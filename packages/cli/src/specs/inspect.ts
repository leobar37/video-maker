/**
 * Inspection & scaffolding command group (`inspectSpecs`): new, preflight,
 * status, find, catalog, plan.
 *
 * Everything here is offline and file-based. Gates are DERIVED from artifacts
 * on disk (`deriveGates`, FR-009) — there is no editable workflow state file
 * anywhere in this codebase, by design: dropping an artifact flips its gate
 * back and writing a forged state file grants nothing.
 */
import { promises as fsp } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import {
  PROJECT_SUBDIRS,
  deriveGates,
  loadProject,
  projectPaths,
  resolveInsideProject,
  validateProject,
  GATE_NAMES,
  type GateName,
  type Project,
  type SceneConfig,
  type VideoConfig,
} from '@videomaker/core';
import {
  VideoCatalogSchema,
  type CatalogEntry,
  type VideoCatalog,
} from '@videomaker/schemas';

import {
  JSON_ARG,
  PROJECT_ARG,
  pathExists,
  readJsonFile,
  resolveProjectDir,
  writeJsonFile,
} from '../args';
import type { CommandSpec, PlanStep } from '../spec-types';

// ---------------------------------------------------------------------------
// Shared project helpers (also used by specs/scene.ts)
// ---------------------------------------------------------------------------

/** Loads the project at `--project`, failing actionably when invalid. */
export async function loadProjectOrFail(projectDir: string, fail: (message: string, code?: number) => never): Promise<Project> {
  try {
    return await loadProject(projectDir);
  } catch (error) {
    return fail(`Proyecto inválido en ${projectDir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Project-relative (POSIX) rendering of an absolute path inside the project. */
export function projectRelative(projectDir: string, absolute: string): string {
  const rel = relative(projectDir, absolute);
  return rel.split(sep).join('/');
}

// ---------------------------------------------------------------------------
// `new` — idempotent project scaffolder
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

interface ScaffoldInput {
  projectDir: string;
  id: string;
  product: string;
  title: string;
  preset: string;
  tagline: string;
}

function scaffoldConfig(input: ScaffoldInput): VideoConfig {
  return {
    id: input.id,
    product: input.product,
    title: input.title,
    workflow: { schemaVersion: 1, draft: true, reviewPolicy: 'advisory' },
    resolution: { width: 1080, height: 1920 },
    fps: 30,
    tts: {
      provider: 'elevenlabs',
      mode: 'continuous',
      voiceId: 'REPLACE_ME',
      modelId: 'eleven_multilingual_v2',
      language: 'es-419',
    },
    branding: { preset: input.preset },
    scenes: [
      {
        id: 's1-hook',
        intent: 'TODO: dolor concreto del rubro (intro innovable).',
        source: 'motion',
        narration: 'TODO: línea de hook.',
        status: 'pending',
        minSeconds: 4,
        maxSeconds: 6,
        durationHint: 5,
      },
      {
        id: 's2-demo',
        intent: 'TODO: flujo real que se captura y por qué demuestra el valor.',
        source: 'demo-app',
        narration: 'TODO: narración de la escena demo.',
        status: 'pending',
        minSeconds: 8,
        maxSeconds: 12,
        durationHint: 10,
      },
      {
        id: 's3-cta',
        intent: 'cierre de marca: logo + tagline.',
        source: 'motion',
        narration: input.tagline.length > 0 ? `${input.title}. ${input.tagline}.` : 'TODO: tagline de cierre.',
        status: 'pending',
        minSeconds: 4,
        maxSeconds: 5,
        durationHint: 5,
      },
    ],
  };
}

function scaffoldNarration(input: ScaffoldInput, config: VideoConfig): string {
  const lines = [
    `# ${input.title} — guion`,
    '',
    'Idioma editorial: es-419 (español LATAM neutro, tuteo).',
    '',
    '## Mapa de escenas (aprobar ANTES de generar assets)',
    '',
    ...config.scenes.map((scene, index) => `${index + 1}. **${scene.id}** — ${scene.intent}`),
    '',
    '## Guion por escena',
    '',
  ];
  for (const scene of config.scenes) {
    lines.push(`### ${scene.id}`, '', scene.narration, '');
  }
  return `${lines.join('\n')}\n`;
}

async function runScaffold(input: ScaffoldInput, out: (line: string) => void): Promise<number> {
  const manifestPath = join(input.projectDir, 'video.json');
  if (await pathExists(manifestPath)) {
    out(`project ya existe en ${input.projectDir} (no-op; video.json intacto).`);
    return 0;
  }
  if (!SLUG_PATTERN.test(input.id)) {
    out(`error: id inválido "${input.id}" (esperado ^[a-z0-9][a-z0-9-]*$).`);
    return 1;
  }
  if (!SLUG_PATTERN.test(input.product)) {
    out(`error: product inválido "${input.product}" (esperado ^[a-z0-9][a-z0-9-]*$).`);
    return 1;
  }
  const config = scaffoldConfig(input);
  validateProject(config);
  await fsp.mkdir(input.projectDir, { recursive: true });
  for (const subdir of PROJECT_SUBDIRS) {
    await fsp.mkdir(join(input.projectDir, subdir), { recursive: true });
  }
  await writeJsonFile(manifestPath, config);
  const scriptDir = await resolveInsideProject(input.projectDir, 'script');
  await fsp.writeFile(join(scriptDir, 'narration.md'), scaffoldNarration(input, config));
  out(`proyecto creado en ${input.projectDir}`);
  out(`  video.json + ${PROJECT_SUBDIRS.join('/')} + script/narration.md`);
  out('  escenas en status "pending": completá video.json + script/narration.md antes de producir.');
  return 0;
}

// ---------------------------------------------------------------------------
// `preflight` — local sanity checks (no network)
// ---------------------------------------------------------------------------

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

interface AssetReference {
  relative: string;
  sceneId?: string;
  active: boolean;
}

function assetReferences(project: Project): AssetReference[] {
  const refs: AssetReference[] = [];
  const config = project.config;
  const push = (relative: string | undefined, scene?: SceneConfig): void => {
    if (relative === undefined || relative === '') return;
    refs.push({ relative, sceneId: scene?.id, active: scene === undefined || scene.status === 'active' });
  };
  push(config.visualSystem?.styleReference);
  for (const character of config.visualSystem?.characters ?? []) {
    for (const reference of character.references) push(reference);
  }
  for (const fixture of config.capture?.fixtureFiles ?? []) push(fixture);
  for (const scene of config.scenes) {
    push(scene.avatar?.image, scene);
    push(scene.avatar?.audio, scene);
    push(scene.falVideo?.promptFile, scene);
    push(scene.falVideo?.negativePromptFile, scene);
    push(scene.falVideo?.initialImage, scene);
    push(scene.falVideo?.tailImage, scene);
  }
  return refs;
}

async function runPreflightChecks(projectDir: string): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  let project: Project | undefined;
  try {
    project = await loadProject(projectDir);
    checks.push({ name: 'video.json', status: 'ok', detail: `válido (${project.slug})` });
  } catch (error) {
    checks.push({
      name: 'video.json',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
    return checks;
  }

  const paths = projectPaths(projectDir);
  for (const subdir of PROJECT_SUBDIRS) {
    const absolute = paths[`${subdir}Dir` as keyof typeof paths];
    const exists = await pathExists(absolute);
    checks.push({
      name: `dir ${subdir}/`,
      status: exists ? 'ok' : 'fail',
      detail: exists ? 'presente' : 'falta (regenerá con `vm new`)',
    });
  }

  for (const reference of assetReferences(project)) {
    let exists = false;
    try {
      exists = await pathExists(await resolveInsideProject(projectDir, reference.relative));
    } catch {
      checks.push({
        name: `asset ${reference.relative}`,
        status: 'fail',
        detail: `referencia insegura${reference.sceneId ? ` (escena ${reference.sceneId})` : ''}`,
      });
      continue;
    }
    if (exists) {
      checks.push({ name: `asset ${reference.relative}`, status: 'ok', detail: 'presente' });
    } else {
      checks.push({
        name: `asset ${reference.relative}`,
        status: reference.active ? 'fail' : 'warn',
        detail: `ausente${reference.sceneId ? ` (escena ${reference.sceneId})` : ''}`,
      });
    }
  }

  for (const scene of project.config.scenes) {
    if (scene.status !== 'active') continue;
    const hasVoice = scene.narration.trim().length > 0 || (scene.dialogue ?? []).length > 0;
    checks.push({
      name: `narration ${scene.id}`,
      status: hasVoice ? 'ok' : 'warn',
      detail: hasVoice ? 'presente' : 'escena activa sin narración ni diálogo',
    });
  }
  return checks;
}

// ---------------------------------------------------------------------------
// `find` + `catalog` — project index (FR-010)
// ---------------------------------------------------------------------------

/** Canonical index file written by `catalog` and read by `find`. */
export const CATALOG_RELATIVE = 'videos.json';

interface FoundProject {
  dir: string;
  config: VideoConfig;
  tags: string[];
}

function rawTags(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null || !('tags' in raw)) return [];
  const tags = (raw as { tags?: unknown }).tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((tag): tag is string => typeof tag === 'string');
}

const SCAN_SKIP: Record<string, true> = {
  node_modules: true,
  bundles: true,
  renders: true,
  assets: true,
};

async function scanProjects(root: string, maxDepth: number): Promise<FoundProject[]> {
  const found: FoundProject[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (await pathExists(join(current.dir, 'video.json'))) {
      try {
        const project = await loadProject(current.dir);
        const raw = (await readJsonFile(join(current.dir, 'video.json'))) as Record<string, unknown>;
        found.push({ dir: current.dir, config: project.config, tags: rawTags(raw) });
      } catch {
        // Invalid projects are skipped by the index; `preflight` explains them.
      }
      continue;
    }
    if (current.depth >= maxDepth) continue;
    const entries = await fsp.readdir(current.dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SCAN_SKIP[entry.name] === true || entry.name.startsWith('.') || entry.name.startsWith('_')) {
        continue;
      }
      queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 });
    }
  }
  return found.sort((left, right) => `${left.config.product}/${left.config.id}`.localeCompare(`${right.config.product}/${right.config.id}`));
}

/** Publication evidence: a journal under qa/publication/ reaching "complete". */
async function isPublished(projectDir: string): Promise<boolean> {
  const publicationDir = join(projectDir, 'qa', 'publication');
  let attempts: string[];
  try {
    attempts = (await fsp.readdir(publicationDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return false;
  }
  for (const attempt of attempts) {
    try {
      const journal = (await readJsonFile(join(publicationDir, attempt, 'journal.json'))) as {
        stages?: unknown;
      };
      if (Array.isArray(journal.stages) && journal.stages.includes('complete')) return true;
    } catch {
      // Broken journals never grant the published status.
    }
  }
  return false;
}

/**
 * Durable-bundle evidence ("has bundle"): the provenance file written by the
 * archive command, or a bundle manifest next to the project (bundles are kept
 * outside the project directory, e.g. `<root>/bundles/<name>/MANIFEST.json`).
 */
async function findBundleEvidence(projectDir: string): Promise<string | undefined> {
  const provenance = join(projectDir, 'qa', 'archive.json');
  if (await pathExists(provenance)) return projectRelative(projectDir, provenance);
  const bundlesDir = join(projectDir, '..', 'bundles');
  let entries: string[];
  try {
    entries = await fsp.readdir(bundlesDir);
  } catch {
    return undefined;
  }
  const base = projectDir.split(sep).pop() ?? '';
  for (const name of entries.sort()) {
    if (!name.startsWith(`${base}-`)) continue;
    if (await pathExists(join(bundlesDir, name, 'MANIFEST.json'))) {
      return `bundles/${name}`;
    }
  }
  return undefined;
}

async function buildCatalog(root: string): Promise<{ catalog: VideoCatalog; scanned: number }> {
  const projects = await scanProjects(root, 3);
  const videos: CatalogEntry[] = [];
  for (const found of projects) {
    const published = await isPublished(found.dir);
    const bundle = await findBundleEvidence(found.dir);
    videos.push({
      id: `${found.config.product}/${found.config.id}`,
      product: found.config.product,
      slug: found.config.id,
      title: found.config.title,
      status: published ? 'published' : 'draft',
      hasBundle: bundle !== undefined,
      ...(found.tags.length > 0 || published
        ? { public: { id: `${found.config.product}/${found.config.id}`, version: '1', ...(found.tags.length > 0 ? { tags: found.tags } : {}) } }
        : {}),
      ...(bundle !== undefined ? { archive: { bundle } } : {}),
    });
  }
  return { catalog: VideoCatalogSchema.parse({ schemaVersion: 3, videos }), scanned: projects.length };
}

export interface FindFilters {
  text?: string;
  tag?: string;
  product?: string;
  status?: string;
  missingBundle?: boolean;
}

/** Applies all present filters (AND) to catalog entries. */
export function filterVideos(entries: readonly CatalogEntry[], filters: FindFilters): CatalogEntry[] {
  const text = filters.text?.trim().toLowerCase();
  return entries.filter((entry) => {
    if (text !== undefined && text !== '') {
      const haystack = `${entry.id} ${entry.title}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    if (filters.tag !== undefined && !(entry.public?.tags ?? []).includes(filters.tag)) return false;
    if (filters.product !== undefined && entry.product !== filters.product) return false;
    if (filters.status !== undefined && entry.status !== filters.status) return false;
    if (filters.missingBundle === true && entry.hasBundle) return false;
    return true;
  });
}

function printCatalogTable(entries: readonly CatalogEntry[], out: (line: string) => void): void {
  if (entries.length === 0) {
    out('  sin resultados.');
    return;
  }
  for (const entry of entries) {
    out(
      `  ${entry.id.padEnd(32)} ${entry.status.padEnd(10)} ${entry.title.padEnd(36)} bundle:${entry.hasBundle ? 'si' : 'no'}`,
    );
  }
}

// ---------------------------------------------------------------------------
// `plan` — aggregate plan of what the pipeline would do (no network)
// ---------------------------------------------------------------------------

/** Production artifacts required per active scene (mirrors gate derivation). */
function requiredSceneArtifacts(config: VideoConfig): Array<{ relative: string; scene: SceneConfig }> {
  const required: Array<{ relative: string; scene: SceneConfig }> = [];
  const active = config.scenes.filter((scene) => scene.status === 'active');
  const continuous = config.tts.mode === 'continuous';
  if (continuous && active.some((scene) => scene.narration.trim().length > 0)) {
    required.push({ relative: 'script/audio/narration.wav', scene: active[0]! });
  }
  for (const scene of active) {
    if (!continuous && scene.narration.trim().length > 0) {
      required.push({ relative: `script/audio/${scene.id}.wav`, scene });
    }
    if (scene.source === 'demo-app') required.push({ relative: `scenes/${scene.id}/capture.mp4`, scene });
    if (scene.source === 'fal-video') required.push({ relative: `scenes/${scene.id}/generated.mp4`, scene });
    if (scene.source === 'avatar' && scene.avatar) {
      required.push({ relative: scene.avatar.image, scene }, { relative: scene.avatar.audio, scene });
    }
  }
  return required;
}

async function aggregatePlanSteps(projectDir: string): Promise<PlanStep[]> {
  const steps: PlanStep[] = [];
  const gates = await deriveGates(projectDir);
  const project = await loadProject(projectDir);
  const byGate = new Map<GateName, string | undefined>(gates.gates.map((gate) => [gate.gate, gate.detail]));

  const storyboard = byGate.get('storyboard');
  if (storyboard !== undefined) {
    steps.push({ action: `finalizar storyboard: ${storyboard}`, writes: 'video.json', gate: 'storyboard' });
  }
  const spend = byGate.get('spend');
  if (spend !== undefined) {
    steps.push({ action: `conciliar spend: ${spend}`, writes: 'qa/spend.json', gate: 'spend' });
  }

  const missing = new Set<string>();
  const required = requiredSceneArtifacts(project.config);
  const present = await Promise.all(
    required.map((entry) => pathExists(join(projectDir, entry.relative))),
  );
  required.forEach((entry, index) => {
    if (present[index]) return;
    if (missing.has(entry.relative)) return;
    missing.add(entry.relative);
    const generated = entry.scene.source === 'fal-video' ? entry.scene.falVideo?.budgetUsd : undefined;
    steps.push({
      action: `producir ${entry.relative} (escena ${entry.scene.id}, ${entry.scene.source})`,
      writes: entry.relative,
      gate: 'assets',
      ...(generated !== undefined ? { costUsd: generated } : {}),
    });
  });

  const tail: Array<{ gate: GateName; action: string; writes: string }> = [
    { gate: 'render', action: 'ensamblar y renderizar el video final', writes: 'renders/' },
    { gate: 'qa', action: 'correr checks QA y escribir el reporte', writes: 'qa/report.json' },
    { gate: 'signoff', action: 'registrar la revisión humana de signoff', writes: 'qa/reviews.json' },
    { gate: 'publish', action: 'publicar y sellar el journal de publicación', writes: 'qa/publication/' },
  ];
  for (const entry of tail) {
    if (byGate.get(entry.gate) === undefined) continue;
    steps.push({ action: entry.action, writes: entry.writes, gate: entry.gate });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

export const inspectSpecs: CommandSpec[] = [
  {
    verb: 'new',
    summary: 'Crea un proyecto de video idempotente (video.json + dirs; escenas pendientes).',
    args: [
      PROJECT_ARG,
      { name: 'id', kind: 'string', required: false, default: '', description: 'Slug del video (default: basename del proyecto).' },
      { name: 'product', kind: 'string', required: false, default: 'demo', description: 'Producto dueño del video.' },
      { name: 'title', kind: 'string', required: false, default: '', description: 'Título público (default: derivado del id).' },
      { name: 'preset', kind: 'string', required: false, default: '', description: 'Preset de branding (default: product).' },
      { name: 'tagline', kind: 'string', required: false, default: '', description: 'Tagline de cierre.' },
    ],
    supportsPlan: true,
    writes: ['video.json', 'script/narration.md', 'script/', 'scenes/', 'remotion/', 'qa/', 'renders/', 'assets/'],
    movesGates: [],
    plan(): PlanStep[] {
      return [
        { action: 'crear directorios canónicos del proyecto', writes: PROJECT_SUBDIRS.map((dir) => `${dir}/`).join(' ') },
        { action: 'escribir video.json con escenas en status "pending"', writes: 'video.json' },
        { action: 'escribir plantilla de guion', writes: 'script/narration.md' },
      ];
    },
    async run(ctx) {
      const projectDir = resolveProjectDir(ctx);
      const id = typeof ctx.args.id === 'string' && ctx.args.id !== '' ? ctx.args.id : (projectDir.split(sep).pop() ?? 'video');
      const product = String(ctx.args.product);
      const title = typeof ctx.args.title === 'string' && ctx.args.title !== '' ? ctx.args.title : id;
      const preset = typeof ctx.args.preset === 'string' && ctx.args.preset !== '' ? ctx.args.preset : product;
      const exitCode = await runScaffold(
        { projectDir, id, product, title, preset, tagline: String(ctx.args.tagline ?? '') },
        ctx.out,
      );
      return { exitCode };
    },
  },
  {
    verb: 'preflight',
    summary: 'Chequeos locales de sanidad del proyecto (config, dirs, referencias de assets; sin red).',
    args: [PROJECT_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan(): PlanStep[] {
      return [{ action: 'validar video.json, directorios canónicos y referencias de assets (solo lectura)' }];
    },
    async run(ctx) {
      const projectDir = resolveProjectDir(ctx);
      const checks = await runPreflightChecks(projectDir);
      const failures = checks.filter((check) => check.status === 'fail');
      if (ctx.args.json === true) {
        ctx.out(JSON.stringify({ projectDir, checks }, null, 2));
      } else {
        for (const check of checks) {
          const icon = check.status === 'ok' ? 'ok  ' : check.status === 'warn' ? 'warn' : 'FAIL';
          ctx.out(`  [${icon}] ${check.name}: ${check.detail}`);
        }
        ctx.out(`  ${checks.length} checks, ${failures.length} fallas.`);
      }
      return { exitCode: failures.length > 0 ? 1 : 0 };
    },
  },
  {
    verb: 'status',
    summary: 'Gates de producción derivados de los artefactos en disco (FR-009, sin estado editable).',
    args: [
      PROJECT_ARG,
      JSON_ARG,
      {
        name: 'check',
        kind: 'string',
        required: false,
        default: '',
        description: `Gate a comprobar (${GATE_NAMES.join('|')}); exit 1 si está pendiente.`,
      },
    ],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan(): PlanStep[] {
      return [{ action: 'derivar gates desde los artefactos en disco (solo lectura)' }];
    },
    async run(ctx) {
      const projectDir = resolveProjectDir(ctx);
      const report = await deriveGates(projectDir);
      const check = typeof ctx.args.check === 'string' && ctx.args.check !== '' ? ctx.args.check : undefined;
      if (check !== undefined && !(GATE_NAMES as readonly string[]).includes(check)) {
        ctx.fail(`--check debe ser uno de: ${GATE_NAMES.join(', ')}.`);
      }
      if (ctx.args.json === true) {
        ctx.out(JSON.stringify(report, null, 2));
      } else {
        ctx.out(`gates: ${projectDir}`);
        for (const gate of report.gates) {
          const suffix = gate.detail !== undefined ? ` — ${gate.detail}` : '';
          ctx.out(`  ${gate.gate.padEnd(10)} ${gate.status}${suffix}`);
          for (const evidence of gate.evidence) ctx.out(`      evidence: ${evidence}`);
        }
      }
      const target = check !== undefined ? report.gates.find((gate) => gate.gate === check) : undefined;
      return { exitCode: target !== undefined && target.status === 'pending' ? 1 : 0 };
    },
  },
  {
    verb: 'find',
    summary: 'Consulta el índice de proyectos con filtros (texto/tag/producto/status/bundle faltante).',
    args: [
      { name: 'root', kind: 'string', required: false, default: '.', description: 'Raíz de proyectos (donde vive videos.json).' },
      { name: 'text', kind: 'string', required: false, default: '', description: 'Texto libre sobre id+title.' },
      { name: 'tag', kind: 'string', required: false, default: '', description: 'Tag exacto (public.tags).' },
      { name: 'product', kind: 'string', required: false, default: '', description: 'Producto exacto.' },
      { name: 'status', kind: 'string', required: false, default: '', description: 'draft|published.' },
      { name: 'missing', kind: 'string', required: false, default: '', description: 'Filtra faltantes: "bundle".' },
      JSON_ARG,
    ],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan(): PlanStep[] {
      return [{ action: 'leer el índice videos.json y aplicar filtros (solo lectura)' }];
    },
    async run(ctx) {
      const root = resolve(ctx.cwd, String(ctx.args.root));
      const catalogPath = join(root, CATALOG_RELATIVE);
      if (!(await pathExists(catalogPath))) {
        ctx.fail(
          `No existe ${catalogPath}. El índice se genera desde los video.json: ejecutá \`vm catalog --root ${root}\` y volvé a intentar.`,
        );
      }
      const catalog = VideoCatalogSchema.parse(await readJsonFile(catalogPath));
      const missing = String(ctx.args.missing);
      if (missing !== '' && missing !== 'bundle') {
        ctx.fail('--missing solo admite "bundle" por ahora.');
      }
      const status = String(ctx.args.status);
      if (status !== '' && status !== 'draft' && status !== 'published') {
        ctx.fail('--status debe ser draft o published.');
      }
      const entries = filterVideos(catalog.videos, {
        ...(ctx.args.text !== '' ? { text: String(ctx.args.text) } : {}),
        ...(ctx.args.tag !== '' ? { tag: String(ctx.args.tag) } : {}),
        ...(ctx.args.product !== '' ? { product: String(ctx.args.product) } : {}),
        ...(status !== '' ? { status } : {}),
        ...(missing === 'bundle' ? { missingBundle: true } : {}),
      });
      if (ctx.args.json === true) {
        ctx.out(JSON.stringify(entries, null, 2));
      } else {
        printCatalogTable(entries, ctx.out);
        ctx.out(`  ${entries.length} de ${catalog.videos.length} videos.`);
      }
      return { exitCode: 0 };
    },
  },
  {
    verb: 'catalog',
    summary: 'Genera/actualiza el índice de proyectos (videos.json) escaneando la raíz.',
    args: [
      { name: 'root', kind: 'string', required: false, default: '.', description: 'Raíz de proyectos a escanear.' },
      JSON_ARG,
    ],
    supportsPlan: true,
    writes: ['videos.json'],
    movesGates: [],
    plan(): PlanStep[] {
      return [{ action: 'escanear video.json bajo la raíz y escribir el índice', writes: 'videos.json' }];
    },
    async run(ctx) {
      const root = resolve(ctx.cwd, String(ctx.args.root));
      const { catalog, scanned } = await buildCatalog(root);
      const catalogPath = join(root, CATALOG_RELATIVE);
      await writeJsonFile(catalogPath, catalog);
      if (ctx.args.json === true) {
        ctx.out(JSON.stringify(catalog, null, 2));
      } else {
        ctx.out(`índice escrito en ${catalogPath}: ${catalog.videos.length} proyectos (${scanned} escaneados).`);
        printCatalogTable(catalog.videos, ctx.out);
      }
      return { exitCode: 0 };
    },
  },
  {
    verb: 'plan',
    summary: 'Plan agregado de lo que haría el pipeline para el proyecto (sin red).',
    args: [PROJECT_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    async plan(ctx) {
      return aggregatePlanSteps(resolveProjectDir(ctx));
    },
    async run(ctx) {
      const projectDir = resolveProjectDir(ctx);
      const steps = await aggregatePlanSteps(projectDir);
      if (ctx.args.json === true) {
        ctx.out(JSON.stringify({ projectDir, steps }, null, 2));
      } else if (steps.length === 0) {
        ctx.out(`plan: ${projectDir} — nada pendiente; todos los gates satisfechos.`);
      } else {
        for (const [index, step] of steps.entries()) {
          const parts = [`${index + 1}. ${step.action}`];
          if (step.writes) parts.push(`writes: ${step.writes}`);
          if (step.gate) parts.push(`gate: ${step.gate}`);
          if (step.costUsd !== undefined) parts.push(`cost: ~$${step.costUsd.toFixed(2)}`);
          ctx.out(`   ${parts.join(' | ')}`);
        }
      }
      return { exitCode: 0, planned: steps };
    },
  },
];
