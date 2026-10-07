import { describe, expect, it } from 'vitest';
import { eq, and, count } from 'drizzle-orm';
import { revokeAgentGrant } from '../src/server/clients';
import { agentGrant, clientAsset, deliveryRevision } from '../src/server/db/schema';
import { env } from 'cloudflare:test';
import {
  apiCall,
  createAgent,
  expectError,
  json,
  resetClientQuota,
  setupPortalFixture,
  stageDelivery,
  MP4_BYTES,
  PNG_BYTES,
  sha256Hex,
  type PortalFixture,
} from './portal-fixture';

/**
 * Deliveries (contracts.md §5/§6): integrator adopt, exact-revision
 * projections, the same staging protocol for outputs, ready-only-after-all-
 * bytes, and the member visibility boundary around the private catalog.
 */

let fixture: PortalFixture;

interface DeliveryBody {
  id: string;
  status: string;
  outputs: { name: string; ready: boolean; sha256: string }[];
  rootHash: string;
  revisionId: string;
}

function deliveryBody(revisionId: string, projectId = 'proj-multi-1', assetId = 'asset-open-1') {
  return {
    projectId,
    assetId,
    revisionId,
    rootHash: sha256Hex(new TextEncoder().encode(`root-${revisionId}`)),
    title: 'Entrega interna',
    kind: 'social',
    outputs: [
      { name: 'cover.png', mediaType: 'image/png', bytes: PNG_BYTES.byteLength, sha256: sha256Hex(PNG_BYTES) },
      { name: 'clip.mp4', mediaType: 'video/mp4', bytes: MP4_BYTES.byteLength, sha256: sha256Hex(MP4_BYTES) },
    ],
  };
}

async function createDelivery(principal: { cookie?: string; apiKey?: string }, body: unknown, clientId?: string): Promise<Response> {
  return apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/clients/${clientId ?? fixture.clientA.id}/deliveries`,
    body,
    cookie: principal.cookie,
    apiKey: principal.apiKey,
  });
}

async function stageAllOutputs(
  principal: { cookie?: string; apiKey?: string },
  deliveryId: string,
): Promise<void> {
  for (const [name, bytes] of [
    ['cover.png', PNG_BYTES],
    ['clip.mp4', MP4_BYTES],
  ] as const) {
    const init = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
      body: {
        kind: 'delivery_output',
        mediaType: name === 'cover.png' ? 'image/png' : 'video/mp4',
        declaredBytes: bytes.byteLength,
        sha256: sha256Hex(bytes),
        deliveryId,
        outputName: name,
      },
      cookie: principal.cookie,
      apiKey: principal.apiKey,
    });
    expect(init.status).toBe(201);
    const session = await json<{ uploadId: string }>(init);
    const put = await apiCall(fixture.deps, {
      method: 'PUT',
      path: `/api/v1/uploads/${session.uploadId}/content`,
      rawBody: bytes,
      cookie: principal.cookie,
      apiKey: principal.apiKey,
    });
    expect(put.status).toBe(200);
    const complete = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/uploads/${session.uploadId}/complete`,
      cookie: principal.cookie,
      apiKey: principal.apiKey,
    });
    expect(complete.status).toBe(201);
  }
}

describe('P-002 deliveries', () => {
  it('sets up the fixture', async () => {
    fixture = await setupPortalFixture();
  });

  describe('client adoption by the workspace integrator', () => {
    it('adopts a new client projection once and replays identical retries', async () => {
      const key = `adopt-${crypto.randomUUID()}`;
      const body = { workspaceId: fixture.workspaceId, studioClientId: 'studio-client-gamma', name: 'Gamma Client' };
      const first = await apiCall(fixture.deps, {
        method: 'POST',
        path: '/api/v1/clients/adopt',
        body,
        idempotencyKey: key,
        apiKey: fixture.integrator.apiKey,
      });
      expect(first.status).toBe(201);
      const adopted = await json<{ id: string; workspaceId: string; studioClientId: string; name: string }>(first);
      expect(adopted.workspaceId).toBe(fixture.workspaceId);
      expect(adopted.studioClientId).toBe('studio-client-gamma');

      const replay = await apiCall(fixture.deps, {
        method: 'POST',
        path: '/api/v1/clients/adopt',
        body,
        idempotencyKey: key,
        apiKey: fixture.integrator.apiKey,
      });
      expect(replay.status).toBe(201);
      expect(replay.headers.get('idempotency-replayed')).toBe('true');
      expect((await json<{ id: string }>(replay)).id).toBe(adopted.id);

      // Divergent payload under the same key → 409.
      const divergent = await apiCall(fixture.deps, {
        method: 'POST',
        path: '/api/v1/clients/adopt',
        body: { ...body, name: 'Other Name' },
        idempotencyKey: key,
        apiKey: fixture.integrator.apiKey,
      });
      await expectError(divergent, 409, 'conflict');
    });

    it('refuses admin/member sessions and non-integrator agents', async () => {
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: '/api/v1/clients/adopt',
          body: { workspaceId: fixture.workspaceId, studioClientId: 'studio-client-delta', name: 'Delta' },
          cookie: fixture.adminCookie,
        }),
        403,
        'forbidden',
      );
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: '/api/v1/clients/adopt',
          body: { workspaceId: fixture.workspaceId, studioClientId: 'studio-client-delta', name: 'Delta' },
          cookie: fixture.memberACookie,
        }),
        403,
        'forbidden',
      );
      // Workspace exists but this agent lacks any grant for it → 404.
      const foreignAgent = await createAgent(fixture.db, fixture.auth, {
        userId: fixture.users.otherMember.id,
        workspaceId: fixture.workspaceId,
        clientIds: null,
        scopes: ['clients:write'],
      });
      // Revoke to simulate "grant for another workspace" — same 404 path.
      const [grantRow] = await fixture.db
        .select({ id: agentGrant.id })
        .from(agentGrant)
        .where(eq(agentGrant.keyId, foreignAgent.keyId))
        .limit(1);
      await revokeAgentGrant(fixture.db, grantRow!.id);
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: '/api/v1/clients/adopt',
          body: { workspaceId: fixture.workspaceId, studioClientId: 'studio-client-delta', name: 'Delta' },
          apiKey: foreignAgent.apiKey,
        }),
        404,
        'not_found',
      );
      // Unknown workspace → 404.
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: '/api/v1/clients/adopt',
          body: { workspaceId: 'no-such-workspace', studioClientId: 'x', name: 'x' },
          apiKey: fixture.integrator.apiKey,
        }),
        404,
        'not_found',
      );
    });
  });

  describe('delivery projection lifecycle', () => {
    let revisionId: string;
    let deliveryId: string;
    let assetId: string;

    it('creates the pending projection atomically before any byte moves', async () => {
      revisionId = `rev-${crypto.randomUUID().slice(0, 8)}`;
      const res = await createDelivery({ apiKey: fixture.integrator.apiKey }, deliveryBody(revisionId));
      expect(res.status).toBe(201);
      const view = await json<DeliveryBody>(res);
      deliveryId = view.id;
      expect(view.status).toBe('pending');
      expect(view.outputs.every((o) => o.ready === false)).toBe(true);

      const [asset] = await fixture.db
        .select({ id: clientAsset.id, visibility: clientAsset.visibility, editorialStatus: clientAsset.editorialStatus })
        .from(clientAsset)
        .where(eq(clientAsset.deliveryId, deliveryId))
        .limit(1);
      expect(asset?.visibility).toBe('internal');
      expect(asset?.editorialStatus).toBe('draft');
      assetId = asset!.id;
    });

    it('retries with the same exact refs do not duplicate; divergent payloads 409', async () => {
      const retry = await createDelivery({ apiKey: fixture.integrator.apiKey }, deliveryBody(revisionId));
      expect(retry.status).toBe(201);
      const view = await json<DeliveryBody>(retry);
      expect(view.id).toBe(deliveryId);

      const divergent = await createDelivery({ apiKey: fixture.integrator.apiKey }, {
        ...deliveryBody(revisionId),
        title: 'Different title',
      });
      await expectError(divergent, 409, 'conflict');

      const [row] = await fixture.db
        .select({ n: count() })
        .from(deliveryRevision)
        .where(and(eq(deliveryRevision.clientId, fixture.clientA.id), eq(deliveryRevision.revisionId, revisionId)));
      expect(row?.n).toBe(1);
    });

    it('rejects output staging that deviates from the declared selected output', async () => {
      const base = {
        kind: 'delivery_output',
        deliveryId,
        outputName: 'cover.png',
        mediaType: 'image/png',
        declaredBytes: PNG_BYTES.byteLength,
        sha256: sha256Hex(PNG_BYTES),
      };
      // Wrong byte count vs the selected output.
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
          body: { ...base, declaredBytes: PNG_BYTES.byteLength + 1 },
          apiKey: fixture.integrator.apiKey,
        }),
        409,
        'conflict',
      );
      // Wrong digest.
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
          body: { ...base, sha256: 'e'.repeat(64) },
          apiKey: fixture.integrator.apiKey,
        }),
        409,
        'conflict',
      );
      // Unknown output name in THIS delivery → 404 (no cross-delivery leak).
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
          body: { ...base, outputName: 'other-delivery-output.png' },
          apiKey: fixture.integrator.apiKey,
        }),
        404,
        'not_found',
      );
    });

    it('stays pending until every output byte is staged, then completes once', async () => {
      const early = await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/deliveries/${deliveryId}/complete`,
        apiKey: fixture.integrator.apiKey,
      });
      await expectError(early, 409, 'conflict');

      await stageAllOutputs({ apiKey: fixture.integrator.apiKey }, deliveryId);

      const done = await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/deliveries/${deliveryId}/complete`,
        apiKey: fixture.integrator.apiKey,
      });
      expect(done.status).toBe(200);
      const view = await json<DeliveryBody>(done);
      expect(view.status).toBe('ready');
      expect(view.outputs.every((o) => o.ready === true)).toBe(true);

      // Re-staging a completed output is refused; re-complete is idempotent.
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
          body: {
            kind: 'delivery_output',
            deliveryId,
            outputName: 'cover.png',
            mediaType: 'image/png',
            declaredBytes: PNG_BYTES.byteLength,
            sha256: sha256Hex(PNG_BYTES),
          },
          apiKey: fixture.integrator.apiKey,
        }),
        409,
        'conflict',
      );
      const again = await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/deliveries/${deliveryId}/complete`,
        apiKey: fixture.integrator.apiKey,
      });
      expect(again.status).toBe(200);
    });

    it('serves selected outputs to admin/agent with exact bytes and safe headers', async () => {
      const res = await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/deliveries/${deliveryId}/outputs/clip.mp4`,
        cookie: fixture.adminCookie,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('video/mp4');
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(MP4_BYTES);

      const head = await apiCall(fixture.deps, {
        method: 'HEAD',
        path: `/api/v1/deliveries/${deliveryId}/outputs/clip.mp4`,
        apiKey: fixture.integrator.apiKey,
      });
      expect(head.status).toBe(200);
      expect(head.headers.get('content-length')).toBe(String(MP4_BYTES.byteLength));

      const range = await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/deliveries/${deliveryId}/outputs/clip.mp4`,
        headers: { range: 'bytes=0-3' },
        cookie: fixture.adminCookie,
      });
      expect(range.status).toBe(206);
      expect(new Uint8Array(await range.arrayBuffer())).toEqual(MP4_BYTES.slice(0, 4));
    });

    it('recovers an orphaned output object on retry without duplicating', async () => {
      await resetClientQuota(fixture.db, fixture.clientA.id);
      const revision = `rev-orphan-${crypto.randomUUID().slice(0, 8)}`;
      const body = deliveryBody(revision);
      const res = await createDelivery({ apiKey: fixture.integrator.apiKey }, body);
      const orphanDelivery = await json<DeliveryBody>(res);

      // Crash simulation: final object exists, D1 output row not finalized.
      const finalKey = `deliveries/${orphanDelivery.id}/${sha256Hex(PNG_BYTES)}`;
      await env.ASSETS.put(finalKey, PNG_BYTES, { httpMetadata: { contentType: 'image/png' } });

      await stageAllOutputs({ apiKey: fixture.integrator.apiKey }, orphanDelivery.id);
      const done = await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/deliveries/${orphanDelivery.id}/complete`,
        apiKey: fixture.integrator.apiKey,
      });
      expect(done.status).toBe(200);
      const view = await json<DeliveryBody>(done);
      expect(view.status).toBe('ready');
      const head = await env.ASSETS.head(finalKey);
      expect(head?.size).toBe(PNG_BYTES.byteLength);
    });
  });

  describe('catalog visibility boundary', () => {
    let deliveryId: string;
    let assetId: string;

    it('stages a delivery and keeps it invisible to the member', async () => {
      const staged = await stageDelivery(fixture.deps, {
        principal: { apiKey: fixture.integrator.apiKey },
        clientId: fixture.clientA.id,
        revisionId: `rev-cat-${crypto.randomUUID().slice(0, 8)}`,
      });
      deliveryId = staged.deliveryId;
      assetId = staged.assetId;

      const memberAssets = await json<{ items: unknown[] }>(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/assets`,
          cookie: fixture.memberACookie,
        }),
      );
      expect(memberAssets.items).toHaveLength(0);
    });

    it('flips visibility for the member and separates provenance per principal', async () => {
      const show = await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/client-assets/${assetId}/visibility`,
        body: { visibility: 'client_visible' },
        cookie: fixture.adminCookie,
      });
      expect(show.status).toBe(200);

      const memberAssets = await json<{ items: Array<Record<string, unknown>> }>(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/assets`,
          cookie: fixture.memberACookie,
        }),
      );
      expect(memberAssets.items).toHaveLength(1);
      expect('rootHash' in memberAssets.items[0]!).toBe(false);

      const agentAssets = await json<{ items: Array<Record<string, unknown>> }>(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/assets`,
          apiKey: fixture.integrator.apiKey,
        }),
      );
      expect(agentAssets.items[0]).toHaveProperty('rootHash');

      // Member output download now allowed; foreign member still 404.
      const memberOutput = await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/deliveries/${deliveryId}/outputs/cover.png`,
        cookie: fixture.memberACookie,
      });
      expect(memberOutput.status).toBe(200);
      await expectError(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/deliveries/${deliveryId}/outputs/cover.png`,
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
    });

    it('keeps multi-client projects isolated per portal client', async () => {
      // Same Studio project/asset/revision delivered to BOTH clients: the
      // projections are distinct rows, each visible only inside its client.
      const revision = `rev-shared-${crypto.randomUUID().slice(0, 8)}`;
      const stagedB = await stageDelivery(fixture.deps, {
        principal: { apiKey: fixture.integrator.apiKey },
        clientId: fixture.clientB.id,
        revisionId: revision,
      });
      const memberBAssets = await json<{ items: { revisionId: string; id: string }[] }>(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientB.id}/assets`,
          cookie: fixture.memberBCookie,
        }),
      );
      // B's projection is internal, so the member sees nothing yet.
      expect(memberBAssets.items.some((a) => a.revisionId === revision)).toBe(false);

      // Admin sees exactly one B row for the shared revision; A rows stay in A.
      const adminBAssets = await json<{ items: { clientId: string; revisionId: string; id: string }[] }>(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientB.id}/assets`,
          cookie: fixture.adminCookie,
        }),
      );
      expect(adminBAssets.items.filter((a) => a.revisionId === revision)).toHaveLength(1);
      expect(adminBAssets.items.every((a) => a.clientId === fixture.clientB.id)).toBe(true);

      // B's asset id is 404 through A's surface (delivery output route).
      await expectError(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/deliveries/${stagedB.deliveryId}/outputs/cover.png`,
          cookie: fixture.memberACookie,
        }),
        404,
        'not_found',
      );
    });
  });
});
