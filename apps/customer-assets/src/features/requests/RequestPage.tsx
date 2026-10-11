/**
 * Guest request page (P-102, R-2; contracts.md §7 additive ·
 * customer-assets-requests): public mobile-first view OUTSIDE the `_app`
 * auth layout. It shows ONLY this request (title/instructions/remaining
 * budget/expiry/state) — never the catalog, deliveries, other requests or
 * any other client's data — and drives the guest-direct upload endpoints
 * with the capability token from the URL. No login prompt exists anywhere in
 * this flow: the token IS the authorization. Every fetch is no-store so no
 * state leaks between tokens (NFR-104).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GuestRequestView } from '@videomaker/customer-assets';
import { errorMessage } from '../../api/client';
import { LIMITS_NOTICE, classifyFile, type UploadProgress } from '../../api/upload';
import { FormActions } from '../../components/forms/fields';
import { Badge, ErrorBanner, ProgressBar, Spinner, formatBytes } from '../../components/ui/primitives';
import { Dropzone } from '../../components/ui/dropzone';
import { useDocumentTitle } from '../../components/ui/head';
import { runGuestUpload, type GuestUploadTransport } from './guest-upload';

interface GuestUploadItem {
  id: string;
  fileName: string;
  progress: UploadProgress;
  message: string | null;
  failed: boolean;
}

const STATE_TEXT: Record<GuestRequestView['state'], string> = {
  open: 'Pedido abierto',
  fulfilled: 'Pedido completo',
  closed: 'Pedido cerrado',
  expired: 'Pedido vencido',
};

async function fetchRequestView(token: string): Promise<GuestRequestView> {
  const response = await fetch(`/api/v1/r/${encodeURIComponent(token)}`, { cache: 'no-store' });
  if (!response.ok) {
    const parsed = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    throw new Error(parsed?.error?.message ?? 'Este enlace no es válido o ha vencido.');
  }
  return (await response.json()) as GuestRequestView;
}

function formatExpiry(expiresAt: number): string {
  return new Date(expiresAt).toLocaleString('es-AR', { dateStyle: 'medium', timeStyle: 'short' });
}

function RequestPage({ token, transport }: { token: string; transport?: GuestUploadTransport }) {
  const [view, setView] = useState<GuestRequestView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<GuestUploadItem[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const idempotencyKeys = useRef(new Map<string, string>());

  const refresh = useCallback(async () => {
    try {
      setView(await fetchRequestView(token));
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

  const startUpload = (item: GuestUploadItem, file: File) => {
    let key = idempotencyKeys.current.get(item.id);
    if (key === undefined) {
      key = crypto.randomUUID();
      idempotencyKeys.current.set(item.id, key);
    }
    const patch = (changes: Partial<GuestUploadItem>) => {
      setItems((current) => current.map((entry) => (entry.id === item.id ? { ...entry, ...changes } : entry)));
    };
    runGuestUpload({ token, file, idempotencyKey: key, transport, onProgress: (progress) => patch({ progress }) })
      .then((result) => {
        patch({ progress: { phase: 'done', loaded: file.size, total: file.size }, message: null, failed: false });
        setView(result.request);
        setNotice(`«${file.name}» subido. ¡Gracias!`);
      })
      .catch((error: unknown) => {
        patch({ failed: true, message: errorMessage(error) });
      });
  };

  const onFilesChosen = (files: File[]) => {
    if (files.length === 0) return;
    const next: GuestUploadItem[] = [];
    for (const file of files) {
      const item: GuestUploadItem = {
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

  if (loading) return <Spinner label="Cargando pedido…" />;
  if (loadError !== null) {
    return (
      <main className="request-main" data-testid="request-page">
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

  const acceptsUploads = view.state === 'open' && view.remainingFiles > 0 && view.remainingBytes > 0;

  return (
    <main className="request-main" data-testid="request-page">
      <section className="card" aria-label="Pedido de material">
        <h2 className="request-title" data-testid="request-title">{view.title}</h2>
        {view.instructions !== null && view.instructions.length > 0 && (
          <p className="field-hint" data-testid="request-instructions">{view.instructions}</p>
        )}
        <p data-testid="request-state">
          <Badge tone={view.state === 'open' ? 'ok' : view.state === 'fulfilled' ? 'plain' : 'hidden'}>
            {STATE_TEXT[view.state]}
          </Badge>
        </p>
        <dl className="kv" data-testid="request-remaining">
          <dt>Archivos restantes</dt>
          <dd>{view.remainingFiles} de {view.maxFiles}</dd>
          <dt>Espacio restante</dt>
          <dd>{formatBytes(view.remainingBytes)} de {formatBytes(view.maxBytes)}</dd>
          <dt>Vence</dt>
          <dd>{formatExpiry(view.expiresAt)}</dd>
        </dl>
        <p className="field-hint">{LIMITS_NOTICE}</p>
        {notice !== null && <p className="badge badge-ok" role="status">{notice}</p>}
      </section>

      {!acceptsUploads ? (
        <section className="card" data-testid="request-closed-message" aria-label="Pedido no disponible">
          <h3>{view.state === 'fulfilled' ? 'Este pedido ya está completo' : 'Este pedido ya no acepta archivos'}</h3>
          <p className="field-hint">
            {view.state === 'fulfilled'
              ? 'Se alcanzó el límite de este pedido. Si necesitás subir algo más, contactá al estudio.'
              : 'Contactá al estudio si necesitás subir algo más.'}
          </p>
        </section>
      ) : (
        <section className="card" aria-label="Subir archivos" data-testid="guest-upload-card">
          <h3>Subir archivos</h3>
          <Dropzone
            onFiles={onFilesChosen}
            accept="image/jpeg,image/png,image/webp,video/mp4,.jpg,.jpeg,.png,.webp,.mp4"
            inputTestId="guest-upload-input"
          />
        </section>
      )}

      {items.length > 0 && (
        <section className="card" aria-label="Estado de cargas" data-testid="guest-upload-list">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((item) => (
              <li key={item.id} className="material-row" data-testid="guest-upload-item">
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

export function GuestRequestPage({ token, transport }: { token: string; transport?: GuestUploadTransport }) {
  useDocumentTitle('Sube tus videos');
  return (
    <div className="request-shell">
      <header className="portal-header">
        <span className="portal-title">Portal de clientes</span>
        <span className="portal-user">Entrega de material</span>
      </header>
      <RequestPage token={token} transport={transport} />
    </div>
  );
}
