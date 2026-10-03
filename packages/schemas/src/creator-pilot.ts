import { z } from 'zod';

import { ClipLayoutSchema, ClipRangeSchema, FrameAnalysisSchema } from './clip';
import { IsoTimestampSchema, Sha256Schema, SLUG_PATTERN } from './primitives';

const TextSchema = z.string().trim().min(1);
const IdSchema = z.string().regex(SLUG_PATTERN);
const ReviewSchema = { reviewer: TextSchema, reviewedAt: IsoTimestampSchema };

/** Optional, project-local editorial gate. It never authorizes publication. */
export const ClipPilotPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  enabled: z.boolean(),
  sampleIds: z.array(IdSchema).min(1).max(10).refine((ids) => new Set(ids).size === ids.length, 'Sample ids must be unique.'),
  contentType: z.enum(['educational', 'comedy']),
  maxCandidates: z.number().int().min(5).max(10),
});
export type ClipPilotPolicy = z.infer<typeof ClipPilotPolicySchema>;

export const ClipPilotCriterionSchema = z.strictObject({ passes: z.boolean(), note: TextSchema });
export type ClipPilotCriterion = z.infer<typeof ClipPilotCriterionSchema>;
export const ClipPilotCriteriaSchema = z.strictObject({
  premisa: ClipPilotCriterionSchema,
  autonomia: ClipPilotCriterionSchema,
  remate: ClipPilotCriterionSchema,
  fidelidad: ClipPilotCriterionSchema,
});
export type ClipPilotCriteria = z.infer<typeof ClipPilotCriteriaSchema>;
export const ClipPilotExampleSchema = z.strictObject({
  kind: z.enum(['positive', 'negative']),
  range: ClipRangeSchema,
  ...ReviewSchema,
  criteria: ClipPilotCriteriaSchema,
}).refine((example) => example.kind === 'positive'
  ? Object.values(example.criteria).every((criterion) => criterion.passes)
  : Object.values(example.criteria).some((criterion) => !criterion.passes),
'Positive examples must pass every criterion; negative examples must fail at least one.');
export type ClipPilotExample = z.infer<typeof ClipPilotExampleSchema>;

export const ClipPilotProvenanceSchema = z.strictObject({
  sourceSha256: Sha256Schema,
  sourceManifestSha256: Sha256Schema,
  transcriptSha256: Sha256Schema,
  decisionsSha256: Sha256Schema,
  framesSha256: Sha256Schema,
  /** Digest of sorted shard names and their file hashes, including metadata. */
  analysisSha256: Sha256Schema,
});
export type ClipPilotProvenance = z.infer<typeof ClipPilotProvenanceSchema>;

export const ClipPilotEdlSchema = z.strictObject({
  range: ClipRangeSchema,
  startFrame: FrameAnalysisSchema,
  endFrame: FrameAnalysisSchema,
  reactionWindows: z.array(z.strictObject({ start: z.number().finite().min(0), end: z.number().finite().min(0) })
    .refine((window) => window.end > window.start, 'Reaction end must follow start.')),
  layoutChanges: z.array(z.strictObject({
    t: z.number().finite().min(0), layout: ClipLayoutSchema,
    frameId: FrameAnalysisSchema.shape.frame_id,
  })),
});
export type ClipPilotEdl = z.infer<typeof ClipPilotEdlSchema>;

const SamplePathSchema = z.string().regex(/^renders\/clips\/[a-z0-9][a-z0-9-]*\.mp4$/, 'Sample must be a project-relative rendered clip.');

/** Editorial approval of a local montage sample, not publish/hash approval. */
export const ClipPilotEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  approval: z.enum(['pending', 'approved', 'rejected']),
  ...ReviewSchema,
  contentType: z.enum(['educational', 'comedy']),
  provenance: ClipPilotProvenanceSchema,
  examples: z.array(ClipPilotExampleSchema).min(2),
  sample: z.strictObject({ rangeId: IdSchema, path: SamplePathSchema, sha256: Sha256Schema }),
  transcriptReview: z.strictObject({
    ...ReviewSchema, trustworthy: z.boolean(),
    /** Global transcript indexes: unresolved words must never be burned. */
    unreliableWordIndexes: z.array(z.number().int().min(0)),
  }),
  framingReview: z.strictObject({
    ...ReviewSchema, safeFramingReviewed: z.boolean(), layoutReviewed: z.boolean(),
  }),
  edl: z.array(ClipPilotEdlSchema).min(1),
}).superRefine((evidence, ctx) => {
  for (const kind of ['positive', 'negative'] as const) {
    if (!evidence.examples.some((example) => example.kind === kind)) {
      ctx.addIssue({ code: 'custom', path: ['examples'], message: `A reviewed ${kind} example is required.` });
    }
  }
  if (evidence.sample.path !== `renders/clips/${evidence.sample.rangeId}.mp4`) {
    ctx.addIssue({ code: 'custom', path: ['sample', 'path'], message: 'Sample path must match its range id.' });
  }
  const ids = evidence.edl.map((entry) => entry.range.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: 'custom', path: ['edl'], message: 'EDL range ids must be unique.' });
  }
});
export type ClipPilotEvidence = z.infer<typeof ClipPilotEvidenceSchema>;
