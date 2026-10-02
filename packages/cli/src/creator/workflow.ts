import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  CreatorTikTokEnvelopeSchema as TikTokCapabilitySchema,
  CreatorIntentSchema as IntentSchema, CreatorTargetResultSchema as ResultSchema,
  CreatorRemotePostSchema as PostSchema, CreatorLookupSchema as LookupSchema,
  type CreatorIntent as Intent, type CreatorTargetResult as TargetResult, type CreatorTikTokCapability,
} from '@videomaker/schemas';
export type { TargetResult };
import { resolveR2Env } from '@videomaker/credentials';
import { R2ObjectStore, ZernioAccounts, ZernioClient, type ObjectStore, type SocialPost } from '@videomaker/providers';
import { defaultMediaDeps, type MediaCommandDeps } from '../pipeline/deps';
import { runPublish } from '../pipeline/publish';
import { loadIdentity, localPath, readJson, sha256, writeJson, type Preset } from './model';
import { measureMedia, planPublication } from './qa';

export interface CreatorDeps {
  media: MediaCommandDeps;
  client(): Promise<ZernioClient>;
  storage(): Promise<ObjectStore>;
}
export function defaultCreatorDeps(media = defaultMediaDeps()): CreatorDeps {
  return {
    media,
    client: async () => new ZernioClient({ apiKey: await media.secrets.getSecret('ZERNIO_API_KEY', 'run'), fetchImpl: media.fetchImpl, maxAttempts: 1 }),
    storage: async () => new R2ObjectStore(await resolveR2Env({ mode: 'run', fetchImpl: media.fetchImpl }), { maxAttempts: 1 }),
  };
}
/**
 * Fails closed on any capability the approved TikTok settings cannot satisfy.
 * `enabled:false` means the creator disabled the interaction; `default` is a
 * composer seed and is NEVER treated as approval. A `null` descriptor (photo
 * media) fails any required toggle rather than assuming consent.
 */
export function assertTikTokCapability(
  capability: CreatorTikTokCapability,
  settings: { privacyLevel: string; allowComment: boolean; allowDuet: boolean; allowStitch: boolean },
  duration: number,
): void {
  const interactions = capability.postingLimits.interactionSettings;
  if (capability.creator.canPostMore !== true ||
      !capability.privacyLevels.some((privacy) => privacy.value === settings.privacyLevel) ||
      capability.postingLimits.maxVideoDurationSec < duration ||
      (settings.allowComment && interactions.allow_comment.enabled !== true) ||
      (settings.allowDuet && interactions.allow_duet?.enabled !== true) ||
      (settings.allowStitch && interactions.allow_stitch?.enabled !== true)) {
    throw new Error('TikTok privacy/duration/interaction capability does not permit the approved settings');
  }
}
export async function remotePreflight(client: ZernioClient, deps: CreatorDeps, preset: Preset, duration: number) {
  const accounts = new ZernioAccounts(client);
  const ctx = deps.media.providerContext();
  const profiles = await accounts.profiles(ctx);
  if (!profiles.some((profile) => profile.id === preset.publishing.profile.id && profile.name === preset.publishing.profile.name)) throw new Error('Exact creator profile name/id not found; no default fallback');
  const connected = await accounts.merged(ctx, preset.publishing.profile.id);
  for (const target of preset.publishing.targets) {
    const matches = connected.filter((account) => account.id === target.accountId && account.platform === target.platform && account.username === target.username);
    if (matches.length !== 1 || matches[0]!.canPost !== true || !['healthy', 'active', 'ok'].includes(matches[0]!.status ?? '')) throw new Error(`Wrong/missing/unhealthy ${target.platform} account under exact creator profile`);
  }
  for (const tiktok of preset.publishing.targets.filter((target) => target.platform === 'tiktok')) {
    if (tiktok.platform !== 'tiktok') continue; // narrow the discriminated union to its options
    const response = await client.request(`/accounts/${encodeURIComponent(tiktok.accountId)}/tiktok/creator-info?mediaType=video`);
    if (response.status !== 200) throw new Error('TikTok creator-info unavailable; no upload/publication permitted');
    assertTikTokCapability(TikTokCapabilitySchema.parse(response.body), tiktok.options, duration);
  }
}


async function statusIntent(project: string, intent: Intent, client: ZernioClient): Promise<TargetResult> {
  const base: TargetResult = { platform: intent.platform, accountId: intent.accountId, idempotencyKey: intent.idempotencyKey, state: 'uncertain' };
  let saved: TargetResult | undefined;
  try { saved = ResultSchema.parse(await readJson(project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.result.json`)); } catch { /* A torn receipt never permits a retry. */ }
  try {
    const path = saved?.remoteId ? `/posts/${encodeURIComponent(saved.remoteId)}` : `/posts?idempotencyKey=${encodeURIComponent(intent.idempotencyKey)}`;
    const response = await client.request(path); // GET only, including uncertain/no-receipt attempts.
    if (response.status !== 200) return { ...base, remoteId: saved?.remoteId, detail: `GET status HTTP ${response.status}; do not resubmit` };
    const parsed = LookupSchema.parse(response.body);
    const candidates = parsed.posts ?? (Array.isArray(parsed.data) ? parsed.data : undefined);
    // Key lookup MUST prove exact membership; never trust the first result in a list.
    const post = saved?.remoteId
      ? parsed.post ?? (!Array.isArray(parsed.data) ? parsed.data : undefined) ?? PostSchema.parse(response.body)
      : candidates?.find((candidate) => candidate.idempotencyKey === intent.idempotencyKey) ?? (parsed.post?.idempotencyKey === intent.idempotencyKey ? parsed.post : undefined);
    if (!post) return saved?.state === 'failed' ? saved : { ...base, detail: 'No exact receipt/key match; uncertain, never auto-retry' };
    const remoteId = post._id ?? post.id;
    if (!remoteId || (saved?.remoteId && remoteId !== saved.remoteId)) return { ...base, detail: 'Receipt identity mismatch' };
    const target = post.platforms.find((platform) => platform.platform === intent.platform);
    const state = target?.status === 'published' ? 'published' : target?.status === 'failed' ? 'failed' : target && ['pending', 'processing', 'scheduled', 'queued', 'publishing'].includes(target.status ?? '') ? 'pending' : 'uncertain';
    return { ...base, state, remoteId, ...(target?.platformPostUrl ? { url: target.platformPostUrl } : {}), ...(target?.errorMessage ? { detail: target.errorMessage } : {}) };
  } catch { return { ...base, remoteId: saved?.remoteId, detail: 'Status lookup unavailable/invalid; no POST or local mutation performed' }; }
}

/** Exclusive write-ahead record + fsync(file and directory). Never removed, even on failure. */
async function claimIntent(project: string, intent: Intent): Promise<boolean> {
  const path = await localPath(project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.json`, true);
  await mkdir(dirname(path), { recursive: true });
  let handle;
  try { handle = await open(path, 'wx'); }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false; throw error; }
  try { await handle.writeFile(`${JSON.stringify(intent)}\n`); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
  return true;
}
async function uploadMedia(store: ObjectStore, project: string, relative: string, expectedHash: string, type: 'video/mp4' | 'image/png', deps: CreatorDeps): Promise<string> {
  const bytes = await readFile(await localPath(project, relative));
  if (sha256(bytes) !== expectedHash) throw new Error('Media changed after approval/QA; upload refused');
  const key = `creator/media/${expectedHash}.${type === 'video/mp4' ? 'mp4' : 'png'}`;
  const ctx = deps.media.providerContext();
  if (!await store.head(key, ctx)) await store.put(key, bytes, { contentType: type }, ctx);
  const verified = await store.inspect(key, ctx);
  if (verified.sha256 !== expectedHash || verified.bytes !== bytes.length || !verified.publicUrl || !/^https:\/\//.test(verified.publicUrl)) throw new Error('R2 object checksum/public URL verification failed');
  return verified.publicUrl;
}

export async function publishCreator(project: string, deps: CreatorDeps, options: { confirm: boolean; spendCap: unknown }): Promise<TargetResult[]> {
  if (!options.confirm) throw new Error('Publication requires --confirm in addition to the exact local approval');
  const plan = await planPublication(project, options.spendCap);
  if (plan.blockers.length || !plan.digest || !plan.media) throw new Error(plan.blockers.join('\n'));
  const { draft, preset, manifest, digest, media } = plan;
  const qa = await measureMedia(project, draft, preset, deps.media);
  if (qa.videoSha256 !== media.videoSha256 || qa.coverSha256 !== media.coverSha256) throw new Error('Current media changed; regenerate QA and approval');
  const client = await deps.client();
  await remotePreflight(client, deps, preset, qa.duration); // ALL destinations must pass before either upload.
  const store = await deps.storage();
  const videoUrl = await uploadMedia(store, project, draft.video, media.videoSha256, 'video/mp4', deps);
  const coverUrl = await uploadMedia(store, project, draft.cover, media.coverSha256, 'image/png', deps);
  const results: TargetResult[] = [];
  for (const target of preset.publishing.targets) {
    const idempotencyKey = `creator:${sha256(`${manifest.id}:${media.videoSha256}:${target.accountId}`)}`;
    const intent: Intent = { schemaVersion: 1, idempotencyKey, platform: target.platform, accountId: target.accountId, projectId: manifest.id, videoSha256: media.videoSha256, digest };
    if (!await claimIntent(project, intent)) {
      results.push(await statusIntent(project, intent, client));
      continue;
    }
    let result: TargetResult;
    try {
      // Gate remains immediately before every target; engine owns provider journal and spend guard.
      const current = await planPublication(project, options.spendCap);
      if (current.blockers.length || current.digest !== digest) throw new Error('Draft/media/approval/spend changed during publication; no submit for this target');
      const tiktokSettings: SocialPost['tiktokSettings'] = target.platform === 'tiktok' ? {
        privacy_level: target.options.privacyLevel, allow_comment: target.options.allowComment,
        allow_duet: target.options.allowDuet, allow_stitch: target.options.allowStitch,
        content_preview_confirmed: true, express_consent_given: true, video_cover_image_url: coverUrl,
        ...(draft.syntheticMedia === true ? { video_made_with_ai: true } : {}),
      } : undefined;
      await localPath(project, 'qa/publication/zernio-journal.jsonl', true);
      await localPath(project, `qa/publication/${idempotencyKey.replace(':', '-').slice(0, 64)}/journal.json`, true);
      const published = await runPublish({
        projectDir: project, deps: deps.media, account: target.accountId, profileId: preset.publishing.profile.id,
        text: draft.platformContent[target.platform] || draft.content, title: draft.title,
        media: [videoUrl], coverUrl, tags: draft.tags, tiktokSettings,
        ...(target.platform === 'youtube' ? { youtube: { title: draft.title, ...target.options, ...(draft.syntheticMedia === true ? { containsSyntheticMedia: true } : {}) } } : {}),
        idempotencyKey, spendCapUsd: typeof options.spendCap === 'number' ? options.spendCap : 0,
        force: false, now: () => deps.media.clock.now(), out: () => {},
      });
      result = { platform: target.platform, accountId: target.accountId, idempotencyKey, state: published.outcome.outcome === 'accepted' ? 'pending' : published.outcome.outcome,
        ...(published.outcome.remoteId ? { remoteId: published.outcome.remoteId } : {}),
        ...(published.outcome.url ? { url: published.outcome.url } : {}),
        ...(published.outcome.detail ? { detail: published.outcome.detail } : {}),
      };
    } catch { result = { platform: target.platform, accountId: target.accountId, idempotencyKey, state: 'uncertain', detail: 'Attempt interrupted; inspect journals and use creator-status. Never resubmit this key.' }; }
    await writeJson(project, `publication/intents/${idempotencyKey.slice('creator:'.length)}.result.json`, result);
    results.push(result);
  }
  return results;
}

export async function statusCreator(project: string, deps: CreatorDeps, offline = false): Promise<TargetResult[]> {
  const { manifest, preset } = await loadIdentity(project);
  const intents: Intent[] = [];
  const directory = await localPath(project, 'publication/intents', true);
  try {
    for (const file of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      // Malformed durable intents are blockers, not permission to submit.
      const intent = IntentSchema.parse(await readJson(project, `publication/intents/${file}`));
      if (intent.projectId !== manifest.id || !preset.publishing.targets.some((target) => target.platform === intent.platform && target.accountId === intent.accountId)) throw new Error('Intent project/target mismatch');
      intents.push(intent);
    }
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const client = !offline && intents.length ? await deps.client() : undefined;
  const results: TargetResult[] = [];
  for (const target of preset.publishing.targets) {
    const mine = intents.filter((intent) => intent.accountId === target.accountId && intent.platform === target.platform);
    if (!mine.length) results.push({ platform: target.platform, accountId: target.accountId, idempotencyKey: '', state: 'not-started' });
    for (const intent of mine) results.push(client ? await statusIntent(project, intent, client) : { platform: intent.platform, accountId: intent.accountId, idempotencyKey: intent.idempotencyKey, state: 'uncertain', detail: 'Offline only: durable intent exists; remote status NOT CHECKED' });
  }
  return results;
}
