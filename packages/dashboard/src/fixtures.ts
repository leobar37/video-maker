/**
 * Shared fixtures for the dashboard suites (mirrors of the studio
 * test-support helpers, local to this package): a temp workspace with a
 * deterministic context and a realistic sealed fixture covering image, SVG
 * and video assets with two revisions (r1/r2) — the same gallery the UI and
 * the HTTP tests consume. No renderer, no network, no Docker/DB.
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { StudioStorage } from '@videomaker/studio';
import {
  createClient,
  createCreativeAsset,
  createCreativeProject,
  createPresetVersion,
  createStudioContext,
  snapshotAsset,
  type StudioContext,
} from '@videomaker/studio';

import { startDashboardServer } from './server';

const CLOCK_BASE = Date.UTC(2026, 8, 30, 12, 0, 0);

export function makeTestContext(workspaceDir: string): StudioContext {
  let seq = 0;
  return {
    workspaceDir,
    clock: () => new Date(CLOCK_BASE + seq * 60_000),
    newId: () => `t${String(++seq).padStart(3, '0')}`,
  };
}

/** Minimal PNG: real signature (the sniffer and the seal verify leading bytes). */
export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3, 4, 5]);
export const PNG_THUMB_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9, 8, 7, 6, 5]);
export const LOGO_V1_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x4c, 0x4f, 0x47, 0x4f, 0x56, 0x31]);
export const MP4_BYTES = new Uint8Array(new TextEncoder().encode('....ftypisom....').map((byte, index) => (index < 4 ? 0 : byte)));
export const SVG_TEXT = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
export const HTML_TEXT = '<!doctype html><html><body><script>alert("nunca ejecutado")</script></body></html>';
export const DESIGN_HTML = '<!doctype html><html><body><h1>workroom</h1></body></html>';
/** Hostile metadata probe: must never reach the DOM as markup. */
export const HOSTILE_TITLE = '<img src=x onerror=alert(1)>';

export interface DashboardFixture {
  root: string;
  ctx: StudioContext;
  clientId: string;
  presetId: string;
  presetVersionId: string;
  demoProjectId: string;
  soloProjectId: string;
  imageAssetId: string;
  svgAssetId: string;
  videoAssetId: string;
  imageR1: string;
  imageR2: string;
  svgR1: string;
  videoR1: string;
  cleanup: () => Promise<void>;
}

async function writeAssetFile(root: string, projectId: string, assetId: string, rel: string, content: string | Uint8Array): Promise<void> {
  const abs = path.join(root, 'projects', projectId, 'assets', assetId, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

async function writePresetResource(root: string, presetId: string, versionId: string, rel: string, content: string | Uint8Array): Promise<void> {
  const abs = path.join(root, 'presets', presetId, 'versions', versionId, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
}

/** Agent-style direct edit of asset.json (the open workshop way). */
export async function editAssetJson(root: string, projectId: string, assetId: string, mutate: (asset: Record<string, unknown>) => void): Promise<void> {
  const abs = path.join(root, 'projects', projectId, 'assets', assetId, 'asset.json');
  const doc = JSON.parse(await readFile(abs, 'utf8')) as Record<string, unknown>;
  mutate(doc);
  await writeFile(abs, `${JSON.stringify(doc, null, 2)}\n`);
}

/**
 * Full fixture:
 * - client `cliente-uno` + preset `logo-brand` (v1 con logo real);
 * - `proyecto-demo` (cliente-uno): `imagen-portada` r1/r2 (rename cover →
 *   cover-v2 en r2; `cover-alt` declarado y JAMÁS sellado) y `svg-post`
 *   (título hostil XSS, post.svg);
 * - `proyecto-solo` (sin clientes): `spot-video` con mp4 + thumbnail.
 */
export async function makeDashboardFixture(prefix = 'vm-dashboard'): Promise<DashboardFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  const ctx = makeTestContext(root);
  const clientId = 'cliente-uno';
  const presetId = 'logo-brand';

  await createClient(ctx, { id: clientId, name: 'Cliente Uno' });
  const preset = await createPresetVersion(ctx, { presetId, clientId, name: 'Logo Brand' });
  await writePresetResource(root, presetId, preset.versionId, 'resources/logo.png', LOGO_V1_BYTES);

  const demoProjectId = 'proyecto-demo';
  const soloProjectId = 'proyecto-solo';
  await createCreativeProject(ctx, { id: demoProjectId, name: 'Proyecto Demo', clientIds: [clientId] });
  await createCreativeProject(ctx, { id: soloProjectId, name: 'Proyecto Solo', clientIds: [] });

  const imageAssetId = 'imagen-portada';
  const svgAssetId = 'svg-post';
  const videoAssetId = 'spot-video';

  await createCreativeAsset(ctx, { id: imageAssetId, projectId: demoProjectId, kind: 'image', title: 'Imagen Portada', presetRefs: [{ presetId, versionId: preset.versionId }] });
  await writeAssetFile(root, demoProjectId, imageAssetId, 'workroom/design.html', DESIGN_HTML);
  await writeAssetFile(root, demoProjectId, imageAssetId, 'outputs/cover.png', PNG_BYTES);
  await writeAssetFile(root, demoProjectId, imageAssetId, 'outputs/thumb.png', PNG_THUMB_BYTES);
  await writeAssetFile(root, demoProjectId, imageAssetId, 'outputs/slide.html', HTML_TEXT);
  await editAssetJson(root, demoProjectId, imageAssetId, (asset) => {
    asset.outputs = [
      { name: 'cover', path: 'outputs/cover.png', mediaType: 'image/png', role: 'deliverable', visibility: 'private' },
      { name: 'cover-alt', path: 'outputs/cover-alt.png', mediaType: 'image/png', role: 'preview', visibility: 'private' },
      { name: 'thumb', path: 'outputs/thumb.png', mediaType: 'image/png', role: 'thumbnail', visibility: 'private' },
      { name: 'slide', path: 'outputs/slide.html', mediaType: 'text/html', role: 'deliverable', visibility: 'private' },
    ];
  });
  const r1 = await snapshotAsset(ctx, { projectId: demoProjectId, assetId: imageAssetId, note: 'r1 portada' });

  // r2: rename of the deliverable (same bytes, new declared name/path); the
  // working `cover-alt` is STILL absent, so it remains unsealed.
  await rename(path.join(root, 'projects', demoProjectId, 'assets', imageAssetId, 'outputs', 'cover.png'), path.join(root, 'projects', demoProjectId, 'assets', imageAssetId, 'outputs', 'cover-v2.png'));
  await editAssetJson(root, demoProjectId, imageAssetId, (asset) => {
    const outputs = asset.outputs as Array<{ name: string; path: string; mediaType: string; role: string; visibility: string }>;
    asset.outputs = outputs.map((output) => (output.name === 'cover' ? { ...output, name: 'cover-v2', path: 'outputs/cover-v2.png' } : output));
  });
  const r2 = await snapshotAsset(ctx, { projectId: demoProjectId, assetId: imageAssetId, note: 'r2 portada' });

  // Working deletions AFTER both seals: the latest working dir no longer has
  // the r1 output at all (regression guard for revision-scoped production).
  await rm(path.join(root, 'projects', demoProjectId, 'assets', imageAssetId, 'outputs', 'cover-v2.png'), { force: true });
  await rm(path.join(root, 'projects', demoProjectId, 'assets', imageAssetId, 'outputs', 'thumb.png'), { force: true });

  await createCreativeAsset(ctx, { id: svgAssetId, projectId: demoProjectId, kind: 'svg', title: HOSTILE_TITLE, presetRefs: [{ presetId, versionId: preset.versionId }] });
  await writeAssetFile(root, demoProjectId, svgAssetId, 'outputs/post.svg', SVG_TEXT);
  await editAssetJson(root, demoProjectId, svgAssetId, (asset) => {
    asset.outputs = [{ name: 'post.svg', path: 'outputs/post.svg', mediaType: 'image/svg+xml', role: 'deliverable', visibility: 'private' }];
  });
  const svgR1 = await snapshotAsset(ctx, { projectId: demoProjectId, assetId: svgAssetId, note: 'r1 post' });

  await createCreativeAsset(ctx, { id: videoAssetId, projectId: soloProjectId, kind: 'video', title: 'Spot Video' });
  await writeAssetFile(root, soloProjectId, videoAssetId, 'project/package.json', '{\n  "name": "spot-remotion"\n}\n');
  await writeAssetFile(root, soloProjectId, videoAssetId, 'project/src/index.ts', 'export const spot = 1;\n');
  await writeAssetFile(root, soloProjectId, videoAssetId, 'outputs/spot.mp4', MP4_BYTES);
  await writeAssetFile(root, soloProjectId, videoAssetId, 'outputs/spot-thumb.png', PNG_THUMB_BYTES);
  await editAssetJson(root, soloProjectId, videoAssetId, (asset) => {
    asset.outputs = [
      { name: 'spot', path: 'outputs/spot.mp4', mediaType: 'video/mp4', role: 'deliverable', visibility: 'private' },
      { name: 'spot-thumb', path: 'outputs/spot-thumb.png', mediaType: 'image/png', role: 'thumbnail', visibility: 'private' },
    ];
  });
  const videoR1 = await snapshotAsset(ctx, { projectId: soloProjectId, assetId: videoAssetId, note: 'r1 spot' });

  return {
    root,
    ctx,
    clientId,
    presetId,
    presetVersionId: preset.versionId,
    demoProjectId,
    soloProjectId,
    imageAssetId,
    svgAssetId,
    videoAssetId,
    imageR1: r1.revision.revisionId,
    imageR2: r2.revision.revisionId,
    svgR1: svgR1.revision.revisionId,
    videoR1: videoR1.revision.revisionId,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Ephemeral local dashboard server for tests; always stopped by the suite. */
export interface TestServer {
  baseUrl: string;
  port: number;
  stop: () => Promise<void>;
}

export async function startTestDashboard(root: string, options: { storage?: StudioStorage } = {}): Promise<TestServer> {
  const running = await startDashboardServer({ workspaceDir: root, port: 0, ...(options.storage !== undefined ? { storage: options.storage } : {}) });
  return { baseUrl: `http://127.0.0.1:${running.port}`, port: running.port, stop: running.stop };
}
