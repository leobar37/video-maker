import { describe, expect, test } from 'bun:test';
import {
  CreatorBatchProgressSchema,
  type CreatorBatchProgress,
  type CreatorBatchSummary,
  type CreatorBatchTargetProgress,
} from '@videomaker/schemas';
import { buildPublicCreatorBatchStatus } from './batch-status';

const checkedAt = '2026-10-03T12:00:00+00:00';
const targetCheckedAt = '2026-10-02T10:00:00Z';
const capacityCheckedAt = '2026-10-01T08:00:00Z';
const defaultPlatforms: CreatorBatchTargetProgress['platform'][] = ['tiktok', 'youtube', 'instagram'];

function fixture(platforms = defaultPlatforms): CreatorBatchProgress {
  const projects = Array.from({ length: 8 }, (_, index) => ({
    projectPath: `projects/secret-path-${index + 1}`,
    projectId: `secret-project-${index + 1}`,
    preset: { id: 'secret-preset', version: 1, sha256: 'a'.repeat(64) },
    approval: { approved: true as const, digest: 'b'.repeat(64) },
    media: { videoSha256: 'c'.repeat(64), coverSha256: 'd'.repeat(64) },
    targets: platforms.map((platform) => ({ platform, accountId: `secret-account-${platform}`, username: `secret-username-${platform}` })),
  }));
  const targets: CreatorBatchTargetProgress[] = projects.flatMap((project, index) => project.targets.map((target, targetIndex) => ({
    projectId: project.projectId,
    platform: target.platform,
    accountId: target.accountId,
    state: index >= 6 && target.platform === 'tiktok' ? 'pending' : 'published',
    idempotencyKey: `creator:${(index * platforms.length + targetIndex).toString(16).padStart(64, '0')}`,
    remoteId: `secret-remote-${index}-${targetIndex}`,
    checkedAt: targetCheckedAt,
    detail: 'secret-provider-error secret-caption secret-profile secret-journal',
  })));
  const summary: CreatorBatchSummary = { total: targets.length, published: targets.length - 2, pending: 2, notStarted: 0, uncertain: 0, failed: 0, blocked: 0 };
  return CreatorBatchProgressSchema.parse({
    schemaVersion: 1,
    manifest: { schemaVersion: 1, batchId: 'secret-batch', queuePolicy: 'allow-provider-queue', projects },
    checkedAt,
    targets,
    summary,
    complete: false,
    capacity: [
      { platform: 'tiktok', accountId: 'secret-account-tiktok', status: 'unknown', source: 'secret-source-offline', checkedAt: null, detail: 'secret-capacity-detail' },
      { platform: 'youtube', accountId: 'secret-account-youtube', status: 'estimated', source: 'secret-source-estimate', checkedAt: capacityCheckedAt, remaining: 2, available: 1, canPostMore: true, resetAt: '2026-10-04T00:00:00Z', nextRetryAt: '2026-10-03T13:00:00Z' },
      { platform: 'instagram', accountId: 'secret-account-instagram', status: 'confirmed', source: 'secret-source-provider', checkedAt: capacityCheckedAt, remaining: 0, canPostMore: false },
    ],
    dependencies: [{ dependencyId: 'secret-dependency', scope: 'independent', effect: 'informative', state: 'uncertain', detail: 'secret-ledger-detail' }],
  });
}

function withStates(progress: CreatorBatchProgress, states: CreatorBatchTargetProgress['state'][]): CreatorBatchProgress {
  const targets = progress.targets.map((target, index) => {
    const state = states[index] ?? target.state;
    if (state === 'not-started' || state === 'blocked') {
      return { projectId: target.projectId, platform: target.platform, accountId: target.accountId, state };
    }
    return { ...target, state };
  });
  const summary: CreatorBatchSummary = { total: targets.length, published: 0, pending: 0, notStarted: 0, uncertain: 0, failed: 0, blocked: 0 };
  for (const target of targets) summary[target.state === 'not-started' ? 'notStarted' : target.state] += 1;
  return CreatorBatchProgressSchema.parse({ ...progress, targets, summary, complete: summary.published === summary.total });
}

function withUrl(progress: CreatorBatchProgress, url: string, index = 0): CreatorBatchProgress {
  return { ...progress, targets: progress.targets.map((target, targetIndex) => targetIndex === index ? { ...target, url } : target) };
}

describe('public creator batch snapshot', () => {
  test('8 clips × 3 platforms means 22 published and 2 pending, not completed', () => {
    const progress = fixture();
    const report = buildPublicCreatorBatchStatus(progress);
    expect(report.schemaVersion).toBe(1);
    expect(report.clipCount).toBe(8);
    expect(report.summary).toEqual({ total: 24, published: 22, pending: 2, notStarted: 0, uncertain: 0, failed: 0, blocked: 0 });
    expect(report.complete).toBe(false);
    expect(report.targets).toHaveLength(24);
    expect(report.targets.filter((target) => target.state === 'pending')).toEqual([
      { clipOrdinal: 7, targetOrdinal: 1, platform: 'tiktok', state: 'pending', checkedAt: targetCheckedAt },
      { clipOrdinal: 8, targetOrdinal: 1, platform: 'tiktok', state: 'pending', checkedAt: targetCheckedAt },
    ]);
    expect(report.targets[1]).toEqual({ clipOrdinal: 1, targetOrdinal: 2, platform: 'youtube', state: 'published', checkedAt: targetCheckedAt });
    // Ordinals follow approved manifest order, not arbitrary observation order.
    expect(buildPublicCreatorBatchStatus({ ...progress, targets: [...progress.targets].reverse() })).toEqual(report);
  });

  test('uses original snapshot and observation timestamps with manual-only refresh', () => {
    const report = buildPublicCreatorBatchStatus(fixture());
    expect(report.checkedAt).toBe(checkedAt);
    expect(report.targets[0]!.checkedAt).toBe(targetCheckedAt);
    expect(report.capacity![1]!.checkedAt).toBe(capacityCheckedAt);
    expect(report.refresh).toBe('manual');
    expect(report.autoMonitoring).toBe(false);
    expect(report.capacity![0]).toEqual({ observationOrdinal: 1, platform: 'tiktok', status: 'unknown', checkedAt: null });
    expect(report.capacity![1]).toEqual({ observationOrdinal: 2, platform: 'youtube', status: 'estimated', checkedAt: capacityCheckedAt, remaining: 2, available: 1, canPostMore: true, resetAt: '2026-10-04T00:00:00Z', nextRetryAt: '2026-10-03T13:00:00Z' });
    expect(report.capacity![2]!.remaining).toBe(0);
    expect(report.capacity![2]!.canPostMore).toBe(false);
    expect(buildPublicCreatorBatchStatus({ ...fixture(), capacity: [] })).not.toHaveProperty('capacity');
  });

  test('all states remain independent and completion requires every target published', () => {
    const progress = withStates(fixture(), ['published', 'pending', 'not-started', 'uncertain', 'failed', 'blocked']);
    const report = buildPublicCreatorBatchStatus(progress);
    expect(report.targets.slice(0, 6).map((target) => target.state)).toEqual(['published', 'pending', 'not-started', 'uncertain', 'failed', 'blocked']);
    expect(report.summary).toEqual({ total: 24, published: 17, pending: 3, notStarted: 1, uncertain: 1, failed: 1, blocked: 1 });
    expect(report.targets[2]).not.toHaveProperty('checkedAt');
    expect(report.complete).toBe(false);
    const completed = buildPublicCreatorBatchStatus(withStates(fixture(), Array(24).fill('published')));
    expect(completed.complete).toBe(true);
    expect(completed.summary.published).toBe(24);
    expect(completed.summary.pending).toBe(0);
  });

  test('never serializes deliberate private identities, proof, paths, errors or free strings', () => {
    const progress = fixture();
    const publicJson = JSON.stringify(buildPublicCreatorBatchStatus(progress));
    expect(publicJson).not.toContain('secret-');
    for (const secret of [
      progress.manifest.batchId,
      ...progress.manifest.projects.flatMap((project) => [project.projectPath, project.projectId, project.preset.id, project.preset.sha256, project.approval.digest, project.media.videoSha256, project.media.coverSha256, ...project.targets.flatMap((target) => [target.accountId, target.username])]),
      ...progress.targets.flatMap((target) => [target.idempotencyKey!, target.remoteId!, target.detail!]),
      ...progress.capacity.map((observation) => observation.source),
      ...progress.dependencies.flatMap((dependency) => [dependency.dependencyId, dependency.detail]),
    ]) expect(publicJson).not.toContain(secret);
    for (const key of ['manifest', 'batchId', 'projectId', 'accountId', 'username', 'remoteId', 'idempotencyKey', 'detail', 'source', 'approval', 'digest', 'media', 'dependencies', 'caption', 'journal', 'profile']) {
      expect(publicJson).not.toContain(`"${key}":`);
    }
  });

  test('validates malformed private snapshots before any public projection', () => {
    const progress = fixture();
    const malformed: unknown[] = [
      null,
      {},
      { ...progress, schemaVersion: 2 },
      { ...progress, checkedAt: 'yesterday' },
      { ...progress, complete: true },
      { ...progress, summary: { ...progress.summary, published: 24, pending: 0 } },
      { ...progress, targets: progress.targets.slice(1) },
      { ...progress, targets: [{ ...progress.targets[0], remoteId: undefined }, ...progress.targets.slice(1)] },
      { ...progress, targets: [progress.targets[0], ...progress.targets.slice(0, -1)] },
      { ...progress, capacity: [{ ...progress.capacity[0], remaining: 99 }] },
      { ...progress, rawSecret: 'secret-extra-field' },
    ];
    for (const value of malformed) expect(() => buildPublicCreatorBatchStatus(value as CreatorBatchProgress)).toThrow();
  });

  test('accepts only matching-platform recognized HTTPS public post URLs', () => {
    const platforms: CreatorBatchTargetProgress['platform'][] = ['tiktok', 'youtube', 'instagram', 'twitter', 'linkedin', 'facebook'];
    const progress = fixture(platforms);
    const urls = [
      'https://www.tiktok.com/@public_user/video/1234567890123456789',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.instagram.com/reel/Public_123/',
      'https://x.com/public_user/status/1234567890123456789',
      'https://www.linkedin.com/feed/update/urn:li:activity:1234567890123456789/',
      'https://www.facebook.com/public.user/posts/1234567890',
    ];
    for (const [index, url] of urls.entries()) expect(buildPublicCreatorBatchStatus(withUrl(progress, url, index)).targets[index]!.url).toBe(url);
    for (const url of ['https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/shorts/dQw4w9WgXcQ']) {
      expect(buildPublicCreatorBatchStatus(withUrl(progress, url, 1)).targets[1]!.url).toBe(url);
    }
    for (const url of ['https://www.facebook.com/reel/1234567890/', 'https://www.facebook.com/watch/?v=1234567890', 'https://www.facebook.com/permalink.php?story_fbid=pfbidPublic123&id=1234567890']) {
      expect(buildPublicCreatorBatchStatus(withUrl(progress, url, 5)).targets[5]!.url).toBe(url);
    }
    expect(buildPublicCreatorBatchStatus(withUrl(progress, urls[1]!)).targets[0]).not.toHaveProperty('url');
    expect(buildPublicCreatorBatchStatus(withUrl(fixture(), urls[0]!, 18)).targets[18]).not.toHaveProperty('url');
    expect(buildPublicCreatorBatchStatus(withStates(withUrl(fixture(), urls[0]!), ['uncertain'])).targets[0]).not.toHaveProperty('url');
  });

  test('drops hostile protocols, private hosts, upload paths, credentials and signed queries', () => {
    const progress = fixture();
    const attacks = [
      'http://www.tiktok.com/@public/video/123',
      'javascript:alert(1)',
      'data:text/plain,secret-payload',
      'file:///secret-journal',
      'https://127.0.0.1/@public/video/123',
      'https://[::1]/@public/video/123',
      'https://10.0.0.1/@public/video/123',
      'https://100.64.0.1/@public/video/123',
      'https://localhost/@public/video/123',
      'https://www.tiktok.com.evil.example/@public/video/123',
      'https://evil.example/@public/video/123',
      'https://secret-user:secret-password@www.tiktok.com/@public/video/123',
      'https://www.tiktok.com:8443/@public/video/123',
      'https://www.tiktok.com/@public/video/123?token=secret-token',
      'https://www.tiktok.com/@public/video/123?X-Amz-Signature=secret-signature',
      'https://www.tiktok.com/@public/video/123#secret-fragment',
      'https://www.tiktok.com/upload/123.mp4',
      'https://www.tiktok.com/@public/video/123.mp4',
      'https://cdn.tiktok.com/@public/video/123',
      'https://www.tiktok.com/@public/video/%31%32%33',
      'https://www.tiktok.com/secret/../@public/video/123',
      'https://www.tiktok.com/@public/video/123/secret-journal',
    ];
    for (const url of attacks) {
      const report = buildPublicCreatorBatchStatus(withUrl(progress, url));
      expect(report.targets[0]).not.toHaveProperty('url');
      expect(JSON.stringify(report)).not.toContain('secret-');
    }
    for (const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&token=secret-token', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&v=dQw4w9WgXcQ', 'https://www.youtube.com/embed/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=secret-id']) {
      expect(buildPublicCreatorBatchStatus(withUrl(progress, url, 1)).targets[1]).not.toHaveProperty('url');
    }
  });

  test('returns a detached immutable snapshot without mutating or retaining its source', () => {
    // Mutable input checks that parsing/freezing is confined to the detached projection.
    const progress = JSON.parse(JSON.stringify(fixture())) as CreatorBatchProgress;
    const before = JSON.stringify(progress);
    const report = buildPublicCreatorBatchStatus(progress);
    expect(JSON.stringify(progress)).toBe(before);
    expect(Object.isFrozen(progress)).toBe(false);
    expect(Object.isFrozen(progress.manifest)).toBe(false);
    for (const value of [report, report.summary, report.targets, ...report.targets, report.capacity!, ...report.capacity!]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(Reflect.set(report, 'checkedAt', 'secret-new-time')).toBe(false);
    expect(Reflect.set(report.summary, 'published', 24)).toBe(false);
    expect(Reflect.set(report.targets[0]!, 'state', 'pending')).toBe(false);
    expect(Reflect.set(report.capacity![0]!, 'remaining', 99)).toBe(false);
    const publicBefore = JSON.stringify(report);
    progress.checkedAt = '2026-10-04T12:00:00Z';
    progress.targets[0]!.state = 'uncertain';
    progress.capacity[1]!.remaining = 99;
    expect(JSON.stringify(report)).toBe(publicBefore);
  });
});
