import { describe, expect, it } from 'vitest';
import { isValidSummaryCacheEntry } from '../src/shared/summary-cache.js';

describe('summary cache model matching', () => {
  it('treats legacy bare Claude ids as equivalent to canonical Anthropic selections', () => {
    expect(
      isValidSummaryCacheEntry(
        {
          summary: 'Cached',
          personalityId: 'p1',
          personalityUpdatedAt: 123,
          generatedAt: 456,
          spendingDataVerified: true,
          subscriptionLookupVerified: true,
          modelId: 'claude-opus-4-6',
        },
        'p1',
        123,
        'anthropic:claude-opus-4-6',
      ),
    ).toBe(true);
  });
});
