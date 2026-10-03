import { describe, expect, test } from 'bun:test';

import {
  ClipPilotEvidenceSchema, ClipPilotPolicySchema, SCHEMA_VERSIONS,
  type ClipPilotEvidence, type ClipPilotPolicy, type ClipRange, type FrameAnalysis,
} from './index';

const hash = 'a'.repeat(64);
const review = { reviewer: 'Synthetic offline reviewer', reviewedAt: '2026-01-01T00:00:00.000Z' };
const range: ClipRange = {
  schemaVersion: 1, id: 'sample', start: 0, end: 2, score: 0.8,
  breakdown: { highlight: 0.8, hook: 0.8, novelty: 0.8, emotion: 0.8, density: 0.8, closure: 0.8 },
  layout: 'single', faces: [{ id: 'speaker-a', bbox: [100, 100, 250, 250], presence: 1 }],
  social: { title: 'Synthetic premise', description: 'Offline fixture, not real review.', hashtags: ['test'] },
};
const frame: FrameAnalysis = {
  schemaVersion: 1, frame_id: 'f-000001', t: 0,
  speakers: [{ id: 'speaker-a', bbox: [100, 100, 250, 250], speaking: true }],
  sceneCut: false, energy: 0.5, topic: 'synthetic', highlight: 0.5,
};
const criteria = {
  premisa: { passes: true, note: 'Premise retained in synthetic input.' },
  autonomia: { passes: true, note: 'Self-contained synthetic input.' },
  remate: { passes: true, note: 'Ending retained in synthetic input.' },
  fidelidad: { passes: true, note: 'Faithful to synthetic input.' },
};
function evidence(): ClipPilotEvidence {
  return {
    schemaVersion: 1, approval: 'approved', ...review, contentType: 'educational',
    provenance: { sourceSha256: hash, sourceManifestSha256: hash, transcriptSha256: hash, decisionsSha256: hash, framesSha256: hash, analysisSha256: hash },
    examples: [
      { kind: 'positive', range, ...review, criteria },
      { kind: 'negative', range: { ...range, id: 'negative' }, ...review,
        criteria: { ...criteria, remate: { passes: false, note: 'Missing synthetic ending.' } } },
    ],
    sample: { rangeId: 'sample', path: 'renders/clips/sample.mp4', sha256: hash },
    transcriptReview: { ...review, trustworthy: true, unreliableWordIndexes: [] },
    framingReview: { ...review, safeFramingReviewed: true, layoutReviewed: true },
    edl: [{ range, startFrame: frame, endFrame: { ...frame, frame_id: 'f-000002', t: 2 }, reactionWindows: [], layoutChanges: [] }],
  };
}
const policy: ClipPilotPolicy = { schemaVersion: 1, enabled: true, sampleIds: ['sample'], contentType: 'educational', maxCandidates: 5 };

describe('strict versioned editorial pilot contracts', () => {
  test('exports public contracts and accepts explicit positive/negative reviewed examples', () => {
    expect(ClipPilotPolicySchema.parse(policy)).toEqual(policy);
    expect(ClipPilotEvidenceSchema.parse(evidence())).toEqual(evidence());
    expect(SCHEMA_VERSIONS.clipPilotPolicy).toBe(1);
    expect(SCHEMA_VERSIONS.clipPilotEvidence).toBe(1);
  });

  test('requires versions, named dated reviews, four criteria and both example kinds', () => {
    const valid = evidence();
    for (const invalid of [
      { ...valid, schemaVersion: 2 }, { ...valid, schemaVersion: undefined },
      { ...valid, reviewer: ' ' }, { ...valid, reviewedAt: 'not-a-date' },
      { ...valid, examples: [valid.examples[0], valid.examples[0]] },
      { ...valid, examples: [valid.examples[1], valid.examples[1]] },
      { ...valid, examples: [{ ...valid.examples[0], criteria: { premisa: criteria.premisa } }, valid.examples[1]] },
      { ...valid, examples: [{ ...valid.examples[0], reviewer: '' }, valid.examples[1]] },
    ]) expect(ClipPilotEvidenceSchema.safeParse(invalid).success).toBe(false);
  });

  test('requires positive examples to pass and negative examples to demonstrate a failure', () => {
    const valid = evidence();
    expect(ClipPilotEvidenceSchema.safeParse({ ...valid, examples: [
      { ...valid.examples[0], criteria: { ...criteria, fidelidad: { passes: false, note: 'Changed meaning.' } } }, valid.examples[1],
    ] }).success).toBe(false);
    expect(ClipPilotEvidenceSchema.safeParse({ ...valid, examples: [valid.examples[0], { ...valid.examples[1], criteria }] }).success).toBe(false);
  });

  test('rejects unknown publication approvals and malformed provenance/EDL', () => {
    const valid = evidence();
    for (const invalid of [
      { ...valid, publicationApproved: true },
      { ...valid, sample: { ...valid.sample, publishApproved: true } },
      { ...valid, provenance: { ...valid.provenance, sourceSha256: 'bad' } },
      { ...valid, edl: [{ ...valid.edl[0], startFrame: { ...frame, unknown: true } }] },
      { ...valid, edl: [valid.edl[0], valid.edl[0]] },
      { ...valid, transcriptReview: { ...valid.transcriptReview, unreliableWordIndexes: [-1] } },
    ]) expect(ClipPilotEvidenceSchema.safeParse(invalid).success).toBe(false);
  });

  test('permits pending/rejected editorial evidence, never unsafe sample paths', () => {
    for (const approval of ['pending', 'rejected'] as const) {
      expect(ClipPilotEvidenceSchema.safeParse({ ...evidence(), approval }).success).toBe(true);
    }
    for (const path of ['../secret.mp4', '/tmp/sample.mp4', 'renders/clips/../sample.mp4', 'renders\\clips\\sample.mp4', 'renders/clips/other.mp4']) {
      expect(ClipPilotEvidenceSchema.safeParse({ ...evidence(), sample: { ...evidence().sample, path } }).success).toBe(false);
    }
  });

  test('policy has bounded offline recipe and strict ids/content type even when disabled', () => {
    for (const invalid of [
      { ...policy, schemaVersion: 2 }, { ...policy, sampleIds: [] },
      { ...policy, sampleIds: ['sample', 'sample'] }, { ...policy, sampleIds: ['../sample'] },
      { ...policy, maxCandidates: 4 }, { ...policy, maxCandidates: 11 },
      { ...policy, contentType: 'viral' }, { ...policy, enabled: false, approval: true },
    ]) expect(ClipPilotPolicySchema.safeParse(invalid).success).toBe(false);
  });
});
