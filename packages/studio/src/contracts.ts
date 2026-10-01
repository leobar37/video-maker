/**
 * `@videomaker/studio` — public service contracts frozen by P-001
 * (contracts.md §5). TYPES ONLY: the file-based services land in P-002,
 * the R2 transport in P-004 and the CLI adapters in P-003. This module
 * deliberately contains no implementations, so nothing here can promise
 * success it cannot deliver.
 *
 * Conventions:
 * - Every service takes `ctx` first and a typed input object second.
 * - Every service fails by throwing a `StudioServiceError` (stable code,
 *   human message, redacted details); it never returns partial objects
 *   with a confirmed state.
 * - The schemas of `@videomaker/schemas` are the single representation of
 *   persisted data; these signatures derive from them and never invent a
 *   parallel one.
 */
import type {
  CreativeAsset,
  CreativeProject,
  EditorialStatus,
  OutputSpec,
  PresetIdentity,
  PresetRef,
  PresetResource,
  PresetVersion,
  PresetVisualRef,
  ProjectCheckpoint,
  Recipe,
  RevisionManifest,
  SnapshotFile,
  StudioCatalog,
  StudioClient,
  StudioError,
  SyncReceipt,
  SyncStatus,
} from '@videomaker/schemas';

export type {
  CreativeAsset,
  CreativeProject,
  EditorialStatus,
  ManifestOutputRef,
  OutputSpec,
  PresetIdentity,
  PresetRef,
  PresetResource,
  PresetVersion,
  PresetVisualRef,
  ProjectCheckpoint,
  Recipe,
  RevisionManifest,
  SnapshotFile,
  StudioCatalog,
  StudioCatalogEntry,
  StudioCatalogOutput,
  StudioClient,
  StudioError,
  StudioErrorCode,
  SyncReceipt,
  SyncStatus,
} from '@videomaker/schemas';

// ---------------------------------------------------------------------------
// Context, references and storage port
// ---------------------------------------------------------------------------

/** Execution context: workspace root, injectable clock and id factory. */
export interface StudioContext {
  workspaceDir: string;
  clock: () => Date;
  newId: () => string;
}

/** Points at exactly one revision of one asset of one project. */
export interface RevisionRef {
  projectId: string;
  assetId: string;
  revisionId: string;
}

/** Metadata of one immutable storage object (SHA-256, never an ETag). */
export interface ObjectMeta {
  key: string;
  bytes: number;
  sha256: string;
  etag?: string;
}

/**
 * Storage port injected into sync/verify/recover. `putImmutable` must make
 * create/inmutability verifiable with the real API; same key with different
 * bytes is a CONFLICT, not an overwrite.
 */
export interface StudioStorage {
  head(key: string): Promise<ObjectMeta | null>;
  putImmutable(key: string, bytes: Uint8Array, mediaType: string): Promise<ObjectMeta>;
  get(key: string): Promise<Uint8Array>;
  list(prefix: string, cursor?: string): Promise<{ keys: string[]; nextCursor?: string }>;
}

/** Public failure shape thrown by every service. `details` must be redacted. */
export interface StudioServiceError extends StudioError {
  readonly cause?: unknown;
}

// ---------------------------------------------------------------------------
// Inspection, history and diff projections (read-only, never just an id/URL)
// ---------------------------------------------------------------------------

/** Presence of one declared path inside the asset directory. */
export interface AssetPathStatus {
  path: string;
  present: boolean;
}

/** Preset reference resolved to its exact version, or null when missing. */
export interface ResolvedPresetRef extends PresetRef {
  preset: PresetVersion | null;
}

/** Declared output plus whether its file currently exists on disk. */
export interface OutputStatus extends OutputSpec {
  present: boolean;
}

/** One revision of the asset history (summary projection of a manifest). */
export interface RevisionSummary {
  revisionId: string;
  parentRevisionId?: string;
  createdAt: string;
  note: string;
  editorialStatus: EditorialStatus;
  rootHash: string;
}

/** What `inspectCreativeAsset` returns: real paths, exact presets, state. */
export interface AssetInspection {
  asset: CreativeAsset;
  assetDir: string;
  sources: AssetPathStatus[];
  inputs: AssetPathStatus[];
  presets: ResolvedPresetRef[];
  outputs: OutputStatus[];
  recipe?: Recipe;
  history: RevisionSummary[];
  sync: Array<{ revisionId: string; status: SyncStatus }>;
}

/** Added/removed/modified name sets; no AI, no semantic pixel comparison. */
export interface NameSetChange {
  added: string[];
  removed: string[];
  modified: string[];
}

/** How the optional recipe changed between two revisions. */
export type RecipeChange = 'unchanged' | 'added' | 'removed' | 'modified';

/** Result of `diffAssetRevisions`. */
export interface RevisionDiff {
  from: { revisionId: string; rootHash: string };
  to: { revisionId: string; rootHash: string };
  files: NameSetChange;
  outputs: NameSetChange;
  presets: NameSetChange;
  recipe: RecipeChange;
}

// ---------------------------------------------------------------------------
// Service inputs
// ---------------------------------------------------------------------------

export interface CreateClientInput {
  id: string;
  name: string;
  presetRefs?: PresetRef[];
  metadata?: Record<string, unknown>;
}

/**
 * `versionId` is always assigned by the service (`ctx.newId()`): creating a
 * preset never edits a previous version.
 */
export interface CreatePresetVersionInput {
  presetId: string;
  clientId: string;
  name: string;
  identity?: PresetIdentity;
  resources?: PresetResource[];
  visualRefs?: PresetVisualRef[];
}

/**
 * Creating an asset requires no outputs and no recipe: the agent declares
 * paths later by editing `asset.json` directly.
 */
export interface CreateCreativeAssetInput {
  id: string;
  projectId: string;
  kind: CreativeAsset['kind'];
  title?: string;
  presetRefs?: PresetRef[];
}

export interface CatalogFilter {
  clientId?: string;
  projectId?: string;
  assetId?: string;
  kind?: string;
}

// ---------------------------------------------------------------------------
// The frozen public API of the studio package
// ---------------------------------------------------------------------------

export interface StudioServices {
  // Identity: clients and versioned brand presets
  createClient(ctx: StudioContext, input: CreateClientInput): Promise<StudioClient>;
  listClients(ctx: StudioContext): Promise<StudioClient[]>;
  getClient(ctx: StudioContext, input: { id: string }): Promise<StudioClient>;
  createPresetVersion(ctx: StudioContext, input: CreatePresetVersionInput): Promise<PresetVersion>;
  listPresetVersions(ctx: StudioContext, input: { presetId?: string }): Promise<PresetVersion[]>;
  getPresetVersion(ctx: StudioContext, input: { presetId: string; versionId: string }): Promise<PresetVersion>;

  // Independent projects and open assets
  createCreativeProject(ctx: StudioContext, input: { id: string; name: string; clientIds?: string[] }): Promise<CreativeProject>;
  listCreativeProjects(ctx: StudioContext): Promise<CreativeProject[]>;
  getCreativeProject(ctx: StudioContext, input: { id: string }): Promise<CreativeProject>;
  createCreativeAsset(ctx: StudioContext, input: CreateCreativeAssetInput): Promise<CreativeAsset>;
  inspectCreativeAsset(ctx: StudioContext, input: { projectId: string; assetId: string }): Promise<AssetInspection>;

  // Revisions: seal, history, diff, restore (never re-render, never network)
  snapshotAsset(ctx: StudioContext, input: { projectId: string; assetId: string; note: string }): Promise<{ revision: RevisionManifest; manifestPath: string }>;
  listAssetRevisions(ctx: StudioContext, input: { projectId: string; assetId: string }): Promise<RevisionSummary[]>;
  getRevisionManifest(ctx: StudioContext, ref: RevisionRef): Promise<RevisionManifest>;
  diffAssetRevisions(ctx: StudioContext, input: { projectId: string; assetId: string; fromRevisionId: string; toRevisionId: string }): Promise<RevisionDiff>;
  restoreAssetRevision(ctx: StudioContext, input: RevisionRef & { outDir: string }): Promise<{ restored: SnapshotFile[]; outDir: string }>;

  // Checkpoints and backup protocol (storage always injected)
  createProjectCheckpoint(ctx: StudioContext, input: { projectId: string; entries: Array<{ assetId: string; revisionId: string }> }): Promise<ProjectCheckpoint>;
  syncProject(ctx: StudioContext, input: { projectId: string; storage: StudioStorage }): Promise<{ receipts: SyncReceipt[] }>;
  verifyProjectBackup(ctx: StudioContext, input: { projectId: string; storage: StudioStorage; deep: boolean }): Promise<{ verified: RevisionRef[]; failures: StudioError[] }>;
  recoverProjectFromStorage(ctx: StudioContext, input: { projectId: string; storage: StudioStorage; outDir: string; revisionRefs?: RevisionRef[]; checkpointId?: string }): Promise<{ restored: RevisionRef[]; outDir: string }>;

  // Read-only catalog for the single dashboard
  buildStudioCatalog(ctx: StudioContext, filter?: CatalogFilter): Promise<StudioCatalog>;
}
