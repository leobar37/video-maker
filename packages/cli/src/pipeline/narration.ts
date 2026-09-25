/**
 * Continuous narration helpers (PURE): the whole video's voice is synthesized
 * in ONE request so it stays acoustically identical across scene cuts. These
 * helpers join the per-scene texts, derive gap-free scene timings from the
 * provider's character alignment (a scene ends exactly where the next one's
 * first spoken character starts), fingerprint the effective synthesis request
 * and assemble the tracked `narration.json` metadata (`ContinuousNarration`).
 *
 * Character indices are CODE-POINT offsets (`Array.from` semantics), matching
 * the provider's per-character alignment arrays. No fs, no network, no
 * secrets — tests exercise the math directly.
 */
import { sha256Json, type TtsConfig } from '@videomaker/core';
import {
  TTS_OUTPUT_FORMAT,
  effectiveVoiceSettings,
  type CharacterAlignment,
} from '@videomaker/providers';
import {
  ContinuousNarrationSchema,
  type ContinuousNarration,
  type SceneTiming,
  type VoiceSettings,
} from '@videomaker/schemas';

/** Separator inserted between scenes in the joined text (a short natural pause). */
export const SCENE_TEXT_SEPARATOR = '\n\n';

/** One scene's narration text, in approved order. */
export interface SceneNarrationInput {
  id: string;
  narration: string;
}

/** [startChar, endChar) code-point range of one scene inside the joined text. */
export interface SceneCharRange {
  sceneId: string;
  startChar: number;
  endChar: number;
}

export interface JoinedNarration {
  text: string;
  ranges: SceneCharRange[];
}

/**
 * Concatenates the narration of the given scenes and records each scene's
 * exact character range. Throws when a scene has no narration — continuous
 * mode narrates every scene it covers.
 */
export function joinSceneNarration(scenes: readonly SceneNarrationInput[]): JoinedNarration {
  if (scenes.length === 0) {
    throw new Error('Continuous narration has no scenes to narrate.');
  }
  const ranges: SceneCharRange[] = [];
  let text = '';
  for (const scene of scenes) {
    const narration = scene.narration.trim();
    if (narration.length === 0) {
      throw new Error(
        `Continuous narration: scene "${scene.id}" has no narration text. ` +
          'Every narrated scene needs text in video.json.',
      );
    }
    if (ranges.length > 0) text += SCENE_TEXT_SEPARATOR;
    const startChar = Array.from(text).length;
    text += narration;
    ranges.push({ sceneId: scene.id, startChar, endChar: Array.from(text).length });
  }
  return { text, ranges };
}

/** Narrows the provider's `artifact.extra.alignment` payload. */
export function parseCharacterAlignment(value: unknown): CharacterAlignment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Provider artifact carries no character alignment.');
  }
  const record = value as Record<string, unknown>;
  const { characters, character_start_times_seconds, character_end_times_seconds } = record;
  if (
    !Array.isArray(characters) ||
    !Array.isArray(character_start_times_seconds) ||
    !Array.isArray(character_end_times_seconds) ||
    characters.some((entry) => typeof entry !== 'string') ||
    character_start_times_seconds.some((entry) => typeof entry !== 'number') ||
    character_end_times_seconds.some((entry) => typeof entry !== 'number')
  ) {
    throw new Error('Provider character alignment is malformed (expected string/number arrays).');
  }
  return {
    characters: characters as string[],
    character_start_times_seconds: character_start_times_seconds as number[],
    character_end_times_seconds: character_end_times_seconds as number[],
  };
}

function firstSpokenChar(alignment: CharacterAlignment, range: SceneCharRange): number {
  for (let i = range.startChar; i < range.endChar; i += 1) {
    if (!/\s/.test(alignment.characters[i] ?? '')) return i;
  }
  throw new Error(`Scene "${range.sceneId}" has no spoken characters in its text range.`);
}

/**
 * Derives gap-free scene boundaries: scene i starts at its first spoken
 * character's timestamp (the first scene starts at 0) and ends exactly where
 * the NEXT scene's first spoken character begins; the last scene ends at the
 * master duration. Timings chain exactly — no gaps, no overlaps — so
 * `ContinuousNarrationSchema` accepts the metadata and the renderer never
 * drifts against the voice.
 */
export function deriveSceneTimings(
  ranges: readonly SceneCharRange[],
  alignment: CharacterAlignment,
  masterDurationSeconds: number,
): SceneTiming[] {
  if (!Number.isFinite(masterDurationSeconds) || masterDurationSeconds <= 0) {
    throw new Error(`Invalid narration master duration (${masterDurationSeconds}s).`);
  }
  const lastRange = ranges[ranges.length - 1];
  if (
    lastRange === undefined ||
    alignment.characters.length < lastRange.endChar ||
    alignment.character_start_times_seconds.length !== alignment.characters.length ||
    alignment.character_end_times_seconds.length !== alignment.characters.length
  ) {
    throw new Error(
      `Provider alignment covers ${alignment.characters.length} characters but the joined ` +
        `text needs ${lastRange?.endChar ?? 0}; the timestamps cannot derive scene timings.`,
    );
  }
  const boundaries = ranges.map((range) => {
    const charIndex = firstSpokenChar(alignment, range);
    return alignment.character_start_times_seconds[charIndex] as number;
  });
  return ranges.map((range, index) => {
    const startSeconds = index === 0 ? 0 : (boundaries[index] as number);
    const endSeconds =
      index === ranges.length - 1 ? masterDurationSeconds : (boundaries[index + 1] as number);
    const durationSeconds = endSeconds - startSeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(
        `Scene "${range.sceneId}" gets ${String(durationSeconds)}s from the alignment ` +
          `(${String(startSeconds)}→${String(endSeconds)}); the timestamps are not ` +
          'monotonic across scenes.',
      );
    }
    return { sceneId: range.sceneId, startSeconds, endSeconds, durationSeconds };
  });
}

/** Effective voice settings in the schema's JSON-safe shape (undefined keys dropped). */
function schemaVoiceSettings(tts: TtsConfig): VoiceSettings {
  const effective = effectiveVoiceSettings({ ...(tts.voiceSettings ?? {}) });
  const settings: VoiceSettings = {};
  for (const key of ['stability', 'similarity_boost', 'style', 'speed'] as const) {
    const value = effective[key];
    if (typeof value === 'number') settings[key] = value;
  }
  if (typeof effective.use_speaker_boost === 'boolean') {
    settings.use_speaker_boost = effective.use_speaker_boost;
  }
  return settings;
}

/**
 * Deterministic fingerprint of the EFFECTIVE synthesis request (output format,
 * model, language, voice, effective voice settings and the exact joined text).
 * The API key is never part of it: any drift (voice change, settings change,
 * script edit, scene reorder) changes the hash and marks the master stale.
 */
export function narrationFingerprint(tts: TtsConfig, joinedText: string): string {
  return sha256Json({
    outputFormat: TTS_OUTPUT_FORMAT,
    modelId: tts.modelId,
    language: tts.language ?? null,
    voiceId: tts.voiceId,
    pronunciationDictionaryId: tts.pronunciationDictionaryId ?? null,
    voiceSettings: schemaVoiceSettings(tts),
    text: joinedText,
  });
}

export interface ContinuousNarrationInput {
  tts: TtsConfig;
  joined: JoinedNarration;
  alignment: CharacterAlignment;
  /** Real duration of the master WAV in seconds (probed from the media). */
  masterDurationSeconds: number;
  /** SHA-256 of the master WAV. */
  wavSha256: string;
  /** Project-relative path of the master WAV (e.g. `script/audio/narration.wav`). */
  wav: string;
  generatedAt: string;
  /** Provider id; defaults to the configured `tts.provider`. */
  provider?: string;
}

/**
 * Builds the tracked master metadata and validates it against
 * `ContinuousNarrationSchema` — gap/overlap-free timings, fingerprint and
 * sha256 pinned, so corrupted metadata can never reach the renderer.
 */
export function buildContinuousNarrationMeta(
  input: ContinuousNarrationInput,
): ContinuousNarration {
  const { tts, joined } = input;
  const settings = schemaVoiceSettings(tts);
  return ContinuousNarrationSchema.parse({
    schemaVersion: 1,
    mode: 'continuous',
    provider: input.provider ?? tts.provider,
    voiceId: tts.voiceId,
    voiceName: tts.voiceName ?? null,
    modelId: tts.modelId,
    language: tts.language ?? null,
    voiceSettings: Object.keys(settings).length > 0 ? settings : null,
    text: joined.text,
    fingerprint: narrationFingerprint(tts, joined.text),
    wavSha256: input.wavSha256,
    durationSeconds: input.masterDurationSeconds,
    scenes: deriveSceneTimings(joined.ranges, input.alignment, input.masterDurationSeconds),
    wav: input.wav,
    generatedAt: input.generatedAt,
  });
}
