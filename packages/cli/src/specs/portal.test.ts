/**
 * CLI-level tests for the portal-* specs (P-003, contracts.md §7): stable
 * `--json` envelopes, exit codes 0/1/2, plan-only mutations with ZERO
 * network/fs writes/credential use, remote pagination, auth failures and
 * redirect discipline — all against an in-process fake origin on 127.0.0.1:0
 * (gate G-cap-live: no real network, no real credentials).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createStudioContext, snapshotAsset } from '@videomaker/studio';

import { runCli, runSpecs } from '../runtime';
import { allSpecs } from '../all-specs';
import type { CommandSpec } from '../spec-types';
import { portalSpecs } from './portal';
import { PNG_BYTES, makeWorkspace, startFakePortal, type FakePortal, type WorkspaceFixture } from '../portal/testing';
import { createIngestServer, setTailscaleIpv4ResolverForTests, type IngestServer } from '../portal/ingest-server';

// ---------------------------------------------------------------------------

const tempRoots: string[] = [];

afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspaceTracked(): Promise<WorkspaceFixture> {
  const fixture = await makeWorkspace('portal-specs');
  tempRoots.push(fixture.root);
  return fixture;
}

interface RunResult {
  code: number;
  lines: string[];
}

async function run(argv: string[], cwd: string, specs: readonly CommandSpec[] = portalSpecs): Promise<RunResult> {
  const lines: string[] = [];
  const code = await runSpecs(specs, argv, { cwd, out: (line) => void lines.push(line) });
  return { code, lines };
}

interface Envelope {
  schemaVersion: number;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

/** `--json` responses are exactly ONE stable envelope document on stdout. */
function parseEnvelope(result: RunResult): Envelope {
  expect(result.lines.length).toBe(1);
  return JSON.parse(result.lines[0]!) as Envelope;
}

/**
 * Reads a string field off outside-controlled envelope data with explicit
 * runtime guards (bun's depth-1 asymmetric matchers are unreliable, so this
 * checks the exact shape it trusts).
 */
function stringField(value: unknown, key: string): string {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    throw new Error(`se esperaba el campo "${key}" en ${JSON.stringify(value)?.slice(0, 160) ?? String(value)}`);
  }
  const record: Record<string, unknown> = value as Record<string, unknown>; // guarded above
  const field = record[key];
  if (typeof field !== 'string') {
    throw new Error(`se esperaba un string en "${key}"; llegó ${typeof field}: ${JSON.stringify(value)?.slice(0, 200)}`);
  }
  return field;
}

/** Injects the credential around a CLI run (spec layer reads process.env). */
async function withApiKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.CUSTOMER_ASSETS_API_KEY;
  process.env.CUSTOMER_ASSETS_API_KEY = key;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.CUSTOMER_ASSETS_API_KEY;
    else process.env.CUSTOMER_ASSETS_API_KEY = previous;
  }
}

/** Recursive workspace snapshot (path → size+mtime) for zero-write proofs. */
async function treeSnapshot(root: string): Promise<Map<string, string>> {
  const entries = new Map<string, string>();
  let info;
  try {
    info = await stat(root);
  } catch {
    return entries;
  }
  if (!info.isDirectory()) return entries;
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(abs);
        continue;
      }
      const fileStat = await stat(abs);
      entries.set(abs, `${fileStat.size}:${fileStat.mtimeMs}`);
    }
  };
  await walk(root);
  return entries;
}

// ---------------------------------------------------------------------------

const PORTAL_VERBS = [
  'portal-auth-status',
  'portal-client-adopt',
  'portal-client-list',
  'portal-material-list',
  'portal-material-show',
  'portal-material-pull',
  'portal-delivery-push',
  'portal-access-link',
  'portal-asset-list',
  'portal-request-create',
  'portal-request-list',
  'portal-request-close',
  'portal-request-link',
  'portal-request-pull',
  // Operator order 2026-10-06 (per-asset upload links).
  'portal-asset-upload-link',
  'portal-asset-pull',
  // Operator order 2026-10-06 §10 (tailnet ingest).
  'portal-ingest-serve',
  'portal-asset-ingest-pull',
];

describe('registry', () => {
  test('registers all eighteen portal verbs without touching legacy verbs', () => {
    const verbs = allSpecs().map((spec) => spec.verb);
    for (const verb of PORTAL_VERBS) expect(verbs).toContain(verb);
    // Legacy specs keep their internal kebab verbs (normalization untouched).
    expect(verbs).toContain('client-create');
    expect(verbs).toContain('asset-snapshot');
    expect(verbs).toContain('version');
  });
});

describe('reads: envelopes, pagination and auth failures', () => {
  let fake: FakePortal;

  beforeAll(async () => {
    fake = await startFakePortal();
  });

  afterAll(async () => {
    await fake.stop();
  });

  test('portal-auth-status --json prints the principal WITHOUT echoing the key', async () => {
    const result = await withApiKey(fake.apiKey, () => run(['portal-auth-status', '--origin', fake.origin, '--json'], '.'));
    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ principal: { kind: 'agent' } });
    // Scopes arrive as an array; the credential never appears in the output.
    expect(result.lines.join('\n')).toContain('"scopes"');
    expect(result.lines.join('\n')).not.toContain(fake.apiKey);
  });

  test('missing --origin fails at parse time: legacy text error, exit 2 (flat verbs keep the runtime contract)', async () => {
    const result = await withApiKey(fake.apiKey, () => run(['portal-auth-status', '--json'], '.'));
    expect(result.code).toBe(2);
    expect(result.lines[0]).toContain('error:');
  });

  test('non-https public origin is a usage error (exit 2)', async () => {
    const result = await withApiKey(fake.apiKey, () => run(['portal-auth-status', '--origin', 'http://portal.example.com', '--json'], '.'));
    expect(result.code).toBe(2);
    expect(parseEnvelope(result).error?.code).toBe('INVALID_INPUT');
  });

  test('pagination: portal-client-list walks cursor pages', async () => {
    await withApiKey(fake.apiKey, async () => {
      const ws = await makeWorkspaceTracked();
      const adopt = await run(['portal-client-adopt', ws.studioClientId, '--workspace', ws.workspaceDir, '--workspace-id', 'ws-a', '--origin', fake.origin, '--execute', '--json'], '.');
      expect(adopt.code).toBe(0);
      // A second projection (same studio client, another workspace) so the
      // page really has a successor.
      const adopt2 = await run(['portal-client-adopt', ws.studioClientId, '--workspace', ws.workspaceDir, '--workspace-id', 'ws-b', '--origin', fake.origin, '--execute', '--json'], '.');
      expect(adopt2.code).toBe(0);
      const page1 = parseEnvelope(await run(['portal-client-list', '--origin', fake.origin, '--limit', '1', '--json'], '.'));
      expect(page1.ok).toBe(true);
      const items = page1.data!.items;
      if (!Array.isArray(items)) throw new Error('items no es un array');
      expect(items.length).toBe(1);
      const cursor = page1.data!.nextCursor;
      if (typeof cursor !== 'string') throw new Error('se esperaba un cursor de página siguiente');
      const page2 = parseEnvelope(await run(['portal-client-list', '--origin', fake.origin, '--limit', '1', '--cursor', cursor, '--json'], '.'));
      expect(page2.ok).toBe(true);
      const items2 = page2.data!.items;
      if (!Array.isArray(items2)) throw new Error('items no es un array');
      expect(items2.length).toBe(1);
      expect(page2.data!.nextCursor).toBeNull();
    });
  });

  test('portal-material-show with an unknown id: NOT_FOUND envelope, exit 2', async () => {
    const result = await withApiKey(fake.apiKey, () => run(['portal-material-show', 'mat-does-not-exist', '--origin', fake.origin, '--json'], '.'));
    expect(result.code).toBe(2);
    const envelope = parseEnvelope(result);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('NOT_FOUND');
  });

  test('expired key: UNAUTHORIZED envelope, exit 1', async () => {
    const expired = await startFakePortal({ authMode: 'expired' });
    try {
      const result = await withApiKey(expired.apiKey, () => run(['portal-auth-status', '--origin', expired.origin, '--json'], '.'));
      expect(result.code).toBe(1);
      const envelope = parseEnvelope(result);
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('UNAUTHORIZED');
    } finally {
      await expired.stop();
    }
  });

  test('revoked key: UNAUTHORIZED envelope, exit 1', async () => {
    const revoked = await startFakePortal({ authMode: 'revoked' });
    try {
      const result = await withApiKey(revoked.apiKey, () => run(['portal-auth-status', '--origin', revoked.origin, '--json'], '.'));
      expect(result.code).toBe(1);
      expect(parseEnvelope(result).error?.code).toBe('UNAUTHORIZED');
    } finally {
      await revoked.stop();
    }
  });

  test('scope denied: FORBIDDEN envelope, exit 1', async () => {
    const denied = await startFakePortal({ authMode: 'forbidden' });
    try {
      const result = await withApiKey(denied.apiKey, () => run(['portal-asset-list', '--client', 'pc-1', '--origin', denied.origin, '--json'], '.'));
      expect(result.code).toBe(1);
      expect(parseEnvelope(result).error?.code).toBe('FORBIDDEN');
    } finally {
      await denied.stop();
    }
  });

  test('missing credential: AUTH_REQUIRED operational failure, exit 1', async () => {
    const previous = process.env.CUSTOMER_ASSETS_API_KEY;
    delete process.env.CUSTOMER_ASSETS_API_KEY;
    try {
      const result = await run(['portal-client-list', '--origin', fake.origin, '--json'], '.');
      expect(result.code).toBe(1);
      expect(parseEnvelope(result).error?.code).toBe('AUTH_REQUIRED');
    } finally {
      if (previous === undefined) delete process.env.CUSTOMER_ASSETS_API_KEY;
      else process.env.CUSTOMER_ASSETS_API_KEY = previous;
    }
  });

  test('redirects never receive credentials: 302 fails operational, nothing follows', async () => {
    const redirecting = await startFakePortal({ redirect: { path: '/api/v1/me', location: 'https://evil.example/me' } });
    try {
      const result = await withApiKey(redirecting.apiKey, () => run(['portal-auth-status', '--origin', redirecting.origin, '--json'], '.'));
      expect(result.code).toBe(1);
      const envelope = parseEnvelope(result);
      expect(envelope.ok).toBe(false);
      // The key never leaks through the error text either.
      expect(result.lines.join('\n')).not.toContain(redirecting.apiKey);
      // Exactly ONE request was attempted; the redirect target got nothing.
      expect(redirecting.requests.length).toBe(1);
      expect(redirecting.requests[0]!.path).toBe('/api/v1/me');
    } finally {
      await redirecting.stop();
    }
  });
});

describe('mutations: plan-only without --execute (zero IO, zero credential use)', () => {
  let fake: FakePortal;
  let ws: WorkspaceFixture;

  beforeAll(async () => {
    fake = await startFakePortal();
    ws = await makeWorkspaceTracked();
  });

  afterAll(async () => {
    await fake.stop();
  });

  const SENTINEL_KEY = 'SENTINEL-KEY-VALUE-000';

  async function expectPlanOnly(argv: string[]): Promise<void> {
    const before = await treeSnapshot(ws.workspaceDir);
    const requestsBefore = fake.requests.length;
    // The sentinel env var is present: plan mode must neither use nor print it.
    const result = await withApiKey(SENTINEL_KEY, () => run(argv, '.'));
    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result);
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.executed).toBe(false);
    expect(Array.isArray(envelope.data?.plan)).toBe(true);
    expect((envelope.data!.plan as unknown[]).length).toBeGreaterThan(0);
    expect(result.lines.join('\n')).not.toContain(SENTINEL_KEY);
    expect(fake.requests.length).toBe(requestsBefore);
    expect(await treeSnapshot(ws.workspaceDir)).toEqual(before);
  }

  test('portal-client-adopt without --execute is a pure plan', async () => {
    await expectPlanOnly(['portal-client-adopt', ws.studioClientId, '--workspace', ws.workspaceDir, '--workspace-id', 'ws-plan', '--origin', fake.origin, '--json']);
    expect(fake.deliveries().length).toBe(0);
  });

  test('portal-material-pull without --execute is a pure plan', async () => {
    await expectPlanOnly(['portal-material-pull', 'mat-1', '--project', ws.projectId, '--asset', ws.assetId, '--workspace', ws.workspaceDir, '--origin', fake.origin, '--json']);
  });

  test('portal-delivery-push without --execute is a pure plan', async () => {
    await expectPlanOnly(['portal-delivery-push', '--workspace', ws.workspaceDir, '--client', 'pc-1', '--project', ws.projectId, '--asset', ws.assetId, '--revision', 'rev-1', '--outputs', 'cover', '--origin', fake.origin, '--json']);
  });

  test('explicit --dry-run renders the human plan through the runtime: no network, no writes', async () => {
    const before = await treeSnapshot(ws.workspaceDir);
    const result = await withApiKey(SENTINEL_KEY, () => run(['portal-material-pull', 'mat-1', '--project', ws.projectId, '--asset', ws.assetId, '--workspace', ws.workspaceDir, '--origin', fake.origin, '--dry-run'], '.'));
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain('plan: portal-material-pull');
    expect(result.lines.join('\n')).not.toContain(SENTINEL_KEY);
    expect(fake.requests.length).toBe(0);
    expect(await treeSnapshot(ws.workspaceDir)).toEqual(before);
  });

  test('portal-access-link without --execute is a pure plan (no credential use, no network)', async () => {
    const before = await treeSnapshot(ws.workspaceDir);
    const requestsBefore = fake.requests.length;
    const result = await withApiKey(SENTINEL_KEY, () => run(['portal-access-link', '--client', 'pc-1', '--email', 'cliente@ejemplo.com', '--expires-in', '48h', '--origin', fake.origin, '--json'], '.'));
    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result);
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.executed).toBe(false);
    expect((envelope.data!.plan as unknown[]).length).toBeGreaterThan(0);
    // The plan may name the target email (operator input), never the key.
    expect(result.lines.join('\n')).not.toContain(SENTINEL_KEY);
    expect(fake.requests.length).toBe(requestsBefore);
    expect(await treeSnapshot(ws.workspaceDir)).toEqual(before);
  });

  test('portal-access-link usage errors stay local: exit 2, INVALID_INPUT, zero requests', async () => {
    const requestsBefore = fake.requests.length;
    const badTtl = await withApiKey(fake.apiKey, () => run(['portal-access-link', '--client', 'pc-1', '--email', 'cliente@ejemplo.com', '--expires-in', '5m', '--origin', fake.origin, '--json'], '.'));
    expect(badTtl.code).toBe(2);
    expect(parseEnvelope(badTtl).error?.code).toBe('INVALID_INPUT');

    const badUnit = await withApiKey(fake.apiKey, () => run(['portal-access-link', '--client', 'pc-1', '--email', 'cliente@ejemplo.com', '--expires-in', '7semanas', '--origin', fake.origin, '--json'], '.'));
    expect(badUnit.code).toBe(2);
    expect(parseEnvelope(badUnit).error?.code).toBe('INVALID_INPUT');

    const missingEmail = await withApiKey(fake.apiKey, () => run(['portal-access-link', '--client', 'pc-1', '--origin', fake.origin, '--json'], '.'));
    expect(missingEmail.code).toBe(2);
    // A missing REQUIRED arg dies at arg-parse time: legacy text error (same
    // contract as missing --origin), still exit 2 and still zero requests.
    expect(missingEmail.lines[0]).toContain('error:');
    expect(fake.requests.length).toBe(requestsBefore);
  });

  test('portal-request-create without --execute is a pure plan (grammar validated locally)', async () => {
    await expectPlanOnly(['portal-request-create', '--client', 'pc-1', '--project', 'proj', '--title', 'Fotos', '--max-files', '3', '--max-bytes', '4MiB', '--expires-in', '30d', '--origin', fake.origin, '--json']);
  });

  test('portal-request-close / link / pull without --execute are pure plans', async () => {
    await expectPlanOnly(['portal-request-close', 'req-1', '--reason', 'Ya no hace falta', '--origin', fake.origin, '--json']);
    await expectPlanOnly(['portal-request-link', 'req-1', '--expires-in', '48h', '--origin', fake.origin, '--json']);
    await expectPlanOnly(['portal-request-pull', 'req-1', '--project', ws.projectId, '--asset', ws.assetId, '--workspace', ws.workspaceDir, '--origin', fake.origin, '--json']);
  });

  test('portal-request-list (read) under --dry-run is a pure plan: zero requests', async () => {
    const requestsBefore = fake.requests.length;
    const result = await withApiKey('SENTINEL-KEY-PLAN', () => run(['portal-request-list', '--client', 'pc-1', '--project', 'pp-plan', '--state', 'open', '--origin', fake.origin, '--dry-run'], '.'));
    expect(result.code).toBe(0);
    expect(result.lines[0]).toContain('plan: portal-request-list');
    expect(result.lines.join('\n')).not.toContain('SENTINEL-KEY-PLAN');
    expect(fake.requests.length).toBe(requestsBefore);
  });

  test('portal-request-create grammar errors stay local: exit 2, zero requests', async () => {
    const requestsBefore = fake.requests.length;
    const badFiles = await withApiKey(fake.apiKey, () => run(['portal-request-create', '--client', 'pc-1', '--project', 'proj', '--title', 'T', '--max-files', '0', '--max-bytes', '4MiB', '--origin', fake.origin, '--json'], '.'));
    expect(badFiles.code).toBe(2);
    expect(parseEnvelope(badFiles).error?.code).toBe('INVALID_INPUT');
    const badBytesGrammar = await withApiKey(fake.apiKey, () => run(['portal-request-create', '--client', 'pc-1', '--project', 'proj', '--title', 'T', '--max-files', '3', '--max-bytes', '4MB', '--origin', fake.origin, '--json'], '.'));
    expect(badBytesGrammar.code).toBe(2);
    expect(parseEnvelope(badBytesGrammar).error?.code).toBe('INVALID_INPUT');
    const badState = await withApiKey(fake.apiKey, () => run(['portal-request-list', '--client', 'pc-1', '--state', 'archivado', '--origin', fake.origin, '--json'], '.'));
    expect(badState.code).toBe(2);
    const badExpiry = await withApiKey(fake.apiKey, () => run(['portal-request-create', '--client', 'pc-1', '--project', 'proj', '--title', 'T', '--max-files', '3', '--max-bytes', '4MiB', '--expires-in', '5m', '--origin', fake.origin, '--json'], '.'));
    expect(badExpiry.code).toBe(2);
    expect(fake.requests.length).toBe(requestsBefore);
  });

  test('portal-asset-upload-link without --execute is a pure plan (grammar validated locally)', async () => {
    await expectPlanOnly(['portal-asset-upload-link', '--project', ws.projectId, '--asset', ws.assetId, '--workspace', ws.workspaceDir, '--expires-in', '24h', '--origin', fake.origin, '--json']);
  });

  test('portal-asset-pull without --execute is a pure plan', async () => {
    await expectPlanOnly(['portal-asset-pull', '--project', ws.projectId, '--asset', ws.assetId, '--workspace', ws.workspaceDir, '--origin', fake.origin, '--json']);
  });

  test('portal-ingest-serve (§10) plans purely under --dry-run; bad --ingest-port is a local usage error', async () => {
    // serve is an operational command (no --execute gate): the pure plan is
    // reached with --dry-run, like every other read.
    const before = await treeSnapshot(ws.workspaceDir);
    const requestsBefore = fake.requests.length;
    const planResult = await withApiKey(SENTINEL_KEY, () => run(['portal-ingest-serve', '--origin', fake.origin, '--dry-run', '--json'], '.'));
    expect(planResult.code).toBe(0);
    // Flat verbs render the plan in human form under --dry-run (the runtime
    // path); the invariants are textual: wildcard never appears, tailscale
    // does, and the sentinel credential is never used or printed.
    const planText = planResult.lines.join('\n');
    expect(planText).toContain('0.0.0.0');
    expect(planText).toContain('tailscale');
    expect(planText).toContain('portal-asset-ingest-pull');
    expect(planText).not.toContain(SENTINEL_KEY);
    expect(fake.requests.length).toBe(requestsBefore);
    expect(await treeSnapshot(ws.workspaceDir)).toEqual(before);
    const badPort = await run(['portal-ingest-serve', '--origin', fake.origin, '--ingest-port', '70000', '--json'], '.');
    expect(badPort.code).toBe(2);
    expect(parseEnvelope(badPort).error?.code).toBe('INVALID_INPUT');
  });

  test('portal-asset-ingest-pull without --execute is a pure plan (local: no --origin, no credential)', async () => {
    await expectPlanOnly(['portal-asset-ingest-pull', '--project', ws.projectId, '--asset', ws.assetId, '--workspace', ws.workspaceDir, '--json']);
  });

  test('portal-asset-upload-link grammar errors stay local: exit 2, zero requests', async () => {
    const requestsBefore = fake.requests.length;
    const badExpiry = await withApiKey(fake.apiKey, () => run(['portal-asset-upload-link', '--project', ws.projectId, '--asset', ws.assetId, '--workspace', ws.workspaceDir, '--expires-in', '5m', '--origin', fake.origin, '--json'], '.'));
    expect(badExpiry.code).toBe(2);
    expect(parseEnvelope(badExpiry).error?.code).toBe('INVALID_INPUT');
    const badOrigin = await withApiKey(fake.apiKey, () => run(['portal-asset-upload-link', '--project', ws.projectId, '--asset', ws.assetId, '--workspace', ws.workspaceDir, '--origin', 'https://evil.example.com/path'], '.'));
    expect(badOrigin.code).toBe(2);
    expect(fake.requests.length).toBe(requestsBefore);
  });
});

describe('end-to-end through the CLI (real execution, fake origin)', () => {
  let fake: FakePortal;
  let ws: WorkspaceFixture;

  beforeAll(async () => {
    fake = await startFakePortal();
    ws = await makeWorkspaceTracked();
  });

  afterAll(async () => {
    await fake.stop();
  });

  test('adopt → pull → push round trip with stable envelopes and exits', async () => {
    await withApiKey(fake.apiKey, async () => {
      // Adopt through the CLI (with --execute).
      const adopt = await run(['portal-client-adopt', ws.studioClientId, '--workspace', ws.workspaceDir, '--workspace-id', 'ws-e2e', '--origin', fake.origin, '--execute', '--json'], '.');
      expect(adopt.code).toBe(0);
      const adoptEnvelope = parseEnvelope(adopt);
      // NOTE: extract first — bun's toMatchObject writes nested asymmetric
      // matchers back into the received object, so matchers never see `data`.
      const portalClientId = stringField(adoptEnvelope.data!.portalClient, 'id');
      expect(adoptEnvelope.data).toMatchObject({ executed: true, name: 'Acme Inc.' });

      // Seed a material for the adopted client and pull it through the CLI.
      const material = await fake.seedMaterial({ clientId: portalClientId, name: 'cover input.png', mediaType: 'image/png', bytes: PNG_BYTES });
      const pull = await run(['portal-material-pull', material.id, '--project', ws.projectId, '--asset', ws.assetId, '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json'], '.');
      expect(pull.code).toBe(0);
      const pullEnvelope = parseEnvelope(pull);
      expect(pullEnvelope.data).toMatchObject({ executed: true, inputPath: `inputs/portal/${material.id}-${material.sha256.slice(0, 8)}.png` });
      const inputPath = stringField(pullEnvelope.data, 'inputPath');
      const provenancePath = stringField(pullEnvelope.data, 'provenancePath');
      const assetJson = JSON.parse(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')) as { inputs: string[] };
      expect(assetJson.inputs).toContain(inputPath);
      expect(assetJson.inputs).toContain(provenancePath);

      // Declare + seal an output, then push through the CLI.
      await Bun.write(join(ws.assetDir, 'outputs', 'cover.png'), PNG_BYTES);
      const assetWithOutput = { ...assetJson, outputs: [{ name: 'cover', path: 'outputs/cover.png', mediaType: 'image/png', role: 'deliverable', visibility: 'public' }] };
      await Bun.write(join(ws.assetDir, 'asset.json'), `${JSON.stringify(assetWithOutput, null, 2)}\n`);
      const { revision } = await snapshotAsset(createStudioContext(ws.workspaceDir), { projectId: ws.projectId, assetId: ws.assetId, note: 'r1' });

      const push = await run(['portal-delivery-push', '--workspace', ws.workspaceDir, '--client', portalClientId, '--project', ws.projectId, '--asset', ws.assetId, '--revision', revision.revisionId, '--outputs', 'cover', '--origin', fake.origin, '--execute', '--json'], '.');
      expect(push.code).toBe(0);
      const pushEnvelope = parseEnvelope(push);
      expect(pushEnvelope.data).toMatchObject({ executed: true, rootHash: revision.rootHash, delivery: { status: 'ready' } });

      // asset-list through the CLI reflects the delivered asset.
      const assets = await run(['portal-asset-list', '--client', portalClientId, '--origin', fake.origin, '--json'], '.');
      expect(assets.code).toBe(0);
      const items = parseEnvelope(assets).data!.items as Array<{ id: string }>;
      expect(items.length).toBe(1);
    });
  });

  test('portal-access-link --execute mints a single-use URL through the fake portal', async () => {
    await withApiKey(fake.apiKey, async () => {
      const client = fake.seedClient({ workspaceId: 'ws-access', studioClientId: 'sc-access', name: 'Access Client' });
      const mint = await run(['portal-access-link', '--client', client.id, '--email', 'socia@ejemplo.com', '--expires-in', '48h', '--origin', fake.origin, '--execute', '--json'], '.');
      expect(mint.code).toBe(0);
      const envelope = parseEnvelope(mint);
      expect(envelope.ok).toBe(true);
      const url = stringField(envelope.data!, 'url');
      expect(url.startsWith(`${fake.origin}/api/auth/magic-link/verify?token=`)).toBe(true);
      expect(stringField(envelope.data!, 'email')).toBe('socia@ejemplo.com');
      expect(envelope.data!.singleUse).toBe(true);
      expect(typeof envelope.data!.expiresAt).toBe('number');
      expect(envelope.data!.expiresAt as number).toBeGreaterThan(Date.now() + 47 * 3_600_000);
      // The minted URL is the operator's deliverable; the key never appears.
      expect(mint.lines.join('\n')).not.toContain(fake.apiKey);
      expect(fake.requests.some((r) => r.path === `/api/v1/clients/${client.id}/access-links`)).toBe(true);
    });
  });

  test('portal-access-link without the access:write scope: FORBIDDEN, exit 1', async () => {
    const denied = await startFakePortal({ authMode: 'forbidden' });
    try {
      const result = await withApiKey(denied.apiKey, () => run(['portal-access-link', '--client', 'pc-1', '--email', 'cliente@ejemplo.com', '--origin', denied.origin, '--execute', '--json'], '.'));
      expect(result.code).toBe(1);
      expect(parseEnvelope(result).error?.code).toBe('FORBIDDEN');
    } finally {
      await denied.stop();
    }
  });

  test('runCli (full registry) routes portal verbs too', async () => {
    const lines: string[] = [];
    const code = await withApiKey(fake.apiKey, () => runCli(['portal-auth-status', '--origin', fake.origin, '--json'], { cwd: '.', out: (line) => void lines.push(line) }));
    expect(code).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ ok: true });
  });
});


// ---------------------------------------------------------------------------
// R-3 (customer-assets-requests): portal-request-* execution matrix against
// the fake portal's request family (dual CAS simplified; guest-direct routes
// require NO api key — the token in the path is the capability).
// ---------------------------------------------------------------------------

const VARIANT_PNG_BYTES = (() => {
  const bytes = new Uint8Array(PNG_BYTES);
  bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x5a;
  return bytes;
})();

function shaOf(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

async function guestUploadThroughFake(fake: FakePortal, token: string, bytes: Uint8Array, name: string): Promise<number> {
  const init = await fetch(`${fake.origin}/api/v1/r/${token}/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mediaType: 'image/png', declaredBytes: bytes.length, name }),
  });
  if (init.status !== 201) return init.status;
  const session = (await init.json()) as { uploadId: string };
  await fetch(`${fake.origin}/api/v1/r/${token}/uploads/${session.uploadId}/content`, {
    method: 'PUT',
    headers: { 'content-type': 'image/png' },
    body: new Uint8Array(bytes),
  });
  const complete = await fetch(`${fake.origin}/api/v1/r/${token}/uploads/${session.uploadId}/complete`, { method: 'POST' });
  return complete.status;
}

/** Narrows a nested object field (list items carry {request, …}). */
function stringFieldRecord(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    throw new Error(`se esperaba el objeto "${key}"`);
  }
  return (value as Record<string, unknown>)[key];
}

describe('portal-request-* execution matrix (R-3, fake portal)', () => {
  let fake: FakePortal;
  let ws: WorkspaceFixture;
  let clientId: string;
  let projectId: string;
  let requestId: string;
  let token: string;

  beforeAll(async () => {
    fake = await startFakePortal();
    ws = await makeWorkspaceTracked();
    const client = fake.seedClient({ workspaceId: 'ws-r3-specs', studioClientId: ws.studioClientId, name: 'Acme Inc.' });
    clientId = client.id;
    projectId = fake.seedProject({ clientId, studioProjectId: ws.projectId, name: 'Proyecto acme' }).id;
  });

  afterAll(async () => {
    await fake.stop();
  });

  test('portal-request-create --execute returns {requestId, url, expiresAt, limits} ONCE', async () => {
    const result = await withApiKey(fake.apiKey, () => run([
      'portal-request-create', '--client', clientId, '--project', projectId,
      '--title', 'Fotos del evento', '--instructions', 'JPG o PNG',
      '--max-files', '2', '--max-bytes', '4MiB', '--expires-in', '30d',
      '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result);
    requestId = stringField(envelope.data!, 'requestId');
    const url = stringField(envelope.data!, 'url');
    expect(url.startsWith(`${fake.origin}/request/`)).toBe(true);
    expect(envelope.data!.limits).toMatchObject({ maxFiles: 2, maxBytes: 4 * 1_048_576 });
    expect(envelope.data!.expiresAt as number).toBeGreaterThan(Date.now() + 29 * 24 * 3_600_000);
    // Two remote calls happened: create + first mint (0 emails).
    expect(fake.requests.some((entry) => entry.method === 'POST' && /\/api\/v1\/projects\/[^/]+\/requests$/.test(entry.path))).toBe(true);
    expect(fake.requests.some((entry) => entry.method === 'POST' && /\/api\/v1\/requests\/[^/]+\/link$/.test(entry.path))).toBe(true);
    // The key never leaks even though the URL is in the response.
    expect(result.lines.join('\n')).not.toContain(fake.apiKey);
    token = url.split('/request/')[1] ?? '';
  });

  test('portal-request-create with an unknown pointer: NOT_FOUND, exit 2; mismatched --client: INVALID_INPUT', async () => {
    const unknown = await withApiKey(fake.apiKey, () => run([
      'portal-request-create', '--client', clientId, '--project', 'pp-missing',
      '--title', 'T', '--max-files', '2', '--max-bytes', '4MiB',
      '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(unknown.code).toBe(2);
    expect(parseEnvelope(unknown).error?.code).toBe('NOT_FOUND');

    const mismatch = await withApiKey(fake.apiKey, () => run([
      'portal-request-create', '--client', 'pc-otro', '--project', projectId,
      '--title', 'T', '--max-files', '2', '--max-bytes', '4MiB',
      '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(mismatch.code).toBe(2);
    expect(parseEnvelope(mismatch).error?.code).toBe('INVALID_INPUT');
  });

  test('portal-request-create with a requests:write-less grant: FORBIDDEN, exit 1', async () => {
    const denied = await startFakePortal({ scopes: ['clients:read', 'materials:read'] });
    try {
      const deniedClient = denied.seedClient({ workspaceId: 'ws-denied', studioClientId: 'sc-denied', name: 'Denied' });
      denied.seedProject({ clientId: deniedClient.id, studioProjectId: 'proj', name: 'Proyecto' });
      const result = await withApiKey(denied.apiKey, () => run([
        'portal-request-create', '--client', deniedClient.id, '--project', 'proj',
        '--title', 'T', '--max-files', '2', '--max-bytes', '4MiB',
        '--origin', denied.origin, '--execute', '--json',
      ], '.'));
      expect(result.code).toBe(1);
      expect(parseEnvelope(result).error?.code).toBe('FORBIDDEN');
    } finally {
      await denied.stop();
    }
  });

  test('portal-request-link --execute rotates: old guest token 404, new 200', async () => {
    const mint = await withApiKey(fake.apiKey, () => run(['portal-request-link', requestId, '--expires-in', '48h', '--origin', fake.origin, '--execute', '--json'], '.'));
    expect(mint.code).toBe(0);
    const newUrl = stringField(parseEnvelope(mint).data!, 'url');
    const newToken = newUrl.split('/request/')[1] ?? '';
    expect((await fetch(`${fake.origin}/api/v1/r/${token}`)).status).toBe(404);
    expect((await fetch(`${fake.origin}/api/v1/r/${newToken}`)).status).toBe(200);
    token = newToken;
  });

  test('portal-request-pull imports ALL ready materials with request provenance; retry is idempotent', async () => {
    expect(await guestUploadThroughFake(fake, token, PNG_BYTES, 'uno.png')).toBe(201);
    expect(await guestUploadThroughFake(fake, token, VARIANT_PNG_BYTES, 'dos.png')).toBe(201);

    const pull = await withApiKey(fake.apiKey, () => run([
      'portal-request-pull', requestId, '--project', ws.projectId, '--asset', ws.assetId,
      '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(pull.code).toBe(0);
    const envelope = parseEnvelope(pull);
    expect(envelope.data!.portalProject).toMatchObject({ studioProjectId: ws.projectId });
    const imported = envelope.data!.imported as Array<Record<string, unknown>>;
    expect(imported.length).toBe(2);
    const shas = [shaOf(PNG_BYTES), shaOf(VARIANT_PNG_BYTES)];
    for (const material of imported) {
      expect(shas).toContain(stringField(material, 'sha256'));
      const provenance = JSON.parse(await readFile(join(ws.assetDir, stringField(material, 'provenancePath')), 'utf8')) as Record<string, unknown>;
      expect(provenance.requestId).toBe(requestId);
    }
    const assetDoc = JSON.parse(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')) as { inputs: string[] };
    expect(assetDoc.inputs.length).toBe(4);

    const retry = await withApiKey(fake.apiKey, () => run([
      'portal-request-pull', requestId, '--project', ws.projectId, '--asset', ws.assetId,
      '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(retry.code).toBe(0);
    const retryEnvelope = parseEnvelope(retry);
    expect(retryEnvelope.data!.addedInputs).toEqual([]);
    const retryImported = retryEnvelope.data!.imported as Array<Record<string, unknown>>;
    for (const material of retryImported) expect(material.reusedBytes).toBe(true);
    const assetAfter = JSON.parse(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')) as { inputs: string[] };
    expect(assetAfter.inputs.length).toBe(4);
  });

  test('portal-request-pull negatives: empty request and unknown request (exit 2, no writes)', async () => {
    const created = await withApiKey(fake.apiKey, () => run([
      'portal-request-create', '--client', clientId, '--project', projectId,
      '--title', 'Vacío', '--max-files', '1', '--max-bytes', '1MiB',
      '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    const emptyId = stringField(parseEnvelope(created).data!, 'requestId');
    const emptyPull = await withApiKey(fake.apiKey, () => run([
      'portal-request-pull', emptyId, '--project', ws.projectId, '--asset', ws.assetId,
      '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(emptyPull.code).toBe(2);
    expect(parseEnvelope(emptyPull).error?.code).toBe('INVALID_INPUT');

    const unknownPull = await withApiKey(fake.apiKey, () => run([
      'portal-request-pull', 'req-missing', '--project', ws.projectId, '--asset', ws.assetId,
      '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(unknownPull.code).toBe(2);
    expect(parseEnvelope(unknownPull).error?.code).toBe('NOT_FOUND');
  });

  test('portal-request-list filters by state; client-wide listing is a usage error for agent keys', async () => {
    const list = await withApiKey(fake.apiKey, () => run(['portal-request-list', '--client', clientId, '--project', projectId, '--origin', fake.origin, '--json'], '.'));
    expect(list.code).toBe(0);
    const items = parseEnvelope(list).data!.items as Array<Record<string, unknown>>;
    // main + 'Vacío' + the stray request left by the post-hoc --client
    // mismatch guard above (created server-side before the guard fires).
    expect(items.length).toBe(3);
    expect(items.every((item) => stringField(item, 'portalProjectId') === projectId)).toBe(true);
    const fulfilled = await withApiKey(fake.apiKey, () => run(['portal-request-list', '--client', clientId, '--project', projectId, '--state', 'fulfilled', '--origin', fake.origin, '--json'], '.'));
    const fulfilledItems = parseEnvelope(fulfilled).data!.items as Array<Record<string, unknown>>;
    expect(fulfilledItems.length).toBe(1);
    expect(stringField(stringFieldRecord(fulfilledItems[0]!, 'request'), 'id')).toBe(requestId);

    // Agents cannot enumerate a client's pointers (contracts.md §3): the CLI
    // demands the pointer id instead of promising a client-wide sweep.
    const noProject = await withApiKey(fake.apiKey, () => run(['portal-request-list', '--client', clientId, '--origin', fake.origin, '--json'], '.'));
    expect(noProject.code).toBe(2);
    expect(parseEnvelope(noProject).error?.code).toBe('INVALID_INPUT');
  });

  test('portal-request-close --execute closes; re-close CONFLICT; unknown NOT_FOUND', async () => {
    const close = await withApiKey(fake.apiKey, () => run(['portal-request-close', requestId, '--reason', 'Cierre de prueba', '--origin', fake.origin, '--execute', '--json'], '.'));
    expect(close.code).toBe(0);
    const requestView = parseEnvelope(close).data!.request as Record<string, unknown>;
    expect(stringField(requestView, 'state')).toBe('closed');

    const again = await withApiKey(fake.apiKey, () => run(['portal-request-close', requestId, '--origin', fake.origin, '--execute', '--json'], '.'));
    expect(again.code).toBe(1);
    expect(parseEnvelope(again).error?.code).toBe('CONFLICT');

    // Guest uploads on a closed request are refused (409 envelope, no pull).
    expect(await guestUploadThroughFake(fake, token, PNG_BYTES, 'tarde.png')).toBe(409);

    const unknown = await withApiKey(fake.apiKey, () => run(['portal-request-close', 'req-missing', '--origin', fake.origin, '--execute', '--json'], '.'));
    expect(unknown.code).toBe(2);
    expect(parseEnvelope(unknown).error?.code).toBe('NOT_FOUND');
  });
});

describe('legacy compatibility guards', () => {
  test('portal verbs never collide with studio grouped normalization', () => {
    for (const spec of portalSpecs) {
      expect(spec.verb.startsWith('portal-')).toBe(true);
      expect(spec.supportsPlan).toBe(true);
    }
  });

  test('workspace temp confinement lives inside .vm (excluded from seals)', async () => {
    const ws = await makeWorkspaceTracked();
    // The fixture + a pull leave no residue outside .vm/tmp (proved by the
    // bridge suite); here we assert the .vm dir is the only hidden state.
    await mkdir(join(ws.workspaceDir, '.vm', 'tmp'), { recursive: true });
    const entries = await readdir(ws.workspaceDir);
    expect(entries.filter((entry) => entry.startsWith('.'))).toEqual(['.vm']);
  });
});

// ---------------------------------------------------------------------------
// portal-asset-* execution matrix (operator order 2026-10-06, fake portal):
// mint → guest upload (no credential) → pull with SHA equality; rotation,
// used-link refusal and idempotent re-pull through the CLI envelopes.
// ---------------------------------------------------------------------------

describe('portal-asset-* execution matrix (asset upload links)', () => {
  let fake: FakePortal;
  let ws: WorkspaceFixture;
  let clientId: string;
  let mintedUrl: string;
  let token: string;

  beforeAll(async () => {
    fake = await startFakePortal();
    ws = await makeWorkspaceTracked();
    const client = fake.seedClient({ workspaceId: 'ws-asset-specs', studioClientId: ws.studioClientId, name: 'Acme Inc.' });
    clientId = client.id;
    fake.seedProject({ clientId, studioProjectId: ws.projectId, name: 'Proyecto acme' });
  });

  afterAll(async () => {
    await fake.stop();
  });

  test('portal-asset-upload-link --execute prints the URL exactly once (envelope + delivery line)', async () => {
    const result = await withApiKey(fake.apiKey, () => run([
      'portal-asset-upload-link', '--project', ws.projectId, '--asset', ws.assetId,
      '--client', clientId, '--expires-in', '24h',
      '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result);
    expect(envelope.ok).toBe(true);
    expect(envelope.data?.executed).toBe(true);
    mintedUrl = stringField(envelope.data, 'url');
    expect(mintedUrl.startsWith(`${fake.origin}/asset-upload/`)).toBe(true);
    expect(stringField(envelope.data, 'studioAssetId')).toBe(ws.assetId);
    token = mintedUrl.split('/asset-upload/')[1] ?? '';
    expect(fake.requests.some((entry) => entry.method === 'POST' && entry.path === '/api/v1/asset-upload-links')).toBe(true);
  });

  test('guest uploads through the minted link with NO credential (single-use)', async () => {
    const init = await fetch(`${fake.origin}/api/v1/a/${token}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaType: 'image/png', declaredBytes: PNG_BYTES.length, name: 'toma-cli.png' }),
    });
    expect(init.status).toBe(201);
    const session = (await init.json()) as { uploadId: string };
    const put = await fetch(`${fake.origin}/api/v1/a/${token}/uploads/${session.uploadId}/content`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: new Uint8Array(PNG_BYTES),
    });
    expect(put.status).toBe(200);
    const complete = await fetch(`${fake.origin}/api/v1/a/${token}/uploads/${session.uploadId}/complete`, { method: 'POST' });
    expect(complete.status).toBe(201);
    // The token is NOT an API key: the fake answers 401 outside the family.
    const asKey = await fetch(`${fake.origin}/api/v1/me`, { headers: { 'x-api-key': token } });
    expect(asKey.status).toBe(401);
  });

  test('portal-asset-pull --execute imports with upload==import SHA and linkId provenance', async () => {
    const result = await withApiKey(fake.apiKey, () => run([
      'portal-asset-pull', '--project', ws.projectId, '--asset', ws.assetId,
      '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(result.code).toBe(0);
    const envelope = parseEnvelope(result);
    expect(envelope.data?.executed).toBe(true);
    const imported = envelope.data?.imported as Array<Record<string, unknown>>;
    expect(imported.length).toBe(1);
    expect(typeof imported[0]!.linkId).toBe('string');
    const provenance = JSON.parse(await readFile(join(ws.assetDir, String(imported[0]!.provenancePath)), 'utf8')) as Record<string, unknown>;
    expect(provenance.linkId).toBe(imported[0]!.linkId);
    expect(provenance.sha256).toBe(imported[0]!.sha256);
    expect(JSON.stringify(provenance)).not.toContain(fake.apiKey);
  });

  test('portal-asset-pull re-run is idempotent: zero added inputs, reused bytes', async () => {
    const result = await withApiKey(fake.apiKey, () => run([
      'portal-asset-pull', '--project', ws.projectId, '--asset', ws.assetId,
      '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(result.code).toBe(0);
    const imported = parseEnvelope(result).data?.imported as Array<Record<string, unknown>>;
    expect(imported[0]!.reusedBytes).toBe(true);
    expect((parseEnvelope(result).data?.addedInputs as unknown[]).length).toBe(0);
  });

  test('used link refuses more uploads; a second mint rotates and the new token works', async () => {
    const refused = await fetch(`${fake.origin}/api/v1/a/${token}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaType: 'image/png', declaredBytes: 10 }),
    });
    expect(refused.status).toBe(409);
    const rotated = await withApiKey(fake.apiKey, () => run([
      'portal-asset-upload-link', '--project', ws.projectId, '--asset', ws.assetId,
      '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(rotated.code).toBe(0);
    // The SPENT link stays view-only (used state, uploads always refused);
    // only OPEN priors get closed by rotation.
    expect((await fetch(`${fake.origin}/api/v1/a/${token}`, { method: 'GET' })).status).toBe(200);
    const oldUpload = await fetch(`${fake.origin}/api/v1/a/${token}/uploads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mediaType: 'image/png', declaredBytes: 10 }),
    });
    expect(oldUpload.status).toBe(409);
    token = (stringField(parseEnvelope(rotated).data, 'url').split('/asset-upload/')[1] ?? '');
    expect((await fetch(`${fake.origin}/api/v1/a/${token}`, { method: 'GET' })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// portal tailnet ingest matrix (§10 · customer-assets-requests): --tailnet
// mint, the local serve planning surface, and the LOCAL ingest-pull against
// a REAL (bun-local, 127.0.0.1:0) ingest server fed by the fake portal.
// ---------------------------------------------------------------------------

describe('portal tailnet ingest matrix (§10)', () => {
  let fake: FakePortal;
  let ws: WorkspaceFixture;
  let clientId: string;
  let ingest: IngestServer;
  const TAILNET_IP = '10.66.0.42';

  function sha256HexOf(bytes: Uint8Array): string {
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(bytes);
    return hasher.digest('hex');
  }

  /** Minimal MP4-shaped payload (`ftyp` at offset 4) with a per-test fill. */
  function makeMp4Bytes(size: number, fill: number): Uint8Array {
    const bytes = new Uint8Array(size);
    bytes[4] = 0x66;
    bytes[5] = 0x74;
    bytes[6] = 0x79;
    bytes[7] = 0x70;
    for (let index = 8; index < size; index += 1) bytes[index] = (fill + index) % 251;
    return bytes;
  }

  beforeAll(async () => {
    fake = await startFakePortal();
    ws = await makeWorkspaceTracked();
    const client = fake.seedClient({ workspaceId: 'ws-tailnet-specs', studioClientId: ws.studioClientId, name: 'Acme Inc.' });
    clientId = client.id;
    fake.seedProject({ clientId, studioProjectId: ws.projectId, name: 'Proyecto acme' });
    ingest = await createIngestServer({ portalOrigin: fake.origin, ingestDir: join(ws.root, 'landing'), bindHost: '127.0.0.1', port: 0 });
    // Hermetic tailnet resolution: the SERVE command would use `tailscale ip -4`.
    setTailscaleIpv4ResolverForTests(async () => TAILNET_IP);
  });

  afterAll(async () => {
    setTailscaleIpv4ResolverForTests(null);
    await ingest.stop();
    await fake.stop();
  });

  test('portal-asset-upload-link --tailnet adds tailnetUrl for the SAME token (probe listening, https url intact)', async () => {
    // The probe must reach the bind host: resolve the loopback the TEST
    // server actually listens on (the real serve uses the tailscale IPv4).
    setTailscaleIpv4ResolverForTests(async () => '127.0.0.1');
    try {
    const result = await withApiKey(fake.apiKey, () => run([
      'portal-asset-upload-link', '--project', ws.projectId, '--asset', ws.assetId,
      '--tailnet', '--ingest-port', String(ingest.port),
      '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(result.code).toBe(0);
    const data = parseEnvelope(result).data!;
    const url = stringField(data, 'url');
    const token = url.split('/asset-upload/')[1] ?? '';
    expect(stringField(data, 'tailnetUrl')).toBe(`http://127.0.0.1:${ingest.port}/subir/${token}`);
    expect(stringField(data, 'tailnetProbe')).toBe('listening');
    expect(stringField(data, 'url')).toBe(url);
    // The tailnet URL is NOT persisted anywhere: it lives in this envelope.
    expect(fake.requests.every((entry) => (entry.bodyText ?? '').includes(TAILNET_IP) === false)).toBe(true);
    } finally {
      setTailscaleIpv4ResolverForTests(async () => TAILNET_IP);
    }
  });

  test('a non-listening ingest port only WARNS: the mint still succeeds (exit 0)', async () => {
    const result = await withApiKey(fake.apiKey, () => run([
      'portal-asset-upload-link', '--project', ws.projectId, '--asset', ws.assetId,
      '--tailnet', '--ingest-port', '1',
      '--workspace', ws.workspaceDir, '--origin', fake.origin, '--execute', '--json',
    ], '.'));
    expect(result.code).toBe(0);
    const data = parseEnvelope(result).data!;
    expect(stringField(data, 'tailnetProbe')).toBe('not-listening');
    expect(stringField(data, 'tailnetUrl')).toContain(`http://${TAILNET_IP}:1/subir/`);
  });

  test('portal-asset-ingest-pull --execute imports a REAL landed take (no --origin, no credential)', async () => {
    const minted = fake.seedAssetLink({ clientId, studioProjectId: ws.projectId, studioAssetId: ws.assetId, expiresIn: '24h' });
    const bytes = makeMp4Bytes(96, 21);
    const view = await fetch(`${ingest.origin}/subir/${minted.token}`);
    expect(view.status).toBe(200);
    const put = await fetch(`${ingest.origin}/subir/${minted.token}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes.slice(),
    });
    expect(put.status).toBe(200);
    const done = await fetch(`${ingest.origin}/subir/${minted.token}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bytes: bytes.length }),
    });
    expect(done.status).toBe(201);

    // Deliberately WITHOUT withApiKey: the ingest pull is local by design.
    delete process.env.CUSTOMER_ASSETS_API_KEY;
    const result = await run([
      'portal-asset-ingest-pull', '--project', ws.projectId, '--asset', ws.assetId,
      '--workspace', ws.workspaceDir, '--ingest-dir', ingest.ingestDir, '--execute', '--json',
    ], '.');
    expect(result.code).toBe(0);
    const data = parseEnvelope(result).data!;
    const imported = data.imported as Array<Record<string, unknown>>;
    expect(imported.length).toBe(1);
    expect(imported[0]!.sha256).toBe(sha256HexOf(bytes));
    expect(imported[0]!.removedFromLanding).toBe(true);
    const provenance = JSON.parse(await readFile(join(ws.assetDir, String(imported[0]!.provenancePath)), 'utf8')) as Record<string, unknown>;
    expect(provenance.tailnet).toBe(true);
    expect(provenance.source).toBe('tailnet-ingest');
    // Landing drained after the verified import.
    const drained = await stat(join(ingest.ingestDir, String(imported[0]!.tokenHash))).then(() => true, () => false);
    expect(drained).toBe(false);
  });

  test('portal-asset-ingest-pull re-run: empty landing is an idempotent success with zero duplicates', async () => {
    const before = JSON.parse(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')) as { inputs: string[] };
    const result = await run([
      'portal-asset-ingest-pull', '--project', ws.projectId, '--asset', ws.assetId,
      '--workspace', ws.workspaceDir, '--ingest-dir', ingest.ingestDir, '--execute', '--json',
    ], '.');
    expect(result.code).toBe(0);
    const data = parseEnvelope(result).data!;
    expect(data.imported as unknown[]).toEqual([]);
    const after = JSON.parse(await readFile(join(ws.assetDir, 'asset.json'), 'utf8')) as { inputs: string[] };
    expect(after.inputs).toEqual(before.inputs);
  });

  test('a take whose bytes drift from the manifest is refused BEFORE import and KEPT in the landing', async () => {
    const minted = fake.seedAssetLink({ clientId, studioProjectId: ws.projectId, studioAssetId: ws.assetId, expiresIn: '24h' });
    const bytes = makeMp4Bytes(64, 5);
    await fetch(`${ingest.origin}/subir/${minted.token}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: bytes.slice(),
    });
    const done = await fetch(`${ingest.origin}/subir/${minted.token}/complete`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bytes: bytes.length }),
    });
    expect(done.status).toBe(201);
    const tokenHash = sha256HexOf(new TextEncoder().encode(minted.token));
    const takeId = `take-${sha256HexOf(bytes).slice(0, 8)}`;
    const takePath = join(ingest.ingestDir, tokenHash, `${takeId}.mp4`);
    // Corrupt the LANDED bytes (drift probe, like swapMaterialBytes).
    const drifted = new Uint8Array(bytes);
    drifted[drifted.length - 1] = drifted[drifted.length - 1]! ^ 0x5a;
    await writeFile(takePath, drifted);

    const result = await run([
      'portal-asset-ingest-pull', '--project', ws.projectId, '--asset', ws.assetId,
      '--workspace', ws.workspaceDir, '--ingest-dir', ingest.ingestDir, '--execute', '--json',
    ], '.');
    // HASH_MISMATCH is operational (exit 1): the landing entry stays for a
    // re-import; nothing was written near the asset.
    expect(result.code).toBe(1);
    const envelope = parseEnvelope(result);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('HASH_MISMATCH');
    // The take stays in the landing for a re-import of good bytes.
    expect(await stat(takePath).then(() => true, () => false)).toBe(true);
  });
});
