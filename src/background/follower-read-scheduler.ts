import type { RouteKey } from '../shared/types.js';
import type { TraceScope } from './followers-trace.js';

const BASE_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 8000;
const MAX_LIMITS = 5;
/** One penalty level is forgiven after this long since the cooldown ended
 * AND then this many reads Fansly answered at the slower pace. Reads inside
 * the quiet period do not count and idle time proves nothing, so a scan that
 * follows a 429 always probes at the penalised spacing first. */
const HEAL_MS = 300_000;
const HEAL_READS = 20;
/** Route families need a wider gap than the lane default. `account` is a
 * live measurement (E128): the only 429 was the third `/account?ids=` read
 * 2 s apart and also the fifth `/account*` read in 10 s. One trace cannot
 * tell those apart, so follower pages share the gap with the id reads. */
const ROUTE_SPACING_MS: Partial<Record<RouteKey, number>> = { message: 1500, account: 5000 };

interface Lane {
  tail: Promise<void>;
  pending: number;
  nextAt: number;
  nextRouteAt: Partial<Record<RouteKey, number>>;
  cooldownUntil: number;
  limits: number;
  healFrom: number;
  clean: number;
  usedAt: number;
}

const spacing = (limits: number) => Math.min(MAX_INTERVAL_MS, BASE_INTERVAL_MS * 2 ** limits);

function heal(lane: Lane): void {
  while (lane.limits > 0 && lane.clean >= HEAL_READS && Date.now() - lane.healFrom >= HEAL_MS) {
    lane.limits--;
    lane.healFrom += HEAL_MS;
    lane.clean = 0;
  }
}

/** Only follower-owned GETs use this queue. All their windows share a creator
 * lane, independently of debug mode. A permit covers one HTTP attempt, never
 * an entire scan or a POST. Server-requested waits are never shortened. */
export class FollowerReadScheduler {
  private readonly lanes = new Map<string, Lane>();

  status(creatorId: string): { cooldownUntil: number; intervalMs: number } | undefined {
    const lane = this.lanes.get(creatorId);
    return lane ? { cooldownUntil: lane.cooldownUntil, intervalMs: spacing(lane.limits) } : undefined;
  }

  async acquire(creatorId: string, route: RouteKey, signal: AbortSignal, trace?: TraceScope): Promise<{
    release: () => void;
    /** Fansly answered this read without throttling it. */
    served: () => void;
    limited: (retryAfterMs?: number) => number;
  }> {
    signal.throwIfAborted();
    for (const [id, value] of this.lanes) {
      if (!value.pending && Math.max(value.usedAt + 900_000, value.cooldownUntil) < Date.now()) this.lanes.delete(id);
    }
    let lane = this.lanes.get(creatorId);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0, nextAt: 0, nextRouteAt: {}, cooldownUntil: 0, limits: 0, healFrom: 0, clean: 0, usedAt: Date.now() };
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
    const scope = trace?.start('http.queue', { creatorId, route, pending: current.pending });
    try {
      await abortable(previous, signal);
      const penalty = current.limits;
      heal(current);
      if (current.limits !== penalty) scope?.event('http.heal', { from: penalty, to: current.limits, intervalMs: spacing(current.limits) });
      const until = Math.max(current.nextAt, current.cooldownUntil, current.nextRouteAt[route] ?? 0);
      const waitMs = Math.max(0, until - Date.now());
      if (waitMs) {
        scope?.event('http.queue-wait', { waitMs, until, reason: current.cooldownUntil > Date.now() ? 'rate-limit' : until > current.nextAt ? 'route-spacing' : 'spacing' });
        while (Date.now() < until) await sleep(until - Date.now(), signal);
      }
      signal.throwIfAborted();
      const intervalMs = spacing(current.limits);
      current.nextAt = Date.now() + intervalMs;
      const routeMs = ROUTE_SPACING_MS[route];
      if (routeMs) current.nextRouteAt[route] = Date.now() + Math.max(routeMs, intervalMs);
      scope?.end({ intervalMs });
      return {
        release,
        served: () => { if (Date.now() - current.healFrom >= HEAL_MS) current.clean++; },
        limited: (retryAfterMs) => {
          current.clean = 0;
          const backoffMs = Math.max(retryAfterMs ?? 0, Math.min(300_000, 30_000 * 2 ** Math.min(current.limits, 4)));
          current.limits = Math.min(MAX_LIMITS, current.limits + 1);
          current.cooldownUntil = Math.max(current.cooldownUntil, Date.now() + backoffMs);
          current.healFrom = current.cooldownUntil;
          trace?.event('http.cooldown', { creatorId, route, backoffMs, until: current.cooldownUntil, intervalMs: spacing(current.limits), retryAfterMs });
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
