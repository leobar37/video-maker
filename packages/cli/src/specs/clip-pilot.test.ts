import { afterEach, describe, expect, test } from 'bun:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256File } from '@videomaker/core';
import type { ClipDecision, ClipPilotEvidence, ClipPilotPolicy, ClipRange, FrameAnalysis } from '@videomaker/schemas';

import { readClipPilotProvenance } from '../creator/pilot';
import { makeTestContext, makeTestDeps, makeTestProject } from '../pipeline/test-support';
import { buildClipRenderSpecs } from './clip';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vm-spec-pilot-'));
  temporary.push(dir);
  await makeTestProject(dir);
  await mkdir(join(dir, 'clips/analysis'), { recursive: true });
  await writeFile(join(dir, 'clips/source.mp4'), 'synthetic offline source bytes');
  const sourceSha256 = await sha256File(join(dir, 'clips/source.mp4'));
  await writeFile(join(dir, 'clips/source.json'), JSON.stringify({
    schemaVersion: 1, sha256: sourceSha256, width: 1280, height: 720, fps: 30, durationSeconds: 9, path: 'source.mp4',
  }));
  const ranges: ClipRange[] = ['sample', 'rest', 'negative'].map((id, index) => ({
    schemaVersion: 1, id, start: index * 3, end: index * 3 + 2, score: 0.8,
    breakdown: { highlight: 0.8, hook: 0.8, density: 0.8, emotion: 0.8, novelty: 0.8, closure: 0.8 },
    layout: 'single', faces: [{ id: 'speaker-a', bbox: [100, 100, 250, 250], presence: 1 }],
    social: { title: 'Synthetic clip', description: 'Offline fixture only.', hashtags: ['test'] },
  }));
  const frames: FrameAnalysis[] = Array.from({ length: 9 }, (_, t) => ({
    schemaVersion: 1, frame_id: `f-${String(t + 1).padStart(6, '0')}`, t,
    speakers: [{ id: 'speaker-a', bbox: [100, 100, 250, 250], speaking: true }],
    sceneCut: false, energy: 0.5, topic: 'synthetic', highlight: 0.5,
  }));
  await writeFile(join(dir, 'clips/analysis/shard-001.json'), JSON.stringify({ schemaVersion: 1, sourceSha256, status: 'ok', frames }));
  const words = ranges.flatMap((range) => [
    { word: 'premisa', start: range.start + 0.1, end: range.start + 0.5 },
    { word: 'remate', start: range.end - 0.5, end: range.end - 0.1 },
  ]);
  await writeFile(join(dir, 'clips/transcript.json'), JSON.stringify({ schemaVersion: 1, language: 'es', words }));
  const decisions: ClipDecision = { schemaVersion: 1, sourceSha256, backend: 'offline-fixture',
    decisions: ranges.map((range) => ({ range, status: range.id === 'negative' ? 'rejected' : 'approved' })) };
  await writeFile(join(dir, 'clips/decisions.json'), JSON.stringify(decisions));
  const policy: ClipPilotPolicy = { schemaVersion: 1, enabled: true, sampleIds: ['sample'], contentType: 'educational', maxCandidates: 5 };
  await writeFile(join(dir, 'clips/pilot-policy.json'), JSON.stringify(policy));
  const deps = makeTestDeps();
  let processCalls = 0;
  deps.process = { async run() { processCalls += 1; throw new Error('Unexpected subprocess'); } };
  const render = buildClipRenderSpecs(deps)[0]!;
  const review = { reviewer: 'Synthetic fixture reviewer (not real ASR review)', reviewedAt: '2026-01-01T00:00:00.000Z' };
  const criteria = {
    premisa: { passes: true, note: 'Synthetic premise retained.' },
    autonomia: { passes: true, note: 'Synthetic standalone context.' },
    remate: { passes: true, note: 'Synthetic ending retained.' },
    fidelidad: { passes: true, note: 'Synthetic meaning unchanged.' },
  };
  async function approveSample(): Promise<ClipPilotEvidence> {
    const evidence: ClipPilotEvidence = {
      schemaVersion: 1, approval: 'approved', ...review, contentType: 'educational',
      provenance: await readClipPilotProvenance({ projectDir: dir, decisions, words, frames }),
      examples: [
        { kind: 'positive', range: ranges[0]!, ...review, criteria },
        { kind: 'negative', range: ranges[2]!, ...review, criteria: { ...criteria, remate: { passes: false, note: 'Synthetic bad ending.' } } },
      ],
      sample: { rangeId: 'sample', path: 'renders/clips/sample.mp4', sha256: await sha256File(join(dir, 'renders/clips/sample.mp4')) },
      transcriptReview: { ...review, trustworthy: true, unreliableWordIndexes: [] },
      framingReview: { ...review, safeFramingReviewed: true, layoutReviewed: true },
      edl: ranges.slice(0, 2).map((range) => ({
        range, startFrame: frames.find((frame) => frame.t === range.start)!, endFrame: frames.find((frame) => frame.t === range.end)!,
        reactionWindows: [], layoutChanges: [],
      })),
    };
    await writeFile(join(dir, 'clips/pilot-evidence.json'), JSON.stringify(evidence));
    return evidence;
  }
  return { dir, deps, render, policy, approveSample, processCalls: () => processCalls };
}

describe('clip-render pilot preflight before mass effects', () => {
  test('active unapproved policy rejects default or arbitrary --id before any effects/output', async () => {
    const { dir, deps, render, processCalls } = await fixture();
    const lines: string[] = [];
    const selections: Record<string, string | string[]>[] = [{ project: dir }, { project: dir, id: ['rest'] }];
    for (const args of selections) {
      await expect(render.run(makeTestContext(args, { lines }))).rejects.toThrow(/Editorial clip pilot/);
    }
    expect(deps.calls.renderVideo).toEqual([]);
    expect(deps.calls.renderStill).toEqual([]);
    expect(deps.calls.ffmpeg).toEqual([]);
    expect(processCalls()).toBe(0);
    expect(lines).toEqual([]);
    await expect(access(join(dir, 'clips/trimmed'))).rejects.toThrow();
    await expect(access(join(dir, 'public/media/clips'))).rejects.toThrow();
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.publish).toBe(0);
  });

  test('sample renders first, then explicit synthetic editorial approval releases the rest', async () => {
    const { dir, deps, render, approveSample, processCalls } = await fixture();
    await render.run(makeTestContext({ project: dir, id: ['sample'] }));
    expect(deps.calls.renderVideo).toHaveLength(1);
    expect(await Bun.file(join(dir, 'clips/pilot-evidence.json')).exists()).toBe(false);
    const evidence = await approveSample();
    const sampleBefore = await sha256File(join(dir, 'renders/clips/sample.mp4'));
    await render.run(makeTestContext({ project: dir, id: ['rest'] }));
    expect(deps.calls.renderVideo.map((call) => call.outputLocation)).toEqual([
      join(dir, 'renders/clips/sample.mp4'), join(dir, 'renders/clips/rest.mp4'),
    ]);
    expect(await sha256File(join(dir, 'renders/clips/sample.mp4'))).toBe(sampleBefore);
    expect(JSON.parse(await readFile(join(dir, 'clips/pilot-evidence.json'), 'utf8'))).toEqual(evidence);
    expect(await Bun.file(join(dir, 'creator/approval.json')).exists()).toBe(false);
    expect(deps.calls.publish).toBe(0);
    expect(deps.calls.fetch).toBe(0);
    expect(deps.calls.secrets).toEqual([]);
    expect(processCalls()).toBe(0);
  });

  test('mutated sample rejects before any new rendering/staging', async () => {
    const { dir, deps, render, approveSample } = await fixture();
    await render.run(makeTestContext({ project: dir, id: ['sample'] }));
    await approveSample();
    const ffmpegBefore = deps.calls.ffmpeg.length;
    await writeFile(join(dir, 'renders/clips/sample.mp4'), 'changed synthetic montage');
    await expect(render.run(makeTestContext({ project: dir, id: ['rest'] }))).rejects.toThrow(/sample artifact has changed/);
    expect(deps.calls.renderVideo).toHaveLength(1);
    expect(deps.calls.ffmpeg).toHaveLength(ffmpegBefore);
    await expect(access(join(dir, 'public/media/clips/rest.mp4'))).rejects.toThrow();
  });

  test('absent and explicitly disabled policies preserve normal default rendering', async () => {
    for (const enabled of [undefined, false]) {
      const { dir, deps, render, policy } = await fixture();
      if (enabled === undefined) await rm(join(dir, 'clips/pilot-policy.json'));
      else await writeFile(join(dir, 'clips/pilot-policy.json'), JSON.stringify({ ...policy, enabled }));
      const result = await render.run(makeTestContext({ project: dir }));
      expect(result.exitCode).toBe(0);
      expect(deps.calls.renderVideo).toHaveLength(2);
      expect(deps.calls.publish).toBe(0);
    }
  });

  test('invalid active policy fails closed, while plan does not even parse policy', async () => {
    const { dir, deps, render, processCalls } = await fixture();
    await writeFile(join(dir, 'clips/pilot-policy.json'), '{ invalid policy');
    const steps = await render.plan(makeTestContext({ project: dir }, { mode: 'plan' }));
    expect(steps).toHaveLength(5);
    await expect(render.run(makeTestContext({ project: dir }))).rejects.toThrow(/invalid JSON/);
    expect(deps.calls.ffmpeg).toEqual([]);
    expect(deps.calls.renderVideo).toEqual([]);
    expect(deps.calls.renderStill).toEqual([]);
    expect(processCalls()).toBe(0);
  });
});
