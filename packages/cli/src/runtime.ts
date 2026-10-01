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
import {
  STUDIO_GROUP_SUBS,
  groupedVerbDisplay,
  isJsonModeArgv,
  isStudioGroupedVerb,
  normalizeGroupedVerb,
  studioArgvAdapter,
  studioEnvelopeError,
  studioEnvelopeOk,
} from './specs/studio-pairs';
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
  // Grouped studio invocations (`client create`, `asset snapshot`, …) resolve
  // to their internal verb BEFORE the registry lookup, via the exact
  // whitelist in ./specs/studio-pairs. Legacy single-token verbs are
  // unaffected (no legacy verb is a studio group). Global flags work the
  // same before or after the pair because runtime flags were already
  // stripped above and the subcommand must be the first remaining token.
  return normalizeGroupedVerb(invocation);
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
      .map((entry) => groupedVerbDisplay(entry.verb))
      .join(', ');
    const message = `verbo desconocido "${invocation.verb}". Verbs: ${known}.`;
    // JSON usage errors are a studio-group contract: only unrecognized
    // commands WITHIN known studio groups get the envelope. Legacy verbs
    // keep the classic text even when --json is present.
    const studioGroup = invocation.verb !== undefined && STUDIO_GROUP_SUBS[invocation.verb] !== undefined;
    if (studioGroup && isJsonModeArgv(invocation.rest)) {
      out(studioEnvelopeError({ code: 'INVALID_INPUT', message, details: { verb: invocation.verb } }));
    } else {
      out(`error: ${message}`);
      out('Usá `vm --help` para el registro completo.');
    }
    return 2;
  }

  if (invocation.help) {
    out(formatCommandHelp(spec));
    return 0;
  }

  let args: Record<string, string | number | boolean | string[]>;
  try {
    // Studio grouped specs enforce exact arity (at most one positional `<id>`)
    // BEFORE the generic parser; legacy specs keep parseArgs untouched.
    const restTokens = isStudioGroupedVerb(spec.verb)
      ? studioArgvAdapter(spec.args, invocation.rest)
      : invocation.rest;
    args = parseArgs(spec.args, restTokens);
  } catch (error) {
    if (error instanceof ArgParseError) {
      if (isStudioGroupedVerb(spec.verb) && isJsonModeArgv(invocation.rest)) {
        out(studioEnvelopeError({ code: 'INVALID_INPUT', message: error.message }));
      } else {
        out(`error: ${error.message}`);
      }
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
      // Studio groups with --json print ONLY the envelope (steps as data);
      // the human `plan:` rendering stays for everything else.
      if (isStudioGroupedVerb(spec.verb) && isJsonModeArgv(invocation.rest)) {
        out(studioEnvelopeOk({ verb: spec.verb, steps }));
      } else {
        out(formatPlanSteps(spec.verb, steps));
      }
      return 0;
    }
    const result = await spec.run(ctx);
    return result.exitCode;
  } catch (error) {
    if (error instanceof CommandFailure) {
      // `reported` failures already emitted their stable output (e.g. the
      // studio --json envelope); printing again would corrupt stdout.
      if (!error.reported) out(`error: ${error.message}`);
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
