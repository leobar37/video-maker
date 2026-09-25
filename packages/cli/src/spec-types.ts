/**
 * Declarative command contract (FR-013) — commands are DATA.
 *
 * A command is a `CommandSpec` in a registry: verb, args with schema, plan
 * mode, artifacts it writes, gates it moves. Adding a command = adding a spec
 * (plus its handler functions inside the spec object); NEVER a new script.
 * The runtime (`src/runtime.ts`, owned by CliRuntime) interprets specs.
 *
 * This file is the shared contract between the command-group implementations
 * and is FINAL — do not modify; import types from here (`./spec-types`).
 */
import type { GateName } from '@videomaker/core';

export type ArgKind = 'string' | 'number' | 'boolean' | 'string[]';

export interface CommandArgSpec {
  /** Long flag name, e.g. "project" → `--project`. */
  name: string;
  kind: ArgKind;
  required?: boolean;
  description: string;
  default?: string | number | boolean | string[];
}

export interface PlanStep {
  /** Human-readable planned action. */
  action: string;
  /** Path or public URL the step touches (NEVER secrets). */
  target?: string;
  /** Project-relative artifact this step writes. */
  writes?: string;
  /** Gate this step moves. */
  gate?: GateName;
  /** Estimated spend in USD for paid steps. */
  costUsd?: number;
}

export interface CommandRunContext {
  /** Parsed args per the spec's `args` schema (defaults applied). */
  args: Record<string, string | number | boolean | string[]>;
  /** Working directory of the CLI invocation. */
  cwd: string;
  /**
   * 'plan' | 'run'. `--plan`/`--dry-run` forces 'plan'.
   * In 'plan' the runtime calls `plan()` only: NO network, NO credential
   * resolution (NFR-002). `run()` MUST refuse to execute when mode is 'plan'.
   */
  mode: 'plan' | 'run';
  /** Output sink (stdout). Never print secret values. */
  out: (line: string) => void;
  /** Fail with an actionable message; must throw/exit with `code` (default 1). */
  fail: (message: string, code?: number) => never;
}

export interface CommandResult {
  exitCode: number;
  /** Plan steps produced (plan mode, or run mode when useful as a receipt). */
  planned?: PlanStep[];
}

export interface CommandSpec {
  /** CLI verb, e.g. "new", "assemble". Unique in the registry. */
  verb: string;
  summary: string;
  args: CommandArgSpec[];
  /** Command can spend money or touch the paid providers. */
  paid?: boolean;
  /** Whether the spec honors plan mode (must be true when `paid`). */
  supportsPlan: boolean;
  /** Artifacts the command writes (project-relative patterns, documentation). */
  writes: string[];
  /** Gates the command can move. */
  movesGates: GateName[];
  /** Pure planning: no network, no secrets. Returns the steps run() would do. */
  plan(ctx: CommandRunContext): Promise<PlanStep[]> | PlanStep[];
  /** Execute for real (mode 'run'). */
  run(ctx: CommandRunContext): Promise<CommandResult> | CommandResult;
}

export interface CommandRegistry {
  register(spec: CommandSpec): void;
  get(verb: string): CommandSpec | undefined;
  list(): CommandSpec[];
}
