/**
 * Zernio ads as paid operations: pure plan (explicit limits), exactly one
 * live submit per plan, uncertain outcomes block the plan until an explicit
 * reconcile — never a silent retry (FR-011 spend safety).
 */
import { describe, expect, it } from 'bun:test';

import {
  InMemoryPaidOperationStore,
  PaidOperationError,
  paidPlanDigest,
  type PaidOperationStore,
} from '@videomaker/core';

import type { ProviderContext } from '../ports';
import { ZernioClient } from './client';
import {
  adsConnectionId,
  buildBoostBody,
  evaluateAlert,
  extractCampaignId,
  ZernioAds,
  ZernioAdsError,
  type BoostRequest,
} from './ads';

const REQUEST: BoostRequest = {
  accountId: 'conn-1',
  adAccountId: 'ads-1',
  postId: 'post-1',
  name: 'boost post-1',
  goal: 'traffic',
  amount: 25,
  budgetType: 'daily',
  targeting: {
    countries: ['PE'],
    cities: [{ key: 'lim', name: 'Lima' }],
    interests: [{ id: 'i1', name: 'running' }],
    ageMin: 18,
    ageMax: 44,
  },
};

function ctxOf(fetchImpl: typeof fetch): ProviderContext {
  return {
    mode: 'run',
    secrets: {
      getSecret: async () => {
        throw new Error('secrets must not be read');
      },
    },
    fetchImpl,
    clock: { now: () => new Date('2026-09-24T12:00:00.000Z') },
  };
}

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

interface FakeTransport {
  fetchImpl: typeof fetch;
  calls: Recorded[];
  posts: Recorded[];
}

function fakeTransport(handler: (call: Recorded) => { status: number; body: unknown }): FakeTransport {
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
      return calls.filter(
        (c) => c.method === 'POST' && new URL(c.url).pathname.endsWith('/ads/boost'),
      );
    },
  };
}

function adsOf(
  transport: FakeTransport,
  store: PaidOperationStore = new InMemoryPaidOperationStore(),
): ZernioAds {
  const client = new ZernioClient({ apiKey: 'test-key', fetchImpl: transport.fetchImpl });
  return new ZernioAds(client, store);
}

describe('buildBoostBody / evaluateAlert', () => {
  it('builds explicit targeting and omits schedule without dates', () => {
    const body = buildBoostBody(REQUEST);
    expect(body).toMatchObject({
      accountId: 'conn-1',
      adAccountId: 'ads-1',
      postId: 'post-1',
      budget: { amount: 25, type: 'daily' },
      targeting: {
        countries: ['PE'],
        cities: [{ key: 'lim', name: 'Lima' }],
        interests: [{ id: 'i1', name: 'running' }],
        ageMin: 18,
        ageMax: 44,
      },
    });
    expect(body).not.toHaveProperty('schedule');

    const scheduled = buildBoostBody({
      ...REQUEST,
      startDate: '2026-10-01T00:00:00.000Z',
    });
    expect(scheduled.schedule).toEqual({ startDate: '2026-10-01T00:00:00.000Z' });

    expect(() =>
      buildBoostBody({ ...REQUEST, targeting: { ...REQUEST.targeting, countries: [] } }),
    ).toThrow(ZernioAdsError);
  });

  it('detects threshold breaches and passes in green', () => {
    expect(evaluateAlert({ cpm: 12, spend: 30 }, { maxCpm: 10 })).toMatchObject({ breached: true });
    expect(evaluateAlert({ cpm: 5, spend: 30 }, { maxCpm: 10, maxSpend: 20 })).toMatchObject({
      breached: true,
    });
    expect(evaluateAlert({ cpm: 5, spend: 10 }, { maxCpm: 10, maxSpend: 20 }).breached).toBe(false);
  });

  it('resolves ads connections and campaign ids', () => {
    const accounts = [
      { id: 'conn-meta', platform: 'metaads' },
      { id: 'conn-tt', platform: 'tiktokads' },
      { id: 'acc-1', platform: 'instagram' },
    ];
    expect(adsConnectionId(accounts, 'meta')).toBe('conn-meta');
    expect(adsConnectionId(accounts, 'tiktok')).toBe('conn-tt');
    expect(() => adsConnectionId(accounts.slice(2), 'meta')).toThrow(ZernioAdsError);

    expect(extractCampaignId({ platformCampaignId: 'camp-1' })).toBe('camp-1');
    expect(extractCampaignId({ campaign: { id: 'camp-2' } })).toBe('camp-2');
  });
});

describe('ZernioAds plan/submit/status as paid operations', () => {
  it('plans with explicit limits and a stable digest', () => {
    const ads = adsOf(fakeTransport(() => ({ status: 200, body: {} })));
    const first = ads.planBoost(REQUEST);
    const second = ads.planBoost(REQUEST);
    expect(first.plan.inputsDigest).toBe(second.plan.inputsDigest);
    expect(first.plan).toMatchObject({
      schemaVersion: 1,
      command: 'zernio-ads:boost',
      subject: 'zernio-ads:boost:post-1',
      estimatedCostUsd: 25,
      maxAttempts: 1,
      spendCapUsd: 25,
    });
    expect(paidPlanDigest(first.plan)).toBe(paidPlanDigest(second.plan));

    const bigger = ads.planBoost({ ...REQUEST, amount: 30 }, { maxAttempts: 2, spendCapUsd: 60 });
    expect(bigger.plan.inputsDigest).not.toBe(first.plan.inputsDigest);
    expect(bigger.plan.maxAttempts).toBe(2);
    expect(bigger.plan.spendCapUsd).toBe(60);
  });

  it('submits exactly once per plan and blocks the plan afterwards (no double spend)', async () => {
    const transport = fakeTransport(() => ({ status: 200, body: { platformCampaignId: 'camp-1' } }));
    const store = new InMemoryPaidOperationStore();
    const ads = adsOf(transport, store);
    const ctx = ctxOf(transport.fetchImpl);
    const bundle = ads.planBoost(REQUEST);

    const { record, campaignId } = await ads.submitBoost(bundle, ctx);
    expect(campaignId).toBe('camp-1');
    expect(record.state).toBe('submitted');
    expect(record.receipt?.requestId).toBe(paidPlanDigest(bundle.plan));
    expect(transport.posts).toHaveLength(1);
    expect(transport.posts[0].headers['idempotency-key']).toBe(paidPlanDigest(bundle.plan));

    // Same plan again: the engine refuses before any second wire attempt.
    await expect(ads.submitBoost(bundle, ctx)).rejects.toBeInstanceOf(PaidOperationError);
    expect(transport.posts).toHaveLength(1);
  });

  it('a submit without a proven outcome journals uncertain and blocks the plan', async () => {
    const transport = fakeTransport(() => {
      throw new Error('connection reset');
    });
    const store = new InMemoryPaidOperationStore();
    const ads = adsOf(transport, store);
    const ctx = ctxOf(transport.fetchImpl);
    const bundle = ads.planBoost(REQUEST);

    await expect(ads.submitBoost(bundle, ctx)).rejects.toBeInstanceOf(PaidOperationError);
    const history = await store.list({ planDigest: paidPlanDigest(bundle.plan) });
    expect(history.map((entry) => entry.state)).toEqual(['uncertain']);

    // Uncertain blocks: no automatic retry, no second POST.
    await expect(ads.submitBoost(bundle, ctx)).rejects.toBeInstanceOf(PaidOperationError);
    expect(transport.posts).toHaveLength(1);
  });

  it('status/insights read the campaign without spending', async () => {
    const routed = fakeTransport((call) => {
      if (call.url.includes('/analytics')) {
        return {
          status: 200,
          body: { analytics: { summary: { spend: 5, cpm: 2, impressions: 100, reach: 80 } } },
        };
      }
      return {
        status: 200,
        body: { campaign: { id: 'camp-1', status: 'active', effective_status: 'ACTIVE' } },
      };
    });
    const routedAds = adsOf(routed);
    const routedCtx = ctxOf(routed.fetchImpl);

    const summary = await routedAds.campaignStatus('camp-1', 'conn-1', routedCtx);
    expect(summary).toMatchObject({ id: 'camp-1', status: 'active', effectiveStatus: 'ACTIVE' });
    const insights = await routedAds.campaignInsights('camp-1', 'conn-1', routedCtx);
    expect(insights).toMatchObject({ spend: 5, cpm: 2, impressions: 100, reach: 80 });

    await routedAds.setCampaignStatus('camp-1', 'conn-1', 'meta', 'paused', routedCtx);
    expect(routed.calls.some((c) => c.method === 'PUT')).toBe(true);
  });
});
