// E145: MAIN-world `document_start` script. A passive listener on the Fansly
// page's OWN wsv3 socket — no connection, request or frame of ours.
//
// Fansly creates the socket with the global constructor on every (re)connect:
// `this.con_ = new WebSocket(this.uri_)`, then `binaryType` and `on*`
// assignments (main.51b59e98940f00c0.js, `setUpConnection`). A Proxy over
// `window.WebSocket` hands back the NATIVE object from exactly one
// `Reflect.construct`, so `instanceof`, the static constants, `prototype`,
// `send`, `close` and every `on*` behave as before; a constructor exception
// reaches the page untouched. We only add `addEventListener` listeners, each
// fully guarded — nothing of ours may break the page's socket.
//
// No `browser.*` exists in this world; results go to the isolated relay as
// CustomEvents carrying JSON strings (see message-sound-protocol.ts).

import { extractIncomingMessages } from '../shared/fansly-ws-frame.js';
import {
  SOUND_BRIDGE_ARM_EVENT,
  SOUND_BRIDGE_MESSAGE_EVENT,
  SOUND_BRIDGE_RELAY_READY_EVENT,
  SOUND_BRIDGE_TAP_EVENT,
  type FanslySocketState,
  type SocketTapStatus,
} from '../shared/message-sound-protocol.js';

const INSTALLED = Symbol.for('chatgoose.socketTap');
const FANSLY_SOCKET_HOST = 'wsv3.fansly.com';
/** The frame counters reach «Статус» at most this often. */
export const TAP_STATS_INTERVAL_MS = 5_000;

function isFanslyMessageSocket(url: unknown, base: string): boolean {
  try {
    const parsed = new URL(String(url), base);
    return parsed.protocol === 'wss:' && parsed.hostname === FANSLY_SOCKET_HOST;
  } catch {
    return false;
  }
}

export function installPageSocketTap(target: Window & typeof globalThis = window): boolean {
  const flagged = target as unknown as Record<symbol, unknown>;
  if (flagged[INSTALLED]) return false;
  const Native = target.WebSocket;
  if (typeof Native !== 'function') return false;
  Object.defineProperty(target, INSTALLED, { value: true });

  // Captured NOW, at document_start, before Fansly's zone.js patches it: a
  // listener registered through the patched method would run inside Angular's
  // zone and cost the page an extra change-detection pass on every frame.
  const addListener = target.EventTarget.prototype.addEventListener;
  const listen = (node: EventTarget, type: string, listener: (event: Event) => void): void => {
    addListener.call(node, type, listener);
  };

  let armed = true;
  let socket: FanslySocketState = 'none';
  /** Only the newest socket's lifecycle is reported: Fansly closes the old one
   * right before creating the next, and its late `close` must not mask the
   * new socket's `open`. */
  let current: WebSocket | null = null;
  let lastStatsAt = Number.NEGATIVE_INFINITY;
  const stats = { framesSeen: 0, messagesParsed: 0, droppedByType: 0 };

  const emit = (name: string, payload: unknown): void => {
    try {
      target.dispatchEvent(new target.CustomEvent(name, { detail: JSON.stringify(payload) }));
    } catch {
      // never let the bridge reach the page
    }
  };
  const report = (): void => {
    lastStatsAt = Date.now();
    const status: SocketTapStatus = { v: 1, socket, ...stats };
    emit(SOUND_BRIDGE_TAP_EVENT, status);
  };

  const observe = (instance: WebSocket): void => {
    current = instance;
    socket = 'connecting';
    report();
    listen(instance, 'open', () => {
      if (current !== instance) return;
      socket = 'open';
      report();
    });
    listen(instance, 'close', () => {
      if (current !== instance) return;
      socket = 'closed';
      report();
    });
    listen(instance, 'message', (event: Event) => {
      if (!armed) return;
      try {
        const data: unknown = (event as MessageEvent).data;
        if (typeof data !== 'string') return;
        stats.framesSeen += 1;
        const parsed = extractIncomingMessages(data);
        stats.droppedByType += parsed.droppedByType;
        for (const message of parsed.messages) {
          stats.messagesParsed += 1;
          emit(SOUND_BRIDGE_MESSAGE_EVENT, message);
        }
        // «frames seen, none parsed» is how a changed Fansly format shows up.
        if (Date.now() - lastStatsAt >= TAP_STATS_INTERVAL_MS) report();
      } catch {
        // the page's own handler already has the frame
      }
    });
  };

  target.WebSocket = new Proxy(Native, {
    construct(constructor, args: unknown[], newTarget) {
      const instance = Reflect.construct(constructor, args, newTarget) as WebSocket;
      try {
        if (isFanslyMessageSocket(args[0], target.location.href)) observe(instance);
      } catch {
        // observation is optional; the socket is not
      }
      return instance;
    },
  });

  listen(target, SOUND_BRIDGE_RELAY_READY_EVENT, () => report());
  listen(target, SOUND_BRIDGE_ARM_EVENT, (event: Event) => {
    const detail: unknown = (event as CustomEvent).detail;
    if (detail === 'on') armed = true;
    else if (detail === 'off') armed = false;
  });
  report();
  return true;
}

if (typeof window !== 'undefined') installPageSocketTap();
