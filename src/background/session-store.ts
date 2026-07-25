import type { RouteKey, SessionSnapshotEntry, SessionTemplate } from '../shared/types.js';
import { recordAccountPresence } from './account-presence.js';

export interface SessionCaptureResult {
  accountId: string;
  authorization: string;
  fanslyClientId: string;
  fanslySessionId: string;
  fanslyClientTs: string;
  fanslyClientCheck: string | null;
  routeKey: RouteKey | null;
}

export class SessionStore {
  private readonly sessionsByAccount = new Map<string, SessionTemplate>();
  private readonly accountByTabId = new Map<number, string>();

  registerCapture(tabId: number, capture: SessionCaptureResult): SessionTemplate {
    const previousAccountId = this.accountByTabId.get(tabId) ?? null;
    if (previousAccountId && previousAccountId !== capture.accountId) {
      this.accountByTabId.delete(tabId);
      this.pruneOrphanedSession(previousAccountId);
    }

    // Reuse the existing object identity when the same account re-captures
    // (e.g. a re-login), refreshing its credentials in place so an in-flight
    // request holding this reference picks up the new token instead of
    // continuing to 401 on a detached stale copy.
    const existing = this.sessionsByAccount.get(capture.accountId);
    const session: SessionTemplate = existing ?? {
      accountId: capture.accountId,
      resolvedAccountId: null,
      resolvedUsername: null,
      resolvedDisplayName: null,
      authorization: capture.authorization,
      fanslyClientId: capture.fanslyClientId,
      fanslySessionId: capture.fanslySessionId,
      latestTs: capture.fanslyClientTs,
      latestCheck: capture.fanslyClientCheck,
      routeChecks: {},
      lastSeenAt: Date.now(),
      connected: true,
    };

    if (existing) {
      // Preserve resolved identity and accumulated routeChecks; refresh creds.
      existing.authorization = capture.authorization;
      existing.fanslyClientId = capture.fanslyClientId;
      existing.fanslySessionId = capture.fanslySessionId;
      existing.latestTs = capture.fanslyClientTs;
      existing.latestCheck = capture.fanslyClientCheck;
      existing.lastSeenAt = Date.now();
      existing.connected = true;
    }

    if (capture.routeKey && capture.fanslyClientCheck) {
      session.routeChecks[capture.routeKey] = capture.fanslyClientCheck;
    }

    this.sessionsByAccount.set(capture.accountId, session);
    this.accountByTabId.set(tabId, capture.accountId);
    // Durable presence: this map dies with the worker, so the moment is recorded
    // outside it (leading write + 30s coalescing inside the store — every Fansly
    // request is a capture). Keyed by the canonical id once identity resolved, so
    // a rekeyed account does not resurrect its legacy row. Names are still null
    // at capture time; the fansly-client hook fills them in after `account/me`.
    // Fire-and-forget by design: presence must never delay or fail a capture.
    void recordAccountPresence({
      accountId: session.resolvedAccountId ?? capture.accountId,
      username: session.resolvedUsername,
      displayName: session.resolvedDisplayName,
    }).catch(() => undefined);
    return session;
  }

  /** The tab a live account is captured on, or null. Only the in-memory map can
   * answer this: after a worker restart no tab is attributable to an account,
   * and the accounts view says so instead of guessing. */
  getTabIdForAccount(accountId: string | null | undefined): number | null {
    if (!accountId) {
      return null;
    }
    for (const [tabId, mappedAccountId] of this.accountByTabId) {
      if (mappedAccountId === accountId) {
        return tabId;
      }
      const session = this.sessionsByAccount.get(mappedAccountId);
      if (session?.resolvedAccountId === accountId) {
        return tabId;
      }
    }
    return null;
  }

  getSessionByAccount(accountId: string | null | undefined): SessionTemplate | null {
    if (!accountId) {
      return null;
    }

    const direct = this.sessionsByAccount.get(accountId);
    if (direct) {
      return direct;
    }

    for (const session of this.sessionsByAccount.values()) {
      if (session.resolvedAccountId === accountId) {
        return session;
      }
    }

    return null;
  }

  getSessionForTab(tabId: number): SessionTemplate | null {
    const accountId = this.accountByTabId.get(tabId);
    return accountId ? this.getSessionByAccount(accountId) : null;
  }

  getSessions(): SessionTemplate[] {
    return Array.from(this.sessionsByAccount.values());
  }

  getAccountIdForTab(tabId: number): string | null {
    return this.accountByTabId.get(tabId) ?? null;
  }

  getDisplayAccountIdForTab(tabId: number): string | null {
    const session = this.getSessionForTab(tabId);
    return session?.resolvedAccountId ?? session?.accountId ?? null;
  }

  markDisconnected(accountId: string): void {
    const existing = this.sessionsByAccount.get(accountId);
    if (!existing) {
      return;
    }

    // Mutate in place so an in-flight request holding this reference observes
    // the disconnect instead of continuing against a detached stale copy.
    existing.connected = false;
  }

  forgetTab(tabId: number): void {
    const accountId = this.accountByTabId.get(tabId);
    this.accountByTabId.delete(tabId);

    if (accountId) {
      this.pruneOrphanedSession(accountId);
    }
  }

  snapshot(): SessionSnapshotEntry[] {
    const activeAccountIds = new Set(this.accountByTabId.values());

    return Array.from(activeAccountIds)
      .map((legacyAccountId) => {
        const session = this.sessionsByAccount.get(legacyAccountId);
        if (!session) {
          return null;
        }

        return {
          legacyAccountId,
          resolvedAccountId: session.resolvedAccountId,
          username: session.resolvedUsername,
          displayName: session.resolvedDisplayName,
          connected: session.connected,
          lastSeenAt: session.lastSeenAt,
        } satisfies SessionSnapshotEntry;
      })
      .filter((entry): entry is SessionSnapshotEntry => entry !== null);
  }

  private pruneOrphanedSession(accountId: string): void {
    if (!this.isAccountReferenced(accountId)) {
      this.sessionsByAccount.delete(accountId);
    }
  }

  private isAccountReferenced(accountId: string): boolean {
    return Array.from(this.accountByTabId.values()).some(
      (referencedAccountId) => referencedAccountId === accountId,
    );
  }
}
