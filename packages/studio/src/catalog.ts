/**
 * Read-only catalog DTO (contracts.md §5) consumed by the single dashboard:
 * one entry per sealed revision, with editorial / production / backup states
 * kept separate and logical service paths (never persisted in manifests).
 */
import path from 'node:path';

import {
  StudioCatalogSchema,
  type StudioCatalog,
  type StudioCatalogEntry,
  type StudioCatalogOutput,
} from '@videomaker/schemas';

import type { CatalogFilter, StudioContext } from './contracts';
import { fail } from './errors';
import { assertStudioId, parseOrInvalid } from './jsonio';
import { assetsRoot, describePathKind, listDirNames, projectsRoot, revisionsRoot, revisionDir, workspaceRoot } from './paths';
import { evaluateRevisionBackup } from './receipts';
import { getRevisionManifest } from './snapshot';

const ASSET_KINDS: Record<string, true> = { image: true, video: true, svg: true, other: true };

export async function buildStudioCatalog(ctx: StudioContext, filter?: CatalogFilter): Promise<StudioCatalog> {
  if (filter?.projectId !== undefined) assertStudioId(filter.projectId, 'filter.projectId');
  if (filter?.assetId !== undefined) assertStudioId(filter.assetId, 'filter.assetId');
  if (filter?.clientId !== undefined) assertStudioId(filter.clientId, 'filter.clientId');
  if (filter?.kind !== undefined && !ASSET_KINDS[filter.kind]) {
    fail('INVALID_INPUT', 'filter.kind debe ser image | video | svg | other.', { kind: filter.kind });
  }

  const root = workspaceRoot(ctx);
  const entries: StudioCatalogEntry[] = [];
  for (const projectId of await listDirNames(projectsRoot(root))) {
    if (filter?.projectId !== undefined && filter.projectId !== projectId) continue;

    for (const assetId of await listDirNames(assetsRoot(root, projectId))) {
      if (filter?.assetId !== undefined && filter.assetId !== assetId) continue;

      for (const revisionId of await listDirNames(revisionsRoot(root, projectId, assetId))) {
        if (revisionId.startsWith('.staging-')) continue;
        const manifest = await getRevisionManifest(ctx, { projectId, assetId, revisionId });
        if (filter?.kind !== undefined && manifest.assetSnapshot.kind !== filter.kind) continue;
        if (filter?.clientId !== undefined && !manifest.clientSnapshots.some((client) => client.id === filter.clientId)) continue;

        // Revision-scoped production state (contracts.md §8): declared outputs
        // come from THIS revision's frozen assetSnapshot and presence is
        // decided against the SEALED copy under revisions/.../files — never
        // against the mutable working dir or latest asset.json (an r1 entry
        // must not inherit r2 renames or working-file deletions). Existence
        // only: full SHA verification happens when the file is served.
        const sealedFilesDir = path.join(revisionDir(root, projectId, assetId, revisionId), 'files');
        const sealedRefPaths = new Set(manifest.outputs.map((ref) => ref.path));
        const presentOutputs: string[] = [];
        const missingOutputs: string[] = [];
        for (const spec of manifest.assetSnapshot.outputs) {
          const sealed = sealedRefPaths.has(spec.path) && (await describePathKind(path.join(sealedFilesDir, spec.path))) === 'file';
          (sealed ? presentOutputs : missingOutputs).push(spec.name);
        }

        const outputs: StudioCatalogOutput[] = manifest.outputs.map((ref) => {
          const spec = manifest.assetSnapshot.outputs.find((candidate) => candidate.name === ref.name);
          return {
            name: ref.name,
            mediaType: spec?.mediaType ?? 'application/octet-stream',
            role: spec?.role ?? 'deliverable',
            visibility: spec?.visibility ?? 'private',
            servicePath: `files/${projectId}/${assetId}/${revisionId}/${ref.name}`,
          };
        });

        const evidence = await evaluateRevisionBackup(root, { projectId, assetId, revisionId }, manifest);
        entries.push({
          projectId,
          assetId,
          revisionId,
          rootHash: manifest.rootHash,
          project: { id: manifest.projectSnapshot.id, name: manifest.projectSnapshot.name },
          clients: manifest.clientSnapshots.map((client) => ({ id: client.id, name: client.name })),
          asset: {
            id: manifest.assetSnapshot.id,
            kind: manifest.assetSnapshot.kind,
            title: manifest.assetSnapshot.title,
            presetRefs: manifest.assetSnapshot.presetRefs,
          },
          presets: manifest.presetSnapshots.map((preset) => ({
            presetId: preset.presetId,
            versionId: preset.versionId,
            clientId: preset.clientId,
            name: preset.name,
          })),
          outputs,
          editorialStatus: manifest.editorialStatus,
          production: { presentOutputs, missingOutputs },
          backup: { status: evidence.status, receiptVerified: evidence.receiptVerified },
          errors: evidence.error !== undefined ? [evidence.error] : [],
        });
      }
    }
  }
  return parseOrInvalid(StudioCatalogSchema, { schemaVersion: 1, entries }, 'studio catalog');
}
