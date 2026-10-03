import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePublicationJournal, ZernioClient, ZernioPublisher, type ObjectMeta, type ObjectStore, type Publisher } from '@videomaker/providers';
import { CreatorIntentSchema, CreatorTikTokEnvelopeSchema as TikTokCapabilitySchema, type CreatorIntent, type CreatorTikTokCapability, type CreatorBatchCapacityObservation, type CreatorBatchTarget } from '@videomaker/schemas';
import { makeTestDeps } from '../pipeline/test-support';
import { loadProject, initProject, sha256, writeJson, PresetSchema, type Preset } from './model';
import { planPublication, runCreatorQa } from './qa';
import { FileSpendLedger, spendLedgerPath } from '../pipeline/spend-ledger';
import { assertTikTokCapability, publishCreator, remotePreflight, statusCreator, reconcileCreator, type CreatorDeps, type CreatorPublishOptions } from './workflow';
import { CreatorPreflightError, type CreatorCapacitySource } from './preflight';

const PRESET_PATH = new URL('../../../../presets/leobar.json', import.meta.url).pathname;
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected record');
  return Object.fromEntries(Object.entries(value));
}
interface Controls {
  secondClient?: boolean; duration?: number; wrongProfile?: boolean; wrongAccount?: boolean; unhealthy?: boolean; privacy?: boolean; capacity?: number;
  canPostMore?: boolean; commentsDisabled?: boolean;
  uncertain?: string; rejected?: string; pending?: boolean; synthetic?: boolean; corruptStorage?: boolean; loudness?: number;
  uncertainDetail?: string; rejectedDetail?: string;
  beforePost?: () => Promise<void>;
  beforeValidate?: () => Promise<void>;
}
async function fixture(controls: Controls = {}) {
  const root = await mkdtemp(join(tmpdir(), 'creator-workflow-'));
  roots.push(root);
  const project = join(root, 'video');
  let presetPath = PRESET_PATH;
  if (controls.secondClient) {
    const baseline = PresetSchema.parse(JSON.parse(await readFile(PRESET_PATH, 'utf8')));
    const custom = { ...baseline, id: 'client-two', name: 'Client Two',
      identity: { palette: ['#123456'], fonts: ['Arial'], tone: 'Formal', rules: ['Original content'] },
      editing: { width: 1280, height: 720, fps: 24, audio: { ...baseline.editing.audio, targetLufs: -18, maxTruePeakDbtp: -2 }, render: baseline.editing.render },
      publishing: { provider: 'zernio', profile: { name: 'client-two-profile', id: 'profile-two' }, targets: [{ platform: 'facebook', accountId: 'facebook-two', username: 'client-two', constraints: { maxDurationSeconds: 600, maxTextCharacters: 2000 } }], maxHashtags: 3, discloseSyntheticMediaWhenPresent: true },
    };
    presetPath = join(root, 'client-two.json');
    await writeFile(presetPath, JSON.stringify(custom));
  }
  await initProject(project, 'unique-video', 'Mi siguiente video', false, presetPath);
  const { preset, draft } = await loadProject(project);
  const edited = { ...draft, video: 'renders/final.mp4', cover: 'renders/cover.png', title: 'Mi título', content: 'Mi contenido #IA', platformContent: controls.secondClient ? {} : { twitter: 'Mi texto X' }, syntheticMedia: controls.synthetic ?? true, tags: ['edición', 'Remotion'] };
  await writeFile(join(project, edited.video), 'final bytes');
  await writeFile(join(project, edited.cover), 'cover bytes');
  await writeJson(project, 'publication/draft.json', edited);
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const submittedIntents: CreatorIntent[] = [];
  const objects = new Map<string, { bytes: Uint8Array; meta: ObjectMeta }>();
  let puts = 0;
  let storageCalls = 0;
  let clientCalls = 0;
  let processCalls = 0;
  const posts = new Map<string, { _id: string; idempotencyKey: string; platforms: Array<{ platform: string; status: string; platformPostUrl: string }> }>();
  const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^.*\/v1/, '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? record(JSON.parse(init.body)) : undefined;
    calls.push({ method, path: `${path}${url.search}`, ...(body ? { body } : {}) });
    let answer: unknown;
    let status = 200;
    if (path === '/profiles') answer = { profiles: [{ _id: controls.wrongProfile ? 'wrong' : preset.publishing.profile.id, name: preset.publishing.profile.name }] };
    else if (path === '/accounts') {
      expect(url.searchParams.get('profileId')).toBe(preset.publishing.profile.id);
      answer = { accounts: preset.publishing.targets.map((target, index) => ({ _id: controls.wrongAccount && index === 0 ? 'wrong' : target.accountId, platform: target.platform, username: target.username })) };
    } else if (path === '/accounts/health') answer = { accounts: preset.publishing.targets.map((target, index) => ({ accountId: target.accountId, status: controls.unhealthy && index === 2 ? 'expired' : 'healthy', canPost: !(controls.unhealthy && index === 2) })) };
    else if (path.endsWith('/tiktok/creator-info')) {
      expect(url.searchParams.get('mediaType')).toBe('video');
      answer = {
        creator: { nickname: 'creator', avatarUrl: 'https://cdn.example/avatar.png', isVerified: false, canPostMore: controls.canPostMore !== false },
        privacyLevels: [{ value: controls.privacy ? 'SELF_ONLY' : 'PUBLIC_TO_EVERYONE', label: 'Everyone' }],
        postingLimits: {
          maxVideoDurationSec: controls.capacity ?? 600,
          interactionSettings: {
            allow_comment: { enabled: controls.commentsDisabled !== true, required: true, default: true, label: 'Comments' },
            allow_duet: { enabled: true, required: true, default: false, label: 'Duet' },
            allow_stitch: { enabled: true, required: true, default: false, label: 'Stitch' },
          },
        },
      };
    }
    else if (path === '/posts' && method === 'POST') {
      if (!body || !Array.isArray(body.platforms)) throw new Error('Bad request');
      const target = record(body.platforms[0]);
      const key = new Headers(init?.headers).get('idempotency-key');
      if (!key) throw new Error('Missing idempotency header');
      submittedIntents.push(CreatorIntentSchema.parse(JSON.parse(await readFile(join(project, 'publication', 'intents', `${key.slice('creator:'.length)}.json`), 'utf8'))));
      await controls.beforePost?.();
      const platform = String(target.platform);
      if (platform === controls.uncertain) throw new Error(controls.uncertainDetail ?? 'transport interrupted after submit');
      if (platform === controls.rejected) { status = 400; answer = { error: controls.rejectedDetail ?? 'rejected' }; }
      else {
        const post = { _id: `remote-${platform}`, idempotencyKey: key, profileId: preset.publishing.profile.id, platforms: [{ platform, accountId: String(target.accountId), status: controls.pending ? 'pending' : 'published', platformPostUrl: `https://social.example/${platform}` }] };
        posts.set(key, post);
        status = controls.pending ? 207 : 201;
        answer = { post };
      }
    } else if (path === '/posts') {
      const all = [...posts.values()];
      const offset = Number(url.searchParams.get('offset') ?? 0);
      answer = { posts: all.slice(offset, offset + 100), pagination: { page: offset / 100 + 1, limit: 100, total: all.length, pages: Math.max(1, Math.ceil(all.length / 100)) } };
    }
    else if (path.startsWith('/posts/')) answer = { post: [...posts.values()].find((post) => post._id === decodeURIComponent(path.slice(7))) };
    else throw new Error(`Unexpected request ${method} ${path}`);
    return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json' } });
  }, { preconnect: () => {} });
  const client = new ZernioClient({ apiKey: 'offline-test-key', fetchImpl, maxAttempts: 1 });
  const media = makeTestDeps({ ebur128Summary: `Summary:\n Integrated loudness:\n I: ${controls.loudness ?? preset.editing.audio.targetLufs} LUFS\n Loudness range:\n LRA: 3.0 LU\n True peak:\n Peak: -2.0 dBFS\n` });
  media.fetchImpl = fetchImpl;
  media.process = { async run(command, args) {
    processCalls++;
    if (command !== 'ffprobe') return { code: 0, stdout: '', stderr: '' };
    const cover = args.at(-1)?.endsWith('.png');
    return { code: 0, stderr: '', stdout: JSON.stringify({ streams: cover ? [{ codec_type: 'video', codec_name: 'png', width: preset.editing.width, height: preset.editing.height }] : [{ codec_type: 'video', codec_name: 'h264', width: preset.editing.width, height: preset.editing.height, avg_frame_rate: `${preset.editing.fps}/1`, pix_fmt: preset.editing.render.pixelFormat }, { codec_type: 'audio', codec_name: 'aac', sample_rate: String(preset.editing.render.sampleRate) }], format: { duration: String(controls.duration ?? 10) } }) };
  } };
  media.publisher = async (journalPath): Promise<Publisher> => {
    const publisher = new ZernioPublisher(client, { journal: new FilePublicationJournal(journalPath) });
    return {
      id: publisher.id,
      accounts: (ctx) => publisher.accounts(ctx),
      validate: async (post, ctx) => { await controls.beforeValidate?.(); return publisher.validate(post, ctx); },
      publish: (post, ctx) => publisher.publish(post, ctx),
      schedule: (post, ctx) => publisher.schedule(post, ctx),
      status: (key, ctx) => publisher.status(key, ctx),
      reconcile: (key, ctx) => publisher.reconcile(key, ctx),
    };
  };
  const store: ObjectStore = {
    async head(key) { return objects.get(key)?.meta ?? null; },
    async put(key, bytes, opts) { puts++; const meta = { key, bytes: bytes.length, sha256: sha256(bytes), contentType: opts.contentType, publicUrl: `https://cdn.example/${key}` }; objects.set(key, { bytes, meta }); return meta; },
    async get(key) { const value = objects.get(key); if (!value) throw new Error('missing'); return value.bytes; },
    async inspect(key) { const value = objects.get(key); if (!value) throw new Error('missing'); return controls.corruptStorage ? { ...value.meta, sha256: 'bad' } : value.meta; },
  };
  const deps: CreatorDeps = { media, client: async () => { clientCalls++; return client; }, storage: async () => { storageCalls++; return store; } };
  if (controls.loudness === undefined) {
    await runCreatorQa(project, media);
    const plan = await planPublication(project, 0);
    await writeJson(project, 'publication/draft.json', { ...edited, approval: { approved: true, digest: plan.digest } });
  }
  return { project, deps, media, calls, posts, preset, controls, submittedIntents, counts: () => ({ puts, clientCalls, storageCalls, processCalls }) };
}

function confirmedCapacity(target: CreatorBatchTarget, checkedAt: Date, remaining = 1): CreatorBatchCapacityObservation {
  return { platform: target.platform, accountId: target.accountId, status: 'confirmed',
    source: 'trusted-offline-test-capacity', checkedAt: checkedAt.toISOString(), remaining };
}

interface CreatorGetCall { method: string; path: string; body?: Record<string, unknown> }
interface ProofPost {
  _id: string;
  idempotencyKey?: string;
  requestId?: string;
  profileId?: string;
  content?: string;
  createdAt?: string;
  mediaItems?: Array<{ url: string; thumbnail?: string }>;
  platforms: Array<{ platform: string; accountId?: string; profileId?: string; status?: string; platformPostUrl?: string; errorMessage?: string }>;
}

async function seedClaim(project: string, deps: CreatorDeps, preset: Preset, withJournal = true): Promise<CreatorIntent> {
  const plan = await planPublication(project, 0);
  if (!plan.digest || !plan.media) throw new Error('Fixture needs approved media');
  const target = preset.publishing.targets.at(-1)!;
  const intent = CreatorIntentSchema.parse({
    schemaVersion: 1, idempotencyKey: `creator:${sha256(`${plan.manifest.id}:${plan.media.videoSha256}:${target.accountId}`)}`,
    projectId: plan.manifest.id, digest: plan.digest, videoSha256: plan.media.videoSha256,
    platform: target.platform, accountId: target.accountId,
    evidence: { profileId: preset.publishing.profile.id, content: plan.draft.platformContent[target.platform] || plan.draft.content,
      videoUrl: 'https://cdn.example/original.mp4', coverUrl: 'https://cdn.example/original.png',
      submittedAt: '2026-01-01T00:00:00.000Z' },
  });
  await writeJson(project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.json`, intent);
  if (withJournal) await new FilePublicationJournal(join(project, 'qa/publication/zernio-journal.jsonl')).append({
    schemaVersion: 1, idempotencyKey: intent.idempotencyKey, attempt: 1, outcome: 'uncertain',
    at: deps.media.clock.now().toISOString(), detail: 'Original interrupted submit; never retry',
  });
  return intent;
}

function proofPost(intent: CreatorIntent, id = 'proven-remote', status = 'published'): ProofPost {
  if (!intent.evidence) throw new Error('Proof fixture requires original evidence');
  return {
    _id: id, profileId: intent.evidence.profileId, content: intent.evidence.content,
    createdAt: intent.evidence.submittedAt,
    mediaItems: [{ url: intent.evidence.videoUrl, thumbnail: intent.evidence.coverUrl }],
    platforms: [{ platform: intent.platform, accountId: intent.accountId, profileId: intent.evidence.profileId,
      status, platformPostUrl: `https://social.example/${id}` }],
  };
}

function completeList(posts: ProofPost[], page = 1, total = posts.length) {
  return { posts, pagination: { page, limit: 100, total, pages: Math.max(1, Math.ceil(total / 100)) } };
}

function installGet(deps: CreatorDeps, calls: CreatorGetCall[], response: (url: URL) => { status?: number; body: unknown }): void {
  const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    calls.push({ method, path: `${url.pathname.replace(/^.*\/v1/, '')}${url.search}` });
    if (method !== 'GET') throw new Error('Reconciliation must never POST');
    const answer = response(url);
    return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200, headers: { 'content-type': 'application/json' } });
  }, { preconnect: () => {} });
  deps.client = async () => new ZernioClient({ apiKey: 'do-not-persist-api-secret', fetchImpl, maxAttempts: 1 });
}

async function snapshotFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) files.push(...await snapshotFiles(join(directory, entry.name), `${name}/`));
    else files.push(`${name}:${sha256(await readFile(join(directory, entry.name)))}`);
  }
  return files;
}

describe('creator safe publishing (offline)', () => {
  test('one selected destination submits without changing approved snapshot, draft or digest; unselected health/capability is irrelevant', async () => {
    const f = await fixture({ wrongAccount: true, unhealthy: true, canPostMore: false });
    const target = f.preset.publishing.targets[3]!;
    const snapshotBefore = await readFile(join(f.project, 'preset.snapshot.json'));
    const draftBefore = await readFile(join(f.project, 'publication', 'draft.json'));
    const before = await planPublication(f.project, 0);
    const options: CreatorPublishOptions = { confirm: true, spendCap: 0, targetAccountIds: Object.freeze([target.accountId]) };
    const results = await publishCreator(f.project, f.deps, options);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ platform: 'twitter', accountId: target.accountId, state: 'published' });
    const posts = f.calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body!.platforms).toEqual([{ platform: target.platform, accountId: target.accountId }]);
    expect(f.calls.some((call) => call.path.includes('creator-info'))).toBe(false);
    expect(await readFile(join(f.project, 'preset.snapshot.json'))).toEqual(snapshotBefore);
    expect(await readFile(join(f.project, 'publication', 'draft.json'))).toEqual(draftBefore);
    expect((await planPublication(f.project, 0)).digest).toBe(before.digest);
    expect((await statusCreator(f.project, f.deps, true)).filter((result) => result.state === 'not-started')).toHaveLength(3);
  });
  test('unknown and duplicate target IDs reject before client, media processes, storage or POST', async () => {
    const f = await fixture();
    const before = f.counts();
    const accountId = f.preset.publishing.targets[0]!.accountId;
    await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: ['unknown'] })).rejects.toThrow('approved account IDs');
    await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [accountId, accountId] })).rejects.toThrow('unique account IDs');
    const client = await f.deps.client();
    await expect(remotePreflight(client, f.deps, f.preset, 10, ['unknown'])).rejects.toMatchObject({ kind: 'identity', scope: 'shared' });
    await expect(remotePreflight(client, f.deps, f.preset, 10, [accountId, accountId])).rejects.toMatchObject({ kind: 'identity', scope: 'shared' });
    expect(f.calls).toHaveLength(0);
    expect(f.counts()).toEqual({ ...before, clientCalls: before.clientCalls + 1 });
    expect(f.media.calls.secrets).toHaveLength(0);
  });
  test('empty explicit scope is a zero-effect no-op, even without execution confirmation or cap', async () => {
    const f = await fixture();
    const before = f.counts();
    const ffmpegCalls = f.media.calls.ffmpeg.length;
    const filesBefore = await readdir(join(f.project, 'publication'));
    expect(await publishCreator(f.project, f.deps, { confirm: false, spendCap: undefined, targetAccountIds: [] })).toEqual([]);
    expect(f.calls).toHaveLength(0);
    expect(f.counts()).toEqual(before);
    expect(f.media.calls.ffmpeg).toHaveLength(ffmpegCalls);
    expect(f.media.calls.secrets).toHaveLength(0);
    expect(await readdir(join(f.project, 'publication'))).toEqual(filesBefore);
    const client = await f.deps.client();
    await remotePreflight(client, f.deps, f.preset, 10, []);
    expect(f.calls).toHaveLength(0);
  });
  test('exact text, profile, HTTPS URLs and submit time are persisted before each POST without secrets or raw receipts', async () => {
    const f = await fixture();
    await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 });
    const posts = f.calls.filter((call) => call.method === 'POST');
    expect(f.submittedIntents).toHaveLength(4);
    for (const [index, intent] of f.submittedIntents.entries()) {
      const body = posts[index]!.body!;
      const attachments = body.mediaItems;
      expect(Array.isArray(attachments)).toBe(true);
      if (!Array.isArray(attachments)) throw new Error('Expected media items');
      const content = body.content;
      const attachment = record(attachments[0]);
      const videoUrl = attachment.url;
      const coverUrl = attachment.thumbnail;
      if (typeof content !== 'string' || typeof videoUrl !== 'string' || typeof coverUrl !== 'string') {
        throw new Error('Expected text content and media URLs');
      }
      expect(intent.evidence).toEqual({
        profileId: f.preset.publishing.profile.id,
        content,
        videoUrl,
        coverUrl,
        submittedAt: f.media.clock.now().toISOString(),
      });
      expect(Object.keys(intent.evidence!).sort()).toEqual(['content', 'coverUrl', 'profileId', 'submittedAt', 'videoUrl']);
      const bytes = await readFile(join(f.project, 'publication', 'intents', `${intent.idempotencyKey.slice('creator:'.length)}.json`), 'utf8');
      expect(bytes).not.toContain('offline-test-key');
      expect(bytes).not.toContain('authorization');
      expect(bytes).not.toContain('remote-');
    }
  });
  test('selected unhealthy/cannot-post account still blocks before any upload', async () => {
    const f = await fixture({ unhealthy: true });
    await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [f.preset.publishing.targets[2]!.accountId] })).rejects.toMatchObject({ kind: 'identity', scope: 'account', accountId: f.preset.publishing.targets[2]!.accountId });
    expect(f.counts().storageCalls).toBe(0);
    expect(f.counts().puts).toBe(0);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
  test('subset never ignores the whole-project ledger, including an attempt opened between two submits', async () => {
    const blocked = await fixture();
    const unresolved = { schemaVersion: 1 as const, attemptId: 'attempt-1', planDigest: 'b'.repeat(64), command: 'gen-media', subject: 'gen-media:scene:abc', state: 'uncertain' as const, reservedUsd: 0.5, createdAt: '2026-01-01T00:00:00.000Z' };
    await new FileSpendLedger(spendLedgerPath(blocked.project)).append(unresolved);
    await expect(publishCreator(blocked.project, blocked.deps, { confirm: true, spendCap: 0, targetAccountIds: [blocked.preset.publishing.targets[3]!.accountId] })).rejects.toThrow('paid attempts');
    expect(blocked.calls).toHaveLength(0);
    expect(blocked.counts().clientCalls).toBe(0);
    expect(blocked.counts().storageCalls).toBe(0);
    const f = await fixture();
    f.controls.beforePost = async () => { await new FileSpendLedger(spendLedgerPath(f.project)).append(unresolved); };
    const targets = f.preset.publishing.targets.slice(0, 2).map((target) => target.accountId);
    const result = await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: targets });
    expect(result.map((item) => item.state)).toEqual(['published', 'uncertain']);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: targets })).rejects.toThrow('paid attempts');
  });
  test('subset still gates unselected local project constraints and approval', async () => {
    const f = await fixture();
    const { draft } = await loadProject(f.project);
    await writeJson(f.project, 'publication/draft.json', { ...draft, platformContent: { ...draft.platformContent, twitter: 'x'.repeat(281) } });
    const plan = await planPublication(f.project, 0);
    await writeJson(f.project, 'publication/draft.json', { ...draft, platformContent: { ...draft.platformContent, twitter: 'x'.repeat(281) }, approval: { approved: true, digest: plan.digest } });
    await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [f.preset.publishing.targets[0]!.accountId] })).rejects.toThrow('twitter: text exceeds');
    expect(f.calls).toHaveLength(0);
  });
  test('upload hashes and whole-project hashes are rechecked after remote preflight and between targets', async () => {
    const changed = await fixture();
    const storage = changed.deps.storage;
    changed.deps.storage = async () => {
      await writeFile(join(changed.project, 'renders', 'final.mp4'), 'changed after remote preflight');
      return storage();
    };
    await expect(publishCreator(changed.project, changed.deps, { confirm: true, spendCap: 0, targetAccountIds: [changed.preset.publishing.targets[3]!.accountId] })).rejects.toThrow('Media changed');
    expect(changed.counts().puts).toBe(0);
    expect(changed.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    const f = await fixture();
    f.controls.beforePost = async () => { await writeFile(join(f.project, 'renders', 'cover.png'), 'changed after first POST'); };
    const result = await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: f.preset.publishing.targets.slice(0, 2).map((target) => target.accountId) });
    expect(result.map((item) => item.state)).toEqual(['published', 'uncertain']);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  });
  test('a reapproved digest never replaces an existing claim or permits its second POST', async () => {
    const f = await fixture();
    const accountId = f.preset.publishing.targets[3]!.accountId;
    const options = { confirm: true, spendCap: 0, targetAccountIds: [accountId] };
    const [first] = await publishCreator(f.project, f.deps, options);
    const file = join(f.project, 'publication', 'intents', `${first!.idempotencyKey.slice('creator:'.length)}.json`);
    const before = await readFile(file);
    const { draft } = await loadProject(f.project);
    const updated = { ...draft, platformContent: { ...draft.platformContent, twitter: 'Different approved text' } };
    await writeJson(f.project, 'publication/draft.json', updated);
    const plan = await planPublication(f.project, 0);
    await writeJson(f.project, 'publication/draft.json', { ...updated, approval: { approved: true, digest: plan.digest } });
    const callCount = f.calls.length;
    await expect(publishCreator(f.project, f.deps, options)).rejects.toThrow('digest/identity mismatch');
    expect(f.calls).toHaveLength(callCount);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(await readFile(file)).toEqual(before);
  });
  test('legacy crash claims allow GET only, no storage or proof fabrication; mismatched and torn claims remain barriers', async () => {
    const f = await fixture();
    const plan = await planPublication(f.project, 0);
    const target = f.preset.publishing.targets[3]!;
    const key = `creator:${sha256(`unique-video:${plan.media!.videoSha256}:${target.accountId}`)}`;
    const relative = `publication/intents/${key.slice('creator:'.length)}.json`;
    const legacy = { schemaVersion: 1, idempotencyKey: key, platform: target.platform, accountId: target.accountId, projectId: 'unique-video', videoSha256: plan.media!.videoSha256, digest: plan.digest };
    await writeJson(f.project, relative, legacy);
    const bytes = await readFile(join(f.project, relative));
    const result = await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [target.accountId] });
    expect(result[0]!.state).toBe('uncertain');
    expect(f.calls.length).toBeGreaterThan(0);
    expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(f.counts().storageCalls).toBe(0);
    expect(await readFile(join(f.project, relative))).toEqual(bytes);
    expect(CreatorIntentSchema.parse(legacy).evidence).toBeUndefined();
    for (const corruption of [{ projectId: 'different-project' }, { platform: 'youtube' }, { accountId: 'unknown-account' }, { idempotencyKey: `creator:${'b'.repeat(64)}` }]) {
      await writeJson(f.project, relative, { ...legacy, ...corruption });
      await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [target.accountId] })).rejects.toThrow('mismatch');
    }
    await writeJson(f.project, relative, legacy);
    await writeJson(f.project, `publication/intents/${'a'.repeat(64)}.json`, legacy);
    await expect(statusCreator(f.project, f.deps, true)).rejects.toThrow('file key mismatch');
    await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [target.accountId] })).rejects.toThrow('file key mismatch');
    await rm(join(f.project, 'publication', 'intents', `${'a'.repeat(64)}.json`));
    await writeFile(join(f.project, relative), '{"schemaVersion":1');
    await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [target.accountId] })).rejects.toThrow();
    expect(await readFile(join(f.project, relative), 'utf8')).toBe('{"schemaVersion":1');
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });
  test('concurrent, interrupted and repeated subset runs have exactly one POST and retain the original payload proof', async () => {
    const f = await fixture({ uncertain: 'twitter' });
    const options: CreatorPublishOptions = { confirm: true, spendCap: 0, targetAccountIds: [f.preset.publishing.targets[3]!.accountId] };
    const [first, second] = await Promise.all([
      publishCreator(f.project, f.deps, options),
      publishCreator(f.project, f.deps, options),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    const relative = `publication/intents/${first[0]!.idempotencyKey.slice('creator:'.length)}.json`;
    const bytes = await readFile(join(f.project, relative));
    expect(CreatorIntentSchema.parse(JSON.parse(bytes.toString('utf8'))).evidence).toBeDefined();
    const before = f.counts();
    const callCount = f.calls.length;
    expect((await publishCreator(f.project, f.deps, options))[0]!.state).toBe('uncertain');
    expect(f.calls.slice(callCount).every((call) => call.method === 'GET')).toBe(true);
    expect(f.counts().storageCalls).toBe(before.storageCalls);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(await readFile(join(f.project, relative))).toEqual(bytes);
  });
  test('same workflow handles a second client, single Facebook target and different media policy without leobar defaults', async () => {
    const f = await fixture({ secondClient: true, synthetic: false, duration: 150 });
    const loaded = await loadProject(f.project);
    expect(loaded.manifest.preset.id).toBe('client-two');
    expect(loaded.preset.editing).toMatchObject({ width: 1280, height: 720, fps: 24 });
    expect(await readFile(join(f.project, 'preset.snapshot.json'), 'utf8')).not.toContain('leobar');
    const result = await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ platform: 'facebook', accountId: 'facebook-two', state: 'published' });
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.calls.some((call) => call.path.includes('creator-info'))).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain('6ab44');
    expect((await statusCreator(f.project, f.deps))).toHaveLength(1);
  });
  test('four independent results reuse engine and wire exact metadata, tags, profile, TikTok and YouTube disclosure', async () => {
    const f = await fixture();
    const results = await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 });
    expect(results.map((r) => r.state)).toEqual(['published', 'published', 'published', 'published']);
    const submits = f.calls.filter((call) => call.method === 'POST');
    expect(submits).toHaveLength(4);
    const tiktok = submits[0]!.body!;
    expect(tiktok.tags).toEqual(['edición', 'Remotion']);
    expect(tiktok.title).toBe('Mi título');
    expect(tiktok.tiktokSettings).toMatchObject({ privacy_level: 'PUBLIC_TO_EVERYONE', video_made_with_ai: true, allow_comment: true, allow_duet: false, allow_stitch: false, content_preview_confirmed: true, express_consent_given: true });
    expect(submits[1]!.body!.platforms).toEqual([{ platform: 'youtube', accountId: f.preset.publishing.targets[1]!.accountId, platformSpecificData: { title: 'Mi título', visibility: 'public', madeForKids: false, categoryId: '28', containsSyntheticMedia: true } }]);
    expect(submits[3]!.body!.content).toBe('Mi texto X');
    expect(f.counts().puts).toBe(2);
    const intentFiles = await readdir(join(f.project, 'publication', 'intents'));
    expect(intentFiles).toHaveLength(8);
    expect(intentFiles.every((name) => /^[a-f0-9]{64}(?:\.result)?\.json$/.test(name))).toBe(true);
    expect(f.media.calls.submits).toHaveLength(0);
  });
  test('AI disclosure is absent for explicitly non-synthetic media', async () => {
    const f = await fixture({ synthetic: false });
    await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 });
    const submits = f.calls.filter((call) => call.method === 'POST');
    expect(record(submits[0]!.body!.tiktokSettings).video_made_with_ai).toBeUndefined();
    expect(JSON.stringify(submits[1]!.body)).not.toContain('containsSyntheticMedia');
  });
  test('confirm, cap and all account/profile/TikTok gates block before upload/POST', async () => {
    const f = await fixture();
    await expect(publishCreator(f.project, f.deps, { confirm: false, spendCap: 0 })).rejects.toThrow('--confirm');
    await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: undefined })).rejects.toThrow('--spend-cap');
    expect(f.calls).toHaveLength(0);
    for (const controls of [{ wrongProfile: true }, { wrongAccount: true }, { unhealthy: true }, { privacy: true }, { capacity: 5 }, { canPostMore: false }, { commentsDisabled: true }]) {
      const blocked = await fixture(controls);
      await expect(publishCreator(blocked.project, blocked.deps, { confirm: true, spendCap: 0 })).rejects.toThrow();
      expect(blocked.counts().storageCalls).toBe(0);
      expect(blocked.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    }
  });
  test('QA remeasures current media, requires decode, valid format and loudness; storage SHA verification blocks submit', async () => {
    const bad = await fixture({ loudness: -12 });
    await expect(runCreatorQa(bad.project, bad.deps.media)).rejects.toThrow();
    const f = await fixture({ corruptStorage: true });
    await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 })).rejects.toThrow('checksum');
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    f.controls.corruptStorage = false;
    const goodProcess = f.deps.media.process;
    f.deps.media.process = { run: async (command, args) => command === 'ffmpeg' ? { code: 1, stdout: '', stderr: 'decode failed' } : goodProcess.run(command, args) };
    await expect(publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 })).rejects.toThrow('decode');
  });
  test('repeat and concurrent invocations never cause POST2; pending receipt never marks publication complete', async () => {
    const f = await fixture({ pending: true });
    const [first, second] = await Promise.all([
      publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 }),
      publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 }),
    ]);
    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
    const repeated = await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 });
    expect(repeated.every((result) => result.state === 'pending')).toBe(true);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
    const directories = (await readdir(join(f.project, 'qa', 'publication'))).filter((name) => name !== 'zernio-journal.jsonl');
    for (const directory of directories) {
      const journal = record(JSON.parse(await readFile(join(f.project, 'qa', 'publication', directory, 'journal.json'), 'utf8')));
      expect(journal.outcome).toBe('accepted');
      expect(journal.stages).not.toContain('complete');
    }
  });
  test('uncertain and rejected targets do not resend successes; status is GET-only and preserves local files', async () => {
    const f = await fixture({ uncertain: 'youtube', rejected: 'linkedin' });
    const first = await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 });
    expect(first.map((r) => r.state)).toEqual(['published', 'uncertain', 'failed', 'published']);
    const directory = join(f.project, 'publication', 'intents');
    const before = await Promise.all((await readdir(directory)).sort().map(async (name) => `${name}:${sha256(await readFile(join(directory, name)))}`));
    const callCount = f.calls.length;
    const status = await statusCreator(f.project, f.deps);
    expect(status).toHaveLength(4);
    expect(status.map((result) => result.state)).toEqual(['published', 'uncertain', 'uncertain', 'published']);
    expect(f.calls.slice(callCount).every((call) => call.method === 'GET')).toBe(true);
    expect(await Promise.all((await readdir(directory)).sort().map(async (name) => `${name}:${sha256(await readFile(join(directory, name)))}`))).toEqual(before);
    await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 });
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
  });
  test('crash after durable intent but before receipt never submits that target again', async () => {
    const f = await fixture();
    const plan = await planPublication(f.project, 0);
    const target = f.preset.publishing.targets[0]!;
    const key = `creator:${sha256(`unique-video:${plan.media!.videoSha256}:${target.accountId}`)}`;
    await writeJson(f.project, `publication/intents/${key.slice('creator:'.length)}.json`, { schemaVersion: 1, idempotencyKey: key, platform: target.platform, accountId: target.accountId, projectId: 'unique-video', videoSha256: plan.media!.videoSha256, digest: plan.digest });
    const results = await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 });
    expect(results[0]!.state).toBe('uncertain');
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(3);
  });
});

describe('creator queue policy preflight (offline adapters only)', () => {
  test('confirmed positive capacity permits required-capacity and reports frozen, validated observations', async () => {
    const f = await fixture();
    let capacityChecks = 0;
    f.deps.capacity = async (target, checkedAt) => { capacityChecks++; return confirmedCapacity(target, checkedAt, 2); };
    const observed: CreatorBatchCapacityObservation[] = [];
    const result = await publishCreator(f.project, f.deps, {
      confirm: true, spendCap: 0, queuePolicy: 'require-capacity',
      onCapacity: (capacity) => {
        expect(Object.isFrozen(capacity)).toBe(true);
        expect(capacity.every((item) => Object.isFrozen(item))).toBe(true);
        observed.push(...capacity);
      },
    });
    expect(result.every((target) => target.state === 'published')).toBe(true);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(4);
    expect(capacityChecks).toBeGreaterThanOrEqual(12); // Initial, immediately before claim, and before each wire.
    expect(observed.every((item) => item.status === 'confirmed' && item.remaining === 2)).toBe(true);
    expect(observed.some((item) => item.platform === 'tiktok' && item.canPostMore === true)).toBe(true);
  });

  test('unknown, estimated, stale, exhausted and source failures refuse require-capacity before uploads or fresh claims', async () => {
    const sources: Array<CreatorCapacitySource | undefined> = [
      undefined,
      async (target, checkedAt) => ({ ...confirmedCapacity(target, checkedAt), status: 'estimated' }),
      async (target, checkedAt) => confirmedCapacity(target, new Date(checkedAt.getTime() - 120_000)),
      async (target, checkedAt) => confirmedCapacity(target, checkedAt, 0),
      async () => { throw new Error('secret-capacity-source-must-not-leak'); },
    ];
    for (const capacity of sources) {
      const f = await fixture();
      f.deps.capacity = capacity;
      const before = await snapshotFiles(f.project);
      let failure: unknown;
      try {
        await publishCreator(f.project, f.deps, {
          confirm: true, spendCap: 0, queuePolicy: 'require-capacity',
          targetAccountIds: [f.preset.publishing.targets[0]!.accountId],
        });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(CreatorPreflightError);
      expect(failure).toMatchObject({ kind: 'quota', scope: 'account' });
      expect(String(failure)).not.toContain('secret-capacity-source');
      expect(f.counts().storageCalls).toBe(0);
      expect(f.counts().puts).toBe(0);
      expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
      expect(await snapshotFiles(f.project)).toEqual(before);
    }
  });

  test('default provider queue policy permits unknown or estimated capacity without inventing a numeric quota', async () => {
    for (const estimated of [false, true]) {
      const f = await fixture();
      if (estimated) f.deps.capacity = async (target, checkedAt) => ({ ...confirmedCapacity(target, checkedAt), status: 'estimated' });
      const observed: CreatorBatchCapacityObservation[] = [];
      const result = await publishCreator(f.project, f.deps, {
        confirm: true, spendCap: 0, targetAccountIds: [f.preset.publishing.targets[0]!.accountId],
        onCapacity: (capacity) => { observed.push(...capacity); },
      });
      expect(result[0]?.state).toBe('published');
      expect(observed[0]).toMatchObject({ status: estimated ? 'estimated' : 'unknown', canPostMore: true });
      if (!estimated) {
        expect(observed[0]?.remaining).toBeUndefined();
        expect(observed[0]?.resetAt).toBeUndefined();
        expect(observed[0]?.nextRetryAt).toBeUndefined();
      }
    }
  });

  test('capacity lost during storage initialization is rechecked before any fresh durable claim', async () => {
    const f = await fixture();
    const target = f.preset.publishing.targets[3]!;
    let remaining = 1;
    f.deps.capacity = async (account, checkedAt) => confirmedCapacity(account, checkedAt, remaining);
    const storage = f.deps.storage;
    f.deps.storage = async () => { remaining = 0; return storage(); };
    await expect(publishCreator(f.project, f.deps, {
      confirm: true, spendCap: 0, queuePolicy: 'require-capacity', targetAccountIds: [target.accountId],
    })).rejects.toMatchObject({ kind: 'quota', accountId: target.accountId });
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    expect((await snapshotFiles(f.project)).some((file) => file.startsWith('publication/intents/'))).toBe(false);
  });

  test('capacity lost after validation refuses the wire but preserves its already durable key permanently', async () => {
    const f = await fixture();
    const target = f.preset.publishing.targets[3]!;
    let remaining = 1;
    f.deps.capacity = async (account, checkedAt) => confirmedCapacity(account, checkedAt, remaining);
    f.controls.beforeValidate = async () => { remaining = 0; };
    const options: CreatorPublishOptions = { confirm: true, spendCap: 0, queuePolicy: 'require-capacity', targetAccountIds: [target.accountId] };
    await expect(publishCreator(f.project, f.deps, options)).rejects.toMatchObject({ kind: 'quota', scope: 'account', accountId: target.accountId });
    const files = (await readdir(join(f.project, 'publication', 'intents'))).filter((file) => !file.endsWith('.result.json'));
    expect(files).toHaveLength(1);
    const path = join(f.project, 'publication', 'intents', files[0]!);
    const claim = await readFile(path);
    remaining = 2;
    await publishCreator(f.project, f.deps, options);
    expect(await readFile(path)).toEqual(claim);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  test('HTTP207 queue race after positive capacity preserves pending ID through concurrent and repeated execution', async () => {
    const f = await fixture({ pending: true });
    const target = f.preset.publishing.targets[3]!;
    f.deps.capacity = async (account, checkedAt) => confirmedCapacity(account, checkedAt);
    const options: CreatorPublishOptions = { confirm: true, spendCap: 0, queuePolicy: 'require-capacity', targetAccountIds: [target.accountId] };
    const concurrent = await Promise.all([publishCreator(f.project, f.deps, options), publishCreator(f.project, f.deps, options)]);
    expect(concurrent.flat().some((result) => result.state === 'pending' && result.remoteId === 'remote-twitter')).toBe(true);
    const before = f.counts();
    const files = await snapshotFiles(f.project);
    f.deps.capacity = async () => { throw new Error('Capacity must not be queried for an existing immutable claim'); };
    const repeated = await publishCreator(f.project, f.deps, options);
    expect(repeated[0]).toMatchObject({ state: 'pending', remoteId: 'remote-twitter' });
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.counts().storageCalls).toBe(before.storageCalls);
    expect(f.counts().puts).toBe(before.puts);
    expect(await snapshotFiles(f.project)).toEqual(files);
  });

  test('client/storage credential and TLS failures are safe typed shared errors before any upload', async () => {
    const stages: Array<'client' | 'storage'> = ['client', 'storage'];
    for (const stage of stages) {
      for (const tls of [false, true]) {
        const f = await fixture();
        const fail = async (): Promise<never> => {
          throw Object.assign(new Error('secret-preflight-must-not-leak'), tls ? { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } } : {});
        };
        if (stage === 'client') f.deps.client = fail;
        else f.deps.storage = fail;
        let failure: unknown;
        try { await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0 }); }
        catch (error) { failure = error; }
        expect(failure).toBeInstanceOf(CreatorPreflightError);
        expect(failure).toMatchObject({ kind: tls ? 'tls' : 'credential', scope: 'shared' });
        expect(String(failure)).not.toContain('secret-preflight');
        expect(JSON.stringify(failure)).not.toContain('secret-preflight');
        expect(f.counts().puts).toBe(0);
        expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
        expect((await snapshotFiles(f.project)).some((file) => file.startsWith('publication/intents/'))).toBe(false);
      }
    }
  });
});

describe('creator durable intent contract', () => {
  const legacy: CreatorIntent = {
    schemaVersion: 1, idempotencyKey: `creator:${'a'.repeat(64)}`, platform: 'twitter', accountId: 'account',
    projectId: 'project', videoSha256: 'b'.repeat(64), digest: 'c'.repeat(64),
  };
  const evidence = {
    profileId: 'profile', content: 'Exact original text #IA',
    videoUrl: 'https://cdn.example/video.mp4', coverUrl: 'https://cdn.example/cover.png',
    submittedAt: '2026-10-03T10:00:00.000Z',
  };
  test('v1 legacy files remain valid without evidence and new files retain exact optional evidence', () => {
    expect(CreatorIntentSchema.parse(legacy)).toEqual(legacy);
    expect(CreatorIntentSchema.parse({ ...legacy, evidence })).toEqual({ ...legacy, evidence });
  });
  test('intent and evidence stay strict, including headers/auth/raw-response rejection and ISO timestamps', () => {
    expect(CreatorIntentSchema.safeParse({ ...legacy, authorization: 'secret' }).success).toBe(false);
    for (const extra of [{ headers: { authorization: 'secret' } }, { auth: 'secret' }, { response: { post: {} } }]) {
      expect(CreatorIntentSchema.safeParse({ ...legacy, evidence: { ...evidence, ...extra } }).success).toBe(false);
    }
    expect(CreatorIntentSchema.safeParse({ ...legacy, evidence: { ...evidence, submittedAt: 'today' } }).success).toBe(false);
    expect(CreatorIntentSchema.safeParse({ ...legacy, digest: undefined, evidence }).success).toBe(false);
  });
  test('both evidence media URLs require HTTPS public locations without inline credentials', () => {
    for (const url of [
      'http://cdn.example/video.mp4', 'not-a-url', 'https://localhost/video.mp4',
      'https://127.0.0.1/video.mp4', 'https://10.0.0.1/video.mp4', 'https://172.16.0.1/video.mp4',
      'https://192.168.1.2/video.mp4', 'https://100.64.0.1/video.mp4', 'https://169.254.1.1/video.mp4',
      'https://[::1]/video.mp4', 'https://[fc00::1]/video.mp4', 'https://user:password@cdn.example/video.mp4',
    ]) {
      expect(CreatorIntentSchema.safeParse({ ...legacy, evidence: { ...evidence, videoUrl: url } }).success).toBe(false);
      expect(CreatorIntentSchema.safeParse({ ...legacy, evidence: { ...evidence, coverUrl: url } }).success).toBe(false);
    }
  });
});

describe('creator TikTok capability assertion (documented camelCase)', () => {
  const interaction = (enabled: boolean) => ({ enabled, required: true, default: true, label: 'Toggle' });
  const capability = (overrides: Record<string, unknown> = {}): CreatorTikTokCapability => TikTokCapabilitySchema.parse({
    creator: { nickname: 'c', avatarUrl: 'https://cdn.example/a.png', isVerified: false, canPostMore: true },
    privacyLevels: [{ value: 'PUBLIC_TO_EVERYONE', label: 'Everyone' }],
    postingLimits: { maxVideoDurationSec: 600, interactionSettings: { allow_comment: interaction(true), allow_duet: interaction(true), allow_stitch: interaction(true) } },
    ...overrides,
  });
  const settings = { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: false, allowStitch: false };
  test('accepts the documented camelCase response within duration headroom', () => {
    expect(() => assertTikTokCapability(capability(), settings, 140)).not.toThrow();
  });
  test('rejects creator.canPostMore false, an unavailable privacy level and over-duration', () => {
    expect(() => assertTikTokCapability(capability({ creator: { nickname: 'c', avatarUrl: 'https://cdn.example/a.png', isVerified: false, canPostMore: false } }), settings, 10)).toThrow();
    expect(() => assertTikTokCapability(capability({ privacyLevels: [{ value: 'SELF_ONLY', label: 'Only me' }] }), settings, 10)).toThrow();
    expect(() => assertTikTokCapability(capability(), { ...settings, allowComment: false }, 601)).toThrow();
  });
  test('rejects a disabled comment and a null duet/stitch descriptor when required, never reading "default" as consent', () => {
    expect(() => assertTikTokCapability(capability({ postingLimits: { maxVideoDurationSec: 600, interactionSettings: { allow_comment: interaction(false), allow_duet: interaction(true), allow_stitch: interaction(true) } } }), settings, 10)).toThrow();
    const photo = capability({ postingLimits: { maxVideoDurationSec: 600, interactionSettings: { allow_comment: interaction(true), allow_duet: null, allow_stitch: null } } });
    expect(() => assertTikTokCapability(photo, { ...settings, allowDuet: true }, 10)).toThrow();
    expect(() => assertTikTokCapability(photo, settings, 10)).not.toThrow();
  });
});

describe('creator GET proof and audited reconciliation (offline)', () => {
  test('publication diagnostics never copy secret-bearing raw transport causes or rejection messages into creator receipts', async () => {
    const secret = 'https://provider.example/?token=raw-transport-secret Authorization: Bearer do-not-persist';
    for (const scenario of [
      { controls: { uncertain: 'twitter', uncertainDetail: secret }, state: 'uncertain', detail: 'Publication state unknown; GET reconciliation required; never resubmit' },
      { controls: { rejected: 'twitter', rejectedDetail: secret }, state: 'failed', detail: 'Provider rejected publication; no automatic retry' },
    ]) {
      const f = await fixture(scenario.controls);
      const accountId = f.preset.publishing.targets.at(-1)!.accountId;
      const [result] = await publishCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [accountId] });
      expect(result).toMatchObject({ state: scenario.state, detail: scenario.detail });
      expect(JSON.stringify(result)).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain('raw-transport-secret');
      const receipt = await readFile(join(f.project, `publication/intents/${result!.idempotencyKey.slice('creator:'.length)}.result.json`), 'utf8');
      expect(receipt).not.toContain('raw-transport-secret');
      expect(receipt).not.toContain('Authorization');
      expect((await readdir(join(f.project, 'publication'))).includes('reconciliations.jsonl')).toBe(false);
    }
  });

  test('repairs a historical false HTTP 207 failure to pending on the same journal attempt, without replacing history', async () => {
    const f = await fixture();
    const intent = await seedClaim(f.project, f.deps, f.preset);
    const journal = new FilePublicationJournal(join(f.project, 'qa/publication/zernio-journal.jsonl'));
    await journal.append({ schemaVersion: 1, idempotencyKey: intent.idempotencyKey, attempt: 1,
      outcome: 'failed', at: f.media.clock.now().toISOString(), remoteId: 'old-207', detail: 'Historical HTTP 207 misclassification' });
    const relative = `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.result.json`;
    await writeJson(f.project, relative, { platform: intent.platform, accountId: intent.accountId,
      idempotencyKey: intent.idempotencyKey, state: 'failed', remoteId: 'old-207' });
    const before = await readFile(journal.path, 'utf8');
    const post = proofPost(intent, 'old-207', 'pending');
    post.platforms[0]!.errorMessage = 'do-not-persist-raw-error-secret';
    installGet(f.deps, f.calls, () => ({ body: { post } }));
    const result = await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] });
    expect(result[0]).toMatchObject({ state: 'pending', remoteId: 'old-207' });
    expect(result[0]!.url).toBeUndefined();
    expect((await readFile(journal.path, 'utf8')).startsWith(before)).toBe(true);
    expect((await journal.readAll()).map((entry) => [entry.attempt, entry.outcome])).toEqual([[1, 'uncertain'], [1, 'failed'], [1, 'accepted']]);
    const receipt = record(JSON.parse(await readFile(join(f.project, relative), 'utf8')));
    expect(receipt.state).toBe('pending');
    const audit = record(JSON.parse((await readFile(join(f.project, 'publication/reconciliations.jsonl'), 'utf8')).trim()));
    expect(audit.source).toBe('remote-id');
    expect(audit.previous).toEqual({ state: 'failed', remoteId: 'old-207' });
    expect(audit.result).toEqual({ state: 'pending', remoteId: 'old-207' });
    const evidence = `${await readFile(journal.path, 'utf8')}${JSON.stringify(audit)}${JSON.stringify(receipt)}`;
    expect(evidence).not.toContain('do-not-persist-raw-error-secret');
    expect(evidence).not.toContain('do-not-persist-api-secret');
    expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(f.counts().storageCalls).toBe(0);
    expect(f.media.calls.secrets).toHaveLength(0);
  });

  test('GET pending to published uses the correct target URL and status preserves every project byte', async () => {
    const f = await fixture();
    const intent = await seedClaim(f.project, f.deps, f.preset);
    await writeJson(f.project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.result.json`,
      { platform: intent.platform, accountId: intent.accountId, idempotencyKey: intent.idempotencyKey, state: 'pending', remoteId: 'known' });
    const post = proofPost(intent, 'known');
    post.platforms.unshift({ platform: 'youtube', accountId: 'other', status: 'published', platformPostUrl: 'https://social.example/not-this-target' });
    installGet(f.deps, f.calls, () => ({ body: { post } }));
    const before = await snapshotFiles(f.project);
    const results = await statusCreator(f.project, f.deps);
    expect(results.find((result) => result.accountId === intent.accountId)).toMatchObject({
      state: 'published', remoteId: 'known', url: 'https://social.example/known',
    });
    expect(await snapshotFiles(f.project)).toEqual(before);
    expect(f.calls).toEqual([{ method: 'GET', path: '/posts/known' }]);
  });

  test('a first unchanged pending reconciliation still audits GET proof without duplicating the existing attempt', async () => {
    const f = await fixture({ pending: true });
    const accountId = f.preset.publishing.targets.at(-1)!.accountId;
    const options = { confirm: true, spendCap: 0, targetAccountIds: [accountId] };
    const published = await publishCreator(f.project, f.deps, options);
    const journalPath = join(f.project, 'qa/publication/zernio-journal.jsonl');
    const before = await readFile(journalPath);
    const callCount = f.calls.length;
    expect((await reconcileCreator(f.project, f.deps, options))[0]!.state).toBe('pending');
    expect(await readFile(journalPath)).toEqual(before);
    const audit = record(JSON.parse((await readFile(join(f.project, 'publication/reconciliations.jsonl'), 'utf8')).trim()));
    expect(audit.previous).toEqual({ state: 'pending', remoteId: published[0]!.remoteId });
    expect(audit.result).toEqual({ state: 'pending', remoteId: published[0]!.remoteId });
    const after = await snapshotFiles(f.project);
    await reconcileCreator(f.project, f.deps, options);
    expect(await snapshotFiles(f.project)).toEqual(after);
    expect(f.calls.slice(callCount).every((call) => call.method === 'GET')).toBe(true);
  });

  test('known-ID evidence cannot borrow a wrong account/profile, ambiguous target or unknown target state', async () => {
    for (const mode of ['wrong-account', 'wrong-profile', 'ambiguous-target', 'unknown-target']) {
      const f = await fixture();
      const intent = await seedClaim(f.project, f.deps, f.preset);
      await writeJson(f.project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.result.json`,
        { platform: intent.platform, accountId: intent.accountId, idempotencyKey: intent.idempotencyKey, state: 'pending', remoteId: 'known' });
      const post = proofPost(intent, 'known');
      if (mode === 'wrong-account') post.platforms[0]!.accountId = 'wrong';
      if (mode === 'wrong-profile') post.profileId = 'wrong';
      if (mode === 'ambiguous-target') post.platforms.push({ ...post.platforms[0]! });
      if (mode === 'unknown-target') delete post.platforms[0]!.status;
      installGet(f.deps, f.calls, () => ({ body: { post } }));
      const before = await snapshotFiles(f.project);
      expect((await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] }))[0]).toMatchObject({ state: 'uncertain', remoteId: 'known' });
      expect(await snapshotFiles(f.project)).toEqual(before);
    }
  });

  test('unfiltered complete pages uniquely prove full original payload; check time never widens the original ±5min window', async () => {
    const f = await fixture();
    const intent = await seedClaim(f.project, f.deps, f.preset);
    f.media.clock = { now: () => new Date('2026-10-03T10:00:00.000Z') };
    const unrelated = Array.from({ length: 100 }, (_, index) => ({ ...proofPost(intent, `other-${index}`), content: 'Other content' }));
    installGet(f.deps, f.calls, (url) => ({ body: url.searchParams.get('offset') === '0'
      ? completeList(unrelated, 1, 101) : completeList([proofPost(intent)], 2, 101) }));
    const results = await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] });
    expect(results[0]).toMatchObject({ state: 'published', remoteId: 'proven-remote' });
    expect(f.calls).toEqual([{ method: 'GET', path: '/posts?limit=100&offset=0' }, { method: 'GET', path: '/posts?limit=100&offset=100' }]);
    expect(await readFile(join(f.project, 'publication/reconciliations.jsonl'), 'utf8')).toContain('"source":"payload"');
    expect((await new FilePublicationJournal(join(f.project, 'qa/publication/zernio-journal.jsonl')).readAll()).map((entry) => entry.outcome)).toEqual(['uncertain', 'published']);
  });

  test('exact echoed key works for a legacy claim without fabricating payload; an unrelated first item is never borrowed', async () => {
    const f = await fixture();
    const intent = await seedClaim(f.project, f.deps, f.preset);
    const { evidence: _evidence, ...legacy } = intent;
    const relative = `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.json`;
    await writeJson(f.project, relative, legacy);
    const bytes = await readFile(join(f.project, relative));
    const exact = { ...proofPost(intent, 'echoed'), idempotencyKey: intent.idempotencyKey };
    delete exact.content; delete exact.mediaItems; delete exact.createdAt;
    installGet(f.deps, f.calls, () => ({ body: completeList([{ ...proofPost(intent, 'first'), idempotencyKey: 'wrong-key' }, exact]) }));
    const result = await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] });
    expect(result[0]).toMatchObject({ state: 'published', remoteId: 'echoed' });
    expect(await readFile(join(f.project, relative))).toEqual(bytes);
    expect(await readFile(join(f.project, 'publication/reconciliations.jsonl'), 'utf8')).toContain('"source":"echoed-key"');
  });

  const invalidPayloads: Array<{ name: string; change: (post: ProofPost) => void }> = [
    { name: 'wrong account', change: (post) => { post.platforms[0]!.accountId = 'wrong'; } },
    { name: 'wrong profile', change: (post) => { post.profileId = 'wrong'; } },
    { name: 'wrong target profile', change: (post) => { post.platforms[0]!.profileId = 'wrong'; } },
    { name: 'wrong platform', change: (post) => { post.platforms[0]!.platform = 'youtube'; } },
    { name: 'wrong cover', change: (post) => { post.mediaItems![0]!.thumbnail = 'https://cdn.example/wrong.png'; } },
    { name: 'wrong video', change: (post) => { post.mediaItems![0]!.url = 'https://cdn.example/wrong.mp4'; } },
    { name: 'wrong exact content', change: (post) => { post.content += ' '; } },
    { name: 'outside original upper window', change: (post) => { post.createdAt = '2026-01-01T00:05:00.001Z'; } },
    { name: 'outside original lower window', change: (post) => { post.createdAt = '2025-12-31T23:54:59.999Z'; } },
    { name: 'missing cover proof', change: (post) => { delete post.mediaItems![0]!.thumbnail; } },
    { name: 'missing account proof', change: (post) => { delete post.platforms[0]!.accountId; } },
    { name: 'missing profile proof', change: (post) => { delete post.profileId; } },
    { name: 'missing content proof', change: (post) => { delete post.content; } },
    { name: 'missing window proof', change: (post) => { delete post.createdAt; } },
    { name: 'unknown remote target state', change: (post) => { post.platforms[0]!.status = 'unknown'; } },
  ];
  for (const scenario of invalidPayloads) test(`${scenario.name} is uncertain and cannot mutate files or release a claim`, async () => {
    const f = await fixture();
    const intent = await seedClaim(f.project, f.deps, f.preset);
    const post = proofPost(intent);
    scenario.change(post);
    installGet(f.deps, f.calls, () => ({ body: completeList([post]) }));
    const before = await snapshotFiles(f.project);
    const result = await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] });
    expect(result[0]!.state).toBe('uncertain');
    expect(await snapshotFiles(f.project)).toEqual(before);
    expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
    expect(f.counts().storageCalls).toBe(0);
  });

  test('ambiguity across complete pages and missing pagination never become unique proof', async () => {
    for (const mode of ['ambiguous', 'no-pagination', 'incomplete-page']) {
      const f = await fixture();
      const intent = await seedClaim(f.project, f.deps, f.preset);
      const first = [proofPost(intent, 'one'), ...Array.from({ length: 99 }, (_, index) => ({ ...proofPost(intent, `other-${index}`), content: 'unrelated' }))];
      installGet(f.deps, f.calls, (url) => ({ body: mode === 'no-pagination' ? { posts: [proofPost(intent)] }
        : mode === 'incomplete-page' ? completeList([proofPost(intent)], 1, 101)
        : url.searchParams.get('offset') === '0' ? completeList(first, 1, 101) : completeList([proofPost(intent, 'two')], 2, 101) }));
      const before = await snapshotFiles(f.project);
      expect((await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] }))[0]!.state).toBe('uncertain');
      expect(await snapshotFiles(f.project)).toEqual(before);
    }
  });

  test('legacy payload-only matches cannot repair a saved failed result without original proof', async () => {
    const f = await fixture();
    const intent = await seedClaim(f.project, f.deps, f.preset);
    const { evidence: _evidence, ...legacy } = intent;
    await writeJson(f.project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.json`, legacy);
    await writeJson(f.project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.result.json`,
      { platform: intent.platform, accountId: intent.accountId, idempotencyKey: intent.idempotencyKey, state: 'failed' });
    installGet(f.deps, f.calls, () => ({ body: completeList([proofPost(intent)]) }));
    const before = await snapshotFiles(f.project);
    expect((await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] }))[0]!.state).toBe('uncertain');
    expect(await snapshotFiles(f.project)).toEqual(before);
  });

  test('saved receipt identity is validated before its ID is used, and mismatched GET IDs remain uncertain retaining the hint', async () => {
    const f = await fixture();
    const intent = await seedClaim(f.project, f.deps, f.preset);
    const relative = `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.result.json`;
    installGet(f.deps, f.calls, () => ({ body: { post: proofPost(intent, 'different-id') } }));
    for (const mismatch of [{ accountId: 'wrong' }, { platform: 'youtube' }, { idempotencyKey: 'wrong-key' }]) {
      await writeJson(f.project, relative, { platform: intent.platform, accountId: intent.accountId, idempotencyKey: intent.idempotencyKey,
        state: 'pending', remoteId: 'must-not-use', ...mismatch });
      const before = await snapshotFiles(f.project);
      expect((await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] }))[0]!.state).toBe('uncertain');
      expect(f.calls).toHaveLength(0);
      expect(await snapshotFiles(f.project)).toEqual(before);
    }
    await writeJson(f.project, relative, { platform: intent.platform, accountId: intent.accountId, idempotencyKey: intent.idempotencyKey, state: 'pending', remoteId: 'expected-id' });
    const before = await snapshotFiles(f.project);
    expect((await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] }))[0]).toMatchObject({ state: 'uncertain', remoteId: 'expected-id' });
    expect(await snapshotFiles(f.project)).toEqual(before);
  });

  test('repeat reconciliation skips identical transitions and advances pending to published additively while the paid ledger stays open', async () => {
    const f = await fixture();
    const intent = await seedClaim(f.project, f.deps, f.preset);
    const ledger = new FileSpendLedger(spendLedgerPath(f.project));
    await ledger.append({ schemaVersion: 1, attemptId: 'typesafe-open', planDigest: 'b'.repeat(64), command: 'gen-media',
      subject: 'typesafe:scene:abc', state: 'submitted', reservedUsd: 2, createdAt: '2026-01-01T00:00:00.000Z', receipt: { requestId: 'typesafe-request' } });
    const ledgerBefore = await readFile(spendLedgerPath(f.project));
    let status = 'pending';
    installGet(f.deps, f.calls, (url) => ({ body: url.pathname.endsWith('/posts')
      ? completeList([proofPost(intent, 'proven-remote', status)]) : { post: proofPost(intent, 'proven-remote', status) } }));
    const options = { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] };
    expect((await reconcileCreator(f.project, f.deps, options))[0]!.state).toBe('pending');
    const firstAudit = await readFile(join(f.project, 'publication/reconciliations.jsonl'), 'utf8');
    const afterFirst = await snapshotFiles(f.project);
    expect((await reconcileCreator(f.project, f.deps, options))[0]!.state).toBe('pending');
    expect(await snapshotFiles(f.project)).toEqual(afterFirst);
    status = 'published';
    expect((await reconcileCreator(f.project, f.deps, options))[0]!.state).toBe('published');
    const audit = await readFile(join(f.project, 'publication/reconciliations.jsonl'), 'utf8');
    expect(audit.startsWith(firstAudit)).toBe(true);
    expect(audit.trim().split('\n')).toHaveLength(2);
    expect(await readFile(spendLedgerPath(f.project))).toEqual(ledgerBefore);
    expect((await ledger.list()).at(-1)!.state).toBe('submitted');
    expect((await planPublication(f.project, 0)).blockers.some((blocker) => blocker.includes('paid attempts'))).toBe(true);
    expect(f.media.calls.secrets).toHaveLength(0);
    expect(f.counts().storageCalls).toBe(0);
    expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  test('crash after journal reconciliation and torn latest receipt recovers from new GET proof without a new attempt', async () => {
    const f = await fixture();
    const intent = await seedClaim(f.project, f.deps, f.preset);
    installGet(f.deps, f.calls, () => ({ body: completeList([proofPost(intent)]) }));
    const options = { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] };
    await reconcileCreator(f.project, f.deps, options);
    const journalPath = join(f.project, 'qa/publication/zernio-journal.jsonl');
    const journalBefore = await readFile(journalPath);
    const auditBefore = await readFile(join(f.project, 'publication/reconciliations.jsonl'), 'utf8');
    await writeFile(join(f.project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.result.json`), '{"state":');
    expect((await reconcileCreator(f.project, f.deps, options))[0]!.state).toBe('published');
    expect(await readFile(journalPath)).toEqual(journalBefore);
    expect((await readFile(join(f.project, 'publication/reconciliations.jsonl'), 'utf8')).startsWith(auditBefore)).toBe(true);
    expect((await readdir(join(f.project, 'publication/intents'))).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect((await new FilePublicationJournal(journalPath).readAll()).map((entry) => entry.attempt)).toEqual([1, 1]);
  });

  test('a claim before any provider journal can record GET proof but must not invent a provider attempt', async () => {
    const f = await fixture();
    const intent = await seedClaim(f.project, f.deps, f.preset, false);
    installGet(f.deps, f.calls, (url) => ({ body: url.pathname.endsWith('/posts')
      ? completeList([proofPost(intent)]) : { post: proofPost(intent) } }));
    const before = await readFile(join(f.project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.json`));
    expect((await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] }))[0]!.state).toBe('published');
    expect((await new FilePublicationJournal(join(f.project, 'qa/publication/zernio-journal.jsonl')).readAll())).toEqual([]);
    expect(await readFile(join(f.project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.json`))).toEqual(before);
    const afterFirst = await snapshotFiles(f.project);
    expect((await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] }))[0]!.state).toBe('published');
    expect(await snapshotFiles(f.project)).toEqual(afterFirst);
  });

  test('torn append journals/audits are preserved conservatively even when fresh GET proof exists', async () => {
    for (const relative of ['qa/publication/zernio-journal.jsonl', 'publication/reconciliations.jsonl']) {
      const f = await fixture();
      const intent = await seedClaim(f.project, f.deps, f.preset);
      let before = '';
      try { before = await readFile(join(f.project, relative), 'utf8'); } catch { /* audit not created yet */ }
      await writeFile(join(f.project, relative), `${before}{"schemaVersion":`);
      installGet(f.deps, f.calls, () => ({ body: completeList([proofPost(intent)]) }));
      const snapshot = await snapshotFiles(f.project);
      expect((await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [intent.accountId] }))[0]!.state).toBe('uncertain');
      expect(await snapshotFiles(f.project)).toEqual(snapshot);
    }
  });

  test('explicit confirmation, finite zero cap and approved unique target scope guard all mutations and GETs; no claim means not-started', async () => {
    const f = await fixture();
    const before = await snapshotFiles(f.project);
    await expect(reconcileCreator(f.project, f.deps, { confirm: false, spendCap: 0 })).rejects.toThrow('--confirm');
    for (const spendCap of [undefined, null, '0', NaN, Infinity, -1, 0.01, 1]) {
      await expect(reconcileCreator(f.project, f.deps, { confirm: true, spendCap })).rejects.toThrow('--spend-cap 0');
    }
    await expect(reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: ['unknown'] })).rejects.toThrow('approved account IDs');
    const accountId = f.preset.publishing.targets[0]!.accountId;
    await expect(reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [accountId, accountId] })).rejects.toThrow('unique account IDs');
    expect(await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [] })).toEqual([]);
    expect(await reconcileCreator(f.project, f.deps, { confirm: true, spendCap: 0, targetAccountIds: [accountId] })).toEqual([
      { platform: f.preset.publishing.targets[0]!.platform, accountId, idempotencyKey: '', state: 'not-started' },
    ]);
    expect(f.calls).toHaveLength(0);
    expect(f.counts().clientCalls).toBe(0);
    expect(f.counts().storageCalls).toBe(0);
    expect(await snapshotFiles(f.project)).toEqual(before);
  });
});
