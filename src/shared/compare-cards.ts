import modelCardDrafts from 'virtual:model-card-drafts';
import { buildAccountLookupOrder } from './account-aliases.js';
import { findActivePersona } from './persona-catalog.js';
import type { CompareModelCard, PersistedState } from './types.js';

type CompareDraftOverrideGlobal = typeof globalThis & {
  __CHATGOOSE_COMPARE_DRAFTS__?: Record<string, string>;
};

function getCompareDraftSource(): Record<string, string> {
  return (
    (globalThis as CompareDraftOverrideGlobal).__CHATGOOSE_COMPARE_DRAFTS__ ??
    modelCardDrafts
  );
}

export function resolveMappedPersonalityId(
  accountMappings: Record<string, string>,
  resolvedAccountId: string | null,
  legacyAccountId: string | null,
  accountAliases: Record<string, string> = {},
): string | null {
  const lookupOrder = buildAccountLookupOrder(
    accountAliases,
    resolvedAccountId,
    legacyAccountId,
  );
  for (const accountId of lookupOrder) {
    const mapped = accountMappings[accountId];
    if (mapped) {
      return mapped;
    }
  }

  return null;
}

export function getCompareDraftCount(): number {
  return Object.keys(getCompareDraftSource()).length;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

function compareDraftNames(left: string, right: string): number {
  return left.localeCompare(right, 'en', {
    sensitivity: 'base',
    numeric: true,
  });
}

export function resolveCompareDraftCards(
  drafts: Record<string, string>,
): CompareModelCard[] {
  return Object.entries(drafts)
    .sort(([left], [right]) => compareDraftNames(left, right))
    .map(([label, content]) => ({
      id: label,
      label,
      content,
      source: 'draft',
    }));
}

export function resolveCompareModelCardsForPersonality(
  storage: PersistedState,
  personalityId: string | null,
): CompareModelCard[] {
  return resolveCompareModelCardsForDrafts(
    storage,
    personalityId,
    getCompareDraftSource(),
  );
}

export function resolveCompareModelCardsForDrafts(
  storage: PersistedState,
  personalityId: string | null,
  drafts: Record<string, string>,
): CompareModelCard[] {
  const draftCards = resolveCompareDraftCards(drafts);
  const personality = findActivePersona(storage.personaCatalog, personalityId);

  if (!personality) {
    return draftCards;
  }

  const duplicateLabel = draftCards.some(
    (card) => normalizeLabel(card.label) === normalizeLabel(personality.displayName),
  );
  const currentCard: CompareModelCard = {
    id: `current:${personality.key}`,
    label: duplicateLabel
      ? `${personality.displayName} (current)`
      : personality.displayName,
    // Content never enters the client. This internal identity string exists
    // only so compare fingerprints invalidate when exact definition bytes move.
    content: `persona:${storage.personaCatalogSource ?? 'unscoped'}:${personality.key}@${personality.definitionId}`,
    source: 'current',
  };

  return [currentCard, ...draftCards];
}

export function resolveCompareModelCards(
  storage: PersistedState,
  resolvedAccountId: string | null,
  legacyAccountId: string | null,
): CompareModelCard[] {
  const rawPersonalityId = resolveMappedPersonalityId(
    storage.accountMappings,
    resolvedAccountId,
    legacyAccountId,
    storage.accountAliases,
  );
  const personalityId = findActivePersona(
    storage.personaCatalog,
    rawPersonalityId,
  )?.key ?? null;
  return resolveCompareModelCardsForPersonality(storage, personalityId);
}

function hashString(seed: number, value: string): number {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function fingerprintCompareCardContents(
  cards: ReadonlyArray<Pick<CompareModelCard, 'content'>>,
): string {
  let hash = 2166136261;
  for (const card of cards) {
    hash = hashString(hash, `${card.content.length}:`);
    hash = hashString(hash, card.content);
  }
  return hash.toString(16).padStart(8, '0');
}

export function getCompareCardsFingerprint(
  storage: PersistedState,
  resolvedAccountId: string | null,
  legacyAccountId: string | null,
): string {
  return fingerprintCompareCardContents(
    resolveCompareModelCards(storage, resolvedAccountId, legacyAccountId),
  );
}

export function getCompareCardsFingerprintForPersonality(
  storage: PersistedState,
  personalityId: string | null,
): string {
  return fingerprintCompareCardContents(
    resolveCompareModelCardsForPersonality(storage, personalityId),
  );
}
