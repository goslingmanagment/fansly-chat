import { millsToUsd } from './earnings.js';
import type { FanSubscriptionContext, FanslySubscriptionTier } from './types.js';

const MS_PER_DAY = 86_400_000;

const SUBSCRIPTION_STATUS_LABELS: Record<number, string> = {
  3: 'Active',
  4: 'Active (alternate)',
  5: 'Expired',
};

function billingCycleLabel(days: number): string {
  if (days === 30) return 'month';
  if (days === 90) return '3 months';
  if (days === 180) return '6 months';
  if (days === 365) return 'year';
  return `${days} days`;
}

function formatShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function daysBetween(from: number, to: number): number {
  return Math.floor(Math.abs(to - from) / MS_PER_DAY);
}

function isActive(status: number): boolean {
  return status === 3 || status === 4;
}

function isGift(sub: FanSubscriptionContext): boolean {
  return sub.giftCodeId !== null && sub.giftCodeId !== '0' && sub.price === 0;
}

function isPromoActive(sub: FanSubscriptionContext): boolean {
  if (sub.promoPrice === null) {
    return false;
  }
  if (sub.promoStatus !== null) {
    return sub.promoStatus === 1;
  }
  return true;
}

function formatUsd(value: number | null): string {
  return value === null ? 'Unknown' : `$${millsToUsd(value)}`;
}

/**
 * Format rich subscription context for AI prompt inclusion.
 *
 * Uses the richer formatting approach: gift/promo detection, churn risk,
 * days-until-end, auto-renew status, benefits, available plans.
 *
 * Accepts Codex's FanSubscriptionContext (normalized form) with optional
 * FanslySubscriptionTier for benefits/plans.
 *
 * Does NOT escape — escaping happens in the prompt builder.
 */
export function formatFanSubscriptionData(
  subscription: FanSubscriptionContext | null,
  tier: FanslySubscriptionTier | null = null,
  now: number = Date.now(),
): string {
  if (!subscription && !tier) {
    return '';
  }

  const lines: string[] = ['FAN SUBSCRIPTION DATA:'];

  if (subscription) {
    formatWithSubscription(lines, subscription, tier, now);
  } else if (tier) {
    lines.push('Status: Not subscribed');
    formatTierDetails(lines, tier);
  }

  return lines.join('\n');
}

function formatWithSubscription(
  lines: string[],
  sub: FanSubscriptionContext,
  tier: FanslySubscriptionTier | null,
  now: number,
): void {
  const cycle = sub.billingCycle !== null ? billingCycleLabel(sub.billingCycle) : 'month';
  const renewPriceStr = sub.renewPrice !== null ? `$${millsToUsd(sub.renewPrice)}` : formatUsd(sub.price);
  const tierPrice = `${renewPriceStr}/${cycle}`;
  const tierName = sub.subscriptionTierName ?? tier?.name ?? 'Unknown';

  lines.push(`Source: ${sub.source}`);
  lines.push(`Subscriber account ID: ${sub.subscriberAccountId}`);
  lines.push(`Tier: ${tierName} (${tierPrice})`);

  // Status with acquisition nuances
  if (isActive(sub.status)) {
    let statusDetail = 'Active';
    if (isGift(sub)) {
      statusDetail += ` (gift subscription — paid $${millsToUsd(sub.price)}, renewal price ${tierPrice})`;
    } else if (isPromoActive(sub)) {
      statusDetail += ` (promotional price: $${millsToUsd(sub.promoPrice!)})`;
    }
    lines.push(`Status: ${statusDetail}`);
  } else {
    const statusLabel = SUBSCRIPTION_STATUS_LABELS[sub.status] ?? 'Unknown';
    if (sub.endsAtIso) {
      const endsAtMs = new Date(sub.endsAtIso).getTime();
      const daysAgo = daysBetween(endsAtMs, now);
      lines.push(`Status: ${statusLabel} (ended ${formatShortDate(endsAtMs)} — ${daysAgo} days ago)`);
      if (sub.createdAtIso) {
        const createdMs = new Date(sub.createdAtIso).getTime();
        const subscribedDays = daysBetween(createdMs, endsAtMs);
        lines.push(`Was subscribed for: ${subscribedDays} days`);
      }
    } else {
      lines.push(`Status: ${statusLabel} (${sub.status})`);
    }
  }

  // Date details
  if (sub.createdAtIso) {
    const createdMs = new Date(sub.createdAtIso).getTime();
    const subscribedDaysAgo = daysBetween(createdMs, now);
    lines.push(`Subscribed since: ${formatShortDate(createdMs)} (${subscribedDaysAgo} days ago)`);
  }

  if (isActive(sub.status) && sub.endsAtIso) {
    const endsAtMs = new Date(sub.endsAtIso).getTime();
    if (endsAtMs >= now) {
      const daysUntilEnd = Math.floor((endsAtMs - now) / MS_PER_DAY);
      lines.push(`Current period ends: ${formatShortDate(endsAtMs)} (in ${daysUntilEnd} days)`);
    } else {
      // Fansly data lag can leave an active status with a past endsAt; don't
      // report it as a future date via the absolute-value daysBetween.
      const daysSinceEnd = Math.floor((now - endsAtMs) / MS_PER_DAY);
      lines.push(`Current period ends: ${formatShortDate(endsAtMs)} (ended ${daysSinceEnd} days ago — period lapsed)`);
    }
  }

  // Auto-renew with churn signal
  if (isActive(sub.status)) {
    if (sub.autoRenew === true) {
      lines.push(`Auto-renew: On (renews at ${tierPrice})`);
    } else if (sub.autoRenew === false) {
      lines.push('Auto-renew: Off — will NOT renew (churn risk)');
    }
  }

  // Billing cycle
  if (sub.billingCycle !== null) {
    lines.push(`Billing cycle: ${sub.billingCycle} days`);
  }

  // Promo info
  if (isPromoActive(sub)) {
    lines.push(`Promo active: Yes`);
    lines.push(`Promo price: $${millsToUsd(sub.promoPrice!)}`);
    if (sub.promoDuration !== null) {
      lines.push(`Promo duration: ${sub.promoDuration} days`);
    }
  }

  // Gift info
  if (isGift(sub)) {
    lines.push(`Gift code: ${sub.giftCodeId}`);
  }

  // Benefits from tier definition
  if (tier && tier.subscriptionBenefits.length > 0) {
    lines.push('Benefits:');
    for (const benefit of tier.subscriptionBenefits) {
      lines.push(`- ${benefit}`);
    }
  }

  // Available plan options (only if >1 active plan)
  if (tier && tier.plans.length > 0) {
    const activePlans = tier.plans.filter((p) => p.status === 1);
    if (activePlans.length > 1) {
      lines.push('Available plans:');
      for (const plan of activePlans) {
        lines.push(`- ${billingCycleLabel(plan.billingCycle)}: $${millsToUsd(plan.price)}`);
      }
    }
  }
}

function formatTierDetails(lines: string[], tier: FanslySubscriptionTier): void {
  const activePlans = tier.plans.filter((p) => p.status === 1);
  const monthlyPlan = activePlans.find((p) => p.billingCycle === 30);
  const basePrice = monthlyPlan ? monthlyPlan.price : tier.price;
  const cycle = monthlyPlan ? 'month' : activePlans[0] ? billingCycleLabel(activePlans[0].billingCycle) : 'month';

  lines.push(`Available tier: ${tier.name} ($${millsToUsd(basePrice)}/${cycle})`);

  if (tier.subscriptionBenefits.length > 0) {
    lines.push('Benefits:');
    for (const benefit of tier.subscriptionBenefits) {
      lines.push(`- ${benefit}`);
    }
  }
}
