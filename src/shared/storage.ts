import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  COACH_HISTORY_LIMIT_MAX,
  COACH_HISTORY_LIMIT_MIN,
  DEEP_MAX_MESSAGE_COUNT,
  DEEP_MIN_MESSAGE_COUNT,
  IMPROVE_MAX_MESSAGE_COUNT,
  IMPROVE_MIN_MESSAGE_COUNT,
  KNOWN_ACCOUNTS_KEY,
  PING_MAX_MESSAGE_COUNT,
  PING_MIN_MESSAGE_COUNT,
  QUICK_MAX_MESSAGE_COUNT,
  QUICK_MIN_MESSAGE_COUNT,
  SUMMARY_EVICTION_COUNT,
  STORAGE_SCHEMA_VERSION,
} from './constants.js';
import {
  collectAliasKeysForCanonical,
  resolveCanonicalAccountId,
} from './account-aliases.js';
import { normalizeAgencyHubBaseUrl } from './agency-hub.js';
import {
  createDefaultSettings,
  migrateState,
  serializePersistedState,
  stripSecretSettings,
  UnsupportedFutureStorageSchemaError,
} from './migrations.js';
import {
  findActivePersona,
} from './persona-catalog.js';
import { ensureLegacyPersonaSnapshot } from './persona-preservation.js';
import {
  getInvalidSummaryCacheKeys,
  SummaryCacheStore,
} from './summary-cache.js';
import type {
  PersistedState,
  Settings,
  SummaryCacheEntry,
} from './types.js';

function createSummaryCacheStore(): SummaryCacheStore {
  return new SummaryCacheStore(
    browser.storage.local,
    loadStorageState,
    { evictionCount: SUMMARY_EVICTION_COUNT },
  );
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export interface StorageRepairPlan {
  invalidSummaryKeys: string[];
  persistState: boolean;
}

export interface StorageStateSnapshot {
  state: PersistedState;
  repair: StorageRepairPlan;
}

function materializeStorageState(raw: Record<string, unknown>): StorageStateSnapshot {
  const invalidSummaryKeys = getInvalidSummaryCacheKeys(raw);
  const state = migrateState(raw);
  state.settings = sanitizeSettings(state.settings);

  return {
    state,
    repair: {
      invalidSummaryKeys,
      persistState:
        (raw.schemaVersion as number | undefined) !== STORAGE_SCHEMA_VERSION,
    },
  };
}

/**
 * Capture and normalize one storage snapshot, plus the cleanup it needs,
 * without performing that cleanup. The background coordinator uses this
 * split phase so storage.onChanged patches can be merged before any migration
 * or bundled-persona repair writes back to disk.
 */
export async function readStorageStateSnapshot(): Promise<StorageStateSnapshot> {
  // Hard preservation barrier: no migration/full-state repair can run unless
  // the exact pre-normalization persona data is durably captured first.
  await ensureLegacyPersonaSnapshot();
  const raw = await browser.storage.local.get(null);
  return materializeStorageState(raw);
}

/**
 * Return the normalized local state without repairing storage. This is for
 * latency-sensitive readers that may run beside a background-owned identity
 * rekey: unlike loadStorageState(), it cannot write an older full-state
 * snapshot back over that reconciliation.
 */
export async function readStorageState(): Promise<PersistedState> {
  return (await readStorageStateSnapshot()).state;
}

export async function loadStorageState(): Promise<PersistedState> {
  const { state, repair } = await readStorageStateSnapshot();

  if (repair.invalidSummaryKeys.length > 0) {
    await browser.storage.local.remove(
      repair.invalidSummaryKeys.length === 1
        ? repair.invalidSummaryKeys[0]!
        : repair.invalidSummaryKeys,
    );
  }
  if (repair.persistState) {
    // v13 (A41/I116-4): full-state persists go through the serializer —
    // credentials land in their own keys, never back into the blob. The
    // v12→v13 pass IS this write: it moves the secrets out of the blob.
    await browser.storage.local.set(serializePersistedState(state));
  }

  return state;
}

export function sanitizeSettings(input: Partial<Settings>): Settings {
  const defaults = createDefaultSettings();
  const rawQuick = Number(input.quickMessageCount ?? defaults.quickMessageCount);
  const rawPing = Number(input.pingMessageCount ?? defaults.pingMessageCount);
  const rawImprove = Number(input.improveMessageCount ?? defaults.improveMessageCount);
  const rawDeep = Number(input.deepMessageCount ?? defaults.deepMessageCount);
  const rawCoachHistory = Number(input.coachHistoryLimit ?? defaults.coachHistoryLimit);
  const quick = Number.isFinite(rawQuick) ? rawQuick : defaults.quickMessageCount;
  const ping = Number.isFinite(rawPing) ? rawPing : defaults.pingMessageCount;
  const improve = Number.isFinite(rawImprove) ? rawImprove : defaults.improveMessageCount;
  const deep = Number.isFinite(rawDeep) ? rawDeep : defaults.deepMessageCount;
  const coachHistory = Number.isFinite(rawCoachHistory)
    ? rawCoachHistory
    : defaults.coachHistoryLimit;

  return {
    agencyHubBaseUrl: normalizeAgencyHubBaseUrl(
      String(input.agencyHubBaseUrl ?? defaults.agencyHubBaseUrl),
    ),
    agencyHubApiKey: String(input.agencyHubApiKey ?? defaults.agencyHubApiKey).trim(),
    agencyHubDeviceToken: String(
      input.agencyHubDeviceToken ?? defaults.agencyHubDeviceToken,
    ).trim(),
    quickMessageCount: Math.min(QUICK_MAX_MESSAGE_COUNT, Math.max(QUICK_MIN_MESSAGE_COUNT, quick)),
    pingMessageCount: Math.min(PING_MAX_MESSAGE_COUNT, Math.max(PING_MIN_MESSAGE_COUNT, ping)),
    improveMessageCount: Math.min(
      IMPROVE_MAX_MESSAGE_COUNT,
      Math.max(IMPROVE_MIN_MESSAGE_COUNT, improve),
    ),
    deepMessageCount: Math.min(DEEP_MAX_MESSAGE_COUNT, Math.max(DEEP_MIN_MESSAGE_COUNT, deep)),
    debugMode: Boolean(input.debugMode ?? defaults.debugMode),
    promptCachingEnabled: Boolean(input.promptCachingEnabled ?? defaults.promptCachingEnabled),
    uiTheme:
      input.uiTheme === 'light' || input.uiTheme === 'dark' || input.uiTheme === 'system'
        ? input.uiTheme
        : defaults.uiTheme,
    coachHistoryLimit: Math.min(
      COACH_HISTORY_LIMIT_MAX,
      Math.max(COACH_HISTORY_LIMIT_MIN, coachHistory),
    ),
    coachAutoRecap:
      input.coachAutoRecap === 'short' ||
      input.coachAutoRecap === 'full' ||
      input.coachAutoRecap === 'off'
        ? input.coachAutoRecap
        : defaults.coachAutoRecap,
  };
}

/** v13 (A41/I116-4) custody contract: the credentials are written ONLY when
 * the patch names them as own properties — callers state intent per key. The
 * settings blob itself never carries them, so a read-modify-write racing a
 * token issuance can no longer clobber the fresh token (the pre-v13 bug:
 * options-page debounced saves rewrote the whole blob, stale token included). */
export async function saveSettings(
  settingsPatch: Partial<Settings>,
  baseSettings?: Settings,
  options: { observedSchemaVersion?: number | null } = {},
): Promise<Settings> {
  const observedSchemaVersion = options.observedSchemaVersion;
  if (
    observedSchemaVersion !== null &&
    observedSchemaVersion !== undefined &&
    Number.isSafeInteger(observedSchemaVersion) &&
    observedSchemaVersion > STORAGE_SCHEMA_VERSION
  ) {
    throw new UnsupportedFutureStorageSchemaError(observedSchemaVersion);
  }
  // Options already owns a normalized snapshot and passes it so pagehide can
  // dispatch storage.set before the document is discarded. Other callers keep
  // the coordinator-safe read/modify/write path. Options installs its schema
  // observer before taking that snapshot and passes the observed version here;
  // this branch deliberately has no await before storage.set so pagehide keeps
  // its synchronous dispatch guarantee.
  const currentSettings = baseSettings ?? (await loadStorageState()).settings;
  const nextSettings = sanitizeSettings({ ...currentSettings, ...settingsPatch });
  const items: Record<string, unknown> = {
    settings: stripSecretSettings(nextSettings),
  };
  if (Object.prototype.hasOwnProperty.call(settingsPatch, 'agencyHubDeviceToken')) {
    items[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = nextSettings.agencyHubDeviceToken;
  }
  if (Object.prototype.hasOwnProperty.call(settingsPatch, 'agencyHubApiKey')) {
    items[AGENCY_HUB_API_KEY_STORAGE_KEY] = nextSettings.agencyHubApiKey;
  }
  await browser.storage.local.set(items);
  return nextSettings;
}

export async function saveAccountMapping(accountId: string, personalityId: string | null): Promise<void> {
  const state = await loadStorageState();
  const nextMappings = { ...state.accountMappings };
  const canonicalAccountId =
    resolveCanonicalAccountId(state.accountAliases, accountId) ?? accountId;
  const aliasKeys = collectAliasKeysForCanonical(
    state.accountAliases,
    canonicalAccountId,
  );

  for (const key of new Set([accountId, canonicalAccountId, ...aliasKeys])) {
    delete nextMappings[key];
  }

  if (personalityId) {
    if (!findActivePersona(state.personaCatalog, personalityId)) {
      throw new Error('Cannot map an account to a missing or archived server persona');
    }
    nextMappings[canonicalAccountId] = personalityId;
  }

  await browser.storage.local.set({ accountMappings: nextMappings });
}

export async function registerKnownAccount(accountId: string): Promise<void> {
  const state = await loadStorageState();
  if (state.knownAccounts.includes(accountId)) {
    return;
  }

  const knownAccounts = [...state.knownAccounts, accountId].sort();
  await browser.storage.local.set({ [KNOWN_ACCOUNTS_KEY]: knownAccounts });
}

export async function reconcileKnownAccounts(
  activeCanonicalAccountIds: string[],
): Promise<PersistedState> {
  const state = await loadStorageState();
  const knownAccounts = Array.from(
    new Set([
      ...activeCanonicalAccountIds.filter((accountId) => Boolean(accountId)),
      ...Object.keys(state.accountMappings),
    ]),
  ).sort();

  if (arraysEqual(knownAccounts, state.knownAccounts)) {
    return state;
  }

  await browser.storage.local.set({ [KNOWN_ACCOUNTS_KEY]: knownAccounts });
  return { ...state, knownAccounts };
}

export async function rekeyAccountIdentity(
  legacyAccountId: string,
  resolvedAccountId: string,
): Promise<{
  state: PersistedState;
  mappingMigrated: boolean;
  mappingConflict: boolean;
  knownAccountsChanged: boolean;
}> {
  const state = await loadStorageState();

  if (!legacyAccountId || !resolvedAccountId || legacyAccountId === resolvedAccountId) {
    return { state, mappingMigrated: false, mappingConflict: false, knownAccountsChanged: false };
  }

  const legacyMapping = state.accountMappings[legacyAccountId];
  const resolvedMapping = state.accountMappings[resolvedAccountId];

  let accountMappings = state.accountMappings;
  let accountAliases = state.accountAliases;
  let mappingMigrated = false;
  let mappingConflict = false;
  let accountMappingsChanged = false;
  let accountAliasesChanged = false;

  if (state.accountAliases[legacyAccountId] !== resolvedAccountId) {
    accountAliases = {
      ...state.accountAliases,
      [legacyAccountId]: resolvedAccountId,
    };
    accountAliasesChanged = true;
  }

  if (legacyMapping && resolvedMapping) {
    accountMappings = { ...state.accountMappings };
    delete accountMappings[legacyAccountId];
    mappingConflict = true;
    accountMappingsChanged = true;
  } else if (legacyMapping) {
    accountMappings = { ...state.accountMappings, [resolvedAccountId]: legacyMapping };
    delete accountMappings[legacyAccountId];
    mappingMigrated = true;
    accountMappingsChanged = true;
  }

  let knownAccounts = state.knownAccounts;
  if (state.knownAccounts.includes(legacyAccountId)) {
    knownAccounts = Array.from(
      new Set(state.knownAccounts.map((id) => (id === legacyAccountId ? resolvedAccountId : id))),
    ).sort();
  }

  const knownAccountsChanged = !arraysEqual(knownAccounts, state.knownAccounts);

  if (accountMappingsChanged || knownAccountsChanged || accountAliasesChanged) {
    await browser.storage.local.set({
      accountMappings,
      accountAliases,
      [KNOWN_ACCOUNTS_KEY]: knownAccounts,
    });
  }

  return {
    state: accountMappingsChanged || knownAccountsChanged || accountAliasesChanged
      ? { ...state, accountMappings, accountAliases, knownAccounts }
      : state,
    mappingMigrated,
    mappingConflict,
    knownAccountsChanged,
  };
}

export async function getSummaryCache(groupId: string): Promise<SummaryCacheEntry | null> {
  return createSummaryCacheStore().get(groupId);
}

export async function saveSummaryCache(groupId: string, entry: SummaryCacheEntry): Promise<void> {
  await createSummaryCacheStore().save(groupId, entry);
}

export async function removeSummaryCache(groupId: string): Promise<void> {
  await createSummaryCacheStore().remove(groupId);
}
