import { useCallback, useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import type { GuestAssetLinkView, GuestPutUploadResult, GuestUploadSessionView, V1MediaType } from '@videomaker/customer-assets';
import { errorMessage } from '../api/client';
import { LIMITS_NOTICE, classifyFile, type UploadProgress } from '../api/upload';
import { FormActions } from '../components/forms/fields';
import { Badge, ErrorBanner, ProgressBar, Spinner, formatBytes } from '../components/ui/primitives';
import { Dropzone } from '../components/ui/dropzone';
import { useDocumentTitle } from '../components/ui/head';
import '../styles/portal.css';

/**
 * Guest-direct ASSET upload page (operator order 2026-10-06; contratos
 * aditivos §9 · customer-assets-requests): public route OUTSIDE the `_app`
 * auth layout — no RequireAuth, no session provider, no redirect. The
 * capability token in the path is the ONLY credential, so this route never
 * triggers or renders a login prompt. It shows ONLY this asset+project
 * (titles, expiry, state, remaining CLIENT quota — never the catalog,
 * deliveries, other assets or any other client's data) and drives the
 * guest-direct asset endpoints `/api/v1/a/:token/...`. no-store via head
 * meta: no link state may leak between tokens (NFR-104).
 *
 * NOTE (coordinator merge): this page intentionally duplicates the minimal
 * skeleton of features/requests/RequestPage.tsx (worker UI-DENSITY owns
 * features/components) instead of touching mid-refactor shared files. The
 * upload engine below mirrors features/requests/guest-upload.ts against the
 * /api/v1/a/ family; merge into a shared GuestUploadSurface when both sides
 * land.
 */

const STATE_TEXT: Record<GuestAssetLinkView['state'], string> = {
  open: 'Enlace abierto',
  used: 'Enlace ya usado',
  closed: 'Enlace cerrado',
  expired: 'Enlace vencido',
};

async function fetchAssetView(token: string): Promise<GuestAssetLinkView> {
  const response = await fetch(`/api/v1/a/${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(parsed?.error?.message ?? 'Este enlace no es válido o ha vencido.');
  }
  return (await response.json()) as GuestAssetLinkView;
}

/** Rejects with the parsed API envelope message; never echoes the token. */
async function guestJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(parsed?.error?.message ?? 'La carga falló. Probá de nuevo.');
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

interface GuestAssetUploadItem {
  id: string;
  fileName: string;
  progress: UploadProgress;
  message: string | null;
  failed: boolean;
}

async function runAssetUpload(
  token: string,
  file: File,
  idempotencyKey: string,
  onProgress: (progress: UploadProgress) => void,
): Promise<GuestAssetLinkView> {
  const classified = classifyFile(file);
  if ('reason' in classified) {
    throw new Error(classified.message);
  }
  onProgress({ phase: 'starting', loaded: 0, total: file.size });
  const initResponse = await fetch(`/api/v1/a/${encodeURIComponent(token)}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ mediaType: classified.mediaType as V1MediaType, declaredBytes: file.size, name: file.name }),
  });
  const session = (await guestJson(initResponse)) as GuestUploadSessionView;
  onProgress({ phase: 'uploading', loaded: 0, total: file.size });
  const put = await xhrPut(
    `/api/v1/a/${encodeURIComponent(token)}/uploads/${encodeURIComponent(session.uploadId)}/content`,
    file,
    classified.mediaType,
    (loaded, total) => onProgress({ phase: 'uploading', loaded, total }),
  );
  void put;
  onProgress({ phase: 'finishing', loaded: file.size, total: file.size });
  const completeResponse = await fetch(`/api/v1/a/${encodeURIComponent(token)}/uploads/${encodeURIComponent(session.uploadId)}/complete`, {
    method: 'POST',
  });
  const complete = (await guestJson(completeResponse)) as { link: GuestAssetLinkView };
  onProgress({ phase: 'done', loaded: file.size, total: file.size });
  return complete.link;
}

function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
}

function AssetUploadPage({ token }: { token: string }) {
  const [view, setView] = useState<GuestAssetLinkView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<GuestAssetUploadItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());

  const refresh = useCallback(async () => {
    try {
      setView(await fetchAssetView(token));
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const startUpload = (item: GuestAssetUploadItem, file: File) => {
    let key = idempotencyKeys.current.get(item.id);
    if (key === undefined) {
      key = crypto.randomUUID();
      idempotencyKeys.current.set(item.id, key);
    }
    const patch = (changes: Partial<GuestAssetUploadItem>) => {
      setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, ...changes } : entry)));
    };
    runAssetUpload(token, file, key, (progress) => patch({ progress }))
      .then((link) => {
        patch({ progress: { phase: 'done', loaded: file.size, total: file.size }, message: null, failed: false });
        setView(link);
        setNotice(`«${file.name}» subida atribuida a este asset. ¡Gracias!`);
      })
      .catch((error: unknown) => {
        patch({ failed: true, message: errorMessage(error) });
      });
  };

  const onFilesChosen = (files: File[]) => {
    if (files.length === 0) return;
    const next: GuestAssetUploadItem[] = [];
    for (const file of Array.from(files)) {
      const item: GuestAssetUploadItem = {
        id: crypto.randomUUID(),
        fileName: file.name,
        progress: { phase: 'ready', loaded: 0, total: file.size },
        message: null,
        failed: false,
      };
      const classified = classifyFile({ name: file.name, type: file.type, size: file.size });
      if ('reason' in classified) {
        next.push({ ...item, failed: true, message: classified.message });
      } else {
        next.push(item);
        startUpload(item, file);
      }
    }
    setItems((current) => [...current, ...next]);
  };

  if (loading) return <Spinner label="Cargando enlace…" />;
  if (loadError !== null) {
    return (
      <main className="request-main" data-testid="asset-upload-page">
        <section className="card">
          <ErrorBanner message={loadError} />
          <FormActions>
            <button type="button" className="btn" onClick={() => void refresh()}>Reintentar</button>
          </FormActions>
        </section>
      </main>
    );
  }
  if (view === null) return null;

  const acceptsUploads = view.state === 'open' && view.quota.remainingBytes > 0;

  return (
    <main className="request-main" data-testid="asset-upload-page">
      <section className="card" aria-label="Subida de material">
        <h2 className="request-title" data-testid="asset-upload-title">{view.assetTitle}</h2>
        <p className="field-hint" data-testid="asset-upload-project">{view.projectTitle}</p>
        <p data-testid="asset-upload-state">
          <Badge tone={view.state === 'open' ? 'ok' : view.state === 'used' ? 'plain' : 'hidden'}>
            {STATE_TEXT[view.state]}
          </Badge>
        </p>
        <dl className="kv" data-testid="asset-upload-quota">
          <dt>Espacio disponible</dt>
          <dd>{formatBytes(view.quota.remainingBytes)} de {formatBytes(view.quota.limitBytes)}</dd>
          <dt>Vence</dt>
          <dd>{formatExpiry(view.expiresAt)}</dd>
        </dl>
        <p className="field-hint">{LIMITS_NOTICE}</p>
        {notice !== null && <p className="badge badge-ok" role="status">{notice}</p>}
      </section>

      {!acceptsUploads ? (
        <section className="card" data-testid="asset-upload-closed-message" aria-label="Enlace no disponible">
          <h3>{view.state === 'used' ? 'Este enlace ya fue usado' : 'Este enlace ya no acepta archivos'}</h3>
          <p className="field-hint">
            {view.state === 'used'
              ? 'La toma llegó al estudio. Si necesitás subir algo más, pedí un enlace nuevo.'
              : 'Contactá al estudio si necesitás subir algo más.'}
          </p>
        </section>
      ) : (
        <section className="card" aria-label="Subir archivos" data-testid="asset-upload-card">
          <h3>Subir archivos</h3>
          <Dropzone
            onFiles={onFilesChosen}
            accept="image/jpeg,image/png,image/webp,video/mp4,.jpg,.jpeg,.png,.webp,.mp4"
            inputTestId="asset-upload-input"
          />
        </section>
      )}

      {items.length > 0 && (
        <section className="card" aria-label="Estado de cargas" data-testid="asset-upload-list">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((item) => (
              <li key={item.id} className="material-row" data-testid="asset-upload-item">
                <div>
                  <div className="material-name">{item.fileName}</div>
                  <div className="material-meta">
                    {item.failed
                      ? (item.message ?? 'Error de carga.')
                      : item.progress.phase === 'done'
                        ? 'Listo'
                        : 'Subiendo…'}
                  </div>
                </div>
                <ProgressBar loaded={item.progress.loaded} total={item.progress.total} label={`Carga de ${item.fileName}`} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

export const Route = createFileRoute('/asset-upload/$token')({
  // no-store: no link state may leak between tokens (NFR-104).
  headers: () => ({ 'cache-control': 'no-store' }),
  component: AssetUploadTokenRoute,
});

function AssetUploadTokenRoute() {
  const { token } = Route.useParams();
  useDocumentTitle('Subí tu material');
  return (
    <div className="request-shell">
      <header className="portal-header">
        <span className="portal-title">Portal de clientes</span>
        <span className="portal-user">Subida de material</span>
      </header>
      <AssetUploadPage token={token} />
    </div>
  );
}
