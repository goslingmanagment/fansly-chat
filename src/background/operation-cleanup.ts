export interface FlushTimerState {
  flushTimer: number | null;
}

export function clearFlushTimer(state: FlushTimerState): boolean {
  if (state.flushTimer === null) {
    return false;
  }

  globalThis.clearTimeout(state.flushTimer);
  state.flushTimer = null;
  return true;
}

export function clearFlushTimers(states: Iterable<FlushTimerState>): void {
  for (const state of states) {
    clearFlushTimer(state);
  }
}
