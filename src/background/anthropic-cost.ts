import type {
  AnthropicCostEstimate,
  AnthropicSpendSummary,
  AnthropicUsageMetrics,
} from '../shared/types.js';

interface AnthropicPricing {
  inputUsdPerMillion: number;
  cacheWrite5mUsdPerMillion: number;
  cacheWrite1hUsdPerMillion: number;
  cacheReadUsdPerMillion: number;
  outputUsdPerMillion: number;
}

const USD_PRECISION = 1_000_000;
const TOKENS_PER_MILLION = 1_000_000;

const MODEL_PRICING: Record<string, AnthropicPricing> = {
  'claude-sonnet-4-5': {
    inputUsdPerMillion: 3,
    cacheWrite5mUsdPerMillion: 3.75,
    cacheWrite1hUsdPerMillion: 6,
    cacheReadUsdPerMillion: 0.30,
    outputUsdPerMillion: 15,
  },
  'claude-sonnet-4-6': {
    inputUsdPerMillion: 3,
    cacheWrite5mUsdPerMillion: 3.75,
    cacheWrite1hUsdPerMillion: 6,
    cacheReadUsdPerMillion: 0.30,
    outputUsdPerMillion: 15,
  },
  'claude-sonnet-4': {
    inputUsdPerMillion: 3,
    cacheWrite5mUsdPerMillion: 3.75,
    cacheWrite1hUsdPerMillion: 6,
    cacheReadUsdPerMillion: 0.30,
    outputUsdPerMillion: 15,
  },
  'claude-opus-4-5': {
    inputUsdPerMillion: 15,
    cacheWrite5mUsdPerMillion: 18.75,
    cacheWrite1hUsdPerMillion: 30,
    cacheReadUsdPerMillion: 1.50,
    outputUsdPerMillion: 75,
  },
  'claude-opus-4-6': {
    inputUsdPerMillion: 15,
    cacheWrite5mUsdPerMillion: 18.75,
    cacheWrite1hUsdPerMillion: 30,
    cacheReadUsdPerMillion: 1.50,
    outputUsdPerMillion: 75,
  },
  'claude-haiku-4-5': {
    inputUsdPerMillion: 1,
    cacheWrite5mUsdPerMillion: 1.25,
    cacheWrite1hUsdPerMillion: 2,
    cacheReadUsdPerMillion: 0.10,
    outputUsdPerMillion: 5,
  },
  'claude-3-5-haiku': {
    inputUsdPerMillion: 0.8,
    cacheWrite5mUsdPerMillion: 1,
    cacheWrite1hUsdPerMillion: 1.6,
    cacheReadUsdPerMillion: 0.08,
    outputUsdPerMillion: 4,
  },
};

function roundUsd(value: number): number {
  return Math.round((value + Number.EPSILON) * USD_PRECISION) / USD_PRECISION;
}

function priceTokens(tokens: number, usdPerMillion: number): number {
  return roundUsd((Math.max(0, tokens) * usdPerMillion) / TOKENS_PER_MILLION);
}

function resolvePricing(modelId: string): AnthropicPricing {
  const pricing = MODEL_PRICING[modelId];
  if (!pricing) {
    throw new Error(`Unsupported Anthropic model for cost estimation: ${modelId}`);
  }
  return pricing;
}

function resolveCacheWriteTokens(
  usage: AnthropicUsageMetrics,
): {
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  approximate: boolean;
} {
  const totalCacheWriteTokens = Math.max(0, usage.cache_creation_input_tokens);
  const cacheCreation = usage.cache_creation;
  if (!cacheCreation) {
    return {
      cacheWrite5mTokens: totalCacheWriteTokens,
      cacheWrite1hTokens: 0,
      approximate: totalCacheWriteTokens > 0,
    };
  }

  const raw5mTokens = Math.max(0, cacheCreation.ephemeral_5m_input_tokens ?? 0);
  const raw1hTokens = Math.max(0, cacheCreation.ephemeral_1h_input_tokens ?? 0);
  const accountedTokens = raw5mTokens + raw1hTokens;

  if (accountedTokens === totalCacheWriteTokens) {
    return {
      cacheWrite5mTokens: raw5mTokens,
      cacheWrite1hTokens: raw1hTokens,
      approximate: false,
    };
  }

  if (accountedTokens < totalCacheWriteTokens) {
    return {
      cacheWrite5mTokens: raw5mTokens + (totalCacheWriteTokens - accountedTokens),
      cacheWrite1hTokens: raw1hTokens,
      approximate: true,
    };
  }

  const cacheWrite1hTokens = Math.min(raw1hTokens, totalCacheWriteTokens);
  return {
    cacheWrite5mTokens: Math.max(0, totalCacheWriteTokens - cacheWrite1hTokens),
    cacheWrite1hTokens,
    approximate: true,
  };
}

export function estimateAnthropicCost(
  modelId: string,
  usage: AnthropicUsageMetrics,
): AnthropicCostEstimate {
  const pricing = resolvePricing(modelId);

  const { cacheWrite5mTokens, cacheWrite1hTokens, approximate } =
    resolveCacheWriteTokens(usage);
  const inputUsd = priceTokens(usage.input_tokens, pricing.inputUsdPerMillion);
  const cacheWrite5mUsd = priceTokens(
    cacheWrite5mTokens,
    pricing.cacheWrite5mUsdPerMillion,
  );
  const cacheWrite1hUsd = priceTokens(
    cacheWrite1hTokens,
    pricing.cacheWrite1hUsdPerMillion,
  );
  const cacheReadUsd = priceTokens(
    usage.cache_read_input_tokens,
    pricing.cacheReadUsdPerMillion,
  );
  const outputUsd = priceTokens(usage.output_tokens, pricing.outputUsdPerMillion);

  return {
    modelId,
    inputUsd,
    cacheWrite5mUsd,
    cacheWrite1hUsd,
    cacheReadUsd,
    outputUsd,
    totalUsd: roundUsd(
      inputUsd +
      cacheWrite5mUsd +
      cacheWrite1hUsd +
      cacheReadUsd +
      outputUsd,
    ),
    approximate,
  };
}

export function buildAnthropicSpendSummary(
  modelId: string,
  usage: AnthropicUsageMetrics,
  cost?: AnthropicCostEstimate,
): AnthropicSpendSummary {
  const resolvedCost = cost ?? estimateAnthropicCost(modelId, usage);
  const pricing = resolvePricing(modelId);
  const baselineInputTokens =
    usage.input_tokens +
    usage.cache_creation_input_tokens +
    usage.cache_read_input_tokens;
  const uncachedInputUsd = priceTokens(
    baselineInputTokens,
    pricing.inputUsdPerMillion,
  );
  const uncachedUsd = roundUsd(uncachedInputUsd + resolvedCost.outputUsd);
  const rawCacheEffectUsd = roundUsd(Math.abs(uncachedUsd - resolvedCost.totalUsd));
  const cacheEffectKind =
    uncachedUsd > resolvedCost.totalUsd
      ? 'saved'
      : uncachedUsd < resolvedCost.totalUsd
        ? 'overhead'
        : 'neutral';

  return {
    totalTokens:
      usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens +
      usage.output_tokens,
    inputTokens: usage.input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    outputTokens: usage.output_tokens,
    totalUsd: resolvedCost.totalUsd,
    uncachedUsd,
    cacheEffectUsd: rawCacheEffectUsd,
    cacheEffectKind,
    cacheWriteUsd: roundUsd(
      resolvedCost.cacheWrite5mUsd + resolvedCost.cacheWrite1hUsd,
    ),
    cacheReadUsd: resolvedCost.cacheReadUsd,
    approximate: resolvedCost.approximate,
  };
}

export function createZeroAnthropicSpendSummary(): AnthropicSpendSummary {
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

export function formatAnthropicCostLog(cost: AnthropicCostEstimate): string {
  return `Claude cost: model=${cost.modelId}, total_usd=${cost.totalUsd.toFixed(6)}, input_usd=${cost.inputUsd.toFixed(6)}, cache_write_5m_usd=${cost.cacheWrite5mUsd.toFixed(6)}, cache_write_1h_usd=${cost.cacheWrite1hUsd.toFixed(6)}, cache_read_usd=${cost.cacheReadUsd.toFixed(6)}, output_usd=${cost.outputUsd.toFixed(6)}, approximate=${cost.approximate}`;
}
