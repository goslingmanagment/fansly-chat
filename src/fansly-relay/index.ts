// E149: the relay frame of «Fansly через вкладку». An extension page mounted
// inside the Fansly tab; it holds no session and decides nothing. The
// background hands it one ready request at a time over a port, it performs the
// fetch with the extension's own privileges and hands the answer back.

import {
  FANSLY_RELAY_PORT_NAME,
  FANSLY_RELAY_RESPONSE_HEADERS,
  parseFanslyRelayCommand,
  type FanslyRelayReply,
  type FanslyRelayRequest,
} from '../shared/fansly-relay-protocol.js';

const RECONNECT_DELAYS_MS = [100, 500, 1_000, 5_000] as const;
/** A port that lived this long was accepted: the next reconnect starts over. */
const SETTLED_AFTER_MS = 5_000;

export interface FanslyRelayDependencies {
  connect: () => browser.runtime.Port;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  setTimeout: (callback: () => void, delayMs: number) => unknown;
  now: () => number;
}

export function startFanslyRelay(dependencies: FanslyRelayDependencies): void {
  let attempt = 0;

  const retry = (): void => {
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    attempt += 1;
    dependencies.setTimeout(connect, delay);
  };

  function connect(): void {
    let port: browser.runtime.Port;
    try {
      port = dependencies.connect();
    } catch {
      retry();
      return;
    }
    const connectedAt = dependencies.now();
    const inflight = new Map<string, AbortController>();
    const reply = (message: FanslyRelayReply): void => {
      try {
        port.postMessage(message);
      } catch {
        // the background is gone and nobody waits for this answer
      }
    };

    const run = async (request: FanslyRelayRequest): Promise<void> => {
      const controller = new AbortController();
      inflight.set(request.id, controller);
      try {
        const response = await dependencies.fetch(request.url, {
          method: request.method,
          headers: request.headers,
          ...(request.body !== undefined ? { body: request.body } : {}),
          credentials: 'omit',
          signal: controller.signal,
        });
        const body = await response.text();
        reply({
          type: 'response',
          id: request.id,
          status: response.status,
          headers: FANSLY_RELAY_RESPONSE_HEADERS.flatMap((name): Array<[string, string]> => {
            const value = response.headers.get(name);
            return value === null ? [] : [[name, value]];
          }),
          body,
        });
      } catch {
        reply({ type: 'failure', id: request.id, aborted: controller.signal.aborted });
      } finally {
        inflight.delete(request.id);
      }
    };

    port.onMessage.addListener((raw: unknown) => {
      const command = parseFanslyRelayCommand(raw);
      if (!command) return;
      if (command.type === 'abort') {
        inflight.get(command.id)?.abort();
      } else if (!inflight.has(command.id)) {
        void run(command);
      }
    });
    port.onDisconnect.addListener(() => {
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
      if (dependencies.now() - connectedAt >= SETTLED_AFTER_MS) attempt = 0;
      retry();
    });
  }

  connect();
}

// Only as a frame: opened on its own, the page has no tab to lend.
if (typeof browser !== 'undefined' && typeof window !== 'undefined' && window.top !== window) {
  startFanslyRelay({
    connect: () => browser.runtime.connect({ name: FANSLY_RELAY_PORT_NAME }),
    fetch: (url, init) => fetch(url, init),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    now: () => Date.now(),
  });
}
