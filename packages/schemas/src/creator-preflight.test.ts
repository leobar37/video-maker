import { describe, expect, test } from 'bun:test';
import {
  CreatorPreflightRemoteAccountSchema,
  CreatorPreflightRemoteAccountsSchema,
  CreatorPreflightRemoteHealthSchema,
  CreatorPreflightRemoteProfileSchema,
  CreatorPreflightRemoteProfilesSchema,
} from './index';

const profile = { id: 'profile-1', name: 'Approved profile' };
const account = { accountId: 'account-1', platform: 'tiktok', username: 'approved-user' };
const health = { accountId: 'account-1', status: 'healthy', canPost: true };

describe('creator preflight remote DTOs', () => {
  test('accepts supported profile wrappers and preserves unknown rows', () => {
    const rows = [profile, null, { unrelated: true }];
    for (const body of [rows, { profiles: rows }, { data: rows }]) {
      expect(CreatorPreflightRemoteProfilesSchema.parse(body)).toEqual(rows);
    }
    expect(CreatorPreflightRemoteProfilesSchema.parse({ profiles: [], data: rows })).toEqual([]);
    expect(CreatorPreflightRemoteProfilesSchema.parse({ profiles: rows, pagination: { total: 3 } })).toEqual(rows);
    expect(CreatorPreflightRemoteProfilesSchema.parse([])).toEqual([]);
    expect(CreatorPreflightRemoteAccountsSchema.parse({ accounts: [account, health, null], extra: true }))
      .toEqual({ accounts: [account, health, null] });
  });

  test('accepts all supported profile, account and health identity fields', () => {
    for (const identity of [{ _id: 'profile-1' }, { id: 'profile-1' }]) {
      expect(CreatorPreflightRemoteProfileSchema.safeParse({ ...identity, name: profile.name }).success).toBe(true);
    }
    for (const identity of [{ _id: 'account-1' }, { id: 'account-1' }, { accountId: 'account-1' }]) {
      expect(CreatorPreflightRemoteAccountSchema.safeParse({ ...identity, platform: account.platform, username: account.username }).success).toBe(true);
    }
    for (const identity of [{ id: 'account-1' }, { accountId: 'account-1' }]) {
      expect(CreatorPreflightRemoteHealthSchema.safeParse({ ...identity, status: health.status, canPost: health.canPost }).success).toBe(true);
    }
    expect(CreatorPreflightRemoteHealthSchema.parse({ ...health, username: account.username, platform: account.platform, extra: true }))
      .toEqual({ ...health, username: account.username, platform: account.platform });
  });

  test('rejects missing, empty or incorrectly typed identities', () => {
    for (const body of [{ name: profile.name }, { id: '', name: profile.name }, { _id: 1, name: profile.name }, { ...profile, name: '' }]) {
      expect(CreatorPreflightRemoteProfileSchema.safeParse(body).success).toBe(false);
    }
    for (const identity of [{}, { _id: '' }, { id: '' }, { accountId: '' }, { accountId: 1 }]) {
      expect(CreatorPreflightRemoteAccountSchema.safeParse({ ...identity, platform: account.platform, username: account.username }).success).toBe(false);
    }
    for (const identity of [{}, { id: '' }, { accountId: '' }, { accountId: 1 }]) {
      expect(CreatorPreflightRemoteHealthSchema.safeParse({ ...identity, status: health.status, canPost: health.canPost }).success).toBe(false);
    }
  });

  test('rejects malformed health and account fields without changing health policy', () => {
    for (const fields of [{ status: '' }, { status: null }, { canPost: 'true' }, { canPost: undefined }, { username: '' }, { platform: 1 }]) {
      expect(CreatorPreflightRemoteHealthSchema.safeParse({ ...health, ...fields }).success).toBe(false);
    }
    for (const fields of [{ platform: '' }, { username: '' }, { username: null }]) {
      expect(CreatorPreflightRemoteAccountSchema.safeParse({ ...account, ...fields }).success).toBe(false);
    }
    // DTO validation preserves policy decisions for the consumer's selected identity check.
    expect(CreatorPreflightRemoteHealthSchema.safeParse({ ...health, status: 'disconnected', canPost: false }).success).toBe(true);
  });

  test('rejects missing and non-array envelope fields', () => {
    for (const body of [null, {}, { profiles: null }, { profiles: {} }, { data: 'invalid' }, { profiles: [], data: false }]) {
      expect(CreatorPreflightRemoteProfilesSchema.safeParse(body).success).toBe(false);
    }
    for (const body of [null, {}, [], { accounts: null }, { accounts: {} }, { accounts: 'invalid' }]) {
      expect(CreatorPreflightRemoteAccountsSchema.safeParse(body).success).toBe(false);
    }
  });
});
