/**
 * Command registry (FR-013): commands are data. The registry holds the
 * `CommandSpec` declarations, rejects duplicate verbs and renders the help
 * views. Adding a command = registering a spec; the runtime interprets it.
 */
import type { CommandRegistry, CommandSpec, CommandRunContext, PlanStep } from './spec-types';
import { groupedVerbDisplay } from './specs/studio-pairs';

class Registry implements CommandRegistry {
  private readonly specs = new Map<string, CommandSpec>();

  register(spec: CommandSpec): void {
    if (this.specs.has(spec.verb)) {
      throw new Error(`Verb duplicado en el registro: "${spec.verb}".`);
    }
    if (spec.paid && !spec.supportsPlan) {
      throw new Error(
        `El comando "${spec.verb}" es paid: debe declarar supportsPlan: true (NFR-002).`,
      );
    }
    this.specs.set(spec.verb, spec);
  }

  get(verb: string): CommandSpec | undefined {
    return this.specs.get(verb);
  }

  list(): CommandSpec[] {
    return [...this.specs.values()];
  }
}

/** Builds a registry from a list of specs (duplicate verbs are an error). */
export function createRegistry(specs: readonly CommandSpec[]): CommandRegistry {
  const registry = new Registry();
  for (const spec of specs) registry.register(spec);
  return registry;
}

/** Registry listing: verb, summary and declared side effects. */
export function formatRegistryHelp(registry: CommandRegistry): string {
  const lines = ['vm — video maker production CLI (declarative registry)', '', 'Verbs:'];
  const displays = registry.list().map((spec) => groupedVerbDisplay(spec.verb));
  const width = Math.max(14, ...displays.map((display) => display.length));
  registry.list().forEach((spec, index) => {
    lines.push(`  ${displays[index]!.padEnd(width)} ${spec.summary}`);
  });
  lines.push(
    '',
    'Flags globales: --plan | --dry-run (plan mode: sin red ni credenciales), --help.',
    'Uso: vm <verbo> [--flag <valor> ...]. `vm <verbo> --help` muestra los argumentos.',
  );
  return lines.join('\n');
}

/** Per-command help: summary, args, writes and gates moved. */
export function formatCommandHelp(spec: CommandSpec): string {
  const lines = [`vm ${spec.verb} — ${spec.summary}`, '', 'Args:'];
  if (spec.args.length === 0) lines.push('  (sin argumentos)');
  for (const arg of spec.args) {
    const flag = `--${arg.name}`;
    const value = arg.kind === 'boolean' ? '' : ` <${arg.kind}>`;
    const defaults = arg.default !== undefined ? ` [default: ${JSON.stringify(arg.default)}]` : '';
    const required = arg.required ? ' (requerido)' : '';
    lines.push(`  ${`${flag}${value}`.padEnd(24)} ${arg.description}${defaults}${required}`);
  }
  lines.push('');
  lines.push(`Writes: ${spec.writes.length > 0 ? spec.writes.join(', ') : '(nada)'}`);
  lines.push(`Gates:  ${spec.movesGates.length > 0 ? spec.movesGates.join(', ') : '(ninguno)'}`);
  if (spec.paid) lines.push('Paid:   puede gastar dinero; usá --plan para previsualizar.');
  return lines.join('\n');
}

/** One-line-per-step plan rendering for plan mode and the `plan` verb. */
export function formatPlanSteps(verb: string, steps: readonly PlanStep[]): string {
  const lines = [`plan: ${verb} (${steps.length} pasos)`];
  for (const [index, step] of steps.entries()) {
    const parts = [`${index + 1}. ${step.action}`];
    if (step.target) parts.push(`target: ${step.target}`);
    if (step.writes) parts.push(`writes: ${step.writes}`);
    if (step.gate) parts.push(`gate: ${step.gate}`);
    if (step.costUsd !== undefined) parts.push(`cost: ~$${step.costUsd.toFixed(2)}`);
    lines.push(`   ${parts.join(' | ')}`);
  }
  return lines.join('\n');
}

/**
 * Builds a `CommandRunContext` for spec callbacks. `fail` throws a
 * `CommandFailure` the runtime translates into an exit code.
 */
export class CommandFailure extends Error {
  /**
   * When `reported` is true the failure already printed its stable output
   * (e.g. the studio --json envelope); the runtime must NOT print another
   * line over it. Legacy failures leave it false and print as always.
   */
  readonly reported: boolean;

  constructor(
    message: string,
    public readonly exitCode: number,
    options: { reported?: boolean } = {},
  ) {
    super(message);
    this.name = 'CommandFailure';
    this.reported = options.reported ?? false;
  }
}

export function makeContext(input: {
  args: Record<string, string | number | boolean | string[]>;
  cwd: string;
  mode: 'plan' | 'run';
  out: (line: string) => void;
}): CommandRunContext {
  return {
    args: input.args,
    cwd: input.cwd,
    mode: input.mode,
    out: input.out,
    fail: (message: string, code?: number): never => {
      throw new CommandFailure(message, code ?? 1);
    },
  };
}
