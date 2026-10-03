import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256File } from '@videomaker/core';
import type { ClipDecision, ClipPilotEvidence, ClipPilotPolicy, ClipRange, FrameAnalysis } from '@videomaker/schemas';

import { assertClipPilotReady, readClipPilotProvenance, type ClipPilotReadyInput } from './pilot';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const review = { reviewer: 'Synthetic fixture reviewer (not real ASR review)', reviewedAt: '2026-01-01T00:00:00.000Z' };
const criteria = {
  premisa: { passes: true, note: 'Synthetic premise preserved.' },
  autonomia: { passes: true, note: 'Synthetic standalone context.' },
  remate: { passes: true, note: 'Synthetic ending preserved.' },
  fidelidad: { passes: true, note: 'Synthetic meaning unchanged.' },
};

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'vm-pilot-guard-'));
  temporary.push(dir);
  await mkdir(join(dir, 'clips/analysis'), { recursive: true });
  await mkdir(join(dir, 'renders/clips'), { recursive: true });
  await writeFile(join(dir, 'clips/source.mp4'), 'synthetic offline source, not playable media');
  const sourceSha256 = await sha256File(join(dir, 'clips/source.mp4'));
  await writeFile(join(dir, 'clips/source.json'), JSON.stringify({ schemaVersion: 1, sha256: sourceSha256 }));
  const ranges: ClipRange[] = ['sample', 'rest', 'negative'].map((id, index) => ({
    schemaVersion: 1, id, start: index * 3, end: index * 3 + 2, score: 0.8,
    breakdown: { highlight: 0.8, hook: 0.8, density: 0.8, emotion: 0.8, novelty: 0.8, closure: 0.8 },
    layout: 'single', faces: [{ id: 'speaker-a', bbox: [100, 100, 250, 250], presence: 1 }],
    social: { title: 'Synthetic clip', description: 'Offline fixture only.', hashtags: ['test'] },
  }));
  const frames: FrameAnalysis[] = Array.from({ length: 9 }, (_, t) => ({
    schemaVersion: 1, frame_id: `f-${String(t + 1).padStart(6, '0')}`, t,
    speakers: [{ id: 'speaker-a', bbox: [100, 100, 250, 250], speaking: true }],
    sceneCut: t === 1, energy: 0.5, topic: 'synthetic', highlight: 0.5,
  }));
  const shard = { schemaVersion: 1, sourceSha256, status: 'ok', frames };
  await writeFile(join(dir, 'clips/analysis/shard-001.json'), JSON.stringify(shard));
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
  await writeFile(join(dir, 'renders/clips/sample.mp4'), 'synthetic inspected montage bytes');
  const input: ClipPilotReadyInput = { projectDir: dir, decisions, selectedRanges: ranges.slice(0, 2), words, frames };
  const evidence: ClipPilotEvidence = {
    schemaVersion: 1, approval: 'approved', ...review, contentType: 'educational',
    provenance: await readClipPilotProvenance(input),
    examples: [
      { kind: 'positive', range: ranges[0]!, ...review, criteria },
      { kind: 'negative', range: ranges[2]!, ...review, criteria: { ...criteria, remate: { passes: false, note: 'Synthetic bad ending.' } } },
    ],
    sample: { rangeId: 'sample', path: 'renders/clips/sample.mp4', sha256: await sha256File(join(dir, 'renders/clips/sample.mp4')) },
    transcriptReview: { ...review, trustworthy: true, unreliableWordIndexes: [] },
    framingReview: { ...review, safeFramingReviewed: true, layoutReviewed: true },
    edl: ranges.slice(0, 2).map((range) => ({
      range, startFrame: frames.find((frame) => frame.t === range.start)!, endFrame: frames.find((frame) => frame.t === range.end)!,
      reactionWindows: [], layoutChanges: range.id === 'sample' ? [{ t: 1, layout: 'single', frameId: 'f-000002' }] : [],
    })),
  };
  await writeFile(join(dir, 'clips/pilot-evidence.json'), JSON.stringify(evidence));
  return { dir, ranges, policy, input, evidence, shard };
}

describe('project-local editorial sample render gate', () => {
  test('approved synthetic sample releases mass renders without creating publication approval', async () => {
    const { dir, input } = await fixture();
    const before = await readFile(join(dir, 'clips/pilot-evidence.json'), 'utf8');
    await assertClipPilotReady(input);
    expect(await readFile(join(dir, 'clips/pilot-evidence.json'), 'utf8')).toBe(before);
    expect(JSON.parse(before)).not.toHaveProperty('publicationApproved');
    expect(await Bun.file(join(dir, 'creator/approval.json')).exists()).toBe(false);
  });

  test('absent/disabled policy remains a no-op even without provenance or evidence', async () => {
    const { dir, policy, input } = await fixture();
    await rm(join(dir, 'clips/pilot-policy.json'));
    await rm(join(dir, 'clips/pilot-evidence.json'));
    await rm(join(dir, 'clips/source.mp4'));
    await assertClipPilotReady(input);
    await writeFile(join(dir, 'clips/pilot-policy.json'), JSON.stringify({ ...policy, enabled: false }));
    await assertClipPilotReady(input);
  });

  test('only explicitly configured sample selection can render before evidence/artifact exists', async () => {
    const { dir, input, ranges } = await fixture();
    await rm(join(dir, 'clips/pilot-evidence.json'));
    await rm(join(dir, 'renders/clips/sample.mp4'));
    await assertClipPilotReady({ ...input, selectedRanges: [ranges[0]!] });
    await expect(assertClipPilotReady({ ...input, selectedRanges: [ranges[1]!] })).rejects.toThrow(/required project-local evidence/);
    await expect(assertClipPilotReady(input)).rejects.toThrow(/required project-local evidence/);
    await expect(assertClipPilotReady({ ...input, selectedRanges: [ranges[2]!] })).rejects.toThrow(/not sealed and approved/);
  });

  test('invalid policy, corrupt evidence and pending/rejected samples fail closed', async () => {
    const { dir, input, policy, evidence } = await fixture();
    for (const raw of ['{', JSON.stringify({ ...policy, enabled: 'false' }), JSON.stringify({ ...policy, maxCandidates: 100 })]) {
      await writeFile(join(dir, 'clips/pilot-policy.json'), raw);
      await expect(assertClipPilotReady(input)).rejects.toThrow(/Editorial clip pilot/);
    }
    await writeFile(join(dir, 'clips/pilot-policy.json'), JSON.stringify(policy));
    for (const raw of ['{', JSON.stringify({ ...evidence, approval: 'pending' }), JSON.stringify({ ...evidence, approval: 'rejected' }),
      JSON.stringify({ ...evidence, contentType: 'comedy' }), JSON.stringify({ ...evidence, publicationApproved: true })]) {
      await writeFile(join(dir, 'clips/pilot-evidence.json'), raw);
      await expect(assertClipPilotReady(input)).rejects.toThrow(/Editorial clip pilot/);
    }
  });

  for (const mutation of ['source', 'source-manifest', 'transcript', 'decisions', 'frames', 'analysis-metadata', 'sample'] as const) {
    test(`${mutation} mutation invalidates approved evidence`, async () => {
      const { dir, input, shard } = await fixture();
      if (mutation === 'source') await writeFile(join(dir, 'clips/source.mp4'), 'changed source');
      if (mutation === 'source-manifest') {
        await writeFile(join(dir, 'clips/source.json'), JSON.stringify({ schemaVersion: 1, sha256: input.decisions.sourceSha256, width: 999 }));
      }
      if (mutation === 'transcript') {
        input.words = input.words.map((word, index) => index === 0 ? { ...word, word: 'changed' } : word);
        await writeFile(join(dir, 'clips/transcript.json'), JSON.stringify({ schemaVersion: 1, language: 'es', words: input.words }));
      }
      if (mutation === 'decisions') {
        input.decisions = { ...input.decisions, backend: 'changed-editor' };
        await writeFile(join(dir, 'clips/decisions.json'), JSON.stringify(input.decisions));
      }
      if (mutation === 'frames') {
        input.frames = input.frames.map((frame, index) => index === 0 ? { ...frame, topic: 'changed' } : frame);
        await writeFile(join(dir, 'clips/analysis/shard-001.json'), JSON.stringify({ ...shard, frames: input.frames }));
      }
      if (mutation === 'analysis-metadata') await writeFile(join(dir, 'clips/analysis/shard-001.json'), JSON.stringify({ ...shard, status: 'uncertain' }));
      if (mutation === 'sample') await writeFile(join(dir, 'renders/clips/sample.mp4'), 'changed montage');
      await expect(assertClipPilotReady(input)).rejects.toThrow(/Editorial clip pilot/);
    });
  }

  test('review, words, current boundary frames, EDL camera changes and reactions are enforced', async () => {
    const { dir, input, evidence } = await fixture();
    const invalids = [
      { ...evidence, transcriptReview: { ...evidence.transcriptReview, trustworthy: false } },
      { ...evidence, transcriptReview: { ...evidence.transcriptReview, unreliableWordIndexes: [0] } },
      { ...evidence, transcriptReview: { ...evidence.transcriptReview, unreliableWordIndexes: [999] } },
      { ...evidence, framingReview: { ...evidence.framingReview, layoutReviewed: false } },
      { ...evidence, framingReview: { ...evidence.framingReview, safeFramingReviewed: false } },
      { ...evidence, edl: evidence.edl.slice(0, 1) },
      { ...evidence, edl: [{ ...evidence.edl[0]!, endFrame: input.frames[1] }, evidence.edl[1]] },
      { ...evidence, edl: evidence.edl.map((entry) => ({ ...entry, layoutChanges: [] })) },
      { ...evidence, edl: evidence.edl.map((entry) => ({ ...entry, reactionWindows: [{ start: entry.range.start, end: entry.range.end }] })) },
    ];
    for (const invalid of invalids) {
      await writeFile(join(dir, 'clips/pilot-evidence.json'), JSON.stringify(invalid));
      await expect(assertClipPilotReady(input)).rejects.toThrow(/Editorial clip pilot/);
    }
  });

  test('examples must retain sealed positive/negative identities', async () => {
    const { dir, input, evidence } = await fixture();
    await writeFile(join(dir, 'clips/pilot-evidence.json'), JSON.stringify({ ...evidence, examples: [
      evidence.examples[0], { ...evidence.examples[1]!, range: { ...evidence.examples[1]!.range, id: 'invented' } },
    ] }));
    await expect(assertClipPilotReady(input)).rejects.toThrow(/examples do not match/);
  });

  test('missing, traversing and symlink sample artifacts are forbidden', async () => {
    const { dir, input, evidence } = await fixture();
    await rm(join(dir, 'renders/clips/sample.mp4'));
    await expect(assertClipPilotReady(input)).rejects.toThrow(/required project-local evidence/);
    await writeFile(join(dir, 'clips/pilot-evidence.json'), JSON.stringify({ ...evidence, sample: { ...evidence.sample, path: '../secret.mp4' } }));
    await expect(assertClipPilotReady(input)).rejects.toThrow(/pilot evidence is invalid/);
    await writeFile(join(dir, 'clips/pilot-evidence.json'), JSON.stringify(evidence));
    await symlink(join(dir, 'clips/source.mp4'), join(dir, 'renders/clips/sample.mp4'));
    await expect(assertClipPilotReady(input)).rejects.toThrow(/symlink evidence paths/);
    await rm(join(dir, 'clips/pilot-evidence.json'));
    await expect(assertClipPilotReady({ ...input, selectedRanges: [input.selectedRanges[0]!] })).rejects.toThrow(/symlink evidence paths/);
  });

  test('symlink policy/analysis paths fail without exposing external content', async () => {
    const { dir, input, policy } = await fixture();
    const external = await mkdtemp(join(tmpdir(), 'vm-pilot-external-'));
    temporary.push(external);
    await writeFile(join(external, 'secret.json'), 'PRIVATE SENTINEL');
    await rm(join(dir, 'clips/pilot-policy.json'));
    await symlink(join(external, 'secret.json'), join(dir, 'clips/pilot-policy.json'));
    await expect(assertClipPilotReady(input)).rejects.toThrow(/symlink evidence paths/);
    try { await assertClipPilotReady(input); } catch (error) {
      expect((error as Error).message).not.toContain(external);
      expect((error as Error).message).not.toContain('PRIVATE SENTINEL');
    }
    await rm(join(dir, 'clips/pilot-policy.json'));
    await writeFile(join(dir, 'clips/pilot-policy.json'), JSON.stringify(policy));
    await rm(join(dir, 'clips/analysis/shard-001.json'));
    await symlink(join(external, 'secret.json'), join(dir, 'clips/analysis/shard-001.json'));
    await expect(assertClipPilotReady(input)).rejects.toThrow(/symlink evidence paths/);
    await rm(join(dir, 'clips/analysis'), { recursive: true });
    await symlink(external, join(dir, 'clips/analysis'));
    await expect(assertClipPilotReady(input)).rejects.toThrow(/unsafe analysis directory/);
  });
});
