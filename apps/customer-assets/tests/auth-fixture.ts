import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, beforeAll } from 'vitest';
import {
  createPortalAuth,
  createPortalAuthHandler,
  findUserByEmail,
  provisionUser,
  type MagicLinkMail,
  type PortalAuth,
  type PortalAuthHandler,
} from '../src/server/auth';
import { createDb, type PortalDb } from '../src/server/db';
import {
  account,
  apikey,
  session,
  user as userTable,
  verification,
} from '../src/server/db/auth-schema';

/**
 * Runtime proof for auth on emulated D1 (no mocks substitute the binding):
 * every assertion below reads persisted rows or drives the real Better Auth
 * HTTP handler. Fixture values are synthetic (example.invalid domains);
 * captured mail is referenced by id only and never logged.
 */

export const FIXTURE_ORIGIN = 'http://portal.fixture';
export const FIXTURE_SECRET = 'fixture-secret-emulated-tests-only';

export interface MailSink {
  mails: MagicLinkMail[];
  send: (mail: { email: string; token: string; url: string }) => Promise<void>;
}

export function createMailSink(): MailSink {
  const mails: MagicLinkMail[] = [];
  return {
    mails,
    send: async (mail) => {
      mails.push({ id: crypto.randomUUID(), ...mail });
    },
  };
}

export interface FixtureUsers {
  admin: { id: string; email: string; role: string };
  member: { id: string; email: string; role: string };
  otherMember: { id: string; email: string; role: string };
}

export interface Fixture {
  handler: PortalAuthHandler;
  auth: PortalAuth;
  sink: MailSink;
  db: PortalDb;
  users: FixtureUsers;
}

/** Applies migrations and provisions users idempotently on the current storage. */
export async function setupFixture(
  options: { magicLinkExpiresIn?: number } = {},
): Promise<Fixture> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const db = createDb(env.DB);

  // Storage persists between tests in this harness; start each fixture from
  // a clean auth state (FK-safe order).
  await db.delete(apikey);
  await db.delete(session);
  await db.delete(verification);
  await db.delete(account);
  await db.delete(userTable);

  const seeds: Array<{ email: string; name: string; role: 'admin' | 'member' }> = [
    { email: 'admin@portal.fixture', name: 'Portal Admin', role: 'admin' },
    { email: 'member@portal.fixture', name: 'Member One', role: 'member' },
    { email: 'other@portal.fixture', name: 'Member Two', role: 'member' },
  ];
  const users: FixtureUsers = {} as FixtureUsers;
  for (const seed of seeds) {
    await db
      .insert(userTable)
      .values({
        id: crypto.randomUUID(),
        email: seed.email,
        name: seed.name,
        role: seed.role,
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
    const row = await findUserByEmail(db, seed.email);
    if (!row) throw new Error(`fixture provisioning failed for ${seed.role}`);
    users[seed.role === 'admin' ? 'admin' : seed.role === 'member' ? 'member' : 'otherMember'] = {
      id: row.id,
      email: row.email,
      role: row.role,
    };
  }

  const sink = createMailSink();
  const auth = createPortalAuth(env, {
    secret: FIXTURE_SECRET,
    baseURL: FIXTURE_ORIGIN,
    sendMagicLink: sink.send,
    magicLinkExpiresIn: options.magicLinkExpiresIn,
    rateLimitEnabled: false,
  });
  return { handler: createPortalAuthHandler(auth), auth, sink, db, users };
}

export function request(
  path: string,
  init: {
    method?: 'GET' | 'POST';
    body?: unknown;
    cookie?: string;
    apiKey?: string;
  } = {},
): Request {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: FIXTURE_ORIGIN,
  });
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.apiKey) headers.set('x-api-key', init.apiKey);
  return new Request(`${FIXTURE_ORIGIN}${path}`, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export function firstCookie(response: Response): string | null {
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) return null;
  return cookies[0]!.split(';')[0]!;
}

export async function getSession(
  handler: PortalAuthHandler,
  cookie: string,
): Promise<{ user: { email: string; role?: string | null } | null }> {
  const response = await handler(request('/api/auth/get-session', { cookie }));
  return (await response.json()) as { user: { email: string; role?: string | null } | null };
}

export async function signInViaMagicLink(
  handler: PortalAuthHandler,
  sink: MailSink,
  email: string,
): Promise<string> {
  const sendRes = await handler(
    request('/api/auth/sign-in/magic-link', { method: 'POST', body: { email } }),
  );
  expect(sendRes.status).toBe(200);
  const sent = sink.mails.at(-1);
  if (!sent) throw new Error('expected a captured magic-link mail');
  const verifyRes = await handler(
    request(`/api/auth/magic-link/verify?token=${sent.token}`),
  );
  const cookie = firstCookie(verifyRes);
  if (!cookie) throw new Error('expected a session cookie from magic-link verify');
  return cookie;
}

/** Delivers a magic link and returns (mail id, raw token) without verifying. */
export async function deliverMagicLink(
  handler: PortalAuthHandler,
  sink: MailSink,
  email: string,
): Promise<MagicLinkMail> {
  const sendRes = await handler(
    request('/api/auth/sign-in/magic-link', { method: 'POST', body: { email } }),
  );
  expect(sendRes.status).toBe(200);
  const mail = sink.mails.at(-1);
  if (!mail) throw new Error('expected a captured magic-link mail');
  return mail;
}

export async function countRows(
  db: PortalDb,
  table: typeof userTable | typeof verification | typeof apikey,
): Promise<number> {
  const rows = await db.select().from(table);
  return rows.length;
}

beforeAll(async () => {
  // Ensures migrations exist for the pool's TEST_MIGRATIONS binding even when
  // a suite only imports this helper for types.
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
