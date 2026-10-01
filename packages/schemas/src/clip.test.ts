import { describe, expect, test } from 'bun:test';

import {
  ClipBreakdownSchema,
  ClipDecisionEntrySchema,
  ClipDecisionSchema,
  ClipFaceSchema,
  ClipLayoutSchema,
  ClipRangeSchema,
  ClipSocialSchema,
  ClipStatusSchema,
  FRAME_ID_PATTERN,
  FrameAnalysisSchema,
  SCORING_PRESETS,
  SCORING_SIGNALS,
  ScoringPresetSchema,
  ScoringWeightsSchema,
  type ClipDecision,
  type ClipDecisionEntry,
  type ClipFace,
  type ClipRange,
  type FrameAnalysis,
  type ScoringWeights,
  scoringWeightsFor,
} from './clip';

const frameFixture: FrameAnalysis = {
  schemaVersion: 1,
  frame_id: 'f-000042',
  t: 83.4,
  speakers: [
    { id: 'speaker-a', bbox: [120, 200, 300, 300], speaking: true },
    { id: 'speaker-b', bbox: [600, 180, 280, 320], speaking: false },
  ],
  sceneCut: false,
  energy: 0.7,
  topic: 'hook about editing',
  highlight: 0.85,
  note: 'strong opening gesture',
};

const weightsFixture: ScoringWeights = {
  schemaVersion: 1,
  preset: 'viral',
  weights: SCORING_PRESETS.viral,
};

function roundTrip<T>(schema: { parse: (raw: unknown) => T }, value: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

function withFrame(patch: Record<string, unknown>): unknown {
  return { ...frameFixture, ...patch };
}

const faceFixture: ClipFace = {
  id: 'speaker-a',
  bbox: [120, 200, 300, 300],
  presence: 0.8,
};

const rangeFixture: ClipRange = {
  schemaVersion: 1,
  id: 'hook-about-editing',
  start: 12.5,
  end: 38.2,
  score: 0.82,
  breakdown: {
    highlight: 0.85,
    hook: 0.9,
    density: 0.4,
    emotion: 0.5,
    novelty: 0.4,
    closure: 0.3,
  },
  layout: 'duo',
  faces: [
    faceFixture,
    { id: 'speaker-b', bbox: [600, 180, 280, 320], presence: 0.65 },
  ],
  social: {
    title: 'Editing hooks that stop the scroll',
    description: 'A 25-second clip about crafting strong openings.',
    hashtags: ['editing', 'hooks'],
  },
};

const soloRangeFixture: ClipRange = {
  ...rangeFixture,
  id: 'one-take-tip',
  layout: 'single',
};

const approvedEntryFixture: ClipDecisionEntry = {
  range: rangeFixture,
  status: 'approved',
  note: 'keep the duo split',
};

const rejectedEntryFixture: ClipDecisionEntry = {
  range: soloRangeFixture,
  status: 'rejected',
};

const decisionFixture: ClipDecision = {
  schemaVersion: 1,
  sourceSha256: 'a'.repeat(64),
  backend: 'read-only-dashboard',
  decisions: [approvedEntryFixture, rejectedEntryFixture],
};

function withRange(patch: Record<string, unknown>): unknown {
  return { ...rangeFixture, ...patch };
}

function withDecision(patch: Record<string, unknown>): unknown {
  return { ...decisionFixture, ...patch };
}

describe('FrameAnalysisSchema', () => {
  test('round-trips a full frame analysis', () => {
    const parsed = roundTrip(FrameAnalysisSchema, frameFixture);
    expect(parsed).toEqual(frameFixture);
  });

  test('defaults schemaVersion to 1 when omitted', () => {
    const { schemaVersion: _omitted, ...legacy } = frameFixture;
    const parsed = FrameAnalysisSchema.parse(legacy);
    expect(parsed.schemaVersion).toBe(1);
  });

  test('accepts a frame with no detected speakers', () => {
    const parsed = FrameAnalysisSchema.parse(withFrame({ speakers: [] }));
    expect(parsed.speakers).toEqual([]);
  });

  test('canonical frame ids match f-<6 digits> and nothing else', () => {
    expect(FRAME_ID_PATTERN.test('f-000001')).toBe(true);
    expect(FRAME_ID_PATTERN.test('f-00001')).toBe(false);
    expect(FRAME_ID_PATTERN.test('f-0000001')).toBe(false);
    expect(FRAME_ID_PATTERN.test('F-000001')).toBe(false);
    expect(FRAME_ID_PATTERN.test('000001')).toBe(false);
  });

  test('rejects a malformed frame_id', () => {
    expect(FrameAnalysisSchema.safeParse(withFrame({ frame_id: 'f-42' })).success).toBe(false);
    expect(FrameAnalysisSchema.safeParse(withFrame({ frame_id: 'frame-000042' })).success).toBe(
      false,
    );
  });

  test('rejects out-of-range scalars', () => {
    expect(FrameAnalysisSchema.safeParse(withFrame({ t: -0.1 })).success).toBe(false);
    expect(FrameAnalysisSchema.safeParse(withFrame({ energy: 1.2 })).success).toBe(false);
    expect(FrameAnalysisSchema.safeParse(withFrame({ energy: -0.01 })).success).toBe(false);
    expect(FrameAnalysisSchema.safeParse(withFrame({ highlight: 2 })).success).toBe(false);
    expect(FrameAnalysisSchema.safeParse(withFrame({ energy: Number.NaN })).success).toBe(false);
    expect(FrameAnalysisSchema.safeParse(withFrame({ t: Infinity })).success).toBe(false);
  });

  test('rejects wrong types and empty strings', () => {
    expect(FrameAnalysisSchema.safeParse(withFrame({ sceneCut: 'yes' })).success).toBe(false);
    expect(FrameAnalysisSchema.safeParse(withFrame({ topic: '' })).success).toBe(false);
    expect(FrameAnalysisSchema.safeParse(withFrame({ note: 7 })).success).toBe(false);
    expect(FrameAnalysisSchema.safeParse(withFrame({ t: '83.4' })).success).toBe(false);
  });

  test('rejects missing required fields', () => {
    for (const key of ['frame_id', 't', 'speakers', 'sceneCut', 'energy', 'topic', 'highlight']) {
      const { [key]: _dropped, ...rest } = frameFixture as Record<string, unknown>;
      expect(FrameAnalysisSchema.safeParse(rest).success).toBe(false);
    }
  });

  test('rejects unknown keys (strict: model garbage is never coerced)', () => {
    expect(FrameAnalysisSchema.safeParse(withFrame({ invented: true })).success).toBe(false);
  });

  test('rejects malformed speakers', () => {
    const bad = (speakers: unknown) => FrameAnalysisSchema.safeParse(withFrame({ speakers }));
    expect(bad([{ id: 'speaker-a', bbox: [1, 2, 3], speaking: true }]).success).toBe(false);
    expect(bad([{ id: 'speaker-a', bbox: [1, 2, 3, 4, 5], speaking: true }]).success).toBe(false);
    expect(bad([{ id: 'speaker-a', bbox: [-1, 2, 30, 40], speaking: true }]).success).toBe(false);
    expect(bad([{ id: 'speaker-a', bbox: [1, 2, 1001, 40], speaking: true }]).success).toBe(false);
    expect(bad([{ id: 'speaker-a', bbox: [1, 2, 0, 40], speaking: true }]).success).toBe(false);
    expect(bad([{ id: 'speaker-a', bbox: [1, 2, 30, -5], speaking: true }]).success).toBe(false);
    expect(bad([{ id: '', bbox: [1, 2, 30, 40], speaking: true }]).success).toBe(false);
    expect(bad([{ id: 'speaker-a', bbox: [1, 2, 30, 40], speaking: 'yes' }]).success).toBe(false);
    expect(bad([{ id: 'speaker-a', bbox: [1, 2, 30, 40] }]).success).toBe(false);
  });
});

describe('ScoringWeightsSchema', () => {
  test('round-trips a weights document', () => {
    const parsed = roundTrip(ScoringWeightsSchema, weightsFixture);
    expect(parsed).toEqual(weightsFixture);
  });

  test('defaults schemaVersion to 1 and allows a weights-only document', () => {
    const parsed = ScoringWeightsSchema.parse({ weights: SCORING_PRESETS.podcast });
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.preset).toBeUndefined();
  });

  test('every preset covers all six signals and parses', () => {
    for (const preset of ScoringPresetSchema.options) {
      expect(Object.keys(SCORING_PRESETS[preset]).sort()).toEqual([...SCORING_SIGNALS].sort());
      expect(ScoringWeightsSchema.safeParse(scoringWeightsFor(preset)).success).toBe(true);
    }
    expect(scoringWeightsFor('educational').preset).toBe('educational');
  });

  test('rejects invalid presets and versions', () => {
    expect(ScoringWeightsSchema.safeParse({ ...weightsFixture, preset: 'meme' }).success).toBe(
      false,
    );
    expect(ScoringWeightsSchema.safeParse({ ...weightsFixture, schemaVersion: 2 }).success).toBe(
      false,
    );
  });

  test('rejects malformed weights (strict)', () => {
    const weights = SCORING_PRESETS.viral as Record<string, number>;
    expect(
      ScoringWeightsSchema.safeParse({ weights: { ...weights, hook: -0.1 } }).success,
    ).toBe(false);
    expect(
      ScoringWeightsSchema.safeParse({ weights: { ...weights, highlight: '1' } }).success,
    ).toBe(false);
    const { closure: _dropped, ...incomplete } = weights;
    expect(ScoringWeightsSchema.safeParse({ weights: incomplete }).success).toBe(false);
    expect(
      ScoringWeightsSchema.safeParse({
        weights: { ...weights, highlight: 0, hook: 0, density: 0, emotion: 0, novelty: 0, closure: 0 },
      }).success,
    ).toBe(false);
    expect(
      ScoringWeightsSchema.safeParse({ weights: { ...weights, extra: 1 } }).success,
    ).toBe(false);
    expect(ScoringWeightsSchema.safeParse({ weights, extra: true }).success).toBe(false);
    expect(ScoringWeightsSchema.safeParse({}).success).toBe(false);
  });
});

describe('ClipRangeSchema', () => {
  test('round-trips a full duo range', () => {
    const parsed = roundTrip(ClipRangeSchema, rangeFixture);
    expect(parsed).toEqual(rangeFixture);
  });

  test('defaults schemaVersion to 1 when omitted', () => {
    const { schemaVersion: _omitted, ...legacy } = rangeFixture;
    const parsed = ClipRangeSchema.parse(legacy);
    expect(parsed.schemaVersion).toBe(1);
  });

  test('accepts a fallback single range with two detected faces', () => {
    expect(ClipRangeSchema.safeParse(soloRangeFixture).success).toBe(true);
    expect(ClipRangeSchema.safeParse(withRange({ layout: 'single', faces: [] })).success).toBe(true);
    expect(ClipRangeSchema.safeParse(withRange({ layout: 'single', faces: [faceFixture] })).success).toBe(
      true,
    );
  });

  test('validates layout and status enums', () => {
    expect(ClipLayoutSchema.safeParse('single').success).toBe(true);
    expect(ClipLayoutSchema.safeParse('duo').success).toBe(true);
    expect(ClipLayoutSchema.safeParse('trio').success).toBe(false);
    expect(ClipStatusSchema.safeParse('candidate').success).toBe(true);
    expect(ClipStatusSchema.safeParse('approved').success).toBe(true);
    expect(ClipStatusSchema.safeParse('rejected').success).toBe(true);
    expect(ClipStatusSchema.safeParse('maybe').success).toBe(false);
  });

  test('round-trips a range carrying its review journal', () => {
    const withRevisions = {
      ...rangeFixture,
      revisions: [{ round: 1, verdict: 'revise' as const, issues: ['weak hook'], applied: true }],
    };
    expect(roundTrip(ClipRangeSchema, withRevisions)).toEqual(withRevisions);
    expect(
      ClipRangeSchema.safeParse({
        ...rangeFixture,
        revisions: [{ round: 0, verdict: 'pass', issues: [], applied: true }],
      }).success,
    ).toBe(false);
    expect(
      ClipRangeSchema.safeParse({
        ...rangeFixture,
        revisions: [{ round: 1, verdict: 'x', issues: [], applied: true }],
      }).success,
    ).toBe(false);
  });

  test('rejects score outside 0–1', () => {
    expect(ClipRangeSchema.safeParse(withRange({ score: 1.5 })).success).toBe(false);
    expect(ClipRangeSchema.safeParse(withRange({ score: -0.1 })).success).toBe(false);
  });

  test('rejects end <= start', () => {
    expect(ClipRangeSchema.safeParse(withRange({ end: 12.5 })).success).toBe(false);
    expect(ClipRangeSchema.safeParse(withRange({ end: 12.4 })).success).toBe(false);
    expect(ClipRangeSchema.safeParse(withRange({ start: 38.2, end: 38.2 })).success).toBe(false);
  });

  test("rejects duo layout without exactly 2 faces", () => {
    expect(ClipRangeSchema.safeParse(withRange({ faces: [faceFixture] })).success).toBe(false);
    expect(ClipRangeSchema.safeParse(withRange({ faces: [] })).success).toBe(false);
    expect(
      ClipRangeSchema.safeParse(withRange({ faces: [faceFixture, faceFixture, faceFixture] }))
        .success,
    ).toBe(false);
  });

  test('rejects invalid layouts', () => {
    for (const layout of ['trio', 'SINGLE', 'solo', '', 1, null]) {
      expect(ClipRangeSchema.safeParse(withRange({ layout })).success).toBe(false);
    }
  });

  test('rejects incomplete or over-range breakdown', () => {
    const { closure: _dropped, ...incomplete } = rangeFixture.breakdown;
    const bad = (breakdown: unknown) => ClipRangeSchema.safeParse(withRange({ breakdown })).success;
    expect(bad(incomplete)).toBe(false);
    expect(bad({ ...rangeFixture.breakdown, hook: 1.2 })).toBe(false);
    expect(bad({ ...rangeFixture.breakdown, novelty: -0.01 })).toBe(false);
    expect(bad({ ...rangeFixture.breakdown, extra: 0.5 })).toBe(false);
  });

  test('rejects presence outside 0–1 and malformed faces', () => {
    const badFace = (face: unknown) =>
      ClipRangeSchema.safeParse(withRange({ faces: [face] })).success;
    expect(badFace({ ...faceFixture, presence: 1.2 })).toBe(false);
    expect(badFace({ ...faceFixture, presence: -0.1 })).toBe(false);
    expect(badFace({ ...faceFixture, presence: Number.NaN })).toBe(false);
    expect(badFace({ ...faceFixture, bbox: [1, 2, 0, 40] })).toBe(false);
    expect(badFace({ id: '', bbox: [1, 2, 30, 40], presence: 0.5 })).toBe(false);
  });

  test('rejects unknown keys (strict: model garbage is never coerced)', () => {
    expect(ClipRangeSchema.safeParse(withRange({ invented: true })).success).toBe(false);
    expect(ClipFaceSchema.safeParse({ ...faceFixture, invented: true }).success).toBe(false);
    expect(ClipSocialSchema.safeParse({ ...rangeFixture.social, invented: true }).success).toBe(
      false,
    );
    expect(ClipBreakdownSchema.safeParse({ ...rangeFixture.breakdown, invented: 1 }).success).toBe(
      false,
    );
  });

  test('rejects malformed ids, empty strings and wrong types', () => {
    expect(ClipRangeSchema.safeParse(withRange({ id: 'Hook-About' })).success).toBe(false);
    expect(ClipRangeSchema.safeParse(withRange({ id: '-leading' })).success).toBe(false);
    expect(ClipRangeSchema.safeParse(withRange({ id: 'has_underscore' })).success).toBe(false);
    expect(ClipRangeSchema.safeParse(withRange({ id: '' })).success).toBe(false);
    expect(ClipRangeSchema.safeParse(withRange({ start: '12.5' })).success).toBe(false);
    expect(
      ClipRangeSchema.safeParse(withRange({ social: { ...rangeFixture.social, title: '' } }))
        .success,
    ).toBe(false);
    expect(
      ClipRangeSchema.safeParse(withRange({ social: { ...rangeFixture.social, hashtags: [''] } }))
        .success,
    ).toBe(false);
  });
});

describe('ClipDecisionSchema', () => {
  test('round-trips a full decision document', () => {
    const parsed = roundTrip(ClipDecisionSchema, decisionFixture);
    expect(parsed).toEqual(decisionFixture);
  });

  test('defaults schemaVersion to 1 when omitted', () => {
    const { schemaVersion: _omitted, ...legacy } = decisionFixture;
    const parsed = ClipDecisionSchema.parse(legacy);
    expect(parsed.schemaVersion).toBe(1);
  });

  test('accepts an empty decisions list', () => {
    expect(ClipDecisionSchema.safeParse(withDecision({ decisions: [] })).success).toBe(true);
  });

  test('rejects a decision without sourceSha256', () => {
    const { sourceSha256: _dropped, ...legacy } = decisionFixture;
    expect(ClipDecisionSchema.safeParse(legacy).success).toBe(false);
  });

  test('rejects a malformed sha256', () => {
    const bad = (sourceSha256: unknown) =>
      ClipDecisionSchema.safeParse(withDecision({ sourceSha256 })).success;
    expect(bad('A'.repeat(64))).toBe(false);
    expect(bad('a'.repeat(63))).toBe(false);
    expect(bad('a'.repeat(65))).toBe(false);
    expect(bad('z'.repeat(64))).toBe(false);
    expect(bad('a1b2c3')).toBe(false);
    expect(bad(42)).toBe(false);
  });

  test('rejects invalid entry statuses', () => {
    const bad = (status: unknown) =>
      ClipDecisionSchema.safeParse(withDecision({ decisions: [{ ...approvedEntryFixture, status }] }))
        .success;
    expect(bad('candidate')).toBe(false);
    expect(bad('maybe')).toBe(false);
    expect(bad('APPROVED')).toBe(false);
    expect(bad(1)).toBe(false);
  });

  test('rejects duplicate range ids', () => {
    const duplicated = withDecision({
      decisions: [approvedEntryFixture, { ...rejectedEntryFixture, range: rangeFixture }],
    });
    expect(ClipDecisionSchema.safeParse(duplicated).success).toBe(false);
  });

  test('rejects unknown keys (strict: model garbage is never coerced)', () => {
    expect(ClipDecisionSchema.safeParse(withDecision({ invented: true })).success).toBe(false);
    expect(ClipDecisionEntrySchema.safeParse({ ...approvedEntryFixture, invented: true }).success).toBe(
      false,
    );
    expect(
      ClipDecisionSchema.safeParse(
        withDecision({ decisions: [{ ...approvedEntryFixture, invented: true }] }),
      ).success,
    ).toBe(false);
  });

  test('rejects missing backend and malformed nested ranges', () => {
    expect(ClipDecisionSchema.safeParse(withDecision({ backend: '' })).success).toBe(false);
    const { backend: _dropped, ...legacy } = decisionFixture;
    expect(ClipDecisionSchema.safeParse(legacy).success).toBe(false);
    expect(
      ClipDecisionSchema.safeParse(
        withDecision({
          decisions: [{ range: withRange({ score: 2 }), status: 'approved' }],
        }),
      ).success,
    ).toBe(false);
  });
});
