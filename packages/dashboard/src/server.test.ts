/**
 * Dashboard HTTP suites (P-005 acceptance): ephemeral local servers started
 * and stopped by the tests themselves — no Docker, no DB, no lasting
 * service, no real Tailscale (all network seams faked).
 *
 * Covered: contract endpoints + filters, XSS/metadata safety, CSP/nosniff,
 * sealed-file serving by DECLARED output name (never arbitrary paths),
 * traversal rejections, corruption/type-mismatch rejection, injected-storage
 * fallback, 405 for mutating verbs, and the `dashboard url` state/Tailscale
 * rules (stale rejection, no loopback fallback, trusted-tailnet required).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { RevisionManifestSchema, StudioCatalogSchema, computeRevisionRootHash, sha256Hex, type StudioCatalog } from '@videomaker/schemas';
import { StudioServiceError, storageObjectKeyForSha, type StudioStorage } from '@videomaker/studio';

import { HTML_TEXT, HOSTILE_TITLE, MP4_BYTES, PNG_BYTES, PNG_THUMB_BYTES, SVG_TEXT, makeDashboardFixture, startTestDashboard, type DashboardFixture, type TestServer } from './fixtures';
import { resolveSealedOutput, startDashboardServer } from './server';
import { isTailscaleIpv4, readDashboardServeState, resolveDashboardUrl, writeDashboardServeState, type ListenerProbeResult } from './tailscale';

/** Fake ss: a real all-interfaces LISTEN owned by the registered pid. */
const listenerOk = async (): Promise<ListenerProbeResult> => ({ listening: true, allInterfaces: true, pidMatches: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function envelopeOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function errorOf(payload: Record<string, unknown>): { code: string; message: string } {
  expect(payload.ok).toBe(false);
  const error = payload.error;
  expect(typeof error === 'object' && error !== null && 'code' in error).toBe(true);
  return { code: String((error as Record<string, unknown>)['code']), message: String((error as Record<string, unknown>)['message']) };
}

/** Validated boundary for catalog responses (frozen DTO, never redefined). */
function catalogOf(payload: Record<string, unknown>): StudioCatalog {
  expect(payload.ok).toBe(true);
  const parsed = StudioCatalogSchema.safeParse(payload.data);
  expect(parsed.success).toBe(true);
  return parsed.success ? parsed.data : (null as never);
}

interface FakeStorage extends StudioStorage {
  getKeys: string[];
}

function fakeStorage(objects: Map<string, Uint8Array>, mode: 'ok' | 'failing' = 'ok'): FakeStorage {
  const getKeys: string[] = [];
  return {
    getKeys,
    async head(key: string) {
      const bytes = objects.get(key);
      return bytes ? { key, bytes: bytes.length, sha256: await sha256Hex(bytes) } : null;
    },
    async putImmutable(key: string, bytes: Uint8Array) {
      objects.set(key, bytes);
      return { key, bytes: bytes.length, sha256: await sha256Hex(bytes) };
    },
    async get(key: string) {
      const bytes = objects.get(key);
      if (mode === 'failing') throw new StudioServiceError('STORAGE_UNAVAILABLE', 'get falló (fake redactado).');
      if (!bytes) throw new StudioServiceError('NOT_FOUND', 'objeto ausente en el storage fake.');
      getKeys.push(key);
      return bytes;
    },
    async list(prefix: string) {
      return { keys: [...objects.keys()].filter((key) => key.startsWith(prefix)) };
    },
  };
}

/** A pid that is definitely not running (scans a rare range). */
function findDeadPid(): number {
  for (let candidate = 4_100_000; candidate < 4_199_999; candidate += 1) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return candidate;
    }
  }
  throw new Error('no dead pid found');
}

// ---------------------------------------------------------------------------
// Shared read-only fixture (one ephemeral server for the whole group)
// ---------------------------------------------------------------------------

describe('dashboard HTTP read-only (fixture compartida)', () => {
  let fixture: DashboardFixture;
  let server: TestServer;

  beforeAll(async () => {
    fixture = await makeDashboardFixture('vm-dashboard-http');
    server = await startTestDashboard(fixture.root);
  });

  afterAll(async () => {
    await server?.stop();
    await fixture?.cleanup();
  });

  test('health: 200, JSON, nosniff, sin credenciales ni storage', async () => {
    const response = await fetch(`${server.baseUrl}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload = await envelopeOf(response);
    expect(payload.ok).toBe(true);
    expect((payload.data as Record<string, unknown>)['status']).toBe('ok');
  });

  test('UI shell: estática, CSP restrictiva, sin datos del catálogo embebidos', async () => {
    const response = await fetch(server.baseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const html = await response.text();
    expect(html).toContain('/app.js');
    expect(html).not.toContain('onerror'); // hostile metadata never embedded
    expect(html).not.toContain(HOSTILE_TITLE);
    expect(html).not.toMatch(/<script>[^<]/); // no inline script bodies
    const js = await (await fetch(`${server.baseUrl}/app.js`)).text();
    expect(js).toContain('textContent'); // DOM building escapes by construction
    expect(js).not.toMatch(/innerHTML\s*\(/); // never builds markup from strings
    const css = await fetch(`${server.baseUrl}/styles.css`);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  test('catálogo completo: imagen/svg/video, roles y servicePath por nombre declarado', async () => {
    const response = await fetch(`${server.baseUrl}/api/catalog`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const catalog = catalogOf(await envelopeOf(response));
    expect(catalog.entries).toHaveLength(4);

    const svg = catalog.entries.find((entry) => entry.assetId === fixture.svgAssetId)!;
    expect(svg.asset.title).toBe(HOSTILE_TITLE); // raw in JSON is safe (content-type + nosniff)
    expect(svg.outputs[0]!.servicePath).toBe(`files/${fixture.demoProjectId}/${fixture.svgAssetId}/${fixture.svgR1}/post.svg`);

    const video = catalog.entries.find((entry) => entry.assetId === fixture.videoAssetId)!;
    expect(video.editorialStatus).toBe('draft');
    expect(video.outputs.map((output) => output.role)).toContain('thumbnail');
  });

  test('filtros del contrato: client/project/asset/kind', async () => {
    const kindVideo = catalogOf(await envelopeOf(await fetch(`${server.baseUrl}/api/catalog?kind=video`)));
    expect(kindVideo.entries).toHaveLength(1);
    const kindSvg = catalogOf(await envelopeOf(await fetch(`${server.baseUrl}/api/catalog?kind=svg`)));
    expect(kindSvg.entries).toHaveLength(1);
    const byClient = catalogOf(await envelopeOf(await fetch(`${server.baseUrl}/api/catalog?client=${fixture.clientId}`)));
    expect(byClient.entries).toHaveLength(3);
    const clientAndKind = catalogOf(await envelopeOf(await fetch(`${server.baseUrl}/api/catalog?client=${fixture.clientId}&kind=image`)));
    expect(clientAndKind.entries).toHaveLength(2);
    const byProject = catalogOf(await envelopeOf(await fetch(`${server.baseUrl}/api/catalog?project=${fixture.soloProjectId}`)));
    expect(byProject.entries).toHaveLength(1);
    const byAsset = catalogOf(await envelopeOf(await fetch(`${server.baseUrl}/api/catalog?asset=${fixture.svgAssetId}`)));
    expect(byAsset.entries).toHaveLength(1);
  });

  test('filtros inválidos: envelope estable, sin fuga de paths', async () => {
    const traversal = await fetch(`${server.baseUrl}/api/catalog?project=..%2Fetc`);
    expect(traversal.status).toBe(400);
    expect(errorOf(await envelopeOf(traversal)).code).toBe('INVALID_INPUT');
    const badKind = await fetch(`${server.baseUrl}/api/catalog?kind=nope`);
    expect(badKind.status).toBe(400);
    expect(errorOf(await envelopeOf(badKind)).code).toBe('INVALID_INPUT');
  });

  test('inspección de asset: historial real, 404 con envelope para desconocidos', async () => {
    const response = await fetch(`${server.baseUrl}/api/assets/${fixture.demoProjectId}/${fixture.imageAssetId}`);
    expect(response.status).toBe(200);
    const payload = await envelopeOf(response);
    expect(payload.ok).toBe(true);
    const data = payload.data as Record<string, unknown>; // inspection DTO from typed studio service
    expect(Array.isArray(data['history'])).toBe(true);
    expect((data['history'] as unknown[]).length).toBe(2);
    const outputs = data['outputs'] as Array<Record<string, unknown>>;
    // Inspección = working dir ACTUAL (el fixture borró cover-v2/thumb tras
    // sellar): el dashboard de revisiones usa el sello, la inspección muestra
    // el estado mutable con honestidad.
    const coverV2 = outputs.find((output) => output['name'] === 'cover-v2');
    expect(coverV2?.['present']).toBe(false);
    const slide = outputs.find((output) => output['name'] === 'slide');
    expect(slide?.['present']).toBe(true);
    const missing = await fetch(`${server.baseUrl}/api/assets/${fixture.demoProjectId}/no-existe`);
    expect(missing.status).toBe(404);
    expect(errorOf(await envelopeOf(missing)).code).toBe('NOT_FOUND');
  });

  test('revisión sellada: manifest congelado + rootHash validado', async () => {
    const response = await fetch(`${server.baseUrl}/api/revisions/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}`);
    expect(response.status).toBe(200);
    const payload = await envelopeOf(response);
    expect(payload.ok).toBe(true);
    const parsed = RevisionManifestSchema.safeParse(payload.data);
    expect(parsed.success).toBe(true);
    const manifest = parsed.success ? parsed.data : null;
    expect(manifest?.revisionId).toBe(fixture.imageR1);
    expect(manifest?.rootHash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest!.files.length).toBeGreaterThan(1);
  });

  test('diff r1/r2: archivos agregados/eliminados por nombre', async () => {
    const response = await fetch(`${server.baseUrl}/api/diff/${fixture.demoProjectId}/${fixture.imageAssetId}?from=${fixture.imageR1}&to=${fixture.imageR2}`);
    expect(response.status).toBe(200);
    const payload = await envelopeOf(response);
    expect(payload.ok).toBe(true);
    const diff = payload.data as Record<string, unknown>; // diff DTO from typed studio service
    const files = diff['files'] as Record<string, unknown>;
    expect((files['added'] as string[]).length).toBeGreaterThan(0);
    expect(String(JSON.stringify(diff))).toContain('cover-v2.png');
    const badRequest = await fetch(`${server.baseUrl}/api/diff/${fixture.demoProjectId}/${fixture.imageAssetId}`);
    expect(badRequest.status).toBe(400);
    expect(errorOf(await envelopeOf(badRequest)).code).toBe('INVALID_INPUT');
  });

  test('archivos sellados: PNG inline con bytes exactos y headers', async () => {
    const response = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/png');
    expect(response.headers.get('content-disposition')).toContain('inline');
    expect(response.headers.get('content-disposition')).toContain('cover.png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes).toEqual(PNG_BYTES);
  });

  test('?download=1 fuerza descarga exacta', async () => {
    const response = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover?download=1`);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
  });

  test('SVG y HTML NUNCA inline: attachment siempre (no se ejecutan ni embeben)', async () => {
    const svg = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.svgAssetId}/${fixture.svgR1}/post.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get('content-type')).toContain('image/svg+xml');
    expect(svg.headers.get('content-disposition')).toContain('attachment');
    expect(await svg.text()).toBe(SVG_TEXT);
    const svgDownload = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.svgAssetId}/${fixture.svgR1}/post.svg?download=1`);
    expect(svgDownload.headers.get('content-disposition')).toContain('attachment');
    const html = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/slide`);
    expect(html.headers.get('content-type')).toContain('text/html');
    expect(html.headers.get('content-disposition')).toContain('attachment');
    expect(await html.text()).toBe(HTML_TEXT);
  });

  test('video: inline con content-type correcto (controles nativos en la UI)', async () => {
    const response = await fetch(`${server.baseUrl}/api/files/${fixture.soloProjectId}/${fixture.videoAssetId}/${fixture.videoR1}/spot`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('video/mp4');
    expect(response.headers.get('content-disposition')).toContain('inline');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP4_BYTES);
  });

  test('servicePath del catálogo resuelve por HTTP (nombre declarado → bytes sellados)', async () => {
    const catalog = catalogOf(await envelopeOf(await fetch(`${server.baseUrl}/api/catalog`)));
    const svgEntry = catalog.entries.find((entry) => entry.assetId === fixture.svgAssetId)!;
    const response = await fetch(`${server.baseUrl}/api/${svgEntry.outputs[0]!.servicePath}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SVG_TEXT);
  });

  test('nombre desconocido / traversal: rechazo estable sin fugar bytes', async () => {
    const unknownName = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/otro.png`);
    expect(unknownName.status).toBe(404);
    expect(errorOf(await envelopeOf(unknownName)).code).toBe('NOT_FOUND');
    const manifestAsName = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/manifest.json`);
    expect(manifestAsName.status).toBe(404);
    const traversalName = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/..%2F..%2F..%2Fsecret.txt`);
    expect(traversalName.status).toBe(400);
    expect(errorOf(await envelopeOf(traversalName)).code).toBe('INVALID_INPUT');
    const traversalId = await fetch(`${server.baseUrl}/api/files/..%2Fetc/imagen/x/y`);
    expect(traversalId.status).toBe(400);
    // WHATWG URL normaliza `%2e%2e` como segmento punto (nunca llega al
    // servidor como revisión); cualquier resultado es un rechazo seguro.
    const dotRevision = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/%2E%2E/cover`);
    expect([400, 404]).toContain(dotRevision.status);
    // Doble encoding sobrevive a la normalización y muere en el validador.
    const doubleEncoded = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/%252E%252E%252Fx/cover`);
    expect(doubleEncoded.status).toBe(400);
    expect(errorOf(await envelopeOf(doubleEncoded)).code).toBe('INVALID_INPUT');
  });

  test('solo lectura: verbos mutadores → 405 (no existen endpoints de escritura)', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`${server.baseUrl}/api/catalog`, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toContain('GET');
    }
    const deleteFile = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover`, { method: 'DELETE' });
    expect(deleteFile.status).toBe(405);
    const head = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover`, { method: 'HEAD' });
    expect(head.status).toBe(200);
  });

  test('404 para rutas desconocidas', async () => {
    const response = await fetch(`${server.baseUrl}/api/whatever`);
    expect(response.status).toBe(404);
    expect(errorOf(await envelopeOf(response)).code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Corruption / storage fallback / url rules (dedicated fixtures per test)
// ---------------------------------------------------------------------------

describe('seguridad de archivos sellados (fixtures dedicados)', () => {
  test('manifest alterado → 409 HASH_MISMATCH en revisiones y archivos', async () => {
    const fixture = await makeDashboardFixture('vm-dashboard-tamper');
    const server = await startTestDashboard(fixture.root);
    try {
      const manifestPath = path.join(fixture.root, 'revisions', fixture.demoProjectId, fixture.imageAssetId, fixture.imageR1, 'manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest['rootHash'] = 'a'.repeat(64);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const revisions = await fetch(`${server.baseUrl}/api/revisions/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}`);
      expect(revisions.status).toBe(409);
      expect(errorOf(await envelopeOf(revisions)).code).toBe('HASH_MISMATCH');
      const file = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover`);
      expect(file.status).toBe(409);
      expect(errorOf(await envelopeOf(file)).code).toBe('HASH_MISMATCH');
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });

  test('bytes sellados corruptos → 409; tipo ajeno detectado por sniffing → 409', async () => {
    const fixture = await makeDashboardFixture('vm-dashboard-corrupt');
    const server = await startTestDashboard(fixture.root);
    try {
      const revisionDir = path.join(fixture.root, 'revisions', fixture.demoProjectId, fixture.imageAssetId, fixture.imageR1);
      // 1) plain corruption: different bytes → hash mismatch.
      const coverPath = path.join(revisionDir, 'files', 'outputs', 'cover.png');
      await writeFile(coverPath, PNG_THUMB_BYTES);
      const corrupt = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover`);
      expect(corrupt.status).toBe(409);
      expect(errorOf(await envelopeOf(corrupt)).code).toBe('HASH_MISMATCH');
      // 2) internally-consistent manifest with WRONG type: svg bytes declared
      //    as image/png → the sniffer rejects before serving.
      await writeFile(coverPath, new TextEncoder().encode(SVG_TEXT));
      const manifestPath = path.join(revisionDir, 'manifest.json');
      const parsed = RevisionManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, 'utf8')));
      expect(parsed.success).toBe(true);
      const manifest = parsed.success ? parsed.data : null;
      expect(manifest).not.toBeNull();
      const file = manifest!.files.find((candidate) => candidate.path === 'outputs/cover.png')!;
      const bytes = new TextEncoder().encode(SVG_TEXT);
      file.sha256 = await sha256Hex(bytes);
      file.bytes = bytes.length;
      manifest!.rootHash = await computeRevisionRootHash(manifest!);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const mismatch = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover`);
      expect(mismatch.status).toBe(409);
      expect(errorOf(await envelopeOf(mismatch)).code).toBe('HASH_MISMATCH');
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });

  test('copia sellada local ausente: storage inyectado resuelve por sha; sin storage → 404 accionable', async () => {
    const fixture = await makeDashboardFixture('vm-dashboard-remote');
    try {
      const sealedPath = path.join(fixture.root, 'revisions', fixture.soloProjectId, fixture.videoAssetId, fixture.videoR1, 'files', 'outputs', 'spot.mp4');
      const sealedBytes = await readFile(sealedPath);
      const key = storageObjectKeyForSha(await sha256Hex(new Uint8Array(sealedBytes)));
      // No storage injected → actionable 404.
      const serverAlone = await startTestDashboard(fixture.root);
      try {
        await rm(sealedPath);
        const alone = await fetch(`${serverAlone.baseUrl}/api/files/${fixture.soloProjectId}/${fixture.videoAssetId}/${fixture.videoR1}/spot`);
        expect(alone.status).toBe(404);
        const aloneError = errorOf(await envelopeOf(alone));
        expect(aloneError.code).toBe('NOT_FOUND');
        expect(aloneError.message).toContain('storage privado inyectado');
      } finally {
        await serverAlone.stop();
      }
      // Injected storage with the RIGHT bytes → served after re-verification.
      const objects = new Map<string, Uint8Array>([[key, new Uint8Array(sealedBytes)]]);
      const storage = fakeStorage(objects);
      const serverRemote = await startTestDashboard(fixture.root, { storage });
      try {
        const remote = await fetch(`${serverRemote.baseUrl}/api/files/${fixture.soloProjectId}/${fixture.videoAssetId}/${fixture.videoR1}/spot`);
        expect(remote.status).toBe(200);
        expect(new Uint8Array(await remote.arrayBuffer())).toEqual(new Uint8Array(sealedBytes));
        expect(storage.getKeys).toEqual([key]);
      } finally {
        await serverRemote.stop();
      }
      // Injected storage with WRONG bytes → 409 (never served unchecked).
      const corruptObjects = new Map<string, Uint8Array>([[key, PNG_BYTES]]);
      const serverCorrupt = await startTestDashboard(fixture.root, { storage: fakeStorage(corruptObjects) });
      try {
        const corrupted = await fetch(`${serverCorrupt.baseUrl}/api/files/${fixture.soloProjectId}/${fixture.videoAssetId}/${fixture.videoR1}/spot`);
        expect(corrupted.status).toBe(409);
        expect(errorOf(await envelopeOf(corrupted)).code).toBe('HASH_MISMATCH');
      } finally {
        await serverCorrupt.stop();
      }
      // Storage failure surfaces as typed 503 envelope.
      const serverFailing = await startTestDashboard(fixture.root, { storage: fakeStorage(objects, 'failing') });
      try {
        const failing = await fetch(`${serverFailing.baseUrl}/api/files/${fixture.soloProjectId}/${fixture.videoAssetId}/${fixture.videoR1}/spot`);
        expect(failing.status).toBe(503);
        expect(errorOf(await envelopeOf(failing)).code).toBe('STORAGE_UNAVAILABLE');
      } finally {
        await serverFailing.stop();
      }
    } finally {
      await fixture.cleanup();
    }
  });

  test('health y catálogo jamás tocan el storage inyectado', async () => {
    const fixture = await makeDashboardFixture('vm-dashboard-nostrg');
    const server = await startTestDashboard(fixture.root, { storage: fakeStorage(new Map(), 'failing') });
    try {
      const health = await fetch(`${server.baseUrl}/health`);
      expect(health.status).toBe(200);
      const catalog = await fetch(`${server.baseUrl}/api/catalog`);
      expect(catalog.status).toBe(200);
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Correction round: explicit access policy + deeper sealed integrity
// ---------------------------------------------------------------------------

describe('política de acceso explícita y integridad del sello (corrección)', () => {
  test('startDashboardServer: 0.0.0.0 exige access trusted-tailnet ANTES de bindear', async () => {
    let thrown: unknown;
    try {
      await startDashboardServer({ workspaceDir: os.tmpdir(), host: '0.0.0.0', port: 47233 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof StudioServiceError).toBe(true);
    expect((thrown as StudioServiceError).code).toBe('INVALID_INPUT');
    // No bind happened: nothing answers the port.
    let bound = true;
    try {
      await fetch('http://127.0.0.1:47233/health');
    } catch {
      bound = false;
    }
    expect(bound).toBe(false);
  });

  test('startDashboardServer: access desconocido y localhost+trusted-tailnet rechazados', async () => {
    for (const options of [
      { workspaceDir: os.tmpdir(), host: '0.0.0.0', port: 0, access: 'public' },
      { workspaceDir: os.tmpdir(), host: 'localhost', port: 0, access: 'trusted-tailnet' },
      { workspaceDir: os.tmpdir(), host: '127.0.0.1', port: 0, access: 'trusted-tailnet' },
    ]) {
      let thrown: unknown;
      try {
        await startDashboardServer(options as Parameters<typeof startDashboardServer>[0]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown instanceof StudioServiceError).toBe(true);
      expect((thrown as StudioServiceError).code).toBe('INVALID_INPUT');
    }
  });

  test('revisionId alterado SOLO en el manifest (rootHash válido) ⇒ 409', async () => {
    const fixture = await makeDashboardFixture('vm-dashboard-revid');
    const server = await startTestDashboard(fixture.root);
    try {
      const manifestPath = path.join(fixture.root, 'revisions', fixture.demoProjectId, fixture.imageAssetId, fixture.imageR1, 'manifest.json');
      const parsed = RevisionManifestSchema.safeParse(JSON.parse(await readFile(manifestPath, 'utf8')));
      expect(parsed.success).toBe(true);
      const manifest = parsed.success ? parsed.data : null;
      expect(manifest).not.toBeNull();
      // revisionId está EXCLUIDO del payload del rootHash: el sello sigue
      // "válido", pero la identidad pedida por URL ya no coincide.
      manifest!.revisionId = 'revision-falsa';
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const revisions = await fetch(`${server.baseUrl}/api/revisions/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}`);
      expect(revisions.status).toBe(409);
      expect(errorOf(await envelopeOf(revisions)).code).toBe('HASH_MISMATCH');
      const file = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover`);
      expect(file.status).toBe(409);
      expect(errorOf(await envelopeOf(file)).code).toBe('HASH_MISMATCH');
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });

  test('padre symlink fuera de la revisión con bytes idénticos ⇒ PATH_UNSAFE', async () => {
    const fixture = await makeDashboardFixture('vm-dashboard-symlink');
    const server = await startTestDashboard(fixture.root);
    try {
      const filesDir = path.join(fixture.root, 'revisions', fixture.demoProjectId, fixture.imageAssetId, fixture.imageR1, 'files');
      const outside = await mkdtemp(path.join(os.tmpdir(), 'vm-dashboard-outside-'));
      try {
        // Move the REAL outputs dir outside and link it back: bytes perfect,
        // manifest intact — still refused (the seal must be a real chain).
        await rename(path.join(filesDir, 'outputs'), path.join(outside, 'outputs'));
        await symlink(path.join(outside, 'outputs'), path.join(filesDir, 'outputs'));
        const response = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover`);
        expect(response.status).toBe(400);
        expect(errorOf(await envelopeOf(response)).code).toBe('PATH_UNSAFE');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });

  test('PNG declarado con magia desconocida (manifest consistente) ⇒ 409; formatos no anunciados quedan attachment', async () => {
    const fixture = await makeDashboardFixture('vm-dashboard-magic');
    const server = await startTestDashboard(fixture.root);
    try {
      const revisionDir = path.join(fixture.root, 'revisions', fixture.demoProjectId, fixture.imageAssetId, fixture.imageR1);
      const coverPath = path.join(revisionDir, 'files', 'outputs', 'cover.png');
      // Consistent manifest, WRONG magic: arbitrary bytes can never pass as PNG.
      const bytes = new TextEncoder().encode('DATOS-ARBITRARIOS-SIN-FIRMA-PNG');
      const parsed = RevisionManifestSchema.safeParse(JSON.parse(await readFile(path.join(revisionDir, 'manifest.json'), 'utf8')));
      expect(parsed.success).toBe(true);
      const manifest = parsed.success ? parsed.data : null;
      expect(manifest).not.toBeNull();
      const file = manifest!.files.find((candidate) => candidate.path === 'outputs/cover.png')!;
      file.sha256 = await sha256Hex(bytes);
      file.bytes = bytes.length;
      manifest!.rootHash = await computeRevisionRootHash(manifest!);
      await writeFile(coverPath, bytes);
      await writeFile(path.join(revisionDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      const response = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover`);
      expect(response.status).toBe(409);
      expect(errorOf(await envelopeOf(response)).code).toBe('HASH_MISMATCH');
      // AVIF/WebM sin firma reconocible ⇒ descarga exacta (attachment), nunca
      // clasificación mp4 falsa; formato real mp4 sí se verifica inline.
      const avifBytes = new TextEncoder().encode('DATOS-SIN-FIRMA-AVIF');
      const parsedAvif = RevisionManifestSchema.safeParse(JSON.parse(await readFile(path.join(revisionDir, 'manifest.json'), 'utf8')));
      expect(parsedAvif.success).toBe(true);
      const avifManifest = parsedAvif.success ? parsedAvif.data : null;
      expect(avifManifest).not.toBeNull();
      const avifFile = avifManifest!.files.find((candidate) => candidate.path === 'outputs/cover.png')!;
      const avifSpec = avifManifest!.assetSnapshot.outputs.find((candidate) => candidate.name === 'cover')!;
      avifFile.mediaType = 'image/avif';
      avifSpec.mediaType = 'image/avif';
      avifFile.sha256 = await sha256Hex(avifBytes);
      avifFile.bytes = avifBytes.length;
      avifManifest!.rootHash = await computeRevisionRootHash(avifManifest!);
      await writeFile(coverPath, avifBytes);
      await writeFile(path.join(revisionDir, 'manifest.json'), `${JSON.stringify(avifManifest, null, 2)}\n`);
      const avif = await fetch(`${server.baseUrl}/api/files/${fixture.demoProjectId}/${fixture.imageAssetId}/${fixture.imageR1}/cover`);
      expect(avif.status).toBe(200);
      expect(avif.headers.get('content-type')).toContain('image/avif');
      expect(avif.headers.get('content-disposition')).toContain('attachment');
      const spot = await resolveSealedOutput(fixture.ctx, undefined, {
        projectId: fixture.soloProjectId,
        assetId: fixture.videoAssetId,
        revisionId: fixture.videoR1,
        outputName: 'spot',
      });
      expect(spot.disposition).toBe('inline');
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
  });
});

describe('dashboard url (estado de serve + IPv4 Tailscale)', () => {
  let workspace: string | undefined;

  afterEach(async () => {
    if (workspace !== undefined) await rm(workspace, { recursive: true, force: true });
    workspace = undefined;
  });

  test('sin estado → NOT_FOUND accionable', async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'vm-dashboard-url-'));
    let thrown: unknown;
    try {
      await resolveDashboardUrl({ workspaceDir: workspace });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof StudioServiceError).toBe(true);
    expect((thrown as StudioServiceError).code).toBe('NOT_FOUND');
  });

  test('pid muerto o puerto sin listener → NOT_FOUND (estado stale rechazado)', async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'vm-dashboard-url-'));
    await writeDashboardServeState(workspace, {
      schemaVersion: 1,
      pid: findDeadPid(),
      host: '0.0.0.0',
      port: 45_123,
      access: 'trusted-tailnet',
      startedAt: new Date().toISOString(),
    });
    let thrown: unknown;
    try {
      await resolveDashboardUrl({ workspaceDir: workspace, tailscaleIpv4: async () => '100.64.0.1', probeHealth: async () => true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof StudioServiceError).toBe(true);
    expect((thrown as StudioServiceError).code).toBe('NOT_FOUND');

    // Alive pid but nothing listening on the port → also stale.
    await writeDashboardServeState(workspace, {
      schemaVersion: 1,
      pid: process.pid,
      host: '0.0.0.0',
      port: 45_123,
      access: 'trusted-tailnet',
      startedAt: new Date().toISOString(),
    });
    thrown = undefined;
    try {
      await resolveDashboardUrl({
        workspaceDir: workspace,
        tailscaleIpv4: async () => '100.64.0.1',
        probeHealth: async (url) => !url.includes('45123'),
        listenerProbe: listenerOk,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof StudioServiceError).toBe(true);
    expect((thrown as StudioServiceError).code).toBe('NOT_FOUND');
  });

  test('bind interno o access sin trusted-tailnet → INVALID_INPUT, NUNCA enlace loopback', async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'vm-dashboard-url-'));
    const states = [
      { schemaVersion: 1 as const, pid: process.pid, host: '127.0.0.1', port: 8907, access: 'internal' as const, startedAt: new Date().toISOString() },
      { schemaVersion: 1 as const, pid: process.pid, host: '0.0.0.0', port: 8907, access: 'internal' as const, startedAt: new Date().toISOString() },
    ];
    for (const state of states) {
      await writeDashboardServeState(workspace, state);
      let thrown: unknown;
      try {
        await resolveDashboardUrl({ workspaceDir: workspace, tailscaleIpv4: async () => '100.64.0.1', probeHealth: async () => true });
      } catch (error) {
        thrown = error;
      }
      expect(thrown instanceof StudioServiceError).toBe(true);
      const serviceError = thrown as StudioServiceError;
      expect(serviceError.code).toBe('INVALID_INPUT');
      expect(serviceError.message).toContain('loopback');
    }
    const state = await readDashboardServeState(workspace);
    expect(state?.access).toBe('internal');
  });

  test('enlace feliz: IPv4 real de Tailscale + listener verificado por IP', async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'vm-dashboard-url-'));
    await writeDashboardServeState(workspace, {
      schemaVersion: 1,
      pid: process.pid,
      host: '0.0.0.0',
      port: 8907,
      access: 'trusted-tailnet',
      startedAt: new Date().toISOString(),
    });
    const probedUrls: string[] = [];
    const result = await resolveDashboardUrl({
      workspaceDir: workspace,
      tailscaleIpv4: async () => '100.83.90.33',
      probeHealth: async (url) => {
        probedUrls.push(url);
        return true;
      },
      listenerProbe: listenerOk,
      clientId: 'cliente-uno',
      projectId: 'proyecto-demo',
    });
    expect(result.url).toBe('http://100.83.90.33:8907/?client=cliente-uno&project=proyecto-demo');
    expect(result.access).toBe('trusted-tailnet');
    expect(probedUrls).toContain('http://127.0.0.1:8907/health');
    expect(probedUrls).toContain('http://100.83.90.33:8907/health');
  });

  test('Tailscale caído o sin ruta por la IP → STORAGE_UNAVAILABLE (sin fallback)', async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'vm-dashboard-url-'));
    await writeDashboardServeState(workspace, {
      schemaVersion: 1,
      pid: process.pid,
      host: '0.0.0.0',
      port: 8907,
      access: 'trusted-tailnet',
      startedAt: new Date().toISOString(),
    });
    let thrown: unknown;
    try {
      await resolveDashboardUrl({
        workspaceDir: workspace,
        tailscaleIpv4: async () => {
          throw new StudioServiceError('STORAGE_UNAVAILABLE', 'tailscale inactivo.');
        },
        probeHealth: async () => true,
        listenerProbe: listenerOk,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof StudioServiceError).toBe(true);
    expect((thrown as StudioServiceError).code).toBe('STORAGE_UNAVAILABLE');

    thrown = undefined;
    try {
      await resolveDashboardUrl({
        workspaceDir: workspace,
        tailscaleIpv4: async () => '100.83.90.33',
        probeHealth: async (url) => url.startsWith('http://127.'),
        listenerProbe: listenerOk,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown instanceof StudioServiceError).toBe(true);
    expect((thrown as StudioServiceError).code).toBe('STORAGE_UNAVAILABLE');
  });

  test('estado mentiroso: socket no all-interfaces o pid ajeno ⇒ rechazo (seam ss)', async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'vm-dashboard-url-'));
    await writeDashboardServeState(workspace, {
      schemaVersion: 1,
      pid: process.pid,
      host: '0.0.0.0',
      port: 8907,
      access: 'trusted-tailnet',
      startedAt: new Date().toISOString(),
    });
    const cases: ListenerProbeResult[] = [
      { listening: false, allInterfaces: false, pidMatches: false }, // nothing there
      { listening: true, allInterfaces: false, pidMatches: true }, // loopback-only socket
      { listening: true, allInterfaces: true, pidMatches: false }, // someone else's socket
    ];
    for (const probeResult of cases) {
      let thrown: unknown;
      try {
        await resolveDashboardUrl({
          workspaceDir: workspace,
          tailscaleIpv4: async () => '100.83.90.33',
          probeHealth: async () => true,
          listenerProbe: async () => probeResult,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown instanceof StudioServiceError).toBe(true);
      expect((thrown as StudioServiceError).code).toBe('NOT_FOUND');
      expect((thrown as StudioServiceError).message).toContain('stale');
    }
  });

  test('IP de Tailscale validada (100.64.0.0/10): loopback/privadas/inválidas rechazadas', async () => {
    expect(isTailscaleIpv4('100.83.90.33')).toBe(true);
    expect(isTailscaleIpv4('100.64.0.1')).toBe(true);
    expect(isTailscaleIpv4('100.127.255.254')).toBe(true);
    for (const invalid of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '300.1.2.3', 'no-ip', '']) {
      expect(isTailscaleIpv4(invalid)).toBe(false);
    }
    workspace = await mkdtemp(path.join(os.tmpdir(), 'vm-dashboard-url-'));
    await writeDashboardServeState(workspace, {
      schemaVersion: 1,
      pid: process.pid,
      host: '0.0.0.0',
      port: 8907,
      access: 'trusted-tailnet',
      startedAt: new Date().toISOString(),
    });
    for (const invalid of ['127.0.0.1', '10.0.0.5', '999.999.1.1', 'localhost']) {
      let thrown: unknown;
      try {
        await resolveDashboardUrl({
          workspaceDir: workspace,
          tailscaleIpv4: async () => invalid,
          probeHealth: async () => true,
          listenerProbe: listenerOk,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown instanceof StudioServiceError).toBe(true);
      expect((thrown as StudioServiceError).code).toBe('STORAGE_UNAVAILABLE');
    }
  });

  test('arranque/parada efímera: el estado registra el puerto real y se libera al parar', async () => {
    const fixture = await makeDashboardFixture('vm-dashboard-serve');
    const server = await startTestDashboard(fixture.root);
    try {
      await writeDashboardServeState(fixture.root, {
        schemaVersion: 1,
        pid: process.pid,
        host: '127.0.0.1',
        port: server.port,
        access: 'internal',
        startedAt: new Date().toISOString(),
      });
      const state = await readDashboardServeState(fixture.root);
      expect(state?.port).toBe(server.port);
      const health = await fetch(`${server.baseUrl}/health`);
      expect(health.status).toBe(200);
    } finally {
      await server.stop();
      await fixture.cleanup();
    }
    // Stopped: the ephemeral port no longer answers.
    let closed = false;
    try {
      await fetch(`http://127.0.0.1:${server.port}/health`);
    } catch {
      closed = true;
    }
    expect(closed).toBe(true);
  });
});
