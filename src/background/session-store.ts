import type { RouteKey, SessionSnapshotEntry, SessionTemplate } from '../shared/types.js';

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
    const existing = this.sessionsByAccount.get(capture.accountId);
    const session: SessionTemplate = {
      accountId: capture.accountId,
      resolvedAccountId: existing?.resolvedAccountId ?? null,
      resolvedUsername: existing?.resolvedUsername ?? null,
      resolvedDisplayName: existing?.resolvedDisplayName ?? null,
      authorization: capture.authorization,
      fanslyClientId: capture.fanslyClientId,
      fanslySessionId: capture.fanslySessionId,
      latestTs: capture.fanslyClientTs,
      latestCheck: capture.fanslyClientCheck,
      routeChecks: { ...(existing?.routeChecks ?? {}) },
      lastSeenAt: Date.now(),
      connected: true,
    };

    if (capture.routeKey && capture.fanslyClientCheck) {
      session.routeChecks[capture.routeKey] = capture.fanslyClientCheck;
    }

    this.sessionsByAccount.set(capture.accountId, session);
    this.accountByTabId.set(tabId, capture.accountId);
    return session;
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

    this.sessionsByAccount.set(accountId, {
      ...existing,
      connected: false,
    });
  }

  forgetTab(tabId: number): void {
    this.accountByTabId.delete(tabId);
  }

  snapshot(): SessionSnapshotEntry[] {
    return Array.from(this.sessionsByAccount.entries()).map(([legacyAccountId, session]) => ({
      legacyAccountId,
      resolvedAccountId: session.resolvedAccountId,
      username: session.resolvedUsername,
      displayName: session.resolvedDisplayName,
      connected: session.connected,
      lastSeenAt: session.lastSeenAt,
    }));
  }
}
