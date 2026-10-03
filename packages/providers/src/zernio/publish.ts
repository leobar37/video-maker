/**
 * Zernio publication: publish and schedule of social posts.
 *
 * Semantics (one live submit per idempotency key — never auto-retry):
 * - the wire attempt is journalled per attempt with its outcome;
 * - `published` — explicit publication evidence for the requested target;
 * - `accepted` — a queued target receipt, or HTTP 409 dedupe; never re-sent;
 * - `failed` — a definite rejection or explicitly failed target;
 * - `uncertain` — unknown/missing target receipt, or a transport error
 *   where the request may have landed: the attempt BLOCKS every further
 *   submit for the key until `reconcile` resolves it. A missing receipt is
 *   never papered over with a retry — the retry could double-post.
 *
 * Plan mode (NFR-002) refuses publish/schedule before any network or secret
 * access; `validate` is pure and works in every mode.
 */
import type {
  ProviderContext,
  PublishOutcome,
  Publisher,
  PublisherAccount,
  SocialPost,
} from '../ports';
import { assertRunMode } from '../storage/context';
import { ZernioAccounts, toPublisherAccount, resolveAccountRef } from './accounts';
import type { ZernioClient } from './client';
import {
  attemptsUsed,
  outcomeOf,
  type PublicationJournalEntry,
  type PublicationJournalStore,
} from './journal';
import {
  duplicatePostId,
  extractCreatedPost,
  extractReceiptPostId,
  isIdempotencyConflict,
  targetReceiptOf,
} from './post-response';
import { reconcileByKey, statusByKey, type ReconcileLookup } from './status';

/** Timezone used when scheduling without one (operator's zone). */
export const SCHEDULE_TIMEZONE_DEFAULT = 'America/Lima';

export class PostValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid social post: ${problems.join('; ')}`);
    this.name = 'PostValidationError';
  }
}

/** Refusal to exceed the explicit wire-attempt budget for one key. */
export class AttemptsExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttemptsExhaustedError';
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Pure, offline structural validation (plan-mode safe; zero fetch). */
export function validateSocialPost(post: SocialPost): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!post.idempotencyKey?.trim()) problems.push('idempotencyKey must be a non-empty string');
  if (!post.account?.trim()) {
    problems.push('account must be a non-empty account id or "platform[:@user]" selector');
  }
  if (!post.text?.trim()) problems.push('text must be a non-empty string');
  for (const [index, url] of post.media.entries()) {
    if (!isHttpUrl(url)) problems.push(`media[${index}] must be an absolute http(s) URL`);
  }
  if (post.scheduledFor !== undefined && !Number.isFinite(Date.parse(post.scheduledFor))) {
    problems.push('scheduledFor must be an ISO timestamp');
  }
  return { ok: problems.length === 0, problems };
}

/**
 * `POST /v1/posts` body. One post targets one resolved account; scheduling
 * replaces `publishNow` with `scheduledFor` + timezone.
 */
export function buildPostBody(
  post: SocialPost,
  target: { platform: string; accountId: string },
  opts: { scheduled: boolean; timezone: string },
): Record<string, unknown> {
  return {
    content: post.text,
    mediaItems: post.media.map((url) => ({
      url,
      ...(post.coverUrl ? { type: 'video', thumbnail: post.coverUrl } : {}),
    })),
    platforms: [{
      platform: target.platform,
      accountId: target.accountId,
      ...(target.platform === 'youtube' && post.youtube
        ? { platformSpecificData: post.youtube } : {}),
    }],
    ...(post.title !== undefined ? { title: post.title } : {}),
    ...(post.tags !== undefined ? { tags: post.tags } : {}),
    ...(post.tiktokSettings !== undefined ? { tiktokSettings: post.tiktokSettings } : {}),
    ...(opts.scheduled
      ? { scheduledFor: post.scheduledFor, timezone: opts.timezone }
      : { publishNow: true }),
  };
}

export interface ZernioPublisherOptions {
  journal: PublicationJournalStore;
  /**
   * Explicit wire-attempt budget per idempotency key (default 1: submit-once).
   * Raising it is an operator decision; the publisher never retries on its own.
   */
  maxAttempts?: number;
  timezone?: string;
  /** Reconcile lookup override (tests or future transports). */
  reconcileLookup?: ReconcileLookup;
}

/** `Publisher` port implementation over the Zernio API. */
export class ZernioPublisher implements Publisher {
  readonly id = 'zernio';
  readonly #client: ZernioClient;
  readonly #accounts: ZernioAccounts;
  readonly #journal: PublicationJournalStore;
  readonly #maxAttempts: number;
  readonly #timezone: string;
  readonly #reconcileLookup: ReconcileLookup | undefined;

  constructor(client: ZernioClient, opts: ZernioPublisherOptions) {
    this.#client = client;
    this.#accounts = new ZernioAccounts(client);
    this.#journal = opts.journal;
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 1);
    this.#timezone = opts.timezone ?? SCHEDULE_TIMEZONE_DEFAULT;
    this.#reconcileLookup = opts.reconcileLookup;
  }

  async accounts(ctx: ProviderContext): Promise<PublisherAccount[]> {
    return (await this.#accounts.merged(ctx)).map(toPublisherAccount);
  }

  /** Pure structural validation; safe in plan mode (zero fetch). */
  async validate(post: SocialPost, _ctx: ProviderContext): Promise<{ ok: boolean; problems: string[] }> {
    return validateSocialPost(post);
  }

  async publish(post: SocialPost, ctx: ProviderContext): Promise<PublishOutcome> {
    return this.send(post, { scheduled: false }, ctx);
  }

  async schedule(post: SocialPost, ctx: ProviderContext): Promise<PublishOutcome> {
    return this.send(post, { scheduled: true }, ctx);
  }

  async status(idempotencyKey: string, ctx: ProviderContext): Promise<PublishOutcome> {
    return statusByKey(this.#client, this.#journal, idempotencyKey, ctx);
  }

  async reconcile(idempotencyKey: string, ctx: ProviderContext): Promise<PublishOutcome> {
    return reconcileByKey(this.#client, this.#journal, idempotencyKey, ctx, {
      reconcileLookup: this.#reconcileLookup,
    });
  }

  private async send(
    post: SocialPost,
    mode: { scheduled: boolean },
    ctx: ProviderContext,
  ): Promise<PublishOutcome> {
    const action = mode.scheduled ? 'Zernio schedule' : 'Zernio publish';
    assertRunMode(ctx, action);

    const validation = validateSocialPost(post);
    if (!validation.ok) throw new PostValidationError(validation.problems);
    if (mode.scheduled && !post.scheduledFor) {
      throw new PostValidationError(['schedule requires scheduledFor (ISO timestamp)']);
    }
    if (!mode.scheduled && post.scheduledFor) {
      throw new PostValidationError([
        'publish sends now; use schedule() for a post that carries scheduledFor',
      ]);
    }

    const idempotencyKey = post.idempotencyKey;
    const history = await this.#journal.readAll();
    const mine = history.filter((entry) => entry.idempotencyKey === idempotencyKey);
    const latest = mine.length > 0 ? mine[mine.length - 1] : undefined;

    // Idempotent replay: a proven outcome never produces a second submit.
    if (latest && (latest.outcome === 'published' || latest.outcome === 'accepted')) {
      return outcomeOf(latest);
    }
    // Uncertain attempt: blocked until reconcile — never auto-retried.
    if (latest && latest.outcome === 'uncertain') {
      return {
        ...outcomeOf(latest),
        detail:
          `attempt ${latest.attempt} is journalled without a receipt; ` +
          'retry is blocked until reconcile resolves it',
      };
    }

    const used = attemptsUsed(history, idempotencyKey);
    if (used >= this.#maxAttempts) {
      throw new AttemptsExhaustedError(
        `${action}: idempotency key ${idempotencyKey} already used ${used}/${this.#maxAttempts} ` +
          'wire attempts; raise maxAttempts explicitly to re-attempt (never retried automatically).',
      );
    }

    // Account resolution happens before the wire attempt: a bad selector must
    // never reach the remote.
    const accounts = await this.#accounts.merged(ctx, post.profileId);
    if (post.profileId && !accounts.some((account) =>
      account.id === post.account && account.canPost === true &&
      (account.status === 'healthy' || account.status === 'active' || account.status === 'ok'))) {
      throw new PostValidationError(['explicit profile account is missing or unhealthy']);
    }
    const target = resolveAccountRef(accounts, post.account);
    const body = buildPostBody(post, target, {
      scheduled: mode.scheduled,
      timezone: this.#timezone,
    });
    const attempt = used + 1;
    const at = () => ctx.clock.now().toISOString();

    let response: { status: number; body: unknown };
    try {
      response = await this.#client.request('/posts', {
        method: 'POST',
        body,
        idempotencyKey,
      });
    } catch {
      // The request may or may not have landed: no receipt, so the attempt is
      // uncertain and blocks the key until reconciled.
      const entry: PublicationJournalEntry = {
        schemaVersion: 1,
        idempotencyKey,
        attempt,
        outcome: 'uncertain',
        at: at(),
        detail: 'transport error before a response; remote outcome unknown — reconcile required',
      };
      await this.#journal.append(entry);
      return outcomeOf(entry);
    }

    const duplicateId = duplicatePostId(response.status, response.body);
    if (duplicateId) {
      // 409 dedupe: the content is already out — accepted, not a failure, and
      // re-sending would double-post.
      const entry: PublicationJournalEntry = {
        schemaVersion: 1,
        idempotencyKey,
        attempt,
        outcome: 'accepted',
        at: at(),
        remoteId: duplicateId,
        detail: 'HTTP 409 dedupe: already published remotely (existingPostId); not a failure',
      };
      await this.#journal.append(entry);
      return outcomeOf(entry);
    }

    const created = extractCreatedPost(response.body);
    const recognizedReceiptStatus = [200, 201, 202, 207].includes(response.status);
    const conflict = isIdempotencyConflict(response.status, response.body);
    if (recognizedReceiptStatus || (response.status >= 200 && response.status < 300) || conflict) {
      const receipt = recognizedReceiptStatus && created
        ? targetReceiptOf(created, { ...target, profileId: post.profileId }) : undefined;
      const remoteId = created?.id ?? extractReceiptPostId(response.body);
      const entry: PublicationJournalEntry = {
        schemaVersion: 1,
        idempotencyKey,
        attempt,
        outcome: receipt?.outcome ?? 'uncertain',
        at: at(),
        remoteId,
        url: receipt?.url,
        detail: `POST /posts → HTTP ${response.status}: ${receipt?.detail ?? (conflict
          ? 'original idempotent request is still processing; reconcile required'
          : 'no receipt proving target state; the remote outcome is unknown — reconcile required')}`,
      };
      await this.#journal.append(entry);
      return outcomeOf(entry);
    }

    // Only recognized ordinary client rejections establish failure. Timeouts,
    // conflicts, server failures and undocumented statuses may have landed.
    const remoteId = created?.id ?? extractReceiptPostId(response.body);
    const definiteRejection = [
      400, 401, 403, 404, 405, 406, 410, 411, 412, 413, 414, 415,
      416, 417, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
    ].includes(response.status) && !remoteId;
    const entry: PublicationJournalEntry = {
      schemaVersion: 1,
      idempotencyKey,
      attempt,
      outcome: definiteRejection ? 'failed' : 'uncertain',
      at: at(),
      remoteId,
      detail: definiteRejection
        ? `POST /posts → HTTP ${response.status}: definite rejection, nothing went out`
        : `POST /posts → HTTP ${response.status}: remote outcome unknown — reconcile required; do not resubmit`,
    };
    await this.#journal.append(entry);
    return outcomeOf(entry);
  }
}
