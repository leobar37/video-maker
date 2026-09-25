/**
 * keys.test.ts — known credential names and the R2 helpers.
 */
import { describe, expect, test } from 'bun:test';

import {
  accountIdFromEndpoint,
  ALL_SECRET_NAMES,
  CREDENTIAL_NAMES,
  R2_GENERIC_PAIR,
  R2_MARKETING_PAIR,
  R2_REQUIRED_NAMES,
} from './keys';

describe('credential name registries', () => {
  test('known credential names cover media providers', () => {
    expect([...CREDENTIAL_NAMES]).toEqual(['FAL_KEY', 'ZERNIO_API_KEY', 'ELEVENLABS_API_KEY']);
  });

  test('the R2 contract has no R2_ACCOUNT_ID: it is derived from the endpoint', () => {
    const names = [...R2_REQUIRED_NAMES, ...R2_MARKETING_PAIR, ...R2_GENERIC_PAIR];
    expect(names).not.toContain('R2_ACCOUNT_ID');
    expect([...R2_REQUIRED_NAMES]).toEqual([
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_ENDPOINT',
    ]);
  });

  test('bucket/public URL come in two named pairs', () => {
    expect([...R2_MARKETING_PAIR]).toEqual([
      'R2_MARKETING_BUCKET_NAME',
      'R2_MARKETING_PUBLIC_URL',
    ]);
    expect([...R2_GENERIC_PAIR]).toEqual(['R2_BUCKET_NAME', 'R2_PUBLIC_URL']);
  });

  test('ALL_SECRET_NAMES unions credentials and required R2 names exactly once', () => {
    const names = [...ALL_SECRET_NAMES];
    expect(names).toHaveLength(CREDENTIAL_NAMES.length + R2_REQUIRED_NAMES.length);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('accountIdFromEndpoint', () => {
  test('derives the accountId from the endpoint hostname', () => {
    expect(accountIdFromEndpoint('https://abc123def.r2.cloudflarestorage.com')).toBe('abc123def');
  });

  test('ignores path and trailing slashes', () => {
    expect(accountIdFromEndpoint('https://acc0unt.r2.cloudflarestorage.com/bucket/')).toBe('acc0unt');
  });

  test('returns empty string for non-URL input', () => {
    expect(accountIdFromEndpoint('not a url')).toBe('');
  });
});
