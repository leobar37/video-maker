/**
 * Posts (FR-005): admin creates posts from an asset's exact outputs (ordered
 * selection + exact cover), edits captions and toggles visibility; members
 * get the read-only view (the server already hides internal posts from
 * them). Carousel order and caption render as delivered; caption is plain
 * text, never HTML.
 */

import { useState } from 'react';
import { z } from 'zod';
import type { AssetView, PostView } from '@videomaker/customer-assets';
import { isUnauthorized } from '../../api/client';
import { useAssets, useCreatePost, usePosts, useUpdatePost } from '../../api/hooks';
import { FormActions, TextAreaField, TextField, validateWith } from '../../components/forms/fields';
import { Badge, EmptyState, ErrorBanner, ErrorState, Spinner, formatBytes } from '../../components/ui/primitives';
import { useSession } from '../auth/session';
import { CaptionBlock, PostCarousel } from './PostCarousel';

const postFormSchema = z.object({
  assetId: z.string().min(1, 'Elige un asset.'),
  title: z.string().trim().min(1, 'El título es obligatorio.').max(200),
  caption: z.string().max(2200),
  outputNames: z.array(z.string()).min(1, 'Elige al menos una salida.'),
  coverOutputName: z.string().min(1, 'Elige la portada entre las salidas.'),
  visibility: z.enum(['internal', 'client_visible']),
});

function CreatePostForm({ clientId, assets }: { clientId: string; assets: AssetView[] }) {
  const { me } = useSession();
  const createPost = useCreatePost(me.me.userId, clientId);
  const [assetId, setAssetId] = useState('');
  const [title, setTitle] = useState('');
  const [caption, setCaption] = useState('');
  const [outputNames, setOutputNames] = useState<string[]>([]);
  const [coverOutputName, setCoverOutputName] = useState('');
  const [visibility, setVisibility] = useState<'internal' | 'client_visible'>('client_visible');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<string | null>(null);

  const selectedAsset = assets.find((asset) => asset.id === assetId);

  const toggleOutput = (name: string) => {
    setOutputNames((current) => {
      if (current.includes(name)) {
        if (coverOutputName === name) setCoverOutputName('');
        return current.filter((entry) => entry !== name);
      }
      return [...current, name];
    });
  };

  const moveOutput = (name: string, direction: -1 | 1) => {
    setOutputNames((current) => {
      const index = current.indexOf(name);
      const target = index + direction;
      if (index === -1 || target < 0 || target >= current.length) return current;
      const next = [...current];
      next[index] = next[target]!;
      next[target] = name;
      return next;
    });
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const outcome = validateWith(postFormSchema, { assetId, title, caption, outputNames, coverOutputName, visibility });
    if ('fieldErrors' in outcome) {
      setFieldErrors(outcome.fieldErrors);
      return;
    }
    setFieldErrors({});
    createPost.mutate(
      {
        assetId: outcome.data.assetId,
        title: outcome.data.title,
        caption: outcome.data.caption === '' ? undefined : outcome.data.caption,
        outputNames: outcome.data.outputNames,
        coverOutputName: outcome.data.coverOutputName,
        visibility: outcome.data.visibility,
      },
      {
        onSuccess: () => {
          setTitle('');
          setCaption('');
          setOutputNames([]);
          setCoverOutputName('');
        },
        onError: (error) => setFailure(error instanceof Error ? error.message : 'No se pudo crear el post.'),
      },
    );
  };

  return (
    <section className="card" aria-label="Crear post" data-testid="create-post-form">
      <h2>Crear post</h2>
      {failure !== null && <ErrorBanner message={failure} />}
      <form onSubmit={submit} noValidate>
        <label className="field">
          <span className="field-label">Asset entregado</span>
          <select
            className="field-select"
            value={assetId}
            onChange={(event) => {
              setAssetId(event.target.value);
              setOutputNames([]);
              setCoverOutputName('');
            }}
          >
            <option value="">— elige —</option>
            {assets.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.title} ({asset.revisionId}){asset.visibility === 'client_visible' ? '' : ' · oculto'}
              </option>
            ))}
          </select>
          {fieldErrors.assetId !== undefined && <span className="field-error">{fieldErrors.assetId}</span>}
        </label>
        <TextField label="Título" name="title" value={title} onChange={setTitle} error={fieldErrors.title} required />
        <TextAreaField
          label="Caption"
          name="caption"
          value={caption}
          onChange={setCaption}
          error={fieldErrors.caption}
          maxLength={2200}
          hint="Texto plano; se muestra tal cual, sin HTML."
        />
        {selectedAsset !== undefined && (
          <fieldset style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)' }}>
            <legend className="field-label">Salidas (en orden) y portada</legend>
            {selectedAsset.outputs.map((output) => (
              <div key={output.name} className="asset-output">
                <label>
                  <input
                    type="checkbox"
                    checked={outputNames.includes(output.name)}
                    onChange={() => toggleOutput(output.name)}
                    aria-label={`Incluir ${output.name}`}
                  />{' '}
                  {output.name} · {output.mediaType} · {formatBytes(output.bytes)}
                </label>
                <label style={{ marginLeft: 'auto' }}>
                  <input
                    type="radio"
                    name="cover"
                    checked={coverOutputName === output.name}
                    disabled={!outputNames.includes(output.name)}
                    onChange={() => setCoverOutputName(output.name)}
                    aria-label={`Portada ${output.name}`}
                  />{' '}
                  portada
                </label>
                {outputNames.includes(output.name) && outputNames.length > 1 && (
                  <span>
                    <button type="button" className="btn btn-sm" onClick={() => moveOutput(output.name, -1)} aria-label={`Subir ${output.name}`}>↑</button>{' '}
                    <button type="button" className="btn btn-sm" onClick={() => moveOutput(output.name, 1)} aria-label={`Bajar ${output.name}`}>↓</button>
                  </span>
                )}
              </div>
            ))}
            {fieldErrors.outputNames !== undefined && <span className="field-error">{fieldErrors.outputNames}</span>}
            {fieldErrors.coverOutputName !== undefined && <span className="field-error">{fieldErrors.coverOutputName}</span>}
          </fieldset>
        )}
        <label className="field">
          <span className="field-label">Visibilidad</span>
          <select
            className="field-select"
            value={visibility}
            onChange={(event) => setVisibility(event.target.value === 'client_visible' ? 'client_visible' : 'internal')}
          >
            <option value="client_visible">Visible para el cliente</option>
            <option value="internal">Oculto (interno)</option>
          </select>
        </label>
        <FormActions>
          <button type="submit" className="btn btn-primary" disabled={createPost.isPending}>
            {createPost.isPending ? 'Creando…' : 'Crear post'}
          </button>
        </FormActions>
      </form>
    </section>
  );
}

function PostAdminControls({ clientId, post }: { clientId: string; post: PostView }) {
  const { me } = useSession();
  const updatePost = useUpdatePost(me.me.userId, clientId);
  const [caption, setCaption] = useState(post.caption ?? '');
  const [editing, setEditing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const saveCaption = () => {
    setFailure(null);
    updatePost.mutate(
      { postId: post.id, caption: caption === '' ? null : caption },
      {
        onSuccess: () => setEditing(false),
        onError: (error) => setFailure(error instanceof Error ? error.message : 'No se pudo guardar.'),
      },
    );
  };

  return (
    <div style={{ marginTop: '0.5rem' }} data-testid="post-admin-controls">
      {failure !== null && <ErrorBanner message={failure} />}
      {editing ? (
        <div>
          <TextAreaField label="Caption" name={`caption-${post.id}`} value={caption} onChange={setCaption} maxLength={2200} />
          <FormActions>
            <button type="button" className="btn btn-sm btn-primary" onClick={saveCaption} disabled={updatePost.isPending}>
              Guardar
            </button>
            <button type="button" className="btn btn-sm" onClick={() => { setEditing(false); setCaption(post.caption ?? ''); }}>
              Cancelar
            </button>
          </FormActions>
        </div>
      ) : (
        <FormActions>
          <button type="button" className="btn btn-sm" onClick={() => setEditing(true)}>
            Editar caption
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={updatePost.isPending}
            onClick={() =>
              updatePost.mutate(
                { postId: post.id, visibility: post.visibility === 'client_visible' ? 'internal' : 'client_visible' },
                { onError: (error) => setFailure(error instanceof Error ? error.message : 'Error de visibilidad.') },
              )
            }
          >
            {post.visibility === 'client_visible' ? 'Ocultar post' : 'Mostrar post'}
          </button>
        </FormActions>
      )}
    </div>
  );
}

export function PostsPage({ clientId, admin = false }: { clientId: string; admin?: boolean }) {
  const { me } = useSession();
  const posts = usePosts(me.me.userId, clientId);
  const assets = useAssets(me.me.userId, clientId);

  if (posts.isPending || assets.isPending) return <Spinner label="Cargando posts…" />;
  if (posts.isError) {
    if (isUnauthorized(posts.error)) throw posts.error;
    return <ErrorState message="No se pudieron cargar los posts." onRetry={() => posts.refetch()} />;
  }
  if (assets.isError) {
    if (isUnauthorized(assets.error)) throw assets.error;
    return <ErrorState message="No se pudieron cargar los assets." onRetry={() => assets.refetch()} />;
  }

  const items = posts.data.items;
  const deliveryIdByAsset = new Map(assets.data.items.map((asset) => [asset.id, asset.deliveryId]));

  return (
    <section aria-label="Posts" data-testid="posts-page">
      {admin && <CreatePostForm clientId={clientId} assets={assets.data.items} />}
      {items.length === 0 ? (
        <div className="card">
          <EmptyState
            title={admin ? 'Sin posts' : 'Todavía no hay publicaciones'}
            hint={admin ? 'Crea el primer post desde un asset entregado.' : 'Cuando el estudio publique contenido, aparecerá aquí y en tu cuadrícula.'}
          />
        </div>
      ) : (
        <div className="card-grid" data-testid="post-list">
          {items.map((post, index) => {
            const deliveryId = deliveryIdByAsset.get(post.assetId);
            if (deliveryId === undefined) return null;
            return (
              <article key={post.id} className="card" data-testid="post-card">
                <h3>
                  #{index + 1} {post.title}{' '}
                  {post.visibility === 'client_visible' ? <Badge tone="ok">Visible</Badge> : <Badge tone="hidden">Oculto</Badge>}
                </h3>
                <PostCarousel post={post} deliveryId={deliveryId} />
                <CaptionBlock caption={post.caption} />
                {admin && <PostAdminControls clientId={clientId} post={post} />}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
