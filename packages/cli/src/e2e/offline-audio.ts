/**
 * Offline audio synthesis (pure, deterministic): a speech-like narration take
 * with per-character timestamps and a soft music bed, both rendered to PCM
 * WAV without network, providers or ffmpeg. The character timeline feeds the
 * SAME gap-free timing derivation the live TTS path uses
 * (`deriveSceneTimings`), so offline and live narration metadata share one
 * contract and the renderer cannot tell them apart.
 */
import type { CharacterAlignment } from '@videomaker/providers';

import { encodePcm16Wav } from './wav';

/** Synth constants (kept explicit: tests assert timings against these). */
export const SYNTH = {
  /** Seconds of tone per spoken character (~29 chars/s: fast demo pacing). */
  charSeconds: 0.034,
  /** Seconds per whitespace character (scene separators become short pauses). */
  spaceSeconds: 0.06,
  /** Silence appended after the last spoken character. */
  tailSeconds: 0.4,
  narrationSampleRate: 44_100,
  bedSampleRate: 22_050,
} as const;

/** Per-character time spans over the joined narration text. */
export interface NarrationTimeline {
  /** Code points of the joined text (`Array.from` semantics). */
  chars: string[];
  startSeconds: number[];
  endSeconds: number[];
  /** End of the master audio (last char end + tail). */
  masterDurationSeconds: number;
}

/**
 * Walks the joined text assigning every code point a contiguous time span:
 * spoken characters take `charSeconds`, whitespace `spaceSeconds`. The result
 * is monotonic and gap-free, so scene boundaries derived from the first
 * spoken character of each scene chain exactly.
 */
export function planNarrationTimeline(text: string): NarrationTimeline {
  const chars = Array.from(text);
  if (chars.length === 0) {
    throw new Error('planNarrationTimeline: the joined narration text is empty.');
  }
  const startSeconds: number[] = [];
  const endSeconds: number[] = [];
  let cursor = 0;
  for (const char of chars) {
    const duration = /\s/.test(char) ? SYNTH.spaceSeconds : SYNTH.charSeconds;
    startSeconds.push(cursor);
    cursor += duration;
    endSeconds.push(cursor);
  }
  return {
    chars,
    startSeconds,
    endSeconds,
    masterDurationSeconds: cursor + SYNTH.tailSeconds,
  };
}

/** The provider-style character alignment payload the live path receives. */
export function timelineAlignment(timeline: NarrationTimeline): CharacterAlignment {
  return {
    characters: [...timeline.chars],
    character_start_times_seconds: [...timeline.startSeconds],
    character_end_times_seconds: [...timeline.endSeconds],
  };
}

const clampSample = (value: number): number => Math.max(-1, Math.min(1, value));

/**
 * Speech-like take: one damped two-harmonic tone burst per spoken character
 * (deterministic per index) and silence over whitespace. It is not real
 * speech — it is a locally synthesized stand-in that exercises the exact same
 * narration contract (timings, hashing, ducking, loudnorm) with $0 spend.
 */
export function synthesizeNarrationWav(timeline: NarrationTimeline): Uint8Array {
  const sampleRate = SYNTH.narrationSampleRate;
  const totalSamples = Math.ceil(timeline.masterDurationSeconds * sampleRate);
  const samples = new Int16Array(totalSamples);
  timeline.chars.forEach((char, index) => {
    if (/\s/.test(char)) return;
    const start = timeline.startSeconds[index] as number;
    const end = timeline.endSeconds[index] as number;
    const from = Math.floor(start * sampleRate);
    const to = Math.min(totalSamples, Math.ceil(end * sampleRate));
    const length = Math.max(1, to - from);
    const frequency = 150 + ((index * 53) % 45);
    for (let i = 0; i < length; i += 1) {
      const t = i / sampleRate;
      // Attack/release envelope avoids clicks between character bursts.
      const envelope = Math.min(1, i / (0.004 * sampleRate), (length - i) / (0.006 * sampleRate));
      const fundamental = Math.sin(2 * Math.PI * frequency * t);
      const harmonic = 0.3 * Math.sin(2 * Math.PI * frequency * 2 * t);
      const value = 0.26 * envelope * (fundamental + harmonic);
      const at = from + i;
      if (at < totalSamples) {
        samples[at] = Math.round(clampSample(value) * 32767);
      }
    }
  });
  return encodePcm16Wav(samples, { sampleRate, channels: 1 });
}

/**
 * Soft music bed: a slow F-major pad with a gentle tremolo, long enough to
 * sit under any demo cut (the ducking stage trims/loops it to the film).
 */
export function synthesizeMusicBedWav(options: { durationSeconds?: number } = {}): Uint8Array {
  const sampleRate = SYNTH.bedSampleRate;
  const durationSeconds = options.durationSeconds ?? 24;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`synthesizeMusicBedWav: invalid durationSeconds ${durationSeconds}.`);
  }
  const totalSamples = Math.ceil(durationSeconds * sampleRate);
  const samples = new Int16Array(totalSamples);
  const partials = [174.61, 261.63, 349.23, 440.0];
  for (let i = 0; i < totalSamples; i += 1) {
    const t = i / sampleRate;
    const tremolo = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.15 * t);
    let value = 0;
    for (const frequency of partials) {
      value += Math.sin(2 * Math.PI * frequency * t);
    }
    value *= (0.2 / partials.length) * tremolo;
    samples[i] = Math.round(clampSample(value) * 32767);
  }
  return encodePcm16Wav(samples, { sampleRate, channels: 1 });
}
