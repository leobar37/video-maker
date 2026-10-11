/**
 * Materials (FR-003, NFR-005): mobile-first upload with visible format/size
 * limits, REAL byte progress (XHR), explicit HEIC rejection, per-file retry,
 * and the private material list with authenticated downloads. Empty/loading/
 * error states are explicit; a pending upload is never shown as material.
 */

import { useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import type { MaterialView } from '@videomaker/customer-assets';
import { isUnauthorized } from '../../api/client';
import { materialsKey } from '../../api/keys';
import { useMaterials } from '../../api/hooks';
import {
  LIMITS_NOTICE,
  classifyFile,
  runMaterialUpload,
  type UploadProgress,
  type UploadTransport,
} from '../../api/upload';
import { Badge, EmptyState, ErrorBanner, ErrorState, ProgressBar, Spinner, formatBytes, formatDate } from '../../components/ui/primitives';
import { Dropzone } from '../../components/ui/dropzone';
import { DataTable } from '../../components/ui/data-table';
import { useSession } from '../auth/session';

const DROPZONE_ACCEPT = 'image/jpeg,image/png,image/webp,video/mp4,.jpg,.jpeg,.png,.webp,.mp4';

interface UploadItem {
  id: string;
  fileName: string;
  fileSize: number;
  progress: UploadProgress;
  message: string | null;
  failed: boolean;
}

function UploadCard({
  clientId,
  onUploaded,
  transport,
}: {
  clientId: string;
  onUploaded: () => void;
  /** DI seam for tests; production uses the XHR transport. */
  transport?: UploadTransport;
}) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const idempotencyKeys = useRef(new Map<string, string>());
  const selectedFiles = useRef(new Map<string, File>());

  const patchItem = (id: string, changes: Partial<UploadItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...changes } : item)));
  };

  const startUpload = (item: UploadItem, file: File) => {
    let key = idempotencyKeys.current.get(item.id);
    if (key === undefined) {
      key = crypto.randomUUID();
      idempotencyKeys.current.set(item.id, key);
    }
    runMaterialUpload({
      clientId,
      file,
      idempotencyKey: key,
      transport,
      onProgress: (progress) => patchItem(item.id, { progress }),
    })
      .then(() => patchItem(item.id, { progress: { phase: 'done', loaded: file.size, total: file.size }, message: null, failed: false }))
      .then(onUploaded)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Error de carga.';
        patchItem(item.id, { failed: true, message });
      });
  };

  const onFilesChosen = (files: File[]) => {
    if (files.length === 0) return;
    const next: UploadItem[] = [];
    for (const file of files) {
      const item: UploadItem = {
        id: crypto.randomUUID(),
        fileName: file.name,
        fileSize: file.size,
        progress: { phase: 'ready', loaded: 0, total: file.size },
        message: null,
        failed: false,
      };
      selectedFiles.current.set(item.id, file);
      const classified = classifyFile({ name: file.name, type: file.type, size: file.size });
      if ('reason' in classified) {
        // Rejected BEFORE any network call, with the explicit explanation.
        next.push({ ...item, failed: true, message: classified.message });
      } else {
        next.push(item);
        startUpload(item, file);
      }
    }
    setItems((current) => [...current, ...next]);
  };

  return (
    <section className="card" aria-label="Subir materiales" data-testid="upload-card">
      <h2>Subir materiales</h2>
      <p className="field-hint">{LIMITS_NOTICE}</p>
      <Dropzone onFiles={onFilesChosen} accept={DROPZONE_ACCEPT} />
      <ul style={{ listStyle: 'none', margin: '0.5rem 0 0', padding: 0 }} data-testid="upload-list">
        {items.map((item) => (
          <li key={item.id} style={{ padding: '0.4rem 0', borderBottom: '1px solid var(--line)' }} data-testid="upload-item">
            <div className="material-row" style={{ borderBottom: 0, padding: 0 }}>
              <div style={{ minWidth: 0 }}>
                <div className="material-name">{item.fileName}</div>
                <div className="material-meta">{formatBytes(item.fileSize)}</div>
              </div>
              {item.progress.phase === 'done' && <Badge tone="ok">Listo</Badge>}
              {item.failed && <Badge tone="hidden">Error</Badge>}
            </div>
            {!item.failed && item.progress.phase !== 'done' && item.progress.phase !== 'ready' && (
              <div style={{ marginTop: '0.25rem' }}>
                <ProgressBar
                  loaded={item.progress.loaded}
                  total={item.progress.total}
                  label={`Subiendo ${item.fileName}`}
                />
                <div className="material-meta">
                  {item.progress.phase === 'uploading'
                    ? `${formatBytes(item.progress.loaded)} de ${formatBytes(item.progress.total)}`
                    : item.progress.phase === 'finishing'
                      ? 'Verificando en el servidor…'
                      : 'Iniciando…'}
                </div>
              </div>
            )}
            {item.message !== null && (
              <ErrorBanner message={item.message}>
                {item.failed && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      const file = selectedFiles.current.get(item.id);
                      if (file === undefined) return;
                      patchItem(item.id, { failed: false, message: null, progress: { phase: 'starting', loaded: 0, total: file.size } });
                      startUpload(item, file);
                    }}
                  >
                    Reintentar
                  </button>
                )}
              </ErrorBanner>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function MaterialsTable({ items }: { items: MaterialView[] }) {
  const columns = useMemo<ColumnDef<MaterialView, unknown>[]>(
    () => [
      {
        accessorKey: 'name',
        header: 'Archivo',
        cell: (info) => <span className="material-name">{info.getValue<string>()}</span>,
      },
      {
        accessorKey: 'mediaType',
        header: 'Tipo',
        cell: (info) => <Badge>{info.getValue<string>()}</Badge>,
      },
      {
        accessorKey: 'bytes',
        header: 'Tamaño',
        cell: (info) => <span className="material-meta">{formatBytes(info.getValue<number>())}</span>,
      },
      {
        accessorKey: 'createdAt',
        header: 'Fecha',
        cell: (info) => <span className="material-meta">{formatDate(info.getValue<number>())}</span>,
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) => (
          <a className="btn btn-sm" href={`/api/v1/materials/${row.original.id}/content`} download={row.original.name}>
            Descargar
          </a>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<MaterialView>
      columns={columns}
      data={items}
      getRowId={(material) => material.id}
      initialSorting={[{ id: 'createdAt', desc: true }]}
      pageSize={20}
      tableTestId="materials-table"
      rowTestId="material-row"
      ariaLabel="Materiales"
      emptyTitle="Todavía no hay materiales"
      emptyHint="Sube fotos o videos con los controles de arriba; aparecerán aquí cuando terminen de verificarse."
    />
  );
}

export function MaterialsPage({ clientId, admin = false, transport }: { clientId: string; admin?: boolean; transport?: UploadTransport }) {
  const { me } = useSession();
  const materials = useMaterials(me.me.userId, clientId);
  const queryClient = useQueryClient();

  if (materials.isPending) return <Spinner label="Cargando materiales…" />;
  if (materials.isError) {
    if (isUnauthorized(materials.error)) throw materials.error;
    return <ErrorState message="No se pudieron cargar los materiales." onRetry={() => materials.refetch()} />;
  }

  const items = materials.data.items;
  return (
    <div className="portal-split">
      <div>
        {admin && (
          <p className="field-hint">Como admin puedes subir en nombre del cliente; cada archivo queda asociado a este cliente.</p>
        )}
        <UploadCard
          clientId={clientId}
          transport={transport}
          onUploaded={() => {
            void queryClient.invalidateQueries({ queryKey: materialsKey(me.me.userId, clientId) });
          }}
        />
      </div>
      <section className="card" aria-label="Materiales" data-testid="materials-list">
        <h2>{admin ? 'Materiales del cliente' : 'Tus materiales'}</h2>
        <div data-testid="material-row-list">
          <MaterialsTable items={items} />
        </div>
      </section>
    </div>
  );
}
