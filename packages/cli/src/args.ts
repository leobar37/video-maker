/**
 * Argument parsing and shared spec helpers for the declarative CLI runtime.
 *
 * Parsing is driven entirely by the `CommandArgSpec[]` declared on a
 * `CommandSpec`: flags (`--name value`, `--name=value`, bare `--flag` for
 * booleans) plus positional values for required args in declaration order.
 * Unknown flags and missing required args fail with actionable messages.
 */
import { promises as fsp } from 'node:fs';
import { resolve } from 'node:path';

import type { CommandArgSpec, CommandRunContext } from './spec-types';

/** Thrown for usage errors (unknown flag, missing required arg, bad value). */
export class ArgParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgParseError';
  }
}

export type ArgValue = string | number | boolean | string[];
export type ParsedArgs = Record<string, ArgValue>;

function usageHint(args: readonly CommandArgSpec[]): string {
  return args
    .map((arg) => {
      const flag = `--${arg.name}`;
      const value = arg.kind === 'boolean' ? '' : ` <${arg.kind}>`;
      return arg.required ? `${flag}${value}` : `[${flag}${value}]`;
    })
    .join(' ');
}

function coerce(spec: CommandArgSpec, raw: string): ArgValue {
  switch (spec.kind) {
    case 'string':
      return raw;
    case 'number': {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new ArgParseError(`--${spec.name} espera un número; recibido "${raw}".`);
      }
      return value;
    }
    case 'boolean': {
      if (raw === '' || raw === 'true' || raw === '1') return true;
      if (raw === 'false' || raw === '0') return false;
      throw new ArgParseError(`--${spec.name} espera true/false; recibido "${raw}".`);
    }
    case 'string[]':
      return raw;
  }
}

/**
 * Parses `argv` against a command's declared args. Returns the args record
 * with defaults applied. Throws `ArgParseError` with an actionable message on
 * any violation.
 */
export function parseArgs(
  specs: readonly CommandArgSpec[],
  argv: readonly string[],
): ParsedArgs {
  const byName = new Map<string, CommandArgSpec>();
  for (const spec of specs) {
    if (byName.has(spec.name)) {
      throw new ArgParseError(`El comando declara el argumento "${spec.name}" dos veces.`);
    }
    byName.set(spec.name, spec);
  }

  const values = new Map<string, ArgValue>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    const spec = byName.get(name);
    if (!spec) {
      throw new ArgParseError(
        `Flag desconocido --${name}. Flags válidos: ${[...byName.keys()].map((key) => `--${key}`).join(', ') || '(ninguno)'}.`,
      );
    }
    if (spec.kind === 'boolean') {
      if (eq !== -1) {
        values.set(name, coerce(spec, token.slice(eq + 1)) as boolean);
        continue;
      }
      // Bare `--flag` is true, but `--flag false` / `--flag 0` also work.
      const next = argv[index + 1];
      if (next === 'true' || next === 'false' || next === '1' || next === '0') {
        values.set(name, coerce(spec, next) as boolean);
        index += 1;
      } else {
        values.set(name, true);
      }
      continue;
    }
    let raw: string;
    if (eq !== -1) {
      raw = token.slice(eq + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new ArgParseError(`Falta el valor de --${name} <${spec.kind}>.`);
      }
      raw = next;
      index += 1;
    }
    if (spec.kind === 'string[]') {
      const current = values.get(name);
      values.set(name, [...(Array.isArray(current) ? current : []), raw]);
    } else {
      if (values.has(name)) {
        throw new ArgParseError(`--${name} se repite; se admite un solo valor.`);
      }
      values.set(name, coerce(spec, raw));
    }
  }

  // Positional values fill the declared args in DECLARATION ORDER (the
  // `project`-first convention holds across specs): booleans are flag-only and
  // args already set by a flag keep their value — the flag wins its slot and
  // the positional moves to the next unassigned arg. Required-arg enforcement
  // happens after defaults and positionals are applied.
  const unassigned = specs.filter((spec) => spec.kind !== 'boolean' && !values.has(spec.name));
  if (positionals.length > unassigned.length) {
    throw new ArgParseError(
      `Argumentos posicionales de más: ${positionals.slice(unassigned.length).join(', ')}. Uso: ${usageHint(specs)}`,
    );
  }
  for (const [index, raw] of positionals.entries()) {
    const spec = unassigned[index]!;
    values.set(spec.name, spec.kind === 'string[]' ? [raw] : coerce(spec, raw));
  }

  for (const spec of specs) {
    if (!values.has(spec.name)) {
      if (spec.default !== undefined) {
        values.set(spec.name, spec.default);
      } else if (spec.required) {
        throw new ArgParseError(
          `Falta el argumento requerido --${spec.name} <${spec.kind}> (${spec.description}).`,
        );
      }
    }
  }

  return Object.fromEntries(values);
}

// ---------------------------------------------------------------------------
// Shared spec helpers (project resolution and small fs utilities)
// ---------------------------------------------------------------------------

/**
 * The standard project-scoped argument: `--project <dir>`, optional, default
 * '.' — the project directory resolved against the invocation cwd.
 */
export const PROJECT_ARG: CommandArgSpec = {
  name: 'project',
  kind: 'string',
  required: false,
  default: '.',
  description: 'Directorio del proyecto (contiene video.json); relativo al cwd.',
};

/** The standard machine-readable-output argument (`--json`). */
export const JSON_ARG: CommandArgSpec = {
  name: 'json',
  kind: 'boolean',
  required: false,
  default: false,
  description: 'Salida JSON (para consumo programático).',
};

/** Resolves the `--project` argument against the invocation cwd. */
export function resolveProjectDir(ctx: Pick<CommandRunContext, 'args' | 'cwd'>): string {
  const value = ctx.args.project;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArgParseError('--project debe ser un directorio no vacío.');
  }
  return resolve(ctx.cwd, value);
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(path, 'utf8'));
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await fsp.writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fsp.stat(path);
    return true;
  } catch {
    return false;
  }
}
