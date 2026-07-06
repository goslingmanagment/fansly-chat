import {
  DEEP_MAX_MESSAGE_COUNT,
  DEEP_MIN_MESSAGE_COUNT,
  REASONING_EFFORTS,
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
import { normalizeModelId } from './model-registry.js';
import {
  collectAliasKeysForCanonical,
  resolveCanonicalAccountId,
} from './account-aliases.js';
import { normalizeAgencyHubBaseUrl } from './agency-hub.js';
import { createDefaultSettings, migrateState } from './migrations.js';
import {
  normalizeSavedPersonality,
  reconcileBundledPersonalities,
} from './personalities.js';
import {
  getInvalidSummaryCacheKeys,
  getSummaryCacheKeysForPersonality,
  getSummaryCacheKeysReferencingPersonality,
  SummaryCacheStore,
} from './summary-cache.js';
import type {
  ModelSelectableFeatureType,
  PersistedState,
  Personality,
  ReasoningEffort,
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

function normalizeReasoningEffort(
  value: unknown,
  fallback: ReasoningEffort,
): ReasoningEffort {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : fallback;
}

export async function loadStorageState(): Promise<PersistedState> {
  const raw = await browser.storage.local.get(null);
  const invalidSummaryKeys = getInvalidSummaryCacheKeys(raw);
  const state = migrateState(raw);
  state.settings = sanitizeSettings(state.settings);
  const {
    personalities,
    changed: personalitiesChanged,
  } = reconcileBundledPersonalities(state.personalities);
  state.personalities = personalities;

  if (invalidSummaryKeys.length > 0) {
    await browser.storage.local.remove(
      invalidSummaryKeys.length === 1 ? invalidSummaryKeys[0]! : invalidSummaryKeys,
    );
  }
  if (
    (raw.schemaVersion as number | undefined) !== STORAGE_SCHEMA_VERSION ||
    personalitiesChanged
  ) {
    await browser.storage.local.set(state);
  }

  return state;
}

export function sanitizeSettings(input: Partial<Settings>): Settings {
  const defaults = createDefaultSettings();
  const rawQuick = Number(input.quickMessageCount ?? defaults.quickMessageCount);
  const rawPing = Number(input.pingMessageCount ?? defaults.pingMessageCount);
  const rawImprove = Number(input.improveMessageCount ?? defaults.improveMessageCount);
  const rawDeep = Number(input.deepMessageCount ?? defaults.deepMessageCount);
  const quick = Number.isFinite(rawQuick) ? rawQuick : defaults.quickMessageCount;
  const ping = Number.isFinite(rawPing) ? rawPing : defaults.pingMessageCount;
  const improve = Number.isFinite(rawImprove) ? rawImprove : defaults.improveMessageCount;
  const deep = Number.isFinite(rawDeep) ? rawDeep : defaults.deepMessageCount;

  const rawModels = input.featureModels && typeof input.featureModels === 'object'
    ? input.featureModels as Partial<Record<ModelSelectableFeatureType, string>>
    : {};
  const featureModels = { ...defaults.featureModels };
  for (const feature of Object.keys(defaults.featureModels) as ModelSelectableFeatureType[]) {
    const candidate = rawModels[feature];
    const normalizedModel = normalizeModelId(candidate);
    if (normalizedModel) {
      featureModels[feature] = normalizedModel;
    }
  }

  const rawReasoning = input.featureReasoning && typeof input.featureReasoning === 'object'
    ? input.featureReasoning as Partial<Record<ModelSelectableFeatureType, unknown>>
    : {};
  const featureReasoning = { ...defaults.featureReasoning };
  for (const feature of Object.keys(defaults.featureReasoning) as ModelSelectableFeatureType[]) {
    featureReasoning[feature] = normalizeReasoningEffort(
      rawReasoning[feature],
      defaults.featureReasoning[feature],
    );
  }

  return {
    claudeApiKey: String(input.claudeApiKey ?? defaults.claudeApiKey).trim(),
    openRouterApiKey: String(input.openRouterApiKey ?? defaults.openRouterApiKey).trim(),
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
    featureModels,
    featureReasoning,
  };
}

export async function saveSettings(settingsPatch: Partial<Settings>): Promise<Settings> {
  const state = await loadStorageState();
  const nextSettings = sanitizeSettings({ ...state.settings, ...settingsPatch });
  await browser.storage.local.set({ settings: nextSettings });
  return nextSettings;
}

export async function savePersonalities(personalities: Personality[]): Promise<Personality[]> {
  const normalized = personalities.map(normalizeSavedPersonality);
  const { personalities: reconciled } = reconcileBundledPersonalities(normalized);

  await browser.storage.local.set({ personalities: reconciled });
  return reconciled;
}

export async function deletePersonality(personalityId: string): Promise<void> {
  const state = await loadStorageState();
  const target = state.personalities.find((personality) => personality.id === personalityId);
  if (target?.builtin) {
    return;
  }
  const personalities = state.personalities.filter((p) => p.id !== personalityId);
  const accountMappings = Object.fromEntries(
    Object.entries(state.accountMappings).filter(([, mapped]) => mapped !== personalityId),
  );

  const raw = await browser.storage.local.get(null);
  const removals = Array.from(new Set([
    ...getSummaryCacheKeysForPersonality(state, personalityId),
    ...getSummaryCacheKeysReferencingPersonality(raw, personalityId),
  ]));

  await browser.storage.local.set({ personalities, accountMappings });
  if (removals.length > 0) {
    await browser.storage.local.remove(removals);
  }
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
