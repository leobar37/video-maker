/**
 * Registro de modelos de keyframe (imagen) en fal.ai + costeo en micro-USD.
 *
 * 1 USD = 1_000_000 micro-USD: el pricing sub-centavo acumula en enteros,
 * nunca en floats crudos.
 */

import { MediaProviderError } from './common';

export const KEYFRAME_HARD_STOP_USD = 10;
export const KEYFRAME_PRICING_SNAPSHOT_DATE = '2026-07-25';
export const KEYFRAME_PRICING_URL = 'https://fal.ai/models/fal-ai/nano-banana-pro';

export const MICRO_USD = 1_000_000;

export function usdToMicros(usd: number): number {
  return Math.round(usd * MICRO_USD);
}

export function microsToUsd(micros: number): number {
  return micros / MICRO_USD;
}

/** Presentation-only rounding: exact-cents amounts keep 2 decimals, subcent
 * detail (e.g. a $0.252146 cap overshoot) stays visible with 6 decimals. */
export function formatUsdPrecise(usd: number): string {
  const cleanCents = Math.abs(usd * 100 - Math.round(usd * 100)) < 1e-6;
  return cleanCents ? usd.toFixed(2) : usd.toFixed(6);
}

export interface KeyframeDimensions {
  width: number;
  height: number;
}

export interface KeyframeModel {
  id: string;
  supportsReferences: boolean;
  /** Flat price per generated image (Nano Banana family). Mutually exclusive with usdPerMegapixel. */
  costPerImageUsd?: number;
  /** Price per output megapixel for dimension-priced models (FLUX.1 schnell). */
  usdPerMegapixel?: number;
  /** Official pricing snapshot date; defaults to KEYFRAME_PRICING_SNAPSHOT_DATE. */
  pricingSnapshotDate?: string;
  pricingUrl: string;
}

export const KEYFRAME_MODELS: Readonly<Record<string, KeyframeModel>> = {
  'fal-ai/nano-banana-pro': {
    id: 'fal-ai/nano-banana-pro',
    supportsReferences: false,
    costPerImageUsd: 0.15,
    pricingUrl: KEYFRAME_PRICING_URL,
  },
  'fal-ai/nano-banana-pro/edit': {
    id: 'fal-ai/nano-banana-pro/edit',
    supportsReferences: true,
    costPerImageUsd: 0.15,
    pricingUrl: 'https://fal.ai/models/fal-ai/nano-banana-pro/edit',
  },
  // FLUX.1 [schnell] — USD 0.003 per megapixel, official llms.txt checked 2026-09-13
  // (https://fal.ai/models/fal-ai/flux/schnell/llms.txt). Priced by dimensions; no flat cost.
  'fal-ai/flux/schnell': {
    id: 'fal-ai/flux/schnell',
    supportsReferences: false,
    usdPerMegapixel: 0.003,
    pricingSnapshotDate: '2026-09-13',
    pricingUrl: 'https://fal.ai/models/fal-ai/flux/schnell',
  },
};

export function getKeyframeModel(id: string): KeyframeModel {
  const model = KEYFRAME_MODELS[id];
  if (!model) {
    throw new MediaProviderError(
      'UNSUPPORTED_CAPABILITY',
      `Modelo de keyframe no registrado: ${id}. Registrados: ${Object.keys(KEYFRAME_MODELS).join(', ')}.`,
    );
  }
  return model;
}

export function isDimensionPricedModel(model: KeyframeModel): boolean {
  return model.usdPerMegapixel !== undefined;
}

/** Reserve each attempt in whole micro-USD, rounding up dimension-priced estimates. */
export function keyframeAttemptCostMicros(
  model: KeyframeModel,
  dimensions?: KeyframeDimensions,
): number {
  if (model.usdPerMegapixel !== undefined) {
    if (!dimensions) {
      throw new MediaProviderError(
        'UNSUPPORTED_CAPABILITY',
        `${model.id} se cobra por dimensiones; pasá --width y --height.`,
      );
    }
    const microsPerMegapixel = Math.round(model.usdPerMegapixel * MICRO_USD);
    return Math.ceil((microsPerMegapixel * dimensions.width * dimensions.height) / MICRO_USD);
  }
  if (model.costPerImageUsd === undefined) {
    throw new MediaProviderError(
      'UNSUPPORTED_CAPABILITY',
      `${model.id} no declara pricing (costPerImageUsd ni usdPerMegapixel).`,
    );
  }
  return usdToMicros(model.costPerImageUsd);
}
