/**
 * resolver.ts — lazy, env-first credential resolution with `.env` and Doppler
 * fallback.
 *
 * Precedence for every name (per key, first hit wins):
 *   1. `process.env`
 *   2. the project `.env` (walked up from `process.cwd()`; pure read)
 *   3. Doppler: project `elena-tech`, config `prd`, downloaded as a JSON body
 *      of secrets via HTTP Basic auth (token as username, empty password)
 *
 * Doppler token source: env `DOPPLER_TOKEN_ELENA_TECH`, else the
 * `dopplerToken` field of `~/.config/elena-tech/config.json`.
 *
 * Resolution is lazy and refuses to run in plan mode: plan/dry runs must stay
 * offline and secret-free. Results (and the Doppler download) are cached in
 * memory for the lifetime of the process; `resetCredentialCache()` exists only
 * for tests. Secret values never appear in logs or errors — only `redact()`
 * output (name + length).
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';

import {
  CREDENTIAL_NAMES,
  R2_BUNDLES_BUCKET_NAME,
  R2_GENERIC_PAIR,
  R2_MARKETING_PAIR,
  R2_REQUIRED_NAMES,
  accountIdFromEndpoint,
  type R2Env,
  type SecretName,
} from './keys';

export const DOPPLER_TOKEN_ENV = 'DOPPLER_TOKEN_ELENA_TECH';
export const DOPPLER_PROJECT = 'elena-tech';
export const DOPPLER_CONFIG = 'prd';
const DOPPLER_DOWNLOAD_URL = 'https://api.doppler.com/v3/configs/config/secrets/download';
const GLOBAL_CONFIG_DISPLAY = '~/.config/elena-tech/config.json';

export type Mode = 'plan' | 'run';

export interface ResolveOptions {
  /** `plan` refuses to resolve (no network, no secrets); `run` resolves. */
  mode: Mode;
  /** Test seam: injected fetch, defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

const credentialCache = new Map<string, Resolved>();
let cachedR2Env: R2Env | undefined;
let cachedProjectEnv: Record<string, string> | undefined;
type DopplerState =
  | { status: 'secrets'; secrets: Record<string, string> }
  | { status: 'error'; error: Error };
let dopplerState: DopplerState | undefined;

/** Test-only: clears the in-memory cache between cases. */
export function resetCredentialCache(): void {
  credentialCache.clear();
  cachedR2Env = undefined;
  cachedProjectEnv = undefined;
  dopplerState = undefined;
}

/**
 * Redacted description of a secret: name + presence + length only. The value
 * itself is never included.
 */
export function redact(value: string | undefined, name = 'value'): string {
  const trimmed = value?.trim();
  if (!trimmed) return `${name}=<missing>`;
  return `${name}=<set length=${trimmed.length}>`;
}

/** Plan/dry runs must never resolve credentials; this is the hard stop. */
export function assertNotPlanMode(mode: Mode): void {
  if (mode === 'plan') {
    throw new Error(
      'Credential resolution is refused in plan mode: plan/dry runs must stay offline and secret-free.',
    );
  }
}

function globalConfigPath(): string | undefined {
  const home = process.env.HOME?.trim() || homedir();
  if (!home || home === '/' || !isAbsolute(home)) return undefined;
  return join(home, '.config', 'elena-tech', 'config.json');
}

/** Doppler token without printing or throwing it: env var or global config. */
function readDopplerToken(): string | undefined {
  const fromEnv = process.env[DOPPLER_TOKEN_ENV]?.trim();
  if (fromEnv) return fromEnv;
  const path = globalConfigPath();
  if (!path || !existsSync(path)) return undefined;
  try {
    // Only `dopplerToken` is read; the rest of the global config is irrelevant.
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { dopplerToken?: unknown };
    return typeof parsed.dopplerToken === 'string' && parsed.dopplerToken.trim()
      ? parsed.dopplerToken.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse an env file into key/value pairs. Minimal parser: `KEY=value`, strips
 * matched surrounding quotes. Pure: no `process.env` side effects.
 */
export function parseEnvFileValues(envPath: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  if (!existsSync(envPath)) return parsed;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[match[1]!] = value;
  }
  return parsed;
}

/** Project `.env`: first `.env` walking up from `process.cwd()`. */
function findProjectEnvFile(): string | undefined {
  let dir = resolvePath(process.cwd());
  for (;;) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Parsed project `.env` (empty when absent), read once per process. */
function readProjectEnv(): Record<string, string> {
  if (cachedProjectEnv) return cachedProjectEnv;
  const path = findProjectEnvFile();
  cachedProjectEnv = path ? parseEnvFileValues(path) : {};
  return cachedProjectEnv;
}

/** Removes the token from any text (leaky lower-layer errors) before throwing. */
function scrubToken(text: string, token: string): string {
  return token ? text.split(token).join('<redacted>') : text;
}

function downloadError(message: string, names: readonly string[], token: string): Error {
  return new Error(
    `${scrubToken(message, token)} ` +
      `Fix the Doppler token (${DOPPLER_TOKEN_ENV} or the "dopplerToken" field of ` +
      `${GLOBAL_CONFIG_DISPLAY}), or set ${names.join(', ')} directly in the environment.`,
  );
}

async function downloadDopplerSecrets(
  token: string,
  fetchImpl: typeof fetch,
  names: readonly string[],
): Promise<Record<string, string>> {
  const url = new URL(DOPPLER_DOWNLOAD_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('project', DOPPLER_PROJECT);
  url.searchParams.set('config', DOPPLER_CONFIG);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: {
        Authorization: `Basic ${Buffer.from(`${token}:`).toString('base64')}`,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    throw downloadError(
      `Doppler request failed for ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}: ${
        error instanceof Error ? error.message : 'network error'
      }.`,
      names,
      token,
    );
  }
  if (!response.ok) {
    throw downloadError(
      `Doppler responded HTTP ${response.status} for ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}.`,
      names,
      token,
    );
  }
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw downloadError(
      `Doppler returned an invalid JSON payload for ${DOPPLER_PROJECT}/${DOPPLER_CONFIG}.`,
      names,
      token,
    );
  }
  return Object.fromEntries(
    Object.entries(payload).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

/**
 * One Doppler download per process (success or failure is remembered).
 * Returns `undefined` only when no token is available at all.
 */
async function getDopplerSecrets(
  fetchImpl: typeof fetch,
  names: readonly string[],
): Promise<Record<string, string> | undefined> {
  if (dopplerState?.status === 'secrets') return dopplerState.secrets;
  if (dopplerState?.status === 'error') throw dopplerState.error;
  const token = readDopplerToken();
  if (!token) return undefined;
  try {
    const secrets = await downloadDopplerSecrets(token, fetchImpl, names);
    dopplerState = { status: 'secrets', secrets };
    return secrets;
  } catch (error) {
    const wrapped =
      error instanceof Error
        ? error
        : downloadError('Doppler request failed: unknown error.', names, token);
    dopplerState = { status: 'error', error: wrapped };
    throw wrapped;
  }
}

type ValueSource = 'process.env' | 'project .env' | 'Doppler';

interface Resolved {
  value?: string;
  source?: ValueSource;
}

/**
 * Per-key lookup: `process.env` beats the project `.env`, which beats Doppler.
 * Returns the winning source alongside the value (empty when the name resolves
 * nowhere); cached per process.
 */
async function lookupName(name: string, opts: ResolveOptions): Promise<Resolved> {
  const cached = credentialCache.get(name);
  if (cached) return cached;

  const fromEnv = process.env[name]?.trim();
  if (fromEnv) {
    const hit: Resolved = { value: fromEnv, source: 'process.env' };
    credentialCache.set(name, hit);
    return hit;
  }
  const fromFile = readProjectEnv()[name]?.trim();
  if (fromFile) {
    const hit: Resolved = { value: fromFile, source: 'project .env' };
    credentialCache.set(name, hit);
    return hit;
  }

  const secrets = await getDopplerSecrets(opts.fetchImpl ?? globalThis.fetch, [name]);
  const fromDoppler = secrets?.[name]?.trim();
  if (fromDoppler) {
    const hit: Resolved = { value: fromDoppler, source: 'Doppler' };
    credentialCache.set(name, hit);
    return hit;
  }
  return {};
}

/** Thrown when a secret exists nowhere (env, `.env` or Doppler); actionable, never leaks values. */
export class CredentialMissingError extends Error {
  readonly credential: string;

  constructor(name: string) {
    super(
      `${redact(undefined, name)}: not set in the environment or the project .env and not found ` +
        `in Doppler (${DOPPLER_PROJECT}/${DOPPLER_CONFIG}). Set ${name} directly in the ` +
        `environment, or provide a Doppler token via ${DOPPLER_TOKEN_ENV} or the ` +
        `"dopplerToken" field of ${GLOBAL_CONFIG_DISPLAY} so it can be downloaded from Doppler.`,
    );
    this.name = 'CredentialMissingError';
    this.credential = name;
  }
}

/**
 * Resolves a single credential name: env → project `.env` → Doppler. Lazy
 * (nothing is touched until called) and cached per process. Throws an
 * actionable error — never containing secret values — when nothing resolves.
 */
export async function resolveCredentials(
  provider: SecretName,
  opts: ResolveOptions,
): Promise<string> {
  assertNotPlanMode(opts.mode);
  const { value } = await lookupName(provider, opts);
  if (value !== undefined) return value;
  throw new CredentialMissingError(provider);
}

/**
 * Error for a half-declared or cross-source-mixed bucket/URL pair: the two
 * values are one declaration and mixing sources publishes 404 links.
 */
const PAIR_DECLARATION_ERROR =
  'R2_MARKETING_BUCKET_NAME and R2_MARKETING_PUBLIC_URL must be declared together and from ' +
  'the same source (the marketing bucket and its public URL are one pair). Declaring only one, ' +
  'or mixing sources with the generic pair (R2_BUCKET_NAME/R2_PUBLIC_URL), publishes URLs that ' +
  'answer 404.';

export interface R2Inspection {
  env?: R2Env;
  /** Names of the contract that resolved nowhere (actionable list). */
  missing: string[];
}

/**
 * R2 contract over resolved values, mirroring source `inspectMarketingEnv` and
 * `marketingEnvFromOrigins`: hard-fails when the bucket/public-URL pair is half
 * declared or mixed across sources, or when the accountId cannot be derived
 * from `R2_ENDPOINT`; otherwise reports exactly which names are missing so the
 * caller can try another source or abort.
 */
export async function inspectR2Env(opts: ResolveOptions): Promise<R2Inspection> {
  assertNotPlanMode(opts.mode);
  const resolved: Record<string, Resolved> = {};
  for (const name of [...R2_REQUIRED_NAMES, ...R2_MARKETING_PAIR]) {
    resolved[name] = await lookupName(name, opts);
  }

  const marketingBucket = resolved.R2_MARKETING_BUCKET_NAME.value;
  const marketingPublicUrl = resolved.R2_MARKETING_PUBLIC_URL.value;
  if (Boolean(marketingBucket) !== Boolean(marketingPublicUrl)) {
    throw new Error(PAIR_DECLARATION_ERROR);
  }

  const useMarketing = Boolean(marketingBucket);
  const bucketKey = useMarketing ? R2_MARKETING_PAIR[0] : R2_GENERIC_PAIR[0];
  const publicUrlKey = useMarketing ? R2_MARKETING_PAIR[1] : R2_GENERIC_PAIR[1];
  if (!useMarketing) {
    for (const name of R2_GENERIC_PAIR) {
      resolved[name] = await lookupName(name, opts);
    }
  }
  const bucketHit = resolved[bucketKey];
  const publicHit = resolved[publicUrlKey];
  // Bucket and URL must come from the SAME source: a bucket from one origin and
  // its URL from another is exactly the publish that ends in 404 links.
  if (bucketHit.value && publicHit.value && bucketHit.source !== publicHit.source) {
    throw new Error(PAIR_DECLARATION_ERROR);
  }

  const required = useMarketing ? [...R2_REQUIRED_NAMES] : [...R2_REQUIRED_NAMES, ...R2_GENERIC_PAIR];
  const missing = required.filter((name) => !resolved[name].value);
  if (missing.length > 0) return { missing };

  const bundles = await lookupName(R2_BUNDLES_BUCKET_NAME, opts);
  const endpoint = resolved.R2_ENDPOINT.value!.replace(/\/+$/, '');
  const accountId = accountIdFromEndpoint(endpoint);
  if (!accountId) {
    throw new Error(
      'Could not derive the accountId from R2_ENDPOINT (expected a host like ' +
        'https://<accountId>.r2.cloudflarestorage.com). Fix R2_ENDPOINT in the environment, ' +
        'the project .env, or Doppler.',
    );
  }

  return {
    env: {
      accountId,
      accessKeyId: resolved.R2_ACCESS_KEY_ID.value!,
      secretAccessKey: resolved.R2_SECRET_ACCESS_KEY.value!,
      bucket: bucketHit.value!,
      endpoint,
      publicUrl: publicHit.value!.replace(/\/+$/, ''),
      ...(bundles.value ? { bundlesBucket: bundles.value } : {}),
    },
    missing: [],
  };
}

function missingR2Error(missing: readonly string[]): Error {
  return new Error(
    `Missing required environment variables: ${missing.join(', ')}. ` +
      `Set them in the process environment, in the project .env, or in Doppler ` +
      `(token via ${DOPPLER_TOKEN_ENV} or the "dopplerToken" field of ${GLOBAL_CONFIG_DISPLAY}); ` +
      `resolved values are never printed.`,
  );
}

/**
 * Resolves the R2 environment (env → `.env` → Doppler, cached per process):
 * secrets + endpoint required, bucket/public URL per the marketing-pair rule,
 * `R2_BUNDLES_BUCKET_NAME` as an optional lookup. Throws with the exact list of
 * missing names when the contract is incomplete.
 */
export async function resolveR2Env(opts: ResolveOptions): Promise<R2Env> {
  assertNotPlanMode(opts.mode);
  if (cachedR2Env) return cachedR2Env;
  const { env, missing } = await inspectR2Env(opts);
  if (!env) throw missingR2Error(missing);
  cachedR2Env = env;
  return env;
}

export interface CredentialReportEntry {
  name: string;
  present: boolean;
  length: number;
}

/**
 * Redacted report over the resolvable credentials and the R2Env members
 * (labels `bucket`, `publicUrl` and derived `accountId`): presence + length
 * only. Never throws per name; refused in plan mode like every resolution.
 */
export async function credentialReport(opts: ResolveOptions): Promise<CredentialReportEntry[]> {
  assertNotPlanMode(opts.mode);
  const entries: CredentialReportEntry[] = [];
  const record = (name: string, value: string | undefined): void => {
    entries.push(
      value ? { name, present: true, length: value.length } : { name, present: false, length: 0 },
    );
  };

  for (const name of CREDENTIAL_NAMES) {
    let value: string | undefined;
    try {
      value = (await lookupName(name, opts)).value;
    } catch {
      value = undefined;
    }
    record(name, value);
  }

  // R2 members come from one value snapshot; a download failure leaves the
  // names that already resolved (env/.env) untouched and marks the rest missing.
  const snapshot: Record<string, string | undefined> = {};
  try {
    for (const name of [...R2_REQUIRED_NAMES, ...R2_MARKETING_PAIR, ...R2_GENERIC_PAIR]) {
      snapshot[name] = (await lookupName(name, opts)).value;
    }
  } catch {
    // Keep the partial snapshot.
  }
  for (const name of R2_REQUIRED_NAMES) record(name, snapshot[name]);
  record('bucket', snapshot.R2_MARKETING_BUCKET_NAME ?? snapshot.R2_BUCKET_NAME);
  record('publicUrl', snapshot.R2_MARKETING_PUBLIC_URL ?? snapshot.R2_PUBLIC_URL);
  const endpoint = snapshot.R2_ENDPOINT;
  record('accountId (derived)', endpoint ? accountIdFromEndpoint(endpoint) : undefined);
  return entries;
}
