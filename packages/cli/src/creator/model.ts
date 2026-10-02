import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import {
  CreatorPresetSchema as PresetSchema, CreatorDraftSchema as DraftSchema,
  CreatorProjectSchema as ProjectSchema, CreatorQaSchema as QaSchema,
  type CreatorPreset as Preset, type CreatorDraft as Draft,
  type CreatorProject as Project, type CreatorMediaQa as MediaQa,
} from '@videomaker/schemas';
export { PresetSchema, DraftSchema, ProjectSchema, QaSchema };
export type { Preset, Draft, MediaQa };

export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');

/** Reject symlinks in every existing component, including the project and its parents. */
export async function noSymlinks(path: string, allowMissing = false): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split('/').filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`Symlink refused: ${cursor}`);
    } catch (error) {
      if (allowMissing && error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
}
export async function localPath(project: string, relative: string, allowMissing = false): Promise<string> {
  if (!relative || isAbsolute(relative) || relative.includes('\\') || relative.split('/').some((part) => !part || part === '.' || part === '..') || relative.includes('\0')) {
    throw new Error(`Unsafe project-relative path: ${relative}`);
  }
  const path = join(resolve(project), relative);
  await noSymlinks(path, allowMissing);
  return path;
}
export async function readJson(project: string, relative: string): Promise<unknown> {
  return JSON.parse(await readFile(await localPath(project, relative), 'utf8'));
}
export async function writeJson(project: string, relative: string, value: unknown): Promise<void> {
  const path = await localPath(project, relative, true);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
export async function loadIdentity(project: string) {
  const manifest = ProjectSchema.parse(await readJson(project, 'creator-project.json'));
  const bytes = await readFile(await localPath(project, 'preset.snapshot.json'));
  const preset = PresetSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (sha256(bytes) !== manifest.preset.sha256 || preset.version !== manifest.preset.version || preset.id !== manifest.preset.id) throw new Error('Preset snapshot hash/id/version mismatch');
  return { manifest, preset };
}
export async function loadProject(project: string) {
  const { manifest, preset } = await loadIdentity(project);
  const draft = DraftSchema.parse(await readJson(project, 'publication/draft.json'));
  return { manifest, preset, draft };
}
export function approvalDigest(project: Project, preset: Preset, draft: Draft, videoHash: string, coverHash: string): string {
  const { approval: _approval, ...content } = draft;
  return sha256(JSON.stringify({ project, content, videoHash, coverHash, publishing: preset.publishing }));
}
export async function initProject(project: string, id: string, title: string, dryRun: boolean, presetPath: string) {
  await noSymlinks(project, true);
  try { await lstat(project); throw new Error('Project directory already exists; refusing overwrite'); }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const bytes = await readFile(presetPath);
  const preset = PresetSchema.parse(JSON.parse(bytes.toString('utf8')));
  const manifest = ProjectSchema.parse({ schemaVersion: 1, id, title, preset: { id: preset.id, version: preset.version, sha256: sha256(bytes) } });
  const draft: Draft = { schemaVersion: 1, video: '', cover: '', title: '', content: '', platformContent: {}, tags: [], syntheticMedia: null, approval: { approved: false, digest: null } };
  if (!dryRun) {
    await mkdir(dirname(resolve(project)), { recursive: true });
    await mkdir(project); // Exclusive directory creation, no merge into an existing project.
    for (const dir of ['originals', 'editing', 'overlays', 'renders', 'qa', 'publication']) await mkdir(join(project, dir));
    await writeFile(join(project, 'preset.snapshot.json'), bytes, { flag: 'wx' });
    await writeJson(project, 'creator-project.json', manifest);
    await writeJson(project, 'publication/draft.json', draft);
  }
  return manifest;
}
