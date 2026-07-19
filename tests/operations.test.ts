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
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
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
  Settings,
  SummaryCacheEntry,
} from '../src/shared/types.js';

let mockStorage: Record<string, unknown> = {};
let currentNow = 1_700_000_000_000;
let activeStorageCoordinator: {
  applyStorageChanges(
    changes: Record<string, browser.storage.StorageChange>,
    areaName: string,
  ): void;
} | null = null;

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
  mockStorage.personaCatalogSource = personaCatalogSource(
    mockStorage.settings as Settings,
  );
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
  activeStorageCoordinator = storageCoordinator;

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
    mockStorage.personaCatalog = [{
      key: personalityId,
      displayName: currentCard.label.replace(/ \(current\)$/, ''),
      definitionId: 'v1:current-card-definition',
      version: 1000,
      status: 'active',
    }];
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
    activeStorageCoordinator = null;
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
      personaCatalog: [{
        key: 'personality-1',
        displayName: 'Closer',
        definitionId: 'v1:personality-one-definition',
        version: 1000,
        status: 'active',
      }],
      personaCatalogSource: null,
      personaCatalogFetchedAt: null,
      accountMappings: {
        'account-1': 'personality-1',
      },
      accountAliases: {},
      knownAccounts: [],
      'summary:group-1': {
        summary: 'Old summary',
        personalityId: 'personality-1',
        personaDefinitionId: 'v1:personality-one-definition',
        personalityUpdatedAt: 1000,
        personaCatalogSource: null,
        generatedAt: 2000,
        spendingDataVerified: true,
        subscriptionLookupVerified: true,
        modelId: 'kernel',
        trustedTerminal: true,
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
            const changes = Object.fromEntries(Object.entries(items).map(([key, newValue]) => [
              key,
              { oldValue: mockStorage[key], newValue },
            ]));
            Object.assign(mockStorage, items);
            activeStorageCoordinator?.applyStorageChanges(changes, 'local');
          }),
          remove: vi.fn(async (keys: string | string[]) => {
            const changes: Record<string, browser.storage.StorageChange> = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.prototype.hasOwnProperty.call(mockStorage, key)) {
                changes[key] = { oldValue: mockStorage[key], newValue: undefined };
              }
              delete mockStorage[key];
            }
            if (Object.keys(changes).length > 0) {
              activeStorageCoordinator?.applyStorageChanges(changes, 'local');
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
    activeStorageCoordinator = null;
    delete (globalThis as typeof globalThis & {
      __CHATGOOSE_COMPARE_DRAFTS__?: Record<string, string>;
    }).__CHATGOOSE_COMPARE_DRAFTS__;
    vi.doUnmock('virtual:model-card-drafts');
    vi.doUnmock('../src/shared/compare-cards.js');
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('retains active Scan commit fences beyond 200 unrelated groups', async () => {
    const { coordinator } = await createCoordinatorHarness();
    const fences = coordinator as {
      reserveSummaryCommitToken(): number;
      registerSummaryCommit(groupId: string, operationId: string, token: number): void;
      isLatestSummaryCommit(
        groupId: string,
        operationId: string,
        token: number,
      ): boolean;
    };

    const firstToken = fences.reserveSummaryCommitToken();
    fences.registerSummaryCommit('first-group', 'first-operation', firstToken);

    for (let index = 0; index < 200; index += 1) {
      const token = fences.reserveSummaryCommitToken();
      fences.registerSummaryCommit(`other-group-${index}`, `other-operation-${index}`, token);
    }

    expect(fences.isLatestSummaryCommit(
      'first-group',
      'first-operation',
      firstToken,
    )).toBe(true);
  });

  it('keeps the last-good durable cache until a forced refresh can replace it', async () => {
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

    expect((globalThis as any).browser.storage.local.remove).not.toHaveBeenCalledWith('summary:group-1');
    expect(mockStorage['summary:group-1']).toMatchObject({ summary: 'Old summary' });
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


  it('does not adopt an unversioned Hub summary during tab-state refresh', async () => {
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
          // The SOURCE generation time must win over the hub append time —
          // hydrating with createdAtMs would make an old dossier look fresh
          // (core #136 age policy) and later re-push the wrong stamp.
          createdAtMs: 999_999,
          sourceGeneratedAtMs: 1234,
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

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(postedMessages(port)).toContainEqual(expect.objectContaining({
      type: 'tab:state',
      state: expect.objectContaining({ hasAvailableSummary: false }),
    }));
    expect(agencyHubClient.fetchFanProfileByConversation).not.toHaveBeenCalled();
    expect(mockStorage['summary:group-1']).toBeUndefined();
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
      (mockStorage['summary:group-1'] as Record<string, unknown>).personaCatalogSource =
        personaCatalogSource(mockStorage.settings as Settings);
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

    it('reports no available summary for an untrusted recap and never re-pushes it via tab-state', async () => {
      // Round-9 P1: an untrusted (pre-guard, possibly truncated) recap is a local
      // cache MISS, so hasAvailableSummary is false and the opportunistic tab-state
      // re-push never even fires. (The guard branch itself is pinned separately
      // below — this only covers the tab-state GATE.)
      hubConfiguredSettings();
      delete (mockStorage['summary:group-1'] as Record<string, unknown>).trustedTerminal;
      const agencyHubClient = retryHubClient({
        status: 'pushed',
        reason: 'pushed',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      });
      const { coordinator, port } = await createCoordinatorHarness({ agencyHubClient });

      await coordinator.handlePortMessage(1, { type: 'tab:init', groupId: 'group-1', routeNonce: 1 });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(postedMessages(port)).toContainEqual(expect.objectContaining({
        type: 'tab:state',
        state: expect.objectContaining({ hasAvailableSummary: false }),
      }));
      expect(agencyHubClient.pushFanProfile).not.toHaveBeenCalled();
    });

    it('the retrySummaryHubSync guard itself refuses an untrusted recap on a direct call (item 4)', async () => {
      // Round-11 item 4: the tab-state assertion above stays green even if
      // operations.ts's `trustedTerminal !== true` guard is deleted (retrySummaryHubSync
      // is never reached when hasAvailableSummary is false). Exercise the guard
      // DIRECTLY — the cache-swap race: the entry was trusted when tab state was
      // computed, then replaced by a legacy one before the async re-read — so
      // removing the guard makes this test go red.
      hubConfiguredSettings();
      // Untrusted + unsynced (base fixture has no agencyHubSync), otherwise fully
      // push-eligible: baseUrl set, persona matches, not-yet-saved. So the ONLY
      // thing that can stop the push is the trustedTerminal guard — deleting it
      // (grep operations.ts) makes this test go red.
      delete (mockStorage['summary:group-1'] as Record<string, unknown>).trustedTerminal;
      const agencyHubClient = retryHubClient({
        status: 'pushed',
        reason: 'pushed',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      });
      const { coordinator } = await createCoordinatorHarness({ agencyHubClient });

      // tab:init wires the tab route + session. hasAvailableSummary is false for the
      // untrusted entry, so tab:init does NOT re-push (no retry-state pollution).
      await coordinator.handlePortMessage(1, { type: 'tab:init', groupId: 'group-1', routeNonce: 1 });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(agencyHubClient.pushFanProfile).not.toHaveBeenCalled();

      // Direct call reaches the guard branch itself (the cache-swap race). Refuses.
      await (coordinator as any).retrySummaryHubSync(1);
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

    it('does not push a cached summary when a remap commits during Hub preflight', async () => {
      hubConfiguredSettings();
      let resolvePreflight: ((value: Record<string, unknown>) => void) | null = null;
      let markPreflightStarted: (() => void) | null = null;
      const preflightStarted = new Promise<void>((resolve) => {
        markPreflightStarted = resolve;
      });
      const agencyHubClient = retryHubClient({
        status: 'pushed',
        reason: 'pushed',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      });
      agencyHubClient.fetchFanProfileByConversation = vi.fn(() => {
        markPreflightStarted?.();
        return new Promise((resolve) => {
          resolvePreflight = resolve;
        });
      });
      const { coordinator } = await createCoordinatorHarness({ agencyHubClient });
      await tabInit(coordinator, 1);
      await preflightStarted;

      // Simulate storage.set having committed while storage.onChanged is still
      // queued: mutate the browser-storage backing object only, deliberately
      // leaving StorageCoordinator.state on persona-1.
      mockStorage.personaCatalog = [
        { key: 'personality-1', displayName: 'Closer', definitionId: 'v1:personality-one-definition', version: 1000, status: 'active' },
        { key: 'personality-2', displayName: 'Warm', definitionId: 'v1:personality-two-definition', version: 1, status: 'active' },
      ];
      mockStorage.accountMappings = { 'account-1': 'personality-2' };
      resolvePreflight!({
        status: 'not-found',
        reason: 'profile_missing',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      });

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(agencyHubClient.pushFanProfile).not.toHaveBeenCalled();
      expect(mockStorage['summary:group-1']).not.toMatchObject({
        agencyHubSync: expect.objectContaining({ state: 'saved' }),
      });
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

  it('does not mix Hub-A settings with a Hub-B persona snapshot after delayed identity resolution', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://hub-a.test',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    const fanslyClient = buildFanslyClientMock();
    let resolveIdentity: ((value: string) => void) | null = null;
    let markIdentityStarted: (() => void) | null = null;
    const identityStarted = new Promise<void>((resolve) => {
      markIdentityStarted = resolve;
    });
    fanslyClient.getAuthenticatedAccountId.mockImplementation(() => {
      markIdentityStarted?.();
      return new Promise((resolve) => {
        resolveIdentity = resolve;
      });
    });
    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      fetchFanProfileByConversation: vi.fn(async () => ({ status: 'not-found' })),
      pushFanProfile: vi.fn(async () => ({ status: 'pushed', reason: 'pushed' })),
    };
    const { coordinator, kernelGateway, port } = await createCoordinatorHarness({
      fanslyClient,
      agencyHubClient,
    });
    const operation = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'source-switch-op',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });
    await identityStarted;

    const settingsB = {
      ...(mockStorage.settings as Settings),
      agencyHubBaseUrl: 'http://hub-b.test',
    };
    const sourceB = personaCatalogSource(settingsB);
    await (globalThis as any).browser.storage.local.set({
      settings: settingsB,
      personaCatalogSource: sourceB,
      personaCatalog: mockStorage.personaCatalog,
    });
    resolveIdentity!('account-1');
    await operation;

    expect(agencyHubClient.resolvePageLabelForUsername).not.toHaveBeenCalled();
    expect(kernelGateway.streamFeature).not.toHaveBeenCalled();
    expect(postedMessages(port)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'operation:error',
        operationId: 'source-switch-op',
        error: expect.objectContaining({ key: 'chat_changed' }),
      }),
    ]));
  });

  it.each([
    { label: 'missing', personaCatalog: [] },
    {
      label: 'archived',
      personaCatalog: [{
        key: 'personality-1',
        displayName: 'Archived custom',
        definitionId: 'v1:personality-one-archived',
        version: 1000,
        status: 'archived',
      }],
    },
  ])('treats an existing $label personality mapping as unmapped', async ({ personaCatalog }) => {
    mockStorage.personaCatalog = personaCatalog;
    mockStorage.accountMappings = { 'account-1': 'personality-1' };
    const { coordinator, port } = await createCoordinatorHarness();

    await coordinator.handleCapture(1, 'account-1');

    expect(postedMessages(port)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tab:state',
        state: expect.objectContaining({
          mappedPersonalityId: null,
          mappedPersonalityName: null,
        }),
      }),
    ]));
  });

  it('retries a failed captured identity on ordinary traffic after a cooldown', async () => {
    mockStorage = {
      ...mockStorage,
      accountMappings: { 'resolved-1': 'personality-1' },
      knownAccounts: ['resolved-1'],
    };
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getAuthenticatedAccountId
      .mockRejectedValueOnce(new Error('temporary account lookup failure'))
      .mockImplementation(async (session: any) => {
        session.resolvedAccountId = 'resolved-1';
        return 'resolved-1';
      });
    const { coordinator, port, sessionStore } = await createCoordinatorHarness({ fanslyClient });
    sessionStore.registerCapture(1, { ...SESSION_CAPTURE, accountId: 'legacy-1' });

    await coordinator.handleCapture(1, 'legacy-1', true);
    await vi.waitFor(() => {
      expect(fanslyClient.getAuthenticatedAccountId).toHaveBeenCalledTimes(1);
    });

    // Ordinary requests inside the cooldown update headers but do no heavy UI
    // work and do not hammer /account/me.
    const messagesBeforeRetry = postedMessages(port).length;
    await coordinator.handleCapture(1, 'legacy-1', false);
    expect(fanslyClient.getAuthenticatedAccountId).toHaveBeenCalledTimes(1);
    expect(postedMessages(port)).toHaveLength(messagesBeforeRetry);

    advanceNow(30_001);
    await coordinator.handleCapture(1, 'legacy-1', false);
    await vi.waitFor(() => {
      expect(fanslyClient.getAuthenticatedAccountId).toHaveBeenCalledTimes(2);
      expect(postedMessages(port)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'mapping:changed',
          state: expect.objectContaining({
            accountId: 'resolved-1',
            mappedPersonalityId: 'personality-1',
          }),
        }),
      ]));
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
      expectedPersonaDefinitionId: 'v1:personality-one-definition',
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
      expectedPersonaDefinitionId: 'v1:current-card-definition',
      pageLabel: 'creator-fs',
    });
    expect(request.clientContext.transcript.length).toBeGreaterThan(0);
    expect(completeMessages.map((message) => message.cardId)).toEqual(['current:personality-1']);
    expect(errorMessages.map((message) => message.cardId)).toEqual(['draft-1']);
    expect(errorMessages[0]?.error.key).toBe('compare_cards_unavailable');
    expect(messages.some((message) => message.type === 'compare:complete')).toBe(true);
  });

  it('discards Compare when the captured persona source/revision changes before card completion', async () => {
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
    let resolveStream: ((value: string) => void) | null = null;
    let markStreamStarted: (() => void) | null = null;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(() => {
        markStreamStarted?.();
        return new Promise<string>((resolve) => {
          resolveStream = resolve;
        });
      }),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });
    const compare = coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'stale-compare',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });
    await streamStarted;

    // Same key, new revision; direct mutation leaves coordinator state stale.
    mockStorage.personaCatalog = [
      { key: 'personality-1', displayName: 'Closer', definitionId: 'v1:personality-one-revised', version: 1001, status: 'active' },
    ];
    resolveStream!('Old compare reply');
    await compare;

    const messages = postedMessages(port);
    expect(messages.some((message) => message.type === 'compare:cardComplete')).toBe(false);
    expect(messages.some((message) => message.type === 'compare:complete')).toBe(false);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'compare:discarded',
        operationId: 'stale-compare',
      }),
    ]));
  });

  it('does not mix Hub-A settings with Hub-B Compare cards after delayed identity resolution', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://hub-a.test',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
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
    const fanslyClient = buildFanslyClientMock();
    let resolveIdentity: ((value: string) => void) | null = null;
    let markIdentityStarted: (() => void) | null = null;
    const identityStarted = new Promise<void>((resolve) => {
      markIdentityStarted = resolve;
    });
    fanslyClient.getAuthenticatedAccountId.mockImplementation(() => {
      markIdentityStarted?.();
      return new Promise((resolve) => {
        resolveIdentity = resolve;
      });
    });
    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      fetchFanProfileByConversation: vi.fn(async () => ({ status: 'not-found' })),
      pushFanProfile: vi.fn(async () => ({ status: 'pushed', reason: 'pushed' })),
    };
    const { coordinator, kernelGateway, port } = await createCoordinatorHarness({
      fanslyClient,
      agencyHubClient,
    });
    const compare = coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'source-switch-compare',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });
    await identityStarted;

    const settingsB = {
      ...(mockStorage.settings as Settings),
      agencyHubBaseUrl: 'http://hub-b.test',
    };
    await (globalThis as any).browser.storage.local.set({
      settings: settingsB,
      personaCatalogSource: personaCatalogSource(settingsB),
      personaCatalog: mockStorage.personaCatalog,
    });
    resolveIdentity!('account-1');
    await compare;

    expect(agencyHubClient.resolvePageLabelForUsername).not.toHaveBeenCalled();
    expect(kernelGateway.streamFeature).not.toHaveBeenCalled();
    expect(postedMessages(port)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'compare:error',
        operationId: 'source-switch-compare',
        error: expect.objectContaining({ key: 'chat_changed' }),
      }),
    ]));
  });

  it('rechecks Compare source after deferred page-label resolution and before kernel stream', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://hub-a.test',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
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
    let resolvePageLabel: ((value: string) => void) | null = null;
    let markPageLabelStarted: (() => void) | null = null;
    const pageLabelStarted = new Promise<void>((resolve) => {
      markPageLabelStarted = resolve;
    });
    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      resolvePageLabelForUsername: vi.fn(() => {
        markPageLabelStarted?.();
        return new Promise<string>((resolve) => {
          resolvePageLabel = resolve;
        });
      }),
      fetchFanProfileByConversation: vi.fn(async () => ({ status: 'not-found' })),
      pushFanProfile: vi.fn(async () => ({ status: 'pushed', reason: 'pushed' })),
    };
    const { coordinator, kernelGateway, port } = await createCoordinatorHarness({
      agencyHubClient,
    });
    const compare = coordinator.startCompare(1, {
      type: 'compare:start',
      operationId: 'deferred-page-label-compare',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });
    await pageLabelStarted;

    const settingsB = {
      ...(mockStorage.settings as Settings),
      agencyHubBaseUrl: 'http://hub-b.test',
    };
    mockStorage.settings = settingsB;
    mockStorage.personaCatalogSource = personaCatalogSource(settingsB);
    resolvePageLabel!('creator-fs');
    await compare;

    expect(kernelGateway.streamFeature).not.toHaveBeenCalled();
    expect(postedMessages(port).some((message) => message.type === 'compare:complete')).toBe(false);
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

  it('fails a compare card closed on a truncated stream (provider length)', async () => {
    // Round-4 P2: compare cards are replies; the literal 'max_tokens' check
    // missed OpenRouter's provider 'length'. isOutputExhausted normalizes both,
    // so a truncated card is non-insertable instead of presented.
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
        _request: unknown,
        callbacks: { onStopReason?: (reason: string | null) => void },
      ) => {
        callbacks.onStopReason?.('length');
        return 'Hey babe, I was just thinking about the custom you asked for and';
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
    const currentError = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'compare:cardError' }> =>
        message.type === 'compare:cardError' && message.cardId === 'current:personality-1',
    );
    expectUserErrorIdentity(currentError?.error, {
      key: 'ai_output_unusable',
      code: 'CG-API-06',
    });
    // Fail closed: the truncated card is never presented as a completed card.
    expect(
      messages.some(
        (message) =>
          message.type === 'compare:cardComplete' &&
          message.cardId === 'current:personality-1',
      ),
    ).toBe(false);
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

  it('preserves Scan click order when the older tab validates after the newer tab completes', async () => {
    delete mockStorage['summary:group-1'];
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async (
        _settings: unknown,
        request: { clientRequestId: string },
      ) => request.clientRequestId === 'new-validation-scan'
        ? 'New validation-order summary'
        : 'Old validation-order summary'),
    };
    const { coordinator, port, sessionStore } = await createCoordinatorHarness({
      fanslyClient,
      kernelGateway,
    });
    sessionStore.registerCapture(2, SESSION_CAPTURE);
    const secondPort = createMockRuntimePort(2);
    coordinator.registerPort(secondPort as never);
    let resolveOldTab: ((value: { url: string }) => void) | null = null;
    let markOldValidationStarted: (() => void) | null = null;
    const oldValidationStarted = new Promise<void>((resolve) => {
      markOldValidationStarted = resolve;
    });
    (globalThis as any).browser.tabs.get = vi.fn((tabId: number) => {
      if (tabId === 1) {
        markOldValidationStarted?.();
        return new Promise((resolve) => {
          resolveOldTab = resolve;
        });
      }
      return Promise.resolve({ url: 'https://fansly.com/messages/group-1' });
    });
    const payload = {
      type: 'operation:start' as const,
      feature: 'fan-summary' as const,
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    };

    const oldOperation = coordinator.startOperation(1, {
      ...payload,
      operationId: 'old-validation-scan',
      forceRegenerate: true,
    });
    await oldValidationStarted;
    await coordinator.startOperation(2, {
      ...payload,
      operationId: 'new-validation-scan',
    });
    resolveOldTab!({ url: 'https://fansly.com/messages/group-1' });
    await oldOperation;

    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    expect(mockStorage['summary:group-1']).toMatchObject({
      summary: 'New validation-order summary',
    });
    expect(postedMessages(secondPort).some((message) =>
      message.type === 'operation:complete' &&
      message.operationId === 'new-validation-scan'
    )).toBe(true);
    expect(postedMessages(port).some((message) =>
      message.type === 'operation:complete' &&
      message.operationId === 'old-validation-scan'
    )).toBe(false);
  });

  it('revalidates an uncached Scan task after fan-id resolution and before Hub push', async () => {
    delete mockStorage['summary:group-1'];
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    const fanslyClient = buildFanslyClientMock();
    let groupCalls = 0;
    let resolveSyncGroup: ((value: { users: Array<{ userId: string }> }) => void) | null = null;
    let markSyncGroupStarted: (() => void) | null = null;
    const syncGroupStarted = new Promise<void>((resolve) => {
      markSyncGroupStarted = resolve;
    });
    fanslyClient.getGroup.mockImplementation(() => {
      groupCalls += 1;
      if (groupCalls === 1) {
        // No fan id during generation => enrichment incomplete and no local
        // cache, while the existing fire-and-forget Hub path still runs.
        return Promise.resolve({ users: [{ userId: 'account-1' }] });
      }
      markSyncGroupStarted?.();
      return new Promise((resolve) => {
        resolveSyncGroup = resolve;
      });
    });
    const agencyHubClient = {
      isConfigured: vi.fn(() => true),
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      fetchFanProfileByConversation: vi.fn(async () => ({ status: 'not-found' })),
      pushFanProfile: vi.fn(async () => ({
        status: 'pushed',
        reason: 'pushed',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      })),
    };
    const { coordinator } = await createCoordinatorHarness({
      anthropicRawText: 'Uncached summary',
      fanslyClient,
      agencyHubClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'uncached-summary-op',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });
    await syncGroupStarted;

    // Again reproduce committed storage bytes before onChanged dispatch.
    mockStorage.personaCatalog = [
      { key: 'personality-1', displayName: 'Closer', definitionId: 'v1:personality-one-revised', version: 1001, status: 'active' },
    ];
    resolveSyncGroup!({ users: [{ userId: 'account-1' }, { userId: 'fan-1' }] });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(agencyHubClient.pushFanProfile).not.toHaveBeenCalled();
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

  it('routes coach-chat through the DEEP timeout path, not the 60s quick-total (round-3 P1)', async () => {
    // coach-chat has messageCountBucket 'quick' but timeoutBucket 'deep': a coach
    // answer is capped at 64 000 chars, so it must NOT run under the 60s
    // quick-total total budget. Observed at the prep stage — a hanging message
    // load survives past QUICK_OPERATION_TIMEOUT_MS (which would already have
    // aborted a quick-bucketed feature) and only aborts at the deep-prep budget.
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
      operationId: 'coach-op',
      feature: 'coach-chat',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    await loadStarted;

    // Past the quick-total ceiling: a quick-bucketed feature would already have
    // aborted with timed_out — coach must still be running.
    await vi.advanceTimersByTimeAsync(QUICK_OPERATION_TIMEOUT_MS);
    expect(
      postedMessages(port).some((message) => message.type === 'operation:error'),
    ).toBe(false);

    // Only the deep-prep budget aborts it.
    await vi.advanceTimersByTimeAsync(
      DEEP_OPERATION_PREP_TIMEOUT_MS - QUICK_OPERATION_TIMEOUT_MS,
    );
    await startPromise;

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );
    expectUserErrorIdentity(errorMessage?.error, {
      key: 'timed_out',
      code: 'CG-NET-02',
    });
    expect(
      errorMessage?.profiling?.stages.find((stage) => stage.key === 'llm-ttfb'),
    ).toBeUndefined();
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
    (mockStorage['summary:group-1'] as Record<string, unknown>).personaCatalogSource =
      personaCatalogSource(mockStorage.settings as Settings);

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

  it('never stamps an unversioned Hub body as current and runs the gateway on cache miss', async () => {
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
        status: 'fetched',
        reason: 'fetched',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
        body: 'Stale Hub summary from persona v1',
        createdAtMs: Date.parse('2026-03-20T12:00:00.000Z'),
        fanAccountId: 'fan-9',
      })),
      pushFanProfile: vi.fn(async () => ({
        status: 'skipped',
        reason: 'disabled',
        baseUrl: null,
      })),
    };

    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    const { coordinator, kernelGateway, port } = await createCoordinatorHarness({
      anthropicRawText: 'Generated summary',
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
      forceRegenerate: false,
    });

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(agencyHubClient.fetchFanProfileByConversation).not.toHaveBeenCalled();
    expect(completeMessage?.result).toMatchObject({
      rawText: 'Generated summary',
      summaryMeta: {
        cached: false,
        stale: false,
      },
    });
    expect((mockStorage['summary:group-1'] as SummaryCacheEntry | undefined)).toMatchObject({
      summary: 'Generated summary',
      personalityId: 'personality-1',
      personalityUpdatedAt: 1000,
      personaCatalogSource: personaCatalogSource(mockStorage.settings as Settings),
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: 'kernel',
      // A fresh generation sits behind the fail-closed guards, so it is marked
      // trusted-terminal — that marker is what makes it a valid future cache hit.
      trustedTerminal: true,
    });
    expect(JSON.stringify(mockStorage['summary:group-1'])).not.toContain('Stale Hub summary');
    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a newer remapped summary when the old persona stream finishes first', async () => {
    delete mockStorage['summary:group-1'];
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    let resolveStream: ((value: string) => void) | null = null;
    let markStreamStarted: (() => void) | null = null;
    const streamStarted = new Promise<void>((resolve) => {
      markStreamStarted = resolve;
    });
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(() => {
        markStreamStarted?.();
        return new Promise<string>((resolve) => {
          resolveStream = resolve;
        });
      }),
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
        status: 'pushed',
        reason: 'pushed',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      })),
    };
    const { coordinator, port } = await createCoordinatorHarness({
      fanslyClient,
      kernelGateway,
      agencyHubClient,
    });

    const operation = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'old-summary-op',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });
    await streamStarted;

    const newerSummary: SummaryCacheEntry = {
      summary: 'New persona summary',
      personalityId: 'personality-2',
      personaDefinitionId: 'v1:personality-two-definition',
      personalityUpdatedAt: 1,
      personaCatalogSource: mockStorage.personaCatalogSource as string | null,
      generatedAt: currentNow + 1,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: 'kernel',
    };
    // Browser storage has committed P2, but deliberately do not dispatch the
    // change into StorageCoordinator: this reproduces the real event lag.
    mockStorage.personaCatalog = [
      { key: 'personality-1', displayName: 'Closer', definitionId: 'v1:personality-one-definition', version: 1000, status: 'active' },
      { key: 'personality-2', displayName: 'Warm', definitionId: 'v1:personality-two-definition', version: 1, status: 'active' },
    ];
    mockStorage.accountMappings = { 'account-1': 'personality-2' };
    mockStorage['summary:group-1'] = newerSummary;
    resolveStream!('Old persona summary');
    await operation;

    expect(mockStorage['summary:group-1']).toEqual(newerSummary);
    expect(agencyHubClient.pushFanProfile).not.toHaveBeenCalled();
    expect(postedMessages(port).some((message) =>
      message.type === 'operation:complete' && message.operationId === 'old-summary-op'
    )).toBe(false);
    expect(postedMessages(port)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'operation:error',
        operationId: 'old-summary-op',
        error: expect.objectContaining({ key: 'chat_changed' }),
      }),
    ]));
  });

  it('replaces a same-millisecond stale P1 cache with a current P2 summary', async () => {
    mockStorage.personaCatalog = [
      { key: 'personality-1', displayName: 'Closer', definitionId: 'v1:personality-one-definition', version: 1000, status: 'active' },
      { key: 'personality-2', displayName: 'Warm', definitionId: 'v1:personality-two-definition', version: 1, status: 'active' },
    ];
    mockStorage.accountMappings = { 'account-1': 'personality-2' };
    mockStorage['summary:group-1'] = {
      summary: 'Stale P1 summary',
      personalityId: 'personality-1',
      personaDefinitionId: 'v1:personality-one-definition',
      personalityUpdatedAt: 1000,
      personaCatalogSource: null,
      generatedAt: currentNow,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: 'kernel',
    } satisfies SummaryCacheEntry;
    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    const { coordinator } = await createCoordinatorHarness({
      anthropicRawText: 'Current P2 summary',
      fanslyClient,
    });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'p2-summary-op',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    expect(mockStorage['summary:group-1']).toMatchObject({
      summary: 'Current P2 summary',
      personalityId: 'personality-2',
      personalityUpdatedAt: 1,
      generatedAt: currentNow,
    });
  });

  it.each([
    { label: 'cached', verified: true },
    { label: 'uncached incomplete-enrichment', verified: false },
  ])('lets only the latest cross-tab Scan commit and push ($label)', async ({ verified }) => {
    delete mockStorage['summary:group-1'];
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    const fanslyClient = buildFanslyClientMock();
    if (verified) {
      fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
      fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    }
    let resolveOldStream: ((value: string) => void) | null = null;
    let markOldStreamStarted: (() => void) | null = null;
    const oldStreamStarted = new Promise<void>((resolve) => {
      markOldStreamStarted = resolve;
    });
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        (_settings: unknown, request: { clientRequestId: string }) => {
          if (request.clientRequestId === 'old-scan') {
            markOldStreamStarted?.();
            return new Promise<string>((resolve) => {
              resolveOldStream = resolve;
            });
          }
          return Promise.resolve('Newer Scan body');
        },
      ),
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
        status: 'pushed',
        reason: 'pushed',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      })),
    };
    const { coordinator, port, sessionStore } = await createCoordinatorHarness({
      fanslyClient,
      kernelGateway,
      agencyHubClient,
    });
    sessionStore.registerCapture(2, SESSION_CAPTURE);
    const secondPort = createMockRuntimePort(2);
    coordinator.registerPort(secondPort as never);
    const payload = {
      type: 'operation:start' as const,
      feature: 'fan-summary' as const,
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    };

    const oldOperation = coordinator.startOperation(1, {
      ...payload,
      operationId: 'old-scan',
    });
    await oldStreamStarted;
    await coordinator.startOperation(2, {
      ...payload,
      operationId: 'new-scan',
    });
    advanceNow(1_000);
    resolveOldStream!('Older transcript, later completion');
    await oldOperation;
    await vi.waitFor(() => {
      expect(agencyHubClient.pushFanProfile).toHaveBeenCalledTimes(1);
    });

    expect(agencyHubClient.pushFanProfile).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Newer Scan body' }),
    );
    expect(postedMessages(secondPort).some((message) =>
      message.type === 'operation:complete' && message.operationId === 'new-scan'
    )).toBe(true);
    expect(postedMessages(port).some((message) =>
      message.type === 'operation:complete' && message.operationId === 'old-scan'
    )).toBe(false);
    if (verified) {
      expect(mockStorage['summary:group-1']).toMatchObject({
        summary: 'Newer Scan body',
        personalityId: 'personality-1',
      });
    } else {
      expect(mockStorage['summary:group-1']).toBeUndefined();
    }
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

    expect(agencyHubClient.fetchFanProfileByConversation).not.toHaveBeenCalled();
    expect(completeMessage?.result.rawText).toBe('Generated summary');
    expect(completeMessage?.result.summaryMeta?.cached).toBe(false);
    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    expect(postedMessages(port).find((message) => message.type === 'operation:error')).toBeUndefined();
  });

  it('regenerates a stale local entry instead of adopting an unversioned Hub body', async () => {
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

    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    const { coordinator, kernelGateway, port } = await createCoordinatorHarness({
      anthropicRawText: 'Regenerated summary',
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
      forceRegenerate: false,
    });

    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );

    expect(agencyHubClient.fetchFanProfileByConversation).not.toHaveBeenCalled();
    expect(completeMessage?.result.rawText).toBe('Regenerated summary');
    expect(completeMessage?.result.summaryMeta?.cached).toBe(false);
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    expect(mockStorage['summary:group-1']).toMatchObject({
      summary: 'Regenerated summary',
      personalityId: 'personality-1',
      personalityUpdatedAt: 1000,
      modelId: 'kernel',
    });
  });

  it('regenerates immediately on forced refresh', async () => {
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

  it('uses the versioned local cache on the second open after gateway generation', async () => {
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
        status: 'fetched',
        reason: 'fetched',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
        body: 'Hub summary',
        createdAtMs: 123,
        fanAccountId: 'fan-1',
      })),
      pushFanProfile: vi.fn(async () => ({
        status: 'skipped',
        reason: 'disabled',
        baseUrl: null,
      })),
    };

    const fanslyClient = buildFanslyClientMock();
    fanslyClient.getEarnings.mockResolvedValue(buildAggregatedEarnings());
    fanslyClient.getFanSubscriptionContext.mockResolvedValue(buildSubscriptionContext());
    const { coordinator, kernelGateway, port } = await createCoordinatorHarness({
      anthropicRawText: 'Generated summary',
      agencyHubClient,
      fanslyClient,
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

    expect(agencyHubClient.fetchFanProfileByConversation).not.toHaveBeenCalled();
    expect(secondCompleteMessage?.result).toMatchObject({
      rawText: 'Generated summary',
      summaryMeta: {
        cached: true,
      },
    });
    expect(fanslyClient.loadMessages).toHaveBeenCalledTimes(1);
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
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
      personaDefinitionId: 'v1:personality-one-definition',
      personalityUpdatedAt: 1000,
      personaCatalogSource: personaCatalogSource(mockStorage.settings as Settings),
      generatedAt: 2000,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: 'kernel',
      trustedTerminal: true,
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

  it('regenerates instead of reusing a same-key/version summary after the Hub source changes', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://hub-a.test',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    (mockStorage as Record<string, unknown>)['summary:group-1'] = {
      summary: 'Cached summary',
      personalityId: 'personality-1',
      personaDefinitionId: 'v1:personality-one-definition',
      personalityUpdatedAt: 1000,
      personaCatalogSource: personaCatalogSource(mockStorage.settings as Settings),
      generatedAt: 2000,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: 'kernel',
      fanAccountId: 'fan-1',
      trustedTerminal: true,
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
      cached: false,
      syncStatus: { state: 'saving' },
    });

    await vi.waitFor(() => {
      const putCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('http://hub-b.test/api/v1/pages/creator-fs/fans/fan-1/profile'),
      );
      expect(putCalls).toHaveLength(1);
      expect((mockStorage['summary:group-1'] as SummaryCacheEntry).agencyHubSync).toMatchObject({
        state: 'saved',
        // The old A-scoped cache remains inert; the uncached B generation is
        // pushed without relabelling A's body as B-owned.
        baseUrl: 'http://hub-a.test',
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

  it('fails closed on a truncated coach stream (max_tokens AND provider length)', async () => {
    // Round-4 P1: coach-chat is promptMode 'analysis', so the reply-only guard
    // let a truncated coach answer through and present as a result — a hard-rule
    // violation. isOutputExhausted normalizes BOTH the kernel 'max_tokens' and
    // OpenRouter's provider 'length'; the guard now covers coach-chat.
    for (const stopReason of ['max_tokens', 'length'] as const) {
      const kernelGateway = {
        isConfigured: vi.fn(() => true),
        streamFeature: vi.fn(
          async (
            _settings: unknown,
            _request: unknown,
            callbacks: { onStopReason?: (reason: string | null) => void },
            _signal: unknown,
          ) => {
            callbacks.onStopReason?.(stopReason);
            return 'Try leading with a question about her weekend, then bridge to the';
          },
        ),
      };
      const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

      await coordinator.startOperation(1, {
        type: 'operation:start',
        operationId: `coach-op-${stopReason}`,
        feature: 'coach-chat',
        groupId: 'group-1',
        routeNonce: 1,
        domFanDisplayName: 'alice',
        forceRegenerate: false,
      });

      const messages = postedMessages(port);
      const errorMessage = messages.find(
        (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
          message.type === 'operation:error',
      );
      expect(errorMessage?.error).toMatchObject({ key: 'ai_output_unusable' });
      // Fail closed: the truncated coach answer is NEVER presented as a result.
      expect(messages.some((message) => message.type === 'operation:complete')).toBe(false);
    }
  });

  it('fails closed on a truncated shipped reply feature (fast-reply, provider length)', async () => {
    // Round-11 P2: widening the exhaustion guard to isOutputExhausted ('length'
    // too) changed live behaviour for the FOUR shipped reply features — a provider
    // 'length' stop now hard-fails where a truncated-but-insertable reply used to
    // reach the fan. Pin fast-reply, the highest-frequency path; a revert to the
    // literal `max_tokens` check would go red here.
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(
        async (
          _settings: unknown,
          _request: unknown,
          callbacks: { onStopReason?: (reason: string | null) => void },
          _signal: unknown,
        ) => {
          callbacks.onStopReason?.('length');
          // Non-empty, normally-insertable text — the point is that 'length' fails
          // it closed anyway (normalizeReplyParts would otherwise yield a part).
          return 'Hey babe, I was just thinking about you and';
        },
      ),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'reply-length',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });

    const messages = postedMessages(port);
    const errorMessage = messages.find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );
    expect(errorMessage?.error).toMatchObject({ key: 'ai_output_unusable' });
    expect(messages.some((message) => message.type === 'operation:complete')).toBe(false);
  });

  it('fails closed on a truncated fan-summary stream and caches nothing', async () => {
    // Round-4 extended the exhaustion guard to fan-summary; this pins it. A
    // truncated recap must fail closed — never presented AND, the whole point for
    // recaps, never written to the summary cache (a truncated recap there would
    // poison later reads and any Hub dossier push). Cover the kernel 'max_tokens'
    // and OpenRouter's provider 'length'.
    for (const stopReason of ['max_tokens', 'length'] as const) {
      delete mockStorage['summary:group-1'];
      const kernelGateway = {
        isConfigured: vi.fn(() => true),
        streamFeature: vi.fn(
          async (
            _settings: unknown,
            _request: unknown,
            callbacks: { onStopReason?: (reason: string | null) => void },
            _signal: unknown,
          ) => {
            callbacks.onStopReason?.(stopReason);
            return 'Alice is a long-term whale who mostly buys customs and responds best to';
          },
        ),
      };
      const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

      await coordinator.startOperation(1, {
        type: 'operation:start',
        operationId: `summary-op-${stopReason}`,
        feature: 'fan-summary',
        groupId: 'group-1',
        routeNonce: 1,
        domFanDisplayName: 'alice',
        forceRegenerate: false,
      });

      const messages = postedMessages(port);
      const errorMessage = messages.find(
        (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
          message.type === 'operation:error',
      );
      expect(errorMessage?.error).toMatchObject({ key: 'ai_output_unusable' });
      // Nothing presented, and the truncated summary is NEVER cached.
      expect(messages.some((message) => message.type === 'operation:complete')).toBe(false);
      expect(mockStorage['summary:group-1']).toBeUndefined();
    }
  });

  it('fails closed on an empty or whitespace-only coach/recap stream (nothing cached)', async () => {
    // Round-6 P1-1: buildFeatureResult returns any rawText for coach + recap
    // (incl. '' or whitespace), and the exhaustion guard only fires on a stop
    // reason. A meta→done stream with no content — or a whitespace end_turn
    // answer — must fail closed, never present, and never enter the summary cache.
    for (const feature of ['coach-chat', 'fan-summary'] as const) {
      for (const emptyish of ['', '   \n\t  ']) {
        delete mockStorage['summary:group-1'];
        const kernelGateway = {
          isConfigured: vi.fn(() => true),
          streamFeature: vi.fn(async () => emptyish),
        };
        const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

        await coordinator.startOperation(1, {
          type: 'operation:start',
          operationId: `empty-${feature}-${emptyish.length}`,
          feature,
          groupId: 'group-1',
          routeNonce: 1,
          domFanDisplayName: 'alice',
          forceRegenerate: false,
        });

        const messages = postedMessages(port);
        const errorMessage = messages.find(
          (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
            message.type === 'operation:error',
        );
        expect(errorMessage?.error).toMatchObject({ key: 'ai_output_unusable' });
        expect(messages.some((message) => message.type === 'operation:complete')).toBe(false);
        expect(mockStorage['summary:group-1']).toBeUndefined();
      }
    }
  });

  it('does not serve a pre-guard (legacy, unmarked) cached recap — regenerates instead', async () => {
    // Round-6 P1-2: a recap cached before fan-summary was exhaustion-guarded (a
    // possibly-truncated recap) carries no trustedTerminal marker. isValidSummaryCacheEntry
    // now requires the marker, so such an entry is a cache MISS: the truncated
    // recap is never served or Hub-pushed again — it regenerates and self-heals.
    mockStorage['summary:group-1'] = {
      summary: 'Legacy possibly-truncated recap',
      personalityId: 'personality-1',
      personaDefinitionId: 'v1:personality-one-definition',
      personalityUpdatedAt: 1000,
      personaCatalogSource: null,
      generatedAt: 2000,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: 'kernel',
      // NOTE: no trustedTerminal — this is a pre-guard/legacy entry.
    };
    const kernelGateway = {
      isConfigured: vi.fn(() => true),
      streamFeature: vi.fn(async () => 'Fresh complete recap'),
    };
    const { coordinator, port } = await createCoordinatorHarness({ kernelGateway });

    await coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'summary-legacy',
      feature: 'fan-summary',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
    });

    // The legacy entry did NOT serve as a cache hit: the stream ran
    // (regeneration) and the completed recap is the fresh one, marked cached:false.
    expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1);
    const completeMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:complete' }> =>
        message.type === 'operation:complete',
    );
    expect(completeMessage?.result.rawText).toBe('Fresh complete recap');
    expect(completeMessage?.result.summaryMeta).toMatchObject({ cached: false });
    // The legacy (possibly-truncated) recap was never presented to the chatter.
    expect(
      postedMessages(port).every(
        (message) =>
          message.type !== 'operation:complete' ||
          message.result.rawText !== 'Legacy possibly-truncated recap',
      ),
    ).toBe(true);
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
      personaDefinitionId: 'v1:personality-one-definition',
      personalityUpdatedAt: 1000,
      personaCatalogSource: null,
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
