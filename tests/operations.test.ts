/* eslint-disable @typescript-eslint/no-explicit-any --
   legacy suite drives background operations through `as any` seams; the
   operations surface is rewritten onto kernel feature services in Stage 32
   Task 3. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMPARE_TEMPERATURE,
  DEEP_OPERATION_LLM_IDLE_TIMEOUT_MS,
  DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS,
  DEEP_OPERATION_LLM_TTFB_TIMEOUT_MS,
  DEEP_OPERATION_PREP_TIMEOUT_MS,
  DEFAULT_MODEL_ID,
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
  FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT,
  FEATURE_TEMPERATURES,
  QUICK_OPERATION_TIMEOUT_MS,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import { ChatGooseError } from '../src/shared/errors.js';
import { getAgencyHubModelId } from '../src/shared/model-registry.js';
import { flattenPromptBlocks } from '../src/shared/prompts.js';
import {
  createMockRuntimePort,
  postedMessages,
} from './helpers/port.js';
import type {
  AggregatedEarnings,
  BackgroundPortMessage,
  CompareModelCard,
  FanSubscriptionContext,
  FanslyMessagePageResponse,
  MonthlyEarningsRow,
  NormalizedTranscriptMessage,
  SummaryCacheEntry,
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

function pagesFromTranscript(messages: NormalizedTranscriptMessage[]): FanslyMessagePageResponse[] {
  return [
    {
      messages: messages.map((m) => ({
        id: m.id,
        type: m.type,
        content: m.text,
        groupId: 'g1',
        senderId: m.senderId,
        createdAt: m.createdAt,
        attachments: [],
        embeds: [],
        totalTipAmount: 0,
      })),
      accountMedia: [],
      accountMediaBundles: [],
      accountMediaOrders: [],
    },
  ];
}

function buildMessagePages(count: number): FanslyMessagePageResponse[] {
  return pagesFromTranscript(buildTranscriptMessages(count));
}

function buildPpvMediaPage(ids: string[]): FanslyMessagePageResponse {
  return {
    messages: ids.map((id, index) => ({
      id: `ppv-message-${index + 1}`,
      type: 1,
      content: `ppv ${index + 1}`,
      groupId: 'g1',
      senderId: 'account-1',
      createdAt: 2_000 + index,
      attachments: [{ contentType: 1, contentId: id }],
      embeds: [],
      totalTipAmount: 0,
    })),
    accountMedia: ids.map((id) => ({
      id,
      media: { type: 2, mimetype: 'video/mp4' },
      purchased: true,
      access: true,
      whitelisted: true,
      permissions: { permissionFlags: [{ flags: 9, price: 33000 }] },
    })),
    accountMediaBundles: [],
    accountMediaOrders: [],
  };
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

function buildAggregatedEarnings(): AggregatedEarnings {
  return {
    correlationAccountId: 'fan-1',
    windowStartIso: '2026-01-01T00:00:00.000Z',
    windowEndIso: '2026-03-01T00:00:00.000Z',
    totalGross: 125_000,
    totalNet: 100_000,
    breakdown: [],
    monthlyTotals: [],
  };
}

function buildFanslyClientMock() {
  return {
    getAuthenticatedAccount: vi.fn(async (session?: {
      resolvedAccountId?: string | null;
      resolvedUsername?: string | null;
      resolvedDisplayName?: string | null;
    }) => {
      if (session) {
        session.resolvedAccountId = 'account-1';
        session.resolvedUsername = 'creator';
        session.resolvedDisplayName = 'Creator';
      }
      return {
        id: 'account-1',
        username: 'creator',
        displayName: 'Creator',
      };
    }),
    getAuthenticatedAccountId: vi.fn(
      async (session?: {
        resolvedAccountId?: string | null;
        resolvedUsername?: string | null;
        resolvedDisplayName?: string | null;
      }, _signal?: AbortSignal) => {
        if (session) {
          session.resolvedAccountId = 'account-1';
          session.resolvedUsername = 'creator';
          session.resolvedDisplayName = 'Creator';
        }
        return 'account-1';
      },
    ),
    loadMessages: vi.fn(async (
      _groupId: string,
      _messageCount: number,
      _session: unknown,
      _signal?: AbortSignal,
    ) => ({
      pages: buildMessagePages(30),
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
    verifyMediaPurchaseStates: vi.fn(async (..._args: unknown[]) => ({})),
  };
}

function advanceNow(ms: number): number {
  currentNow += ms;
  return currentNow;
}

/** Contract-valid fixtures — the SDK validates hub responses (Stage 32). */
function hubPageRow() {
  return {
    id: 1,
    label: 'creator-fs',
    platform: 'fansly',
    modelSlug: 'creator',
    modelName: 'Creator',
    username: 'creator',
    displayName: null,
    followerCount: { value: null, available: false },
    subscriberCount: { value: null, available: false },
    lastLightSyncAt: null,
    lastFollowerSyncAt: null,
  };
}

function hubProfileRecord(version: number) {
  return {
    version,
    body: '# fan summary',
    source: 'chatmuse',
    createdAt: '2026-03-20T12:00:00.000Z',
    createdByUserId: null,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function expectUserErrorIdentity(
  error: { key?: string; code?: string } | undefined,
  expected: { key: string; code: string },
): void {
  expect(error).toMatchObject(expected);
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
  agencyHubClient?: {
    isConfigured: (...args: any[]) => boolean;
    fetchFanProfileByConversation: (...args: any[]) => Promise<any>;
    pushFanProfile: (...args: any[]) => Promise<any>;
  };
  agencyHubUsageReporter?: {
    enqueue: (...args: any[]) => void;
  };
}) {
  const [{ OperationCoordinator }, { SessionStore }, { StorageCoordinator }, { TabContextStore }] =
    await Promise.all([
      import('../src/background/operations.js'),
      import('../src/background/session-store.js'),
      import('../src/background/storage-coordinator.js'),
      import('../src/background/tab-context.js'),
    ]);

  const sessionStore = new SessionStore();
  sessionStore.registerCapture(1, SESSION_CAPTURE);

  const fanslyClient = options?.fanslyClient ?? buildFanslyClientMock();
  const anthropicClient = options?.anthropicClient ?? {
    streamMessage: vi.fn(async () => options?.anthropicRawText ?? 'Result'),
  };
  const agencyHubClient = options?.agencyHubClient ?? {
    isConfigured: vi.fn(() => false),
    fetchFanProfileByConversation: vi.fn(async () => ({
      status: 'skipped',
      reason: 'disabled',
      baseUrl: null,
    })),
    pushFanProfile: vi.fn(async () => ({
      status: 'skipped',
      reason: 'disabled',
      baseUrl: null,
    })),
  };
  const agencyHubUsageReporter = options?.agencyHubUsageReporter ?? {
    enqueue: vi.fn(),
  };
  const storageCoordinator = new StorageCoordinator();

  const coordinator = new OperationCoordinator(
    sessionStore,
    new TabContextStore(),
    fanslyClient as never,
    anthropicClient as never,
    storageCoordinator,
    agencyHubClient as never,
    agencyHubUsageReporter as never,
  ) as any;
  const port = createMockRuntimePort(1);
  coordinator.registerPort(port as never);

  return {
    coordinator,
    fanslyClient,
    anthropicClient,
    agencyHubClient,
    agencyHubUsageReporter,
    port,
    sessionStore,
    storageCoordinator,
  };
}

async function mockCompareCards(cards: CompareModelCard[]): Promise<void> {
  const compareDrafts = Object.fromEntries(
    cards
      .filter((card) => card.source === 'draft')
      .map((card) => [card.label, card.content]),
  );
  (globalThis as typeof globalThis & {
    __CHATGOOSE_COMPARE_DRAFTS__?: Record<string, string>;
  }).__CHATGOOSE_COMPARE_DRAFTS__ = compareDrafts;

  const currentCard = cards.find((card) => card.source === 'current') ?? null;
  if (currentCard) {
    const personalityId = currentCard.id.replace(/^current:/, '');
    mockStorage.personalities = [
      {
        id: personalityId,
        name: currentCard.label,
        content: currentCard.content,
        updatedAt: 1000,
      },
    ];
    mockStorage.accountMappings = {
      'account-1': personalityId,
    };
  } else {
    mockStorage.personalities = [];
    mockStorage.accountMappings = {};
  }
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
        agencyHubBaseUrl: '',
        agencyHubApiKey: '',
        agencyHubDeviceToken: '',
        quickMessageCount: 100,
        pingMessageCount: 100,
        improveMessageCount: 100,
        deepMessageCount: 500,
        debugMode: false,
        promptCachingEnabled: true,
        featureModels: { ...DEFAULT_FEATURE_MODELS },
        featureReasoning: { ...DEFAULT_FEATURE_REASONING },
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
      accountAliases: {},
      knownAccounts: [],
      'summary:group-1': {
        summary: 'Old summary',
        personalityId: 'personality-1',
        personalityUpdatedAt: 1000,
        generatedAt: 2000,
        spendingDataVerified: true,
        subscriptionLookupVerified: true,
        modelId: DEFAULT_FEATURE_MODELS['fan-summary'],
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
    delete (globalThis as typeof globalThis & {
      __CHATGOOSE_COMPARE_DRAFTS__?: Record<string, string>;
    }).__CHATGOOSE_COMPARE_DRAFTS__;
    vi.doUnmock('virtual:model-card-drafts');
    vi.doUnmock('../src/shared/compare-cards.js');
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it('marks tab state when a valid summary is already available locally', async () => {
    const { coordinator, port } = await createCoordinatorHarness();

    await coordinator.handlePortMessage(1, {
      type: 'tab:init',
      groupId: 'group-1',
      routeNonce: 1,
    });

    expect(postedMessages(port)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tab:state',
          state: expect.objectContaining({
            groupId: 'group-1',
            hasAvailableSummary: true,
          }),
        }),
      ]),
    );
  });

  it('accepts valid content messages through the registered port listener', async () => {
    const { port } = await createCoordinatorHarness();

    port.emitMessage({
      type: 'tab:init',
      groupId: 'group-1',
      routeNonce: 1,
    });

    await vi.waitFor(() => {
      expect(postedMessages(port)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tab:state',
            state: expect.objectContaining({
              groupId: 'group-1',
              hasAvailableSummary: true,
            }),
          }),
        ]),
      );
    });
  });

  it('drops malformed content messages at the registered port listener', async () => {
    const { port, anthropicClient, fanslyClient } = await createCoordinatorHarness();

    port.emitMessage({
      type: 'tab:init',
      groupId: 123,
      routeNonce: 1,
    });
    port.emitMessage({
      type: 'operation:start',
      operationId: 'bad-op',
      feature: 'not-a-feature',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
    });
    await Promise.resolve();

    expect(postedMessages(port)).toEqual([]);
    expect(anthropicClient.streamMessage).not.toHaveBeenCalled();
    expect(fanslyClient.loadMessages).not.toHaveBeenCalled();
  });

  it('includes provider-aware API key readiness in tab state', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      claudeApiKey: 'sk-ant-test',
      openRouterApiKey: '',
      featureModels: {
        ...DEFAULT_FEATURE_MODELS,
        'fast-reply': 'openrouter:x-ai/grok-4.3',
      },
    };
    const { coordinator, port } = await createCoordinatorHarness();

    await coordinator.handlePortMessage(1, {
      type: 'tab:init',
      groupId: 'group-1',
      routeNonce: 1,
    });

    expect(postedMessages(port)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tab:state',
          state: expect.objectContaining({
            hasApiKey: true,
            modelProviderByFeature: expect.objectContaining({
              'fast-reply': 'openrouter',
              'help-me': 'anthropic',
            }),
            apiKeyReadyByFeature: expect.objectContaining({
              'fast-reply': false,
              'help-me': true,
            }),
          }),
        }),
      ]),
    );
  });

  it('prefetches an Agency Hub summary for tab state availability and marks it ready', async () => {
    delete mockStorage['summary:group-1'];

    const { coordinator, port, agencyHubClient } = await createCoordinatorHarness({
      agencyHubClient: {
        isConfigured: vi.fn(() => true),
        fetchFanProfileByConversation: vi.fn(async () => ({
          status: 'fetched',
          reason: 'fetched',
          baseUrl: 'http://hub.test',
          pageLabel: 'creator-fs',
          body: 'Hub summary',
          createdAtMs: 1234,
          fanAccountId: 'fan-1',
        })),
        pushFanProfile: vi.fn(async () => ({
          status: 'skipped',
          reason: 'disabled',
          baseUrl: null,
        })),
      },
    });

    await coordinator.handlePortMessage(1, {
      type: 'tab:init',
      groupId: 'group-1',
      routeNonce: 1,
    });

    await vi.waitFor(() => {
      const availabilityMessages = postedMessages(port).filter(
        (message) => message.type === 'tab:state',
      );
      expect(availabilityMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            state: expect.objectContaining({
              groupId: 'group-1',
              hasAvailableSummary: false,
            }),
          }),
          expect.objectContaining({
            state: expect.objectContaining({
              groupId: 'group-1',
              hasAvailableSummary: true,
            }),
          }),
        ]),
      );
    });

    expect(agencyHubClient.fetchFanProfileByConversation).toHaveBeenCalledTimes(1);
    expect(mockStorage['summary:group-1']).toMatchObject({
      summary: 'Hub summary',
      personalityId: 'personality-1',
      generatedAt: 1234,
      modelId: DEFAULT_FEATURE_MODELS['fan-summary'],
      fanAccountId: 'fan-1',
    });
  });

  it('auto-recovers a mapped personality when a new legacy alias is captured for the same account', async () => {
    mockStorage = {
      ...mockStorage,
      accountMappings: {
        'resolved-1': 'personality-1',
      },
      accountAliases: {},
      knownAccounts: ['resolved-1'],
    };

    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getAuthenticatedAccountId.mockImplementation(async (session: any) => {
      session.resolvedAccountId = 'resolved-1';
      return 'resolved-1';
    });

    const { coordinator, port, sessionStore } = await createCoordinatorHarness({
      fanslyClient,
    });

    sessionStore.registerCapture(1, {
      ...SESSION_CAPTURE,
      accountId: 'legacy-1',
    });

    await coordinator.handleCapture(1, 'legacy-1');

    await vi.waitFor(() => {
      const stateMessages = postedMessages(port).filter(
        (message) =>
          message.type === 'tab:state' || message.type === 'mapping:changed',
      );

      expect(stateMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'tab:state',
            state: expect.objectContaining({
              accountId: 'legacy-1',
              mappedPersonalityId: null,
            }),
          }),
          expect.objectContaining({
            type: 'mapping:changed',
            state: expect.objectContaining({
              accountId: 'resolved-1',
              mappedPersonalityId: 'personality-1',
              mappedPersonalityName: 'Closer',
            }),
          }),
        ]),
      );
    });

    expect(fanslyClient.getAuthenticatedAccountId).toHaveBeenCalledTimes(1);
    expect(mockStorage.accountAliases).toEqual({
      'legacy-1': 'resolved-1',
    });
  });

  it('refreshes every waiting tab after a shared identity resolution completes', async () => {
    mockStorage = {
      ...mockStorage,
      accountMappings: {
        'resolved-1': 'personality-1',
      },
      accountAliases: {},
      knownAccounts: ['resolved-1'],
    };

    let resolveIdentity: ((value: string) => void) | null = null;
    const identityReady = new Promise<string>((resolve) => {
      resolveIdentity = resolve;
    });

    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getAuthenticatedAccountId.mockImplementation(async (session: any) => {
      const resolvedAccountId = await identityReady;
      session.resolvedAccountId = resolvedAccountId;
      return resolvedAccountId;
    });

    const { coordinator, port, sessionStore } = await createCoordinatorHarness({
      fanslyClient,
    });
    const secondPort = {
      postMessage: vi.fn(),
      onDisconnect: { addListener: vi.fn() },
    };

    coordinator.portsByTabId.set(2, secondPort);
    sessionStore.registerCapture(1, {
      ...SESSION_CAPTURE,
      accountId: 'legacy-1',
    });
    sessionStore.registerCapture(2, {
      ...SESSION_CAPTURE,
      accountId: 'legacy-1',
    });

    void coordinator.handleCapture(1, 'legacy-1');
    void coordinator.handleCapture(2, 'legacy-1');

    await vi.waitFor(() => {
      expect(fanslyClient.getAuthenticatedAccountId).toHaveBeenCalledTimes(1);
    });

    const releaseIdentity = resolveIdentity as ((value: string) => void) | null;
    if (!releaseIdentity) {
      throw new Error('Identity resolver was not initialized');
    }
    releaseIdentity('resolved-1');

    await vi.waitFor(() => {
      const firstMessages = postedMessages(port).filter(
        (message) => message.type === 'mapping:changed',
      );
      const secondMessages = postedMessages(secondPort).filter(
        (message) => message.type === 'mapping:changed',
      );

      expect(firstMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mapping:changed',
            state: expect.objectContaining({
              accountId: 'resolved-1',
              mappedPersonalityId: 'personality-1',
            }),
          }),
        ]),
      );
      expect(secondMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'mapping:changed',
            state: expect.objectContaining({
              accountId: 'resolved-1',
              mappedPersonalityId: 'personality-1',
            }),
          }),
        ]),
      );
    });
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

  it('passes exact orderhistory not-purchased evidence into fast-reply prompts', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockResolvedValue({
      pages: [buildPpvMediaPage(['media-ppv'])],
      pagesLoaded: 1,
      targetPages: 1,
    });
    fanslyClient.verifyMediaPurchaseStates.mockResolvedValue({
      checkedNotPurchasedSingleIds: new Set(['media-ppv']),
      verificationIncomplete: false,
    });
    const { coordinator, anthropicClient } = await createCoordinatorHarness({
      anthropicRawText: 'Reply',
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

    expect(fanslyClient.verifyMediaPurchaseStates).toHaveBeenCalledWith(
      [{ kind: 'single', contentId: 'media-ppv' }],
      'fan-1',
      expect.objectContaining({ accountId: 'account-1' }),
      expect.anything(),
    );
    expect(flattenUserBlocksFromStreamCall(anthropicClient)).toContain(
      '[Video — PPV $33.00, not purchased]',
    );
  });

  it('does not call the verifier for PPV media already proven purchased inline', async () => {
    const fanslyClient = buildFanslyClientMock();
    const page = buildPpvMediaPage(['media-ppv']);
    page.accountMediaOrders = [
      { accountId: 'fan-1', accountMediaId: 'media-ppv', type: 1, createdAt: 2_001 },
    ];
    fanslyClient.loadMessages.mockResolvedValue({
      pages: [page],
      pagesLoaded: 1,
      targetPages: 1,
    });
    const { coordinator, anthropicClient } = await createCoordinatorHarness({
      anthropicRawText: 'Reply',
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

    expect(fanslyClient.verifyMediaPurchaseStates).not.toHaveBeenCalled();
    expect(flattenUserBlocksFromStreamCall(anthropicClient)).toContain(
      '[Video — PPV $33.00, purchased]',
    );
  });

  it('keeps PPV unknown when group lookup cannot resolve a fan id', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockResolvedValue({
      pages: [buildPpvMediaPage(['media-ppv'])],
      pagesLoaded: 1,
      targetPages: 1,
    });
    fanslyClient.getGroup.mockRejectedValue(new Error('group failed'));
    const { coordinator, anthropicClient } = await createCoordinatorHarness({
      anthropicRawText: 'Reply',
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

    expect(fanslyClient.verifyMediaPurchaseStates).not.toHaveBeenCalled();
    expect(flattenUserBlocksFromStreamCall(anthropicClient)).toContain(
      '[Video — PPV $33.00, unknown]',
    );
  });

  it('fails open to unknown when media purchase verification rejects', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockResolvedValue({
      pages: [buildPpvMediaPage(['media-ppv'])],
      pagesLoaded: 1,
      targetPages: 1,
    });
    fanslyClient.verifyMediaPurchaseStates.mockRejectedValue(new Error('verifier down'));
    const { coordinator, anthropicClient } = await createCoordinatorHarness({
      anthropicRawText: 'Reply',
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
    expect(flattenUserBlocksFromStreamCall(anthropicClient)).toContain(
      '[Video — PPV $33.00, unknown]',
    );
  });

  it('leaves PPV cap overflow unknown while using verifier evidence for capped items', async () => {
    const fanslyClient = buildFanslyClientMock();
    const ids = Array.from(
      { length: FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT + 1 },
      (_, index) => `media-${index + 1}`,
    );
    fanslyClient.loadMessages.mockResolvedValue({
      pages: [buildPpvMediaPage(ids)],
      pagesLoaded: 1,
      targetPages: 1,
    });
    fanslyClient.verifyMediaPurchaseStates.mockImplementation(async (requests: unknown) => ({
      checkedNotPurchasedSingleIds: new Set(
        (requests as Array<{ contentId: string }>).map((request) => request.contentId),
      ),
      verificationIncomplete: false,
    }));
    const { coordinator, anthropicClient } = await createCoordinatorHarness({
      anthropicRawText: 'Reply',
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

    const verifyCalls = fanslyClient.verifyMediaPurchaseStates.mock.calls as unknown as [unknown[], ...unknown[]][];
    const verifiedRequests = verifyCalls[0]?.[0] ?? [];
    const prompt = flattenUserBlocksFromStreamCall(anthropicClient);
    expect(verifiedRequests).toHaveLength(FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT);
    expect(prompt).toContain('[Video — PPV $33.00, not purchased] ppv 1');
    expect(prompt).toContain('[Video — PPV $33.00, unknown] ppv 11');
  });

  it('includes the selected tone in fast-reply debug prompts and uncached user blocks', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const { coordinator, anthropicClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'Flirty reply',
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
      replyTone: 'flirty',
    });

    const debugPromptMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:debugPrompt' }> =>
        message.type === 'operation:debugPrompt',
    );
    const streamArgs = anthropicClient.streamMessage.mock.calls[0]?.[0] as {
      userBlocks: Array<{ text: string; cache_control?: unknown }>;
    };
    const lastUserBlock = streamArgs.userBlocks[streamArgs.userBlocks.length - 1];

    expect(debugPromptMessage?.snapshot.user).toContain('Tone override: FLIRTY');
    expect(debugPromptMessage?.snapshot.user).toContain(
      'intent and energy of this reply should shift',
    );
    expect(flattenUserBlocksFromStreamCall(anthropicClient)).toContain('Tone override: FLIRTY');
    expect(lastUserBlock?.text).toContain('Tone override: FLIRTY');
    expect(lastUserBlock?.cache_control).toBeUndefined();
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
    await mockCompareCards([
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

    expectUserErrorIdentity(errorMessage?.error, {
      key: 'compare_cards_unavailable',
      code: 'CG-FLOW-08',
    });
    expect(anthropicClient.streamMessage).not.toHaveBeenCalled();
  });

  it('runs compare cards with one shared prep pass and the fast-reply model for each card', async () => {
    delete mockStorage['summary:group-1'];
    await mockCompareCards([
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
    expect(anthropicClient.streamMessage.mock.calls.length).toBeGreaterThanOrEqual(3);
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
    const systemPrompts = new Set(
      anthropicClient.streamMessage.mock.calls.map((_, index) =>
        flattenSystemBlocksFromStreamCall(anthropicClient, index),
      ),
    );
    expect(systemPrompts.size).toBeGreaterThanOrEqual(3);
    expect(
      Array.from(systemPrompts).some((prompt) =>
        prompt.includes('Current baseline personality'),
      ),
    ).toBe(true);
    expect(
      Array.from(systemPrompts).some((prompt) =>
        prompt.includes('Draft personality variant'),
      ),
    ).toBe(true);
    expect(
      Array.from(systemPrompts).some((prompt) =>
        prompt.includes('Second draft personality variant'),
      ),
    ).toBe(true);
    expect(readyMessage?.cards.map((card) => card.label)).toEqual(['Closer (current)', 'draft-1', 'draft-2']);
    expect(new Set(chunkMessages.map((message) => message.cardId))).toEqual(
      new Set(['current:personality-1', 'draft-1', 'draft-2']),
    );
    expect(completeMessages).toHaveLength(3);
    expect(messages.some((message) => message.type === 'compare:complete')).toBe(true);
  });

  it('includes the selected tone in compare reply prompts', async () => {
    delete mockStorage['summary:group-1'];
    await mockCompareCards([
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
      streamMessage: vi.fn(async ({ onText }: { onText: (text: string) => void }) => {
        onText('Reply');
        return 'Reply';
      }),
    };
    const { coordinator } = await createCoordinatorHarness({ anthropicClient });

    await coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'compare-op',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
      replyTone: 'upsell',
    });

    expect(flattenUserBlocksFromStreamCall(anthropicClient, 0)).toContain('Tone override: SOFT UPSELL');
    expect(flattenUserBlocksFromStreamCall(anthropicClient, 1)).toContain('Tone override: SOFT UPSELL');
    expect(flattenUserBlocksFromStreamCall(anthropicClient, 0)).toContain(
      'intent and energy of this reply should shift',
    );
  });

  it('uses the compare-specific lower temperature for compare cards', async () => {
    await mockCompareCards([
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
      streamMessage: vi.fn(async ({ onText }: { onText: (text: string) => void }) => {
        onText('Reply');
        return 'Reply';
      }),
    };
    const { coordinator } = await createCoordinatorHarness({ anthropicClient });

    await coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'compare-op',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(2);
    expect(anthropicClient.streamMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ temperature: COMPARE_TEMPERATURE }),
    );
    expect(anthropicClient.streamMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ temperature: COMPARE_TEMPERATURE }),
    );
  });

  it('keeps per-card profiling cost snapshots isolated during debug compare runs', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };
    await mockCompareCards([
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
      streamMessage: vi.fn(async ({
        systemBlocks,
        onUsage,
      }: {
        systemBlocks: Array<{ text: string }>;
        onUsage?: (usage: {
          input_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          output_tokens: number;
        }) => void;
      }) => {
        const system = systemBlocks.map((block) => block.text).join('');
        if (system.includes('Current baseline personality')) {
          onUsage?.({
            input_tokens: 100,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 5,
            output_tokens: 8,
          });
          await Promise.resolve();
          return 'Current reply';
        }

        onUsage?.({
          input_tokens: 200,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 10,
          output_tokens: 16,
        });
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

    const completeMessages = postedMessages(port).filter(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:cardComplete' }> =>
        message.type === 'compare:cardComplete',
    );

    const currentCard = completeMessages.find((message) => message.cardId === 'current:personality-1');
    const draftCard = completeMessages.find((message) => message.cardId === 'draft-1');

    expect(currentCard?.profiling?.llmUsage).toEqual({
      input_tokens: 100,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
      output_tokens: 8,
    });
    expect(currentCard?.profiling?.llmCost?.totalUsd).toBe(0.00046);
    expect(currentCard?.profiling?.llmCost?.approximate).toBe(true);
    expect(currentCard?.llmSpend).toEqual({
      totalTokens: 123,
      inputTokens: 100,
      cacheWriteTokens: 10,
      cacheReadTokens: 5,
      outputTokens: 8,
      totalUsd: 0.00046,
      uncachedUsd: 0.000465,
      cacheEffectUsd: 0.000005,
      cacheEffectKind: 'saved',
      cacheWriteUsd: 0.000038,
      cacheReadUsd: 0.000002,
      approximate: true,
    });
    expect(draftCard?.profiling?.llmUsage).toEqual({
      input_tokens: 200,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 10,
      output_tokens: 16,
    });
    expect(draftCard?.profiling?.llmCost?.totalUsd).toBe(0.000918);
    expect(draftCard?.profiling?.llmCost?.approximate).toBe(true);
    expect(draftCard?.llmSpend).toEqual({
      totalTokens: 246,
      inputTokens: 200,
      cacheWriteTokens: 20,
      cacheReadTokens: 10,
      outputTokens: 16,
      totalUsd: 0.000918,
      uncachedUsd: 0.00093,
      cacheEffectUsd: 0.000012,
      cacheEffectKind: 'saved',
      cacheWriteUsd: 0.000075,
      cacheReadUsd: 0.000003,
      approximate: true,
    });
  });

  it('allows mixed compare outcomes and still completes the overall compare session', async () => {
    await mockCompareCards([
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
      streamMessage: vi.fn(async ({
        systemBlocks,
        onUsage,
      }: {
        systemBlocks: Array<{ text: string }>;
        onUsage?: (usage: {
          input_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          output_tokens: number;
        }) => void;
      }) => {
        const system = systemBlocks.map((block) => block.text).join('');
        if (system.includes('Current baseline personality')) {
          onUsage?.({
            input_tokens: 50,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 2,
            output_tokens: 0,
          });
          throw new ChatGooseError('network_error');
        }
        onUsage?.({
          input_tokens: 75,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 3,
          output_tokens: 6,
        });
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
    expectUserErrorIdentity(cardError?.error, {
      key: 'network_error',
      code: 'CG-NET-01',
    });
    expect(cardError?.llmSpend).toEqual({
      totalTokens: 56,
      inputTokens: 50,
      cacheWriteTokens: 4,
      cacheReadTokens: 2,
      outputTokens: 0,
      totalUsd: 0.000166,
      uncachedUsd: 0.000168,
      cacheEffectUsd: 0.000002,
      cacheEffectKind: 'saved',
      cacheWriteUsd: 0.000015,
      cacheReadUsd: 0.000001,
      approximate: true,
    });
    expect(cardComplete?.cardId).toBe('draft-1');
    expect(cardComplete?.llmSpend).toEqual({
      totalTokens: 89,
      inputTokens: 75,
      cacheWriteTokens: 5,
      cacheReadTokens: 3,
      outputTokens: 6,
      totalUsd: 0.000335,
      uncachedUsd: 0.000339,
      cacheEffectUsd: 0.000004,
      cacheEffectKind: 'saved',
      cacheWriteUsd: 0.000019,
      cacheReadUsd: 0.000001,
      approximate: true,
    });
    expect(messages.some((message) => message.type === 'compare:complete')).toBe(true);
  });

  it('treats unexpected compare card aborts as connection errors and still completes', async () => {
    await mockCompareCards([
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
      streamMessage: vi.fn(async ({
        systemBlocks,
      }: {
        systemBlocks: Array<{ text: string }>;
      }) => {
        const system = systemBlocks.map((block) => block.text).join('');
        if (system.includes('Current baseline personality')) {
          throw new DOMException('Aborted', 'AbortError');
        }
        await Promise.resolve();
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

    expect(cardError?.cardId).toBe('current:personality-1');
    expectUserErrorIdentity(cardError?.error, {
      key: 'network_error',
      code: 'CG-NET-01',
    });
    expect(messages.some((message) => message.type === 'compare:cardComplete')).toBe(true);
    expect(messages.some((message) => message.type === 'compare:complete')).toBe(true);
  });

  it('sends compare:discarded when an active compare session is cancelled', async () => {
    await mockCompareCards([
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
      streamMessage: vi.fn(
        ({ signal }: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => {
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

    await vi.waitFor(() => {
      if (coordinator.activeCompareByTabId.get(1)?.operationId !== 'compare-op') {
        throw new Error('Compare session is not active yet');
      }
    }, { timeout: 2000 });
    expect(coordinator.activeByTabId.has(1)).toBe(false);
    expect(coordinator.activeCompareByTabId.get(1)?.operationId).toBe('compare-op');
    expect(coordinator.tabContexts.get(1)?.activeOperationId).toBeNull();

    coordinator.cancelCompare(1, undefined, true);
    await startPromise;

    const discardedMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:discarded' }> =>
        message.type === 'compare:discarded',
    );

    expectUserErrorIdentity(discardedMessage?.error, {
      key: 'chat_changed',
      code: 'CG-FLOW-06',
    });
    expect(
      (coordinator as unknown as { cancelledCompareOperationIds: Set<string> })
        .cancelledCompareOperationIds.size,
    ).toBe(0);
  });

  it('blocks a second operation that races the first across validateStart', async () => {
    const anthropicClient = {
      streamMessage: vi.fn(async ({ onText }: { onText: (text: string) => void }) => {
        onText('hi');
        return 'hi';
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

    const basePayload = {
      type: 'operation:start' as const,
      feature: 'fast-reply' as const,
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default' as const,
    };

    // Fire both synchronously: the first reserves the tab before its first
    // await, so the second must be rejected by the guard rather than racing it
    // through validateStart and clobbering the first operation's state.
    const first = coordinator.startOperation(1, { ...basePayload, operationId: 'op-1' });
    const second = coordinator.startOperation(1, { ...basePayload, operationId: 'op-2' });
    await Promise.all([first, second]);

    const secondError = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error' && message.operationId === 'op-2',
    );
    expectUserErrorIdentity(secondError?.error, {
      key: 'another_operation',
      code: 'CG-FLOW-04',
    });

    // The first operation still completes normally and the reservation clears.
    const firstComplete = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete' && message.operationId === 'op-1',
    );
    expect(firstComplete).toBeDefined();
    expect(
      (coordinator as unknown as { startingTabIds: Set<number> }).startingTabIds.size,
    ).toBe(0);
  });

  it('sends compare:error when compare generation hits the shared timeout', async () => {
    vi.useFakeTimers();
    await mockCompareCards([
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

    let startedStreams = 0;
    let resolveStreamsStarted: (() => void) | null = null;
    const streamsStarted = new Promise<void>((resolve) => {
      resolveStreamsStarted = resolve;
    });
    const anthropicClient = {
      streamMessage: vi.fn(
        ({ signal }: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => {
          startedStreams += 1;
          if (startedStreams === 2) {
            resolveStreamsStarted?.();
          }
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

    await streamsStarted;
    await vi.advanceTimersByTimeAsync(QUICK_OPERATION_TIMEOUT_MS);
    await startPromise;

    const messages = postedMessages(port);
    const errorMessage = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:error' }> =>
        message.type === 'compare:error',
    );

    expectUserErrorIdentity(errorMessage?.error, {
      key: 'timed_out',
      code: 'CG-NET-02',
    });
    expect(messages.some((message) => message.type === 'compare:complete')).toBe(false);
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
    expect(nonDebugLoadMessagesArgs?.[4]).toBeUndefined();
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

  it('includes llmSpend in non-debug progress and completion payloads once usage arrives', async () => {
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
        onUsage?.({
          input_tokens: 100,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 5,
          output_tokens: 8,
        });
        onText('Hello');
        return 'Hello';
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

    const messages = postedMessages(port);
    const progressWithSpend = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:progress' }> =>
        message.type === 'operation:progress' && Boolean(message.llmSpend),
    );
    const completeMessage = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(progressWithSpend?.llmSpend).toEqual({
      totalTokens: 123,
      inputTokens: 100,
      cacheWriteTokens: 10,
      cacheReadTokens: 5,
      outputTokens: 8,
      totalUsd: 0.00046,
      uncachedUsd: 0.000465,
      cacheEffectUsd: 0.000005,
      cacheEffectKind: 'saved',
      cacheWriteUsd: 0.000038,
      cacheReadUsd: 0.000002,
      approximate: true,
    });
    expect(completeMessage?.llmSpend).toEqual(progressWithSpend?.llmSpend);
    expect(progressWithSpend).not.toHaveProperty('profiling');
    expect(completeMessage).not.toHaveProperty('profiling');
  });

  it('omits profiling data from non-debug error payloads', async () => {
    const nowSeconds = Math.floor(currentNow / 1000);
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockResolvedValue({
      pages: pagesFromTranscript([
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
      ]),
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

    expectUserErrorIdentity(errorMessage?.error, {
      key: 'ping_blocked',
      code: 'CG-FLOW-05',
    });
    expect(errorMessage).not.toHaveProperty('profiling');
  });

  it('preserves non-debug deep-feature page progress without profiling snapshots', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockImplementation(async (...args: any[]) => {
      const onProgress = args[4] as
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
        pages: buildMessagePages(30),
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
    expect(typeof deepFeatureLoadMessagesArgs?.[4]).toBe('function');
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

    expectUserErrorIdentity(discardedMessage?.error, {
      key: 'chat_changed',
      code: 'CG-FLOW-06',
    });
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
      const onProgress = args[4] as
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
        pages: buildMessagePages(30),
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
        onReasoningObserved,
        onReasoningDelta,
      }: {
        onText: (text: string) => void;
        onUsage?: (usage: {
          input_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          output_tokens: number;
          cache_creation?: {
            ephemeral_5m_input_tokens: number;
            ephemeral_1h_input_tokens: number;
          };
        }) => void;
        onReasoningObserved?: (signal: 'thinking_block') => void;
        onReasoningDelta?: (text: string) => void;
      }) => {
        advanceNow(200);
        onReasoningObserved?.('thinking_block');
        onReasoningDelta?.('I should answer warmly.');
        onText('Hello');
        advanceNow(250);
        onText(' there');
        advanceNow(120);
        onUsage?.({
          input_tokens: 420,
          cache_creation_input_tokens: 300,
          cache_read_input_tokens: 90,
          output_tokens: 11,
          cache_creation: {
            ephemeral_5m_input_tokens: 120,
            ephemeral_1h_input_tokens: 180,
          },
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
    const debugPromptMessages = messages.filter(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:debugPrompt' }> =>
        message.type === 'operation:debugPrompt',
    );
    const debugPromptMessage = debugPromptMessages.at(-1);

    expect(progressMessages.some((message) => Boolean(message.profiling))).toBe(true);
    expect(completeMessage?.profiling).toBeDefined();
    expect(completeMessage?.profiling?.llmUsage).toEqual({
      input_tokens: 420,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 90,
      output_tokens: 11,
      cache_creation: {
        ephemeral_5m_input_tokens: 120,
        ephemeral_1h_input_tokens: 180,
      },
    });
    expect(completeMessage?.profiling?.llmCost).toEqual({
      modelId: DEFAULT_FEATURE_MODELS['fast-reply'],
      inputUsd: 0.00126,
      cacheWrite5mUsd: 0.00045,
      cacheWrite1hUsd: 0.00108,
      cacheReadUsd: 0.000027,
      outputUsd: 0.000165,
      totalUsd: 0.002982,
      approximate: false,
    });
    expect(debugPromptMessage?.snapshot.system).toBe(
      flattenSystemBlocksFromStreamCall(anthropicClient),
    );
    expect(debugPromptMessage?.snapshot.user).toBe(
      flattenUserBlocksFromStreamCall(anthropicClient),
    );
    expect(completeMessage?.profiling?.reasoningBlock).toBe('I should answer warmly.');
    expect(completeMessage?.profiling?.logEntries.some((entry) => entry.message.includes('Loaded messages page 1/2'))).toBe(true);
    expect(completeMessage?.profiling?.logEntries.some((entry) => entry.message.includes('Claude Sonnet 4.6 usage: input_tokens=420, cache_creation_input_tokens=300, cache_read_input_tokens=90, output_tokens=11'))).toBe(true);
    expect(completeMessage?.profiling?.logEntries.some((entry) => entry.message.includes('Claude Sonnet 4.6 cost: model=anthropic:claude-sonnet-4-6, total_usd=0.002982, input_usd=0.001260, cache_write_5m_usd=0.000450, cache_write_1h_usd=0.001080, cache_read_usd=0.000027, output_usd=0.000165, approximate=false'))).toBe(true);
    expect(completeMessage?.profiling?.logEntries.some((entry) => entry.message.includes('Reasoning requested: medium (Claude Sonnet 4.6)'))).toBe(true);
    expect(completeMessage?.profiling?.logEntries.some((entry) => entry.message.includes('Reasoning observed: yes (thinking_block)'))).toBe(true);
    expect(completeMessage?.profiling?.stages.map((stage) => stage.key)).toEqual([
      'resolve-identity',
      'load-messages',
      'group-lookup',
      'account-name-lookup',
      'earnings',
      'subscription-lookup',
      'prompt-build',
      'llm-ttfb',
      'llm-stream',
    ]);
    expect(completeMessage?.profiling?.stages.find((stage) => stage.key === 'llm-ttfb')).toMatchObject({
      status: 'completed',
      detail: 'first provider event received',
    });
    expect(completeMessage?.profiling?.stages.find((stage) => stage.key === 'llm-stream')).toMatchObject({
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
        throw new ChatGooseError('network_error');
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
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-ttfb')).toMatchObject({
      status: 'failed',
      detail: 'operation failed',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-stream')).toBeUndefined();
  });

  it('does not leak the operation id into the cancelled set after a failed operation', async () => {
    const anthropicClient = {
      streamMessage: vi.fn(async () => {
        throw new ChatGooseError('network_error');
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
    expect(errorMessage).toBeDefined();
    expect(
      (coordinator as unknown as { cancelledOperationIds: Set<string> }).cancelledOperationIds.size,
    ).toBe(0);
  });

  it('maps unexpected aborts to network_error in debug mode', async () => {
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

    expectUserErrorIdentity(errorMessage?.error, {
      key: 'network_error',
      code: 'CG-NET-01',
    });
    expect(errorMessage?.profiling).toBeDefined();
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-ttfb')).toMatchObject({
      status: 'failed',
      detail: 'operation failed',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-stream')).toBeUndefined();
  });

  it('includes profiling data on true timeout in debug mode', async () => {
    vi.useFakeTimers();
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

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
    await vi.advanceTimersByTimeAsync(QUICK_OPERATION_TIMEOUT_MS);
    await startPromise;

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );

    expectUserErrorIdentity(errorMessage?.error, {
      key: 'timed_out',
      code: 'CG-NET-02',
    });
    expect(errorMessage?.profiling).toBeDefined();
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-ttfb')).toMatchObject({
      status: 'failed',
      detail: 'operation failed',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-stream')).toBeUndefined();
  });

  it('lets deep fan summary complete after more than 120 seconds when progress continues', async () => {
    vi.useFakeTimers();

    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockImplementation(
      async () => new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            pages: buildMessagePages(30),
            pagesLoaded: 2,
            targetPages: 2,
          });
        }, 100_000);
      }),
    );

    const anthropicClient = {
      streamMessage: vi.fn(
        ({
          signal,
          onText,
          onProgress,
        }: {
          signal: AbortSignal;
          onText: (text: string) => void;
          onProgress?: () => void;
        }) => new Promise<string>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });

          setTimeout(() => {
            onText('Long');
          }, 10_000);
          setTimeout(() => {
            onProgress?.();
          }, 40_000);
          setTimeout(() => {
            onProgress?.();
          }, 70_000);
          setTimeout(() => {
            onProgress?.();
          }, 100_000);
          setTimeout(() => {
            onProgress?.();
          }, 130_000);
          setTimeout(() => {
            onText(' summary');
            resolve('Long summary');
          }, 170_000);
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      fanslyClient,
      anthropicClient,
    });

    const startPromise = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: true,
    });

    await vi.advanceTimersByTimeAsync(300_000);
    await startPromise;

    const messages = postedMessages(port);
    const completeMessage = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(messages.find((message) => message.type === 'operation:error')).toBeUndefined();
    expect(completeMessage?.result.rawText).toBe('Long summary');
  });

  it('times out deep prep when message loading exceeds the prep budget', async () => {
    vi.useFakeTimers();
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    let resolveLoadStarted: (() => void) | null = null;
    const loadStarted = new Promise<void>((resolve) => {
      resolveLoadStarted = resolve;
    });
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockImplementation(
      async (
        _groupId: string,
        _messageCount: number,
        _session: unknown,
        signal?: AbortSignal,
      ) => new Promise((_, reject) => {
        resolveLoadStarted?.();
        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      }),
    );
    const { coordinator, port } = await createCoordinatorHarness({ fanslyClient });

    const startPromise = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'review-op',
      feature: 'chat-review',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    await loadStarted;
    await vi.advanceTimersByTimeAsync(DEEP_OPERATION_PREP_TIMEOUT_MS);
    await startPromise;

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );

    expectUserErrorIdentity(errorMessage?.error, {
      key: 'timed_out',
      code: 'CG-NET-02',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'load-messages')).toMatchObject({
      status: 'failed',
      detail: 'operation failed',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-ttfb')).toBeUndefined();
  });

  it('times out deep operations when LLM TTFB exceeds the stage budget', async () => {
    vi.useFakeTimers();
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

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

    const startPromise = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'review-op',
      feature: 'chat-review',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    await streamStarted;
    await vi.advanceTimersByTimeAsync(DEEP_OPERATION_LLM_TTFB_TIMEOUT_MS);
    await startPromise;

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );

    expectUserErrorIdentity(errorMessage?.error, {
      key: 'timed_out',
      code: 'CG-NET-02',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-ttfb')).toMatchObject({
      status: 'failed',
      detail: 'operation failed',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-stream')).toBeUndefined();
  });

  it('treats reasoning progress before text as deep LLM provider activity', async () => {
    vi.useFakeTimers();
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    let resolveStreamStarted: (() => void) | null = null;
    const streamStarted = new Promise<void>((resolve) => {
      resolveStreamStarted = resolve;
    });
    const anthropicClient = {
      streamMessage: vi.fn(
        ({
          signal,
          onText,
          onProgress,
          onReasoningObserved,
        }: {
          signal: AbortSignal;
          onText: (text: string) => void;
          onProgress?: () => void;
          onReasoningObserved?: (signal: 'thinking_delta') => void;
        }) => new Promise<string>((resolve, reject) => {
          resolveStreamStarted?.();
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });

          setTimeout(() => {
            onProgress?.();
            onReasoningObserved?.('thinking_delta');
          }, 10_000);
          setTimeout(() => {
            onText('Deep review');
          }, 50_000);
          setTimeout(() => {
            resolve('Deep review');
          }, 51_000);
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

    const startPromise = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'review-op',
      feature: 'chat-review',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    await streamStarted;
    await vi.advanceTimersByTimeAsync(51_000);
    await startPromise;

    const messages = postedMessages(port);
    const completeMessage = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(messages.find((message) => message.type === 'operation:error')).toBeUndefined();
    expect(completeMessage?.result.rawText).toBe('Deep review');
    expect(completeMessage?.profiling?.stages.find((stage) => stage.key === 'llm-ttfb')).toMatchObject({
      status: 'completed',
      detail: 'first provider event received',
    });
    expect(completeMessage?.profiling?.stages.find((stage) => stage.key === 'llm-stream')).toMatchObject({
      status: 'completed',
      detail: '11 chars',
    });
  });

  it('times out deep operations when LLM stream goes idle after the first chunk', async () => {
    vi.useFakeTimers();
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const anthropicClient = {
      streamMessage: vi.fn(
        ({
          signal,
          onText,
        }: {
          signal: AbortSignal;
          onText: (text: string) => void;
        }) => new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });

          setTimeout(() => {
            onText('Hello');
          }, 1_000);
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

    const startPromise = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'review-op',
      feature: 'chat-review',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(DEEP_OPERATION_LLM_IDLE_TIMEOUT_MS);
    await startPromise;

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );

    expectUserErrorIdentity(errorMessage?.error, {
      key: 'timed_out',
      code: 'CG-NET-02',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-ttfb')).toMatchObject({
      status: 'completed',
      detail: 'first text chunk received',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-stream')).toMatchObject({
      status: 'failed',
      detail: 'operation failed',
    });
  });

  it('times out deep operations when LLM stream exceeds the max stream budget', async () => {
    vi.useFakeTimers();
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const anthropicClient = {
      streamMessage: vi.fn(
        ({
          signal,
          onText,
          onProgress,
        }: {
          signal: AbortSignal;
          onText: (text: string) => void;
          onProgress?: () => void;
        }) => new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });

          setTimeout(() => {
            onText('Hello');
          }, 1_000);
          for (let offset = 31_000; offset < DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS; offset += 30_000) {
            setTimeout(() => {
              onProgress?.();
            }, offset);
          }
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

    const startPromise = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'review-op',
      feature: 'chat-review',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS);
    await startPromise;

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );

    expectUserErrorIdentity(errorMessage?.error, {
      key: 'timed_out',
      code: 'CG-NET-02',
    });
    expect(errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-stream')).toMatchObject({
      status: 'failed',
      detail: 'operation failed',
    });
  });

  it('returns profiling data for ping_blocked before Claude work starts', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const nowSeconds = Math.floor(currentNow / 1000);
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockResolvedValue({
      pages: pagesFromTranscript([
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
      ]),
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

    expectUserErrorIdentity(errorMessage?.error, {
      key: 'ping_blocked',
      code: 'CG-FLOW-05',
    });
    expect(errorMessage?.profiling?.stages.map((stage) => stage.key)).toEqual([
      'resolve-identity',
      'load-messages',
      'group-lookup',
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

  it('does not query Agency Hub when a valid local summary cache entry exists', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };

    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      fetchFanProfileByConversation: vi.fn(async () => ({
        status: 'fetched',
        reason: 'fetched',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
        body: 'Hub summary',
        createdAtMs: Date.parse('2026-03-20T12:00:00.000Z'),
        fanAccountId: 'fan-1',
      })),
      pushFanProfile: vi.fn(async () => ({
        status: 'skipped',
        reason: 'disabled',
        baseUrl: null,
      })),
    };

    const { coordinator, anthropicClient, fanslyClient } = await createCoordinatorHarness({
      agencyHubClient,
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

    expect(agencyHubClient.fetchFanProfileByConversation).not.toHaveBeenCalled();
    expect(fanslyClient.loadMessages).not.toHaveBeenCalled();
    expect(anthropicClient.streamMessage).not.toHaveBeenCalled();
  });

  it('returns a Hub summary immediately on local cache miss and persists it locally', async () => {
    delete mockStorage['summary:group-1'];
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };

    const createdAtMs = Date.parse('2026-03-20T12:00:00.000Z');
    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      fetchFanProfileByConversation: vi.fn(async () => ({
        status: 'fetched',
        reason: 'fetched',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
        body: 'Hub summary',
        createdAtMs,
        fanAccountId: 'fan-9',
      })),
      pushFanProfile: vi.fn(async () => ({
        status: 'skipped',
        reason: 'disabled',
        baseUrl: null,
      })),
    };

    const { coordinator, anthropicClient, fanslyClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'Generated summary',
      agencyHubClient,
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

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(agencyHubClient.fetchFanProfileByConversation).toHaveBeenCalledTimes(1);
    expect(completeMessage?.result).toMatchObject({
      rawText: 'Hub summary',
      summaryMeta: {
        generatedAt: createdAtMs,
        cached: true,
        stale: false,
        syncStatus: {
          state: 'saved',
          baseUrl: 'http://localhost:3000',
          pageLabel: 'creator-fs',
        },
      },
    });
    expect((mockStorage['summary:group-1'] as SummaryCacheEntry | undefined)).toMatchObject({
      summary: 'Hub summary',
      personalityId: 'personality-1',
      personalityUpdatedAt: 1000,
      generatedAt: createdAtMs,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: DEFAULT_FEATURE_MODELS['fan-summary'],
      fanAccountId: 'fan-9',
      agencyHubSync: {
        state: 'saved',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      },
    });
    expect(fanslyClient.loadMessages).not.toHaveBeenCalled();
    expect(anthropicClient.streamMessage).not.toHaveBeenCalled();
  });

  it('falls through to generation when the Hub has no stored summary', async () => {
    delete mockStorage['summary:group-1'];
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };

    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      fetchFanProfileByConversation: vi.fn(async () => ({
        status: 'not-found',
        reason: 'profile_missing',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      })),
      pushFanProfile: vi.fn(async () => ({
        status: 'skipped',
        reason: 'disabled',
        baseUrl: null,
      })),
    };

    const { coordinator, anthropicClient, fanslyClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'Generated summary',
      agencyHubClient,
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

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(agencyHubClient.fetchFanProfileByConversation).toHaveBeenCalledTimes(1);
    expect(completeMessage?.result.rawText).toBe('Generated summary');
    expect(completeMessage?.result.summaryMeta?.cached).toBe(false);
    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
    expect(postedMessages(port).find((message) => message.type === 'operation:error')).toBeUndefined();
  });

  it.each([
    { reason: 'network_error' },
    { reason: 'aborted' },
  ])('falls through to generation when the Hub prefetch fails ($reason)', async ({ reason }) => {
    delete mockStorage['summary:group-1'];
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };

    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      fetchFanProfileByConversation: vi.fn(async () => ({
        status: 'failed',
        reason,
        baseUrl: 'http://localhost:3000',
      })),
      pushFanProfile: vi.fn(async () => ({
        status: 'skipped',
        reason: 'disabled',
        baseUrl: null,
      })),
    };

    const { coordinator, anthropicClient, fanslyClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'Generated summary',
      agencyHubClient,
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

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(agencyHubClient.fetchFanProfileByConversation).toHaveBeenCalledTimes(1);
    expect(completeMessage?.result.rawText).toBe('Generated summary');
    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
    expect(postedMessages(port).find((message) => message.type === 'operation:error')).toBeUndefined();
  });

  it('tries Hub prefetch before regenerating when the local cache entry is stale for the current model', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
      featureModels: {
        ...DEFAULT_FEATURE_MODELS,
        'fan-summary': 'claude-haiku-4-5',
      },
    };

    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      fetchFanProfileByConversation: vi.fn(async () => ({
        status: 'fetched',
        reason: 'fetched',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
        body: 'Hub summary for new model',
        createdAtMs: Date.parse('2026-03-20T12:00:00.000Z'),
        fanAccountId: 'fan-1',
      })),
      pushFanProfile: vi.fn(async () => ({
        status: 'skipped',
        reason: 'disabled',
        baseUrl: null,
      })),
    };

    const { coordinator, anthropicClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'Regenerated summary',
      agencyHubClient,
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

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(agencyHubClient.fetchFanProfileByConversation).toHaveBeenCalledTimes(1);
    expect(completeMessage?.result.rawText).toBe('Hub summary for new model');
    expect(completeMessage?.result.summaryMeta?.cached).toBe(true);
    expect(anthropicClient.streamMessage).not.toHaveBeenCalled();
  });

  it('skips Hub prefetch on forced refresh and regenerates immediately', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };

    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      fetchFanProfileByConversation: vi.fn(async () => ({
        status: 'fetched',
        reason: 'fetched',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
        body: 'Hub summary',
        createdAtMs: Date.parse('2026-03-20T12:00:00.000Z'),
        fanAccountId: 'fan-1',
      })),
      pushFanProfile: vi.fn(async () => ({
        status: 'skipped',
        reason: 'disabled',
        baseUrl: null,
      })),
    };

    const { coordinator, anthropicClient, fanslyClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'Fresh summary',
      agencyHubClient,
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

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(agencyHubClient.fetchFanProfileByConversation).not.toHaveBeenCalled();
    expect(completeMessage?.result.rawText).toBe('Fresh summary');
    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
  });

  it('uses the local cache on the second open after a Hub prefetch hit', async () => {
    delete mockStorage['summary:group-1'];
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };

    const createdAtMs = Date.parse('2026-03-20T12:00:00.000Z');
    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      fetchFanProfileByConversation: vi.fn(async () => ({
        status: 'fetched',
        reason: 'fetched',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
        body: 'Hub summary',
        createdAtMs,
        fanAccountId: 'fan-1',
      })),
      pushFanProfile: vi.fn(async () => ({
        status: 'skipped',
        reason: 'disabled',
        baseUrl: null,
      })),
    };

    const { coordinator, anthropicClient, fanslyClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'Generated summary',
      agencyHubClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op-1',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op-2',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    const secondCompleteMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete' &&
        message.operationId === 'summary-op-2',
    );

    expect(agencyHubClient.fetchFanProfileByConversation).toHaveBeenCalledTimes(1);
    expect(secondCompleteMessage?.result).toMatchObject({
      rawText: 'Hub summary',
      summaryMeta: {
        generatedAt: createdAtMs,
        cached: true,
        syncStatus: { state: 'saved' },
      },
    });
    expect(fanslyClient.loadMessages).not.toHaveBeenCalled();
    expect(anthropicClient.streamMessage).not.toHaveBeenCalled();
  });

  it('pushes fresh fan summaries to Agency Hub after completion and marks the cache entry as synced', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        return jsonResponse([hubPageRow()]);
      }
      if (href === 'http://localhost:3000/api/v1/pages/creator-fs/fans/fan-1/profile') {
        return jsonResponse(hubProfileRecord(1));
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { AgencyHubClient } = await import('../src/background/agency-hub-client.js');
    const agencyHubClient = new AgencyHubClient(fetch);
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    const { coordinator, port } = await createCoordinatorHarness({
      anthropicRawText: 'Fresh summary',
      agencyHubClient,
      fanslyClient,
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

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(completeMessage?.result.summaryMeta).toMatchObject({
      cached: false,
      syncStatus: { state: 'saving' },
    });
    expect(postedMessages(port).find((message) => message.type === 'operation:error')).toBeUndefined();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const cacheEntry = mockStorage['summary:group-1'] as SummaryCacheEntry | undefined;
      const syncMessage = postedMessages(port).find(
        (message): message is Extract<BackgroundPortMessage, { type: 'summary:syncStatus' }> =>
          message.type === 'summary:syncStatus' &&
          message.generatedAt === completeMessage?.result.summaryMeta?.generatedAt,
      );
      expect(cacheEntry).toBeDefined();
      expect(cacheEntry?.fanAccountId).toBe('fan-1');
      expect(cacheEntry?.agencyHubSync).toMatchObject({
        state: 'saved',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      });
      expect(syncMessage?.syncStatus).toMatchObject({
        state: 'saved',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      });
    });
  });

  it('backfills cached summaries only once for the same Hub configuration', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    (mockStorage as Record<string, unknown>)['summary:group-1'] = {
      summary: 'Cached summary',
      personalityId: 'personality-1',
      personalityUpdatedAt: 1000,
      generatedAt: 2000,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: DEFAULT_FEATURE_MODELS['fan-summary'],
    };

    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href === 'http://localhost:3000/api/v1/pages') {
        return jsonResponse([hubPageRow()]);
      }
      if (href === 'http://localhost:3000/api/v1/pages/creator-fs/fans/fan-1/profile') {
        return jsonResponse(hubProfileRecord(1));
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { AgencyHubClient } = await import('../src/background/agency-hub-client.js');
    const agencyHubClient = new AgencyHubClient(fetch);
    const { coordinator, port } = await createCoordinatorHarness({
      agencyHubClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op-1',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    await vi.waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/v1/pages/creator-fs/fans/fan-1/profile'),
      );
      expect(putCalls).toHaveLength(1);
      const completeMessage = postedMessages(port).find(
        (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
          message.type === 'operation:complete' &&
          message.operationId === 'summary-op-1',
      );
      expect(completeMessage?.result.summaryMeta).toMatchObject({
        cached: true,
        syncStatus: { state: 'saving' },
      });
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op-2',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    await vi.waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/api/v1/pages/creator-fs/fans/fan-1/profile'),
      );
      expect(putCalls).toHaveLength(1);
      const completeMessage = postedMessages(port).find(
        (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
          message.type === 'operation:complete' &&
          message.operationId === 'summary-op-2',
      );
      expect(completeMessage?.result.summaryMeta).toMatchObject({
        cached: true,
        syncStatus: { state: 'saved' },
      });
    });
  });

  it('marks summary sync as not set up when Agency Hub sync is skipped', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    (browser as Record<string, unknown>).permissions = {
      contains: vi.fn(async () => false),
    } as never;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { AgencyHubClient } = await import('../src/background/agency-hub-client.js');
    const agencyHubClient = new AgencyHubClient(fetch);
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    const { coordinator, port } = await createCoordinatorHarness({
      anthropicRawText: 'Fresh summary',
      agencyHubClient,
      fanslyClient,
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

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(completeMessage?.result.summaryMeta).toMatchObject({
      syncStatus: { state: 'saving' },
    });

    await vi.waitFor(() => {
      const syncMessage = postedMessages(port).find(
        (message): message is Extract<BackgroundPortMessage, { type: 'summary:syncStatus' }> =>
          message.type === 'summary:syncStatus',
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(syncMessage?.syncStatus).toMatchObject({ state: 'not-set-up' });
      expect((mockStorage['summary:group-1'] as SummaryCacheEntry | undefined)?.agencyHubSync).toMatchObject({
        state: 'not-set-up',
      });
    });
  });

  it('does not block summary completion when Agency Hub sync fails', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };

    const fetchMock = vi.fn(async () => jsonResponse({ error: 'bad gateway' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const { AgencyHubClient } = await import('../src/background/agency-hub-client.js');
    const agencyHubClient = new AgencyHubClient(fetch);
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    const { coordinator, port } = await createCoordinatorHarness({
      anthropicRawText: 'Fresh summary',
      agencyHubClient,
      fanslyClient,
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

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(completeMessage?.result.rawText).toBe('Fresh summary');
    expect(completeMessage?.result.summaryMeta).toMatchObject({
      syncStatus: { state: 'saving' },
    });
    expect(postedMessages(port).find((message) => message.type === 'operation:error')).toBeUndefined();

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect((mockStorage['summary:group-1'] as SummaryCacheEntry | undefined)?.agencyHubSync).toMatchObject({
      state: 'failed',
    });
  });

  it('treats a changed Agency Hub base URL as a new backfill target for cached summaries', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://hub-a.test',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    (mockStorage as Record<string, unknown>)['summary:group-1'] = {
      summary: 'Cached summary',
      personalityId: 'personality-1',
      personalityUpdatedAt: 1000,
      generatedAt: 2000,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: DEFAULT_FEATURE_MODELS['fan-summary'],
      fanAccountId: 'fan-1',
      agencyHubSync: {
        baseUrl: 'http://hub-a.test',
        pageLabel: 'creator-fs',
        generatedAt: 2000,
        syncedAt: 2100,
      },
    };

    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (
        href === 'http://hub-a.test/api/v1/pages' ||
        href === 'http://hub-b.test/api/v1/pages'
      ) {
        return jsonResponse([hubPageRow()]);
      }
      if (href === 'http://hub-b.test/api/v1/pages/creator-fs/fans/fan-1/profile') {
        return jsonResponse(hubProfileRecord(2));
      }
      throw new Error(`Unexpected URL: ${href}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { AgencyHubClient } = await import('../src/background/agency-hub-client.js');
    const agencyHubClient = new AgencyHubClient(fetch);
    const { coordinator, port } = await createCoordinatorHarness({
      agencyHubClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op-1',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    await vi.waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('/pages/creator-fs/fans/fan-1/profile'),
      );
      expect(putCalls).toHaveLength(0);
      const completeMessage = postedMessages(port).find(
        (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
          message.type === 'operation:complete' &&
          message.operationId === 'summary-op-1',
      );
      expect(completeMessage?.result.summaryMeta).toMatchObject({
        cached: true,
        syncStatus: { state: 'saved' },
      });
    });

    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://hub-b.test',
    };

    const { coordinator: secondCoordinator, port: secondPort } = await createCoordinatorHarness({
      agencyHubClient,
    });

    await secondCoordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-op-2',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });
    const secondCompleteMessage = postedMessages(secondPort).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete' &&
        message.operationId === 'summary-op-2',
    );
    expect(secondCompleteMessage?.result.summaryMeta).toMatchObject({
      cached: true,
      syncStatus: { state: 'saving' },
    });

    await vi.waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('http://hub-b.test/api/v1/pages/creator-fs/fans/fan-1/profile'),
      );
      expect(putCalls).toHaveLength(1);
      expect((mockStorage['summary:group-1'] as SummaryCacheEntry).agencyHubSync).toMatchObject({
        state: 'saved',
        baseUrl: 'http://hub-b.test',
        pageLabel: 'creator-fs',
      });
    });
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
      expect.objectContaining({ model: 'anthropic:claude-haiku-4-5' }),
    );
  });

  it('sanitizes leaked Gemini meta text before returning insertable reply parts', async () => {
    const { coordinator, port } = await createCoordinatorHarness({
      anthropicRawText:
        `]\n[NEXT]\n"I think it's cute tbh"\n\nWait, the prompt says "Most replies should be a single message."`,
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

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(completeMessage?.result.rawText).toContain('prompt says');
    expect(completeMessage?.result.parts).toEqual(["I think it's cute tbh"]);
  });

  it('returns an unusable-output error when a reply has no insertable parts after sanitizing', async () => {
    const { coordinator, port } = await createCoordinatorHarness({
      anthropicRawText: 'The prompt says output only the message text.',
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

    expect(errorMessage?.error).toMatchObject({
      key: 'ai_output_unusable',
      code: 'CG-API-06',
    });
  });

  it('routes OpenRouter selections through the shared stream client with provider-aware settings', async () => {
    (mockStorage.settings as Record<string, unknown>).openRouterApiKey = 'sk-or-v1-test';
    (mockStorage.settings as Record<string, unknown>).claudeApiKey = '';
    (mockStorage.settings as Record<string, unknown>).debugMode = true;
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'openrouter:google/gemini-3.1-pro-preview',
    };

    const anthropicClient = {
      streamMessage: vi.fn(async ({ onUsage }: {
        onUsage?: (usage: {
          input_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          output_tokens: number;
        }) => void;
      }) => {
        onUsage?.({
          input_tokens: 6026,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 786,
        });
        return 'OpenRouter reply';
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

    expect(anthropicClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'openrouter:google/gemini-3.1-pro-preview',
        settings: expect.objectContaining({
          claudeApiKey: '',
          openRouterApiKey: 'sk-or-v1-test',
        }),
      }),
    );
    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );
    expect(completeMessage?.profiling?.llmCost).toMatchObject({
      modelId: 'openrouter:google/gemini-3.1-pro-preview',
      inputUsd: 0.012052,
      outputUsd: 0.009432,
      totalUsd: 0.021484,
    });
    const profilingLogs = completeMessage?.profiling?.logEntries
      .map((entry) => entry.message)
      .join('\n') ?? '';
    expect(profilingLogs).toContain('Gemini 3.1 Pro Preview usage');
    expect(profilingLogs).toContain('Gemini 3.1 Pro Preview cost');
    expect(profilingLogs).not.toContain('Claude usage');
    expect(profilingLogs).not.toContain('Claude cost');
  });

  it('shows an OpenRouter-specific missing key error for OpenRouter operation selections', async () => {
    (mockStorage.settings as Record<string, unknown>).claudeApiKey = 'sk-ant-test';
    (mockStorage.settings as Record<string, unknown>).openRouterApiKey = '';
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'openrouter:x-ai/grok-4.3',
    };
    const { coordinator, port } = await createCoordinatorHarness();

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

    expect(errorMessage?.error).toMatchObject({
      key: 'missing_api_key',
      message: 'OpenRouter API key not configured.',
    });
  });

  it('keeps the Anthropic-specific missing key error for Anthropic operation selections', async () => {
    (mockStorage.settings as Record<string, unknown>).claudeApiKey = '';
    (mockStorage.settings as Record<string, unknown>).openRouterApiKey = 'sk-or-v1-test';
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'anthropic:claude-sonnet-4-6',
    };
    const { coordinator, port } = await createCoordinatorHarness();

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

    expect(errorMessage?.error).toMatchObject({
      key: 'missing_api_key',
      message: 'Claude API key not configured.',
    });
  });

  it('shows an OpenRouter-specific missing key error for OpenRouter compare selections', async () => {
    (mockStorage.settings as Record<string, unknown>).claudeApiKey = 'sk-ant-test';
    (mockStorage.settings as Record<string, unknown>).openRouterApiKey = '';
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'openrouter:x-ai/grok-4.3',
    };
    const { coordinator, port } = await createCoordinatorHarness();

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

    expect(errorMessage?.error).toMatchObject({
      key: 'missing_api_key',
      message: 'OpenRouter API key not configured.',
    });
  });

  it('does not fallback from an unavailable OpenRouter model to Claude or another OpenRouter model', async () => {
    (mockStorage.settings as Record<string, unknown>).openRouterApiKey = 'sk-or-v1-test';
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'openrouter:x-ai/grok-4.20',
    };

    const anthropicClient = {
      streamMessage: vi.fn(async () => {
        throw new ChatGooseError('model_unavailable', {
          details: { provider: 'openrouter' },
        });
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
    expectUserErrorIdentity(errorMessage?.error, {
      key: 'model_unavailable',
      code: 'CG-API-03',
    });
    expect(errorMessage?.error.message).toBe('Selected OpenRouter model is unavailable.');
  });

  it('passes the configured temperature for each operation type', async () => {
    const { coordinator, anthropicClient } = await createCoordinatorHarness({
      anthropicRawText: 'Result',
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

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'review-op',
      feature: 'chat-review',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: true,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'improve-op',
      feature: 'improve-draft',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      draftText: 'hey babe how was your day',
      forceRegenerate: false,
    });

    expect(anthropicClient.streamMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ temperature: FEATURE_TEMPERATURES['fast-reply'] }),
    );
    expect(anthropicClient.streamMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ temperature: FEATURE_TEMPERATURES['chat-review'] }),
    );
    expect(anthropicClient.streamMessage).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ temperature: FEATURE_TEMPERATURES['improve-draft'] }),
    );
  });

  it('uses the fast-reply model for improve-draft and returns a single-part result', async () => {
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'claude-haiku-4-5',
    };
    const { coordinator, anthropicClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'improved reply',
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'improve-op',
      feature: 'improve-draft',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      draftText: 'hey babe how was your day',
      forceRegenerate: false,
    });

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(anthropicClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'anthropic:claude-haiku-4-5',
        feature: 'improve-draft',
      }),
    );
    expect(flattenUserBlocksFromStreamCall(anthropicClient)).toContain('## Current Draft');
    expect(flattenUserBlocksFromStreamCall(anthropicClient)).toContain('hey babe how was your day');
    expect(completeMessage?.result.parts).toEqual(['improved reply']);
    expect(completeMessage?.result.splitModeRequested).toBeUndefined();
  });

  it('uses the dedicated improve message count for improve-draft history', async () => {
    (mockStorage.settings as Record<string, unknown>).quickMessageCount = 100;
    (mockStorage.settings as Record<string, unknown>).improveMessageCount = 17;
    const fanslyClient = buildFanslyClientMock();
    const { coordinator } = await createCoordinatorHarness({ fanslyClient });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'improve-op',
      feature: 'improve-draft',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      draftText: 'hey babe how was your day',
      forceRegenerate: false,
    });

    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    const [groupId, messageCount] =
      fanslyClient.loadMessages.mock.calls[0] as unknown as [string, number, ...unknown[]];
    expect(groupId).toBe('group-1');
    expect(messageCount).toBe(17);
  });

  it('uses the dedicated ping message count for ping history', async () => {
    (mockStorage.settings as Record<string, unknown>).quickMessageCount = 100;
    (mockStorage.settings as Record<string, unknown>).pingMessageCount = 17;
    const fanslyClient = buildFanslyClientMock();
    const { coordinator } = await createCoordinatorHarness({ fanslyClient });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'ping-op',
      feature: 'ping',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    const [groupId, messageCount] =
      fanslyClient.loadMessages.mock.calls[0] as unknown as [string, number, ...unknown[]];
    expect(groupId).toBe('group-1');
    expect(messageCount).toBe(17);
  });

  it('keeps using quickMessageCount for fast-reply history', async () => {
    (mockStorage.settings as Record<string, unknown>).quickMessageCount = 13;
    (mockStorage.settings as Record<string, unknown>).pingMessageCount = 99;
    const fanslyClient = buildFanslyClientMock();
    const { coordinator } = await createCoordinatorHarness({ fanslyClient });

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

    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    const [groupId, messageCount] =
      fanslyClient.loadMessages.mock.calls[0] as unknown as [string, number, ...unknown[]];
    expect(groupId).toBe('group-1');
    expect(messageCount).toBe(13);
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
        if (callCount === 1 && model === 'anthropic:claude-opus-4-5') {
          throw new ChatGooseError('model_unavailable');
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
      expect.objectContaining({ model: 'anthropic:claude-opus-4-5' }),
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
        throw new ChatGooseError('model_unavailable');
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
    expectUserErrorIdentity(errorMessage?.error, {
      key: 'model_unavailable',
      code: 'CG-API-03',
    });
  });

  it('retries Anthropic rate limits once when Retry-After is 60 seconds or less', async () => {
    vi.useFakeTimers();

    const retryAtMs = currentNow + 30_000;
    let callCount = 0;
    const anthropicClient = {
      streamMessage: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new ChatGooseError('rate_limited', {
            retryAfterMs: 30_000,
            retryAtMs,
          });
        }
        return 'Retried reply';
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

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

    await vi.advanceTimersByTimeAsync(0);

    const waitingMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:progress' }> =>
        message.type === 'operation:progress' &&
        message.statusCode === 'CG-API-01',
    );
    expect(waitingMessage).toMatchObject({
      phase: 'generating',
      statusCode: 'CG-API-01',
      message: 'Rate limited. Waiting to retry…',
      retryAtMs,
    });
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await startPromise;

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(2);
    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );
    expect(completeMessage?.result.rawText).toBe('Retried reply');
  });

  it('uses the registry rate-limit code when retrying a plain rate-limited error object without code', async () => {
    vi.useFakeTimers();

    const retryAtMs = currentNow + 30_000;
    let callCount = 0;
    const anthropicClient = {
      streamMessage: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw {
            key: 'rate_limited',
            retryAfterMs: 30_000,
            retryAtMs,
          };
        }
        return 'Retried reply';
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

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

    await vi.advanceTimersByTimeAsync(0);

    const waitingMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:progress' }> =>
        message.type === 'operation:progress' &&
        message.statusCode === 'CG-API-01',
    );
    expect(waitingMessage).toMatchObject({
      phase: 'generating',
      statusCode: 'CG-API-01',
      message: 'Rate limited. Waiting to retry…',
      retryAtMs,
    });
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    await startPromise;

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(2);
  });

  it('does not auto-retry Anthropic rate limits when Retry-After is longer than 60 seconds', async () => {
    const anthropicClient = {
      streamMessage: vi.fn(async () => {
        throw new ChatGooseError('rate_limited', {
          retryAfterMs: 61_000,
          retryAtMs: currentNow + 61_000,
        });
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
    expectUserErrorIdentity(errorMessage?.error, {
      key: 'rate_limited',
      code: 'CG-API-01',
    });
  });

  it('retries Anthropic service_unavailable once before failing the operation', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const anthropicClient = {
      streamMessage: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new ChatGooseError('service_unavailable');
        }
        return 'Recovered reply';
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

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

    await vi.advanceTimersByTimeAsync(0);

    const waitingMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:progress' }> =>
        message.type === 'operation:progress' &&
        message.statusCode === 'CG-API-05',
    );
    expect(waitingMessage).toMatchObject({
      phase: 'generating',
      statusCode: 'CG-API-05',
      message: 'Anthropic Direct unavailable. Retrying…',
    });
    expect(typeof waitingMessage?.retryAtMs).toBe('number');
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await startPromise;

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(2);
    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );
    expect(completeMessage?.result.rawText).toBe('Recovered reply');
  });

  it('retries service_unavailable after provider progress arrives before text', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const anthropicClient = {
      streamMessage: vi.fn(async ({
        onProgress,
        onText,
      }: {
        onProgress?: () => void;
        onText: (text: string) => void;
      }) => {
        callCount += 1;
        if (callCount === 1) {
          onProgress?.();
          throw new ChatGooseError('service_unavailable');
        }
        onText('Recovered reply');
        return 'Recovered reply';
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

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

    await vi.advanceTimersByTimeAsync(0);

    const waitingMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:progress' }> =>
        message.type === 'operation:progress' &&
        message.statusCode === 'CG-API-05',
    );
    expect(waitingMessage).toMatchObject({
      phase: 'generating',
      statusCode: 'CG-API-05',
      message: 'Anthropic Direct unavailable. Retrying…',
    });
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await startPromise;

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(2);
    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );
    expect(completeMessage?.result.rawText).toBe('Recovered reply');
  });

  it('does not retry Anthropic service_unavailable more than once', async () => {
    vi.useFakeTimers();

    const anthropicClient = {
      streamMessage: vi.fn(async () => {
        throw new ChatGooseError('service_unavailable');
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ anthropicClient });

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

    await vi.advanceTimersByTimeAsync(5_000);
    await startPromise;

    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(2);
    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );
    expectUserErrorIdentity(errorMessage?.error, {
      key: 'service_unavailable',
      code: 'CG-API-05',
    });
  });

  it('invalidates summary cache when model changes', async () => {
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fan-summary': 'claude-haiku-4-5',
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

    // Cache had modelId from default but we're using claude-haiku-4-5 — should miss
    expect(anthropicClient.streamMessage).toHaveBeenCalledTimes(1);
    expect(anthropicClient.streamMessage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'anthropic:claude-haiku-4-5' }),
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

  it('removes cache_control markers but preserves prompt text and block segmentation when prompt caching is off', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
      promptCachingEnabled: false,
    };

    const { coordinator, anthropicClient, port } = await createCoordinatorHarness({
      anthropicRawText: 'hey babe',
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

    const debugPromptMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:debugPrompt' }> =>
        message.type === 'operation:debugPrompt',
    );
    const streamArgs = anthropicClient.streamMessage.mock.calls[0]?.[0] as {
      systemBlocks: Array<{ text: string; cache_control?: unknown }>;
      userBlocks: Array<{ text: string; cache_control?: unknown }>;
    };

    expect(streamArgs.systemBlocks).toHaveLength(2);
    expect(streamArgs.userBlocks).toHaveLength(3);
    expect(streamArgs.systemBlocks.every((block) => block.cache_control === undefined)).toBe(true);
    expect(streamArgs.userBlocks.every((block) => block.cache_control === undefined)).toBe(true);
    expect(flattenSystemBlocksFromStreamCall(anthropicClient)).toBe(debugPromptMessage?.snapshot.system);
    expect(flattenUserBlocksFromStreamCall(anthropicClient)).toBe(debugPromptMessage?.snapshot.user);
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

  it('reports successful completed operations with feature, model, tokens, duration, and timestamp', async () => {
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    const anthropicClient = {
      streamMessage: vi.fn(async ({
        onUsage,
      }: {
        onUsage?: (usage: {
          input_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          output_tokens: number;
        }) => void;
      }) => {
        onUsage?.({
          input_tokens: 120,
          cache_creation_input_tokens: 8,
          cache_read_input_tokens: 4,
          output_tokens: 16,
        });
        advanceNow(321);
        return 'Reported reply';
      }),
    };
    const { coordinator } = await createCoordinatorHarness({
      anthropicClient,
      agencyHubUsageReporter,
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

    expect(agencyHubUsageReporter.enqueue).toHaveBeenCalledTimes(1);
    expect(agencyHubUsageReporter.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agencyHubBaseUrl: '',
        agencyHubApiKey: '',
        agencyHubDeviceToken: '',
        debugMode: false,
      }),
      expect.objectContaining({
        clientEventId: 'reply-op',
        feature: 'fast-reply',
        model: getAgencyHubModelId(DEFAULT_MODEL_ID),
        inputTokens: 120,
        outputTokens: 16,
        cacheWriteTokens: 8,
        cacheReadTokens: 4,
        conversationId: 'group-1',
        durationMs: 321,
        isCacheHit: false,
        isRegeneration: false,
        completedAt: new Date(currentNow).toISOString(),
      }),
    );
  });

  it('reports canonical OpenRouter model ids to Agency Hub usage', async () => {
    (mockStorage.settings as Record<string, unknown>).openRouterApiKey = 'sk-or-v1-test';
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'openrouter:x-ai/grok-4.3',
    };
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    const { coordinator } = await createCoordinatorHarness({
      agencyHubUsageReporter,
      anthropicClient: {
        streamMessage: vi.fn(async ({ onUsage }: {
          onUsage?: (usage: {
            input_tokens: number;
            cache_creation_input_tokens: number;
            cache_read_input_tokens: number;
            output_tokens: number;
          }) => void;
        }) => {
          onUsage?.({
            input_tokens: 500,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 300,
            output_tokens: 5,
          });
          return 'OpenRouter reply';
        }),
      },
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

    expect(agencyHubUsageReporter.enqueue.mock.calls[0]?.[1]).toMatchObject({
      clientEventId: 'reply-op',
      model: 'openrouter:x-ai/grok-4.3',
      inputTokens: 500,
      cacheWriteTokens: 200,
      cacheReadTokens: 300,
      outputTokens: 5,
    });
  });

  it('keeps feature names for improve-draft and hi-greeting while using the shared fast-reply model config', async () => {
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.loadMessages.mockResolvedValue({
      pages: buildMessagePages(5),
      pagesLoaded: 1,
      targetPages: 1,
    });
    const { coordinator } = await createCoordinatorHarness({
      fanslyClient,
      agencyHubUsageReporter,
      anthropicClient: {
        streamMessage: vi.fn(async () => 'Reply'),
      },
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'improve-op',
      feature: 'improve-draft',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      draftText: 'fix this',
      forceRegenerate: false,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'hi-op',
      feature: 'hi-greeting',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    expect(agencyHubUsageReporter.enqueue).toHaveBeenCalledTimes(2);
    expect(agencyHubUsageReporter.enqueue.mock.calls[0]?.[1]).toMatchObject({
      clientEventId: 'improve-op',
      feature: 'improve-draft',
      model: getAgencyHubModelId(DEFAULT_MODEL_ID),
    });
    expect(agencyHubUsageReporter.enqueue.mock.calls[1]?.[1]).toMatchObject({
      clientEventId: 'hi-op',
      feature: 'hi-greeting',
      model: getAgencyHubModelId(DEFAULT_MODEL_ID),
    });
  });

  it('reports cached fan-summary hits as zero-token cache hits', async () => {
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    const { coordinator } = await createCoordinatorHarness({
      agencyHubUsageReporter,
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

    expect(agencyHubUsageReporter.enqueue).toHaveBeenCalledTimes(1);
    expect(agencyHubUsageReporter.enqueue.mock.calls[0]?.[1]).toMatchObject({
      clientEventId: 'summary-op',
      feature: 'fan-summary',
      model: getAgencyHubModelId(DEFAULT_FEATURE_MODELS['fan-summary']),
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      conversationId: 'group-1',
      isCacheHit: true,
      isRegeneration: false,
    });
  });

  it('reports Agency Hub prefetched fan-summary hits as zero-token cache hits', async () => {
    delete mockStorage['summary:group-1'];
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    const { coordinator } = await createCoordinatorHarness({
      agencyHubUsageReporter,
      agencyHubClient: {
        isConfigured: vi.fn(() => true),
        fetchFanProfileByConversation: vi.fn(async () => ({
          status: 'fetched',
          reason: 'fetched',
          baseUrl: 'http://localhost:3000',
          pageLabel: 'creator-fs',
          body: 'Hub summary',
          createdAtMs: 1234,
          fanAccountId: 'fan-1',
        })),
        pushFanProfile: vi.fn(async () => ({
          status: 'skipped',
          reason: 'disabled',
          baseUrl: null,
        })),
      },
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

    expect(agencyHubUsageReporter.enqueue).toHaveBeenCalledTimes(1);
    expect(agencyHubUsageReporter.enqueue.mock.calls[0]?.[1]).toMatchObject({
      clientEventId: 'summary-op',
      feature: 'fan-summary',
      model: getAgencyHubModelId(DEFAULT_FEATURE_MODELS['fan-summary']),
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      conversationId: 'group-1',
      isCacheHit: true,
    });
  });

  it('does not report failed operations', async () => {
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    const { coordinator } = await createCoordinatorHarness({
      agencyHubUsageReporter,
      anthropicClient: {
        streamMessage: vi.fn(async () => {
          throw new ChatGooseError('network_error');
        }),
      },
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

    expect(agencyHubUsageReporter.enqueue).not.toHaveBeenCalled();
  });

  it('does not report discarded operations', async () => {
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    let streamStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const anthropicClient = {
      streamMessage: vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        streamStarted?.();
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      }),
    };
    const { coordinator } = await createCoordinatorHarness({
      anthropicClient,
      agencyHubUsageReporter,
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

    await started;
    await coordinator.handlePortMessage(1, {
      type: 'tab:routeChanged',
      groupId: 'group-2',
      routeNonce: 2,
    });
    await startPromise;

    expect(agencyHubUsageReporter.enqueue).not.toHaveBeenCalled();
  });

  it('reports the fallback model after model_unavailable retries', async () => {
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'claude-opus-4-5',
    };
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    let callCount = 0;
    const anthropicClient = {
      streamMessage: vi.fn(async ({
        model,
        onUsage,
      }: {
        model: string;
        onUsage?: (usage: {
          input_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          output_tokens: number;
        }) => void;
      }) => {
        callCount += 1;
        if (callCount === 1 && model === 'anthropic:claude-opus-4-5') {
          throw new ChatGooseError('model_unavailable');
        }
        onUsage?.({
          input_tokens: 50,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 2,
          output_tokens: 7,
        });
        return 'Fallback reply';
      }),
    };
    const { coordinator } = await createCoordinatorHarness({
      anthropicClient,
      agencyHubUsageReporter,
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

    expect(agencyHubUsageReporter.enqueue).toHaveBeenCalledTimes(1);
    expect(agencyHubUsageReporter.enqueue.mock.calls[0]?.[1]).toMatchObject({
      clientEventId: 'reply-op',
      model: getAgencyHubModelId(DEFAULT_MODEL_ID),
    });
  });

  it('reports one AI usage event per successful compare card and no extra aggregate compare event', async () => {
    await mockCompareCards([
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
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    const anthropicClient = {
      streamMessage: vi.fn(async ({
        onUsage,
      }: {
        onUsage?: (usage: {
          input_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          output_tokens: number;
        }) => void;
      }) => {
        onUsage?.({
          input_tokens: 75,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 3,
          output_tokens: 6,
        });
        return 'Compare reply';
      }),
    };
    const { coordinator } = await createCoordinatorHarness({
      anthropicClient,
      agencyHubUsageReporter,
    });

    await coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'compare-op',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    expect(agencyHubUsageReporter.enqueue).toHaveBeenCalledTimes(2);
    expect(agencyHubUsageReporter.enqueue.mock.calls.map((call) => call[1].clientEventId)).toEqual(
      expect.arrayContaining(['compare-op:current:personality-1', 'compare-op:draft-1']),
    );
    for (const [, event] of agencyHubUsageReporter.enqueue.mock.calls) {
      expect(event).toMatchObject({
        feature: 'fast-reply',
        model: getAgencyHubModelId(DEFAULT_MODEL_ID),
        conversationId: 'group-1',
        isCacheHit: false,
        isRegeneration: false,
      });
    }
  });

  it('reports only successful compare cards when compare has mixed outcomes', async () => {
    await mockCompareCards([
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
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    const anthropicClient = {
      streamMessage: vi.fn(async ({
        systemBlocks,
        onUsage,
      }: {
        systemBlocks: Array<{ text: string }>;
        onUsage?: (usage: {
          input_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          output_tokens: number;
        }) => void;
      }) => {
        const system = systemBlocks.map((block) => block.text).join('');
        if (system.includes('Current baseline personality')) {
          onUsage?.({
            input_tokens: 50,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 2,
            output_tokens: 0,
          });
          throw new ChatGooseError('network_error');
        }
        onUsage?.({
          input_tokens: 75,
          cache_creation_input_tokens: 5,
          cache_read_input_tokens: 3,
          output_tokens: 6,
        });
        return 'Draft reply';
      }),
    };
    const { coordinator } = await createCoordinatorHarness({
      anthropicClient,
      agencyHubUsageReporter,
    });

    await coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'compare-op',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    expect(agencyHubUsageReporter.enqueue).toHaveBeenCalledTimes(1);
    expect(agencyHubUsageReporter.enqueue.mock.calls[0]?.[1]).toMatchObject({
      clientEventId: 'compare-op:draft-1',
      feature: 'fast-reply',
    });
  });

  it('reports the fallback model for successful compare cards after model_unavailable retries', async () => {
    await mockCompareCards([
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
    (mockStorage.settings as Record<string, unknown>).featureModels = {
      ...DEFAULT_FEATURE_MODELS,
      'fast-reply': 'claude-opus-4-5',
    };
    const agencyHubUsageReporter = { enqueue: vi.fn() };
    const anthropicClient = {
      streamMessage: vi.fn(async ({
        model,
        onUsage,
      }: {
        model: string;
        onUsage?: (usage: {
          input_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          output_tokens: number;
        }) => void;
      }) => {
        if (model === 'anthropic:claude-opus-4-5') {
          throw new ChatGooseError('model_unavailable');
        }
        onUsage?.({
          input_tokens: 60,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 1,
          output_tokens: 8,
        });
        return 'Fallback compare reply';
      }),
    };
    const { coordinator } = await createCoordinatorHarness({
      anthropicClient,
      agencyHubUsageReporter,
    });

    await coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'compare-op',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: true,
      replyMode: 'default',
    });

    expect(agencyHubUsageReporter.enqueue).toHaveBeenCalledTimes(2);
    for (const [, event] of agencyHubUsageReporter.enqueue.mock.calls) {
      expect(event).toMatchObject({
        model: getAgencyHubModelId(DEFAULT_MODEL_ID),
        feature: 'fast-reply',
        isRegeneration: true,
      });
    }
  });
});
