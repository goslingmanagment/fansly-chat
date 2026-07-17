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
 * The "loaded for THESE creds" signal is SOURCE MATCH (the stored
 * personaCatalogSource equals the source derived from the current credentials),
 * NOT fetchedAt presence: the background controller SKIPS the write when a
 * refreshed catalog is byte-identical to what is stored, so a server-confirmed
 * EMPTY catalog can legitimately carry fetchedAt === null (e.g. right after a
 * rotation where the cleared cache was also empty). Keying on fetchedAt would then
 * wrongly claim «ещё не загружен» forever. So: source mismatch = not yet synced
 * for these creds (rotation/first load, NOT «persona deleted»); source match =
 * the server's real answer for these creds. */
export function classifyPersonaEmptyState(
  args: { currentSource: string | null; storedSource: string | null },
): PersonaEmptyState {
  if (args.currentSource === null) return 'no-credentials';
  if (args.storedSource !== args.currentSource) return 'awaiting-refresh';
  return 'empty-catalog';
}

/** Footer relative time. Deliberately "изменялся": personaCatalogFetchedAt is
 * last-CHANGED (a byte-identical refresh does not advance it), never last-checked.
 * A null timestamp is NOT "never loaded" (classifyPersonaEmptyState decides that
 * from source match now) — it just means there is no change date to show, so
 * render a dash. */
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
