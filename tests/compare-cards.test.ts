import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import type { PersistedState } from '../src/shared/types.js';

function createStorage(overrides?: Partial<PersistedState>): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: {
      agencyHubBaseUrl: '',
      agencyHubDeviceToken: '',
      quickMessageCount: 100,
      pingMessageCount: 100,
      improveMessageCount: 100,
      deepMessageCount: 500,
      debugMode: false,
      promptCachingEnabled: true,
      uiTheme: 'system',
      showToolbarHints: true,
      coachHistoryLimit: 10,
      coachAutoRecap: 'off',
      messageSoundEnabled: true,
      messageSoundTone: 'blip',
      messageSoundVolume: 50,
      messageSoundMutedAccountIds: [],
      followSoundEnabled: true,
      followSoundTone: 'double',
    },
    personalities: [],
    personaCatalog: [],
    personaCatalogSource: null,
    personaCatalogFetchedAt: null,
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
      personaCatalog: [
        {
          key: 'personality-1',
          displayName: 'A-card',
          definitionId: 'v1:persona-one-definition',
          version: 1,
          status: 'active',
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
      personaCatalog: [
        {
          key: 'personality-1',
          displayName: 'Closer',
          definitionId: 'v1:persona-one-definition',
          version: 1,
          status: 'active',
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
      personaCatalog: [
        {
          key: 'personality-1',
          displayName: 'Closer',
          definitionId: 'v1:persona-two-definition',
          version: 2,
          status: 'active',
        },
      ],
    });
    const changedVersionOnlyStorage = createStorage({
      ...baseStorage,
      personaCatalog: [
        {
          ...baseStorage.personaCatalog[0]!,
          version: 999,
        },
      ],
    });
    const changedSourceStorage = createStorage({
      ...baseStorage,
      personaCatalogSource: 'source-b',
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
        changedVersionOnlyStorage,
        'personality-1',
      ),
    ).toBe(baseFingerprint);
    expect(
      compareCards.getCompareCardsFingerprintForPersonality(
        changedContentStorage,
        'personality-1',
      ),
    ).not.toBe(baseFingerprint);
    expect(
      compareCards.getCompareCardsFingerprintForPersonality(
        changedSourceStorage,
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
