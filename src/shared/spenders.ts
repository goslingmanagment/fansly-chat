// Pure Spenders-board domain logic. Unlike the ChatGoose Desktop board (whose
// tiers come from named OnlyMonster lists), Fansly has no equivalent, so tiers
// here are computed client-side from a lifetime-spend threshold table. All
// amounts are creator-facing USD (callers convert Fansly mills → USD first).

export type SpenderTierId = 'whale' | 'top' | 'prime' | 'base' | 'low' | 'micro';

export interface SpenderTier {
  id: SpenderTierId;
  title: string;
  emoji: string;
  /** Inclusive lower bound, USD. */
  minUsd: number;
  /** Exclusive upper bound, USD; null = open-ended (top tier). */
  maxUsd: number | null;
  /** Display band, e.g. '$600+' or '$350–600'. */
  band: string;
}

// Highest → lowest. Bands mirror the Desktop reference design.
export const SPENDER_TIERS: readonly SpenderTier[] = [
  { id: 'whale', title: 'Whale', emoji: '🐳', minUsd: 600, maxUsd: null, band: '$600+' },
  { id: 'top', title: 'Top', emoji: '⭐', minUsd: 350, maxUsd: 600, band: '$350–600' },
  { id: 'prime', title: 'Prime', emoji: '✅', minUsd: 150, maxUsd: 350, band: '$150–350' },
  { id: 'base', title: 'Base', emoji: '③', minUsd: 50, maxUsd: 150, band: '$50–150' },
  { id: 'low', title: 'Low', emoji: '②', minUsd: 25, maxUsd: 50, band: '$25–50' },
  { id: 'micro', title: 'Micro', emoji: '①', minUsd: 1, maxUsd: 25, band: '$1–25' },
];

const TIER_BY_ID = new Map<SpenderTierId, SpenderTier>(
  SPENDER_TIERS.map((tier) => [tier.id, tier]),
);

const USD_WHOLE_FORMATTER = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

export function getSpenderTier(id: SpenderTierId): SpenderTier {
  const tier = TIER_BY_ID.get(id);
  if (tier === undefined) {
    throw new Error(`Unknown spender tier: ${id}`);
  }
  return tier;
}

/** Tier for a lifetime spend, or null when below the micro floor ($1). */
export function assignSpenderTier(lifetimeUsd: number): SpenderTierId | null {
  if (!Number.isFinite(lifetimeUsd) || lifetimeUsd < SPENDER_TIERS[SPENDER_TIERS.length - 1]!.minUsd) {
    return null;
  }
  for (const tier of SPENDER_TIERS) {
    if (lifetimeUsd >= tier.minUsd && (tier.maxUsd === null || lifetimeUsd < tier.maxUsd)) {
      return tier.id;
    }
  }
  return null;
}

export interface SpenderLike {
  lifetimeUsd: number;
}

export interface SpenderTierGroup<T extends SpenderLike> {
  tier: SpenderTier;
  entries: T[];
}

/** Highest spender first; ties break by a stable id when provided. */
export function compareByLifetimeDesc(
  a: SpenderLike & { fanAccountId?: string },
  b: SpenderLike & { fanAccountId?: string },
): number {
  if (a.lifetimeUsd !== b.lifetimeUsd) return b.lifetimeUsd - a.lifetimeUsd;
  const aId = a.fanAccountId ?? '';
  const bId = b.fanAccountId ?? '';
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

export function sortByLifetimeDesc<T extends SpenderLike & { fanAccountId?: string }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort(compareByLifetimeDesc);
}

/**
 * Group spenders into tier sections in tier order, dropping empty tiers and
 * anything below the micro floor. Each section is sorted highest-first.
 */
export function groupSpendersByTier<T extends SpenderLike & { fanAccountId?: string }>(
  entries: readonly T[],
): SpenderTierGroup<T>[] {
  const byTier = new Map<SpenderTierId, T[]>();
  for (const entry of entries) {
    const tierId = assignSpenderTier(entry.lifetimeUsd);
    if (tierId === null) continue;
    const bucket = byTier.get(tierId);
    if (bucket === undefined) {
      byTier.set(tierId, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  const groups: SpenderTierGroup<T>[] = [];
  for (const tier of SPENDER_TIERS) {
    const bucket = byTier.get(tier.id);
    if (bucket !== undefined && bucket.length > 0) {
      groups.push({ tier, entries: sortByLifetimeDesc(bucket) });
    }
  }
  return groups;
}

/** Count entries per tier (for chip badges). `all` includes every positive
 * finite loaded spender, including the below-$1 rows shown outside the named
 * tiers. */
export function countByTier(entries: readonly SpenderLike[]): {
  all: number;
  byTier: Record<SpenderTierId, number>;
} {
  const byTier: Record<SpenderTierId, number> = {
    whale: 0,
    top: 0,
    prime: 0,
    base: 0,
    low: 0,
    micro: 0,
  };
  let all = 0;
  for (const entry of entries) {
    if (!Number.isFinite(entry.lifetimeUsd) || entry.lifetimeUsd <= 0) continue;
    all += 1;
    const tierId = assignSpenderTier(entry.lifetimeUsd);
    if (tierId === null) continue;
    byTier[tierId] += 1;
  }
  return { all, byTier };
}

/** '$1,078' — rounded whole dollars with thousands separators (no cents). */
export function formatSpenderAmount(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '';
  const rounded = Math.round(usd);
  return `$${USD_WHOLE_FORMATTER.format(rounded)}`;
}

function formatExactMills(mills: number): string {
  const wholeDollars = Math.floor(mills / 1000);
  const exactMills = String(mills % 1000).padStart(3, '0');
  const fraction = exactMills.replace(/0+$/, '').padEnd(2, '0');
  return `$${USD_WHOLE_FORMATTER.format(wholeDollars)}.${fraction}`;
}

/** Compact lifetime amount without visually crossing a tier boundary.
 *
 * Tiers are assigned from the exact kernel mills. Most rows still use the
 * whole-dollar display, but a value such as 599_600 mills must not render as
 * "$600" while correctly remaining in Top. In that narrow boundary case we
 * retain two or three decimal digits from the integer mills. */
export function formatTierAwareSpenderAmount(lifetimeMills: number): string {
  if (!Number.isFinite(lifetimeMills) || lifetimeMills <= 0) return '';
  const mills = Math.round(lifetimeMills);
  if (mills < 1000) return formatExactMills(mills);
  const usd = mills / 1000;
  const roundedUsd = Math.round(usd);
  if (assignSpenderTier(usd) === assignSpenderTier(roundedUsd)) {
    return formatSpenderAmount(usd);
  }

  return formatExactMills(mills);
}

/** First purchase landed inside the month window: lifetime ≈ month spend.
 * (Desktop reference: isNewSpender over its 30-day retained window.) */
export const NEW_SPENDER_EPSILON_USD = 1;

export function isNewSpender(lifetimeUsd: number, monthUsd: number | null): boolean {
  return (
    monthUsd !== null &&
    Number.isFinite(monthUsd) &&
    monthUsd > 0 &&
    Number.isFinite(lifetimeUsd) &&
    monthUsd <= lifetimeUsd &&
    lifetimeUsd - monthUsd < NEW_SPENDER_EPSILON_USD
  );
}

/** '+$123' for a positive month-to-date figure; '' when unknown or when the
 * amount rounds below a whole dollar (a "+$0" chip would be noise). */
export function formatMonthDelta(monthUsd: number | null): string {
  if (monthUsd === null || !Number.isFinite(monthUsd) || Math.round(monthUsd) < 1) {
    return '';
  }
  return `+${formatSpenderAmount(monthUsd)}`;
}

/** Case-insensitive substring match over the chatter's custom name, display
 * name, and username. An empty/blank query keeps every entry. */
export function filterSpendersByQuery<
  T extends {
    fanAccountId?: string;
    displayName: string | null;
    username: string | null;
    customName?: string | null;
  },
>(entries: readonly T[], query: string): T[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...entries];
  return entries.filter(
    (entry) =>
      (entry.customName ?? '').toLowerCase().includes(needle) ||
      (entry.displayName ?? '').toLowerCase().includes(needle) ||
      (entry.username ?? '').toLowerCase().includes(needle) ||
      (entry.fanAccountId ?? '').toLowerCase().includes(needle),
  );
}

/** The kernel's month-window key ('YYYY-MM', UTC calendar month) for a
 * timestamp — the projection buckets monthly earnings by calendar month. */
export function monthWindowFor(epochMs: number): string {
  const date = new Date(epochMs);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}`;
}
