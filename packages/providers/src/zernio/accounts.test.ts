/**
 * Accounts/health/profiles normalization and resolution rules (pure).
 */
import { describe, expect, it } from 'bun:test';

import {
  mergeHealth,
  normalizeAccount,
  parseProfiles,
  resolveAccountRef,
  resolveTargetAccount,
  resolveZernioProfile,
  toPublisherAccount,
  ZernioAccountError,
  type ZernioAccount,
} from './accounts';

const ACCOUNTS: ZernioAccount[] = [
  { id: 'acc-1', platform: 'instagram', username: 'brand' },
  { id: 'acc-2', platform: 'instagram', username: 'other' },
  { id: 'acc-3', platform: 'tiktok', username: 'brand' },
];

describe('normalizeAccount / mergeHealth', () => {
  it('uses _id and username when present, id/displayName as fallback', () => {
    expect(normalizeAccount({ _id: 'a', platform: 'instagram', username: 'u' })).toEqual({
      id: 'a',
      platform: 'instagram',
      username: 'u',
      displayName: undefined,
    });
    expect(normalizeAccount({ id: 'b', platform: 'tiktok', displayName: 'B' })).toEqual({
      id: 'b',
      platform: 'tiktok',
      username: 'B',
      displayName: 'B',
    });
  });

  it('merges status/canPost by id and leaves unknown accounts untouched', () => {
    const merged = mergeHealth(ACCOUNTS, [
      { accountId: 'acc-1', status: 'ok', canPost: true },
      { id: 'acc-3', status: 'expired' },
    ]);
    expect(merged[0]).toMatchObject({ status: 'ok', canPost: true });
    expect(merged[1]).toEqual(ACCOUNTS[1]);
    expect(merged[2]).toMatchObject({ status: 'expired', canPost: undefined });
  });
});

describe('resolveTargetAccount / resolveAccountRef', () => {
  it('resolves by platform and disambiguates with @user', () => {
    expect(resolveTargetAccount(ACCOUNTS, 'tiktok').id).toBe('acc-3');
    expect(resolveTargetAccount(ACCOUNTS, 'instagram', '@Other').id).toBe('acc-2');
  });

  it('throws on zero or multiple matches (never lands on the wrong account)', () => {
    expect(() => resolveTargetAccount(ACCOUNTS, 'linkedin')).toThrow(ZernioAccountError);
    expect(() => resolveTargetAccount(ACCOUNTS, 'instagram')).toThrow(ZernioAccountError);
  });

  it('resolves account refs: bare id, platform selector, platform:@user', () => {
    expect(resolveAccountRef(ACCOUNTS, 'acc-3')).toEqual({ platform: 'tiktok', accountId: 'acc-3' });
    expect(resolveAccountRef(ACCOUNTS, 'tiktok:@brand')).toEqual({
      platform: 'tiktok',
      accountId: 'acc-3',
    });
  });
});

describe('profiles', () => {
  it('parses wrappers and raw arrays, tolerating broken entries', () => {
    expect(parseProfiles({ profiles: [{ _id: 'p1', name: 'Default', isDefault: true }] })).toEqual([
      { id: 'p1', name: 'Default', isDefault: true },
    ]);
    expect(parseProfiles([{ id: 'p2', name: 'Other' }, null])).toEqual([
      { id: 'p2', name: 'Other', isDefault: false },
      { id: '', name: '', isDefault: false },
    ]);
  });

  it('resolves "default" to the isDefault profile and rejects unknown names', () => {
    const profiles = [
      { id: 'p1', name: 'Default', isDefault: true },
      { id: 'p2', name: 'Rafelito', isDefault: false },
    ];
    expect(resolveZernioProfile(profiles, 'DEFAULT').id).toBe('p1');
    expect(resolveZernioProfile(profiles, 'rafelito').id).toBe('p2');
    expect(() => resolveZernioProfile(profiles, 'nope')).toThrow(ZernioAccountError);
  });
});

describe('toPublisherAccount', () => {
  it('maps health to the port shape', () => {
    expect(toPublisherAccount({ id: 'acc-1', platform: 'instagram', username: 'brand', canPost: true })).toEqual({
      id: 'acc-1',
      handle: 'brand',
      healthy: true,
      detail: 'platform=instagram;status=unknown;canPost=true',
    });
    expect(
      toPublisherAccount({ id: 'acc-2', platform: 'tiktok', status: 'expired' }).healthy,
    ).toBe(false);
    expect(toPublisherAccount({ id: 'acc-3', platform: 'tiktok', status: 'ok' }).healthy).toBe(true);
  });
});
