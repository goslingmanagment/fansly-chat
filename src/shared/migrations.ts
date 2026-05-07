import {
  DEEP_DEFAULT_MESSAGE_COUNT,
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
  IMPROVE_DEFAULT_MESSAGE_COUNT,
  PING_DEFAULT_MESSAGE_COUNT,
  QUICK_DEFAULT_MESSAGE_COUNT,
  STORAGE_SCHEMA_VERSION,
} from './constants.js';
import type { PersistedState, Settings } from './types.js';

export function createDefaultSettings(): Settings {
  return {
    claudeApiKey: '',
    openRouterApiKey: '',
    agencyHubBaseUrl: '',
    agencyHubApiKey: '',
    quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
    pingMessageCount: PING_DEFAULT_MESSAGE_COUNT,
    improveMessageCount: IMPROVE_DEFAULT_MESSAGE_COUNT,
    deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
    debugMode: false,
    promptCachingEnabled: true,
    featureModels: { ...DEFAULT_FEATURE_MODELS },
    featureReasoning: { ...DEFAULT_FEATURE_REASONING },
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

function migrateSettingsRecord(raw: Record<string, unknown> | null | undefined): Settings {
  const defaults = createDefaultSettings();
  const legacyAnthropicApiKey =
    typeof raw?.anthropicApiKey === 'string' ? raw.anthropicApiKey : defaults.claudeApiKey;
  const legacyClaudeApiKey =
    typeof raw?.claudeApiKey === 'string' && raw.claudeApiKey.trim()
      ? raw.claudeApiKey
      : legacyAnthropicApiKey;

  return {
    claudeApiKey: legacyClaudeApiKey,
    openRouterApiKey:
      typeof raw?.openRouterApiKey === 'string'
        ? raw.openRouterApiKey
        : defaults.openRouterApiKey,
    agencyHubBaseUrl:
      typeof raw?.agencyHubBaseUrl === 'string' ? raw.agencyHubBaseUrl : defaults.agencyHubBaseUrl,
    agencyHubApiKey:
      typeof raw?.agencyHubApiKey === 'string' ? raw.agencyHubApiKey : defaults.agencyHubApiKey,
    quickMessageCount: Number(raw?.quickMessageCount ?? defaults.quickMessageCount),
    pingMessageCount: Number(raw?.pingMessageCount ?? raw?.quickMessageCount ?? defaults.pingMessageCount),
    improveMessageCount: Number(raw?.improveMessageCount ?? defaults.improveMessageCount),
    deepMessageCount: Number(raw?.deepMessageCount ?? defaults.deepMessageCount),
    debugMode: Boolean(raw?.debugMode ?? defaults.debugMode),
    promptCachingEnabled: Boolean(
      raw?.promptCachingEnabled ?? defaults.promptCachingEnabled,
    ),
    featureModels:
      raw?.featureModels && typeof raw.featureModels === 'object'
        ? raw.featureModels as Settings['featureModels']
        : defaults.featureModels,
    featureReasoning:
      raw?.featureReasoning && typeof raw.featureReasoning === 'object'
        ? raw.featureReasoning as Settings['featureReasoning']
        : defaults.featureReasoning,
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
      settings:
        current.settings && typeof current.settings === 'object'
          ? migrateSettingsRecord(current.settings as unknown as Record<string, unknown>)
          : createDefaultSettings(),
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
    settings,
    personalities: personalities as PersistedState['personalities'],
    accountMappings,
    accountAliases,
    knownAccounts: knownAccounts as string[],
    ...summaryEntries,
  };
}
