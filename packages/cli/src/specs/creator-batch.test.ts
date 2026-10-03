import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePublicationJournal, ZernioClient, ZernioPublisher, type ObjectMeta, type ObjectStore } from '@videomaker/providers';
import { CreatorBatchManifestSchema, CreatorBatchProgressSchema } from '@videomaker/schemas';
import { allSpecs } from '../all-specs';
import { runSpecs } from '../runtime';
import type { CommandSpec } from '../spec-types';
import { initProject, loadProject, PresetSchema, QaSchema, sha256, writeJson } from '../creator/model';
import { planPublication } from '../creator/qa';
import type { CreatorDeps } from '../creator/workflow';
import { makeTestContext, makeTestDeps } from '../pipeline/test-support';
import { buildCreatorBatchSpecs, creatorBatchSpecs } from './creator-batch';

const VERBS = ['creator-batch-plan', 'creator-batch-publish', 'creator-batch-status', 'creator-batch-resume', 'creator-batch-reconcile'];
const MUTATIONS = ['creator-batch-publish', 'creator-batch-resume', 'creator-batch-reconcile'];
const PRESET_PATH = new URL('../../../../presets/leobar.json', import.meta.url).pathname;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function byVerb(specs: CommandSpec[], verb: string): CommandSpec {
  const spec = specs.find(entry => entry.verb === verb);
  if (!spec) throw new Error(`Missing spec ${verb}`);
  return spec;
}

/** Include directory names and exact file bytes so even hidden audit writes are detected. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const bytes: Record<string, string> = {};
  async function visit(relative: string): Promise<void> {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { bytes[`${path}/`] = ''; await visit(path); }
      else bytes[path] = (await readFile(join(root, path))).toString('base64');
    }
  }
  await visit('');
  return bytes;
}

interface Controls { state?: 'pending' | 'published'; rejected?: boolean; uncertain?: boolean; transportFailure?: boolean }
async function fixture(controls: Controls = {}) {
  const root = await mkdtemp(join(tmpdir(), 'creator-batch-spec-'));
  roots.push(root);
  const baseline = PresetSchema.parse(JSON.parse(await readFile(PRESET_PATH, 'utf8')));
  const selected = baseline.publishing.targets.find(target => target.platform !== 'tiktok');
  if (!selected) throw new Error('Fixture requires a supported non-TikTok preset destination');
  const presetPath = join(root, 'client.json');
  const fixturePreset = PresetSchema.parse({ ...baseline, publishing: { ...baseline.publishing, targets: [selected] } });
  await writeFile(presetPath, JSON.stringify(fixturePreset));
  const project = join(root, 'video');
  await initProject(project, 'batch-video', 'Batch video', false, presetPath);
  const { manifest, preset, draft } = await loadProject(project);
  const truePeakDbtp = Math.min(-2, preset.editing.audio.maxTruePeakDbtp);
  const edited = { ...draft, video: 'renders/final.mp4', cover: 'renders/cover.png', title: 'Original title', content: 'Original publication text', platformContent: {}, syntheticMedia: false };
  await writeFile(join(project, edited.video), 'approved final bytes');
  await writeFile(join(project, edited.cover), 'approved cover bytes');
  await writeJson(project, 'publication/draft.json', edited);
  const hashes = { videoSha256: sha256(await readFile(join(project, edited.video))), coverSha256: sha256(await readFile(join(project, edited.cover))) };
  await writeJson(project, 'qa/creator-media.json', QaSchema.parse({
    schemaVersion: 1, ...hashes, width: preset.editing.width, height: preset.editing.height, fps: preset.editing.fps,
    videoCodec: preset.editing.render.videoCodec, audioCodec: preset.editing.render.audioCodec, audioTracks: preset.editing.audio.tracks,
    pixelFormat: preset.editing.render.pixelFormat, sampleRate: preset.editing.render.sampleRate,
    duration: 10, integratedLufs: preset.editing.audio.targetLufs, truePeakDbtp,
    decoded: true, coverDecoded: true, coverWidth: preset.editing.width, coverHeight: preset.editing.height, coverCodec: 'png',
  }));
  const approval = await planPublication(project, 0);
  if (!approval.digest) throw new Error('Fixture approval digest unavailable');
  await writeJson(project, 'publication/draft.json', { ...edited, approval: { approved: true, digest: approval.digest } });
  const batch = CreatorBatchManifestSchema.parse({
    schemaVersion: 1, batchId: 'batch-spec', queuePolicy: 'allow-provider-queue',
    projects: [{ projectPath: 'video', projectId: manifest.id, preset: manifest.preset, approval: { approved: true, digest: approval.digest }, media: hashes, targets: [{ platform: selected.platform, accountId: selected.accountId, username: selected.username }] }],
  });
  await writeFile(join(root, 'batch.json'), JSON.stringify(batch));

  const calls: Array<{ method: string; path: string }> = [];
  let clientCalls = 0;
  let storageCalls = 0;
  let processCalls = 0;
  let puts = 0;
  const posts = new Map<string, { _id: string; idempotencyKey: string; profileId: string; platforms: Array<{ platform: string; accountId: string; status: string; platformPostUrl: string }> }>();
  const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^.*\/v1/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path });
    if (controls.transportFailure) throw new Error('secret-provider-key-must-not-leak');
    let payload: unknown;
    let status = 200;
    if (path === '/profiles') payload = { profiles: [{ _id: preset.publishing.profile.id, name: preset.publishing.profile.name }] };
    else if (path === '/accounts') payload = { accounts: [{ _id: selected.accountId, platform: selected.platform, username: selected.username }] };
    else if (path === '/accounts/health') payload = { accounts: [{ accountId: selected.accountId, status: 'healthy', canPost: true }] };
    else if (path === '/posts' && method === 'POST') {
      const key = new Headers(init?.headers).get('idempotency-key');
      if (!key) throw new Error('Missing submit-once key');
      if (controls.uncertain) throw new Error('secret-submit-key-must-not-leak');
      if (controls.rejected) { status = 400; payload = { error: 'secret-rejection-detail-must-not-leak' }; }
      else {
        const post = { _id: `remote-${selected.platform}`, idempotencyKey: key, profileId: preset.publishing.profile.id, platforms: [{ platform: selected.platform, accountId: selected.accountId, status: controls.state ?? 'pending', platformPostUrl: 'https://social.example/approved-post' }] };
        posts.set(key, post);
        status = 201;
        payload = { post };
      }
    } else if (path === '/posts') {
      const all = [...posts.values()];
      const offset = Number(url.searchParams.get('offset') ?? 0);
      payload = { posts: all.slice(offset, offset + 100), pagination: { page: offset / 100 + 1, limit: 100, total: all.length, pages: Math.max(1, Math.ceil(all.length / 100)) } };
    } else if (path.startsWith('/posts/')) {
      const post = [...posts.values()].find(post => post._id === decodeURIComponent(path.slice(7)));
      payload = { post: post && { ...post, platforms: post.platforms.map(target => ({ ...target, status: controls.state ?? target.status })) } };
    } else throw new Error(`Unexpected fixture request ${method} ${path}`);
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }, { preconnect: () => {} });
  const client = new ZernioClient({ apiKey: 'fixture-key', fetchImpl, maxAttempts: 1 });
  const media = makeTestDeps();
  media.fetchImpl = fetchImpl;
  media.publisher = async journalPath => new ZernioPublisher(client, { journal: new FilePublicationJournal(journalPath) });
  media.process = { async run(command, args) {
    processCalls++;
    if (command !== 'ffprobe') return { code: 0, stdout: '', stderr: '' };
    const cover = args.at(-1)?.endsWith('.png');
    return { code: 0, stderr: '', stdout: JSON.stringify({ streams: cover
      ? [{ codec_type: 'video', codec_name: 'png', width: preset.editing.width, height: preset.editing.height }]
      : [{ codec_type: 'video', codec_name: preset.editing.render.videoCodec, width: preset.editing.width, height: preset.editing.height, avg_frame_rate: `${preset.editing.fps}/1`, pix_fmt: preset.editing.render.pixelFormat }, ...Array.from({ length: preset.editing.audio.tracks }, () => ({ codec_type: 'audio', codec_name: preset.editing.render.audioCodec, sample_rate: String(preset.editing.render.sampleRate) }))], format: { duration: '10' } }) };
  } };
  media.ffmpeg = { async run() {
    media.calls.ffmpeg.push([]);
    return { exitCode: 0, stdout: '', stderr: `Summary:\n Integrated loudness:\n I: ${preset.editing.audio.targetLufs} LUFS\n Loudness range:\n LRA: 3.0 LU\n True peak:\n Peak: ${truePeakDbtp} dBFS\n` };
  } };
  const objects = new Map<string, { bytes: Uint8Array; meta: ObjectMeta }>();
  const store: ObjectStore = {
    async head(key) { return objects.get(key)?.meta ?? null; },
    async put(key, bytes, options) {
      puts++;
      const meta = { key, bytes: bytes.length, sha256: sha256(bytes), contentType: options.contentType, publicUrl: `https://cdn.example/${key}` };
      objects.set(key, { bytes, meta });
      return meta;
    },
    async get(key) { const object = objects.get(key); if (!object) throw new Error('Missing fixture object'); return object.bytes; },
    async inspect(key) { const object = objects.get(key); if (!object) throw new Error('Missing fixture object'); return object.meta; },
  };
  const deps: CreatorDeps = { media, client: async () => { clientCalls++; return client; }, storage: async () => { storageCalls++; return store; } };
  return { root, project, deps, media, calls, controls, counts: () => ({ clientCalls, storageCalls, processCalls, puts }) };
}

async function invoke(root: string, deps: CreatorDeps | undefined, verb: string, flags: string[] = []) {
  const lines: string[] = [];
  const exitCode = await runSpecs(buildCreatorBatchSpecs(deps), [verb, '--batch', 'batch.json', ...flags], { cwd: root, out: line => { lines.push(line); } });
  return { exitCode, lines };
}

describe('official creator batch CLI specs', () => {
  test('registry exposes the five exact names once and preserves selection registration', () => {
    expect(creatorBatchSpecs.map(spec => spec.verb)).toEqual(VERBS);
    for (const verb of VERBS) expect(allSpecs().filter(spec => spec.verb === verb)).toHaveLength(1);
    expect(allSpecs().filter(spec => spec.verb === 'clips-select')).toHaveLength(1);
    for (const spec of creatorBatchSpecs) {
      expect(spec.supportsPlan).toBe(true);
      expect(spec.args.find(arg => arg.name === 'batch')).toMatchObject({ kind: 'string', required: true });
      expect(spec.summary).not.toContain('pending is published');
    }
    for (const verb of ['creator-batch-publish', 'creator-batch-resume']) {
      const spec = byVerb(creatorBatchSpecs, verb);
      expect(spec.paid).toBe(true);
      expect(spec.movesGates).toEqual(['publish']);
      expect(spec.writes).toContain('publication/intents/*');
    }
    for (const verb of ['creator-batch-plan', 'creator-batch-status']) {
      expect(byVerb(creatorBatchSpecs, verb).writes).toEqual([]);
      expect(byVerb(creatorBatchSpecs, verb).movesGates).toEqual([]);
      expect(byVerb(creatorBatchSpecs, verb).paid).not.toBe(true);
    }
    const reconcile = byVerb(creatorBatchSpecs, 'creator-batch-reconcile');
    expect(reconcile.writes).toEqual(['publication/reconciliations.jsonl', 'publication/intents/*.result.json', 'qa/publication/zernio-journal.jsonl']);
    expect(reconcile.movesGates).toEqual([]);
    expect(reconcile.paid).not.toBe(true);
    for (const verb of MUTATIONS) {
      const spec = byVerb(creatorBatchSpecs, verb);
      expect(spec.args.find(arg => arg.name === 'confirm')?.kind).toBe('boolean');
      expect(spec.args.find(arg => arg.name === 'spend-cap')).toMatchObject({ kind: 'number' });
      expect(spec.args.find(arg => arg.name === 'spend-cap')?.default).toBeUndefined();
    }
  });

  test('help follows declarative conventions and required batch flags are enforced', async () => {
    for (const verb of VERBS) {
      const lines: string[] = [];
      expect(await runSpecs(creatorBatchSpecs, [verb, '--help'], { cwd: '.', out: line => { lines.push(line); } })).toBe(0);
      expect(lines.join('\n')).toContain('--batch');
      expect(lines.join('\n')).toContain('Writes:');
      expect(lines.join('\n')).toContain('Gates:');
      expect(await runSpecs(creatorBatchSpecs, [verb], { cwd: '.', out: () => {} })).toBe(2);
      await expect(Promise.resolve(byVerb(creatorBatchSpecs, verb).run(makeTestContext({}, { mode: 'plan' })))).rejects.toThrow('Refusing side effects in plan mode');
      await expect(Promise.resolve(byVerb(creatorBatchSpecs, verb).plan(makeTestContext({ batch: ' ' }, { mode: 'plan' })))).rejects.toThrow('--batch is required');
    }
  });

  test('every dry-run is byte-identical and calls no fetch, secrets, storage, clients, or processes', async () => {
    const f = await fixture();
    const before = await snapshot(f.root);
    for (const verb of VERBS) {
      for (const flag of ['--dry-run', '--plan']) {
        const result = await invoke(f.root, f.deps, verb, [flag]);
        expect(result.exitCode).toBe(0);
        expect(result.lines.join('\n')).toContain('remote NOT CHECKED');
        expect(result.lines.join('\n')).toContain('no writes, network, secrets, storage, processes, or generation');
        expect(await snapshot(f.root)).toEqual(before);
      }
      expect((await invoke(f.root, undefined, verb, ['--dry-run'])).exitCode).toBe(0);
    }
    const localPlan = await invoke(f.root, f.deps, 'creator-batch-plan');
    expect(localPlan.exitCode).toBe(0);
    expect(CreatorBatchProgressSchema.parse(JSON.parse(localPlan.lines.join('\n'))).complete).toBe(false);
    expect(await snapshot(f.root)).toEqual(before);
    expect(f.calls).toEqual([]);
    expect(f.counts()).toEqual({ clientCalls: 0, storageCalls: 0, processCalls: 0, puts: 0 });
    expect(f.media.calls.secrets).toEqual([]);
    expect(f.media.calls.ffmpeg).toEqual([]);
    expect(f.media.calls.submits).toEqual([]);
  });

  test('reconcile never submits unstarted targets or manufactures a local receipt', async () => {
    const f = await fixture();
    const before = await snapshot(f.root);
    const result = await invoke(f.root, f.deps, 'creator-batch-reconcile', ['--confirm', '--spend-cap', '0']);
    expect(result.exitCode).toBe(0);
    const progress = CreatorBatchProgressSchema.parse(JSON.parse(result.lines.join('\n')));
    expect(progress.summary.notStarted).toBe(1);
    expect(progress.complete).toBe(false);
    expect(await snapshot(f.root)).toEqual(before);
    expect(f.calls).toEqual([]);
    expect(f.counts()).toEqual({ clientCalls: 0, storageCalls: 0, processCalls: 0, puts: 0 });
  });

  test('confirmation and exactly-zero explicit caps fail before any effects', async () => {
    const f = await fixture();
    const before = await snapshot(f.root);
    for (const verb of MUTATIONS) {
      for (const flags of [[], ['--spend-cap', '0'], ['--confirm'], ['--confirm', '--spend-cap', '-1'], ['--confirm', '--spend-cap', '1']]) {
        const result = await invoke(f.root, f.deps, verb, flags);
        expect(result.exitCode).toBe(2);
        expect(result.lines.join('\n')).toMatch(/--confirm|--spend-cap/);
      }
      for (const cap of [NaN, Infinity]) {
        await expect(Promise.resolve(byVerb(buildCreatorBatchSpecs(f.deps), verb).run(makeTestContext({ batch: 'batch.json', confirm: true, 'spend-cap': cap }, { cwd: f.root })))).rejects.toThrow('--spend-cap 0');
      }
    }
    expect(await snapshot(f.root)).toEqual(before);
    expect(f.calls).toEqual([]);
    expect(f.counts()).toEqual({ clientCalls: 0, storageCalls: 0, processCalls: 0, puts: 0 });
    expect(f.media.calls.secrets).toEqual([]);
  });

  test('publish queue acceptance is success but pending is independent of published and complete=false', async () => {
    const f = await fixture({ state: 'pending' });
    const result = await invoke(f.root, f.deps, 'creator-batch-publish', ['--confirm', '--spend-cap', '0']);
    expect(result.exitCode).toBe(0);
    const progress = CreatorBatchProgressSchema.parse(JSON.parse(result.lines.join('\n')));
    expect(progress.summary).toEqual({ total: 1, published: 0, pending: 1, notStarted: 0, uncertain: 0, failed: 0, blocked: 0 });
    expect(progress.complete).toBe(false);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(f.media.calls.submits).toEqual([]);
    const postsBefore = f.calls.filter(call => call.method === 'POST').length;
    const resumed = await invoke(f.root, f.deps, 'creator-batch-resume', ['--confirm', '--spend-cap', '0']);
    expect(resumed.exitCode).toBe(0);
    expect(CreatorBatchProgressSchema.parse(JSON.parse(resumed.lines.join('\n'))).summary.pending).toBe(1);
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(postsBefore);
  });

  test('status is GET-only and changes no bytes or storage/processes even when remote state advances', async () => {
    const f = await fixture({ state: 'pending' });
    expect((await invoke(f.root, f.deps, 'creator-batch-publish', ['--confirm', '--spend-cap', '0'])).exitCode).toBe(0);
    f.controls.state = 'published';
    const before = await snapshot(f.root);
    const counts = f.counts();
    const callOffset = f.calls.length;
    const ffmpegCalls = f.media.calls.ffmpeg.length;
    const result = await invoke(f.root, f.deps, 'creator-batch-status');
    expect(result.exitCode).toBe(0);
    const progress = CreatorBatchProgressSchema.parse(JSON.parse(result.lines.join('\n')));
    expect(progress.summary.published).toBe(1);
    expect(progress.summary.pending).toBe(0);
    expect(progress.complete).toBe(true);
    expect(f.calls.slice(callOffset).length).toBeGreaterThan(0);
    expect(f.calls.slice(callOffset).every(call => call.method === 'GET')).toBe(true);
    expect(await snapshot(f.root)).toEqual(before);
    expect(f.counts()).toMatchObject({ storageCalls: counts.storageCalls, processCalls: counts.processCalls, puts: counts.puts });
    expect(f.media.calls.ffmpeg).toHaveLength(ffmpegCalls);
    expect(f.media.calls.secrets).toEqual([]);
  });

  test('reconcile performs GET plus local audit only and preserves approved media/snapshot/draft', async () => {
    const f = await fixture({ state: 'pending' });
    expect((await invoke(f.root, f.deps, 'creator-batch-publish', ['--confirm', '--spend-cap', '0'])).exitCode).toBe(0);
    f.controls.state = 'published';
    const before = await snapshot(f.root);
    const counts = f.counts();
    const callOffset = f.calls.length;
    const ffmpegCalls = f.media.calls.ffmpeg.length;
    const result = await invoke(f.root, f.deps, 'creator-batch-reconcile', ['--confirm', '--spend-cap', '0']);
    expect(result.exitCode).toBe(0);
    expect(CreatorBatchProgressSchema.parse(JSON.parse(result.lines.join('\n'))).complete).toBe(true);
    expect(f.calls.slice(callOffset).length).toBeGreaterThan(0);
    expect(f.calls.slice(callOffset).every(call => call.method === 'GET')).toBe(true);
    const after = await snapshot(f.root);
    expect(after).not.toEqual(before);
    expect(after['video/publication/reconciliations.jsonl']).toBeDefined();
    for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[path] === after[path]) continue;
      expect(path === 'video/publication/reconciliations.jsonl'
        || /^video\/publication\/intents\/[a-f0-9]{64}\.result\.json$/.test(path)
        || path === 'video/qa/publication/zernio-journal.jsonl').toBe(true);
    }
    expect(after['video/preset.snapshot.json']).toBe(before['video/preset.snapshot.json']);
    expect(after['video/publication/draft.json']).toBe(before['video/publication/draft.json']);
    expect(after['video/renders/final.mp4']).toBe(before['video/renders/final.mp4']);
    expect(after['video/renders/cover.png']).toBe(before['video/renders/cover.png']);
    expect(f.counts()).toMatchObject({ storageCalls: counts.storageCalls, processCalls: counts.processCalls, puts: counts.puts });
    expect(f.media.calls.ffmpeg).toHaveLength(ffmpegCalls);
    expect(f.media.calls.secrets).toEqual([]);
  });

  test('blocked, failed and uncertain runs exit nonzero without leaking provider details', async () => {
    const blocked = await fixture();
    const current = await loadProject(blocked.project);
    await writeJson(blocked.project, 'publication/draft.json', { ...current.draft, approval: { approved: false, digest: null } });
    const blockedResult = await invoke(blocked.root, blocked.deps, 'creator-batch-publish', ['--confirm', '--spend-cap', '0']);
    expect(blockedResult.exitCode).toBe(1);
    expect(CreatorBatchProgressSchema.parse(JSON.parse(blockedResult.lines.join('\n'))).summary.blocked).toBe(1);
    expect(blocked.calls).toEqual([]);
    for (const controls of [{ rejected: true }, { uncertain: true }]) {
      const f = await fixture(controls);
      const result = await invoke(f.root, f.deps, 'creator-batch-publish', ['--confirm', '--spend-cap', '0']);
      expect(result.exitCode).toBe(1);
      const progress = CreatorBatchProgressSchema.parse(JSON.parse(result.lines.join('\n')));
      expect(progress.summary.failed + progress.summary.uncertain).toBe(1);
      expect(progress.complete).toBe(false);
      expect(result.lines.join('\n')).not.toContain('secret-');
    }
  });

  test('invalid manifests and transport errors have deterministic nonsensitive diagnostics', async () => {
    const f = await fixture();
    await writeFile(join(f.root, 'batch.json'), '{"secret-fixture-token":');
    for (const verb of VERBS) {
      const first = await invoke(f.root, f.deps, verb, MUTATIONS.includes(verb) ? ['--confirm', '--spend-cap', '0'] : []);
      const second = await invoke(f.root, f.deps, verb, MUTATIONS.includes(verb) ? ['--confirm', '--spend-cap', '0'] : []);
      expect(first.exitCode).toBe(1);
      expect(second.lines).toEqual(first.lines);
      expect(first.lines.join('\n')).not.toContain('secret-fixture-token');
    }
    expect(f.calls).toEqual([]);
    const transport = await fixture({ state: 'pending' });
    expect((await invoke(transport.root, transport.deps, 'creator-batch-publish', ['--confirm', '--spend-cap', '0'])).exitCode).toBe(0);
    transport.controls.transportFailure = true;
    const result = await invoke(transport.root, transport.deps, 'creator-batch-status');
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).not.toContain('secret-provider-key');
  });
});
