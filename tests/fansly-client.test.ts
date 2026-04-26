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
    vi.useRealTimers();
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

  it('aborts immediately when retry backoff starts with an already-aborted signal', async () => {
    vi.useFakeTimers();
    const { client, session } = createClientHarness();
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort();
      return new Response('retry later', { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    let settledError: unknown;
    void client
      .getMessagePage('group-1', null, session, controller.signal)
      .catch((error) => {
        settledError = error;
      });

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(settledError).toBeInstanceOf(DOMException);
    expect((settledError as DOMException | undefined)?.name).toBe('AbortError');
  });
});

describe('FanslyClient getMonthlyEarnings', () => {
  afterEach(() => {
    vi.useRealTimers();
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

describe('FanslyClient media purchase verification', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('treats a type-less exact single orderhistory row as purchased', async () => {
    const { client, session } = createClientHarness();
    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      expect(href).toContain('/media/orderhistory');
      expect(href).toContain('accountMediaId=media-1');
      expect(href).toContain('accountIds=fan-1');
      return jsonSuccessResponse({
        accountMediaOrderHistory: [
          { accountId: 'fan-1', accountMediaId: 'media-1' },
        ],
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.verifyMediaPurchaseStates(
      [{ kind: 'single', contentId: 'media-1' }],
      'fan-1',
      session,
      new AbortController().signal,
    );

    expect(Array.from(result.purchasedSingleIds ?? [])).toEqual(['media-1']);
    expect(Array.from(result.checkedNotPurchasedSingleIds ?? [])).toEqual([]);
  });

  it('treats an explicit type-less accountMediaBundleId orderhistory row as purchased', async () => {
    const { client, session } = createClientHarness();
    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      expect(href).toContain('/media/orderhistory');
      expect(href).toContain('accountMediaBundleId=bundle-1');
      expect(href).toContain('accountIds=fan-1');
      return jsonSuccessResponse({
        aggregationData: {
          accountMediaOrders: [
            { accountId: 'fan-1', accountMediaBundleId: 'bundle-1' },
          ],
        },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.verifyMediaPurchaseStates(
      [{ kind: 'bundle', contentId: 'bundle-1' }],
      'fan-1',
      session,
      new AbortController().signal,
    );

    expect(Array.from(result.purchasedBundleIds ?? [])).toEqual(['bundle-1']);
    expect(Array.from(result.checkedNotPurchasedBundleIds ?? [])).toEqual([]);
  });

  it('returns checked not purchased for a successful exact empty orderhistory result', async () => {
    const { client, session } = createClientHarness();
    const fetchMock = vi.fn(async () =>
      jsonSuccessResponse({ accountMediaOrderHistory: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.verifyMediaPurchaseStates(
      [{ kind: 'single', contentId: 'media-1' }],
      'fan-1',
      session,
      new AbortController().signal,
    );

    expect(Array.from(result.purchasedSingleIds ?? [])).toEqual([]);
    expect(Array.from(result.checkedNotPurchasedSingleIds ?? [])).toEqual(['media-1']);
    expect(result.verificationIncomplete).toBe(false);
  });

  it('does not credit mismatched orderhistory rows and still treats the exact check as not purchased', async () => {
    const { client, session } = createClientHarness();
    const fetchMock = vi.fn(async () =>
      jsonSuccessResponse({
        accountMediaOrderHistory: [
          { accountId: 'fan-other', accountMediaId: 'media-1' },
          { accountId: 'fan-1', accountMediaId: 'other-media' },
          { accountId: 'fan-1', accountMediaId: 'media-1', type: 2 },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.verifyMediaPurchaseStates(
      [{ kind: 'single', contentId: 'media-1' }],
      'fan-1',
      session,
      new AbortController().signal,
    );

    expect(Array.from(result.purchasedSingleIds ?? [])).toEqual([]);
    expect(Array.from(result.checkedNotPurchasedSingleIds ?? [])).toEqual(['media-1']);
  });

  it('fails open to unknown evidence on verifier errors', async () => {
    const { client, session } = createClientHarness();
    const fetchMock = vi.fn(async () => {
      throw new Error('network down');
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.verifyMediaPurchaseStates(
      [{ kind: 'single', contentId: 'media-1' }],
      'fan-1',
      session,
      new AbortController().signal,
    );

    expect(Array.from(result.purchasedSingleIds ?? [])).toEqual([]);
    expect(Array.from(result.checkedNotPurchasedSingleIds ?? [])).toEqual([]);
    expect(result.verificationIncomplete).toBe(true);
  });

  it('fails open to unknown evidence on malformed orderhistory responses', async () => {
    const { client, session } = createClientHarness();
    const fetchMock = vi.fn(async () => jsonSuccessResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    const result = await client.verifyMediaPurchaseStates(
      [{ kind: 'bundle', contentId: 'bundle-1' }],
      'fan-1',
      session,
      new AbortController().signal,
    );

    expect(Array.from(result.purchasedBundleIds ?? [])).toEqual([]);
    expect(Array.from(result.checkedNotPurchasedBundleIds ?? [])).toEqual([]);
    expect(result.verificationIncomplete).toBe(true);
  });
});
