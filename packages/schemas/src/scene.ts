/**
 * FR-014 scene delegation contract pair: a curated `SceneBrief` goes in, a
 * verifiable `SceneResult` comes out. Orchestrators never write scene
 * artifacts themselves — they emit a brief, the producer writes the result,
 * and an independent verifier checks the sha256 evidence against disk.
 *
 * The delegation journal is the mandatory trace of who executed each scene.
 */
import { z } from 'zod';

import { Sha256Schema } from './primitives';

// ---------------------------------------------------------------------------
// SceneResult — what every scene producer MUST write to disk
// ---------------------------------------------------------------------------

export const SceneDiagnosticSchema = z.object({
  level: z.enum(['error', 'warn', 'info']),
  message: z.string().min(1),
});
export type SceneDiagnostic = z.infer<typeof SceneDiagnosticSchema>;

/** Legacy result: `status` is an execution fact, never an editorial approval. */
export const SceneResultV1Schema = z.object({
  schemaVersion: z.literal(1).optional(),
  sceneId: z.string().min(1),
  agent: z.string().min(1),
  status: z.enum(['ok', 'fail']),
  /** Project-relative path of the produced artifact (code / config / critique). */
  outputPath: z.string().min(1).optional(),
  /** Project-relative path of the validation still, when produced. */
  stillPath: z.string().min(1).optional(),
  diagnostics: z.array(SceneDiagnosticSchema).default([]),
});
export type SceneResultV1 = z.infer<typeof SceneResultV1Schema>;

export const SceneResultV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    sceneId: z.string().min(1),
    agent: z.string().min(1),
    executionStatus: z.enum(['ok', 'fail']),
    editorialVerdict: z.enum(['pass', 'blocked', 'unreviewed']),
    outputPath: z.string().min(1).optional(),
    outputSha256: Sha256Schema.optional(),
    stillPath: z.string().min(1).optional(),
    stillSha256: Sha256Schema.optional(),
    diagnostics: z.array(SceneDiagnosticSchema).default([]),
    artifacts: z
      .array(z.object({ path: z.string().min(1), sha256: Sha256Schema }))
      .optional(),
    audiovisualVerdict: z.enum(['pass', 'blocked', 'unreviewed']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.executionStatus === 'ok' && (!value.outputPath || !value.outputSha256)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Una ejecución ok requiere outputPath y outputSha256.',
      });
    }
    if (value.stillPath && !value.stillSha256) {
      ctx.addIssue({ code: 'custom', message: 'stillPath requiere stillSha256.' });
    }
    if (
      value.editorialVerdict === 'pass' &&
      (value.executionStatus !== 'ok' || value.diagnostics.some((item) => item.level === 'error'))
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Un resultado con errores no puede tener veredicto pass.',
      });
    }
  });
export type SceneResultV2 = z.infer<typeof SceneResultV2Schema>;

/** V3 adds an explicit pause; successful/failed executions retain V2. */
export const SceneResultV3Schema = z.object({
  schemaVersion: z.literal(3),
  sceneId: z.string().min(1),
  agent: z.string().min(1),
  executionStatus: z.literal('waiting-human'),
  editorialVerdict: z.enum(['blocked', 'unreviewed']),
  waitingFor: z.object({
    id: z.string().min(1),
    code: z.string().regex(/^[A-Z][A-Z0-9_]+$/, 'code debe ser una CONSTANTE_EN_MAYÚSCULAS.'),
    reason: z.string().min(1),
    nextAction: z.string().min(1),
  }),
  outputPath: z.string().min(1).optional(),
  outputSha256: Sha256Schema.optional(),
  stillPath: z.string().min(1).optional(),
  stillSha256: Sha256Schema.optional(),
  diagnostics: z.array(SceneDiagnosticSchema).default([]),
  artifacts: z
    .array(z.object({ path: z.string().min(1), sha256: Sha256Schema }))
    .optional(),
  audiovisualVerdict: z.enum(['pass', 'blocked', 'unreviewed']).optional(),
});
export type SceneResultV3 = z.infer<typeof SceneResultV3Schema>;

/** Legacy status is an execution fact, never an editorial approval. */
export const SceneResultSchema = z
  .union([SceneResultV3Schema, SceneResultV2Schema, SceneResultV1Schema])
  .transform((value) => {
    if ('executionStatus' in value) return value;
    const { status, ...rest } = value;
    return {
      ...rest,
      schemaVersion: 2 as const,
      executionStatus: status,
      editorialVerdict: value.diagnostics.some((item) => item.level === 'error')
        ? ('blocked' as const)
        : ('unreviewed' as const),
      outputSha256: undefined as string | undefined,
      stillSha256: undefined as string | undefined,
      artifacts: undefined as Array<{ path: string; sha256: string }> | undefined,
      audiovisualVerdict: undefined as 'pass' | 'blocked' | 'unreviewed' | undefined,
    };
  });
export type SceneResult = z.infer<typeof SceneResultSchema>;

// ---------------------------------------------------------------------------
// SceneBrief — curated input package handed to the producer
// ---------------------------------------------------------------------------

/** Branding shape the scene producers consume (flat, resolved from a preset). */
export const SceneBrandingSchema = z.object({
  canvasFrom: z.string().min(1),
  canvasTo: z.string().min(1),
  ink: z.string().min(1),
  accent: z.string().min(1),
  fontDisplay: z.string().min(1),
  fontBody: z.string().min(1),
});
export type SceneBranding = z.infer<typeof SceneBrandingSchema>;

export const SceneSourceSchema = z.enum(['demo-app', 'motion', 'fal-video', 'avatar']);
export type SceneSource = z.infer<typeof SceneSourceSchema>;

export const SceneNeighborSchema = z.object({
  id: z.string(),
  intent: z.string(),
  narration: z.string(),
  source: SceneSourceSchema,
  durationSeconds: z.number().positive(),
});
export type SceneNeighbor = z.infer<typeof SceneNeighborSchema>;

export const GlobalDirectionSchema = z.object({
  title: z.string(),
  styleReference: z.string().optional(),
  cameraLanguage: z.string().optional(),
});
export type GlobalDirection = z.infer<typeof GlobalDirectionSchema>;

/**
 * Exact sample-range of one scene inside the continuous narration master.
 * `startSeconds`/`endSeconds` and `startFrame`/`endFrame` must describe the
 * same interval at the given sample rate and fps.
 */
export const SceneAudioBindingSchema = z.object({
  schemaVersion: z.literal(1),
  masterPath: z.string().min(1),
  masterSha256: Sha256Schema,
  masterFingerprint: z.string().min(1),
  sceneId: z.string().min(1),
  startSample: z.number().int().nonnegative(),
  endSample: z.number().int().positive(),
  paddingEndSamples: z.number().int().nonnegative().optional(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
  bitsPerSample: z.number().int().positive(),
  semanticStartSeconds: z.number().nonnegative(),
  semanticEndSeconds: z.number().positive(),
  startSeconds: z.number().nonnegative(),
  endSeconds: z.number().positive(),
  fps: z.number().positive(),
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
  segmentPath: z.string().min(1),
  segmentSha256: Sha256Schema,
  boundaryReview: z
    .object({
      schemaVersion: z.literal(1),
      policy: z.literal('human-reviewed-boundaries/v1'),
      required: z.literal(true),
      checks: z.tuple([z.literal('segment-start'), z.literal('segment-end')]),
      measurements: z.array(
        z.object({
          edge: z.enum(['start', 'end']),
          fromSample: z.number().int().nonnegative(),
          toSample: z.number().int().nonnegative(),
          peakDbfs: z.number().finite().nullable(),
          rmsDbfs: z.number().finite().nullable(),
        }),
      ),
    })
    .optional(),
});
export type SceneAudioBinding = z.infer<typeof SceneAudioBindingSchema>;

export const CharacterSchema = z.object({
  id: z.string().min(1),
  references: z.array(z.string().min(1)).default([]),
});
export type Character = z.infer<typeof CharacterSchema>;

export const AvatarConfigSchema = z.object({
  image: z.string().min(1),
  audio: z.string().min(1),
  audioBinding: SceneAudioBindingSchema,
  characterRefs: z.array(z.string().min(1)).optional(),
  productReferences: z.array(z.string().min(1)).optional(),
});
export type AvatarConfig = z.infer<typeof AvatarConfigSchema>;

export const SceneAvatarReviewSchema = z.object({
  schemaVersion: z.literal(1),
  sceneId: z.string().min(1),
  digest: Sha256Schema,
  artifacts: z.array(z.object({ path: z.string().min(1), sha256: Sha256Schema })),
  bindingDigest: Sha256Schema,
  criticSha256: Sha256Schema.nullable(),
});
export type SceneAvatarReview = z.infer<typeof SceneAvatarReviewSchema>;

/** An operation the brief authorizes the producer to spend on. */
export const SceneOperationSchema = z.object({
  subject: z.string().min(1),
  digest: Sha256Schema,
  command: z.string().min(1),
  budgetUsd: z.number().nonnegative(),
  maxAttempts: z.number().int().positive(),
});
export type SceneOperation = z.infer<typeof SceneOperationSchema>;

export const SceneBriefSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  sceneId: z.string().min(1),
  agent: z.string().min(1),
  /** Project-relative video project dir (e.g. `<producto>/<slug>`). */
  videoDir: z.string().min(1),
  intent: z.string().min(1),
  narration: z.string().default(''),
  durationSeconds: z.number().positive(),
  brandingPreset: z.string().min(1),
  branding: SceneBrandingSchema,
  /** When false the scene must not show channel/company brand. */
  isBranded: z.boolean().default(true),
  /** Project-relative output artifact path the producer must write. */
  outputPath: z.string().min(1),
  /** Project-relative validation still path the producer should write. */
  stillPath: z.string().min(1),
  /** Curated context package: 3-4 project-relative files, never full specs. */
  contextFiles: z.array(z.string().min(1)).min(1),
  globalDirection: GlobalDirectionSchema.optional(),
  neighbors: z
    .object({ previous: SceneNeighborSchema.optional(), next: SceneNeighborSchema.optional() })
    .optional(),
  source: SceneSourceSchema.optional(),
  /** Paths here are project-relative, unlike outputPath/contextFiles. */
  avatar: AvatarConfigSchema.optional(),
  identityReferences: z.array(CharacterSchema).optional(),
  /** The supplied image contains the product; no unsupported field is invented. */
  productReferencePaths: z.array(z.string().min(1)).optional(),
  authorizedOperations: z.array(SceneOperationSchema).optional(),
  avatarReview: SceneAvatarReviewSchema.optional(),
  avatarCritiquePath: z.string().min(1).optional(),
});
export type SceneBrief = z.infer<typeof SceneBriefSchema>;

// ---------------------------------------------------------------------------
// Delegation journal — durable trace of who executed a scene
// ---------------------------------------------------------------------------

export const SceneDelegationSchema = z.object({
  schemaVersion: z.literal(1),
  sceneId: z.string().min(1),
  agent: z.string().min(1),
  /** Task-registry id of the producer that executed the scene. */
  agentId: z.string().min(1),
  /** Transcript reference of the execution. */
  historyRef: z.string().min(1),
  model: z.string().optional(),
  workspaceRef: z.string().optional(),
  briefPath: z.string().min(1),
  briefDigest: Sha256Schema,
  startedAt: z.string().min(1),
  endedAt: z.string().optional(),
  outcome: z.enum(['running', 'ok', 'fail', 'waiting-human']),
  resultRef: z.string().optional(),
});
export type SceneDelegation = z.infer<typeof SceneDelegationSchema>;

export const SceneDelegationJournalSchema = z.object({
  schemaVersion: z.literal(1),
  sceneId: z.string().min(1),
  entries: z.array(SceneDelegationSchema),
});
export type SceneDelegationJournal = z.infer<typeof SceneDelegationJournalSchema>;
