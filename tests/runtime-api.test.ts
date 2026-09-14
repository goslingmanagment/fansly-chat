import { beforeEach, describe, expect, it, vi } from 'vitest';
import manifest from '../manifest.json';
import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  AGENCY_HUB_PREFETCH_TIMEOUT_MS,
  LAST_SEEN_VERSION_STORAGE_KEY,
  ONBOARDING_STORAGE_KEY,
  SPENDERS_BUILD_TIMEOUT_MS,
  SPENDERS_BUILD_TIMEOUT_REASON,
  STORAGE_SCHEMA_VERSION,
  VOICE_CAPABILITY_BUDGET_MS,
} from '../src/shared/constants.js';
import { createUserError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import { normalizeAgencyHubBaseUrl } from '../src/shared/agency-hub.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import { SpendersService } from '../src/background/spenders-service.js';
import { spendersObservationScope } from '../src/background/spenders-status-tracker.js';
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

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
    checkHealth?: ReturnType<typeof vi.fn>;
    checkIdentity?: ReturnType<typeof vi.fn>;
    revokeDeviceToken?: ReturnType<typeof vi.fn>;
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
    resolveCapabilityFast: (tabId: number, budgetMs: number) => Promise<boolean>;
  };
  voiceAttempts?: {
    load: (route: StoredVoiceAttemptRoute) => Promise<unknown[]>;
    save: (
      snapshot: VoiceAttemptStoreSnapshot,
      expectedRevision: number,
    ) => Promise<number>;
    remove: (
      attemptId: string,
      route: StoredVoiceAttemptRoute,
      expectedRevision: number,
    ) => Promise<void>;
  };
  tabContexts?: TabContextStoreClass;
  storageCoordinator?: {
    ensurePersistedState?: () => Promise<unknown>;
    // A stub can pin `getState` to a deliberately STALE snapshot: the real
    // coordinator in this harness re-reads storage on every call (its listener
    // probe is never observed), so only a stub can reproduce the cache lag a
    // handler sees in Firefox.
    getState?: () => Promise<unknown>;
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
  const tabsUpdate = vi.fn<
    (tabId: number, info: { active?: boolean }) => Promise<{ id: number }>
  >(async (tabId: number) => ({ id: tabId }));
  const windowsUpdate = vi.fn<
    (windowId: number, info: { focused?: boolean }) => Promise<{ id: number }>
  >(async (windowId: number) => ({ id: windowId }));

  // A shared in-memory storage.session so a REAL SpendersService's status
  // observation (written through the tracker's storage.session custody) is
  // inspectable by the test regardless of module-instance identity.
  const sessionBacking: Record<string, unknown> = {};
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
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete mockStorage[key];
          }
        }),
      },
      session: {
        get: vi.fn(async (key: string) => structuredClone({ [key]: sessionBacking[key] })),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(sessionBacking, structuredClone(items));
        }),
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
      update: tabsUpdate,
    },
    windows: {
      update: windowsUpdate,
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
    checkHealth: vi.fn(async () => ({ ok: false, reason: 'no_base_url' })),
    checkIdentity: vi.fn(async () => ({ ok: false, reason: 'no_credential' })),
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
    save: vi.fn(async () => 1),
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
    storageCoordinator,
    sessionBacking,
    tabContexts,
    tabsQuery,
    tabsGet,
    tabsCreate,
    tabsUpdate,
    windowsUpdate,
    agencyHubClient,
    spendersService,
    debugPrompts,
    voiceAttempts,
    send: (message: unknown, sender?: MessageSenderLike) => onMessageListener!(message, sender),
  };
}

describe('runtime-api message ownership', () => {
  it('declines follower requests synchronously so their dedicated listener can respond', async () => {
    await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn(async () => null) });
    const coreListener = onMessageListener!;
    expect(coreListener({ type: 'followers', action: 'scan', hours: 48 }, { tab: { id: 7 } })).toBeUndefined();
    expect(coreListener({ type: 'followersDebug', action: 'list' }, { tab: { id: 7 } })).toBeUndefined();

    // Register the actual follower bridge beside the core bridge. In Firefox,
    // a Promise claims the response channel even when it resolves undefined.
    const { registerFollowersRuntime } = await import('../src/background/followers-runtime.js');
    Object.assign(browser.runtime, { id: 'chatgoose@test' });
    Object.assign(browser.tabs, { onRemoved: { addListener: vi.fn() } });
    const snapshot = { scanId: '11111111-1111-4111-8111-111111111111' };
    const start = vi.fn(async () => snapshot);
    registerFollowersRuntime({ start } as never);
    const followersListener = onMessageListener!;
    const sender = { id: 'chatgoose@test', frameId: 0, tab: { id: 7 }, url: 'https://fansly.com/' };
    const responses = [coreListener, followersListener].map((listener) => listener({ type: 'followers', action: 'scan', hours: 48 }, sender)).filter((response) => response !== undefined);
    expect(responses).toHaveLength(1);
    await expect(responses[0]).resolves.toEqual({ ok: true, snapshot });
    expect(start).toHaveBeenCalledWith(7, 48);
    expect(followersListener({ type: 'getSessionsSnapshot' }, sender)).toBeUndefined();
  });
});

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

    expect(onMessageListener?.({ type: 'unknown' })).toBeUndefined();
    expect(onMessageListener?.({ type: 'getPopupStatus', tabId: '1' })).toBeUndefined();

    expect(tabsGet).not.toHaveBeenCalled();
    expect(tabsQuery).not.toHaveBeenCalled();
    expect(fanslyClient.getAuthenticatedAccount).not.toHaveBeenCalled();
  });
});

describe('runtime-api getTabAccountIdentity', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('answers with the sender tab\'s live session, preferring the local label', async () => {
    mockStorage = createStorage({
      'chatgoose:accountLabels': { version: 1, byAccount: { resolved: 'Ари-1' } },
    });
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };
    const { sessionStore, send } = await installRuntimeApiHarness(fanslyClient);
    sessionStore.registerCapture(3, makeCapture('legacy'));
    const session = sessionStore.getSessionForTab(3)!;
    session.resolvedAccountId = 'resolved';
    session.resolvedUsername = 'itsaribae';
    session.resolvedDisplayName = 'Ari';

    await expect(send({ type: 'getTabAccountIdentity' }, { tab: { id: 3 } })).resolves.toEqual({
      accountId: 'resolved',
      label: 'Ари-1',
      username: 'itsaribae',
      displayName: 'Ari',
    });
    expect(fanslyClient.getAuthenticatedAccount).not.toHaveBeenCalled();
  });

  it('falls back to the display name, then to the tab context, and never guesses', async () => {
    mockStorage = createStorage();
    const fanslyClient = {
      getAuthenticatedAccount: vi.fn(async () => null),
    };
    const { sessionStore, tabContexts, send } = await installRuntimeApiHarness(fanslyClient);
    sessionStore.registerCapture(3, makeCapture('legacy'));
    const session = sessionStore.getSessionForTab(3)!;
    session.resolvedUsername = 'itsaribae';
    session.resolvedDisplayName = 'Ari';

    await expect(send({ type: 'getTabAccountIdentity' }, { tab: { id: 3 } })).resolves.toMatchObject({
      accountId: 'legacy',
      label: expect.stringContaining('Ari'),
    });

    // A tab the session store never saw but the capture layer attributed.
    tabContexts.setAccount(9, 'ctx-account');
    await expect(send({ type: 'getTabAccountIdentity' }, { tab: { id: 9 } })).resolves.toMatchObject({
      accountId: 'ctx-account',
      username: null,
      displayName: null,
    });

    // Unknown tab, or no tab at all (an extension page asking): null.
    await expect(send({ type: 'getTabAccountIdentity' }, { tab: { id: 42 } })).resolves.toBeNull();
    await expect(send({ type: 'getTabAccountIdentity' }, {})).resolves.toBeNull();
  });
});

describe('runtime-api voice-attempt custody RPC', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('acknowledges save only after the background repository commits', async () => {
    let release!: (revision: number) => void;
    const committed = new Promise<number>((resolve) => {
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
      { type: 'voiceAttemptSave', snapshot: voiceSnapshot(route), expectedRevision: 0 },
      { tab: { id: 5 }, url: 'https://fansly.com/messages/group-1' },
    ).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(1);

    await expect(pending).resolves.toEqual({ version: 2, ok: true, revision: 1 });
    expect(voiceAttempts.save).toHaveBeenCalledWith(voiceSnapshot(route), 0);
  });

  it('routes load/save/remove through the one central listener', async () => {
    const route = {
      accountId: 'creator-1',
      groupId: 'group-1',
      routeNonce: 3,
    };
    const entry = { savedAt: 1_000, revision: 4, ...voiceSnapshot(route) };
    const voiceAttempts = {
      load: vi.fn(async () => [entry]),
      save: vi.fn(async () => 1),
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
    )).resolves.toEqual({ version: 2, ok: true, entries: [entry] });
    await expect(harness.send(
      {
        type: 'voiceAttemptRemove',
        attemptId: entry.attempt.attemptId,
        route: { ...route, routeNonce: 99 },
        expectedRevision: entry.revision,
      },
      sender,
    )).resolves.toEqual({ version: 2, ok: true });

    expect(voiceAttempts.load).toHaveBeenCalledWith(route);
    expect(voiceAttempts.remove).toHaveBeenCalledWith(
      entry.attempt.attemptId,
      { ...route, routeNonce: 99 },
      entry.revision,
    );
  });

  it('accepts the canonical route id while the tab context holds the legacy alias', async () => {
    const route = {
      accountId: 'creator-1',
      groupId: 'group-1',
      routeNonce: 3,
    };
    const entry = { savedAt: 1_000, revision: 1, ...voiceSnapshot(route) };
    const voiceAttempts = {
      load: vi.fn(async () => [entry]),
      save: vi.fn(async () => 1),
      remove: vi.fn(async () => undefined),
    };
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => null) },
      { voiceAttempts },
    );
    // handleCapture rewrites TabContext.accountId with the LEGACY captured id
    // on every Fansly request, while the content route carries the canonical
    // resolved id. The session alias set must win over the oscillating
    // context value.
    harness.sessionStore.registerCapture(5, makeCapture('legacy-1'));
    const session = harness.sessionStore.getSessionForTab(5);
    if (session) {
      session.resolvedAccountId = 'creator-1';
    }
    harness.tabContexts.setRoute(5, 'group-1', 3);
    harness.tabContexts.setAccount(5, 'legacy-1');
    const sender = { tab: { id: 5 }, url: 'https://fansly.com/messages/group-1' };

    await expect(harness.send(
      { type: 'voiceAttemptLoad', route },
      sender,
    )).resolves.toEqual({ version: 2, ok: true, entries: [entry] });
    expect(voiceAttempts.load).toHaveBeenCalledWith(route);
  });

  it('accepts a sender whose frozen sender.url predates the SPA navigation (Firefox pushState)', async () => {
    const route = {
      accountId: 'creator-1',
      groupId: 'group-1',
      routeNonce: 3,
    };
    const entry = { savedAt: 1_000, revision: 1, ...voiceSnapshot(route) };
    const voiceAttempts = {
      load: vi.fn(async () => [entry]),
      save: vi.fn(async () => 1),
      remove: vi.fn(async () => undefined),
    };
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => null) },
      { voiceAttempts },
    );
    harness.sessionStore.registerCapture(5, makeCapture('creator-1'));
    harness.tabContexts.setRoute(5, 'group-1', 3);
    // Firefox freezes sender.url at the document's LOAD URL; only tab.url
    // follows history.pushState. A conversation opened via SPA navigation
    // must validate against the live tab.url.
    const sender = {
      tab: { id: 5, url: 'https://fansly.com/messages/group-1' },
      url: 'https://fansly.com/home',
    };

    await expect(harness.send(
      { type: 'voiceAttemptLoad', route },
      sender,
    )).resolves.toEqual({ version: 2, ok: true, entries: [entry] });
    expect(voiceAttempts.load).toHaveBeenCalledWith(route);
  });

  it.each([
    {
      label: 'live tab.url on a different conversation wins over a stale sender.url',
      sender: {
        tab: { id: 5, url: 'https://fansly.com/messages/group-2' },
        url: 'https://fansly.com/messages/group-1',
      },
      route: { accountId: 'creator-1', groupId: 'group-1', routeNonce: 3 },
    },
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
      save: vi.fn(async () => 1),
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
      version: 2,
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
      { type: 'voiceAttemptSave', snapshot: voiceSnapshot(route), expectedRevision: 0 },
      { tab: { id: 5 }, url: 'https://fansly.com/messages/group-1' },
    )).rejects.toThrow('session storage rejected');
  });
});

describe('runtime-api getAiQuotaStatus', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('returns null when no same-day quota observation exists', async () => {
    await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => null),
    });
    await expect(onMessageListener?.({ type: 'getAiQuotaStatus' })).resolves.toBeNull();
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

  it('carries resolved human names and drops the fan placeholder', async () => {
    mockStorage = createStorage();
    const { sessionStore, tabContexts, tabsQuery } = await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    });
    sessionStore.registerCapture(1, makeCapture('active'));
    const session = sessionStore.getSessionByAccount('active');
    if (!session) {
      throw new Error('session missing');
    }
    session.resolvedDisplayName = 'Lora Belle';
    session.resolvedUsername = 'lorabelle';
    tabContexts.setRoute(1, 'active-group', 1);
    tabContexts.setFan(1, 'active-group', 'fan-1', 'BigTipper92');
    tabsQuery.mockResolvedValue([
      { id: 1, url: 'https://fansly.com/messages/active-group' },
    ]);

    const named = await onMessageListener?.({ type: 'getPopupStatus' });
    expect(named).toEqual(
      expect.objectContaining({
        accountName: 'Lora Belle (@lorabelle)',
        fanName: 'BigTipper92',
      }),
    );

    // The operations-side 'fan' placeholder must not surface as a name.
    tabContexts.setFan(1, 'active-group', 'fan-1', 'fan');
    const placeholder = await onMessageListener?.({ type: 'getPopupStatus' });
    expect(placeholder).toEqual(expect.objectContaining({ fanName: null }));
  });

  it('surfaces the fail-closed voice-notes capability for the selected tab', async () => {
    mockStorage = createStorage();
    const voiceService = {
      resolveCapabilityFast: vi.fn(async () => true),
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
    expect(voiceService.resolveCapabilityFast).toHaveBeenCalledWith(
      1,
      VOICE_CAPABILITY_BUDGET_MS,
    );
  });

  it('answers within the first-paint budget when the capability probe is slow', async () => {
    // The popup used to await the whole cold probe (up to
    // AGENCY_HUB_PREFETCH_TIMEOUT_MS = 5s) before painting anything at all.
    // The budget answers fail-closed instead; the 🎙 hint catches up over the
    // tab-state re-push the service fires when the probe lands.
    mockStorage = createStorage();
    const voiceService = {
      // Stands in for the service's budget race: the underlying probe would
      // need the full prefetch timeout, the budget answers before it.
      resolveCapabilityFast: vi.fn(
        (_tabId: number, budgetMs: number) =>
          new Promise<boolean>((resolve) => {
            setTimeout(() => resolve(false), budgetMs);
            setTimeout(() => resolve(true), AGENCY_HUB_PREFETCH_TIMEOUT_MS);
          }),
      ),
    };
    const { sessionStore, tabsQuery } = await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => ({ username: 'creator' })),
    }, { voiceService });
    sessionStore.registerCapture(1, makeCapture('active'));
    tabsQuery.mockResolvedValue([
      { id: 1, url: 'https://fansly.com/messages/active-group' },
    ]);

    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const pending = onMessageListener?.({ type: 'getPopupStatus' });
      // The handler reaches the resolver through several storage/tabs task
      // hops; step the clock in 1ms slices until it does.
      for (
        let i = 0;
        i < 50 && voiceService.resolveCapabilityFast.mock.calls.length === 0;
        i += 1
      ) {
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(voiceService.resolveCapabilityFast).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(VOICE_CAPABILITY_BUDGET_MS);
      await expect(pending).resolves.toEqual(
        expect.objectContaining({ voiceNotesCapable: false }),
      );
      // The popup answered long before a cold probe could have.
      expect(Date.now() - startedAt).toBeLessThan(AGENCY_HUB_PREFETCH_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
    expect(voiceService.resolveCapabilityFast).toHaveBeenCalledWith(
      1,
      VOICE_CAPABILITY_BUDGET_MS,
    );
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

describe('runtime-api issueAgencyHubDeviceToken', () => {
  const fanslyClient = { getAuthenticatedAccount: vi.fn(async () => undefined) };
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('commits the device token and its issuing-hub metadata in ONE storage write', async () => {
    // Custody-grade binding: sign-out revokes against `meta.issuedFrom`, so a
    // token that lands without its metadata (or with a PREVIOUS hub's) sends the
    // new bearer to the old hub, whose 401 reads as a clean sign-out while the
    // token stays live. One `storage.set` makes that divergence impossible.
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_from_hub_a',
      [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: {
        version: 1,
        keyPrefix: 'aaa',
        issuedAt: 1,
        expiresAt: '2026-08-01T00:00:00.000Z',
        issuedFrom: 'https://hub-a.example',
      },
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub-a.example' },
    });
    const { send } = await installRuntimeApiHarness(fanslyClient);

    const setCalls: Array<Record<string, unknown>> = [];
    const browserRef = (globalThis as {
      browser: { storage: { local: { set: (items: Record<string, unknown>) => Promise<void> } } };
    }).browser;
    const realSet = browserRef.storage.local.set;
    browserRef.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
      setCalls.push({ ...items });
      return realSet(items);
    });

    vi.stubGlobal('fetch', vi.fn(async (url: URL | string) => {
      const href = String(url);
      const json = (payload: unknown): Response => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
      if (href.endsWith('/api/v1/auth/login')) {
        return json({
          authMethod: 'session',
          user: {
            id: 7, username: 'dasha', role: 'chatter', mustChangePassword: false, assignedPages: [],
          },
        });
      }
      if (href.endsWith('/api/v1/auth/device-tokens')) {
        return json({
          token: 'agency_hub_device_from_hub_b',
          id: 12,
          label: 'chatgoose-extension firefox',
          keyPrefix: 'bbb',
          expiresAt: '2026-10-04T00:00:00.000Z',
        });
      }
      if (href.endsWith('/api/v1/auth/logout')) {
        return json({ ok: true });
      }
      throw new Error(`Unexpected URL: ${href}`);
    }));
    try {
      const response = await send({
        type: 'issueAgencyHubDeviceToken',
        baseUrl: 'https://hub-b.example',
        username: 'dasha',
        password: 'pw',
      });
      expect(response).toMatchObject({ ok: true, keyPrefix: 'bbb' });
    } finally {
      vi.unstubAllGlobals();
      browserRef.storage.local.set = realSet;
    }

    // The custody key and the metadata rode the SAME set — there is no window in
    // which the token belongs to hub B while the record still names hub A.
    const custodyWrites = setCalls.filter(
      (call) => AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY in call,
    );
    expect(custodyWrites).toHaveLength(1);
    expect(custodyWrites[0]).toMatchObject({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_from_hub_b',
      [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: expect.objectContaining({
        version: 1,
        keyPrefix: 'bbb',
        issuedFrom: 'https://hub-b.example',
      }),
    });
    // No separate metadata write is left anywhere in the sequence.
    expect(
      setCalls.filter((call) => AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY in call),
    ).toHaveLength(1);
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]).toMatchObject({
      issuedFrom: 'https://hub-b.example',
    });
  });
});

describe('runtime-api signOutAgencyHub', () => {
  const fanslyClient = { getAuthenticatedAccount: vi.fn(async () => undefined) };
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('wipes BOTH custody keys and the token metadata, and reports "revoked"', async () => {
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc',
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: 'legacy-key',
      [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: {
        version: 1, keyPrefix: 'abc', issuedAt: 1, expiresAt: '2026-08-01T00:00:00.000Z',
      },
    });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(
        async (
          _settings: { agencyHubBaseUrl: string; agencyHubDeviceToken: string },
          _signal: AbortSignal,
        ) => 'revoked' as const,
      ),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    const response = await send({ type: 'signOutAgencyHub' });
    expect(response).toEqual({ outcome: 'revoked' });
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe(''); // EMPTY, not removed
    expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');
    // The operational metadata described a token that no longer exists here.
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]).toBeUndefined();
    // Revoke used the CAPTURED token (the stored copy is already wiped by now).
    expect(agencyHubClient.revokeDeviceToken).toHaveBeenCalledTimes(1);
    const [passedSettings] = agencyHubClient.revokeDeviceToken.mock.calls[0]!;
    expect(passedSettings.agencyHubDeviceToken).toBe('agency_hub_device_abc');
  });

  it('revokes against the ISSUING hub after the base URL moved, not the current one', async () => {
    // The token was minted on hub A; the chatter later re-pointed the extension
    // at hub B. Revoking against B gets a 401/403 that maps to
    // `already-invalid`, so the UI would report a clean sign-out while the
    // bearer stayed alive on A. `issuedFrom` is the only record of who minted it.
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc',
      [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: {
        version: 1,
        keyPrefix: 'abc',
        issuedAt: 1,
        expiresAt: '2026-08-01T00:00:00.000Z',
        issuedFrom: 'https://hub-a.example',
      },
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub-b.example' },
    });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(
        async (
          _settings: { agencyHubBaseUrl: string; agencyHubDeviceToken: string },
          _signal: AbortSignal,
        ) => 'revoked' as const,
      ),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    expect(await send({ type: 'signOutAgencyHub' })).toEqual({ outcome: 'revoked' });
    const [passedSettings] = agencyHubClient.revokeDeviceToken.mock.calls[0]!;
    expect(passedSettings.agencyHubBaseUrl).toBe('https://hub-a.example');
  });

  it('falls back to the current base URL for a token issued before issuedFrom existed', async () => {
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc',
      // A v1 record written by an older build: no issuing address recorded.
      [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: {
        version: 1, keyPrefix: 'abc', issuedAt: 1, expiresAt: '2026-08-01T00:00:00.000Z',
      },
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub-b.example' },
    });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(
        async (
          _settings: { agencyHubBaseUrl: string; agencyHubDeviceToken: string },
          _signal: AbortSignal,
        ) => 'revoked' as const,
      ),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    await send({ type: 'signOutAgencyHub' });
    const [passedSettings] = agencyHubClient.revokeDeviceToken.mock.calls[0]!;
    expect(passedSettings.agencyHubBaseUrl).toBe('https://hub-b.example');
  });

  it('re-wipes after the revoke: a legacy key restored mid-revoke does not survive', async () => {
    // The options page's debounced settings chain writes `agencyHubApiKey`
    // OUTSIDE the auth FIFO. A delayed autosave (or a second options tab)
    // landing during the up-to-5s revoke would put a usable key back on disk
    // AFTER the wipe, while this handler still answered `revoked`.
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc',
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: 'legacy-key',
    });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(async () => {
        // The wipe already landed…
        expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');
        // …and now a stale page write resurrects the key mid-revoke.
        mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY] = 'legacy-key-resurrected';
        return 'revoked' as const;
      }),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    expect(await send({ type: 'signOutAgencyHub' })).toEqual({ outcome: 'revoked' });
    // EMPTY string, never removal (E19) — and never the resurrected value.
    expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
  });

  it('wipes BEFORE the revoke resolves: a deferred revoke still leaves storage wiped', async () => {
    // Background durability: the wipe must land even if the page closes mid-revoke.
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc',
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: 'legacy-key',
    });
    const release = createDeferred<'revoked'>();
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(async () => {
        // By the time the revoke runs the wipe has already committed.
        expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
        expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');
        return release.promise;
      }),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    const pending = send({ type: 'signOutAgencyHub' });
    release.resolve('revoked');
    expect(await pending).toEqual({ outcome: 'revoked' });
  });

  it('no token to revoke → "already-invalid", and STILL wipes any leftover apiKey', async () => {
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: '',
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: 'legacy-key',
    });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(async () => 'revoked' as const),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    const response = await send({ type: 'signOutAgencyHub' });
    expect(response).toEqual({ outcome: 'already-invalid' });
    expect(agencyHubClient.revokeDeviceToken).not.toHaveBeenCalled(); // nothing to revoke
    expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe(''); // apiKey still wiped
  });

  it('maps a 401/403 revoke to "unreachable" when NO metadata names the issuing hub', async () => {
    // Without a metadata record nothing here knows which hub minted the stored
    // token, so the revoke goes to a guessed address. Its 401/403 is equally «the
    // token is dead» and «this hub never issued it» — reporting «уже недействителен»
    // would claim a clean sign-out over a bearer that may still be live elsewhere.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc',
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub-b.example' },
    });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(async () => 'already-invalid' as const),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    expect(await send({ type: 'signOutAgencyHub' })).toEqual({ outcome: 'unreachable' });
    // The revoke WAS attempted (best effort against the only address we have)…
    expect(agencyHubClient.revokeDeviceToken).toHaveBeenCalledTimes(1);
    // …and the local wipe still happened — EMPTY strings, never removal (E19).
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
    expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');
    vi.restoreAllMocks();
  });

  it('maps a 401/403 revoke to "unreachable" for a metadata record with no issuing address', async () => {
    // A valid pre-`issuedFrom` v1 record is READABLE but says nothing about who
    // minted the token, so the revoke falls back to the CURRENT base URL — also a
    // guess. Keying the honest-outcome decision on the record's existence rather
    // than on the address would report «уже недействителен» over that guess.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc',
      [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: {
        version: 1, keyPrefix: 'abc', issuedAt: 1, expiresAt: '2026-08-01T00:00:00.000Z',
      },
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub-b.example' },
    });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(
        async (
          _settings: { agencyHubBaseUrl: string; agencyHubDeviceToken: string },
          _signal: AbortSignal,
        ) => 'already-invalid' as const,
      ),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    expect(await send({ type: 'signOutAgencyHub' })).toEqual({ outcome: 'unreachable' });
    const [passedSettings] = agencyHubClient.revokeDeviceToken.mock.calls[0]!;
    expect(passedSettings.agencyHubBaseUrl).toBe('https://hub-b.example');
    vi.restoreAllMocks();
  });

  it('keeps "already-invalid" when VALID metadata names the issuing hub', async () => {
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc',
      [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: {
        version: 1,
        keyPrefix: 'abc',
        issuedAt: 1,
        expiresAt: '2026-08-01T00:00:00.000Z',
        issuedFrom: 'https://hub-a.example',
      },
    });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(
        async (
          _settings: { agencyHubBaseUrl: string; agencyHubDeviceToken: string },
          _signal: AbortSignal,
        ) => 'already-invalid' as const,
      ),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    // The 401 came from the hub that really minted this token: an honest sign-out.
    expect(await send({ type: 'signOutAgencyHub' })).toEqual({ outcome: 'already-invalid' });
    const [passedSettings] = agencyHubClient.revokeDeviceToken.mock.calls[0]!;
    expect(passedSettings.agencyHubBaseUrl).toBe('https://hub-a.example');
  });

  it('maps a thrown revoke to "unreachable" (already wiped)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockStorage = createStorage({ [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc' });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(async () => {
        throw new Error('network down');
      }),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    expect(await send({ type: 'signOutAgencyHub' })).toEqual({ outcome: 'unreachable' });
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
  });

  it('a failed durable wipe → "wipe-failed" with the error, NO revoke attempted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockStorage = createStorage({ [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc' });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    // After install, reject ONLY the custody wipe write (the write carrying the
    // device-token key) — the pre-wipe read still needs its own writes to work.
    (globalThis as { browser: { storage: { local: { set: unknown } } } }).browser.storage.local.set =
      vi.fn(async (items: Record<string, unknown>) => {
        if (Object.prototype.hasOwnProperty.call(items, AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY)) {
          throw new Error('storage write failed');
        }
        Object.assign(mockStorage, items);
      });
    const response = await send({ type: 'signOutAgencyHub' });
    expect(response).toMatchObject({ outcome: 'wipe-failed' });
    expect((response as { error?: string }).error).toContain('storage write failed');
    expect(agencyHubClient.revokeDeviceToken).not.toHaveBeenCalled(); // wipe threw first
  });

  it('writes ONLY the two custody keys, never the settings blob — a concurrent blob write survives', async () => {
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc',
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: 'legacy-key',
      settings: { ...createDefaultSettings(), uiTheme: 'dark' },
    });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(async () => 'revoked' as const),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });

    const setCalls: Array<Record<string, unknown>> = [];
    const browserRef = (globalThis as {
      browser: { storage: { local: { set: (items: Record<string, unknown>) => Promise<void> } } };
    }).browser;
    const realSet = browserRef.storage.local.set;
    browserRef.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
      setCalls.push(items);
      // A parallel tab commits a uiTheme change during the wipe write. With a
      // custody-only write it survives; a blob rewrite would clobber it.
      (mockStorage.settings as Record<string, unknown>).uiTheme = 'light';
      return realSet(items);
    });

    await send({ type: 'signOutAgencyHub' });

    const wipe = setCalls.find((call) => AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY in call);
    expect(wipe).toBeDefined();
    expect(Object.keys(wipe!).sort()).toEqual(
      [AGENCY_HUB_API_KEY_STORAGE_KEY, AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY].sort(),
    );
    // No set call in the whole sign-out rewrote the settings blob…
    expect(setCalls.some((call) => 'settings' in call)).toBe(false);
    // …so the concurrent uiTheme write survived, and custody is empty.
    expect((mockStorage.settings as Record<string, unknown>).uiTheme).toBe('light');
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
    expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');
  });

  it('serializes a concurrent sign-in behind a held sign-out — no interleaving (auth FIFO)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_old',
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub.example' },
    });
    const revoke = createDeferred<'revoked'>();
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      // Held open → the sign-out stays inside its critical section.
      revokeDeviceToken: vi.fn(
        async (
          _settings: { agencyHubBaseUrl: string; agencyHubDeviceToken: string },
          _signal: AbortSignal,
        ) => revoke.promise,
      ),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });

    // Observe (and fail fast) the sign-in's first network op without a real hub.
    let loginAttempted = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      loginAttempted = true;
      throw new Error('network');
    }));

    try {
      // Sign-out acquires the lock; the sign-in is dispatched while it is held.
      const signOut = send({ type: 'signOutAgencyHub' });
      const signIn = send({
        type: 'issueAgencyHubDeviceToken',
        baseUrl: 'https://hub.example',
        username: 'u',
        password: 'p',
      });

      // The sign-out wiped custody and parked on the held revoke; the sign-in is
      // queued behind it and has NOT begun (no login attempt yet).
      await vi.waitFor(() => expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe(''));
      expect(loginAttempted).toBe(false);

      // Release the sign-out; only now may the sign-in enter its critical section.
      revoke.resolve('revoked');
      expect(await signOut).toEqual({ outcome: 'revoked' });
      await signIn;
      expect(loginAttempted).toBe(true);

      // Invariant: the sign-out ran fully (old token wiped locally AND revoked
      // remotely) BEFORE the sign-in began, so there is no interleaving where a
      // freshly issued token is wiped locally while a stale one is revoked.
      expect(agencyHubClient.revokeDeviceToken).toHaveBeenCalledTimes(1);
      const [passed] = agencyHubClient.revokeDeviceToken.mock.calls[0]!;
      expect(passed.agencyHubDeviceToken).toBe('agency_hub_device_old');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('runtime-api getAgencyHubDeviceTokenMeta', () => {
  const fanslyClient = { getAuthenticatedAccount: vi.fn(async () => undefined) };
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('returns the stored v1 record', async () => {
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: {
        version: 1, keyPrefix: 'abc123', issuedAt: 42, expiresAt: '2026-08-01T00:00:00.000Z',
      },
    });
    const { send } = await installRuntimeApiHarness(fanslyClient);
    expect(await send({ type: 'getAgencyHubDeviceTokenMeta' })).toEqual({
      version: 1, keyPrefix: 'abc123', issuedAt: 42, expiresAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it('returns null for an absent or foreign-version record', async () => {
    mockStorage = createStorage();
    const absent = await installRuntimeApiHarness(fanslyClient);
    expect(await absent.send({ type: 'getAgencyHubDeviceTokenMeta' })).toBeNull();

    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY]: { version: 2, keyPrefix: 'x' },
    });
    const foreign = await installRuntimeApiHarness(fanslyClient);
    expect(await foreign.send({ type: 'getAgencyHubDeviceTokenMeta' })).toBeNull();
  });
});

describe('runtime-api agency hub reads', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('answers getAgencyHubHealth from the stored settings', async () => {
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub.example' },
    });
    const checkHealth = vi.fn(async () => ({
      ok: true, status: 'ok', dbLatencyMs: 9, contractHash: 'h', sdkContractHash: 'h', sdkSourceCommit: 'c',
    }));
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn() },
      { agencyHubClient: { testConnection: vi.fn(), checkHealth, checkIdentity: vi.fn() } },
    );
    const result = await harness.send({ type: 'getAgencyHubHealth' });
    expect(result).toMatchObject({ ok: true, status: 'ok' });
    expect(checkHealth).toHaveBeenCalledWith(
      expect.objectContaining({ agencyHubBaseUrl: 'https://hub.example' }),
      expect.any(AbortSignal),
    );
  });

  it('answers getAgencyHubIdentity from the stored settings', async () => {
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub.example' },
    });
    const checkIdentity = vi.fn(async () => ({
      ok: true, username: 'lilly', role: 'chatter', pages: ['Lilly'],
    }));
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn() },
      { agencyHubClient: { testConnection: vi.fn(), checkHealth: vi.fn(), checkIdentity } },
    );
    const result = await harness.send({ type: 'getAgencyHubIdentity' });
    expect(result).toMatchObject({ ok: true, username: 'lilly', role: 'chatter', pages: ['Lilly'] });
    expect(checkIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ agencyHubBaseUrl: 'https://hub.example' }),
      expect.any(AbortSignal),
    );
  });

  it('reads a FRESH hub snapshot, not the stale coordinator cache, after a delayed onChanged', async () => {
    // A save landed hub B in storage, but its storage.onChanged has not yet
    // reached the coordinator, so the cache still holds hub A. The status
    // handler must probe the just-saved hub B (fresh read), not the previous hub.
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub-a.example' },
    });
    const checkHealth = vi.fn(async () => ({
      ok: true, status: 'ok', dbLatencyMs: 1, contractHash: 'h', sdkContractHash: 'h', sdkSourceCommit: 'c',
    }));
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn() },
      { agencyHubClient: { testConnection: vi.fn(), checkHealth, checkIdentity: vi.fn() } },
    );
    // Prime the coordinator cache with hub A.
    await (harness.storageCoordinator as unknown as { getState: () => Promise<unknown> }).getState();
    // The save is now durable in storage (hub B) but its onChanged is NOT applied
    // to the coordinator — the cache is deliberately left stale at hub A.
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub-b.example' },
    });

    await harness.send({ type: 'getAgencyHubHealth' });
    expect(checkHealth).toHaveBeenCalledWith(
      expect.objectContaining({ agencyHubBaseUrl: 'https://hub-b.example' }),
      expect.any(AbortSignal),
    );
  });
});

describe('runtime-api getAiQuotaByPage', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('returns the full same-day per-page quota map', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    // The harness resetModules()-loads the tracker the handler reads; import the
    // SAME post-reset instance to seed it.
    const { recordQuotaSnapshot } = await import('../src/background/quota-tracker.js');
    await recordQuotaSnapshot('lilly', 143);
    await recordQuotaSnapshot('ari', 4);

    const result = await harness.send({ type: 'getAiQuotaByPage' }) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['ari', 'lilly']);
    expect(result.ari).toMatchObject({ remainingRequestsToday: 4, exhausted: false });
  });
});

describe('runtime-api getOpsDaily', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('returns today’s counters recorded by the ops-daily tracker', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    const { recordGeneration, recordHubError } = await import('../src/background/ops-daily.js');
    await recordHubError('CG-HUB-04');
    await recordGeneration({
      feature: 'fast-reply', accountId: 'acc-1', accountLabel: 'lora', pageLabel: 'lora-1',
    });

    const result = await harness.send({ type: 'getOpsDaily' });
    expect(result).toMatchObject({
      version: 1,
      hubErrorsTotal: 1,
      pageByAccount: { 'acc-1': 'lora-1' },
    });
  });
});

describe('runtime-api onboarding flag', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('reads «not dismissed yet» for an absent or foreign-version record', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });

    expect(await harness.send({ type: 'getOnboardingState' }))
      .toEqual({ version: 1, dismissedAt: null });

    // A record from a future/foreign shape is not half-trusted.
    mockStorage[ONBOARDING_STORAGE_KEY] = { version: 2, dismissedAt: 111 };
    expect(await harness.send({ type: 'getOnboardingState' }))
      .toEqual({ version: 1, dismissedAt: null });
  });

  it('stamps the flag once and keeps the FIRST timestamp afterwards', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });

    expect(await harness.send({ type: 'dismissOnboarding' })).toEqual({ ok: true });
    const first = (mockStorage[ONBOARDING_STORAGE_KEY] as { dismissedAt: number }).dismissedAt;
    expect(typeof first).toBe('number');

    expect(await harness.send({ type: 'dismissOnboarding' })).toEqual({ ok: true });
    // A second call (another settings tab, a reload) must not move the date the
    // install actually finished setup.
    expect((mockStorage[ONBOARDING_STORAGE_KEY] as { dismissedAt: number }).dismissedAt)
      .toBe(first);
    // …and the read reports it.
    expect(await harness.send({ type: 'getOnboardingState' }))
      .toEqual({ version: 1, dismissedAt: first });
  });

  it('serializes two concurrent stamps into one record', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });

    const [a, b] = await Promise.all([
      harness.send({ type: 'dismissOnboarding' }),
      harness.send({ type: 'dismissOnboarding' }),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    // The FIFO queue means the second read-modify-write saw the first stamp, so
    // exactly one write landed.
    const writes = (browser.storage.local.set as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([items]) => ONBOARDING_STORAGE_KEY in (items as Record<string, unknown>));
    expect(writes).toHaveLength(1);
  });

  it('reports a failed write instead of pretending onboarding is over', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    (browser.storage.local.set as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('quota'));

    expect(await harness.send({ type: 'dismissOnboarding' })).toEqual({ ok: false });
    expect(mockStorage[ONBOARDING_STORAGE_KEY]).toBeUndefined();
  });
});

describe('runtime-api openOptions', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('re-points the ALREADY OPEN settings tab and raises its window', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    harness.tabsQuery.mockResolvedValueOnce([
      { id: 41, url: 'moz-extension://cg-test-uuid/options.html#generation' },
    ]);
    harness.tabsGet.mockResolvedValueOnce({ id: 41, windowId: 5 } as never);

    const result = await harness.send({
      type: 'openOptions',
      pane: 'hub',
      code: 'CG-HUB-04',
    });

    expect(result).toEqual({ opened: true, reused: true });
    // The query has to be a prefix match: the hash is not part of a match
    // pattern, so the open tab is found whatever pane it is showing.
    expect(harness.tabsQuery).toHaveBeenCalledWith({
      url: 'moz-extension://cg-test-uuid/options.html*',
    });
    expect(harness.tabsUpdate).toHaveBeenCalledWith(41, {
      active: true,
      url: 'moz-extension://cg-test-uuid/options.html#hub:CG-HUB-04',
    });
    expect(harness.windowsUpdate).toHaveBeenCalledWith(5, { focused: true });
    // A SECOND options tab would be a second pagehide settings writer.
    expect(harness.tabsCreate).not.toHaveBeenCalled();
  });

  it('hops through the bare pane when the open tab already shows the same deep link (BL-006)', async () => {
    // The same hash twice fires no hashchange, so the page could never re-arm
    // its highlight. A hop to `#hub` first makes the deep link a real change.
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    harness.tabsQuery.mockResolvedValueOnce([
      { id: 41, url: 'moz-extension://cg-test-uuid/options.html#hub:CG-HUB-04' },
    ]);
    harness.tabsGet.mockResolvedValueOnce({ id: 41, windowId: 5 } as never);

    const result = await harness.send({ type: 'openOptions', pane: 'hub', code: 'CG-HUB-04' });

    expect(result).toEqual({ opened: true, reused: true });
    expect(harness.tabsUpdate.mock.calls).toEqual([
      [41, { url: 'moz-extension://cg-test-uuid/options.html#hub' }],
      [41, { active: true, url: 'moz-extension://cg-test-uuid/options.html#hub:CG-HUB-04' }],
    ]);
    expect(harness.tabsCreate).not.toHaveBeenCalled();
  });

  it('does not hop when the tab already shows the bare pane it is sent to', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    harness.tabsQuery.mockResolvedValueOnce([
      { id: 41, url: 'moz-extension://cg-test-uuid/options.html#hub' },
    ]);
    harness.tabsGet.mockResolvedValueOnce({ id: 41, windowId: 5 } as never);

    await harness.send({ type: 'openOptions', pane: 'hub' });

    expect(harness.tabsUpdate).toHaveBeenCalledTimes(1);
    expect(harness.tabsUpdate).toHaveBeenCalledWith(41, {
      active: true,
      url: 'moz-extension://cg-test-uuid/options.html#hub',
    });
  });

  it('opens one tab when none is open, and drops an unusable code', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });

    const result = await harness.send({
      type: 'openOptions',
      pane: 'accounts',
      code: '<script>',
    });

    expect(result).toEqual({ opened: true, reused: false });
    // The hash grammar refuses the junk code and keeps the pane.
    expect(harness.tabsCreate).toHaveBeenCalledWith({
      url: 'moz-extension://cg-test-uuid/options.html#accounts',
    });
  });

  it('falls back to creating a tab when the open one disappeared mid-flight', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    harness.tabsQuery.mockResolvedValueOnce([{ id: 41 }]);
    harness.tabsUpdate.mockRejectedValueOnce(new Error('No tab with id: 41'));

    expect(await harness.send({ type: 'openOptions', pane: 'status' }))
      .toEqual({ opened: true, reused: false });
    expect(harness.tabsCreate).toHaveBeenCalledWith({
      url: 'moz-extension://cg-test-uuid/options.html#status',
    });
  });

  it('reports honestly when the browser refuses to open anything', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    harness.tabsCreate.mockRejectedValueOnce(new Error('denied'));

    expect(await harness.send({ type: 'openOptions', pane: 'status' }))
      .toEqual({ opened: false, reused: false });
  });

  it('serializes concurrent requests into ONE tab (double-clicked Settings)', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    // The browser's own truth: the tab is queryable only after tabs.create
    // resolved. Without the lock both requests see «no tab» at the query await
    // and both create one — two options tabs, two pagehide settings writers.
    const openTabs: Array<{ id: number; url?: string }> = [];
    harness.tabsQuery.mockImplementation(async () => [...openTabs]);
    harness.tabsCreate.mockImplementation(async (info: { url: string }) => {
      openTabs.push({ id: 41, url: info.url });
      return { id: 41 };
    });
    harness.tabsGet.mockResolvedValue({ id: 41, windowId: 5 } as never);

    const [first, second] = await Promise.all([
      harness.send({ type: 'openOptions', pane: 'status' }),
      harness.send({ type: 'openOptions', pane: 'hub', code: 'CG-HUB-04' }),
    ]);

    expect(harness.tabsCreate).toHaveBeenCalledTimes(1);
    expect(first).toEqual({ opened: true, reused: false });
    // The second request found the first one's tab and re-pointed it.
    expect(second).toEqual({ opened: true, reused: true });
    expect(harness.tabsUpdate).toHaveBeenCalledWith(41, {
      active: true,
      url: 'moz-extension://cg-test-uuid/options.html#hub:CG-HUB-04',
    });
  });

  it('pins the deep-link page path to the manifest options_ui.page', async () => {
    mockStorage = createStorage();
    await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    // One fact in two files. A drift here does not throw: `tabs.query` simply
    // stops matching the open settings tab, and the singleton silently degrades
    // to always-create — the exact failure the reuse path exists to prevent.
    const { OPTIONS_PAGE_PATH } = await import('../src/background/runtime-api.js');
    expect(OPTIONS_PAGE_PATH).toBe(manifest.options_ui.page);
  });
});

describe('runtime-api last-seen version', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('reads «none seen» for an absent or foreign-version record', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });

    expect(await harness.send({ type: 'getLastSeenVersion' }))
      .toEqual({ version: 1, lastSeenVersion: null });

    mockStorage[LAST_SEEN_VERSION_STORAGE_KEY] = { version: 7, lastSeenVersion: '9.9.9' };
    expect(await harness.send({ type: 'getLastSeenVersion' }))
      .toEqual({ version: 1, lastSeenVersion: null });
  });

  it('records the version the page marked as seen and reads it back', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });

    expect(await harness.send({ type: 'setLastSeenVersion', version: ' 2.0.0 ' }))
      .toEqual({ ok: true });
    expect(mockStorage[LAST_SEEN_VERSION_STORAGE_KEY])
      .toEqual({ version: 1, lastSeenVersion: '2.0.0' });
    expect(await harness.send({ type: 'getLastSeenVersion' }))
      .toEqual({ version: 1, lastSeenVersion: '2.0.0' });
  });

  it('reports a failed write so the dot can stay on', async () => {
    mockStorage = createStorage();
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    (browser.storage.local.set as unknown as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('quota'));

    expect(await harness.send({ type: 'setLastSeenVersion', version: '2.0.0' }))
      .toEqual({ ok: false });
    expect(mockStorage[LAST_SEEN_VERSION_STORAGE_KEY]).toBeUndefined();
  });
});

describe('runtime-api getSpendersStatus', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('returns the freshest observation recorded under the CURRENT hub+credential', async () => {
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub', agencyHubDeviceToken: 'tok' },
    });
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    // Same post-reset instance the handler reads.
    const { recordSpendersObservation, spendersObservationScope: scopeOf } =
      await import('../src/background/spenders-status-tracker.js');
    const sourceIdentity = `creator-1|${scopeOf('https://hub', 'tok')}`;
    await recordSpendersObservation({ sourceIdentity, streamState: 'ramped', outcome: 'ok' });

    const result = await harness.send({ type: 'getSpendersStatus' });
    expect(result).toMatchObject({ sourceIdentity, outcome: 'ok', streamState: 'ramped' });
  });

  it('returns null for an observation recorded under a previous hub (hub changed)', async () => {
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub-b', agencyHubDeviceToken: 'tok' },
    });
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    const { recordSpendersObservation, spendersObservationScope: scopeOf } =
      await import('../src/background/spenders-status-tracker.js');
    // Observed under hub A; the settings now point at hub B.
    await recordSpendersObservation({
      sourceIdentity: `creator-1|${scopeOf('https://hub-a', 'tok')}`,
      streamState: 'ramped',
      outcome: 'ok',
    });
    expect(await harness.send({ type: 'getSpendersStatus' })).toBeNull();
  });

  it('returns null for an observation recorded under a previous credential (same URL)', async () => {
    // A same-URL credential swap must hide the previous principal's board.
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub', agencyHubDeviceToken: 'new-tok' },
    });
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    const { recordSpendersObservation, spendersObservationScope: scopeOf } =
      await import('../src/background/spenders-status-tracker.js');
    await recordSpendersObservation({
      sourceIdentity: `creator-1|${scopeOf('https://hub', 'old-tok')}`,
      streamState: 'ramped',
      outcome: 'ok',
    });
    expect(await harness.send({ type: 'getSpendersStatus' })).toBeNull();
  });

  it('returns null when no board has been observed', async () => {
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub', agencyHubDeviceToken: 'tok' },
    });
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    expect(await harness.send({ type: 'getSpendersStatus' })).toBeNull();
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

  it('aborts a timed-out build with the timeout reason so the wrapper records a FAIL', async () => {
    vi.useFakeTimers();
    try {
      let captured: AbortSignal | undefined;
      const spendersService = {
        getList: vi.fn((_session: unknown, signal: AbortSignal) => new Promise((_resolve, reject) => {
          captured = signal;
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        })),
      };
      const { sessionStore, send } = await installRuntimeApiHarness(
        { getAuthenticatedAccount: vi.fn() },
        { spendersService },
      );
      sessionStore.registerCapture(7, makeCapture('creator-1'));

      const pending = send({ type: 'getSpendersList' }, { tab: { id: 7 } });
      await Promise.resolve(); // let the handler invoke getList
      expect(captured?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(SPENDERS_BUILD_TIMEOUT_MS);
      // The build-timeout handler aborts with a real AbortError DOMException whose
      // MESSAGE carries the reason so the getList wrapper can tell a real timeout
      // (record FAIL) from a user-cancel / superseded build (skip), and so an
      // aborted fetch rejects with an AbortError instead of a bare string.
      expect(captured?.reason).toBeInstanceOf(DOMException);
      expect((captured?.reason as DOMException).name).toBe('AbortError');
      expect((captured?.reason as DOMException).message).toBe(SPENDERS_BUILD_TIMEOUT_REASON);
      await expect(pending).resolves.toEqual({ ok: false, error: createUserError('timed_out') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a FAIL and returns timed_out when a real build times out mid-fetch (refresh path)', async () => {
    // Integration: the abort fires DURING an in-flight kernel fetch on the
    // refresh path. The user must get an honest timed_out AND the board must
    // record a FAIL observation (so the Статус row stops showing a stale RAMPED).
    vi.useFakeTimers();
    try {
      // A kernel fetch that hangs until aborted → the build cannot finish before
      // the runtime build-timeout fires.
      const kernelSource = {
        resolvePageLabelForUsername: vi.fn(async () => 'creator-fs'),
        fetchTopSpenders: vi.fn((_s: unknown, _p: string, _w: string, _l: number, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
          })),
      };
      const fanslyClient = {
        getAuthenticatedAccount: vi.fn(),
        listFanAccounts: vi.fn(async () => ({ fans: [], truncated: false })),
        getAccountNames: vi.fn(async () => []),
      };
      const settings = {
        ...createDefaultSettings(),
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'hub-key',
      };
      const service = new SpendersService(
        fanslyClient as never,
        kernelSource as never,
        async () => settings,
      );
      const harness = await installRuntimeApiHarness(
        fanslyClient,
        { spendersService: service as unknown as { getList: ReturnType<typeof vi.fn> } },
      );
      harness.sessionStore.registerCapture(7, makeCapture('creator-1'));

      const pending = harness.send({ type: 'getSpendersList', refresh: true }, { tab: { id: 7 } });
      await vi.advanceTimersByTimeAsync(SPENDERS_BUILD_TIMEOUT_MS);

      // The user sees an honest timeout…
      await expect(pending).resolves.toEqual({ ok: false, error: createUserError('timed_out') });
      // …and a FAIL observation is recorded under the CURRENT hub+credential.
      const scope = spendersObservationScope(
        normalizeAgencyHubBaseUrl('http://localhost:3000'),
        'hub-key',
      );
      const observations = Object.values(
        (harness.sessionBacking.spendersObservations ?? {}) as Record<
          string,
          { outcome: string; sourceIdentity: string }
        >,
      );
      expect(observations.some(
        (observation) => observation.outcome === 'fail' && observation.sourceIdentity.endsWith(`|${scope}`),
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
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

describe('runtime-api accounts view', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  const resolvedAccount = (id: string, username: string, displayName: string) =>
    vi.fn(async (session: SessionTemplate) => {
      session.resolvedAccountId = id;
      session.resolvedUsername = username;
      session.resolvedDisplayName = displayName;
      return { id, username, displayName };
    });

  it('classifies live / seen / never and never invents a tab for a restarted worker', async () => {
    mockStorage = createStorage({
      knownAccounts: ['acc-live', 'acc-never'],
      'chatgoose:accountPresence': {
        version: 1,
        byAccount: {
          'acc-live': { lastSeenAt: 900, username: 'lora', displayName: 'Lora' },
          'acc-seen': { lastSeenAt: 500, username: 'mika', displayName: 'Mika' },
        },
      },
      'chatgoose:accountLabels': { version: 1, byAccount: { 'acc-seen': 'Мика · вечер' } },
    });
    const harness = await installRuntimeApiHarness({
      getAuthenticatedAccount: resolvedAccount('acc-live', 'lora', 'Lora'),
    });
    harness.sessionStore.registerCapture(31, makeCapture('acc-live'));
    // Two fansly.com tabs are open, but only one is attributable to a session.
    harness.tabsQuery.mockResolvedValue([{ id: 31 }, { id: 32 }]);

    const view = await harness.send({ type: 'getAccountsView' }) as {
      accounts: Array<Record<string, unknown>>;
      unattributedFanslyTabs: number;
    };

    expect(view.accounts.map((entry) => [entry.accountId, entry.state])).toEqual([
      ['acc-live', 'live'],
      ['acc-seen', 'seen'],
      ['acc-never', 'never'],
    ]);
    // A tab id exists ONLY for the live row.
    expect(view.accounts.map((entry) => entry.tabId)).toEqual([31, null, null]);
    // The chatter's own label beats the model's public name.
    expect(view.accounts[1]).toMatchObject({ localLabel: 'Мика · вечер', label: 'Мика · вечер' });
    // The unattributed tab is reported as an AGGREGATE, never as a row.
    expect(view.unattributedFanslyTabs).toBe(1);
  });

  it('counts every captured tab as attributed, not one tab per row', async () => {
    mockStorage = createStorage({ knownAccounts: ['acc-live'] });
    const harness = await installRuntimeApiHarness({
      getAuthenticatedAccount: resolvedAccount('acc-live', 'lora', 'Lora'),
    });
    // ONE account, TWO captured tabs (a second chat window). A row can only
    // carry one tab id, so a set built from the rows would call tab 32
    // unattributed and tell the chatter «открой чат, и строка оживёт» about a
    // chat that is already open.
    harness.sessionStore.registerCapture(31, makeCapture('acc-live'));
    harness.sessionStore.registerCapture(32, makeCapture('acc-live'));
    harness.tabsQuery.mockResolvedValue([{ id: 31 }, { id: 32 }, { id: 99 }]);

    const view = await harness.send({ type: 'getAccountsView' }) as {
      accounts: Array<{ accountId: string; state: string }>;
      unattributedFanslyTabs: number;
    };

    expect(view.accounts.map((entry) => [entry.accountId, entry.state])).toEqual([
      ['acc-live', 'live'],
    ]);
    // Only the foreign tab is genuinely unattributed.
    expect(view.unattributedFanslyTabs).toBe(1);
  });

  it('reads the mappings FRESH, so a just-assigned persona is not reported as unmapped', async () => {
    // storage.local.set resolves before storage.onChanged refreshes the
    // coordinator cache, so the pane can call getAccountsView while that cache
    // still predates the write it just made.
    const settings = {
      ...createDefaultSettings(),
      agencyHubBaseUrl: 'https://hub.example.test',
      agencyHubDeviceToken: 'device-x',
    };
    const personaCatalog = [
      {
        key: 'p-active',
        displayName: 'Closer',
        definitionId: 'v1:persona-active-definition',
        version: 1,
        status: 'active',
      },
    ];
    mockStorage = createStorage({
      settings,
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'device-x',
      knownAccounts: ['acc-1'],
      // No mapping yet: this is the snapshot the coordinator cached.
      accountMappings: {},
      personaCatalog,
      personaCatalogSource: personaCatalogSource(settings),
      personaCatalogFetchedAt: '2026-07-25T00:00:00.000Z',
    });
    const staleState = structuredClone(mockStorage);
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn(async () => undefined) },
      {
        storageCoordinator: {
          ensurePersistedState: vi.fn(async () => staleState),
          getState: vi.fn(async () => staleState),
        },
      },
    );

    // The options page assigns the persona; the coordinator cache still says {}.
    mockStorage.accountMappings = { 'acc-1': 'p-active' };

    const view = await harness.send({ type: 'getAccountsView' }) as {
      accounts: Array<{ accountId: string; personaMapped: boolean }>;
    };

    // Answering from the cache would paint a false amber «AI отключён» until the
    // next poll.
    expect(view.accounts).toEqual([
      expect.objectContaining({ accountId: 'acc-1', personaMapped: true }),
    ]);
    expect(
      (staleState as { accountMappings: Record<string, string> }).accountMappings,
    ).toEqual({});
  });

  it('treats an archived mapping as unmapped — an archived persona cannot generate', async () => {
    // The catalog is fenced to the credentials it was fetched for (E37), so the
    // stored source has to match or the whole catalog reads as absent.
    const settings = {
      ...createDefaultSettings(),
      agencyHubBaseUrl: 'https://hub.example.test',
      agencyHubDeviceToken: 'device-x',
    };
    mockStorage = createStorage({
      settings,
      // v15 custody layout: the token lives in its own key, and that is what the
      // catalog source is derived from.
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'device-x',
      knownAccounts: ['acc-active', 'acc-archived'],
      accountMappings: { 'acc-active': 'p-active', 'acc-archived': 'p-old' },
      personaCatalog: [
        {
          key: 'p-active',
          displayName: 'Closer',
          definitionId: 'v1:persona-active-definition',
          version: 1,
          status: 'active',
        },
        {
          key: 'p-old',
          displayName: 'Old',
          definitionId: 'v1:persona-archived-definition',
          version: 1,
          status: 'archived',
        },
      ],
      personaCatalogSource: personaCatalogSource(settings),
      personaCatalogFetchedAt: '2026-07-25T00:00:00.000Z',
    });
    const harness = await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => undefined),
    });

    const view = await harness.send({ type: 'getAccountsView' }) as {
      accounts: Array<{ accountId: string; personaMapped: boolean }>;
    };

    expect(
      Object.fromEntries(view.accounts.map((entry) => [entry.accountId, entry.personaMapped])),
    ).toEqual({ 'acc-active': true, 'acc-archived': false });
  });

  it('carries the observed kernel page from the day’s ops counters', async () => {
    mockStorage = createStorage({
      knownAccounts: ['acc-1'],
      'chatgoose:opsDaily': {
        version: 1,
        dateUtc: new Date().toISOString().slice(0, 10),
        hubErrors: [],
        hubErrorsTotal: 0,
        lastGeneration: null,
        pageByAccount: { 'acc-1': 'lora-1' },
        lastSummaryPush: null,
      },
    });
    const harness = await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => undefined),
    });

    const view = await harness.send({ type: 'getAccountsView' }) as {
      accounts: Array<{ accountId: string; observedPage: string | null }>;
    };

    expect(view.accounts[0]).toMatchObject({ accountId: 'acc-1', observedPage: 'lora-1' });
  });

  it('focuses a live account’s tab AND raises its window', async () => {
    mockStorage = createStorage({ knownAccounts: ['acc-live'] });
    const harness = await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => undefined),
    });
    harness.sessionStore.registerCapture(44, makeCapture('acc-live'));
    harness.tabsGet.mockResolvedValue({ id: 44, windowId: 9 } as never);

    await expect(harness.send({ type: 'focusAccountTab', accountId: 'acc-live' }))
      .resolves.toEqual({ ok: true });

    expect(harness.tabsUpdate).toHaveBeenCalledWith(44, { active: true });
    // Activating a tab in a background window leaves it invisible — the window
    // has to be raised too or «к вкладке» does nothing visible.
    expect(harness.windowsUpdate).toHaveBeenCalledWith(9, { focused: true });
  });

  it('refuses to focus an account with no live session instead of guessing a tab', async () => {
    mockStorage = createStorage({ knownAccounts: ['acc-seen'] });
    const harness = await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => undefined),
    });

    await expect(harness.send({ type: 'focusAccountTab', accountId: 'acc-seen' }))
      .resolves.toEqual({ ok: false });
    expect(harness.tabsUpdate).not.toHaveBeenCalled();
    expect(harness.windowsUpdate).not.toHaveBeenCalled();
  });

  it('writes a local label only through setAccountLabel, and rejects a blank account id', async () => {
    mockStorage = createStorage({ knownAccounts: ['acc-1'] });
    const harness = await installRuntimeApiHarness({
      getAuthenticatedAccount: vi.fn(async () => undefined),
    });

    await expect(
      harness.send({ type: 'setAccountLabel', accountId: 'acc-1', label: '  Лора  ' }),
    ).resolves.toEqual({ ok: true });
    expect(mockStorage['chatgoose:accountLabels']).toEqual({
      version: 1,
      byAccount: { 'acc-1': 'Лора' },
    });

    // An unroutable request is dropped by the protocol guard, not half-applied.
    expect(
      harness.send({ type: 'setAccountLabel', accountId: '   ', label: 'x' }),
    ).toBeUndefined();
    // The settings blob is untouched by any of this: labels are operational.
    expect((mockStorage.settings as Record<string, unknown>).accountLabels).toBeUndefined();
  });
});
