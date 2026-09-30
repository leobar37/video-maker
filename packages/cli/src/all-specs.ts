/**
 * Registry composition (FR-013): combining the command groups is DATA
 * assembly, not wiring. Each group exports its `CommandSpec[]`; adding a
 * command means adding a spec there — never a new script.
 *
 * The tiny inline `version` spec proves the point: a complete command with no
 * dedicated module, registered and executed like every other.
 */
import { clipAnalysisSpecs, clipDecisionSpecs, clipRenderSpecs } from './specs/clip';
import { inspectSpecs } from './specs/inspect';
import { mediaSpecs } from './specs/media';
import { persistSpecs } from './specs/persist';
import { sceneSpecs } from './specs/scene';
import type { CommandSpec, PlanStep } from './spec-types';

export const CLI_VERSION = '0.1.0';

const versionSpec: CommandSpec = {
  verb: 'version',
  summary: 'Imprime la versión del CLI.',
  args: [],
  supportsPlan: true,
  writes: [],
  movesGates: [],
  plan(): PlanStep[] {
    return [];
  },
  run(ctx) {
    ctx.out(`vm ${CLI_VERSION}`);
    return { exitCode: 0 };
  },
};

/** Every command of the CLI, in display order. */
export function allSpecs(): CommandSpec[] {
  return [
    ...inspectSpecs,
    ...sceneSpecs,
    ...mediaSpecs,
    ...persistSpecs,
    ...clipAnalysisSpecs,
    ...clipDecisionSpecs,
    ...clipRenderSpecs,
    versionSpec,
  ];
}
