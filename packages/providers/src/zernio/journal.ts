/**
 * Publication journal for Zernio posts: append-only, recoverable per attempt.
 *
 * Contract:
 * - one JSON line per entry (JSONL), appended in order; a reader created later
 *   resumes exactly where the writer left off;
 * - entries carry the idempotency key, attempt number, outcome, remote id and
 *   timestamps — and NOTHING else. The shape is closed (unknown fields are
 *   rejected), so secret values can never be smuggled into a journal entry
 *   (NFR-001);
 * - an attempt may accrue several entries (state transitions: the wire attempt
 *   and its later reconciliation share the attempt number); the latest entry
 *   of an attempt is its current state;
 * - a truncated final line (crash mid-append) is skipped on read — recovery —
 *   while corruption anywhere else is loud.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { PublishOutcome, PublishOutcomeKind } from '../ports';

export type { PublishOutcomeKind };

const OUTCOMES: readonly PublishOutcomeKind[] = ['accepted', 'published', 'failed', 'uncertain'];

export interface PublicationJournalEntry {
  schemaVersion: 1;
  /** Social post idempotency key (the publish intent identity). */
  idempotencyKey: string;
  /** 1-based attempt number within the idempotency key. */
  attempt: number;
  outcome: PublishOutcomeKind;
  /** ISO timestamp of this entry. */
  at: string;
  /** Remote post id, when proven. */
  remoteId?: string;
  /** Public post URL, when the remote returned one. */
  url?: string;
  /** Non-secret operator-facing context (HTTP status, reconcile evidence ref). */
  detail?: string;
}

export class JournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalError';
  }
}

function invalid(message: string): never {
  throw new JournalError(`Invalid publication journal entry: ${message}`);
}

/**
 * Closed-shape validation. Unknown fields are rejected precisely so extra
 * payload (tokens, headers, raw responses) can never enter the journal.
 */
export function validatePublicationJournalEntry(value: unknown): PublicationJournalEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('entry must be an object.');
  }
  const entry = value as Record<string, unknown>;
  const allowed: Record<string, true> = {
    schemaVersion: true,
    idempotencyKey: true,
    attempt: true,
    outcome: true,
    at: true,
    remoteId: true,
    url: true,
    detail: true,
  };
  for (const key of Object.keys(entry)) {
    if (allowed[key] !== true) invalid(`unknown field ${JSON.stringify(key)}.`);
  }
  if (entry.schemaVersion !== 1) invalid('schemaVersion must be 1.');
  if (typeof entry.idempotencyKey !== 'string' || entry.idempotencyKey.trim() === '') {
    invalid('idempotencyKey must be a non-empty string.');
  }
  if (
    typeof entry.attempt !== 'number' ||
    !Number.isSafeInteger(entry.attempt) ||
    entry.attempt < 1
  ) {
    invalid('attempt must be a positive integer.');
  }
  if (typeof entry.outcome !== 'string' || !OUTCOMES.includes(entry.outcome as PublishOutcomeKind)) {
    invalid(`outcome must be one of ${OUTCOMES.join(' | ')}.`);
  }
  if (typeof entry.at !== 'string' || !Number.isFinite(Date.parse(entry.at))) {
    invalid('at must be an ISO timestamp.');
  }
  for (const key of ['remoteId', 'url', 'detail'] as const) {
    if (entry[key] !== undefined && typeof entry[key] !== 'string') {
      invalid(`${key} must be a string when present.`);
    }
  }
  return entry as unknown as PublicationJournalEntry;
}

/**
 * Parses journal text. A corrupt final line is skipped (the classic
 * crash-mid-append truncation); a corrupt line with valid entries after it is
 * a real corruption and throws.
 */
export function parsePublicationJournalText(text: string): PublicationJournalEntry[] {
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  const entries: PublicationJournalEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      entries.push(validatePublicationJournalEntry(JSON.parse(lines[i])));
    } catch (err) {
      if (i === lines.length - 1) continue; // truncated/unparseable tail: recoverable
      throw err instanceof JournalError
        ? err
        : new JournalError(`Corrupt journal line ${i + 1}: ${(err as Error).message}`);
    }
  }
  return entries;
}

/** Current state of each idempotency key (latest entry wins, in order). */
export function latestByKey(
  entries: readonly PublicationJournalEntry[],
): Map<string, PublicationJournalEntry> {
  const latest = new Map<string, PublicationJournalEntry>();
  for (const entry of entries) latest.set(entry.idempotencyKey, entry);
  return latest;
}

/** Current state of each attempt (latest entry per key+attempt). */
export function latestByAttempt(
  entries: readonly PublicationJournalEntry[],
): Map<string, PublicationJournalEntry> {
  const latest = new Map<string, PublicationJournalEntry>();
  for (const entry of entries) latest.set(`${entry.idempotencyKey}#${entry.attempt}`, entry);
  return latest;
}

/** Highest attempt number used for a key (0 when never attempted). */
export function attemptsUsed(
  entries: readonly PublicationJournalEntry[],
  idempotencyKey: string,
): number {
  let max = 0;
  for (const entry of entries) {
    if (entry.idempotencyKey === idempotencyKey) max = Math.max(max, entry.attempt);
  }
  return max;
}

/** Journal seam consumed by the publisher and the status/reconcile paths. */
export interface PublicationJournalStore {
  append(entry: PublicationJournalEntry): Promise<void>;
  /** Full ordered history; reads are resumable (a new reader sees every append). */
  readAll(): Promise<PublicationJournalEntry[]>;
}

export class InMemoryPublicationJournal implements PublicationJournalStore {
  readonly #entries: PublicationJournalEntry[] = [];

  async append(entry: PublicationJournalEntry): Promise<void> {
    this.#entries.push(validatePublicationJournalEntry(entry));
  }

  async readAll(): Promise<PublicationJournalEntry[]> {
    return [...this.#entries];
  }
}

/** Append-only JSONL journal on disk. */
export class FilePublicationJournal implements PublicationJournalStore {
  constructor(readonly path: string) {}

  async append(entry: PublicationJournalEntry): Promise<void> {
    const line = `${JSON.stringify(validatePublicationJournalEntry(entry))}\n`;
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, line, 'utf8');
  }

  async readAll(): Promise<PublicationJournalEntry[]> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    return parsePublicationJournalText(text);
  }
}

/** Convenience: map the journalled state of a key to its `PublishOutcome`. */
export function outcomeOf(entry: PublicationJournalEntry): PublishOutcome {
  return {
    outcome: entry.outcome,
    idempotencyKey: entry.idempotencyKey,
    ...(entry.remoteId ? { remoteId: entry.remoteId } : {}),
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.detail ? { detail: entry.detail } : {}),
  };
}
