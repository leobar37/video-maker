/**
 * QA verification: artifact hash tampering is caught and loudness outside the
 * tolerance blocks — both with actionable detail and exit != 0.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256File } from '@videomaker/core';

import { runQa } from './qa';
import { writeJsonArtifact } from './evidence';
import { EBUR128_SUMMARY_LOUD, makeTestDeps, makeTestProject } from './test-support';

async function evidenceFixture(dir: string): Promise<void> {
  await makeTestProject(dir);
  await mkdir(join(dir, 'renders'), { recursive: true });
  const mp4 = join(dir, 'renders', 'test-video.mp4');
  await writeFile(mp4, 'rendered video bytes');
  const sha256 = await sha256File(mp4);
  await writeJsonArtifact(join(dir, 'qa', 'report.json'), {
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    command: 'assemble',
    result: { mp4: 'renders/test-video.mp4', sha256, qaPassed: true, durationSeconds: 6 },
    artifacts: [{ path: 'renders/test-video.mp4', role: 'render', sha256, bytes: 18 }],
    inputs: [
      {
        path: 'script/audio/narration.wav',
        role: 'narration-master',
        sha256: 'a'.repeat(64),
        source: 'script/audio/narration.json#wavSha256',
      },
    ],
    checks: [{ code: 'artifact-hashes', label: 'hashes', status: 'pass', detail: 'ok' }],
  });
}

describe('runQa', () => {
  test('passes when hashes match and loudness is within tolerance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-qa-'));
    await evidenceFixture(dir);
    const result = await runQa({
      projectDir: dir,
      deps: makeTestDeps(),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.failures).toEqual([]);
    expect(result.checks.map((check) => check.status)).toEqual(['pass', 'pass']);
  });

  test('catches hash tamper on a produced artifact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-qa-'));
    await evidenceFixture(dir);
    await writeFile(join(dir, 'renders', 'test-video.mp4'), 'TAMPERED video bytes');
    const result = await runQa({
      projectDir: dir,
      deps: makeTestDeps(),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    });
    expect(result.exitCode).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain('artifact-hashes');
    expect(result.failures[0]).toContain('renders/test-video.mp4');
    expect(result.failures[0]).toContain('modified after evidence was written');

    // The fresh report records the blocked verdict (the qa gate goes pending).
    const report = JSON.parse(await readFile(join(dir, 'qa', 'report.json'), 'utf8')) as {
      result: { qaPassed: boolean };
      checks: { code: string; status: string }[];
    };
    expect(report.result.qaPassed).toBe(false);
    expect(report.checks.find((check) => check.code === 'artifact-hashes')?.status).toBe('blocked');
  });

  test('blocks loudness outside the tolerance with measured detail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-qa-'));
    await evidenceFixture(dir);
    const result = await runQa({
      projectDir: dir,
      deps: makeTestDeps({ ebur128Summary: EBUR128_SUMMARY_LOUD }),
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    });
    expect(result.exitCode).toBe(1);
    const loudnessFailure = result.failures.find((failure) => failure.startsWith('loudness:'));
    expect(loudnessFailure).toBeDefined();
    expect(loudnessFailure).toContain('I=-8.00 LUFS');
    expect(loudnessFailure).toContain('TP=0.50 dBTP');

    const loudness = JSON.parse(await readFile(join(dir, 'qa', 'loudness.json'), 'utf8')) as {
      passed: boolean;
      measured: { integratedLufs: number };
    };
    expect(loudness.passed).toBe(false);
    expect(loudness.measured.integratedLufs).toBe(-8);
  });

  test('fails actionable when there is no evidence report yet', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-qa-'));
    await makeTestProject(dir);
    await expect(
      runQa({
        projectDir: dir,
        deps: makeTestDeps(),
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        out: () => {},
      }),
    ).rejects.toThrow(/vm assemble/);
  });
});
