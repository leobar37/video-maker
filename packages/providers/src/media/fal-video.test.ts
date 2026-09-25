/**
 * fal-video: keyframe upload path, image-to-video submit-once, result
 * download and plan-mode refusal. Fake transports only — zero network.
 */
import { describe, expect, test } from 'bun:test';

import type { MediaSubmitInput, ProviderContext } from '../ports';
import { MediaSubmitUncertainError } from './common';
import { createFalVideoProvider } from './fal-video';
import {
  fixedClock,
  jsonResponse,
  makeFakeFetch,
  makeFakeSecrets,
  type RecordedRequest,
} from './test-support';

const FAL_KEY = 'TOP-SECRET-FAL-KEY';
const QUEUE_URL = 'https://queue.fal.run/fal-ai/minimax/hailuo-02/pro/image-to-video';
const STATUS_URL = 'https://queue.fal.run/requests/req-9/status';
const RESPONSE_URL = 'https://queue.fal.run/requests/req-9';
const UPLOAD_INITIATE = 'https://rest.alpha.fal.ai/storage/upload/initiate';
const UPLOAD_PUT = 'https://cdn.fal.example/upload/abc';
const FILE_URL = 'https://cdn.fal.example/files/keyframe.png';

function videoInput(idempotencyKey: string): MediaSubmitInput {
  return {
    kind: 'video',
    idempotencyKey,
    planDigest: 'b'.repeat(64),
    params: {
      modelId: 'fal-ai/minimax/hailuo-02/pro/image-to-video',
      prompt: 'la cámara rodea el producto',
      durationSeconds: 6,
      durationFormat: 'suffixed',
      source: { url: 'https://cdn.example/first-frame.png' },
      references: [{ url: 'https://cdn.example/cast-1.png' }],
      referenceField: 'image_urls',
      outputPath: '/tmp/fal-video-test/generated.mp4',
      estimatedCostUsd: 0.5,
    },
  };
}

function imageInput(idempotencyKey: string): MediaSubmitInput {
  return {
    kind: 'image',
    idempotencyKey,
    planDigest: 'c'.repeat(64),
    params: {
      source: { bytes: new TextEncoder().encode('png-bytes'), filename: 'keyframe.png', contentType: 'image/png' },
    },
  };
}

function harness(handler: (request: RecordedRequest) => Response | Promise<Response>) {
  const { fetchImpl, requests } = makeFakeFetch(handler);
  const secrets = makeFakeSecrets({ FAL_KEY });
  const ctx: ProviderContext = {
    mode: 'run',
    secrets,
    fetchImpl,
    clock: fixedClock('2026-09-24T12:00:00.000Z'),
  };
  return { requests, ctx, secrets };
}

describe('fal-video keyframe upload path (kind image)', () => {
  test('uploads the keyframe spend-neutrally and never hits a queue submit', async () => {
    const { requests, ctx } = harness((request) => {
      if (request.url === UPLOAD_INITIATE) {
        return jsonResponse({ upload_url: UPLOAD_PUT, file_url: FILE_URL });
      }
      if (request.url === UPLOAD_PUT && request.method === 'PUT') return new Response('');
      return jsonResponse({ error: 'unexpected' }, 500);
    });
    const provider = createFalVideoProvider();

    const planned = provider.plan(imageInput('img-1'));
    expect(planned.paid).toBe(false);
    expect(planned.estimatedCostUsd).toBe(0);

    const { receipt, status } = await provider.submit(imageInput('img-1'), ctx);
    expect(receipt.providerJobId).toBe('upload-img-1');
    expect(status.state).toBe('queued');

    const artifact = await provider.result(receipt, ctx);
    expect(artifact.url).toBe(FILE_URL);
    expect(artifact.bytes).toBe(9);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(requests.some((request) => request.url.startsWith('https://queue.fal.run'))).toBe(false);

    // Submit-once: a replayed upload sends ZERO HTTP.
    const before = requests.length;
    await provider.submit(imageInput('img-1'), ctx);
    expect(requests.length).toBe(before);
  });
});

describe('fal-video image-to-video (kind video)', () => {
  test('uploads sources, submits once and downloads the result', async () => {
    const { requests, ctx } = harness((request) => {
      if (request.method === 'POST' && request.url === QUEUE_URL) {
        return jsonResponse({
          request_id: 'req-9',
          status_url: STATUS_URL,
          response_url: RESPONSE_URL,
        });
      }
      if (request.url === STATUS_URL) return jsonResponse({ status: 'COMPLETED' });
      if (request.url === RESPONSE_URL) {
        return jsonResponse({ video: { url: 'https://cdn.example/generated.mp4' } });
      }
      if (request.url === 'https://cdn.example/generated.mp4') {
        return new Response(new Uint8Array([7, 7, 7]));
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });
    const provider = createFalVideoProvider();

    const { receipt } = await provider.submit(videoInput('vid-1'), ctx);
    const submits = requests.filter((request) => request.url === QUEUE_URL);
    expect(submits.length).toBe(1);
    const body = JSON.parse(submits[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body.image_url).toBe('https://cdn.example/first-frame.png');
    expect(body.duration).toBe('6s');
    expect(body.image_urls).toEqual(['https://cdn.example/cast-1.png']);

    expect((await provider.status(receipt, ctx)).state).toBe('succeeded');
    const artifact = await provider.result(receipt, ctx);
    expect(artifact.url).toBe('https://cdn.example/generated.mp4');
    expect(artifact.bytes).toBe(3);
  });

  test('a receipt-less submit failure maps to uncertain and blocks the retry', async () => {
    const { requests, ctx } = harness((request) =>
      request.url === QUEUE_URL ? jsonResponse({}, 502) : jsonResponse({ error: 'unexpected' }, 500),
    );
    const provider = createFalVideoProvider();

    await expect(provider.submit(videoInput('vid-2'), ctx)).rejects.toBeInstanceOf(
      MediaSubmitUncertainError,
    );
    await expect(provider.submit(videoInput('vid-2'), ctx)).rejects.toBeInstanceOf(
      MediaSubmitUncertainError,
    );
    // Only the single failed submit hit the network; the blocked retry is free.
    expect(requests.length).toBe(1);
    const record = await provider.gate.record('vid-2');
    expect(record?.state).toBe('uncertain');
  });

  test('plan mode refuses submits without fetch or secrets (NFR-002)', async () => {
    const { requests, ctx, secrets } = harness(queue => jsonResponse({}));
    const planCtx: ProviderContext = { ...ctx, mode: 'plan' };
    const provider = createFalVideoProvider();

    const planned = provider.plan(videoInput('vid-3'));
    expect(planned.endpoint).toBe(QUEUE_URL);
    await expect(provider.submit(videoInput('vid-3'), planCtx)).rejects.toThrow('Plan mode');
    expect(requests.length).toBe(0);
    expect(secrets.resolved).toEqual([]);
  });
});
