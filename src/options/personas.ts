// Pure presentation helpers for the «Персоны» pane. Ported from the 2.0 P3
// branch (3ef84d8:src/options/personas.ts) with ONE change: the catalog-date
// formatter no longer bakes Russian strings in. Copy belongs to
// `src/options/copy.ts` (the pane labels the value itself), so
// this module stays a copy-free, DOM-free set of functions.

import { BUNDLED_LORA_PERSONALITY_ID } from '../shared/personalities.js';
import type { PersonaCatalogEntry } from '../shared/types.js';

export interface PersonaRowView {
  key: string;
  displayName: string;
  version: number;
  builtin: boolean;
  archived: boolean;
  accountCount: number;
  /** The accounts sitting on this persona, in mapping order. The pane held this
   * map all along and threw the identities away (E62). */
  accountIds: string[];
}

export type PersonaEmptyState = 'no-credentials' | 'awaiting-refresh' | 'empty-catalog';

/** Group local account→persona mappings by persona key, keeping the account ids
 * (the count is `.length`). */
export function groupMappingsByPersona(
  accountMappings: Record<string, string>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const [accountId, key] of Object.entries(accountMappings)) {
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(accountId);
    } else {
      groups.set(key, [accountId]);
    }
  }
  return groups;
}

/** Count local account→persona mappings per persona key. */
export function countMappingsByPersona(
  accountMappings: Record<string, string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [key, ids] of groupMappingsByPersona(accountMappings)) {
    counts.set(key, ids.length);
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
  const groups = groupMappingsByPersona(accountMappings);
  const views: PersonaRowView[] = [];
  for (const persona of catalog) {
    const accountIds = groups.get(persona.key) ?? [];
    const archived = persona.status === 'archived';
    if (archived && accountIds.length === 0) continue;
    views.push({
      key: persona.key,
      displayName: persona.displayName,
      version: persona.version,
      builtin: persona.key === BUNDLED_LORA_PERSONALITY_ID,
      archived,
      accountCount: accountIds.length,
      accountIds,
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
 * controller stamps fetchedAt on every confirmed response (even a byte-identical
 * empty one). So: source mismatch OR fetchedAt === null = not yet synced for these
 * creds (rotation/first load/failed refresh, NOT «persona deleted»); source match
 * AND fetchedAt !== null = the server's real (empty) answer for these creds. */
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

/**
 * The catalog's last-CHANGED moment as a plain date string, or null when there
 * is none to show.
 *
 * `personaCatalogFetchedAt` is last-CHANGED, never last-checked: a byte-identical
 * refresh does not advance it. A null here means only "no change date to
 * display" — `classifyPersonaEmptyState` reads the same null as one of its two
 * not-loaded signals, but only there.
 *
 * Copy-free by design: the caller labels this value («Обновлён»)
 * (or falls back to `catalogNever`), so the wording lives in one dictionary.
 */
export function formatCatalogChangedDate(fetchedAt: string | null): string | null {
  if (!fetchedAt) return null;
  const changedAt = Date.parse(fetchedAt);
  if (!Number.isFinite(changedAt)) return null;
  const at = new Date(changedAt);
  const day = String(at.getDate()).padStart(2, '0');
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const hours = String(at.getHours()).padStart(2, '0');
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${at.getFullYear()} ${hours}:${minutes}`;
}
