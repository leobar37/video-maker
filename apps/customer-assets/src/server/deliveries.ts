import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  AssetView,
  DeliveryView,
  OutputRef,
  Page,
  V1MediaType,
} from '@videomaker/customer-assets';
import type { PortalDb } from './db';
import { clientAsset, deliveryOutput, deliveryRevision } from './db/schema';
import {
  PortalError,
  authorizeClient,
  badRequest,
  canonicalJson,
  conflict,
  notFound,
  requireNonEmptyString,
  requireOutputName,
  requireSha256,
  requireStudioId,
  type Principal,
} from './access';
import { portalClient } from './db/schema';
import { serveStoredObject, storageKeys, type ServeOutcome } from './storage';
import { V1_TYPE_LIMIT_BYTES, isV1MediaType } from './uploads';

/**
 * Internal deliveries and the private catalog projection (contracts.md §2/§5):
 * - a delivery pins EXACT Studio refs (project/asset/revision/rootHash) and
 *   EXACT selected outputs (name, hash, bytes, mediaType); new versions are
 *   new rows, there is no `latest` indirection for client-facing bytes;
 * - creation writes the whole pending projection (delivery + outputs + client
 *   asset, visibility internal) atomically BEFORE any byte is staged;
 * - unique (workspace, project, asset, revision) refs make retries
 *   non-duplicating: identical payload replays the existing delivery, a
 *   divergent payload is a 409;
 * - `complete` marks ready only when EVERY output's bytes are verified in R2;
 * - clients see `client_visible` assets only, and only after the delivery is
 *   ready; internal drafts, sources and manifests never cross that boundary.
 */

export type DeliveryRow = typeof deliveryRevision.$inferSelect;
export type DeliveryOutputRow = typeof deliveryOutput.$inferSelect;
export type ClientAssetRow = typeof clientAsset.$inferSelect;

const MAX_OUTPUTS = 20;
const MAX_PROVENANCE_JSON = 4096;

export interface CreateDeliveryInput {
  projectId: string;
  assetId: string;
  revisionId: string;
  rootHash: string;
  title: string;
  kind: string;
  outputs: OutputRef[];
  provenance?: Record<string, string | number | boolean | null>;
}

function isOutputRefArray(value: unknown): boolean {
  return Array.isArray(value);
}

function validateDeliveryInput(input: unknown): CreateDeliveryInput {
  if (typeof input !== 'object' || input === null) throw badRequest('A delivery body is required.');
  const raw = input as Record<string, unknown>;
  const outputsRaw: unknown = raw.outputs;
  if (!Array.isArray(outputsRaw) || outputsRaw.length === 0) {
    throw badRequest('outputs must be a non-empty array of selected outputs.');
  }
  if (outputsRaw.length > MAX_OUTPUTS) throw badRequest(`outputs supports at most ${MAX_OUTPUTS} entries.`);
  const seen = new Set<string>();
  const outputs = (outputsRaw as unknown[]).map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw badRequest('each output must be an object.');
    const e = entry as Record<string, unknown>;
    const name = requireOutputName(e.name, 'output.name');
    if (seen.has(name)) throw badRequest(`duplicate output name: ${name}`);
    seen.add(name);
    if (!isV1MediaType(e.mediaType)) throw badRequest('output.mediaType is not a v1 media type.');
    const bytes = e.bytes;
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes <= 0) {
      throw badRequest('output.bytes must be a positive integer.');
    }
    if (bytes > V1_TYPE_LIMIT_BYTES[e.mediaType]) {
      throw badRequest(`output.bytes exceeds the ${e.mediaType} limit.`);
    }
    return {
      name,
      mediaType: e.mediaType,
      bytes,
      sha256: requireSha256(e.sha256, 'output.sha256'),
    };
  });

  let provenance: Record<string, string | number | boolean | null> | undefined;
  if (raw.provenance !== undefined) {
    if (typeof raw.provenance !== 'object' || raw.provenance === null || Array.isArray(raw.provenance)) {
      throw badRequest('provenance must be an object of primitive values.');
    }
    for (const [key, value] of Object.entries(raw.provenance)) {
      if (value !== null && typeof value === 'object') {
        throw badRequest('provenance values must be primitives.');
      }
      if (key.length > 64) throw badRequest('provenance keys are limited to 64 characters.');
    }
    provenance = raw.provenance as Record<string, string | number | boolean | null>;
  }

  return {
    projectId: requireStudioId(raw.projectId, 'projectId'),
    assetId: requireStudioId(raw.assetId, 'assetId'),
    revisionId: requireStudioId(raw.revisionId, 'revisionId'),
    rootHash: requireSha256(raw.rootHash, 'rootHash'),
    title: requireNonEmptyString(raw.title, 'title', 200),
    kind: requireNonEmptyString(raw.kind, 'kind', 64),
    outputs,
    provenance,
  };
}

export function deliveryView(
  row: DeliveryRow,
  outputs: DeliveryOutputRow[],
): DeliveryView {
  return {
    id: row.id,
    clientId: row.clientId,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    assetId: row.assetId,
    revisionId: row.revisionId,
    rootHash: row.rootHash,
    title: row.title,
    kind: row.kind,
    status: row.status as DeliveryView['status'],
    outputs: outputs.map((o) => ({
      name: o.name,
      mediaType: o.mediaType as V1MediaType,
      bytes: o.bytes,
      sha256: o.sha256,
      ready: o.objectKey !== null,
    })),
    createdAt: row.createdMs,
  };
}

export async function loadDeliveryOutputs(db: PortalDb, deliveryId: string): Promise<DeliveryOutputRow[]> {
  return db.select().from(deliveryOutput).where(eq(deliveryOutput.deliveryId, deliveryId));
}

/**
 * POST /api/v1/clients/:clientId/deliveries — internal delivery projection.
 * Admin humans and agents with `deliveries:write` may deliver; client members
 * never see this operation (their own client returns 403, others 404).
 */
export async function createDelivery(
  db: PortalDb,
  principal: Principal,
  clientId: string,
  rawInput: unknown,
): Promise<{ delivery: DeliveryView; replayed: boolean }> {
  await authorizeClient(db, principal, clientId, 'deliveries:write');
  const input = validateDeliveryInput(rawInput);

  const fingerprint = canonicalJson(input);
  // Retry idempotency per client: the same Studio revision may be delivered
  // to different portal clients (multi-client projects), but never twice to
  // the same one with divergent payloads.
  const [existing] = await db
    .select()
    .from(deliveryRevision)
    .where(
      and(
        eq(deliveryRevision.clientId, clientId),
        eq(deliveryRevision.projectId, input.projectId),
        eq(deliveryRevision.assetId, input.assetId),
        eq(deliveryRevision.revisionId, input.revisionId),
      ),
    )
    .limit(1);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw conflict('This Studio revision was already delivered with different outputs.');
    }
    return { delivery: deliveryView(existing, await loadDeliveryOutputs(db, existing.id)), replayed: true };
  }

  const now = Date.now();
  const deliveryId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const provenanceJson = input.provenance === undefined ? null : canonicalJson(input.provenance);
  if (provenanceJson !== null && provenanceJson.length > MAX_PROVENANCE_JSON) {
    throw badRequest('provenance is too large.');
  }

  // The workspace comes from the authorized client row (exact, not derived
  // from the caller's grant shape).
  const [clientRow] = await db
    .select({ workspaceId: portalClient.workspaceId })
    .from(portalClient)
    .where(eq(portalClient.id, clientId))
    .limit(1);
  if (!clientRow) throw notFound();
  const { workspaceId } = clientRow;

  // Atomic pending projection BEFORE any byte staging: delivery + outputs +
  // the internal client asset appear together or not at all (D1 batch).
  // A concurrent identical create loses the unique-refs race and converges on
  // the winner's row instead of surfacing an internal error.
  try {
    await db.batch([
      db.insert(deliveryRevision).values({
        id: deliveryId,
        clientId,
        workspaceId,
        projectId: input.projectId,
        assetId: input.assetId,
        revisionId: input.revisionId,
        rootHash: input.rootHash,
        title: input.title,
        kind: input.kind,
        provenanceJson,
        fingerprint,
        status: 'pending',
        createdBy: principal.kind === 'agent' ? `key:${principal.keyId}` : `user:${principal.userId}`,
        createdMs: now,
      }),
      ...input.outputs.map((output) =>
        db.insert(deliveryOutput).values({
          id: crypto.randomUUID(),
          deliveryId,
          name: output.name,
          mediaType: output.mediaType,
          bytes: output.bytes,
          sha256: output.sha256,
          createdMs: now,
        }),
      ),
      db.insert(clientAsset).values({
        id: assetId,
        clientId,
        deliveryId,
        title: input.title,
        visibility: 'internal',
        editorialStatus: 'draft',
        createdMs: now,
        updatedMs: now,
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes('UNIQUE constraint failed')) throw error;
    const [winner] = await db
      .select()
      .from(deliveryRevision)
      .where(
        and(
          eq(deliveryRevision.clientId, clientId),
          eq(deliveryRevision.projectId, input.projectId),
          eq(deliveryRevision.assetId, input.assetId),
          eq(deliveryRevision.revisionId, input.revisionId),
        ),
      )
      .limit(1);
    if (!winner) throw error;
    if (winner.fingerprint !== fingerprint) {
      throw conflict('This Studio revision was already delivered with different outputs.');
    }
    return { delivery: deliveryView(winner, await loadDeliveryOutputs(db, winner.id)), replayed: true };
  }

  const [row] = await db.select().from(deliveryRevision).where(eq(deliveryRevision.id, deliveryId)).limit(1);
  return { delivery: deliveryView(row!, await loadDeliveryOutputs(db, deliveryId)), replayed: false };
}

export async function loadDeliveryForPrincipal(
  db: PortalDb,
  principal: Principal,
  deliveryId: string,
  scope: string,
): Promise<DeliveryRow> {
  const [row] = await db.select().from(deliveryRevision).where(eq(deliveryRevision.id, deliveryId)).limit(1);
  if (!row) throw notFound();
  await authorizeClient(db, principal, row.clientId, scope);
  return row;
}

/**
 * POST /api/v1/deliveries/:id/complete — ready only when ALL selected outputs
 * have verified bytes in R2. Anything less leaves the delivery pending.
 */
export async function completeDelivery(
  db: PortalDb,
  bucket: R2Bucket,
  principal: Principal,
  deliveryId: string,
): Promise<DeliveryView> {
  const delivery = await loadDeliveryForPrincipal(db, principal, deliveryId, 'deliveries:write');
  if (delivery.status === 'ready') {
    return deliveryView(delivery, await loadDeliveryOutputs(db, deliveryId));
  }
  if (delivery.status !== 'pending') {
    throw conflict(`Delivery is ${delivery.status} and cannot be completed.`);
  }

  const outputs = await loadDeliveryOutputs(db, deliveryId);
  const missing = outputs.filter((o) => o.objectKey === null);
  if (missing.length > 0) {
    throw conflict(`Delivery has ${missing.length} unstaged output(s); stage them before completing.`);
  }
  // Belt and braces: the final objects must actually exist in R2 before the
  // ready status is committed (R2 loss after output completion keeps the
  // delivery pending instead of faking readiness).
  for (const output of outputs) {
    const head = await bucket.head(output.objectKey!);
    if (head === null || head.size !== output.bytes) {
      throw new PortalError(
        500,
        'internal',
        'staged output object is missing from storage; delivery stays pending',
      );
    }
  }

  await db
    .update(deliveryRevision)
    .set({ status: 'ready', completedMs: Date.now() })
    .where(eq(deliveryRevision.id, deliveryId));
  const [row] = await db.select().from(deliveryRevision).where(eq(deliveryRevision.id, deliveryId)).limit(1);
  return deliveryView(row!, outputs);
}

/* catalog ------------------------------------------------------------------ */

function assetView(
  asset: ClientAssetRow,
  delivery: DeliveryRow,
  outputs: DeliveryOutputRow[],
  exposeProvenance: boolean,
): AssetView {
  return {
    id: asset.id,
    clientId: asset.clientId,
    deliveryId: asset.deliveryId,
    title: asset.title,
    revisionId: delivery.revisionId,
    visibility: asset.visibility as AssetView['visibility'],
    editorialStatus: asset.editorialStatus,
    outputs: outputs.map((o) => ({
      name: o.name,
      mediaType: o.mediaType as V1MediaType,
      bytes: o.bytes,
      sha256: o.sha256,
    })),
    createdAt: asset.createdMs,
    ...(exposeProvenance ? { rootHash: delivery.rootHash } : {}),
  };
}

/**
 * GET /api/v1/clients/:clientId/assets — the private catalog.
 * Members: only client_visible assets of ready deliveries, never internal
 * drafts or provenance fields. Admin humans and agents with deliveries:read:
 * everything, provenance included (contracts.md §3).
 */
export async function listAssetsForClient(
  db: PortalDb,
  principal: Principal,
  clientId: string,
): Promise<Page<AssetView>> {
  const exposeProvenance = principal.kind !== 'member';
  await authorizeClient(db, principal, clientId, 'deliveries:read');

  const conditions =
    principal.kind === 'member'
      ? and(
          eq(clientAsset.clientId, clientId),
          eq(clientAsset.visibility, 'client_visible'),
          eq(deliveryRevision.status, 'ready'),
        )
      : eq(clientAsset.clientId, clientId);

  const rows = await db
    .select({ asset: clientAsset, delivery: deliveryRevision })
    .from(clientAsset)
    .innerJoin(deliveryRevision, eq(deliveryRevision.id, clientAsset.deliveryId))
    .where(conditions)
    .orderBy(desc(clientAsset.createdMs))
    .limit(100);

  if (rows.length === 0) return { items: [], nextCursor: null };
  const outputRows = await db
    .select()
    .from(deliveryOutput)
    .where(inArray(deliveryOutput.deliveryId, rows.map((r) => r.delivery.id)));
  return {
    items: rows.map((r) =>
      assetView(
        r.asset,
        r.delivery,
        outputRows.filter((o) => o.deliveryId === r.delivery.id),
        exposeProvenance,
      ),
    ),
    nextCursor: null,
  };
}

export interface AuthorizedOutput {
  delivery: DeliveryRow;
  output: DeliveryOutputRow;
}

/**
 * Authorization for a SINGLE selected output (contracts.md §6): the name must
 * match a selected delivery_output row; members additionally require the
 * delivery to be ready AND the asset to be client_visible. Any miss is 404 —
 * manipulated names gain no access to arbitrary keys.
 */
export async function authorizeDeliveryOutput(
  db: PortalDb,
  principal: Principal,
  deliveryId: string,
  outputName: string,
): Promise<AuthorizedOutput> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(outputName)) throw notFound();
  const delivery = await loadDeliveryForPrincipal(db, principal, deliveryId, 'deliveries:read');

  const [output] = await db
    .select()
    .from(deliveryOutput)
    .where(and(eq(deliveryOutput.deliveryId, deliveryId), eq(deliveryOutput.name, outputName)))
    .limit(1);
  if (!output) throw notFound();

  if (principal.kind === 'member') {
    if (delivery.status !== 'ready') throw notFound();
    const [asset] = await db
      .select({ visibility: clientAsset.visibility })
      .from(clientAsset)
      .where(eq(clientAsset.deliveryId, deliveryId))
      .limit(1);
    if (!asset || asset.visibility !== 'client_visible') throw notFound();
  }
  return { delivery, output };
}

/** GET|HEAD /api/v1/deliveries/:id/outputs/:name — selected output only. */
export async function serveDeliveryOutput(
  db: PortalDb,
  bucket: R2Bucket,
  principal: Principal,
  deliveryId: string,
  outputName: string,
  request: Request,
): Promise<ServeOutcome> {
  const { output } = await authorizeDeliveryOutput(db, principal, deliveryId, outputName);
  if (output.objectKey === null) throw notFound();
  // Defense in depth: the stored key is always the content-addressed final
  // key computed at finalize time — never a client-supplied string.
  const expectedPrefix = storageKeys.deliveryOutputFinal(deliveryId, output.sha256);
  if (output.objectKey !== expectedPrefix) throw notFound();
  return serveStoredObject(request, bucket, {
    key: output.objectKey,
    size: output.bytes,
    contentType: output.mediaType,
    filename: output.name,
  });
}
