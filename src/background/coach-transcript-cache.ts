import {
  compareMessageIds,
  estimateTargetPages,
  extractOldestMessageId,
} from '../shared/transcript.js';
import type { FanslyMessagePageResponse } from '../shared/types.js';

/**
 * Coach transcript session cache — spec §6 "background session cache with
 * overlap-and-replace".
 *
 * Why this representation (fresh-wins analysis)
 * ---------------------------------------------
 * The window is stored as an ORDERED, DE-OVERLAPPED list of raw
 * `FanslyMessagePageResponse` pages (oldest page first, newest/freshest page
 * last, with every message id appearing in at most one page). This is the only
 * representation that a single downstream `normalizeTranscript(window.pages)`
 * call renders with fresh-wins for BOTH concerns at once:
 *
 *   - message rows: `normalizeTranscript`'s per-id dedupe is FIRST-write-wins,
 *     so a naive `[...old, ...fresh]` concat would keep STALE rows. We instead
 *     region-replace — dropping every cached message whose id is covered by the
 *     fresh page(s) before appending the fresh rows — so each id appears once
 *     (the fresh version). Edits update; deletions inside the refreshed region
 *     disappear.
 *   - page maps (media / bundles / accountMediaOrders): `collectPageMaps` is
 *     LAST-write-wins (`map.set`), so the freshest page must be LAST in the
 *     array. Because purchase evidence for an old message can arrive in a NEWER
 *     page, per-page normalization would be wrong — the maps must be assembled
 *     across the whole merged window, which the ordered page list preserves.
 *
 * The cache never calls the network: the caller supplies loader callbacks. It
 * owns only the merge/keying/LRU. Downstream normalization + PPV verification
 * stay with the caller (operations, Task 7), which re-runs them on the merged
 * `window.pages` each turn (the Fansly client's own TTL caches keep that cheap).
 */

export const COACH_TRANSCRIPT_CACHE_MAX_SESSIONS = 5;

export interface CoachTranscriptCacheKeyParts {
  /** Owning browser tab. */
  tabId: number;
  /** Content-side coach session id (random per page-load). */
  coachSessionId: string;
  /** Creator (model) account id. */
  accountId: string;
  /** Fansly messaging group id. */
  groupId: string;
  /** The quick-window message count in force when the window was seeded. A
   * changed value is a different key (miss → reseed), matching spec §3. */
  quickMessageCount: number;
}

/** The merged window handed back to the caller. `pages` is ordered oldest-first
 * and de-overlapped — pass it straight to `normalizeTranscript`. */
export interface CoachTranscriptWindow {
  pages: FanslyMessagePageResponse[];
  /** Provider `reachedEnd` for the window's OLDEST edge (spec §5/§6). A
   * newest-tail refresh does not change it; a from-scratch rebuild does. */
  reachedEnd: boolean;
}

/** What the full-window loader (first turn / reseed) returns. `pages` is
 * newest-first, exactly as `FanslyClient.loadMessages` produces them. */
export interface CoachTranscriptLoadResult {
  pages: FanslyMessagePageResponse[];
  reachedEnd: boolean;
}

/** What the single-page loader (follow-up refresh) returns for one page.
 * `reachedEnd` means THIS page came back short/empty (provider end at this
 * page's oldest edge). */
export interface CoachTranscriptPageResult {
  page: FanslyMessagePageResponse;
  reachedEnd: boolean;
}

export type CoachTranscriptRefreshResult =
  | { status: 'refreshed'; window: CoachTranscriptWindow }
  /** Key not cached (never seeded, evicted, or SW restart) — caller must seed. */
  | { status: 'miss' }
  /** Continuity could not be re-established within the paging budget — the
   * caller MUST full-reload (getOrSeed), and this is decided BEFORE any kernel
   * call so context acquisition never burns a generation (spec §6.4). */
  | { status: 'reload-required' };

interface CacheEntry {
  parts: CoachTranscriptCacheKeyParts;
  window: CoachTranscriptWindow;
}

function serializeKey(parts: CoachTranscriptCacheKeyParts): string {
  return [
    parts.tabId,
    parts.coachSessionId,
    parts.accountId,
    parts.groupId,
    parts.quickMessageCount,
  ].join(':');
}

/** The newest (max) message id across a page list, or null when empty. */
function newestMessageId(pages: FanslyMessagePageResponse[]): string | null {
  let newest: string | null = null;
  for (const page of pages) {
    for (const message of page.messages ?? []) {
      if (newest === null || compareMessageIds(message.id, newest) > 0) {
        newest = message.id;
      }
    }
  }
  return newest;
}

/** Reverse a newest-first page list into the cache's oldest-first storage
 * order (so the freshest page ends up last for map last-write-wins). */
function toOldestFirst(
  newestFirstPages: FanslyMessagePageResponse[],
): FanslyMessagePageResponse[] {
  return [...newestFirstPages].reverse();
}

/**
 * Region-replace (used only for a NON-exhaustive overlapping fetch): keep cached
 * messages strictly OLDER than the fresh region's oldest id, then append the
 * fresh pages (oldest-first) after them. The partition is clean (cached
 * `< freshOldestId`, fresh `>= freshOldestId`), so no id appears twice and the
 * result stays globally oldest-first with the freshest page last. An exhaustive
 * (short) fetch never comes here — it proves nothing exists below its oldest
 * edge, so it snapshot-replaces instead (see `refresh`).
 */
function mergeOverlap(
  cachePagesOldestFirst: FanslyMessagePageResponse[],
  freshPagesNewestFirst: FanslyMessagePageResponse[],
  freshOldestId: string,
): FanslyMessagePageResponse[] {
  const retainedPages = cachePagesOldestFirst
    .map((page) => ({
      ...page,
      messages: (page.messages ?? []).filter(
        (message) => compareMessageIds(message.id, freshOldestId) < 0,
      ),
    }))
    .filter((page) => page.messages.length > 0);

  return [...retainedPages, ...toOldestFirst(freshPagesNewestFirst)];
}

/** Keep the raw cache itself bounded, not only the transcript sent to Core.
 * Pages stay oldest-first and messages keep their provider order, so the
 * existing fresh-wins page-map behavior is unchanged. Once an oldest row is
 * evicted the cached window no longer proves full-history coverage. */
function trimWindow(
  window: CoachTranscriptWindow,
  maxMessages: number,
): CoachTranscriptWindow {
  const limit = Math.max(0, Math.floor(maxMessages));
  const rankedMessages = window.pages
    .flatMap((page) => page.messages ?? [])
    .sort((left, right) => compareMessageIds(right.id, left.id));
  if (rankedMessages.length <= limit) {
    return window;
  }

  const retained = new Set(rankedMessages.slice(0, limit));
  const pages = window.pages
    .map((page) => ({
      ...page,
      messages: (page.messages ?? []).filter((message) => retained.has(message)),
    }))
    .filter((page) => page.messages.length > 0);
  return { pages, reachedEnd: false };
}

export class CoachTranscriptCache {
  /** Insertion-ordered map == LRU order (oldest key first, MRU last). */
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly maxSessions: number = COACH_TRANSCRIPT_CACHE_MAX_SESSIONS,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * First turn / reseed: return the cached window if present (no load), else
   * load the full quick window and cache it. `loadFullWindow` returns pages
   * newest-first (loadMessages order); they are stored oldest-first.
   */
  async getOrSeed(
    parts: CoachTranscriptCacheKeyParts,
    loadFullWindow: () => Promise<CoachTranscriptLoadResult>,
  ): Promise<CoachTranscriptWindow> {
    const key = serializeKey(parts);
    const existing = this.entries.get(key);
    if (existing) {
      this.touch(key, existing);
      return this.cloneWindow(existing.window);
    }

    const { pages, reachedEnd } = await loadFullWindow();
    const window: CoachTranscriptWindow = {
      pages: toOldestFirst(pages),
      reachedEnd,
    };
    const stored = this.store(key, parts, window);
    return this.cloneWindow(stored);
  }

  /**
   * Follow-up turn: fetch the newest page(s) and reconcile against the cached
   * window per spec §6. Returns `miss` (never seeded) or `reload-required`
   * (continuity lost) so the caller can decide BEFORE any kernel call.
   */
  async refresh(
    parts: CoachTranscriptCacheKeyParts,
    loadPage: (before: string | null) => Promise<CoachTranscriptPageResult>,
  ): Promise<CoachTranscriptRefreshResult> {
    const key = serializeKey(parts);
    const entry = this.entries.get(key);
    if (!entry) {
      return { status: 'miss' };
    }
    this.touch(key, entry);

    const cacheNewestId = newestMessageId(entry.window.pages);
    // Bound the paging so a large burst can't turn one refresh into an
    // unbounded Fansly walk — one window's worth of pages, plus a page of slack.
    const maxRefreshPages = estimateTargetPages(parts.quickMessageCount) + 1;

    const freshPages: FanslyMessagePageResponse[] = []; // newest-first
    let before: string | null = null;
    let pagesFetched = 0;

    for (;;) {
      const { page, reachedEnd } = await loadPage(before);
      freshPages.push(page);
      pagesFetched += 1;
      const freshOldestId = extractOldestMessageId(page.messages ?? []);

      if (reachedEnd) {
        // A short/empty page proves nothing exists below its oldest edge, so
        // the fresh pages ARE the whole conversation now — replace the snapshot
        // entirely, WHETHER OR NOT they overlap the cache. This is what discards
        // cached rows a mass-unsend removed below the fresh oldest edge; keeping
        // them (via a region-merge) would send phantom messages to the kernel.
        const window: CoachTranscriptWindow = {
          pages: toOldestFirst(freshPages),
          reachedEnd: true,
        };
        const stored = this.store(key, parts, window);
        return { status: 'refreshed', window: this.cloneWindow(stored) };
      }

      const overlaps =
        cacheNewestId !== null &&
        freshOldestId !== null &&
        compareMessageIds(freshOldestId, cacheNewestId) <= 0;

      if (overlaps) {
        const window: CoachTranscriptWindow = {
          pages: mergeOverlap(entry.window.pages, freshPages, freshOldestId),
          // A non-exhaustive tail refresh leaves the oldest edge untouched, so
          // its coverage stands. Even when the fresh region covers the WHOLE
          // cache it re-fetches back to at-or-before the old oldest id (a
          // conversation never gains OLDER messages), so a previously-confirmed
          // end still holds; and since this page was NOT short we cannot newly
          // confirm an end here.
          reachedEnd: entry.window.reachedEnd,
        };
        const stored = this.store(key, parts, window);
        return { status: 'refreshed', window: this.cloneWindow(stored) };
      }

      // Full page, still no overlap → page further back.
      before = freshOldestId;
      if (before === null || pagesFetched >= maxRefreshPages) {
        // Cannot page (no cursor) or exhausted the budget without reconnecting:
        // the cached window's continuity is known-broken, so EVICT it (keeping
        // it would make the caller's full reload a stale cache hit) and hand off
        // to a clean full reload — decided before any kernel call.
        this.entries.delete(key);
        return { status: 'reload-required' };
      }
    }
  }

  /** Drop every cached window whose key parts match the predicate (route /
   * account / persona change, «Новый диалог», etc.). Returns the count removed. */
  invalidate(
    predicate: (parts: CoachTranscriptCacheKeyParts) => boolean,
  ): number {
    let removed = 0;
    for (const [key, entry] of [...this.entries]) {
      if (predicate(entry.parts)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Read a window without loading or touching LRU (introspection/tests). */
  peek(parts: CoachTranscriptCacheKeyParts): CoachTranscriptWindow | undefined {
    const entry = this.entries.get(serializeKey(parts));
    return entry ? this.cloneWindow(entry.window) : undefined;
  }

  clear(): void {
    this.entries.clear();
  }

  private store(
    key: string,
    parts: CoachTranscriptCacheKeyParts,
    window: CoachTranscriptWindow,
  ): CoachTranscriptWindow {
    const boundedWindow = trimWindow(window, parts.quickMessageCount);
    this.entries.delete(key);
    this.entries.set(key, { parts, window: boundedWindow });
    while (this.entries.size > this.maxSessions) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.entries.delete(oldest);
    }
    return boundedWindow;
  }

  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  /** Shallow-copy the page array so callers cannot mutate our stored order. */
  private cloneWindow(window: CoachTranscriptWindow): CoachTranscriptWindow {
    return { pages: window.pages.slice(), reachedEnd: window.reachedEnd };
  }
}
