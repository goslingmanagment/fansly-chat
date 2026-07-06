import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('SpendersService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('ranks payers by lifetime gross and drops $0 fans', async () => {
    const { client } = makeClient({});
    const service = new SpendersService(client);

    const result = await service.getList(session(), new AbortController().signal);

    expect(result.entries.map((e) => e.fanAccountId)).toEqual(['f1', 'f2']);
    expect(result.entries[0]).toMatchObject({
      fanAccountId: 'f1',
      groupId: 'g1',
      displayName: 'Fan f1',
      lifetimeMills: 1078000,
      lifetimeUsd: 1078,
    });
    expect(result.fanCount).toBe(2);
    expect(result.scannedCount).toBe(3);
  });

  it('caches the result and refetches only on refresh', async () => {
    const { client, listFanAccounts } = makeClient({});
    const service = new SpendersService(client);
    const sess = session();

    await service.getList(sess, new AbortController().signal);
    await service.getList(sess, new AbortController().signal);
    expect(listFanAccounts).toHaveBeenCalledTimes(1);

    await service.getList(sess, new AbortController().signal, { refresh: true });
    expect(listFanAccounts).toHaveBeenCalledTimes(2);
  });

  it('counts a per-fan earnings failure as $0', async () => {
    const { client } = makeClient({ earnings: { f1: 500000, f2: 'throw', f3: 250000 } });
    const service = new SpendersService(client);

    const result = await service.getList(session(), new AbortController().signal);

    expect(result.entries.map((e) => e.fanAccountId)).toEqual(['f1', 'f3']);
  });

  it('throws (does not cache) when the build is aborted', async () => {
    const { client, listFanAccounts } = makeClient({});
    const service = new SpendersService(client);
    const controller = new AbortController();
    controller.abort();

    await expect(service.getList(session(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    // A subsequent (non-aborted) call rebuilds rather than serving a poisoned cache.
    await service.getList(session(), new AbortController().signal);
    expect(listFanAccounts).toHaveBeenCalledTimes(2);
  });
});

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
      spendersLegacyRebuild: overrides.legacyRebuild ?? false,
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

  it('the hidden spendersLegacyRebuild flip forces the legacy sweep', async () => {
    const { service, kernelSource, getEarnings } = makeKernelHarness({ legacyRebuild: true });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(kernelSource.fetchTopSpenders).not.toHaveBeenCalled();
    expect(getEarnings).toHaveBeenCalled(); // the per-fan sweep ran
    expect(result.entries[0]?.fanAccountId).toBe('f1');
  });

  it('fails loudly when the page label cannot be resolved', async () => {
    const { service, kernelSource } = makeKernelHarness();
    kernelSource.resolvePageLabelForUsername.mockResolvedValue(null as never);
    await expect(
      service.getList(kernelSession(), new AbortController().signal),
    ).rejects.toMatchObject({ key: 'hub_page_match_failed' });
  });
});
