/**
 * Assemble dry flow (zero network/secrets): the film props are composed from
 * the narration timings exactly as the render consumes them, evidence pins
 * every produced artifact (FR-011) and the loudness stage is gate-configurable.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256File, sha256Hex, type VideoConfig } from '@videomaker/core';
import { filmTimingPlan } from '@videomaker/motion-core';
import type { FilmProps } from '@videomaker/motion-remotion';

import { buildContinuousNarrationMeta, joinSceneNarration } from './narration';
import { buildDuckMusicArgs, runAssemble, runStill } from './assemble';
import { makeTestDeps, makeTestProject } from './test-support';

function alignmentFor(text: string): {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
} {
  const characters = Array.from(text);
  return {
    characters,
    character_start_times_seconds: characters.map((_, index) => index * 0.1),
    character_end_times_seconds: characters.map((_, index) => index * 0.1 + 0.05),
  };
}

async function projectWithNarration(
  dir: string,
): Promise<{ config: VideoConfig; narrationText: string }> {
  const config = await makeTestProject(dir);
  const joined = joinSceneNarration(
    config.scenes
      .filter((scene) => scene.status === 'active')
      .map((scene) => ({ id: scene.id, narration: scene.narration })),
  );
  const wavBytes = new TextEncoder().encode('fake narration wav bytes');
  const wavPath = join(dir, 'script', 'audio', 'narration.wav');
  await writeFile(wavPath, wavBytes);
  const meta = buildContinuousNarrationMeta({
    tts: config.tts,
    joined,
    alignment: alignmentFor(joined.text),
    masterDurationSeconds: 6,
    wavSha256: sha256Hex(wavBytes),
    wav: 'script/audio/narration.wav',
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  await writeFile(join(dir, 'script', 'audio', 'narration.json'), JSON.stringify(meta, null, 2));
  return { config, narrationText: joined.text };
}

describe('runAssemble (dry flow)', () => {
  test('composes the film props from the narration timings and renders with them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-assemble-'));
    const { config } = await projectWithNarration(dir);
    const deps = makeTestDeps();

    const result = await runAssemble({
      projectDir: dir,
      deps,
      outDir: 'renders',
      loudness: true,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    });

    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.secrets).toEqual([]);
    expect(deps.calls.renderVideo).toHaveLength(1);
    const render = deps.calls.renderVideo[0]!;
    const props = render.inputProps as FilmProps;

    // Film props come from the narration timings, not from durationHints:
    // scene-a ends where scene-b's first spoken char starts (0.1s per char).
    const boundary =
      (Array.from('Primera escena con voz.').length + Array.from('\n\n').length) * 0.1;
    expect(props.timingMode).toBe('continuous');
    expect(props.scenes.map((scene) => scene.id)).toEqual(['scene-a', 'scene-b']);
    expect(props.scenes[0]!.durationInSeconds).toBeCloseTo(boundary, 6);
    expect(props.scenes[1]!.durationInSeconds).toBeCloseTo(6 - boundary, 6);
    expect(props.narration).toEqual({ src: 'media/narration.wav', durationSeconds: 6 });
    expect(props.scenes[0]!.audioSrc).toBeUndefined();

    // Same frame math as the render path.
    const plan = filmTimingPlan({
      fps: config.fps,
      scenes: props.scenes,
      timingMode: props.timingMode,
      narration: props.narration ?? null,
    });
    expect(render.expectedDurationInFrames).toBe(plan.totalFrames);
    expect(result.totalFrames).toBe(plan.totalFrames);

    // Result contract shape: mp4 + sha256 + qa passed.
    expect(result.mp4).toBe('renders/test-video.mp4');
    expect(result.sha256).toBe(await sha256File(join(dir, 'renders', 'test-video.mp4')));
    expect(result.qaPassed).toBe(true);
  });

  test('writes evidence: artifact hashes, input provenance and loudness vs tolerance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-assemble-'));
    await projectWithNarration(dir);
    const deps = makeTestDeps();

    await runAssemble({
      projectDir: dir,
      deps,
      outDir: 'renders',
      loudness: true,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    });

    const report = JSON.parse(await readFile(join(dir, 'qa', 'report.json'), 'utf8')) as {
      schemaVersion: number;
      result: { mp4: string; sha256: string; qaPassed: boolean };
      artifacts: { path: string; sha256: string }[];
      inputs: { path: string; sha256: string; source: string }[];
      checks: { code: string; status: string }[];
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.result.mp4).toBe('renders/test-video.mp4');
    expect(report.result.qaPassed).toBe(true);
    expect(report.artifacts.map((artifact) => artifact.path)).toContain('renders/test-video.mp4');
    expect(report.artifacts.map((artifact) => artifact.path)).toContain(
      'public/media/narration.wav',
    );
    // Provenance of inputs: source artifact + pinned hash.
    const narrationInput = report.inputs.find((input) => input.path === 'script/audio/narration.wav');
    expect(narrationInput?.source).toBe('script/audio/narration.json#wavSha256');
    expect(narrationInput?.sha256).toBe(
      await sha256File(join(dir, 'script', 'audio', 'narration.wav')),
    );
    expect(report.checks.some((check) => check.code === 'artifact-hashes' && check.status === 'pass')).toBe(true);
    expect(report.checks.some((check) => check.code === 'loudness' && check.status === 'pass')).toBe(true);

    const loudness = JSON.parse(await readFile(join(dir, 'qa', 'loudness.json'), 'utf8')) as {
      measured: { integratedLufs: number; truePeakDbtp: number };
      tolerance: { targetLufs: number; targetTruePeakDbtp: number };
      passed: boolean;
    };
    expect(loudness.measured.integratedLufs).toBe(-14);
    expect(loudness.measured.truePeakDbtp).toBe(-1.5);
    expect(loudness.tolerance.targetLufs).toBe(-14);
    expect(loudness.tolerance.targetTruePeakDbtp).toBe(-1);
    expect(loudness.passed).toBe(true);
  });

  test('ducks a music bed under the narration when one exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-assemble-'));
    await projectWithNarration(dir);
    await writeFile(join(dir, 'script', 'audio', 'music.mp3'), 'fake music bed');
    const deps = makeTestDeps();

    await runAssemble({
      projectDir: dir,
      deps,
      outDir: 'renders',
      loudness: true,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    });

    const duck = deps.calls.ffmpeg.find((args) =>
      args.some((arg) => arg.includes('sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[duck]')),
    );
    expect(duck).toBeDefined();
    // Muxer contract: explicit output format AND a real .mp4 temp name —
    // ffmpeg cannot infer a container from a `.tmp` suffix.
    const output = duck![duck!.length - 1]!;
    expect(output.endsWith('.mp4')).toBe(true);
    expect(duck).toContain('-f');
    expect(duck![duck!.indexOf('-f') + 1]).toBe('mp4');
    expect(duck![duck!.indexOf('-f') + 2]).toBe(output);
    const report = JSON.parse(await readFile(join(dir, 'qa', 'report.json'), 'utf8')) as {
      inputs: { path: string; role: string; source: string }[];
    };
    expect(
      report.inputs.some((input) => input.role === 'music-bed' && input.source === 'gen-music'),
    ).toBe(true);
  });

  test('a failing duck keeps the render intact, cleans the temp and surfaces stderr', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-assemble-'));
    await projectWithNarration(dir);
    await writeFile(join(dir, 'script', 'audio', 'music.mp3'), 'fake music bed');
    const deps = makeTestDeps();
    const healthy = deps.ffmpeg;
    const stderr =
      'ffmpeg version 6.1 Copyright (c) 2000-2023 the FFmpeg developers\n' +
      'Error initializing the muxer for /tmp/x.duck.tmp.mp4: Invalid argument\n' +
      'Error opening output file /tmp/x.duck.tmp.mp4: Invalid argument\n';
    deps.ffmpeg = {
      async run(args) {
        if (args.some((arg) => arg.includes('sidechaincompress'))) {
          return { exitCode: 1, stdout: '', stderr };
        }
        return healthy.run(args);
      },
    };

    let message = '';
    try {
      await runAssemble({
        projectDir: dir,
        deps,
        outDir: 'renders',
        loudness: true,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        out: () => {},
      });
    } catch (error) {
      message = (error as Error).message;
    }

    // Head AND tail of ffmpeg's stderr survive into the message.
    expect(message).toContain('ffmpeg music ducking failed (exit 1)');
    expect(message).toContain('ffmpeg version 6.1');
    expect(message).toContain('Error initializing the muxer');
    expect(message).toContain('Invalid argument');

    // The original render is untouched and the temp is gone.
    const renders = await readdir(join(dir, 'renders'));
    expect(renders).toEqual(['test-video.mp4']);
    expect(await readFile(join(dir, 'renders', 'test-video.mp4'), 'utf8')).toBe(
      `fake mp4 for ${join(dir, 'renders', 'test-video.mp4')}`,
    );
  });

  test('narration wav tampering is refused before rendering', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-assemble-'));
    await projectWithNarration(dir);
    await writeFile(join(dir, 'script', 'audio', 'narration.wav'), 'tampered wav bytes');
    const deps = makeTestDeps();
    await expect(
      runAssemble({
        projectDir: dir,
        deps,
        outDir: 'renders',
        loudness: true,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        out: () => {},
      }),
    ).rejects.toThrow(/narration\.wav hash/);
    expect(deps.calls.renderVideo).toHaveLength(0);
  });

  test('missing prerequisites fail with the artifact named', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-assemble-'));
    await makeTestProject(dir);
    const deps = makeTestDeps();
    await expect(
      runAssemble({
        projectDir: dir,
        deps,
        outDir: 'renders',
        loudness: true,
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        out: () => {},
      }),
    ).rejects.toThrow(/script\/audio\/narration\.json/);
  });
});

describe('runStill', () => {
  test('samples frames with the SAME filmTimingPlan as the render path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vm-still-'));
    const { config } = await projectWithNarration(dir);
    const deps = makeTestDeps();

    const result = await runStill({
      projectDir: dir,
      deps,
      frac: 0.5,
      draft: false,
      outDir: 'qa/stills',
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      out: () => {},
    });

    expect(deps.calls.renderStill).toHaveLength(2);
    const first = deps.calls.renderStill[0]!;
    const props = first.inputProps as FilmProps;
    const plan = filmTimingPlan({
      fps: config.fps,
      scenes: props.scenes,
      timingMode: props.timingMode,
      narration: props.narration ?? null,
    });
    // Frame math is identical to the video path (narration changes no scene span).
    expect(first.expectedDurationInFrames).toBe(plan.totalFrames);
    expect(result.totalFrames).toBe(plan.totalFrames);
    const spanB = plan.spans[1]!;
    expect(result.stills[1]?.frame).toBeGreaterThanOrEqual(spanB.startFrame);
    expect(result.stills[1]?.frame).toBeLessThan(spanB.endFrame);
    expect(result.stills[1]?.png).toBe('qa/stills/scene-b.png');
    // No network, no secrets, no video render in the still path.
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.secrets).toEqual([]);
    expect(deps.calls.renderVideo).toEqual([]);
  });
});
