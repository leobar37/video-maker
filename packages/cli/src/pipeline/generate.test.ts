/**
 * Paid generation: gen-audio writes the continuous master + timings with a
 * journaled receipt, gen-media journals per-scene receipts to qa/spend.json,
 * and every run refuses to spend without the explicit cap (spec-level).
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PaidOperationRecord } from '@videomaker/core';
import type { ContinuousNarration } from '@videomaker/schemas';

import { runGenAudio, runGenMedia } from './generate';
import { makeTestDeps, makeTestProject } from './test-support';

describe('runGenAudio', () => {
  test('synthesizes once and writes narration.wav + gap-free narration.json with a receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-gen-audio-'));
    await makeTestProject(dir);
    const deps = makeTestDeps();

    const result = await runGenAudio({
      projectDir: dir,
      deps,
      spendCapUsd: 2,
      estimatedCostUsd: 0.5,
      force: false,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    });

    expect(result.replayed).toBe(false);
    expect(deps.calls.submits).toHaveLength(1);
    expect(deps.calls.submits[0]?.input.kind).toBe('tts');
    expect(deps.calls.submits[0]?.input.params.voiceId).toBe('voice-1');

    const meta = JSON.parse(
      await readFile(join(dir, 'script', 'audio', 'narration.json'), 'utf8'),
    ) as ContinuousNarration;
    expect(meta.mode).toBe('continuous');
    expect(meta.scenes).toHaveLength(2);
    expect(meta.scenes[0]?.endSeconds).toBe(meta.scenes[1]?.startSeconds);
    expect(meta.scenes[1]?.endSeconds).toBe(meta.durationSeconds);
    expect(meta.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(meta.wavSha256).toMatch(/^[a-f0-9]{64}$/);

    // The paid attempt is journalled to qa/spend.json (submit-once receipt,
    // append-only: submit entry + completion entry for the same attempt).
    const ledger = JSON.parse(await readFile(join(dir, 'qa', 'spend.json'), 'utf8')) as {
      attempts: PaidOperationRecord[];
    };
    expect(new Set(ledger.attempts.map((entry) => entry.attemptId)).size).toBe(1);
    const latest = ledger.attempts[ledger.attempts.length - 1]!;
    expect(latest.state).toBe('completed');
    expect(latest.receipt?.requestId).toContain('fake-tts-job');
    expect(latest.command).toBe('gen-audio');
  });

  test('replays a verified master with zero submits on re-run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-gen-audio-'));
    await makeTestProject(dir);
    const deps = makeTestDeps();
    const options = {
      projectDir: dir,
      deps,
      spendCapUsd: 2,
      estimatedCostUsd: null,
      force: false,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    };
    await runGenAudio(options);
    const again = await runGenAudio(options);
    expect(again.replayed).toBe(true);
    expect(deps.calls.submits).toHaveLength(1);
  });
});

describe('runGenMedia', () => {
  test('journals one receipt per scene to qa/spend.json', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-gen-media-'));
    await makeTestProject(dir);
    // A fal-video scene with its declarative request + input files.
    const manifest = JSON.parse(await readFile(join(dir, 'video.json'), 'utf8')) as {
      scenes: Record<string, unknown>[];
    };
    manifest.scenes = [
      {
        id: 'scene-v',
        intent: 'media-frame',
        source: 'fal-video',
        narration: 'Escena generada.',
        status: 'active',
        falVideo: {
          provider: 'fal',
          qualityTier: 'support',
          preset: 'kling-2.5-turbo-standard-i2v',
          initialImage: 'assets/first.png',
          promptFile: 'scenes/scene-v/prompt.txt',
          duration: 5,
          maxAttempts: 1,
          budgetUsd: 0.8,
        },
      },
    ];
    await writeFile(join(dir, 'video.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(dir, 'assets', 'first.png'), 'fake png');
    await mkdir(join(dir, 'scenes', 'scene-v'), { recursive: true });
    await writeFile(join(dir, 'scenes', 'scene-v', 'prompt.txt'), 'Un coche rojo avanza.');

    const deps = makeTestDeps();
    const result = await runGenMedia({
      projectDir: dir,
      deps,
      spendCapUsd: 5,
      estimatedCostUsd: null,
      force: false,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    });

    expect(result.scenes).toHaveLength(1);
    expect(result.scenes[0]?.output).toBe('scenes/scene-v/media/video.mp4');
    const ledger = JSON.parse(await readFile(join(dir, 'qa', 'spend.json'), 'utf8')) as {
      attempts: PaidOperationRecord[];
    };
    expect(new Set(ledger.attempts.map((entry) => entry.attemptId)).size).toBe(1);
    const latest = ledger.attempts[ledger.attempts.length - 1]!;
    expect(latest.command).toBe('gen-media');
    expect(latest.subject).toContain('gen-media:scene-v:');
    expect(latest.receipt?.requestId).toContain('fake-fal-video-job');
    // The preset KEY resolves to the fal queue route + pinned request shape;
    // it is never used raw as a URL segment (that route does not exist).
    expect(deps.calls.submits[0]?.input.params).toMatchObject({
      modelId: 'fal-ai/kling-video/v2.5-turbo/standard/image-to-video',
      durationFormat: 'plain',
      defaultInput: {},
      firstFrameField: 'image_url',
    });
  });
});
