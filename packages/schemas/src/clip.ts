/**
 * Clip analysis contracts: the per-frame vision output of an analysis shard is
 * validated against `FrameAnalysis`, the adjustable scoring function is
 * configured through `ScoringWeights` (six normalized signals + presets), and
 * the candidate windows plus their human decisions are captured by
 * `ClipRange` / `ClipDecision`. All documents carry `schemaVersion: 1`.
 *
 * Validation is strict on purpose: garbage coming back from a model is
 * rejected, never coerced. Unknown keys, wrong types and out-of-range values
 * all fail parsing.
 */
import { z } from 'zod';

import { SLUG_PATTERN, Sha256Schema } from './primitives';

// ---------------------------------------------------------------------------
// FrameAnalysis — one canonical frame of a vision shard
// ---------------------------------------------------------------------------

/** Canonical frame id: `f-<6 digits>` (`f-000001`). */
export const FRAME_ID_PATTERN = /^f-\d{6}$/;

/** Face bbox components live in normalized 0–1000 coordinates. */
export const BBOX_COORD_MIN = 0;
export const BBOX_COORD_MAX = 1000;

const BboxComponentSchema = z.number().min(BBOX_COORD_MIN).max(BBOX_COORD_MAX);

/** Normalized face box `[x, y, w, h]` in 0–1000 coordinates. */
export const BBoxSchema = z
  .tuple([
    BboxComponentSchema,
    BboxComponentSchema,
    BboxComponentSchema,
    BboxComponentSchema,
  ])
  .refine(([, , width, height]) => width > 0 && height > 0, {
    message: 'bbox width and height must be positive.',
  });
export type BBox = z.infer<typeof BBoxSchema>;

/** A detected speaker/face at one frame. */
export const FrameSpeakerSchema = z.strictObject({
  /** Stable speaker id within one shard (`speaker-a`, `speaker-b`, …). */
  id: z.string().min(1),
  bbox: BBoxSchema,
  speaking: z.boolean(),
});
export type FrameSpeaker = z.infer<typeof FrameSpeakerSchema>;

/**
 * Per-frame vision contract (`clips/analysis/shard-*.json` entries). `frame_id`
 * is the canonical addressing key; `t` is the human/ffmpeg clock in seconds
 * from the start of the source, shared with the transcript.
 */
export const FrameAnalysisSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  frame_id: z.string().regex(FRAME_ID_PATTERN, 'frame_id must match f-<6 digits>.'),
  /** Seconds from the start of the source. */
  t: z.number().min(0),
  speakers: z.array(FrameSpeakerSchema),
  sceneCut: z.boolean(),
  /** Energy of the moment, normalized 0–1. */
  energy: z.number().min(0).max(1),
  topic: z.string().min(1),
  /** Vision highlight score, normalized 0–1. */
  highlight: z.number().min(0).max(1),
  note: z.string().optional(),
});
export type FrameAnalysis = z.infer<typeof FrameAnalysisSchema>;

// ---------------------------------------------------------------------------
// ScoringWeights — adjustable, never a black box
// ---------------------------------------------------------------------------

/** The six normalized signals a candidate window sums (weights × signal). */
export const SCORING_SIGNALS = [
  'highlight',
  'hook',
  'density',
  'emotion',
  'novelty',
  'closure',
] as const;
export type ScoringSignal = (typeof SCORING_SIGNALS)[number];

export const ScoringPresetSchema = z.enum(['viral', 'podcast', 'educational']);
export type ScoringPreset = z.infer<typeof ScoringPresetSchema>;

/** One weight per scoring signal; all six are mandatory. */
export const ScoringWeightValuesSchema = z
  .strictObject({
    highlight: z.number().min(0),
    hook: z.number().min(0),
    density: z.number().min(0),
    emotion: z.number().min(0),
    novelty: z.number().min(0),
    closure: z.number().min(0),
  })
  .refine((weights) => SCORING_SIGNALS.some((signal) => weights[signal] > 0), {
    message: 'At least one scoring weight must be greater than zero.',
  });
export type ScoringWeightValues = z.infer<typeof ScoringWeightValuesSchema>;

/**
 * `clips/scoring.json` document: explicit weights plus the preset they were
 * derived from (if any). Presets only change weights, never the signals.
 */
export const ScoringWeightsSchema = z.strictObject({
  schemaVersion: z.literal(1).default(1),
  preset: ScoringPresetSchema.optional(),
  weights: ScoringWeightValuesSchema,
});
export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;

/** Preset weights: `viral` favors highlight+hook, `podcast` density+emotion,
 * `educational` novelty+closure. */
export const SCORING_PRESETS: Record<ScoringPreset, ScoringWeightValues> = {
  viral: {
    highlight: 1,
    hook: 0.9,
    density: 0.4,
    emotion: 0.5,
    novelty: 0.4,
    closure: 0.3,
  },
  podcast: {
    highlight: 0.4,
    hook: 0.3,
    density: 0.9,
    emotion: 0.9,
    novelty: 0.3,
    closure: 0.5,
  },
  educational: {
    highlight: 0.3,
    hook: 0.4,
    density: 0.5,
    emotion: 0.3,
    novelty: 0.9,
    closure: 0.9,
  },
};

/** Build a full `ScoringWeights` document from a preset (e.g. `--init-weights`). */
export function scoringWeightsFor(preset: ScoringPreset): ScoringWeights {
  return ScoringWeightsSchema.parse({
    schemaVersion: 1,
    preset,
    weights: SCORING_PRESETS[preset],
  });
}

// ---------------------------------------------------------------------------
// ClipRange / ClipDecision — candidate windows and their human decisions
// ---------------------------------------------------------------------------

/** Cropping layout of a candidate range: one face or a two-face split. */
export const ClipLayoutSchema = z.enum(['single', 'duo']);
export type ClipLayout = z.infer<typeof ClipLayoutSchema>;

/** Lifecycle of a range in the read-only dashboard. */
export const ClipStatusSchema = z.enum(['candidate', 'approved', 'rejected']);
export type ClipStatus = z.infer<typeof ClipStatusSchema>;

/**
 * Representative face of a candidate range: one bbox in normalized 0–1000
 * coordinates plus the fraction of range frames where the face is visible.
 */
export const ClipFaceSchema = z.strictObject({
  /** Stable face id within one source video (`speaker-a`, `speaker-b`, …). */
  id: z.string().min(1),
  bbox: BBoxSchema,
  /** Fraction of range frames where the face is visible (0–1). */
  presence: z.number().min(0).max(1),
});
export type ClipFace = z.infer<typeof ClipFaceSchema>;

/** Social copy drafted for a candidate range. */
export const ClipSocialSchema = z.strictObject({
  title: z.string().min(1),
  description: z.string().min(1),
  hashtags: z.array(z.string().min(1)),
});
export type ClipSocial = z.infer<typeof ClipSocialSchema>;

/** Normalized per-signal values behind `ClipRange.score` (each 0–1). */
export const ClipBreakdownSchema = z.strictObject({
  highlight: z.number().min(0).max(1),
  hook: z.number().min(0).max(1),
  density: z.number().min(0).max(1),
  emotion: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  closure: z.number().min(0).max(1),
});
export type ClipBreakdown = z.infer<typeof ClipBreakdownSchema>;

/** One agent self-review round journaled on a candidate (`clip-ranges --review`). */
export const ClipRevisionSchema = z.strictObject({
  round: z.number().int().min(1),
  verdict: z.enum(['pass', 'revise']),
  issues: z.array(z.string().min(1)),
  /** True when the round's feedback landed (patch applied, discard, or a pass). */
  applied: z.boolean(),
});
export type ClipRevision = z.infer<typeof ClipRevisionSchema>;

/**
 * A candidate clip window cut from one source video (`clips/ranges.json`
 * entries): time bounds in seconds from the start of the source, the score
 * and its per-signal breakdown, the crop layout, representative faces and the
 * drafted social copy.
 */
export const ClipRangeSchema = z
  .strictObject({
    schemaVersion: z.literal(1).default(1),
    /** Lowercase slug, stable within one source video. */
    id: z.string().regex(SLUG_PATTERN, 'id must be a lowercase slug.'),
    /** Range start in seconds from the start of the source. */
    start: z.number().min(0),
    /** Range end in seconds from the start of the source. */
    end: z.number().min(0),
    /** Final score, normalized 0–1. */
    score: z.number().min(0).max(1),
    breakdown: ClipBreakdownSchema,
    layout: ClipLayoutSchema,
    faces: z.array(ClipFaceSchema),
    social: ClipSocialSchema,
    /** Agent self-review journal (`clip-ranges --review`); absent otherwise. */
    revisions: z.array(ClipRevisionSchema).optional(),
  })
  .superRefine((range, ctx) => {
    if (range.end <= range.start) {
      ctx.addIssue({
        code: 'custom',
        path: ['end'],
        message: 'end must be greater than start.',
      });
    }
    // `duo` is a fixed two-face split; `single` never limits face count
    // (a fallback single crop over two detected faces is legal).
    if (range.layout === 'duo' && range.faces.length !== 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['faces'],
        message: "layout 'duo' requires exactly 2 faces.",
      });
    }
  });
export type ClipRange = z.infer<typeof ClipRangeSchema>;

/** One approved/rejected decision over a candidate range. */
export const ClipDecisionEntrySchema = z.strictObject({
  range: ClipRangeSchema,
  /** Resolved status: a decided range is never left as `candidate`. */
  status: z.enum(['approved', 'rejected']),
  /** Optional free-form reason for the decision. */
  note: z.string().optional(),
});
export type ClipDecisionEntry = z.infer<typeof ClipDecisionEntrySchema>;

/**
 * `clips/decisions.json` document: the human decisions recorded over the
 * candidate ranges of one source video, identified by the video's sha256.
 */
export const ClipDecisionSchema = z
  .strictObject({
    schemaVersion: z.literal(1).default(1),
    /** SHA-256 of the source video the ranges were cut from. */
    sourceSha256: Sha256Schema,
    /** Decision backend (dashboard, CLI, …) that produced this document. */
    backend: z.string().min(1),
    decisions: z.array(ClipDecisionEntrySchema),
  })
  .superRefine((decision, ctx) => {
    const seen = new Set<string>();
    decision.decisions.forEach((entry, index) => {
      if (seen.has(entry.range.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['decisions', index],
          message: `Duplicate range id "${entry.range.id}".`,
        });
      }
      seen.add(entry.range.id);
    });
  });
export type ClipDecision = z.infer<typeof ClipDecisionSchema>;
