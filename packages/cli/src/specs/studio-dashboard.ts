/**
 * `studioDashboardSpecs` — declarative adapters for the dashboard commands
 * (P-005, contracts.md §6/§8): `dashboard serve` and `dashboard url`.
 *
 * Conventions (mirror of the P-003/P-004 studio specs):
 * - `dashboard serve` NEVER starts a server in plan mode: `--plan`/`--dry-run`
 *   perform zero bind, zero network, zero credentials, zero subprocess and
 *   zero writes (NFR-002). The real bind happens only in `run()`.
 * - Default bind is INTERNAL (127.0.0.1). Exposing on all interfaces requires
 *   the explicit pair `--host 0.0.0.0 --access trusted-tailnet` and prints an
 *   access-model warning. The server is read-only: no mutating HTTP verb
 *   exists, so no auth/RBAC is introduced in this phase.
 * - The internal default NEVER prints a loopback URL to the user; the
 *   user-facing link is only built by `dashboard url` from the serve state,
 *   verifying pid + listener + real Tailscale IPv4 (no loopback fallback).
 * - Typed/usage failures use the P-003 envelope (`studioEnvelopeError` +
 *   `CommandFailure reported`) in `--json` mode, exactly one output.
 * - The dashboard package import is lazy (`run()` only): CLI startup must
 *   not drag the server/UI into every command.
 */
import { resolve } from 'node:path';

import { isStudioServiceError, StudioServiceError } from '@videomaker/studio';

import { JSON_ARG } from '../args';
import { CommandFailure } from '../registry';
import type {
  CommandArgSpec,
  CommandResult,
  CommandRunContext,
  CommandSpec,
  PlanStep,
} from '../spec-types';
import { STUDIO_EXIT_OK, STUDIO_EXIT_USAGE, studioEnvelopeError, studioExitCodeForError } from './studio-pairs';

const WORKSPACE_ARG: CommandArgSpec = {
  name: 'workspace',
  kind: 'string',
  required: false,
  description: 'Raíz del workspace studio (default: ./workspace relativa al cwd); guarda el estado de serve en .vm/dashboard/.',
};

const HOST_ARG: CommandArgSpec = {
  name: 'host',
  kind: 'string',
  required: false,
  default: '127.0.0.1',
  description: 'Bind: 127.0.0.1 (interno, default) | 0.0.0.0 (todas las interfaces; exige --access trusted-tailnet).',
};

const PORT_ARG: CommandArgSpec = {
  name: 'port',
  kind: 'number',
  required: false,
  default: 0,
  description: 'Puerto TCP explícito (default 0: efímero del SO, descubierto luego por `dashboard url` desde el estado).',
};

const ACCESS_ARG: CommandArgSpec = {
  name: 'access',
  kind: 'string',
  required: false,
  default: 'internal',
  description: 'Modelo de acceso: internal (default) | trusted-tailnet (red de confianza explícita; NUNCA Internet público). Otros valores se rechazan.',
};

const CLIENT_ARG: CommandArgSpec = {
  name: 'client',
  kind: 'string',
  required: false,
  description: 'Filtro opcional del enlace: id de cliente.',
};

const PROJECT_ARG: CommandArgSpec = {
  name: 'project',
  kind: 'string',
  required: false,
  description: 'Filtro opcional del enlace: id de proyecto.',
};

// ---------------------------------------------------------------------------
// Local helpers (mirror of the studio-sync conventions)
// ---------------------------------------------------------------------------

function workspaceDirOf(ctx: CommandRunContext): string {
  const value = ctx.args.workspace;
  const raw = typeof value === 'string' && value.trim().length > 0 ? value : 'workspace';
  return resolve(ctx.cwd, raw);
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
      ctx.out(studioEnvelopeError({ code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) }));
      throw new CommandFailure(error.message, exitCode, { reported: true });
    }
    return ctx.fail(`${error.code}: ${error.message}`, exitCode);
  }
  throw error;
}

async function withDashboard<T>(ctx: CommandRunContext, service: () => Promise<T>): Promise<T> {
  try {
    return await service();
  } catch (error) {
    failStudio(ctx, error);
  }
}

function optionalId(ctx: CommandRunContext, name: string): string | undefined {
  const value = ctx.args[name];
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value.trim();
}

// ---------------------------------------------------------------------------
// dashboard serve
// ---------------------------------------------------------------------------

interface ServeOptions {
  host: '127.0.0.1' | '0.0.0.0';
  port: number;
  access: 'internal' | 'trusted-tailnet';
}

/** Validates the bind policy BEFORE anything happens (pure; plan-safe). */
function serveOptionsOf(ctx: CommandRunContext): ServeOptions {
  // localhost normalizes to 127.0.0.1 FIRST, so no early return can bypass
  // the trusted-tailnet ↔ bind cross-checks.
  const hostRaw = typeof ctx.args.host === 'string' && ctx.args.host.trim().length > 0 ? ctx.args.host.trim() : '127.0.0.1';
  if (hostRaw !== '127.0.0.1' && hostRaw !== 'localhost' && hostRaw !== '0.0.0.0') {
    return failUsage(ctx, '--host soporta 127.0.0.1/localhost (interno) u 0.0.0.0 (todas las interfaces).');
  }
  const host: ServeOptions['host'] = hostRaw === 'localhost' ? '127.0.0.1' : (hostRaw as ServeOptions['host']);
  const accessRaw = typeof ctx.args.access === 'string' && ctx.args.access.trim().length > 0 ? ctx.args.access.trim() : 'internal';
  if (accessRaw !== 'internal' && accessRaw !== 'trusted-tailnet') {
    return failUsage(ctx, '--access soporta internal (default) o trusted-tailnet (explícito); otros valores se rechazan.');
  }
  const access: ServeOptions['access'] = accessRaw;
  const portRaw = ctx.args.port;
  const port =
    portRaw === undefined
      ? 0
      : typeof portRaw === 'number' && Number.isInteger(portRaw) && portRaw >= 0 && portRaw <= 65535
        ? portRaw
        : failUsage(ctx, '--port espera un entero entre 0 (efímero) y 65535.');
  // Explicit permission model, mirroring startDashboardServer exactly.
  if (host === '0.0.0.0' && access !== 'trusted-tailnet') {
    return failUsage(ctx, 'Exponer en todas las interfaces exige --access trusted-tailnet explícito (advertencia: no es apto para Internet abierto ni reemplaza auth multiusuario).');
  }
  if (host === '127.0.0.1' && access === 'trusted-tailnet') {
    return failUsage(ctx, '--access trusted-tailnet exige --host 0.0.0.0 (un bind interno no genera enlace de usuario).');
  }
  return { host, port, access };
}

export const dashboardServeSpec: CommandSpec = {
  verb: 'dashboard-serve',
  summary: 'dashboard serve [--host <host>] [--port <n>] [--access trusted-tailnet] — servidor SOLO lectura del catálogo studio.',
  args: [HOST_ARG, PORT_ARG, ACCESS_ARG, WORKSPACE_ARG, JSON_ARG],
  supportsPlan: true,
  writes: ['.vm/dashboard/serve.json'],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    const options = serveOptionsOf(ctx);
    const portLabel = options.port === 0 ? 'puerto efímero del SO' : `puerto ${options.port}`;
    const steps: PlanStep[] = [
      { action: `NUNCA en plan: cero bind, cero red, cero credenciales, cero subprocess, cero writes (el run real haría bind ${options.host}, ${portLabel})` },
    ];
    if (options.access === 'trusted-tailnet') {
      steps.push({ action: 'exposición en TODAS las interfaces: solo red de confianza (trusted-tailnet); sin auth multiusuario, nunca Internet público' });
    }
    steps.push({ action: 'servir SOLO lectura: catálogo/inspección/diff/archivos sellados por nombre declarado; sin acciones mutadoras HTTP', writes: '' });
    steps.push({ action: 'registrar el estado de serve (pid/host/port real/access) para que `dashboard url` descubra el puerto', writes: '.vm/dashboard/serve.json' });
    steps.push({ action: 'el bind interno NUNCA imprime un enlace loopback al usuario; el enlace lo construye `dashboard url` con IPv4 Tailscale verificada' });
    return steps;
  },

  async run(ctx): Promise<CommandResult> {
    const options = serveOptionsOf(ctx);
    const workspaceDir = workspaceDirOf(ctx);
    // Lazy import: the server/UI must not load for unrelated CLI commands.
    const dashboard = await withDashboard(ctx, () => import('@videomaker/dashboard'));
    const running = await withDashboard(ctx, () => dashboard.startDashboardServer({ workspaceDir, host: options.host, port: options.port, access: options.access }));
    await withDashboard(ctx, async () => {
      try {
        await dashboard.writeDashboardServeState(workspaceDir, {
          schemaVersion: 1,
          pid: process.pid,
          host: running.hostname,
          port: running.port,
          access: running.access,
          startedAt: new Date().toISOString(),
        });
      } catch (error) {
        await running.stop();
        throw new StudioServiceError('STORAGE_UNAVAILABLE', 'No se pudo registrar el estado de serve en .vm/dashboard (¿permisos del workspace?).', undefined, error);
      }
    });

    if (jsonMode(ctx)) {
      // Envelope once, BEFORE blocking; the shutdown path prints nothing more.
      ctx.out(`${JSON.stringify({ schemaVersion: 1, ok: true, data: { listening: true, host: running.hostname, port: running.port, access: running.access, pid: process.pid } }, null, 2)}\n`);
    } else {
      // Internal default: NO loopback URL for the user, ever.
      ctx.out(`dashboard SOLO lectura escuchando en bind ${running.hostname}:${running.port} (interno; sin enlace para el usuario).`);
      if (running.access === 'trusted-tailnet') {
        ctx.out('ADVERTENCIA de modelo de acceso: expuesto en todas las interfaces (trusted-tailnet) — únicamente red de confianza; no es apto para Internet abierto y no reemplaza auth multiusuario.');
      }
      ctx.out('Enlace para el usuario: `vm dashboard url` (IPv4 Tailscale verificada; nunca loopback). Ctrl+C para detener.');
    }

    const shutdown = new Promise<void>((resolveShutdown) => {
      const stop = () => resolveShutdown();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await shutdown;
    await running.stop();
    try {
      await dashboard.removeDashboardServeState(workspaceDir);
    } catch {
      // Best-effort cleanup; `dashboard url` rejects stale state anyway.
    }
    if (!jsonMode(ctx)) {
      ctx.out('dashboard detenido.');
    }
    return { exitCode: STUDIO_EXIT_OK };
  },
};

// ---------------------------------------------------------------------------
// dashboard url
// ---------------------------------------------------------------------------

export const dashboardUrlSpec: CommandSpec = {
  verb: 'dashboard-url',
  summary: 'dashboard url [--client <id>] [--project <id>] — enlace Tailscale verificado del servidor en ejecución (nunca loopback).',
  args: [CLIENT_ARG, PROJECT_ARG, WORKSPACE_ARG, JSON_ARG],
  supportsPlan: true,
  writes: [],
  movesGates: [],

  async plan(ctx): Promise<PlanStep[]> {
    const client = optionalId(ctx, 'client');
    const project = optionalId(ctx, 'project');
    const filters = [client ? `client=${client}` : null, project ? `project=${project}` : null].filter((part) => part !== null);
    return [
      { action: 'leer el estado de serve local (.vm/dashboard/serve.json); sin red, sin subprocess en plan' },
      { action: 'en run: comprobar pid vivo + /health local; estado stale/ausente ⇒ error, jamás un enlace loopback' },
      { action: 'en run: exigir bind 0.0.0.0 con --access trusted-tailnet registrado' },
      { action: 'en run: obtener IPv4 real con `tailscale ip -4` y probar /health a través de ella antes de entregar el enlace' },
      { action: `componer http://<ip-tailscale>:<puerto>/${filters.length > 0 ? `?${filters.join('&')}` : ''} (filtros opcionales)` },
    ];
  },

  async run(ctx): Promise<CommandResult> {
    const clientId = optionalId(ctx, 'client');
    const projectId = optionalId(ctx, 'project');
    const dashboard = await withDashboard(ctx, () => import('@videomaker/dashboard'));
    const result = await withDashboard(ctx, () =>
      dashboard.resolveDashboardUrl({ workspaceDir: workspaceDirOf(ctx), ...(clientId !== undefined ? { clientId } : {}), ...(projectId !== undefined ? { projectId } : {}) }),
    );
    if (jsonMode(ctx)) {
      ctx.out(`${JSON.stringify({ schemaVersion: 1, ok: true, data: { url: result.url, ip: result.ip, port: result.port, access: result.access, filters: { ...(clientId !== undefined ? { client: clientId } : {}), ...(projectId !== undefined ? { project: projectId } : {}) } } }, null, 2)}\n`);
    } else {
      ctx.out(result.url);
      ctx.out('Compartí solo este enlace Tailscale; el servidor no es apto para Internet abierto (trusted-tailnet, sin auth multiusuario).');
    }
    return { exitCode: STUDIO_EXIT_OK };
  },
};

/** All dashboard commands, in registry/display order (pairs per contracts.md §6). */
export const studioDashboardSpecs: CommandSpec[] = [dashboardServeSpec, dashboardUrlSpec];
