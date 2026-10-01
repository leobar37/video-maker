'use strict';

/* Dashboard read-only (contracts.md §8). Vanilla JS, sin frameworks.
 * Metadatos SOLO vía textContent (nunca innerHTML): XSS-proof by construction.
 * Filtros client/project/asset/kind; r1/r2 diff; descargas exactas por
 * nombre declarado de output; video con controles nativos; SVG/HTML como
 * descarga (attachment), nunca ejecutados ni embebidos. */

(() => {
  const state = {
    catalog: null,
    view: new URLSearchParams(location.search).get('view') === 'instagram' ? 'instagram' : 'gallery',
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) {
      if (child === undefined || child === null) continue;
      node.append(child);
    }
    return node;
  }

  async function fetchEnvelope(url) {
    let response;
    try {
      response = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (error) {
      throw { code: 'NETWORK', message: 'no se pudo contactar al servidor' };
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      throw { code: 'RESPONSE', message: `respuesta no-JSON (HTTP ${response.status})` };
    }
    if (!payload || payload.ok !== true) {
      const err = payload && payload.error ? payload.error : { code: 'RESPONSE', message: `HTTP ${response.status}` };
      throw err;
    }
    return payload.data;
  }

  // ------------------------------------------------------------------
  // States (loading / error / empty)
  // ------------------------------------------------------------------

  function setStatus(node) {
    const region = $('status');
    region.replaceChildren(...(node ? [node] : []));
    region.classList.toggle('is-error', Boolean(node) && node.dataset.kind === 'error');
  }

  function loadingStatus() {
    const node = el('p', { class: 'status-line', text: 'Cargando catálogo…' });
    node.dataset.kind = 'loading';
    return node;
  }

  function emptyStatus() {
    const node = el('p', { class: 'status-line', text: 'Sin revisiones selladas para los filtros actuales. Creá una con `vm asset snapshot`.' });
    node.dataset.kind = 'empty';
    return node;
  }

  function errorStatus(err) {
    const retry = el('button', { type: 'button', text: 'Reintentar' });
    retry.addEventListener('click', () => loadCatalog());
    const node = el('div', { class: 'status-error' }, [
      el('p', { text: `No se pudo cargar el catálogo: ${err.code || 'ERROR'} — ${err.message || 'error desconocido'}` }),
      retry,
    ]);
    node.dataset.kind = 'error';
    return node;
  }

  // ------------------------------------------------------------------
  // Filters
  // ------------------------------------------------------------------

  function fillSelect(select, values, keepValue) {
    const previous = keepValue ? select.value : '';
    select.replaceChildren(el('option', { value: '', text: select.id === 'filter-client' ? 'Todos' : 'Todos' }));
    for (const item of values) {
      select.append(el('option', { value: item.value, text: item.label }));
    }
    if (previous && values.some((item) => item.value === previous)) select.value = previous;
  }

  function populateFilters(catalog) {
    const clientMap = new Map();
    const projectMap = new Map();
    const assetIds = new Set();
    for (const entry of catalog.entries) {
      for (const client of entry.clients) clientMap.set(client.id, client.name);
      projectMap.set(entry.project.id, entry.project.name);
      assetIds.add(entry.asset.id);
    }
    fillSelect(
      $('filter-client'),
      [...clientMap.entries()].map(([id, name]) => ({ value: id, label: name !== id ? `${id} — ${name}` : id })),
      true,
    );
    fillSelect(
      $('filter-project'),
      [...projectMap.entries()].map(([id, name]) => ({ value: id, label: name !== id ? `${id} — ${name}` : id })),
      true,
    );
    const datalist = $('asset-options');
    datalist.replaceChildren(...[...assetIds].sort().map((id) => el('option', { value: id })));
  }

  function currentQuery() {
    const params = new URLSearchParams();
    const client = $('filter-client').value;
    const project = $('filter-project').value;
    const asset = $('filter-asset').value.trim();
    const kind = $('filter-kind').value;
    if (client) params.set('client', client);
    if (project) params.set('project', project);
    if (asset) params.set('asset', asset);
    if (kind) params.set('kind', kind);
    const query = params.toString();
    return query.length > 0 ? `?${query}` : '';
  }

  // ------------------------------------------------------------------
  // Presentation helpers
  // ------------------------------------------------------------------

  const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
  const INLINE_VIDEO = new Set(['video/mp4', 'video/webm']);

  function previewKind(mediaType) {
    if (INLINE_IMAGE.has(mediaType)) return 'image';
    if (INLINE_VIDEO.has(mediaType)) return 'video';
    return 'download';
  }

  /** Default preview: thumbnail/preview inline primero, si no primer inline. */
  function defaultPreviewOutput(entry) {
    const ranked = [...entry.outputs].sort((a, b) => {
      const rank = (out) => (out.role === 'thumbnail' ? 0 : out.role === 'preview' ? 1 : 2);
      return rank(a) - rank(b);
    });
    return ranked.find((out) => previewKind(out.mediaType) !== 'download') ?? null;
  }

  function backupLabel(entry) {
    if (entry.backup.status === 'confirmed' && entry.backup.receiptVerified) return { text: 'respaldo confirmado (receipt verificado)', tone: 'ok' };
    if (entry.backup.status === 'confirmed') return { text: 'respaldo reclamado sin receipt verificado', tone: 'warn' };
    if (entry.backup.status === 'failed') return { text: 'respaldo fallido', tone: 'bad' };
    if (entry.backup.status === 'syncing') return { text: 'respaldo en curso', tone: 'warn' };
    return { text: 'solo local (sin receipt remoto)', tone: 'neutral' };
  }

  const EDITORIAL_LABEL = { draft: 'borrador', approved: 'aprobado', rejected: 'rechazado' };

  // ------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------

  function metaRow(term, valueNode) {
    return el('div', { class: 'meta-row' }, [el('dt', { text: term }), el('dd', {}, [valueNode])]);
  }

  function previewNode(entry, output) {
    const kind = output ? previewKind(output.mediaType) : 'download';
    if (output && kind === 'image') {
      return el('img', { src: `/api/${output.servicePath}`, alt: `${entry.asset.title} — ${output.name}`, loading: 'lazy' });
    }
    if (output && kind === 'video') {
      return el('video', { src: `/api/${output.servicePath}`, controls: '', preload: 'metadata' });
    }
    const hint = output
      ? `${output.name} (${output.mediaType}) se sirve como descarga: HTML/JS/SVG nunca se ejecutan ni embebidos.`
      : 'Sin output con vista previa posible; descargá los archivos declarados.';
    return el('div', { class: 'preview-fallback', role: 'note' }, [
      el('p', { text: 'Sin vista previa embebida para este output.' }),
      el('p', { class: 'muted', text: hint }),
    ]);
  }

  function outputsTable(entry, onSelectOutput) {
    const tbody = el('tbody');
    for (const output of entry.outputs) {
      const kind = previewKind(output.mediaType);
      const actions = el('td', { class: 'cell-actions' });
      if (kind !== 'download') {
        const view = el('a', { href: `/api/${output.servicePath}`, target: '_blank', rel: 'noopener noreferrer', text: 'ver' });
        actions.append(view, ' ');
      }
      const download = el('a', { href: `/api/${output.servicePath}?download=1`, download: output.name, text: 'descargar' });
      actions.append(download);
      const previewButton = el('button', { type: 'button', class: 'linklike', text: 'previsualizar' });
      previewButton.addEventListener('click', () => onSelectOutput(output));
      const nameCell = el('th', { scope: 'row' }, [el('span', { text: `${output.name} ` }), previewButton]);
      const row = el('tr', {}, [
        nameCell,
        el('td', { text: output.role }),
        el('td', {}, [el('code', { text: output.mediaType })]),
        el('td', { text: output.visibility }),
        actions,
      ]);
      tbody.append(row);
    }
    return el('table', { class: 'outputs' }, [
      el('thead', {}, [
        el('tr', {}, [el('th', { scope: 'col', text: 'Output (nombre declarado)' }), el('th', { scope: 'col', text: 'Rol' }), el('th', { scope: 'col', text: 'Tipo' }), el('th', { scope: 'col', text: 'Visibilidad' }), el('th', { scope: 'col', text: 'Acciones' })]),
      ]),
      tbody,
    ]);
  }

  function diffSection(entry, revisions) {
    const selectFrom = el('select', { 'aria-label': 'Revisión origen' });
    const selectTo = el('select', { 'aria-label': 'Revisión destino' });
    for (const revision of revisions) {
      const label = `${revision.revisionId} — ${revision.rootHash.slice(0, 12)}`;
      selectFrom.append(el('option', { value: revision.revisionId, text: label }));
      selectTo.append(el('option', { value: revision.revisionId, text: label }));
    }
    if (revisions.length > 1) selectTo.selectedIndex = 1;
    const result = el('div', { class: 'diff-result' });
    const button = el('button', { type: 'button', text: 'Comparar' });
    button.addEventListener('click', async () => {
      result.replaceChildren(el('p', { class: 'muted', text: 'Comparando…' }));
      try {
        const diff = await fetchEnvelope(`/api/diff/${entry.projectId}/${entry.assetId}?from=${encodeURIComponent(selectFrom.value)}&to=${encodeURIComponent(selectTo.value)}`);
        result.replaceChildren(renderDiff(diff));
      } catch (error) {
        result.replaceChildren(el('p', { class: 'status-line is-error-text', text: `diff falló: ${error.code} — ${error.message}` }));
      }
    });
    return el('details', { class: 'diff' }, [
      el('summary', { text: 'Comparar revisiones (diff)' }),
      el('div', { class: 'diff-controls' }, [selectFrom, el('span', { text: '→' }), selectTo, button]),
      result,
    ]);
  }

  function changeList(title, names, tone) {
    if (names.length === 0) return null;
    return el('div', { class: 'diff-group' }, [
      el('h4', { text: title }),
      el('ul', {}, names.map((name) => el('li', {}, [el('code', { class: tone, text: name })]))),
    ]);
  }

  function renderDiff(diff) {
    const recipeLabel = { unchanged: 'sin cambios', added: 'agregada', removed: 'eliminada', modified: 'modificada' };
    return el('div', {}, [
      el('p', { class: 'muted', text: `${diff.from.revisionId} (${diff.from.rootHash.slice(0, 12)}) → ${diff.to.revisionId} (${diff.to.rootHash.slice(0, 12)}) · recipe: ${recipeLabel[diff.recipe] ?? diff.recipe}` }),
      changeList('Archivos agregados', diff.files.added, 'add'),
      changeList('Archivos eliminados', diff.files.removed, 'del'),
      changeList('Archivos modificados', diff.files.modified, 'mod'),
      changeList('Outputs agregados', diff.outputs.added, 'add'),
      changeList('Outputs eliminados', diff.outputs.removed, 'del'),
      changeList('Outputs modificados', diff.outputs.modified, 'mod'),
      changeList('Presets agregados', diff.presets.added, 'add'),
      changeList('Presets eliminados', diff.presets.removed, 'del'),
      changeList('Presets modificados', diff.presets.modified, 'mod'),
    ]);
  }

  function entryCard(entry, assetRevisions) {
    const backup = backupLabel(entry);
    const previewHost = el('div', { class: 'preview' });
    const openLink = el('a', { class: 'action-primary', target: '_blank', rel: 'noopener noreferrer', text: 'Ampliar' });
    const downloadLink = el('a', { class: 'action-secondary', text: 'Descargar' });
    const select = el('select', { 'aria-label': 'Output a previsualizar (nombre declarado)' });
    for (const output of entry.outputs) {
      select.append(el('option', { value: output.name, text: output.name }));
    }
    const defaultOutput = defaultPreviewOutput(entry);
    if (defaultOutput) select.value = defaultOutput.name;

    const showPreview = (output) => {
      if (output && typeof output.name === 'string') select.value = output.name;
      const chosen = entry.outputs.find((output) => output.name === select.value) ?? null;
      previewHost.replaceChildren(previewNode(entry, chosen));
      openLink.hidden = !chosen || previewKind(chosen.mediaType) === 'download';
      downloadLink.hidden = !chosen;
      if (chosen) {
        openLink.href = `/api/${chosen.servicePath}`;
        openLink.setAttribute('aria-label', `Ampliar ${entry.asset.title}: ${chosen.name}`);
        downloadLink.href = `/api/${chosen.servicePath}?download=1`;
        downloadLink.download = chosen.name;
        downloadLink.setAttribute('aria-label', `Descargar ${entry.asset.title}: ${chosen.name}`);
      }
    };
    select.addEventListener('change', showPreview);
    showPreview();

    const missingNote =
      entry.production.missingOutputs.length > 0
        ? el('p', { class: 'warn-text', text: `Declarados sin sello en esta revisión: ${entry.production.missingOutputs.join(', ')}` })
        : null;

    const errors =
      entry.errors.length > 0
        ? el('ul', { class: 'error-list' }, entry.errors.map((err) => el('li', { text: `${err.code}: ${err.message}` })))
        : null;

    const clientsText = entry.clients.length > 0 ? entry.clients.map((client) => (client.name !== client.id ? `${client.id} — ${client.name}` : client.id)).join(', ') : 'sin clientes';
    const presetsText = entry.presets.length > 0 ? entry.presets.map((preset) => `${preset.presetId}@${preset.versionId} (${preset.name}, cliente ${preset.clientId})`).join(', ') : 'sin presets';
    const videoOutput = entry.outputs.find((output) => previewKind(output.mediaType) === 'video');
    const playButton = videoOutput ? el('button', { type: 'button', class: 'action-secondary', text: 'Ver video' }) : null;
    if (playButton) playButton.addEventListener('click', () => showPreview(videoOutput));
    const backupShort = { ok: 'Respaldado', warn: 'Por verificar', bad: 'Respaldo fallido', neutral: 'Local' }[backup.tone];


    return el('article', { class: 'card', 'data-asset': entry.assetId, 'data-revision': entry.revisionId }, [
      el('div', { class: 'card-topline' }, [
        el('span', { class: 'asset-kind', text: { image: 'Imagen', video: 'Video', svg: 'SVG' }[entry.asset.kind] ?? 'Archivo' }),
        el('span', { class: 'revision-label', text: `Versión ${entry.revisionId}` }),
      ]),
      previewHost,
      el('div', { class: 'card-content' }, [
        el('header', { class: 'card-header' }, [
          el('h3', { text: entry.asset.title, title: entry.asset.title }),
          el('p', { class: 'project-name', text: entry.project.name, title: entry.project.name }),
        ]),
        el('div', { class: 'preview-controls' }, [el('span', { class: 'preview-label', text: 'Formato' }), select]),
        el('div', { class: 'card-actions' }, [openLink, downloadLink, playButton]),
        el('div', { class: 'badges' }, [
          el('span', { class: `badge editorial-${entry.editorialStatus}`, text: EDITORIAL_LABEL[entry.editorialStatus] ?? entry.editorialStatus }),
          el('span', { class: `badge backup-${backup.tone}`, text: backupShort, title: backup.text }),
        ]),
        missingNote,
        errors,
        el('details', { class: 'asset-details' }, [
          el('summary', { text: 'Detalles y archivos' }),
          el('dl', { class: 'meta' }, [
            metaRow('Proyecto', el('span', { text: entry.project.id !== entry.project.name ? `${entry.project.id} — ${entry.project.name}` : entry.project.id })),
            metaRow('Clientes', el('span', { text: clientsText })),
            metaRow('Presets', el('span', { text: presetsText })),
            metaRow('Revisión', el('code', { text: entry.revisionId })),
            metaRow('rootHash', el('code', { class: 'hash', text: entry.rootHash, title: entry.rootHash })),
            metaRow('Producción', el('span', { text: `${entry.production.presentOutputs.length} sellado(s) de ${entry.production.presentOutputs.length + entry.production.missingOutputs.length} declarado(s)` })),
            metaRow('Respaldo', el('span', { text: backup.text })),
          ]),
          outputsTable(entry, showPreview),
        ]),
        diffSection(entry, assetRevisions),
      ]),
    ]);
  }

  function setView(view) {
    state.view = view;
    document.body.dataset.view = view;
    $('entries').hidden = view !== 'gallery';
    $('instagram-view').hidden = view !== 'instagram';
    $('filters-panel').open = view === 'gallery';
    $('view-gallery').setAttribute('aria-pressed', String(view === 'gallery'));
    $('view-instagram').setAttribute('aria-pressed', String(view === 'instagram'));
    if (state.catalog) renderCatalog(state.catalog);
  }

  function instagramView(catalog) {
    const host = $('instagram-view');
    host.replaceChildren();
    const posts = catalog.entries.flatMap((entry) => {
      const output = entry.outputs.find((out) => out.role === 'deliverable' && previewKind(out.mediaType) !== 'download');
      return output ? [{ entry, output }] : [];
    });
    const profile = catalog.entries.find((entry) => entry.outputs.some((out) => out.name === 'avatar' && previewKind(out.mediaType) === 'image'));
    const avatar = profile?.outputs.find((out) => out.name === 'avatar');
    const client = posts[0]?.entry.clients[0] ?? profile?.clients[0];
    const name = profile?.asset.title ?? client?.name ?? 'Tu próxima propuesta';
    const avatarNode = () => avatar
      ? el('img', { class: 'ig-avatar', src: `/api/${avatar.servicePath}`, alt: `Perfil de ${name}` })
      : el('span', { class: 'ig-avatar ig-avatar-placeholder', text: (client?.id ?? 'ST').slice(0, 2).toUpperCase() });
    const dialog = el('dialog', { class: 'ig-post-dialog', 'aria-label': 'Vista de publicación propuesta' });
    const closeButton = el('button', { class: 'ig-close', type: 'button', text: 'Cerrar', 'aria-label': 'Cerrar publicación' });
    closeButton.addEventListener('click', () => dialog.close());
    const postBody = el('div', { class: 'ig-post-body' });
    dialog.append(closeButton, postBody);
    dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });
    const openPost = ({ entry, output }) => {
      postBody.replaceChildren(
        el('div', { class: 'ig-post-media' }, [previewNode(entry, output)]),
        el('div', { class: 'ig-post-copy' }, [
          el('div', { class: 'ig-post-owner' }, [avatarNode(), el('strong', { text: name })]),
          el('span', { class: 'ig-proposal-chip', text: 'Pieza propuesta' }),
          el('h3', { text: entry.asset.title }),
          el('p', { class: 'muted', text: 'Archivo existente del taller. Esta vista no publica contenido ni muestra métricas reales.' }),
          el('p', { class: 'ig-version', text: `Versión ${entry.revisionId} · ${EDITORIAL_LABEL[entry.editorialStatus] ?? entry.editorialStatus}` }),
          el('div', { class: 'card-actions' }, [
            el('a', { class: 'action-primary', href: `/api/${output.servicePath}`, target: '_blank', rel: 'noopener noreferrer', text: 'Ver original' }),
            el('a', { class: 'action-secondary', href: `/api/${output.servicePath}?download=1`, download: output.name, text: 'Descargar' }),
          ]),
        ]),
      );
      dialog.showModal();
    };
    const grid = el('div', { class: 'ig-post-grid', 'aria-label': 'Grid de publicaciones propuestas' });
    posts.forEach((post, index) => {
      const thumb = post.entry.outputs.find((out) => out.role === 'thumbnail' && previewKind(out.mediaType) === 'image') ?? post.output;
      const media = previewNode(post.entry, thumb);
      if (media.tagName === 'VIDEO') {
        media.removeAttribute('controls');
        media.muted = true;
      }
      const tile = el('button', { class: 'ig-tile', type: 'button', 'aria-label': `Abrir propuesta ${index + 1}: ${post.entry.asset.title}` }, [
        media,
        el('span', { class: 'ig-slot', text: String(index + 1).padStart(2, '0') }),
      ]);
      tile.addEventListener('click', () => openPost(post));
      grid.append(tile);
    });
    if (!posts.length) grid.append(el('p', { class: 'ig-empty', text: 'Puedes partir desde cero. Añade piezas de imagen o video a este proyecto para ver tu propuesta.' }));
    host.append(
      el('p', { class: 'ig-notice', text: 'Vista de propuesta · No conectada a Instagram. Seguidores y publicaciones reales no importados.' }),
      el('div', { class: 'ig-frame' }, [
        el('div', { class: 'ig-bar' }, [el('span', { class: 'ig-wordmark', text: 'Instagram' }), el('span', { class: 'ig-proposal-chip', text: 'Simulación' })]),
        el('header', { class: 'ig-profile' }, [
          avatarNode(),
          el('div', { class: 'ig-profile-info' }, [
            el('div', { class: 'ig-username-row' }, [el('h2', { text: client?.id ?? 'propuesta' }), el('span', { class: 'ig-proposal-chip', text: 'Vista previa' })]),
            el('div', { class: 'ig-stats' }, [
              el('span', {}, [el('strong', { text: String(posts.length) }), ' posts propuestos']),
              el('span', { title: 'Sin datos reales de la cuenta' }, [el('strong', { text: '—' }), ' seguidores']),
              el('span', { title: 'Sin datos reales de la cuenta' }, [el('strong', { text: '—' }), ' seguidos']),
            ]),
            el('strong', { class: 'ig-profile-name', text: name }),
            el('p', { class: 'ig-bio', text: 'Ideas y piezas del taller, listas para revisar en conjunto.' }),
          ]),
        ]),
        el('div', { class: 'ig-grid-heading', text: 'PUBLICACIONES · PROPUESTA' }),
        grid,
      ]),
      dialog,
    );
  }

  function renderCatalog(catalog) {
    populateFilters(catalog);
    const host = $('entries');
    host.replaceChildren();
    $('instagram-view').replaceChildren();
    if (state.view === 'instagram') {
      setStatus(null);
      instagramView(catalog);
      return;
    }
    if (catalog.entries.length === 0) {
      setStatus(emptyStatus());
      return;
    }
    setStatus(null);
    const revisionsByAsset = new Map();
    for (const entry of catalog.entries) {
      const key = `${entry.projectId}/${entry.assetId}`;
      if (!revisionsByAsset.has(key)) revisionsByAsset.set(key, []);
      revisionsByAsset.get(key).push(entry);
    }
    for (const entry of catalog.entries) {
      const key = `${entry.projectId}/${entry.assetId}`;
      host.append(entryCard(entry, revisionsByAsset.get(key)));
    }
  }

  async function loadCatalog() {
    setStatus(loadingStatus());
    try {
      const catalog = await fetchEnvelope(`/api/catalog${currentQuery()}`);
      state.catalog = catalog;
      renderCatalog(catalog);
    } catch (error) {
      $('entries').replaceChildren();
      $('instagram-view').replaceChildren();
      setStatus(errorStatus(error));
    }
  }

  function wireFilters() {
    for (const id of ['filter-client', 'filter-project', 'filter-kind']) {
      $(id).addEventListener('change', () => loadCatalog());
    }
    let debounce;
    $('filter-asset').addEventListener('input', () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => loadCatalog(), 250);
    });
    $('reload').addEventListener('click', () => loadCatalog());
    $('view-gallery').addEventListener('click', () => setView('gallery'));
    $('view-instagram').addEventListener('click', () => setView('instagram'));
  }

  const initial = new URLSearchParams(location.search);
  for (const key of ['client', 'project']) {
    const value = initial.get(key);
    if (value) {
      $(`filter-${key}`).append(el('option', { value, text: value }));
      $(`filter-${key}`).value = value;
    }
  }
  $('filter-asset').value = initial.get('asset') ?? '';
  if (initial.has('kind')) $('filter-kind').value = initial.get('kind');
  setView(state.view);
  wireFilters();
  loadCatalog();
})();
