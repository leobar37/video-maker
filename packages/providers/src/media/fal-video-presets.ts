/**
 * Presets de motores image-to-video en fal.ai + ruteo de presupuesto.
 *
 * Los precios son snapshots del pricing del proveedor (ver fecha por preset),
 * no garantías atemporales. Revisar la página oficial del endpoint en fal.ai
 * antes de enviar.
 */

import { MediaProviderError } from './common';

export type FalQualityTier = 'support' | 'hero';
export type FalVideoDuration = 4 | 5 | 6 | 8 | 10;

export const FAL_PRICING_SNAPSHOT_DATE = '2026-07-25';
export const FAL_PRICING_URL =
  'https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/standard/image-to-video';
export const FAL_HARD_STOP_USD = 10;

export interface FalVideoPreset {
  id: string;
  provider: 'fal';
  modelId: string;
  endpoint: string;
  tier: FalQualityTier;
  supportedDurations: readonly FalVideoDuration[];
  supportsTailImage: boolean;
  costPerSecondUsd: number;
  pricingSnapshotDate: string;
  pricingUrl: string;
  /**
   * Extra input fields merged into the fal submit payload (e.g. resolution).
   * Lets a preset pin the cost-bearing options the snapshot price assumes.
   */
  defaultInput?: Record<string, string | boolean | number>;
  /**
   * Reference-image support (character/style consistency). When set, scenes
   * may declare `characterRefs`, resolved to `referenceInputField` URLs.
   */
  referenceInputField?: string;
  /**
   * Payload field for the first-frame keyframe. Defaults to `image_url`.
   * Set to `null` when the model has no first-frame pin (Seedance): the
   * initial keyframe is prepended to the references instead (with
   * `prependInitialImageToRefs`).
   */
  firstFrameInputField?: string | null;
  /** Prepend the uploaded initial keyframe to the reference URLs. */
  prependInitialImageToRefs?: boolean;
  /** Wire format for `duration`: seconds (default) or Veo-style "8s". */
  durationFormat?: 'seconds' | 'suffixed';
  /**
   * Token billing on top of the per-second price (Seedance-style): USD per
   * 1000 tokens at the preset's default resolution, or 0 when the model
   * charges per second only.
   */
  costTokensPerSecondUsd?: number;
}

const STANDARD_MODEL = 'fal-ai/kling-video/v2.5-turbo/standard/image-to-video';
const PRO_MODEL = 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video';
const H3_MAX_MODEL = 'minimax/h3-max/image-to-video';
const SEEDANCE_REF_MODEL = 'bytedance/seedance-2.5/reference-to-video';
const VEO31_FAST_I2V = 'fal-ai/veo3.1/fast/image-to-video';

export const FAL_VIDEO_PRESETS: Readonly<Record<string, FalVideoPreset>> = {
  'kling-2.5-turbo-standard-i2v': {
    id: 'kling-2.5-turbo-standard-i2v',
    provider: 'fal',
    modelId: STANDARD_MODEL,
    endpoint: `https://queue.fal.run/${STANDARD_MODEL}`,
    tier: 'support',
    supportedDurations: [5, 10],
    supportsTailImage: false,
    costPerSecondUsd: 0.042,
    pricingSnapshotDate: FAL_PRICING_SNAPSHOT_DATE,
    pricingUrl: FAL_PRICING_URL,
  },
  'kling-2.5-turbo-pro-i2v': {
    id: 'kling-2.5-turbo-pro-i2v',
    provider: 'fal',
    modelId: PRO_MODEL,
    endpoint: `https://queue.fal.run/${PRO_MODEL}`,
    tier: 'hero',
    supportedDurations: [5, 10],
    supportsTailImage: true,
    costPerSecondUsd: 0.07,
    pricingSnapshotDate: FAL_PRICING_SNAPSHOT_DATE,
    pricingUrl: 'https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video',
  },
  'minimax-h3-max-i2v': {
    id: 'minimax-h3-max-i2v',
    provider: 'fal',
    modelId: H3_MAX_MODEL,
    endpoint: `https://queue.fal.run/${H3_MAX_MODEL}`,
    tier: 'support',
    supportedDurations: [5, 10],
    supportsTailImage: false,
    // Snapshot 2026-09-08 (fal.ai/models/minimax/h3-max/image-to-video):
    // 768P promo $0.02/s vigente hasta 2026-09-14, luego tarifa regular.
    costPerSecondUsd: 0.02,
    pricingSnapshotDate: '2026-09-08',
    pricingUrl: 'https://fal.ai/models/minimax/h3-max/image-to-video',
    defaultInput: { resolution: '768P' },
  },
  'seedance-2.5-ref-exact': {
    id: 'seedance-2.5-ref-exact',
    provider: 'fal',
    modelId: SEEDANCE_REF_MODEL,
    endpoint: `https://queue.fal.run/${SEEDANCE_REF_MODEL}`,
    tier: 'hero',
    supportedDurations: [5, 10],
    supportsTailImage: false,
    referenceInputField: 'image_urls',
    firstFrameInputField: null,
    prependInitialImageToRefs: true,
    // Snapshot 2026-09-10 (fal.ai/models/bytedance/seedance-2.5/reference-to-video):
    // 480p $0.2205/s + ~$0.0214/1k tokens. Tokens ~= H*W*dur*24/1024, so at
    // 480x854 portrait ~= 9600 tokens/s ~= $0.21/s. Blended ~= $0.43/s:
    // 5s ~= $2.13, 10s ~= $4.26. 720p would ~double it (10s ~= $9.35, almost
    // the $10 hard stop) — raise resolution per scene only with budget approval.
    // generate_audio: true — acted scenes carry native dialogue with lip-sync
    // (the actor voices come from the model itself; an ElevenLabs overlay would
    // never match the lips). Same price either way. The narrator (voice-over
    // on demo/motion scenes) stays ElevenLabs.
    costPerSecondUsd: 0.2205,
    costTokensPerSecondUsd: 0.21,
    pricingSnapshotDate: '2026-09-10',
    pricingUrl: 'https://fal.ai/models/bytedance/seedance-2.5/reference-to-video',
    defaultInput: { resolution: '480p', aspect_ratio: '9:16', generate_audio: true },
  },
  'veo3.1-fast-i2v': {
    id: 'veo3.1-fast-i2v',
    provider: 'fal',
    modelId: VEO31_FAST_I2V,
    endpoint: `https://queue.fal.run/${VEO31_FAST_I2V}`,
    tier: 'hero',
    supportedDurations: [4, 6, 8],
    supportsTailImage: false,
    firstFrameInputField: 'image_url',
    durationFormat: 'suffixed',
    // Snapshot 2026-09-11 (fal.ai/models/fal-ai/veo3.1/fast/image-to-video):
    // generate_audio: true — diálogo nativo con lip-sync; la voz del actor la
    // genera el modelo (español rioplatense/neutro configurable en prompt).
    costPerSecondUsd: 0.15,
    pricingSnapshotDate: '2026-09-11',
    pricingUrl: 'https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video',
    defaultInput: {
      resolution: '720p',
      aspect_ratio: '9:16',
      generate_audio: true,
      auto_fix: true,
    },
  },
};

export function getFalVideoPreset(id: string): FalVideoPreset {
  const preset = FAL_VIDEO_PRESETS[id];
  if (!preset) {
    throw new MediaProviderError(
      'UNSUPPORTED_CAPABILITY',
      `Preset fal-video desconocido "${id}". Disponibles: ${Object.keys(FAL_VIDEO_PRESETS).join(', ')}.`,
    );
  }
  return preset;
}

export function estimateFalVideoCost(preset: FalVideoPreset, duration: number): number {
  const perSecond = preset.costPerSecondUsd + (preset.costTokensPerSecondUsd ?? 0);
  return Number((perSecond * duration).toFixed(2));
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export interface FalBudgetDecision {
  allowed: boolean;
  reason?: string;
  nextAttemptCostUsd: number;
  projectedSceneCostUsd: number;
  cumulativeProjectedCostUsd: number;
}

export function decideFalBudget(input: {
  preset: FalVideoPreset;
  duration: number;
  priorAttemptCostsUsd: number[];
  priorProjectCostUsd?: number;
  sceneBudgetUsd: number;
  hardStopUsd?: number;
}): FalBudgetDecision {
  const nextAttemptCostUsd = estimateFalVideoCost(input.preset, input.duration);
  const priorSceneCostUsd = input.priorAttemptCostsUsd.reduce((sum, value) => sum + value, 0);
  const projectedSceneCostUsd = Number((priorSceneCostUsd + nextAttemptCostUsd).toFixed(2));
  const priorProjectCostUsd = input.priorProjectCostUsd ?? priorSceneCostUsd;
  const cumulativeProjectedCostUsd = Number((priorProjectCostUsd + nextAttemptCostUsd).toFixed(2));
  const hardStopUsd = input.hardStopUsd ?? FAL_HARD_STOP_USD;
  if (cumulativeProjectedCostUsd > hardStopUsd) {
    return {
      allowed: false,
      reason: `El próximo intento llevaría el gasto proyectado a ${formatUsd(cumulativeProjectedCostUsd)}, por encima del freno duro de ${formatUsd(hardStopUsd)}.`,
      nextAttemptCostUsd,
      projectedSceneCostUsd,
      cumulativeProjectedCostUsd,
    };
  }
  if (projectedSceneCostUsd > input.sceneBudgetUsd) {
    return {
      allowed: false,
      reason: `El próximo intento llevaría la escena a ${formatUsd(projectedSceneCostUsd)}, por encima de su presupuesto de ${formatUsd(input.sceneBudgetUsd)}.`,
      nextAttemptCostUsd,
      projectedSceneCostUsd,
      cumulativeProjectedCostUsd,
    };
  }
  return {
    allowed: true,
    nextAttemptCostUsd,
    projectedSceneCostUsd,
    cumulativeProjectedCostUsd,
  };
}
