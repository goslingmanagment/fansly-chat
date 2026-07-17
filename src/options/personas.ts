import { BUNDLED_LORA_PERSONALITY_ID } from '../shared/personalities.js';
import type { PersonaCatalogEntry } from '../shared/types.js';

export interface PersonaRowView {
  key: string;
  displayName: string;
  version: number;
  builtin: boolean;
  archived: boolean;
  accountCount: number;
}

export type PersonaEmptyState = 'no-credentials' | 'awaiting-refresh' | 'empty-catalog';

/** Count local account→persona mappings per persona key. */
export function countMappingsByPersona(
  accountMappings: Record<string, string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of Object.values(accountMappings)) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Rows to render, in catalog order: every active persona, plus an ARCHIVED one
 * only while a mapping still references it (so the chatter can pick a
 * replacement). Archived-and-unreferenced personas are hidden — the catalog
 * schema carries no update time, so none is invented. */
export function buildPersonaRowViews(
  catalog: readonly PersonaCatalogEntry[],
  accountMappings: Record<string, string>,
): PersonaRowView[] {
  const counts = countMappingsByPersona(accountMappings);
  const views: PersonaRowView[] = [];
  for (const persona of catalog) {
    const accountCount = counts.get(persona.key) ?? 0;
    const archived = persona.status === 'archived';
    if (archived && accountCount === 0) continue;
    views.push({
      key: persona.key,
      displayName: persona.displayName,
      version: persona.version,
      builtin: persona.key === BUNDLED_LORA_PERSONALITY_ID,
      archived,
      accountCount,
    });
  }
  return views;
}

/** Distinguish an empty section's cause. The catalog cache is bound to the exact
 * source (baseUrl|sha256(bearer)) — an authority boundary, not an offline cache.
 * "Loaded for THESE creds" needs BOTH signals: the stored personaCatalogSource
 * must equal the source derived from the current credentials AND a fetch must
 * have actually landed (fetchedAt !== null). clearForSource stamps the new source
 * with fetchedAt === null before any request, so right after a rotation the source
 * can already match while nothing has been fetched — and a FAILED refresh leaves
 * exactly that {source: match, fetchedAt: null} triple. Reporting «пустой каталог»
 * then would be dishonest (the server never answered), so the background
 * controller now stamps fetchedAt on every confirmed response (even a
 * byte-identical empty one). So: source mismatch OR fetchedAt === null = not yet
 * synced for these creds (rotation/first load/failed refresh, NOT «persona
 * deleted»); source match AND fetchedAt !== null = the server's real (empty)
 * answer for these creds. */
export function classifyPersonaEmptyState(
  args: {
    currentSource: string | null;
    storedSource: string | null;
    fetchedAt: string | null;
  },
): PersonaEmptyState {
  if (args.currentSource === null) return 'no-credentials';
  if (args.storedSource !== args.currentSource || args.fetchedAt === null) {
    return 'awaiting-refresh';
  }
  return 'empty-catalog';
}

/** Footer relative time. Deliberately "изменялся": personaCatalogFetchedAt is
 * last-CHANGED (a byte-identical refresh does not advance it), never last-checked.
 * A null timestamp shown here is only "no change date to display" — render a dash.
 * classifyPersonaEmptyState reads the same null as one of two not-loaded signals
 * (alongside source mismatch), but only there; the footer stays purely cosmetic. */
export function formatCatalogChangedAt(
  fetchedAt: string | null,
  now: number = Date.now(),
): string {
  if (!fetchedAt) return 'каталог изменялся: —';
  const changedAt = Date.parse(fetchedAt);
  if (!Number.isFinite(changedAt)) return 'каталог изменялся: —';
  const minutes = Math.max(0, Math.round((now - changedAt) / 60_000));
  if (minutes === 0) return 'каталог изменялся только что';
  if (minutes < 60) return `каталог изменялся ${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `каталог изменялся ${hours} ч назад`;
  return `каталог изменялся ${Math.round(hours / 24)} дн назад`;
}
