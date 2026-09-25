/**
 * Zernio HTTP client.
 *
 * - The API key travels only in the `Authorization` header; it is never logged,
 *   never journalled and never included in error messages (NFR-001).
 * - Idempotent mutations carry the idempotency key in BOTH `Idempotency-Key`
 *   and `x-request-id`, so the remote can dedupe replays of the same intent.
 * - Explicit retry policy (NFR): `maxAttempts` bounds transport retries of
 *   SAFE (GET) requests only. Mutating requests (POST/PUT) are sent exactly
 *   once — a deduped/paid call is never silently retried, because a retry that
 *   the remote did not dedupe would double-publish or double-spend.
 */
import type { FetchLike } from '../ports';

export const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';

export interface ZernioClientOptions {
  /** API key (secret). Never leaves the Authorization header. */
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Explicit retry policy for GET requests; mutations are never retried. */
  maxAttempts?: number;
  /** Receives `method path → status` lines only; never the key. */
  logger?: (msg: string) => void;
}

export interface ZernioRequestInit {
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  /** Sent as `Idempotency-Key` and `x-request-id` on mutations. */
  idempotencyKey?: string;
}

export interface ZernioResponse {
  status: number;
  body: unknown;
}

/** The request never got a response: the remote outcome is unknown. */
export class ZernioTransportError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    cause: unknown,
  ) {
    super(`Zernio ${method} ${path} failed before a response: ${(cause as Error).message}`);
    this.name = 'ZernioTransportError';
    this.cause = cause;
  }
}

export class ZernioClient {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #maxAttempts: number;
  readonly #logger: ((msg: string) => void) | undefined;

  constructor(opts: ZernioClientOptions) {
    if (!opts.apiKey) throw new Error('ZernioClient requires an API key.');
    this.baseUrl = (opts.baseUrl ?? ZERNIO_BASE_URL).replace(/\/+$/, '');
    this.#apiKey = opts.apiKey;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 1);
    this.#logger = opts.logger;
  }

  /**
   * One request cycle. GET requests may retry up to `maxAttempts` on transport
   * errors (never on a response); mutations always make exactly one wire
   * attempt, so an ambiguous outcome surfaces as `ZernioTransportError` and
   * never as a silent second submit.
   */
  async request(path: string, init: ZernioRequestInit = {}): Promise<ZernioResponse> {
    const method = init.method ?? 'GET';
    const safe = method === 'GET';
    const attempts = safe ? this.#maxAttempts : 1;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': 'application/json',
    };
    if (init.idempotencyKey) {
      headers['Idempotency-Key'] = init.idempotencyKey;
      headers['x-request-id'] = init.idempotencyKey;
    }
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const url = `${this.baseUrl}${path}`;

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.#fetch(url, { method, headers, body });
      } catch (err) {
        lastError = err;
        if (attempt < attempts) continue;
        throw new ZernioTransportError(method, path, err);
      }
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Non-JSON bodies pass through as text.
      }
      this.#logger?.(`zernio ${method} ${path} → ${response.status}`);
      return { status: response.status, body: parsed };
    }
    /* c8 ignore next */
    throw new ZernioTransportError(method, path, lastError);
  }
}
