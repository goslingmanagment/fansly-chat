import { SUMMARY_CACHE_PREFIX } from './constants.js';
import { normalizeAgencyHubSummarySyncMetadata } from './agency-hub.js';
import type {
  AgencyHubSummarySyncMetadata,
  PersistedState,
  SummaryCacheEntry,
} from './types.js';
import { findActivePersona } from './persona-catalog.js';

export type SummaryCacheKey = `${typeof SUMMARY_CACHE_PREFIX}${string}`;

interface SummaryCacheStorageArea {
  get(keys?: string | string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

interface SummaryCacheStoreOptions {
  evictionCount: number;
  afterSet?: (items: Record<string, unknown>) => void;
  afterRemove?: (keys: SummaryCacheKey[]) => void;
}

export function summaryCacheKey(groupId: string): SummaryCacheKey {
  return `${SUMMARY_CACHE_PREFIX}${groupId}`;
}

export function isSummaryCacheKey(key: string): key is SummaryCacheKey {
  return key.startsWith(SUMMARY_CACHE_PREFIX);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeSummarySyncMetadata(
  value: unknown,
): AgencyHubSummarySyncMetadata | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (!isFiniteNumber(record.generatedAt)) {
    return undefined;
  }

  return normalizeAgencyHubSummarySyncMetadata(
    record as unknown as AgencyHubSummarySyncMetadata,
  );
}

export function normalizeSummaryCacheEntry(value: unknown): SummaryCacheEntry | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.summary !== 'string' ||
    typeof record.personalityId !== 'string' ||
    !isFiniteNumber(record.personalityUpdatedAt) ||
    !Object.prototype.hasOwnProperty.call(record, 'personaCatalogSource') ||
    (typeof record.personaCatalogSource !== 'string' && record.personaCatalogSource !== null) ||
    !isFiniteNumber(record.generatedAt)
  ) {
    return null;
  }

  const entry: SummaryCacheEntry = {
    summary: record.summary,
    personalityId: record.personalityId,
    personalityUpdatedAt: record.personalityUpdatedAt,
    personaCatalogSource: record.personaCatalogSource,
    generatedAt: record.generatedAt,
  };

  if (typeof record.spendingDataVerified === 'boolean') {
    entry.spendingDataVerified = record.spendingDataVerified;
  }
  if (typeof record.subscriptionLookupVerified === 'boolean') {
    entry.subscriptionLookupVerified = record.subscriptionLookupVerified;
  }
  if (typeof record.modelId === 'string') {
    entry.modelId = record.modelId;
  }
  if (typeof record.fanAccountId === 'string' || record.fanAccountId === null) {
    entry.fanAccountId = record.fanAccountId;
  }

  const agencyHubSync = normalizeSummarySyncMetadata(record.agencyHubSync);
  if (agencyHubSync) {
    entry.agencyHubSync = agencyHubSync;
  }

  return entry;
}

export function collectSummaryCacheEntries(
  storage: object,
): Record<SummaryCacheKey, SummaryCacheEntry> {
  const entries: Record<SummaryCacheKey, SummaryCacheEntry> = {};
  for (const [key, value] of Object.entries(storage)) {
    if (!isSummaryCacheKey(key)) {
      continue;
    }

    const normalized = normalizeSummaryCacheEntry(value);
    if (normalized) {
      entries[key] = normalized;
    }
  }

  return entries;
}

export function getInvalidSummaryCacheKeys(storage: object): SummaryCacheKey[] {
  return Object.entries(storage)
    .filter(([key, value]) =>
      isSummaryCacheKey(key) && !normalizeSummaryCacheEntry(value),
    )
    .map(([key]) => key as SummaryCacheKey);
}

export function listSummaryCacheEntries(
  storage: object,
): Array<[SummaryCacheKey, SummaryCacheEntry]> {
  return Object.entries(collectSummaryCacheEntries(storage)) as Array<[
    SummaryCacheKey,
    SummaryCacheEntry,
  ]>;
}

export function getSummaryCacheEntry(
  storage: object,
  groupId: string,
): SummaryCacheEntry | null {
  const value = (storage as Record<string, unknown>)[summaryCacheKey(groupId)];
  return normalizeSummaryCacheEntry(value);
}

export function getSummaryCacheKeysForPersonality(
  storage: object,
  personalityId: string,
): SummaryCacheKey[] {
  return listSummaryCacheEntries(storage)
    .filter(([, entry]) => entry.personalityId === personalityId)
    .map(([key]) => key);
}

export function getSummaryCacheKeysReferencingPersonality(
  storage: object,
  personalityId: string,
): SummaryCacheKey[] {
  return Object.entries(storage)
    .filter(([key, value]) => {
      if (!isSummaryCacheKey(key) || !value || typeof value !== 'object') {
        return false;
      }
      return (value as Record<string, unknown>).personalityId === personalityId;
    })
    .map(([key]) => key as SummaryCacheKey);
}

export function getOldestSummaryCacheKeys(
  storage: object,
  count: number,
): SummaryCacheKey[] {
  return listSummaryCacheEntries(storage)
    .sort((left, right) => left[1].generatedAt - right[1].generatedAt)
    .slice(0, count)
    .map(([key]) => key);
}

export function getSummaryCacheEvictionKeys(
  storage: object,
  count: number,
): SummaryCacheKey[] {
  if (count <= 0) {
    return [];
  }

  return [
    ...getInvalidSummaryCacheKeys(storage),
    ...getOldestSummaryCacheKeys(storage, count),
  ].slice(0, count);
}

export class SummaryCacheStore {
  constructor(
    private readonly storage: SummaryCacheStorageArea,
    private readonly loadState: () => Promise<object>,
    private readonly options: SummaryCacheStoreOptions,
  ) {}

  async get(groupId: string): Promise<SummaryCacheEntry | null> {
    const key = summaryCacheKey(groupId);
    const result = await this.storage.get(key);
    return normalizeSummaryCacheEntry(result[key]);
  }

  async save(groupId: string, entry: SummaryCacheEntry): Promise<void> {
    const key = summaryCacheKey(groupId);
    const normalizedEntry = normalizeSummaryCacheEntry(entry);
    if (!normalizedEntry) {
      throw new Error('Invalid summary cache entry');
    }

    try {
      await this.setEntry(key, normalizedEntry);
    } catch {
      const keysToRemove = getSummaryCacheEvictionKeys(
        await this.storage.get(null),
        this.options.evictionCount,
      );
      if (keysToRemove.length > 0) {
        await this.removeKeys(keysToRemove);
      }
      await this.setEntry(key, normalizedEntry);
    }
  }

  async update(
    groupId: string,
    updater: (entry: SummaryCacheEntry) => SummaryCacheEntry,
  ): Promise<SummaryCacheEntry | null> {
    const key = summaryCacheKey(groupId);
    const currentEntry = getSummaryCacheEntry(await this.loadState(), groupId);
    if (!currentEntry) {
      return null;
    }

    const nextEntry = normalizeSummaryCacheEntry(updater(currentEntry));
    if (!nextEntry) {
      throw new Error('Invalid summary cache entry');
    }

    await this.setEntry(key, nextEntry);
    return nextEntry;
  }

  async remove(groupId: string): Promise<void> {
    await this.removeKeys([summaryCacheKey(groupId)]);
  }

  private async setEntry(
    key: SummaryCacheKey,
    entry: SummaryCacheEntry,
  ): Promise<void> {
    const items = { [key]: entry };
    await this.storage.set(items);
    this.options.afterSet?.(items);
  }

  private async removeKeys(keys: SummaryCacheKey[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }

    await this.storage.remove(keys.length === 1 ? keys[0]! : keys);
    this.options.afterRemove?.(keys);
  }
}

export function isValidSummaryCacheEntry(
  entry: SummaryCacheEntry | null | undefined,
  personalityId: string,
  personalityUpdatedAt: number,
  personaCatalogSource: string | null,
  modelId: string,
): entry is SummaryCacheEntry {
  return Boolean(
    entry &&
    entry.personalityId === personalityId &&
    entry.personalityUpdatedAt === personalityUpdatedAt &&
    entry.personaCatalogSource === personaCatalogSource &&
    (entry.modelId ?? null) === (modelId ?? null) &&
    entry.spendingDataVerified === true &&
    entry.subscriptionLookupVerified === true
  );
}

export function hasAvailableFanSummary(
  storage: PersistedState,
  groupId: string | null,
  mappedPersonalityId: string | null,
): boolean {
  if (!groupId || !mappedPersonalityId) {
    return false;
  }

  const personality = findActivePersona(storage.personaCatalog, mappedPersonalityId);
  if (!personality) {
    return false;
  }

  const summaryEntry = getSummaryCacheEntry(storage, groupId);

  // Stage 32: models are kernel config — 'kernel' is the cache model pin.
  return isValidSummaryCacheEntry(
    summaryEntry,
    personality.key,
    personality.version,
    storage.personaCatalogSource,
    'kernel',
  );
}
