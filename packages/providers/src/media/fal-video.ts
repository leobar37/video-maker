/**
 * `fal-video`: MediaProvider adapter (kind 'video') for image-to-video over
 * the fal queue REST API — upload source keyframes → one submit → status →
 * result → download. Submit-once per `MediaSubmitInput.idempotencyKey`: a
 * failed/timeout submit without a receipt maps to `uncertain` and blocks
 * retries until reconciled; status/result polling is free.
 *
 * Also serves the 'image' keyframe upload path (spend-neutral, $0) when the
 * source has a standalone keyframe to host on the fal CDN.
 */
import { createHash } from 'node:crypto';
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
  FAL_STORAGE_BASE,
  downloadProviderBytes,
  extractResultUrl,
  falAuthHeaders,
  falCredentials,
  falJobStatus,
  parseQueueReceipt,
  sanitizeProviderDetail,
  uploadToFalStorage,
} from './fal-queue';
import { SubmitGate, receiptFacts, type SubmitGateOptions, type SubmitProbe } from './submit-gate';

/** How the provider expects the duration field in the request body. */
export type FalVideoDurationFormat = 'suffixed' | 'plain';

interface FalVideoSubmitParams {
  modelId?: string;
  endpoint?: string;
  prompt: string;
  durationSeconds: number;
  durationFormat: FalVideoDurationFormat;
  defaultInput: Record<string, unknown>;
  /** Request field carrying the first-frame keyframe URL (null = none). */
  firstFrameField: string | null;
  /** Request field carrying reference image URLs (null = no references). */
  referenceField: string | null;
  prependSourceToRefs: boolean;
  source: MediaSourceInput;
  tailSource?: MediaSourceInput;
  /** Request field carrying the tail-frame keyframe URL (null = none). */
  tailField: string | null;
  references: MediaSourceInput[];
  outputPath?: string;
  estimatedCostUsd?: number;
}

function parseSourceList(value: unknown, label: string): MediaSourceInput[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new MediaProviderError('INVALID_PARAMS', `${label} must be an array of media sources.`);
  }
  return value.map((item, index) => parseMediaSource(item, `${label}[${index}]`));
}

function parseFalVideoParams(params: Record<string, unknown>): FalVideoSubmitParams {
  const durationSeconds = params.durationSeconds;
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new MediaProviderError(
      'INVALID_PARAMS',
      'params.durationSeconds must be a positive finite number.',
    );
  }
  const durationFormat = params.durationFormat ?? 'plain';
  if (durationFormat !== 'suffixed' && durationFormat !== 'plain') {
    throw new MediaProviderError(
      'INVALID_PARAMS',
      'params.durationFormat must be "suffixed" or "plain".',
    );
  }
  const defaultInput = params.defaultInput ?? {};
  if (!defaultInput || typeof defaultInput !== 'object' || Array.isArray(defaultInput)) {
    throw new MediaProviderError('INVALID_PARAMS', 'params.defaultInput must be an object.');
  }
  const firstFrameField = params.firstFrameField === undefined ? 'image_url' : params.firstFrameField;
  if (firstFrameField !== null && typeof firstFrameField !== 'string') {
    throw new MediaProviderError(
      'INVALID_PARAMS',
      'params.firstFrameField must be a string or null.',
    );
  }
  const referenceField = params.referenceField ?? null;
  if (referenceField !== null && typeof referenceField !== 'string') {
    throw new MediaProviderError(
      'INVALID_PARAMS',
      'params.referenceField must be a string or null.',
    );
  }
  const tailField = params.tailField === undefined ? 'tail_image_url' : params.tailField;
  if (tailField !== null && typeof tailField !== 'string') {
    throw new MediaProviderError('INVALID_PARAMS', 'params.tailField must be a string or null.');
  }
  const parsed: FalVideoSubmitParams = {
    prompt: typeof params.prompt === 'string' ? params.prompt : '',
    durationSeconds,
    durationFormat,
    defaultInput: defaultInput as Record<string, unknown>,
    firstFrameField,
    referenceField,
    tailField,
    prependSourceToRefs: params.prependSourceToRefs === true,
    source: parseMediaSource(params.source, 'params.source'),
    references: parseSourceList(params.references, 'params.references'),
  };
  const modelId = optionalStringParam(params, 'modelId', 'params');
  if (modelId !== undefined) parsed.modelId = modelId;
  const endpoint = optionalStringParam(params, 'endpoint', 'params');
  if (endpoint !== undefined) parsed.endpoint = endpoint;
  const tailSource = params.tailSource === undefined ? undefined : parseMediaSource(params.tailSource, 'params.tailSource');
  if (tailSource !== undefined) parsed.tailSource = tailSource;
  const outputPath = optionalStringParam(params, 'outputPath', 'params');
  if (outputPath !== undefined) parsed.outputPath = outputPath;
  const estimatedCostUsd = optionalNumberParam(params, 'estimatedCostUsd', 'params');
  if (estimatedCostUsd !== undefined) parsed.estimatedCostUsd = estimatedCostUsd;
  if (!parsed.endpoint && !parsed.modelId) {
    throw new MediaProviderError('INVALID_PARAMS', 'params needs endpoint or modelId.');
  }
  return parsed;
}

function videoSubmitEndpoint(params: FalVideoSubmitParams): string {
  if (params.endpoint) return params.endpoint;
  return `${FAL_QUEUE_BASE}/${params.modelId ?? ''}`;
}

function videoRequestBody(
  params: FalVideoSubmitParams,
  sourceUrl: string,
  tailUrl: string | undefined,
  referenceUrls: string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...params.defaultInput,
    prompt: params.prompt,
    duration:
      params.durationFormat === 'suffixed' ? `${params.durationSeconds}s` : String(params.durationSeconds),
  };
  if (params.firstFrameField) body[params.firstFrameField] = sourceUrl;
  const refs = [...referenceUrls];
  if (params.prependSourceToRefs) refs.unshift(sourceUrl);
  if (tailUrl && params.tailField) {
    // Tail-frame keyframes ride the documented per-model field (default: fal's
    // documented `tail_image_url`).
    body[params.tailField] = tailUrl;
  }
  if (params.referenceField) {
    if (refs.length > 0) body[params.referenceField] = refs;
  } else if (refs.length > 0) {
    throw new MediaProviderError(
      'INVALID_PARAMS',
      'This request shape has no reference field but references were provided.',
    );
  }
  return body;
}

function videoRequestSnapshot(input: MediaSubmitInput): Record<string, unknown> {
  const snapshot = paramsSnapshot(input.params) as Record<string, unknown>;
  const request: Record<string, unknown> = {};
  for (const field of [
    'modelId',
    'endpoint',
    'prompt',
    'durationSeconds',
    'durationFormat',
    'firstFrameField',
    'referenceField',
    'tailField',
    'prependSourceToRefs',
    'outputPath',
    'estimatedCostUsd',
  ] as const) {
    if (snapshot[field] !== undefined) request[field] = snapshot[field];
  }
  request.source = snapshot.source ?? { url: '[remote]' };
  if (snapshot.tailSource !== undefined) request.tailSource = snapshot.tailSource;
  if (snapshot.references !== undefined) request.references = snapshot.references;
  return request;
}

export interface FalVideoProviderOptions extends SubmitGateOptions {
  /** Test seam: overrides the fal queue base URL. */
  queueBaseUrl?: string;
}

/**
 * MediaProvider for image-to-video (kind 'video') and keyframe uploads
 * (kind 'image') over fal queue REST. Submit-once per idempotency key;
 * `plan()` reports the run-mode work without doing it.
 */
export function createFalVideoProvider(
  options: FalVideoProviderOptions = {},
): PlannedMediaProvider & { gate: SubmitGate } {
  const gate = new SubmitGate(options);
  const queueBase = options.queueBaseUrl ?? FAL_QUEUE_BASE;
  const provider: PlannedMediaProvider & { gate: SubmitGate } = {
    id: 'fal-video',
    gate,

    plan(input: MediaSubmitInput): MediaPlannedAction {
      if (input.kind === 'image') {
        return {
          provider: 'fal-video',
          kind: 'image',
          operation: 'upload',
          network: true,
          paid: false,
          estimatedCostUsd: 0,
          endpoint: FAL_STORAGE_BASE,
          requiresSecrets: ['FAL_KEY'],
          request: videoRequestSnapshot(input),
          detail: 'spend-neutral fal CDN keyframe upload (no paid submit)',
        };
      }
      const params = parseFalVideoParams(input.params);
      return {
        provider: 'fal-video',
        kind: 'video',
        operation: 'submit',
        network: true,
        paid: true,
        estimatedCostUsd: params.estimatedCostUsd ?? null,
        endpoint: videoSubmitEndpoint(params),
        requiresSecrets: ['FAL_KEY'],
        request: videoRequestSnapshot(input),
        detail:
          'one fal queue image-to-video submit (submit-once per idempotencyKey) after free keyframe uploads',
      };
    },

    async submit(
      input: MediaSubmitInput,
      ctx: ProviderContext,
    ): Promise<{ receipt: PaidReceipt; status: MediaJobStatus }> {
      assertKind(input, ['video', 'image']);
      const planned = provider.plan(input);
      assertRunMode(ctx.mode, planned);
      const key = assertIdempotencyKey(input);

      if (input.kind === 'image') {
        return submitKeyframeUpload(input, ctx, gate, planned, key);
      }

      const params = parseFalVideoParams(input.params);
      const probe: SubmitProbe = {
        provider: 'fal-video',
        kind: 'video',
        idempotencyKey: key,
        planDigest: input.planDigest,
        params: input.params,
        estimatedCostUsd: planned.estimatedCostUsd,
        ...(params.outputPath !== undefined ? { output: params.outputPath } : {}),
      };
      // Replay/blocking decisions come first: a replayed submit is ZERO HTTP.
      const replay = await gate.lookup(probe);
      if (replay) return replay;

      ctx.logger?.(`fal-video: uploading keyframe inputs for ${key}`);
      const source = await uploadToFalStorage(ctx, params.source);
      const tail = params.tailSource ? await uploadToFalStorage(ctx, params.tailSource) : undefined;
      const references: string[] = [];
      for (const reference of params.references) {
        references.push((await uploadToFalStorage(ctx, reference)).url);
      }
      const endpoint = queueBase === FAL_QUEUE_BASE ? videoSubmitEndpoint(params) : queueBase;
      const body = videoRequestBody(
        params,
        source.url,
        tail?.url,
        references,
      );
      return gate.run({
        ...probe,
        perform: async () => {
          const apiKey = await falCredentials(ctx);
          // One native fetch performs exactly one submit; no SDK retry middlewares.
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
          return parseQueueReceipt(await response.json());
        },
      });
    },

    async status(receipt: PaidReceipt, ctx: ProviderContext): Promise<MediaJobStatus> {
      assertRunMode(ctx.mode, {
        provider: 'fal-video',
        kind: 'video',
        operation: 'status',
        network: true,
        paid: false,
        estimatedCostUsd: 0,
        requiresSecrets: ['FAL_KEY'],
        request: {},
        detail: 'read-only fal queue status poll',
      });
      const facts = receiptFacts(receipt, 'fal-video');
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
      assertRunMode(ctx.mode, {
        provider: 'fal-video',
        kind: 'video',
        operation: 'result',
        network: true,
        paid: false,
        estimatedCostUsd: 0,
        requiresSecrets: ['FAL_KEY'],
        request: {},
        detail: 'read-only fal queue result fetch plus artifact download',
      });
      const facts = receiptFacts(receipt, 'fal-video');
      const providerJobId = receipt.providerJobId;

      if (facts.kind === 'image') {
        // The keyframe upload is its own artifact: hosted URL + source digest.
        const fileUrl = facts.responseUrl;
        if (!fileUrl) {
          throw new MediaProviderError('INVALID_RECEIPT', 'Upload receipt carries no file_url.');
        }
        const source = facts.request.source;
        const bytes =
          source && typeof source === 'object' && 'bytes' in source
            ? Number((source as Record<string, unknown>).bytes)
            : undefined;
        return {
          url: fileUrl,
          ...(bytes !== undefined ? { bytes } : {}),
          ...(typeof facts.request.sourceSha256 === 'string'
            ? { sha256: facts.request.sourceSha256 }
            : {}),
          contentType: typeof facts.request.contentType === 'string' ? facts.request.contentType : undefined,
          extra: {
            provider: 'fal-video',
            kind: 'image',
            idempotencyKey: facts.idempotencyKey,
            providerJobId,
          },
        };
      }

      if (!facts.responseUrl) {
        throw new MediaProviderError('INVALID_RECEIPT', 'Receipt carries no responseUrl.');
      }
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
      const mediaUrl = extractResultUrl(payload);
      if (!mediaUrl) {
        throw new MediaProviderError(
          'INVALID_PROVIDER_OUTPUT',
          'No media URL found in the fal result payload.',
        );
      }
      const bytes = await downloadProviderBytes(ctx.fetchImpl, mediaUrl);
      const outputPath =
        typeof facts.request.outputPath === 'string' ? facts.request.outputPath : undefined;
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
          provider: 'fal-video',
          kind: 'video',
          idempotencyKey: facts.idempotencyKey,
          providerJobId,
          ...(outputPath !== undefined ? { localPath: outputPath } : {}),
        },
      };
    },
  };
  return provider;
}

/**
 * Spend-neutral 'image' keyframe upload path: the CDN upload is not a paid
 * submit, so it journals with `estimatedCostUsd: 0` and never reaches a queue
 * endpoint. Upload failures journal nothing (no spend happened).
 */
async function submitKeyframeUpload(
  input: MediaSubmitInput,
  ctx: ProviderContext,
  gate: SubmitGate,
  planned: MediaPlannedAction,
  key: string,
): Promise<{ receipt: PaidReceipt; status: MediaJobStatus }> {
  const params = input.params;
  const source = parseMediaSource(params.source, 'params.source');
  const snapshot = paramsSnapshot(params) as Record<string, unknown>;
  const sourceSha256 =
    'bytes' in source ? createHash('sha256').update(source.bytes).digest('hex') : undefined;
  const probe: SubmitProbe = {
    provider: 'fal-video',
    kind: 'image',
    idempotencyKey: key,
    planDigest: input.planDigest,
    params: {
      ...snapshot,
      // Explicit size summary so receipts record a number, not a binary echo.
      source: 'bytes' in source ? { bytes: source.bytes.byteLength } : { url: source.url },
      ...(sourceSha256 !== undefined ? { sourceSha256 } : {}),
    },
    estimatedCostUsd: 0,
  };
  const replay = await gate.lookup(probe);
  if (replay) return replay;
  ctx.logger?.(`fal-video: uploading keyframe ${key}`);
  const uploaded = await uploadToFalStorage(ctx, source);
  return gate.run({
    ...probe,
    perform: async () => ({
      requestId: `upload-${key}`,
      responseUrl: uploaded.url,
    }),
  });
}
