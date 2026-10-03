import { describe, expect, test } from 'bun:test';
import {
  CreatorBatchCapacityObservationSchema,
  CreatorBatchDependencyObservationSchema,
  CreatorBatchManifestSchema,
  CreatorBatchProgressSchema,
  type CreatorBatchManifest,
  type CreatorBatchProgress,
  type CreatorBatchSummary,
  type CreatorBatchTargetProgress,
} from './creator-batch';

const digest = 'a'.repeat(64);
const checkedAt = '2026-10-03T12:00:00Z';

function manifestFixture(): CreatorBatchManifest {
  return CreatorBatchManifestSchema.parse({
    schemaVersion: 1,
    batchId: 'eight-clips',
    projects: Array.from({ length: 8 }, (_, index) => ({
      projectPath: `projects/clip-${index + 1}`,
      projectId: `clip-${index + 1}`,
      preset: { id: 'approved-preset', version: 1, sha256: digest },
      approval: { approved: true, digest },
      media: { videoSha256: 'b'.repeat(64), coverSha256: 'c'.repeat(64) },
      targets: [
        { platform: 'tiktok', accountId: 'tt-1', username: 'approved-tiktok' },
        { platform: 'youtube', accountId: 'yt-1', username: 'approved-youtube' },
        { platform: 'instagram', accountId: 'ig-1', username: 'approved-instagram' },
      ],
    })),
  });
}

function summaryFor(targets: readonly Pick<CreatorBatchTargetProgress, 'state'>[]): CreatorBatchSummary {
  const counts: CreatorBatchSummary = { total: targets.length, published: 0, pending: 0, notStarted: 0, uncertain: 0, failed: 0, blocked: 0 };
  for (const target of targets) counts[target.state === 'not-started' ? 'notStarted' : target.state] += 1;
  return counts;
}

function progressFixture(): CreatorBatchProgress {
  const manifest = manifestFixture();
  const targets: CreatorBatchTargetProgress[] = manifest.projects.flatMap((project, index) => project.targets.map((target, targetIndex): CreatorBatchTargetProgress => ({
    projectId: project.projectId,
    platform: target.platform,
    accountId: target.accountId,
    state: index >= 6 && target.platform === 'tiktok' ? 'pending' : 'published',
    idempotencyKey: `creator:${(index * 3 + targetIndex).toString(16).padStart(64, '0')}`,
    remoteId: `remote-${index}-${targetIndex}`,
    checkedAt,
  })));
  return CreatorBatchProgressSchema.parse({
    schemaVersion: 1, manifest, checkedAt, targets, summary: summaryFor(targets), complete: false,
    capacity: [{ platform: 'tiktok', accountId: 'tt-1', status: 'unknown', source: 'offline: remote capacity not checked', checkedAt: null }],
  });
}

function withFirstProject(fields: Record<string, unknown>): unknown {
  const manifest = manifestFixture();
  return { ...manifest, projects: [{ ...manifest.projects[0], ...fields }, ...manifest.projects.slice(1)] };
}

describe('creator batch manifest', () => {
  test('pins immutable approval, preset, media and target identities without editing settings', () => {
    const manifest = manifestFixture();
    const project = manifest.projects[0]!;
    expect(manifest.queuePolicy).toBe('allow-provider-queue');
    expect(project.approval).toEqual({ approved: true, digest });
    for (const value of [manifest, manifest.projects, project, project.preset, project.approval, project.media, project.targets, project.targets[0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(project.approval, 'digest', 'd'.repeat(64))).toBe(false);
    expect(Reflect.set(project.preset, 'version', 2)).toBe(false);
    expect(Reflect.set(project.targets[0]!, 'accountId', 'replacement')).toBe(false);
    expect(CreatorBatchManifestSchema.safeParse({ ...manifest, queuePolicy: 'require-capacity' }).success).toBe(true);
    expect(CreatorBatchManifestSchema.safeParse({ ...manifest, queuePolicy: 'skip-preflight' }).success).toBe(false);
  });

  test('rejects empty, absolute, traversal and noncanonical project paths', () => {
    for (const projectPath of ['', '.', '..', '../clip', 'projects/../clip', '/projects/clip', 'C:/clip', 'C:clip', 'projects\\clip', 'projects//clip', 'projects/./clip', 'projects/clip/', 'projects/clip\0', 'projects/clip\n']) {
      expect(CreatorBatchManifestSchema.safeParse(withFirstProject({ projectPath })).success).toBe(false);
    }
  });

  test('rejects duplicate projects, target accounts and conflicting account identities', () => {
    const manifest = manifestFixture();
    const first = manifest.projects[0]!;
    expect(CreatorBatchManifestSchema.safeParse(withFirstProject({ projectPath: manifest.projects[1]!.projectPath })).success).toBe(false);
    expect(CreatorBatchManifestSchema.safeParse(withFirstProject({ projectId: manifest.projects[1]!.projectId })).success).toBe(false);
    expect(CreatorBatchManifestSchema.safeParse(withFirstProject({ targets: [...first.targets, first.targets[0]] })).success).toBe(false);
    for (const change of [{ platform: 'youtube' }, { username: 'different-person' }, { accountId: '' }]) {
      const targets = [{ ...first.targets[0], ...change }, ...first.targets.slice(1)];
      expect(CreatorBatchManifestSchema.safeParse(withFirstProject({ targets })).success).toBe(false);
    }
    expect(CreatorBatchManifestSchema.safeParse({ ...manifest, projects: [] }).success).toBe(false);
    expect(CreatorBatchManifestSchema.safeParse(withFirstProject({ targets: [] })).success).toBe(false);
  });

  test('rejects invalid digests, unapproved identities and settings/ledger overrides', () => {
    const first = manifestFixture().projects[0]!;
    for (const invalidDigest of ['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), null]) {
      for (const fields of [
        { preset: { ...first.preset, sha256: invalidDigest } },
        { approval: { approved: true, digest: invalidDigest } },
        { media: { ...first.media, videoSha256: invalidDigest } },
        { media: { ...first.media, coverSha256: invalidDigest } },
      ]) expect(CreatorBatchManifestSchema.safeParse(withFirstProject(fields)).success).toBe(false);
    }
    for (const fields of [
      { approval: { approved: false, digest } },
      { approval: { digest } },
      { approval: { approved: true, digest, ignoreLedger: true } },
      { preset: { ...first.preset, version: 0 } },
      { preset: { ...first.preset, publishing: {} } },
      { targets: [{ ...first.targets[0], options: { privacyLevel: 'SELF_ONLY' } }] },
      { targets: [{ ...first.targets[0], required: false }] },
      { ignoreProjectLedger: true },
    ]) expect(CreatorBatchManifestSchema.safeParse(withFirstProject(fields)).success).toBe(false);
    expect(CreatorBatchManifestSchema.safeParse({ ...manifestFixture(), schemaVersion: 2 }).success).toBe(false);
  });
});

describe('creator batch progress', () => {
  test('8x3 fixture reports 22 published and two pending, never complete', () => {
    const progress = progressFixture();
    expect(progress.targets).toHaveLength(24);
    expect(progress.summary).toEqual({ total: 24, published: 22, pending: 2, notStarted: 0, uncertain: 0, failed: 0, blocked: 0 });
    expect(progress.complete).toBe(false);
    expect(progress.targets.filter((target) => target.state === 'pending').every((target) => target.platform === 'tiktok')).toBe(true);
    expect(CreatorBatchProgressSchema.safeParse({ ...progress, complete: true }).success).toBe(false);
  });

  test('target states remain independent and summaries must match them', () => {
    const progress = progressFixture();
    const targets: CreatorBatchTargetProgress[] = progress.targets.map((target, index): CreatorBatchTargetProgress => {
      if (index === 0 || index === 1) return { projectId: target.projectId, platform: target.platform, accountId: target.accountId, state: index === 0 ? 'not-started' : 'blocked', detail: 'Project gate' };
      if (index === 2 || index === 3) return { ...target, state: index === 2 ? 'uncertain' : 'failed' };
      return target;
    });
    const parsed = CreatorBatchProgressSchema.parse({ ...progress, targets, summary: summaryFor(targets) });
    expect(parsed.summary).toEqual({ total: 24, published: 18, pending: 2, notStarted: 1, uncertain: 1, failed: 1, blocked: 1 });
    expect(parsed.targets[4]!.state).toBe('published');
    expect(CreatorBatchProgressSchema.safeParse({ ...parsed, summary: progress.summary }).success).toBe(false);
    expect(CreatorBatchProgressSchema.safeParse({ ...parsed, summary: { ...parsed.summary, total: 23 } }).success).toBe(false);
  });

  test('cannot omit, duplicate, substitute or add an unapproved target', () => {
    const progress = progressFixture();
    for (const targets of [
      progress.targets.slice(1),
      [...progress.targets, progress.targets[0]!],
      [progress.targets[1]!, ...progress.targets.slice(1)],
      [{ ...progress.targets[0]!, projectId: 'unapproved' }, ...progress.targets.slice(1)],
      [{ ...progress.targets[0]!, accountId: 'different-account' }, ...progress.targets.slice(1)],
      [{ ...progress.targets[0]!, platform: 'facebook' }, ...progress.targets.slice(1)],
    ]) expect(CreatorBatchProgressSchema.safeParse({ ...progress, targets, summary: summaryFor(targets) }).success).toBe(false);
  });

  test('completion requires proof for every destination and cannot understate all-published completion', () => {
    const progress = progressFixture();
    const targets: CreatorBatchTargetProgress[] = progress.targets.map((target): CreatorBatchTargetProgress => ({ ...target, state: 'published' }));
    const complete = { ...progress, targets, summary: summaryFor(targets), complete: true };
    expect(CreatorBatchProgressSchema.safeParse(complete).success).toBe(true);
    expect(CreatorBatchProgressSchema.safeParse({ ...complete, complete: false }).success).toBe(false);
    for (const fields of [{ remoteId: undefined }, { idempotencyKey: undefined }, { checkedAt: undefined }, { checkedAt: 'yesterday' }]) {
      expect(CreatorBatchProgressSchema.safeParse({ ...complete, targets: [{ ...targets[0], ...fields }, ...targets.slice(1)] }).success).toBe(false);
    }
    expect(CreatorBatchProgressSchema.safeParse({ ...progress, targets: [{ ...progress.targets[0], state: 'not-started' }, ...progress.targets.slice(1)] }).success).toBe(false);
    expect(CreatorBatchProgressSchema.safeParse({ ...progress, checkedAt: 'not-a-timestamp' }).success).toBe(false);
  });

  test('observations expose uncertainty without fabricated remaining quota or a project-ledger bypass', () => {
    const progress = progressFixture();
    expect(progress.capacity[0]!.checkedAt).toBeNull();
    expect(progress.capacity[0]!.status).toBe('unknown');
    const observation = { platform: 'tiktok', accountId: 'tt-1', status: 'unknown', source: 'documented creator-info', checkedAt };
    expect(CreatorBatchCapacityObservationSchema.safeParse({ ...observation, canPostMore: true }).success).toBe(true);
    expect(CreatorBatchCapacityObservationSchema.safeParse({ ...observation, remaining: 15 }).success).toBe(false);
    expect(CreatorBatchCapacityObservationSchema.safeParse({ ...observation, available: 15 }).success).toBe(false);
    expect(CreatorBatchCapacityObservationSchema.safeParse({ ...observation, status: 'confirmed', remaining: 2, nextRetryAt: checkedAt }).success).toBe(true);
    expect(CreatorBatchCapacityObservationSchema.safeParse({ ...observation, status: 'confirmed', checkedAt: null }).success).toBe(false);
    expect(CreatorBatchCapacityObservationSchema.safeParse({ ...observation, checkedAt: null, canPostMore: true }).success).toBe(false);
    expect(CreatorBatchProgressSchema.safeParse({ ...progress, capacity: [...progress.capacity, progress.capacity[0]] }).success).toBe(false);
    expect(CreatorBatchProgressSchema.safeParse({ ...progress, capacity: [{ ...observation, accountId: 'unapproved' }] }).success).toBe(false);
    const dependency = { dependencyId: 'typesafe-evaluation', state: 'uncertain', detail: 'Independent evaluation ledger remains open' };
    expect(CreatorBatchDependencyObservationSchema.safeParse({ ...dependency, scope: 'independent', effect: 'informative' }).success).toBe(true);
    expect(CreatorBatchDependencyObservationSchema.safeParse({ ...dependency, scope: 'project', projectId: 'clip-1', effect: 'informative' }).success).toBe(false);
    expect(CreatorBatchProgressSchema.safeParse({ ...progress, dependencies: [{ ...dependency, scope: 'project', projectId: 'unknown', effect: 'blocking' }] }).success).toBe(false);
  });
});
