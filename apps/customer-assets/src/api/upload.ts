/**
 * Material upload engine (contracts.md §4, FR-003): init → authenticated PUT
 * with REAL byte progress (XHR upload events; fetch has no upload progress) →
 * complete. Client-side pre-checks reject unsupported types (HEIC gets an
 * explicit explanation, no fake conversion) and over-limit sizes before any
 * network round. Retries reuse the SAME idempotency key, so a failed PUT
 * re-drives the pending session instead of creating a duplicate.
 */

import type {
  ErrorCode,
  InitUploadRequest,
  MaterialView,
  PutUploadResult,
  UploadSessionView,
  V1MediaType,
} from '@videomaker/customer-assets';
import { V1_MEDIA_TYPES } from '@videomaker/customer-assets';
import { portal } from './client';

/** v1 format limits — MUST mirror the server's V1_TYPE_LIMIT_BYTES (uploads.ts). */
export const MEDIA_LIMIT_BYTES: Record<V1MediaType, number> = {
  'image/jpeg': 20 * 1024 * 1024,
  'image/png': 20 * 1024 * 1024,
  'image/webp': 20 * 1024 * 1024,
  'video/mp4': 50 * 1024 * 1024,
};

export const HEIC_NOTICE =
  'HEIC/HEIF (iPhone) no está soportado todavía: convierte la foto a JPEG antes de subirla.';

export const LIMITS_NOTICE =
  'Formatos: JPEG, PNG o WebP hasta 20 MiB · MP4 hasta 50 MiB. HEIC no soportado.';

export type RejectionReason = 'unsupported' | 'oversized';

export interface FileRejection {
  reason: RejectionReason;
  message: string;
}

const EXTENSION_MEDIA_TYPES: Record<string, V1MediaType> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  mp4: 'video/mp4',
};

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * Maps a browser File to a v1 media type. Browser `file.type` is trusted ONLY
 * when it names a v1 type; otherwise the extension decides (browsers report
 * HEIC inconsistently). Anything else is unsupported — HEIC names get the
 * explicit conversion notice.
 */
export function classifyFile(file: { name: string; type: string; size: number }): { mediaType: V1MediaType } | FileRejection {
  const extension = extensionOf(file.name);
  if (extension === 'heic' || extension === 'heif' || file.type === 'image/heic' || file.type === 'image/heif') {
    return { reason: 'unsupported', message: HEIC_NOTICE };
  }
  const declared = (V1_MEDIA_TYPES as readonly string[]).includes(file.type)
    ? (file.type as V1MediaType)
    : EXTENSION_MEDIA_TYPES[extension];
  if (declared === undefined) {
    return {
      reason: 'unsupported',
      message: `Formato no soportado (${extension === '' ? 'sin extensión' : `.${extension}`}). ${LIMITS_NOTICE}`,
    };
  }
  if (file.size > MEDIA_LIMIT_BYTES[declared]) {
    const limitMiB = Math.round(MEDIA_LIMIT_BYTES[declared] / (1024 * 1024));
    return { reason: 'oversized', message: `El archivo supera el límite de ${limitMiB} MiB para este formato.` };
  }
  return { mediaType: declared };
}

export type UploadPhase = 'ready' | 'starting' | 'uploading' | 'finishing' | 'done' | 'failed';

export interface UploadProgress {
  phase: UploadPhase;
  loaded: number;
  total: number;
}

/** Transport seam: the default talks to the live API; tests inject fakes. */
export interface UploadTransport {
  init(clientId: string, request: InitUploadRequest, idempotencyKey: string): Promise<UploadSessionView>;
  put(uploadId: string, body: Blob, contentType: string, onProgress: (loaded: number, total: number) => void): Promise<PutUploadResult>;
  complete(uploadId: string): Promise<{ material?: MaterialView }>;
}

export type UploadTransportError = Error & { status?: number; code?: ErrorCode };

/** Resolves when the transfer settles; rejects with the parsed API envelope. */
function xhrPut(
  url: string,
  body: Blob,
  contentType: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<PutUploadResult> {
  const { promise, resolve, reject } = Promise.withResolvers<PutUploadResult>();
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', url);
  xhr.setRequestHeader('content-type', contentType);
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) onProgress(event.loaded, event.total);
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        resolve(JSON.parse(xhr.responseText) as PutUploadResult);
      } catch {
        reject(new Error('Respuesta de carga no interpretable.'));
      }
      return;
    }
    let code: ErrorCode = 'internal';
    let message = `Error ${xhr.status} durante la carga.`;
    try {
      const parsed = JSON.parse(xhr.responseText) as { error?: { code?: ErrorCode; message?: string } };
      code = parsed.error?.code ?? code;
      message = parsed.error?.message ?? message;
    } catch {
      /* keep fallbacks */
    }
    const failure = Object.assign(new Error(message), { status: xhr.status, code }) as UploadTransportError;
    reject(failure);
  };
  xhr.onerror = () => reject(new Error('La conexión falló durante la carga.'));
  xhr.onabort = () => reject(new Error('Carga cancelada.'));
  xhr.send(body);
  return promise;
}

/** Default transport against the emulated/live portal API. */
export function createPortalUploadTransport(): UploadTransport {
  return {
    init: (clientId, request, idempotencyKey) => portal.initUpload(clientId, request, idempotencyKey),
    put: (uploadId, body, contentType, onProgress) =>
      xhrPut(`/api/v1/uploads/${encodeURIComponent(uploadId)}/content`, body, contentType, onProgress),
    complete: async (uploadId) => ({ material: await portal.completeUpload(uploadId) }),
  };
}

export interface RunUploadInput {
  clientId: string;
  file: File;
  /** Stable across retries of the SAME selection (dedup + resume semantics). */
  idempotencyKey: string;
  transport?: UploadTransport;
  onProgress: (progress: UploadProgress) => void;
}

/**
 * Drives one material upload to `done` or throws. Progress phases: starting
 * (init), uploading (real bytes), finishing (complete + D1 ready commit).
 */
export async function runMaterialUpload(input: RunUploadInput): Promise<MaterialView> {
  const transport = input.transport ?? createPortalUploadTransport();
  const classified = classifyFile(input.file);
  if ('reason' in classified) {
    // Pre-checks mirror the server's contract locally; the server re-checks.
    const code: ErrorCode = classified.reason === 'oversized' ? 'payload_too_large' : 'unsupported_media_type';
    throw Object.assign(new Error(classified.message), { code }) as UploadTransportError;
  }
  input.onProgress({ phase: 'starting', loaded: 0, total: input.file.size });
  const session = await transport.init(
    input.clientId,
    {
      kind: 'material',
      mediaType: classified.mediaType,
      declaredBytes: input.file.size,
      name: input.file.name,
    },
    input.idempotencyKey,
  );
  input.onProgress({ phase: 'uploading', loaded: 0, total: input.file.size });
  await transport.put(session.uploadId, input.file, classified.mediaType, (loaded, total) => {
    input.onProgress({ phase: 'uploading', loaded, total });
  });
  input.onProgress({ phase: 'finishing', loaded: input.file.size, total: input.file.size });
  const { material } = await transport.complete(session.uploadId);
  if (!material) throw new Error('La carga no produjo un material.');
  input.onProgress({ phase: 'done', loaded: input.file.size, total: input.file.size });
  return material;
}
