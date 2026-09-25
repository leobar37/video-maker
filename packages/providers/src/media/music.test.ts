/**
 * music: explicit provider selection with NEVER automatic fallback between
 * providers, plus submit-once per provider. Fake transports only — zero network.
 */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import type { MediaSubmitInput, ProviderContext } from '../ports';
import { MediaProviderError, MediaSubmitUncertainError } from './common';
import {
  createElevenLabsMusicProvider,
  createFalMusicProvider,
  selectMusicProvider,
} from './music';
import {
  fixedClock,
  jsonResponse,
  makeFakeFetch,
  makeFakeProcessRunner,
  makeFakeSecrets,
  type RecordedRequest,
} from './test-support';

const ELEVENLABS_KEY = 'TOP-SECRET-ELEVENLABS-KEY';
const FAL_KEY = 'TOP-SECRET-FAL-KEY';
const EL_MUSIC_URL = 'https://api.elevenlabs.io/v1/music';
const FAL_MUSIC_URL = 'https://queue.fal.run/fal-ai/stable-audio';
const FAL_STATUS_URL = 'https://queue.fal.run/requests/m-1/status';
const FAL_RESPONSE_URL = 'https://queue.fal.run/requests/m-1';

function musicInput(idempotencyKey: string, outputPath: string): MediaSubmitInput {
  return {
    kind: 'music',
    idempotencyKey,
    planDigest: 'e'.repeat(64),
    params: {
      prompt: 'cama corporativa cálida, sin voces',
      lengthSeconds: 30,
      outputPath,
      estimatedCostUsd: 0.2,
    },
  };
}

function harness(handler: (request: RecordedRequest) => Response | Promise<Response>) {
  const { fetchImpl, requests } = makeFakeFetch(handler);
  const secrets = makeFakeSecrets({ ELEVENLABS_API_KEY: ELEVENLABS_KEY, FAL_KEY });
  const processes = makeFakeProcessRunner((call) => {
    // The ffmpeg fake writes deterministic bytes to the transcode output.
    const output = call.args[call.args.length - 1] as string;
    writeFileSync(output, new Uint8Array([4, 5, 6]));
    return { code: 0 };
  });
  const ctx: ProviderContext = {
    mode: 'run',
    secrets,
    fetchImpl,
    clock: fixedClock('2026-09-24T12:00:00.000Z'),
    process: processes,
  };
  const outputPath = join(mkdtempSync(join(tmpdir(), 'music-test-')), 'music.mp3');
  return { requests, ctx, outputPath, secrets };
}

describe('music provider selection is explicit, never automatic', () => {
  test('a missing or unknown provider id throws instead of falling back', () => {
    expect(() => selectMusicProvider(undefined)).toThrow('Choose a music provider explicitly');
    expect(() => selectMusicProvider('other')).toThrow('Choose a music provider explicitly');
    expect(selectMusicProvider('elevenlabs').id).toBe('elevenlabs-music');
    expect(selectMusicProvider('fal').id).toBe('fal-stable-audio');
  });

  test('an uncertain request never triggers a spend on the other provider', async () => {
    const { requests, ctx, outputPath } = harness((request) =>
      request.url === EL_MUSIC_URL ? jsonResponse({ detail: 'boom' }, 500) : jsonResponse({}, 500),
    );
    const elevenlabs = selectMusicProvider('elevenlabs');

    await expect(elevenlabs.submit(musicInput('m-1', outputPath), ctx)).rejects.toBeInstanceOf(
      MediaSubmitUncertainError,
    );

    // Every request went to ElevenLabs; fal was never contacted.
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.url.startsWith('https://api.elevenlabs.io')).toBe(true);
    }
    expect(requests.some((request) => request.url.includes('queue.fal.run'))).toBe(false);
  });

  test('the fal adapter never calls ElevenLabs (no implicit cross-provider retry)', async () => {
    const { requests, ctx, outputPath } = harness((request) =>
      request.url === FAL_MUSIC_URL
        ? jsonResponse({
            request_id: 'm-1',
            status_url: FAL_STATUS_URL,
            response_url: FAL_RESPONSE_URL,
          })
        : jsonResponse({}, 500),
    );
    const fal = selectMusicProvider('fal');

    await fal.submit(musicInput('m-2', outputPath), ctx);
    for (const request of requests) {
      expect(request.url.startsWith('https://queue.fal.run')).toBe(true);
    }
  });
});

describe('music submit-once', () => {
  test('a second submit with the same idempotencyKey sends ZERO requests (fal)', async () => {
    const { requests, ctx, outputPath } = harness((request) =>
      request.url === FAL_MUSIC_URL
        ? jsonResponse({
            request_id: 'm-1',
            status_url: FAL_STATUS_URL,
            response_url: FAL_RESPONSE_URL,
          })
        : jsonResponse({}, 500),
    );
    const fal = createFalMusicProvider();

    const first = await fal.submit(musicInput('m-3', outputPath), ctx);
    const second = await fal.submit(musicInput('m-3', outputPath), ctx);

    expect(requests.length).toBe(1);
    expect(second.receipt.providerJobId).toBe(first.receipt.providerJobId);
  });

  test('ElevenLabs music failure is uncertain and blocks the retry', async () => {
    const { requests, ctx, outputPath } = harness(() => jsonResponse({ detail: 'boom' }, 500));
    const elevenlabs = createElevenLabsMusicProvider();

    await expect(
      elevenlabs.submit(musicInput('m-4', outputPath), ctx),
    ).rejects.toBeInstanceOf(MediaSubmitUncertainError);
    await expect(
      elevenlabs.submit(musicInput('m-4', outputPath), ctx),
    ).rejects.toBeInstanceOf(MediaSubmitUncertainError);
    expect(requests.length).toBe(1);
    const record = await elevenlabs.gate.record('m-4');
    expect(record?.state).toBe('uncertain');
  });

  test('plan mode refuses without fetch or secrets (NFR-002)', async () => {
    const { requests, ctx, outputPath, secrets } = harness(() => jsonResponse({}, 500));
    const planCtx: ProviderContext = { ...ctx, mode: 'plan' };
    const provider = createFalMusicProvider();

    expect(provider.plan(musicInput('m-5', outputPath)).paid).toBe(true);
    await expect(provider.submit(musicInput('m-5', outputPath), planCtx)).rejects.toThrow(
      'Plan mode',
    );
    expect(requests.length).toBe(0);
    expect(secrets.resolved).toEqual([]);
  });
});

describe('music result flow', () => {
  test('fal Stable Audio downloads the result and transcodes behind ProcessRunner', async () => {
    const { ctx, outputPath } = harness((request) => {
      if (request.url === FAL_MUSIC_URL) {
        return jsonResponse({
          request_id: 'm-1',
          status_url: FAL_STATUS_URL,
          response_url: FAL_RESPONSE_URL,
        });
      }
      if (request.url === FAL_STATUS_URL) return jsonResponse({ status: 'COMPLETED' });
      if (request.url === FAL_RESPONSE_URL) {
        return jsonResponse({ audio_file: { url: 'https://cdn.example/bed.wav' } });
      }
      if (request.url === 'https://cdn.example/bed.wav') {
        return new Response(new Uint8Array([1, 1, 1]));
      }
      return jsonResponse({}, 500);
    });
    const fal = createFalMusicProvider();
    const { receipt } = await fal.submit(musicInput('m-6', outputPath), ctx);

    expect((await fal.status(receipt, ctx)).state).toBe('succeeded');
    const artifact = await fal.result(receipt, ctx);
    expect(artifact.contentType).toBe('audio/mpeg');
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.extra?.model).toBe('fal-ai/stable-audio');
    expect(artifact.extra?.localPath).toBe(outputPath);
    expect(existsSync(outputPath)).toBe(true);
  });

  test('ElevenLabs music_v2 returns mp3 bytes and transcodes behind ProcessRunner', async () => {
    const { ctx, outputPath } = harness((request) =>
      request.url === EL_MUSIC_URL
        ? new Response(new Uint8Array([2, 2]), { status: 200 })
        : jsonResponse({}, 500),
    );
    const elevenlabs = createElevenLabsMusicProvider();
    const { receipt } = await elevenlabs.submit(musicInput('m-7', outputPath), ctx);

    const artifact = await elevenlabs.result(receipt, ctx);
    expect(artifact.extra?.model).toBe('music_v2');
    expect(artifact.extra?.provider).toBe('elevenlabs-music');
  });
});
