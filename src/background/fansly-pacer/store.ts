import type { RouteState } from './controller.js';

export type PacerStorage = Pick<browser.storage.StorageArea, 'get' | 'set'>;

/** What a creator lane must not forget when the background page unloads: an
 * open cooldown, the penalty level and every remembered limit. An operational
 * cache like the follower proofs: its own key, no schema migration (E130). */
export interface SavedLane {
  usedAt: number;
  cooldownUntil: number;
  level: number;
  gapLevel: number;
  healFrom: number;
  clean: number;
  routes: Record<string, Omit<RouteState, 'lastStartAt'>>;
}

const LOAD_DEADLINE_MS = 1000;
const key = (creatorId: string) => `chatgoose:fansly-pacer:v1:${creatorId}`;
const time = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);

export class PacerStore {
  constructor(private readonly storage?: PacerStorage) {}

  /** Best effort both ways: a lane without storage still paces from memory,
   * and a storage call that never answers must not hold every read (E124).
   * An answer that comes after the deadline is not thrown away: `late` gets
   * it, so a saved cooldown is applied as soon as it is known (E133). */
  async load(creatorId: string, late?: (saved: SavedLane) => void): Promise<SavedLane | undefined> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const missed = Symbol('deadline');
      const deadline = new Promise<typeof missed>((resolve) => { timer = setTimeout(() => resolve(missed), LOAD_DEADLINE_MS); });
      const reading = Promise.resolve(this.storage?.get(key(creatorId))).then((stored) => this.parse(stored?.[key(creatorId)]));
      const first = await Promise.race([reading, deadline]).finally(() => clearTimeout(timer));
      if (first !== missed) return first;
      void reading.then((saved) => { if (saved) late?.(saved); }, () => undefined);
      return undefined;
    } catch { return undefined; }
  }

  private parse(stored: unknown): SavedLane | undefined {
    const raw = stored as Partial<SavedLane> | null | undefined;
    if (!raw || typeof raw !== 'object') return undefined;
    const routes: SavedLane['routes'] = {};
    for (const [paceKey, value] of Object.entries(raw.routes && typeof raw.routes === 'object' ? raw.routes : {})) {
      const route = value as Partial<RouteState> | null;
      if (!route || time(route.spacingMs) === 0) continue;
      routes[paceKey] = { spacingMs: time(route.spacingMs), badMs: time(route.badMs), badAt: time(route.badAt) };
    }
    const level = Math.round(time(raw.level));
    // A lane saved by 2.4.3 has no gap level: it widened from the second limit.
    const gapLevel = typeof raw.gapLevel === 'number' ? Math.round(time(raw.gapLevel)) : Math.max(0, level - 1);
    return { usedAt: time(raw.usedAt), cooldownUntil: time(raw.cooldownUntil), level, gapLevel, healFrom: time(raw.healFrom), clean: Math.round(time(raw.clean)), routes };
  }

  async save(creatorId: string, lane: SavedLane | null): Promise<void> {
    try { await this.storage?.set({ [key(creatorId)]: lane }); } catch { /* memory keeps pacing */ }
  }
}
