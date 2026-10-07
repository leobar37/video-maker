/**
 * E2E fixture client: reset/migrate the emulated D1, provision the two-client
 * workspace, mint REAL Better Auth sessions through the fake-mail sink, and
 * drive the v1 API with session cookies. Runs only against the loopback e2e
 * server (guarded by the E2E_FIXTURE var).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { ORIGIN } from './server';

const APP_DIR = join(import.meta.dir, '..', '..');

export interface ProvisionedClient {
  id: string;
  studioClientId: string;
  name: string;
}

export interface FixtureData {
  workspaceId: string;
  alpha: ProvisionedClient;
  beta: ProvisionedClient;
}

export const ADMIN = 'admin@e2e.fixture';
export const ALICE = 'alice@e2e.fixture';
export const BOB = 'bob@e2e.fixture';
export const CAROL = 'carol@e2e.fixture';

/** Migration DDL from apps/customer-assets/migrations (comment-safe split). */
export function migrationStatements(): string[] {
  const statements: string[] = [];
  for (const file of ['0001_auth.sql', '0002_portal.sql', '0003_portal_projects.sql', '0004_upload_requests.sql', '0005_asset_upload_links.sql']) {
    const sql = readFileSync(join(APP_DIR, 'migrations', file), 'utf8');
    const withoutComments = sql
      .split('\n')
      .map((line) => line.replace(/--.*$/, ''))
      .join('\n');
    for (const statement of withoutComments.split(';')) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) statements.push(trimmed);
    }
  }
  return statements;
}

async function fixturePost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as Record<string, unknown>;
  if (!response.ok || json.ok !== true) {
    throw new Error(`fixture ${path} failed (${response.status}): ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

export async function resetDatabase(): Promise<void> {
  await fixturePost('/api/fixture/reset', { statements: migrationStatements() });
}

export async function provisionFixture(): Promise<FixtureData> {
  const result = await fixturePost('/api/fixture/provision', {
    users: [
      { email: ADMIN, name: 'Portal Admin', role: 'admin' },
      { email: ALICE, name: 'Alice Alpha', role: 'member' },
      { email: BOB, name: 'Bob Beta', role: 'member' },
    ],
    workspaceLabel: 'E2E Studio Workspace',
    integratorEmail: ALICE,
    clients: [
      { studioClientId: 'e2e-alpha', name: 'Alpha Cliente' },
      { studioClientId: 'e2e-beta', name: 'Beta Cliente' },
    ],
    memberships: [
      { userEmail: ALICE, clientIndex: 0 },
      { userEmail: BOB, clientIndex: 1 },
    ],
  });
  const clients = result.clients as ProvisionedClient[];
  return { workspaceId: result.workspaceId as string, alpha: clients[0]!, beta: clients[1]! };
}

/**
 * Signs a persona in THROUGH THE REAL Better Auth machinery: the fixture
 * endpoint captures the magic link with a fake sink and returns the verify
 * URL; visiting it issues the real session cookie and redirect. No token
 * ever reaches a screenshot (navigation lands on the callback path).
 */
export async function loginPersona(context: BrowserContext, email: string, callbackURL: string): Promise<void> {
  const result = await fixturePost('/api/fixture/session', { email, callbackURL });
  const verifyUrl = result.verifyUrl as string;
  const page = await context.newPage();
  try {
    await page.goto(verifyUrl, { waitUntil: 'load' });
  } finally {
    await page.close();
  }
}

/* v1 API with a session cookie (harness-side seeding, like the CLI would) */

export function sha256Hex(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

/** A real, decodable 1×1 blue PNG so grid thumbnails render as images. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
export const PNG_BYTES: Uint8Array = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

export const MP4_BYTES: Uint8Array = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, ...'ftyp'.split('').map((c) => c.charCodeAt(0)), ...'isom'.split('').map((c) => c.charCodeAt(0)),
  ...[...'e2e-clip-mp4'].map((c) => c.charCodeAt(0)),
]);

export interface StagedDelivery {
  deliveryId: string;
  assetId: string;
  outputs: { name: string; mediaType: string; bytes: Uint8Array; sha256: string }[];
}

async function api(
  path: string,
  init: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH';
    cookie?: string;
    body?: unknown;
    rawBody?: Uint8Array;
    contentType?: string;
  },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie) headers.cookie = init.cookie;
  if (init.contentType) headers['content-type'] = init.contentType;
  const response = await fetch(`${ORIGIN}${path}`, {
    method: init.method,
    headers,
    body: (init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body))) as BodyInit,
  });
  return response;
}

/** Stages a delivery with all outputs through the v1 API as the admin. */
export async function stageDeliveryAsAdmin(
  cookie: string,
  clientId: string,
  options: { assetSuffix: string; title: string },
): Promise<StagedDelivery> {
  const outputs = [
    { name: 'cover.png', mediaType: 'image/png', bytes: PNG_BYTES },
    { name: 'clip.mp4', mediaType: 'video/mp4', bytes: MP4_BYTES },
  ].map((output) => ({ ...output, sha256: sha256Hex(output.bytes) }));

  const createRes = await api(`/api/v1/clients/${clientId}/deliveries`, {
    method: 'POST',
    cookie,
    body: {
      projectId: 'proj-e2e-1',
      assetId: `asset-e2e-${options.assetSuffix}`,
      revisionId: `rev-e2e-${options.assetSuffix}-${Date.now()}`,
      rootHash: sha256Hex(new TextEncoder().encode('e2e-sealed-root')),
      title: options.title,
      kind: 'social',
      outputs: outputs.map((output) => ({ name: output.name, mediaType: output.mediaType, bytes: output.bytes.byteLength, sha256: output.sha256 })),
    },
  });
  if (createRes.status !== 201) throw new Error(`delivery create failed: ${createRes.status} ${await createRes.text()}`);
  const delivery = (await createRes.json()) as { id: string };

  for (const output of outputs) {
    const initRes = await api(`/api/v1/clients/${clientId}/uploads`, {
      method: 'POST',
      cookie,
      body: {
        kind: 'delivery_output',
        mediaType: output.mediaType,
        declaredBytes: output.bytes.byteLength,
        sha256: output.sha256,
        deliveryId: delivery.id,
        outputName: output.name,
      },
    });
    if (initRes.status !== 201) throw new Error(`output init failed: ${initRes.status} ${await initRes.text()}`);
    const session = (await initRes.json()) as { uploadId: string };
    const putRes = await api(`/api/v1/uploads/${session.uploadId}/content`, {
      method: 'PUT',
      cookie,
      rawBody: output.bytes,
      contentType: output.mediaType,
    });
    if (putRes.status !== 200) throw new Error(`output put failed: ${putRes.status} ${await putRes.text()}`);
    const completeRes = await api(`/api/v1/uploads/${session.uploadId}/complete`, { method: 'POST', cookie });
    if (completeRes.status !== 201) throw new Error(`output complete failed: ${completeRes.status}`);
  }

  const completeDelivery = await api(`/api/v1/deliveries/${delivery.id}/complete`, { method: 'POST', cookie });
  if (completeDelivery.status !== 200) throw new Error(`delivery complete failed: ${completeDelivery.status}`);

  const assetsRes = await api(`/api/v1/clients/${clientId}/assets`, { method: 'GET', cookie });
  const assets = (await assetsRes.json()) as { items: { id: string; deliveryId: string }[] };
  const asset = assets.items.find((entry) => entry.deliveryId === delivery.id);
  if (asset === undefined) throw new Error('staged asset not found in catalog');
  return { deliveryId: delivery.id, assetId: asset.id, outputs };
}

export { api as apiWithCookie };
