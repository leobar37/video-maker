/**
 * scripts/studio-demo.ts — shared deterministic fixture of P-006.
 *
 * Builds a complete creative-workspace from the static adoption fixtures in
 * `demo/studio/` (BFC cover copies + standalone Remotion project, both made
 * OUTSIDE the CLI). Deterministic ids (`d001`, `d002`, …) and a fixed clock
 * that advances one minute per id: the same input always produces
 * byte-identical manifests, so the live R2 probe is idempotent and a rerun
 * never uploads the fixture twice.
 *
 * Never renders, never mutates the adopted originals (`bfc/`,
 * `projects/demo/hello/`), never touches the network.
 */
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  createClient,
  createCreativeAsset,
  createCreativeProject,
  createPresetVersion,
  createProjectCheckpoint,
  createStudioContext,
  snapshotAsset,
  type PresetRef,
  type RevisionManifest,
  type StudioContext,
} from '@videomaker/studio';

const CLOCK_BASE = Date.UTC(2026, 8, 30, 0, 0, 0);

export const DEMO_ROOT = path.join(import.meta.dir, '..', 'demo', 'studio');

export interface DemoProjectIds {
  shared: string;
  solo: string;
}

export interface DemoRevisionInfo {
  projectId: string;
  assetId: string;
  revisionId: string;
  rootHash: string;
  manifest: RevisionManifest;
}

export interface DemoWorkspace {
  workspaceDir: string;
  ctx: StudioContext;
  projectIds: DemoProjectIds;
  clientIds: { bfc: string; secondBrand: string };
  presets: { bfcLogoV1: PresetRef; bfcLogoV2: PresetRef; secondBrandV1: PresetRef };
  assets: {
    cover: { assetId: string; r1: DemoRevisionInfo; r2: DemoRevisionInfo };
    video: { assetId: string; r1: DemoRevisionInfo; r2: DemoRevisionInfo };
  };
  checkpoints: { shared: string; solo: string };
}

export async function sha256File(absPath: string): Promise<string> {
  return createHash('sha256').update(await readFile(absPath)).digest('hex');
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic context: sequential ids + clock advancing 1 min per id. */
export function demoContext(workspaceDir: string): StudioContext {
  let seq = 0;
  return createStudioContext(workspaceDir, {
    newId: () => `d${String(++seq).padStart(3, '0')}`,
    clock: () => new Date(CLOCK_BASE + seq * 60_000),
  });
}

async function copyInto(assetDir: string, rel: string, sourceAbs: string): Promise<void> {
  const destination = path.join(assetDir, rel);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(sourceAbs, destination);
}

async function copyTreeInto(assetDir: string, relDir: string, sourceDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const source = path.join(sourceDir, entry.name);
    if (entry.isDirectory()) {
      await copyTreeInto(assetDir, path.join(relDir, entry.name), source);
    } else if (entry.isFile()) {
      await copyInto(assetDir, path.join(relDir, entry.name), source);
    }
  }
}

/** Agent-style direct edit of asset.json (the open-workshop way). */
async function writeAssetJson(
  ctx: StudioContext,
  projectId: string,
  assetId: string,
  doc: Record<string, unknown>,
): Promise<void> {
  const abs = path.join(ctx.workspaceDir, 'projects', projectId, 'assets', assetId, 'asset.json');
  await writeFile(abs, `${JSON.stringify(doc, null, 2)}\n`);
}

async function placePresetResource(
  ctx: StudioContext,
  presetId: string,
  versionId: string,
  rel: string,
  sourceAbs: string,
): Promise<{ path: string; sha256: string; mediaType: string }> {
  const destination = path.join(ctx.workspaceDir, 'presets', presetId, 'versions', versionId, rel);
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(sourceAbs, destination);
  return { path: rel, sha256: await sha256File(destination), mediaType: 'image/png' };
}

function revisionInfo(projectId: string, manifest: RevisionManifest): DemoRevisionInfo {
  return { projectId, assetId: manifest.assetId, revisionId: manifest.revisionId, rootHash: manifest.rootHash, manifest };
}

export interface BuildDemoOptions {
  projectIds: DemoProjectIds;
}

/**
 * Builds the full adoption demo inside `workspaceDir` (must not exist yet):
 * two clients, a shared project (image asset with two revisions: different
 * source/outputs + preset version with a changed logo copy) and a clientless
 * project (video asset: standalone Remotion project + real MP4/cover, second
 * revision changes ONLY the preset), plus one checkpoint per project.
 */
export async function buildDemoWorkspace(workspaceDir: string, options: BuildDemoOptions): Promise<DemoWorkspace> {
  const ctx = demoContext(workspaceDir);
  const bfcDir = path.join(DEMO_ROOT, 'bfc');
  const remotionDir = path.join(DEMO_ROOT, 'remotion-hello');

  await createClient(ctx, { id: 'bfc', name: 'BFC (adopción demo)' });
  await createClient(ctx, { id: 'second-brand', name: 'Marca Secundaria (demo)' });

  const bfcLogoV1Doc = await createPresetVersion(ctx, {
    presetId: 'bfc-logo',
    clientId: 'bfc',
    name: 'BFC logo captura original v1',
    identity: { palette: ['#101418', '#f5f2ea'], tone: 'editorial', rules: ['logo de captura original, no vector oficial'] },
    resources: [await placePresetResource(ctx, 'bfc-logo', 'd001', 'resources/logo.png', path.join(bfcDir, 'logo-bfc-profile.png'))],
  });
  const bfcLogoV2Doc = await createPresetVersion(ctx, {
    presetId: 'bfc-logo',
    clientId: 'bfc',
    name: 'BFC logo demo v2 (logo cambiado en copia demo)',
    identity: { palette: ['#141018', '#eaeaf5'], tone: 'editorial', rules: ['logo original intacto; v2 usa copia demo redimensionada'] },
    resources: [await placePresetResource(ctx, 'bfc-logo', 'd002', 'resources/logo.png', path.join(bfcDir, 'logo-bfc-demo-v2.png'))],
  });
  const secondBrandDoc = await createPresetVersion(ctx, {
    presetId: 'second-brand',
    clientId: 'second-brand',
    name: 'Marca Secundaria mark v1',
    identity: { palette: ['#0b1e14', '#e5f5ea'], tone: 'neutro' },
    resources: [await placePresetResource(ctx, 'second-brand', 'd003', 'resources/mark.png', path.join(remotionDir, 'public', 'media', 'placeholder-art.png'))],
  });

  await createCreativeProject(ctx, { id: options.projectIds.shared, name: 'Showcase compartido (dos clientes)', clientIds: ['bfc', 'second-brand'] });
  await createCreativeProject(ctx, { id: options.projectIds.solo, name: 'Taller sin cliente', clientIds: [] });

  const bfcLogoV1: PresetRef = { presetId: 'bfc-logo', versionId: bfcLogoV1Doc.versionId };
  const bfcLogoV2: PresetRef = { presetId: 'bfc-logo', versionId: bfcLogoV2Doc.versionId };
  const secondBrandV1: PresetRef = { presetId: 'second-brand', versionId: secondBrandDoc.versionId };

  // Image asset (shared project): adopted BFC cover, two revisions.
  const coverAsset = await createCreativeAsset(ctx, {
    id: 'bfc-cover',
    projectId: options.projectIds.shared,
    kind: 'image',
    title: 'Cover BFC feed/story (adopción no destructiva)',
    presetRefs: [bfcLogoV1],
  });
  const coverDir = path.join(ctx.workspaceDir, 'projects', options.projectIds.shared, 'assets', coverAsset.id);
  await copyInto(coverDir, 'sources/cover-v3.html', path.join(bfcDir, 'cover-v3-r1.html'));
  await copyInto(coverDir, 'outputs/feed.png', path.join(bfcDir, 'outputs-r1', 'feed.png'));
  await copyInto(coverDir, 'outputs/story.png', path.join(bfcDir, 'outputs-r1', 'story.png'));
  await writeAssetJson(ctx, options.projectIds.shared, coverAsset.id, {
    schemaVersion: 1,
    id: coverAsset.id,
    projectId: options.projectIds.shared,
    kind: 'image',
    title: coverAsset.title,
    presetRefs: [bfcLogoV1],
    sources: ['sources/cover-v3.html'],
    inputs: [],
    outputs: [
      { name: 'feed', path: 'outputs/feed.png', mediaType: 'image/png', role: 'deliverable', visibility: 'private' },
      { name: 'story', path: 'outputs/story.png', mediaType: 'image/png', role: 'deliverable', visibility: 'private' },
    ],
  });
  const coverR1 = await snapshotAsset(ctx, { projectId: options.projectIds.shared, assetId: coverAsset.id, note: 'r1: cover-v3 original + outputs feed/story producidos fuera de la CLI' });

  // r2: different existing local source + outputs + preset version whose logo
  // changed in the DEMO copy only (the original BFC logo is never touched).
  await copyInto(coverDir, 'sources/cover-v3.html', path.join(bfcDir, 'cover-v3-r2.html'));
  await copyInto(coverDir, 'outputs/feed.png', path.join(bfcDir, 'outputs-r2', 'feed.png'));
  await copyInto(coverDir, 'outputs/story.png', path.join(bfcDir, 'outputs-r2', 'story.png'));
  await writeAssetJson(ctx, options.projectIds.shared, coverAsset.id, {
    schemaVersion: 1,
    id: coverAsset.id,
    projectId: options.projectIds.shared,
    kind: 'image',
    title: coverAsset.title,
    presetRefs: [bfcLogoV2],
    sources: ['sources/cover-v3.html'],
    inputs: [],
    outputs: [
      { name: 'feed', path: 'outputs/feed.png', mediaType: 'image/png', role: 'deliverable', visibility: 'private' },
      { name: 'story', path: 'outputs/story.png', mediaType: 'image/png', role: 'deliverable', visibility: 'private' },
    ],
  });
  const coverR2 = await snapshotAsset(ctx, { projectId: options.projectIds.shared, assetId: coverAsset.id, note: 'r2: fuente/outputs del post 03 + preset v2 con logo cambiado (copia demo)' });

  // Video asset (clientless project): standalone editable Remotion project
  // with its own package.json/lock/src/public + real existing MP4/cover.
  const videoAsset = await createCreativeAsset(ctx, {
    id: 'hello-video',
    projectId: options.projectIds.solo,
    kind: 'video',
    title: 'Hola Remotion (proyecto editable + MP4 existente)',
    presetRefs: [bfcLogoV1],
  });
  const videoDir = path.join(ctx.workspaceDir, 'projects', options.projectIds.solo, 'assets', videoAsset.id);
  await copyTreeInto(videoDir, 'workroom/remotion-hello', remotionDir);
  await writeAssetJson(ctx, options.projectIds.solo, videoAsset.id, {
    schemaVersion: 1,
    id: videoAsset.id,
    projectId: options.projectIds.solo,
    kind: 'video',
    title: videoAsset.title,
    presetRefs: [bfcLogoV1],
    sources: ['workroom/remotion-hello'],
    inputs: [],
    outputs: [
      { name: 'hello', path: 'workroom/remotion-hello/outputs/hello.mp4', mediaType: 'video/mp4', role: 'deliverable', visibility: 'private' },
      { name: 'cover', path: 'workroom/remotion-hello/outputs/cover.png', mediaType: 'image/png', role: 'thumbnail', visibility: 'private' },
    ],
    recipe: {
      argv: ['bun', 'x', 'remotion', 'render', 'Hello'],
      cwd: 'workroom/remotion-hello',
      outputs: ['workroom/remotion-hello/outputs/hello.mp4'],
      toolchain: { versions: { remotion: '4.0.496' }, lockfile: 'workroom/remotion-hello/bun.lock' },
    },
  });
  const videoR1 = await snapshotAsset(ctx, { projectId: options.projectIds.solo, assetId: videoAsset.id, note: 'r1: proyecto Remotion editable + hello.mp4/cover existentes (sin render de CLI)' });

  // r2 changes ONLY the preset version: sources/outputs bytes stay, the seal
  // changes (preset snapshot) and r1 must remain byte-stable.
  await writeAssetJson(ctx, options.projectIds.solo, videoAsset.id, {
    schemaVersion: 1,
    id: videoAsset.id,
    projectId: options.projectIds.solo,
    kind: 'video',
    title: videoAsset.title,
    presetRefs: [secondBrandV1],
    sources: ['workroom/remotion-hello'],
    inputs: [],
    outputs: [
      { name: 'hello', path: 'workroom/remotion-hello/outputs/hello.mp4', mediaType: 'video/mp4', role: 'deliverable', visibility: 'private' },
      { name: 'cover', path: 'workroom/remotion-hello/outputs/cover.png', mediaType: 'image/png', role: 'thumbnail', visibility: 'private' },
    ],
    recipe: {
      argv: ['bun', 'x', 'remotion', 'render', 'Hello'],
      cwd: 'workroom/remotion-hello',
      outputs: ['workroom/remotion-hello/outputs/hello.mp4'],
      toolchain: { versions: { remotion: '4.0.496' }, lockfile: 'workroom/remotion-hello/bun.lock' },
    },
  });
  const videoR2 = await snapshotAsset(ctx, { projectId: options.projectIds.solo, assetId: videoAsset.id, note: 'r2: cambia solo el preset (Marca Secundaria); fuentes/outputs intactos' });

  const sharedCheckpoint = await createProjectCheckpoint(ctx, {
    projectId: options.projectIds.shared,
    entries: [{ assetId: coverAsset.id, revisionId: coverR2.revision.revisionId }],
  });
  const soloCheckpoint = await createProjectCheckpoint(ctx, {
    projectId: options.projectIds.solo,
    entries: [{ assetId: videoAsset.id, revisionId: videoR2.revision.revisionId }],
  });

  return {
    workspaceDir: ctx.workspaceDir,
    ctx,
    projectIds: options.projectIds,
    clientIds: { bfc: 'bfc', secondBrand: 'second-brand' },
    presets: { bfcLogoV1, bfcLogoV2, secondBrandV1 },
    assets: {
      cover: {
        assetId: coverAsset.id,
        r1: revisionInfo(options.projectIds.shared, coverR1.revision),
        r2: revisionInfo(options.projectIds.shared, coverR2.revision),
      },
      video: {
        assetId: videoAsset.id,
        r1: revisionInfo(options.projectIds.solo, videoR1.revision),
        r2: revisionInfo(options.projectIds.solo, videoR2.revision),
      },
    },
    checkpoints: { shared: sharedCheckpoint.checkpointId, solo: soloCheckpoint.checkpointId },
  };
}

/** Non-secret fixture inventory: byte sizes and SHAs of the static demo. */
export async function demoFixtureFacts(): Promise<{ file: string; bytes: number; sha256: string }[]> {
  const facts: { file: string; bytes: number; sha256: string }[] = [];
  const walk = async (rel: string, abs: string): Promise<void> => {
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      const relEntry = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
      const absEntry = path.join(abs, entry.name);
      if (entry.isDirectory()) await walk(relEntry, absEntry);
      else if (entry.isFile()) {
        const info = await stat(absEntry);
        facts.push({ file: `demo/studio/${relEntry}`, bytes: info.size, sha256: await sha256File(absEntry) });
      }
    }
  };
  await walk('', DEMO_ROOT);
  return facts.sort((a, b) => (a.file < b.file ? -1 : 1));
}
