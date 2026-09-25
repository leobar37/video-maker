#!/usr/bin/env bun
/**
 * motion-still.ts — render a still of the demo composition.
 *
 * Usage:
 *   bun packages/motion-remotion/scripts/motion-still.ts --sample [--frame <n>]
 *
 * `--sample` renders one PNG of `projects/demo/hello` to
 * `projects/demo/hello/qa/stills/sample.png` through the render adapter's
 * `renderFilmStill` path: the SAME bundle → selectComposition pipeline (same
 * entry point, same public dir, same webpack overrides, same input props) as
 * `renderMedia`. The sample frame is picked from the shared timing plan
 * (`filmTimingPlan` + `stillTimingInput`) that the composition's
 * `calculateMetadata` uses, and the adapter verifies the composition length
 * matches the plan before rendering — still and render consume identical
 * scene boundaries by construction.
 */

import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { WebpackOverrideFn } from '@remotion/bundler';

import { demoFilmProps } from '../../../projects/demo/hello/remotion/demo-props';
import { filmTimingPlan, stillTimingInput } from '../../motion-core/src';
import { renderFilmStill } from '../src/render-adapter';

interface Args {
  sample: boolean;
  frame?: number;
  output?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { sample: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--sample') {
      args.sample = true;
    } else if (arg === '--frame') {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(`--frame needs a non-negative integer, got "${argv[i + 1] ?? ''}".`);
      }
      args.frame = value;
      i += 1;
    } else if (arg === '--output') {
      const value = argv[i + 1];
      if (!value) throw new Error('--output needs a path.');
      args.output = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }
  return args;
}

/**
 * The demo project is not a workspace package, so its bare imports (`remotion`,
 * `react`, …) resolve through the kit's node_modules on the bundle side. The
 * kit's own modules resolve normally (they live inside the package).
 */
const kitNodeModules = resolve(import.meta.dir, '..', 'node_modules');
const repoNodeModules = resolve(import.meta.dir, '..', '..', '..', 'node_modules');

const webpackOverride: WebpackOverrideFn = (config) => ({
  ...config,
  resolve: {
    ...config.resolve,
    modules: [kitNodeModules, repoNodeModules, 'node_modules', ...(config.resolve?.modules ?? [])],
  },
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sample) {
    process.stderr.write('usage: motion-still.ts --sample [--frame <n>] [--output <png>]\n');
    process.exit(1);
  }

  const repoRoot = resolve(import.meta.dir, '..', '..', '..');
  const demoDir = join(repoRoot, 'projects', 'demo', 'hello');
  const output = args.output ?? join(demoDir, 'qa', 'stills', 'sample.png');

  // Shared frame math: the still path derives from the full-render input via
  // `stillTimingInput` (no audio on a still, identical scene boundaries).
  const plan = filmTimingPlan(
    stillTimingInput({
      fps: demoFilmProps.fps,
      scenes: demoFilmProps.scenes,
      timingMode: demoFilmProps.timingMode,
      narration: demoFilmProps.narration ?? null,
    }),
  );
  // Default sample: the middle of the last scene's span — away from scene
  // boundaries, where every entrance spring is still at zero opacity.
  const lastSpan = plan.spans[plan.spans.length - 1]!;
  const frame =
    args.frame ??
    lastSpan.startFrame + Math.floor(lastSpan.durationInFrames / 2);

  await mkdir(dirname(output), { recursive: true });
  process.stdout.write(
    `motion-still: sample frame ${frame}/${plan.totalFrames} (${demoFilmProps.fps}fps) -> ${output}\n`,
  );

  await renderFilmStill({
    entryPoint: join(demoDir, 'remotion', 'index.ts'),
    publicDir: join(demoDir, 'public'),
    compositionId: 'Film',
    inputProps: demoFilmProps,
    expectedDurationInFrames: plan.totalFrames,
    webpackOverride,
    output,
    frame,
  });

  const info = await stat(output);
  if (!info.isFile() || info.size <= 0) {
    throw new Error(`motion-still: output ${output} is missing or empty.`);
  }
  process.stdout.write(`motion-still: wrote ${info.size} bytes to ${output}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`motion-still: ${message}\n`);
  process.exit(1);
});
