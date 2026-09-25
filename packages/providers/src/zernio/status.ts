/**
 * Status and reconcile per idempotency key.
 *
 * - `status` reports what the remote says about the journalled post right now.
 * - `reconcile` is the ONLY door out of an `uncertain` attempt (a submit whose
 *   outcome was not proven by a receipt). It resolves the attempt against the
 *   remote by idempotency key and journals the verdict as a state transition
 *   of the same attempt number. Retrying a publish is never a substitute for
 *   reconciling: an uncertain attempt may already have gone out.
 */
import type { ProviderContext, PublishOutcome } from '../ports';
import { assertRunMode } from '../storage/context';
import type { ZernioClient } from './client';
import {
  outcomeOf,
  type PublicationJournalEntry,
  type PublicationJournalStore,
} from './journal';
import { extractCreatedPost, extractFirstListedPost, postUrlOf } from './post-response';

/** Verdict of a remote lookup for one idempotency key. */
export interface ReconcileFinding {
  verdict: 'found' | 'absent' | 'inconclusive';
  remoteId?: string;
  url?: string;
  detail?: string;
}

export type ReconcileLookup = (
  idempotencyKey: string,
  ctx: ProviderContext,
) => Promise<ReconcileFinding>;

/**
 * Default lookup: ask the remote which post (if any) was created for this
 * idempotency key. Transport failures and unexpected statuses are
 * `inconclusive` — never a silent `absent`, which would wrongly unblock a
 * retry that could double-post.
 */
export function remoteReconcileLookup(client: ZernioClient): ReconcileLookup {
  return async (idempotencyKey, ctx) => {
    assertRunMode(ctx, 'Zernio reconcile lookup');
    const path = `/posts?requestId=${encodeURIComponent(idempotencyKey)}`;
    let response: { status: number; body: unknown };
    try {
      response = await client.request(path);
    } catch (err) {
      return { verdict: 'inconclusive', detail: `lookup failed: ${(err as Error).message}` };
    }
    if (response.status !== 200) {
      return {
        verdict: 'inconclusive',
        detail: `GET ${path} → HTTP ${response.status}`,
      };
    }
    const post = extractFirstListedPost(response.body);
    if (!post) return { verdict: 'absent', detail: 'remote reports no post for this key' };
    return {
      verdict: 'found',
      remoteId: post.id,
      url: postUrlOf(post),
      detail: 'remote reports the post for this key',
    };
  };
}

export interface StatusOptions {
  reconcileLookup?: ReconcileLookup;
}

async function entriesFor(
  journal: PublicationJournalStore,
  idempotencyKey: string,
): Promise<PublicationJournalEntry[]> {
  return (await journal.readAll()).filter((entry) => entry.idempotencyKey === idempotencyKey);
}

/**
 * Current status of one idempotency key. Journal-derived states answer
 * offline (also in plan mode); anything requiring the remote refuses in plan
 * mode (NFR-002).
 */
export async function statusByKey(
  client: ZernioClient,
  journal: PublicationJournalStore,
  idempotencyKey: string,
  ctx: ProviderContext,
): Promise<PublishOutcome> {
  const entries = await entriesFor(journal, idempotencyKey);
  if (entries.length === 0) {
    return {
      outcome: 'failed',
      idempotencyKey,
      detail: 'unknown idempotency key: never journalled (nothing was submitted)',
    };
  }
  const latest = entries[entries.length - 1];
  if (latest.outcome === 'failed' || !latest.remoteId) {
    return outcomeOf(latest);
  }
  assertRunMode(ctx, 'Zernio status lookup');
  const path = `/posts/${encodeURIComponent(latest.remoteId)}`;
  let response: { status: number; body: unknown };
  try {
    response = await client.request(path);
  } catch (err) {
    return {
      outcome: 'uncertain',
      idempotencyKey,
      remoteId: latest.remoteId,
      detail: `status lookup failed: ${(err as Error).message}; state unknown`,
    };
  }
  if (response.status === 404) {
    return {
      outcome: 'failed',
      idempotencyKey,
      remoteId: latest.remoteId,
      detail: 'remote post not found (404)',
    };
  }
  if (response.status !== 200) {
    return {
      outcome: 'uncertain',
      idempotencyKey,
      remoteId: latest.remoteId,
      detail: `status lookup HTTP ${response.status}; state unknown`,
    };
  }
  const post = extractCreatedPost(response.body);
  if (!post) {
    return {
      outcome: 'uncertain',
      idempotencyKey,
      remoteId: latest.remoteId,
      detail: 'status response carried no parseable post; state unknown',
    };
  }
  const platforms = post.platforms
    .map((p) => `${p.platform}:${p.status ?? '?'}`)
    .join(', ');
  return {
    outcome: 'published',
    idempotencyKey,
    remoteId: post.id,
    url: postUrlOf(post),
    detail: platforms ? `remote reports the post (${platforms})` : 'remote reports the post',
  };
}

/**
 * Resolves an `uncertain` attempt from remote evidence. Proven states pass
 * through untouched; an inconclusive lookup leaves the attempt uncertain.
 */
export async function reconcileByKey(
  client: ZernioClient,
  journal: PublicationJournalStore,
  idempotencyKey: string,
  ctx: ProviderContext,
  opts: StatusOptions = {},
): Promise<PublishOutcome> {
  const entries = await entriesFor(journal, idempotencyKey);
  if (entries.length === 0) {
    return {
      outcome: 'failed',
      idempotencyKey,
      detail: 'unknown idempotency key: nothing to reconcile',
    };
  }
  const latest = entries[entries.length - 1];
  if (latest.outcome === 'published' || latest.outcome === 'accepted') {
    return { ...outcomeOf(latest), detail: 'already proven; nothing to reconcile' };
  }
  if (latest.outcome === 'failed') {
    return { ...outcomeOf(latest), detail: 'already definitively failed; nothing to reconcile' };
  }

  const lookup = opts.reconcileLookup ?? remoteReconcileLookup(client);
  const finding = await lookup(idempotencyKey, ctx);
  const at = ctx.clock.now().toISOString();
  if (finding.verdict === 'found') {
    const entry: PublicationJournalEntry = {
      schemaVersion: 1,
      idempotencyKey,
      attempt: latest.attempt,
      outcome: 'published',
      at,
      remoteId: finding.remoteId,
      url: finding.url,
      detail: `reconciled: ${finding.detail ?? 'remote reports the post for this key'}`,
    };
    await journal.append(entry);
    return outcomeOf(entry);
  }
  if (finding.verdict === 'absent') {
    const entry: PublicationJournalEntry = {
      schemaVersion: 1,
      idempotencyKey,
      attempt: latest.attempt,
      outcome: 'failed',
      at,
      detail: `reconciled: ${finding.detail ?? 'remote reports no post for this key'}`,
    };
    await journal.append(entry);
    return outcomeOf(entry);
  }
  return {
    outcome: 'uncertain',
    idempotencyKey,
    ...(latest.remoteId ? { remoteId: latest.remoteId } : {}),
    detail: `reconcile inconclusive (${finding.detail ?? 'lookup gave no verdict'}); attempt ${latest.attempt} stays uncertain`,
  };
}
