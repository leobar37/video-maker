import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
/** Video destinations supported by this workflow's Zernio adapter. */
export const CreatorPlatformSchema = z.enum(['tiktok', 'youtube', 'linkedin', 'twitter', 'facebook', 'instagram']);
const target = {
  accountId: z.string().min(1), username: z.string().min(1),
  constraints: z.object({ maxDurationSeconds: z.number().positive().optional(), maxTextCharacters: z.number().int().positive().optional(), maxTitleCharacters: z.number().int().positive().optional() }).strict().optional(),
};
const TargetSchema = z.discriminatedUnion('platform', [
  z.object({ ...target, platform: z.literal('tiktok'), options: z.object({ privacyLevel: z.enum(['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'SELF_ONLY']), allowComment: z.boolean(), allowDuet: z.boolean(), allowStitch: z.boolean() }).strict() }).strict(),
  z.object({ ...target, platform: z.literal('youtube'), options: z.object({ visibility: z.enum(['public', 'private', 'unlisted']), madeForKids: z.boolean(), categoryId: z.string().regex(/^\d+$/).optional() }).strict() }).strict(),
  z.object({ ...target, platform: z.enum(['linkedin', 'twitter', 'facebook', 'instagram']), options: z.object({}).strict().optional() }).strict(),
]);
export const CreatorPresetSchema = z.object({
  schemaVersion: z.literal(1), id: slug, version: z.number().int().positive(), name: z.string().min(1),
  identity: z.object({ palette: z.array(z.string()), fonts: z.array(z.string()), tone: z.string(), rules: z.array(z.string()) }),
  editing: z.object({
    width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive(),
    audio: z.object({ tracks: z.number().int().positive(), targetLufs: z.number(), maxTruePeakDbtp: z.number(), lufsTolerance: z.number().nonnegative().optional() }).passthrough(),
    render: z.object({ videoCodec: z.string().min(1), audioCodec: z.string().min(1), pixelFormat: z.string().optional(), sampleRate: z.number().int().positive().optional() }).passthrough(),
  }).passthrough(),
  publishing: z.object({
    provider: z.literal('zernio'), profile: z.object({ name: z.string().min(1), id: z.string().min(1) }).strict(),
    targets: z.array(TargetSchema).min(1).refine((targets) => new Set(targets.map((t) => t.accountId)).size === targets.length, 'unique target accounts required'),
    maxHashtags: z.number().int().nonnegative(), discloseSyntheticMediaWhenPresent: z.literal(true),
  }).strict(),
  safety: z.object({ publishRequiresExplicitApproval: z.literal(true), paidGenerationRequiresNewBudgetApproval: z.literal(true), neverRetryUncertainPublication: z.literal(true), uploadOnlyFinalAndCover: z.literal(true), preserveOriginals: z.literal(true) }),
});
export type CreatorPreset = z.infer<typeof CreatorPresetSchema>;
export const CreatorDraftSchema = z.object({
  schemaVersion: z.literal(1), video: z.string(), cover: z.string(), title: z.string(), content: z.string(),
  platformContent: z.partialRecord(CreatorPlatformSchema, z.string()), tags: z.array(z.string().min(1)), syntheticMedia: z.boolean().nullable(),
  approval: z.object({ approved: z.boolean(), digest: hash.nullable() }).strict(),
}).strict();
export type CreatorDraft = z.infer<typeof CreatorDraftSchema>;
export const CreatorProjectSchema = z.object({
  schemaVersion: z.literal(1), id: slug, title: z.string().min(1),
  preset: z.object({ id: slug, version: z.number().int().positive(), sha256: hash }).strict(),
}).strict();
export type CreatorProject = z.infer<typeof CreatorProjectSchema>;
export const CreatorQaSchema = z.object({
  schemaVersion: z.literal(1), videoSha256: hash, coverSha256: hash,
  width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive(), videoCodec: z.string(), audioCodec: z.string(), audioTracks: z.number().int().positive(),
  pixelFormat: z.string().optional(), sampleRate: z.number().int().positive().optional(),
  duration: z.number().positive(), integratedLufs: z.number(), truePeakDbtp: z.number(),
  decoded: z.literal(true), coverDecoded: z.literal(true), coverWidth: z.number().int().positive(), coverHeight: z.number().int().positive(), coverCodec: z.literal('png'),
}).strict();
export type CreatorMediaQa = z.infer<typeof CreatorQaSchema>;
export const CreatorProbeSchema = z.object({
  streams: z.array(z.object({ codec_type: z.string(), codec_name: z.string(), width: z.number().optional(), height: z.number().optional(), avg_frame_rate: z.string().optional(), duration: z.string().optional(), pix_fmt: z.string().optional(), sample_rate: z.string().optional() })),
  format: z.object({ duration: z.string().optional() }),
});
const TikTokInteractionSchema = z.object({
  enabled: z.boolean(), required: z.boolean(), default: z.boolean(), label: z.string(),
});
export const CreatorTikTokInfoSchema = z.object({
  nickname: z.string(), avatarUrl: z.string(), isVerified: z.boolean(), canPostMore: z.boolean(),
});
/** Zernio `GET /accounts/{id}/tiktok/creator-info?mediaType=video` (documented camelCase). */
export const CreatorTikTokEnvelopeSchema = z.object({
  creator: CreatorTikTokInfoSchema,
  privacyLevels: z.array(z.object({ value: z.string(), label: z.string() })),
  postingLimits: z.object({
    maxVideoDurationSec: z.number().int().positive(),
    interactionSettings: z.object({
      allow_comment: TikTokInteractionSchema,
      allow_duet: TikTokInteractionSchema.nullable(),
      allow_stitch: TikTokInteractionSchema.nullable(),
    }),
  }),
});
export type CreatorTikTokCapability = z.infer<typeof CreatorTikTokEnvelopeSchema>;
export const CreatorIntentSchema = z.object({
  schemaVersion: z.literal(1), idempotencyKey: z.string().regex(/^creator:[a-f0-9]{64}$/),
  platform: CreatorPlatformSchema, accountId: z.string().min(1), projectId: z.string(), videoSha256: hash, digest: hash,
}).strict();
export type CreatorIntent = z.infer<typeof CreatorIntentSchema>;
export const CreatorTargetResultSchema = z.object({
  platform: CreatorPlatformSchema, accountId: z.string().optional(), idempotencyKey: z.string(), state: z.enum(['published', 'pending', 'failed', 'uncertain', 'not-started']),
  remoteId: z.string().optional(), url: z.string().optional(), detail: z.string().optional(),
}).strict();
export type CreatorTargetResult = z.infer<typeof CreatorTargetResultSchema>;
export const CreatorRemotePostSchema = z.object({
  _id: z.string().optional(), id: z.string().optional(), idempotencyKey: z.string().optional(),
  platforms: z.array(z.object({ platform: z.string(), status: z.string().optional(), platformPostUrl: z.string().optional(), errorMessage: z.string().optional() })).default([]),
});
export const CreatorLookupSchema = z.object({ post: CreatorRemotePostSchema.optional(), posts: z.array(CreatorRemotePostSchema).optional(), data: z.union([CreatorRemotePostSchema, z.array(CreatorRemotePostSchema)]).optional() });
