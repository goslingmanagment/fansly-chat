import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { FeatureType, Personality, SummaryCacheEntry } from '../src/shared/types.js';
import { DEFAULT_MODEL_ID, STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import { migrateState, createDefaultSettings, createSeedState } from '../src/shared/migrations.js';

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
  it('returns seed state for null input', () => {
    const result = migrateState(null);
    expect(result.schemaVersion).toBe(STORAGE_SCHEMA_VERSION);
    expect(result.settings).toEqual(createDefaultSettings());
    expect(result.personalities).toEqual([]);
    expect(result.accountMappings).toEqual({});
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
      knownAccounts: ['acc1'],
    };
    const result = migrateState(existing);
    expect(result.settings.debugMode).toBe(true);
    expect(result.personalities).toHaveLength(1);
    expect(result.accountMappings.acc1).toBe('p1');
    expect(result.knownAccounts).toEqual(['acc1']);
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
    expect(result.personalities).toHaveLength(1);
    expect(result.personalities[0]!.name).toBe('Legacy');
    expect(result.accountMappings.acc1).toBe('p1');
  });

  it('fills in default settings for missing fields during migration', () => {
    const partial = { schemaVersion: 0, settings: { claudeApiKey: 'key' } };
    const result = migrateState(partial);
    expect(result.settings.claudeApiKey).toBe('key');
    expect(result.settings.quickMessageCount).toBe(createDefaultSettings().quickMessageCount);
    expect(result.settings.deepMessageCount).toBe(createDefaultSettings().deepMessageCount);
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
    expect(result.settings.featureModels['fan-summary']).toBe(DEFAULT_MODEL_ID);
  });

  it('carries forward summary:* keys during migration', () => {
    const legacy = {
      schemaVersion: 0,
      'summary:group1': { summary: 'cached', personalityId: 'p1', personalityUpdatedAt: 100, generatedAt: 200 },
    };
    const result = migrateState(legacy);
    expect((result as unknown as Record<string, unknown>)['summary:group1']).toBeDefined();
  });

  it('defaults knownAccounts to empty array when missing or non-array', () => {
    const result1 = migrateState({ schemaVersion: STORAGE_SCHEMA_VERSION, settings: createDefaultSettings(), personalities: [], accountMappings: {} });
    expect(result1.knownAccounts).toEqual([]);

    const result2 = migrateState({ schemaVersion: STORAGE_SCHEMA_VERSION, settings: createDefaultSettings(), personalities: [], accountMappings: {}, knownAccounts: 'not-array' });
    expect(result2.knownAccounts).toEqual([]);
  });
});

// ─── sanitizeSettings ───────────────────────────────────────────────────

describe('sanitizeSettings', () => {
  it('clamps quickMessageCount within bounds', () => {
    const result = storage.sanitizeSettings({ quickMessageCount: 999 });
    expect(result.quickMessageCount).toBe(200);
  });

  it('clamps deepMessageCount within bounds', () => {
    const result = storage.sanitizeSettings({ deepMessageCount: 1 });
    expect(result.deepMessageCount).toBe(100);
  });

  it('trims API key', () => {
    const result = storage.sanitizeSettings({ claudeApiKey: '  sk-test  ' });
    expect(result.claudeApiKey).toBe('sk-test');
  });

  it('fills defaults for missing fields', () => {
    const result = storage.sanitizeSettings({});
    expect(result.claudeApiKey).toBe('');
    expect(result.debugMode).toBe(false);
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
    expect(result.featureModels['fan-summary']).toBe(DEFAULT_MODEL_ID);
    expect(result.featureModels['ping']).toBe(DEFAULT_MODEL_ID);
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
    expect(result.featureModels['fast-reply']).toBe('claude-haiku-4-5');
    expect(result.featureModels['fan-summary']).toBe('claude-opus-4-6');
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
    expect(result.featureModels['fast-reply']).toBe('claude-haiku-4-5');
    expect(result.featureModels['help-me']).toBe(DEFAULT_MODEL_ID);
    expect(result.featureModels['fan-summary']).toBe(DEFAULT_MODEL_ID);
    expect(result.featureModels['chat-review']).toBe(DEFAULT_MODEL_ID);
    expect(result.featureModels['ping']).toBe(DEFAULT_MODEL_ID);
  });

  it('falls back to default when quickMessageCount is NaN-producing string', () => {
    const result = storage.sanitizeSettings({ quickMessageCount: 'abc' as unknown as number });
    const defaults = createDefaultSettings();
    expect(result.quickMessageCount).toBe(defaults.quickMessageCount);
    expect(Number.isFinite(result.quickMessageCount)).toBe(true);
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
    expect(result.settings.featureModels['fast-reply']).toBe('claude-haiku-4-5');
    expect(result.settings.featureModels['help-me']).toBe(DEFAULT_MODEL_ID);
    expect(result.settings.featureModels['fan-summary']).toBe(DEFAULT_MODEL_ID);
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
});

// ─── deletePersonality (cascade) ────────────────────────────────────────

describe('deletePersonality', () => {
  it('removes personality, related mappings, and related summaries', async () => {
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
    };

    await storage.deletePersonality('p1');

    expect((mockStorage.personalities as Personality[]).map((p) => p.id)).toEqual(['p2']);
    expect((mockStorage.accountMappings as Record<string, string>).acc1).toBeUndefined();
    expect((mockStorage.accountMappings as Record<string, string>).acc2).toBeUndefined();
    expect((mockStorage.accountMappings as Record<string, string>).acc3).toBe('p2');
    expect(mockStorage['summary:group1']).toBeUndefined();
    expect(mockStorage['summary:group3']).toBeUndefined();
    expect(mockStorage['summary:group2']).toBeDefined();
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
      knownAccounts: [],
    };
    await storage.saveAccountMapping('acc1', 'p1');
    expect((mockStorage.accountMappings as Record<string, string>).acc1).toBe('p1');
  });

  it('removes a mapping when personalityId is null', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: { acc1: 'p1' },
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
      knownAccounts: ['legacy'],
    };
    const result = await storage.rekeyAccountIdentity('legacy', 'resolved');
    expect(result.mappingMigrated).toBe(true);
    expect(result.state.accountMappings.resolved).toBe('p1');
    expect(result.state.accountMappings.legacy).toBeUndefined();
    expect(result.state.knownAccounts).toEqual(['resolved']);
  });

  it('handles conflict when both have mappings (resolved wins)', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: { legacy: 'p1', resolved: 'p2' },
      knownAccounts: [],
    };
    const result = await storage.rekeyAccountIdentity('legacy', 'resolved');
    expect(result.mappingConflict).toBe(true);
    expect(result.state.accountMappings.resolved).toBe('p2');
    expect(result.state.accountMappings.legacy).toBeUndefined();
  });

  it('no-ops when ids are equal', async () => {
    mockStorage = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      settings: createDefaultSettings(),
      personalities: [],
      accountMappings: {},
      knownAccounts: [],
    };
    const result = await storage.rekeyAccountIdentity('same', 'same');
    expect(result.mappingMigrated).toBe(false);
    expect(result.mappingConflict).toBe(false);
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
    };
    await storage.saveSummaryCache('group-abc', entry);
    const result = await storage.getSummaryCache('group-abc');
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('Fan is engaged');
  });

  it('removes summary cache entry', async () => {
    mockStorage = { 'summary:group-1': { summary: 'test', personalityId: 'p1', personalityUpdatedAt: 100, generatedAt: 200 } };
    await storage.removeSummaryCache('group-1');
    expect(mockStorage['summary:group-1']).toBeUndefined();
  });
});
