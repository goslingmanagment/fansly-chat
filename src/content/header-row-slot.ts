// A place for one ChatGoose control in Fansly's own chat-header row, «Last
// seen … | Gallery | …» (E152, E157).
//
// The row lives inside Angular's header, which Fansly both reuses across chats
// and tears down (the Gallery view, a route change). A slot therefore trusts
// neither: every sync re-reads the open chat from the URL and re-homes the
// element, driven by the conversation subtree's mutations and a slow timer.
// Several slots share the row; each keeps its own place by `order`.

import {
  CONVERSATION_ATTACH_RETRY_MS,
  CONVERSATION_ATTACH_SLOW_RETRY_MS,
  CONVERSATION_ATTACH_TIMEOUT_MS,
} from '../shared/constants.js';
import { parseGroupIdFromPath } from '../shared/fansly-routes.js';

const ROUTE_ROOT_SELECTOR = 'app-messages-conversation-route';
/** The row under the fan's name. Fansly renders it only for a one-to-one chat. */
export const HEADER_SUB_ROW_SELECTOR =
  `${ROUTE_ROOT_SELECTOR} .message-content-header-contact .content-header-sub-row`;

export interface HeaderRowSlotOptions {
  /** The element's class: copies of it a previous instance of the extension
   * left in the row are removed. */
  className: string;
  /** Position among ChatGoose controls in the row, ascending left to right. */
  order: number;
  /** Paint the element for the chat that is open; called on every sync. */
  render: (groupId: string) => void;
}

export class HeaderRowSlot {
  private readonly cleanedRows = new WeakSet<HTMLElement>();
  private currentGroupId: string | null = null;
  private checkTimer: number | null = null;
  private attachDeadlineMs: number | null = null;
  private observedRoot: HTMLElement | null = null;
  private stopObserver: (() => void) | null = null;

  constructor(
    readonly root: HTMLElement,
    private readonly options: HeaderRowSlotOptions,
  ) {
    root.dataset.chatgooseRowOrder = String(options.order);
  }

  /** The chat the last sync found open. */
  get groupId(): string | null {
    return this.currentGroupId;
  }

  /** Re-read the page: which chat is open, and is the element still in its
   * row. Safe to call at any time; it only touches the DOM on a change. */
  sync(): void {
    const groupId = parseGroupIdFromPath(window.location.pathname);
    this.clearCheck();
    if (groupId !== this.currentGroupId) {
      this.currentGroupId = groupId;
      this.attachDeadlineMs = null;
    }
    if (!groupId) {
      this.stopObserving();
      this.root.remove();
      return;
    }

    this.options.render(groupId);
    const row = document.querySelector(HEADER_SUB_ROW_SELECTOR);
    if (!(row instanceof HTMLElement)) {
      this.root.remove();
    } else {
      this.dropStaleControls(row);
      this.place(row);
    }
    this.observe();
    this.scheduleCheck();
  }

  destroy(): void {
    this.clearCheck();
    this.stopObserving();
    this.currentGroupId = null;
    this.root.remove();
  }

  /** In the row, before the first ChatGoose control that sorts after this
   * one. Moves only when the element is missing or out of order. */
  private place(row: HTMLElement): void {
    const order = this.options.order;
    const controls = [...row.children].filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && child.dataset.chatgooseRowOrder !== undefined,
    );
    const orders = controls.map((child) => Number(child.dataset.chatgooseRowOrder));
    const ordered = orders.every((value, index) => index === 0 || orders[index - 1]! < value);
    if (this.root.parentElement === row && ordered) {
      return;
    }
    const next = controls.find(
      (child) => child !== this.root && Number(child.dataset.chatgooseRowOrder) > order,
    ) ?? null;
    row.insertBefore(this.root, next);
  }

  /** An extension update leaves the previous instance's control in a header
   * Fansly keeps reusing, frozen on whatever fan it last showed. Once per row:
   * a second look could only ever meet a control that is alive. */
  private dropStaleControls(row: HTMLElement): void {
    if (this.cleanedRows.has(row)) {
      return;
    }
    this.cleanedRows.add(row);
    for (const stale of row.querySelectorAll(`.${this.options.className}`)) {
      if (stale !== this.root) {
        stale.remove();
      }
    }
  }

  private observe(): void {
    const routeRoot = document.querySelector(ROUTE_ROOT_SELECTOR);
    const target = routeRoot instanceof HTMLElement
      ? routeRoot.parentElement ?? routeRoot
      : null;
    if (target === this.observedRoot && target?.isConnected) {
      return;
    }
    this.stopObserving();
    if (!target) {
      return;
    }

    let timer: number | null = null;
    const observer = new MutationObserver((records) => {
      // Our own re-render lives in the observed subtree and changes nothing
      // about where the element belongs.
      if (timer !== null || records.every(({ target: node }) => this.root.contains(node))) {
        return;
      }
      timer = window.setTimeout(() => {
        timer = null;
        this.sync();
      }, 0);
    });
    // Angular repaints a reused header by rewriting text nodes in place.
    observer.observe(target, { childList: true, characterData: true, subtree: true });
    this.observedRoot = target;
    this.stopObserver = () => {
      observer.disconnect();
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }

  private stopObserving(): void {
    this.stopObserver?.();
    this.stopObserver = null;
    this.observedRoot = null;
  }

  /** The next look at the page without waiting for a mutation. Fast while the
   * header is missing inside the attach window (the chat is still rendering);
   * otherwise a slow keep-alive, for a subtree Fansly swaps out from above the
   * observed one. */
  private scheduleCheck(): void {
    if (this.root.isConnected) {
      this.attachDeadlineMs = null;
    } else {
      this.attachDeadlineMs ??= Date.now() + CONVERSATION_ATTACH_TIMEOUT_MS;
    }
    const waiting = this.attachDeadlineMs !== null && Date.now() < this.attachDeadlineMs;
    this.checkTimer = window.setTimeout(() => {
      this.checkTimer = null;
      this.sync();
    }, waiting ? CONVERSATION_ATTACH_RETRY_MS : CONVERSATION_ATTACH_SLOW_RETRY_MS);
  }

  private clearCheck(): void {
    if (this.checkTimer !== null) {
      window.clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }
}
