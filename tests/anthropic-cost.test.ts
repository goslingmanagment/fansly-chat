import { describe, expect, it } from 'vitest';
import {
  buildAnthropicSpendSummary,
  estimateAnthropicCost,
} from '../src/background/anthropic-cost.js';

describe('Anthropic spend summary', () => {
  it('marks cache savings when cached reads reduce total request cost', () => {
    const usage = {
      input_tokens: 100,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
      output_tokens: 8,
    };

    const cost = estimateAnthropicCost('claude-sonnet-4-6', usage);
    const summary = buildAnthropicSpendSummary('claude-sonnet-4-6', usage, cost);

    expect(summary).toEqual({
      totalTokens: 123,
      inputTokens: 100,
      cacheWriteTokens: 10,
      cacheReadTokens: 5,
      outputTokens: 8,
      totalUsd: 0.00046,
      uncachedUsd: 0.000465,
      cacheEffectUsd: 0.000005,
      cacheEffectKind: 'saved',
      cacheWriteUsd: 0.000038,
      cacheReadUsd: 0.000002,
      approximate: true,
    });
  });

  it('marks cache overhead when write pricing exceeds an uncached baseline', () => {
    const usage = {
      input_tokens: 420,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 90,
      output_tokens: 11,
      cache_creation: {
        ephemeral_5m_input_tokens: 120,
        ephemeral_1h_input_tokens: 180,
      },
    };

    const cost = estimateAnthropicCost('claude-sonnet-4-6', usage);
    const summary = buildAnthropicSpendSummary('claude-sonnet-4-6', usage, cost);

    expect(summary).toEqual({
      totalTokens: 821,
      inputTokens: 420,
      cacheWriteTokens: 300,
      cacheReadTokens: 90,
      outputTokens: 11,
      totalUsd: 0.002982,
      uncachedUsd: 0.002595,
      cacheEffectUsd: 0.000387,
      cacheEffectKind: 'overhead',
      cacheWriteUsd: 0.00153,
      cacheReadUsd: 0.000027,
      approximate: false,
    });
  });
});
