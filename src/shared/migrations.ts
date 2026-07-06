import {
  DEEP_DEFAULT_MESSAGE_COUNT,
  IMPROVE_DEFAULT_MESSAGE_COUNT,
  PING_DEFAULT_MESSAGE_COUNT,
  QUICK_DEFAULT_MESSAGE_COUNT,
  STORAGE_SCHEMA_VERSION,
} from './constants.js';
import { collectSummaryCacheEntries } from './summary-cache.js';
import type { PersistedState, Settings } from './types.js';

export function createDefaultSettings(): Settings {
  return {
    agencyHubBaseUrl: '',
    agencyHubApiKey: '',
    agencyHubDeviceToken: '',
    quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
    pingMessageCount: PING_DEFAULT_MESSAGE_COUNT,
    improveMessageCount: IMPROVE_DEFAULT_MESSAGE_COUNT,
    deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
    debugMode: false,
    promptCachingEnabled: true,
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
  // Stage 32 (v9): vendor keys and model/reasoning selections are DROPPED —
  // AI rides the kernel; models are kernel config. Old fields fall away here.
  return {
    agencyHubBaseUrl:
      typeof raw?.agencyHubBaseUrl === 'string' ? raw.agencyHubBaseUrl : defaults.agencyHubBaseUrl,
    agencyHubApiKey:
      typeof raw?.agencyHubApiKey === 'string' ? raw.agencyHubApiKey : defaults.agencyHubApiKey,
    agencyHubDeviceToken:
      typeof raw?.agencyHubDeviceToken === 'string'
        ? raw.agencyHubDeviceToken
        : defaults.agencyHubDeviceToken,
    quickMessageCount: Number(raw?.quickMessageCount ?? defaults.quickMessageCount),
    pingMessageCount: Number(raw?.pingMessageCount ?? raw?.quickMessageCount ?? defaults.pingMessageCount),
    improveMessageCount: Number(raw?.improveMessageCount ?? defaults.improveMessageCount),
    deepMessageCount: Number(raw?.deepMessageCount ?? defaults.deepMessageCount),
    debugMode: Boolean(raw?.debugMode ?? defaults.debugMode),
    promptCachingEnabled: Boolean(
      raw?.promptCachingEnabled ?? defaults.promptCachingEnabled,
    ),
  };
}

type MigrationRecord = Record<string, unknown>;

export interface MigrationStep {
  toVersion: number;
  migrate: (record: MigrationRecord) => MigrationRecord;
}

function normalizePersistedRecord(
  record: MigrationRecord,
  schemaVersion: number,
): PersistedState {
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

  return {
    schemaVersion,
    settings,
    personalities: personalities as PersistedState['personalities'],
    accountMappings,
    accountAliases,
    knownAccounts: knownAccounts as string[],
    ...collectSummaryCacheEntries(record),
  };
}

export const MIGRATIONS: readonly MigrationStep[] = [
  {
    toVersion: STORAGE_SCHEMA_VERSION,
    migrate: (record) =>
      normalizePersistedRecord(record, STORAGE_SCHEMA_VERSION) as unknown as MigrationRecord,
  },
];

function applyMigrations(
  record: MigrationRecord,
  schemaVersion: number,
): PersistedState {
  let state: MigrationRecord = record;
  let migrated = false;

  for (const migration of MIGRATIONS) {
    if (schemaVersion >= migration.toVersion) {
      continue;
    }
    state = migration.migrate(state);
    migrated = true;
  }

  return migrated
    ? state as unknown as PersistedState
    : normalizePersistedRecord(record, STORAGE_SCHEMA_VERSION);
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
    // Guard personalities/accountMappings the same way the incremental branch
    // does: a corrupt value at the current version (e.g. a non-array after a
    // partial storage.set) would otherwise reach reconcileBundledPersonalities
    // and throw, bricking every load including the settings UI.
    return normalizePersistedRecord(record, STORAGE_SCHEMA_VERSION);
  }

  // Incremental migration: preserve what exists, fill in defaults for missing fields.
  return applyMigrations(record, schemaVersion);
}
