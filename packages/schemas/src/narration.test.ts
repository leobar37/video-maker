import { describe, expect, test } from 'bun:test';

import {
  ContinuousNarrationSchema,
  SceneTimingSchema,
  type ContinuousNarration,
  type SceneTiming,
} from './narration';

const sha = (char: string): string => char.repeat(64);

const narrationFixture: ContinuousNarration = {
  schemaVersion: 1,
  mode: 'continuous',
  provider: 'elevenlabs',
  voiceId: 'voice-demo',
  voiceName: 'Demo Voice',
  modelId: 'eleven_v3',
  language: 'es',
  voiceSettings: {
    stability: 0.7,
    similarity_boost: 0.5,
    style: 0,
    use_speaker_boost: true,
    speed: 1,
  },
  text: 'Primera escena.\n\nSegunda escena.',
  fingerprint: sha('d'),
  wavSha256: sha('e'),
  durationSeconds: 12.5,
  scenes: [
    { sceneId: 's1', startSeconds: 0, endSeconds: 7, durationSeconds: 7 },
    { sceneId: 's2', startSeconds: 7, endSeconds: 12.5, durationSeconds: 5.5 },
  ],
  wav: 'audio/narration.wav',
  generatedAt: '2026-09-24T18:05:10.131Z',
};

function roundTrip<T>(schema: { parse: (raw: unknown) => T }, value: unknown): T {
  return schema.parse(JSON.parse(JSON.stringify(value)));
}

function withScenes(scenes: SceneTiming[], durationSeconds = 12.5): ContinuousNarration {
  return { ...narrationFixture, scenes, durationSeconds };
}

describe('ContinuousNarrationSchema', () => {
  test('round-trips a gap-free continuous narration', () => {
    const parsed = roundTrip(ContinuousNarrationSchema, narrationFixture);
    expect(parsed).toEqual(narrationFixture);
  });

  test('accepts a source-era document without schemaVersion, defaulting to 1', () => {
    const { schemaVersion: _omitted, ...legacy } = narrationFixture;
    const parsed = ContinuousNarrationSchema.parse(legacy);
    expect(parsed.schemaVersion).toBe(1);
  });

  test('rejects gaps between consecutive scenes', () => {
    const parsed = ContinuousNarrationSchema.safeParse(
      withScenes([
        { sceneId: 's1', startSeconds: 0, endSeconds: 7, durationSeconds: 7 },
        { sceneId: 's2', startSeconds: 7.5, endSeconds: 12.5, durationSeconds: 5 },
      ]),
    );
    expect(parsed.success).toBe(false);
  });

  test('rejects overlaps between consecutive scenes', () => {
    const parsed = ContinuousNarrationSchema.safeParse(
      withScenes([
        { sceneId: 's1', startSeconds: 0, endSeconds: 7, durationSeconds: 7 },
        { sceneId: 's2', startSeconds: 6.5, endSeconds: 12.5, durationSeconds: 6 },
      ]),
    );
    expect(parsed.success).toBe(false);
  });

  test('rejects a chain that does not start at 0 or does not cover durationSeconds', () => {
    expect(
      ContinuousNarrationSchema.safeParse(
        withScenes([
          { sceneId: 's1', startSeconds: 0.5, endSeconds: 7, durationSeconds: 6.5 },
          { sceneId: 's2', startSeconds: 7, endSeconds: 12.5, durationSeconds: 5.5 },
        ]),
      ).success,
    ).toBe(false);
    expect(
      ContinuousNarrationSchema.safeParse(
        withScenes(
          [
            { sceneId: 's1', startSeconds: 0, endSeconds: 7, durationSeconds: 7 },
            { sceneId: 's2', startSeconds: 7, endSeconds: 12, durationSeconds: 5 },
          ],
          12.5,
        ),
      ).success,
    ).toBe(false);
  });

  test('rejects a segment whose durationSeconds is not endSeconds - startSeconds', () => {
    expect(
      ContinuousNarrationSchema.safeParse(
        withScenes([
          { sceneId: 's1', startSeconds: 0, endSeconds: 7, durationSeconds: 6 },
          { sceneId: 's2', startSeconds: 7, endSeconds: 12.5, durationSeconds: 5.5 },
        ]),
      ).success,
    ).toBe(false);
    expect(
      SceneTimingSchema.safeParse({ sceneId: 's1', startSeconds: 7, endSeconds: 7, durationSeconds: 0 })
        .success,
    ).toBe(false);
  });

  test('rejects malformed fingerprints and audio hashes', () => {
    expect(
      ContinuousNarrationSchema.safeParse({ ...narrationFixture, fingerprint: 'no-es-un-sha256' })
        .success,
    ).toBe(false);
    expect(
      ContinuousNarrationSchema.safeParse({ ...narrationFixture, wavSha256: sha('E') }).success,
    ).toBe(false);
    expect(
      ContinuousNarrationSchema.safeParse({ ...narrationFixture, wavSha256: undefined }).success,
    ).toBe(false);
  });

  test('rejects a bad schemaVersion, mode, empty scenes or invalid duration', () => {
    expect(
      ContinuousNarrationSchema.safeParse({ ...narrationFixture, schemaVersion: 2 }).success,
    ).toBe(false);
    expect(ContinuousNarrationSchema.safeParse({ ...narrationFixture, mode: 'per-scene' }).success).toBe(false);
    expect(ContinuousNarrationSchema.safeParse({ ...narrationFixture, scenes: [] }).success).toBe(false);
    expect(
      ContinuousNarrationSchema.safeParse({ ...narrationFixture, durationSeconds: 0 }).success,
    ).toBe(false);
    expect(
      ContinuousNarrationSchema.safeParse({ ...narrationFixture, generatedAt: 'nope' }).success,
    ).toBe(false);
    expect(ContinuousNarrationSchema.safeParse({ ...narrationFixture, text: '  ' }).success).toBe(false);
  });
});
