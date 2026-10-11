/**
 * `clip-ingest` — bring a remote source into the project's `clips/` folder.
 *
 * Two modes, both yt-dlp under the hood:
 *  - whole video → `clips/source.mp4`, the canonical source `clip-transcribe`
 *    and `clip-frames` consume by default;
 *  - `--section A-B` → `clips/sections/NN-A-B.mp4`, one file per range.
 *
 * Section mode is the fast path: on a proxied route the transfer is
 * proportional to the selected seconds instead of the whole video (measured:
 * 60 s of 1080p in ~38 s versus ~58 min for whole 70-minute video).
 *
 * `--proxy` takes an HTTP proxy URL. yt-dlp forwards it to the ffmpeg child for
 * ranged fetches, which is what makes `--download-sections` work behind a SOCKS
 * tunnel (a plain SOCKS URL makes ffmpeg fail with HTTP 403). The proxy may
 * carry credentials: they are NEVER echoed by `plan()` or `run()`.
 *
 * Plan mode is pure (NFR-002): arg validation only, no network, no secrets.
 */
import { resolve } from 'node:path';

import {
  downloadClipSections,
  downloadClipSource,
  parseDownloadSections,
  type DownloadSection,
} from '../pipeline/clip';
import { defaultMediaDeps, type MediaCommandDeps } from '../pipeline/deps';
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
  description: 'Project directory that owns clips/.',
};
const URL_ARG: CommandArgSpec = {
  name: 'url',
  kind: 'string',
  required: true,
  description: 'http(s) source (e.g. a YouTube watch URL).',
};
const PROXY: CommandArgSpec = {
  name: 'proxy',
  kind: 'string',
  description: 'HTTP proxy URL (credentials redacted from every output).',
};
const SECTION: CommandArgSpec = {
  name: 'section',
  kind: 'string[]',
  description: 'Repeatable "startSec-endSec" range; downloads only those ranges.',
};
const MAX_HEIGHT: CommandArgSpec = {
  name: 'max-height',
  kind: 'number',
  description: 'Video height ceiling for the selector (default 1080).',
};
const EXTRACTOR_ARGS: CommandArgSpec = {
  name: 'extractor-args',
  kind: 'string',
  description: 'Extra yt-dlp --extractor-args (e.g. a player-client hint); passed verbatim.',
};
const REUSE: CommandArgSpec = {
  name: 'reuse-existing',
  kind: 'boolean',
  description: 'Keep an existing clips/source.mp4 instead of refreshing it (opt-in: the default avoids stale quality).',
};
const YTDLP: CommandArgSpec = {
  name: 'yt-dlp',
  kind: 'string',
  description: 'yt-dlp binary (default: yt-dlp on PATH).',
};

/** `host:port` of a proxy URL, or a placeholder — never user:password. */
function redactProxy(proxy: string): string {
  try {
    const url = new URL(proxy);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    return '<invalid proxy URL>';
  }
}

function projectOf(ctx: CommandRunContext): string {
  if (typeof ctx.args.project !== 'string' || !ctx.args.project.trim()) {
    return ctx.fail('--project is required', 2);
  }
  return resolve(ctx.cwd, ctx.args.project);
}

function requiredString(ctx: CommandRunContext, name: string): string {
  const value = ctx.args[name];
  if (typeof value !== 'string' || !value.trim()) return ctx.fail(`--${name} is required`, 2);
  return value;
}

function optionalString(ctx: CommandRunContext, name: string): string | undefined {
  const value = ctx.args[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) return ctx.fail(`--${name} must be a non-empty string`, 2);
  return value;
}

function sectionsOf(ctx: CommandRunContext): DownloadSection[] {
  const raw = ctx.args.section;
  if (raw === undefined) return [];
  const parts = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
  const specs = parts.filter((part): part is string => typeof part === 'string' && part.trim().length > 0);
  if (specs.length === 0) return ctx.fail('--section needs at least one "start-end" range', 2);
  try {
    return specs.flatMap((spec) => parseDownloadSections(spec));
  } catch (error) {
    return ctx.fail(error instanceof Error ? error.message : String(error), 2);
  }
}

export function buildClipIngestSpecs(deps: MediaCommandDeps = defaultMediaDeps()): CommandSpec[] {
  const ingest: CommandSpec = {
    verb: 'clip-ingest',
    summary:
      'Fetch a remote source into clips/ with yt-dlp — whole video or only the given sections, optionally through an HTTP proxy.',
    args: [PROJECT, URL_ARG, PROXY, SECTION, MAX_HEIGHT, EXTRACTOR_ARGS, REUSE, YTDLP],
    supportsPlan: true,
    writes: ['clips/source.mp4', 'clips/sections/*'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const project = projectOf(ctx);
      const url = requiredString(ctx, 'url');
      const proxy = optionalString(ctx, 'proxy');
      const maxHeight = typeof ctx.args['max-height'] === 'number' ? ctx.args['max-height'] : 1080;
      optionalString(ctx, 'extractor-args');
      const sections = sectionsOf(ctx);
      const via = proxy ? ` via HTTP proxy ${redactProxy(proxy)}` : '';
      if (sections.length > 0) {
        const seconds = sections.reduce((sum, s) => sum + (s.endSec - s.startSec), 0);
        return [
          {
            action: `Download ${sections.length} section(s) (~${Math.round(seconds)} s) from ${url} with yt-dlp${via}, ≤${maxHeight}p, one file per range.`,
            target: `${project}/clips/sections`,
          },
          { action: 'No network, no credentials and no writes in plan mode.' },
        ];
      }
      return [
        {
          action: ctx.args['reuse-existing'] === true
            ? `Keep the existing clips/source.mp4 when present, else download ${url} with yt-dlp${via}, ≤${maxHeight}p.`
            : `Download the whole source from ${url} with yt-dlp${via}, ≤${maxHeight}p, to clips/source.mp4.`,
          target: `${project}/clips/source.mp4`,
        },
        { action: 'No network, no credentials and no writes in plan mode.' },
      ];
    },
    async run(ctx) {
      if (ctx.mode === 'plan') return ctx.fail('clip-ingest refuses side effects in plan mode', 2);
      const project = projectOf(ctx);
      const url = requiredString(ctx, 'url');
      const proxy = optionalString(ctx, 'proxy');
      const bin = optionalString(ctx, 'yt-dlp');
      const extractorArgs = optionalString(ctx, 'extractor-args');
      const maxHeight = typeof ctx.args['max-height'] === 'number' ? ctx.args['max-height'] : 1080;
      const sections = sectionsOf(ctx);
      const options = {
        ...(proxy ? { proxy } : {}),
        ...(ctx.args['reuse-existing'] === true ? { reuseExisting: true } : {}),
        ...(bin ? { ytdlpBin: bin } : {}),
        ...(maxHeight ? { maxHeight } : {}),
        ...(extractorArgs ? { extractorArgs } : {}),
      };
      try {
        if (sections.length > 0) {
          const paths = await downloadClipSections(deps.process, project, url, sections, options);
          ctx.out(JSON.stringify({ source: 'sections', count: paths.length, paths }, null, 2));
        } else {
          const path = await downloadClipSource(deps.process, project, url, options);
          ctx.out(JSON.stringify({ source: path }, null, 2));
        }
        return { exitCode: 0 };
      } catch (error) {
        return ctx.fail(`clip-ingest: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
  return [ingest];
}

/** The registry's ingest command for remote clip sources. */
export const clipIngestSpecs: CommandSpec[] = buildClipIngestSpecs();
