import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { ChatMuseError } from '../src/shared/errors.js';
import type {
  BackgroundPortMessage,
  FanSubscriptionContext,
  NormalizedTranscriptMessage,
} from '../src/shared/types.js';

let mockStorage: Record<string, unknown> = {};
let currentNow = 1_700_000_000_000;

const SESSION_CAPTURE = {
  accountId: 'account-1',
  authorization: 'Bearer token',
  fanslyClientId: 'client-id',
  fanslySessionId: 'session-id',
  fanslyClientTs: '123',
  fanslyClientCheck: 'route-check',
  routeKey: 'group' as const,
};

function buildTranscriptMessages(count: number): NormalizedTranscriptMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index + 1}`,
    createdAt: 1_000 + index,
    senderId: index % 2 === 0 ? 'account-1' : 'fan-1',
    senderLabel: index % 2 === 0 ? 'Model' : 'Fan',
    type: 1,
    text: `message ${index + 1}`,
    labels: [],
  }));
}

function buildSubscriptionContext(): FanSubscriptionContext {
  return {
    source: '/api/v1/subscribers',
    subscriptionId: 'sub-1',
    subscriberAccountId: 'fan-1',
    status: 3,
    subscriptionTierId: 'tier-1',
    subscriptionTierName: 'VIP',
    planId: 'plan-1',
    price: 1200,
    renewPrice: 1200,
    autoRenew: true,
    billingCycle: 30,
    giftCodeId: null,
    promoId: null,
    promoPrice: null,
    promoDuration: null,
    promoStatus: null,
    promoStartsAtIso: null,
    promoEndsAtIso: null,
    renewDateIso: null,
    endsAtIso: null,
    createdAtIso: '2026-03-01T00:00:00.000Z',
  };
}

function buildFanslyClientMock() {
  return {
    getAuthenticatedAccountId: vi.fn(async () => 'account-1'),
    loadMessages: vi.fn(async () => ({
      transcriptMessages: buildTranscriptMessages(30),
      windowStartMs: 0,
      pagesLoaded: 2,
      targetPages: 2,
    })),
    getGroup: vi.fn(async () => ({
      users: [{ userId: 'account-1' }, { userId: 'fan-1' }],
    })),
    getAccountNames: vi.fn(async () => [
      {
        id: 'fan-1',
        username: 'alice',
        displayName: 'Alice',
      },
    ]),
    getEarnings: vi.fn(async () => null),
    getFanSubscriptionContext: vi.fn(
      async (): Promise<FanSubscriptionContext | null> => null,
    ),
  };
}

function advanceNow(ms: number): number {
  currentNow += ms;
  return currentNow;
}

function postedMessages(port: { postMessage: ReturnType<typeof vi.fn> }): BackgroundPortMessage[] {
  return port.postMessage.mock.calls.map(([message]) => message as BackgroundPortMessage);
}

async function createCoordinatorHarness(options?: {
  anthropicRawText?: string;
  fanslyClient?: ReturnType<typeof buildFanslyClientMock>;
  anthropicClient?: { streamMessage: ReturnType<typeof vi.fn> };
}) {
  const [{ OperationCoordinator }, { SessionStore }, { TabContextStore }] =
    await Promise.all([
      import('../src/background/operations.js'),
      import('../src/background/session-store.js'),
      import('../src/background/tab-context.js'),
    ]);

  const sessionStore = new SessionStore();
  sessionStore.registerCapture(1, SESSION_CAPTURE);

  const fanslyClient = options?.fanslyClient ?? buildFanslyClientMock();
  const anthropicClient = options?.anthropicClient ?? {
    streamMessage: vi.fn(async () => options?.anthropicRawText ?? 'Result'),
  };

  const coordinator = new OperationCoordinator(
    sessionStore,
    new TabContextStore(),
    fanslyClient as never,
    anthropicClient as never,
  ) as any;
  const port = { postMessage: vi.fn() };

  coordinator.portsByTabId.set(1, port);

  return { coordinator, fanslyClient, anthropicClient, port };
}

describe('OperationCoordinator', () => {
  beforeEach(() => {
    vi.resetModules();
    currentNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => currentNow);
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: {
        claudeApiKey: 'sk-test',
        quickMessageCount: 100,
        deepMessageCount: 500,
        debugMode: false,
      },
      personalities: [
        {
          id: 'personality-1',
          name: 'Closer',
          content: 'Sell smoothly',
          updatedAt: 1000,
        },
      ],
      accountMappings: {
        'account-1': 'personality-1',
      },
      knownAccounts: [],
      'summary:group-1': {
        summary: 'Old summary',
        personalityId: 'personality-1',
        personalityUpdatedAt: 1000,
        generatedAt: 2000,
        spendingDataVerified: true,
        subscriptionLookupVerified: true,
      },
    };

    (globalThis as Record<string, unknown>).browser = {
      storage: {
        local: {
          get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
            if (keys === null || keys === undefined) {
              return { ...mockStorage };
            }
            if (typeof keys === 'string') {
              return { [keys]: mockStorage[keys] };
            }
            if (Array.isArray(keys)) {
              const result: Record<string, unknown> = {};
              for (const key of keys) {
                result[key] = mockStorage[key];
              }
              return result;
            }
            return {};
          }),
          set: vi.fn(async (items: Record<string, unknown>) => {
            Object.assign(mockStorage, items);
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              delete mockStorage[key];
            }
          }),
        },
      },
      tabs: {
        get: vi.fn(async () => ({
          url: 'https://fansly.com/messages/group-1',
        })),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removes the durable summary cache before a forced fan-summary refresh', async () => {
    const { coordinator } = await createCoordinatorHarness({
      anthropicRawText: 'Fresh summary',
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: true,
    });

    expect((globalThis as any).browser.storage.local.remove).toHaveBeenCalledWith('summary:group-1');
  });

  it('uses cache-only subscription lookup for fast-reply and proceeds without subscription data on cache miss', async () => {
    const fanslyClient = buildFanslyClientMock();
    const { coordinator, anthropicClient } = await createCoordinatorHarness({
      anthropicRawText: 'hey babe',
      fanslyClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'reply-op',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    expect(fanslyClient.getFanSubscriptionContext).toHaveBeenCalledWith(
      'group-1',
      'fan-1',
      expect.objectContaining({ accountId: 'account-1' }),
      expect.anything(),
      'cache-only',
    );
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
    expect(anthropicClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'fast-reply',
        user: expect.not.stringContaining('## Fan Subscription Data'),
      }),
    );
  });

  it('uses full subscription lookup for deep features and still includes subscription data in the prompt', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(
      buildSubscriptionContext(),
    );
    const { coordinator, anthropicClient } = await createCoordinatorHarness({
      anthropicRawText:
        '<rating>7</rating><evaluation>Solid</evaluation><recommendations>Keep going</recommendations>',
      fanslyClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'review-op',
      feature: 'chat-review',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    expect(fanslyClient.getFanSubscriptionContext).toHaveBeenCalledWith(
      'group-1',
      'fan-1',
      expect.objectContaining({ accountId: 'account-1' }),
      expect.anything(),
      'full',
    );
    expect(anthropicClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'chat-review',
        user: expect.stringContaining('## Fan Subscription Data'),
      }),
    );
  });

  it('omits profiling data from progress and completion payloads when debug mode is off', async () => {
    const fanslyClient = buildFanslyClientMock();
    const { coordinator, port } = await createCoordinatorHarness({
      anthropicRawText: 'hello there',
      fanslyClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'reply-op',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    const messages = postedMessages(port);
    const progressMessages = messages.filter(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:progress' }> =>
        message.type === 'operation:progress',
    );
    expect(progressMessages).toHaveLength(2);
    expect(progressMessages.map((message) => message.phase)).toEqual([
      'loading-messages',
      'generating',
    ]);
    expect(progressMessages.some((message) => message.currentPage !== undefined)).toBe(false);
    const nonDebugLoadMessagesArgs = fanslyClient.loadMessages.mock.calls[0] as unknown[];
    expect(nonDebugLoadMessagesArgs?.[5]).toBeUndefined();
    expect(fanslyClient.getFanSubscriptionContext).toHaveBeenCalledWith(
      'group-1',
      'fan-1',
      expect.objectContaining({ accountId: 'account-1' }),
      expect.anything(),
      'cache-only',
    );
    for (const message of messages) {
      if (
        message.type === 'operation:progress' ||
        message.type === 'operation:complete' ||
        message.type === 'operation:error' ||
        message.type === 'operation:discarded'
      ) {
        expect(message).not.toHaveProperty('profiling');
      }
    }
  });

  it('omits profiling data from non-debug error payloads', async () => {
    const nowSeconds = Math.floor(currentNow / 1000);
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockResolvedValue({
      transcriptMessages: [
        {
          id: 'message-1',
          createdAt: nowSeconds - 20,
          senderId: 'account-1',
          senderLabel: 'Model',
          type: 1,
          text: 'hello',
          labels: [],
        },
        {
          id: 'message-2',
          createdAt: nowSeconds - 5,
          senderId: 'fan-1',
          senderLabel: 'Fan',
          type: 1,
          text: 'hey?',
          labels: [],
        },
      ],
      windowStartMs: 0,
      pagesLoaded: 1,
      targetPages: 1,
    });
    const { coordinator, port } = await createCoordinatorHarness({
      fanslyClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'ping-op',
      feature: 'ping',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );

    expect(errorMessage?.error.code).toBe('ping_blocked');
    expect(errorMessage).not.toHaveProperty('profiling');
  });

  it('preserves non-debug deep-feature page progress without profiling snapshots', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockImplementation(async (...args: any[]) => {
      const onProgress = args[5] as
        | ((progress: {
            currentPage: number;
            targetPages: number;
            pageMessageCount: number;
            collectedCount: number;
          }) => void)
        | undefined;
      onProgress?.({
        currentPage: 1,
        targetPages: 2,
        pageMessageCount: 25,
        collectedCount: 25,
      });
      onProgress?.({
        currentPage: 2,
        targetPages: 2,
        pageMessageCount: 5,
        collectedCount: 30,
      });
      return {
        transcriptMessages: buildTranscriptMessages(30),
        windowStartMs: 0,
        pagesLoaded: 2,
        targetPages: 2,
      };
    });

    const { coordinator, port } = await createCoordinatorHarness({
      anthropicRawText:
        '<rating>7</rating><evaluation>Solid</evaluation><recommendations>Keep going</recommendations>',
      fanslyClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'review-op',
      feature: 'chat-review',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    const progressMessages = postedMessages(port).filter(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:progress' }> =>
        message.type === 'operation:progress',
    );

    expect(progressMessages).toHaveLength(4);
    expect(progressMessages.map((message) => message.phase)).toEqual([
      'loading-messages',
      'loading-messages',
      'loading-messages',
      'generating',
    ]);
    expect(progressMessages[1]).toMatchObject({
      currentPage: 1,
      targetPages: 2,
      message: 'Loading messages… 1/2 pages',
    });
    expect(progressMessages[2]).toMatchObject({
      currentPage: 2,
      targetPages: 2,
      message: 'Loading messages… 2/2 pages',
    });
    const deepFeatureLoadMessagesArgs = fanslyClient.loadMessages.mock.calls[0] as unknown[];
    expect(typeof deepFeatureLoadMessagesArgs?.[5]).toBe('function');
    expect(fanslyClient.getFanSubscriptionContext).toHaveBeenCalledWith(
      'group-1',
      'fan-1',
      expect.objectContaining({ accountId: 'account-1' }),
      expect.anything(),
      'full',
    );
    expect(progressMessages.some((message) => 'profiling' in message)).toBe(false);
  });

  it('omits profiling data from non-debug discarded payloads on cancel', async () => {
    let resolveStreamStarted: (() => void) | null = null;
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });
    const anthropicClient = {
      streamMessage: vi.fn(
        ({ signal }: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => {
          resolveStreamStarted?.();
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      anthropicClient,
    });

    const startPromise = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'reply-op',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    await streamStarted;
    await coordinator.cancelOperation(1, undefined, true);
    await startPromise;

    const messages = postedMessages(port);
    const discardedMessage = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:discarded' }> =>
        message.type === 'operation:discarded',
    );

    expect(discardedMessage?.error.code).toBe('chat_changed');
    expect(discardedMessage).not.toHaveProperty('profiling');
    expect(messages.some((message) => message.type === 'operation:error')).toBe(false);
  });

  it('includes profiling snapshots in debug mode and records the main stage breakdown', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getAuthenticatedAccountId.mockImplementation(async () => {
      advanceNow(50);
      return 'account-1';
    });
    fanslyClient.loadMessages.mockImplementation(async (...args: any[]) => {
      const onProgress = args[5] as
        | ((progress: {
            currentPage: number;
            targetPages: number;
            pageMessageCount: number;
            collectedCount: number;
          }) => void)
        | undefined;
      advanceNow(150);
      onProgress?.({
        currentPage: 1,
        targetPages: 2,
        pageMessageCount: 25,
        collectedCount: 25,
      });
      advanceNow(250);
      onProgress?.({
        currentPage: 2,
        targetPages: 2,
        pageMessageCount: 5,
        collectedCount: 30,
      });
      advanceNow(100);
      return {
        transcriptMessages: buildTranscriptMessages(30),
        windowStartMs: 0,
        pagesLoaded: 2,
        targetPages: 2,
      };
    });
    fanslyClient.getGroup.mockImplementation(async () => {
      advanceNow(80);
      return { users: [{ userId: 'account-1' }, { userId: 'fan-1' }] };
    });
    fanslyClient.getAccountNames.mockImplementation(async () => {
      advanceNow(40);
      return [{ id: 'fan-1', username: 'alice', displayName: 'Alice' }];
    });
    fanslyClient.getEarnings.mockImplementation(async () => {
      advanceNow(90);
      return null;
    });
    fanslyClient.getFanSubscriptionContext.mockImplementation(async (...args: any[]) => {
      const onTrace = args[5] as ((event: { type: string }) => void) | undefined;
      onTrace?.({ type: 'cache-miss' });
      advanceNow(30);
      onTrace?.({ type: 'cache-only-skip' });
      return null;
    });

    const anthropicClient = {
      streamMessage: vi.fn(async ({ onText }: { onText: (text: string) => void }) => {
        advanceNow(200);
        onText('Hello');
        advanceNow(250);
        onText(' there');
        advanceNow(120);
        return 'Hello there';
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({
      fanslyClient,
      anthropicClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'reply-op',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    const messages = postedMessages(port);
    const progressMessages = messages.filter(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:progress' }> =>
        message.type === 'operation:progress',
    );
    const completeMessage = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(progressMessages.some((message) => Boolean(message.profiling))).toBe(true);
    expect(completeMessage?.profiling).toBeDefined();
    expect(completeMessage?.profiling?.logEntries.some((entry) => entry.message.includes('Loaded messages page 1/2'))).toBe(true);
    expect(completeMessage?.profiling?.stages.map((stage) => stage.key)).toEqual([
      'resolve-identity',
      'load-messages',
      'group-lookup',
      'account-name-lookup',
      'earnings',
      'subscription-lookup',
      'prompt-build',
      'claude-ttfb',
      'claude-stream',
    ]);
    expect(completeMessage?.profiling?.stages.find((stage) => stage.key === 'claude-ttfb')).toMatchObject({
      status: 'completed',
      detail: 'first chunk received',
    });
    expect(completeMessage?.profiling?.stages.find((stage) => stage.key === 'claude-stream')).toMatchObject({
      status: 'completed',
      detail: '11 chars',
    });
    expect(completeMessage?.profiling?.stages.find((stage) => stage.key === 'subscription-lookup')?.detail).toContain('cache miss -> cache-only skip');
  });

  it('includes partial profiling data on error in debug mode', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const anthropicClient = {
      streamMessage: vi.fn(async () => {
        advanceNow(300);
        throw new ChatMuseError('network_error');
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      anthropicClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'reply-op',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );

    expect(errorMessage?.profiling).toBeDefined();
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'claude-ttfb')).toMatchObject({
      status: 'failed',
      detail: 'operation failed',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'claude-stream')).toBeUndefined();
  });

  it('includes profiling data on timeout/abort in debug mode', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const anthropicClient = {
      streamMessage: vi.fn(async () => {
        advanceNow(300);
        throw new DOMException('Aborted', 'AbortError');
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      anthropicClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'reply-op',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );

    expect(errorMessage?.error.code).toBe('timed_out');
    expect(errorMessage?.profiling).toBeDefined();
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'claude-ttfb')).toMatchObject({
      status: 'failed',
      detail: 'operation failed',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'claude-stream')).toBeUndefined();
  });

  it('returns profiling data for ping_blocked before Claude work starts', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const nowSeconds = Math.floor(currentNow / 1000);
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockResolvedValue({
      transcriptMessages: [
        {
          id: 'message-1',
          createdAt: nowSeconds - 20,
          senderId: 'account-1',
          senderLabel: 'Model',
          type: 1,
          text: 'hello',
          labels: [],
        },
        {
          id: 'message-2',
          createdAt: nowSeconds - 5,
          senderId: 'fan-1',
          senderLabel: 'Fan',
          type: 1,
          text: 'hey?',
          labels: [],
        },
      ],
      windowStartMs: 0,
      pagesLoaded: 1,
      targetPages: 1,
    });

    const { coordinator, port } = await createCoordinatorHarness({
      fanslyClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'ping-op',
      feature: 'ping',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );

    expect(errorMessage?.error.code).toBe('ping_blocked');
    expect(errorMessage?.profiling?.stages.map((stage) => stage.key)).toEqual([
      'resolve-identity',
      'load-messages',
      'ping-analysis',
    ]);
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'ping-analysis')?.detail).toBe('active');
  });

  it('returns summary-cache profiling for fan summary cache hits in debug mode', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const { coordinator, port, fanslyClient, anthropicClient } = await createCoordinatorHarness();

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(completeMessage?.result.summaryMeta).toMatchObject({ cached: true });
    expect(completeMessage?.profiling?.stages.map((stage) => stage.key)).toEqual([
      'resolve-identity',
      'summary-cache-check',
    ]);
    expect(completeMessage?.profiling?.stages.find((stage) => stage.key === 'summary-cache-check')).toMatchObject({
      status: 'completed',
      detail: 'cache hit',
    });
    expect(fanslyClient.loadMessages).not.toHaveBeenCalled();
    expect(anthropicClient.streamMessage).not.toHaveBeenCalled();
  });
});
