import {
  DEFAULT_CLAUDE_PROVIDER,
  DEEP_DEFAULT_MESSAGE_COUNT,
  DEFAULT_FEATURE_MODELS,
  QUICK_DEFAULT_MESSAGE_COUNT,
  STORAGE_SCHEMA_VERSION,
} from './constants.js';
import type { PersistedState, Settings } from './types.js';

export function createDefaultSettings(): Settings {
  return {
    claudeProvider: DEFAULT_CLAUDE_PROVIDER,
    anthropicApiKey: '',
    kiroApiKey: '',
    quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
    deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
    debugMode: false,
    promptCachingEnabled: true,
    featureModels: { ...DEFAULT_FEATURE_MODELS },
  };
}

function migrateSettingsRecord(raw: Record<string, unknown> | null | undefined): Settings {
  const defaults = createDefaultSettings();
  const legacyClaudeApiKey =
    typeof raw?.claudeApiKey === 'string' ? raw.claudeApiKey : defaults.anthropicApiKey;

  return {
    claudeProvider: raw?.claudeProvider === 'kiro' ? 'kiro' : defaults.claudeProvider,
    anthropicApiKey: String(raw?.anthropicApiKey ?? legacyClaudeApiKey),
    kiroApiKey: String(raw?.kiroApiKey ?? defaults.kiroApiKey),
    quickMessageCount: Number(raw?.quickMessageCount ?? defaults.quickMessageCount),
    deepMessageCount: Number(raw?.deepMessageCount ?? defaults.deepMessageCount),
    debugMode: Boolean(raw?.debugMode ?? defaults.debugMode),
    promptCachingEnabled: Boolean(
      raw?.promptCachingEnabled ?? defaults.promptCachingEnabled,
    ),
    featureModels:
      raw?.featureModels && typeof raw.featureModels === 'object'
        ? raw.featureModels as Settings['featureModels']
        : defaults.featureModels,
  };
}

export function createSeedState(): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: createDefaultSettings(),
    personalities: [],
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
  };
}

/**
 * Migrate raw storage data to the current schema.
 *
 * Key difference from Codex: preserves existing data during migration
 * instead of wiping to seed state. Only creates seed state when raw
 * data is null/undefined/not-object.
 */
export function migrateState(raw: unknown): PersistedState {
  if (!raw || typeof raw !== 'object') {
    return createSeedState();
  }

  const record = raw as Record<string, unknown>;
  const schemaVersion = typeof record.schemaVersion === 'number' ? record.schemaVersion : 0;

  if (schemaVersion === STORAGE_SCHEMA_VERSION) {
    const current = record as unknown as PersistedState;
    return {
      ...current,
      accountAliases: current.accountAliases && typeof current.accountAliases === 'object'
        ? current.accountAliases
        : {},
      knownAccounts: Array.isArray(current.knownAccounts) ? current.knownAccounts : [],
    };
  }

  // Incremental migration: preserve what exists, fill in defaults for missing fields
  const defaults = createSeedState();
  const settings = record.settings && typeof record.settings === 'object'
    ? migrateSettingsRecord(record.settings as Record<string, unknown>)
    : defaults.settings;

  const personalities = Array.isArray(record.personalities) ? record.personalities : defaults.personalities;
  const accountMappings = record.accountMappings && typeof record.accountMappings === 'object'
    ? (record.accountMappings as Record<string, string>)
    : defaults.accountMappings;
  const accountAliases = record.accountAliases && typeof record.accountAliases === 'object'
    ? (record.accountAliases as Record<string, string>)
    : defaults.accountAliases;
  const knownAccounts = Array.isArray(record.knownAccounts) ? record.knownAccounts : defaults.knownAccounts;

  // Carry forward any summary:* keys
  const summaryEntries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('summary:')) {
      summaryEntries[key] = value;
    }
  }

  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: settings as Settings,
    personalities: personalities as PersistedState['personalities'],
    accountMappings,
    accountAliases,
    knownAccounts: knownAccounts as string[],
    ...summaryEntries,
  };
}
