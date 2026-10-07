/**
 * E2E-ONLY fixture endpoint (G-cap-local: ephemeral local servers, fake mail).
 *
 * DEAD CODE in any real deployment: every handler answers 404 unless the
 * Worker was started with the `E2E_FIXTURE` var, which only the e2e vite
 * config sets (tests/e2e/vite.config.ts, loopback only). It exists so the
 * harness can (a) reset/apply migrations on the emulated D1, (b) provision
 * users/clients/memberships through the SAME services production uses, and
 * (c) mint a REAL Better Auth session via the real magic-link machinery with
 * a fake sink — no mail provider exists offline. It never runs on deploy and
 * never returns anything beyond the loopback test session URL.
 */

import { createFileRoute } from '@tanstack/react-router';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { createPortalAuth, createPortalAuthHandler, provisionUser, findUserByEmail } from '../../../server/auth';
import { createDb, type PortalDb } from '../../../server/db';
import { membership, portalClient, portalWorkspace } from '../../../server/db/schema';
import { createMembership } from '../../../server/clients';

function fixtureEnabled(): boolean {
  return (env as { E2E_FIXTURE?: string }).E2E_FIXTURE === '1';
}

function refused(): Response {
  return Response.json({ error: { code: 'not_found', message: 'Resource not found.', requestId: 'fixture' } }, { status: 404 });
}

function ok(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

/** Tables from migrations 0001/0002 — dropped FK-safe before re-apply. */
const DROP_ORDER = [
  'audit_event',
  'post_output',
  'post',
  'client_grid',
  'client_asset',
  'delivery_output',
  'delivery_revision',
  'material',
  'upload_session',
  'idempotency_record',
  'client_quota',
  'agent_grant',
  'invitation',
  'membership',
  'portal_client',
  'portal_workspace',
  'apikey',
  'session',
  'verification',
  'account',
  'user',
  'd1_migrations',
];

async function resetDatabase(db: PortalDb, statements: string[]): Promise<void> {
  for (const table of DROP_ORDER) {
    await db.run(`DROP TABLE IF EXISTS "${table}"`);
  }
  for (const statement of statements) {
    await db.run(statement);
  }
}

const resetSchema = z.object({ statements: z.array(z.string()).max(500) });

const provisionSchema = z.object({
  users: z.array(z.object({ email: z.string().email(), name: z.string().min(1), role: z.enum(['admin', 'member']) })).min(1),
  workspaceLabel: z.string().min(1),
  integratorEmail: z.string().email(),
  clients: z.array(z.object({ studioClientId: z.string().min(1), name: z.string().min(1) })).min(1),
  memberships: z.array(z.object({ userEmail: z.string().email(), clientIndex: z.number().int().min(0) })),
});

/** Splits drizzle-format DDL (blank-line separated statements). */
function splitStatements(sql: string): string[] {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

async function fixtureHandler(request: Request): Promise<Response> {
  if (!fixtureEnabled()) return refused();
  const url = new URL(request.url);
  const db = createDb(env.DB);

  if (url.pathname === '/api/fixture/reset' && request.method === 'POST') {
    const parsed = resetSchema.safeParse(await request.json());
    if (!parsed.success) return ok({ ok: false, message: 'invalid body' }, 400);
    await resetDatabase(db, parsed.data.statements);
    return ok({ ok: true });
  }

  if (url.pathname === '/api/fixture/provision' && request.method === 'POST') {
    const parsed = provisionSchema.safeParse(await request.json());
    if (!parsed.success) return ok({ ok: false, message: 'invalid body' }, 400);
    const input = parsed.data;
    for (const user of input.users) {
      const existing = await findUserByEmail(db, user.email);
      if (existing === undefined) {
        await provisionUser(db, { email: user.email, name: user.name, role: user.role });
      }
    }
    const integrator = await findUserByEmail(db, input.integratorEmail);
    if (integrator === undefined) return ok({ ok: false, message: 'integrator missing' }, 400);
    const [workspace] = await db
      .insert(portalWorkspace)
      .values({
        id: crypto.randomUUID(),
        label: input.workspaceLabel,
        integratorUserId: integrator.id,
        createdMs: Date.now(),
      })
      .returning();
    const clients: { id: string; studioClientId: string; name: string }[] = [];
    let index = 0;
    for (const client of input.clients) {
      const [row] = await db
        .insert(portalClient)
        .values({
          id: crypto.randomUUID(),
          workspaceId: workspace!.id,
          studioClientId: client.studioClientId,
          name: client.name,
          projectionVersion: 1,
          createdMs: Date.now() + index,
        })
        .returning();
      clients.push({ id: row!.id, studioClientId: row!.studioClientId, name: row!.name });
      index += 1;
    }
    for (const link of input.memberships) {
      const user = await findUserByEmail(db, link.userEmail);
      const target = clients[link.clientIndex];
      if (user !== undefined && target !== undefined) {
        await createMembership(db, { userId: user.id, portalClientId: target.id });
      }
    }
    return ok({ ok: true, workspaceId: workspace!.id, clients });
  }

  if (url.pathname === '/api/fixture/session' && request.method === 'POST') {
    const parsed = z
      .object({ email: z.string().email(), callbackURL: z.string().max(200).optional() })
      .safeParse(await request.json());
    if (!parsed.success) return ok({ ok: false, message: 'invalid body' }, 400);
    // A dedicated auth instance over the SAME D1 with a FAKE sink: the
    // sign-in → verify flow is the real Better Auth machinery end to end.
    const mails: { token: string; url: string; email: string }[] = [];
    const origin = url.origin;
    const auth = createPortalAuth(env, {
      secret: env.BETTER_AUTH_SECRET ?? 'e2e-fixture-secret-local-only-0123456789abcdef',
      baseURL: origin,
      rateLimitEnabled: false,
      sendMagicLink: async (mail) => {
        mails.push(mail);
      },
    });
    const handler = createPortalAuthHandler(auth);
    const jsonHeaders = { 'content-type': 'application/json', origin };
    const signIn = await handler(
      new Request(`${origin}/api/auth/sign-in/magic-link`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ email: parsed.data.email, callbackURL: parsed.data.callbackURL ?? '/portal' }),
      }),
    );
    if (!signIn.ok) {
      return ok({ ok: false, message: `sign-in failed: ${signIn.status}` }, 500);
    }
    const mail = mails.at(-1);
    if (mail === undefined) return ok({ ok: false, message: 'no mail captured' }, 500);
    return ok({ ok: true, verifyUrl: mail.url });
  }

  return refused();
}

export const Route = createFileRoute('/api/fixture/$')({
  server: {
    handlers: {
      POST: ({ request }) => fixtureHandler(request),
      GET: ({ request }) => fixtureHandler(request),
    },
  },
});
