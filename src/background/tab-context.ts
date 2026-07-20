import type { TabContext } from '../shared/types.js';

export class TabContextStore {
  private readonly contexts = new Map<number, TabContext>();

  getOrCreate(tabId: number): TabContext {
    const existing = this.contexts.get(tabId);
    if (existing) {
      return existing;
    }

    const context: TabContext = {
      tabId,
      accountId: null,
      groupId: null,
      fanAccountId: null,
      fanDisplayName: null,
      activeOperationId: null,
      routeNonce: 0,
    };

    this.contexts.set(tabId, context);
    return context;
  }

  setAccount(tabId: number, accountId: string | null): TabContext {
    const context = this.getOrCreate(tabId);
    context.accountId = accountId;
    return context;
  }

  setRoute(tabId: number, groupId: string | null, routeNonce: number): TabContext {
    const context = this.getOrCreate(tabId);
    // Clear the cached fan whenever the CONVERSATION changes — on ANY groupId
    // change, not only a null route. Fan resolution is always per-operation, so a
    // stale fan from group A must never ride a request for group B: an SPA
    // transition A→B previously left A's fanAccountId under groupId B, so
    // recap-status(B, null) resolved fanRef=A and the Hub could return A's recap
    // metadata for B's conversation. Re-setting the SAME groupId (routeNonce bump)
    // keeps the fan.
    if (context.groupId !== groupId) {
      context.fanAccountId = null;
      context.fanDisplayName = null;
    }
    context.groupId = groupId;
    context.routeNonce = routeNonce;
    return context;
  }

  setFan(
    tabId: number,
    groupId: string | null,
    fanAccountId: string | null,
    fanDisplayName: string | null,
  ): TabContext {
    const context = this.getOrCreate(tabId);
    // Structural stale-fan guard: only write the fan into the context it was
    // resolved FOR (`groupId` = the operation's conversation). A LATE writer — an
    // operation on group A whose fan lookup resolves after an SPA route-change to
    // B has already advanced this context and aborted the op — must NOT stamp A's
    // fan onto a context now at B, or recap-status(B, null) would resolve fanRef=A
    // and the Hub could return A's recap metadata for B. The invariant lives HERE,
    // not in each caller's discipline (the setRoute reader-half is not enough).
    if (context.groupId !== groupId) {
      return context;
    }
    context.fanAccountId = fanAccountId;
    context.fanDisplayName = fanDisplayName;
    return context;
  }

  setActiveOperation(tabId: number, operationId: string | null): TabContext {
    const context = this.getOrCreate(tabId);
    context.activeOperationId = operationId;
    return context;
  }

  get(tabId: number): TabContext | null {
    return this.contexts.get(tabId) ?? null;
  }

  remove(tabId: number): void {
    this.contexts.delete(tabId);
  }
}
