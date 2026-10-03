import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { globalAgent } from 'node:https';
import { ZernioClient, type ObjectStore } from '@videomaker/providers';
import {
  CreatorBatchCapacityObservationSchema, CreatorPresetSchema, CreatorTikTokEnvelopeSchema,
  type CreatorBatchCapacityObservation, type CreatorBatchTarget, type CreatorPreset, type CreatorTikTokCapability,
} from '@videomaker/schemas';
import { makeTestDeps, type TestDeps } from '../pipeline/test-support';
import type { CreatorDeps } from './workflow';
import {
  assertTikTokCapability, checkedCreatorClient, checkedCreatorStorage, CreatorPreflightError,
  remoteCreatorPreflight, type CreatorCapacitySource, type CreatorPreflightErrorKind,
} from './preflight';

// DO_NOT_RUN during delegated edits: the parent owns the phase validation gate.
const PRESET_PATH = new URL('../../../../presets/leobar.json', import.meta.url).pathname;
const SECRET = 'test-preflight-secret-do-not-log';
type PreflightEndpoint = 'profiles' | 'accounts' | 'health' | 'creator-info';
interface PreflightControls {
  profileId?: string;
  profileName?: string;
  accountId?: string;
  accountPlatform?: string;
  username?: string;
  healthStatus?: string;
  canPost?: boolean;
  missingCanPost?: boolean;
  missingUsername?: boolean;
  duplicateAccount?: boolean;
  duplicateHealth?: boolean;
  capability?: CreatorTikTokCapability;
  creatorInfoBody?: unknown;
  statuses?: Partial<Record<PreflightEndpoint, number>>;
  transportEndpoint?: PreflightEndpoint;
  transportFailure?: unknown;
  mode?: 'run' | 'plan';
}
interface PreflightCall { method: string; path: string }
interface ResourceCounts { client: number; storage: number; head: number; put: number }
interface PreflightFixture {
  preset: CreatorPreset;
  target: CreatorBatchTarget;
  client: ZernioClient;
  store: ObjectStore;
  deps: CreatorDeps;
  media: TestDeps;
  calls: PreflightCall[];
  logs: string[];
  resources: ResourceCounts;
}
interface PreflightSourceOptions {
  status?: CreatorBatchCapacityObservation['status'];
  remaining?: number;
  available?: number;
  canPostMore?: boolean;
  ageMs?: number;
  accountId?: string;
  platform?: CreatorBatchTarget['platform'];
  resetAt?: string;
  nextRetryAt?: string;
}
interface PreflightSourceSnapshots {
  returned?: CreatorBatchCapacityObservation;
  observed?: readonly Readonly<CreatorBatchCapacityObservation>[];
}

function capability(): CreatorTikTokCapability {
  return CreatorTikTokEnvelopeSchema.parse({
    creator: { nickname: 'creator', avatarUrl: 'https://cdn.example/avatar.png', isVerified: false, canPostMore: true },
    privacyLevels: [{ value: 'PUBLIC_TO_EVERYONE', label: 'Everyone' }],
    postingLimits: {
      maxVideoDurationSec: 600,
      interactionSettings: {
        allow_comment: { enabled: true, required: true, default: true, label: 'Comments' },
        allow_duet: { enabled: true, required: true, default: false, label: 'Duet' },
        allow_stitch: { enabled: true, required: true, default: false, label: 'Stitch' },
      },
    },
  });
}

async function fixture(controls: PreflightControls = {}): Promise<PreflightFixture> {
  const preset = CreatorPresetSchema.parse(JSON.parse(await readFile(PRESET_PATH, 'utf8')));
  const approved = preset.publishing.targets.find((target) => target.platform === 'tiktok');
  if (!approved) throw new Error('Fixture must include TikTok');
  const target: CreatorBatchTarget = { platform: approved.platform, accountId: approved.accountId, username: approved.username };
  const calls: PreflightCall[] = [];
  const logs: string[] = [];
  const resources: ResourceCounts = { client: 0, storage: 0, head: 0, put: 0 };
  const fetchImpl = Object.assign(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const path = url.pathname.replace(/^.*\/v1/, '');
    const method = init?.method ?? 'GET';
    calls.push({ method, path: `${path}${url.search}` });
    let endpoint: PreflightEndpoint;
    let body: unknown;
    if (path === '/profiles') {
      endpoint = 'profiles';
      body = { profiles: [{ _id: controls.profileId ?? preset.publishing.profile.id, name: controls.profileName ?? preset.publishing.profile.name }] };
    } else if (path === '/accounts') {
      endpoint = 'accounts';
      expect(url.searchParams.get('profileId')).toBe(preset.publishing.profile.id);
      const accounts = preset.publishing.targets.map((entry, index) => ({
        _id: index === 0 ? controls.accountId ?? entry.accountId : entry.accountId,
        platform: index === 0 ? controls.accountPlatform ?? entry.platform : entry.platform,
        ...(index === 0 && controls.missingUsername ? {} : { username: index === 0 ? controls.username ?? entry.username : entry.username }),
      }));
      if (controls.duplicateAccount) accounts.push({ ...accounts[0]! });
      body = { accounts };
    } else if (path === '/accounts/health') {
      endpoint = 'health';
      const accounts = preset.publishing.targets.map((entry, index) => ({
        accountId: entry.accountId, status: index === 0 ? controls.healthStatus ?? 'healthy' : 'healthy',
        ...(index === 0 && controls.missingCanPost ? {} : { canPost: index === 0 ? controls.canPost ?? true : true }),
      }));
      if (controls.duplicateHealth) accounts.push({ ...accounts[0]! });
      body = { accounts };
    } else if (path === `/accounts/${encodeURIComponent(target.accountId)}/tiktok/creator-info`) {
      endpoint = 'creator-info';
      expect(url.searchParams.get('mediaType')).toBe('video');
      body = controls.creatorInfoBody ?? controls.capability ?? capability();
    } else throw new Error('Unexpected preflight route');
    if (controls.transportEndpoint === endpoint) throw controls.transportFailure;
    const status = controls.statuses?.[endpoint] ?? 200;
    return new Response(JSON.stringify(status === 200 ? body : { error: SECRET }), { status });
  }, { preconnect: () => {} });
  const client = new ZernioClient({ apiKey: SECRET, fetchImpl, maxAttempts: 1, logger: (message) => { logs.push(message); } });
  const store: ObjectStore = {
    head: async () => { resources.head += 1; return null; },
    put: async () => { resources.put += 1; throw new Error('Preflight must not write test objects'); },
    get: async () => { throw new Error('Preflight must not read storage objects'); },
    inspect: async () => { throw new Error('Preflight must not inspect storage objects'); },
  };
  const media = makeTestDeps();
  const deps: CreatorDeps = {
    media: { ...media, providerContext: () => ({ ...media.providerContext(), mode: controls.mode ?? 'run', logger: (message) => { logs.push(message); } }) },
    client: async () => { resources.client += 1; return client; },
    storage: async () => { resources.storage += 1; return store; },
  };
  return { preset, target, client, store, deps, media, calls, logs, resources };
}

function source(options: PreflightSourceOptions = {}): CreatorCapacitySource {
  return async (target, checkedAt) => CreatorBatchCapacityObservationSchema.parse({
    platform: options.platform ?? target.platform, accountId: options.accountId ?? target.accountId,
    status: options.status ?? 'confirmed', source: 'trusted read-only test evidence',
    checkedAt: new Date(checkedAt.getTime() - (options.ageMs ?? 0)).toISOString(),
    ...(options.remaining !== undefined ? { remaining: options.remaining } : {}),
    ...(options.available !== undefined ? { available: options.available } : {}),
    ...(options.canPostMore !== undefined ? { canPostMore: options.canPostMore } : {}),
    ...(options.resetAt !== undefined ? { resetAt: options.resetAt } : {}),
    ...(options.nextRetryAt !== undefined ? { nextRetryAt: options.nextRetryAt } : {}),
  });
}

async function failure(promise: Promise<unknown>, kind: CreatorPreflightErrorKind, scope: 'shared' | 'account'): Promise<CreatorPreflightError> {
  try { await promise; }
  catch (error) {
    expect(error).toBeInstanceOf(CreatorPreflightError);
    if (!(error instanceof CreatorPreflightError)) throw new Error('Expected safe preflight error');
    expect(error.kind).toBe(kind);
    expect(error.scope).toBe(scope);
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(error.cause).toBeUndefined();
    return error;
  }
  throw new Error('Expected preflight refusal');
}

function expectReadOnly(f: PreflightFixture): void {
  expect(f.calls.every((call) => call.method === 'GET')).toBe(true);
  expect(f.resources.storage).toBe(0);
  expect(f.resources.head).toBe(0);
  expect(f.resources.put).toBe(0);
  expect(f.media.calls.secrets).toEqual([]);
  expect(f.logs.join('\n')).not.toContain(SECRET);
}

describe('creator operational preflight (read-only)', () => {
  test('default capacity is fresh unknown, never 15-minus-count or a reset estimate', async () => {
    const f = await fixture();
    const before = Date.now();
    const observations = await remoteCreatorPreflight(f.client, f.deps, f.preset, 10);
    expect(observations).toHaveLength(f.preset.publishing.targets.length);
    for (const observation of observations) {
      expect(observation.status).toBe('unknown');
      expect(observation.remaining).toBeUndefined();
      expect(observation.available).toBeUndefined();
      expect(observation.resetAt).toBeUndefined();
      expect(observation.nextRetryAt).toBeUndefined();
      expect(observation.checkedAt).not.toBeNull();
      if (observation.checkedAt === null) throw new Error('Expected fresh check');
      expect(Date.parse(observation.checkedAt)).toBeGreaterThanOrEqual(before);
      expect(Date.parse(observation.checkedAt)).toBeLessThanOrEqual(Date.now());
      expect(CreatorBatchCapacityObservationSchema.safeParse(observation).success).toBe(true);
    }
    expect(observations.find((entry) => entry.accountId === f.target.accountId)?.canPostMore).toBe(true);
    expect(f.calls).toHaveLength(4);
    expect(f.calls.every((call) => !call.path.includes('quota') && !call.path.includes('/posts'))).toBe(true);
    expectReadOnly(f);
  });

  test('empty selection makes no remote, storage, capacity-source or observer calls', async () => {
    const f = await fixture();
    let capacityCalls = 0;
    let observerCalls = 0;
    const observations = await remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
      targetAccountIds: [], queuePolicy: 'require-capacity',
      capacitySource: async (target, checkedAt) => {
        capacityCalls += 1;
        return source({ remaining: 1 })(target, checkedAt);
      },
      onCapacity: () => { observerCalls += 1; },
    });
    expect(observations).toEqual([]);
    expect(capacityCalls).toBe(0);
    expect(observerCalls).toBe(0);
    expect(f.calls).toEqual([]);
    expectReadOnly(f);
  });

  test('selection rejects duplicate/unapproved IDs before any remote request', async () => {
    const f = await fixture();
    for (const targetAccountIds of [['wrong'], [f.target.accountId, f.target.accountId]]) {
      await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, { targetAccountIds }), 'identity', 'shared');
    }
    expect(f.calls).toEqual([]);
    expectReadOnly(f);
  });

  test('exact profile id and name are both mandatory and failures are shared', async () => {
    for (const controls of [{ profileId: 'other' }, { profileName: 'LEOBAR' }]) {
      const f = await fixture(controls);
      const error = await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10), 'identity', 'shared');
      expect(error.accountId).toBeUndefined();
      expect(f.calls).toHaveLength(1);
      expectReadOnly(f);
    }
  });

  test('exact account identity, unique health, healthy status and explicit canPost are mandatory', async () => {
    const cases: PreflightControls[] = [
      { accountId: 'other' }, { accountPlatform: 'youtube' }, { username: 'OTHER' }, { missingUsername: true },
      { healthStatus: 'expired' }, { canPost: false }, { missingCanPost: true }, { duplicateAccount: true }, { duplicateHealth: true },
    ];
    for (const controls of cases) {
      const f = await fixture(controls);
      const error = await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10), 'identity', 'account');
      expect(error.accountId).toBe(f.target.accountId);
      expect(error.platform).toBe('tiktok');
      expect(f.calls.some((call) => call.path.includes('creator-info'))).toBe(false);
      expectReadOnly(f);
    }
  });

  test('only selected accounts gate preflight, never mutate approved targets', async () => {
    const f = await fixture({ canPost: false, username: 'other' });
    const other = f.preset.publishing.targets.find((entry) => entry.platform === 'youtube');
    if (!other) throw new Error('Fixture must include YouTube');
    const before = JSON.stringify(f.preset);
    const observations = await remoteCreatorPreflight(f.client, f.deps, f.preset, 10, { targetAccountIds: [other.accountId] });
    expect(observations.map((entry) => entry.accountId)).toEqual([other.accountId]);
    expect(f.calls.some((call) => call.path.includes('creator-info'))).toBe(false);
    expect(JSON.stringify(f.preset)).toBe(before);
    expectReadOnly(f);
  });

  test('profile/account/health HTTP failures are shared; credentials remain shared on every endpoint', async () => {
    const endpoints: PreflightEndpoint[] = ['profiles', 'accounts', 'health', 'creator-info'];
    for (const endpoint of endpoints) {
      for (const status of [401, 403]) {
        const f = await fixture({ statuses: { [endpoint]: status } });
        await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10), 'credential', 'shared');
        expectReadOnly(f);
      }
      const f = await fixture({ statuses: { [endpoint]: 503 } });
      await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10), 'network', endpoint === 'creator-info' ? 'account' : 'shared');
      expectReadOnly(f);
    }
    const f = await fixture({ statuses: { profiles: 429 } });
    await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10), 'network', 'shared');
    expectReadOnly(f);
  });

  test('plan mode is refused without requests or secret resolution', async () => {
    const f = await fixture({ mode: 'plan' });
    await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10), 'network', 'shared');
    expect(f.calls).toEqual([]);
    expectReadOnly(f);
  });
});

describe('creator read-only capacity evidence', () => {
  test('require-capacity fails closed for default unknown even when canPostMore is true', async () => {
    const f = await fixture();
    const seen: CreatorBatchCapacityObservation[] = [];
    const error = await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
      targetAccountIds: [f.target.accountId], queuePolicy: 'require-capacity',
      onCapacity: (observations) => { seen.push(...observations); },
    }), 'quota', 'account');
    expect(error.accountId).toBe(f.target.accountId);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.status).toBe('unknown');
    expect(seen[0]?.canPostMore).toBe(true);
    expect(seen[0]?.remaining).toBeUndefined();
    expectReadOnly(f);
  });

  test('fresh confirmed numeric remaining or available permits strict preflight', async () => {
    const cases: PreflightSourceOptions[] = [{ remaining: 1 }, { available: 2 }, { remaining: 3, available: 3 }, { remaining: 1, ageMs: 59_000 }];
    for (const options of cases) {
      const f = await fixture();
      const observations = await remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
        targetAccountIds: [f.target.accountId], queuePolicy: 'require-capacity', capacitySource: source(options),
      });
      expect(observations).toHaveLength(1);
      expect(observations[0]?.status).toBe('confirmed');
      expect(observations[0]?.remaining ?? observations[0]?.available).toBeGreaterThanOrEqual(1);
      expectReadOnly(f);
    }
  });

  test('estimated, unknown, boolean-positive and zero never establish strict capacity', async () => {
    const cases: PreflightSourceOptions[] = [
      { status: 'estimated', remaining: 10 }, { status: 'unknown', canPostMore: true },
      { status: 'confirmed', canPostMore: true }, { remaining: 0 }, { available: 0 },
    ];
    for (const options of cases) {
      const f = await fixture();
      const seen: CreatorBatchCapacityObservation[] = [];
      await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
        targetAccountIds: [f.target.accountId], queuePolicy: 'require-capacity', capacitySource: source(options),
        onCapacity: (observations) => { seen.push(...observations); },
      }), 'quota', 'account');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.status).toBe(options.status ?? 'confirmed');
      expectReadOnly(f);
    }
  });

  test('provider queue policy permits unknown, estimated and zero evidence without inventing schedules', async () => {
    for (const options of [{ remaining: 0 }, { status: 'estimated', available: 4 }, { status: 'unknown', canPostMore: true }] satisfies PreflightSourceOptions[]) {
      const f = await fixture();
      const observations = await remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
        targetAccountIds: [f.target.accountId], queuePolicy: 'allow-provider-queue', capacitySource: source(options),
      });
      expect(observations).toHaveLength(1);
      expect(observations[0]?.nextRetryAt).toBeUndefined();
      expect(observations[0]?.resetAt).toBeUndefined();
      expectReadOnly(f);
    }
  });

  test('stale, future, wrong-account, wrong-platform and conflicting count evidence fails closed', async () => {
    const cases: PreflightSourceOptions[] = [
      { remaining: 1, ageMs: 60_001 }, { remaining: 1, ageMs: -60_000 },
      { remaining: 1, accountId: 'wrong' }, { remaining: 1, platform: 'youtube' },
      { remaining: 1, available: 0 }, { remaining: 0, available: 1 }, { remaining: 1, canPostMore: false },
    ];
    for (const options of cases) {
      const f = await fixture();
      const seen: CreatorBatchCapacityObservation[] = [];
      await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
        targetAccountIds: [f.target.accountId], capacitySource: source(options),
        onCapacity: (observations) => { seen.push(...observations); },
      }), 'quota', 'account');
      expect(seen).toHaveLength(1);
      expect(seen[0]?.status).toBe('unknown');
      expect(seen[0]?.remaining).toBeUndefined();
      expectReadOnly(f);
    }
  });

  test('source DTO is independently runtime parsed, including timestamps and unknown fields', async () => {
    const corruptions: Array<(observation: CreatorBatchCapacityObservation) => void> = [
      (observation) => { Object.defineProperty(observation, 'remaining', { value: -1, enumerable: true }); },
      (observation) => { Object.defineProperty(observation, 'remaining', { value: 1.5, enumerable: true }); },
      (observation) => { Object.defineProperty(observation, 'checkedAt', { value: 'not-a-date', enumerable: true }); },
      (observation) => { Object.defineProperty(observation, 'checkedAt', { value: null, enumerable: true }); },
      (observation) => { Object.defineProperty(observation, 'resetAt', { value: 'midnight', enumerable: true }); },
      (observation) => { Object.defineProperty(observation, 'nextRetryAt', { value: 'tomorrow', enumerable: true }); },
      (observation) => { Object.defineProperty(observation, 'rawError', { value: SECRET, enumerable: true }); },
      (observation) => { Object.defineProperty(observation, 'remaining', { get: () => { throw new Error(SECRET); }, enumerable: true }); },
    ];
    for (const corrupt of corruptions) {
      const f = await fixture();
      const capacitySource: CreatorCapacitySource = async (target, checkedAt) => {
        const observation = await source({ remaining: 1 })(target, checkedAt);
        corrupt(observation);
        return observation;
      };
      await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, { targetAccountIds: [f.target.accountId], capacitySource }), 'quota', 'account');
      expectReadOnly(f);
    }
  });

  test('unavailable source strips thrown secret text and does not become a default positive count', async () => {
    const f = await fixture();
    await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
      targetAccountIds: [f.target.accountId], capacitySource: async () => { throw new Error(SECRET); },
    }), 'quota', 'account');
    expectReadOnly(f);
  });

  test('structured reset and retry timestamps survive only validated trusted evidence', async () => {
    const f = await fixture();
    const resetAt = new Date(Date.now() + 3_600_000).toISOString();
    const nextRetryAt = new Date(Date.now() + 60_000).toISOString();
    const observations = await remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
      targetAccountIds: [f.target.accountId], queuePolicy: 'require-capacity', capacitySource: source({ remaining: 1, resetAt, nextRetryAt }),
    });
    expect(observations[0]?.resetAt).toBe(resetAt);
    expect(observations[0]?.nextRetryAt).toBe(nextRetryAt);
    expectReadOnly(f);
  });

  test('every requested account requires its own numeric evidence', async () => {
    const f = await fixture();
    const capacitySource: CreatorCapacitySource = async (target, checkedAt) => source(
      target.accountId === f.target.accountId ? { remaining: 1 } : { status: 'unknown' },
    )(target, checkedAt);
    const error = await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
      queuePolicy: 'require-capacity', capacitySource,
    }), 'quota', 'account');
    expect(error.accountId).not.toBe(f.target.accountId);
    expectReadOnly(f);
  });

  test('source receives frozen exact target and observations passed to observers are frozen copies', async () => {
    const f = await fixture();
    const snapshots: PreflightSourceSnapshots = {};
    const capacitySource: CreatorCapacitySource = async (target, checkedAt) => {
      expect(target).toEqual(f.target);
      expect(Object.isFrozen(target)).toBe(true);
      expect(checkedAt).toBeInstanceOf(Date);
      const observation = await source({ remaining: 2 })(target, checkedAt);
      snapshots.returned = observation;
      return observation;
    };
    const observations = await remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
      targetAccountIds: [f.target.accountId], queuePolicy: 'require-capacity', capacitySource,
      onCapacity: (values) => { snapshots.observed = values; },
    });
    expect(snapshots.observed).toHaveLength(1);
    expect(Object.isFrozen(snapshots.observed)).toBe(true);
    expect(Object.isFrozen(snapshots.observed?.[0])).toBe(true);
    if (!snapshots.returned) throw new Error('Source must be called');
    snapshots.returned.remaining = 0;
    expect(observations[0]?.remaining).toBe(2);
    expect(snapshots.observed?.[0]?.remaining).toBe(2);
    expectReadOnly(f);
  });

  test('concurrent calls re-read changing capacity instead of sharing a cached positive result', async () => {
    const f = await fixture();
    let reads = 0;
    const capacitySource: CreatorCapacitySource = async (target, checkedAt) => {
      const remaining = reads++ === 0 ? 1 : 0;
      await Promise.resolve();
      return source({ remaining })(target, checkedAt);
    };
    const results = await Promise.allSettled([0, 1].map(() => remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
      targetAccountIds: [f.target.accountId], queuePolicy: 'require-capacity', capacitySource,
    })));
    expect(reads).toBe(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    for (const result of results) if (result.status === 'rejected') {
      const reason: unknown = result.reason;
      expect(reason).toBeInstanceOf(CreatorPreflightError);
      if (!(reason instanceof CreatorPreflightError)) throw new Error('Expected safe preflight error');
      expect(reason.kind).toBe('quota');
    }
    expectReadOnly(f);
  });
});

describe('TikTok capability and quota rejection evidence', () => {
  test('canPostMore:false and creator-info429 always block both policies with unknown numeric quota', async () => {
    for (const queuePolicy of ['allow-provider-queue', 'require-capacity'] as const) {
      const blocked = capability();
      blocked.creator.canPostMore = false;
      for (const controls of [{ capability: blocked }, { statuses: { 'creator-info': 429 } }] satisfies PreflightControls[]) {
        const f = await fixture(controls);
        const seen: CreatorBatchCapacityObservation[] = [];
        let sourceCalls = 0;
        await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
          targetAccountIds: [f.target.accountId], queuePolicy,
          capacitySource: async (target, checkedAt) => { sourceCalls += 1; return source({ remaining: 99 })(target, checkedAt); },
          onCapacity: (observations) => { seen.push(...observations); },
        }), 'quota', 'account');
        expect(sourceCalls).toBe(0);
        expect(seen).toHaveLength(1);
        expect(seen[0]?.status).toBe('unknown');
        expect(seen[0]?.canPostMore).toBe(false);
        expect(seen[0]?.remaining).toBeUndefined();
        expect(seen[0]?.resetAt).toBeUndefined();
        expect(seen[0]?.nextRetryAt).toBeUndefined();
        expectReadOnly(f);
      }
    }
  });

  test('documented envelope is mandatory and malformed responses never expose raw body', async () => {
    const f = await fixture({ creatorInfoBody: { creator_info: { max_video_post_duration_sec: 600 }, secret: SECRET } });
    const seen: CreatorBatchCapacityObservation[] = [];
    await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
      targetAccountIds: [f.target.accountId], onCapacity: (observations) => { seen.push(...observations); },
    }), 'capability', 'account');
    expect(seen[0]?.status).toBe('unknown');
    expect(seen[0]?.canPostMore).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expectReadOnly(f);
  });

  test('privacy, duration and interaction rejection preserve capability checks and emit unknown evidence', async () => {
    const privacy = capability();
    privacy.privacyLevels = [{ value: 'SELF_ONLY', label: 'Only me' }];
    const duration = capability();
    duration.postingLimits.maxVideoDurationSec = 5;
    const comments = capability();
    comments.postingLimits.interactionSettings.allow_comment.enabled = false;
    for (const denied of [privacy, duration, comments]) {
      const f = await fixture({ capability: denied });
      const seen: CreatorBatchCapacityObservation[] = [];
      await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
        targetAccountIds: [f.target.accountId], onCapacity: (observations) => { seen.push(...observations); },
      }), 'capability', 'account');
      expect(seen[0]?.status).toBe('unknown');
      expect(seen[0]?.canPostMore).toBe(true);
      expectReadOnly(f);
    }
  });

  test('pure public capability assertion keeps enabled/default/null semantics and message', () => {
    const approved = { privacyLevel: 'PUBLIC_TO_EVERYONE', allowComment: true, allowDuet: true, allowStitch: true };
    const allowed = capability();
    expect(() => assertTikTokCapability(allowed, approved, 10)).not.toThrow();
    const disabled = capability();
    disabled.postingLimits.interactionSettings.allow_duet = { enabled: false, required: true, default: true, label: 'Duet' };
    expect(() => assertTikTokCapability(disabled, approved, 10)).toThrow('TikTok privacy/duration/interaction capability does not permit the approved settings');
    const photo = capability();
    photo.postingLimits.interactionSettings.allow_duet = null;
    photo.postingLimits.interactionSettings.allow_stitch = null;
    expect(() => assertTikTokCapability(photo, approved, 10)).toThrow();
    expect(() => assertTikTokCapability(photo, { ...approved, allowDuet: false, allowStitch: false }, 10)).not.toThrow();
  });
});

describe('credential/TLS resource helpers and transport hygiene', () => {
  test('helpers resolve existing factories without making permission probes or object writes', async () => {
    const f = await fixture();
    expect(await checkedCreatorClient(f.deps)).toBe(f.client);
    expect(await checkedCreatorStorage(f.deps)).toBe(f.store);
    expect(f.resources).toEqual({ client: 1, storage: 1, head: 0, put: 0 });
    expect(f.calls).toEqual([]);
    expect(f.media.calls.secrets).toEqual([]);
  });

  test('credential and nested TLS factory failures have distinct constant safe messages', async () => {
    const f = await fixture();
    const credentials = { ...f.deps, client: async (): Promise<ZernioClient> => { throw new Error(SECRET); } };
    const credential = await failure(checkedCreatorClient(credentials), 'credential', 'shared');
    const tlsFailure = new Error(SECRET, { cause: Object.assign(new Error(SECRET), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }) });
    const tls = await failure(checkedCreatorClient({ ...f.deps, client: async (): Promise<ZernioClient> => { throw tlsFailure; } }), 'tls', 'shared');
    const storageCredential = await failure(checkedCreatorStorage({ ...f.deps, storage: async (): Promise<ObjectStore> => { throw SECRET; } }), 'credential', 'shared');
    const storageTls = await failure(checkedCreatorStorage({ ...f.deps, storage: async (): Promise<ObjectStore> => { throw tlsFailure; } }), 'tls', 'shared');
    expect(credential.message).not.toBe(tls.message);
    expect(storageCredential.message).toBe(credential.message);
    expect(storageTls.message).toBe(tls.message);
    expectReadOnly(f);
  });

  test('wrapped remote TLS errors stay safe and node TLS verification configuration is untouched', async () => {
    const rejection = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    const extraCa = process.env.NODE_EXTRA_CA_CERTS;
    const rejectUnauthorized = globalAgent.options.rejectUnauthorized;
    const f = await fixture({
      transportEndpoint: 'profiles',
      transportFailure: new Error(SECRET, { cause: Object.assign(new Error(SECRET), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) }),
    });
    await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10), 'tls', 'shared');
    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(rejection);
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(extraCa);
    expect(globalAgent.options.rejectUnauthorized).toBe(rejectUnauthorized);
    expectReadOnly(f);
  });

  test('ordinary transport errors are network failures, never matched from secret message text', async () => {
    const f = await fixture({ transportEndpoint: 'creator-info', transportFailure: new Error(`${SECRET} ERR_TLS_CERT_ALTNAME_INVALID`) });
    await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10), 'network', 'shared');
    expectReadOnly(f);
  });

  test('guarded malformed/cyclic causes cannot leak secrets or recurse indefinitely', async () => {
    const f = await fixture();
    const cyclic: { cause?: unknown; message: string } = { message: SECRET };
    cyclic.cause = cyclic;
    const getter = Object.defineProperty(new Error(SECRET), 'cause', { get: () => { throw new Error(SECRET); } });
    for (const error of [cyclic, getter, null, SECRET]) {
      await failure(checkedCreatorClient({ ...f.deps, client: async (): Promise<ZernioClient> => { throw error; } }), 'credential', 'shared');
    }
    expectReadOnly(f);
  });

  test('observer exceptions become constant typed failures rather than secret diagnostics', async () => {
    const f = await fixture();
    await failure(remoteCreatorPreflight(f.client, f.deps, f.preset, 10, {
      targetAccountIds: [f.target.accountId], onCapacity: () => { throw new Error(SECRET); },
    }), 'quota', 'shared');
    expectReadOnly(f);
  });
});
