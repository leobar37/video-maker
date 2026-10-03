import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePublicationJournal, ZernioClient, ZernioPublisher, type ObjectMeta, type ObjectStore, type Publisher } from '@videomaker/providers';
import { CreatorBatchManifestSchema, CreatorBatchProgressSchema, CreatorIntentSchema, type CreatorBatchManifest, type CreatorBatchProject, type CreatorBatchCapacityObservation, type CreatorBatchTarget, type CreatorIntent } from '@videomaker/schemas';
import { makeTestDeps } from '../pipeline/test-support';
import { FileSpendLedger, spendLedgerPath } from '../pipeline/spend-ledger';
import { initProject, loadProject, PresetSchema, sha256, writeJson } from './model';
import { planPublication, runCreatorQa } from './qa';
import { type CreatorDeps } from './workflow';
import { loadCreatorBatch, planCreatorBatch, publishCreatorBatch, reconcileCreatorBatch, resumeCreatorBatch, statusCreatorBatch } from './batch';
import { type CreatorCapacitySource } from './preflight';

const PRESET_PATH = new URL('../../../../presets/leobar.json', import.meta.url).pathname;
const roots: string[] = [];
const options = { confirm: true, spendCap: 0 };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

interface Controls {
  pending?: boolean;
  pendingLastTwo?: boolean;
  rejectPlatform?: string;
  uncertainPlatform?: string;
  uncertainMessage?: string;
  profileStatus?: number;
  failStatus?: boolean;
  beforePost?: (intent: CreatorIntent, project: string) => Promise<void>;
  beforeValidate?: (project: string) => Promise<void>;
  beforeStorage?: () => Promise<void>;
  unhealthyAccount?: string;
  wrongAccount?: string;
  canPostMore?: boolean;
  creatorStatus?: number;
  remoteFailure?: unknown;
}
interface RemotePost {
  _id: string;
  idempotencyKey: string;
  profileId: string;
  platforms: Array<{ platform: string; accountId: string; status: string; platformPostUrl: string }>;
}
interface WireCall { method: string; path: string; key?: string; body?: Record<string, unknown> }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
  return Object.fromEntries(Object.entries(value));
}

async function fixture(count = 1, controls: Controls = {}) {
  const root = await mkdtemp(join(tmpdir(), 'creator-batch-'));
  roots.push(root);
  const original = PresetSchema.parse(JSON.parse(await readFile(PRESET_PATH, 'utf8')));
  const preset = PresetSchema.parse({ ...original, publishing: { ...original.publishing, targets: original.publishing.targets.filter((target) => target.platform !== 'twitter') } });
  const presetPath = join(root, 'approved-preset.json');
  await writeFile(presetPath, JSON.stringify(preset));
  const paths: string[] = [];
  const entries: CreatorBatchProject[] = [];
  const keyProjects = new Map<string, string>();
  const posts = new Map<string, RemotePost>();
  const calls: WireCall[] = [];
  const submitted: CreatorIntent[] = [];
  const objects = new Map<string, { bytes: Uint8Array; meta: ObjectMeta }>();
  let puts = 0;
  let clients = 0;
  let stores = 0;
  let processes = 0;
  const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^.*\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? record(JSON.parse(init.body)) : undefined;
    const key = new Headers(init?.headers).get('idempotency-key') ?? undefined;
    calls.push({ method, path: `${path}${url.search}`, ...(key ? { key } : {}), ...(body ? { body } : {}) });
    if (method === 'GET' && path.startsWith('/posts') && controls.failStatus) throw new Error('secret-status-key-must-not-leak');
    if (path === '/profiles' && controls.remoteFailure) throw controls.remoteFailure;
    let answer: unknown;
    let status = 200;
    if (path === '/profiles') {
      status = controls.profileStatus ?? 200;
      answer = { profiles: [{ _id: preset.publishing.profile.id, name: preset.publishing.profile.name }] };
    } else if (path === '/accounts') answer = { accounts: preset.publishing.targets.map((target) => ({ _id: target.accountId === controls.wrongAccount ? 'wrong-identity' : target.accountId, platform: target.platform, username: target.username })) };
    else if (path === '/accounts/health') answer = { accounts: preset.publishing.targets.map((target) => ({ accountId: target.accountId, status: target.accountId === controls.unhealthyAccount ? 'expired' : 'healthy', canPost: target.accountId !== controls.unhealthyAccount })) };
    else if (path.endsWith('/tiktok/creator-info')) {
      status = controls.creatorStatus ?? 200;
      answer = {
        creator: { nickname: 'creator', avatarUrl: 'https://cdn.example/avatar.png', isVerified: false, canPostMore: controls.canPostMore !== false },
        privacyLevels: [{ value: 'PUBLIC_TO_EVERYONE', label: 'Everyone' }],
        postingLimits: { maxVideoDurationSec: 600, interactionSettings: {
          allow_comment: { enabled: true, required: true, default: true, label: 'Comments' },
          allow_duet: { enabled: true, required: true, default: false, label: 'Duet' },
          allow_stitch: { enabled: true, required: true, default: false, label: 'Stitch' },
        } },
      };
    }
    else if (path === '/posts' && method === 'POST') {
      if (!body || !Array.isArray(body.platforms) || !key) throw new Error('Invalid POST');
      const target = record(body.platforms[0]);
      const project = keyProjects.get(key);
      if (!project) throw new Error('Unknown submit key');
      const intent = CreatorIntentSchema.parse(JSON.parse(await readFile(join(project, 'publication/intents', `${key.slice('creator:'.length)}.json`), 'utf8')));
      submitted.push(intent);
      await controls.beforePost?.(intent, project);
      const platform = String(target.platform);
      if (platform === controls.uncertainPlatform) throw new Error(controls.uncertainMessage ?? 'Crash after durable claim and transport submit');
      if (platform === controls.rejectPlatform) { status = 400; answer = { error: 'rejected' }; }
      else {
        const pending = controls.pending || (controls.pendingLastTwo && platform === 'tiktok' && paths.indexOf(project) >= count - 2);
        const post: RemotePost = { _id: `remote-${posts.size + 1}`, idempotencyKey: key, profileId: preset.publishing.profile.id,
          platforms: [{ platform, accountId: intent.accountId, status: pending ? 'pending' : 'published', platformPostUrl: `https://social.example/${posts.size + 1}` }] };
        posts.set(key, post);
        status = pending ? 207 : 201;
        answer = { post };
      }
    } else if (path === '/posts') {
      const listed = [...posts.values()];
      const offset = Number(url.searchParams.get('offset') ?? 0);
      answer = { posts: listed.slice(offset, offset + 100), pagination: { page: offset / 100 + 1, limit: 100, total: listed.length, pages: Math.max(1, Math.ceil(listed.length / 100)) } };
    }
    else if (path.startsWith('/posts/')) answer = { post: [...posts.values()].find((post) => post._id === decodeURIComponent(path.slice(7))) };
    else throw new Error(`Unexpected transport ${method} ${path}`);
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }, { preconnect: () => {} });
  const client = new ZernioClient({ apiKey: 'mock-only-batch-key', fetchImpl, maxAttempts: 1 });
  const media = makeTestDeps({ ebur128Summary: `Summary:\n Integrated loudness:\n I: ${preset.editing.audio.targetLufs} LUFS\n Loudness range:\n LRA: 3.0 LU\n True peak:\n Peak: ${preset.editing.audio.maxTruePeakDbtp} dBFS\n` });
  media.fetchImpl = fetchImpl;
  media.process = { async run(command, args) {
    processes++;
    if (command !== 'ffprobe') return { code: 0, stdout: '', stderr: '' };
    const cover = args.at(-1)?.endsWith('.png');
    return { code: 0, stderr: '', stdout: JSON.stringify({ streams: cover
      ? [{ codec_type: 'video', codec_name: 'png', width: preset.editing.width, height: preset.editing.height }]
      : [{ codec_type: 'video', codec_name: 'h264', width: preset.editing.width, height: preset.editing.height, avg_frame_rate: `${preset.editing.fps}/1`, pix_fmt: preset.editing.render.pixelFormat }, { codec_type: 'audio', codec_name: 'aac', sample_rate: String(preset.editing.render.sampleRate) }], format: { duration: '10' } }) };
  } };
  media.publisher = async (journalPath): Promise<Publisher> => {
    const publisher = new ZernioPublisher(client, { journal: new FilePublicationJournal(journalPath) });
    return {
      id: publisher.id,
      accounts: (ctx) => publisher.accounts(ctx),
      validate: async (post, ctx) => { const project = keyProjects.get(post.idempotencyKey); if (project) await controls.beforeValidate?.(project); return publisher.validate(post, ctx); },
      publish: (post, ctx) => publisher.publish(post, ctx),
      schedule: (post, ctx) => publisher.schedule(post, ctx),
      status: (key, ctx) => publisher.status(key, ctx),
      reconcile: (key, ctx) => publisher.reconcile(key, ctx),
    };
  };
  const store: ObjectStore = {
    async head(key) { return objects.get(key)?.meta ?? null; },
    async put(key, bytes, opts) { puts++; const meta = { key, bytes: bytes.length, sha256: sha256(bytes), contentType: opts.contentType, publicUrl: `https://cdn.example/${key}` }; objects.set(key, { bytes, meta }); return meta; },
    async get(key) { const object = objects.get(key); if (!object) throw new Error('Missing mock object'); return object.bytes; },
    async inspect(key) { const object = objects.get(key); if (!object) throw new Error('Missing mock object'); return object.meta; },
  };
  const deps: CreatorDeps = { media, client: async () => { clients++; return client; }, storage: async () => { stores++; await controls.beforeStorage?.(); return store; } };
  for (let index = 0; index < count; index++) {
    const projectPath = `video-${index + 1}`;
    const project = join(root, projectPath);
    paths.push(project);
    await initProject(project, projectPath, `Video ${index + 1}`, false, presetPath);
    const { manifest, draft } = await loadProject(project);
    const edited = { ...draft, video: 'renders/final.mp4', cover: 'renders/cover.png', title: `Original ${index + 1}`, content: 'Mi contenido original #IA', syntheticMedia: true };
    await writeFile(join(project, edited.video), `final-${index + 1}`);
    await writeFile(join(project, edited.cover), `cover-${index + 1}`);
    await writeJson(project, 'publication/draft.json', edited);
    await runCreatorQa(project, media);
    const plan = await planPublication(project, 0);
    if (!plan.digest || !plan.media) throw new Error('Fixture plan missing hashes');
    await writeJson(project, 'publication/draft.json', { ...edited, approval: { approved: true, digest: plan.digest } });
    entries.push({ projectPath, projectId: manifest.id, preset: manifest.preset, approval: { approved: true, digest: plan.digest }, media: plan.media,
      targets: preset.publishing.targets.map((target) => ({ platform: target.platform, accountId: target.accountId, username: target.username })) });
    for (const target of preset.publishing.targets) keyProjects.set(`creator:${sha256(`${manifest.id}:${plan.media.videoSha256}:${target.accountId}`)}`, project);
  }
  const manifestPath = join(root, 'batch.json');
  const manifest = CreatorBatchManifestSchema.parse({ schemaVersion: 1, batchId: 'offline-batch', queuePolicy: 'allow-provider-queue', projects: entries });
  await writeFile(manifestPath, JSON.stringify(manifest));
  return { root, paths, manifestPath, manifest, preset, deps, media, controls, posts, calls, submitted,
    counts: () => ({ puts, clients, stores, processes, ffmpeg: media.calls.ffmpeg.length, secrets: media.calls.secrets.length, generated: media.calls.submits.length }) };
}

function confirmedCapacity(target: CreatorBatchTarget, checkedAt: Date, remaining = 1): CreatorBatchCapacityObservation {
  return { platform: target.platform, accountId: target.accountId, status: 'confirmed',
    source: 'trusted-offline-test-capacity', checkedAt: checkedAt.toISOString(), remaining };
}

async function requireCapacity(manifestPath: string, manifest: CreatorBatchManifest): Promise<void> {
  await writeFile(manifestPath, JSON.stringify({ ...manifest, queuePolicy: 'require-capacity' }));
}

async function restrictTargets(path: string, manifest: CreatorBatchManifest, indices: number[]): Promise<void> {
  await writeFile(path, JSON.stringify({ ...manifest, projects: manifest.projects.map((entry) => ({ ...entry, targets: indices.map((index) => entry.targets[index]!) })) }));
}

async function treeBytes(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(path: string, relative: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = `${relative}${entry.name}`;
      if (entry.isDirectory()) { result.push(`${name}/`); await visit(join(path, entry.name), `${name}/`); }
      else result.push(`${name}:${(await readFile(join(path, entry.name))).toString('base64')}`);
    }
  }
  await visit(root, '');
  return result;
}

async function seedIntent(project: string, entry: CreatorBatchProject, targetIndex: number, state?: 'failed' | 'uncertain'): Promise<string> {
  const target = entry.targets[targetIndex]!;
  const key = `creator:${sha256(`${entry.projectId}:${entry.media.videoSha256}:${target.accountId}`)}`;
  await writeJson(project, `publication/intents/${key.slice('creator:'.length)}.json`, {
    schemaVersion: 1, idempotencyKey: key, platform: target.platform, accountId: target.accountId, projectId: entry.projectId, videoSha256: entry.media.videoSha256, digest: entry.approval.digest,
  });
  if (state) await writeJson(project, `publication/intents/${key.slice('creator:'.length)}.result.json`, { platform: target.platform, accountId: target.accountId, idempotencyKey: key, state });
  return key;
}

const openSpend = { schemaVersion: 1 as const, attemptId: 'paid-attempt', planDigest: 'b'.repeat(64), command: 'gen-media', subject: 'gen-media:scene:abc', state: 'uncertain' as const, reservedUsd: 0.5, createdAt: '2026-01-01T00:00:00.000Z' };

describe('typed creator batch (mocks-only real submit-once workflow)', () => {
  test('eight projects by three networks: 24 exact unique POSTs, 22 published, two TikTok HTTP207 pending; two resumes never POST/upload again', async () => {
    const f = await fixture(8, { pendingLastTwo: true });
    // Real incident shape: source Typesafe clips-select ledger remains unresolved outside eight approved projects.
    await new FileSpendLedger(spendLedgerPath(f.root)).append({ ...openSpend, command: 'clips-select', subject: `clips-select:${'c'.repeat(64)}` });
    const sourceLedger = await readFile(spendLedgerPath(f.root));
    const planned = await planCreatorBatch(f.manifestPath, 0);
    expect(planned.summary.notStarted).toBe(24);
    expect(planned.dependencies.find((item) => item.scope === 'independent')).toMatchObject({ scope: 'independent', effect: 'informative', state: 'uncertain' });
    const first = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(first.summary).toEqual({ total: 24, published: 22, pending: 2, notStarted: 0, uncertain: 0, failed: 0, blocked: 0 });
    expect(first.complete).toBe(false);
    expect(first.capacity.every((item) => item.status === 'unknown' && item.remaining === undefined && item.resetAt === undefined && item.nextRetryAt === undefined)).toBe(true);
    expect(first.dependencies.find((item) => item.scope === 'independent')).toMatchObject({ scope: 'independent', effect: 'informative', state: 'uncertain' });
    expect(await readFile(spendLedgerPath(f.root))).toEqual(sourceLedger);
    expect(first.targets.filter((target) => target.state === 'pending').every((target) => target.platform === 'tiktok')).toBe(true);
    const posts = f.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(24);
    expect(new Set(posts.map((call) => call.key)).size).toBe(24);
    expect(f.submitted.every((intent) => intent.evidence?.profileId === f.preset.publishing.profile.id)).toBe(true);
    const counts = f.counts();
    const bytes = await treeBytes(f.root);
    const callCount = f.calls.length;
    for (let index = 0; index < 2; index++) expect((await resumeCreatorBatch(f.manifestPath, f.deps, options)).summary).toEqual(first.summary);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(24);
    expect(f.calls.slice(callCount).every((call) => call.method === 'GET')).toBe(true);
    expect(f.counts().puts).toBe(counts.puts);
    expect(f.counts().stores).toBe(counts.stores);
    expect(f.counts().processes).toBe(counts.processes);
    expect(await treeBytes(f.root)).toEqual(bytes);
    expect(await readFile(spendLedgerPath(f.root))).toEqual(sourceLedger);
    CreatorBatchProgressSchema.parse(first);
  });

  test('pending becomes published through status GET without local writes and complete means every required target published', async () => {
    const f = await fixture(2, { pending: true });
    const published = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(published.summary.pending).toBe(6);
    for (const post of f.posts.values()) post.platforms[0]!.status = 'published';
    const before = await treeBytes(f.root);
    const counts = f.counts();
    const calls = f.calls.length;
    const observed = await statusCreatorBatch(f.manifestPath, f.deps);
    expect(observed.summary.published).toBe(6);
    expect(observed.complete).toBe(true);
    expect(f.calls.slice(calls).every((call) => call.method === 'GET')).toBe(true);
    expect(f.counts().puts).toBe(counts.puts);
    expect(f.counts().processes).toBe(counts.processes);
    expect(f.counts().ffmpeg).toBe(counts.ffmpeg);
    expect(f.counts().secrets).toBe(0);
    expect(await treeBytes(f.root)).toEqual(before);
  });

  test('resume with no eligible targets returns fresh pending-to-published observation and performs no upload/POST', async () => {
    const f = await fixture(1, { pending: true });
    await publishCreatorBatch(f.manifestPath, f.deps, options);
    for (const post of f.posts.values()) post.platforms[0]!.status = 'published';
    const counts = f.counts();
    const result = await resumeCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.complete).toBe(true);
    expect(result.summary.published).toBe(3);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(3);
    expect(f.counts().stores).toBe(counts.stores);
  });

  test('shared status credential factory failure is reported as uncertainty without local mutation or secret leakage', async () => {
    const f = await fixture(2);
    await publishCreatorBatch(f.manifestPath, f.deps, options);
    let attempts = 0;
    f.deps.client = async () => { attempts++; throw new Error('secret-status-key-must-not-leak'); };
    const bytes = await treeBytes(f.root);
    const counts = f.counts();
    const callCount = f.calls.length;
    const result = await statusCreatorBatch(f.manifestPath, f.deps);
    expect(result.summary.uncertain).toBe(6);
    expect(attempts).toBe(1);
    expect(JSON.stringify(result)).not.toContain('secret-status-key-must-not-leak');
    expect(f.calls).toHaveLength(callCount);
    expect(f.counts()).toEqual(counts);
    expect(await treeBytes(f.root)).toEqual(bytes);
  });

  test('inconclusive shared GET transport stops repeated clip lookups and keeps status read-only', async () => {
    const f = await fixture(2);
    await publishCreatorBatch(f.manifestPath, f.deps, options);
    f.controls.failStatus = true;
    const bytes = await treeBytes(f.root);
    const callCount = f.calls.length;
    const result = await statusCreatorBatch(f.manifestPath, f.deps);
    expect(result.summary.uncertain).toBe(6);
    expect(f.calls.slice(callCount).every((call) => call.method === 'GET')).toBe(true);
    expect(f.calls.length - callCount).toBeLessThanOrEqual(3);
    expect(JSON.stringify(result)).not.toContain('secret-status-key-must-not-leak');
    expect(await treeBytes(f.root)).toEqual(bytes);
  });

  test('plan and offline status are filesystem-read-only, secret-free/process-free; capacity stays unknown', async () => {
    const f = await fixture(2);
    const before = await treeBytes(f.root);
    const counts = f.counts();
    const planned = await planCreatorBatch(f.manifestPath, 0);
    expect(planned.summary.notStarted).toBe(6);
    expect(planned.capacity.every((item) => item.status === 'unknown' && item.checkedAt === null && item.remaining === undefined)).toBe(true);
    const status = await statusCreatorBatch(f.manifestPath, f.deps, true);
    expect(status.summary).toEqual(planned.summary);
    expect(await loadCreatorBatch(f.manifestPath)).toEqual(f.manifest);
    expect(f.counts()).toEqual(counts);
    expect(f.calls).toHaveLength(0);
    expect(await treeBytes(f.root)).toEqual(before);
  });

  test('offline plan and status retain attempted target evidence without invoking any external seam', async () => {
    const f = await fixture();
    await publishCreatorBatch(f.manifestPath, f.deps, options);
    const before = await treeBytes(f.root);
    const counts = f.counts();
    const callCount = f.calls.length;
    const planned = await planCreatorBatch(f.manifestPath, 0);
    const observed = await statusCreatorBatch(f.manifestPath, f.deps, true);
    expect(planned.summary.published).toBe(3);
    expect(observed.targets.every((target) => target.idempotencyKey && target.remoteId)).toBe(true);
    expect(f.calls).toHaveLength(callCount);
    expect(f.counts()).toEqual(counts);
    expect(await treeBytes(f.root)).toEqual(before);
  });

  test('confirm and exact finite zero spend cap are required even when resume has no eligible targets', async () => {
    const f = await fixture();
    for (const operation of [publishCreatorBatch, resumeCreatorBatch, reconcileCreatorBatch]) {
      await expect(operation(f.manifestPath, f.deps, { confirm: false, spendCap: 0 })).rejects.toThrow('--confirm');
      for (const cap of [undefined, null, '0', NaN, Infinity, -1, 1]) await expect(operation(f.manifestPath, f.deps, { confirm: true, spendCap: cap })).rejects.toThrow('--spend-cap 0');
    }
    expect((await planCreatorBatch(f.manifestPath, undefined)).summary.blocked).toBe(3);
    expect(f.calls).toHaveLength(0);
    expect(f.counts().stores).toBe(0);
  });

  test('require-capacity offline plan blocks unknown capacity; execution may collect read-only evidence but never uploads/posts unknown quota', async () => {
    const f = await fixture(2);
    await requireCapacity(f.manifestPath, f.manifest);
    const planned = await planCreatorBatch(f.manifestPath, 0);
    expect(planned.summary.blocked).toBe(6);
    expect(planned.targets.every((target) => target.detail?.includes('require-capacity'))).toBe(true);
    expect(planned.capacity.every((item) => item.status === 'unknown' && item.checkedAt === null)).toBe(true);
    expect(f.calls).toHaveLength(0);
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary.blocked).toBe(6);
    expect(result.capacity.every((item) => item.status === 'unknown' && item.checkedAt !== null && item.remaining === undefined)).toBe(true);
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(f.counts().stores).toBe(0);
    expect(f.counts().puts).toBe(0);
  });

  test('confirmed injected capacity passes through guarded deps and publishes required-capacity without editing approved bytes', async () => {
    const f = await fixture(2);
    await requireCapacity(f.manifestPath, f.manifest);
    let checks = 0;
    f.deps.capacity = async (target, checkedAt) => { checks++; return confirmedCapacity(target, checkedAt, 2); };
    const immutable = await Promise.all(f.paths.flatMap((path) => ['preset.snapshot.json', 'publication/draft.json'].map(async (file) => [join(path, file), await readFile(join(path, file))] as const)));
    const planned = await planCreatorBatch(f.manifestPath, 0);
    expect(planned.summary.blocked).toBe(6); // Planning never calls the adapter or network.
    expect(checks).toBe(0);
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ published: 6, blocked: 0, uncertain: 0 });
    expect(result.complete).toBe(true);
    expect(result.capacity.every((item) => item.status === 'confirmed' && item.remaining === 2 && item.checkedAt !== null)).toBe(true);
    expect(checks).toBeGreaterThanOrEqual(18);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(6);
    for (const [path, bytes] of immutable) expect(await readFile(path)).toEqual(bytes);
    CreatorBatchProgressSchema.parse(result);
  });

  test('estimated or stale capacity never authorizes strict sends and reports only valid evidence without fresh claims', async () => {
    const sources: CreatorCapacitySource[] = [
      async (target, checkedAt) => ({ ...confirmedCapacity(target, checkedAt), status: 'estimated' }),
      async (target, checkedAt) => confirmedCapacity(target, new Date(checkedAt.getTime() - 120_000)),
    ];
    for (const capacity of sources) {
      const f = await fixture(2);
      await requireCapacity(f.manifestPath, f.manifest);
      f.deps.capacity = capacity;
      const before = await treeBytes(f.root);
      const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
      expect(result.summary.blocked).toBe(6);
      expect(result.capacity.every((item) => item.status !== 'confirmed')).toBe(true);
      expect(f.counts().puts).toBe(0);
      expect(f.counts().stores).toBe(0);
      expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
      expect(await treeBytes(f.root)).toEqual(before);
    }
  });

  test('known zero capacity pauses only that account across clips while positive accounts still submit', async () => {
    const f = await fixture(3);
    await requireCapacity(f.manifestPath, f.manifest);
    f.deps.capacity = async (target, checkedAt) => confirmedCapacity(target, checkedAt, target.platform === 'tiktok' ? 0 : 2);
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ blocked: 3, published: 6, uncertain: 0 });
    expect(result.targets.filter((target) => target.platform === 'tiktok').every((target) => target.state === 'blocked' && !target.idempotencyKey)).toBe(true);
    expect(result.capacity.find((item) => item.platform === 'tiktok')).toMatchObject({ status: 'confirmed', remaining: 0 });
    expect(f.submitted.every((intent) => intent.platform !== 'tiktok')).toBe(true);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(6);
  });

  test('exact account identity/health and TikTok quota refusals stop only that account, not eligible approved accounts', async () => {
    const modes: Array<'identity' | 'health' | 'quota' | 'daily-limit'> = ['identity', 'health', 'quota', 'daily-limit'];
    for (const mode of modes) {
      const f = await fixture(2);
      const account = f.preset.publishing.targets[0]!.accountId;
      if (mode === 'identity') f.controls.wrongAccount = account;
      else if (mode === 'health') f.controls.unhealthyAccount = account;
      else if (mode === 'quota') f.controls.canPostMore = false;
      else f.controls.creatorStatus = 429;
      const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
      expect(result.summary).toMatchObject({ blocked: 2, published: 4, uncertain: 0 });
      expect(result.targets.filter((target) => target.accountId === account).every((target) => target.state === 'blocked' && !target.idempotencyKey)).toBe(true);
      expect(f.submitted.every((intent) => intent.accountId !== account)).toBe(true);
      if (mode === 'quota' || mode === 'daily-limit') {
        expect(result.capacity.find((item) => item.accountId === account)).toMatchObject({ status: 'unknown', canPostMore: false });
        expect(result.capacity.find((item) => item.accountId === account)?.remaining).toBeUndefined();
      }
    }
  });

  test('capacity consumed by an earlier clip is freshly checked before the next clip claim and only its account is paused', async () => {
    const f = await fixture(3);
    await requireCapacity(f.manifestPath, f.manifest);
    let remaining = 1;
    f.deps.capacity = async (target, checkedAt) => confirmedCapacity(target, checkedAt, target.platform === 'tiktok' ? remaining : 2);
    f.controls.beforePost = async (intent) => { if (intent.platform === 'tiktok') remaining = 0; };
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ published: 7, blocked: 2, uncertain: 0 });
    expect(f.submitted.filter((intent) => intent.platform === 'tiktok')).toHaveLength(1);
    expect(result.capacity.find((item) => item.platform === 'tiktok')).toMatchObject({ status: 'confirmed', remaining: 0 });
    for (const entry of f.manifest.projects.slice(1)) {
      const target = entry.targets[0]!;
      const key = sha256(`${entry.projectId}:${entry.media.videoSha256}:${target.accountId}`);
      const files = await readdir(join(f.root, entry.projectPath, 'publication', 'intents'));
      expect(files.some((file) => file.startsWith(key))).toBe(false);
      expect(result.targets.find((item) => item.projectId === entry.projectId && item.accountId === target.accountId)?.idempotencyKey).toBeUndefined();
    }
  });

  test('a final capacity race blocks the wire, retains the claimed key, and keeps other accounts eligible', async () => {
    const f = await fixture(2);
    await requireCapacity(f.manifestPath, f.manifest);
    let remaining = 1;
    f.deps.capacity = async (target, checkedAt) => confirmedCapacity(target, checkedAt, target.platform === 'tiktok' ? remaining : 2);
    f.controls.beforeValidate = async () => { remaining = 0; };
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ uncertain: 1, blocked: 1, published: 4 });
    expect(result.targets.find((target) => target.projectId === 'video-1' && target.platform === 'tiktok')?.idempotencyKey).toMatch(/^creator:/);
    expect(f.submitted.every((intent) => intent.platform !== 'tiktok')).toBe(true);
    const posts = f.calls.filter((call) => call.method === 'POST').length;
    await resumeCreatorBatch(f.manifestPath, f.deps, options);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(posts);
  });

  test('a failed durable claim in a later clip pauses that account even in an earlier new clip', async () => {
    const f = await fixture(2);
    const failed = await seedIntent(f.paths[1]!, f.manifest.projects[1]!, 0, 'failed');
    const result = await resumeCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ failed: 1, blocked: 1, published: 4 });
    expect(result.targets.find((target) => target.projectId === 'video-1' && target.platform === 'tiktok')).toMatchObject({ state: 'blocked' });
    expect(f.submitted.every((intent) => intent.platform !== 'tiktok')).toBe(true);
    expect(f.calls.some((call) => call.method === 'POST' && call.key === failed)).toBe(false);
  });

  test('a failed provider account pauses its later clips while all other accounts continue and the failed key never retries', async () => {
    const f = await fixture(2, { rejectPlatform: 'tiktok' });
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ failed: 1, blocked: 1, published: 4 });
    expect(f.submitted.filter((intent) => intent.platform === 'tiktok')).toHaveLength(1);
    const failedKey = result.targets.find((target) => target.state === 'failed')!.idempotencyKey!;
    await resumeCreatorBatch(f.manifestPath, f.deps, options);
    expect(f.calls.filter((call) => call.method === 'POST' && call.key === failedKey)).toHaveLength(1);
  });

  test('positive preflight cannot prevent an HTTP207 queue race; concurrent and repeated resumes preserve pending ID with one POST', async () => {
    const f = await fixture(1, { pending: true });
    await restrictTargets(f.manifestPath, f.manifest, [0]);
    await requireCapacity(f.manifestPath, await loadCreatorBatch(f.manifestPath));
    let capacityChecks = 0;
    f.deps.capacity = async (target, checkedAt) => { capacityChecks++; return confirmedCapacity(target, checkedAt); };
    let claimed: (() => void) | undefined;
    let release: (() => void) | undefined;
    const claimedBarrier = new Promise<void>((resolve) => { claimed = resolve; });
    const releaseBarrier = new Promise<void>((resolve) => { release = resolve; });
    f.controls.beforePost = async () => { claimed?.(); await releaseBarrier; };
    const first = publishCreatorBatch(f.manifestPath, f.deps, options);
    await claimedBarrier;
    const competitor = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(competitor.summary.uncertain).toBe(1);
    release?.();
    const result = await first;
    expect(result.targets[0]).toMatchObject({ state: 'pending', remoteId: 'remote-1' });
    const before = f.counts();
    const bytes = await treeBytes(f.root);
    const checks = capacityChecks;
    const resumed = await Promise.all([resumeCreatorBatch(f.manifestPath, f.deps, options), resumeCreatorBatch(f.manifestPath, f.deps, options)]);
    expect(resumed.every((progress) => progress.targets[0]?.state === 'pending' && progress.targets[0]?.remoteId === 'remote-1')).toBe(true);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.counts().puts).toBe(before.puts);
    expect(f.counts().stores).toBe(before.stores);
    expect(capacityChecks).toBe(checks);
    expect(await treeBytes(f.root)).toEqual(bytes);
  });

  test('shared TLS/network preflight failures stop all related work before upload without leaking causes', async () => {
    for (const tls of [false, true]) {
      const f = await fixture(3);
      f.controls.remoteFailure = Object.assign(new Error('secret-remote-preflight-must-not-leak'), tls ? { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } } : {});
      const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
      expect(result.summary.blocked).toBe(9);
      expect(f.calls.filter((call) => call.path === '/profiles')).toHaveLength(1);
      expect(f.counts().stores).toBe(0);
      expect(f.counts().puts).toBe(0);
      expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
      expect(JSON.stringify(result)).not.toContain('secret-remote-preflight');
      expect(result.targets.every((target) => !target.idempotencyKey)).toBe(true);
    }
  });

  test('confirmed quota never bypasses open project spend while legitimate independent source Typesafe evidence remains informative', async () => {
    const f = await fixture(2);
    await requireCapacity(f.manifestPath, f.manifest);
    f.deps.capacity = async (target, checkedAt) => confirmedCapacity(target, checkedAt, 2);
    await new FileSpendLedger(spendLedgerPath(f.root)).append({ ...openSpend, command: 'clips-select', subject: `clips-select:${'c'.repeat(64)}` });
    await new FileSpendLedger(spendLedgerPath(f.paths[0]!)).append(openSpend);
    const source = await readFile(spendLedgerPath(f.root));
    const project = await readFile(spendLedgerPath(f.paths[0]!));
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ blocked: 3, published: 3 });
    expect(result.dependencies.find((item) => item.scope === 'independent')).toMatchObject({ effect: 'informative', state: 'uncertain' });
    expect(result.dependencies.find((item) => item.scope === 'project' && item.projectId === 'video-1')).toMatchObject({ effect: 'blocking', state: 'open' });
    expect(f.submitted.every((intent) => intent.projectId === 'video-2')).toBe(true);
    expect(await readFile(spendLedgerPath(f.root))).toEqual(source);
    expect(await readFile(spendLedgerPath(f.paths[0]!))).toEqual(project);
  });

  test('crash after durable intent with no receipt never submits the key; other never-started targets remain eligible', async () => {
    const f = await fixture();
    const key = await seedIntent(f.paths[0]!, f.manifest.projects[0]!, 0);
    const claimPath = join(f.paths[0]!, 'publication/intents', `${key.slice('creator:'.length)}.json`);
    const claim = await readFile(claimPath);
    const first = await resumeCreatorBatch(f.manifestPath, f.deps, options);
    expect(first.summary).toMatchObject({ total: 3, published: 2, uncertain: 1 });
    await resumeCreatorBatch(f.manifestPath, f.deps, options);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
    expect(f.calls.some((call) => call.method === 'POST' && call.key === key)).toBe(false);
    expect(await readFile(claimPath)).toEqual(claim);
  });

  test('lost local receipt after a real durable submit recovers through exact echoed-key GET without POST or receipt writes', async () => {
    const f = await fixture();
    await restrictTargets(f.manifestPath, f.manifest, [0]);
    const first = await publishCreatorBatch(f.manifestPath, f.deps, options);
    const key = first.targets[0]!.idempotencyKey!;
    await rm(join(f.paths[0]!, 'publication/intents', `${key.slice('creator:'.length)}.result.json`));
    const bytes = await treeBytes(f.root);
    const counts = f.counts();
    const result = await resumeCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.complete).toBe(true);
    expect(result.targets[0]?.idempotencyKey).toBe(key);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.counts().stores).toBe(counts.stores);
    expect(await treeBytes(f.root)).toEqual(bytes);
  });

  test('concurrent batch controllers and subsequent concurrent resumes never POST twice for any key', async () => {
    const f = await fixture();
    await restrictTargets(f.manifestPath, f.manifest, [0]);
    let claimed: (() => void) | undefined;
    let release: (() => void) | undefined;
    const claimedBarrier = new Promise<void>((resolve) => { claimed = resolve; });
    const releaseBarrier = new Promise<void>((resolve) => { release = resolve; });
    f.controls.beforePost = async () => { claimed?.(); await releaseBarrier; };
    const first = publishCreatorBatch(f.manifestPath, f.deps, options);
    await claimedBarrier; // The real controller's durable fsync'd intent is visible before competing execution.
    const competitor = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(competitor.summary.uncertain).toBe(1);
    release?.();
    await first;
    await Promise.all([resumeCreatorBatch(f.manifestPath, f.deps, options), resumeCreatorBatch(f.manifestPath, f.deps, options)]);
    const posts = f.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(new Set(posts.map((call) => call.key)).size).toBe(1);
    expect((await statusCreatorBatch(f.manifestPath, f.deps)).complete).toBe(true);
  });

  test('partial-target batch execution submits only listed approved accounts, leaving preset/draft/media byte-identical', async () => {
    const f = await fixture(2);
    await restrictTargets(f.manifestPath, f.manifest, [1]);
    const immutable = await Promise.all(f.paths.flatMap((path) => ['creator-project.json', 'preset.snapshot.json', 'publication/draft.json', 'renders/final.mp4', 'renders/cover.png', 'qa/creator-media.json'].map(async (file) => [join(path, file), await readFile(join(path, file))] as const)));
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary.total).toBe(2);
    expect(result.complete).toBe(true);
    expect(f.submitted.map((intent) => intent.accountId)).toEqual(Array(2).fill(f.preset.publishing.targets[1]!.accountId));
    for (const [path, bytes] of immutable) expect(await readFile(path)).toEqual(bytes);
  });

  test('missing shared credential is attempted once, then all related batch work is locally blocked', async () => {
    const f = await fixture(8);
    let attempts = 0;
    f.deps.client = async () => { attempts++; await f.media.secrets.getSecret('ZERNIO_API_KEY', 'run'); throw new Error('secret-client-credential-must-not-leak'); };
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(JSON.stringify(result)).not.toContain('secret-client-credential');
    expect(attempts).toBe(1);
    expect(f.media.calls.secrets).toEqual(['ZERNIO_API_KEY']);
    expect(result.summary.blocked).toBe(24);
    expect(f.calls).toHaveLength(0);
    expect(f.counts().stores).toBe(0);
  });

  test('shared authorization preflight failure is not blindly repeated across clips/accounts', async () => {
    const f = await fixture(3, { profileStatus: 401 });
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary.blocked).toBe(9);
    expect(f.calls.filter((call) => call.path === '/profiles')).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(f.counts().stores).toBe(0);
  });

  test('shared storage initialization failure stops later clips without durable claims or repeated storage calls', async () => {
    const f = await fixture(2);
    let stores = 0;
    f.deps.storage = async () => { stores++; throw new Error('secret-r2-credential-must-not-leak'); };
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(JSON.stringify(result)).not.toContain('secret-r2-credential');
    expect(stores).toBe(1);
    expect(result.summary.blocked).toBe(6);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  test('shared publisher credential initialization failure is not repeated and preserves its already claimed key', async () => {
    const f = await fixture(2);
    let attempts = 0;
    f.deps.media.publisher = async () => { attempts++; throw new Error('secret-publisher-key-must-not-leak'); };
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(attempts).toBe(1);
    expect(result.summary).toMatchObject({ uncertain: 1, blocked: 5 });
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(result.targets[0]?.idempotencyKey).toMatch(/^creator:[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('secret-publisher-key-must-not-leak');
  });

  test('failed and uncertain durable intents never retry; independent unstarted accounts can still publish', async () => {
    const f = await fixture();
    const failed = await seedIntent(f.paths[0]!, f.manifest.projects[0]!, 0, 'failed');
    const uncertain = await seedIntent(f.paths[0]!, f.manifest.projects[0]!, 1, 'uncertain');
    const first = await resumeCreatorBatch(f.manifestPath, f.deps, options);
    expect(first.summary).toMatchObject({ published: 1, failed: 1, uncertain: 1 });
    await resumeCreatorBatch(f.manifestPath, f.deps, options);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.calls.some((call) => call.method === 'POST' && [failed, uncertain].includes(call.key ?? ''))).toBe(false);
  });

  test('transport interruption retains claim and prevents retry while halting related account work', async () => {
    const f = await fixture(2, { uncertainPlatform: 'tiktok', uncertainMessage: 'secret-submit-key-must-not-leak' });
    const first = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(first.summary.uncertain).toBe(1);
    expect(JSON.stringify(first)).not.toContain('secret-submit-key-must-not-leak');
    expect(first.targets.find((target) => target.projectId === 'video-2' && target.platform === 'tiktok')?.state).toBe('blocked');
    const claim = f.submitted.find((intent) => intent.platform === 'tiktok')!;
    await restrictTargets(f.manifestPath, f.manifest, [0]);
    // An unresolved first key keeps the whole account paused, even in a new explicitly confirmed run.
    await resumeCreatorBatch(f.manifestPath, f.deps, options);
    expect(f.calls.filter((call) => call.method === 'POST' && call.key === claim.idempotencyKey)).toHaveLength(1);
  });

  test('an open same-project ledger blocks only that project, remains byte-identical, and independent approved project publishes', async () => {
    const f = await fixture(2);
    await new FileSpendLedger(spendLedgerPath(f.paths[0]!)).append(openSpend);
    const before = await readFile(spendLedgerPath(f.paths[0]!));
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ blocked: 3, published: 3 });
    expect(result.dependencies.find((item) => item.scope === 'project' && item.projectId === 'video-1')).toMatchObject({ scope: 'project', effect: 'blocking', state: 'open' });
    expect(await readFile(spendLedgerPath(f.paths[0]!))).toEqual(before);
    expect(f.submitted.every((intent) => intent.projectId === 'video-2')).toBe(true);
  });

  test('unrecognized open source-ledger dependency cannot be automatically classified as clear or informative', async () => {
    const f = await fixture(2);
    await new FileSpendLedger(spendLedgerPath(f.root)).append(openSpend);
    const before = await readFile(spendLedgerPath(f.root));
    const planned = await planCreatorBatch(f.manifestPath, 0);
    expect(planned.summary.blocked).toBe(6);
    expect(planned.dependencies.some((item) => item.scope === 'independent')).toBe(false);
    expect(planned.targets.every((target) => target.detail?.includes('unrecognized scope'))).toBe(true);
    expect((await publishCreatorBatch(f.manifestPath, f.deps, options)).summary.blocked).toBe(6);
    expect(f.calls).toHaveLength(0);
    expect(await readFile(spendLedgerPath(f.root))).toEqual(before);
  });

  test('invalid source ledger fails closed without pretending its dependency is informative', async () => {
    const f = await fixture();
    await writeJson(f.root, 'qa/spend.json', { schemaVersion: 1, attempts: [{ state: 'uncertain' }] });
    const before = await readFile(spendLedgerPath(f.root));
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary.blocked).toBe(3);
    expect(result.dependencies.some((item) => item.scope === 'independent')).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(await readFile(spendLedgerPath(f.root))).toEqual(before);
  });

  test('ledger opened between submits blocks remaining project targets and never erases its paid evidence', async () => {
    const f = await fixture();
    f.controls.beforePost = async (_intent, project) => { await new FileSpendLedger(spendLedgerPath(project)).append(openSpend); };
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ published: 1, blocked: 2 });
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect((await new FileSpendLedger(spendLedgerPath(f.paths[0]!)).list())[0]?.state).toBe('uncertain');
  });

  test('current project identity, preset, draft, approval, media and QA changes each block their project before any submit', async () => {
    const changes: Array<(project: string) => Promise<void>> = [
      async (project) => { const { manifest } = await loadProject(project); await writeJson(project, 'creator-project.json', { ...manifest, id: 'wrong-project' }); },
      async (project) => { await writeFile(join(project, 'preset.snapshot.json'), `${await readFile(join(project, 'preset.snapshot.json'), 'utf8')} `); },
      async (project) => { const { draft } = await loadProject(project); await writeJson(project, 'publication/draft.json', { ...draft, content: 'Changed after approval' }); },
      async (project) => { const { draft } = await loadProject(project); await writeJson(project, 'publication/draft.json', { ...draft, approval: { approved: false, digest: null } }); },
      async (project) => { await writeFile(join(project, 'renders/final.mp4'), 'changed video'); },
      async (project) => { await writeFile(join(project, 'renders/cover.png'), 'changed cover'); },
      async (project) => { const qa = record(JSON.parse(await readFile(join(project, 'qa/creator-media.json'), 'utf8'))); await writeJson(project, 'qa/creator-media.json', { ...qa, videoSha256: 'a'.repeat(64) }); },
    ];
    for (const change of changes) {
      const f = await fixture(2);
      await change(f.paths[0]!);
      const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
      expect(result.summary).toMatchObject({ blocked: 3, published: 3 });
      expect(f.submitted.every((intent) => intent.projectId === 'video-2')).toBe(true);
    }
  });

  test('inter-submit media hash changes stop remaining targets while retaining successful receipt', async () => {
    const f = await fixture();
    f.controls.beforePost = async (_intent, project) => { await writeFile(join(project, 'renders/cover.png'), 'changed after first submit'); };
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ published: 1, blocked: 2 });
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });

  test('batch manifest changed after upload/claim is rechecked before submit and never POSTs', async () => {
    const f = await fixture();
    f.controls.beforeValidate = async () => { await writeFile(f.manifestPath, `${JSON.stringify(f.manifest)}\n`); };
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary.published).toBe(0);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect(result.targets.every((target) => target.state !== 'not-started')).toBe(true);
  });

  test('batch target identities must exactly match approved platform/account/username', async () => {
    const f = await fixture();
    const entry = f.manifest.projects[0]!;
    await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, projects: [{ ...entry, targets: [{ ...entry.targets[0]!, username: 'wrong-owner' }] }] }));
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary.blocked).toBe(1);
    expect(f.calls).toHaveLength(0);
  });

  test('manifest file and root symlinks are rejected before all mutations', async () => {
    const f = await fixture();
    const fileLink = join(f.root, 'manifest-link.json');
    await symlink(f.manifestPath, fileLink);
    await expect(planCreatorBatch(fileLink, 0)).rejects.toThrow('Symlink refused');
    const root = await mkdtemp(join(tmpdir(), 'batch-root-link-'));
    roots.push(root);
    const rootLink = join(root, 'root');
    await symlink(f.root, rootLink);
    await expect(publishCreatorBatch(join(rootLink, 'batch.json'), f.deps, options)).rejects.toThrow('Symlink refused');
    expect(f.calls).toHaveLength(0);
  });

  test('symlinked project and media components are blocked, never copied or initialized', async () => {
    const f = await fixture(2);
    await rm(f.paths[0]!, { recursive: true });
    await symlink(f.paths[1]!, f.paths[0]!);
    const result = await publishCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary).toMatchObject({ blocked: 3, published: 3 });
    expect(f.submitted.every((intent) => intent.projectId === 'video-2')).toBe(true);
    const g = await fixture();
    await rm(join(g.paths[0]!, 'renders/final.mp4'));
    await symlink(join(g.paths[0]!, 'renders/cover.png'), join(g.paths[0]!, 'renders/final.mp4'));
    expect((await publishCreatorBatch(g.manifestPath, g.deps, options)).summary.blocked).toBe(3);
    expect(g.calls).toHaveLength(0);
  });

  test('traversal, absolute, noncanonical and backslash project paths are rejected by the manifest schema', async () => {
    const f = await fixture();
    for (const projectPath of ['../outside', '/tmp/outside', 'video-1/../video-1', './video-1', 'video-1//nested', 'video-1\\nested']) {
      await writeFile(f.manifestPath, JSON.stringify({ ...f.manifest, projects: [{ ...f.manifest.projects[0]!, projectPath }] }));
      await expect(planCreatorBatch(f.manifestPath, 0)).rejects.toThrow();
    }
    expect(f.calls).toHaveLength(0);
  });

  test('torn durable claims and older-media claims remain permanent submission barriers without inventing bypass keys', async () => {
    const f = await fixture();
    const key = await seedIntent(f.paths[0]!, f.manifest.projects[0]!, 0);
    await writeFile(join(f.paths[0]!, 'publication/intents', `${key.slice('creator:'.length)}.json`), '{');
    expect((await resumeCreatorBatch(f.manifestPath, f.deps, options)).summary.uncertain).toBe(3);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const g = await fixture();
    const entry = g.manifest.projects[0]!;
    const target = entry.targets[0]!;
    const oldHash = 'a'.repeat(64);
    const oldKey = `creator:${sha256(`${entry.projectId}:${oldHash}:${target.accountId}`)}`;
    await writeJson(g.paths[0]!, `publication/intents/${oldKey.slice('creator:'.length)}.json`, { schemaVersion: 1, projectId: entry.projectId, platform: target.platform, accountId: target.accountId, videoSha256: oldHash, digest: entry.approval.digest, idempotencyKey: oldKey });
    const result = await resumeCreatorBatch(g.manifestPath, g.deps, options);
    expect(result.targets[0]?.state).toBe('uncertain');
    expect(g.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  test('reconciliation uses the existing audited GET bridge for listed targets, never closes an open spend ledger or POSTs', async () => {
    const f = await fixture(1, { pending: true });
    await restrictTargets(f.manifestPath, f.manifest, [0]);
    await publishCreatorBatch(f.manifestPath, f.deps, options);
    for (const post of f.posts.values()) post.platforms[0]!.status = 'published';
    await new FileSpendLedger(spendLedgerPath(f.paths[0]!)).append(openSpend);
    const ledger = await readFile(spendLedgerPath(f.paths[0]!));
    const calls = f.calls.length;
    const counts = f.counts();
    const result = await reconcileCreatorBatch(f.manifestPath, f.deps, options);
    expect(result.summary.published).toBe(1);
    expect(result.complete).toBe(true);
    expect(result.dependencies.some((item) => item.state === 'open')).toBe(true);
    expect(f.calls.slice(calls).every((call) => call.method === 'GET')).toBe(true);
    expect(f.counts().stores).toBe(counts.stores);
    expect(f.counts().processes).toBe(counts.processes);
    expect(await readFile(spendLedgerPath(f.paths[0]!))).toEqual(ledger);
  });
});
