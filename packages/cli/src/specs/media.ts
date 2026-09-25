/**
 * Media/pipeline command specs (FR-013): commands are DATA.
 *
 * `mediaSpecs` declares the seven production verbs — gen-audio, gen-music,
 * gen-media, still, assemble, qa, publish — with their args schema, the exact
 * plan steps they would run (targets, writes, gates moved, cost estimates) and
 * their run handlers. Plan mode is pure: NO network, NO credential resolution
 * (NFR-002) — only offline arg/fs inspection so a dry run works against a
 * freshly scaffolded project with zero artifacts. `run()` hard-refuses plan
 * mode; paid runs refuse to spend without an explicit `--spend-cap`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type {
  CommandArgSpec,
  CommandResult,
  CommandRunContext,
  CommandSpec,
  PlanStep,
} from '../spec-types';
import { defaultMediaDeps, type MediaCommandDeps } from '../pipeline/deps';
import { MissingSpendCapError, spendCapFromArgs } from '../pipeline/spend-ledger';
import {
  MUSIC_AUDIO_RELATIVE,
  NARRATION_META_RELATIVE,
  NARRATION_WAV_RELATIVE,
  runGenAudio,
  runGenMedia,
  runGenMusic,
  sceneMediaCandidates,
} from '../pipeline/generate';
import {
  DEFAULT_RENDER_OUT_DIR,
  DEFAULT_STILL_OUT_DIR,
  MUSIC_BED_CANDIDATES,
  runAssemble,
  runStill,
} from '../pipeline/assemble';
import { runQa } from '../pipeline/qa';
import { runPublish } from '../pipeline/publish';

/**
 * Planning-only cost estimates (NOT price quotes): they reserve budget in the
 * plan; the enforced limit is always the operator's explicit `--spend-cap`.
 */
const TTS_PLANNED_USD_PER_1K_CHARS = 0.3;
const MUSIC_PLANNED_USD_PER_TRACK = 0.5;

/**
 * The project-scoped argument: `--project <dir>`, flag or positional (the
 * runtime maps positionals to `required` args in declaration order), default
 * '.' so the flag is never mandatory. `required: true` is what makes
 * `vm qa <project>` positional work — with the default applied first it never
 * fails as "missing".
 */
const PROJECT_ARG: CommandArgSpec = {
  name: 'project',
  kind: 'string',
  required: true,
  default: '.',
  description: 'Project directory (relative to the invocation cwd).',
};

const SPEND_CAP_ARG: CommandArgSpec = {
  name: 'spend-cap',
  kind: 'number',
  description:
    'Hard spend cap in USD journalled against every submit of this run. ' +
    'REQUIRED before any paid submit in run mode.',
};

const ESTIMATED_COST_ARG: CommandArgSpec = {
  name: 'estimated-cost',
  kind: 'number',
  description:
    'Operator cost estimate in USD for one attempt (reservation only; overrides ' +
    'the built-in planning estimate).',
};

const FORCE_ARG: CommandArgSpec = {
  name: 'force',
  kind: 'boolean',
  default: false,
  description: 'Regenerate even when a verified artifact already exists.',
};

function argString(
  args: Record<string, string | number | boolean | string[]>,
  name: string,
): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function argNumber(
  args: Record<string, string | number | boolean | string[]>,
  name: string,
): number | undefined {
  const value = args[name];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function argBoolean(
  args: Record<string, string | number | boolean | string[]>,
  name: string,
  fallback: boolean,
): boolean {
  const value = args[name];
  return typeof value === 'boolean' ? value : fallback;
}

function argList(
  args: Record<string, string | number | boolean | string[]>,
  name: string,
): string[] | undefined {
  const value = args[name];
  if (!Array.isArray(value)) return undefined;
  const entries = value.filter((entry) => entry.trim().length > 0);
  return entries.length > 0 ? entries : undefined;
}

function projectDirOf(ctx: CommandRunContext): string {
  return resolve(ctx.cwd, argString(ctx.args, 'project') ?? '.');
}

/** run() MUST refuse to execute in plan mode (contract). */
function refusePlanMode(ctx: CommandRunContext, verb: string): never {
  return ctx.fail(
    `${verb}: run() refuses plan mode — run with --plan/--dry-run for the plan, ` +
      'without --plan to execute.',
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PlanProject {
  id: string;
  problem?: string;
  scenes: Array<{
    id: string;
    source: string;
    status: string;
    narrationChars: number;
    budgetUsd: number | null;
    durationSeconds: number | null;
  }>;
  ttsMode: string | undefined;
  narrationChars: number;
}

/** Offline project summary for planning: never throws, never touches the network. */
function readPlanProject(projectDir: string): PlanProject {
  const fallback: PlanProject = {
    id: '<id>',
    problem: 'no readable video.json yet',
    scenes: [],
    ttsMode: undefined,
    narrationChars: 0,
  };
  const manifestPath = join(projectDir, 'video.json');
  if (!existsSync(manifestPath)) return fallback;
  try {
    const config = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      id?: unknown;
      tts?: { mode?: unknown };
      scenes?: unknown;
    };
    const scenes: PlanProject['scenes'] = [];
    let narrationChars = 0;
    for (const entry of Array.isArray(config.scenes) ? config.scenes : []) {
      const scene = entry as {
        id?: unknown;
        source?: unknown;
        status?: unknown;
        narration?: unknown;
        falVideo?: { budgetUsd?: unknown };
        durationHint?: unknown;
      };
      const narration = typeof scene.narration === 'string' ? scene.narration.trim() : '';
      narrationChars += narration.length;
      scenes.push({
        id: typeof scene.id === 'string' ? scene.id : '<scene>',
        source: typeof scene.source === 'string' ? scene.source : 'motion',
        status: typeof scene.status === 'string' ? scene.status : 'active',
        narrationChars: narration.length,
        budgetUsd:
          typeof scene.falVideo?.budgetUsd === 'number' ? scene.falVideo.budgetUsd : null,
        durationSeconds: typeof scene.durationHint === 'number' ? scene.durationHint : null,
      });
    }
    return {
      id: typeof config.id === 'string' ? config.id : fallback.id,
      scenes,
      ttsMode: typeof config.tts?.mode === 'string' ? config.tts.mode : undefined,
      narrationChars,
    };
  } catch {
    return { ...fallback, problem: 'video.json is not valid JSON yet' };
  }
}

function existingFlag(projectDir: string, relative: string): string {
  return existsSync(join(projectDir, ...relative.split('/'))) ? '' : ' — MISSING (run first)';
}

function estimatedSpend(
  args: Record<string, string | number | boolean | string[]>,
  plannedUsd: number,
): number {
  return argNumber(args, 'estimated-cost') ?? Math.round(plannedUsd * 1e4) / 1e4;
}

export function buildMediaSpecs(deps: MediaCommandDeps = defaultMediaDeps()): CommandSpec[] {
  const now = () => new Date();

  const genAudio: CommandSpec = {
    verb: 'gen-audio',
    summary:
      'Synthesize the continuous narration master (one TTS request) with gap-free scene timings.',
    args: [PROJECT_ARG, SPEND_CAP_ARG, ESTIMATED_COST_ARG, FORCE_ARG],
    paid: true,
    supportsPlan: true,
    writes: ['script/audio/narration.wav', 'script/audio/narration.json', 'qa/spend.json'],
    movesGates: ['assets', 'spend'],
    plan(ctx): PlanStep[] {
      const projectDir = projectDirOf(ctx);
      const project = readPlanProject(projectDir);
      const costUsd = estimatedSpend(ctx.args, (project.narrationChars / 1000) * TTS_PLANNED_USD_PER_1K_CHARS);
      const modeNote =
        project.ttsMode === 'continuous' ? '' : ' — video.json tts.mode must be "continuous"';
      return [
        {
          action:
            `verify narration script (active scenes with text) in video.json${modeNote}` +
            `${project.problem !== undefined ? ` — ${project.problem}` : ''}`,
          target: 'video.json',
        },
        {
          action:
            `one continuous TTS synthesis (kind tts) → ${NARRATION_WAV_RELATIVE}` +
            `${existingFlag(projectDir, NARRATION_WAV_RELATIVE)}`,
          target: NARRATION_WAV_RELATIVE,
          writes: NARRATION_WAV_RELATIVE,
          costUsd,
        },
        {
          action:
            `derive gap-free scene timings + request fingerprint + wav sha256 → ` +
            `${NARRATION_META_RELATIVE}${existingFlag(projectDir, NARRATION_META_RELATIVE)}`,
          target: NARRATION_META_RELATIVE,
          writes: NARRATION_META_RELATIVE,
        },
        {
          action:
            'journal the paid attempt to qa/spend.json (submit-once: receipt proven or ' +
            'uncertain + blocked retry)',
          writes: 'qa/spend.json',
          gate: 'spend',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') return refusePlanMode(ctx, 'gen-audio');
      let spendCapUsd: number;
      try {
        spendCapUsd = spendCapFromArgs('gen-audio', ctx.args);
      } catch (error) {
        return ctx.fail(error instanceof MissingSpendCapError ? error.message : errorText(error));
      }
      try {
        await runGenAudio({
          projectDir: projectDirOf(ctx),
          deps,
          spendCapUsd,
          estimatedCostUsd: argNumber(ctx.args, 'estimated-cost') ?? null,
          force: argBoolean(ctx.args, 'force', false),
          now,
          out: ctx.out,
        });
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(errorText(error));
      }
    },
  };

  const genMusic: CommandSpec = {
    verb: 'gen-music',
    summary:
      'Music bed: $0 reuse from the music library (--use) or explicit paid generation (--generate).',
    args: [
      PROJECT_ARG,
      {
        name: 'use',
        kind: 'string',
        description: 'Library bed id/name to reuse ($0; copies it to script/audio/music.*).',
      },
      {
        name: 'generate',
        kind: 'boolean',
        default: false,
        description: 'Explicit opt-in to a PAID generation (never implicit).',
      },
      {
        name: 'provider',
        kind: 'string',
        description: 'Music provider for --generate: "elevenlabs" | "fal".',
      },
      { name: 'prompt', kind: 'string', description: 'Music prompt for --generate.' },
      {
        name: 'seconds',
        kind: 'number',
        description: 'Requested bed length in seconds (default 30).',
      },
      SPEND_CAP_ARG,
      ESTIMATED_COST_ARG,
      FORCE_ARG,
    ],
    paid: true,
    supportsPlan: true,
    writes: ['script/audio/music.*', 'qa/spend.json'],
    movesGates: ['assets', 'spend'],
    plan(ctx): PlanStep[] {
      const projectDir = projectDirOf(ctx);
      const reuse = argString(ctx.args, 'use');
      const generate = argBoolean(ctx.args, 'generate', false);
      if (reuse !== undefined && !generate) {
        return [
          {
            action:
              `reuse library bed "${reuse}" ($0; no submit, no journal) → ${MUSIC_AUDIO_RELATIVE}` +
              `${existingFlag(projectDir, MUSIC_AUDIO_RELATIVE)}`,
            target: MUSIC_AUDIO_RELATIVE,
            writes: MUSIC_AUDIO_RELATIVE,
            costUsd: 0,
          },
        ];
      }
      const provider = argString(ctx.args, 'provider') ?? '<provider>';
      return [
        {
          action:
            generate
              ? `paid music generation via ${provider} → ${MUSIC_AUDIO_RELATIVE}`
              : 'choose the bed source: --use <bed> (reuses $0) or --generate (paid)',
          target: MUSIC_AUDIO_RELATIVE,
          writes: MUSIC_AUDIO_RELATIVE,
          costUsd: estimatedSpend(ctx.args, MUSIC_PLANNED_USD_PER_TRACK),
        },
        {
          action: 'journal the paid attempt to qa/spend.json (submit-once)',
          writes: 'qa/spend.json',
          gate: 'spend',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') return refusePlanMode(ctx, 'gen-music');
      const generate = argBoolean(ctx.args, 'generate', false);
      let spendCapUsd = 0;
      if (generate) {
        try {
          spendCapUsd = spendCapFromArgs('gen-music', ctx.args);
        } catch (error) {
          return ctx.fail(error instanceof MissingSpendCapError ? error.message : errorText(error));
        }
      }
      try {
        const provider = argString(ctx.args, 'provider');
        await runGenMusic({
          projectDir: projectDirOf(ctx),
          deps,
          spendCapUsd,
          estimatedCostUsd: argNumber(ctx.args, 'estimated-cost') ?? null,
          force: argBoolean(ctx.args, 'force', false),
          now,
          out: ctx.out,
          generate,
          ...(argString(ctx.args, 'use') !== undefined ? { use: argString(ctx.args, 'use') } : {}),
          ...(provider === 'elevenlabs' || provider === 'fal' ? { provider } : {}),
          ...(argString(ctx.args, 'prompt') !== undefined
            ? { prompt: argString(ctx.args, 'prompt') }
            : {}),
          ...(argNumber(ctx.args, 'seconds') !== undefined
            ? { lengthSeconds: argNumber(ctx.args, 'seconds') }
            : {}),
        });
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(errorText(error));
      }
    },
  };

  const genMedia: CommandSpec = {
    verb: 'gen-media',
    summary: 'Generate scene media (fal video/avatar) into scenes/<id>/media/* with per-scene receipts.',
    args: [
      PROJECT_ARG,
      {
        name: 'scenes',
        kind: 'string[]',
        description: 'Scene ids to generate (default: every active fal-video/avatar scene).',
      },
      SPEND_CAP_ARG,
      ESTIMATED_COST_ARG,
      FORCE_ARG,
    ],
    paid: true,
    supportsPlan: true,
    writes: ['scenes/<id>/media/*', 'qa/spend.json'],
    movesGates: ['assets', 'spend'],
    plan(ctx): PlanStep[] {
      const projectDir = projectDirOf(ctx);
      const project = readPlanProject(projectDir);
      const selected = argList(ctx.args, 'scenes');
      const targets = project.scenes.filter(
        (scene) =>
          (scene.source === 'fal-video' || scene.source === 'avatar') &&
          scene.status === 'active' &&
          (selected === undefined || selected.includes(scene.id)),
      );
      const steps: PlanStep[] = targets.map((scene) => {
        const output = scene.source === 'fal-video'
          ? `scenes/${scene.id}/media/video.mp4`
          : `scenes/${scene.id}/media/avatar.mp4`;
        return {
          action:
            `submit one ${scene.source} job for scene "${scene.id}" (submit-once per idempotency ` +
            `key) → ${output}${existingFlag(projectDir, output)}`,
          target: output,
          writes: output,
          costUsd:
            argNumber(ctx.args, 'estimated-cost') ??
            (scene.budgetUsd !== null ? scene.budgetUsd : undefined),
        };
      });
      if (steps.length === 0) {
        steps.push({
          action:
            'no fal-video/avatar scenes selected — declare them in video.json or pass --scenes ' +
            `(available: ${project.scenes.map((scene) => scene.id).join(', ') || 'none yet'})`,
          target: 'video.json',
        });
      }
      steps.push({
        action:
          'journal each per-scene receipt to qa/spend.json through the core paid-operation engine ' +
          '(explicit --spend-cap enforced before any submit)',
        writes: 'qa/spend.json',
        gate: 'spend',
      });
      return steps;
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') return refusePlanMode(ctx, 'gen-media');
      let spendCapUsd: number;
      try {
        spendCapUsd = spendCapFromArgs('gen-media', ctx.args);
      } catch (error) {
        return ctx.fail(error instanceof MissingSpendCapError ? error.message : errorText(error));
      }
      try {
        await runGenMedia({
          projectDir: projectDirOf(ctx),
          deps,
          spendCapUsd,
          estimatedCostUsd: argNumber(ctx.args, 'estimated-cost') ?? null,
          force: argBoolean(ctx.args, 'force', false),
          now,
          out: ctx.out,
          ...(argList(ctx.args, 'scenes') !== undefined ? { scenes: argList(ctx.args, 'scenes') } : {}),
        });
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(errorText(error));
      }
    },
  };

  const still: CommandSpec = {
    verb: 'still',
    summary:
      'Render PNG stills through the render adapter with the SAME filmTimingPlan frame math as assemble.',
    args: [
      PROJECT_ARG,
      {
        name: 'scenes',
        kind: 'string[]',
        description: 'Scene ids to sample (default: every active scene).',
      },
      {
        name: 'frac',
        kind: 'number',
        default: 0.5,
        description: 'Position inside each scene span (0..1).',
      },
      {
        name: 'draft',
        kind: 'boolean',
        default: false,
        description: 'Preview before narration/media exist (durationHint timings).',
      },
      {
        name: 'out',
        kind: 'string',
        default: DEFAULT_STILL_OUT_DIR,
        description: 'Project-relative stills directory.',
      },
    ],
    paid: false,
    supportsPlan: true,
    writes: ['qa/stills/*.png'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const projectDir = projectDirOf(ctx);
      const project = readPlanProject(projectDir);
      const outDir = argString(ctx.args, 'out') ?? DEFAULT_STILL_OUT_DIR;
      const selected = argList(ctx.args, 'scenes');
      const scenes = selected ?? project.scenes.map((scene) => scene.id);
      return [
        {
          action:
            'stage project media into public/media/ and compose the film props from the ' +
            `narration timings${argBoolean(ctx.args, 'draft', false) ? ' (draft: durationHint timings)' : ''}`,
          target: 'public/media',
        },
        {
          action:
            'compute the shared frame math (filmTimingPlan / stillTimingInput) and sample one ' +
            `frame per scene${scenes.length > 0 ? ` (${scenes.join(', ')})` : ''}`,
          target: 'video.json',
        },
        ...scenes.map((sceneId) => ({
          action: `renderStill → ${outDir}/${sceneId}.png${existingFlag(projectDir, `${outDir}/${sceneId}.png`)}`,
          target: `${outDir}/${sceneId}.png`,
          writes: `${outDir}/${sceneId}.png`,
        })),
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') return refusePlanMode(ctx, 'still');
      try {
        await runStill({
          projectDir: projectDirOf(ctx),
          deps,
          frac: argNumber(ctx.args, 'frac') ?? 0.5,
          draft: argBoolean(ctx.args, 'draft', false),
          outDir: argString(ctx.args, 'out') ?? DEFAULT_STILL_OUT_DIR,
          now,
          out: ctx.out,
          ...(argList(ctx.args, 'scenes') !== undefined ? { scenes: argList(ctx.args, 'scenes') } : {}),
        });
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(errorText(error));
      }
    },
  };

  const assemble: CommandSpec = {
    verb: 'assemble',
    summary:
      'Assemble the film: narration timings → film props → renderMedia (h264) → ducking → ' +
      'loudnorm/ebur128 → renders/*.mp4 + evidence (qa/report.json, qa/loudness.json).',
    args: [
      PROJECT_ARG,
      {
        name: 'loudness',
        kind: 'boolean',
        default: true,
        description: 'Gate for the loudnorm/ebur128 normalization stage (default on).',
      },
      {
        name: 'out',
        kind: 'string',
        default: DEFAULT_RENDER_OUT_DIR,
        description: 'Project-relative renders directory.',
      },
    ],
    paid: false,
    supportsPlan: true,
    writes: ['renders/*.mp4', 'public/media/*', 'qa/report.json', 'qa/loudness.json'],
    movesGates: ['render', 'qa'],
    plan(ctx): PlanStep[] {
      const projectDir = projectDirOf(ctx);
      const project = readPlanProject(projectDir);
      const outDir = argString(ctx.args, 'out') ?? DEFAULT_RENDER_OUT_DIR;
      const mp4 = `${outDir}/${project.id}.mp4`;
      const narrationMissing =
        !existsSync(join(projectDir, ...NARRATION_META_RELATIVE.split('/'))) ||
        !existsSync(join(projectDir, ...NARRATION_WAV_RELATIVE.split('/')));
      const bed = MUSIC_BED_CANDIDATES.find((candidate) =>
        existsSync(join(projectDir, ...candidate.split('/'))),
      );
      return [
        {
          action:
            `verify the continuous narration master (${NARRATION_META_RELATIVE} + ` +
            `${NARRATION_WAV_RELATIVE}, wav sha256 vs fingerprint)` +
            (narrationMissing ? ' — MISSING: run "vm gen-audio" first' : ''),
          target: NARRATION_META_RELATIVE,
        },
        {
          action:
            'stage project media into public/media/ and compose the film props from the ' +
            'narration timings (gap-free scene spans)',
          target: 'public/media',
          writes: 'public/media/*',
        },
        {
          action:
            `renderMedia (h264/yuv420p) via the motion render adapter with the shared ` +
            `filmTimingPlan frame math → ${mp4}`,
          target: mp4,
          writes: mp4,
          gate: 'render',
        },
        {
          action:
            bed !== undefined
              ? `audio ducking: music bed ${bed} under the narration master (sidechain)`
              : `audio ducking: music bed (${MUSIC_BED_CANDIDATES.join(' | ')}) — no bed present; stage skipped`,
          target: bed ?? MUSIC_BED_CANDIDATES[0],
        },
        {
          action:
            `loudnorm/ebur128 normalization stage (gate: --loudness=${argBoolean(ctx.args, 'loudness', true)}) ` +
            'then independent measurement vs tolerance',
          target: mp4,
        },
        {
          action:
            'write evidence: qa/report.json (sha256 of every produced artifact + provenance of ' +
            'every input) and qa/loudness.json (measured loudness/true-peak vs tolerance)',
          writes: 'qa/report.json',
          gate: 'qa',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') return refusePlanMode(ctx, 'assemble');
      try {
        await runAssemble({
          projectDir: projectDirOf(ctx),
          deps,
          outDir: argString(ctx.args, 'out') ?? DEFAULT_RENDER_OUT_DIR,
          loudness: argBoolean(ctx.args, 'loudness', true),
          now,
          out: ctx.out,
        });
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(errorText(error));
      }
    },
  };

  const qa: CommandSpec = {
    verb: 'qa',
    summary:
      'Verify a finished render against its evidence: artifact hashes (tamper detection) + ' +
      'loudness/true-peak (ebur128) vs tolerance.',
    args: [
      PROJECT_ARG,
      {
        name: 'video',
        kind: 'string',
        description: 'Project-relative video to measure (default: the evidence report result.mp4).',
      },
    ],
    paid: false,
    supportsPlan: true,
    writes: ['qa/report.json', 'qa/loudness.json'],
    movesGates: ['qa'],
    plan(ctx): PlanStep[] {
      const projectDir = projectDirOf(ctx);
      const evidencePresent = existsSync(join(projectDir, 'qa', 'report.json'));
      return [
        {
          action:
            're-hash every recorded artifact against qa/report.json (blocked on any mismatch)' +
            (evidencePresent ? '' : ' — MISSING: run "vm assemble" first'),
          target: 'qa/report.json',
        },
        {
          action:
            'measure loudness/true-peak with ebur128 and compare vs the qa/loudness.json tolerance',
          target: argString(ctx.args, 'video') ?? 'renders/*.mp4',
        },
        {
          action: 'write the fresh verdicts to qa/report.json and qa/loudness.json',
          writes: 'qa/report.json',
          gate: 'qa',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') return refusePlanMode(ctx, 'qa');
      try {
        const result = await runQa({
          projectDir: projectDirOf(ctx),
          deps,
          now,
          out: ctx.out,
          ...(argString(ctx.args, 'video') !== undefined ? { video: argString(ctx.args, 'video') } : {}),
        });
        return { exitCode: result.exitCode };
      } catch (error) {
        return ctx.fail(errorText(error));
      }
    },
  };

  const publish: CommandSpec = {
    verb: 'publish',
    summary:
      'Publish/schedule via the Zernio Publisher port with a stable idempotency key, the spend ' +
      'gate and a per-attempt journal under qa/publication/<attempt>/journal.json.',
    args: [
      PROJECT_ARG,
      { name: 'account', kind: 'string', description: 'Publisher account handle.' },
      { name: 'text', kind: 'string', description: 'Post text.' },
      {
        name: 'media',
        kind: 'string[]',
        description: 'Public media URLs to attach.',
      },
      {
        name: 'schedule',
        kind: 'string',
        description: 'ISO timestamp: schedule instead of publishing now.',
      },
      { name: 'tags', kind: 'string[]', description: 'Post tags.' },
      {
        name: 'idempotency-key',
        kind: 'string',
        description:
          'Stable key for this publication (default: publish:<project>:<video sha>). One live ' +
          'post per key; 409 dedupe answers are accepted, never retried.',
      },
      SPEND_CAP_ARG,
      FORCE_ARG,
    ],
    paid: true,
    supportsPlan: true,
    writes: ['qa/publication/<attempt>/journal.json'],
    movesGates: ['publish'],
    plan(ctx): PlanStep[] {
      const projectDir = projectDirOf(ctx);
      const key = argString(ctx.args, 'idempotency-key') ?? 'publish:<project>:<video sha>';
      return [
        {
          action:
            'spend gate: refuse while qa/spend.json holds unresolved paid attempts ' +
            '(uncertain/submitted)',
          target: 'qa/spend.json',
          gate: 'spend',
        },
        {
          action:
            `validate the social post and submit ONCE to the publisher with idempotency key ` +
            `"${key}" (409 dedupe ⇒ accepted; no auto-retry without reconcile)`,
          costUsd: 0,
        },
        {
          action:
            'journal every attempt to qa/publication/<attempt>/journal.json (stages: preflight → ' +
            'submitted → complete on accepted/published)',
          writes: 'qa/publication/<attempt>/journal.json',
          gate: 'publish',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') return refusePlanMode(ctx, 'publish');
      let spendCapUsd: number;
      try {
        spendCapUsd = spendCapFromArgs('publish', ctx.args);
      } catch (error) {
        return ctx.fail(error instanceof MissingSpendCapError ? error.message : errorText(error));
      }
      const account = argString(ctx.args, 'account');
      const text = argString(ctx.args, 'text');
      if (account === undefined || text === undefined) {
        return ctx.fail('publish: --account and --text are required in run mode.');
      }
      try {
        const result = await runPublish({
          projectDir: projectDirOf(ctx),
          deps,
          account,
          text,
          media: argList(ctx.args, 'media') ?? [],
          idempotencyKey:
            argString(ctx.args, 'idempotency-key') ??
            `publish:${account}:${text.slice(0, 32)}`,
          spendCapUsd,
          force: argBoolean(ctx.args, 'force', false),
          now,
          out: ctx.out,
          ...(argString(ctx.args, 'schedule') !== undefined
            ? { scheduledFor: argString(ctx.args, 'schedule') }
            : {}),
          ...(argList(ctx.args, 'tags') !== undefined ? { tags: argList(ctx.args, 'tags') } : {}),
        });
        return { exitCode: result.exitCode };
      } catch (error) {
        return ctx.fail(errorText(error));
      }
    },
  };

  return [genAudio, genMusic, genMedia, still, assemble, qa, publish];
}

/** The registry's media/pipeline commands (FR-013). */
export const mediaSpecs: CommandSpec[] = buildMediaSpecs();

/** Re-exported so callers can resolve scene media paths the way gen-media does. */
export { sceneMediaCandidates };
