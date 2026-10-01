/**
 * Social/vertical command specs (covers + AI backgrounds + carousel gate).
 *
 * - `cover --project <dir> [--check] [--force]`: validates or renders the
 *   1080×1920 cover (`social-cover.json` → Chromium PNG → Sharp previews).
 * - `gen-image --project <dir> --prompt-file <f> --aspect-ratio 9:16
 *   --submit --spend-cap <usd>`: one FAL flux/schnell image with the paid
 *   spend gate, receipt journal and bounded poll.
 * - `carousel --project <dir> --images <dir> [--check]`: the 1080×1350 gate.
 *
 * Plan mode is pure (NFR-002). `run()` hard-refuses plan mode; paid runs
 * refuse without `--spend-cap`.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type {
  CommandArgSpec,
  CommandResult,
  CommandRunContext,
  CommandSpec,
  PlanStep,
} from '../spec-types';
import type { MediaCommandDeps } from '../pipeline/deps';
import { defaultMediaDeps } from '../pipeline/deps';
import { MissingSpendCapError, spendCapFromArgs } from '../pipeline/spend-ledger';
import {
  CAROUSEL_HEIGHT,
  CAROUSEL_WIDTH,
  COVER_HEIGHT,
  COVER_WIDTH,
  carouselCheck,
  coverCheck,
  renderCover,
} from '../pipeline/cover';
import { estimateAttemptUsd, runGenImage } from '../pipeline/gen-image';

const PROJECT_ARG: CommandArgSpec = {
  name: 'project',
  kind: 'string',
  required: true,
  default: '.',
  description: 'Project directory (relative to the invocation cwd).',
};

function argString(
  args: Record<string, string | number | boolean | string[]>,
  name: string,
): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function argBoolean(
  args: Record<string, string | number | boolean | string[]>,
  name: string,
  fallback: boolean,
): boolean {
  const value = args[name];
  return typeof value === 'boolean' ? value : fallback;
}

function projectDirOf(ctx: CommandRunContext): string {
  return resolve(ctx.cwd, argString(ctx.args, 'project') ?? '.');
}

function refusePlanMode(ctx: CommandRunContext, verb: string): never {
  return ctx.fail(
    `${verb}: run() refuses plan mode — run with --plan/--dry-run for the plan, ` +
      'without --plan to execute.',
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildSocialSpecs(deps: MediaCommandDeps = defaultMediaDeps()): CommandSpec[] {
  const cover: CommandSpec = {
    verb: 'cover',
    summary:
      `Renderiza la portada vertical ${COVER_WIDTH}×${COVER_HEIGHT} del proyecto ` +
      '(social-cover.json → Chromium → previews 3:4 y 1:1). Con --check solo valida.',
    args: [
      PROJECT_ARG,
      { name: 'check', kind: 'boolean', default: false, description: 'Solo valida metadata y salidas.' },
      { name: 'force', kind: 'boolean', default: false, description: 'Re-renderiza aunque exista.' },
    ],
    supportsPlan: true,
    writes: ['<project>/covers/cover.png', '<project>/covers/social/preview-*.png'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const projectDir = projectDirOf(ctx);
      if (argBoolean(ctx.args, 'check', false)) {
        return [
          {
            action: 'validar social-cover.json y salidas 1080×1920/3:4/1:1',
            target: projectDir,
          },
        ];
      }
      return [
        {
          action: `renderizar portada ${COVER_WIDTH}×${COVER_HEIGHT} en Chromium local`,
          target: projectDir,
          writes: '<project>/covers/cover.png',
        },
        {
          action: 'derivar previews 1080×1440 y 1080×1080 (center-crop)',
          writes: '<project>/covers/social/preview-*.png',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'cover');
      const projectDir = projectDirOf(ctx);
      if (argBoolean(ctx.args, 'check', false)) {
        const issues = await coverCheck(projectDir);
        if (issues.length > 0) {
          for (const issue of issues) ctx.out(`cover --check: ${issue.path}: ${issue.message}`);
          return ctx.fail(`cover --check: ${issues.length} problema(s) en ${projectDir}.`);
        }
        ctx.out(`cover --check: PASS en ${projectDir}.`);
        return { exitCode: 0 };
      }
      try {
        await renderCover(projectDir, ctx.out);
      } catch (error) {
        return ctx.fail(`cover: ${errorText(error)}`);
      }
      return { exitCode: 0 };
    },
  };

  const genImage: CommandSpec = {
    verb: 'gen-image',
    summary:
      'Genera un fondo vertical con FAL flux/schnell (submit + poll + journal). ' +
      'Operación paga: exige --spend-cap.',
    args: [
      PROJECT_ARG,
      { name: 'prompt-file', kind: 'string', description: 'Ruta del prompt (texto).' },
      { name: 'prompt', kind: 'string', description: 'Prompt inline (alternativa).' },
      { name: 'aspect-ratio', kind: 'string', default: '9:16', description: '9:16 | 1:1 | 4:5 | 16:9.' },
      { name: 'out', kind: 'string', default: 'covers/bg.png', description: 'Salida relativa al proyecto.' },
      {
        name: 'spend-cap',
        kind: 'number',
        description: 'Tope de gasto USD (requerido para --submit).',
      },
      { name: 'submit', kind: 'boolean', default: false, description: 'Emite el submit pago.' },
      { name: 'force', kind: 'boolean', default: false, description: 'Re-emite aunque el journal esté completo.' },
    ],
    paid: true,
    supportsPlan: true,
    writes: ['<project>/covers/bg.png', '<project>/qa/gen-image.json'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const projectDir = projectDirOf(ctx);
      const aspect = argString(ctx.args, 'aspect-ratio') ?? '9:16';
      let estimate = 0;
      try {
        estimate = estimateAttemptUsd(aspect);
      } catch {
        estimate = 0;
      }
      return [
        {
          action: `generar fondo ${aspect} con ${'fal-ai/flux/schnell'} (~$${estimate.toFixed(4)})`,
          target: projectDir,
          writes: '<project>/covers/bg.png',
          costUsd: estimate,
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'gen-image');
      let spendCapUsd: number;
      try {
        spendCapUsd = spendCapFromArgs('gen-image', ctx.args);
      } catch (error) {
        return ctx.fail(error instanceof MissingSpendCapError ? error.message : errorText(error));
      }
      if (!argBoolean(ctx.args, 'submit', false)) {
        return ctx.fail('gen-image: nada que emitir sin --submit (ver --plan para el estimado).');
      }
      const projectDir = projectDirOf(ctx);
      const promptFile = argString(ctx.args, 'prompt-file');
      const inline = argString(ctx.args, 'prompt');
      let prompt = inline ?? '';
      if (promptFile) {
        try {
          prompt = (await readFile(resolve(ctx.cwd, promptFile), 'utf8')).trim();
        } catch {
          return ctx.fail(`gen-image: no se pudo leer --prompt-file ${promptFile}.`);
        }
      }
      if (prompt.length === 0) return ctx.fail('gen-image: falta --prompt-file <ruta> o --prompt <texto>.');
      const aspect = argString(ctx.args, 'aspect-ratio') ?? '9:16';
      const outRel = argString(ctx.args, 'out') ?? 'covers/bg.png';
      try {
        const result = await runGenImage(
          {
            projectDir,
            prompt,
            outPath: join(projectDir, outRel),
            aspect,
            spendCapUsd,
            force: argBoolean(ctx.args, 'force', false),
            out: ctx.out,
          },
          {
            fetchImpl: deps.fetchImpl,
            falKey: () => deps.secrets.getSecret('FAL_KEY', 'run'),
            sleep: (ms: number) => {
              const { promise, resolve } = Promise.withResolvers<void>();
              setTimeout(resolve, ms);
              return promise;
            },
          },
        );
        ctx.out(`gen-image: listo ${result.outPath} ($${result.spentUsd.toFixed(4)}).`);
      } catch (error) {
        return ctx.fail(errorText(error));
      }
      return { exitCode: 0 };
    },
  };

  const carousel: CommandSpec = {
    verb: 'carousel',
    summary:
      `Puerta 1080×${CAROUSEL_HEIGHT} del carrusel: valida PNGs en orden. ` +
      'Con --check no toca red.',
    args: [
      PROJECT_ARG,
      { name: 'images', kind: 'string', description: 'Directorio con los PNG (positional u orden).' },
      { name: 'check', kind: 'boolean', default: false, description: 'Solo valida localmente.' },
    ],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan(ctx): PlanStep[] {
      return [
        {
          action: `validar páginas ${CAROUSEL_WIDTH}×${CAROUSEL_HEIGHT} en ${argString(ctx.args, 'images') ?? '<dir>'}`,
          target: projectDirOf(ctx),
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'carousel');
      const images = argString(ctx.args, 'images');
      if (!images) return ctx.fail('carousel: falta --images <directorio> con los PNG.');
      const { pages, issues } = await carouselCheck(resolve(ctx.cwd, images));
      if (issues.length > 0) {
        for (const issue of issues) ctx.out(`carousel: ${issue.path}: ${issue.message}`);
        return ctx.fail(`carousel: ${issues.length} problema(s), no hay submit.`);
      }
      ctx.out(`carousel: PASS ${pages.length} páginas ${CAROUSEL_WIDTH}×${CAROUSEL_HEIGHT}.`);
      if (!argBoolean(ctx.args, 'check', false)) {
        ctx.out('carousel: sin --check hoy solo valida (upload R2 en el próximo paso).');
      }
      return { exitCode: 0 };
    },
  };

  return [cover, genImage, carousel];
}

/** The registry's social/vertical commands (FR-013). */
export const socialSpecs: CommandSpec[] = buildSocialSpecs();
