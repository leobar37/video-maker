/**
 * `persistSpecs` — declarative persistence commands (FR-012, FR-013).
 *
 * Verbs: `bundle` (content-addressed packaging), `hydrate` (hash-verified
 * restore) and `archive` (binary offload to object storage + provenance).
 * All three honor plan mode: `plan()` is pure planning (local reads only — no
 * network, no credential resolution, NFR-002) and `run()` refuses outright
 * when `ctx.mode === 'plan'`.
 *
 * Convention: every project-scoped command takes optional `--project`
 * (default '.') and resolves project-internal paths with the
 * `@videomaker/core` containment helpers (`resolveInsideProject`).
 */
import { resolve } from 'node:path';

import { PathTraversalError, resolveInsideProject } from '@videomaker/core';

import type {
  CommandArgSpec,
  CommandResult,
  CommandRunContext,
  CommandSpec,
  PlanStep,
} from '../spec-types';
import {
  buildBundle,
  computeArchiveInventory,
  computeBundleInventory,
  defaultBundleDir,
  hydrateBundle,
  PersistError,
  readBundleManifest,
  resolveArchiveStorage,
  runArchive,
  ARCHIVE_MANIFEST_REL,
} from '../persist';
import { archiveTargetOf } from '../persist/r2-wiring';

const PROJECT_ARG: CommandArgSpec = {
  name: 'project',
  kind: 'string',
  default: '.',
  description: 'Project directory (resolved against the invocation cwd).',
};

/** Maps persistence refusals to `ctx.fail` (exit != 0, actionable message). */
function refused(ctx: CommandRunContext, error: unknown): never {
  if (error instanceof PersistError || error instanceof PathTraversalError) {
    return ctx.fail(error.message);
  }
  throw error;
}

function stringArg(ctx: CommandRunContext, name: string): string {
  const value = ctx.args[name];
  if (value !== undefined && typeof value !== 'string') {
    return ctx.fail(`--${name} must be a string.`);
  }
  return value ?? '';
}

function projectDirOf(ctx: CommandRunContext): string {
  return resolve(ctx.cwd, stringArg(ctx, 'project') || '.');
}

function bundleDirOf(ctx: CommandRunContext): string {
  const bundle = stringArg(ctx, 'bundle');
  if (!bundle) {
    return ctx.fail('--bundle is required (the bundle directory holding MANIFEST.json).');
  }
  return resolve(ctx.cwd, bundle);
}

export const bundleSpec: CommandSpec = {
  verb: 'bundle',
  summary:
    'Package a project content-addressed: file copies + sealed MANIFEST.json (files, rootHash).',
  args: [
    PROJECT_ARG,
    {
      name: 'out',
      kind: 'string',
      description:
        'Bundle output dir (default: <project>/../bundles/<slug>-<rootHashPrefix>/). Must live outside the project.',
    },
  ],
  supportsPlan: true,
  writes: ['<out>/MANIFEST.json', '<out>/<project-relative files>'],
  movesGates: [],

  async plan(ctx: CommandRunContext): Promise<PlanStep[]> {
    try {
      const projectDir = projectDirOf(ctx);
      const inventory = await computeBundleInventory(projectDir);
      const outArg = stringArg(ctx, 'out');
      const outDir = outArg ? resolve(ctx.cwd, outArg) : defaultBundleDir(projectDir, inventory.rootHash);
      return bundleSteps(projectDir, outDir, inventory.rootHash, inventory.files.length);
    } catch (error) {
      return refused(ctx, error);
    }
  },

  async run(ctx: CommandRunContext): Promise<CommandResult> {
    if (ctx.mode === 'plan') {
      return ctx.fail('bundle refuses to execute in plan mode (NFR-002): drop --plan/--dry-run to write the bundle.');
    }
    try {
      const projectDir = projectDirOf(ctx);
      const outArg = stringArg(ctx, 'out');
      const result = await buildBundle(projectDir, outArg ? { outDir: resolve(ctx.cwd, outArg) } : {});
      ctx.out(
        `bundled ${result.fileCount} files (${result.totalBytes} bytes) into ${result.outDir} ` +
          `(rootHash ${result.manifest.rootHash})`,
      );
      return {
        exitCode: 0,
        planned: bundleSteps(projectDir, result.outDir, result.manifest.rootHash, result.fileCount),
      };
    } catch (error) {
      return refused(ctx, error);
    }
  },
};

function bundleSteps(
  projectDir: string,
  outDir: string,
  rootHash: string,
  fileCount: number,
): PlanStep[] {
  return [
    {
      action: `hash ${fileCount} project files under ${projectDir} (exclusion policy applied)`,
      target: projectDir,
    },
    { action: `copy ${fileCount} files into the bundle dir`, target: outDir },
    {
      action: `seal MANIFEST.json (rootHash ${rootHash})`,
      target: resolve(outDir, 'MANIFEST.json'),
      writes: 'MANIFEST.json',
    },
  ];
}

export const hydrateSpec: CommandSpec = {
  verb: 'hydrate',
  summary:
    'Restore a project FROM a bundle into a target dir, verifying every file hash + rootHash first.',
  args: [
    {
      name: 'bundle',
      kind: 'string',
      required: true,
      description: 'Bundle directory holding MANIFEST.json (produced by `vm bundle`).',
    },
    PROJECT_ARG,
  ],
  supportsPlan: true,
  writes: ['<project>/<sealed files restored from the bundle>'],
  movesGates: [],

  async plan(ctx: CommandRunContext): Promise<PlanStep[]> {
    try {
      const bundleDir = bundleDirOf(ctx);
      const manifest = await readBundleManifest(bundleDir);
      const targetDir = projectDirOf(ctx);
      return [
        {
          action: `verify ${manifest.files.length} sealed files + rootHash ${manifest.rootHash} against MANIFEST.json`,
          target: bundleDir,
        },
        {
          action: `restore ${manifest.files.length} files (${manifest.files.reduce((sum, f) => sum + f.bytes, 0)} bytes); mismatches abort with the target untouched`,
          target: targetDir,
        },
      ];
    } catch (error) {
      return refused(ctx, error);
    }
  },

  async run(ctx: CommandRunContext): Promise<CommandResult> {
    if (ctx.mode === 'plan') {
      return ctx.fail('hydrate refuses to execute in plan mode (NFR-002): drop --plan/--dry-run to restore.');
    }
    try {
      const bundleDir = bundleDirOf(ctx);
      const targetDir = projectDirOf(ctx);
      const result = await hydrateBundle(bundleDir, targetDir);
      ctx.out(
        `hydrated ${result.fileCount} files into ${result.targetDir} ` +
          `(${result.restored.length} written, ${result.unchanged.length} already current)`,
      );
      return { exitCode: 0, planned: [] };
    } catch (error) {
      return refused(ctx, error);
    }
  },
};

export const archiveSpec: CommandSpec = {
  verb: 'archive',
  summary:
    'Upload regenerable/large binaries to object storage (content-addressed keys) and seal provenance in qa/archive.json.',
  args: [PROJECT_ARG],
  supportsPlan: true,
  writes: [ARCHIVE_MANIFEST_REL],
  movesGates: [],

  async plan(ctx: CommandRunContext): Promise<PlanStep[]> {
    try {
      const projectDir = projectDirOf(ctx);
      const inventory = await computeArchiveInventory(projectDir);
      const steps: PlanStep[] = inventory.map((object) => ({
        action: `upload ${object.path} (${object.bytes} bytes) as ${object.contentType}`,
        target: object.key,
      }));
      steps.push({
        action: `seal provenance (${inventory.length} objects: key ↔ path ↔ sha256)`,
        target: await resolveInsideProject(projectDir, ...ARCHIVE_MANIFEST_REL.split('/')),
        writes: ARCHIVE_MANIFEST_REL,
      });
      return steps;
    } catch (error) {
      return refused(ctx, error);
    }
  },

  async run(ctx: CommandRunContext): Promise<CommandResult> {
    if (ctx.mode === 'plan') {
      return ctx.fail('archive refuses to execute in plan mode (NFR-002): drop --plan/--dry-run to upload.');
    }
    try {
      const projectDir = projectDirOf(ctx);
      const storage = await resolveArchiveStorage();
      const target = archiveTargetOf(storage);
      // Output only (no behavior change): say WHERE objects go before uploading.
      ctx.out(
        target
          ? `target: s3://${target.bucket} via ${target.endpointHost} — keys ` +
              `${target.keyPrefix}/<sha256[0:2]>/<sha256>, served ${target.publicUrlPolicy}`
          : 'target: object store (content-addressed keys)',
      );
      const result = await runArchive(projectDir, storage);
      ctx.out(
        `archived ${result.objects.length} binaries (${result.totalBytes} bytes): ` +
          `${result.uploaded.length} uploaded, ${result.skipped.length} already stored; ` +
          `provenance in ${result.manifestPath}`,
      );
      for (const object of result.objects) {
        ctx.out(`  ${object.key}  <-  ${object.path}`);
      }
      return {
        exitCode: 0,
        planned: result.objects.map((object) => ({
          action: `stored ${object.path} (${object.bytes} bytes)`,
          target: object.key,
        })),
      };
    } catch (error) {
      return refused(ctx, error);
    }
  },
};

/** All persistence commands, in registry order. */
export const persistSpecs: CommandSpec[] = [bundleSpec, hydrateSpec, archiveSpec];
