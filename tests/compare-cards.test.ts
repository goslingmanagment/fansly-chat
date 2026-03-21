import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FEATURE_MODELS, STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import type { PersistedState } from '../src/shared/types.js';

function createStorage(overrides?: Partial<PersistedState>): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: {
      claudeApiKey: 'sk-test',
      agencyHubBaseUrl: '',
      agencyHubApiKey: '',
      quickMessageCount: 100,
      improveMessageCount: 100,
      deepMessageCount: 500,
      debugMode: false,
      promptCachingEnabled: true,
      featureModels: { ...DEFAULT_FEATURE_MODELS },
    },
    personalities: [],
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
    ...overrides,
  };
}

async function importCompareCardsModule(drafts: Record<string, string>) {
  vi.resetModules();
  vi.doMock('virtual:model-card-drafts', () => ({
    default: drafts,
  }));
  return import('../src/shared/compare-cards.js');
}

describe('compare cards', () => {
  afterEach(() => {
    vi.doUnmock('virtual:model-card-drafts');
    vi.restoreAllMocks();
  });

  it('returns no draft cards when the virtual drafts module is empty', async () => {
    const compareCards = await importCompareCardsModule({});
    const storage = createStorage();

    expect(compareCards.getCompareDraftCount()).toBe(0);
    expect(
      compareCards.resolveCompareModelCardsForPersonality(storage, null),
    ).toEqual([]);
  });

  it('orders draft cards stably and deduplicates the current label', async () => {
    const compareCards = await importCompareCardsModule({});
    const storage = createStorage({
      personalities: [
        {
          id: 'personality-1',
          name: 'A-card',
          content: 'Current personality',
          updatedAt: 1000,
        },
      ],
    });

    const cards = compareCards.resolveCompareModelCardsForDrafts(
      storage,
      'personality-1',
      {
        'b-card': 'B',
        'A-card': 'A',
        'c-card': 'C',
      },
    );

    expect(cards.map((card) => card.label)).toEqual([
      'A-card (current)',
      'A-card',
      'b-card',
      'c-card',
    ]);
  });

  it('hashes only ordered card contents, not unrelated settings', async () => {
    const compareCards = await importCompareCardsModule({
      draft: 'Draft content',
    });
    const baseStorage = createStorage({
      personalities: [
        {
          id: 'personality-1',
          name: 'Closer',
          content: 'Current content',
          updatedAt: 1000,
        },
      ],
    });
    const changedSettingsStorage = createStorage({
      ...baseStorage,
      settings: {
        ...baseStorage.settings,
        debugMode: true,
        deepMessageCount: 900,
      },
    });
    const changedContentStorage = createStorage({
      ...baseStorage,
      personalities: [
        {
          id: 'personality-1',
          name: 'Closer',
          content: 'Changed content',
          updatedAt: 2000,
        },
      ],
    });

    const baseFingerprint =
      compareCards.getCompareCardsFingerprintForPersonality(
        baseStorage,
        'personality-1',
      );

    expect(
      compareCards.getCompareCardsFingerprintForPersonality(
        changedSettingsStorage,
        'personality-1',
      ),
    ).toBe(baseFingerprint);
    expect(
      compareCards.getCompareCardsFingerprintForPersonality(
        changedContentStorage,
        'personality-1',
      ),
    ).not.toBe(baseFingerprint);
  });

  it('resolves a canonical mapping through a stored legacy alias', async () => {
    const compareCards = await importCompareCardsModule({});

    expect(
      compareCards.resolveMappedPersonalityId(
        { resolved: 'personality-1' },
        null,
        'legacy',
        { legacy: 'resolved' },
      ),
    ).toBe('personality-1');
  });
});
