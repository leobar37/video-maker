import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePublicationJournal, ZernioClient, ZernioPublisher, type ObjectMeta, type ObjectStore } from '@videomaker/providers';
import { CreatorTikTokEnvelopeSchema as TikTokCapabilitySchema, type CreatorTikTokCapability } from '@videomaker/schemas';
import { makeTestDeps } from '../pipeline/test-support';
import { loadProject, initProject, sha256, writeJson, PresetSchema } from './model';
import { planPublication, runCreatorQa } from './qa';
import { assertTikTokCapability, publishCreator, statusCreator, type CreatorDeps } from './workflow';

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
  const objects = new Map<string, { bytes: Uint8Array; meta: ObjectMeta }>();
  let puts = 0;
  let storageCalls = 0;
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
      const platform = String(target.platform);
      if (platform === controls.uncertain) throw new Error('transport interrupted after submit');
      if (platform === controls.rejected) { status = 400; answer = { error: 'rejected' }; }
      else {
        const key = new Headers(init?.headers).get('idempotency-key');
        if (!key) throw new Error('Missing idempotency header');
        const post = { _id: `remote-${platform}`, idempotencyKey: key, platforms: [{ platform, status: controls.pending ? 'pending' : 'published', platformPostUrl: `https://social.example/${platform}` }] };
        posts.set(key, post);
        status = 201;
        answer = { post };
      }
    } else if (path === '/posts') answer = { posts: [...posts.values()].filter((post) => post.idempotencyKey === url.searchParams.get('idempotencyKey')) };
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
  media.publisher = async (journalPath) => new ZernioPublisher(client, { journal: new FilePublicationJournal(journalPath) });
  const store: ObjectStore = {
    async head(key) { return objects.get(key)?.meta ?? null; },
    async put(key, bytes, opts) { puts++; const meta = { key, bytes: bytes.length, sha256: sha256(bytes), contentType: opts.contentType, publicUrl: `https://cdn.example/${key}` }; objects.set(key, { bytes, meta }); return meta; },
    async get(key) { const value = objects.get(key); if (!value) throw new Error('missing'); return value.bytes; },
    async inspect(key) { const value = objects.get(key); if (!value) throw new Error('missing'); return controls.corruptStorage ? { ...value.meta, sha256: 'bad' } : value.meta; },
  };
  const deps: CreatorDeps = { media, client: async () => client, storage: async () => { storageCalls++; return store; } };
  if (controls.loudness === undefined) {
    await runCreatorQa(project, media);
    const plan = await planPublication(project, 0);
    await writeJson(project, 'publication/draft.json', { ...edited, approval: { approved: true, digest: plan.digest } });
  }
  return { project, deps, media, calls, posts, preset, controls, counts: () => ({ puts, storageCalls, processCalls }) };
}

describe('creator safe publishing (offline)', () => {
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
    expect(status.map((result) => result.state)).toEqual(['published', 'uncertain', 'failed', 'published']);
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
