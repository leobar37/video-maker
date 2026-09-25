/**
 * Publish/schedule orchestration over the Zernio `Publisher` port.
 *
 * Spend-safety (FR-011) + idempotency:
 * - the spend gate refuses to publish while paid attempts are unresolved
 *   (`uncertain`/`submitted` in `qa/spend.json`);
 * - one wire attempt per idempotency key, journaled per attempt under
 *   `qa/publication/<attempt>/journal.json` with the stages the publish gate
 *   derives (`complete` only for proven outcomes);
 * - outcomes: `accepted` (HTTP 409 dedupe: already out remotely — NOT a
 *   failure), `published`, `failed` (definite rejection), `uncertain` (no
 *   receipt — reconcile required; NEVER auto-retried).
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PublishOutcome, PublishOutcomeKind, SocialPost } from '@videomaker/providers';

import { projectAbsolute } from './assemble';
import { writeJsonArtifact } from './evidence';
import { FileSpendLedger, openAttempts, spendLedgerPath } from './spend-ledger';
import type { MediaCommandDeps } from './deps';

/** Last stage of a publication journal proving the publish gate (core). */
export const PUBLICATION_FINAL_STAGE = 'complete';

export interface PublishAttemptRecord {
  at: string;
  action: 'publish' | 'schedule' | 'replay';
  outcome: PublishOutcomeKind;
  remoteId?: string;
  url?: string;
  detail?: string;
}

/** Per-attempt publication journal (`qa/publication/<attempt>/journal.json`). */
export interface PublishJournal {
  schemaVersion: 1;
  id: string;
  idempotencyKey: string;
  post: {
    account: string;
    text: string;
    media: string[];
    scheduledFor?: string;
    tags?: string[];
  };
  createdAt: string;
  updatedAt: string;
  /** One entry per attempt; the last one is the current outcome. */
  attempts: PublishAttemptRecord[];
  outcome: PublishOutcomeKind;
  stages: string[];
}

export interface PublishOptions {
  projectDir: string;
  deps: MediaCommandDeps;
  account: string;
  text: string;
  /** Public media URLs. */
  media: string[];
  /** ISO timestamp: schedule instead of publishing now. */
  scheduledFor?: string;
  tags?: string[];
  /** Stable key: one live post per intended publication. */
  idempotencyKey: string;
  /** Explicit spend cap (the paid-run gate). */
  spendCapUsd: number;
  /** Re-publish even when a completed journal exists for the key. */
  force: boolean;
  now: () => Date;
  out: (line: string) => void;
}

export interface PublishRunResult {
  exitCode: number;
  outcome: PublishOutcome;
  /** Project-relative journal of this attempt. */
  journalPath: string;
  attemptId: string;
}

function attemptDirOf(idempotencyKey: string): string {
  const slug = idempotencyKey
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug.length > 0 ? slug : 'attempt';
}

async function readJournal(path: string): Promise<PublishJournal | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as PublishJournal;
    return parsed?.schemaVersion === 1 && Array.isArray(parsed.stages) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Publishes (or schedules) one social post with a stable idempotency key and a
 * per-attempt journal. A prior proven outcome is replayed from the journal —
 * the publisher is never called again (no double post, no auto-retry).
 */
export async function runPublish(options: PublishOptions): Promise<PublishRunResult> {
  const { projectDir, deps } = options;

  // Spend gate: unresolved paid attempts block publication.
  const ledger = new FileSpendLedger(spendLedgerPath(projectDir));
  const unresolved = await openAttempts(ledger);
  if (unresolved.length > 0) {
    throw new Error(
      `publish: spend gate closed — unreconciled paid attempt(s) in qa/spend.json: ` +
        `${unresolved.map((record) => `${record.attemptId} (${record.state})`).join(', ')}. ` +
        'Reconcile them before publishing.',
    );
  }

  const attemptId = attemptDirOf(options.idempotencyKey);
  const journalRelative = `qa/publication/${attemptId}/journal.json`;
  const journalAbsolute = projectAbsolute(projectDir, journalRelative);
  const nowIso = () => options.now().toISOString();
  const post: SocialPost = {
    idempotencyKey: options.idempotencyKey,
    account: options.account,
    text: options.text,
    media: options.media,
    ...(options.scheduledFor !== undefined ? { scheduledFor: options.scheduledFor } : {}),
    ...(options.tags !== undefined ? { tags: options.tags } : {}),
  };

  const previous = await readJournal(journalAbsolute);
  if (
    previous !== undefined &&
    previous.idempotencyKey === options.idempotencyKey &&
    previous.outcome === 'uncertain'
  ) {
    // No auto-retry: an uncertain submit may already have gone out. The
    // operator reconciles (publisher.status/reconcile) before any new attempt.
    throw new Error(
      `publish: the previous attempt for ${options.idempotencyKey} is uncertain ` +
        `(${previous.attempts[previous.attempts.length - 1]?.detail ?? 'no detail'}). ` +
        'Reconcile it before submitting again; nothing is retried automatically.',
    );
  }
  if (
    previous !== undefined &&
    previous.idempotencyKey === options.idempotencyKey &&
    (previous.outcome === 'published' || previous.outcome === 'accepted') &&
    !options.force
  ) {
    const replay: PublishAttemptRecord = {
      at: nowIso(),
      action: 'replay',
      outcome: previous.outcome,
      detail: 'idempotent replay from the publication journal; no new submit',
      ...(previous.attempts[previous.attempts.length - 1]?.remoteId !== undefined
        ? { remoteId: previous.attempts[previous.attempts.length - 1]?.remoteId as string }
        : {}),
    };
    const journal: PublishJournal = {
      ...previous,
      updatedAt: nowIso(),
      attempts: [...previous.attempts, replay],
    };
    await writeJsonArtifact(journalAbsolute, journal);
    options.out(
      `publish: ${previous.outcome} already proven for ${options.idempotencyKey}; ` +
        `replayed from ${journalRelative} (no new submit).`,
    );
    return {
      exitCode: 0,
      outcome: {
        outcome: previous.outcome,
        idempotencyKey: options.idempotencyKey,
        detail: replay.detail ?? 'idempotent replay',
      },
      journalPath: journalRelative,
      attemptId,
    };
  }

  const publisher = await deps.publisher(
    projectAbsolute(projectDir, 'qa/publication/zernio-journal.jsonl'),
  );
  const ctx = deps.providerContext();
  const validation = await publisher.validate(post, ctx);
  const stages = ['preflight'];
  const createdAt = previous?.createdAt ?? nowIso();

  const finish = async (
    outcome: PublishOutcomeKind,
    attempt: Omit<PublishAttemptRecord, 'at'>,
  ): Promise<PublishRunResult> => {
    const record: PublishAttemptRecord = { at: nowIso(), ...attempt };
    if (outcome === 'published' || outcome === 'accepted') {
      if (!stages.includes('submitted')) stages.push('submitted');
      if (!stages.includes(PUBLICATION_FINAL_STAGE)) stages.push(PUBLICATION_FINAL_STAGE);
    } else if (attempt.action !== 'replay') {
      stages.push('submitted');
    }
    const journal: PublishJournal = {
      schemaVersion: 1,
      id: attemptId,
      idempotencyKey: options.idempotencyKey,
      post: {
        account: post.account,
        text: post.text,
        media: post.media,
        ...(post.scheduledFor !== undefined ? { scheduledFor: post.scheduledFor } : {}),
        ...(post.tags !== undefined ? { tags: post.tags } : {}),
      },
      createdAt,
      updatedAt: nowIso(),
      attempts: [...(previous?.attempts ?? []), record],
      outcome,
      stages,
    };
    await mkdir(join(journalAbsolute, '..'), { recursive: true });
    await writeJsonArtifact(journalAbsolute, journal);
    return {
      exitCode: outcome === 'published' || outcome === 'accepted' ? 0 : 1,
      outcome: {
        outcome,
        idempotencyKey: options.idempotencyKey,
        ...(record.remoteId !== undefined ? { remoteId: record.remoteId } : {}),
        ...(record.url !== undefined ? { url: record.url } : {}),
        ...(record.detail !== undefined ? { detail: record.detail } : {}),
      },
      journalPath: journalRelative,
      attemptId,
    };
  };

  if (!validation.ok) {
    options.out(`publish: post rejected by validation: ${validation.problems.join('; ')}`);
    return finish('failed', {
      action: 'publish',
      outcome: 'failed',
      detail: `invalid post: ${validation.problems.join('; ')}`,
    });
  }

  const action = options.scheduledFor !== undefined ? 'schedule' : 'publish';
  let result: PublishOutcome;
  try {
    result =
      action === 'schedule'
        ? await publisher.schedule(post, ctx)
        : await publisher.publish(post, ctx);
  } catch (cause) {
    // A thrown transport error leaves the remote outcome unknown: uncertain,
    // journaled, NEVER auto-retried — reconcile via the publisher's status().
    const detail = cause instanceof Error ? cause.message : String(cause);
    options.out(`publish: submit finished without a receipt (${detail}); outcome uncertain.`);
    return finish('uncertain', {
      action,
      outcome: 'uncertain',
      detail: `no receipt (${detail}); reconcile before any retry`,
    });
  }

  const record: Omit<PublishAttemptRecord, 'at'> = {
    action,
    outcome: result.outcome,
    ...(result.remoteId !== undefined ? { remoteId: result.remoteId } : {}),
    ...(result.url !== undefined ? { url: result.url } : {}),
    ...(result.detail !== undefined ? { detail: result.detail } : {}),
  };
  options.out(`publish: ${result.outcome} (${options.idempotencyKey}) — ${result.detail ?? 'no detail'}`);
  return finish(result.outcome, record);
}
