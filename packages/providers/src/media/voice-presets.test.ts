/**
 * voice-presets: registry integrity, calibration fidelity and asset hygiene.
 * Ported from the Elena Tech video pipeline (videos/cli/voice-presets.test.ts).
 */
import { describe, expect, test } from 'bun:test';

import {
  VOICE_PRESETS,
  VOICE_PRESET_IDS,
  resolveVoicePreset,
  type MinimaxFalVoicePreset,
  type VoiceAssetRef,
} from './voice-presets';

describe('resolveVoicePreset', () => {
  test('resuelve memo-v3 intacto (calibración 2026-09-18)', () => {
    const memo = resolveVoicePreset('memo-v3');
    expect(memo.provider).toBe('elevenlabs');
    expect(memo.modelId).toBe('eleven_v3');
    expect(memo.voiceId).toBe('FTFn0f40lQFQlsDC71tR');
    expect(memo.voiceSettings).toEqual({
      stability: 0.7,
      similarity_boost: 0.5,
      style: 0,
      use_speaker_boost: true,
      speed: 1.0,
    });
  });

  test('acepta las tres estrategias del bake-off', () => {
    expect(resolveVoicePreset('memo-v3').provider).toBe('elevenlabs');
    expect(resolveVoicePreset('memo-minimax-clone').provider).toBe('minimax-fal');
    expect(resolveVoicePreset('lively-girl').provider).toBe('fal-preset');
  });

  test('falla con la lista de conocidos', () => {
    expect(() => resolveVoicePreset('desconocida')).toThrow(/desconocida/);
    expect(() => resolveVoicePreset('desconocida')).toThrow(/memo-v3/);
  });
});

describe('presets', () => {
  test('todo preset registra estrategia de preservación y nota', () => {
    for (const id of VOICE_PRESET_IDS) {
      const preset = resolveVoicePreset(id);
      expect(preset.preservation.trim().length).toBeGreaterThan(20);
      expect(preset.note.trim().length).toBeGreaterThan(20);
    }
  });

  test('el clon de MiniMax declara su origen y su caché efímera', () => {
    const clone = resolveVoicePreset('memo-minimax-clone') as MinimaxFalVoicePreset;
    expect(clone.cloneOf).toBe('memo-v3');
    expect(clone.customVoiceId).toBeUndefined();
    expect(clone.preservation).toContain('voice-clone');
    expect(clone.calibration).toEqual({
      speed: 1.1,
      pitch: 0,
      vol: 1,
      languageBoost: 'Spanish',
    });
  });

  test('fal-preset declara su voz de sistema', () => {
    const lively = resolveVoicePreset('lively-girl');
    expect(lively.provider).toBe('fal-preset');
    expect(lively.voiceId).toBe('Lively_Girl');
  });

  test('los activos de audio son URLs https de R2 — nunca rutas del repo', () => {
    const refs: VoiceAssetRef[] = [];
    for (const id of VOICE_PRESET_IDS) {
      const preset = resolveVoicePreset(id);
      if (preset.assets.reference) refs.push(preset.assets.reference);
      refs.push(...preset.assets.auditions);
    }
    for (const ref of refs) {
      expect(ref.url.startsWith('https://')).toBe(true);
      expect(ref.url).not.toContain('file://');
      expect(ref.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  test('el registro es coherente: ids internos coinciden con su clave', () => {
    for (const [key, preset] of Object.entries(VOICE_PRESETS)) {
      expect(preset.id).toBe(key);
    }
  });
});
