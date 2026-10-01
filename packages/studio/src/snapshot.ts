/**
 * Local revisions (contracts.md §3–§5): immutable staging + lock + atomic
 * publish, deterministic history/diff, checkpoint map and restore that only
 * copies verified bytes. No render, no network, no subprocess — restoring
 * never regenerates or executes sources.
 */
import { mkdir, open, readdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalStudioJson,
  computeRevisionRootHash,
  CreativeAssetSchema,
  CreativeProjectSchema,
  PresetVersionSchema,
  ProjectCheckpointSchema,
  RevisionManifestSchema,
  sha256Hex,
  StudioClientSchema,
  type CreativeAsset,
  type CreativeProject,
  type ManifestOutputRef,
  type PresetRef,
  type PresetVersion,
  type ProjectCheckpoint,
  type RevisionManifest,
  type SnapshotFile,
  type StudioClient,
} from '@videomaker/schemas';

import type { RevisionDiff, RevisionRef, RevisionSummary, StudioContext } from './contracts';
import { fail } from './errors';
import { assertNonEmptyString, assertStudioId, parseOrInvalid, readJsonDocument, writeExclusiveJson } from './jsonio';
import {
  assertNoSymlinkComponents,
  assetDir,
  assetFile,
  assetLockFile,
  checkpointFileOf,
  clientFile,
  describePathKind,
  EXCLUDED_DIR_NAMES,
  EXCLUDED_FILE_NAMES,
  isInsideDir,
  listDirNames,
  manifestFileOf,
  pathExists,
  presetFile,
  presetVersionDir,
  projectFile,
  resolveInsideDir,
  revisionDir,
  revisionsRoot,
  stagingRevisionDir,
  workspaceRoot,
} from './paths';
import { secretPathReason } from './selection';
import { sealEntries, verifySealedMetadata, type SealEntry } from './sealing';

// ---------------------------------------------------------------------------
// Locking: one writer per asset
// ---------------------------------------------------------------------------

async function acquireAssetLock(lockPath: string): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(`${new Date().toISOString()}\n`, 'utf8');
    await handle.close();
  } catch (cause) {
    fail('CONFLICT', 'Otra operación mantiene el lock de snapshot para este asset.', undefined, cause);
  }
}

async function releaseAssetLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // Already released: nothing to clean.
  }
}

// ---------------------------------------------------------------------------
// Preset / client resolution for the exact snapshot
// ---------------------------------------------------------------------------

function byPresetKey(a: { presetId: string; versionId: string }, b: { presetId: string; versionId: string }): number {
  const keyA = `${a.presetId}@${a.versionId}`;
  const keyB = `${b.presetId}@${b.versionId}`;
  return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
}

async function resolvePresetVersions(root: string, refs: PresetRef[]): Promise<PresetVersion[]> {
  const unique = new Map<string, PresetRef>();
  for (const ref of refs) {
    unique.set(`${ref.presetId}@${ref.versionId}`, ref);
  }
  const resolved: PresetVersion[] = [];
  for (const ref of [...unique.values()].sort(byPresetKey)) {
    const preset = await readJsonDocument(
      presetFile(root, ref.presetId, ref.versionId),
      PresetVersionSchema,
      `preset ${ref.presetId}@${ref.versionId}`,
    );
    if (preset.presetId !== ref.presetId || preset.versionId !== ref.versionId) {
      fail('INVALID_INPUT', 'El documento de preset no coincide con la referencia del asset.', {
        presetId: ref.presetId,
        versionId: ref.versionId,
      });
    }
    resolved.push(preset);
  }
  return resolved;
}

async function collectClientSnapshots(root: string, project: CreativeProject, presets: PresetVersion[]): Promise<StudioClient[]> {
  const needed = new Set<string>(project.clientIds);
  for (const preset of presets) {
    needed.add(preset.clientId);
  }
  const clients: StudioClient[] = [];
  for (const clientId of [...needed].sort()) {
    clients.push(await readJsonDocument(clientFile(root, clientId), StudioClientSchema, `client ${clientId}`));
  }
  return clients;
}

// ---------------------------------------------------------------------------
// File selection (contracts.md §4)
// ---------------------------------------------------------------------------

interface CollectedEntries {
  entries: SealEntry[];
  outputRefs: ManifestOutputRef[];
}

/**
 * Precedence when a path is declared twice (dedup, first insert wins):
 * outputs → asset.json (metadata) → presets → inputs → sources.
 */
async function collectSealEntries(
  root: string,
  projectId: string,
  asset: CreativeAsset,
  presets: PresetVersion[],
): Promise<CollectedEntries> {
  const byPath = new Map<string, SealEntry>();
  const dir = assetDir(root, projectId, asset.id);
  const outputRefs: ManifestOutputRef[] = [];

  const add = (snapshotPath: string, absolutePath: string, role: SealEntry['role'], extra: Partial<SealEntry> = {}): void => {
    const existing = byPath.get(snapshotPath);
    if (existing !== undefined) {
      if (path.resolve(existing.absolutePath) !== path.resolve(absolutePath)) {
        fail('CONFLICT', 'Dos archivos distintos colisionan en la misma ruta del snapshot; renombra antes de sellar.', {
          snapshotPath,
          yaSeleccionado: existing.absolutePath,
          candidato: absolutePath,
        });
      }
      return; // Same real file declared twice: first role wins (dedup).
    }
    byPath.set(snapshotPath, { snapshotPath, absolutePath, role, ...extra });
  };

  const rejectSecret = (relPath: string): void => {
    const reason = secretPathReason(relPath);
    if (reason !== null) {
      fail('SECRET_PATH', 'La selección declara un archivo con patrón de secreto; revisa el asset antes de sellar.', {
        path: relPath,
        reason,
      });
    }
  };

  for (const spec of asset.outputs) {
    rejectSecret(spec.path);
    const abs = resolveInsideDir(dir, spec.path, `output ${spec.name}`);
    const kind = await describePathKind(abs);
    if (kind === 'missing') continue; // Only existing outputs are sealed; >=1 required later.
    await assertNoSymlinkComponents(dir, spec.path, `output ${spec.name}`);
    if (kind !== 'file') {
      fail('PATH_UNSAFE', 'Un output declarado debe ser un archivo regular.', { path: spec.path, kind });
    }
    add(spec.path, abs, 'output', { mediaType: spec.mediaType, verifySignature: true });
    outputRefs.push({ name: spec.name, path: spec.path });
  }

  add('asset.json', path.join(dir, 'asset.json'), 'metadata');

  for (const preset of presets) {
    const versionDir = presetVersionDir(root, preset.presetId, preset.versionId);
    const versionDirKind = await describePathKind(versionDir);
    if (versionDirKind !== 'directory') {
      fail('PATH_UNSAFE', 'El directorio de versión de preset debe ser un directorio real.', {
        presetId: preset.presetId,
        versionId: preset.versionId,
        kind: versionDirKind,
      });
    }
    const presetJsonAbs = path.join(versionDir, 'preset.json');
    if ((await describePathKind(presetJsonAbs)) !== 'file') {
      fail('NOT_FOUND', 'Falta preset.json de la versión exacta.', { presetId: preset.presetId, versionId: preset.versionId });
    }
    add(`presets/${preset.presetId}/${preset.versionId}/preset.json`, presetJsonAbs, 'preset');
    for (const resource of [...(preset.resources ?? [])].sort((a, b) => (a.path < b.path ? -1 : 1))) {
      rejectSecret(resource.path);
      const abs = resolveInsideDir(versionDir, resource.path, `recurso de preset ${preset.presetId}`);
      await assertNoSymlinkComponents(versionDir, resource.path, `recurso de preset ${preset.presetId}`);
      const kind = await describePathKind(abs);
      if (kind === 'missing') {
        fail('NOT_FOUND', 'Recurso declarado por el preset inexistente en disco.', {
          presetId: preset.presetId,
          versionId: preset.versionId,
          path: resource.path,
        });
      }
      if (kind !== 'file') {
        fail('PATH_UNSAFE', 'Un recurso de preset debe ser un archivo regular.', { path: resource.path, kind });
      }
      add(`presets/${preset.presetId}/${preset.versionId}/${resource.path}`, abs, 'preset', {
        expectedSha256: resource.sha256,
        ...(resource.mediaType !== undefined ? { mediaType: resource.mediaType } : {}),
      });
    }
  }

  for (const role of ['input', 'source'] as const) {
    for (const declared of asset[role === 'input' ? 'inputs' : 'sources']) {
      await addDeclaredPath(dir, declared, role, rejectSecret, add);
    }
  }

  return { entries: [...byPath.values()], outputRefs };
}

async function addDeclaredPath(
  dir: string,
  declared: string,
  role: 'source' | 'input',
  rejectSecret: (relPath: string) => void,
  add: (snapshotPath: string, absolutePath: string, role: SealEntry['role']) => void,
): Promise<void> {
  rejectSecret(declared);
  const abs = resolveInsideDir(dir, declared, `${role} declarado`);
  const kind = await describePathKind(abs);
  if (kind === 'missing') {
    fail('NOT_FOUND', `Ruta ${role} declarada inexistente; el backup de fuentes/inputs nunca omite en silencio.`, { path: declared });
  }
  await assertNoSymlinkComponents(dir, declared, `${role} declarado`);
  if (kind === 'symlink' || kind === 'special') {
    fail('PATH_UNSAFE', 'Ruta declarada no permitida (symlink o archivo especial).', { path: declared, kind });
  }
  if (kind === 'file') {
    add(declared.replace(/\/+$/, ''), abs, role);
    return;
  }
  await walkDirectory(abs, declared.replace(/\/+$/, ''), role, rejectSecret, add);
}

async function walkDirectory(
  absDir: string,
  relDir: string,
  role: 'source' | 'input',
  rejectSecret: (relPath: string) => void,
  add: (snapshotPath: string, absolutePath: string, role: SealEntry['role']) => void,
): Promise<void> {
  const entries = (await readdir(absDir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const rel = relDir.length === 0 ? entry.name : `${relDir}/${entry.name}`;
    if (EXCLUDED_FILE_NAMES[entry.name]) continue;
    if (entry.isDirectory()) {
      if (EXCLUDED_DIR_NAMES[entry.name]) continue; // Regenerable: pruned, documented policy.
      await walkDirectory(path.join(absDir, entry.name), rel, role, rejectSecret, add);
      continue;
    }
    if (entry.isSymbolicLink()) {
      fail('PATH_UNSAFE', 'Symlink dentro del directorio declarado.', { path: rel });
    }
    if (!entry.isFile()) {
      fail('PATH_UNSAFE', 'Archivo especial dentro del directorio declarado.', { path: rel });
    }
    rejectSecret(rel);
    add(rel, path.join(absDir, entry.name), role);
  }
}

// ---------------------------------------------------------------------------
// Lineage: deterministic parent selection
// ---------------------------------------------------------------------------

async function loadManifests(root: string, projectId: string, assetId: string): Promise<RevisionManifest[]> {
  const dir = revisionsRoot(root, projectId, assetId);
  const manifests: RevisionManifest[] = [];
  for (const name of await listDirNames(dir)) {
    if (name.startsWith('.staging-')) continue;
    const manifestPath = path.join(dir, name, 'manifest.json');
    if (!(await pathExists(manifestPath))) continue;
    manifests.push(await readJsonDocument(manifestPath, RevisionManifestSchema, `manifest ${name}`));
  }
  return manifests;
}

/** Exactly one head (no child) is the parent; zero heads is a first revision. */
async function resolveParentRevisionId(root: string, projectId: string, assetId: string): Promise<string | undefined> {
  const manifests = await loadManifests(root, projectId, assetId);
  if (manifests.length === 0) return undefined;
  const parents = new Set<string>();
  for (const manifest of manifests) {
    if (manifest.parentRevisionId !== undefined) parents.add(manifest.parentRevisionId);
  }
  const heads = manifests.map((manifest) => manifest.revisionId).filter((id) => !parents.has(id)).sort();
  if (heads.length > 1) {
    fail('CONFLICT', 'El asset tiene varias cabezas de historial; resuelve el linaje antes de sellar.', { heads });
  }
  return heads[0];
}

// ---------------------------------------------------------------------------
// snapshotAsset
// ---------------------------------------------------------------------------

export async function snapshotAsset(
  ctx: StudioContext,
  input: { projectId: string; assetId: string; note: string },
): Promise<{ revision: RevisionManifest; manifestPath: string }> {
  assertStudioId(input.projectId, 'project id');
  assertStudioId(input.assetId, 'asset id');
  if (typeof input.note !== 'string') {
    fail('INVALID_INPUT', 'note debe ser un string.', { field: 'note' });
  }
  const root = workspaceRoot(ctx);
  const project = await readJsonDocument(projectFile(root, input.projectId), CreativeProjectSchema, `project ${input.projectId}`);
  const asset = await readJsonDocument(assetFile(root, input.projectId, input.assetId), CreativeAssetSchema, `asset ${input.assetId}`);
  const presets = await resolvePresetVersions(root, asset.presetRefs);
  const revisionId = assertStudioId(ctx.newId(), 'revisionId generado');

  const lockPath = assetLockFile(root, input.projectId, input.assetId);
  await acquireAssetLock(lockPath);
  const stagingDir = stagingRevisionDir(root, input.projectId, input.assetId, revisionId);
  try {
    await rm(stagingDir, { recursive: true, force: true });
    const parentRevisionId = await resolveParentRevisionId(root, input.projectId, input.assetId);
    const filesDir = path.join(stagingDir, 'files');
    await mkdir(filesDir, { recursive: true });

    const collected = await collectSealEntries(root, input.projectId, asset, presets);
    if (collected.outputRefs.length === 0) {
      fail('OUTPUT_MISSING', 'La revisión necesita al menos un output existente en disco.', {
        declaredOutputs: asset.outputs.map((spec) => spec.path),
      });
    }
    const files = await sealEntries(collected.entries, filesDir);
    await verifySealedMetadata(filesDir, asset, presets);
    const clientSnapshots = await collectClientSnapshots(root, project, presets);

    const manifest = await assembleManifest({
      asset,
      clientSnapshots,
      files,
      outputRefs: collected.outputRefs,
      presets,
      project,
      revisionId,
      ...(parentRevisionId !== undefined ? { parentRevisionId } : {}),
      note: input.note,
      createdAt: ctx.clock().toISOString(),
    });
    const validated = parseOrInvalid(RevisionManifestSchema, manifest, `manifest ${revisionId}`);
    await writeExclusiveJson(path.join(stagingDir, 'manifest.json'), validated, `manifest ${revisionId}`);

    const finalDir = revisionDir(root, input.projectId, input.assetId, revisionId);
    if (await pathExists(finalDir)) {
      fail('CONFLICT', 'La revisión ya existe en el workspace.', { revisionId });
    }
    await rename(stagingDir, finalDir);
    return { revision: validated, manifestPath: manifestFileOf(root, input.projectId, input.assetId, revisionId) };
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
    await releaseAssetLock(lockPath);
  }
}

interface AssembleManifestArgs {
  project: CreativeProject;
  asset: CreativeAsset;
  presets: PresetVersion[];
  clientSnapshots: StudioClient[];
  files: SnapshotFile[];
  outputRefs: ManifestOutputRef[];
  revisionId: string;
  parentRevisionId?: string;
  note: string;
  createdAt: string;
}

/**
 * Builds the manifest and seals it: the §3 payload ignores `rootHash`, so the
 * digest is computed through the placeholder and then stored on the field
 * that was excluded from the hash.
 */
async function assembleManifest(args: AssembleManifestArgs): Promise<RevisionManifest> {
  const manifest: RevisionManifest = {
    schemaVersion: 1,
    projectId: args.project.id,
    assetId: args.asset.id,
    revisionId: args.revisionId,
    ...(args.parentRevisionId !== undefined ? { parentRevisionId: args.parentRevisionId } : {}),
    createdAt: args.createdAt,
    note: args.note,
    editorialStatus: 'draft',
    projectSnapshot: args.project,
    clientSnapshots: args.clientSnapshots,
    assetSnapshot: args.asset,
    presetSnapshots: args.presets,
    ...(args.asset.recipe !== undefined ? { recipeSnapshot: args.asset.recipe } : {}),
    files: [...args.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    outputs: args.outputRefs,
    rootHash: '0'.repeat(64),
  };
  manifest.rootHash = await computeRevisionRootHash(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// History, diff, restore, checkpoint
// ---------------------------------------------------------------------------

function toSummary(manifest: RevisionManifest): RevisionSummary {
  return {
    revisionId: manifest.revisionId,
    ...(manifest.parentRevisionId !== undefined ? { parentRevisionId: manifest.parentRevisionId } : {}),
    createdAt: manifest.createdAt,
    note: manifest.note,
    editorialStatus: manifest.editorialStatus,
    rootHash: manifest.rootHash,
  };
}

export async function listAssetRevisions(
  ctx: StudioContext,
  input: { projectId: string; assetId: string },
): Promise<RevisionSummary[]> {
  assertStudioId(input.projectId, 'project id');
  assertStudioId(input.assetId, 'asset id');
  const manifests = await loadManifests(workspaceRoot(ctx), input.projectId, input.assetId);
  return manifests
    .map(toSummary)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.revisionId < b.revisionId ? -1 : 1));
}

export async function getRevisionManifest(ctx: StudioContext, ref: RevisionRef): Promise<RevisionManifest> {
  assertStudioId(ref.projectId, 'project id');
  assertStudioId(ref.assetId, 'asset id');
  assertStudioId(ref.revisionId, 'revision id');
  return readJsonDocument(
    manifestFileOf(workspaceRoot(ctx), ref.projectId, ref.assetId, ref.revisionId),
    RevisionManifestSchema,
    `manifest ${ref.revisionId}`,
  );
}

interface NameSets {
  added: string[];
  removed: string[];
  modified: string[];
}

function diffByKey<T>(from: T[], to: T[], key: (item: T) => string, signature: (item: T) => string): NameSets {
  const fromSignatures = new Map(from.map((item) => [key(item), signature(item)] as const));
  const toSignatures = new Map(to.map((item) => [key(item), signature(item)] as const));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [name, toSignature] of toSignatures) {
    const fromSignature = fromSignatures.get(name);
    if (fromSignature === undefined) added.push(name);
    else if (fromSignature !== toSignature) modified.push(name);
  }
  for (const name of fromSignatures.keys()) {
    if (!toSignatures.has(name)) removed.push(name);
  }
  return { added: added.sort(), removed: removed.sort(), modified: modified.sort() };
}

function shaByPathOf(manifest: RevisionManifest): Map<string, string> {
  return new Map(manifest.files.map((file) => [file.path, file.sha256] as const));
}

function presetSignature(preset: PresetVersion): string {
  return canonicalStudioJson({
    versionId: preset.versionId,
    name: preset.name,
    ...(preset.identity !== undefined ? { identity: preset.identity } : {}),
    ...(preset.resources !== undefined ? { resources: preset.resources } : {}),
    ...(preset.visualRefs !== undefined ? { visualRefs: preset.visualRefs } : {}),
  });
}

export async function diffAssetRevisions(
  ctx: StudioContext,
  input: { projectId: string; assetId: string; fromRevisionId: string; toRevisionId: string },
): Promise<RevisionDiff> {
  assertStudioId(input.projectId, 'project id');
  assertStudioId(input.assetId, 'asset id');
  assertStudioId(input.fromRevisionId, 'from revision id');
  assertStudioId(input.toRevisionId, 'to revision id');
  const from = await getRevisionManifest(ctx, {
    projectId: input.projectId,
    assetId: input.assetId,
    revisionId: input.fromRevisionId,
  });
  const to = await getRevisionManifest(ctx, { projectId: input.projectId, assetId: input.assetId, revisionId: input.toRevisionId });

  const fromShas = shaByPathOf(from);
  const toShas = shaByPathOf(to);
  const files = diffByKey(from.files, to.files, (file) => file.path, (file) => file.sha256);
  const fromOutputs = from.outputs.map((ref) => ({
    name: ref.name,
    signature: `${ref.path}:${fromShas.get(ref.path) ?? '?'}`,
  }));
  const toOutputs = to.outputs.map((ref) => ({
    name: ref.name,
    signature: `${ref.path}:${toShas.get(ref.path) ?? '?'}`,
  }));
  const outputs = diffByKey(fromOutputs, toOutputs, (item) => item.name, (item) => item.signature);
  const presets = diffByKey(from.presetSnapshots, to.presetSnapshots, (preset) => preset.presetId, presetSignature);

  const fromRecipe = from.recipeSnapshot === undefined ? null : canonicalStudioJson(from.recipeSnapshot);
  const toRecipe = to.recipeSnapshot === undefined ? null : canonicalStudioJson(to.recipeSnapshot);
  const recipe: RevisionDiff['recipe'] =
    fromRecipe === toRecipe ? 'unchanged' : fromRecipe === null ? 'added' : toRecipe === null ? 'removed' : 'modified';

  return {
    from: { revisionId: from.revisionId, rootHash: from.rootHash },
    to: { revisionId: to.revisionId, rootHash: to.rootHash },
    files,
    outputs,
    presets,
    recipe,
  };
}

export async function restoreAssetRevision(
  ctx: StudioContext,
  input: RevisionRef & { outDir: string },
): Promise<{ restored: SnapshotFile[]; outDir: string }> {
  assertStudioId(input.projectId, 'project id');
  assertStudioId(input.assetId, 'asset id');
  assertStudioId(input.revisionId, 'revision id');
  assertNonEmptyString(input.outDir, 'outDir');
  const root = workspaceRoot(ctx);
  const manifest = await getRevisionManifest(ctx, input);
  const recomputed = await computeRevisionRootHash(manifest);
  if (recomputed !== manifest.rootHash) {
    fail('HASH_MISMATCH', 'El manifest sellado no coincide con su rootHash (posible alteración).', {
      revisionId: manifest.revisionId,
    });
  }

  const outAbs = path.resolve(input.outDir);
  if (isInsideDir(root, outAbs)) {
    fail('PATH_UNSAFE', 'El destino de restauración no puede estar dentro del árbol de origen.', { outDir: input.outDir });
  }
  if (await pathExists(outAbs)) {
    const outKind = await describePathKind(outAbs);
    if (outKind !== 'directory') {
      fail('CONFLICT', 'El destino de restauración existe y no es un directorio.', { outDir: input.outDir, kind: outKind });
    }
    const existing = await readdir(outAbs);
    if (existing.length > 0) {
      fail('CONFLICT', 'El directorio de destino no está vacío; la restauración nunca sobrescribe.', { outDir: input.outDir });
    }
  }
  await mkdir(outAbs, { recursive: true });

  const sealedFilesRoot = path.join(revisionDir(root, input.projectId, input.assetId, input.revisionId), 'files');
  for (const file of [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const source = path.join(sealedFilesRoot, file.path);
    if ((await describePathKind(source)) !== 'file') {
      fail('NOT_FOUND', 'Archivo sellado ausente en la revisión local.', { revisionId: input.revisionId, path: file.path });
    }
    const bytes = new Uint8Array(await readFile(source));
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== file.sha256) {
      fail('HASH_MISMATCH', 'El archivo sellado no coincide con su hash declarado.', {
        revisionId: input.revisionId,
        path: file.path,
      });
    }
    const destination = path.join(outAbs, file.path);
    if (!isInsideDir(outAbs, destination)) {
      fail('PATH_UNSAFE', 'Ruta sellada escapa del destino.', { path: file.path });
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  return { restored: manifest.files, outDir: outAbs };
}

export async function createProjectCheckpoint(
  ctx: StudioContext,
  input: { projectId: string; entries: Array<{ assetId: string; revisionId: string }> },
): Promise<ProjectCheckpoint> {
  assertStudioId(input.projectId, 'project id');
  const root = workspaceRoot(ctx);
  await readJsonDocument(projectFile(root, input.projectId), CreativeProjectSchema, `project ${input.projectId}`);
  const seen = new Set<string>();
  const entries: ProjectCheckpoint['entries'] = [];
  for (const entry of input.entries) {
    assertStudioId(entry.assetId, 'asset id');
    assertStudioId(entry.revisionId, 'revision id');
    if (seen.has(entry.assetId)) {
      fail('INVALID_INPUT', 'Un checkpoint declara un asset como máximo una vez.', { assetId: entry.assetId });
    }
    seen.add(entry.assetId);
    const manifest = await getRevisionManifest(ctx, {
      projectId: input.projectId,
      assetId: entry.assetId,
      revisionId: entry.revisionId,
    });
    entries.push({ assetId: entry.assetId, revisionId: entry.revisionId, rootHash: manifest.rootHash });
  }
  const checkpointId = assertStudioId(ctx.newId(), 'checkpointId generado');
  const checkpoint = parseOrInvalid(
    ProjectCheckpointSchema,
    {
      schemaVersion: 1,
      projectId: input.projectId,
      checkpointId,
      createdAt: ctx.clock().toISOString(),
      entries,
    },
    `checkpoint ${checkpointId}`,
  );
  await writeExclusiveJson(checkpointFileOf(root, input.projectId, checkpointId), checkpoint, `checkpoint ${checkpointId}`);
  return checkpoint;
}
