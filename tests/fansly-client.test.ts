import { afterEach, describe, expect, it, vi } from 'vitest';
import { FanslyClient } from '../src/background/fansly-client.js';
import { SessionStore } from '../src/background/session-store.js';
import type { FanslySubscriberSubscriptionRecord, MonthlyEarningsRow } from '../src/shared/types.js';

const SESSION_CAPTURE = {
  accountId: 'account-1',
  authorization: 'Bearer token',
  fanslyClientId: 'client-id',
  fanslySessionId: 'session-id',
  fanslyClientTs: '123',
  fanslyClientCheck: 'route-check',
  routeKey: 'group' as const,
};

const SUBSCRIPTION_RECORD: FanslySubscriberSubscriptionRecord = {
  id: 'sub-1',
  subscriberId: 'fan-1',
  subscriptionTierId: 'tier-1',
  subscriptionTierName: 'VIP',
  planId: 'plan-1',
  status: 3,
  price: 1200,
  renewPrice: 1200,
  autoRenew: 1,
  billingCycle: 30,
  giftCodeId: null,
  promoId: null,
  promoPrice: null,
  promoDuration: null,
  promoStatus: null,
  promoStartsAt: null,
  promoEndsAt: null,
  renewDate: 1_730_000_000_000,
  endsAt: 1_731_000_000_000,
  createdAt: 1_720_000_000_000,
};

function jsonSuccessResponse(response: unknown): Response {
  return new Response(JSON.stringify({ success: true, response }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function createClientHarness() {
  const sessionStore = new SessionStore();
  sessionStore.registerCapture(1, SESSION_CAPTURE);
  const session = sessionStore.getSessionForTab(1);

  if (!session) {
    throw new Error('Missing session');
  }

  return {
    client: new FanslyClient(sessionStore),
    session,
  };
}

describe('FanslyClient subscription lookup modes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('uses cached subscription context in cache-only mode without fetching', async () => {
    const { client, session } = createClientHarness();
    const fetchMock = vi.fn(async () =>
      jsonSuccessResponse({
        data: [{ groupId: 'group-1', partnerAccountId: 'fan-1' }],
        aggregationData: {
          accounts: [{ id: 'fan-1', subscriberSubscription: SUBSCRIPTION_RECORD }],
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const fullResult = await client.getFanSubscriptionContext(
      'group-1',
      'fan-1',
      session,
      new AbortController().signal,
      'full',
    );

    expect(fullResult).toEqual(
      expect.objectContaining({
        source: '/api/v1/messaging/groups',
        subscriptionId: 'sub-1',
        subscriberAccountId: 'fan-1',
      }),
    );

    fetchMock.mockClear();

    const cachedResult = await client.getFanSubscriptionContext(
      'group-1',
      'fan-1',
      session,
      new AbortController().signal,
      'cache-only',
    );

    expect(cachedResult).toEqual(fullResult);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null on a cache-only miss without touching subscription endpoints', async () => {
    const { client, session } = createClientHarness();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.getFanSubscriptionContext(
      'group-1',
      'fan-1',
      session,
      new AbortController().signal,
      'cache-only',
    );

    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps full lookup fallback through subscribers and caches the resolved result', async () => {
    const { client, session } = createClientHarness();
    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);

      if (href.includes('/messaging/groups')) {
        return jsonSuccessResponse({ data: [] });
      }

      if (href.includes('/subscribers')) {
        return jsonSuccessResponse({
          stats: {
            totalActive: 1,
            totalExpired: 0,
            total: 1,
          },
          subscriptions: [SUBSCRIPTION_RECORD],
        });
      }

      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const fullResult = await client.getFanSubscriptionContext(
      'group-1',
      'fan-1',
      session,
      new AbortController().signal,
      'full',
    );

    expect(fullResult).toEqual(
      expect.objectContaining({
        source: '/api/v1/subscribers',
        subscriptionId: 'sub-1',
        subscriberAccountId: 'fan-1',
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/messaging/groups');
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/subscribers');

    fetchMock.mockClear();

    const cachedResult = await client.getFanSubscriptionContext(
      'group-1',
      'fan-1',
      session,
      new AbortController().signal,
      'cache-only',
    );

    expect(cachedResult).toEqual(fullResult);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('FanslyClient getMonthlyEarnings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns monthly rows from monthlystats endpoint', async () => {
    const { client, session } = createClientHarness();
    const rows: MonthlyEarningsRow[] = [
      { year: 2026, month: 2, totalGross: 195000, totalNet: 156000, accountId: 'a', correlationAccountId: 'fan-1', timestamp: 1 },
      { year: 2026, month: 1, totalGross: 400000, totalNet: 320000, accountId: 'a', correlationAccountId: 'fan-1', timestamp: 2 },
    ];
    const fetchMock = vi.fn(async () => jsonSuccessResponse(rows));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.getMonthlyEarnings(
      'fan-1',
      0,
      Date.now(),
      session,
      new AbortController().signal,
    );

    expect(result).toEqual(rows);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String((fetchMock.mock.calls as unknown[][])[0]?.[0]);
    expect(url).toContain('/monthlystats/accounts');
    expect(url).toContain('correlationAccountId=fan-1');
  });

  it('returns empty array when API returns no data', async () => {
    const { client, session } = createClientHarness();
    const fetchMock = vi.fn(async () => jsonSuccessResponse([]));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.getMonthlyEarnings(
      'fan-1',
      0,
      Date.now(),
      session,
      new AbortController().signal,
    );

    expect(result).toEqual([]);
  });
});
