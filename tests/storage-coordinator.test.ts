import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

let mockStorage: Record<string, unknown> = {};

function createStorage(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: createDefaultSettings(),
    personalities: [{ id: 'p1', name: 'Closer', content: 'be nice', updatedAt: 1 }],
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
    ...overrides,
  };
}

async function installStorageCoordinatorHarness(options?: {
  stallFirstSet?: boolean;
}) {
  vi.resetModules();

  let setCallCount = 0;
  let releaseFirstSet: (() => void) | null = null;
  const firstSetGate = new Promise<void>((resolve) => {
    releaseFirstSet = resolve;
  });

  const storageGet = vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
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
  });

  const storageSet = vi.fn(async (items: Record<string, unknown>) => {
    setCallCount += 1;
    if (options?.stallFirstSet && setCallCount === 1) {
      await firstSetGate;
    }
    Object.assign(mockStorage, items);
  });

  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: storageGet,
        set: storageSet,
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete mockStorage[key];
          }
        }),
      },
    },
  };

  const { StorageCoordinator } = await import('../src/background/storage-coordinator.js');
  return {
    coordinator: new StorageCoordinator(),
    storageGet,
    storageSet,
    releaseFirstSet: () => {
      releaseFirstSet?.();
    },
  };
}

describe('StorageCoordinator', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('serializes concurrent known-account registrations without dropping entries', async () => {
    mockStorage = createStorage();
    const { coordinator, storageSet, releaseFirstSet } =
      await installStorageCoordinatorHarness({ stallFirstSet: true });

    const firstWrite = coordinator.registerKnownAccount('b');
    const secondWrite = coordinator.registerKnownAccount('a');

    await vi.waitFor(() => {
      expect(storageSet).toHaveBeenCalledTimes(1);
    });

    releaseFirstSet();
    await Promise.all([firstWrite, secondWrite]);

    expect(storageSet).toHaveBeenCalledTimes(2);
    expect(mockStorage.knownAccounts).toEqual(['a', 'b']);
  });
});
