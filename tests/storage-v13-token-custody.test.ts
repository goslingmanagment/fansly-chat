// W9.4 / A41/I116-4 — storage v13: per-key credential custody.
//
// The v12 layout kept the device token inside the `settings` blob, and every
// saveSettings was a read-modify-write of that whole blob — an options-page
// debounced save racing a token issuance could persist a stale token over
// the fresh one. v13 moves both hub credentials to their own storage.local
// keys: the blob never carries them, custody keys are written only when a
// patch names them, and a one-release fallback still READS v12 blobs.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import {
  createDefaultSettings,
  migrateState,
  serializePersistedState,
  stripSecretSettings,
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
      agencyHubApiKey: 'legacy-key',
      agencyHubDeviceToken: 'old-token',
    },
    personalities: [],
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
    ...overrides,
  };
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
    expect(state.settings.agencyHubApiKey).toBe('legacy-key');

    // Persisted layout: custody keys own the secrets, blob has none.
    expect(mockStorage[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('old-token');
    expect(mockStorage[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('legacy-key');
    const blob = mockStorage.settings as Record<string, unknown>;
    expect(blob).not.toHaveProperty('agencyHubDeviceToken');
    expect(blob).not.toHaveProperty('agencyHubApiKey');
    expect(mockStorage.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
  });

  it('fallback-reads a v12 blob that has not migrated yet (pure migrateState)', () => {
    const state = migrateState(v12Store());
    expect(state.settings.agencyHubDeviceToken).toBe('old-token');
    expect(state.settings.agencyHubApiKey).toBe('legacy-key');
  });

  it('custody key beats a stale blob value whenever both exist', () => {
    const state = migrateState({
      ...v12Store({ schemaVersion: STORAGE_SCHEMA_VERSION }),
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: 'fresh-token',
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: '',
    });
    // The stale v12-shaped blob still carries 'old-token'/'legacy-key' — the
    // custody keys must win in BOTH directions (fresh token, cleared key).
    expect(state.settings.agencyHubDeviceToken).toBe('fresh-token');
    expect(state.settings.agencyHubApiKey).toBe('');
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
    expect(written).not.toHaveProperty(AGENCY_HUB_API_KEY_STORAGE_KEY);
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
      agencyHubApiKey: staleView.settings.agencyHubApiKey,
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
});

describe('serialization helpers', () => {
  it('stripSecretSettings removes exactly the two credential fields', () => {
    const settings = {
      ...createDefaultSettings(),
      agencyHubApiKey: 'k',
      agencyHubDeviceToken: 't',
    };
    const stripped = stripSecretSettings(settings);
    expect(stripped).not.toHaveProperty('agencyHubApiKey');
    expect(stripped).not.toHaveProperty('agencyHubDeviceToken');
    expect(stripped.agencyHubBaseUrl).toBe(settings.agencyHubBaseUrl);
    expect(stripped.uiTheme).toBe(settings.uiTheme);
  });

  it('serializePersistedState emits custody keys + a secret-free blob', () => {
    const state = migrateState(v12Store());
    const serialized = serializePersistedState(state);
    expect(serialized[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]).toBe('old-token');
    expect(serialized[AGENCY_HUB_API_KEY_STORAGE_KEY]).toBe('legacy-key');
    expect(serialized.settings).not.toHaveProperty('agencyHubDeviceToken');
  });
});

describe('StorageCoordinator memory under v13 custody', () => {
  it('a settings-blob-only change never erases the token from memory', async () => {
    mockStorage = v12Store();
    const coordinator = new StorageCoordinator();
    const initial = await coordinator.init();
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

    const state = await coordinator.getState();
    expect(state.settings.uiTheme).toBe('dark');
    expect(state.settings.agencyHubDeviceToken).toBe('old-token');
  });

  it('a custody-key change updates the in-memory token', async () => {
    mockStorage = v12Store();
    const coordinator = new StorageCoordinator();
    await coordinator.init();

    coordinator.applyStorageChanges(
      {
        [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {
          newValue: 'rotated-token',
        } as browser.storage.StorageChange,
      },
      'local',
    );

    const state = await coordinator.getState();
    expect(state.settings.agencyHubDeviceToken).toBe('rotated-token');
  });
});
