import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  KNOWN_ACCOUNTS_KEY,
  LEGACY_PERSONA_SNAPSHOT_KEY,
  STORAGE_SCHEMA_VERSION,
  SUMMARY_EVICTION_COUNT,
} from '../shared/constants.js';
import { migrateState, serializePersistedState } from '../shared/migrations.js';
import {
  readStorageState,
  readStorageStateSnapshot,
  sanitizeSettings,
  type StorageRepairPlan,
} from '../shared/storage.js';
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
  // v13 (A41/I116-4): the in-memory state keeps credentials inside settings,
  // but storage keeps them in their own keys — seed those keys from memory
  // so a settings-blob-only change (which carries no secrets by design)
  // cannot erase the token from the coordinator's view. A patch that DOES
  // name a custody key (token issuance, key edit) overrides the seed.
  const raw: Record<string, unknown> = {
    [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: state.settings.agencyHubDeviceToken,
    [AGENCY_HUB_API_KEY_STORAGE_KEY]: state.settings.agencyHubApiKey,
    ...state,
    ...setItems,
  };
  for (const key of removeKeys) {
    delete raw[key];
    if (key === AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY || key === AGENCY_HUB_API_KEY_STORAGE_KEY) {
      raw[key] = ''; // an explicit custody-key removal means "credential gone"
    }
  }

  const nextState = migrateState(raw);
  nextState.settings = sanitizeSettings(nextState.settings);
  if (typeof nextState.schemaVersion !== 'number') {
    nextState.schemaVersion = STORAGE_SCHEMA_VERSION;
  }
  return nextState;
}

interface StoragePatch {
  setItems: Record<string, unknown>;
  removeKeys: string[];
}

interface FinalStoragePatch {
  removed: boolean;
  value?: unknown;
}

interface StorageListenerProbe {
  valuePrefix: string;
  resolve: () => void;
}

const STORAGE_LISTENER_PROBE_KEY = '__chatgooseStorageListenerProbeV1';
const STORAGE_REPAIR_ACK_KEY = '__chatgooseStorageRepairAckV1';
const STORAGE_LISTENER_PROBE_ATTEMPTS = 3;
const STORAGE_REPAIR_ACK_WAIT_TASKS = 3;
const STORAGE_REPAIR_ACK_MAX_PENDING = 32;

interface StorageRepairSetAck {
  kind: 'set';
  expected: Record<string, unknown>;
  resolve: () => void;
}

interface StorageRepairRemoveAck {
  kind: 'remove';
  expectedKeys: Set<string>;
  abandoned: boolean;
  resolveArmed: () => void;
  resolveComplete: () => void;
}

type StorageRepairAck = StorageRepairSetAck | StorageRepairRemoveAck;

function storageValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) =>
      storageValuesEqual(value, right[index]));
  }
  if (
    left && right &&
    typeof left === 'object' && typeof right === 'object' &&
    !Array.isArray(left) && !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord);
    const rightKeys = Object.keys(rightRecord);
    return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      storageValuesEqual(leftRecord[key], rightRecord[key]));
  }
  return false;
}

function isNormalizedStateKey(key: string): boolean {
  return key === 'schemaVersion' ||
    key === 'settings' ||
    key === 'personalities' ||
    key === 'personaCatalog' ||
    key === 'personaCatalogSource' ||
    key === 'personaCatalogFetchedAt' ||
    key === 'accountMappings' ||
    key === 'accountAliases' ||
    key === KNOWN_ACCOUNTS_KEY ||
    key === AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY ||
    key === AGENCY_HUB_API_KEY_STORAGE_KEY;
}

function waitForStorageChangeDispatch(): Promise<void> {
  // storage.local.set/remove can resolve before storage.onChanged is delivered
  // to this same service worker. Yield one task so the operation's queued
  // event is consumed while its expectation is still active.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitStorageDispatchTasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await waitForStorageChangeDispatch();
  }
}

export class StorageCoordinator {
  private state: PersistedState | null = null;
  private loadingState: Promise<PersistedState> | null = null;
  private startupLoadInProgress = false;
  private listenerProbeObserved = false;
  private activeListenerProbe: StorageListenerProbe | null = null;
  private deferredRepairNeeded = false;
  private deferredRepairPromise: Promise<void> | null = null;
  private readonly pendingStoragePatches: StoragePatch[] = [];
  private readonly pendingRepairAcks = new Map<string, StorageRepairAck>();
  private repairAckSequence = 0;
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
    if (this.state && !this.loadingState) {
      if (this.deferredRepairNeeded) {
        await this.retryDeferredRepair();
      }
      const ready = this.state;
      if (!ready) {
        throw new Error('Storage state disappeared during deferred repair');
      }
      return ready;
    }

    if (!this.loadingState) {
      this.startupLoadInProgress = true;
      this.loadingState = this.proveStorageListener()
        .then(async (listenerReady) => {
          // This read deliberately happens AFTER the listener barrier. It
          // captures writes Firefox may have committed while an early
          // storage.onChanged event was lost during listener registration.
          const { state, repair } = await readStorageStateSnapshot();
          let current = state;
          for (const patch of this.pendingStoragePatches) {
            current = applyRawStoragePatch(current, patch.setItems, patch.removeKeys);
          }
          this.state = current;

          if (listenerReady) {
            await this.repairStartupStorage(repair);
            this.deferredRepairNeeded = false;
          } else {
            // Without an observed probe, a migration write can race an edit
            // whose early change event Firefox dropped. Return normalized
            // state for availability, but keep all repair work read-only until
            // a later access can prove the listener and take another snapshot.
            this.deferredRepairNeeded = true;
          }

          const ready = this.state;
          if (!ready) {
            throw new Error('Storage state disappeared during startup repair');
          }
          if (!this.deferredRepairNeeded) {
            this.pendingStoragePatches.length = 0;
          }
          this.startupLoadInProgress = false;
          return ready;
        })
        .catch((error: unknown) => {
          // Keep every observed patch for a clean retry. A failed repair may
          // have partially written its old payload before rejecting; replaying
          // the retained patches over the next fresh snapshot restores the
          // user's newer writes instead of accepting that partial result.
          this.state = null;
          this.startupLoadInProgress = false;
          this.deferredRepairNeeded = false;
          throw error;
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
    if (areaName !== 'local') {
      return;
    }

    const suppressedRepairKeys = this.consumeRepairAckBatch(changes);
    const setItems: Record<string, unknown> = {};
    const removeKeys: string[] = [];
    for (const [key, change] of Object.entries(changes)) {
      if (key === STORAGE_LISTENER_PROBE_KEY) {
        this.observeStorageListenerProbe(change);
        continue;
      }
      if (key === STORAGE_REPAIR_ACK_KEY || suppressedRepairKeys.has(key)) {
        continue;
      }
      // Immutable preservation evidence is outside normalized runtime state.
      // Never buffer/replay its own startup write through the coordinator.
      if (key === LEGACY_PERSONA_SNAPSHOT_KEY) {
        continue;
      }
      if (change.newValue === undefined) {
        removeKeys.push(key);
      } else {
        setItems[key] = change.newValue;
      }
    }

    if (Object.keys(setItems).length === 0 && removeKeys.length === 0) {
      return;
    }

    if (!this.state || this.startupLoadInProgress || this.deferredRepairNeeded) {
      // storage.onChanged can beat the initial storage.get. Replaying these
      // patches over that captured snapshot prevents startup from resurrecting
      // stale mappings/persona text in memory and later kernel reconciliation.
      this.pendingStoragePatches.push({ setItems, removeKeys });
    }

    if (!this.state) {
      return;
    }

    this.state = applyRawStoragePatch(this.state, setItems, removeKeys);
    if (this.deferredRepairNeeded && !this.startupLoadInProgress) {
      void this.retryDeferredRepair();
    }
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

  /**
   * Commit a generated summary only while a fresh browser-storage snapshot
   * still satisfies its captured persona identity. This runs inside the
   * coordinator write queue so another tab's newer summary cannot be
   * overwritten by an older operation that finished later. A failed
   * post-write check never removes anything: the entry may already have been
   * superseded by a newer valid write.
   */
  async saveSummaryCacheIfCurrent(
    groupId: string,
    entry: SummaryCacheEntry,
    isCurrent: (state: PersistedState) => boolean,
  ): Promise<boolean> {
    return this.enqueueWrite(async () => {
      const before = await readStorageState();
      if (!isCurrent(before)) {
        return false;
      }

      const existing = getSummaryCacheEntry(before, groupId);
      if (
        existing &&
        existing.personalityId === entry.personalityId &&
        existing.personalityUpdatedAt === entry.personalityUpdatedAt &&
        existing.personaCatalogSource === entry.personaCatalogSource &&
        existing.generatedAt >= entry.generatedAt &&
        (
          existing.generatedAt !== entry.generatedAt ||
          existing.summary !== entry.summary
        )
      ) {
        return false;
      }

      await this.summaryCache.save(groupId, entry);

      const after = await readStorageState();
      const committed = getSummaryCacheEntry(after, groupId);
      return isCurrent(after) &&
        committed?.generatedAt === entry.generatedAt &&
        committed.summary === entry.summary &&
        committed.personalityId === entry.personalityId &&
        committed.personalityUpdatedAt === entry.personalityUpdatedAt &&
        committed.personaCatalogSource === entry.personaCatalogSource;
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

  private async repairStartupStorage(repair: StorageRepairPlan): Promise<void> {
    if (repair.persistState) {
      const state = this.state;
      if (!state) {
        throw new Error('Storage state is unavailable for startup repair');
      }
      await this.writeStartupSet(serializePersistedState(state));
    }

    if (repair.invalidSummaryKeys.length > 0) {
      await this.writeStartupRemove(repair.invalidSummaryKeys);
    }

    // Reapply every patch observed since the initial get began. The first
    // batch is often already represented by the repair payload, but replay is
    // intentional: it also covers a storage.set that completed after an
    // external write and therefore temporarily won the disk race. Patches
    // arriving during replay extend the array and are drained in the next
    // iteration.
    let cursor = 0;
    while (cursor < this.pendingStoragePatches.length) {
      const patches = this.pendingStoragePatches.slice(cursor);
      cursor = this.pendingStoragePatches.length;
      await this.replayStartupPatches(patches);
    }

    try {
      await browser.storage.local.remove(STORAGE_REPAIR_ACK_KEY);
    } catch {
      // Private ack residue is ignored by materialization and storage policy.
    }
  }

  private async proveStorageListener(): Promise<boolean> {
    if (this.listenerProbeObserved) {
      return true;
    }

    const valuePrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    for (let attempt = 0; attempt < STORAGE_LISTENER_PROBE_ATTEMPTS; attempt += 1) {
      let resolveObserved: (() => void) | null = null;
      const observed = new Promise<void>((resolve) => {
        resolveObserved = resolve;
      });
      this.activeListenerProbe = {
        valuePrefix,
        resolve: () => resolveObserved?.(),
      };

      try {
        await browser.storage.local.set({
          [STORAGE_LISTENER_PROBE_KEY]: `${valuePrefix}:${attempt}`,
        });
        await Promise.race([
          observed,
          waitForStorageChangeDispatch(),
        ]);
      } catch {
        // A storage failure is handled like an unobserved listener: never let
        // startup hang and never proceed to a mutating repair on uncertainty.
      } finally {
        this.activeListenerProbe = null;
        try {
          await browser.storage.local.remove(STORAGE_LISTENER_PROBE_KEY);
        } catch {
          // A stale private probe is ignored by state materialization and all
          // storage-change policies; the next attempt overwrites it.
        }
      }

      if (this.listenerProbeObserved) {
        return true;
      }
    }

    return false;
  }

  private observeStorageListenerProbe(change: browser.storage.StorageChange): void {
    const probe = this.activeListenerProbe;
    if (
      !probe ||
      typeof change.newValue !== 'string' ||
      !change.newValue.startsWith(`${probe.valuePrefix}:`)
    ) {
      return;
    }
    this.listenerProbeObserved = true;
    probe.resolve();
  }

  private async retryDeferredRepair(): Promise<void> {
    if (!this.deferredRepairNeeded || this.deferredRepairPromise) {
      return this.deferredRepairPromise ?? Promise.resolve();
    }

    this.deferredRepairPromise = (async () => {
      this.startupLoadInProgress = true;
      try {
        const listenerReady = await this.proveStorageListener();
        // Even while Firefox still fails to acknowledge the listener, every
        // explicit deferred get refreshes the read-only view. Mutation remains
        // forbidden until the barrier succeeds, but callers never stay pinned
        // to the first fallback snapshot.
        const { state, repair } = await readStorageStateSnapshot();
        let current = state;
        for (const patch of this.pendingStoragePatches) {
          current = applyRawStoragePatch(current, patch.setItems, patch.removeKeys);
        }
        this.state = current;
        if (!listenerReady) {
          return;
        }
        await this.repairStartupStorage(repair);
        this.pendingStoragePatches.length = 0;
        this.deferredRepairNeeded = false;
      } catch {
        // Keep the normalized in-memory state and buffered patches available.
        // A later getState/storage event retries from another fresh snapshot.
      } finally {
        this.startupLoadInProgress = false;
      }
    })().finally(() => {
      this.deferredRepairPromise = null;
    });

    return this.deferredRepairPromise;
  }

  private async replayStartupPatches(patches: StoragePatch[]): Promise<void> {
    const finalByKey = new Map<string, FinalStoragePatch>();
    for (const patch of patches) {
      for (const [key, value] of Object.entries(patch.setItems)) {
        finalByKey.set(key, { removed: false, value });
      }
      for (const key of patch.removeKeys) {
        finalByKey.set(key, { removed: true });
      }
    }

    const state = this.state;
    if (!state) {
      throw new Error('Storage state is unavailable while replaying startup changes');
    }
    const normalized = serializePersistedState(state);
    const setItems: Record<string, unknown> = {};
    const removeKeys: string[] = [];

    for (const [key, patch] of finalByKey) {
      if (isNormalizedStateKey(key)) {
        if (Object.prototype.hasOwnProperty.call(normalized, key)) {
          setItems[key] = normalized[key];
        } else {
          removeKeys.push(key);
        }
      } else if (patch.removed) {
        removeKeys.push(key);
      } else {
        setItems[key] = patch.value;
      }
    }

    if (Object.keys(setItems).length > 0) {
      await this.writeStartupSet(setItems);
    }
    if (removeKeys.length > 0) {
      await this.writeStartupRemove(removeKeys);
    }
  }

  private async writeStartupSet(items: Record<string, unknown>): Promise<void> {
    const ack = this.nextRepairAck();
    let resolveObserved: (() => void) | null = null;
    const observed = new Promise<void>((resolve) => {
      resolveObserved = resolve;
    });
    this.registerRepairAck(ack, {
      kind: 'set',
      expected: items,
      resolve: () => resolveObserved?.(),
    });

    let writeCompleted = false;
    try {
      await browser.storage.local.set({
        ...items,
        [STORAGE_REPAIR_ACK_KEY]: ack,
      });
      writeCompleted = true;
      if (!await this.waitForRepairAck(observed)) {
        throw new Error('Storage startup repair acknowledgement was not observed');
      }
    } catch (error) {
      // If the write itself failed, no matching event can arrive. After a
      // completed but unacknowledged write, retain the signature so a very
      // late self-event is still suppressed instead of overwriting newer state.
      if (!writeCompleted) {
        this.pendingRepairAcks.delete(ack);
      }
      throw error;
    }
  }

  private async writeStartupRemove(keys: string[]): Promise<void> {
    const ack = this.nextRepairAck();
    let resolveArmed: (() => void) | null = null;
    let resolveComplete: (() => void) | null = null;
    const armed = new Promise<void>((resolve) => {
      resolveArmed = resolve;
    });
    const complete = new Promise<void>((resolve) => {
      resolveComplete = resolve;
    });
    this.registerRepairAck(ack, {
      kind: 'remove',
      expectedKeys: new Set(keys),
      abandoned: false,
      resolveArmed: () => resolveArmed?.(),
      resolveComplete: () => resolveComplete?.(),
    });

    let markerWritten = false;
    try {
      await browser.storage.local.set({ [STORAGE_REPAIR_ACK_KEY]: ack });
      markerWritten = true;
      if (!await this.waitForRepairAck(armed)) {
        const pending = this.pendingRepairAcks.get(ack);
        if (pending?.kind === 'remove') {
          pending.abandoned = true;
        }
        throw new Error('Storage startup removal acknowledgement was not armed');
      }
      await browser.storage.local.remove([...keys, STORAGE_REPAIR_ACK_KEY]);
      if (!await this.waitForRepairAck(complete)) {
        throw new Error('Storage startup removal acknowledgement was not observed');
      }
    } catch (error) {
      if (!markerWritten) {
        this.pendingRepairAcks.delete(ack);
      }
      // Once the marker write completed, retain the bounded signature: a
      // rejected/timed-out remove may still deliver a late completion event.
      throw error;
    }
  }

  private consumeRepairAckBatch(
    changes: Record<string, browser.storage.StorageChange>,
  ): Set<string> {
    const suppressed = new Set<string>();
    const ackChange = changes[STORAGE_REPAIR_ACK_KEY];
    if (!ackChange) {
      return suppressed;
    }

    if (typeof ackChange.newValue === 'string') {
      const ack = this.pendingRepairAcks.get(ackChange.newValue);
      if (!ack) {
        return suppressed;
      }
      if (ack.kind === 'remove') {
        ack.resolveArmed();
        if (ack.abandoned) {
          this.pendingRepairAcks.delete(ackChange.newValue);
        }
        return suppressed;
      }

      for (const [key, expectedValue] of Object.entries(ack.expected)) {
        const change = changes[key];
        if (change && storageValuesEqual(change.newValue, expectedValue)) {
          suppressed.add(key);
        }
      }
      ack.resolve();
      this.pendingRepairAcks.delete(ackChange.newValue);
      return suppressed;
    }

    if (typeof ackChange.oldValue === 'string') {
      const ack = this.pendingRepairAcks.get(ackChange.oldValue);
      if (!ack || ack.kind !== 'remove') {
        return suppressed;
      }
      for (const key of ack.expectedKeys) {
        if (changes[key]?.newValue === undefined) {
          suppressed.add(key);
        }
      }
      ack.resolveComplete();
      this.pendingRepairAcks.delete(ackChange.oldValue);
    }
    return suppressed;
  }

  private nextRepairAck(): string {
    this.repairAckSequence += 1;
    return `${Date.now().toString(36)}-${this.repairAckSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  private registerRepairAck(ack: string, record: StorageRepairAck): void {
    while (this.pendingRepairAcks.size >= STORAGE_REPAIR_ACK_MAX_PENDING) {
      const oldest = this.pendingRepairAcks.keys().next().value as string | undefined;
      if (!oldest) {
        break;
      }
      this.pendingRepairAcks.delete(oldest);
    }
    this.pendingRepairAcks.set(ack, record);
  }

  private async waitForRepairAck(observed: Promise<void>): Promise<boolean> {
    return Promise.race([
      observed.then(() => true),
      waitStorageDispatchTasks(STORAGE_REPAIR_ACK_WAIT_TASKS).then(() => false),
    ]);
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
