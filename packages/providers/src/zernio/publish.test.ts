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
import type { ReconcileLookup } from './status';

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
            platforms: [{ platform: 'instagram', platformPostUrl: 'https://social.example.com/p/1' }],
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
      router({ status: 201, body: { post: { _id: 'post-2', platforms: [] } } }),
    );
    const { publisher } = publisherOf(transport);
    const { ctx } = ctxOf('run', transport.fetchImpl);

    const scheduled: SocialPost = { ...SOCIAL_POST, scheduledFor: '2026-10-01T15:00:00.000Z' };
    const outcome = await publisher.schedule(scheduled, ctx);
    expect(outcome.outcome).toBe('published');
    expect(transport.posts[0].body).toMatchObject({
      scheduledFor: '2026-10-01T15:00:00.000Z',
      timezone: 'America/Lima',
    });
    expect(transport.posts[0].body).not.toHaveProperty('publishNow');

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

describe('ZernioPublisher.reconcile (the only exit from uncertainty)', () => {
  it('resolves an uncertain attempt from the remote and journals it as the same attempt', async () => {
    const transport = fakeTransport((call) => {
      const path = tail(call.url);
      if (path === '/accounts/health') return { status: 200, body: HEALTH };
      if (path === '/accounts') return { status: 200, body: ACCOUNTS };
      if (path === '/posts' && call.method === 'GET') {
        // Lookup by idempotency key: the post DID land.
        return {
          status: 200,
          body: { posts: [{ _id: 'post-7', platforms: [{ platform: 'instagram', status: 'published' }] }] },
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

  it('an absent remote post reconciles to failed and a fresh attempt needs the explicit budget', async () => {
    const transport = fakeTransport((call) => {
      const path = tail(call.url);
      if (path === '/accounts/health') return { status: 200, body: HEALTH };
      if (path === '/accounts') return { status: 200, body: ACCOUNTS };
      if (path === '/posts' && call.method === 'GET') {
        return { status: 200, body: { posts: [] } };
      }
      return { status: 201, body: { ok: true } };
    });
    const { publisher, journal } = publisherOf(transport, { maxAttempts: 2 });
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
