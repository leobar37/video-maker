/**
 * Continuous narration math: joined text ranges (code-point indexed),
 * gap-free scene timings from the character alignment, fingerprint drift and
 * schema-validated master metadata.
 */
import { describe, expect, test } from 'bun:test';

import type { TtsConfig } from '@videomaker/core';
import type { CharacterAlignment } from '@videomaker/providers';
import { ContinuousNarrationSchema } from '@videomaker/schemas';

import {
  SCENE_TEXT_SEPARATOR,
  buildContinuousNarrationMeta,
  deriveSceneTimings,
  joinSceneNarration,
  narrationFingerprint,
  parseCharacterAlignment,
} from './narration';

const TTS: TtsConfig = {
  provider: 'elevenlabs',
  mode: 'continuous',
  voiceId: 'voice-1',
  modelId: 'eleven_multilingual_v2',
};

function alignmentFor(text: string, secondsPerChar = 0.1): CharacterAlignment {
  const characters = Array.from(text);
  return {
    characters,
    character_start_times_seconds: characters.map((_, index) => index * secondsPerChar),
    character_end_times_seconds: characters.map((_, index) => index * secondsPerChar + 0.05),
  };
}

describe('joinSceneNarration', () => {
  test('records exact code-point ranges over the joined text', () => {
    const joined = joinSceneNarration([
      { id: 'a', narration: 'Hola 🎬 mundo.' },
      { id: 'b', narration: 'Segunda.' },
    ]);
    expect(joined.text).toBe(`Hola 🎬 mundo.${SCENE_TEXT_SEPARATOR}Segunda.`);
    expect(joined.ranges).toHaveLength(2);
    expect(joined.ranges[0]?.startChar).toBe(0);
    // Astral emoji counts as ONE code point (alignment indexing semantics).
    expect(joined.ranges[0]?.endChar).toBe(Array.from('Hola 🎬 mundo.').length);
    expect(joined.ranges[1]?.startChar).toBe(
      Array.from(`Hola 🎬 mundo.${SCENE_TEXT_SEPARATOR}`).length,
    );
    expect(joined.ranges[1]?.endChar).toBe(Array.from(joined.text).length);
    // Slice by code points, not UTF-16 units (the emoji is one char).
    expect(Array.from(joined.text).slice(joined.ranges[1]?.startChar).join('')).toBe('Segunda.');
  });

  test('rejects scenes without narration text', () => {
    expect(() => joinSceneNarration([{ id: 'a', narration: '   ' }])).toThrow(/no narration text/);
    expect(() => joinSceneNarration([])).toThrow(/no scenes/);
  });
});

describe('deriveSceneTimings', () => {
  test('chains scenes with zero gaps and zero overlaps', () => {
    const joined = joinSceneNarration([
      { id: 'a', narration: 'Uno dos.' },
      { id: 'b', narration: 'Tres cuatro.' },
      { id: 'c', narration: 'Cinco.' },
    ]);
    const timings = deriveSceneTimings(joined.ranges, alignmentFor(joined.text), 9);
    expect(timings.map((timing) => timing.sceneId)).toEqual(['a', 'b', 'c']);
    expect(timings[0]?.startSeconds).toBe(0);
    expect(timings[2]?.endSeconds).toBe(9);
    for (let index = 0; index + 1 < timings.length; index += 1) {
      expect(timings[index]?.endSeconds).toBe(timings[index + 1]?.startSeconds);
    }
    for (const timing of timings) {
      expect(timing.durationSeconds).toBeCloseTo(timing.endSeconds - timing.startSeconds, 10);
      expect(timing.durationSeconds).toBeGreaterThan(0);
    }
    // Boundaries come from the first spoken char of each scene's range.
    const boundaryB = (alignmentFor(joined.text).character_start_times_seconds[
      joined.ranges[1]?.startChar as number
    ] ?? 0) as number;
    expect(timings[1]?.startSeconds).toBe(boundaryB);
  });

  test('rejects a non-positive master duration', () => {
    const joined = joinSceneNarration([{ id: 'a', narration: 'Uno.' }]);
    expect(() => deriveSceneTimings(joined.ranges, alignmentFor(joined.text), 0)).toThrow(
      /Invalid narration master duration/,
    );
  });

  test('rejects alignments that do not produce visible scenes', () => {
    const joined = joinSceneNarration([
      { id: 'a', narration: 'Uno.' },
      { id: 'b', narration: 'Dos.' },
    ]);
    // Every character starts at 0: the second scene would get zero duration.
    const characters = Array.from(joined.text);
    const alignment: CharacterAlignment = {
      characters,
      character_start_times_seconds: characters.map(() => 0),
      character_end_times_seconds: characters.map(() => 0.05),
    };
    expect(() => deriveSceneTimings(joined.ranges, alignment, 3)).toThrow(/not monotonic/);
  });
});

describe('narrationFingerprint', () => {
  test('is stable for the same effective request and drifts on any change', () => {
    const joined = joinSceneNarration([{ id: 'a', narration: 'Texto fijo.' }]);
    const base = narrationFingerprint(TTS, joined.text);
    expect(narrationFingerprint({ ...TTS }, joined.text)).toBe(base);
    expect(narrationFingerprint(TTS, `${joined.text} editado.`)).not.toBe(base);
    expect(narrationFingerprint({ ...TTS, voiceId: 'voice-2' }, joined.text)).not.toBe(base);
    expect(
      narrationFingerprint({ ...TTS, voiceSettings: { stability: 0.9 } }, joined.text),
    ).not.toBe(base);
    expect(base).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('buildContinuousNarrationMeta', () => {
  test('produces schema-valid, gap/overlap-free metadata pinned by hash', () => {
    const joined = joinSceneNarration([
      { id: 'a', narration: 'Primera escena.' },
      { id: 'b', narration: 'Segunda escena.' },
    ]);
    const meta = buildContinuousNarrationMeta({
      tts: TTS,
      joined,
      alignment: alignmentFor(joined.text),
      masterDurationSeconds: 6,
      wavSha256: 'a'.repeat(64),
      wav: 'script/audio/narration.wav',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(meta.mode).toBe('continuous');
    expect(meta.fingerprint).toBe(narrationFingerprint(TTS, joined.text));
    expect(meta.wavSha256).toBe('a'.repeat(64));
    expect(meta.scenes).toHaveLength(2);
    expect(meta.scenes[0]?.startSeconds).toBe(0);
    expect(meta.scenes[1]?.endSeconds).toBe(6);
    expect(meta.scenes[0]?.endSeconds).toBe(meta.scenes[1]?.startSeconds);
  });

  test('corrupted timings cannot masquerade as valid metadata', () => {
    const joined = joinSceneNarration([
      { id: 'a', narration: 'Primera escena.' },
      { id: 'b', narration: 'Segunda escena.' },
    ]);
    const meta = buildContinuousNarrationMeta({
      tts: TTS,
      joined,
      alignment: alignmentFor(joined.text),
      masterDurationSeconds: 6,
      wavSha256: 'a'.repeat(64),
      wav: 'script/audio/narration.wav',
      generatedAt: '2026-01-01T00:00:00.000Z',
    });
    // Hand-edit a boundary (kept internally consistent): the continuity check
    // must still reject the resulting gap.
    const corrupted = structuredClone(meta);
    const shifted = corrupted.scenes[1]!;
    corrupted.scenes[1] = {
      ...shifted,
      startSeconds: shifted.startSeconds + 1,
      endSeconds: shifted.endSeconds + 1,
    };
    expect(() => ContinuousNarrationSchema.parse(corrupted)).toThrow(/sin gaps ni solapes/);
  });
});

describe('parseCharacterAlignment', () => {
  test('narrows the provider payload and rejects malformed arrays', () => {
    const alignment = parseCharacterAlignment({
      characters: ['a', 'b'],
      character_start_times_seconds: [0, 0.1],
      character_end_times_seconds: [0.05, 0.15],
    });
    expect(alignment.characters).toEqual(['a', 'b']);
    expect(() => parseCharacterAlignment({ characters: 'ab' })).toThrow(/malformed/);
    expect(() => parseCharacterAlignment(undefined)).toThrow(/no character alignment/);
  });
});
