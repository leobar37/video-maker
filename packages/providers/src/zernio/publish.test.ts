/**
 * Zernio publisher: 409 dedupe ⇒ accepted (zero double-post), missing receipt
 * ⇒ uncertain with blocked retry, journal-driven replay and the reconcile-only
 * exit from uncertainty. All transports are fakes: no network in tests.
 */
import { describe, expect, it } from 'bun:test';

import type { ProviderContext, SocialPost } from '../ports';
import { ZernioClient } from './client';
import { InMemoryPublicationJournal, attemptsUsed, latestByKey } from './journal';
import {
  AttemptsExhaustedError,
  PostValidationError,
  validateSocialPost,
  ZernioPublisher,
} from './publish';
import { extractCreatedPost, extractListedPosts, targetReceiptOf } from './post-response';
import type { ReconcileFinding, ReconcileLookup } from './status';

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Header capture (names normalized lowercase, like the Headers iterator). */
function collectHeaders(init?: HeadersInit): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init).forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

type Handler = (call: Recorded) => { status: number; body: unknown } | never;

interface FakeTransport {
  fetchImpl: typeof fetch;
  calls: Recorded[];
  posts: Recorded[];
}

/** API path tail: `https://host/api/v1/accounts` → `/accounts`. */
function tail(url: string): string {
  return new URL(url).pathname.replace(/^.*\/api\/v1/, '');
}

function fakeTransport(handler: Handler): FakeTransport {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Recorded = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: collectHeaders(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const result = handler(call);
    return new Response(JSON.stringify(result.body), { status: result.status });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls,
    get posts(): Recorded[] {
      return calls.filter((c) => c.method === 'POST' && tail(c.url) === '/posts');
    },
  };
}

function ctxOf(
  mode: 'plan' | 'run',
  fetchImpl: typeof fetch,
): { ctx: ProviderContext; secretReads: string[] } {
  const secretReads: string[] = [];
  return {
    secretReads,
    ctx: {
      mode,
      secrets: {
        getSecret: async (name: string) => {
          secretReads.push(name);
          throw new Error('secrets must not be read');
        },
      },
      fetchImpl,
      clock: { now: () => new Date('2026-09-24T12:00:00.000Z') },
    },
  };
}

const ACCOUNTS = {
  accounts: [{ _id: 'acc-1', platform: 'instagram', username: 'brand' }],
};
const HEALTH = { accounts: [{ accountId: 'acc-1', canPost: true, status: 'ok' }] };

/** Default router: accounts/health + one programmable POST /posts answer. */
function router(post: { status: number; body: unknown }): Handler {
  return (call) => {
    const path = tail(call.url);
    if (path === '/accounts/health') return { status: 200, body: HEALTH };
    if (path === '/accounts') return { status: 200, body: ACCOUNTS };
    if (path === '/posts' && call.method === 'POST') return post;
    throw new Error(`unexpected call ${call.method} ${call.url}`);
  };
}

const SOCIAL_POST: SocialPost = {
  idempotencyKey: 'idem-1',
  account: 'instagram:@brand',
  text: 'hello world',
  media: ['https://cdn.example.com/marketing/a.mp4'],
};

const PROFILE_POST: SocialPost = {
  ...SOCIAL_POST,
  account: 'acc-1',
  profileId: 'profile-1',
};

function publisherOf(
  transport: FakeTransport,
  opts: { maxAttempts?: number; reconcileLookup?: ReconcileLookup } = {},
): { publisher: ZernioPublisher; journal: InMemoryPublicationJournal } {
  const journal = new InMemoryPublicationJournal();
  const client = new ZernioClient({ apiKey: 'test-key', fetchImpl: transport.fetchImpl });
  const publisher = new ZernioPublisher(client, { journal, ...opts });
  return { publisher, journal };
}

describe('ZernioPublisher.publish', () => {
  it('409 dedupe ⇒ accepted, journaled, with zero double-post', async () => {
    const transport = fakeTransport(
      router({ status: 409, body: { existingPostId: 'post-9' } }),
    );
    const { publisher, journal } = publisherOf(transport);
    const { ctx } = ctxOf('run', transport.fetchImpl);

    const outcome = await publisher.publish(SOCIAL_POST, ctx);
    expect(outcome).toMatchObject({
      outcome: 'accepted',
      idempotencyKey: 'idem-1',
      remoteId: 'post-9',
    });

    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0].headers['idempotency-key']).toBe('idem-1');
    expect(transport.posts[0].headers['x-request-id']).toBe('idem-1');
    expect(transport.posts[0].body).toMatchObject({
      content: 'hello world',
      mediaItems: [{ url: 'https://cdn.example.com/marketing/a.mp4' }],
      platforms: [{ platform: 'instagram', accountId: 'acc-1' }],
      publishNow: true,
    });

    const entries = await journal.readAll();
    expect(entries.map((e) => e.outcome)).toEqual(['accepted']);
  });

  it('a proven outcome is replayed from the journal without a second submit', async () => {
    const transport = fakeTransport(
      router({
        status: 201,
        body: {
          post: {
            _id: 'post-1',
            platforms: [{ platform: 'instagram', accountId: 'acc-1', status: 'published', platformPostUrl: 'https://social.example.com/p/1' }],
          },
        },
      }),
    );
    const { publisher } = publisherOf(transport);
    const { ctx } = ctxOf('run', transport.fetchImpl);

    const first = await publisher.publish(SOCIAL_POST, ctx);
    expect(first).toMatchObject({
      outcome: 'published',
      remoteId: 'post-1',
      url: 'https://social.example.com/p/1',
    });

    const replay = await publisher.publish(SOCIAL_POST, ctx);
    expect(replay).toMatchObject({ outcome: 'published', remoteId: 'post-1' });
    expect(transport.posts).toHaveLength(1);
  });

  it('missing receipt ⇒ uncertain, and retry is blocked until reconcile (no auto-retry)', async () => {
    const transport = fakeTransport(router({ status: 201, body: { ok: true } }));
    const { publisher, journal } = publisherOf(transport);
    const { ctx } = ctxOf('run', transport.fetchImpl);

    const outcome = await publisher.publish(SOCIAL_POST, ctx);
    expect(outcome.outcome).toBe('uncertain');
    expect(outcome.detail).toContain('no receipt');

    const blocked = await publisher.publish(SOCIAL_POST, ctx);
    expect(blocked.outcome).toBe('uncertain');
    expect(blocked.detail).toContain('blocked');
    // The blocked retry never reached the wire.
    expect(transport.posts).toHaveLength(1);
    expect(attemptsUsed(await journal.readAll(), 'idem-1')).toBe(1);
  });

  it('a transport error is uncertain: the request may have landed', async () => {
    const transport = fakeTransport((call) => {
      const path = tail(call.url);
      if (path === '/accounts/health') return { status: 200, body: HEALTH };
      if (path === '/accounts') return { status: 200, body: ACCOUNTS };
      throw new Error('connection reset');
    });
    const { publisher, journal } = publisherOf(transport);
    const { ctx } = ctxOf('run', transport.fetchImpl);

    const outcome = await publisher.publish(SOCIAL_POST, ctx);
    expect(outcome.outcome).toBe('uncertain');
    const latest = latestByKey(await journal.readAll()).get('idem-1');
    expect(latest?.outcome).toBe('uncertain');
    expect(transport.posts).toHaveLength(1);
  });

  for (const code of ['ECONNRESET', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    it(`${code} never persists secret-bearing transport diagnostics`, async () => {
      const secret = 'secret-marker-transport-credential';
      const cause = Object.assign(new Error(`${code}: ${secret}`), { code });
      const transport = fakeTransport((call) => {
        if (tail(call.url) === '/posts') throw cause;
        return router({ status: 201, body: {} })(call);
      });
      const { publisher, journal } = publisherOf(transport, { maxAttempts: 3 });
      const { ctx } = ctxOf('run', transport.fetchImpl);
      const outcome = await publisher.publish(SOCIAL_POST, ctx);
      expect(outcome.outcome).toBe('uncertain');
      expect(outcome.detail).toContain('transport error before a response');
      expect(JSON.stringify(outcome)).not.toContain(secret);
      expect(JSON.stringify(await journal.readAll())).not.toContain(secret);
      const replay = await publisher.publish(SOCIAL_POST, ctx);
      expect(replay.outcome).toBe('uncertain');
      expect(JSON.stringify(replay)).not.toContain(secret);
      expect(transport.posts).toHaveLength(1);
    });
  }

  for (const post of [SOCIAL_POST, PROFILE_POST]) {
    for (const status of [299, 300, 307, 399, 408, 409, 499, 500, 503, 599]) {
      it(`${post.profileId ? 'profile' : 'legacy'} HTTP ${status} blocks replay and retains an ID hint`, async () => {
        const transport = fakeTransport(router({
          status,
          body: {
            error: 'secret-marker-response',
            post: { _id: 'unknown-http-post', platforms: [
              { platform: 'instagram', accountId: 'acc-1', status: 'published' },
            ] },
          },
        }));
        const { publisher, journal } = publisherOf(transport, { maxAttempts: 3 });
        const { ctx } = ctxOf('run', transport.fetchImpl);
        expect(await publisher.publish(post, ctx)).toMatchObject({
          outcome: 'uncertain', remoteId: 'unknown-http-post',
        });
        expect(await publisher.publish(post, ctx)).toMatchObject({
          outcome: 'uncertain', remoteId: 'unknown-http-post',
          detail: expect.stringContaining('blocked'),
        });
        expect(JSON.stringify(await journal.readAll())).not.toContain('secret-marker-response');
        expect(attemptsUsed(await journal.readAll(), post.idempotencyKey)).toBe(1);
        expect(transport.posts).toHaveLength(1);
      });
    }

    for (const status of [400, 401, 403, 422, 429]) {
      it(`${post.profileId ? 'profile' : 'legacy'} known HTTP ${status} remains failed without automatic retry`, async () => {
        const transport = fakeTransport(router({ status, body: { error: 'secret-marker-rejection' } }));
        const { publisher, journal } = publisherOf(transport, { maxAttempts: 3 });
        const { ctx } = ctxOf('run', transport.fetchImpl);
        const outcome = await publisher.publish(post, ctx);
        expect(outcome.outcome).toBe('failed');
        expect(outcome.detail).toContain(`HTTP ${status}`);
        expect(JSON.stringify(outcome)).not.toContain('secret-marker-rejection');
        expect(JSON.stringify(await journal.readAll())).not.toContain('secret-marker-rejection');
        expect(transport.posts).toHaveLength(1);
      });
    }
  }

  for (const post of [SOCIAL_POST, PROFILE_POST]) {
    it(`${post.profileId ? 'profile' : 'legacy'} timeout retains a postId-only hint`, async () => {
      const transport = fakeTransport(router({ status: 408, body: { postId: 'timeout-post' } }));
      const { publisher } = publisherOf(transport, { maxAttempts: 3 });
      const { ctx } = ctxOf('run', transport.fetchImpl);
      expect(await publisher.publish(post, ctx)).toMatchObject({
        outcome: 'uncertain', remoteId: 'timeout-post',
      });
      expect(await publisher.publish(post, ctx)).toMatchObject({
        outcome: 'uncertain', remoteId: 'timeout-post',
      });
      expect(transport.posts).toHaveLength(1);
    });

    it(`${post.profileId ? 'profile' : 'legacy'} ordinary 4xx with an ID cannot prove nothing went out`, async () => {
      const transport = fakeTransport(router({ status: 422, body: { postId: 'ambiguous-rejection' } }));
      const { publisher } = publisherOf(transport, { maxAttempts: 3 });
      const { ctx } = ctxOf('run', transport.fetchImpl);
      expect(await publisher.publish(post, ctx)).toMatchObject({
        outcome: 'uncertain', remoteId: 'ambiguous-rejection',
      });
      expect((await publisher.publish(post, ctx)).outcome).toBe('uncertain');
      expect(transport.posts).toHaveLength(1);
    });
  }

  it('a definite HTTP rejection is failed and the explicit maxAttempts budget gates re-attempts', async () => {
    const transport = fakeTransport(router({ status: 422, body: { error: 'bad' } }));
    const { publisher } = publisherOf(transport, { maxAttempts: 1 });
    const { ctx } = ctxOf('run', transport.fetchImpl);

    const outcome = await publisher.publish(SOCIAL_POST, ctx);
    expect(outcome.outcome).toBe('failed');
    expect(outcome.detail).toContain('422');

    await expect(publisher.publish(SOCIAL_POST, ctx)).rejects.toThrow(AttemptsExhaustedError);
    expect(transport.posts).toHaveLength(1);
  });

  it('schedule sends scheduledFor + timezone instead of publishNow', async () => {
    const transport = fakeTransport(
      router({ status: 201, body: { post: { _id: 'post-2', platforms: [
        { platform: 'instagram', accountId: 'acc-1', status: 'scheduled' },
      ] } } }),
    );
    const { publisher } = publisherOf(transport);
    const { ctx } = ctxOf('run', transport.fetchImpl);

    const scheduled: SocialPost = { ...SOCIAL_POST, scheduledFor: '2026-10-01T15:00:00.000Z' };
    const outcome = await publisher.schedule(scheduled, ctx);
    expect(outcome).toMatchObject({ outcome: 'accepted', remoteId: 'post-2' });
    expect(transport.posts[0].body).toMatchObject({
      scheduledFor: '2026-10-01T15:00:00.000Z',
      timezone: 'America/Lima',
    });
    expect(transport.posts[0].body).not.toHaveProperty('publishNow');
    expect(await publisher.schedule(scheduled, ctx)).toMatchObject({
      outcome: 'accepted', remoteId: 'post-2',
    });

    // publish refuses a scheduled post and schedule requires the timestamp.
    await expect(publisher.publish(scheduled, ctx)).rejects.toThrow(PostValidationError);
    await expect(
      publisher.schedule({ ...SOCIAL_POST, scheduledFor: undefined }, ctx),
    ).rejects.toThrow(PostValidationError);
    expect(transport.posts).toHaveLength(1);
  });

  it('plan mode refuses publish/schedule with zero fetch calls and zero secret reads', async () => {
    const transport = fakeTransport(router({ status: 201, body: {} }));
    const { publisher } = publisherOf(transport);
    const { ctx, secretReads } = ctxOf('plan', transport.fetchImpl);

    await expect(publisher.publish(SOCIAL_POST, ctx)).rejects.toThrow(/plan mode/);
    await expect(publisher.schedule(SOCIAL_POST, ctx)).rejects.toThrow(/plan mode/);
    expect(transport.calls).toHaveLength(0);
    expect(secretReads).toHaveLength(0);
  });

  it('validate is pure and structural (works in plan mode)', async () => {
    const transport = fakeTransport(router({ status: 201, body: {} }));
    const { publisher } = publisherOf(transport);
    const { ctx } = ctxOf('plan', transport.fetchImpl);

    const ok = await publisher.validate(SOCIAL_POST, ctx);
    expect(ok).toEqual({ ok: true, problems: [] });

    const bad = validateSocialPost({
      idempotencyKey: ' ',
      account: '',
      text: '',
      media: ['not-a-url'],
      scheduledFor: 'mañana',
    });
    expect(bad.ok).toBe(false);
    expect(bad.problems).toHaveLength(5);
    expect(transport.calls).toHaveLength(0);
  });
});

describe('target-scoped Zernio creation receipts', () => {
  const states = [
    { status: 'published', outcome: 'published' },
    { status: 'pending', outcome: 'accepted' },
    { status: 'queued', outcome: 'accepted' },
    { status: 'processing', outcome: 'accepted' },
    { status: 'scheduled', outcome: 'accepted' },
    { status: 'publishing', outcome: 'accepted' },
    { status: 'failed', outcome: 'failed' },
  ] as const;

  for (const status of ['PUBLISHED', 'PENDING', 'FAILED', 'secret-marker-unknown-status']) {
    it(`target ${status} journals only normalized known state, not raw error metadata`, async () => {
      const secret = 'secret-marker-provider-error';
      const body = { post: {
        _id: 'safe-receipt', profileId: 'profile-1', status: 'scheduled', queueId: 'queue-1',
        queuedFromProfile: 'profile-1', errorMessage: secret,
        platforms: [{
          platform: 'instagram', accountId: 'acc-1', status,
          errorMessage: secret, errorCategory: secret, errorSource: secret,
        }],
      } };
      const parsed = extractCreatedPost(body);
      expect(parsed?.errorMessage).toBe(secret);
      expect(parsed?.queueId).toBe('queue-1');
      expect(parsed?.queuedFromProfile).toBe('profile-1');
      expect(parsed?.platforms[0]).toMatchObject({
        errorMessage: secret, errorCategory: secret, errorSource: secret,
      });
      const transport = fakeTransport(router({ status: 207, body }));
      const { publisher, journal } = publisherOf(transport, { maxAttempts: 3 });
      const { ctx } = ctxOf('run', transport.fetchImpl);
      const outcome = await publisher.publish(PROFILE_POST, ctx);
      expect(outcome).toMatchObject({
        remoteId: 'safe-receipt',
        outcome: status === 'PUBLISHED' ? 'published'
          : status === 'PENDING' ? 'accepted' : status === 'FAILED' ? 'failed' : 'uncertain',
      });
      expect(JSON.stringify(outcome)).not.toContain(secret);
      expect(JSON.stringify(outcome)).not.toContain('secret-marker-unknown-status');
      expect(JSON.stringify(await journal.readAll())).not.toContain(secret);
      expect(JSON.stringify(await journal.readAll())).not.toContain('secret-marker-unknown-status');
      if (status !== 'secret-marker-unknown-status') {
        expect(outcome.detail).toContain(`target state: ${status.toLowerCase()}`);
      }
      expect(transport.posts).toHaveLength(1);
    });
  }

  for (const httpStatus of [200, 201, 202, 207]) {
    for (const state of states) {
      it(`HTTP ${httpStatus} target ${state.status} preserves its ID as ${state.outcome}`, async () => {
        const transport = fakeTransport(router({
          status: httpStatus,
          body: { post: {
            _id: 'target-post',
            idempotencyKey: SOCIAL_POST.idempotencyKey,
            status: 'partial',
            platforms: [
              { platform: 'youtube', status: 'published', platformPostUrl: 'https://wrong.example/post' },
              {
                platform: 'instagram',
                accountId: { _id: 'acc-1' },
                profileId: 'profile-1',
                status: state.status,
                platformPostUrl: 'https://right.example/post',
                errorMessage: state.status === 'pending' ? 'queued by provider' : undefined,
              },
            ],
          } },
        }));
        const { publisher, journal } = publisherOf(transport, { maxAttempts: 3 });
        const { ctx } = ctxOf('run', transport.fetchImpl);
        const result = await publisher.publish(PROFILE_POST, ctx);
        expect(result).toMatchObject({ outcome: state.outcome, remoteId: 'target-post' });
        expect(result.url).toBe(state.outcome === 'published' ? 'https://right.example/post' : undefined);
        expect((await journal.readAll())[0]).toMatchObject({
          outcome: state.outcome, remoteId: 'target-post', attempt: 1,
        });
        if (state.outcome !== 'failed') {
          expect(await publisher.publish(PROFILE_POST, ctx)).toMatchObject({
            outcome: state.outcome, remoteId: 'target-post',
          });
          expect(transport.posts).toHaveLength(1);
        }
        expect(transport.posts[0]?.headers['idempotency-key']).toBe(SOCIAL_POST.idempotencyKey);
      });
    }

    for (const fixture of [
      { name: 'unknown status', platforms: [{ platform: 'instagram', accountId: 'acc-1', status: 'mystery' }] },
      { name: 'missing status', platforms: [{ platform: 'instagram', accountId: 'acc-1' }] },
      { name: 'absent target', platforms: [{ platform: 'youtube', status: 'published' }] },
      { name: 'missing platforms', platforms: [] },
      { name: 'wrong account', platforms: [{ platform: 'instagram', accountId: 'another-account', status: 'published' }] },
      { name: 'malformed account', platforms: [{ platform: 'instagram', accountId: { username: 'brand' }, status: 'published' }] },
      { name: 'wrong profile', platforms: [{ platform: 'instagram', accountId: 'acc-1', profileId: 'other-profile', status: 'published' }] },
      { name: 'ambiguous target', platforms: [
        { platform: 'instagram', accountId: 'acc-1', status: 'published' },
        { platform: 'instagram', accountId: 'acc-1', status: 'pending' },
      ] },
    ]) {
      it(`HTTP ${httpStatus} ${fixture.name} remains uncertain and cannot resubmit`, async () => {
        const transport = fakeTransport(router({
          status: httpStatus,
          body: { post: { _id: 'uncertain-post', platforms: fixture.platforms } },
        }));
        const { publisher } = publisherOf(transport, { maxAttempts: 3 });
        const { ctx } = ctxOf('run', transport.fetchImpl);
        const result = await publisher.publish(PROFILE_POST, ctx);
        expect(result).toMatchObject({ outcome: 'uncertain', remoteId: 'uncertain-post' });
        expect(result.url).toBeUndefined();
        expect((await publisher.publish(PROFILE_POST, ctx)).outcome).toBe('uncertain');
        expect(transport.posts).toHaveLength(1);
      });
    }

    it(`HTTP ${httpStatus} without a receipt stays uncertain even with a larger attempt budget`, async () => {
      const transport = fakeTransport(router({ status: httpStatus, body: { ok: true } }));
      const { publisher } = publisherOf(transport, { maxAttempts: 3 });
      const { ctx } = ctxOf('run', transport.fetchImpl);
      expect((await publisher.publish(PROFILE_POST, ctx)).outcome).toBe('uncertain');
      expect((await publisher.publish(PROFILE_POST, ctx)).outcome).toBe('uncertain');
      expect(transport.posts).toHaveLength(1);
    });
  }

  for (const httpStatus of [201, 202, 207]) {
    for (const state of ['published', 'pending', 'failed']) {
      for (const identity of [
        { name: 'missing account', profileId: 'profile-1', accountId: undefined },
        { name: 'missing profile', profileId: undefined, accountId: 'acc-1' },
        { name: 'wrong account', profileId: 'profile-1', accountId: 'wrong' },
        { name: 'wrong profile', profileId: 'wrong', accountId: 'acc-1' },
        { name: 'malformed post profile', profileId: { username: 'brand' }, accountId: 'acc-1', targetProfileId: 'profile-1' },
        { name: 'null post profile', profileId: null, accountId: 'acc-1', targetProfileId: 'profile-1' },
        { name: 'contradicting target profile', profileId: 'profile-1', accountId: 'acc-1', targetProfileId: 'wrong' },
        { name: 'malformed account', profileId: 'profile-1', accountId: {} },
        { name: 'null account', profileId: 'profile-1', accountId: null },
        { name: 'malformed target profile', profileId: 'profile-1', accountId: 'acc-1', targetProfileId: {} },
        { name: 'null target profile', profileId: 'profile-1', accountId: 'acc-1', targetProfileId: null },
      ]) {
        it(`HTTP ${httpStatus} ${state} with ${identity.name} preserves uncertainty in journal and replay`, async () => {
          const transport = fakeTransport(router({
            status: httpStatus,
            body: { post: {
              _id: 'unproven-identity', profileId: identity.profileId,
              platforms: [{ platform: 'instagram', accountId: identity.accountId,
                profileId: 'targetProfileId' in identity ? identity.targetProfileId : undefined,
                status: state, platformPostUrl: 'https://unproven.example/post' }],
            } },
          }));
          const { publisher, journal } = publisherOf(transport, { maxAttempts: 3 });
          const { ctx } = ctxOf('run', transport.fetchImpl);
          const result = await publisher.publish(PROFILE_POST, ctx);
          expect(result).toMatchObject({
            outcome: 'uncertain', remoteId: 'unproven-identity',
          });
          expect(result.url).toBeUndefined();
          expect((await journal.readAll()).map((entry) => entry.outcome)).toEqual(['uncertain']);
          const callsBeforeReplay = transport.calls.length;
          const replay = await publisher.publish(PROFILE_POST, ctx);
          expect(replay).toMatchObject({
            outcome: 'uncertain', remoteId: 'unproven-identity',
          });
          expect(replay.url).toBeUndefined();
          expect(transport.calls.slice(callsBeforeReplay).filter((call) => call.method === 'POST')).toHaveLength(0);
          expect(transport.posts).toHaveLength(1);
        });
      }
    }

    for (const state of states) {
      it(`HTTP ${httpStatus} ${state.status} accepts exact account and post-level profile proof`, async () => {
        const transport = fakeTransport(router({
          status: httpStatus,
          body: { post: { _id: 'post-profile-proof', profileId: { _id: 'profile-1' },
            platforms: [{ platform: 'instagram', accountId: 'acc-1', status: state.status }] } },
        }));
        const { publisher } = publisherOf(transport);
        const { ctx } = ctxOf('run', transport.fetchImpl);
        expect(await publisher.publish(PROFILE_POST, ctx)).toMatchObject({
          outcome: state.outcome, remoteId: 'post-profile-proof',
        });
      });
    }
  }

  for (const httpStatus of [200, 201, 202, 207]) {
    for (const fixture of [
      { name: 'status-less target', body: { post: { _id: 'legacy-unproven', platforms: [
        { platform: 'instagram', platformPostUrl: 'https://social.example.com/unproven' },
      ] } } },
      { name: 'unknown target status', body: { post: { _id: 'legacy-unproven', platforms: [
        { platform: 'instagram', accountId: 'acc-1', status: 'mystery' },
      ] } } },
      { name: 'empty platforms', body: { post: { _id: 'legacy-unproven', platforms: [] } } },
      { name: 'ID-only post', body: { post: { _id: 'legacy-unproven' } } },
      { name: 'postId-only receipt', body: { postId: 'legacy-unproven' } },
    ]) {
      it(`legacy HTTP ${httpStatus} ${fixture.name} is uncertain and blocks replay`, async () => {
        const transport = fakeTransport(router({ status: httpStatus, body: fixture.body }));
        const { publisher, journal } = publisherOf(transport, { maxAttempts: 3 });
        const { ctx } = ctxOf('run', transport.fetchImpl);
        expect(await publisher.publish(SOCIAL_POST, ctx)).toMatchObject({
          outcome: 'uncertain', remoteId: 'legacy-unproven',
        });
        expect(await publisher.publish(SOCIAL_POST, ctx)).toMatchObject({
          outcome: 'uncertain', remoteId: 'legacy-unproven',
          detail: expect.stringContaining('blocked'),
        });
        expect((await journal.readAll())[0]).toMatchObject({
          outcome: 'uncertain', remoteId: 'legacy-unproven', attempt: 1,
        });
        expect(transport.posts).toHaveLength(1);
        expect(attemptsUsed(await journal.readAll(), SOCIAL_POST.idempotencyKey)).toBe(1);
      });
    }
  }

  for (const status of ['pending', 'scheduled', undefined, 'mystery']) {
    it(`legacy schedule target ${status ?? 'missing status'} requires state evidence`, async () => {
      const transport = fakeTransport(router({
        status: 201,
        body: { post: { _id: 'scheduled-receipt', status: 'scheduled', platforms: [
          { platform: 'instagram', accountId: 'acc-1', status },
        ] } },
      }));
      const { publisher } = publisherOf(transport, { maxAttempts: 3 });
      const { ctx } = ctxOf('run', transport.fetchImpl);
      const post = { ...SOCIAL_POST, scheduledFor: '2026-10-01T15:00:00.000Z' };
      const expected = status === 'pending' || status === 'scheduled' ? 'accepted' : 'uncertain';
      expect(await publisher.schedule(post, ctx)).toMatchObject({
        outcome: expected, remoteId: 'scheduled-receipt',
      });
      expect(await publisher.schedule(post, ctx)).toMatchObject({
        outcome: expected, remoteId: 'scheduled-receipt',
      });
      expect(transport.posts).toHaveLength(1);
    });
  }

  it('HTTP 202 in-flight postId is retained as a hint, never publication proof', async () => {
    const transport = fakeTransport(router({ status: 202, body: { postId: 'saving-post' } }));
    const { publisher } = publisherOf(transport, { maxAttempts: 3 });
    const { ctx } = ctxOf('run', transport.fetchImpl);
    expect(await publisher.publish(PROFILE_POST, ctx)).toMatchObject({
      outcome: 'uncertain', remoteId: 'saving-post',
    });
    expect((await publisher.publish(PROFILE_POST, ctx)).outcome).toBe('uncertain');
    expect(transport.posts).toHaveLength(1);
  });

  it('HTTP 207 scheduled post with pending target remains accepted despite error text', async () => {
    const transport = fakeTransport(router({
      status: 207,
      body: {
        error: 'Daily limit reached; automatic publishing later',
        post: {
          _id: 'queued-post', profileId: 'profile-1', status: 'scheduled',
          platforms: [{ platform: 'instagram', accountId: 'acc-1', status: 'pending' }],
        },
        platformResults: [{ platform: 'instagram', status: 'failed', error: 'transient quota' }],
      },
    }));
    const { publisher } = publisherOf(transport);
    const { ctx } = ctxOf('run', transport.fetchImpl);
    expect(await publisher.publish(PROFILE_POST, ctx)).toMatchObject({
      outcome: 'accepted', remoteId: 'queued-post',
    });
  });

  it('legacy 207 also classifies queued target evidence, never blanket success', async () => {
    const transport = fakeTransport(router({
      status: 207,
      body: { post: { _id: 'legacy-queued', platforms: [
        { platform: 'youtube', status: 'published', platformPostUrl: 'https://wrong.example/post' },
        { platform: 'instagram', accountId: 'acc-1', status: 'pending' },
      ] } },
    }));
    const { publisher } = publisherOf(transport);
    const { ctx } = ctxOf('run', transport.fetchImpl);
    expect(await publisher.publish(SOCIAL_POST, ctx)).toMatchObject({
      outcome: 'accepted', remoteId: 'legacy-queued',
    });
    expect((await publisher.publish(SOCIAL_POST, ctx)).url).toBeUndefined();
    expect(transport.posts).toHaveLength(1);
  });

  it('undocumented HTTP 206 is uncertain even with a published-looking body', async () => {
    const transport = fakeTransport(router({
      status: 206,
      body: { post: { _id: 'unrecognized-post', platforms: [
        { platform: 'instagram', accountId: 'acc-1', status: 'published' },
      ] } },
    }));
    const { publisher } = publisherOf(transport, { maxAttempts: 3 });
    const { ctx } = ctxOf('run', transport.fetchImpl);
    expect(await publisher.publish(PROFILE_POST, ctx)).toMatchObject({
      outcome: 'uncertain', remoteId: 'unrecognized-post',
    });
    expect((await publisher.publish(PROFILE_POST, ctx)).outcome).toBe('uncertain');
    expect(transport.posts).toHaveLength(1);
  });

  it('HTTP 409 idempotency_conflict cannot unlock a second POST', async () => {
    const transport = fakeTransport(router({
      status: 409, body: { code: 'idempotency_conflict', error: 'still processing' },
    }));
    const { publisher } = publisherOf(transport, { maxAttempts: 3 });
    const { ctx } = ctxOf('run', transport.fetchImpl);
    expect((await publisher.publish(PROFILE_POST, ctx)).outcome).toBe('uncertain');
    expect((await publisher.publish(PROFILE_POST, ctx)).outcome).toBe('uncertain');
    expect(transport.posts).toHaveLength(1);
  });

  it('HTTP 409 dedupe is accepted and replays without a second POST', async () => {
    const transport = fakeTransport(router({ status: 409, body: { existingPostId: 'deduped' } }));
    const { publisher } = publisherOf(transport, { maxAttempts: 3 });
    const { ctx } = ctxOf('run', transport.fetchImpl);
    expect(await publisher.publish(PROFILE_POST, ctx)).toMatchObject({
      outcome: 'accepted', remoteId: 'deduped',
    });
    expect((await publisher.publish(PROFILE_POST, ctx)).outcome).toBe('accepted');
    expect(transport.posts).toHaveLength(1);
  });

  it('HTTP 207 queued TikTok retains its remote ID and blocks duplicate POSTs', async () => {
    const transport = fakeTransport((call) => {
      const path = tail(call.url);
      if (path === '/accounts') return {
        status: 200, body: { accounts: [{ _id: 'tiktok-acc', platform: 'tiktok' }] },
      };
      if (path === '/accounts/health') return {
        status: 200, body: { accounts: [{ accountId: 'tiktok-acc', canPost: true, status: 'ok' }] },
      };
      if (path === '/posts' && call.method === 'POST') return {
        status: 207,
        body: { post: { _id: 'tiktok-queued', profileId: 'profile-1', status: 'scheduled', platforms: [
          { platform: 'youtube', status: 'published', platformPostUrl: 'https://wrong.example/post' },
          {
            platform: 'tiktok', accountId: 'tiktok-acc', status: 'pending',
            errorMessage: 'provider queue: daily Business API limit reached',
          },
        ] } },
      };
      throw new Error(`unexpected call ${call.method} ${call.url}`);
    });
    const { publisher, journal } = publisherOf(transport, { maxAttempts: 3 });
    const { ctx } = ctxOf('run', transport.fetchImpl);
    const post = { ...PROFILE_POST, account: 'tiktok-acc' };
    expect(await publisher.publish(post, ctx)).toMatchObject({
      outcome: 'accepted', remoteId: 'tiktok-queued',
    });
    expect((await publisher.publish(post, ctx)).url).toBeUndefined();
    expect(transport.posts).toHaveLength(1);
    expect(attemptsUsed(await journal.readAll(), post.idempotencyKey)).toBe(1);
  });

  for (const httpStatus of [500, 503]) {
    it(`profile HTTP ${httpStatus} stays uncertain and cannot resubmit`, async () => {
      const transport = fakeTransport(router({ status: httpStatus, body: { error: 'server failure' } }));
      const { publisher } = publisherOf(transport, { maxAttempts: 3 });
      const { ctx } = ctxOf('run', transport.fetchImpl);
      expect((await publisher.publish(PROFILE_POST, ctx)).outcome).toBe('uncertain');
      expect((await publisher.publish(PROFILE_POST, ctx)).outcome).toBe('uncertain');
      expect(transport.posts).toHaveLength(1);
    });
  }
});

describe('post response correlation helpers', () => {
  it('retains guarded correlation, populated identities, media, queue and error hints', () => {
    const post = extractCreatedPost({ data: { post: {
      _id: 'post-id', idempotencyKey: 'exact-key', requestId: 'request-id',
      profileId: { _id: 'profile-1' }, content: 'exact caption',
      createdAt: '2026-10-01T10:00:00.000Z',
      scheduledFor: '2026-10-02T10:00:00.000Z',
      queuedFromProfile: 'profile-1', queueId: 'queue-1', timezone: 'UTC',
      mediaItems: [{ url: 'https://cdn.example/video.mp4', type: 'video', thumbnail: 'https://cdn.example/cover.jpg' }],
      platforms: [{
        platform: 'instagram', accountId: { _id: 'acc-1' }, profileId: { _id: 'profile-1' },
        status: 'pending', errorMessage: 'provider queue hint',
        errorCategory: 'rate_limit', errorSource: 'platform',
      }],
    } } });
    expect(post).toMatchObject({
      id: 'post-id', idempotencyKey: 'exact-key', requestId: 'request-id',
      profileId: 'profile-1', content: 'exact caption',
      queuedFromProfile: 'profile-1', queueId: 'queue-1', timezone: 'UTC',
      mediaItems: [{ url: 'https://cdn.example/video.mp4', thumbnail: 'https://cdn.example/cover.jpg' }],
      platforms: [{ accountId: 'acc-1', profileId: 'profile-1', errorMessage: 'provider queue hint' }],
    });
    expect(extractCreatedPost({ _id: 99 })).toBeNull();
    expect(extractCreatedPost({ _id: 'bad-media', mediaItems: [{ url: 42 }] })?.mediaItems).toBeUndefined();
  });

  it('returns every list member, distinguishing empty lists from malformed evidence', () => {
    expect(extractListedPosts({ posts: [
      { _id: 'wrong-first', idempotencyKey: 'another-key' },
      { _id: 'exact-second', idempotencyKey: 'exact-key' },
    ] })?.map((post) => [post.id, post.idempotencyKey])).toEqual([
      ['wrong-first', 'another-key'], ['exact-second', 'exact-key'],
    ]);
    expect(extractListedPosts({ data: { posts: [] } })).toEqual([]);
    expect(extractListedPosts({ posts: [{ _id: 'valid' }, { noId: true }] })).toBeNull();
    expect(extractListedPosts({ posts: 'malformed' })).toBeNull();
  });

  it('chooses the exact account, not the first same-platform entry', () => {
    const post = extractCreatedPost({ _id: 'multi-account', platforms: [
      { platform: 'instagram', accountId: 'wrong-account', status: 'published', platformPostUrl: 'https://wrong.example/post' },
      { platform: 'instagram', accountId: 'acc-1', status: 'published', platformPostUrl: 'https://right.example/post' },
    ] });
    if (!post) throw new Error('fixture must parse');
    expect(targetReceiptOf(post, { platform: 'instagram', accountId: 'acc-1' })).toMatchObject({
      outcome: 'published', url: 'https://right.example/post',
    });
    expect(targetReceiptOf(post, { platform: 'instagram' }).outcome).toBe('uncertain');
    const platformOnly = extractCreatedPost({ _id: 'platform-only', platforms: [
      { platform: 'instagram', status: 'published' },
    ] });
    if (!platformOnly) throw new Error('fixture must parse');
    expect(targetReceiptOf(platformOnly, { platform: 'instagram' }).outcome).toBe('published');
    expect(targetReceiptOf(platformOnly, { platform: 'instagram', accountId: 'acc-1' })).toMatchObject({
      outcome: 'uncertain', remoteId: 'platform-only',
    });
  });
});

describe('ZernioPublisher.reconcile (the only exit from uncertainty)', () => {
  it('resolves an uncertain attempt from the remote and journals it as the same attempt', async () => {
    const transport = fakeTransport((call) => {
      const path = tail(call.url);
      if (path === '/accounts/health') return { status: 200, body: HEALTH };
      if (path === '/accounts') return { status: 200, body: ACCOUNTS };
      if (path === '/posts' && call.method === 'GET') {
        // A complete listing with an exact echoed key proves membership.
        return {
          status: 200,
          body: {
            posts: [{ _id: 'post-7', requestId: 'idem-1', platforms: [{ platform: 'instagram', status: 'published' }] }],
            pagination: { page: 1, limit: 100, total: 1, pages: 1 },
          },
        };
      }
      if (path === '/posts' && call.method === 'POST') {
        return { status: 201, body: { ok: true } }; // receipt-less attempt
      }
      throw new Error(`unexpected call ${call.method} ${call.url}`);
    });
    const { publisher, journal } = publisherOf(transport);
    const { ctx } = ctxOf('run', transport.fetchImpl);

    expect((await publisher.publish(SOCIAL_POST, ctx)).outcome).toBe('uncertain');
    const reconciled = await publisher.reconcile('idem-1', ctx);
    expect(reconciled).toMatchObject({ outcome: 'published', remoteId: 'post-7' });

    const entries = await journal.readAll();
    expect(entries.map((e) => [e.attempt, e.outcome])).toEqual([
      [1, 'uncertain'],
      [1, 'published'],
    ]);
    expect(attemptsUsed(entries, 'idem-1')).toBe(1);

    // The key is now proven: replay, no second POST.
    expect((await publisher.publish(SOCIAL_POST, ctx)).outcome).toBe('published');
    expect(transport.posts).toHaveLength(1);
  });

  for (const finding of [
    { verdict: 'absent' },
    { verdict: 'absent', evidenceSource: 'payload' },
    { verdict: 'absent', evidenceSource: 'echoed-key' },
  ] satisfies ReconcileFinding[]) {
    it(`absence with ${finding.evidenceSource ?? 'missing'} source cannot authorize POST2 despite retry budget`, async () => {
      const transport = fakeTransport(router({ status: 201, body: { ok: true } }));
      const { publisher, journal } = publisherOf(transport, {
        maxAttempts: 2,
        reconcileLookup: async () => finding,
      });
      const { ctx } = ctxOf('run', transport.fetchImpl);
      expect((await publisher.publish(SOCIAL_POST, ctx)).outcome).toBe('uncertain');
      const before = await journal.readAll();
      const serializedBefore = JSON.stringify(before);
      expect((await publisher.reconcile('idem-1', ctx)).outcome).toBe('uncertain');
      expect((await publisher.publish(SOCIAL_POST, ctx)).outcome).toBe('uncertain');
      expect(transport.posts).toHaveLength(1);
      expect(await journal.readAll()).toEqual(before);
      expect(JSON.stringify(await journal.readAll())).toBe(serializedBefore);
      expect(attemptsUsed(await journal.readAll(), 'idem-1')).toBe(1);
    });
  }

  it('an injected authoritative absence permits a fresh attempt with an explicit budget', async () => {
    const transport = fakeTransport((call) => {
      const path = tail(call.url);
      if (path === '/accounts/health') return { status: 200, body: HEALTH };
      if (path === '/accounts') return { status: 200, body: ACCOUNTS };
      if (path === '/posts' && call.method === 'GET') {
        return { status: 200, body: { posts: [] } };
      }
      return { status: 201, body: { ok: true } };
    });
    const { publisher, journal } = publisherOf(transport, {
      maxAttempts: 2,
      reconcileLookup: async () => ({
        verdict: 'absent', evidenceSource: 'authoritative', detail: 'authoritative proof of absence',
      }),
    });
    const { ctx } = ctxOf('run', transport.fetchImpl);

    expect((await publisher.publish(SOCIAL_POST, ctx)).outcome).toBe('uncertain');
    expect((await publisher.reconcile('idem-1', ctx)).outcome).toBe('failed');

    const retried = await publisher.publish(SOCIAL_POST, ctx);
    expect(retried.outcome).toBe('uncertain'); // receipt-less again
    expect(transport.posts).toHaveLength(2); // only after reconcile + configured budget
    expect(attemptsUsed(await journal.readAll(), 'idem-1')).toBe(2);
  });

  it('an inconclusive lookup leaves the attempt uncertain (never a silent retry)', async () => {
    const lookup: ReconcileLookup = async () => ({
      verdict: 'inconclusive',
      detail: 'lookup gave no verdict',
    });
    const transport = fakeTransport(router({ status: 201, body: { ok: true } }));
    const { publisher } = publisherOf(transport, { reconcileLookup: lookup });
    const { ctx } = ctxOf('run', transport.fetchImpl);

    expect((await publisher.publish(SOCIAL_POST, ctx)).outcome).toBe('uncertain');
    const result = await publisher.reconcile('idem-1', ctx);
    expect(result.outcome).toBe('uncertain');
    expect(result.detail).toContain('inconclusive');
    expect(transport.posts).toHaveLength(1);
  });
});
