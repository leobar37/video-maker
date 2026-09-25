/**
 * Offline narration master: writes `script/audio/narration.wav` +
 * `script/audio/narration.json` exactly like `runGenAudio` does, but from the
 * local synth (no providers, no credentials, $0). The metadata is built with
 * the SAME pipeline helpers (`joinSceneNarration` → `deriveSceneTimings` via
 * `buildContinuousNarrationMeta`), so gap-free timings, the request
 * fingerprint and the wav sha256 follow the live contract byte-for-byte.
 *
 * The meta's `provider` is `offline-synth`: a replay guard so a later live run
 * never mistakes the local synth for a real TTS master (and vice versa).
 */
import { readFile, writeFile } from 'node:fs/promises';

import { resolveInsideProject, sha256File, type TtsConfig } from '@videomaker/core';
import type { ContinuousNarration } from '@videomaker/schemas';

import {
  NARRATION_META_RELATIVE,
  NARRATION_WAV_RELATIVE,
} from '../pipeline/generate';
import { writeJsonArtifact } from '../pipeline/evidence';
import {
  buildContinuousNarrationMeta,
  joinSceneNarration,
  narrationFingerprint,
  type SceneNarrationInput,
} from '../pipeline/narration';

import {
  planNarrationTimeline,
  synthesizeNarrationWav,
  timelineAlignment,
} from './offline-audio';

/** `narration.json#provider` marker of locally synthesized masters. */
export const OFFLINE_PROVIDER_ID = 'offline-synth';

/** True when a narration meta was produced by the offline synth. */
export function isOfflineNarrationMeta(meta: ContinuousNarration | undefined): boolean {
  return meta?.provider?.startsWith('offline') === true;
}

/**
 * Existing master whose fingerprint matches the effective request and whose
 * wav still hashes to the recorded `wavSha256`; `undefined` otherwise (the
 * caller decides whether an offline meta may be replayed).
 */
export async function findNarrationMaster(
  projectDir: string,
  fingerprint: string,
): Promise<ContinuousNarration | undefined> {
  let meta: ContinuousNarration;
  try {
    meta = JSON.parse(await readFile(await resolveInsideProject(projectDir, NARRATION_META_RELATIVE), 'utf8')) as ContinuousNarration;
  } catch {
    return undefined;
  }
  if (meta?.fingerprint !== fingerprint) return undefined;
  try {
    const wavSha256 = await sha256File(await resolveInsideProject(projectDir, NARRATION_WAV_RELATIVE));
    if (wavSha256 !== meta.wavSha256) return undefined;
  } catch {
    return undefined;
  }
  return meta;
}

export interface OfflineNarrationOptions {
  projectDir: string;
  tts: TtsConfig;
  /** Active scenes with narration text, in render order. */
  scenes: readonly SceneNarrationInput[];
  now: () => Date;
  out: (line: string) => void;
  /** Resynthesize even when a verified offline master exists. */
  force?: boolean;
}

export interface OfflineNarrationResult {
  wav: string;
  meta: string;
  narration: ContinuousNarration;
  /** True when an existing verified offline master was reused (no write). */
  replayed: boolean;
}

/**
 * Synthesizes (or replays) the offline narration master. Idempotent: a rerun
 * with the same script reuses the verified wav+meta pair and writes nothing.
 */
export async function writeOfflineNarrationMaster(
  options: OfflineNarrationOptions,
): Promise<OfflineNarrationResult> {
  const { projectDir, tts, scenes } = options;
  const joined = joinSceneNarration(scenes);
  const fingerprint = narrationFingerprint(tts, joined.text);

  if (options.force !== true) {
    const existing = await findNarrationMaster(projectDir, fingerprint);
    if (existing && isOfflineNarrationMeta(existing)) {
      options.out(
        `gen-audio (offline): verified synth master reused (fingerprint ${fingerprint.slice(0, 12)}…); $0.`,
      );
      return {
        wav: NARRATION_WAV_RELATIVE,
        meta: NARRATION_META_RELATIVE,
        narration: existing,
        replayed: true,
      };
    }
  }

  const timeline = planNarrationTimeline(joined.text);
  const wavPath = await resolveInsideProject(projectDir, NARRATION_WAV_RELATIVE);
  await writeFile(wavPath, synthesizeNarrationWav(timeline));
  const narration = buildContinuousNarrationMeta({
    tts,
    joined,
    alignment: timelineAlignment(timeline),
    masterDurationSeconds: timeline.masterDurationSeconds,
    wavSha256: await sha256File(wavPath),
    wav: NARRATION_WAV_RELATIVE,
    generatedAt: options.now().toISOString(),
    provider: OFFLINE_PROVIDER_ID,
  });
  await writeJsonArtifact(
    await resolveInsideProject(projectDir, NARRATION_META_RELATIVE),
    narration,
  );
  options.out(
    `gen-audio (offline): synth master ${narration.durationSeconds.toFixed(2)}s across ` +
      `${narration.scenes.length} scene(s) → ${NARRATION_WAV_RELATIVE}; provider ${OFFLINE_PROVIDER_ID}.`,
  );
  return {
    wav: NARRATION_WAV_RELATIVE,
    meta: NARRATION_META_RELATIVE,
    narration,
    replayed: false,
  };
}
