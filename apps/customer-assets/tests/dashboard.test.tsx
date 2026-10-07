/**
 * P-004 dashboard tests (test:ui — browser-less, happy-dom + @testing-library):
 * upload happy/error/unsupported/oversized states, empty states, the admin
 * visibility cascade mirrored on the query layer, explicit reorder-conflict
 * handling, and cache isolation between users/clients. The network layer is
 * mocked at the SDK boundary; the server contract itself is proven by the
 * worker tests (test:worker) and the e2e suite.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, type RenderResult } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import {
  type AssetView,
  type MaterialView,
  type MeInfo,
  type Page,
  type PostView,
  type PortalClientView,
  type PortalProjectView,
  type GridState,
} from '@videomaker/customer-assets';
import { resetPortalCache, prunePortalCacheForClient, meKey, materialsKey, assetsKey, postsKey, gridKey } from '../src/api/keys';
import { MEDIA_LIMIT_BYTES, classifyFile, runMaterialUpload, type UploadTransport } from '../src/api/upload';

/* ------------------------------------------------------------------ mocks */

vi.mock('../src/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api/client')>();
  return {
    ...actual,
    portal: {
      me: vi.fn(),
      listClients: vi.fn(),
      listMaterials: vi.fn(),
      listAssets: vi.fn(),
      listPosts: vi.fn(),
      getGrid: vi.fn(),
      patchGrid: vi.fn(),
      patchPost: vi.fn(),
      createPost: vi.fn(),
      setAssetVisibility: vi.fn(),
      initUpload: vi.fn(),
      completeUpload: vi.fn(),
      listProjects: vi.fn(),
      createProject: vi.fn(),
      renameProject: vi.fn(),
      listRequests: vi.fn(),
      getRequest: vi.fn(),
      createRequest: vi.fn(),
      mintRequestLink: vi.fn(),
      closeRequest: vi.fn(),
      listRequestMaterials: vi.fn(),
    },
    requestMagicLink: vi.fn(),
    signOutSession: vi.fn(),
  };
});

vi.mock('../src/features/admin/server', () => ({
  listClientAccess: vi.fn(),
  inviteClientMember: vi.fn(),
  mintClientAccessLink: vi.fn(),
  revokeAccessMembership: vi.fn(),
  revokeAccessInvitation: vi.fn(),
  issueClientAgentKey: vi.fn(),
  revokeAccessGrant: vi.fn(),
  acceptMyInvitations: vi.fn(),
}));

import { ApiClientError, portal, requestMagicLink } from '../src/api/client';
import { MaterialsPage } from '../src/features/materials/MaterialsPage';
import { ProjectsTab } from '../src/features/admin/ProjectsTab';
import { AssetsPage } from '../src/features/assets/AssetsPage';
import { PostsPage } from '../src/features/posts/PostsPage';
import { InstagramGridPage } from '../src/features/instagram/InstagramGridPage';
import { LoginPage } from '../src/features/auth/LoginPage';
import { RequireAuth } from '../src/features/auth/session';

const mocked = vi.mocked(portal, true);
const mockedMagicLink = vi.mocked(requestMagicLink, true);

const USER = 'user-1';
const CLIENT = 'client-1';

/** fireEvent-based file selection (no extra dependency). */
function chooseFiles(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

async function typeInto(element: Element, text: string): Promise<void> {
  fireEvent.input(element, { target: { value: text } });
}

const meInfo: MeInfo = { me: { kind: 'member', userId: USER, role: 'member', email: 'member@fixture.test' } };
const adminInfo: MeInfo = { me: { kind: 'admin', userId: 'admin-1', role: 'admin', email: 'admin@fixture.test' } };

function emptyPage<T>(): Page<T> {
  return { items: [], nextCursor: null };
}

function materialFixture(overrides: Partial<MaterialView> = {}): MaterialView {
  return {
    id: 'mat-1',
    clientId: CLIENT,
    name: 'foto.jpg',
    mediaType: 'image/jpeg',
    bytes: 1234,
    sha256: 'a'.repeat(64),
    status: 'ready',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function assetFixture(overrides: Partial<AssetView> = {}): AssetView {
  return {
    id: 'asset-1',
    clientId: CLIENT,
    deliveryId: 'delivery-1',
    title: 'Revisión 1',
    revisionId: 'rev-1',
    visibility: 'client_visible',
    editorialStatus: 'approved',
    outputs: [{ name: 'cover.png', mediaType: 'image/png', bytes: 2048, sha256: 'b'.repeat(64) }],
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function projectFixture(overrides: Partial<PortalProjectView> = {}): PortalProjectView {
  return {
    id: 'project-1',
    portalClientId: CLIENT,
    workspaceId: 'ws-1',
    studioProjectId: 'proj-brand-film-1',
    name: 'Brand Film',
    projectionVersion: 1,
    createdAt: 1_700_000_000_000,
    materialCount: 0,
    ...overrides,
  };
}

function postFixture(overrides: Partial<PostView> = {}): PostView {
  return {
    id: 'post-1',
    clientId: CLIENT,
    assetId: 'asset-1',
    title: 'Lanzamiento',
    caption: 'Texto del post',
    cover: { name: 'cover.png', mediaType: 'image/png', bytes: 2048, sha256: 'b'.repeat(64) },
    outputs: [
      { name: 'cover.png', mediaType: 'image/png', bytes: 2048, sha256: 'b'.repeat(64) },
      { name: 'clip.mp4', mediaType: 'video/mp4', bytes: 4096, sha256: 'c'.repeat(64) },
    ],
    visibility: 'client_visible',
    position: 0,
    version: 1,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

let queryClient: QueryClient;

function seedCache(entries: { key: readonly unknown[]; data: unknown }[]): void {
  for (const entry of entries) queryClient.setQueryData(entry.key, entry.data);
}

/** Minimal router carrying the app's real paths so typed Links/Navigate work. */
function renderWithProviders(
  ui: ReactNode,
  initialPath = '/',
  me: MeInfo = meInfo,
  options: { anonymous?: boolean } = {},
): RenderResult {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  if (options.anonymous === true) {
    mocked.me.mockRejectedValue(new ApiClientError(401, 'unauthorized', 'Authentication required.', 'req-401'));
  } else {
    mocked.me.mockResolvedValue(meInfo);
    seedCache([{ key: meKey, data: me }]);
  }

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  // Production renders every feature under RequireAuth (MeContext source).
  const shell = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <RequireAuth>{ui}</RequireAuth>,
  });
  const login = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    // /login is PUBLIC: no RequireAuth (an anonymous 401 here would redirect
    // to /login forever).
    component: () => ui,
  });
  const router = createRouter({ routeTree: rootRoute.addChildren([shell, login]), history: createMemoryHistory({ initialEntries: [initialPath] }) });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.me.mockResolvedValue(meInfo);
  // R-2: project cards render their own requests section; default to empty.
  mocked.listRequests.mockResolvedValue({ items: [], nextCursor: null });
});

/* ------------------------------------------------------- upload workflows */

function fakeFile(name: string, type: string, size: number): File {
  const blob = new Blob([new Uint8Array(Math.min(size, 64))], { type });
  Object.defineProperty(blob, 'name', { value: name });
  Object.defineProperty(blob, 'size', { value: size });
  return blob as File;
}

function okTransport(): UploadTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    init: vi.fn(async () => {
      calls.push('init');
      return {
        uploadId: 'up-1',
        clientId: CLIENT,
        kind: 'material',
        mediaType: 'image/jpeg',
        declaredBytes: 10,
        status: 'pending',
        expiresAt: Date.now() + 60_000,
      };
    }),
    put: vi.fn(async (_uploadId, _body, _type, onProgress) => {
      calls.push('put');
      onProgress(5, 10);
      onProgress(10, 10);
      return { uploadId: 'up-1', status: 'staged', bytes: 10, sha256: 'd'.repeat(64), mediaType: 'image/jpeg' };
    }),
    complete: vi.fn(async () => {
      calls.push('complete');
      return { material: materialFixture() };
    }),
  } as never;
}

describe('materials upload', () => {
  it('uploads a valid image with real progress phases and refreshes the list', async () => {
    const transport = okTransport();
    let lmCall = 0;
    mocked.listMaterials.mockImplementation(async () => {
      lmCall += 1;
      return lmCall === 1 ? emptyPage<MaterialView>() : { items: [materialFixture()], nextCursor: null };
    });
    renderWithProviders(<MaterialsPage clientId={CLIENT} transport={transport} />);
    await screen.findByTestId('upload-card');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    chooseFiles(input, [fakeFile('foto.jpg', 'image/jpeg', 10)]);

    await waitFor(() => expect(screen.getAllByText('Listo').length).toBeGreaterThan(0));
    expect(transport.init).toHaveBeenCalledTimes(1);
    expect(transport.calls).toEqual(['init', 'put', 'complete']);
    // The success invalidated the materials cache: the list REFETCHED and now
    // shows the delivered material row (invalidation is observable, not a flag).
    await waitFor(() => expect(mocked.listMaterials.mock.calls.length).toBeGreaterThanOrEqual(2));
    await screen.findByTestId('material-row');
  });

  it('rejects HEIC client-side with the explicit explanation and never touches the network', async () => {
        const transport = okTransport();
    mocked.listMaterials.mockResolvedValue(emptyPage<MaterialView>());
    renderWithProviders(<MaterialsPage clientId={CLIENT} transport={transport} />);
    await screen.findByTestId('upload-card');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    chooseFiles(input, [fakeFile('iphone.heic', 'image/heic', 10)]);

    await screen.findByText(/HEIC\/HEIF.*no está soportado/i);
    expect(transport.init).not.toHaveBeenCalled();
    expect(transport.put).not.toHaveBeenCalled();
  });

  it('rejects oversized files before any request', async () => {
        const transport = okTransport();
    mocked.listMaterials.mockResolvedValue(emptyPage<MaterialView>());
    renderWithProviders(<MaterialsPage clientId={CLIENT} transport={transport} />);
    await screen.findByTestId('upload-card');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const limit = MEDIA_LIMIT_BYTES['image/png'];
    chooseFiles(input, [fakeFile('grande.png', 'image/png', limit + 1)]);

    await screen.findByText(/supera el límite/i);
    expect(transport.init).not.toHaveBeenCalled();
  });

  it('surfaces server upload failures with a retry that re-drives the pipeline', async () => {
        mocked.listMaterials.mockResolvedValue(emptyPage<MaterialView>());
    const failing = okTransport();
    failing.put = vi.fn(async () => {
      throw new ApiClientError(500, 'internal', 'almacén no disponible', 'req-1');
    });
    const retrying = okTransport();
    let current = failing;
    const switching: UploadTransport = {
      get init() {
        return current.init;
      },
      get put() {
        return current.put;
      },
      get complete() {
        return current.complete;
      },
    };
    renderWithProviders(<MaterialsPage clientId={CLIENT} transport={switching} />);
    await screen.findByTestId('upload-card');

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    chooseFiles(input, [fakeFile('video.mp4', 'video/mp4', 32)]);
    await screen.findByText(/almacén no disponible/i);
    expect(screen.getByText('Reintentar')).toBeTruthy();

    current = retrying;
    fireEvent.click(screen.getByText('Reintentar'));
    await screen.findByText('Listo');
    expect(retrying.calls).toEqual(['init', 'put', 'complete']);
  });

  it('reports real progress phases through the transport seam', async () => {
    const transport = okTransport();
    const phases: string[] = [];
    await runMaterialUpload({
      clientId: CLIENT,
      file: fakeFile('foto.jpg', 'image/jpeg', 10),
      idempotencyKey: 'idem-1',
      transport,
      onProgress: (progress) => phases.push(`${progress.phase}:${progress.loaded}/${progress.total}`),
    });
    expect(phases).toEqual([
      'starting:0/10',
      'uploading:0/10',
      'uploading:5/10',
      'uploading:10/10',
      'finishing:10/10',
      'done:10/10',
    ]);
  });

  it('classifies files exactly like the server limits table', () => {
    expect(classifyFile({ name: 'a.jpg', type: 'image/jpeg', size: 1 })).toEqual({ mediaType: 'image/jpeg' });
    expect(classifyFile({ name: 'b.mp4', type: '', size: 1 })).toEqual({ mediaType: 'video/mp4' });
    expect(classifyFile({ name: 'c.heic', type: '', size: 1 })).toMatchObject({ reason: 'unsupported' });
    expect(classifyFile({ name: 'd.svg', type: 'image/svg+xml', size: 1 })).toMatchObject({ reason: 'unsupported' });
    expect(classifyFile({ name: 'e.png', type: 'image/png', size: MEDIA_LIMIT_BYTES['image/png'] + 1 })).toMatchObject({ reason: 'oversized' });
  });
});

/* ------------------------------------------------------------ empty states */

describe('empty and error states', () => {
  it('materials list shows the empty state', async () => {
    mocked.listMaterials.mockResolvedValue(emptyPage<MaterialView>());
    renderWithProviders(<MaterialsPage clientId={CLIENT} />);
    await screen.findByTestId('empty-state');
    expect(screen.getByText('Todavía no hay materiales')).toBeTruthy();
  });

  it('assets catalog shows the member empty state', async () => {
    mocked.listAssets.mockResolvedValue(emptyPage<AssetView>());
    renderWithProviders(<AssetsPage clientId={CLIENT} />);
    await screen.findByText('Todavía no hay assets para ti');
  });

  it('posts page shows the member empty state', async () => {
    mocked.listPosts.mockResolvedValue(emptyPage<PostView>());
    mocked.listAssets.mockResolvedValue(emptyPage<AssetView>());
    renderWithProviders(<PostsPage clientId={CLIENT} />);
    await screen.findByText('Todavía no hay publicaciones');
  });

  it('instagram grid shows the empty state', async () => {
    mocked.listPosts.mockResolvedValue(emptyPage<PostView>());
    mocked.listAssets.mockResolvedValue(emptyPage<AssetView>());
    renderWithProviders(<InstagramGridPage clientId={CLIENT} />);
    await screen.findByText('Cuadrícula vacía');
  });

  it('materials error state offers retry', async () => {
    mocked.listMaterials.mockRejectedValue(new ApiClientError(500, 'internal', 'D1 caída', 'req-2'));
    renderWithProviders(<MaterialsPage clientId={CLIENT} />);
    // one retry with backoff happens before the error state surfaces
    await screen.findByTestId('error-state', {}, { timeout: 4000 });
    expect(screen.getByText('Reintentar')).toBeTruthy();
  });
});

/* ----------------------------------------- admin visibility cascade (cache) */

describe('admin visibility cascade on the query layer', () => {
  it('toggling visibility refetches assets and invalidates posts AND grid caches', async () => {
    mocked.me.mockResolvedValue(adminInfo);
    mocked.listAssets.mockResolvedValueOnce({ items: [assetFixture()], nextCursor: null });
    mocked.listAssets.mockResolvedValue({ items: [assetFixture({ visibility: 'internal' })], nextCursor: null });
    mocked.setAssetVisibility.mockResolvedValue(assetFixture({ visibility: 'internal' }));

    renderWithProviders(<AssetsPage clientId={CLIENT} admin />, '/', adminInfo);
    await screen.findByTestId('asset-card');
    // Seed the inactive caches AFTER render (renderWithProviders owns the
    // QueryClient instance).
    seedCache([
      { key: postsKey(adminInfo.me.userId, CLIENT), data: { items: [postFixture()], nextCursor: null } },
      { key: gridKey(adminInfo.me.userId, CLIENT), data: { version: 3, posts: [] } satisfies GridState },
    ]);
    const assetsCallsBefore = mocked.listAssets.mock.calls.length;

    fireEvent.click(screen.getByTestId('asset-visibility-switch'));
    await waitFor(() => expect(mocked.setAssetVisibility).toHaveBeenCalledWith('asset-1', { visibility: 'internal' }));
    // Cascade on the query layer: the mounted assets query REFETCHES…
    await waitFor(() => expect(mocked.listAssets.mock.calls.length).toBeGreaterThan(assetsCallsBefore));
    // …and the inactive posts/grid caches are stale for the next view.
    await waitFor(() => {
      expect(queryClient.getQueryState(postsKey(adminInfo.me.userId, CLIENT))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(gridKey(adminInfo.me.userId, CLIENT))?.isInvalidated).toBe(true);
    });
  });
});

/* --------------------------------------------------------- reorder conflict */

describe('grid reorder conflicts', () => {
  function gridOf(version: number, ids: string[]): GridState {
    return { version, posts: ids.map((postId, position) => ({ postId, position, visibility: 'client_visible' as const })) };
  }

  it('a 409 keeps the server order and surfaces the conflict explicitly', async () => {
        mocked.me.mockResolvedValue(adminInfo);
    const postA = postFixture({ id: 'post-a', title: 'A' });
    const postB = postFixture({ id: 'post-b', title: 'B', position: 1 });
    mocked.listPosts.mockResolvedValue({ items: [postA, postB], nextCursor: null });
    mocked.listAssets.mockResolvedValue({ items: [assetFixture()], nextCursor: null });
    mocked.getGrid.mockResolvedValue(gridOf(7, ['post-a', 'post-b']));
    mocked.patchGrid.mockRejectedValue(new ApiClientError(409, 'conflict', 'Grid version mismatch', 'req-3'));

    renderWithProviders(<InstagramGridPage clientId={CLIENT} admin />, '/', adminInfo);
    await screen.findByTestId('insta-grid');
    const gridBefore = (queryClient.getQueryData(gridKey(adminInfo.me.userId, CLIENT)) as GridState).version;

    fireEvent.click(screen.getByTestId('move-up-post-b'));
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toContain('No se aplicó tu movimiento');
    expect(banner.textContent).toContain('recarga');
    // Nothing was applied locally: the cached grid still holds server truth.
    expect((queryClient.getQueryData(gridKey(adminInfo.me.userId, CLIENT)) as GridState).version).toBe(gridBefore);
    // Reload control present for the admin to resync.
    expect(screen.getByText('Recargar orden')).toBeTruthy();
  });

  it('a successful reorder persists the new order and bumps the cached version', async () => {
        mocked.me.mockResolvedValue(adminInfo);
    const postA = postFixture({ id: 'post-a', title: 'A' });
    const postB = postFixture({ id: 'post-b', title: 'B', position: 1 });
    mocked.listPosts.mockResolvedValue({ items: [postA, postB], nextCursor: null });
    mocked.listAssets.mockResolvedValue({ items: [assetFixture()], nextCursor: null });
    mocked.getGrid.mockResolvedValue(gridOf(7, ['post-a', 'post-b']));
    mocked.patchGrid.mockResolvedValue(gridOf(8, ['post-b', 'post-a']));

    renderWithProviders(<InstagramGridPage clientId={CLIENT} admin />, '/', adminInfo);
    await screen.findByTestId('insta-grid');

    fireEvent.click(screen.getByTestId('move-up-post-b'));
    await waitFor(() => {
      expect(mocked.patchGrid).toHaveBeenCalledWith(CLIENT, { version: 7, order: ['post-b', 'post-a'] });
      expect((queryClient.getQueryData(gridKey(adminInfo.me.userId, CLIENT)) as GridState).version).toBe(8);
    });
    // First cell now shows B's cover (order badge 1).
    await screen.findByLabelText('Abrir B, posición 1');
  });
});

/* ------------------------------------------------------- cache isolation */

describe('cache isolation between users and clients', () => {
  it('user change clears the ENTIRE cache (no cross-user leakage)', () => {
    const qc = new QueryClient();
    qc.setQueryData(meKey, meInfo);
    qc.setQueryData(materialsKey('u1', 'cA'), { items: ['a-material'], nextCursor: null });
    qc.setQueryData(materialsKey('u2', 'cB'), { items: ['b-secret'], nextCursor: null });

    resetPortalCache(qc, { userId: 'u1' }, { userId: 'u2' });
    expect(qc.getQueryData(meKey)).toBeUndefined();
    expect(qc.getQueryData(materialsKey('u1', 'cA'))).toBeUndefined();
    expect(qc.getQueryData(materialsKey('u2', 'cB'))).toBeUndefined();
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it('client switch prunes only the other client’s scoped entries', () => {
    const qc = new QueryClient();
    qc.setQueryData(meKey, meInfo);
    qc.setQueryData(['clients', 'u1'], { items: [], nextCursor: null });
    qc.setQueryData(materialsKey('u1', 'cA'), { items: ['a'], nextCursor: null });
    qc.setQueryData(assetsKey('u1', 'cA'), { items: [], nextCursor: null });
    qc.setQueryData(materialsKey('u1', 'cB'), { items: ['b'], nextCursor: null });

    prunePortalCacheForClient(qc, 'u1', 'cA');
    expect(qc.getQueryData(materialsKey('u1', 'cA'))).not.toBeUndefined();
    expect(qc.getQueryData(assetsKey('u1', 'cA'))).not.toBeUndefined();
    expect(qc.getQueryData(['clients', 'u1'])).not.toBeUndefined();
    expect(qc.getQueryData(materialsKey('u1', 'cB'))).toBeUndefined();
  });

  it('keys always bind user AND client', () => {
    expect(materialsKey('u1', 'cA')).toEqual(['client', 'u1', 'cA', 'materials']);
    expect(materialsKey('u2', 'cA')).not.toEqual(materialsKey('u1', 'cA'));
    expect(gridKey('u1', 'cA')).not.toEqual(postsKey('u1', 'cA'));
  });
});

/* ------------------------------------------------------------- login form */

describe('login page', () => {
  it('shows the neutral confirmation after a successful magic-link request', async () => {
        mockedMagicLink.mockResolvedValue(undefined);
    renderWithProviders(<LoginPage redirectTarget={null} />, '/login', meInfo, { anonymous: true });
    await screen.findByTestId('login-form');

    await typeInto(screen.getByLabelText(/Email/), 'member@fixture.test');
    fireEvent.click(screen.getByText('Enviar enlace de acceso'));

    await screen.findByTestId('login-sent');
    expect(screen.getByText(/Si la dirección está registrada/i)).toBeTruthy();
    // The message must not reveal whether the email exists.
    expect(screen.queryByText(/no existe|no está registrada|inválido tras enviar/i)).toBeNull();
  });

  it('validates the email client-side before sending', async () => {
        renderWithProviders(<LoginPage redirectTarget={null} />, '/login', meInfo, { anonymous: true });
    await screen.findByTestId('login-form');

    fireEvent.click(screen.getByText('Enviar enlace de acceso'));
    expect(await screen.findByText('Escribe tu email.')).toBeTruthy();
    expect(mockedMagicLink).not.toHaveBeenCalled();
  });

  it('network failures show a retryable error, never a fake success', async () => {
        mockedMagicLink.mockRejectedValue(new Error('magic-link-request-failed:500'));
    renderWithProviders(<LoginPage redirectTarget={null} />, '/login', meInfo, { anonymous: true });
    await screen.findByTestId('login-form');

    await typeInto(screen.getByLabelText(/Email/), 'member@fixture.test');
    fireEvent.click(screen.getByText('Enviar enlace de acceso'));

    await screen.findByRole('alert');
    expect(screen.queryByTestId('login-sent')).toBeNull();
  });
});

/* --------------------------------------------------- instagram rendering */

describe('instagram grid rendering', () => {
  it('renders three ordered cells with an MP4 cover placeholder and a modal carousel', async () => {
        const post = postFixture({ cover: { name: 'clip.mp4', mediaType: 'video/mp4', bytes: 4096, sha256: 'c'.repeat(64) } });
    mocked.listPosts.mockResolvedValue({ items: [post], nextCursor: null });
    mocked.listAssets.mockResolvedValue({ items: [assetFixture()], nextCursor: null });

    renderWithProviders(<InstagramGridPage clientId={CLIENT} />);
    await screen.findByTestId('insta-grid');

    // MP4 cover → explicit placeholder, never a promised thumbnail.
    expect(screen.getAllByTestId('video-placeholder').length).toBeGreaterThan(0);
    expect(screen.getByText('MP4 · sin miniatura')).toBeTruthy();
    expect(screen.getByText('1')).toBeTruthy(); // explicit order badge

    fireEvent.click(screen.getByLabelText(/Abrir Lanzamiento, posición 1/i));
    await screen.findByRole('dialog');
    // Exact cover is labeled inside the detail modal.
    expect(screen.getByText(/Portada exacta/i)).toBeTruthy();
    expect(screen.getByTestId('post-caption').textContent).toBe('Texto del post');
  });

  it('members never see hidden posts (server filters; UI renders what arrives)', async () => {
    const visible = postFixture({ id: 'post-visible' });
    mocked.listPosts.mockResolvedValue({ items: [visible], nextCursor: null });
    mocked.listAssets.mockResolvedValue({ items: [assetFixture()], nextCursor: null });
    renderWithProviders(<InstagramGridPage clientId={CLIENT} />);
    await screen.findByTestId('insta-grid');
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });
});

/* ------------------------------------------------------ admin projects tab */

describe('admin projects tab (R-1 + R-2)', () => {
  it('renders project cards with per-project material counts and request sections', async () => {
    mocked.me.mockResolvedValue(adminInfo);
    mocked.listProjects.mockResolvedValue({
      items: [projectFixture({ materialCount: 3 }), projectFixture({ id: 'project-2', name: 'Reels 2026', studioProjectId: 'proj-reels-1' })],
      nextCursor: null,
    });
    mocked.listRequests.mockResolvedValue({ items: [], nextCursor: null });

    renderWithProviders(<ProjectsTab clientId={CLIENT} />, '/', adminInfo);
    await screen.findByTestId('projects-tab');

    const cards = screen.getAllByTestId('project-card');
    expect(cards).toHaveLength(2);
    expect(screen.getByText('Brand Film')).toBeTruthy();
    expect(screen.getByText(/3 materiales/)).toBeTruthy();
    expect(screen.getByText('Reels 2026')).toBeTruthy();
    // R-2: every project card carries its own requests section with the
    // creation form and the explicit empty state (no fabricated requests).
    expect(screen.getAllByTestId('project-requests')).toHaveLength(2);
    expect(screen.getAllByTestId('request-create-form')).toHaveLength(2);
    expect(screen.getAllByText('Sin pedidos')).toHaveLength(2);
  });

  it('renders open request cards with mint/close actions through the SDK', async () => {
    mocked.me.mockResolvedValue(adminInfo);
    mocked.listProjects.mockResolvedValue({ items: [projectFixture()], nextCursor: null });
    mocked.listRequests.mockResolvedValue({
      items: [
        {
          id: 'request-1',
          portalProjectId: 'project-1',
          portalClientId: CLIENT,
          title: 'Tomas del evento',
          instructions: 'Subí los videos crudos',
          maxFiles: 10,
          maxBytes: 2 * 1024 * 1024 * 1024,
          usedFiles: 3,
          usedBytes: 30 * 1024 * 1024,
          remainingFiles: 7,
          remainingBytes: 2 * 1024 * 1024 * 1024 - 30 * 1024 * 1024,
          state: 'open',
          expiresAt: Date.now() + 86_400_000,
          createdAt: Date.now(),
          closedAt: null,
          closeReason: null,
        },
      ],
      nextCursor: null,
    });

    renderWithProviders(<ProjectsTab clientId={CLIENT} />, '/', adminInfo);
    await screen.findByTestId('request-card');
    expect(screen.getByText('Tomas del evento')).toBeTruthy();
    expect(screen.getByText(/7 archivos/)).toBeTruthy();
  });

  it('creates a project through the SDK and refetches the list', async () => {
    mocked.me.mockResolvedValue(adminInfo);
    let listCall = 0;
    mocked.listProjects.mockImplementation(async () => {
      listCall += 1;
      return listCall === 1
        ? { items: [], nextCursor: null }
        : { items: [projectFixture()], nextCursor: null };
    });
    mocked.createProject.mockResolvedValue(projectFixture());

    renderWithProviders(<ProjectsTab clientId={CLIENT} />, '/', adminInfo);
    await screen.findByTestId('project-create-form');
    expect(screen.getByText('Sin proyectos proyectados')).toBeTruthy();

    await typeInto(screen.getByLabelText(/Id del proyecto en Studio/i), 'proj-brand-film-1');
    await typeInto(screen.getByLabelText(/Título visible/i), 'Brand Film');
    fireEvent.click(screen.getByText('Proyectar proyecto'));

    await waitFor(() => expect(mocked.createProject).toHaveBeenCalledWith(CLIENT, { studioProjectId: 'proj-brand-film-1', name: 'Brand Film' }));
    await screen.findByTestId('project-card');
    expect(mocked.listProjects.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('renames a project inline through the SDK', async () => {
    mocked.me.mockResolvedValue(adminInfo);
    mocked.listProjects.mockResolvedValue({ items: [projectFixture()], nextCursor: null });
    mocked.renameProject.mockResolvedValue(projectFixture({ name: 'Brand Film — Fase 1' }));

    renderWithProviders(<ProjectsTab clientId={CLIENT} />, '/', adminInfo);
    await screen.findByTestId('project-card');

    fireEvent.click(screen.getByTestId('project-rename-button'));
    await typeInto(screen.getByLabelText(/Nuevo título/i), 'Brand Film — Fase 1');
    fireEvent.click(screen.getByText('Guardar'));

    await waitFor(() => expect(mocked.renameProject).toHaveBeenCalledWith('project-1', { name: 'Brand Film — Fase 1' }));
  });

  it('surfaces list failures with an explicit banner', async () => {
    mocked.me.mockResolvedValue(adminInfo);
    mocked.listProjects.mockRejectedValue(new ApiClientError(403, 'forbidden', 'Projects are restricted.', 'req-9'));

    renderWithProviders(<ProjectsTab clientId={CLIENT} />, '/', adminInfo);
    await screen.findByText(/restricted/i);
    expect(screen.queryByTestId('project-card')).toBeNull();
  });
});
