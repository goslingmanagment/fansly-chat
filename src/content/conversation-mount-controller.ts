import { CONVERSATION_ATTACH_RETRY_MS, CONVERSATION_ATTACH_TIMEOUT_MS } from '../shared/constants.js';
import { getActiveConversationDom } from './conversation-dom.js';
import type { ActiveConversationDom } from './conversation-dom.js';

type ConversationDomResolver = () => ActiveConversationDom | null;

export class ConversationMountController {
  private activeGroupId: string | null = null;
  private sessionId = 0;
  private retryTimer: number | null = null;
  private retryDeadlineMs: number | null = null;
  private stopObserver: (() => void) | null = null;
  private mountedInputHost: HTMLElement | null = null;
  private mountedRouteRoot: HTMLElement | null = null;
  private mountedObservationRoot: HTMLElement | null = null;

  constructor(
    private readonly root: HTMLElement,
    private readonly resolveConversationDom: ConversationDomResolver = getActiveConversationDom,
  ) {}

  setActiveRoute(groupId: string | null): void {
    this.activeGroupId = groupId;
    this.sessionId += 1;
    this.resetMountState();

    if (!groupId) {
      this.detachRoot();
      return;
    }

    this.detachRoot();
    if (this.syncNow()) {
      return;
    }

    this.retryDeadlineMs = Date.now() + CONVERSATION_ATTACH_TIMEOUT_MS;
    this.scheduleRetry(this.sessionId);
  }

  syncNow(): boolean {
    if (!this.activeGroupId) {
      return false;
    }

    const conversation = this.resolveConversationDom();
    if (!conversation) {
      return false;
    }

    this.attach(conversation, this.sessionId);
    return true;
  }

  detach(): void {
    this.activeGroupId = null;
    this.sessionId += 1;
    this.resetMountState();
    this.detachRoot();
  }

  destroy(): void {
    this.detach();
  }

  private attach(conversation: ActiveConversationDom, sessionId: number): void {
    if (this.root.parentElement !== conversation.inputParent || this.root.nextSibling !== conversation.inputHost) {
      conversation.inputParent.insertBefore(this.root, conversation.inputHost);
    }

    this.mountedInputHost = conversation.inputHost;
    this.mountedRouteRoot = conversation.routeRoot;
    this.mountedObservationRoot =
      conversation.routeRoot.parentElement instanceof HTMLElement ? conversation.routeRoot.parentElement : conversation.routeRoot;
    this.clearRetry();
    this.startObserver(sessionId);
  }

  private handleObservedChange(sessionId: number): void {
    if (sessionId !== this.sessionId || !this.activeGroupId) {
      return;
    }

    if (this.isAnchorValid()) {
      return;
    }

    this.stopObserving();
    this.mountedInputHost = null;
    this.mountedRouteRoot = null;
    this.mountedObservationRoot = null;
    this.detachRoot();

    if (this.syncNow()) {
      return;
    }

    this.retryDeadlineMs = Date.now() + CONVERSATION_ATTACH_TIMEOUT_MS;
    this.scheduleRetry(sessionId);
  }

  private isAnchorValid(): boolean {
    return Boolean(
      this.activeGroupId &&
        this.root.isConnected &&
        this.mountedInputHost?.isConnected &&
        this.mountedRouteRoot?.isConnected &&
        this.mountedObservationRoot?.isConnected &&
        this.root.parentElement === this.mountedInputHost.parentElement &&
        this.root.nextSibling === this.mountedInputHost,
    );
  }

  private scheduleRetry(sessionId: number): void {
    if (this.retryTimer !== null) {
      return;
    }

    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;

      if (sessionId !== this.sessionId || !this.activeGroupId) {
        return;
      }

      if (this.syncNow()) {
        return;
      }

      if (this.retryDeadlineMs !== null && Date.now() >= this.retryDeadlineMs) {
        this.retryDeadlineMs = null;
        return;
      }

      this.scheduleRetry(sessionId);
    }, CONVERSATION_ATTACH_RETRY_MS);
  }

  private startObserver(sessionId: number): void {
    this.stopObserving();

    const observationRoot = this.mountedObservationRoot;
    if (!observationRoot) {
      return;
    }

    let pending = false;
    let callbackTimer: number | null = null;
    const observer = new MutationObserver(() => {
      if (pending) {
        return;
      }

      pending = true;
      callbackTimer = window.setTimeout(() => {
        pending = false;
        callbackTimer = null;
        this.handleObservedChange(sessionId);
      }, 0);
    });

    observer.observe(observationRoot, { childList: true, subtree: true });
    this.stopObserver = () => {
      observer.disconnect();
      if (callbackTimer !== null) {
        window.clearTimeout(callbackTimer);
      }
    };
  }

  private resetMountState(): void {
    this.clearRetry();
    this.stopObserving();
    this.mountedInputHost = null;
    this.mountedRouteRoot = null;
    this.mountedObservationRoot = null;
  }

  private stopObserving(): void {
    this.stopObserver?.();
    this.stopObserver = null;
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retryDeadlineMs = null;
  }

  private detachRoot(): void {
    this.root.remove();
  }
}
