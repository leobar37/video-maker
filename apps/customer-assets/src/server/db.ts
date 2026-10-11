import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './db/auth-schema';

/** Named contract for the portal D1 access layer (drizzle over D1 binding). */
export type PortalDb = DrizzleD1Database<typeof schema>;

/**
 * Portal D1 access. Bindings are always passed in explicitly so server
 * modules stay testable against emulated Workers runtime without any host
 * (Node/Bun) imports.
 */
export function createDb(d1: D1Database): PortalDb {
  return drizzle(d1, { schema });
}

export { schema as authSchema };
