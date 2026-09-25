/**
 * Social-track / distribution surface.
 *
 * Endpoints that report and manage where a published post landed across
 * platforms:
 * - `GET  /posts/:id`          → per-platform distribution status + public URL
 * - `POST /posts/:id/retry`    → re-run a failed platform distribution
 * - `POST /posts/:id/edit`     → per-platform caption edit (where the net allows)
 * - `GET  /queue/slots`, `GET /queue/preview` → the profile's publishing queue
 * - `GET  /analytics/best-time` → best-time slots per account
 *
 * Plus the pure social-track merge rule (`mergeDistributionEntry`) used to
 * record one network's entry in a local distribution map.
 */
import type { ProviderContext } from '../ports';
import { assertRunMode } from '../storage/context';
import type { ZernioClient } from './client';
import { extractCreatedPost, postUrlOf, type CreatedPost } from './post-response';

export class ZernioDistributionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZernioDistributionError';
  }
}

/** One network's distribution entry (social-track shape). */
export interface SocialEntry {
  status: 'pending' | 'published' | 'failed';
  account?: string;
  url?: string;
  mediaId?: string;
  publishedAt?: string;
  notes?: string;
}

export type DistributionMap = Record<string, SocialEntry>;

/**
 * Social-track upsert: merges one network's entry over the previous one, with
 * the incoming status always winning. Pure.
 */
export function mergeDistributionEntry(
  distribution: DistributionMap | undefined,
  network: string,
  entry: SocialEntry,
): DistributionMap {
  return {
    ...(distribution ?? {}),
    [network]: { ...(distribution?.[network] ?? {}), ...entry, status: entry.status },
  };
}

export interface DistributionEntry {
  platform: string;
  status?: string;
  url?: string;
}

export interface PostDistribution {
  remoteId: string;
  url?: string;
  entries: DistributionEntry[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Distribution view of one post (platform + status + public URL). */
export function toDistribution(post: CreatedPost): PostDistribution {
  return {
    remoteId: post.id,
    url: postUrlOf(post),
    entries: post.platforms.map((platform) => ({
      platform: platform.platform,
      status: platform.status,
      url: platform.platformPostUrl,
    })),
  };
}

export interface BestTimeSlot {
  dayOfWeek: number;
  hour: number;
  avgEngagement?: number;
}

/** Parses the `/analytics/best-time` slots (tolerant snake/camel casing). */
export function parseBestTimeSlots(body: unknown): BestTimeSlot[] {
  const root = asRecord(body);
  const raw = (Array.isArray(root.slots) ? root.slots : Array.isArray(root.data) ? root.data : []) as
    unknown[];
  const slots: BestTimeSlot[] = [];
  for (const item of raw) {
    const entry = asRecord(item);
    const dayOfWeek = Number(entry.day_of_week ?? entry.dayOfWeek);
    const hour = Number(entry.hour);
    if (!Number.isFinite(dayOfWeek) || !Number.isFinite(hour)) continue;
    const engagement = Number(entry.avg_engagement ?? entry.avgEngagement);
    slots.push({
      dayOfWeek,
      hour,
      ...(Number.isFinite(engagement) ? { avgEngagement: engagement } : {}),
    });
  }
  return slots;
}

/** Ranks best-time slots by engagement, strongest first (top 5). */
export function rankBestTimeSlots(slots: BestTimeSlot[], limit = 5): BestTimeSlot[] {
  return [...slots]
    .sort((a, b) => (b.avgEngagement ?? 0) - (a.avgEngagement ?? 0))
    .slice(0, limit);
}

const LIMA_UTC_OFFSET_HOURS = -5;

/** Next UTC occurrence of a weekly slot (dayOfWeek 0 = Monday) after `from`. */
export function nextUtcOccurrence(dayOfWeek: number, hourUtc: number, from: Date): Date {
  const fromDow = (from.getUTCDay() + 6) % 7;
  let dayDelta = (dayOfWeek - fromDow + 7) % 7;
  let candidate = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + dayDelta, hourUtc),
  );
  if (candidate.getTime() <= from.getTime()) {
    dayDelta += 7;
    candidate = new Date(
      Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + dayDelta, hourUtc),
    );
  }
  return candidate;
}

/** Human label for a UTC instant in the operator timezone (UTC-5). */
export function limaLabel(utc: Date): string {
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const local = new Date(utc.getTime() + LIMA_UTC_OFFSET_HOURS * 3_600_000);
  return `${days[(local.getUTCDay() + 6) % 7]} ${String(local.getUTCHours()).padStart(2, '0')}:00 (UTC-5)`;
}

export interface QueueSlot {
  dayOfWeek?: number;
  hourUtc?: number;
  [key: string]: unknown;
}

/** Distribution/queue/best-time endpoints over the Zernio client. */
export class ZernioDistribution {
  constructor(private readonly client: ZernioClient) {}

  /** `GET /posts/:id` — per-platform distribution of a published post. */
  async postDistribution(postId: string, ctx: ProviderContext): Promise<PostDistribution> {
    assertRunMode(ctx, 'Zernio distribution lookup');
    const { status, body } = await this.client.request(`/posts/${encodeURIComponent(postId)}`);
    if (status !== 200) {
      throw new ZernioDistributionError(`GET /posts/${postId} → HTTP ${status}.`);
    }
    const post = extractCreatedPost(body);
    if (!post) throw new ZernioDistributionError(`GET /posts/${postId} returned no parseable post.`);
    return toDistribution(post);
  }

  /** `POST /posts/:id/retry` — re-run a failed platform distribution. */
  async retry(postId: string, ctx: ProviderContext): Promise<PostDistribution> {
    assertRunMode(ctx, 'Zernio distribution retry');
    const { status, body } = await this.client.request(`/posts/${encodeURIComponent(postId)}/retry`, {
      method: 'POST',
    });
    if (status !== 200 && status !== 201) {
      throw new ZernioDistributionError(`POST /posts/${postId}/retry → HTTP ${status}.`);
    }
    const post = extractCreatedPost(body);
    if (!post) throw new ZernioDistributionError('Retry response carried no parseable post.');
    return toDistribution(post);
  }

  /** `POST /posts/:id/edit` — per-platform caption edit (where the net allows). */
  async editCaption(
    postId: string,
    platform: string,
    content: string,
    ctx: ProviderContext,
  ): Promise<void> {
    assertRunMode(ctx, 'Zernio caption edit');
    const { status } = await this.client.request(`/posts/${encodeURIComponent(postId)}/edit`, {
      method: 'POST',
      body: { platform, content },
    });
    if (status !== 200 && status !== 201) {
      throw new ZernioDistributionError(`POST /posts/${postId}/edit → HTTP ${status}.`);
    }
  }

  /** `GET /queue/slots` — the profile's publishing queue slots. */
  async queueSlots(profileId: string, ctx: ProviderContext): Promise<unknown> {
    assertRunMode(ctx, 'Zernio queue slots');
    const { status, body } = await this.client.request(
      `/queue/slots?profileId=${encodeURIComponent(profileId)}`,
    );
    if (status !== 200) throw new ZernioDistributionError(`GET /queue/slots → HTTP ${status}.`);
    return body;
  }

  /** `GET /queue/preview` — next queued posts of a profile. */
  async queuePreview(profileId: string, count: number, ctx: ProviderContext): Promise<unknown> {
    assertRunMode(ctx, 'Zernio queue preview');
    const { status, body } = await this.client.request(
      `/queue/preview?profileId=${encodeURIComponent(profileId)}&count=${encodeURIComponent(String(count))}`,
    );
    if (status !== 200) throw new ZernioDistributionError(`GET /queue/preview → HTTP ${status}.`);
    return body;
  }

  /** `GET /analytics/best-time` — ranked best-time slots for an account. */
  async bestTime(
    platform: string,
    accountId: string,
    ctx: ProviderContext,
    limit = 5,
  ): Promise<BestTimeSlot[]> {
    assertRunMode(ctx, 'Zernio best-time lookup');
    const { status, body } = await this.client.request(
      `/analytics/best-time?platform=${encodeURIComponent(platform)}&accountId=${encodeURIComponent(accountId)}`,
    );
    if (status !== 200) {
      throw new ZernioDistributionError(`GET /analytics/best-time → HTTP ${status}.`);
    }
    return rankBestTimeSlots(parseBestTimeSlots(body), limit);
  }
}
