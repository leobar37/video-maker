/**
 * TanStack Query keys and cache hygiene (NFR-005, contracts.md §8):
 * every client-scoped key carries BOTH the user id and the client id, so a
 * session can never render another user's or another client's cached data.
 * `resetPortalCache` wipes on user change; `prunePortalCacheForClient` drops
 * other clients' scoped entries on client switch.
 */

import type { QueryClient } from '@tanstack/react-query';

/** `['me']` — current principal (single instance per document). */
export const meKey = ['me'] as const;

export function clientsKey(userId: string) {
  return ['clients', userId] as const;
}

/**
 * Prefix of every client-scoped entry: `['client', userId, clientId, ...kind]`.
 * Kind stays in the key so list/detail caches never collide.
 */
export function clientScopeKey(userId: string, clientId: string) {
  return ['client', userId, clientId] as const;
}

export function materialsKey(userId: string, clientId: string) {
  return [...clientScopeKey(userId, clientId), 'materials'] as const;
}

export function assetsKey(userId: string, clientId: string) {
  return [...clientScopeKey(userId, clientId), 'assets'] as const;
}

export function postsKey(userId: string, clientId: string) {
  return [...clientScopeKey(userId, clientId), 'posts'] as const;
}

export function gridKey(userId: string, clientId: string) {
  return [...clientScopeKey(userId, clientId), 'grid'] as const;
}

export function accessKey(userId: string, clientId: string) {
  return [...clientScopeKey(userId, clientId), 'access'] as const;
}

export interface SessionRef {
  /** null while anonymous. */
  userId: string | null;
}

function isScopedToOtherClient(queryKey: readonly unknown[], clientId: string): boolean {
  return queryKey[0] === 'client' && queryKey[2] !== clientId;
}

/**
 * Cache hygiene on identity change. A user change (login/logout/different
 * member) clears EVERYTHING — no cross-user cache or miniature can survive.
 * The same-user case has nothing user-scoped to drop; client-level hygiene is
 * `prunePortalCacheForClient`.
 */
export function resetPortalCache(queryClient: QueryClient, previous: SessionRef, next: SessionRef): void {
  if (previous.userId !== next.userId) queryClient.clear();
}

/**
 * Client-switch prune for the CURRENT user: removes every `['client', userId,
 * otherClientId, ...]` entry so a stale miniature/list of the previously open
 * client can never be rendered. `me` and the clients list are kept.
 */
export function prunePortalCacheForClient(queryClient: QueryClient, userId: string, clientId: string): void {
  queryClient.removeQueries({
    predicate: (query) => isScopedToOtherClient(query.queryKey, clientId),
  });
}

/** Logout wipe: nothing cached survives a session end. */
export function wipePortalCache(queryClient: QueryClient): void {
  queryClient.clear();
}
