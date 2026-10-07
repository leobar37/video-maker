/**
 * Private object serving (contracts.md §4):
 * - Objects are addressed by SERVER-side lookups (resource row -> stored
 *   object key). No route ever accepts a client-supplied bucket/key.
 * - Staging keys are never servable: only verified, immutable final keys are
 *   streamed, and staging lives under a reserved prefix this module refuses.
 * - Every response is marked private/no-store, `nosniff`, locked-down CSP,
 *   and no-referrer; content types are the server-verified media types.
 * - GET supports single Range requests (MP4 seeking); HEAD returns exact
 *   metadata without a body. Unsatisfiable ranges answer 416 with the
 *   canonical asterisk-form Content-Range header.
 */

const STAGING_PREFIX = 'staging/';

export interface StoredObjectTarget {
  /** Server-resolved immutable object key (never client input). */
  key: string;
  /** Verified byte size recorded at finalize time. */
  size: number;
  /** Server-detected media type (magic signature verified at finalize). */
  contentType: string;
  /** Sanitized display filename for Content-Disposition. */
  filename: string;
}

export class StagingKeyRefusalError extends Error {
  constructor(key: string) {
    super(`refusing to serve staging key: ${key}`);
    this.name = 'StagingKeyRefusalError';
  }
}

export function assertNotStagingKey(key: string): void {
  if (key.startsWith(STAGING_PREFIX)) throw new StagingKeyRefusalError(key);
}

function safeFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
}

function baseHeaders(target: StoredObjectTarget): Headers {
  const headers = new Headers();
  headers.set('content-type', target.contentType);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', 'private, no-store');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'; sandbox");
  headers.set('referrer-policy', 'no-referrer');
  headers.set('content-disposition', `inline; filename="${safeFilename(target.filename)}"`);
  return headers;
}

interface ParsedRange {
  start: number;
  length: number;
}

/**
 * Parses a single-range `bytes=` header (RFC 9110 §14). Multi-range and
 * syntactically invalid headers return null (serve the full representation);
 * syntactically valid but unsatisfiable ranges return 'unsatisfiable'.
 */
export function parseRangeHeader(header: string | null, size: number): ParsedRange | 'unsatisfiable' | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null; // multi-range or malformed: full representation
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    // Suffix form: last N bytes.
    const suffix = Number.parseInt(rawEnd!, 10);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    const start = Math.max(0, size - suffix);
    return { start, length: size - start };
  }

  const start = Number.parseInt(rawStart!, 10);
  if (start >= size) return 'unsatisfiable';
  if (rawEnd === '') return { start, length: size - start };
  const end = Math.min(Number.parseInt(rawEnd!, 10), size - 1);
  if (end < start) return null; // malformed: ignore
  return { start, length: end - start + 1 };
}

export type ServeOutcome =
  | { ok: true; response: Response }
  | { ok: false; missing: true };

/**
 * Streams a verified, immutable object with authorization already performed
 * by the caller. GET honors a single Range; HEAD answers metadata only. The
 * stored row (size/type) is authoritative; R2 only supplies bytes.
 */
export async function serveStoredObject(
  request: Request,
  bucket: R2Bucket,
  target: StoredObjectTarget,
): Promise<ServeOutcome> {
  assertNotStagingKey(target.key);

  if (request.method === 'HEAD') {
    const headers = baseHeaders(target);
    headers.set('content-length', String(target.size));
    return { ok: true, response: new Response(null, { status: 200, headers }) };
  }

  const range = parseRangeHeader(request.headers.get('range'), target.size);
  if (range === 'unsatisfiable') {
    const headers = baseHeaders(target);
    headers.set('content-range', `bytes */${target.size}`);
    return {
      ok: true,
      response: new Response(null, { status: 416, headers }),
    };
  }

  const object =
    range === null
      ? await bucket.get(target.key)
      : await bucket.get(target.key, { range: { offset: range.start, length: range.length } });
  if (object === null) return { ok: false, missing: true };

  const headers = baseHeaders(target);
  if (range === null) {
    headers.set('content-length', String(target.size));
    return { ok: true, response: new Response(object.body, { status: 200, headers }) };
  }
  headers.set('content-length', String(range.length));
  headers.set('content-range', `bytes ${range.start}-${range.start + range.length - 1}/${target.size}`);
  return { ok: true, response: new Response(object.body, { status: 206, headers }) };
}

/** Deterministic final keys (content-addressed; server-side composition only). */
export const storageKeys = {
  materialFinal(clientId: string, sha256Hex: string): string {
    return `materials/${clientId}/${sha256Hex}`;
  },
  deliveryOutputFinal(deliveryId: string, sha256Hex: string): string {
    return `deliveries/${deliveryId}/${sha256Hex}`;
  },
  staging(): string {
    return `${STAGING_PREFIX}${crypto.randomUUID()}`;
  },
};
