import { formatExactMills } from './spenders.js';

/** One way into the partner's DMs. Any one rule set satisfied is enough. */
export interface FanslyDmPermissionRule {
  flags?: number;
  verificationFlags?: number;
  /** JSON object keyed by flag; each value is a JSON string of its own. */
  metadata?: string | null;
  verificationMetadata?: string | null;
}
/** What this account already has toward the partner (tips sent, price paid). */
export interface FanslyDmPermissionAccount { flags?: number; metadata?: string | null }
export interface DmRequirement {
  /** Fansly's bits: 1 price per message, 2 follow the fan, 4 subscribe to the
   * fan, 8 tips, 16 followed by the fan, 32 media purchases, 64 subscribed by
   * the fan, 128 on the fan's list. */
  flags: number;
  /** Mills per message; null when the rule names a price Fansly's own reader
   * could not read. */
  price: number | null;
}

function parse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;
/** Fansly's verifyTipMetdata / verifyMediaPurchasesMetdata: what is still missing. */
function missing(rule: unknown, have: unknown, field: 'totalSent' | 'totalPurchased'): number {
  const needed = amount(parse(rule)?.minAmount);
  return needed ? needed - amount(parse(have)?.[field]) : 0;
}
/** Fansly's verifyPriceMetdata. A null price passes there (`0 >= null`); an
 * unreadable rule throws and a missing price stays unmet. Here both are an
 * unmet price of unknown size, never a free chat. */
function unpaidPrice(rule: unknown, paid: unknown): number | null {
  const price = parse(rule)?.price;
  if (price === null) return 0;
  if (typeof price !== 'number' || !Number.isFinite(price)) return null;
  return amount(parse(paid)?.price) >= price ? 0 : price;
}

/** Fansly's own answer to «may this account DM the partner?», ported from its
 * app bundle (`verifyNew`, main.2e6b96097a4bb73b.js, read 2026-10-12). The
 * group object carries the partner's rule sets and what this account already
 * has. Fansly hides its composer while the answer is not empty (E155). No
 * tip is ever attached, so a price is always unmet unless already paid. The
 * subscription-tier and list names Fansly reads there only label its own
 * screen; they never change the bits, so they are not read here. */
export function unmetDmRequirements(rules: readonly FanslyDmPermissionRule[] | null | undefined, account: FanslyDmPermissionAccount | null | undefined): DmRequirement[] {
  const have = parse(account?.metadata) ?? {};
  const unmet: DmRequirement[] = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    const flags = amount(rule?.flags);
    const meta = parse(rule?.metadata) ?? {};
    let open = flags & ~amount(rule?.verificationFlags);
    const tips = flags & 8 ? missing(meta[8], have[8], 'totalSent') : 0;
    const media = flags & 32 ? missing(meta[32], have[32], 'totalPurchased') : 0;
    const price = flags & 1 ? unpaidPrice(meta[1], have[1]) : 0;
    open = tips > 0 ? open | 8 : open & ~8;
    open = media > 0 ? open | 32 : open & ~32;
    open = price === null || price > 0 ? open | 1 : open & ~1;
    if (!open) return [];
    unmet.push({ flags: open, price: open & 1 ? price : 0 });
  }
  return unmet;
}

const CONDITIONS: Array<[number, string]> = [
  [2, 'модель подписана на фана'], [4, 'у модели платная подписка на фана'], [8, 'чаевые фану'],
  [16, 'фан подписан на модель'], [32, 'покупки у фана'], [64, 'фан — платный подписчик модели'], [128, 'модель в списке фана'],
];

/** One line for the chatter. A paid DM is the common case and names its price. */
export function describeDmRequirements(unmet: readonly DmRequirement[]): string {
  const prices = unmet.filter((requirement) => requirement.flags === 1).map((requirement) => requirement.price);
  if (prices.length) {
    const known = prices.filter((price): price is number => price !== null && price > 0);
    return known.length ? `Платная личка: ${formatExactMills(Math.round(Math.min(...known)))} за сообщение.` : 'Платная личка.';
  }
  const ways = unmet.map((requirement) => [
    ...(requirement.flags & 1 ? [requirement.price ? `оплата ${formatExactMills(Math.round(requirement.price))} за сообщение` : 'оплата за сообщение'] : []),
    ...CONDITIONS.filter(([bit]) => requirement.flags & bit).map(([, text]) => text),
  ].join(' и '));
  return `Фан закрыл личку. Fansly пускает только при условии: ${[...new Set(ways)].join(', или ')}.`;
}
