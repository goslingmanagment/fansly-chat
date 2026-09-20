import type { RouteState } from './controller.js';

export type PacerStorage = Pick<browser.storage.StorageArea, 'get' | 'set'>;

/** What a creator lane must not forget when the background page unloads: an
 * open cooldown, the penalty level and every remembered limit. An operational
 * cache like the follower proofs: its own key, no schema migration (E130). */
export interface SavedLane {
  usedAt: number;
  cooldownUntil: number;
  level: number;
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
   * and a storage call that never answers must not hold every read (E124). */
  async load(creatorId: string): Promise<SavedLane | undefined> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), LOAD_DEADLINE_MS); });
      const stored = await Promise.race([this.storage?.get(key(creatorId)), deadline]).finally(() => clearTimeout(timer));
      const raw = stored?.[key(creatorId)] as Partial<SavedLane> | null | undefined;
      if (!raw || typeof raw !== 'object') return undefined;
      const routes: SavedLane['routes'] = {};
      for (const [paceKey, value] of Object.entries(raw.routes && typeof raw.routes === 'object' ? raw.routes : {})) {
        const route = value as Partial<RouteState> | null;
        if (!route || time(route.spacingMs) === 0) continue;
        routes[paceKey] = { spacingMs: time(route.spacingMs), clean: time(route.clean), badMs: time(route.badMs), badAt: time(route.badAt), quietUntil: time(route.quietUntil) };
      }
      return { usedAt: time(raw.usedAt), cooldownUntil: time(raw.cooldownUntil), level: Math.round(time(raw.level)), healFrom: time(raw.healFrom), clean: Math.round(time(raw.clean)), routes };
    } catch { return undefined; }
  }

  async save(creatorId: string, lane: SavedLane | null): Promise<void> {
    try { await this.storage?.set({ [key(creatorId)]: lane }); } catch { /* memory keeps pacing */ }
  }
}
