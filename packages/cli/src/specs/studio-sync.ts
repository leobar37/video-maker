/**
 * `studioSyncSpecs` — declarative adapters for the backup commands (P-004,
 * contracts.md §6/§7): `sync push`, `sync verify` and `sync recover`.
 *
 * Conventions:
 * - The R2 storage is resolved LAZILY and only inside a real `run()`:
 *   `--plan`/`--dry-run` never resolve credentials, never build a client and
 *   never touch the network (NFR-002). The lazy `await import` is deliberate:
 *   a static import would drag the AWS SDK and the credentials resolver into
 *   every CLI startup, including unrelated commands.
 * - Private by default: the storage factory requires the explicit private
 *   archive bucket (R2_BUNDLES_BUCKET_NAME) and refuses to fall back to the
 *   media bucket, which can be public. Nothing here writes public objects.
 * - `sync push` returns exit 1 when any receipt ended `failed`; receipts are
 *   the evidence, a boolean is never trusted.
 * - `sync verify` returns exit 1 when `failures` is not empty (contracts §5)
 *   and still prints the full evidence (verified + failures) as data.
 * - `sync recover` rebuilds the project in an EMPTY directory from the remote
 *   backup only; it never reads the local registry and never regenerates.
 */
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  createStudioContext,
  getRevisionManifest,
  isStudioServiceError,
  listAssetRevisions,
  recoverProjectFromStorage,
  StudioServiceError,
  syncProject,
  verifyProjectBackup,
  type RevisionRef,
  type StudioContext,
  type StudioStorage,
} from '@videomaker/studio';

import { JSON_ARG } from '../args';
import { CommandFailure } from '../registry';
import type {
  CommandArgSpec,
  CommandResult,
  CommandRunContext,
  CommandSpec,
  PlanStep,
} from '../spec-types';
import { STUDIO_EXIT_OK, STUDIO_EXIT_OPERATIONAL, STUDIO_EXIT_USAGE, studioEnvelopeError, studioExitCodeForError } from './studio-pairs';

const WORKSPACE_ARG: CommandArgSpec = {
  name: 'workspace',
  kind: 'string',
  required: false,
  description: 'Raíz del workspace studio (default: ./workspace relativa al cwd).',
};

const PROJECT_ARG: CommandArgSpec = {
  name: 'project',
  kind: 'string',
  required: true,
  description: 'Id del proyecto a respaldar/verificar/recuperar.',
};

// ---------------------------------------------------------------------------
// Local helpers (mirror of the P-003 studio spec conventions)
// ---------------------------------------------------------------------------

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

function requireString(ctx: CommandRunContext, name: string): string {
  const value = ctx.args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return failUsage(ctx, `--${name} es obligatorio y no puede estar vacío.`);
  }
  return value;
}

/** Maps typed studio failures to the stable envelope / exit-code contract. */
function failStudio(ctx: CommandRunContext, error: unknown): never {
  if (isStudioServiceError(error)) {
    const exitCode = studioExitCodeForError(error.code);
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeError({ code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) }));
      throw new CommandFailure(error.message, exitCode, { reported: true });
    }
    return ctx.fail(`${error.code}: ${error.message}`, exitCode);
  }
  throw error;
}

async function withStudio<T>(ctx: CommandRunContext, service: (studio: StudioContext) => Promise<T>): Promise<T> {
  try {
    return await service(studioContextOf(ctx));
  } catch (error) {
    failStudio(ctx, error);
  }
}

// ---------------------------------------------------------------------------
// Lazy private storage (NFR-002: only a REAL sync run resolves anything)
// ---------------------------------------------------------------------------

type StudioStorageLoader = () => Promise<StudioStorage>;

let storageLoaderOverride: StudioStorageLoader | undefined;

/** Test seam: inject a fake storage without touching credentials/R2. */
export function setStudioSyncStorageLoaderForTests(loader?: StudioStorageLoader): void {
  storageLoaderOverride = loader;
}

function toStorageStartupError(error: unknown): StudioServiceError {
  if (isStudioServiceError(error)) return error;
  if (error instanceof Error) {
    if (error.name === 'StudioPrivateBucketMissingError') {
      return new StudioServiceError('STORAGE_UNAVAILABLE', error.message);
    }
    if (error.message.includes('Missing required environment variables')) {
      return new StudioServiceError('AUTH_REQUIRED', 'Falta configuración R2 para sync (valores nunca impresos).', {
        hint: 'Declará R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT y R2_BUNDLES_BUCKET_NAME (bucket privado).',
      });
    }
  }
  return new StudioServiceError('STORAGE_UNAVAILABLE', 'No se pudo preparar el almacenamiento privado (detalle redactado).', undefined, error);
}

async function loadPrivateStorage(ctx: CommandRunContext): Promise<StudioStorage> {
  if (storageLoaderOverride !== undefined) {
    try {
      return await storageLoaderOverride();
    } catch (error) {
      failStudio(ctx, toStorageStartupError(error));
    }
  }
  // Deliberate lazy `await import` of literal modules: credentials and the
  // AWS SDK must only load for a real sync run, never at CLI startup nor in
  // plan mode (contracts.md §6 "R2 se resuelve lazy").
  const { createPrivateStudioR2Storage } = await import('@videomaker/providers');
  const { resolveR2Env } = await import('@videomaker/credentials');
  try {
    const env = await resolveR2Env({ mode: 'run' });
    return createPrivateStudioR2Storage(env);
  } catch (error) {
    failStudio(ctx, toStorageStartupError(error));
  }
}

/** `--revisions <asset@revision,csv>` → explicit recovery selector. */
function revisionRefsFromCsv(ctx: CommandRunContext, raw: string): RevisionRef[] {
  const projectId = requireString(ctx, 'project');
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((entry) => {
      const at = entry.indexOf('@');
      if (at <= 0 || at === entry.length - 1) {
        return failUsage(ctx, `--revisions espera entradas <assetId>@<revisionId> separadas por coma; recibido "${entry}".`);
      }
      return { projectId, assetId: entry.slice(0, at), revisionId: entry.slice(at + 1) };
    });
}

/** `--checkpoint` and `--revisions` are mutually exclusive selectors. */
function assertSingleSelector(ctx: CommandRunContext): void {
  const hasCheckpoint = typeof ctx.args.checkpoint === 'string' && ctx.args.checkpoint.trim().length > 0;
  const hasRevisions = typeof ctx.args.revisions === 'string' && ctx.args.revisions.trim().length > 0;
  if (hasCheckpoint && hasRevisions) {
    failUsage(ctx, 'Elegí un solo selector activo: --checkpoint o --revisions, no ambos.');
  }
}

interface AssetRevisionSummary {
  assetId: string;
  revisions: Array<{ revisionId: string; files: number }>;
}

/** Local read-only summary for plan steps (readdir + history; no network). */
async function localRevisionSummary(studio: StudioContext, projectId: string): Promise<AssetRevisionSummary[]> {
  const assetsDir = join(studio.workspaceDir, 'projects', projectId, 'assets');
  const assetIds = (await readdir(assetsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const summary: AssetRevisionSummary[] = [];
  for (const assetId of assetIds) {
    const revisions = await listAssetRevisions(studio, { projectId, assetId });
    const detailed = await Promise.all(
      revisions.map(async (revision) => ({
        revisionId: revision.revisionId,
        files: (await getRevisionManifest(studio, { projectId, assetId, revisionId: revision.revisionId })).files.length,
      })),
    );
    summary.push({ assetId, revisions: detailed });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// sync push
// ---------------------------------------------------------------------------

export const syncPushSpec: CommandSpec = {
  verb: 'sync-push',
  summary: 'sync push --project <id> — respaldo privado completo e idempotente (manifest = commit).',
  args: [PROJECT_ARG, WORKSPACE_ARG, JSON_ARG],
  supportsPlan: true,
  writes: ['.vm/receipts/**', 'remoto: objects/<sha-prefix>/<sha>', 'remoto: studio/v1/projects/<p>/**'],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    const projectId = requireString(ctx, 'project');
    const studio = studioContextOf(ctx);
    const assets = await withStudio(ctx, () => localRevisionSummary(studio, projectId));
    const steps: PlanStep[] = [
      { action: 'resolver bucket PRIVADO explícito (R2_BUNDLES_BUCKET_NAME); sin fallback al bucket de medios' },
    ];
    for (const asset of assets) {
      for (const revision of asset.revisions) {
        steps.push({
          action: `subir objetos faltantes de ${asset.assetId}@${revision.revisionId} (${revision.files} archivos, dedup por sha) y confirmar tamaño/SHA-256`,
          writes: 'remoto: objects/<sha-prefix>/<sha>',
        });
        steps.push({
          action: `commitear manifest inmutable de ${asset.assetId}@${revision.revisionId} (IfNoneMatch; misma key con otros bytes = CONFLICT)`,
          writes: `remoto: studio/v1/projects/${projectId}/assets/${asset.assetId}/revisions/${revision.revisionId}/manifest.json`,
        });
      }
    }
    steps.push({ action: 'escribir receipts confirmed SOLO tras confirmar manifest y todos los objetos (failed ≠ confirmed)' });
    steps.push({ action: 'nunca regenerar outputs: los bytes salen de las copias selladas locales' });
    return steps;
  },

  async run(ctx): Promise<CommandResult> {
    const projectId = requireString(ctx, 'project');
    const storage = await loadPrivateStorage(ctx);
    const { receipts } = await withStudio(ctx, (studio) => syncProject(studio, { projectId, storage }));
    const failed = receipts.filter((receipt) => receipt.status === 'failed');
    if (failed.length > 0) {
      // ONE output, and it is an error envelope: never ok:true followed by a
      // failure. Receipts (safe, redacted) ride along as evidence.
      const first = failed[0]!.error ?? { code: 'STORAGE_UNAVAILABLE' as const, message: 'revisión fallida sin error registrado.' };
      if (jsonMode(ctx)) {
        ctx.out(
          studioEnvelopeError({
            code: first.code,
            message: `sync de "${projectId}" terminó con ${failed.length} revisión(es) fallidas; receipts persistidos en .vm/receipts.`,
            details: { receipts },
          }),
        );
      } else {
        for (const receipt of receipts) {
          const state = receipt.status === 'confirmed' ? 'confirmed' : `${receipt.status}${receipt.error !== undefined ? ` (${receipt.error.code}: ${receipt.error.message})` : ''}`;
          ctx.out(`${receipt.assetId}@${receipt.revisionId}: ${state}`);
        }
      }
      throw new CommandFailure(
        `sync de "${projectId}" terminó con ${failed.length} revisión(es) fallidas (receipts failed, nunca confirmed).`,
        STUDIO_EXIT_OPERATIONAL,
        { reported: true },
      );
    }
    if (jsonMode(ctx)) {
      ctx.out(JSON.stringify({ schemaVersion: 1, ok: true, data: { receipts, failedCount: 0 } }, null, 2));
    } else {
      for (const receipt of receipts) {
        ctx.out(`${receipt.assetId}@${receipt.revisionId}: confirmed`);
      }
      ctx.out(`sync de "${projectId}": ${receipts.length}/${receipts.length} revisión(es) confirmadas`);
    }
    return { exitCode: STUDIO_EXIT_OK };
  },
};

// ---------------------------------------------------------------------------
// sync verify
// ---------------------------------------------------------------------------

export const syncVerifySpec: CommandSpec = {
  verb: 'sync-verify',
  summary: 'sync verify --project <id> [--deep] — verifica el respaldo remoto; exit 1 si hay failures.',
  args: [
    PROJECT_ARG,
    { name: 'deep', kind: 'boolean', required: false, default: false, description: 'Deep verify: GET + SHA-256 de cada objeto (no solo HEAD/metadatos).' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    const projectId = requireString(ctx, 'project');
    const deep = ctx.args.deep === true;
    return [
      { action: `listar manifests remotos de ${projectId} por prefix con cursores hasta el fin` },
      { action: 'validar cada manifest (schema + rootHash + ids) y cruzar con las revisiones locales por bytes exactos' },
      { action: `verificar objetos: ${deep ? 'GET + SHA-256 de cada objeto (deep)' : 'HEAD (tamaño + sha256 de metadatos)'}` },
      { action: 'reportar failures; el adaptador CLI retorna exit 1 si no está vacío' },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const projectId = requireString(ctx, 'project');
    const deep = ctx.args.deep === true;
    const storage = await loadPrivateStorage(ctx);
    const result = await withStudio(ctx, (studio) => verifyProjectBackup(studio, { projectId, storage, deep }));
    if (result.failures.length > 0) {
      // ONE output: the error envelope carries verified + failures as safe
      // evidence; exit stays 1 (contracts.md §5). Never ok:true + failure.
      const first = result.failures[0]!;
      if (jsonMode(ctx)) {
        ctx.out(
          studioEnvelopeError({
            code: first.code,
            message: `sync verify de "${projectId}" reportó ${result.failures.length} failure(s).`,
            details: { verified: result.verified, failures: result.failures },
          }),
        );
      } else {
        ctx.out(`verificadas ${result.verified.length} revisión(es) remotas de "${projectId}"`);
        for (const failure of result.failures) {
          ctx.out(`  failure ${failure.code}: ${failure.message}`);
        }
      }
      throw new CommandFailure(`sync verify de "${projectId}" reportó ${result.failures.length} failure(s).`, STUDIO_EXIT_OPERATIONAL, {
        reported: true,
      });
    }
    if (jsonMode(ctx)) {
      ctx.out(JSON.stringify({ schemaVersion: 1, ok: true, data: result }, null, 2));
    } else {
      ctx.out(`verificadas ${result.verified.length} revisión(es) remotas de "${projectId}"`);
    }
    return { exitCode: STUDIO_EXIT_OK };
  },
};

// ---------------------------------------------------------------------------
// sync recover
// ---------------------------------------------------------------------------

export const syncRecoverSpec: CommandSpec = {
  verb: 'sync-recover',
  summary: 'sync recover --project <id> --out <empty-dir> [--checkpoint <id> | --revisions <asset@rev,csv>] — reconstruye SOLO desde el remoto.',
  args: [
    PROJECT_ARG,
    { name: 'out', kind: 'string', required: true, description: 'Directorio destino VACÍO (nunca sobrescribe).' },
    { name: 'checkpoint', kind: 'string', required: false, description: 'Selector activo: checkpointId explícito.' },
    { name: 'revisions', kind: 'string', required: false, description: 'Selector activo: <assetId>@<revisionId> separadas por coma.' },
    WORKSPACE_ARG,
    JSON_ARG,
  ],
  supportsPlan: true,
  writes: ['<out>/**'],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    assertSingleSelector(ctx);
    const projectId = requireString(ctx, 'project');
    const outDir = resolve(ctx.cwd, requireString(ctx, 'out'));
    const selector =
      typeof ctx.args.checkpoint === 'string' && ctx.args.checkpoint.trim().length > 0
        ? `checkpoint ${ctx.args.checkpoint}`
        : typeof ctx.args.revisions === 'string' && ctx.args.revisions.trim().length > 0
          ? `revisiones ${ctx.args.revisions}`
          : 'cabeza única por asset (parentRevisionId)';
    return [
      { action: `listar manifests remotos de ${projectId} por prefix con cursores hasta el fin (solo lectura)` },
      { action: `validar manifests/paths/hashes antes de escribir; selector activo: ${selector}` },
      { action: `restaurar TODAS las revisiones (manifest bytes exactos + objetos verificados por SHA-256) en ${outDir}`, writes: '<out>/**' },
      { action: 'reconstruir proyecto/clientes/presets/assets desde la metadata embebida (sin registry local) y escribir la metadata activa del selector' },
      { action: 'la recuperación NO regenera ni ejecuta fuentes; restaura bytes sellados' },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    assertSingleSelector(ctx);
    const projectId = requireString(ctx, 'project');
    const outDir = resolve(ctx.cwd, requireString(ctx, 'out'));
    const checkpoint = typeof ctx.args.checkpoint === 'string' && ctx.args.checkpoint.trim().length > 0 ? ctx.args.checkpoint : undefined;
    const revisionRefs =
      typeof ctx.args.revisions === 'string' && ctx.args.revisions.trim().length > 0 ? revisionRefsFromCsv(ctx, ctx.args.revisions) : undefined;
    const storage = await loadPrivateStorage(ctx);
    const result = await withStudio(ctx, (studio) =>
      recoverProjectFromStorage(studio, {
        projectId,
        storage,
        outDir,
        ...(checkpoint !== undefined ? { checkpointId: checkpoint } : {}),
        ...(revisionRefs !== undefined ? { revisionRefs } : {}),
      }),
    );
    if (jsonMode(ctx)) {
      ctx.out(JSON.stringify({ schemaVersion: 1, ok: true, data: { outDir: result.outDir, restored: result.restored } }, null, 2));
    } else {
      ctx.out(`recuperadas ${result.restored.length} revisión(es) de "${projectId}" en ${result.outDir} (SHA-256 verificados, sin regenerar)`);
    }
    return { exitCode: STUDIO_EXIT_OK };
  },
};

/** All sync commands, in registry/display order (pairs per contracts.md §6). */
export const studioSyncSpecs: CommandSpec[] = [syncPushSpec, syncVerifySpec, syncRecoverSpec];
