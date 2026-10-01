/**
 * `studioSpecs` — declarative adapters for the creative-workspace services
 * (P-003, contracts.md §5/§6). Commands are DATA over `@videomaker/studio`
 * services; the CLI administers the agent's work (clients, presets,
 * projects, assets, revisions) and never decides composition: no templates,
 * no hidden renderer, no storage logic.
 *
 * Conventions:
 * - Grouped invocations (`client create`, …) are normalized by the runtime
 *   into the internal kebab verbs declared here (see `./studio-pairs`).
 * - Every spec takes `--workspace <dir>` (default `<cwd>/workspace`) and
 *   `--json`; queries print ONLY the stable envelope when `--json` is set.
 * - `plan()` is pure: local reads at most, never writes/network/subprocess
 *   (NFR-002). `run()` refuses in plan mode via the runtime, which never
 *   calls it.
 * - `asset render` exists only around the OPTIONAL recipe: `--plan`/default
 *   show argv/cwd/outputs; execution requires explicit `--execute`, spawns
 *   without a shell inside a confined cwd and NEVER creates a revision.
 *   Snapshot/restore never render.
 * - Typed errors: `StudioServiceError` → JSON envelope (exit 2 input/usage
 *   codes, 1 operational) or `error: CODE: message` for humans.
 */
import { spawn } from 'node:child_process';
import { lstat, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  createClient,
  createCreativeAsset,
  createCreativeProject,
  createPresetVersion,
  createProjectCheckpoint,
  createStudioContext,
  diffAssetRevisions,
  getClient,
  getCreativeProject,
  getPresetVersion,
  getRevisionManifest,
  inspectCreativeAsset,
  isStudioServiceError,
  listAssetRevisions,
  listClients,
  listCreativeProjects,
  listPresetVersions,
  restoreAssetRevision,
  snapshotAsset,
  StudioServiceError,
} from '@videomaker/studio';
import type { PresetRef, StudioContext } from '@videomaker/studio';

import { JSON_ARG, readJsonFile } from '../args';
import { CommandFailure } from '../registry';
import type {
  CommandArgSpec,
  CommandResult,
  CommandRunContext,
  CommandSpec,
  PlanStep,
} from '../spec-types';
import {
  STUDIO_EXIT_OK,
  STUDIO_EXIT_USAGE,
  studioEnvelopeError,
  studioEnvelopeOk,
  studioExitCodeForError,
} from './studio-pairs';

const ASSET_KINDS: readonly string[] = ['image', 'video', 'svg', 'other'];

// ---------------------------------------------------------------------------
// Shared args and context helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ARG: CommandArgSpec = {
  name: 'workspace',
  kind: 'string',
  required: false,
  description: 'Raíz del workspace studio (default: ./workspace relativa al cwd).',
};

/** Studio `--project` is an id (independent projects), not a directory. */
const PROJECT_ID_FLAG: CommandArgSpec = {
  name: 'project',
  kind: 'string',
  required: true,
  description: 'Id del proyecto dueño del asset.',
};

/** The asset id is the first declared arg so the positional `<id>` fills it. */
function idArg(description: string): CommandArgSpec {
  return { name: 'id', kind: 'string', required: true, description };
}

function workspaceDirOf(ctx: CommandRunContext): string {
  const value = ctx.args.workspace;
  const raw = typeof value === 'string' && value.trim().length > 0 ? value : 'workspace';
  return resolve(ctx.cwd, raw);
}

function studioContextOf(ctx: CommandRunContext): StudioContext {
  return createStudioContext(workspaceDirOf(ctx));
}

function jsonMode(ctx: CommandRunContext): boolean {
  return ctx.args.json === true;
}

/** Usage failure (exit 2): JSON envelope only, or actionable human error. */
function failUsage(ctx: CommandRunContext, message: string): never {
  if (jsonMode(ctx)) {
    ctx.out(studioEnvelopeError({ code: 'INVALID_INPUT', message }));
    throw new CommandFailure(message, STUDIO_EXIT_USAGE, { reported: true });
  }
  return ctx.fail(message, STUDIO_EXIT_USAGE);
}

/** Maps typed studio failures to the stable envelope / exit-code contract. */
function failStudio(ctx: CommandRunContext, error: unknown): never {
  if (isStudioServiceError(error)) {
    const exitCode = studioExitCodeForError(error.code);
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeError({ code: error.code, message: error.message, details: error.details }));
      throw new CommandFailure(error.message, exitCode, { reported: true });
    }
    return ctx.fail(`${error.code}: ${error.message}`, exitCode);
  }
  throw error;
}

/** Wraps a service call so every spec surfaces typed errors identically. */
async function withStudio<T>(ctx: CommandRunContext, service: (studio: StudioContext) => Promise<T>): Promise<T> {
  try {
    return await service(studioContextOf(ctx));
  } catch (error) {
    failStudio(ctx, error);
  }
}

function requireString(ctx: CommandRunContext, name: string): string {
  const value = ctx.args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    failUsage(ctx, `--${name} es obligatorio y no puede estar vacío.`);
  }
  return value;
}

function optionalString(ctx: CommandRunContext, name: string): string | undefined {
  const value = ctx.args[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function csvValues(raw: string): string[] {
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** `--presets <preset@version,csv>` → exact preset references. */
function presetRefsFromCsv(ctx: CommandRunContext, raw: string): PresetRef[] {
  return csvValues(raw).map((entry) => {
    const at = entry.indexOf('@');
    if (at <= 0 || at === entry.length - 1) {
      failUsage(ctx, `--presets espera entradas <presetId>@<versionId> separadas por coma; recibido "${entry}".`);
    }
    return { presetId: entry.slice(0, at), versionId: entry.slice(at + 1) };
  });
}

/** `--revisions <asset@revision,csv>` → checkpoint entries (ids only). */
function checkpointEntriesFromCsv(ctx: CommandRunContext, raw: string): Array<{ assetId: string; revisionId: string }> {
  return csvValues(raw).map((entry) => {
    const at = entry.indexOf('@');
    if (at <= 0 || at === entry.length - 1) {
      failUsage(ctx, `--revisions espera entradas <assetId>@<revisionId> separadas por coma; recibido "${entry}".`);
    }
    return { assetId: entry.slice(0, at), revisionId: entry.slice(at + 1) };
  });
}

/** Reads and lightly checks the `preset create --file` JSON document. */
async function presetInputFromFile(
  ctx: CommandRunContext,
): Promise<{ name: string; identity?: unknown; resources?: unknown; visualRefs?: unknown }> {
  const filePath = resolve(ctx.cwd, requireString(ctx, 'file'));
  let document: unknown;
  try {
    document = await readJsonFile(filePath);
  } catch (error) {
    failUsage(
      ctx,
      `--file no contiene JSON válido (${filePath}): ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    failUsage(ctx, `--file debe contener un objeto preset JSON (${filePath}).`);
  }
  const record = document as Record<string, unknown>;
  if (typeof record.name !== 'string' || record.name.trim().length === 0) {
    failUsage(ctx, `--file debe declarar "name" no vacío (${filePath}).`);
  }
  return {
    name: record.name,
    identity: record.identity,
    resources: record.resources,
    visualRefs: record.visualRefs,
  };
}

// ---------------------------------------------------------------------------
// client group
// ---------------------------------------------------------------------------

export const clientCreateSpec: CommandSpec = {
  verb: 'client-create',
  summary: 'client create <id> --name <text> — registra un cliente de marca.',
  args: [
    idArg('Id del cliente (kebab-case).'),
    { name: 'name', kind: 'string', required: true, description: 'Nombre visible del cliente.' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: ['clients/<id>/client.json'],
  movesGates: [],

  plan(ctx): PlanStep[] {
    const id = requireString(ctx, 'id');
    const name = requireString(ctx, 'name');
    return [
      {
        action: `crear cliente "${id}" (${name})`,
        target: join(workspaceDirOf(ctx), 'clients', id, 'client.json'),
        writes: `clients/${id}/client.json`,
      },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const client = await withStudio(ctx, (studio) =>
      createClient(studio, { id: requireString(ctx, 'id'), name: requireString(ctx, 'name') }),
    );
    if (jsonMode(ctx)) ctx.out(studioEnvelopeOk(client));
    else ctx.out(`cliente "${client.id}" (${client.name}) creado en ${join(workspaceDirOf(ctx), 'clients', client.id)}`);
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const clientListSpec: CommandSpec = {
  verb: 'client-list',
  summary: 'client list — lista los clientes del workspace.',
  args: [WORKSPACE_ARG, JSON_ARG],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  plan(ctx): PlanStep[] {
    return [{ action: `listar clientes bajo ${join(workspaceDirOf(ctx), 'clients')} (solo lectura)` }];
  },

  async run(ctx): Promise<CommandResult> {
    const clients = await withStudio(ctx, (studio) => listClients(studio));
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeOk(clients));
      return { exitCode: STUDIO_EXIT_OK };
    }
    ctx.out(`clientes (${clients.length}):`);
    for (const client of clients) ctx.out(`  ${client.id.padEnd(24)} ${client.name}`);
    if (clients.length === 0) ctx.out('  (ninguno)');
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const clientShowSpec: CommandSpec = {
  verb: 'client-show',
  summary: 'client show <id> — muestra un cliente.',
  args: [idArg('Id del cliente.'), WORKSPACE_ARG, JSON_ARG],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  plan(ctx): PlanStep[] {
    const id = requireString(ctx, 'id');
    return [{ action: `leer clients/${id}/client.json (solo lectura)`, target: join(workspaceDirOf(ctx), 'clients', id) }];
  },

  async run(ctx): Promise<CommandResult> {
    const client = await withStudio(ctx, (studio) => getClient(studio, { id: requireString(ctx, 'id') }));
    if (jsonMode(ctx)) ctx.out(studioEnvelopeOk(client));
    else ctx.out(JSON.stringify(client, null, 2));
    return { exitCode: STUDIO_EXIT_OK };
  },
};

// ---------------------------------------------------------------------------
// preset group
// ---------------------------------------------------------------------------

export const presetCreateSpec: CommandSpec = {
  verb: 'preset-create',
  summary:
    'preset create <id> --client <id> --file <json> — crea una versión NUEVA del preset (nunca edita la anterior).',
  args: [
    idArg('Id del preset (kebab-case).'),
    { name: 'client', kind: 'string', required: true, description: 'Id del cliente dueño del preset.' },
    { name: 'file', kind: 'string', required: true, description: 'JSON con { name, identity?, resources?, visualRefs? }.' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: ['presets/<presetId>/versions/<versionId>/preset.json'],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    const presetId = requireString(ctx, 'id');
    const clientId = requireString(ctx, 'client');
    const input = await presetInputFromFile(ctx);
    return [
      {
        action: `crear versión NUEVA del preset "${presetId}" (${input.name}) para el cliente "${clientId}"; versionId lo asigna el servicio`,
        target: join(workspaceDirOf(ctx), 'presets', presetId, 'versions'),
        writes: `presets/${presetId}/versions/<versionId>/preset.json`,
      },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const input = await presetInputFromFile(ctx);
    const preset = await withStudio(ctx, (studio) =>
      createPresetVersion(studio, {
        presetId: requireString(ctx, 'id'),
        clientId: requireString(ctx, 'client'),
        name: input.name,
        // identity/resources/visualRefs pasan tal cual: el servicio los
        // valida con los schemas congelados (parseOrInvalid → INVALID_INPUT).
        identity: input.identity as never,
        resources: input.resources as never,
        visualRefs: input.visualRefs as never,
      }),
    );
    if (jsonMode(ctx)) ctx.out(studioEnvelopeOk(preset));
    else ctx.out(`preset "${preset.presetId}" versión "${preset.versionId}" creada (${preset.name})`);
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const presetListSpec: CommandSpec = {
  verb: 'preset-list',
  summary: 'preset list — lista todas las versiones de presets.',
  args: [WORKSPACE_ARG, JSON_ARG],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  plan(ctx): PlanStep[] {
    return [{ action: `listar versiones bajo ${join(workspaceDirOf(ctx), 'presets')} (solo lectura)` }];
  },

  async run(ctx): Promise<CommandResult> {
    const versions = await withStudio(ctx, (studio) => listPresetVersions(studio, {}));
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeOk(versions));
      return { exitCode: STUDIO_EXIT_OK };
    }
    ctx.out(`versiones de presets (${versions.length}):`);
    for (const preset of versions) {
      ctx.out(`  ${`${preset.presetId}@${preset.versionId}`.padEnd(36)} ${preset.clientId.padEnd(20)} ${preset.name}`);
    }
    if (versions.length === 0) ctx.out('  (ninguna)');
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const presetShowSpec: CommandSpec = {
  verb: 'preset-show',
  summary: 'preset show <id> --version <id> — muestra una versión exacta del preset.',
  args: [
    idArg('Id del preset.'),
    { name: 'version', kind: 'string', required: true, description: 'versionId exacto (inmutable).' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  plan(ctx): PlanStep[] {
    const presetId = requireString(ctx, 'id');
    const versionId = requireString(ctx, 'version');
    return [
      {
        action: `leer presets/${presetId}/versions/${versionId}/preset.json (solo lectura)`,
        target: join(workspaceDirOf(ctx), 'presets', presetId, 'versions', versionId),
      },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const preset = await withStudio(ctx, (studio) =>
      getPresetVersion(studio, { presetId: requireString(ctx, 'id'), versionId: requireString(ctx, 'version') }),
    );
    if (jsonMode(ctx)) ctx.out(studioEnvelopeOk(preset));
    else ctx.out(JSON.stringify(preset, null, 2));
    return { exitCode: STUDIO_EXIT_OK };
  },
};

// ---------------------------------------------------------------------------
// project group
// ---------------------------------------------------------------------------

export const projectCreateSpec: CommandSpec = {
  verb: 'project-create',
  summary: 'project create <id> --name <text> [--clients <csv>] — proyecto independiente (0..n clientes).',
  args: [
    idArg('Id del proyecto (kebab-case).'),
    { name: 'name', kind: 'string', required: true, description: 'Nombre visible del proyecto.' },
    { name: 'clients', kind: 'string', required: false, default: '', description: 'Ids de clientes en CSV (vacío = proyecto sin cliente).' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: ['projects/<id>/project.json'],
  movesGates: [],

  plan(ctx): PlanStep[] {
    const id = requireString(ctx, 'id');
    const name = requireString(ctx, 'name');
    const clientIds = csvValues(optionalString(ctx, 'clients') ?? '');
    return [
      {
        action: `crear proyecto "${id}" (${name}) con clientes [${clientIds.join(', ') || 'sin cliente'}]`,
        target: join(workspaceDirOf(ctx), 'projects', id, 'project.json'),
        writes: `projects/${id}/project.json`,
      },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const project = await withStudio(ctx, (studio) =>
      createCreativeProject(studio, {
        id: requireString(ctx, 'id'),
        name: requireString(ctx, 'name'),
        clientIds: csvValues(optionalString(ctx, 'clients') ?? ''),
      }),
    );
    if (jsonMode(ctx)) ctx.out(studioEnvelopeOk(project));
    else ctx.out(`proyecto "${project.id}" creado (${project.name}; clientes: ${project.clientIds.join(', ') || 'ninguno'})`);
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const projectListSpec: CommandSpec = {
  verb: 'project-list',
  summary: 'project list — lista los proyectos.',
  args: [WORKSPACE_ARG, JSON_ARG],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  plan(ctx): PlanStep[] {
    return [{ action: `listar proyectos bajo ${join(workspaceDirOf(ctx), 'projects')} (solo lectura)` }];
  },

  async run(ctx): Promise<CommandResult> {
    const projects = await withStudio(ctx, (studio) => listCreativeProjects(studio));
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeOk(projects));
      return { exitCode: STUDIO_EXIT_OK };
    }
    ctx.out(`proyectos (${projects.length}):`);
    for (const project of projects) {
      ctx.out(`  ${project.id.padEnd(24)} clientes=[${project.clientIds.join(', ')}] ${project.name}`);
    }
    if (projects.length === 0) ctx.out('  (ninguno)');
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const projectShowSpec: CommandSpec = {
  verb: 'project-show',
  summary: 'project show <id> — muestra un proyecto.',
  args: [idArg('Id del proyecto.'), WORKSPACE_ARG, JSON_ARG],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  plan(ctx): PlanStep[] {
    const id = requireString(ctx, 'id');
    return [{ action: `leer projects/${id}/project.json (solo lectura)`, target: join(workspaceDirOf(ctx), 'projects', id) }];
  },

  async run(ctx): Promise<CommandResult> {
    const project = await withStudio(ctx, (studio) => getCreativeProject(studio, { id: requireString(ctx, 'id') }));
    if (jsonMode(ctx)) ctx.out(studioEnvelopeOk(project));
    else ctx.out(JSON.stringify(project, null, 2));
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const projectCheckpointSpec: CommandSpec = {
  verb: 'project-checkpoint',
  summary: 'project checkpoint <id> --revisions <asset@revision,csv> — mapa inmutable assetId → revisión.',
  args: [
    idArg('Id del proyecto.'),
    { name: 'revisions', kind: 'string', required: true, description: 'Entradas <assetId>@<revisionId> en CSV.' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: ['checkpoints/<projectId>/<checkpointId>.json'],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    const projectId = requireString(ctx, 'id');
    const entries = checkpointEntriesFromCsv(ctx, requireString(ctx, 'revisions'));
    const steps: PlanStep[] = [];
    for (const entry of entries) {
      const manifest = await withStudio(ctx, (studio) =>
        getRevisionManifest(studio, { projectId, assetId: entry.assetId, revisionId: entry.revisionId }),
      );
      steps.push({
        action: `fijar ${entry.assetId} → ${entry.revisionId} (rootHash ${manifest.rootHash.slice(0, 12)}…)`,
      });
    }
    steps.push({
      action: `escribir checkpoint inmutable de "${projectId}" (checkpointId lo asigna el servicio)`,
      target: join(workspaceDirOf(ctx), 'checkpoints', projectId),
      writes: `checkpoints/${projectId}/<checkpointId>.json`,
    });
    return steps;
  },

  async run(ctx): Promise<CommandResult> {
    const checkpoint = await withStudio(ctx, (studio) =>
      createProjectCheckpoint(studio, {
        projectId: requireString(ctx, 'id'),
        entries: checkpointEntriesFromCsv(ctx, requireString(ctx, 'revisions')),
      }),
    );
    if (jsonMode(ctx)) ctx.out(studioEnvelopeOk(checkpoint));
    else
      ctx.out(
        `checkpoint "${checkpoint.checkpointId}" creado con ${checkpoint.entries.length} entrada(s) ` +
          `→ checkpoints/${checkpoint.projectId}/${checkpoint.checkpointId}.json`,
      );
    return { exitCode: STUDIO_EXIT_OK };
  },
};

// ---------------------------------------------------------------------------
// asset group
// ---------------------------------------------------------------------------

export const assetCreateSpec: CommandSpec = {
  verb: 'asset-create',
  summary:
    'asset create <id> --project <id> --kind <kind> [--presets <preset@version,csv>] — asset abierto, sin outputs ni renderer.',
  args: [
    idArg('Id del asset (kebab-case).'),
    PROJECT_ID_FLAG,
    { name: 'kind', kind: 'string', required: true, description: `Tipo del asset: ${ASSET_KINDS.join(' | ')}.` },
    { name: 'presets', kind: 'string', required: false, default: '', description: 'Referencias exactas <presetId>@<versionId> en CSV (varias marcas permitidas).' },
    { name: 'title', kind: 'string', required: false, description: 'Título visible (default: el id del asset).' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: ['projects/<project>/assets/<id>/asset.json'],
  movesGates: [],

  plan(ctx): PlanStep[] {
    const id = requireString(ctx, 'id');
    const projectId = requireString(ctx, 'project');
    const kind = requireString(ctx, 'kind');
    if (!ASSET_KINDS.includes(kind)) {
      failUsage(ctx, `--kind debe ser uno de: ${ASSET_KINDS.join(', ')}; recibido "${kind}".`);
    }
    const presetRefs = presetRefsFromCsv(ctx, optionalString(ctx, 'presets') ?? '');
    return [
      {
        action: `crear asset abierto "${id}" (${kind}) en el proyecto "${projectId}" con presets [${presetRefs
          .map((ref) => `${ref.presetId}@${ref.versionId}`)
          .join(', ') || 'ninguno'}]; sin outputs ni recipe exigidos`,
        target: join(workspaceDirOf(ctx), 'projects', projectId, 'assets', id, 'asset.json'),
        writes: `projects/${projectId}/assets/${id}/asset.json`,
      },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const kind = requireString(ctx, 'kind');
    if (!ASSET_KINDS.includes(kind)) {
      failUsage(ctx, `--kind debe ser uno de: ${ASSET_KINDS.join(', ')}; recibido "${kind}".`);
    }
    const asset = await withStudio(ctx, (studio) =>
      createCreativeAsset(studio, {
        id: requireString(ctx, 'id'),
        projectId: requireString(ctx, 'project'),
        // El servicio valida kind/presetRefs con los schemas congelados
        // (INVALID_INPUT accionable); la CLI pasa el valor declarado.
        kind: kind as never,
        title: optionalString(ctx, 'title'),
        presetRefs: presetRefsFromCsv(ctx, optionalString(ctx, 'presets') ?? ''),
      }),
    );
    if (jsonMode(ctx)) ctx.out(studioEnvelopeOk(asset));
    else
      ctx.out(
        `asset "${asset.id}" creado en ${join(workspaceDirOf(ctx), 'projects', asset.projectId, 'assets', asset.id)} ` +
          `(sin outputs exigidos; declará rutas y recipe editando asset.json)`,
      );
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const assetInspectSpec: CommandSpec = {
  verb: 'asset-inspect',
  summary: 'asset inspect <id> --project <id> — muestra rutas reales, fuentes, presets exactos y estado.',
  args: [idArg('Id del asset.'), PROJECT_ID_FLAG, WORKSPACE_ARG, JSON_ARG],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  plan(ctx): PlanStep[] {
    const assetId = requireString(ctx, 'id');
    const projectId = requireString(ctx, 'project');
    return [
      {
        action: `inspeccionar asset.json, fuentes, outputs y estado de sync (solo lectura)`,
        target: join(workspaceDirOf(ctx), 'projects', projectId, 'assets', assetId),
      },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const inspection = await withStudio(ctx, (studio) =>
      inspectCreativeAsset(studio, { projectId: requireString(ctx, 'project'), assetId: requireString(ctx, 'id') }),
    );
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeOk(inspection));
      return { exitCode: STUDIO_EXIT_OK };
    }
    ctx.out(`asset ${inspection.asset.id} (${inspection.asset.kind}) — ${inspection.asset.title}`);
    ctx.out(`  dir:      ${inspection.assetDir}`);
    ctx.out(
      `  fuentes:  ${inspection.sources.map((source) => `${source.path}${source.present ? '' : ' [AUSENTE]'}`).join(', ') || '(ninguna)'}`,
    );
    ctx.out(
      `  inputs:   ${inspection.inputs.map((input) => `${input.path}${input.present ? '' : ' [AUSENTE]'}`).join(', ') || '(ninguno)'}`,
    );
    ctx.out(
      `  presets:  ${inspection.presets
        .map((ref) => `${ref.presetId}@${ref.versionId}${ref.preset ? ` (${ref.preset.name})` : ' [FALTANTE]'}`)
        .join(', ') || '(ninguno)'}`,
    );
    ctx.out(
      `  outputs:  ${inspection.outputs
        .map((output) => `${output.name} → ${output.path} (${output.mediaType}, ${output.present ? 'presente' : 'AUSENTE'})`)
        .join(', ') || '(ninguno declarado)'}`,
    );
    ctx.out(
      `  recipe:   ${
        inspection.recipe
          ? `${JSON.stringify(inspection.recipe.argv)} (cwd ${inspection.recipe.cwd}; outputs: ${inspection.recipe.outputs.join(', ')})`
          : '(sin recipe — declarala en asset.json; ejecutarla requiere asset render --execute)'
      }`,
    );
    ctx.out(
      `  history:  ${inspection.history.length} revisión(es); sync: ${
        inspection.sync.map((entry) => `${entry.revisionId}=${entry.status}`).join(', ') || 'sin revisiones'
      }`,
    );
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const assetSnapshotSpec: CommandSpec = {
  verb: 'asset-snapshot',
  summary: 'asset snapshot <id> --project <id> --note <text> — sella una revisión inmutable (sin render ni red).',
  args: [
    idArg('Id del asset.'),
    PROJECT_ID_FLAG,
    { name: 'note', kind: 'string', required: true, description: 'Nota descriptiva de la revisión.' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: ['revisions/<project>/<asset>/<revisionId>/manifest.json'],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    const inspection = await withStudio(ctx, (studio) =>
      inspectCreativeAsset(studio, { projectId: requireString(ctx, 'project'), assetId: requireString(ctx, 'id') }),
    );
    const steps: PlanStep[] = [
      {
        action: `sellar asset.json + fuentes/inputs declarados de "${inspection.asset.id}"`,
        target: inspection.assetDir,
      },
    ];
    for (const output of inspection.outputs) {
      steps.push({
        action: output.present
          ? `sellar output "${output.name}" (${output.path})`
          : `output "${output.name}" ausente: se omite del sello (queda marcado faltante en producción)`,
        target: join(inspection.assetDir, output.path),
      });
    }
    steps.push({
      action: 'publicar la revisión atómicamente bajo revisions/<p>/<a>/<revisionId asignado> (lock por asset, hashes verificados)',
      target: join(workspaceDirOf(ctx), 'revisions', inspection.asset.projectId, inspection.asset.id),
      writes: `revisions/${inspection.asset.projectId}/${inspection.asset.id}/<revisionId>/manifest.json`,
    });
    return steps;
  },

  async run(ctx): Promise<CommandResult> {
    const result = await withStudio(ctx, (studio) =>
      snapshotAsset(studio, {
        projectId: requireString(ctx, 'project'),
        assetId: requireString(ctx, 'id'),
        note: requireString(ctx, 'note'),
      }),
    );
    if (jsonMode(ctx)) {
      ctx.out(
        studioEnvelopeOk({
          revisionId: result.revision.revisionId,
          rootHash: result.revision.rootHash,
          parentRevisionId: result.revision.parentRevisionId,
          createdAt: result.revision.createdAt,
          note: result.revision.note,
          editorialStatus: result.revision.editorialStatus,
          manifestPath: result.manifestPath,
          fileCount: result.revision.files.length,
          outputs: result.revision.outputs.map((output) => output.name),
        }),
      );
    } else {
      ctx.out(
        `revisión ${result.revision.revisionId} sellada (rootHash ${result.revision.rootHash.slice(0, 12)}…, ` +
          `${result.revision.files.length} archivos) → ${result.manifestPath}`,
      );
    }
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const assetHistorySpec: CommandSpec = {
  verb: 'asset-history',
  summary: 'asset history <id> --project <id> — lista las revisiones selladas.',
  args: [idArg('Id del asset.'), PROJECT_ID_FLAG, WORKSPACE_ARG, JSON_ARG],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  plan(ctx): PlanStep[] {
    const assetId = requireString(ctx, 'id');
    const projectId = requireString(ctx, 'project');
    return [
      {
        action: `leer revisions/${projectId}/${assetId}/<revisionId>/manifest.json (solo lectura)`,
        target: join(workspaceDirOf(ctx), 'revisions', projectId, assetId),
      },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const revisions = await withStudio(ctx, (studio) =>
      listAssetRevisions(studio, { projectId: requireString(ctx, 'project'), assetId: requireString(ctx, 'id') }),
    );
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeOk(revisions));
      return { exitCode: STUDIO_EXIT_OK };
    }
    ctx.out(`revisiones de ${requireString(ctx, 'id')} (${revisions.length}):`);
    for (const revision of revisions) {
      ctx.out(`  ${revision.revisionId.padEnd(20)} ${revision.createdAt} ${revision.editorialStatus.padEnd(10)} ${revision.rootHash.slice(0, 12)}… ${revision.note}`);
    }
    if (revisions.length === 0) ctx.out('  (ninguna)');
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const assetDiffSpec: CommandSpec = {
  verb: 'asset-diff',
  summary: 'asset diff <id> --project <id> --from <revision> --to <revision> — archivos/outputs/presets/recipe cambiados.',
  args: [
    idArg('Id del asset.'),
    PROJECT_ID_FLAG,
    { name: 'from', kind: 'string', required: true, description: 'RevisionId base.' },
    { name: 'to', kind: 'string', required: true, description: 'RevisionId a comparar.' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    const projectId = requireString(ctx, 'project');
    const assetId = requireString(ctx, 'id');
    const diff = await withStudio(ctx, (studio) =>
      diffAssetRevisions(studio, {
        projectId,
        assetId,
        fromRevisionId: requireString(ctx, 'from'),
        toRevisionId: requireString(ctx, 'to'),
      }),
    );
    return [
      {
        action: `diff ${diff.from.revisionId} (rootHash ${diff.from.rootHash.slice(0, 12)}…) → ${diff.to.revisionId} (rootHash ${diff.to.rootHash.slice(0, 12)}…); solo lectura`,
      },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const diff = await withStudio(ctx, (studio) =>
      diffAssetRevisions(studio, {
        projectId: requireString(ctx, 'project'),
        assetId: requireString(ctx, 'id'),
        fromRevisionId: requireString(ctx, 'from'),
        toRevisionId: requireString(ctx, 'to'),
      }),
    );
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeOk(diff));
      return { exitCode: STUDIO_EXIT_OK };
    }
    ctx.out(`diff ${diff.from.revisionId} → ${diff.to.revisionId}`);
    for (const [label, change] of [
      ['archivos', diff.files],
      ['outputs', diff.outputs],
      ['presets', diff.presets],
    ] as const) {
      const detail = [
        change.added.length > 0 ? `añadidos: ${change.added.join(', ')}` : '',
        change.removed.length > 0 ? `eliminados: ${change.removed.join(', ')}` : '',
        change.modified.length > 0 ? `modificados: ${change.modified.join(', ')}` : '',
      ]
        .filter((part) => part.length > 0)
        .join(' | ');
      ctx.out(`  ${label}: ${detail || 'sin cambios'}`);
    }
    ctx.out(`  recipe: ${diff.recipe}`);
    return { exitCode: STUDIO_EXIT_OK };
  },
};

export const assetRestoreSpec: CommandSpec = {
  verb: 'asset-restore',
  summary: 'asset restore <id> --project <id> --revision <id> --out <empty-dir> — restaura hashes exactos (no regenera ni ejecuta).',
  args: [
    idArg('Id del asset.'),
    PROJECT_ID_FLAG,
    { name: 'revision', kind: 'string', required: true, description: 'RevisionId a restaurar.' },
    { name: 'out', kind: 'string', required: true, description: 'Directorio destino VACÍO (nunca sobrescribe).' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: ['<out>/**'],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    const manifest = await withStudio(ctx, (studio) =>
      getRevisionManifest(studio, {
        projectId: requireString(ctx, 'project'),
        assetId: requireString(ctx, 'id'),
        revisionId: requireString(ctx, 'revision'),
      }),
    );
    const outDir = resolve(ctx.cwd, requireString(ctx, 'out'));
    return [
      {
        action: `verificar SHA-256 de ${manifest.files.length} archivo(s) sellados de ${manifest.revisionId} (rootHash ${manifest.rootHash.slice(0, 12)}…)`,
      },
      {
        action: `restaurar ${manifest.files.length} archivo(s) en ${outDir} (debe estar vacío; conflicto = error, sin sobrescritura)`,
        target: outDir,
        writes: '<out>/**',
      },
      { action: 'la restauración NO regenera ni ejecuta nada: copia sellada exacta' },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const result = await withStudio(ctx, (studio) =>
      restoreAssetRevision(studio, {
        projectId: requireString(ctx, 'project'),
        assetId: requireString(ctx, 'id'),
        revisionId: requireString(ctx, 'revision'),
        outDir: resolve(ctx.cwd, requireString(ctx, 'out')),
      }),
    );
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeOk({ outDir: result.outDir, files: result.restored }));
    } else {
      ctx.out(`restaurados ${result.restored.length} archivo(s) en ${result.outDir} (SHA-256 verificados, sin regenerar)`);
    }
    return { exitCode: STUDIO_EXIT_OK };
  },
};

/**
 * Resolves recipe.cwd strictly INSIDE the asset dir, rejecting traversal and
 * any symlink component between the asset dir and the target (a symlinked
 * parent must never become the spawn cwd).
 */
async function resolveRecipeCwd(assetDir: string, recipeCwd: string): Promise<string> {
  const abs = resolve(assetDir, recipeCwd);
  const rel = relative(assetDir, abs);
  if (isAbsolute(rel) || rel.startsWith('..')) {
    throw new StudioServiceError('PATH_UNSAFE', `recipe.cwd escapa del directorio del asset: ${recipeCwd}`);
  }
  if (rel.length === 0) return abs;
  let current = assetDir;
  for (const part of rel.split(sep).filter((segment) => segment.length > 0)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) {
      throw new StudioServiceError('NOT_FOUND', `recipe.cwd no existe dentro del asset: ${recipeCwd}`);
    }
    if (info.isSymbolicLink()) {
      throw new StudioServiceError('PATH_UNSAFE', `recipe.cwd atraviesa un symlink: ${current}`);
    }
  }
  const finalInfo = await stat(abs).catch(() => null);
  if (!finalInfo?.isDirectory()) {
    throw new StudioServiceError('NOT_FOUND', `recipe.cwd debe ser un directorio dentro del asset: ${recipeCwd}`);
  }
  return abs;
}

/** Loads the asset inspection and requires the explicit recipe for render. */
async function renderRecipeOf(ctx: CommandRunContext): Promise<{
  assetDir: string;
  argv: string[];
  recipeCwd: string;
  outputs: string[];
}> {
  const inspection = await withStudio(ctx, (studio) =>
    inspectCreativeAsset(studio, { projectId: requireString(ctx, 'project'), assetId: requireString(ctx, 'id') }),
  );
  const recipe = inspection.recipe;
  if (!recipe) {
    failUsage(
      ctx,
      `asset "${inspection.asset.id}" no declara recipe en ${join(inspection.assetDir, 'asset.json')} ` +
        `(agregá "recipe": { "argv": [...], "cwd": ".", "outputs": [...] }); la CLI no inventa renderers ni busca templates.`,
    );
  }
  return {
    assetDir: inspection.assetDir,
    argv: recipe.argv,
    recipeCwd: recipe.cwd,
    outputs: recipe.outputs,
  };
}

function renderPlanSteps(assetDir: string, argv: readonly string[], recipeCwd: string, outputs: readonly string[]): PlanStep[] {
  return [
    {
      action: `ejecutar SIN shell: ${JSON.stringify(argv)} (cwd confinado al asset)`,
      target: resolve(assetDir, recipeCwd),
    },
    {
      action: `outputs que produce el proceso (no la CLI): ${outputs.join(', ')}`,
      writes: outputs.join(', '),
    },
    { action: 'la ejecución NO crea revisiones; sellá después con `asset snapshot`' },
  ];
}

export const assetRenderSpec: CommandSpec = {
  verb: 'asset-render',
  summary:
    'asset render <id> --project <id> [--execute] — wrapper OPCIONAL de la recipe: sin --execute solo muestra argv/cwd/outputs.',
  args: [
    idArg('Id del asset.'),
    PROJECT_ID_FLAG,
    { name: 'execute', kind: 'boolean', required: false, default: false, description: 'Ejecutar la recipe de verdad (opt-in inequívoco; spawn directo, sin shell).' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: ['<recipe.outputs dentro del asset> (solo con --execute, escritos por el proceso)'],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    const { assetDir, argv, recipeCwd, outputs } = await renderRecipeOf(ctx);
    return renderPlanSteps(assetDir, argv, recipeCwd, outputs);
  },

  async run(ctx): Promise<CommandResult> {
    const { assetDir, argv, recipeCwd, outputs } = await renderRecipeOf(ctx);

    // Without --execute the command is a read-only preview: never spawn.
    if (!ctx.args.execute) {
      if (jsonMode(ctx)) {
        ctx.out(
          studioEnvelopeOk({
            executed: false,
            argv,
            cwd: resolve(assetDir, recipeCwd),
            outputs,
            hint: 'Añadé --execute para ejecutar la recipe; sellá la revisión con asset snapshot.',
          }),
        );
      } else {
        ctx.out(`recipe de ${JSON.stringify(requireString(ctx, 'id'))}: ${JSON.stringify(argv)}`);
        ctx.out(`  cwd:     ${resolve(assetDir, recipeCwd)} (confinado al asset)`);
        ctx.out(`  outputs: ${outputs.join(', ')}`);
        ctx.out('  (preview; añadé --execute para ejecutar. La ejecución no crea revisiones.)');
      }
      return { exitCode: STUDIO_EXIT_OK };
    }

    try {
      const cwdAbs = await withStudio(ctx, () => resolveRecipeCwd(assetDir, recipeCwd));
      // En modo JSON el stdout pertenece al envelope: el stdout/stderr del
      // proceso se desvía a stderr. Sin --json (y sin shell) todo hereda.
      const jsonRecipe = jsonMode(ctx);
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: cwdAbs,
        shell: false,
        stdio: jsonRecipe ? ['inherit', 'pipe', 'pipe'] : 'inherit',
      });
      if (jsonRecipe) {
        child.stdout?.pipe(process.stderr);
        child.stderr?.pipe(process.stderr);
      }
      const exitCode = await new Promise<number>((settleExit, rejectSpawn) => {
        child.on('error', (error) => {
          rejectSpawn(new StudioServiceError('RECIPE_FAILED', `no se pudo ejecutar "${argv[0]}": ${error.message}`));
        });
        child.on('close', (code) => settleExit(code ?? 1));
      });
      if (exitCode !== 0) {
        throw new StudioServiceError(
          'RECIPE_FAILED',
          `la recipe terminó con exit ${exitCode}; no se creó ninguna revisión.`,
        );
      }
      if (jsonMode(ctx)) {
        ctx.out(studioEnvelopeOk({ executed: true, exitCode, argv, cwd: cwdAbs, outputs }));
      } else {
        ctx.out(`recipe ejecutada (exit 0); outputs declarados: ${outputs.join(', ')}`);
        ctx.out('sellá la revisión con `asset snapshot` (el render no versiona por sí solo).');
      }
      return { exitCode: STUDIO_EXIT_OK };
    } catch (error) {
      // Spawn ENOENT / cwd inseguro / exit != 0: envelope tipado y exit
      // coherente; JAMÁS se crea una revisión desde el render.
      failStudio(ctx, error);
    }
  },
};

/** All studio commands, in registry/display order (pairs per contracts.md §6). */
export const studioSpecs: CommandSpec[] = [
  clientCreateSpec,
  clientListSpec,
  clientShowSpec,
  presetCreateSpec,
  presetListSpec,
  presetShowSpec,
  projectCreateSpec,
  projectListSpec,
  projectShowSpec,
  projectCheckpointSpec,
  assetCreateSpec,
  assetInspectSpec,
  assetSnapshotSpec,
  assetHistorySpec,
  assetDiffSpec,
  assetRestoreSpec,
  assetRenderSpec,
];
