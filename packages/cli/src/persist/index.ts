/**
 * Portable persistence (FR-012): content-addressed `bundle`, hash-verified
 * `hydrate`, object-storage `archive`. Pure local logic here; the declarative
 * command specs live in `../specs/persist`.
 */
export { PersistError } from './errors';
export {
  ARCHIVABLE_EXTENSIONS,
  assertNotSecretPath,
  contentTypeFor,
  isArchivableBinary,
  isExcludedPath,
} from './policy';
export { collectProjectFiles, type CollectedFile } from './walk';
export {
  computeRootHash,
  MANIFEST_NAME,
  MANIFEST_SCHEMA_VERSION,
  parseManifest,
  serializeManifest,
  assertSafeRelativePath,
  type BundleFileEntry,
  type BundleManifest,
} from './manifest';
export {
  buildBundle,
  computeBundleInventory,
  defaultBundleDir,
  sanitizeSlug,
  type BundleBuildResult,
  type BundleInventory,
} from './bundle';
export { hydrateBundle, readBundleManifest, type HydrateResult } from './hydrate';
export {
  archiveKeyFor,
  ARCHIVE_MANIFEST_REL,
  ARCHIVE_MANIFEST_SCHEMA_VERSION,
  computeArchiveInventory,
  DEFAULT_KEY_PREFIX,
  runArchive,
  serializeArchiveManifest,
  type ArchiveManifest,
  type ArchiveObjectPlan,
  type ArchiveObjectRecord,
  type ArchiveRunResult,
} from './archive';
export {
  resetArchiveStorageSource,
  resolveArchiveStorage,
  setArchiveStorageSource,
  type ArchiveStorage,
  type ArchiveStorageSource,
} from './storage-seam';
