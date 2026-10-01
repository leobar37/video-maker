/**
 * File-based identity and workshop services (contracts.md §5): clients,
 * immutable versioned brand presets, client-independent projects and open
 * assets. Creative editing happens directly in the files; services only
 * create and read. Updating a preset ALWAYS means a new version.
 */
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  CreativeAssetSchema,
  CreativeProjectSchema,
  PresetVersionSchema,
  StudioClientSchema,
  type CreativeAsset,
  type CreativeProject,
  type PresetRef,
  type PresetVersion,
  type StudioClient,
} from '@videomaker/schemas';

import type {
  AssetInspection,
  CreateClientInput,
  CreateCreativeAssetInput,
  CreatePresetVersionInput,
  StudioContext,
} from './contracts';
import { fail } from './errors';
import { assertNonEmptyString, assertStudioId, parseOrInvalid, readJsonDocument, writeExclusiveJson } from './jsonio';
import {
  assetDir,
  assetFile,
  clientFile,
  clientsRoot,
  listDirNames,
  presetFile,
  presetVersionsRoot,
  presetsRoot,
  projectFile,
  projectsRoot,
  workspaceRoot,
} from './paths';
import { evaluateRevisionBackup } from './receipts';
import { getRevisionManifest, listAssetRevisions } from './snapshot';
async function ensurePresetVersionExists(root: string, ref: PresetRef): Promise<void> {
  const preset = await readJsonDocument(
    presetFile(root, ref.presetId, ref.versionId),
    PresetVersionSchema,
    `preset ${ref.presetId}@${ref.versionId}`,
  );
  if (preset.presetId !== ref.presetId || preset.versionId !== ref.versionId) {
    fail('INVALID_INPUT', 'El documento de preset no coincide con la referencia declarada.', {
      presetId: ref.presetId,
      versionId: ref.versionId,
    });
  }
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export async function createClient(ctx: StudioContext, input: CreateClientInput): Promise<StudioClient> {
  assertStudioId(input.id, 'client id');
  assertNonEmptyString(input.name, 'name');
  const root = workspaceRoot(ctx);
  for (const ref of input.presetRefs ?? []) {
    assertStudioId(ref.presetId, 'presetId');
    assertStudioId(ref.versionId, 'versionId');
    await ensurePresetVersionExists(root, ref);
  }
  const doc = parseOrInvalid(
    StudioClientSchema,
    {
      schemaVersion: 1,
      id: input.id,
      name: input.name,
      ...(input.presetRefs !== undefined && input.presetRefs.length > 0 ? { presetRefs: input.presetRefs } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    },
    `client ${input.id}`,
  );
  await writeExclusiveJson(clientFile(root, input.id), doc, `client ${input.id}`);
  return doc;
}

export async function listClients(ctx: StudioContext): Promise<StudioClient[]> {
  const root = workspaceRoot(ctx);
  const clients: StudioClient[] = [];
  for (const clientId of await listDirNames(clientsRoot(root))) {
    clients.push(await readJsonDocument(clientFile(root, clientId), StudioClientSchema, `client ${clientId}`));
  }
  return clients;
}

export async function getClient(ctx: StudioContext, input: { id: string }): Promise<StudioClient> {
  assertStudioId(input.id, 'client id');
  return readJsonDocument(clientFile(workspaceRoot(ctx), input.id), StudioClientSchema, `client ${input.id}`);
}

// ---------------------------------------------------------------------------
// Preset versions (immutable: a change is a NEW version)
// ---------------------------------------------------------------------------

export async function createPresetVersion(ctx: StudioContext, input: CreatePresetVersionInput): Promise<PresetVersion> {
  assertStudioId(input.presetId, 'presetId');
  assertStudioId(input.clientId, 'clientId');
  assertNonEmptyString(input.name, 'name');
  const root = workspaceRoot(ctx);
  await readJsonDocument(clientFile(root, input.clientId), StudioClientSchema, `client ${input.clientId}`);
  const versionId = assertStudioId(ctx.newId(), 'versionId generado');
  const doc = parseOrInvalid(
    PresetVersionSchema,
    {
      schemaVersion: 1,
      presetId: input.presetId,
      versionId,
      clientId: input.clientId,
      name: input.name,
      ...(input.identity !== undefined ? { identity: input.identity } : {}),
      ...(input.resources !== undefined && input.resources.length > 0 ? { resources: input.resources } : {}),
      ...(input.visualRefs !== undefined && input.visualRefs.length > 0 ? { visualRefs: input.visualRefs } : {}),
    },
    `preset ${input.presetId}@${versionId}`,
  );
  await writeExclusiveJson(presetFile(root, input.presetId, versionId), doc, `preset ${input.presetId}@${versionId}`);
  return doc;
}

export async function listPresetVersions(ctx: StudioContext, input: { presetId?: string }): Promise<PresetVersion[]> {
  const root = workspaceRoot(ctx);
  const presetIds = input.presetId !== undefined ? [assertStudioId(input.presetId, 'presetId')] : await listDirNames(presetsRoot(root));
  const versions: PresetVersion[] = [];
  for (const presetId of presetIds) {
    for (const versionId of await listDirNames(presetVersionsRoot(root, presetId))) {
      versions.push(await readJsonDocument(presetFile(root, presetId, versionId), PresetVersionSchema, `preset ${presetId}@${versionId}`));
    }
  }
  return versions.sort((a, b) => (a.presetId < b.presetId ? -1 : a.presetId > b.presetId ? 1 : a.versionId < b.versionId ? -1 : 1));
}

export async function getPresetVersion(ctx: StudioContext, input: { presetId: string; versionId: string }): Promise<PresetVersion> {
  assertStudioId(input.presetId, 'presetId');
  assertStudioId(input.versionId, 'versionId');
  return readJsonDocument(
    presetFile(workspaceRoot(ctx), input.presetId, input.versionId),
    PresetVersionSchema,
    `preset ${input.presetId}@${input.versionId}`,
  );
}

// ---------------------------------------------------------------------------
// Creative projects (independent of clients)
// ---------------------------------------------------------------------------

export async function createCreativeProject(
  ctx: StudioContext,
  input: { id: string; name: string; clientIds?: string[] },
): Promise<CreativeProject> {
  assertStudioId(input.id, 'project id');
  assertNonEmptyString(input.name, 'name');
  const root = workspaceRoot(ctx);
  const clientIds = input.clientIds ?? [];
  for (const clientId of clientIds) {
    assertStudioId(clientId, 'clientId');
    await readJsonDocument(clientFile(root, clientId), StudioClientSchema, `client ${clientId}`);
  }
  const doc = parseOrInvalid(CreativeProjectSchema, { schemaVersion: 1, id: input.id, name: input.name, clientIds }, `project ${input.id}`);
  await writeExclusiveJson(projectFile(root, input.id), doc, `project ${input.id}`);
  return doc;
}

export async function listCreativeProjects(ctx: StudioContext): Promise<CreativeProject[]> {
  const root = workspaceRoot(ctx);
  const projects: CreativeProject[] = [];
  for (const projectId of await listDirNames(projectsRoot(root))) {
    projects.push(await readJsonDocument(projectFile(root, projectId), CreativeProjectSchema, `project ${projectId}`));
  }
  return projects;
}

export async function getCreativeProject(ctx: StudioContext, input: { id: string }): Promise<CreativeProject> {
  assertStudioId(input.id, 'project id');
  return readJsonDocument(projectFile(workspaceRoot(ctx), input.id), CreativeProjectSchema, `project ${input.id}`);
}

// ---------------------------------------------------------------------------
// Open assets
// ---------------------------------------------------------------------------

export async function createCreativeAsset(ctx: StudioContext, input: CreateCreativeAssetInput): Promise<CreativeAsset> {
  assertStudioId(input.id, 'asset id');
  const root = workspaceRoot(ctx);
  await readJsonDocument(projectFile(root, input.projectId), CreativeProjectSchema, `project ${input.projectId}`);
  const presetRefs = input.presetRefs ?? [];
  for (const ref of presetRefs) {
    assertStudioId(ref.presetId, 'presetId');
    assertStudioId(ref.versionId, 'versionId');
    await ensurePresetVersionExists(root, ref);
  }
  const title = input.title !== undefined ? assertNonEmptyString(input.title, 'title') : input.id;
  const doc = parseOrInvalid(
    CreativeAssetSchema,
    { schemaVersion: 1, id: input.id, projectId: input.projectId, kind: input.kind, title, presetRefs, sources: [], inputs: [], outputs: [] },
    `asset ${input.id}`,
  );
  await writeExclusiveJson(assetFile(root, input.projectId, input.id), doc, `asset ${input.id}`);
  const dir = assetDir(root, input.projectId, input.id);
  await mkdir(path.join(dir, 'workroom'), { recursive: true });
  await mkdir(path.join(dir, 'outputs'), { recursive: true });
  return doc;
}

/** Full open view of one asset: real paths, exact presets, state — never just an id. */
export async function inspectCreativeAsset(ctx: StudioContext, input: { projectId: string; assetId: string }): Promise<AssetInspection> {
  assertStudioId(input.projectId, 'project id');
  assertStudioId(input.assetId, 'asset id');
  const root = workspaceRoot(ctx);
  const asset = await readJsonDocument(assetFile(root, input.projectId, input.assetId), CreativeAssetSchema, `asset ${input.assetId}`);
  const dir = assetDir(root, input.projectId, input.assetId);

  const pathStatus = async (declared: string): Promise<{ path: string; present: boolean }> => {
    try {
      await stat(path.resolve(dir, declared));
      return { path: declared, present: true };
    } catch {
      return { path: declared, present: false };
    }
  };

  const presets = await Promise.all(
    asset.presetRefs.map(async (ref) => ({
      presetId: ref.presetId,
      versionId: ref.versionId,
      preset: await readJsonDocument(presetFile(root, ref.presetId, ref.versionId), PresetVersionSchema, `preset ${ref.presetId}@${ref.versionId}`).catch(() => null),
    })),
  );

  const outputs = await Promise.all(
    asset.outputs.map(async (spec) => ({
      ...spec,
      present: await pathExistsInDir(dir, spec.path),
    })),
  );

  const history = await listAssetRevisions(ctx, { projectId: input.projectId, assetId: input.assetId });
  const sync = await Promise.all(
    history.map(async (summary) => {
      const manifest = await getRevisionManifest(ctx, {
        projectId: input.projectId,
        assetId: input.assetId,
        revisionId: summary.revisionId,
      });
      const evidence = await evaluateRevisionBackup(
        root,
        { projectId: input.projectId, assetId: input.assetId, revisionId: summary.revisionId },
        manifest,
      );
      return { revisionId: summary.revisionId, status: evidence.status };
    }),
  );

  return {
    asset,
    assetDir: dir,
    sources: await Promise.all(asset.sources.map(pathStatus)),
    inputs: await Promise.all(asset.inputs.map(pathStatus)),
    presets,
    outputs,
    ...(asset.recipe !== undefined ? { recipe: asset.recipe } : {}),
    history,
    sync,
  };
}

async function pathExistsInDir(dir: string, relPath: string): Promise<boolean> {
  try {
    await stat(path.resolve(dir, relPath));
    return true;
  } catch {
    return false;
  }
}
