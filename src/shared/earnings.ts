import type { AggregatedEarnings, EarningsRow } from './types.js';

const LABELS: Record<number, string> = {
  2110: 'Subscription',
  2116: 'Subscription renewal',
  7101: 'Tip or media purchase',
  15001: 'Message tip / paid message',
};

export function millsToUsd(value: number): string {
  return (value / 1000).toFixed(2);
}

export function aggregateEarnings(
  rows: EarningsRow[],
  correlationAccountId: string,
  windowStartMs: number,
  windowEndMs: number,
): AggregatedEarnings {
  const breakdownMap = new Map<number, { gross: number; net: number }>();

  for (const row of rows) {
    const current = breakdownMap.get(row.type) ?? { gross: 0, net: 0 };
    current.gross += row.totalGross;
    current.net += row.totalNet;
    breakdownMap.set(row.type, current);
  }

  const breakdown = Array.from(breakdownMap.entries())
    .map(([type, totals]) => ({
      label: LABELS[type] ?? `Unknown (type ${type})`,
      type,
      gross: totals.gross,
      net: totals.net,
    }))
    .sort((left, right) => right.gross - left.gross);

  const totalGross = breakdown.reduce((sum, entry) => sum + entry.gross, 0);
  const totalNet = breakdown.reduce((sum, entry) => sum + entry.net, 0);

  return {
    correlationAccountId,
    windowStartIso: new Date(windowStartMs).toISOString(),
    windowEndIso: new Date(windowEndMs).toISOString(),
    totalGross,
    totalNet,
    breakdown,
  };
}

export function formatFanSpendingData(aggregated: AggregatedEarnings): string {
  const header = [
    'FAN SPENDING DATA:',
    `Window: ${aggregated.windowStartIso} to ${aggregated.windowEndIso} (UTC)`,
    'Source: /api/v1/account/wallets/earnings/stats/accounts',
    `Correlation account ID: ${aggregated.correlationAccountId}`,
    `Total gross: $${millsToUsd(aggregated.totalGross)}`,
    `Total net: $${millsToUsd(aggregated.totalNet)}`,
  ];

  if (aggregated.breakdown.length === 0) {
    return `${header.join('\n')}\nBreakdown: none`;
  }

  const lines = aggregated.breakdown.map((entry) => `- ${entry.label}: $${millsToUsd(entry.gross)}`);
  return `${header.join('\n')}\nBreakdown:\n${lines.join('\n')}`;
}
