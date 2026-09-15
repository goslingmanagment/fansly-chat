// «Персоны» pane presentation helpers. Ported from the 2.0 P3 suite
// (3ef84d8:tests/options-personas.test.ts); the catalog-date case follows this
// repo's copy-free formatter (the wording lives in `src/options/copy.ts`).

import { afterEach, describe, expect, it } from 'vitest';
import { COPY } from '../src/options/copy.js';
import {
  buildPersonaRowViews,
  classifyPersonaEmptyState,
  countMappingsByPersona,
  formatCatalogChangedDate,
} from '../src/options/personas.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import { BUNDLED_LORA_PERSONALITY_ID } from '../src/shared/personalities.js';
import { mountOptionsPage, unmountOptionsPage } from './helpers/options-page.js';
import type { MountedOptionsPage } from './helpers/options-page.js';
import type { PersonaCatalogEntry, Settings } from '../src/shared/types.js';

const entry = (over: Partial<PersonaCatalogEntry>): PersonaCatalogEntry => ({
  key: 'k',
  displayName: 'Name',
  version: 1,
  definitionId: 'definition-id-16chars',
  status: 'active',
  ...over,
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
    expect(view).toMatchObject({
      builtin: true,
      archived: false,
      version: 3,
      accountCount: 2,
    });
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
  const fetched = '2026-07-25T12:00:00Z';

  it('no bearer/address → no-credentials (even with a leftover stored source)', () => {
    expect(classifyPersonaEmptyState({
      currentSource: null,
      storedSource: null,
      fetchedAt: null,
    })).toBe('no-credentials');
    expect(classifyPersonaEmptyState({
      currentSource: null,
      storedSource: 'http://h|old',
      fetchedAt: fetched,
    })).toBe('no-credentials');
  });

  it('creds set but catalog not synced to THESE creds → awaiting-refresh', () => {
    expect(classifyPersonaEmptyState({
      currentSource: 'http://h|new',
      storedSource: null,
      fetchedAt: null,
    })).toBe('awaiting-refresh');
    expect(classifyPersonaEmptyState({
      currentSource: 'http://h|new',
      storedSource: 'http://h|old',
      fetchedAt: fetched,
    })).toBe('awaiting-refresh');
  });

  it('source matches but nothing fetched yet → awaiting-refresh, never «пусто»', () => {
    expect(classifyPersonaEmptyState({
      currentSource: 'http://h|new',
      storedSource: 'http://h|new',
      fetchedAt: null,
    })).toBe('awaiting-refresh');
  });

  it('source matches AND a fetch landed, server returned zero → empty-catalog', () => {
    expect(classifyPersonaEmptyState({
      currentSource: 'http://h|new',
      storedSource: 'http://h|new',
      fetchedAt: fetched,
    })).toBe('empty-catalog');
  });
});

describe('formatCatalogChangedDate', () => {
  it('formats the last-CHANGED moment and returns null when there is none', () => {
    // null no longer means "not loaded" (the classifier decides that from the
    // source match) — it just means there is no change date to display, and the
    // pane then says «ещё не обновлялся» from the dictionary.
    expect(formatCatalogChangedDate(null)).toBeNull();
    expect(formatCatalogChangedDate('not-a-date')).toBeNull();

    const at = new Date(2026, 6, 25, 14, 5);
    expect(formatCatalogChangedDate(at.toISOString())).toBe('25.07.2026 14:05');
  });
});

describe('«Персоны» pane', () => {
  let page: MountedOptionsPage;

  afterEach(async () => {
    await unmountOptionsPage();
    delete (globalThis as Record<string, unknown>).browser;
  });

  const HUB_SETTINGS: Partial<Settings> = {
    agencyHubBaseUrl: 'https://hub.example.test',
    agencyHubDeviceToken: 'device-x',
  };

  const emptyText = (): string | null | undefined =>
    page.document.querySelector<HTMLElement>('[data-role="persona-empty"]')?.textContent;

  const personaRow = (key: string): HTMLElement | null =>
    page.document.querySelector<HTMLElement>(`[data-persona-key="${key}"]`);

  it('says «подключись» when there are no credentials at all', async () => {
    page = await mountOptionsPage({ state: { personaCatalog: [] } });
    expect(emptyText()).toBe(COPY.personas.emptyFresh);
  });

  it('says «ещё не читался» when nothing was fetched for THESE credentials', async () => {
    // A failed refresh leaves {source: match, fetchedAt: null} — the pane must not
    // upgrade that into a claim about the server's answer.
    page = await mountOptionsPage({
      settings: HUB_SETTINGS,
      state: {
        personaCatalog: [],
        personaCatalogSource: personaCatalogSource({
          agencyHubBaseUrl: 'https://hub.example.test',
          agencyHubDeviceToken: 'device-x',
        }),
        personaCatalogFetchedAt: null,
      },
    });
    expect(emptyText()).toBe(COPY.personas.emptyUnknown);
    const catalogRow =
      page.document.querySelector<HTMLElement>('[data-role="persona-catalog"]');
    expect(catalogRow?.textContent).toContain(COPY.personas.catalogUpdatedLabel);
    expect(catalogRow?.textContent).toContain(COPY.personas.catalogNever);
  });

  it('says «каталог пуст» only once the server confirmed it for these credentials', async () => {
    const source = personaCatalogSource({
      agencyHubBaseUrl: 'https://hub.example.test',
      agencyHubDeviceToken: 'device-x',
    });
    // Freshness is measured against the wall clock, so this fixture has to be
    // relative: an absolute fetchedAt silently rots into a STALE catalog two
    // days after it is written and takes the «no staleness marker» assertion
    // below down with it. The literal date format is pinned by the
    // formatCatalogChangedDate unit test above; here we only assert the pane
    // shows the formatted value.
    const fetchedAt = new Date(Date.now() - 6 * 3_600_000).toISOString();
    page = await mountOptionsPage({
      settings: HUB_SETTINGS,
      state: {
        personaCatalog: [],
        personaCatalogSource: source,
        personaCatalogFetchedAt: fetchedAt,
      },
    });
    expect(emptyText()).toBe(COPY.personas.emptyConfirmed);
    const catalogRow =
      page.document.querySelector<HTMLElement>('[data-role="persona-catalog"]');
    // Label and value are separate nodes of the catalog card: «Сохранён»
    // is the key, the formatted date is the value.
    expect(catalogRow?.textContent).toContain(COPY.personas.catalogUpdatedLabel);
    expect(catalogRow?.textContent).toContain(formatCatalogChangedDate(fetchedAt));
    // A saved-content date does not determine freshness of the latest poll.
    const age = page.document.querySelector<HTMLElement>('.chatgoose-persona-catage');
    expect(age).toBeNull();
  });

  it('names the hub the catalog came from by its WHOLE address', async () => {
    // `normalizeAgencyHubBaseUrl` deliberately preserves a non-root path, so two
    // agencies on one host differ only there. Printing `new URL(...).host`
    // collapsed them into the same line — and the credential fingerprint half of
    // `personaCatalogSource` must never reach the screen either.
    const settings: Partial<Settings> = {
      agencyHubBaseUrl: 'https://hub.example.test/agency-b',
      agencyHubDeviceToken: 'device-x',
    };
    const source = personaCatalogSource({
      agencyHubBaseUrl: 'https://hub.example.test/agency-b',
      agencyHubDeviceToken: 'device-x',
    });
    page = await mountOptionsPage({
      settings,
      state: {
        personaCatalog: [],
        personaCatalogSource: source,
        personaCatalogFetchedAt: new Date(2026, 6, 25, 14, 5).toISOString(),
      },
    });

    const sourceRow = Array.from(
      page.document.querySelectorAll<HTMLElement>('.chatgoose-fact'),
    ).find((row) => row.textContent?.startsWith(COPY.personas.catalogSourceLabel))!;
    expect(sourceRow).toBeTruthy();
    expect(sourceRow.querySelector('.chatgoose-fact-v')?.textContent)
      .toBe('https://hub.example.test/agency-b');
    // The hash half of «baseUrl|hash» is a credential fingerprint.
    const fingerprint = source!.split('|')[1]!;
    expect(fingerprint).toBeTruthy();
    expect(page.document.body.textContent).not.toContain(fingerprint);
  });

  it('does not confuse an old content timestamp with failed or stale synchronization', async () => {
    const source = personaCatalogSource({
      agencyHubBaseUrl: 'https://hub.example.test',
      agencyHubDeviceToken: 'device-x',
    });
    page = await mountOptionsPage({
      settings: HUB_SETTINGS,
      state: {
        personaCatalog: [],
        personaCatalogSource: source,
        personaCatalogFetchedAt: new Date(Date.now() - 11 * 86_400_000).toISOString(),
      },
    });
    const age = page.document.querySelector<HTMLElement>('.chatgoose-persona-catage');
    expect(age).toBeNull();
    expect(page.document.body.textContent).toContain(COPY.personas.catalogRefreshHint);
    expect(page.document.querySelector('[data-role="persona-catalog"]')?.textContent)
      .toContain(COPY.personas.catalogUpdatedLabel);
  });

  it('renders a row with the built-in badge, mono version and mapping count', async () => {
    const source = personaCatalogSource({
      agencyHubBaseUrl: 'https://hub.example.test',
      agencyHubDeviceToken: 'device-x',
    });
    page = await mountOptionsPage({
      settings: HUB_SETTINGS,
      state: {
        personaCatalog: [{
          key: BUNDLED_LORA_PERSONALITY_ID,
          displayName: 'Lora',
          definitionId: 'v1:lora-persona-definition',
          version: 4,
          status: 'active',
        }],
        personaCatalogSource: source,
        personaCatalogFetchedAt: new Date().toISOString(),
        accountMappings: { 'acc-1': BUNDLED_LORA_PERSONALITY_ID, 'acc-2': BUNDLED_LORA_PERSONALITY_ID },
        knownAccounts: ['acc-1', 'acc-2'],
      },
    });

    const row = personaRow(BUNDLED_LORA_PERSONALITY_ID)!;
    expect(row.textContent).toContain('Lora');
    expect(row.textContent).toContain(COPY.personas.builtInBadge);
    expect(row.textContent).toContain(`${COPY.personas.versionPrefix}4`);
    // The count rides the chips' own caption since E67 — it used to sit at the
    // row's right edge, counting the very chips printed beside it.
    expect(row.querySelector('[data-role="persona-mapped"]')?.textContent)
      .toContain(COPY.personas.mappedLabel.replace('{n}', '2'));
    expect(page.document.querySelector('[data-role="persona-empty"]')).toBeNull();
  });

  it('keeps an archived persona visible with an amber «выбери замену» while mapped', async () => {
    const source = personaCatalogSource({
      agencyHubBaseUrl: 'https://hub.example.test',
      agencyHubDeviceToken: 'device-x',
    });
    page = await mountOptionsPage({
      settings: HUB_SETTINGS,
      state: {
        personaCatalog: [{
          key: 'p-old',
          displayName: 'Old',
          definitionId: 'v1:persona-archived-definition',
          version: 2,
          status: 'archived',
        }],
        personaCatalogSource: source,
        personaCatalogFetchedAt: new Date().toISOString(),
        accountMappings: { 'acc-1': 'p-old' },
        knownAccounts: ['acc-1'],
      },
    });

    const row = personaRow('p-old')!;
    expect(row.className).toContain('chatgoose-persona-row-archived');
    expect(row.textContent).toContain(COPY.personas.archivedMapped);
    expect(row.querySelector('.chatgoose-badge-amber')?.textContent)
      .toBe(COPY.personas.archivedMapped);
  });

  it('hides an archived-and-unreferenced persona but never calls the catalog empty', async () => {
    const source = personaCatalogSource({
      agencyHubBaseUrl: 'https://hub.example.test',
      agencyHubDeviceToken: 'device-x',
    });
    page = await mountOptionsPage({
      settings: HUB_SETTINGS,
      state: {
        personaCatalog: [{
          key: 'p-old',
          displayName: 'Old',
          definitionId: 'v1:persona-archived-definition',
          version: 2,
          status: 'archived',
        }],
        personaCatalogSource: source,
        personaCatalogFetchedAt: new Date().toISOString(),
        accountMappings: {},
      },
    });

    expect(personaRow('p-old')).toBeNull();
    // The raw catalog is NOT empty — saying «каталог пуст» here would be false.
    expect(emptyText()).toBe(COPY.personas.emptyAllArchived);
  });

  it('offers the only refresh path there is, and names its side effect honestly', async () => {
    page = await mountOptionsPage({ settings: HUB_SETTINGS, state: { personaCatalog: [] } });

    const refresh = page.document.querySelector<HTMLButtonElement>(
      '[data-role="persona-catalog-refresh"]',
    );
    expect(refresh?.textContent).toBe(COPY.personas.catalogRefresh);
    // There is no standalone catalog-refetch operation: the catalog is re-read
    // after a SUCCESSFUL connection test, and the hint says so.
    expect(page.document.body.textContent).toContain(COPY.personas.catalogRefreshHint);

    const before = page.sentRequestTypes().filter((type) => type === 'testAgencyHubConnection').length;
    refresh!.click();
    await page.flushAsync();
    expect(
      page.sentRequestTypes().filter((type) => type === 'testAgencyHubConnection').length,
    ).toBeGreaterThan(before);
  });

  it('folds the legacy archive away behind a details summary', async () => {
    page = await mountOptionsPage({ state: { personaCatalog: [] } });

    const fold = page.document.querySelector<HTMLDetailsElement>(
      '[data-role="persona-legacy-fold"]',
    );
    expect(fold?.open).toBe(false);
    expect(fold?.querySelector('summary')?.textContent).toBe(COPY.personas.legacyFold);
    expect(fold?.textContent).toContain(COPY.personas.legacyNote);
  });
});
