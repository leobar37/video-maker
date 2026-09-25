/**
 * Versioned execution contracts for a video production run: the approved
 * proposal handed to the producer, the progress checkpoint written after each
 * stage, and the verifiable result of a successful run.
 *
 * V1 and V2 shapes are preserved; V2 adds `executionStatus` so a checkpoint can
 * express `waiting-human` / `error` without changing the stage vocabulary.
 */
import { z } from 'zod';

import {
  COMMIT_PATTERN,
  HttpUrlSchema,
  IsoTimestampSchema,
  SLUG_PATTERN,
  WAITING_ID_PATTERN,
} from './primitives';

const SlugSchema = z
  .string()
  .trim()
  .regex(SLUG_PATTERN, 'slug debe cumplir /^[a-z0-9][a-z0-9-]*$/ (minúsculas, números y guiones).');

/**
 * Validates a project-relative POSIX path for a produced artifact: no
 * absolute root, no `..`, no `\`, no NUL/newline, normalized. Anti-traversal
 * by construction — an artifact path can never escape the project root.
 */
export function sanitizeArtifactRelativePath(raw: string): string {
  const value = raw.trim();
  if (value === '') {
    throw new Error('La ruta del artefacto no puede estar vacía.');
  }
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('La ruta del artefacto no puede contener saltos de línea ni bytes NUL.');
  }
  if (value.includes('\\')) {
    throw new Error(`La ruta del artefacto debe usar separadores POSIX ("/"), no "\\": "${raw}".`);
  }
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value)) {
    throw new Error(`La ruta del artefacto debe ser relativa al proyecto, no absoluta: "${raw}".`);
  }
  if (value.split('/').includes('..')) {
    throw new Error(`La ruta del artefacto no puede contener ".." (escape del proyecto): "${raw}".`);
  }
  const normalized = value
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
  if (normalized === '') {
    throw new Error(`La ruta del artefacto no apunta a un archivo dentro del proyecto: "${raw}".`);
  }
  return normalized;
}

/** Sanitized project-relative artifact path (transform; rejects traversal). */
export const ArtifactRelativePathSchema = z.string().transform((raw, ctx) => {
  try {
    return sanitizeArtifactRelativePath(raw);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : String(error),
    });
    return z.NEVER;
  }
});

// ---------------------------------------------------------------------------
// Proposal — the approved input of a production run
// ---------------------------------------------------------------------------

/** Approved production proposal. Ids are plain strings (`product`/`slug`). */
export const VideoExecutionProposalV1Schema = z.object({
  schemaVersion: z.literal(1),
  product: z.string().min(1, 'product debe ser un string no vacío.'),
  slug: SlugSchema,
  title: z.string().trim().min(1, 'title debe ser un string no vacío.'),
  brief: z.string().trim().min(1, 'brief debe ser un string no vacío.'),
});
export type VideoExecutionProposalV1 = z.infer<typeof VideoExecutionProposalV1Schema>;

/** Hard token ceiling and wall-clock deadline of a production run. */
export const VideoExecutionLimitsSchema = z.object({
  tokenBudget: z.number().positive(),
  maxRuntimeMinutes: z.number().positive(),
});
export type VideoExecutionLimits = z.infer<typeof VideoExecutionLimitsSchema>;

// ---------------------------------------------------------------------------
// Progress — checkpoint written after every production stage
// ---------------------------------------------------------------------------

export const VIDEO_PROGRESS_STAGES = [
  'scaffolded',
  'preflight',
  'audio',
  'capture',
  'assembled',
  'qa',
  'published',
] as const;
export const VideoProgressStageSchema = z.enum(VIDEO_PROGRESS_STAGES);
export type VideoProgressStage = z.infer<typeof VideoProgressStageSchema>;

export const VideoExecutionStateSchema = z.enum(['active', 'waiting-human', 'error']);
export type VideoExecutionState = z.infer<typeof VideoExecutionStateSchema>;

/** Stable identity of the human decision that must be resolved before resume. */
export const VideoWaitingForSchema = z.object({
  id: z.string().regex(WAITING_ID_PATTERN, 'waitingFor.id tiene un formato inválido.'),
  reason: z.string().trim().min(1, 'waitingFor.reason debe ser un string no vacío.'),
});
export type VideoWaitingFor = z.infer<typeof VideoWaitingForSchema>;

export const VideoProgressV1Schema = z.object({
  schemaVersion: z.literal(1),
  stage: VideoProgressStageSchema,
  updatedAt: IsoTimestampSchema,
  detail: z.string().optional(),
});
export type VideoProgressV1 = z.infer<typeof VideoProgressV1Schema>;

export const VideoProgressV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    stage: VideoProgressStageSchema,
    updatedAt: IsoTimestampSchema,
    detail: z.string().optional(),
    executionStatus: VideoExecutionStateSchema,
    waitingFor: VideoWaitingForSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.executionStatus === 'waiting-human' && !value.waitingFor) {
      ctx.addIssue({
        code: 'custom',
        message: 'waiting-human requiere waitingFor.id y reason.',
      });
    }
    if (value.executionStatus !== 'waiting-human' && value.waitingFor) {
      ctx.addIssue({ code: 'custom', message: 'waitingFor solo aplica a waiting-human.' });
    }
    if (value.executionStatus === 'error' && (value.detail === undefined || !value.detail.trim())) {
      ctx.addIssue({ code: 'custom', message: 'error requiere detail.' });
    }
  });
export type VideoProgressV2 = z.infer<typeof VideoProgressV2Schema>;

export const VideoProgressSchema = z.discriminatedUnion('schemaVersion', [
  VideoProgressV1Schema,
  VideoProgressV2Schema,
]);
export type VideoProgress = z.infer<typeof VideoProgressSchema>;

/** Normalizes a V1 checkpoint to V2 (`executionStatus: 'active'`). */
export function adaptVideoProgress(progress: VideoProgress): VideoProgressV2 {
  return progress.schemaVersion === 2
    ? progress
    : { ...progress, schemaVersion: 2, executionStatus: 'active' };
}

// ---------------------------------------------------------------------------
// Result — verifiable outcome of a successful production run
// ---------------------------------------------------------------------------

export const VideoExecutionResultV1Schema = z.object({
  schemaVersion: z.literal(1),
  status: z.literal('succeeded'),
  product: z.string().min(1, 'product debe ser un string no vacío.'),
  slug: SlugSchema,
  title: z.string().trim().min(1, 'title debe ser un string no vacío.'),
  video: z.object({
    path: ArtifactRelativePathSchema.refine(
      (path) => path.endsWith('.mp4'),
      'video.path debe terminar en ".mp4".',
    ),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'video.sha256 debe ser un hash hexadecimal de 64 caracteres.'),
    durationSeconds: z
      .number()
      .refine((value) => Number.isFinite(value) && value > 0, 'durationSeconds debe ser > 0.'),
    publicUrl: HttpUrlSchema,
  }),
  qa: z.object({
    visual: z.literal('passed'),
    audio: z.literal('passed'),
    content: z.literal('passed'),
    technical: z.literal('passed'),
  }),
  git: z.object({
    commit: z
      .string()
      .regex(COMMIT_PATTERN, 'git.commit debe ser un SHA hexadecimal de 7 a 40 caracteres.'),
    pullRequest: HttpUrlSchema,
  }),
  completedAt: IsoTimestampSchema,
});
export type VideoExecutionResultV1 = z.infer<typeof VideoExecutionResultV1Schema>;

export const VideoExecutionResultV2Schema = VideoExecutionResultV1Schema.extend({
  schemaVersion: z.literal(2),
  executionStatus: z.literal('succeeded'),
});
export type VideoExecutionResultV2 = z.infer<typeof VideoExecutionResultV2Schema>;

export const VideoExecutionResultSchema = z.discriminatedUnion('schemaVersion', [
  VideoExecutionResultV1Schema,
  VideoExecutionResultV2Schema,
]);
export type VideoExecutionResult = z.infer<typeof VideoExecutionResultSchema>;

/** Normalizes a V1 result to V2 (`executionStatus: 'succeeded'`). */
export function adaptVideoResult(result: VideoExecutionResult): VideoExecutionResultV2 {
  return { ...result, schemaVersion: 2, executionStatus: 'succeeded' };
}
