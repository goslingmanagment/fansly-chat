import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSpendersObservations,
  getLatestSpendersObservation,
  recordSpendersObservation,
  spendersObservationScope,
} from '../src/background/spenders-status-tracker.js';

/** Build the sourceIdentity the way SpendersService.getList does:
 * `creator|hubBaseUrl|sha256(bearer)`. */
function sourceId(creator: string, hubBaseUrl: string, bearer: string): string {
  return `${creator}|${spendersObservationScope(hubBaseUrl, bearer)}`;
}

describe('spenders-status-tracker', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-07-17T09:00:00.000Z')); });
  afterEach(async () => {
    // Reset module state so the memory-fallback map does not bleed across tests.
    await clearSpendersObservations();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Ordered first: the tracker's session-memory fallback is module-scoped and
  // has no same-UTC-day expiry (unlike quota-tracker), so this "empty" assertion
  // must observe fresh module memory before any sibling test records into it.
  it('returns null when nothing has been observed', async () => {
    expect(await getLatestSpendersObservation('https://hub', 'bearer')).toBeNull();
  });

  it('serves the freshest observation across creators under the current hub+bearer', async () => {
    await recordSpendersObservation({ sourceIdentity: sourceId('lilly', 'https://hub', 'bearer'), streamState: 'ramped', outcome: 'ok' });
    vi.setSystemTime(new Date('2026-07-17T09:05:00.000Z'));
    await recordSpendersObservation({ sourceIdentity: sourceId('ari', 'https://hub', 'bearer'), streamState: null, outcome: 'fail' });
    const latest = await getLatestSpendersObservation('https://hub', 'bearer');
    expect(latest).toMatchObject({ outcome: 'fail', streamState: null });
    expect(latest?.sourceIdentity).toBe(sourceId('ari', 'https://hub', 'bearer'));
  });

  it('does not surface an observation recorded under a different hub (principal change)', async () => {
    await recordSpendersObservation({ sourceIdentity: sourceId('creator-1', 'https://hub-a', 'bearer'), streamState: 'ramped', outcome: 'ok' });
    // Still on hub A → served.
    expect(await getLatestSpendersObservation('https://hub-a', 'bearer')).toMatchObject({ streamState: 'ramped', outcome: 'ok' });
    // The chatter changed the hub setting to B — the A-hub board must not survive.
    expect(await getLatestSpendersObservation('https://hub-b', 'bearer')).toBeNull();
    // A blank current hub OR a blank bearer can match nothing.
    expect(await getLatestSpendersObservation('', 'bearer')).toBeNull();
    expect(await getLatestSpendersObservation(null, 'bearer')).toBeNull();
    expect(await getLatestSpendersObservation('https://hub-a', null)).toBeNull();
    expect(await getLatestSpendersObservation('https://hub-a', '')).toBeNull();
  });

  it('binds the observation to the bearer: a same-URL credential swap hides the prior board', async () => {
    // Finding 5: recorded under bearer-A on hub H.
    await recordSpendersObservation({ sourceIdentity: sourceId('creator-1', 'https://hub', 'bearer-A'), streamState: 'ramped', outcome: 'ok' });
    // Same creator, same URL, DIFFERENT bearer → the prior principal's board is invisible.
    expect(await getLatestSpendersObservation('https://hub', 'bearer-B')).toBeNull();
    // The original bearer still sees it.
    expect(await getLatestSpendersObservation('https://hub', 'bearer-A')).toMatchObject({ outcome: 'ok' });
  });

  it('clearSpendersObservations wipes the map (A→B→A leaves no stale A board)', async () => {
    // Finding 5: the background clears observations on every hub-source change,
    // so A's OLD board never survives A→B→A.
    await recordSpendersObservation({ sourceIdentity: sourceId('creator-1', 'https://hub', 'bearer-A'), streamState: 'ramped', outcome: 'ok' });
    await clearSpendersObservations(); // A → B
    await recordSpendersObservation({ sourceIdentity: sourceId('creator-1', 'https://hub', 'bearer-B'), streamState: 'flag_off', outcome: 'ok' });
    await clearSpendersObservations(); // B → A
    // Back on A, but A's original observation is gone (no board reopened yet).
    expect(await getLatestSpendersObservation('https://hub', 'bearer-A')).toBeNull();
    expect(await getLatestSpendersObservation('https://hub', 'bearer-B')).toBeNull();
  });

  it('serializes interleaved records for different creators (structured-clone storage.session)', async () => {
    // Finding 6: a storage.session that hands back a structured clone on every get
    // (as a real MV3 session store does) would let two overlapping read-modify-writes
    // clobber each other without the mutation queue. Both records must survive.
    let backing: Record<string, unknown> = {};
    const sessionArea = {
      get: vi.fn(async (key: string) => structuredClone({ [key]: backing[key] })),
      set: vi.fn(async (items: Record<string, unknown>) => { backing = { ...backing, ...structuredClone(items) }; }),
    };
    vi.stubGlobal('browser', { storage: { session: sessionArea } });

    await Promise.all([
      recordSpendersObservation({ sourceIdentity: sourceId('creator-1', 'https://hub', 'bearer'), streamState: 'ramped', outcome: 'ok' }),
      recordSpendersObservation({ sourceIdentity: sourceId('creator-2', 'https://hub', 'bearer'), streamState: 'flag_off', outcome: 'ok' }),
    ]);

    const stored = backing.spendersObservations as Record<string, unknown>;
    expect(Object.keys(stored)).toContain(sourceId('creator-1', 'https://hub', 'bearer'));
    expect(Object.keys(stored)).toContain(sourceId('creator-2', 'https://hub', 'bearer'));
  });
});
