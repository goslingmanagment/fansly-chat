import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpendersService } from '../src/background/spenders-service.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
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
