/**
 * Test seams shared by the media adapter test suites: fake transports that
 * record every call (fetch, secrets, processes) and a fixed clock. Nothing
 * here touches the network — tests must stay fully offline.
 */
import type {
  Clock,
  FetchLike,
  ProcessResult,
  ProcessRunner,
  SecretSource,
} from '../ports';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface FakeFetch {
  fetchImpl: FetchLike;
  requests: RecordedRequest[];
}

/**
 * Builds a `FetchLike` that records every request and delegates to `handler`.
 * The recorder doubles as the network assertion surface (call counts, URLs,
 * headers).
 */
export function makeFakeFetch(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
): FakeFetch {
  const requests: RecordedRequest[] = [];
  // Bun's `typeof fetch` carries extra statics (preconnect) the recorder does
  // not need; the seam only implements the call surface.
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : String((input as { url?: string }).url ?? input);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(init?.headers ?? {})) {
      headers[key.toLowerCase()] = String(value);
    }
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const request: RecordedRequest = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      ...(body !== undefined ? { body } : {}),
    };
    requests.push(request);
    return handler(request);
  }) as unknown as FetchLike;
  return { fetchImpl, requests };
}

export interface FakeSecrets extends SecretSource {
  /** Secret names resolved so far (order preserved). */
  resolved: string[];
}

/** Secrets that count every resolution; values are test-only fixtures. */
export function makeFakeSecrets(values: Record<string, string>): FakeSecrets {
  const resolved: string[] = [];
  return {
    resolved,
    async getSecret(name: string): Promise<string> {
      resolved.push(name);
      const value = values[name];
      if (value === undefined) throw new Error(`fake secrets have no ${name}`);
      return value;
    },
  };
}

/** Fixed clock for deterministic timestamps. */
export function fixedClock(iso: string): Clock {
  return { now: () => new Date(iso) };
}

export interface FakeProcessCall {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface FakeProcessRunner extends ProcessRunner {
  calls: FakeProcessCall[];
}

/**
 * ProcessRunner fake: records calls and lets the test produce each result
 * (e.g. writing fake transcode output to the destination path).
 */
export function makeFakeProcessRunner(
  handle: (call: FakeProcessCall) => Partial<ProcessResult> | Promise<Partial<ProcessResult>>,
): FakeProcessRunner {
  const calls: FakeProcessCall[] = [];
  return {
    calls,
    async run(command, args, opts) {
      const call: FakeProcessCall = {
        command,
        args,
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.env !== undefined ? { env: opts.env } : {}),
      };
      calls.push(call);
      const result = await handle(call);
      return {
        code: result.code ?? 0,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
  };
}

/** JSON response helper for fake fetch handlers. */
export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
