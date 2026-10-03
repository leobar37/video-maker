import { isRecord } from '@videomaker/core';
import type { FetchLike, SecretSource } from './ports';
import { createSecretSource } from './secrets';

export interface TypesafeScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: readonly string[];
}

export interface TypesafeNoulQuestion {
  type: 'noul';
  instructions: string;
}

export type TypesafeQuestion = TypesafeScoreQuestion | TypesafeNoulQuestion;

export interface TypesafeEvaluationRequest {
  state: Record<string, unknown>;
  model: string;
  questions: Record<string, TypesafeQuestion>;
}

export interface TypesafeScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
}

export interface TypesafeNoulAnswer {
  type: 'noul';
  noul: number;
}

export type TypesafeAnswer = TypesafeScoreAnswer | TypesafeNoulAnswer;

export interface TypesafeEvaluationResponse {
  model: string;
  answers: Record<string, TypesafeAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

export type TypesafeEvaluationErrorCode =
  | 'INVALID_REQUEST'
  | 'PAYLOAD_LIMIT'
  | 'CREDENTIAL'
  | 'HTTP'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'INVALID_RESPONSE';

const ERROR_MESSAGES: Record<TypesafeEvaluationErrorCode, string> = {
  INVALID_REQUEST: 'Invalid Typesafe evaluation request.',
  PAYLOAD_LIMIT: 'Typesafe evaluation exceeds the conservative payload limit.',
  CREDENTIAL: 'Typesafe API credential resolution failed.',
  HTTP: 'Typesafe evaluation returned an unsuccessful HTTP status.',
  NETWORK: 'Typesafe evaluation transport failed.',
  TIMEOUT: 'Typesafe evaluation timed out.',
  ABORTED: 'Typesafe evaluation was cancelled.',
  INVALID_RESPONSE: 'Typesafe evaluation returned an invalid response.',
};

/** Never carries upstream messages, response bodies, secret values or causes. */
export class TypesafeEvaluationError extends Error {
  readonly code: TypesafeEvaluationErrorCode;
  readonly status?: number;

  constructor(code: TypesafeEvaluationErrorCode, status?: number) {
    super(ERROR_MESSAGES[code]);
    this.name = 'TypesafeEvaluationError';
    this.code = code;
    if (status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599) {
      this.status = status;
    }
  }
}

export interface CreateTypesafeEvaluatorOptions {
  fetchImpl?: FetchLike;
  secrets?: SecretSource;
  timeoutMs?: number;
}

export interface TypesafeEvaluator {
  evaluate(
    request: TypesafeEvaluationRequest,
    signal?: AbortSignal,
  ): Promise<TypesafeEvaluationResponse>;
}

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MAX_PAYLOAD_BYTES = 60_000;
const MAX_SINGLE_CONTEXT_BYTES = 28_000;
const PROBABILITY_TOLERANCE = 0.01;
const SCORE_TOLERANCE = 0.05;

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function inRange(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validateRequest(value: unknown): asserts value is TypesafeEvaluationRequest {
  if (!isRecord(value) || !isRecord(value.state) ||
    typeof value.model !== 'string' || !value.model.trim() ||
    !isRecord(value.questions) || Object.keys(value.questions).length === 0) {
    throw new TypesafeEvaluationError('INVALID_REQUEST');
  }
  for (const [id, question] of Object.entries(value.questions)) {
    if (!id.trim() || !isRecord(question) ||
      typeof question.instructions !== 'string' || !question.instructions.trim()) {
      throw new TypesafeEvaluationError('INVALID_REQUEST');
    }
    if (question.type === 'noul' && hasExactKeys(question, ['type', 'instructions'])) continue;
    if (question.type !== 'score' ||
      !hasExactKeys(question, ['type', 'instructions', 'criteria']) ||
      !Array.isArray(question.criteria) || question.criteria.length < 2 ||
      question.criteria.length > 10 ||
      !question.criteria.every((level) => typeof level === 'string' && level.trim())) {
      throw new TypesafeEvaluationError('INVALID_REQUEST');
    }
  }
}

/** Shared by live calls and persisted response caches; rejects all unknown fields. */
export function validateTypesafeResponse(
  value: unknown,
  request: TypesafeEvaluationRequest,
): TypesafeEvaluationResponse {
  validateRequest(request);
  const invalid = (): never => { throw new TypesafeEvaluationError('INVALID_RESPONSE'); };
  if (!isRecord(value) || !hasExactKeys(value, ['model', 'answers', 'usage']) ||
    value.model !== request.model || !isRecord(value.answers) || !isRecord(value.usage) ||
    !hasExactKeys(value.answers, Object.keys(request.questions)) ||
    !hasExactKeys(value.usage, ['input_tokens', 'output_tokens'])) return invalid();

  if (!inRange(value.usage.input_tokens, 0, 64_000) ||
    !Number.isSafeInteger(value.usage.input_tokens) ||
    !inRange(value.usage.output_tokens, 0, Number.MAX_SAFE_INTEGER) ||
    !Number.isSafeInteger(value.usage.output_tokens)) return invalid();

  for (const [id, question] of Object.entries(request.questions)) {
    const answer = value.answers[id];
    if (!isRecord(answer) || answer.type !== question.type) return invalid();
    if (question.type === 'noul') {
      if (!hasExactKeys(answer, ['type', 'noul']) || !inRange(answer.noul, 0, 1)) return invalid();
      continue;
    }
    const levels = question.criteria.map((_, index) => String(index));
    if (!hasExactKeys(answer, ['type', 'score', 'confidence', 'legend', 'probabilities']) ||
      !inRange(answer.score, 0, levels.length - 1) || !inRange(answer.confidence, 0, 1) ||
      !isRecord(answer.legend) || !isRecord(answer.probabilities) ||
      !hasExactKeys(answer.legend, levels) || !hasExactKeys(answer.probabilities, levels)) {
      return invalid();
    }
    let probabilitySum = 0;
    let expectedScore = 0;
    for (const [index, key] of levels.entries()) {
      const probability = answer.probabilities[key];
      if (!inRange(probability, 0, 1) || answer.legend[key] !== question.criteria[index]) {
        return invalid();
      }
      probabilitySum += probability;
      expectedScore += index * probability;
    }
    if (Math.abs(probabilitySum - 1) > PROBABILITY_TOLERANCE ||
      Math.abs(answer.score - expectedScore) > SCORE_TOLERANCE) return invalid();
  }
  return value as unknown as TypesafeEvaluationResponse;
}

function prepareRequest(request: TypesafeEvaluationRequest): {
  body: string;
  snapshot: TypesafeEvaluationRequest;
} {
  try {
    validateRequest(request);
    // Snapshot prevents caller mutation during asynchronous credential resolution.
    const body = JSON.stringify({ model: request.model, state: request.state, questions: request.questions });
    const snapshot: unknown = JSON.parse(body);
    validateRequest(snapshot);
    const utf8 = new TextEncoder();
    if (utf8.encode(body).byteLength > MAX_PAYLOAD_BYTES) {
      throw new TypesafeEvaluationError('PAYLOAD_LIMIT');
    }
    const exceedsSingleContext = Object.entries(snapshot.questions).some(([id, question]) =>
      utf8.encode(JSON.stringify({ state: snapshot.state, questions: { [id]: question } })).byteLength >
        MAX_SINGLE_CONTEXT_BYTES);
    if (exceedsSingleContext) {
      throw new TypesafeEvaluationError('PAYLOAD_LIMIT');
    }
    return { body, snapshot };
  } catch (error) {
    if (error instanceof TypesafeEvaluationError) throw error;
    throw new TypesafeEvaluationError('INVALID_REQUEST');
  }
}

/** Pure preflight for plan/run callers: validates shape and conservative byte limits. */
export function validateTypesafeRequest(request: TypesafeEvaluationRequest): void {
  prepareRequest(request);
}

/** Single POST, fixed HTTPS destination, no retry, no eager credential lookup. */
export function createTypesafeEvaluator(
  options: CreateTypesafeEvaluatorOptions = {},
): TypesafeEvaluator {
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new TypesafeEvaluationError('INVALID_REQUEST');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const secrets = options.secrets ?? createSecretSource({ fetchImpl });

  return {
    async evaluate(request, signal) {
      const { body, snapshot } = prepareRequest(request);
      if (signal?.aborted) throw new TypesafeEvaluationError('ABORTED');
      const controller = new AbortController();
      let cancellation: TypesafeEvaluationError | undefined;
      const cancelled = Promise.withResolvers<never>();
      const cancel = (code: 'TIMEOUT' | 'ABORTED'): void => {
        if (cancellation) return;
        cancellation = new TypesafeEvaluationError(code);
        controller.abort();
        cancelled.reject(cancellation);
      };
      const callerAbort = (): void => cancel('ABORTED');
      signal?.addEventListener('abort', callerAbort, { once: true });
      const timer = setTimeout(() => cancel('TIMEOUT'), timeoutMs);
      const checkCancelled = (): void => {
        if (cancellation) throw cancellation;
      };
      const execute = async (): Promise<TypesafeEvaluationResponse> => {
        let apiKey: string;
        try {
          apiKey = await secrets.getSecret('TYPE_SAFE_AI', 'run');
          checkCancelled();
          if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error();
        } catch {
          checkCancelled();
          throw new TypesafeEvaluationError('CREDENTIAL');
        }
        let response: Response;
        try {
          response = await fetchImpl(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body,
            signal: controller.signal,
            // Do not forward authorization to an upstream redirect destination.
            redirect: 'error',
          });
          checkCancelled();
        } catch {
          checkCancelled();
          throw new TypesafeEvaluationError('NETWORK');
        }
        if (!response.ok) throw new TypesafeEvaluationError('HTTP', response.status);
        let value: unknown;
        try {
          value = await response.json();
          checkCancelled();
        } catch {
          checkCancelled();
          throw new TypesafeEvaluationError('INVALID_RESPONSE');
        }
        return validateTypesafeResponse(value, snapshot);
      };
      try {
        return await Promise.race([execute(), cancelled.promise]);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', callerAbort);
      }
    },
  };
}
