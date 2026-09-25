/**
 * NFR-001 secret self-check: scans the project's produced artifacts (qa/,
 * journals, project JSON, script metadata, bundles) for plausible secret
 * assignments, like the phase grep
 * `(fal_key|zernio|elevenlabs|secret)[=:][^ ]` but also covering names such
 * as `ELEVENLABS_API_KEY=`/`ZERNIO_API_KEY=` (the bare phase pattern misses
 * those suffixes).
 *
 * Findings NEVER carry the value: only file, line and the key NAME, rendered
 * as `KEY=<redacted>` — the same redaction discipline as
 * `@videomaker/credentials`. Values stay unread in the output.
 */
import { promises as fsp } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Key-name stem followed by an assignment; the value is never retained. */
const SECRET_ASSIGNMENT = /\b([\w.-]*(?:fal[_-]?key|zernio|elevenlabs|secret)[\w.-]*)\s*[=:]\s*[^\s"']+/gi;

/** Artifacts are text or binary; only text files can leak a printable secret. */
const TEXT_EXTENSIONS: Record<string, true> = {
  '.json': true,
  '.md': true,
  '.txt': true,
  '.log': true,
  '.csv': true,
  '.tsv': true,
  '.yml': true,
  '.yaml': true,
  '.env': true,
};

const BINARY_EXTENSIONS: Record<string, true> = {
  '.png': true,
  '.jpg': true,
  '.jpeg': true,
  '.gif': true,
  '.webp': true,
  '.mp4': true,
  '.mov': true,
  '.webm': true,
  '.m4v': true,
  '.wav': true,
  '.mp3': true,
  '.m4a': true,
  '.aac': true,
  '.pdf': true,
  '.zip': true,
  '.ttf': true,
  '.woff': true,
  '.woff2': true,
};

/** Files above this size are never artifacts worth scanning line by line. */
const MAX_SCANNABLE_BYTES = 4 * 1024 * 1024;

export interface SecretFinding {
  /** Project-relative path of the offending file. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Key NAME matched (never its value). */
  key: string;
  /** Safe rendering for logs: `KEY=<redacted>`. */
  redacted: string;
}

export interface SecretScanReport {
  files: string[];
  findings: SecretFinding[];
  ok: boolean;
}

/** One-line findings for logs; the matched value is never printed. */
export function formatSecretFindings(findings: readonly SecretFinding[]): string[] {
  return findings.map(
    (finding) => `  ${finding.file}:${finding.line} ${finding.redacted} (value redacted)`,
  );
}

/**
 * Detects plausible secret assignments in one text blob. Findings expose the
 * key name and position only — the value is dropped inside the matcher.
 */
export function scanTextForSecrets(text: string): Array<Omit<SecretFinding, 'file'>> {
  const findings: Array<Omit<SecretFinding, 'file'>> = [];
  const lines = text.split('\n');
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  for (const match of text.matchAll(SECRET_ASSIGNMENT)) {
    const at = match.index ?? 0;
    let line = 0;
    while (line + 1 < offsets.length && (offsets[line + 1] as number) <= at) line += 1;
    const key = (match[1] ?? '').toUpperCase();
    findings.push({
      line: line + 1,
      key,
      redacted: `${key}=<redacted>`,
    });
  }
  return findings;
}

/** Whether a path is a scannable text artifact (binary media is skipped). */
export function isScannableTextPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  const extension = dot === -1 ? '' : name.slice(dot).toLowerCase();
  if (extension === '') return true;
  if (BINARY_EXTENSIONS[extension] === true) return false;
  return TEXT_EXTENSIONS[extension] === true;
}

const ROOT_TARGETS = ['qa', 'script', 'scenes', 'assets', 'bundles'] as const;

async function collectScannableFiles(projectDir: string, root: string, acc: string[]): Promise<void> {
  const absoluteRoot = join(projectDir, ...root.split('/'));
  let entries: Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
  try {
    entries = await fsp.readdir(absoluteRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRelative = root.length > 0 ? `${root}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.cache') continue;
      await collectScannableFiles(projectDir, childRelative, acc);
    } else if (entry.isFile() && isScannableTextPath(childRelative)) {
      acc.push(childRelative);
    }
  }
}

/**
 * Scans every produced artifact of a project: `qa/` (evidence, journals,
 * spend ledger), `script/`/`scenes/`/`assets/` metadata, `bundles/` and the
 * project-root JSON (video.json). Binary media is skipped on purpose.
 */
export async function scanProjectSecrets(projectDir: string): Promise<SecretScanReport> {
  const targets: string[] = [];
  await collectScannableFiles(projectDir, '', targets);
  const files: string[] = [];
  const findings: SecretFinding[] = [];
  for (const fileRelative of targets) {
    const underTarget =
      ROOT_TARGETS.some((root) => fileRelative === root || fileRelative.startsWith(`${root}/`)) ||
      (fileRelative.endsWith('.json') && !fileRelative.includes(sep) && !fileRelative.includes('/'));
    if (!underTarget) continue;
    const absolute = join(projectDir, ...fileRelative.split('/'));
    const stat = await fsp.stat(absolute);
    if (stat.size > MAX_SCANNABLE_BYTES) continue;
    const text = await fsp.readFile(absolute, 'utf8');
    if (text.includes('\u0000')) continue; // binary payload with a text extension
    files.push(fileRelative);
    for (const finding of scanTextForSecrets(text)) {
      findings.push({ ...finding, file: fileRelative.split(sep).join('/') });
    }
  }
  return { files, findings, ok: findings.length === 0 };
}

/** Project-relative rendering of an absolute path (display only). */
export function displayPath(projectDir: string, absolute: string): string {
  return relative(projectDir, absolute).split(sep).join('/');
}
