/* eslint-disable @typescript-eslint/no-explicit-any --
   legacy suite drives background operations through `as any` seams; the
   operations surface is rewritten onto kernel feature services in Stage 32
   Task 3. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEEP_OPERATION_LLM_IDLE_TIMEOUT_MS,
  DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS,
  DEEP_OPERATION_LLM_TTFB_TIMEOUT_MS,
  DEEP_OPERATION_PREP_TIMEOUT_MS,
  FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT,
  QUICK_OPERATION_TIMEOUT_MS,
  STORAGE_SCHEMA_VERSION,
  SUMMARY_SYNC_RETRY_COOLDOWN_MS,
} from '../src/shared/constants.js';
import { ChatGooseError } from '../src/shared/errors.js';
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

// Stage 32: prompt assembly is kernel-side — the observable surface is the
// kernel REQUEST (refs + clientContext). These helpers read it off the stub.
function kernelRequestFromStreamCall(
  kernelGateway: { streamFeature: ReturnType<typeof vi.fn> },
  callIndex = 0,
): Record<string, any> {
  return kernelGateway.streamFeature.mock.calls[callIndex]?.[1] ?? {};
}

/** Everything the client shipped as context values, flattened — the
 * post-cutover analogue of "what reached the user prompt". */
function flattenUserBlocksFromStreamCall(
  kernelGateway: { streamFeature: ReturnType<typeof vi.fn> },
  callIndex = 0,
): string {
  const request = kernelRequestFromStreamCall(kernelGateway, callIndex);
  const context = request.clientContext ?? {};
  return [
    context.transcript,
    context.fanSpendingData,
    context.fanSubscriptionData,
    context.fanBio,
    request.draftText,
  ].filter(Boolean).join('\n');
}

async function createCoordinatorHarness(options?: {
  anthropicRawText?: string;
  fanslyClient?: ReturnType<typeof buildFanslyClientMock>;
  kernelGateway?: { isConfigured: ReturnType<typeof vi.fn>; streamFeature: ReturnType<typeof vi.fn> };
  agencyHubClient?: {
    isConfigured: (...args: any[]) => boolean;
    fetchFanProfileByConversation: (...args: any[]) => Promise<any>;
    pushFanProfile: (...args: any[]) => Promise<any>;
  };
  unusedReporter?: {
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
  const kernelGateway = options?.kernelGateway ?? {
    isConfigured: vi.fn(() => true),
    streamFeature: vi.fn(async () => options?.anthropicRawText ?? 'Result'),
  };
  const agencyHubClient = options?.agencyHubClient ?? {
    isConfigured: vi.fn(() => false),
    // Stage 32: the kernel lane resolves the page label pre-generation.
    resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
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
  const storageCoordinator = new StorageCoordinator();

  const coordinator = new OperationCoordinator(
    sessionStore,
    new TabContextStore(),
    fanslyClient as never,
    kernelGateway as never,
    storageCoordinator,
    agencyHubClient as never,
  ) as any;
  const port = createMockRuntimePort(1);
  coordinator.registerPort(port as never);

  return {
    coordinator,
    fanslyClient,
    kernelGateway,
    agencyHubClient,
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
        agencyHubBaseUrl: '',
        agencyHubApiKey: '',
        agencyHubDeviceToken: '',
        quickMessageCount: 100,
        pingMessageCount: 100,
        improveMessageCount: 100,
        deepMessageCount: 500,
        debugMode: false,
        promptCachingEnabled: true,
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
        modelId: 'kernel',
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
    const { port, kernelGateway, fanslyClient } = await createCoordinatorHarness();

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
    expect(kernelGateway.streamFeature).not.toHaveBeenCalled();
    expect(fanslyClient.loadMessages).not.toHaveBeenCalled();
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
      modelId: 'kernel',
      fanAccountId: 'fan-1',
    });
  });

  // Core #136: the kernel injects the HUB copy of a ready Scan into other
  // features' prompts, so a valid-but-unsaved local summary is re-pushed
  // opportunistically on chat open — bounded by in-flight dedup + cooldown.
  describe('summary hub-sync retry on chat open', () => {
    function hubConfiguredSettings(): void {
      mockStorage.settings = {
        ...(mockStorage.settings as Record<string, unknown>),
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'hub-key',
      };
    }

    function retryHubClient(
      pushResult: Record<string, unknown>,
      fetchResult: Record<string, unknown> = {
        status: 'not-found',
        reason: 'profile_missing',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      },
    ) {
      return {
        isConfigured: vi.fn(() => true),
        resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
        fetchFanProfileByConversation: vi.fn(async () => fetchResult),
        pushFanProfile: vi.fn(async () => pushResult),
      };
    }

    const tabInit = (coordinator: any, routeNonce: number) =>
      coordinator.handlePortMessage(1, {
        type: 'tab:init',
        groupId: 'group-1',
        routeNonce,
      });

    it('re-pushes a ready-but-unsaved summary and stops once the hub confirms the save', async () => {
      hubConfiguredSettings();
      const agencyHubClient = retryHubClient({
        status: 'pushed',
        reason: 'pushed',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      });
      const { coordinator } = await createCoordinatorHarness({ agencyHubClient });

      await tabInit(coordinator, 1);
      await vi.waitFor(() => {
        expect(agencyHubClient.pushFanProfile).toHaveBeenCalledTimes(1);
        expect(mockStorage['summary:group-1']).toMatchObject({
          agencyHubSync: expect.objectContaining({ state: 'saved' }),
        });
      });

      // Saved → the next chat open does not push again.
      await tabInit(coordinator, 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(agencyHubClient.pushFanProfile).toHaveBeenCalledTimes(1);
    });

    it('does not push when the summary is already saved for the current hub target', async () => {
      hubConfiguredSettings();
      mockStorage['summary:group-1'] = {
        ...(mockStorage['summary:group-1'] as Record<string, unknown>),
        agencyHubSync: {
          state: 'saved',
          generatedAt: 2000,
          baseUrl: 'http://localhost:3000',
          pageLabel: 'creator-fs',
          syncedAt: 1,
          updatedAt: 1,
        },
      };
      const agencyHubClient = retryHubClient({
        status: 'pushed',
        reason: 'pushed',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      });
      const { coordinator } = await createCoordinatorHarness({ agencyHubClient });

      await tabInit(coordinator, 1);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(agencyHubClient.pushFanProfile).not.toHaveBeenCalled();
    });

    it('waits out the cooldown after a failed push instead of hammering the hub', async () => {
      hubConfiguredSettings();
      const agencyHubClient = retryHubClient({
        status: 'failed',
        reason: 'network',
        baseUrl: 'http://localhost:3000',
        pageLabel: null,
      });
      const { coordinator } = await createCoordinatorHarness({ agencyHubClient });

      await tabInit(coordinator, 1);
      await vi.waitFor(() => {
        expect(agencyHubClient.pushFanProfile).toHaveBeenCalledTimes(1);
      });

      // Inside the cooldown window: refresh does not re-push.
      await tabInit(coordinator, 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(agencyHubClient.pushFanProfile).toHaveBeenCalledTimes(1);

      // Past the cooldown: the retry fires again.
      advanceNow(SUMMARY_SYNC_RETRY_COOLDOWN_MS + 1_000);
      await tabInit(coordinator, 3);
      await vi.waitFor(() => {
        expect(agencyHubClient.pushFanProfile).toHaveBeenCalledTimes(2);
      });
    });

    it('records "saved" without a duplicate append when the hub already holds this body', async () => {
      hubConfiguredSettings();
      const agencyHubClient = retryHubClient(
        { status: 'pushed', reason: 'pushed', baseUrl: 'http://localhost:3000', pageLabel: 'creator-fs' },
        {
          status: 'fetched',
          reason: 'fetched',
          baseUrl: 'http://localhost:3000',
          pageLabel: 'creator-fs',
          body: 'Old summary',
          createdAtMs: 5000,
          fanAccountId: 'fan-1',
        },
      );
      const { coordinator } = await createCoordinatorHarness({ agencyHubClient });

      await tabInit(coordinator, 1);
      await vi.waitFor(() => {
        expect(mockStorage['summary:group-1']).toMatchObject({
          agencyHubSync: expect.objectContaining({ state: 'saved' }),
        });
      });
      expect(agencyHubClient.pushFanProfile).not.toHaveBeenCalled();
    });

    it('never supersedes a newer hub dossier with a stale local re-push', async () => {
      hubConfiguredSettings();
      const agencyHubClient = retryHubClient(
        { status: 'pushed', reason: 'pushed', baseUrl: 'http://localhost:3000', pageLabel: 'creator-fs' },
        {
          status: 'fetched',
          reason: 'fetched',
          baseUrl: 'http://localhost:3000',
          pageLabel: 'creator-fs',
          // Another device re-scanned: different body, generated AFTER our
          // local summary (generatedAt 2000).
          body: 'Newer dossier from another device',
          createdAtMs: 999_999,
          sourceGeneratedAtMs: 888_888,
          fanAccountId: 'fan-1',
        },
      );
      const { coordinator } = await createCoordinatorHarness({ agencyHubClient });

      await tabInit(coordinator, 1);
      await vi.waitFor(() => {
        expect(agencyHubClient.fetchFanProfileByConversation).toHaveBeenCalledTimes(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(agencyHubClient.pushFanProfile).not.toHaveBeenCalled();
      expect(mockStorage['summary:group-1']).not.toMatchObject({
        agencyHubSync: expect.objectContaining({ state: 'saved' }),
      });

      // Parked for this worker lifetime: another chat open changes nothing.
      await tabInit(coordinator, 2);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(agencyHubClient.fetchFanProfileByConversation).toHaveBeenCalledTimes(1);
      expect(agencyHubClient.pushFanProfile).not.toHaveBeenCalled();
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
    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    expect(kernelRequestFromStreamCall(kernelGateway)).toMatchObject({
      feature: 'fast-reply',
      pageLabel: 'creator-fs',
    });
    expect(
      kernelRequestFromStreamCall(kernelGateway).clientContext.fanSubscriptionData,
    ).toBe('');
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
    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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
    expect(flattenUserBlocksFromStreamCall(kernelGateway)).toContain(
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
    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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
    expect(flattenUserBlocksFromStreamCall(kernelGateway)).toContain(
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
    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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
    expect(flattenUserBlocksFromStreamCall(kernelGateway)).toContain(
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
    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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

    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    expect(flattenUserBlocksFromStreamCall(kernelGateway)).toContain(
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
    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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
    const prompt = flattenUserBlocksFromStreamCall(kernelGateway);
    expect(verifiedRequests).toHaveLength(FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT);
    expect(prompt).toContain('[Video — PPV $33.00, not purchased] ppv 1');
    expect(prompt).toContain('[Video — PPV $33.00, unknown] ppv 11');
  });

  it('includes the selected tone in fast-reply debug prompts and uncached user blocks', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const { coordinator, kernelGateway, port } = await createCoordinatorHarness({
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

    // Tone rendering is kernel-side now — the observable is the request's
    // replyTone plus the debug snapshot still carrying the raw transcript.
    expect(kernelRequestFromStreamCall(kernelGateway).replyTone).toBe('flirty');
    expect(debugPromptMessage?.snapshot.transcript.length).toBeGreaterThan(0);
    expect(debugPromptMessage?.snapshot.system).toBe('[assembled kernel-side]');
  });

  it('uses full subscription lookup for deep features and still includes subscription data in the prompt', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(
      buildSubscriptionContext(),
    );
    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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
    expect(kernelRequestFromStreamCall(kernelGateway)).toMatchObject({
      feature: 'chat-review',
      pageLabel: 'creator-fs',
    });
    expect(
      kernelRequestFromStreamCall(kernelGateway).clientContext.fanSubscriptionData,
    ).not.toBe('');
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

    const { coordinator, kernelGateway, port } = await createCoordinatorHarness();

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
    expect(kernelGateway.streamFeature).not.toHaveBeenCalled();
  });

  it('runs the current-persona card on the kernel lane and errors draft cards', async () => {
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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async (
        _settings: unknown,
        _request: Record<string, any>,
        callbacks: { onText: (text: string) => void },
      ) => {
        callbacks.onText('Current reply');
        return 'Current reply';
      }),
    };
    const { coordinator, port, fanslyClient } = await createCoordinatorHarness({ kernelGateway });

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
    const completeMessages = messages.filter(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:cardComplete' }> =>
        message.type === 'compare:cardComplete',
    );
    const errorMessages = messages.filter(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:cardError' }> =>
        message.type === 'compare:cardError',
    );

    // One shared prep pass regardless of card count.
    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    expect(fanslyClient.getGroup).toHaveBeenCalledTimes(1);

    // Stage 32: only the kernel-known current persona runs (one fast-reply
    // generation with its personaKey); local draft cards died with the local
    // prompt library — they error, not silently drop.
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    const request = kernelRequestFromStreamCall(kernelGateway);
    expect(request).toMatchObject({
      feature: 'fast-reply',
      personaKey: 'personality-1',
      pageLabel: 'creator-fs',
    });
    expect(request.clientContext.transcript.length).toBeGreaterThan(0);
    expect(completeMessages.map((message) => message.cardId)).toEqual(['current:personality-1']);
    expect(errorMessages.map((message) => message.cardId)).toEqual(['draft-1']);
    expect(errorMessages[0]?.error.key).toBe('compare_cards_unavailable');
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

    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async (
        _settings: unknown,
        _request: Record<string, any>,
        callbacks: { onText: (text: string) => void },
      ) => {
        callbacks.onText('Reply');
        return 'Reply';
      }),
    };
    const { coordinator } = await createCoordinatorHarness({ kernelGateway });

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

    // Tone rendering is kernel-side — the request carries the tone; only the
    // kernel-known current card reaches the gateway.
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    expect(kernelRequestFromStreamCall(kernelGateway).replyTone).toBe('upsell');
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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async (
        _settings: unknown,
        _request: Record<string, any>,
        callbacks: {
          onUsage?: (usage: {
            inputTokens: number;
            outputTokens: number;
            cacheWriteTokens: number;
            cacheReadTokens: number;
            costMicroUsd: number;
            costApproximate: boolean;
          }) => void;
        },
      ) => {
        callbacks.onUsage?.({
          inputTokens: 50,
          outputTokens: 0,
          cacheWriteTokens: 4,
          cacheReadTokens: 2,
          costMicroUsd: 166,
          costApproximate: false,
        });
        throw new ChatGooseError('network_error');
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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
    const cardErrors = messages.filter(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:cardError' }> =>
        message.type === 'compare:cardError',
    );

    // The current card fails on the kernel lane with its gateway-priced spend
    // attached; the draft card errors client-side (no kernel persona). The
    // session still completes.
    const currentError = cardErrors.find((message) => message.cardId === 'current:personality-1');
    expectUserErrorIdentity(currentError?.error, {
      key: 'network_error',
      code: 'CG-NET-01',
    });
    expect(currentError?.llmSpend).toEqual({
      totalTokens: 56,
      inputTokens: 50,
      cacheWriteTokens: 4,
      cacheReadTokens: 2,
      outputTokens: 0,
      totalUsd: 0.000166,
      uncachedUsd: 0.000166,
      cacheEffectUsd: 0,
      cacheEffectKind: 'neutral',
      cacheWriteUsd: 0,
      cacheReadUsd: 0,
      approximate: false,
    });
    const draftError = cardErrors.find((message) => message.cardId === 'draft-1');
    expect(draftError?.error.key).toBe('compare_cards_unavailable');
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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async () => {
        throw new DOMException('Aborted', 'AbortError');
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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
        message.type === 'compare:cardError' && message.cardId === 'current:personality-1',
    );

    expectUserErrorIdentity(cardError?.error, {
      key: 'network_error',
      code: 'CG-NET-01',
    });
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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        (
          _settings: unknown,
          _request: Record<string, any>,
          _callbacks: unknown,
          signal: AbortSignal,
        ) => new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async (
        _settings: unknown,
        _request: Record<string, any>,
        callbacks: { onText: (text: string) => void },
      ) => {
        callbacks.onText('hi');
        return 'hi';
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        (
          _settings: unknown,
          _request: Record<string, any>,
          _callbacks: unknown,
          signal: AbortSignal,
        ) => new Promise<string>((_resolve, reject) => {
          startedStreams += 1;
          // Stage 32: only the current card reaches the gateway (draft cards
          // error client-side) — one stream is the full set.
          if (startedStreams === 1) {
            resolveStreamsStarted?.();
          }
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async (
        _settings: unknown,
        _request: Record<string, any>,
        callbacks: {
          onText: (text: string) => void;
          onUsage?: (usage: {
            inputTokens: number;
            outputTokens: number;
            cacheWriteTokens: number;
            cacheReadTokens: number;
            costMicroUsd: number;
            costApproximate: boolean;
          }) => void;
        },
      ) => {
        callbacks.onUsage?.({
          inputTokens: 100,
          outputTokens: 8,
          cacheWriteTokens: 10,
          cacheReadTokens: 5,
          costMicroUsd: 700,
          costApproximate: false,
        });
        callbacks.onText('Hello');
        return 'Hello';
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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
      // Gateway-priced (Stage 32): totals authoritative, cache decomposition
      // neutral — the client has no price tables anymore.
      totalUsd: 0.0007,
      uncachedUsd: 0.0007,
      cacheEffectUsd: 0,
      cacheEffectKind: 'neutral',
      cacheWriteUsd: 0,
      cacheReadUsd: 0,
      approximate: false,
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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        (
          _settings: unknown,
          _request: Record<string, any>,
          _callbacks: unknown,
          signal: AbortSignal,
        ) => new Promise<string>((_resolve, reject) => {
          resolveStreamStarted?.();
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      kernelGateway,
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

  it('includes partial profiling data on error in debug mode', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      debugMode: true,
    };

    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async () => {
        advanceNow(300);
        throw new ChatGooseError('network_error');
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      kernelGateway,
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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async () => {
        throw new ChatGooseError('network_error');
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      kernelGateway,
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

    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async () => {
        advanceNow(300);
        throw new DOMException('Aborted', 'AbortError');
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      kernelGateway,
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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        (
          _settings: unknown,
          _request: Record<string, any>,
          _callbacks: unknown,
          signal: AbortSignal,
        ) => new Promise<string>((_resolve, reject) => {
          resolveStreamStarted?.();
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      kernelGateway,
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

    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        (
          _settings: unknown,
          _request: Record<string, any>,
          callbacks: Record<string, any>,
          signal: AbortSignal,
        ) => new Promise<string>((resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });

          setTimeout(() => {
            callbacks.onText('Long');
          }, 10_000);
          // Kernel-lane keepalive between text chunks = reasoning deltas.
          setTimeout(() => {
            callbacks.onReasoningDelta?.('…');
          }, 40_000);
          setTimeout(() => {
            callbacks.onReasoningDelta?.('…');
          }, 70_000);
          setTimeout(() => {
            callbacks.onReasoningDelta?.('…');
          }, 100_000);
          setTimeout(() => {
            callbacks.onReasoningDelta?.('…');
          }, 130_000);
          setTimeout(() => {
            callbacks.onText(' summary');
            resolve('Long summary');
          }, 170_000);
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      fanslyClient,
      kernelGateway,
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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        (
          _settings: unknown,
          _request: Record<string, any>,
          _callbacks: unknown,
          signal: AbortSignal,
        ) => new Promise<string>((_resolve, reject) => {
          resolveStreamStarted?.();
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        (
          _settings: unknown,
          _request: Record<string, any>,
          callbacks: Record<string, any>,
          signal: AbortSignal,
        ) => new Promise<string>((resolve, reject) => {
          resolveStreamStarted?.();
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });

          setTimeout(() => {
            callbacks.onProgress?.();
            callbacks.onReasoningDelta?.('thinking_delta');
          }, 10_000);
          setTimeout(() => {
            callbacks.onText('Deep review');
          }, 50_000);
          setTimeout(() => {
            resolve('Deep review');
          }, 51_000);
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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

    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        (
          _settings: unknown,
          _request: Record<string, any>,
          callbacks: Record<string, any>,
          signal: AbortSignal,
        ) => new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });

          setTimeout(() => {
            callbacks.onText('Hello');
          }, 1_000);
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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

    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        (
          _settings: unknown,
          _request: Record<string, any>,
          callbacks: Record<string, any>,
          signal: AbortSignal,
        ) => new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });

          setTimeout(() => {
            callbacks.onText('Hello');
          }, 1_000);
          for (let offset = 31_000; offset < DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS; offset += 30_000) {
            setTimeout(() => {
              callbacks.onProgress?.();
            }, offset);
          }
        }),
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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

    const { coordinator, port, fanslyClient, kernelGateway } = await createCoordinatorHarness();

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
    expect(kernelGateway.streamFeature).not.toHaveBeenCalled();
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
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
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

    const { coordinator, kernelGateway, fanslyClient } = await createCoordinatorHarness({
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
    expect(kernelGateway.streamFeature).not.toHaveBeenCalled();
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
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
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

    const { coordinator, kernelGateway, fanslyClient, port } = await createCoordinatorHarness({
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
      modelId: 'kernel',
      fanAccountId: 'fan-9',
      agencyHubSync: {
        state: 'saved',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      },
    });
    expect(fanslyClient.loadMessages).not.toHaveBeenCalled();
    expect(kernelGateway.streamFeature).not.toHaveBeenCalled();
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
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
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

    const { coordinator, kernelGateway, fanslyClient, port } = await createCoordinatorHarness({
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
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
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
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
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

    const { coordinator, kernelGateway, fanslyClient, port } = await createCoordinatorHarness({
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
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    expect(postedMessages(port).find((message) => message.type === 'operation:error')).toBeUndefined();
  });

  it('tries Hub prefetch before regenerating when the local cache entry is stale for the current model', async () => {
    // A pre-cutover entry pinned to a vendor model id is stale against the
    // 'kernel' sentinel (the recorded one-time invalidation trade).
    (mockStorage['summary:group-1'] as Record<string, unknown>).modelId =
      'anthropic:claude-sonnet-4-6';
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };

    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
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

    const { coordinator, kernelGateway, port } = await createCoordinatorHarness({
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
    expect(kernelGateway.streamFeature).not.toHaveBeenCalled();
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
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
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

    const { coordinator, kernelGateway, fanslyClient, port } = await createCoordinatorHarness({
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
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
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
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
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

    const { coordinator, kernelGateway, fanslyClient, port } = await createCoordinatorHarness({
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
    expect(kernelGateway.streamFeature).not.toHaveBeenCalled();
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
    // Stage 32: generation needs a page label; pin it so these tests
    // keep exercising the summary-sync path (their real subject).
    (agencyHubClient as any).resolvePageLabelForUsername = vi.fn(async () => 'creator-fs');
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

  it('W9.4/A18: caches a fresh fan summary even when the meta frame names a real vendor model', async () => {
    // Pre-fix, the write was gated on `actualModel === resolvedModel` — but
    // resolvedModel is the 'kernel' cache sentinel while the kernel's meta
    // frame always carries the real vendor model id, so in production the
    // gate never passed and fresh summaries were never cached.
    delete mockStorage['summary:group-1'];
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async (
        _settings: unknown,
        _request: Record<string, any>,
        callbacks: {
          onText: (text: string) => void;
          onMeta?: (meta: { requestId: string; clientRequestId: string; model: string }) => void;
        },
      ) => {
        callbacks.onMeta?.({
          requestId: 'gen-1',
          clientRequestId: 'summary-op',
          model: 'claude-sonnet-4-5',
        });
        callbacks.onText('Fresh summary');
        return 'Fresh summary';
      }),
    };
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    const { coordinator, port } = await createCoordinatorHarness({
      kernelGateway,
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

    expect(postedMessages(port).find((message) => message.type === 'operation:error')).toBeUndefined();
    const cacheEntry = mockStorage['summary:group-1'] as SummaryCacheEntry | undefined;
    expect(cacheEntry).toBeDefined();
    expect(cacheEntry?.summary).toBe('Fresh summary');
    // The cache identity stays the kernel sentinel — the pin the read path
    // (isValidSummaryCacheEntry(..., 'kernel')) checks against.
    expect(cacheEntry?.modelId).toBe('kernel');
    expect(cacheEntry?.spendingDataVerified).toBe(true);
    expect(cacheEntry?.subscriptionLookupVerified).toBe(true);
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
      modelId: 'kernel',
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
    // Stage 32: generation needs a page label; pin it so these tests
    // keep exercising the summary-sync path (their real subject).
    (agencyHubClient as any).resolvePageLabelForUsername = vi.fn(async () => 'creator-fs');
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
    // Stage 32: generation needs a page label; pin it so these tests
    // keep exercising the summary-sync path (their real subject).
    (agencyHubClient as any).resolvePageLabelForUsername = vi.fn(async () => 'creator-fs');
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
    // Stage 32: generation needs a page label; pin it so these tests
    // keep exercising the summary-sync path (their real subject).
    (agencyHubClient as any).resolvePageLabelForUsername = vi.fn(async () => 'creator-fs');
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
      modelId: 'kernel',
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
    // Stage 32: generation needs a page label; pin it so these tests
    // keep exercising the summary-sync path (their real subject).
    (agencyHubClient as any).resolvePageLabelForUsername = vi.fn(async () => 'creator-fs');
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

  it('passes the configured temperature for each operation type', async () => {
    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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

    // Temperatures are kernel policy now — the observable is feature routing.
    expect(kernelRequestFromStreamCall(kernelGateway, 0).feature).toBe('fast-reply');
    expect(kernelRequestFromStreamCall(kernelGateway, 1).feature).toBe('chat-review');
    expect(kernelRequestFromStreamCall(kernelGateway, 2).feature).toBe('improve-draft');
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



  it('does not auto-retry Anthropic rate limits when Retry-After is longer than 60 seconds', async () => {
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async () => {
        throw new ChatGooseError('rate_limited', {
          retryAfterMs: 61_000,
          retryAtMs: currentNow + 61_000,
        });
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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

    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw new ChatGooseError('service_unavailable');
        }
        return 'Recovered reply';
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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
      message: 'Provider unavailable. Retrying…',
    });
    expect(typeof waitingMessage?.retryAtMs).toBe('number');
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await startPromise;

    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(2);
    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );
    expect(completeMessage?.result.rawText).toBe('Recovered reply');
  });

  it('retries service_unavailable after provider progress arrives before text', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async (
        _settings: unknown,
        _request: Record<string, any>,
        callbacks: {
          onMeta?: (meta: { requestId: string; clientRequestId: string; model: string }) => void;
          onText: (text: string) => void;
        },
      ) => {
        callCount += 1;
        if (callCount === 1) {
          callbacks.onMeta?.({ requestId: 'gen-1', clientRequestId: 'op', model: 'kernel-model' });
          throw new ChatGooseError('service_unavailable');
        }
        callbacks.onText('Recovered reply');
        return 'Recovered reply';
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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
      message: 'Provider unavailable. Retrying…',
    });
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await startPromise;

    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(2);
    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );
    expect(completeMessage?.result.rawText).toBe('Recovered reply');
  });

  it('does not retry Anthropic service_unavailable more than once', async () => {
    vi.useFakeTimers();

    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async () => {
        throw new ChatGooseError('service_unavailable');
      }),
    };

    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

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

    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(2);
    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );
    expectUserErrorIdentity(errorMessage?.error, {
      key: 'service_unavailable',
      code: 'CG-API-05',
    });
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

    const { coordinator, kernelGateway, port } = await createCoordinatorHarness({
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

    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
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

    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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

    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    const promptUser = flattenUserBlocksFromStreamCall(kernelGateway);
    expect(promptUser).toContain('Total gross (all-time): $595.00');
    expect(promptUser).toContain('Total net (all-time): $476.00');
    expect(promptUser).toContain('Monthly totals:');
  });

  it('produces zeroed spending data when both earnings calls succeed empty', async () => {
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(null);
    fanslyClient.getMonthlyEarnings.mockResolvedValue([]);

    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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

    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    const promptUser = flattenUserBlocksFromStreamCall(kernelGateway);
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

    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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
    const promptUser = flattenUserBlocksFromStreamCall(kernelGateway);
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

    const { coordinator, kernelGateway } = await createCoordinatorHarness({
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

    const promptUser = flattenUserBlocksFromStreamCall(kernelGateway);
    expect(promptUser).toContain('(some months could not be fetched)');
  });

  it('stale port disconnect does not cancel current operation (Bug 1)', async () => {
    let resolveStream: ((text: string) => void) | null = null;
    let resolveStreamStarted: (() => void) | null = null;
    const streamStarted = new Promise<void>((resolve) => { resolveStreamStarted = resolve; });
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        () => {
          resolveStreamStarted?.();
          return new Promise<string>((resolve) => { resolveStream = resolve; });
        },
      ),
    };
    const { coordinator } = await createCoordinatorHarness({ kernelGateway });

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
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        () => {
          resolveStreamStarted?.();
          return new Promise<string>((resolve) => { resolveStream = resolve; });
        },
      ),
    };
    const { coordinator } = await createCoordinatorHarness({ kernelGateway });

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





  it('does not report failed operations', async () => {
    const unusedReporter = { enqueue: vi.fn() };
    const { coordinator } = await createCoordinatorHarness({
      unusedReporter,
      kernelGateway: {
        isConfigured: vi.fn(() => true),
        streamFeature: vi.fn(async () => {
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

    expect(unusedReporter.enqueue).not.toHaveBeenCalled();
  });

  it('does not report discarded operations', async () => {
    const unusedReporter = { enqueue: vi.fn() };
    let streamStarted: (() => void) | null = null;
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async (
        _settings: unknown,
        _request: Record<string, any>,
        _callbacks: unknown,
        signal: AbortSignal,
      ) => {
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
      kernelGateway,
      unusedReporter,
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

    expect(unusedReporter.enqueue).not.toHaveBeenCalled();
  });
});
