import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, it, describe } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  deliverMagicLink,
  firstCookie,
  getSession,
  request,
  setupFixture,
  signInViaMagicLink,
} from './auth-fixture';
import {
  apikey,
  user as userTable,
  verification,
} from '../src/server/db/auth-schema';
import { provisionUser } from '../src/server/auth';

// P-001 auth/credentials proof on emulated D1. No mock substitutes the
// binding: every test drives the real Better Auth handler over HTTP-shaped
// requests and reads rows back through Drizzle on env.DB.

describe('magic link login on emulated D1', () => {
  it('happy path: sends one mail, persists a hashed token, mints a session', async () => {
    const fx = await setupFixture();
    const mail = await deliverMagicLink(fx.handler, fx.sink, fx.users.member.email);

    // The stored verification material is NOT the raw token (hashed storage).
    const rows = await fx.db.select().from(verification);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.value === mail.token || r.identifier === mail.token)).toBe(false);

    const verifyRes = await fx.handler(
      request(`/api/auth/magic-link/verify?token=${mail.token}`),
    );
    expect(verifyRes.status).toBe(200);
    const cookie = firstCookie(verifyRes);
    expect(cookie).toBeTruthy();

    const session = await getSession(fx.handler, cookie!);
    expect(session?.user?.email).toBe(fx.users.member.email);
    expect(session?.user?.role).toBe('member');
  });

  it('expired token fails: no session, verification rejected', async () => {
    const fx = await setupFixture();
    const mail = await deliverMagicLink(fx.handler, fx.sink, fx.users.member.email);

    // Age the persisted verification past its expiry in the real D1 row.
    const rows = await fx.db.select().from(verification);
    expect(rows.length).toBeGreaterThan(0);
    const target = rows.at(-1)!;
    await fx.db
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(verification.id, target.id));

    const verifyRes = await fx.handler(
      request(`/api/auth/magic-link/verify?token=${mail.token}`),
    );
    expect(firstCookie(verifyRes)).toBeNull();
    const session = await getSession(fx.handler, 'better-auth.session_token=none');
    expect(session).toBeNull();
  });

  it('replayed token fails after first consumption', async () => {
    const fx = await setupFixture();
    const mail = await deliverMagicLink(fx.handler, fx.sink, fx.users.member.email);

    const first = await fx.handler(
      request(`/api/auth/magic-link/verify?token=${mail.token}`),
    );
    expect(first.status).toBe(200);
    expect(firstCookie(first)).toBeTruthy();

    const replay = await fx.handler(
      request(`/api/auth/magic-link/verify?token=${mail.token}`),
    );
    expect(firstCookie(replay)).toBeNull();
  });

  it('unknown email: neutral response, mail may be sent, but signup and session are refused', async () => {
    const fx = await setupFixture();

    const known = await fx.handler(
      request('/api/auth/sign-in/magic-link', {
        method: 'POST',
        body: { email: fx.users.member.email },
      }),
    );
    const unknownEmail = 'ghost@portal.fixture';
    const before = await fx.db.select().from(userTable);
    const unknown = await fx.handler(
      request('/api/auth/sign-in/magic-link', { method: 'POST', body: { email: unknownEmail } }),
    );

    // Neutral: identical status and body whether the email exists or not.
    expect(unknown.status).toBe(known.status);
    expect(await unknown.json()).toEqual({ status: true });

    // Observed better-auth 1.7.7 behavior: sendMagicLink still fires and the
    // verification row exists, but disableSignUp gates signup at VERIFY time.
    const mail = fx.sink.mails.find((m) => m.email === unknownEmail);
    const beforeVerify = await fx.db.select().from(userTable);
    const verifyRes = await fx.handler(
      request(`/api/auth/magic-link/verify?token=${mail!.token}`),
    );
    expect(firstCookie(verifyRes)).toBeNull();
    const after = await fx.db.select().from(userTable);
    expect(after).toHaveLength(beforeVerify.length);
    expect(after).toHaveLength(before.length);
    expect(after.some((u) => u.email === unknownEmail)).toBe(false);
    void mail;
  });

  it('disableSignUp blocks public signup entirely', async () => {
    const fx = await setupFixture();
    const before = await fx.db.select().from(userTable);
    await fx.handler(
      request('/api/auth/sign-in/magic-link', {
        method: 'POST',
        body: { email: 'stranger@portal.fixture' },
      }),
    );
    const after = await fx.db.select().from(userTable);
    expect(after).toHaveLength(before.length);
    expect(after.some((u) => u.email === 'stranger@portal.fixture')).toBe(false);
  });
});

describe('session lifecycle on emulated D1', () => {
  it('get-session returns the provisioned user and sign-out ends it', async () => {
    const fx = await setupFixture();
    const cookie = await signInViaMagicLink(fx.handler, fx.sink, fx.users.member.email);

    const before = await getSession(fx.handler, cookie);
    expect(before?.user?.email).toBe(fx.users.member.email);

    const signOut = await fx.handler(request('/api/auth/sign-out', { method: 'POST', cookie }));
    expect(signOut.status).toBe(200);
    const cleared = firstCookie(signOut);
    const after = await getSession(fx.handler, cleared ?? cookie);
    expect(after?.user ?? null).toBeNull();
  });
});

describe('admin-only provisioning', () => {
  it('admin exists only through server-side provisioning; default role is member', async () => {
    const fx = await setupFixture();
    const admin = await fx.db
      .select()
      .from(userTable)
      .where(eq(userTable.email, 'admin@portal.fixture'));
    expect(admin).toHaveLength(1);
    expect(admin[0]!.role).toBe('admin');
    const member = await fx.db
      .select()
      .from(userTable)
      .where(eq(userTable.email, 'member@portal.fixture'));
    expect(member[0]!.role).toBe('member');
  });
});

describe('api keys: create / verify / revoke with real D1 persistence', () => {
  it('admin provisions an agent key server-side; verify succeeds; revoke takes effect on next request', async () => {
    const fx = await setupFixture();
    const adminCookie = await signInViaMagicLink(fx.handler, fx.sink, fx.users.admin.email);

    // Privileged, scoped keys are provisioned ONLY through the server-side
    // API (contracts.md §3). No HTTP surface can set scopes.
    const created = await fx.auth.api.createApiKey({
      body: {
        userId: fx.users.admin.id,
        name: 'cli-agent',
        permissions: { materials: ['read'], deliveries: ['write'] },
      },
    });
    expect(created.key).toBeTruthy();

    // Persisted in D1, and never in plaintext.
    const stored = await fx.db.select().from(apikey).where(eq(apikey.id, created.id));
    expect(stored).toHaveLength(1);
    expect(stored[0]!.key).not.toBe(created.key);
    expect(stored[0]!.referenceId).toBe(fx.users.admin.id);

    const verifyOk = await fx.auth.api.verifyApiKey({ body: { key: created.key } });
    expect(verifyOk.valid).toBe(true);
    expect(verifyOk.key?.id).toBe(created.id);

    // Scope enforcement on verification: granted scope passes, ungranted fails.
    const withinScope = await fx.auth.api.verifyApiKey({
      body: { key: created.key, permissions: { deliveries: ['write'] } },
    });
    expect(withinScope.valid).toBe(true);
    const escalation = await fx.auth.api.verifyApiKey({
      body: { key: created.key, permissions: { admin: ['*'] } },
    });
    expect(escalation.valid).toBe(false);

    // Revocation is session-guarded even server-side: it needs the admin
    // session (the plugin's delete route uses sessionMiddleware).
    await fx.auth.api.deleteApiKey({
      body: { keyId: created.id },
      headers: new Headers({ cookie: adminCookie }),
    });

    // Next request with the revoked key must fail.
    const verifyRevoked = await fx.auth.api.verifyApiKey({ body: { key: created.key } });
    expect(verifyRevoked.valid).toBe(false);
  });

  it('HTTP key creation accepts no scopes: permissions are server-only properties', async () => {
    const fx = await setupFixture();
    const adminCookie = await signInViaMagicLink(fx.handler, fx.sink, fx.users.admin.email);

    const escalateAttempt = await fx.handler(
      request('/api/auth/api-key/create', {
        method: 'POST',
        cookie: adminCookie,
        body: { name: 'escalate', permissions: { admin: ['*'] } },
      }),
    );
    expect(escalateAttempt.status).toBe(400);
    const err = (await escalateAttempt.json()) as { code?: string };
    expect(err.code).toBe('SERVER_ONLY_PROPERTY');
    expect(await fx.db.select().from(apikey)).toHaveLength(0);

    // Without scopes, an admin-session create succeeds and only the configured
    // default permissions (materials: read) are applied.
    const created = (await (
      await fx.handler(
        request('/api/auth/api-key/create', {
          method: 'POST',
          cookie: adminCookie,
          body: { name: 'default-scoped' },
        }),
      )
    ).json()) as { key: string; id: string; permissions: Record<string, string[]> };
    expect(created.key).toBeTruthy();
    expect(created.permissions).toEqual({ materials: ['read'] });
    expect(
      (await fx.db.select().from(apikey).where(eq(apikey.id, created.id)))[0]!.referenceId,
    ).toBe(fx.users.admin.id);
  });

  it('an API key never mints a session (no impersonation)', async () => {
    const fx = await setupFixture();
    const created = await fx.auth.api.createApiKey({
      body: { userId: fx.users.admin.id, name: 'probe' },
    });

    const sessionWithKey = await fx.handler(
      request('/api/auth/get-session', { apiKey: created.key }),
    );
    const body = (await sessionWithKey.json()) as unknown;
    expect(body ?? null).toBeNull();
  });
});

describe('transactional adapter config (documented, not faked)', () => {
  it('drizzle .transaction() is rejected by D1: adapter runs sequentially (transaction: false)', async () => {
    const fx = await setupFixture();

    // Repro (contracts.md §6: atomic work must use D1 batch, not interactive
    // BEGIN/COMMIT): drizzle's D1 session emits `begin`, which the emulated
    // D1 engine rejects, matching real D1 behavior.
    let txError: unknown;
    try {
      await fx.db.transaction(async (tx) => {
        await tx.insert(userTable).values({
          id: 'tx-probe-user',
          email: 'txprobe@portal.fixture',
          name: 'Tx Probe',
          role: 'member',
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      });
    } catch (error) {
      txError = error;
    }
    expect(String(txError)).toContain('begin');

    // The failed transaction must not have committed anything.
    const rows = await fx.db.select().from(userTable);
    expect(rows.some((r) => r.id === 'tx-probe-user')).toBe(false);

    // The supported mode: plain sequential statements (what better-auth's
    // drizzle adapter executes with `transaction: false`) persist normally.
    const provisioned = await provisionUser(fx.db, {
      email: 'seq@portal.fixture',
      name: 'Sequential',
      role: 'member',
    });
    expect(provisioned.role).toBe('member');
  });
});

describe('generic key routes are admin-guarded (no self-issue, no escalation)', () => {
  it('member session cannot create keys through /api/auth/api-key/*', async () => {
    const fx = await setupFixture();
    const memberCookie = await signInViaMagicLink(fx.handler, fx.sink, fx.users.member.email);

    const res = await fx.handler(
      request('/api/auth/api-key/create', {
        method: 'POST',
        cookie: memberCookie,
        body: { name: 'self-issued', permissions: { admin: ['*'] } },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
    const keys = await fx.db.select().from(apikey);
    expect(keys).toHaveLength(0);
  });

  it('member session cannot provision a key for another user', async () => {
    const fx = await setupFixture();
    const memberCookie = await signInViaMagicLink(fx.handler, fx.sink, fx.users.member.email);

    const res = await fx.handler(
      request('/api/auth/api-key/create', {
        method: 'POST',
        cookie: memberCookie,
        body: { name: 'usurped', userId: fx.users.admin.id },
      }),
    );
    expect(res.status).toBe(403);
    const keys = await fx.db.select().from(apikey);
    expect(keys.some((k) => k.referenceId === fx.users.admin.id)).toBe(false);
  });

  it('agent API key cannot reach key management or widen scopes', async () => {
    const fx = await setupFixture();
    const adminCookie = await signInViaMagicLink(fx.handler, fx.sink, fx.users.admin.email);
    const created = (await (
      await fx.handler(
        request('/api/auth/api-key/create', {
          method: 'POST',
          cookie: adminCookie,
          body: { name: 'agent', permissions: { materials: ['read'] } },
        }),
      )
    ).json()) as { key: string };

    for (const path of ['/api/auth/api-key/create', '/api/auth/api-key/list']) {
      const res = await fx.handler(
        request(path, {
          method: 'POST',
          apiKey: created.key,
          body: path.endsWith('create') ? { permissions: { deliveries: ['write'] } } : undefined,
        }),
      );
      expect(res.status).toBe(403);
    }
  });

  it('portal guard, not plugin courtesy, is what blocks cross-user provisioning', async () => {
    const fx = await setupFixture();
    const memberCookie = await signInViaMagicLink(fx.handler, fx.sink, fx.users.member.email);

    // The guarded portal surface must reject any member attempt, whatever
    // body it sends (cross-user userId included).
    const guarded = await fx.handler(
      request('/api/auth/api-key/create', {
        method: 'POST',
        cookie: memberCookie,
        body: { userId: fx.users.admin.id, name: 'usurped' },
      }),
    );
    expect(guarded.status).toBe(403);
    const keys = await fx.db.select().from(apikey);
    expect(keys.some((k) => k.referenceId === fx.users.admin.id)).toBe(false);
  });
});
