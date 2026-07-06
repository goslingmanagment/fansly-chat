import type {
  AggregatedEarnings,
  EarningsBreakdownEntry,
  EarningsRow,
  MonthlyEarningsRow,
  MonthlyEarningsTotal,
} from './types.js';

const LABELS: Record<number, string> = {
  2110: 'Subscription',
  2116: 'Subscription renewal',
  7101: 'Tip or media purchase',
  15001: 'Message tip / paid message',
};

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function millsToUsd(value: number): string {
  return (value / 1000).toFixed(2);
}

export function monthWindowMs(year: number, month: number): { start: number; end: number } {
  const start = Date.UTC(year, month - 1, 1);
  const end = Date.UTC(year, month, 1);
  return { start, end };
}

export function aggregateMonthlyEarnings(rows: MonthlyEarningsRow[]): MonthlyEarningsTotal[] {
  return rows
    .map((row) => ({
      year: row.year,
      month: row.month,
      totalGross: row.totalGross,
      totalNet: row.totalNet,
    }))
    .sort((a, b) => b.year - a.year || b.month - a.month);
}

function buildBreakdownMap(rows: EarningsRow[]): Map<number, { gross: number; net: number }> {
  const map = new Map<number, { gross: number; net: number }>();
  for (const row of rows) {
    const current = map.get(row.type) ?? { gross: 0, net: 0 };
    current.gross += row.totalGross;
    current.net += row.totalNet;
    map.set(row.type, current);
  }
  return map;
}

function breakdownFromMap(map: Map<number, { gross: number; net: number }>): EarningsBreakdownEntry[] {
  return Array.from(map.entries())
    .map(([type, totals]) => ({
      label: LABELS[type] ?? `Unknown (type ${type})`,
      type,
      gross: totals.gross,
      net: totals.net,
    }))
    .sort((left, right) => right.gross - left.gross);
}

export function aggregateEarnings(
  rows: EarningsRow[],
  correlationAccountId: string,
  windowStartMs: number,
  windowEndMs: number,
): AggregatedEarnings {
  const breakdown = breakdownFromMap(buildBreakdownMap(rows));
  const totalGross = breakdown.reduce((sum, entry) => sum + entry.gross, 0);
  const totalNet = breakdown.reduce((sum, entry) => sum + entry.net, 0);

  return {
    correlationAccountId,
    windowStartIso: new Date(windowStartMs).toISOString(),
    windowEndIso: new Date(windowEndMs).toISOString(),
    totalGross,
    totalNet,
    breakdown,
    monthlyTotals: [],
  };
}

function formatMonthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function formatBreakdownLine(entry: EarningsBreakdownEntry): string {
  return `${entry.label} $${millsToUsd(entry.gross)}`;
}

export function formatFanSpendingData(aggregated: AggregatedEarnings): string {
  const lines: string[] = [
    'FAN SPENDING DATA:',
    `Correlation account ID: ${aggregated.correlationAccountId}`,
    `Total gross (all-time): $${millsToUsd(aggregated.totalGross)}`,
    `Total net (all-time): $${millsToUsd(aggregated.totalNet)}`,
  ];

  if (aggregated.breakdown.length > 0) {
    lines.push('Type breakdown (all-time):');
    for (const entry of aggregated.breakdown) {
      lines.push(`- ${entry.label}: $${millsToUsd(entry.gross)}`);
    }
  }

  if (aggregated.monthlyTotals.length > 0) {
    lines.push('Monthly totals:');
    for (const m of aggregated.monthlyTotals) {
      lines.push(`- ${formatMonthLabel(m.year, m.month)}: $${millsToUsd(m.totalGross)}`);
    }
  }

  if (aggregated.monthlyBreakdowns && aggregated.monthlyBreakdowns.length > 0) {
    lines.push('Monthly breakdown by type:');
    for (const mb of aggregated.monthlyBreakdowns) {
      if (mb.breakdown.length > 0) {
        lines.push(`- ${formatMonthLabel(mb.year, mb.month)}: ${mb.breakdown.map(formatBreakdownLine).join(', ')}`);
      }
    }
  }
  if (aggregated.monthlyBreakdownsPartial) {
    lines.push('(some months could not be fetched)');
  }

  return lines.join('\n');
}
