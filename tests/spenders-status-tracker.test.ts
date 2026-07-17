import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLatestSpendersObservation,
  recordSpendersObservation,
} from '../src/background/spenders-status-tracker.js';

describe('spenders-status-tracker', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-17T09:00:00.000Z')); });
  afterEach(() => { vi.useRealTimers(); });

  // Ordered first: the tracker's session-memory fallback is module-scoped and
  // has no same-UTC-day expiry (unlike quota-tracker), so this "empty" assertion
  // must observe fresh module memory before any sibling test records into it.
  it('returns null when nothing has been observed', async () => {
    expect(await getLatestSpendersObservation()).toBeNull();
  });

  it('serves the freshest observation across sources', async () => {
    await recordSpendersObservation({ sourceIdentity: 'lilly|https://hub', streamState: 'ramped', outcome: 'ok' });
    vi.setSystemTime(new Date('2026-07-17T09:05:00.000Z'));
    await recordSpendersObservation({ sourceIdentity: 'ari|https://hub', streamState: null, outcome: 'fail' });
    const latest = await getLatestSpendersObservation();
    expect(latest).toMatchObject({ sourceIdentity: 'ari|https://hub', outcome: 'fail', streamState: null });
  });
});
