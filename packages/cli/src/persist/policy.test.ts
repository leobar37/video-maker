import { describe, expect, test } from 'bun:test';

import { PersistError } from './errors';
import {
  assertNotSecretPath,
  contentTypeFor,
  isArchivableBinary,
  isExcludedPath,
} from './policy';

describe('isExcludedPath (regenerables stay out of bundles)', () => {
  test('excludes dependency trees, caches, build output', () => {
    expect(isExcludedPath('node_modules/pkg/index.js')).toBe(true);
    expect(isExcludedPath('scenes/node_modules/pkg/index.js')).toBe(true);
    expect(isExcludedPath('.cache/frames/001.png')).toBe(true);
    expect(isExcludedPath('.turbo/turbo-build.log')).toBe(true);
    expect(isExcludedPath('.git/config')).toBe(true);
    expect(isExcludedPath('dist/bundle.js')).toBe(true);
    expect(isExcludedPath('remotion/dist-web/main.js')).toBe(true);
  });

  test('excludes lockfiles and temp files', () => {
    expect(isExcludedPath('bun.lock')).toBe(true);
    expect(isExcludedPath('bun.lockb')).toBe(true);
    expect(isExcludedPath('yarn.lock')).toBe(true);
    expect(isExcludedPath('renders/partial.mp4.tmp')).toBe(true);
    expect(isExcludedPath('renders/capture.tmp-123')).toBe(true);
    expect(isExcludedPath('.DS_Store')).toBe(true);
  });

  test('keeps real project content', () => {
    expect(isExcludedPath('video.json')).toBe(false);
    expect(isExcludedPath('script/01-hook.md')).toBe(false);
    expect(isExcludedPath('renders/hero.mp4')).toBe(false);
    expect(isExcludedPath('assets/logo.png')).toBe(false);
    expect(isExcludedPath('qa/archive.json')).toBe(false);
  });
});

describe('assertNotSecretPath (refused, never silently dropped)', () => {
  test('refuses credential-looking paths with an actionable error', () => {
    expect(() => assertNotSecretPath('.env')).toThrow(PersistError);
    expect(() => assertNotSecretPath('.env.production')).toThrow(/secret/);
    expect(() => assertNotSecretPath('qa/credentials.json')).toThrow(PersistError);
    expect(() => assertNotSecretPath('secrets/prod.json')).toThrow(PersistError);
    expect(() => assertNotSecretPath('assets/id_ed25519')).toThrow(PersistError);
    expect(() => assertNotSecretPath('assets/tls/server.pem')).toThrow(PersistError);
    expect(() => assertNotSecretPath('assets/signing.key')).toThrow(PersistError);
  });

  test('allows ordinary project paths', () => {
    expect(() => assertNotSecretPath('video.json')).not.toThrow();
    expect(() => assertNotSecretPath('assets/logo.png')).not.toThrow();
    expect(() => assertNotSecretPath('qa/archive.json')).not.toThrow();
    expect(() => assertNotSecretPath('renders/keyboard-shortcuts.png')).not.toThrow();
  });
});

describe('archive selection', () => {
  test('picks media binaries only', () => {
    expect(isArchivableBinary('renders/hero.mp4')).toBe(true);
    expect(isArchivableBinary('assets/VO.wav')).toBe(true);
    expect(isArchivableBinary('assets/cover.JPEG')).toBe(true);
    expect(isArchivableBinary('video.json')).toBe(false);
    expect(isArchivableBinary('qa/archive.json')).toBe(false);
    expect(isArchivableBinary('script/01-hook.md')).toBe(false);
    expect(isArchivableBinary('assets/style.css')).toBe(false);
  });

  test('derives content types from extensions', () => {
    expect(contentTypeFor('renders/hero.mp4')).toBe('video/mp4');
    expect(contentTypeFor('assets/cover.png')).toBe('image/png');
    expect(contentTypeFor('assets/data.bin')).toBe('application/octet-stream');
  });
});
