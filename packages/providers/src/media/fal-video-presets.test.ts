/**
 * fal-video-presets: documented snapshot pricing, budget routing and preset
 * integrity. Pricing assertions ported from the Elena Tech video pipeline
 * (videos/cli/fal-video.test.ts, first describe block).
 */
import { describe, expect, test } from 'bun:test';

import {
  FAL_HARD_STOP_USD,
  FAL_PRICING_SNAPSHOT_DATE,
  FAL_VIDEO_PRESETS,
  decideFalBudget,
  estimateFalVideoCost,
  getFalVideoPreset,
} from './fal-video-presets';

describe('fal video presets and budget routing', () => {
  test('estimates documented Standard and Pro 5s/10s snapshot prices', () => {
    const standard = getFalVideoPreset('kling-2.5-turbo-standard-i2v');
    const pro = getFalVideoPreset('kling-2.5-turbo-pro-i2v');
    expect(estimateFalVideoCost(standard, 5)).toBe(0.21);
    expect(estimateFalVideoCost(standard, 10)).toBe(0.42);
    expect(estimateFalVideoCost(pro, 5)).toBe(0.35);
    expect(estimateFalVideoCost(pro, 10)).toBe(0.7);
    expect(standard.tier).toBe('support');
    expect(pro.tier).toBe('hero');
    expect(pro.supportsTailImage).toBe(true);
    expect(FAL_PRICING_SNAPSHOT_DATE).toBe('2026-07-25');
  });

  test('estimates H3 Max 768P promo price and pins resolution input', () => {
    const h3max = getFalVideoPreset('minimax-h3-max-i2v');
    expect(estimateFalVideoCost(h3max, 5)).toBe(0.1);
    expect(h3max.tier).toBe('support');
    expect(h3max.defaultInput).toEqual({ resolution: '768P' });
  });

  test('refuses a projected request above the $10 hard stop', () => {
    const pro = getFalVideoPreset('kling-2.5-turbo-pro-i2v');
    const decision = decideFalBudget({
      preset: pro,
      duration: 5,
      priorAttemptCostsUsd: [9.8],
      sceneBudgetUsd: 20,
      hardStopUsd: FAL_HARD_STOP_USD,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.projectedSceneCostUsd).toBe(10.15);
    expect(decision.reason).toContain('$10.00');
  });

  test('refuses a request above the per-scene budget even under $10', () => {
    const standard = getFalVideoPreset('kling-2.5-turbo-standard-i2v');
    const decision = decideFalBudget({
      preset: standard,
      duration: 10,
      priorAttemptCostsUsd: [0.42],
      sceneBudgetUsd: 0.5,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('$0.50');
  });

  test('ids internos coinciden con su clave y cada preset declara pricing', () => {
    for (const [key, preset] of Object.entries(FAL_VIDEO_PRESETS)) {
      expect(preset.id).toBe(key);
      expect(preset.costPerSecondUsd).toBeGreaterThan(0);
      expect(preset.pricingUrl.startsWith('https://fal.ai/')).toBe(true);
      expect(preset.pricingSnapshotDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('desconocido falla listando los disponibles', () => {
    expect(() => getFalVideoPreset('no-existe')).toThrow(/no-existe/);
    expect(() => getFalVideoPreset('no-existe')).toThrow(/seedance-2.5-ref-exact/);
  });
});
