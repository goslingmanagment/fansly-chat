import { describe, expect, it } from 'vitest';
import { fanslyIdTimestampMs } from '../src/shared/fansly-id-time.js';

describe('fanslyIdTimestampMs', () => {
  it('reads the creation time an id carries', () => {
    // An account whose Fansly `createdAt` is 2026-04-28T19:29:53Z.
    expect(fanslyIdTimestampMs('905593157180223488', Date.parse('2026-10-11T00:00:00Z')))
      .toBe(Date.parse('2026-04-28T19:29:53.779Z'));
  });

  it('answers null for anything that is not a Fansly id', () => {
    const now = Date.parse('2026-10-11T00:00:00Z');
    for (const invalid of ['', 'abc', '-1', '0', '12.5', '999999999999999999999999']) {
      expect(fanslyIdTimestampMs(invalid, now)).toBeNull();
    }
    // An id minted after `now` cannot name an existing account.
    expect(fanslyIdTimestampMs('905593157180223488', Date.parse('2026-01-01T00:00:00Z')))
      .toBeNull();
  });
});
