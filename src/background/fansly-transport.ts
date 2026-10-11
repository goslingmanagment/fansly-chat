import { FANSLY_REQUEST_TIMEOUT_MS } from '../shared/constants.js';
import { ChatGooseError } from '../shared/errors.js';
import {
  FANSLY_RELAY_PAGE,
  parseFanslyRelayReply,
  type FanslyRelayCommand,
} from '../shared/fansly-relay-protocol.js';
import type { SessionTemplate } from '../shared/types.js';

/** One ready Fansly request: headers, pacing and identity checks are done. */
export interface FanslyWireRequest {
  url: URL;
  method: 'GET' | 'POST';
  headers: Headers;
  body?: string;
  signal: AbortSignal;
}

/** Where a request of one session leaves from. `send` dispatches before it
 * yields, like `fetch`, so the caller's last identity check stays the last
 * thing before the request leaves. */
export interface FanslyRoute {
  /** Set when the request rides a tab's relay frame. */
  tabId?: number;
  send: (request: FanslyWireRequest) => Promise<Response>;
}

export interface FanslyTransport {
  /** Settles the route of a session before its identity check. Throws
   * `fansly_tab_unavailable` when the route is missing; only a read waits for
   * a tab that is still loading its frame. */
  route: (session: SessionTemplate, method: 'GET' | 'POST', signal: AbortSignal) => Promise<FanslyRoute>;
}

/** The extension's own background request. Firefox gives it no tab, so a
 * per-container proxy never applies and it leaves from the chatter's address. */
export const DIRECT_FANSLY_ROUTE: FanslyRoute = {
  send: ({ url, method, headers, body, signal }) =>
    fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), signal, credentials: 'omit' }),
};

export const directFanslyTransport: FanslyTransport = { route: async () => DIRECT_FANSLY_ROUTE };

/** How long a read waits for the frame of a tab that is still loading. */
export const FANSLY_RELAY_WAIT_MS = 5_000;
const BODILESS_STATUS = new Set([204, 205, 304]);

interface PendingReply {
  head: (status: number, headers: Array<[string, string]>) => void;
  body: (text: string) => void;
  fail: (error: unknown) => void;
}

interface Relay {
  port: browser.runtime.Port;
  pending: Map<string, PendingReply>;
}

interface RelayHubDependencies {
  extensionId: string;
  relayUrl: string;
}

/** E149: the relay frames of «Fansly через вкладку», one per Fansly tab.
 * A frame's request is attributed by Firefox to its tab and container, so the
 * container's proxy carries it — the page's own address, not the chatter's. */
export class FanslyRelayHub {
  /** Live frames per tab, oldest first. A second frame never evicts the first:
   * evicting would make the evicted frame reconnect and evict back, forever. */
  private readonly relays = new Map<number, Relay[]>();
  private readonly waiters = new Set<() => void>();
  private lastId = 0;

  constructor(private readonly dependencies: RelayHubDependencies) {}

  /** Only our relay page, framed inside a tab, is taken. New requests go to the
   * newest frame of a tab; an older one finishes what it holds. */
  register(port: browser.runtime.Port): void {
    const sender = port.sender;
    const tabId = sender?.tab?.id;
    if (tabId === undefined || sender?.id !== this.dependencies.extensionId || !sender.frameId || sender.url !== this.dependencies.relayUrl) {
      port.disconnect();
      return;
    }
    const relay: Relay = { port, pending: new Map() };
    this.relays.set(tabId, [...(this.relays.get(tabId) ?? []), relay]);
    port.onMessage.addListener((raw: unknown) => {
      const reply = parseFanslyRelayReply(raw);
      const pending = reply ? relay.pending.get(reply.id) : undefined;
      if (!reply || !pending) return;
      if (reply.type === 'head') pending.head(reply.status, reply.headers);
      else if (reply.type === 'body') pending.body(reply.body);
      else pending.fail(new TypeError('Fansly relay request failed'));
    });
    port.onDisconnect.addListener(() => {
      const rest = (this.relays.get(tabId) ?? []).filter((entry) => entry !== relay);
      if (rest.length) this.relays.set(tabId, rest);
      else this.relays.delete(tabId);
      this.fail(relay);
    });
    for (const wake of [...this.waiters]) wake();
  }

  /** A frame that went away answers nothing: its requests end like a dropped
   * connection, so a dispatched write stays unconfirmed for its caller. */
  private fail(relay: Relay): void {
    for (const pending of [...relay.pending.values()]) pending.fail(new TypeError('Fansly relay frame disconnected'));
  }

  private pick(tabIds: readonly number[]): [number, Relay] | null {
    for (const tabId of tabIds) {
      const relay = this.relays.get(tabId)?.at(-1);
      if (relay) return [tabId, relay];
    }
    return null;
  }

  private ready(tabIds: () => readonly number[], signal: AbortSignal, wait: boolean): Promise<[number, Relay]> {
    const tabs = tabIds();
    const found = this.pick(tabs);
    if (found) return Promise.resolve(found);
    // No tab holds this session, or a write: there is nothing to wait for.
    if (!wait || tabs.length === 0) return Promise.reject(new ChatGooseError('fansly_tab_unavailable'));
    return new Promise((resolve, reject) => {
      const finish = (settle: () => void): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.waiters.delete(onConnect);
        settle();
      };
      const onConnect = (): void => {
        const next = this.pick(tabIds());
        if (next) finish(() => resolve(next));
      };
      const onAbort = (): void => finish(() => reject(signal.reason));
      const timer = setTimeout(() => finish(() => reject(new ChatGooseError('fansly_tab_unavailable'))), FANSLY_RELAY_WAIT_MS);
      this.waiters.add(onConnect);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** The frame of one of `tabIds` as a route. Only a read waits for a frame;
   * a write goes now or not at all. */
  async route(tabIds: () => readonly number[], method: 'GET' | 'POST', signal: AbortSignal): Promise<FanslyRoute> {
    signal.throwIfAborted();
    const [tabId, relay] = await this.ready(tabIds, signal, method === 'GET');
    return { tabId, send: (request) => this.dispatch(relay, request) };
  }

  /** Answers like `fetch`: the response settles on the status and headers, its
   * body arrives after them; no answer is a TypeError; an abort is the
   * signal's reason, on the response or on its unread body. The command is
   * posted before this returns. */
  private dispatch(relay: Relay, request: FanslyWireRequest): Promise<Response> {
    const { signal } = request;
    if (signal.aborted) return Promise.reject(signal.reason);
    const id = String(++this.lastId);
    return new Promise<Response>((resolve, reject) => {
      let body: ReadableStreamDefaultController<Uint8Array> | null = null;
      let bodyTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        clearTimeout(bodyTimer);
        relay.pending.delete(id);
        signal.removeEventListener('abort', onAbort);
      };
      const fail = (error: unknown): void => {
        finish();
        if (!body) {
          reject(error);
          return;
        }
        try {
          body.error(error);
        } catch {
          // the body was already complete
        }
      };
      const post = (command: FanslyRelayCommand): void => relay.port.postMessage(command);
      const abortInFrame = (): void => {
        try {
          post({ type: 'abort', id });
        } catch {
          // the frame is already gone; its request died with it
        }
      };
      const onAbort = (): void => {
        abortInFrame();
        fail(signal.reason);
      };
      relay.pending.set(id, {
        head: (status, headers) => {
          if (body) return;
          const bodiless = BODILESS_STATUS.has(status);
          const stream = bodiless ? null : new ReadableStream<Uint8Array>({
            start: (controller) => {
              body = controller;
            },
            // A caller done with the status lets the frame stop reading.
            cancel: () => {
              abortInFrame();
              finish();
            },
          });
          let response: Response;
          try {
            response = new Response(stream, { status, headers });
          } catch {
            body = null;
            fail(new TypeError('Fansly relay returned an unusable response'));
            return;
          }
          if (bodiless) {
            finish();
          } else {
            // A caller that acts on the status alone (401, 429, a retry) never
            // reads the body and clears its own timeout: a body that stalls
            // must not hold the frame's request for the rest of the shift.
            bodyTimer = setTimeout(() => {
              abortInFrame();
              fail(new DOMException('The operation timed out.', 'TimeoutError'));
            }, FANSLY_REQUEST_TIMEOUT_MS);
          }
          resolve(response);
        },
        body: (text) => {
          if (!body) return;
          body.enqueue(new TextEncoder().encode(text));
          body.close();
          finish();
        },
        fail,
      });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        post({
          type: 'request',
          id,
          method: request.method,
          url: request.url.toString(),
          headers: [...request.headers],
          ...(request.body !== undefined ? { body: request.body } : {}),
        });
      } catch {
        fail(new TypeError('Fansly relay frame disconnected'));
      }
    });
  }
}

export function createFanslyRelayHub(): FanslyRelayHub {
  return new FanslyRelayHub({
    extensionId: browser.runtime.id,
    relayUrl: browser.runtime.getURL(FANSLY_RELAY_PAGE),
  });
}

interface FanslyTransportOptions {
  /** The chatter's «Fansly через вкладку» switch, read at each request. */
  viaTab: () => Promise<boolean>;
  /** Tabs whose captured session is this one, in no particular order. */
  tabsFor: (session: SessionTemplate) => readonly number[];
  relays: Pick<FanslyRelayHub, 'route'>;
}

/** Off (the default) keeps the background request. On, the request rides the
 * frame of a tab that holds the same session and never falls back to the
 * direct route: that route is the one this mode exists to avoid. */
export function createFanslyTransport(options: FanslyTransportOptions): FanslyTransport {
  return {
    route: async (session, method, signal) => {
      let viaTab = false;
      try {
        viaTab = await options.viaTab();
      } catch {
        // unreadable settings keep the route every install has had so far
      }
      return viaTab ? options.relays.route(() => options.tabsFor(session), method, signal) : DIRECT_FANSLY_ROUTE;
    },
  };
}
