import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FeatureType, Personality, SummaryCacheEntry } from '../src/shared/types.js';
import { normalizeAgencyHubSummarySyncMetadata } from '../src/shared/agency-hub.js';
import {
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
  DEFAULT_MODEL_ID,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import {
  MIGRATIONS,
  migrateState,
  createDefaultSettings,
  createSeedState,
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

// Dynamic import to ensure mock is set up before module loads
const storage = await import('../src/shared/storage.js');

beforeEach(() => {
  mockStorage = {};
  vi.clearAllMocks();
});

// ─── migrateState ───────────────────────────────────────────────────────

describe('migrateState', () => {
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
      settings: { claudeApiKey: 'sk-test', quickMessageCount: 50, deepMessageCount: 200, debugMode: true },
      personalities: [{ id: 'p1', name: 'Legacy', content: 'old', updatedAt: 500 }],
      accountMappings: { acc1: 'p1' },
    };
    const result = migrateState(legacy);
    expect(result.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(result.settings.claudeApiKey).toBe('sk-test');
    expect(result.settings.debugMode).toBe(true);
    expect(result.settings.pingMessageCount).toBe(50);
    expect(result.personalities).toHaveLength(1);
    expect(result.personalities[0]!.name).toBe('Legacy');
    expect(result.accountMappings.acc1).toBe('p1');
    expect(result.accountAliases).toEqual({});
  });

  it('fills in default settings for missing fields during migration', () => {
    const partial = { schemaVersion: 0, settings: { claudeApiKey: 'key' } };
    const result = migrateState(partial);
    expect(result.settings.claudeApiKey).toBe('key');
    expect(result.settings.quickMessageCount).toBe(createDefaultSettings().quickMessageCount);
    expect(result.settings.pingMessageCount).toBe(createDefaultSettings().pingMessageCount);
    expect(result.settings.improveMessageCount).toBe(createDefaultSettings().improveMessageCount);
    expect(result.settings.deepMessageCount).toBe(createDefaultSettings().deepMessageCount);
    expect(result.settings.featureReasoning).toEqual(DEFAULT_FEATURE_REASONING);
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

  it('seeds pingMessageCount from quickMessageCount when migrating legacy settings', () => {
    const result = migrateState({
      schemaVersion: 4,
      settings: {
        claudeApiKey: 'sk-test',
        quickMessageCount: 73,
      },
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    });

    expect(result.settings.quickMessageCount).toBe(73);
    expect(result.settings.pingMessageCount).toBe(73);
  });

  it('backfills claudeApiKey from anthropicApiKey when needed', () => {
    const result = migrateState({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: {
        anthropicApiKey: 'sk-ant-test',
      },
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    });

    expect(result.settings.claudeApiKey).toBe('sk-ant-test');
    expect((result.settings as unknown as Record<string, unknown>).anthropicApiKey).toBeUndefined();
  });

  it('preserves claudeApiKey when both key fields exist', () => {
    const result = migrateState({
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: {
        claudeApiKey: 'sk-ant-primary',
        anthropicApiKey: 'sk-ant-secondary',
      },
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    });

    expect(result.settings.claudeApiKey).toBe('sk-ant-primary');
    expect((result.settings as unknown as Record<string, unknown>).anthropicApiKey).toBeUndefined();
  });

  it('populates featureModels with defaults when migrating from schema 1', () => {
    const legacy = {
      schemaVersion: 1,
      settings: { claudeApiKey: 'sk-test', quickMessageCount: 100, deepMessageCount: 500, debugMode: false },
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    };
    const result = migrateState(legacy);
    expect(result.settings.featureModels).toBeDefined();
    expect(result.settings.featureModels['fast-reply']).toBe(DEFAULT_MODEL_ID);
    expect(result.settings.featureModels['fan-summary']).toBe(DEFAULT_FEATURE_MODELS['fan-summary']);
  });

  it('carries forward summary:* keys during migration', () => {
    const legacy = {
      schemaVersion: 0,
      'summary:group1': { summary: 'cached', personalityId: 'p1', personalityUpdatedAt: 100, generatedAt: 200 },
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
        personalityUpdatedAt: 100,
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
        personalityUpdatedAt: 100,
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
        personalityUpdatedAt: 100,
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

  it('trims API key', () => {
    const result = storage.sanitizeSettings({ claudeApiKey: '  sk-test  ' });
    expect(result.claudeApiKey).toBe('sk-test');
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
    expect(result.claudeApiKey).toBe('');
    expect(result.pingMessageCount).toBe(createDefaultSettings().pingMessageCount);
    expect(result.debugMode).toBe(false);
    expect(result.improveMessageCount).toBe(createDefaultSettings().improveMessageCount);
    expect(result.promptCachingEnabled).toBe(true);
  });

  it('defaults promptCachingEnabled to true for legacy settings', () => {
    const result = storage.sanitizeSettings({
      claudeApiKey: 'sk-test',
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

  it('defaults featureModels when missing from input', () => {
    const result = storage.sanitizeSettings({});
    expect(result.featureModels['fast-reply']).toBe(DEFAULT_MODEL_ID);
    expect(result.featureModels['fan-summary']).toBe(DEFAULT_FEATURE_MODELS['fan-summary']);
    expect(result.featureModels['ping']).toBe(DEFAULT_MODEL_ID);
  });

  it('defaults featureReasoning to medium when missing from input', () => {
    const result = storage.sanitizeSettings({});
    expect(result.featureReasoning).toEqual(DEFAULT_FEATURE_REASONING);
  });

  it('preserves valid model choices', () => {
    const result = storage.sanitizeSettings({
      featureModels: {
        'fast-reply': 'claude-haiku-4-5',
        'help-me': DEFAULT_MODEL_ID,
        'fan-summary': 'claude-opus-4-6',
        'chat-review': DEFAULT_MODEL_ID,
        'ping': DEFAULT_MODEL_ID,
      },
    });
    expect(result.featureModels['fast-reply']).toBe('anthropic:claude-haiku-4-5');
    expect(result.featureModels['fan-summary']).toBe('anthropic:claude-opus-4-6');
  });

  it('preserves valid featureReasoning choices', () => {
    const result = storage.sanitizeSettings({
      featureReasoning: {
        ...DEFAULT_FEATURE_REASONING,
        'fast-reply': 'off',
        'fan-summary': 'max',
        ping: 'low',
      },
    });
    expect(result.featureReasoning['fast-reply']).toBe('off');
    expect(result.featureReasoning['fan-summary']).toBe('max');
    expect(result.featureReasoning.ping).toBe('low');
    expect(result.featureReasoning['help-me']).toBe('medium');
  });

  it('falls back to medium for unknown featureReasoning values', () => {
    const result = storage.sanitizeSettings({
      featureReasoning: {
        ...DEFAULT_FEATURE_REASONING,
        'fast-reply': 'turbo',
      } as unknown as typeof DEFAULT_FEATURE_REASONING,
    });
    expect(result.featureReasoning['fast-reply']).toBe('medium');
  });

  it('preserves provider-aware OpenRouter model choices', () => {
    const result = storage.sanitizeSettings({
      featureModels: {
        ...DEFAULT_FEATURE_MODELS,
        'fast-reply': 'openrouter:x-ai/grok-4.3',
      },
    });

    expect(result.featureModels['fast-reply']).toBe('openrouter:x-ai/grok-4.3');
  });

  it('preserves the OpenRouter API key', () => {
    const result = storage.sanitizeSettings({
      openRouterApiKey: '  sk-or-v1-test  ',
    });

    expect(result.openRouterApiKey).toBe('sk-or-v1-test');
  });

  it('falls back to default for unknown model IDs', () => {
    const result = storage.sanitizeSettings({
      featureModels: {
        'fast-reply': 'claude-nonexistent-model',
        'help-me': DEFAULT_MODEL_ID,
        'fan-summary': DEFAULT_MODEL_ID,
        'chat-review': DEFAULT_MODEL_ID,
        'ping': DEFAULT_MODEL_ID,
      },
    });
    expect(result.featureModels['fast-reply']).toBe(DEFAULT_MODEL_ID);
  });

  it('fills missing feature keys from defaults in partial featureModels', () => {
    const result = storage.sanitizeSettings({
      featureModels: {
        'fast-reply': 'claude-haiku-4-5',
      } as Record<FeatureType, string>,
    });
    expect(result.featureModels['fast-reply']).toBe('anthropic:claude-haiku-4-5');
    expect(result.featureModels['help-me']).toBe(DEFAULT_MODEL_ID);
    expect(result.featureModels['fan-summary']).toBe(DEFAULT_FEATURE_MODELS['fan-summary']);
    expect(result.featureModels['chat-review']).toBe(DEFAULT_MODEL_ID);
    expect(result.featureModels['ping']).toBe(DEFAULT_MODEL_ID);
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
        personalityUpdatedAt: 100,
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

  it('seeds bundled Lora when storage has no personalities', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    };

    const result = await storage.loadStorageState();
    const [bundledLora] = createBundledPersonalities();

    expect(result.personalities).toEqual([bundledLora]);
    expect(mockStorage.personalities).toEqual([bundledLora]);
  });

  it('preserves modified bundled personalities until the bundled version changes', async () => {
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
          content: 'customized by user',
          updatedAt: bundledLora.updatedAt + 123,
        },
      ],
      accountMappings: {},
      knownAccounts: [],
    };

    const result = await storage.loadStorageState();

    expect(result.personalities[0]).toMatchObject({
      id: BUNDLED_LORA_PERSONALITY_ID,
      builtin: true,
      builtinVersion: BUNDLED_LORA_PERSONALITY_VERSION,
      content: 'customized by user',
    });
  });

  it('re-adds bundled Lora when other personalities exist but the bundled entry is missing', async () => {
    const [bundledLora] = createBundledPersonalities();
    if (!bundledLora) {
      throw new Error('Expected bundled Lora personality');
    }
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [
        { id: 'custom-1', name: 'Custom', content: 'custom', updatedAt: 1000 },
      ],
      accountMappings: {},
      knownAccounts: [],
    };

    const result = await storage.loadStorageState();

    expect(result.personalities).toEqual([
      { id: 'custom-1', name: 'Custom', content: 'custom', updatedAt: 1000 },
      bundledLora,
    ]);
    expect(mockStorage.personalities).toEqual([
      { id: 'custom-1', name: 'Custom', content: 'custom', updatedAt: 1000 },
      bundledLora,
    ]);
  });

  it('overwrites modified bundled personalities when the bundled version changes', async () => {
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
          name: 'User Edited Lora',
          content: 'customized by user',
          updatedAt: bundledLora.updatedAt + 123,
          builtinVersion: bundledLora.builtinVersion! - 1,
        },
      ],
      accountMappings: {},
      knownAccounts: [],
    };

    const result = await storage.loadStorageState();

    expect(result.personalities).toEqual([bundledLora]);
    expect(mockStorage.personalities).toEqual([bundledLora]);
  });

  it('deep-merges featureModels on load even when schema matches', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: {
        ...createDefaultSettings(),
        featureModels: { 'fast-reply': 'claude-haiku-4-5' },
      },
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    };
    const result = await storage.loadStorageState();
    expect(result.settings.featureModels['fast-reply']).toBe('anthropic:claude-haiku-4-5');
    expect(result.settings.featureModels['help-me']).toBe(DEFAULT_MODEL_ID);
    expect(result.settings.featureModels['fan-summary']).toBe(DEFAULT_FEATURE_MODELS['fan-summary']);
  });

  it('deep-merges featureReasoning on load even when schema matches', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: {
        ...createDefaultSettings(),
        featureReasoning: { 'fast-reply': 'off' },
      },
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    };
    const result = await storage.loadStorageState();
    expect(result.settings.featureReasoning['fast-reply']).toBe('off');
    expect(result.settings.featureReasoning['help-me']).toBe('medium');
    expect(result.settings.featureReasoning['fan-summary']).toBe('medium');
  });
});

// ─── savePersonalities ──────────────────────────────────────────────────

describe('savePersonalities', () => {
  it('normalizes personality names (trim, default to Unnamed)', async () => {
    const personalities: Personality[] = [
      { id: 'p1', name: '  ', content: 'test', updatedAt: 1000 },
      { id: 'p2', name: '  Trimmed  ', content: 'test', updatedAt: 1000 },
    ];
    const result = await storage.savePersonalities(personalities);
    expect(result[0]!.name).toBe('Unnamed');
    expect(result[1]!.name).toBe('Trimmed');
  });

  it('seeds bundled Lora when saving an empty personalities list', async () => {
    const result = await storage.savePersonalities([]);

    expect(result).toEqual(createBundledPersonalities());
    expect(mockStorage.personalities).toEqual(createBundledPersonalities());
  });

  it('re-adds bundled Lora when saving a custom-only personality list', async () => {
    const [bundledLora] = createBundledPersonalities();
    if (!bundledLora) {
      throw new Error('Expected bundled Lora personality');
    }

    const result = await storage.savePersonalities([
      { id: 'p1', name: 'Custom', content: 'test', updatedAt: 1000 },
    ]);

    expect(result).toEqual([
      { id: 'p1', name: 'Custom', content: 'test', updatedAt: 1000 },
      bundledLora,
    ]);
    expect(mockStorage.personalities).toEqual([
      { id: 'p1', name: 'Custom', content: 'test', updatedAt: 1000 },
      bundledLora,
    ]);
  });
});

// ─── deletePersonality (cascade) ────────────────────────────────────────

describe('deletePersonality', () => {
  it('removes personality, related mappings, and related summaries', async () => {
    const [bundledLora] = createBundledPersonalities();
    if (!bundledLora) {
      throw new Error('Expected bundled Lora personality');
    }
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [
        { id: 'p1', name: 'ToDelete', content: 'x', updatedAt: 1000 },
        { id: 'p2', name: 'Keep', content: 'y', updatedAt: 1000 },
      ],
      accountMappings: { acc1: 'p1', acc2: 'p1', acc3: 'p2' },
      knownAccounts: [],
      'summary:group1': { summary: 'sum1', personalityId: 'p1', personalityUpdatedAt: 1000, generatedAt: 2000 } as SummaryCacheEntry,
      'summary:group2': { summary: 'sum2', personalityId: 'p2', personalityUpdatedAt: 1000, generatedAt: 2000 } as SummaryCacheEntry,
      'summary:group3': { summary: 'sum3', personalityId: 'p1', personalityUpdatedAt: 1000, generatedAt: 3000 } as SummaryCacheEntry,
      'summary:corrupt-group': { summary: 'bad', personalityId: 'p1' },
    };

    await storage.deletePersonality('p1');

    expect(mockStorage.personalities).toEqual([
      { id: 'p2', name: 'Keep', content: 'y', updatedAt: 1000 },
      bundledLora,
    ]);
    expect((mockStorage.accountMappings as Record<string, string>).acc1).toBeUndefined();
    expect((mockStorage.accountMappings as Record<string, string>).acc2).toBeUndefined();
    expect((mockStorage.accountMappings as Record<string, string>).acc3).toBe('p2');
    expect(mockStorage['summary:group1']).toBeUndefined();
    expect(mockStorage['summary:group3']).toBeUndefined();
    expect(mockStorage['summary:corrupt-group']).toBeUndefined();
    expect(mockStorage['summary:group2']).toBeDefined();
  });

  it('does not delete bundled personalities or their related state', async () => {
    const [bundledLora] = createBundledPersonalities();
    if (!bundledLora) {
      throw new Error('Expected bundled Lora personality');
    }

    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [bundledLora],
      accountMappings: { acc1: bundledLora.id },
      knownAccounts: [],
      'summary:group1': {
        summary: 'sum1',
        personalityId: bundledLora.id,
        personalityUpdatedAt: bundledLora.updatedAt,
        generatedAt: 2000,
      } as SummaryCacheEntry,
    };

    await storage.deletePersonality(bundledLora.id);

    expect(mockStorage.personalities).toEqual([bundledLora]);
    expect(mockStorage.accountMappings).toEqual({ acc1: bundledLora.id });
    expect(mockStorage['summary:group1']).toBeDefined();
  });
});

// ─── saveAccountMapping ─────────────────────────────────────────────────

describe('saveAccountMapping', () => {
  it('adds a mapping when personalityId is provided', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
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
      personalities: [],
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
      personalityUpdatedAt: 1000,
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
