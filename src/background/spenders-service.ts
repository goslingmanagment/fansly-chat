// The ranked top-spenders board. Stage 32 Task 4: rankings come from ONE
// kernel query over the Stage 16 fan-earnings projection
// (GET /api/v1/pages/:pageLabel/top-spenders) instead of the legacy rebuild
// that fetched lifetime earnings per fan (~150 Fansly calls per creator per
// 10 minutes). One bounded Fansly conversations enumeration REMAINS — it is
// the fan→groupId map the board needs to open chats (DP 1-B: the extension
// stays free to read Fansly for conversation context; it just never rebuilds
// rankings from quota-expensive sweeps).
//
// The legacy rebuild stays behind the hidden `spendersLegacyRebuild` setting
// for ONE release (diagnostic fallback; no UI — flipped via storage), then
// dies. Kernel snapshots carry an honest as-of timestamp: builtAt =
// max(observed_at) of the projection window, not "now".

import {
  SPENDERS_CACHE_TTL_MS,
  SPENDERS_EARNINGS_CONCURRENCY,
  SPENDERS_MAX_FANS,
} from '../shared/constants.js';
import { mapWithConcurrency } from '../shared/concurrency.js';
import { ChatGooseError } from '../shared/errors.js';
import type {
  FanslyAccountResponse,
  SessionTemplate,
  Settings,
  SpenderListEntry,
  SpendersListResult,
} from '../shared/types.js';
import type { AgencyHubClient } from './agency-hub-client.js';
import type { FanslyClient } from './fansly-client.js';

const ACCOUNT_NAME_BATCH = 50;

interface CacheEntry {
  builtAt: number;
  result: SpendersListResult;
}

export interface SpendersKernelSource {
  resolvePageLabelForUsername: AgencyHubClient['resolvePageLabelForUsername'];
  fetchTopSpenders(
    settings: Settings,
    pageLabel: string,
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
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
      if (cached && now - cached.builtAt < SPENDERS_CACHE_TTL_MS) {
        return cached.result;
      }
    }

    const settings = await this.getSettings?.();
    const useKernel =
      this.kernelSource !== undefined &&
      settings !== undefined &&
      !settings.spendersLegacyRebuild;

    const result = useKernel
      ? await this.buildFromKernel(session, settings, signal, now)
      : await this.buildLegacy(session, signal, now);

    this.cache.set(key, { builtAt: now, result });
    return result;
  }

  private async buildFromKernel(
    session: SessionTemplate,
    settings: Settings,
    signal: AbortSignal,
    nowMs: number,
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

    // The one Fansly read that remains: conversation enumeration = the
    // fan→groupId map for opening chats from the board.
    const { fans, truncated } = await this.fanslyClient.listFanAccounts(
      SPENDERS_MAX_FANS,
      session,
      signal,
    );
    const groupByFanId = new Map(fans.map((fan) => [fan.fanAccountId, fan.groupId]));

    const snapshot = await this.kernelSource!.fetchTopSpenders(
      settings,
      pageLabel,
      SPENDERS_MAX_FANS,
      signal,
    );

    const entries: SpenderListEntry[] = snapshot.entries
      .filter((entry) => groupByFanId.has(entry.platformUserId))
      .map((entry) => ({
        fanAccountId: entry.platformUserId,
        groupId: groupByFanId.get(entry.platformUserId)!,
        displayName: entry.displayName,
        username: entry.username,
        lifetimeMills: entry.grossMills,
        lifetimeUsd: entry.grossMills / 1000,
      }));

    return {
      entries,
      // Honest staleness: the projection's freshest observation, not "now".
      builtAt: snapshot.builtAt !== null ? Date.parse(snapshot.builtAt) : nowMs,
      fanCount: entries.length,
      scannedCount: fans.length,
      truncated,
    };
  }

  /** Pre-cutover rebuild (~SPENDERS_MAX_FANS Fansly calls) — hidden-setting
   * fallback for one release, then deleted. */
  private async buildLegacy(
    session: SessionTemplate,
    signal: AbortSignal,
    nowMs: number,
  ): Promise<SpendersListResult> {
    const { fans, truncated } = await this.fanslyClient.listFanAccounts(
      SPENDERS_MAX_FANS,
      session,
      signal,
    );

    const spend = await mapWithConcurrency(
      fans,
      SPENDERS_EARNINGS_CONCURRENCY,
      async (fan) => {
        const lifetimeMills = await this.fetchLifetimeMills(fan.fanAccountId, nowMs, session, signal);
        return { fan, lifetimeMills };
      },
    );

    // Per-fan fetches swallow aborts (→ $0) so abandoned fan-out workers can't
    // raise unhandled rejections; surface the timeout here instead, before we
    // build or cache a board that would otherwise be a partial/empty snapshot.
    if (signal.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    const payers = spend.filter((row) => row.lifetimeMills > 0);
    const nameById = await this.resolveNames(
      payers.map((row) => row.fan.fanAccountId),
      session,
      signal,
    );

    const entries: SpenderListEntry[] = payers
      .map((row) => {
        const account = nameById.get(row.fan.fanAccountId);
        return {
          fanAccountId: row.fan.fanAccountId,
          groupId: row.fan.groupId,
          displayName: account?.displayName ?? null,
          username: account?.username ?? null,
          lifetimeMills: row.lifetimeMills,
          lifetimeUsd: row.lifetimeMills / 1000,
        } satisfies SpenderListEntry;
      })
      .sort((a, b) => b.lifetimeMills - a.lifetimeMills);

    return {
      entries,
      builtAt: nowMs,
      fanCount: entries.length,
      scannedCount: fans.length,
      truncated,
    };
  }

  /**
   * Best-effort lifetime gross; ANY per-fan failure (including an abort) counts
   * as $0 so a failing fetch in one fan-out worker can't reject the whole batch
   * or orphan its siblings. A real timeout is detected by the caller via
   * `signal.aborted` after the fan-out settles.
   */
  private async fetchLifetimeMills(
    fanAccountId: string,
    nowMs: number,
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<number> {
    try {
      const earnings = await this.fanslyClient.getEarnings(fanAccountId, 0, nowMs, session, signal);
      return earnings?.totalGross ?? 0;
    } catch {
      return 0;
    }
  }

  private async resolveNames(
    fanAccountIds: string[],
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<Map<string, FanslyAccountResponse>> {
    const nameById = new Map<string, FanslyAccountResponse>();
    for (let i = 0; i < fanAccountIds.length; i += ACCOUNT_NAME_BATCH) {
      const batch = fanAccountIds.slice(i, i + ACCOUNT_NAME_BATCH);
      try {
        const accounts = await this.fanslyClient.getAccountNames(batch, session, signal);
        for (const account of accounts) {
          if (account.id) {
            nameById.set(account.id, account);
          }
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        // Names are cosmetic — a failed batch just renders ids/usernames blank.
      }
    }
    return nameById;
  }

  invalidate(session: SessionTemplate): void {
    this.cache.delete(this.cacheKey(session));
  }
}
