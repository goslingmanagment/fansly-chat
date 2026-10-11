import { ChatGooseError } from '../shared/errors.js';
import {
  FANSLY_RELAY_PAGE,
  parseFanslyRelayReply,
  type FanslyRelayCommand,
} from '../shared/fansly-relay-protocol.js';
import type { SessionTemplate } from '../shared/types.js';

/** One ready Fansly request: headers, pacing and identity checks are done. */
export interface FanslyTransportRequest {
  url: URL;
  method: 'GET' | 'POST';
  headers: Headers;
  body?: string;
  signal: AbortSignal;
  session: SessionTemplate;
  /** Called before dispatch when the request leaves through a tab's relay. */
  onTabRoute?: (tabId: number) => void;
}

export interface FanslyTransport {
  (request: FanslyTransportRequest): Promise<Response>;
  /** Settles when a request of this session could leave right now; throws
   * `fansly_tab_unavailable` when its route is missing. A write checks this
   * before taking custody, so a missing route is never an unconfirmed send. */
  ready?: (session: SessionTemplate, signal: AbortSignal) => Promise<void>;
}

/** The extension's own background request. Firefox gives it no tab, so a
 * per-container proxy never applies and it leaves from the chatter's address. */
export const directFanslyTransport: FanslyTransport = ({ url, method, headers, body, signal }) =>
  fetch(url, { method, headers, ...(body !== undefined ? { body } : {}), signal, credentials: 'omit' });

/** How long a read waits for the frame of a tab that is still loading. */
export const FANSLY_RELAY_WAIT_MS = 5_000;
const BODILESS_STATUS = new Set([204, 205, 304]);

interface PendingReply {
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
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
  private readonly relays = new Map<number, Relay>();
  private readonly waiters = new Set<() => void>();
  private lastId = 0;

  constructor(private readonly dependencies: RelayHubDependencies) {}

  /** Only our relay page, framed inside a tab, is taken; the newest frame of a
   * tab replaces the previous one. */
  register(port: browser.runtime.Port): void {
    const sender = port.sender;
    const tabId = sender?.tab?.id;
    if (tabId === undefined || sender?.id !== this.dependencies.extensionId || !sender.frameId || sender.url !== this.dependencies.relayUrl) {
      port.disconnect();
      return;
    }
    const relay: Relay = { port, pending: new Map() };
    const previous = this.relays.get(tabId);
    this.relays.set(tabId, relay);
    if (previous) {
      this.fail(previous);
      previous.port.disconnect();
    }
    port.onMessage.addListener((raw: unknown) => {
      const reply = parseFanslyRelayReply(raw);
      const pending = reply ? relay.pending.get(reply.id) : undefined;
      if (!reply || !pending) return;
      if (reply.type === 'failure') {
        pending.reject(new TypeError('Fansly relay request failed'));
        return;
      }
      try {
        pending.resolve(new Response(BODILESS_STATUS.has(reply.status) ? null : reply.body, { status: reply.status, headers: reply.headers }));
      } catch {
        pending.reject(new TypeError('Fansly relay returned an unusable response'));
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.relays.get(tabId) === relay) this.relays.delete(tabId);
      this.fail(relay);
    });
    for (const wake of [...this.waiters]) wake();
  }

  /** A frame that went away answers nothing: its requests end like a dropped
   * connection, so a dispatched write stays unconfirmed for its caller. */
  private fail(relay: Relay): void {
    for (const pending of [...relay.pending.values()]) pending.reject(new TypeError('Fansly relay frame disconnected'));
  }

  private pick(tabIds: readonly number[]): [number, Relay] | null {
    for (const tabId of tabIds) {
      const relay = this.relays.get(tabId);
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

  /** Settles once one of `tabIds` has a frame, waiting as long as a read would. */
  async whenReady(tabIds: () => readonly number[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.ready(tabIds, signal, true);
  }

  /** Sends through the frame of one of `tabIds`. Answers like `fetch`: an HTTP
   * status is a Response, no answer is a TypeError, an abort is the signal's
   * reason. Only a read waits for a frame; a write goes now or not at all. */
  async send(tabIds: () => readonly number[], request: Omit<FanslyTransportRequest, 'session'>): Promise<Response> {
    const { signal } = request;
    signal.throwIfAborted();
    const [tabId, relay] = await this.ready(tabIds, signal, request.method === 'GET');
    signal.throwIfAborted();
    request.onTabRoute?.(tabId);
    const id = String(++this.lastId);
    return new Promise<Response>((resolve, reject) => {
      const finish = (settle: () => void): void => {
        relay.pending.delete(id);
        signal.removeEventListener('abort', onAbort);
        settle();
      };
      const post = (command: FanslyRelayCommand): void => relay.port.postMessage(command);
      const onAbort = (): void => {
        try {
          post({ type: 'abort', id });
        } catch {
          // the frame is already gone; its request died with it
        }
        finish(() => reject(signal.reason));
      };
      relay.pending.set(id, {
        resolve: (response) => finish(() => resolve(response)),
        reject: (error) => finish(() => reject(error)),
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
        finish(() => reject(new TypeError('Fansly relay frame disconnected')));
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
  relays: Pick<FanslyRelayHub, 'send' | 'whenReady'>;
}

/** Off (the default) keeps the background request. On, the request rides the
 * frame of a tab that holds the same session and never falls back to the
 * direct route: that route is the one this mode exists to avoid. */
export function createFanslyTransport(options: FanslyTransportOptions): FanslyTransport {
  const viaTab = async (): Promise<boolean> => {
    try {
      return await options.viaTab();
    } catch {
      // unreadable settings keep the route every install has had so far
      return false;
    }
  };
  const transport: FanslyTransport = async (request) => {
    if (!await viaTab()) return directFanslyTransport(request);
    const { session, ...wire } = request;
    return options.relays.send(() => options.tabsFor(session), wire);
  };
  transport.ready = async (session, signal) => {
    if (await viaTab()) await options.relays.whenReady(() => options.tabsFor(session), signal);
  };
  return transport;
}
