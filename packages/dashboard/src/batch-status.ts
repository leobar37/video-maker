import {
  CreatorBatchProgressSchema,
  type CreatorBatchProgress,
  type CreatorBatchTargetProgress,
} from '@videomaker/schemas';

export interface PublicCreatorBatchTargetStatus {
  readonly clipOrdinal: number;
  readonly targetOrdinal: number;
  readonly platform: CreatorBatchTargetProgress['platform'];
  readonly state: CreatorBatchTargetProgress['state'];
  readonly checkedAt?: string;
  readonly url?: string;
}

export interface PublicCreatorBatchCapacityStatus {
  readonly observationOrdinal: number;
  readonly platform: CreatorBatchTargetProgress['platform'];
  readonly status: 'confirmed' | 'estimated' | 'unknown';
  readonly checkedAt: string | null;
  readonly remaining?: number;
  readonly available?: number;
  readonly canPostMore?: boolean;
  readonly resetAt?: string;
  readonly nextRetryAt?: string;
}

export interface PublicCreatorBatchStatus {
  readonly schemaVersion: 1;
  /** Observation time from the supplied snapshot, not the time this report was rendered. */
  readonly checkedAt: string;
  readonly clipCount: number;
  readonly refresh: 'manual';
  readonly autoMonitoring: false;
  readonly summary: Readonly<{
    total: number;
    published: number;
    pending: number;
    notStarted: number;
    uncertain: number;
    failed: number;
    blocked: number;
  }>;
  readonly complete: boolean;
  readonly targets: readonly PublicCreatorBatchTargetStatus[];
  readonly capacity?: readonly PublicCreatorBatchCapacityStatus[];
}

/** Fail closed: public post routes only, not provider receipts, media or arbitrary HTTPS URLs. */
function publicPostUrl(platform: CreatorBatchTargetProgress['platform'], value: string | undefined): string | undefined {
  if (!value || !/^https:\/\//i.test(value) || /[\s\u0000-\u001f\u007f\\%]/u.test(value)
    || /\/\.{1,2}(?:\/|[?#]|$)/.test(value) || value.length > 2048) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return undefined;
  const host = url.hostname;
  const pathname = url.pathname;
  const noQuery = url.search === '';
  const exactQuery = (keys: string[]): boolean => {
    const entries = [...url.searchParams.keys()];
    return entries.length === keys.length && keys.every((key) => entries.includes(key));
  };
  let recognized = false;
  switch (platform) {
    case 'tiktok':
      recognized = ['tiktok.com', 'www.tiktok.com'].includes(host) && noQuery
        && /^\/@[A-Za-z0-9_.]{1,24}\/video\/[0-9]+\/?$/.test(pathname);
      break;
    case 'youtube':
      if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
        recognized = (pathname === '/watch' && exactQuery(['v']) && /^[A-Za-z0-9_-]{11}$/.test(url.searchParams.get('v') ?? ''))
          || (noQuery && /^\/shorts\/[A-Za-z0-9_-]{11}\/?$/.test(pathname));
      } else if (host === 'youtu.be') {
        recognized = noQuery && /^\/[A-Za-z0-9_-]{11}\/?$/.test(pathname);
      }
      break;
    case 'instagram':
      recognized = ['instagram.com', 'www.instagram.com'].includes(host) && noQuery
        && /^\/(?:p|reel|tv)\/[A-Za-z0-9_-]{1,64}\/?$/.test(pathname);
      break;
    case 'twitter':
      recognized = ['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com'].includes(host) && noQuery
        && (/^\/[A-Za-z0-9_]{1,15}\/status\/[0-9]+\/?$/.test(pathname) || /^\/i\/web\/status\/[0-9]+\/?$/.test(pathname));
      break;
    case 'linkedin':
      recognized = ['linkedin.com', 'www.linkedin.com'].includes(host) && noQuery
        && (/^\/feed\/update\/urn:li:activity:[0-9]+\/?$/.test(pathname)
          || /^\/posts\/[A-Za-z0-9_-]+-activity-[0-9]+-[A-Za-z0-9_-]+\/?$/.test(pathname));
      break;
    case 'facebook':
      if (['facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(host)) {
        recognized = (noQuery && (/^\/[A-Za-z0-9.]+\/posts\/(?:[0-9]+|pfbid[A-Za-z0-9]+)\/?$/.test(pathname)
          || /^\/reel\/[0-9]+\/?$/.test(pathname)))
          || (pathname === '/watch/' && exactQuery(['v']) && /^[0-9]+$/.test(url.searchParams.get('v') ?? ''))
          || (pathname === '/permalink.php' && exactQuery(['story_fbid', 'id'])
            && /^(?:[0-9]+|pfbid[A-Za-z0-9]+)$/.test(url.searchParams.get('story_fbid') ?? '')
            && /^[0-9]+$/.test(url.searchParams.get('id') ?? ''));
      }
      break;
  }
  return recognized ? url.href : undefined;
}

/** Pure, detached public snapshot. It performs no network checks or publication actions. */
export function buildPublicCreatorBatchStatus(progress: CreatorBatchProgress): PublicCreatorBatchStatus {
  const snapshot = CreatorBatchProgressSchema.parse(progress);
  const observed = new Map(snapshot.targets.map((target) => [JSON.stringify([target.projectId, target.platform, target.accountId]), target]));
  const targets = snapshot.manifest.projects.flatMap((project, clipIndex) => project.targets.map((required, targetIndex) => {
    // Schema validation guarantees every approved destination occurs exactly once.
    const target = observed.get(JSON.stringify([project.projectId, required.platform, required.accountId]))!;
    const row: { -readonly [K in keyof PublicCreatorBatchTargetStatus]: PublicCreatorBatchTargetStatus[K] } = {
      clipOrdinal: clipIndex + 1,
      targetOrdinal: targetIndex + 1,
      platform: target.platform,
      state: target.state,
    };
    if (target.checkedAt !== undefined) row.checkedAt = target.checkedAt;
    const url = target.state === 'published' ? publicPostUrl(target.platform, target.url) : undefined;
    if (url !== undefined) row.url = url;
    return Object.freeze(row);
  }));
  const summary = snapshot.summary;
  const result: { -readonly [K in keyof PublicCreatorBatchStatus]: PublicCreatorBatchStatus[K] } = {
    schemaVersion: 1,
    checkedAt: snapshot.checkedAt,
    clipCount: snapshot.manifest.projects.length,
    refresh: 'manual',
    autoMonitoring: false,
    summary: Object.freeze({
      total: summary.total,
      published: summary.published,
      pending: summary.pending,
      notStarted: summary.notStarted,
      uncertain: summary.uncertain,
      failed: summary.failed,
      blocked: summary.blocked,
    }),
    complete: snapshot.complete,
    targets: Object.freeze(targets),
  };
  if (snapshot.capacity.length > 0) {
    result.capacity = Object.freeze(snapshot.capacity.map((observation, index) => {
      const row: { -readonly [K in keyof PublicCreatorBatchCapacityStatus]: PublicCreatorBatchCapacityStatus[K] } = {
        observationOrdinal: index + 1,
        platform: observation.platform,
        status: observation.status,
        checkedAt: observation.checkedAt,
      };
      if (observation.remaining !== undefined) row.remaining = observation.remaining;
      if (observation.available !== undefined) row.available = observation.available;
      if (observation.canPostMore !== undefined) row.canPostMore = observation.canPostMore;
      if (observation.resetAt !== undefined) row.resetAt = observation.resetAt;
      if (observation.nextRetryAt !== undefined) row.nextRetryAt = observation.nextRetryAt;
      return Object.freeze(row);
    }));
  }
  return Object.freeze(result);
}
