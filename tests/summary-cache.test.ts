import { describe, expect, it } from 'vitest';
import {
  collectSummaryCacheEntries,
  getInvalidSummaryCacheKeys,
  getOldestSummaryCacheKeys,
  getSummaryCacheEvictionKeys,
  getSummaryCacheEntry,
  isValidSummaryCacheEntry,
  normalizeSummaryCacheEntry,
  SummaryCacheStore,
} from '../src/shared/summary-cache.js';
import type { SummaryCacheEntry } from '../src/shared/types.js';

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
