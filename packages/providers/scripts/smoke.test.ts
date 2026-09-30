/**
 * `providers:smoke --plan`: offline by construction — zero fetch, zero secret
 * reads, name presence only. Coherent (or empty) configuration exits 0;
 * incoherent pair declarations exit non-zero with actionable errors; secret
 * values never reach stdout (NFR-001).
 */
import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, runSmokePlan, type SmokeOptions } from './smoke';

const SMOKE_SCRIPT = join(import.meta.dir, 'smoke.ts');

function presenceOf(names: readonly string[]): SmokeOptions['presence'] {
  const declared = new Set(names);
  return (name: string) => declared.has(name);
}

describe('runSmokePlan', () => {
  it('zero env: coherent plan that prints what WOULD be required', () => {
    const report = runSmokePlan({ presence: presenceOf([]) });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    const text = report.lines.join('\n');
    expect(text).toContain('would require: R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ENDPOINT');
    expect(text).toContain('would require: ZERNIO_API_KEY');
    expect(text).toContain('no secret values read');
  });

  it('fully declared configuration is coherent and reports presence only', () => {
    const report = runSmokePlan({
      presence: presenceOf([
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_ENDPOINT',
        'R2_MARKETING_BUCKET_NAME',
        'R2_MARKETING_PUBLIC_URL',
        'R2_BUNDLES_BUCKET_NAME',
        'ZERNIO_API_KEY',
      ]),
    });
    expect(report.ok).toBe(true);
    const text = report.lines.join('\n');
    expect(text).not.toContain('would require:');
    expect(text).toContain('R2_MARKETING_BUCKET_NAME=declared');
    expect(text).toContain('ZERNIO_API_KEY=declared');
    // Presence is reported per name, also for names the active pair does not use.
    expect(text).toContain('R2_BUCKET_NAME=missing');
    expect(text).toContain('R2_BUNDLES_BUCKET_NAME=declared');
  });

  it('falls back to the generic pair when the marketing pair is not declared', () => {
    const report = runSmokePlan({
      presence: presenceOf([
        'R2_ACCESS_KEY_ID',
        'R2_SECRET_ACCESS_KEY',
        'R2_ENDPOINT',
        'R2_BUCKET_NAME',
        'R2_PUBLIC_URL',
      ]),
    });
    expect(report.ok).toBe(true);
    const text = report.lines.join('\n');
    expect(text).toContain('generic pair');
    expect(text).toContain('R2_MARKETING_BUCKET_NAME=missing');
  });

  it('half-declared pairs are incoherent (actionable errors)', () => {
    const halfMarketing = runSmokePlan({
      presence: presenceOf(['R2_MARKETING_BUCKET_NAME']),
    });
    expect(halfMarketing.ok).toBe(false);
    expect(halfMarketing.errors.join('\n')).toContain('half-declared marketing pair');

    const halfGeneric = runSmokePlan({
      presence: presenceOf(['R2_PUBLIC_URL']),
    });
    expect(halfGeneric.ok).toBe(false);
    expect(halfGeneric.errors.join('\n')).toContain('half-declared generic pair');
  });
});

describe('smoke CLI', () => {
  it('exits 0 for a coherent plan and 1 for incoherent declarations', async () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);

    expect(await main(['--plan'], { presence: presenceOf([]), write })).toBe(0);
    expect(
      await main(['--plan'], { presence: presenceOf(['R2_MARKETING_BUCKET_NAME']), write }),
    ).toBe(1);
    expect(lines.join('\n')).toContain('FAILED');
  });

  it('rejects any argument other than --plan with usage (exit 2)', async () => {
    const lines: string[] = [];
    expect(await main([], { write: (line) => lines.push(line) })).toBe(2);
    expect(await main(['--run'], { write: (line) => lines.push(line) })).toBe(2);
    expect(lines.join('\n')).toContain('usage:');
  });
});

describe('smoke script process (offline by construction)', () => {
  async function runSmoke(env: Record<string, string>): Promise<{ code: number; stdout: string }> {
    const proc = Bun.spawn([process.execPath, SMOKE_SCRIPT, '--plan'], {
      env,
      // Hermetic: bun auto-loads `.env` from the process cwd — run from a
      // neutral directory so only `env` decides name presence.
      cwd: tmpdir(),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const code = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    return { code, stdout };
  }

  it('runs with zero env: exit 0 and what would be required', async () => {
    const { code, stdout } = await runSmoke({
      PATH: process.env.PATH ?? '/usr/bin',
    });
    expect(code).toBe(0);
    expect(stdout).toContain('would require: ZERNIO_API_KEY');
    expect(stdout).toContain('OK: configuration coherent');
  });

  it('never prints secret values even when they are declared (NFR-001)', async () => {
    const { code, stdout } = await runSmoke({
      PATH: process.env.PATH ?? '/usr/bin',
      R2_ACCESS_KEY_ID: 'super-secret-access-123',
      R2_SECRET_ACCESS_KEY: 'super-secret-key-456',
      R2_ENDPOINT: 'https://testaccount.r2.cloudflarestorage.com',
      R2_BUCKET_NAME: 'assets-bucket',
      R2_PUBLIC_URL: 'https://cdn.example.com',
      ZERNIO_API_KEY: 'super-secret-zernio-789',
    });
    expect(code).toBe(0);
    expect(stdout).toContain('R2_ACCESS_KEY_ID=declared');
    expect(stdout).not.toContain('super-secret-access-123');
    expect(stdout).not.toContain('super-secret-key-456');
    expect(stdout).not.toContain('super-secret-zernio-789');
    expect(stdout).not.toContain('assets-bucket');
  });

  it('exits non-zero when the declared configuration is incoherent', async () => {
    const { code, stdout } = await runSmoke({
      PATH: process.env.PATH ?? '/usr/bin',
      R2_MARKETING_BUCKET_NAME: 'marketing-bucket',
    });
    expect(code).toBe(1);
    expect(stdout).toContain('half-declared marketing pair');
    expect(stdout).not.toContain('marketing-bucket');
  });
});
