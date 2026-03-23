import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { createUserError } from '../src/shared/errors.js';
import { createDefaultSettings } from '../src/shared/migrations.js';
import type { AgencyHubConnectionTestRequest, SessionTemplate } from '../src/shared/types.js';

let mockStorage: Record<string, unknown> = {};
let onMessageListener:
  | ((message: { type: string; tabId?: number; settings?: AgencyHubConnectionTestRequest['settings'] }) => Promise<unknown>)
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
}) {
  vi.resetModules();
  onMessageListener = undefined;

  const tabsQuery = vi.fn<() => Promise<Array<{ id: number; url?: string }>>>(
    async () => [],
  );
  const tabsGet = vi.fn<(tabId: number) => Promise<{ id: number; url?: string }>>(
    async (tabId: number) => ({ id: tabId, url: undefined }),
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
        addListener: vi.fn((listener: (message: { type: string; tabId?: number; settings?: AgencyHubConnectionTestRequest['settings'] }) => Promise<unknown>) => {
          onMessageListener = listener;
        }),
      },
    },
    tabs: {
      query: tabsQuery,
      get: tabsGet,
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
  registerRuntimeApi({
    agencyHubClient: agencyHubClient as never,
    fanslyClient: fanslyClient as never,
    sessionStore,
    tabContexts: new TabContextStore(),
    storageCoordinator,
  });

  if (!onMessageListener) {
    throw new Error('Runtime listener was not registered');
  }

  return { sessionStore, tabsQuery, tabsGet, agencyHubClient };
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
          code: 'GM-HUB-04',
          message: 'Agency Hub host permission is missing.',
        },
      })),
    };

    await installRuntimeApiHarness(fanslyClient, { agencyHubClient });

    const settings = {
      agencyHubBaseUrl: 'http://hub.test',
      agencyHubApiKey: 'hub-key',
    };
    const result = await onMessageListener?.({
      type: 'testAgencyHubConnection',
      settings,
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        key: 'hub_missing_permission',
        code: 'GM-HUB-04',
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
});
