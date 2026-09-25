/**
 * Declarative CLI runtime (FR-013): a small interpreter over `CommandSpec`.
 *
 * `runCli(argv, opts)` resolves the verb against the registry (`allSpecs`),
 * parses the declared args and dispatches:
 *   - `--plan` / `--dry-run` → plan mode: `plan(ctx)` only, steps printed.
 *     Plan mode NEVER touches the network or resolves credentials (NFR-002);
 *     `run()` is never invoked.
 *   - otherwise → `run(ctx)` for real.
 *
 * Exit codes: 0 ok, 1 command failure, 2 usage error (unknown verb, unknown
 * flag, missing required arg). Errors are written through the output sink.
 */
import { parseArgs, ArgParseError } from './args';
import {
  CommandFailure,
  createRegistry,
  formatCommandHelp,
  formatPlanSteps,
  formatRegistryHelp,
  makeContext,
} from './registry';
import { allSpecs } from './all-specs';
import type { CommandRegistry, CommandSpec } from './spec-types';

export interface RunCliOptions {
  /** Working directory of the CLI invocation. */
  cwd: string;
  /** Output sink (stdout). Never print secret values. */
  out?: (line: string) => void;
}

/** Flags interpreted by the runtime itself, never by a command spec. */
const RUNTIME_FLAGS: Record<string, true> = {
  '--plan': true,
  '--dry-run': true,
  '--help': true,
  '-h': true,
};

interface Invocation {
  verb: string | undefined;
  rest: string[];
  planMode: boolean;
  help: boolean;
}

function splitInvocation(argv: readonly string[]): Invocation {
  const invocation: Invocation = { verb: undefined, rest: [], planMode: false, help: false };
  for (const token of argv) {
    if (token === '--plan' || token === '--dry-run') {
      invocation.planMode = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      invocation.help = true;
      continue;
    }
    if (invocation.verb === undefined) invocation.verb = token;
    else invocation.rest.push(token);
  }
  return invocation;
}

/**
 * Generic interpreter over an explicit registry. Exported so tests and tools
 * can register ad-hoc specs at runtime and execute them through the exact
 * same path as `runCli` (declarativity evidence for FR-013).
 */
export async function runRegistry(
  registry: CommandRegistry,
  argv: readonly string[],
  opts: RunCliOptions,
): Promise<number> {
  const out = opts.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const invocation = splitInvocation(argv);

  if (invocation.verb === undefined || invocation.verb === 'help') {
    out(formatRegistryHelp(registry));
    return 0;
  }

  const spec = registry.get(invocation.verb);
  if (!spec) {
    const known = registry
      .list()
      .map((entry) => entry.verb)
      .join(', ');
    out(`error: verbo desconocido "${invocation.verb}". Verbs: ${known}.`);
    out('Usá `vm --help` para el registro completo.');
    return 2;
  }

  if (invocation.help) {
    out(formatCommandHelp(spec));
    return 0;
  }

  let args: Record<string, string | number | boolean | string[]>;
  try {
    args = parseArgs(spec.args, invocation.rest);
  } catch (error) {
    if (error instanceof ArgParseError) {
      out(`error: ${error.message}`);
      return 2;
    }
    throw error;
  }

  const mode = invocation.planMode ? ('plan' as const) : ('run' as const);
  const ctx = makeContext({ args, cwd: opts.cwd, mode, out });

  try {
    if (mode === 'plan') {
      if (!spec.supportsPlan) {
        out(`error: "${spec.verb}" no soporta modo plan (--plan/--dry-run).`);
        return 2;
      }
      // NFR-002: plan mode is pure — run() is never called here.
      const steps = await spec.plan(ctx);
      out(formatPlanSteps(spec.verb, steps));
      return 0;
    }
    const result = await spec.run(ctx);
    return result.exitCode;
  } catch (error) {
    if (error instanceof CommandFailure) {
      out(`error: ${error.message}`);
      return error.exitCode;
    }
    out(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** Same interpreter over a plain spec list. */
export async function runSpecs(
  specs: readonly CommandSpec[],
  argv: readonly string[],
  opts: RunCliOptions,
): Promise<number> {
  return runRegistry(createRegistry(specs), argv, opts);
}

/**
 * The CLI entry contract: `runCli(argv, { cwd, out? }) → exit code`.
 * Sibling command groups are discovered declaratively via `allSpecs()`.
 */
export async function runCli(argv: string[], opts: RunCliOptions): Promise<number> {
  return runSpecs(allSpecs(), argv, opts);
}
