/**
 * Publish orchestration: 409 dedupe answers are `accepted` (not a failure),
 * every attempt is journaled under qa/publication/<attempt>/journal.json, and
 * the spend gate refuses while paid attempts are unresolved.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PublishJournal } from './publish';
import { runPublish } from './publish';
import { FileSpendLedger, spendLedgerPath } from './spend-ledger';
import { makeTestDeps, makeTestProject, type TestDeps } from './test-support';

async function publishFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vm-publish-'));
  await makeTestProject(dir);
  return dir;
}

function baseOptions(dir: string, deps: TestDeps) {
  return {
    projectDir: dir,
    deps,
    account: '@demo',
    text: 'Mira este video.',
    media: ['https://cdn.example.test/video.mp4'],
    idempotencyKey: 'publish:demo:test-video:1',
    spendCapUsd: 1,
    force: false,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    out: () => {},
  };
}

describe('runPublish', () => {
  test('409 dedupe ⇒ accepted, journaled and replayed without a second submit', async () => {
    const dir = await publishFixture();
    const deps = makeTestDeps({
      publishImpl: async () => ({
        outcome: 'accepted',
        idempotencyKey: 'publish:demo:test-video:1',
        remoteId: 'remote-post-9',
        detail: 'HTTP 409 dedupe: already published remotely (remote-post-9)',
      }),
    });

    const first = await runPublish(baseOptions(dir, deps));
    expect(first.exitCode).toBe(0);
    expect(first.outcome.outcome).toBe('accepted');
    expect(first.outcome.remoteId).toBe('remote-post-9');
    expect(deps.calls.publish).toBe(1);

    const journalPath = join(dir, 'qa', 'publication', 'publish-demo-test-video-1', 'journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as PublishJournal;
    expect(journal.schemaVersion).toBe(1);
    expect(journal.outcome).toBe('accepted');
    expect(journal.stages).toContain('complete');
    expect(journal.attempts).toHaveLength(1);
    expect(journal.attempts[0]?.outcome).toBe('accepted');
    expect(journal.attempts[0]?.action).toBe('publish');

    // Second invocation: dedupe replay from the journal — NO new submit.
    const second = await runPublish(baseOptions(dir, deps));
    expect(second.exitCode).toBe(0);
    expect(second.outcome.outcome).toBe('accepted');
    expect(deps.calls.publish).toBe(1);
    const replayed = JSON.parse(await readFile(journalPath, 'utf8')) as PublishJournal;
    expect(replayed.attempts).toHaveLength(2);
    expect(replayed.attempts[1]?.action).toBe('replay');
  });

  test('journals each attempt; a definite rejection fails without stage complete', async () => {
    const dir = await publishFixture();
    const deps = makeTestDeps({
      publishImpl: async () => ({
        outcome: 'failed',
        idempotencyKey: 'publish:demo:test-video:1',
        detail: 'HTTP 422: media URL not reachable',
      }),
    });
    const result = await runPublish(baseOptions(dir, deps));
    expect(result.exitCode).toBe(1);
    expect(result.outcome.outcome).toBe('failed');

    const journal = JSON.parse(
      await readFile(join(dir, result.journalPath), 'utf8'),
    ) as PublishJournal;
    expect(journal.outcome).toBe('failed');
    expect(journal.stages).not.toContain('complete');
    expect(journal.attempts[0]?.detail).toContain('HTTP 422');
  });

  test('a thrown submit stays uncertain and is never auto-retried', async () => {
    const dir = await publishFixture();
    let calls = 0;
    const deps = makeTestDeps({
      publishImpl: async () => {
        calls += 1;
        throw new Error('socket hang up');
      },
    });
    const result = await runPublish(baseOptions(dir, deps));
    expect(result.exitCode).toBe(1);
    expect(result.outcome.outcome).toBe('uncertain');
    expect(calls).toBe(1);

    // Re-invoking does NOT resubmit while the outcome is uncertain.
    await expect(runPublish(baseOptions(dir, deps))).rejects.toThrow(/uncertain/i);
    expect(calls).toBe(1);
  });

  test('the spend gate refuses while paid attempts are unresolved', async () => {
    const dir = await publishFixture();
    const ledger = new FileSpendLedger(spendLedgerPath(dir));
    await ledger.append({
      schemaVersion: 1,
      attemptId: 'attempt-1',
      planDigest: 'b'.repeat(64),
      command: 'gen-media',
      subject: 'gen-media:scene-a:abc',
      state: 'uncertain',
      reservedUsd: 0.5,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const deps = makeTestDeps();
    await expect(runPublish(baseOptions(dir, deps))).rejects.toThrow(/spend gate closed/);
    expect(deps.calls.publish).toBe(0);
  });

  test('scheduled posts go through publisher.schedule with the same journal', async () => {
    const dir = await publishFixture();
    const actions: string[] = [];
    const deps = makeTestDeps({
      publishImpl: async (action) => {
        actions.push(action);
        return {
          outcome: 'published',
          idempotencyKey: 'publish:demo:test-video:1',
          remoteId: 'remote-scheduled-1',
        };
      },
    });
    const result = await runPublish({
      ...baseOptions(dir, deps),
      scheduledFor: '2026-02-01T12:00:00.000Z',
    });
    expect(result.exitCode).toBe(0);
    expect(actions).toEqual(['schedule']);
    const journal = JSON.parse(await readFile(join(dir, result.journalPath), 'utf8')) as PublishJournal;
    expect(journal.post.scheduledFor).toBe('2026-02-01T12:00:00.000Z');
    expect(journal.stages).toContain('complete');
  });
});
