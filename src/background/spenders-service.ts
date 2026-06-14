// Builds the ranked top-spenders board. Fansly exposes no "all fans by spend"
// endpoint, so this enumerates the creator's conversations and fetches lifetime
// earnings per fan (one call each), at bounded concurrency, capped to the most
// recent SPENDERS_MAX_FANS conversations. Results are cached per creator for a
// short window so reopening the board is instant and doesn't re-hammer Fansly.

import {
  SPENDERS_CACHE_TTL_MS,
  SPENDERS_EARNINGS_CONCURRENCY,
  SPENDERS_MAX_FANS,
} from '../shared/constants.js';
import { mapWithConcurrency } from '../shared/concurrency.js';
import type {
  FanslyAccountResponse,
  SessionTemplate,
  SpenderListEntry,
  SpendersListResult,
} from '../shared/types.js';
import type { FanslyClient } from './fansly-client.js';

const ACCOUNT_NAME_BATCH = 50;

interface CacheEntry {
  builtAt: number;
  result: SpendersListResult;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export class SpendersService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly fanslyClient: FanslyClient) {}

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

    const { fans, truncated } = await this.fanslyClient.listFanAccounts(
      SPENDERS_MAX_FANS,
      session,
      signal,
    );

    const spend = await mapWithConcurrency(
      fans,
      SPENDERS_EARNINGS_CONCURRENCY,
      async (fan) => {
        const lifetimeMills = await this.fetchLifetimeMills(fan.fanAccountId, now, session, signal);
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

    const result: SpendersListResult = {
      entries,
      builtAt: now,
      fanCount: entries.length,
      scannedCount: fans.length,
      truncated,
    };

    this.cache.set(key, { builtAt: now, result });
    return result;
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
