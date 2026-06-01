import {
  KNOWN_ACCOUNTS_KEY,
  STORAGE_SCHEMA_VERSION,
  SUMMARY_EVICTION_COUNT,
} from '../shared/constants.js';
import { migrateState } from '../shared/migrations.js';
import { loadStorageState, sanitizeSettings } from '../shared/storage.js';
import {
  getSummaryCacheEntry,
  SummaryCacheStore,
} from '../shared/summary-cache.js';
import type { PersistedState, SummaryCacheEntry } from '../shared/types.js';

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function applyRawStoragePatch(
  state: PersistedState,
  setItems: Record<string, unknown>,
  removeKeys: string[] = [],
): PersistedState {
  const raw: Record<string, unknown> = { ...state, ...setItems };
  for (const key of removeKeys) {
    delete raw[key];
  }

  const nextState = migrateState(raw);
  nextState.settings = sanitizeSettings(nextState.settings);
  if (typeof nextState.schemaVersion !== 'number') {
    nextState.schemaVersion = STORAGE_SCHEMA_VERSION;
  }
  return nextState;
}

export class StorageCoordinator {
  private state: PersistedState | null = null;
  private loadingState: Promise<PersistedState> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly summaryCache = new SummaryCacheStore(
    browser.storage.local,
    () => this.getState(),
    {
      evictionCount: SUMMARY_EVICTION_COUNT,
      afterSet: (items) => {
        this.commitLocalWrite(items);
      },
      afterRemove: (keys) => {
        this.commitLocalWrite({}, keys);
      },
    },
  );

  async init(): Promise<PersistedState> {
    return this.getState();
  }

  async getState(): Promise<PersistedState> {
    if (this.state) {
      return this.state;
    }

    if (!this.loadingState) {
      this.loadingState = loadStorageState()
        .then((state) => {
          this.state = state;
          return state;
        })
        .finally(() => {
          this.loadingState = null;
        });
    }

    return this.loadingState;
  }

  applyStorageChanges(
    changes: Record<string, browser.storage.StorageChange>,
    areaName: string,
  ): void {
    if (areaName !== 'local' || !this.state) {
      return;
    }

    const setItems: Record<string, unknown> = {};
    const removeKeys: string[] = [];
    for (const [key, change] of Object.entries(changes)) {
      if (change.newValue === undefined) {
        removeKeys.push(key);
      } else {
        setItems[key] = change.newValue;
      }
    }

    if (Object.keys(setItems).length === 0 && removeKeys.length === 0) {
      return;
    }

    this.state = applyRawStoragePatch(this.state, setItems, removeKeys);
  }

  async registerKnownAccount(accountId: string): Promise<void> {
    if (!accountId) {
      return;
    }

    await this.enqueueWrite(async () => {
      const state = await this.getState();
      if (state.knownAccounts.includes(accountId)) {
        return;
      }

      const knownAccounts = [...state.knownAccounts, accountId].sort();
      await browser.storage.local.set({ [KNOWN_ACCOUNTS_KEY]: knownAccounts });
      this.commitLocalWrite({ [KNOWN_ACCOUNTS_KEY]: knownAccounts });
    });
  }

  async reconcileKnownAccounts(
    activeCanonicalAccountIds: string[],
  ): Promise<PersistedState> {
    return this.enqueueWrite(async () => {
      const state = await this.getState();
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
      return this.commitLocalWrite({ [KNOWN_ACCOUNTS_KEY]: knownAccounts }) ?? state;
    });
  }

  async rekeyAccountIdentity(
    legacyAccountId: string,
    resolvedAccountId: string,
  ): Promise<{
    state: PersistedState;
    mappingMigrated: boolean;
    mappingConflict: boolean;
    knownAccountsChanged: boolean;
  }> {
    return this.enqueueWrite(async () => {
      const state = await this.getState();

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

      if (accountMappingsChanged || accountAliasesChanged || knownAccountsChanged) {
        await browser.storage.local.set({
          accountMappings,
          accountAliases,
          [KNOWN_ACCOUNTS_KEY]: knownAccounts,
        });
        const nextState = this.commitLocalWrite({
          accountMappings,
          accountAliases,
          [KNOWN_ACCOUNTS_KEY]: knownAccounts,
        }) ?? state;
        return {
          state: nextState,
          mappingMigrated,
          mappingConflict,
          knownAccountsChanged,
        };
      }

      return {
        state,
        mappingMigrated,
        mappingConflict,
        knownAccountsChanged,
      };
    });
  }

  async getSummaryCache(groupId: string): Promise<SummaryCacheEntry | null> {
    const state = await this.getState();
    return getSummaryCacheEntry(state, groupId);
  }

  async saveSummaryCache(groupId: string, entry: SummaryCacheEntry): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.summaryCache.save(groupId, entry);
    });
  }

  async updateSummaryCache(
    groupId: string,
    updater: (entry: SummaryCacheEntry) => SummaryCacheEntry,
  ): Promise<SummaryCacheEntry | null> {
    return this.enqueueWrite(async () => {
      return this.summaryCache.update(groupId, updater);
    });
  }

  async removeSummaryCache(groupId: string): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.summaryCache.remove(groupId);
    });
  }

  private commitLocalWrite(
    setItems: Record<string, unknown>,
    removeKeys: string[] = [],
  ): PersistedState | null {
    if (!this.state) {
      return null;
    }

    this.state = applyRawStoragePatch(this.state, setItems, removeKeys);
    return this.state;
  }

  private async enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
