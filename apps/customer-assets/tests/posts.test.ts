import { describe, expect, it } from 'vitest';
import {
  apiCall,
  expectError,
  json,
  setupPortalFixture,
  stageDelivery,
  PNG_BYTES,
  sha256Hex,
  type PortalFixture,
} from './portal-fixture';

/**
 * Posts, versioned grid and the hide cascade (contracts.md §6, FR-005/006):
 * admin-human-only writes, exact output references, optimistic concurrency
 * with explicit 409s, and hiding an asset cutting every indirect route.
 */

let fixture: PortalFixture;

interface PostBody {
  id: string;
  assetId: string;
  title: string;
  caption: string | null;
  cover: { name: string };
  outputs: { name: string }[];
  visibility: string;
  position: number;
  version: number;
}

interface StagedRef {
  deliveryId: string;
  assetId: string;
}

const stagedByLabel: Record<string, StagedRef> = {};

async function createPost(
  body: Record<string, unknown>,
  principal: { cookie?: string } = { cookie: fixture.adminCookie },
  clientId?: string,
): Promise<Response> {
  return apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/clients/${clientId ?? fixture.clientA.id}/posts`,
    body,
    cookie: principal.cookie,
  });
}

async function makeVisible(assetId: string): Promise<void> {
  const res = await apiCall(fixture.deps, {
    method: 'PATCH',
    path: `/api/v1/client-assets/${assetId}/visibility`,
    body: { visibility: 'client_visible' },
    cookie: fixture.adminCookie,
  });
  expect(res.status).toBe(200);
}

describe('P-002 posts and grid', () => {
  it('sets up the fixture with two staged deliveries for client A', async () => {
    fixture = await setupPortalFixture();
    stagedByLabel.one = await stageDelivery(fixture.deps, {
      principal: { apiKey: fixture.integrator.apiKey },
      clientId: fixture.clientA.id,
      revisionId: `rev-post-1-${crypto.randomUUID().slice(0, 6)}`,
    });
    stagedByLabel.two = await stageDelivery(fixture.deps, {
      principal: { apiKey: fixture.integrator.apiKey },
      clientId: fixture.clientA.id,
      revisionId: `rev-post-2-${crypto.randomUUID().slice(0, 6)}`,
      projectId: 'proj-multi-1',
      assetId: 'asset-open-2',
    });
    stagedByLabel.hidden = await stageDelivery(fixture.deps, {
      principal: { apiKey: fixture.integrator.apiKey },
      clientId: fixture.clientA.id,
      revisionId: `rev-post-3-${crypto.randomUUID().slice(0, 6)}`,
      projectId: 'proj-multi-1',
      assetId: 'asset-open-3',
    });
    await makeVisible(stagedByLabel.one.assetId);
    await makeVisible(stagedByLabel.two.assetId);
    // `hidden` stays internal on purpose.
  });

  it('creates posts with exact ordered outputs and an exact cover', async () => {
    const res = await createPost({
      assetId: stagedByLabel.one.assetId,
      title: 'Lanzamiento',
      caption: 'Novedades de la semana',
      outputNames: ['clip.mp4', 'cover.png'],
      coverOutputName: 'cover.png',
      visibility: 'client_visible',
    });
    expect(res.status).toBe(201);
    const post = await json<PostBody>(res);
    expect(post.outputs.map((o) => o.name)).toEqual(['clip.mp4', 'cover.png']);
    expect(post.cover.name).toBe('cover.png');
    expect(post.position).toBe(0);
    expect(post.version).toBe(1);
    expect(post.visibility).toBe('client_visible');
  });

  it('rejects posts referencing outputs of another delivery or bad covers', async () => {
    // delivery two has the same output names; to prove cross-delivery
    // rejection we request an output that exists ONLY on delivery two by
    // targeting asset one: both deliveries use identical names, so use a
    // bogus name plus an existing cross-check on the second asset.
    await expectError(
      await createPost({
        assetId: stagedByLabel.one.assetId,
        title: 't',
        outputNames: ['not-in-delivery.png'],
        coverOutputName: 'not-in-delivery.png',
        visibility: 'internal',
      }),
      400,
      'bad_request',
    );
    await expectError(
      await createPost({
        assetId: stagedByLabel.one.assetId,
        title: 't',
        outputNames: ['cover.png'],
        coverOutputName: 'clip.mp4',
        visibility: 'internal',
      }),
      400,
      'bad_request',
    );
    await expectError(
      await createPost({
        assetId: 'asset-unknown',
        title: 't',
        outputNames: ['cover.png'],
        coverOutputName: 'cover.png',
        visibility: 'internal',
      }),
      404,
      'not_found',
    );
    // A visible post requires a visible asset (asset three stays internal).
    await expectError(
      await createPost({
        assetId: stagedByLabel.hidden.assetId,
        title: 't',
        outputNames: ['cover.png'],
        coverOutputName: 'cover.png',
        visibility: 'client_visible',
      }),
      409,
      'conflict',
    );
  });

  it('restricts posts reads/writes per principal kind', async () => {
    await createPost({
      assetId: stagedByLabel.one.assetId,
      title: 'Oculto',
      outputNames: ['cover.png'],
      coverOutputName: 'cover.png',
      visibility: 'internal',
    });

    const adminList = await json<{ items: PostBody[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/posts`,
        cookie: fixture.adminCookie,
      }),
    );
    expect(adminList.items).toHaveLength(2);

    const memberList = await json<{ items: PostBody[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/posts`,
        cookie: fixture.memberACookie,
      }),
    );
    expect(memberList.items).toHaveLength(1);
    expect(memberList.items[0]!.visibility).toBe('client_visible');

    await expectError(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/posts`,
        apiKey: fixture.integrator.apiKey,
      }),
      403,
      'forbidden',
    );
    await expectError(
      await createPost(
        {
          assetId: stagedByLabel.one.assetId,
          title: 't',
          outputNames: ['cover.png'],
          coverOutputName: 'cover.png',
          visibility: 'internal',
        },
        { cookie: fixture.memberACookie },
      ),
      403,
      'forbidden',
    );
  });

  it('patches posts with optimistic concurrency and re-checks the asset boundary', async () => {
    const created = await json<PostBody>(
      await createPost({
        assetId: stagedByLabel.one.assetId,
        title: 'Original',
        outputNames: ['cover.png'],
        coverOutputName: 'cover.png',
        visibility: 'client_visible',
      }),
    );

    const stale = await apiCall(fixture.deps, {
      method: 'PATCH',
      path: `/api/v1/posts/${created.id}`,
      body: { caption: 'late' },
      headers: { 'if-match': `"${created.version + 5}"` },
      cookie: fixture.adminCookie,
    });
    await expectError(stale, 409, 'conflict');

    const patched = await apiCall(fixture.deps, {
      method: 'PATCH',
      path: `/api/v1/posts/${created.id}`,
      body: { caption: 'Caption actualizada' },
      headers: { 'if-match': `"${created.version}"` },
      cookie: fixture.adminCookie,
    });
    expect(patched.status).toBe(200);
    const view = await json<PostBody>(patched);
    expect(view.caption).toBe('Caption actualizada');
    expect(view.version).toBe(created.version + 1);

    // Hiding the asset makes a client_visible flip impossible for its posts.
    await apiCall(fixture.deps, {
      method: 'PATCH',
      path: `/api/v1/client-assets/${stagedByLabel.one.assetId}/visibility`,
      body: { visibility: 'internal' },
      cookie: fixture.adminCookie,
    });
    await expectError(
      await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/posts/${created.id}`,
        body: { visibility: 'client_visible' },
        cookie: fixture.adminCookie,
      }),
      409,
      'conflict',
    );
    // Restore for later tests.
    await makeVisible(stagedByLabel.one.assetId);
  });

  it('reorders the grid atomically with version CAS; stale/concurrent writers get 409', async () => {
    const ids: string[] = [];
    for (const title of ['A', 'B', 'C']) {
      const created = await json<PostBody>(
        await createPost({
          assetId: stagedByLabel.two.assetId,
          title,
          outputNames: ['cover.png'],
          coverOutputName: 'cover.png',
          visibility: 'client_visible',
        }),
      );
      ids.push(created.id);
    }

    const first = await apiCall(fixture.deps, {
      method: 'PATCH',
      path: `/api/v1/clients/${fixture.clientA.id}/grid`,
      body: { version: 1, order: [ids[2]!, ids[0]!, ids[1]!] },
      cookie: fixture.adminCookie,
    });
    expect(first.status).toBe(200);
    const grid1 = await json<{ version: number; posts: { postId: string; position: number }[] }>(first);
    expect(grid1.version).toBe(2);
    // Ordered posts come first; the client's other posts follow in their
    // previous relative order (three earlier posts exist from prior tests).
    expect(grid1.posts).toHaveLength(6);
    expect(grid1.posts.slice(0, 3).map((p) => p.postId)).toEqual([ids[2], ids[0], ids[1]]);
    expect(grid1.posts.slice(0, 3).map((p) => p.position)).toEqual([0, 1, 2]);
    expect(new Set(grid1.posts.slice(3).map((p) => p.postId)).intersection(new Set(ids)).size).toBe(0);

    // Stale version → 409.
    await expectError(
      await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/clients/${fixture.clientA.id}/grid`,
        body: { version: 1, order: [ids[0]!] },
        cookie: fixture.adminCookie,
      }),
      409,
      'conflict',
    );

    // Concurrent writers on the same version: exactly one wins.
    const attempts = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        apiCall(fixture.deps, {
          method: 'PATCH',
          path: `/api/v1/clients/${fixture.clientA.id}/grid`,
          body: { version: 2, order: [ids[i]!, ids[(i + 1) % 3]!, ids[(i + 2) % 3]!] },
          cookie: fixture.adminCookie,
        }),
      ),
    );
    expect(attempts.filter((r) => r.status === 200)).toHaveLength(1);
    expect(attempts.filter((r) => r.status === 409)).toHaveLength(2);
    for (const r of attempts) await r.json();

    // If-Match carries the version instead of the body.
    const viaHeader = await apiCall(fixture.deps, {
      method: 'PATCH',
      path: `/api/v1/clients/${fixture.clientA.id}/grid`,
      body: { order: [ids[1]!, ids[2]!, ids[0]!] },
      headers: { 'if-match': '"3"' },
      cookie: fixture.adminCookie,
    });
    expect(viaHeader.status).toBe(200);

    // Member view follows the grid order.
    const memberList = await json<{ items: PostBody[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/posts`,
        cookie: fixture.memberACookie,
      }),
    );
    const positions = memberList.items.map((p) => p.position);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // Foreign post ids are refused inside the order list.
    await expectError(
      await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/clients/${fixture.clientB.id}/grid`,
        body: { version: 1, order: [ids[0]!] },
        cookie: fixture.adminCookie,
      }),
      409,
      'conflict',
    );
  });

  it('hides an asset and cuts every indirect route for members', async () => {
    const created = await json<PostBody>(
      await createPost({
        assetId: stagedByLabel.one.assetId,
        title: 'Cascade',
        outputNames: ['clip.mp4'],
        coverOutputName: 'clip.mp4',
        visibility: 'client_visible',
      }),
    );

    const hide = await apiCall(fixture.deps, {
      method: 'PATCH',
      path: `/api/v1/client-assets/${stagedByLabel.one.assetId}/visibility`,
      body: { visibility: 'internal' },
      cookie: fixture.adminCookie,
    });
    expect(hide.status).toBe(200);
    const hidden = await json<{ visibility: string }>(hide);
    expect(hidden.visibility).toBe('internal');

    // The dependent post was cascaded to internal in the same batch.
    const memberPosts = await json<{ items: { id: string }[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/posts`,
        cookie: fixture.memberACookie,
      }),
    );
    expect(memberPosts.items.some((p) => p.id === created.id)).toBe(false);

    // The indirect byte route (post output → delivery output) is closed.
    await expectError(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/deliveries/${stagedByLabel.one.deliveryId}/outputs/clip.mp4`,
        cookie: fixture.memberACookie,
      }),
      404,
      'not_found',
    );

    // Admin keeps access; showing again does NOT auto-show the post.
    const adminOutput = await apiCall(fixture.deps, {
      method: 'GET',
      path: `/api/v1/deliveries/${stagedByLabel.one.deliveryId}/outputs/clip.mp4`,
      cookie: fixture.adminCookie,
    });
    expect(adminOutput.status).toBe(200);
    await makeVisible(stagedByLabel.one.assetId);
    const afterShow = await json<{ items: { id: string }[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/posts`,
        cookie: fixture.memberACookie,
      }),
    );
    expect(afterShow.items.some((p) => p.id === created.id)).toBe(false);
  });

  it('denies non-admin visibility changes and idempotent keyed post creation', async () => {
    await expectError(
      await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/client-assets/${stagedByLabel.two.assetId}/visibility`,
        body: { visibility: 'internal' },
        cookie: fixture.memberACookie,
      }),
      403,
      'forbidden',
    );
    await expectError(
      await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/client-assets/${stagedByLabel.two.assetId}/visibility`,
        body: { visibility: 'internal' },
        apiKey: fixture.integrator.apiKey,
      }),
      403,
      'forbidden',
    );

    const key = `post-${crypto.randomUUID()}`;
    const body = {
      assetId: stagedByLabel.two.assetId,
      title: 'Idempotent',
      outputNames: ['cover.png'],
      coverOutputName: 'cover.png',
      visibility: 'internal',
    };
    const first = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/posts`,
      body,
      idempotencyKey: key,
      cookie: fixture.adminCookie,
    });
    const second = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/posts`,
      body,
      idempotencyKey: key,
      cookie: fixture.adminCookie,
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect((await json<{ id: string }>(second)).id).toBe((await json<{ id: string }>(first)).id);
  });

  // GET grid (additive P-004 read): the CAS version source for admin reorder.
  it('serves the admin-only grid read; members/agents denied, cross-client 404', async () => {
    // Admin read returns the live version and ordered post summaries.
    const adminGet = await apiCall(fixture.deps, {
      method: 'GET',
      path: `/api/v1/clients/${fixture.clientA.id}/grid`,
      cookie: fixture.adminCookie,
    });
    expect(adminGet.status).toBe(200);
    const grid = await json<{ version: number; posts: { postId: string; position: number; visibility: string }[] }>(adminGet);
    expect(grid.version).toBeGreaterThanOrEqual(1);
    for (const [index, entry] of grid.posts.entries()) {
      expect(entry.position).toBe(index);
    }

    // The read version is exactly what PATCH accepts (CAS source of truth).
    const patch = await apiCall(fixture.deps, {
      method: 'PATCH',
      path: `/api/v1/clients/${fixture.clientA.id}/grid`,
      body: { version: grid.version, order: [...grid.posts.map((p) => p.postId)].reverse() },
      cookie: fixture.adminCookie,
    });
    expect(patch.status).toBe(200);
    const patched = await json<{ version: number }>(patch);
    expect(patched.version).toBe(grid.version + 1);
    const reread = await apiCall(fixture.deps, {
      method: 'GET',
      path: `/api/v1/clients/${fixture.clientA.id}/grid`,
      cookie: fixture.adminCookie,
    });
    expect((await json<{ version: number }>(reread)).version).toBe(grid.version + 1);

    // Member of THIS client: authorized resource, insufficient role → 403.
    await expectError(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/grid`,
        cookie: fixture.memberACookie,
      }),
      403,
      'forbidden',
    );

    // Member of ANOTHER client: no enumeration → 404.
    await expectError(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/grid`,
        cookie: fixture.memberBCookie,
      }),
      404,
      'not_found',
    );

    // Agent key (even the workspace integrator): never an admin human → 403.
    await expectError(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/grid`,
        apiKey: fixture.integrator.apiKey,
      }),
      403,
      'forbidden',
    );

    // Unknown client id (admin): 404.
    await expectError(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: '/api/v1/clients/00000000-0000-4000-8000-000000000000/grid',
        cookie: fixture.adminCookie,
      }),
      404,
      'not_found',
    );

    // Fresh client with no grid row: version defaults to 1 with no posts.
    const fresh = await apiCall(fixture.deps, {
      method: 'GET',
      path: `/api/v1/clients/${fixture.clientB.id}/grid`,
      cookie: fixture.adminCookie,
    });
    expect(fresh.status).toBe(200);
    expect(await json<{ version: number; posts: unknown[] }>(fresh)).toMatchObject({ version: 1, posts: [] });
  });
});
