/**
 * Full Zernio surface in plan mode: everything that can answer offline answers
 * offline (validate, plan, journal-derived status) and everything that would
 * touch the network refuses BEFORE any fetch or secret read (NFR-002).
 * The spies below make "zero fetch, zero secret reads" an assertion.
 */
import { describe, expect, it } from 'bun:test';

import type { ProviderContext, SocialPost } from '../ports';
import { InMemoryPaidOperationStore } from '@videomaker/core';

import { ZernioAccounts } from './accounts';
import { ZernioClient } from './client';
import { ZernioDistribution } from './distribution';
import { InMemoryPublicationJournal } from './journal';
import { validateSocialPost, ZernioPublisher } from './publish';
import { describeZernioPlan } from './plan';
import { ZernioAds, type BoostRequest } from './ads';

function planContext(): {
  ctx: ProviderContext;
  fetchCalls: string[];
  secretReads: string[];
} {
  const fetchCalls: string[] = [];
  const secretReads: string[] = [];
  const ctx: ProviderContext = {
    mode: 'plan',
    secrets: {
      getSecret: async (name: string) => {
        secretReads.push(name);
        throw new Error('secrets must not be read in plan mode');
      },
    },
    fetchImpl: (async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      throw new Error('fetch must not be called in plan mode');
    }) as unknown as typeof fetch,
    clock: { now: () => new Date('2026-09-24T12:00:00.000Z') },
  };
  return { ctx, fetchCalls, secretReads };
}

const POST: SocialPost = {
  idempotencyKey: 'idem-plan',
  account: 'instagram:@brand',
  text: 'hello',
  media: ['https://cdn.example.com/marketing/a.mp4'],
};

const BOOST: BoostRequest = {
  accountId: 'conn-1',
  adAccountId: 'ads-1',
  postId: 'post-1',
  name: 'boost',
  goal: 'traffic',
  amount: 10,
  budgetType: 'daily',
  targeting: { countries: ['PE'], cities: [], interests: [] },
};

describe('Zernio surface in plan mode', () => {
  it('validates posts and plans adapters with zero fetch calls and zero secret reads', async () => {
    const { ctx, fetchCalls, secretReads } = planContext();
    const client = new ZernioClient({ apiKey: 'unused', fetchImpl: ctx.fetchImpl });
    const journal = new InMemoryPublicationJournal();
    const publisher = new ZernioPublisher(client, { journal });
    const accounts = new ZernioAccounts(client);
    const distribution = new ZernioDistribution(client);
    const ads = new ZernioAds(client, new InMemoryPaidOperationStore());

    // The validate path works offline.
    expect(await publisher.validate(POST, ctx)).toEqual({ ok: true, problems: [] });
    expect(validateSocialPost(POST).ok).toBe(true);

    // Journal-derived status/reconcile answer offline (never submitted).
    expect((await publisher.status('idem-plan', ctx)).outcome).toBe('failed');
    expect((await publisher.reconcile('idem-plan', ctx)).outcome).toBe('failed');

    // The ads plan is pure: exact body + paid plan, no network.
    const bundle = ads.planBoost(BOOST);
    expect(bundle.plan.command).toBe('zernio-ads:boost');
    expect(bundle.plan.maxAttempts).toBe(1);
    expect(bundle.plan.spendCapUsd).toBe(10);

    // The plan descriptors are pure.
    const plan = describeZernioPlan(() => false);
    expect(plan.missing).toEqual(['ZERNIO_API_KEY']);
    expect(plan.would.length).toBeGreaterThan(0);

    // Every networked entry point refuses BEFORE any fetch or secret read.
    await expect(accounts.list(ctx)).rejects.toThrow(/plan mode/);
    await expect(accounts.health(ctx)).rejects.toThrow(/plan mode/);
    await expect(accounts.profiles(ctx)).rejects.toThrow(/plan mode/);
    await expect(accounts.merged(ctx)).rejects.toThrow(/plan mode/);
    await expect(publisher.publish(POST, ctx)).rejects.toThrow(/plan mode/);
    await expect(publisher.schedule(POST, ctx)).rejects.toThrow(/plan mode/);
    await expect(publisher.accounts(ctx)).rejects.toThrow(/plan mode/);
    await expect(distribution.postDistribution('post-1', ctx)).rejects.toThrow(/plan mode/);
    await expect(distribution.retry('post-1', ctx)).rejects.toThrow(/plan mode/);
    await expect(distribution.editCaption('post-1', 'instagram', 'x', ctx)).rejects.toThrow(
      /plan mode/,
    );
    await expect(distribution.queueSlots('profile-1', ctx)).rejects.toThrow(/plan mode/);
    await expect(distribution.queuePreview('profile-1', 5, ctx)).rejects.toThrow(/plan mode/);
    await expect(distribution.bestTime('instagram', 'acc-1', ctx)).rejects.toThrow(/plan mode/);
    await expect(ads.reachEstimate(BOOST, ctx)).rejects.toThrow(/plan mode/);
    await expect(ads.submitBoost(bundle, ctx)).rejects.toThrow(/plan mode/);
    await expect(ads.campaignStatus('camp-1', 'conn-1', ctx)).rejects.toThrow(/plan mode/);
    await expect(ads.campaignInsights('camp-1', 'conn-1', ctx)).rejects.toThrow(/plan mode/);
    await expect(ads.setCampaignStatus('camp-1', 'conn-1', 'meta', 'paused', ctx)).rejects.toThrow(
      /plan mode/,
    );

    expect(fetchCalls).toHaveLength(0);
    expect(secretReads).toHaveLength(0);
    expect(await journal.readAll()).toHaveLength(0);
  });
});
