/**
 * Pure parsing of Zernio post responses (tolerant to `data`/`post` wrappers).
 * Shared by the publish, status and distribution paths; no I/O.
 */
import { isRecord } from '@videomaker/core';
import type { PublishOutcomeKind } from '../ports';

export interface CreatedPlatform {
  platform: string;
  accountId?: string;
  profileId?: string;
  status?: string;
  platformPostUrl?: string;
  errorMessage?: string;
  errorCategory?: string;
  errorSource?: string;
  scheduledFor?: string;
}

export interface CreatedMediaItem {
  url: string;
  type?: string;
  thumbnail?: string;
}

export interface CreatedPost {
  id: string;
  platforms: CreatedPlatform[];
  idempotencyKey?: string;
  requestId?: string;
  profileId?: string;
  /** A supplied malformed post profile cannot be replaced by target-level proof. */
  invalidProfileId?: boolean;
  content?: string;
  mediaItems?: CreatedMediaItem[];
  createdAt?: string;
  scheduledFor?: string;
  queuedFromProfile?: string;
  queueId?: string;
  timezone?: string;
  status?: string;
  errorMessage?: string;
}

export interface ReceiptTarget {
  platform: string;
  accountId?: string;
  profileId?: string;
}

export interface TargetReceipt {
  outcome: PublishOutcomeKind;
  remoteId: string;
  url?: string;
  platform?: CreatedPlatform;
  detail: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value) ? value : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Populated account/profile references are returned as `{ _id }` by GET /posts. */
function identityOf(value: unknown): string | undefined {
  if (typeof value === 'string') return stringField(value);
  if (!isRecord(value)) return undefined;
  return stringField(value._id) ?? stringField(value.id);
}

/** 409 dedupe answer: the id of the already-published post, when present. */
export function duplicatePostId(status: number, body: unknown): string | null {
  if (status !== 409) return null;
  return stringField(asRecord(body).existingPostId) ?? null;
}

/** HTTP 202 may carry only `postId`: an identity hint, not target-state proof. */
export function extractReceiptPostId(body: unknown): string | undefined {
  const root = asRecord(body);
  const data = asRecord(root.data);
  return stringField(root.postId) ?? stringField(data.postId);
}

/** The original mutation is still running; a 409 conflict is not a rejection. */
export function isIdempotencyConflict(status: number, body: unknown): boolean {
  return status === 409 && asRecord(body).code === 'idempotency_conflict';
}

/** Extract one post, never an arbitrary member of a list response. */
export function extractCreatedPost(body: unknown): CreatedPost | null {
  if (!isRecord(body)) return null;
  const root = body;
  const post = asRecord(root.post ?? root.data ?? root);
  const nested = asRecord(post.post ?? post);
  const id = stringField(nested._id) ?? stringField(nested.id) ?? stringField(root.existingPostId);
  if (!id) return null;
  const rawPlatforms: unknown[] = Array.isArray(nested.platforms) ? nested.platforms : [];
  const rawMedia: unknown[] | undefined = Array.isArray(nested.mediaItems) ? nested.mediaItems : undefined;
  return {
    id,
    idempotencyKey: stringField(nested.idempotencyKey),
    requestId: stringField(nested.requestId),
    profileId: identityOf(nested.profileId),
    invalidProfileId: nested.profileId !== undefined && !identityOf(nested.profileId),
    content: typeof nested.content === 'string' ? nested.content : undefined,
    createdAt: stringField(nested.createdAt),
    scheduledFor: stringField(nested.scheduledFor),
    queuedFromProfile: identityOf(nested.queuedFromProfile),
    queueId: identityOf(nested.queueId),
    timezone: stringField(nested.timezone),
    status: stringField(nested.status),
    errorMessage: stringField(nested.errorMessage) ?? stringField(root.error),
    // Malformed media is not partial evidence for payload reconciliation.
    mediaItems: rawMedia?.every((item) => isRecord(item) && stringField(item.url))
      ? rawMedia.map((item) => {
        const media = asRecord(item);
        return {
          url: stringField(media.url) ?? '',
          type: stringField(media.type),
          thumbnail: stringField(media.thumbnail),
        };
      }) : undefined,
    platforms: rawPlatforms.map((item) => {
      const entry = asRecord(item);
      const accountId = identityOf(entry.accountId);
      const profileId = identityOf(entry.profileId);
      // Do not turn a malformed supplied identity into an identity-less match.
      const invalidIdentity = (entry.accountId !== undefined && !accountId) ||
        (entry.profileId !== undefined && !profileId);
      return {
        platform: invalidIdentity ? '' : stringField(entry.platform) ?? '',
        accountId,
        profileId,
        status: stringField(entry.status),
        platformPostUrl: stringField(entry.platformPostUrl),
        errorMessage: stringField(entry.errorMessage),
        errorCategory: stringField(entry.errorCategory),
        errorSource: stringField(entry.errorSource),
        scheduledFor: stringField(entry.scheduledFor),
      };
    }),
  };
}

/**
 * Exact supplied account/profile identities are required; profile proof may be
 * post-level or target-level, but neither may contradict the requested profile.
 * Platform-only callers retain unique-platform matching without identity proof.
 */
export function targetReceiptOf(post: CreatedPost, target: ReceiptTarget): TargetReceipt {
  const uncertain = (detail: string): TargetReceipt => ({
    outcome: 'uncertain', remoteId: post.id, detail,
  });
  if (target.profileId !== undefined &&
    (post.invalidProfileId || (post.profileId !== undefined && target.profileId !== post.profileId))) {
    return uncertain('receipt profile does not match the requested profile');
  }
  let candidates = post.platforms.filter((entry) => entry.platform === target.platform);
  if (target.accountId !== undefined) {
    candidates = candidates.filter((entry) => entry.accountId === target.accountId);
  }
  const platform = candidates[0];
  if (candidates.length !== 1 || !platform) {
    return uncertain('receipt has no unique matching platform/account target');
  }
  if (target.profileId !== undefined) {
    if (platform.profileId !== undefined && target.profileId !== platform.profileId) {
      return uncertain('receipt target profile does not match the requested profile');
    }
    if (post.profileId !== target.profileId && platform.profileId !== target.profileId) {
      return uncertain('receipt has no matching profile proof');
    }
  }
  const status = platform.status?.toLowerCase();
  if (status === 'published') {
    return {
      outcome: 'published', remoteId: post.id, url: platform.platformPostUrl, platform,
      detail: 'target state: published',
    };
  }
  if (status && ['queued', 'pending', 'processing', 'scheduled', 'publishing'].includes(status)) {
    return { outcome: 'accepted', remoteId: post.id, platform, detail: `target state: ${status}` };
  }
  if (status === 'failed') {
    return { outcome: 'failed', remoteId: post.id, platform, detail: 'target state: failed' };
  }
  return { ...uncertain('unknown target state; reconcile required'), platform };
}

/** First URL for legacy distribution views, not proof of a requested target. */
export function postUrlOf(post: CreatedPost): string | undefined {
  for (const platform of post.platforms) {
    if (platform.platformPostUrl) return platform.platformPostUrl;
  }
  return undefined;
}

/**
 * Parses every listed post, leaving identity selection to the caller. `null`
 * means malformed/unknown evidence; `[]` means an explicitly empty list.
 */
export function extractListedPosts(body: unknown): CreatedPost[] | null {
  if (Array.isArray(body)) {
    const posts = body.map(extractCreatedPost);
    return posts.every((post): post is CreatedPost => post !== null) ? posts : null;
  }
  if (!isRecord(body)) return null;
  const list = Array.isArray(body.posts) ? body.posts
    : Array.isArray(body.data) ? body.data : undefined;
  if (list) return extractListedPosts(list);
  if (isRecord(body.data)) return extractListedPosts(body.data);
  const post = extractCreatedPost(body);
  return post ? [post] : null;
}

/** Legacy list view; never use the first item to prove an identity match. */
export function extractFirstListedPost(body: unknown): CreatedPost | null {
  return extractListedPosts(body)?.[0] ?? null;
}
