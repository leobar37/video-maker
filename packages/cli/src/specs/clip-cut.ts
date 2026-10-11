/**
 * `clip-cut` — fast ffmpeg-only vertical cut from a local source.
 *
 * Reads a plan (`clips/clip-plan.json`: `{ clips: [{ id, startSec, endSec }] }`),
 * snaps every boundary to MEASURED silence (per window, ±`--pad` seconds) and
 * renders 1080x1920 H.264/AAC at −16 LUFS with a cover frame per clip.
 *
 * Plan mode reads only local files (no ffmpeg, no network, no secrets).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { defaultMediaDeps, type MediaCommandDeps } from '../pipeline/deps';
import {
  runClipCut,
  type ClipLayout,
  type SubtitleWord,
  type CutClipSpec,
  type CutClipResult,
} from '../pipeline/clip-cut';
import type {
  CommandArgSpec,
  CommandRunContext,
  CommandSpec,
  PlanStep,
} from '../spec-types';

const PROJECT: CommandArgSpec = {
  name: 'project',
  kind: 'string',
  required: true,
  description: 'Project directory that owns clips/ and renders/.',
};
const CLIP_PLAN: CommandArgSpec = {
  name: 'clip-plan',
  kind: 'string',
  description: 'Clip plan JSON, relative to the project (default clips/clip-plan.json). NOT the global --plan flag.',
};
const SOURCE: CommandArgSpec = {
  name: 'source',
  kind: 'string',
  description: 'Source video, relative to the project (default clips/source.mp4).',
};
const LAYOUT: CommandArgSpec = {
  name: 'layout',
  kind: 'string',
  description: "'blur' (full frame on a blurred backdrop) or 'crop' (9:16 fill). Default blur.",
};
const WIDTH: CommandArgSpec = { name: 'width', kind: 'number', description: 'Output width (default 1080).' };
const HEIGHT: CommandArgSpec = { name: 'height', kind: 'number', description: 'Output height (default 1920).' };
const CROP_OFFSET: CommandArgSpec = {
  name: 'crop-offset',
  kind: 'number',
  description: 'Horizontal anchor for --layout crop: 0 left, 50 center, 100 right (default 50).',
};
const MAX_DURATION: CommandArgSpec = {
  name: 'max-duration',
  kind: 'number',
  description: 'Hard cap on clip duration in seconds (default 90).',
};
const PAD: CommandArgSpec = {
  name: 'pad',
  kind: 'number',
  description: 'Seconds measured around each window for silence detection (default 8).',
};
const WORDS: CommandArgSpec = {
  name: 'words',
  kind: 'string',
  description: 'Word timestamps JSON for burned-in captions ({words:[{t,end,text}]}), project-relative.',
};
const JOBS: CommandArgSpec = {
  name: 'jobs',
  kind: 'number',
  description: 'Clips rendered concurrently (default 1; ffmpeg is CPU-bound).',
};
const PEAKS: CommandArgSpec = {
  name: 'peaks',
  kind: 'string',
  description: 'Reaction peaks JSON for cover picking ({events:[{peakSec,riseDb}]}).',
};

interface PlanFile {
  clips?: unknown;
}

function projectOf(ctx: CommandRunContext): string {
  if (typeof ctx.args.project !== 'string' || !ctx.args.project.trim()) {
    return ctx.fail('--project is required', 2);
  }
  return resolve(ctx.cwd, ctx.args.project);
}

function relOf(ctx: CommandRunContext, name: string, fallback: string): string {
  const value = ctx.args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) return ctx.fail(`--${name} must be a non-empty string`, 2);
  if (value.startsWith('/') || value.includes('..')) {
    return ctx.fail(`--${name} must be a project-relative path without ".."`);
  }
  return value;
}

function numberOf(ctx: CommandRunContext, name: string, fallback: number): number {
  const value = ctx.args[name];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) return ctx.fail(`--${name} must be a number`, 2);
  return value;
}

async function readClips(ctx: CommandRunContext, path: string): Promise<CutClipSpec[]> {
  let parsed: PlanFile;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as PlanFile;
  } catch (error) {
    return ctx.fail(
      `cannot read clip plan ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const raw = Array.isArray(parsed.clips) ? parsed.clips : [];
  const clips: CutClipSpec[] = [];
  for (const entry of raw) {
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.startSec !== 'number' || typeof record.endSec !== 'number') {
      return ctx.fail(`clip plan ${path} has an entry without {id, startSec, endSec}`);
    }
    clips.push({ id: record.id, startSec: record.startSec, endSec: record.endSec });
  }
  if (clips.length === 0) return ctx.fail(`clip plan ${path} has no clips`);
  return clips;
}

async function readWords(
  ctx: CommandRunContext,
  project: string,
  relative: string | undefined,
): Promise<SubtitleWord[]> {
  if (!relative) return [];
  try {
    const parsed = JSON.parse(await readFile(resolve(project, relative), 'utf8')) as { words?: SubtitleWord[] };
    if (!Array.isArray(parsed.words)) return ctx.fail(`words ${relative} has no "words" array`);
    return parsed.words.filter(
      (word) => typeof word?.t === 'number' && typeof word?.end === 'number' && typeof word?.text === 'string',
    );
  } catch (error) {
    return ctx.fail(`cannot read words ${relative}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** True for a missing file (Node `ENOENT`), used to treat optional inputs as absent. */
function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

async function readPeaks(
  ctx: CommandRunContext,
  project: string,
  relative: string | undefined,
): Promise<{ peakSec: number; riseDb: number }[]> {
  if (!relative) return [];
  try {
    const parsed = JSON.parse(await readFile(resolve(project, relative), 'utf8')) as {
      events?: { peakSec?: unknown; riseDb?: unknown }[];
    };
    return (parsed.events ?? [])
      .filter((e) => typeof e.peakSec === 'number' && typeof e.riseDb === 'number')
      .map((e) => ({ peakSec: e.peakSec as number, riseDb: e.riseDb as number }));
  } catch (error) {
    // The reaction signal is optional: an absent file simply means "no peaks".
    if (isMissingFile(error)) return [];
    return ctx.fail(`cannot read peaks ${relative}`);
  }
}

function layoutOf(ctx: CommandRunContext): ClipLayout {
  const value = ctx.args.layout;
  if (value === undefined) return 'blur';
  if (value === 'blur' || value === 'crop') return value;
  return ctx.fail("--layout must be 'blur' or 'crop'", 2);
}

export function buildClipCutSpecs(deps: MediaCommandDeps = defaultMediaDeps()): CommandSpec[] {
  const cut: CommandSpec = {
    verb: 'clip-cut',
    summary:
      'Cut 9:16 clips from a local source with ffmpeg: boundaries snapped to measured silence, loudness normalized, cover per clip.',
    args: [PROJECT, CLIP_PLAN, SOURCE, LAYOUT, WIDTH, HEIGHT, CROP_OFFSET, MAX_DURATION, PAD, WORDS, JOBS, PEAKS],
    supportsPlan: true,
    writes: ['renders/clips/*.mp4', 'renders/clips/*.png', 'renders/clips/manifest.json'],
    movesGates: [],
    async plan(ctx): Promise<PlanStep[]> {
      const project = projectOf(ctx);
      const planPath = resolve(project, relOf(ctx, 'clip-plan', 'clips/clip-plan.json'));
      const sourcePath = resolve(project, relOf(ctx, 'source', 'clips/source.mp4'));
      const clips = await readClips(ctx, planPath);
      const layout = layoutOf(ctx);
      const width = numberOf(ctx, 'width', 1080);
      const height = numberOf(ctx, 'height', 1920);
      return [
        {
          action: `Cut ${clips.length} clip(s) at ${width}x${height} with layout ${layout}; snap each boundary to measured silence (±${numberOf(ctx, 'pad', 8)} s per window) and normalize to −16 LUFS.`,
          target: `${project}/renders/clips`,
        },
        { action: `Source ${sourcePath}; plan ${planPath}. Plan mode runs no ffmpeg and reads no secrets.` },
      ];
    },
    async run(ctx) {
      if (ctx.mode === 'plan') return ctx.fail('clip-cut refuses side effects in plan mode', 2);
      const project = projectOf(ctx);
      const sourcePath = resolve(project, relOf(ctx, 'source', 'clips/source.mp4'));
      const planPath = resolve(project, relOf(ctx, 'clip-plan', 'clips/clip-plan.json'));
      const clips = await readClips(ctx, planPath);
      const peaks = await readPeaks(ctx, project, relOf(ctx, 'peaks', 'source/reactions.json'));
      const wordsRelative =
        typeof ctx.args.words === 'string' && ctx.args.words.trim() ? relOf(ctx, 'words', '') : undefined;
      const words = await readWords(ctx, project, wordsRelative);
      try {
        const results = await runClipCut(deps.process, project, sourcePath, clips, {
          layout: layoutOf(ctx),
          width: numberOf(ctx, 'width', 1080),
          height: numberOf(ctx, 'height', 1920),
          cropOffsetPercent: numberOf(ctx, 'crop-offset', 50),
          maxDurationSec: numberOf(ctx, 'max-duration', 90),
          padSec: numberOf(ctx, 'pad', 8),
          jobs: numberOf(ctx, 'jobs', 1),
          peaks,
          ...(words.length > 0 ? { words } : {}),
        });
        const manifest = {
          schemaVersion: 1,
          source: sourcePath,
          layout: layoutOf(ctx),
          clips: results satisfies CutClipResult[],
        };
        const manifestPath = resolve(project, 'renders/clips/manifest.json');
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        ctx.out(`clip-cut: ${results.length} clip(s) -> ${manifestPath}`);
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(`clip-cut: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  return [cut];
}

/** The registry's fast ffmpeg cut command. */
export const clipCutSpecs: CommandSpec[] = buildClipCutSpecs();
