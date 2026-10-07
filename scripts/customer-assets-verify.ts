/**
 * scripts/customer-assets-verify.ts — `bun run portal:verify` (P-005, offline).
 *
 * Non-vacuous staged verifier for the FULL offline walkthrough on emulated
 * D1/R2 with fake mail (gate G-cap-local; G-cap-live stays closed):
 *
 *   boot+provision → agent key + CLI adopt → invites + client logins →
 *   client upload (real JPEG) → CLI material list/pull into a REAL Studio
 *   workspace → CLI delivery-push of EXISTING sealed demo revision outputs
 *   (r1 + r2, no render/generation) → admin visibility/post/grid → client
 *   catalog/grid view (browser) + download → negatives (cross-client, MIME,
 *   path, retries, logout, revocation, hidden cascade).
 *
 * Non-vacuousness: every stage MUST record at least one assertion; any failed
 * check, missing stage or exception → exit 1 with the stage name. A stripped
 * run can never print green. Sabotage probe: `PORTAL_VERIFY_SABOTAGE=1` makes
 * the download stage compare against a deliberately wrong digest, so the run
 * MUST fail with exit 1 and leave the failed stage recorded in
 * evidence/customer-assets-portal/offline-sabotage.json (one-off proof the
 * assertions really bite; the clean run writes offline.json).
 *
 * Offline discipline: the only network is 127.0.0.1 (ephemeral `vite dev`
 * with the E2E_FIXTURE var + the CLI against that loopback origin). No cloud,
 * no deploy, no real email, no studio:verify:r2, nothing applied. The agent
 * key exists only in the CLI subprocess env and is NEVER printed, screenshotted
 * or written to evidence.
 */
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Database } from 'bun:sqlite';

import { computeRevisionRootHash } from '@videomaker/schemas';
import { createStudioContext, getRevisionManifest } from '@videomaker/studio';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import { buildDemoWorkspace, sha256File, type DemoWorkspace } from './studio-demo';

const REPO_ROOT = join(import.meta.dir, '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'customer-assets');
const E2E_DIR = join(APP_DIR, 'tests', 'e2e');
const STATE_DIR = join(E2E_DIR, '.state');
const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'customer-assets-portal');
const SHOT_DIR = join(EVIDENCE_DIR, 'p005-offline');

const SABOTAGE = process.env.PORTAL_VERIFY_SABOTAGE === '1';
const WRONG_DIGEST = 'f'.repeat(64);
const EVIDENCE_FILE = join(EVIDENCE_DIR, SABOTAGE ? 'offline-sabotage.json' : 'offline.json');

const PORT = Number(process.env.PORTAL_VERIFY_PORT ?? 4531);
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** Loopback-only CLI origin: parsePortalOrigin tolerates http on 127.0.0.1. */
const CLI_BIN = 'packages/cli/src/main.ts';

const ADMIN = 'admin@p005.fixture';
const INTEGRATOR = 'alice@p005.fixture';
const CAROL = 'carol@p005.fixture';
const BOB = 'bob@p005.fixture';

const KEY_MAIN_NAME = 'p005-integrador';
const KEY_LIMITED_NAME = 'p005-readonly';

/**
 * Fixture photo: real decodable 32x32 JPEG (embedded, deterministic). The
 * expected digest is asserted at runtime so a silently edited fixture fails
 * the run instead of shifting every hash.
 */
const PHOTO_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAgACADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCHXqJAAAAAAAAAAAAAAAf/2Q==';
const PHOTO_EXPECTED_SHA = '780255fb9015c79e8016278861ceb00730e88c6f7a72cc18be473b9e1e3698a5';
const PHOTO_BYTES: Uint8Array = Uint8Array.from(atob(PHOTO_JPEG_BASE64), (c) => c.charCodeAt(0));

function sha256(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  return hasher.digest('hex');
}

/* ---------------------------------------------------------------------------
 * Runtime narrowing helpers for the JSON boundaries (CLI envelopes + API
 * bodies). This standalone script has no zod in scope (root-level module, no
 * hoisted dependency), so isRecord here is the ONE canonical boundary guard;
 * every field read goes through the checked helpers below and no call site
 * re-guards objects.
 * ------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function jsonRecord(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function subRecord(record: Record<string, unknown> | null, field: string): Record<string, unknown> | null {
  const raw = record?.[field];
  return isRecord(raw) ? raw : null;
}

function stringField(record: Record<string, unknown> | null, field: string): string {
  const raw = record?.[field];
  return typeof raw === 'string' ? raw : '';
}

function numberField(record: Record<string, unknown> | null, field: string): number | null {
  const raw = record?.[field];
  return typeof raw === 'number' ? raw : null;
}

function recordArrayField(record: Record<string, unknown> | null, field: string): Record<string, unknown>[] {
  const raw = record?.[field];
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function stringArrayField(record: Record<string, unknown> | null, field: string): string[] {
  const raw = record?.[field];
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

/* ---------------------------------------------------------------------------
 * Stages: every stage must carry >= 1 assertion or the run fails.
 * ------------------------------------------------------------------------- */

class StageScope {
  readonly name: string;
  assertions = 0;
  ok = true;
  readonly notes: string[] = [];
  readonly failures: string[] = [];

  constructor(name: string) {
    this.name = name;
  }

  check(condition: boolean, detail: string): void {
    if (condition) {
      this.assertions += 1;
    } else {
      this.ok = false;
      this.failures.push(detail);
      this.notes.push(`FALLO: ${detail}`);
    }
  }

  note(message: string): void {
    this.notes.push(message);
  }
}

interface StageResult {
  name: string;
  ok: boolean;
  assertions: number;
  notes: string[];
}

const stages: StageResult[] = [];
const commands: { cmd: string; exit: number; code?: string; message?: string }[] = [];

async function runStage(name: string, fn: (stage: StageScope) => Promise<void>): Promise<StageScope> {
  const stage = new StageScope(name);
  try {
    await fn(stage);
  } catch (error) {
    stage.ok = false;
    stage.notes.push(`EXCEPCIÓN: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
  if (stage.assertions === 0) {
    stage.ok = false;
    stage.notes.push('etapa sin aserciones: una suite vacía nunca cuenta como evidencia');
  }
  stages.push({ name, ok: stage.ok, assertions: stage.assertions, notes: stage.notes });
  console.log(`[etapa] ${name}: ${stage.ok ? 'ok' : 'FALLO'} (${stage.assertions} aserciones)`);
  if (!stage.ok) {
    for (const detail of stage.failures) console.error(`  ↳ ${detail}`);
  }
  return stage;
}

/**
 * Targeted fixture UPDATEs against the emulated D1 (miniflare SQLite file):
 * the /api/fixture/reset endpoint DROPS every table (full reset), so narrow
 * state mutations (grant widening, expiry backdating) go straight to the same
 * SQLite database the dev server uses — offline fixture manipulation only.
 */
function fixtureSql(statements: readonly string[]): void {
  const dir = join(APP_DIR, 'tests', 'e2e', '.state', 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const files = readdirSync(dir).filter((entry) => entry.endsWith('.sqlite') && entry !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error(`D1 emulada ambigua (${files.length} archivos sqlite)`);
  const db = new Database(join(dir, files[0]!));
  try {
    for (const statement of statements) db.run(statement);
  } finally {
    db.close();
  }
}

/* ---------------------------------------------------------------------------
 * Ephemeral loopback server (same recipe as tests/e2e/server.ts, self-contained
 * so this script stays inside the root tsconfig scope).
 * ------------------------------------------------------------------------- */

interface E2eServer {
  stop(): Promise<void>;
}

async function startServer(): Promise<E2eServer> {
  rmSync(STATE_DIR, { recursive: true, force: true });
  const proc = Bun.spawn({
    cmd: [
      'bunx', 'vite', 'dev',
      '--config', 'tests/e2e/vite.config.ts',
      '--host', '127.0.0.1',
      '--port', String(PORT),
      '--strictPort',
    ],
    cwd: APP_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, E2E_PORT: String(PORT) },
  });
  const deadline = Date.now() + 120_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`vite dev exited early (${proc.exitCode}):\n${stderr.slice(-2000)}`);
    }
    try {
      const response = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(2000) });
      const body = (await jsonRecord(response)) as { d1?: boolean; r2?: boolean } | null;
      if (response.ok && body?.d1 === true && body?.r2 === true) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  if (!healthy) {
    proc.kill();
    throw new Error('vite dev did not become healthy in time');
  }
  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      proc.kill('SIGTERM');
      const gracefulDeadline = Date.now() + 10_000;
      while (proc.exitCode === null && Date.now() < gracefulDeadline) {
        await Bun.sleep(200);
      }
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await proc.exited;
    },
  };
}

/* ---------------------------------------------------------------------------
 * HTTP helpers (fixture endpoints + v1 API)
 * ------------------------------------------------------------------------- */

async function fixturePost(pathname: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await jsonRecord(response);
  if (json === null || json.ok !== true) {
    throw new Error(`fixture ${pathname} falló (${response.status})`);
  }
  return json;
}

/** Migration DDL from apps/customer-assets/migrations (comment-safe split). */
function migrationStatements(): string[] {
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

interface ApiInit {
  cookie?: string;
  apiKey?: string;
  body?: unknown;
  rawBody?: Uint8Array;
  contentType?: string;
}

async function api(
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH',
  pathname: string,
  init: ApiInit = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  if (init.apiKey !== undefined) headers['x-api-key'] = init.apiKey;
  if (init.contentType !== undefined) headers['content-type'] = init.contentType;
  else if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${ORIGIN}${pathname}`, {
    method,
    headers,
    body: (init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body))) as BodyInit,
  });
}

/* ---------------------------------------------------------------------------
 * Browser helpers (playwright-core + cached chromium, loopback only)
 * ------------------------------------------------------------------------- */

async function launchBrowser(): Promise<{ browser: Browser; close(): Promise<void> }> {
  const cacheRoot = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  let executablePath: string | undefined;
  const versions = readdirSync(cacheRoot)
    .filter((entry) => entry.startsWith('chromium-'))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const version of versions) {
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const candidate = join(cacheRoot, version, sub, 'chrome');
      try {
        statSync(candidate);
        executablePath = candidate;
        break;
      } catch {
        /* try next layout */
      }
    }
    if (executablePath !== undefined) break;
  }
  if (executablePath === undefined) throw new Error(`no cached chromium under ${cacheRoot}`);
  const browser = await chromium.launch({ executablePath, headless: true });
  return { browser, close: () => browser.close() };
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ ignoreHTTPSErrors: false });
}

/** Signs a persona in through the REAL Better Auth magic-link machinery. */
async function loginPersona(context: BrowserContext, email: string, callbackURL: string): Promise<void> {
  const result = await fixturePost('/api/fixture/session', { email, callbackURL });
  const verifyUrl = stringField(result, 'verifyUrl');
  const page = await context.newPage();
  try {
    await page.goto(verifyUrl, { waitUntil: 'load' });
  } finally {
    await page.close();
  }
}

async function cookieOf(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(ORIGIN);
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function goto(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
  } catch {
    await page.waitForTimeout(1500);
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
  }
  const body = await page.textContent('body');
  if (body !== null && body.trimStart().startsWith('{"status"')) {
    await page.waitForTimeout(1500);
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
  }
}

async function waitContent(page: Page, selector: string, timeout = 20_000): Promise<void> {
  await page.waitForSelector(selector, { state: 'visible', timeout });
}

/**
 * Navigation + selector with ONE reload retry: the dev server compiles routes
 * on demand and a first hit can transiently render an error/redirect page;
 * a reload after a settle delay recovers it (same recipe as P-004's goto).
 */
async function gotoWait(page: Page, url: string, selector: string, timeout = 20_000): Promise<void> {
  await goto(page, url);
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
  } catch {
    await page.waitForTimeout(1500);
    await goto(page, url);
    await page.waitForSelector(selector, { state: 'visible', timeout });
  }
}

const screenshots: { name: string; path: string; bytes: number }[] = [];

async function shoot(page: Page, name: string): Promise<void> {
  const abs = join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: abs, fullPage: false });
  screenshots.push({
    name: `${name}.png`,
    path: `evidence/customer-assets-portal/p005-offline/${name}.png`,
    bytes: statSync(abs).size,
  });
}

/* ---------------------------------------------------------------------------
 * CLI subprocess runner (envelope-checked; key travels ONLY in env)
 * ------------------------------------------------------------------------- */

interface CliOutcome {
  exit: number;
  ok: boolean;
  data: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
}

async function runCli(args: string[], apiKey?: string): Promise<CliOutcome> {
  const cmd = `bun ${CLI_BIN} ${args.join(' ')}`;
  const proc = Bun.spawn(['bun', CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    env: apiKey === undefined ? { ...process.env } : { ...process.env, CUSTOMER_ASSETS_API_KEY: apiKey },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  let envelope: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (isRecord(parsed)) envelope = parsed;
  } catch {
    envelope = null;
  }
  if (envelope === null || numberField(envelope, 'schemaVersion') !== 1) {
    throw new Error(`CLI sin envelope JSON schemaVersion 1 en: ${cmd} — stderr: ${stderr.slice(-300)}`);
  }
  const ok = envelope.ok === true;
  const error = ok ? null : subRecord(envelope, 'error');
  commands.push(ok
    ? { cmd, exit }
    : { cmd, exit, code: stringField(error, 'code'), message: stringField(error, 'message').slice(0, 200) });
  return {
    exit,
    ok,
    data: ok ? subRecord(envelope, 'data') : null,
    error,
  };
}

function pageItems(outcome: CliOutcome): Record<string, unknown>[] {
  return recordArrayField(outcome.data, 'items');
}

/* ---------------------------------------------------------------------------
 * Globals shared across stages
 * ------------------------------------------------------------------------- */

let server: E2eServer | null = null;
let tmpRoot: string | null = null;
let workspaceDir: string | null = null;
let demo: DemoWorkspace | null = null;
const browserCtxs: BrowserContext[] = [];

let workspaceId = '';
let bfcClientId = '';
let secondClientId = '';
let agentKey = '';
let limitedKey = '';
let adminCookie = '';
let carolCookie = '';
let bobCookie = '';

let materialId = '';
let deliveryR1 = '';
let deliveryR2 = '';
let assetIdR1 = '';
let assetIdR2 = '';
let postId = '';

const photoSha = sha256(PHOTO_BYTES);
const hashes: Record<string, string> = {};

/**
 * R-3 guest fixtures (embedded, deterministic): a real 1x1 PNG plus a
 * byte-flipped variant (same valid magic, distinct sha256) so the two guest
 * uploads are genuinely different materials.
 */
const REQUEST_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const REQUEST_PNG_BYTES: Uint8Array = Uint8Array.from(atob(REQUEST_PNG_BASE64), (c) => c.charCodeAt(0));
const REQUEST_PNG_VARIANT_BYTES: Uint8Array = (() => {
  const bytes = new Uint8Array(REQUEST_PNG_BYTES);
  bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x5a;
  return bytes;
})();
const requestPngSha = sha256(REQUEST_PNG_BYTES);
const requestVariantSha = sha256(REQUEST_PNG_VARIANT_BYTES);

/** R-3 state shared by the requests stage and the evidence writer. */
const requestSecrets: string[] = []; // guest capability tokens + the requests agent key (NEVER logged)
let requestsAgentKey = '';
let requestProjectBfc = '';
let requestProjectSecond = '';
let requestIdMain = '';
let guestTokenMain = '';
let requestIdClose = '';
let guestTokenClose = '';
let requestIdExpiry = '';
let guestTokenExpiry = '';

/* ---------------------------------------------------------------------------
 * Stages
 * ------------------------------------------------------------------------- */

async function stagePreflight(stage: StageScope): Promise<void> {
  stage.check(PHOTO_BYTES.length > 0, 'fixture photo.jpg presente');
  stage.check(photoSha === PHOTO_EXPECTED_SHA, 'fixture photo.jpg coincide con su sha256 documentado');
  stage.check(Number.isFinite(PORT) && PORT > 0, `puerto efímero configurado (${PORT})`);
}

async function stageBoot(stage: StageScope): Promise<void> {
  server = await startServer();
  const health = await fetch(`${ORIGIN}/api/health`);
  const healthBody = (await jsonRecord(health)) as { d1?: boolean; r2?: boolean } | null;
  stage.check(health.ok && healthBody?.d1 === true && healthBody?.r2 === true, 'servidor efímero sano con D1 y R2 emulados');

  await fixturePost('/api/fixture/reset', { statements: migrationStatements() });
  stage.note('migraciones 0001_auth + 0002_portal aplicadas a D1 emulado (estado fresco)');

  const provisioned = await fixturePost('/api/fixture/provision', {
    users: [
      { email: ADMIN, name: 'Portal Admin', role: 'admin' },
      { email: INTEGRATOR, name: 'Alice Integradora', role: 'member' },
      { email: CAROL, name: 'Carol Cliente', role: 'member' },
      { email: BOB, name: 'Bob Cliente', role: 'member' },
    ],
    workspaceLabel: 'P-005 Portal Verify Workspace',
    integratorEmail: INTEGRATOR,
    clients: [{ studioClientId: 'bfc', name: 'BFC (adopción demo)' }],
    memberships: [],
  });
  workspaceId = stringField(provisioned, 'workspaceId');
  const seededClients = recordArrayField(provisioned, 'clients');
  bfcClientId = stringField(seededClients[0] ?? null, 'id');
  stage.check(workspaceId.length > 0, 'workspace portal provisionado con integrador alice');
  stage.check(bfcClientId.length > 0, 'cliente portal bfc proyectado por provisioning controlado');
  stage.check(seededClients.length === 1, 'exactamente un cliente semilla (second-brand lo adopta el CLI)');

  // Prewarm: the dev server compiles routes on demand; warm every page the
  // walkthrough will open so late-run browser navigations never stall on a
  // first compile (GET only; auth redirects are expected and fine here).
  for (const route of ['/', '/login', '/portal', '/admin/clients', `/portal/${bfcClientId}/materials`, `/portal/${bfcClientId}/assets`, `/portal/${bfcClientId}/instagram`, `/admin/clients/${bfcClientId}/access`]) {
    await fetch(`${ORIGIN}${route}`, { signal: AbortSignal.timeout(120_000) }).catch(() => undefined);
  }
  stage.note('rutas UI precalentadas (compilación on-demand del dev server)');
  stage.note('entorno: D1/R2 miniflare locales, mail fake sink, servidor loopback 127.0.0.1 only');
}

async function stageKeyAdopt(stage: StageScope): Promise<void> {
  tmpRoot = await mkdtemp(join(tmpdir(), 'p005-portal-verify-'));
  workspaceDir = join(tmpRoot, 'workspace');
  demo = await buildDemoWorkspace(workspaceDir, { projectIds: { shared: 'demo-shared', solo: 'demo-solo' } });
  stage.note(
    `workspace Studio real (revisiones selladas r1/r2 existentes, sin render): ${demo.assets.cover.r1.revisionId} / ${demo.assets.cover.r2.revisionId}`,
  );

  const browser = await launchBrowser();
  try {
    const adminCtx = await newContext(browser.browser);
    browserCtxs.push(adminCtx);
    await loginPersona(adminCtx, ADMIN, '/admin/clients');
    adminCookie = await cookieOf(adminCtx);
    stage.check(adminCookie.length > 0, 'sesión admin real (magic link con sink fake) emitida');

    const page = await adminCtx.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoWait(page, `${ORIGIN}/admin/clients/${bfcClientId}/access`, '[data-testid="access-tab"]');
    // Screenshot BEFORE any key exists on the page (never capture secrets).
    await shoot(page, 'desktop-admin-access-p005');

    const issueKey = async (keyName: string, scopes: string[], workspaceWide: boolean): Promise<string> => {
      await page.fill('[data-testid="agent-key-form"] input[name="agent-email"]', INTEGRATOR);
      await page.fill('[data-testid="agent-key-form"] input[name="agent-key-name"]', keyName);
      for (const scope of ['clients:read', 'clients:write', 'materials:read', 'materials:write', 'deliveries:read', 'deliveries:write']) {
        const box = page.locator(`input[aria-label="Scope ${scope}"]`);
        if (scopes.includes(scope)) await box.check();
        else await box.uncheck();
      }
      const wide = page.locator('input[aria-label="Grant de todo el workspace"]');
      if (workspaceWide) await wide.check();
      else await wide.uncheck();
      await page.click('[data-testid="agent-key-form"] button[type="submit"]');
      await page.waitForFunction(
        (previous) => {
          const pre = document.querySelector('[data-testid="issued-key"] pre');
          return pre !== null && pre.textContent !== null && pre.textContent.trim().length > 0 && pre.textContent.trim() !== previous;
        },
        agentKey,
        { timeout: 20_000 },
      );
      return (await page.textContent('[data-testid="issued-key"] pre'))?.trim() ?? '';
    };

    agentKey = await issueKey(KEY_MAIN_NAME, ['clients:read', 'clients:write', 'materials:read', 'deliveries:read', 'deliveries:write'], true);
    stage.check(agentKey.length >= 16 && !/\s/.test(agentKey), 'key de integrador emitida por el flujo admin UI (se muestra una sola vez)');
    stage.check(!agentKey.includes('@'), 'la key emitida no contiene el email del agente');

    limitedKey = await issueKey(KEY_LIMITED_NAME, ['materials:read'], false);
    stage.check(limitedKey.length >= 16 && limitedKey !== agentKey, 'segunda key (materials:read, scope de un solo cliente) emitida para negativas');
  } finally {
    await browser.close();
  }

  const me = await runCli(['portal-auth-status', '--origin', ORIGIN, '--json'], agentKey);
  stage.check(me.exit === 0 && me.ok, 'portal-auth-status con la key de integrador responde ok');
  const principal = subRecord(me.data, 'principal');
  stage.check(stringField(principal, 'kind') === 'agent', `principal agente reconocido (${stringField(principal, 'kind')})`);
  const scopes = stringOrArrayScope(principal);
  stage.check(
    ['clients:write', 'materials:read', 'deliveries:write'].every((scope) => scopes.includes(scope)),
    'scopes server-side del grant visibles en /me',
  );

  const adoptBfc = await runCli([
    'portal-client-adopt', 'bfc',
    '--workspace', workspaceDir!,
    '--workspace-id', workspaceId,
    '--origin', ORIGIN,
    '--execute', '--json',
  ], agentKey);
  stage.check(adoptBfc.exit === 0 && adoptBfc.ok, 'portal-client-adopt bfc exitoso');
  const bfcPortal = subRecord(adoptBfc.data, 'portalClient');
  stage.check(stringField(bfcPortal, 'studioClientId') === 'bfc', 'proyección adoptada referencia el studio client bfc');
  stage.check(stringField(bfcPortal, 'id') === bfcClientId, 'readoptar un cliente ya proyectado NO duplica filas (misma id)');

  const adoptSecond = await runCli([
    'portal-client-adopt', 'second-brand',
    '--workspace', workspaceDir!,
    '--workspace-id', workspaceId,
    '--origin', ORIGIN,
    '--execute', '--json',
  ], agentKey);
  stage.check(adoptSecond.exit === 0 && adoptSecond.ok, 'portal-client-adopt second-brand crea la proyección vía CLI');
  const secondPortal = subRecord(adoptSecond.data, 'portalClient');
  secondClientId = stringField(secondPortal, 'id');
  stage.check(secondClientId.length > 0 && stringField(secondPortal, 'studioClientId') === 'second-brand', 'segundo cliente adoptado con studioClientId second-brand');

  const list = await runCli(['portal-client-list', '--origin', ORIGIN, '--json'], agentKey);
  stage.check(list.exit === 0 && pageItems(list).length === 2, `portal-client-list ve exactamente 2 clientes (${pageItems(list).length})`);
}

/** /me scopes may arrive as a string[]; narrow without casting. */
function stringOrArrayScope(record: Record<string, unknown> | null): string[] {
  const raw = record?.['scopes'];
  if (Array.isArray(raw)) return raw.filter((entry): entry is string => typeof entry === 'string');
  return [];
}

async function stageInviteLogin(stage: StageScope): Promise<void> {
  const browser = await launchBrowser();
  try {
    const adminCtx = await newContext(browser.browser);
    browserCtxs.push(adminCtx);
    await loginPersona(adminCtx, ADMIN, '/admin/clients');
    const adminPage = await adminCtx.newPage();

    await gotoWait(adminPage, `${ORIGIN}/admin/clients/${bfcClientId}/access`, '[data-testid="invite-form"]');
    await adminPage.fill('[data-testid="invite-form"] input[name="invite-email"]', CAROL);
    await adminPage.click('[data-testid="invite-form"] button[type="submit"]');
    await waitContent(adminPage, '[data-testid="invitation-table"]');
    stage.check((await adminPage.textContent('body'))?.includes(CAROL) === true, 'invitación a carol creada por el admin UI');

    await gotoWait(adminPage, `${ORIGIN}/admin/clients/${secondClientId}/access`, '[data-testid="invite-form"]');
    await adminPage.fill('[data-testid="invite-form"] input[name="invite-email"]', BOB);
    await adminPage.click('[data-testid="invite-form"] button[type="submit"]');
    await waitContent(adminPage, '[data-testid="invitation-table"]');
    stage.check((await adminPage.textContent('body'))?.includes(BOB) === true, 'invitación a bob creada en el segundo cliente');

    const carolCtx = await newContext(browser.browser);
    browserCtxs.push(carolCtx);
    await loginPersona(carolCtx, CAROL, '/portal');
    const carolPage = await carolCtx.newPage();
    await gotoWait(carolPage, `${ORIGIN}/portal`, '[data-testid="client-picker"], [data-testid="upload-card"]');
    carolCookie = await cookieOf(carolCtx);
    stage.check(carolCookie.length > 0, 'carol inició sesión con magic link fake');

    const bobCtx = await newContext(browser.browser);
    browserCtxs.push(bobCtx);
    await loginPersona(bobCtx, BOB, '/portal');
    const bobPage = await bobCtx.newPage();
    await gotoWait(bobPage, `${ORIGIN}/portal`, '[data-testid="client-picker"], [data-testid="upload-card"]');
    bobCookie = await cookieOf(bobCtx);
    stage.check(bobCookie.length > 0, 'bob inició sesión con magic link fake');
  } finally {
    await browser.close();
  }

  const carolClients = await jsonRecord(await api('GET', '/api/v1/clients', { cookie: carolCookie }));
  const carolItems = recordArrayField(carolClients, 'items');
  stage.check(carolItems.length === 1 && stringField(carolItems[0] ?? null, 'id') === bfcClientId, 'carol ve exactamente su cliente (membresía activada al entrar al portal)');
  const bobClients = await jsonRecord(await api('GET', '/api/v1/clients', { cookie: bobCookie }));
  const bobItems = recordArrayField(bobClients, 'items');
  stage.check(bobItems.length === 1 && stringField(bobItems[0] ?? null, 'id') === secondClientId, 'bob ve exactamente el segundo cliente');
}

async function stageClientUpload(stage: StageScope): Promise<void> {
  const browser = await launchBrowser();
  try {
    const carolCtx = await newContext(browser.browser);
    browserCtxs.push(carolCtx);
    await loginPersona(carolCtx, CAROL, '/portal');
    const page = await carolCtx.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoWait(page, `${ORIGIN}/portal/${bfcClientId}/materials`, '[data-testid="upload-card"]');
    await page.setInputFiles('input[type="file"]', {
      name: 'photo.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.from(PHOTO_BYTES),
    });
    await waitContent(page, '[data-testid="material-row"]', 30_000);
    stage.check((await page.textContent('[data-testid="materials-list"]'))?.includes('photo.jpg') === true, 'subida REAL por UI: photo.jpg aparece como material ready');
    await shoot(page, 'mobile-materials-p005');
  } finally {
    await browser.close();
  }

  const list = await jsonRecord(await api('GET', `/api/v1/clients/${bfcClientId}/materials`, { cookie: carolCookie }));
  const items = recordArrayField(list, 'items');
  stage.check(items.length === 1, `exactamente 1 material registrado (${items.length})`);
  const material = items[0] ?? null;
  materialId = stringField(material, 'id');
  stage.check(materialId.length > 0, 'material con id registrado');
  stage.check(stringField(material, 'name') === 'photo.jpg', `nombre original display preservado (${stringField(material, 'name')})`);
  stage.check(stringField(material, 'mediaType') === 'image/jpeg' && stringField(material, 'status') === 'ready', 'material detectado image/jpeg y en estado ready');
  stage.check(numberField(material, 'bytes') === PHOTO_BYTES.length, `bytes registrados == bytes subidos (${String(numberField(material, 'bytes'))})`);
  stage.check(stringField(material, 'sha256') === photoSha, `sha256 registrado == sha256 subido (${stringField(material, 'sha256').slice(0, 12)}…)`);
  hashes.materialPhotoUploaded = photoSha;
  hashes.materialPhotoRegistered = stringField(material, 'sha256');

  const content = await api('GET', `/api/v1/materials/${materialId}/content`, { cookie: carolCookie });
  stage.check(content.status === 200, 'la cliente puede releer su propio material (200)');
  stage.check(content.headers.get('x-content-type-options') === 'nosniff', 'respuesta de contenido con nosniff');
  const downloaded = new Uint8Array(await content.arrayBuffer());
  hashes.materialPhotoReadBack = sha256(downloaded);
  stage.check(hashes.materialPhotoReadBack === photoSha, 'bytes releídos por la cliente == bytes subidos');
}

async function stageMaterialPull(stage: StageScope): Promise<void> {
  const list = await runCli(['portal-material-list', '--client', bfcClientId, '--origin', ORIGIN, '--json'], agentKey);
  stage.check(list.exit === 0 && pageItems(list).length === 1, 'portal-material-list pagina el material del cliente');
  const listed = pageItems(list)[0] ?? null;
  stage.check(stringField(listed, 'id') === materialId && stringField(listed, 'sha256') === photoSha, 'el material listado por CLI es el que subió la cliente (id + sha)');

  const show = await runCli(['portal-material-show', materialId, '--origin', ORIGIN, '--json'], agentKey);
  stage.check(show.exit === 0 && stringField(show.data, 'sha256') === photoSha, 'portal-material-show confirma el sha256 registrado');

  const pull = await runCli([
    'portal-material-pull', materialId,
    '--project', 'demo-shared',
    '--asset', 'bfc-cover',
    '--workspace', workspaceDir!,
    '--origin', ORIGIN,
    '--execute', '--json',
  ], agentKey);
  stage.check(pull.exit === 0 && pull.ok, 'portal-material-pull importa el material como input del asset abierto');
  const inputPath = stringField(pull.data, 'inputPath');
  const provenancePath = stringField(pull.data, 'provenancePath');
  const addedInputs = stringArrayField(pull.data, 'addedInputs');
  stage.check(inputPath.startsWith('inputs/portal/') && inputPath.endsWith('.jpg'), `input registrado en ${inputPath}`);
  stage.check(provenancePath.endsWith('.provenance.json'), `sidecar de provenance en ${provenancePath}`);
  stage.check(addedInputs.length === 2, `primera importación añade input + sidecar (${addedInputs.length} entradas)`);
  stage.check(pull.data?.reusedBytes === false, 'primera importación reporta reusedBytes=false');

  const assetDir = join(workspaceDir!, 'projects', 'demo-shared', 'assets', 'bfc-cover');
  const inputBytes = new Uint8Array(await readFile(join(assetDir, inputPath)));
  hashes.materialPhotoImported = sha256(inputBytes);
  stage.check(hashes.materialPhotoImported === photoSha, 'bytes importados al workspace == bytes subidos (cadena de hash)');

  const provenance = parseJsonRecord(await readFile(join(assetDir, provenancePath), 'utf8')) ?? {};
  stage.check(
    stringField(provenance, 'source') === 'portal' && stringField(provenance, 'materialId') === materialId && stringField(provenance, 'sha256') === photoSha,
    'sidecar registra origen portal + material + sha sin credenciales',
  );
  stage.check(stringField(provenance, 'studioClientId') === 'bfc', 'sidecar mantiene la relación con el studio client');
  const provenanceText = JSON.stringify(provenance);
  stage.check(!provenanceText.includes('CUSTOMER_ASSETS_API_KEY') && !provenanceText.includes(agentKey), 'el sidecar NO contiene la key ni credenciales');

  const assetDoc = parseJsonRecord(await readFile(join(assetDir, 'asset.json'), 'utf8')) ?? {};
  stage.check(
    assetDocInputsInclude(assetDoc, inputPath) && assetDocInputsInclude(assetDoc, provenancePath),
    'asset.json abierto registra input + provenance',
  );

  // Plan mode must be a pure plan: zero writes.
  const inputsDirBefore = await readdir(join(assetDir, 'inputs', 'portal'));
  const assetInputsBefore = await assetDocInputsCount(assetDir);
  const plan = await runCli([
    'portal-material-pull', materialId,
    '--project', 'demo-shared',
    '--asset', 'bfc-cover',
    '--workspace', workspaceDir!,
    '--origin', ORIGIN,
    '--json',
  ], agentKey);
  stage.check(plan.exit === 0 && plan.data?.executed === false, 'sin --execute el pull imprime SOLO el plan (executed=false)');
  stage.check(recordArrayField(plan.data, 'plan').length > 0, 'el plan enumera pasos concretos');
  const inputsDirAfterPlan = await readdir(join(assetDir, 'inputs', 'portal'));
  const assetInputsAfterPlan = await assetDocInputsCount(assetDir);
  stage.check(
    inputsDirAfterPlan.length === inputsDirBefore.length && assetInputsAfterPlan === assetInputsBefore,
    'el plan no escribió nada (plan sin red ni escritura)',
  );

  // Retry converges without duplicates.
  const retry = await runCli([
    'portal-material-pull', materialId,
    '--project', 'demo-shared',
    '--asset', 'bfc-cover',
    '--workspace', workspaceDir!,
    '--origin', ORIGIN,
    '--execute', '--json',
  ], agentKey);
  stage.check(retry.exit === 0 && retry.data?.reusedBytes === true, 'reintento de pull reutiliza los bytes verificados');
  stage.check(stringArrayField(retry.data, 'addedInputs').length === 0, 'reintento no añade inputs nuevos');
  const inputsDirAfterRetry = await readdir(join(assetDir, 'inputs', 'portal'));
  stage.check(inputsDirAfterRetry.length === 2 && inputsDirBefore.length === 2, `sin archivos duplicados en inputs/portal (${inputsDirAfterRetry.length} archivos)`);
}

function assetDocInputsInclude(assetDoc: Record<string, unknown>, relPath: string): boolean {
  return stringArrayField(assetDoc, 'inputs').includes(relPath);
}

async function assetDocInputsCount(assetDir: string): Promise<number> {
  const doc = parseJsonRecord(await readFile(join(assetDir, 'asset.json'), 'utf8')) ?? {};
  return stringArrayField(doc, 'inputs').length;
}

async function stageDeliveryPush(stage: StageScope): Promise<void> {
  const r1 = demo!.assets.cover.r1;
  const r2 = demo!.assets.cover.r2;
  const assetDir = join(workspaceDir!, 'projects', 'demo-shared', 'assets', 'bfc-cover');
  const workingFeed = join(assetDir, 'outputs', 'feed.png');
  const sealedR1Feed = join(workspaceDir!, 'revisions', 'demo-shared', 'bfc-cover', r1.revisionId, 'files', 'outputs', 'feed.png');

  const feedRef = r1.manifest.outputs.find((output) => output.name === 'feed');
  const feedFile = feedRef === undefined ? undefined : r1.manifest.files.find((file) => file.path === feedRef.path);
  const feedR1Sha = feedFile?.sha256 ?? '';
  stage.check(feedRef !== undefined && feedFile?.role === 'output' && feedFile.mediaType === 'image/png', 'output feed declarado en el manifest r1 como archivo sellado role=output image/png');
  hashes.outputFeedR1Manifest = feedR1Sha;
  stage.check(await sha256File(sealedR1Feed) === feedR1Sha, 'la copia sellada de r1 bajo revisions/ coincide byte a byte con el manifest');

  const pushArgs = (revisionId: string): string[] => [
    'portal-delivery-push',
    '--workspace', workspaceDir!,
    '--client', bfcClientId,
    '--project', 'demo-shared',
    '--asset', 'bfc-cover',
    '--revision', revisionId,
    '--outputs', 'feed',
    '--origin', ORIGIN,
  ];

  // Negative: the demo build leaves the r2 bytes in the working tree, so
  // pushing r1 WITHOUT restoring must be refused (no implicit recovery).
  const stale = await runCli([...pushArgs(r1.revisionId), '--execute', '--json'], agentKey);
  stage.check(stale.exit !== 0 && !stale.ok && stringField(stale.error, 'code') === 'HASH_MISMATCH', 'push r1 con bytes de trabajo alterados: rechazado HASH_MISMATCH (nunca recupera implícito)');

  // Explicit restore through the existing Studio flow (asset-restore), then
  // the operator places the verified bytes back into the working tree.
  const restoreDir1 = await mkdtemp(join(tmpdir(), 'p005-restore-r1-'));
  const restore1 = await runCli(['asset-restore', 'bfc-cover', '--project', 'demo-shared', '--revision', r1.revisionId, '--out', restoreDir1, '--workspace', workspaceDir!, '--json']);
  stage.check(restore1.exit === 0 && restore1.ok, 'asset-restore r1 restaura los hashes exactos (flujo Studio existente, sin render)');
  const restoredFeed1 = join(restoreDir1, 'outputs', 'feed.png');
  stage.check(await sha256File(restoredFeed1) === feedR1Sha, 'los bytes restaurados de r1 verifican contra el manifest sellado');
  await mkdir(dirname(workingFeed), { recursive: true });
  await copyFile(restoredFeed1, workingFeed);

  const push1 = await runCli([...pushArgs(r1.revisionId), '--execute', '--json'], agentKey);
  stage.check(push1.exit === 0 && push1.ok, 'portal-delivery-push r1 entrega el output elegido');
  const delivery1 = subRecord(push1.data, 'delivery');
  deliveryR1 = stringField(delivery1, 'id');
  stage.check(stringField(delivery1, 'status') === 'ready', `entrega r1 en estado ${stringField(delivery1, 'status')}`);
  stage.check(stringField(delivery1, 'rootHash') === r1.rootHash, 'rootHash transmitido == rootHash sellado de la revisión (verificado por el bridge)');
  const pushed1 = recordArrayField(push1.data, 'outputs');
  stage.check(pushed1.length === 1 && stringField(pushed1[0] ?? null, 'sha256') === feedR1Sha, 'solo el output elegido viaja, con su sha exacto');
  hashes.outputFeedR1Delivered = stringField(pushed1[0] ?? null, 'sha256');

  const assetsAfterFirst = await jsonRecord(await api('GET', `/api/v1/clients/${bfcClientId}/assets`, { cookie: adminCookie }));
  const assets1 = recordArrayField(assetsAfterFirst, 'items');
  stage.check(assets1.length === 1 && stringField(assets1[0] ?? null, 'deliveryId') === deliveryR1, 'un solo client asset para r1 tras el primer push');
  assetIdR1 = stringField(assets1[0] ?? null, 'id');

  const retryPush = await runCli([...pushArgs(r1.revisionId), '--execute', '--json'], agentKey);
  stage.check(retryPush.exit === 0 && retryPush.ok, 'reintento de delivery-push responde ok (staging idempotente)');
  stage.check(stringField(subRecord(retryPush.data, 'delivery'), 'id') === deliveryR1, 'reintento converge a la MISMA entrega (sin filas duplicadas)');
  const assetsRetry = await jsonRecord(await api('GET', `/api/v1/clients/${bfcClientId}/assets`, { cookie: adminCookie }));
  stage.check(recordArrayField(assetsRetry, 'items').length === 1, 'el reintento no duplicó assets ni entregas');

  const planPush = await runCli([...pushArgs(r1.revisionId), '--json'], agentKey);
  stage.check(planPush.exit === 0 && planPush.data?.executed === false, 'delivery-push sin --execute es solo plan (sin red ni escritura)');
  const assetsPlan = await jsonRecord(await api('GET', `/api/v1/clients/${bfcClientId}/assets`, { cookie: adminCookie }));
  stage.check(recordArrayField(assetsPlan, 'items').length === 1, 'el plan de entrega no creó recursos');

  // r2 fixture work: the demo's SECOND existing sealed revision. The working
  // tree holds r1 bytes now, so the same stale-bytes refusal applies first.
  const stale2 = await runCli([...pushArgs(r2.revisionId), '--execute', '--json'], agentKey);
  stage.check(stale2.exit !== 0 && !stale2.ok && stringField(stale2.error, 'code') === 'HASH_MISMATCH', 'push r2 sobre bytes de r1: rechazado HASH_MISMATCH');
  const restoreDir2 = await mkdtemp(join(tmpdir(), 'p005-restore-r2-'));
  const restore2 = await runCli(['asset-restore', 'bfc-cover', '--project', 'demo-shared', '--revision', r2.revisionId, '--out', restoreDir2, '--workspace', workspaceDir!, '--json']);
  stage.check(restore2.exit === 0 && restore2.ok, 'asset-restore r2 restaura los bytes de la segunda revisión');
  await copyFile(join(restoreDir2, 'outputs', 'feed.png'), workingFeed);

  const push2 = await runCli([...pushArgs(r2.revisionId), '--execute', '--json'], agentKey);
  const delivery2 = subRecord(push2.data, 'delivery');
  stage.check(push2.exit === 0 && stringField(delivery2, 'status') === 'ready', 'delivery-push r2 (trabajo fixture posterior) entregado');
  deliveryR2 = stringField(delivery2, 'id');
  stage.check(deliveryR2 !== deliveryR1 && stringField(delivery2, 'rootHash') === r2.rootHash, 'r2 es una entrega DISTINTA con el rootHash de r2');
  const pushed2 = recordArrayField(push2.data, 'outputs');
  hashes.outputFeedR2Delivered = stringField(pushed2[0] ?? null, 'sha256');
  stage.check(hashes.outputFeedR2Delivered !== feedR1Sha, 'los bytes de r2 difieren de r1 (fixtures reales distintos)');

  const assetsAfterR2 = await jsonRecord(await api('GET', `/api/v1/clients/${bfcClientId}/assets`, { cookie: adminCookie }));
  const assets2 = recordArrayField(assetsAfterR2, 'items');
  stage.check(assets2.length === 2, 'dos assets (r1 y r2) tras el trabajo r2');
  assetIdR2 = stringField(assets2.find((entry) => stringField(entry, 'deliveryId') === deliveryR2) ?? null, 'id');

  // r1 must remain byte-identical AFTER the r2 work (local seal + portal side).
  const studio = createStudioContext(workspaceDir!);
  const r1Manifest = await getRevisionManifest(studio, { projectId: 'demo-shared', assetId: 'bfc-cover', revisionId: r1.revisionId });
  const recomputed = await computeRevisionRootHash(r1Manifest);
  stage.check(recomputed === r1Manifest.rootHash && recomputed === r1.rootHash, 'rootHash de r1 se recalcula intacto tras el trabajo r2 (Studio local)');
  stage.check(await sha256File(sealedR1Feed) === feedR1Sha, 'los bytes sellados de r1 siguen intactos (el sellado nunca se reescribe)');
  const d1AfterR2 = await api('GET', `/api/v1/deliveries/${deliveryR1}/outputs/feed`, { cookie: adminCookie });
  const d1Bytes = new Uint8Array(await d1AfterR2.arrayBuffer());
  hashes.outputFeedR1AfterR2 = sha256(d1Bytes);
  stage.check(d1AfterR2.status === 200 && hashes.outputFeedR1AfterR2 === feedR1Sha, 'la entrega r1 descargada tras r2 es byte-idéntica (sin latest, sin sobrescritura)');
}

async function stagePublishClientView(stage: StageScope): Promise<void> {
  const showResponse = await api('PATCH', `/api/v1/client-assets/${assetIdR1}/visibility`, { cookie: adminCookie, body: { visibility: 'client_visible' } });
  stage.check(showResponse.status === 200, 'admin hace visible la entrega r1 (ruta admin humano)');

  const postResponse = await api('POST', `/api/v1/clients/${bfcClientId}/posts`, {
    cookie: adminCookie,
    body: {
      assetId: assetIdR1,
      title: 'Feed BFC r1',
      caption: 'Entrega r1 verificada offline (fixture, sin IA).',
      outputNames: ["feed"],
      coverOutputName: "feed",
      visibility: 'client_visible',
    },
  });
  stage.check(postResponse.status === 201, 'admin crea el post con output + cover exactos');
  const post = await jsonRecord(postResponse);
  postId = stringField(post, 'id');
  const postCover = subRecord(post, 'cover');
  stage.check(stringField(postCover, 'sha256') === hashes.outputFeedR1Manifest, 'portada del post es el output EXACTO entregado');
  const postOutputs = recordArrayField(post, 'outputs');
  stage.check(postOutputs.length === 1 && stringField(postOutputs[0] ?? null, 'sha256') === hashes.outputFeedR1Manifest, 'el carrusel referencia solo outputs de su propia entrega');

  const gridBefore = await jsonRecord(await api('GET', `/api/v1/clients/${bfcClientId}/grid`, { cookie: adminCookie }));
  const gridPostsBefore = recordArrayField(gridBefore, 'posts');
  stage.check(
    numberField(gridBefore, 'version') === 1 && stringField(gridPostsBefore[0] ?? null, 'postId') === postId,
    `grid inicial v${String(numberField(gridBefore, 'version'))} con el post registrado`,
  );
  const gridPatch = await api('PATCH', `/api/v1/clients/${bfcClientId}/grid`, { cookie: adminCookie, body: { version: numberField(gridBefore, 'version'), order: [postId] } });
  const gridAfter = await jsonRecord(gridPatch);
  stage.check(gridPatch.status === 200 && numberField(gridAfter, 'version') === (numberField(gridBefore, 'version') ?? 0) + 1, `reorden atómico CAS: versión ${String(numberField(gridAfter, 'version'))}`);

  const carolAssetsDoc = await jsonRecord(await api('GET', `/api/v1/clients/${bfcClientId}/assets`, { cookie: carolCookie }));
  const carolAssets = recordArrayField(carolAssetsDoc, 'items');
  stage.check(carolAssets.length === 1 && stringField(carolAssets[0] ?? null, 'visibility') === 'client_visible', 'la cliente ve exactamente su asset visible');
  const carolOutputs = recordArrayField(carolAssets[0] ?? null, 'outputs');
  stage.check(
    carolOutputs.some((output) => stringField(output, "name") === "feed" && stringField(output, 'sha256') === hashes.outputFeedR1Manifest),
    'catálogo expone el output exacto con su hash',
  );

  const browserView = async (): Promise<void> => {
    const browser = await launchBrowser();
    try {
      const carolCtx = await newContext(browser.browser);
      await loginPersona(carolCtx, CAROL, '/portal');
      const page = await carolCtx.newPage();
      await page.setViewportSize({ width: 390, height: 844 });

      await gotoWait(page, `${ORIGIN}/portal/${bfcClientId}/assets`, '[data-testid="assets-page"]');
    stage.check(await page.locator('[data-testid="asset-list"]').count() === 1, 'el catálogo del cliente lista los assets visibles');
    const assetsBody = (await page.textContent('body')) ?? '';
    stage.check(assetsBody.includes('Cover BFC'), 'catálogo del cliente muestra la revisión entregada');
    stage.check(!assetsBody.includes('rootHash'), 'sin fuga de provenance/rootHash en el catálogo del cliente');
    await shoot(page, 'mobile-assets-p005');

    // Stage (g): browser grid view (mobile viewport; desktop as extra).
    await gotoWait(page, `${ORIGIN}/portal/${bfcClientId}/instagram`, '[data-testid="insta-grid"]');
    const cells = await page.locator('[data-testid^="insta-cell-"]').count();
    stage.check(cells >= 1, `cuadrícula Instagram con ${cells} celda(s) visible(s) para la cliente`);
    await page.locator('[aria-label^="Abrir Feed BFC r1"]').click();
    await waitContent(page, '[role="dialog"]');
    const modalText = (await page.textContent('[role="dialog"]')) ?? '';
    stage.check(modalText.includes('Entrega r1 verificada offline'), 'detalle del post muestra el caption');
    await page.keyboard.press('Escape');
    await shoot(page, 'mobile-grid-p005');
    await page.reload({ waitUntil: 'load' });
    await waitContent(page, '[data-testid="insta-grid"]');
    stage.check(true, 'grid persiste tras recargar');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    await shoot(page, 'desktop-grid-p005');

    // Client download straight from the browser session.
    const download = await carolCtx.request.get(`${ORIGIN}/api/v1/deliveries/${deliveryR1}/outputs/feed`);
    const bytes = new Uint8Array(await download.body());
    hashes.outputFeedR1Downloaded = sha256(bytes);
    const expectedDigest = SABOTAGE ? WRONG_DIGEST : hashes.outputFeedR1Manifest;
    stage.check(download.status() === 200, 'descarga autenticada de la cliente: 200');
    stage.check(
      hashes.outputFeedR1Downloaded === expectedDigest,
      SABOTAGE
        ? 'SONDA DE SABOTAJE activa: la comparación contra un digest equivocado DEBE fallar'
        : 'bytes descargados == bytes entregados (sha256 == manifest r1)',
    );
    stage.check(download.headers()['content-type'] === 'image/png' && download.headers()['x-content-type-options'] === 'nosniff', 'descarga con MIME seguro y nosniff');
    await carolCtx.close();
  } finally {
    await browser.close();
  }
};
  try {
    await browserView();
  } catch (firstError) {
    stage.note(`vista cliente reintento tras: ${firstError instanceof Error ? firstError.message.slice(0, 160) : String(firstError)}`);
    await Bun.sleep(3000);
    await browserView();
  }
}

async function stageNegatives(stage: StageScope): Promise<void> {
  // (1) hidden cascade: admin hides r1; the client loses catalog, post and the direct URL.
  const hide = await api('PATCH', `/api/v1/client-assets/${assetIdR1}/visibility`, { cookie: adminCookie, body: { visibility: 'internal' } });
  stage.check(hide.status === 200, 'admin oculta la entrega r1');
  const hiddenAssets = await jsonRecord(await api('GET', `/api/v1/clients/${bfcClientId}/assets`, { cookie: carolCookie }));
  stage.check(recordArrayField(hiddenAssets, 'items').length === 0, 'catálogo del cliente vacío tras ocultar (cascada)');
  const hiddenPosts = await jsonRecord(await api('GET', `/api/v1/clients/${bfcClientId}/posts`, { cookie: carolCookie }));
  stage.check(recordArrayField(hiddenPosts, 'items').length === 0, 'el post deja de ser visible para la cliente');
  const hiddenDirect = await api('GET', `/api/v1/deliveries/${deliveryR1}/outputs/feed`, { cookie: carolCookie });
  stage.check(hiddenDirect.status === 404, 'URL directa del output oculto: 404 en el siguiente request');

  // (2) cross-client isolation for bob (member of second-brand only).
  const crossCases: Array<[string, number]> = [];
  const crossRequest = async (label: string, pathname: string): Promise<void> => {
    crossCases.push([label, (await api('GET', pathname, { cookie: bobCookie })).status]);
  };
  await crossRequest('list materials del otro cliente', `/api/v1/clients/${bfcClientId}/materials`);
  await crossRequest('list assets del otro cliente', `/api/v1/clients/${bfcClientId}/assets`);
  await crossRequest('show material ajeno', `/api/v1/materials/${materialId}`);
  await crossRequest('content de material ajeno', `/api/v1/materials/${materialId}/content`);
  await crossRequest('deep-link a output ajeno', `/api/v1/deliveries/${deliveryR1}/outputs/feed`);
  await crossRequest('posts del otro cliente', `/api/v1/clients/${bfcClientId}/posts`);
  for (const [label, status] of crossCases) {
    stage.check(status === 404, `acceso cruzado (${label}): 404 sin enumeración (recibido ${String(status)})`);
  }
  const ownPage = await api('GET', `/api/v1/clients/${secondClientId}/materials`, { cookie: bobCookie });
  stage.check(ownPage.status === 200, 'control: bob sigue viendo SU cliente (el 404 no es ruptura general)');

  // (3) limited agent key: scope + client-scope enforcement.
  const limitedMe = await runCli(['portal-auth-status', '--origin', ORIGIN, '--json'], limitedKey);
  stage.check(
    limitedMe.exit === 0 && stringOrArrayScope(subRecord(limitedMe.data, 'principal')).join(',') === 'materials:read',
    'key limitada declara SOLO materials:read',
  );
  const limitedOk = await runCli(['portal-material-list', '--client', bfcClientId, '--origin', ORIGIN, '--json'], limitedKey);
  stage.check(limitedOk.exit === 0 && limitedOk.ok, 'control: la key limitada SÍ puede listar materiales de SU cliente (scope suficiente)');
  const limitedCross = await runCli(['portal-material-list', '--client', secondClientId, '--origin', ORIGIN, '--json'], limitedKey);
  stage.check(
    limitedCross.exit !== 0 && !limitedCross.ok && stringField(limitedCross.error, 'code') === 'NOT_FOUND',
    'key limitada NO ve el otro cliente del workspace (grant client-scoped → 404 sin enumeración)',
  );
  const limitedAdopt = await runCli([
    'portal-client-adopt', 'bfc',
    '--workspace', workspaceDir!,
    '--workspace-id', workspaceId,
    '--origin', ORIGIN,
    '--execute', '--json',
  ], limitedKey);
  stage.check(
    limitedAdopt.exit === 1 && !limitedAdopt.ok && stringField(limitedAdopt.error, 'code') === 'FORBIDDEN',
    'adopción sin clients:write es rechazada FORBIDDEN (sin autoescalada de scopes)',
  );

  // (4) MIME manipulation.
  const heic = await api('POST', `/api/v1/clients/${bfcClientId}/uploads`, { cookie: carolCookie, body: { kind: 'material', mediaType: 'image/heic', declaredBytes: 10 } });
  stage.check(heic.status === 400, 'HEIC rechazado en init con explicación (400, sin fingir conversión)');
  const lyingInit = await api('POST', `/api/v1/clients/${bfcClientId}/uploads`, { cookie: carolCookie, body: { kind: 'material', mediaType: 'image/png', declaredBytes: PHOTO_BYTES.length } });
  const lyingSession = await jsonRecord(lyingInit);
  stage.check(lyingInit.status === 201, 'sesión con tipo declarado png creada (la verificación real ocurre en bytes)');
  const lyingPut = await api('PUT', `/api/v1/uploads/${stringField(lyingSession, 'uploadId')}/content`, { cookie: carolCookie, rawBody: PHOTO_BYTES, contentType: 'image/png' });
  stage.check(lyingPut.status === 200, 'PUT de bytes jpeg bajo declaración png llega a staging');
  const lyingComplete = await api('POST', `/api/v1/uploads/${stringField(lyingSession, 'uploadId')}/complete`, { cookie: carolCookie });
  stage.check(lyingComplete.status === 415, 'complete rechaza 415: bytes detectados != tipo declarado (sin falso ready)');
  const garbageInit = await api('POST', `/api/v1/clients/${bfcClientId}/uploads`, { cookie: carolCookie, body: { kind: 'material', mediaType: 'image/jpeg', declaredBytes: 8 } });
  const garbageSession = await jsonRecord(garbageInit);
  const garbagePut = await api('PUT', `/api/v1/uploads/${stringField(garbageSession, 'uploadId')}/content`, { cookie: carolCookie, rawBody: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), contentType: 'image/jpeg' });
  stage.check(garbagePut.status === 415, 'cuerpo sin firma conocida: 415 en PUT');

  // (5) path manipulation.
  const traversalInit = await api('POST', `/api/v1/clients/${bfcClientId}/uploads`, { cookie: carolCookie, body: { kind: 'material', mediaType: 'image/jpeg', declaredBytes: PHOTO_BYTES.length, name: '../../etc/evil.jpg' } });
  const traversalSession = await jsonRecord(traversalInit);
  stage.check(traversalInit.status === 201, 'init con nombre malicioso aceptado SOLO tras saneo (la ruta nunca viaja)');
  await api('PUT', `/api/v1/uploads/${stringField(traversalSession, 'uploadId')}/content`, { cookie: carolCookie, rawBody: PHOTO_BYTES, contentType: 'image/jpeg' });
  const traversalComplete = await api('POST', `/api/v1/uploads/${stringField(traversalSession, 'uploadId')}/complete`, { cookie: carolCookie });
  const traversalMaterial = await jsonRecord(traversalComplete);
  const traversalName = stringField(traversalMaterial, 'name');
  stage.check(
    traversalComplete.status === 201 && !traversalName.includes('/') && !traversalName.includes('\\'),
    `nombre saneado sin separadores de ruta (${traversalName})`,
  );
  const traversalOutput = await api('GET', `/api/v1/deliveries/${deliveryR1}/outputs/..%2Ffeed.png`, { cookie: carolCookie });
  stage.check(traversalOutput.status === 404, 'nombre de output con traversal: 404 (nunca resuelve keys arbitrarias)');
  const slashOutput = await api('POST', `/api/v1/clients/${bfcClientId}/uploads`, { cookie: carolCookie, body: { kind: 'delivery_output', mediaType: 'image/png', declaredBytes: 1, sha256: 'a'.repeat(64), deliveryId: deliveryR1, outputName: 'sub/evil.png' } });
  stage.check(slashOutput.status === 400, 'outputName con separadores rechazado en validación de entrada (400)');

  // (6) logout cuts the very next request.
  const signOut = await fetch(`${ORIGIN}/api/auth/sign-out`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: carolCookie, origin: ORIGIN },
    body: JSON.stringify({}),
  });
  stage.check(signOut.status === 200 || signOut.status === 204, 'logout de la cliente (Better Auth real)');
  const meAfterLogout = await api('GET', '/api/v1/me', { cookie: carolCookie });
  stage.check(meAfterLogout.status === 401, 'siguiente request tras logout: 401');
  const contentAfterLogout = await api('GET', `/api/v1/materials/${materialId}/content`, { cookie: carolCookie });
  stage.check(contentAfterLogout.status === 401, 'contenido del material tras logout: 401 (la sesión muerta no lee bytes)');

  // (7) grant revocation from the admin UI cuts the agent's next operation.
  const revokeViaUi = async (): Promise<void> => {
    const browser = await launchBrowser();
    try {
      const adminCtx = await newContext(browser.browser);
      await loginPersona(adminCtx, ADMIN, `/admin/clients/${bfcClientId}/access`);
      const page = await adminCtx.newPage();
      await gotoWait(page, `${ORIGIN}/admin/clients/${bfcClientId}/access`, '[data-testid="access-tab"]', 30_000);
      await page.click(`button[aria-label="Revocar grant de ${KEY_MAIN_NAME}"]`);
      await page.waitForFunction(
        () => document.querySelector('[data-testid="grant-table"]')?.textContent?.includes('revocado') === true,
        undefined,
        { timeout: 30_000 },
      );
      await adminCtx.close();
    } finally {
      await browser.close();
    }
  };
  try {
    await revokeViaUi();
  } catch (firstError) {
    stage.note(`revocación UI reintento tras: ${firstError instanceof Error ? firstError.message.slice(0, 160) : String(firstError)}`);
    await Bun.sleep(2000);
    await revokeViaUi();
  }
  stage.check(true, 'admin revoca el grant del agente desde la UI');
  const meAfterRevoke = await runCli(['portal-auth-status', '--origin', ORIGIN, '--json'], agentKey);
  stage.check(
    meAfterRevoke.exit === 0 && stringOrArrayScope(subRecord(meAfterRevoke.data, 'principal')).length === 0,
    'la key sigue siendo una identidad válida pero el grant quedó vacío (scopes [])',
  );
  const listAfterRevoke = await runCli(['portal-material-list', '--client', bfcClientId, '--origin', ORIGIN, '--json'], agentKey);
  stage.check(
    listAfterRevoke.exit !== 0 && !listAfterRevoke.ok,
    'siguiente operación del agente tras revocación: rechazada en el mismo request',
  );
}

async function stageRequests(stage: StageScope): Promise<void> {
  // (0) A requests-capable agent key: issued through the REAL admin UI flow
  // (key shown once) and the grant widened via the emulated-D1 fixture,
  // because the v1 access tab does not render the R-2 requests:* checkboxes
  // (grants created before R-2 never hold the new scopes — this mirrors the
  // operator path where an updated issuer grants them server-side).
  const browser = await launchBrowser();
  try {
    const adminCtx = await newContext(browser.browser);
    browserCtxs.push(adminCtx);
    await loginPersona(adminCtx, ADMIN, `/admin/clients/${bfcClientId}/access`);
    const page = await adminCtx.newPage();
    await gotoWait(page, `${ORIGIN}/admin/clients/${bfcClientId}/access`, '[data-testid="agent-key-form"]', 30_000);
    await page.fill('[data-testid="agent-key-form"] input[name="agent-email"]', INTEGRATOR);
    await page.fill('[data-testid="agent-key-form"] input[name="agent-key-name"]', 'p005-requests');
    for (const scope of ['clients:read', 'clients:write', 'materials:read', 'materials:write', 'deliveries:read', 'deliveries:write', 'access:write']) {
      const box = page.locator(`input[aria-label="Scope ${scope}"]`);
      if (['clients:read', 'materials:read'].includes(scope)) await box.check();
      else await box.uncheck();
    }
    await page.click('[data-testid="agent-key-form"] button[type="submit"]');
    await page.waitForFunction(
      () => {
        const pre = document.querySelector('[data-testid="issued-key"] pre');
        return pre !== null && pre.textContent !== null && pre.textContent.trim().length > 0;
      },
      undefined,
      { timeout: 20_000 },
    );
    requestsAgentKey = (await page.textContent('[data-testid="issued-key"] pre'))?.trim() ?? '';
    await adminCtx.close();
  } finally {
    await browser.close();
  }
  stage.check(requestsAgentKey.length >= 16 && !/\s/.test(requestsAgentKey), 'key de agente para requests emitida por el flujo admin UI (se muestra una sola vez)');
  requestSecrets.push(requestsAgentKey);
  let widenedOk = true;
  try {
    fixtureSql([`UPDATE agent_grant SET scopes = '["clients:read","materials:read","requests:read","requests:write"]' WHERE key_id IN (SELECT id FROM apikey WHERE name = 'p005-requests')`]);
  } catch {
    widenedOk = false;
  }
  stage.check(widenedOk, 'grant del agente ampliado con requests:read/requests:write (fixture D1 emulado, scopes server-side)');
  const meRequests = await runCli(['portal-auth-status', '--origin', ORIGIN, '--json'], requestsAgentKey);
  const meScopes = stringOrArrayScope(subRecord(meRequests.data, 'principal'));
  stage.check(meRequests.exit === 0 && meScopes.includes('requests:read') && meScopes.includes('requests:write'), `scopes visibles en /me: ${meScopes.join(', ')}`);

  // (1) PortalProjects (R-1 pointers) via the ADMIN route; duplicates 409.
  const createdProject = await api('POST', `/api/v1/clients/${bfcClientId}/projects`, { cookie: adminCookie, body: { studioProjectId: 'demo-shared', name: 'BFC Showcase (requests)' } });
  const projectDoc = await jsonRecord(createdProject);
  requestProjectBfc = stringField(projectDoc, 'id');
  stage.check(createdProject.status === 201 && requestProjectBfc.length > 0, 'admin registra el pointer bfc → demo-shared (201)');
  stage.check(stringField(projectDoc, 'studioProjectId') === 'demo-shared', 'el pointer referencia el proyecto studio demo-shared');
  const duplicateProject = await api('POST', `/api/v1/clients/${bfcClientId}/projects`, { cookie: adminCookie, body: { studioProjectId: 'demo-shared', name: 'Duplicado' } });
  stage.check(duplicateProject.status === 409, 'pointer duplicado (cliente, proyecto): 409');
  const secondProject = await api('POST', `/api/v1/clients/${secondClientId}/projects`, { cookie: adminCookie, body: { studioProjectId: 'demo-shared', name: 'Second Brand (requests)' } });
  requestProjectSecond = stringField(await jsonRecord(secondProject), 'id');
  stage.check(secondProject.status === 201 && requestProjectSecond.length > 0, 'pointer del segundo cliente hacia su par (cliente, demo-shared)');

  // (2) Plan mode with a CLOSED port proves zero network; then the real create
  // returns {requestId, url, expiresAt, limits} — the URL captured in-process
  // only (0 emails; nunca en logs ni evidencia).
  const planArgs = ['portal-request-create', '--client', bfcClientId, '--project', requestProjectBfc, '--title', 'Fotos del evento', '--instructions', 'Entregar en JPG o PNG', '--max-files', '2', '--max-bytes', '4MiB', '--expires-in', '30d'];
  const portClosed = `${ORIGIN.split(':')[0]}://127.0.0.1:9`;
  const plan = await runCli([...planArgs, '--origin', portClosed, '--json'], requestsAgentKey);
  stage.check(plan.exit === 0 && plan.data?.executed === false, 'sin --execute el create es SOLO plan incluso con un origen sin servidor (cero red)');
  stage.check(recordArrayField(plan.data, 'plan').length >= 3, 'el plan enumera resolución de pointer + crear request + mint del enlace');

  const createMain = await runCli([...planArgs, '--origin', ORIGIN, '--execute', '--json'], requestsAgentKey);
  stage.check(createMain.exit === 0 && createMain.ok, 'portal-request-create --execute crea el pedido y mintea el enlace de invitado');
  requestIdMain = stringField(createMain.data, 'requestId');
  const mintedUrl = stringField(createMain.data, 'url');
  guestTokenMain = mintedUrl.startsWith(`${ORIGIN}/request/`) ? mintedUrl.slice(`${ORIGIN}/request/`.length) : '';
  stage.check(requestIdMain.length > 0 && guestTokenMain.length > 0, `request ${requestIdMain} con URL de invitado capturada en proceso (el token vive solo en memoria)`);
  stage.check(mintedUrl.startsWith(`${ORIGIN}/request/`), 'el URL minteado apunta al origen aprobado');
  const mainLimits = subRecord(createMain.data, 'limits');
  stage.check(numberField(mainLimits, 'maxFiles') === 2 && numberField(mainLimits, 'maxBytes') === 4 * 1_048_576, 'límites devueltos: 2 archivos / 4MiB');
  stage.check((numberField(createMain.data, 'expiresAt') ?? 0) > Date.now() + 29 * 24 * 3_600_000, 'expiresAt coherente con --expires-in 30d');
  stage.check(!JSON.stringify(commands).includes(guestTokenMain), 'el token de capacidad NO aparece en el registro de comandos de la evidencia');

  // (3) Guest-direct flow (sin cookie, sin api key: el token ES la capacidad).
  const guestView = await api('GET', `/api/v1/r/${guestTokenMain}`);
  const guestViewDoc = await jsonRecord(guestView);
  stage.check(guestView.status === 200, 'el invitado ve SU request sin login (200)');
  stage.check(guestView.headers.get('cache-control') === 'no-store', 'vista de invitado con no-store (sin fuga de cache entre tokens)');
  stage.check(stringField(guestViewDoc, 'title') === 'Fotos del evento' && !('id' in (guestViewDoc ?? {})) && !('clientId' in (guestViewDoc ?? {})), 'vista mínima: título visible, CERO ids de otros recursos');
  stage.check(stringField(guestViewDoc, 'state') === 'open', `estado visible para el invitado: ${stringField(guestViewDoc, 'state')}`);

  const guestUpload = async (token: string, bytes: Uint8Array, name: string): Promise<{ status: number; body: Record<string, unknown> | null }> => {
    const init = await api('POST', `/api/v1/r/${token}/uploads`, { body: { mediaType: 'image/png', declaredBytes: bytes.length, name } });
    const initDoc = await jsonRecord(init);
    if (init.status !== 201) return { status: init.status, body: initDoc };
    const put = await api('PUT', `/api/v1/r/${token}/uploads/${stringField(initDoc, 'uploadId')}/content`, { rawBody: bytes, contentType: 'image/png' });
    if (put.status !== 200) return { status: put.status, body: await jsonRecord(put) };
    const complete = await api('POST', `/api/v1/r/${token}/uploads/${stringField(initDoc, 'uploadId')}/complete`);
    return { status: complete.status, body: await jsonRecord(complete) };
  };

  const first = await guestUpload(guestTokenMain, REQUEST_PNG_BYTES, 'uno.png');
  const firstMaterial = subRecord(first.body, 'material');
  hashes.requestUploadUno = stringField(firstMaterial, 'sha256');
  stage.check(first.status === 201 && hashes.requestUploadUno === requestPngSha, 'subida de invitado 1/2 verificada server-side (sha == subido)');
  const second = await guestUpload(guestTokenMain, REQUEST_PNG_VARIANT_BYTES, 'dos.png');
  const secondRequest = subRecord(second.body, 'request');
  hashes.requestUploadDos = stringField(subRecord(second.body, 'material'), 'sha256');
  stage.check(second.status === 201 && hashes.requestUploadDos === requestVariantSha, 'subida de invitado 2/2 verificada (fixture variante distinta)');
  stage.check(stringField(secondRequest, 'state') === 'fulfilled', 'auto-cierre al llenar límites: fulfilled sin cron');

  const overInit = await api('POST', `/api/v1/r/${guestTokenMain}/uploads`, { body: { mediaType: 'image/png', declaredBytes: 10 } });
  stage.check(overInit.status === 409, 'init sobre request fulfilled: 409 (el presupuesto congeló la capacidad)');

  const materialsPage = await jsonRecord(await api('GET', `/api/v1/requests/${requestIdMain}/materials`, { apiKey: requestsAgentKey }));
  const requestMaterials = recordArrayField(materialsPage, 'items');
  stage.check(requestMaterials.length === 2, `el pedido registra exactamente 2 materiales (${requestMaterials.length})`);
  stage.check(
    recordArrayField(materialsPage, 'items').every((material) => [requestPngSha, requestVariantSha].includes(stringField(material, 'sha256'))),
    'los materiales del pedido son EXACTAMENTE los subidos por el invitado (sha)',
  );

  // (4) CLI pull into the EXACT Studio project of the pointer.
  const assetDir = join(workspaceDir!, 'projects', 'demo-shared', 'assets', 'bfc-cover');
  const pull = await runCli([
    'portal-request-pull', requestIdMain,
    '--project', 'demo-shared', '--asset', 'bfc-cover',
    '--workspace', workspaceDir!, '--origin', ORIGIN, '--execute', '--json',
  ], requestsAgentKey);
  stage.check(pull.exit === 0 && pull.ok, 'portal-request-pull importa TODOS los materiales ready al proyecto del pointer');
  const imported = recordArrayField(pull.data, 'imported');
  stage.check(imported.length === 2, `imported=2 con input + provenance por material (${imported.length})`);
  hashes.requestImportedUno = '';
  hashes.requestImportedDos = '';
  let assetInputsAfterPull = -1;
  for (const entry of imported) {
    const inputPath = stringField(entry, 'inputPath');
    const provenancePath = stringField(entry, 'provenancePath');
    const inputBytes = new Uint8Array(await readFile(join(assetDir, inputPath)));
    const digest = sha256(inputBytes);
    const expected = digest === requestPngSha ? requestPngSha : requestVariantSha;
    stage.check(digest === expected && stringField(entry, 'sha256') === expected, `bytes importados == bytes subidos por el invitado (${inputPath})`);
    const provenance = parseJsonRecord(await readFile(join(assetDir, provenancePath), 'utf8')) ?? {};
    stage.check(
      stringField(provenance, 'requestId') === requestIdMain && stringField(provenance, 'origin') === ORIGIN && stringField(provenance, 'materialId') === stringField(entry, 'id'),
      'sidecar registra procedencia (origin, materialId, requestId)',
    );
    stage.check(!JSON.stringify(provenance).includes(requestsAgentKey), 'el sidecar NO contiene la key del agente');
    if (expected === requestPngSha) hashes.requestImportedUno = digest;
    else hashes.requestImportedDos = digest;
  }
  stage.check(hashes.requestImportedUno === requestPngSha && hashes.requestImportedDos === requestVariantSha, 'ambos fixtures importados con su sha exacto (uno y dos)');
  const assetDocAfterPull = parseJsonRecord(await readFile(join(assetDir, 'asset.json'), 'utf8')) ?? {};
  assetInputsAfterPull = stringArrayField(assetDocAfterPull, 'inputs').length;
  stage.check(stringArrayField(assetDocAfterPull, 'inputs').length >= 4 && stringArrayField(pull.data, 'addedInputs').length === 4, 'asset.json registró input + sidecar de cada material (4 entradas nuevas)');

  const repull = await runCli([
    'portal-request-pull', requestIdMain,
    '--project', 'demo-shared', '--asset', 'bfc-cover',
    '--workspace', workspaceDir!, '--origin', ORIGIN, '--execute', '--json',
  ], requestsAgentKey);
  stage.check(repull.exit === 0 && stringArrayField(repull.data, 'addedInputs').length === 0, 're-pull idempotente: cero entradas nuevas');
  const assetDocAfterRepull = parseJsonRecord(await readFile(join(assetDir, 'asset.json'), 'utf8')) ?? {};
  stage.check(stringArrayField(assetDocAfterRepull, 'inputs').length === assetInputsAfterPull, 're-pull no duplicó entradas en asset.json');

  // Plan mode of pull: cero escritura.
  const inputsDirBefore = await readdir(join(assetDir, 'inputs', 'portal'));
  const planPull = await runCli([
    'portal-request-pull', requestIdMain,
    '--project', 'demo-shared', '--asset', 'bfc-cover',
    '--workspace', workspaceDir!, '--origin', ORIGIN, '--json',
  ], requestsAgentKey);
  stage.check(planPull.exit === 0 && planPull.data?.executed === false, 'pull sin --execute imprime SOLO el plan');
  const inputsDirAfterPlan = await readdir(join(assetDir, 'inputs', 'portal'));
  stage.check(inputsDirAfterPlan.length === inputsDirBefore.length, 'el plan de pull no escribió nada en inputs/portal');

  // (5) Pull negatives: workspace sin el proyecto del pointer; --project que
  // NO coincide con el pointer (nunca se inventa destino ni se importa a otro).
  const emptyDir = await mkdtemp(join(tmpdir(), 'p005-requests-empty-'));
  const emptyWorkspace = join(emptyDir, 'workspace');
  await mkdir(emptyWorkspace, { recursive: true });
  const noProject = await runCli([
    'portal-request-pull', requestIdMain,
    '--project', 'demo-shared', '--asset', 'bfc-cover',
    '--workspace', emptyWorkspace, '--origin', ORIGIN, '--execute', '--json',
  ], requestsAgentKey);
  stage.check(noProject.exit === 2 && stringField(noProject.error, 'code') === 'NOT_FOUND', 'pull a workspace SIN el proyecto indicado: NOT_FOUND (exit 2)');
  stage.check(!(await readdir(emptyWorkspace)).includes('projects'), 'sin proyecto local NO se crea ningún destino');
  const soloAsset = join(workspaceDir!, 'projects', 'demo-solo', 'assets', 'hello-video');
  const soloInputsBefore = (await readdir(soloAsset).catch(() => [] as string[])).length;
  const wrongProject = await runCli([
    'portal-request-pull', requestIdMain,
    '--project', 'demo-solo', '--asset', 'hello-video',
    '--workspace', workspaceDir!, '--origin', ORIGIN, '--execute', '--json',
  ], requestsAgentKey);
  stage.check(wrongProject.exit === 2 && stringField(wrongProject.error, 'code') === 'INVALID_INPUT', 'pull a un proyecto local SIN relación con el cliente del pedido: INVALID_INPUT (nunca a otro proyecto)');
  const soloInputsAfter = (await readdir(soloAsset).catch(() => [] as string[])).length;
  stage.check(soloInputsAfter === soloInputsBefore, 'el rechazo de proyecto incorrecto no escribió en demo-solo');

  // (6) Rotación de token: el anterior MUERE (un token activo por request).
  const createClose = await runCli([
    'portal-request-create', '--client', bfcClientId, '--project', requestProjectBfc,
    '--title', 'Pedido a cerrar', '--max-files', '1', '--max-bytes', '1MiB',
    '--origin', ORIGIN, '--execute', '--json',
  ], requestsAgentKey);
  requestIdClose = stringField(createClose.data, 'requestId');
  const createCloseUrl = stringField(createClose.data, 'url');
  const firstCloseToken = createCloseUrl.startsWith(`${ORIGIN}/request/`) ? createCloseUrl.slice(`${ORIGIN}/request/`.length) : '';
  requestSecrets.push(firstCloseToken);
  const mintClose = await runCli(['portal-request-link', requestIdClose, '--expires-in', '48h', '--origin', ORIGIN, '--execute', '--json'], requestsAgentKey);
  const closeUrl = stringField(mintClose.data, 'url');
  guestTokenClose = closeUrl.startsWith(`${ORIGIN}/request/`) ? closeUrl.slice(`${ORIGIN}/request/`.length) : '';
  requestSecrets.push(guestTokenClose);
  stage.check(mintClose.exit === 0 && guestTokenClose.length > 0, 'portal-request-link mintea el enlace del segundo pedido');
  const oldTokenView = await api('GET', `/api/v1/r/${firstCloseToken}`);
  stage.check(oldTokenView.status === 404, 'el token ANTERIOR de un request muere al re-mintear (404 uniforme)');
  const newTokenView = await api('GET', `/api/v1/r/${guestTokenClose}`);
  stage.check(newTokenView.status === 200, 'el token nuevo sigue vivo tras la rotación (control)');

  // (7) Cierre: CLI close → closed; re-close 409; guest init 409.
  const close = await runCli(['portal-request-close', requestIdClose, '--reason', 'Ya no hace falta', '--origin', ORIGIN, '--execute', '--json'], requestsAgentKey);
  const closedView = subRecord(close.data, 'request');
  stage.check(close.exit === 0 && stringField(closedView, 'state') === 'closed', 'portal-request-close cierra el pedido (estado closed)');
  const reclose = await runCli(['portal-request-close', requestIdClose, '--origin', ORIGIN, '--execute', '--json'], requestsAgentKey);
  stage.check(reclose.exit === 1 && stringField(reclose.error, 'code') === 'CONFLICT', 're-cerrar un pedido cerrado: 409 CONFLICT (exit 1)');
  const guestOnClosed = await guestUpload(guestTokenClose, REQUEST_PNG_BYTES, 'tarde.png');
  stage.check(guestOnClosed.status === 409, 'init de invitado sobre request cerrado: 409');

  // (8) Expiry LAZY: backdate del expires_ms via fixture → el PRIMER uso
  // materializa expired (audit única, sin cron); uploads y close rechazan.
  const createExpiry = await runCli([
    'portal-request-create', '--client', bfcClientId, '--project', requestProjectBfc,
    '--title', 'Pedido a vencer', '--max-files', '1', '--max-bytes', '1MiB', '--expires-in', '30m',
    '--origin', ORIGIN, '--execute', '--json',
  ], requestsAgentKey);
  requestIdExpiry = stringField(createExpiry.data, 'requestId');
  const expiryUrl = stringField(createExpiry.data, 'url');
  guestTokenExpiry = expiryUrl.startsWith(`${ORIGIN}/request/`) ? expiryUrl.slice(`${ORIGIN}/request/`.length) : '';
  requestSecrets.push(guestTokenExpiry);
  const expiryInit = await api('POST', `/api/v1/r/${guestTokenExpiry}/uploads`, { body: { mediaType: 'image/png', declaredBytes: REQUEST_PNG_BYTES.length } });
  const expirySession = await jsonRecord(expiryInit);
  stage.check(expiryInit.status === 201, 'sesión de invitado creada mientras el pedido está vigente');
  const expiryPut = await api('PUT', `/api/v1/r/${guestTokenExpiry}/uploads/${stringField(expirySession, 'uploadId')}/content`, { rawBody: REQUEST_PNG_BYTES, contentType: 'image/png' });
  stage.check(expiryPut.status === 200, 'PUT del invitado en staging (declaro y subo antes de vencer)');
  let backdated = true;
  try {
    fixtureSql([`UPDATE upload_request SET expires_ms = 1 WHERE id = '${requestIdExpiry}'`]);
  } catch {
    backdated = false;
  }
  stage.check(backdated, 'fixture: expires_ms retrocedido en D1 emulado (sin cron)');
  const completeAfterExpiry = await api('POST', `/api/v1/r/${guestTokenExpiry}/uploads/${stringField(expirySession, 'uploadId')}/complete`);
  stage.check(completeAfterExpiry.status === 409, 'complete tras vencer: 409 (el cierre lazy es efectivo entre PUT y complete)');
  const expiredView = await api('GET', `/api/v1/r/${guestTokenExpiry}`);
  const expiredDoc = await jsonRecord(expiredView);
  stage.check(expiredView.status === 200 && stringField(expiredDoc, 'state') === 'expired', 'la vista del invitado muestra state=expired tras el cierre lazy');
  const expiredInit = await api('POST', `/api/v1/r/${guestTokenExpiry}/uploads`, { body: { mediaType: 'image/png', declaredBytes: 10 } });
  stage.check(expiredInit.status === 409, 'init de invitado sobre request vencido: 409');
  const closeExpired = await runCli(['portal-request-close', requestIdExpiry, '--origin', ORIGIN, '--execute', '--json'], requestsAgentKey);
  stage.check(closeExpired.exit === 1 && stringField(closeExpired.error, 'code') === 'CONFLICT', 'cerrar un pedido vencido: 409 CONFLICT (ya terminó)');

  // (9) Filtro de estado en el listado CLI + negativas de scope/rol.
  const listExpired = await runCli(['portal-request-list', '--client', bfcClientId, '--project', requestProjectBfc, '--state', 'expired', '--origin', ORIGIN, '--json'], requestsAgentKey);
  const expiredItems = pageItems(listExpired);
  stage.check(
    listExpired.exit === 0 && expiredItems.length === 1 && stringField(subRecord(expiredItems[0] ?? null, 'request'), 'id') === requestIdExpiry,
    'portal-request-list --state expired encuentra exactamente el pedido vencido',
  );
  const listAll = await runCli(['portal-request-list', '--client', bfcClientId, '--project', requestProjectBfc, '--origin', ORIGIN, '--json'], requestsAgentKey);
  stage.check(pageItems(listAll).length === 3, `listado completo del pointer: 3 pedidos (${pageItems(listAll).length})`);

  const memberCreate = await api('POST', `/api/v1/projects/${requestProjectSecond}/requests`, { cookie: bobCookie, body: { title: 'Miembro', maxFiles: 1, maxBytes: 1048576 } });
  stage.check(memberCreate.status === 403, 'miembro logueado NO puede crear requests sobre su propio cliente: 403');
  const oldScopeList = await runCli(['portal-request-list', '--client', bfcClientId, '--project', requestProjectBfc, '--origin', ORIGIN, '--json'], limitedKey);
  stage.check(oldScopeList.exit === 1 && stringField(oldScopeList.error, 'code') === 'FORBIDDEN', 'agente con grant previo (sin requests:read): 403 FORBIDDEN');
  const oldScopeCreate = await runCli([
    'portal-request-create', '--client', bfcClientId, '--project', requestProjectBfc,
    '--title', 'X', '--max-files', '1', '--max-bytes', '1MiB',
    '--origin', ORIGIN, '--execute', '--json',
  ], limitedKey);
  stage.check(oldScopeCreate.exit === 1 && stringField(oldScopeCreate.error, 'code') === 'FORBIDDEN', 'agente sin requests:write NO crea requests: 403 FORBIDDEN (sin autoescalada)');

  // (10) El token de invitado NO es una credencial del catálogo.
  const guestAsKey = await api('GET', `/api/v1/clients/${bfcClientId}/materials`, { apiKey: guestTokenMain });
  stage.check(guestAsKey.status === 401, 'el token de capacidad NO autentica nada fuera de /api/v1/r/... (401)');
}

/* ---------------------------------------------------------------------------
 * Evidence + main
 * ------------------------------------------------------------------------- */

async function buildEvidence(totalAssertions: number): Promise<Record<string, unknown>> {
  return {
    date: new Date().toISOString(),
    phase: 'P-005 flujo completo offline (v1) + R-3 recorrido upload requests (customer-assets-requests)',
    gate: 'G-cap-local (D1/R2 emulados, servidor efímero loopback, mail fake). G-cap-live NO ejecutado: sin cloud, deploy, emails reales ni studio:verify:r2.',
    environment: {
      mode: 'emulated-only',
      d1: 'miniflare local (apps/customer-assets/tests/e2e/.state, migraciones 0001+0002+0003+0004)',
      r2: 'bucket emulado customer-assets-local (privado, aislado del backup Studio)',
      mail: 'fake sink vía /api/fixture/session (solo con var E2E_FIXTURE=1)',
      server: `vite dev efímero en 127.0.0.1:${PORT} (loopback exclusivo)`,
      network: 'solo 127.0.0.1; cero red real',
    },
    sabotageProbe: {
      flag: 'PORTAL_VERIFY_SABOTAGE=1 fuerza una aserción de hash equivocado en 07-publish-client-view (única etapa saboteada; 08.5-requests es independiente del digest saboteado)',
      thisRun: SABOTAGE
        ? 'activa: esta corrida DEBE terminar en exit 1 con 07-publish-client-view en fallo'
        : 'inactiva; la prueba de no-vacuidad vive en offline-sabotage.json (exit 1 observado)',
    },
    stages,
    sha256: hashes,
    fixtures: {
      'photo.jpg': { source: 'embebido en scripts/customer-assets-verify.ts (JPEG 32x32 real)', bytes: PHOTO_BYTES.length, sha256: photoSha },
      'r1 feed.png': { source: 'demo/studio/bfc/outputs-r1/feed.png vía revisión sellada del workspace demo', sha256: hashes.outputFeedR1Manifest ?? '' },
      'r2 feed.png': { source: 'demo/studio/bfc/outputs-r2/feed.png vía revisión sellada del workspace demo', sha256: hashes.outputFeedR2Delivered ?? '' },
    },
    commands,
    counts: {
      stages: stages.length,
      stagesOk: stages.filter((stage) => stage.ok).length,
      assertions: totalAssertions,
      cliInvocations: commands.length,
      cliOk: commands.filter((command) => command.exit === 0).length,
      screenshots: screenshots.length,
      portalClients: 2,
      materialsWalkthrough: 1,
      deliveries: 2,
      posts: 1,
      uploadRequests: 3,
      requestMaterialsImported: 2,
    },
    screenshots: [...new Map(screenshots.map((shot) => [shot.name, shot])).values()],
    notes: [
      'Cadena de hashes: subido == registrado == importado == releído (material) y manifest == entregado == descargado == tras-r2 (output r1).',
      'La key de agente viajó SOLO como env del subprocess CLI; no aparece en este archivo, screenshots ni envelopes.',
      'Las URLs de verificación (magic link) nunca se registran; los snapshots son de páginas de catálogo/grid/admin sin secretos.',
      'El checklist de operación en apps/customer-assets/ops/ es DOCUMENTACIÓN: nada fue aprovisionado ni aplicado.',
    ],
  };
}

async function writeEvidence(totalAssertions: number): Promise<void> {
  const serialized = JSON.stringify(await buildEvidence(totalAssertions), null, 2);
  for (const secret of [agentKey, limitedKey, ...requestSecrets]) {
    if (secret.length > 0 && serialized.includes(secret)) {
      throw new Error('evidence contiene una key de agente: abortando escritura');
    }
  }
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await mkdir(SHOT_DIR, { recursive: true });
  await writeFile(EVIDENCE_FILE, `${serialized}\n`);
}

async function main(): Promise<number> {
  console.log(`portal:verify — origen efímero ${ORIGIN}${SABOTAGE ? ' (SONDA DE SABOTAJE activa)' : ''}`);
  const t0 = Date.now();
  await runStage('00-preflight', stagePreflight);
  await runStage('01-boot-provision', stageBoot);
  await runStage('02-agent-key-adopt', stageKeyAdopt);
  await runStage('03-invite-login', stageInviteLogin);
  await runStage('04-client-upload', stageClientUpload);
  await runStage('05-cli-material-pull', stageMaterialPull);
  await runStage('06-cli-delivery-push', stageDeliveryPush);
  await runStage('07-publish-client-view', stagePublishClientView);
  await runStage('08-negatives', stageNegatives);
  await runStage('08.5-requests', stageRequests);

  await runStage('09-evidence', async (stage) => {
    const totalAssertions = stages.reduce((sum, entry) => sum + entry.assertions, 0);
    stage.check(totalAssertions > 0, `aserciones acumuladas en etapas previas (${totalAssertions})`);
    const chainMaterial = hashes.materialPhotoUploaded === hashes.materialPhotoRegistered
      && hashes.materialPhotoRegistered === hashes.materialPhotoImported
      && hashes.materialPhotoImported === hashes.materialPhotoReadBack;
    stage.check(chainMaterial, 'cadena material: subido == registrado == importado == releído');
    const chainRequest = hashes.requestUploadUno === requestPngSha
      && hashes.requestUploadDos === requestVariantSha
      && hashes.requestImportedUno === requestPngSha
      && hashes.requestImportedDos === requestVariantSha;
    stage.check(chainRequest, 'cadena requests: subido por invitado == registrado == importado al workspace (SHA-256, ambos fixtures)');
    const chainOutput = hashes.outputFeedR1Delivered === hashes.outputFeedR1Manifest
      && hashes.outputFeedR1Downloaded === hashes.outputFeedR1Manifest
      && hashes.outputFeedR1AfterR2 === hashes.outputFeedR1Manifest;
    stage.check(chainOutput, 'cadena output r1: manifest == entregado == descargado == tras-r2');
    await writeEvidence(totalAssertions);
    const written = (await jsonRecord(new Response(await readFile(EVIDENCE_FILE, 'utf8')))) ?? {};
    stage.check(recordArrayField(written, 'stages').length === stages.length, `evidence ${EVIDENCE_FILE.split('/').pop()} escrita y releída`);
    for (const shot of screenshots) {
      stage.check(statSync(join(REPO_ROOT, shot.path)).size > 0, `screenshot presente: ${shot.name}`);
    }
  });

  // Rewrite with the COMPLETE stage list (the in-stage write predates the
  // 09-evidence row) so the recorded counts match the console summary.
  await writeEvidence(stages.reduce((sum, entry) => sum + entry.assertions, 0)).catch(() => undefined);

  if (server !== null) await server.stop();
  for (const context of browserCtxs) await context.close().catch(() => undefined);
  if (tmpRoot !== null && stages.every((stage) => stage.ok)) {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const failed = stages.filter((stage) => !stage.ok);
  console.log(
    `portal:verify ${failed.length === 0 ? 'OK' : 'FALLO'} — ${stages.length} etapas, ${stages.reduce((sum, stage) => sum + stage.assertions, 0)} aserciones, ${Date.now() - t0}ms`,
  );
  if (failed.length > 0) {
    console.error(`etapas en fallo: ${failed.map((stage) => stage.name).join(', ')}`);
    return 1;
  }
  return 0;
}

const code = await main();
process.exit(code);
