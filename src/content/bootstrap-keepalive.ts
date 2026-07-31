const BOOTSTRAP_PORT_RECONNECT_DELAYS_MS = [100, 500, 1_000, 5_000] as const;

interface BootstrapKeepaliveDependencies {
  connect: () => browser.runtime.Port;
  setTimeout: (callback: () => void, delayMs: number) => number;
  clearTimeout: (timerId: number) => void;
}

export interface BootstrapKeepalive {
  handOff: () => void;
}

/**
 * Keep the MV3 worker alive while only the lightweight global shell is loaded.
 *
 * The returned handoff is terminal: it closes the bootstrap port and prevents
 * both an already-scheduled retry and a late disconnect event from reopening
 * one after the full content application's operational port has taken over.
 */
export function startBootstrapKeepalive(
  dependencies: BootstrapKeepaliveDependencies = {
    connect: () => browser.runtime.connect({ name: 'chatgoose-bootstrap' }),
    setTimeout: (callback, delayMs) => window.setTimeout(callback, delayMs),
    clearTimeout: (timerId) => window.clearTimeout(timerId),
  },
): BootstrapKeepalive {
  let port: browser.runtime.Port | null = null;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;
  let handedOff = false;

  const scheduleReconnect = (): void => {
    if (handedOff || reconnectTimer !== null) {
      return;
    }
    const delay = BOOTSTRAP_PORT_RECONNECT_DELAYS_MS[
      Math.min(
        reconnectAttempt,
        BOOTSTRAP_PORT_RECONNECT_DELAYS_MS.length - 1,
      )
    ]!;
    reconnectAttempt += 1;
    reconnectTimer = dependencies.setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  };

  const connect = (): void => {
    if (handedOff || port) {
      return;
    }
    try {
      const nextPort = dependencies.connect();
      port = nextPort;
      reconnectAttempt = 0;
      nextPort.onDisconnect.addListener(() => {
        if (port !== nextPort) {
          return;
        }
        port = null;
        scheduleReconnect();
      });
    } catch {
      scheduleReconnect();
    }
  };

  connect();

  return {
    handOff(): void {
      handedOff = true;
      if (reconnectTimer !== null) {
        dependencies.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const activePort = port;
      port = null;
      activePort?.disconnect();
    },
  };
}
