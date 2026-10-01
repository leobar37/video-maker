/**
 * scripts/studio-verify.ts — `bun run studio:verify` (P-006, offline).
 *
 * Runs, with a hard exit-0-or-nothing contract:
 *   1. fixture integrity: the adopted BFC/Remotion copies in `demo/studio/`
 *      still match the recorded provenance AND the originals are untouched
 *      (non-destructive adoption);
 *   2. EVERY suite of the new phases plus the relevant legacy
 *      dispatcher/registry/persistence suites (`bun test`), refusing a
 *      vacuous "0 tests" pass — files, suites and assertions are required;
 *   3. the full adoption demo end-to-end in a temp workspace (no renderer,
 *      no network): two revisions per asset, stable r1, diff, restore with
 *      SHA-256 proof, checkpoints, catalog and CLI JSON envelopes;
 *   4. an ephemeral machine-local dashboard smoke (bind 127.0.0.1, stopped
 *      before exit): health, catalog, asset API, sealed image/video serving.
 *
 * Evidence lands in `evidence/creative-workspace/validation.json` (visual
 * checks stay PENDING for the coordinator/Flash; nothing is invented).
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildStudioCatalog,
  diffAssetRevisions,
  getRevisionManifest,
  inspectCreativeAsset,
  restoreAssetRevision,
  type RevisionManifest,
} from '@videomaker/studio';
import { startDashboardServer } from '@videomaker/dashboard';

/** Runtime narrowing for JSON boundary reads (no inline cast access). */
function recordWithField(value: unknown, field: string): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && field in value) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Provenance document of `demo/studio/bfc/provenance.json`. */
interface ProvenanceDoc {
  adopted: Array<{ original: string; adoptedCopy: string; sha256: string }>;
  derived: Array<{ file: string; derivedFrom: string; sha256?: string; edit: string }>;
}

import { buildDemoWorkspace, demoFixtureFacts, DEMO_ROOT, sha256Bytes, sha256File } from './studio-demo';

const REPO_ROOT = path.join(import.meta.dir, '..');
const EVIDENCE_DIR = path.join(REPO_ROOT, 'evidence', 'creative-workspace');
const EVIDENCE_FILE = path.join(EVIDENCE_DIR, 'validation.json');

/** Every suite of the new phases + the legacy suites this goal must not regress. */
const REQUIRED_SUITES = [
  'packages/schemas/src/studio.test.ts',
  'packages/schemas/src/catalog.test.ts',
  'packages/studio/src/workspace.test.ts',
  'packages/studio/src/snapshot.test.ts',
  'packages/studio/src/sync.test.ts',
  'packages/cli/src/args.test.ts',
  'packages/cli/src/runtime.test.ts',
  'packages/cli/src/specs/studio.test.ts',
  'packages/cli/src/specs/studio-sync.test.ts',
  'packages/cli/src/specs/studio-dashboard.test.ts',
  'packages/providers/src/storage/r2-store.test.ts',
  'packages/providers/src/storage/studio-r2.test.ts',
  'packages/cli/src/persist/archive.test.ts',
  'packages/cli/src/persist/policy.test.ts',
  'packages/cli/src/persist/r2-wiring.test.ts',
  'packages/dashboard/src/catalog.test.ts',
  'packages/dashboard/src/server.test.ts',
] as const;

/** Floor under the aggregate so a stripped suite set can never "pass". */
const MIN_TOTAL_TESTS = 150;

interface VerifyFailure {
  step: string;
  detail: string;
}

const failures: VerifyFailure[] = [];
const notes: string[] = [];

function requireThat(step: string, condition: boolean, detail: string): void {
  if (!condition) failures.push({ step, detail });
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await access(absPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1. Fixture integrity + non-destructive adoption
// ---------------------------------------------------------------------------


async function checkFixtures(): Promise<{ fixtureBytes: number }> {
  const provenancePath = path.join(DEMO_ROOT, 'bfc', 'provenance.json');
  const provenance: ProvenanceDoc = JSON.parse(await readFile(provenancePath, 'utf8')) as ProvenanceDoc;

  for (const entry of provenance.adopted) {
    const originalAbs = path.join(REPO_ROOT, entry.original);
    requireThat(`provenance:${entry.original}`, await fileExists(originalAbs), 'original ausente');
    requireThat(`provenance:${entry.adoptedCopy}`, await fileExists(path.join(REPO_ROOT, entry.adoptedCopy)), 'copia demo ausente');
    const originalSha = await sha256File(originalAbs);
    requireThat(
      `provenance:${entry.original}`,
      originalSha === entry.sha256,
      `el original cambió (esperado ${entry.sha256.slice(0, 12)}…, actual ${originalSha.slice(0, 12)}…) — adopción destructiva`,
    );
    const copySha = await sha256File(path.join(REPO_ROOT, entry.adoptedCopy));
    requireThat(`provenance:${entry.adoptedCopy}`, copySha === entry.sha256, 'la copia demo divergió del original adoptado');
  }
  for (const derived of provenance.derived) {
    if (derived.sha256 !== undefined) {
      requireThat(
        `derived:${derived.file}`,
        (await sha256File(path.join(REPO_ROOT, derived.file))) === derived.sha256,
        'archivo derivado divergió',
      );
    }
  }
  const logoOriginal = provenance.adopted.find((entry) => entry.original === 'bfc/assets/logo-bfc-profile.png');
  const logoV2 = provenance.derived.find((entry) => entry.file === 'demo/studio/bfc/logo-bfc-demo-v2.png');
  requireThat('fixtures:logo-cambiado', logoOriginal !== undefined && logoV2?.sha256 !== undefined && logoOriginal.sha256 !== logoV2.sha256, 'el logo v2 debe ser distinto del original (copia demo)');
  requireThat(
    'fixtures:lock-propio',
    await fileExists(path.join(DEMO_ROOT, 'remotion-hello', 'bun.lock')),
    'el fixture Remotion debe tener lock propio',
  );

  const facts = await demoFixtureFacts();
  const fixtureBytes = facts.reduce((total, fact) => total + fact.bytes, 0);
  requireThat('fixtures:tamano', fixtureBytes <= 20 * 1024 * 1024, `demo/studio supera 20 MiB: ${fixtureBytes} bytes`);
  return { fixtureBytes };
}

// ---------------------------------------------------------------------------
// 2. Suite runner (files + suites + assertions required)
// ---------------------------------------------------------------------------

interface SuiteRunResult {
  exitCode: number;
  totalTests: number;
  files: number;
  passed: number;
  failed: number;
  perSuite: Array<{ suite: string; tests: number; pass: number; fail: number; exitCode: number }>;
}

async function runSuites(): Promise<SuiteRunResult> {
  let totalTests = 0;
  let passed = 0;
  let failed = 0;
  const perSuite: Array<{ suite: string; tests: number; pass: number; fail: number; exitCode: number }> = [];
  let aggregateExit = 0;
  // runs, so presence and per-suite assertion counts are enforced by running
  // each file on its own (a suite with 0 tests can never pass).
  for (const suite of REQUIRED_SUITES) {
    requireThat(`suites:exists:${suite}`, await fileExists(path.join(REPO_ROOT, suite)), 'suite requerida ausente');
    const proc = Bun.spawn(['bun', 'test', suite], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
    const output = `${await new Response(proc.stdout).text()}\n${await new Response(proc.stderr).text()}`;
    const exitCode = await proc.exited;
    aggregateExit = aggregateExit === 0 ? exitCode : 1;
    // bun test reports on stderr: `Ran N tests across N files. [time]` plus
    // standalone ` N pass` / ` N fail` counters (never "N pass, N fail").
    const summary = /Ran (\d+) tests across (\d+) files?/.exec(output);
    const passCounters = [...output.matchAll(/^\s*(\d+) pass$/gm)].map((match) => Number(match[1]));
    const failCounters = [...output.matchAll(/^\s*(\d+) fail$/gm)].map((match) => Number(match[1]));
    const suiteTests = summary === null ? 0 : Number(summary[1]);
    const suitePassed = passCounters.length > 0 ? Math.max(...passCounters) : 0;
    const suiteFailed = failCounters.length > 0 ? Math.max(...failCounters) : 0;
    requireThat(`suites:ran:${suite}`, summary !== null && Number(summary[2]) === 1, 'la suite no corrió como archivo propio');
    requireThat(`suites:tests:${suite}`, suiteTests >= 1, 'suite sin assertions: no basta "0 tests"');
    requireThat(`suites:exit:${suite}`, exitCode === 0, `bun test terminó con exit ${exitCode}`);
    totalTests += suiteTests;
    passed += suitePassed;
    failed += suiteFailed;
    perSuite.push({ suite, tests: suiteTests, pass: suitePassed, fail: suiteFailed, exitCode });
  }
  requireThat('suites:count', totalTests >= MIN_TOTAL_TESTS, `demasiados pocos tests (${totalTests} < ${MIN_TOTAL_TESTS})`);
  requireThat('suites:failures', failed === 0 && passed === totalTests, `${failed} tests fallidos en el agregado`);
  return { exitCode: aggregateExit, totalTests, files: perSuite.length, passed, failed, perSuite };
}

// ---------------------------------------------------------------------------
// 3. Adoption end-to-end in a temp workspace (offline, renderer-free)
// ---------------------------------------------------------------------------

interface ManifestFileCheck {
  path: string;
  sha256: string;
  ok: boolean;
}

async function verifyRestoredTree(outDir: string, manifest: RevisionManifest): Promise<ManifestFileCheck[]> {
  const checks: ManifestFileCheck[] = [];
  for (const file of manifest.files) {
    const restored = await readFile(path.join(outDir, file.path));
    checks.push({ path: file.path, sha256: file.sha256, ok: (await sha256Bytes(new Uint8Array(restored))) === file.sha256 && restored.byteLength === file.bytes });
  }
  return checks;
}

async function runCliJson(args: string[]): Promise<{ exitCode: number; stdout: string; data?: unknown }> {
  const proc = Bun.spawn(['bun', 'packages/cli/src/main.ts', ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  let data: unknown;
  try {
    const envelope = recordWithField(JSON.parse(stdout), 'schemaVersion');
    if (envelope?.ok !== true || envelope?.schemaVersion !== 1) {
      failures.push({ step: 'cli:envelope', detail: `envelope inválido para ${args.join(' ')}` });
    }
    data = envelope?.data;
  } catch {
    failures.push({ step: 'cli:json', detail: `stdout no es JSON para: ${args.join(' ')} — ${stdout.slice(0, 120)}` });
  }
  return { exitCode, stdout, data };
}

interface AdoptionResult {
  projectIds: { shared: string; solo: string };
  revisions: Array<{ projectId: string; assetId: string; revisionId: string; rootHash: string; files: number }>;
  restoreChecks: Array<{ revisionId: string; filesOk: boolean; files: number }>;
  cliExitCodes: Array<{ args: string; exitCode: number }>;
}

async function runAdoption(): Promise<AdoptionResult> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cw-verify-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const demo = await buildDemoWorkspace(workspaceDir, { projectIds: { shared: 'shared-showcase', solo: 'solo-workshop' } });
  const result: AdoptionResult = {
    projectIds: demo.projectIds,
    revisions: [],
    restoreChecks: [],
    cliExitCodes: [],
  };

  // Two distinct revisions per asset, r1 byte-stable after the r2 work.
  for (const [name, asset] of [['cover', demo.assets.cover], ['video', demo.assets.video]] as const) {
    requireThat(`adopcion:${name}:rootHash-distinto`, asset.r1.rootHash !== asset.r2.rootHash, 'las dos revisiones comparten rootHash');
    const r1After = await getRevisionManifest(demo.ctx, {
      projectId: asset.r1.projectId,
      assetId: asset.r1.assetId,
      revisionId: asset.r1.revisionId,
    });
    requireThat(
      `adopcion:${name}:r1-estable`,
      JSON.stringify(r1After) === JSON.stringify(asset.r1.manifest),
      'el manifest r1 cambió tras crear r2 (las revisiones son inmutables)',
    );
    result.revisions.push(
      { projectId: asset.r1.projectId, assetId: asset.r1.assetId, revisionId: asset.r1.revisionId, rootHash: asset.r1.rootHash, files: asset.r1.manifest.files.length },
      { projectId: asset.r2.projectId, assetId: asset.r2.assetId, revisionId: asset.r2.revisionId, rootHash: asset.r2.rootHash, files: asset.r2.manifest.files.length },
    );
  }

  // Preset change alone re-seals the video asset (r2) with r1 sources intact.
  const videoDiff = await diffAssetRevisions(demo.ctx, {
    projectId: demo.projectIds.solo,
    assetId: demo.assets.video.assetId,
    fromRevisionId: demo.assets.video.r1.revisionId,
    toRevisionId: demo.assets.video.r2.revisionId,
  });
  requireThat(
  'adopcion:video:preset-cambiado',
  videoDiff.presets.added.length > 0 && videoDiff.presets.removed.length > 0,
  'el diff de video debe mostrar el preset reemplazado (added+removed)',
);
  const videoMp4R1 = demo.assets.video.r1.manifest.files.find((file) => file.path === 'workroom/remotion-hello/outputs/hello.mp4');
  const videoMp4R2 = demo.assets.video.r2.manifest.files.find((file) => file.path === 'workroom/remotion-hello/outputs/hello.mp4');
  requireThat(
    'adopcion:video:mp4-estable',
    videoMp4R1 !== undefined && videoMp4R2 !== undefined && videoMp4R1.sha256 === videoMp4R2.sha256,
    'el MP4 no debe cambiar entre r1 y r2 (solo cambia el preset)',
  );

  // Cover diff must show outputs + presets changed (different local source).
  const coverDiff = await diffAssetRevisions(demo.ctx, {
    projectId: demo.projectIds.shared,
    assetId: demo.assets.cover.assetId,
    fromRevisionId: demo.assets.cover.r1.revisionId,
    toRevisionId: demo.assets.cover.r2.revisionId,
  });
  requireThat('adopcion:cover:outputs-modificados', coverDiff.outputs.modified.length >= 1, 'el diff de cover debe mostrar outputs modificados');

  // Inspection: real directories, exact presets, explicit recipe (never run).
  const videoInspection = await inspectCreativeAsset(demo.ctx, { projectId: demo.projectIds.solo, assetId: demo.assets.video.assetId });
  requireThat('adopcion:inspect:fuentes', videoInspection.sources.every((source) => source.present), 'fuente ausente en inspección');
  requireThat(
    'adopcion:inspect:preset-exacto',
    videoInspection.presets.length === 1 && videoInspection.presets[0]?.versionId === demo.presets.secondBrandV1.versionId,
    'la inspección debe resolver el preset exacto de r2',
  );
  requireThat('adopcion:inspect:recipe', videoInspection.recipe?.argv[0] === 'bun', 'recipe explícita esperada (no ejecutada)');

  // Restore r1 of both assets into empty dirs with SHA proof.
  for (const asset of [demo.assets.cover, demo.assets.video]) {
    const outDir = path.join(tempRoot, 'restore', asset.assetId);
    const restored = await restoreAssetRevision(demo.ctx, {
      projectId: asset.r1.projectId,
      assetId: asset.r1.assetId,
      revisionId: asset.r1.revisionId,
      outDir,
    });
    const checks = await verifyRestoredTree(restored.outDir, asset.r1.manifest);
    requireThat(
      `adopcion:restore:${asset.assetId}`,
      checks.every((check) => check.ok) && checks.length === asset.r1.manifest.files.length,
      `restore verificó ${checks.filter((check) => check.ok).length}/${checks.length} archivos por SHA`,
    );
    result.restoreChecks.push({ revisionId: asset.r1.revisionId, filesOk: checks.every((check) => check.ok), files: checks.length });
  }

  // Catalog: one read-only consumer view with separated states.
  const catalog = await buildStudioCatalog(demo.ctx);
  requireThat('adopcion:catalog:entries', catalog.entries.length === 4, `catálogo esperaba 4 entries (2 revisiones por asset), hay ${catalog.entries.length}`);
  const videoEntry = catalog.entries.find((entry) => entry.asset.id === demo.assets.video.assetId && entry.revisionId === demo.assets.video.r2.revisionId);
  requireThat('adopcion:catalog:video', videoEntry !== undefined, 'entry de video ausente');
  requireThat(
    'adopcion:catalog:estados',
    videoEntry !== undefined && videoEntry.revisionId === demo.assets.video.r2.revisionId && videoEntry.outputs.length === 2,
    'entry de video debe mostrar revisión activa y outputs declarados',
  );
  const videoOnly = await buildStudioCatalog(demo.ctx, { kind: 'video' });
  requireThat('adopcion:catalog:filtro', videoOnly.entries.length === 2, 'filtro kind=video debe dejar 2 entries (una por revisión)');

  // CLI JSON surface over the same workspace (pairs → internal verbs).
  const cliChecks: Array<{ args: string[]; expect: (data: unknown) => boolean }> = [
    {
      args: ['project', 'list', '--workspace', workspaceDir, '--json'],
      expect: (data) => Array.isArray(data) && data.length === 2,
    },
    {
      args: ['asset', 'inspect', demo.assets.cover.assetId, '--project', demo.projectIds.shared, '--workspace', workspaceDir, '--json'],
      expect: (data) => {
        const inspection = recordWithField(data, 'asset');
        const asset = inspection === null ? null : recordWithField(inspection.asset, 'id');
        return asset?.id === demo.assets.cover.assetId;
      },
    },
    {
      args: ['asset', 'history', demo.assets.video.assetId, '--project', demo.projectIds.solo, '--workspace', workspaceDir, '--json'],
      expect: (data) => Array.isArray(data) && data.length === 2,
    },
    {
      args: ['preset', 'list', '--workspace', workspaceDir, '--json'],
      expect: (data) => Array.isArray(data) && data.length === 3,
    },
  ];
  for (const check of cliChecks) {
    const run = await runCliJson(check.args);
    requireThat(`cli:${check.args.slice(1, 4).join(' ')}`, run.exitCode === 0 && check.expect(run.data), `exit ${run.exitCode}`);
    result.cliExitCodes.push({ args: check.args.join(' '), exitCode: run.exitCode });
  }

  await rm(tempRoot, { recursive: true, force: true });
  return result;
}

// ---------------------------------------------------------------------------
// 4. Ephemeral dashboard smoke (machine-local, always stopped)
// ---------------------------------------------------------------------------

interface DashboardSmoke {
  healthOk: boolean;
  catalogOk: boolean;
  assetApiOk: boolean;
  imageServedSha: string;
  imageShaMatches: boolean;
  videoContentType: string;
  videoServed: boolean;
  cspPresent: boolean;
  port: number;
  stopped: boolean;
}

async function runDashboardSmoke(): Promise<DashboardSmoke> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cw-dash-'));
  const workspaceDir = path.join(tempRoot, 'workspace');
  const demo = await buildDemoWorkspace(workspaceDir, { projectIds: { shared: 'shared-showcase', solo: 'solo-workshop' } });
  const smoke: DashboardSmoke = {
    healthOk: false,
    catalogOk: false,
    assetApiOk: false,
    imageServedSha: '',
    imageShaMatches: false,
    videoContentType: '',
    videoServed: false,
    cspPresent: false,
    port: 0,
    stopped: false,
  };
  const server = await startDashboardServer({ workspaceDir, host: '127.0.0.1', port: 0, access: 'internal' });
  smoke.port = server.port;
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${base}/health`);
    const healthBody = recordWithField(await health.json(), 'ok');
    smoke.healthOk = health.status === 200 && healthBody?.ok === true;

    const catalogResponse = await fetch(`${base}/api/catalog`);
    const catalogEnvelope = recordWithField(await catalogResponse.json(), 'data');
    const catalogData = catalogEnvelope === null ? null : recordWithField(catalogEnvelope.data, 'entries');
    const entries = catalogData?.entries;
    smoke.catalogOk = catalogResponse.status === 200 && catalogEnvelope?.ok === true && Array.isArray(entries) && entries.length === 4;

    const assetResponse = await fetch(`${base}/api/assets/${demo.projectIds.solo}/${demo.assets.video.assetId}`);
    smoke.assetApiOk = assetResponse.status === 200;

    // Sealed copies served by declared output name, not mutable latest.
    const coverFeed = demo.assets.cover.r1.manifest.files.find((file) => file.path === 'outputs/feed.png');
    const imageResponse = await fetch(
      `${base}/api/files/${demo.projectIds.shared}/${demo.assets.cover.assetId}/${demo.assets.cover.r1.revisionId}/feed`,
    );
    const imageBytes = new Uint8Array(await imageResponse.arrayBuffer());
    smoke.imageServedSha = await sha256Bytes(imageBytes);
    smoke.imageShaMatches = imageResponse.status === 200 && coverFeed !== undefined && smoke.imageServedSha === coverFeed.sha256;

    const videoResponse = await fetch(
      `${base}/api/files/${demo.projectIds.solo}/${demo.assets.video.assetId}/${demo.assets.video.r1.revisionId}/hello`,
    );
    smoke.videoContentType = videoResponse.headers.get('content-type') ?? '';
    smoke.videoServed = videoResponse.status === 200 && smoke.videoContentType.startsWith('video/');

    const uiResponse = await fetch(base);
    smoke.cspPresent = (uiResponse.headers.get('content-security-policy') ?? '').length > 0 && (catalogResponse.headers.get('content-security-policy') ?? '').length > 0;
  } finally {
    await server.stop();
    smoke.stopped = true;
    await rm(tempRoot, { recursive: true, force: true });
  }
  requireThat('dashboard:health', smoke.healthOk, '/health no respondió ok');
  requireThat('dashboard:catalog', smoke.catalogOk, '/api/catalog sin los 2 assets');
  requireThat('dashboard:asset', smoke.assetApiOk, '/api/assets del video falló');
  requireThat('dashboard:imagen-sellada', smoke.imageShaMatches, 'el PNG servido no coincide con el SHA sellado');
  requireThat('dashboard:video', smoke.videoServed, `el MP4 no se sirvió como video (${smoke.videoContentType})`);
  requireThat('dashboard:csp', smoke.cspPresent, 'CSP ausente');
  return smoke;
}

// ---------------------------------------------------------------------------
// Evidence + main
// ---------------------------------------------------------------------------

async function mergeEvidence(section: Record<string, unknown>): Promise<void> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  let current: Record<string, unknown> = {};
  if (await fileExists(EVIDENCE_FILE)) {
    current = JSON.parse(await readFile(EVIDENCE_FILE, 'utf8')) as Record<string, unknown>;
  }
  const visual = typeof current.visual === 'object' && current.visual !== null ? (current.visual as Record<string, unknown>) : {};
  const merged: Record<string, unknown> = {
    ...current,
    schemaVersion: 1,
    goal: 'G-001',
    // The visual section belongs to the coordinator/Flash pass; this worker
    // never invents screenshots or a confirmed state.
    visual: { ...visual, status: visual.status === 'confirmed' ? 'PENDING' : (visual.status ?? 'PENDING') },
    ...section,
  };
  await writeFile(EVIDENCE_FILE, `${JSON.stringify(merged, null, 2)}\n`);
}

async function main(): Promise<number> {
  const startedAt = new Date();
  console.log('[studio:verify] 1/4 fixtures + adopción no destructiva…');
  const fixtures = await checkFixtures();

  console.log('[studio:verify] 2/4 suites offline (nuevas fases + legacy relevante)…');
  const suites = await runSuites();

  console.log('[studio:verify] 3/4 demo end-to-end (snapshot/diff/restore/catálogo/CLI)…');
  const adoption = await runAdoption();

  console.log('[studio:verify] 4/4 smoke efímero del dashboard (127.0.0.1, se detiene al final)…');
  const dashboard = await runDashboardSmoke();

  const exitCode = failures.length === 0 ? 0 : 1;
  const evidence = {
    offline: {
      ranAt: startedAt.toISOString(),
      exitCode,
      command: 'bun run studio:verify',
      fixtureBytes: fixtures.fixtureBytes,
      suites: {
        required: REQUIRED_SUITES.length,
        filesRan: suites.files,
        totalTests: suites.totalTests,
        passed: suites.passed,
        failed: suites.failed,
        exitCode: suites.exitCode,
      },
      adoption,
      dashboardSmoke: { ...dashboard, url: `http://127.0.0.1:${dashboard.port} (efímero, detenido)` },
      failures,
      notes,
    },
  };
  await mergeEvidence(evidence);

  if (failures.length > 0) {
    console.error(`[studio:verify] FALLÓ con ${failures.length} problema(s):`);
    for (const failure of failures) console.error(`  - [${failure.step}] ${failure.detail}`);
    return 1;
  }
  console.log(
    `[studio:verify] OK — ${suites.passed}/${suites.totalTests} tests en ${suites.files} suites, ` +
      `2 revisiones por asset con r1 estable, restore SHA verificado, CLI JSON y dashboard smoke OK.`,
  );
  return 0;
}

const code = await main();
process.exit(code);
