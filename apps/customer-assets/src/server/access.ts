import { eq, and, sql, type SQL } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ErrorCode, PortalClientView } from '@videomaker/customer-assets';
import type { PortalAuth } from './auth';
import type { PortalDb } from './db';
import {
  agentGrant,
  auditEvent,
  idempotencyRecord,
  membership,
  portalClient,
  type portalWorkspace,
} from './db/schema';
import { user as userRole } from './db/auth-schema';

/**
 * Identity and authorization (contracts.md §3):
 * - One principal per request: Better Auth session (admin/member human) or a
 *   verified API key (agent principal). An API key NEVER mints a session and
 *   NEVER grants admin actions, even if its owner is an admin.
 * - Agent scopes live ONLY in the server-side `agent_grant` row (key id ->
 *   workspace, client list, scopes); nothing is accepted from CLI input or
 *   from Better Auth key permissions.
 * - Every authorization decision re-reads current D1 state, so membership or
 *   grant revocation is effective on the very next request.
 * - Cross-client resources are 404 (never 403) so nothing can be enumerated;
 *   403 is reserved for "authorized resource, insufficient scope/role".
 */

/** Portal runtime bindings (wrangler.jsonc, emulation-only in P-002). */
export interface PortalEnv {
  DB: D1Database;
  ASSETS: R2Bucket;
}

/** Dependencies every request handler needs (injected; no host imports). */
export interface RequestDeps {
  env: PortalEnv;
  auth: PortalAuth;
  db: PortalDb;
  /**
   * Access-link minting (operator-ordered, 2026-10-05) ONLY: the portal's
   * approved origin and the Better Auth secret. Optional so existing route
   * assemblies stay source-compatible; when absent, minting answers 500
   * instead of guessing either value. Never logged, never echoed.
   */
  portalOrigin?: string;
  portalSecret?: string;
}

/** Raised anywhere in server code; rendered by the API layer as the envelope. */
export class PortalError extends Error {
  readonly status: number;
  readonly code: ErrorCode;

  constructor(status: number, code: ErrorCode, message: string) {
    super(message);
    this.name = 'PortalError';
    this.status = status;
    this.code = code;
  }
}

export function unauthorized(message = 'Authentication required.'): PortalError {
  return new PortalError(401, 'unauthorized', message);
}
export function forbidden(message: string): PortalError {
  return new PortalError(403, 'forbidden', message);
}
export function notFound(message = 'Resource not found.'): PortalError {
  return new PortalError(404, 'not_found', message);
}
export function conflict(message: string): PortalError {
  return new PortalError(409, 'conflict', message);
}
export function badRequest(message: string): PortalError {
  return new PortalError(400, 'bad_request', message);
}

/**
 * Single-statement execution used for CAS predicates where the affected-row
 * count IS the decision (idempotency inserts, version bumps). Parameterized
 * through drizzle's sql template. D1 single statements and `db.batch()` are
 * atomic; drizzle `.transaction()` is not (proven in P-001).
 */
export function rawRun(db: PortalDb, query: SQL): Promise<D1Result> {
  return db.run(query);
}

/**
 * D1 batch for a dynamically built statement list (drizzle batch requires a
 * non-empty tuple). The whole batch is atomic; an empty list is a no-op.
 */
export async function batchAll(
  db: PortalDb,
  statements: BatchItem<'sqlite'>[],
): Promise<void> {
  if (statements.length === 0) return;
  await db.batch([statements[0]!, ...statements.slice(1)]);
}

/* principals -------------------------------------------------------------- */

export interface AgentGrantInfo {
  grantId: string;
  workspaceId: string;
  /** null = every client of the workspace (workspace-wide integrator grant). */
  clientIds: string[] | null;
  scopes: string[];
}

export interface Principal {
  kind: 'admin' | 'member' | 'agent';
  /** Portal user id (agents: the key's owning user). */
  userId: string;
  role: 'admin' | 'member';
  email?: string;
  /** Agent principals only: verified key id. */
  keyId?: string;
  /** Agent principals only: current server-side grant (null when absent/revoked). */
  grant: AgentGrantInfo | null;
}

/** Stable principal identity used for idempotency/audit/ownership binds. */
export function principalId(principal: Principal): string {
  return principal.kind === 'agent' ? `key:${principal.keyId ?? 'unknown'}` : `user:${principal.userId}`;
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function parseGrantClientIds(raw: string): string[] | null {
  if (raw === 'null') return null;
  return parseJsonStringArray(raw);
}

/**
 * Resolves the request principal from either the Better Auth session cookie
 * or the `x-api-key` header. Returns null when neither is present/valid
 * (rendered as 401 by the API layer). Every step re-reads live D1 state.
 */
export async function resolvePrincipal(deps: RequestDeps, request: Request): Promise<Principal | null> {
  const { auth, env, db } = deps;

  const apiKeyHeader = request.headers.get('x-api-key');
  if (apiKeyHeader) {
    // Agent identity: verify through Better Auth (checks enabled/expiry), then
    // load the server-side grant for this key. Key permissions on the Better
    // Auth row are deliberately ignored for authorization decisions.
    const verification = await auth.api.verifyApiKey({ body: { key: apiKeyHeader } });
    if (!verification.valid || verification.key === null) return null;
    const key = verification.key;
    const [grantRow] = await db.select().from(agentGrant).where(eq(agentGrant.keyId, key.id)).limit(1);
    const [ownerRow] = await db
      .select({ role: userRole.role })
      .from(userRole)
      .where(eq(userRole.id, key.referenceId))
      .limit(1);
    return {
      kind: 'agent',
      userId: key.referenceId,
      role: ownerRow?.role === 'admin' ? 'admin' : 'member',
      keyId: key.id,
      grant:
        grantRow && grantRow.revokedMs === null
          ? {
              grantId: grantRow.id,
              workspaceId: grantRow.workspaceId,
              clientIds: parseGrantClientIds(grantRow.clientIds),
              scopes: parseJsonStringArray(grantRow.scopes),
            }
          : null,
    };
  }

  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  const role = session.user.role === 'admin' ? 'admin' : 'member';
  return {
    kind: role === 'admin' ? 'admin' : 'member',
    userId: session.user.id,
    role,
    email: session.user.email,
    grant: null,
  };
}

/* client-scoped authorization --------------------------------------------- */

export type PortalWorkspaceRow = typeof portalWorkspace.$inferSelect;

export interface AuthorizedClient {
  client: PortalClientView;
}

export function toClientView(row: typeof portalClient.$inferSelect): PortalClientView {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    studioClientId: row.studioClientId,
    name: row.name,
    projectionVersion: row.projectionVersion,
    createdAt: row.createdMs,
  };
}

/**
 * Client-scoped authorization for ANY operation (contracts.md §3/§6):
 * - admin human: every client is authorized for client-scoped reads/writes;
 * - member: only clients with a CURRENTLY active membership;
 * - agent: only clients inside a live grant (workspace + client list), with
 *   the operation scope checked server-side.
 * Admin-only write operations additionally require `requireAdmin`; for those
 * the API layer passes scope=undefined and calls requireAdmin separately.
 */
export async function authorizeClient(
  db: PortalDb,
  principal: Principal,
  clientId: string,
  scope?: string,
): Promise<AuthorizedClient> {
  const [client] = await db
    .select()
    .from(portalClient)
    .where(eq(portalClient.id, clientId))
    .limit(1);
  if (!client) throw notFound();

  if (principal.kind === 'admin') return { client: toClientView(client) };

  if (principal.kind === 'member') {
    const [active] = await db
      .select({ id: membership.id })
      .from(membership)
      .where(
        and(
          eq(membership.userId, principal.userId),
          eq(membership.portalClientId, clientId),
          eq(membership.status, 'active'),
        ),
      )
      .limit(1);
    if (!active) throw notFound();
    return { client: toClientView(client) };
  }

  // Agent: live grant must cover workspace AND client, plus operation scope.
  const grant = principal.grant;
  if (!grant || grant.workspaceId !== client.workspaceId) throw notFound();
  if (grant.clientIds !== null && !grant.clientIds.includes(client.id)) throw notFound();
  if (scope && !grant.scopes.includes(scope)) {
    throw forbidden(`Missing required scope: ${scope}`);
  }
  return { client: toClientView(client) };
}

/** Admin-only guard (visibility, grid, posts writes, membership admin). */
export function requireAdmin(principal: Principal): void {
  if (principal.kind !== 'admin') {
    throw forbidden('This operation is restricted to provisioned admin sessions.');
  }
}

/* validation helpers ------------------------------------------------------- */

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OUTPUT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STUDIO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function requireSha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw badRequest(`${field} must be a lowercase hex sha256 digest.`);
  }
  return value;
}

/** Output names are safe key fragments: no separators, no traversal. */
export function requireOutputName(value: unknown, field = 'outputName'): string {
  if (typeof value !== 'string' || !OUTPUT_NAME_PATTERN.test(value) || value.includes('..')) {
    throw badRequest(`${field} has an invalid format.`);
  }
  return value;
}

export function requireStudioId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !STUDIO_ID_PATTERN.test(value)) {
    throw badRequest(`${field} has an invalid format.`);
  }
  return value;
}

export function requireNonEmptyString(value: unknown, field: string, maxLength = 500): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`${field} is required.`);
  }
  if (value.length > maxLength) throw badRequest(`${field} exceeds ${maxLength} characters.`);
  return value;
}

/** Display-only filename: strips paths/control chars, caps length. */
export function sanitizeDisplayName(value: unknown, maxLength = 200): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw badRequest('name must be a string.');
  const cleaned = value
    .replace(/[/\\]+/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return undefined;
  return cleaned.slice(0, maxLength);
}

export function requireVisibility(value: unknown): 'internal' | 'client_visible' {
  if (value !== 'internal' && value !== 'client_visible') {
    throw badRequest("visibility must be 'internal' or 'client_visible'.");
  }
  return value;
}

/** Strict email shape for minting (display-only elsewhere; no lists). */
export function requireEmail(value: unknown, field = 'email'): string {
  if (typeof value !== 'string') throw badRequest(`${field} is required.`);
  const email = value.trim().toLowerCase();
  if (email.length === 0 || email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw badRequest(`${field} must be a valid email address (max 200 chars).`);
  }
  return email;
}

export const ACCESS_LINK_MIN_SECONDS = 30 * 60; // 30m (CLI floor)
export const ACCESS_LINK_MAX_SECONDS = 30 * 24 * 60 * 60; // 30d (operator bound)
export const ACCESS_LINK_DEFAULT_SECONDS = 7 * 24 * 60 * 60; // 7d

/**
 * Access-link lifetime (operator-ordered feature): `<n>m`|`<n>h`|`<n>d`,
 * bounded to [30 minutes, 30 days]; absent means the 7d default. better-auth
 * 1.7.7 has no per-call expiresIn, so the accepted value is written into the
 * verification row by a per-mint auth instance (see createMintingAuth).
 */
export function parseExpiresIn(value: unknown): number {
  if (value === undefined) return ACCESS_LINK_DEFAULT_SECONDS;
  const match = typeof value === 'string' ? /^(\d+)(m|h|d)$/.exec(value.trim()) : null;
  if (!match) throw badRequest('expiresIn must look like 30m, 48h or 7d.');
  const amount = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw badRequest('expiresIn must look like 30m, 48h or 7d.');
  const seconds = amount * (match[2] === 'm' ? 60 : match[2] === 'h' ? 3_600 : 86_400);
  if (seconds < ACCESS_LINK_MIN_SECONDS || seconds > ACCESS_LINK_MAX_SECONDS) {
    throw badRequest('expiresIn must be between 30 minutes and 30 days.');
  }
  return seconds;
}

/* pagination ---------------------------------------------------------------- */

export interface ListOptions {
  cursor?: string | null;
  limit?: number;
}

export function parseListOptions(url: URL): ListOptions {
  const cursor = url.searchParams.get('cursor');
  const rawLimit = url.searchParams.get('limit');
  let limit = 50;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 100) {
      throw badRequest('limit must be an integer between 1 and 100.');
    }
    limit = parsed;
  }
  return { cursor, limit };
}

function bytesToHexLocal(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Opaque keyset cursor over (orderMs, id). */
export function encodeCursor(ms: number, id: string): string {
  const raw = `${ms}:${id}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeCursor(cursor: string): { ms: number; id: string } | null {
  try {
    const padded = cursor.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const raw = new TextDecoder().decode(bytes);
    const separator = raw.indexOf(':');
    if (separator <= 0) return null;
    const ms = Number.parseInt(raw.slice(0, separator), 10);
    const id = raw.slice(separator + 1);
    if (!Number.isFinite(ms) || id.length === 0) return null;
    return { ms, id };
  } catch {
    return null;
  }
}

/* idempotency --------------------------------------------------------------- */

/** Stable JSON stringify: object keys sorted, arrays order-preserving. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** Payload fingerprint bound into every idempotency record. */
export function fingerprintOf(payload: unknown): string {
  return bytesToHexLocal(sha256(new TextEncoder().encode(canonicalJson(payload))));
}

export function hashIdempotencyKey(rawKey: string): string {
  return bytesToHexLocal(sha256(new TextEncoder().encode(rawKey)));
}

export interface IdempotencyContext {
  principal: Principal;
  clientId: string;
  operation: string;
  rawKey: string | null;
  fingerprint: string;
}

export type IdempotencyOutcome =
  | { mode: 'fresh'; principalToken: string; clientId: string; operation: string; keyHash: string; fingerprint: string }
  | { mode: 'replay'; status: number; body: string };

const IDEMPOTENCY_WAIT_MS = 2_000;
const IDEMPOTENCY_POLL_MS = 40;

/**
 * Idempotency ledger (contracts.md §6): the INSERT is the concurrency
 * arbiter — at most one record per (principal, client, operation, key).
 * - Winner: record created in `pending`; caller runs the mutation and closes
 *   the record with completeIdempotency() (stored JSON response is replayed).
 * - Loser with a DIFFERENT payload fingerprint: 409 immediately.
 * - Loser with the SAME fingerprint: replays the stored response, waiting
 *   briefly while the winner's mutation is still in flight (portal mutations
 *   are fast D1 work). Waiting is bounded; timeout is a 409, never silence.
 */
export async function beginIdempotency(
  db: PortalDb,
  ctx: IdempotencyContext,
): Promise<IdempotencyOutcome> {
  if (ctx.rawKey === null || ctx.rawKey.length === 0) {
    // No key: the mutation runs unguarded; natural unique constraints keep
    // resource-level idempotency (delivery refs, material content hash).
    return { mode: 'fresh', principalToken: '', clientId: '', operation: '', keyHash: '', fingerprint: '' };
  }

  const keyHash = hashIdempotencyKey(ctx.rawKey);
  const now = Date.now();
  const insert = await rawRun(
    db,
    sql`INSERT OR IGNORE INTO idempotency_record
         (id, principal_id, client_id, operation, key_hash, fingerprint, status, created_ms)
       VALUES (${crypto.randomUUID()}, ${principalId(ctx.principal)}, ${ctx.clientId}, ${ctx.operation}, ${keyHash}, ${ctx.fingerprint}, 'pending', ${now})`,
  );
  if (insert.meta.changes === 1) {
    return {
      mode: 'fresh',
      principalToken: principalId(ctx.principal),
      clientId: ctx.clientId,
      operation: ctx.operation,
      keyHash,
      fingerprint: ctx.fingerprint,
    };
  }

  // Lost the insert race: fingerprint decides replay vs conflict.
  const deadline = now + IDEMPOTENCY_WAIT_MS;
  for (;;) {
    const [row] = await db
      .select({
        fingerprint: idempotencyRecord.fingerprint,
        status: idempotencyRecord.status,
        responseStatus: idempotencyRecord.responseStatus,
        responseJson: idempotencyRecord.responseJson,
      })
      .from(idempotencyRecord)
      .where(
        and(
          eq(idempotencyRecord.principalId, principalId(ctx.principal)),
          eq(idempotencyRecord.clientId, ctx.clientId),
          eq(idempotencyRecord.operation, ctx.operation),
          eq(idempotencyRecord.keyHash, keyHash),
        ),
      )
      .limit(1);
    if (row && row.fingerprint !== ctx.fingerprint) {
      throw conflict('This Idempotency-Key was already used with a different payload.');
    }
    if (row && row.status === 'completed' && row.responseJson !== null) {
      return { mode: 'replay', status: row.responseStatus ?? 200, body: row.responseJson };
    }
    if (Date.now() >= deadline) {
      throw conflict('An operation with this Idempotency-Key is still in progress.');
    }
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, IDEMPOTENCY_POLL_MS);
    await promise;
  }
}

/** Records the winner's JSON response for future replays. */
export async function completeIdempotency(
  db: PortalDb,
  ctx: { principal: Principal; clientId: string; operation: string },
  keyHash: string,
  status: number,
  body: string,
): Promise<void> {
  await rawRun(
    db,
    sql`UPDATE idempotency_record SET status = 'completed', response_status = ${status}, response_json = ${body}
        WHERE principal_id = ${principalId(ctx.principal)} AND client_id = ${ctx.clientId} AND operation = ${ctx.operation} AND key_hash = ${keyHash}`,
  );
}

/** Releases a failed winner's record so the client can retry cleanly. */
export async function failIdempotency(
  db: PortalDb,
  ctx: { principal: Principal; clientId: string; operation: string },
  keyHash: string,
): Promise<void> {
  await rawRun(
    db,
    sql`DELETE FROM idempotency_record WHERE principal_id = ${principalId(ctx.principal)} AND client_id = ${ctx.clientId} AND operation = ${ctx.operation} AND key_hash = ${keyHash} AND status = 'pending'`,
  );
}

/** True when the caller holds the fresh (winner) record of a keyed mutation. */
export function isFreshKeyed(outcome: IdempotencyOutcome): boolean {
  return outcome.mode === 'fresh' && outcome.keyHash !== '';
}

/* audit ---------------------------------------------------------------------- */

export interface AuditInput {
  principal: Principal;
  workspaceId: string | null;
  clientId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  requestId: string;
}

/** Fire-and-forget audit insert; failures never break the request path. */
export async function recordAudit(db: PortalDb, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditEvent).values({
      id: crypto.randomUUID(),
      workspaceId: input.workspaceId,
      clientId: input.clientId,
      actor: principalId(input.principal),
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestId: input.requestId,
      createdMs: Date.now(),
    });
  } catch {
    // Audit is best-effort in v1; it must never leak errors to clients.
  }
}
