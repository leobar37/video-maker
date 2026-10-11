/**
 * Assets catalog (FR-004): exact delivered revisions with their selected
 * outputs. Members only ever receive client_visible assets (the server
 * filters); admins see everything plus the visibility switch whose hide
 * action cascades server-side to dependent posts and direct URLs.
 */

import { useState } from 'react';
import type { AssetView, OutputRef } from '@videomaker/customer-assets';
import { isUnauthorized } from '../../api/client';
import { useAssets, useSetAssetVisibility } from '../../api/hooks';
import { Badge, EmptyState, ErrorState, Spinner, formatBytes, formatDate } from '../../components/ui/primitives';
import { useSession } from '../auth/session';

function outputUrl(deliveryId: string, output: OutputRef): string {
  return `/api/v1/deliveries/${deliveryId}/outputs/${output.name}`;
}

function OutputList({ asset }: { asset: AssetView }) {
  return (
    <ul className="asset-outputs">
      {asset.outputs.map((output) => (
        <li key={output.name} className="asset-output" data-testid="asset-output">
          <Badge tone={output.mediaType === 'video/mp4' ? 'warn' : 'plain'}>{output.mediaType}</Badge>
          <span style={{ fontWeight: 600 }}>{output.name}</span>
          <span className="material-meta">{formatBytes(output.bytes)}</span>
          <a className="btn btn-sm" style={{ marginLeft: 'auto' }} href={outputUrl(asset.deliveryId, output)} download={output.name}>
            Descargar
          </a>
        </li>
      ))}
    </ul>
  );
}

function VisibilitySwitch({ clientId, asset, isAdmin }: { clientId: string; asset: AssetView; isAdmin: boolean }) {
  const { me } = useSession();
  const setVisibility = useSetAssetVisibility(me.me.userId, clientId);
  const [failure, setFailure] = useState<string | null>(null);
  if (!isAdmin) {
    return asset.visibility === 'client_visible' ? <Badge tone="ok">Visible</Badge> : <Badge tone="hidden">Oculto</Badge>;
  }
  const checked = asset.visibility === 'client_visible';
  return (
    <span className="switch-row">
      <label>
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={setVisibility.isPending}
          onChange={(event) => {
            setFailure(null);
            setVisibility.mutate(
              { assetId: asset.id, visibility: event.target.checked ? 'client_visible' : 'internal' },
              { onError: (error) => setFailure(error instanceof Error ? error.message : 'Error de visibilidad.') },
            );
          }}
          aria-label={`Visible para el cliente: ${asset.title}`}
          data-testid="asset-visibility-switch"
        />{' '}
        Visible para el cliente
      </label>
      {failure !== null && <Badge tone="hidden">{failure}</Badge>}
    </span>
  );
}

export function AssetsPage({ clientId, admin = false }: { clientId: string; admin?: boolean }) {
  const { me } = useSession();
  const assets = useAssets(me.me.userId, clientId);

  if (assets.isPending) return <Spinner label="Cargando assets…" />;
  if (assets.isError) {
    if (isUnauthorized(assets.error)) throw assets.error;
    return <ErrorState message="No se pudieron cargar los assets." onRetry={() => assets.refetch()} />;
  }

  const items = assets.data.items;
  return (
    <section aria-label="Assets entregados" data-testid="assets-page">
      {admin && (
        <p className="field-hint">
          Ocultar un asset lo retira del catálogo del cliente y desactiva posts y URLs directas que lo usan.
        </p>
      )}
      {items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={admin ? 'Sin entregas para este cliente' : 'Todavía no hay assets para ti'}
            hint={
              admin
                ? 'Las entregas llegan desde el estudio (CLI de integración); aquí se controla su visibilidad.'
                : 'Cuando el estudio entregue una revisión, aparecerá aquí con sus archivos.'
            }
          />
        </div>
      ) : (
        <div className="card-grid" data-testid="asset-list">
          {items.map((asset) => (
            <article key={asset.id} className="card" data-testid="asset-card">
              <h3>{asset.title}</h3>
              <div className="material-meta">
                revisión {asset.revisionId} · {formatDate(asset.createdAt)} ·{' '}
                <VisibilitySwitch clientId={clientId} asset={asset} isAdmin={admin} />
              </div>
              <OutputList asset={asset} />
              {admin && asset.rootHash !== undefined && (
                <dl className="kv" style={{ marginTop: '0.5rem' }}>
                  <dt>rootHash</dt>
                  <dd>{asset.rootHash.slice(0, 16)}…</dd>
                </dl>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
