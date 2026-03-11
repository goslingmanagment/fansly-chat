import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MODEL_ID, DEFAULT_FEATURE_MODELS, STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { ChatMuseError } from '../src/shared/errors.js';
import { flattenPromptBlocks } from '../src/shared/prompts.js';
import type {
  AggregatedEarnings,
  BackgroundPortMessage,
  CompareModelCard,
  FanSubscriptionContext,
  MonthlyEarningsRow,
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
    getEarnings: vi.fn(async (): Promise<AggregatedEarnings | null> => null),
    getMonthlyEarnings: vi.fn(async (): Promise<MonthlyEarningsRow[]> => []),
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

function flattenUserBlocksFromStreamCall(
  anthropicClient: { streamMessage: ReturnType<typeof vi.fn> },
  callIndex = 0,
): string {
  return flattenPromptBlocks(
    anthropicClient.streamMessage.mock.calls[callIndex]?.[0].userBlocks ?? [],
  );
}

function flattenSystemBlocksFromStreamCall(
  anthropicClient: { streamMessage: ReturnType<typeof vi.fn> },
  callIndex = 0,
): string {
  return flattenPromptBlocks(
    anthropicClient.streamMessage.mock.calls[callIndex]?.[0].systemBlocks ?? [],
  );
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
  const port = {
    postMessage: vi.fn(),
    onDisconnect: { addListener: vi.fn() },
  };

  coordinator.portsByTabId.set(1, port);

  return { coordinator, fanslyClient, anthropicClient, port };
}

function mockCompareCards(cards: CompareModelCard[]) {
  vi.doMock('../src/shared/compare-cards.js', () => ({
    getCompareDraftCount: () => cards.filter((card) => card.source === 'draft').length,
    resolveMappedPersonalityId: () => null,
    resolveCompareModelCards: () => cards,
  }));
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
        featureModels: { ...DEFAULT_FEATURE_MODELS },
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
        modelId: DEFAULT_MODEL_ID,
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
    vi.doUnmock('../src/shared/compare-cards.js');
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

  it('uses full subscription lookup for fast-reply and proceeds without subscription data when not found', async () => {
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
      'full',
    );
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
    expect(anthropicClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: 'fast-reply',
        userBlocks: expect.any(Array),
      }),
    );
    expect(anthropicClient.streamMessage.mock.calls[0]?.[0]).not.toHaveProperty('system');
    expect(anthropicClient.streamMessage.mock.calls[0]?.[0]).not.toHaveProperty('user');
    expect(flattenUserBlocksFromStreamCall(anthropicClient)).not.toContain(
      '## Fan Subscription Data',
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
        userBlocks: expect.any(Array),
      }),
    );
    expect(anthropicClient.streamMessage.mock.calls[0]?.[0]).not.toHaveProperty('system');
    expect(anthropicClient.streamMessage.mock.calls[0]?.[0]).not.toHaveProperty('user');
    expect(flattenUserBlocksFromStreamCall(anthropicClient)).toContain(
      '## Fan Subscription Data',
    );
  });

  it('returns compare_cards_unavailable when compare has fewer than two cards', async () => {
    mockCompareCards([
      {
        id: 'draft-only',
        label: 'draft-only',
        content: 'Draft only personality',
        source: 'draft',
      },
    ]);
    mockStorage.personalities = [];
    mockStorage.accountMappings = {};

    const { coordinator, anthropicClient, port } = await createCoordinatorHarness();

    await coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'compare-op',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:error' }> =>
        message.type === 'compare:error',
    );

    expect(errorMessage?.error.code).toBe('compare_cards_unavailable');
    expect(anthropicClient.streamMessage).not.toHaveBeenCalled();
  });

  it('runs compare cards with one shared prep pass and the fast-reply model for each card', async () => {
    mockCompareCards([
      {
        id: 'current:personality-1',
        label: 'Closer (current)',
        content: 'Current baseline personality',
        source: 'current',
      },
      {
        id: 'draft-1',
        label: 'draft-1',
        content: 'Draft personality variant',
        source: 'draft',
      },
      {
        id: 'draft-2',
        label: 'draft-2',
        content: 'Second draft personality variant',
        source: 'draft',
      },
    ]);
    const anthropicClient = {
      streamMessage: vi.fn(async ({ systemBlocks, onText }: { systemBlocks: Array<{ text: string }>; onText: (text: string) => void }) => {
        const system = systemBlocks.map((block) => block.text).join('');
        const text = system.includes('Current baseline personality')
          ? 'Current reply'
          : system.includes('Second draft personality variant')
            ? 'Draft 2 reply'
            : 'Draft 1 reply';
        onText(text);
        return text;
      }),
    };
    const { coordinator, port, fanslyClient } = await createCoordinatorHarness({ anthropicClient });

    await coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'compare-op',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'preferSplit',
    });

    const messages = postedMessages(port);
    const readyMessage = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:ready' }> =>
        message.type === 'compare:ready',
    );
    const chunkMessages = messages.filter(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:chunk' }> =>
        message.type === 'compare:chunk',
    );
    const completeMessages = messages.filter(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:cardComplete' }> =>
        message.type === 'compare:cardComplete',
    );

    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    expect(fanslyClient.getGroup).toHaveBeenCalledTimes(1);
    expect(fanslyClient.getEarnings).toHaveBeenCalledTimes(1);
    expect(fanslyClient.getMonthlyEarnings).toHaveBeenCalledTimes(1);
    expect(fanslyClient.getFanSubscriptionContext).toHaveBeenCalledTimes(1);
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(3);
    for (const [index, call] of anthropicClient.streamMessage.mock.calls.entries()) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          model: DEFAULT_FEATURE_MODELS['fast-reply'],
          feature: 'fast-reply',
          systemBlocks: expect.any(Array),
          userBlocks: expect.any(Array),
        }),
      );
      expect(call[0]).not.toHaveProperty('system');
      expect(call[0]).not.toHaveProperty('user');
      expect(flattenSystemBlocksFromStreamCall(anthropicClient, index)).toContain(
        '## Model Personality',
      );
    }
    expect(readyMessage?.cards.map((card) => card.label)).toEqual(['Closer (current)', 'draft-1', 'draft-2']);
    expect(new Set(chunkMessages.map((message) => message.cardId))).toEqual(
      new Set(['current:personality-1', 'draft-1', 'draft-2']),
    );
    expect(completeMessages).toHaveLength(3);
    expect(messages.some((message) => message.type === 'compare:complete')).toBe(true);
  });

  it('allows mixed compare outcomes and still completes the overall compare session', async () => {
    mockCompareCards([
      {
        id: 'current:personality-1',
        label: 'Closer (current)',
        content: 'Current baseline personality',
        source: 'current',
      },
      {
        id: 'draft-1',
        label: 'draft-1',
        content: 'Draft personality variant',
        source: 'draft',
      },
    ]);
    const anthropicClient = {
      streamMessage: vi.fn(async ({ systemBlocks }: { systemBlocks: Array<{ text: string }> }) => {
        const system = systemBlocks.map((block) => block.text).join('');
        if (system.includes('Current baseline personality')) {
          throw new ChatMuseError('network_error');
        }
        return 'Draft reply';
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

    await coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'compare-op',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    const messages = postedMessages(port);
    const cardError = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:cardError' }> =>
        message.type === 'compare:cardError',
    );
    const cardComplete = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:cardComplete' }> =>
        message.type === 'compare:cardComplete',
    );

    expect(cardError?.cardId).toBe('current:personality-1');
    expect(cardError?.error.code).toBe('network_error');
    expect(cardComplete?.cardId).toBe('draft-1');
    expect(messages.some((message) => message.type === 'compare:complete')).toBe(true);
  });

  it('sends compare:discarded when an active compare session is cancelled', async () => {
    mockCompareCards([
      {
        id: 'current:personality-1',
        label: 'Closer (current)',
        content: 'Current baseline personality',
        source: 'current',
      },
      {
        id: 'draft-1',
        label: 'draft-1',
        content: 'Draft personality variant',
        source: 'draft',
      },
    ]);
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
    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

    const startPromise = coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'compare-op',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    await streamStarted;
    expect(coordinator.activeByTabId.has(1)).toBe(false);
    expect(coordinator.activeCompareByTabId.get(1)?.operationId).toBe('compare-op');
    expect(coordinator.tabContexts.get(1)?.activeOperationId).toBeNull();

    coordinator.cancelCompare(1, undefined, true);
    await startPromise;

    const discardedMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:discarded' }> =>
        message.type === 'compare:discarded',
    );

    expect(discardedMessage?.error.code).toBe('chat_changed');
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
      'full',
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
      onTrace?.({ type: 'groups-miss' });
      onTrace?.({ type: 'subscribers-miss' });
      return null;
    });

    const anthropicClient = {
      streamMessage: vi.fn(async ({
        onText,
        onUsage,
      }: {
        onText: (text: string) => void;
        onUsage?: (usage: {
          input_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          output_tokens: number;
        }) => void;
      }) => {
        advanceNow(200);
        onText('Hello');
        advanceNow(250);
        onText(' there');
        advanceNow(120);
        onUsage?.({
          input_tokens: 420,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 90,
          output_tokens: 11,
        });
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
    const debugPromptMessage = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:debugPrompt' }> =>
        message.type === 'operation:debugPrompt',
    );

    expect(progressMessages.some((message) => Boolean(message.profiling))).toBe(true);
    expect(completeMessage?.profiling).toBeDefined();
    expect(completeMessage?.profiling?.anthropicUsage).toEqual({
      input_tokens: 420,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 90,
      output_tokens: 11,
    });
    expect(debugPromptMessage?.snapshot.system).toBe(
      flattenSystemBlocksFromStreamCall(anthropicClient),
    );
    expect(debugPromptMessage?.snapshot.user).toBe(
      flattenUserBlocksFromStreamCall(anthropicClient),
    );
    expect(completeMessage?.profiling?.logEntries.some((entry) => entry.message.includes('Loaded messages page 1/2'))).toBe(true);
    expect(completeMessage?.profiling?.logEntries.some((entry) => entry.message.includes('Claude usage: input_tokens=420, cache_creation_input_tokens=300, cache_read_input_tokens=90, output_tokens=11'))).toBe(true);
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
    expect(completeMessage?.profiling?.stages.find((stage) => stage.key === 'subscription-lookup')?.detail).toContain('cache miss -> groups miss -> subscribers miss');
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

  it('passes the per-feature model to streamMessage', async () => {
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'claude-haiku-4-5',
    };

    const { coordinator, anthropicClient } = await createCoordinatorHarness({
      anthropicRawText: 'quick reply',
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

    expect(anthropicClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5' }),
    );
  });

  it('retries with default model on model_unavailable error', async () => {
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'claude-opus-4-5',
    };

    let callCount = 0;
    const anthropicClient = {
      streamMessage: vi.fn(async ({ model }: { model: string }) => {
        callCount++;
        if (callCount === 1 && model === 'claude-opus-4-5') {
          throw new ChatMuseError('model_unavailable');
        }
        return 'Fallback result';
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

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

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(2);
    expect(anthropicClient.streamMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ model: 'claude-opus-4-5' }),
    );
    expect(anthropicClient.streamMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ model: DEFAULT_MODEL_ID }),
    );

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );
    expect(completeMessage).toBeDefined();
  });

  it('does not retry when default model itself is unavailable', async () => {
    const anthropicClient = {
      streamMessage: vi.fn(async () => {
        throw new ChatMuseError('model_unavailable');
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

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

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );
    expect(errorMessage?.error.code).toBe('model_unavailable');
  });

  it('invalidates summary cache when model changes', async () => {
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fan-summary': 'claude-opus-4-6',
    };

    const { coordinator, anthropicClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'New model summary',
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    // Cache had modelId: DEFAULT_MODEL_ID but we're using claude-opus-4-6 — should miss
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
    expect(anthropicClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-opus-4-6' }),
    );

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );
    expect(completeMessage?.result.summaryMeta?.cached).toBe(false);
  });

  it('treats legacy cache entries without modelId as cache misses', async () => {
    // Override cache entry to remove modelId
    (mockStorage as Record<string, unknown>)['summary:group-1'] = {
      summary: 'Old summary',
      personalityId: 'personality-1',
      personalityUpdatedAt: 1000,
      generatedAt: 2000,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      // no modelId field
    };

    const { coordinator, anthropicClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'Regenerated summary',
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );
    expect(completeMessage?.result.summaryMeta?.cached).toBe(false);
  });

  it('derives totals from monthlystats when stats fails', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockRejectedValue(new Error('stats 500'));
    fanslyClient.getMonthlyEarnings.mockResolvedValue([
      { year: 2026, month: 2, totalGross: 195000, totalNet: 156000, accountId: 'a', correlationAccountId: 'fan-1', timestamp: 1 },
      { year: 2026, month: 1, totalGross: 400000, totalNet: 320000, accountId: 'a', correlationAccountId: 'fan-1', timestamp: 2 },
    ] satisfies MonthlyEarningsRow[]);

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

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
    const promptUser = flattenUserBlocksFromStreamCall(anthropicClient);
    expect(promptUser).toContain('Total gross (all-time): $595.00');
    expect(promptUser).toContain('Total net (all-time): $476.00');
    expect(promptUser).toContain('Monthly totals:');
  });

  it('produces zeroed spending data when both earnings calls succeed empty', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(null);
    fanslyClient.getMonthlyEarnings.mockResolvedValue([]);

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

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
    const promptUser = flattenUserBlocksFromStreamCall(anthropicClient);
    expect(promptUser).toContain('FAN SPENDING DATA:');
    expect(promptUser).toContain('Total gross (all-time): $0.00');
  });

  it('fetches per-month type breakdown for deep features', async () => {
    const fanslyClient = buildFanslyClientMock();
    const monthlyRows: MonthlyEarningsRow[] = [
      { year: 2026, month: 2, totalGross: 195000, totalNet: 156000, accountId: 'a', correlationAccountId: 'fan-1', timestamp: 1 },
      { year: 2026, month: 1, totalGross: 400000, totalNet: 320000, accountId: 'a', correlationAccountId: 'fan-1', timestamp: 2 },
      { year: 2025, month: 12, totalGross: 100000, totalNet: 80000, accountId: 'a', correlationAccountId: 'fan-1', timestamp: 3 },
    ];
    fanslyClient.getMonthlyEarnings.mockResolvedValue(monthlyRows);

    const allTimeAggregated: AggregatedEarnings = {
      correlationAccountId: 'fan-1',
      windowStartIso: new Date(0).toISOString(),
      windowEndIso: new Date(currentNow).toISOString(),
      totalGross: 695000,
      totalNet: 556000,
      breakdown: [
        { label: 'Subscription', type: 2110, gross: 695000, net: 556000 },
      ],
      monthlyTotals: [],
    };
    const perMonthAggregated: AggregatedEarnings = {
      ...allTimeAggregated,
      totalGross: 195000,
      totalNet: 156000,
      breakdown: [
        { label: 'Subscription', type: 2110, gross: 195000, net: 156000 },
      ],
    };

    let callCount = 0;
    fanslyClient.getEarnings.mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? allTimeAggregated : perMonthAggregated;
    });

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

    // 1 all-time call + 3 per-month calls
    expect(fanslyClient.getEarnings).toHaveBeenCalledTimes(4);
    const promptUser = flattenUserBlocksFromStreamCall(anthropicClient);
    expect(promptUser).toContain('Monthly breakdown by type:');
  });

  it('caps per-month breakdown at 12 months', async () => {
    const fanslyClient = buildFanslyClientMock();
    const monthlyRows: MonthlyEarningsRow[] = Array.from({ length: 15 }, (_, i) => {
      const d = new Date(2026, 2 - i, 1); // Mar 2026 backwards
      return {
        year: d.getFullYear(),
        month: d.getMonth() + 1,
        totalGross: 100000,
        totalNet: 80000,
        accountId: 'a',
        correlationAccountId: 'fan-1',
        timestamp: i,
      };
    });
    fanslyClient.getMonthlyEarnings.mockResolvedValue(monthlyRows);
    fanslyClient.getEarnings.mockResolvedValue({
      correlationAccountId: 'fan-1',
      windowStartIso: new Date(0).toISOString(),
      windowEndIso: new Date(currentNow).toISOString(),
      totalGross: 100000,
      totalNet: 80000,
      breakdown: [{ label: 'Subscription', type: 2110, gross: 100000, net: 80000 }],
      monthlyTotals: [],
    } satisfies AggregatedEarnings);

    const { coordinator } = await createCoordinatorHarness({
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

    // 1 all-time + 12 per-month (not 15)
    expect(fanslyClient.getEarnings).toHaveBeenCalledTimes(13);
  });

  it('marks monthlyBreakdowns as partial when per-month fetches fail', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getMonthlyEarnings.mockResolvedValue([
      { year: 2026, month: 2, totalGross: 195000, totalNet: 156000, accountId: 'a', correlationAccountId: 'fan-1', timestamp: 1 },
      { year: 2026, month: 1, totalGross: 400000, totalNet: 320000, accountId: 'a', correlationAccountId: 'fan-1', timestamp: 2 },
    ] satisfies MonthlyEarningsRow[]);

    let callCount = 0;
    fanslyClient.getEarnings.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // all-time stats call succeeds
        return {
          correlationAccountId: 'fan-1',
          windowStartIso: new Date(0).toISOString(),
          windowEndIso: new Date(currentNow).toISOString(),
          totalGross: 595000,
          totalNet: 476000,
          breakdown: [{ label: 'Subscription', type: 2110, gross: 595000, net: 476000 }],
          monthlyTotals: [],
        } satisfies AggregatedEarnings;
      }
      // per-month calls: first succeeds, second fails
      if (callCount === 2) {
        return {
          correlationAccountId: 'fan-1',
          windowStartIso: '',
          windowEndIso: '',
          totalGross: 195000,
          totalNet: 156000,
          breakdown: [{ label: 'Subscription', type: 2110, gross: 195000, net: 156000 }],
          monthlyTotals: [],
        } satisfies AggregatedEarnings;
      }
      throw new Error('per-month fetch failed');
    });

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

    const promptUser = flattenUserBlocksFromStreamCall(anthropicClient);
    expect(promptUser).toContain('(some months could not be fetched)');
  });

  it('stale port disconnect does not cancel current operation (Bug 1)', async () => {
    let resolveStream: ((text: string) => void) | null = null;
    let resolveStreamStarted: (() => void) | null = null;
    const streamStarted = new Promise<void>((resolve) => { resolveStreamStarted = resolve; });
    const anthropicClient = {
      streamMessage: vi.fn(
        () => {
          resolveStreamStarted?.();
          return new Promise<string>((resolve) => { resolveStream = resolve; });
        },
      ),
    };
    const { coordinator } = await createCoordinatorHarness({ anthropicClient });

    // Simulate old port with its own disconnect handler
    const oldPort = {
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
    };
    coordinator.registerPort(Object.assign(oldPort, {
      sender: { tab: { id: 1 } },
      onMessage: { addListener: vi.fn() },
    }));
    const oldDisconnectHandler = oldPort.onDisconnect.addListener.mock.calls[0]![0]!;

    // New port replaces the old one
    const newPort = {
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
    };
    coordinator.registerPort(Object.assign(newPort, {
      sender: { tab: { id: 1 } },
      onMessage: { addListener: vi.fn() },
    }));

    // Start operation on the new port
    const startPromise = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'new-op',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    // Wait until the stream is active
    await streamStarted;

    // Old port disconnects — should NOT cancel the new operation
    oldDisconnectHandler();

    // Operation should still be active
    expect(coordinator.activeByTabId.has(1)).toBe(true);

    resolveStream!('Result');
    await startPromise;
  });

  it('cancel with mismatched operationId does not cancel current operation (Bug 2)', async () => {
    let resolveStream: ((text: string) => void) | null = null;
    let resolveStreamStarted: (() => void) | null = null;
    const streamStarted = new Promise<void>((resolve) => { resolveStreamStarted = resolve; });
    const anthropicClient = {
      streamMessage: vi.fn(
        () => {
          resolveStreamStarted?.();
          return new Promise<string>((resolve) => { resolveStream = resolve; });
        },
      ),
    };
    const { coordinator } = await createCoordinatorHarness({ anthropicClient });

    const startPromise = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'current-op',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    // Wait until the stream is active
    await streamStarted;

    // Simulate cancel for a stale operation
    await coordinator.handlePortMessage(1, {
      type: 'operation:cancel',
      operationId: 'old-stale-op',
    });

    // Operation should still be active (mismatched operationId)
    expect(coordinator.activeByTabId.has(1)).toBe(true);

    resolveStream!('Result');
    await startPromise;
  });
});
