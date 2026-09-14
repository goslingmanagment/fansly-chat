import { afterEach, describe, expect, it, vi } from 'vitest';
import { FanslyClient } from '../src/background/fansly-client.js';
import { SessionStore } from '../src/background/session-store.js';
import { FollowersTrace } from '../src/background/followers-trace.js';
import { FollowerReadScheduler } from '../src/background/follower-read-scheduler.js';

function harness() {
  const store = new SessionStore();
  const session = store.registerCapture(7, { accountId: '1', authorization: 'session-token', fanslyClientId: 'client-id', fanslySessionId: 'session-id', fanslyClientTs: '10', fanslyClientCheck: 'check', routeKey: 'message' });
  return { client: new FanslyClient(store), session, signal: new AbortController().signal };
}
const envelope = (response: unknown) => new Response(JSON.stringify({ success: true, response }), { status: 200 });

describe('Fansly browser-session outreach transport', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('escalates repeated throttles and carries the last cooldown beyond retry exhaustion', async () => {
    vi.useFakeTimers(); const h = harness(); const session = h.client.followerSession(h.session);
    const start = Date.now(), at: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => { at.push(Date.now() - start); return at.length <= 4 ? new Response('', { status: 429 }) : envelope({ messages: [] }); }));
    const work = h.client.getMessagePage('3', null, session, h.signal);
    const rejected = expect(work).rejects.toMatchObject({ key: 'rate_limited' });
    await vi.advanceTimersByTimeAsync(210_000); await rejected;
    expect(at).toEqual([0, 30_000, 90_000, 210_000]);
    expect(h.client.followerReadStatus(session)).toEqual({ cooldownUntil: start + 450_000, intervalMs: 8000 });
    const next = h.client.getMessagePage('4', null, h.client.followerSession(h.session), h.signal);
    await vi.advanceTimersByTimeAsync(239_999); expect(at).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1); await next; expect(at[4]).toBe(450_000);
  });
  it('honors a dated Retry-After even when its originating window cancels during cooldown', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-14T10:00:00Z'));
    const h = harness(); const session = h.client.followerSession(h.session);
    const start = Date.now(), at: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => { at.push(Date.now() - start); return at.length === 1 ? new Response('', { status: 429, headers: { 'retry-after': 'Mon, 14 Sep 2026 10:05:00 GMT' } }) : envelope({ messages: [] }); }));
    const controller = new AbortController();
    const work = h.client.getMessagePage('3', null, session, controller.signal);
    const rejected = expect(work).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1);
    const next = h.client.getMessagePage('4', null, h.client.followerSession(h.session), h.signal);
    await vi.advanceTimersByTimeAsync(4999); controller.abort(); await rejected;
    await vi.advanceTimersByTimeAsync(294_999); expect(at).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1); await next; expect(at).toEqual([0, 300_000]);
  });
  it('does not prune a long cooldown but resets spacing after the lane is truly idle', async () => {
    vi.useFakeTimers(); const scheduler = new FollowerReadScheduler(); const signal = new AbortController().signal; const start = Date.now();
    const permit = await scheduler.acquire('1', true, signal); permit.limited(2_000_000); permit.release();
    await vi.advanceTimersByTimeAsync(900_001);
    const waiting = scheduler.acquire('1', true, signal);
    await vi.advanceTimersByTimeAsync(1_099_998);
    expect(scheduler.status('1')).toEqual({ cooldownUntil: start + 2_000_000, intervalMs: 2000 });
    await vi.advanceTimersByTimeAsync(1); const after = await waiting; after.release();
    await vi.advanceTimersByTimeAsync(900_001); const reset = await scheduler.acquire('1', false, signal);
    expect(scheduler.status('1')).toEqual({ cooldownUntil: 0, intervalMs: 1000 }); reset.release();
  });
  it('records actual HTTP attempts, 429 backoff and status under the caller fan scope', async () => {
    const h = harness();
    const trace = new FollowersTrace({ id: crypto.randomUUID(), tabId: 7, hours: 48, version: 'test', build: 'test' });
    const scope = trace.start('row.check', {}, '2');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response('private-body', { status: 429, headers: { 'retry-after': '1' } })).mockResolvedValueOnce(envelope({ messages: [] }));
    vi.stubGlobal('fetch', fetch); vi.useFakeTimers();
    const pending = h.client.getMessagePage('3', '456', h.session, h.signal, scope);
    await vi.advanceTimersByTimeAsync(1000); await pending;
    expect(fetch).toHaveBeenCalledTimes(2);
    const report = trace.read();
    expect(report.events.filter((event) => event.name === 'http' && event.phase === 'start').map((event) => [event.fanId, event.data.method, event.data.path, event.data.attempt])).toEqual([['2', 'GET', '/api/v1/message', 1], ['2', 'GET', '/api/v1/message', 2]]);
    for (const event of report.events.filter((event) => event.name === 'http' && event.phase === 'start')) expect(event.data.query).toBe('?groupId=3&limit=25&before=456&ngsw-bypass=true');
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'http.retry', data: { status: 429, backoffMs: 1000, retryAfterMs: 1000 } }));
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'http', phase: 'end', data: expect.objectContaining({ outcome: 'success', status: 200 }) }));
    for (const secret of ['session-token', 'session-id', 'client-id', 'private-body']) expect(JSON.stringify(report)).not.toContain(secret);
  });
  it('spaces every follower GET across windows and honors a long shared Retry-After before any queued read', async () => {
    vi.useFakeTimers();
    const h = harness();
    const one = h.client.followerSession(h.session);
    const two = h.client.followerSession(h.session);
    const timestamps: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      timestamps.push(Date.now());
      return timestamps.length === 1 ? new Response('', { status: 429, headers: { 'retry-after': '90' } }) : envelope({ messages: [] });
    });
    vi.stubGlobal('fetch', fetch);
    const started = Date.now();
    const work = Promise.all([
      h.client.getMessagePage('3', null, one, h.signal),
      h.client.getMessagePage('4', null, two, h.signal),
      h.client.getMessagePage('5', null, one, h.signal),
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(h.client.followerReadStatus(one)).toEqual({ cooldownUntil: started + 90_000, intervalMs: 2000 });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4001); await work;
    expect(timestamps.map((time) => time - started)).toEqual([0, 90_000, 92_000, 94_000]);
  });
  it('uses a 30-second fallback for 429 and leaves another creator independent', async () => {
    vi.useFakeTimers();
    const h = harness();
    const one = h.client.followerSession(h.session);
    const store = new SessionStore();
    const other = store.registerCapture(8, { accountId: '9', authorization: 'other', fanslyClientId: 'client-id', fanslySessionId: 'other-session', fanslyClientTs: '10', fanslyClientCheck: 'check', routeKey: 'message' });
    // Same client and scheduler; supply both identities in its real store.
    const client = new FanslyClient({ getSessionByAccount: (id: string) => id === '1' ? h.session : other } as SessionStore);
    const a = client.followerSession(one), b = client.followerSession(other);
    const timestamps: Array<[string, number]> = [];
    const start = Date.now();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      const group = new URL(String(url)).searchParams.get('groupId')!;
      timestamps.push([group, Date.now() - start]);
      return timestamps.length === 1 ? new Response('', { status: 429 }) : envelope({ messages: [] });
    });
    vi.stubGlobal('fetch', fetch);
    const work = client.getMessagePage('3', null, a, h.signal);
    await vi.advanceTimersByTimeAsync(0);
    await client.getMessagePage('9', null, b, h.signal);
    await vi.advanceTimersByTimeAsync(29_999); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); await work;
    expect(timestamps).toEqual([['3', 0], ['9', 0], ['3', 30_000]]);
  });
  it('cancels a queued waiter without releasing the active request or sending on a changed identity', async () => {
    vi.useFakeTimers();
    const h = harness(); const session = h.client.followerSession(h.session);
    let finish!: (response: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(envelope({ messages: [] }));
    vi.stubGlobal('fetch', fetch);
    const first = h.client.getMessagePage('3', null, session, h.signal);
    const controller = new AbortController();
    const cancelled = h.client.getMessagePage('4', null, session, controller.signal);
    const cancelledCheck = expect(cancelled).rejects.toThrow();
    const third = h.client.getMessagePage('5', null, session, h.signal);
    const thirdCheck = expect(third).rejects.toMatchObject({ key: 'chat_changed' });
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await cancelledCheck;
    await vi.advanceTimersByTimeAsync(2000); expect(fetch).toHaveBeenCalledOnce();
    h.session.authorization = 'changed';
    finish(envelope({ messages: [] })); await first; await thirdCheck;
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('paces all follower GET routes and records the wait independently of debug mode', async () => {
    vi.useFakeTimers();
    const h = harness(); const session = h.client.followerSession(h.session);
    const at: number[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { at.push(Date.now()); return envelope({ messages: [] }); });
    vi.stubGlobal('fetch', fetch);
    const work = Promise.all([
      h.client.getMessagePage('3', null, session, h.signal),
      h.client.getGroup('3', session, h.signal),
      h.client.getMessagePage('4', null, session, h.signal),
      h.client.getMessagePage('5', null, session, h.signal),
    ]);
    await vi.advanceTimersByTimeAsync(3500); await work;
    expect(at.map((value) => value - at[0]!)).toEqual([0, 1000, 2000, 3500]);
  });
  it('records a failed POST exactly once, without its body', async () => {
    const h = harness();
    const trace = new FollowersTrace({ id: crypto.randomUUID(), tabId: 7, hours: 48, version: 'test', build: 'test' });
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('private-body', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(h.client.sendFollowerMessage('3', 'private-message', '1', h.session, h.signal, trace)).rejects.toThrow();
    const report = trace.read();
    expect(report.counters['http.start']).toBe(1);
    expect(report.counters['http.error']).toBe(1);
    expect(report.events).toContainEqual(expect.objectContaining({ name: 'http.response', data: { status: 503 } }));
    expect(JSON.stringify(report)).not.toContain('private-message');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('uses the native follower relation cursor and fails closed on a malformed list', async () => {
    const h = harness();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope({ followers: [{ id: '123', followerId: '2' }], aggregationData: { accounts: [] } }));
    vi.stubGlobal('fetch', fetch);
    await h.client.getFollowerPage('1', '456', h.session, h.signal);
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/api/v1/account/1/followersnew');
    expect(url.searchParams.get('before')).toBe('456');
    expect(url.searchParams.get('limit')).toBe('100');
    fetch.mockResolvedValueOnce(envelope({}));
    await expect(h.client.getFollowerPage('1', '0', h.session, h.signal)).rejects.toThrow();
  });
  it('does exactly one POST after a 503 and does not enter read retries', async () => {
    const h = harness();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    await expect(h.client.sendFollowerMessage('3', 'hello', '1', h.session, h.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
    const [, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('authorization')).toBe('session-token');
    expect(JSON.parse(String(init.body))).toMatchObject({ type: 1, groupId: '3', content: 'hello', attachments: [], likes: [], inReplyTo: null, scheduledFor: 0 });
  });
  it('refuses a success receipt for a different recipient/group', async () => {
    const h = harness();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope({ id: '99', groupId: '999', senderId: '1' }));
    vi.stubGlobal('fetch', fetch);
    await expect(h.client.sendFollowerMessage('3', 'hello', '1', h.session, h.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('refuses a group containing unexpected participants', async () => {
    const h = harness();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => envelope({ id: '3', users: [{ userId: '1' }, { userId: '99' }] }));
    vi.stubGlobal('fetch', fetch);
    await expect(h.client.createFollowerGroup('2', '1', h.session, h.signal)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
