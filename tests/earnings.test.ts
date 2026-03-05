import { describe, expect, it } from 'vitest';
import {
  aggregateEarnings,
  aggregateMonthlyEarnings,
  formatFanSpendingData,
  millsToUsd,
  monthWindowMs,
} from '../src/shared/earnings.js';
import type { AggregatedEarnings, EarningsRow, MonthlyEarningsRow } from '../src/shared/types.js';

const FAN_ID = 'fan-account-789';
const WINDOW_START = 1700000000000;
const WINDOW_END = 1700086400000;

function makeRow(overrides: Partial<EarningsRow> = {}): EarningsRow {
  return {
    type: 2110,
    totalGross: 10000,
    totalNet: 8000,
    accountId: 'model-1',
    correlationAccountId: FAN_ID,
    timestamp: 1700000000,
    ...overrides,
  };
}

describe('millsToUsd', () => {
  it('converts 10000 mills to $10.00', () => {
    expect(millsToUsd(10000)).toBe('10.00');
  });

  it('converts 500 mills to $0.50', () => {
    expect(millsToUsd(500)).toBe('0.50');
  });

  it('converts 1500 mills to $1.50', () => {
    expect(millsToUsd(1500)).toBe('1.50');
  });

  it('converts 0 mills to $0.00', () => {
    expect(millsToUsd(0)).toBe('0.00');
  });
});

describe('aggregateEarnings', () => {
  it('returns zero totals and empty breakdown for empty rows', () => {
    const result = aggregateEarnings([], FAN_ID, WINDOW_START, WINDOW_END);
    expect(result.totalGross).toBe(0);
    expect(result.totalNet).toBe(0);
    expect(result.breakdown).toEqual([]);
    expect(result.correlationAccountId).toBe(FAN_ID);
  });

  it('aggregates multiple rows of the same type', () => {
    const rows = [
      makeRow({ totalGross: 10000, totalNet: 8000 }),
      makeRow({ totalGross: 15000, totalNet: 12000 }),
    ];
    const result = aggregateEarnings(rows, FAN_ID, WINDOW_START, WINDOW_END);
    expect(result.totalGross).toBe(25000);
    expect(result.totalNet).toBe(20000);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0]!.gross).toBe(25000);
  });

  it('sorts breakdown by gross descending', () => {
    const rows = [
      makeRow({ type: 2110, totalGross: 10000, totalNet: 8000 }),
      makeRow({ type: 7101, totalGross: 50000, totalNet: 40000 }),
      makeRow({ type: 15001, totalGross: 5000, totalNet: 4000 }),
    ];
    const result = aggregateEarnings(rows, FAN_ID, WINDOW_START, WINDOW_END);
    expect(result.breakdown[0]!.type).toBe(7101);
    expect(result.breakdown[1]!.type).toBe(2110);
    expect(result.breakdown[2]!.type).toBe(15001);
  });

  it('uses known labels for known types', () => {
    const rows = [makeRow({ type: 2110 })];
    const result = aggregateEarnings(rows, FAN_ID, WINDOW_START, WINDOW_END);
    expect(result.breakdown[0]!.label).toBe('Subscription');
  });

  it('uses "Unknown (type XXXX)" for unknown types', () => {
    const rows = [makeRow({ type: 9999 })];
    const result = aggregateEarnings(rows, FAN_ID, WINDOW_START, WINDOW_END);
    expect(result.breakdown[0]!.label).toBe('Unknown (type 9999)');
  });

  it('includes ISO timestamps from window', () => {
    const result = aggregateEarnings([], FAN_ID, WINDOW_START, WINDOW_END);
    expect(result.windowStartIso).toBe(new Date(WINDOW_START).toISOString());
    expect(result.windowEndIso).toBe(new Date(WINDOW_END).toISOString());
  });
});

describe('formatFanSpendingData', () => {
  it('formats header and totals for empty breakdown', () => {
    const aggregated = aggregateEarnings([], FAN_ID, WINDOW_START, WINDOW_END);
    const result = formatFanSpendingData(aggregated);
    expect(result).toContain('FAN SPENDING DATA:');
    expect(result).toContain(`Correlation account ID: ${FAN_ID}`);
    expect(result).toContain('Total gross (all-time): $0.00');
    expect(result).toContain('Total net (all-time): $0.00');
    expect(result).not.toContain('Type breakdown');
  });

  it('formats breakdown lines with labels and gross amounts', () => {
    const rows = [
      makeRow({ type: 7101, totalGross: 50000, totalNet: 40000 }),
      makeRow({ type: 2110, totalGross: 10000, totalNet: 8000 }),
    ];
    const aggregated = aggregateEarnings(rows, FAN_ID, WINDOW_START, WINDOW_END);
    const result = formatFanSpendingData(aggregated);
    expect(result).toContain('Total gross (all-time): $60.00');
    expect(result).toContain('Total net (all-time): $48.00');
    expect(result).toContain('- Tip or media purchase: $50.00');
    expect(result).toContain('- Subscription: $10.00');
  });

  it('includes monthly totals when present', () => {
    const aggregated: AggregatedEarnings = {
      ...aggregateEarnings([], FAN_ID, WINDOW_START, WINDOW_END),
      monthlyTotals: [
        { year: 2026, month: 2, totalGross: 195000, totalNet: 156000 },
        { year: 2026, month: 1, totalGross: 400000, totalNet: 320000 },
      ],
    };
    const result = formatFanSpendingData(aggregated);
    expect(result).toContain('Monthly totals:');
    expect(result).toContain('- Feb 2026: $195.00');
    expect(result).toContain('- Jan 2026: $400.00');
  });

  it('includes monthly breakdowns for deep features', () => {
    const aggregated: AggregatedEarnings = {
      ...aggregateEarnings([], FAN_ID, WINDOW_START, WINDOW_END),
      monthlyTotals: [],
      monthlyBreakdowns: [
        {
          year: 2026,
          month: 2,
          breakdown: [
            { label: 'Subscription', type: 2110, gross: 45000, net: 36000 },
            { label: 'Tip or media purchase', type: 7101, gross: 150000, net: 120000 },
          ],
        },
      ],
    };
    const result = formatFanSpendingData(aggregated);
    expect(result).toContain('Monthly breakdown by type:');
    expect(result).toContain('- Feb 2026: Subscription $45.00, Tip or media purchase $150.00');
  });

  it('shows partial note when monthlyBreakdownsPartial is set', () => {
    const aggregated: AggregatedEarnings = {
      ...aggregateEarnings([], FAN_ID, WINDOW_START, WINDOW_END),
      monthlyTotals: [],
      monthlyBreakdowns: [
        {
          year: 2026,
          month: 2,
          breakdown: [
            { label: 'Subscription', type: 2110, gross: 45000, net: 36000 },
          ],
        },
      ],
      monthlyBreakdownsPartial: true,
    };
    const result = formatFanSpendingData(aggregated);
    expect(result).toContain('(some months could not be fetched)');
  });

  it('shows partial note even when all per-month breakdowns failed', () => {
    const aggregated: AggregatedEarnings = {
      ...aggregateEarnings([], FAN_ID, WINDOW_START, WINDOW_END),
      monthlyTotals: [],
      monthlyBreakdowns: [],
      monthlyBreakdownsPartial: true,
    };
    const result = formatFanSpendingData(aggregated);
    expect(result).not.toContain('Monthly breakdown by type:');
    expect(result).toContain('(some months could not be fetched)');
  });

  it('omits monthly breakdown section when not provided', () => {
    const aggregated = aggregateEarnings(
      [makeRow({ totalGross: 10000, totalNet: 8000 })],
      FAN_ID,
      WINDOW_START,
      WINDOW_END,
    );
    const result = formatFanSpendingData(aggregated);
    expect(result).not.toContain('Monthly breakdown by type:');
  });
});

describe('aggregateMonthlyEarnings', () => {
  it('returns empty array for empty input', () => {
    expect(aggregateMonthlyEarnings([])).toEqual([]);
  });

  it('sorts by year/month descending', () => {
    const rows: MonthlyEarningsRow[] = [
      { year: 2025, month: 6, totalGross: 100, totalNet: 80, accountId: 'a', correlationAccountId: 'b', timestamp: 1 },
      { year: 2026, month: 2, totalGross: 200, totalNet: 160, accountId: 'a', correlationAccountId: 'b', timestamp: 2 },
      { year: 2026, month: 1, totalGross: 300, totalNet: 240, accountId: 'a', correlationAccountId: 'b', timestamp: 3 },
    ];
    const result = aggregateMonthlyEarnings(rows);
    expect(result).toEqual([
      { year: 2026, month: 2, totalGross: 200, totalNet: 160 },
      { year: 2026, month: 1, totalGross: 300, totalNet: 240 },
      { year: 2025, month: 6, totalGross: 100, totalNet: 80 },
    ]);
  });
});

describe('monthWindowMs', () => {
  it('returns correct UTC boundaries for a month', () => {
    const { start, end } = monthWindowMs(2026, 2);
    expect(start).toBe(Date.UTC(2026, 1, 1));
    expect(end).toBe(Date.UTC(2026, 2, 1));
  });

  it('handles December → January boundary', () => {
    const { start, end } = monthWindowMs(2025, 12);
    expect(start).toBe(Date.UTC(2025, 11, 1));
    expect(end).toBe(Date.UTC(2026, 0, 1));
  });
});
