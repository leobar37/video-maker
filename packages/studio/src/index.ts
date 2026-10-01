/**
 * `@videomaker/studio` — file-based services of the creative workspace
 * (P-002) plus the backup-protocol services of P-004 (`sync.ts`), which are
 * storage-injected: the package itself never touches the network.
 */
import { buildStudioCatalog } from './catalog';
import type { StudioServices } from './contracts';
import { createStudioContext } from './context';
import {
  createClient,
  createCreativeAsset,
  createCreativeProject,
  createPresetVersion,
  getClient,
  getCreativeProject,
  getPresetVersion,
  inspectCreativeAsset,
  listClients,
  listCreativeProjects,
  listPresetVersions,
} from './workspace';
import {
  createProjectCheckpoint,
  diffAssetRevisions,
  getRevisionManifest,
  listAssetRevisions,
  restoreAssetRevision,
  snapshotAsset,
} from './snapshot';
import {
  listAllKeys,
  objectKeysOf,
  parseRevisionFromManifestKey,
  recoverProjectFromStorage,
  syncProject,
  verifyProjectBackup,
} from './sync';

export * from './contracts';
export { StudioServiceError, isStudioServiceError } from './errors';
export { createStudioContext, type StudioContextOverrides } from './context';
export { storageCheckpointKey, storageManifestKey, storageObjectKeyForSha } from './receipts';
export {
  buildStudioCatalog,
  createClient,
  createCreativeAsset,
  createCreativeProject,
  createPresetVersion,
  createProjectCheckpoint,
  diffAssetRevisions,
  getClient,
  getCreativeProject,
  getPresetVersion,
  getRevisionManifest,
  inspectCreativeAsset,
  listAssetRevisions,
  listAllKeys,
  listClients,
  listCreativeProjects,
  listPresetVersions,
  objectKeysOf,
  parseRevisionFromManifestKey,
  recoverProjectFromStorage,
  restoreAssetRevision,
  snapshotAsset,
  syncProject,
  verifyProjectBackup,
};

/** Keys of `StudioServices` implemented in this package (all of them: the
 * backup services are storage-injected, so they stay network-free here). */
export type LocalStudioServiceKeys =
  | 'createClient'
  | 'listClients'
  | 'getClient'
  | 'createPresetVersion'
  | 'listPresetVersions'
  | 'getPresetVersion'
  | 'createCreativeProject'
  | 'listCreativeProjects'
  | 'getCreativeProject'
  | 'createCreativeAsset'
  | 'inspectCreativeAsset'
  | 'snapshotAsset'
  | 'listAssetRevisions'
  | 'getRevisionManifest'
  | 'diffAssetRevisions'
  | 'restoreAssetRevision'
  | 'createProjectCheckpoint'
  | 'syncProject'
  | 'verifyProjectBackup'
  | 'recoverProjectFromStorage'
  | 'buildStudioCatalog';

/** Bundle for the declarative CLI adapters (P-003). */
export const localStudioServices: Pick<StudioServices, LocalStudioServiceKeys> = {
  createClient,
  listClients,
  getClient,
  createPresetVersion,
  listPresetVersions,
  getPresetVersion,
  createCreativeProject,
  listCreativeProjects,
  getCreativeProject,
  createCreativeAsset,
  inspectCreativeAsset,
  snapshotAsset,
  listAssetRevisions,
  getRevisionManifest,
  diffAssetRevisions,
  restoreAssetRevision,
  createProjectCheckpoint,
  syncProject,
  verifyProjectBackup,
  recoverProjectFromStorage,
  buildStudioCatalog,
};
