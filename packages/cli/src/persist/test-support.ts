/**
 * Test-only helpers for the persistence suites (same convention as
 * `providers/src/media/test-support.ts`): temp dirs, a throwing CLI context,
 * and an in-memory `ObjectStore` fake with a counting `ProviderContext` that
 * proves plan() never touches fetch or secrets.
 */
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex } from '@videomaker/core';
import type { ObjectMeta, ObjectStore, ProviderContext, SecretSource } from '@videomaker/providers';

import type { CommandRunContext } from '../spec-types';

const tempDirs: string[] = [];

/** Creates an isolated temp dir; call `cleanupTempDirs()` in `afterAll`. */
export async function makeTempDir(prefix = 'vm-persist-'): Promise<string> {
  const dir = await fsp.mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export async function cleanupTempDirs(): Promise<void> {
  await Promise.all(tempDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
}

/** Thrown by `fakeRunContext().fail` — asserts expect this, never process exit. */
export class FailSignal extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
    this.name = 'FailSignal';
  }
}

/** `CommandRunContext` whose `fail` throws `FailSignal` and whose `out` records lines. */
export function fakeRunContext(
  overrides: Partial<CommandRunContext> = {},
): CommandRunContext & { lines: string[] } {
  const lines: string[] = [];
  const ctx: CommandRunContext & { lines: string[] } = {
    args: {},
    cwd: process.cwd(),
    mode: 'run',
    out: (line: string) => {
      lines.push(line);
    },
    fail: (message: string, code?: number): never => {
      throw new FailSignal(message, code);
    },
    lines,
    ...overrides,
  };
  return ctx;
}

interface StoredObject {
  data: Uint8Array;
  contentType?: string;
}

/** In-memory `ObjectStore` port fake: records every call for assertions. */
export class FakeObjectStore implements ObjectStore {
  readonly objects = new Map<string, StoredObject>();
  readonly calls: Array<{ op: 'head' | 'put' | 'get' | 'inspect'; key: string }> = [];

  async head(key: string): Promise<ObjectMeta | null> {
    this.calls.push({ op: 'head', key });
    const found = this.objects.get(key);
    return found ? this.metaOf(key, found) : null;
  }

  async put(key: string, body: Uint8Array, opts: { contentType?: string }): Promise<ObjectMeta> {
    this.calls.push({ op: 'put', key });
    const stored: StoredObject = { data: body, contentType: opts.contentType };
    this.objects.set(key, stored);
    return this.metaOf(key, stored);
  }

  async get(key: string): Promise<Uint8Array> {
    this.calls.push({ op: 'get', key });
    const found = this.objects.get(key);
    if (!found) throw new Error(`FakeObjectStore: missing object ${key}`);
    return found.data;
  }

  async inspect(key: string): Promise<ObjectMeta> {
    this.calls.push({ op: 'inspect', key });
    const found = this.objects.get(key);
    if (!found) throw new Error(`FakeObjectStore: missing object ${key}`);
    return this.metaOf(key, found);
  }

  private metaOf(key: string, stored: StoredObject): ObjectMeta {
    return {
      key,
      bytes: stored.data.byteLength,
      sha256: sha256Hex(stored.data),
      contentType: stored.contentType,
    };
  }
}

export interface CountingProviderContext {
  ctx: ProviderContext;
  counts: { fetch: number; secrets: number };
}

/**
 * A run-mode `ProviderContext` whose fetch and secret seams COUNT (and refuse)
 * every call: any use from plan() is a test failure.
 */
export function countingProviderContext(): CountingProviderContext {
  const counts = { fetch: 0, secrets: 0 };
  const secrets: SecretSource = {
    getSecret: async (name: string): Promise<string> => {
      counts.secrets += 1;
      throw new Error(`secret resolution attempted in tests: ${name}`);
    },
  };
  const fetchImpl = (async (): Promise<Response> => {
    counts.fetch += 1;
    throw new Error('network fetch attempted in tests');
  }) as unknown as typeof fetch;
  return {
    ctx: { mode: 'run', secrets, fetchImpl, clock: { now: () => new Date() } },
    counts,
  };
}
