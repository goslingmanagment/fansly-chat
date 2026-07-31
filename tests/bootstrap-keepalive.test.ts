import { describe, expect, it, vi } from 'vitest';
import { startBootstrapKeepalive } from '../src/content/bootstrap-keepalive.js';
import { createMockRuntimePort } from './helpers/port.js';

function createTimers() {
  let nextTimerId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    setTimeout: vi.fn((callback: () => void, _delayMs: number) => {
      const timerId = nextTimerId++;
      callbacks.set(timerId, callback);
      return timerId;
    }),
    clearTimeout: vi.fn((timerId: number) => {
      callbacks.delete(timerId);
    }),
    run(timerId: number): void {
      const callback = callbacks.get(timerId);
      callbacks.delete(timerId);
      callback?.();
    },
    get(timerId: number): (() => void) | undefined {
      return callbacks.get(timerId);
    },
  };
}

describe('bootstrap keepalive lifecycle', () => {
  it('reconnects after a dropped bootstrap port', () => {
    const firstPort = createMockRuntimePort(1);
    const secondPort = createMockRuntimePort(1);
    const connect = vi.fn()
      .mockReturnValueOnce(firstPort)
      .mockReturnValueOnce(secondPort);
    const timers = createTimers();

    startBootstrapKeepalive({
      connect: connect as () => browser.runtime.Port,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    firstPort.emitDisconnect();
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 100);

    timers.run(1);
    expect(connect).toHaveBeenCalledTimes(2);

    // A duplicate/late event from the superseded port cannot schedule another
    // connection over the new live port.
    firstPort.emitDisconnect();
    expect(timers.setTimeout).toHaveBeenCalledTimes(1);
  });

  it('retries when runtime.connect throws synchronously', () => {
    const port = createMockRuntimePort(1);
    const connect = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('background unavailable');
      })
      .mockReturnValueOnce(port);
    const timers = createTimers();

    startBootstrapKeepalive({
      connect: connect as () => browser.runtime.Port,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    timers.run(1);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(port.onDisconnect.addListener).toHaveBeenCalledTimes(1);
  });

  it('backs off repeated connect failures, caps them, and resets after success', () => {
    const recoveredPort = createMockRuntimePort(1);
    let fail = true;
    const connect = vi.fn(() => {
      if (fail) {
        throw new Error('extension context unavailable');
      }
      return recoveredPort as unknown as browser.runtime.Port;
    });
    const timers = createTimers();

    startBootstrapKeepalive({
      connect,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    timers.run(1);
    timers.run(2);
    timers.run(3);
    timers.run(4);

    expect(timers.setTimeout.mock.calls.map(([, delay]) => delay))
      .toEqual([100, 500, 1_000, 5_000, 5_000]);

    fail = false;
    timers.run(5);
    recoveredPort.emitDisconnect();

    expect(timers.setTimeout.mock.calls.at(-1)?.[1]).toBe(100);
  });

  it('makes handoff terminal for active and already-scheduled connections', () => {
    const firstPort = createMockRuntimePort(1);
    firstPort.disconnect.mockImplementation(() => firstPort.emitDisconnect());
    const connect = vi.fn(() => firstPort as unknown as browser.runtime.Port);
    const activeTimers = createTimers();
    const active = startBootstrapKeepalive({
      connect,
      setTimeout: activeTimers.setTimeout,
      clearTimeout: activeTimers.clearTimeout,
    });

    active.handOff();

    expect(firstPort.disconnect).toHaveBeenCalledTimes(1);
    expect(activeTimers.setTimeout).not.toHaveBeenCalled();

    const droppedPort = createMockRuntimePort(1);
    const pendingConnect = vi.fn(
      () => droppedPort as unknown as browser.runtime.Port,
    );
    const pendingTimers = createTimers();
    const pending = startBootstrapKeepalive({
      connect: pendingConnect,
      setTimeout: pendingTimers.setTimeout,
      clearTimeout: pendingTimers.clearTimeout,
    });
    droppedPort.emitDisconnect();
    const scheduledRetry = pendingTimers.setTimeout.mock.results[0]?.value as number;
    const lateRetry = pendingTimers.get(scheduledRetry);

    pending.handOff();
    // Even if a host races and delivers the cleared callback, the terminal flag
    // remains the final guard against reopening the bootstrap port.
    lateRetry?.();

    expect(pendingTimers.clearTimeout).toHaveBeenCalledWith(scheduledRetry);
    expect(pendingConnect).toHaveBeenCalledTimes(1);
  });
});
