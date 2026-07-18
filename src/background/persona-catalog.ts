import {
  PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY,
  PERSONA_CATALOG_SOURCE_STORAGE_KEY,
  PERSONA_CATALOG_STORAGE_KEY,
} from '../shared/constants.js';
import {
  normalizePersonaCatalog,
  personaCatalogSource,
} from '../shared/persona-catalog.js';
import { ensureLegacyPersonaSnapshot } from '../shared/persona-preservation.js';
import type { PersonaCatalogEntry, Settings } from '../shared/types.js';

const PERSONA_CATALOG_TIMEOUT_MS = 15_000;
export const PERSONA_CATALOG_REFRESH_INTERVAL_MS = 5 * 60_000;

export interface PersonaCatalogStorage {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface PersonaCatalogHub {
  isConfigured(settings: Settings): boolean;
  fetchAiPersonaCatalog(
    settings: Settings,
    signal: AbortSignal,
  ): Promise<PersonaCatalogEntry[]>;
}

export interface PersonaCatalogController {
  refresh(): Promise<void>;
}

export function startPersonaCatalogRefreshLoop(options: {
  refresh: () => Promise<void>;
  onWarn?: (message: string) => void;
  intervalMs?: number;
}): () => void {
  const onWarn = options.onWarn ?? (() => {});
  const timer = globalThis.setInterval(() => {
    void options.refresh().catch((error) => {
      onWarn(`[persona-catalog] periodic refresh failed: ${describeError(error)}`);
    });
  }, options.intervalMs ?? PERSONA_CATALOG_REFRESH_INTERVAL_MS);
  return () => globalThis.clearInterval(timer);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error);
}

/**
 * Metadata-only, read-only persona catalog refresh.
 *
 * Requests serialize and stale responses cannot overwrite a newer Hub source.
 * The legacy full-text array is never read for runtime use and never written.
 */
export function createPersonaCatalogController(options: {
  hub: PersonaCatalogHub;
  storage: PersonaCatalogStorage;
  /** Must perform a fresh schema-checked read on every invocation. */
  readSettings: () => Promise<Settings>;
  onWarn?: (message: string) => void;
  timeoutMs?: number;
  now?: () => Date;
}): PersonaCatalogController {
  const onWarn = options.onWarn ?? (() => {});
  const timeoutMs = options.timeoutMs ?? PERSONA_CATALOG_TIMEOUT_MS;
  let queue: Promise<void> = Promise.resolve();
  let latestGeneration = 0;

  async function commitIfCurrent(
    generation: number,
    source: string | null,
    items: Record<string, unknown>,
  ): Promise<boolean> {
    if (generation !== latestGeneration) return false;
    // This is both a source TOCTOU fence and a future-schema barrier. A newer
    // schema makes readSettings reject, so no catalog write follows an
    // observed unsupported layout. A switch after this await is the narrow
    // already-in-flight browser.storage window documented by E37.
    const currentSource = personaCatalogSource(await options.readSettings());
    if (generation !== latestGeneration || currentSource !== source) return false;
    await options.storage.set(items);
    return true;
  }

  async function clearForSource(
    source: string | null,
    generation: number,
  ): Promise<boolean> {
    return commitIfCurrent(generation, source, {
      [PERSONA_CATALOG_STORAGE_KEY]: [],
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: source,
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: null,
    });
  }

  async function refreshOne(generation: number): Promise<void> {
    // This barrier is intentionally before even the first GET. If it rejects,
    // no catalog request and no metadata mutation is allowed to proceed.
    await ensureLegacyPersonaSnapshot(options.storage);

    const settings = await options.readSettings();
    if (generation !== latestGeneration) return;
    const source = personaCatalogSource(settings);
    const stored = await options.storage.get(null);
    const storedSource = typeof stored[PERSONA_CATALOG_SOURCE_STORAGE_KEY] === 'string'
      ? stored[PERSONA_CATALOG_SOURCE_STORAGE_KEY]
      : null;
    if (storedSource !== source && generation === latestGeneration) {
      if (!await clearForSource(source, generation)) return;
    }

    if (!source || !options.hub.isConfigured(settings)) {
      if (generation === latestGeneration && storedSource === source) {
        const catalog = normalizePersonaCatalog(stored[PERSONA_CATALOG_STORAGE_KEY]);
        if (catalog.length > 0 || stored[PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY] != null) {
          await clearForSource(null, generation);
        }
      }
      return;
    }

    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    let catalog: PersonaCatalogEntry[];
    try {
      catalog = normalizePersonaCatalog(
        await options.hub.fetchAiPersonaCatalog(settings, controller.signal),
      );
    } catch (error) {
      onWarn(`[persona-catalog] refresh failed: ${describeError(error)}`);
      return;
    } finally {
      globalThis.clearTimeout(timeout);
    }

    if (generation !== latestGeneration) return;
    const storedCatalog = normalizePersonaCatalog(stored[PERSONA_CATALOG_STORAGE_KEY]);
    if (
      storedSource === source &&
      JSON.stringify(storedCatalog) === JSON.stringify(catalog)
    ) {
      return;
    }
    await commitIfCurrent(generation, source, {
      [PERSONA_CATALOG_STORAGE_KEY]: catalog,
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: source,
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: (options.now?.() ?? new Date()).toISOString(),
    });
  }

  return {
    refresh() {
      const generation = ++latestGeneration;
      const task = queue.then(
        () => refreshOne(generation),
        () => refreshOne(generation),
      );
      queue = task.catch(() => undefined);
      return task;
    },
  };
}
