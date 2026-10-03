/** Read-only remote status and explicit append-only reconciliation; never resubmit. */
import { isRecord } from '@videomaker/core';
import type { ProviderContext, PublishOutcome, PublishOutcomeKind } from '../ports';
import { assertRunMode } from '../storage/context';
import type { ZernioClient } from './client';
import {
  outcomeOf,
  type PublicationJournalEntry,
  type PublicationJournalStore,
} from './journal';
import {
  extractCreatedPost,
  extractListedPosts,
  targetReceiptOf,
  type CreatedPost,
  type ReceiptTarget,
  type TargetReceipt,
} from './post-response';

/** Full, exact intent evidence required when the remote does not echo the key. */
export interface RemotePostEvidence {
  profileId: string;
  platform: string;
  accountId: string;
  content: string;
  videoUrl: string;
  coverUrl: string;
  createdAfter: string;
  createdBefore: string;
}

export interface RemoteReconcileOptions {
  remoteId?: string;
  target?: ReceiptTarget;
  evidence?: RemotePostEvidence;
}

/** Membership evidence and target-state proof are deliberately separate. */
export interface ReconcileFinding {
  verdict: 'found' | 'absent' | 'inconclusive';
  remoteId?: string;
  url?: string;
  detail?: string;
  outcome?: PublishOutcomeKind;
  evidenceSource?: 'remote-id' | 'echoed-key' | 'payload' | 'authoritative';
}

export type ReconcileLookup = (
  idempotencyKey: string,
  ctx: ProviderContext,
) => Promise<ReconcileFinding>;

const PAGE_LIMIT = 100;
const MAX_PAGES = 100;
const PENDING_STATES = ['queued', 'pending', 'processing', 'scheduled', 'publishing'];

/** Legacy journals have no target identity: do not borrow another target's URL. */
function receiptOf(post: CreatedPost, target?: ReceiptTarget): TargetReceipt {
  if (target) return targetReceiptOf(post, target);
  const states = post.platforms.map((platform) => platform.status?.toLowerCase());
  const detail = post.platforms.map((platform) => `${platform.platform}:${platform.status ?? '?'}`).join(', ');
  if (states.length === 0 || post.platforms.some((platform) => !platform.platform) ||
    states.some((state) => !state || !['published', 'failed', ...PENDING_STATES].includes(state))) {
    return { outcome: 'uncertain', remoteId: post.id, detail: 'remote target states are missing or unknown' };
  }
  if (states.every((state) => state === 'published')) {
    return {
      outcome: 'published', remoteId: post.id,
      ...(post.platforms.length === 1 ? { url: post.platforms[0]?.platformPostUrl } : {}),
      detail: `all remote targets published (${detail})`,
    };
  }
  return {
    outcome: states.every((state) => state === 'failed') ? 'failed' : 'accepted',
    remoteId: post.id,
    detail: `remote target states (${detail})`,
  };
}

interface ListPagination {
  page: number;
  limit: number;
  total: number;
  pages: number;
}

function paginationOf(body: unknown): ListPagination | null {
  if (!isRecord(body) || Array.isArray(body)) return null;
  const envelope = isRecord(body.data) && !Array.isArray(body.data) ? body.data : body;
  if (!Array.isArray(body.posts) && !Array.isArray(body.data) && !Array.isArray(envelope.posts)) return null;
  const value = body.pagination ?? envelope.pagination;
  if (!isRecord(value) || Array.isArray(value)) return null;
  const { page, limit, total, pages } = value;
  if (typeof page !== 'number' || !Number.isSafeInteger(page) || page < 1 ||
    typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit !== PAGE_LIMIT ||
    typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 ||
    typeof pages !== 'number' || !Number.isSafeInteger(pages) || pages < 0) return null;
  if (pages !== Math.ceil(total / limit) && !(total === 0 && pages === 1)) return null;
  return { page, limit, total, pages };
}

function validEvidence(evidence: RemotePostEvidence): boolean {
  return (['profileId', 'platform', 'accountId', 'videoUrl', 'coverUrl'] as const).every((field) => {
    const value = evidence[field];
    return typeof value === 'string' && value.trim().length > 0;
  }) && typeof evidence.content === 'string' &&
    typeof evidence.createdAfter === 'string' && typeof evidence.createdBefore === 'string' &&
    Number.isFinite(Date.parse(evidence.createdAfter)) && Number.isFinite(Date.parse(evidence.createdBefore)) &&
    Date.parse(evidence.createdAfter) <= Date.parse(evidence.createdBefore);
}

function matchesPayload(post: CreatedPost, evidence: RemotePostEvidence): boolean {
  if (post.profileId !== evidence.profileId || post.content !== evidence.content || !post.createdAt) return false;
  const createdAt = Date.parse(post.createdAt);
  if (!Number.isFinite(createdAt) || createdAt < Date.parse(evidence.createdAfter) ||
    createdAt > Date.parse(evidence.createdBefore)) return false;
  const targets = post.platforms.filter((platform) => platform.platform === evidence.platform &&
    platform.accountId === evidence.accountId &&
    (platform.profileId === undefined || platform.profileId === evidence.profileId));
  const media = post.mediaItems;
  return targets.length === 1 && media !== undefined && media.length === 1 &&
    media[0]?.url === evidence.videoUrl && media[0]?.thumbnail === evidence.coverUrl;
}

function found(post: CreatedPost, options: RemoteReconcileOptions,
  evidenceSource: ReconcileFinding['evidenceSource']): ReconcileFinding {
  const target = options.target ?? options.evidence;
  const receipt = receiptOf(post, target);
  return { verdict: 'found', remoteId: post.id, outcome: receipt.outcome,
    ...(receipt.url ? { url: receipt.url } : {}), detail: receipt.detail, evidenceSource };
}

/** Only documented GETs; an unfiltered list can prove membership, never absence. */
export function remoteReconcileLookup(
  client: ZernioClient,
  options: RemoteReconcileOptions = {},
): ReconcileLookup {
  return async (idempotencyKey, ctx) => {
    assertRunMode(ctx, 'Zernio reconcile lookup');
    const inconclusive = (detail: string): ReconcileFinding => ({ verdict: 'inconclusive', detail });
    try {
      if (options.remoteId !== undefined) {
        if (typeof options.remoteId !== 'string' || !options.remoteId.trim()) return inconclusive('invalid remote identity');
        const path = `/posts/${encodeURIComponent(options.remoteId)}`;
        const response = await client.request(path);
        if (response.status !== 200) return inconclusive(`GET ${path} → HTTP ${response.status}; state unknown`);
        const post = extractCreatedPost(response.body);
        if (!post || post.id !== options.remoteId) return inconclusive('remote response identity does not match the stored post');
        return found(post, options, 'remote-id');
      }
      if (options.evidence && !validEvidence(options.evidence)) return inconclusive('invalid payload evidence/window');
      const candidates: { post: CreatedPost; source: 'echoed-key' | 'payload' }[] = [];
      const seen = new Set<string>();
      let expected: ListPagination | undefined;
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const path = `/posts?limit=${PAGE_LIMIT}&offset=${(page - 1) * PAGE_LIMIT}`;
        const response = await client.request(path);
        if (response.status !== 200) return inconclusive(`GET ${path} → HTTP ${response.status}`);
        const posts = extractListedPosts(response.body);
        const pagination = paginationOf(response.body);
        if (!posts || !pagination || pagination.page !== page ||
          (expected && (pagination.total !== expected.total || pagination.pages !== expected.pages)) ||
          posts.length !== Math.min(PAGE_LIMIT, Math.max(0, pagination.total - (page - 1) * PAGE_LIMIT))) {
          return inconclusive('malformed or incomplete list pagination/evidence');
        }
        expected = pagination;
        for (const post of posts) {
          if (seen.has(post.id)) return inconclusive('duplicate remote identity across list pages');
          seen.add(post.id);
          const echoed = post.idempotencyKey === idempotencyKey || post.requestId === idempotencyKey;
          const contradicts = (post.idempotencyKey !== undefined && post.idempotencyKey !== idempotencyKey) ||
            (post.requestId !== undefined && post.requestId !== idempotencyKey);
          if (echoed && contradicts) return inconclusive('conflicting echoed request identities');
          if (echoed) candidates.push({ post, source: 'echoed-key' });
          else if (!contradicts && options.evidence && matchesPayload(post, options.evidence)) {
            candidates.push({ post, source: 'payload' });
          }
          if (candidates.length > 1) return inconclusive('multiple matching remote posts');
        }
        if (page >= pagination.pages) {
          const match = candidates[0];
          return match ? found(match.post, options, match.source) : inconclusive('no unique matching post; unfiltered listing does not prove absence');
        }
      }
      return inconclusive('pagination safety cap reached before uniqueness could be proven');
    } catch {
      return inconclusive('remote lookup failed; state unknown');
    }
  };
}

export interface StatusOptions extends RemoteReconcileOptions {
  reconcileLookup?: ReconcileLookup;
}

async function entriesFor(
  journal: PublicationJournalStore,
  idempotencyKey: string,
): Promise<PublicationJournalEntry[]> {
  return (await journal.readAll()).filter((entry) => entry.idempotencyKey === idempotencyKey);
}

/** Status is GET-only and never appends journal transitions. */
export async function statusByKey(
  client: ZernioClient,
  journal: PublicationJournalStore,
  idempotencyKey: string,
  ctx: ProviderContext,
  options: RemoteReconcileOptions = {},
): Promise<PublishOutcome> {
  const entries = await entriesFor(journal, idempotencyKey);
  const latest = entries[entries.length - 1];
  if (!latest) return { outcome: 'failed', idempotencyKey, detail: 'unknown idempotency key: never journalled (nothing was submitted)' };
  if (latest.outcome === 'failed' || !latest.remoteId) return outcomeOf(latest);
  const finding = await remoteReconcileLookup(client, { ...options, remoteId: latest.remoteId })(idempotencyKey, ctx);
  return {
    outcome: finding.verdict === 'found' ? finding.outcome ?? 'uncertain' : 'uncertain',
    idempotencyKey, remoteId: latest.remoteId,
    ...(finding.url ? { url: finding.url } : {}),
    detail: finding.detail ?? 'remote state unknown',
  };
}

/** Reconciliation is the only writer of remote state transitions, never a POST. */
export async function reconcileByKey(
  client: ZernioClient,
  journal: PublicationJournalStore,
  idempotencyKey: string,
  ctx: ProviderContext,
  opts: StatusOptions = {},
): Promise<PublishOutcome> {
  const entries = await entriesFor(journal, idempotencyKey);
  const latest = entries[entries.length - 1];
  if (!latest) return { outcome: 'failed', idempotencyKey, detail: 'unknown idempotency key: nothing to reconcile' };
  if (latest.outcome === 'published') return { ...outcomeOf(latest), detail: 'already proven; nothing to reconcile' };
  if (latest.outcome === 'failed' && !latest.remoteId && !opts.remoteId && !opts.reconcileLookup && !opts.evidence) {
    return { ...outcomeOf(latest), detail: 'already definitively failed; nothing to reconcile' };
  }
  assertRunMode(ctx, 'Zernio reconcile');
  const lookup = opts.reconcileLookup ?? remoteReconcileLookup(client, {
    ...opts, remoteId: latest.remoteId ?? opts.remoteId,
  });
  let finding: ReconcileFinding;
  try {
    finding = await lookup(idempotencyKey, ctx);
  } catch {
    finding = { verdict: 'inconclusive', detail: 'lookup failed; state unknown' };
  }
  const expectedRemoteId = latest.remoteId ?? opts.remoteId;
  const matchingIdentity = typeof finding.remoteId === 'string' && finding.remoteId.trim().length > 0 &&
    (expectedRemoteId === undefined || expectedRemoteId === finding.remoteId);
  const outcome = finding.outcome;
  const provenOutcome = outcome === 'published' || outcome === 'accepted' || outcome === 'failed';
  const falseFailureProof = latest.outcome !== 'failed' || (matchingIdentity &&
    (latest.remoteId !== undefined || finding.evidenceSource !== undefined));
  if (finding.verdict === 'found' && matchingIdentity && provenOutcome && falseFailureProof) {
    const entry: PublicationJournalEntry = {
      schemaVersion: 1, idempotencyKey, attempt: latest.attempt,
      outcome, at: ctx.clock.now().toISOString(),
      remoteId: finding.remoteId,
      ...(finding.outcome === 'published' && finding.url ? { url: finding.url } : {}),
      detail: `reconciled (${finding.evidenceSource ?? 'authoritative'}): ${finding.detail ?? 'explicit remote state proof'}`,
    };
    await journal.append(entry);
    return outcomeOf(entry);
  }
  if (finding.verdict === 'absent' && finding.evidenceSource === 'authoritative' &&
    opts.reconcileLookup && latest.outcome === 'uncertain') {
    const entry: PublicationJournalEntry = {
      schemaVersion: 1, idempotencyKey, attempt: latest.attempt, outcome: 'failed',
      at: ctx.clock.now().toISOString(),
      detail: `reconciled: ${finding.detail ?? 'authoritative lookup proves absence'}`,
    };
    await journal.append(entry);
    return outcomeOf(entry);
  }
  return {
    ...outcomeOf(latest),
    detail: `reconcile inconclusive (${finding.detail ?? 'no explicit matching state proof'}); attempt ${latest.attempt} stays ${latest.outcome}`,
  };
}
