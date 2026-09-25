/**
 * Continuous narration contract (`narration.json`): the whole video's voice is
 * synthesized as ONE take so the voice stays acoustically identical across
 * scene cuts. The stored metadata pins the exact text, the voice
 * configuration fingerprint and the sha256 of the master audio.
 *
 * Scene timings are continuous: a scene ends exactly where the next one
 * starts — no padding, no gaps. The schema enforces that invariant so
 * corrupted metadata can never reach the renderer.
 */
import { z } from 'zod';

import { IsoTimestampSchema, Sha256Schema } from './primitives';

/** Tolerance (seconds) for continuity and duration arithmetic. */
export const NARRATION_TIMING_TOLERANCE_SECONDS = 1e-6;

/** Voice settings applied to the single synthesis request. */
export const VoiceSettingsSchema = z.object({
  stability: z.number().optional(),
  similarity_boost: z.number().optional(),
  style: z.number().optional(),
  use_speaker_boost: z.boolean().optional(),
  speed: z.number().optional(),
});
export type VoiceSettings = z.infer<typeof VoiceSettingsSchema>;

/**
 * Per-scene on-screen timing derived from the master narration. Continuity
 * (no gaps, no overlaps) is validated at document level over the whole
 * `scenes` list.
 */
export const SceneTimingSchema = z
  .object({
    sceneId: z.string().min(1),
    startSeconds: z.number().finite(),
    endSeconds: z.number().finite(),
    durationSeconds: z.number().finite(),
  })
  .superRefine((scene, ctx) => {
    if (scene.endSeconds <= scene.startSeconds) {
      ctx.addIssue({
        code: 'custom',
        message: `Timing inválido para ${scene.sceneId}: endSeconds debe ser mayor que startSeconds.`,
      });
    }
    if (
      Math.abs(scene.endSeconds - scene.startSeconds - scene.durationSeconds) >
      NARRATION_TIMING_TOLERANCE_SECONDS
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `Timing inválido para ${scene.sceneId}: durationSeconds no es endSeconds - startSeconds.`,
      });
    }
    if (scene.startSeconds < 0) {
      ctx.addIssue({
        code: 'custom',
        message: `Timing inválido para ${scene.sceneId}: startSeconds no puede ser negativo.`,
      });
    }
  });
export type SceneTiming = z.infer<typeof SceneTimingSchema>;

/** Tracked metadata of the continuous narration master. */
export const ContinuousNarrationSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    mode: z.literal('continuous'),
    provider: z.string().min(1),
    voiceId: z.string().min(1),
    voiceName: z.string().nullable(),
    modelId: z.string().min(1),
    language: z.string().nullable(),
    voiceSettings: VoiceSettingsSchema.nullable(),
    /** Exact joined text that produced the master. */
    text: z.string().refine((value) => value.trim().length > 0, 'Falta el texto de la narración.'),
    /** Deterministic fingerprint of the effective request (text + voice config). */
    fingerprint: Sha256Schema,
    /** SHA-256 of the master WAV — verified on load. */
    wavSha256: Sha256Schema,
    durationSeconds: z
      .number()
      .refine(
        (value) => Number.isFinite(value) && value > 0,
        'durationSeconds debe ser un número finito mayor que 0.',
      ),
    /** Gap-free coverage of `[0, durationSeconds]`, in scene order. */
    scenes: z.array(SceneTimingSchema).min(1, 'No hay timings de escenas.'),
    wav: z.string().min(1),
    generatedAt: IsoTimestampSchema,
  })
  .superRefine((value, ctx) => {
    let cursor = 0;
    value.scenes.forEach((scene, index) => {
      if (Math.abs(scene.startSeconds - cursor) > NARRATION_TIMING_TOLERANCE_SECONDS) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', index],
          message:
            `Las escenas deben encadenarse sin gaps ni solapes: ${scene.sceneId} inicia en ` +
            `${scene.startSeconds}s y el cursor va en ${cursor}s.`,
        });
      }
      cursor = scene.endSeconds;
    });
    if (Math.abs(cursor - value.durationSeconds) > NARRATION_TIMING_TOLERANCE_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        path: ['durationSeconds'],
        message:
          `Las escenas cubren ${cursor}s pero durationSeconds es ` +
          `${value.durationSeconds}s; metadata corrupta.`,
      });
    }
  });
export type ContinuousNarration = z.infer<typeof ContinuousNarrationSchema>;
