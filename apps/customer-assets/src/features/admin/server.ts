/**
 * Admin dashboard server functions (contracts.md §6/§8): invites, memberships
 * and agent-key management. There are deliberately NO generic HTTP endpoints
 * behind these — each function resolves the principal from the incoming
 * request (same guard as /api/v1), requires a provisioned ADMIN HUMAN
 * session, and calls the same audited services the API uses. Results are
 * plain `UiResult` unions so failures stay typed across the server boundary
 * without relying on error serialization.
 */

import { desc, eq } from 'drizzle-orm';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { env } from 'cloudflare:workers';
import { provisionUser, findUserByEmail } from '../../server/auth';
import { createDb, type PortalDb } from '../../server/db';
import { agentGrant, invitation, membership, portalClient } from '../../server/db/schema';
import { apikey, user as userTable } from '../../server/db/auth-schema';
import {
  PortalError,
  resolvePrincipal,
  requireAdmin,
  notFound,
  parseExpiresIn,
  type Principal,
  type RequestDeps,
} from '../../server/access';
import { createPortalAuth } from '../../server/auth';
import {
  acceptInvitation,
  createAgentGrant,
  createInvitation,
  issueAgentKey,
  mintAccessLink,
  revokeAgentGrant,
  revokeMembership,
} from '../../server/clients';

let cachedDeps: RequestDeps | null = null;

function portalDeps(): RequestDeps {
  cachedDeps ??= {
    env: { DB: env.DB, ASSETS: env.ASSETS },
    auth: createPortalAuth(
      { DB: env.DB },
      {
        secret: env.BETTER_AUTH_SECRET ?? '',
        baseURL: env.PORTAL_ORIGIN ?? undefined,
        sendMagicLink: async () => {
          throw new Error('magic link delivery provider not configured (G-cap-live)');
        },
      },
    ),
    db: createDb(env.DB),
    // Admin access-link minting only (never logged/echoed elsewhere).
    portalOrigin: env.PORTAL_ORIGIN ?? undefined,
    portalSecret: env.BETTER_AUTH_SECRET ?? undefined,
  };
  return cachedDeps;
}

export type UiResult<T> = { ok: true; data: T } | { ok: false; status: number; message: string };

function failure(error: unknown): UiResult<never> {
  if (error instanceof PortalError) return { ok: false, status: error.status, message: error.message };
  return { ok: false, status: 500, message: 'Error interno de administración.' };
}

async function requireAdminUi(): Promise<{ deps: RequestDeps; principal: Principal }> {
  const deps = portalDeps();
  const principal = await resolvePrincipal(deps, getRequest());
  if (principal === null) throw new PortalError(401, 'unauthorized', 'Autenticación requerida.');
  requireAdmin(principal);
  return { deps, principal };
}

const emailSchema = z.string().trim().toLowerCase().email('Email inválido.').max(200);

/** Provisions the portal user for an email (admin-only provisioning, FR-001). */
async function userForEmail(db: PortalDb, email: string) {
  const existing = await findUserByEmail(db, email);
  if (existing) return existing;
  const name = email.split('@')[0] ?? email;
  return provisionUser(db, { email, name, role: 'member' });
}

/* access tab views ----------------------------------------------------------- */

export interface AccessMembership {
  id: string;
  email: string;
  status: string;
  createdMs: number;
}

export interface AccessInvitation {
  id: string;
  email: string;
  status: string;
  expiresMs: number;
}

export interface AccessGrant {
  id: string;
  keyName: string;
  keyStart: string | null;
  keyEnabled: boolean;
  scopes: string[];
  clientIds: string[] | null;
  workspaceId: string;
  revokedMs: number | null;
}

export interface AccessSnapshot {
  memberships: AccessMembership[];
  invitations: AccessInvitation[];
  grants: AccessGrant[];
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export const listClientAccess = createServerFn({ method: 'GET' })
  .validator(z.string().min(1))
  .handler(async ({ data: clientId }): Promise<UiResult<AccessSnapshot>> => {
    try {
      const { deps } = await requireAdminUi();
      const db: PortalDb = deps.db;
      const [client] = await db.select().from(portalClient).where(eq(portalClient.id, clientId)).limit(1);
      if (!client) throw notFound();
      const membershipRows = await db
        .select({ membership, email: userTable.email })
        .from(membership)
        .innerJoin(userTable, eq(userTable.id, membership.userId))
        .where(eq(membership.portalClientId, clientId))
        .orderBy(desc(membership.createdMs));
      const invitationRows = await db
        .select()
        .from(invitation)
        .where(eq(invitation.portalClientId, clientId))
        .orderBy(desc(invitation.createdMs));
      const grantRows = await db
        .select({ grant: agentGrant, keyName: apikey.name, keyStart: apikey.start, keyEnabled: apikey.enabled })
        .from(agentGrant)
        .leftJoin(apikey, eq(apikey.id, agentGrant.keyId))
        .where(eq(agentGrant.workspaceId, client.workspaceId))
        .orderBy(desc(agentGrant.createdMs));
      return {
        ok: true,
        data: {
          memberships: membershipRows.map((row) => ({
            id: row.membership.id,
            email: row.email,
            status: row.membership.status,
            createdMs: row.membership.createdMs,
          })),
          invitations: invitationRows.map((row) => ({
            id: row.id,
            email: row.email,
            status: row.status,
            expiresMs: row.expiresMs,
          })),
          grants: grantRows.map((row) => ({
            id: row.grant.id,
            keyName: row.keyName ?? row.grant.keyId,
            keyStart: row.keyStart,
            keyEnabled: row.keyEnabled ?? false,
            scopes: parseStringArray(row.grant.scopes),
            clientIds: row.grant.clientIds === 'null' ? null : parseStringArray(row.grant.clientIds),
            workspaceId: row.grant.workspaceId,
            revokedMs: row.grant.revokedMs,
          })),
        },
      };
    } catch (error) {
      return failure(error);
    }
  });

/* invitations and memberships ------------------------------------------------- */

const inviteInput = z.object({
  clientId: z.string().min(1),
  email: emailSchema,
});

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const inviteClientMember = createServerFn({ method: 'POST' })
  .validator(inviteInput)
  .handler(async ({ data }): Promise<UiResult<AccessInvitation>> => {
    try {
      const { deps, principal } = await requireAdminUi();
      const [client] = await deps.db.select().from(portalClient).where(eq(portalClient.id, data.clientId)).limit(1);
      if (!client) throw notFound();
      // FR-001: portal users are ALWAYS admin-provisioned. Inviting an unknown
      // email provisions a (role=member, no membership) user so the magic-link
      // sign-in can succeed; membership only exists after acceptance.
      await userForEmail(deps.db, data.email);
      const row = await createInvitation(deps.db, {
        email: data.email,
        portalClientId: data.clientId,
        invitedBy: principal.userId,
        expiresMs: Date.now() + INVITATION_TTL_MS,
      });
      return {
        ok: true,
        data: { id: row.id, email: row.email, status: row.status, expiresMs: row.expiresMs },
      };
    } catch (error) {
      return failure(error);
    }
  });

const accessLinkInput = z.object({
  clientId: z.string().min(1),
  email: emailSchema,
  expiresIn: z.string().regex(/^(\d+)(m|h|d)$/, 'Usá <n>m, <n>h o <n>d (ej. 30m, 48h, 7d).').optional(),
});

/**
 * Mints a single-use login link for a client member (operator-ordered
 * feature, 2026-10-05): same server policy as POST /api/v1/.../access-links.
 * The URL is shown/copied EXACTLY ONCE in the admin session and is never
 * persisted or logged by the portal.
 */
export const mintClientAccessLink = createServerFn({ method: 'POST' })
  .validator(accessLinkInput)
  .handler(async ({ data }): Promise<UiResult<{ url: string; email: string; expiresAt: number; singleUse: true }>> => {
    try {
      const { deps, principal } = await requireAdminUi();
      const approvedOrigin = deps.portalOrigin;
      if (approvedOrigin === undefined || approvedOrigin.length === 0) {
        throw new PortalError(500, 'internal', 'Minting no está configurado en este despliegue.');
      }
      const [client] = await deps.db.select().from(portalClient).where(eq(portalClient.id, data.clientId)).limit(1);
      if (!client) throw notFound();
      const minted = await mintAccessLink(deps, principal, data.clientId, {
        email: data.email,
        expiresInSeconds: parseExpiresIn(data.expiresIn),
        origin: approvedOrigin,
      });
      return { ok: true, data: { url: minted.url, email: minted.email, expiresAt: minted.expiresAt, singleUse: true } };
    } catch (error) {
      return failure(error);
    }
  });

export const revokeAccessMembership = createServerFn({ method: 'POST' })
  .validator(z.string().min(1))
  .handler(async ({ data: membershipId }): Promise<UiResult<{ id: string }>> => {
    try {
      const { deps } = await requireAdminUi();
      const [row] = await deps.db.select().from(membership).where(eq(membership.id, membershipId)).limit(1);
      if (!row) throw notFound();
      await revokeMembership(deps.db, membershipId);
      return { ok: true, data: { id: membershipId } };
    } catch (error) {
      return failure(error);
    }
  });

export const revokeAccessInvitation = createServerFn({ method: 'POST' })
  .validator(z.string().min(1))
  .handler(async ({ data: invitationId }): Promise<UiResult<{ id: string }>> => {
    try {
      const { deps } = await requireAdminUi();
      const [row] = await deps.db.select().from(invitation).where(eq(invitation.id, invitationId)).limit(1);
      if (!row) throw notFound();
      await deps.db.update(invitation).set({ status: 'revoked' }).where(eq(invitation.id, invitationId));
      return { ok: true, data: { id: invitationId } };
    } catch (error) {
      return failure(error);
    }
  });

/* agent keys ----------------------------------------------------------------- */

const issueKeyInput = z.object({
  clientId: z.string().min(1),
  email: emailSchema,
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.string()).min(1),
  workspaceWide: z.boolean(),
});

export const issueClientAgentKey = createServerFn({ method: 'POST' })
  .validator(issueKeyInput)
  .handler(async ({ data }): Promise<UiResult<{ key: string; keyId: string; grantId: string }>> => {
    try {
      const { deps } = await requireAdminUi();
      const [client] = await deps.db.select().from(portalClient).where(eq(portalClient.id, data.clientId)).limit(1);
      if (!client) throw notFound();
      const user = await userForEmail(deps.db, data.email);
      const issued = await issueAgentKey(deps.auth, { userId: user.id, name: data.name });
      const grant = await createAgentGrant(deps.db, {
        keyId: issued.id,
        workspaceId: client.workspaceId,
        clientIds: data.workspaceWide ? null : [data.clientId],
        scopes: data.scopes,
      });
      // The raw key is shown exactly once, to the admin, over the session.
      return { ok: true, data: { key: issued.key, keyId: issued.id, grantId: grant.id } };
    } catch (error) {
      return failure(error);
    }
  });

export const revokeAccessGrant = createServerFn({ method: 'POST' })
  .validator(z.string().min(1))
  .handler(async ({ data: grantId }): Promise<UiResult<{ id: string }>> => {
    try {
      const { deps } = await requireAdminUi();
      const [row] = await deps.db.select().from(agentGrant).where(eq(agentGrant.id, grantId)).limit(1);
      if (!row) throw notFound();
      await revokeAgentGrant(deps.db, grantId);
      return { ok: true, data: { id: grantId } };
    } catch (error) {
      return failure(error);
    }
  });

/* member-side invitation acceptance ------------------------------------------- */

/**
 * Accepts every pending, unexpired invitation addressed to the signed-in
 * member's email. Runs on portal entry so "admin invita → cliente inicia
 * sesión" needs no extra step; never reveals invitations beyond the member's
 * own email.
 */
export const acceptMyInvitations = createServerFn({ method: 'POST' })
  .handler(async (): Promise<UiResult<{ accepted: number; clientIds: string[] }>> => {
    try {
      const deps = portalDeps();
      const principal = await resolvePrincipal(deps, getRequest());
      if (principal === null || principal.kind === 'agent' || principal.email === undefined) {
        return { ok: true, data: { accepted: 0, clientIds: [] } };
      }
      const email = principal.email.toLowerCase();
      const rows = await deps.db
        .select()
        .from(invitation)
        .where(eq(invitation.email, email));
      const accepted: string[] = [];
      for (const row of rows) {
        if (row.status !== 'pending') continue;
        const created = await acceptInvitation(deps.db, row.id, principal.userId);
        accepted.push(created.portalClientId);
      }
      return { ok: true, data: { accepted: accepted.length, clientIds: accepted } };
    } catch (error) {
      return failure(error);
    }
  });
