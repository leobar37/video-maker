import { describe, expect, it } from 'bun:test';
import type { ProviderContext, PublishOutcomeKind } from '../ports';
import { ZernioClient } from './client';
import { InMemoryPublicationJournal, type PublicationJournalEntry } from './journal';
import {
  reconcileByKey,
  remoteReconcileLookup,
  statusByKey,
  type ReconcileFinding,
  type RemotePostEvidence,
} from './status';

interface RecordedRequest {
  method: string;
  path: string;
}

interface TestResponse {
  status: number;
  body: unknown;
}

function harness(handler: (call: RecordedRequest) => TestResponse, mode: 'plan' | 'run' = 'run') {
  const calls: RecordedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const call = { method: init?.method ?? 'GET', path: url.pathname.replace('/api/v1', '') + url.search };
    calls.push(call);
    const result = handler(call);
    return new Response(JSON.stringify(result.body), { status: result.status });
  }) as typeof fetch;
  const ctx: ProviderContext = {
    mode, fetchImpl,
    secrets: { getSecret: async () => { throw new Error('no secret reads'); } },
    clock: { now: () => new Date('2026-09-24T12:00:00.000Z') },
  };
  const client = new ZernioClient({ apiKey: 'test-only', fetchImpl });
  return { calls, ctx, client };
}

const EVIDENCE: RemotePostEvidence = {
  profileId: 'profile-1', platform: 'instagram', accountId: 'account-1',
  content: 'Exact caption\n#tag', videoUrl: 'https://media.example/video.mp4',
  coverUrl: 'https://media.example/cover.jpg',
  createdAfter: '2026-09-24T10:00:00.000Z', createdBefore: '2026-09-24T11:00:00.000Z',
};

function post(id: string, status = 'published') {
  return {
    _id: id, profileId: EVIDENCE.profileId, content: EVIDENCE.content,
    createdAt: '2026-09-24T10:30:00.000Z',
    mediaItems: [{ type: 'video', url: EVIDENCE.videoUrl, thumbnail: EVIDENCE.coverUrl }],
    platforms: [{ platform: EVIDENCE.platform, accountId: EVIDENCE.accountId,
      status, platformPostUrl: `https://social.example/${id}` }],
  };
}

function listing(posts: unknown[], page = 1, total = posts.length) {
  return { posts, pagination: { page, limit: 100, total, pages: Math.ceil(total / 100) } };
}

async function journalOf(outcome: PublishOutcomeKind = 'uncertain', remoteId?: string) {
  const journal = new InMemoryPublicationJournal();
  const entry: PublicationJournalEntry = {
    schemaVersion: 1, idempotencyKey: 'key-1', attempt: 1, outcome,
    at: '2026-09-24T10:00:00.000Z', ...(remoteId ? { remoteId } : {}),
  };
  await journal.append(entry);
  return journal;
}

function unrelatedPage() {
  return Array.from({ length: 100 }, (_, index) => ({ ...post(`unrelated-${index}`), requestId: `other-${index}` }));
}

describe('remoteReconcileLookup safe identity proof', () => {
  it('matches the exact echoed key, never the first post or an undocumented filter', async () => {
    const h = harness(() => ({ status: 200, body: listing([
      { ...post('wrong'), requestId: 'another-key' },
      { ...post('right'), requestId: 'key-1' },
    ]) }));
    expect(await remoteReconcileLookup(h.client)('key-1', h.ctx)).toMatchObject({
      verdict: 'found', remoteId: 'right', outcome: 'published', evidenceSource: 'echoed-key',
      url: 'https://social.example/right',
    });
    expect(h.calls).toEqual([{ method: 'GET', path: '/posts?limit=100&offset=0' }]);
  });

  it('traverses all official pages before claiming a unique match', async () => {
    const first = unrelatedPage();
    first[0] = { ...post('right'), requestId: 'key-1' };
    const h = harness((call) => ({ status: 200,
      body: call.path.endsWith('offset=0') ? listing(first, 1, 101) : listing([post('other-page')], 2, 101),
    }));
    expect(await remoteReconcileLookup(h.client)('key-1', h.ctx)).toMatchObject({ verdict: 'found', remoteId: 'right' });
    expect(h.calls.map((call) => call.path)).toEqual(['/posts?limit=100&offset=0', '/posts?limit=100&offset=100']);
  });

  it('can find an echoed key on a later page', async () => {
    const h = harness((call) => ({ status: 200, body: call.path.endsWith('offset=0')
      ? listing(unrelatedPage(), 1, 101) : listing([{ ...post('later'), idempotencyKey: 'key-1' }], 2, 101) }));
    expect(await remoteReconcileLookup(h.client)('key-1', h.ctx)).toMatchObject({ verdict: 'found', remoteId: 'later' });
    expect(h.calls).toHaveLength(2);
  });

  it('rejects a second match even when it appears on a later page', async () => {
    const first = unrelatedPage();
    first[0] = { ...post('first-match'), requestId: 'key-1' };
    const h = harness((call) => ({ status: 200, body: call.path.endsWith('offset=0')
      ? listing(first, 1, 101) : listing([{ ...post('second-match'), requestId: 'key-1' }], 2, 101) }));
    expect((await remoteReconcileLookup(h.client)('key-1', h.ctx)).verdict).toBe('inconclusive');
    expect(h.calls).toHaveLength(2);
  });

  for (const [name, body] of [
    ['empty unfiltered list', listing([])],
    ['missing pagination', { posts: [{ ...post('candidate'), requestId: 'key-1' }] }],
    ['wrong documented pagination shape', { posts: [post('candidate')], pagination: { hasMore: false, total: 1 } }],
    ['incomplete page', listing([{ ...post('candidate'), requestId: 'key-1' }], 1, 101)],
    ['inconsistent page count', { ...listing([post('candidate')]), pagination: { page: 1, limit: 100, total: 1, pages: 2 } }],
    ['malformed post', listing([{ content: 'no identity' }])],
    ['two echoed matches', listing([{ ...post('one'), requestId: 'key-1' }, { ...post('two'), idempotencyKey: 'key-1' }])],
    ['conflicting echoes', listing([{ ...post('one'), requestId: 'key-1', idempotencyKey: 'other' }])],
  ] as const) {
    it(`${name} is inconclusive and never authoritative absence`, async () => {
      const h = harness(() => ({ status: 200, body }));
      expect((await remoteReconcileLookup(h.client, { evidence: EVIDENCE })('key-1', h.ctx)).verdict).toBe('inconclusive');
    });
  }

  it('rejects pagination drift after a matching first page', async () => {
    const first = unrelatedPage();
    first[0] = { ...post('match'), requestId: 'key-1' };
    const h = harness((call) => ({ status: 200, body: call.path.endsWith('offset=0')
      ? listing(first, 1, 101) : listing([post('other')], 2, 102) }));
    expect((await remoteReconcileLookup(h.client)('key-1', h.ctx)).verdict).toBe('inconclusive');
  });

  it('rejects repeated identities across pages', async () => {
    const first = unrelatedPage();
    first[0] = { ...post('match'), requestId: 'key-1' };
    const h = harness((call) => ({ status: 200, body: call.path.endsWith('offset=0')
      ? listing(first, 1, 101) : listing([{ ...post('match'), requestId: 'key-1' }], 2, 101) }));
    expect((await remoteReconcileLookup(h.client)('key-1', h.ctx)).verdict).toBe('inconclusive');
  });

  it('a bounded pagination cap cannot prove uniqueness', async () => {
    const h = harness((call) => {
      const offset = Number(new URL(`https://example.test${call.path}`).searchParams.get('offset'));
      const posts = Array.from({ length: 100 }, (_, index) => ({ ...post(`post-${offset + index}`),
        requestId: offset + index === 0 ? 'key-1' : `other-${offset + index}` }));
      return { status: 200, body: listing(posts, offset / 100 + 1, 10100) };
    });
    const finding = await remoteReconcileLookup(h.client)('key-1', h.ctx);
    expect(finding.verdict).toBe('inconclusive');
    expect(finding.detail).toContain('cap');
    expect(h.calls).toHaveLength(100);
  });

  it('accepts a unique complete payload with populated profile/account identities', async () => {
    const candidate = { ...post('payload'), profileId: { _id: EVIDENCE.profileId },
      platforms: [{ ...post('payload').platforms[0], accountId: { _id: EVIDENCE.accountId } }] };
    const h = harness(() => ({ status: 200, body: listing([candidate]) }));
    expect(await remoteReconcileLookup(h.client, { evidence: EVIDENCE })('key-1', h.ctx)).toMatchObject({
      verdict: 'found', remoteId: 'payload', evidenceSource: 'payload', outcome: 'published',
    });
  });

  it('payload uniqueness also requires every page, and preserves pending acceptance', async () => {
    const first = unrelatedPage().map((candidate, index) => index === 0 ? post('payload', 'pending') : candidate);
    const h = harness((call) => ({ status: 200, body: call.path.endsWith('offset=0')
      ? listing(first, 1, 101) : listing([{ ...post('other'), requestId: 'another-key' }], 2, 101) }));
    expect(await remoteReconcileLookup(h.client, { evidence: EVIDENCE })('key-1', h.ctx)).toMatchObject({
      verdict: 'found', remoteId: 'payload', outcome: 'accepted', evidenceSource: 'payload',
    });
    expect(h.calls).toHaveLength(2);
  });

  it('a later-page HTTP failure prevents proof from the first page', async () => {
    const first = unrelatedPage();
    first[0] = { ...post('match'), requestId: 'key-1' };
    const h = harness((call) => call.path.endsWith('offset=0')
      ? { status: 200, body: listing(first, 1, 101) } : { status: 500, body: {} });
    expect((await remoteReconcileLookup(h.client)('key-1', h.ctx)).verdict).toBe('inconclusive');
    expect(h.calls).toHaveLength(2);
  });

  it('a singular post with list pagination is still a malformed list', async () => {
    const h = harness(() => ({ status: 200, body: {
      ...post('single'), requestId: 'key-1', pagination: { page: 1, limit: 100, total: 1, pages: 1 },
    } }));
    expect((await remoteReconcileLookup(h.client)('key-1', h.ctx)).verdict).toBe('inconclusive');
  });

  it('rejects duplicate full payloads without echoed keys', async () => {
    const h = harness(() => ({ status: 200, body: listing([post('one'), post('two')]) }));
    expect((await remoteReconcileLookup(h.client, { evidence: EVIDENCE })('key-1', h.ctx)).verdict).toBe('inconclusive');
  });

  const base = post('payload');
  for (const [name, candidate] of [
    ['wrong profile', { ...base, profileId: 'other' }],
    ['missing profile', { ...base, profileId: undefined }],
    ['wrong account', { ...base, platforms: [{ ...base.platforms[0], accountId: 'other' }] }],
    ['missing account', { ...base, platforms: [{ ...base.platforms[0], accountId: undefined }] }],
    ['wrong platform', { ...base, platforms: [{ ...base.platforms[0], platform: 'tiktok' }] }],
    ['contradicting target profile', { ...base, platforms: [{ ...base.platforms[0], profileId: 'other' }] }],
    ['inexact content', { ...base, content: `${base.content} ` }],
    ['missing content', { ...base, content: undefined }],
    ['wrong video', { ...base, mediaItems: [{ ...base.mediaItems[0], url: 'https://media.example/other.mp4' }] }],
    ['wrong cover', { ...base, mediaItems: [{ ...base.mediaItems[0], thumbnail: 'https://media.example/other.jpg' }] }],
    ['missing cover', { ...base, mediaItems: [{ url: EVIDENCE.videoUrl }] }],
    ['malformed media', { ...base, mediaItems: [null] }],
    ['missing media', { ...base, mediaItems: undefined }],
    ['extra media', { ...base, mediaItems: [...base.mediaItems, ...base.mediaItems] }],
    ['before window', { ...base, createdAt: '2026-09-24T09:59:59.999Z' }],
    ['after window', { ...base, createdAt: '2026-09-24T11:00:00.001Z' }],
    ['missing creation time', { ...base, createdAt: undefined }],
    ['invalid creation time', { ...base, createdAt: 'invalid' }],
    ['another echoed key', { ...base, requestId: 'other' }],
  ] as const) {
    it(`payload fallback rejects ${name}`, async () => {
      const h = harness(() => ({ status: 200, body: listing([candidate]) }));
      expect((await remoteReconcileLookup(h.client, { evidence: EVIDENCE })('key-1', h.ctx)).verdict).toBe('inconclusive');
    });
  }

  for (const evidence of [
    { ...EVIDENCE, createdAfter: 'invalid' },
    { ...EVIDENCE, createdBefore: '2026-09-24T09:00:00.000Z' },
    { ...EVIDENCE, coverUrl: '' },
  ]) {
    it('invalid evidence windows/fields cannot initiate a listing', async () => {
      const h = harness(() => { throw new Error('must not request'); });
      expect((await remoteReconcileLookup(h.client, { evidence })('key-1', h.ctx)).verdict).toBe('inconclusive');
      expect(h.calls).toHaveLength(0);
    });
  }

  it('uses exact stored remote identity via GET, not a listing', async () => {
    const h = harness(() => ({ status: 200, body: { post: post('remote/id', 'pending') } }));
    expect(await remoteReconcileLookup(h.client, { remoteId: 'remote/id', target: EVIDENCE })('key-1', h.ctx))
      .toMatchObject({ verdict: 'found', remoteId: 'remote/id', outcome: 'accepted', evidenceSource: 'remote-id' });
    expect(h.calls).toEqual([{ method: 'GET', path: '/posts/remote%2Fid' }]);
  });

  for (const [name, response] of [
    ['wrong remote id', { status: 200, body: { post: post('wrong') } }],
    ['malformed detail', { status: 200, body: { ok: true } }],
    ['404', { status: 404, body: { error: 'not found' } }],
    ['server error', { status: 500, body: {} }],
  ] as const) {
    it(`${name} does not prove remote-id absence or publication`, async () => {
      const h = harness(() => response);
      expect((await remoteReconcileLookup(h.client, { remoteId: 'stored' })('key-1', h.ctx)).verdict).toBe('inconclusive');
    });
  }

  it('transport failure remains inconclusive', async () => {
    const h = harness(() => { throw new Error('offline'); });
    expect((await remoteReconcileLookup(h.client)('key-1', h.ctx)).verdict).toBe('inconclusive');
  });
});

describe('statusByKey is conservative and read-only', () => {
  for (const [name, platforms, outcome] of [
    ['pending', [{ platform: 'instagram', status: 'pending', platformPostUrl: 'must-not-leak' }], 'accepted'],
    ['all published', [{ platform: 'instagram', status: 'published' }, { platform: 'tiktok', status: 'published' }], 'published'],
    ['mixed published/pending', [{ platform: 'instagram', status: 'published', platformPostUrl: 'other-target' }, { platform: 'tiktok', status: 'pending' }], 'accepted'],
    ['mixed published/failed', [{ platform: 'instagram', status: 'published' }, { platform: 'tiktok', status: 'failed' }], 'accepted'],
    ['missing status', [{ platform: 'instagram', platformPostUrl: 'not-proof' }], 'uncertain'],
    ['no target states', [], 'uncertain'],
    ['unknown status', [{ platform: 'instagram', status: 'custom' }], 'uncertain'],
    ['all failed', [{ platform: 'instagram', status: 'failed' }], 'failed'],
  ] as const) {
    it(`${name} reports ${outcome} without writes or another target URL`, async () => {
      const h = harness(() => ({ status: 200, body: { ...post('stored'), status: 'published', platforms } }));
      const journal = await journalOf('accepted', 'stored');
      const before = await journal.readAll();
      const result = await statusByKey(h.client, journal, 'key-1', h.ctx);
      expect(result.outcome).toBe(outcome);
      expect(result.url).toBeUndefined();
      expect(await journal.readAll()).toEqual(before);
      expect(h.calls).toEqual([{ method: 'GET', path: '/posts/stored' }]);
    });
  }

  it('exact target status does not borrow a different account URL', async () => {
    const h = harness(() => ({ status: 200, body: { ...post('stored'), platforms: [
      { platform: 'instagram', accountId: 'other', status: 'published', platformPostUrl: 'wrong-url' },
      { platform: 'instagram', accountId: EVIDENCE.accountId, status: 'pending' },
    ] } }));
    const journal = await journalOf('accepted', 'stored');
    const result = await statusByKey(h.client, journal, 'key-1', h.ctx, { target: EVIDENCE });
    expect(result.outcome).toBe('accepted');
    expect(result.url).toBeUndefined();
    expect(await journal.readAll()).toHaveLength(1);
  });

  for (const state of ['published', 'pending', 'failed']) {
    for (const identity of [
      { name: 'missing account', profileId: EVIDENCE.profileId, accountId: undefined },
      { name: 'missing profile', profileId: undefined, accountId: EVIDENCE.accountId },
      { name: 'wrong account', profileId: EVIDENCE.profileId, accountId: 'wrong' },
      { name: 'wrong profile', profileId: 'wrong', accountId: EVIDENCE.accountId },
      { name: 'malformed post profile', profileId: {}, accountId: EVIDENCE.accountId, targetProfileId: EVIDENCE.profileId },
      { name: 'null post profile', profileId: null, accountId: EVIDENCE.accountId, targetProfileId: EVIDENCE.profileId },
      { name: 'contradicting target profile', profileId: EVIDENCE.profileId, accountId: EVIDENCE.accountId, targetProfileId: 'wrong' },
      { name: 'malformed account', profileId: EVIDENCE.profileId, accountId: {} },
      { name: 'null account', profileId: EVIDENCE.profileId, accountId: null },
      { name: 'malformed target profile', profileId: EVIDENCE.profileId, accountId: EVIDENCE.accountId, targetProfileId: {} },
      { name: 'null target profile', profileId: EVIDENCE.profileId, accountId: EVIDENCE.accountId, targetProfileId: null },
    ]) {
      it(`${state} with ${identity.name} cannot complete status or reconciliation`, async () => {
        const h = harness(() => ({ status: 200, body: { post: {
          ...post('stored', state), profileId: identity.profileId,
          platforms: [{ platform: EVIDENCE.platform, accountId: identity.accountId,
            profileId: 'targetProfileId' in identity ? identity.targetProfileId : undefined,
            status: state, platformPostUrl: 'https://unproven.example/post' }],
        } } }));
        const journal = await journalOf('uncertain', 'stored');
        const before = await journal.readAll();
        const status = await statusByKey(h.client, journal, 'key-1', h.ctx, { target: EVIDENCE });
        expect(status).toMatchObject({
          outcome: 'uncertain', remoteId: 'stored',
        });
        expect(status.url).toBeUndefined();
        const reconciled = await reconcileByKey(h.client, journal, 'key-1', h.ctx, { target: EVIDENCE });
        expect(reconciled).toMatchObject({
          outcome: 'uncertain', remoteId: 'stored',
        });
        expect(reconciled.url).toBeUndefined();
        expect(await journal.readAll()).toEqual(before);
        expect(h.calls).toEqual([
          { method: 'GET', path: '/posts/stored' },
          { method: 'GET', path: '/posts/stored' },
        ]);
      });
    }
  }

  for (const [state, outcome] of [['published', 'published'], ['pending', 'accepted'], ['failed', 'failed']] as const) {
    it(`${state} accepts post-level profile proof without duplicating it on the target`, async () => {
      const h = harness(() => ({ status: 200, body: { post: post('stored', state) } }));
      const journal = await journalOf('uncertain', 'stored');
      expect(await reconcileByKey(h.client, journal, 'key-1', h.ctx, { target: EVIDENCE })).toMatchObject({
        outcome, remoteId: 'stored',
      });
      expect((await journal.readAll()).map((entry) => entry.outcome)).toEqual(['uncertain', outcome]);
      expect(h.calls).toEqual([{ method: 'GET', path: '/posts/stored' }]);
    });
  }

  it('404 is uncertainty, never a definitive failure or a journal mutation', async () => {
    const h = harness(() => ({ status: 404, body: {} }));
    const journal = await journalOf('accepted', 'stored');
    expect((await statusByKey(h.client, journal, 'key-1', h.ctx)).outcome).toBe('uncertain');
    expect(await journal.readAll()).toHaveLength(1);
  });

  it('wrong returned id never changes the stored identity', async () => {
    const h = harness(() => ({ status: 200, body: post('wrong') }));
    const journal = await journalOf('accepted', 'stored');
    expect(await statusByKey(h.client, journal, 'key-1', h.ctx)).toMatchObject({ outcome: 'uncertain', remoteId: 'stored' });
    expect(await journal.readAll()).toHaveLength(1);
  });

  it('offline failed records and unknown keys use no requests in plan mode', async () => {
    const h = harness(() => { throw new Error('no requests'); }, 'plan');
    const journal = await journalOf('failed');
    expect((await statusByKey(h.client, journal, 'key-1', h.ctx)).outcome).toBe('failed');
    expect((await statusByKey(h.client, journal, 'unknown', h.ctx)).outcome).toBe('failed');
    expect(h.calls).toHaveLength(0);
  });
});

describe('explicit reconcile appends proof, never POSTs', () => {
  it('accepted pending remains accepted until a GET proves publication on the same attempt', async () => {
    let published = false;
    const h = harness(() => ({ status: 200, body: post('stored', published ? 'published' : 'pending') }));
    const journal = await journalOf('accepted', 'stored');
    expect((await reconcileByKey(h.client, journal, 'key-1', h.ctx)).outcome).toBe('accepted');
    published = true;
    const result = await reconcileByKey(h.client, journal, 'key-1', h.ctx);
    expect(result).toMatchObject({ outcome: 'published', remoteId: 'stored', url: 'https://social.example/stored' });
    expect((await journal.readAll()).map((entry) => [entry.attempt, entry.outcome])).toEqual([
      [1, 'accepted'], [1, 'accepted'], [1, 'published'],
    ]);
    expect(h.calls).toEqual([{ method: 'GET', path: '/posts/stored' }, { method: 'GET', path: '/posts/stored' }]);
  });

  it('explicit matching remote-id evidence repairs a historical false failure without resubmitting', async () => {
    const h = harness(() => ({ status: 200, body: post('stored') }));
    const journal = await journalOf('failed', 'stored');
    expect((await reconcileByKey(h.client, journal, 'key-1', h.ctx)).outcome).toBe('published');
    expect((await journal.readAll()).map((entry) => entry.outcome)).toEqual(['failed', 'published']);
    expect(h.calls).toEqual([{ method: 'GET', path: '/posts/stored' }]);
  });

  it('false failure may be repaired to accepted, not mislabeled published', async () => {
    const h = harness(() => ({ status: 200, body: post('stored', 'pending') }));
    const journal = await journalOf('failed', 'stored');
    expect((await reconcileByKey(h.client, journal, 'key-1', h.ctx)).outcome).toBe('accepted');
    expect((await journal.readAll()).map((entry) => entry.outcome)).toEqual(['failed', 'accepted']);
  });

  it('failed without remote evidence remains offline and safe', async () => {
    const h = harness(() => { throw new Error('no requests'); });
    const journal = await journalOf('failed');
    expect((await reconcileByKey(h.client, journal, 'key-1', h.ctx)).outcome).toBe('failed');
    expect(await journal.readAll()).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
  });

  for (const finding of [
    { verdict: 'found', remoteId: 'stored' },
    { verdict: 'found', remoteId: 'stored', outcome: 'uncertain' },
    { verdict: 'found', remoteId: 'wrong', outcome: 'published' },
    { verdict: 'found', outcome: 'published' },
  ] satisfies ReconcileFinding[]) {
    it('found without explicit matching outcome does not clear uncertainty', async () => {
      const h = harness(() => { throw new Error('no transport'); });
      const journal = await journalOf('uncertain', 'stored');
      expect((await reconcileByKey(h.client, journal, 'key-1', h.ctx, { reconcileLookup: async () => finding })).outcome).toBe('uncertain');
      expect(await journal.readAll()).toHaveLength(1);
      expect(h.calls).toHaveLength(0);
    });
  }

  it('empty default listing never authorizes retry by appending failed', async () => {
    const h = harness(() => ({ status: 200, body: listing([]) }));
    const journal = await journalOf();
    expect((await reconcileByKey(h.client, journal, 'key-1', h.ctx)).outcome).toBe('uncertain');
    expect(await journal.readAll()).toHaveLength(1);
    expect(h.calls.every((call) => call.method === 'GET')).toBe(true);
  });

  for (const finding of [
    { verdict: 'absent' },
    { verdict: 'absent', evidenceSource: 'payload' },
    { verdict: 'absent', evidenceSource: 'echoed-key' },
  ] satisfies ReconcileFinding[]) {
    it(`injected absence with ${finding.evidenceSource ?? 'missing'} source preserves uncertainty and journal bytes`, async () => {
      const h = harness(() => { throw new Error('no transport'); });
      const journal = await journalOf();
      const before = await journal.readAll();
      const serializedBefore = JSON.stringify(before);
      const result = await reconcileByKey(h.client, journal, 'key-1', h.ctx, {
        reconcileLookup: async () => finding,
      });
      expect(result.outcome).toBe('uncertain');
      expect(await journal.readAll()).toEqual(before);
      expect(JSON.stringify(await journal.readAll())).toBe(serializedBefore);
      expect(h.calls).toHaveLength(0);
    });
  }

  it('only explicit injected authoritative absence retains the old failed transition', async () => {
    const h = harness(() => { throw new Error('no transport'); });
    const journal = await journalOf();
    const result = await reconcileByKey(h.client, journal, 'key-1', h.ctx, {
      reconcileLookup: async () => ({ verdict: 'absent', evidenceSource: 'authoritative' }),
    });
    expect(result.outcome).toBe('failed');
    expect((await journal.readAll()).map((entry) => [entry.attempt, entry.outcome])).toEqual([[1, 'uncertain'], [1, 'failed']]);
    expect(h.calls).toHaveLength(0);
  });

  it('unknown target states remain uncertain and append no proof', async () => {
    const h = harness(() => ({ status: 200, body: post('stored', 'unknown') }));
    const journal = await journalOf('uncertain', 'stored');
    expect((await reconcileByKey(h.client, journal, 'key-1', h.ctx)).outcome).toBe('uncertain');
    expect(await journal.readAll()).toHaveLength(1);
  });

  it('404 does not erase definite failure or append fabricated absence', async () => {
    const h = harness(() => ({ status: 404, body: {} }));
    const journal = await journalOf('failed', 'stored');
    expect((await reconcileByKey(h.client, journal, 'key-1', h.ctx)).outcome).toBe('failed');
    expect(await journal.readAll()).toHaveLength(1);
  });

  it('an injected lookup failure cannot write a transition', async () => {
    const h = harness(() => { throw new Error('no transport'); });
    const journal = await journalOf('uncertain', 'stored');
    expect((await reconcileByKey(h.client, journal, 'key-1', h.ctx, {
      reconcileLookup: async () => { throw new Error('lookup unavailable'); },
    })).outcome).toBe('uncertain');
    expect(await journal.readAll()).toHaveLength(1);
    expect(h.calls).toHaveLength(0);
  });

  it('dry-run blocks lookup/status/reconcile with zero requests and zero writes', async () => {
    const h = harness(() => { throw new Error('must not request'); }, 'plan');
    const journal = await journalOf('accepted', 'stored');
    let injectedCalls = 0;
    await expect(remoteReconcileLookup(h.client)('key-1', h.ctx)).rejects.toThrow('plan');
    await expect(statusByKey(h.client, journal, 'key-1', h.ctx)).rejects.toThrow('plan');
    await expect(reconcileByKey(h.client, journal, 'key-1', h.ctx, {
      reconcileLookup: async () => { injectedCalls += 1; return { verdict: 'found', remoteId: 'stored', outcome: 'published' }; },
    })).rejects.toThrow('plan');
    expect(injectedCalls).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect(await journal.readAll()).toHaveLength(1);
  });
});
