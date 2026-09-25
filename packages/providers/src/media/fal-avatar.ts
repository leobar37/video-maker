/**
 * `fal-avatar`: MediaProvider adapter (kind 'avatar') over the fal queue REST
 * API with SUBMIT-ONCE semantics — exactly one live submit per
 * `MediaSubmitInput.idempotencyKey`, journalled through `@videomaker/core`.
 * A submit that fails or times out without a receipt maps to `uncertain` and
 * blocks retries until explicitly reconciled. Status/result polling is free.
 *
 * Ported and decoupled from the avatar generation pipeline: engine catalog,
 * documented payload builder and strict documented-response parsing.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { sha256Hex } from '@videomaker/core';

import type {
  MediaArtifact,
  MediaJobStatus,
  MediaSubmitInput,
  PaidReceipt,
  ProviderContext,
} from '../ports';
import {
  MediaProviderError,
  assertIdempotencyKey,
  assertKind,
  assertRunMode,
  optionalNumberParam,
  optionalStringParam,
  paramsSnapshot,
  parseMediaSource,
  type MediaPlannedAction,
  type MediaSourceInput,
  type PlannedMediaProvider,
} from './common';
import {
  FAL_QUEUE_BASE,
  downloadProviderBytes,
  falAuthHeaders,
  falCredentials,
  falJobStatus,
  parseQueueReceipt,
  sanitizeProviderDetail,
  uploadToFalStorage,
} from './fal-queue';
import { SubmitGate, receiptFacts, type SubmitGateOptions, type SubmitProbe } from './submit-gate';

/** Local documentation snapshot of an avatar engine, not a model-weight pin. */
export interface AvatarEngine {
  id: string;
  version: string;
  modelId: string;
  endpoint: string;
  capabilities: {
    image: true;
    externalAudio: true;
    freeformDirection: boolean;
    aspectRatio: '9:16' | null;
    resolution: '720p' | null;
    talkingStyle: 'stable' | null;
    outputFps: null;
    minimumAudioSeconds: null;
    maximumAudioSeconds: null;
    wavSupport: 'unverified';
  };
  pricing: { usdPerOutputSecond: number; checkedAt: string; rounding: 'unknown'; source: string };
  sources: string[];
  limitations: string[];
}

export const AVATAR_ENGINES: readonly AvatarEngine[] = [
  {
    id: 'heygen-avatar4',
    version: 'fal-openapi-2026-09-22/v1',
    modelId: 'fal-ai/heygen/avatar4/image-to-video',
    endpoint: `${FAL_QUEUE_BASE}/fal-ai/heygen/avatar4/image-to-video`,
    capabilities: {
      image: true,
      externalAudio: true,
      freeformDirection: false,
      aspectRatio: '9:16',
      resolution: '720p',
      talkingStyle: 'stable',
      outputFps: null,
      minimumAudioSeconds: null,
      maximumAudioSeconds: null,
      wavSupport: 'unverified',
    },
    pricing: {
      usdPerOutputSecond: 0.1,
      checkedAt: '2026-09-22',
      rounding: 'unknown',
      source: 'https://fal.ai/models/fal-ai/heygen/avatar4/image-to-video/llms.txt',
    },
    sources: [
      'https://fal.ai/models/fal-ai/heygen/avatar4/image-to-video/llms.txt',
      'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/heygen/avatar4/image-to-video',
    ],
    limitations: [
      'WAV format compatibility, audio duration limits and output FPS are not guaranteed by the published schema. Validate returned media; never silently convert the approved audio or infer timing.',
    ],
  },
  {
    id: 'kling-avatar-v2-pro',
    version: 'fal-openapi-2026-09-22/v1',
    modelId: 'fal-ai/kling-video/ai-avatar/v2/pro',
    endpoint: `${FAL_QUEUE_BASE}/fal-ai/kling-video/ai-avatar/v2/pro`,
    capabilities: {
      image: true,
      externalAudio: true,
      freeformDirection: true,
      aspectRatio: null,
      resolution: null,
      talkingStyle: null,
      outputFps: null,
      minimumAudioSeconds: null,
      maximumAudioSeconds: null,
      wavSupport: 'unverified',
    },
    pricing: {
      usdPerOutputSecond: 0.115,
      checkedAt: '2026-09-22',
      rounding: 'unknown',
      source: 'https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/pro/llms.txt',
    },
    sources: [
      'https://fal.ai/models/fal-ai/kling-video/ai-avatar/v2/pro/llms.txt',
      'https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/kling-video/ai-avatar/v2/pro',
    ],
    limitations: [
      'The published schema does not guarantee WAV compatibility, audio duration limits, output FPS, aspect ratio or resolution. Inspect the actual output; prompt support is not a guarantee of gesture, identity or product fidelity.',
    ],
  },
];

export function avatarEngine(id: string): AvatarEngine {
  const engine = AVATAR_ENGINES.find((candidate) => candidate.id === id);
  if (!engine) {
    throw new MediaProviderError(
      'UNSUPPORTED_CAPABILITY',
      `Unknown avatar engine "${id}" (known: ${AVATAR_ENGINES.map((entry) => entry.id).join(', ')}).`,
    );
  }
  return engine;
}

export function estimateAvatarCost(engine: AvatarEngine, seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new MediaProviderError('UNSUPPORTED_CAPABILITY', 'Audio without a valid duration.');
  }
  // Informational arithmetic only; unknown output rounding reserves the full allowance.
  return Math.round(seconds * engine.pricing.usdPerOutputSecond * 1e6) / 1e6;
}

export interface AvatarPayloadInput {
  imageUrl: string;
  audioUrl: string;
  direction?: string;
}

function assertRemoteAsset(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MediaProviderError('INVALID_PROVIDER_INPUT', `${label} is not a valid URL.`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new MediaProviderError(
      'INVALID_PROVIDER_INPUT',
      `${label} must be HTTPS without credentials in the URL.`,
    );
  }
}

/** Builds the documented engine payload; freeform prompts only where supported. */
export function buildAvatarPayload(
  engine: AvatarEngine,
  input: AvatarPayloadInput,
): Record<string, unknown> {
  const direction = input.direction?.trim() ?? '';
  if (direction && !engine.capabilities.freeformDirection) {
    throw new MediaProviderError(
      'UNSUPPORTED_CAPABILITY',
      'This engine does not accept freeform direction with external audio; the prompt would be spoken text.',
    );
  }
  assertRemoteAsset(input.imageUrl, 'image_url');
  assertRemoteAsset(input.audioUrl, 'audio_url');
  if (engine.id === 'kling-avatar-v2-pro') {
    return {
      image_url: input.imageUrl,
      audio_url: input.audioUrl,
      ...(direction ? { prompt: direction } : {}),
    };
  }
  return {
    image_url: input.imageUrl,
    audio_url: input.audioUrl,
    aspect_ratio: engine.capabilities.aspectRatio,
    resolution: engine.capabilities.resolution,
    talking_style: engine.capabilities.talkingStyle,
    caption: false,
  };
}

/**
 * Parses the documented File response (`{ video: { url } }`), not an arbitrary
 * nested URL (e.g. an input image). Kling documents `duration` as required:
 * response validation only — the downloaded stream stays authoritative.
 */
export function parseAvatarResult(payload: unknown, engine?: AvatarEngine): string {
  let value: unknown = payload;
  if (value && typeof value === 'object' && 'data' in value) {
    value = (value as Record<string, unknown>).data;
  }
  if (
    engine?.id === 'kling-avatar-v2-pro' &&
    (!value ||
      typeof value !== 'object' ||
      !('duration' in value) ||
      typeof (value as Record<string, unknown>).duration !== 'number' ||
      !Number.isFinite((value as Record<string, unknown>).duration) ||
      ((value as Record<string, unknown>).duration as number) <= 0)
  ) {
    throw new MediaProviderError(
      'INVALID_PROVIDER_OUTPUT',
      'Kling response is missing a valid duration.',
    );
  }
  const video =
    value && typeof value === 'object' ? (value as Record<string, unknown>).video : undefined;
  const url = video && typeof video === 'object' ? (video as Record<string, unknown>).url : undefined;
  if (typeof url !== 'string') {
    throw new MediaProviderError(
      'INVALID_PROVIDER_OUTPUT',
      'Official response is missing the video file.',
    );
  }
  const file = video as Record<string, unknown>;
  if ('content_type' in file && file.content_type !== null && file.content_type !== 'video/mp4') {
    throw new MediaProviderError('INVALID_PROVIDER_OUTPUT', 'Result is not an MP4 video.');
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MediaProviderError('INVALID_PROVIDER_OUTPUT', 'Invalid video URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    /\.(png|jpe?g|webp|wav|mp3)$/i.test(parsed.pathname)
  ) {
    throw new MediaProviderError('INVALID_PROVIDER_OUTPUT', 'Unsupported video URL.');
  }
  return parsed.href;
}

interface AvatarSubmitParams {
  engineId?: string;
  modelId?: string;
  image: MediaSourceInput;
  audio: MediaSourceInput;
  direction?: string;
  durationSeconds?: number;
  outputPath?: string;
  estimatedCostUsd?: number;
}

const PROBE_FIELDS = ['engineId', 'modelId', 'direction', 'durationSeconds', 'outputPath'] as const;

function parseAvatarParams(params: Record<string, unknown>): AvatarSubmitParams {
  const parsed: AvatarSubmitParams = {
    image: parseMediaSource(params.image, 'params.image'),
    audio: parseMediaSource(params.audio, 'params.audio'),
  };
  const engineId = optionalStringParam(params, 'engineId', 'params');
  if (engineId !== undefined) parsed.engineId = engineId;
  const modelId = optionalStringParam(params, 'modelId', 'params');
  if (modelId !== undefined) parsed.modelId = modelId;
  const direction = optionalStringParam(params, 'direction', 'params');
  if (direction !== undefined) parsed.direction = direction;
  const durationSeconds = optionalNumberParam(params, 'durationSeconds', 'params');
  if (durationSeconds !== undefined) parsed.durationSeconds = durationSeconds;
  const outputPath = optionalStringParam(params, 'outputPath', 'params');
  if (outputPath !== undefined) parsed.outputPath = outputPath;
  const estimatedCostUsd = optionalNumberParam(params, 'estimatedCostUsd', 'params');
  if (estimatedCostUsd !== undefined) parsed.estimatedCostUsd = estimatedCostUsd;
  if (!parsed.engineId && !parsed.modelId) {
    throw new MediaProviderError('INVALID_PARAMS', 'params needs engineId or modelId.');
  }
  return parsed;
}

/** Endpoint this adapter would submit to; plan-mode safe (no secrets). */
function avatarEndpoint(params: AvatarSubmitParams): string {
  if (params.engineId) return avatarEngine(params.engineId).endpoint;
  if (!params.modelId) {
    throw new MediaProviderError('INVALID_PARAMS', 'params needs engineId or modelId.');
  }
  return `${FAL_QUEUE_BASE}/${params.modelId}`;
}

function avatarEstimatedCost(params: AvatarSubmitParams): number | null {
  if (params.estimatedCostUsd !== undefined) return params.estimatedCostUsd;
  if (params.engineId && params.durationSeconds !== undefined) {
    return estimateAvatarCost(avatarEngine(params.engineId), params.durationSeconds);
  }
  return null;
}

function avatarRequestSnapshot(input: MediaSubmitInput): Record<string, unknown> {
  const snapshot = paramsSnapshot(input.params) as Record<string, unknown>;
  const request: Record<string, unknown> = {};
  for (const field of PROBE_FIELDS) {
    if (snapshot[field] !== undefined) request[field] = snapshot[field];
  }
  request.image = snapshot.image ?? { url: '[remote]' };
  request.audio = snapshot.audio ?? { url: '[remote]' };
  return request;
}

export interface FalAvatarProviderOptions extends SubmitGateOptions {
  /** Test seam: overrides the fal queue base URL. */
  queueBaseUrl?: string;
}

/**
 * MediaProvider for avatar jobs over fal queue REST. Submit-once per
 * idempotency key; `plan()` reports the run-mode work without doing it.
 */
export function createFalAvatarProvider(
  options: FalAvatarProviderOptions = {},
): PlannedMediaProvider & { gate: SubmitGate } {
  const gate = new SubmitGate(options);
  const queueBase = options.queueBaseUrl ?? FAL_QUEUE_BASE;
  const provider: PlannedMediaProvider & { gate: SubmitGate } = {
    id: 'fal-avatar',
    gate,

    plan(input: MediaSubmitInput): MediaPlannedAction {
      const params = parseAvatarParams(input.params);
      return {
        provider: 'fal-avatar',
        kind: 'avatar',
        operation: 'submit',
        network: true,
        paid: true,
        estimatedCostUsd: avatarEstimatedCost(params),
        endpoint: queueBase === FAL_QUEUE_BASE ? avatarEndpoint(params) : queueBase,
        requiresSecrets: ['FAL_KEY'],
        request: avatarRequestSnapshot(input),
        detail:
          'one fal queue submit (submit-once per idempotencyKey) after free CDN uploads of the image and audio inputs',
      };
    },

    async submit(
      input: MediaSubmitInput,
      ctx: ProviderContext,
    ): Promise<{ receipt: PaidReceipt; status: MediaJobStatus }> {
      assertKind(input, ['avatar']);
      const params = parseAvatarParams(input.params);
      const planned = provider.plan(input);
      assertRunMode(ctx.mode, planned);
      const key = assertIdempotencyKey(input);
      const probe: SubmitProbe = {
        provider: 'fal-avatar',
        kind: 'avatar',
        idempotencyKey: key,
        planDigest: input.planDigest,
        params: input.params,
        estimatedCostUsd: planned.estimatedCostUsd,
        ...(params.outputPath !== undefined ? { output: params.outputPath } : {}),
      };
      // Replay/blocking decisions come first: a replayed submit is ZERO HTTP.
      const replay = await gate.lookup(probe);
      if (replay) return replay;

      ctx.logger?.(`fal-avatar: uploading avatar inputs for ${key}`);
      const image = await uploadToFalStorage(ctx, params.image);
      const audio = await uploadToFalStorage(ctx, params.audio);
      const engine = params.engineId ? avatarEngine(params.engineId) : undefined;
      const endpoint =
        queueBase === FAL_QUEUE_BASE ? avatarEndpoint(params) : `${queueBase}/${params.modelId ?? ''}`;
      const body = engine
        ? buildAvatarPayload(engine, {
            imageUrl: image.url,
            audioUrl: audio.url,
            ...(params.direction !== undefined ? { direction: params.direction } : {}),
          })
        : {
            image_url: image.url,
            audio_url: audio.url,
            ...(params.direction ? { prompt: params.direction } : {}),
          };
      return gate.run({
        ...probe,
        perform: async () => {
          const apiKey = await falCredentials(ctx);
          const response = await ctx.fetchImpl(endpoint, {
            method: 'POST',
            headers: falAuthHeaders(apiKey),
            body: JSON.stringify(body),
            redirect: 'error',
          });
          if (!response.ok) {
            throw new MediaProviderError(
              'UNCERTAIN_SUBMISSION',
              `Submit without receipt (HTTP ${response.status}). Reconcile the reservation.`,
            );
          }
          // One native fetch performs exactly one submit; no SDK retry middlewares.
          return parseQueueReceipt(await response.json());
        },
      });
    },

    async status(receipt: PaidReceipt, ctx: ProviderContext): Promise<MediaJobStatus> {
      const planned: MediaPlannedAction = {
        provider: 'fal-avatar',
        kind: 'avatar',
        operation: 'status',
        network: true,
        paid: false,
        estimatedCostUsd: 0,
        requiresSecrets: ['FAL_KEY'],
        request: {},
        detail: 'read-only fal queue status poll',
      };
      assertRunMode(ctx.mode, planned);
      const facts = receiptFacts(receipt, 'fal-avatar');
      if (!facts.statusUrl) {
        throw new MediaProviderError('INVALID_RECEIPT', 'Receipt carries no statusUrl.');
      }
      const apiKey = await falCredentials(ctx);
      const response = await ctx.fetchImpl(facts.statusUrl, { headers: falAuthHeaders(apiKey) });
      if (!response.ok) {
        throw new MediaProviderError(
          'STATUS_FAILED',
          `fal status ${response.status}: ${sanitizeProviderDetail(await response.text().catch(() => ''))}`,
        );
      }
      const payload: unknown = await response.json();
      const record =
        payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
      return falJobStatus(record.status);
    },

    async result(receipt: PaidReceipt, ctx: ProviderContext): Promise<MediaArtifact> {
      const planned: MediaPlannedAction = {
        provider: 'fal-avatar',
        kind: 'avatar',
        operation: 'result',
        network: true,
        paid: false,
        estimatedCostUsd: 0,
        requiresSecrets: ['FAL_KEY'],
        request: {},
        detail: 'read-only fal queue result fetch plus artifact download',
      };
      assertRunMode(ctx.mode, planned);
      const facts = receiptFacts(receipt, 'fal-avatar');
      if (!facts.responseUrl) {
        throw new MediaProviderError('INVALID_RECEIPT', 'Receipt carries no responseUrl.');
      }
      const engine = facts.request.engineId ? avatarEngine(String(facts.request.engineId)) : undefined;
      const apiKey = await falCredentials(ctx);
      const response = await ctx.fetchImpl(facts.responseUrl, {
        headers: falAuthHeaders(apiKey),
      });
      if (!response.ok) {
        throw new MediaProviderError(
          'RESULT_FAILED',
          `fal result ${response.status}: ${sanitizeProviderDetail(await response.text().catch(() => ''))}`,
        );
      }
      const payload: unknown = await response.json();
      const mediaUrl = parseAvatarResult(payload, engine);
      const bytes = await downloadProviderBytes(ctx.fetchImpl, mediaUrl);
      const outputPath = typeof facts.request.outputPath === 'string' ? facts.request.outputPath : undefined;
      if (outputPath) {
        await mkdir(dirname(outputPath), { recursive: true });
        await writeFile(outputPath, bytes);
      }
      return {
        url: mediaUrl,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
        contentType: 'video/mp4',
        extra: {
          provider: 'fal-avatar',
          kind: 'avatar',
          idempotencyKey: facts.idempotencyKey,
          providerJobId: receipt.providerJobId,
          ...(outputPath !== undefined ? { localPath: outputPath } : {}),
          ...(engine !== undefined ? { engineId: engine.id } : {}),
        },
      };
    },
  };
  return provider;
}
