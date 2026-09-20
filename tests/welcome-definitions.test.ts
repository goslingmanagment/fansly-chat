import { afterEach, describe, expect, it, vi } from 'vitest';
import { WelcomeDefinitionsService, welcomeStorageKey } from '../src/background/welcome-definitions.js';
import { FollowersService } from '../src/background/followers-service.js';
import { FollowersTrace } from '../src/background/followers-trace.js';
import type { FanslyClient } from '../src/background/fansly-client.js';
import type { SessionStore } from '../src/background/session-store.js';
import type { AgencyHubClient } from '../src/background/agency-hub-client.js';
import type { KernelFeatureGateway } from '../src/background/kernel-feature-gateway.js';
import type { PersistedState, SessionTemplate } from '../src/shared/types.js';
import { createDefaultSettings } from '../src/shared/migrations.js';

const KEY = 'chatgoose:followers:v1:welcome:1:';
const DAY = 24 * 3600_000;
const session: SessionTemplate = { accountId: '1', resolvedAccountId: '1', resolvedUsername: 'creator', resolvedDisplayName: 'Creator', authorization: 'secret', fanslySessionId: 'session', fanslyClientId: 'client', latestTs: '1', latestCheck: 'check', routeChecks: {}, lastSeenAt: 1, connected: true };
const definitions = (...contents: string[]) => contents.map((content) => ({ messageTemplate: { content } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness() {
  const values: Record<string, unknown> = {};
  const paced: SessionTemplate[] = [];
  const fansly = {
    followerSession: vi.fn((value: SessionTemplate) => { const copy = structuredClone(value); paced.push(copy); return copy; }),
    getWelcomeDefinitions: vi.fn(async (_session: SessionTemplate, _signal: AbortSignal, _trace?: unknown): Promise<unknown> => definitions('auto welcome')),
  };
  const storage = {
    get: vi.fn(async (keys: string | string[]) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, values[key]]))),
    set: vi.fn(async (update: Record<string, unknown>) => { Object.assign(values, structuredClone(update)); }),
  };
  const service = new WelcomeDefinitionsService({ fansly, storage: storage as unknown as browser.storage.StorageArea });
  return { service, values, fansly, storage, paced };
}

describe('welcome definitions service', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('keeps the New Followers storage key', () => {
    expect(welcomeStorageKey('1')).toBe(KEY);
  });

  it('serves a caller that has no scan and no trace (the chat Hi)', async () => {
    const h = harness();
    h.fansly.getWelcomeDefinitions.mockResolvedValue(definitions('  auto\n welcome ', 'second'));
    const before = Date.now();
    const loaded = await h.service.load({ creatorId: '1', session });
    expect([...loaded.texts]).toEqual(['auto welcome', 'second']);
    expect(loaded.checkedAt).toBeGreaterThanOrEqual(before);
    // Same cache shape as before the extraction: raw texts plus the check time.
    expect(h.values[KEY]).toEqual({ texts: ['  auto\n welcome ', 'second'], checkedAt: loaded.checkedAt });
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce();
  });

  it('reads Fansly only through the paced follower lane, on a signal no caller can abort', async () => {
    const h = harness();
    await h.service.load({ creatorId: '1', session });
    const [used, signal] = h.fansly.getWelcomeDefinitions.mock.calls[0]!;
    expect(h.fansly.followerSession).toHaveBeenCalledExactlyOnceWith(session);
    expect(used).toBe(h.paced[0]);
    expect(used).not.toBe(session);
    expect(signal.aborted).toBe(false);
  });

  it('answers from the cache for 24 hours, then asks Fansly again', async () => {
    const h = harness();
    h.values[KEY] = { texts: ['cached welcome'], checkedAt: Date.now() - DAY + 60_000 };
    const hit = await h.service.load({ creatorId: '1', session });
    expect([...hit.texts]).toEqual(['cached welcome']);
    expect(h.fansly.getWelcomeDefinitions).not.toHaveBeenCalled();
    expect(h.storage.set).not.toHaveBeenCalled();

    h.values[KEY] = { texts: ['cached welcome'], checkedAt: Date.now() - DAY - 1 };
    const refreshed = await h.service.load({ creatorId: '1', session });
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce();
    // An edited automation keeps its older text: fans already received it.
    expect([...refreshed.texts]).toEqual(['cached welcome', 'auto welcome']);
    expect(h.values[KEY]).toMatchObject({ texts: ['cached welcome', 'auto welcome'] });
  });

  it('skips a fresh cache when the caller asks for a fresh read', async () => {
    const h = harness();
    h.values[KEY] = { texts: ['cached welcome'], checkedAt: Date.now() };
    const loaded = await h.service.load({ creatorId: '1', session, fresh: true });
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce();
    expect([...loaded.texts]).toEqual(['cached welcome', 'auto welcome']);
  });

  it('keeps each creator in its own cache entry and its own read', async () => {
    const h = harness();
    h.fansly.getWelcomeDefinitions.mockImplementation(async (used) => definitions(`welcome of ${used.accountId}`));
    const [first, second] = await Promise.all([
      h.service.load({ creatorId: '1', session }),
      h.service.load({ creatorId: '9', session: { ...session, accountId: '9', resolvedAccountId: '9' } }),
    ]);
    expect([...first.texts]).toEqual(['welcome of 1']);
    expect([...second.texts]).toEqual(['welcome of 9']);
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledTimes(2);
    expect(Object.keys(h.values).sort()).toEqual([KEY, 'chatgoose:followers:v1:welcome:9:']);
  });

  it('rejects a failed load without a cache, and the next caller starts a new read', async () => {
    const h = harness();
    h.fansly.getWelcomeDefinitions.mockRejectedValueOnce(new Error('offline'));
    await expect(h.service.load({ creatorId: '1', session })).rejects.toThrow('offline');
    expect(h.values[KEY]).toBeUndefined();
    expect([...(await h.service.load({ creatorId: '1', session })).texts]).toEqual(['auto welcome']);
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledTimes(2);
  });

  it('falls back to the stale cache on a failed load, but never for a fresh read', async () => {
    const h = harness();
    const checkedAt = Date.now() - 3 * DAY;
    h.values[KEY] = { texts: ['old welcome'], checkedAt };
    h.fansly.getWelcomeDefinitions.mockRejectedValue(new Error('offline'));
    expect(await h.service.load({ creatorId: '1', session })).toEqual({ texts: new Set(['old welcome']), checkedAt });
    await expect(h.service.load({ creatorId: '1', session, fresh: true })).rejects.toThrow('offline');
    expect(h.values[KEY]).toEqual({ texts: ['old welcome'], checkedAt });
  });

  it('rejects an unreadable definition shape and a corrupt cache instead of guessing', async () => {
    const h = harness();
    h.fansly.getWelcomeDefinitions.mockResolvedValueOnce({ unexpected: true });
    await expect(h.service.load({ creatorId: '1', session })).rejects.toThrow('welcome');
    expect(h.values[KEY]).toBeUndefined();
    h.values[KEY] = { texts: ['ok', 7], checkedAt: Date.now() };
    await expect(h.service.load({ creatorId: '1', session })).rejects.toThrow('Повреждён кэш');
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce();
  });

  it('shares one Fansly read between concurrent callers of the same creator', async () => {
    const h = harness();
    const gate = deferred<unknown>();
    h.fansly.getWelcomeDefinitions.mockReturnValueOnce(gate.promise);
    const first = h.service.load({ creatorId: '1', session });
    const second = h.service.load({ creatorId: '1', session, fresh: true });
    await vi.waitFor(() => expect(h.storage.get).toHaveBeenCalledTimes(2));
    gate.resolve(definitions('auto welcome'));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce();
    expect(h.storage.set).toHaveBeenCalledOnce();
  });

  it('detaches an aborted caller without poisoning the read another caller joined', async () => {
    const h = harness();
    const gate = deferred<unknown>();
    h.fansly.getWelcomeDefinitions.mockReturnValueOnce(gate.promise);
    const closing = new AbortController();
    const closed = h.service.load({ creatorId: '1', session, signal: closing.signal });
    const other = h.service.load({ creatorId: '1', session });
    await vi.waitFor(() => expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce());
    closing.abort(new DOMException('tab closed', 'AbortError'));
    await expect(closed).rejects.toThrow('tab closed');
    expect(h.fansly.getWelcomeDefinitions.mock.calls[0]![1].aborted).toBe(false);
    gate.resolve(definitions('auto welcome'));
    expect([...(await other).texts]).toEqual(['auto welcome']);
    // The owner left, the read still filled the cache for the next caller.
    expect(h.values[KEY]).toMatchObject({ texts: ['auto welcome'] });
    await h.service.load({ creatorId: '1', session });
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce();
  });

  it('does not start a read for a caller that is already gone', async () => {
    const h = harness();
    await expect(h.service.load({ creatorId: '1', session, signal: AbortSignal.abort(new DOMException('gone', 'AbortError')) })).rejects.toThrow('gone');
    expect(h.storage.get).not.toHaveBeenCalled();
    expect(h.fansly.getWelcomeDefinitions).not.toHaveBeenCalled();
  });

  it('leaves no unhandled rejection when a detached caller\'s read fails later', async () => {
    const h = harness();
    const gate = deferred<unknown>();
    h.fansly.getWelcomeDefinitions.mockReturnValueOnce(gate.promise);
    const unhandled = vi.fn();
    // The repo ships a minimal `process` shim instead of the Node typings.
    const events = process as unknown as Record<'on' | 'off', (event: string, listener: () => void) => void>;
    events.on('unhandledRejection', unhandled);
    try {
      const closing = new AbortController();
      const closed = h.service.load({ creatorId: '1', session, signal: closing.signal });
      await vi.waitFor(() => expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce());
      closing.abort(new DOMException('tab closed', 'AbortError'));
      await expect(closed).rejects.toThrow('tab closed');
      gate.reject(new Error('offline'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally { events.off('unhandledRejection', unhandled); }
  });

  it('keeps the followers debug trace: the same spans, events and no message text', async () => {
    const h = harness();
    const trace = new FollowersTrace({ id: 'scan-a', tabId: 7, hours: 48, version: 'test', build: 'test' });
    h.values[KEY] = { texts: ['secret old welcome'], checkedAt: Date.now() - 3 * DAY };
    h.fansly.getWelcomeDefinitions.mockResolvedValueOnce(definitions('secret new welcome'));
    await h.service.load({ creatorId: '1', session, trace, traceId: 'scan-a' });
    h.fansly.getWelcomeDefinitions.mockRejectedValueOnce(new Error('offline'));
    h.values[KEY] = { texts: ['secret old welcome'], checkedAt: Date.now() - 3 * DAY };
    await h.service.load({ creatorId: '1', session, trace, traceId: 'scan-a' });
    h.values[KEY] = { texts: ['secret old welcome'], checkedAt: Date.now() };
    await h.service.load({ creatorId: '1', session, trace, traceId: 'scan-a' });
    const report = trace.read();
    expect(report.events.map((event) => `${event.name}.${event.phase}`)).toEqual([
      'welcome.load.start', 'welcome.cache-read.start', 'welcome.cache-read.end', 'welcome.fetch.event',
      'welcome.cache-write.start', 'welcome.cache-write.end', 'welcome.loaded.event', 'welcome.load.end',
      'welcome.load.start', 'welcome.cache-read.start', 'welcome.cache-read.end', 'welcome.fetch.event', 'welcome.stale-fallback.event', 'welcome.load.end',
      'welcome.load.start', 'welcome.cache-read.start', 'welcome.cache-read.end', 'welcome.cache-hit.event', 'welcome.load.end',
    ]);
    expect(report.events[0]!.data).toEqual({ fresh: false });
    expect(report.events[3]!.data).toMatchObject({ fresh: false, cachedCount: 1 });
    expect(report.events[6]!.data).toEqual({ definitions: 1, retainedTexts: 2 });
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('tells a traced joiner whose read it joined', async () => {
    const h = harness();
    const gate = deferred<unknown>();
    h.fansly.getWelcomeDefinitions.mockReturnValueOnce(gate.promise);
    const joiner = new FollowersTrace({ id: 'scan-b', tabId: 8, hours: 48, version: 'test', build: 'test' });
    const owner = h.service.load({ creatorId: '1', session, traceId: 'scan-a' });
    await vi.waitFor(() => expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce());
    const joined = h.service.load({ creatorId: '1', session, fresh: true, trace: joiner, traceId: 'scan-b' });
    await vi.waitFor(() => expect(joiner.read().events.some((event) => event.name === 'welcome.join')).toBe(true));
    gate.resolve(definitions('auto welcome'));
    await Promise.all([owner, joined]);
    expect(joiner.read().events.find((event) => event.name === 'welcome.join')!.data).toEqual({ ownerTraceId: 'scan-a', fresh: true });
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce();
  });
});

describe('welcome definitions shared with the followers window', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('lets the followers scan and another surface share one read, cache and service', async () => {
    const h = harness();
    const gate = deferred<unknown>();
    h.fansly.getWelcomeDefinitions.mockReturnValueOnce(gate.promise);
    const state: PersistedState = { schemaVersion: 16, settings: createDefaultSettings(), personalities: [], personaCatalog: [], personaCatalogSource: null, personaCatalogFetchedAt: null, accountMappings: {}, accountAliases: {}, knownAccounts: [] };
    const fansly = {
      ...h.fansly,
      followerReadStatus: vi.fn(() => undefined),
      getAuthenticatedAccount: vi.fn(async () => ({ id: '1', username: 'creator' })),
      getFollowerPage: vi.fn(async () => ({ followers: [] })),
    };
    const followers = new FollowersService({
      fansly: fansly as unknown as FanslyClient, sessions: { getSessionForTab: () => session } as unknown as SessionStore,
      gateway: {} as KernelFeatureGateway, hub: {} as AgencyHubClient, readState: async () => state,
      storage: h.storage as unknown as browser.storage.StorageArea, welcome: h.service,
    });
    const snapshot = await followers.start(7, 48);
    await vi.waitFor(() => expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce());
    const chat = h.service.load({ creatorId: '1', session });
    await vi.waitFor(() => expect(h.storage.get).toHaveBeenCalledTimes(2));
    gate.resolve(definitions('auto welcome'));
    expect([...(await chat).texts]).toEqual(['auto welcome']);
    await vi.waitFor(() => expect(followers.state(7, snapshot.scanId).scanning).toBe(false));
    expect(followers.state(7, snapshot.scanId).error).toBeUndefined();
    expect(h.fansly.getWelcomeDefinitions).toHaveBeenCalledOnce();
    followers.close(7);
  });
});
