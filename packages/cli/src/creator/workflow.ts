import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { isRecord } from '@videomaker/core';
import {
  CreatorIntentSchema as IntentSchema, CreatorTargetResultSchema as ResultSchema,
  type CreatorIntent as Intent, type CreatorTargetResult as TargetResult, type CreatorProject,
  type CreatorBatchQueuePolicy, type CreatorBatchCapacityObservation,
} from '@videomaker/schemas';
export type { TargetResult };
import { resolveR2Env } from '@videomaker/credentials';
import {
  R2ObjectStore, ZernioClient,
  reconcileByKey, remoteReconcileLookup, validatePublicationJournalEntry,
  type ObjectStore, type SocialPost, type ProviderContext, type ReconcileFinding,
  type RemotePostEvidence, type PublicationJournalStore, type Publisher,
} from '@videomaker/providers';
import { defaultMediaDeps, type MediaCommandDeps } from '../pipeline/deps';
import { runPublish } from '../pipeline/publish';
import { loadIdentity, localPath, readJson, sha256, writeJson, type Preset } from './model';
import { measureMedia, planPublication } from './qa';
import {
  checkedCreatorClient, checkedCreatorStorage, remoteCreatorPreflight, CreatorPreflightError,
  type CreatorCapacitySource, type CreatorCapacityObserver,
} from './preflight';
export { assertTikTokCapability } from './preflight';

export interface CreatorDeps {
  media: MediaCommandDeps;
  client(): Promise<ZernioClient>;
  storage(): Promise<ObjectStore>;
  capacity?: CreatorCapacitySource;
}

export interface CreatorPublishOptions {
  confirm: boolean;
  spendCap: unknown;
  /** Execution scope only; never changes the approved preset or digest. */
  targetAccountIds?: readonly string[];
  queuePolicy?: CreatorBatchQueuePolicy;
  /** Validated read-only evidence for batch progress; never authorizes a retry. */
  onCapacity?: CreatorCapacityObserver;
}

interface CreatorIdentity {
  manifest: CreatorProject;
  preset: Preset;
}
type CreatorTarget = Preset['publishing']['targets'][number];

function selectedTargets(preset: Preset, targetAccountIds?: readonly string[]): CreatorTarget[] {
  if (targetAccountIds === undefined) return preset.publishing.targets;
  if (!Array.isArray(targetAccountIds) ||
      targetAccountIds.some((id) => typeof id !== 'string' || !preset.publishing.targets.some((target) => target.accountId === id))) {
    throw new Error('Target subset must contain only approved account IDs');
  }
  if (new Set(targetAccountIds).size !== targetAccountIds.length) throw new Error('Target subset must contain unique account IDs');
  return preset.publishing.targets.filter((target) => targetAccountIds.includes(target.accountId));
}

function validateIntent(intent: Intent, identity: CreatorIdentity, fileKey: string, expected?: Intent): void {
  const key = `creator:${sha256(`${identity.manifest.id}:${intent.videoSha256}:${intent.accountId}`)}`;
  if (intent.projectId !== identity.manifest.id || intent.idempotencyKey !== key ||
      fileKey !== key.slice('creator:'.length) ||
      !identity.preset.publishing.targets.some((target) => target.platform === intent.platform && target.accountId === intent.accountId) ||
      (intent.evidence && intent.evidence.profileId !== identity.preset.publishing.profile.id)) {
    throw new Error('Intent project/target/file key mismatch; never resubmit');
  }
  if (expected && (intent.digest !== expected.digest || intent.videoSha256 !== expected.videoSha256 ||
      intent.accountId !== expected.accountId || intent.platform !== expected.platform || intent.idempotencyKey !== expected.idempotencyKey)) {
    throw new Error('Existing intent approved digest/identity mismatch; never replace or resubmit');
  }
}

async function existingIntent(project: string, identity: CreatorIdentity, expected: Intent): Promise<Intent | undefined> {
  const fileKey = expected.idempotencyKey.slice('creator:'.length);
  let raw: unknown;
  try { raw = await readJson(project, `publication/intents/${fileKey}.json`); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  const intent = IntentSchema.parse(raw);
  validateIntent(intent, identity, fileKey, expected);
  return intent;
}

async function durableIntents(project: string, identity: CreatorIdentity): Promise<Intent[]> {
  const intents: Intent[] = [];
  const directory = await localPath(project, 'publication/intents', true);
  try {
    for (const file of await readdir(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const intent = IntentSchema.parse(await readJson(project, `publication/intents/${file}`));
      validateIntent(intent, identity, file.slice(0, -'.json'.length));
      intents.push(intent);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  return intents;
}

export function defaultCreatorDeps(media = defaultMediaDeps()): CreatorDeps {
  return {
    media,
    client: async () => new ZernioClient({ apiKey: await media.secrets.getSecret('ZERNIO_API_KEY', 'run'), fetchImpl: media.fetchImpl, maxAttempts: 1 }),
    storage: async () => new R2ObjectStore(await resolveR2Env({ mode: 'run', fetchImpl: media.fetchImpl }), { maxAttempts: 1 }),
  };
}
export async function remotePreflight(
  client: ZernioClient, deps: CreatorDeps, preset: Preset, duration: number,
  targetAccountIds?: readonly string[], queuePolicy: CreatorBatchQueuePolicy = 'allow-provider-queue',
  onCapacity?: CreatorCapacityObserver,
): Promise<CreatorBatchCapacityObservation[]> {
  return remoteCreatorPreflight(client, deps, preset, duration, {
    targetAccountIds, queuePolicy, capacitySource: deps.capacity, onCapacity,
  });
}

/** The last read-only check is immediately before the provider wire attempt. */
function capacityGuardedMedia(
  deps: CreatorDeps, check: () => Promise<void>, refused: (error: CreatorPreflightError) => void,
): MediaCommandDeps {
  return { ...deps.media, publisher: async (journalPath): Promise<Publisher> => {
    const publisher = await deps.media.publisher(journalPath);
    const guard = async (): Promise<void> => {
      try { await check(); }
      catch (error) { if (error instanceof CreatorPreflightError) refused(error); throw error; }
    };
    return {
      id: publisher.id,
      accounts: (ctx) => publisher.accounts(ctx),
      validate: (post, ctx) => publisher.validate(post, ctx),
      publish: async (post, ctx) => { await guard(); return publisher.publish(post, ctx); },
      schedule: async (post, ctx) => { await guard(); return publisher.schedule(post, ctx); },
      status: (key, ctx) => publisher.status(key, ctx),
      reconcile: (key, ctx) => publisher.reconcile(key, ctx),
    };
  } };
}


interface IntentStatus {
  result: TargetResult;
  saved?: TargetResult;
  finding?: ReconcileFinding;
}

/** The original submission, not the check time, bounds payload proof to ±5 minutes. */
function intentEvidence(intent: Intent): RemotePostEvidence | undefined {
  if (!intent.evidence) return undefined; // Never reconstruct a legacy payload from today's draft.
  const submitted = Date.parse(intent.evidence.submittedAt);
  return {
    profileId: intent.evidence.profileId, platform: intent.platform, accountId: intent.accountId,
    content: intent.evidence.content, videoUrl: intent.evidence.videoUrl, coverUrl: intent.evidence.coverUrl,
    createdAfter: new Date(submitted - 5 * 60_000).toISOString(),
    createdBefore: new Date(submitted + 5 * 60_000).toISOString(),
  };
}

async function inspectIntent(project: string, intent: Intent, client: ZernioClient, profileId: string, ctx: ProviderContext): Promise<IntentStatus> {
  const base: TargetResult = { platform: intent.platform, accountId: intent.accountId, idempotencyKey: intent.idempotencyKey, state: 'uncertain' };
  let saved: TargetResult | undefined;
  try { saved = ResultSchema.parse(await readJson(project, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.result.json`)); }
  catch { /* A missing/torn receipt supplies no ID or state proof, never permission to resubmit. */ }
  if (saved && (saved.platform !== intent.platform || saved.accountId !== intent.accountId || saved.idempotencyKey !== intent.idempotencyKey)) {
    return { result: { ...base, detail: 'Saved receipt target/key identity mismatch; do not resubmit' } };
  }
  try {
    const evidence = intentEvidence(intent);
    const finding = await remoteReconcileLookup(client, {
      remoteId: saved?.remoteId, target: { platform: intent.platform, accountId: intent.accountId, profileId },
      ...(evidence ? { evidence } : {}),
    })(intent.idempotencyKey, ctx);
    const state = finding.verdict !== 'found' ? 'uncertain'
      : finding.outcome === 'published' ? 'published'
      : finding.outcome === 'accepted' ? 'pending'
      : finding.outcome === 'failed' ? 'failed' : 'uncertain';
    return { saved, finding, result: {
      ...base, state,
      ...(finding.remoteId ?? saved?.remoteId ? { remoteId: finding.remoteId ?? saved?.remoteId } : {}),
      ...(state === 'published' && finding.url ? { url: finding.url } : {}),
      // Do not persist remote error bodies/messages as local reconciliation evidence.
      detail: state === 'uncertain' ? 'Remote GET evidence is inconclusive; never resubmit'
        : `Remote GET proves ${state} (${finding.evidenceSource ?? 'unknown'})`,
    } };
  } catch {
    return { saved, result: { ...base, remoteId: saved?.remoteId, detail: 'Status lookup unavailable/invalid; no POST or local mutation performed' } };
  }
}

async function statusIntent(project: string, intent: Intent, client: ZernioClient, profileId: string, ctx: ProviderContext): Promise<TargetResult> {
  return (await inspectIntent(project, intent, client, profileId, ctx)).result;
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

export async function publishCreator(project: string, deps: CreatorDeps, options: CreatorPublishOptions): Promise<TargetResult[]> {
  if (options.targetAccountIds !== undefined) {
    const { preset } = await loadIdentity(project);
    if (!selectedTargets(preset, options.targetAccountIds).length) return [];
  }
  if (!options.confirm) throw new Error('Publication requires --confirm in addition to the exact local approval');
  // Always plan the whole approved project, including its unresolved spend ledger.
  const plan = await planPublication(project, options.spendCap);
  if (plan.blockers.length || !plan.digest || !plan.media) throw new Error(plan.blockers.join('\n'));
  const { draft, preset, manifest, digest, media } = plan;
  const targets = selectedTargets(preset, options.targetAccountIds);
  const identity: CreatorIdentity = { preset, manifest };
  const previous = await durableIntents(project, identity);
  const attempts: Array<{ target: CreatorTarget; intent: Intent; existing?: Intent }> = [];
  for (const target of targets) {
    const idempotencyKey = `creator:${sha256(`${manifest.id}:${media.videoSha256}:${target.accountId}`)}`;
    const intent: Intent = { schemaVersion: 1, idempotencyKey, platform: target.platform, accountId: target.accountId, projectId: manifest.id, videoSha256: media.videoSha256, digest };
    const existing = previous.find((candidate) => candidate.idempotencyKey === idempotencyKey);
    if (existing) validateIntent(existing, identity, idempotencyKey.slice('creator:'.length), intent);
    attempts.push({ target, intent, existing });
  }
  const qa = attempts.some((attempt) => !attempt.existing) ? await measureMedia(project, draft, preset, deps.media) : undefined;
  if (qa && (qa.videoSha256 !== media.videoSha256 || qa.coverSha256 !== media.coverSha256)) throw new Error('Current media changed; regenerate QA and approval');
  const client = await checkedCreatorClient(deps);
  let videoUrl = '';
  let coverUrl = '';
  if (qa) {
    await remotePreflight(client, deps, preset, qa.duration, targets.map((target) => target.accountId), options.queuePolicy, options.onCapacity);
    const store = await checkedCreatorStorage(deps);
    videoUrl = await uploadMedia(store, project, draft.video, media.videoSha256, 'video/mp4', deps);
    coverUrl = await uploadMedia(store, project, draft.cover, media.coverSha256, 'image/png', deps);
  }
  const results: TargetResult[] = [];
  for (const attempt of attempts) {
    const { target, intent } = attempt;
    const { idempotencyKey } = intent;
    if (attempt.existing) {
      results.push(await statusIntent(project, attempt.existing, client, preset.publishing.profile.id, deps.media.providerContext()));
      continue;
    }
    if (options.queuePolicy === 'require-capacity' && qa) {
      // A prior positive observation is not a reservation. Check this account again
      // before making a permanent fresh claim, after any upload/storage delay.
      await remotePreflight(client, deps, preset, qa.duration, [target.accountId], options.queuePolicy, options.onCapacity);
    }
    intent.evidence = {
      profileId: preset.publishing.profile.id,
      content: draft.platformContent[target.platform] || draft.content,
      videoUrl, coverUrl, submittedAt: deps.media.clock.now().toISOString(),
    };
    IntentSchema.parse(intent); // Fail closed before persisting invalid/public-URL evidence.
    if (!await claimIntent(project, intent)) {
      try {
        const existing = await existingIntent(project, identity, intent);
        if (!existing) throw new Error('Durable claim disappeared');
        results.push(await statusIntent(project, existing, client, preset.publishing.profile.id, deps.media.providerContext()));
      } catch {
        // A concurrent/torn claim is still a permanent barrier to a second POST.
        results.push({ platform: target.platform, accountId: target.accountId, idempotencyKey, state: 'uncertain', detail: 'Existing durable intent invalid/incomplete; never replace or resubmit' });
      }
      continue;
    }
    let capacityFailure: CreatorPreflightError | undefined;
    const publishMedia = options.queuePolicy === 'require-capacity' && qa
      ? capacityGuardedMedia(deps, () => remotePreflight(client, deps, preset, qa.duration, [target.accountId], options.queuePolicy, options.onCapacity).then(() => {}),
        (error) => { capacityFailure = error; })
      : deps.media;
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
        projectDir: project, deps: publishMedia, account: target.accountId, profileId: intent.evidence.profileId,
        text: intent.evidence.content, title: draft.title,
        media: [videoUrl], coverUrl, tags: draft.tags, tiktokSettings,
        ...(target.platform === 'youtube' ? { youtube: { title: draft.title, ...target.options, ...(draft.syntheticMedia === true ? { containsSyntheticMedia: true } : {}) } } : {}),
        idempotencyKey, spendCapUsd: typeof options.spendCap === 'number' ? options.spendCap : 0,
        force: false, now: () => deps.media.clock.now(), out: () => {},
      });
      result = { platform: target.platform, accountId: target.accountId, idempotencyKey, state: published.outcome.outcome === 'accepted' ? 'pending' : published.outcome.outcome,
        ...(published.outcome.remoteId ? { remoteId: published.outcome.remoteId } : {}),
        ...(published.outcome.outcome === 'published' && published.outcome.url ? { url: published.outcome.url } : {}),
        // Transport causes and remote error messages may contain secrets; never persist arbitrary details.
        detail: published.outcome.outcome === 'published' ? 'Provider target receipt proves publication'
          : published.outcome.outcome === 'accepted' ? 'Provider accepted publication; GET status required'
          : published.outcome.outcome === 'failed' ? 'Provider rejected publication; no automatic retry'
          : 'Publication state unknown; GET reconciliation required; never resubmit',
      };
    } catch { result = { platform: target.platform, accountId: target.accountId, idempotencyKey, state: 'uncertain', detail: 'Attempt interrupted; inspect journals and use creator-status. Never resubmit this key.' }; }
    await writeJson(project, `publication/intents/${idempotencyKey.slice('creator:'.length)}.result.json`, result);
    results.push(result);
    // A claimed key remains immutable even if the final check refuses the wire.
    // Carry the typed scope to a batch controller after persisting its receipt.
    if (capacityFailure) throw capacityFailure;
  }
  return results;
}

export async function statusCreator(project: string, deps: CreatorDeps, offline = false): Promise<TargetResult[]> {
  const identity = await loadIdentity(project);
  const { preset } = identity;
  const intents = await durableIntents(project, identity);
  const client = !offline && intents.length ? await deps.client() : undefined;
  const results: TargetResult[] = [];
  for (const target of preset.publishing.targets) {
    const mine = intents.filter((intent) => intent.accountId === target.accountId && intent.platform === target.platform);
    if (!mine.length) results.push({ platform: target.platform, accountId: target.accountId, idempotencyKey: '', state: 'not-started' });
    for (const intent of mine) results.push(client ? await statusIntent(project, intent, client, preset.publishing.profile.id, deps.media.providerContext()) : { platform: intent.platform, accountId: intent.accountId, idempotencyKey: intent.idempotencyKey, state: 'uncertain', detail: 'Offline only: durable intent exists; remote status NOT CHECKED' });
  }
  return results;
}

interface CreatorReconciliationAudit {
  schemaVersion: 1;
  identity: { projectId: string; digest: string; idempotencyKey: string; profileId: string; platform: string; accountId: string };
  source: 'remote-id' | 'echoed-key' | 'payload' | 'authoritative';
  previous: { state: TargetResult['state']; remoteId?: string };
  result: { state: TargetResult['state']; remoteId: string };
  checkedAt: string;
}

function isReconciliationAudit(value: unknown): value is CreatorReconciliationAudit {
  if (!isRecord(value) || value.schemaVersion !== 1 ||
      Object.keys(value).some((key) => !['schemaVersion', 'identity', 'source', 'previous', 'result', 'checkedAt'].includes(key)) ||
      !isRecord(value.identity) || !isRecord(value.previous) || !isRecord(value.result)) return false;
  const identityFields = ['projectId', 'digest', 'idempotencyKey', 'profileId', 'platform', 'accountId'];
  const identity = value.identity;
  if (Object.keys(identity).some((key) => !identityFields.includes(key)) ||
      identityFields.some((key) => typeof identity[key] !== 'string' || !identity[key])) return false;
  for (const snapshot of [value.previous, value.result]) {
    if (Object.keys(snapshot).some((key) => !['state', 'remoteId'].includes(key)) ||
        typeof snapshot.state !== 'string' || !['published', 'pending', 'failed', 'uncertain', 'not-started'].includes(snapshot.state) ||
        (snapshot.remoteId !== undefined && (typeof snapshot.remoteId !== 'string' || !snapshot.remoteId.trim()))) return false;
  }
  return typeof value.result.remoteId === 'string' && value.result.remoteId.trim().length > 0 &&
    typeof value.source === 'string' && ['remote-id', 'echoed-key', 'payload', 'authoritative'].includes(value.source) &&
    typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt));
}

async function reconciliationAudits(project: string): Promise<CreatorReconciliationAudit[]> {
  let text: string;
  try { text = await readFile(await localPath(project, 'publication/reconciliations.jsonl'), 'utf8'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
  if (text && !text.endsWith('\n')) throw new Error('Torn reconciliation audit; preserve all evidence');
  return text.split('\n').filter((line) => line.trim()).map((line) => {
    const value: unknown = JSON.parse(line);
    if (!isReconciliationAudit(value)) throw new Error('Invalid reconciliation audit; preserve all evidence');
    return value;
  });
}

/** Refuse torn append tails rather than destroying evidence or making them interior corruption. */
async function durableAppend(project: string, relative: string, value: unknown): Promise<void> {
  const path = await localPath(project, relative, true);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'a+');
  try {
    const text = await handle.readFile('utf8');
    if (text && !text.endsWith('\n')) throw new Error('Torn journal/audit tail; preserve evidence and do not append');
    for (const line of text.split('\n').filter((line) => line.trim())) JSON.parse(line);
    await handle.writeFile(`${JSON.stringify(value)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Only this explicit reconciliation writer replaces a latest receipt atomically. */
async function replaceReceipt(project: string, intent: Intent, result: TargetResult): Promise<void> {
  const relative = `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.result.json`;
  const path = await localPath(project, relative, true);
  const temporary = await localPath(project, `${relative}.${randomUUID()}.tmp`, true);
  const handle = await open(temporary, 'wx');
  try {
    try { await handle.writeFile(`${JSON.stringify(ResultSchema.parse(result), null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await localPath(project, relative, true); // Recheck the destination before rename.
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    try { await unlink(temporary); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
}

/**
 * Audited GET proof for existing claims only. This deliberately does not call
 * planPublication/runPublish or inspect, clear, complete or reconcile a paid ledger.
 */
export async function reconcileCreator(project: string, deps: CreatorDeps, options: CreatorPublishOptions): Promise<TargetResult[]> {
  if (options.confirm !== true) throw new Error('Reconciliation requires explicit --confirm');
  if (typeof options.spendCap !== 'number' || !Number.isFinite(options.spendCap) || options.spendCap !== 0) {
    throw new Error('Reconciliation requires explicit finite --spend-cap 0');
  }
  const identity = await loadIdentity(project);
  const targets = selectedTargets(identity.preset, options.targetAccountIds);
  if (!targets.length) return [];
  const intents = await durableIntents(project, identity);
  const selected = intents.filter((intent) => targets.some((target) => target.platform === intent.platform && target.accountId === intent.accountId));
  const client = selected.length ? await deps.client() : undefined;
  const ctx = deps.media.providerContext();
  const relative = 'qa/publication/zernio-journal.jsonl';
  const journal: PublicationJournalStore = {
    async readAll() {
      let text: string;
      try { text = await readFile(await localPath(project, relative), 'utf8'); }
      catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      }
      if (text && !text.endsWith('\n')) throw new Error('Torn publication journal; preserve all evidence');
      return text.split('\n').filter((line) => line.trim()).map((line) => validatePublicationJournalEntry(JSON.parse(line)));
    },
    async append(entry) { await durableAppend(project, relative, validatePublicationJournalEntry(entry)); },
  };
  const results: TargetResult[] = [];
  for (const target of targets) {
    const mine = selected.filter((intent) => intent.platform === target.platform && intent.accountId === target.accountId);
    if (!mine.length) results.push({ platform: target.platform, accountId: target.accountId, idempotencyKey: '', state: 'not-started' });
    for (const intent of mine) {
      if (!client) continue;
      const inspected = await inspectIntent(project, intent, client, identity.preset.publishing.profile.id, ctx);
      const { result, saved, finding } = inspected;
      if (result.state === 'uncertain' || !finding || finding.verdict !== 'found' || !finding.remoteId || !finding.evidenceSource) {
        results.push(result);
        continue; // No proof means no local mutation, release, delete, key or retry.
      }
      try {
        const entries = (await journal.readAll()).filter((entry) => entry.idempotencyKey === intent.idempotencyKey);
        const latest = entries[entries.length - 1];
        const outcome = result.state === 'pending' ? 'accepted' : result.state;
        if ((latest?.remoteId && latest.remoteId !== finding.remoteId) ||
            (latest?.outcome === 'published' && outcome !== 'published')) {
          results.push({ ...result, state: 'uncertain', url: undefined, detail: 'GET proof conflicts with existing journal identity/state; preserve history' });
          continue;
        }
        const journalMatches = latest?.outcome === outcome && latest.remoteId === result.remoteId &&
          (outcome !== 'published' || latest.url === result.url);
        const receiptMatches = saved?.state === result.state && saved.remoteId === result.remoteId && saved.url === result.url;
        const audits = await reconciliationAudits(project);
        const previousAudit = audits.filter((audit) => audit.identity.idempotencyKey === intent.idempotencyKey).at(-1);
        const auditMatches = previousAudit?.identity.projectId === intent.projectId && previousAudit.identity.digest === intent.digest &&
          previousAudit.identity.platform === intent.platform && previousAudit.identity.accountId === intent.accountId &&
          previousAudit.identity.profileId === identity.preset.publishing.profile.id &&
          previousAudit.result.state === result.state && previousAudit.result.remoteId === result.remoteId;
        if (auditMatches && receiptMatches && (journalMatches || !latest)) { results.push(result); continue; }
        // Closed, purpose-built audit snapshot: no payload, remote detail, headers or secrets.
        const audit: CreatorReconciliationAudit = {
          schemaVersion: 1,
          identity: { projectId: intent.projectId, digest: intent.digest, idempotencyKey: intent.idempotencyKey,
            profileId: identity.preset.publishing.profile.id, platform: intent.platform, accountId: intent.accountId },
          source: finding.evidenceSource,
          previous: { state: saved?.state ?? (latest?.outcome === 'accepted' ? 'pending' : latest?.outcome ?? 'uncertain'),
            ...(saved?.remoteId ?? latest?.remoteId ? { remoteId: saved?.remoteId ?? latest?.remoteId } : {}) },
          result: { state: result.state, remoteId: finding.remoteId },
          checkedAt: deps.media.clock.now().toISOString(),
        };
        await durableAppend(project, 'publication/reconciliations.jsonl', audit);
        if (latest && !journalMatches) {
          // The provider owns state transitions; reuse its proven finding, not a second lookup engine.
          const reconciled = await reconcileByKey(client, journal, intent.idempotencyKey, ctx, {
            reconcileLookup: async () => ({ ...finding, detail: 'exact remote GET identity and target-state proof' }),
          });
          if (reconciled.outcome !== outcome || reconciled.remoteId !== result.remoteId) throw new Error('Journal proof changed during reconciliation');
        }
        // If the claim predates any provider attempt, record proof but never invent an attempt number.
        await replaceReceipt(project, intent, result);
        results.push(result);
      } catch {
        results.push({ ...result, state: 'uncertain', url: undefined, detail: 'Reconciliation interrupted/unsafe journal; claim and history retained; inspect audit before repeating' });
      }
    }
  }
  return results;
}
