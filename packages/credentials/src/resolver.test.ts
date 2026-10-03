/**
 * resolver.test.ts — env → `.env` → Doppler precedence, lazy resolution,
 * caching, plan-mode refusal, the R2 pair rule and redaction. No network:
 * fetch is always injected.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { CREDENTIAL_NAMES } from './keys';
import {
  assertNotPlanMode,
  CredentialMissingError,
  credentialReport,
  DOPPLER_TOKEN_ENV,
  parseEnvFileValues,
  redact,
  resetCredentialCache,
  resolveCredentials,
  resolveR2Env,
  type ResolveOptions,
} from './resolver';

const TOUCHED_ENV = [
  ...CREDENTIAL_NAMES,
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'R2_ENDPOINT',
  'R2_MARKETING_BUCKET_NAME',
  'R2_MARKETING_PUBLIC_URL',
  'R2_BUCKET_NAME',
  'R2_PUBLIC_URL',
  'R2_BUNDLES_BUCKET_NAME',
  DOPPLER_TOKEN_ENV,
  'HOME',
] as const;

const DOPPLER_PAYLOAD = {
  FAL_KEY: 'doppler-fal-secret',
  ZERNIO_API_KEY: 'doppler-zernio-secret',
  ELEVENLABS_API_KEY: 'doppler-eleven-secret',
  TYPE_SAFE_AI: 'doppler-typesafe-secret',
  R2_ACCESS_KEY_ID: 'doppler-access-key',
  R2_SECRET_ACCESS_KEY: 'doppler-secret-key',
  R2_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com',
  R2_MARKETING_BUCKET_NAME: 'marketing-bucket',
  R2_MARKETING_PUBLIC_URL: 'https://cdn.example.com/marketing',
  R2_BUCKET_NAME: 'generic-bucket',
  R2_PUBLIC_URL: 'https://cdn.example.com/generic',
  R2_BUNDLES_BUCKET_NAME: 'bundles-bucket',
  NOT_A_SECRET: 42,
};

interface FetchCall {
  url: string;
  authorization: string | undefined;
}

function stubFetch(payload: unknown, options: { status?: number } = {}) {
  const calls: FetchCall[] = [];
  const impl = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(input), authorization: init?.headers?.Authorization });
    return new Response(JSON.stringify(payload), { status: options.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

let savedEnv: Record<string, string | undefined>;
let savedCwd: string;
let workDir: string;

beforeEach(() => {
  savedEnv = {};
  for (const key of TOUCHED_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Work in a temp dir with no `.env` anywhere up the tree and an empty HOME,
  // so the real project `.env` and ~/.config are never consulted.
  savedCwd = process.cwd();
  workDir = mkdtempSync(join(tmpdir(), 'credentials-test-'));
  process.chdir(workDir);
  process.env.HOME = workDir;
  resetCredentialCache();
});

afterEach(() => {
  process.chdir(savedCwd);
  for (const key of TOUCHED_ENV) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetCredentialCache();
});

describe('env → .env → Doppler precedence', () => {
  test('process.env value wins over Doppler without any fetch', async () => {
    process.env.FAL_KEY = 'env-fal-secret';
    process.env[DOPPLER_TOKEN_ENV] = 'tok-env';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);

    const resolved = await resolveCredentials('FAL_KEY', { mode: 'run', fetchImpl: impl });

    expect(resolved).toBe('env-fal-secret');
    expect(calls).toHaveLength(0);
  });

  test('project .env value is used when the environment is empty', async () => {
    writeFileSync(join(workDir, '.env'), 'FAL_KEY=env-file-fal-secret\n');
    process.env[DOPPLER_TOKEN_ENV] = 'tok-env';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);

    const resolved = await resolveCredentials('FAL_KEY', { mode: 'run', fetchImpl: impl });

    expect(resolved).toBe('env-file-fal-secret');
    expect(calls).toHaveLength(0);
  });

  test('process.env beats the project .env', async () => {
    writeFileSync(join(workDir, '.env'), 'FAL_KEY=env-file-fal-secret\n');
    process.env.FAL_KEY = 'env-fal-secret';
    process.env[DOPPLER_TOKEN_ENV] = 'tok-env';
    const { impl } = stubFetch(DOPPLER_PAYLOAD);

    const resolved = await resolveCredentials('FAL_KEY', { mode: 'run', fetchImpl: impl });

    expect(resolved).toBe('env-fal-secret');
  });

  test('project .env beats Doppler', async () => {
    writeFileSync(join(workDir, '.env'), 'FAL_KEY=env-file-fal-secret\n');
    process.env[DOPPLER_TOKEN_ENV] = 'tok-env';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);

    const resolved = await resolveCredentials('FAL_KEY', { mode: 'run', fetchImpl: impl });

    expect(resolved).toBe('env-file-fal-secret');
    expect(calls).toHaveLength(0);
  });

  test('the whole R2 contract resolves from the project .env without network', async () => {
    writeFileSync(
      join(workDir, '.env'),
      [
        'R2_ACCESS_KEY_ID=file-access-key',
        'R2_SECRET_ACCESS_KEY=file-secret-key',
        'R2_ENDPOINT=https://fileacct.r2.cloudflarestorage.com/',
        'R2_BUNDLES_BUCKET_NAME=file-bundles',
        'R2_MARKETING_BUCKET_NAME=file-marketing-bucket',
        'R2_MARKETING_PUBLIC_URL=https://cdn.example.com/marketing/',
      ].join('\n'),
    );
    process.env[DOPPLER_TOKEN_ENV] = 'tok-env';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);

    const env = await resolveR2Env({ mode: 'run', fetchImpl: impl });

    expect(calls).toHaveLength(0);
    expect(env).toEqual({
      accountId: 'fileacct',
      accessKeyId: 'file-access-key',
      secretAccessKey: 'file-secret-key',
      bucket: 'file-marketing-bucket',
      endpoint: 'https://fileacct.r2.cloudflarestorage.com',
      publicUrl: 'https://cdn.example.com/marketing',
      bundlesBucket: 'file-bundles',
    });
  });

  test('Doppler fallback works per key and wins only when env and .env are silent', async () => {
    process.env.FAL_KEY = 'env-fal-secret';
    process.env[DOPPLER_TOKEN_ENV] = 'tok-abc123';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);
    const opts: ResolveOptions = { mode: 'run', fetchImpl: impl };

    expect(await resolveCredentials('FAL_KEY', opts)).toBe('env-fal-secret');
    expect(await resolveCredentials('ELEVENLABS_API_KEY', opts)).toBe('doppler-eleven-secret');
    expect(await resolveCredentials('ZERNIO_API_KEY', opts)).toBe('doppler-zernio-secret');
    expect(await resolveCredentials('TYPE_SAFE_AI', opts)).toBe('doppler-typesafe-secret');
    expect(calls).toHaveLength(1);
  });

  test('downloads with Basic auth (token as username, empty password) and pinned query', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-abc123';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);

    await resolveCredentials('FAL_KEY', { mode: 'run', fetchImpl: impl });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://api.doppler.com/v3/configs/config/secrets/download',
    );
    expect(url.searchParams.get('format')).toBe('json');
    expect(url.searchParams.get('project')).toBe('elena-tech');
    expect(url.searchParams.get('config')).toBe('prd');
    const auth = calls[0]!.authorization ?? '';
    expect(auth.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(auth.slice('Basic '.length), 'base64').toString()).toBe('tok-abc123:');
  });

  test('Doppler token is read from ~/.config/elena-tech/config.json when env is absent', async () => {
    const configDir = join(workDir, '.config', 'elena-tech');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify({ dopplerToken: 'cfg-file-token', other: 'ignored' }),
    );
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);

    const resolved = await resolveCredentials('ZERNIO_API_KEY', { mode: 'run', fetchImpl: impl });

    expect(resolved).toBe('doppler-zernio-secret');
    const auth = calls[0]!.authorization ?? '';
    expect(Buffer.from(auth.slice('Basic '.length), 'base64').toString()).toBe('cfg-file-token:');
  });

  test('env token wins over the config-file token', async () => {
    const configDir = join(workDir, '.config', 'elena-tech');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({ dopplerToken: 'cfg-file-token' }));
    process.env[DOPPLER_TOKEN_ENV] = 'env-token';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);

    await resolveCredentials('FAL_KEY', { mode: 'run', fetchImpl: impl });

    const auth = calls[0]!.authorization ?? '';
    expect(Buffer.from(auth.slice('Basic '.length), 'base64').toString()).toBe('env-token:');
  });
});

describe('parseEnvFileValues', () => {
  test('parses KEY=value, strips matched quotes and ignores junk lines', () => {
    const path = join(workDir, 'sample.env');
    writeFileSync(
      path,
      [
        '# comment',
        'PLAIN=value',
        'QUOTED="quoted value"',
        "SINGLE='single value'",
        'UNMATCHED="open quote',
        'lower=ignored',
        '',
      ].join('\n'),
    );

    expect(parseEnvFileValues(path)).toEqual({
      PLAIN: 'value',
      QUOTED: 'quoted value',
      SINGLE: 'single value',
      UNMATCHED: '"open quote',
    });
  });
});

describe('in-memory cache', () => {
  test('one Doppler download serves repeated and sibling lookups', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-cache';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);
    const opts: ResolveOptions = { mode: 'run', fetchImpl: impl };

    await resolveCredentials('FAL_KEY', opts);
    await resolveCredentials('FAL_KEY', opts);
    await resolveCredentials('ZERNIO_API_KEY', opts);
    expect(calls).toHaveLength(1);

    // env-side cache hit: mutating env after resolution does not change the result.
    process.env.FAL_KEY = 'mutated-later';
    expect(await resolveCredentials('FAL_KEY', opts)).toBe('doppler-fal-secret');
    expect(calls).toHaveLength(1);
  });

  test('resetCredentialCache forces a fresh download again', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-cache';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);
    const opts: ResolveOptions = { mode: 'run', fetchImpl: impl };

    await resolveCredentials('FAL_KEY', opts);
    expect(calls).toHaveLength(1);
    resetCredentialCache();
    await resolveCredentials('FAL_KEY', opts);
    expect(calls).toHaveLength(2);
  });

  test('resolveR2Env is cached per process', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-cache';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);
    const opts: ResolveOptions = { mode: 'run', fetchImpl: impl };

    const first = await resolveR2Env(opts);
    const second = await resolveR2Env(opts);

    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });
});

describe('plan-mode refusal', () => {
  test('resolution throws in plan mode even with credentials available', async () => {
    process.env.FAL_KEY = 'env-fal-secret';
    const { impl, calls } = stubFetch(DOPPLER_PAYLOAD);
    const opts: ResolveOptions = { mode: 'plan', fetchImpl: impl };

    await expect(resolveCredentials('FAL_KEY', opts)).rejects.toThrow(/plan mode/);
    await expect(resolveR2Env(opts)).rejects.toThrow(/plan mode/);
    expect(calls).toHaveLength(0);
  });

  test('assertNotPlanMode is the exported hard stop', () => {
    expect(() => assertNotPlanMode('plan')).toThrow(/plan mode/);
    expect(() => assertNotPlanMode('run')).not.toThrow();
  });

  test('credentialReport also refuses plan mode', async () => {
    await expect(credentialReport({ mode: 'plan' })).rejects.toThrow(/plan mode/);
  });
});

describe('redaction', () => {
  test('redact reports name and length only', () => {
    const text = redact('super-secret-value', 'FAL_KEY');
    expect(text).toContain('FAL_KEY');
    expect(text).toContain(String('super-secret-value'.length));
    expect(text).not.toContain('super-secret-value');
  });

  test('redact marks absent values as missing', () => {
    expect(redact(undefined, 'FAL_KEY')).toBe('FAL_KEY=<missing>');
  });

  test('missing-credential error is actionable and leaks no values', async () => {
    const { impl } = stubFetch(DOPPLER_PAYLOAD);
    process.env.FAL_KEY = 'another-secret-value';

    const failure = resolveCredentials('ELEVENLABS_API_KEY', { mode: 'run', fetchImpl: impl });
    await expect(failure).rejects.toBeInstanceOf(CredentialMissingError);
    const message = await failure.catch((error: Error) => error.message);

    expect(message).toContain(DOPPLER_TOKEN_ENV);
    expect(message).toContain('~/.config/elena-tech/config.json');
    expect(message).toContain('ELEVENLABS_API_KEY');
    expect(message).not.toContain('doppler-eleven-secret');
    expect(message).not.toContain('another-secret-value');
    expect(message).not.toContain('doppler-zernio-secret');
  });

  test('download failures never echo the token, even from leaky errors', async () => {
    const token = 'tok-super-secret-token';
    process.env[DOPPLER_TOKEN_ENV] = token;
    const leaky = (async () => {
      throw new Error(`upstream leaked ${token}`);
    }) as unknown as typeof fetch;

    const failure = resolveCredentials('FAL_KEY', { mode: 'run', fetchImpl: leaky });
    const message = await failure.catch((error: Error) => error.message);

    expect(message).toContain('Doppler');
    expect(message).not.toContain(token);
    expect(message).toContain('<redacted>');
    expect(message).toContain(DOPPLER_TOKEN_ENV);
    expect(message).toContain('~/.config/elena-tech/config.json');
  });

  test('HTTP errors report status only, never secrets', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-http';
    const { impl } = stubFetch({ FAL_KEY: 'leaky-body-secret' }, { status: 401 });

    const failure = resolveCredentials('FAL_KEY', { mode: 'run', fetchImpl: impl });
    const message = await failure.catch((error: Error) => error.message);

    expect(message).toContain('401');
    expect(message).not.toContain('leaky-body-secret');
    expect(message).not.toContain('tok-http');
  });
});

describe('resolveR2Env', () => {
  test('marketing pair wins over the generic pair; accountId is derived, not requested', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-r2';
    const { impl } = stubFetch(DOPPLER_PAYLOAD);

    const env = await resolveR2Env({ mode: 'run', fetchImpl: impl });

    expect(env).toEqual({
      accountId: 'acct123',
      accessKeyId: 'doppler-access-key',
      secretAccessKey: 'doppler-secret-key',
      bucket: 'marketing-bucket',
      endpoint: 'https://acct123.r2.cloudflarestorage.com',
      publicUrl: 'https://cdn.example.com/marketing',
      bundlesBucket: 'bundles-bucket',
    });
  });

  test('generic-pair fallback is used when the marketing pair is not declared', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-r2';
    const { impl } = stubFetch({
      R2_ACCESS_KEY_ID: 'doppler-access-key',
      R2_SECRET_ACCESS_KEY: 'doppler-secret-key',
      R2_ENDPOINT: 'https://acct123.r2.cloudflarestorage.com',
      R2_BUCKET_NAME: 'generic-bucket',
      R2_PUBLIC_URL: 'https://cdn.example.com/generic/',
    });

    const env = await resolveR2Env({ mode: 'run', fetchImpl: impl });

    expect(env.bucket).toBe('generic-bucket');
    expect(env.publicUrl).toBe('https://cdn.example.com/generic');
    expect(env.bundlesBucket).toBeUndefined();
  });

  test('marketing-pair togetherness: bucket alone is rejected with the 404 warning', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-r2';
    process.env.R2_MARKETING_BUCKET_NAME = 'half-marketing';
    const { impl } = stubFetch(DOPPLER_PAYLOAD);

    const failure = resolveR2Env({ mode: 'run', fetchImpl: impl });
    const message = await failure.catch((error: Error) => error.message);

    expect(message).toContain('R2_MARKETING_BUCKET_NAME');
    expect(message).toContain('R2_MARKETING_PUBLIC_URL');
    expect(message).toContain('404');
    expect(message).not.toContain('half-marketing');
  });

  test('marketing-pair togetherness: public URL alone is rejected too', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-r2';
    process.env.R2_MARKETING_PUBLIC_URL = 'https://half.example.com';
    const { impl } = stubFetch({});

    const failure = resolveR2Env({ mode: 'run', fetchImpl: impl });
    const message = await failure.catch((error: Error) => error.message);

    expect(message).toContain('R2_MARKETING_BUCKET_NAME');
    expect(message).toContain('R2_MARKETING_PUBLIC_URL');
    expect(message).toContain('404');
    expect(message).not.toContain('half.example.com');
  });

  test('missing contract lists exactly the required names', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-r2';
    const { impl } = stubFetch({});

    const failure = resolveR2Env({ mode: 'run', fetchImpl: impl });
    const message = await failure.catch((error: Error) => error.message);

    expect(message).toContain('R2_ACCESS_KEY_ID');
    expect(message).toContain('R2_SECRET_ACCESS_KEY');
    expect(message).toContain('R2_ENDPOINT');
    expect(message).toContain('R2_BUCKET_NAME');
    expect(message).toContain('R2_PUBLIC_URL');
    expect(message).not.toContain('R2_MARKETING_BUCKET_NAME');
    expect(message).not.toContain('R2_BUNDLES_BUCKET_NAME');
  });

  test('an endpoint that cannot yield an accountId is rejected', async () => {
    process.env[DOPPLER_TOKEN_ENV] = 'tok-r2';
    process.env.R2_ENDPOINT = 'not-a-url';
    const { impl } = stubFetch(DOPPLER_PAYLOAD);

    const failure = resolveR2Env({ mode: 'run', fetchImpl: impl });
    const message = await failure.catch((error: Error) => error.message);

    expect(message).toContain('accountId');
    expect(message).toContain('R2_ENDPOINT');
    expect(message).not.toContain('not-a-url');
  });
});

describe('credentialReport', () => {
  test('reports names, presence and lengths only, with the derived accountId label', async () => {
    process.env.FAL_KEY = 'env-fal-secret';
    process.env[DOPPLER_TOKEN_ENV] = 'tok-report';
    const { impl } = stubFetch({ ...DOPPLER_PAYLOAD, FAL_KEY: undefined });

    const report = await credentialReport({ mode: 'run', fetchImpl: impl });

    expect(report.map((entry) => entry.name)).toEqual([
      'FAL_KEY',
      'ZERNIO_API_KEY',
      'ELEVENLABS_API_KEY',
      'TYPE_SAFE_AI',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_ENDPOINT',
      'bucket',
      'publicUrl',
      'accountId (derived)',
    ]);
    expect(report.find((entry) => entry.name === 'FAL_KEY')).toEqual({
      name: 'FAL_KEY',
      present: true,
      length: 'env-fal-secret'.length,
    });
    expect(report.find((entry) => entry.name === 'accountId (derived)')).toEqual({
      name: 'accountId (derived)',
      present: true,
      length: 'acct123'.length,
    });
    for (const entry of report) {
      expect(Object.keys(entry).sort()).toEqual(['length', 'name', 'present']);
    }
    const serialized = JSON.stringify(report);
    for (const secret of Object.values(DOPPLER_PAYLOAD)) {
      if (typeof secret === 'string') expect(serialized).not.toContain(secret);
    }
  });

  test('missing entries come back present:false instead of throwing', async () => {
    const report = await credentialReport({ mode: 'run', fetchImpl: stubFetch({}).impl });

    expect(report.every((entry) => !entry.present)).toBe(true);
    expect(report.every((entry) => entry.length === 0)).toBe(true);
  });
});
