/**
 * keyframe-models: registry integrity and micro-USD cost reservation.
 * Cost rules ported from the Elena Tech video pipeline
 * (videos/cli/lib/keyframe-generation.ts + gen-keyframe.test.ts).
 */
import { describe, expect, test } from 'bun:test';

import {
  KEYFRAME_MODELS,
  getKeyframeModel,
  isDimensionPricedModel,
  keyframeAttemptCostMicros,
  microsToUsd,
  usdToMicros,
} from './keyframe-models';

describe('keyframe models', () => {
  test('nano-banana-pro cuesta plano por imagen', () => {
    const model = getKeyframeModel('fal-ai/nano-banana-pro');
    expect(isDimensionPricedModel(model)).toBe(false);
    expect(keyframeAttemptCostMicros(model)).toBe(usdToMicros(0.15));
  });

  test('flux/schnell se cobra por dimensiones con redondeo hacia arriba', () => {
    const model = getKeyframeModel('fal-ai/flux/schnell');
    expect(isDimensionPricedModel(model)).toBe(true);
    // 3000 micros/MP * (1024*608)px / 1e6 = ceil(1867.776) = 1868 micros.
    expect(keyframeAttemptCostMicros(model, { width: 1024, height: 608 })).toBe(1868);
    // Fracción sub-micro: ceil, nunca floor (la reserva no queda corta).
    expect(keyframeAttemptCostMicros(model, { width: 1000, height: 1000 })).toBe(3000);
    expect(microsToUsd(1875)).toBeCloseTo(0.001875, 9);
  });

  test('dimensiones faltantes en modelo por dimensiones es error de capability', () => {
    const model = getKeyframeModel('fal-ai/flux/schnell');
    expect(() => keyframeAttemptCostMicros(model)).toThrow(/--width y --height/);
  });

  test('modelo no registrado falla listando los conocidos', () => {
    expect(() => getKeyframeModel('fal-ai/no-existe')).toThrow(/no-existe/);
    expect(() => getKeyframeModel('fal-ai/no-existe')).toThrow(/nano-banana-pro\/edit/);
  });

  test('los ids internos coinciden con su clave', () => {
    for (const [key, model] of Object.entries(KEYFRAME_MODELS)) {
      expect(model.id).toBe(key);
    }
  });
});
