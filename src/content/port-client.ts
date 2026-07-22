import { PORT_RECONNECT_DELAYS_MS } from '../shared/constants.js';
import { isBackgroundPortMessage } from '../shared/protocol.js';
import type { BackgroundPortMessage, ContentPortMessage } from '../shared/types.js';

interface PortClientCallbacks {
  onMessage: (message: BackgroundPortMessage) => void;
  onDisconnected: () => void;
  onConnected?: () => void;
}

export class PortClient {
  private port: browser.runtime.Port | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private lastInit: Extract<ContentPortMessage, { type: 'tab:init' }> | null = null;

  constructor(private readonly callbacks: PortClientCallbacks) {}

  connect(): void {
    if (this.port) {
      return;
    }

    this.port = browser.runtime.connect({ name: 'chatgoose-content' });
    this.port.onMessage.addListener((message) => {
      if (isBackgroundPortMessage(message)) {
        this.callbacks.onMessage(message);
      }
    });
    this.port.onDisconnect.addListener(() => {
      this.port = null;
      this.callbacks.onDisconnected();
      this.scheduleReconnect();
    });

    this.reconnectAttempt = 0;
    if (this.lastInit) {
      this.send(this.lastInit);
    }
    this.callbacks.onConnected?.();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) {
      return;
    }
    const delay = PORT_RECONNECT_DELAYS_MS[
      Math.min(this.reconnectAttempt, PORT_RECONNECT_DELAYS_MS.length - 1)
    ]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Posts a message to the background port. Returns false when the port is
   * disconnected (mid-reconnect) and the message was dropped. tab:init/
   * tab:routeChanged are persisted in lastInit and replayed on reconnect, so a
   * dropped one is recovered; other messages (operation:start, compare:start,
   * cancels) are lost, and the caller must handle the false return.
   */
  send(message: ContentPortMessage): boolean {
    if (message.type === 'tab:init') {
      this.lastInit = message;
    } else if (message.type === 'tab:routeChanged' && this.lastInit) {
      this.lastInit = {
        ...this.lastInit,
        groupId: message.groupId,
        routeNonce: message.routeNonce,
      };
    }
    if (!this.port) {
      return false;
    }
    try {
      this.port.postMessage(message);
    } catch {
      // A dead port whose disconnect event has not been delivered yet throws
      // («Attempt to postMessage on disconnected port»). The contract of this
      // method is «false = the start never reached the background» — every
      // caller already handles that honestly, so the throw window must map to
      // the same outcome for ALL dispatch sites (review round 14: only
      // sendCoachTurn had its own belt-and-braces catch; startCoachRecapChain
      // armed the chain and leaked the exception into a menu click handler).
      return false;
    }
    return true;
  }
}
