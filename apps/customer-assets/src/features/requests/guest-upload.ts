/**
 * Guest upload engine (R-2, contracts.md §5): the SAME init → PUT with real
 * byte progress (XHR) → complete protocol as the member uploader, but against
 * the guest-direct endpoints `/api/v1/r/:token/...` — no credential header,
 * no cookie, no session. Client-side pre-checks (classifyFile) mirror the
 * server contract; retries reuse the SAME idempotency key.
 */

import type {
  GuestCompleteResult,
  GuestPutUploadResult,
  GuestUploadSessionView,
  V1MediaType,
} from '@videomaker/customer-assets';
import { classifyFile, type UploadProgress } from '../../api/upload';

/** Transport seam: the default talks to the live guest API; tests inject fakes. */
export interface GuestUploadTransport {
  init(token: string, request: { mediaType: V1MediaType; declaredBytes: number; name?: string }, idempotencyKey: string): Promise<GuestUploadSessionView>;
  put(token: string, uploadId: string, body: Blob, contentType: string, onProgress: (loaded: number, total: number) => void): Promise<GuestPutUploadResult>;
  complete(token: string, uploadId: string): Promise<GuestCompleteResult>;
}

/** Rejects with the parsed API envelope message; never echoes the token. */
async function guestJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    let message = `Error ${response.status} durante la carga.`;
    try {
      const parsed = (await response.json()) as { error?: { message?: string } };
      message = parsed.error?.message ?? message;
    } catch {
      /* keep fallback */
    }
    throw new Error(message);
  }
  return response.json();
}

function xhrPut(url: string, body: Blob, contentType: string, onProgress: (loaded: number, total: number) => void): Promise<GuestPutUploadResult> {
  const { promise, resolve, reject } = Promise.withResolvers<GuestPutUploadResult>();
  const xhr = new XMLHttpRequest();
  xhr.open('PUT', url);
  xhr.setRequestHeader('content-type', contentType);
  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) onProgress(event.loaded, event.total);
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        resolve(JSON.parse(xhr.responseText) as GuestPutUploadResult);
      } catch {
        reject(new Error('Respuesta de carga no interpretable.'));
      }
      return;
    }
    let message = `Error ${xhr.status} durante la carga.`;
    try {
      const parsed = JSON.parse(xhr.responseText) as { error?: { message?: string } };
      message = parsed.error?.message ?? message;
    } catch {
      /* keep fallback */
    }
    reject(new Error(message));
  };
  xhr.onerror = () => reject(new Error('La conexión falló durante la carga.'));
  xhr.onabort = () => reject(new Error('Carga cancelada.'));
  xhr.send(body);
  return promise;
}

/** Default transport against the guest-direct API (token in the path only). */
export function createGuestUploadTransport(): GuestUploadTransport {
  return {
    async init(token, request, idempotencyKey) {
      const response = await fetch(`/api/v1/r/${encodeURIComponent(token)}/uploads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(request),
      });
      return (await guestJson(response)) as GuestUploadSessionView;
    },
    put(token, uploadId, body, contentType, onProgress) {
      return xhrPut(`/api/v1/r/${encodeURIComponent(token)}/uploads/${encodeURIComponent(uploadId)}/content`, body, contentType, onProgress);
    },
    async complete(token, uploadId) {
      const response = await fetch(`/api/v1/r/${encodeURIComponent(token)}/uploads/${encodeURIComponent(uploadId)}/complete`, {
        method: 'POST',
      });
      return (await guestJson(response)) as GuestCompleteResult;
    },
  };
}

export interface RunGuestUploadInput {
  token: string;
  file: File;
  idempotencyKey: string;
  transport?: GuestUploadTransport;
  onProgress: (progress: UploadProgress) => void;
}

/** Drives one guest material upload to `done` or throws (message is display-safe). */
export async function runGuestUpload(input: RunGuestUploadInput): Promise<GuestCompleteResult> {
  const transport = input.transport ?? createGuestUploadTransport();
  const classified = classifyFile(input.file);
  if ('reason' in classified) {
    throw new Error(classified.message);
  }
  input.onProgress({ phase: 'starting', loaded: 0, total: input.file.size });
  const session = await transport.init(
    input.token,
    { mediaType: classified.mediaType, declaredBytes: input.file.size, name: input.file.name },
    input.idempotencyKey,
  );
  input.onProgress({ phase: 'uploading', loaded: 0, total: input.file.size });
  await transport.put(input.token, session.uploadId, input.file, classified.mediaType, (loaded, total) => {
    input.onProgress({ phase: 'uploading', loaded, total });
  });
  input.onProgress({ phase: 'finishing', loaded: input.file.size, total: input.file.size });
  const result = await transport.complete(input.token, session.uploadId);
  input.onProgress({ phase: 'done', loaded: input.file.size, total: input.file.size });
  return result;
}
