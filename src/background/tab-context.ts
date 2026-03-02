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
    context.groupId = groupId;
    context.routeNonce = routeNonce;
    if (!groupId) {
      context.fanAccountId = null;
      context.fanDisplayName = null;
    }
    return context;
  }

  setFan(tabId: number, fanAccountId: string | null, fanDisplayName: string | null): TabContext {
    const context = this.getOrCreate(tabId);
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
