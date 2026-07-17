import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  SPENDERS_BUILD_TIMEOUT_MS,
  SPENDERS_BUILD_TIMEOUT_REASON,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import { createUserError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import { normalizeAgencyHubBaseUrl } from '../src/shared/agency-hub.js';
import { SpendersService } from '../src/background/spenders-service.js';
import { spendersObservationScope } from '../src/background/spenders-status-tracker.js';
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

async function installRuntimeApiHarness(fanslyClient: {
  getAuthenticatedAccount: (session: SessionTemplate, signal: AbortSignal) => Promise<unknown>;
}, options?: {
  agencyHubClient?: {
    testConnection: ReturnType<typeof vi.fn>;
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
        remove: vi.fn(async () => undefined),
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
    storageCoordinator,
    sessionBacking,
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

describe('runtime-api signOutAgencyHub', () => {
  const fanslyClient = { getAuthenticatedAccount: vi.fn(async () => undefined) };
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('wipes BOTH custody keys and reports "revoked" on a successful revoke', async () => {
    mockStorage = createStorage({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc',
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: 'legacy-key',
    });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(
        async (_settings: { agencyHubBaseUrl: string; agencyHubDeviceToken: string }, _signal: AbortSignal) =>
          'revoked' as const,
      ),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    const response = await send({ type: 'signOutAgencyHub' });
    expect(response).toEqual({ outcome: 'revoked' });
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe(''); // EMPTY, not removed
    expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('');
    // Revoke used the CAPTURED token (the stored copy is already wiped by now).
    expect(agencyHubClient.revokeDeviceToken).toHaveBeenCalledTimes(1);
    const [passedSettings] = agencyHubClient.revokeDeviceToken.mock.calls[0]!;
    expect(passedSettings.agencyHubDeviceToken).toBe('agency_hub_device_abc');
  });

  it('wipes BEFORE the revoke resolves: a deferred revoke still leaves storage wiped', async () => {
    // Background durability: the wipe must land even if the page closes mid-revoke.
    // Model that here by holding the revoke open and asserting the storage is
    // already wiped before it settles.
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

  it('maps a 401 revoke to "already-invalid" (still wiped)', async () => {
    mockStorage = createStorage({ [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc' });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(async () => 'already-invalid' as const),
    };
    const { send } = await installRuntimeApiHarness(fanslyClient, { agencyHubClient });
    expect(await send({ type: 'signOutAgencyHub' })).toEqual({ outcome: 'already-invalid' });
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('');
  });

  it('maps a thrown revoke to "unreachable" (already wiped)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockStorage = createStorage({ [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'agency_hub_device_abc' });
    const agencyHubClient = {
      testConnection: vi.fn(async () => ({ ok: true })),
      revokeDeviceToken: vi.fn(async () => { throw new Error('network down'); }),
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
    // device-token key) — the pre-wipe loadStorageState read still needs to
    // persist its legacy-persona snapshot, so a blanket throw is wrong.
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
});

describe('runtime-api agency hub reads', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('answers getAgencyHubHealth from the stored settings', async () => {
    mockStorage = createStorage({ settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub.example' } });
    const checkHealth = vi.fn(async () => ({ ok: true, status: 'ok', dbLatencyMs: 9, contractHash: 'h', sdkContractHash: 'h' }));
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn() },
      { agencyHubClient: { testConnection: vi.fn(), checkHealth, checkIdentity: vi.fn() } },
    );
    const result = await harness.send({ type: 'getAgencyHubHealth' });
    expect(result).toMatchObject({ ok: true, status: 'ok' });
    expect(checkHealth).toHaveBeenCalledWith(expect.objectContaining({ agencyHubBaseUrl: 'https://hub.example' }), expect.any(AbortSignal));
  });

  it('answers getAgencyHubIdentity from the stored settings', async () => {
    mockStorage = createStorage({ settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub.example' } });
    const checkIdentity = vi.fn(async () => ({ ok: true, username: 'lilly', role: 'chatter', pages: ['Lilly'] }));
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn() },
      { agencyHubClient: { testConnection: vi.fn(), checkHealth: vi.fn(), checkIdentity } },
    );
    const result = await harness.send({ type: 'getAgencyHubIdentity' });
    expect(result).toMatchObject({ ok: true, username: 'lilly', role: 'chatter', pages: ['Lilly'] });
    expect(checkIdentity).toHaveBeenCalledWith(expect.objectContaining({ agencyHubBaseUrl: 'https://hub.example' }), expect.any(AbortSignal));
  });

  it('reads a FRESH hub snapshot, not the stale coordinator cache, after a delayed onChanged', async () => {
    // Finding 2: a save landed hub B in storage, but its storage.onChanged has not
    // yet reached the coordinator, so the cache still holds hub A. The status
    // handler must probe the just-saved hub B (fresh read), not the previous hub.
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub-a.example' },
    });
    const checkHealth = vi.fn(async () => ({ ok: true, status: 'ok', dbLatencyMs: 1, contractHash: 'h', sdkContractHash: 'h' }));
    const harness = await installRuntimeApiHarness(
      { getAuthenticatedAccount: vi.fn() },
      { agencyHubClient: { testConnection: vi.fn(), checkHealth, checkIdentity: vi.fn() } },
    );
    // Prime the coordinator cache with hub A.
    await harness.storageCoordinator.getState();
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
    // SAME post-reset instance to seed its session-memory fallback (no
    // browser.storage.session in the test env).
    const { recordQuotaSnapshot } = await import('../src/background/quota-tracker.js');
    await recordQuotaSnapshot('lilly', 143);
    await recordQuotaSnapshot('ari', 4);

    const result = await harness.send({ type: 'getAiQuotaByPage' }) as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(['ari', 'lilly']);
    expect(result.ari).toMatchObject({ remainingRequestsToday: 4, exhausted: false });
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
    // Same post-reset instance the handler reads (no browser.storage.session
    // in the test env — the tracker uses its module-memory fallback).
    const { recordSpendersObservation, spendersObservationScope } =
      await import('../src/background/spenders-status-tracker.js');
    const sourceIdentity = `creator-1|${spendersObservationScope('https://hub', 'tok')}`;
    await recordSpendersObservation({ sourceIdentity, streamState: 'ramped', outcome: 'ok' });

    const result = await harness.send({ type: 'getSpendersStatus' });
    expect(result).toMatchObject({ sourceIdentity, outcome: 'ok', streamState: 'ramped' });
  });

  it('returns null for an observation recorded under a previous hub (hub changed)', async () => {
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub-b', agencyHubDeviceToken: 'tok' },
    });
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    const { recordSpendersObservation, spendersObservationScope } =
      await import('../src/background/spenders-status-tracker.js');
    // Observed under hub A; the settings now point at hub B.
    await recordSpendersObservation({
      sourceIdentity: `creator-1|${spendersObservationScope('https://hub-a', 'tok')}`,
      streamState: 'ramped',
      outcome: 'ok',
    });
    expect(await harness.send({ type: 'getSpendersStatus' })).toBeNull();
  });

  it('returns null for an observation recorded under a previous credential (same URL)', async () => {
    // Finding 5: a same-URL credential swap must hide the previous principal's board.
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://hub', agencyHubDeviceToken: 'new-tok' },
    });
    const harness = await installRuntimeApiHarness({ getAuthenticatedAccount: vi.fn() });
    const { recordSpendersObservation, spendersObservationScope } =
      await import('../src/background/spenders-status-tracker.js');
    await recordSpendersObservation({
      sourceIdentity: `creator-1|${spendersObservationScope('https://hub', 'old-tok')}`,
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
    // Finding 7 integration: the abort fires DURING an in-flight kernel fetch on
    // the refresh path. The user must get an honest timed_out AND the board must
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
      const scope = spendersObservationScope(normalizeAgencyHubBaseUrl('http://localhost:3000'), 'hub-key');
      const observations = Object.values(
        (harness.sessionBacking.spendersObservations ?? {}) as Record<string, { outcome: string; sourceIdentity: string }>,
      );
      expect(observations.some((o) => o.outcome === 'fail' && o.sourceIdentity.endsWith(`|${scope}`))).toBe(true);
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
