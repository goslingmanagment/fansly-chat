import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationProfiler } from '../src/background/operation-profiling.js';

let currentNow = 1_700_000_000_000;

function advanceNow(ms: number): number {
  currentNow += ms;
  return currentNow;
}

describe('createOperationProfiler', () => {
  beforeEach(() => {
    currentNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => currentNow);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns a no-op profiler when disabled', () => {
    const profiler = createOperationProfiler(false);

    profiler.log('ignored');
    profiler.startStage('resolve-identity', 'Resolve account identity');
    profiler.completeStage('resolve-identity', 'done');

    expect(profiler.enabled).toBe(false);
    expect(profiler.snapshot()).toBeUndefined();
  });

  it('records log entries and stage durations from Date.now', () => {
    const profiler = createOperationProfiler(true);

    profiler.startStage('resolve-identity', 'Resolve account identity');
    profiler.log('Resolve account identity');
    advanceNow(125);
    profiler.completeStage('resolve-identity', 'resolved account-1');

    const snapshot = profiler.snapshot();
    expect(snapshot).toMatchObject({
      elapsedMs: 125,
      activeLabel: null,
      logEntries: [{ elapsedMs: 0, message: 'Resolve account identity' }],
    });
    expect(snapshot?.stages).toEqual([
      expect.objectContaining({
        key: 'resolve-identity',
        status: 'completed',
        startedElapsedMs: 0,
        endedElapsedMs: 125,
        durationMs: 125,
        detail: 'resolved account-1',
      }),
    ]);
  });

  it('joins active labels for concurrent running stages', () => {
    const profiler = createOperationProfiler(true);

    profiler.startStage('earnings', 'Fetch earnings');
    advanceNow(10);
    profiler.startStage('subscription-lookup', 'Lookup subscription');

    expect(profiler.snapshot()?.activeLabel).toBe(
      'Fetch earnings + Lookup subscription',
    );
  });

  it('marks unfinished stages as failed during finalization', () => {
    const profiler = createOperationProfiler(true);

    profiler.startStage('claude-ttfb', 'Wait for Claude TTFB');
    advanceNow(220);
    const snapshot = profiler.finalizeRunningStages('operation failed');

    expect(snapshot?.stages).toEqual([
      expect.objectContaining({
        key: 'claude-ttfb',
        status: 'failed',
        durationMs: 220,
        detail: 'operation failed',
      }),
    ]);
  });

  it('records skipped stages without leaving them active', () => {
    const profiler = createOperationProfiler(true);

    profiler.skipStage(
      'account-name-lookup',
      'Resolve fan display name',
      'fan account unavailable',
    );

    expect(profiler.snapshot()).toMatchObject({
      activeLabel: null,
      stages: [
        expect.objectContaining({
          key: 'account-name-lookup',
          status: 'skipped',
          durationMs: 0,
          detail: 'fan account unavailable',
        }),
      ],
    });
  });
});
