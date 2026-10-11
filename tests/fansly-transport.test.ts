import { afterEach, describe, expect, it, vi } from 'vitest';
import { FanslyClient } from '../src/background/fansly-client.js';
import {
  DIRECT_FANSLY_ROUTE,
  FANSLY_RELAY_WAIT_MS,
  FanslyRelayHub,
  createFanslyTransport,
  type FanslyRoute,
  type FanslyTransport,
  type FanslyWireRequest,
} from '../src/background/fansly-transport.js';
import { SessionStore } from '../src/background/session-store.js';
import { ChatGooseError } from '../src/shared/errors.js';
import type { FanslyRelayCommand, FanslyRelayRequest } from '../src/shared/fansly-relay-protocol.js';
import type { SessionTemplate } from '../src/shared/types.js';

const EXTENSION_ID = 'chatgoose@gosling.agency';
const RELAY_URL = 'moz-extension://uuid/fansly-relay.html';

interface FakeSender {
  id?: string;
  url?: string;
  frameId?: number;
  tab?: { id?: number };
}

function relayPort(sender: FakeSender) {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const commands: FanslyRelayCommand[] = [];
  let disconnected = false;
  const port = {
    name: 'chatgoose-fansly-relay',
    sender,
    postMessage: vi.fn((message: FanslyRelayCommand) => {
      if (disconnected) throw new Error('Attempt to postMessage on disconnected port');
      commands.push(message);
    }),
    disconnect: vi.fn(() => { disconnected = true; }),
    onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.add(listener) },
    onDisconnect: { addListener: (listener: () => void) => disconnectListeners.add(listener) },
  };
  const reply = (message: unknown) => { for (const listener of messageListeners) listener(message); };
  return {
    port: port as unknown as browser.runtime.Port,
    commands,
    reply,
    /** A complete answer, the way the frame sends it: head, then body. */
    answer: (id: string, status: number, body = '', headers: Array<[string, string]> = []) => {
      reply({ type: 'head', id, status, headers });
      reply({ type: 'body', id, body });
    },
    requests: () => commands.filter((command): command is FanslyRelayRequest => command.type === 'request'),
    drop: () => { disconnected = true; for (const listener of disconnectListeners) listener(); },
    get disconnected() { return disconnected; },
  };
}

const frameOf = (tabId: number, overrides: Partial<FakeSender> = {}) =>
  relayPort({ id: EXTENSION_ID, url: RELAY_URL, frameId: 17, tab: { id: tabId }, ...overrides });

function wire(method: 'GET' | 'POST' = 'GET', signal = new AbortController().signal): FanslyWireRequest {
  return {
    url: new URL('https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true'),
    method,
    headers: new Headers({ authorization: 'auth', 'fansly-client-ts': '1' }),
    ...(method === 'POST' ? { body: '{"a":1}' } : {}),
    signal,
  };
}

const hubWith = (...frames: Array<ReturnType<typeof frameOf>>) => {
  const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
  for (const frame of frames) hub.register(frame.port);
  return hub;
};
const routeOf = (hub: FanslyRelayHub, tabIds: number[], method: 'GET' | 'POST' = 'GET', signal = new AbortController().signal) =>
  hub.route(() => tabIds, method, signal);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('E149 FanslyRelayHub', () => {
  it('routes through the frame of a matching tab: the command leaves on send, the answer is a Response', async () => {
    const frame = frameOf(5);
    const route = await routeOf(hubWith(frame), [9, 5], 'POST');
    expect(route.tabId).toBe(5);
    expect(frame.commands).toEqual([]);

    const pending = route.send(wire('POST'));
    // Posted before send yields, like fetch: nothing can run in between.
    expect(frame.commands).toEqual([{
      type: 'request', id: '1', method: 'POST',
      url: 'https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true',
      headers: [['authorization', 'auth'], ['fansly-client-ts', '1']],
      body: '{"a":1}',
    }]);
    frame.answer('1', 429, 'slow down', [['content-type', 'text/plain'], ['retry-after', '7']]);
    const response = await pending;
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(await response.text()).toBe('slow down');
  });

  it('settles on the head: a status counts even when its body never arrives', async () => {
    const frame = frameOf(5);
    const pending = (await routeOf(hubWith(frame), [5])).send(wire());
    frame.reply({ type: 'head', id: '1', status: 401, headers: [] });
    const response = await pending;
    expect(response.status).toBe(401);
    frame.reply({ type: 'failure', id: '1', aborted: false });
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
  });

  it('keeps a 204 bodiless instead of throwing on the Response constructor', async () => {
    const frame = frameOf(5);
    const pending = (await routeOf(hubWith(frame), [5])).send(wire());
    frame.answer('1', 204);
    expect((await pending).status).toBe(204);
  });

  it('refuses ports that are not our relay page framed inside a tab', () => {
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const strangers = [
      relayPort({ id: 'other@ext', url: RELAY_URL, frameId: 17, tab: { id: 5 } }),
      relayPort({ id: EXTENSION_ID, url: 'moz-extension://uuid/options.html', frameId: 17, tab: { id: 5 } }),
      relayPort({ id: EXTENSION_ID, url: RELAY_URL, frameId: 0, tab: { id: 5 } }),
      relayPort({ id: EXTENSION_ID, url: RELAY_URL, frameId: 17 }),
    ];
    for (const stranger of strangers) {
      hub.register(stranger.port);
      expect(stranger.disconnected).toBe(true);
    }
  });

  it('a read waits for a tab that is still loading its frame; a write does not wait', async () => {
    vi.useFakeTimers();
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    await expect(routeOf(hub, [5], 'POST')).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });

    const read = routeOf(hub, [5]);
    await vi.advanceTimersByTimeAsync(1_000);
    const frame = frameOf(5);
    hub.register(frame.port);
    const pending = (await read).send(wire());
    frame.answer('1', 200, '{}');
    expect((await pending).status).toBe(200);
  });

  it('gives up on a read after the wait, and at once when no tab holds the session', async () => {
    vi.useFakeTimers();
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    await expect(routeOf(hub, [])).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });
    const read = routeOf(hub, [5]);
    const settled = expect(read).rejects.toBeInstanceOf(ChatGooseError);
    await vi.advanceTimersByTimeAsync(FANSLY_RELAY_WAIT_MS);
    await settled;
  });

  it('a dropped frame fails its requests like a dropped connection, before or after the head', async () => {
    const frame = frameOf(5);
    const hub = hubWith(frame);
    const route = await routeOf(hub, [5], 'POST');
    const beforeHead = route.send(wire('POST'));
    const afterHead = route.send(wire());
    frame.reply({ type: 'head', id: '2', status: 200, headers: [] });
    const response = await afterHead;
    frame.drop();
    await expect(beforeHead).rejects.toBeInstanceOf(TypeError);
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
    // The tab has no frame any more: a write fails at once, before dispatch.
    await expect(routeOf(hub, [5], 'POST')).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });
    // A route taken before the drop answers like a dead connection.
    await expect(route.send(wire('POST'))).rejects.toBeInstanceOf(TypeError);
  });

  it('a relay failure without an HTTP answer is a TypeError, like fetch', async () => {
    const frame = frameOf(5);
    const pending = (await routeOf(hubWith(frame), [5])).send(wire());
    frame.reply({ type: 'failure', id: '1', aborted: false });
    await expect(pending).rejects.toBeInstanceOf(TypeError);
  });

  it('an abort reaches the frame and rejects with the signal reason, on the response or on its body', async () => {
    const frame = frameOf(5);
    const route = await routeOf(hubWith(frame), [5]);
    const early = new AbortController();
    const first = route.send(wire('GET', early.signal));
    early.abort(new DOMException('Aborted', 'AbortError'));
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(frame.commands.at(-1)).toEqual({ type: 'abort', id: '1' });
    // A late answer for the aborted id is ignored.
    frame.answer('1', 200, '{}');

    const late = new AbortController();
    const second = route.send(wire('GET', late.signal));
    frame.reply({ type: 'head', id: '2', status: 200, headers: [] });
    const response = await second;
    late.abort(new DOMException('The operation timed out.', 'TimeoutError'));
    await expect(response.text()).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(frame.commands.at(-1)).toEqual({ type: 'abort', id: '2' });

    // An already aborted signal never posts a request, as fetch never sends one.
    const gone = new AbortController();
    gone.abort(new DOMException('Aborted', 'AbortError'));
    const before = frame.commands.length;
    await expect(route.send(wire('GET', gone.signal))).rejects.toMatchObject({ name: 'AbortError' });
    expect(frame.commands).toHaveLength(before);
  });

  it('a second frame of a tab never evicts the first: the old one finishes its request, new ones go to the newest', async () => {
    const first = frameOf(5);
    const hub = hubWith(first);
    const pending = (await routeOf(hub, [5])).send(wire());
    const second = frameOf(5);
    hub.register(second.port);
    // No eviction: an evicted frame would reconnect and evict back, forever.
    expect(first.disconnected).toBe(false);
    expect(second.disconnected).toBe(false);
    first.answer(first.requests()[0]!.id, 200, 'first');
    expect(await (await pending).text()).toBe('first');

    const next = (await routeOf(hub, [5])).send(wire());
    expect(second.requests()).toHaveLength(1);
    expect(first.requests()).toHaveLength(1);
    // The old frame going away leaves the newest one serving the tab.
    first.drop();
    second.answer(second.requests()[0]!.id, 200, 'second');
    expect(await (await next).text()).toBe('second');

    // And when the newest goes away, an older live frame takes over.
    const third = frameOf(5);
    hub.register(third.port);
    third.drop();
    const after = (await routeOf(hub, [5])).send(wire());
    expect(second.requests()).toHaveLength(2);
    second.answer(second.requests()[1]!.id, 200, 'again');
    expect(await (await after).text()).toBe('again');
  });

  it('a frame of another tab never answers for this session', async () => {
    vi.useFakeTimers();
    const other = frameOf(8);
    const read = routeOf(hubWith(other), [5]);
    const settled = expect(read).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });
    await vi.advanceTimersByTimeAsync(FANSLY_RELAY_WAIT_MS);
    await settled;
    expect(other.commands).toEqual([]);
  });
});

describe('E149 createFanslyTransport', () => {
  const session = { accountId: 'acc-1' } as SessionTemplate;

  it('off: the background request, exactly as before', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const relays = { route: vi.fn() };
    const transport = createFanslyTransport({ viaTab: async () => false, tabsFor: () => [5], relays });

    const route = await transport.route(session, 'GET', new AbortController().signal);
    expect(route).toBe(DIRECT_FANSLY_ROUTE);
    expect(route.tabId).toBeUndefined();
    await route.send(wire());
    expect(relays.route).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true'),
      expect.objectContaining({ method: 'GET', credentials: 'omit' }),
    );
  });

  it('on: the relay of the session\'s own tabs, never the direct route', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const tabsFor = vi.fn((value: SessionTemplate) => (value.accountId === 'acc-1' ? [5] : []));
    const viaRelay: FanslyRoute = { tabId: 5, send: vi.fn(async () => new Response('relay', { status: 200 })) };
    const relays = {
      route: vi.fn(async (tabIds: () => readonly number[], _method: 'GET' | 'POST', _signal: AbortSignal) => {
        if (!tabIds().length) throw new ChatGooseError('fansly_tab_unavailable');
        return viaRelay;
      }),
    };
    const transport = createFanslyTransport({ viaTab: async () => true, tabsFor, relays });

    await expect(transport.route(session, 'POST', new AbortController().signal)).resolves.toBe(viaRelay);
    expect(relays.route.mock.calls[0]![1]).toBe('POST');
    await expect(transport.route({ accountId: 'acc-2' } as SessionTemplate, 'GET', new AbortController().signal))
      .rejects.toMatchObject({ key: 'fansly_tab_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unreadable settings keep the route every install has had', async () => {
    const relays = { route: vi.fn() };
    const transport = createFanslyTransport({ viaTab: async () => { throw new Error('storage'); }, tabsFor: () => [5], relays });
    await expect(transport.route(session, 'GET', new AbortController().signal)).resolves.toBe(DIRECT_FANSLY_ROUTE);
    expect(relays.route).not.toHaveBeenCalled();
  });
});

describe('E149 FanslyClient on the tab route', () => {
  function harness(viaTab: boolean) {
    const store = new SessionStore();
    store.registerCapture(5, {
      accountId: 'acc-1', authorization: 'auth', fanslyClientId: 'cid', fanslySessionId: 'sid',
      fanslyClientTs: '1', fanslyClientCheck: 'check', routeKey: 'account',
    });
    const frame = frameOf(5);
    const hub = hubWith(frame);
    const client = new FanslyClient(store, undefined, createFanslyTransport({
      viaTab: async () => viaTab,
      tabsFor: (session) => store.getTabIdsForAccount(session.accountId),
      relays: hub,
    }));
    return { store, client, frame, hub, session: store.getSessionForTab(5)! };
  }

  it('reads the account through the tab frame with the captured session headers', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { client, frame, session } = harness(true);
    const pending = client.getAuthenticatedAccount(session, new AbortController().signal);
    await vi.waitFor(() => expect(frame.requests()).toHaveLength(1));
    const command = frame.requests()[0]!;
    expect(command).toMatchObject({ type: 'request', method: 'GET', url: 'https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true' });
    expect(Object.fromEntries(command.headers)).toMatchObject({ authorization: 'auth', 'fansly-client-id': 'cid', 'fansly-session-id': 'sid', 'fansly-client-check': 'check' });

    frame.answer(command.id, 200, JSON.stringify({ success: true, response: { account: { id: '777', username: 'ari' } } }), [['content-type', 'application/json']]);
    await expect(pending).resolves.toMatchObject({ id: '777', username: 'ari' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 401 through the tab still ends the session, even when its body never arrives', async () => {
    const { client, frame, session, store } = harness(true);
    const pending = client.getAuthenticatedAccount(session, new AbortController().signal);
    await vi.waitFor(() => expect(frame.requests()).toHaveLength(1));
    const { id } = frame.requests()[0]!;
    frame.reply({ type: 'head', id, status: 401, headers: [] });
    frame.reply({ type: 'failure', id, aborted: false });
    await expect(pending).rejects.toMatchObject({ key: 'session_expired' });
    expect(store.getSessionForTab(5)?.connected).toBe(false);
  });

  it('a 429 through the tab sets the read lane\'s cooldown even when its body breaks', async () => {
    const { client, frame, session } = harness(true);
    const paced = client.followerSession(session);
    const pending = client.getGroup('123', paced, new AbortController().signal, undefined, 'none');
    await vi.waitFor(() => expect(frame.requests()).toHaveLength(1));
    const { id } = frame.requests()[0]!;
    frame.reply({ type: 'head', id, status: 429, headers: [['retry-after', '600']] });
    frame.reply({ type: 'failure', id, aborted: false });
    await expect(pending).rejects.toMatchObject({ key: 'rate_limited' });
    expect(client.followerReadStatus(paced)?.cooldownUntil ?? 0).toBeGreaterThan(Date.now() + 60_000);
  });

  it('a follower message POST goes through the tab once; a lost frame leaves it unconfirmed, never retried', async () => {
    const { client, frame, session } = harness(true);
    const pending = client.sendFollowerMessage('123', 'hi', '777', session, new AbortController().signal);
    await vi.waitFor(() => expect(frame.requests()).toHaveLength(1));
    expect(frame.requests()[0]).toMatchObject({ method: 'POST', url: 'https://apiv3.fansly.com/api/v1/message?ngsw-bypass=true' });
    frame.drop();
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(frame.requests()).toHaveLength(1);
  });

  it('off: the same read goes to fetch and the frame stays idle', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, response: { account: { id: '777', username: 'ari' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { client, frame, session } = harness(false);
    await expect(client.getAuthenticatedAccount(session, new AbortController().signal)).resolves.toMatchObject({ id: '777' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(frame.commands).toEqual([]);
  });

  it('assertRoute: a no-op off; on, it waits for the frame like a read and names a missing one', async () => {
    const off = harness(false);
    await expect(off.client.assertRoute(off.session, new AbortController().signal)).resolves.toBeUndefined();
    const on = harness(true);
    await expect(on.client.assertRoute(on.session, new AbortController().signal)).resolves.toBeUndefined();
    on.frame.drop();
    vi.useFakeTimers();
    const waiting = on.client.assertRoute(on.session, new AbortController().signal);
    const settled = expect(waiting).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });
    await vi.advanceTimersByTimeAsync(FANSLY_RELAY_WAIT_MS);
    await settled;
  });
});

describe('E149 the identity check stays the last thing before dispatch', () => {
  function gated() {
    const store = new SessionStore();
    store.registerCapture(5, {
      accountId: 'acc-1', authorization: 'auth', fanslyClientId: 'cid', fanslySessionId: 'sid',
      fanslyClientTs: '1', fanslyClientCheck: null, routeKey: null,
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const send = vi.fn(async () => new Response(JSON.stringify({ success: true, response: {} }), { status: 200 }));
    const transport: FanslyTransport = { route: vi.fn(async () => { await gate; return { send }; }) };
    const client = new FanslyClient(store, undefined, transport);
    return { store, client, send, open, transport, session: client.followerSession(store.getSessionForTab(5)!) };
  }

  it('a session that ends while the route settles never gets its POST', async () => {
    const { store, client, send, open, transport, session } = gated();
    const pending = client.sendFollowerMessage('123', 'hi', '777', session, new AbortController().signal);
    await vi.waitFor(() => expect(transport.route).toHaveBeenCalledTimes(1));
    store.markDisconnected('acc-1');
    open();
    await expect(pending).rejects.toMatchObject({ key: 'chat_changed' });
    expect(send).not.toHaveBeenCalled();
  });

  it('a paced read whose session is replaced while the route settles is not sent with the old token', async () => {
    const { store, client, send, open, transport, session } = gated();
    const pending = client.getGroup('123', session, new AbortController().signal, undefined, 'none');
    await vi.waitFor(() => expect(transport.route).toHaveBeenCalledTimes(1));
    store.registerCapture(5, {
      accountId: 'acc-1', authorization: 'new-auth', fanslyClientId: 'cid', fanslySessionId: 'sid-2',
      fanslyClientTs: '2', fanslyClientCheck: null, routeKey: null,
    });
    open();
    await expect(pending).rejects.toMatchObject({ key: 'chat_changed' });
    expect(send).not.toHaveBeenCalled();
  });
});
