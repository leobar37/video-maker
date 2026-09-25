/**
 * `elevenlabs-tts`: MediaProvider adapter (kind 'tts') for the ElevenLabs
 * `with-timestamps` endpoint. ONE synthesis request per
 * `MediaSubmitInput.idempotencyKey` (submit-once): a failed/timeout request
 * without a receipt maps to `uncertain` and blocks retries until reconciled.
 *
 * The artifact `extra` carries word/character timestamps (the provider's
 * character alignment plus derived word spans). The ffmpeg transcode to WAV
 * runs behind the injectable `ProcessRunner` port — tests use a fake.
 *
 * NFR-001: the API key travels ONLY in the `xi-api-key` request header; the
 * response base64 audio and the key never reach logs, journals or receipts.
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
import { SubmitGate, receiptFacts, synchronousOutcome, type SubmitGateOptions, type SubmitProbe } from './submit-gate';

export const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
/** Output format negotiated with the endpoint (transcoded to WAV afterwards). */
export const TTS_OUTPUT_FORMAT = 'mp3_44100_128';
/** Transcode policy of the master WAV: 44.1kHz mono, no trimming (alignment
 *  timestamps describe the audio exactly as returned). */
export const TTS_TRANSCODE_VERSION = 'wav-44100-mono-untrimmed/v1';

/** Character alignment returned by the with-timestamps endpoint. */
export interface CharacterAlignment {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}

/** Word-level span derived from the character alignment. */
export interface WordTimestamp {
  word: string;
  startSeconds: number;
  endSeconds: number;
}

/**
 * Known per-request character limits by ElevenLabs model. Unknown models get
 * NO invented limit — the provider answer decides.
 */
export const KNOWN_MODEL_CHAR_LIMITS: Record<string, number> = {
  eleven_v3: 5000,
  eleven_multilingual_v2: 10000,
  eleven_flash_v2_5: 40000,
};

/** Fail locally (before spending a request) when the script exceeds the limit. */
export function assertWithinModelLimit(modelId: string, charCount: number): void {
  const limit = KNOWN_MODEL_CHAR_LIMITS[modelId];
  if (limit === undefined) return;
  if (charCount > limit) {
    throw new MediaProviderError(
      'MODEL_LIMIT_EXCEEDED',
      `Script has ${charCount} characters and model ${modelId} accepts ${limit} per request; ` +
        `shorten the narration or switch models before regenerating.`,
    );
  }
}

/** Pipeline defaults merged with project overrides (single source of truth). */
export function effectiveVoiceSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> {
  return {
    stability: 0.5,
    similarity_boost: 0.8,
    style: 0.15,
    use_speaker_boost: true,
    ...(settings ?? {}),
  };
}

/**
 * Validate that the alignment describes exactly the submitted text and that
 * timestamps are usable (non-negative, non-decreasing). Malformed provider
 * output must fail loudly, never be patched over.
 */
export function validateAlignment(alignment: CharacterAlignment, text: string): void {
  const {
    characters,
    character_start_times_seconds: starts,
    character_end_times_seconds: ends,
  } = alignment;
  const expectedChars = Array.from(text);
  if (
    !Array.isArray(characters) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    characters.length !== expectedChars.length ||
    starts.length !== expectedChars.length ||
    ends.length !== expectedChars.length
  ) {
    throw new MediaProviderError(
      'INVALID_ALIGNMENT',
      `Invalid alignment: ${characters?.length ?? '?'}/${starts?.length ?? '?'}/` +
        `${ends?.length ?? '?'} elements for ${expectedChars.length} submitted characters.`,
    );
  }
  if (characters.join('') !== text) {
    throw new MediaProviderError(
      'INVALID_ALIGNMENT',
      'Invalid alignment: returned characters do not match the submitted text.',
    );
  }
  let previousStart = 0;
  for (let i = 0; i < expectedChars.length; i += 1) {
    const start = starts[i] as number;
    const end = ends[i] as number;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new MediaProviderError(
        'INVALID_ALIGNMENT',
        `Invalid alignment at character ${i}: start=${start}, end=${end}.`,
      );
    }
    if (start < previousStart - 1e-6) {
      throw new MediaProviderError(
        'INVALID_ALIGNMENT',
        `Non-monotonic alignment at character ${i}: start=${start} < ${previousStart}.`,
      );
    }
    previousStart = Math.max(previousStart, start);
  }
}

/** Groups consecutive non-whitespace characters into word spans. */
export function deriveWordTimestamps(alignment: CharacterAlignment): WordTimestamp[] {
  const words: WordTimestamp[] = [];
  let current = '';
  let startSeconds = 0;
  let endSeconds = 0;
  for (let i = 0; i < alignment.characters.length; i += 1) {
    const char = alignment.characters[i] as string;
    const charStart = alignment.character_start_times_seconds[i] as number;
    const charEnd = alignment.character_end_times_seconds[i] as number;
    if (/\s/.test(char)) {
      if (current) {
        words.push({ word: current, startSeconds, endSeconds });
        current = '';
      }
      continue;
    }
    if (!current) startSeconds = charStart;
    current += char;
    endSeconds = charEnd;
  }
  if (current) words.push({ word: current, startSeconds, endSeconds });
  return words;
}

interface TtsRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** ElevenLabs accepts ISO 639-1 codes; configs keep editorial BCP 47 locales. */
function elevenLabsLanguageCode(language: string | undefined): string | undefined {
  const primarySubtag = language?.trim().split('-')[0]?.toLowerCase();
  return primarySubtag || undefined;
}

export interface TtsSubmitParams {
  voiceId: string;
  modelId: string;
  text: string;
  language?: string;
  voiceSettings?: Record<string, unknown>;
  pronunciationDictionaryId?: string;
  outputFormat: string;
  outputPath: string;
  transcode: boolean;
  sampleRate: number;
  channels: number;
  estimatedCostUsd?: number;
}

function parseTtsParams(params: Record<string, unknown>): TtsSubmitParams {
  const parsed: TtsSubmitParams = {
    voiceId: requireStringParam(params, 'voiceId', 'params'),
    modelId: requireStringParam(params, 'modelId', 'params'),
    text: requireStringParam(params, 'text', 'params'),
    outputFormat: optionalStringParam(params, 'outputFormat', 'params') ?? TTS_OUTPUT_FORMAT,
    outputPath: requireStringParam(params, 'outputPath', 'params'),
    transcode: params.transcode === false ? false : true,
    sampleRate: optionalNumberParam(params, 'sampleRate', 'params') ?? 44100,
    channels: optionalNumberParam(params, 'channels', 'params') ?? 1,
  };
  const language = optionalStringParam(params, 'language', 'params');
  if (language !== undefined) parsed.language = language;
  const pronunciationDictionaryId = optionalStringParam(
    params,
    'pronunciationDictionaryId',
    'params',
  );
  if (pronunciationDictionaryId !== undefined) {
    parsed.pronunciationDictionaryId = pronunciationDictionaryId;
  }
  const voiceSettings = params.voiceSettings;
  if (voiceSettings !== undefined && voiceSettings !== null) {
    if (typeof voiceSettings !== 'object' || Array.isArray(voiceSettings)) {
      throw new MediaProviderError('INVALID_PARAMS', 'params.voiceSettings must be an object.');
    }
    parsed.voiceSettings = voiceSettings as Record<string, unknown>;
  }
  const estimatedCostUsd = optionalNumberParam(params, 'estimatedCostUsd', 'params');
  if (estimatedCostUsd !== undefined) parsed.estimatedCostUsd = estimatedCostUsd;
  return parsed;
}

/** Builds the single with-timestamps request. The API key only enters headers. */
export function buildTtsRequest(params: TtsSubmitParams, apiKey: string): TtsRequest {
  const languageCode = elevenLabsLanguageCode(params.language);
  return {
    url: `${ELEVENLABS_API_BASE}/v1/text-to-speech/${params.voiceId}/with-timestamps?output_format=${params.outputFormat}`,
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: {
      text: params.text,
      model_id: params.modelId,
      ...(languageCode ? { language_code: languageCode } : {}),
      voice_settings: effectiveVoiceSettings(params.voiceSettings),
      ...(params.pronunciationDictionaryId
        ? {
            pronunciation_dictionary_locators: [
              { pronunciation_dictionary_id: params.pronunciationDictionaryId },
            ],
          }
        : {}),
    },
  };
}

interface TtsSynthesis {
  audio: Uint8Array;
  alignment: CharacterAlignment;
}

interface TtsTimestamps {
  characters: string[];
  characterStartSeconds: number[];
  characterEndSeconds: number[];
  words: WordTimestamp[];
}

export interface ElevenLabsTtsProviderOptions extends SubmitGateOptions {
  /** Test seam: overrides the ElevenLabs API base URL. */
  apiBaseUrl?: string;
}

/**
 * MediaProvider for continuous narration synthesis (kind 'tts'). Submit-once
 * per idempotency key; `plan()` reports the run-mode work without doing it.
 */
export function createElevenLabsTtsProvider(
  options: ElevenLabsTtsProviderOptions = {},
): PlannedMediaProvider & { gate: SubmitGate } {
  const gate = new SubmitGate(options);
  const apiBase = options.apiBaseUrl ?? ELEVENLABS_API_BASE;
  /** Synthesized payload cache: audio/alignment never enter receipts or logs. */
  const syntheses = new Map<string, TtsSynthesis>();

  const provider: PlannedMediaProvider & { gate: SubmitGate } = {
    id: 'elevenlabs-tts',
    gate,

    plan(input: MediaSubmitInput): MediaPlannedAction {
      const params = parseTtsParams(input.params);
      return {
        provider: 'elevenlabs-tts',
        kind: 'tts',
        operation: 'submit',
        network: true,
        paid: true,
        estimatedCostUsd: params.estimatedCostUsd ?? null,
        endpoint: `${apiBase}/v1/text-to-speech/${params.voiceId}/with-timestamps`,
        requiresSecrets: ['ELEVENLABS_API_KEY'],
        request: paramsSnapshot(input.params) as Record<string, unknown>,
        detail:
          'one ElevenLabs with-timestamps synthesis request (submit-once per idempotencyKey); ffmpeg WAV transcode afterwards',
      };
    },

    async submit(
      input: MediaSubmitInput,
      ctx: ProviderContext,
    ): Promise<{ receipt: PaidReceipt; status: MediaJobStatus }> {
      assertKind(input, ['tts']);
      const params = parseTtsParams(input.params);
      const planned = provider.plan(input);
      assertRunMode(ctx.mode, planned);
      const key = assertIdempotencyKey(input);
      const probe: SubmitProbe = {
        provider: 'elevenlabs-tts',
        kind: 'tts',
        idempotencyKey: key,
        planDigest: input.planDigest,
        params: input.params,
        estimatedCostUsd: planned.estimatedCostUsd,
        output: params.outputPath,
      };
      const replay = await gate.lookup(probe);
      if (replay) {
        return synchronousOutcome(replay, 'synchronous ElevenLabs synthesis (submit-once replay)');
      }

      // Local guards run BEFORE spending: known model limits and the transcode
      // seam must be satisfied without a request.
      assertWithinModelLimit(params.modelId, Array.from(params.text).length);
      if (params.transcode) requireProcessRunner(ctx, 'WAV transcode');

      const outcome = await gate.run({
        ...probe,
        perform: async () => {
          const apiKey = await ctx.secrets.getSecret('ELEVENLABS_API_KEY', ctx.mode);
          const request = buildTtsRequest(params, apiKey);
          ctx.logger?.(`elevenlabs-tts: one with-timestamps request for ${key}`);
          // ONE request for the whole script; the body is never logged.
          const response = await ctx.fetchImpl(request.url, {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
          });
          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new MediaProviderError(
              'UNCERTAIN_SUBMISSION',
              `Synthesis without receipt (HTTP ${response.status}): ${detail.slice(0, 200)}`,
            );
          }
          let payload: unknown;
          try {
            payload = await response.json();
          } catch (cause) {
            throw new MediaProviderError(
              'INVALID_RECEIPT',
              'ElevenLabs returned invalid JSON for with-timestamps.',
              { cause },
            );
          }
          const record =
            payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
          const audioBase64 = record.audio_base64;
          const alignment = record.alignment;
          if (typeof audioBase64 !== 'string' || !audioBase64 || !alignment) {
            throw new MediaProviderError(
              'INVALID_RECEIPT',
              'Incomplete with-timestamps response: missing audio_base64 or alignment.',
            );
          }
          const typedAlignment = parseAlignment(alignment);
          validateAlignment(typedAlignment, params.text);
          syntheses.set(key, {
            audio: new Uint8Array(Buffer.from(audioBase64, 'base64')),
            alignment: typedAlignment,
          });
          const requestId = typeof record.request_id === 'string' ? record.request_id : `tts-${key}`;
          return { requestId };
        },
      });
      return synchronousOutcome(outcome, 'synchronous ElevenLabs synthesis completed in one request');
    },

    async status(receipt: PaidReceipt, ctx: ProviderContext): Promise<MediaJobStatus> {
      assertRunMode(ctx.mode, {
        provider: 'elevenlabs-tts',
        kind: 'tts',
        operation: 'status',
        network: true,
        paid: false,
        estimatedCostUsd: 0,
        requiresSecrets: ['ELEVENLABS_API_KEY'],
        request: {},
        detail: 'synchronous synthesis status (no polling endpoint)',
      });
      // The submit receipt is minted only after a validated complete response,
      // so a proven submit for this synchronous provider is already succeeded.
      receiptFacts(receipt, 'elevenlabs-tts');
      return { state: 'succeeded', detail: 'synchronous ElevenLabs synthesis' };
    },

    async result(receipt: PaidReceipt, ctx: ProviderContext): Promise<MediaArtifact> {
      assertRunMode(ctx.mode, {
        provider: 'elevenlabs-tts',
        kind: 'tts',
        operation: 'result',
        network: true,
        paid: false,
        estimatedCostUsd: 0,
        requiresSecrets: [],
        request: {},
        detail: 'local ffmpeg WAV transcode of the cached synthesis',
      });
      const facts = receiptFacts(receipt, 'elevenlabs-tts');
      const synthesis = syntheses.get(facts.idempotencyKey);
      if (!synthesis) {
        throw new MediaProviderError(
          'SYNTHESIS_NOT_CACHED',
          `No cached synthesis for ${facts.idempotencyKey}: result() must run on the adapter ` +
            `instance that submitted it (audio never enters receipts). Resubmitting is refused ` +
            `by submit-once; reconcile if the payload is truly lost.`,
        );
      }
      const params = parseTtsParams(facts.request);
      const runner: ProcessRunner = requireProcessRunner(ctx, 'WAV transcode');
      const wavPath = params.outputPath;
      await mkdir(dirname(wavPath), { recursive: true });
      let bytes: Uint8Array;
      if (params.transcode) {
        bytes = await transcodeToWav(runner, synthesis.audio, wavPath, {
          sampleRate: params.sampleRate,
          channels: params.channels,
        });
      } else {
        bytes = synthesis.audio;
        await writeFile(wavPath, bytes);
      }
      const words = deriveWordTimestamps(synthesis.alignment);
      const timestamps: TtsTimestamps = {
        characters: synthesis.alignment.characters,
        characterStartSeconds: synthesis.alignment.character_start_times_seconds,
        characterEndSeconds: synthesis.alignment.character_end_times_seconds,
        words,
      };
      return {
        url: `file://${wavPath}`,
        bytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
        contentType: params.transcode ? 'audio/wav' : 'audio/mpeg',
        extra: {
          provider: 'elevenlabs-tts',
          kind: 'tts',
          idempotencyKey: facts.idempotencyKey,
          providerJobId: receipt.providerJobId,
          voiceId: params.voiceId,
          modelId: params.modelId,
          text: params.text,
          sourceFormat: params.outputFormat,
          transcode: params.transcode ? TTS_TRANSCODE_VERSION : 'none',
          localPath: wavPath,
          // Word/character timestamps: normalized view + verbatim provider shape.
          timestamps,
          alignment: synthesis.alignment,
        },
      };
    },
  };
  return provider;
}

function parseAlignment(value: unknown): CharacterAlignment {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const { characters, character_start_times_seconds, character_end_times_seconds } = record;
  if (
    !Array.isArray(characters) ||
    !Array.isArray(character_start_times_seconds) ||
    !Array.isArray(character_end_times_seconds)
  ) {
    throw new MediaProviderError(
      'INVALID_ALIGNMENT',
      'Alignment must carry characters and their start/end arrays.',
    );
  }
  return {
    characters: characters.map((char) => String(char)),
    character_start_times_seconds: character_start_times_seconds.map((n) => Number(n)),
    character_end_times_seconds: character_end_times_seconds.map((n) => Number(n)),
  };
}

/**
 * Transcode to WAV WITHOUT trimming: the alignment timestamps describe the
 * audio exactly as returned, so trimming would invalidate scene boundaries.
 * The audio reaches ffmpeg through temp files because the ProcessRunner port
 * has no stdin channel.
 */
async function transcodeToWav(
  runner: ProcessRunner,
  audio: Uint8Array,
  wavPath: string,
  opts: { sampleRate: number; channels: number },
): Promise<Uint8Array> {
  const suffix = `${process.pid}-${randomUUID()}`;
  const tmpMp3 = join(tmpdir(), `elevenlabs-tts-${suffix}.mp3`);
  const tmpWav = join(tmpdir(), `elevenlabs-tts-${suffix}.wav`);
  await writeFile(tmpMp3, audio);
  try {
    const result = await runner.run('ffmpeg', [
      '-y',
      '-i',
      tmpMp3,
      '-ar',
      String(opts.sampleRate),
      '-ac',
      String(opts.channels),
      '-c:a',
      'pcm_s16le',
      '-f',
      'wav',
      tmpWav,
    ]);
    if (result.code !== 0) {
      throw new MediaProviderError(
        'TRANSCODE_FAILED',
        `ffmpeg failed to transcode to WAV: ${result.stderr.slice(-400)}`,
      );
    }
    const wav = new Uint8Array(await readFile(tmpWav));
    await writeFile(wavPath, wav);
    return wav;
  } finally {
    await rm(tmpMp3, { force: true }).catch(() => {});
    await rm(tmpWav, { force: true }).catch(() => {});
  }
}
