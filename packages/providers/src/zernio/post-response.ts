/**
 * Pure parsing of Zernio post responses (tolerant to `data`/`post` wrappers).
 * Shared by the publish, status and distribution paths; no I/O.
 */

export interface CreatedPlatform {
  platform: string;
  status?: string;
  platformPostUrl?: string;
}

export interface CreatedPost {
  id: string;
  platforms: CreatedPlatform[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** 409 dedupe answer: the id of the already-published post, when present. */
export function duplicatePostId(status: number, body: unknown): string | null {
  if (status !== 409) return null;
  const existing = asRecord(body).existingPostId;
  return typeof existing === 'string' && existing ? existing : null;
}

/**
 * Extracts the created/fetched post from any known response envelope
 * (`{post}`, `{data}`, raw post; `_id`/`id`; `existingPostId` fallback).
 */
export function extractCreatedPost(body: unknown): CreatedPost | null {
  if (!body || typeof body !== 'object') return null;
  const root = asRecord(body);
  const post = asRecord(root.post ?? root.data ?? root);
  const nested = asRecord(post.post ?? post);
  const id =
    (typeof nested._id === 'string' ? nested._id : undefined) ??
    (typeof nested.id === 'string' ? nested.id : undefined) ??
    (typeof root.existingPostId === 'string' ? root.existingPostId : undefined);
  if (!id) return null;
  const rawPlatforms = Array.isArray(nested.platforms) ? nested.platforms : [];
  return {
    id,
    platforms: rawPlatforms.map((item) => {
      const entry = asRecord(item);
      return {
        platform: typeof entry.platform === 'string' ? entry.platform : '',
        status: typeof entry.status === 'string' ? entry.status : undefined,
        platformPostUrl:
          typeof entry.platformPostUrl === 'string' ? entry.platformPostUrl : undefined,
      };
    }),
  };
}

/** First platform URL that proves the post is publicly reachable. */
export function postUrlOf(post: CreatedPost): string | undefined {
  for (const platform of post.platforms) {
    if (platform.platformPostUrl) return platform.platformPostUrl;
  }
  return undefined;
}

/** First entry of a `GET /posts?...` list response, when present. */
export function extractFirstListedPost(body: unknown): CreatedPost | null {
  const root = asRecord(body);
  const list = Array.isArray(root.posts) ? root.posts : Array.isArray(root.data) ? root.data : null;
  if (list) {
    if (list.length === 0) return null;
    return extractCreatedPost(list[0]);
  }
  return extractCreatedPost(body);
}
