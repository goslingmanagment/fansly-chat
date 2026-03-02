import {
  DEEP_DEFAULT_MESSAGE_COUNT,
  QUICK_DEFAULT_MESSAGE_COUNT,
  STORAGE_SCHEMA_VERSION,
} from './constants.js';
import type { PersistedState, Settings } from './types.js';

export function createDefaultSettings(): Settings {
  return {
    claudeApiKey: '',
    quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
    deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
    debugMode: false,
  };
}

export function createSeedState(): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: createDefaultSettings(),
    personalities: [],
    accountMappings: {},
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
      knownAccounts: Array.isArray(current.knownAccounts) ? current.knownAccounts : [],
    };
  }

  // Incremental migration: preserve what exists, fill in defaults for missing fields
  const defaults = createSeedState();
  const settings = record.settings && typeof record.settings === 'object'
    ? { ...defaults.settings, ...(record.settings as Partial<Settings>) }
    : defaults.settings;

  const personalities = Array.isArray(record.personalities) ? record.personalities : defaults.personalities;
  const accountMappings = record.accountMappings && typeof record.accountMappings === 'object'
    ? (record.accountMappings as Record<string, string>)
    : defaults.accountMappings;
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
    knownAccounts: knownAccounts as string[],
    ...summaryEntries,
  };
}
