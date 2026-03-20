import {
  CLAUDE_MODEL_IDS,
  DEEP_MAX_MESSAGE_COUNT,
  DEEP_MIN_MESSAGE_COUNT,
  KNOWN_ACCOUNTS_KEY,
  QUICK_MAX_MESSAGE_COUNT,
  QUICK_MIN_MESSAGE_COUNT,
  STORAGE_SCHEMA_VERSION,
  SUMMARY_CACHE_PREFIX,
} from './constants.js';
import {
  collectAliasKeysForCanonical,
  resolveCanonicalAccountId,
} from './account-aliases.js';
import { createDefaultSettings, migrateState } from './migrations.js';
import type {
  ModelSelectableFeatureType,
  PersistedState,
  Personality,
  Settings,
  SummaryCacheEntry,
} from './types.js';

function isSummaryKey(key: string): key is `summary:${string}` {
  return key.startsWith(SUMMARY_CACHE_PREFIX);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function loadStorageState(): Promise<PersistedState> {
  const raw = await browser.storage.local.get(null);
  const state = migrateState(raw);
  state.settings = sanitizeSettings(state.settings);

  if ((raw.schemaVersion as number | undefined) !== STORAGE_SCHEMA_VERSION) {
    await browser.storage.local.set(state);
  }

  return state;
}

export function sanitizeSettings(input: Partial<Settings>): Settings {
  const defaults = createDefaultSettings();
  const rawQuick = Number(input.quickMessageCount ?? defaults.quickMessageCount);
  const rawDeep = Number(input.deepMessageCount ?? defaults.deepMessageCount);
  const quick = Number.isFinite(rawQuick) ? rawQuick : defaults.quickMessageCount;
  const deep = Number.isFinite(rawDeep) ? rawDeep : defaults.deepMessageCount;

  const rawModels = input.featureModels && typeof input.featureModels === 'object'
    ? input.featureModels as Partial<Record<ModelSelectableFeatureType, string>>
    : {};
  const featureModels = { ...defaults.featureModels };
  for (const feature of Object.keys(defaults.featureModels) as ModelSelectableFeatureType[]) {
    const candidate = rawModels[feature];
    if (candidate && CLAUDE_MODEL_IDS.has(candidate)) {
      featureModels[feature] = candidate;
    }
  }

  return {
    claudeApiKey: String(input.claudeApiKey ?? defaults.claudeApiKey).trim(),
    quickMessageCount: Math.min(QUICK_MAX_MESSAGE_COUNT, Math.max(QUICK_MIN_MESSAGE_COUNT, quick)),
    deepMessageCount: Math.min(DEEP_MAX_MESSAGE_COUNT, Math.max(DEEP_MIN_MESSAGE_COUNT, deep)),
    debugMode: Boolean(input.debugMode ?? defaults.debugMode),
    promptCachingEnabled: Boolean(input.promptCachingEnabled ?? defaults.promptCachingEnabled),
    featureModels,
  };
}

export async function saveSettings(settingsPatch: Partial<Settings>): Promise<Settings> {
  const state = await loadStorageState();
  const nextSettings = sanitizeSettings({ ...state.settings, ...settingsPatch });
  await browser.storage.local.set({ settings: nextSettings });
  return nextSettings;
}

export async function savePersonalities(personalities: Personality[]): Promise<Personality[]> {
  const normalized = personalities.map((personality) => ({
    ...personality,
    name: personality.name.trim() || 'Unnamed',
    content: personality.content,
    updatedAt: personality.updatedAt || Date.now(),
  }));

  await browser.storage.local.set({ personalities: normalized });
  return normalized;
}

export async function deletePersonality(personalityId: string): Promise<void> {
  const state = await loadStorageState();
  const personalities = state.personalities.filter((p) => p.id !== personalityId);
  const accountMappings = Object.fromEntries(
    Object.entries(state.accountMappings).filter(([, mapped]) => mapped !== personalityId),
  );

  const removals = Object.keys(state)
    .filter((key) => isSummaryKey(key))
    .filter((key) => {
      const entry = state[key] as SummaryCacheEntry | undefined;
      return entry?.personalityId === personalityId;
    });

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
  const key = `${SUMMARY_CACHE_PREFIX}${groupId}`;
  const result = await browser.storage.local.get(key);
  return (result[key] as SummaryCacheEntry | undefined) ?? null;
}

async function evictOldestSummariesAndRetry(key: string, entry: SummaryCacheEntry): Promise<void> {
  const state = await loadStorageState();
  const summaryEntries = Object.entries(state)
    .filter(([summaryKey]) => isSummaryKey(summaryKey))
    .map(([summaryKey, summaryEntry]) => [summaryKey, summaryEntry as SummaryCacheEntry] as const)
    .sort((left, right) => left[1].generatedAt - right[1].generatedAt);

  const keysToRemove = summaryEntries.slice(0, 10).map(([summaryKey]) => summaryKey);
  if (keysToRemove.length > 0) {
    await browser.storage.local.remove(keysToRemove);
  }
  await browser.storage.local.set({ [key]: entry });
}

export async function saveSummaryCache(groupId: string, entry: SummaryCacheEntry): Promise<void> {
  const key = `${SUMMARY_CACHE_PREFIX}${groupId}`;
  try {
    await browser.storage.local.set({ [key]: entry });
  } catch {
    await evictOldestSummariesAndRetry(key, entry);
  }
}

export async function removeSummaryCache(groupId: string): Promise<void> {
  await browser.storage.local.remove(`${SUMMARY_CACHE_PREFIX}${groupId}`);
}
