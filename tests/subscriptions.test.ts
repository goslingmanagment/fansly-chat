import { describe, expect, it } from 'vitest';
import { formatFanSubscriptionData } from '../src/shared/subscriptions.js';
import type { FanSubscriptionContext, FanslySubscriptionTier } from '../src/shared/types.js';

const NOW = new Date('2025-03-02T00:00:00Z').getTime();
const DAY_MS = 86_400_000;

function makeSub(overrides: Partial<FanSubscriptionContext> = {}): FanSubscriptionContext {
  return {
    source: '/api/v1/messaging/groups',
    subscriptionId: 'sub-1',
    subscriberAccountId: 'fan-123',
    status: 3,
    subscriptionTierId: 'tier-1',
    subscriptionTierName: 'Gold Tier',
    planId: 'plan-1',
    price: 10000,
    renewPrice: 10000,
    autoRenew: true,
    billingCycle: 30,
    giftCodeId: '0',
    promoId: null,
    promoPrice: null,
    promoDuration: null,
    promoStatus: null,
    promoStartsAtIso: null,
    promoEndsAtIso: null,
    renewDateIso: null,
    endsAtIso: new Date(NOW + 15 * DAY_MS).toISOString(),
    createdAtIso: new Date(NOW - 47 * DAY_MS).toISOString(),
    ...overrides,
  };
}

function makeTier(overrides: Partial<FanslySubscriptionTier> = {}): FanslySubscriptionTier {
  return {
    id: 'tier-1',
    name: 'Gold Tier',
    price: 10000,
    subscriptionBenefits: ['Full access to DMs', 'Exclusive content'],
    plans: [
      { id: 'plan-1', status: 1, billingCycle: 30, price: 10000 },
      { id: 'plan-2', status: 1, billingCycle: 90, price: 25000 },
    ],
    ...overrides,
  };
}

describe('formatFanSubscriptionData', () => {
  it('returns empty string when both subscription and tier are null', () => {
    expect(formatFanSubscriptionData(null, null, NOW)).toBe('');
  });

  it('shows tier name, status, price, dates, and auto-renew for active subscriber', () => {
    const result = formatFanSubscriptionData(makeSub(), makeTier(), NOW);
    expect(result).toContain('FAN SUBSCRIPTION DATA:');
    expect(result).toContain('Tier: Gold Tier ($10.00/month)');
    expect(result).toContain('Status: Active');
    expect(result).toContain('47 days ago');
    expect(result).toContain('in 15 days');
    expect(result).toContain('Auto-renew: On (renews at $10.00/month)');
  });

  it('shows source field', () => {
    const result = formatFanSubscriptionData(makeSub(), null, NOW);
    expect(result).toContain('Source: /api/v1/messaging/groups');
  });

  it('shows benefits from tier definition', () => {
    const result = formatFanSubscriptionData(makeSub(), makeTier(), NOW);
    expect(result).toContain('Benefits:');
    expect(result).toContain('- Full access to DMs');
    expect(result).toContain('- Exclusive content');
  });

  it('shows available plan options when >1 active plan', () => {
    const result = formatFanSubscriptionData(makeSub(), makeTier(), NOW);
    expect(result).toContain('Available plans:');
    expect(result).toContain('- month: $10.00');
    expect(result).toContain('- 3 months: $25.00');
  });

  it('does not show available plans when only 1 plan', () => {
    const tier = makeTier({ plans: [{ id: 'plan-1', status: 1, billingCycle: 30, price: 10000 }] });
    const result = formatFanSubscriptionData(makeSub(), tier, NOW);
    expect(result).not.toContain('Available plans:');
  });

  // --- Churn risk ---

  it('shows churn risk when auto-renew is off', () => {
    const sub = makeSub({ autoRenew: false });
    const result = formatFanSubscriptionData(sub, makeTier(), NOW);
    expect(result).toContain('Auto-renew: Off');
    expect(result).toContain('will NOT renew (churn risk)');
  });

  // --- Gift subscription ---

  it('shows gift subscription details', () => {
    const sub = makeSub({ price: 0, giftCodeId: '836023724372160513' });
    const result = formatFanSubscriptionData(sub, makeTier(), NOW);
    expect(result).toContain('gift subscription');
    expect(result).toContain('paid $0.00');
    expect(result).toContain('renewal price $10.00/month');
  });

  // --- Promotional price ---

  it('shows promotional price', () => {
    const sub = makeSub({ promoPrice: 7770, promoStatus: 1 });
    const result = formatFanSubscriptionData(sub, makeTier(), NOW);
    expect(result).toContain('promotional price: $7.77');
  });

  // --- Expired subscription ---

  it('shows expired status with end date and duration', () => {
    const sub = makeSub({
      status: 5,
      endsAtIso: new Date(NOW - 15 * DAY_MS).toISOString(),
      createdAtIso: new Date(NOW - 46 * DAY_MS).toISOString(),
    });
    const result = formatFanSubscriptionData(sub, makeTier(), NOW);
    expect(result).toContain('Expired');
    expect(result).toContain('15 days ago');
    expect(result).toContain('Was subscribed for: 31 days');
  });

  it('does not show auto-renew for expired subscriptions', () => {
    const sub = makeSub({ status: 5, endsAtIso: new Date(NOW - 10 * DAY_MS).toISOString() });
    const result = formatFanSubscriptionData(sub, makeTier(), NOW);
    expect(result).not.toContain('Auto-renew:');
  });

  it('does not show "Current period ends" for expired subscriptions', () => {
    const sub = makeSub({ status: 5, endsAtIso: new Date(NOW - 10 * DAY_MS).toISOString() });
    const result = formatFanSubscriptionData(sub, makeTier(), NOW);
    expect(result).not.toContain('Current period ends:');
  });

  // --- Subscription without tier ---

  it('shows subscription data without benefits when tier is null', () => {
    const result = formatFanSubscriptionData(makeSub(), null, NOW);
    expect(result).toContain('Tier: Gold Tier');
    expect(result).toContain('Status: Active');
    expect(result).not.toContain('Benefits:');
    expect(result).not.toContain('Available plans:');
  });

  // --- Tier only (no subscription) ---

  it('shows "Not subscribed" when only tier is available', () => {
    const result = formatFanSubscriptionData(null, makeTier(), NOW);
    expect(result).toContain('Status: Not subscribed');
    expect(result).toContain('Available tier: Gold Tier');
    expect(result).toContain('Benefits:');
  });

  // --- Billing cycle labels ---

  it('formats 30-day cycle as "month"', () => {
    const sub = makeSub({ billingCycle: 30 });
    const result = formatFanSubscriptionData(sub, null, NOW);
    expect(result).toContain('/month');
  });

  it('formats 90-day cycle as "3 months"', () => {
    const sub = makeSub({ billingCycle: 90, renewPrice: 25000 });
    const result = formatFanSubscriptionData(sub, null, NOW);
    expect(result).toContain('$25.00/3 months');
  });

  it('formats 180-day cycle as "6 months"', () => {
    const sub = makeSub({ billingCycle: 180, renewPrice: 45000 });
    const result = formatFanSubscriptionData(sub, null, NOW);
    expect(result).toContain('$45.00/6 months');
  });

  it('formats 365-day cycle as "year"', () => {
    const sub = makeSub({ billingCycle: 365, renewPrice: 100000 });
    const result = formatFanSubscriptionData(sub, null, NOW);
    expect(result).toContain('$100.00/year');
  });

  it('formats non-standard cycle in days', () => {
    const sub = makeSub({ billingCycle: 14, renewPrice: 5000 });
    const result = formatFanSubscriptionData(sub, null, NOW);
    expect(result).toContain('$5.00/14 days');
  });

  // --- Mills formatting ---

  it('formats 5000 mills as $5.00', () => {
    const sub = makeSub({ renewPrice: 5000 });
    const result = formatFanSubscriptionData(sub, null, NOW);
    expect(result).toContain('$5.00');
  });

  it('formats 0 mills as $0.00 for gift subscriptions', () => {
    const sub = makeSub({ price: 0, giftCodeId: 'gift-1' });
    const result = formatFanSubscriptionData(sub, null, NOW);
    expect(result).toContain('$0.00');
  });
});
