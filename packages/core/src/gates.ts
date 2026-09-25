/**
 * File-based gate derivation (FR-009).
 *
 * `deriveGates` inspects the artifacts already on disk and reports each
 * production gate as `satisfied` or `pending` with the project-relative
 * evidence paths behind the verdict. There is no editable state file: dropping
 * an artifact flips its gate back to `pending`, and writing a forged state file
 * grants nothing. Invalid or unreadable artifacts make a gate `pending` (with
 * a detail message) instead of throwing, so one broken file cannot hide the
 * status of the rest.
 */
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

import { isRecord } from './guards';
import { validateProject, type VideoConfig } from './project';
import {
  SPEND_LEDGER_RELATIVE,
  validatePaidOperationRecord,
  type PaidOperationRecord,
} from './paid-operation';

export const GATE_NAMES = [
  'storyboard',
  'spend',
  'assets',
  'render',
  'qa',
  'signoff',
  'publish',
] as const;
export type GateName = (typeof GATE_NAMES)[number];
export type GateSatisfaction = 'satisfied' | 'pending';

/** Last stage of a publication journal proving the publish gate. */
export const PUBLISH_FINAL_STAGE = 'complete';

export interface GateReport {
  gate: GateName;
  status: GateSatisfaction;
  /** Project-relative artifact paths backing the verdict (inspected files). */
  evidence: string[];
  /** Why the gate is pending; only set when `status` is `pending`. */
  detail?: string;
}

export interface GatesReport {
  schemaVersion: 1;
  projectDir: string;
  /** One report per gate, in `GATE_NAMES` order. */
  gates: GateReport[];
}

interface ArtifactRead {
  exists: boolean;
  value?: unknown;
  error?: string;
}

interface ProjectArtifacts {
  manifestExists: boolean;
  config?: VideoConfig;
  configError?: string;
}

async function readJsonArtifact(path: string): Promise<ArtifactRead> {
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch (cause) {
    const enoent = cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT';
    if (enoent) return { exists: false };
    return { exists: true, error: `unreadable (${cause instanceof Error ? cause.message : String(cause)})` };
  }
  try {
    return { exists: true, value: JSON.parse(text) };
  } catch (cause) {
    return { exists: true, error: `invalid JSON (${cause instanceof Error ? cause.message : String(cause)})` };
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await fsp.stat(path)).isFile();
  } catch {
    return false;
  }
}

async function listFiles(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function listSubdirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function deriveStoryboardGate(artifacts: ProjectArtifacts): GateReport {
  const gate = 'storyboard' as const;
  const evidence = artifacts.manifestExists ? ['video.json'] : [];
  if (!artifacts.config) {
    return { gate, status: 'pending', evidence, detail: artifacts.configError ?? 'no video.json' };
  }
  const problems: string[] = [];
  const scenes = artifacts.config.scenes;
  if (scenes.length === 0) problems.push('no scenes declared');
  for (const scene of scenes) {
    if (scene.status !== 'active') problems.push(`scene "${scene.id}" is ${scene.status}`);
    if (/^\s*TODO\b/.test(scene.intent) || /^\s*TODO\b/.test(scene.narration)) {
      problems.push(`scene "${scene.id}" still has TODO text`);
    }
    if (scene.narration.trim().length === 0 && (scene.dialogue ?? []).length === 0) {
      problems.push(`scene "${scene.id}" has neither narration nor dialogue`);
    }
  }
  if (problems.length > 0) return { gate, status: 'pending', evidence, detail: problems.join('; ') };
  return { gate, status: 'satisfied', evidence };
}

async function deriveSpendGate(projectDir: string): Promise<GateReport> {
  const gate = 'spend' as const;
  const read = await readJsonArtifact(join(projectDir, SPEND_LEDGER_RELATIVE));
  const evidence = read.exists ? [SPEND_LEDGER_RELATIVE] : [];
  if (!read.exists) {
    return { gate, status: 'pending', evidence, detail: `no spend ledger at ${SPEND_LEDGER_RELATIVE}` };
  }
  if (read.error) return { gate, status: 'pending', evidence, detail: `spend ledger ${read.error}` };
  const ledger = read.value;
  if (!isRecord(ledger) || ledger.schemaVersion !== 1 || !Array.isArray(ledger.attempts)) {
    return { gate, status: 'pending', evidence, detail: 'spend ledger has an invalid shape' };
  }
  const latest = new Map<string, PaidOperationRecord>();
  try {
    for (const entry of ledger.attempts) {
      const record = validatePaidOperationRecord(entry);
      latest.set(record.attemptId, record);
    }
  } catch (cause) {
    return { gate, status: 'pending', evidence, detail: `spend ledger entry invalid (${cause instanceof Error ? cause.message : String(cause)})` };
  }
  const open = [...latest.values()].filter(
    (record) => record.state === 'uncertain' || record.state === 'submitted',
  );
  if (open.length > 0) {
    return {
      gate,
      status: 'pending',
      evidence,
      detail: `unreconciled attempts: ${open.map((record) => record.attemptId).join(', ')}`,
    };
  }
  return { gate, status: 'satisfied', evidence };
}

/** Required production artifacts per active scene (captures, narration, takes). */
function requiredSceneArtifacts(config: VideoConfig): string[] {
  const required: string[] = [];
  const active = config.scenes.filter((scene) => scene.status === 'active');
  const continuous = config.tts.mode === 'continuous';
  if (continuous && active.some((scene) => scene.narration.trim().length > 0)) {
    required.push('script/audio/narration.wav');
  }
  for (const scene of active) {
    if (!continuous && scene.narration.trim().length > 0) {
      required.push(`script/audio/${scene.id}.wav`);
    }
    if (scene.source === 'demo-app') required.push(`scenes/${scene.id}/capture.mp4`);
    if (scene.source === 'fal-video') required.push(`scenes/${scene.id}/generated.mp4`);
    if (scene.source === 'avatar') {
      required.push(`scenes/${scene.id}/avatar.mp4`);
      if (scene.avatar) required.push(scene.avatar.image, scene.avatar.audio);
    }
  }
  return [...new Set(required)];
}

async function deriveAssetsGate(projectDir: string, artifacts: ProjectArtifacts): Promise<GateReport> {
  const gate = 'assets' as const;
  const evidence = artifacts.manifestExists ? ['video.json'] : [];
  if (!artifacts.config) {
    return { gate, status: 'pending', evidence, detail: artifacts.configError ?? 'no video.json' };
  }
  const required = requiredSceneArtifacts(artifacts.config);
  const missing: string[] = [];
  for (const relative of required) {
    if (await fileExists(join(projectDir, relative))) evidence.push(relative);
    else missing.push(relative);
  }
  if (missing.length > 0) {
    return { gate, status: 'pending', evidence, detail: `missing: ${missing.join(', ')}` };
  }
  return { gate, status: 'satisfied', evidence };
}

async function deriveRenderGate(projectDir: string): Promise<GateReport> {
  const gate = 'render' as const;
  const names = await listFiles(join(projectDir, 'renders'), '.mp4');
  const evidence = names.map((name) => `renders/${name}`);
  if (names.length === 0) {
    return { gate, status: 'pending', evidence, detail: 'no rendered .mp4 in renders/' };
  }
  return { gate, status: 'satisfied', evidence };
}

async function deriveQaGate(projectDir: string): Promise<GateReport> {
  const gate = 'qa' as const;
  const read = await readJsonArtifact(join(projectDir, 'qa', 'report.json'));
  const evidence = read.exists ? ['qa/report.json'] : [];
  if (!read.exists) return { gate, status: 'pending', evidence, detail: 'no qa/report.json' };
  if (read.error) return { gate, status: 'pending', evidence, detail: `qa report ${read.error}` };
  const report = read.value;
  if (!isRecord(report) || report.schemaVersion !== 1 || !Array.isArray(report.checks)) {
    return { gate, status: 'pending', evidence, detail: 'qa report has an invalid shape' };
  }
  if (report.checks.length === 0) {
    return { gate, status: 'pending', evidence, detail: 'qa report has no checks' };
  }
  const problems: string[] = [];
  let passed = 0;
  for (const [index, check] of report.checks.entries()) {
    if (!isRecord(check) || typeof check.code !== 'string' || !check.code.trim()) {
      problems.push(`check ${index} has no code`);
      continue;
    }
    if (check.status === 'blocked') problems.push(`check "${check.code}" is blocked`);
    else if (check.status === 'pass') passed += 1;
    else if (check.status !== 'not-applicable') problems.push(`check "${check.code}" has an invalid status`);
  }
  if (passed === 0) problems.push('no passing check');
  if (problems.length > 0) return { gate, status: 'pending', evidence, detail: problems.join('; ') };
  return { gate, status: 'satisfied', evidence };
}

async function deriveSignoffGate(projectDir: string): Promise<GateReport> {
  const gate = 'signoff' as const;
  const read = await readJsonArtifact(join(projectDir, 'qa', 'reviews.json'));
  const evidence = read.exists ? ['qa/reviews.json'] : [];
  if (!read.exists) return { gate, status: 'pending', evidence, detail: 'no qa/reviews.json' };
  if (read.error) return { gate, status: 'pending', evidence, detail: `review store ${read.error}` };
  const store = read.value;
  if (!isRecord(store) || !isRecord(store.records)) {
    return { gate, status: 'pending', evidence, detail: 'review store has an invalid shape' };
  }
  const approved = Object.entries(store.records).some(([key, entry]) => {
    if (!isRecord(entry) || entry.verdict !== 'approved') return false;
    return key.startsWith('signoff:') || entry.kind === 'signoff';
  });
  if (!approved) {
    return { gate, status: 'pending', evidence, detail: 'no approved signoff record' };
  }
  return { gate, status: 'satisfied', evidence };
}

async function derivePublishGate(projectDir: string): Promise<GateReport> {
  const gate = 'publish' as const;
  const publicationDir = join(projectDir, 'qa', 'publication');
  const attempts = await listSubdirectories(publicationDir);
  const evidence: string[] = [];
  const problems: string[] = [];
  let published = false;
  for (const attempt of attempts) {
    const relative = `qa/publication/${attempt}/journal.json`;
    const read = await readJsonArtifact(join(projectDir, relative));
    if (!read.exists) {
      problems.push(`${attempt} has no journal`);
      continue;
    }
    evidence.push(relative);
    if (read.error) {
      problems.push(`${attempt} journal ${read.error}`);
      continue;
    }
    const journal = read.value;
    if (!isRecord(journal) || journal.schemaVersion !== 1 || !Array.isArray(journal.stages)) {
      problems.push(`${attempt} journal has an invalid shape`);
      continue;
    }
    if (journal.stages.includes(PUBLISH_FINAL_STAGE)) published = true;
    else problems.push(`${attempt} has not reached stage "${PUBLISH_FINAL_STAGE}"`);
  }
  if (!published) {
    const detail =
      attempts.length === 0
        ? 'no publication attempt under qa/publication/'
        : problems.join('; ') || 'no completed publication journal';
    return { gate, status: 'pending', evidence, detail };
  }
  return { gate, status: 'satisfied', evidence };
}

/**
 * Derives every gate from the artifacts under `projectDir`. Read-only: the
 * project is never locked, migrated or written.
 */
export async function deriveGates(projectDir: string): Promise<GatesReport> {
  const manifest = await readJsonArtifact(join(projectDir, 'video.json'));
  const artifacts: ProjectArtifacts = { manifestExists: manifest.exists };
  if (manifest.error) artifacts.configError = `video.json ${manifest.error}`;
  else if (!manifest.exists) artifacts.configError = 'no video.json';
  else {
    try {
      artifacts.config = validateProject(manifest.value);
    } catch (cause) {
      artifacts.configError = `video.json invalid (${cause instanceof Error ? cause.message : String(cause)})`;
    }
  }
  const gates: GateReport[] = [
    deriveStoryboardGate(artifacts),
    await deriveSpendGate(projectDir),
    await deriveAssetsGate(projectDir, artifacts),
    await deriveRenderGate(projectDir),
    await deriveQaGate(projectDir),
    await deriveSignoffGate(projectDir),
    await derivePublishGate(projectDir),
  ];
  return { schemaVersion: 1, projectDir, gates };
}
