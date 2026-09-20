import type { TraceScope } from '../followers-trace.js';
import { BAD_MEMORY_MS, floorOf, fresh, healed, limited, rested, type RouteState } from './controller.js';
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
/** A server-requested wait is honoured up to here: an HTTP-date from a skewed
 * clock must not park a creator for days, and the value is persisted. */
const RETRY_AFTER_MAX_MS = 6 * 3600_000;
/** FBuddy's cooldown grows with the reads answered since the previous limit
 * (1.25 s each, 300 s at most); ours takes the same term (E133). The count
 * lives in memory: a background restart or a rest starts it over. */
const COOLDOWN_PER_ANSWER_MS = 1250;
const COOLDOWN_MAX_MS = 300_000;

interface Lane {
  /** Saved limits are back in place (or confirmed absent). */
  ready: Promise<void>;
  tail: Promise<void>;
  pending: number;
  nextAt: number;
  cooldownUntil: number;
  level: number;
  /** How far the lane gap is widened; it comes back down one level per heal. */
  gapLevel: number;
  /** Reads Fansly answered since the previous limit. */
  answered: number;
  healFrom: number;
  clean: number;
  usedAt: number;
  savedAt: number;
  stored: boolean;
  routes: Map<string, RouteState>;
}

/** One limit does not say whose budget ran out, so it widens the whole lane.
 * Only a family measured to be limited on its own (`isolated`, E128) slows
 * just its key first and the lane from the second unhealed limit. */
const laneGap = (gapLevel: number) => Math.min(LANE_GAP_MAX_MS, LANE_GAP_MS * 2 ** gapLevel);

function heal(lane: Lane): void {
  while (lane.level > 0 && lane.clean >= HEAL_READS && Date.now() - lane.healFrom >= HEAL_MS) {
    lane.level--;
    lane.gapLevel = Math.max(0, lane.gapLevel - 1);
    lane.healFrom += HEAL_MS;
    lane.clean = 0;
    for (const [key, route] of lane.routes) lane.routes.set(key, healed(route, policyOf(key), Date.now()));
  }
}

/** A truly idle lane drops its penalty (E121) but not what Fansly refused: a
 * remembered limit outlives the wait, every other key starts over. */
function rest(lane: Lane, now: number): void {
  lane.level = 0; lane.gapLevel = 0; lane.answered = 0; lane.healFrom = 0; lane.clean = 0; lane.cooldownUntil = 0; lane.nextAt = 0;
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
    return lane ? { cooldownUntil: lane.cooldownUntil, intervalMs: laneGap(lane.gapLevel) } : undefined;
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
      // Rested once: the next idle check is a quarter of an hour away, not the next acquire.
      value.usedAt = Date.now();
      if (value.routes.size) this.persist(id, value); else this.lanes.delete(id);
    }
    const current = this.lane(creatorId, trace);
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
        scope?.event('http.heal', { from: penalty, to: current.level, intervalMs: laneGap(current.gapLevel) });
        this.persist(creatorId, current);
      }
      const route = current.routes.get(key) ?? fresh(policy);
      const routeAt = route.lastStartAt ? route.lastStartAt + route.spacingMs : 0;
      // The jitter rides on whichever deadline binds. Added to the lane gap
      // alone it vanished behind the key spacing, and a run of one key went
      // out as a 500 ms metronome (live trace, E133).
      const base = Math.max(current.nextAt, routeAt);
      const jitterMs = base > Date.now() ? Math.floor(this.random() * (LANE_JITTER_MS + 1)) : 0;
      const until = Math.max(current.cooldownUntil, base + jitterMs);
      const waitMs = Math.max(0, until - Date.now());
      if (waitMs) {
        scope?.event('http.queue-wait', { waitMs, until, reason: current.cooldownUntil > Date.now() ? 'rate-limit' : routeAt > current.nextAt ? 'route-spacing' : 'spacing' });
        while (Date.now() < until) await sleep(until - Date.now(), signal);
      }
      signal.throwIfAborted();
      const intervalMs = laneGap(current.gapLevel);
      current.nextAt = Date.now() + intervalMs;
      current.routes.set(key, { ...route, lastStartAt: Date.now() });
      scope?.end({ intervalMs, spacingMs: route.spacingMs });
      return {
        release,
        served: () => {
          current.answered++;
          if (Date.now() - current.healFrom >= HEAL_MS) current.clean++;
        },
        limited: (retryAfterMs) => this.limit(creatorId, current, method, pathname, retryAfterMs, trace),
      };
    } catch (error) { scope?.fail(error, { callerAborted: signal.aborted }); release(); throw error; }
  }

  /** When this key is next free. A caller that can wait elsewhere does so,
   * instead of sitting in the FIFO and holding every read behind it. */
  readyAt(creatorId: string, method: string, pathname: string): number {
    const route = this.lanes.get(creatorId)?.routes.get(paceFor(method, pathname).key);
    return route?.lastStartAt ? route.lastStartAt + route.spacingMs : 0;
  }

  /** A write Fansly limited counts against the lane like a limited read. */
  refused(creatorId: string, method: string, pathname: string, retryAfterMs: number | undefined, trace?: TraceScope): void {
    this.limit(creatorId, this.lane(creatorId, trace), method, pathname, retryAfterMs, trace);
  }

  private lane(creatorId: string, trace?: TraceScope): Lane {
    let lane = this.lanes.get(creatorId);
    if (!lane) {
      lane = { ready: Promise.resolve(), tail: Promise.resolve(), pending: 0, nextAt: 0, cooldownUntil: 0, level: 0, gapLevel: 0, answered: 0, healFrom: 0, clean: 0, usedAt: Date.now(), savedAt: 0, stored: false, routes: new Map() };
      // The queue opens only after the saved limits are back in place. A
      // failed restore must never wedge the lane: memory keeps pacing.
      lane.ready = this.restore(creatorId, lane, trace).catch(() => undefined);
      lane.tail = lane.ready;
      this.lanes.set(creatorId, lane);
    }
    return lane;
  }

  private limit(creatorId: string, lane: Lane, method: string, pathname: string, retryAfterMs: number | undefined, trace?: TraceScope): number {
    const { key, policy } = paceFor(method, pathname);
    const now = Date.now();
    const ladderMs = Math.min(COOLDOWN_MAX_MS, 30_000 * 2 ** Math.min(lane.level, 4));
    const backoffMs = Math.max(Math.min(retryAfterMs ?? 0, RETRY_AFTER_MAX_MS), ladderMs, Math.min(COOLDOWN_MAX_MS, lane.answered * COOLDOWN_PER_ANSWER_MS));
    // An isolated family widens the lane from its second unhealed limit, any other key from the first.
    if (!policy.isolated || lane.level > 0) lane.gapLevel = Math.min(MAX_LEVEL, lane.gapLevel + 1);
    lane.level = Math.min(MAX_LEVEL, lane.level + 1);
    lane.clean = 0; lane.answered = 0;
    lane.cooldownUntil = Math.max(lane.cooldownUntil, now + backoffMs);
    lane.healFrom = lane.cooldownUntil;
    const state = limited(lane.routes.get(key) ?? fresh(policy), policy, now);
    lane.routes.set(key, state);
    trace?.event('http.cooldown', { creatorId, route: key, backoffMs, until: lane.cooldownUntil, intervalMs: laneGap(lane.gapLevel), spacingMs: state.spacingMs, retryAfterMs });
    this.persist(creatorId, lane);
    return lane.cooldownUntil - now;
  }

  /** A lane that was truly idle starts over, as it would have in memory; a
   * remembered limit and an open cooldown survive the background page. A
   * storage answer that misses the deadline is merged in when it arrives:
   * by then the lane has moved, so only what is stricter is taken. */
  private async restore(creatorId: string, lane: Lane, trace?: TraceScope): Promise<void> {
    const saved = await this.store.load(creatorId, (late) => this.apply(creatorId, lane, late, true, trace));
    if (saved) this.apply(creatorId, lane, saved, false, trace);
  }

  private apply(creatorId: string, lane: Lane, saved: SavedLane, late: boolean, trace?: TraceScope): void {
    const now = Date.now();
    const idle = Math.max(saved.usedAt + IDLE_MS, saved.cooldownUntil) < now;
    lane.stored = true;
    if (!idle) {
      // A cooldown saved before the cap existed must not park the creator for years.
      lane.cooldownUntil = Math.max(lane.cooldownUntil, Math.min(saved.cooldownUntil, now + RETRY_AFTER_MAX_MS));
      lane.level = Math.max(lane.level, Math.min(MAX_LEVEL, saved.level));
      lane.gapLevel = Math.min(lane.level, Math.max(lane.gapLevel, saved.gapLevel));
      lane.healFrom = Math.max(lane.healFrom, saved.healFrom);
      // Reads answered before a late penalty arrived ran at the unpenalised
      // pace: they forgive nothing (E128).
      lane.clean = late ? 0 : saved.clean;
    }
    for (const [key, route] of Object.entries(saved.routes)) {
      // The policy may have moved since the key was saved.
      const policy = policyOf(key);
      const kept: RouteState = { ...route, lastStartAt: 0 };
      const state = idle ? rested(kept, policy, now) : kept;
      if (idle && !(state.badMs > 0 && now - state.badAt < BAD_MEMORY_MS)) continue;
      const current = lane.routes.get(key);
      const spacingMs = Math.min(policy.ceilMs, Math.max(floorOf(state, policy, now), state.spacingMs, current?.spacingMs ?? 0));
      lane.routes.set(key, current && current.badAt >= state.badAt ? { ...current, spacingMs } : { ...state, lastStartAt: current?.lastStartAt ?? 0, spacingMs });
    }
    if (idle || late) this.persist(creatorId, lane);
    trace?.event('http.pace-restored', { creatorId, idle, late, level: lane.level, cooldownUntil: lane.cooldownUntil, routes: [...lane.routes].map(([key, route]) => `${key}=${route.spacingMs}`).join(', ') });
  }

  /** Only a lane that carries a penalty or a remembered limit is worth a key. */
  private persist(creatorId: string, lane: Lane): void {
    const now = Date.now();
    lane.savedAt = now;
    const worth = lane.level > 0 || lane.cooldownUntil > now || [...lane.routes.values()].some((route) => route.badMs > 0);
    if (!worth && !lane.stored) return;
    lane.stored = worth;
    const saved: SavedLane | null = worth ? {
      usedAt: lane.usedAt, cooldownUntil: lane.cooldownUntil, level: lane.level, gapLevel: lane.gapLevel, healFrom: lane.healFrom, clean: lane.clean,
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
