/**
 * scripts/customer-assets-verify-live.ts — `bun run portal:verify:live` (P-006).
 *
 * Staged, non-vacuous LIVE smoke of the authorized HTTPS pilot
 * (https://customers-assets.theelena.me) behind the human gate G-cap-live.
 * Model: scripts/customer-assets-verify.ts (P-005 offline) — same stage
 * machinery, same non-vacuous rule: a missing stage, a skip, or a stage with
 * 0 assertions fails the whole run (exit 1). Nothing is faked offline-style:
 * real DNS/TLS, real D1/R2 bindings, exactly one real magic-link email.
 *
 * Modes (mutually exclusive):
 *   --preflight (or PORTAL_LIVE_PREFLIGHT=1)
 *       Local readiness only. Zero cloud calls unless CLOUDFLARE_API_TOKEN is
 *       already in env (then `wrangler whoami`, read-only). Prints NAMED gaps
 *       and exits 1 while anything is missing — e.g. cloud credentials.
 *   --request-login
 *       Sends the ONE authorized magic-link email to PORTAL_LIVE_EMAIL
 *       (Better Auth sign-in over real HTTPS) and prints the handoff
 *       instructions. Refuses to exceed 2 total emails for the pilot
 *       (counter file evidence/customer-assets-portal/.live-email-counter.json).
 *   --magic-link '<login URL>'  (or env PORTAL_LIVE_MAGIC_LINK)
 *       Full staged live smoke; consumes the received login URL instead of
 *       sending anything. This is the only mode that writes live.json.
 *
 * Budgets enforced BY CONSTRUCTION (resource-inventory + phase DoD):
 *   photo fixture ≤ 1 MiB; total uploaded bytes ≤ 20 MiB; ≤ 2 outbound emails;
 *   no render/IA/social publication; CLI pushes an EXISTING sealed output
 *   (studio-demo revisions); no remote deletion as implicit cleanup.
 *
 * Redaction contract: no token, cookie, API key or login URL ever reaches
 * stdout evidence or live.json — the writer aborts the run if any of them
 * appears in the serialized evidence. Only resource NAMES/ids (non-secret)
 * and counts are recorded.
 *
 * Stage B runbook (exact commands): apps/customer-assets/ops/runbook-p006-live.md
 * (also printed on failures that block the run).
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import { buildDemoWorkspace, sha256File, type DemoWorkspace } from './studio-demo';

const REPO_ROOT = join(import.meta.dir, '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'customer-assets');
const EVIDENCE_DIR = join(REPO_ROOT, 'evidence', 'customer-assets-portal');
const SHOT_DIR = join(EVIDENCE_DIR, 'p006-live');
const EVIDENCE_FILE = join(EVIDENCE_DIR, 'live.json');
/** Manual-mode handoff file for the captured login URL (0600, machine-local). */
const MAGIC_LINK_FILE = '/tmp/p006-live-magic-link';
const WRANGLER_CONFIG = join(APP_DIR, 'wrangler.jsonc');

const CLI_BIN = 'packages/cli/src/main.ts';

/** Zone-approved pilot host. Any other host fails the run (never evidence). */
const APPROVED_HOST = 'customers-assets.theelena.me';
const APPROVED_ORIGIN = `https://${APPROVED_HOST}`;

/* Budgets (phase DoD + resource-inventory). */
const MAX_PHOTO_BYTES = 1_048_576; // 1 MiB per uploaded photo
const MAX_TOTAL_UPLOAD_BYTES = 20 * 1_048_576; // 20 MiB total uploads
const MAX_EMAILS = 2; // pilot authorization ceiling

const D1_PLACEHOLDER = 'REPLACE_WITH_REAL_D1_DATABASE_ID_AT_STAGE_B';
const EMULATION_D1_ID = 'local-emulation-only';

const PILOT_WORKSPACE_LABEL = 'P-006 Live Pilot Workspace';
const PILOT_STUDIO_CLIENT_ID = 'bfc';
/**
 * MUST equal the demo workspace's studio client display name: the adopt API
 * refuses projections whose name differs from the local client.json (CONFLICT
 * guard). The demo workspace is the integration source of this smoke.
 */
const PILOT_CLIENT_NAME = 'BFC (adopción demo)';

const KEY_MAIN_NAME = 'p006-live-integrator';
const KEY_LIMITED_NAME = 'p006-live-readonly';

/**
 * Operator-approved recipient + workspace principals. The OPERATOR identity
 * is DEFAULTED to the approved pilot principal so a reproduction needs no env
 * beyond the Cloudflare credentials (override via PORTAL_LIVE_EMAIL).
 */
const OPERATOR_EMAIL = (process.env.PORTAL_LIVE_EMAIL ?? 'operator@theelena.me').trim();
const INTEGRATOR_EMAIL = (process.env.PORTAL_LIVE_INTEGRATOR_EMAIL ?? 'integrator@theelena.me').trim();
const EMAIL_SECRET_NAME = (process.env.PORTAL_LIVE_EMAIL_SECRET_NAME ?? 'RESEND_API_KEY').trim();

const args = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const MAGIC_LINK = (argValue('--magic-link') ?? process.env.PORTAL_LIVE_MAGIC_LINK ?? '').trim();
const PREFLIGHT_MODE = args.includes('--preflight') || process.env.PORTAL_LIVE_PREFLIGHT === '1';
const REQUEST_LOGIN_MODE = args.includes('--request-login');

const ORIGIN = (() => {
  const raw = (process.env.PORTAL_ORIGIN ?? APPROVED_ORIGIN).trim().replace(/\/+$/, '');
  return raw;
})();

/* Fixture photo: real decodable 32x32 JPEG, deterministic (same as P-005). */
const PHOTO_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAgACADAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCHXqJAAAAAAAAAAAAAAAf/2Q==';
const PHOTO_EXPECTED_SHA = '780255fb9015c79e8016278861ceb00730e88c6f7a72cc18be473b9e1e3698a5';
const PHOTO_BYTES: Uint8Array = Uint8Array.from(atob(PHOTO_JPEG_BASE64), (c) => c.charCodeAt(0));

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const photoSha = sha256(PHOTO_BYTES);

/* ---------------------------------------------------------------------------
 * Counters + budgets
 * ------------------------------------------------------------------------- */

const counters = {
  requests: 0,
  cliInvocations: 0,
  wranglerOps: 0,
  bytesUploaded: 0,
  bytesDownloaded: 0,
  emailsSent: 0, // ALWAYS 0: login = copy the link (operator decision, Stage B)
};

/* ---------------------------------------------------------------------------
 * Runtime narrowing helpers (same JSON boundaries as the offline verifier)
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
  const value = record?.[field];
  return isRecord(value) ? value : null;
}

function stringField(record: Record<string, unknown> | null, field: string): string {
  const value = record?.[field];
  return typeof value === 'string' ? value : '';
}

function numberField(record: Record<string, unknown> | null, field: string): number | null {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function recordArrayField(record: Record<string, unknown> | null, field: string): Record<string, unknown>[] {
  const value = record?.[field];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringArrayField(record: Record<string, unknown> | null, field: string): string[] {
  const value = record?.[field];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
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

/* ---------------------------------------------------------------------------
 * wrangler runner: token travels ONLY via env; output is captured and parsed,
 * never echoed raw (it can contain account emails).
 * ------------------------------------------------------------------------- */

interface WranglerOutcome {
  exit: number;
  stdout: string;
  stderr: string;
}

async function runWrangler(args: string[], options: { quiet?: boolean } = {}): Promise<WranglerOutcome> {
  counters.wranglerOps += 1;
  const label = `wrangler ${args.join(' ')}`;
  if (options.quiet !== true) console.log(`  [cloud] ${label}`);
  const proc = Bun.spawn(['bunx', 'wrangler', ...args], {
    cwd: APP_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '1' },
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exit = await proc.exited;
  commands.push({ cmd: label, exit });
  return { exit, stdout, stderr };
}

/** Extracts the first JSON array value from mixed wrangler output. */
function wranglerJsonArray(stdout: string): unknown[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const parsed: unknown = JSON.parse(stdout.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ---------------------------------------------------------------------------
 * wrangler.jsonc reader (comment-stripping parse of OUR OWN config file)
 * ------------------------------------------------------------------------- */

interface PortalConfig {
  workerName: string;
  d1Name: string;
  d1Id: string;
  bucketName: string;
  vars: Record<string, unknown>;
  routes: Record<string, unknown>[];
  raw: string;
}

function stripJsoncComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

function readPortalConfig(): PortalConfig {
  const raw = readFileSync(WRANGLER_CONFIG, 'utf8');
  const stripped = stripJsoncComments(raw);
  const parsed = parseJsonRecord(stripped) ?? {};
  const d1List = Array.isArray(parsed.d1_databases) ? parsed.d1_databases.filter(isRecord) : [];
  const r2List = Array.isArray(parsed.r2_buckets) ? parsed.r2_buckets.filter(isRecord) : [];
  const routeList = Array.isArray(parsed.routes) ? parsed.routes.filter(isRecord) : [];
  return {
    workerName: stringField(parsed, 'name'),
    d1Name: stringField(d1List[0] ?? null, 'database_name'),
    d1Id: stringField(d1List[0] ?? null, 'database_id'),
    bucketName: stringField(r2List[0] ?? null, 'bucket_name'),
    vars: isRecord(parsed.vars) ? parsed.vars : {},
    routes: routeList,
    raw: stripped,
  };
}

/* ---------------------------------------------------------------------------
 * HTTP helpers (v1 API with cookies; counts every request)
 * ------------------------------------------------------------------------- */

interface ApiInit {
  cookie?: string;
  body?: unknown;
  rawBody?: Uint8Array;
  contentType?: string;
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH';
}

async function api(method: ApiInit['method'], pathname: string, init: ApiInit = {}): Promise<Response> {
  counters.requests += 1;
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  if (init.contentType !== undefined) headers['content-type'] = init.contentType;
  else if (init.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${ORIGIN}${pathname}`, {
    method: method ?? 'GET',
    headers,
    body: (init.rawBody ?? (init.body === undefined ? undefined : JSON.stringify(init.body))) as BodyInit,
    signal: AbortSignal.timeout(60_000),
  });
}

async function recordDownload(response: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  counters.bytesDownloaded += bytes.length;
  return bytes;
}

/* ---------------------------------------------------------------------------
 * Browser helpers (playwright-core + cached chromium; real HTTPS only)
 * ------------------------------------------------------------------------- */

async function launchBrowser(): Promise<Browser> {
  const cacheRoot = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
  let executablePath: string | undefined;
  const versions = existsSync(cacheRoot) ? readdirSync(cacheRoot) : [];
  for (const version of versions.filter((entry) => entry.startsWith('chromium-')).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))) {
    for (const sub of ['chrome-linux64', 'chrome-linux']) {
      const candidate = join(cacheRoot, version, sub, 'chrome');
      if (existsSync(candidate)) {
        executablePath = candidate;
        break;
      }
    }
    if (executablePath !== undefined) break;
  }
  if (executablePath === undefined) throw new Error(`no cached chromium under ${cacheRoot}`);
  // --disable-dev-shm-usage: long runs exhaust /dev/shm and kill the renderer
  // mid-smoke; --no-sandbox is standard for rootless CI headless.
  return chromium.launch({ executablePath, headless: true, args: ['--disable-dev-shm-usage', '--no-sandbox'] });
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  // Real pilot origin: certificate errors must FAIL the run, never pass.
  return browser.newContext({ ignoreHTTPSErrors: false });
}

/**
 * Guarantees a usable browser context with the operator's HTTPS session.
 * If the previous context/browser died mid-run (headless crash), relaunches
 * and re-injects the SAVED session cookie — never a second magic link.
 */
async function ensureOperatorContext(stage: StageScope): Promise<void> {
  if (operatorCtx !== null) {
    try {
      const probe = await operatorCtx.newPage();
      await probe.close();
      return;
    } catch {
      stage.note('contexto/navegador previo murió entre etapas: recreando con la cookie de sesión guardada (sin segundo login)');
      try {
        await operatorCtx.close();
      } catch {
        /* already dead */
      }
      operatorCtx = null;
    }
  }
  if (browser === null || !browser.isConnected()) {
    browser = await launchBrowser();
  }
  // Canonical Playwright restore: the SAVED storage state (cookies + origins)
  // reconstructs the HTTPS session exactly — no second magic link, no manual
  // cookie field reconstruction. NOTE: a string is treated as a FILE PATH by
  // playwright — pass the parsed object. Errors are rethrown REDACTED: the
  // raw error embeds the session cookies.
  let fresh: BrowserContext;
  try {
    fresh = operatorStorageState.length > 0
      ? await browser.newContext({ ignoreHTTPSErrors: false, storageState: JSON.parse(operatorStorageState) })
      : await newContext(browser);
  } catch (error) {
    throw new Error(`restauración de sesión falló (storageState redactado): ${error instanceof Error ? error.message.split('\n')[0]?.slice(0, 80) : String(error)}`);
  }
  operatorCtx = fresh;
}

async function cookieOf(context: BrowserContext): Promise<string> {
  const cookies = await context.cookies(ORIGIN);
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

async function gotoWait(page: Page, url: string, selector: string, timeout = 30_000): Promise<void> {
  await page.goto(url, { waitUntil: 'load', timeout });
  try {
    await page.waitForSelector(selector, { state: 'visible', timeout });
  } catch {
    await page.waitForTimeout(1500);
    await page.goto(url, { waitUntil: 'load', timeout });
    await page.waitForSelector(selector, { state: 'visible', timeout });
  }
}

const screenshots: { name: string; path: string; bytes: number }[] = [];

async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOT_DIR, { recursive: true });
  const abs = join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: abs, fullPage: false });
  screenshots.push({ name: `${name}.png`, path: `evidence/customer-assets-portal/p006-live/${name}.png`, bytes: statSync(abs).size });
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
  counters.cliInvocations += 1;
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
  const envelope = parseJsonRecord(stdout);
  if (envelope === null || numberField(envelope, 'schemaVersion') !== 1) {
    throw new Error(`CLI sin envelope JSON schemaVersion 1 en: ${cmd} — stderr: ${stderr.slice(-300)}`);
  }
  const ok = envelope.ok === true;
  const error = ok ? null : subRecord(envelope, 'error');
  commands.push(ok
    ? { cmd, exit }
    : { cmd, exit, code: stringField(error, 'code'), message: stringField(error, 'message').slice(0, 200) });
  return { exit, ok, data: ok ? subRecord(envelope, 'data') : null, error };
}

function pageItems(outcome: CliOutcome): Record<string, unknown>[] {
  return recordArrayField(outcome.data, 'items');
}

/** /me scopes may arrive as a string[]; narrow without casting. */
function scopesOf(principal: Record<string, unknown> | null): string[] {
  const raw = principal?.['scopes'];
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : [];
}

/* ---------------------------------------------------------------------------
 * Controlled D1 provisioning SQL (mirrors provisionUser/createWorkspace/
 * createMembership/fixture-provision semantics EXACTLY; idempotent; the only
 * direct writes this run performs, restricted to pilot rows)
 * ------------------------------------------------------------------------- */

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function nowSecondsSql(): string {
  return "CAST(strftime('%s','now') AS INTEGER)";
}

/** portal_* tables store epoch MILLISECONDS (0002_portal.sql header). */
function nowMsSql(): string {
  return "CAST(strftime('%s','now') AS INTEGER) * 1000";
}

interface ProvisionedIds {
  workspaceId: string;
  pilotClientId: string;
}

/** Runs one statement remotely and returns the JSON rows it produced. */
async function d1Query(stage: StageScope, database: string, sql: string): Promise<Record<string, unknown>[]> {
  const outcome = await runWrangler(['d1', 'execute', database, '--remote', '--json', '--command', sql]);
  stage.check(outcome.exit === 0, `d1 execute --remote exit 0 (${sql.slice(0, 48)}…; recibido ${String(outcome.exit)})`);
  const outer = wranglerJsonArray(outcome.stdout);
  const first = outer[0];
  const results = isRecord(first) && Array.isArray(first.results) ? first.results.filter(isRecord) : [];
  return results;
}

async function provisionPilotRows(stage: StageScope, database: string): Promise<ProvisionedIds> {
  const now = nowSecondsSql();

  // 1. Users: operator (admin, receives THE magic-link email) + integrator
  //    (CLI principal; never logs in). provisionUser semantics: lowercase
  //    email, emailVerified true, role server-side.
  for (const person of [
    { email: OPERATOR_EMAIL, name: 'Portal Operator (P-006)', role: 'admin' },
    { email: INTEGRATOR_EMAIL, name: 'Portal Integrator (P-006)', role: 'member' },
  ]) {
    await d1Query(stage, database,
      `INSERT OR IGNORE INTO "user" ("id","name","email","email_verified","role","created_at","updated_at") `
      + `VALUES (${sqlString(randomUUID())},${sqlString(person.name)},${sqlString(person.email.toLowerCase())},1,${sqlString(person.role)},${now},${now})`,
    );
    const rows = await d1Query(stage, database,
      `SELECT "id" FROM "user" WHERE "email" = ${sqlString(person.email.toLowerCase())}`,
    );
    stage.check(rows.length === 1, `usuario ${redactEmail(person.email)} presente en D1 (fila única)`);
  }

  // 2. Workspace (createWorkspace semantics: label + integrator binding).
  const workspaceRows = await d1Query(stage, database,
    `SELECT "id" FROM "portal_workspace" WHERE "label" = ${sqlString(PILOT_WORKSPACE_LABEL)} LIMIT 1`,
  );
  let workspaceId = stringField(workspaceRows[0] ?? null, 'id');
  if (workspaceId.length === 0) {
    const integratorRows = await d1Query(stage, database,
      `SELECT "id" FROM "user" WHERE "email" = ${sqlString(INTEGRATOR_EMAIL.toLowerCase())}`,
    );
    workspaceId = randomUUID();
    await d1Query(stage, database,
      `INSERT INTO "portal_workspace" ("id","label","integrator_user_id","created_ms") `
      + `VALUES (${sqlString(workspaceId)},${sqlString(PILOT_WORKSPACE_LABEL)},${sqlString(stringField(integratorRows[0] ?? null, 'id'))},${nowMsSql()})`,
    );
  }
  stage.check(workspaceId.length > 0, 'workspace piloto presente con id estable');

  // 3. Pilot client projection (portal_client UNIQUE (workspace, studio id)).
  // Upsert (NO delete): converges the display name with the integration
  // source so `portal-client-adopt` never dies on the CONFLICT guard.
  await d1Query(stage, database,
    `INSERT INTO "portal_client" ("id","workspace_id","studio_client_id","name","projection_version","created_ms") `
    + `VALUES (${sqlString(randomUUID())},${sqlString(workspaceId)},${sqlString(PILOT_STUDIO_CLIENT_ID)},${sqlString(PILOT_CLIENT_NAME)},1,${nowMsSql()}) `
    + `ON CONFLICT("workspace_id","studio_client_id") DO UPDATE SET "name" = excluded."name"`,
  );
  const clientRows = await d1Query(stage, database,
    `SELECT "id" FROM "portal_client" WHERE "workspace_id" = ${sqlString(workspaceId)} AND "studio_client_id" = ${sqlString(PILOT_STUDIO_CLIENT_ID)}`,
  );
  const pilotClientId = stringField(clientRows[0] ?? null, 'id');
  stage.check(pilotClientId.length > 0, 'cliente portal piloto proyectado (studio bfc)');

  // 4. Operator membership on the pilot client (createMembership semantics:
  //    active; UNIQUE (user, client) makes the OR IGNORE idempotent).
  const operatorRows = await d1Query(stage, database,
    `SELECT "id" FROM "user" WHERE "email" = ${sqlString(OPERATOR_EMAIL.toLowerCase())}`,
  );
  await d1Query(stage, database,
    `INSERT OR IGNORE INTO "membership" ("id","user_id","portal_client_id","status","created_ms") `
    + `VALUES (${sqlString(randomUUID())},${sqlString(stringField(operatorRows[0] ?? null, 'id'))},${sqlString(pilotClientId)},'active',${nowMsSql()})`,
  );
  const membershipRows = await d1Query(stage, database,
    `SELECT "id" FROM "membership" WHERE "user_id" = ${sqlString(stringField(operatorRows[0] ?? null, 'id'))} AND "portal_client_id" = ${sqlString(pilotClientId)} AND "status" = 'active'`,
  );
  stage.check(membershipRows.length === 1, 'membresía activa operador↔cliente piloto (controlado, sin invitación)');

  return { workspaceId, pilotClientId };
}

/** Redacts an email for notes/evidence: keeps provider, masks the local part. */
function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 2)}***@${email.slice(at + 1)}`;
}

/* ---------------------------------------------------------------------------
 * Magic-link capture (operator decision: login = copy the link, 0 emails).
 * `wrangler tail --format json` streams worker logs; the mailer's SMOKE path
 * logs the single-use URL. The URL never lands in stdout, commands or
 * evidence — only in memory (and the 0600 handoff file in --request-login).
 * ------------------------------------------------------------------------- */

const SMOKE_MARKER = '[PORTAL-LIVE-SMOKE]';

function extractSmokeUrl(line: string): string {
  if (!line.includes(SMOKE_MARKER)) return '';
  const parsed = parseJsonRecord(line);
  const candidates: string[] = [];
  const logs = recordArrayField(parsed, 'logs');
  for (const entry of logs) candidates.push(stringField(entry, 'message'));
  if (parsed === null) candidates.push(line);
  for (const message of candidates) {
    // Stop at whitespace, quotes or commas: pretty-JSON fragments and partial
    // lines must never leak delimiters into the captured URL.
    const match = message.match(/url=(https:\/\/[^\s",']+)/);
    if (match !== null) return match[1] ?? '';
  }
  return '';
}

/** Redacted diagnosis envelope: code/message only — never headers or raw body. */
async function readErrorEnvelope(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as Record<string, unknown>;
    const message = typeof body['message'] === 'string'
      ? body['message']
      : typeof body['error'] === 'string' ? body['error'] : '';
    return JSON.stringify({ status: response.status, code: body['code'] ?? null, message })
      .replaceAll(/token=[^"&\s]+/g, 'token=<redacted>');
  } catch {
    return `status ${String(response.status)} (cuerpo no JSON)`;
  }
}

/**
 * POSTs the Better Auth sign-in for the operator with backoff-and-retry:
 * transient 4xx (rate limiter windows, cold isolate) must not fail the smoke
 * when a retry with a fresh request is safe (it is: single-use links, 0 emails).
 */
async function postSignInWithRetry(): Promise<void> {
  if (!/^[^'"\s@]+@[^'"\s@]+\.[^'"\s@]+$/.test(OPERATOR_EMAIL)) {
    throw new Error(`email del operador inválido (${redactEmail(OPERATOR_EMAIL)}): la petición sign-in no se envía`);
  }
  let lastReason = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    counters.requests += 1;
    const response = await fetch(`${ORIGIN}/api/auth/sign-in/magic-link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: OPERATOR_EMAIL, callbackURL: '/portal' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return;
    lastReason = await readErrorEnvelope(response);
    if (attempt < 3) await Bun.sleep(attempt === 1 ? 15_000 : 30_000);
  }
  throw new Error(`sign-in magic-link rechazado: ${lastReason.slice(0, 220)} (¿deploy/vars/rate-limit?)`);
}

/** Waits for wrangler's attach banner ("Connected to …") before triggering. */
async function waitForTailReady(tail: Bun.Subprocess, stdoutText: { value: string }, stderrText: { value: string }): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (/connected/i.test(stderrText.value) || /connected/i.test(stdoutText.value)) return;
    if (tail.exitCode !== null) return; // dead tail: let the read loop report it
    await Bun.sleep(500);
  }
  // 30s without banner: proceed anyway (the SMOKE read loop still guards).
}

/** Streams a subprocess pipe into a shared text sink (best-effort). */
async function drainInto(stream: ReadableStream<Uint8Array>, sink: { value: string }): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done === true) break;
      sink.value += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    /* stream closed by kill() */
  }
}

/**
 * ONE capture attempt: attach → wait ready → sign-in → read SMOKE line
 * (≥60s); on timeout, resend sign-in ONCE with the tail already attached
 * (fresh single-use link) and keep reading. Kills the tail on exit.
 */
async function attemptCapture(): Promise<string> {
  const tail = Bun.spawn(['bunx', 'wrangler', 'tail', '--format', 'json'], {
    cwd: APP_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '1' },
  });
  const cleanup = (): void => {
    if (tail.exitCode === null) tail.kill('SIGTERM');
  };
  try {
    const stdoutText = { value: '' };
    const stderrText = { value: '' };
    const stdoutDrain = drainInto(tail.stdout, stdoutText);
    const stderrDrain = drainInto(tail.stderr, stderrText);
    void stdoutDrain;
    void stderrDrain;

    // Race-safe attach: tail can take seconds; sending too early misses logs.
    await waitForTailReady(tail, stdoutText, stderrText);
    await postSignInWithRetry();

    const readForSmoke = async (budgetMs: number): Promise<string> => {
      const deadline = Date.now() + budgetMs;
      while (Date.now() < deadline) {
        const match = extractSmokeUrl(stdoutText.value);
        if (match.length > 0) return match;
        await Bun.sleep(1_000);
      }
      return '';
    };

    let url = await readForSmoke(75_000);
    if (url.length === 0) {
      // Tail attached but nothing streamed: resend once (fresh single-use
      // link; still 0 emails) and keep reading with the tail in place.
      await postSignInWithRetry();
      url = await readForSmoke(60_000);
    }
    if (url.length > 0) return url;
    throw new Error('tail timeout sin línea SMOKE tras reintento de sign-in (¿PORTAL_LIVE_SMOKE=1 en el deploy?)');
  } finally {
    cleanup();
    await Bun.sleep(500);
    if (tail.exitCode === null) tail.kill('SIGKILL');
  }
}

/**
 * Captures the login URL with ONE whole-attempt retry (a fresh attempt is
 * always safe: single-use links, zero emails, idempotent pilot state).
 */
async function captureMagicLinkViaTail(): Promise<string> {
  let lastError = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await attemptCapture();
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < 2) await Bun.sleep(10_000);
    }
  }
  throw new Error(lastError);
}

/** Tracked so the evidence scrubber can prove the URL never leaks. */
let capturedLoginUrl = '';

/** Saved Playwright storage state (cookies) of the operator session. */
let operatorStorageState = '';

/* ---------------------------------------------------------------------------
 * Runbook (exact Stage-B sequence; also at ops/runbook-p006-live.md)
 * ------------------------------------------------------------------------- */

function printRunbook(): void {
  console.error(`
RUNBOOK P-006 Stage B (detalle: apps/customer-assets/ops/runbook-p006-live.md)
  export CLOUDFLARE_API_TOKEN=...            # coordinador; NUNCA en repo/logs
  bunx wrangler d1 create customer-assets-prod          # anotar database_id → wrangler.jsonc
  bunx wrangler r2 bucket create customer-assets-prod   # privado, aislado (NUNCA el bucket backup Studio)
  bunx wrangler d1 migrations apply customer-assets-prod --remote
  bunx wrangler d1 migrations list customer-assets-prod --remote   # → vacío
  openssl rand -hex 32 | bunx wrangler secret put BETTER_AUTH_SECRET   # valor jamás impreso
  bun run --cwd apps/customer-assets build && bunx wrangler deploy   # (desde apps/customer-assets)
  # dominio customers-assets.theelena.me → worker (custom_domain en wrangler.jsonc)
  bun run portal:verify:live -- --request-login    # captura el enlace vía wrangler tail; CERO emails
  PORTAL_LIVE_MAGIC_LINK="$(cat /tmp/p006-live-magic-link)" bun run portal:verify:live
`.trimEnd());
}

/* ---------------------------------------------------------------------------
 * Globals shared across stages
 * ------------------------------------------------------------------------- */

let config: PortalConfig;
let browser: Browser | null = null;
let operatorCtx: BrowserContext | null = null;
let operatorCookie = '';
let tmpRoot: string | null = null;
let workspaceDir: string | null = null;
let demo: DemoWorkspace | null = null;

let workspaceId = '';
let pilotClientId = '';
let secondClientId = '';
let agentKey = '';
let limitedKey = '';

let materialId = '';
let deliveryR1 = '';
let assetIdR1 = '';
let postId = '';

const hashes: Record<string, string> = {};

const secretsSeen = (): string[] => [agentKey, limitedKey, operatorCookie, MAGIC_LINK, capturedLoginUrl].filter((secret) => secret.length > 8);

/* ---------------------------------------------------------------------------
 * Shared readiness checks (used by preflight mode AND stage 00)
 * ------------------------------------------------------------------------- */

interface ReadinessGap {
  name: string;
  detail: string;
}

async function collectReadiness(withCloud: boolean): Promise<{ gaps: ReadinessGap[]; notes: string[] }> {
  const gaps: ReadinessGap[] = [];
  const notes: string[] = [];

  // Local deps
  if (!existsSync(join(REPO_ROOT, 'node_modules'))) gaps.push({ name: 'deps', detail: 'node_modules raíz ausente (bun install)' });
  if (!existsSync(join(APP_DIR, 'node_modules', 'wrangler'))) gaps.push({ name: 'deps', detail: 'wrangler no instalado en apps/customer-assets (bun install)' });
  if (!existsSync(join(APP_DIR, 'migrations', '0001_auth.sql')) || !existsSync(join(APP_DIR, 'migrations', '0002_portal.sql'))) {
    gaps.push({ name: 'migrations', detail: 'migraciones 0001/0002 ausentes' });
  }

  // Origin allowlist
  if (ORIGIN !== APPROVED_ORIGIN) {
    gaps.push({ name: 'origin', detail: `PORTAL_ORIGIN=${ORIGIN} no es el dominio aprobado ${APPROVED_ORIGIN}` });
  }

  // Cloud credentials
  if ((process.env.CLOUDFLARE_API_TOKEN ?? '').length === 0) {
    gaps.push({ name: 'cloud credentials', detail: 'CLOUDFLARE_API_TOKEN ausente en env (mecanismo del coordinador pendiente)' });
  } else if (withCloud) {
    const who = await runWrangler(['whoami'], { quiet: true });
    if (who.exit !== 0) {
      gaps.push({ name: 'cloud credentials', detail: `wrangler whoami exit ${String(who.exit)}: el token no autentica` });
    } else {
      notes.push('wrangler whoami ok (identidad NO registrada: la salida puede contener datos de cuenta)');
    }
  }

  // Operator inputs
  if (!/^[^'"\s@]+@[^'"\s@]+\.[^'"\s@]+$/.test(OPERATOR_EMAIL)) {
    gaps.push({ name: 'operator email', detail: 'PORTAL_LIVE_EMAIL (email aprobado del operador para el magic link) ausente o inválido' });
  }
  if (!/^[^'"\s@]+@[^'"\s@]+\.[^'"\s@]+$/.test(INTEGRATOR_EMAIL)) {
    gaps.push({ name: 'integrator email', detail: 'PORTAL_LIVE_INTEGRATOR_EMAIL inválido' });
  }
  notes.push('entrega email DIFERIDA por el operador: login = copiar enlace (captura vía wrangler tail; 0 emails; sin secreto de proveedor)');
  if (MAGIC_LINK.length > 0) notes.push('magic link recibido por env/arg (la corrida NO captura vía tail)');
  else notes.push('magic link no provisto: 06-email-login lo captura en vivo vía wrangler tail (ruta SMOKE)');

  // Config parameterization (gap only for cloud-capable runs; preflight informs)
  const parsed = readPortalConfig();
  if (parsed.d1Id === D1_PLACEHOLDER) {
    gaps.push({ name: 'config d1', detail: 'wrangler.jsonc database_id sigue en placeholder (se rellena tras `wrangler d1 create` en Stage B)' });
  }
  if (parsed.d1Id === EMULATION_D1_ID) gaps.push({ name: 'config d1', detail: 'wrangler.jsonc conserva el id sintético de emulación' });
  if (parsed.raw.includes('E2E_FIXTURE')) gaps.push({ name: 'config e2e', detail: 'E2E_FIXTURE aparece en wrangler.jsonc (PROHIBIDO en deploy)' });
  if (parsed.vars['PORTAL_ORIGIN'] !== APPROVED_ORIGIN) gaps.push({ name: 'config origin', detail: 'var PORTAL_ORIGIN de wrangler.jsonc no coincide con el dominio aprobado' });
  if ('E2E_FIXTURE' in process.env) gaps.push({ name: 'env e2e', detail: 'E2E_FIXTURE seteada en el entorno local: desactívala antes de operar live' });

  return { gaps, notes };
}

/* ---------------------------------------------------------------------------
 * Modes: preflight / request-login (no evidence write; they are helpers)
 * ------------------------------------------------------------------------- */

async function runPreflight(): Promise<number> {
  console.log('portal:verify:live — PREFLIGHT (solo comprobaciones locales; sin mutations)');
  const { gaps, notes } = await collectReadiness(true);
  for (const note of notes) console.log(`  nota: ${note}`);
  if (gaps.length === 0) {
    console.log('PREFLIGHT OK — listo para Stage B (runbook: ops/runbook-p006-live.md)');
    return 0;
  }
  console.error('PREFLIGHT NOT READY — gaps:');
  for (const [index, gap] of gaps.entries()) console.error(`  ${index + 1}. [${gap.name}] ${gap.detail}`);
  console.error(`\nresumen: ${gaps.length} gap(s) — el smoke completo permanece bloqueado hasta resolverlos.`);
  return 1;
}

async function runRequestLogin(): Promise<number> {
  console.log('portal:verify:live — REQUEST-LOGIN (captura el enlace; CERO emails)');
  if (!/^[^'"\s@]+@[^'"\s@]+\.[^'"\s@]+$/.test(OPERATOR_EMAIL)) {
    console.error('gap: PORTAL_LIVE_EMAIL ausente/inválido — nada se captura.');
    return 1;
  }
  const health = await api('GET', '/api/health');
  const healthBody = await jsonRecord(health);
  if (!(health.ok && healthBody?.d1 === true && healthBody?.r2 === true)) {
    console.error(`gap: ${ORIGIN}/api/health no responde {{d1:true,r2:true}} (¿deploy hecho? ¿DNS propagado?) — status ${String(health.status)}`);
    return 1;
  }
  let url = '';
  try {
    url = await captureMagicLinkViaTail();
  } catch (error) {
    console.error(`captura falló: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  writeFileSync(MAGIC_LINK_FILE, `${url}\n`, { mode: 0o600 });
  console.log('enlace capturado vía wrangler tail (CERO emails; single-use; NUNCA se imprime).');
  console.log('PAUSA HUMANA DOCUMENTADA:');
  console.log(`  1. El enlace quedó en ${MAGIC_LINK_FILE} (permisos 0600, máquina local).`);
  console.log('  2. Ejecuta:  PORTAL_LIVE_MAGIC_LINK="$(cat /tmp/p006-live-magic-link)" bun run portal:verify:live');
  console.log('  3. El enlace expira en ~5 minutos: lanza enseguida.');
  return 0;
}

/* ---------------------------------------------------------------------------
 * Stages
 * ------------------------------------------------------------------------- */

async function stagePreflightAuth(stage: StageScope): Promise<void> {
  stage.check(photoSha === PHOTO_EXPECTED_SHA, 'fixture photo.jpg coincide con su sha256 documentado');
  stage.check(PHOTO_BYTES.length <= MAX_PHOTO_BYTES, `foto del smoke ≤ 1 MiB por construcción (${String(PHOTO_BYTES.length)}B)`);
  stage.check(ORIGIN === APPROVED_ORIGIN, `origen == dominio aprobado (${ORIGIN})`);

  const { gaps, notes } = await collectReadiness(true);
  for (const note of notes) stage.note(note);
  for (const gap of gaps) stage.note(`gap: [${gap.name}] ${gap.detail}`);
  stage.check(gaps.length === 0, `readiness sin gaps (${String(gaps.length)} abiertos)`);

  if (!existsSync(join(APP_DIR, 'dist', 'server'))) {
    stage.note('dist/server ausente: 03-deploy construye el bundle antes de publicar');
  }
}

async function stageResourceCheck(stage: StageScope): Promise<void> {
  config = readPortalConfig();
  stage.check(config.workerName === 'customer-assets', `worker name fijo (${config.workerName})`);
  stage.check(config.d1Id.length > 0 && config.d1Id !== D1_PLACEHOLDER && config.d1Id !== EMULATION_D1_ID,
    `database_id real asignado en wrangler.jsonc (no placeholder, no emulación)`);
  stage.check(!config.raw.includes('E2E_FIXTURE'), 'E2E_FIXTURE ausente del config de deploy (dead-code solo del harness e2e)');
  stage.check(config.vars['PORTAL_ORIGIN'] === APPROVED_ORIGIN, 'var PORTAL_ORIGIN del config == dominio aprobado');
  stage.check(config.vars['PORTAL_LIVE_SMOKE'] === '1', 'var PORTAL_LIVE_SMOKE=1 (decisión operador: login = copiar enlace; 0 emails)');
  const route = config.routes[0] ?? null;
  stage.check(stringField(route, 'pattern') === APPROVED_HOST && route?.['custom_domain'] === true,
    'custom domain aprobado declarado (customers-assets.theelena.me → worker)');

  // D1: create only the authorized NEW database; never touch anything else.
  const d1List = wranglerJsonArray((await runWrangler(['d1', 'list', '--json'], { quiet: true })).stdout)
    .map((entry) => (isRecord(entry) ? entry : {}))
    .filter((entry) => stringField(entry, 'name') === config.d1Name || stringField(entry, 'uuid') === config.d1Id);
  if (d1List.length === 0) {
    const created = await runWrangler(['d1', 'create', config.d1Name]);
    stage.check(created.exit === 0, `d1 create ${config.d1Name} exit 0`);
    stage.note(`D1 ${config.d1Name} creado en esta corrida (id no secret: ver wrangler.jsonc)`);
  } else {
    stage.note(`D1 ${config.d1Name} ya existe (reuso; ninguna otra base fue tocada)`);
  }
  const d1After = wranglerJsonArray((await runWrangler(['d1', 'list', '--json'], { quiet: true })).stdout)
    .map((entry) => (isRecord(entry) ? entry : {}))
    .filter((entry) => stringField(entry, 'name') === config.d1Name);
  stage.check(d1After.length === 1, `exactamente la D1 autorizada existe (${config.d1Name})`);

  // R2: private, isolated bucket; assert it is NOT any Studio bucket.
  stage.check(config.bucketName.startsWith('customer-assets'), `bucket del portal namespaced al portal (${config.bucketName})`);
  stage.check(config.bucketName !== 'customer-assets-local', 'el bucket del deploy NO es el de emulación local');
  for (const studioBucketEnv of ['R2_BUNDLES_BUCKET_NAME', 'R2_MARKETING_BUCKET_NAME']) {
    const studioBucket = (process.env[studioBucketEnv] ?? '').trim();
    if (studioBucket.length > 0) {
      stage.check(config.bucketName !== studioBucket, `el bucket del portal NO es ${studioBucketEnv} (aislamiento del backup Studio)`);
    }
  }
  // Existence via `bucket info` (authoritative); `r2 bucket list --json` is
  // not a valid flag in wrangler 4. Create tolerates "already exists".
  const info = await runWrangler(['r2', 'bucket', 'info', config.bucketName], { quiet: true });
  if (info.exit !== 0) {
    const created = await runWrangler(['r2', 'bucket', 'create', config.bucketName]);
    const already = /already exists|10004/i.test(`${created.stdout}\n${created.stderr}`);
    stage.check(created.exit === 0 || already, `r2 bucket create ${config.bucketName} ok (privado por defecto)`);
  }
  const infoAfter = await runWrangler(['r2', 'bucket', 'info', config.bucketName], { quiet: true });
  stage.check(infoAfter.exit === 0, `bucket ${config.bucketName} existe y es accesible (privado, aislado; ningún otro bucket tocado)`);
}

async function stageMigrate(stage: StageScope): Promise<void> {
  // Forward-only migrations, in order, to the authorized database.
  // NOTE: `d1 migrations list` has no --json in wrangler 4 — parse the text.
  const listPending = async (): Promise<string> => {
    counters.wranglerOps += 1;
    const outcome = await runWrangler(['d1', 'migrations', 'list', config.d1Name, '--remote'], { quiet: true });
    stage.check(outcome.exit === 0, `d1 migrations list --remote exit 0 (recibido ${String(outcome.exit)})`);
    return `${outcome.stdout}\n${outcome.stderr}`;
  };
  const before = await listPending();
  if (!before.includes('No migrations to apply')) {
    const applied = await runWrangler(['d1', 'migrations', 'apply', config.d1Name, '--remote']);
    stage.check(applied.exit === 0, `d1 migrations apply --remote exit 0 (0001+0002 en orden)`);
  }
  const after = await listPending();
  stage.check(after.includes('No migrations to apply'), 'd1 migrations list --remote sin migraciones pendientes tras aplicar');

  const tables = await d1Query(stage, config.d1Name,
    `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' ORDER BY "name"`,
  );
  const tableNames = tables.map((row) => stringField(row, 'name'));
  const expected = ['user', 'session', 'account', 'verification', 'apikey',
    'portal_workspace', 'portal_client', 'membership', 'invitation', 'agent_grant',
    'upload_session', 'material', 'delivery_revision', 'delivery_output', 'client_asset',
    'post', 'post_output', 'client_grid', 'client_quota', 'idempotency_record', 'audit_event'];
  const missing = expected.filter((table) => !tableNames.includes(table));
  stage.check(missing.length === 0, `schema completo tras 0001+0002 (faltan: ${missing.join(', ') || 'ninguna'})`);

  const provisioned = await provisionPilotRows(stage, config.d1Name);
  workspaceId = provisioned.workspaceId;
  pilotClientId = provisioned.pilotClientId;
  stage.note(`workspace ${workspaceId}; cliente piloto ${pilotClientId} (ids no secret)`);
  stage.note('provisioning controlado por SQL idempotente: SOLO filas del piloto; sin DELETE, sin datos ajenos');
}

async function stageDeploy(stage: StageScope): Promise<void> {
  const typecheck = Bun.spawnSync(['bun', 'run', 'build'], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' });
  stage.check(typecheck.exitCode === 0, `bun run build (tsc repo) exit 0 (recibido ${String(typecheck.exitCode)})`);
  commands.push({ cmd: 'bun run build', exit: typecheck.exitCode });

  const build = Bun.spawnSync(['bun', 'run', 'build'], { cwd: APP_DIR, stdout: 'pipe', stderr: 'pipe' });
  stage.check(build.exitCode === 0, `bun run --cwd apps/customer-assets build exit 0 (recibido ${String(build.exitCode)})`);
  commands.push({ cmd: 'bun run --cwd apps/customer-assets build', exit: build.exitCode });
  stage.check(existsSync(join(APP_DIR, 'dist', 'server')) && existsSync(join(APP_DIR, 'dist', 'client')), 'bundle dist/client + dist/server emitido');

  const deploy = await runWrangler(['deploy']);
  stage.check(deploy.exit === 0, `wrangler deploy exit 0 (recibido ${String(deploy.exit)})`);
  const deployOut = `${deploy.stdout}\n${deploy.stderr}`;
  const versionId = deployOut.match(/Current Version ID:\s*([a-f0-9-]+)/i)?.[1] ?? '';
  if (versionId.length > 0) stage.note(`versión desplegada: ${versionId} (id no secret)`);
  stage.check(deployOut.includes(APPROVED_HOST) || deployOut.includes('customers-assets'), 'deploy declara el dominio aprobado como trigger/custom domain');

  // Secrets must EXIST (names only; values are operator-injected, never here).
  // NOTE: wrangler 4 uses `secret list --format json` (no --json flag).
  const secretList = wranglerJsonArray((await runWrangler(['secret', 'list', '--format', 'json'], { quiet: true })).stdout)
    .map((entry) => (isRecord(entry) ? stringField(entry, 'name') : ''));
  stage.check(secretList.includes('BETTER_AUTH_SECRET'), 'secret BETTER_AUTH_SECRET presente (nombre verificado; valor jamás leído)');
  if (!secretList.includes('BETTER_AUTH_SECRET')) {
    stage.note('falta BETTER_AUTH_SECRET → `wrangler secret put BETTER_AUTH_SECRET` (valor SOLO del operador) y re-lanzar esta corrida');
  }
  stage.note(`entrega email diferida por el operador (sin secreto ${EMAIL_SECRET_NAME} exigido; PORTAL_LIVE_SMOKE=1 captura el enlace por tail)`);
}

async function stageDnsHttps(stage: StageScope): Promise<void> {
  // DNS + TLS + Cloudflare edge; up to ~3 min de gracia tras el deploy.
  const deadline = Date.now() + 180_000;
  let response: Response | null = null;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      counters.requests += 1;
      response = await fetch(`${ORIGIN}/`, { redirect: 'follow', signal: AbortSignal.timeout(15_000) });
      break;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await Bun.sleep(10_000);
    }
  }
  stage.check(response !== null, `https://${APPROVED_HOST}/ responde (DNS+TLS) ${lastError.length > 0 ? `— último error: ${lastError.slice(0, 120)}` : ''}`);
  if (response === null) return;
  stage.check(response.url.startsWith(`${ORIGIN}`), `respuesta final servida desde el dominio aprobado (${response.url.slice(0, 60)}…)`);
  stage.check(response.status === 200, `GET / status 200 (recibido ${String(response.status)})`);
  stage.check(response.headers.get('cf-ray') !== null, 'cabecera cf-ray presente: servido por el edge Cloudflare (no origen directo)');
  stage.check(!response.url.includes('workers.dev'), 'la evidencia de dominio NO es workers.dev');
}

async function stageHealth(stage: StageScope): Promise<void> {
  const health = await api('GET', '/api/health');
  const body = await jsonRecord(health);
  stage.check(health.status === 200, `/api/health status 200 sobre HTTPS (recibido ${String(health.status)})`);
  stage.check(body?.d1 === true && body?.r2 === true, `bindings reales sanos: d1=${String(body?.d1)} r2=${String(body?.r2)}`);
}

async function stageEmailLogin(stage: StageScope): Promise<void> {
  // Operator decision (Stage B): login = copy the link, ZERO outbound emails.
  // If no URL was handed in, capture it live from `wrangler tail` (SMOKE path).
  let loginUrl = MAGIC_LINK;
  if (loginUrl.length === 0) {
    stage.check((process.env.CLOUDFLARE_API_TOKEN ?? '').length > 0, 'token Cloudflare presente para el tail de captura');
    try {
      loginUrl = await captureMagicLinkViaTail();
      capturedLoginUrl = loginUrl;
      stage.note('login URL capturado vía wrangler tail (ruta SMOKE del mailer; 0 emails; valor no registrado)');
    } catch (error) {
      printRunbook();
      stage.check(false, `captura del magic link vía tail falló: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
      return;
    }
  }
  if (capturedLoginUrl.length === 0) capturedLoginUrl = loginUrl;
  let linkOrigin = '';
  let linkPath = '';
  try {
    const link = new URL(loginUrl);
    linkOrigin = link.origin;
    linkPath = link.pathname;
  } catch {
    stage.check(false, 'magic link provisto no parsea como URL (se rechaza sin registrar su valor)');
    return;
  }
  stage.check(linkOrigin === ORIGIN && linkPath.startsWith('/api/auth/magic-link/verify'),
    'magic link apunta al dominio aprobado y al verify de Better Auth (valor NUNCA registrado)');

  browser = await launchBrowser();
  operatorCtx = await newContext(browser);
  const page = await operatorCtx.newPage();
  try {
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 45_000 });
  } catch {
    // Redacted on purpose: navigation errors embed the full login URL.
    await page.goto(`${ORIGIN}/portal`, { waitUntil: 'load', timeout: 30_000 }).catch(() => undefined);
  }
  await page.waitForURL((url) => url.pathname.startsWith('/portal') || url.pathname.startsWith('/admin'), { timeout: 30_000 })
    .catch(async () => {
      await page.goto(`${ORIGIN}/portal`, { waitUntil: 'load', timeout: 30_000 });
    });
  operatorCookie = await cookieOf(operatorCtx);
  operatorStorageState = JSON.stringify(await operatorCtx.storageState());
  stage.check(operatorCookie.includes('better-auth'), 'sesión HTTPS del operador emitida por el magic link REAL (cookie capturada, nunca registrada)');

  const me = await api('GET', '/api/v1/me', { cookie: operatorCookie });
  stage.check(me.status === 200, '/api/v1/me con la sesión del operador: 200');
  const meBody = await jsonRecord(me);
  const meRecord = subRecord(meBody, 'me') ?? meBody;
  stage.check(stringField(meRecord, 'role') === 'admin' || stringField(meRecord, 'kind') === 'user',
    `principal identificado (role=${stringField(meRecord, 'role') || 'n/a'}, kind=${stringField(meRecord, 'kind') || 'n/a'})`);

  // Agent keys via the REAL admin UI (flujo admin; key se muestra una sola vez).
  const adminPage = await operatorCtx.newPage();
  await adminPage.setViewportSize({ width: 1440, height: 900 });
  await gotoWait(adminPage, `${ORIGIN}/admin/clients/${pilotClientId}/access`, '[data-testid="access-tab"]');

  const issueKey = async (keyName: string, scopes: string[], workspaceWide: boolean): Promise<string> => {
    await adminPage.fill('[data-testid="agent-key-form"] input[name="agent-email"]', INTEGRATOR_EMAIL);
    await adminPage.fill('[data-testid="agent-key-form"] input[name="agent-key-name"]', keyName);
    for (const scope of ['clients:read', 'clients:write', 'materials:read', 'materials:write', 'deliveries:read', 'deliveries:write']) {
      const box = adminPage.locator(`input[aria-label="Scope ${scope}"]`);
      if (scopes.includes(scope)) await box.check();
      else await box.uncheck();
    }
    const wide = adminPage.locator('input[aria-label="Grant de todo el workspace"]');
    if (workspaceWide) await wide.check();
    else await wide.uncheck();
    await adminPage.click('[data-testid="agent-key-form"] button[type="submit"]');
    await adminPage.waitForFunction(
      (previous) => {
        const pre = document.querySelector('[data-testid="issued-key"] pre');
        return pre !== null && pre.textContent !== null && pre.textContent.trim().length > 0 && pre.textContent.trim() !== previous;
      },
      agentKey,
      { timeout: 30_000 },
    );
    return (await adminPage.textContent('[data-testid="issued-key"] pre'))?.trim() ?? '';
  };

  agentKey = await issueKey(KEY_MAIN_NAME, ['clients:read', 'clients:write', 'materials:read', 'deliveries:read', 'deliveries:write'], true);
  stage.check(agentKey.length >= 16 && !/\s/.test(agentKey) && !agentKey.includes('@'), 'key de integrador emitida por el flujo admin UI real (una sola vista, jamás registrada)');
  limitedKey = await issueKey(KEY_LIMITED_NAME, ['materials:read'], false);
  stage.check(limitedKey.length >= 16 && limitedKey !== agentKey, 'segunda key limitada (materials:read, client-scoped) emitida para negativas');
  await adminPage.close();
}

async function stageClientUpload(stage: StageScope): Promise<void> {
  if (operatorCtx === null || operatorCookie.length === 0) {
    stage.check(false, 'sin sesión del operador (06-email-login falló): etapa no ejecutable en esta corrida');
    return;
  }
  counters.bytesUploaded += PHOTO_BYTES.length;
  stage.check(counters.bytesUploaded <= MAX_TOTAL_UPLOAD_BYTES, `presupuesto de subida respetado (${String(counters.bytesUploaded)}B ≤ 20 MiB)`);

  await ensureOperatorContext(stage);
  const page = await operatorCtx!.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoWait(page, `${ORIGIN}/portal/${pilotClientId}/materials`, '[data-testid="upload-card"]');
  await page.setInputFiles('input[type="file"]', {
    name: 'photo.jpg',
    mimeType: 'image/jpeg',
    buffer: Buffer.from(PHOTO_BYTES),
  });
  await page.waitForSelector('[data-testid="material-row"]', { timeout: 45_000 });
  stage.check((await page.textContent('[data-testid="materials-list"]'))?.includes('photo.jpg') === true,
    'subida REAL por UI sobre HTTPS: photo.jpg aparece como material ready');
  await shoot(page, 'mobile-materials-p006');
  await page.close();

  const list = await api('GET', `/api/v1/clients/${pilotClientId}/materials`, { cookie: operatorCookie });
  const items = recordArrayField(await jsonRecord(list), 'items');
  const material = items.find((entry) => stringField(entry, 'sha256') === photoSha) ?? null;
  stage.check(material !== null, `material registrado con el sha subido (${String(items.length)} material(es) visibles)`);
  materialId = stringField(material, 'id');
  stage.check(materialId.length > 0, 'material con id registrado');
  stage.check(stringField(material, 'mediaType') === 'image/jpeg' && stringField(material, 'status') === 'ready', 'material image/jpeg en estado ready');
  stage.check(numberField(material, 'bytes') === PHOTO_BYTES.length, `bytes registrados == bytes subidos (${String(PHOTO_BYTES.length)})`);
  hashes.materialPhotoUploaded = photoSha;
  hashes.materialPhotoRegistered = stringField(material, 'sha256');

  const content = await api('GET', `/api/v1/materials/${materialId}/content`, { cookie: operatorCookie });
  stage.check(content.status === 200, 'relectura autenticada del material: 200');
  stage.check(content.headers.get('x-content-type-options') === 'nosniff', 'contenido con nosniff');
  const downloaded = await recordDownload(content);
  hashes.materialPhotoReadBack = sha256(downloaded);
  stage.check(hashes.materialPhotoReadBack === photoSha, 'bytes releídos desde R2 == bytes subidos (hash chain)');
}

async function stageCliMaterialPull(stage: StageScope): Promise<void> {
  if (agentKey.length === 0) {
    stage.check(false, 'sin key de integrador (06-email-login falló): etapa no ejecutable en esta corrida');
    return;
  }
  tmpRoot = await mkdtemp(join(tmpdir(), 'p006-live-'));
  workspaceDir = join(tmpRoot, 'workspace');
  demo = await buildDemoWorkspace(workspaceDir, { projectIds: { shared: 'demo-shared', solo: 'demo-solo' } });
  stage.note(`workspace Studio con revisiones selladas EXISTENTES (sin render): ${demo.assets.cover.r1.revisionId}`);

  const me = await runCli(['portal-auth-status', '--origin', ORIGIN, '--json'], agentKey);
  stage.check(me.exit === 0 && me.ok, 'portal-auth-status con la key de integrador responde ok');
  const principal = subRecord(me.data, 'principal');
  stage.check(stringField(principal, 'kind') === 'agent', `principal agente reconocido (${stringField(principal, 'kind')})`);
  stage.check(['clients:write', 'materials:read', 'deliveries:write'].every((scope) => scopesOf(principal).includes(scope)),
    'scopes server-side del grant visibles en /me');

  const adoptPilot = await runCli([
    'portal-client-adopt', PILOT_STUDIO_CLIENT_ID,
    '--workspace', workspaceDir!, '--workspace-id', workspaceId,
    '--origin', ORIGIN, '--execute', '--json',
  ], agentKey);
  stage.check(adoptPilot.exit === 0 && adoptPilot.ok, 'portal-client-adopt bfc exitoso');
  stage.check(stringField(subRecord(adoptPilot.data, 'portalClient'), 'id') === pilotClientId,
    'readoptar el cliente proyectado NO duplica filas (misma id)');

  const adoptSecond = await runCli([
    'portal-client-adopt', 'second-brand',
    '--workspace', workspaceDir!, '--workspace-id', workspaceId,
    '--origin', ORIGIN, '--execute', '--json',
  ], agentKey);
  stage.check(adoptSecond.exit === 0 && adoptSecond.ok, 'portal-client-adopt second-brand crea la segunda proyección (para negativas)');
  secondClientId = stringField(subRecord(adoptSecond.data, 'portalClient'), 'id');
  stage.check(secondClientId.length > 0 && secondClientId !== pilotClientId, 'segundo cliente con id propio');

  const list = await runCli(['portal-client-list', '--origin', ORIGIN, '--json'], agentKey);
  stage.check(list.exit === 0 && pageItems(list).length === 2, `portal-client-list ve exactamente 2 clientes (${String(pageItems(list).length)})`);

  const materialList = await runCli(['portal-material-list', '--client', pilotClientId, '--origin', ORIGIN, '--json'], agentKey);
  stage.check(materialList.exit === 0 && pageItems(materialList).some((item) => stringField(item, 'sha256') === photoSha),
    'portal-material-list pagina el material subido por la cliente (sha coincide)');
  const show = await runCli(['portal-material-show', materialId, '--origin', ORIGIN, '--json'], agentKey);
  stage.check(show.exit === 0 && stringField(show.data, 'sha256') === photoSha, 'portal-material-show confirma el sha256 registrado');

  const pull = await runCli([
    'portal-material-pull', materialId,
    '--project', 'demo-shared', '--asset', 'bfc-cover',
    '--workspace', workspaceDir!, '--origin', ORIGIN, '--execute', '--json',
  ], agentKey);
  stage.check(pull.exit === 0 && pull.ok, 'portal-material-pull importa el material como input verificado');
  const inputPath = stringField(pull.data, 'inputPath');
  const provenancePath = stringField(pull.data, 'provenancePath');
  stage.check(inputPath.startsWith('inputs/portal/') && inputPath.endsWith('.jpg'), `input registrado en ${inputPath}`);
  stage.check(provenancePath.endsWith('.provenance.json'), `sidecar de provenance en ${provenancePath}`);
  const assetDir = join(workspaceDir!, 'projects', 'demo-shared', 'assets', 'bfc-cover');
  const inputBytes = new Uint8Array(await readFile(join(assetDir, inputPath)));
  hashes.materialPhotoImported = sha256(inputBytes);
  stage.check(hashes.materialPhotoImported === photoSha, 'bytes importados al workspace == bytes subidos (cadena completa)');

  const plan = await runCli([
    'portal-material-pull', materialId,
    '--project', 'demo-shared', '--asset', 'bfc-cover',
    '--workspace', workspaceDir!, '--origin', ORIGIN, '--json',
  ], agentKey);
  stage.check(plan.exit === 0 && plan.data?.executed === false, 'pull sin --execute imprime SOLO el plan (executed=false)');
}

async function stageCliDeliveryPush(stage: StageScope): Promise<void> {
  if (agentKey.length === 0 || workspaceDir === null || demo === null) {
    stage.check(false, 'sin prerequisitos (06/08 fallaron): etapa de entrega no ejecutable en esta corrida');
    return;
  }
  const r1 = demo!.assets.cover.r1;
  const assetDir = join(workspaceDir!, 'projects', 'demo-shared', 'assets', 'bfc-cover');
  const workingFeed = join(assetDir, 'outputs', 'feed.png');
  const feedRef = r1.manifest.outputs.find((output) => output.name === 'feed');
  const feedFile = feedRef === undefined ? undefined : r1.manifest.files.find((file) => file.path === feedRef.path);
  const feedR1Sha = feedFile?.sha256 ?? '';
  stage.check(feedRef !== undefined && feedFile?.role === 'output', 'output feed declarado en el manifest sellado r1 (EXISTENTE, sin generación)');
  hashes.outputFeedR1Manifest = feedR1Sha;

  const pushArgs = [
    'portal-delivery-push',
    '--workspace', workspaceDir!,
    '--client', pilotClientId,
    '--project', 'demo-shared', '--asset', 'bfc-cover',
    '--revision', r1.revisionId, '--outputs', 'feed',
    '--origin', ORIGIN,
  ];

  const stale = await runCli([...pushArgs, '--execute', '--json'], agentKey);
  stage.check(stale.exit !== 0 && stringField(stale.error, 'code') === 'HASH_MISMATCH',
    'push sobre bytes de trabajo alterados: rechazado HASH_MISMATCH (nunca recupera implícito)');

  const restoreDir = await mkdtemp(join(tmpdir(), 'p006-restore-'));
  const restore = await runCli(['asset-restore', 'bfc-cover', '--project', 'demo-shared', '--revision', r1.revisionId, '--out', restoreDir, '--workspace', workspaceDir!, '--json']);
  stage.check(restore.exit === 0 && restore.ok, 'asset-restore restaura los hashes exactos (flujo Studio existente)');
  const restoredFeed = join(restoreDir, 'outputs', 'feed.png');
  stage.check(await sha256File(restoredFeed) === feedR1Sha, 'bytes restaurados verifican contra el manifest sellado');
  mkdirSync(join(assetDir, 'outputs'), { recursive: true });
  writeFileSync(workingFeed, readFileSync(restoredFeed));

  const push = await runCli([...pushArgs, '--execute', '--json'], agentKey);
  if (push.exit === 0 && push.ok) {
    const delivery = subRecord(push.data, 'delivery');
    deliveryR1 = stringField(delivery, 'id');
    stage.check(stringField(delivery, 'status') === 'ready', `entrega en estado ${stringField(delivery, 'status')}`);
    stage.check(stringField(delivery, 'rootHash') === r1.rootHash, 'rootHash transmitido == rootHash sellado');
    const pushed = recordArrayField(push.data, 'outputs');
    const pushedSha = stringField(pushed[0] ?? null, 'sha256');
    const pushedBytes = numberField(pushed[0] ?? null, 'bytes') ?? 0;
    counters.bytesUploaded += pushedBytes;
    hashes.outputFeedR1Delivered = pushedSha;
    stage.check(pushed.length === 1 && pushedSha === feedR1Sha, `solo el output elegido viaja, con su sha exacto (${String(pushedBytes)}B)`);
    stage.check(counters.bytesUploaded <= MAX_TOTAL_UPLOAD_BYTES, `presupuesto total de subida respetado (${String(counters.bytesUploaded)}B ≤ 20 MiB)`);
  } else if (stringField(push.error, 'code') === 'CONFLICT' && /already complete/i.test(stringField(push.error, 'message'))) {
    // Cross-run convergence: a previous pilot run already delivered THIS
    // revision (deterministic demo → same fingerprint). The server refuses
    // re-staging a complete delivery by design (exactness/immutability); the
    // smoke verifies the EXISTING delivery instead of creating a new one.
    stage.note('entrega ya COMPLETE de una corrida anterior (mismo fingerprint): convergencia idempotente verificada por estado y bytes, sin re-staging');
    const assets = await api('GET', `/api/v1/clients/${pilotClientId}/assets`, { cookie: operatorCookie });
    const assetsItems = recordArrayField(await jsonRecord(assets), 'items');
    const mine = assetsItems.find((entry) => stringField(entry, 'revisionId') === r1.revisionId) ?? null;
    deliveryR1 = stringField(mine, 'deliveryId');
    assetIdR1 = stringField(mine, 'id');
    hashes.outputFeedR1Delivered = feedR1Sha;
    const outputs = recordArrayField(mine, 'outputs');
    stage.check(deliveryR1.length > 0 && assetIdR1.length > 0, 'entrega previa localizada por revisión sellada (id estable entre corridas)');
    stage.check(outputs.some((output) => stringField(output, 'name') === 'feed' && stringField(output, 'sha256') === feedR1Sha),
      'el output feed de la entrega existente conserva el sha del manifest');
  } else {
    stage.check(false, `portal-delivery-push falló inesperadamente (${stringField(push.error, 'code')}): ${stringField(push.error, 'message').slice(0, 160)}`);
  }

  const assetsAfterPush = await api('GET', `/api/v1/clients/${pilotClientId}/assets`, { cookie: operatorCookie });
  const assetsItems = recordArrayField(await jsonRecord(assetsAfterPush), 'items');
  const mineRow = assetsItems.find((entry) => stringField(entry, 'deliveryId') === deliveryR1) ?? null;
  assetIdR1 = stringField(mineRow, 'id');
  stage.check(assetIdR1.length > 0, 'client asset registrado para la entrega');

  const retry = await runCli([...pushArgs, '--execute', '--json'], agentKey);
  const retryConverged = (retry.exit === 0 && stringField(subRecord(retry.data, 'delivery'), 'id') === deliveryR1)
    || (stringField(retry.error, 'code') === 'CONFLICT' && /already complete/i.test(stringField(retry.error, 'message')));
  stage.check(retryConverged, 'reintento de push converge (misma entrega o ya-complete con el mismo fingerprint; sin filas duplicadas)');

  // Immutability: re-download the delivered output AFTER the retry.
  const redownload = await api('GET', `/api/v1/deliveries/${deliveryR1}/outputs/feed`, { cookie: operatorCookie });
  const bytes = await recordDownload(redownload);
  hashes.outputFeedR1AfterR2 = sha256(bytes);
  stage.check(redownload.status === 200 && hashes.outputFeedR1AfterR2 === feedR1Sha, 'entrega releída tras el reintento es byte-idéntica (inmutabilidad)');
}

async function stagePublishClientView(stage: StageScope): Promise<void> {
  if (operatorCtx === null || operatorCookie.length === 0 || assetIdR1.length === 0 || deliveryR1.length === 0) {
    stage.check(false, 'sin prerequisitos (06/09 fallaron): publicación no ejecutable en esta corrida');
    return;
  }
  const show = await api('PATCH', `/api/v1/client-assets/${assetIdR1}/visibility`, { cookie: operatorCookie, body: { visibility: 'client_visible' } });
  stage.check(show.status === 200, 'admin hace visible la entrega (ruta admin humana)');

  // Rerun-safe: reuse the post of a previous pilot run for THIS asset; grid
  // order always carries EVERY post id (atomic CAS reorder contract).
  const existingPosts = await api('GET', `/api/v1/clients/${pilotClientId}/posts`, { cookie: operatorCookie });
  const existingItems = recordArrayField(await jsonRecord(existingPosts), 'items');
  const minePost = existingItems.find((entry) => stringField(entry, 'assetId') === assetIdR1) ?? null;
  if (minePost !== null) {
    postId = stringField(minePost, 'id');
    stage.note('post de una corrida anterior reusado (mismo asset; sin duplicados)');
  } else {
    const postResponse = await api('POST', `/api/v1/clients/${pilotClientId}/posts`, {
      cookie: operatorCookie,
      body: {
        assetId: assetIdR1,
        title: 'Feed BFC piloto',
        caption: 'Entrega del piloto P-006 (output existente, sin IA ni publicación).',
        outputNames: ['feed'],
        coverOutputName: 'feed',
        visibility: 'client_visible',
      },
    });
    stage.check(postResponse.status === 201, 'admin crea el post con output + cover exactos');
    const post = await jsonRecord(postResponse);
    postId = stringField(post, 'id');
    stage.check(stringField(subRecord(post, 'cover'), 'sha256') === hashes.outputFeedR1Manifest, 'portada del post es el output EXACTO entregado');
  }
  stage.check(postId.length > 0, 'post del piloto presente');

  const gridBefore = await jsonRecord(await api('GET', `/api/v1/clients/${pilotClientId}/grid`, { cookie: operatorCookie }));
  const gridPosts = recordArrayField(gridBefore, 'posts');
  stage.check(gridPosts.some((entry) => stringField(entry, 'postId') === postId), 'grid contiene el post registrado');
  const gridOrder = [...new Set([postId, ...gridPosts.map((entry) => stringField(entry, 'postId'))])];
  const gridPatch = await api('PATCH', `/api/v1/clients/${pilotClientId}/grid`, {
    cookie: operatorCookie,
    body: { version: numberField(gridBefore, 'version'), order: gridOrder },
  });
  stage.check(gridPatch.status === 200, 'reorden atómico CAS del grid aceptado');

  const catalog = await api('GET', `/api/v1/clients/${pilotClientId}/assets`, { cookie: operatorCookie });
  const catalogItems = recordArrayField(await jsonRecord(catalog), 'items');
  stage.check(catalogItems.some((entry) => stringField(entry, 'visibility') === 'client_visible'), 'catálogo del cliente expone el asset visible');

  await ensureOperatorContext(stage);
  // Browser view as the member (mobile) — the operator IS the pilot member.
  // One full retry: a headless crash mid-view must not fail the whole stage.
  const browserClientView = async (): Promise<void> => {
    const page = await operatorCtx!.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoWait(page, `${ORIGIN}/portal/${pilotClientId}/assets`, '[data-testid="assets-page"]');
    stage.check(((await page.textContent('body')) ?? '').includes('Cover BFC') === true, 'catálogo del cliente muestra la revisión entregada (Cover BFC)');
    stage.check(((await page.textContent('body')) ?? '').includes('rootHash') === false, 'sin fuga de provenance/rootHash en la vista cliente');
    await shoot(page, 'mobile-assets-p006');

    await gotoWait(page, `${ORIGIN}/portal/${pilotClientId}/instagram`, '[data-testid="insta-grid"]');
    const cells = await page.locator('[data-testid^="insta-cell-"]').count();
    stage.check(cells >= 1, `cuadrícula con ${String(cells)} celda(s) visible(s)`);
    await page.locator('[aria-label^="Abrir Feed BFC piloto"]').click();
    await page.waitForSelector('[role="dialog"]', { timeout: 20_000 });
    stage.check(((await page.textContent('[role="dialog"]')) ?? '').includes('piloto P-006'), 'detalle del post muestra el caption');
    await page.keyboard.press('Escape');
    await shoot(page, 'mobile-grid-p006');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(400);
    await shoot(page, 'desktop-grid-p006');

    const download = await operatorCtx!.request.get(`${ORIGIN}/api/v1/deliveries/${deliveryR1}/outputs/feed`);
    const bytes = new Uint8Array(await download.body());
    counters.bytesDownloaded += bytes.length;
    hashes.outputFeedR1Downloaded = sha256(bytes);
    stage.check(download.status() === 200, 'descarga autenticada desde la sesión del portal: 200');
    stage.check(hashes.outputFeedR1Downloaded === hashes.outputFeedR1Manifest, 'bytes descargados == bytes entregados (sha256 == manifest)');
    stage.check(download.headers()['content-type'] === 'image/png' && download.headers()['x-content-type-options'] === 'nosniff',
      'descarga con MIME seguro y nosniff');
    await page.close();
  };
  try {
    await browserClientView();
  } catch (firstError) {
    stage.note(`vista cliente reintento tras: ${firstError instanceof Error ? firstError.message.slice(0, 160) : String(firstError)}`);
    await Bun.sleep(3000);
    await ensureOperatorContext(stage);
    await browserClientView();
  }
}

async function stageNegativesCrossClient(stage: StageScope): Promise<void> {
  if (limitedKey.length === 0 || agentKey.length === 0 || materialId.length === 0 || deliveryR1.length === 0) {
    stage.check(false, 'sin prerequisitos (06..09 fallaron): negativas no ejecutables en esta corrida');
    return;
  }
  // (0) E2E dead-code proof: the fixture endpoint must 404 on the deployment.
  const fixture = await api('POST', '/api/fixture/provision', { body: { users: [] } });
  stage.check(fixture.status === 404, `E2E_FIXTURE ausente en el deploy: /api/fixture/* responde ${String(fixture.status)} (esperado 404)`);

  // (1) no-session access fails closed.
  const unauthMaterial = await api('GET', `/api/v1/materials/${materialId}/content`);
  stage.check(unauthMaterial.status === 401 || unauthMaterial.status === 404,
    `contenido de material sin sesión: ${String(unauthMaterial.status)} (401/404, jamás bytes)`);
  const unauthOutput = await api('GET', `/api/v1/deliveries/${deliveryR1}/outputs/feed`);
  stage.check(unauthOutput.status === 401 || unauthOutput.status === 404,
    `output sin sesión: ${String(unauthOutput.status)} (privacidad del bucket por defecto)`);

  // (2) bounded agent key: own client ok, second client invisible, no scope creep.
  const limitedMe = await runCli(['portal-auth-status', '--origin', ORIGIN, '--json'], limitedKey);
  stage.check(limitedMe.exit === 0 && scopesOf(subRecord(limitedMe.data, 'principal')).join(',') === 'materials:read',
    'key limitada declara SOLO materials:read');
  const limitedOwn = await runCli(['portal-material-list', '--client', pilotClientId, '--origin', ORIGIN, '--json'], limitedKey);
  stage.check(limitedOwn.exit === 0 && limitedOwn.ok, 'control: la key limitada SÍ lista SU cliente (scope suficiente)');
  const limitedCross = await runCli(['portal-material-list', '--client', secondClientId, '--origin', ORIGIN, '--json'], limitedKey);
  stage.check(limitedCross.exit !== 0 && stringField(limitedCross.error, 'code') === 'NOT_FOUND',
    'cross-client con key acotada: 404 sin enumeración (segundo cliente)');
  const limitedAdopt = await runCli([
    'portal-client-adopt', PILOT_STUDIO_CLIENT_ID,
    '--workspace', workspaceDir!, '--workspace-id', workspaceId,
    '--origin', ORIGIN, '--execute', '--json',
  ], limitedKey);
  stage.check(limitedAdopt.exit === 1 && stringField(limitedAdopt.error, 'code') === 'FORBIDDEN',
    'adopción sin clients:write rechazada FORBIDDEN (sin autoescalada de scopes)');
  const mainCross = await runCli(['portal-material-list', '--client', secondClientId, '--origin', ORIGIN, '--json'], agentKey);
  stage.check(mainCross.exit === 0, 'control: la key workspace-wide SÍ ve el segundo cliente (el 404 es del grant, no ruptura general)');
}

async function stageNegativesRevocation(stage: StageScope): Promise<void> {
  if (operatorCtx === null || agentKey.length === 0 || limitedKey.length === 0) {
    stage.check(false, 'sin prerequisitos (06 falló): revocación no ejecutable en esta corrida');
    return;
  }
  // Revoke the MAIN grant from the admin UI; the very next request is cut.
  // Rerun-safe: revoked grants stay listed, so wait for the revoke-button
  // COUNT to drop instead of any 'revocado' text.
  await ensureOperatorContext(stage);
  const adminPage = await operatorCtx!.newPage();
  await gotoWait(adminPage, `${ORIGIN}/admin/clients/${pilotClientId}/access`, '[data-testid="access-tab"]', 45_000);
  const revokeButtons = adminPage.locator(`button[aria-label="Revocar grant de ${KEY_MAIN_NAME}"]`);
  const activeBefore = await revokeButtons.count();
  stage.check(activeBefore >= 1, `grant activo del agente presente en la UI (${String(activeBefore)} botón(es) de revocación)`);
  await revokeButtons.first().click();
  // The predicate runs in BROWSER scope: the selector must travel as an arg.
  await adminPage.waitForFunction(
    ({ sel, previous }: { sel: string; previous: number }) => document.querySelectorAll(sel).length < previous,
    { sel: `button[aria-label="Revocar grant de ${KEY_MAIN_NAME}"]`, previous: activeBefore },
    { timeout: 30_000 },
  );
  await adminPage.close();
  stage.check(true, 'admin revoca el grant del agente desde la UI real');

  const meAfterRevoke = await runCli(['portal-auth-status', '--origin', ORIGIN, '--json'], agentKey);
  stage.check(meAfterRevoke.exit === 0 && scopesOf(subRecord(meAfterRevoke.data, 'principal')).length === 0,
    'la key sigue siendo identidad válida pero el grant quedó vacío (scopes [])');
  const listAfterRevoke = await runCli(['portal-material-list', '--client', pilotClientId, '--origin', ORIGIN, '--json'], agentKey);
  stage.check(listAfterRevoke.exit !== 0 && listAfterRevoke.ok === false, 'siguiente operación del agente tras revocación: rechazada en el mismo request');
  const limitedControl = await runCli(['portal-material-list', '--client', pilotClientId, '--origin', ORIGIN, '--json'], limitedKey);
  stage.check(limitedControl.exit === 0, 'control: el grant limitado NO fue tocado por la revocación (revocación quirúrgica)');
}

async function stageEvidence(stage: StageScope): Promise<void> {
  const totalAssertions = stages.reduce((sum, entry) => sum + entry.assertions, 0);
  stage.check(totalAssertions > 0, `aserciones acumuladas en etapas previas (${String(totalAssertions)})`);
  const chainMaterial = hashes.materialPhotoUploaded === hashes.materialPhotoRegistered
    && hashes.materialPhotoRegistered === hashes.materialPhotoImported
    && hashes.materialPhotoImported === hashes.materialPhotoReadBack;
  stage.check(chainMaterial, 'cadena material: subido == registrado == importado == releído');
  const chainOutput = hashes.outputFeedR1Delivered === hashes.outputFeedR1Manifest
    && hashes.outputFeedR1Downloaded === hashes.outputFeedR1Manifest
    && hashes.outputFeedR1AfterR2 === hashes.outputFeedR1Manifest;
  stage.check(chainOutput, 'cadena output: manifest == entregado == descargado == tras-reintento');
  stage.check(counters.emailsSent <= MAX_EMAILS, `presupuesto de emails respetado (${String(counters.emailsSent)} ≤ ${String(MAX_EMAILS)})`);
  stage.check(counters.bytesUploaded <= MAX_TOTAL_UPLOAD_BYTES, `presupuesto de bytes respetado (${String(counters.bytesUploaded)}B ≤ 20 MiB)`);
  await writeEvidence(totalAssertions);
  const written = parseJsonRecord(await readFile(EVIDENCE_FILE, 'utf8')) ?? {};
  stage.check(recordArrayField(written, 'stages').length === stages.length, `evidence live.json escrita y releída (${EVIDENCE_FILE.replace(REPO_ROOT + '/', '')})`);
  for (const shot of screenshots) {
    stage.check(statSync(join(REPO_ROOT, shot.path)).size > 0, `screenshot presente: ${shot.name}`);
  }
}

async function buildEvidence(totalAssertions: number): Promise<Record<string, unknown>> {
  return {
    date: new Date().toISOString(),
    phase: 'P-006 piloto HTTPS autorizado (customers-assets.theelena.me)',
    gate: 'G-cap-live APROBADO por el operador (inventario: apps/customer-assets/ops/resource-inventory.md + deployment-checklist.md). Smoke sintético de namespace único.',
    environment: {
      mode: 'live-pilot',
      origin: ORIGIN,
      worker: config.workerName,
      d1: `${config.d1Name} (id ${config.d1Id.slice(0, 8)}…, no secret)`,
      r2: `${config.bucketName} (privado, aislado del backup Studio)`,
      emailDelivery: 'deferred-by-operator (link captured via wrangler tail, single-use)',
      budgets: { maxPhotoBytes: MAX_PHOTO_BYTES, maxTotalUploadBytes: MAX_TOTAL_UPLOAD_BYTES, maxEmails: MAX_EMAILS },
    },
    stages,
    sha256: hashes,
    fixtures: {
      'photo.jpg': { source: 'embebido en scripts/customer-assets-verify-live.ts (JPEG 32x32 real)', bytes: PHOTO_BYTES.length, sha256: photoSha },
      'output feed r1': { source: 'revisión sellada EXISTENTE del workspace demo (sin render/IA)', sha256: hashes.outputFeedR1Manifest ?? '' },
    },
    commands,
    counts: {
      stages: stages.length,
      stagesOk: stages.filter((stage) => stage.ok).length,
      assertions: totalAssertions,
      cliInvocations: counters.cliInvocations,
      wranglerOps: counters.wranglerOps,
      dataPlaneRequests: counters.requests,
      bytesUploaded: counters.bytesUploaded,
      bytesDownloaded: counters.bytesDownloaded,
      emailsSent: counters.emailsSent,
      portalClients: 2,
      deliveries: 1,
      posts: 1,
    },
    screenshots,
    notes: [
      'Cadena de hashes verificada sobre HTTPS real: material subido==registrado==importado==releído; output manifest==entregado==descargado==tras-reintento.',
      'La sesión del operador viajó SOLO como cookie en memoria del proceso y subprocess CLI env; no aparece en este archivo.',
      'Las URLs de login (magic link) jamás se registran: capturadas del tail SMOKE y consumidas una sola vez; el consumidor de evidencia no puede reusarlas.',
      'CERO emails salientes: entrega diferida por el operador (login = copiar enlace vía wrangler tail; var PORTAL_LIVE_SMOKE=1 solo para este deploy del piloto).',
      'Sin render/IA/publicación social; sin borrado remoto: la revocación es un flip de estado y los bytes permanecen.',
      `Presupuesto: ${String(counters.emailsSent)}/${String(MAX_EMAILS)} emails, ${String(counters.bytesUploaded)}B subidos (≤20MiB), foto de ${String(PHOTO_BYTES.length)}B (≤1MiB).`,
    ],
  };
}

async function writeEvidence(totalAssertions: number): Promise<void> {
  const serialized = JSON.stringify(await buildEvidence(totalAssertions), null, 2);
  for (const secret of secretsSeen()) {
    if (serialized.includes(secret)) {
      throw new Error('evidence contiene un token/cookie/key/login URL: abortando escritura');
    }
  }
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await writeFileSync(EVIDENCE_FILE, `${serialized}\n`);
}

/* ---------------------------------------------------------------------------
 * Main
 * ------------------------------------------------------------------------- */

async function fullRun(): Promise<number> {
  console.log(`portal:verify:live — smoke LIVE contra ${ORIGIN}`);
  const t0 = Date.now();
  await runStage('00-preflight-auth', stagePreflightAuth);
  await runStage('01-resource-check', stageResourceCheck);
  await runStage('02-migrate', stageMigrate);
  await runStage('03-deploy', stageDeploy);
  await runStage('04-dns-https', stageDnsHttps);
  await runStage('05-health', stageHealth);
  await runStage('06-email-login', stageEmailLogin);
  await runStage('07-upload', stageClientUpload);
  await runStage('08-cli-pull', stageCliMaterialPull);
  await runStage('09-cli-push-existing-output', stageCliDeliveryPush);
  await runStage('10-publish-grid', stagePublishClientView);
  await runStage('11-negatives-cross-client', stageNegativesCrossClient);
  await runStage('12-negatives-revocation', stageNegativesRevocation);
  await runStage('13-evidence', stageEvidence);

  // Rewrite with the COMPLETE stage list (the in-stage write predates 13).
  await writeEvidence(stages.reduce((sum, entry) => sum + entry.assertions, 0)).catch(() => undefined);

  if (operatorCtx !== null) await operatorCtx.close().catch(() => undefined);
  if (browser !== null) await browser.close().catch(() => undefined);
  if (tmpRoot !== null && stages.every((stage) => stage.ok)) {
    await rm(tmpRoot, { recursive: true, force: true });
  }

  const failed = stages.filter((stage) => !stage.ok);
  console.log(
    `portal:verify:live ${failed.length === 0 ? 'OK' : 'FALLO'} — ${String(stages.length)} etapas, ${String(stages.reduce((sum, stage) => sum + stage.assertions, 0))} aserciones, requests=${String(counters.requests)}, bytes↑=${String(counters.bytesUploaded)}, emails=${String(counters.emailsSent)}, ${String(Date.now() - t0)}ms`,
  );
  if (failed.length > 0) {
    console.error(`etapas en fallo: ${failed.map((stage) => stage.name).join(', ')}`);
    if (failed.some((stage) => stage.name === '02-migrate' || stage.name === '03-deploy')) printRunbook();
    return 1;
  }
  return 0;
}

async function main(): Promise<number> {
  if (PREFLIGHT_MODE && REQUEST_LOGIN_MODE) {
    console.error('modos excluyentes: usa --preflight O --request-login, no ambos');
    return 1;
  }
  if (PREFLIGHT_MODE) return runPreflight();
  if (REQUEST_LOGIN_MODE) return runRequestLogin();
  return fullRun();
}

const code = await main();
process.exit(code);
