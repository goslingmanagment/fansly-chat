import type { TraceScope } from './followers-trace.js';

interface Lane {
  tail: Promise<void>;
  pending: number;
  nextAt: number;
  nextHistoryAt: number;
  cooldownUntil: number;
  intervalMs: number;
  limits: number;
  usedAt: number;
}

/** Only follower-owned GETs use this queue. All their windows share a creator
 * lane, independently of debug mode. A permit covers one HTTP attempt, never
 * an entire scan or a POST. Server-requested waits are never shortened. */
export class FollowerReadScheduler {
  private readonly lanes = new Map<string, Lane>();

  status(creatorId: string): { cooldownUntil: number; intervalMs: number } | undefined {
    const lane = this.lanes.get(creatorId);
    return lane ? { cooldownUntil: lane.cooldownUntil, intervalMs: lane.intervalMs } : undefined;
  }

  async acquire(creatorId: string, history: boolean, signal: AbortSignal, trace?: TraceScope): Promise<{
    release: () => void;
    limited: (retryAfterMs?: number) => number;
  }> {
    signal.throwIfAborted();
    for (const [id, value] of this.lanes) {
      if (!value.pending && Math.max(value.usedAt + 900_000, value.cooldownUntil) < Date.now()) this.lanes.delete(id);
    }
    let lane = this.lanes.get(creatorId);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0, nextAt: 0, nextHistoryAt: 0, cooldownUntil: 0, intervalMs: 1000, limits: 0, usedAt: Date.now() };
      this.lanes.set(creatorId, lane);
    }
    const current = lane;
    const previous = current.tail;
    let unlock!: () => void;
    current.tail = new Promise<void>((resolve) => { unlock = resolve; });
    current.pending++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.pending--; current.usedAt = Date.now();
      // A cancelled waiter must not let its successor overtake the owner.
      void previous.then(unlock);
    };
    const scope = trace?.start('http.queue', { creatorId, history, pending: current.pending });
    try {
      await abortable(previous, signal);
      const until = Math.max(current.nextAt, current.cooldownUntil, history ? current.nextHistoryAt : 0);
      const waitMs = Math.max(0, until - Date.now());
      if (waitMs) {
        scope?.event('http.queue-wait', { waitMs, until, reason: current.cooldownUntil > Date.now() ? 'rate-limit' : 'spacing' });
        while (Date.now() < until) await sleep(until - Date.now(), signal);
      }
      signal.throwIfAborted();
      current.nextAt = Date.now() + current.intervalMs;
      if (history) current.nextHistoryAt = Date.now() + Math.max(1500, current.intervalMs);
      scope?.end({ intervalMs: current.intervalMs });
      return {
        release,
        limited: (retryAfterMs) => {
          const backoffMs = Math.max(retryAfterMs ?? 0, Math.min(300_000, 30_000 * 2 ** Math.min(current.limits, 4)));
          current.limits++;
          current.intervalMs = Math.min(8000, current.intervalMs * 2);
          current.cooldownUntil = Math.max(current.cooldownUntil, Date.now() + backoffMs);
          trace?.event('http.cooldown', { creatorId, backoffMs, until: current.cooldownUntil, intervalMs: current.intervalMs, retryAfterMs });
          return current.cooldownUntil - Date.now();
        },
      };
    } catch (error) { scope?.fail(error, { callerAborted: signal.aborted }); release(); throw error; }
  }
}

function abortable(work: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    void work.then(() => { signal.removeEventListener('abort', abort); resolve(); });
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, Math.min(ms, 2_147_483_647));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
