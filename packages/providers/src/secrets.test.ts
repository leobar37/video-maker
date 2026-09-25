/**
 * secrets: the `SecretSource` seam over `@videomaker/credentials` — plan-mode
 * refusal preserved (NFR-002) and redacted-only reporting (NFR-001).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { resetCredentialCache } from '@videomaker/credentials';

import { makeFakeFetch } from './media/test-support';
import { createSecretSource } from './secrets';

const SECRET_VALUE = 'env-secret-value-123';

beforeEach(() => {
  resetCredentialCache();
});

afterEach(() => {
  delete process.env.FAL_KEY;
  resetCredentialCache();
});

describe('createSecretSource plan-mode refusal (NFR-002)', () => {
  test('plan mode refuses resolution without any fetch', async () => {
    const { fetchImpl, requests } = makeFakeFetch(() => new Response(''));
    const source = createSecretSource({ fetchImpl });

    await expect(source.getSecret('FAL_KEY', 'plan')).rejects.toThrow('plan mode');
    expect(requests.length).toBe(0);
  });

  test('unknown secret names are refused before anything is resolved', async () => {
    const { fetchImpl, requests } = makeFakeFetch(() => new Response(''));
    const source = createSecretSource({ fetchImpl });

    await expect(source.getSecret('NOT_A_SECRET', 'run')).rejects.toThrow('Unknown secret name');
    expect(requests.length).toBe(0);
  });
});

describe('createSecretSource resolution', () => {
  test('run mode resolves env-first without network and logs only redaction', async () => {
    process.env.FAL_KEY = SECRET_VALUE;
    resetCredentialCache();
    const { fetchImpl, requests } = makeFakeFetch(() => new Response(''));
    const logs: string[] = [];
    const source = createSecretSource({ fetchImpl, logger: (msg) => logs.push(msg) });

    const value = await source.getSecret('FAL_KEY', 'run');

    expect(value).toBe(SECRET_VALUE);
    expect(requests.length).toBe(0);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('FAL_KEY=<set');
    for (const line of logs) expect(line).not.toContain(SECRET_VALUE);
  });
});
