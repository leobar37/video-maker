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
import { MediaSubmitUncertainError, PlanModeRefusalError } from './common';
import { createElevenLabsTtsProvider, deriveWordTimestamps } from './elevenlabs-tts';
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
