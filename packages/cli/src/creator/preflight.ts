import { isRecord } from '@videomaker/core';
import {
  CreatorBatchCapacityObservationSchema, CreatorTikTokEnvelopeSchema,
  CreatorPreflightRemoteProfileSchema, CreatorPreflightRemoteProfilesSchema,
  CreatorPreflightRemoteAccountsSchema, CreatorPreflightRemoteAccountSchema, CreatorPreflightRemoteHealthSchema,
  type CreatorBatchCapacityObservation, type CreatorBatchQueuePolicy,
  type CreatorBatchTarget, type CreatorPreset, type CreatorTikTokCapability,
} from '@videomaker/schemas';
import { assertRunMode, type ObjectStore, type ZernioClient, type ZernioResponse } from '@videomaker/providers';
import type { CreatorDeps } from './workflow';

/** Trusted, read-only evidence adapter; absent by default, never an invented quota endpoint. */
export type CreatorCapacitySource = (target: CreatorBatchTarget, checkedAt: Date) => Promise<CreatorBatchCapacityObservation>;
export type CreatorCapacityObserver = (observations: readonly Readonly<CreatorBatchCapacityObservation>[]) => void;

export interface CreatorPreflightOptions {
  targetAccountIds?: readonly string[];
  queuePolicy?: CreatorBatchQueuePolicy;
  capacitySource?: CreatorCapacitySource;
  onCapacity?: CreatorCapacityObserver;
}

export type CreatorPreflightErrorKind = 'credential' | 'tls' | 'identity' | 'capability' | 'quota' | 'network';
export type CreatorPreflightErrorScope = 'shared' | 'account';
const safeMessages: Record<CreatorPreflightErrorKind, string> = {
  credential: 'Creator credentials unavailable or rejected; no upload/publication permitted',
  tls: 'Creator TLS verification failed; no upload/publication permitted',
  identity: 'Exact approved creator identity unavailable; no upload/publication permitted',
  capability: 'Creator capability does not permit the approved settings; no upload/publication permitted',
  quota: 'Creator capacity unavailable or insufficient; no upload/publication permitted',
  network: 'Creator read-only remote preflight unavailable; no upload/publication permitted',
};

/** Intentionally retains no remote message, body, transport cause, or credential value. */
export class CreatorPreflightError extends Error {
  readonly accountId?: string;
  readonly platform?: CreatorBatchTarget['platform'];

  constructor(
    readonly kind: CreatorPreflightErrorKind,
    readonly scope: CreatorPreflightErrorScope,
    target?: Pick<CreatorBatchTarget, 'accountId' | 'platform'>,
  ) {
    super(safeMessages[kind]);
    this.name = 'CreatorPreflightError';
    if (target) {
      this.accountId = target.accountId;
      this.platform = target.platform;
    }
  }
}

const tlsCodes: Record<string, true> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: true, SELF_SIGNED_CERT_IN_CHAIN: true,
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: true, UNABLE_TO_GET_ISSUER_CERT: true,
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: true, CERT_HAS_EXPIRED: true, CERT_NOT_YET_VALID: true,
  CERT_SIGNATURE_FAILURE: true, CERT_UNTRUSTED: true, CERT_REJECTED: true,
};

function isTlsFailure(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    // Transport wrappers may carry a cause; never inspect or propagate their messages.
    try {
      if (!isRecord(current) || visited.has(current)) return false;
      visited.add(current);
      const code = current.code;
      if (typeof code === 'string' && (Object.hasOwn(tlsCodes, code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_'))) return true;
      current = current.cause;
    } catch { return false; }
  }
  return false;
}

export async function checkedCreatorClient(deps: CreatorDeps): Promise<ZernioClient> {
  try { return await deps.client(); }
  catch (error) { throw new CreatorPreflightError(isTlsFailure(error) ? 'tls' : 'credential', 'shared'); }
}

/** Resolves existing configuration only. Real HEAD/upload remains authoritative for R2 permissions. */
export async function checkedCreatorStorage(deps: CreatorDeps): Promise<ObjectStore> {
  try { return await deps.storage(); }
  catch (error) { throw new CreatorPreflightError(isTlsFailure(error) ? 'tls' : 'credential', 'shared'); }
}

/**
 * Fails closed on any capability the approved TikTok settings cannot satisfy.
 * `enabled:false` means the creator disabled the interaction; `default` is a
 * composer seed and is NEVER treated as approval. A `null` descriptor (photo
 * media) fails any required toggle rather than assuming consent.
 */
export function assertTikTokCapability(
  capability: CreatorTikTokCapability,
  settings: { privacyLevel: string; allowComment: boolean; allowDuet: boolean; allowStitch: boolean },
  duration: number,
): void {
  const interactions = capability.postingLimits.interactionSettings;
  if (capability.creator.canPostMore !== true ||
      !capability.privacyLevels.some((privacy) => privacy.value === settings.privacyLevel) ||
      capability.postingLimits.maxVideoDurationSec < duration ||
      (settings.allowComment && interactions.allow_comment.enabled !== true) ||
      (settings.allowDuet && interactions.allow_duet?.enabled !== true) ||
      (settings.allowStitch && interactions.allow_stitch?.enabled !== true)) {
    throw new Error('TikTok privacy/duration/interaction capability does not permit the approved settings');
  }
}

type CreatorApprovedTarget = CreatorPreset['publishing']['targets'][number];

function selectedTargets(preset: CreatorPreset, accountIds?: readonly string[]): CreatorApprovedTarget[] {
  if (accountIds === undefined) return preset.publishing.targets;
  if (!Array.isArray(accountIds) || new Set(accountIds).size !== accountIds.length ||
      accountIds.some((id) => typeof id !== 'string' || !preset.publishing.targets.some((target) => target.accountId === id))) {
    throw new CreatorPreflightError('identity', 'shared');
  }
  return preset.publishing.targets.filter((target) => accountIds.includes(target.accountId));
}

async function remoteGet(client: ZernioClient, path: string, target?: CreatorBatchTarget): Promise<ZernioResponse> {
  let response: ZernioResponse;
  try { response = await client.request(path, { method: 'GET' }); }
  catch (error) {
    throw new CreatorPreflightError(isTlsFailure(error) ? 'tls' : 'network', 'shared');
  }
  if (response.status === 401 || response.status === 403) throw new CreatorPreflightError('credential', 'shared');
  if (target && response.status === 429) throw new CreatorPreflightError('quota', 'account', target);
  if (response.status !== 200) throw new CreatorPreflightError('network', target ? 'account' : 'shared', target);
  return response;
}

async function validateRemoteIdentity(client: ZernioClient, preset: CreatorPreset, targets: CreatorApprovedTarget[]): Promise<void> {
  const profiles = CreatorPreflightRemoteProfilesSchema.safeParse((await remoteGet(client, '/profiles')).body);
  if (!profiles.success) throw new CreatorPreflightError('identity', 'shared');
  const exactProfiles = profiles.data.flatMap((raw) => {
    const parsed = CreatorPreflightRemoteProfileSchema.safeParse(raw);
    return parsed.success && (parsed.data._id ?? parsed.data.id) === preset.publishing.profile.id &&
      parsed.data.name === preset.publishing.profile.name ? [parsed.data] : [];
  });
  if (exactProfiles.length !== 1) throw new CreatorPreflightError('identity', 'shared');
  const accounts = CreatorPreflightRemoteAccountsSchema.safeParse((await remoteGet(client, `/accounts?profileId=${encodeURIComponent(preset.publishing.profile.id)}`)).body);
  const health = CreatorPreflightRemoteAccountsSchema.safeParse((await remoteGet(client, '/accounts/health')).body);
  if (!accounts.success || !health.success) throw new CreatorPreflightError('identity', 'shared');
  for (const target of targets) {
    const matches = accounts.data.accounts.flatMap((raw) => {
      const parsed = CreatorPreflightRemoteAccountSchema.safeParse(raw);
      return parsed.success && (parsed.data._id ?? parsed.data.id ?? parsed.data.accountId) === target.accountId ? [parsed.data] : [];
    });
    const status = health.data.accounts.flatMap((raw) => {
      const parsed = CreatorPreflightRemoteHealthSchema.safeParse(raw);
      return parsed.success && (parsed.data.accountId ?? parsed.data.id) === target.accountId ? [parsed.data] : [];
    });
    const account = matches[0];
    const connected = status[0];
    if (matches.length !== 1 || !account || account.platform !== target.platform || account.username !== target.username ||
        status.length !== 1 || !connected || connected.canPost !== true || !['healthy', 'active', 'ok'].includes(connected.status) ||
        (connected.username !== undefined && connected.username !== target.username) ||
        (connected.platform !== undefined && connected.platform !== target.platform)) {
      throw new CreatorPreflightError('identity', 'account', target);
    }
  }
}

async function capacityObservation(target: CreatorBatchTarget, source: CreatorCapacitySource | undefined, canPostMore?: boolean): Promise<CreatorBatchCapacityObservation> {
  const checkedAt = new Date();
  if (!source) return CreatorBatchCapacityObservationSchema.parse({
    platform: target.platform, accountId: target.accountId, status: 'unknown',
    source: target.platform === 'tiktok' ? 'documented TikTok creator-info capability; numeric quota unavailable' : 'documented account health; numeric quota unavailable',
    checkedAt: checkedAt.toISOString(), ...(canPostMore !== undefined ? { canPostMore } : {}),
  });
  let observation: CreatorBatchCapacityObservation;
  try {
    const raw: unknown = await source(Object.freeze({ platform: target.platform, accountId: target.accountId, username: target.username }), checkedAt);
    // Parsing is inside the guard too: malformed adapter objects can have throwing getters.
    observation = CreatorBatchCapacityObservationSchema.parse(raw);
  } catch { throw new CreatorPreflightError('quota', 'account', target); }
  const observedAt = observation.checkedAt === null ? NaN : Date.parse(observation.checkedAt);
  const now = Date.now();
  if (observation.platform !== target.platform || observation.accountId !== target.accountId ||
      !Number.isFinite(observedAt) || observedAt > now || now - observedAt > 60_000 ||
      (observation.remaining !== undefined && observation.available !== undefined && observation.remaining !== observation.available) ||
      (canPostMore !== undefined && observation.canPostMore !== undefined && observation.canPostMore !== canPostMore)) {
    throw new CreatorPreflightError('quota', 'account', target);
  }
  return { ...observation, ...(canPostMore !== undefined ? { canPostMore } : {}) };
}

function emitCapacity(observations: CreatorBatchCapacityObservation[], observer?: CreatorCapacityObserver): void {
  if (!observer) return;
  const snapshot = Object.freeze(observations.map((observation) => Object.freeze({ ...observation })));
  try { observer(snapshot); }
  catch { throw new CreatorPreflightError('quota', 'shared'); }
}

/** Read-only GET identity/capability checks run before storage construction or uploads. */
export async function remoteCreatorPreflight(
  client: ZernioClient, deps: CreatorDeps, preset: CreatorPreset, duration: number,
  options: CreatorPreflightOptions = {},
): Promise<CreatorBatchCapacityObservation[]> {
  const targets = selectedTargets(preset, options.targetAccountIds);
  if (!targets.length) return [];
  if (options.queuePolicy !== undefined && options.queuePolicy !== 'allow-provider-queue' && options.queuePolicy !== 'require-capacity') {
    throw new CreatorPreflightError('quota', 'shared');
  }
  try { assertRunMode(deps.media.providerContext(), 'Creator remote preflight'); }
  catch { throw new CreatorPreflightError('network', 'shared'); }
  await validateRemoteIdentity(client, preset, targets);
  const observations: CreatorBatchCapacityObservation[] = [];
  for (const target of targets) {
    let canPostMore: boolean | undefined;
    try {
      if (target.platform === 'tiktok') {
        let response: ZernioResponse;
        try { response = await remoteGet(client, `/accounts/${encodeURIComponent(target.accountId)}/tiktok/creator-info?mediaType=video`, target); }
        catch (error) {
          if (error instanceof CreatorPreflightError && error.kind === 'quota') canPostMore = false;
          throw error;
        }
        const capability = CreatorTikTokEnvelopeSchema.safeParse(response.body);
        if (!capability.success) throw new CreatorPreflightError('capability', 'account', target);
        canPostMore = capability.data.creator.canPostMore;
        if (!canPostMore) throw new CreatorPreflightError('quota', 'account', target);
        try { assertTikTokCapability(capability.data, target.options, duration); }
        catch { throw new CreatorPreflightError('capability', 'account', target); }
      }
      const observation = await capacityObservation(target, options.capacitySource, canPostMore);
      observations.push(observation);
      emitCapacity(observations, options.onCapacity);
      const remaining = observation.remaining ?? observation.available;
      if (observation.canPostMore === false || (options.queuePolicy === 'require-capacity' &&
          (observation.status !== 'confirmed' || remaining === undefined || remaining < 1))) {
        throw new CreatorPreflightError('quota', 'account', target);
      }
    } catch (error) {
      if (!observations.some((observation) => observation.accountId === target.accountId)) {
        observations.push(await capacityObservation(target, undefined, canPostMore));
        emitCapacity(observations, options.onCapacity);
      }
      throw error;
    }
  }
  // A slow later account/source or observer must not leave earlier evidence stale at return.
  const now = Date.now();
  for (const observation of observations) {
    const observedAt = observation.checkedAt === null ? NaN : Date.parse(observation.checkedAt);
    if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > 60_000) {
      throw new CreatorPreflightError('quota', 'account', observation);
    }
  }
  return observations;
}
