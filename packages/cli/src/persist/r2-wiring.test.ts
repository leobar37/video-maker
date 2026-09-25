/**
 * `r2-wiring` — the production `ArchiveStorageSource` for `vm archive` run
 * mode. Proves the wiring is lazy (zero resolutions until a real run invokes
 * it), that the archive bucket is an explicit `bundlesBucket ?? bucket` choice,
 * and that `describeArchiveTarget` can be printed without ever exposing a
 * secret (NFR-001). All offline: seams and environment fixtures only.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { resetCredentialCache, type R2Env } from '@videomaker/credentials';
import { R2ObjectStore } from '@videomaker/providers';

import {
  resetArchiveStorageSource,
  resolveArchiveStorage,
  setArchiveStorageSource,
} from './index';
import {
  archiveTargetOf,
  createR2ArchiveStorageSource,
  describeArchiveTarget,
} from './r2-wiring';
import { archiveSpec } from '../specs/persist';
import {
  cleanupTempDirs,
  fakeRunContext,
  FakeObjectStore,
  makeTempDir,
} from './test-support';

const ACCESS_KEY_ID_VALUE = 'test-access-key-id';
const SECRET_ACCESS_KEY_VALUE = 'test-secret-access-key';

/** Fake R2 contract: values are invented, never real credentials. */
const BASE_R2_ENV: R2Env = {
  accountId: 'acct123',
  accessKeyId: ACCESS_KEY_ID_VALUE,
  secretAccessKey: SECRET_ACCESS_KEY_VALUE,
  bucket: 'marketing-bucket',
  endpoint: 'https://acct123.r2.cloudflarestorage.com',
  publicUrl: 'https://cdn.example.com/marketing',
};

/** Saves, overwrites and restores `process.env` entries around one test. */
async function withProcessEnv(
  entries: Record<string, string>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(
    Object.keys(entries).map((name) => [name, process.env[name] as string | undefined]),
  );
  Object.assign(process.env, entries);
  try {
    await run();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

afterAll(cleanupTempDirs);
afterEach(() => {
  resetArchiveStorageSource();
  resetCredentialCache();
});

describe('createR2ArchiveStorageSource', () => {
  test('resolves lazily: zero environment resolutions until a real run invokes the source', async () => {
    let resolutions = 0;
    setArchiveStorageSource(
      createR2ArchiveStorageSource({
        resolveEnv: async () => {
          resolutions += 1;
          return BASE_R2_ENV;
        },
      }),
    );

    // Installing the source touches nothing: no env, no secrets, no network.
    expect(resolutions).toBe(0);

    const storage = await resolveArchiveStorage();
    expect(resolutions).toBe(1);
    expect(storage.store).toBeInstanceOf(R2ObjectStore);
    expect(storage.ctx.mode).toBe('run');
    expect(storage.ctx.fetchImpl).toBe(globalThis.fetch);
    expect(storage.ctx.secrets).toBeDefined();
    expect(storage.ctx.clock.now()).toBeInstanceOf(Date);
  });

  test('the archive bucket is an explicit choice: bundlesBucket ?? bucket', async () => {
    const withBundles = await createR2ArchiveStorageSource({
      resolveEnv: async () => ({ ...BASE_R2_ENV, bundlesBucket: 'bundles-bucket' }),
    })();
    const bundlesStore = withBundles.store as R2ObjectStore;
    expect(bundlesStore.env.bucket).toBe('bundles-bucket');
    // The rest of the contract still reaches the store untouched.
    expect(bundlesStore.env.endpoint).toBe(BASE_R2_ENV.endpoint);
    expect(bundlesStore.env.accessKeyId).toBe(ACCESS_KEY_ID_VALUE);

    const withoutBundles = await createR2ArchiveStorageSource({
      resolveEnv: async () => ({ ...BASE_R2_ENV }),
    })();
    expect((withoutBundles.store as R2ObjectStore).env.bucket).toBe('marketing-bucket');
  });

  test('the default wiring resolves offline from process.env and never fetches', async () => {
    await withProcessEnv(
      {
        R2_ACCESS_KEY_ID: 'ak-default',
        R2_SECRET_ACCESS_KEY: 'sk-default',
        R2_ENDPOINT: 'https://acct9.r2.cloudflarestorage.com',
        R2_MARKETING_BUCKET_NAME: 'marketing-bucket',
        R2_MARKETING_PUBLIC_URL: 'https://cdn.example.com/marketing',
        R2_BUNDLES_BUCKET_NAME: 'bundles-bucket',
      },
      async () => {
        resetCredentialCache();
        let fetches = 0;
        const storage = await createR2ArchiveStorageSource({
          fetchImpl: (async (): Promise<Response> => {
            fetches += 1;
            throw new Error('network fetch attempted in tests');
          }) as unknown as typeof fetch,
        })();
        expect(fetches).toBe(0);
        expect((storage.store as R2ObjectStore).env.bucket).toBe('bundles-bucket');
        expect(archiveTargetOf(storage)?.bucket).toBe('bundles-bucket');
      },
    );
  });
});

describe('describeArchiveTarget', () => {
  test('reports where objects go and never a secret value', () => {
    const description = describeArchiveTarget({
      ...BASE_R2_ENV,
      bundlesBucket: 'bundles-bucket',
    });

    expect(description).toEqual({
      bucket: 'bundles-bucket',
      endpointHost: 'acct123.r2.cloudflarestorage.com',
      keyPrefix: 'objects',
      publicUrlPolicy: 'https://cdn.example.com/marketing/<key>',
    });

    // The report shape is exactly the four reporting fields — no secrets — and
    // the serialized form carries neither credential value (NFR-001).
    expect(Object.keys(description).sort()).toEqual([
      'bucket',
      'endpointHost',
      'keyPrefix',
      'publicUrlPolicy',
    ]);
    const serialized = JSON.stringify(description);
    expect(serialized).not.toContain(SECRET_ACCESS_KEY_VALUE);
    expect(serialized).not.toContain(ACCESS_KEY_ID_VALUE);
    expect(serialized).not.toContain('accountId');
  });

  test('archiveTargetOf describes a resolved R2 store and yields null for foreign stores', async () => {
    const storage = await createR2ArchiveStorageSource({
      resolveEnv: async () => BASE_R2_ENV,
    })();

    expect(archiveTargetOf(storage)?.bucket).toBe('marketing-bucket');
    expect(archiveTargetOf({ store: new FakeObjectStore(), ctx: storage.ctx })).toBeNull();
  });
});

describe('archiveSpec run output', () => {
  test('reports the target bucket and the full key list before the summary', async () => {
    const project = await makeTempDir('vm-r2-wiring-');
    await fsp.mkdir(join(project, 'renders'), { recursive: true });
    await fsp.writeFile(join(project, 'renders', 'sample.wav'), 'fake-wav-bytes');

    // Store fake (no network) carrying the resolved env the real adapter exposes.
    const fake = new FakeObjectStore();
    setArchiveStorageSource(
      createR2ArchiveStorageSource({
        resolveEnv: async () => ({ ...BASE_R2_ENV, bundlesBucket: 'bundles-bucket' }),
        createStore: (env) => Object.assign(fake, { env }),
      }),
    );

    const ctx = fakeRunContext({ args: { project } });
    const result = await archiveSpec.run(ctx);
    expect(result.exitCode).toBe(0);

    const lines = ctx.lines.join('\n');
    expect(lines).toContain(
      'target: s3://bundles-bucket via acct123.r2.cloudflarestorage.com',
    );
    // WHERE objects go is printed before anything uploads.
    expect(lines.indexOf('target: s3://bundles-bucket')).toBeLessThan(lines.indexOf('archived '));
    for (const step of result.planned ?? []) {
      expect(step.target).toMatch(/^objects\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
      expect(lines).toContain(`  ${step.target}  <-  renders/sample.wav`);
    }
    expect(lines).toContain('qa/archive.json');
  });
});
