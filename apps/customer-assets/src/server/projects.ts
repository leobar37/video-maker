import { and, desc, eq, sql } from 'drizzle-orm';
import type { Page, PortalProjectView } from '@videomaker/customer-assets';
import type { PortalDb } from './db';
import { portalProject } from './db/schema';
import {
  authorizeClient,
  badRequest,
  conflict,
  forbidden,
  notFound,
  rawRun,
  requireAdmin,
  requireStudioId,
  sanitizeDisplayName,
  type Principal,
} from './access';

/**
 * PortalProject projection service (P-101, R-1; contracts.md §2/§5 additive ·
 * customer-assets-requests):
 * - a project is a canonical POINTER to an existing Studio project, projected
 *   per portal client exactly like PortalClient projects Studio clients;
 *   Studio is never written and nothing beyond the allowlisted display fields
 *   is stored (FR-101, NFR-103).
 * - Authorization (contracts.md §3 additive): admin humans adopt/list/rename;
 *   members list ONLY their own client's projects; agents have NO project
 *   operation (403 on authorized clients, 404 elsewhere — the v1 enumeration
 *   rule). There is deliberately NO projects:* agent scope: the additive
 *   contracts fixed alta/lista/renombre to admin humano (+ member list).
 * - Creation is idempotent per (portalClientId, studioProjectId): an identical
 *   retry returns the existing pointer; a divergent display title is a 409
 *   (same semantics as client adoption).
 * - Per-project material counts come from `material.portal_project_id`
 *   (0003), read through an explicit `sql` template because the drizzle
 *   mapping keeps the v1 column set (see db/schema.ts).
 */

export type PortalProjectRow = typeof portalProject.$inferSelect;

export function toProjectView(row: PortalProjectRow, materialCount?: number): PortalProjectView {
  return {
    id: row.id,
    portalClientId: row.portalClientId,
    workspaceId: row.workspaceId,
    studioProjectId: row.studioProjectId,
    name: row.name,
    projectionVersion: row.projectionVersion,
    createdAt: row.createdMs,
    ...(materialCount === undefined ? {} : { materialCount }),
  };
}

export interface RegisterProjectInput {
  studioProjectId: string;
  name: string;
}

/**
 * POST /api/v1/clients/:clientId/projects — admin-human-only projection of an
 * existing Studio project. Idempotent: identical retries return the existing
 * pointer; a different display title on the same (client, studio project) is
 * a 409. Authorization follows the access-link precedent: the client is
 * resolved FIRST (404 for unknown/foreign principals), then the admin-human
 * role is enforced (403 for authorized members/agents).
 */
export async function registerProjectPointer(
  db: PortalDb,
  principal: Principal,
  clientId: string,
  input: RegisterProjectInput,
): Promise<{ project: PortalProjectView; replayed: boolean }> {
  const studioProjectId = requireStudioId(input.studioProjectId, 'studioProjectId');
  const name = sanitizeDisplayName(input.name);
  if (name === undefined) throw badRequest('name is required.');

  const authorized = await authorizeClient(db, principal, clientId);
  requireAdmin(principal);

  const [existing] = await db
    .select()
    .from(portalProject)
    .where(
      and(eq(portalProject.portalClientId, clientId), eq(portalProject.studioProjectId, studioProjectId)),
    )
    .limit(1);
  if (existing) {
    if (existing.name !== name) {
      throw conflict('A projection for this studio project already exists with a different name.');
    }
    const counts = await materialCountsByProject(db, clientId);
    return { project: toProjectView(existing, counts.get(existing.id) ?? 0), replayed: true };
  }

  const [row] = await db
    .insert(portalProject)
    .values({
      id: crypto.randomUUID(),
      workspaceId: authorized.client.workspaceId,
      portalClientId: clientId,
      studioProjectId,
      name,
      projectionVersion: 1,
      createdMs: Date.now(),
    })
    .returning();
  const counts = await materialCountsByProject(db, clientId);
  return { project: toProjectView(row!, counts.get(row!.id) ?? 0), replayed: false };
}

/**
 * GET /api/v1/clients/:clientId/projects — admin sees every client's
 * projects, members see their own client's, agents are refused even when
 * their grant covers the client (contracts.md §3 additive). Each item carries
 * the count of materials attributed to it (attribution is optional; projects
 * without attributed materials count 0).
 */
export async function listProjectsForClient(
  db: PortalDb,
  principal: Principal,
  clientId: string,
): Promise<Page<PortalProjectView>> {
  await authorizeClient(db, principal, clientId);
  if (principal.kind === 'agent') {
    throw forbidden('Projects are restricted to portal admins and client members.');
  }

  const rows = await db
    .select()
    .from(portalProject)
    .where(eq(portalProject.portalClientId, clientId))
    .orderBy(desc(portalProject.createdMs))
    .limit(100);

  const counts = await materialCountsByProject(db, clientId);
  return {
    items: rows.map((row) => toProjectView(row, counts.get(row.id) ?? 0)),
    nextCursor: null,
  };
}

/**
 * Material counts per project for ONE client, keyed by project id. Explicit
 * `sql` template: the drizzle `material` mapping intentionally keeps the v1
 * column set (db/schema.ts), and this path only runs where 0003 is applied.
 * The map is runtime-keyed (project ids come from D1 rows), hence a Map.
 */
export async function materialCountsByProject(db: PortalDb, clientId: string): Promise<Map<string, number>> {
  const result = await rawRun(
    db,
    sql`SELECT portal_project_id AS project_id, COUNT(*) AS total
        FROM material
        WHERE client_id = ${clientId} AND portal_project_id IS NOT NULL
        GROUP BY portal_project_id`,
  );
  const counts = new Map<string, number>();
  for (const row of (result.results ?? []) as { project_id: string; total: number }[]) {
    counts.set(row.project_id, Number(row.total));
  }
  return counts;
}

/**
 * PATCH /api/v1/projects/:projectId — display-title rename, admin-human-only.
 * Unknown projects and other clients' projects are 404 for non-admins (v1
 * enumeration rule); authorized members/agents get 403 from requireAdmin.
 */
export async function renameProject(
  db: PortalDb,
  principal: Principal,
  projectId: string,
  name: string,
): Promise<PortalProjectView> {
  const [row] = await db.select().from(portalProject).where(eq(portalProject.id, projectId)).limit(1);
  if (!row) throw notFound();
  await authorizeClient(db, principal, row.portalClientId);
  requireAdmin(principal);

  const cleaned = sanitizeDisplayName(name);
  if (cleaned === undefined) throw badRequest('name is required.');

  const [updated] = await db
    .update(portalProject)
    .set({ name: cleaned })
    .where(eq(portalProject.id, projectId))
    .returning();
  return toProjectView(updated!);
}
