#!/usr/bin/env bun
/**
 * `bun packages/cli/scripts/demo-dry.ts` — offline demo of the production CLI.
 *
 * Everything is driven generically through `runCli(argv)` (no handler
 * imports): scaffolds a temp project with `new`, runs `preflight`, `status`,
 * `plan`, a dry `assemble`, then a `bundle` + `hydrate` round-trip verifying
 * the sha256 evidence of every bundled file in both directions. Nothing
 * touches the network and nothing spends: commands run in plan mode wherever
 * they would spend. The temp directory is removed on exit.
 */
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256File } from '@videomaker/core';

import { runCli } from '../src/runtime';

interface Manifest {
  schemaVersion: number;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  rootHash: string;
}

async function step(name: string, argv: string[], cwd: string): Promise<void> {
  process.stdout.write(`\n== ${name}\n   $ vm ${argv.join(' ')}\n`);
  const exitCode = await runCli(argv, {
    cwd,
    out: (line) => process.stdout.write(`   ${line}\n`),
  });
  if (exitCode !== 0) {
    throw new Error(`step "${name}" exited with ${exitCode}`);
  }
}

async function verifyManifestFiles(manifest: Manifest, targetDir: string, label: string): Promise<void> {
  for (const file of manifest.files) {
    const absolute = join(targetDir, ...file.path.split('/'));
    const actual = await sha256File(absolute);
    if (actual !== file.sha256) {
      throw new Error(`${label}: SHA-256 no coincide para ${file.path}`);
    }
  }
  process.stdout.write(`   ok ${label}: ${manifest.files.length} archivos verificados (rootHash ${manifest.rootHash.slice(0, 12)}…)\n`);
}

async function main(): Promise<void> {
  const tmp = await fsp.mkdtemp(join(tmpdir(), 'vm-demo-dry-'));
  const project = join(tmp, 'proj');
  const bundleDir = join(tmp, 'bundle');
  const restoredDir = join(tmp, 'restored');
  try {
    await step(
      'scaffolding idempotente',
      ['new', '--project', project, '--product', 'demo', '--id', '01-demo', '--title', 'Demo offline'],
      tmp,
    );
    await step('preflight local (sin red)', ['preflight', '--project', project], tmp);
    await step('status: gates derivados de artefactos', ['status', '--project', project], tmp);
    await step('plan agregado del pipeline', ['plan', '--project', project], tmp);
    await step('assemble en modo plan (no renderiza, no gasta)', ['assemble', '--dry-run', '--project', project], tmp);

    await step('bundle del proyecto', ['bundle', '--project', project, '--out', bundleDir], tmp);
    const manifest = JSON.parse(await fsp.readFile(join(bundleDir, 'MANIFEST.json'), 'utf8')) as Manifest;
    await verifyManifestFiles(manifest, bundleDir, 'bundle');

    await step('hydrate en un destino limpio', ['hydrate', '--bundle', bundleDir, '--project', restoredDir], tmp);
    await verifyManifestFiles(manifest, restoredDir, 'hydrate round-trip');

    process.stdout.write('\ndemo-dry: OK (offline, sin gastos; temp dir limpiada)\n');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`demo-dry: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
