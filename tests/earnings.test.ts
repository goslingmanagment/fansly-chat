import { describe, expect, it } from 'vitest';
import { millsToUsd, aggregateEarnings, formatFanSpendingData } from '../src/shared/earnings.js';
import type { EarningsRow } from '../src/shared/types.js';

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
  it('returns "Breakdown: none" for empty breakdown', () => {
    const aggregated = aggregateEarnings([], FAN_ID, WINDOW_START, WINDOW_END);
    const result = formatFanSpendingData(aggregated);
    expect(result).toContain('FAN SPENDING DATA:');
    expect(result).toContain(`Correlation account ID: ${FAN_ID}`);
    expect(result).toContain('Total gross: $0.00');
    expect(result).toContain('Total net: $0.00');
    expect(result).toContain('Breakdown: none');
  });

  it('formats breakdown lines with labels and gross amounts', () => {
    const rows = [
      makeRow({ type: 7101, totalGross: 50000, totalNet: 40000 }),
      makeRow({ type: 2110, totalGross: 10000, totalNet: 8000 }),
    ];
    const aggregated = aggregateEarnings(rows, FAN_ID, WINDOW_START, WINDOW_END);
    const result = formatFanSpendingData(aggregated);
    expect(result).toContain('Total gross: $60.00');
    expect(result).toContain('Total net: $48.00');
    expect(result).toContain('- Tip or media purchase: $50.00');
    expect(result).toContain('- Subscription: $10.00');
  });

  it('includes Source and Window fields', () => {
    const aggregated = aggregateEarnings([], FAN_ID, WINDOW_START, WINDOW_END);
    const result = formatFanSpendingData(aggregated);
    expect(result).toContain('Source: /api/v1/account/wallets/earnings/stats/accounts');
    expect(result).toContain('Window:');
  });
});
