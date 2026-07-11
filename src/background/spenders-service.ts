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
// Kernel snapshots carry an honest as-of timestamp: builtAt =
// max(observed_at) of the projection window, not "now".

import {
  FANSLY_CUSTOM_NAME_NOTE_TYPE,
  SPENDERS_CACHE_TTL_MS,
  SPENDERS_KERNEL_LIMIT,
  SPENDERS_MAX_FANS,
  SPENDERS_NAME_LOOKUP_BATCH,
} from '../shared/constants.js';
import { ChatGooseError } from '../shared/errors.js';
import { monthWindowFor } from '../shared/spenders.js';
import type {
  FanslyAccountResponse,
  SessionTemplate,
  Settings,
  SpenderListEntry,
  SpendersListResult,
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

interface CacheEntry {
  cachedAt: number;
  result: SpendersListResult;
}

// MV3 event-page workers die between board opens; storage.session keeps the
// 10-minute cache useful across restarts (dies with the browser session,
// never syncs). Module memory is the fallback for unit tests/exotic builds —
// mirrors quota-tracker's custody pattern.
const SESSION_CACHE_STORAGE_KEY = 'spendersCache';

function sessionStorageArea(): browser.storage.StorageArea | null {
  try {
    return browser.storage?.session ?? null;
  } catch {
    return null;
  }
}

async function readSessionCache(key: string): Promise<CacheEntry | null> {
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
      !Array.isArray(candidate.result.entries)
    ) {
      return null;
    }
    return candidate;
  } catch {
    return null;
  }
}

async function writeSessionCache(key: string, entry: CacheEntry | null): Promise<void> {
  const area = sessionStorageArea();
  if (!area) return;
  try {
    const raw = await area.get(SESSION_CACHE_STORAGE_KEY);
    const all =
      raw[SESSION_CACHE_STORAGE_KEY] && typeof raw[SESSION_CACHE_STORAGE_KEY] === 'object'
        ? { ...(raw[SESSION_CACHE_STORAGE_KEY] as Record<string, CacheEntry>) }
        : {};
    if (entry === null) {
      delete all[key];
    } else {
      all[key] = entry;
    }
    await area.set({ [SESSION_CACHE_STORAGE_KEY]: all });
  } catch {
    // Best-effort persistence; the in-memory cache already holds the data.
  }
}

export interface SpendersKernelSource {
  resolvePageLabelForUsername: AgencyHubClient['resolvePageLabelForUsername'];
  fetchTopSpenders(
    settings: Settings,
    pageLabel: string,
    window: string,
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    builtAt: string | null;
    fanCount: number;
    entries: Array<{
      platformUserId: string;
      username: string | null;
      displayName: string | null;
      grossMills: number;
    }>;
  }>;
}

export class SpendersService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly fanslyClient: FanslyClient,
    private readonly kernelSource?: SpendersKernelSource,
    private readonly getSettings?: () => Promise<Settings>,
  ) {}

  private cacheKey(session: SessionTemplate): string {
    return session.resolvedAccountId ?? session.accountId;
  }

  async getList(
    session: SessionTemplate,
    signal: AbortSignal,
    options?: { refresh?: boolean },
  ): Promise<SpendersListResult> {
    const key = this.cacheKey(session);
    const now = Date.now();

    if (!options?.refresh) {
      const cached = this.cache.get(key);
      if (cached && now - cached.cachedAt < SPENDERS_CACHE_TTL_MS) {
        return cached.result;
      }
      // Worker restarted since the last build? The session-storage copy is
      // still fresh for up to the same TTL.
      const persisted = await readSessionCache(key);
      if (
        persisted &&
        now - persisted.cachedAt < SPENDERS_CACHE_TTL_MS &&
        persisted.result.builtAt !== null
      ) {
        this.cache.set(key, persisted);
        return persisted.result;
      }
    }

    const settings = await this.getSettings?.();
    if (this.kernelSource === undefined || settings === undefined) {
      // The legacy per-fan rebuild died in 1.7.0 — a board without the kernel
      // wired is a composition bug, not a fallback case.
      throw new ChatGooseError('hub_request_failed');
    }

    const result = await this.buildFromKernel(session, settings, signal);

    // W9.3/A20: builtAt === null means the kernel has never walked this
    // page (not ramped) — caching would pin a "not enabled" board for
    // 10 minutes past the moment rankings actually turn on.
    if (result.builtAt !== null) {
      const entry: CacheEntry = { cachedAt: now, result };
      this.cache.set(key, entry);
      void writeSessionCache(key, entry);
    } else {
      this.cache.delete(key);
      void writeSessionCache(key, null);
    }
    return result;
  }

  private async buildFromKernel(
    session: SessionTemplate,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<SpendersListResult> {
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
    const [{ fans }, lifetime, month] = await Promise.all([
      // The one Fansly read that remains: conversation enumeration = the
      // fan→groupId map for opening chats. It does NOT gate membership.
      this.fanslyClient.listFanAccounts(SPENDERS_MAX_FANS, session, signal),
      this.kernelSource!.fetchTopSpenders(
        settings,
        pageLabel,
        'lifetime',
        SPENDERS_KERNEL_LIMIT,
        signal,
      ),
      // Best-effort month column: a failed or empty month window degrades
      // the +$N column to unknown, never the board.
      this.kernelSource!
        .fetchTopSpenders(settings, pageLabel, monthWindow, SPENDERS_KERNEL_LIMIT, signal)
        .catch(() => null),
    ]);

    const groupByFanId = new Map(fans.map((fan) => [fan.fanAccountId, fan.groupId]));
    // builtAt null = no monthly observations in the window. That is
    // indistinguishable from "monthly stream not collected", so the column
    // reads unknown (null), never a misleading $0.
    const monthReady = month !== null && month.builtAt !== null;
    const monthByFanId = new Map(
      monthReady ? month.entries.map((entry) => [entry.platformUserId, entry.grossMills]) : [],
    );

    // Best-effort: the names chatters actually recognize. One batched
    // /account?ids= sweep (an endpoint this client already uses) brings the
    // creator-session account payloads, whose notes carry Fansly's native
    // custom display names; the same payload backfills platform names for
    // fans the projection knows only by id. Failure degrades to platform
    // names, never the board.
    const accountById = await this.resolveFanAccounts(
      lifetime.entries.map((entry) => entry.platformUserId),
      session,
      signal,
    );

    const entries: SpenderListEntry[] = lifetime.entries.map((entry) => {
      const monthMills = monthReady ? (monthByFanId.get(entry.platformUserId) ?? 0) : null;
      const account = accountById.get(entry.platformUserId);
      return {
        fanAccountId: entry.platformUserId,
        groupId: groupByFanId.get(entry.platformUserId) ?? null,
        customName: account ? customNameFromAccount(account) : null,
        displayName: entry.displayName ?? account?.displayName ?? null,
        username: entry.username ?? account?.username ?? null,
        lifetimeMills: entry.grossMills,
        lifetimeUsd: entry.grossMills / 1000,
        monthMills,
        monthUsd: monthMills !== null ? monthMills / 1000 : null,
      };
    });

    return {
      entries,
      // Honest staleness: the projection's freshest observation, not "now".
      // Null passes through verbatim (W9.3/A20): rewriting it to Date.now()
      // made a never-walked page claim "no paying fans … updated just now".
      builtAt: lifetime.builtAt !== null ? Date.parse(lifetime.builtAt) : null,
      fanCount: lifetime.fanCount,
      monthWindow: monthReady ? monthWindow : null,
      fetchedAt: Date.now(),
    };
  }

  /** Batched creator-session account lookup for the listed fans. Best-effort:
   * a failed batch drops only its own fans' names (platform names remain). */
  private async resolveFanAccounts(
    fanAccountIds: string[],
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<Map<string, FanslyAccountResponse>> {
    const accountById = new Map<string, FanslyAccountResponse>();
    for (let start = 0; start < fanAccountIds.length; start += SPENDERS_NAME_LOOKUP_BATCH) {
      const batch = fanAccountIds.slice(start, start + SPENDERS_NAME_LOOKUP_BATCH);
      try {
        const accounts = await this.fanslyClient.getAccountNames(batch, session, signal);
        for (const account of accounts) {
          if (account?.id) {
            accountById.set(account.id, account);
          }
        }
      } catch (error) {
        // An aborted build must still abort; anything else is best-effort.
        if (error instanceof DOMException && error.name === 'AbortError') {
          throw error;
        }
      }
    }
    return accountById;
  }

  /** Drop the cached board for this creator (memory + session storage). */
  invalidate(session: SessionTemplate): void {
    const key = this.cacheKey(session);
    this.cache.delete(key);
    void writeSessionCache(key, null);
  }
}
