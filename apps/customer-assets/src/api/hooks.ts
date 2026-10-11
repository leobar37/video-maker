/**
 * TanStack Query hooks (contracts.md §8): every key is user+client scoped
 * (see ./keys) and mutations invalidate exactly the scoped families they
 * touch — hiding an asset cascades to posts/grid caches the same way the
 * server cascades rows.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { AccessInvitation, AccessSnapshot } from '../features/admin/server';
import {
  acceptMyInvitations,
  inviteClientMember,
  issueClientAgentKey,
  listClientAccess,
  mintClientAccessLink,
  revokeAccessGrant,
  revokeAccessInvitation,
  revokeAccessMembership,
  type UiResult,
} from '../features/admin/server';
import { portal } from './client';
import { accessKey, assetsKey, clientsKey, gridKey, materialsKey, meKey, postsKey } from './keys';

const QUERY_DEFAULTS = { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } as const;

/** Current principal; 401 surfaces through `error` (RequireAuth redirects). */
export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: () => portal.me(),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    throwOnError: false,
  });
}

export function useClients(userId: string, enabled = true) {
  return useQuery({
    queryKey: clientsKey(userId),
    queryFn: () => portal.listClients(),
    enabled,
    ...QUERY_DEFAULTS,
  });
}

export function useMaterials(userId: string, clientId: string) {
  return useQuery({
    queryKey: materialsKey(userId, clientId),
    queryFn: () => portal.listMaterials(clientId),
    ...QUERY_DEFAULTS,
  });
}

export function useAssets(userId: string, clientId: string) {
  return useQuery({
    queryKey: assetsKey(userId, clientId),
    queryFn: () => portal.listAssets(clientId),
    ...QUERY_DEFAULTS,
  });
}

export function usePosts(userId: string, clientId: string) {
  return useQuery({
    queryKey: postsKey(userId, clientId),
    queryFn: () => portal.listPosts(clientId),
    ...QUERY_DEFAULTS,
  });
}

/** Admin-only: current grid version + ordered post ids (CAS source). */
export function useGrid(userId: string, clientId: string, enabled = true) {
  return useQuery({
    queryKey: gridKey(userId, clientId),
    queryFn: () => portal.getGrid(clientId),
    enabled,
    ...QUERY_DEFAULTS,
  });
}

export function useAccess(userId: string, clientId: string, enabled = true) {
  return useQuery({
    queryKey: accessKey(userId, clientId),
    queryFn: async () => {
      const result = await listClientAccess({ data: clientId });
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    enabled,
    ...QUERY_DEFAULTS,
  });
}

async function unwrap<T>(result: Promise<UiResult<T>>): Promise<T> {
  const settled = await result;
  if (!settled.ok) throw new Error(settled.message);
  return settled.data;
}

function invalidateClientScope(queryClient: QueryClient, userId: string, clientId: string, kinds: readonly string[]): void {
  for (const kind of kinds) {
    void queryClient.invalidateQueries({ queryKey: [...assetsKey(userId, clientId).slice(0, 3), kind] });
  }
}

export function useSetAssetVisibility(userId: string, clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { assetId: string; visibility: 'internal' | 'client_visible' }) =>
      portal.setAssetVisibility(input.assetId, { visibility: input.visibility }),
    onSuccess: () => {
      // Server cascade (asset → dependent posts) must be mirrored in cache.
      invalidateClientScope(queryClient, userId, clientId, ['assets', 'posts', 'grid']);
    },
  });
}

export function useUpdatePost(userId: string, clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { postId: string; caption?: string | null; visibility?: 'internal' | 'client_visible'; title?: string }) =>
      portal.patchPost(input.postId, { caption: input.caption, visibility: input.visibility, title: input.title }),
    onSuccess: () => invalidateClientScope(queryClient, userId, clientId, ['posts', 'grid']),
  });
}

export function useCreatePost(userId: string, clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof portal.createPost>[1]) => portal.createPost(clientId, input),
    onSuccess: () => invalidateClientScope(queryClient, userId, clientId, ['posts', 'grid']),
  });
}

export interface GridReorderInput {
  order: string[];
  version: number;
}

/**
 * Grid reorder behind the server CAS. A 409 (ApiClientError) reaches the
 * caller so the UI can surface the conflict EXPLICITLY — nothing is applied
 * optimistically, so a conflict can never silently drop an admin's order.
 */
export function usePatchGrid(userId: string, clientId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: GridReorderInput) => {
      const state = await portal.patchGrid(clientId, { version: input.version, order: input.order });
      return state;
    },
    onSuccess: (state) => {
      queryClient.setQueryData(gridKey(userId, clientId), state);
      void queryClient.invalidateQueries({ queryKey: postsKey(userId, clientId) });
    },
  });
}

function useAdminMutation<TInput, TData>(queryClient: QueryClient, userId: string, clientId: string, run: (input: TInput) => Promise<TData>) {
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: accessKey(userId, clientId) });
    },
  });
}

export function useInviteMember(userId: string, clientId: string) {
  const queryClient = useQueryClient();
  return useAdminMutation<{ email: string }, AccessInvitation>(
    queryClient,
    userId,
    clientId,
    (input) => unwrap(inviteClientMember({ data: { clientId, email: input.email } })),
  );
}

/** Minted link shape (url/email/expiresAt) handed to the admin exactly once. */
export interface MintedAccessLink {
  url: string;
  email: string;
  expiresAt: number;
  singleUse: true;
}

export function useMintAccessLink(userId: string, clientId: string) {
  const queryClient = useQueryClient();
  return useAdminMutation<{ email: string; expiresIn?: string }, MintedAccessLink>(
    queryClient,
    userId,
    clientId,
    (input) => unwrap(mintClientAccessLink({ data: { clientId, email: input.email, expiresIn: input.expiresIn } })),
  );
}

export function useRevokeMembership(userId: string, clientId: string) {
  const queryClient = useQueryClient();
  return useAdminMutation<string, unknown>(
    queryClient,
    userId,
    clientId,
    (membershipId) => unwrap(revokeAccessMembership({ data: membershipId })),
  );
}

export function useRevokeInvitation(userId: string, clientId: string) {
  const queryClient = useQueryClient();
  return useAdminMutation<string, unknown>(
    queryClient,
    userId,
    clientId,
    (invitationId) => unwrap(revokeAccessInvitation({ data: invitationId })),
  );
}

export interface IssueKeyInput {
  email: string;
  name: string;
  scopes: string[];
  workspaceWide: boolean;
}

export function useIssueAgentKey(userId: string, clientId: string) {
  const queryClient = useQueryClient();
  return useAdminMutation<IssueKeyInput, { key: string; keyId: string; grantId: string }>(
    queryClient,
    userId,
    clientId,
    (input) => unwrap(issueClientAgentKey({ data: { clientId: clientId, email: input.email, name: input.name, scopes: input.scopes, workspaceWide: input.workspaceWide } })),
  );
}

export function useRevokeGrant(userId: string, clientId: string) {
  const queryClient = useQueryClient();
  return useAdminMutation<string, unknown>(
    queryClient,
    userId,
    clientId,
    (grantId) => unwrap(revokeAccessGrant({ data: grantId })),
  );
}

export function useAcceptInvitations(onAccepted: (clientIds: string[]) => void) {
  return useMutation({
    mutationFn: async () => {
      const result = await acceptMyInvitations();
      if (!result.ok) throw new Error(result.message);
      return result.data;
    },
    onSuccess: (data) => onAccepted(data.clientIds),
  });
}

export type { AccessSnapshot };
