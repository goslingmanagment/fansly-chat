// W9.4 / A41/I116-4 — storage v13: per-key credential custody.
//
// The v12 layout kept the device token inside the `settings` blob, and every
// saveSettings was a read-modify-write of that whole blob — an options-page
// debounced save racing a token issuance could persist a stale token over
// the fresh one. v13 moves both hub credentials to their own storage.local
// keys: the blob never carries them, custody keys are written only when a
// patch names them, and a one-release fallback still READS v12 blobs.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  DEFAULT_AGENCY_HUB_BASE_URL,
  LEGACY_PERSONA_SNAPSHOT_KEY,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import {
  createDefaultSettings,
  migrateState,
  serializePersistedState,
  stripSecretSettings,
  UnsupportedFutureStorageSchemaError,
} from '../src/shared/migrations.js';

// ─── Mock browser.storage.local (same pattern as storage-migration tests) ──

let mockStorage: Record<string, unknown> = {};

(globalThis as Record<string, unknown>).browser = {
  storage: {
    local: {
      get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
        if (keys === null || keys === undefined) return { ...mockStorage };
        if (typeof keys === 'string') return { [keys]: mockStorage[keys] };
        if (Array.isArray(keys)) {
          const result: Record<string, unknown> = {};
          for (const k of keys) result[k] = mockStorage[k];
          return result;
        }
        return {};
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(mockStorage, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keyArr) delete mockStorage[k];
      }),
    },
  },
};

const storage = await import('../src/shared/storage.js');
const { StorageCoordinator } = await import('../src/background/storage-coordinator.js');

function v12Store(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 12,
    settings: {
      ...createDefaultSettings(),
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubDeviceToken: 'old-token',
    },
    personalities: [],
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
    ...overrides,
  };
}

function fullStateWrites(): Record<string, unknown>[] {
  return vi.mocked(browser.storage.local.set).mock.calls
    .map(([items]) => items)
    .filter((items) =>
      Object.prototype.hasOwnProperty.call(items, 'settings') ||
      Object.prototype.hasOwnProperty.call(items, AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY) ||
      Object.prototype.hasOwnProperty.call(items, LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY),
    );
}

beforeEach(() => {
  mockStorage = {};
  vi.clearAllMocks();
});

describe('v12 → v13 migration', () => {
  it('moves credentials to their own keys and strips them from the persisted blob', async () => {
    mockStorage = v12Store();

    const state = await storage.loadStorageState();

    // In-memory shape unchanged: consumers still read settings.agencyHub*.
    expect(state.settings.agencyHubDeviceToken).toBe('old-token');

    // Persisted layout: the custody key owns the secret, the blob has none,
    // and the retired legacy slot is gone (v17/E123).
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('old-token');
    expect(LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY in mockStorage).toBe(false);
    const blob = mockStorage.settings as Record<string, unknown>;
    expect(blob).not.toHaveProperty('agencyHubDeviceToken');
    expect(blob).not.toHaveProperty('agencyHubApiKey');
    expect(mockStorage.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
  });

  it('fallback-reads a v12 blob that has not migrated yet (pure migrateState)', () => {
    const state = migrateState(v12Store());
    expect(state.settings.agencyHubDeviceToken).toBe('old-token');
  });

  it('custody key beats a stale blob value whenever both exist', () => {
    const state = migrateState({
      ...v12Store({ schemaVersion: STORAGE_SCHEMA_VERSION }),
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'fresh-token',
    });
    // The stale v12-shaped blob still carries 'old-token' — the custody key
    // must win over it.
    expect(state.settings.agencyHubDeviceToken).toBe('fresh-token');
  });

  it('leaves current-schema custody repair to the fenced background coordinator', async () => {
    mockStorage = v12Store({ schemaVersion: STORAGE_SCHEMA_VERSION });

    const snapshot = await storage.readStorageStateSnapshot();

    expect(snapshot.state.settings.agencyHubDeviceToken).toBe('old-token');
    expect(snapshot.repair).toMatchObject({
      persistState: false,
      custodyLayoutNeedsRepair: true,
    });
    expect(fullStateWrites()).toEqual([]);
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBeUndefined();
    expect(mockStorage.settings).toHaveProperty('agencyHubDeviceToken', 'old-token');
  });

  it('never lets a direct current-schema read replace fresher custody values', async () => {
    mockStorage = {
      ...v12Store({ schemaVersion: STORAGE_SCHEMA_VERSION }),
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'fresh-token',
    };

    const state = await storage.loadStorageState();

    expect(state.settings.agencyHubDeviceToken).toBe('fresh-token');
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('fresh-token');
    expect(mockStorage.settings).toHaveProperty('agencyHubDeviceToken', 'old-token');
    expect(fullStateWrites()).toEqual([]);
  });
});

describe('v12 → v17 direct jump (E123)', () => {
  it('carries a working sign-in out of the pre-v13 blob and retires the legacy slot', async () => {
    // The update feed serves only the NEWEST build, so an install still on
    // ≤1.8.0 (pre-v13) lands on v17 in one step. Its credential lives inside the
    // settings blob; without the blob fallback below it would arrive signed out
    // and need a fresh password — which is exactly what this release promises
    // will NOT happen.
    mockStorage = {
      schemaVersion: 12,
      settings: {
        ...createDefaultSettings(),
        agencyHubBaseUrl: 'https://hub.example',
        agencyHubDeviceToken: 'agency_hub_device_live',
        // A pre-v13 blob also carried the legacy key. It is dropped, not moved.
        agencyHubApiKey: 'legacy-key',
      },
      agencyHubApiKey: 'legacy-key',
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };

    const state = await storage.loadStorageState();

    // The sign-in survives the jump — no re-login for anyone on the fleet.
    expect(state.settings.agencyHubDeviceToken).toBe('agency_hub_device_live');
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('agency_hub_device_live');
    expect(mockStorage.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    // …and the retired credential is gone from both places it could hide.
    expect(state.settings).not.toHaveProperty('agencyHubApiKey');
    expect(mockStorage.settings).not.toHaveProperty('agencyHubApiKey');
    expect(LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY in mockStorage).toBe(false);
  });

  it('fills in the default hub address for an install that never had one', async () => {
    mockStorage = {
      schemaVersion: 12,
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: '' },
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };

    const state = await storage.loadStorageState();

    expect(state.settings.agencyHubBaseUrl).toBe(DEFAULT_AGENCY_HUB_BASE_URL);
  });

  it('never overwrites an address someone chose deliberately', async () => {
    mockStorage = {
      schemaVersion: 12,
      settings: { ...createDefaultSettings(), agencyHubBaseUrl: 'https://staging.example' },
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };

    const state = await storage.loadStorageState();

    expect(state.settings.agencyHubBaseUrl).toBe('https://staging.example');
  });

  it('an install that held ONLY the legacy key arrives signed out, not half-signed-in', async () => {
    mockStorage = {
      schemaVersion: 12,
      settings: {
        ...createDefaultSettings(),
        agencyHubBaseUrl: 'https://hub.example',
        agencyHubApiKey: 'legacy-key',
      },
      agencyHubApiKey: 'legacy-key',
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };

    const state = await storage.loadStorageState();

    expect(state.settings.agencyHubDeviceToken).toBe('');
    expect(LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY in mockStorage).toBe(false);
  });
});

describe('narrow steady-state reads', () => {
  const summaryOne = {
    summary: 'first summary',
    personalityId: 'p1',
    personaDefinitionId: 'v1:persona-one-definition',
    personalityUpdatedAt: 1,
    personaCatalogSource: null,
    generatedAt: 10,
  };
  const summaryTwo = {
    ...summaryOne,
    summary: 'second summary',
    generatedAt: 20,
  };

  async function primeCurrentLayout(): Promise<void> {
    mockStorage = serializePersistedState(migrateState({
      ...v12Store({ schemaVersion: STORAGE_SCHEMA_VERSION }),
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'current-token',
      'summary:g1': summaryOne,
      'summary:g2': summaryTwo,
    }));
    // The first process read intentionally performs the write-once legacy
    // preservation snapshot. Assertions below cover the subsequent steady
    // state after that safety barrier has been established.
    await storage.readStorageState();
    vi.mocked(browser.storage.local.get).mockClear();
  }

  it('reads only normalized keys plus the requested summary on a current layout', async () => {
    await primeCurrentLayout();

    const state = await storage.readStorageState({
      summaryKeys: ['summary:g1'],
    });
    const calls = vi.mocked(browser.storage.local.get).mock.calls;
    const requestedKeys = calls.at(-1)?.[0];

    expect(calls.some(([keys]) => keys === null || keys === undefined)).toBe(false);
    expect(calls[0]?.[0]).toBe(LEGACY_PERSONA_SNAPSHOT_KEY);
    expect(Array.isArray(requestedKeys)).toBe(true);
    expect(requestedKeys).toEqual(expect.arrayContaining([
      'schemaVersion',
      'settings',
      AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
      // Still ASKED for, never read as a credential: presence is what tells the
      // coordinator there is a retired slot left to remove (v17/E123).
      LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY,
      'summary:g1',
    ]));
    expect(requestedKeys).not.toContain('summary:g2');
    expect((state as unknown as Record<string, unknown>)['summary:g1']).toEqual(summaryOne);
    expect((state as unknown as Record<string, unknown>)['summary:g2']).toBeUndefined();
  });

  it('falls back to a full snapshot for migration and preserves every summary', async () => {
    await primeCurrentLayout();
    mockStorage.schemaVersion = STORAGE_SCHEMA_VERSION - 1;

    const state = await storage.readStorageState({
      summaryKeys: ['summary:g1'],
    });
    const calls = vi.mocked(browser.storage.local.get).mock.calls;

    expect(calls.some(([keys]) => Array.isArray(keys))).toBe(true);
    expect(calls.some(([keys]) => keys === null)).toBe(true);
    expect(state.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect((state as unknown as Record<string, unknown>)['summary:g1']).toEqual(summaryOne);
    expect((state as unknown as Record<string, unknown>)['summary:g2']).toEqual(summaryTwo);
  });

  it('falls back to the full current-schema snapshot when custody layout needs repair', async () => {
    mockStorage = {
      ...v12Store({ schemaVersion: STORAGE_SCHEMA_VERSION }),
      'summary:g1': summaryOne,
      'summary:g2': summaryTwo,
    };
    // Establish only the immutable preservation barrier; this read is
    // deliberately non-mutating, so the legacy custody layout stays on disk.
    await storage.readStorageState();
    vi.mocked(browser.storage.local.get).mockClear();

    const state = await storage.readStorageState({
      summaryKeys: ['summary:g1'],
    });
    const calls = vi.mocked(browser.storage.local.get).mock.calls;

    expect(calls.some(([keys]) => Array.isArray(keys))).toBe(true);
    expect(calls.some(([keys]) => keys === null)).toBe(true);
    expect(state.settings.agencyHubDeviceToken).toBe('old-token');
    expect((state as unknown as Record<string, unknown>)['summary:g2']).toEqual(summaryTwo);
    expect(fullStateWrites()).toEqual([]);
  });

  it('fails on a future schema from the narrow read without cloning full storage', async () => {
    await primeCurrentLayout();
    mockStorage.schemaVersion = STORAGE_SCHEMA_VERSION + 1;

    await expect(storage.readStorageState()).rejects.toThrow(
      UnsupportedFutureStorageSchemaError,
    );
    expect(
      vi.mocked(browser.storage.local.get).mock.calls
        .some(([keys]) => keys === null || keys === undefined),
    ).toBe(false);
  });
});

describe('saveSettings custody contract', () => {
  it('writes a custody key only when the patch names it', async () => {
    mockStorage = v12Store();
    await storage.loadStorageState(); // migrate to v13

    (browser.storage.local.set as ReturnType<typeof vi.fn>).mockClear();
    await storage.saveSettings({ quickMessageCount: 30 });

    const written = (browser.storage.local.set as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
    expect(written).toHaveProperty('settings');
    expect(written).not.toHaveProperty(AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY);
    expect(written).not.toHaveProperty(LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY);
    expect((written.settings as Record<string, unknown>)).not.toHaveProperty('agencyHubDeviceToken');
  });

  it('token issuance is an atomic single-key set of the custody key', async () => {
    mockStorage = v12Store();
    await storage.loadStorageState();

    await storage.saveSettings({
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubDeviceToken: 'issued-token',
    });

    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('issued-token');
    const reloaded = await storage.loadStorageState();
    expect(reloaded.settings.agencyHubDeviceToken).toBe('issued-token');
  });

  it('A41 race: an interleaved stale options-page save cannot clobber a fresh token', async () => {
    mockStorage = v12Store();

    // Options page opens and snapshots state (token = 'old-token').
    const staleView = await storage.loadStorageState();
    expect(staleView.settings.agencyHubDeviceToken).toBe('old-token');

    // Sign-in issues a fresh token (runtime-api path).
    await storage.saveSettings({
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubDeviceToken: 'fresh-token',
    });

    // The stale options page then flushes its debounced save — the exact
    // patch shape saveSettingsDebounced builds (inputs + counts; NO token
    // property, the page never edits it).
    await storage.saveSettings({
      agencyHubBaseUrl: staleView.settings.agencyHubBaseUrl,
      quickMessageCount: 30,
      pingMessageCount: staleView.settings.pingMessageCount,
      improveMessageCount: staleView.settings.improveMessageCount,
      deepMessageCount: staleView.settings.deepMessageCount,
      debugMode: staleView.settings.debugMode,
      promptCachingEnabled: staleView.settings.promptCachingEnabled,
    });

    // The token survives: the blob write carries no token by construction.
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('fresh-token');
    const after = await storage.loadStorageState();
    expect(after.settings.agencyHubDeviceToken).toBe('fresh-token');
    expect(after.settings.quickMessageCount).toBe(30);
  });

  it('co-writes an extra key in the SAME set as the credential', async () => {
    // E59 post-campaign: the device-token metadata must never land in a separate
    // write from the token it describes.
    mockStorage = v12Store();
    await storage.loadStorageState();

    (browser.storage.local.set as ReturnType<typeof vi.fn>).mockClear();
    await storage.saveSettings(
      { agencyHubDeviceToken: 'issued-token' },
      undefined,
      { alsoWrite: { 'chatgoose:someMeta': { version: 1 } } },
    );

    const calls = (browser.storage.local.set as ReturnType<typeof vi.fn>).mock.calls;
    const custodyWrites = calls.filter(
      ([items]) => Object.prototype.hasOwnProperty.call(items, AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY),
    );
    expect(custodyWrites).toHaveLength(1);
    expect(custodyWrites[0]![0]).toMatchObject({
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'issued-token',
      'chatgoose:someMeta': { version: 1 },
    });
  });

  it('REFUSES a co-write that would overwrite a key this write owns', async () => {
    // The invariant in the doc comment is enforced, not trusted: a colliding
    // co-write would silently win over the credential (or the schema stamp) this
    // call computed.
    mockStorage = v12Store();
    await storage.loadStorageState();

    for (const collision of [
      { settings: {} },
      { schemaVersion: 999 },
      { [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'smuggled-token' },
    ]) {
      await expect(storage.saveSettings(
        { agencyHubDeviceToken: 'issued-token' },
        undefined,
        { alsoWrite: collision },
      )).rejects.toThrow('alsoWrite');
    }
    // …and nothing of the sort reached disk.
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).not.toBe('smuggled-token');
    expect(mockStorage.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
  });
});

describe('saveSettings durably stamps schemaVersion (E45)', () => {
  function preV15Store(deep: number): Record<string, unknown> {
    // A v14 record whose v15 migration was never written back to disk — the
    // StorageCoordinator's deferred-repair window (listener probe not yet passed).
    return {
      schemaVersion: 14,
      settings: { ...createDefaultSettings(), deepMessageCount: deep },
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };
  }

  it('preserves a deliberate post-v15 deep window even when disk was still pre-v15', async () => {
    // Disk holds v14 + the new default; the chatter deliberately picks 1500.
    mockStorage = preV15Store(3000);

    // Options loads via the NON-mutating readStorageState (in-memory v15, disk
    // stays v14), then saves the deliberate 1500 with its observed version.
    const view = await storage.readStorageState();
    expect(view.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    await storage.saveSettings(
      { deepMessageCount: 1500 },
      view.settings,
      { observedSchemaVersion: view.schemaVersion },
    );

    // The write stamps the durable v15 marker alongside the settings...
    expect(mockStorage.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    // ...so the next load does NOT re-run the one-shot deep-window bump: the
    // deliberate 1500 survives (without the marker it would migrate to 3000).
    const reloaded = await storage.loadStorageState();
    expect(reloaded.settings.deepMessageCount).toBe(1500);
  });

  it('never downgrades schemaVersion below a higher on-disk version (future-schema barrier)', async () => {
    const future = STORAGE_SCHEMA_VERSION + 1;
    mockStorage = {
      schemaVersion: future,
      settings: { ...createDefaultSettings() },
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };
    // A newer worker owns disk at a higher schema. saveSettings must REFUSE
    // rather than stamp our (lower) version over it.
    await expect(
      storage.saveSettings(
        { deepMessageCount: 1500 },
        createDefaultSettings(),
        { observedSchemaVersion: future },
      ),
    ).rejects.toThrow();
    expect(mockStorage.schemaVersion).toBe(future);
  });

  it('reads the REAL disk version on the read/modify/write path and refuses to stamp over a higher one (round-14 P2)', async () => {
    // The read/modify/write path (no baseSettings — e.g. runtime-api's device-token
    // save) does not get an observedSchemaVersion, so the write-site disk read is
    // its explicit downgrade barrier: a newer worker raised disk to a future
    // version, and our stamp must NOT downgrade the marker (16 → 15) into a
    // re-migration ping-pong. The guard fires BEFORE loadStorageState (which would
    // also throw), so this asserts the co-located guard specifically.
    const future = STORAGE_SCHEMA_VERSION + 1;
    mockStorage = {
      schemaVersion: future,
      settings: { ...createDefaultSettings() },
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };
    await expect(
      storage.saveSettings({ deepMessageCount: 1500 }), // no baseSettings ⇒ read/modify/write path
    ).rejects.toThrow(UnsupportedFutureStorageSchemaError);
    expect(mockStorage.schemaVersion).toBe(future);
  });
});

describe('serialization helpers', () => {
  it('stripSecretSettings removes the one credential field (and the retired one stays gone)', () => {
    const settings = {
      ...createDefaultSettings(),
      agencyHubDeviceToken: 't',
    };
    const stripped = stripSecretSettings(settings);
    expect(stripped).not.toHaveProperty('agencyHubApiKey');
    expect(stripped).not.toHaveProperty('agencyHubDeviceToken');
    expect(stripped.agencyHubBaseUrl).toBe(settings.agencyHubBaseUrl);
    expect(stripped.uiTheme).toBe(settings.uiTheme);
  });

  it('serializePersistedState emits the one custody key + a secret-free blob', () => {
    const state = migrateState(v12Store());
    const serialized = serializePersistedState(state);
    expect(serialized[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('old-token');
    // The retired slot is never re-emitted (v17/E123).
    expect(serialized).not.toHaveProperty(LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY);
    expect(serialized.settings).not.toHaveProperty('agencyHubDeviceToken');
  });
});

describe('StorageCoordinator memory under v13 custody', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('a settings-blob-only change never erases the token from memory', async () => {
    mockStorage = v12Store();
    const coordinator = new StorageCoordinator();
    const [initial] = await Promise.all([coordinator.init(), vi.runAllTimersAsync()]);
    expect(initial.settings.agencyHubDeviceToken).toBe('old-token');

    // Another context writes a v13 (secret-free) blob — e.g. a theme change.
    coordinator.applyStorageChanges(
      {
        settings: {
          newValue: stripSecretSettings({ ...initial.settings, uiTheme: 'dark' }),
        } as browser.storage.StorageChange,
      },
      'local',
    );

    const [state] = await Promise.all([coordinator.getState(), vi.runAllTimersAsync()]);
    expect(state.settings.uiTheme).toBe('dark');
    expect(state.settings.agencyHubDeviceToken).toBe('old-token');
  });

  it('a custody-key change updates the in-memory token', async () => {
    mockStorage = v12Store();
    const coordinator = new StorageCoordinator();
    await Promise.all([coordinator.init(), vi.runAllTimersAsync()]);

    coordinator.applyStorageChanges(
      {
        [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
          newValue: 'rotated-token',
        } as browser.storage.StorageChange,
      },
      'local',
    );

    const [state] = await Promise.all([coordinator.getState(), vi.runAllTimersAsync()]);
    expect(state.settings.agencyHubDeviceToken).toBe('rotated-token');
  });
});
