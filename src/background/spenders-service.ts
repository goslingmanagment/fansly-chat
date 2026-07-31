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
  SPENDERS_BUILD_TIMEOUT_REASON,
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
  SpendersSnapshotPayload,
  SpendersStreamState,
} from '../shared/types.js';
import { resolveHubBearer, type AgencyHubClient } from './agency-hub-client.js';
import type { FanslyClient } from './fansly-client.js';
import {
  recordSpendersObservation,
  spendersObservationScope,
} from './spenders-status-tracker.js';

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
    /** Optional here on purpose: the kernel declares it optional (it deploys
     * separately), so a snapshot from an older kernel simply lacks it. */
    deletedAt?: string | null;
  }>;
}

interface BuiltSpendersResult {
  result: SpendersListResult;
  /** False when the server returned fewer rows than the requested bound can
   * cover (notably the one-release old-Core 1000→500 compatibility path). */
  hasRequestedCoverage: boolean;
}

/** What a build has learned so far, for the observation `getList` records when
 * the build THROWS and there is no result to read. Most failures happen well
 * after the page label is resolved (a Hub 500 on the lifetime request, a build
 * timeout, `session_expired` during enrichment), and an anonymous «сборка не
 * удалась» is exactly the verdict this row exists to stop printing. Only a
 * failure at (or before) `resolvePageLabelForUsername` leaves both null. */
interface SpendersBuildScope {
  pageLabel: string | null;
  builtAt: number | null;
}

function newBuildScope(): SpendersBuildScope {
  return { pageLabel: null, builtAt: null };
}

/** Copy what another scope (or a finished result) learned, never overwriting a
 * known value with a null — a late joiner adopts the shared build's findings. */
function adoptScope(target: SpendersBuildScope, source: SpendersBuildScope): void {
  if (source.pageLabel !== null) target.pageLabel = source.pageLabel;
  if (source.builtAt !== null) target.builtAt = source.builtAt;
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

interface SpendersBuildSubscriber {
  onProgress?: (progress: SpendersProgressPayload) => void;
  onSnapshot?: (snapshot: SpendersSnapshotPayload) => void;
}

interface InFlightBuild {
  controller: AbortController;
  promise: Promise<SpendersListResult>;
  /** Filled by the running build; every waiter adopts it, so a tab that joined
   * a shared build names the same page when that build fails. */
  scope: SpendersBuildScope;
  subscribers: Set<SpendersBuildSubscriber>;
  latestProgress: SpendersProgressPayload | null;
  latestSnapshot: SpendersSnapshotPayload | null;
  waiterCount: number;
  settled: boolean;
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
// V3 expanded ranking coverage to 1000 and put the requested bound in each
// cache key. V4 adds `deletedAt` to every cached row: the whole result lives in
// storage.session, which outlives an extension update by up to its TTL, and the
// read path does not normalise inside `entries[]` — a V3 row would enter the
// board as a `SpenderListEntry` without the field, and a deleted fan would keep
// showing a bare numeric id and a "find chat" chip that can never resolve. Old
// entries deliberately miss after the upgrade.
const SESSION_CACHE_STORAGE_KEY = 'spendersCacheV4';

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
    // Belt and braces on top of the V4 key bump, which is what actually keeps
    // pre-`pageLabel` (and pre-`deletedAt`) entries out: storage.session is
    // still foreign-shaped data, and a `SpendersListResult` without `pageLabel`
    // would enter the app in a shape its own type forbids, silently costing the
    // options row its page name.
    return {
      ...candidate,
      result: { ...candidate.result, pageLabel: candidate.result.pageLabel ?? null },
    };
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
  private readonly inFlightByKey = new Map<string, InFlightBuild>();
  private readonly activeBuildControllers = new Map<AbortController, string>();
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
    return `${this.boardCachePrefix(session)}${encodeURIComponent(baseUrl)}|${encodeURIComponent(username)}|limit=${SPENDERS_KERNEL_LIMIT}`;
  }

  async getList(
    session: SessionTemplate,
    signal: AbortSignal,
    options?: {
      refresh?: boolean;
      onProgress?: (progress: SpendersProgressPayload) => void;
      onSnapshot?: (snapshot: SpendersSnapshotPayload) => void;
    },
  ): Promise<SpendersListResult> {
    // ONE settings snapshot feeds BOTH the observation record AND the build, so
    // a mid-build credential change cannot make the two disagree on the source.
    const settings = await this.getSettings?.();
    const sourceIdentity = settings
      ? `${this.creatorKey(session)}|${spendersObservationScope(
          normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl),
          resolveHubBearer(settings),
        )}`
      : this.creatorKey(session);
    // Filled in as the build learns; read only on the failure path, where there
    // is no result to read the page off.
    const scope = newBuildScope();
    try {
      const result = await this.getListInternal(session, signal, settings, scope, options);
      await recordSpendersObservation({
        sourceIdentity,
        streamState: result.source.streamState,
        outcome: 'ok',
        // Both ride the RESULT, so a cache hit and a shared in-flight build
        // record the same page and the same projection age a fresh build does.
        pageLabel: result.pageLabel,
        builtAt: result.builtAt,
      });
      return result;
    } catch (error) {
      const isAbort = error instanceof DOMException && error.name === 'AbortError';
      // A user cancellation (tab closed / superseded build) is not a board
      // outcome — skip it. But a build-TIMEOUT abort IS a real failure: recording
      // it as FAIL is what stops the Статус row from showing a stale RAMPED. The
      // runtime-api timeout handler aborts with an AbortError DOMException whose
      // MESSAGE carries the reason, so read it off `signal.reason` (a plain user
      // abort carries no such message). Reading the reason off the signal — not
      // the caught error — is robust: some inner abort points rethrow a bare
      // 'Aborted' DOMException that no longer carries the reason.
      const reason: unknown = signal.reason;
      const isTimeoutAbort = isAbort &&
        reason instanceof DOMException && reason.message === SPENDERS_BUILD_TIMEOUT_REASON;
      if (!isAbort || isTimeoutAbort) {
        // Whatever the build got as far as learning. A failure after the page
        // was resolved still knows its page, and «сборка не удалась» about no
        // page in particular names nothing — that anonymous verdict is what
        // this row exists to stop printing. Both stay null only when the
        // resolve itself is what failed.
        await recordSpendersObservation({
          sourceIdentity,
          streamState: null,
          outcome: 'fail',
          pageLabel: scope.pageLabel,
          builtAt: scope.builtAt,
        });
      }
      throw error;
    }
  }

  private async getListInternal(
    session: SessionTemplate,
    signal: AbortSignal,
    settings: Settings | undefined,
    scope: SpendersBuildScope,
    options?: {
      refresh?: boolean;
      onProgress?: (progress: SpendersProgressPayload) => void;
      onSnapshot?: (snapshot: SpendersSnapshotPayload) => void;
    },
  ): Promise<SpendersListResult> {
    throwIfParentAborted(signal);
    if (this.kernelSource === undefined || settings === undefined) {
      // The legacy per-fan rebuild died in 1.7.0 — a board without the kernel
      // wired is a composition bug, not a fallback case.
      throw new ChatGooseError('hub_request_failed');
    }
    throwIfParentAborted(signal);

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
        // Adopt BEFORE the abort check below: a build-timeout abort raised here
        // is recorded as a real failure, and the cached board already knows
        // which page it is about.
        adoptScope(scope, cached.result);
        throwIfParentAborted(signal);
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
        adoptScope(scope, persisted.result);
        throwIfParentAborted(signal);
        this.cache.set(key, persisted);
        return persisted.result;
      }
    }

    throwIfParentAborted(signal);

    if (options?.refresh) {
      // Refresh remains an independent rebuild and supersedes an older cold
      // build for cache purposes. Do not make later cold callers join stale
      // work that a user explicitly asked to replace.
      this.inFlightByKey.delete(key);
      const controller = new AbortController();
      this.activeBuildControllers.set(controller, key);
      try {
        return await this.runBuild(
          key,
          generation,
          session,
          settings,
          AbortSignal.any([signal, controller.signal]),
          scope,
          options,
        );
      } finally {
        this.activeBuildControllers.delete(controller);
      }
    }

    let inFlight = this.inFlightByKey.get(key);
    if (!inFlight) {
      inFlight = this.startSharedBuild(key, generation, session, settings);
      this.inFlightByKey.set(key, inFlight);
    }
    return await this.waitForSharedBuild(key, inFlight, signal, scope, options);
  }

  private async runBuild(
    key: string,
    generation: number,
    session: SessionTemplate,
    settings: Settings,
    signal: AbortSignal,
    scope: SpendersBuildScope,
    callbacks?: SpendersBuildSubscriber,
  ): Promise<SpendersListResult> {
    const buildSequence = ++this.buildSequence;
    this.latestBuildByKey.set(key, buildSequence);
    const built = await this.buildFromKernel(
      session,
      settings,
      signal,
      scope,
      callbacks?.onProgress,
      callbacks?.onSnapshot,
    );
    const { result } = built;

    // A token/settings invalidation may race an already-running build. Return
    // that caller's completed response, but never repopulate the cleared cache
    // with a snapshot fetched under the old source identity.
    if (
      generation !== this.cacheGeneration ||
      this.latestBuildByKey.get(key) !== buildSequence
    ) return result;

    // Disabled or still-pending sources stay live questions; a ramped source
    // with a successful empty sync is authoritative and may be cached.
    if (built.hasRequestedCoverage && isCacheableResult(result)) {
      const entry: CacheEntry = { cachedAt: Date.now(), result };
      this.cache.set(key, entry);
      await writeSessionCache(key, entry);
    } else {
      this.cache.delete(key);
      await writeSessionCache(key, null);
    }
    return result;
  }

  private startSharedBuild(
    key: string,
    generation: number,
    session: SessionTemplate,
    settings: Settings,
  ): InFlightBuild {
    const controller = new AbortController();
    this.activeBuildControllers.set(controller, key);
    const build: InFlightBuild = {
      controller,
      promise: Promise.resolve(null as unknown as SpendersListResult),
      scope: newBuildScope(),
      subscribers: new Set<SpendersBuildSubscriber>(),
      latestProgress: null,
      latestSnapshot: null,
      waiterCount: 0,
      settled: false,
    };

    const publishProgress = (progress: SpendersProgressPayload): void => {
      build.latestProgress = progress;
      for (const subscriber of build.subscribers) {
        try {
          subscriber.onProgress?.(progress);
        } catch {
          // A disconnected content port must not poison work shared by other tabs.
        }
      }
    };
    const publishSnapshot = (snapshot: SpendersSnapshotPayload): void => {
      build.latestSnapshot = snapshot;
      for (const subscriber of build.subscribers) {
        try {
          subscriber.onSnapshot?.(snapshot);
        } catch {
          // A disconnected content port must not poison work shared by other tabs.
        }
      }
    };

    // Defer the actual build by one microtask so the first caller is subscribed
    // before the synchronous ranking progress frame is published.
    build.promise = Promise.resolve().then(async () => await this.runBuild(
      key,
      generation,
      session,
      settings,
      controller.signal,
      build.scope,
      { onProgress: publishProgress, onSnapshot: publishSnapshot },
    )).finally(() => {
      build.settled = true;
      this.activeBuildControllers.delete(controller);
      if (this.inFlightByKey.get(key) === build) {
        this.inFlightByKey.delete(key);
      }
    });
    return build;
  }

  private waitForSharedBuild(
    key: string,
    build: InFlightBuild,
    signal: AbortSignal,
    scope: SpendersBuildScope,
    subscriber: SpendersBuildSubscriber = {},
  ): Promise<SpendersListResult> {
    throwIfParentAborted(signal);
    build.waiterCount += 1;
    build.subscribers.add(subscriber);
    // Late joiners should not regress to an empty spinner while the first tab
    // is already showing rows. Snapshot first, then the latest enrichment bar.
    try {
      if (build.latestSnapshot) subscriber.onSnapshot?.(build.latestSnapshot);
      if (build.latestProgress) subscriber.onProgress?.(build.latestProgress);
    } catch {
      // The request promise still delivers the final result.
    }

    return new Promise<SpendersListResult>((resolve, reject) => {
      let finished = false;
      const cleanup = (): void => {
        if (finished) return;
        finished = true;
        // Every terminal path for this waiter runs through here (resolved,
        // rejected, or aborted), so a joiner reports the page the shared build
        // resolved even though it never held the local that carries it.
        adoptScope(scope, build.scope);
        signal.removeEventListener('abort', onAbort);
        build.subscribers.delete(subscriber);
        build.waiterCount = Math.max(0, build.waiterCount - 1);
        if (!build.settled && build.waiterCount === 0) {
          if (this.inFlightByKey.get(key) === build) {
            this.inFlightByKey.delete(key);
          }
          build.controller.abort();
        }
      };
      const onAbort = (): void => {
        cleanup();
        reject(parentAbortError(signal));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      build.promise.then(
        (result) => {
          cleanup();
          resolve(result);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
      // A replay callback above may synchronously abort this caller before the
      // listener is installed. AbortSignal does not replay an earlier event,
      // so close that gap after the shared promise has its rejection handler.
      if (signal.aborted) {
        onAbort();
      }
    });
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
    scope: SpendersBuildScope,
    onProgress?: (progress: SpendersProgressPayload) => void,
    onSnapshot?: (snapshot: SpendersSnapshotPayload) => void,
  ): Promise<BuiltSpendersResult> {
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
    // From here on every failure knows its page. Nothing below this line may
    // clear it — a build that got further learned more, not less.
    scope.pageLabel = pageLabel;

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
    // Start the required lifetime request first. Optional work is launched
    // immediately after, but can never consume a sequential mock/retry slot
    // that belongs to the authoritative request.
    const lifetimeRequest = this.kernelSource!.fetchTopSpenders(
      settings,
      pageLabel,
      'lifetime',
      SPENDERS_KERNEL_LIMIT,
      signal,
    );
    const monthOutcome = this.fetchMonthBestEffort(
      settings,
      pageLabel,
      monthWindow,
      signal,
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    let lifetime: KernelSpendersSnapshot;
    try {
      lifetime = await lifetimeRequest;
    } catch (error) {
      chatMapController.abort();
      throw error;
    }
    // The projection's own freshness is known as soon as the ranking lands, so
    // a failure in the optional enrichment that follows can still say how old
    // the data was.
    scope.builtAt = parseKernelTimestamp(lifetime.builtAt);

    // Lifetime is the only authoritative ranking. Publish it immediately with
    // honest unknowns for optional fields; month, direct-chat ids, and custom
    // names hydrate in the final response without hiding usable rows.
    const preliminary = this.assembleKernelResult(
      lifetime,
      null,
      monthWindow,
      new Map(),
      new Map(),
      pageLabel,
    );
    onSnapshot?.({ type: 'spenders:snapshot', result: preliminary.result });

    if (lifetime.entries.length === 0) {
      // Disabled, pending, and authoritatively-empty sources have no chat to
      // open and no names to decorate. Cancel the speculative Fansly request
      // instead of making the board wait for its 12-second deadline.
      chatMapController.abort();
    }

    // Once the ranking exists, run all optional enrichment concurrently. The
    // settled wrappers prevent a fast fatal outcome from becoming unhandled
    // while another best-effort source is still finishing.
    // Deleted accounts are never returned by /account?ids=, so asking again
    // every build spends Fansly requests to learn nothing (238 of lora-1's 709
    // rows are deleted) and the negative answer is not cacheable. The kernel
    // already knows they are gone; the board labels those rows instead.
    // `== null`, not `!== null`: a kernel that predates the field, and any row
    // that reached here without it, must count as ALIVE.
    // Only the NETWORK half is gated: every listed id, deleted included, still
    // gets its cache lookup, or a fan the chatter renamed would lose that name
    // the moment the kernel marked them deleted.
    const sweepableIds = new Set(
      lifetime.entries
        .filter((entry) => entry.deletedAt == null)
        .map((entry) => entry.platformUserId),
    );
    const namesOutcome = lifetime.entries.length === 0
      ? Promise.resolve({ ok: true as const, value: new Map<string, FanNames>() })
      : this.resolveFanNames(
          lifetime.entries.map((entry) => entry.platformUserId),
          sweepableIds,
          session,
          signal,
          onProgress,
        ).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
    const [mapOutcome, resolvedMonth, resolvedNames] = await Promise.all([
      chatMapOutcome,
      monthOutcome,
      namesOutcome,
    ]);
    if (!mapOutcome.ok) throw mapOutcome.error;
    if (!resolvedMonth.ok) throw resolvedMonth.error;
    if (!resolvedNames.ok) throw resolvedNames.error;
    const { fans } = mapOutcome.value;
    const groupByFanId = new Map(fans.map((fan) => [fan.fanAccountId, fan.groupId]));
    return this.assembleKernelResult(
      lifetime,
      resolvedMonth.value,
      monthWindow,
      groupByFanId,
      resolvedNames.value,
      pageLabel,
    );
  }

  private assembleKernelResult(
    lifetime: KernelSpendersSnapshot,
    month: KernelSpendersSnapshot | null,
    monthWindow: string,
    groupByFanId: ReadonlyMap<string, string>,
    namesByFanId: ReadonlyMap<string, FanNames>,
    pageLabel: string,
  ): BuiltSpendersResult {
    // Source health distinguishes a successful empty month from an unramped
    // stream. Even when usable, entries may be a bounded top-N subset: only
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
        // `?? null` collapses "this kernel does not report deletion" and "this
        // fan is alive" into the same value on purpose: both mean the board has
        // no reason to mark the row.
        deletedAt: entry.deletedAt ?? null,
      };
    });

    return {
      result: {
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
        // Which page this board is about. The options row names it, so an
        // «приток остановлен» verdict cannot be read as a claim about some
        // other creator the same browser also opened.
        pageLabel,
      },
      // A compatible old Core can return only 500 for the requested 1000.
      // Do not pin that truncated recovery result for ten minutes after Core
      // comes back. Legitimate pages above 1000 still satisfy min(total, cap).
      hasRequestedCoverage:
        lifetime.entries.length === Math.min(lifetime.fanCount, SPENDERS_KERNEL_LIMIT) &&
        (
          month === null ||
          month.entries.length === Math.min(month.fanCount, SPENDERS_KERNEL_LIMIT)
        ),
    };
  }

  /** Names for the listed fans: session-cached first (6h TTL — renames are
   * rare), then ONE paced sweep for unknown ids only: no retry budget, an
   * inter-batch pause, and a hard wall-clock budget. Best-effort throughout:
   * whatever the sweep did not reach stays on platform names.
   *
   * `sweepableIds` gates the NETWORK half only. Every listed id is still looked
   * up in the cache: a deleted fan the chatter had renamed (E25 custom name,
   * the one the team recognizes) must keep that name on the board — dropping it
   * would turn a familiar big spender into an anonymous «deleted account» row,
   * which is worse than the id it replaced. */
  private async resolveFanNames(
    fanAccountIds: string[],
    sweepableIds: ReadonlySet<string>,
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
    // Unknown AND askable. An id outside `sweepableIds` is not «missing» in any
    // useful sense: the platform will never answer for it, so it must not enter
    // a batch, consume the sweep budget, or inflate the progress total.
    const missing = requestedIds.filter((id) => !namesById.has(id) && sweepableIds.has(id));
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
    for (const [key] of this.inFlightByKey) {
      if (!key.startsWith(prefix)) continue;
      this.inFlightByKey.delete(key);
    }
    // Includes direct Refresh builds and a cold build that Refresh superseded
    // in inFlightByKey; neither may keep using invalidated credentials.
    for (const [controller, key] of this.activeBuildControllers) {
      if (key.startsWith(prefix)) controller.abort();
    }
    await deleteSessionCachesWithPrefix(prefix);
  }

  /** Source identity changed (Hub settings or credential): no persisted board
   * is safe to reuse, including a build that was already in flight. */
  async invalidateAll(): Promise<void> {
    this.cacheGeneration += 1;
    this.cache.clear();
    this.latestBuildByKey.clear();
    for (const controller of this.activeBuildControllers.keys()) {
      controller.abort();
    }
    this.inFlightByKey.clear();
    await clearSessionCache();
  }
}
