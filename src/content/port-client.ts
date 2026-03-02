import { PORT_RECONNECT_DELAYS_MS } from '../shared/constants.js';
import type { BackgroundPortMessage, ContentPortMessage } from '../shared/types.js';

interface PortClientCallbacks {
  onMessage: (message: BackgroundPortMessage) => void;
  onDisconnected: () => void;
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

    this.port = browser.runtime.connect({ name: 'chatmuse-content' });
    this.port.onMessage.addListener((message) => {
      this.callbacks.onMessage(message as BackgroundPortMessage);
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

  send(message: ContentPortMessage): void {
    if (message.type === 'tab:init') {
      this.lastInit = message;
    } else if (message.type === 'tab:routeChanged' && this.lastInit) {
      this.lastInit = {
        ...this.lastInit,
        groupId: message.groupId,
        routeNonce: message.routeNonce,
      };
    }
    this.port?.postMessage(message);
  }
}
