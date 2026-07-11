import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpendersService } from '../src/background/spenders-service.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import { monthWindowFor } from '../src/shared/spenders.js';
import type { SessionTemplate } from '../src/shared/types.js';

function session(accountId = 'creator-1'): SessionTemplate {
  return {
    accountId,
    resolvedAccountId: null,
    resolvedUsername: null,
    resolvedDisplayName: null,
    authorization: 'auth',
    fanslyClientId: 'client',
    fanslySessionId: 'session',
    latestTs: '1',
    latestCheck: null,
    routeChecks: {},
    lastSeenAt: 0,
    connected: true,
  };
}

interface StubOverrides {
  fans?: Array<{ groupId: string; fanAccountId: string }>;
  truncated?: boolean;
}

function makeClient(overrides: StubOverrides) {
  const fans = overrides.fans ?? [
    { groupId: 'g1', fanAccountId: 'f1' },
    { groupId: 'g2', fanAccountId: 'f2' },
    { groupId: 'g3', fanAccountId: 'f3' },
  ];

  const listFanAccounts = vi.fn(async () => ({ fans, truncated: overrides.truncated ?? false }));
  const getEarnings = vi.fn(async () => null);

  const client = { listFanAccounts, getEarnings } as unknown as FanslyClient;
  return { client, listFanAccounts, getEarnings };
}

interface KernelSnapshot {
  builtAt: string | null;
  fanCount: number;
  entries: Array<{
    platformUserId: string;
    username: string | null;
    displayName: string | null;
    grossMills: number;
  }>;
}

// 1.7.0: the legacy per-fan sweep tests died with the code path (E9). The
// service-level behaviors they pinned — caching and abort hygiene — are
// re-expressed against the kernel path below.

// ── Stage 32 Task 4 (+E23): the kernel board queries ───────────────────────

describe('SpendersService (kernel source)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function kernelSession(): SessionTemplate {
    return { ...session(), resolvedUsername: 'creator' };
  }

  const LIFETIME_SNAPSHOT: KernelSnapshot = {
    builtAt: '2026-07-05T00:00:00.000Z',
    fanCount: 3,
    entries: [
      { platformUserId: 'f1', username: 'alice', displayName: 'Alice', grossMills: 1_078_000 },
      { platformUserId: 'f2', username: null, displayName: null, grossMills: 700_000 },
      // Not among the enumerated conversations → kept, with groupId null (E23).
      { platformUserId: 'f-unknown', username: 'ghost', displayName: null, grossMills: 500_000 },
    ],
  };

  const MONTH_SNAPSHOT: KernelSnapshot = {
    builtAt: '2026-07-05T00:00:00.000Z',
    fanCount: 2,
    entries: [
      { platformUserId: 'f1', username: 'alice', displayName: 'Alice', grossMills: 120_000 },
      { platformUserId: 'f-unknown', username: 'ghost', displayName: null, grossMills: 500_000 },
    ],
  };

  function makeKernelHarness(overrides: StubOverrides & {
    snapshot?: KernelSnapshot;
    monthSnapshot?: KernelSnapshot | 'throw';
  } = {}) {
    const { client, listFanAccounts, getEarnings } = makeClient(overrides);
    const snapshot = overrides.snapshot ?? LIFETIME_SNAPSHOT;
    const monthSnapshot = overrides.monthSnapshot ?? MONTH_SNAPSHOT;
    const fetchTopSpenders = vi.fn(
      async (
        _settings: unknown,
        _pageLabel: string,
        window: string,
        _limit: number,
        _signal: AbortSignal,
      ) => {
        if (window === 'lifetime') return snapshot;
        if (monthSnapshot === 'throw') throw new Error('month window failed');
        return monthSnapshot;
      },
    );
    const kernelSource = {
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      fetchTopSpenders,
    };
    const settings = {
      ...createDefaultSettings(),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
    };
    const service = new SpendersService(client, kernelSource, async () => settings);
    return { service, kernelSource, fetchTopSpenders, listFanAccounts, getEarnings };
  }

  it('builds from the kernel: every spender listed, unmapped fans get groupId null', async () => {
    const { service, fetchTopSpenders, listFanAccounts, getEarnings } = makeKernelHarness();
    const result = await service.getList(kernelSession(), new AbortController().signal);

    // Lifetime + month windows, ZERO per-fan earnings calls, one enumeration.
    expect(fetchTopSpenders).toHaveBeenCalledTimes(2);
    expect(fetchTopSpenders).toHaveBeenCalledWith(
      expect.objectContaining({ agencyHubApiKey: 'hub-key' }),
      'creator-fs',
      'lifetime',
      expect.any(Number),
      expect.any(AbortSignal),
    );
    expect(fetchTopSpenders).toHaveBeenCalledWith(
      expect.anything(),
      'creator-fs',
      monthWindowFor(Date.now()),
      expect.any(Number),
      expect.any(AbortSignal),
    );
    expect(listFanAccounts).toHaveBeenCalledTimes(1);
    expect(getEarnings).not.toHaveBeenCalled();

    expect(result.entries).toEqual([
      {
        fanAccountId: 'f1',
        groupId: 'g1',
        displayName: 'Alice',
        username: 'alice',
        lifetimeMills: 1_078_000,
        lifetimeUsd: 1078,
        monthMills: 120_000,
        monthUsd: 120,
      },
      {
        fanAccountId: 'f2',
        groupId: 'g2',
        displayName: null,
        username: null,
        lifetimeMills: 700_000,
        lifetimeUsd: 700,
        // In the month snapshot's window but absent from its entries = $0.
        monthMills: 0,
        monthUsd: 0,
      },
      {
        // E23: the enumeration is a map, not a membership gate — a whale
        // outside the most-recent chats stays on the board.
        fanAccountId: 'f-unknown',
        groupId: null,
        displayName: null,
        username: 'ghost',
        lifetimeMills: 500_000,
        lifetimeUsd: 500,
        monthMills: 500_000,
        monthUsd: 500,
      },
    ]);
    // Snapshot honesty: the projection's freshest observation, not "now".
    expect(result.builtAt).toBe(Date.parse('2026-07-05T00:00:00.000Z'));
    // fanCount = the kernel's total, not the shown slice.
    expect(result.fanCount).toBe(3);
    expect(result.monthWindow).toBe(monthWindowFor(Date.now()));
    expect(typeof result.fetchedAt).toBe('number');
  });

  it('degrades the month column to unknown when the month query fails', async () => {
    const { service } = makeKernelHarness({ monthSnapshot: 'throw' });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.monthWindow).toBeNull();
    expect(result.entries.map((entry) => entry.monthUsd)).toEqual([null, null, null]);
    // The board itself is unaffected.
    expect(result.entries).toHaveLength(3);
    expect(result.builtAt).not.toBeNull();
  });

  it('treats an empty month window (builtAt null) as unknown, not $0', async () => {
    const { service } = makeKernelHarness({
      monthSnapshot: { builtAt: null, fanCount: 0, entries: [] },
    });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.monthWindow).toBeNull();
    expect(result.entries.map((entry) => entry.monthUsd)).toEqual([null, null, null]);
  });

  it('1.7.0: no legacy fallback — an unwired kernel source fails loudly', async () => {
    const { client } = makeClient({});
    const bare = new SpendersService(client);
    await expect(
      bare.getList(kernelSession(), new AbortController().signal),
    ).rejects.toMatchObject({ key: 'hub_request_failed' });
  });

  it('caches the kernel result and refetches only on refresh', async () => {
    const { service, fetchTopSpenders } = makeKernelHarness();
    const sess = kernelSession();

    await service.getList(sess, new AbortController().signal);
    await service.getList(sess, new AbortController().signal);
    expect(fetchTopSpenders).toHaveBeenCalledTimes(2); // lifetime + month, once

    await service.getList(sess, new AbortController().signal, { refresh: true });
    expect(fetchTopSpenders).toHaveBeenCalledTimes(4);
  });

  it('throws (does not cache) when the kernel build is aborted', async () => {
    const { service, fetchTopSpenders } = makeKernelHarness();
    fetchTopSpenders.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

    await expect(
      service.getList(kernelSession(), new AbortController().signal),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // A subsequent call rebuilds rather than serving a poisoned cache.
    const result = await service.getList(kernelSession(), new AbortController().signal);
    expect(result.entries.length).toBeGreaterThan(0);
  });

  // ── E: the 10-min cache survives worker restarts via storage.session ─────

  it('serves a fresh session-storage snapshot after a worker restart', async () => {
    const store = new Map<string, unknown>();
    const sessionArea = {
      get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      }),
    };
    vi.stubGlobal('browser', { storage: { session: sessionArea } });

    const first = makeKernelHarness();
    await first.service.getList(kernelSession(), new AbortController().signal);
    expect(first.fetchTopSpenders).toHaveBeenCalledTimes(2);

    // "Restart": a brand-new service instance (empty memory cache) must serve
    // the persisted snapshot without re-asking the kernel.
    const second = makeKernelHarness();
    const result = await second.service.getList(kernelSession(), new AbortController().signal);
    expect(second.fetchTopSpenders).not.toHaveBeenCalled();
    expect(result.entries).toHaveLength(3);

    // refresh bypasses the persisted copy too.
    await second.service.getList(kernelSession(), new AbortController().signal, { refresh: true });
    expect(second.fetchTopSpenders).toHaveBeenCalledTimes(2);
  });

  // ── W9.3/A20: not-ramped pages (kernel builtAt null) ─────────────────────

  it('propagates a null builtAt verbatim instead of inventing "now"', async () => {
    const { service } = makeKernelHarness({
      snapshot: { builtAt: null, fanCount: 0, entries: [] },
      monthSnapshot: { builtAt: null, fanCount: 0, entries: [] },
    });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.builtAt).toBeNull();
    expect(result.entries).toEqual([]);
    expect(result.fanCount).toBe(0);
  });

  it('never caches a not-ramped result — every open re-asks the kernel', async () => {
    const { service, kernelSource, fetchTopSpenders } = makeKernelHarness({
      snapshot: { builtAt: null, fanCount: 0, entries: [] },
      monthSnapshot: { builtAt: null, fanCount: 0, entries: [] },
    });
    const sess = kernelSession();

    await service.getList(sess, new AbortController().signal);
    await service.getList(sess, new AbortController().signal);
    // No 10-minute pin: both non-refresh calls hit the kernel.
    expect(fetchTopSpenders).toHaveBeenCalledTimes(4);

    // The moment the kernel starts serving a real snapshot, it lands (and
    // caches again like any ramped page).
    kernelSource.fetchTopSpenders.mockResolvedValue({
      builtAt: '2026-07-10T00:00:00.000Z',
      fanCount: 1,
      entries: [
        { platformUserId: 'f1', username: 'alice', displayName: 'Alice', grossMills: 1_000 },
      ],
    });
    const ramped = await service.getList(sess, new AbortController().signal);
    expect(ramped.builtAt).toBe(Date.parse('2026-07-10T00:00:00.000Z'));
    await service.getList(sess, new AbortController().signal);
    expect(fetchTopSpenders).toHaveBeenCalledTimes(6);
  });

  it('fails loudly when the page label cannot be resolved', async () => {
    const { service, kernelSource } = makeKernelHarness();
    kernelSource.resolvePageLabelForUsername.mockResolvedValue(null as never);
    await expect(
      service.getList(kernelSession(), new AbortController().signal),
    ).rejects.toMatchObject({ key: 'hub_page_match_failed' });
  });
});
