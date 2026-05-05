import { describe, expect, it } from 'vitest';
import {
  formatCompactTokens,
  formatUsd,
  formatSpendPrimary,
  formatSpendSecondary,
  formatCacheEffectInline,
} from '../src/content/spend-format.js';
import type { LlmSpendSummary } from '../src/shared/types.js';

describe('formatCompactTokens', () => {
  it.each([
    [0, '0'],
    [1, '1'],
    [999, '999'],
    [1000, '1k'],
    [1500, '1.5k'],
    [9999, '10k'],
    [10000, '10k'],
    [99999, '100k'],
    [999999, '1000k'],
    [1000000, '1M'],
    [1500000, '1.5M'],
  ])('formats %d as %s', (input, expected) => {
    expect(formatCompactTokens(input)).toBe(expected);
  });
});

describe('formatUsd', () => {
  it('formats values >= 1 with 2 digits', () => {
    expect(formatUsd(1.5)).toBe('$1.50');
  });

  it('formats values >= 0.01 with 4 digits', () => {
    expect(formatUsd(0.05)).toBe('$0.0500');
  });

  it('formats small values with 6 digits', () => {
    expect(formatUsd(0.002982)).toBe('$0.002982');
  });

  it('prepends ~ when approximate', () => {
    expect(formatUsd(0.05, true)).toBe('~$0.0500');
  });
});

function createSpend(overrides?: Partial<LlmSpendSummary>): LlmSpendSummary {
  return {
    totalTokens: 4500,
    inputTokens: 1200,
    cacheWriteTokens: 350,
    cacheReadTokens: 890,
    outputTokens: 2060,
    totalUsd: 0.0123,
    uncachedUsd: 0.015,
    cacheEffectUsd: 0.0012,
    cacheEffectKind: 'saved',
    cacheWriteUsd: 0.001,
    cacheReadUsd: 0.0002,
    approximate: false,
    ...overrides,
  };
}

describe('formatSpendPrimary', () => {
  it('returns cost and compact tokens', () => {
    expect(formatSpendPrimary(createSpend())).toBe('$0.0123 · 4.5k tokens');
  });
});

describe('formatSpendSecondary', () => {
  it('returns compact token breakdown', () => {
    expect(formatSpendSecondary(createSpend())).toBe('in 1.2k · write 350 · read 890 · out 2.1k');
  });
});

describe('formatCacheEffectInline', () => {
  it('returns saved text with kind', () => {
    const result = formatCacheEffectInline(createSpend());
    expect(result).toEqual({ text: 'saved $0.001200', kind: 'saved' });
  });

  it('returns overhead text with kind', () => {
    const result = formatCacheEffectInline(createSpend({ cacheEffectKind: 'overhead' }));
    expect(result).toEqual({ text: 'overhead $0.001200', kind: 'overhead' });
  });

  it('returns null for neutral', () => {
    expect(formatCacheEffectInline(createSpend({ cacheEffectKind: 'neutral' }))).toBeNull();
  });

  it('returns null when effect is zero', () => {
    expect(formatCacheEffectInline(createSpend({ cacheEffectUsd: 0 }))).toBeNull();
  });
});
