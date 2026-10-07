/**
 * `portalSpecs` — flat `portal-*` commands (P-003, contracts.md §7): the CLI
 * bridge between a local Studio workspace and the remote customer-assets
 * portal. Declared like every other spec; the runtime (`runtime.ts`) is the
 * ONLY dispatcher (no second interpreter here).
 *
 * Conventions:
 * - Envelope: `--json` prints exactly ONE stable document (`studioEnvelopeOk`
 *   / `studioEnvelopeError`); human mode keeps `error: CODE: message`. Exit
 *   codes: 0 ok, 1 operational, 2 input/usage (same table as studio groups).
 * - Mutations (`adopt`, `material-pull`, `delivery-push`, `access-link`)
 *   REQUIRE `--execute`. Without it (and for `--plan`/`--dry-run` via
 *   `plan()`) they print the plan with ZERO network, ZERO filesystem writes
 *   and ZERO credential lookups.
 * - Reads (`auth-status`, `*-list`, `material-show`) execute normally; only
 *   `--plan`/`--dry-run` turns them into pure plans.
 * - Credential: `CUSTOMER_ASSETS_API_KEY` injected env only (never a flag),
 *   resolved lazily inside `run()`; origin must be explicit https (loopback
 *   http only for local fake origins). Redirects never receive credentials
 *   (`redirect: 'error'` in the SDK).
 */
import {
  isStudioServiceError,
  StudioServiceError,
} from '@videomaker/studio';
import { ApiClientError } from '@videomaker/customer-assets/client';
import type { AccessLinkView, AssetUploadLinkView, AssetView, DeliveryView, MaterialView, MeInfo, OutputRef, Page, PortalClientView, UploadRequestLinkView, UploadRequestState, UploadRequestView } from '@videomaker/customer-assets';

import { JSON_ARG } from '../args';
import { CommandFailure, formatPlanSteps } from '../registry';
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
import {
  API_KEY_ENV,
  createPortalClient,
  parsePortalOrigin,
  requireApiKey,
} from '../portal/auth';
import {
  adoptPortalClient,
  pullMaterial,
  pushDelivery,
} from '../portal/bridge';
import {
  closePortalRequest,
  createPortalRequest,
  listPortalRequests,
  mintPortalRequestLink,
  pullRequestMaterials,
} from '../portal/requests';
import { mintPortalAssetLink, pullAssetMaterials, pullLandedTakes } from '../portal/asset-links';
import {
  INGEST_DEFAULT_DIR,
  INGEST_DEFAULT_PORT,
  createIngestServer,
  formatIngestServeBanner,
  probeTcpPort,
  resolveTailscaleIpv4,
} from '../portal/ingest-server';

// ---------------------------------------------------------------------------
// Shared args and small helpers
// ---------------------------------------------------------------------------

const ORIGIN_ARG: CommandArgSpec = {
  name: 'origin',
  kind: 'string',
  required: true,
  description: 'Origen https explícito del portal, sin path ni credenciales (http solo loopback local).',
};

const EXECUTE_ARG: CommandArgSpec = {
  name: 'execute',
  kind: 'boolean',
  required: false,
  default: false,
  description: 'Ejecutar la mutación de verdad; sin este flag SOLO se muestra el plan (sin red ni escritura).',
};

const WORKSPACE_ARG: CommandArgSpec = {
  name: 'workspace',
  kind: 'string',
  required: false,
  description: 'Raíz del workspace studio (default: ./workspace relativa al cwd).',
};

const WORKSPACE_ID_ARG: CommandArgSpec = {
  name: 'workspace-id',
  kind: 'string',
  required: true,
  description: 'Id del workspace portal registrado por el administrador.',
};

const CLIENT_ARG: CommandArgSpec = {
  name: 'client',
  kind: 'string',
  required: true,
  description: 'Id del cliente portal (portalClientId).',
};

/** `--client` opcional: cross-check del puntero resuelto (asset-link mint). */
const OPTIONAL_CLIENT_ARG: CommandArgSpec = {
  name: 'client',
  kind: 'string',
  required: false,
  description: 'Id del cliente portal esperado (cross-check del puntero resuelto; opcional).',
};

const CURSOR_ARG: CommandArgSpec = {
  name: 'cursor',
  kind: 'string',
  required: false,
  description: 'Cursor opaco de la página siguiente.',
};

const LIMIT_ARG: CommandArgSpec = {
  name: 'limit',
  kind: 'number',
  required: false,
  description: 'Tamaño de página (1-100).',
};

const PROJECT_ID_ARG: CommandArgSpec = {
  name: 'project',
  kind: 'string',
  required: true,
  description: 'Id del proyecto studio dueño del asset.',
};

const ASSET_ARG: CommandArgSpec = {
  name: 'asset',
  kind: 'string',
  required: true,
  description: 'Id del asset studio ABIENTO que recibe el input.',
};

const REVISION_ARG: CommandArgSpec = {
  name: 'revision',
  kind: 'string',
  required: true,
  description: 'Id exacto de la revisión sellada a entregar.',
};

const OUTPUTS_ARG: CommandArgSpec = {
  name: 'outputs',
  kind: 'string',
  required: true,
  description: 'Nombres de outputs elegidos del manifest, separados por coma.',
};

const EMAIL_ARG: CommandArgSpec = {
  name: 'email',
  kind: 'string',
  required: true,
  description: 'Email del miembro cliente que recibirá el link de acceso.',
};

const EXPIRES_ARG: CommandArgSpec = {
  name: 'expires-in',
  kind: 'string',
  required: false,
  description: 'Vida del link: <n>m|h|d (ej. 30m, 48h, 7d; mínimo 30m, máximo 30d; default 7d).',
};

const TITLE_ARG: CommandArgSpec = {
  name: 'title',
  kind: 'string',
  required: true,
  description: 'Título display del pedido de material (saneado por el servidor).',
};

const INSTRUCTIONS_ARG: CommandArgSpec = {
  name: 'instructions',
  kind: 'string',
  required: false,
  description: 'Instrucciones display para el invitado (opcional).',
};

const MAX_FILES_ARG: CommandArgSpec = {
  name: 'max-files',
  kind: 'number',
  required: true,
  description: 'Máximo de archivos que acepta el request (1-500; el server lo valida contra la cuota).',
};

const MAX_BYTES_ARG: CommandArgSpec = {
  name: 'max-bytes',
  kind: 'string',
  required: true,
  description: 'Presupuesto de bytes del request: <n>MiB|<n>GiB (ej. 512MiB, 2GiB).',
};

const STATE_ARG: CommandArgSpec = {
  name: 'state',
  kind: 'string',
  required: false,
  description: 'Filtro de estado del request: open|fulfilled|closed|expired.',
};

const PORTAL_PROJECT_ARG: CommandArgSpec = {
  name: 'project',
  kind: 'string',
  required: false,
  description: 'Id del proyecto portal (pointer): los agentes no pueden enumerar pointers (contracts §3), así que el id se pasa explícito.',
};

/** Usage failure when the pointer id is missing (JSON envelope, exit 2). */
function requirePortalProject(ctx: CommandRunContext): string {
  const value = ctx.args.project;
  if (typeof value !== 'string' || value.trim().length === 0) {
    failUsage(ctx, '--project es obligatorio: pasá el id del proyecto portal (pointer); los agentes no pueden listar pointers.');
  }
  return value;
}

const REASON_ARG: CommandArgSpec = {
  name: 'reason',
  kind: 'string',
  required: false,
  description: 'Motivo display del cierre (auditado sin secretos; default: closed_by_admin).',
};

/** `--tailnet`: además del URL https, emitir el URL de ingest por la tailnet. */
const TAILNET_ARG: CommandArgSpec = {
  name: 'tailnet',
  kind: 'boolean',
  required: false,
  default: false,
  description: 'También imprimir tailnetUrl http://<ip tailscale>:<puerto>/subir/<token> (mismo token; resuelve `tailscale ip -4` al mintear).',
};

const INGEST_PORT_ARG: CommandArgSpec = {
  name: 'ingest-port',
  kind: 'number',
  required: false,
  default: INGEST_DEFAULT_PORT,
  description: `Puerto del ingest tailnet (default ${INGEST_DEFAULT_PORT}; falla fuerte si está ocupado).`,
};

const INGEST_DIR_ARG: CommandArgSpec = {
  name: 'ingest-dir',
  kind: 'string',
  required: false,
  default: INGEST_DEFAULT_DIR,
  description: `Directorio landing de tomas del ingest (default ${INGEST_DEFAULT_DIR}; gitignored; NO son materiales del portal).`,
};

const INGEST_TOKEN_ARG: CommandArgSpec = {
  name: 'token',
  kind: 'string',
  required: false,
  description: 'Prefijo del tokenHash (mínimo 8 hex) para importar SOLO las tomas de un link.',
};

/**
 * Gramática/bounds EXACTOS al servidor (REQUEST_MAX_FILES_CAP): entero 1..500.
 * Validación pura local: falla como usage (exit 2) sin red.
 */
export function parseMaxFilesArg(ctx: CommandRunContext): number {
  const value = ctx.args['max-files'];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 500) {
    failUsage(ctx, '--max-files debe ser un entero entre 1 y 500.');
  }
  return value;
}

/**
 * Gramática EXACTA de límites (contracts.md §6 aditivo): `<n>MiB|<n>GiB` →
 * bytes. Validación pura local (la cuota del cliente la valida el servidor).
 */
export function parseMaxBytesArg(ctx: CommandRunContext): number {
  const raw = ctx.args['max-bytes'];
  if (typeof raw !== 'string' || !/^(\d+)(MiB|GiB)$/.test(raw.trim())) {
    failUsage(ctx, '--max-bytes debe tener forma <n>MiB o <n>GiB (ej. 512MiB, 2GiB).');
  }
  const match = /^(\d+)(MiB|GiB)$/.exec(raw.trim())!;
  const amount = Number.parseInt(match[1]!, 10);
  const bytes = amount * (match[2] === 'MiB' ? 1_048_576 : 1_073_741_824);
  if (amount <= 0 || bytes <= 0) {
    failUsage(ctx, '--max-bytes debe ser un presupuesto positivo (ej. 512MiB, 2GiB).');
  }
  return bytes;
}

/** Valida el filtro --state localmente (usage exit 2 si no es del dominio). */
function optionalStateArg(ctx: CommandRunContext): UploadRequestState | undefined {
  const raw = ctx.args.state;
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !['open', 'fulfilled', 'closed', 'expired'].includes(raw)) {
    failUsage(ctx, '--state debe ser open, fulfilled, closed o expired.');
  }
  return raw as UploadRequestState;
}

/**
 * Grammar/bounds EXACTOS al servidor (parseExpiresIn en access.ts): el mismo
 * `<n>m|h|d`, 30m..30d. Validación pura local: falla como usage (exit 2) sin
 * red, igual que cualquier otro argumento inválido.
 */
export function parseExpiresInArg(ctx: CommandRunContext): string | undefined {
  const raw = ctx.args['expires-in'];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^(\d+)(m|h|d)$/.test(raw.trim())) {
    failUsage(ctx, '--expires-in debe tener forma <n>m, <n>h o <n>d (ej. 30m, 48h, 7d).');
  }
  const match = /^(\d+)(m|h|d)$/.exec(raw.trim())!;
  const amount = Number.parseInt(match[1]!, 10);
  const seconds = amount * (match[2] === 'm' ? 60 : match[2] === 'h' ? 3_600 : 86_400);
  const MIN = 30 * 60;
  const MAX = 30 * 24 * 3_600;
  if (amount <= 0 || seconds < MIN || seconds > MAX) {
    failUsage(ctx, '--expires-in debe estar entre 30 minutos y 30 días (ej. 30m, 48h, 7d).');
  }
  return raw.trim();
}

/** The positional `<id>` fills the first declared arg, so it goes first. */
function idArg(description: string): CommandArgSpec {
  return { name: 'id', kind: 'string', required: true, description };
}

function jsonMode(ctx: CommandRunContext): boolean {
  return ctx.args.json === true;
}

function requireString(ctx: CommandRunContext, name: string): string {
  const value = ctx.args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    failUsage(ctx, `--${name} es obligatorio y no puede estar vacío.`);
  }
  return value;
}

function workspaceDirOf(ctx: CommandRunContext): string {
  const value = ctx.args.workspace;
  const raw = typeof value === 'string' && value.trim().length > 0 ? value : 'workspace';
  return raw;
}

/** `--ingest-dir` (default `.tmp/portal-ingest`, relativo al cwd del serve). */
function ingestDirOf(ctx: CommandRunContext): string {
  const value = ctx.args['ingest-dir'];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : INGEST_DEFAULT_DIR;
}

/** `--ingest-port` validado (1..65535); default 8787. Usage exit 2 si no. */
function ingestPortOf(ctx: CommandRunContext): number {
  const value = ctx.args['ingest-port'] ?? INGEST_DEFAULT_PORT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    failUsage(ctx, '--ingest-port debe ser un entero entre 1 y 65535.');
  }
  return value;
}

/** `--token` opcional (prefijo del tokenHash); vacío/ausente = sin filtro. */
function optionalTokenPrefix(ctx: CommandRunContext): string | undefined {
  const value = ctx.args.token;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value.trim();
}

/**
 * Resolves the tailnet ingest URL for a minted link: `tailscale ip -4` at
 * mint time + a best-effort TCP probe of the ingest port (a warn, never a
 * failure — the server may live in another tmux pane or start later).
 */
async function tailnetUrlForMint(url: string, port: number): Promise<{ tailnetUrl: string; probe: 'listening' | 'not-listening' }> {
  const token = url.split('/asset-upload/')[1] ?? '';
  if (token.length === 0) {
    throw new StudioServiceError('INVALID_INPUT', 'El URL minteado no contiene el token esperado; no se compone tailnetUrl.', {});
  }
  const host = await resolveTailscaleIpv4();
  const listening = await probeTcpPort(host, port);
  return { tailnetUrl: `http://${host}:${port}/subir/${token}`, probe: listening ? 'listening' : 'not-listening' };
}

/** Validates the explicit origin (pure); usage failure keeps exit 2. */
function originOf(ctx: CommandRunContext): string {
  try {
    return parsePortalOrigin(ctx.args.origin);
  } catch (error) {
    if (isStudioServiceError(error)) {
      failUsage(ctx, error.message);
    }
    throw error;
  }
}

function optionalLimit(ctx: CommandRunContext): number | undefined {
  const value = ctx.args.limit;
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    failUsage(ctx, '--limit debe ser un entero entre 1 y 100.');
  }
  return value;
}

/** Usage failure (exit 2): JSON envelope only, or actionable human error. */
function failUsage(ctx: CommandRunContext, message: string): never {
  if (jsonMode(ctx)) {
    ctx.out(studioEnvelopeError({ code: 'INVALID_INPUT', message }));
    throw new CommandFailure(message, STUDIO_EXIT_USAGE, { reported: true });
  }
  return ctx.fail(message, STUDIO_EXIT_USAGE);
}

/** Typed local failure (studio codes keep their exit table). */
function failLocal(ctx: CommandRunContext, error: StudioServiceError): never {
  const exitCode = studioExitCodeForError(error.code);
  if (jsonMode(ctx)) {
    ctx.out(studioEnvelopeError({ code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) }));
    throw new CommandFailure(error.message, exitCode, { reported: true });
  }
  return ctx.fail(`${error.code}: ${error.message}`, exitCode);
}

/** Remote failure: stable envelope with the server's code + requestId. */
function failApi(ctx: CommandRunContext, error: ApiClientError): never {
  const code = error.code.toUpperCase();
  const exitCode = studioExitCodeForError(code);
  if (jsonMode(ctx)) {
    ctx.out(studioEnvelopeError({ code, message: error.message, details: { status: error.status, requestId: error.requestId } }));
    throw new CommandFailure(error.message, exitCode, { reported: true });
  }
  return ctx.fail(`PORTAL ${error.message}`, exitCode);
}

/**
 * Runs a real operation and prints exactly one result: the `--json` envelope
 * or the human rendering. Every typed failure maps to the stable envelope
 * with the right exit code; unexpected failures never leak credentials
 * (messages cannot contain the key: it is never interpolated anywhere).
 */
async function executePortal(
  ctx: CommandRunContext,
  verb: string,
  task: () => Promise<unknown>,
  render: (data: unknown) => void,
): Promise<CommandResult> {
  try {
    const data = await task();
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeOk(data));
    } else {
      render(data);
    }
    return { exitCode: STUDIO_EXIT_OK };
  } catch (error) {
    if (error instanceof ApiClientError) return failApi(ctx, error) as never;
    if (isStudioServiceError(error)) return failLocal(ctx, error) as never;
    if (error instanceof CommandFailure) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (jsonMode(ctx)) {
      ctx.out(studioEnvelopeError({ code: 'INTERNAL', message }));
      throw new CommandFailure(message, 1, { reported: true });
    }
    return ctx.fail(message, 1);
  }
}

/**
 * Fast credential gate for REAL execution (run mode only): fails
 * AUTH_REQUIRED before any doomed request. Plan mode never calls this.
 */
function requireCredential(): void {
  requireApiKey();
}

/**
 * Plan-only result for mutations invoked WITHOUT `--execute` (contracts.md
 * §7): prints the plan and exits 0 without network, writes or credentials.
 */
function planOnlyResult(ctx: CommandRunContext, verb: string, steps: readonly PlanStep[]): CommandResult {
  if (jsonMode(ctx)) {
    ctx.out(studioEnvelopeOk({ executed: false, plan: steps, hint: `Repetí ${verb} con --execute para ejecutarlo.` }));
  } else {
    ctx.out(`(sin --execute: solo plan; sin red, sin escritura, sin credenciales)`);
    ctx.out(formatPlanSteps(verb, steps));
  }
  return { exitCode: STUDIO_EXIT_OK };
}

function requireMutationExecute(ctx: CommandRunContext, verb: string, steps: readonly PlanStep[]): true {
  if (ctx.args.execute !== true) {
    planOnlyResult(ctx, verb, steps);
    throw new CommandFailure('mutation sin --execute: solo plan', STUDIO_EXIT_OK, { reported: true });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Pure plans (no network, no writes, no credential access — NFR-002)
// ---------------------------------------------------------------------------

function planAuthStatus(ctx: CommandRunContext): PlanStep[] {
  return [{ action: 'GET /api/v1/me — principal y scopes del agente (sin token)', target: originOf(ctx) }];
}

function planClientList(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const cursor = ctx.args.cursor;
  const query = typeof cursor === 'string' && cursor.length > 0 ? `?cursor=${cursor}` : '';
  return [{ action: `GET /api/v1/clients${query} — clientes adoptados en este workspace`, target: origin }];
}

function planMaterialList(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const clientId = requireString(ctx, 'client');
  const params = new URLSearchParams();
  if (typeof ctx.args.cursor === 'string' && ctx.args.cursor.length > 0) params.set('cursor', ctx.args.cursor);
  const limit = optionalLimit(ctx);
  if (limit !== undefined) params.set('limit', String(limit));
  const query = params.size > 0 ? `?${params.toString()}` : '';
  return [{ action: `GET /api/v1/clients/${clientId}/materials${query} — materiales ready del cliente`, target: origin }];
}

function planMaterialShow(ctx: CommandRunContext): PlanStep[] {
  const materialId = requireString(ctx, 'id');
  return [{ action: `GET /api/v1/materials/${materialId} — metadata del material (sin bytes)`, target: originOf(ctx) }];
}

function planAssetList(ctx: CommandRunContext): PlanStep[] {
  const clientId = requireString(ctx, 'client');
  return [{ action: `GET /api/v1/clients/${clientId}/assets — assets entregados al cliente`, target: originOf(ctx) }];
}

function planAdopt(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const studioClientId = requireString(ctx, 'id');
  const workspaceId = requireString(ctx, 'workspace-id');
  return [
    { action: `leer client.json local de ${studioClientId} en el workspace (solo id + nombre display)`, target: workspaceDirOf(ctx) },
    { action: `POST /api/v1/clients/adopt — proyectar el cliente con idempotencia estable (workspace ${workspaceId})`, target: origin },
  ];
}

function planMaterialPull(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const materialId = requireString(ctx, 'id');
  const projectId = requireString(ctx, 'project');
  const assetId = requireString(ctx, 'asset');
  const assetPrefix = `projects/${projectId}/assets/${assetId}`;
  return [
    { action: `GET /api/v1/materials/${materialId} — metadata registrada (hash/bytes/tipo)`, target: origin },
    { action: `GET /api/v1/materials/${materialId}/content — descarga a temporal confinado bajo <workspace>/.vm/tmp`, target: '<workspace>/.vm/tmp' },
    { action: 'verificar sha256 + bytes + firma (magic) contra el registro del material' },
    { action: `copiar con creación exclusiva a ${assetPrefix}/inputs/portal/<materialId>-<sha8><ext> (nunca sobrescribe un input distinto)`, writes: `${assetPrefix}/inputs/portal/` },
    { action: `escribir sidecar de provenance determinista ${assetPrefix}/inputs/portal/<…>.provenance.json (sin credenciales)`, writes: `${assetPrefix}/inputs/portal/` },
    { action: `actualizar ${assetPrefix}/asset.json (inputs) con lock de asset, validación de schema y rename atómico`, writes: `${assetPrefix}/asset.json` },
    { action: 'borrar el temporal confinado' },
  ];
}

function planDeliveryPush(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const projectId = requireString(ctx, 'project');
  const assetId = requireString(ctx, 'asset');
  const revisionId = requireString(ctx, 'revision');
  const outputsRaw = requireString(ctx, 'outputs');
  return [
    { action: `leer el manifest sellado revisions/${projectId}/${assetId}/${revisionId}/manifest.json (solo lectura)`, target: `revisions/${projectId}/${assetId}/${revisionId}/manifest.json` },
    { action: 'recalcular rootHash con el módulo puro y compararlo con el manifest' },
    { action: `verificar sha256/bytes locales de SOLO los outputs elegidos: ${outputsRaw}` },
    { action: `POST /api/v1/clients/<client>/deliveries — crear la entrega con idempotencia estable`, target: origin },
    { action: `stage+PUT de los outputs elegidos (uploads con idempotencia; bytes verificados por el servidor)`, target: origin },
    { action: 'POST /api/v1/deliveries/<id>/complete — ready cuando todos los outputs estén verificados', target: origin },
    { action: 'NUNCA viajan: sources, recipe, manifests, snapshots, .env ni nada no elegido' },
  ];
}

function planAccessLink(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const clientId = requireString(ctx, 'client');
  const email = requireString(ctx, 'email');
  const expiresIn = parseExpiresInArg(ctx) ?? '7d (default)';
  return [
    { action: `POST /api/v1/clients/${clientId}/access-links — mint de un link de login single-use para ${email} (vence en ${expiresIn}; sin email: el link se captura y se devuelve para entregarlo vos)`, target: origin },
    { action: 'entregar el link por tu canal (WhatsApp, etc.): vence en la fecha elegida y sirve UNA sola vez; nunca publicarlo ni loguearlo' },
  ];
}

function planRequestCreate(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const projectId = requirePortalProject(ctx);
  const title = requireString(ctx, 'title');
  const maxFiles = parseMaxFilesArg(ctx);
  const maxBytes = parseMaxBytesArg(ctx);
  const expiresIn = parseExpiresInArg(ctx) ?? '7d (default)';
  return [
    { action: `POST /api/v1/projects/${projectId}/requests — crear el pedido "${title}" (max ${maxFiles} archivos / ${maxBytes} bytes, vence en ${expiresIn})`, target: origin },
    { action: 'POST /api/v1/requests/<id>/link — mint del enlace de invitado (vence con el request); el URL viaja UNA sola vez en la respuesta', target: origin },
    { action: 'entregar el URL por tu canal (0 emails); nunca publicarlo ni loguearlo' },
  ];
}

function planRequestList(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const projectId = requirePortalProject(ctx);
  const state = optionalStateArg(ctx);
  return [
    { action: `GET /api/v1/projects/${projectId}/requests${state !== undefined ? ` (filtro state=${state})` : ''} — pedidos de material del pointer`, target: origin },
  ];
}

function planRequestClose(ctx: CommandRunContext): PlanStep[] {
  const requestId = requireString(ctx, 'id');
  return [
    { action: `POST /api/v1/requests/${requestId}/close — cerrar el pedido (409 si ya cerró/venció; nada se borra)`, target: originOf(ctx) },
  ];
}

function planRequestLink(ctx: CommandRunContext): PlanStep[] {
  const requestId = requireString(ctx, 'id');
  const expiresIn = parseExpiresInArg(ctx) ?? '7d (default)';
  return [
    { action: `POST /api/v1/requests/${requestId}/link — mint/rotación del enlace de invitado (vence en ${expiresIn}; el token ANTERIOR queda revocado)`, target: originOf(ctx) },
    { action: 'entregar el URL por tu canal (0 emails); el URL viaja UNA sola vez en la respuesta; nunca publicarlo ni loguearlo' },
  ];
}

function planRequestPull(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const requestId = requireString(ctx, 'id');
  const projectId = requireString(ctx, 'project');
  const assetId = requireString(ctx, 'asset');
  const assetPrefix = `projects/${projectId}/assets/${assetId}`;
  return [
    { action: `GET /api/v1/requests/${requestId} — estado y cliente del pedido`, target: origin },
    { action: `leer el proyecto studio local ${projectId} + inspeccionar el asset ${assetId} (si falta: error claro, NUNCA se inventa destino)`, target: workspaceDirOf(ctx) },
    { action: `GET /api/v1/requests/${requestId}/materials — metadata de TODOS los materiales ready del pedido`, target: origin },
    { action: `por material: descarga a temporal confinado bajo <workspace>/.vm/tmp + verificación sha256/bytes/firma (relación cliente-proyecto validada)`, target: '<workspace>/.vm/tmp' },
    { action: `copiar con creación exclusiva a ${assetPrefix}/inputs/portal/<materialId>-<sha8><ext> (nunca sobrescribe un input distinto)`, writes: `${assetPrefix}/inputs/portal/` },
    { action: `sidecar de provenance determinista (origin, materialId, requestId) en ${assetPrefix}/inputs/portal/<…>.provenance.json`, writes: `${assetPrefix}/inputs/portal/` },
    { action: `actualizar ${assetPrefix}/asset.json (inputs) con lock de asset, validación de schema y rename atómico`, writes: `${assetPrefix}/asset.json` },
    { action: 'borrar el temporal confinado; idempotente por (origin, materialId): reintentar no duplica' },
  ];
}

/**
 * Plans `portal-asset-upload-link` (operator order 2026-10-06). Grammar
 * (ids, --expires-in) is validated LOCALLY by the spec layer before this
 * plan runs: an invalid value never reaches the network (usage exit 2).
 */
function planAssetLinkMint(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const projectId = requireString(ctx, 'project');
  const assetId = requireString(ctx, 'asset');
  const expiresIn = parseExpiresInArg(ctx) ?? '7d (default)';
  const clientNote = typeof ctx.args.client === 'string' && ctx.args.client.length > 0 ? ` (cross-check --client ${ctx.args.client})` : '';
  const steps: PlanStep[] = [
    { action: `leer el proyecto studio local ${projectId} + inspeccionar el asset ${assetId} en el workspace (si falta: error claro, sin red)`, target: workspaceDirOf(ctx) },
    { action: `POST /api/v1/asset-upload-links — mint del link de subida para ESE asset exacto (scope assets:write; vence en ${expiresIn}; rota el link anterior)${clientNote}`, target: origin },
    { action: 'entregar el URL por tu canal (0 emails): abre en el celular SIN login y sube atribuido a ese asset; el URL viaja UNA sola vez en la respuesta; nunca publicarlo ni loguearlo' },
  ];
  if (ctx.args.tailnet === true) {
    const port = typeof ctx.args['ingest-port'] === 'number' ? ctx.args['ingest-port'] : INGEST_DEFAULT_PORT;
    steps.push({ action: `--tailnet: resolver \`tailscale ip -4\` y componer tailnetUrl http://<ip>:${port}/subir/<token> (mismo token; advertencia si el puerto no está escuchando; NUNCA 0.0.0.0)`, target: `http://<tailscale-ip>:${port}` });
    steps.push({ action: `el invitado grande sube por la tailnet al ingest local (chunks 32MiB, tope 5GiB); el portal sigue siendo la única fuente de validez del token` });
  }
  return steps;
}

/** Plans `portal-ingest-serve` (§10): the foreground tailnet ingest server. */
function planIngestServe(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const port = ingestPortOf(ctx);
  const dir = ingestDirOf(ctx);
  return [
    { action: 'resolver la IPv4 de tailscale local (`tailscale ip -4`) y bindear SOLO ahí (jamás 0.0.0.0/::; sin login: red cerrada + token)', target: `http://<tailscale-ip>:${port}` },
    { action: `validar CADA request contra GET /api/v1/a/:token de la vista mínima del portal (200 + open; cache ~60s; expirado/cerrado/unknown NUNCA aceptan bytes)`, target: origin },
    { action: `GET/PUT /subir/:token — chunks 32MiB reanudables por offset (409 si adelantás), tope 5GiB por toma; staging por tokenHash`, target: `<cwd>/${dir}` },
    { action: `POST /subir/:token/complete — sha256 stream + ftyp + manifest {tokenHash, binding del portal, sha256, bytes, receivedAt} + rename atómico a ${dir}/<tokenHash>/`, writes: `${dir}/*` },
    { action: 'recordatorio ACL tailnet: el invitado necesita alcance a este puerto por la ACL de tailscale; los archivos landed NO son materiales del portal (entran a Studio con portal-asset-ingest-pull)' },
  ];
}

/** Plans `portal-asset-ingest-pull` (§10): local import of landed takes. */
function planIngestPull(ctx: CommandRunContext): PlanStep[] {
  const projectId = requireString(ctx, 'project');
  const assetId = requireString(ctx, 'asset');
  const dir = ingestDirOf(ctx);
  const tokenPrefix = optionalTokenPrefix(ctx);
  const assetPrefix = `projects/${projectId}/assets/${assetId}`;
  return [
    { action: `escanear ${dir}/<tokenHash>/take-*.manifest.json (SIN red NI credencial; filtro tokenHash: ${tokenPrefix ?? 'ninguno'})`, target: dir },
    { action: `leer el proyecto studio local ${projectId} + inspeccionar el asset ${assetId} ABIERTO (si falta: error claro, NUNCA se inventa destino)`, target: workspaceDirOf(ctx) },
    { action: 'por toma: leer bytes landed y RE-VERIFICAR sha256/bytes/firma mp4 contra el manifest (un manifest inválido es error fuerte, nunca se importa a ciegas)' },
    { action: `copiar con creación exclusiva a ${assetPrefix}/inputs/portal/take-<sha8>.mp4 + sidecar provenance (source tailnet-ingest, tailnet:true, tokenHash)`, writes: `${assetPrefix}/inputs/portal/` },
    { action: `actualizar ${assetPrefix}/asset.json (inputs) con lock de asset, validación de schema y rename atómico`, writes: `${assetPrefix}/asset.json` },
    { action: 'recién después de la importación verificada borrar la toma del landing; re-pull con landing vacío = éxito sin duplicados (idempotente)' },
  ];
}

/** Plans `portal-asset-pull` (operator order 2026-10-06). */
function planAssetPull(ctx: CommandRunContext): PlanStep[] {
  const origin = originOf(ctx);
  const projectId = requireString(ctx, 'project');
  const assetId = requireString(ctx, 'asset');
  const assetPrefix = `projects/${projectId}/assets/${assetId}`;
  return [
    { action: `GET /api/v1/asset-upload-links/materials?asset=${assetId} — metadata de TODOS los materiales ready con asset_target en ese asset`, target: origin },
    { action: `leer el proyecto studio local ${projectId} + inspeccionar el asset ${assetId} (si falta: error claro, NUNCA se inventa destino)`, target: workspaceDirOf(ctx) },
    { action: `por material: descarga a temporal confinado bajo <workspace>/.vm/tmp + verificación sha256/bytes/firma (relación cliente-proyecto validada)`, target: '<workspace>/.vm/tmp' },
    { action: `copiar con creación exclusiva a ${assetPrefix}/inputs/portal/<materialId>-<sha8><ext> (nunca sobrescribe un input distinto)`, writes: `${assetPrefix}/inputs/portal/` },
    { action: `sidecar de provenance determinista (origin, materialId, linkId) en ${assetPrefix}/inputs/portal/<…>.provenance.json`, writes: `${assetPrefix}/inputs/portal/` },
    { action: `actualizar ${assetPrefix}/asset.json (inputs) con lock de asset, validación de schema y rename atómico`, writes: `${assetPrefix}/asset.json` },
    { action: 'borrar el temporal confinado; idempotente por (origin, materialId): reintentar no duplica' },
  ];
}

// ---------------------------------------------------------------------------
// Data extraction for envelopes / human renderings
// ---------------------------------------------------------------------------

interface AdoptData {
  executed: true;
  workspaceId: string;
  studioClientId: string;
  name: string;
  portalClient: PortalClientView;
}

interface PullData {
  executed: true;
  material: { id: string; name?: string; mediaType: string; bytes: number; sha256: string };
  portalClient: { id: string; studioClientId: string };
  inputPath: string;
  provenancePath: string;
  addedInputs: string[];
  reusedBytes: boolean;
}

interface PushData {
  executed: true;
  delivery: DeliveryView;
  outputs: OutputRef[];
  rootHash: string;
  revisionId: string;
}

interface AccessLinkData {
  executed: true;
  url: string;
  email: string;
  expiresAt: number;
  singleUse: true;
}

interface RequestCreateData {
  executed: true;
  requestId: string;
  url: string;
  expiresAt: number;
  limits: { maxFiles: number; maxBytes: number };
  request: UploadRequestView;
  project: { id: string; portalClientId: string };
}

interface RequestLinkData {
  executed: true;
  url: string;
  requestId: string;
  expiresAt: number;
  limits: { maxFiles: number; maxBytes: number };
}

/** Envelope of `portal-request-list` (one pointer's requests). */
interface RequestListData {
  items: Array<{ request: UploadRequestView; portalProjectId: string; portalClientId: string }>;
  nextCursor: string | null;
}

interface RequestCloseData {
  executed: true;
  request: UploadRequestView;
}

interface RequestPullData {
  executed: true;
  requestId: string;
  state: UploadRequestState;
  portalProject: { id: string; studioProjectId: string };
  assetId: string;
  imported: Array<{
    id: string;
    name?: string;
    mediaType: string;
    bytes: number;
    sha256: string;
    inputPath: string;
    provenancePath: string;
    addedInputs: string[];
    reusedBytes: boolean;
  }>;
  addedInputs: string[];
}

/** Envelope of `portal-asset-upload-link` (URL de entrega manual, una vez). */
interface AssetLinkMintData {
  executed: true;
  url: string;
  linkId: string;
  portalClientId: string;
  portalProjectId: string | null;
  studioProjectId: string;
  studioAssetId: string;
  expiresAt: number;
  /** §10: present only with --tailnet (mismo token, ingest tailnet local). */
  tailnetUrl?: string;
  ingestPort?: number;
  tailnetProbe?: 'listening' | 'not-listening';
}

/** Envelope of `portal-asset-pull` (per-asset import set). */
interface AssetPullData {
  executed: true;
  studioProjectId: string;
  studioAssetId: string;
  imported: Array<{
    id: string;
    name?: string;
    mediaType: string;
    bytes: number;
    sha256: string;
    inputPath: string;
    provenancePath: string;
    addedInputs: string[];
    reusedBytes: boolean;
    linkId: string | null;
  }>;
  addedInputs: string[];
}

/** Envelope of `portal-asset-ingest-pull` (§10, local landing → Studio). */
interface IngestPullData {
  executed: true;
  studioProjectId: string;
  studioAssetId: string;
  ingestDir: string;
  imported: Array<{
    takeId: string;
    tokenHash: string;
    sha256: string;
    bytes: number;
    ingestOrigin: string;
    inputPath: string;
    provenancePath: string;
    addedInputs: string[];
    reusedBytes: boolean;
    removedFromLanding: boolean;
  }>;
  addedInputs: string[];
}

function renderMaterialLine(material: MaterialView): string {
  const name = material.name !== undefined && material.name.length > 0 ? ` ${material.name}` : '';
  return `  ${material.id}${name} — ${material.mediaType}, ${material.bytes}B, sha256:${material.sha256.slice(0, 12)}…`;
}

function renderPage<T extends { id: string }>(label: string, page: Page<T>, render: (item: T) => string): string[] {
  const lines = [`${label}: ${page.items.length} ítem(s); nextCursor: ${page.nextCursor ?? '(fin)'}`];
  for (const item of page.items) lines.push(render(item));
  return lines;
}

// ---------------------------------------------------------------------------
// The specs
// ---------------------------------------------------------------------------

export const portalSpecs: CommandSpec[] = [
  {
    verb: 'portal-auth-status',
    summary: 'Portal: principal y scopes del agente (sin eco del token).',
    args: [ORIGIN_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planAuthStatus,
    run(ctx) {
      return executePortal(
        ctx,
        'portal-auth-status',
        async () => {
          requireCredential();
          const client = createPortalClient(originOf(ctx));
          const me: MeInfo = await client.me();
          return { principal: me.me, origin: originOf(ctx), credential: { env: API_KEY_ENV } };
        },
        (data) => {
          const record = data as { principal: MeInfo['me']; origin: string };
          ctx.out(`principal: ${record.principal.kind} ${record.principal.userId}`);
          ctx.out(`scopes: ${record.principal.scopes?.length ? record.principal.scopes.join(', ') : '(ninguno)'}`);
          ctx.out(`origin: ${record.origin}`);
        },
      );
    },
  },
  {
    verb: 'portal-client-adopt',
    summary: 'Portal: adoptar un cliente studio existente en un workspace portal (integrador).',
    args: [idArg('Id del cliente studio local (posicional).'), WORKSPACE_ID_ARG, WORKSPACE_ARG, ORIGIN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planAdopt,
    run(ctx) {
      const verb = 'portal-client-adopt';
      const steps = planAdopt(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          requireCredential();
          const result = await adoptPortalClient({
            origin: originOf(ctx),
            workspaceDir: workspaceDirOf(ctx),
            workspaceId: requireString(ctx, 'workspace-id'),
            studioClientId: requireString(ctx, 'id'),
          });
          return {
            executed: true as const,
            workspaceId: result.workspaceId,
            studioClientId: result.studioClientId,
            name: result.name,
            portalClient: result.portalClient,
          };
        },
        (data) => {
          const record = data as AdoptData;
          ctx.out(`portal client ${record.portalClient.id} ← studio client ${record.studioClientId} (workspace ${record.workspaceId})`);
          ctx.out(`nombre display: ${record.name}; proyección v${record.portalClient.projectionVersion}`);
        },
      );
    },
  },
  {
    verb: 'portal-client-list',
    summary: 'Portal: listar clientes adoptados visibles para el principal.',
    args: [ORIGIN_ARG, CURSOR_ARG, LIMIT_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planClientList,
    run(ctx) {
      return executePortal(
        ctx,
        'portal-client-list',
        async () => {
          requireCredential();
          const client = createPortalClient(originOf(ctx));
          return client.listClients({
            cursor: typeof ctx.args.cursor === 'string' && ctx.args.cursor.length > 0 ? ctx.args.cursor : undefined,
            limit: optionalLimit(ctx),
          });
        },
        (data) => {
          for (const line of renderPage<PortalClientView>('portal clients', data as Page<PortalClientView>, (item) => `  ${item.id} ← studio ${item.studioClientId} "${item.name}" (workspace ${item.workspaceId}, v${item.projectionVersion})`)) {
            ctx.out(line);
          }
        },
      );
    },
  },
  {
    verb: 'portal-material-list',
    summary: 'Portal: listar materiales ready de un cliente (paginado).',
    args: [CLIENT_ARG, ORIGIN_ARG, CURSOR_ARG, LIMIT_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planMaterialList,
    run(ctx) {
      return executePortal(
        ctx,
        'portal-material-list',
        async () => {
          requireCredential();
          const client = createPortalClient(originOf(ctx));
          return client.listMaterials(requireString(ctx, 'client'), {
            cursor: typeof ctx.args.cursor === 'string' && ctx.args.cursor.length > 0 ? ctx.args.cursor : undefined,
            limit: optionalLimit(ctx),
          });
        },
        (data) => {
          for (const line of renderPage<MaterialView>('materiales', data as Page<MaterialView>, renderMaterialLine)) {
            ctx.out(line);
          }
        },
      );
    },
  },
  {
    verb: 'portal-material-show',
    summary: 'Portal: metadata de un material (sin bytes).',
    args: [idArg('Id del material (posicional).'), ORIGIN_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planMaterialShow,
    run(ctx) {
      return executePortal(
        ctx,
        'portal-material-show',
        async () => {
          requireCredential();
          const client = createPortalClient(originOf(ctx));
          return client.getMaterial(requireString(ctx, 'id'));
        },
        (data) => {
          const material = data as MaterialView; // task output: MaterialView
          ctx.out(`material ${renderMaterialLine(material).trim()}`);
          ctx.out(`  creado: ${new Date(material.createdAt).toISOString()}`);
        },
      );
    },
  },
  {
    verb: 'portal-material-pull',
    summary: 'Portal: importar un material como INPUT de un asset abierto (verificado, idempotente).',
    args: [idArg('Id del material portal (posicional).'), PROJECT_ID_ARG, ASSET_ARG, WORKSPACE_ARG, ORIGIN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: ['projects/<project>/assets/<asset>/inputs/portal/*', 'projects/<project>/assets/<asset>/asset.json'],
    movesGates: [],
    plan: planMaterialPull,
    run(ctx) {
      const verb = 'portal-material-pull';
      const steps = planMaterialPull(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          requireCredential();
          const result = await pullMaterial({
            origin: originOf(ctx),
            workspaceDir: workspaceDirOf(ctx),
            projectId: requireString(ctx, 'project'),
            assetId: requireString(ctx, 'asset'),
            materialId: requireString(ctx, 'id'),
          });
          return {
            executed: true as const,
            material: result.material,
            portalClient: result.portalClient,
            inputPath: result.inputPath,
            provenancePath: result.provenancePath,
            addedInputs: result.addedInputs,
            reusedBytes: result.reusedBytes,
          };
        },
        (data) => {
          const record = data as PullData;
          ctx.out(`material ${record.material.id} (${record.material.mediaType}, ${record.material.bytes}B, sha256:${record.material.sha256.slice(0, 12)}…)`);
          ctx.out(`input: ${record.inputPath}`);
          ctx.out(`provenance: ${record.provenancePath}`);
          ctx.out(`asset.json inputs añadidos: ${record.addedInputs.length > 0 ? record.addedInputs.join(', ') : '(ninguno — relación ya presente)'}`);
        },
      );
    },
  },
  {
    verb: 'portal-delivery-push',
    summary: 'Portal: entregar outputs ELEGIDOS de una revisión sellada (exacto e idempotente).',
    args: [WORKSPACE_ARG, CLIENT_ARG, PROJECT_ID_ARG, ASSET_ARG, REVISION_ARG, OUTPUTS_ARG, ORIGIN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planDeliveryPush,
    run(ctx) {
      const verb = 'portal-delivery-push';
      const steps = planDeliveryPush(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          requireCredential();
          const outputsRaw = requireString(ctx, 'outputs');
          const result = await pushDelivery({
            origin: originOf(ctx),
            workspaceDir: workspaceDirOf(ctx),
            portalClientId: requireString(ctx, 'client'),
            projectId: requireString(ctx, 'project'),
            assetId: requireString(ctx, 'asset'),
            revisionId: requireString(ctx, 'revision'),
            outputNames: outputsRaw.split(','),
          });
          return {
            executed: true as const,
            delivery: result.delivery,
            outputs: result.outputs,
            rootHash: result.rootHash,
            revisionId: result.revisionId,
          };
        },
        (data) => {
          const record = data as PushData;
          ctx.out(`delivery ${record.delivery.id} — estado ${record.delivery.status}`);
          ctx.out(`revisión ${record.revisionId} rootHash:${record.rootHash.slice(0, 12)}…`);
          for (const output of record.outputs) {
            ctx.out(`  output ${output.name} — ${output.mediaType}, ${output.bytes}B, sha256:${output.sha256.slice(0, 12)}…`);
          }
        },
      );
    },
  },
  {
    verb: 'portal-access-link',
    summary: 'Portal: mintear un link de login single-use con vencimiento para un miembro cliente (admin/integrador).',
    args: [CLIENT_ARG, EMAIL_ARG, EXPIRES_ARG, ORIGIN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planAccessLink,
    run(ctx) {
      const verb = 'portal-access-link';
      const steps = planAccessLink(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          requireCredential();
          const client = createPortalClient(originOf(ctx));
          const link: AccessLinkView = await client.mintAccessLink(requireString(ctx, 'client'), {
            email: requireString(ctx, 'email'),
            expiresIn: parseExpiresInArg(ctx),
            origin: originOf(ctx),
          });
          return {
            executed: true as const,
            url: link.url,
            email: link.email,
            expiresAt: link.expiresAt,
            singleUse: link.singleUse,
          };
        },
        (data) => {
          const record = data as AccessLinkData;
          ctx.out(`link para ${record.email} (vence: ${new Date(record.expiresAt).toISOString()}, un solo uso)`);
          ctx.out(record.url);
          ctx.out('entregalo por tu canal; el token nunca viaja por email del portal ni queda logueado.');
        },
      );
    },
  },
  {
    verb: 'portal-asset-list',
    summary: 'Portal: listar assets entregados a un cliente.',
    args: [CLIENT_ARG, ORIGIN_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planAssetList,
    run(ctx) {
      return executePortal(
        ctx,
        'portal-asset-list',
        async () => {
          requireCredential();
          const client = createPortalClient(originOf(ctx));
          return client.listAssets(requireString(ctx, 'client'));
        },
        (data) => {
          for (const line of renderPage<AssetView>('portal assets', data as Page<AssetView>, (item) => `  ${item.id} ← revisión ${item.revisionId} "${item.title}" (${item.visibility}, ${item.outputs.length} output(s))`)) {
            ctx.out(line);
          }
        },
      );
    },
  },
  {
    verb: 'portal-request-create',
    summary: 'Portal: crear un pedido de material por proyecto y mintear su enlace de invitado (admin/agente requests:write).',
    args: [CLIENT_ARG, PORTAL_PROJECT_ARG, TITLE_ARG, INSTRUCTIONS_ARG, MAX_FILES_ARG, MAX_BYTES_ARG, EXPIRES_ARG, ORIGIN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planRequestCreate,
    run(ctx) {
      const verb = 'portal-request-create';
      const steps = planRequestCreate(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          requireCredential();
          const result = await createPortalRequest({
            origin: originOf(ctx),
            portalProjectId: requirePortalProject(ctx),
            portalClientId: requireString(ctx, 'client'),
            title: requireString(ctx, 'title'),
            ...(ctx.args.instructions !== undefined ? { instructions: requireString(ctx, 'instructions') } : {}),
            maxFiles: parseMaxFilesArg(ctx),
            maxBytes: parseMaxBytesArg(ctx),
            expiresIn: parseExpiresInArg(ctx),
          });
          return {
            executed: true as const,
            requestId: result.requestId,
            url: result.url,
            expiresAt: result.expiresAt,
            limits: result.limits,
            request: result.request,
            project: result.project,
          };
        },
        (data) => {
          const record = data as RequestCreateData;
          ctx.out(`request ${record.requestId} — "${record.request.title}" en el proyecto portal ${record.project.id} (vence: ${new Date(record.expiresAt).toISOString()})`);
          ctx.out(`límites: ${record.limits.maxFiles} archivos / ${record.limits.maxBytes} bytes`);
          ctx.out(record.url);
          ctx.out('entregalo por tu canal (0 emails); el token nunca queda logueado ni en la evidencia.');
        },
      );
    },
  },
  {
    verb: 'portal-request-list',
    summary: 'Portal: listar pedidos de material de un proyecto portal (filtro opcional de estado).',
    args: [CLIENT_ARG, PORTAL_PROJECT_ARG, STATE_ARG, ORIGIN_ARG, CURSOR_ARG, LIMIT_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planRequestList,
    run(ctx) {
      return executePortal(
        ctx,
        'portal-request-list',
        async () => {
          requireCredential();
          const items = await listPortalRequests({
            origin: originOf(ctx),
            portalProjectId: requirePortalProject(ctx),
            portalClientId: requireString(ctx, 'client'),
            state: optionalStateArg(ctx),
          });
          return { items, nextCursor: null as string | null };
        },
        (data) => {
          const record = data as RequestListData;
          ctx.out(`pedidos: ${record.items.length} ítem(s)`);
          for (const entry of record.items) {
            const request = entry.request;
            ctx.out(`  ${request.id} — "${request.title}" (${request.state}, ${request.remainingFiles}/${request.maxFiles} archivos libres, proyecto portal ${entry.portalProjectId}, vence: ${new Date(request.expiresAt).toISOString()})`);
          }
        },
      );
    },
  },
  {
    verb: 'portal-request-close',
    summary: 'Portal: cerrar un pedido de material (congela el presupuesto; 409 si ya cerró).',
    args: [idArg('Id del request (posicional).'), REASON_ARG, ORIGIN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planRequestClose,
    run(ctx) {
      const verb = 'portal-request-close';
      const steps = planRequestClose(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          requireCredential();
          const request = await closePortalRequest({
            origin: originOf(ctx),
            requestId: requireString(ctx, 'id'),
            ...(ctx.args.reason !== undefined ? { reason: requireString(ctx, 'reason') } : {}),
          });
          return { executed: true as const, request };
        },
        (data) => {
          const record = data as RequestCloseData;
          ctx.out(`request ${record.request.id} — estado ${record.request.state}${record.request.closeReason ? ` (${record.request.closeReason})` : ''}`);
        },
      );
    },
  },
  {
    verb: 'portal-request-link',
    summary: 'Portal: mintear/rotar el enlace de invitado de un pedido (el token anterior muere; URL de entrega manual).',
    args: [idArg('Id del request (posicional).'), EXPIRES_ARG, ORIGIN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planRequestLink,
    run(ctx) {
      const verb = 'portal-request-link';
      const steps = planRequestLink(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          requireCredential();
          const link: UploadRequestLinkView = await mintPortalRequestLink({
            origin: originOf(ctx),
            requestId: requireString(ctx, 'id'),
            expiresIn: parseExpiresInArg(ctx),
          });
          return {
            executed: true as const,
            url: link.url,
            requestId: link.requestId,
            expiresAt: link.expiresAt,
            limits: link.limits,
          };
        },
        (data) => {
          const record = data as RequestLinkData;
          ctx.out(`link para el request ${record.requestId} (vence: ${new Date(record.expiresAt).toISOString()}; el enlace anterior quedó revocado)`);
          ctx.out(record.url);
          ctx.out('entregalo por tu canal (0 emails); nunca publicarlo ni loguearlo.');
        },
      );
    },
  },
  {
    verb: 'portal-request-pull',
    summary: 'Portal: importar TODOS los materiales ready de un pedido al proyecto Studio local indicado (verificado, idempotente; relación con el cliente del pedido validada).',
    args: [idArg('Id del request (posicional).'), PROJECT_ID_ARG, ASSET_ARG, WORKSPACE_ARG, ORIGIN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: ['projects/<project>/assets/<asset>/inputs/portal/*', 'projects/<project>/assets/<asset>/asset.json'],
    movesGates: [],
    plan: planRequestPull,
    run(ctx) {
      const verb = 'portal-request-pull';
      const steps = planRequestPull(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          requireCredential();
          return pullRequestMaterials({
            origin: originOf(ctx),
            workspaceDir: workspaceDirOf(ctx),
            requestId: requireString(ctx, 'id'),
            projectId: requireString(ctx, 'project'),
            assetId: requireString(ctx, 'asset'),
          });
        },
        (data) => {
          const record = data as RequestPullData;
          ctx.out(`request ${record.requestId} (${record.state}) → proyecto studio ${record.portalProject.studioProjectId}, asset ${record.assetId}`);
          for (const material of record.imported) {
            ctx.out(`  material ${material.id} (${material.mediaType}, ${material.bytes}B, sha256:${material.sha256.slice(0, 12)}…)`);
            ctx.out(`  input: ${material.inputPath}`);
            ctx.out(`  provenance: ${material.provenancePath}`);
          }
          ctx.out(`asset.json inputs añadidos: ${record.addedInputs.length > 0 ? record.addedInputs.join(', ') : '(ninguno — relación ya presente)'}`);
        },
      );
    },
  },
  {
    verb: 'portal-asset-upload-link',
    summary: 'Portal: mintear un link de subida de invitado atado a UN asset studio exacto (scope assets:write; el celular sube sin login y queda atribuido a ese asset; 0 emails).',
    args: [PROJECT_ID_ARG, ASSET_ARG, OPTIONAL_CLIENT_ARG, EXPIRES_ARG, TAILNET_ARG, INGEST_PORT_ARG, WORKSPACE_ARG, ORIGIN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [],
    movesGates: [],
    plan: planAssetLinkMint,
    run(ctx) {
      const verb = 'portal-asset-upload-link';
      const steps = planAssetLinkMint(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          requireCredential();
          const result = await mintPortalAssetLink({
            origin: originOf(ctx),
            workspaceDir: workspaceDirOf(ctx),
            studioProjectId: requireString(ctx, 'project'),
            studioAssetId: requireString(ctx, 'asset'),
            ...(typeof ctx.args.client === 'string' && ctx.args.client.length > 0 ? { portalClientId: requireString(ctx, 'client') } : {}),
            expiresIn: parseExpiresInArg(ctx),
          });
          if (ctx.args.tailnet === true) {
            // §10: mismo token, servido por el ingest local de la tailnet.
            // El probe del puerto es advertencia (nunca falla el mint).
            const tailnet = await tailnetUrlForMint(result.url, ingestPortOf(ctx));
            return {
              executed: true as const,
              url: result.url,
              linkId: result.linkId,
              portalClientId: result.portalClientId,
              portalProjectId: result.portalProjectId,
              studioProjectId: result.studioProjectId,
              studioAssetId: result.studioAssetId,
              expiresAt: result.expiresAt,
              tailnetUrl: tailnet.tailnetUrl,
              ingestPort: ingestPortOf(ctx),
              tailnetProbe: tailnet.probe,
            };
          }
          return {
            executed: true as const,
            url: result.url,
            linkId: result.linkId,
            portalClientId: result.portalClientId,
            portalProjectId: result.portalProjectId,
            studioProjectId: result.studioProjectId,
            studioAssetId: result.studioAssetId,
            expiresAt: result.expiresAt,
          };
        },
        (data) => {
          const record = data as AssetLinkMintData;
          ctx.out(`link para el asset ${record.studioAssetId} (proyecto studio ${record.studioProjectId}, cliente portal ${record.portalClientId}; vence: ${new Date(record.expiresAt).toISOString()}; el enlace anterior quedó cerrado)`);
          ctx.out(record.url);
          if (record.tailnetUrl !== undefined) {
            ctx.out(`tailnetUrl: ${record.tailnetUrl} (chunks hasta el ingest local; NUNCA por Cloudflare)`);
            if (record.tailnetProbe === 'listening') {
              ctx.out(`puerto ingest ${record.ingestPort}: escuchando.`);
            } else {
              ctx.out(`ATENCIÓN: el puerto ingest ${record.ingestPort} no responde ahora; levantá portal-ingest-serve antes de compartir el URL (advertencia, el mint queda válido).`);
            }
            ctx.out('el invitado necesita alcance tailnet a ese puerto (ACL); sin login: el token del link es la capacidad.');
          }
          ctx.out('entregalo por tu canal (0 emails): abre en el celular sin login; el token nunca queda logueado ni en la evidencia.');
        },
      );
    },
  },
  {
    verb: 'portal-asset-pull',
    summary: 'Portal: importar TODOS los materiales ready con asset_target en un asset studio exacto (verificado, idempotente; provenance con linkId).',
    args: [PROJECT_ID_ARG, ASSET_ARG, WORKSPACE_ARG, ORIGIN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: ['projects/<project>/assets/<asset>/inputs/portal/*', 'projects/<project>/assets/<asset>/asset.json'],
    movesGates: [],
    plan: planAssetPull,
    run(ctx) {
      const verb = 'portal-asset-pull';
      const steps = planAssetPull(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          requireCredential();
          return pullAssetMaterials({
            origin: originOf(ctx),
            workspaceDir: workspaceDirOf(ctx),
            studioProjectId: requireString(ctx, 'project'),
            studioAssetId: requireString(ctx, 'asset'),
          });
        },
        (data) => {
          const record = data as AssetPullData;
          ctx.out(`asset studio ${record.studioAssetId} (proyecto ${record.studioProjectId}): ${record.imported.length} material(es) importado(s)`);
          for (const material of record.imported) {
            ctx.out(`  material ${material.id} (${material.mediaType}, ${material.bytes}B, sha256:${material.sha256.slice(0, 12)}…, link ${material.linkId ?? '(sin link)'})`);
            ctx.out(`  input: ${material.inputPath}`);
            ctx.out(`  provenance: ${material.provenancePath}`);
          }
          ctx.out(`asset.json inputs añadidos: ${record.addedInputs.length > 0 ? record.addedInputs.join(', ') : '(ninguno — relación ya presente)'}`);
        },
      );
    },
  },
  {
    verb: 'portal-ingest-serve',
    summary: 'Portal: servir el ingest de tomas pesadas por la tailnet (sin login; token validado contra el portal; chunks reanudables 32MiB, tope 5GiB; primer plano).',
    args: [ORIGIN_ARG, INGEST_PORT_ARG, INGEST_DIR_ARG, JSON_ARG],
    supportsPlan: true,
    writes: [`${INGEST_DEFAULT_DIR}/*`],
    movesGates: [],
    plan: planIngestServe,
    run(ctx) {
      // Grammar first (usage exit 2): nothing binds or resolves before the
      // args are valid.
      originOf(ctx);
      const port = ingestPortOf(ctx);
      return executePortal(
        ctx,
        'portal-ingest-serve',
        async () => {
          // Bind host: la IPv4 de tailscale SOLO (jamás 0.0.0.0/::; el
          // loopback existe únicamente para tests del módulo).
          const bindHost = await resolveTailscaleIpv4();
          const server = await createIngestServer({
            portalOrigin: originOf(ctx),
            ingestDir: ingestDirOf(ctx),
            bindHost,
            port,
          });
          for (const line of formatIngestServeBanner({ origin: server.origin, bindHost: server.host, ingestDir: server.ingestDir, port: server.port })) {
            ctx.out(line);
          }
          // Foreground: the process lives until the operator interrupts it.
          await new Promise<never>(() => {
            const shutdown = (): void => {
              void server.stop().then(() => process.exit(0));
            };
            process.once('SIGINT', shutdown);
            process.once('SIGTERM', shutdown);
          });
        },
        () => undefined,
      );
    },
  },
  {
    verb: 'portal-asset-ingest-pull',
    summary: 'Portal: importar las tomas LANDED del ingest tailnet al asset studio exacto (SHA verificado, idempotente; SIN red ni credencial: el landing es local).',
    args: [PROJECT_ID_ARG, ASSET_ARG, WORKSPACE_ARG, INGEST_DIR_ARG, INGEST_TOKEN_ARG, EXECUTE_ARG, JSON_ARG],
    supportsPlan: true,
    writes: ['projects/<project>/assets/<asset>/inputs/portal/*', 'projects/<project>/assets/<asset>/asset.json'],
    movesGates: [],
    plan: planIngestPull,
    run(ctx) {
      const verb = 'portal-asset-ingest-pull';
      const steps = planIngestPull(ctx);
      requireMutationExecute(ctx, verb, steps);
      return executePortal(
        ctx,
        verb,
        async () => {
          const tokenHashPrefix = optionalTokenPrefix(ctx);
          // Local by design (§10): los tomas landed nunca son materiales del
          // portal; acá NO hay --origin ni CUSTOMER_ASSETS_API_KEY.
          return pullLandedTakes({
            workspaceDir: workspaceDirOf(ctx),
            ingestDir: ingestDirOf(ctx),
            studioProjectId: requireString(ctx, 'project'),
            studioAssetId: requireString(ctx, 'asset'),
            ...(tokenHashPrefix !== undefined ? { tokenHashPrefix } : {}),
          });
        },
        (data) => {
          const record = data as IngestPullData;
          ctx.out(`asset studio ${record.studioAssetId} (proyecto ${record.studioProjectId}): ${record.imported.length} toma(s) del landing ${record.ingestDir}`);
          for (const take of record.imported) {
            ctx.out(`  toma ${take.takeId} (video/mp4, ${take.bytes}B, sha256:${take.sha256.slice(0, 12)}…, tokenHash ${take.tokenHash.slice(0, 12)}…, origen ${take.ingestOrigin})`);
            ctx.out(`  input: ${take.inputPath}`);
            ctx.out(`  provenance: ${take.provenancePath}`);
            ctx.out(`  landing drenado: ${take.removedFromLanding ? 'sí' : 'no'}`);
          }
          ctx.out(`asset.json inputs añadidos: ${record.addedInputs.length > 0 ? record.addedInputs.join(', ') : '(ninguno — ya importado)'}`);
        },
      );
    },
  },
];
