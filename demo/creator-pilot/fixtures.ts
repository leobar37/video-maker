import type { ClipRange, FrameAnalysis } from '@videomaker/schemas';
import type { PilotClipQaInput } from '../../packages/cli/src/creator/pilot-qa';

export const range: ClipRange = {
  schemaVersion: 1, id: 'synthetic-sample', start: 0, end: 4, score: 0.5,
  breakdown: { highlight: 0.5, hook: 0.5, density: 0.5, emotion: 0.5, novelty: 0.5, closure: 0.5 },
  layout: 'duo', faces: [
    { id: 'speaker-a', bbox: [100, 200, 200, 400], presence: 1 },
    { id: 'speaker-b', bbox: [650, 200, 200, 400], presence: 1 },
  ], social: { title: 'Synthetic demonstration', description: 'Offline shapes, not real ASR review or viral calibration.', hashtags: [] },
};
export const frames: FrameAnalysis[] = [0, 1, 2, 3, 4].map((t, index) => ({
  schemaVersion: 1, frame_id: `f-${String(index).padStart(6, '0')}`, t,
  speakers: range.faces.map((face) => ({ id: face.id, bbox: face.bbox, speaking: face.id === 'speaker-a' })),
  sceneCut: t === 2, energy: 0.5, highlight: 0.5, topic: 'synthetic',
}));
export const baseline: PilotClipQaInput = {
  range, frames, words: [
    { word: 'Synthetic', start: 0, end: 1 },
    { word: 'premise', start: 1, end: 2 },
    { word: 'and', start: 2, end: 3 },
    { word: 'payoff', start: 3, end: 4 },
  ], transcriptReviewed: true, safeFramingReviewed: true,
  reactionWindows: [{ start: 2, end: 4 }],
  layoutChanges: [{ t: 2, layout: 'duo', frameId: 'f-000002' }],
};
export const examples: { label: string; expectedOk: boolean; input: PilotClipQaInput }[] = [
  { label: 'positive-word-edges-duo-reaction-camera', expectedOk: true, input: baseline },
  { label: 'negative-word-edge-cut', expectedOk: false, input: { ...baseline, range: { ...range, start: 0.5 } } },
  { label: 'negative-truncated-reaction', expectedOk: false, input: { ...baseline, reactionWindows: [{ start: 2, end: 5 }] } },
  { label: 'negative-camera-frame-mismatch', expectedOk: false, input: { ...baseline, layoutChanges: [{ t: 2, layout: 'duo', frameId: 'f-000001' }] } },
  { label: 'negative-listener-lost-at-switch', expectedOk: false, input: { ...baseline, frames: frames.map((frame) => frame.t === 2 ? { ...frame, speakers: frame.speakers.slice(0, 1) } : frame) } },
  { label: 'negative-unsafe-crop', expectedOk: false, input: { ...baseline, safeFramingReviewed: false } },
  { label: 'negative-missing-transcript', expectedOk: false, input: { ...baseline, words: [] } },
  { label: 'negative-disputed-transcript', expectedOk: false, input: { ...baseline, unreliableWordIndexes: [2] } },
];

export const recipe = {
  label: 'SYNTHETIC OFFLINE DEMONSTRATION — not human ASR proof, calibration, virality or publication approval',
  contentType: 'educational', maxCandidates: 8,
  budget: { currency: 'USD', maxSpend: 0, paidCallsAuthorized: false },
  cacheRecipe: { mode: 'offline-fixture-only', providerCacheGenerated: false, paidCacheReuseAuthorized: false },
  privateSource: 'private/source.mp4', transcript: baseline.words,
  edl: { range, startFrame: frames[0], endFrame: frames[4], reactionWindows: baseline.reactionWindows, layoutChanges: baseline.layoutChanges },
  inspect: ['sample.mp4', 'still.png', 'evidence.json', 'qa-results.json'],
  generation: 'bun demo/creator-pilot/generate.ts (local ffmpeg lavfi only)',
};
