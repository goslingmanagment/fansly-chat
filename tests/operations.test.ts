import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import type { NormalizedTranscriptMessage } from '../src/shared/types.js';

let mockStorage: Record<string, unknown> = {};

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

describe('OperationCoordinator', () => {
  beforeEach(() => {
    vi.resetModules();
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: {
        claudeApiKey: 'sk-test',
        quickMessageCount: 100,
        deepMessageCount: 500,
        debugMode: false,
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

  it('removes the durable summary cache before a forced fan-summary refresh', async () => {
    const [{ OperationCoordinator }, { SessionStore }, { TabContextStore }] = await Promise.all([
      import('../src/background/operations.js'),
      import('../src/background/session-store.js'),
      import('../src/background/tab-context.js'),
    ]);

    const sessionStore = new SessionStore();
    sessionStore.registerCapture(1, {
      accountId: 'account-1',
      authorization: 'Bearer token',
      fanslyClientId: 'client-id',
      fanslySessionId: 'session-id',
      fanslyClientTs: '123',
      fanslyClientCheck: 'route-check',
      routeKey: 'group',
    });

    const fanslyClient = {
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
      getEarnings: vi.fn(async () => null),
      getFanSubscriptionContext: vi.fn(async () => null),
    };
    const anthropicClient = {
      streamMessage: vi.fn(async () => 'Fresh summary'),
    };

    const coordinator = new OperationCoordinator(
      sessionStore,
      new TabContextStore(),
      fanslyClient as never,
      anthropicClient as never,
    ) as any;
    const port = { postMessage: vi.fn() };

    coordinator.portsByTabId.set(1, port);

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
});
