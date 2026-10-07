import { describe, expect, it } from 'vitest';
import {
  apiCall,
  createAgent,
  disableAgentKey,
  expectError,
  expectNoInternalPaths,
  json,
  resetClientQuota,
  setupPortalFixture,
  stageDelivery,
  uploadMaterial,
  JPEG_BYTES,
  PNG_BYTES,
  sha256Hex,
  type PortalFixture,
} from './portal-fixture';
import { revokeAgentGrant, revokeMembership } from '../src/server/clients';
import { agentGrant, deliveryRevision, membership } from '../src/server/db/schema';
import { eq } from 'drizzle-orm';

/**
 * Tenant/scope matrix (DoD): two clients, one multi-client project, every
 * access path checked cross-client and per-principal-kind. Cross-client
 * answers are ALWAYS 404 (no enumeration); 403 is reserved for authorized
 * resources with insufficient scope/role.
 */

let fixture: PortalFixture;

describe('P-002 access control', () => {
  it('sets up the two-client fixture', async () => {
    fixture = await setupPortalFixture();
    expect(fixture.clientA.id).not.toBe(fixture.clientB.id);
  });

  it('authenticates principals: 401 without identity, kinds via /me', async () => {
    const anon = await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/me' });
    await expectError(anon, 401, 'unauthorized');

    const admin = await json<{ me: { kind: string; email?: string } }>(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/me', cookie: fixture.adminCookie }),
    );
    expect(admin.me.kind).toBe('admin');

    const member = await json<{ me: { kind: string; email?: string } }>(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/me', cookie: fixture.memberACookie }),
    );
    expect(member.me.kind).toBe('member');
    expect(member.me.email).toBe('member@portal.fixture');

    const agent = await json<{ me: { kind: string; scopes?: string[] } }>(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/me', apiKey: fixture.integrator.apiKey }),
    );
    expect(agent.me.kind).toBe('agent');
    expect(agent.me.scopes).toContain('materials:read');

    const bogus = await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/me', apiKey: 'not-a-real-key' });
    await expectError(bogus, 401, 'unauthorized');
  });

  it('lists exactly the authorized clients per principal kind', async () => {
    const admin = await json<{ items: { id: string }[] }>(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/clients', cookie: fixture.adminCookie }),
    );
    expect(admin.items.map((c) => c.id).sort()).toEqual([fixture.clientA.id, fixture.clientB.id].sort());

    const memberA = await json<{ items: { id: string }[] }>(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/clients', cookie: fixture.memberACookie }),
    );
    expect(memberA.items.map((c) => c.id)).toEqual([fixture.clientA.id]);

    const memberB = await json<{ items: { id: string }[] }>(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/clients', cookie: fixture.memberBCookie }),
    );
    expect(memberB.items.map((c) => c.id)).toEqual([fixture.clientB.id]);

    const agent = await json<{ items: { id: string }[] }>(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/clients', apiKey: fixture.integrator.apiKey }),
    );
    expect(agent.items.map((c) => c.id).sort()).toEqual([fixture.clientA.id, fixture.clientB.id].sort());
    await expectNoInternalPaths(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/clients', cookie: fixture.adminCookie }),
    );
  });

  describe('cross-client denial on every path (member B vs client A)', () => {
    let materialId: string;
    let uploadId: string;
    let deliveryId: string;

    it('seeds client A with a material, a pending upload and an internal delivery', async () => {
      const material = await uploadMaterial(fixture.deps, {
        principal: { cookie: fixture.adminCookie },
        clientId: fixture.clientA.id,
        name: 'alpha.jpg',
      });
      expect(material.status).toBe(201);
      materialId = (await json<{ id: string }>(material)).id;

      const init = await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
        body: { kind: 'material', mediaType: 'image/jpeg', declaredBytes: JPEG_BYTES.byteLength },
        cookie: fixture.adminCookie,
      });
      uploadId = (await json<{ uploadId: string }>(init)).uploadId;

      const delivery = await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/clients/${fixture.clientA.id}/deliveries`,
        body: {
          projectId: 'proj-multi-1',
          assetId: 'asset-open-1',
          revisionId: `rev-${crypto.randomUUID().slice(0, 8)}`,
          rootHash: 'a'.repeat(64),
          title: 'Internal draft',
          kind: 'social',
          outputs: [
            { name: 'cover.png', mediaType: 'image/png', bytes: 10, sha256: 'b'.repeat(64) },
          ],
        },
        cookie: fixture.adminCookie,
      });
      expect(delivery.status).toBe(201);
      deliveryId = (await json<{ id: string }>(delivery)).id;
    });

    it('denies list/show/content/HEAD/Range', async () => {
      const cases: Array<{ method: 'GET' | 'HEAD'; path: string; extra?: Record<string, string> }> = [
        { method: 'GET', path: `/api/v1/clients/${fixture.clientA.id}/materials` },
        { method: 'GET', path: `/api/v1/materials/${materialId}` },
        { method: 'GET', path: `/api/v1/materials/${materialId}/content` },
        { method: 'HEAD', path: `/api/v1/materials/${materialId}/content` },
        { method: 'GET', path: `/api/v1/materials/${materialId}/content`, extra: { range: 'bytes=0-3' } },
      ];
      for (const c of cases) {
        const res = await apiCall(fixture.deps, { method: c.method, path: c.path, headers: c.extra, cookie: fixture.memberBCookie });
        await expectError(res, 404, 'not_found');
      }
    });

    it('denies upload init/complete and foreign session access', async () => {
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
          body: { kind: 'material', mediaType: 'image/jpeg', declaredBytes: 10 },
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
      // Foreign upload id: even the same principal kind, different client.
      await expectError(
        await apiCall(fixture.deps, {
          method: 'PUT',
          path: `/api/v1/uploads/${uploadId}/content`,
          rawBody: JPEG_BYTES,
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/uploads/${uploadId}/complete`,
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
    });

    it('denies delivery create/complete/output and asset/post/grid access', async () => {
      const body = {
        projectId: 'p',
        assetId: 'a',
        revisionId: 'r',
        rootHash: 'c'.repeat(64),
        title: 't',
        kind: 'social',
        outputs: [{ name: 'x.png', mediaType: 'image/png', bytes: 5, sha256: 'd'.repeat(64) }],
      };
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/clients/${fixture.clientA.id}/deliveries`,
          body,
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/deliveries/${deliveryId}/complete`,
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
      await expectError(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/deliveries/${deliveryId}/outputs/cover.png`,
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
      await expectError(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/assets`,
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
      await expectError(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/posts`,
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/clients/${fixture.clientA.id}/posts`,
          body: { assetId: 'x', title: 't', outputNames: ['cover.png'], coverOutputName: 'cover.png', visibility: 'internal' },
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
      await expectError(
        await apiCall(fixture.deps, {
          method: 'PATCH',
          path: `/api/v1/clients/${fixture.clientA.id}/grid`,
          body: { version: 1, order: [] },
          cookie: fixture.memberBCookie,
        }),
        404,
        'not_found',
      );
    });
  });

  describe('member never sees internal drafts or internal fields', () => {
    let assetId: string;
    let deliveryId: string;
    let outputBytes: Uint8Array;

    it('seeds a fully staged, internal delivery for client A', async () => {
      outputBytes = PNG_BYTES;
      const staged = await stageDelivery(fixture.deps, {
        principal: { cookie: fixture.adminCookie },
        clientId: fixture.clientA.id,
        revisionId: `rev-internal-${crypto.randomUUID().slice(0, 8)}`,
      });
      deliveryId = staged.deliveryId;
      assetId = staged.assetId;
      expect(staged.outputs[0]!.sha256).toBe(sha256Hex(PNG_BYTES));
    });

    it('hides internal assets/outputs from the member', async () => {
      const assets = await json<{ items: unknown[] }>(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/assets`,
          cookie: fixture.memberACookie,
        }),
      );
      expect(assets.items).toEqual([]);

      await expectError(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/deliveries/${deliveryId}/outputs/cover.png`,
          cookie: fixture.memberACookie,
        }),
        404,
        'not_found',
      );

      const posts = await json<{ items: unknown[] }>(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/posts`,
          cookie: fixture.memberACookie,
        }),
      );
      expect(posts.items).toEqual([]);
    });

    it('exposes nothing internal in member DTOs, admin view carries provenance', async () => {
      const showRes = await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/client-assets/${assetId}/visibility`,
        body: { visibility: 'client_visible' },
        cookie: fixture.adminCookie,
      });
      expect(showRes.status).toBe(200);

      const memberAssets = await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/assets`,
        cookie: fixture.memberACookie,
      });
      expect(memberAssets.status).toBe(200);
      await expectNoInternalPaths(memberAssets);
      const memberView = await json<{ items: Array<Record<string, unknown>> }>(memberAssets);
      expect(memberView.items).toHaveLength(1);
      expect(memberView.items[0]).toHaveProperty('visibility', 'client_visible');
      expect('rootHash' in memberView.items[0]!).toBe(false);

      const adminAssets = await json<{ items: Array<Record<string, unknown>> }>(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/assets`,
          cookie: fixture.adminCookie,
        }),
      );
      expect(adminAssets.items[0]).toHaveProperty('rootHash');

      // Member output download now works — the ONLY change was visibility.
      const output = await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/deliveries/${deliveryId}/outputs/cover.png`,
        cookie: fixture.memberACookie,
      });
      expect(output.status).toBe(200);
      const bytes = new Uint8Array(await output.arrayBuffer());
      expect(bytes).toEqual(outputBytes);
    });
  });

  describe('agent scopes are validated server-side', () => {
    it('denies writes beyond the granted scope with 403 on an authorized client', async () => {
      const agent = await createAgent(fixture.db, fixture.auth, {
        userId: fixture.users.member.id,
        workspaceId: fixture.workspaceId,
        clientIds: [fixture.clientA.id],
        scopes: ['materials:read'],
      });
      // Authorized client + materials:read → list works.
      const list = await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/materials`,
        apiKey: agent.apiKey,
      });
      expect(list.status).toBe(200);

      // Same client, missing scope → 403 (never 404: the client is granted).
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/clients/${fixture.clientA.id}/uploads`,
          body: { kind: 'material', mediaType: 'image/jpeg', declaredBytes: 10 },
          apiKey: agent.apiKey,
        }),
        403,
        'forbidden',
      );
      // Client outside the grant list → 404 even with a valid scope.
      await expectError(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientB.id}/materials`,
          apiKey: agent.apiKey,
        }),
        404,
        'not_found',
      );
      // Admin-only surfaces are unavailable to agent keys: the client IS
      // granted, so the answer is the role refusal (403), never silent 404.
      await expectError(
        await apiCall(fixture.deps, {
          method: 'POST',
          path: `/api/v1/clients/${fixture.clientA.id}/posts`,
          body: { assetId: 'x', title: 't', outputNames: ['a'], coverOutputName: 'a', visibility: 'internal' },
          apiKey: agent.apiKey,
        }),
        403,
        'forbidden',
      );
    });

    it('rejects manipulated output names and paths with 404', async () => {
      const deliveryId = await firstDeliveryId();
      for (const name of ['..%2Fmaterials%2Fx', 'sub%2Fpath', '.', 'a%00b', 'missing-output.png']) {
        const res = await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/deliveries/${deliveryId}/outputs/${name}`,
          cookie: fixture.adminCookie,
        });
        expect([404, 400]).toContain(res.status);
        if (res.status === 400) await res.json();
      }
    });

    async function firstDeliveryId(): Promise<string> {
      const [found] = await fixture.db.select({ id: deliveryRevision.id }).from(deliveryRevision).limit(1);
      if (!found) throw new Error('expected a seeded delivery');
      return found.id;
    }
  });

  describe('revocation is effective on the next request', () => {
    it('membership revocation cuts access immediately', async () => {
      const list = await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/materials`,
        cookie: fixture.memberACookie,
      });
      expect(list.status).toBe(200);

      const [membershipRow] = await fixture.db
        .select({ id: membership.id })
        .from(membership)
        .where(eq(membership.userId, fixture.users.member.id))
        .limit(1);
      await revokeMembership(fixture.db, membershipRow!.id);

      await expectError(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/materials`,
          cookie: fixture.memberACookie,
        }),
        404,
        'not_found',
      );

      // Re-activate the SAME row for later suites (unique per user+client).
      await fixture.db
        .update(membership)
        .set({ status: 'active', revokedMs: null })
        .where(eq(membership.id, membershipRow.id));
      const restored = await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/materials`,
        cookie: fixture.memberACookie,
      });
      expect(restored.status).toBe(200);
    });

    it('grant revocation cuts agent access immediately; key disable yields 401', async () => {
      const agent = await createAgent(fixture.db, fixture.auth, {
        userId: fixture.users.member.id,
        workspaceId: fixture.workspaceId,
        clientIds: null,
        scopes: ['materials:read'],
      });
      const ok = await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/materials`,
        apiKey: agent.apiKey,
      });
      expect(ok.status).toBe(200);

      // Find the grant for this key and revoke it.
      const [grantRow] = await fixture.db
        .select({ id: agentGrant.id })
        .from(agentGrant)
        .where(eq(agentGrant.keyId, agent.keyId))
        .limit(1);
      await revokeAgentGrant(fixture.db, grantRow!.id);

      await expectError(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/materials`,
          apiKey: agent.apiKey,
        }),
        404,
        'not_found',
      );

      await disableAgentKey(fixture.db, agent.keyId);
      await expectError(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/materials`,
          apiKey: agent.apiKey,
        }),
        401,
        'unauthorized',
      );
    });
  });

  describe('private content headers and envelope discipline', () => {
    it('marks content responses private with safe MIME and CSP', async () => {
      await resetClientQuota(fixture.db, fixture.clientA.id);
      const material = await uploadMaterial(fixture.deps, {
        principal: { cookie: fixture.adminCookie },
        clientId: fixture.clientA.id,
        name: 'headers.jpg',
      });
      const view = await json<{ id: string }>(material);
      const res = await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/materials/${view.id}/content`,
        cookie: fixture.memberACookie,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(res.headers.get('content-type')).toBe('image/jpeg');
      expect(res.headers.get('accept-ranges')).toBe('bytes');
      expect(res.headers.get('content-disposition')).toContain('inline');
    });

    it('pages lists as {items, nextCursor} and 404s unknown routes', async () => {
      const page = await json<{ items: unknown[]; nextCursor: string | null }>(
        await apiCall(fixture.deps, {
          method: 'GET',
          path: `/api/v1/clients/${fixture.clientA.id}/materials?limit=1`,
          cookie: fixture.memberACookie,
        }),
      );
      expect(Array.isArray(page.items)).toBe(true);
      expect(typeof page.nextCursor === 'string' || page.nextCursor === null).toBe(true);

      await expectError(
        await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/unknown', cookie: fixture.adminCookie }),
        404,
        'not_found',
      );
    });
  });
});
