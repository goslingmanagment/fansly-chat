import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Personality, SummaryCacheEntry } from '../src/shared/types.js';
import { normalizeAgencyHubSummarySyncMetadata } from '../src/shared/agency-hub.js';
import {
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import {
  MIGRATIONS,
  migrateState,
  createDefaultSettings,
  createSeedState,
  UnsupportedFutureStorageSchemaError,
  bumpLegacyDeepMessageCountDefault,
  DEEP_DEFAULT_BUMP_SCHEMA_VERSION,
} from '../src/shared/migrations.js';
import {
  BUNDLED_LORA_PERSONALITY_ID,
  BUNDLED_LORA_PERSONALITY_VERSION,
  createBundledPersonalities,
} from '../src/shared/personalities.js';

// ─── Mock browser.storage.local ─────────────────────────────────────────

let mockStorage: Record<string, unknown> = {};

(globalThis as Record<string, unknown>).browser = {
  storage: {
    local: {
      get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
        if (keys === null || keys === undefined) return { ...mockStorage };
        if (typeof keys === 'string') {
          return Object.prototype.hasOwnProperty.call(mockStorage, keys)
            ? { [keys]: mockStorage[keys] }
            : {};
        }
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

// Dynamic import to ensure mock is set up before module loads
const storage = await import('../src/shared/storage.js');

beforeEach(() => {
  mockStorage = {};
  vi.clearAllMocks();
});

// ─── migrateState ───────────────────────────────────────────────────────

describe('migrateState', () => {
  it('fails closed instead of downgrading a future storage schema', () => {
    expect(() => migrateState({
      schemaVersion: STORAGE_SCHEMA_VERSION + 1,
      settings: createDefaultSettings(),
      futureOwnedField: { preserve: true },
    })).toThrow(UnsupportedFutureStorageSchemaError);
  });

  it('rejects a settings write when its live schema observer saw a future version', async () => {
    await expect(storage.saveSettings(
      { debugMode: true },
      createDefaultSettings(),
      { observedSchemaVersion: STORAGE_SCHEMA_VERSION + 1 },
    )).rejects.toBeInstanceOf(UnsupportedFutureStorageSchemaError);
    expect(browser.storage.local.set).not.toHaveBeenCalled();
  });

  it('keeps migrations ordered up to the current schema', () => {
    expect(MIGRATIONS.map((migration) => migration.toVersion)).toEqual([
      STORAGE_SCHEMA_VERSION,
    ]);
  });

  it('returns seed state for null input', () => {
    const result = migrateState(null);
    expect(result.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(result.settings).toEqual(createDefaultSettings());
    expect(result.personalities).toEqual([]);
    expect(result.accountMappings).toEqual({});
    expect(result.accountAliases).toEqual({});
    expect(result.knownAccounts).toEqual([]);
  });

  it('returns seed state for non-object input', () => {
    expect(migrateState('string' as unknown)).toEqual(createSeedState());
    expect(migrateState(42 as unknown)).toEqual(createSeedState());
  });

  it('returns data as-is when schemaVersion matches current', () => {
    const existing = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: { ...createDefaultSettings(), debugMode: true },
      personalities: [{ id: 'p1', name: 'Test', content: 'test', updatedAt: 1000 }],
      accountMappings: { acc1: 'p1' },
      accountAliases: { legacy: 'resolved' },
      knownAccounts: ['acc1'],
    };
    const result = migrateState(existing);
    expect(result.settings.debugMode).toBe(true);
    expect(result.personalities).toHaveLength(1);
    expect(result.accountMappings.acc1).toBe('p1');
    expect(result.accountAliases).toEqual({ legacy: 'resolved' });
    expect(result.knownAccounts).toEqual(['acc1']);
  });

  it('coerces corrupt personalities/accountMappings at the current schema version', () => {
    const corrupt = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: 'not-an-array',
      accountMappings: 'not-an-object',
      accountAliases: {},
      knownAccounts: [],
    };
    const result = migrateState(corrupt as unknown);
    expect(result.personalities).toEqual([]);
    expect(result.accountMappings).toEqual({});
  });

  it('preserves existing data during migration from older schema', () => {
    const legacy = {
      schemaVersion: 0,
      settings: { quickMessageCount: 50, deepMessageCount: 200, debugMode: true },
      personalities: [{ id: 'p1', name: 'Legacy', content: 'old', updatedAt: 500 }],
      accountMappings: { acc1: 'p1' },
    };
    const result = migrateState(legacy);
    expect(result.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(result.settings.debugMode).toBe(true);
    expect(result.settings.pingMessageCount).toBe(50);
    expect(result.personalities).toHaveLength(1);
    expect(result.personalities[0]!.name).toBe('Legacy');
    expect(result.accountMappings.acc1).toBe('p1');
    expect(result.accountAliases).toEqual({});
  });

  it('fills in default settings for missing fields during migration', () => {
    const partial = { schemaVersion: 0, settings: { debugMode: true } };
    const result = migrateState(partial);
    expect(result.settings.quickMessageCount).toBe(createDefaultSettings().quickMessageCount);
    expect(result.settings.pingMessageCount).toBe(createDefaultSettings().pingMessageCount);
    expect(result.settings.improveMessageCount).toBe(createDefaultSettings().improveMessageCount);
    expect(result.settings.deepMessageCount).toBe(createDefaultSettings().deepMessageCount);
  });

  it('adds agencyHubDeviceToken on migration from pre-v8 records and keeps a stored one (idempotent)', () => {
    // Pre-v8 record: no token field at all → defaults to ''.
    const legacy = migrateState({
      schemaVersion: 7,
      settings: { agencyHubBaseUrl: 'http://localhost:3000', agencyHubApiKey: 'legacy-key' },
    });
    expect(legacy.settings.agencyHubDeviceToken).toBe('');
    expect(legacy.settings.agencyHubApiKey).toBe('legacy-key');

    // v8 record with a token survives re-migration byte-for-byte.
    const migratedOnce = migrateState({
      schemaVersion: 8,
      settings: { agencyHubDeviceToken: 'agency_hub_device_x' },
    });
    const migratedTwice = migrateState(migratedOnce as unknown as Record<string, unknown>);
    expect(migratedOnce.settings.agencyHubDeviceToken).toBe('agency_hub_device_x');
    expect(migratedTwice.settings.agencyHubDeviceToken).toBe('agency_hub_device_x');
  });

  it('adds uiTheme on migration from pre-v12 records and keeps a stored choice (idempotent)', () => {
    // Pre-v12 record: no uiTheme field at all → defaults to 'system'.
    const legacy = migrateState({
      schemaVersion: 11,
      settings: { agencyHubBaseUrl: 'http://localhost:3000' },
    });
    expect(legacy.settings.uiTheme).toBe('system');

    // A stored choice survives re-migration; junk falls back to the default.
    const migrated = migrateState({ schemaVersion: 11, settings: { uiTheme: 'dark' } });
    expect(migrated.settings.uiTheme).toBe('dark');
    const remigrated = migrateState(migrated as unknown as Record<string, unknown>);
    expect(remigrated.settings.uiTheme).toBe('dark');
    const junk = migrateState({ schemaVersion: 11, settings: { uiTheme: 'neon' } });
    expect(junk.settings.uiTheme).toBe('system');
  });

  it('seeds pingMessageCount from quickMessageCount when migrating legacy settings', () => {
    const result = migrateState({
      schemaVersion: 4,
      settings: {
        quickMessageCount: 73,
      },
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    });

    expect(result.settings.quickMessageCount).toBe(73);
    expect(result.settings.pingMessageCount).toBe(73);
  });

  // ─── v15: coach fields + deep-window default 1500 → 3000 ────────────────
  // NOTE ON VERSION NUMBER: the brief specced this as the "v14" migration,
  // but schema v14 already shipped to production (1.9.9–1.9.11, the persona
  // catalog move) and lives on `main`. Per the repo's forward-only migration
  // law this shape change (coach fields + deep default) gets its OWN number,
  // v15. The brief's semantics are preserved exactly, just keyed on the true
  // current version: a record already at the current schema never re-runs the
  // deep-window bump, and a shipped-v14 record with the OLD default upgrades.

  it('v15: bumps a pre-v15 default deep window (1500) to the new default (3000)', () => {
    const fromV13 = migrateState({
      schemaVersion: 13,
      settings: { deepMessageCount: 1500 },
    });
    expect(fromV13.settings.deepMessageCount).toBe(3000);

    // The shipped-v14 default (also 1500) must upgrade too — v14 < current.
    const fromV14 = migrateState({
      schemaVersion: 14,
      settings: { deepMessageCount: 1500 },
    });
    expect(fromV14.settings.deepMessageCount).toBe(3000);
  });

  it('v15: preserves a user-modified deep window (1499 stays 1499)', () => {
    const result = migrateState({
      schemaVersion: 13,
      settings: { deepMessageCount: 1499 },
    });
    expect(result.settings.deepMessageCount).toBe(1499);
  });

  it('v15: a missing deep window adopts the new default (3000)', () => {
    const result = migrateState({
      schemaVersion: 13,
      settings: { debugMode: true },
    });
    expect(result.settings.deepMessageCount).toBe(3000);
  });

  it('v15: never re-transforms a record already at the current schema (1500 stays 1500)', () => {
    const atCurrent = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: { ...createDefaultSettings(), deepMessageCount: 1500 },
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };
    const result = migrateState(atCurrent);
    expect(result.settings.deepMessageCount).toBe(1500);

    // Round-trip stability: re-migrating the output must not drift the value.
    const remigrated = migrateState(result as unknown as Record<string, unknown>);
    expect(remigrated.settings.deepMessageCount).toBe(1500);
  });

  // The legacy deep-window bump must anchor to a FIXED version (15), not the
  // moving STORAGE_SCHEMA_VERSION. Unit-test the transform helper directly with
  // hardcoded incoming versions so the guard is proven independent of whatever
  // the current schema happens to be. Without the fixed anchor, a future schema
  // bump (say v16) would re-fire the transform on a v15 record whose 1500 is the
  // chatter's DELIBERATE choice — E45 violation.
  describe('bumpLegacyDeepMessageCountDefault anchors on a fixed version', () => {
    it('pins the anchor at schema version 15', () => {
      expect(DEEP_DEFAULT_BUMP_SCHEMA_VERSION).toBe(15);
    });

    it('refuses to bump a record already AT the anchor version (15)', () => {
      const result = bumpLegacyDeepMessageCountDefault({ deepMessageCount: 1500 }, 15);
      expect(result.deepMessageCount).toBe(1500);
    });

    it('refuses to bump a HYPOTHETICAL future-version record (16) — the E45 regression', () => {
      // With the buggy `>= STORAGE_SCHEMA_VERSION` guard this would re-fire once
      // the schema advances past 15; the fixed anchor keeps it inert.
      const result = bumpLegacyDeepMessageCountDefault({ deepMessageCount: 1500 }, 16);
      expect(result.deepMessageCount).toBe(1500);
    });

    it('bumps a genuinely pre-v15 record carrying the old default (1500 → 3000)', () => {
      expect(bumpLegacyDeepMessageCountDefault({ deepMessageCount: 1500 }, 13).deepMessageCount).toBe(3000);
      expect(bumpLegacyDeepMessageCountDefault({ deepMessageCount: 1500 }, 14).deepMessageCount).toBe(3000);
    });

    it('preserves a pre-v15 record with a non-default value (1499 stays 1499)', () => {
      expect(bumpLegacyDeepMessageCountDefault({ deepMessageCount: 1499 }, 14).deepMessageCount).toBe(1499);
    });
  });

  it('v15: adds coach fields with defaults when absent from an older record', () => {
    const result = migrateState({
      schemaVersion: 13,
      settings: { debugMode: true },
    });
    expect(result.settings.coachHistoryLimit).toBe(createDefaultSettings().coachHistoryLimit);
    expect(result.settings.coachAutoRecap).toBe('off');
  });

  it('v15: preserves stored coach fields and coerces junk coachAutoRecap on migration', () => {
    const kept = migrateState({
      schemaVersion: 14,
      settings: { coachHistoryLimit: 5, coachAutoRecap: 'full' },
    });
    expect(kept.settings.coachHistoryLimit).toBe(5);
    expect(kept.settings.coachAutoRecap).toBe('full');

    const junk = migrateState({
      schemaVersion: 14,
      settings: { coachAutoRecap: 'weekly' },
    });
    expect(junk.settings.coachAutoRecap).toBe('off');
  });

  it('v15: default settings carry the coach fields and the 3000 deep window', () => {
    const defaults = createDefaultSettings();
    expect(defaults.deepMessageCount).toBe(3000);
    expect(defaults.coachHistoryLimit).toBe(10);
    expect(defaults.coachAutoRecap).toBe('off');
  });




  it('carries forward source-scoped summary:* keys during migration', () => {
    const legacy = {
      schemaVersion: 0,
      'summary:group1': { summary: 'cached', personalityId: 'p1', personaDefinitionId: 'v1:persona-one-definition', personalityUpdatedAt: 100, personaCatalogSource: 'source-a', generatedAt: 200 },
    };
    const result = migrateState(legacy);
    expect((result as unknown as Record<string, unknown>)['summary:group1']).toBeDefined();
  });

  it('drops corrupt summary cache entries during migration', () => {
    const result = migrateState({
      schemaVersion: 0,
      'summary:valid': {
        summary: 'cached',
        personalityId: 'p1',
        personaDefinitionId: 'v1:persona-one-definition',
        personalityUpdatedAt: 100,
        personaCatalogSource: 'source-a',
        generatedAt: 200,
      },
      'summary:corrupt': {
        summary: 'missing required metadata',
      },
    });

    expect((result as unknown as Record<string, unknown>)['summary:valid']).toBeDefined();
    expect((result as unknown as Record<string, unknown>)['summary:corrupt']).toBeUndefined();
  });

  it('preserves agency hub sync metadata in legacy summary cache entries', () => {
    const legacy = {
      schemaVersion: 0,
      'summary:group1': {
        summary: 'cached',
        personalityId: 'p1',
        personaDefinitionId: 'v1:persona-one-definition',
        personalityUpdatedAt: 100,
        personaCatalogSource: 'source-a',
        generatedAt: 200,
        fanAccountId: 'fan-1',
        agencyHubSync: {
          baseUrl: 'http://localhost:3000',
          pageLabel: 'creator-fs',
          generatedAt: 200,
          syncedAt: 300,
        },
      },
    };
    const result = migrateState(legacy);
    expect((result as unknown as Record<string, SummaryCacheEntry>)['summary:group1']).toMatchObject({
      fanAccountId: 'fan-1',
      agencyHubSync: {
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
      },
    });
  });

  it('interprets legacy success-only agency hub metadata as saved', () => {
    const legacy = {
      schemaVersion: 0,
      'summary:group1': {
        summary: 'cached',
        personalityId: 'p1',
        personaDefinitionId: 'v1:persona-one-definition',
        personalityUpdatedAt: 100,
        personaCatalogSource: 'source-a',
        generatedAt: 200,
        agencyHubSync: {
          baseUrl: 'http://localhost:3000',
          pageLabel: 'creator-fs',
          generatedAt: 200,
          syncedAt: 300,
        },
      },
    };

    const result = migrateState(legacy);
    const entry = (result as unknown as Record<string, SummaryCacheEntry>)['summary:group1'];
    expect(entry).toBeDefined();
    if (!entry) {
      throw new Error('Expected migrated summary cache entry');
    }
    expect(normalizeAgencyHubSummarySyncMetadata(entry.agencyHubSync)).toMatchObject({
      state: 'saved',
      baseUrl: 'http://localhost:3000',
      pageLabel: 'creator-fs',
      generatedAt: 200,
      syncedAt: 300,
    });
  });

  it('defaults knownAccounts to empty array when missing or non-array', () => {
    const result1 = migrateState({ schemaVersion: STORAGE_SCHEMA_VERSION, settings: createDefaultSettings(), personalities: [], accountMappings: {} });
    expect(result1.accountAliases).toEqual({});
    expect(result1.knownAccounts).toEqual([]);

    const result2 = migrateState({ schemaVersion: STORAGE_SCHEMA_VERSION, settings: createDefaultSettings(), personalities: [], accountMappings: {}, knownAccounts: 'not-array' });
    expect(result2.accountAliases).toEqual({});
    expect(result2.knownAccounts).toEqual([]);
  });
});

// ─── sanitizeSettings ───────────────────────────────────────────────────

describe('sanitizeSettings', () => {
  it('clamps quickMessageCount within bounds', () => {
    const result = storage.sanitizeSettings({ quickMessageCount: 999 });
    expect(result.quickMessageCount).toBe(200);
  });

  it('clamps pingMessageCount within bounds', () => {
    const result = storage.sanitizeSettings({ pingMessageCount: 999 });
    expect(result.pingMessageCount).toBe(200);
  });

  it('clamps deepMessageCount within bounds', () => {
    const result = storage.sanitizeSettings({ deepMessageCount: 1 });
    expect(result.deepMessageCount).toBe(100);
  });

  it('clamps deepMessageCount to the configured max', () => {
    const result = storage.sanitizeSettings({ deepMessageCount: 9999 });
    expect(result.deepMessageCount).toBe(3000);
  });

  it('clamps improveMessageCount within bounds', () => {
    const result = storage.sanitizeSettings({ improveMessageCount: 999 });
    expect(result.improveMessageCount).toBe(200);
  });

  it('keeps valid uiTheme values and falls back to system for junk', () => {
    expect(storage.sanitizeSettings({ uiTheme: 'dark' }).uiTheme).toBe('dark');
    expect(storage.sanitizeSettings({ uiTheme: 'light' }).uiTheme).toBe('light');
    expect(
      storage.sanitizeSettings({ uiTheme: 'neon' as unknown as 'dark' }).uiTheme,
    ).toBe('system');
  });

  it('clamps coachHistoryLimit within [1, 20]', () => {
    expect(storage.sanitizeSettings({ coachHistoryLimit: 0 }).coachHistoryLimit).toBe(1);
    expect(storage.sanitizeSettings({ coachHistoryLimit: 21 }).coachHistoryLimit).toBe(20);
    expect(storage.sanitizeSettings({ coachHistoryLimit: 7 }).coachHistoryLimit).toBe(7);
  });

  it('normalizes a fractional coachHistoryLimit to a whole integer', () => {
    // Turn count must persist as an integer — round to nearest, then clamp.
    expect(storage.sanitizeSettings({ coachHistoryLimit: 1.5 }).coachHistoryLimit).toBe(2);
    expect(storage.sanitizeSettings({ coachHistoryLimit: 1.4 }).coachHistoryLimit).toBe(1);
    expect(storage.sanitizeSettings({ coachHistoryLimit: 10.6 }).coachHistoryLimit).toBe(11);
    // Rounding runs before the clamp: 20.4 rounds to 20 (in range), 20.6 rounds
    // to 21 then clamps back to the 20 ceiling.
    expect(storage.sanitizeSettings({ coachHistoryLimit: 20.6 }).coachHistoryLimit).toBe(20);
    for (const value of [1.5, 3.2, 9.9, 12.5, 19.999]) {
      expect(
        Number.isInteger(storage.sanitizeSettings({ coachHistoryLimit: value }).coachHistoryLimit),
      ).toBe(true);
    }
  });

  it('falls back to the coachHistoryLimit default for a NaN-producing value', () => {
    const result = storage.sanitizeSettings({
      coachHistoryLimit: 'abc' as unknown as number,
    });
    expect(result.coachHistoryLimit).toBe(createDefaultSettings().coachHistoryLimit);
    expect(Number.isFinite(result.coachHistoryLimit)).toBe(true);
  });

  it('keeps valid coachAutoRecap values and falls back to off for junk', () => {
    expect(storage.sanitizeSettings({ coachAutoRecap: 'off' }).coachAutoRecap).toBe('off');
    expect(storage.sanitizeSettings({ coachAutoRecap: 'short' }).coachAutoRecap).toBe('short');
    expect(storage.sanitizeSettings({ coachAutoRecap: 'full' }).coachAutoRecap).toBe('full');
    expect(
      storage.sanitizeSettings({
        coachAutoRecap: 'weekly' as unknown as 'off',
      }).coachAutoRecap,
    ).toBe('off');
  });

  it('fills coach field defaults when missing', () => {
    const result = storage.sanitizeSettings({});
    expect(result.coachHistoryLimit).toBe(createDefaultSettings().coachHistoryLimit);
    expect(result.coachAutoRecap).toBe('off');
  });

  it('trims API key', () => {
    const result = storage.sanitizeSettings({ agencyHubApiKey: '  hub-key  ' });
    expect(result.agencyHubApiKey).toBe('hub-key');
  });

  it('canonicalizes the Agency Hub base URL and trims its API key', () => {
    const result = storage.sanitizeSettings({
      agencyHubBaseUrl: ' https://hub.example.com/base/ ',
      agencyHubApiKey: '  hub-key  ',
      agencyHubDeviceToken: '',
    });
    expect(result.agencyHubBaseUrl).toBe('https://hub.example.com/base');
    expect(result.agencyHubApiKey).toBe('hub-key');
  });

  it('fills defaults for missing fields', () => {
    const result = storage.sanitizeSettings({});
    expect(result.pingMessageCount).toBe(createDefaultSettings().pingMessageCount);
    expect(result.debugMode).toBe(false);
    expect(result.improveMessageCount).toBe(createDefaultSettings().improveMessageCount);
    expect(result.promptCachingEnabled).toBe(true);
  });

  it('defaults promptCachingEnabled to true for legacy settings', () => {
    const result = storage.sanitizeSettings({
      debugMode: false,
    });
    expect(result.promptCachingEnabled).toBe(true);
  });

  it('preserves explicit promptCachingEnabled values', () => {
    const result = storage.sanitizeSettings({
      promptCachingEnabled: false,
    });
    expect(result.promptCachingEnabled).toBe(false);
  });



  it('Stage 32 (v9): drops vendor keys and model selections from old records', () => {
    const result = migrateState({
      schemaVersion: 8,
      settings: {
        claudeApiKey: 'sk-ant-legacy',
        openRouterApiKey: 'or-legacy',
        featureModels: { 'fast-reply': 'anthropic:claude-haiku-4-5' },
        featureReasoning: { 'fast-reply': 'max' },
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'hub-key',
      },
    });
    const dumped = JSON.stringify(result.settings);
    expect(dumped).not.toContain('sk-ant-legacy');
    expect(dumped).not.toContain('or-legacy');
    expect(dumped).not.toContain('featureModels');
    expect(dumped).not.toContain('featureReasoning');
    expect(result.settings.agencyHubApiKey).toBe('hub-key');
  });
  it('falls back to default when quickMessageCount is NaN-producing string', () => {
    const result = storage.sanitizeSettings({ quickMessageCount: 'abc' as unknown as number });
    const defaults = createDefaultSettings();
    expect(result.quickMessageCount).toBe(defaults.quickMessageCount);
    expect(Number.isFinite(result.quickMessageCount)).toBe(true);
  });

  it('falls back to default when pingMessageCount is NaN-producing string', () => {
    const result = storage.sanitizeSettings({ pingMessageCount: 'abc' as unknown as number });
    const defaults = createDefaultSettings();
    expect(result.pingMessageCount).toBe(defaults.pingMessageCount);
    expect(Number.isFinite(result.pingMessageCount)).toBe(true);
  });

  it('falls back to default when deepMessageCount is NaN-producing string', () => {
    const result = storage.sanitizeSettings({ deepMessageCount: 'not-a-number' as unknown as number });
    const defaults = createDefaultSettings();
    expect(result.deepMessageCount).toBe(defaults.deepMessageCount);
    expect(Number.isFinite(result.deepMessageCount)).toBe(true);
  });

  it('still clamps valid numeric strings', () => {
    const result = storage.sanitizeSettings({ quickMessageCount: '999' as unknown as number });
    expect(result.quickMessageCount).toBe(200);
  });
});

// ─── loadStorageState ───────────────────────────────────────────────────

describe('loadStorageState', () => {
  it('returns migrated state from storage', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    };
    const result = await storage.loadStorageState();
    expect(result.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
  });

  it('persists migration result when schema version differs', async () => {
    mockStorage = { schemaVersion: 0 };
    await storage.loadStorageState();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test mock access
    const setBrowser = (globalThis as unknown as Record<string, any>).browser;
    expect(setBrowser.storage.local.set).toHaveBeenCalled();
  });

  it('removes corrupt summary cache entries from browser storage during load cleanup', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: createBundledPersonalities(),
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
      'summary:valid': {
        summary: 'cached',
        personalityId: 'p1',
        personaDefinitionId: 'v1:persona-one-definition',
        personalityUpdatedAt: 100,
        personaCatalogSource: 'source-a',
        generatedAt: 200,
      } as SummaryCacheEntry,
      'summary:corrupt': {
        summary: 'missing required metadata',
        personalityId: 'p1',
      },
    };

    const result = await storage.loadStorageState();

    expect((result as unknown as Record<string, unknown>)['summary:valid']).toBeDefined();
    expect((result as unknown as Record<string, unknown>)['summary:corrupt']).toBeUndefined();
    expect(mockStorage['summary:valid']).toBeDefined();
    expect(mockStorage['summary:corrupt']).toBeUndefined();
    expect(
      (globalThis as unknown as { browser: { storage: { local: { remove: unknown } } } })
        .browser.storage.local.remove,
    ).toHaveBeenCalledWith(
      'summary:corrupt',
    );
  });

  it('keeps an empty legacy personalities array unchanged', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    };

    const result = await storage.loadStorageState();
    expect(result.personalities).toEqual([]);
    expect(mockStorage.personalities).toEqual([]);
  });

  it('does not normalize, repair, or overwrite legacy persona definitions', async () => {
    const [bundledLora] = createBundledPersonalities();
    if (!bundledLora) {
      throw new Error('Expected bundled Lora personality');
    }
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [
        {
          ...bundledLora,
          name: '  User Edited Lora  ',
          content: '',
          updatedAt: bundledLora.updatedAt + 123,
          builtinVersion: (bundledLora.builtinVersion ?? 1) - 1,
        },
        { id: 'large', name: 'Large', content: 'x'.repeat(100_000), updatedAt: 1 },
      ],
      accountMappings: {},
      knownAccounts: [],
    };

    const result = await storage.loadStorageState();

    expect(result.personalities).toEqual(mockStorage.personalities);
    expect(result.personalities[0]).toMatchObject({
      id: BUNDLED_LORA_PERSONALITY_ID,
      name: '  User Edited Lora  ',
      content: '',
      builtinVersion: BUNDLED_LORA_PERSONALITY_VERSION - 1,
    });
  });
});

// ─── saveAccountMapping ─────────────────────────────────────────────────

describe('saveAccountMapping', () => {
  const usablePersonality: Personality = {
    id: 'p1',
    name: 'Custom',
    content: 'Reply naturally',
    updatedAt: 1,
  };
  const activeCatalog = [{
    key: 'p1',
    displayName: 'Custom',
    definitionId: 'v1:persona-one-definition',
    version: 1,
    status: 'active' as const,
  }];

  it('adds a mapping when personalityId is provided', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [usablePersonality],
      personaCatalog: activeCatalog,
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };
    await storage.saveAccountMapping('acc1', 'p1');
    expect((mockStorage.accountMappings as Record<string, string>).acc1).toBe('p1');
  });

  it('stores mappings under the canonical account id when a legacy alias exists', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [usablePersonality],
      personaCatalog: activeCatalog,
      accountMappings: {
        legacy: 'stale',
      },
      accountAliases: {
        legacy: 'resolved',
      },
      knownAccounts: [],
    };

    await storage.saveAccountMapping('legacy', 'p1');

    expect(mockStorage.accountMappings).toEqual({
      resolved: 'p1',
    });
  });

  it('removes a mapping when personalityId is null', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: { acc1: 'p1' },
      accountAliases: {},
      knownAccounts: [],
    };
    await storage.saveAccountMapping('acc1', null);
    expect((mockStorage.accountMappings as Record<string, string>).acc1).toBeUndefined();
  });

  it('rejects mappings to missing or archived server personas', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [{ ...usablePersonality, content: '   ' }],
      personaCatalog: [{ ...activeCatalog[0]!, status: 'archived' }],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };

    await expect(storage.saveAccountMapping('acc1', 'p1')).rejects.toThrow('archived');
    await expect(storage.saveAccountMapping('acc1', 'missing')).rejects.toThrow('missing');
    expect(mockStorage.accountMappings).toEqual({});
  });
});

// ─── registerKnownAccount ───────────────────────────────────────────────

describe('registerKnownAccount', () => {
  it('adds new account and sorts', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: ['b'],
    };
    await storage.registerKnownAccount('a');
    expect(mockStorage.knownAccounts).toEqual(['a', 'b']);
  });

  it('does not add duplicate', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: ['a'],
    };
    await storage.registerKnownAccount('a');
    expect(mockStorage.knownAccounts).toEqual(['a']);
  });
});

// ─── rekeyAccountIdentity ───────────────────────────────────────────────

describe('rekeyAccountIdentity', () => {
  it('migrates mapping from legacy to resolved id', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: { legacy: 'p1' },
      accountAliases: {},
      knownAccounts: ['legacy'],
    };
    const result = await storage.rekeyAccountIdentity('legacy', 'resolved');
    expect(result.mappingMigrated).toBe(true);
    expect(result.state.accountMappings.resolved).toBe('p1');
    expect(result.state.accountMappings.legacy).toBeUndefined();
    expect(result.state.accountAliases).toEqual({ legacy: 'resolved' });
    expect(result.state.knownAccounts).toEqual(['resolved']);
  });

  it('handles conflict when both have mappings (resolved wins)', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: { legacy: 'p1', resolved: 'p2' },
      accountAliases: {},
      knownAccounts: [],
    };
    const result = await storage.rekeyAccountIdentity('legacy', 'resolved');
    expect(result.mappingConflict).toBe(true);
    expect(result.state.accountMappings.resolved).toBe('p2');
    expect(result.state.accountMappings.legacy).toBeUndefined();
    expect(result.state.accountAliases).toEqual({ legacy: 'resolved' });
  });

  it('no-ops when ids are equal', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      knownAccounts: [],
    };
    const result = await storage.rekeyAccountIdentity('same', 'same');
    expect(result.mappingMigrated).toBe(false);
    expect(result.mappingConflict).toBe(false);
    expect(result.state.accountAliases).toEqual({});
  });
});

// ─── reconcileKnownAccounts ─────────────────────────────────────────────

describe('reconcileKnownAccounts', () => {
  it('prunes stale unmapped accounts from polluted storage', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: {},
      knownAccounts: ['active', 'stale'],
    };

    const result = await storage.reconcileKnownAccounts(['active']);

    expect(result.knownAccounts).toEqual(['active']);
    expect(mockStorage.knownAccounts).toEqual(['active']);
  });

  it('keeps mapped but disconnected accounts in knownAccounts', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: {
        mappedOffline: 'p1',
      },
      knownAccounts: ['mappedOffline', 'stale'],
    };

    const result = await storage.reconcileKnownAccounts(['active']);

    expect(result.knownAccounts).toEqual(['active', 'mappedOffline']);
    expect(mockStorage.knownAccounts).toEqual(['active', 'mappedOffline']);
  });
});

// ─── Summary cache ──────────────────────────────────────────────────────

describe('summary cache', () => {
  it('returns null when no summary is cached', async () => {
    const result = await storage.getSummaryCache('group-xyz');
    expect(result).toBeNull();
  });

  it('round-trips saveSummaryCache → getSummaryCache', async () => {
    const entry: SummaryCacheEntry = {
      summary: 'Fan is engaged',
      personalityId: 'p1',
      personaDefinitionId: 'v1:persona-one-definition',
      personalityUpdatedAt: 1000,
      personaCatalogSource: null,
      generatedAt: 5000,
      fanAccountId: 'fan-1',
      agencyHubSync: {
        baseUrl: 'http://localhost:3000',
        pageLabel: 'creator-fs',
        generatedAt: 5000,
        syncedAt: 6000,
      },
    };
    await storage.saveSummaryCache('group-abc', entry);
    const result = await storage.getSummaryCache('group-abc');
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('Fan is engaged');
    expect(result!.fanAccountId).toBe('fan-1');
    expect(result!.agencyHubSync?.pageLabel).toBe('creator-fs');
  });

  it('removes summary cache entry', async () => {
    mockStorage = { 'summary:group-1': { summary: 'test', personalityId: 'p1', personalityUpdatedAt: 100, generatedAt: 200 } };
    await storage.removeSummaryCache('group-1');
    expect(mockStorage['summary:group-1']).toBeUndefined();
  });
});
