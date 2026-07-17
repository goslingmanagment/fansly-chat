import { describe, expect, it } from 'vitest';
import {
  buildPersonaRowViews,
  classifyPersonaEmptyState,
  countMappingsByPersona,
  formatCatalogChangedAt,
} from '../src/options/personas.js';
import { BUNDLED_LORA_PERSONALITY_ID } from '../src/shared/personalities.js';
import type { PersonaCatalogEntry } from '../src/shared/types.js';

const entry = (over: Partial<PersonaCatalogEntry>): PersonaCatalogEntry => ({
  key: 'k', displayName: 'Name', version: 1,
  definitionId: 'definition-id-16chars', status: 'active', ...over,
});

describe('countMappingsByPersona', () => {
  it('counts accountMappings per persona key', () => {
    const counts = countMappingsByPersona({ a: 'k1', b: 'k1', c: 'k2' });
    expect(counts.get('k1')).toBe(2);
    expect(counts.get('k2')).toBe(1);
  });
});

describe('buildPersonaRowViews', () => {
  it('flags built-in, carries version and mapping count', () => {
    const [view] = buildPersonaRowViews(
      [entry({ key: BUNDLED_LORA_PERSONALITY_ID, displayName: 'Lora', version: 3 })],
      { acc1: BUNDLED_LORA_PERSONALITY_ID, acc2: BUNDLED_LORA_PERSONALITY_ID },
    );
    expect(view).toMatchObject({ builtin: true, archived: false, version: 3, accountCount: 2 });
  });

  it('hides an archived persona that no mapping references', () => {
    const views = buildPersonaRowViews([entry({ key: 'old', status: 'archived' })], {});
    expect(views).toHaveLength(0);
  });

  it('keeps an archived persona while a mapping still points at it', () => {
    const views = buildPersonaRowViews(
      [entry({ key: 'old', status: 'archived' })],
      { acc1: 'old' },
    );
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ archived: true, accountCount: 1 });
  });
});

describe('classifyPersonaEmptyState', () => {
  // "Loaded for THESE creds" needs BOTH source match AND a landed fetch
  // (fetchedAt !== null). clearForSource stamps the new source with fetchedAt null
  // before any request, and a failed refresh leaves that {match, null} triple —
  // so source match alone must NOT be read as "server returned an empty catalog".
  const fetched = '2026-07-17T12:00:00Z';
  it('no bearer/address → no-credentials (even with a leftover stored source)', () => {
    expect(classifyPersonaEmptyState({ currentSource: null, storedSource: null, fetchedAt: null }))
      .toBe('no-credentials');
    expect(classifyPersonaEmptyState({ currentSource: null, storedSource: 'http://h|old', fetchedAt: fetched }))
      .toBe('no-credentials');
  });
  it('creds set but catalog not synced to THESE creds → awaiting-refresh (rotation/first load)', () => {
    expect(classifyPersonaEmptyState({ currentSource: 'http://h|new', storedSource: null, fetchedAt: null }))
      .toBe('awaiting-refresh');
    expect(classifyPersonaEmptyState({ currentSource: 'http://h|new', storedSource: 'http://h|old', fetchedAt: fetched }))
      .toBe('awaiting-refresh');
  });
  it('source matches but nothing fetched yet (cleared cache / failed refresh) → awaiting-refresh, never «пустой каталог»', () => {
    expect(classifyPersonaEmptyState({ currentSource: 'http://h|new', storedSource: 'http://h|new', fetchedAt: null }))
      .toBe('awaiting-refresh');
  });
  it('source matches AND a fetch landed, server returned zero → empty-catalog', () => {
    expect(classifyPersonaEmptyState({ currentSource: 'http://h|new', storedSource: 'http://h|new', fetchedAt: fetched }))
      .toBe('empty-catalog');
  });
});

describe('formatCatalogChangedAt', () => {
  it('renders "изменялся" relative time (last-CHANGED, not last-checked); a dash when undated', () => {
    const base = Date.parse('2026-07-17T12:00:00Z');
    // null no longer means "not loaded" (the classifier decides that from source
    // match now) — it just means we have no change timestamp: render a dash.
    expect(formatCatalogChangedAt(null, base)).toBe('каталог изменялся: —');
    expect(formatCatalogChangedAt('2026-07-17T12:00:00Z', base)).toBe('каталог изменялся только что');
    expect(formatCatalogChangedAt('2026-07-17T11:55:00Z', base)).toBe('каталог изменялся 5 мин назад');
    expect(formatCatalogChangedAt('2026-07-17T09:00:00Z', base)).toBe('каталог изменялся 3 ч назад');
    expect(formatCatalogChangedAt('2026-07-15T12:00:00Z', base)).toBe('каталог изменялся 2 дн назад');
  });
});
