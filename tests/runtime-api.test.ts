import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { createUserError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import type {
  SessionTemplate,
  SpendersBuildPayload,
} from '../src/shared/types.js';
import type {
  StoredVoiceAttemptRoute,
  VoiceAttemptStoreSnapshot,
} from '../src/shared/voice-attempt.js';
import type { TabContextStore as TabContextStoreClass } from '../src/background/tab-context.js';

type MessageSenderLike = { tab?: { id?: number }; url?: string };
let mockStorage: Record<string, unknown> = {};
let onMessageListener:
  | ((message: unknown, sender?: MessageSenderLike) => Promise<unknown>)
  | undefined;

function makeCapture(accountId: string) {
  return {
    accountId,
    authorization: `Bearer ${accountId}`,
    fanslyClientId: `${accountId}-client`,
    fanslySessionId: `${accountId}-session`,
    fanslyClientTs: '123',
    fanslyClientCheck: 'route-check',
    routeKey: 'group' as const,
  };
}

function createStorage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: createDefaultSettings(),
    personalities: [],
    personaCatalog: [],
    personaCatalogSource: null,
    personaCatalogFetchedAt: null,
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
    ...overrides,
  };
}

function voiceSnapshot(
  route: StoredVoiceAttemptRoute,
): VoiceAttemptStoreSnapshot {
  return {
    attempt: {
      attemptId: '11111111-1111-4111-8111-111111111111',
      phase: 'script',
      draftText: 'Hello',
      script: 'Hello',
      canonicalScript: null,
      generationRef: null,
      sourceFingerprint: null,
      pageLabel: null,
      tone: 'none',
      takes: [],
      selectedTakeId: null,
      stale: false,
      boundRoute: { ...route },
    },
    conversationRef: '',
    pendingCreate: null,
    burnedClientRequestIds: [],
  };
}

async function installRuntimeApiHarness(fanslyClient: {
  getAuthenticatedAccount: (session: SessionTemplate, signal: AbortSignal) => Promise<unknown>;
}, options?: {
  agencyHubClient?: {
    testConnection?: ReturnType<typeof vi.fn>;
    resolvePageLabelForUsername?: ReturnType<typeof vi.fn>;
    getRecapStatus?: ReturnType<typeof vi.fn>;
  };
  spendersService?: {
    getList: ReturnType<typeof vi.fn>;
  };
  debugPrompts?: {
    put: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    has: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
  emitToTab?: (tabId: number, message: SpendersBuildPayload) => void;
  onAgencyHubReady?: () => void;
  voiceService?: {
    resolveCapability: (tabId: number) => Promise<boolean>;
  };
  voiceAttempts?: {
    load: (route: StoredVoiceAttemptRoute) => Promise<unknown[]>;
    save: (snapshot: VoiceAttemptStoreSnapshot) => Promise<void>;
    remove: (attemptId: string, route?: StoredVoiceAttemptRoute) => Promise<void>;
  };
  tabContexts?: TabContextStoreClass;
  storageCoordinator?: {
    ensurePersistedState: () => Promise<unknown>;
  };
}) {
  vi.resetModules();
  onMessageListener = undefined;

  const tabsQuery = vi.fn<() => Promise<Array<{ id: number; url?: string }>>>(
    async () => [],
  );
  const tabsGet = vi.fn<(tabId: number) => Promise<{ id: number; url?: string }>>(
    async (tabId: number) => ({ id: tabId, url: undefined }),
  );
  const tabsCreate = vi.fn<(info: { url: string }) => Promise<{ id: number }>>(
    async () => ({ id: 7 }),
  );

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
            keys.forEach((key) => {
              result[key] = mockStorage[key];
            });
            return result;
          }
          return {};
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(mockStorage, items);
        }),
        remove: vi.fn(async () => undefined),
      },
    },
    runtime: {
      onMessage: {
        addListener: vi.fn((listener: (message: unknown, sender?: MessageSenderLike) => Promise<unknown>) => {
          onMessageListener = listener;
        }),
      },
      getURL: (path: string) => `moz-extension://cg-test-uuid/${path}`,
    },
    tabs: {
      query: tabsQuery,
      get: tabsGet,
      create: tabsCreate,
    },
  };

  const [{ registerRuntimeApi }, { SessionStore }, { StorageCoordinator }, { TabContextStore }] = await Promise.all([
    import('../src/background/runtime-api.js'),
    import('../src/background/session-store.js'),
    import('../src/background/storage-coordinator.js'),
    import('../src/background/tab-context.js'),
  ]);

  const sessionStore = new SessionStore();
  const storageCoordinator = options?.storageCoordinator ?? new StorageCoordinator();
  const agencyHubClient = options?.agencyHubClient ?? {
    testConnection: vi.fn(async () => ({ ok: true })),
  };
  const spendersService = options?.spendersService ?? {
    getList: vi.fn(async () => ({
      entries: [],
      builtAt: 0,
      fanCount: 0,
      monthWindow: null,
      fetchedAt: 0,
    })),
  };
  const debugPrompts = options?.debugPrompts ?? {
    put: vi.fn(() => 'token'),
    get: vi.fn(() => null),
    has: vi.fn(() => false),
    clear: vi.fn(),
  };
  const tabContexts = options?.tabContexts ?? new TabContextStore();
  const voiceAttempts = options?.voiceAttempts ?? {
    load: vi.fn(async () => []),
    save: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };
  registerRuntimeApi({
    agencyHubClient: agencyHubClient as never,
    fanslyClient: fanslyClient as never,
    sessionStore,
    spendersService: spendersService as never,
    tabContexts,
    storageCoordinator: storageCoordinator as never,
    debugPrompts: debugPrompts as never,
    emitToTab: options?.emitToTab,
    onAgencyHubReady: options?.onAgencyHubReady,
    voiceService: options?.voiceService,
    voiceAttempts: voiceAttempts as never,
  });

  if (!onMessageListener) {
    throw new Error('Runtime listener was not registered');
  }

  return {
    sessionStore,
    tabContexts,
    tabsQuery,
    tabsGet,
    tabsCreate,
    agencyHubClient,
    spendersService,
    debugPrompts,
    voiceAttempts,
    send: (message: unknown, sender?: MessageSenderLike) => onMessageListener!(message, sender),
  };
}

describe('runtime-api storage readiness barrier', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('acknowledges only after durable repair and propagates repair failure', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ensurePersistedState = vi.fn(async () => barrier);
    const readyHarness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => null) },
      { storageCoordinator: { ensurePersistedState } },
    );

    let settled = false;
    const pending = readyHarness.send({ type: 'ensureStorageReady' })
      .finally(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).resolves.toEqual({ ready: true });
    expect(ensurePersistedState).toHaveBeenCalledTimes(1);

    const failedHarness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => null) },
      {
        storageCoordinator: {
          ensurePersistedState: vi.fn(async () => {
            throw new Error('repair failed');
          }),
        },
      },
    );
    await expect(failedHarness.send({ type: 'ensureStorageReady' })).rejects.toThrow(
      'repair failed',
    );
  });
});

describe('runtime-api getSessionsSnapshot', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('enriches active sessions, rekeys legacy ids, and prunes stale known accounts', async () => {
    mockStorage = createStorage({
      accountMappings: {
        legacy: 'p1',
        mappedOffline: 'p2',
      },
      knownAccounts: ['legacy', 'mappedOffline', 'stale'],
    });

    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async (session: SessionTemplate) => {
        session.resolvedAccountId = 'resolved';
        session.resolvedUsername = 'creator';
        session.resolvedDisplayName = 'Creator';
        return {
          id: 'resolved',
          username: 'creator',
          displayName: 'Creator',
        };
      }),
    };

    const { sessionStore } = await installRuntimeApiHarness(fanslyClient);
    sessionStore.registerCapture(1, makeCapture('legacy'));

    const result = await onMessageListener?.({ type: 'getSessionsSnapshot' });

    expect(result).toEqual([
      expect.objectContaining({
        legacyAccountId: 'legacy',
        resolvedAccountId: 'resolved',
        username: 'creator',
        displayName: 'Creator',
      }),
    ]);
    expect(fanslyClient.getAuthenticatedAccount).toHaveBeenCalledTimes(1);
    expect(mockStorage.accountMappings).toEqual({
      resolved: 'p1',
      mappedOffline: 'p2',
    });
    expect(mockStorage.accountAliases).toEqual({
      legacy: 'resolved',
    });
    expect(mockStorage.knownAccounts).toEqual(['mappedOffline', 'resolved']);
  });

  it('keeps mapped offline accounts in storage even when they are absent from the active snapshot', async () => {
    mockStorage = createStorage({
      accountMappings: {
        mappedOffline: 'p1',
      },
      knownAccounts: ['mappedOffline', 'stale'],
    });

    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };

    await installRuntimeApiHarness(fanslyClient);

    const result = await onMessageListener?.({ type: 'getSessionsSnapshot' });

    expect(result).toEqual([]);
    expect(fanslyClient.getAuthenticatedAccount).not.toHaveBeenCalled();
    expect(mockStorage.knownAccounts).toEqual(['mappedOffline']);
    expect(mockStorage.accountMappings).toEqual({
      mappedOffline: 'p1',
    });
    expect(mockStorage.accountAliases).toEqual({});
  });
});

describe('runtime-api boundary guard', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('ignores unknown or malformed runtime requests', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };

    const { tabsGet, tabsQuery } = await installRuntimeApiHarness(fanslyClient);

    await expect(onMessageListener?.({ type: 'unknown' })).resolves.toBeUndefined();
    await expect(onMessageListener?.({ type: 'getPopupStatus', tabId: '1' })).resolves.toBeUndefined();

    expect(tabsGet).not.toHaveBeenCalled();
    expect(tabsQuery).not.toHaveBeenCalled();
    expect(fanslyClient.getAuthenticatedAccount).not.toHaveBeenCalled();
  });
});

describe('runtime-api voice-attempt custody RPC', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('acknowledges save only after the background repository commits', async () => {
    let release!: () => void;
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const voiceAttempts = {
      load: vi.fn(async () => []),
      save: vi.fn(async () => committed),
      remove: vi.fn(async () => undefined),
    };
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => null) },
      { voiceAttempts },
    );
    harness.sessionStore.registerCapture(5, makeCapture('creator-1'));
    harness.tabContexts.setRoute(5, 'group-1', 3);
    harness.tabContexts.setAccount(5, 'creator-1');
    const route = {
      accountId: 'creator-1',
      groupId: 'group-1',
      routeNonce: 3,
    };

    let settled = false;
    const pending = harness.send(
      { type: 'voiceAttemptSave', snapshot: voiceSnapshot(route) },
      { tab: { id: 5 }, url: 'https://fansly.com/messages/group-1' },
    ).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();

    await expect(pending).resolves.toEqual({ version: 1, ok: true });
    expect(voiceAttempts.save).toHaveBeenCalledWith(voiceSnapshot(route));
  });

  it('routes load/save/remove through the one central listener', async () => {
    const route = {
      accountId: 'creator-1',
      groupId: 'group-1',
      routeNonce: 3,
    };
    const entry = { savedAt: 1_000, ...voiceSnapshot(route) };
    const voiceAttempts = {
      load: vi.fn(async () => [entry]),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => null) },
      { voiceAttempts },
    );
    harness.sessionStore.registerCapture(5, makeCapture('creator-1'));
    harness.tabContexts.setRoute(5, 'group-1', 3);
    const sender = { tab: { id: 5 }, url: 'https://fansly.com/messages/group-1' };

    await expect(harness.send(
      { type: 'voiceAttemptLoad', route },
      sender,
    )).resolves.toEqual({ version: 1, ok: true, entries: [entry] });
    await expect(harness.send(
      {
        type: 'voiceAttemptRemove',
        attemptId: entry.attempt.attemptId,
        route: { ...route, routeNonce: 99 },
      },
      sender,
    )).resolves.toEqual({ version: 1, ok: true });

    expect(voiceAttempts.load).toHaveBeenCalledWith(route);
    expect(voiceAttempts.remove).toHaveBeenCalledWith(
      entry.attempt.attemptId,
      { ...route, routeNonce: 99 },
    );
  });

  it.each([
    {
      label: 'no tab',
      sender: { url: 'https://fansly.com/messages/group-1' },
      route: { accountId: 'creator-1', groupId: 'group-1', routeNonce: 3 },
    },
    {
      label: 'extension page',
      sender: { tab: { id: 5 }, url: 'moz-extension://uuid/options.html' },
      route: { accountId: 'creator-1', groupId: 'group-1', routeNonce: 3 },
    },
    {
      label: 'wrong Fansly group',
      sender: { tab: { id: 5 }, url: 'https://fansly.com/messages/group-2' },
      route: { accountId: 'creator-1', groupId: 'group-1', routeNonce: 3 },
    },
    {
      label: 'wrong known account',
      sender: { tab: { id: 5 }, url: 'https://fansly.com/messages/group-1' },
      route: { accountId: 'creator-2', groupId: 'group-1', routeNonce: 3 },
    },
  ])('rejects an invalid content sender: $label', async ({ sender, route }) => {
    const voiceAttempts = {
      load: vi.fn(async () => []),
      save: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => null) },
      { voiceAttempts },
    );
    harness.sessionStore.registerCapture(5, makeCapture('creator-1'));
    harness.tabContexts.setRoute(5, 'group-1', 3);
    harness.tabContexts.setAccount(5, 'creator-1');

    await expect(harness.send(
      { type: 'voiceAttemptLoad', route },
      sender,
    )).resolves.toEqual({
      version: 1,
      ok: false,
      error: 'invalid_sender',
    });
    expect(voiceAttempts.load).not.toHaveBeenCalled();
  });

  it('propagates repository failure instead of inventing an acknowledgement', async () => {
    const route = {
      accountId: 'creator-1',
      groupId: 'group-1',
      routeNonce: 3,
    };
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => null) },
      {
        voiceAttempts: {
          load: vi.fn(async () => []),
          save: vi.fn(async () => {
            throw new Error('session storage rejected');
          }),
          remove: vi.fn(async () => undefined),
        },
      },
    );
    harness.sessionStore.registerCapture(5, makeCapture('creator-1'));
    harness.tabContexts.setRoute(5, 'group-1', 3);

    await expect(harness.send(
      { type: 'voiceAttemptSave', snapshot: voiceSnapshot(route) },
      { tab: { id: 5 }, url: 'https://fansly.com/messages/group-1' },
    )).rejects.toThrow('session storage rejected');
  });
});

describe('runtime-api getPopupStatus', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('uses the requested tab url when tabId is provided', async () => {
    mockStorage = createStorage({
      personalities: [
        {
          id: 'p1',
          name: 'Closer',
          content: 'Sell smoothly',
          updatedAt: 1000,
        },
      ],
      personaCatalog: [{
        key: 'p1',
        displayName: 'Closer',
        definitionId: 'v1:persona-one-definition',
        version: 1000,
        status: 'active',
      }],
      accountMappings: {
        other: 'p1',
      },
    });

    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };

    const { sessionStore, tabsQuery, tabsGet } = await installRuntimeApiHarness(fanslyClient);
    sessionStore.registerCapture(1, makeCapture('active'));
    sessionStore.registerCapture(2, makeCapture('other'));

    tabsQuery.mockResolvedValue([
      { id: 1, url: 'https://fansly.com/messages/active-group' },
    ]);
    tabsGet.mockImplementation(async (tabId: number) => ({
      id: tabId,
      url: tabId === 2
        ? 'https://fansly.com/messages/other-group'
        : 'https://fansly.com/messages/active-group',
    }));

    const result = await onMessageListener?.({
      type: 'getPopupStatus',
      tabId: 2,
    });

    expect(result).toEqual(
      expect.objectContaining({
        tabId: 2,
        accountId: 'other',
        groupId: 'other-group',
        mappedPersonalityId: 'p1',
        mappedPersonalityName: 'Closer',
      }),
    );
    expect(tabsGet).toHaveBeenCalledWith(2);
    expect(tabsQuery).not.toHaveBeenCalled();
  });

  it('reports kernel-lane readiness as hasApiKey (hub transport configured)', async () => {
    mockStorage = createStorage({
      settings: {
        ...createDefaultSettings(),
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'hub-key',
      },
    });
    const { sessionStore, tabsQuery } = await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    });
    sessionStore.registerCapture(1, makeCapture('active'));
    tabsQuery.mockResolvedValue([
      { id: 1, url: 'https://fansly.com/messages/active-group' },
    ]);

    const configured = await onMessageListener?.({ type: 'getPopupStatus' });
    expect(configured).toEqual(expect.objectContaining({ hasApiKey: true }));
  });

  it('reports hasApiKey false when the hub transport is unconfigured', async () => {
    mockStorage = createStorage();
    const { sessionStore, tabsQuery } = await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    });
    sessionStore.registerCapture(1, makeCapture('active'));
    tabsQuery.mockResolvedValue([
      { id: 1, url: 'https://fansly.com/messages/active-group' },
    ]);

    const cleared = await onMessageListener?.({ type: 'getPopupStatus' });
    expect(cleared).toEqual(expect.objectContaining({ hasApiKey: false }));
  });

  it('surfaces the fail-closed voice-notes capability for the selected tab', async () => {
    mockStorage = createStorage();
    const voiceService = {
      resolveCapability: vi.fn(async () => true),
    };
    const { sessionStore, tabsQuery } = await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    }, { voiceService });
    sessionStore.registerCapture(1, makeCapture('active'));
    tabsQuery.mockResolvedValue([
      { id: 1, url: 'https://fansly.com/messages/active-group' },
    ]);

    const result = await onMessageListener?.({ type: 'getPopupStatus' });

    expect(result).toEqual(expect.objectContaining({ voiceNotesCapable: true }));
    expect(voiceService.resolveCapability).toHaveBeenCalledWith(1);
  });
});

describe('runtime-api testAgencyHubConnection', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('passes Agency Hub settings through to the background client and returns its result', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({
        ok: false,
        error: {
          key: 'hub_missing_permission',
          code: 'CG-HUB-04',
          message: 'Agency Hub host permission is missing.',
        },
      })),
    };

    await installRuntimeApiHarness(fanslyClient, { agencyHubClient });

    const settings = {
      agencyHubBaseUrl: 'http://hub.test',
      agencyHubApiKey: 'hub-key',
      agencyHubDeviceToken: '',
    };
    const result = await onMessageListener?.({
      type: 'testAgencyHubConnection',
      settings,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        key: 'hub_missing_permission',
        code: 'CG-HUB-04',
      },
    });
    expect(agencyHubClient.testConnection).toHaveBeenCalledWith(
      settings,
      expect.any(AbortSignal),
    );
  });

  it('returns a coded fallback error when the testAgencyHubConnection request is malformed', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };

    await installRuntimeApiHarness(fanslyClient);

    const result = await onMessageListener?.({
      type: 'testAgencyHubConnection',
    });

    expect(result).toEqual({
      ok: false,
      error: createUserError('hub_request_failed'),
    });
  });

  it('signals persona reconciliation only after a successful live test', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };
    const agencyHubClient = {
      testConnection: vi.fn()
        .mockResolvedValueOnce({ ok: false, error: createUserError('hub_request_failed') })
        .mockResolvedValueOnce({ ok: true }),
    };
    const onAgencyHubReady = vi.fn();
    await installRuntimeApiHarness(fanslyClient, { agencyHubClient, onAgencyHubReady });
    const request = {
      type: 'testAgencyHubConnection',
      settings: {
        agencyHubBaseUrl: 'https://hub.test',
        agencyHubApiKey: 'key',
        agencyHubDeviceToken: '',
      },
    };

    await onMessageListener?.(request);
    expect(onAgencyHubReady).not.toHaveBeenCalled();
    await onMessageListener?.(request);
    expect(onAgencyHubReady).toHaveBeenCalledTimes(1);
  });
});

describe('runtime-api getSpendersList', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('builds the board for the sender tab session', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => undefined),
    };
    const result = {
      entries: [
        {
          fanAccountId: 'fan-1',
          groupId: 'group-1',
          customName: null,
          displayName: 'Whale Bob',
          username: 'whalebob',
          lifetimeMills: 1078000,
          lifetimeUsd: 1078,
          monthMills: null,
          monthUsd: null,
        },
      ],
      builtAt: 123,
      fanCount: 1,
      monthWindow: null,
      fetchedAt: 456,
    };
    const spendersService = { getList: vi.fn(async () => result) };

    const { sessionStore } = await installRuntimeApiHarness(fanslyClient, {
      spendersService,
    });
    sessionStore.registerCapture(7, makeCapture('creator-1'));

    const response = await onMessageListener?.(
      { type: 'getSpendersList', refresh: true },
      { tab: { id: 7 } },
    );

    expect(response).toEqual({ ok: true, result });
    expect(spendersService.getList).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'creator-1' }),
      expect.any(AbortSignal),
      { refresh: true },
    );
  });

  it('returns not_connected when the sender tab has no session', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => undefined),
    };
    const spendersService = { getList: vi.fn(async () => undefined) };

    await installRuntimeApiHarness(fanslyClient, { spendersService });

    const response = await onMessageListener?.(
      { type: 'getSpendersList' },
      { tab: { id: 999 } },
    );

    expect(response).toEqual({ ok: false, error: createUserError('not_connected') });
    expect(spendersService.getList).not.toHaveBeenCalled();
  });

  it('correlates progress frames with the requesting board build', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => undefined),
    };
    const result = {
      entries: [],
      builtAt: null,
      source: {
        streamState: 'ramped' as const,
        lastSyncedAt: null,
        consecutiveFailures: 0,
      },
      fanCount: 0,
      monthWindow: null,
      fetchedAt: 456,
    };
    const spendersService = {
      getList: vi.fn(async (_session, _signal, options) => {
        options?.onProgress?.({ type: 'spenders:progress', phase: 'ranking' });
        options?.onSnapshot?.({ type: 'spenders:snapshot', result });
        return result;
      }),
    };
    const emitToTab = vi.fn();
    const { sessionStore } = await installRuntimeApiHarness(fanslyClient, {
      spendersService,
      emitToTab,
    });
    sessionStore.registerCapture(7, makeCapture('creator-1'));

    await onMessageListener?.(
      { type: 'getSpendersList', buildId: 'board-build-7' },
      { tab: { id: 7 } },
    );

    expect(emitToTab).toHaveBeenCalledWith(7, {
      type: 'spenders:progress',
      buildId: 'board-build-7',
      phase: 'ranking',
    });
    expect(emitToTab).toHaveBeenCalledWith(7, {
      type: 'spenders:snapshot',
      buildId: 'board-build-7',
      result,
    });
  });
});

// ── E23: lazy chat resolve for board entries without an enumerated chat ─────

describe('runtime-api resolveFanChat', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('searches the inbox by username for the sender tab session', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => undefined),
      findGroupIdForFan: vi.fn(async () => 'group-42'),
    };
    const { sessionStore } = await installRuntimeApiHarness(fanslyClient);
    sessionStore.registerCapture(7, makeCapture('creator-1'));

    const response = await onMessageListener?.(
      { type: 'resolveFanChat', fanAccountId: 'fan-9', username: 'ghost', displayName: null },
      { tab: { id: 7 } },
    );

    expect(response).toEqual({ ok: true, groupId: 'group-42' });
    expect(fanslyClient.findGroupIdForFan).toHaveBeenCalledWith(
      'fan-9',
      'ghost',
      expect.objectContaining({ accountId: 'creator-1' }),
      expect.any(AbortSignal),
    );
  });

  it('falls back to the display name and reports an honest not-found', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => undefined),
      findGroupIdForFan: vi.fn(async () => null),
    };
    const { sessionStore } = await installRuntimeApiHarness(fanslyClient);
    sessionStore.registerCapture(7, makeCapture('creator-1'));

    const response = await onMessageListener?.(
      { type: 'resolveFanChat', fanAccountId: 'fan-9', username: null, displayName: 'Ghost Fan' },
      { tab: { id: 7 } },
    );

    expect(response).toEqual({ ok: true, groupId: null });
    expect(fanslyClient.findGroupIdForFan).toHaveBeenCalledWith(
      'fan-9',
      'Ghost Fan',
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it('answers not-found without searching when there is no term to search by', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => undefined),
      findGroupIdForFan: vi.fn(async () => 'never'),
    };
    const { sessionStore } = await installRuntimeApiHarness(fanslyClient);
    sessionStore.registerCapture(7, makeCapture('creator-1'));

    const response = await onMessageListener?.(
      { type: 'resolveFanChat', fanAccountId: 'fan-9', username: null, displayName: null },
      { tab: { id: 7 } },
    );

    expect(response).toEqual({ ok: true, groupId: null });
    expect(fanslyClient.findGroupIdForFan).not.toHaveBeenCalled();
  });

  it('returns not_connected when the sender tab has no session', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => undefined),
      findGroupIdForFan: vi.fn(async () => 'never'),
    };
    await installRuntimeApiHarness(fanslyClient);

    const response = await onMessageListener?.(
      { type: 'resolveFanChat', fanAccountId: 'fan-9', username: 'ghost', displayName: null },
      { tab: { id: 999 } },
    );

    expect(response).toEqual({ ok: false, error: createUserError('not_connected') });
    expect(fanslyClient.findGroupIdForFan).not.toHaveBeenCalled();
  });
});

describe('runtime-api getRecapStatus', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  const recap = {
    state: 'ok' as const,
    full: {
      generatedAt: '2026-07-01T00:00:00.000Z',
      ageMs: 1_000,
      transcriptCoverage: 'full-history' as const,
      requestedCount: 3000,
      keptCount: 2900,
    },
    short: {
      generatedAt: '2026-07-18T00:00:00.000Z',
      ageMs: 10,
      transcriptCoverage: 'window' as const,
      requestedCount: 300,
      keptCount: 300,
    },
  };
  const personaDefinitionId = 'v1:persona-one-definition';

  it('resolves the page label and returns both recap slots for a context-confirmed fan', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    };
    const agencyHubClient = {
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      getRecapStatus: vi.fn(async () => recap),
    };
    const { sessionStore, tabContexts } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    sessionStore.registerCapture(7, makeCapture('creator-1'));
    // P1-2: an explicit fanAccountId is trusted only when the tab context confirms
    // it for THIS group. A prior op cached fan-1 for group-1.
    tabContexts.setRoute(7, 'group-1', 1);
    tabContexts.setFan(7, 'group-1', 'fan-1', 'Alice');

    const response = await onMessageListener?.(
      {
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: 'fan-1',
        personaDefinitionId,
      },
      { tab: { id: 7 } },
    );

    expect(response).toEqual(recap);
    // Canonical identity: conversationRef = groupId, fanRef = fanAccountId.
    expect(agencyHubClient.getRecapStatus).toHaveBeenCalledWith(
      expect.anything(),
      {
        pageLabel: 'creator-fs',
        conversationRef: 'group-1',
        fanRef: 'fan-1',
        personaDefinitionId,
      },
      expect.any(AbortSignal),
    );
  });

  it('P2: resolves fanRef from the cached tab context when content sends null', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    };
    const agencyHubClient = {
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      getRecapStatus: vi.fn(async () => recap),
    };
    const { sessionStore, tabContexts } = await installRuntimeApiHarness(fanslyClient, {
      agencyHubClient,
    });
    sessionStore.registerCapture(7, makeCapture('creator-1'));
    // A prior op cached the conversation's fan for this group + tab.
    tabContexts.setRoute(7, 'group-1', 1);
    tabContexts.setFan(7, 'group-1', 'fan-legacy', 'Alice');

    await onMessageListener?.(
      { type: 'getRecapStatus', groupId: 'group-1', fanAccountId: null, personaDefinitionId },
      { tab: { id: 7 } },
    );

    // Legacy recaps (keyed by fan id) become findable via the resolved fanRef.
    expect(agencyHubClient.getRecapStatus).toHaveBeenCalledWith(
      expect.anything(),
      {
        pageLabel: 'creator-fs',
        conversationRef: 'group-1',
        fanRef: 'fan-legacy',
        personaDefinitionId,
      },
      expect.any(AbortSignal),
    );
  });

  it('P1-2: a cross-group cached fan does not leak, and an unresolved fanRef reports unavailable', async () => {
    // Round-13 P1-2: the cached fan is for a DIFFERENT group, so it must not be
    // used (no cross-group leak). With no fanRef, a groupId-only query can never
    // find a fan-id-keyed recap, so we do NOT query and confirm empty — we report
    // 'unavailable' (honest "couldn't check").
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    };
    const agencyHubClient = {
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      getRecapStatus: vi.fn(async () => recap),
    };
    const { sessionStore, tabContexts } = await installRuntimeApiHarness(fanslyClient, {
      agencyHubClient,
    });
    sessionStore.registerCapture(7, makeCapture('creator-1'));
    tabContexts.setRoute(7, 'other-group', 1);
    tabContexts.setFan(7, 'other-group', 'fan-other', 'Someone');

    const response = await onMessageListener?.(
      { type: 'getRecapStatus', groupId: 'group-1', fanAccountId: null, personaDefinitionId },
      { tab: { id: 7 } },
    );

    // Never queried the Hub with a null fanRef, never leaked the cross-group fan.
    expect(agencyHubClient.getRecapStatus).not.toHaveBeenCalled();
    expect(response).toEqual({ state: 'unavailable', full: null, short: null });
  });

  it('P1-2: a COLD recap-status (no cached fan) reports unavailable, not confirmed-empty', async () => {
    // Service-worker restart: the tab context has no fan yet, so fanRef is null.
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    };
    const agencyHubClient = {
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      getRecapStatus: vi.fn(async () => recap),
    };
    const { sessionStore } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    sessionStore.registerCapture(7, makeCapture('creator-1'));
    // No setRoute/setFan — cold TabContext.

    const response = await onMessageListener?.(
      { type: 'getRecapStatus', groupId: 'group-1', fanAccountId: null, personaDefinitionId },
      { tab: { id: 7 } },
    );

    expect(agencyHubClient.getRecapStatus).not.toHaveBeenCalled();
    expect(response).toEqual({ state: 'unavailable', full: null, short: null });
  });

  it('P1-2: an empty-string fanAccountId takes the null path (unavailable, no query)', async () => {
    // Round-14: '' is a falsy fanRef the client would drop, leaving a groupId-only
    // query that FALSELY confirms empty. The handler coerces ''/whitespace → null.
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    };
    const agencyHubClient = {
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      getRecapStatus: vi.fn(async () => recap),
    };
    const { sessionStore } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    sessionStore.registerCapture(7, makeCapture('creator-1'));

    const response = await onMessageListener?.(
      { type: 'getRecapStatus', groupId: 'group-1', fanAccountId: '   ', personaDefinitionId },
      { tab: { id: 7 } },
    );

    expect(agencyHubClient.getRecapStatus).not.toHaveBeenCalled();
    expect(response).toEqual({ state: 'unavailable', full: null, short: null });
  });

  it('P1-2: an explicit fanAccountId the context does not confirm for this group → unavailable', async () => {
    // Round-14: content's DOM fan id can lag an SPA A→B route-change, so a fan the
    // tab context does not confirm for THIS group is a possible cross-group leak.
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    };
    const agencyHubClient = {
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      getRecapStatus: vi.fn(async () => recap),
    };
    const { sessionStore, tabContexts } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    sessionStore.registerCapture(7, makeCapture('creator-1'));
    // Context confirms fan-B for group-1; content sends the stale fan-A.
    tabContexts.setRoute(7, 'group-1', 2);
    tabContexts.setFan(7, 'group-1', 'fan-B', 'Bea');

    const response = await onMessageListener?.(
      { type: 'getRecapStatus', groupId: 'group-1', fanAccountId: 'fan-A', personaDefinitionId },
      { tab: { id: 7 } },
    );

    // Never queried the Hub with the unconfirmed (possibly cross-group) fan.
    expect(agencyHubClient.getRecapStatus).not.toHaveBeenCalled();
    expect(response).toEqual({ state: 'unavailable', full: null, short: null });
  });

  it('returns UNAVAILABLE state on any failure — never breaks coach opening, never fakes "no recap"', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    };
    const agencyHubClient = {
      resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
      getRecapStatus: vi.fn(async () => {
        throw new Error('hub down');
      }),
    };
    const { sessionStore } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    sessionStore.registerCapture(7, makeCapture('creator-1'));

    const response = await onMessageListener?.(
      {
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: 'fan-1',
        personaDefinitionId,
      },
      { tab: { id: 7 } },
    );

    expect(response).toEqual({ state: 'unavailable', full: null, short: null });
  });

  it('returns unavailable when the sender tab has no connected session', async () => {
    const agencyHubClient = {
      resolvePageLabelForUsername: vi.fn(),
      getRecapStatus: vi.fn(),
    };
    await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => undefined) },
      { agencyHubClient },
    );

    const response = await onMessageListener?.(
      {
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: 'fan-1',
        personaDefinitionId,
      },
      { tab: { id: 999 } },
    );

    expect(response).toEqual({ state: 'unavailable', full: null, short: null });
    expect(agencyHubClient.getRecapStatus).not.toHaveBeenCalled();
  });

  it('returns unavailable when no Hub page matches the creator', async () => {
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    };
    const agencyHubClient = {
      resolvePageLabelForUsername: vi.fn(async () => null),
      getRecapStatus: vi.fn(async () => recap),
    };
    const { sessionStore } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    sessionStore.registerCapture(7, makeCapture('creator-1'));

    const response = await onMessageListener?.(
      {
        type: 'getRecapStatus',
        groupId: 'group-1',
        fanAccountId: 'fan-1',
        personaDefinitionId,
      },
      { tab: { id: 7 } },
    );

    expect(response).toEqual({ state: 'unavailable', full: null, short: null });
    expect(agencyHubClient.getRecapStatus).not.toHaveBeenCalled();
  });
});

// E28. The prompt echo carries the persona, the templates and the fan dossier —
// the agency's own IP. These tests pin the two rules that keep it out of
// fansly.com: only our viewer page may read a snapshot, and a token that no
// longer resolves never opens a tab.
describe('runtime-api debug prompt viewer (E28)', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  const snapshot = {
    operationId: 'op-1',
    feature: 'fast-reply' as const,
    modelId: 'claude-x',
    capturedAt: 1_000,
    systemBlocks: [{ text: 'safety + persona', cache: '1h' }],
    userBlocks: [{ text: '## Fan Dossier\nsecret', cache: '5m' }],
    contextManifest: { fanProfile: { version: 2 } },
  };

  function debugStore(stored: typeof snapshot | null) {
    return {
      put: vi.fn(() => 'tok'),
      get: vi.fn(() => stored),
      has: vi.fn(() => stored !== null),
      clear: vi.fn(),
    };
  }

  it('hands the assembled prompt only to the viewer page', async () => {
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => undefined) },
      { debugPrompts: debugStore(snapshot) },
    );

    const forViewer = await harness.send(
      { type: 'getDebugPromptSnapshot', viewerToken: 'tok' },
      { url: 'moz-extension://cg-test-uuid/debug-prompt.html?token=tok' },
    );
    expect(forViewer).toMatchObject({
      feature: 'fast-reply',
      modelId: 'claude-x',
      userBlocks: [{ text: '## Fan Dossier\nsecret', cache: '5m' }],
    });

    // The Fansly content script holds the token, but must not be able to spend
    // it: it shares a document with the site's own JS.
    const forContentScript = await harness.send(
      { type: 'getDebugPromptSnapshot', viewerToken: 'tok' },
      { tab: { id: 3 }, url: 'https://fansly.com/messages/123' },
    );
    expect(forContentScript).toBeUndefined();

    // A page that merely STARTS with our path is a different page.
    const forLookalike = await harness.send(
      { type: 'getDebugPromptSnapshot', viewerToken: 'tok' },
      { url: 'moz-extension://cg-test-uuid/debug-prompt.html.evil?token=tok' },
    );
    expect(forLookalike).toBeUndefined();
    expect(harness.debugPrompts.get).toHaveBeenCalledTimes(1);
  });

  it('opens the viewer tab for a live token and refuses a dead one', async () => {
    const live = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => undefined) },
      { debugPrompts: debugStore(snapshot) },
    );
    const opened = await live.send(
      { type: 'openDebugPrompt', viewerToken: 'tok' },
      { tab: { id: 3 }, url: 'https://fansly.com/messages/123' },
    );
    expect(opened).toEqual({ opened: true });
    expect(live.tabsCreate).toHaveBeenCalledWith({
      url: 'moz-extension://cg-test-uuid/debug-prompt.html?token=tok',
    });

    const expired = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => undefined) },
      { debugPrompts: debugStore(null) },
    );
    const refused = await expired.send(
      { type: 'openDebugPrompt', viewerToken: 'gone' },
      { tab: { id: 3 }, url: 'https://fansly.com/messages/123' },
    );
    expect(refused).toEqual({ opened: false });
    expect(expired.tabsCreate).not.toHaveBeenCalled();
  });
});
