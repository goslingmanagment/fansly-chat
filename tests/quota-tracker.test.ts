import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getLatestQuotaSnapshot,
  getQuotaSnapshotsByPage,
  recordQuotaDenied,
  recordQuotaSnapshot,
} from '../src/background/quota-tracker.js';

// No browser.storage.session in the test env — the tracker's memory fallback
// carries the data, which is exactly the path we pin here.

describe('quota-tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('serves the freshest snapshot and marks denials exhausted', async () => {
    await recordQuotaSnapshot('lilly', 143);
    let latest = await getLatestQuotaSnapshot();
    expect(latest).toMatchObject({
      pageLabel: 'lilly',
      remainingRequestsToday: 143,
      exhausted: false,
    });

    vi.setSystemTime(new Date('2026-07-10T11:00:00.000Z'));
    await recordQuotaDenied('lilly');
    latest = await getLatestQuotaSnapshot();
    expect(latest).toMatchObject({
      pageLabel: 'lilly',
      remainingRequestsToday: 0,
      exhausted: true,
    });
  });

  it('treats a zero-remaining meta snapshot as exhausted', async () => {
    await recordQuotaSnapshot('lilly', 0);
    const latest = await getLatestQuotaSnapshot();
    expect(latest?.exhausted).toBe(true);
  });

  it('expires snapshots across the UTC-midnight quota reset', async () => {
    await recordQuotaSnapshot('lilly', 5);
    // 23:59 same UTC day: still served.
    vi.setSystemTime(new Date('2026-07-10T23:59:00.000Z'));
    expect(await getLatestQuotaSnapshot()).not.toBeNull();
    // 00:01 next UTC day: the kernel has reset — yesterday's number would lie.
    vi.setSystemTime(new Date('2026-07-11T00:01:00.000Z'));
    expect(await getLatestQuotaSnapshot()).toBeNull();
  });

  it('keeps both pages when two records for different pages overlap', async () => {
    // Simulate storage.session, whose get returns a COPY of the map at call time
    // (unlike the memory fallback, which shares one object). Without serialization
    // the later writer would erase the earlier page. The first get parks so the
    // two read-modify-write cycles are forced to interleave.
    const KEY = 'aiQuotaByPage';
    let backing: Record<string, unknown> = {};
    let releaseFirstGet!: () => void;
    const firstGetGate = new Promise<void>((resolve) => { releaseFirstGet = resolve; });
    let getCount = 0;
    vi.stubGlobal('browser', {
      storage: {
        session: {
          get: vi.fn((_key: string) => {
            getCount += 1;
            const captured = { [KEY]: structuredClone(backing) }; // value at CALL time
            return getCount === 1
              ? firstGetGate.then(() => captured) // stale snapshot, delivered late
              : Promise.resolve(captured);
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            backing = items[KEY] as Record<string, unknown>;
          }),
        },
      },
    });

    const first = recordQuotaSnapshot('lilly', 100);
    const second = recordQuotaSnapshot('ari', 50);
    releaseFirstGet();
    await Promise.all([first, second]);

    const byPage = await getQuotaSnapshotsByPage();
    expect(Object.keys(byPage).sort()).toEqual(['ari', 'lilly']);
    expect(byPage.lilly).toMatchObject({ remainingRequestsToday: 100 });
    expect(byPage.ari).toMatchObject({ remainingRequestsToday: 50 });
  });

  it('returns the full same-UTC-day map, dropping stale-day pages', async () => {
    vi.setSystemTime(new Date('2026-07-10T10:00:00.000Z'));
    await recordQuotaSnapshot('lilly', 143);
    await recordQuotaSnapshot('ari', 4);
    let byPage = await getQuotaSnapshotsByPage();
    expect(Object.keys(byPage).sort()).toEqual(['ari', 'lilly']);
    expect(byPage.ari).toMatchObject({ remainingRequestsToday: 4, exhausted: false });

    vi.setSystemTime(new Date('2026-07-11T00:01:00.000Z')); // next UTC day
    byPage = await getQuotaSnapshotsByPage();
    expect(byPage).toEqual({});
  });

  it('ignores records without a page label', async () => {
    vi.setSystemTime(new Date('2026-07-12T10:00:00.000Z'));
    await recordQuotaSnapshot('', 10);
    await recordQuotaDenied('');
    expect(await getLatestQuotaSnapshot()).toBeNull();
  });
});
