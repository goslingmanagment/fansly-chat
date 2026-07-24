import { describe, expect, it } from 'vitest';
import {
  collectSummaryCacheEntries,
  getInvalidSummaryCacheKeys,
  getOldestSummaryCacheKeys,
  getSummaryCacheEvictionKeys,
  getSummaryCacheEntry,
  hasAvailableFanSummary,
  isSummaryCacheKey,
  isValidSummaryCacheEntry,
  normalizeSummaryCacheEntry,
  summaryCacheKey,
  SummaryCacheStore,
} from '../src/shared/summary-cache.js';
import { getErrorMessage } from '../src/shared/errors.js';
import type { PersistedState, SummaryCacheEntry } from '../src/shared/types.js';

describe('summary cache model matching', () => {
  it('Stage 32: model matching is a strict pin against the kernel sentinel', () => {
    const entry: SummaryCacheEntry = {
      summary: 'Cached',
      personalityId: 'personality-1',
      personaDefinitionId: 'v1:persona-one-definition',
      personalityUpdatedAt: 1000,
      personaCatalogSource: 'source-a',
      generatedAt: 456,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: 'kernel',
      trustedTerminal: true,
    };
    expect(isValidSummaryCacheEntry(
      entry,
      'personality-1',
      'v1:persona-one-definition',
      'source-a',
      'kernel',
    )).toBe(true);
    // Pre-cutover entries pinned to vendor ids invalidate once (recorded trade).
    expect(isValidSummaryCacheEntry(
      { ...entry, modelId: 'anthropic:claude-sonnet-4-6' },
      'personality-1',
      'v1:persona-one-definition',
      'source-a',
      'kernel',
    )).toBe(false);
  });

  it('uses the opaque definition id as identity and treats numeric version as metadata', () => {
    const entry: SummaryCacheEntry = {
      summary: 'Cached',
      personalityId: 'personality-1',
      personaDefinitionId: 'v1:persona-one-definition',
      personalityUpdatedAt: 1000,
      personaCatalogSource: 'source-a',
      generatedAt: 456,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: 'kernel',
      trustedTerminal: true,
    };

    expect(isValidSummaryCacheEntry(
      { ...entry, personalityUpdatedAt: 1 },
      'personality-1',
      'v1:persona-one-definition',
      'source-a',
      'kernel',
    )).toBe(true);
    expect(isValidSummaryCacheEntry(
      entry,
      'personality-1',
      'v1:persona-two-definition',
      'source-a',
      'kernel',
    )).toBe(false);
    expect(normalizeSummaryCacheEntry({
      ...entry,
      personaDefinitionId: undefined,
    })).toBeNull();
  });

  it('requires the trustedTerminal marker — a pre-guard/legacy entry is not a valid hit', () => {
    const base: SummaryCacheEntry = {
      summary: 'Cached',
      personalityId: 'personality-1',
      personaDefinitionId: 'v1:persona-one-definition',
      personalityUpdatedAt: 1000,
      personaCatalogSource: 'source-a',
      generatedAt: 456,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId: 'kernel',
    };
    const args = ['personality-1', 'v1:persona-one-definition', 'source-a', 'kernel'] as const;
    // Legacy/pre-guard entry (no marker) — possibly a truncated recap cached
    // before fan-summary was exhaustion-guarded — must NOT serve a cache hit.
    expect(isValidSummaryCacheEntry(base, ...args)).toBe(false);
    // An entry written behind the exhaustion + empty fail-closed guards is valid.
    expect(isValidSummaryCacheEntry({ ...base, trustedTerminal: true }, ...args)).toBe(true);
    // The marker survives normalization/collect (a fresh entry stays valid); a
    // legacy entry normalizes fine but simply carries no marker.
    expect(normalizeSummaryCacheEntry({ ...base, trustedTerminal: true }))
      .toMatchObject({ trustedTerminal: true });
    expect(normalizeSummaryCacheEntry(base)).not.toHaveProperty('trustedTerminal');
  });
});

describe('summary cache boundaries', () => {
  const validEntry: SummaryCacheEntry = {
    summary: 'Cached',
    personalityId: 'p1',
    personaDefinitionId: 'v1:persona-one-definition',
    personalityUpdatedAt: 123,
    personaCatalogSource: 'source-a',
    generatedAt: 456,
    spendingDataVerified: true,
    subscriptionLookupVerified: true,
    modelId: 'anthropic:claude-opus-4-6',
    trustedTerminal: true,
  };

  it('normalizes valid entries and drops corrupt summary cache values', () => {
    expect(normalizeSummaryCacheEntry(validEntry)).toEqual(validEntry);
    expect(normalizeSummaryCacheEntry({ summary: 'missing metadata' })).toBeNull();
    expect(normalizeSummaryCacheEntry({
      ...validEntry,
      personaCatalogSource: undefined,
    })).toBeNull();

    const entries = collectSummaryCacheEntries({
      'summary:group-1': validEntry,
      'summary:group-2': { summary: 'missing metadata' },
      settings: {},
    });

    expect(entries).toEqual({ 'summary:group-1': validEntry });
    expect(getSummaryCacheEntry(entries, 'group-1')).toEqual(validEntry);
    expect(getSummaryCacheEntry(entries, 'group-2')).toBeNull();
  });

  it('preserves recap coverage metadata while accepting legacy entries without it', () => {
    const currentEntry: SummaryCacheEntry = {
      ...validEntry,
      transcriptCoverage: 'window',
      keptCount: 300,
    };

    expect(normalizeSummaryCacheEntry(currentEntry)).toEqual(currentEntry);
    expect(normalizeSummaryCacheEntry(validEntry)).toEqual(validEntry);
    expect(normalizeSummaryCacheEntry({
      ...validEntry,
      transcriptCoverage: 'unknown',
      keptCount: -1,
    })).toEqual(validEntry);
  });

  it('canonicalizes a persisted retired sync error through its registry tombstone', () => {
    const normalized = normalizeSummaryCacheEntry({
      ...validEntry,
      agencyHubSync: {
        state: 'failed',
        generatedAt: validEntry.generatedAt,
        error: {
          key: 'missing_api_key',
          code: 'CG-AUTH-01',
          message: 'Claude API key not configured.',
          description: 'Open Settings and add a valid Claude API key.',
          httpStatus: 401,
          serverDetail: 'legacy detail',
        },
      },
    });

    expect(normalized?.agencyHubSync).toMatchObject({
      state: 'failed',
      error: {
        ...getErrorMessage('missing_api_key'),
        httpStatus: 401,
        serverDetail: 'legacy detail',
      },
    });
    const sync = normalized?.agencyHubSync;
    if (sync?.state !== 'failed') {
      throw new Error('Expected a normalized failed sync status');
    }
    expect(sync.error?.message).not.toContain('Claude');
  });

  it('lists corrupt raw entries separately from normalized cache entries', () => {
    expect(
      getInvalidSummaryCacheKeys({
        'summary:group-1': validEntry,
        'summary:group-2': { summary: 'missing metadata', personalityId: 'p1' },
        settings: {},
      }),
    ).toEqual(['summary:group-2']);
  });

  it('selects the oldest valid entries for quota eviction', () => {
    expect(
      getOldestSummaryCacheKeys(
        {
          'summary:new': { ...validEntry, generatedAt: 300 },
          'summary:old': { ...validEntry, generatedAt: 100 },
          'summary:corrupt': { summary: 'bad' },
          'summary:middle': { ...validEntry, generatedAt: 200 },
        },
        2,
      ),
    ).toEqual(['summary:old', 'summary:middle']);
  });

  it('prefers invalid raw entries before valid entries when selecting quota eviction keys', () => {
    expect(
      getSummaryCacheEvictionKeys(
        {
          'summary:new': { ...validEntry, generatedAt: 300 },
          'summary:old': { ...validEntry, generatedAt: 100 },
          'summary:corrupt': { summary: 'bad' },
        },
        2,
      ),
    ).toEqual(['summary:corrupt', 'summary:old']);
  });

  it('encapsulates storage reads, eviction, writes, and removes', async () => {
    const backing: Record<string, unknown> = {
      'summary:old': { ...validEntry, generatedAt: 100 },
      'summary:new': { ...validEntry, generatedAt: 200 },
    };
    const removed: string[] = [];
    let failNextSet = true;
    const store = new SummaryCacheStore(
      {
        async get(key) {
          if (typeof key === 'string') {
            return { [key]: backing[key] };
          }
          return { ...backing };
        },
        async set(items) {
          if (failNextSet) {
            failNextSet = false;
            throw new Error('quota');
          }
          Object.assign(backing, items);
        },
        async remove(keys) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          removed.push(...keyList);
          for (const key of keyList) {
            delete backing[key];
          }
        },
      },
      async () => backing,
      { evictionCount: 1 },
    );

    await store.save('saved', validEntry);

    expect(removed).toEqual(['summary:old']);
    expect(await store.get('saved')).toEqual(validEntry);
    expect(await store.update('saved', (entry) => ({ ...entry, summary: 'Updated' }))).toMatchObject({
      summary: 'Updated',
    });
    await store.remove('saved');
    expect(backing['summary:saved']).toBeUndefined();
  });

  it('evicts raw corrupt entries when quota retry cannot find enough valid summaries', async () => {
    const backing: Record<string, unknown> = {
      'summary:corrupt': { summary: 'bad', personalityId: 'p1' },
    };
    const removed: string[] = [];
    let failNextSet = true;
    const store = new SummaryCacheStore(
      {
        async get(key) {
          if (key === null || key === undefined) {
            return { ...backing };
          }
          if (typeof key === 'string') {
            return { [key]: backing[key] };
          }
          return {};
        },
        async set(items) {
          if (failNextSet) {
            failNextSet = false;
            throw new Error('quota');
          }
          Object.assign(backing, items);
        },
        async remove(keys) {
          const keyList = Array.isArray(keys) ? keys : [keys];
          removed.push(...keyList);
          for (const key of keyList) {
            delete backing[key];
          }
        },
      },
      async () => backing,
      { evictionCount: 1 },
    );

    await store.save('saved', validEntry);

    expect(removed).toEqual(['summary:corrupt']);
    expect(backing['summary:corrupt']).toBeUndefined();
    expect(backing['summary:saved']).toEqual(validEntry);
  });
});

describe('summary cache mode-qualified keys (short recap)', () => {
  const validEntry: SummaryCacheEntry = {
    summary: 'Cached',
    personalityId: 'p1',
    personaDefinitionId: 'v1:persona-one-definition',
    personalityUpdatedAt: 123,
    personaCatalogSource: 'source-a',
    generatedAt: 456,
    spendingDataVerified: true,
    subscriptionLookupVerified: true,
    modelId: 'kernel',
    // A valid (servable) entry carries the trusted-terminal marker that
    // isValidSummaryCacheEntry / hasAvailableFanSummary require.
    trustedTerminal: true,
  };

  it('routes full to the legacy prefix and short to summary-short:', () => {
    expect(summaryCacheKey('group-1')).toBe('summary:group-1');
    expect(summaryCacheKey('group-1', 'full')).toBe('summary:group-1');
    expect(summaryCacheKey('group-1', 'short')).toBe('summary-short:group-1');
  });

  it('recognizes both prefixes as summary cache keys, disjointly', () => {
    expect(isSummaryCacheKey('summary:group-1')).toBe(true);
    expect(isSummaryCacheKey('summary-short:group-1')).toBe(true);
    expect(isSummaryCacheKey('settings')).toBe(false);
    // The two prefixes never overlap: a short key is NOT a full key.
    expect('summary-short:group-1'.startsWith('summary:')).toBe(false);
  });

  it('reads the entry for the requested mode independently', () => {
    const storage = {
      'summary:group-1': { ...validEntry, summary: 'FULL' },
      'summary-short:group-1': { ...validEntry, summary: 'SHORT' },
    };
    expect(getSummaryCacheEntry(storage, 'group-1')?.summary).toBe('FULL');
    expect(getSummaryCacheEntry(storage, 'group-1', 'full')?.summary).toBe('FULL');
    expect(getSummaryCacheEntry(storage, 'group-1', 'short')?.summary).toBe('SHORT');
  });

  it('a short entry alone never satisfies hasAvailableFanSummary (full-only)', () => {
    const storage = {
      personaCatalog: [{
        key: 'p1',
        displayName: 'Closer',
        definitionId: 'v1:persona-one-definition',
        version: 123,
        status: 'active',
      }],
      personaCatalogSource: 'source-a',
      'summary-short:group-1': validEntry,
    } as unknown as PersistedState;
    expect(hasAvailableFanSummary(storage, 'group-1', 'p1')).toBe(false);

    // The same body under the FULL key does satisfy it.
    const withFull = { ...storage, 'summary:group-1': validEntry } as unknown as PersistedState;
    expect(hasAvailableFanSummary(withFull, 'group-1', 'p1')).toBe(true);
  });

  it('eviction and invalid-key sweeps span both prefixes', () => {
    const storage = {
      'summary:full-old': { ...validEntry, generatedAt: 100 },
      'summary-short:short-new': { ...validEntry, generatedAt: 300 },
      'summary-short:corrupt': { summary: 'bad' },
    };
    expect(getInvalidSummaryCacheKeys(storage)).toEqual(['summary-short:corrupt']);
    // Oldest-first across both prefixes; corrupt keys go first for eviction.
    expect(getSummaryCacheEvictionKeys(storage, 2)).toEqual([
      'summary-short:corrupt',
      'summary:full-old',
    ]);
  });

  it('SummaryCacheStore.save writes under the mode-qualified key', async () => {
    const backing: Record<string, unknown> = {};
    const store = new SummaryCacheStore(
      {
        async get(key) {
          if (typeof key === 'string') return { [key]: backing[key] };
          return { ...backing };
        },
        async set(items) { Object.assign(backing, items); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete backing[key];
        },
      },
      async () => backing,
      { evictionCount: 1 },
    );

    await store.save('group-1', validEntry, 'short');
    expect(backing['summary-short:group-1']).toEqual(validEntry);
    expect(backing['summary:group-1']).toBeUndefined();
    expect(await store.get('group-1', 'short')).toEqual(validEntry);
    expect(await store.get('group-1', 'full')).toBeNull();
  });
});
