// The ranked top-spenders board. Stage 32 Task 4: rankings come from ONE
// kernel query over the Stage 16 fan-earnings projection
// (GET /api/v1/pages/:pageLabel/top-spenders) instead of the legacy rebuild
// that fetched lifetime earnings per fan (~150 Fansly calls per creator per
// 10 minutes). One bounded Fansly conversations enumeration REMAINS — it is
// the fan→groupId map the board needs to open chats (DP 1-B: the extension
// stays free to read Fansly for conversation context; it just never rebuilds
// rankings from quota-expensive sweeps).
//
// E23: the enumeration is a MAP, not a membership gate — every kernel
// spender is listed even without an enumerated conversation (groupId null;
// the board resolves the chat lazily on open). A second, best-effort kernel
// query over the current 'YYYY-MM' window feeds the month-to-date column;
// its failure degrades the column to unknown, never the board.
//
// The legacy rebuild (and its hidden `spendersLegacyRebuild` setting) died in
// 1.7.0 as planned (E6/E9): the kernel query is the ONLY ranking source.
// Kernel results carry an honest projection timestamp: builtAt =
// max(observed_at) across the page/window projection, not "now", not
// necessarily one of the returned top N, and not a coherent timestamp shared
// by every returned row.

import {
  FANSLY_CUSTOM_NAME_NOTE_TYPE,
  FANSLY_PAGINATION_DELAY_MS,
  SPENDERS_CACHE_TTL_MS,
  SPENDERS_KERNEL_LIMIT,
  SPENDERS_MAX_FANS,
  SPENDERS_NAME_LOOKUP_BATCH,
  SPENDERS_NAME_SWEEP_BUDGET_MS,
  SPENDERS_NAMES_CACHE_MAX,
  SPENDERS_NAMES_CACHE_TTL_MS,
} from '../shared/constants.js';
import {
  normalizeAgencyHubBaseUrl,
  normalizeAgencyHubUsername,
} from '../shared/agency-hub.js';
import { ChatGooseError } from '../shared/errors.js';
import { monthWindowFor } from '../shared/spenders.js';
import type {
  FanslyAccountResponse,
  SessionTemplate,
  Settings,
  SpenderListEntry,
  SpendersListResult,
  SpendersProgressPayload,
  SpendersStreamState,
} from '../shared/types.js';
import type { AgencyHubClient } from './agency-hub-client.js';
import type { FanslyClient } from './fansly-client.js';

/** The creator's custom display name for a fan — Fansly's native rename,
 * stored as an account note whose text is the name. */
function customNameFromAccount(account: FanslyAccountResponse): string | null {
  if (!Array.isArray(account.notes)) return null;
  const note = account.notes.find(
    (entry) => entry?.contentType === FANSLY_CUSTOM_NAME_NOTE_TYPE,
  );
  const text = note?.note?.trim();
  return text ? text : null;
}

/** What a board row needs to know about a fan's names. */
interface FanNames {
  customName: string | null;
  displayName: string | null;
  username: string | null;
}

interface KernelSpendersSourceStatus {
  streamState: SpendersStreamState;
  lastSyncedAt: string | null;
  consecutiveFailures: number | null;
}

interface KernelSpendersSnapshot {
  builtAt: string | null;
  fanCount: number;
  source: KernelSpendersSourceStatus;
  entries: Array<{
    platformUserId: string;
    username: string | null;
    displayName: string | null;
    grossMills: number;
  }>;
}

function parseKernelTimestamp(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parentAbortError(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException && signal.reason.name === 'AbortError'
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

function throwIfParentAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw parentAbortError(signal);
  }
}

interface NamesCacheEntry {
  savedAt: number;
  byId: Record<string, FanNames>;
}

function namesFromAccount(account: FanslyAccountResponse): FanNames {
  return {
    customName: customNameFromAccount(account),
    displayName: account.displayName ?? null,
    username: account.username ?? null,
  };
}

/** Abort-aware sleep for pacing the name sweep between batches. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort);
  });
}

interface CacheEntry {
  cachedAt: number;
  result: SpendersListResult;
}

/** Conversation enumeration only accelerates direct chat-open; never let it
 * consume the 30-second generic Fansly request timeout before the board can
 * fall back to lazy inbox search. */
const SPENDERS_CHAT_MAP_BUDGET_MS = 12_000;
const SPENDERS_MONTH_BUDGET_MS = 12_000;

// MV3 event-page workers die between board opens; storage.session keeps the
// 10-minute cache useful across restarts (dies with the browser session,
// never syncs). Module memory is the fallback for unit tests/exotic builds —
// mirrors quota-tracker's custody pattern.
// V2 adds source health and scopes each entry to its Hub origin. Old session
// entries deliberately miss rather than being trusted as the new shape.
const SESSION_CACHE_STORAGE_KEY = 'spendersCacheV2';

// storage.session updates replace the whole aggregate object. Serialize every
// mutation so two overlapping creator builds cannot both read the same
// snapshot and let the later writer erase the earlier creator's entry.
let sessionCacheMutationQueue: Promise<void> = Promise.resolve();

function sessionStorageArea(): browser.storage.StorageArea | null {
  try {
    return browser.storage?.session ?? null;
  } catch {
    return null;
  }
}

async function readSessionCache(key: string): Promise<CacheEntry | null> {
  // An invalidate triggered by a settings/token change must land before a new
  // board is allowed to trust the persisted snapshot.
  await sessionCacheMutationQueue;
  const area = sessionStorageArea();
  if (!area) return null;
  try {
    const raw = await area.get(SESSION_CACHE_STORAGE_KEY);
    const all = raw[SESSION_CACHE_STORAGE_KEY];
    if (!all || typeof all !== 'object') return null;
    const entry = (all as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object') return null;
    const candidate = entry as CacheEntry;
    if (
      typeof candidate.cachedAt !== 'number' ||
      !candidate.result ||
      !Array.isArray(candidate.result.entries) ||
      !candidate.result.source ||
      typeof candidate.result.source !== 'object' ||
      typeof candidate.result.source.streamState !== 'string'
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

async function mutateSessionCache(
  mutate: (all: Record<string, CacheEntry>) => void,
): Promise<void> {
  const run = sessionCacheMutationQueue.then(async () => {
    const area = sessionStorageArea();
    if (!area) return;
    const raw = await area.get(SESSION_CACHE_STORAGE_KEY);
    const all =
      raw[SESSION_CACHE_STORAGE_KEY] && typeof raw[SESSION_CACHE_STORAGE_KEY] === 'object'
        ? { ...(raw[SESSION_CACHE_STORAGE_KEY] as Record<string, CacheEntry>) }
        : {};
    mutate(all);
    await area.set({ [SESSION_CACHE_STORAGE_KEY]: all });
  });

  // Persistence is best-effort, but keep the queue usable after a storage
  // failure and let each caller await its own ordered attempt.
  sessionCacheMutationQueue = run.catch(() => undefined);
  await sessionCacheMutationQueue;
}

async function writeSessionCache(key: string, entry: CacheEntry | null): Promise<void> {
  await mutateSessionCache((all) => {
    if (entry === null) delete all[key];
    else all[key] = entry;
  });
}

async function deleteSessionCachesWithPrefix(prefix: string): Promise<void> {
  await mutateSessionCache((all) => {
    for (const key of Object.keys(all)) {
      if (key.startsWith(prefix)) delete all[key];
    }
  });
}

async function clearSessionCache(): Promise<void> {
  await mutateSessionCache((all) => {
    for (const key of Object.keys(all)) delete all[key];
  });
}

// Fan names get their OWN cache, in storage.LOCAL (not session): renames are
// rare, and a browser restart must not re-buy 10 batched /account?ids=
// requests per creator. TTL 6h, size-capped. Later builds — including a
// Refresh — fetch only ids the cache does not know.
const NAMES_CACHE_STORAGE_KEY = 'spendersNames';

// storage.local updates replace the whole `spendersNames` object. Serialize
// read/merge/write across creators and service instances so overlapping board
// builds cannot lose entries or start a redundant sweep behind a queued write.
let namesCacheWriteQueue: Promise<void> = Promise.resolve();

function localStorageArea(): browser.storage.StorageArea | null {
  try {
    return browser.storage?.local ?? null;
  } catch {
    return null;
  }
}

async function readNamesCache(key: string): Promise<NamesCacheEntry | null> {
  await namesCacheWriteQueue;
  const area = localStorageArea();
  if (!area) return null;
  try {
    const raw = await area.get(NAMES_CACHE_STORAGE_KEY);
    const all = raw[NAMES_CACHE_STORAGE_KEY];
    if (!all || typeof all !== 'object') return null;
    const entry = (all as Record<string, unknown>)[key];
    if (!entry || typeof entry !== 'object') return null;
    const candidate = entry as NamesCacheEntry;
    if (
      typeof candidate.savedAt !== 'number' ||
      candidate.byId === null ||
      typeof candidate.byId !== 'object' ||
      Array.isArray(candidate.byId)
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

async function updateNamesCache(
  key: string,
  priorityIds: readonly string[],
  patch: ReadonlyMap<string, FanNames>,
): Promise<void> {
  const run = namesCacheWriteQueue.then(async () => {
    const area = localStorageArea();
    if (!area) return;

    const raw = await area.get(NAMES_CACHE_STORAGE_KEY);
    const all =
      raw[NAMES_CACHE_STORAGE_KEY] && typeof raw[NAMES_CACHE_STORAGE_KEY] === 'object'
        ? { ...(raw[NAMES_CACHE_STORAGE_KEY] as Record<string, NamesCacheEntry>) }
        : {};
    const existing = all[key];
    const now = Date.now();
    const existingFresh =
      existing !== undefined &&
      typeof existing.savedAt === 'number' &&
      existing.byId !== null &&
      typeof existing.byId === 'object' &&
      !Array.isArray(existing.byId) &&
      now - existing.savedAt < SPENDERS_NAMES_CACHE_TTL_MS;
    const merged: Record<string, FanNames> = existingFresh
      ? { ...existing.byId }
      : {};
    for (const [id, names] of patch) {
      merged[id] = names;
    }

    // Current board ids win eviction; fill the rest from the latest merged
    // cache until the exact per-creator cap is reached.
    const capped: Record<string, FanNames> = {};
    let count = 0;
    for (const id of priorityIds) {
      const names = merged[id];
      if (names === undefined || Object.hasOwn(capped, id)) continue;
      capped[id] = names;
      count += 1;
      if (count >= SPENDERS_NAMES_CACHE_MAX) break;
    }
    if (count < SPENDERS_NAMES_CACHE_MAX) {
      for (const [id, names] of Object.entries(merged)) {
        if (Object.hasOwn(capped, id)) continue;
        capped[id] = names;
        count += 1;
        if (count >= SPENDERS_NAMES_CACHE_MAX) break;
      }
    }

    all[key] = {
      savedAt: existingFresh ? existing.savedAt : now,
      byId: capped,
    };
    await area.set({ [NAMES_CACHE_STORAGE_KEY]: all });
  });

  // Keep the queue usable after storage failures. Persistence is best-effort,
  // but each caller awaits its queued attempt before the worker may go idle.
  namesCacheWriteQueue = run.catch(() => undefined);
  await namesCacheWriteQueue;
}

export interface SpendersKernelSource {
  resolvePageLabelForUsername: AgencyHubClient['resolvePageLabelForUsername'];
  fetchTopSpenders(
    settings: Settings,
    pageLabel: string,
    window: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<KernelSpendersSnapshot>;
}

function isCacheableResult(result: SpendersListResult): boolean {
  return result.source.streamState === 'ramped' &&
    (result.builtAt !== null || result.source.lastSyncedAt !== null);
}

export class SpendersService {
  private readonly cache = new Map<string, CacheEntry>();
  private cacheGeneration = 0;
  private buildSequence = 0;
  private readonly latestBuildByKey = new Map<string, number>();

  constructor(
    private readonly fanslyClient: FanslyClient,
    private readonly kernelSource?: SpendersKernelSource,
    private readonly getSettings?: () => Promise<Settings>,
    /** Test seam — production uses the constants. */
    private readonly tuning?: {
      nameSweepBudgetMs?: number;
      chatMapBudgetMs?: number;
      monthBudgetMs?: number;
    },
  ) {}

  private creatorKey(session: SessionTemplate): string {
    return session.resolvedAccountId ?? session.accountId;
  }

  private boardCachePrefix(session: SessionTemplate): string {
    return `${encodeURIComponent(this.creatorKey(session))}|`;
  }

  private boardCacheKey(session: SessionTemplate, settings: Settings): string {
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const username = normalizeAgencyHubUsername(session.resolvedUsername) ?? '';
    return `${this.boardCachePrefix(session)}${encodeURIComponent(baseUrl)}|${encodeURIComponent(username)}`;
  }

  async getList(
    session: SessionTemplate,
    signal: AbortSignal,
    options?: {
      refresh?: boolean;
      onProgress?: (progress: SpendersProgressPayload) => void;
    },
  ): Promise<SpendersListResult> {
    const settings = await this.getSettings?.();
    if (this.kernelSource === undefined || settings === undefined) {
      // The legacy per-fan rebuild died in 1.7.0 — a board without the kernel
      // wired is a composition bug, not a fallback case.
      throw new ChatGooseError('hub_request_failed');
    }

    const key = this.boardCacheKey(session, settings);
    const now = Date.now();
    const generation = this.cacheGeneration;

    if (!options?.refresh) {
      const cached = this.cache.get(key);
      if (
        cached &&
        now - cached.cachedAt < SPENDERS_CACHE_TTL_MS &&
        isCacheableResult(cached.result)
      ) {
        return cached.result;
      }
      // Worker restarted since the last build? The session-storage copy is
      // still fresh for up to the same TTL.
      const persisted = await readSessionCache(key);
      if (
        persisted &&
        generation === this.cacheGeneration &&
        now - persisted.cachedAt < SPENDERS_CACHE_TTL_MS &&
        isCacheableResult(persisted.result)
      ) {
        this.cache.set(key, persisted);
        return persisted.result;
      }
    }

    const buildSequence = ++this.buildSequence;
    this.latestBuildByKey.set(key, buildSequence);
    const result = await this.buildFromKernel(session, settings, signal, options?.onProgress);

    // A token/settings invalidation may race an already-running build. Return
    // that caller's completed response, but never repopulate the cleared cache
    // with a snapshot fetched under the old source identity.
    if (
      generation !== this.cacheGeneration ||
      this.latestBuildByKey.get(key) !== buildSequence
    ) return result;

    // Disabled or still-pending sources stay live questions; a ramped source
    // with a successful empty sync is authoritative and may be cached.
    if (isCacheableResult(result)) {
      const entry: CacheEntry = { cachedAt: Date.now(), result };
      this.cache.set(key, entry);
      await writeSessionCache(key, entry);
    } else {
      this.cache.delete(key);
      await writeSessionCache(key, null);
    }
    return result;
  }

  private async listFanAccountsBestEffort(
    session: SessionTemplate,
    parentSignal: AbortSignal,
    requestSignal: AbortSignal = parentSignal,
  ): Promise<{ fans: Array<{ groupId: string; fanAccountId: string }>; truncated: boolean }> {
    const deadlineController = new AbortController();
    const deadline = globalThis.setTimeout(
      () => deadlineController.abort(),
      this.tuning?.chatMapBudgetMs ?? SPENDERS_CHAT_MAP_BUDGET_MS,
    );
    const mapSignal = AbortSignal.any([requestSignal, deadlineController.signal]);
    try {
      return await this.fanslyClient.listFanAccounts(
        SPENDERS_MAX_FANS,
        session,
        mapSignal,
      );
    } catch (error) {
      throwIfParentAborted(parentSignal);
      if (error instanceof ChatGooseError && error.key === 'session_expired') {
        throw error;
      }
      return { fans: [], truncated: false };
    } finally {
      globalThis.clearTimeout(deadline);
    }
  }

  /** The month column is optional. Give it its own deadline so a wedged second
   * Hub request cannot hold an already-ready lifetime board until the global
   * 120-second runtime timeout. */
  private async fetchMonthBestEffort(
    settings: Settings,
    pageLabel: string,
    monthWindow: string,
    parentSignal: AbortSignal,
  ): Promise<KernelSpendersSnapshot | null> {
    const deadlineController = new AbortController();
    const deadline = globalThis.setTimeout(
      () => deadlineController.abort(),
      this.tuning?.monthBudgetMs ?? SPENDERS_MONTH_BUDGET_MS,
    );
    const monthSignal = AbortSignal.any([parentSignal, deadlineController.signal]);
    try {
      return await this.kernelSource!.fetchTopSpenders(
        settings,
        pageLabel,
        monthWindow,
        SPENDERS_KERNEL_LIMIT,
        monthSignal,
      );
    } catch {
      throwIfParentAborted(parentSignal);
      return null;
    } finally {
      globalThis.clearTimeout(deadline);
    }
  }

  private async buildFromKernel(
    session: SessionTemplate,
    settings: Settings,
    signal: AbortSignal,
    onProgress?: (progress: SpendersProgressPayload) => void,
  ): Promise<SpendersListResult> {
    onProgress?.({ type: 'spenders:progress', phase: 'ranking' });
    const pageUsername = session.resolvedUsername?.trim() || null;
    const pageLabel = await this.kernelSource!.resolvePageLabelForUsername(
      settings,
      pageUsername,
      signal,
    );
    if (!pageLabel) {
      throw new ChatGooseError('hub_page_match_failed');
    }

    const monthWindow = monthWindowFor(Date.now());
    const chatMapController = new AbortController();
    const chatMapSignal = AbortSignal.any([signal, chatMapController.signal]);
    // Convert the speculative map to an explicitly-settled outcome at once:
    // a fast fatal rejection must never sit unhandled while the Hub requests
    // are still in flight.
    const chatMapOutcome = this.listFanAccountsBestEffort(
      session,
      signal,
      chatMapSignal,
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const [lifetime, month] = await Promise.all([
      this.kernelSource!.fetchTopSpenders(
        settings,
        pageLabel,
        'lifetime',
        SPENDERS_KERNEL_LIMIT,
        signal,
      ),
      this.fetchMonthBestEffort(settings, pageLabel, monthWindow, signal),
    ]).catch((error: unknown) => {
      chatMapController.abort();
      throw error;
    });

    if (lifetime.entries.length === 0) {
      // Disabled, pending, and authoritatively-empty sources have no chat to
      // open and no names to decorate. Cancel the speculative Fansly request
      // instead of making the board wait for its 12-second deadline.
      chatMapController.abort();
    }

    const mapOutcome = await chatMapOutcome;
    if (!mapOutcome.ok) throw mapOutcome.error;
    const { fans } = mapOutcome.value;

    const groupByFanId = new Map(fans.map((fan) => [fan.fanAccountId, fan.groupId]));
    // Source health distinguishes a successful empty month from an unramped
    // stream. Even when usable, entries may be a bounded top-500 subset: only
    // a complete response makes an absent lifetime fan a known $0.
    const monthLastSyncedAt = month === null
      ? null
      : parseKernelTimestamp(month.source.lastSyncedAt);
    const monthReady = month !== null &&
      month.source.streamState === 'ramped' &&
      (
        month.builtAt !== null ||
        (monthLastSyncedAt !== null && monthWindowFor(monthLastSyncedAt) === monthWindow)
      );
    const monthComplete = monthReady && month.fanCount === month.entries.length;
    const monthByFanId = new Map(
      monthReady ? month.entries.map((entry) => [entry.platformUserId, entry.grossMills]) : [],
    );

    // Best-effort: the names chatters actually recognize (custom rename
    // notes + platform-name backfill). Cached long and hard-budgeted —
    // names are decoration, the board must never hang on them (the 1.9.1
    // freeze was this sweep retrying through rate limits).
    const namesByFanId = lifetime.entries.length === 0
      ? new Map<string, FanNames>()
      : await this.resolveFanNames(
          lifetime.entries.map((entry) => entry.platformUserId),
          session,
          signal,
          onProgress,
        );

    const entries: SpenderListEntry[] = lifetime.entries.map((entry) => {
      const knownMonthMills = monthReady ? monthByFanId.get(entry.platformUserId) : undefined;
      const monthMills = knownMonthMills ?? (monthComplete ? 0 : null);
      const names = namesByFanId.get(entry.platformUserId);
      return {
        fanAccountId: entry.platformUserId,
        groupId: groupByFanId.get(entry.platformUserId) ?? null,
        customName: names?.customName ?? null,
        displayName: entry.displayName ?? names?.displayName ?? null,
        username: entry.username ?? names?.username ?? null,
        lifetimeMills: entry.grossMills,
        lifetimeUsd: entry.grossMills / 1000,
        monthMills,
        monthUsd: monthMills !== null ? monthMills / 1000 : null,
      };
    });

    return {
      entries,
      // Honest staleness: the projection's newest observation, not "now",
      // not necessarily one of the returned top N, and not a coherent
      // timestamp shared by every returned row.
      // Source state, not builtAt alone, distinguishes disabled/pending/empty.
      builtAt: parseKernelTimestamp(lifetime.builtAt),
      source: {
        streamState: lifetime.source.streamState,
        lastSyncedAt: parseKernelTimestamp(lifetime.source.lastSyncedAt),
        consecutiveFailures: lifetime.source.consecutiveFailures,
      },
      fanCount: lifetime.fanCount,
      monthWindow: monthReady ? monthWindow : null,
      fetchedAt: Date.now(),
    };
  }

  /** Names for the listed fans: session-cached first (6h TTL — renames are
   * rare), then ONE paced sweep for unknown ids only: no retry budget, an
   * inter-batch pause, and a hard wall-clock budget. Best-effort throughout:
   * whatever the sweep did not reach stays on platform names. */
  private async resolveFanNames(
    fanAccountIds: string[],
    session: SessionTemplate,
    signal: AbortSignal,
    onProgress?: (progress: SpendersProgressPayload) => void,
  ): Promise<Map<string, FanNames>> {
    const cacheKey = this.creatorKey(session);
    const requestedIds = [...new Set(fanAccountIds)];
    const requestedIdSet = new Set(requestedIds);
    const namesById = new Map<string, FanNames>();

    const cached = await readNamesCache(cacheKey);
    throwIfParentAborted(signal);
    const cacheFresh =
      cached !== null && Date.now() - cached.savedAt < SPENDERS_NAMES_CACHE_TTL_MS;
    if (cached && cacheFresh) {
      for (const id of requestedIds) {
        const names = cached.byId[id];
        if (names !== undefined) namesById.set(id, names);
      }
    }

    const cachedSize = cached === null ? 0 : Object.keys(cached.byId).length;
    const missing = requestedIds.filter((id) => !namesById.has(id));
    if (missing.length === 0) {
      if (cachedSize > SPENDERS_NAMES_CACHE_MAX) {
        await updateNamesCache(cacheKey, requestedIds, namesById);
      }
      return namesById;
    }

    // The sweep is the part a chatter actually waits on (a warm cache skips
    // it entirely) — so it is the part that reports counts.
    onProgress?.({
      type: 'spenders:progress',
      phase: 'names',
      done: 0,
      total: missing.length,
    });

    const sweepBudgetMs = this.tuning?.nameSweepBudgetMs ?? SPENDERS_NAME_SWEEP_BUDGET_MS;
    const sweepStart = Date.now();
    const deadlineController = new AbortController();
    const deadlineTimer = globalThis.setTimeout(
      () => deadlineController.abort(),
      Math.max(0, sweepBudgetMs),
    );
    const sweepSignal = AbortSignal.any([signal, deadlineController.signal]);
    let fetchedAny = false;
    try {
      for (let start = 0; start < missing.length; start += SPENDERS_NAME_LOOKUP_BATCH) {
        if (Date.now() - sweepStart >= sweepBudgetMs) {
          break; // Out of budget — ship the board with what we have.
        }
        const batch = missing.slice(start, start + SPENDERS_NAME_LOOKUP_BATCH);
        try {
          if (start > 0) {
            await pause(FANSLY_PAGINATION_DELAY_MS, sweepSignal);
          }
          const accounts = await this.fanslyClient.getAccountNames(
            batch,
            session,
            sweepSignal,
            'none',
          );
          for (const account of accounts) {
            if (account?.id && requestedIdSet.has(account.id)) {
              namesById.set(account.id, namesFromAccount(account));
              fetchedAny = true;
            }
          }
        } catch (error) {
          // Only the caller's cancellation aborts the whole board. The sweep's
          // deadline and FanslyClient's request-local timeout are decoration
          // failures and ship the names already in hand.
          throwIfParentAborted(signal);
          if (error instanceof ChatGooseError && error.key === 'session_expired') {
            throw error;
          }
          if (deadlineController.signal.aborted) break;
          // A 429 applies to the sweep, not just one batch. Continuing would
          // issue more requests into an explicit rate limit.
          if (error instanceof ChatGooseError && error.key === 'rate_limited') break;
        }
        // Honest count: batches that failed still advance the bar (their fans
        // are done being tried — they keep platform names).
        onProgress?.({
          type: 'spenders:progress',
          phase: 'names',
          done: Math.min(start + batch.length, missing.length),
          total: missing.length,
        });
      }
    } finally {
      globalThis.clearTimeout(deadlineTimer);
    }
    throwIfParentAborted(signal);

    if (fetchedAny || cachedSize > SPENDERS_NAMES_CACHE_MAX) {
      await updateNamesCache(cacheKey, requestedIds, namesById);
    }
    return namesById;
  }

  /** Drop the cached board for this creator (memory + session storage). */
  async invalidate(session: SessionTemplate): Promise<void> {
    this.cacheGeneration += 1;
    const prefix = this.boardCachePrefix(session);
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
    for (const key of this.latestBuildByKey.keys()) {
      if (key.startsWith(prefix)) this.latestBuildByKey.delete(key);
    }
    await deleteSessionCachesWithPrefix(prefix);
  }

  /** Source identity changed (Hub settings or credential): no persisted board
   * is safe to reuse, including a build that was already in flight. */
  async invalidateAll(): Promise<void> {
    this.cacheGeneration += 1;
    this.cache.clear();
    this.latestBuildByKey.clear();
    await clearSessionCache();
  }
}
