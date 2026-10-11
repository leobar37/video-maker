import { z } from 'zod';
import { Sha256Schema } from './primitives';

const TextSchema = z.string().trim().min(1).max(20_000);
const LiteralTextSchema = z.string().min(1).max(20_000).refine(text => text.trim().length > 0, { message: 'Text must not be blank.' });
const SecondsSchema = z.number().finite().nonnegative();
export const ClipSelectionTranscriptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  videoId: z.string().trim().min(1).max(200),
  language: z.string().trim().min(1).max(30),
  durationSec: z.number().finite().positive(),
  segments: z.array(z.strictObject({
    id: z.string().trim().min(1).max(100),
    startSec: SecondsSchema,
    endSec: SecondsSchema,
    speaker: z.string().trim().min(1).max(100),
    text: LiteralTextSchema,
  })).max(10_000),
}).superRefine((transcript, ctx) => {
  const ids = new Set<string>();
  let previousEnd = 0;
  transcript.segments.forEach((segment, index) => {
    if (ids.has(segment.id)) ctx.addIssue({ code: 'custom', path: ['segments', index, 'id'], message: 'Segment IDs must be unique.' });
    ids.add(segment.id);
    if (segment.endSec <= segment.startSec || segment.endSec > transcript.durationSec) {
      ctx.addIssue({ code: 'custom', path: ['segments', index], message: 'Require 0 <= startSec < endSec <= durationSec.' });
    }
    if (segment.startSec < previousEnd) ctx.addIssue({ code: 'custom', path: ['segments', index, 'startSec'], message: 'Segments must be ordered and non-overlapping.' });
    previousEnd = segment.endSec;
  });
  if (transcript.segments.reduce((sum, segment) => sum + segment.text.length, 0) > 1_000_000) {
    ctx.addIssue({ code: 'custom', path: ['segments'], message: 'Transcript text exceeds 1,000,000 characters.' });
  }
});
export type ClipSelectionTranscript = z.infer<typeof ClipSelectionTranscriptSchema>;


const ClipSelectionLevelsSchema = z.array(z.string().trim().min(1).max(120)).min(2).max(10);
const UnitScoreSchema = z.number().finite().min(0).max(1);

/**
 * Optional override of the built-in editorial rubric.
 *
 * The persisted evaluation keeps its four canonical signal slots
 * (`hook`, `value`, `autonomy`, `closure`) and its two gates
 * (`standalone`, `faithful`); this override rewrites the PROMPTS, the LEVEL
 * LABELS, the WEIGHTS and the routing thresholds for a given request. Arbitrary
 * new signal ids would change the stored contract, so they are deliberately out
 * of scope here.
 */
export const ClipSelectionRubricOverrideSchema = z.strictObject({
  instructions: z
    .strictObject({
      hook: TextSchema.optional(),
      value: TextSchema.optional(),
      autonomy: TextSchema.optional(),
      closure: TextSchema.optional(),
    })
    .optional(),
  levels: z
    .strictObject({
      hook: ClipSelectionLevelsSchema.optional(),
      value: ClipSelectionLevelsSchema.optional(),
      autonomy: ClipSelectionLevelsSchema.optional(),
      closure: ClipSelectionLevelsSchema.optional(),
    })
    .optional(),
  weights: z
    .strictObject({
      hook: z.number().finite().min(0).max(1),
      value: z.number().finite().min(0).max(1),
      autonomy: z.number().finite().min(0).max(1),
      closure: z.number().finite().min(0).max(1),
    })
    .refine(
      (weights) => weights.hook + weights.value + weights.autonomy + weights.closure > 0,
      { message: 'Rubric weights must not all be zero.' },
    )
    .optional(),
  /** Minimum quality (0-100) for a `suggested` route (default 75). */
  minQuality: z.number().finite().min(0).max(100).optional(),
  /** Minimum Score confidence to accept a suggestion (default 0.80). */
  confidenceFloor: UnitScoreSchema.optional(),
  /** Minimum standalone/faithful gate value to accept a suggestion (default 0.95). */
  gateFloor: UnitScoreSchema.optional(),
});
export type ClipSelectionRubricOverride = z.infer<typeof ClipSelectionRubricOverrideSchema>;

export const ClipSelectionRequestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  /** Relative to the request file; containment is checked against --project. */
  transcript: z.string().min(1).max(4096),
  audience: TextSchema,
  objective: TextSchema,
  contentType: z.enum(['educational', 'comedy']).default('educational'),
  maxClips: z.number().int().min(1).max(50),
  duration: z.strictObject({
    minSec: z.number().finite().min(1).max(600),
    maxSec: z.number().finite().min(1).max(600),
  }).refine(value => value.maxSec >= value.minSec, { message: 'maxSec must be >= minSec.' }),
  maxCandidates: z.number().int().min(1).max(500).default(100),
  model: z.literal('jev-1.13.0').default('jev-1.13.0'),
  /** Rewrite prompts/levels/weights/thresholds without changing the result contract. */
  rubric: ClipSelectionRubricOverrideSchema.optional(),
  /** Reaction-peaks JSON (`{events:[{peakSec,riseDb}]}`) folded into the ranking. */
  reactionPeaks: z.string().min(1).max(4096).optional(),
  /**
   * Weight 0-1 given to the audience-reaction bonus when re-ranking. Optional
   * WITHOUT a default on purpose: injecting a value would change the selection
   * digest of every existing request and invalidate its paid cache.
   */
  reactionWeight: z.number().finite().min(0).max(1).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  deadlineMs: z.number().int().min(100).max(3_600_000).default(120_000),
});
export type ClipSelectionRequest = z.infer<typeof ClipSelectionRequestSchema>;

export const CLIP_SELECTION_SIGNALS = ['hook', 'value', 'autonomy', 'closure'] as const;
export const ClipSelectionSignalsSchema = z.strictObject({
  hook: z.number().finite().min(0).max(100),
  value: z.number().finite().min(0).max(100),
  autonomy: z.number().finite().min(0).max(100),
  closure: z.number().finite().min(0).max(100),
});
export type ClipSelectionSignals = z.infer<typeof ClipSelectionSignalsSchema>;

export const ClipSelectionCandidateSchema = z.strictObject({
  id: z.string().min(1),
  sourceRange: z.strictObject({ startSec: SecondsSchema, endSec: SecondsSchema }),
  sourceSegments: z.array(z.string().min(1)).min(1),
  speaker: z.string().min(1),
  text: LiteralTextSchema,
}).refine(value => value.sourceRange.endSec > value.sourceRange.startSec, { message: 'Candidate range must have positive duration.' });
export type ClipSelectionCandidate = z.infer<typeof ClipSelectionCandidateSchema>;

const ProbabilitySchema = z.number().finite().min(0).max(1);
export const ClipSelectionEvaluationSchema = z.strictObject({
  quality: z.number().finite().min(0).max(100),
  minScoreConfidence: ProbabilitySchema,
  signals: ClipSelectionSignalsSchema,
  gates: z.strictObject({ standalone: ProbabilitySchema, faithful: ProbabilitySchema }),
  model: z.literal('jev-1.13.0'),
  usage: z.strictObject({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
  responseSha256: Sha256Schema,
  responsePath: z.string().min(1),
});
export type ClipSelectionEvaluation = z.infer<typeof ClipSelectionEvaluationSchema>;

export const ClipSelectionResultEntrySchema = z.strictObject({
  candidate: ClipSelectionCandidateSchema,
  route: z.enum(['suggested', 'review', 'rejected', 'duplicate', 'not_selected', 'evaluation_failed']),
  evaluation: ClipSelectionEvaluationSchema.nullable(),
  reasonCodes: z.array(z.string().min(1)),
  duplicateOf: z.string().optional(),
  errorCode: z.string().optional(),
  cached: z.boolean(),
  cutStatus: z.literal('needs_audio_video_review'),
  approvedForPublication: z.literal(false),
}).superRefine((entry, ctx) => {
  if ((entry.route === 'evaluation_failed') !== (entry.evaluation === null)) {
    ctx.addIssue({ code: 'custom', path: ['evaluation'], message: 'Only failed evaluations have null metrics.' });
  }
  if (entry.route === 'duplicate' && !entry.duplicateOf) {
    ctx.addIssue({ code: 'custom', path: ['duplicateOf'], message: 'Duplicates must reference a candidate.' });
  }
});
export type ClipSelectionResultEntry = z.infer<typeof ClipSelectionResultEntrySchema>;

export const ClipSelectionResultEntryV1Schema = ClipSelectionResultEntrySchema;
export type ClipSelectionResultEntryV1 = ClipSelectionResultEntry;

export const ClipSelectionResultV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.enum(['complete', 'partial']),
  videoId: z.string().min(1),
  requestSha256: Sha256Schema,
  transcriptSha256: Sha256Schema,
  selectionDigest: Sha256Schema,
  createdAt: z.iso.datetime(),
  rubricVersion: z.literal(1),
  policyVersion: z.literal(1),
  model: z.literal('jev-1.13.0'),
  selectedIds: z.array(z.string()),
  reviewIds: z.array(z.string()),
  entries: z.array(ClipSelectionResultEntrySchema),
  warnings: z.array(z.string()),
  spend: z.strictObject({
    capUsd: z.number().finite().nonnegative(),
    reservedUsd: z.number().finite().nonnegative(),
    actualUsd: z.number().finite().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    newCalls: z.number().int().nonnegative(),
    cachedCalls: z.number().int().nonnegative(),
  }),
  approvedForPublication: z.literal(false),
});
export type ClipSelectionResultV1 = z.infer<typeof ClipSelectionResultV1Schema>;
/** Legacy producer contract; migrate producers explicitly to V2. */
export type ClipSelectionResult = ClipSelectionResultV1;

const UsdSchema = z.number().finite().nonnegative();
const EvidenceTextSchema = z.string().min(1).refine(value => value.trim().length > 0, { message: 'Evidence must not be blank.' });
const USD_TOLERANCE = 1e-12;

/**
 * Verbatim latest journal record for this candidate's paid attempt. Reporting
 * does not reconcile, close, rewrite, or replace the original ledger evidence.
 */
export const ClipSelectionAttemptEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  attemptId: EvidenceTextSchema,
  planDigest: Sha256Schema,
  command: z.literal('clips-select'),
  subject: EvidenceTextSchema,
  state: z.enum(['uncertain', 'submitted', 'completed', 'reconciled']),
  reservedUsd: UsdSchema,
  createdAt: z.iso.datetime(),
  receipt: z.strictObject({
    requestId: EvidenceTextSchema,
    statusUrl: EvidenceTextSchema.optional(),
    responseUrl: EvidenceTextSchema.optional(),
  }).optional(),
  reconciliation: z.strictObject({
    by: EvidenceTextSchema,
    at: z.iso.datetime(),
    evidence: EvidenceTextSchema,
  }).optional(),
}).superRefine((attempt, ctx) => {
  if (attempt.state === 'uncertain' && attempt.receipt !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['receipt'], message: 'An uncertain attempt cannot carry a receipt.' });
  }
  if ((attempt.state === 'submitted' || attempt.state === 'completed') && attempt.receipt === undefined) {
    ctx.addIssue({ code: 'custom', path: ['receipt'], message: 'A proven submit requires its original receipt.' });
  }
  if ((attempt.state === 'reconciled') !== (attempt.reconciliation !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['reconciliation'], message: 'Only reconciled attempts require reconciliation evidence.' });
  }
});
export type ClipSelectionAttemptEvidence = z.infer<typeof ClipSelectionAttemptEvidenceSchema>;

export const ClipSelectionLifecycleSchema = z.enum(['evaluated', 'not_evaluated', 'failed', 'uncertain']);
export type ClipSelectionLifecycle = z.infer<typeof ClipSelectionLifecycleSchema>;
export const ClipSelectionEditorialRouteSchema = z.enum(['suggested', 'review', 'rejected', 'duplicate', 'not_selected']);
export type ClipSelectionEditorialRoute = z.infer<typeof ClipSelectionEditorialRouteSchema>;
export const ClipSelectionProvenanceSchema = z.enum(['automatic-complete', 'automatic-partial', 'editorial-local']);
export type ClipSelectionProvenance = z.infer<typeof ClipSelectionProvenanceSchema>;

export const ClipSelectionResultEntryV2Schema = z.strictObject({
  candidate: ClipSelectionCandidateSchema,
  lifecycle: ClipSelectionLifecycleSchema,
  /** No editorial ranking is inferred for a candidate without valid metrics. */
  route: ClipSelectionEditorialRouteSchema.nullable(),
  evaluation: ClipSelectionEvaluationSchema.nullable(),
  reasonCodes: z.array(EvidenceTextSchema),
  duplicateOf: EvidenceTextSchema.optional(),
  errorCode: EvidenceTextSchema.optional(),
  attempt: ClipSelectionAttemptEvidenceSchema.nullable(),
  cached: z.boolean(),
  cutStatus: z.literal('needs_audio_video_review'),
  approvedForPublication: z.literal(false),
}).superRefine((entry, ctx) => {
  const evaluated = entry.lifecycle === 'evaluated';
  if (evaluated !== (entry.evaluation !== null)) {
    ctx.addIssue({ code: 'custom', path: ['evaluation'], message: 'Only evaluated candidates have metrics, and their metrics are required.' });
  }
  if (evaluated !== (entry.route !== null)) {
    ctx.addIssue({ code: 'custom', path: ['route'], message: 'Editorial routes require an evaluated candidate.' });
  }
  if (entry.route === 'duplicate' ? !entry.duplicateOf : entry.duplicateOf !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['duplicateOf'], message: 'Only duplicates must reference another candidate.' });
  }
  if (!evaluated && entry.reasonCodes.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['reasonCodes'], message: 'Unevaluated lifecycles must explain why metrics are absent.' });
  }
  if (!evaluated && entry.cached) {
    ctx.addIssue({ code: 'custom', path: ['cached'], message: 'Only valid evaluations can be reused from cache.' });
  }
  if (entry.lifecycle === 'not_evaluated' && entry.attempt !== null) {
    ctx.addIssue({ code: 'custom', path: ['attempt'], message: 'Not-evaluated candidates must not hide a paid attempt.' });
  }
  if (evaluated && (!entry.attempt || !(
    entry.attempt.state === 'completed' ||
    (entry.attempt.state === 'reconciled' && entry.attempt.receipt !== undefined)
  ))) {
    ctx.addIssue({ code: 'custom', path: ['attempt'], message: 'Evaluations require completed or explicitly reconciled paid evidence.' });
  }
  if (entry.lifecycle === 'uncertain' && (!entry.attempt ||
    !['uncertain', 'submitted'].includes(entry.attempt.state) || entry.attempt.reservedUsd <= 0)) {
    ctx.addIssue({ code: 'custom', path: ['attempt'], message: 'Uncertain outcomes require their open paid attempt and a positive reservation.' });
  }
  if (entry.lifecycle === 'failed' && entry.attempt !== null && entry.attempt.state !== 'reconciled') {
    ctx.addIssue({ code: 'custom', path: ['attempt'], message: 'A paid attempt is not a proven failure without explicit reconciliation evidence.' });
  }
});
export type ClipSelectionResultEntryV2 = z.infer<typeof ClipSelectionResultEntryV2Schema>;

export const ClipSelectionSpendV2Schema = z.strictObject({
  capUsd: UsdSchema,
  /** Confirmed charge evidence; uncertain costs remain in openReservedUsd. */
  confirmedActualUsd: UsdSchema,
  /** Original reservations made for these attempts, including now-closed ones. */
  historicalReservedUsd: UsdSchema,
  /** Latest uncertain/submitted reservations, each attempt counted once. */
  openReservedUsd: UsdSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  newCalls: z.number().int().nonnegative(),
  cachedCalls: z.number().int().nonnegative(),
}).superRefine((spend, ctx) => {
  if (spend.confirmedActualUsd + spend.openReservedUsd > spend.historicalReservedUsd + USD_TOLERANCE) {
    ctx.addIssue({ code: 'custom', path: ['historicalReservedUsd'], message: 'Historical reservations must cover confirmed charges and still-open reservations.' });
  }
});
export type ClipSelectionSpendV2 = z.infer<typeof ClipSelectionSpendV2Schema>;

export const ClipSelectionResultV2Schema = z.strictObject({
  schemaVersion: z.literal(2),
  status: z.enum(['complete', 'partial']),
  provenance: ClipSelectionProvenanceSchema,
  videoId: z.string().min(1),
  requestSha256: Sha256Schema,
  transcriptSha256: Sha256Schema,
  selectionDigest: Sha256Schema,
  createdAt: z.iso.datetime(),
  rubricVersion: z.literal(1),
  policyVersion: z.literal(1),
  model: z.literal('jev-1.13.0'),
  selectedIds: z.array(EvidenceTextSchema),
  reviewIds: z.array(EvidenceTextSchema),
  entries: z.array(ClipSelectionResultEntryV2Schema).max(500),
  warnings: z.array(z.string()),
  spend: ClipSelectionSpendV2Schema,
  approvedForPublication: z.literal(false),
}).superRefine((result, ctx) => {
  const entriesById = new Map<string, ClipSelectionResultEntryV2>();
  const attemptIds = new Set<string>();
  let openReservedUsd = 0;
  let completedUsd = 0;
  result.entries.forEach((entry, index) => {
    if (entriesById.has(entry.candidate.id)) {
      ctx.addIssue({ code: 'custom', path: ['entries', index, 'candidate', 'id'], message: 'Candidate IDs must be unique.' });
    }
    entriesById.set(entry.candidate.id, entry);
    if (!entry.attempt) return;
    if (attemptIds.has(entry.attempt.attemptId)) {
      ctx.addIssue({ code: 'custom', path: ['entries', index, 'attempt', 'attemptId'], message: 'A paid attempt cannot belong to multiple candidates.' });
    }
    attemptIds.add(entry.attempt.attemptId);
    if (entry.attempt.state === 'uncertain' || entry.attempt.state === 'submitted') {
      openReservedUsd += entry.attempt.reservedUsd;
    }
    if (entry.attempt.state === 'completed') completedUsd += entry.attempt.reservedUsd;
  });
  for (const [field, route] of [['selectedIds', 'suggested'], ['reviewIds', 'review']] as const) {
    const ids = result[field];
    const expected = result.entries.filter(entry => entry.lifecycle === 'evaluated' && entry.route === route);
    if (new Set(ids).size !== ids.length || ids.length !== expected.length ||
      ids.some(id => entriesById.get(id)?.lifecycle !== 'evaluated' || entriesById.get(id)?.route !== route)) {
      ctx.addIssue({ code: 'custom', path: [field], message: 'IDs must match the evaluated candidates with this editorial route exactly.' });
    }
  }
  result.entries.forEach((entry, index) => {
    if (entry.route === 'duplicate' && (entry.duplicateOf === entry.candidate.id ||
      entriesById.get(entry.duplicateOf ?? '')?.route !== 'suggested')) {
      ctx.addIssue({ code: 'custom', path: ['entries', index, 'duplicateOf'], message: 'Duplicates must reference another suggested candidate in the result.' });
    }
  });
  const complete = result.entries.every(entry => entry.lifecycle === 'evaluated');
  if ((result.status === 'complete') !== complete) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'Only a result with every candidate evaluated is complete.' });
  }
  if ((result.provenance === 'automatic-complete' && !complete) ||
    (result.provenance === 'automatic-partial' && complete)) {
    ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'Automatic provenance must reflect whether all candidates were evaluated.' });
  }
  if (Math.abs(result.spend.openReservedUsd - openReservedUsd) > USD_TOLERANCE) {
    ctx.addIssue({ code: 'custom', path: ['spend', 'openReservedUsd'], message: 'Open reserves must match the latest open attempt evidence, not historical journal sums.' });
  }
  if (result.spend.confirmedActualUsd + USD_TOLERANCE < completedUsd) {
    ctx.addIssue({ code: 'custom', path: ['spend', 'confirmedActualUsd'], message: 'Confirmed charges cannot omit completed attempt costs.' });
  }
});
export type ClipSelectionResultV2 = z.infer<typeof ClipSelectionResultV2Schema>;
export const ClipSelectionResultLatestSchema = ClipSelectionResultV2Schema;
export type ClipSelectionResultLatest = ClipSelectionResultV2;

/** Compatibility reader only: new producers must choose a version explicitly. */
export const ClipSelectionResultSchema = z.union([ClipSelectionResultV1Schema, ClipSelectionResultV2Schema]);
export type ClipSelectionResultDocument = z.infer<typeof ClipSelectionResultSchema>;
