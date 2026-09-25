/**
 * Evidence (FR-011): every produced artifact is pinned by sha256, every input
 * carries its provenance (source artifact + hash) and the result keeps the
 * source contract shape (mp4 + sha256 + qa passed) so third parties can
 * verify the render byte-for-byte.
 *
 * Two artifacts live here:
 *   - `qa/report.json` — the evidence report + QA checks (core's `deriveQaGate`
 *     reads its `checks`);
 *   - `qa/loudness.json` — measured loudness/true-peak vs the gate tolerance.
 */
import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';

import { isRecord, sha256File } from '@videomaker/core';
import type { ComplianceStats, LoudnessGate } from '@videomaker/motion-remotion';

export const EVIDENCE_REPORT_RELATIVE = 'qa/report.json';
export const LOUDNESS_REPORT_RELATIVE = 'qa/loudness.json';

/** Check verdicts core's `deriveGates` understands. */
export type QaCheckStatus = 'pass' | 'blocked' | 'not-applicable';

export interface QaCheck {
  /** Stable machine code (e.g. `artifact-hashes`). */
  code: string;
  label: string;
  status: QaCheckStatus;
  /** Operator-facing detail; names the offending artifact on failure. */
  detail: string;
}

/** One produced artifact pinned by hash. */
export interface ArtifactEvidence {
  /** Project-relative path. */
  path: string;
  role: string;
  sha256: string;
  bytes: number;
}

/** One input with its provenance: the source artifact and its pinned hash. */
export interface InputProvenance {
  /** Project-relative input path. */
  path: string;
  role: string;
  sha256: string;
  /** Where the expected hash is pinned, e.g. `script/audio/narration.json#wavSha256`. */
  source: string;
}

/**
 * Source result contract shape: the render (mp4) + its sha256 + whether QA
 * passed. Third parties re-hash the mp4 and compare.
 */
export interface ResultEvidence {
  mp4: string;
  sha256: string;
  qaPassed: boolean;
  durationSeconds?: number;
}

export interface QaEvidenceReport {
  schemaVersion: 1;
  createdAt: string;
  command: 'assemble' | 'qa';
  result: ResultEvidence;
  /** sha256 of every produced artifact. */
  artifacts: ArtifactEvidence[];
  /** Provenance of every input (source artifact + hash). */
  inputs: InputProvenance[];
  checks: QaCheck[];
}

export interface LoudnessReport {
  schemaVersion: 1;
  createdAt: string;
  /** Project-relative file the measurement describes. */
  file: string;
  measured: {
    integratedLufs: number;
    loudnessRangeLu: number;
    truePeakDbtp: number;
  };
  tolerance: {
    targetLufs: number;
    lufsTolerance: number;
    targetTruePeakDbtp: number;
  };
  passed: boolean;
}

/** Atomic JSON write (tmp + rename) so a crash never leaves a torn artifact. */
export async function writeJsonArtifact(path: string, value: unknown): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, path);
}

/** Reads a JSON artifact; `undefined` when it does not exist. */
export async function readJsonArtifact(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await fsp.readFile(path, 'utf8');
  } catch (cause) {
    if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT') {
      return undefined;
    }
    throw cause;
  }
  return JSON.parse(text);
}

/** Hashes + sizes one produced artifact for the evidence report. */
export async function collectArtifactEvidence(
  projectDir: string,
  relativePath: string,
  role: string,
): Promise<ArtifactEvidence> {
  const absolute = join(projectDir, relativePath);
  const stat = await fsp.stat(absolute);
  return {
    path: relativePath,
    role,
    sha256: await sha256File(absolute),
    bytes: stat.size,
  };
}

function isQaCheckStatus(value: unknown): value is QaCheckStatus {
  return value === 'pass' || value === 'blocked' || value === 'not-applicable';
}

/** Reads `qa/report.json` and rejects shapes the QA gate could not verify. */
export async function readEvidenceReport(projectDir: string): Promise<QaEvidenceReport> {
  const raw = await readJsonArtifact(join(projectDir, EVIDENCE_REPORT_RELATIVE));
  if (raw === undefined) {
    throw new Error(
      `No evidence report at ${EVIDENCE_REPORT_RELATIVE}; run "vm assemble" first ` +
        '(the report pins every produced artifact by sha256).',
    );
  }
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.artifacts) ||
    !Array.isArray(raw.inputs) ||
    !Array.isArray(raw.checks) ||
    !isRecord(raw.result) ||
    typeof raw.result.mp4 !== 'string' ||
    typeof raw.result.sha256 !== 'string'
  ) {
    throw new Error(`${EVIDENCE_REPORT_RELATIVE} has an invalid shape; re-run "vm assemble".`);
  }
  for (const check of raw.checks) {
    if (!isRecord(check) || typeof check.code !== 'string' || !isQaCheckStatus(check.status)) {
      throw new Error(`${EVIDENCE_REPORT_RELATIVE} has an invalid check entry; re-run "vm assemble".`);
    }
  }
  return raw as unknown as QaEvidenceReport;
}

export async function writeEvidenceReport(
  projectDir: string,
  report: QaEvidenceReport,
): Promise<string> {
  const path = join(projectDir, EVIDENCE_REPORT_RELATIVE);
  await writeJsonArtifact(path, report);
  return EVIDENCE_REPORT_RELATIVE;
}

export async function writeLoudnessReport(
  projectDir: string,
  report: LoudnessReport,
): Promise<string> {
  const path = join(projectDir, LOUDNESS_REPORT_RELATIVE);
  await writeJsonArtifact(path, report);
  return LOUDNESS_REPORT_RELATIVE;
}

export async function readLoudnessReport(projectDir: string): Promise<LoudnessReport> {
  const raw = await readJsonArtifact(join(projectDir, LOUDNESS_REPORT_RELATIVE));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.tolerance)) {
    throw new Error(`${LOUDNESS_REPORT_RELATIVE} has an invalid shape; re-run "vm assemble".`);
  }
  return raw as unknown as LoudnessReport;
}

/**
 * Re-hashes every recorded artifact and compares against the evidence report.
 * One mismatch = tamper (or a lost file) and the check is `blocked` with the
 * offending paths named.
 */
export async function verifyArtifactHashes(
  projectDir: string,
  artifacts: readonly ArtifactEvidence[],
): Promise<QaCheck> {
  const problems: string[] = [];
  for (const artifact of artifacts) {
    let actual: string;
    try {
      actual = await sha256File(join(projectDir, artifact.path));
    } catch {
      problems.push(`${artifact.path} is missing or unreadable`);
      continue;
    }
    if (actual !== artifact.sha256) {
      problems.push(`${artifact.path} hash ${actual} ≠ recorded ${artifact.sha256}`);
    }
  }
  return {
    code: 'artifact-hashes',
    label: 'Produced artifacts match their recorded sha256',
    status: problems.length > 0 ? 'blocked' : 'pass',
    detail:
      problems.length > 0
        ? `hash verification failed: ${problems.join('; ')} — the artifact was modified ` +
          'after evidence was written; re-run "vm assemble" or restore the file.'
        : `${artifacts.length} artifact(s) re-hashed and verified.`,
  };
}

/** Loudness verdict vs the gate tolerance (defaults: -14 ±1 LUFS, TP ≤ -1 dBTP). */
export function loudnessCheck(
  stats: ComplianceStats,
  gate: LoudnessGate = {},
  file: string,
): QaCheck {
  const target = gate.targetLufs ?? -14;
  const tolerance = gate.lufsTolerance ?? 1;
  const targetPeak = gate.targetTruePeakDbtp ?? -1;
  const passed =
    Math.abs(stats.integratedLufs - target) <= tolerance && stats.truePeakDbtp <= targetPeak;
  return {
    code: 'loudness',
    label: 'Loudness within tolerance (ebur128)',
    status: passed ? 'pass' : 'blocked',
    detail:
      `measured I=${stats.integratedLufs.toFixed(2)} LUFS, TP=${stats.truePeakDbtp.toFixed(2)} ` +
      `dBTP on ${file} vs tolerance ${target}±${tolerance} LUFS / TP ≤ ${targetPeak} dBTP` +
      (passed
        ? ''
        : ' — normalize with "vm assemble --loudness" (loudnorm/ebur128 stage) before publishing.'),
  };
}

/** A report passes QA when nothing is blocked and at least one check passed. */
export function qaPassed(checks: readonly QaCheck[]): boolean {
  return (
    checks.some((check) => check.status === 'pass') &&
    checks.every((check) => check.status !== 'blocked')
  );
}
