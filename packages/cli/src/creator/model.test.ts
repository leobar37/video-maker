import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject, loadProject, localPath, PresetSchema, DraftSchema, QaSchema, sha256, writeJson } from './model';
import { planPublication } from './qa';
import { FileSpendLedger, spendLedgerPath } from '../pipeline/spend-ledger';
import { buildCreatorSpecs } from '../specs/creator';
import { defaultCreatorDeps } from './workflow';
import { makeTestDeps, makeTestContext } from '../pipeline/test-support';

const PRESET_PATH = new URL('../../../../presets/leobar.json', import.meta.url).pathname;
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'creator-model-'));
  directories.push(root);
  const project = join(root, 'fresh');
  await initProject(project, 'fresh', 'Nuevo video propio', false, PRESET_PATH);
  return { root, project };
}
export const passingQa = (videoSha256: string, coverSha256: string) => QaSchema.parse({
  schemaVersion: 1, videoSha256, coverSha256, width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', audioTracks: 1,
  pixelFormat: 'yuv420p', sampleRate: 48000,
  duration: 10, integratedLufs: -16, truePeakDbtp: -2, decoded: true, coverDecoded: true, coverWidth: 1080, coverHeight: 1920, coverCodec: 'png',
});
async function readyLocal(project: string) {
  const loaded = await loadProject(project);
  const draft = { ...loaded.draft, video: 'renders/final.mp4', cover: 'renders/cover.png', title: 'Título propio', content: 'Contenido nuevo', platformContent: { twitter: 'Texto X' }, syntheticMedia: false };
  await writeFile(join(project, draft.video), 'video');
  await writeFile(join(project, draft.cover), 'cover');
  await writeJson(project, 'publication/draft.json', draft);
  await writeJson(project, 'qa/creator-media.json', passingQa(sha256('video'), sha256('cover')));
  const plan = await planPublication(project, 0);
  await writeJson(project, 'publication/draft.json', { ...draft, approval: { approved: true, digest: plan.digest } });
  return draft;
}

describe('creator local contracts', () => {
  test('preset is valid and init copies EXACT bytes without inherited generation/publication state', async () => {
    const { project } = await fixture();
    const source = await readFile(PRESET_PATH);
    expect(PresetSchema.parse(JSON.parse(source.toString())).publishing.targets).toHaveLength(4);
    expect(await readFile(join(project, 'preset.snapshot.json'))).toEqual(source);
    const { manifest, draft } = await loadProject(project);
    expect(manifest.preset.sha256).toBe(sha256(source));
    expect(draft).toEqual({ schemaVersion: 1, video: '', cover: '', title: '', content: '', platformContent: {}, tags: [], syntheticMedia: null, approval: { approved: false, digest: null } });
    for (const dir of ['originals', 'editing', 'overlays', 'renders', 'qa']) expect(await readdir(join(project, dir))).toEqual([]);
    expect(await readdir(join(project, 'publication'))).toEqual(['draft.json']);
    await expect(initProject(project, 'fresh', 'Again', false, PRESET_PATH)).rejects.toThrow(/already exists/);
  });
  test('init dry-run and all spec plans never resolve env, network, processes, or write', async () => {
    const { root, project } = await fixture();
    const media = makeTestDeps();
    const deps = defaultCreatorDeps(media);
    deps.client = async () => { throw new Error('network touched'); };
    deps.storage = async () => { throw new Error('secrets touched'); };
    const specs = buildCreatorSpecs(deps);
    const before = await readdir(root);
    await initProject(join(root, 'planned'), 'planned', 'Dry', true, PRESET_PATH);
    await specs[0]!.plan(makeTestContext({ project: join(root, 'planned'), preset: PRESET_PATH, id: 'planned', title: 'Dry' }, { cwd: root, mode: 'plan' }));
    expect(await readdir(root)).toEqual(before);
    for (const spec of specs.filter((s) => s.verb !== 'creator-init')) {
      const context = makeTestContext({ project }, { cwd: root, mode: 'plan' });
      const steps = await spec.plan(context);
      expect(steps.length).toBeGreaterThan(0);
    }
    expect(media.calls.fetch).toBe(0);
    expect(media.calls.secrets).toEqual([]);
    expect(media.calls.ffmpeg).toEqual([]);
    expect(await readdir(join(project, 'qa'))).toEqual([]);
  });
  test('rejects traversal, absolute paths, symlinks, and symlinked parent directories', async () => {
    const { root, project } = await fixture();
    for (const path of ['../secret', '/etc/passwd', 'renders/../x', 'renders\\x', 'renders//x']) await expect(localPath(project, path, true)).rejects.toThrow(/Unsafe/);
    await symlink(root, join(project, 'renders', 'escape'));
    await expect(localPath(project, 'renders/escape/a', true)).rejects.toThrow(/Symlink/);
    await symlink(project, join(root, 'alias'));
    await expect(loadProject(join(root, 'alias'))).rejects.toThrow(/Symlink/);
    await expect(initProject(join(root, 'alias', 'new'), 'new', 'No', false, PRESET_PATH)).rejects.toThrow(/Symlink/);
  });
  test('approval binds video, cover, text, targets and synthetic-media decision; QA binds bytes', async () => {
    const { project } = await fixture();
    await readyLocal(project);
    expect((await planPublication(project, 0)).blockers).toEqual([]);
    const loaded = await loadProject(project);
    for (const change of [{ content: 'Changed' }, { platformContent: { twitter: 'Changed' } }, { syntheticMedia: true }, { title: 'Changed' }, { tags: ['changed'] }]) {
      await writeJson(project, 'publication/draft.json', { ...loaded.draft, ...change });
      expect((await planPublication(project, 0)).blockers.join(' ')).toContain('approval');
    }
    await writeJson(project, 'publication/draft.json', loaded.draft);
    await writeFile(join(project, loaded.draft.video), 'changed video');
    expect((await planPublication(project, 0)).blockers.join(' ')).toMatch(/QA hash mismatch/);
    await writeFile(join(project, loaded.draft.video), 'video');
    await writeFile(join(project, loaded.draft.cover), 'changed cover');
    expect((await planPublication(project, 0)).blockers.join(' ')).toMatch(/QA hash mismatch/);
    await writeJson(project, 'publication/draft.json', { ...loaded.draft, platformContent: { twitter: 'x'.repeat(281) } });
    expect((await planPublication(project, 0)).blockers.join(' ')).toContain('twitter: text exceeds 280');
    expect(() => DraftSchema.parse({ ...loaded.draft, syntheticMedia: undefined })).toThrow();
    await writeJson(project, 'publication/draft.json', loaded.draft);
    await writeFile(join(project, loaded.draft.cover), 'cover');
    const changedPreset = { ...loaded.preset, publishing: { ...loaded.preset.publishing, targets: loaded.preset.publishing.targets.map((target, index) => index === 0 ? { ...target, accountId: 'replacement-account' } : target) } };
    const bytes = JSON.stringify(changedPreset);
    await writeFile(join(project, 'preset.snapshot.json'), bytes);
    await writeJson(project, 'creator-project.json', { ...loaded.manifest, preset: { ...loaded.manifest.preset, sha256: sha256(bytes) } });
    expect((await planPublication(project, 0)).blockers.join(' ')).toContain('approval');
  });
  test('cap and unresolved paid attempts block offline without provider calls', async () => {
    const { project } = await fixture();
    await readyLocal(project);
    expect((await planPublication(project, undefined)).blockers.join(' ')).toContain('--spend-cap');
    await new FileSpendLedger(spendLedgerPath(project)).append({ schemaVersion: 1, attemptId: 'attempt-1', planDigest: 'b'.repeat(64), command: 'gen-media', subject: 'gen-media:scene:abc', state: 'uncertain', reservedUsd: 0.5, createdAt: '2026-01-01T00:00:00.000Z' });
    expect((await planPublication(project, 0)).blockers.join(' ')).toContain('paid attempts');
  });
  test('preset rejects unsupported platform options instead of forwarding raw data', async () => {
    const { project } = await fixture();
    const { preset } = await loadProject(project);
    expect(() => PresetSchema.parse({ ...preset, publishing: { ...preset.publishing, targets: [{ platform: 'facebook', accountId: 'fb', username: 'other', options: { unvalidated: true } }] } })).toThrow();
    expect(() => PresetSchema.parse({ ...preset, publishing: { ...preset.publishing, targets: [{ platform: 'unknown-network', accountId: 'other', username: 'other' }] } })).toThrow();
  });
  test('snapshot tampering and invalid QA fail closed', async () => {
    const { project } = await fixture();
    await readyLocal(project);
    await writeJson(project, 'qa/creator-media.json', { ...passingQa(sha256('video'), sha256('cover')), pixelFormat: 'yuv444p', sampleRate: 44100 });
    const policy = (await planPublication(project, 0)).blockers.join(' ');
    expect(policy).toContain('pixel format');
    expect(policy).toContain('sample rate');
    await writeJson(project, 'qa/creator-media.json', { ...passingQa(sha256('video'), sha256('cover')), decoded: false });
    expect((await planPublication(project, 0)).blockers.join(' ')).toContain('Missing/invalid QA');
    await writeFile(join(project, 'preset.snapshot.json'), '{}');
    await expect(loadProject(project)).rejects.toThrow();
  });
});
