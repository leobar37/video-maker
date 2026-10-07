import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  apiCall,
  createAgent,
  expectError,
  json,
  setupPortalFixture,
  type PortalFixture,
} from './portal-fixture';
import { FIXTURE_ORIGIN, firstCookie, getSession, request } from './auth-fixture';
import { findUserByEmail } from '../src/server/auth';
import { revokeMembership } from '../src/server/clients';
import {
  auditEvent,
  invitation,
  membership,
} from '../src/server/db/schema';
import { verification } from '../src/server/db/auth-schema';

/**
 * Access-link minting (operator-ordered feature, 2026-10-05): admin human or
 * agent key with the explicit `access:write` scope mints a single-use login
 * URL for a client member with a configurable expiry. The link IS Better
 * Auth's magic-link token (same hashed, single-use verification row), so the
 * proofs below reuse the real /api/auth/magic-link/verify path. The minted
 * URL must never appear in audit rows, and members never mint.
 */

let fixture: PortalFixture;

/** Extracts the raw token from a minted link (tests treat it as a secret). */
function tokenOf(url: string): string {
  const token = new URL(url).searchParams.get('token');
  if (token === null || token.length === 0) throw new Error('minted link has no token');
  return token;
}

/** Drives the REAL verify endpoint with the minted token. */
async function consumeLink(handler: PortalFixture['handler'], token: string): Promise<Response> {
  return handler(
    request(`/api/auth/magic-link/verify?token=${token}&callbackURL=${encodeURIComponent(`${FIXTURE_ORIGIN}/`)}`),
  );
}

describe('access-link minting', () => {
  it('sets up the two-client fixture', async () => {
    fixture = await setupPortalFixture();
    expect(fixture.clientA.id).not.toBe(fixture.clientB.id);
  });

  it('admin mints a link: provisioning + invite-ledger membership + single response shape', async () => {
    const email = 'nueva@portal.fixture';
    const mintRes = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
      body: { email, expiresIn: '48h' },
      cookie: fixture.adminCookie,
    });
    expect(mintRes.status).toBe(201);
    const link = await json<{ url: string; email: string; expiresAt: number; singleUse: boolean }>(mintRes);
    expect(link.email).toBe(email);
    expect(link.singleUse).toBe(true);
    expect(link.url.startsWith(`${FIXTURE_ORIGIN}/api/auth/magic-link/verify?token=`)).toBe(true);
    // Default would be 7d; 48h was requested explicitly.
    expect(link.expiresAt).toBeGreaterThan(Date.now() + 47 * 3_600_000);
    expect(link.expiresAt).toBeLessThan(Date.now() + 49 * 3_600_000);

    // FR-001 provisioning: the member user exists (role=member) so the
    // disableSignUp verify path can succeed.
    const member = await findUserByEmail(fixture.deps.db, email);
    expect(member?.role).toBe('member');

    // Membership exists through the NORMAL invite ledger (accepted invitation).
    const [active] = await fixture.deps.db
      .select()
      .from(membership)
      .where(and(eq(membership.userId, member!.id), eq(membership.portalClientId, fixture.clientA.id)))
      .limit(1);
    expect(active?.status).toBe('active');
    const [invite] = await fixture.deps.db
      .select()
      .from(invitation)
      .where(and(eq(invitation.email, email), eq(invitation.portalClientId, fixture.clientA.id)))
      .limit(1);
    expect(invite?.status).toBe('accepted');
    expect(invite?.acceptedUserId).toBe(member!.id);

    // Audit records the mint (clientId + expiry window) but NEVER the url/token.
    const token = tokenOf(link.url);
    const audits = await fixture.deps.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.clientId, fixture.clientA.id));
    const mintAudit = audits.find((row) => row.action === 'access-link.mint');
    expect(mintAudit).toBeDefined();
    expect(mintAudit!.resourceType).toBe('membership');
    expect(mintAudit!.resourceId).toBe(active!.id);
    expect(JSON.stringify(audits)).not.toContain(token);
    expect(JSON.stringify(audits)).not.toContain(link.url);
  });

  it('consuming the minted link logs the member in exactly once', async () => {
    const email = 'unico@portal.fixture';
    const link = await json<{ url: string }>(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
        body: { email },
        cookie: fixture.adminCookie,
      }),
    );
    const first = await consumeLink(fixture.handler, tokenOf(link.url));
    expect(first.status).toBe(302);
    const cookie = firstCookie(first);
    expect(cookie).not.toBeNull();
    const session = await getSession(fixture.handler, cookie!);
    expect(session.user?.email).toBe(email);

    // Single use: the same token never mints a second session.
    const second = await consumeLink(fixture.handler, tokenOf(link.url));
    expect(firstCookie(second)).toBeNull();
    const location = second.headers.get('location') ?? '';
    expect(location).toContain('error=INVALID_TOKEN');

    // And the fresh member only sees the client they now belong to.
    const clients = await json<{ items: { id: string }[] }>(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/clients', cookie: cookie! }),
    );
    expect(clients.items.map((c) => c.id)).toEqual([fixture.clientA.id]);
  });

  it('agent with access:write mints; agent without it is 403; cross-client agent is 404', async () => {
    const allowed = await createAgent(fixture.deps.db, fixture.auth, {
      userId: fixture.users.member.id,
      workspaceId: fixture.workspaceId,
      clientIds: [fixture.clientA.id],
      scopes: ['access:write'],
    });
    const ok = await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
      body: { email: 'via-agente@portal.fixture', expiresIn: '30m' },
      apiKey: allowed.apiKey,
    });
    expect(ok.status).toBe(201);
    expect((await json<{ singleUse: boolean }>(ok)).singleUse).toBe(true);

    const denied = await createAgent(fixture.deps.db, fixture.auth, {
      userId: fixture.users.otherMember.id,
      workspaceId: fixture.workspaceId,
      clientIds: [fixture.clientA.id],
      scopes: ['clients:read'],
    });
    await expectError(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
        body: { email: 'denied@portal.fixture' },
        apiKey: denied.apiKey,
      }),
      403,
      'forbidden',
    );

    const foreign = await createAgent(fixture.deps.db, fixture.auth, {
      userId: fixture.users.otherMember.id,
      workspaceId: fixture.workspaceId,
      clientIds: [fixture.clientB.id],
      scopes: ['access:write'],
    });
    await expectError(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
        body: { email: 'foreign@portal.fixture' },
        apiKey: foreign.apiKey,
      }),
      404,
      'not_found',
    );
  });

  it('members never mint: own client 403, non-member client 404', async () => {
    await expectError(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
        body: { email: 'self@portal.fixture' },
        cookie: fixture.memberACookie,
      }),
      403,
      'forbidden',
    );
    await expectError(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
        body: { email: 'self@portal.fixture' },
        cookie: fixture.memberBCookie,
      }),
      404,
      'not_found',
    );
  });

  it('expiry is honored: row expiresAt matches the mint request and the verify path enforces it', async () => {
    const email = 'expira@portal.fixture';
    const link = await json<{ url: string; expiresAt: number }>(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
        body: { email, expiresIn: '30m' },
        cookie: fixture.adminCookie,
      }),
    );
    // Response promises ~30 minutes.
    expect(link.expiresAt).toBeGreaterThan(Date.now() + 29 * 60_000);
    expect(link.expiresAt).toBeLessThan(Date.now() + 31 * 60_000);

    // The verification ROW carries that exact lifetime (better-auth 1.7.7 has
    // no per-call expiresIn; the per-mint instance writes the row).
    const token = tokenOf(link.url);
    const rows = await fixture.deps.db.select().from(verification);
    const mintedRow = rows.find((row) => row.value.includes(email));
    expect(mintedRow).toBeDefined();
    const expected = new Date(link.expiresAt);
    expect(Math.abs(mintedRow!.expiresAt.getTime() - expected.getTime())).toBeLessThan(60_000);

    // Expiry is enforced by the ROW (not config): backdate it and the verify
    // path refuses without minting a session.
    await fixture.deps.db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(verification.id, mintedRow!.id));
    const expired = await consumeLink(fixture.handler, token);
    expect(firstCookie(expired)).toBeNull();
    expect(expired.headers.get('location') ?? '').toContain('error=INVALID_TOKEN');
  });

  it('revoked membership: mint refuses (409) and an older link grants no client access', async () => {
    const email = 'revocado@portal.fixture';
    const link = await json<{ url: string }>(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
        body: { email },
        cookie: fixture.adminCookie,
      }),
    );
    const member = await findUserByEmail(fixture.deps.db, email);
    const [row] = await fixture.deps.db
      .select()
      .from(membership)
      .where(and(eq(membership.userId, member!.id), eq(membership.portalClientId, fixture.clientA.id)))
      .limit(1);
    expect(row?.status).toBe('active');

    // Re-mint for the same existing member never duplicates the membership...
    const membershipsBefore = await fixture.deps.db
      .select()
      .from(membership)
      .where(eq(membership.userId, member!.id));
    await apiCall(fixture.deps, {
      method: 'POST',
      path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
      body: { email },
      cookie: fixture.adminCookie,
    });
    const membershipsAfter = await fixture.deps.db
      .select()
      .from(membership)
      .where(eq(membership.userId, member!.id));
    expect(membershipsAfter.length).toBe(membershipsBefore.length);

    // ...and revocation is never resurrected by minting.
    await revokeMembership(fixture.deps.db, row!.id);
    await expectError(
      await apiCall(fixture.deps, {
        method: 'POST',
        path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
        body: { email },
        cookie: fixture.adminCookie,
      }),
      409,
      'conflict',
    );

    // A link minted BEFORE the revocation still logs in (auth layer), but the
    // very next client-scoped request is denied: no membership, no access.
    const res = await consumeLink(fixture.handler, tokenOf(link.url));
    const cookie = firstCookie(res);
    expect(cookie).not.toBeNull();
    const clients = await json<{ items: { id: string }[] }>(
      await apiCall(fixture.deps, { method: 'GET', path: '/api/v1/clients', cookie: cookie! }),
    );
    expect(clients.items.map((c) => c.id)).not.toContain(fixture.clientA.id);
  });

  it('rejects bad input: unapproved origin, out-of-bounds expiresIn, missing email', async () => {
    const base = {
      method: 'POST' as const,
      path: `/api/v1/clients/${fixture.clientA.id}/access-links`,
      cookie: fixture.adminCookie,
    };
    await expectError(
      await apiCall(fixture.deps, { ...base, body: { email: 'x@portal.fixture', origin: 'https://evil.example' } }),
      400,
      'bad_request',
    );
    await expectError(
      await apiCall(fixture.deps, { ...base, body: { email: 'x@portal.fixture', expiresIn: '5m' } }),
      400,
      'bad_request',
    );
    await expectError(
      await apiCall(fixture.deps, { ...base, body: { email: 'x@portal.fixture', expiresIn: '60d' } }),
      400,
      'bad_request',
    );
    await expectError(
      await apiCall(fixture.deps, { ...base, body: { email: 'x@portal.fixture', expiresIn: 'pronto' } }),
      400,
      'bad_request',
    );
    await expectError(await apiCall(fixture.deps, { ...base, body: {} }), 400, 'bad_request');
    await expectError(
      await apiCall(fixture.deps, { ...base, body: { email: 'no-es-un-email' } }),
      400,
      'bad_request',
    );
  });
});
