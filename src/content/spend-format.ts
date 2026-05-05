import type { LlmCostEstimate, LlmSpendSummary } from '../shared/types.js';
import { getModelDisplayName } from '../shared/model-registry.js';

export function formatCompactTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) {
    const v = n / 1000;
    return v % 1 === 0 ? `${v}k` : `${v.toFixed(1).replace(/\.0$/, '')}k`;
  }
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  const v = n / 1_000_000;
  return v % 1 === 0 ? `${v}M` : `${v.toFixed(1).replace(/\.0$/, '')}M`;
}

export function formatUsd(value: number, approximate = false): string {
  const digits = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  return `${approximate ? '~' : ''}$${value.toFixed(digits)}`;
}

export function formatSpendPrimary(spend: LlmSpendSummary): string {
  return `${formatUsd(spend.totalUsd, spend.approximate)} · ${formatCompactTokens(spend.totalTokens)} tokens`;
}

export function formatSpendSecondary(spend: LlmSpendSummary): string {
  return (
    `in ${formatCompactTokens(spend.inputTokens)} · ` +
    `write ${formatCompactTokens(spend.cacheWriteTokens)} · ` +
    `read ${formatCompactTokens(spend.cacheReadTokens)} · ` +
    `out ${formatCompactTokens(spend.outputTokens)}`
  );
}

export function formatCacheEffectInline(
  spend: LlmSpendSummary,
): { text: string; kind: 'saved' | 'overhead' } | null {
  if (spend.cacheEffectKind === 'neutral' || spend.cacheEffectUsd === 0) {
    return null;
  }
  return {
    text: `${spend.cacheEffectKind} ${formatUsd(spend.cacheEffectUsd, spend.approximate)}`,
    kind: spend.cacheEffectKind as 'saved' | 'overhead',
  };
}

export function formatLlmCostSummary(cost: LlmCostEstimate): string {
  return `total ${formatUsd(cost.totalUsd, cost.approximate)} • input ${formatUsd(
    cost.inputUsd,
    cost.approximate,
  )} • write ${formatUsd(
    cost.cacheWrite5mUsd + cost.cacheWrite1hUsd,
    cost.approximate,
  )} • read ${formatUsd(cost.cacheReadUsd, cost.approximate)} • output ${formatUsd(
    cost.outputUsd,
    cost.approximate,
  )}`;
}

export function formatModelCostLabel(cost: LlmCostEstimate): string {
  return `${getModelDisplayName(cost.modelId)} cost`;
}

export function formatModelUsageLabel(cost?: LlmCostEstimate): string {
  return cost ? `${getModelDisplayName(cost.modelId)} usage` : 'Model usage';
}
