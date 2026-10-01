import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClient, createCreativeAsset, createCreativeProject, createStudioContext, snapshotAsset } from '@videomaker/studio';

const REPO = resolve(import.meta.dir, '..');
const PROJECT_ID = 'bfc-instagram-demo';
const PIECES = [
  { id: 'post-01', title: 'Empieza hoy', base: 'bfc/covers' },
  { id: 'post-02', title: 'Tu mejor versión empieza hoy', base: 'bfc/posts/02/covers' },
  { id: 'post-03', title: 'Domingos: nuevo horario', base: 'bfc/posts/03/covers' },
];
const sha = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');

/** Copies already-produced files and seals them locally; never renders or uploads. */
export async function prepareInstagramDemo(workspaceDir: string) {
  const ctx = createStudioContext(resolve(workspaceDir));
  const originalPaths = ['bfc/assets/logo-bfc-profile.png', ...PIECES.flatMap(piece => [`${piece.base}/feed.png`, `${piece.base}/cover-v3.html`])];
  const before = await Promise.all(originalPaths.map(async path => ({ path, sha256: await sha(join(REPO, path)) })));
  const projectDir = join(ctx.workspaceDir, 'projects', PROJECT_ID);
  if (existsSync(projectDir)) throw new Error(`El proyecto ${PROJECT_ID} ya existe; no se sobrescribe. Usa el workspace existente o uno nuevo.`);
  if (!existsSync(join(ctx.workspaceDir, 'clients', 'bfc', 'client.json'))) {
    await createClient(ctx, { id: 'bfc', name: 'Body Fitness Cutervo' });
  }
  await createCreativeProject(ctx, { id: PROJECT_ID, name: 'BFC · Propuesta de Instagram', clientIds: ['bfc'] });
  const adopted = [];
  for (const item of [
    ...PIECES.map(piece => ({ id: piece.id, title: piece.title, source: `${piece.base}/cover-v3.html`, output: `${piece.base}/feed.png`, outputName: 'feed', role: 'deliverable' as const })),
    { id: 'profile', title: 'Body Fitness Cutervo', source: 'bfc/assets/logo-bfc-profile.png', output: 'bfc/assets/logo-bfc-profile.png', outputName: 'avatar', role: 'thumbnail' as const },
  ]) {
    const asset = await createCreativeAsset(ctx, { id: item.id, projectId: PROJECT_ID, kind: 'image', title: item.title, presetRefs: [] });
    const dir = join(projectDir, 'assets', asset.id);
    await mkdir(join(dir, 'sources'), { recursive: true });
    await mkdir(join(dir, 'outputs'), { recursive: true });
    const sourceName = item.source.endsWith('.html') ? 'design.html' : 'logo.png';
    await copyFile(join(REPO, item.source), join(dir, 'sources', sourceName));
    await copyFile(join(REPO, item.output), join(dir, 'outputs', `${item.outputName}.png`));
    await writeFile(join(dir, 'asset.json'), JSON.stringify({
      schemaVersion: 1, id: asset.id, projectId: PROJECT_ID, kind: 'image', title: item.title,
      presetRefs: [], sources: [`sources/${sourceName}`], inputs: [],
      outputs: [{ name: item.outputName, path: `outputs/${item.outputName}.png`, mediaType: 'image/png', role: item.role, visibility: 'private' }],
    }, null, 2));
    const sealed = await snapshotAsset(ctx, { projectId: PROJECT_ID, assetId: asset.id, note: 'Propuesta de Instagram: copia exacta de una pieza existente, sin render ni publicación.' });
    const originalSha = await sha(join(REPO, item.output));
    if (await sha(join(dir, 'outputs', `${item.outputName}.png`)) !== originalSha) throw new Error('La copia no coincide con el archivo original');
    adopted.push({ assetId: asset.id, revisionId: sealed.revision.revisionId, outputName: item.outputName, sha256: originalSha });
  }
  for (const original of before) {
    if (await sha(join(REPO, original.path)) !== original.sha256) throw new Error(`Original modificado: ${original.path}`);
  }
  return { projectId: PROJECT_ID, posts: 3, profileAssets: 1, originalsUnchanged: true, adopted };
}

if (import.meta.main) {
  const workspaceDir = process.argv[2];
  if (!workspaceDir) throw new Error('Uso: bun scripts/studio-instagram-demo.ts <workspace-local>');
  console.log(JSON.stringify(await prepareInstagramDemo(workspaceDir), null, 2));
}
