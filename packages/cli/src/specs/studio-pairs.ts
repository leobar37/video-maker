/**
 * Group-dispatch contract for the studio CLI groups (contracts.md §6).
 *
 * New grouped invocations (`client create`, `asset snapshot`, …) are
 * normalized into internal kebab verbs (`client-create`, `asset-snapshot`)
 * BEFORE the registry is resolved, using an exact whitelist of pairs — never
 * an arbitrary concatenation of the second token, and never a `--flag` value.
 * `sync`/`dashboard` pairs are declared here so P-004/P-005 only add specs;
 * until those specs exist the registry answers "verbo desconocido" (exit 2),
 * never a fake success.
 *
 * This module is intentionally free of service imports so `runtime.ts` and
 * `registry.ts` can depend on it without import cycles.
 */
import { ArgParseError } from '../args';
import type { CommandArgSpec } from '../spec-types';

/**
 * Whitelist of exact `group sub` pairs, static lookup: `group → sub → true`.
 * Subcommand candidates are accepted only when this table says so; flag
 * tokens (leading `-`) are never candidates.
 */
export const STUDIO_GROUP_SUBS: Readonly<Record<string, Readonly<Record<string, true>>>> = {
  client: { create: true, list: true, show: true },
  preset: { create: true, list: true, show: true },
  project: { create: true, list: true, show: true, checkpoint: true },
  asset: {
    create: true,
    inspect: true,
    snapshot: true,
    history: true,
    diff: true,
    restore: true,
    render: true,
  },
  // Declared for P-004 (sync) and P-005 (dashboard): pairs exist, specs arrive
  // with their APIs. No placeholder specs are registered in the meantime.
  sync: { push: true, verify: true, recover: true },
  dashboard: { serve: true, url: true },
};

export interface GroupedInvocation {
  verb: string | undefined;
  rest: string[];
}

/**
 * Normalizes the exact pair `group sub` → `group-sub` before registry
 * lookup. The subcommand must be the FIRST remaining token, must be
 * whitelisted for the group and must not be a flag (so flag values can never
 * be consumed as subcommands). Everything else passes through untouched.
 */
export function normalizeGroupedVerb<I extends GroupedInvocation>(invocation: I): I {
  const { verb, rest } = invocation;
  if (verb === undefined || rest.length === 0) return invocation;
  const subs = STUDIO_GROUP_SUBS[verb];
  if (!subs) return invocation;
  const candidate = rest[0]!;
  if (candidate.startsWith('-') || subs[candidate] !== true) return invocation;
  return { ...invocation, verb: `${verb}-${candidate}`, rest: rest.slice(1) };
}

/** Display form of a verb: grouped pairs render as `group sub`, others as-is. */
export function groupedVerbDisplay(verb: string): string {
  const separator = verb.indexOf('-');
  if (separator <= 0) return verb;
  const group = verb.slice(0, separator);
  const sub = verb.slice(separator + 1);
  return STUDIO_GROUP_SUBS[group]?.[sub] === true ? `${group} ${sub}` : verb;
}

/** True for internal verbs of the studio groups (`client-create`, …). */
export function isStudioGroupedVerb(verb: string): boolean {
  const separator = verb.indexOf('-');
  if (separator <= 0) return false;
  return STUDIO_GROUP_SUBS[verb.slice(0, separator)]?.[verb.slice(separator + 1)] === true;
}

// ---------------------------------------------------------------------------
// Stable `--json` envelope (contracts.md §6)
// ---------------------------------------------------------------------------

export interface StudioEnvelopeError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/** Success envelope: `{ schemaVersion: 1, ok: true, data }`. */
export function studioEnvelopeOk(data: unknown): string {
  return JSON.stringify({ schemaVersion: 1, ok: true, data }, null, 2);
}

/** Error envelope: `{ schemaVersion: 1, ok: false, error: { code, message } }`. */
export function studioEnvelopeError(error: StudioEnvelopeError): string {
  return JSON.stringify({ schemaVersion: 1, ok: false, error }, null, 2);
}

/** Exit codes for studio commands: 0 ok, 1 operational failure, 2 input/usage. */
export const STUDIO_EXIT_OK = 0;
export const STUDIO_EXIT_OPERATIONAL = 1;
export const STUDIO_EXIT_USAGE = 2;

/** Studio error codes that describe bad input/usage (exit 2, not 1). */
const STUDIO_USAGE_ERROR_CODES: Record<string, true> = {
  INVALID_INPUT: true,
  NOT_FOUND: true,
  PATH_UNSAFE: true,
  SECRET_PATH: true,
};

export function studioExitCodeForError(code: string): number {
  return STUDIO_USAGE_ERROR_CODES[code] === true ? STUDIO_EXIT_USAGE : STUDIO_EXIT_OPERATIONAL;
}

/** True when the invocation asked for the stable JSON envelope (`--json`). */
export function isJsonModeArgv(rest: readonly string[]): boolean {
  return rest.some((token) => token === '--json' || token.startsWith('--json='));
}

// ---------------------------------------------------------------------------
// Strict arity for studio grouped specs (P-003 correction): AT MOST one
// positional — the spec's `id`, when declared — everything else must be
// flags. Generic `parseArgs`/legacy positional semantics are untouched; the
// runtime applies this adapter ONLY to studio-grouped specs, before parsing.
// ---------------------------------------------------------------------------

const BOOLEAN_LITERALS: ReadonlySet<string> = new Set(['true', 'false', '1', '0']);

/**
 * Transforms the single positional `<id>` into `--id=<value>` and rejects
 * extras and id duplication with `ArgParseError` (stable usage error, exit
 * 2). Flag tokens (including `--flag=value` and flag VALUES) are never
 * mistaken for positionals; unknown flags pass through so `parseArgs` keeps
 * being the authority for them. Grouped specs WITHOUT `id` (lists and the
 * future sync/dashboard commands) accept zero positionals.
 */
export function studioArgvAdapter(specArgs: readonly CommandArgSpec[], argv: readonly string[]): string[] {
  const idSpec = specArgs.find((arg) => arg.name === 'id');
  const specByName = new Map(specArgs.map((arg) => [arg.name, arg]));
  const out: string[] = [];
  let positionalId: string | null = null;
  let idByFlag = false;
  let expectValue = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (expectValue) {
      out.push(token);
      expectValue = false;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const arg = specByName.get(name);
      if (name === 'id') idByFlag = true;
      out.push(token);
      if (arg !== undefined && eq === -1) {
        if (arg.kind !== 'boolean') {
          expectValue = true;
        } else if (BOOLEAN_LITERALS.has(argv[index + 1] ?? '')) {
          expectValue = true;
        }
      }
      continue;
    }
    if (idSpec === undefined) {
      throw new ArgParseError(
        `"${token}" es posicional pero este comando no acepta posicionales (solo flags).`,
      );
    }
    if (positionalId !== null) {
      throw new ArgParseError(
        `Argumento posicional inesperado "${token}": este comando acepta a lo sumo <id> posicional; los demás valores van por --flag.`,
      );
    }
    positionalId = token;
  }

  if (positionalId !== null && idByFlag) {
    throw new ArgParseError(
      `El id llegó dos veces (posicional "${positionalId}" y --id); usá solo una forma.`,
    );
  }
  if (positionalId !== null) {
    out.unshift(`--id=${positionalId}`);
  }
  return out;
}
