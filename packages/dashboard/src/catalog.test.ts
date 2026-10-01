/**
 * Catalog consumption suites (P-005): the dashboard is the single consumer
 * of the frozen `StudioCatalog` DTO. Covered:
 * - one entry per sealed revision for image/SVG/video; roles and servicePaths
 *   by declared output name; DTO never redefined (schema-parsed);
 * - REVISION-SCOPED production state: r1 reflects its SEALED outputs even
 *   after the latest renamed them or the working files disappeared, and a
 *   declared-but-unsealed output stays missing (existence-only checks: no
 *   hashing of media during catalog reads);
 * - filters client/project/asset/kind (+invalid kinds rejected);
 * - backup state from structural receipt evidence only: a forged
 *   "confirmed" status without complete evidence reads as failed, never as
 *   "backup confirmado" por boolean editable;
 * - editorial status stays a separate, independent field.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { StudioCatalogSchema } from '@videomaker/schemas';
import { buildStudioCatalog, isStudioServiceError, type CatalogFilter, type StudioCatalog } from '@videomaker/studio';

import { editAssetJson, makeDashboardFixture, type DashboardFixture } from './fixtures';

async function catalogOf(ctx: DashboardFixture['ctx'], filter?: CatalogFilter): Promise<StudioCatalog> {
  const catalog = await buildStudioCatalog(ctx, filter);
  const parsed = StudioCatalogSchema.safeParse(catalog);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : (null as never);
}

async function serviceErrorOf(code: string, run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(isStudioServiceError(thrown)).toBe(true);
  expect((thrown as { code: string }).code).toBe(code);
}

describe('catálogo studio consumido por el dashboard', () => {
  let fixture: DashboardFixture;

  afterEach(async () => {
    await fixture?.cleanup();
    fixture = undefined as unknown as DashboardFixture;
  });

  test('una entrada por revisión sellada (imagen r1/r2, svg, video); DTO congelado', async () => {
    fixture = await makeDashboardFixture('vm-catalog-entries');
    const catalog = await catalogOf(fixture.ctx);
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.entries).toHaveLength(4);

    const imageR1 = catalog.entries.find((entry) => entry.revisionId === fixture.imageR1)!;
    expect(imageR1.asset.kind).toBe('image');
    expect(imageR1.rootHash).toMatch(/^[0-9a-f]{64}$/);
    expect(imageR1.clients).toEqual([{ id: fixture.clientId, name: 'Cliente Uno' }]);
    expect(imageR1.presets).toEqual([{ presetId: fixture.presetId, versionId: fixture.presetVersionId, clientId: fixture.clientId, name: 'Logo Brand' }]);
    // outputs = SELLADOS (manifest); lo declarado-sin-sello vive en production.
    const roles = Object.fromEntries(imageR1.outputs.map((output) => [output.name, output.role]));
    expect(Object.keys(roles)).toEqual(['cover', 'thumb', 'slide']);
    expect(roles['cover']).toBe('deliverable');
    expect(roles['thumb']).toBe('thumbnail');
    expect(roles['slide']).toBe('deliverable');
    expect(imageR1.production.missingOutputs).toEqual(['cover-alt']);
    for (const output of imageR1.outputs) {
      expect(output.servicePath).toBe(`files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/${output.name}`);
      expect(output.visibility).toBe('private');
    }

    const svg = catalog.entries.find((entry) => entry.revisionId === fixture.svgR1)!;
    expect(svg.asset.kind).toBe('svg');
    const video = catalog.entries.find((entry) => entry.revisionId === fixture.videoR1)!;
    expect(video.asset.kind).toBe('video');
    expect(video.clients).toEqual([]); // proyecto sin clientes
  });

  test('producción por revisión: r1 conserva su output sellado tras renombrar latest y borrar working', async () => {
    fixture = await makeDashboardFixture('vm-catalog-r1r2');
    const catalog = await catalogOf(fixture.ctx);
    const r1 = catalog.entries.find((entry) => entry.revisionId === fixture.imageR1)!;
    const r2 = catalog.entries.find((entry) => entry.revisionId === fixture.imageR2)!;

    // r1 (sello): cover/thumb/slide sellados presentes; cover-alt declarado y
    // JAMÁS sellado sigue missing — AUNQUE el working dir ya no tiene cover
    // ni thumb y r2 renombró.
    expect(r1.production.presentOutputs).toEqual(['cover', 'thumb', 'slide']);
    expect(r1.production.missingOutputs).toEqual(['cover-alt']);
    expect(r1.outputs.map((output) => output.name)).toEqual(['cover', 'thumb', 'slide']);

    // r2: su propio nombre declarado sellado; cover ya no existe en r2.
    expect(r2.production.presentOutputs).toEqual(['cover-v2', 'thumb', 'slide']);
    expect(r2.production.missingOutputs).toEqual(['cover-alt']);
    expect(r2.outputs.map((output) => output.name)).toEqual(['cover-v2', 'thumb', 'slide']);

    // Working dir appears to "recover" cover-alt AFTER both seals: the
    // revision-scoped view must NOT reclassify any sealed revision.
    await editAssetJson(fixture.root, fixture.demoProjectId, fixture.imageAssetId, () => {}); // touch latest: irrelevant
    await mkdir(path.join(fixture.root, 'projects', fixture.demoProjectId, 'assets', fixture.imageAssetId, 'outputs'), { recursive: true });
    await writeFile(
      path.join(fixture.root, 'projects', fixture.demoProjectId, 'assets', fixture.imageAssetId, 'outputs', 'cover-alt.png'),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
    );
    const after = await catalogOf(fixture.ctx);
    const r1After = after.entries.find((entry) => entry.revisionId === fixture.imageR1)!;
    const r2After = after.entries.find((entry) => entry.revisionId === fixture.imageR2)!;
    expect(r1After.production.missingOutputs).toEqual(['cover-alt']);
    expect(r2After.production.missingOutputs).toEqual(['cover-alt']);
  });

  test('filtros del servicio: client/project/asset/kind; kind inválido rechazado', async () => {
    fixture = await makeDashboardFixture('vm-catalog-filters');
    const videoOnly = await catalogOf(fixture.ctx, { kind: 'video' });
    expect(videoOnly.entries.map((entry) => entry.assetId)).toEqual([fixture.videoAssetId]);

    const byClient = await catalogOf(fixture.ctx, { clientId: fixture.clientId });
    expect(byClient.entries).toHaveLength(3);
    expect(byClient.entries.every((entry) => entry.clients.some((client) => client.id === fixture.clientId))).toBe(true);

    const byProject = await catalogOf(fixture.ctx, { projectId: fixture.soloProjectId });
    expect(byProject.entries).toHaveLength(1);
    const byAsset = await catalogOf(fixture.ctx, { assetId: fixture.svgAssetId });
    expect(byAsset.entries.map((entry) => entry.revisionId)).toEqual([fixture.svgR1]);

    const combined = await catalogOf(fixture.ctx, { clientId: fixture.clientId, kind: 'image' });
    expect(combined.entries).toHaveLength(2);

    await serviceErrorOf('INVALID_INPUT', () => buildStudioCatalog(fixture.ctx, { kind: 'nope' }));
    await serviceErrorOf('INVALID_INPUT', () => buildStudioCatalog(fixture.ctx, { projectId: '../etc' }));
  });

  test('respaldo por evidencia estructural: receipt "confirmed" incompleto lee failed, no confirmado', async () => {
    fixture = await makeDashboardFixture('vm-catalog-backup');
    const before = await catalogOf(fixture.ctx);
    const r1 = before.entries.find((entry) => entry.revisionId === fixture.imageR1)!;
    expect(r1.backup).toEqual({ status: 'local', receiptVerified: false });
    expect(r1.errors).toEqual([]);

    // Forge a receipt that CLAIMS confirmed without complete evidence
    // (missing confirmedObjects coverage): structural proof fails, the
    // catalog reports failed + actionable error — never "confirmed".
    const receiptDir = path.join(fixture.root, '.vm', 'receipts', fixture.demoProjectId, fixture.imageAssetId);
    await mkdir(receiptDir, { recursive: true });
    await writeFile(
      path.join(receiptDir, `${fixture.imageR1}.json`),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          projectId: fixture.demoProjectId,
          assetId: fixture.imageAssetId,
          revisionId: fixture.imageR1,
          rootHash: r1.rootHash,
          manifestKey: `studio/v1/projects/${fixture.demoProjectId}/assets/${fixture.imageAssetId}/revisions/${fixture.imageR1}/manifest.json`,
          manifestSha256: 'f'.repeat(64),
          status: 'confirmed',
          confirmedObjects: [],
        },
        null,
        2,
      )}\n`,
    );
    const after = await catalogOf(fixture.ctx);
    const forged = after.entries.find((entry) => entry.revisionId === fixture.imageR1)!;
    expect(forged.backup.status).toBe('failed');
    expect(forged.backup.receiptVerified).toBe(false);
    expect(forged.errors.length).toBeGreaterThan(0);
    // manifestSha256 que no firma los bytes locales ⇒ HASH_MISMATCH.
    expect(forged.errors[0]!.code).toBe('HASH_MISMATCH');

    // Untouched sibling stays local (and editorial is a separate dimension).
    const svg = after.entries.find((entry) => entry.revisionId === fixture.svgR1)!;
    expect(svg.backup.status).toBe('local');
    expect(svg.editorialStatus).toBe('draft');
  });
});
