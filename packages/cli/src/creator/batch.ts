import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  CreatorBatchManifestSchema, CreatorBatchProgressSchema, CreatorBatchTargetProgressSchema, CreatorBatchCapacityObservationSchema,
  CreatorIntentSchema, CreatorTargetResultSchema,
  type CreatorBatchManifest, type CreatorBatchProject, type CreatorBatchProgress,
  type CreatorBatchTarget, type CreatorBatchTargetProgress, type CreatorBatchSummary,
  type CreatorBatchDependencyObservation, type CreatorBatchCapacityObservation, type CreatorIntent, type CreatorTargetResult,
} from '@videomaker/schemas';
import type { ObjectStore, Publisher, ZernioClient } from '@videomaker/providers';
import { FileSpendLedger, openAttempts, spendLedgerPath } from '../pipeline/spend-ledger';
import { localPath, noSymlinks, readJson, sha256 } from './model';
import { planPublication } from './qa';
import { publishCreator, reconcileCreator, statusCreator, type CreatorDeps } from './workflow';
import { CreatorPreflightError, type CreatorCapacityObserver } from './preflight';

export interface CreatorBatchRunOptions {
  confirm: boolean;
  spendCap: unknown;
}

interface LoadedBatch {
  manifest: CreatorBatchManifest;
  path: string;
  root: string;
  hash: string;
  sourceDependencies: CreatorBatchDependencyObservation[];
  sourceBlockers: string[];
}
interface ProjectObservation {
  path: string;
  blockers: string[];
  targets: CreatorBatchTargetProgress[];
  dependencies: CreatorBatchDependencyObservation[];
}

const detailOf = (error: unknown): string => error instanceof Error ? error.message : 'Invalid local batch evidence';
const zeroCap = (cap: unknown): boolean => typeof cap === 'number' && Number.isFinite(cap) && cap === 0;
const targetKey = (target: { projectId: string; platform: string; accountId: string }): string => JSON.stringify([target.projectId, target.platform, target.accountId]);
const accountKey = (target: Pick<CreatorBatchTarget, 'platform' | 'accountId'>): string => JSON.stringify([target.platform, target.accountId]);

async function readBatch(manifestPath: string): Promise<LoadedBatch> {
  const path = resolve(manifestPath);
  await noSymlinks(path);
  const bytes = await readFile(path);
  const manifest = CreatorBatchManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  const root = dirname(path);
  const sourceDependencies: CreatorBatchDependencyObservation[] = [];
  const sourceBlockers: string[] = [];
  // A source clips-select evaluation is not a paid dependency of independently approved renders.
  // Only that explicitly recognized kind gets informative scope; unknown open kinds fail closed.
  if (!manifest.projects.some((entry) => resolve(root, entry.projectPath) === root)) {
    try {
      await localPath(root, 'qa/spend.json', true);
      const latest = await new FileSpendLedger(spendLedgerPath(root)).list();
      for (const attempt of latest) {
        if (attempt.command === 'clips-select' && /^clips-select:[a-f0-9]{64}$/.test(attempt.subject)) {
          sourceDependencies.push({ scope: 'independent', effect: 'informative', dependencyId: `source:clips-select:${attempt.attemptId}`,
            state: attempt.state === 'uncertain' ? 'uncertain' : attempt.state === 'submitted' ? 'open' : 'clear',
            detail: 'Source clips-select evaluation is separate from the listed hash-bound, approved creator projects; its ledger is preserved' });
        } else if (attempt.state === 'uncertain' || attempt.state === 'submitted') {
          sourceBlockers.push('Source ledger contains an open dependency of unrecognized scope; new targets are blocked pending explicit dependency classification');
        }
      }
    } catch {
      sourceBlockers.push('Source ledger is invalid/unsafe; dependency scope cannot be established and new targets are blocked');
    }
  }
  return { manifest, path, root, hash: sha256(bytes), sourceDependencies, sourceBlockers };
}

export async function loadCreatorBatch(manifestPath: string): Promise<CreatorBatchManifest> {
  return (await readBatch(manifestPath)).manifest;
}

async function unchangedBatch(batch: LoadedBatch): Promise<void> {
  await noSymlinks(batch.path);
  if (sha256(await readFile(batch.path)) !== batch.hash) throw new Error('Batch manifest changed during execution; no new submit permitted');
}

function unstarted(entry: CreatorBatchProject, target: CreatorBatchTarget, detail?: string): CreatorBatchTargetProgress {
  return { projectId: entry.projectId, platform: target.platform, accountId: target.accountId,
    state: detail ? 'blocked' : 'not-started', ...(detail ? { detail } : {}) };
}

function observedResult(entry: CreatorBatchProject, target: Pick<CreatorBatchTarget, 'platform' | 'accountId'>, intent: CreatorIntent, result?: CreatorTargetResult): CreatorBatchTargetProgress {
  const matching = result && result.platform === target.platform && result.accountId === target.accountId && result.idempotencyKey === intent.idempotencyKey && result.state !== 'not-started';
  const candidate = {
    projectId: entry.projectId, platform: target.platform, accountId: target.accountId,
    idempotencyKey: intent.idempotencyKey,
    state: matching ? result.state : 'uncertain',
    ...(matching && result.remoteId ? { remoteId: result.remoteId } : {}),
    ...(matching && result.url ? { url: result.url } : {}),
    checkedAt: new Date().toISOString(),
    detail: matching ? `Exact target receipt reports ${result.state}; this durable key is never resubmitted` : 'Durable intent exists without an exact receipt; never resubmit',
  };
  const parsed = CreatorBatchTargetProgressSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return { projectId: entry.projectId, platform: target.platform, accountId: target.accountId,
    idempotencyKey: intent.idempotencyKey, state: 'uncertain', detail: 'Invalid receipt evidence; never resubmit' };
}

/** Inspect every durable claim, including an older hash: an account already started is never eligible. */
async function localIntents(project: string, entry: CreatorBatchProject): Promise<Map<string, CreatorIntent>> {
  const result = new Map<string, CreatorIntent>();
  const directory = await localPath(project, 'publication/intents', true);
  let files: string[];
  try { files = await readdir(directory); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return result;
    throw error;
  }
  for (const file of files) {
    if (/^[a-f0-9]{64}\.result\.json$/.test(file)) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(file)) throw new Error('Unrecognized durable intent file; no new submit permitted');
    const intent = CreatorIntentSchema.parse(await readJson(project, `publication/intents/${file}`));
    if (intent.projectId !== entry.projectId || intent.idempotencyKey !== `creator:${sha256(`${entry.projectId}:${intent.videoSha256}:${intent.accountId}`)}` || file !== `${intent.idempotencyKey.slice('creator:'.length)}.json`) {
      throw new Error('Durable intent identity mismatch; never replace or resubmit');
    }
    const key = JSON.stringify([intent.platform, intent.accountId]);
    if (result.has(key)) throw new Error('Multiple durable intents for one account; never resubmit');
    result.set(key, intent);
  }
  return result;
}

async function inspectProject(batch: LoadedBatch, entry: CreatorBatchProject, spendCap: unknown): Promise<ProjectObservation> {
  const blockers: string[] = [...batch.sourceBlockers];
  const dependencies: CreatorBatchDependencyObservation[] = [];
  let path = '';
  let intents = new Map<string, CreatorIntent>();
  let unsafeIntents = false;
  try {
    path = await localPath(batch.root, entry.projectPath);
    try { intents = await localIntents(path, entry); }
    catch (error) { unsafeIntents = true; blockers.push(detailOf(error)); }
    await unchangedBatch(batch);
    const plan = await planPublication(path, spendCap);
    blockers.push(...plan.blockers);
    if (!zeroCap(spendCap)) blockers.push('Batch publication requires explicit finite --spend-cap 0; no generation is performed');
    if (plan.manifest.id !== entry.projectId || plan.manifest.preset.id !== entry.preset.id || plan.manifest.preset.version !== entry.preset.version || plan.manifest.preset.sha256 !== entry.preset.sha256) blockers.push('Project/preset snapshot differs from the batch manifest');
    if (!plan.draft.approval.approved || plan.draft.approval.digest !== entry.approval.digest || plan.digest !== entry.approval.digest) blockers.push('Current draft/approval digest differs from the batch manifest');
    if (plan.media?.videoSha256 !== entry.media.videoSha256 || plan.media?.coverSha256 !== entry.media.coverSha256) blockers.push('Current media hashes differ from the batch manifest');
    for (const target of entry.targets) {
      if (!plan.preset.publishing.targets.some((approved) => approved.platform === target.platform && approved.accountId === target.accountId && approved.username === target.username)) blockers.push(`Batch target ${target.accountId} is not an exact approved preset target`);
      const intent = intents.get(JSON.stringify([target.platform, target.accountId]));
      if (intent && (intent.digest !== entry.approval.digest || intent.videoSha256 !== entry.media.videoSha256 || (intent.evidence && intent.evidence.profileId !== plan.preset.publishing.profile.id))) blockers.push('Existing intent differs from approved batch evidence; never bypass with a new key');
    }
    for (const intent of intents.values()) {
      if (!plan.preset.publishing.targets.some((approved) => approved.accountId === intent.accountId && approved.platform === intent.platform)) blockers.push('Durable intent contains an unapproved target; no new submit permitted');
    }
    try {
      await localPath(path, 'qa/spend.json', true);
      const attempts = await openAttempts(new FileSpendLedger(spendLedgerPath(path)));
      dependencies.push({ scope: 'project', projectId: entry.projectId, effect: 'blocking', dependencyId: `${entry.projectId}:spend`,
        state: attempts.length ? 'open' : 'clear', detail: attempts.length ? 'Same-project paid ledger remains open; new publication is blocked' : 'No open same-project paid attempts' });
    } catch {
      dependencies.push({ scope: 'project', projectId: entry.projectId, effect: 'blocking', dependencyId: `${entry.projectId}:spend`, state: 'uncertain', detail: 'Invalid/unsafe same-project paid ledger; new publication is blocked' });
    }
  } catch (error) { blockers.push(detailOf(error)); }
  const targets: CreatorBatchTargetProgress[] = [];
  for (const target of entry.targets) {
    const intent = intents.get(JSON.stringify([target.platform, target.accountId]));
    if (intent) {
      let receipt: CreatorTargetResult | undefined;
      try { receipt = CreatorTargetResultSchema.parse(await readJson(path, `publication/intents/${intent.idempotencyKey.slice('creator:'.length)}.result.json`)); } catch { /* Missing/torn receipts never release the claim. */ }
      targets.push(observedResult(entry, target, intent, receipt));
    } else if (unsafeIntents) {
      targets.push({ projectId: entry.projectId, platform: target.platform, accountId: target.accountId, state: 'uncertain', detail: 'Invalid/incomplete durable claims; never submit until reconciled' });
    } else targets.push(unstarted(entry, target, blockers.length ? blockers.join('\n') : undefined));
  }
  return { path, blockers, targets, dependencies };
}

function progress(
  batch: LoadedBatch, observations: ProjectObservation[],
  capacity: readonly CreatorBatchCapacityObservation[] = [], offline = true,
): CreatorBatchProgress {
  const targets = observations.flatMap((observation) => observation.targets).map((target): CreatorBatchTargetProgress => (
    offline && batch.manifest.queuePolicy === 'require-capacity' && target.state === 'not-started'
      ? { ...target, state: 'blocked', detail: 'require-capacity: offline capacity is unknown; read-only remote preflight is required before a new claim' }
      : target
  ));
  const summary: CreatorBatchSummary = { total: targets.length, published: 0, pending: 0, notStarted: 0, uncertain: 0, failed: 0, blocked: 0 };
  for (const target of targets) summary[target.state === 'not-started' ? 'notStarted' : target.state]++;
  const accounts = new Map(batch.manifest.projects.flatMap((entry) => entry.targets.map((target) => [accountKey(target), target] as const)));
  const observed = new Map(capacity.map((observation) => [accountKey(observation), CreatorBatchCapacityObservationSchema.parse(observation)]));
  return CreatorBatchProgressSchema.parse({ schemaVersion: 1, manifest: batch.manifest, checkedAt: new Date().toISOString(), targets, summary,
    complete: summary.published === summary.total,
    capacity: [...accounts.values()].map((target) => observed.get(accountKey(target)) ?? {
      platform: target.platform, accountId: target.accountId, status: 'unknown',
      source: offline ? 'offline-no-remote-capacity-evidence' : 'provider-account-capacity-unobserved', checkedAt: null,
    }),
    dependencies: [...batch.sourceDependencies, ...observations.flatMap((observation) => observation.dependencies)] });
}

export async function planCreatorBatch(manifestPath: string, spendCap: unknown): Promise<CreatorBatchProgress> {
  const batch = await readBatch(manifestPath);
  const observations = await Promise.all(batch.manifest.projects.map((entry) => inspectProject(batch, entry, spendCap)));
  return progress(batch, observations);
}

/** Cache shared initialization failures, too: missing credentials never trigger a blind loop over clips. */
function sharedDeps(deps: CreatorDeps): CreatorDeps {
  let client: Promise<ZernioClient> | undefined;
  let storage: Promise<ObjectStore> | undefined;
  return { ...deps, client: () => client ??= deps.client(), storage: () => storage ??= deps.storage() };
}

async function observeRemote(entry: CreatorBatchProject, observation: ProjectObservation, deps: CreatorDeps): Promise<boolean> {
  const snapshotBlocked = observation.blockers.some((blocker) => !blocker.startsWith('require-capacity:')
    && !blocker.startsWith('Resolve submitted/uncertain paid attempts in qa/spend.json')
    && !blocker.startsWith('Invalid or unsafe qa/spend.json')
    && !blocker.startsWith('Source ledger'));
  if (!observation.path || snapshotBlocked || !observation.targets.some((target) => target.idempotencyKey)) return false;
  const results = await statusCreator(observation.path, deps);
  for (let index = 0; index < observation.targets.length; index++) {
    const target = observation.targets[index]!;
    if (!target.idempotencyKey) continue;
    const result = results.find((candidate) => candidate.platform === target.platform && candidate.accountId === target.accountId && candidate.idempotencyKey === target.idempotencyKey);
    if (!result || (target.state === 'failed' && result.state === 'uncertain')) continue;
    const intent = CreatorIntentSchema.parse(await readJson(observation.path, `publication/intents/${target.idempotencyKey.slice('creator:'.length)}.json`));
    observation.targets[index] = observedResult(entry, target, intent, result);
  }
  // The bridge deliberately hides upstream authentication/transport errors. An inconclusive
  // check conservatively stops further shared GET work rather than blindly probing every clip.
  return results.some((result) => result.state === 'uncertain');
}

function markRemoteUnavailable(observation: ProjectObservation): void {
  observation.targets = observation.targets.map((target): CreatorBatchTargetProgress => target.idempotencyKey
    ? { ...target, state: 'uncertain', url: undefined, detail: 'Shared remote evidence unavailable; no status proof was collected and this key must never be resubmitted' }
    : target);
}

export async function statusCreatorBatch(manifestPath: string, deps: CreatorDeps, offline = false): Promise<CreatorBatchProgress> {
  const batch = await readBatch(manifestPath);
  const shared = sharedDeps(deps);
  const observations: ProjectObservation[] = [];
  let unavailable = false;
  for (const entry of batch.manifest.projects) {
    const observation = await inspectProject(batch, entry, 0);
    if (!offline) {
      if (unavailable) markRemoteUnavailable(observation);
      else {
        try { unavailable = await observeRemote(entry, observation, shared); }
        catch { unavailable = true; markRemoteUnavailable(observation); }
      }
    }
    observations.push(observation);
  }
  return progress(batch, observations);
}

function guardedDeps(deps: CreatorDeps, check: () => Promise<void>, refused: (error: unknown) => void, sharedRefused: () => void): CreatorDeps {
  return { ...deps, media: { ...deps.media, publisher: async (journalPath): Promise<Publisher> => {
    let publisher: Publisher;
    try { publisher = await deps.media.publisher(journalPath); }
    catch (error) { sharedRefused(); throw error; }
    const guard = async (): Promise<void> => { try { await check(); } catch (error) { refused(error); throw error; } };
    return {
      id: publisher.id,
      accounts: (ctx) => publisher.accounts(ctx),
      validate: async (post, ctx) => {
        await guard();
        try { return await publisher.validate(post, ctx); }
        catch (error) { sharedRefused(); throw error; }
      },
      publish: async (post, ctx) => { await guard(); return publisher.publish(post, ctx); },
      schedule: async (post, ctx) => { await guard(); return publisher.schedule(post, ctx); },
      status: (key, ctx) => publisher.status(key, ctx),
      reconcile: (key, ctx) => publisher.reconcile(key, ctx),
    };
  } } };
}

async function executeBatch(manifestPath: string, deps: CreatorDeps, options: CreatorBatchRunOptions): Promise<CreatorBatchProgress> {
  if (options.confirm !== true) throw new Error('Batch publication/resume requires --confirm and exact local approvals');
  if (!zeroCap(options.spendCap)) throw new Error('Batch publication/resume requires explicit finite --spend-cap 0');
  const batch = await readBatch(manifestPath);
  const shared = sharedDeps(deps);
  const observations = await Promise.all(batch.manifest.projects.map((entry) => inspectProject(batch, entry, options.spendCap)));
  const stoppedAccounts = new Map<string, string>();
  const observedCapacity = new Map<string, CreatorBatchCapacityObservation>();
  const onCapacity: CreatorCapacityObserver = (capacity) => {
    for (const observation of capacity) {
      const validated = CreatorBatchCapacityObservationSchema.parse(observation);
      observedCapacity.set(accountKey(validated), validated);
    }
  };
  let sharedFailure: string | undefined;
  let remoteUnavailable = false;
  // Resolve all prior account claims before sending an earlier clip for that
  // account. A failed/uncertain claim in a later entry is still an account pause.
  for (let index = 0; index < batch.manifest.projects.length; index++) {
    const entry = batch.manifest.projects[index]!;
    const observation = observations[index]!;
    if (!sharedFailure && !remoteUnavailable) {
      try { remoteUnavailable = await observeRemote(entry, observation, shared); }
      catch {
        sharedFailure = 'Shared creator client unavailable; remaining batch work is blocked';
        markRemoteUnavailable(observation);
      }
    }
    for (const target of observation.targets) {
      if (target.state === 'failed' || target.state === 'uncertain') {
        stoppedAccounts.set(accountKey(target), 'Earlier account attempt failed/uncertain; remaining account work is blocked');
      }
    }
  }
  for (let projectIndex = 0; projectIndex < batch.manifest.projects.length; projectIndex++) {
    const entry = batch.manifest.projects[projectIndex]!;
    const observation = observations[projectIndex]!;
    // One existing controller call per new target: re-read the batch and project snapshots between submissions.
    for (const approved of entry.targets) {
      const index = observation.targets.findIndex((target) => target.accountId === approved.accountId && target.platform === approved.platform);
      const before = observation.targets[index]!;
      if (before.state !== 'not-started') continue;
      const stop = sharedFailure ?? stoppedAccounts.get(accountKey(approved));
      if (stop) { observation.targets[index] = unstarted(entry, approved, stop); continue; }
      const fresh = await inspectProject(batch, entry, options.spendCap);
      observation.dependencies = fresh.dependencies;
      const current = fresh.targets[index]!;
      if (fresh.blockers.length || current.state !== 'not-started') { observation.targets[index] = current; continue; }
      let localFailure: string | undefined;
      const guarded = guardedDeps(shared, async () => {
        const latest = await inspectProject(batch, entry, options.spendCap);
        // The controller has claimed this target by now; the durable claim is expected, not a bypass.
        if (latest.blockers.length) throw new Error(latest.blockers.join('\n'));
      }, (error) => { localFailure = detailOf(error); }, () => { sharedFailure = 'Shared creator publisher/client unavailable; remaining batch work is blocked'; });
      try {
        await publishCreator(observation.path, guarded, {
          ...options, targetAccountIds: [approved.accountId], queuePolicy: batch.manifest.queuePolicy, onCapacity,
        });
      } catch (error) {
        if (error instanceof CreatorPreflightError) {
          if (error.scope === 'account' && error.accountId === approved.accountId && (!error.platform || error.platform === approved.platform)) {
            stoppedAccounts.set(accountKey(approved), error.message);
          } else sharedFailure = error.message;
        } else {
          const latest = await inspectProject(batch, entry, options.spendCap);
          if (!latest.blockers.length) sharedFailure = 'Shared creator preflight/client/storage unavailable; remaining batch work is blocked';
        }
      }
      const latest = await inspectProject(batch, entry, options.spendCap);
      observation.dependencies = latest.dependencies;
      observation.targets[index] = latest.targets[index]!;
      if (localFailure) observation.blockers.push(localFailure);
      if (observation.targets[index]!.state === 'not-started') observation.targets[index] = unstarted(entry, approved,
        sharedFailure ?? stoppedAccounts.get(accountKey(approved)) ?? 'Publication interrupted before durable claim; no automatic retry in this run');
      if (observation.targets[index]!.state === 'failed' || observation.targets[index]!.state === 'uncertain') {
        if (!stoppedAccounts.has(accountKey(approved))) stoppedAccounts.set(accountKey(approved), 'Earlier account attempt failed/uncertain; remaining account work is blocked');
      }
    }
  }
  // Reinspect durable evidence so concurrent controllers cannot make progress an authorization to retry.
  // Preserve local blocked explanations; observing remote outcomes is GET-only and never rewrites receipts.
  for (let index = 0; index < observations.length; index++) {
    const entry = batch.manifest.projects[index]!;
    const previous = observations[index]!;
    const fresh = await inspectProject(batch, entry, options.spendCap);
    const old = new Map(previous.targets.map((target) => [targetKey(target), target]));
    fresh.targets = fresh.targets.map((target) => {
      const prior = old.get(targetKey(target));
      if (target.state === 'not-started' && prior?.state === 'blocked') return prior;
      if (target.idempotencyKey && target.idempotencyKey === prior?.idempotencyKey) return prior;
      return target;
    });
    observations[index] = fresh;
  }
  return progress(batch, observations, [...observedCapacity.values()], false);
}

export async function publishCreatorBatch(manifestPath: string, deps: CreatorDeps, options: CreatorBatchRunOptions): Promise<CreatorBatchProgress> {
  return executeBatch(manifestPath, deps, options);
}

export async function resumeCreatorBatch(manifestPath: string, deps: CreatorDeps, options: CreatorBatchRunOptions): Promise<CreatorBatchProgress> {
  return executeBatch(manifestPath, deps, options);
}

/** Audited GET reconciliation only. An open spend ledger blocks submitting, not collecting evidence. */
export async function reconcileCreatorBatch(manifestPath: string, deps: CreatorDeps, options: CreatorBatchRunOptions): Promise<CreatorBatchProgress> {
  if (options.confirm !== true) throw new Error('Batch reconciliation requires --confirm');
  if (!zeroCap(options.spendCap)) throw new Error('Batch reconciliation requires explicit finite --spend-cap 0');
  const batch = await readBatch(manifestPath);
  const shared = sharedDeps(deps);
  const observations: ProjectObservation[] = [];
  let unavailable = false;
  for (const entry of batch.manifest.projects) {
    let observation = await inspectProject(batch, entry, options.spendCap);
    const snapshotBlockers = observation.blockers.filter((blocker) => !blocker.startsWith('require-capacity:')
      && !blocker.startsWith('Resolve submitted/uncertain paid attempts in qa/spend.json')
      && !blocker.startsWith('Invalid or unsafe qa/spend.json')
      && !blocker.startsWith('Source ledger'));
    if (!unavailable && observation.path && !snapshotBlockers.length && observation.targets.some((target) => target.idempotencyKey)) {
      try {
        await unchangedBatch(batch);
        const results = await reconcileCreator(observation.path, shared, { ...options, targetAccountIds: entry.targets.map((target) => target.accountId) });
        observation = await inspectProject(batch, entry, options.spendCap);
        for (let index = 0; index < observation.targets.length; index++) {
          const target = observation.targets[index]!;
          if (!target.idempotencyKey) continue;
          const result = results.find((candidate) => candidate.platform === target.platform && candidate.accountId === target.accountId && candidate.idempotencyKey === target.idempotencyKey);
          if (!result) continue;
          const intent = CreatorIntentSchema.parse(await readJson(observation.path, `publication/intents/${target.idempotencyKey.slice('creator:'.length)}.json`));
          observation.targets[index] = observedResult(entry, target, intent, result);
        }
      } catch { unavailable = true; markRemoteUnavailable(observation); }
    }
    observations.push(observation);
  }
  return progress(batch, observations);
}
