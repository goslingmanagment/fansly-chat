import type { TraceScope } from '../followers-trace.js';
import { BAD_MEMORY_MS, floorOf, fresh, limited, rested, served, started, type RouteState } from './controller.js';
import { LANE_GAP_MAX_MS, LANE_GAP_MS, LANE_JITTER_MS, paceFor, policyOf } from './policy.js';
import { PacerStore, type PacerStorage, type SavedLane } from './store.js';

const MAX_LEVEL = 5;
/** One lane level is forgiven after this long since the cooldown ended AND
 * then this many reads Fansly answered. Reads inside the quiet period do not
 * count and idle time proves nothing, so a scan that follows a 429 always
 * probes at the penalised pace first (E128). */
const HEAL_MS = 300_000;
const HEAL_READS = 20;
const IDLE_MS = 900_000;
const SAVE_EVERY_MS = 60_000;

interface Lane {
  tail: Promise<void>;
  pending: number;
  nextAt: number;
  cooldownUntil: number;
  level: number;
  healFrom: number;
  clean: number;
  usedAt: number;
  savedAt: number;
  stored: boolean;
  routes: Map<string, RouteState>;
}

/** The first limit slows only its own key. From the second unhealed limit the
 * whole lane widens too: repeated limits point at a shared budget. */
const laneGap = (level: number) => Math.min(LANE_GAP_MAX_MS, LANE_GAP_MS * 2 ** Math.max(0, level - 1));

function heal(lane: Lane): void {
  while (lane.level > 0 && lane.clean >= HEAL_READS && Date.now() - lane.healFrom >= HEAL_MS) {
    lane.level--;
    lane.healFrom += HEAL_MS;
    lane.clean = 0;
  }
}

/** A truly idle lane drops its penalty (E121) but not what Fansly refused: a
 * remembered limit outlives the wait, every other key starts over. */
function rest(lane: Lane, now: number): void {
  lane.level = 0; lane.healFrom = 0; lane.clean = 0; lane.cooldownUntil = 0; lane.nextAt = 0;
  for (const [key, route] of lane.routes) {
    if (route.badMs > 0 && now - route.badAt < BAD_MEMORY_MS) lane.routes.set(key, rested(route, policyOf(key), now));
    else lane.routes.delete(key);
  }
}

/** Reads that opt in share one FIFO per creator, independently of debug mode:
 * one attempt in flight, a jittered gap between any two starts and a learned
 * spacing per pace key. A permit covers one HTTP attempt, never an entire scan
 * or a POST. Server-requested waits are never shortened. */
export class FanslyPacer {
  private readonly lanes = new Map<string, Lane>();
  private readonly store: PacerStore;
  private readonly random: () => number;

  constructor(options: { storage?: PacerStorage; random?: () => number } = {}) {
    this.store = new PacerStore(options.storage);
    this.random = options.random ?? (() => Math.random());
  }

  status(creatorId: string): { cooldownUntil: number; intervalMs: number } | undefined {
    const lane = this.lanes.get(creatorId);
    return lane ? { cooldownUntil: lane.cooldownUntil, intervalMs: laneGap(lane.level) } : undefined;
  }

  async acquire(creatorId: string, method: string, pathname: string, signal: AbortSignal, trace?: TraceScope): Promise<{
    release: () => void;
    /** Fansly answered this read without throttling it. */
    served: () => void;
    limited: (retryAfterMs?: number) => number;
  }> {
    signal.throwIfAborted();
    for (const [id, value] of this.lanes) {
      if (value.pending || Math.max(value.usedAt + IDLE_MS, value.cooldownUntil) >= Date.now()) continue;
      rest(value, Date.now());
      if (value.routes.size) this.persist(id, value); else this.lanes.delete(id);
    }
    let lane = this.lanes.get(creatorId);
    if (!lane) {
      lane = { tail: Promise.resolve(), pending: 0, nextAt: 0, cooldownUntil: 0, level: 0, healFrom: 0, clean: 0, usedAt: Date.now(), savedAt: 0, stored: false, routes: new Map() };
      // The queue opens only after the saved limits are back in place.
      lane.tail = this.restore(creatorId, lane, trace);
      this.lanes.set(creatorId, lane);
    }
    const current = lane;
    const { key, policy } = paceFor(method, pathname);
    const previous = current.tail;
    let unlock!: () => void;
    current.tail = new Promise<void>((resolve) => { unlock = resolve; });
    current.pending++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      current.pending--; current.usedAt = Date.now();
      if (Date.now() - current.savedAt >= SAVE_EVERY_MS) this.persist(creatorId, current);
      // A cancelled waiter must not let its successor overtake the owner.
      void previous.then(unlock);
    };
    const scope = trace?.start('http.queue', { creatorId, route: key, pending: current.pending });
    try {
      await abortable(previous, signal);
      const penalty = current.level;
      heal(current);
      if (current.level !== penalty) {
        scope?.event('http.heal', { from: penalty, to: current.level, intervalMs: laneGap(current.level) });
        this.persist(creatorId, current);
      }
      const route = current.routes.get(key) ?? fresh(policy);
      const routeAt = route.lastStartAt ? route.lastStartAt + route.spacingMs : 0;
      const until = Math.max(current.nextAt, current.cooldownUntil, routeAt);
      const waitMs = Math.max(0, until - Date.now());
      if (waitMs) {
        scope?.event('http.queue-wait', { waitMs, until, reason: current.cooldownUntil > Date.now() ? 'rate-limit' : until > current.nextAt ? 'route-spacing' : 'spacing' });
        while (Date.now() < until) await sleep(until - Date.now(), signal);
      }
      signal.throwIfAborted();
      const intervalMs = laneGap(current.level);
      current.nextAt = Date.now() + intervalMs + Math.floor(this.random() * (LANE_JITTER_MS + 1));
      const begun = started(route, Date.now());
      current.routes.set(key, begun.state);
      scope?.end({ intervalMs, spacingMs: route.spacingMs });
      const paced = (reason: string, from: number) => {
        const to = current.routes.get(key)?.spacingMs ?? from;
        if (to === from) return;
        trace?.event('http.pace', { creatorId, route: key, from, to, reason });
        this.persist(creatorId, current);
      };
      return {
        release,
        served: () => {
          if (Date.now() - current.healFrom >= HEAL_MS) current.clean++;
          const state = current.routes.get(key) ?? begun.state;
          current.routes.set(key, served(state, policy, Date.now(), begun.exercised));
          paced('answered', state.spacingMs);
        },
        limited: (retryAfterMs) => {
          current.clean = 0;
          const backoffMs = Math.max(retryAfterMs ?? 0, Math.min(300_000, 30_000 * 2 ** Math.min(current.level, 4)));
          current.level = Math.min(MAX_LEVEL, current.level + 1);
          current.cooldownUntil = Math.max(current.cooldownUntil, Date.now() + backoffMs);
          current.healFrom = current.cooldownUntil;
          const state = current.routes.get(key) ?? begun.state;
          current.routes.set(key, limited(state, policy, Date.now(), current.cooldownUntil));
          trace?.event('http.cooldown', { creatorId, route: key, backoffMs, until: current.cooldownUntil, intervalMs: laneGap(current.level), spacingMs: current.routes.get(key)!.spacingMs, retryAfterMs });
          this.persist(creatorId, current);
          return current.cooldownUntil - Date.now();
        },
      };
    } catch (error) { scope?.fail(error, { callerAborted: signal.aborted }); release(); throw error; }
  }

  /** A lane that was truly idle starts over, as it would have in memory; a
   * remembered limit and an open cooldown survive the background page. */
  private async restore(creatorId: string, lane: Lane, trace?: TraceScope): Promise<void> {
    const saved = await this.store.load(creatorId);
    if (!saved) return;
    const now = Date.now();
    const idle = Math.max(saved.usedAt + IDLE_MS, saved.cooldownUntil) < now;
    lane.stored = true;
    lane.cooldownUntil = saved.cooldownUntil; lane.level = Math.min(MAX_LEVEL, saved.level); lane.healFrom = saved.healFrom; lane.clean = saved.clean;
    for (const [key, route] of Object.entries(saved.routes)) {
      // The policy may have moved since the key was saved.
      const policy = policyOf(key);
      const state: RouteState = { ...route, lastStartAt: 0 };
      lane.routes.set(key, { ...state, spacingMs: Math.min(policy.ceilMs, Math.max(floorOf(state, policy, now), state.spacingMs)) });
    }
    if (idle) { rest(lane, now); this.persist(creatorId, lane); }
    trace?.event('http.pace-restored', { creatorId, idle, level: lane.level, cooldownUntil: lane.cooldownUntil, routes: [...lane.routes].map(([key, route]) => `${key}=${route.spacingMs}`).join(', ') });
  }

  /** Only a lane that carries a penalty or a remembered limit is worth a key. */
  private persist(creatorId: string, lane: Lane): void {
    const now = Date.now();
    lane.savedAt = now;
    const worth = lane.level > 0 || lane.cooldownUntil > now || [...lane.routes.values()].some((route) => route.badMs > 0);
    if (!worth && !lane.stored) return;
    lane.stored = worth;
    const saved: SavedLane | null = worth ? {
      usedAt: lane.usedAt, cooldownUntil: lane.cooldownUntil, level: lane.level, healFrom: lane.healFrom, clean: lane.clean,
      routes: Object.fromEntries([...lane.routes].map(([key, { lastStartAt: _lastStartAt, ...route }]) => [key, route])),
    } : null;
    void this.store.save(creatorId, saved);
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
