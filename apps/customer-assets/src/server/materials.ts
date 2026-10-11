import { and, desc, eq, lt, or } from 'drizzle-orm';
import type { MaterialView, Page } from '@videomaker/customer-assets';
import type { PortalDb } from './db';
import { material } from './db/schema';
import {
  authorizeClient,
  decodeCursor,
  encodeCursor,
  notFound,
  type ListOptions,
  type Principal,
} from './access';
import { serveStoredObject, type ServeOutcome } from './storage';

/**
 * Private material catalog (contracts.md §6): every read is filtered by the
 * live membership/grant decision, never by UI state alone. Object keys stay
 * server-internal; downloads always resolve the immutable object through the
 * material row (never through client-supplied keys or paths).
 */

export type MaterialRow = typeof material.$inferSelect;

interface CursorTuple {
  ms: number;
  id: string;
}

/** Keyset page over (created_ms, id) DESC; opaque cursor; bounded limit. */
export async function listMaterialsForClient(
  db: PortalDb,
  principal: Principal,
  clientId: string,
  options: ListOptions,
): Promise<Page<MaterialView>> {
  await authorizeClient(db, principal, clientId, 'materials:read');

  let cursor: CursorTuple | null = null;
  if (options.cursor !== undefined && options.cursor !== null) {
    cursor = decodeCursor(options.cursor);
    if (cursor === null) return { items: [], nextCursor: null };
  }

  const where = cursor
    ? and(
        eq(material.clientId, clientId),
        or(
          lt(material.createdMs, cursor.ms),
          and(eq(material.createdMs, cursor.ms), lt(material.id, cursor.id)),
        ),
      )
    : eq(material.clientId, clientId);

  const rows = await db
    .select()
    .from(material)
    .where(where)
    .orderBy(desc(material.createdMs), desc(material.id))
    .limit(options.limit ?? 50);

  const items = rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    name: row.originalName ?? row.id,
    mediaType: row.mediaType as MaterialView['mediaType'],
    bytes: row.bytes,
    sha256: row.sha256,
    status: 'ready' as const,
    createdAt: row.createdMs,
  }));
  const last = rows.at(-1);
  const hasMore = items.length === (options.limit ?? 50);
  return {
    items,
    nextCursor: last !== undefined && hasMore ? encodeCursor(last.createdMs, last.id) : null,
  };
}

export async function getMaterialForPrincipal(
  db: PortalDb,
  principal: Principal,
  materialId: string,
  scope: string,
): Promise<MaterialRow> {
  const [row] = await db.select().from(material).where(eq(material.id, materialId)).limit(1);
  if (!row) throw notFound();
  await authorizeClient(db, principal, row.clientId, scope);
  return row;
}

/** GET|HEAD /api/v1/materials/:id/content — auth-checked private streaming. */
export async function serveMaterialContent(
  db: PortalDb,
  bucket: R2Bucket,
  principal: Principal,
  materialId: string,
  request: Request,
): Promise<ServeOutcome> {
  const row = await getMaterialForPrincipal(db, principal, materialId, 'materials:read');
  return serveStoredObject(request, bucket, {
    key: row.objectKey,
    size: row.bytes,
    contentType: row.mediaType,
    filename: row.originalName ?? row.id,
  });
}

/** Quota/report helper for fixtures and the future admin surface. */
export async function materialBytesForClient(db: PortalDb, clientId: string): Promise<number> {
  const rows = await db
    .select({ bytes: material.bytes })
    .from(material)
    .where(eq(material.clientId, clientId));
  return rows.reduce((sum, r) => sum + r.bytes, 0);
}
