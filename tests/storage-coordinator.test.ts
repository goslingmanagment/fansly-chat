import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY,
  PERSONA_CATALOG_SOURCE_STORAGE_KEY,
  PERSONA_CATALOG_STORAGE_KEY,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import { createDefaultSettings, stripSecretSettings } from '../src/shared/migrations.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import { createBundledPersonalities } from '../src/shared/personalities.js';
import type { Settings, SummaryCacheEntry } from '../src/shared/types.js';

let mockStorage: Record<string, unknown> = {};

function createStorage(overrides: Partial<Record<string, unknown>> = {}) {
  const [bundledLora] = createBundledPersonalities();
  const personalities = [
    { id: 'p1', name: 'Closer', content: 'be nice', updatedAt: 1 },
    ...(bundledLora ? [bundledLora] : []),
  ];
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: stripSecretSettings(createDefaultSettings()),
    [AGENCY_HUB_API_KEY_STORAGE_KEY]: '',
    [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: '',
    personalities,
    legacyPersonaSnapshotV1: {
      schemaVersion: 1,
      capturedAt: '2026-07-13T00:00:00.000Z',
      origin: {
        client: 'chatgoose-firefox-extension',
        extensionVersion: 'test',
        storageSchemaVersion: STORAGE_SCHEMA_VERSION,
        agencyHubBaseUrl: '',
        reason: 'global-personas-became-server-managed',
      },
      raw: {
        personalitiesPresent: true,
        personalities,
        accountMappingsPresent: true,
        accountMappings: {},
        accountAliasesPresent: true,
        accountAliases: {},
      },
    },
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
    ...overrides,
  };
}

async function installStorageCoordinatorHarness(options?: {
  stallFirstSet?: boolean;
  rejectFirstSet?: boolean;
  repairEventDelayTasks?: number;
  missFirstProbeEvent?: boolean;
  disableProbeEvents?: boolean;
  afterMissedFirstProbe?: () => void;
  stallFirstGet?: boolean;
  rejectFirstGet?: boolean;
}) {
  vi.resetModules();

  let setCallCount = 0;
  let releaseFirstSet: (() => void) | null = null;
  const firstSetGate = new Promise<void>((resolve) => {
    releaseFirstSet = resolve;
  });
  let releaseFirstGet: (() => void) | null = null;
  const firstGetGate = new Promise<void>((resolve) => {
    releaseFirstGet = resolve;
  });
  let fullGetCount = 0;
  let probeSetCount = 0;
  let probeEventsEnabled = !options?.disableProbeEvents;
  const operationLog: string[] = [];
  let emitStorageChanges: ((changes: Record<string, browser.storage.StorageChange>) => void) | null = null;

  const emitAfterTasks = (
    changes: Record<string, browser.storage.StorageChange>,
    remainingTasks: number,
  ): void => {
    if (remainingTasks <= 0) {
      emitStorageChanges?.(changes);
      return;
    }
    setTimeout(() => emitAfterTasks(changes, remainingTasks - 1), 0);
  };

  const storageGet = vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
    if (keys === null || keys === undefined) {
      fullGetCount += 1;
      const snapshot = { ...mockStorage };
      if (options?.rejectFirstGet && fullGetCount === 1) {
        throw new Error('initial storage read failed');
      }
      if (options?.stallFirstGet && fullGetCount === 1) {
        await firstGetGate;
      }
      return snapshot;
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
    operationLog.push('write');
    setCallCount += 1;
    if (options?.stallFirstSet && setCallCount === 1) {
      await firstSetGate;
    }
    if (options?.rejectFirstSet && setCallCount === 1) {
      throw new Error('startup storage repair failed');
    }
    Object.assign(mockStorage, items);
  });

  const rawStorageSet = vi.fn(async (items: Record<string, unknown>) => {
    const probeValue = items.__chatgooseStorageListenerProbeV1;
    if (typeof probeValue === 'string') {
      probeSetCount += 1;
      operationLog.push(`probe:${probeSetCount}`);
      Object.assign(mockStorage, items);
      if (options?.missFirstProbeEvent && probeSetCount === 1) {
        options.afterMissedFirstProbe?.();
      } else if (probeEventsEnabled) {
        setTimeout(() => {
          emitStorageChanges?.({
            __chatgooseStorageListenerProbeV1: { newValue: probeValue },
          });
        }, 0);
      }
      return;
    }
    const oldValues = Object.fromEntries(
      Object.keys(items).map((key) => [key, mockStorage[key]]),
    );
    await storageSet(items);
    const changes = Object.fromEntries(Object.entries(items).map(([key, newValue]) => [
      key,
      { oldValue: oldValues[key], newValue },
    ]));
    emitAfterTasks(
      changes,
      setCallCount === 1 ? (options?.repairEventDelayTasks ?? 0) : 0,
    );
  });

  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: storageGet,
        set: rawStorageSet,
        remove: vi.fn(async (keys: string | string[]) => {
          const normalizedKeys = Array.isArray(keys) ? keys : [keys];
          const changes: Record<string, browser.storage.StorageChange> = {};
          for (const key of normalizedKeys) {
            if (Object.prototype.hasOwnProperty.call(mockStorage, key)) {
              changes[key] = { oldValue: mockStorage[key], newValue: undefined };
            }
            delete mockStorage[key];
          }
          if (Object.keys(changes).length > 0) {
            emitStorageChanges?.(changes);
          }
        }),
      },
    },
  };

  const { StorageCoordinator } = await import('../src/background/storage-coordinator.js');
  const coordinator = new StorageCoordinator();
  emitStorageChanges = (changes) => coordinator.applyStorageChanges(changes, 'local');
  return {
    coordinator,
    storageGet,
    storageSet,
    probeSetCount: () => probeSetCount,
    operationLog,
    enableProbeEvents: () => {
      probeEventsEnabled = true;
    },
    releaseFirstSet: () => {
      releaseFirstSet?.();
    },
    releaseFirstGet: () => {
      releaseFirstGet?.();
    },
  };
}

describe('StorageCoordinator', () => {
  beforeEach(() => {
    mockStorage = {};
    vi.clearAllMocks();
  });

  it('passes the normal startup listener barrier with one probe and no repair write', async () => {
    mockStorage = createStorage();
    const { coordinator, operationLog, probeSetCount, storageSet } =
      await installStorageCoordinatorHarness();

    await coordinator.getState();

    expect(probeSetCount()).toBe(1);
    expect(operationLog).toEqual(['probe:1']);
    expect(storageSet).not.toHaveBeenCalled();
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

  it('replays storage changes that arrive while the initial snapshot is loading', async () => {
    mockStorage = createStorage();
    const { coordinator, storageGet, releaseFirstGet } =
      await installStorageCoordinatorHarness({ stallFirstGet: true });
    const loading = coordinator.getState();
    await vi.waitFor(() => expect(storageGet).toHaveBeenCalledTimes(1));

    const nextPersonalities = [
      { id: 'p1', name: 'Closer', content: 'new instructions', updatedAt: 2 },
      ...createBundledPersonalities(),
    ];
    coordinator.applyStorageChanges({
      personalities: {
        oldValue: mockStorage.personalities,
        newValue: nextPersonalities,
      },
    }, 'local');
    releaseFirstGet();

    await expect(loading).resolves.toMatchObject({
      personalities: nextPersonalities,
    });
    await expect(coordinator.getState()).resolves.toMatchObject({
      personalities: nextPersonalities,
    });
  });

  it('takes a fresh snapshot after an observed probe when the first probe event was lost', async () => {
    const [bundledLora] = createBundledPersonalities();
    const nextSettings = stripSecretSettings({
      ...createDefaultSettings(),
      uiTheme: 'dark',
      agencyHubApiKey: 'fresh-key',
      agencyHubDeviceToken: 'fresh-token',
    });
    const nextPersonalities = [
      { id: 'p1', name: 'Closer', content: 'written before listener was live', updatedAt: 8 },
      ...(bundledLora ? [bundledLora] : []),
    ];
    const nextMappings = { acc2: 'p1' };
    mockStorage = createStorage({
      schemaVersion: 12,
      personalities: [{ id: 'p1', name: 'Closer', content: 'stale', updatedAt: 1 }],
      accountMappings: { acc1: 'p1' },
    });

    const { coordinator, operationLog, probeSetCount, storageSet } =
      await installStorageCoordinatorHarness({
        missFirstProbeEvent: true,
        afterMissedFirstProbe: () => {
          // Simulate the Firefox startup window: storage changes, but the
          // listener misses both that event and the first probe event.
          Object.assign(mockStorage, {
            settings: nextSettings,
            personalities: nextPersonalities,
            accountMappings: nextMappings,
            [AGENCY_HUB_API_KEY_STORAGE_KEY]: 'fresh-key',
            [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'fresh-token',
          });
        },
      });

    const state = await coordinator.getState();
    expect(probeSetCount()).toBe(2);
    expect(operationLog).toEqual(['probe:1', 'probe:2', 'write']);
    expect(storageSet).toHaveBeenCalledTimes(1);
    expect(state.settings).toMatchObject({
      uiTheme: 'dark',
      agencyHubApiKey: 'fresh-key',
      agencyHubDeviceToken: 'fresh-token',
    });
    expect(state.personalities).toEqual(nextPersonalities);
    expect(state.accountMappings).toEqual(nextMappings);
    expect(mockStorage.settings).toEqual(nextSettings);
    expect(mockStorage.personalities).toEqual(nextPersonalities);
    expect(mockStorage.accountMappings).toEqual(nextMappings);
    expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('fresh-key');
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('fresh-token');
  });

  it('returns normalized state without repair when no probe is observed, then retries safely', async () => {
    mockStorage = createStorage({
      schemaVersion: 12,
      personalities: [{ id: 'p1', name: 'Closer', content: 'legacy state', updatedAt: 1 }],
    });
    const { coordinator, enableProbeEvents, probeSetCount, storageSet } =
      await installStorageCoordinatorHarness({ disableProbeEvents: true });

    const fallback = await coordinator.getState();
    expect(fallback.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(probeSetCount()).toBe(3);
    expect(storageSet).not.toHaveBeenCalled();
    expect(mockStorage.schemaVersion).toBe(12);

    enableProbeEvents();
    await coordinator.getState();
    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledTimes(1));
    expect(mockStorage.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
  });

  it('refuses an external writer until current-schema legacy credentials are durably repaired', async () => {
    mockStorage = createStorage({
      settings: {
        ...createDefaultSettings(),
        agencyHubApiKey: 'legacy-key',
        agencyHubDeviceToken: 'legacy-token',
      },
    });
    delete mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY];
    delete mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY];
    const { coordinator, enableProbeEvents, storageSet } =
      await installStorageCoordinatorHarness({ disableProbeEvents: true });

    await expect(coordinator.ensurePersistedState()).rejects.toThrow(
      'Storage repair could not be durably completed',
    );
    expect(storageSet).not.toHaveBeenCalled();

    enableProbeEvents();
    await expect(coordinator.ensurePersistedState()).resolves.toMatchObject({
      settings: {
        agencyHubApiKey: 'legacy-key',
        agencyHubDeviceToken: 'legacy-token',
      },
    });
    expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('legacy-key');
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('legacy-token');
    expect(mockStorage.settings).not.toHaveProperty('agencyHubApiKey');
    expect(mockStorage.settings).not.toHaveProperty('agencyHubDeviceToken');
  });

  it('fresh-reads current storage after an initially unobserved barrier', async () => {
    mockStorage = createStorage({
      settings: { ...createDefaultSettings(), uiTheme: 'light' },
    });
    const { coordinator, enableProbeEvents, storageSet } =
      await installStorageCoordinatorHarness({ disableProbeEvents: true });

    const fallback = await coordinator.getState();
    expect(fallback.settings.uiTheme).toBe('light');
    expect(storageSet).not.toHaveBeenCalled();

    mockStorage.settings = stripSecretSettings({
      ...createDefaultSettings(),
      uiTheme: 'dark',
    });
    const stillReadOnly = await coordinator.getState();

    expect(stillReadOnly.settings.uiTheme).toBe('dark');
    expect(storageSet).not.toHaveBeenCalled();

    enableProbeEvents();
    await coordinator.getState();
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('migrates only after merging newer persona, mapping, settings, and custody writes', async () => {
    const [bundledLora] = createBundledPersonalities();
    mockStorage = createStorage({
      schemaVersion: 12,
      settings: {
        ...createDefaultSettings(),
        agencyHubApiKey: 'old-key',
        agencyHubDeviceToken: 'old-token',
      },
      personalities: [{ id: 'p1', name: 'Closer', content: 'old instructions', updatedAt: 1 }],
      accountMappings: { acc1: 'p1' },
    });
    const { coordinator, storageGet, releaseFirstGet } =
      await installStorageCoordinatorHarness({ stallFirstGet: true });
    const loading = coordinator.getState();
    await vi.waitFor(() => expect(storageGet).toHaveBeenCalledTimes(1));

    const nextSettings = stripSecretSettings({
      ...createDefaultSettings(),
      uiTheme: 'dark',
      agencyHubApiKey: 'fresh-key',
      agencyHubDeviceToken: 'fresh-token',
    });
    const nextPersonalities = [
      { id: 'p1', name: 'Closer', content: 'new instructions', updatedAt: 2 },
      ...(bundledLora ? [bundledLora] : []),
    ];
    const nextMappings = { acc1: 'p1', acc2: 'p1' };
    Object.assign(mockStorage, {
      settings: nextSettings,
      personalities: nextPersonalities,
      accountMappings: nextMappings,
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: 'fresh-key',
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'fresh-token',
    });
    coordinator.applyStorageChanges({
      settings: { newValue: nextSettings },
      personalities: { newValue: nextPersonalities },
      accountMappings: { newValue: nextMappings },
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: { newValue: 'fresh-key' },
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: { newValue: 'fresh-token' },
    }, 'local');
    releaseFirstGet();

    const state = await loading;
    expect(state.settings).toMatchObject({
      uiTheme: 'dark',
      agencyHubApiKey: 'fresh-key',
      agencyHubDeviceToken: 'fresh-token',
    });
    expect(state.personalities).toEqual(nextPersonalities);
    expect(state.accountMappings).toEqual(nextMappings);
    expect(mockStorage).toMatchObject({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      personalities: nextPersonalities,
      accountMappings: nextMappings,
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: 'fresh-key',
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'fresh-token',
    });
    expect(mockStorage.settings).toEqual(nextSettings);
  });

  it('restores newer writes that land while the startup repair write is in flight', async () => {
    const [bundledLora] = createBundledPersonalities();
    mockStorage = createStorage({
      schemaVersion: 12,
      settings: {
        ...createDefaultSettings(),
        agencyHubApiKey: 'old-key',
        agencyHubDeviceToken: 'old-token',
      },
      personalities: [{ id: 'p1', name: 'Closer', content: 'old instructions', updatedAt: 1 }],
      accountMappings: { acc1: 'p1' },
    });
    const { coordinator, storageSet, releaseFirstSet } =
      await installStorageCoordinatorHarness({ stallFirstSet: true });
    const loading = coordinator.getState();
    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledTimes(1));

    const nextSettings = stripSecretSettings({
      ...createDefaultSettings(),
      uiTheme: 'dark',
      agencyHubApiKey: 'fresh-key',
      agencyHubDeviceToken: 'fresh-token',
    });
    const nextPersonalities = [
      { id: 'p1', name: 'Closer', content: 'edited during repair', updatedAt: 3 },
      ...(bundledLora ? [bundledLora] : []),
    ];
    const nextMappings = { acc2: 'p1' };
    Object.assign(mockStorage, {
      settings: nextSettings,
      personalities: nextPersonalities,
      accountMappings: nextMappings,
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: 'fresh-key',
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'fresh-token',
    });
    coordinator.applyStorageChanges({
      settings: { newValue: nextSettings },
      personalities: { newValue: nextPersonalities },
      accountMappings: { newValue: nextMappings },
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: { newValue: 'fresh-key' },
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: { newValue: 'fresh-token' },
    }, 'local');
    releaseFirstSet();

    const state = await loading;
    expect(state.settings).toMatchObject({
      uiTheme: 'dark',
      agencyHubApiKey: 'fresh-key',
      agencyHubDeviceToken: 'fresh-token',
    });
    expect(state.personalities).toEqual(nextPersonalities);
    expect(state.accountMappings).toEqual(nextMappings);
    expect(mockStorage.settings).toEqual(nextSettings);
    expect(mockStorage.personalities).toEqual(nextPersonalities);
    expect(mockStorage.accountMappings).toEqual(nextMappings);
    expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('fresh-key');
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('fresh-token');
  });

  it('retains buffered changes after an initial read failure and applies them on retry', async () => {
    mockStorage = createStorage();
    const { coordinator, storageGet } =
      await installStorageCoordinatorHarness({ rejectFirstGet: true });
    const firstLoad = coordinator.getState();
    const nextMappings = { acc2: 'p1' };
    mockStorage.accountMappings = nextMappings;
    coordinator.applyStorageChanges({
      accountMappings: { newValue: nextMappings },
    }, 'local');

    await expect(firstLoad).rejects.toThrow('initial storage read failed');
    await expect(coordinator.getState()).resolves.toMatchObject({
      accountMappings: nextMappings,
    });
    // The preservation barrier performs its own snapshot read before the
    // storage coordinator retries the full state read.
    expect(storageGet).toHaveBeenCalledTimes(3);
    expect(mockStorage.accountMappings).toEqual(nextMappings);
  });

  it('retains writes observed during a failed repair and restores them on retry', async () => {
    mockStorage = createStorage({ schemaVersion: 12 });
    const { coordinator, storageSet, releaseFirstSet } =
      await installStorageCoordinatorHarness({
        stallFirstSet: true,
        rejectFirstSet: true,
      });
    const firstLoad = coordinator.getState();
    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledTimes(1));

    const nextPersonalities = [
      { id: 'p1', name: 'Closer', content: 'survives repair failure', updatedAt: 4 },
      ...createBundledPersonalities(),
    ];
    mockStorage.personalities = nextPersonalities;
    coordinator.applyStorageChanges({
      personalities: { newValue: nextPersonalities },
    }, 'local');
    releaseFirstSet();

    await expect(firstLoad).rejects.toThrow('startup storage repair failed');
    const recovered = await coordinator.getState();
    expect(recovered.personalities).toEqual(nextPersonalities);
    expect(mockStorage.personalities).toEqual(nextPersonalities);
    expect(mockStorage.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
  });

  it('waits for a repair acknowledgement delayed by two tasks before exposing state', async () => {
    mockStorage = createStorage({
      schemaVersion: 12,
      settings: { ...createDefaultSettings(), uiTheme: 'light' },
    });
    const { coordinator } = await installStorageCoordinatorHarness({
      repairEventDelayTasks: 2,
    });
    await coordinator.getState();

    const nextSettings = stripSecretSettings({
      ...createDefaultSettings(),
      uiTheme: 'dark',
    });
    mockStorage.settings = nextSettings;
    coordinator.applyStorageChanges({
      settings: { newValue: nextSettings },
    }, 'local');
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(coordinator.getState()).resolves.toMatchObject({
      settings: { uiTheme: 'dark' },
    });
  });

  it('hides source-A catalog bytes synchronously when settings move to source B', async () => {
    const settingsA: Settings = {
      ...createDefaultSettings(),
      agencyHubBaseUrl: 'https://hub-a.example.test',
      agencyHubDeviceToken: 'device-a',
    };
    const settingsB: Settings = {
      ...settingsA,
      agencyHubBaseUrl: 'https://hub-b.example.test',
      agencyHubDeviceToken: 'device-b',
    };
    const sourceA = personaCatalogSource(settingsA);
    mockStorage = createStorage({
      settings: stripSecretSettings(settingsA),
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: settingsA.agencyHubDeviceToken,
      [PERSONA_CATALOG_STORAGE_KEY]: [{
        key: 'source-a-persona',
        displayName: 'Source A',
        definitionId: 'v1:source-a-persona',
        version: 1,
        status: 'active',
      }],
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: sourceA,
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: '2026-07-13T12:00:00.000Z',
    });
    const { coordinator } = await installStorageCoordinatorHarness();

    await expect(coordinator.getState()).resolves.toMatchObject({
      personaCatalog: [{ key: 'source-a-persona' }],
      personaCatalogSource: sourceA,
    });

    // The source-A refresh can be hung behind a network request indefinitely.
    // StorageCoordinator must still stop exposing A immediately when the user
    // switches settings/custody to B; clearing disk is the refresh's job.
    const storedSettingsB = stripSecretSettings(settingsB);
    coordinator.applyStorageChanges({
      settings: { newValue: storedSettingsB },
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
        oldValue: settingsA.agencyHubDeviceToken,
        newValue: settingsB.agencyHubDeviceToken,
      },
    }, 'local');

    await expect(coordinator.getState()).resolves.toMatchObject({
      settings: {
        agencyHubBaseUrl: settingsB.agencyHubBaseUrl,
        agencyHubDeviceToken: settingsB.agencyHubDeviceToken,
      },
      personaCatalog: [],
      personaCatalogSource: sourceA,
      personaCatalogFetchedAt: null,
    });
  });

  it('preserves a valid summary cache write observed during startup repair', async () => {
    mockStorage = createStorage({ schemaVersion: 12 });
    const { coordinator, storageSet, releaseFirstSet } =
      await installStorageCoordinatorHarness({ stallFirstSet: true });
    const loading = coordinator.getState();
    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledTimes(1));

    const summary: SummaryCacheEntry = {
      summary: 'new summary',
      personalityId: 'p1',
      personaDefinitionId: 'v1:persona-one-definition',
      personalityUpdatedAt: 1,
      personaCatalogSource: null,
      generatedAt: 10,
    };
    mockStorage['summary:g1'] = summary;
    coordinator.applyStorageChanges({
      'summary:g1': { newValue: summary },
    }, 'local');
    releaseFirstSet();

    await loading;
    expect(mockStorage['summary:g1']).toEqual(summary);
    await expect(coordinator.getSummaryCache('g1')).resolves.toEqual(summary);
  });

  it('fails closed without writes after observing a future storage schema', async () => {
    mockStorage = createStorage();
    const { coordinator, storageSet } = await installStorageCoordinatorHarness();
    await coordinator.getState();
    storageSet.mockClear();

    coordinator.applyStorageChanges({
      schemaVersion: {
        oldValue: STORAGE_SCHEMA_VERSION,
        newValue: STORAGE_SCHEMA_VERSION + 1,
      },
    }, 'local');

    await expect(coordinator.getState()).rejects.toThrow(
      `Storage schema ${STORAGE_SCHEMA_VERSION + 1} is newer`,
    );
    await expect(coordinator.registerKnownAccount('future-schema-account')).rejects.toThrow(
      `Storage schema ${STORAGE_SCHEMA_VERSION + 1} is newer`,
    );
    expect(storageSet).not.toHaveBeenCalled();
  });

  it('fails closed when a deferred fresh read discovers a future schema', async () => {
    mockStorage = createStorage();
    const { coordinator, storageSet } = await installStorageCoordinatorHarness({
      disableProbeEvents: true,
    });

    await expect(coordinator.getState()).resolves.toMatchObject({
      schemaVersion: STORAGE_SCHEMA_VERSION,
    });
    storageSet.mockClear();
    mockStorage.schemaVersion = STORAGE_SCHEMA_VERSION + 1;

    await expect(coordinator.getState()).rejects.toThrow(
      `Storage schema ${STORAGE_SCHEMA_VERSION + 1} is newer`,
    );
    await expect(coordinator.registerKnownAccount('future-schema-account')).rejects.toThrow(
      `Storage schema ${STORAGE_SCHEMA_VERSION + 1} is newer`,
    );
    expect(storageSet).not.toHaveBeenCalled();
  });
});
