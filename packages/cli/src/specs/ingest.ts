/**
 * Ingest command specs: read-only Instagram research evidence.
 *
 * - `ig-profile` renders the public profile grid in headless Chromium
 *   (`--via browser`, the only transport that defeats the login wall) and
 *   enriches every grid link with anonymous `og:*` post metadata.
 * - `ig-post` fetches one post (`--via fetch`, pure og tags) and upserts it
 *   into the artifact inventory.
 * - `ig-viewer` renders `diagnostico/index.html` from the inventory (local).
 *
 * Plan mode is pure (NFR-002): no network, no secrets, no browser launch.
 * `run()` hard-refuses plan mode.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
import {
  collectProfileViaBrowser,
  diagnosePost,
  fetchIgHtml,
  isEmptyDetail,
  parsePostOg,
  renderDiagnosticHtml,
  type BrowserCollected,
  type IgProfileInventory,
} from '../pipeline/ig';

const PROFILE_ARG: CommandArgSpec = {
  name: 'profile',
  kind: 'string',
  required: true,
  description: 'Instagram username without @ (positional works).',
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

function refusePlanMode(ctx: CommandRunContext, verb: string): never {
  return ctx.fail(
    `${verb}: run() refuses plan mode — run with --plan/--dry-run for the plan, ` +
      'without --plan to execute.',
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function artifactDirOf(ctx: CommandRunContext, profile?: string): string {
  const explicit = argString(ctx.args, 'artifact');
  if (explicit) return resolve(ctx.cwd, explicit);
  return resolve(ctx.cwd, 'docs', 'artifacts', profile ? slugOf(profile) : 'ingest');
}

function slugOf(profile: string): string {
  return profile.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

async function readInventory(path: string): Promise<IgProfileInventory | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as IgProfileInventory;
  } catch {
    return undefined;
  }
}

export function buildIngestSpecs(deps: MediaCommandDeps = defaultMediaDeps()): CommandSpec[] {
  const now = () => new Date();

  const igProfile: CommandSpec = {
    verb: 'ig-profile',
    summary:
      'Dump del perfil público de IG: grid vía Chromium headless + og:* por post. ' +
      'Escribe profile-inventory.json y evidence/. Solo lectura, sin login.',
    args: [
      PROFILE_ARG,
      { name: 'via', kind: 'string', default: 'browser', description: 'browser (grid real) | fetch (solo posts sueltos).' },
      { name: 'artifact', kind: 'string', description: 'Directorio del artefacto (default docs/artifacts/<perfil>).' },
      { name: 'count', kind: 'number', default: 20, description: 'Máximo de posts a enriquecer.' },
      { name: 'screenshots', kind: 'boolean', default: false, description: 'Captura PNG por post además del grid.' },
    ],
    supportsPlan: true,
    writes: ['docs/artifacts/<perfil>/profile-inventory.json', 'docs/artifacts/<perfil>/evidence/**'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const profile = argString(ctx.args, 'profile') ?? '<perfil>';
      const dir = artifactDirOf(ctx, profile);
      return [
        {
          action: `renderizar https://www.instagram.com/${profile}/ en Chromium headless y leer el grid`,
          target: `https://www.instagram.com/${profile}/`,
        },
        {
          action: 'enriquecer cada link con og:title/og:description/og:image (fetch anónimo)',
          writes: 'docs/artifacts/<perfil>/profile-inventory.json',
        },
        {
          action: 'guardar screenshot del grid en evidence/',
          writes: 'docs/artifacts/<perfil>/evidence/perfil-posts.png',
        },
        { action: `escribir inventario en ${dir}`, writes: 'docs/artifacts/<perfil>/profile-inventory.json' },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'ig-profile');
      const profile = argString(ctx.args, 'profile');
      if (!profile) return ctx.fail('ig-profile: falta --profile <usuario> (o positional).');
      const via = argString(ctx.args, 'via') ?? 'browser';
      if (via !== 'browser') {
        return ctx.fail(
          'ig-profile: el grid del perfil está tras el login-wall para fetch anónimo; usá --via browser.',
        );
      }
      const count = Math.max(1, Math.floor(argNumber(ctx.args, 'count') ?? 20));
      const screenshots = argBoolean(ctx.args, 'screenshots', false);
      const dir = artifactDirOf(ctx, profile);
      const evidenceDir = join(dir, 'evidence');
      const profileUrl = `https://www.instagram.com/${profile}/`;
      ctx.out(`ig-profile: renderizando ${profileUrl}`);
      await mkdir(evidenceDir, { recursive: true });
      if (screenshots) await mkdir(join(evidenceDir, 'posts'), { recursive: true });
      let collected: BrowserCollected;
      try {
        collected = await collectProfileViaBrowser(profile, {
          count,
          screenshots,
          gridScreenshotPath: join(evidenceDir, 'perfil-posts.png'),
          postsShotDir: screenshots ? join(evidenceDir, 'posts') : undefined,
          out: ctx.out,
        });
      } catch (error) {
        return ctx.fail(`ig-profile: Chromium falló: ${errorText(error)}`);
      }
      if (collected.detail.length === 0) {
        return ctx.fail(
          `ig-profile: 0/${collected.grid.length} posts con og tags (rate-limit de IG); inventario intacto, reintentá en unos minutos.`,
        );
      }
      const inventory: IgProfileInventory = {
        username: profile,
        profile: profileUrl,
        title: collected.title,
        bio: collected.bio,
        followers: collected.followers,
        following: collected.following,
        posts: collected.grid.filter((h) => h.includes('/p/')),
        reels: collected.grid.filter((h) => h.includes('/reel/')),
        posts_detail: collected.detail,
        extraction: {
          at: now().toISOString(),
          method: 'vm ig-profile --via browser (sesión única Chromium: grid + og + screenshots)',
          note: 'el fetch anónimo se limita; la sesión renderizada no',
        },
      };
      await writeFile(join(dir, 'profile-inventory.json'), JSON.stringify(inventory, null, 2));
      ctx.out(
        `ig-profile: @${profile} → ${collected.detail.length}/${collected.grid.length} posts con detalle en ${dir}`,
      );
      return { exitCode: 0 };
    },
  };

  const igPost: CommandSpec = {
    verb: 'ig-post',
    summary: 'Detalle de un post (og:*) y upsert en el inventario del artefacto.',
    args: [
      { name: 'shortcode', kind: 'string', required: true, description: 'Código del post (positional).' },
      PROFILE_ARG,
      { name: 'via', kind: 'string', default: 'fetch', description: 'fetch (og anónimo) | browser.' },
      { name: 'artifact', kind: 'string', description: 'Directorio del artefacto (default docs/artifacts/<perfil>).' },
    ],
    supportsPlan: true,
    writes: ['docs/artifacts/<perfil>/profile-inventory.json'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      const shortcode = argString(ctx.args, 'shortcode') ?? '<shortcode>';
      return [
        {
          action: `leer https://www.instagram.com/<perfil>/(p|reel)/${shortcode}/ y upsert en el inventario`,
          target: shortcode,
          writes: 'docs/artifacts/<perfil>/profile-inventory.json',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'ig-post');
      const shortcode = argString(ctx.args, 'shortcode');
      const profile = argString(ctx.args, 'profile') ?? 'bfc_cutervo';
      if (!shortcode) return ctx.fail('ig-post: falta --shortcode <código> (o positional).');
      const dir = artifactDirOf(ctx, profile);
      const href = `/bfc_cutervo/p/${shortcode}/`;
      const url = `https://www.instagram.com${href}`;
      let html: string;
      try {
        const fetched = await fetchIgHtml(url, deps.fetchImpl);
        if (fetched.status !== 200) return ctx.fail(`ig-post: ${url} → HTTP ${fetched.status}.`);
        html = fetched.html;
      } catch (error) {
        return ctx.fail(`ig-post: fetch falló: ${errorText(error)}`);
      }
      const detail = parsePostOg(href, html);
      if (isEmptyDetail(detail)) {
        return ctx.fail(`ig-post: ${url} no trae og tags (muro de login o rate-limit); inventario intacto.`);
      }
      const path = join(dir, 'profile-inventory.json');
      const inventory = await readInventory(path);
      if (!inventory) return ctx.fail(`ig-post: no hay inventario en ${path} (corré ig-profile primero).`);
      const rest = inventory.posts_detail.filter((post) => post.shortcode !== detail.shortcode);
      inventory.posts_detail = [...rest, detail];
      await writeFile(path, JSON.stringify(inventory, null, 2));
      ctx.out(
        `ig-post: ${detail.shortcode} → ${detail.likes} likes, ${detail.comments} comentarios, "${detail.date}" [${diagnosePost(detail).join(', ') || 'ok'}]`,
      );
      return { exitCode: 0 };
    },
  };

  const igViewer: CommandSpec = {
    verb: 'ig-viewer',
    summary: 'Genera diagnostico/index.html desde profile-inventory.json (local, sin red).',
    args: [
      { name: 'artifact', kind: 'string', required: true, default: '.', description: 'Directorio del artefacto (positional).' },
    ],
    supportsPlan: true,
    writes: ['<artifact>/diagnostico/index.html'],
    movesGates: [],
    plan(ctx): PlanStep[] {
      return [
        {
          action: 'leer profile-inventory.json y escribir diagnostico/index.html',
          writes: '<artifact>/diagnostico/index.html',
        },
      ];
    },
    async run(ctx): Promise<CommandResult> {
      if (ctx.mode === 'plan') refusePlanMode(ctx, 'ig-viewer');
      const dir = resolve(ctx.cwd, argString(ctx.args, 'artifact') ?? '.');
      const inventory = await readInventory(join(dir, 'profile-inventory.json'));
      if (!inventory) {
        return ctx.fail(`ig-viewer: no hay profile-inventory.json en ${dir} (corré ig-profile primero).`);
      }
      const outDir = join(dir, 'diagnostico');
      await mkdir(outDir, { recursive: true });
      await writeFile(join(outDir, 'index.html'), renderDiagnosticHtml(inventory));
      ctx.out(`ig-viewer: ${inventory.posts_detail.length} tarjetas → ${join(outDir, 'index.html')}`);
      return { exitCode: 0 };
    },
  };

  return [igProfile, igPost, igViewer];
}

/** The registry's ingest commands (FR-013). */
export const ingestSpecs: CommandSpec[] = buildIngestSpecs();
