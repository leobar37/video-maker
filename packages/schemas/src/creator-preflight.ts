import { z } from 'zod';

const remoteIdentity = z.string().min(1);

/** Read-only remote DTOs; selected identities are checked by the preflight consumer. */
export const CreatorPreflightRemoteProfileSchema = z.object({
  _id: remoteIdentity.optional(), id: remoteIdentity.optional(), name: remoteIdentity,
}).refine((profile) => profile._id !== undefined || profile.id !== undefined);
export type CreatorPreflightRemoteProfile = z.infer<typeof CreatorPreflightRemoteProfileSchema>;

/** Preserve unknown rows so malformed, unrelated identities do not invalidate the envelope. */
export const CreatorPreflightRemoteProfilesSchema = z.union([
  z.array(z.unknown()),
  z.object({ profiles: z.array(z.unknown()).optional(), data: z.array(z.unknown()).optional() })
    .refine((body) => body.profiles !== undefined || body.data !== undefined)
    .transform((body) => body.profiles ?? body.data ?? []),
]);
export type CreatorPreflightRemoteProfiles = z.infer<typeof CreatorPreflightRemoteProfilesSchema>;

export const CreatorPreflightRemoteAccountsSchema = z.object({ accounts: z.array(z.unknown()) });
export type CreatorPreflightRemoteAccounts = z.infer<typeof CreatorPreflightRemoteAccountsSchema>;

export const CreatorPreflightRemoteAccountSchema = z.object({
  _id: remoteIdentity.optional(), id: remoteIdentity.optional(), accountId: remoteIdentity.optional(),
  platform: remoteIdentity, username: remoteIdentity,
}).refine((account) => account._id !== undefined || account.id !== undefined || account.accountId !== undefined);
export type CreatorPreflightRemoteAccount = z.infer<typeof CreatorPreflightRemoteAccountSchema>;

export const CreatorPreflightRemoteHealthSchema = z.object({
  accountId: remoteIdentity.optional(), id: remoteIdentity.optional(),
  status: remoteIdentity, canPost: z.boolean(), username: remoteIdentity.optional(), platform: remoteIdentity.optional(),
}).refine((health) => health.accountId !== undefined || health.id !== undefined);
export type CreatorPreflightRemoteHealth = z.infer<typeof CreatorPreflightRemoteHealthSchema>;
