import { SUMMARY_CACHE_PREFIX } from './constants.js';
import type { PersistedState, SummaryCacheEntry } from './types.js';

export function isValidSummaryCacheEntry(
  entry: SummaryCacheEntry | null | undefined,
  personalityId: string,
  personalityUpdatedAt: number,
  modelId: string,
): entry is SummaryCacheEntry {
  return Boolean(
    entry &&
    entry.personalityId === personalityId &&
    entry.personalityUpdatedAt === personalityUpdatedAt &&
    entry.modelId === modelId &&
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

  const personality = storage.personalities.find(
    (entry) => entry.id === mappedPersonalityId,
  );
  if (!personality) {
    return false;
  }

  const summaryEntry = (
    storage as unknown as Record<string, unknown>
  )[`${SUMMARY_CACHE_PREFIX}${groupId}`] as SummaryCacheEntry | undefined;

  return isValidSummaryCacheEntry(
    summaryEntry,
    personality.id,
    personality.updatedAt,
    storage.settings.featureModels['fan-summary'],
  );
}
