/**
 * Publication journal: append-only, recoverable per attempt, resumable reads.
 * A new reader must resume exactly where the writer stopped — and the entry
 * shape is closed so secrets can never be journalled (NFR-001).
 */
import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  attemptsUsed,
  FilePublicationJournal,
  InMemoryPublicationJournal,
  JournalError,
  latestByAttempt,
  latestByKey,
  parsePublicationJournalText,
  validatePublicationJournalEntry,
  type PublicationJournalEntry,
} from './journal';

function entry(overrides: Partial<PublicationJournalEntry> = {}): PublicationJournalEntry {
  return {
    schemaVersion: 1,
    idempotencyKey: 'key-1',
    attempt: 1,
    outcome: 'published',
    at: '2026-09-24T12:00:00.000Z',
    remoteId: 'post-1',
    ...overrides,
  };
}

async function journalPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'videomaker-journal-'));
  return join(dir, 'publication.jsonl');
}

describe('publication journal entries', () => {
  it('accepts a well-formed entry and rejects unknown fields (no secret smuggling)', () => {
    expect(validatePublicationJournalEntry(entry())).toBeTruthy();
    expect(() =>
      validatePublicationJournalEntry({ ...entry(), authorization: 'Bearer secret' }),
    ).toThrow(JournalError);
    expect(() => validatePublicationJournalEntry({ ...entry(), attempt: 0 })).toThrow(JournalError);
    expect(() => validatePublicationJournalEntry({ ...entry(), outcome: 'maybe' })).toThrow(
      JournalError,
    );
    expect(() => validatePublicationJournalEntry({ ...entry(), at: 'ayer' })).toThrow(JournalError);
  });

  it('skips a truncated trailing line (crash recovery) but not middle corruption', () => {
    const good = JSON.stringify(entry());
    const truncated = '{"schemaVersion":1,"idempotencyKey":"key-1","atten';
    const parsed = parsePublicationJournalText(`${good}\n${truncated}`);
    expect(parsed).toHaveLength(1);

    const corruptMiddle = `${good}\nnot-json\n${JSON.stringify(entry({ attempt: 2 }))}`;
    expect(() => parsePublicationJournalText(corruptMiddle)).toThrow(JournalError);
  });
});

describe('FilePublicationJournal', () => {
  it('write → a new reader resumes exactly (per attempt, in order)', async () => {
    const path = await journalPath();
    const writer = new FilePublicationJournal(path);

    await writer.append(entry({ attempt: 1, outcome: 'uncertain', remoteId: undefined, detail: 'no receipt' }));
    await writer.append(entry({ attempt: 2, outcome: 'published', remoteId: 'post-7' }));
    await writer.append(
      entry({ idempotencyKey: 'key-2', attempt: 1, outcome: 'accepted', remoteId: 'post-8' }),
    );

    const reader = new FilePublicationJournal(path);
    const entries = await reader.readAll();
    expect(entries.map((e) => [e.idempotencyKey, e.attempt, e.outcome])).toEqual([
      ['key-1', 1, 'uncertain'],
      ['key-1', 2, 'published'],
      ['key-2', 1, 'accepted'],
    ]);

    const latest = latestByKey(entries);
    expect(latest.get('key-1')?.outcome).toBe('published');
    expect(latest.get('key-2')?.outcome).toBe('accepted');
    expect(attemptsUsed(entries, 'key-1')).toBe(2);
  });

  it('recovers state transitions of the same attempt number', async () => {
    const path = await journalPath();
    const writer = new FilePublicationJournal(path);
    await writer.append(entry({ attempt: 1, outcome: 'uncertain', remoteId: undefined }));
    // Reconcile resolves the SAME attempt (a state transition, not a new one).
    await writer.append(
      entry({ attempt: 1, outcome: 'failed', remoteId: undefined, detail: 'reconciled: absent' }),
    );

    const entries = await new FilePublicationJournal(path).readAll();
    expect(entries).toHaveLength(2);
    expect(latestByAttempt(entries).get('key-1#1')?.outcome).toBe('failed');
    expect(attemptsUsed(entries, 'key-1')).toBe(1);
  });

  it('reads an empty journal when the file does not exist yet', async () => {
    expect(await new FilePublicationJournal(await journalPath()).readAll()).toEqual([]);
  });

  it('round-trips through disk without inventing fields', async () => {
    const path = await journalPath();
    const original = entry({ detail: 'HTTP 409 dedupe', url: 'https://social.example.com/p/1' });
    await new FilePublicationJournal(path).append(original);
    expect(await new FilePublicationJournal(path).readAll()).toEqual([original]);
  });
});

describe('InMemoryPublicationJournal', () => {
  it('matches the file contract for append + readAll', async () => {
    const journal = new InMemoryPublicationJournal();
    await journal.append(entry());
    await journal.append(entry({ attempt: 2, outcome: 'failed', remoteId: undefined }));
    const entries = await journal.readAll();
    expect(entries.map((e) => e.outcome)).toEqual(['published', 'failed']);
    expect(() => validatePublicationJournalEntry(42)).toThrow(JournalError);
  });
});
