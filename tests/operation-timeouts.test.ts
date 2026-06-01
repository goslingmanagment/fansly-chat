import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationTimeoutController } from '../src/background/operation-timeouts.js';

describe('OperationTimeoutController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts its signal when an armed timeout expires', () => {
    vi.useFakeTimers();
    const timeouts = new OperationTimeoutController<'total'>();

    timeouts.arm('total', 100);
    expect(timeouts.signal.aborted).toBe(false);

    vi.advanceTimersByTime(100);

    expect(timeouts.signal.aborted).toBe(true);
  });

  it('replaces an existing timeout for the same key', () => {
    vi.useFakeTimers();
    const timeouts = new OperationTimeoutController<'idle'>();

    timeouts.arm('idle', 100);
    timeouts.arm('idle', 500);
    vi.advanceTimersByTime(100);

    expect(timeouts.signal.aborted).toBe(false);

    vi.advanceTimersByTime(400);

    expect(timeouts.signal.aborted).toBe(true);
  });

  it('clears armed timeouts without aborting', () => {
    vi.useFakeTimers();
    const timeouts = new OperationTimeoutController<'prep' | 'stream'>();

    timeouts.arm('prep', 100);
    timeouts.arm('stream', 200);
    timeouts.clearAll();
    vi.advanceTimersByTime(200);

    expect(timeouts.signal.aborted).toBe(false);
  });
});
