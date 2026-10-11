/**
 * elevenlabs-tts: word/character timestamps flow into artifact.extra, the
 * ffmpeg transcode runs behind the ProcessRunner port, submit-once holds, and
 * receipt-less failures map to uncertain. Fake transports only — zero network.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { MediaSubmitInput, ProviderContext } from '../ports';
import { MediaProviderError, MediaSubmitUncertainError, PlanModeRefusalError } from './common';
import {
  assertWithinModelLimit,
  buildTtsRequest,
  createElevenLabsTtsProvider,
  deriveWordTimestamps,
  effectiveVoiceSettings,
  effectiveVoiceSettingsForModel,
  KNOWN_MODEL_CHAR_LIMITS,
  V4_MODEL_IDS,
  type TtsSubmitParams,
} from './elevenlabs-tts';
import {
  fixedClock,
  jsonResponse,
  makeFakeFetch,
  makeFakeProcessRunner,
  makeFakeSecrets,
  type FakeProcessRunner,
  type RecordedRequest,
} from './test-support';

const API_KEY = 'TOP-SECRET-ELEVENLABS-KEY';
const TEXT = 'hola mundo';
const VOICE_ID = 'voice-1';
const REQUEST_URL = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps?output_format=mp3_44100_128`;

const CHARACTERS = Array.from(TEXT);
const STARTS = CHARACTERS.map((_, index) => Math.round(index * 0.08 * 100) / 100);
const ENDS = CHARACTERS.map((_, index) => Math.round((index * 0.08 + 0.06) * 100) / 100);
const FAKE_WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);

function ttsInput(idempotencyKey: string, outputPath: string): MediaSubmitInput {
  return {
    kind: 'tts',
    idempotencyKey,
    planDigest: 'd'.repeat(64),
    params: {
      voiceId: VOICE_ID,
      modelId: 'eleven_v3',
      text: TEXT,
      language: 'es-419',
      outputPath,
      estimatedCostUsd: 0.05,
    },
  };
}

function withTimestampsResponse(): Response {
  return jsonResponse({
    audio_base64: Buffer.from(new Uint8Array([9, 8, 7, 6])).toString('base64'),
    alignment: {
      characters: CHARACTERS,
      character_start_times_seconds: STARTS,
      character_end_times_seconds: ENDS,
    },
  });
}

interface Harness {
  requests: RecordedRequest[];
  ctx: ProviderContext;
  outputPath: string;
  processes: FakeProcessRunner;
}

function writeFakeWav(path: string): void {
  writeFileSync(path, FAKE_WAV);
}

function harness(handler: (request: RecordedRequest) => Response | Promise<Response>): Harness {
  const { fetchImpl, requests } = makeFakeFetch(handler);
  const secrets = makeFakeSecrets({ ELEVENLABS_API_KEY: API_KEY });
  const processes = makeFakeProcessRunner((call) => {
    // The ffmpeg fake writes deterministic bytes to the transcode output.
    const output = call.args[call.args.length - 1] as string;
    writeFakeWav(output);
    return { code: 0 };
  });
  const ctx: ProviderContext = {
    mode: 'run',
    secrets,
    fetchImpl,
    clock: fixedClock('2026-09-24T12:00:00.000Z'),
    process: processes,
  };
  const outputPath = join(mkdtempSync(join(tmpdir(), 'tts-test-')), 'narration.wav');
  return { requests, ctx, outputPath, processes };
}

describe('elevenlabs-tts timestamps in artifact.extra', () => {
  test('word/character timestamps flow into extra and the transcode uses ProcessRunner', async () => {
    const { requests, ctx, outputPath, processes } = harness((request) =>
      request.url === REQUEST_URL ? withTimestampsResponse() : jsonResponse({}, 500),
    );
    const provider = createElevenLabsTtsProvider();

    const { receipt, status } = await provider.submit(ttsInput('tts-1', outputPath), ctx);
    expect(status.state).toBe('succeeded');
    expect(receipt.providerJobId).toBe('tts-tts-1');

    const artifact = await provider.result(receipt, ctx);
    const timestamps = artifact.extra?.timestamps as {
      characters: string[];
      characterStartSeconds: number[];
      characterEndSeconds: number[];
      words: { word: string; startSeconds: number; endSeconds: number }[];
    };
    expect(timestamps.characters).toEqual(CHARACTERS);
    expect(timestamps.characterStartSeconds).toEqual(STARTS);
    expect(timestamps.characterEndSeconds).toEqual(ENDS);
    expect(timestamps.words).toEqual([
      { word: 'hola', startSeconds: 0, endSeconds: 0.3 },
      { word: 'mundo', startSeconds: 0.4, endSeconds: 0.78 },
    ]);
    const alignment = artifact.extra?.alignment as { characters: string[] };
    expect(alignment.characters).toEqual(CHARACTERS);
    expect(artifact.extra?.localPath).toBe(outputPath);
    expect(artifact.contentType).toBe('audio/wav');

    // ffmpeg ran through the ProcessRunner port and the WAV landed on disk.
    expect(processes.calls[0]?.command).toBe('ffmpeg');
    expect(processes.calls[0]?.args).toContain('-ar');
    expect(existsSync(outputPath)).toBe(true);
    expect(new Uint8Array(readFileSync(outputPath))).toEqual(FAKE_WAV);
  });

  test('the API key lives only in the request header (NFR-001)', async () => {
    const { requests, ctx, outputPath } = harness((request) =>
      request.url === REQUEST_URL ? withTimestampsResponse() : jsonResponse({}, 500),
    );
    const provider = createElevenLabsTtsProvider();
    await provider.submit(ttsInput('tts-2', outputPath), ctx);

    expect(requests[0]?.headers['xi-api-key']).toBe(API_KEY);
    expect(requests[0]?.body ?? '').not.toContain(API_KEY);
  });
});

describe('elevenlabs-tts submit-once', () => {
  test('a second submit with the same idempotencyKey sends ZERO requests', async () => {
    const { requests, ctx, outputPath } = harness((request) =>
      request.url === REQUEST_URL ? withTimestampsResponse() : jsonResponse({}, 500),
    );
    const provider = createElevenLabsTtsProvider();

    const first = await provider.submit(ttsInput('tts-3', outputPath), ctx);
    const second = await provider.submit(ttsInput('tts-3', outputPath), ctx);

    expect(requests.length).toBe(1);
    expect(second.receipt.providerJobId).toBe(first.receipt.providerJobId);
  });

  test('a failed synthesis without a receipt is uncertain and blocks retries', async () => {
    const { requests, ctx, outputPath } = harness((request) =>
      request.url === REQUEST_URL ? jsonResponse({ detail: 'boom' }, 500) : jsonResponse({}, 500),
    );
    const provider = createElevenLabsTtsProvider();

    await expect(provider.submit(ttsInput('tts-4', outputPath), ctx)).rejects.toBeInstanceOf(
      MediaSubmitUncertainError,
    );
    await expect(provider.submit(ttsInput('tts-4', outputPath), ctx)).rejects.toBeInstanceOf(
      MediaSubmitUncertainError,
    );
    expect(requests.length).toBe(1);
    const record = await provider.gate.record('tts-4');
    expect(record?.state).toBe('uncertain');
  });

  test('plan mode refuses without fetch or secret resolution (NFR-002)', async () => {
    const { requests, ctx, outputPath } = harness(() => jsonResponse({}, 500));
    const planCtx: ProviderContext = { ...ctx, mode: 'plan' };
    const provider = createElevenLabsTtsProvider();

    const planned = provider.plan(ttsInput('tts-5', outputPath));
    expect(planned.requiresSecrets).toEqual(['ELEVENLABS_API_KEY']);
    await expect(provider.submit(ttsInput('tts-5', outputPath), planCtx)).rejects.toBeInstanceOf(
      PlanModeRefusalError,
    );
    expect(requests.length).toBe(0);
  });
});

describe('deriveWordTimestamps', () => {
  test('groups non-whitespace characters into word spans', () => {
    const words = deriveWordTimestamps({
      characters: CHARACTERS,
      character_start_times_seconds: STARTS,
      character_end_times_seconds: ENDS,
    });
    expect(words.map((word) => word.word)).toEqual(['hola', 'mundo']);
  });
});

function ttsParams(overrides: Partial<TtsSubmitParams> = {}): TtsSubmitParams {
  return {
    voiceId: VOICE_ID,
    modelId: 'eleven_v4',
    text: TEXT,
    outputFormat: 'mp3_44100_128',
    outputPath: '/tmp/narration.wav',
    transcode: true,
    sampleRate: 44100,
    channels: 1,
    ...overrides,
  };
}

describe('elevenlabs-tts model-aware voice settings', () => {
  test('effectiveVoiceSettings stays model-unaware for existing callers', () => {
    expect(effectiveVoiceSettings(undefined)).toEqual({
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0.15,
      use_speaker_boost: true,
    });
  });

  test('v4 and v4 Turbo emit ONLY stability + similarity_boost', () => {
    for (const modelId of Object.keys(V4_MODEL_IDS)) {
      const settings = effectiveVoiceSettingsForModel(modelId, {
        stability: 0.7,
        similarity_boost: 0.9,
        style: 0.9,
        speed: 1.2,
        use_speaker_boost: true,
      });
      expect(settings).toEqual({ stability: 0.7, similarity_boost: 0.9 });
      expect(settings).not.toHaveProperty('style');
      expect(settings).not.toHaveProperty('speed');
      expect(settings).not.toHaveProperty('use_speaker_boost');
    }
  });

  test('v4 drops the pipeline defaults style/speaker_boost when no overrides are given', () => {
    expect(effectiveVoiceSettingsForModel('eleven_v4', undefined)).toEqual({
      stability: 0.5,
      similarity_boost: 0.8,
    });
  });

  test('previous models keep style and speaker boost (no regression)', () => {
    expect(effectiveVoiceSettingsForModel('eleven_multilingual_v2', undefined)).toEqual({
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0.15,
      use_speaker_boost: true,
    });
  });

  test('buildTtsRequest filters voice_settings for eleven_v4', () => {
    const request = buildTtsRequest(
      ttsParams({ voiceSettings: { style: 0.9, speed: 1.1, use_speaker_boost: true } }),
      API_KEY,
    );
    expect(request.body.voice_settings).toEqual({ stability: 0.5, similarity_boost: 0.8 });
    expect(request.body.model_id).toBe('eleven_v4');
  });

  test('buildTtsRequest keeps style/use_speaker_boost for previous models', () => {
    const request = buildTtsRequest(ttsParams({ modelId: 'eleven_multilingual_v2' }), API_KEY);
    expect(request.body.voice_settings).toEqual({
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0.15,
      use_speaker_boost: true,
    });
  });
});

describe('elevenlabs-tts use_pvc_as_ivc mapping', () => {
  test('omits the flag when the caller does not set it (API default false)', () => {
    const request = buildTtsRequest(ttsParams(), API_KEY);
    expect(request.body).not.toHaveProperty('use_pvc_as_ivc');
  });

  test('maps usePvcAsIvc true/false to the request body', () => {
    const enabled = buildTtsRequest(ttsParams({ usePvcAsIvc: true }), API_KEY);
    const disabled = buildTtsRequest(ttsParams({ usePvcAsIvc: false }), API_KEY);
    expect(enabled.body.use_pvc_as_ivc).toBe(true);
    expect(disabled.body.use_pvc_as_ivc).toBe(false);
  });

  test('submit forwards the flag end to end without touching the API key', async () => {
    const { requests, ctx, outputPath } = harness((request) =>
      request.url === REQUEST_URL ? withTimestampsResponse() : jsonResponse({}, 500),
    );
    const provider = createElevenLabsTtsProvider();
    const input: MediaSubmitInput = {
      ...ttsInput('tts-v4-pvc', outputPath),
      params: {
        ...ttsInput('tts-v4-pvc', outputPath).params,
        modelId: 'eleven_v4',
        usePvcAsIvc: true,
        voiceSettings: { style: 0.9, speed: 1.2, stability: 0.7 },
      },
    };

    await provider.submit(input, ctx);
    const body = JSON.parse(requests[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body.model_id).toBe('eleven_v4');
    expect(body.use_pvc_as_ivc).toBe(true);
    expect(body.voice_settings).toEqual({ stability: 0.7, similarity_boost: 0.8 });
    expect(requests[0]?.body ?? '').not.toContain(API_KEY);
  });

  test('rejects a non-boolean usePvcAsIvc before spending a request', async () => {
    const { requests, ctx, outputPath } = harness(() => withTimestampsResponse());
    const provider = createElevenLabsTtsProvider();
    const input: MediaSubmitInput = {
      ...ttsInput('tts-v4-bad', outputPath),
      params: {
        ...ttsInput('tts-v4-bad', outputPath).params,
        modelId: 'eleven_v4',
        usePvcAsIvc: 'yes',
      },
    };

    await expect(provider.submit(input, ctx)).rejects.toBeInstanceOf(MediaProviderError);
    expect(requests.length).toBe(0);
  });
});

describe('elevenlabs-tts model character limits', () => {
  test('eleven_v4 carries the official 10000 ceiling', () => {
    expect(KNOWN_MODEL_CHAR_LIMITS.eleven_v4).toBe(10000);
    expect(() => assertWithinModelLimit('eleven_v4', 10000)).not.toThrow();
    expect(() => assertWithinModelLimit('eleven_v4', 10001)).toThrow(/MODEL_LIMIT_EXCEEDED|10000/);
  });

  test('model limits that were already known are untouched', () => {
    expect(KNOWN_MODEL_CHAR_LIMITS.eleven_v3).toBe(5000);
    expect(KNOWN_MODEL_CHAR_LIMITS.eleven_multilingual_v2).toBe(10000);
    expect(KNOWN_MODEL_CHAR_LIMITS.eleven_flash_v2_5).toBe(40000);
  });

  test('eleven_v4_turbo has NO invented limit — the provider decides', () => {
    expect(KNOWN_MODEL_CHAR_LIMITS.eleven_v4_turbo).toBeUndefined();
    expect(() => assertWithinModelLimit('eleven_v4_turbo', 100000)).not.toThrow();
  });
});
