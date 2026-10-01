/**
 * Shared fixtures for the studio suites: a temp workspace with a
 * deterministic context (sequential ids, advancing clock) and helpers to
 * place asset/preset files exactly where the layout expects them.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { expect } from 'bun:test';

import type { StudioContext } from './contracts';
import { StudioServiceError, isStudioServiceError } from './errors';

const CLOCK_BASE = Date.UTC(2026, 8, 30, 12, 0, 0);

export interface TestWorkspace {
  root: string;
  ctx: StudioContext;
  cleanup: () => Promise<void>;
}

/** Deterministic ids (`t001`, `t002`, …) and a clock advancing one minute per id. */
export function makeTestContext(workspaceDir: string): StudioContext {
  let seq = 0;
  return {
    workspaceDir,
    clock: () => new Date(CLOCK_BASE + seq * 60_000),
    newId: () => `t${String(++seq).padStart(3, '0')}`,
  };
}

export async function makeTestWorkspace(prefix: string): Promise<TestWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return { root, ctx: makeTestContext(root), cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Assert the call rejects with the exact public error code. */
export async function assertServiceError(code: StudioServiceError['code'], run: () => Promise<unknown>): Promise<StudioServiceError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(isStudioServiceError(caught)).toBe(true);
  const serviceError = caught as StudioServiceError;
  expect(serviceError.code).toBe(code);
  return serviceError;
}

/** Write a file inside `projects/<p>/assets/<a>/<rel>` creating parents. */
export async function writeAssetFile(root: string, projectId: string, assetId: string, rel: string, content: string | Uint8Array): Promise<string> {
  const abs = path.join(root, 'projects', projectId, 'assets', assetId, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return abs;
}

/** Write a resource of a preset version (agents place files after creation). */
export async function writePresetResource(root: string, presetId: string, versionId: string, rel: string, content: string | Uint8Array): Promise<string> {
  const abs = path.join(root, 'presets', presetId, 'versions', versionId, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content);
  return abs;
}

/** Agent-style direct edit of asset.json (the open workshop way). */
export async function editAssetJson(root: string, projectId: string, assetId: string, mutate: (asset: Record<string, unknown>) => void): Promise<void> {
  const abs = path.join(root, 'projects', projectId, 'assets', assetId, 'asset.json');
  const doc = JSON.parse(await readFile(abs, 'utf8')) as Record<string, unknown>;
  mutate(doc);
  await writeFile(abs, `${JSON.stringify(doc, null, 2)}\n`);
}
