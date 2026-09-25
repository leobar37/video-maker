/**
 * Zernio ads surface (`zernio-ads`): plan / submit / status of boosts as paid
 * operations on top of `@videomaker/core`.
 *
 * Spend safety (FR-011 semantics of the paid-operation engine):
 * - `planBoost` is pure: exact request body + `PaidOperationPlan` with explicit
 *   `maxAttempts` and `spendCapUsd` before any money moves;
 * - `submitBoost` goes through `submitOnce`: exactly one wire submit per plan,
 *   journalled in a `PaidOperationStore`. A submit without a proven receipt is
 *   journalled `uncertain` and blocks further submits until explicitly
 *   reconciled — an uncertain boost may have spent money;
 * - the idempotency key of the boost is the plan digest, so provider-side
 *   dedupe also survives crashes;
 * - preview (`reachEstimate`) never spends; the API key is never logged or
 *   journalled (NFR-001).
 */
import {
  paidPlanDigest,
  sha256Json,
  submitOnce,
  type PaidOperationPlan,
  type PaidOperationRecord,
  type PaidOperationStore,
} from '@videomaker/core';

import type { ProviderContext } from '../ports';
import { assertRunMode } from '../storage/context';
import type { ZernioAccount } from './accounts';
import type { ZernioClient } from './client';

export class ZernioAdsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZernioAdsError';
  }
}

export interface BoostTarget {
  cities: Array<{ key: string; name?: string }>;
  interests: Array<{ id: string; name: string }>;
  ageMin?: number;
  ageMax?: number;
  countries: string[];
}

export interface BoostRequest {
  accountId: string;
  adAccountId: string;
  postId: string;
  name: string;
  goal: string;
  /** Budget amount in USD (daily or lifetime per `budgetType`). */
  amount: number;
  budgetType: string;
  startDate?: string;
  endDate?: string;
  targeting: BoostTarget;
}

/** Exact `POST /v1/ads/boost` body. Pure and testable. */
export function buildBoostBody(req: BoostRequest): Record<string, unknown> {
  if (req.targeting.countries.length === 0) {
    throw new ZernioAdsError('targeting.countries is required (explicit targeting, never defaults).');
  }
  return {
    accountId: req.accountId,
    adAccountId: req.adAccountId,
    postId: req.postId,
    name: req.name,
    goal: req.goal,
    budget: { amount: req.amount, type: req.budgetType },
    ...(req.startDate || req.endDate
      ? {
          schedule: {
            ...(req.startDate ? { startDate: req.startDate } : {}),
            ...(req.endDate ? { endDate: req.endDate } : {}),
          },
        }
      : {}),
    targeting: {
      ...(req.targeting.ageMin !== undefined ? { ageMin: req.targeting.ageMin } : {}),
      ...(req.targeting.ageMax !== undefined ? { ageMax: req.targeting.ageMax } : {}),
      countries: req.targeting.countries,
      ...(req.targeting.cities.length > 0 ? { cities: req.targeting.cities } : {}),
      ...(req.targeting.interests.length > 0 ? { interests: req.targeting.interests } : {}),
    },
  };
}

export interface AlertThresholds {
  maxCpm?: number;
  maxSpend?: number;
}

export interface AlertResult {
  breached: boolean;
  lines: string[];
}

/** Evaluates spend thresholds against an insights summary. Pure. */
export function evaluateAlert(
  summary: { cpm?: number; spend?: number },
  thresholds: AlertThresholds,
): AlertResult {
  const lines: string[] = [];
  let breached = false;
  if (thresholds.maxCpm !== undefined && (summary.cpm ?? 0) > thresholds.maxCpm) {
    breached = true;
    lines.push(`cpm ${summary.cpm} > ${thresholds.maxCpm}`);
  }
  if (thresholds.maxSpend !== undefined && (summary.spend ?? 0) > thresholds.maxSpend) {
    breached = true;
    lines.push(`spend ${summary.spend} > ${thresholds.maxSpend}`);
  }
  if (!breached) lines.push('OK: within thresholds.');
  return { breached, lines };
}

/** Ads connection id for a platform (`metaads` / `tiktokads` account entry). */
export function adsConnectionId(accounts: ZernioAccount[], platform: 'meta' | 'tiktok'): string {
  const want = platform === 'tiktok' ? 'tiktokads' : 'metaads';
  const found = accounts.find((account) => account.platform === want);
  if (!found?.id) throw new ZernioAdsError(`No ${want} connection on the Zernio account.`);
  return found.id;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** Campaign id from a boost/status response (tolerant wrappers). */
export function extractCampaignId(body: unknown): string | undefined {
  const root = asRecord(body);
  const direct = root.platformCampaignId ?? root.campaignId;
  if (typeof direct === 'string' && direct) return direct;
  const campaign = asRecord(root.campaign ?? root);
  const id = campaign.id ?? campaign._id;
  return typeof id === 'string' && id ? id : undefined;
}

export interface BoostPlanBundle {
  plan: PaidOperationPlan;
  body: Record<string, unknown>;
}

export interface BoostSubmitOptions {
  /** Wire idempotency key; defaults to the plan digest (stable per intent). */
  idempotencyKey?: string;
}

export interface BoostSubmitResult {
  record: PaidOperationRecord;
  campaignId?: string;
}

export interface CampaignSummary {
  id: string;
  status?: string;
  effectiveStatus?: string;
  objective?: string;
  budget?: unknown;
}

export interface CampaignInsights {
  spend?: number;
  cpm?: number;
  impressions?: number;
  reach?: number;
  actions?: unknown;
}

export interface ZernioAdsOptions {
  /** Explicit plan limits; defaults to one attempt capped at the budget. */
  maxAttempts?: number;
  spendCapUsd?: number;
}

/** Ads surface: plan/submit/status as paid operations. */
export class ZernioAds {
  constructor(
    private readonly client: ZernioClient,
    private readonly store: PaidOperationStore,
    private readonly opts: ZernioAdsOptions = {},
  ) {}

  /** Pure: exact request body + paid plan with explicit attempt/spend limits. */
  planBoost(req: BoostRequest, opts: ZernioAdsOptions = {}): BoostPlanBundle {
    const body = buildBoostBody(req);
    const plan: PaidOperationPlan = {
      schemaVersion: 1,
      command: 'zernio-ads:boost',
      subject: `zernio-ads:boost:${req.postId}`,
      inputsDigest: sha256Json(body),
      outputs: ['ads/campaign'],
      estimatedCostUsd: req.amount,
      maxAttempts: opts.maxAttempts ?? this.opts.maxAttempts ?? 1,
      spendCapUsd: opts.spendCapUsd ?? this.opts.spendCapUsd ?? req.amount,
    };
    return { plan, body };
  }

  /** Preview reach for the same targeting: never spends. */
  async reachEstimate(req: BoostRequest, ctx: ProviderContext): Promise<unknown> {
    assertRunMode(ctx, 'Zernio ads reach estimate');
    const body = buildBoostBody(req);
    const targeting = asRecord(body).targeting;
    const { status, body: response } = await this.client.request('/ads/targeting/reach-estimate', {
      method: 'POST',
      body: { accountId: req.accountId, adAccountId: req.adAccountId, spec: targeting },
    });
    if (status !== 200 && status !== 201) {
      throw new ZernioAdsError(`POST /ads/targeting/reach-estimate → HTTP ${status}.`);
    }
    return response;
  }

  /**
   * Exactly one live submit per plan (`submitOnce`). Any outcome without a
   * proven receipt is journalled `uncertain` and blocks the plan until it is
   * reconciled out-of-band — never retried silently.
   */
  async submitBoost(
    bundle: BoostPlanBundle,
    ctx: ProviderContext,
    opts: BoostSubmitOptions = {},
  ): Promise<BoostSubmitResult> {
    assertRunMode(ctx, 'Zernio ads boost submit');
    const idempotencyKey = opts.idempotencyKey ?? paidPlanDigest(bundle.plan);
    let campaignId: string | undefined;
    const record = await submitOnce({
      store: this.store,
      plan: bundle.plan,
      now: () => ctx.clock.now(),
      submit: async () => {
        const response = await this.client.request('/ads/boost', {
          method: 'POST',
          body: bundle.body,
          idempotencyKey,
        });
        if (response.status !== 200 && response.status !== 201) {
          throw new ZernioAdsError(`POST /ads/boost → HTTP ${response.status}`);
        }
        campaignId = extractCampaignId(response.body);
        return {
          requestId: idempotencyKey,
          ...(campaignId
            ? { statusUrl: `${this.client.baseUrl}/ads/campaigns/${campaignId}` }
            : {}),
        };
      },
    });
    return { record, campaignId };
  }

  /** `GET /ads/campaigns/:id` — campaign status (paid-op status probe). */
  async campaignStatus(
    campaignId: string,
    accountId: string,
    ctx: ProviderContext,
  ): Promise<CampaignSummary> {
    assertRunMode(ctx, 'Zernio ads campaign status');
    const { status, body } = await this.client.request(
      `/ads/campaigns/${encodeURIComponent(campaignId)}?accountId=${encodeURIComponent(accountId)}`,
    );
    if (status !== 200) throw new ZernioAdsError(`GET /ads/campaigns/${campaignId} → HTTP ${status}.`);
    const root = asRecord(body);
    const campaign = asRecord(root.campaign ?? root);
    return {
      id: extractCampaignId(body) ?? campaignId,
      status: typeof campaign.status === 'string' ? campaign.status : undefined,
      effectiveStatus:
        typeof campaign.effective_status === 'string'
          ? campaign.effective_status
          : typeof campaign.effectiveStatus === 'string'
            ? campaign.effectiveStatus
            : undefined,
      objective: typeof campaign.objective === 'string' ? campaign.objective : undefined,
      budget: campaign.daily_budget ?? campaign.budget,
    };
  }

  /** `GET /ads/campaigns/:id/analytics` — spend/CPM summary. */
  async campaignInsights(
    campaignId: string,
    accountId: string,
    ctx: ProviderContext,
  ): Promise<CampaignInsights> {
    assertRunMode(ctx, 'Zernio ads campaign insights');
    const { status, body } = await this.client.request(
      `/ads/campaigns/${encodeURIComponent(campaignId)}/analytics?accountId=${encodeURIComponent(accountId)}`,
    );
    if (status !== 200) {
      throw new ZernioAdsError(`GET /ads/campaigns/${campaignId}/analytics → HTTP ${status}.`);
    }
    const root = asRecord(body);
    const summary = asRecord(asRecord(root.analytics).summary);
    return {
      spend: typeof summary.spend === 'number' ? summary.spend : undefined,
      cpm: typeof summary.cpm === 'number' ? summary.cpm : undefined,
      impressions: typeof summary.impressions === 'number' ? summary.impressions : undefined,
      reach: typeof summary.reach === 'number' ? summary.reach : undefined,
      actions: summary.actions,
    };
  }

  /** `PUT /ads/campaigns/:id/status` — pause/resume a campaign. */
  async setCampaignStatus(
    campaignId: string,
    accountId: string,
    platform: 'meta' | 'tiktok',
    next: 'paused' | 'active',
    ctx: ProviderContext,
  ): Promise<void> {
    assertRunMode(ctx, 'Zernio ads campaign status change');
    const { status } = await this.client.request(
      `/ads/campaigns/${encodeURIComponent(campaignId)}/status?accountId=${encodeURIComponent(accountId)}`,
      { method: 'PUT', body: { status: next, platform } },
    );
    if (status !== 200) throw new ZernioAdsError(`PUT /ads/campaigns/${campaignId}/status → HTTP ${status}.`);
  }
}
