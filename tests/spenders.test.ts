import { describe, expect, it } from 'vitest';
import {
  assignSpenderTier,
  countByTier,
  formatSpenderAmount,
  groupSpendersByTier,
  SPENDER_TIERS,
  sortByLifetimeDesc,
} from '../src/shared/spenders.js';

interface Row {
  fanAccountId: string;
  lifetimeUsd: number;
}

function row(fanAccountId: string, lifetimeUsd: number): Row {
  return { fanAccountId, lifetimeUsd };
}

describe('assignSpenderTier', () => {
  it('maps amounts to the correct tier band', () => {
    expect(assignSpenderTier(1078)).toBe('whale');
    expect(assignSpenderTier(600)).toBe('whale');
    expect(assignSpenderTier(599.99)).toBe('top');
    expect(assignSpenderTier(350)).toBe('top');
    expect(assignSpenderTier(349)).toBe('prime');
    expect(assignSpenderTier(150)).toBe('prime');
    expect(assignSpenderTier(149)).toBe('base');
    expect(assignSpenderTier(50)).toBe('base');
    expect(assignSpenderTier(49)).toBe('low');
    expect(assignSpenderTier(25)).toBe('low');
    expect(assignSpenderTier(24)).toBe('micro');
    expect(assignSpenderTier(1)).toBe('micro');
  });

  it('returns null below the micro floor or for junk', () => {
    expect(assignSpenderTier(0.5)).toBeNull();
    expect(assignSpenderTier(0)).toBeNull();
    expect(assignSpenderTier(-10)).toBeNull();
    expect(assignSpenderTier(Number.NaN)).toBeNull();
  });

  it('every tier resolves within its own band', () => {
    for (const tier of SPENDER_TIERS) {
      expect(assignSpenderTier(tier.minUsd)).toBe(tier.id);
    }
  });
});

describe('groupSpendersByTier', () => {
  it('orders tiers highest-first, sorts within a tier, and drops empties + untiered', () => {
    const rows: Row[] = [
      row('a', 700),
      row('b', 650),
      row('c', 0.2), // below floor → dropped
      row('d', 200),
      row('e', 40),
    ];
    const groups = groupSpendersByTier(rows);
    expect(groups.map((g) => g.tier.id)).toEqual(['whale', 'prime', 'low']);
    expect(groups[0]!.entries.map((r) => r.fanAccountId)).toEqual(['a', 'b']);
  });

  it('breaks lifetime ties deterministically by id', () => {
    const sorted = sortByLifetimeDesc([row('z', 100), row('a', 100)]);
    expect(sorted.map((r) => r.fanAccountId)).toEqual(['a', 'z']);
  });
});

describe('countByTier', () => {
  it('tallies per tier and the grand total, ignoring untiered', () => {
    const result = countByTier([row('a', 700), row('b', 400), row('c', 0)]);
    expect(result.all).toBe(2);
    expect(result.byTier.whale).toBe(1);
    expect(result.byTier.top).toBe(1);
    expect(result.byTier.micro).toBe(0);
  });
});

describe('formatSpenderAmount', () => {
  it('renders whole dollars with thousands separators', () => {
    expect(formatSpenderAmount(1078)).toBe('$1,078');
    expect(formatSpenderAmount(1022.4)).toBe('$1,022');
    expect(formatSpenderAmount(718)).toBe('$718');
    expect(formatSpenderAmount(1234567)).toBe('$1,234,567');
  });

  it('renders nothing for zero/unknown', () => {
    expect(formatSpenderAmount(0)).toBe('');
    expect(formatSpenderAmount(-5)).toBe('');
    expect(formatSpenderAmount(Number.NaN)).toBe('');
  });
});
