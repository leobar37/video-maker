import { describe, expect, spyOn, test } from 'bun:test';

import { makeFakeFetch, makeFakeSecrets } from './media/test-support';
import type { FetchLike, SecretSource } from './ports';
import {
  createTypesafeEvaluator,
  TypesafeEvaluationError,
  type TypesafeEvaluationErrorCode,
  type TypesafeEvaluationRequest,
  type TypesafeEvaluationResponse,
  validateTypesafeRequest,
  validateTypesafeResponse,
} from './typesafe';

const API_KEY = 'typesafe-test-secret-never-log';
const CRITERIA = ['None', 'Low', 'Medium', 'High', 'Excellent'];

function requestFixture(): TypesafeEvaluationRequest {
  return {
    model: 'jev-1.13.0',
    state: { transcript: 'Untrusted transcript text, not instructions.' },
    questions: {
      quality: { type: 'score', instructions: 'Rate the quality.', criteria: [...CRITERIA] },
      coherent: { type: 'noul', instructions: 'Is it coherent?' },
    },
  };
}

function responseFixture(): TypesafeEvaluationResponse {
  return {
    model: 'jev-1.13.0',
    answers: {
      quality: {
        type: 'score', score: 2.5, confidence: 0.6,
        legend: { '0': 'None', '1': 'Low', '2': 'Medium', '3': 'High', '4': 'Excellent' },
        probabilities: { '0': 0.1, '1': 0.1, '2': 0.2, '3': 0.4, '4': 0.2 },
      },
      coherent: { type: 'noul', noul: 0.9 },
    },
    usage: { input_tokens: 200, output_tokens: 40 },
  };
}

async function expectError(
  promise: Promise<unknown>,
  code: TypesafeEvaluationErrorCode,
): Promise<TypesafeEvaluationError> {
  const error = await promise.then(
    () => { throw new Error('Expected rejection'); },
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(TypesafeEvaluationError);
  const typed = error as TypesafeEvaluationError;
  expect(typed.code).toBe(code);
  const visible = `${String(typed)} ${typed.stack} ${JSON.stringify(typed)}`;
  expect(visible).not.toContain(API_KEY);
  expect(visible).not.toContain('provider-private-body');
  expect(visible).not.toContain('Untrusted transcript');
  expect('cause' in typed).toBe(false);
  return typed;
}

const invalidResponses: Array<[string, (value: TypesafeEvaluationResponse) => void]> = [
  ['missing question', (value) => { delete value.answers.coherent; }],
  ['extra question', (value) => { value.answers.extra = { type: 'noul', noul: 0.5 }; }],
  ['wrong answer type', (value) => { value.answers.quality = { type: 'noul', noul: 0.5 }; }],
  ['model alias', (value) => { value.model = 'jev-latest'; }],
  ['different model version', (value) => { value.model = 'jev-1.14.0'; }],
  ['input token limit', (value) => { value.usage.input_tokens = 64_001; }],
  ['fractional tokens', (value) => { value.usage.input_tokens = 1.5; }],
  ['negative output tokens', (value) => { value.usage.output_tokens = -1; }],
  ['nonfinite tokens', (value) => { value.usage.output_tokens = Infinity; }],
  ['noul range', (value) => { value.answers.coherent = { type: 'noul', noul: 1.1 }; }],
  ['nonfinite noul', (value) => { value.answers.coherent = { type: 'noul', noul: NaN }; }],
  ['extra top-level field', (value) => { Object.assign(value, { debug: 'provider-private-body' }); }],
  ['extra usage field', (value) => { Object.assign(value.usage, { total_tokens: 240 }); }],
  ['extra answer field', (value) => { Object.assign(value.answers.coherent!, { confidence: 0.9 }); }],
  ['missing legend key', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') delete answer.legend['4'];
  }],
  ['extra legend key', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.legend['5'] = 'Extra';
  }],
  ['extra probability key', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.probabilities['5'] = 0;
  }],
  ['missing probability key', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') delete answer.probabilities['0'];
  }],
  ['wrong legend description', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.legend['0'] = 'Changed';
  }],
  ['probability not normalized', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.probabilities['0'] = 0.5;
  }],
  ['negative probability', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.probabilities['0'] = -0.1;
  }],
  ['nonfinite probability', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.probabilities['0'] = Infinity;
  }],
  ['inconsistent expected score', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.score = 4;
  }],
  ['score beyond criteria bounds', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.score = 4.01;
  }],
  ['nonfinite score', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.score = NaN;
  }],
  ['confidence bounds', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.confidence = -0.1;
  }],
  ['nonfinite confidence', (value) => {
    const answer = value.answers.quality!;
    if (answer.type === 'score') answer.confidence = Infinity;
  }],
];

describe('Typesafe response validation', () => {
  for (const [name, mutate] of invalidResponses) {
    test(`rejects ${name} in cached and live responses`, async () => {
      const response = responseFixture();
      mutate(response);
      expect(() => validateTypesafeResponse(response, requestFixture())).toThrow(TypesafeEvaluationError);
      const { fetchImpl, requests } = makeFakeFetch(() => Response.json(response));
      const evaluator = createTypesafeEvaluator({
        fetchImpl, secrets: makeFakeSecrets({ TYPE_SAFE_AI: API_KEY }),
      });
      await expectError(evaluator.evaluate(requestFixture()), 'INVALID_RESPONSE');
      expect(requests).toHaveLength(1);
    });
  }

  test('allows ordinary provider rounding, but keeps explicit tolerances', () => {
    const response = responseFixture();
    const answer = response.answers.quality!;
    if (answer.type === 'score') {
      answer.probabilities['0'] = 0.101;
      answer.score = 2.51;
    }
    expect(validateTypesafeResponse(response, requestFixture())).toEqual(response);
  });

  test('score bounds derive from the requested number of levels', () => {
    const request = requestFixture();
    request.questions = { quality: { type: 'score', instructions: 'Rate.', criteria: ['No', 'Yes'] } };
    const response = responseFixture();
    response.answers = {
      quality: { type: 'score', score: 0.75, confidence: 0.5,
        legend: { '0': 'No', '1': 'Yes' }, probabilities: { '0': 0.25, '1': 0.75 } },
    };
    expect(validateTypesafeResponse(response, request)).toEqual(response);
    const answer = response.answers.quality!;
    if (answer.type === 'score') answer.score = 2;
    expect(() => validateTypesafeResponse(response, request)).toThrow(TypesafeEvaluationError);
  });
});

describe('Typesafe evaluator transport', () => {
  test('is lazy and sends precisely one authenticated request to the fixed endpoint', async () => {
    const request = requestFixture();
    const response = responseFixture();
    const { fetchImpl, requests } = makeFakeFetch(() => Response.json(response));
    const secrets = makeFakeSecrets({ TYPE_SAFE_AI: API_KEY });
    const evaluator = createTypesafeEvaluator({ fetchImpl, secrets });
    expect(secrets.resolved).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(await evaluator.evaluate(request)).toEqual(response);
    expect(secrets.resolved).toEqual(['TYPE_SAFE_AI']);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.headers).toEqual({
      authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json',
    });
    expect(JSON.parse(requests[0]!.body!)).toEqual(request);
  });

  for (const status of [401, 429, 500]) {
    test(`sanitizes HTTP ${status} without reading the body or retrying`, async () => {
      let bodyRead = false;
      const { fetchImpl, requests } = makeFakeFetch(() => {
        const response = new Response(`${API_KEY} provider-private-body`, { status });
        response.json = async () => { bodyRead = true; throw new Error(API_KEY); };
        return response;
      });
      const error = await expectError(createTypesafeEvaluator({
        fetchImpl, secrets: makeFakeSecrets({ TYPE_SAFE_AI: API_KEY }),
      }).evaluate(requestFixture()), 'HTTP');
      expect(error.status).toBe(status);
      expect(bodyRead).toBe(false);
      expect(requests).toHaveLength(1);
    });
  }

  test('sanitizes network errors and never retries', async () => {
    const { fetchImpl, requests } = makeFakeFetch(() => {
      throw new Error(`${API_KEY} provider-private-body Untrusted transcript`);
    });
    await expectError(createTypesafeEvaluator({
      fetchImpl, secrets: makeFakeSecrets({ TYPE_SAFE_AI: API_KEY }),
    }).evaluate(requestFixture()), 'NETWORK');
    expect(requests).toHaveLength(1);
  });

  test('sanitizes credential errors without submitting', async () => {
    const { fetchImpl, requests } = makeFakeFetch(() => Response.json(responseFixture()));
    const secrets: SecretSource = {
      async getSecret() { throw new Error(`${API_KEY} provider-private-body`); },
    };
    await expectError(createTypesafeEvaluator({ fetchImpl, secrets }).evaluate(requestFixture()), 'CREDENTIAL');
    expect(requests).toHaveLength(0);
  });

  test('malformed JSON is invalid and sanitized', async () => {
    const { fetchImpl, requests } = makeFakeFetch(() => new Response(`${API_KEY} provider-private-body`));
    await expectError(createTypesafeEvaluator({
      fetchImpl, secrets: makeFakeSecrets({ TYPE_SAFE_AI: API_KEY }),
    }).evaluate(requestFixture()), 'INVALID_RESPONSE');
    expect(requests).toHaveLength(1);
  });

  test('snapshots request data before resolving secrets', async () => {
    const pending = Promise.withResolvers<string>();
    const request = requestFixture();
    const original = structuredClone(request);
    const { fetchImpl, requests } = makeFakeFetch(() => Response.json(responseFixture()));
    const evaluator = createTypesafeEvaluator({ fetchImpl, secrets: { getSecret: () => pending.promise } });
    const result = evaluator.evaluate(request);
    request.model = 'changed';
    request.state.transcript = 'changed';
    request.questions.quality = { type: 'noul', instructions: 'changed' };
    pending.resolve(API_KEY);
    expect(await result).toEqual(responseFixture());
    expect(JSON.parse(requests[0]!.body!)).toEqual(original);
  });
});

describe('Typesafe conservative preflight limits', () => {
  test('public preflight is synchronous, network-free and leaves the request unchanged', () => {
    const request = requestFixture();
    const original = structuredClone(request);
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((() => {
      throw new Error('Preflight must not access the network');
    }) as unknown as FetchLike);
    try {
      expect(validateTypesafeRequest(request)).toBeUndefined();
      expect(request).toEqual(original);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  for (const [name, mutate] of [
    ['state plus question', (request: TypesafeEvaluationRequest) => {
      request.state.transcript = 'a'.repeat(28_000);
    }],
    ['UTF-8 not character count', (request: TypesafeEvaluationRequest) => {
      request.state.transcript = '🙂'.repeat(7_000);
    }],
    ['total serialized payload', (request: TypesafeEvaluationRequest) => {
      request.questions = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [
        `question_${index}`, { type: 'noul', instructions: 'a'.repeat(7_000) },
      ]));
    }],
  ] as const) {
    test(`rejects ${name} before secrets or network`, async () => {
      const request = requestFixture();
      mutate(request);
      const secrets = makeFakeSecrets({ TYPE_SAFE_AI: API_KEY });
      const { fetchImpl, requests } = makeFakeFetch(() => Response.json(responseFixture()));
      expect(() => validateTypesafeRequest(request)).toThrow(TypesafeEvaluationError);
      await expectError(createTypesafeEvaluator({ fetchImpl, secrets }).evaluate(request), 'PAYLOAD_LIMIT');
      expect(secrets.resolved).toHaveLength(0);
      expect(requests).toHaveLength(0);
    });
  }

  test('rejects invalid question requests and cyclic JSON before secrets', async () => {
    const invalid = requestFixture();
    invalid.questions.quality = { type: 'score', instructions: 'Rate.', criteria: ['Only'] };
    const cyclic = requestFixture();
    cyclic.state.self = cyclic.state;
    const secrets = makeFakeSecrets({ TYPE_SAFE_AI: API_KEY });
    const { fetchImpl, requests } = makeFakeFetch(() => Response.json(responseFixture()));
    const evaluator = createTypesafeEvaluator({ fetchImpl, secrets });
    expect(() => validateTypesafeRequest(invalid)).toThrow(TypesafeEvaluationError);
    expect(() => validateTypesafeRequest(cyclic)).toThrow(TypesafeEvaluationError);
    await expectError(evaluator.evaluate(invalid), 'INVALID_REQUEST');
    await expectError(evaluator.evaluate(cyclic), 'INVALID_REQUEST');
    expect(secrets.resolved).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });
});

describe('Typesafe full-call timeout and cancellation', () => {
  for (const code of ['TIMEOUT', 'ABORTED'] as const) {
    test(`${code} includes secret resolution and prevents late submission`, async () => {
      const pending = Promise.withResolvers<string>();
      const controller = new AbortController();
      const { fetchImpl, requests } = makeFakeFetch(() => Response.json(responseFixture()));
      const evaluator = createTypesafeEvaluator({
        fetchImpl, secrets: { getSecret: () => pending.promise }, timeoutMs: code === 'TIMEOUT' ? 15 : 1_000,
      });
      const result = evaluator.evaluate(requestFixture(), controller.signal);
      if (code === 'ABORTED') controller.abort(`${API_KEY} provider-private-body`);
      await expectError(result, code);
      pending.resolve(API_KEY);
      await Promise.resolve();
      await Promise.resolve();
      expect(requests).toHaveLength(0);
    });

    for (const stage of ['fetch', 'body'] as const) {
      test(`${code} includes ${stage} even if the injected implementation ignores cancellation`, async () => {
        const pending = Promise.withResolvers<Response>();
        const body = Promise.withResolvers<unknown>();
        const entered = Promise.withResolvers<void>();
        const controller = new AbortController();
        let transportSignal: AbortSignal | null | undefined;
        let calls = 0;
        const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
          calls++;
          transportSignal = init?.signal;
          if (stage === 'fetch') {
            entered.resolve();
            return pending.promise;
          }
          const response = Response.json(responseFixture());
          response.json = () => { entered.resolve(); return body.promise; };
          return response;
        }) as FetchLike;
        const evaluator = createTypesafeEvaluator({
          fetchImpl, secrets: makeFakeSecrets({ TYPE_SAFE_AI: API_KEY }),
          timeoutMs: code === 'TIMEOUT' ? 15 : 1_000,
        });
        const result = evaluator.evaluate(requestFixture(), controller.signal);
        const checked = expectError(result, code);
        await entered.promise;
        if (code === 'ABORTED') controller.abort(`${API_KEY} provider-private-body`);
        await checked;
        expect(transportSignal?.aborted).toBe(true);
        expect(calls).toBe(1);
        pending.resolve(Response.json(responseFixture()));
        body.resolve(responseFixture());
      });
    }
  }

  test('already aborted caller never resolves credentials', async () => {
    const controller = new AbortController();
    controller.abort(API_KEY);
    const secrets = makeFakeSecrets({ TYPE_SAFE_AI: API_KEY });
    const { fetchImpl, requests } = makeFakeFetch(() => Response.json(responseFixture()));
    await expectError(createTypesafeEvaluator({ fetchImpl, secrets }).evaluate(
      requestFixture(), controller.signal,
    ), 'ABORTED');
    expect(secrets.resolved).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  test('disables redirects instead of forwarding credentials to another host', async () => {
    let redirect: RequestRedirect | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      redirect = init?.redirect;
      return Response.json(responseFixture());
    }) as FetchLike;
    await createTypesafeEvaluator({
      fetchImpl, secrets: makeFakeSecrets({ TYPE_SAFE_AI: API_KEY }),
    }).evaluate(requestFixture());
    expect(redirect).toBe('error');
  });
});
