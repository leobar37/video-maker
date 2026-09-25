/**
 * End-to-end driver (offline): the same pipeline shape as live — narration
 * master, music bed reuse, assemble, qa, publish dry-run, self-checks and
 * metrics — with $0 `offline:` journal entries and zero network/secrets.
 * Also proves the spend-cap refusals fire BEFORE any submit.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeTestDeps, makeTestProject, type TestDeps } from '../pipeline/test-support';
import type { MediaCommandDeps } from '../pipeline/deps';

import { readJournalSummary } from './journal';
import { runE2e } from './run';

/** ffprobe seam answering the acceptance probe (duration + audio stream). */
function depsWithFfprobe(base: TestDeps): MediaCommandDeps {
  return {
    ...base,
    process: {
      async run() {
        return {
          code: 0,
          stdout: JSON.stringify({
            format: { duration: '6.5' },
            streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
          }),
          stderr: '',
        };
      },
    },
  };
}

interface SpendFile {
  attempts: Array<{ attemptId: string; state: string; reservedUsd: number }>;
}

async function readSpend(dir: string): Promise<SpendFile> {
  return JSON.parse(await readFile(join(dir, 'qa', 'spend.json'), 'utf8')) as SpendFile;
}

describe('runE2e — offline mode', () => {
  test('produces narration timings, $0 journal entries, metrics and exit 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-e2e-run-'));
    await makeTestProject(dir);
    const base = makeTestDeps();
    const lines: string[] = [];
    const result = await runE2e({
      argv: ['--mode', 'offline', '--project', dir],
      cwd: dir,
      deps: depsWithFfprobe(base),
      out: (line) => lines.push(line),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(result.exitCode).toBe(0);
    expect(result.report?.passed).toBe(true);
    expect(lines.join('\n')).toContain('e2e: OK');

    const meta = JSON.parse(
      await readFile(join(dir, 'script', 'audio', 'narration.json'), 'utf8'),
    ) as { provider: string; scenes: unknown[] };
    expect(meta.provider).toBe('offline-synth');
    expect(meta.scenes).toHaveLength(2);

    const spend = await readSpend(dir);
    // Append-only journal: one submit + one complete entry per operation,
    // two distinct operations, every one of them $0 and offline-marked.
    const attemptIds = new Set(spend.attempts.map((attempt) => attempt.attemptId));
    expect(attemptIds.size).toBe(2);
    for (const attemptId of attemptIds) {
      expect(attemptId.startsWith('offline:')).toBe(true);
    }
    for (const attempt of spend.attempts) {
      expect(attempt.reservedUsd).toBe(0);
    }
    const summary = await readJournalSummary(dir);
    expect(summary.entries).toHaveLength(2);
    expect(summary.counts.completed).toBe(2);

    const metrics = JSON.parse(await readFile(join(dir, 'qa', 'metrics.json'), 'utf8')) as {
      schemaVersion: number;
      mode: string;
      spend: { totalJournalledUsd: number; operations: unknown[] };
    };
    expect(metrics.schemaVersion).toBe(1);
    expect(metrics.mode).toBe('offline');
    expect(metrics.spend.totalJournalledUsd).toBe(0);
    expect(metrics.spend.operations).toHaveLength(2);
    await expect(stat(join(dir, 'renders', 'test-video.mp4'))).resolves.toBeTruthy();

    // Reruns are idempotent: the journal never duplicates an operation.
    const rerun = await runE2e({
      argv: ['--mode', 'offline', '--project', dir],
      cwd: dir,
      deps: depsWithFfprobe(makeTestDeps()),
      out: () => {},
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(rerun.exitCode).toBe(0);
    expect(new Set((await readSpend(dir)).attempts.map((attempt) => attempt.attemptId)).size).toBe(2);
    expect(base.calls.submits).toHaveLength(0);
    expect(base.calls.fetch).toBe(0);
    expect(base.calls.secrets).toEqual([]);
  });
});

describe('runE2e — spend-cap enforcement', () => {
  test('refuses paid operations without --spend-cap and submits nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-e2e-cap-'));
    await makeTestProject(dir);
    const base = makeTestDeps();
    const lines: string[] = [];
    const result = await runE2e({
      argv: ['--mode', 'live', '--project', dir],
      cwd: dir,
      deps: depsWithFfprobe(base),
      out: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(2);
    expect(lines.join('\n')).toContain('planned costs');
    expect(lines.join('\n')).toContain('--spend-cap');
    expect(base.calls.submits).toHaveLength(0);
    await expect(stat(join(dir, 'qa', 'spend.json'))).rejects.toBeTruthy();
  });

  test('refuses when the planned spend would exceed the cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-e2e-cap-'));
    await makeTestProject(dir);
    const base = makeTestDeps();
    const lines: string[] = [];
    const result = await runE2e({
      argv: ['--mode', 'live', '--spend-cap', '0.01', '--project', dir],
      cwd: dir,
      deps: depsWithFfprobe(base),
      out: (line) => lines.push(line),
    });

    expect(result.exitCode).toBe(2);
    expect(lines.join('\n')).toContain('exceeds the spend cap');
    expect(base.calls.submits).toHaveLength(0);
  });
});
