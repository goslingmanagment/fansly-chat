import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { createUserError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import type { SessionTemplate, SpendersBuildPayload } from '../src/shared/types.js';

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

async function installRuntimeApiHarness(fanslyClient: {
  getAuthenticatedAccount: (session: SessionTemplate, signal: AbortSignal) => Promise<unknown>;
}, options?: {
  agencyHubClient?: {
    testConnection: ReturnType<typeof vi.fn>;
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
  const storageCoordinator = new StorageCoordinator();
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
  registerRuntimeApi({
    agencyHubClient: agencyHubClient as never,
    fanslyClient: fanslyClient as never,
    sessionStore,
    spendersService: spendersService as never,
    tabContexts: new TabContextStore(),
    storageCoordinator,
    debugPrompts: debugPrompts as never,
    emitToTab: options?.emitToTab,
    onAgencyHubReady: options?.onAgencyHubReady,
  });

  if (!onMessageListener) {
    throw new Error('Runtime listener was not registered');
  }

  return {
    sessionStore,
    tabsQuery,
    tabsGet,
    tabsCreate,
    agencyHubClient,
    spendersService,
    debugPrompts,
    send: (message: unknown, sender?: MessageSenderLike) => onMessageListener!(message, sender),
  };
}

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
