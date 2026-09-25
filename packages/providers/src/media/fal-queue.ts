/**
 * fal.ai queue REST helpers shared by the fal media adapters: queue receipt
 * parsing, job-state mapping, result URL extraction, storage upload and
 * provider-detail redaction.
 *
 * NFR-001: the API key travels ONLY in the `Authorization` request header —
 * never in URLs, bodies, logs, receipts or journals.
 */
import type {
  FetchLike,
  MediaJobState,
  MediaJobStatus,
  ProviderContext,
} from '../ports';
import { MediaProviderError, type MediaSourceInput } from './common';

export const FAL_QUEUE_BASE = 'https://queue.fal.run';
export const FAL_STORAGE_BASE = 'https://rest.alpha.fal.ai/storage';

/** Credential contract of every fal call: header-only, never logged. */
export async function falCredentials(ctx: ProviderContext): Promise<string> {
  return ctx.secrets.getSecret('FAL_KEY', ctx.mode);
}

/** The only place the fal key becomes a request header. */
export function falAuthHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' };
}

export interface FalQueueReceipt {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
}

/** Parses the documented queue submit response; anything else is no receipt. */
export function parseQueueReceipt(payload: unknown): FalQueueReceipt {
  if (!payload || typeof payload !== 'object') {
    throw new MediaProviderError('INVALID_RECEIPT', 'fal returned an invalid queue response.');
  }
  const record = payload as Record<string, unknown>;
  const requestId = record.request_id ?? record.requestId;
  const statusUrl = record.status_url ?? record.statusUrl;
  const responseUrl = record.response_url ?? record.responseUrl;
  if (
    typeof requestId !== 'string' ||
    typeof statusUrl !== 'string' ||
    typeof responseUrl !== 'string'
  ) {
    throw new MediaProviderError(
      'INVALID_RECEIPT',
      'fal did not return request_id, status_url and response_url; the submit has no receipt.',
    );
  }
  return { requestId, statusUrl, responseUrl };
}

const FAL_STATUS_STATES: Record<string, MediaJobState> = {
  IN_QUEUE: 'queued',
  SUBMITTED: 'queued',
  IN_PROGRESS: 'running',
  COMPLETED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'failed',
};

/** Maps a fal queue status to the port's job states; unknown states fail loudly. */
export function falJobStatus(status: unknown): MediaJobStatus {
  const normalized = String(status ?? '').toUpperCase();
  const state = FAL_STATUS_STATES[normalized];
  if (!state) {
    throw new MediaProviderError(
      'UNKNOWN_PROVIDER_STATUS',
      `fal returned an unknown status: ${sanitizeProviderDetail(normalized)}`,
    );
  }
  return { state, detail: `fal status ${normalized}` };
}

const RESULT_URL_KEYS: Record<string, true> = {
  url: true,
  video_url: true,
  videoUrl: true,
  file_url: true,
  fileUrl: true,
  download_url: true,
  downloadUrl: true,
  audio_url: true,
  audioUrl: true,
};

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Extracts a generated media URL without trusting one fixed fal response shape.
 * Keys that name statuses/responses/images are skipped so an input preview is
 * never mistaken for the result.
 */
export function extractResultUrl(payload: unknown): string | undefined {
  const visited = new Set<object>();
  const visit = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    if (visited.has(value)) return undefined;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item);
        if (found) return found;
      }
      return undefined;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        RESULT_URL_KEYS[key] &&
        isHttpUrl(child) &&
        !/status|response|image/i.test(key) &&
        !/\.(png|jpe?g|webp)(?:$|[?#])/i.test(child)
      ) {
        return child;
      }
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(payload);
}

/**
 * Redacts provider error text before it reaches logs or errors: auth headers,
 * key assignments and full URLs never leak (NFR-001).
 */
export function sanitizeProviderDetail(value: unknown): string {
  const text =
    typeof value === 'string' ? value : value instanceof Error ? value.message : String(value);
  return text
    .replace(/(?:Key|Bearer)\s+[A-Za-z0-9._-]+/gi, (match) => {
      const scheme = match.split(/\s+/, 1)[0] ?? 'auth';
      return `${scheme} [redacted]`;
    })
    .replace(/FAL_KEY\s*=\s*\S+/gi, 'FAL_KEY=[redacted]')
    .replace(/https?:\/\/[^\s]+/gi, '[provider-url]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export interface FalUploadTarget {
  uploadUrl: string;
  fileUrl: string;
  contentType: string;
}

/** Step 1 of the fal storage upload: negotiate a presigned PUT target. */
export async function initiateFalUpload(
  ctx: ProviderContext,
  input: { filename: string; contentType: string },
): Promise<FalUploadTarget> {
  const apiKey = await falCredentials(ctx);
  const response = await ctx.fetchImpl(`${FAL_STORAGE_BASE}/upload/initiate`, {
    method: 'POST',
    headers: falAuthHeaders(apiKey),
    body: JSON.stringify({ file_name: input.filename, content_type: input.contentType }),
  });
  if (!response.ok) {
    throw new MediaProviderError(
      'UPLOAD_FAILED',
      `fal upload initiate ${response.status}: ${sanitizeProviderDetail(await response.text().catch(() => ''))}`,
    );
  }
  const payload: unknown = await response.json();
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const uploadUrl = record.upload_url ?? record.uploadUrl;
  const fileUrl = record.file_url ?? record.fileUrl;
  if (typeof uploadUrl !== 'string' || typeof fileUrl !== 'string') {
    throw new MediaProviderError(
      'UPLOAD_FAILED',
      'fal upload initiate did not return upload_url and file_url.',
    );
  }
  return { uploadUrl, fileUrl, contentType: input.contentType };
}

const DEFAULT_UPLOAD_CONTENT_TYPE = 'application/octet-stream';

/**
 * Uploads an input asset to the fal CDN (queue submits reference hosted URLs).
 * Free, not a paid submit; local bytes go through the presigned PUT dance.
 */
export async function uploadToFalStorage(
  ctx: ProviderContext,
  source: MediaSourceInput,
): Promise<{ url: string; bytes: number }> {
  if ('url' in source) return { url: source.url, bytes: 0 };
  const contentType = source.contentType ?? DEFAULT_UPLOAD_CONTENT_TYPE;
  const target = await initiateFalUpload(ctx, { filename: source.filename, contentType });
  const put = await ctx.fetchImpl(target.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    // Fresh copy with an exact-size ArrayBuffer backing (fetch BodyInit).
    body: new Uint8Array(source.bytes).buffer,
  });
  if (!put.ok) {
    throw new MediaProviderError(
      'UPLOAD_FAILED',
      `fal upload PUT ${put.status}: ${sanitizeProviderDetail(await put.text().catch(() => ''))}`,
    );
  }
  return { url: target.fileUrl, bytes: source.bytes.byteLength };
}

/** Downloads a provider-hosted artifact. */
export async function downloadProviderBytes(
  fetchImpl: FetchLike,
  url: string,
): Promise<Uint8Array> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new MediaProviderError(
      'DOWNLOAD_FAILED',
      `artifact download ${response.status}: ${sanitizeProviderDetail(url)}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}
