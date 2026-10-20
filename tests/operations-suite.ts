/* eslint-disable @typescript-eslint/no-explicit-any --
   legacy suite drives background operations through `as any` seams; the
   operations surface is rewritten onto kernel feature services in Stage 32
   Task 3. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT,
  STORAGE_SCHEMA_VERSION,
  SUMMARY_SYNC_RETRY_COOLDOWN_MS,
} from '../src/shared/constants.js';
import { migrateState, stripSecretSettings } from '../src/shared/migrations.js';
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
} from '../src/shared/types.js';

// Keep the real, stateless SDK graph across resetModules below. Recreating
// all generated Zod contracts per operation test exhausts CI's 2 GiB heap;
// application modules still reset, and no SDK exports or schemas are replaced.
vi.mock(import('@kernel/sdk'), async (importOriginal) => importOriginal());

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
    ): Promise<{
      pages: FanslyMessagePageResponse[];
      pagesLoaded: number;
      targetPages: number;
      // Optional in the mock so pre-Task-7 overrides that omit it still type;
      // an absent value degrades transcriptCoverage to 'window' (safe default).
      reachedEnd?: boolean;
    }> => ({
      pages: buildMessagePages(30),
      pagesLoaded: 2,
      targetPages: 2,
      reachedEnd: false,
    })),
    getMessagePage: vi.fn(async (
      _groupId: string,
      _before: string | null,
      _session: unknown,
      _signal?: AbortSignal,
    ) => buildMessagePages(1)[0]!),
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
  /** Hi only. Default: a warm, empty welcome cache (no Fansly read). */
  welcomeDefinitions?: { loadWithin: (...args: any[]) => Promise<any> };
}) {
  mockStorage.personaCatalogSource = personaCatalogSource(
    migrateState(mockStorage).settings,
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
  const welcomeDefinitions = options?.welcomeDefinitions ?? {
    loadWithin: vi.fn(async () => ({ texts: new Set<string>(), source: 'cache' })),
  };

  const coordinator = new OperationCoordinator(
    sessionStore,
    new TabContextStore(),
    fanslyClient as never,
    kernelGateway as never,
    storageCoordinator,
    agencyHubClient as never,
    options?.unusedReporter as never,
    undefined,
    welcomeDefinitions as never,
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
    welcomeDefinitions,
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

export type OperationCoordinatorSuitePart = 'lifecycle-and-compare';

export function registerOperationCoordinatorTests(
  part: OperationCoordinatorSuitePart,
): void {
describe(`OperationCoordinator (${part})`, () => {
  beforeEach(() => {
    vi.resetModules();
    activeStorageCoordinator = null;
    currentNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => currentNow);
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: {
        agencyHubBaseUrl: '',
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

  if (part === 'lifecycle-and-compare') {

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
      const settings = {
        ...migrateState(mockStorage).settings,
        agencyHubBaseUrl: 'http://localhost:3000',
      };
      mockStorage.settings = stripSecretSettings(settings);
      mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = settings.agencyHubDeviceToken;
      (mockStorage['summary:group-1'] as Record<string, unknown>).personaCatalogSource =
        personaCatalogSource(settings);
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

    it('never treats a short-only recap as a full Hub dossier to re-push', async () => {
      hubConfiguredSettings();
      mockStorage['summary-short:group-1'] = mockStorage['summary:group-1'];
      delete mockStorage['summary:group-1'];
      const agencyHubClient = retryHubClient({
        status: 'pushed',
        reason: 'pushed',
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      });
      const { coordinator, port } = await createCoordinatorHarness({ agencyHubClient });

      await tabInit(coordinator, 1);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(postedMessages(port)).toContainEqual(expect.objectContaining({
        type: 'tab:state',
        state: expect.objectContaining({
          availableRecaps: { full: false, short: true },
          hasAvailableSummary: true,
        }),
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

  it('drops a stale tab-state refresh that finishes after a newer one', async () => {
    const { coordinator, port } = await createCoordinatorHarness();
    coordinator.tabContexts.setRoute(1, 'group-1', 1);
    const resolvers: Array<(capable: boolean) => void> = [];
    coordinator.setVoiceCapabilityResolver(
      () => new Promise<boolean>((resolve) => {
        resolvers.push(resolve);
      }),
    );

    const before = postedMessages(port).length;
    const first = coordinator.refreshTabState(1);
    const second = coordinator.refreshTabState(1);
    await vi.waitFor(() => {
      expect(resolvers).toHaveLength(2);
    });

    // The NEWER build completes first; the older one must then be dropped.
    resolvers[1]!(true);
    await second;
    resolvers[0]!(false);
    await first;

    const states = postedMessages(port)
      .slice(before)
      .filter((message) => message.type === 'tab:state');
    expect(states).toHaveLength(1);
    expect(states[0]).toEqual(
      expect.objectContaining({
        state: expect.objectContaining({ voiceNotesCapable: true }),
      }),
    );
  });

  it('does not mix Hub-A settings with a Hub-B persona snapshot after delayed identity resolution', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://hub-a.test',
      agencyHubDeviceToken: 'hub-key',
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
      ...migrateState(mockStorage).settings,
      agencyHubBaseUrl: 'http://hub-b.test',
    };
    const sourceB = personaCatalogSource(settingsB);
    await (globalThis as any).browser.storage.local.set({
      settings: stripSecretSettings(settingsB),
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
      '[Video - PPV $33.00, not purchased]',
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
      '[Video - PPV $33.00, purchased]',
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
      '[Video - PPV $33.00, unknown]',
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
      '[Video - PPV $33.00, unknown]',
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
    expect((verifiedRequests as Array<{ contentId: string }>).map(({ contentId }) => contentId))
      .toEqual(ids.slice(1).reverse());
    expect(prompt).toContain('[Video - PPV $33.00, unknown] ppv 1');
    expect(prompt).toContain('[Video - PPV $33.00, not purchased] ppv 11');
  });

  it('does not mix Hub-A settings with Hub-B Compare cards after delayed identity resolution', async () => {
    mockStorage.settings = {
      ...(mockStorage.settings as Record<string, unknown>),
      agencyHubBaseUrl: 'http://hub-a.test',
      agencyHubDeviceToken: 'hub-key',
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
      ...migrateState(mockStorage).settings,
      agencyHubBaseUrl: 'http://hub-b.test',
    };
    await (globalThis as any).browser.storage.local.set({
      settings: stripSecretSettings(settingsB),
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

  it('P1-1: a route-change during validateStart kills the stale start and leaves the new chat intact', async () => {
    // A reserved-but-not-yet-active op on group-1 must NOT re-poison the tab
    // context when the chatter switches to group-2 mid-validation: it dies with
    // chat_changed and never re-touches the context (no setRoute rollback that
    // would let its setFan write a cross-group fan).
    const fanslyClient = buildFanslyClientMock();
    const { coordinator, port } = await createCoordinatorHarness({ fanslyClient });
    await coordinator.handlePortMessage(1, { type: 'tab:init', groupId: 'group-1', routeNonce: 1 });

    // Hang validateStart's browser.tabs.get until we've switched routes.
    let resolveTab: ((value: { url: string }) => void) | null = null;
    let markValidationStarted: (() => void) | null = null;
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve;
    });
    (globalThis as any).browser.tabs.get = vi.fn(() => {
      markValidationStarted?.();
      return new Promise((resolve) => {
        resolveTab = resolve;
      });
    });

    const startPromise = coordinator.startOperation(1, {
      type: 'operation:start',
      operationId: 'stale-op',
      feature: 'fast-reply',
      groupId: 'group-1',
      routeNonce: 1,
      domFanDisplayName: 'alice',
      forceRegenerate: false,
      replyMode: 'default',
    });
    await validationStarted;

    // The chatter switches to group-2 while the op validates.
    await coordinator.handlePortMessage(1, { type: 'tab:routeChanged', groupId: 'group-2', routeNonce: 2 });

    // validateStart's tab.url still shows the OLD chat (URLs lag routeChanged) — so
    // its own URL check passes; only the routeNonce re-check catches the stale start.
    resolveTab!({ url: 'https://fansly.com/messages/group-1' });
    await startPromise;

    const errorMessage = postedMessages(port).find(
      (message): message is Extract<BackgroundPortMessage, { type: 'operation:error' }> =>
        message.type === 'operation:error',
    );
    expect(errorMessage?.error).toMatchObject({ key: 'chat_changed' });
    // The context stays on the NEW chat — never rolled back to group-1.
    expect((coordinator as any).tabContexts.get(1)).toMatchObject({
      groupId: 'group-2',
      fanAccountId: null,
    });
  });

  }

});
}
