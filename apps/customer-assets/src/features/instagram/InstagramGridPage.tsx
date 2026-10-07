/**
 * Instagram grid (FR-006): an explicit-order simulation — three columns at
 * every viewport, cover thumbnails (raster) or the MP4 no-poster placeholder,
 * positional badges, and a detail modal with the ordered carousel + caption.
 * Admins get accessible move up/down controls persisted through the grid CAS;
 * a version conflict is surfaced LOUDLY (banner + reload) — never silently
 * dropped. Hiding content removes it from members' grids server-side.
 */

import { useState } from 'react';
import type { PostView } from '@videomaker/customer-assets';
import { ApiClientError, isUnauthorized } from '../../api/client';
import { useAssets, useGrid, usePatchGrid, usePosts } from '../../api/hooks';
import { Badge, EmptyState, ErrorBanner, ErrorState, Modal, Spinner } from '../../components/ui/primitives';
import { useSession } from '../auth/session';
import { CaptionBlock, PostCarousel } from '../posts/PostCarousel';

function GridThumb({
  post,
  deliveryId,
  order,
  hidden,
}: {
  post: PostView;
  deliveryId: string;
  order: number;
  hidden: boolean;
}) {
  const isVideo = post.cover.mediaType === 'video/mp4';
  return (
    <>
      <span className="insta-order" aria-hidden="true">
        {order}
      </span>
      {hidden && <span className="insta-hidden-flag">oculto</span>}
      {isVideo ? (
        <span className="video-placeholder" data-testid="video-placeholder">
          <span className="glyph" aria-hidden="true">▶</span>
          <span>MP4 · sin miniatura</span>
        </span>
      ) : (
        <img src={`/api/v1/deliveries/${deliveryId}/outputs/${post.cover.name}`} alt={`Portada de ${post.title}`} loading="lazy" />
      )}
      <span className="insta-overlay">{post.title}</span>
    </>
  );
}

function PostDetailModal({ post, deliveryId, onClose }: { post: PostView; deliveryId: string; onClose: () => void }) {
  return (
    <Modal title={post.title} onClose={onClose}>
      <PostCarousel post={post} deliveryId={deliveryId} />
      <CaptionBlock caption={post.caption} />
      <dl className="kv" style={{ marginTop: '0.75rem' }}>
        <dt>Portada exacta</dt>
        <dd>{post.cover.name}</dd>
        <dt>Salidas (orden)</dt>
        <dd>{post.outputs.map((output) => output.name).join(' → ')}</dd>
      </dl>
    </Modal>
  );
}

function ReorderControls({
  clientId,
  postId,
  position,
  conflictMessage,
  onMove,
  disabled,
}: {
  clientId: string;
  postId: string;
  position: number;
  conflictMessage: string | null;
  onMove: (direction: -1 | 1) => void;
  disabled: boolean;
}) {
  return (
    <span className="insta-controls">
      <button
        type="button"
        onClick={() => onMove(-1)}
        disabled={disabled || position === 0}
        aria-label={`Mover el post ${postId.slice(0, 6)} arriba`}
        data-testid={`move-up-${postId}`}
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => onMove(1)}
        disabled={disabled || conflictMessage !== null}
        aria-label={`Mover el post ${postId.slice(0, 6)} abajo`}
        data-testid={`move-down-${postId}`}
      >
        ↓
      </button>
    </span>
  );
}

export function InstagramGridPage({ clientId, admin = false }: { clientId: string; admin?: boolean }) {
  const { me } = useSession();
  // Admin surfaces appear for admin HUMANS wherever they open the grid (the
  // portal grid is the natural reorder surface); members never see controls.
  const adminMode = admin || me.me.role === 'admin';
  const posts = usePosts(me.me.userId, clientId);
  const assets = useAssets(me.me.userId, clientId);
  const grid = useGrid(me.me.userId, clientId, adminMode);
  const patchGrid = usePatchGrid(me.me.userId, clientId);
  const [openPostId, setOpenPostId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  if (posts.isPending || assets.isPending || (adminMode && grid.isPending)) {
    return <Spinner label="Cargando cuadrícula…" />;
  }
  if (posts.isError) {
    if (isUnauthorized(posts.error)) throw posts.error;
    return <ErrorState message="No se pudo cargar la cuadrícula." onRetry={() => posts.refetch()} />;
  }
  if (assets.isError) {
    if (isUnauthorized(assets.error)) throw assets.error;
    return <ErrorState message="No se pudo cargar la cuadrícula." onRetry={() => assets.refetch()} />;
  }
  if (adminMode && grid.isError) {
    if (isUnauthorized(grid.error)) throw grid.error;
    return <ErrorState message="No se pudo cargar el orden del grid." onRetry={() => grid.refetch()} />;
  }

  const deliveryIdByAsset = new Map(assets.data.items.map((asset) => [asset.id, asset.deliveryId]));
  const items = posts.data.items;
  const openPost = items.find((post) => post.id === openPostId) ?? null;
  const openDeliveryId = openPost !== null ? deliveryIdByAsset.get(openPost.assetId) : undefined;

  const orderedPosts = adminMode && grid.data !== undefined
    ? grid.data.posts
        .map((entry) => ({ entry, post: items.find((post) => post.id === entry.postId) }))
        .filter((pair): pair is { entry: (typeof grid.data.posts)[number]; post: PostView } => pair.post !== undefined)
        .map((pair) => ({ post: pair.post, hidden: pair.entry.visibility !== 'client_visible' }))
    : items.map((post) => ({ post, hidden: false }));

  const move = (postId: string, direction: -1 | 1) => {
    if (grid.data === undefined) return;
    const ids = orderedPosts.map((pair) => pair.post.id);
    const from = ids.indexOf(postId);
    const to = from + direction;
    if (from === -1 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    next[from] = next[to]!;
    next[to] = postId;
    setConflict(null);
    patchGrid.mutate(
      { order: next, version: grid.data.version },
      {
        onError: (error) => {
          // EXPLICIT conflict (contracts.md §6): the admin decides — reload
          // pulls the current winner; nothing was applied locally.
          if (error instanceof ApiClientError && error.status === 409) {
            setConflict('El orden cambió mientras editabas. No se aplicó tu movimiento: recarga para ver el orden vigente.');
          } else {
            setConflict(error instanceof Error ? error.message : 'No se pudo guardar el orden.');
          }
        },
      },
    );
  };

  return (
    <section aria-label="Cuadrícula de Instagram (simulación)" data-testid="instagram-page">
      <p className="field-hint">
        Simulación de cuadrícula de Instagram — tres columnas en orden explícito. No es una cuenta ni conexión real.
      </p>
      {conflict !== null && (
        <ErrorBanner message={conflict}>
          <button type="button" className="btn btn-sm" onClick={() => grid.refetch().then(() => setConflict(null))}>
            Recargar orden
          </button>
        </ErrorBanner>
      )}
      {adminMode && <p className="field-hint">Usa ↑/↓ para reordenar; el cambio se guarda con control de versiones.</p>}
      {orderedPosts.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Cuadrícula vacía"
            hint={admin ? 'Publica un post visible para llenar la cuadrícula del cliente.' : 'Cuando el estudio publique contenido, tu cuadrícula aparecerá aquí.'}
          />
        </div>
      ) : (
        <ul className="insta-grid" data-testid="insta-grid">
          {orderedPosts.map((pair, index) => {
            const deliveryId = deliveryIdByAsset.get(pair.post.assetId);
            if (deliveryId === undefined) return null;
            return (
              <li key={pair.post.id}>
                <button
                  type="button"
                  className="insta-cell"
                  onClick={() => setOpenPostId(pair.post.id)}
                  aria-label={`Abrir ${pair.post.title}, posición ${index + 1}`}
                  data-testid={`insta-cell-${pair.post.id}`}
                >
                  <GridThumb post={pair.post} deliveryId={deliveryId} order={index + 1} hidden={pair.hidden} />
                </button>
                {adminMode && (
                  <ReorderControls
                    clientId={clientId}
                    postId={pair.post.id}
                    position={index}
                    conflictMessage={conflict}
                    onMove={(direction) => move(pair.post.id, direction)}
                    disabled={patchGrid.isPending}
                  />
                )}
                {adminMode && pair.hidden && <Badge tone="hidden">Oculto</Badge>}
              </li>
            );
          })}
        </ul>
      )}
      {openPost !== null && openDeliveryId !== undefined && (
        <PostDetailModal post={openPost} deliveryId={openDeliveryId} onClose={() => setOpenPostId(null)} />
      )}
    </section>
  );
}
