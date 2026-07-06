// Stage 32: spend summaries post-cutover. The local price tables died with
// the vendor clients — the kernel gateway prices every generation (Stage 29
// tables) and reports costMicroUsd on the usage frame; this module keeps the
// panel's LlmSpendSummary shape alive from that single source.

import type { LlmSpendSummary } from './types.js';

export interface KernelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costMicroUsd: number;
  costApproximate: boolean;
}

export function createZeroLlmSpendSummary(): LlmSpendSummary {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    totalUsd: 0,
    uncachedUsd: 0,
    cacheEffectUsd: 0,
    cacheEffectKind: 'neutral',
    cacheWriteUsd: 0,
    cacheReadUsd: 0,
    approximate: false,
  };
}

/** Gateway-priced summary: totals are authoritative; the cache-effect
 * decomposition needs per-token price tables the client no longer has, so
 * those fields read neutral/zero (the panel hides zero effects). */
export function buildKernelSpendSummary(usage: KernelUsage): LlmSpendSummary {
  const totalUsd = usage.costMicroUsd / 1_000_000;
  return {
    totalTokens:
      usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens + usage.outputTokens,
    inputTokens: usage.inputTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheReadTokens: usage.cacheReadTokens,
    outputTokens: usage.outputTokens,
    totalUsd,
    uncachedUsd: totalUsd,
    cacheEffectUsd: 0,
    cacheEffectKind: 'neutral',
    cacheWriteUsd: 0,
    cacheReadUsd: 0,
    approximate: usage.costApproximate,
  };
}

export function formatKernelUsageLog(model: string, usage: KernelUsage): string {
  return `${model}: ${usage.inputTokens} in / ${usage.outputTokens} out `
    + `(cache ${usage.cacheWriteTokens}w/${usage.cacheReadTokens}r)`;
}
