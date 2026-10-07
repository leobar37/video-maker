/**
 * Ephemeral local dev server lifecycle for the e2e harness: spawns
 * `vite dev` with the e2e config on 127.0.0.1:<port>, waits for /api/health,
 * and tears everything down (SIGTERM → SIGKILL) before exit. The listener
 * never leaves loopback (G-cap-local).
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

export const E2E_PORT = Number(process.env.E2E_PORT ?? 4519);
export const ORIGIN = `http://127.0.0.1:${E2E_PORT}`;

const APP_DIR = join(import.meta.dir, '..', '..');
const STATE_DIR = join(APP_DIR, 'tests', 'e2e', '.state');

export interface E2eServer {
  stop(): Promise<void>;
}

export async function startE2eServer(): Promise<E2eServer> {
  // Fresh emulated D1/R2 state per run: migrations are applied by the fixture
  // endpoint right after boot, so the database starts deterministic.
  rmSync(STATE_DIR, { recursive: true, force: true });

  const proc = Bun.spawn({
    cmd: [
      'bunx',
      'vite',
      'dev',
      '--config',
      'tests/e2e/vite.config.ts',
      '--host',
      '127.0.0.1',
      '--port',
      String(E2E_PORT),
      '--strictPort',
    ],
    cwd: APP_DIR,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, E2E_PORT: String(E2E_PORT) },
  });

  const deadline = Date.now() + 120_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(`vite dev exited early (${proc.exitCode}):\n${stderr.slice(-2000)}`);
    }
    try {
      const response = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        const body = (await response.json()) as { d1: boolean; r2: boolean };
        if (body.d1 && body.r2) {
          healthy = true;
          break;
        }
      }
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  if (!healthy) {
    proc.kill();
    throw new Error('vite dev did not become healthy in time');
  }

  let stopped = false;
  return {
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      proc.kill('SIGTERM');
      const gracefulDeadline = Date.now() + 10_000;
      while (proc.exitCode === null && Date.now() < gracefulDeadline) {
        await Bun.sleep(200);
      }
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await proc.exited;
    },
  };
}
