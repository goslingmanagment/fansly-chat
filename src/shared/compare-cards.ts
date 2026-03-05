import { COMPARE_DRAFT_CARDS } from './generated/compare-drafts.js';
import type { CompareModelCard, PersistedState } from './types.js';

export function resolveMappedPersonalityId(
  accountMappings: Record<string, string>,
  resolvedAccountId: string | null,
  legacyAccountId: string | null,
): string | null {
  if (resolvedAccountId) {
    const resolved = accountMappings[resolvedAccountId];
    if (resolved) {
      return resolved;
    }
  }

  if (legacyAccountId && legacyAccountId !== resolvedAccountId) {
    return accountMappings[legacyAccountId] ?? null;
  }

  return null;
}

export function getCompareDraftCount(): number {
  return COMPARE_DRAFT_CARDS.length;
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

export function resolveCompareModelCards(
  storage: PersistedState,
  resolvedAccountId: string | null,
  legacyAccountId: string | null,
): CompareModelCard[] {
  const draftCards: CompareModelCard[] = COMPARE_DRAFT_CARDS.map((card) => ({
    ...card,
    source: 'draft',
  }));

  const personalityId = resolveMappedPersonalityId(
    storage.accountMappings,
    resolvedAccountId,
    legacyAccountId,
  );
  const personality = personalityId
    ? storage.personalities.find((entry) => entry.id === personalityId) ?? null
    : null;

  if (!personality) {
    return draftCards;
  }

  const duplicateLabel = draftCards.some((card) => normalizeLabel(card.label) === normalizeLabel(personality.name));
  const currentCard: CompareModelCard = {
    id: `current:${personality.id}`,
    label: duplicateLabel ? `${personality.name} (current)` : personality.name,
    content: personality.content,
    source: 'current',
  };

  return [currentCard, ...draftCards];
}
