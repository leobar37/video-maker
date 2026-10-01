/**
 * CLI sync specs (P-004 correction round): envelope discipline and lazy
 * storage through the REAL runtime. Everything runs against a temp workspace
 * with the storage loader seam injected — zero credentials, zero network.
 *
 * - Success: `sync push|verify|recover --json` print exactly ONE ok:true
 *   envelope and exit 0.
 * - Failures print exactly ONE ok:false error envelope and exit 1 (partial
 *   receipts/failures ride along as safe evidence); usage failures (invalid
 *   selector) print the envelope and exit 2 BEFORE any storage resolution.
 * - Plan purity: every sync command under --plan/--dry-run resolves the
 *   storage loader ZERO times and leaves the workspace tree untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createClient,
  createCreativeAsset,
  createCreativeProject,
  createStudioContext,
  snapshotAsset,
  storageManifestKey,
  type StudioStorage,
} from '@videomaker/studio';

import { runCli } from '../runtime';
import { setStudioSyncStorageLoaderForTests } from './studio-sync';

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const COVER = new Uint8Array([...PNG_SIGNATURE, 4, 4]);

function shaOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** In-memory storage port (no network, fault injection by key). */
class FakeCliStorage implements StudioStorage {
  objects = new Map<string, { bytes: Uint8Array; mediaType: string; shaAtPut: string }>();
  failPutKeys = new Set<string>();

  async head(key: string) {
    const entry = this.objects.get(key);
    return entry === undefined ? null : { key, bytes: entry.bytes.byteLength, sha256: entry.shaAtPut };
  }

  async get(key: string): Promise<Uint8Array> {
    const entry = this.objects.get(key);
    if (entry === undefined) throw new Error(`missing object ${key}`);
    return entry.bytes;
  }

  async putImmutable(key: string, bytes: Uint8Array, mediaType: string) {
    if (this.failPutKeys.has(key)) throw new Error(`injected failure for ${key}`);
    const shaAtPut = shaOf(bytes);
    this.objects.set(key, { bytes, mediaType, shaAtPut });
    return { key, bytes: bytes.byteLength, sha256: shaAtPut };
  }

  async list(prefix: string) {
    return { keys: [...this.objects.keys()].filter((key) => key.startsWith(prefix)).sort() };
  }
}

interface RunResult {
  code: number;
  lines: string[];
}

interface Envelope {
  schemaVersion: number;
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

function envelopeOf(result: RunResult): Envelope {
  expect(result.lines).toHaveLength(1);
  return JSON.parse(result.lines[0]!) as Envelope;
}

async function runCliCaptured(argv: string[], cwd: string): Promise<RunResult> {
  const lines: string[] = [];
  const code = await runCli(argv, { cwd, out: (line: string) => void lines.push(line) });
  return { code, lines: lines.filter((line) => line.trim().length > 0) };
}

async function treeSnapshot(root: string): Promise<Map<string, number>> {
  const entries = new Map<string, number>();
  const walk = async (dir: string): Promise<void> => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const abs = join(dir, item.name);
      if (item.isDirectory()) await walk(abs);
      else {
        const info = await stat(abs);
        entries.set(abs, info.size + info.mtimeMs);
      }
    }
  };
  const info = await stat(root).catch(() => null);
  if (info?.isDirectory()) await walk(root);
  return entries;
}

describe('CLI sync specs: envelopes, lazy storage y plan purity', () => {
  let cwd = '';
  let workspace = '';
  let revisionId = '';
  let manifestKey = '';
  let storage = new FakeCliStorage();
  let loaderCalls = 0;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'vm-cli-sync-'));
    tempDirs.push(cwd);
    workspace = join(cwd, 'ws');
    const ctx = createStudioContext(workspace);
    await createClient(ctx, { id: 'marca-a', name: 'Marca A' });
    await createCreativeProject(ctx, { id: 'campana', name: 'Campaña', clientIds: ['marca-a'] });
    await createCreativeAsset(ctx, { id: 'cover-feed', projectId: 'campana', kind: 'image', title: 'Cover' });
    const assetDir = join(workspace, 'projects', 'campana', 'assets', 'cover-feed');
    await mkdir(join(assetDir, 'outputs'), { recursive: true });
    await writeFile(join(assetDir, 'outputs', 'cover.png'), COVER);
    const assetJson = JSON.parse(await readFile(join(assetDir, 'asset.json'), 'utf8')) as Record<string, unknown>;
    assetJson.outputs = [{ name: 'cover-feed', path: 'outputs/cover.png', mediaType: 'image/png', role: 'deliverable' }];
    await writeFile(join(assetDir, 'asset.json'), `${JSON.stringify(assetJson, null, 2)}\n`);
    const { revision } = await snapshotAsset(ctx, { projectId: 'campana', assetId: 'cover-feed', note: 'r1' });
    revisionId = revision.revisionId;
    manifestKey = storageManifestKey('campana', 'cover-feed', revisionId);

    setStudioSyncStorageLoaderForTests(async () => {
      loaderCalls += 1;
      return storage;
    });
  });

  afterAll(async () => {
    setStudioSyncStorageLoaderForTests(undefined);
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  });

  test('sync push --json: UN envelope ok:true, receipt confirmed, exit 0', async () => {
    const result = await runCliCaptured(['sync', 'push', '--project', 'campana', '--workspace', workspace, '--json'], cwd);
    expect(result.code).toBe(0);
    const envelope = envelopeOf(result);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as { receipts: Array<{ status: string }>; failedCount: number };
    expect(data.failedCount).toBe(0);
    expect(data.receipts[0]?.status).toBe('confirmed');
  });

  test('sync verify --json: UN envelope ok:true, exit 0', async () => {
    const result = await runCliCaptured(['sync', 'verify', '--project', 'campana', '--workspace', workspace, '--json'], cwd);
    expect(result.code).toBe(0);
    const envelope = envelopeOf(result);
    expect(envelope.ok).toBe(true);
    const data = envelope.data as { verified: unknown[]; failures: unknown[] };
    expect(data.failures).toEqual([]);
    expect(data.verified).toHaveLength(1);
  });

  test('sync recover --json: UN envelope ok:true, proyecto reconstruido, exit 0', async () => {
    const out = await mkdtemp(join(tmpdir(), 'vm-cli-sync-out-'));
    tempDirs.push(out);
    const result = await runCliCaptured(['sync', 'recover', '--project', 'campana', '--out', out, '--workspace', workspace, '--json'], cwd);
    expect(result.code).toBe(0);
    const envelope = envelopeOf(result);
    expect(envelope.ok).toBe(true);
    const project = JSON.parse(await readFile(join(out, 'projects', 'campana', 'project.json'), 'utf8')) as { id: string };
    expect(project.id).toBe('campana');
  });

  test('push parcial fallido: UN envelope ok:false con receipts como evidencia, exit 1', async () => {
    const failing = new FakeCliStorage();
    failing.failPutKeys.add(manifestKey);
    const previous = storage;
    storage = failing;
    try {
      const result = await runCliCaptured(['sync', 'push', '--project', 'campana', '--workspace', workspace, '--json'], cwd);
      expect(result.code).toBe(1);
      const envelope = envelopeOf(result);
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('STORAGE_UNAVAILABLE');
      const details = envelope.error?.details as { receipts: Array<{ status: string }> } | undefined;
      expect(details?.receipts?.some((receipt) => receipt.status === 'failed')).toBe(true);
    } finally {
      storage = previous;
    }
  });

  test('verify con namespace remoto faltante: UN envelope ok:false NOT_FOUND, exit 1', async () => {
    const previous = storage;
    storage = new FakeCliStorage(); // nothing uploaded: the remote namespace is empty
    try {
      const result = await runCliCaptured(['sync', 'verify', '--project', 'campana', '--workspace', workspace, '--json'], cwd);
      expect(result.code).toBe(1);
      const envelope = envelopeOf(result);
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('NOT_FOUND');
    } finally {
      storage = previous;
    }
  });

  test('fallo de arranque del storage: envelope ok:false STORAGE_UNAVAILABLE, exit 1', async () => {
    const boom = Object.assign(new Error('The private studio backup bucket is not configured.'), {
      name: 'StudioPrivateBucketMissingError',
    });
    setStudioSyncStorageLoaderForTests(async () => {
      throw boom;
    });
    try {
      const result = await runCliCaptured(['sync', 'push', '--project', 'campana', '--workspace', workspace, '--json'], cwd);
      expect(result.code).toBe(1);
      const envelope = envelopeOf(result);
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('STORAGE_UNAVAILABLE');
    } finally {
      setStudioSyncStorageLoaderForTests(async () => {
        loaderCalls += 1;
        return storage;
      });
    }
  });

  test('selector inválido falla ANTES del storage en run y en plan (exit 2, INVALID_INPUT, loader 0)', async () => {
    const before = loaderCalls;
    for (const extra of [['--json'], ['--json', '--plan']]) {
      const result = await runCliCaptured(
        [
          'sync',
          'recover',
          '--project',
          'campana',
          '--out',
          join(cwd, 'dest'),
          '--workspace',
          workspace,
          '--checkpoint',
          'cp-1',
          '--revisions',
          `cover-feed@${revisionId}`,
          ...extra,
        ],
        cwd,
      );
      expect(result.code).toBe(2);
      const envelope = envelopeOf(result);
      expect(envelope.ok).toBe(false);
      expect(envelope.error?.code).toBe('INVALID_INPUT');
    }
    expect(loaderCalls).toBe(before);
  });

  test('todo sync --plan/--dry-run resuelve el storage CERO veces y no toca el árbol', async () => {
    const treeBefore = await treeSnapshot(workspace);
    const before = loaderCalls;
    const commands: string[][] = [
      ['sync', 'push', '--project', 'campana', '--workspace', workspace, '--json'],
      ['sync', 'verify', '--project', 'campana', '--workspace', workspace, '--json'],
      ['sync', 'recover', '--project', 'campana', '--out', join(cwd, 'dest'), '--workspace', workspace, '--json'],
    ];
    for (const flag of ['--plan', '--dry-run']) {
      for (const base of commands) {
        const result = await runCliCaptured([...base, flag], cwd);
        expect(result.code).toBe(0);
      }
    }
    expect(loaderCalls).toBe(before);
    expect(await treeSnapshot(workspace)).toEqual(treeBefore);
  });
});
