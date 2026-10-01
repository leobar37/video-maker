/**
 * CLI dashboard-spec scenarios (P-005 correction): the bind/access policy is
 * enforced BEFORE any bind, state write or lazy import. Negative tests run
 * `plan()` and `run()` of `dashboard-serve` directly against a stub run
 * context — no server, no `ss`, no Tailscale, no workspace writes.
 */
import { describe, expect, test } from 'bun:test';

import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CommandFailure } from '../registry';
import type { CommandRunContext } from '../spec-types';
import { dashboardServeSpec } from './studio-dashboard';

function ctxOf(args: CommandRunContext['args'], mode: 'plan' | 'run'): { ctx: CommandRunContext; out: string[] } {
  const out: string[] = [];
  const ctx: CommandRunContext = {
    args,
    cwd: os.tmpdir(),
    mode,
    out: (line) => out.push(line),
    fail: (message, code = 1) => {
      throw new CommandFailure(message, code);
    },
  };
  return { ctx, out };
}

/** Runs the spec expecting the P-003 usage envelope + CommandFailure exit 2. */
async function expectUsageExit2(args: CommandRunContext['args'], mode: 'plan' | 'run'): Promise<string[]> {
  const { ctx, out } = ctxOf(args, mode);
  let failure: unknown;
  try {
    if (mode === 'plan') await dashboardServeSpec.plan(ctx);
    else await dashboardServeSpec.run(ctx);
  } catch (error) {
    failure = error;
  }
  expect(failure instanceof CommandFailure).toBe(true);
  expect((failure as CommandFailure).exitCode).toBe(2);
  // The envelope was already printed exactly once (reported = true).
  const envelopes = out.filter((line) => line.includes('"ok": false'));
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]).toContain('"code": "INVALID_INPUT"');
  return out;
}

describe('dashboard serve: política de bind/acceso ANTES de bindear (corrección)', () => {
  test('plan/run --host 0.0.0.0 sin --access ⇒ exit 2 y NINGÚN estado escrito', async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'vm-cli-dash-'));
    try {
      for (const mode of ['plan', 'run'] as const) {
        await expectUsageExit2({ host: '0.0.0.0', port: 47234, workspace, json: true }, mode);
        const stateDir = await stat(path.join(workspace, '.vm')).then(
          () => true,
          () => false,
        );
        expect(stateDir).toBe(false); // zero writes in both modes
      }
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test('localhost ya NO esquiva la política: --access trusted-tailnet exige 0.0.0.0', async () => {
    for (const mode of ['plan', 'run'] as const) {
      await expectUsageExit2({ host: 'localhost', port: 0, access: 'trusted-tailnet', json: true }, mode);
    }
  });

  test('access desconocido se rechaza (no se interpreta como internal)', async () => {
    for (const mode of ['plan', 'run'] as const) {
      await expectUsageExit2({ host: '127.0.0.1', port: 0, access: 'public', json: true }, mode);
    }
  });

  test('combinaciones válidas en plan: pasos puros, cero writes, sin subprocess', async () => {
    for (const args of [
      { host: '127.0.0.1', port: 0, access: 'internal', json: false },
      { host: 'localhost', port: 0, access: 'internal', json: false },
      { host: '0.0.0.0', port: 8907, access: 'trusted-tailnet', json: false },
    ]) {
      const { ctx, out } = ctxOf(args, 'plan');
      const steps = await dashboardServeSpec.plan(ctx);
      expect(steps.length).toBeGreaterThan(0);
      expect(steps[0]!.action).toContain('NUNCA en plan');
      expect(out).toHaveLength(0); // plan prints nothing by itself
    }
  });
});
