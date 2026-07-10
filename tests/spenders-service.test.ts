import { describe, expect, it, vi } from 'vitest';
import { SpendersService } from '../src/background/spenders-service.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
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
  earnings?: Record<string, number | 'throw'>;
}

function makeClient(overrides: StubOverrides) {
  const fans = overrides.fans ?? [
    { groupId: 'g1', fanAccountId: 'f1' },
    { groupId: 'g2', fanAccountId: 'f2' },
    { groupId: 'g3', fanAccountId: 'f3' },
  ];
  const earnings = overrides.earnings ?? { f1: 1078000, f2: 700000, f3: 0 };

  const listFanAccounts = vi.fn(async () => ({ fans, truncated: overrides.truncated ?? false }));
  const getEarnings = vi.fn(async (fanAccountId: string) => {
    const value = earnings[fanAccountId];
    if (value === 'throw') throw new Error('earnings failed');
    return value === undefined ? null : { totalGross: value, totalNet: value };
  });
  const getAccountNames = vi.fn(async (ids: string[]) =>
    ids.map((id) => ({ id, username: id, displayName: `Fan ${id}` })),
  );

  const client = { listFanAccounts, getEarnings, getAccountNames } as unknown as FanslyClient;
  return { client, listFanAccounts, getEarnings, getAccountNames };
}

// 1.7.0: the legacy per-fan sweep tests died with the code path (E9). The
// service-level behaviors they pinned — caching and abort hygiene — are
// re-expressed against the kernel path below.

// ── Stage 32 Task 4: the kernel board query ────────────────────────────────

describe('SpendersService (kernel source)', () => {
  function kernelSession(): SessionTemplate {
    return { ...session(), resolvedUsername: 'creator' };
  }

  function makeKernelHarness(overrides: StubOverrides & {
    snapshot?: {
      builtAt: string | null;
      fanCount: number;
      entries: Array<{
        platformUserId: string;
        username: string | null;
        displayName: string | null;
        grossMills: number;
      }>;
    };
    legacyRebuild?: boolean;
  } = {}) {
    const { client, listFanAccounts, getEarnings } = makeClient(overrides);
    const snapshot = overrides.snapshot ?? {
      builtAt: '2026-07-05T00:00:00.000Z',
      fanCount: 2,
      entries: [
        { platformUserId: 'f1', username: 'alice', displayName: 'Alice', grossMills: 1_078_000 },
        { platformUserId: 'f2', username: null, displayName: null, grossMills: 700_000 },
        // Not among the visible conversations → no groupId → filtered.
        { platformUserId: 'f-unknown', username: 'ghost', displayName: null, grossMills: 500_000 },
      ],
    };
    const kernelSource = {
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      fetchTopSpenders: vi.fn(async () => snapshot),
    };
    const settings = {
      ...createDefaultSettings(),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
    };
    const service = new SpendersService(client, kernelSource, async () => settings);
    return { service, kernelSource, listFanAccounts, getEarnings };
  }

  it('builds from one kernel query: no earnings sweep, honest builtAt, group intersection', async () => {
    const { service, kernelSource, listFanAccounts, getEarnings } = makeKernelHarness();
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(kernelSource.fetchTopSpenders).toHaveBeenCalledWith(
      expect.objectContaining({ agencyHubApiKey: 'hub-key' }),
      'creator-fs',
      expect.any(Number),
      expect.any(AbortSignal),
    );
    // The quota win: one conversations enumeration, ZERO per-fan earnings calls.
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
      },
      {
        fanAccountId: 'f2',
        groupId: 'g2',
        displayName: null,
        username: null,
        lifetimeMills: 700_000,
        lifetimeUsd: 700,
      },
    ]);
    // Snapshot honesty: the projection's freshest observation, not "now".
    expect(result.builtAt).toBe(Date.parse('2026-07-05T00:00:00.000Z'));
    expect(result.fanCount).toBe(2);
  });

  it('1.7.0: no legacy fallback — an unwired kernel source fails loudly', async () => {
    const { service } = makeKernelHarness();
    const bare = new SpendersService(
      (service as unknown as { fanslyClient: FanslyClient }).fanslyClient,
    );
    await expect(
      bare.getList(kernelSession(), new AbortController().signal),
    ).rejects.toMatchObject({ key: 'hub_request_failed' });
  });

  it('caches the kernel result and refetches only on refresh', async () => {
    const { service, kernelSource } = makeKernelHarness();
    const sess = kernelSession();

    await service.getList(sess, new AbortController().signal);
    await service.getList(sess, new AbortController().signal);
    expect(kernelSource.fetchTopSpenders).toHaveBeenCalledTimes(1);

    await service.getList(sess, new AbortController().signal, { refresh: true });
    expect(kernelSource.fetchTopSpenders).toHaveBeenCalledTimes(2);
  });

  it('throws (does not cache) when the kernel build is aborted', async () => {
    const { service, kernelSource } = makeKernelHarness();
    kernelSource.fetchTopSpenders.mockRejectedValueOnce(new DOMException('Aborted', 'AbortError'));

    await expect(
      service.getList(kernelSession(), new AbortController().signal),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // A subsequent call rebuilds rather than serving a poisoned cache.
    await service.getList(kernelSession(), new AbortController().signal);
    expect(kernelSource.fetchTopSpenders).toHaveBeenCalledTimes(2);
  });

  // ── W9.3/A20: not-ramped pages (kernel builtAt null) ─────────────────────

  it('propagates a null builtAt verbatim instead of inventing "now"', async () => {
    const { service } = makeKernelHarness({
      snapshot: { builtAt: null, fanCount: 0, entries: [] },
    });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.builtAt).toBeNull();
    expect(result.entries).toEqual([]);
    expect(result.fanCount).toBe(0);
  });

  it('never caches a not-ramped result — every open re-asks the kernel', async () => {
    const { service, kernelSource } = makeKernelHarness({
      snapshot: { builtAt: null, fanCount: 0, entries: [] },
    });
    const sess = kernelSession();

    await service.getList(sess, new AbortController().signal);
    await service.getList(sess, new AbortController().signal);
    // No 10-minute pin: both non-refresh calls hit the kernel.
    expect(kernelSource.fetchTopSpenders).toHaveBeenCalledTimes(2);

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
    expect(kernelSource.fetchTopSpenders).toHaveBeenCalledTimes(3);
  });

  it('fails loudly when the page label cannot be resolved', async () => {
    const { service, kernelSource } = makeKernelHarness();
    kernelSource.resolvePageLabelForUsername.mockResolvedValue(null as never);
    await expect(
      service.getList(kernelSession(), new AbortController().signal),
    ).rejects.toMatchObject({ key: 'hub_page_match_failed' });
  });
});
