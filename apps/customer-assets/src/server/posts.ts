import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  AssetView,
  GridState,
  OutputRef,
  Page,
  PostView,
  Visibility,
} from '@videomaker/customer-assets';
import type { PortalDb } from './db';
import { clientAsset, clientGrid, deliveryOutput, deliveryRevision, post, postOutput } from './db/schema';
import {
  batchAll,
  PortalError,
  authorizeClient,
  badRequest,
  conflict,
  forbidden,
  notFound,
  rawRun,
  requireAdmin,
  requireNonEmptyString,
  requireOutputName,
  requireVisibility,
  type Principal,
} from './access';

/**
 * Posts and the versioned grid (contracts.md §2/§6, FR-005/FR-006):
 * - posts reference ONLY exact selected outputs of the asset's own delivery —
 *   never outputs of another delivery/client;
 * - making a post visible requires its asset to be visible, so no indirect
 *   route can leak a hidden asset's bytes;
 * - writes are admin-human only; agents have no post scope in v1;
 * - grid reorder is one atomic D1 batch behind a CAS version bump — no
 *   interactive BEGIN/COMMIT, stale versions get an explicit 409.
 */

export type PostRow = typeof post.$inferSelect;

const MAX_POST_OUTPUTS = 10;

interface ClientAssetWithDelivery {
  asset: typeof clientAsset.$inferSelect;
  delivery: typeof deliveryRevision.$inferSelect;
}

async function loadAssetWithDelivery(db: PortalDb, assetId: string): Promise<ClientAssetWithDelivery> {
  const [row] = await db
    .select({ asset: clientAsset, delivery: deliveryRevision })
    .from(clientAsset)
    .innerJoin(deliveryRevision, eq(deliveryRevision.id, clientAsset.deliveryId))
    .where(eq(clientAsset.id, assetId))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

async function deliveryOutputsByName(
  db: PortalDb,
  deliveryId: string,
): Promise<Record<string, typeof deliveryOutput.$inferSelect>> {
  const rows = await db.select().from(deliveryOutput).where(eq(deliveryOutput.deliveryId, deliveryId));
  const byName: Record<string, typeof deliveryOutput.$inferSelect> = {};
  for (const row of rows) byName[row.name] = row;
  return byName;
}

function outputRef(row: typeof deliveryOutput.$inferSelect): OutputRef {
  return {
    name: row.name,
    mediaType: row.mediaType as OutputRef['mediaType'],
    bytes: row.bytes,
    sha256: row.sha256,
  };
}

async function outputRefsForPost(
  db: PortalDb,
  postRow: PostRow,
): Promise<{ cover: OutputRef; outputs: OutputRef[] }> {
  const [asset] = await db
    .select({ deliveryId: clientAsset.deliveryId })
    .from(clientAsset)
    .where(eq(clientAsset.id, postRow.assetId))
    .limit(1);
  if (!asset) throw new PortalError(500, 'internal', 'post references a missing asset');
  const rows = await db
    .select({ name: postOutput.name, position: postOutput.position })
    .from(postOutput)
    .where(eq(postOutput.postId, postRow.id))
    .orderBy(asc(postOutput.position));
  const byName = await deliveryOutputsByName(db, asset.deliveryId);
  const outputs: OutputRef[] = [];
  let cover: OutputRef | null = null;
  for (const entry of rows) {
    const outputRow = byName[entry.name];
    if (!outputRow) throw new PortalError(500, 'internal', 'post output missing from its delivery');
    const ref = outputRef(outputRow);
    outputs.push(ref);
    if (entry.name === postRow.coverOutputName) cover = ref;
  }
  if (cover === null) throw new PortalError(500, 'internal', 'post cover is not among its outputs');
  return { cover, outputs };
}

export async function postView(db: PortalDb, row: PostRow): Promise<PostView> {
  const { cover, outputs } = await outputRefsForPost(db, row);
  return {
    id: row.id,
    clientId: row.clientId,
    assetId: row.assetId,
    title: row.title,
    caption: row.caption,
    cover,
    outputs,
    visibility: row.visibility as Visibility,
    position: row.position,
    version: row.version,
    createdAt: row.createdMs,
  };
}

export interface CreatePostInput {
  assetId: string;
  title: string;
  caption?: string;
  outputNames: string[];
  coverOutputName: string;
  visibility: Visibility;
}

function validatePostInput(raw: unknown): CreatePostInput {
  if (typeof raw !== 'object' || raw === null) throw badRequest('A post body is required.');
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.outputNames) || r.outputNames.length === 0 || r.outputNames.length > MAX_POST_OUTPUTS) {
    throw badRequest(`outputNames must contain between 1 and ${MAX_POST_OUTPUTS} names.`);
  }
  const names = r.outputNames.map((n) => requireOutputName(n, 'outputNames[]'));
  const coverOutputName = requireOutputName(r.coverOutputName, 'coverOutputName');
  if (!names.includes(coverOutputName)) {
    throw badRequest('coverOutputName must be one of outputNames.');
  }
  let caption: string | undefined;
  if (r.caption !== undefined && r.caption !== null) {
    caption = requireNonEmptyString(r.caption, 'caption', 2200);
  }
  if (typeof r.assetId !== 'string' || r.assetId.length === 0) throw badRequest('assetId is required.');
  return {
    assetId: r.assetId,
    title: requireNonEmptyString(r.title, 'title', 200),
    caption,
    outputNames: names,
    coverOutputName,
    visibility: requireVisibility(r.visibility),
  };
}

/**
 * Shared validation: the asset must belong to the client, every requested
 * output name must be an exact selected output of the asset's own delivery,
 * and client_visible posts require a client_visible asset (no indirect
 * exposure of hidden bytes through a post).
 */
async function validatePostAgainstAsset(
  db: PortalDb,
  clientId: string,
  input: CreatePostInput,
): Promise<void> {
  const found = await loadAssetWithDelivery(db, input.assetId);
  if (found.asset.clientId !== clientId) throw notFound();
  const byName = await deliveryOutputsByName(db, found.asset.deliveryId);
  for (const name of input.outputNames) {
    if (byName[name] === undefined) {
      throw badRequest(`output '${name}' is not a selected output of this asset's delivery.`);
    }
  }
  if (input.visibility === 'client_visible' && found.asset.visibility !== 'client_visible') {
    throw conflict('The asset is not visible to the client; show the asset before its posts.');
  }
}

/** POST /api/v1/clients/:clientId/posts — admin human only. */
export async function createPost(
  db: PortalDb,
  principal: Principal,
  clientId: string,
  rawInput: unknown,
): Promise<PostView> {
  await authorizeClient(db, principal, clientId);
  requireAdmin(principal);
  const input = validatePostInput(rawInput);
  await validatePostAgainstAsset(db, clientId, input);

  const [maxRow] = await db
    .select({ max: sql<number | null>`MAX(${post.position})` })
    .from(post)
    .where(eq(post.clientId, clientId));
  const position = (maxRow?.max ?? -1) + 1;
  const now = Date.now();
  const postId = crypto.randomUUID();

  // Post + ordered outputs land in one atomic batch.
  await db.batch([
    db.insert(post).values({
      id: postId,
      clientId,
      assetId: input.assetId,
      title: input.title,
      caption: input.caption ?? null,
      coverOutputName: input.coverOutputName,
      visibility: input.visibility,
      position,
      version: 1,
      createdMs: now,
      updatedMs: now,
    }),
    ...input.outputNames.map((name, index) =>
      db.insert(postOutput).values({ postId, name, position: index }),
    ),
  ]);

  const [row] = await db.select().from(post).where(eq(post.id, postId)).limit(1);
  return postView(db, row!);
}

async function loadPostRow(db: PortalDb, postId: string): Promise<PostRow> {
  const [row] = await db.select().from(post).where(eq(post.id, postId)).limit(1);
  if (!row) throw notFound();
  return row;
}

/**
 * PATCH /api/v1/posts/:id — admin human only. Optional If-Match on the post
 * version (CAS); visibility changes re-check the asset boundary; the cover
 * must stay within the post's outputs.
 */
export async function updatePost(
  db: PortalDb,
  principal: Principal,
  postId: string,
  rawPatch: unknown,
  ifMatchHeader: string | null,
): Promise<PostView> {
  let row = await loadPostRow(db, postId);
  await authorizeClient(db, principal, row.clientId);
  requireAdmin(principal);
  const ifMatchVersion = parseIfMatch(ifMatchHeader);
  if (typeof rawPatch !== 'object' || rawPatch === null) throw badRequest('A patch body is required.');
  const patch = rawPatch as Record<string, unknown>;

  const title = patch.title === undefined ? undefined : requireNonEmptyString(patch.title, 'title', 200);
  const caption =
    patch.caption === undefined
      ? undefined
      : patch.caption === null
        ? null
        : requireNonEmptyString(patch.caption, 'caption', 2200);
  const visibility = patch.visibility === undefined ? undefined : requireVisibility(patch.visibility);
  let outputNames: string[] | undefined;
  if (patch.outputNames !== undefined) {
    if (
      !Array.isArray(patch.outputNames) ||
      patch.outputNames.length === 0 ||
      patch.outputNames.length > MAX_POST_OUTPUTS
    ) {
      throw badRequest(`outputNames must contain between 1 and ${MAX_POST_OUTPUTS} names.`);
    }
    outputNames = patch.outputNames.map((n) => requireOutputName(n, 'outputNames[]'));
  }
  const coverOutputName =
    patch.coverOutputName === undefined ? undefined : requireOutputName(patch.coverOutputName, 'coverOutputName');

  if (outputNames !== undefined) {
    const found = await loadAssetWithDelivery(db, row.assetId);
    const byName = await deliveryOutputsByName(db, found.asset.deliveryId);
    for (const name of outputNames) {
      if (byName[name] === undefined) {
        throw badRequest(`output '${name}' is not a selected output of this asset's delivery.`);
      }
    }
  }
  const finalOutputNames = outputNames ?? (await outputRefsForPost(db, row)).outputs.map((o) => o.name);
  const finalCover = coverOutputName ?? row.coverOutputName;
  if (!finalOutputNames.includes(finalCover)) {
    throw badRequest('coverOutputName must be one of outputNames.');
  }
  if (visibility === 'client_visible' && row.visibility !== 'client_visible') {
    const [asset] = await db
      .select({ visibility: clientAsset.visibility })
      .from(clientAsset)
      .where(eq(clientAsset.id, row.assetId))
      .limit(1);
    if (!asset || asset.visibility !== 'client_visible') {
      throw conflict('The asset is not visible to the client; show the asset before its posts.');
    }
  }

  const now = Date.now();
  const nextTitle = title ?? row.title;
  const nextCaption = caption === undefined ? row.caption : caption;
  const nextVisibility = visibility ?? row.visibility;
  if (ifMatchVersion !== null) {
    // Optimistic concurrency: the version predicate IS the CAS.
    const result = await rawRun(
      db,
      sql`UPDATE post SET title = ${nextTitle}, caption = ${nextCaption}, visibility = ${nextVisibility},
          cover_output_name = ${finalCover}, version = version + 1, updated_ms = ${now} WHERE id = ${postId} AND version = ${ifMatchVersion}`,
    );
    if (result.meta.changes === 0) throw conflict('Post version mismatch; reload and retry.');
  } else {
    await rawRun(
      db,
      sql`UPDATE post SET title = ${nextTitle}, caption = ${nextCaption}, visibility = ${nextVisibility},
          cover_output_name = ${finalCover}, version = version + 1, updated_ms = ${now} WHERE id = ${postId}`,
    );
  }
  await replacePostOutputs(db, postId, finalOutputNames);
  row = await loadPostRow(db, postId);
  return postView(db, row);
}

async function replacePostOutputs(db: PortalDb, postId: string, names: string[]): Promise<void> {
  const existing = await db.select({ name: postOutput.name }).from(postOutput).where(eq(postOutput.postId, postId));
  const desired = new Set(names);
  const removals = existing
    .filter((e) => !desired.has(e.name))
    .map((e) => db.delete(postOutput).where(and(eq(postOutput.postId, postId), eq(postOutput.name, e.name))));
  const upserts = names.map((name, position) =>
    db
      .insert(postOutput)
      .values({ postId, name, position })
      .onConflictDoUpdate({ target: [postOutput.postId, postOutput.name], set: { position } }),
  );
  await batchAll(db, [...removals, ...upserts]);
}

/**
 * GET /api/v1/clients/:clientId/posts — members see client_visible posts
 * only, in grid order; admin humans see everything; agents have no post
 * scope in v1 (403 on an authorized client, 404 elsewhere).
 */
export async function listPostsForClient(
  db: PortalDb,
  principal: Principal,
  clientId: string,
): Promise<Page<PostView>> {
  await authorizeClient(db, principal, clientId);
  if (principal.kind === 'agent') {
    throw forbidden('Agent principals cannot read posts in v1.');
  }

  const conditions =
    principal.kind === 'member'
      ? and(eq(post.clientId, clientId), eq(post.visibility, 'client_visible'))
      : eq(post.clientId, clientId);
  const rows = await db.select().from(post).where(conditions).orderBy(asc(post.position), asc(post.id));
  const items: PostView[] = [];
  for (const row of rows) items.push(await postView(db, row));
  return { items, nextCursor: null };
}

/* grid ---------------------------------------------------------------------- */

/**
 * GET /api/v1/clients/:clientId/grid — admin human only (additive read for
 * P-004): the current grid version plus the ordered post summaries. A fresh
 * admin session needs the live version to send a valid If-Match/`version` on
 * PATCH; without this read a concurrent reorder makes the CAS unrecoverable.
 * Mirrors patchGrid's ordering (position asc, id asc) and never writes.
 */
export async function getGridState(
  db: PortalDb,
  principal: Principal,
  clientId: string,
): Promise<GridState> {
  await authorizeClient(db, principal, clientId);
  requireAdmin(principal);

  const [gridRow] = await db
    .select({ version: clientGrid.version })
    .from(clientGrid)
    .where(eq(clientGrid.clientId, clientId))
    .limit(1);
  const rows = await db
    .select()
    .from(post)
    .where(eq(post.clientId, clientId))
    .orderBy(asc(post.position), asc(post.id));
  return {
    // No row yet == zero reorders; PATCH expects version 1 in that state.
    version: gridRow?.version ?? 1,
    posts: rows.map((row, index) => ({
      postId: row.id,
      position: index,
      visibility: row.visibility as Visibility,
    })),
  };
}

export interface PatchGridInput {
  version: number;
  order: string[];
}

export function parseIfMatch(header: string | null): number | null {
  if (header === null) return null;
  const match = /^\s*"?(\d+)"?\s*$/.exec(header);
  if (!match) throw conflict('If-Match must be a grid version.');
  return Number.parseInt(match[1]!, 10);
}

/**
 * PATCH /api/v1/clients/:clientId/grid — atomic reorder behind a CAS version
 * bump (single D1 statement), then one batch of position updates. Posts not
 * in `order` keep their relative sequence after the listed ones.
 */
export async function patchGrid(
  db: PortalDb,
  principal: Principal,
  clientId: string,
  input: PatchGridInput,
  ifMatchHeader: string | null,
): Promise<GridState> {
  await authorizeClient(db, principal, clientId);
  requireAdmin(principal);
  const ifMatchVersion = parseIfMatch(ifMatchHeader);

  const version = ifMatchVersion ?? input.version;
  if (!Number.isInteger(version) || version < 1) throw badRequest('version must be a positive integer.');
  if (!Array.isArray(input.order)) throw badRequest('order must be an array of post ids.');
  const order = [...new Set(input.order)];

  const clientPosts = await db.select().from(post).where(eq(post.clientId, clientId));
  const byId: Record<string, PostRow> = {};
  for (const row of clientPosts) byId[row.id] = row;
  for (const id of order) {
    if (byId[id] === undefined) {
      throw conflict('order references a post of another client or an unknown post.');
    }
  }

  // Ensure the grid row exists, then CAS the version bump: concurrent PATCHes
  // with the same version cannot both win.
  await rawRun(db, sql`INSERT OR IGNORE INTO client_grid (client_id, version, updated_ms) VALUES (${clientId}, 1, 0)`);
  const bump = await rawRun(
    db,
    sql`UPDATE client_grid SET version = version + 1, updated_ms = ${Date.now()} WHERE client_id = ${clientId} AND version = ${version}`,
  );
  if (bump.meta.changes === 0) {
    throw conflict('Grid version mismatch; reload the grid and retry.');
  }

  const ordered = [
    ...order.map((id) => byId[id]!),
    ...clientPosts
      .filter((row) => !order.includes(row.id))
      .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)),
  ];
  await batchAll(
    db,
    ordered.map((row, index) =>
      db.update(post).set({ position: index, updatedMs: Date.now() }).where(eq(post.id, row.id)),
    ),
  );

  const [gridRow] = await db
    .select({ version: clientGrid.version })
    .from(clientGrid)
    .where(eq(clientGrid.clientId, clientId))
    .limit(1);
  return {
    version: gridRow?.version ?? version + 1,
    posts: ordered.map((row, index) => ({
      postId: row.id,
      position: index,
      visibility: row.visibility as Visibility,
    })),
  };
}

/* visibility cascade ---------------------------------------------------------- */

/**
 * PATCH /api/v1/client-assets/:id/visibility — admin human only. Hiding an
 * asset hides every post that uses it in the SAME atomic batch: no indirect
 * URLs through posts or outputs remain client-accessible. Showing does not
 * auto-show posts; the admin re-enables them explicitly.
 */
export async function setAssetVisibility(
  db: PortalDb,
  principal: Principal,
  assetId: string,
  visibility: Visibility,
): Promise<AssetView> {
  const found = await loadAssetWithDelivery(db, assetId);
  await authorizeClient(db, principal, found.asset.clientId);
  requireAdmin(principal);

  const now = Date.now();
  if (visibility === 'internal') {
    const dependentPosts = await db
      .select({ id: post.id })
      .from(post)
      .where(and(eq(post.assetId, assetId), eq(post.visibility, 'client_visible')));
    await batchAll(db, [
      db.update(clientAsset).set({ visibility, updatedMs: now }).where(eq(clientAsset.id, assetId)),
      ...(dependentPosts.length > 0
        ? [
            db
              .update(post)
              .set({ visibility: 'internal', updatedMs: now })
              .where(inArray(post.id, dependentPosts.map((p) => p.id))),
          ]
        : []),
    ]);
  } else {
    await db.update(clientAsset).set({ visibility, updatedMs: now }).where(eq(clientAsset.id, assetId));
  }

  const [asset] = await db.select().from(clientAsset).where(eq(clientAsset.id, assetId)).limit(1);
  const byName = await deliveryOutputsByName(db, found.asset.deliveryId);
  return {
    id: asset!.id,
    clientId: asset!.clientId,
    deliveryId: asset!.deliveryId,
    title: asset!.title,
    revisionId: found.delivery.revisionId,
    visibility: asset!.visibility as Visibility,
    editorialStatus: asset!.editorialStatus,
    outputs: Object.values(byName).map(outputRef),
    createdAt: asset!.createdMs,
  };
}
