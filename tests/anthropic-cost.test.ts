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

  it('uses OpenRouter registry pricing including priced Grok cache reads', () => {
    const usage = {
      input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      output_tokens: 1_000_000,
    };

    const cost = estimateAnthropicCost('openrouter:x-ai/grok-4.20', usage);
    const summary = buildAnthropicSpendSummary('openrouter:x-ai/grok-4.20', usage, cost);

    expect(cost).toMatchObject({
      modelId: 'openrouter:x-ai/grok-4.20',
      inputUsd: 1.25,
      cacheReadUsd: 0.2,
      outputUsd: 2.5,
      totalUsd: 3.95,
      approximate: false,
    });
    expect(summary).toMatchObject({
      totalTokens: 3_000_000,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheReadUsd: 0.2,
      cacheEffectKind: 'saved',
      approximate: false,
    });
  });

  it('marks costs approximate when a model reports cache reads without cache pricing', () => {
    const cost = estimateAnthropicCost('openrouter:google/gemini-3.1-pro-preview', {
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 10,
      output_tokens: 100,
    });

    expect(cost.cacheReadUsd).toBe(0);
    expect(cost.approximate).toBe(true);
  });

  it('marks Grok 4.3 costs approximate because OpenRouter tiering can apply', () => {
    const cost = estimateAnthropicCost('openrouter:x-ai/grok-4.3', {
      input_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 100,
    });

    expect(cost.approximate).toBe(true);
  });
});
