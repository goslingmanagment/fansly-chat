import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FanslyClient } from '../src/background/fansly-client.js';
import { SessionStore } from '../src/background/session-store.js';
import { FollowersTrace } from '../src/background/followers-trace.js';

function harness() {
  const store = new SessionStore();
  const session = store.registerCapture(7, { accountId: '1', authorization: 'session-token', fanslyClientId: 'client-id', fanslySessionId: 'session-id', fanslyClientTs: '10', fanslyClientCheck: 'check', routeKey: 'message' });
  return { client: new FanslyClient(store), session, signal: new AbortController().signal };
}
const envelope = (response: unknown) => new Response(JSON.stringify({ success: true, response }), { status: 200 });

describe('Fansly browser-session outreach transport', () => {
  // Jitter off: these tests pin exact starts. `fansly-pacer.test.ts` covers it.
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
  it('escalates repeated throttles and carries the last cooldown beyond retry exhaustion', async () => {
    vi.useFakeTimers(); const h = harness(); const session = h.client.followerSession(h.session);
    const start = Date.now(), at: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => { at.push(Date.now() - start); return at.length <= 4 ? new Response('', { status: 429 }) : envelope({ messages: [] }); }));
    const work = h.client.getMessagePage('3', null, session, h.signal);
    const rejected = expect(work).rejects.toMatchObject({ key: 'rate_limited' });
    await vi.advanceTimersByTimeAsync(210_000); await rejected;
    expect(at).toEqual([0, 30_000, 90_000, 210_000]);
    // Four unhealed limits on an ordinary key: the lane gap is 400 ms doubled four times.
    expect(h.client.followerReadStatus(session)).toEqual({ cooldownUntil: start + 450_000, intervalMs: 6400 });
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
  it('counts only reads Fansly answered 2xx towards forgiving a penalty', async () => {
    vi.useFakeTimers();
    const h = harness(); const session = h.client.followerSession(h.session);
    let status = 429;
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => status === 200 ? envelope({ users: [] }) : new Response('', { status })));
    const settle = async (work: Promise<unknown>, ms: number) => { const done = work.then(() => 'ok', () => 'failed'); await vi.advanceTimersByTimeAsync(ms); return done; };
    // Two limits: the second level is the one the lane gap shows (800 ms).
    expect(await settle(h.client.getAccountNames(['2'], session, h.signal, 'none'), 0)).toBe('failed');
    expect(await settle(h.client.getAccountNames(['2'], session, h.signal, 'none'), 30_000)).toBe('failed');
    expect(h.client.followerReadStatus(session)?.intervalMs).toBe(800);
    await vi.advanceTimersByTimeAsync(60_000 + 300_000);
    status = 503;
    for (let i = 0; i < 20; i++) expect(await settle(h.client.getAccountNames(['2'], session, h.signal, 'none'), 20_000)).toBe('failed');
    status = 200;
    for (let i = 0; i < 20; i++) expect(await settle(h.client.getGroup('3', session, h.signal), 2000)).toBe('ok');
    expect(h.client.followerReadStatus(session)?.intervalMs).toBe(800);
    expect(await settle(h.client.getGroup('3', session, h.signal), 2000)).toBe('ok');
    expect(h.client.followerReadStatus(session)?.intervalMs).toBe(400);
  });
  it('earns nothing from a refusal inside HTTP 200 and traces its code, never its text', async () => {
    vi.useFakeTimers();
    const h = harness(); const session = h.client.followerSession(h.session);
    const trace = new FollowersTrace({ id: crypto.randomUUID(), tabId: 7, hours: 48, version: 'test', build: 'test' });
    let mode: 'limit' | 'refuse' | 'answer' = 'limit';
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => mode === 'limit' ? new Response('', { status: 429 })
      : mode === 'refuse' ? new Response(JSON.stringify({ success: false, error: { code: 22, details: 'private-detail' } }), { status: 200 })
      : envelope({ users: [] })));
    const settle = async (work: Promise<unknown>, ms: number) => { const done = work.then(() => 'ok', (error: unknown) => error); await vi.advanceTimersByTimeAsync(ms); return done; };
    await settle(h.client.getAccountNames(['2'], session, h.signal, 'none'), 0);
    await settle(h.client.getAccountNames(['2'], session, h.signal, 'none'), 30_000);
    expect(h.client.followerReadStatus(session)?.intervalMs).toBe(800);
    await vi.advanceTimersByTimeAsync(60_000 + 300_000);
    mode = 'refuse';
    for (let i = 0; i < 25; i++) expect(await settle(h.client.getGroup('3', session, h.signal, trace), 2000)).toMatchObject({ key: 'unknown_error', details: { status: 200, refused: true } });
    mode = 'answer';
    // Twenty-five refusals forgave nothing: the level still needs its twenty answers.
    for (let i = 0; i < 20; i++) expect(await settle(h.client.getGroup('3', session, h.signal), 2000)).toBe('ok');
    expect(h.client.followerReadStatus(session)?.intervalMs).toBe(800);
    expect(await settle(h.client.getGroup('3', session, h.signal), 2000)).toBe('ok');
    expect(h.client.followerReadStatus(session)?.intervalMs).toBe(400);
    const report = trace.read();
    expect(report.events.filter((event) => event.name === 'http.refused').map((event) => event.data)).toContainEqual({ status: 200, code: '22' });
    expect(JSON.stringify(report)).not.toContain('private-detail');
  });
  it('refuses to open a chat during a cooldown, never holds a message after custody, and counts a limited write', async () => {
    vi.useFakeTimers();
    const h = harness(); const session = h.client.followerSession(h.session);
    const trace = new FollowersTrace({ id: crypto.randomUUID(), tabId: 7, hours: 48, version: 'test', build: 'test' });
    const calls: Array<[string, string]> = [];
    let groupStatus = 200;
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname; calls.push([init?.method ?? 'GET', path]);
      if (init?.method === 'POST' && path.endsWith('/group')) return groupStatus === 200 ? envelope({ id: '3', users: [{ userId: '2' }, { userId: '1' }] }) : new Response(JSON.stringify({ success: false, error: { code: 99, details: 'private-detail' } }), { status: groupStatus, headers: { 'content-type': 'application/json' } });
      if (init?.method === 'POST') return envelope({ id: '99', groupId: '3', senderId: '1' });
      return new Response('', { status: 429 });
    }));
    const start = Date.now();
    await expect(h.client.getAccountNames(['2'], session, h.signal, 'none')).rejects.toMatchObject({ key: 'rate_limited' });
    // Opening a chat is refused at once, with the wait, and nothing is sent to Fansly.
    await expect(h.client.createFollowerGroup('2', '1', session, h.signal)).rejects.toMatchObject({ key: 'rate_limited', details: { retryAfterMs: 30_000 } });
    expect(calls.filter(([method]) => method === 'POST')).toEqual([]);
    expect(Date.now() - start).toBe(0);
    // A message is past the hub dispatch by now: holding it would outlive the
    // send deadline and leave a false «не подтверждено» for a message that never left.
    await expect(h.client.sendFollowerMessage('3', 'hello', '1', session, h.signal)).resolves.toBe('99');
    expect(Date.now() - start).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(h.client.createFollowerGroup('2', '1', session, h.signal)).resolves.toBe('3');
    // A refused write says what it was (status, Fansly's code), never what it said,
    // and a limited one opens the lane cooldown like a limited read.
    groupStatus = 403;
    await expect(h.client.createFollowerGroup('2', '1', session, h.signal, trace)).rejects.toMatchObject({ key: 'fansly_server_error', details: { status: 403, code: '99' } });
    groupStatus = 429; const limitedAt = Date.now();
    await expect(h.client.createFollowerGroup('2', '1', session, h.signal, trace)).rejects.toMatchObject({ key: 'fansly_server_error', details: { status: 429 } });
    expect(h.client.followerReadStatus(session)).toEqual({ cooldownUntil: limitedAt + 60_000, intervalMs: 800 });
    const report = trace.read();
    expect(report.events.filter((event) => event.name === 'http.error-body').map((event) => event.data.code)).toEqual(['99', '99']);
    expect(report.counters['http.start']).toBe(2);
    expect(JSON.stringify(report)).not.toContain('private-detail');
    // An ordinary chat client's session is not paced and is never refused
    // here: the write goes out and it is Fansly's own 429 that comes back.
    const posts = calls.filter(([method]) => method === 'POST').length;
    await expect(h.client.createFollowerGroup('2', '1', h.session, h.signal)).rejects.toMatchObject({ key: 'fansly_server_error', details: { status: 429 } });
    expect(calls.filter(([method]) => method === 'POST')).toHaveLength(posts + 1);
    // …while the paced session, now cooling down again, is refused locally and says so in the trace.
    await expect(h.client.createFollowerGroup('2', '1', session, h.signal, trace)).rejects.toMatchObject({ key: 'rate_limited' });
    expect(calls.filter(([method]) => method === 'POST')).toHaveLength(posts + 1);
    expect(trace.read().events.filter((event) => event.name === 'http.write-refused').map((event) => event.data.reason)).toEqual(['lane-cooling-down']);
  });
  it('marks a read that got no HTTP answer at all, whichever error key it keeps', async () => {
    const h = harness(); const session = h.client.followerSession(h.session);
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async () => { throw new TypeError('NetworkError when attempting to fetch resource.'); }));
    // The participant read is optional and keeps `unknown_error`; `status: 0` is what tells the row recheck it was the network.
    await expect(h.client.getGroup('3', session, h.signal)).rejects.toMatchObject({ key: 'unknown_error', details: { status: 0 } });
    await expect(h.client.getMessagePage('3', null, session, h.signal)).rejects.toMatchObject({ key: 'network_error' });
  });
  it('keeps account reads five seconds apart without widening the other routes', async () => {
    vi.useFakeTimers();
    const h = harness(); const session = h.client.followerSession(h.session);
    const at: Array<[string, number]> = []; const start = Date.now();
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>(async (url) => { at.push([new URL(String(url)).pathname, Date.now() - start]); return envelope([]); }));
    const work = Promise.all([
      h.client.getAccountNames(['2'], session, h.signal),
      h.client.getGroup('3', session, h.signal),
      h.client.getAccountNames(['4'], session, h.signal),
      h.client.getGroup('5', session, h.signal),
    ]);
    await vi.advanceTimersByTimeAsync(6000); await work;
    expect(at).toEqual([['/api/v1/account', 0], ['/api/v1/group/3/', 400], ['/api/v1/account', 5000], ['/api/v1/group/5/', 5400]]);
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
  it('records what a refused body is, never what it says', async () => {
    const h = harness(); const session = h.client.followerSession(h.session);
    const trace = new FollowersTrace({ id: crypto.randomUUID(), tabId: 7, hours: 48, version: 'test', build: 'test' });
    const api = JSON.stringify({ success: false, error: { code: 22, details: 'private-detail' } });
    const edge = '<html><body>private-page not found</body></html>';
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(api, { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } }))
      .mockResolvedValueOnce(new Response(edge, { status: 404, headers: { 'content-type': 'text/html' } }));
    vi.stubGlobal('fetch', fetch); vi.useFakeTimers();
    await expect(h.client.getGroup('3', session, h.signal, trace)).rejects.toMatchObject({ key: 'unknown_error' });
    const second = expect(h.client.getGroup('3', session, h.signal, trace)).rejects.toMatchObject({ key: 'unknown_error' });
    await vi.advanceTimersByTimeAsync(500); await second;
    // A 404 is not a throttle: one attempt each, no cooldown, no slower pace.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(h.client.followerReadStatus(session)).toEqual({ cooldownUntil: 0, intervalMs: 400 });
    const report = trace.read();
    expect(report.events.filter((event) => event.name === 'http.error-body').map((event) => event.data)).toEqual([
      { status: 404, contentType: 'application/json', length: api.length, json: true, code: '22' },
      { status: 404, contentType: 'text/html', length: edge.length, json: false, code: null },
    ]);
    for (const secret of ['private-detail', 'private-page']) expect(JSON.stringify(report)).not.toContain(secret);
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
    expect(h.client.followerReadStatus(one)).toEqual({ cooldownUntil: started + 90_000, intervalMs: 800 });
    await vi.advanceTimersByTimeAsync(89_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4001); await work;
    expect(timestamps.map((time) => time - started)).toEqual([0, 90_000, 91_000, 92_000]);
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
    expect(at.map((value) => value - at[0]!)).toEqual([0, 400, 800, 1300]);
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
