/**
 * fal-avatar: submit-once semantics, uncertain mapping for receipt-less
 * failures, plan-mode refusal and secret hygiene (NFR-001/002).
 * Every test runs against fake transports — zero network.
 */
import { describe, expect, test } from 'bun:test';

import type { MediaSubmitInput, ProviderContext } from '../ports';
import { MediaSubmitUncertainError, PlanModeRefusalError } from './common';
import { createFalAvatarProvider } from './fal-avatar';
import {
  fixedClock,
  jsonResponse,
  makeFakeFetch,
  makeFakeSecrets,
  type RecordedRequest,
} from './test-support';

const FAL_KEY = 'TOP-SECRET-FAL-KEY';
const QUEUE_URL = 'https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/pro';
const STATUS_URL = 'https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/pro/requests/req-1/status';
const RESPONSE_URL = 'https://queue.fal.run/fal-ai/kling-video/ai-avatar/v2/pro/requests/req-1';

function submitInput(idempotencyKey: string): MediaSubmitInput {
  return {
    kind: 'avatar',
    idempotencyKey,
    planDigest: 'a'.repeat(64),
    params: {
      engineId: 'kling-avatar-v2-pro',
      image: { url: 'https://cdn.example/scene.png' },
      audio: { url: 'https://cdn.example/line.wav' },
      direction: 'habla a cámara',
      durationSeconds: 6,
    },
  };
}

interface Harness {
  requests: RecordedRequest[];
  ctx: ProviderContext;
  logs: string[];
}

function harness(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
  mode: ProviderContext['mode'] = 'run',
): Harness {
  const { fetchImpl, requests } = makeFakeFetch(handler);
  const secrets = makeFakeSecrets({ FAL_KEY });
  const logs: string[] = [];
  const ctx: ProviderContext = {
    mode,
    secrets,
    fetchImpl,
    clock: fixedClock('2026-09-24T12:00:00.000Z'),
    logger: (msg) => logs.push(msg),
  };
  return { requests, ctx, logs };
}

function queueSubmitHandler(request: RecordedRequest): Response {
  if (request.method === 'POST' && request.url === QUEUE_URL) {
    return jsonResponse({
      request_id: 'req-1',
      status_url: STATUS_URL,
      response_url: RESPONSE_URL,
    });
  }
  return jsonResponse({ error: 'unexpected' }, 500);
}

describe('fal-avatar submit-once', () => {
  test('a second submit with the same idempotencyKey sends ZERO additional HTTP submits', async () => {
    const { requests, ctx } = harness(queueSubmitHandler);
    const provider = createFalAvatarProvider();

    const first = await provider.submit(submitInput('key-1'), ctx);
    const second = await provider.submit(submitInput('key-1'), ctx);

    expect(requests.length).toBe(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(QUEUE_URL);
    expect(first.receipt.providerJobId).toBe('req-1');
    expect(second.receipt.providerJobId).toBe('req-1');
    expect(first.status.state).toBe('queued');

    const record = await provider.gate.record('key-1');
    expect(record?.state).toBe('submitted');
  });

  test('reusing a key with different inputs is refused without any HTTP', async () => {
    const { requests, ctx } = harness(queueSubmitHandler);
    const provider = createFalAvatarProvider();
    await provider.submit(submitInput('key-1'), ctx);

    const different = submitInput('key-1');
    different.params = { ...different.params, durationSeconds: 9 };
    await expect(provider.submit(different, ctx)).rejects.toThrow(
      'already used with different inputs',
    );
    expect(requests.length).toBe(1);
  });
});

describe('fal-avatar receipt-less failure maps to uncertain', () => {
  test('an invalid queue receipt leaves the attempt uncertain and blocks retries', async () => {
    const { requests, ctx } = harness((request) =>
      request.url === QUEUE_URL ? jsonResponse({}) : jsonResponse({ error: 'unexpected' }, 500),
    );
    const provider = createFalAvatarProvider();

    let caught: unknown;
    try {
      await provider.submit(submitInput('key-2'), ctx);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MediaSubmitUncertainError);
    expect((caught as MediaSubmitUncertainError).state).toBe('uncertain');

    // Blocked retry: ZERO additional HTTP submits.
    await expect(provider.submit(submitInput('key-2'), ctx)).rejects.toBeInstanceOf(
      MediaSubmitUncertainError,
    );
    expect(requests.length).toBe(1);

    const record = await provider.gate.record('key-2');
    expect(record?.state).toBe('uncertain');
  });

  test('a timeout/failure without a receipt is uncertain and only reconcile reopens it', async () => {
    let attempts = 0;
    const { requests, ctx } = harness((request) => {
      if (request.url !== QUEUE_URL) return jsonResponse({ error: 'unexpected' }, 500);
      attempts += 1;
      if (attempts === 1) throw new Error('network timeout');
      return jsonResponse({
        request_id: 'req-1',
        status_url: STATUS_URL,
        response_url: RESPONSE_URL,
      });
    });
    const provider = createFalAvatarProvider();

    await expect(provider.submit(submitInput('key-3'), ctx)).rejects.toBeInstanceOf(
      MediaSubmitUncertainError,
    );
    await expect(provider.submit(submitInput('key-3'), ctx)).rejects.toBeInstanceOf(
      MediaSubmitUncertainError,
    );
    expect(requests.length).toBe(1);

    await provider.gate.reconcile('key-3', {
      by: 'operator',
      evidence: 'fal dashboard shows no request for this reservation',
    });
    const reopened = await provider.submit(submitInput('key-3'), ctx);
    expect(reopened.receipt.providerJobId).toBe('req-1');
    expect(requests.length).toBe(2);
  });
});

describe('fal-avatar plan mode (NFR-002)', () => {
  test('plan() reports planned actions with no fetch and no secret resolution', () => {
    const { requests, ctx } = harness(queueSubmitHandler, 'plan');
    const secrets = makeFakeSecrets({ FAL_KEY });
    const provider = createFalAvatarProvider();

    const planned = provider.plan(submitInput('key-4'));

    expect(planned.paid).toBe(true);
    expect(planned.endpoint).toBe(QUEUE_URL);
    expect(planned.requiresSecrets).toEqual(['FAL_KEY']);
    expect(requests.length).toBe(0);
    expect(secrets.resolved).toEqual([]);
  });

  test('submit/status/result refuse in plan mode without fetch or secrets', async () => {
    const { requests, ctx } = harness(queueSubmitHandler, 'plan');
    const secrets = makeFakeSecrets({ FAL_KEY });
    const planCtx: ProviderContext = { ...ctx, secrets };
    const provider = createFalAvatarProvider();

    await expect(provider.submit(submitInput('key-4'), planCtx)).rejects.toBeInstanceOf(
      PlanModeRefusalError,
    );
    expect(requests.length).toBe(0);
    expect(secrets.resolved).toEqual([]);
  });
});

describe('fal-avatar secret hygiene (NFR-001)', () => {
  test('the key lives only in the submit header, never in logs or receipts', async () => {
    const { requests, ctx, logs } = harness(queueSubmitHandler);
    const provider = createFalAvatarProvider();

    const { receipt } = await provider.submit(submitInput('key-5'), ctx);

    expect(requests[0]?.headers.authorization).toBe(`Key ${FAL_KEY}`);
    expect(requests[0]?.body ?? '').not.toContain(FAL_KEY);
    expect(JSON.stringify(receipt)).not.toContain(FAL_KEY);
    for (const line of logs) expect(line).not.toContain(FAL_KEY);
  });
});

describe('fal-avatar status/result flow', () => {
  test('status maps fal states and result downloads the documented video file', async () => {
    const { ctx } = harness((request) => {
      if (request.method === 'POST' && request.url === QUEUE_URL) {
        return jsonResponse({
          request_id: 'req-1',
          status_url: STATUS_URL,
          response_url: RESPONSE_URL,
        });
      }
      if (request.url === STATUS_URL) return jsonResponse({ status: 'IN_PROGRESS' });
      if (request.url === RESPONSE_URL) {
        return jsonResponse({ video: { url: 'https://cdn.example/out.mp4' }, duration: 5 });
      }
      if (request.url === 'https://cdn.example/out.mp4') {
        return new Response(new Uint8Array([1, 2, 3, 4]));
      }
      return jsonResponse({ error: 'unexpected' }, 500);
    });
    const provider = createFalAvatarProvider();
    const { receipt } = await provider.submit(submitInput('key-6'), ctx);

    const status = await provider.status(receipt, ctx);
    expect(status.state).toBe('running');

    const artifact = await provider.result(receipt, ctx);
    expect(artifact.url).toBe('https://cdn.example/out.mp4');
    expect(artifact.bytes).toBe(4);
    expect(artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.contentType).toBe('video/mp4');
    expect(artifact.extra?.providerJobId).toBe('req-1');
  });
});
