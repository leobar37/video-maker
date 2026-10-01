/**
 * `dashboard url` support (contracts.md §8): discover the RUNNING dashboard
 * from the persisted serve state (real port, no new flags), verify it is
 * alive and listening, obtain the machine's Tailscale IPv4 and only then
 * hand out `http://<tailscale-ip>:<port>/` — NEVER a loopback URL, never a
 * fallback. All network seams are injectable for tests (no real Tailscale,
 * no lasting service is touched by the suites).
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { StudioIdSchema } from '@videomaker/schemas';
import { StudioServiceError } from '@videomaker/studio';

function fail(code: StudioServiceError['code'], message: string, details?: Record<string, unknown>): never {
  throw new StudioServiceError(code, message, details);
}

// ---------------------------------------------------------------------------
// Serve state (written by `dashboard serve` run mode; read by `dashboard url`)
// ---------------------------------------------------------------------------

export interface DashboardServeState {
  schemaVersion: 1;
  pid: number;
  host: string;
  port: number;
  access: 'internal' | 'trusted-tailnet';
  /** ISO timestamp of the server start (informational, never authority). */
  startedAt: string;
}

export function dashboardServeStatePath(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), '.vm', 'dashboard', 'serve.json');
}

export async function writeDashboardServeState(workspaceDir: string, state: DashboardServeState): Promise<void> {
  const file = dashboardServeStatePath(workspaceDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** `null` when absent or unreadable — the caller reports "no server". */
export async function readDashboardServeState(workspaceDir: string): Promise<DashboardServeState | null> {
  let raw: string;
  try {
    raw = await readFile(dashboardServeStatePath(workspaceDir), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<DashboardServeState>;
  if (candidate.schemaVersion !== 1) return null;
  if (typeof candidate.pid !== 'number' || !Number.isInteger(candidate.pid) || candidate.pid <= 0) return null;
  if (typeof candidate.host !== 'string' || candidate.host.length === 0) return null;
  if (typeof candidate.port !== 'number' || !Number.isInteger(candidate.port) || candidate.port <= 0 || candidate.port > 65535) return null;
  if (candidate.access !== 'internal' && candidate.access !== 'trusted-tailnet') return null;
  if (typeof candidate.startedAt !== 'string') return null;
  return candidate as DashboardServeState;

}

export async function removeDashboardServeState(workspaceDir: string): Promise<void> {
  await rm(dashboardServeStatePath(workspaceDir), { force: true });
}

// ---------------------------------------------------------------------------
// Injectable seams (tests never touch real Tailscale or lasting servers)
// ---------------------------------------------------------------------------

export type TailscaleIpv4Resolver = () => Promise<string>;
export type HealthProbe = (url: string) => Promise<boolean>;

export const DEFAULT_PROBE_TIMEOUT_MS = 1500;

/** Inputs for the real-socket check: the REGISTERED serve state. */
export interface ListenerProbeInput {
  host: string;
  port: number;
  pid: number;
}

export interface ListenerProbeResult {
  /** A socket is actually LISTENing on that port. */
  listening: boolean;
  /** The socket binds ALL interfaces (0.0.0.0 / [::] / *). */
  allInterfaces: boolean;
  /** The listening socket belongs to the registered pid. */
  pidMatches: boolean;
}

export type ListenerProbe = (input: ListenerProbeInput) => Promise<ListenerProbeResult>;

/**
 * Default real-socket check: `ss -tlnp`. Fails CLOSED on any doubt (ss
 * unavailable, no match, ambiguous owners) — no URL is ever derived from an
 * unverified listener.
 */
export async function probeListenerViaSs(input: ListenerProbeInput): Promise<ListenerProbeResult> {
  const closed: ListenerProbeResult = { listening: false, allInterfaces: false, pidMatches: false };
  let stdout = '';
  try {
    const proc = Bun.spawn(['ss', '-tlnp'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  } catch {
    return closed;
  }
  const suffix = `:${input.port}`;
  const owners: string[] = [];
  let allInterfaces = false;
  for (const line of stdout.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (columns[0] !== 'LISTEN') continue;
    const local = columns.find((column) => column.includes(suffix));
    if (local === undefined || !local.endsWith(suffix)) continue;
    const hostPart = local.slice(0, local.length - suffix.length);
    if (hostPart !== '0.0.0.0' && hostPart !== '[::]' && hostPart !== '*') continue;
    allInterfaces = true;
    for (const match of line.matchAll(/pid=(\d+)/g)) owners.push(match[1]!);
  }
  if (!allInterfaces) return { listening: false, allInterfaces: false, pidMatches: false };
  return { listening: true, allInterfaces: true, pidMatches: owners.includes(String(input.pid)) };
}

/** True ONLY for a non-loopback Tailscale IPv4 (100.64.0.0/10). */
export function isTailscaleIpv4(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (match === null) return false;
  const octets = [match[1], match[2], match[3], match[4]].map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127;
}

/** Probes `GET /health` on the given base URL (machine-local allowed). */
export async function probeDashboardHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Default resolver: `tailscale ip -4`. Fails closed — no valid tailnet IPv4,
 * no link; there is deliberately NO loopback fallback for the user.
 */
export async function tailscaleIpv4ViaCli(): Promise<string> {
  let stdout = '';
  let exitCode = -1;
  try {
    const proc = Bun.spawn(['tailscale', 'ip', '-4'], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
    [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  } catch {
    fail('STORAGE_UNAVAILABLE', 'No se pudo ejecutar `tailscale ip -4` (Tailscale parece inactivo); sin enlace para el usuario (nunca loopback).');
  }
  if (exitCode !== 0) {
    fail('STORAGE_UNAVAILABLE', `\`tailscale ip -4\` terminó con error (exit ${exitCode}); Tailscale no está operativo y no hay enlace alternativo.`);
  }
  const ip = stdout.trim().split(/\s+/)[0] ?? '';
  if (!isTailscaleIpv4(ip)) {
    fail('STORAGE_UNAVAILABLE', '`tailscale ip -4` no devolvió una IPv4 de tailnet (100.64.0.0/10); sin enlace para el usuario.');
  }
  return ip;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user: alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isAllInterfacesHost(host: string): boolean {
  return host === '0.0.0.0' || host === '::';
}

export interface DashboardUrlInput {
  workspaceDir: string;
  clientId?: string;
  projectId?: string;
  /** Test seam: replaces `tailscale ip -4`. */
  tailscaleIpv4?: TailscaleIpv4Resolver;
  /** Test seam: replaces the /health prober. */
  probeHealth?: HealthProbe;
  /** Test seam: replaces the `ss -tlnp` real-socket check. */
  listenerProbe?: ListenerProbe;
}

export interface DashboardUrlResult {
  url: string;
  ip: string;
  port: number;
  access: DashboardServeState['access'];
}

/**
 * Builds the user-facing Tailscale link:
 * 1. serve state present and well-formed (else NOT_FOUND — run `dashboard serve` first);
 * 2. registered pid alive;
 * 3. access model must be `trusted-tailnet` with an all-interfaces bind
 *    (loopback-only servers get an actionable error, never a loopback link);
 * 4. the REAL socket is verified (ss -tlnp: LISTEN on 0.0.0.0/[::] for the
 *    port AND owned by the registered pid — fail-closed, stale rejected);
 * 5. the server answers /health locally;
 * 6. a real, validated Tailscale IPv4 (100.64.0.0/10, never loopback);
 * 7. the server must answer through that IP before the link is handed out.
 */
export async function resolveDashboardUrl(input: DashboardUrlInput): Promise<DashboardUrlResult> {
  if (input.clientId !== undefined && !StudioIdSchema.safeParse(input.clientId).success) {
    fail('INVALID_INPUT', 'filter.clientId debe ser un id kebab-case válido.', { field: 'clientId' });
  }
  if (input.projectId !== undefined && !StudioIdSchema.safeParse(input.projectId).success) {
    fail('INVALID_INPUT', 'filter.projectId debe ser un id kebab-case válido.', { field: 'projectId' });
  }
  const state = await readDashboardServeState(input.workspaceDir);
  if (state === null) {
    fail('NOT_FOUND', 'No hay servidor de dashboard registrado en este workspace; ejecutá `vm dashboard serve` primero.');
  }
  if (!processAlive(state.pid)) {
    fail('NOT_FOUND', `El estado de serve es stale: el pid ${state.pid} ya no está en ejecución; volvé a lanzar \`vm dashboard serve\`.`);
  }
  if (!isAllInterfacesHost(state.host) || state.access !== 'trusted-tailnet') {
    fail(
      'INVALID_INPUT',
      'El dashboard no está expuesto en todas las interfaces; un enlace para el usuario exige `vm dashboard serve --host 0.0.0.0 --access trusted-tailnet` (nunca se entrega un enlace loopback).',
      { host: state.host, access: state.access },
    );
  }
  const listener = input.listenerProbe ?? probeListenerViaSs;
  const socket = await listener({ host: state.host, port: state.port, pid: state.pid });
  if (!socket.listening || !socket.allInterfaces) {
    fail('NOT_FOUND', `El estado de serve es stale: ningún socket real escucha en todas las interfaces del puerto ${state.port}; rechazando el estado registrado.`);
  }
  if (!socket.pidMatches) {
    fail('NOT_FOUND', `El estado de serve es stale: el puerto ${state.port} pertenece a otro proceso (pid ${state.pid} registrado); rechazando el estado.`);
  }
  const probe = input.probeHealth ?? probeDashboardHealth;
  if (!(await probe(`http://127.0.0.1:${state.port}/health`))) {
    fail('NOT_FOUND', `El estado de serve es stale: nada responde en el puerto ${state.port}; rechazando el estado registrado.`);
  }
  const ip = await (input.tailscaleIpv4 ?? tailscaleIpv4ViaCli)();
  // Validated for the real CLI output AND injected values alike.
  if (!isTailscaleIpv4(ip)) {
    fail('STORAGE_UNAVAILABLE', 'La IP obtenida no es una IPv4 de tailnet (100.64.0.0/10); sin enlace (jamás loopback ni valores inválidos).');
  }
  if (!(await probe(`http://${ip}:${state.port}/health`))) {
    fail('STORAGE_UNAVAILABLE', `El servidor no responde a través de la IP de Tailscale (${ip}:${state.port}); sin enlace (¿firewall del tailnet?).`, {
      access: state.access,
    });
  }
  const params = new URLSearchParams();
  if (input.clientId !== undefined) params.set('client', input.clientId);
  if (input.projectId !== undefined) params.set('project', input.projectId);
  const query = params.toString();
  return { url: `http://${ip}:${state.port}/${query.length > 0 ? `?${query}` : ''}`, ip, port: state.port, access: state.access };
}
