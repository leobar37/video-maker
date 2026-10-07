import { index, integer, sqliteTable, text, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * Portal projection schema (contracts.md §2) mirroring
 * migrations/0002_portal.sql — keep both in sync.
 *
 * Timestamps are epoch milliseconds (plain INTEGER, mode: number) so quota
 * arithmetic, cursors and CAS predicates stay integer-native on D1. Ids are
 * opaque UUID strings. Kept in a separate module so the P-001 auth schema
 * files stay untouched; Drizzle needs no registry entry for select/insert/
 * batch usage (only db.query.* relational API would).
 */

export const portalWorkspace = sqliteTable('portal_workspace', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  integratorUserId: text('integrator_user_id').notNull(),
  createdMs: integer('created_ms').notNull(),
});

export const portalClient = sqliteTable(
  'portal_client',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    studioClientId: text('studio_client_id').notNull(),
    name: text('name').notNull(),
    projectionVersion: integer('projection_version').notNull().default(1),
    createdMs: integer('created_ms').notNull(),
  },
  (t) => [
    index('portal_client_workspace_idx').on(t.workspaceId),
  ],
);

export const membership = sqliteTable(
  'membership',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    portalClientId: text('portal_client_id').notNull(),
    status: text('status').notNull().default('active'), // active | revoked
    createdMs: integer('created_ms').notNull(),
    revokedMs: integer('revoked_ms'),
  },
  (t) => [
    index('membership_client_idx').on(t.portalClientId),
    index('membership_user_idx').on(t.userId),
  ],
);

export const invitation = sqliteTable(
  'invitation',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    portalClientId: text('portal_client_id').notNull(),
    status: text('status').notNull().default('pending'), // pending | accepted | revoked | expired
    invitedBy: text('invited_by').notNull(),
    expiresMs: integer('expires_ms').notNull(),
    acceptedUserId: text('accepted_user_id'),
    createdMs: integer('created_ms').notNull(),
  },
  (t) => [
    index('invitation_client_idx').on(t.portalClientId),
    index('invitation_email_idx').on(t.email),
  ],
);

export const agentGrant = sqliteTable(
  'agent_grant',
  {
    id: text('id').primaryKey(),
    keyId: text('key_id').notNull().unique(),
    workspaceId: text('workspace_id').notNull(),
    /** JSON array of client ids, or the literal 'null' = whole workspace. */
    clientIds: text('client_ids').notNull().default('null'),
    /** JSON array of scope strings; server-side source of truth. */
    scopes: text('scopes').notNull(),
    revokedMs: integer('revoked_ms'),
    createdMs: integer('created_ms').notNull(),
  },
  (t) => [index('agent_grant_workspace_idx').on(t.workspaceId)],
);

export const uploadSession = sqliteTable(
  'upload_session',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    kind: text('kind').notNull(), // material | delivery_output
    stagingKey: text('staging_key').notNull().unique(),
    declaredBytes: integer('declared_bytes').notNull(),
    declaredMediaType: text('declared_media_type').notNull(),
    declaredSha256: text('declared_sha256'),
    deliveryId: text('delivery_id'),
    outputName: text('output_name'),
    originalName: text('original_name'),
    principalId: text('principal_id').notNull(),
    status: text('status').notNull().default('pending'),
    actualBytes: integer('actual_bytes'),
    actualSha256: text('actual_sha256'),
    actualMediaType: text('actual_media_type'),
    materialId: text('material_id'),
    expiresMs: integer('expires_ms').notNull(),
    createdMs: integer('created_ms').notNull(),
    completedMs: integer('completed_ms'),
  },
  (t) => [index('upload_session_client_idx').on(t.clientId, t.createdMs)],
);

export const idempotencyRecord = sqliteTable(
  'idempotency_record',
  {
    id: text('id').primaryKey(),
    principalId: text('principal_id').notNull(),
    clientId: text('client_id').notNull(),
    operation: text('operation').notNull(),
    keyHash: text('key_hash').notNull(),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull().default('pending'), // pending | completed | failed
    responseStatus: integer('response_status'),
    responseJson: text('response_json'),
    createdMs: integer('created_ms').notNull(),
  },
  (t) => [],
);

export const clientQuota = sqliteTable('client_quota', {
  clientId: text('client_id').primaryKey(),
  usedBytes: integer('used_bytes').notNull().default(0),
  reservedBytes: integer('reserved_bytes').notNull().default(0),
  limitBytes: integer('limit_bytes').notNull().default(1_073_741_824),
  updatedMs: integer('updated_ms').notNull().default(0),
});

export const material = sqliteTable(
  'material',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    objectKey: text('object_key').notNull().unique(),
    originalName: text('original_name'),
    mediaType: text('media_type').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    status: text('status').notNull().default('ready'),
    uploadedBy: text('uploaded_by').notNull(),
    createdMs: integer('created_ms').notNull(),
    // R-1/R-2 attribution (0003/0004): NULL = free v1 upload. Every environment
    // that runs this mapping applies 0001..0004 (worker tests replay the whole
    // migrations dir; verifier/e2e fixtures replay 0001..0004 explicitly), so
    // the nullable columns are mapped like any other. A request material
    // always carries BOTH (project = the request's project).
    portalProjectId: text('portal_project_id'),
    uploadRequestId: text('upload_request_id'),
    // Asset-link attribution (0005, operator order 2026-10-06): NULL = any
    // non-asset-link upload. Set ONLY when a guest upload through an asset
    // upload link completes; the value is the LOCAL Studio asset id the link
    // was minted for and never comes from client input. Not backfilled.
    assetTarget: text('asset_target'),
  },
  (t) => [
    index('material_client_idx').on(t.clientId, t.createdMs),
    index('material_asset_target_idx').on(t.assetTarget),
  ],
);

export const deliveryRevision = sqliteTable(
  'delivery_revision',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    projectId: text('project_id').notNull(),
    assetId: text('asset_id').notNull(),
    revisionId: text('revision_id').notNull(),
    rootHash: text('root_hash').notNull(),
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    provenanceJson: text('provenance_json'),
    fingerprint: text('fingerprint').notNull(),
    status: text('status').notNull().default('pending'), // pending | ready | failed
    createdBy: text('created_by').notNull(),
    createdMs: integer('created_ms').notNull(),
    completedMs: integer('completed_ms'),
  },
  (t) => [
    index('delivery_client_idx').on(t.clientId, t.createdMs),
    // Per-client retry idempotency; cross-client deliveries stay independent.
    uniqueIndex('delivery_revision_refs_idx').on(t.clientId, t.projectId, t.assetId, t.revisionId),
  ],
);

export const deliveryOutput = sqliteTable(
  'delivery_output',
  {
    id: text('id').primaryKey(),
    deliveryId: text('delivery_id').notNull(),
    name: text('name').notNull(),
    mediaType: text('media_type').notNull(),
    bytes: integer('bytes').notNull(),
    sha256: text('sha256').notNull(),
    objectKey: text('object_key'),
    finalizedMs: integer('finalized_ms'),
    createdMs: integer('created_ms').notNull(),
  },
  (t) => [],
);

export const clientAsset = sqliteTable(
  'client_asset',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    deliveryId: text('delivery_id').notNull().unique(),
    title: text('title').notNull(),
    visibility: text('visibility').notNull().default('internal'), // internal | client_visible
    editorialStatus: text('editorial_status').notNull().default('draft'),
    createdMs: integer('created_ms').notNull(),
    updatedMs: integer('updated_ms').notNull(),
  },
  (t) => [index('client_asset_client_idx').on(t.clientId, t.createdMs)],
);

export const post = sqliteTable(
  'post',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    assetId: text('asset_id').notNull(),
    title: text('title').notNull(),
    caption: text('caption'),
    coverOutputName: text('cover_output_name').notNull(),
    visibility: text('visibility').notNull().default('internal'), // internal | client_visible
    position: integer('position').notNull(),
    version: integer('version').notNull().default(1),
    createdMs: integer('created_ms').notNull(),
    updatedMs: integer('updated_ms').notNull(),
  },
  (t) => [index('post_client_position_idx').on(t.clientId, t.position)],
);

export const postOutput = sqliteTable(
  'post_output',
  {
    postId: text('post_id').notNull(),
    name: text('name').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.name] })],
);

/**
 * PortalProject projection (P-101, R-1; contracts.md §2 additive ·
 * customer-assets-requests): canonical pointer per (portal client, Studio
 * project), adopted admin-human-only, display fields only. Studio stays
 * canonical; D1 is projection only.
 *
 * Mirrors migrations/0003_portal_projects.sql. `material.portal_project_id`
 * (0003) and `material.upload_request_id` (0004) are mapped on the material
 * table above: every environment that runs this mapping (worker tests,
 * verifier, e2e fixtures) applies migrations 0001..0004, so selections can
 * enumerate the nullable columns safely.
 */
export const portalProject = sqliteTable(
  'portal_project',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    portalClientId: text('portal_client_id').notNull(),
    studioProjectId: text('studio_project_id').notNull(),
    name: text('name').notNull(),
    projectionVersion: integer('projection_version').notNull().default(1),
    createdMs: integer('created_ms').notNull(),
  },
  (t) => [index('portal_project_client_idx').on(t.portalClientId, t.createdMs)],
);

/**
 * UploadRequest (P-102, R-2; contracts.md §2 additive ·
 * customer-assets-requests): a pedido de material per project with
 * creator-fixed limits, live budget counters and a lazy state machine
 * open -> fulfilled | closed | expired. portal_client_id is denormalized from
 * the project for authorization and client-quota competition. Mirrors
 * migrations/0004_upload_requests.sql (plain-text refs, FK-safe like
 * upload_session).
 */
export const uploadRequest = sqliteTable(
  'upload_request',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    portalClientId: text('portal_client_id').notNull(),
    portalProjectId: text('portal_project_id').notNull(),
    title: text('title').notNull(),
    instructions: text('instructions'),
    maxFiles: integer('max_files').notNull(),
    maxBytes: integer('max_bytes').notNull(),
    usedFiles: integer('used_files').notNull().default(0),
    usedBytes: integer('used_bytes').notNull().default(0),
    state: text('state').notNull().default('open'), // open | fulfilled | closed | expired
    expiresMs: integer('expires_ms').notNull(),
    createdBy: text('created_by').notNull(),
    createdMs: integer('created_ms').notNull(),
    closedMs: integer('closed_ms'),
    closeReason: text('close_reason'),
  },
  (t) => [
    index('upload_request_client_idx').on(t.portalClientId, t.createdMs),
    index('upload_request_project_idx').on(t.portalProjectId),
  ],
);

/**
 * UploadRequestToken (R-2): guest-direct capability token storage. ONLY the
 * SHA-256 hash is persisted — the raw token lives exclusively in the minted
 * URL, shown once to the admin and never logged/audited. One ACTIVE token per
 * request: re-mint revokes the previous (operator default). UNIQUE(token_hash)
 * makes the hash a stable lookup key without any plaintext column.
 */
export const uploadRequestToken = sqliteTable(
  'upload_request_token',
  {
    id: text('id').primaryKey(),
    requestId: text('request_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresMs: integer('expires_ms').notNull(),
    revokedMs: integer('revoked_ms'),
    createdBy: text('created_by').notNull(),
    createdMs: integer('created_ms').notNull(),
  },
  (t) => [index('upload_request_token_request_idx').on(t.requestId)],
);

/**
 * AssetUploadLink (operator order 2026-10-06; contratos aditivos §9 ·
 * customer-assets-requests): a guest-direct capability bound to EXACTLY ONE
 * Studio asset. ONLY the SHA-256 hash is persisted — the raw token lives
 * exclusively in the minted URL (/asset-upload/<token>), shown once to the
 * operator and never logged/audited. One ACTIVE link per (portal client,
 * Studio asset): re-mint closes the previous (rotation). Lazy state machine
 * open -> used | closed | expired evaluated on every touch. Mirrors
 * migrations/0005_asset_upload_links.sql (plain-text refs, FK-safe like
 * upload_session/upload_request).
 */
export const assetUploadLink = sqliteTable(
  'asset_upload_link',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    portalClientId: text('portal_client_id').notNull(),
    portalProjectId: text('portal_project_id'),
    studioProjectId: text('studio_project_id').notNull(),
    studioAssetId: text('studio_asset_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresMs: integer('expires_ms').notNull(),
    state: text('state').notNull().default('open'), // open | used | closed | expired
    createdBy: text('created_by').notNull(),
    createdMs: integer('created_ms').notNull(),
    closedMs: integer('closed_ms'),
    closeReason: text('close_reason'),
  },
  (t) => [
    index('asset_upload_link_client_idx').on(t.portalClientId, t.createdMs),
    index('asset_upload_link_asset_idx').on(t.portalClientId, t.studioAssetId),
  ],
);

export const clientGrid = sqliteTable('client_grid', {
  clientId: text('client_id').primaryKey(),
  version: integer('version').notNull().default(1),
  updatedMs: integer('updated_ms').notNull().default(0),
});

export const auditEvent = sqliteTable(
  'audit_event',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id'),
    clientId: text('client_id'),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: text('resource_id').notNull(),
    requestId: text('request_id').notNull(),
    createdMs: integer('created_ms').notNull(),
  },
  (t) => [index('audit_client_idx').on(t.clientId, t.createdMs)],
);

export const portalSchema = {
  portalWorkspace,
  portalClient,
  portalProject,
  uploadRequest,
  uploadRequestToken,
  assetUploadLink,
  membership,
  invitation,
  agentGrant,
  uploadSession,
  idempotencyRecord,
  clientQuota,
  material,
  deliveryRevision,
  deliveryOutput,
  clientAsset,
  post,
  postOutput,
  clientGrid,
  auditEvent,
};
