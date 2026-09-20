import { normalizeWelcome, welcomeTexts } from '../shared/followers.js';
import type { SessionTemplate } from '../shared/types.js';
import type { FanslyClient } from './fansly-client.js';
import { traced, type TraceScope } from './followers-trace.js';

type Storage = Pick<browser.storage.StorageArea, 'get' | 'set'>;

/** Normalized welcome texts of one creator and when Fansly last confirmed them. */
export interface WelcomeDefinitions { texts: Set<string>; checkedAt: number }

export interface WelcomeLoadRequest {
  creatorId: string;
  /** The creator's Fansly session. The read always rides the paced follower
   * lane, whichever surface asks. */
  session: SessionTemplate;
  /** Skip the 24 h cache and ask Fansly. A failed fresh read never falls back. */
  fresh?: boolean;
  /** Parent scope of the `welcome.load` span; absent for untraced callers. */
  trace?: TraceScope;
  /** Trace id of the caller, shown to a traced caller that joins this load. */
  traceId?: string;
  /** Detaches THIS caller only. The shared read keeps going and fills the
   * cache for the next caller. */
  signal?: AbortSignal;
}

/** A read that never waits long: where the texts came from, and why not from
 * Fansly when they did not. */
export interface BoundedWelcomeDefinitions {
  texts: Set<string>;
  /** `cache`: younger than 24 h, no network. `fresh`: read now. `stale`: an
   * older cache, because the read failed or did not finish in time. `none`:
   * nothing known, automation is judged by the independent markers only. */
  source: 'cache' | 'fresh' | 'stale' | 'none';
  reason?: 'timeout' | 'error';
}

interface Options {
  fansly: Pick<FanslyClient, 'followerSession' | 'getWelcomeDefinitions'>;
  storage: Storage;
}

const WELCOME_CACHE_MS = 24 * 3600_000;

/** Storage key of the New Followers window since E117; the cache keeps it. */
export const welcomeStorageKey = (creatorId: string) => `chatgoose:followers:v1:welcome:${creatorId}:`;

/** Creator-scoped welcome definitions: storage.local cache for 24 h, one
 * Fansly read per creator at a time, older texts retained when an automation
 * is edited. Shared by the New Followers window and the chat Hi. */
export class WelcomeDefinitionsService {
  private readonly loads = new Map<string, { work: Promise<WelcomeDefinitions>; traceId?: string }>();

  constructor(private readonly options: Options) {}

  async load(request: WelcomeLoadRequest): Promise<WelcomeDefinitions> {
    const signal = request.signal;
    if (!signal) return this.read(request);
    signal.throwIfAborted();
    const work = this.read(request);
    return new Promise<WelcomeDefinitions>((resolve, reject) => {
      const aborted = () => reject(signal.reason);
      signal.addEventListener('abort', aborted, { once: true });
      void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
  }

  /** Cached texts of ANY age, without touching Fansly. Null when nothing
   * readable is cached. */
  async peek(creatorId: string): Promise<WelcomeDefinitions | null> {
    const storageKey = welcomeStorageKey(creatorId);
    const cached = (await this.options.storage.get(storageKey))[storageKey] as { texts?: unknown; checkedAt?: unknown } | undefined;
    if (typeof cached?.checkedAt !== 'number' || !Array.isArray(cached.texts) || !cached.texts.every((v: unknown) => typeof v === 'string')) return null;
    return { texts: new Set((cached.texts as string[]).map(normalizeWelcome)), checkedAt: cached.checkedAt };
  }

  /** Cache-first read for a surface that must never wait on Fansly (the chat
   * Hi): a cache younger than 24 h answers at once; otherwise the normal paced
   * load gets `timeoutMs`, and past it (or on its failure) the stale cache
   * answers, else an empty set. The shared read keeps running and fills the
   * cache for the next caller. Only the caller's own `signal` rejects. */
  async loadWithin({ timeoutMs, signal, ...request }: Omit<WelcomeLoadRequest, 'fresh'> & { timeoutMs: number }): Promise<BoundedWelcomeDefinitions> {
    signal?.throwIfAborted();
    const cached = await this.peek(request.creatorId).catch(() => null);
    signal?.throwIfAborted();
    if (cached && Date.now() - cached.checkedAt < WELCOME_CACHE_MS) return { texts: cached.texts, source: 'cache' };
    const timeout = AbortSignal.timeout(timeoutMs);
    try {
      const loaded = await this.load({ ...request, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      // `load` itself answers a failed Fansly read with the stale cache.
      return cached && loaded.checkedAt === cached.checkedAt ? { texts: loaded.texts, source: 'stale', reason: 'error' } : { texts: loaded.texts, source: 'fresh' };
    } catch {
      signal?.throwIfAborted();
      const reason = timeout.aborted ? 'timeout' : 'error';
      return cached ? { texts: cached.texts, source: 'stale', reason } : { texts: new Set(), source: 'none', reason };
    }
  }

  private async read({ creatorId: creator, session, fresh = false, trace: parent, traceId }: WelcomeLoadRequest): Promise<WelcomeDefinitions> {
    return traced(parent, 'welcome.load', async (scope) => {
      const storageKey = welcomeStorageKey(creator);
      const values = await traced(scope, 'welcome.cache-read', () => this.options.storage.get(storageKey));
      const cached = values[storageKey] as { texts?: unknown; checkedAt?: number } | undefined;
      if (cached && (!Array.isArray(cached.texts) || !cached.texts.every((v: unknown) => typeof v === 'string'))) throw new Error('Повреждён кэш welcome-сообщений.');
      const old = (cached?.texts ?? []) as string[];
      if (!fresh && cached?.checkedAt && Date.now() - cached.checkedAt < WELCOME_CACHE_MS) {
        scope?.event('welcome.cache-hit', { count: old.length, ageMs: Date.now() - cached.checkedAt });
        return { texts: new Set(old.map(normalizeWelcome)), checkedAt: cached.checkedAt };
      }
      const existing = this.loads.get(creator);
      if (existing) {
        scope?.event('welcome.join', { ownerTraceId: existing.traceId, fresh });
        return existing.work;
      }
      scope?.event('welcome.fetch', { fresh, cachedCount: old.length, ageMs: cached?.checkedAt ? Date.now() - cached.checkedAt : null });
      // Account-scoped single-flight is independent of an individual window's
      // cancellation. A closed tab must not poison another tab's welcome read.
      const work = (async () => {
        const raw = await this.options.fansly.getWelcomeDefinitions(this.options.fansly.followerSession(session), new AbortController().signal, scope);
        const texts = [...new Set([...old, ...welcomeTexts(raw)])];
        const checkedAt = Date.now();
        await traced(scope, 'welcome.cache-write', () => this.options.storage.set({ [storageKey]: { texts, checkedAt } }), { count: texts.length });
        scope?.event('welcome.loaded', { definitions: Array.isArray(raw) ? raw.length : 0, retainedTexts: texts.length });
        return { texts: new Set(texts.map(normalizeWelcome)), checkedAt };
      })();
      this.loads.set(creator, { work, traceId });
      try { return await work; }
      catch (error) {
        if (!fresh && cached?.checkedAt) {
          scope?.event('welcome.stale-fallback', { ageMs: Date.now() - cached.checkedAt, count: old.length });
          return { texts: new Set(old.map(normalizeWelcome)), checkedAt: cached.checkedAt };
        }
        throw error;
      } finally { this.loads.delete(creator); }
    }, { fresh });
  }
}
