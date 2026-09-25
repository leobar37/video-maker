import { afterAll, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import {
  InvalidHashInputError,
  canonicalJson,
  sha256File,
  sha256Hex,
  sha256Json,
} from './hash';

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(join(import.meta.dir, '.tmp-'));
  tempDirs.push(dir);
  return dir;
}

const SHA256_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('sha256Hex', () => {
  test('matches the known SHA-256 vector for "abc"', () => {
    expect(sha256Hex('abc')).toBe(SHA256_ABC);
  });

  test('hashes raw bytes identically to UTF-8 text', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(SHA256_ABC);
  });
});

describe('sha256File', () => {
  test('matches the digest of the file contents', async () => {
    const dir = await makeTempDir();
    const path = join(dir, 'abc.txt');
    await fsp.writeFile(path, 'abc');
    expect(await sha256File(path)).toBe(SHA256_ABC);
  });

  test('rejects when the file cannot be read', async () => {
    const dir = await makeTempDir();
    await expect(sha256File(join(dir, 'missing.txt'))).rejects.toThrow(InvalidHashInputError);
  });
});

describe('canonicalJson', () => {
  test('sorts object keys at every depth', () => {
    expect(canonicalJson({ b: { d: 3, c: 2 }, a: 1 })).toBe('{"a":1,"b":{"c":2,"d":3}}');
  });

  test('rejects non-JSON values', () => {
    expect(() => canonicalJson(undefined)).toThrow(InvalidHashInputError);
    expect(() => canonicalJson({ a: undefined })).toThrow(InvalidHashInputError);
    expect(() => canonicalJson({ a: () => 1 })).toThrow(InvalidHashInputError);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(InvalidHashInputError);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(InvalidHashInputError);
    expect(() => canonicalJson(new Date())).toThrow(InvalidHashInputError);
  });

  test('rejects cycles', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(InvalidHashInputError);
  });

  test('rejects sparse arrays and accessors', () => {
    const sparse: number[] = [1];
    sparse[2] = 3;
    expect(() => canonicalJson(sparse)).toThrow(InvalidHashInputError);
    const hidden = { a: 1 };
    Object.defineProperty(hidden, 'b', {
      get: () => 2,
      enumerable: true,
    });
    expect(() => canonicalJson(hidden)).toThrow(InvalidHashInputError);
  });
});

describe('sha256Json', () => {
  test('is independent of key order', () => {
    expect(sha256Json({ a: 1, b: 2 })).toBe(sha256Json({ b: 2, a: 1 }));
    expect(sha256Json({ a: { x: 1, y: 2 } })).toBe(sha256Json({ a: { y: 2, x: 1 } }));
  });

  test('changes when any value changes', () => {
    expect(sha256Json({ a: 1 })).not.toBe(sha256Json({ a: 2 }));
    expect(sha256Json({ a: { x: 1 } })).not.toBe(sha256Json({ a: { x: 2 } }));
  });

  test('array order is significant', () => {
    expect(sha256Json([1, 2])).not.toBe(sha256Json([2, 1]));
  });

  test('hashes the canonical encoding', () => {
    expect(sha256Json({ a: 1 })).toBe(sha256Hex('{"a":1}'));
  });
});
