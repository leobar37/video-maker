/**
 * Provider ports — the seam between the paid-operation engine and concrete
 * adapters (media, object storage, social publication). Pure types plus
 * injectable primitives: no network, no secrets, no origin-monorepo imports.
 *
 * Invariant: in `mode: 'plan'` no port implementation may touch the network
 * or resolve secrets (NFR-002). Secrets travel only in provider headers and
 * are never placed in metadata, journals, receipts or logs (NFR-001).
 */
import type { Mode } from '@videomaker/credentials';

export type FetchLike = typeof fetch;

export interface Clock {
  now(): Date;
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ProcessRunner {
  run(
    command: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<ProcessResult>;
}

/** Secret lookup seam: the only door to @videomaker/credentials. */
export interface SecretSource {
  getSecret(name: string, mode: Mode): Promise<string>;
}

export interface ProviderContext {
  /** 'plan' never touches network or secrets. */
  mode: Mode;
  secrets: SecretSource;
  fetchImpl: FetchLike;
  clock: Clock;
  process?: ProcessRunner;
  /** Callers must never pass secret values into log lines. */
  logger?: (msg: string) => void;
}

/** Receipt is mandatory evidence of a paid submit; without it state stays 'uncertain'. */
export interface PaidReceipt {
  provider: string;
  providerJobId: string;
  submittedAt: string;
  costUsd?: number;
  /** Non-secret response metadata only. */
  raw?: Record<string, unknown>;
}

export type MediaJobState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface MediaJobStatus {
  state: MediaJobState;
  detail?: string;
}

export interface MediaArtifact {
  url: string;
  sha256?: string;
  bytes?: number;
  contentType?: string;
  /** Provider-specific non-secret payload (e.g. TTS timestamps). */
  extra?: Record<string, unknown>;
}

export type MediaKind = 'video' | 'avatar' | 'tts' | 'music' | 'image';

export interface MediaSubmitInput {
  kind: MediaKind;
  params: Record<string, unknown>;
  /** Digest of the paid plan (see @videomaker/core paidPlanDigest). */
  planDigest: string;
  /** Unique per intended spend; drives submit-once semantics. */
  idempotencyKey: string;
}

export interface MediaProvider {
  readonly id: string;
  /** Exactly one live submit per idempotencyKey (submit-once; never auto-retry). */
  submit(
    input: MediaSubmitInput,
    ctx: ProviderContext,
  ): Promise<{ receipt: PaidReceipt; status: MediaJobStatus }>;
  status(receipt: PaidReceipt, ctx: ProviderContext): Promise<MediaJobStatus>;
  result(receipt: PaidReceipt, ctx: ProviderContext): Promise<MediaArtifact>;
}

export interface ObjectMeta {
  key: string;
  bytes: number;
  sha256?: string;
  etag?: string;
  contentType?: string;
  publicUrl?: string;
}

export interface ObjectStore {
  head(key: string, ctx: ProviderContext): Promise<ObjectMeta | null>;
  put(
    key: string,
    body: Uint8Array,
    opts: { contentType?: string },
    ctx: ProviderContext,
  ): Promise<ObjectMeta>;
  get(key: string, ctx: ProviderContext): Promise<Uint8Array>;
  /** Metadata plus checksum verification (sha256 of stored object). */
  inspect(key: string, ctx: ProviderContext): Promise<ObjectMeta>;
}

export interface BucketAdmin {
  /** Guard: bucket and public URL must answer coherently before mutating manifests. */
  verifyPublicUrlCoherence(
    bucket: string,
    publicUrl: string,
    ctx: ProviderContext,
  ): Promise<{ ok: boolean; detail?: string }>;
}

export type PublishOutcomeKind = 'accepted' | 'published' | 'failed' | 'uncertain';

export interface PublishOutcome {
  outcome: PublishOutcomeKind;
  idempotencyKey: string;
  remoteId?: string;
  url?: string;
  detail?: string;
}

export interface TikTokSettings {
  privacy_level: 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'SELF_ONLY';
  allow_comment: boolean;
  allow_duet: boolean;
  allow_stitch: boolean;
  content_preview_confirmed: boolean;
  express_consent_given: boolean;
  video_made_with_ai?: boolean;
  video_cover_image_url?: string;
}

export interface SocialPost {
  idempotencyKey: string;
  account: string;
  text: string;
  /** Public media URLs. */
  media: string[];
  scheduledFor?: string;
  tags?: string[];
  /** Explicit profile scope; omitted by legacy callers. */
  profileId?: string;
  title?: string;
  coverUrl?: string;
  tiktokSettings?: TikTokSettings;
  youtube?: {
    title: string;
    visibility: 'public' | 'private' | 'unlisted';
    madeForKids: boolean;
    containsSyntheticMedia?: boolean;
    categoryId?: string;
  };
}

export interface PublisherAccount {
  id: string;
  handle?: string;
  healthy: boolean;
  detail?: string;
}

export interface Publisher {
  readonly id: string;
  accounts(ctx: ProviderContext): Promise<PublisherAccount[]>;
  validate(
    post: SocialPost,
    ctx: ProviderContext,
  ): Promise<{ ok: boolean; problems: string[] }>;
  publish(post: SocialPost, ctx: ProviderContext): Promise<PublishOutcome>;
  schedule(post: SocialPost, ctx: ProviderContext): Promise<PublishOutcome>;
  status(idempotencyKey: string, ctx: ProviderContext): Promise<PublishOutcome>;
  reconcile(idempotencyKey: string, ctx: ProviderContext): Promise<PublishOutcome>;
}
