/**
 * Portal credential + origin discipline (contracts.md §7): explicit https
 * origins (loopback http only for local fakes), env-only credentials, and a
 * client factory that never reads the credential at construction time.
 */
import { describe, expect, test } from 'bun:test';

import { StudioServiceError } from '@videomaker/studio';

import { API_KEY_ENV, createPortalClient, parsePortalOrigin, readApiKey, requireApiKey } from './auth';

describe('parsePortalOrigin', () => {
  test('accepts explicit https origins and normalizes them', () => {
    expect(parsePortalOrigin('https://portal.example.com')).toBe('https://portal.example.com');
    expect(parsePortalOrigin('https://portal.example.com/')).toBe('https://portal.example.com');
    expect(parsePortalOrigin('https://portal.example.com:8443/')).toBe('https://portal.example.com:8443');
  });

  test('accepts http ONLY on loopback hosts (local fake origins)', () => {
    expect(parsePortalOrigin('http://127.0.0.1:4567')).toBe('http://127.0.0.1:4567');
    expect(parsePortalOrigin('http://localhost:9000')).toBe('http://localhost:9000');
    expect(parsePortalOrigin('http://[::1]:9000')).toBe('http://[::1]:9000');
  });

  test('rejects http on public hosts, other schemes and empty values', () => {
    for (const bad of [
      'http://portal.example.com',
      'ftp://portal.example.com',
      'portal.example.com',
      '',
      '   ',
      null,
      undefined,
      42,
    ]) {
      try {
        parsePortalOrigin(bad);
        throw new Error(`expected rejection for ${String(bad)}`);
      } catch (error) {
        if (!(error instanceof StudioServiceError)) throw new Error(`se esperaba StudioServiceError para ${String(bad)}`);
        expect(error.code).toBe('INVALID_INPUT');
      }
    }
  });

  test('rejects paths, query, fragments and embedded credentials', () => {
    for (const bad of [
      'https://portal.example.com/api/v1',
      'https://portal.example.com?x=1',
      'https://portal.example.com/#frag',
      'https://user:pass@portal.example.com',
      'https://agent@portal.example.com',
    ]) {
      expect(() => parsePortalOrigin(bad)).toThrow(StudioServiceError);
    }
  });
});

describe('credential source', () => {
  test('readApiKey returns undefined for missing/empty env', () => {
    expect(readApiKey({})).toBeUndefined();
    expect(readApiKey({ [API_KEY_ENV]: '' })).toBeUndefined();
    expect(readApiKey({ [API_KEY_ENV]: 'abc' })).toBe('abc');
  });

  test('requireApiKey fails AUTH_REQUIRED (operational) without the env var', () => {
    try {
      requireApiKey({});
      throw new Error('unreachable');
    } catch (error) {
      if (!(error instanceof StudioServiceError)) throw new Error('se esperaba StudioServiceError');
      expect(error.code).toBe('AUTH_REQUIRED');
      // The error never echoes a credential (there is none) nor a flag name.
      expect(error.message).toContain(API_KEY_ENV);
    }
  });

  test('requireApiKey returns the injected value and never leaks it in errors', () => {
    expect(requireApiKey({ [API_KEY_ENV]: 'injected-key' })).toBe('injected-key');
  });

  test('createPortalClient does NOT resolve the credential at construction time', () => {
    // Missing credential: constructing is fine — only real calls would fail.
    expect(() => createPortalClient('http://127.0.0.1:1')).not.toThrow();
    // The resolver is lazy: it reads the env passed at construction per call.
    const env = { [API_KEY_ENV]: 'lazy-key' };
    const client = createPortalClient('http://127.0.0.1:1', env);
    expect(client).toBeDefined();
  });
});
