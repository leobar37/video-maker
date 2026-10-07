import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  apiCall,
  expectError,
  json,
  setupPortalFixture,
  type PortalFixture,
} from './portal-fixture';
import { auditEvent, portalProject } from '../src/server/db/schema';
import type { PortalProjectView } from '@videomaker/customer-assets';

/**
 * PortalProject projection (P-101, R-1; contracts.md §2/§3/§5 additive):
 * admin-human-only creation with idempotent (client, studioProjectId)
 * uniqueness, member list confined to their own client, agents refused, and
 * the `project.created` audit trail without secrets.
 */

let fixture: PortalFixture;

async function createProject(
  principal: { cookie?: string; apiKey?: string },
  clientId: string,
  studioProjectId: string,
  name: string,
  idempotencyKey?: string,
): Promise<Response> {
  return apiCall(fixture.deps, {
    method: 'POST',
    path: `/api/v1/clients/${clientId}/projects`,
    body: { studioProjectId, name },
    idempotencyKey,
    cookie: principal.cookie,
    apiKey: principal.apiKey,
  });
}

describe('P-101 projects', () => {
  it('sets up the fixture', async () => {
    fixture = await setupPortalFixture();
  });

  it('admin projects an existing Studio project with the full pointer view', async () => {
    const res = await createProject({ cookie: fixture.adminCookie }, fixture.clientA.id, 'proj-alpha-1', 'Alpha Film');
    expect(res.status).toBe(201);
    const project = await json<PortalProjectView>(res);
    expect(project.id).toBeTruthy();
    expect(project.portalClientId).toBe(fixture.clientA.id);
    expect(project.workspaceId).toBe(fixture.workspaceId);
    expect(project.studioProjectId).toBe('proj-alpha-1');
    expect(project.name).toBe('Alpha Film');
    expect(project.projectionVersion).toBe(1);
    expect(project.materialCount).toBe(0);
  });

  it('is idempotent per (client, studioProjectId): identical retry returns the same pointer', async () => {
    const res = await createProject({ cookie: fixture.adminCookie }, fixture.clientA.id, 'proj-alpha-1', 'Alpha Film', 'idem-proj-1');
    expect(res.status).toBe(201);
    const replay = await json<PortalProjectView>(res);
    const [row] = await fixture.db
      .select()
      .from(portalProject)
      .where(eq(portalProject.studioProjectId, 'proj-alpha-1'));
    expect(replay.id).toBe(row!.id);
    const all = await fixture.db.select().from(portalProject);
    expect(all.filter((p) => p.studioProjectId === 'proj-alpha-1')).toHaveLength(1);
  });

  it('rejects a divergent display title for the same (client, studioProjectId) with 409', async () => {
    await expectError(
      await createProject({ cookie: fixture.adminCookie }, fixture.clientA.id, 'proj-alpha-1', 'Otro Nombre'),
      409,
      'conflict',
    );
  });

  it('validates the Studio project id and the display title', async () => {
    await expectError(
      await createProject({ cookie: fixture.adminCookie }, fixture.clientA.id, '../evil', 'X'),
      400,
      'bad_request',
    );
    await expectError(
      await createProject({ cookie: fixture.adminCookie }, fixture.clientA.id, 'proj x', 'X'),
      400,
      'bad_request',
    );
    await expectError(
      await createProject({ cookie: fixture.adminCookie }, fixture.clientA.id, 'proj-alpha-2', ''),
      400,
      'bad_request',
    );
    const rows = await fixture.db.select().from(portalProject);
    expect(rows).toHaveLength(1);
  });

  it('lists projects for admins and members of the client only; members never see other clients', async () => {
    await createProject({ cookie: fixture.adminCookie }, fixture.clientB.id, 'proj-beta-1', 'Beta Film');

    const adminList = await json<{ items: PortalProjectView[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/projects`,
        cookie: fixture.adminCookie,
      }),
    );
    expect(adminList.items.map((p) => p.studioProjectId)).toEqual(['proj-alpha-1']);
    expect(adminList.items[0]!.materialCount).toBe(0);

    const memberList = await json<{ items: PortalProjectView[] }>(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/projects`,
        cookie: fixture.memberACookie,
      }),
    );
    expect(memberList.items.map((p) => p.studioProjectId)).toEqual(['proj-alpha-1']);

    // Cross-client listings are 404 (never enumerable).
    await expectError(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientB.id}/projects`,
        cookie: fixture.memberACookie,
      }),
      404,
      'not_found',
    );
    await expectError(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/projects`,
        cookie: fixture.memberBCookie,
      }),
      404,
      'not_found',
    );
    await expectError(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${crypto.randomUUID()}/projects`,
        cookie: fixture.adminCookie,
      }),
      404,
      'not_found',
    );
  });

  it('refuses agents on project operations even with a live workspace grant', async () => {
    await expectError(
      await apiCall(fixture.deps, {
        method: 'GET',
        path: `/api/v1/clients/${fixture.clientA.id}/projects`,
        apiKey: fixture.integrator.apiKey,
      }),
      403,
      'forbidden',
    );
    await expectError(
      await createProject({ apiKey: fixture.integrator.apiKey }, fixture.clientA.id, 'proj-agent-1', 'Agent Film'),
      403,
      'forbidden',
    );
  });

  it('refuses members from creating projects: 403 on their client, 404 elsewhere', async () => {
    await expectError(
      await createProject({ cookie: fixture.memberACookie }, fixture.clientA.id, 'proj-member-1', 'Member Film'),
      403,
      'forbidden',
    );
    await expectError(
      await createProject({ cookie: fixture.memberBCookie }, fixture.clientA.id, 'proj-member-2', 'Member Film'),
      404,
      'not_found',
    );
    await expectError(
      await createProject({}, fixture.clientA.id, 'proj-anon-1', 'Anon Film'),
      401,
      'unauthorized',
    );
  });

  it('renames the display title as admin only', async () => {
    const [row] = await fixture.db
      .select()
      .from(portalProject)
      .where(eq(portalProject.studioProjectId, 'proj-alpha-1'));
    const res = await apiCall(fixture.deps, {
      method: 'PATCH',
      path: `/api/v1/projects/${row!.id}`,
      body: { name: 'Alpha Film — Fase 1' },
      cookie: fixture.adminCookie,
    });
    expect(res.status).toBe(200);
    const renamed = await json<PortalProjectView>(res);
    expect(renamed.name).toBe('Alpha Film — Fase 1');
    expect(renamed.studioProjectId).toBe('proj-alpha-1');

    await expectError(
      await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/projects/${row!.id}`,
        body: { name: 'X' },
        cookie: fixture.memberACookie,
      }),
      403,
      'forbidden',
    );
    await expectError(
      await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/projects/${row!.id}`,
        body: { name: 'X' },
        apiKey: fixture.integrator.apiKey,
      }),
      403,
      'forbidden',
    );
    await expectError(
      await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/projects/${crypto.randomUUID()}`,
        body: { name: 'X' },
        cookie: fixture.adminCookie,
      }),
      404,
      'not_found',
    );
    await expectError(
      await apiCall(fixture.deps, {
        method: 'PATCH',
        path: `/api/v1/projects/${row!.id}`,
        body: { name: '' },
        cookie: fixture.adminCookie,
      }),
      400,
      'bad_request',
    );
  });

  it('records the project.created audit without secrets and never for refused calls', async () => {
    const events = await fixture.db.select().from(auditEvent).where(eq(auditEvent.action, 'project.created'));
    // alpha create + alpha idempotent retry + beta create; refusals (member,
    // agent, anonymous) never audit because the handler never ran for them.
    expect(events).toHaveLength(3);
    const projects = await fixture.db.select().from(portalProject);
    expect(new Set(events.map((e) => e.resourceId))).toEqual(new Set(projects.map((p) => p.id)));
    for (const event of events) {
      expect(event.actor).toBe(`user:${fixture.users.admin.id}`);
      expect(event.resourceType).toBe('portal_project');
      expect([fixture.clientA.id, fixture.clientB.id]).toContain(event.clientId);
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('cookie');
      expect(serialized).not.toContain('x-api-key');
      expect(serialized).not.toContain('proj-member-1');
      expect(serialized).not.toContain('proj-agent-1');
    }
  });
});
