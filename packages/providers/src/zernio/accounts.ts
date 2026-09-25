/**
 * Zernio accounts surface: connected accounts, health, and profile listing.
 *
 * Endpoints: `GET /accounts`, `GET /accounts/health`, `GET /profiles`
 * (profiles group the connected accounts; posts target an `accountId` of a
 * profile). Pure helpers keep the normalization/resolution rules testable
 * without any network.
 */
import type { ProviderContext, PublisherAccount } from '../ports';
import { assertRunMode } from '../storage/context';
import type { ZernioClient } from './client';

/** Default profile name when a line declares none. */
export const DEFAULT_ZERNIO_PROFILE = 'default';

export interface ZernioAccount {
  id: string;
  platform: string;
  username?: string;
  displayName?: string;
  status?: string;
  canPost?: boolean;
}

export interface ZernioProfile {
  id: string;
  name: string;
  isDefault: boolean;
}

export class ZernioAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZernioAccountError';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(source: Record<string, unknown>, name: string): string | undefined {
  const value = source[name];
  return typeof value === 'string' ? value : undefined;
}

/** Normalizes a raw `GET /accounts` entry (`_id`/`id`, username/displayName). */
export function normalizeAccount(raw: Record<string, unknown>): ZernioAccount {
  const id =
    stringField(raw, '_id') ?? stringField(raw, 'id') ?? stringField(raw, 'accountId') ?? '';
  return {
    id,
    platform: stringField(raw, 'platform') ?? '',
    username: stringField(raw, 'username') ?? stringField(raw, 'displayName'),
    displayName: stringField(raw, 'displayName'),
  };
}

/** Fuses `GET /accounts` with `GET /accounts/health` by account id. */
export function mergeHealth(
  accounts: ZernioAccount[],
  health: Array<Record<string, unknown>>,
): ZernioAccount[] {
  const byId = new Map<string, Record<string, unknown>>();
  for (const entry of health) {
    const raw = asRecord(entry);
    byId.set(String(raw.accountId ?? raw.id ?? ''), raw);
  }
  return accounts.map((account) => {
    const entry = byId.get(account.id);
    if (!entry) return account;
    return {
      ...account,
      username: stringField(entry, 'username') ?? account.username,
      displayName: stringField(entry, 'displayName') ?? account.displayName,
      status: stringField(entry, 'status'),
      canPost: typeof entry.canPost === 'boolean' ? entry.canPost : undefined,
    };
  });
}

/**
 * Resolves the target account for a platform; `username` (with or without the
 * leading `@`) disambiguates. Zero or multiple matches throw, so a post can
 * never land on the wrong account.
 */
export function resolveTargetAccount(
  accounts: ZernioAccount[],
  platform: string,
  username?: string,
): ZernioAccount {
  const clean = username?.replace(/^@/, '').toLowerCase();
  const matches = accounts.filter(
    (account) =>
      account.platform.toLowerCase() === platform.toLowerCase() &&
      (!clean ||
        account.username?.replace(/^@/, '').toLowerCase() === clean ||
        account.displayName?.toLowerCase() === clean),
  );
  if (matches.length === 0) throw new ZernioAccountError(`No connected account for "${platform}".`);
  if (matches.length > 1) {
    throw new ZernioAccountError(
      `2+ accounts on "${platform}": disambiguate with "${platform}:@user" (${matches
        .map((m) => `@${m.username ?? m.id}`)
        .join(', ')}).`,
    );
  }
  const found = matches[0];
  if (!found.id) throw new ZernioAccountError(`Account on ${platform} has no id.`);
  return found;
}

/**
 * Resolves a `SocialPost.account` reference: a bare account id, a
 * `platform` selector or a `platform:@user` selector.
 */
export function resolveAccountRef(
  accounts: ZernioAccount[],
  ref: string,
): { platform: string; accountId: string } {
  const trimmed = ref.trim();
  const byId = accounts.find((account) => account.id === trimmed);
  if (byId) {
    if (!byId.platform) throw new ZernioAccountError(`Account ${trimmed} has no platform.`);
    return { platform: byId.platform, accountId: byId.id };
  }
  const [platform, username] = trimmed.split(':');
  if (!platform) throw new ZernioAccountError(`Empty account reference.`);
  const found = resolveTargetAccount(accounts, platform, username);
  return { platform: found.platform, accountId: found.id };
}

/** Normalizes the `GET /profiles` payload (tolerant wrappers). */
export function parseProfiles(payload: unknown): ZernioProfile[] {
  const root = asRecord(payload);
  const raw = (root.profiles ?? root.data ?? payload) as unknown;
  const list = Array.isArray(raw) ? raw : [];
  return list.map((item) => {
    const profile = asRecord(item);
    return {
      id: String(profile._id ?? profile.id ?? ''),
      name: typeof profile.name === 'string' ? profile.name : '',
      isDefault: profile.isDefault === true,
    };
  });
}

/**
 * Resolves a profile by name or id (case-insensitive); `default` matches the
 * `isDefault` profile first. Unknown names throw listing the known profiles.
 */
export function resolveZernioProfile(profiles: ZernioProfile[], name: string): ZernioProfile {
  const wanted = name.trim().toLowerCase();
  const byName = profiles.filter(
    (profile) => profile.name.toLowerCase() === wanted || profile.id.toLowerCase() === wanted,
  );
  const found =
    wanted === DEFAULT_ZERNIO_PROFILE
      ? (profiles.find((profile) => profile.isDefault) ?? byName[0])
      : byName[0];
  if (!found || !found.id) {
    throw new ZernioAccountError(
      `Unknown Zernio profile "${name}". Known: ${
        profiles.map((p) => `${p.name}${p.isDefault ? ' (default)' : ''}`).join(', ') || '(none)'
      }.`,
    );
  }
  return found;
}

/** Port mapping: merged account → `PublisherAccount`. */
export function toPublisherAccount(account: ZernioAccount): PublisherAccount {
  const healthy =
    typeof account.canPost === 'boolean'
      ? account.canPost
      : account.status === 'ok' || account.status === 'connected';
  return {
    id: account.id,
    handle: account.username,
    healthy,
    detail: `platform=${account.platform || '?'};status=${account.status ?? 'unknown'};canPost=${
      account.canPost ?? 'unknown'
    }`,
  };
}

/** Accounts/health/profiles over the Zernio client. */
export class ZernioAccounts {
  constructor(private readonly client: ZernioClient) {}

  /** `GET /accounts`, optionally scoped to a profile. */
  async list(ctx: ProviderContext, profileId?: string): Promise<ZernioAccount[]> {
    assertRunMode(ctx, 'Zernio accounts listing');
    const path = profileId
      ? `/accounts?profileId=${encodeURIComponent(profileId)}`
      : '/accounts';
    const { status, body } = await this.client.request(path);
    if (status !== 200) throw new ZernioAccountError(`GET /accounts → HTTP ${status}.`);
    const raw = asRecord(body).accounts;
    return (Array.isArray(raw) ? raw : []).map((item) => normalizeAccount(asRecord(item)));
  }

  /** `GET /accounts/health` (raw entries, tolerant). */
  async health(ctx: ProviderContext): Promise<Array<Record<string, unknown>>> {
    assertRunMode(ctx, 'Zernio accounts health');
    const { status, body } = await this.client.request('/accounts/health');
    if (status !== 200) return [];
    const raw = asRecord(body).accounts;
    return Array.isArray(raw) ? raw.map(asRecord) : [];
  }

  /** Accounts fused with health, one listing per call. */
  async merged(ctx: ProviderContext, profileId?: string): Promise<ZernioAccount[]> {
    const accounts = await this.list(ctx, profileId);
    return mergeHealth(accounts, await this.health(ctx));
  }

  /** `GET /profiles` (throws when the account has none). */
  async profiles(ctx: ProviderContext): Promise<ZernioProfile[]> {
    assertRunMode(ctx, 'Zernio profiles listing');
    const { status, body } = await this.client.request('/profiles');
    if (status !== 200) throw new ZernioAccountError(`GET /profiles → HTTP ${status}.`);
    const profiles = parseProfiles(body);
    if (profiles.length === 0) throw new ZernioAccountError('Zernio account has no profiles.');
    return profiles;
  }
}
