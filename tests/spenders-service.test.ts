import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpendersService } from '../src/background/spenders-service.js';
import {
  getLatestSpendersObservation,
  recordSpendersObservation,
  spendersObservationScope,
} from '../src/background/spenders-status-tracker.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import { normalizeAgencyHubBaseUrl } from '../src/shared/agency-hub.js';
import { SPENDERS_BUILD_TIMEOUT_REASON } from '../src/shared/constants.js';
import { ChatGooseError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import { monthWindowFor } from '../src/shared/spenders.js';
import type {
  FanslyAccountResponse,
  SessionTemplate,
  Settings,
  SpendersListResult,
  SpendersStreamState,
} from '../src/shared/types.js';

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
  accounts?: FanslyAccountResponse[] | 'throw';
}

function makeClient(overrides: StubOverrides) {
  const fans = overrides.fans ?? [
    { groupId: 'g1', fanAccountId: 'f1' },
    { groupId: 'g2', fanAccountId: 'f2' },
    { groupId: 'g3', fanAccountId: 'f3' },
  ];

  const listFanAccounts = vi.fn(async (
    _maxFans: number,
    _session: SessionTemplate,
    _signal: AbortSignal,
  ) => ({ fans, truncated: overrides.truncated ?? false }));
  const getEarnings = vi.fn(async () => null);
  const getAccountNames = vi.fn(async (
    ids: string[],
    _session: SessionTemplate,
    _signal: AbortSignal,
    _retryPolicy: 'default' | 'none' = 'default',
  ) => {
    if (overrides.accounts === 'throw') throw new Error('account lookup failed');
    const known = overrides.accounts ?? [];
    return known.filter((account) => ids.includes(account.id));
  });

  const client = { listFanAccounts, getEarnings, getAccountNames } as unknown as FanslyClient;
  return { client, listFanAccounts, getEarnings, getAccountNames };
}

interface KernelSnapshot {
  builtAt: string | null;
  fanCount: number;
  source: {
    streamState: SpendersStreamState;
    lastSyncedAt: string | null;
    consecutiveFailures: number | null;
  };
  entries: Array<{
    platformUserId: string;
    username: string | null;
    displayName: string | null;
    grossMills: number;
    /** Optional exactly like the kernel contract: fixtures without it stand
     * for a kernel deployed before the field existed. */
    deletedAt?: string | null;
  }>;
}

const CURRENT_MONTH_SYNC_AT = `${monthWindowFor(Date.now())}-05T01:00:00.000Z`;

const RAMPED_SOURCE: KernelSnapshot['source'] = {
  streamState: 'ramped',
  lastSyncedAt: CURRENT_MONTH_SYNC_AT,
  consecutiveFailures: 0,
};

// 1.7.0: the legacy per-fan sweep tests died with the code path (E9). The
// service-level behaviors they pinned — caching and abort hygiene — are
// re-expressed against the kernel path below.

// ── Stage 32 Task 4 (+E23): the kernel board queries ───────────────────────

describe('SpendersService (kernel source)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function kernelSession(): SessionTemplate {
    return { ...session(), resolvedUsername: 'creator' };
  }

  const LIFETIME_SNAPSHOT: KernelSnapshot = {
    builtAt: '2026-07-05T00:00:00.000Z',
    fanCount: 3,
    source: RAMPED_SOURCE,
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
    source: RAMPED_SOURCE,
    entries: [
      { platformUserId: 'f1', username: 'alice', displayName: 'Alice', grossMills: 120_000 },
      { platformUserId: 'f-unknown', username: 'ghost', displayName: null, grossMills: 500_000 },
    ],
  };

  function makeKernelHarness(overrides: StubOverrides & {
    snapshot?: KernelSnapshot;
    monthSnapshot?: KernelSnapshot | 'throw';
    tuning?: { nameSweepBudgetMs?: number; chatMapBudgetMs?: number; monthBudgetMs?: number };
    settings?: Partial<Settings>;
  } = {}) {
    const { client, listFanAccounts, getEarnings, getAccountNames } = makeClient(overrides);
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
      agencyHubDeviceToken: 'hub-key',
      ...overrides.settings,
    };
    const service = new SpendersService(client, kernelSource, async () => settings, overrides.tuning);
    return {
      service,
      settings,
      kernelSource,
      fetchTopSpenders,
      listFanAccounts,
      getEarnings,
      getAccountNames,
    };
  }

  it('builds from the kernel: every spender listed, unmapped fans get groupId null', async () => {
    const { service, fetchTopSpenders, listFanAccounts, getEarnings } = makeKernelHarness();
    const result = await service.getList(kernelSession(), new AbortController().signal);

    // Lifetime + month windows, ZERO per-fan earnings calls, one enumeration.
    expect(fetchTopSpenders).toHaveBeenCalledTimes(2);
    expect(fetchTopSpenders).toHaveBeenCalledWith(
      expect.objectContaining({ agencyHubDeviceToken: 'hub-key' }),
      'creator-fs',
      'lifetime',
      1000,
      expect.any(AbortSignal),
    );
    expect(fetchTopSpenders).toHaveBeenCalledWith(
      expect.anything(),
      'creator-fs',
      monthWindowFor(Date.now()),
      1000,
      expect.any(AbortSignal),
    );
    expect(listFanAccounts).toHaveBeenCalledTimes(1);
    expect(getEarnings).not.toHaveBeenCalled();

    expect(result.entries).toEqual([
      {
        fanAccountId: 'f1',
        groupId: 'g1',
        customName: null,
        displayName: 'Alice',
        username: 'alice',
        lifetimeMills: 1_078_000,
        lifetimeUsd: 1078,
        monthMills: 120_000,
        monthUsd: 120,
        // A kernel that does not report deletion says nothing, and nothing
        // means alive.
        deletedAt: null,
      },
      {
        fanAccountId: 'f2',
        groupId: 'g2',
        customName: null,
        displayName: null,
        username: null,
        lifetimeMills: 700_000,
        lifetimeUsd: 700,
        // In the month snapshot's window but absent from its entries = $0.
        monthMills: 0,
        monthUsd: 0,
        deletedAt: null,
      },
      {
        // E23: the enumeration is a map, not a membership gate — a whale
        // outside the most-recent chats stays on the board.
        fanAccountId: 'f-unknown',
        groupId: null,
        customName: null,
        displayName: null,
        username: 'ghost',
        lifetimeMills: 500_000,
        lifetimeUsd: 500,
        monthMills: 500_000,
        monthUsd: 500,
        deletedAt: null,
      },
    ]);
    // Snapshot honesty: the projection's freshest observation, not "now".
    expect(result.builtAt).toBe(Date.parse('2026-07-05T00:00:00.000Z'));
    expect(result.source).toEqual({
      streamState: 'ramped',
      lastSyncedAt: Date.parse(CURRENT_MONTH_SYNC_AT),
      consecutiveFailures: 0,
    });
    // fanCount = the kernel's total, not the shown slice.
    expect(result.fanCount).toBe(3);
    expect(result.monthWindow).toBe(monthWindowFor(Date.now()));
    expect(typeof result.fetchedAt).toBe('number');
  });

  it('records a ramped observation on a successful board', async () => {
    const { service, settings } = makeKernelHarness();
    const hub = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    await service.getList(kernelSession(), new AbortController().signal);
    expect(await getLatestSpendersObservation(hub, settings.agencyHubDeviceToken))
      .toMatchObject({ outcome: 'ok', streamState: 'ramped' });
  });

  it('carries the page label into the result and the observation', async () => {
    // The options row must be able to name the page a verdict is about. The
    // label rides the RESULT because the observation is recorded in getList,
    // long before (and, on a cache hit, entirely without) the resolve that
    // produces it.
    const { service, settings } = makeKernelHarness();
    const hub = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.pageLabel).toBe('creator-fs');
    expect(await getLatestSpendersObservation(hub, settings.agencyHubDeviceToken))
      .toMatchObject({
        pageLabel: 'creator-fs',
        builtAt: Date.parse('2026-07-05T00:00:00.000Z'),
      });
  });

  it('names the page on a build that failed AFTER the label was resolved', async () => {
    // The case the row exists for. Nearly every real failure — a Hub 500 on the
    // ranking request, a build timeout, session_expired during enrichment —
    // happens long after resolvePageLabelForUsername succeeded, and an
    // anonymous «сборка не удалась» is the verdict this task set out to kill.
    const { service, settings, fetchTopSpenders } = makeKernelHarness();
    const hub = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    fetchTopSpenders.mockRejectedValue(new ChatGooseError('hub_request_failed'));

    await expect(service.getList(kernelSession(), new AbortController().signal)).rejects.toBeDefined();

    expect(await getLatestSpendersObservation(hub, settings.agencyHubDeviceToken))
      .toMatchObject({ outcome: 'fail', streamState: null, pageLabel: 'creator-fs' });
  });

  it('keeps the projection age of a build that failed after the ranking landed', async () => {
    // The ranking carries the projection's own freshness, so a failure in the
    // optional enrichment that follows can still say how old the data was.
    const { service, settings, listFanAccounts } = makeKernelHarness();
    const hub = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    // session_expired is the one enrichment failure that is fatal to the build.
    listFanAccounts.mockRejectedValue(new ChatGooseError('session_expired'));

    await expect(service.getList(kernelSession(), new AbortController().signal)).rejects.toBeDefined();

    expect(await getLatestSpendersObservation(hub, settings.agencyHubDeviceToken))
      .toMatchObject({
        outcome: 'fail',
        pageLabel: 'creator-fs',
        builtAt: Date.parse('2026-07-05T00:00:00.000Z'),
      });
  });

  it('records no page when the page-label resolution itself failed', async () => {
    // The ONLY failure with genuinely nothing to name. Claiming a page here
    // would be inventing one.
    const { service, settings, kernelSource } = makeKernelHarness();
    const hub = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    kernelSource.resolvePageLabelForUsername = vi.fn(async () => {
      throw new ChatGooseError('hub_page_match_failed');
    });
    await expect(service.getList(kernelSession(), new AbortController().signal)).rejects.toBeDefined();
    expect(await getLatestSpendersObservation(hub, settings.agencyHubDeviceToken))
      .toMatchObject({ outcome: 'fail', pageLabel: null, builtAt: null });
  });

  it('records a failure observation when the board build throws', async () => {
    const { service, settings, kernelSource } = makeKernelHarness();
    const hub = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    // A page-mapping failure makes the kernel build reject with a non-abort error.
    kernelSource.resolvePageLabelForUsername = vi.fn(async () => {
      throw new ChatGooseError('hub_page_match_failed');
    });
    await expect(service.getList(kernelSession(), new AbortController().signal)).rejects.toBeDefined();
    expect(await getLatestSpendersObservation(hub, settings.agencyHubDeviceToken))
      .toMatchObject({ outcome: 'fail', streamState: null });
  });

  it('binds the recorded observation to the bearer (a same-URL credential swap hides it)', async () => {
    // The observation getList records is keyed by hub+bearer, so a different
    // credential on the SAME URL never surfaces the previous board.
    const { service, settings } = makeKernelHarness();
    const hub = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    await service.getList(kernelSession(), new AbortController().signal);
    expect(await getLatestSpendersObservation(hub, settings.agencyHubDeviceToken))
      .toMatchObject({ outcome: 'ok' });
    expect(await getLatestSpendersObservation(hub, 'a-different-key')).toBeNull();
  });

  it('records a FAIL observation when a build-timeout aborts the build', async () => {
    const { service, settings } = makeKernelHarness();
    const hub = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    // The runtime-api timeout handler aborts with an AbortError DOMException whose
    // message carries the reason; the wrapper must treat it as a real board
    // failure, not silently skip it like a user cancel.
    const controller = new AbortController();
    controller.abort(new DOMException(SPENDERS_BUILD_TIMEOUT_REASON, 'AbortError'));
    await expect(service.getList(kernelSession(), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(await getLatestSpendersObservation(hub, settings.agencyHubDeviceToken))
      .toMatchObject({ outcome: 'fail', streamState: null });
  });

  it('does NOT overwrite the observation on a user-cancel / superseded abort', async () => {
    const { service, settings } = makeKernelHarness();
    const hub = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    // Seed the exact source getList uses (creator|hub|sha256(bearer)) with a fresh OK board.
    const sourceIdentity = `creator-1|${spendersObservationScope(hub, settings.agencyHubDeviceToken)}`;
    await recordSpendersObservation({ sourceIdentity, streamState: 'ramped', outcome: 'ok' });
    const controller = new AbortController();
    controller.abort(); // plain cancel — no timeout reason
    await expect(service.getList(kernelSession(), controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    // The cancel recorded nothing, so the seeded OK observation still stands.
    expect(await getLatestSpendersObservation(hub, settings.agencyHubDeviceToken))
      .toMatchObject({ outcome: 'ok', streamState: 'ramped' });
  });

  it('keeps all 1000 returned rows instead of applying a second client-side cutoff', async () => {
    const entries = Array.from({ length: 1000 }, (_, index) => ({
      platformUserId: `fan-${index}`,
      username: `fan${index}`,
      displayName: `Fan ${index}`,
      grossMills: 1_000_000 - index,
    }));
    const { service, fetchTopSpenders } = makeKernelHarness({
      fans: [],
      snapshot: {
        builtAt: '2026-07-05T00:00:00.000Z',
        fanCount: entries.length,
        source: RAMPED_SOURCE,
        entries,
      },
      monthSnapshot: 'throw',
      tuning: { nameSweepBudgetMs: 0 },
    });

    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(fetchTopSpenders).toHaveBeenCalledWith(
      expect.anything(),
      'creator-fs',
      'lifetime',
      1000,
      expect.any(AbortSignal),
    );
    expect(result.entries).toHaveLength(1000);
    expect(result.entries[999]!.fanAccountId).toBe('fan-999');
    expect(result.fanCount).toBe(1000);
  });

  it('does not cache an old-Core fallback that returned only 500 of 694 rows', async () => {
    const entries = Array.from({ length: 500 }, (_, index) => ({
      platformUserId: `fallback-fan-${index}`,
      username: `fallback${index}`,
      displayName: `Fallback Fan ${index}`,
      grossMills: 1_000_000 - index,
    }));
    const { service, fetchTopSpenders } = makeKernelHarness({
      fans: [],
      snapshot: {
        builtAt: '2026-07-05T00:00:00.000Z',
        fanCount: 694,
        source: RAMPED_SOURCE,
        entries,
      },
      monthSnapshot: 'throw',
      tuning: { nameSweepBudgetMs: 0 },
    });
    const sess = kernelSession();

    const first = await service.getList(sess, new AbortController().signal);
    const second = await service.getList(sess, new AbortController().signal);

    expect(first.entries).toHaveLength(500);
    expect(second.entries).toHaveLength(500);
    expect(fetchTopSpenders).toHaveBeenCalledTimes(4);
  });

  it('degrades a failed optional conversation map to lazy chat resolution', async () => {
    const { service, listFanAccounts } = makeKernelHarness();
    listFanAccounts.mockRejectedValueOnce(new Error('inbox temporarily unavailable'));

    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((entry) => entry.groupId === null)).toBe(true);
  });

  it('cuts off a hanging optional conversation map at its focused deadline', async () => {
    vi.useFakeTimers();
    const { service, listFanAccounts } = makeKernelHarness({
      tuning: { chatMapBudgetMs: 25 },
    });
    let started!: () => void;
    const mapStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    listFanAccounts.mockImplementationOnce(async (
      _limit: number,
      _session: SessionTemplate,
      signal: AbortSignal,
    ) => await new Promise<{ fans: Array<{ groupId: string; fanAccountId: string }>; truncated: boolean }>(
      (_resolve, reject) => {
        started();
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      },
    ));

    const build = service.getList(kernelSession(), new AbortController().signal);
    await mapStarted;
    await vi.advanceTimersByTimeAsync(25);
    const result = await build;

    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((entry) => entry.groupId === null)).toBe(true);
  });

  it('does not make an empty kernel board wait for the optional conversation map', async () => {
    const { service, listFanAccounts, getAccountNames } = makeKernelHarness({
      snapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
    });
    let mapSignal: AbortSignal | undefined;
    listFanAccounts.mockImplementationOnce(async (
      _limit: number,
      _session: SessionTemplate,
      signal: AbortSignal,
    ) => {
      mapSignal = signal;
      return await new Promise<{
        fans: Array<{ groupId: string; fanAccountId: string }>;
        truncated: boolean;
      }>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.entries).toEqual([]);
    expect(mapSignal?.aborted).toBe(true);
    expect(getAccountNames).not.toHaveBeenCalled();
  });

  it('keeps session expiry from the conversation map fatal', async () => {
    const { service, listFanAccounts } = makeKernelHarness();
    listFanAccounts.mockRejectedValueOnce(new ChatGooseError('session_expired'));

    await expect(
      service.getList(kernelSession(), new AbortController().signal),
    ).rejects.toMatchObject({ key: 'session_expired' });
  });

  it('observes an early session expiry from the conversation map even for an empty board', async () => {
    const { service, listFanAccounts } = makeKernelHarness({
      snapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
    });
    listFanAccounts.mockRejectedValueOnce(new ChatGooseError('session_expired'));

    await expect(
      service.getList(kernelSession(), new AbortController().signal),
    ).rejects.toMatchObject({ key: 'session_expired' });
  });

  it('keeps a parent abort from the conversation map fatal', async () => {
    const { service, listFanAccounts } = makeKernelHarness();
    const controller = new AbortController();
    let started!: () => void;
    const mapStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    listFanAccounts.mockImplementationOnce(async (
      _limit: number,
      _session: SessionTemplate,
      signal: AbortSignal,
    ) => await new Promise<{ fans: Array<{ groupId: string; fanAccountId: string }>; truncated: boolean }>(
      (_resolve, reject) => {
        started();
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      },
    ));

    const build = service.getList(kernelSession(), controller.signal);
    await mapStarted;
    controller.abort();
    await expect(build).rejects.toMatchObject({ name: 'AbortError' });
  });

  // ── E25: chatter custom names (Fansly rename notes) ──────────────────────

  it('overlays custom names from account notes and backfills platform names', async () => {
    const { service } = makeKernelHarness({
      accounts: [
        {
          id: 'f1',
          username: 'alice',
          displayName: 'Alice',
          notes: [
            { contentType: 12000, note: 'CRM sync blob' },
            { contentType: 12002, note: 'Max/Canada/45' },
          ],
        },
        // The projection knows f2 only by id — the account payload backfills.
        { id: 'f2', username: 'bob_real', displayName: 'Bob', notes: [] },
      ],
    });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.entries[0]).toMatchObject({
      fanAccountId: 'f1',
      customName: 'Max/Canada/45',
      displayName: 'Alice',
    });
    expect(result.entries[1]).toMatchObject({
      fanAccountId: 'f2',
      customName: null,
      displayName: 'Bob',
      username: 'bob_real',
    });
    // Note type 12000 (CRM blobs) is never mistaken for a name.
    expect(result.entries[0]!.customName).not.toContain('CRM');
  });

  it('batches the account lookup and degrades to platform names on failure', async () => {
    const manyEntries = Array.from({ length: 120 }, (_, index) => ({
      platformUserId: `fan-${index}`,
      username: `u${index}`,
      displayName: null,
      grossMills: 1_000_000 - index,
    }));
    const { service, getAccountNames } = makeKernelHarness({
      snapshot: {
        builtAt: '2026-07-05T00:00:00.000Z',
        fanCount: 120,
        source: RAMPED_SOURCE,
        entries: manyEntries,
      },
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
    });
    await service.getList(kernelSession(), new AbortController().signal);

    // 120 fans → 3 batches of ≤50.
    expect(getAccountNames).toHaveBeenCalledTimes(3);
    expect(getAccountNames.mock.calls.every(([ids]) => (ids as string[]).length <= 50)).toBe(true);

    const failing = makeKernelHarness({ accounts: 'throw' });
    const result = await failing.service.getList(kernelSession(), new AbortController().signal);
    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((entry) => entry.customName === null)).toBe(true);
  });

  it('never asks Fansly for a deleted account, and keeps it on the board (E70)', async () => {
    // Fansly does not return deleted accounts at all and the negative answer
    // is not cacheable, so every build re-asked for all 238 of lora-1's dead
    // ids to learn nothing. They still spent money, so they stay in the
    // ranking — only the request goes away.
    const { service, getAccountNames } = makeKernelHarness({
      accounts: [],
      snapshot: {
        builtAt: '2026-07-05T00:00:00.000Z',
        fanCount: 3,
        source: RAMPED_SOURCE,
        entries: [
          { platformUserId: 'f-alive', username: null, displayName: null, grossMills: 900_000 },
          {
            platformUserId: 'f-gone',
            username: null,
            displayName: null,
            grossMills: 500_000,
            deletedAt: '2026-07-20T10:00:00.000Z',
          },
          // No `deletedAt` key at all — an older kernel. Must be swept.
          { platformUserId: 'f-legacy', username: null, displayName: null, grossMills: 100_000 },
        ],
      },
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
    });

    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(getAccountNames).toHaveBeenCalledTimes(1);
    expect(getAccountNames.mock.calls[0]![0]).toEqual(['f-alive', 'f-legacy']);
    expect(result.entries.map((entry) => [entry.fanAccountId, entry.deletedAt])).toEqual([
      ['f-alive', null],
      ['f-gone', '2026-07-20T10:00:00.000Z'],
      ['f-legacy', null],
    ]);
  });

  it('keeps a deleted fan\'s cached custom name — only the request is dropped (E70)', async () => {
    // The sweep gate covers the NETWORK half only. `resolveFanNames` also reads
    // the durable names cache, and that is where a chatter's own rename lives
    // (E25 — the name the team actually recognizes). Gating the whole call
    // would have collapsed a familiar big spender into an anonymous «deleted
    // account» row the moment the kernel marked them deleted, while their spend
    // stayed in the ranking. That is worse than the numeric id it replaced.
    const store = new Map<string, unknown>([
      ['spendersNames', {
        'creator-1': {
          savedAt: Date.now(),
          byId: {
            'f-gone': { customName: 'Max/Canada/45', displayName: null, username: null },
          },
        },
      }],
    ]);
    const localArea = {
      get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      }),
    };
    vi.stubGlobal('browser', {
      storage: {
        local: localArea,
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      },
    });
    const { service, getAccountNames } = makeKernelHarness({
      accounts: [],
      snapshot: {
        builtAt: '2026-07-05T00:00:00.000Z',
        fanCount: 1,
        source: RAMPED_SOURCE,
        entries: [{
          platformUserId: 'f-gone',
          username: null,
          displayName: null,
          grossMills: 500_000,
          deletedAt: '2026-07-20T10:00:00.000Z',
        }],
      },
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
    });

    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(getAccountNames).not.toHaveBeenCalled();
    expect(result.entries[0]!.customName).toBe('Max/Canada/45');
    expect(result.entries[0]!.deletedAt).toBe('2026-07-20T10:00:00.000Z');
  });

  it('skips the sweep entirely when every listed fan is deleted (E70)', async () => {
    const { service, getAccountNames } = makeKernelHarness({
      accounts: [],
      snapshot: {
        builtAt: '2026-07-05T00:00:00.000Z',
        fanCount: 1,
        source: RAMPED_SOURCE,
        entries: [{
          platformUserId: 'f-gone',
          username: null,
          displayName: null,
          grossMills: 500_000,
          deletedAt: '2026-07-20T10:00:00.000Z',
        }],
      },
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
    });

    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(getAccountNames).not.toHaveBeenCalled();
    expect(result.entries).toHaveLength(1);
  });

  it('sweeps names without a retry budget (1.9.1 freeze fix)', async () => {
    const { service, getAccountNames } = makeKernelHarness({ accounts: [] });
    await service.getList(kernelSession(), new AbortController().signal);

    expect(getAccountNames).toHaveBeenCalledWith(
      expect.any(Array),
      expect.anything(),
      expect.anything(),
      'none',
    );
  });

  it('stops the remaining name batches after a rate-limit response', async () => {
    const manyEntries = Array.from({ length: 120 }, (_, index) => ({
      platformUserId: `fan-${index}`,
      username: `u${index}`,
      displayName: null,
      grossMills: 1_000_000 - index,
    }));
    const { service, getAccountNames } = makeKernelHarness({
      snapshot: {
        builtAt: '2026-07-05T00:00:00.000Z',
        fanCount: 120,
        source: RAMPED_SOURCE,
        entries: manyEntries,
      },
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
    });
    getAccountNames.mockRejectedValueOnce(new ChatGooseError('rate_limited'));

    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.entries).toHaveLength(120);
    expect(getAccountNames).toHaveBeenCalledTimes(1);
  });

  it('an exhausted sweep budget ships the board on platform names', async () => {
    const { service, getAccountNames } = makeKernelHarness({
      accounts: [
        { id: 'f1', username: 'alice', displayName: 'Alice', notes: [{ contentType: 12002, note: 'Max' }] },
      ],
      tuning: { nameSweepBudgetMs: 0 },
    });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(getAccountNames).not.toHaveBeenCalled();
    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((entry) => entry.customName === null)).toBe(true);
  });

  it('aborts an in-flight name request at the sweep deadline and ships the board', async () => {
    vi.useFakeTimers();
    const { service, getAccountNames } = makeKernelHarness({
      tuning: { nameSweepBudgetMs: 25 },
    });
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    getAccountNames.mockImplementationOnce(async (
      _ids: string[],
      _session: SessionTemplate,
      signal: AbortSignal,
    ) => await new Promise<FanslyAccountResponse[]>((_resolve, reject) => {
      started();
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    }));

    const build = service.getList(kernelSession(), new AbortController().signal);
    await requestStarted;
    await vi.advanceTimersByTimeAsync(25);
    const result = await build;

    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((entry) => entry.customName === null)).toBe(true);
  });

  it('treats a request-local name AbortError as cosmetic while the parent is live', async () => {
    const { service, getAccountNames } = makeKernelHarness();
    getAccountNames.mockRejectedValueOnce(new DOMException('Request timed out', 'AbortError'));

    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.entries).toHaveLength(3);
    expect(result.entries.every((entry) => entry.customName === null)).toBe(true);
  });

  it('propagates a parent abort during the name sweep', async () => {
    const { service, getAccountNames } = makeKernelHarness();
    const controller = new AbortController();
    let started!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    getAccountNames.mockImplementationOnce(async (
      _ids: string[],
      _session: SessionTemplate,
      signal: AbortSignal,
    ) => await new Promise<FanslyAccountResponse[]>((_resolve, reject) => {
      started();
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    }));

    const build = service.getList(kernelSession(), controller.signal);
    await requestStarted;
    controller.abort();
    await expect(build).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('keeps session expiry from the name sweep fatal and stops later batches', async () => {
    const manyEntries = Array.from({ length: 120 }, (_, index) => ({
      platformUserId: `f${index}`,
      username: `fan${index}`,
      displayName: `Fan ${index}`,
      grossMills: 1_000_000 - index,
    }));
    const { service, getAccountNames } = makeKernelHarness({
      snapshot: {
        builtAt: '2026-07-05T00:00:00.000Z',
        fanCount: manyEntries.length,
        source: RAMPED_SOURCE,
        entries: manyEntries,
      },
    });
    getAccountNames.mockRejectedValueOnce(new ChatGooseError('session_expired'));

    await expect(
      service.getList(kernelSession(), new AbortController().signal),
    ).rejects.toMatchObject({ key: 'session_expired' });
    expect(getAccountNames).toHaveBeenCalledTimes(1);
  });

  it('emits ranking + counted name-sweep progress', async () => {
    const { service } = makeKernelHarness({
      accounts: [{ id: 'f1', username: 'alice', displayName: 'Alice', notes: [] }],
    });
    const frames: Array<{ phase: string; done?: number; total?: number }> = [];
    await service.getList(kernelSession(), new AbortController().signal, {
      onProgress: (progress) => frames.push(progress),
    });

    expect(frames[0]).toMatchObject({ phase: 'ranking' });
    expect(frames.at(-1)).toMatchObject({ phase: 'names', done: 3, total: 3 });
    // The sweep announces its size before doing any work.
    expect(frames.some((frame) => frame.phase === 'names' && frame.done === 0)).toBe(true);
  });

  it('caches resolved names in storage.local — a refresh build does not re-sweep', async () => {
    const store = new Map<string, unknown>();
    const localArea = {
      get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      }),
    };
    const sessionArea = {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => undefined),
    };
    vi.stubGlobal('browser', { storage: { local: localArea, session: sessionArea } });

    const { service, getAccountNames } = makeKernelHarness({
      accounts: [
        { id: 'f1', username: 'alice', displayName: 'Alice', notes: [{ contentType: 12002, note: 'Max/Canada/45' }] },
        { id: 'f2', username: 'bob', displayName: 'Bob', notes: [] },
        { id: 'f-unknown', username: 'ghost', displayName: null, notes: [] },
      ],
    });
    const first = await service.getList(kernelSession(), new AbortController().signal);
    expect(first.entries[0]!.customName).toBe('Max/Canada/45');
    expect(getAccountNames).toHaveBeenCalledTimes(1);

    // Refresh bypasses the BOARD cache but the NAME cache holds: no re-sweep.
    const second = await service.getList(kernelSession(), new AbortController().signal, {
      refresh: true,
    });
    expect(second.entries[0]!.customName).toBe('Max/Canada/45');
    expect(getAccountNames).toHaveBeenCalledTimes(1);

    // The names live in storage.local — they survive a worker/browser restart
    // (a brand-new service instance re-reads them without sweeping).
    const restarted = makeKernelHarness({ accounts: [] });
    const third = await restarted.service.getList(kernelSession(), new AbortController().signal);
    expect(third.entries[0]!.customName).toBe('Max/Canada/45');
    expect(restarted.getAccountNames).not.toHaveBeenCalled();
    expect(localArea.set).toHaveBeenCalled();
  });

  it('compacts an oversized warm name cache to the exact cap without a sweep', async () => {
    const currentNames = {
      f1: { customName: 'Current One', displayName: 'Alice', username: 'alice' },
      f2: { customName: null, displayName: 'Bob', username: 'bob' },
      'f-unknown': { customName: null, displayName: 'Ghost', username: 'ghost' },
    };
    const oldNames = Object.fromEntries(
      Array.from({ length: 2_100 }, (_, index) => [
        `old-${index}`,
        { customName: null, displayName: `Old ${index}`, username: `old${index}` },
      ]),
    );
    const store = new Map<string, unknown>([
      ['spendersNames', {
        'creator-1': {
          savedAt: Date.now(),
          byId: { ...oldNames, ...currentNames },
        },
      }],
    ]);
    const localArea = {
      get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      }),
    };
    vi.stubGlobal('browser', {
      storage: {
        local: localArea,
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      },
    });
    const { service, getAccountNames } = makeKernelHarness();

    await service.getList(kernelSession(), new AbortController().signal);

    expect(getAccountNames).not.toHaveBeenCalled();
    const all = store.get('spendersNames') as Record<string, { byId: Record<string, unknown> }>;
    const capped = all['creator-1']!.byId;
    expect(Object.keys(capped)).toHaveLength(2_000);
    expect(capped).toHaveProperty('f1');
    expect(capped).toHaveProperty('f2');
    expect(capped).toHaveProperty('f-unknown');
  });

  it('serializes and awaits concurrent name-cache writes across creators', async () => {
    const store = new Map<string, unknown>();
    let setCount = 0;
    const localArea = {
      get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        setCount += 1;
        if (setCount === 1) {
          await new Promise((resolve) => globalThis.setTimeout(resolve, 5));
        }
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      }),
    };
    vi.stubGlobal('browser', {
      storage: {
        local: localArea,
        session: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      },
    });
    const accounts: FanslyAccountResponse[] = [
      { id: 'f1', username: 'alice', displayName: 'Alice', notes: [] },
      { id: 'f2', username: 'bob', displayName: 'Bob', notes: [] },
      { id: 'f-unknown', username: 'ghost', displayName: 'Ghost', notes: [] },
    ];
    const first = makeKernelHarness({ accounts });
    const second = makeKernelHarness({ accounts });

    await Promise.all([
      first.service.getList(
        { ...kernelSession(), accountId: 'creator-a' },
        new AbortController().signal,
      ),
      second.service.getList(
        { ...kernelSession(), accountId: 'creator-b' },
        new AbortController().signal,
      ),
    ]);

    const all = store.get('spendersNames') as Record<string, unknown>;
    expect(all).toHaveProperty('creator-a');
    expect(all).toHaveProperty('creator-b');
    expect(localArea.set).toHaveBeenCalledTimes(2);
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

  it('cuts off a hanging optional month query without consuming the global build timeout', async () => {
    vi.useFakeTimers();
    const { service, fetchTopSpenders } = makeKernelHarness({
      tuning: { monthBudgetMs: 25 },
    });
    let started!: () => void;
    const monthStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchTopSpenders.mockImplementation(async (
      _settings: unknown,
      _pageLabel: string,
      window: string,
      _limit: number,
      signal: AbortSignal,
    ) => {
      if (window === 'lifetime') return LIFETIME_SNAPSHOT;
      return await new Promise<KernelSnapshot>((_resolve, reject) => {
        started();
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const build = service.getList(kernelSession(), new AbortController().signal);
    await monthStarted;
    await vi.advanceTimersByTimeAsync(25);
    const result = await build;

    expect(result.entries).toHaveLength(3);
    expect(result.monthWindow).toBeNull();
    expect(result.entries.every((entry) => entry.monthUsd === null)).toBe(true);
  });

  it('treats an enabled-but-not-yet-synced empty month as unknown', async () => {
    const { service } = makeKernelHarness({
      monthSnapshot: {
        builtAt: null,
        fanCount: 0,
        source: { ...RAMPED_SOURCE, lastSyncedAt: null },
        entries: [],
      },
    });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.monthWindow).toBeNull();
    expect(result.entries.map((entry) => entry.monthUsd)).toEqual([null, null, null]);
  });

  it('treats a successfully synced empty month as known zero', async () => {
    const { service } = makeKernelHarness({
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
    });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.monthWindow).toBe(monthWindowFor(Date.now()));
    expect(result.entries.map((entry) => entry.monthUsd)).toEqual([0, 0, 0]);
  });

  it('does not treat a prior-month page sync as proof the current month is complete', async () => {
    const now = new Date();
    const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const previousMonthSync = new Date(currentMonthStart - 1).toISOString();
    const { service } = makeKernelHarness({
      monthSnapshot: {
        builtAt: null,
        fanCount: 0,
        source: { ...RAMPED_SOURCE, lastSyncedAt: previousMonthSync },
        entries: [],
      },
    });

    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.monthWindow).toBeNull();
    expect(result.entries.map((entry) => entry.monthUsd)).toEqual([null, null, null]);
  });

  it('keeps absence unknown when the monthly top-spenders response is truncated', async () => {
    const { service } = makeKernelHarness({
      monthSnapshot: {
        builtAt: '2026-07-05T00:00:00.000Z',
        fanCount: 1001,
        source: RAMPED_SOURCE,
        entries: [
          { platformUserId: 'f1', username: 'alice', displayName: 'Alice', grossMills: 120_000 },
        ],
      },
    });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.entries.map((entry) => entry.monthUsd)).toEqual([120, null, null]);
    expect(result.monthWindow).toBe(monthWindowFor(Date.now()));
  });

  it('does not swallow a parent abort from the best-effort month query', async () => {
    const { service, fetchTopSpenders } = makeKernelHarness();
    const controller = new AbortController();
    let started!: () => void;
    const monthStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    fetchTopSpenders.mockImplementation(async (
      _settings: unknown,
      _pageLabel: string,
      window: string,
      _limit: number,
      signal: AbortSignal,
    ) => {
      if (window === 'lifetime') return LIFETIME_SNAPSHOT;
      return await new Promise<KernelSnapshot>((_resolve, reject) => {
        started();
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const build = service.getList(kernelSession(), controller.signal);
    await monthStarted;
    controller.abort();
    await expect(build).rejects.toMatchObject({ name: 'AbortError' });
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

  it('publishes the lifetime ranking before optional enrichment finishes', async () => {
    const { service, fetchTopSpenders } = makeKernelHarness();
    let releaseMonth!: (snapshot: KernelSnapshot) => void;
    fetchTopSpenders.mockImplementation(async (
      _settings: unknown,
      _pageLabel: string,
      window: string,
    ) => {
      if (window === 'lifetime') return LIFETIME_SNAPSHOT;
      return await new Promise<KernelSnapshot>((resolve) => {
        releaseMonth = resolve;
      });
    });

    const snapshots: SpendersListResult[] = [];
    let finalSettled = false;
    const finalPromise = service.getList(kernelSession(), new AbortController().signal, {
      onSnapshot: (snapshot) => snapshots.push(snapshot.result),
    }).finally(() => {
      finalSettled = true;
    });

    await vi.waitFor(() => expect(snapshots).toHaveLength(1));
    expect(finalSettled).toBe(false);
    expect(snapshots[0]!.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fanAccountId: 'f1',
        groupId: null,
        customName: null,
        monthMills: null,
      }),
    ]));

    releaseMonth(MONTH_SNAPSHOT);
    const final = await finalPromise;
    expect(final.entries[0]).toEqual(expect.objectContaining({
      fanAccountId: 'f1',
      groupId: 'g1',
      monthMills: 120_000,
    }));
  });

  it('single-flights concurrent cold builds and fans out the snapshot', async () => {
    const { service, fetchTopSpenders, listFanAccounts, getAccountNames, kernelSource } =
      makeKernelHarness();
    let releaseMonth!: (snapshot: KernelSnapshot) => void;
    fetchTopSpenders.mockImplementation(async (
      _settings: unknown,
      _pageLabel: string,
      window: string,
    ) => {
      if (window === 'lifetime') return LIFETIME_SNAPSHOT;
      return await new Promise<KernelSnapshot>((resolve) => {
        releaseMonth = resolve;
      });
    });
    const firstSnapshots: SpendersListResult[] = [];
    const secondSnapshots: SpendersListResult[] = [];

    const first = service.getList(kernelSession(), new AbortController().signal, {
      onSnapshot: (snapshot) => firstSnapshots.push(snapshot.result),
    });
    await vi.waitFor(() => expect(firstSnapshots).toHaveLength(1));
    // Join after ranking-ready was already published: the shared build replays
    // the latest usable rows instead of showing another empty spinner.
    const second = service.getList(kernelSession(), new AbortController().signal, {
      onSnapshot: (snapshot) => secondSnapshots.push(snapshot.result),
    });
    await vi.waitFor(() => expect(secondSnapshots).toHaveLength(1));
    releaseMonth(MONTH_SNAPSHOT);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(kernelSource.resolvePageLabelForUsername).toHaveBeenCalledTimes(1);
    expect(fetchTopSpenders).toHaveBeenCalledTimes(2);
    expect(listFanAccounts).toHaveBeenCalledTimes(1);
    expect(getAccountNames).toHaveBeenCalledTimes(1);
    expect(firstSnapshots).toHaveLength(1);
    expect(secondSnapshots).toHaveLength(1);
  });

  it('detaches one aborted cold caller without cancelling another waiter', async () => {
    const { service, fetchTopSpenders } = makeKernelHarness();
    let releaseLifetime!: (snapshot: KernelSnapshot) => void;
    fetchTopSpenders.mockImplementation(async (
      _settings: unknown,
      _pageLabel: string,
      window: string,
    ) => {
      if (window !== 'lifetime') return MONTH_SNAPSHOT;
      return await new Promise<KernelSnapshot>((resolve) => {
        releaseLifetime = resolve;
      });
    });

    const firstController = new AbortController();
    const first = service.getList(kernelSession(), firstController.signal);
    const second = service.getList(kernelSession(), new AbortController().signal);
    await vi.waitFor(() => expect(fetchTopSpenders).toHaveBeenCalledTimes(2));

    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    firstController.abort();
    await firstRejected;
    releaseLifetime(LIFETIME_SNAPSHOT);
    await expect(second).resolves.toMatchObject({ fanCount: 3 });
    expect(fetchTopSpenders).toHaveBeenCalledTimes(2);
  });

  it('detaches a late caller that aborts synchronously during snapshot replay', async () => {
    const { service, fetchTopSpenders } = makeKernelHarness();
    let releaseMonth!: (snapshot: KernelSnapshot) => void;
    fetchTopSpenders.mockImplementation(async (
      _settings: unknown,
      _pageLabel: string,
      window: string,
    ) => {
      if (window === 'lifetime') return LIFETIME_SNAPSHOT;
      return await new Promise<KernelSnapshot>((resolve) => {
        releaseMonth = resolve;
      });
    });

    const first = service.getList(kernelSession(), new AbortController().signal);
    await vi.waitFor(() => expect(releaseMonth).toBeTypeOf('function'));

    const lateController = new AbortController();
    const late = service.getList(kernelSession(), lateController.signal, {
      onSnapshot: () => lateController.abort(),
    });

    await expect(late).rejects.toMatchObject({ name: 'AbortError' });
    releaseMonth(MONTH_SNAPSHOT);
    await expect(first).resolves.toMatchObject({ fanCount: 3 });
    expect(fetchTopSpenders).toHaveBeenCalledTimes(2);
  });

  it('scopes the board cache to the normalized Hub base URL', async () => {
    const { service, settings, fetchTopSpenders } = makeKernelHarness({
      settings: { agencyHubBaseUrl: ' http://localhost:3000/ ' },
    });
    const sess = kernelSession();

    await service.getList(sess, new AbortController().signal);
    settings.agencyHubBaseUrl = 'http://localhost:3000';
    await service.getList(sess, new AbortController().signal);
    expect(fetchTopSpenders).toHaveBeenCalledTimes(2);

    settings.agencyHubBaseUrl = 'https://other-hub.example';
    await service.getList(sess, new AbortController().signal);
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

  it('ignores fresh pre-V4 session snapshots and writes a V4 result', async () => {
    // Every key bump exists because the persisted rows lost a field the app's
    // own types promise: V3 dropped the top-500 coverage assumption, V4 the
    // rows written before `deletedAt` (which would have painted every deleted
    // account as a live fan with a bare numeric id for the whole TTL).
    const staleEntry = {
      'creator-1|legacy': {
        cachedAt: Date.now(),
        result: {
          entries: [],
          builtAt: null,
          source: {
            streamState: 'ramped',
            lastSyncedAt: null,
            consecutiveFailures: 0,
          },
          fanCount: 500,
          monthWindow: null,
          fetchedAt: Date.now(),
        },
      },
    };
    const store = new Map<string, unknown>([
      ['spendersCacheV2', staleEntry],
      ['spendersCacheV3', staleEntry],
    ]);
    const sessionArea = {
      get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      }),
    };
    vi.stubGlobal('browser', { storage: { session: sessionArea } });
    const harness = makeKernelHarness();

    const result = await harness.service.getList(
      kernelSession(),
      new AbortController().signal,
    );

    expect(harness.fetchTopSpenders).toHaveBeenCalledTimes(2);
    expect(result.entries).toHaveLength(3);
    expect(sessionArea.get).not.toHaveBeenCalledWith('spendersCacheV2');
    expect(sessionArea.get).not.toHaveBeenCalledWith('spendersCacheV3');
    expect(store.get('spendersCacheV4')).toBeDefined();
  });

  it('normalises a session snapshot written before pageLabel existed', async () => {
    // storage.session outlives an extension update, and the board cache keeps
    // serving for its whole TTL afterwards. Without normalisation a
    // SpendersListResult would enter the app missing a field its own type
    // declares, and the options row would silently lose the page.
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

    // Rewrite the persisted entry into its pre-change shape — the key is taken
    // from the store rather than reconstructed, so it cannot drift.
    const all = store.get('spendersCacheV4') as Record<string, { result: Record<string, unknown> }>;
    expect(Object.keys(all)).toHaveLength(1);
    for (const entry of Object.values(all)) delete entry.result.pageLabel;
    store.set('spendersCacheV4', all);

    // "Restart": a fresh service instance serves the persisted snapshot.
    const second = makeKernelHarness();
    const result = await second.service.getList(kernelSession(), new AbortController().signal);

    expect(second.fetchTopSpenders).not.toHaveBeenCalled();
    expect(result.pageLabel).toBeNull();
  });

  it('serializes concurrent session-cache writes across creators', async () => {
    const store = new Map<string, unknown>();
    const sessionArea = {
      get: vi.fn(async (key: string) => {
        const snapshot = store.get(key);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1));
        return { [key]: snapshot };
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1));
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      }),
    };
    vi.stubGlobal('browser', { storage: { session: sessionArea } });
    const first = makeKernelHarness();
    const second = makeKernelHarness();

    await Promise.all([
      first.service.getList(
        { ...kernelSession(), accountId: 'creator-a' },
        new AbortController().signal,
      ),
      second.service.getList(
        { ...kernelSession(), accountId: 'creator-b' },
        new AbortController().signal,
      ),
    ]);

    const all = store.get('spendersCacheV4') as Record<string, unknown>;
    expect(Object.keys(all)).toHaveLength(2);
    expect(Object.keys(all).some((key) => key.startsWith('creator-a|'))).toBe(true);
    expect(Object.keys(all).some((key) => key.startsWith('creator-b|'))).toBe(true);
  });

  it('does not let an older same-creator build overwrite a newer cached snapshot', async () => {
    const store = new Map<string, unknown>();
    const sessionArea = {
      get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      }),
    };
    vi.stubGlobal('browser', { storage: { session: sessionArea } });
    const harness = makeKernelHarness();
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let lifetimeCall = 0;
    const oldSnapshot: KernelSnapshot = {
      ...LIFETIME_SNAPSHOT,
      entries: LIFETIME_SNAPSHOT.entries.map((entry, index) =>
        index === 0 ? { ...entry, displayName: 'Old snapshot' } : entry),
    };
    const newSnapshot: KernelSnapshot = {
      ...LIFETIME_SNAPSHOT,
      entries: LIFETIME_SNAPSHOT.entries.map((entry, index) =>
        index === 0 ? { ...entry, displayName: 'New snapshot' } : entry),
    };
    harness.fetchTopSpenders.mockImplementation(async (
      _settings: unknown,
      _pageLabel: string,
      window: string,
    ) => {
      if (window !== 'lifetime') return MONTH_SNAPSHOT;
      lifetimeCall += 1;
      if (lifetimeCall === 1) {
        await oldBlocked;
        return oldSnapshot;
      }
      return newSnapshot;
    });

    const older = harness.service.getList(kernelSession(), new AbortController().signal);
    await vi.waitFor(() => expect(lifetimeCall).toBe(1));
    const newer = await harness.service.getList(
      kernelSession(),
      new AbortController().signal,
      { refresh: true },
    );
    expect(newer.entries[0]!.displayName).toBe('New snapshot');

    releaseOld();
    const oldResult = await older;
    expect(oldResult.entries[0]!.displayName).toBe('Old snapshot');

    const restarted = makeKernelHarness();
    const cached = await restarted.service.getList(
      kernelSession(),
      new AbortController().signal,
    );
    expect(restarted.fetchTopSpenders).not.toHaveBeenCalled();
    expect(cached.entries[0]!.displayName).toBe('New snapshot');
  });

  it('invalidates persisted data and prevents an old in-flight build from restoring it', async () => {
    const store = new Map<string, unknown>();
    const sessionArea = {
      get: vi.fn(async (key: string) => ({ [key]: store.get(key) })),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) store.set(key, value);
      }),
    };
    vi.stubGlobal('browser', { storage: { session: sessionArea } });
    const first = makeKernelHarness();
    let releaseLifetime!: () => void;
    const lifetimeBlocked = new Promise<void>((resolve) => {
      releaseLifetime = resolve;
    });
    first.fetchTopSpenders.mockImplementation(async (
      _settings: unknown,
      _pageLabel: string,
      window: string,
    ) => {
      if (window === 'lifetime') await lifetimeBlocked;
      return window === 'lifetime' ? LIFETIME_SNAPSHOT : MONTH_SNAPSHOT;
    });

    const oldBuild = first.service.getList(kernelSession(), new AbortController().signal);
    await vi.waitFor(() => expect(first.fetchTopSpenders).toHaveBeenCalledTimes(2));
    const oldBuildRejected = expect(oldBuild).rejects.toMatchObject({ name: 'AbortError' });
    await first.service.invalidateAll();
    releaseLifetime();
    await oldBuildRejected;

    expect(store.get('spendersCacheV4')).toEqual({});
    const restarted = makeKernelHarness();
    await restarted.service.getList(kernelSession(), new AbortController().signal);
    expect(restarted.fetchTopSpenders).toHaveBeenCalledTimes(2);
  });

  it('aborts both Refresh and the cold build it superseded on invalidation', async () => {
    const harness = makeKernelHarness();
    const lifetimeSignals: AbortSignal[] = [];
    harness.fetchTopSpenders.mockImplementation(async (
      _settings: unknown,
      _pageLabel: string,
      window: string,
      _limit: number,
      signal: AbortSignal,
    ) => {
      if (window !== 'lifetime') return MONTH_SNAPSHOT;
      lifetimeSignals.push(signal);
      return await new Promise<KernelSnapshot>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        );
      });
    });

    const cold = harness.service.getList(kernelSession(), new AbortController().signal);
    await vi.waitFor(() => expect(lifetimeSignals).toHaveLength(1));
    const refresh = harness.service.getList(
      kernelSession(),
      new AbortController().signal,
      { refresh: true },
    );
    await vi.waitFor(() => expect(lifetimeSignals).toHaveLength(2));

    const coldRejected = expect(cold).rejects.toMatchObject({ name: 'AbortError' });
    const refreshRejected = expect(refresh).rejects.toMatchObject({ name: 'AbortError' });
    await harness.service.invalidateAll();

    await Promise.all([coldRejected, refreshRejected]);
    expect(lifetimeSignals.every((signal) => signal.aborted)).toBe(true);
  });

  // ── W9.3/A20: not-ramped pages (kernel builtAt null) ─────────────────────

  it('propagates a null builtAt verbatim instead of inventing "now"', async () => {
    const { service } = makeKernelHarness({
      snapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
    });
    const result = await service.getList(kernelSession(), new AbortController().signal);

    expect(result.builtAt).toBeNull();
    expect(result.entries).toEqual([]);
    expect(result.fanCount).toBe(0);
    expect(result.source.streamState).toBe('ramped');
  });

  it('caches a ramped, successfully synced empty snapshot', async () => {
    const { service, fetchTopSpenders } = makeKernelHarness({
      snapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
    });
    const sess = kernelSession();

    await service.getList(sess, new AbortController().signal);
    await service.getList(sess, new AbortController().signal);

    expect(fetchTopSpenders).toHaveBeenCalledTimes(2);
  });

  it('never caches a disabled result — every open re-asks the kernel', async () => {
    const { service, kernelSource, fetchTopSpenders } = makeKernelHarness({
      snapshot: {
        builtAt: null,
        fanCount: 0,
        source: { ...RAMPED_SOURCE, streamState: 'flag_off', lastSyncedAt: null },
        entries: [],
      },
      monthSnapshot: { builtAt: null, fanCount: 0, source: RAMPED_SOURCE, entries: [] },
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
      source: RAMPED_SOURCE,
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
