import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../src/shared/concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves result order', async () => {
    const items = [10, 20, 30];
    const result = await mapWithConcurrency(items, 2, async (n) => n * 2);
    expect(result).toEqual([20, 40, 60]);
  });

  it('returns empty array for empty input', async () => {
    const result = await mapWithConcurrency([], 4, async (n: number) => n);
    expect(result).toEqual([]);
  });

  it('respects concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const items = [1, 2, 3, 4, 5, 6];
    await mapWithConcurrency(items, 2, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return n;
    });

    expect(maxInFlight).toBe(2);
  });

  it('propagates errors from fn', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('handles limit greater than items length', async () => {
    const result = await mapWithConcurrency([1, 2], 10, async (n) => n + 1);
    expect(result).toEqual([2, 3]);
  });
});
