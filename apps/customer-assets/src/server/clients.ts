import { and, desc, eq, inArray } from 'drizzle-orm';
import { AGENT_SCOPES, type PortalClientView, type Page } from '@videomaker/customer-assets';
import { createMintingAuth, findUserByEmail, provisionUser, type PortalAuth } from './auth';
import type { PortalDb } from './db';
import { user } from './db/auth-schema';
import {
  agentGrant,
  invitation,
  membership,
  portalClient,
  portalWorkspace,
} from './db/schema';
import {
  authorizeClient,
  badRequest,
  conflict,
  forbidden,
  notFound,
  PortalError,
  requireNonEmptyString,
  sanitizeDisplayName,
  toClientView,
  type Principal,
  type RequestDeps,
} from './access';

/**
 * Client projections and access administration (contracts.md §1/§2/§3):
 * - adopt is the ONLY way clients enter the portal: an agent principal holding
 *   a live workspace grant with `clients:write`, whose owning user is the
 *   workspace's authorized integrator. No general admin access, no browsing.
 * - Only allowlisted display fields are stored (name); nothing else from
 *   Studio client metadata travels to the portal.
 * - Membership/invitation/grant helpers are server-side services for tests
 *   and the future admin surface (P-004); none of them is a generic endpoint.
 */

export type AgentGrantRow = typeof agentGrant.$inferSelect;
export type MembershipRow = typeof membership.$inferSelect;
export type InvitationRow = typeof invitation.$inferSelect;
export type PortalWorkspace = typeof portalWorkspace.$inferSelect;

const STUDIO_CLIENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface AdoptInput {
  workspaceId: string;
  studioClientId: string;
  name: string;
}

/**
 * POST /api/v1/clients/adopt — integrator-only client projection.
 * Authorization requires ALL of (contracts.md §6):
 *   - agent principal (human sessions are refused: not general admin access),
 *   - a live (non-revoked) grant for the workspace,
 *   - `clients:write` in the server-side grant scopes,
 *   - the key's owning user == the workspace's authorized integrator.
 * Retries are non-duplicating: unique (workspace, studioClientId) returns the
 * existing projection for identical payloads; a divergent name is a 409.
 */
export async function adoptClient(
  db: PortalDb,
  principal: Principal,
  input: AdoptInput,
): Promise<{ client: PortalClientView; replayed: boolean }> {
  if (principal.kind !== 'agent') {
    throw forbidden('Client adoption is restricted to the workspace integrator agent.');
  }
  if (input.workspaceId.length === 0) throw badRequest('workspaceId is required.');
  if (!STUDIO_CLIENT_ID_PATTERN.test(input.studioClientId)) {
    throw badRequest('studioClientId has an invalid format.');
  }
  const name = sanitizeDisplayName(input.name);
  if (name === undefined) throw badRequest('name is required.');

  const [workspace] = await db
    .select()
    .from(portalWorkspace)
    .where(eq(portalWorkspace.id, input.workspaceId))
    .limit(1);
  if (!workspace) throw notFound();

  const grant = principal.grant;
  if (!grant || grant.workspaceId !== workspace.id) throw notFound();
  if (grant.clientIds !== null) {
    throw forbidden('Adoption requires a workspace-wide grant.');
  }
  if (!grant.scopes.includes('clients:write')) {
    throw forbidden('Missing required scope: clients:write');
  }
  if (workspace.integratorUserId !== principal.userId) {
    throw forbidden('This key does not belong to the workspace integrator.');
  }

  const [existing] = await db
    .select()
    .from(portalClient)
    .where(
      and(eq(portalClient.workspaceId, workspace.id), eq(portalClient.studioClientId, input.studioClientId)),
    )
    .limit(1);
  if (existing) {
    if (existing.name !== name) {
      throw conflict('A projection for this studio client already exists with a different name.');
    }
    return { client: toClientView(existing), replayed: true };
  }

  const [row] = await db
    .insert(portalClient)
    .values({
      id: crypto.randomUUID(),
      workspaceId: workspace.id,
      studioClientId: input.studioClientId,
      name,
      projectionVersion: 1,
      createdMs: Date.now(),
    })
    .returning();
  return { client: toClientView(row!), replayed: false };
}

/**
 * GET /api/v1/clients — all authorized clients per principal kind:
 * admin human sees every client, members see their active memberships,
 * agents see the clients inside their live grants (workspace-wide grants
 * expand to every client of the workspace).
 */
export async function listAuthorizedClients(
  db: PortalDb,
  principal: Principal,
  scope: string,
): Promise<Page<PortalClientView>> {
  if (principal.kind === 'admin') {
    const rows = await db.select().from(portalClient).orderBy(desc(portalClient.createdMs)).limit(100);
    return { items: rows.map(toClientView), nextCursor: null };
  }

  if (principal.kind === 'member') {
    const rows = await db
      .select({ client: portalClient })
      .from(membership)
      .innerJoin(portalClient, eq(portalClient.id, membership.portalClientId))
      .where(and(eq(membership.userId, principal.userId), eq(membership.status, 'active')))
      .orderBy(desc(portalClient.createdMs))
      .limit(100);
    return { items: rows.map((r) => toClientView(r.client)), nextCursor: null };
  }

  const grant = principal.grant;
  if (!grant) return { items: [], nextCursor: null };
  if (!grant.scopes.includes(scope)) {
    throw forbidden(`Missing required scope: ${scope}`);
  }
  if (grant.clientIds === null) {
    const rows = await db
      .select()
      .from(portalClient)
      .where(eq(portalClient.workspaceId, grant.workspaceId))
      .orderBy(desc(portalClient.createdMs))
      .limit(100);
    return { items: rows.map(toClientView), nextCursor: null };
  }
  if (grant.clientIds.length === 0) return { items: [], nextCursor: null };
  const rows = await db
    .select()
    .from(portalClient)
    .where(inArray(portalClient.id, grant.clientIds))
    .orderBy(desc(portalClient.createdMs))
    .limit(100);
  return { items: rows.map(toClientView), nextCursor: null };
}

/* server-side administration services (no generic endpoints; FR-009) ------- */

export async function createWorkspace(
  db: PortalDb,
  input: { label: string; integratorUserId: string },
): Promise<PortalWorkspace> {
  requireNonEmptyString(input.label, 'label', 200);
  const [row] = await db
    .insert(portalWorkspace)
    .values({
      id: crypto.randomUUID(),
      label: input.label,
      integratorUserId: input.integratorUserId,
      createdMs: Date.now(),
    })
    .returning();
  return row!;
}

export async function createMembership(
  db: PortalDb,
  input: { userId: string; portalClientId: string },
): Promise<MembershipRow> {
  const [row] = await db
    .insert(membership)
    .values({
      id: crypto.randomUUID(),
      userId: input.userId,
      portalClientId: input.portalClientId,
      status: 'active',
      createdMs: Date.now(),
    })
    .returning();
  return row!;
}

/** Revocation is a status flip: the very next request stops being authorized. */
export async function revokeMembership(db: PortalDb, membershipId: string): Promise<void> {
  await db
    .update(membership)
    .set({ status: 'revoked', revokedMs: Date.now() })
    .where(eq(membership.id, membershipId));
}

export async function createInvitation(
  db: PortalDb,
  input: { email: string; portalClientId: string; invitedBy: string; expiresMs: number },
): Promise<InvitationRow> {
  const email = input.email.trim().toLowerCase();
  const [row] = await db
    .insert(invitation)
    .values({
      id: crypto.randomUUID(),
      email,
      portalClientId: input.portalClientId,
      status: 'pending',
      invitedBy: input.invitedBy,
      expiresMs: input.expiresMs,
      createdMs: Date.now(),
    })
    .returning();
  return row!;
}

/** Acceptance is server-side: magic-link sign-in plus this ledger update. */
export async function acceptInvitation(
  db: PortalDb,
  invitationId: string,
  acceptingUserId: string,
): Promise<MembershipRow> {
  const [row] = await db.select().from(invitation).where(eq(invitation.id, invitationId)).limit(1);
  if (!row) throw notFound();
  if (row.status !== 'pending') throw conflict('Invitation is not pending.');
  if (row.expiresMs < Date.now()) {
    await db.update(invitation).set({ status: 'expired' }).where(eq(invitation.id, invitationId));
    throw conflict('Invitation expired.');
  }
  await db
    .update(invitation)
    .set({ status: 'accepted', acceptedUserId: acceptingUserId })
    .where(eq(invitation.id, invitationId));
  return createMembership(db, { userId: acceptingUserId, portalClientId: row.portalClientId });
}

export function isValidAgentScope(scope: string): boolean {
  return (AGENT_SCOPES as readonly string[]).includes(scope);
}

/**
 * Server-side grant provisioning (admin human decides everything; the CLI can
 * only present the key). Scopes are validated against the fixed v1 set —
 * nothing is accepted from caller input at request time.
 */
export async function createAgentGrant(
  db: PortalDb,
  input: { keyId: string; workspaceId: string; clientIds: string[] | null; scopes: string[] },
): Promise<AgentGrantRow> {
  if (input.scopes.length === 0 || input.scopes.some((s) => !isValidAgentScope(s))) {
    throw badRequest('scopes must be a non-empty subset of the v1 agent scopes.');
  }
  const [row] = await db
    .insert(agentGrant)
    .values({
      id: crypto.randomUUID(),
      keyId: input.keyId,
      workspaceId: input.workspaceId,
      clientIds: input.clientIds === null ? 'null' : JSON.stringify(input.clientIds),
      scopes: JSON.stringify(input.scopes),
      createdMs: Date.now(),
    })
    .returning();
  return row!;
}

/** Revocation is immediate for every request after this returns. */
export async function revokeAgentGrant(db: PortalDb, grantId: string): Promise<void> {
  await db.update(agentGrant).set({ revokedMs: Date.now() }).where(eq(agentGrant.id, grantId));
}

/**
 * Issues an agent API key for a user server-side (admin flow; the HTTP key
 * management routes stay admin-only and never accept scope widening).
 */
export async function issueAgentKey(
  auth: PortalAuth,
  input: { userId: string; name: string },
): Promise<{ id: string; key: string }> {
  const result = await auth.api.createApiKey({
    body: { userId: input.userId, name: input.name, rateLimitEnabled: false },
  });
  return { id: result.id, key: result.key };
}

export async function findUserById(db: PortalDb, userId: string) {
  const [row] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  return row;
}

/* access-link minting (operator-ordered, 2026-10-05) ----------------------- */

export interface MintAccessLinkInput {
  /** Already validated/normalized (requireEmail at the API boundary). */
  email: string;
  /** Lifetime in seconds, bounded by parseExpiresIn (30m..30d). */
  expiresInSeconds: number;
  /** Approved portal origin; the minted link points exactly here. */
  origin: string;
}

export interface MintedAccessLink {
  url: string;
  email: string;
  expiresAt: number;
  membershipId: string;
  workspaceId: string;
}

/**
 * Mints a single-use login link for a client member (contracts.md §3/§7
 * additive note, operator-approved 2026-10-05). Policy:
 * - Admin human OR agent key whose live server-side grant holds
 *   `access:write` and covers the client. Members NEVER mint: on their own
 *   client that is 403 (authorized resource, insufficient role); anything
 *   else stays the standard 404 (no enumeration).
 * - Unknown emails are provisioned as role=member portal users (FR-001,
 *   same server-side provisioning the admin invite path uses).
 * - Membership is idempotent through the NORMAL invite ledger: an active
 *   membership is reused; otherwise invitation+acceptance happen in this
 *   call. A REVOKED membership is never resurrected here.
 * - The link IS Better Auth's magic-link token: a per-mint throwaway auth
 *   instance (same D1 tables + secret) stores a hashed, single-use token in
 *   the standard `verification` row with expiresAt = now + expiresInSeconds
 *   and the injected sender CAPTURES the URL instead of delivering it. No
 *   email leaves the system and no parallel token store exists. The url is
 *   returned exactly once and must never be logged, audited, or persisted.
 * - Deliberately NOT idempotency-keyed: replaying the stored response body
 *   would persist a minted URL in the idempotency ledger. Every call mints a
 *   fresh link; unused links simply expire.
 */
export async function mintAccessLink(
  deps: RequestDeps,
  principal: Principal,
  clientId: string,
  input: MintAccessLinkInput,
): Promise<MintedAccessLink> {
  if (
    typeof deps.portalSecret !== 'string' ||
    deps.portalSecret.length === 0 ||
    deps.portalOrigin === undefined ||
    deps.portalOrigin.length === 0
  ) {
    throw new PortalError(500, 'internal', 'Access-link minting is not configured on this deployment.');
  }
  // Defense in depth: the API layer clamps origin to the approved one; the
  // service re-checks whenever an approved origin is configured.
  if (deps.portalOrigin !== undefined && input.origin !== deps.portalOrigin) {
    throw badRequest('origin does not match the portal approved origin.');
  }

  const db = deps.db;
  const authorized = await authorizeClient(db, principal, clientId, 'access:write');
  if (principal.kind === 'member') {
    throw forbidden('Members cannot mint access links.');
  }

  const memberUser = await findUserByEmail(db, input.email);
  const target = memberUser ??
    await provisionUser(db, {
      email: input.email,
      name: input.email.split('@')[0] ?? input.email,
      role: 'member',
    });

  const [existing] = await db
    .select()
    .from(membership)
    .where(and(eq(membership.userId, target.id), eq(membership.portalClientId, clientId)))
    .limit(1);
  if (existing && existing.status !== 'active') {
    throw conflict('Membership was revoked; reinstate it from the admin surface before minting a link.');
  }
  let membershipId = existing?.id;
  if (!existing) {
    const invite = await createInvitation(db, {
      email: input.email,
      portalClientId: clientId,
      invitedBy: principal.userId,
      expiresMs: Date.now() + input.expiresInSeconds * 1000,
    });
    const accepted = await acceptInvitation(db, invite.id, target.id);
    membershipId = accepted.id;
  }
  if (membershipId === undefined) throw new PortalError(500, 'internal', 'Membership provisioning failed.');

  const minting = createMintingAuth(
    { DB: deps.env.DB },
    { secret: deps.portalSecret, baseURL: input.origin, expiresInSeconds: input.expiresInSeconds },
  );
  await minting.auth.api.signInMagicLink({
    body: { email: input.email, callbackURL: `${input.origin}/` },
    headers: new Headers({ origin: input.origin }),
  });
  const mail = minting.minted();

  return {
    url: mail.url,
    email: input.email,
    expiresAt: Date.now() + input.expiresInSeconds * 1000,
    membershipId,
    workspaceId: authorized.client.workspaceId,
  };
}
