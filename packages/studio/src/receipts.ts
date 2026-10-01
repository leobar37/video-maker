/**
 * Local backup evidence (contracts.md §7 key layout): pure storage-key
 * helpers shared with the R2 transport (P-004), plus structural validation
 * of a receipt against the CURRENT sealed revision — IDs, rootHash,
 * manifestKey namespace, manifestSha256 against the actual manifest bytes
 * and confirmedObjects covering every content-addressed object key.
 *
 * This is LOCAL structural evidence only: no network calls, no claim of
 * fresh live verification. A receipt is `confirmed` exclusively when it is
 * schema-valid, bound to this exact revision and complete; anything else
 * degrades to failed/local with an actionable error, never confirmed.
 */
import { readFile } from 'node:fs/promises';

import { sha256Hex, SyncReceiptSchema, type RevisionManifest, type StudioError, type SyncStatus } from '@videomaker/schemas';

import { manifestFileOf, receiptFileOf } from './paths';

/** Content-addressed object key: `objects/<sha-prefix>/<sha>` (private bucket). */
export function storageObjectKeyForSha(sha256: string): string {
  return `objects/${sha256.slice(0, 2)}/${sha256}`;
}

/** Private manifest key of one revision: the commit point of the protocol. */
export function storageManifestKey(projectId: string, assetId: string, revisionId: string): string {
  return `studio/v1/projects/${projectId}/assets/${assetId}/revisions/${revisionId}/manifest.json`;
}

/** Private checkpoint key (immutable; synced with the same protocol). */
export function storageCheckpointKey(projectId: string, checkpointId: string): string {
  return `studio/v1/projects/${projectId}/checkpoints/${checkpointId}.json`;
}

export interface BackupEvidence {
  status: SyncStatus;
  receiptVerified: boolean;
  error?: StudioError;
}

function failedEvidence(code: StudioError['code'], message: string, details?: Record<string, unknown>): BackupEvidence {
  return { status: 'failed', receiptVerified: false, error: { code, message, ...(details !== undefined ? { details } : {}) } };
}

/** Structurally validate the local receipt of one sealed revision. */
export async function evaluateRevisionBackup(
  root: string,
  ref: { projectId: string; assetId: string; revisionId: string },
  manifest: RevisionManifest,
): Promise<BackupEvidence> {
  let raw: string;
  try {
    raw = await readFile(receiptFileOf(root, ref.projectId, ref.assetId, ref.revisionId), 'utf8');
  } catch {
    return { status: 'local', receiptVerified: false };
  }

  let parsedReceipt: unknown;
  try {
    parsedReceipt = JSON.parse(raw);
  } catch {
    return failedEvidence('INVALID_INPUT', 'El receipt local no es JSON válido; respaldo no confirmado.');
  }
  const result = SyncReceiptSchema.safeParse(parsedReceipt);
  if (!result.success) {
    return failedEvidence('INVALID_INPUT', 'El receipt local viola su schema; respaldo no confirmado.', {
      issues: result.error.issues.slice(0, 5).map((issue) => issue.message),
    });
  }
  const receipt = result.data;

  if (receipt.status !== 'confirmed') {
    return {
      status: receipt.status,
      receiptVerified: false,
      ...(receipt.error !== undefined ? { error: receipt.error } : {}),
    };
  }

  if (receipt.projectId !== ref.projectId || receipt.assetId !== ref.assetId || receipt.revisionId !== ref.revisionId) {
    return failedEvidence('HASH_MISMATCH', 'El receipt confirmado no corresponde a esta revisión (ids no coinciden).', {
      receipt: `${receipt.projectId}/${receipt.assetId}/${receipt.revisionId}`,
      revision: `${ref.projectId}/${ref.assetId}/${ref.revisionId}`,
    });
  }
  if (receipt.rootHash !== manifest.rootHash) {
    return failedEvidence('HASH_MISMATCH', 'El rootHash del receipt no coincide con el manifest sellado.', {
      receiptRootHash: receipt.rootHash,
    });
  }
  const expectedManifestKey = storageManifestKey(ref.projectId, ref.assetId, ref.revisionId);
  if (receipt.manifestKey !== expectedManifestKey) {
    return failedEvidence('HASH_MISMATCH', 'El manifestKey del receipt no corresponde al namespace de esta revisión.', {
      receiptManifestKey: receipt.manifestKey,
      expectedManifestKey,
    });
  }
  let manifestBytes: Uint8Array;
  try {
    manifestBytes = new Uint8Array(await readFile(manifestFileOf(root, ref.projectId, ref.assetId, ref.revisionId)));
  } catch {
    return failedEvidence('NOT_FOUND', 'Manifest local ausente: no se puede comprobar manifestSha256 del receipt.');
  }
  const manifestSha256 = await sha256Hex(manifestBytes);
  if (receipt.manifestSha256 !== manifestSha256) {
    return failedEvidence('HASH_MISMATCH', 'manifestSha256 del receipt no coincide con los bytes del manifest local.', {});
  }
  const confirmedKeys = new Set(receipt.confirmedObjects);
  const missingObjects = [
    ...new Set(manifest.files.map((file) => storageObjectKeyForSha(file.sha256))),
  ]
    .filter((key) => !confirmedKeys.has(key))
    .sort();
  if (missingObjects.length > 0) {
    return failedEvidence('HASH_MISMATCH', 'El receipt confirmado no cubre todos los objetos de la revisión.', {
      missingCount: missingObjects.length,
      missingObjects: missingObjects.slice(0, 10),
    });
  }
  if (receipt.error !== undefined) {
    return failedEvidence('INVALID_INPUT', 'Receipt confirmado con error contradictorio; respaldo no confirmado.');
  }
  return { status: 'confirmed', receiptVerified: true };
}
