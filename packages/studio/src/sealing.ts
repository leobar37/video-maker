/**
 * Sealing of selected files into a staging directory: hash the bytes, verify
 * optional declared hashes and output signatures, write the staged copy, then
 * re-read the source to detect files that change while the revision is being
 * sealed (contracts.md §4). The `io.read` seam exists for deterministic tests
 * of that mutation check; it is not part of the frozen service contract.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  canonicalStudioJson,
  CreativeAssetSchema,
  isSafeRelativeFilePath,
  PresetVersionSchema,
  sha256Hex,
  type CreativeAsset,
  type PresetVersion,
  type SnapshotFile,
} from '@videomaker/schemas';

import { fail } from './errors';
import { writeBytesFile } from './jsonio';
import { inferMediaTypeFromPath, signatureMismatch } from './media';
export type SnapshotRole = SnapshotFile['role'];


export interface SealEntry {
  /** Path inside the portable snapshot space (unique across the revision). */
  snapshotPath: string;
  /** Absolute source path on disk. */
  absolutePath: string;
  role: SnapshotRole;
  /** Declared media type when there is one (e.g. an OutputSpec). */
  mediaType?: string;
  /** Verify leading bytes against the declared media type when verifiable. */
  verifySignature?: boolean;
  /** Declared content hash (preset resources); mismatch fails the seal. */
  expectedSha256?: string;
}

export interface SealIo {
  read?: (absolutePath: string) => Promise<Uint8Array>;
}

async function defaultRead(absolutePath: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(absolutePath));
}

function bySnapshotPath(a: SealEntry, b: SealEntry): number {
  return a.snapshotPath < b.snapshotPath ? -1 : a.snapshotPath > b.snapshotPath ? 1 : 0;
}

export async function sealEntries(entries: Iterable<SealEntry>, filesDir: string, io: SealIo = {}): Promise<SnapshotFile[]> {
  const read = io.read ?? defaultRead;
  const sealed: SnapshotFile[] = [];
  for (const entry of [...entries].sort(bySnapshotPath)) {
    if (!isSafeRelativeFilePath(entry.snapshotPath)) {
      fail('PATH_UNSAFE', 'Ruta de snapshot insegura.', { path: entry.snapshotPath });
    }
    const bytes = await read(entry.absolutePath);
    const sha256 = await sha256Hex(bytes);
    if (entry.expectedSha256 !== undefined && sha256 !== entry.expectedSha256) {
      fail('HASH_MISMATCH', 'El archivo no coincide con el hash declarado por su preset.', {
        path: entry.snapshotPath,
        declaredSha256: entry.expectedSha256,
      });
    }
    const declaredMediaType = entry.mediaType ?? inferMediaTypeFromPath(entry.snapshotPath);
    if (entry.verifySignature === true) {
      const mismatch = signatureMismatch(declaredMediaType, bytes);
      if (mismatch !== null) {
        fail('INVALID_INPUT', 'La firma del output no corresponde al tipo declarado.', {
          path: entry.snapshotPath,
          expected: mismatch.expected,
          detected: mismatch.detected ?? 'desconocido',
        });
      }
    }
    await writeBytesFile(path.join(filesDir, entry.snapshotPath), bytes);
    const rechecked = await sha256Hex(await read(entry.absolutePath));
    if (rechecked !== sha256) {
      fail('CONFLICT', 'El archivo cambió mientras se sellaba la revisión.', { path: entry.snapshotPath });
    }
    sealed.push({
      path: entry.snapshotPath,
      sha256,
      bytes: bytes.byteLength,
      mediaType: declaredMediaType,
      role: entry.role,
    });
  }
  return sealed;
}

/**
 * Frozen-metadata guard: the parsed asset/preset snapshots embedded in the
 * manifest must still correspond to the staged JSON bytes right before
 * committing. If the document changed on disk between load and seal, fail
 * CONFLICT instead of sealing old parsed metadata next to new JSON bytes.
 * Canonical comparison tolerates harmless reformatting (key order/whitespace).
 */
export async function verifySealedMetadata(
  filesDir: string,
  asset: CreativeAsset,
  presets: PresetVersion[],
): Promise<void> {
  const stagedAssetBytes = await readFile(path.join(filesDir, 'asset.json'));
  const stagedAsset = CreativeAssetSchema.safeParse(JSON.parse(new TextDecoder().decode(stagedAssetBytes)));
  if (!stagedAsset.success || canonicalStudioJson(stagedAsset.data) !== canonicalStudioJson(asset)) {
    fail('CONFLICT', 'asset.json cambió entre la carga y el sellado; el manifest no sella metadata desactualizada.', {
      document: 'asset.json',
    });
  }
  for (const preset of presets) {
    const stagedPath = path.join(filesDir, 'presets', preset.presetId, preset.versionId, 'preset.json');
    const stagedPreset = PresetVersionSchema.safeParse(JSON.parse(new TextDecoder().decode(await readFile(stagedPath))));
    if (!stagedPreset.success || canonicalStudioJson(stagedPreset.data) !== canonicalStudioJson(preset)) {
      fail('CONFLICT', 'preset.json cambió entre la carga y el sellado; el manifest no sella metadata desactualizada.', {
        document: `presets/${preset.presetId}/${preset.versionId}/preset.json`,
      });
    }
  }
}
