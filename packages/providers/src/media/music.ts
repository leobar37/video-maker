/**
 * `music`: selectable music-bed providers — ElevenLabs Music (`music_v2`) and
 * fal Stable Audio — each a MediaProvider (kind 'music') with submit-once
 * semantics. Selection is ALWAYS explicit: there is no automatic fallback
 * between providers, ever. An uncertain request from one provider never
 * triggers a spend on the other; reconcile first, then choose again.
 *
 * Both providers transcode to a clean 44.1k stereo mp3 behind the injectable
 * `ProcessRunner` port.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { sha256Hex } from '@videomaker/core';

import type {
  MediaArtifact,
  MediaJobStatus,
  MediaSubmitInput,
  PaidReceipt,
  ProcessRunner,
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
  requireProcessRunner,
  requireStringParam,
  type MediaPlannedAction,
  type PlannedMediaProvider,
} from './common';
import {
  FAL_QUEUE_BASE,
  downloadProviderBytes,
  extractResultUrl,
  falAuthHeaders,
  falCredentials,
  falJobStatus,
  parseQueueReceipt,
  sanitizeProviderDetail,
} from './fal-queue';
import { SubmitGate, receiptFacts, synchronousOutcome, type ReceiptFacts, type SubmitGateOptions, type SubmitProbe } from './submit-gate';

export const ELEVENLABS_MUSIC_MODEL = 'music_v2';
export const FAL_MUSIC_MODEL = 'fal-ai/stable-audio';
/** Stable Audio caps generation at 47 seconds per request. */
export const FAL_MUSIC_MAX_SECONDS = 47;
export const MUSIC_TRANSCODE_VERSION = 'mp3-44100-stereo-192k/v1';

/** The only music providers; the choice is always made explicitly. */
export const MUSIC_PROVIDER_IDS = ['elevenlabs', 'fal'] as const;
export type MusicProviderId = (typeof MUSIC_PROVIDER_IDS)[number];

interface MusicSubmitParams {
  prompt: string;
  lengthSeconds: number;
  outputPath: string;
  model: string;
  outputFormat: string;
  estimatedCostUsd?: number;
}

function parseMusicParams(params: Record<string, unknown>, defaultModel: string): MusicSubmitParams {
  const lengthSeconds = params.lengthSeconds;
  if (typeof lengthSeconds !== 'number' || !Number.isFinite(lengthSeconds) || lengthSeconds <= 0) {
    throw new MediaProviderError(
      'INVALID_PARAMS',
      'params.lengthSeconds must be a positive finite number.',
    );
  }
  const parsed: MusicSubmitParams = {
    prompt: requireStringParam(params, 'prompt', 'params'),
    lengthSeconds,
    outputPath: requireStringParam(params, 'outputPath', 'params'),
    model: optionalStringParam(params, 'model', 'params') ?? defaultModel,
    outputFormat: optionalStringParam(params, 'outputFormat', 'params') ?? 'mp3_44100_128',
  };
  const estimatedCostUsd = optionalNumberParam(params, 'estimatedCostUsd', 'params');
  if (estimatedCostUsd !== undefined) parsed.estimatedCostUsd = estimatedCostUsd;
  return parsed;
}

async function transcodeToMp3(
  runner: ProcessRunner,
  audio: Uint8Array,
  mp3Path: string,
): Promise<Uint8Array> {
  const suffix = `${process.pid}-${randomUUID()}`;
  const tmpIn = join(tmpdir(), `music-${suffix}.source`);
  const tmpOut = join(tmpdir(), `music-${suffix}.mp3`);
  await writeFile(tmpIn, audio);
  try {
    const result = await runner.run('ffmpeg', [
      '-y',
      '-i',
      tmpIn,
      '-ar',
      '44100',
      '-ac',
      '2',
      '-b:a',
      '192k',
      tmpOut,
    ]);
    if (result.code !== 0) {
      throw new MediaProviderError(
        'TRANSCODE_FAILED',
        `ffmpeg failed to transcode the music bed: ${result.stderr.slice(-400)}`,
      );
    }
    const mp3 = new Uint8Array(await readFile(tmpOut));
    await writeFile(mp3Path, mp3);
    return mp3;
  } finally {
    await rm(tmpIn, { force: true }).catch(() => {});
    await rm(tmpOut, { force: true }).catch(() => {});
  }
}

function musicArtifact(
  receipt: PaidReceipt,
  facts: ReceiptFacts,
  params: MusicSubmitParams,
  bytes: Uint8Array,
  providerId: string,
): MediaArtifact {
  return {
    url: `file://${params.outputPath}`,
    bytes: bytes.byteLength,
    sha256: sha256Hex(bytes),
    contentType: 'audio/mpeg',
    extra: {
      provider: providerId,
      kind: 'music',
      idempotencyKey: facts.idempotencyKey,
      providerJobId: receipt.providerJobId,
      model: params.model,
      prompt: params.prompt,
      requestedLengthSeconds: params.lengthSeconds,
      transcode: MUSIC_TRANSCODE_VERSION,
      localPath: params.outputPath,
    },
  };
}

export interface MusicProviderOptions extends SubmitGateOptions {
  /** Test seam: overrides the provider API base URL. */
  apiBaseUrl?: string;
  /** Test seam: overrides the fal queue base URL (fal provider only). */
  queueBaseUrl?: string;
}

/**
 * ElevenLabs Music (music_v2, instrumental). Synchronous: one request returns
 * the audio; the submit receipt is minted only from a validated response.
 */
export function createElevenLabsMusicProvider(
  options: MusicProviderOptions = {},
): PlannedMediaProvider & { gate: SubmitGate } {
  const gate = new SubmitGate(options);
  const apiBase = options.apiBaseUrl ?? 'https://api.elevenlabs.io';
  const payloads = new Map<string, Uint8Array>();

  const provider: PlannedMediaProvider & { gate: SubmitGate } = {
    id: 'elevenlabs-music',
    gate,

    plan(input: MediaSubmitInput): MediaPlannedAction {
      const params = parseMusicParams(input.params, ELEVENLABS_MUSIC_MODEL);
      return {
        provider: 'elevenlabs-music',
        kind: 'music',
        operation: 'submit',
        network: true,
        paid: true,
        estimatedCostUsd: params.estimatedCostUsd ?? null,
        endpoint: `${apiBase}/v1/music`,
        requiresSecrets: ['ELEVENLABS_API_KEY'],
        request: paramsSnapshot(input.params) as Record<string, unknown>,
        detail:
          'one ElevenLabs music_v2 request (submit-once per idempotencyKey); ffmpeg mp3 transcode afterwards',
      };
    },

    async submit(
      input: MediaSubmitInput,
      ctx: ProviderContext,
    ): Promise<{ receipt: PaidReceipt; status: MediaJobStatus }> {
      assertKind(input, ['music']);
      const params = parseMusicParams(input.params, ELEVENLABS_MUSIC_MODEL);
      const planned = provider.plan(input);
      assertRunMode(ctx.mode, planned);
      const key = assertIdempotencyKey(input);
      const probe: SubmitProbe = {
        provider: 'elevenlabs-music',
        kind: 'music',
        idempotencyKey: key,
        planDigest: input.planDigest,
        params: input.params,
        estimatedCostUsd: planned.estimatedCostUsd,
        output: params.outputPath,
      };
      const replay = await gate.lookup(probe);
      if (replay) {
        return synchronousOutcome(replay, 'synchronous ElevenLabs Music synthesis (submit-once replay)');
      }
      requireProcessRunner(ctx, 'music transcode');

      const outcome = await gate.run({
        ...probe,
        perform: async () => {
          const apiKey = await ctx.secrets.getSecret('ELEVENLABS_API_KEY', ctx.mode);
          ctx.logger?.(`elevenlabs-music: one music_v2 request for ${key}`);
          const response = await ctx.fetchImpl(`${apiBase}/v1/music`, {
            method: 'POST',
            headers: {
              // NFR-001: the key lives only in this request header.
              'xi-api-key': apiKey,
              'Content-Type': 'application/json',
              Accept: 'audio/mpeg',
            },
            body: JSON.stringify({
              prompt: params.prompt,
              model: params.model,
              music_length_ms: Math.max(3000, Math.min(600_000, params.lengthSeconds * 1000)),
              force_instrumental: true,
              output_format: params.outputFormat,
            }),
          });
          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new MediaProviderError(
              'UNCERTAIN_SUBMISSION',
              `Music request without receipt (HTTP ${response.status}): ${detail.slice(0, 200)}`,
            );
          }
          const audio = new Uint8Array(await response.arrayBuffer());
          if (audio.byteLength === 0) {
            throw new MediaProviderError(
              'INVALID_RECEIPT',
              'ElevenLabs Music returned empty audio; the attempt has no receipt.',
            );
          }
          payloads.set(key, audio);
          return { requestId: `music-${key}` };
        },
      });
      return synchronousOutcome(
        outcome,
        'synchronous ElevenLabs Music synthesis completed in one request',
      );
    },

    async status(receipt: PaidReceipt, ctx: ProviderContext): Promise<MediaJobStatus> {
      assertRunMode(ctx.mode, {
        provider: 'elevenlabs-music',
        kind: 'music',
        operation: 'status',
        network: true,
        paid: false,
        estimatedCostUsd: 0,
        requiresSecrets: [],
        request: {},
        detail: 'synchronous synthesis status (no polling endpoint)',
      });
      receiptFacts(receipt, 'elevenlabs-music');
      return { state: 'succeeded', detail: 'synchronous ElevenLabs Music synthesis' };
    },

    async result(receipt: PaidReceipt, ctx: ProviderContext): Promise<MediaArtifact> {
      assertRunMode(ctx.mode, {
        provider: 'elevenlabs-music',
        kind: 'music',
        operation: 'result',
        network: true,
        paid: false,
        estimatedCostUsd: 0,
        requiresSecrets: [],
        request: {},
        detail: 'local ffmpeg mp3 transcode of the cached music bed',
      });
      const facts = receiptFacts(receipt, 'elevenlabs-music');
      const audio = payloads.get(facts.idempotencyKey);
      if (!audio) {
        throw new MediaProviderError(
          'SYNTHESIS_NOT_CACHED',
          `No cached music bed for ${facts.idempotencyKey}: result() must run on the adapter ` +
            `instance that submitted it (audio never enters receipts).`,
        );
      }
      const params = parseMusicParams(facts.request, ELEVENLABS_MUSIC_MODEL);
      const runner = requireProcessRunner(ctx, 'music transcode');
      await mkdir(dirname(params.outputPath), { recursive: true });
      const bytes = await transcodeToMp3(runner, audio, params.outputPath);
      return musicArtifact(receipt, facts, params, bytes, 'elevenlabs-music');
    },
  };
  return provider;
}

/**
 * fal Stable Audio via the queue REST API: submit → status poll → result →
 * download. Submit-once; polling is free.
 */
export function createFalMusicProvider(
  options: MusicProviderOptions = {},
): PlannedMediaProvider & { gate: SubmitGate } {
  const gate = new SubmitGate(options);
  const queueBase = options.queueBaseUrl ?? FAL_QUEUE_BASE;
  const apiBase = options.apiBaseUrl ?? queueBase;

  const provider: PlannedMediaProvider & { gate: SubmitGate } = {
    id: 'fal-stable-audio',
    gate,

    plan(input: MediaSubmitInput): MediaPlannedAction {
      const params = parseMusicParams(input.params, FAL_MUSIC_MODEL);
      return {
        provider: 'fal-stable-audio',
        kind: 'music',
        operation: 'submit',
        network: true,
        paid: true,
        estimatedCostUsd: params.estimatedCostUsd ?? null,
        endpoint: `${apiBase}/${params.model}`,
        requiresSecrets: ['FAL_KEY'],
        request: paramsSnapshot(input.params) as Record<string, unknown>,
        detail:
          'one fal Stable Audio queue submit (submit-once per idempotencyKey); status polling and download afterwards',
      };
    },

    async submit(
      input: MediaSubmitInput,
      ctx: ProviderContext,
    ): Promise<{ receipt: PaidReceipt; status: MediaJobStatus }> {
      assertKind(input, ['music']);
      const params = parseMusicParams(input.params, FAL_MUSIC_MODEL);
      const planned = provider.plan(input);
      assertRunMode(ctx.mode, planned);
      const key = assertIdempotencyKey(input);
      const probe: SubmitProbe = {
        provider: 'fal-stable-audio',
        kind: 'music',
        idempotencyKey: key,
        planDigest: input.planDigest,
        params: input.params,
        estimatedCostUsd: planned.estimatedCostUsd,
        output: params.outputPath,
      };
      const replay = await gate.lookup(probe);
      if (replay) return replay;
      requireProcessRunner(ctx, 'music transcode');

      return gate.run({
        ...probe,
        perform: async () => {
          const apiKey = await falCredentials(ctx);
          ctx.logger?.(`fal-stable-audio: one queue submit for ${key}`);
          const response = await ctx.fetchImpl(`${apiBase}/${params.model}`, {
            method: 'POST',
            headers: falAuthHeaders(apiKey),
            body: JSON.stringify({
              prompt: params.prompt,
              seconds_total: Math.min(FAL_MUSIC_MAX_SECONDS, params.lengthSeconds),
            }),
            redirect: 'error',
          });
          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new MediaProviderError(
              'UNCERTAIN_SUBMISSION',
              `Submit without receipt (HTTP ${response.status}): ${detail.slice(0, 200)}`,
            );
          }
          return parseQueueReceipt(await response.json());
        },
      });
    },

    async status(receipt: PaidReceipt, ctx: ProviderContext): Promise<MediaJobStatus> {
      assertRunMode(ctx.mode, {
        provider: 'fal-stable-audio',
        kind: 'music',
        operation: 'status',
        network: true,
        paid: false,
        estimatedCostUsd: 0,
        requiresSecrets: ['FAL_KEY'],
        request: {},
        detail: 'read-only fal queue status poll',
      });
      const facts = receiptFacts(receipt, 'fal-stable-audio');
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
        provider: 'fal-stable-audio',
        kind: 'music',
        operation: 'result',
        network: true,
        paid: false,
        estimatedCostUsd: 0,
        requiresSecrets: ['FAL_KEY'],
        request: {},
        detail: 'fal queue result fetch, download and local ffmpeg mp3 transcode',
      });
      const facts = receiptFacts(receipt, 'fal-stable-audio');
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
      const audioUrl = extractResultUrl(payload);
      if (!audioUrl) {
        throw new MediaProviderError(
          'INVALID_PROVIDER_OUTPUT',
          'No audio URL found in the fal result payload.',
        );
      }
      const audio = await downloadProviderBytes(ctx.fetchImpl, audioUrl);
      const params = parseMusicParams(facts.request, FAL_MUSIC_MODEL);
      const runner = requireProcessRunner(ctx, 'music transcode');
      await mkdir(dirname(params.outputPath), { recursive: true });
      const bytes = await transcodeToMp3(runner, audio, params.outputPath);
      return musicArtifact(receipt, facts, params, bytes, 'fal-stable-audio');
    },
  };
  return provider;
}

/**
 * Explicit provider selection. This is the ONLY door to a music provider: an
 * unknown or missing id throws instead of silently falling back to another
 * provider (an uncertain spend must never trigger a different spend).
 */
export function selectMusicProvider(
  id: string | undefined,
  options: MusicProviderOptions = {},
): PlannedMediaProvider & { gate: SubmitGate } {
  if (id === 'elevenlabs') return createElevenLabsMusicProvider(options);
  if (id === 'fal') return createFalMusicProvider(options);
  throw new MediaProviderError(
    'PROVIDER_REQUIRED',
    `Choose a music provider explicitly (${MUSIC_PROVIDER_IDS.join(' | ')}); ` +
      `automatic fallback between providers is not allowed.`,
  );
}
