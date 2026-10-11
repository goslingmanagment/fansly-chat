import { afterEach, describe, expect, it, vi } from 'vitest';
import { FanslyClient } from '../src/background/fansly-client.js';
import {
  FANSLY_RELAY_WAIT_MS,
  FanslyRelayHub,
  createFanslyTransport,
  type FanslyTransportRequest,
} from '../src/background/fansly-transport.js';
import { SessionStore } from '../src/background/session-store.js';
import { ChatGooseError } from '../src/shared/errors.js';
import type { FanslyRelayCommand } from '../src/shared/fansly-relay-protocol.js';
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
  return {
    port: port as unknown as browser.runtime.Port,
    commands,
    reply: (message: unknown) => { for (const listener of messageListeners) listener(message); },
    drop: () => { disconnected = true; for (const listener of disconnectListeners) listener(); },
    get disconnected() { return disconnected; },
  };
}

const frameOf = (tabId: number, overrides: Partial<FakeSender> = {}) =>
  relayPort({ id: EXTENSION_ID, url: RELAY_URL, frameId: 17, tab: { id: tabId }, ...overrides });

function wire(method: 'GET' | 'POST' = 'GET', signal = new AbortController().signal): Omit<FanslyTransportRequest, 'session'> {
  return {
    url: new URL('https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true'),
    method,
    headers: new Headers({ authorization: 'auth', 'fansly-client-ts': '1' }),
    ...(method === 'POST' ? { body: '{"a":1}' } : {}),
    signal,
  };
}

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('E149 FanslyRelayHub', () => {
  it('sends through the frame of a matching tab and turns its answer into a Response', async () => {
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const frame = frameOf(5);
    hub.register(frame.port);
    const routed = vi.fn();

    const pending = hub.send(() => [9, 5], { ...wire('POST'), onTabRoute: routed });
    await flush();
    expect(routed).toHaveBeenCalledWith(5);
    expect(frame.commands).toEqual([{
      type: 'request', id: '1', method: 'POST',
      url: 'https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true',
      headers: [['authorization', 'auth'], ['fansly-client-ts', '1']],
      body: '{"a":1}',
    }]);

    frame.reply({ type: 'response', id: '1', status: 429, headers: [['content-type', 'text/plain'], ['retry-after', '7']], body: 'slow down' });
    const response = await pending;
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(await response.text()).toBe('slow down');
  });

  it('keeps a 204 bodiless instead of throwing on the Response constructor', async () => {
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const frame = frameOf(5);
    hub.register(frame.port);
    const pending = hub.send(() => [5], wire());
    await flush();
    frame.reply({ type: 'response', id: '1', status: 204, headers: [], body: '' });
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

    const write = hub.send(() => [5], wire('POST'));
    await expect(write).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });

    const read = hub.send(() => [5], wire());
    await vi.advanceTimersByTimeAsync(1_000);
    const frame = frameOf(5);
    hub.register(frame.port);
    await vi.advanceTimersByTimeAsync(0);
    expect(frame.commands).toHaveLength(1);
    frame.reply({ type: 'response', id: frame.commands[0]!.id, status: 200, headers: [], body: '{}' });
    expect((await read).status).toBe(200);
  });

  it('gives up on a read after the wait, and at once when no tab holds the session', async () => {
    vi.useFakeTimers();
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });

    await expect(hub.send(() => [], wire())).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });

    const read = hub.send(() => [5], wire());
    const settled = expect(read).rejects.toBeInstanceOf(ChatGooseError);
    await vi.advanceTimersByTimeAsync(FANSLY_RELAY_WAIT_MS);
    await settled;
  });

  it('a dropped frame fails its requests like a dropped connection', async () => {
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const frame = frameOf(5);
    hub.register(frame.port);
    const pending = hub.send(() => [5], wire('POST'));
    await flush();
    frame.drop();
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    // The tab has no frame any more: the next read waits, the next write fails.
    await expect(hub.send(() => [5], wire('POST'))).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });
  });

  it('a relay failure without an HTTP answer is a TypeError, like fetch', async () => {
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const frame = frameOf(5);
    hub.register(frame.port);
    const pending = hub.send(() => [5], wire());
    await flush();
    frame.reply({ type: 'failure', id: '1', aborted: false });
    await expect(pending).rejects.toBeInstanceOf(TypeError);
  });

  it('an abort reaches the frame and rejects with the signal reason', async () => {
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const frame = frameOf(5);
    hub.register(frame.port);
    const controller = new AbortController();
    const pending = hub.send(() => [5], wire('GET', controller.signal));
    await flush();
    controller.abort(new DOMException('Aborted', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(frame.commands.at(-1)).toEqual({ type: 'abort', id: '1' });
    // A late answer for the aborted id is ignored.
    frame.reply({ type: 'response', id: '1', status: 200, headers: [], body: '{}' });
  });

  it('a newer frame of the same tab replaces the old one and fails the old one\'s requests', async () => {
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const first = frameOf(5);
    hub.register(first.port);
    const pending = hub.send(() => [5], wire());
    await flush();
    const second = frameOf(5);
    hub.register(second.port);
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(first.disconnected).toBe(true);
    // The old frame's late disconnect must not evict the new one.
    first.drop();
    const next = hub.send(() => [5], wire());
    await flush();
    expect(second.commands).toHaveLength(1);
    second.reply({ type: 'response', id: second.commands[0]!.id, status: 200, headers: [], body: '{}' });
    expect((await next).status).toBe(200);
  });

  it('a frame of another tab never answers for this session', async () => {
    vi.useFakeTimers();
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const other = frameOf(8);
    hub.register(other.port);
    const read = hub.send(() => [5], wire());
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
    const relays = { send: vi.fn(), whenReady: vi.fn(async () => undefined) };
    const transport = createFanslyTransport({ viaTab: async () => false, tabsFor: () => [5], relays });

    await transport({ ...wire(), session });
    expect(relays.send).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true'),
      expect.objectContaining({ method: 'GET', credentials: 'omit' }),
    );
  });

  it('on: the relay of the session\'s own tabs, never the direct route', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const tabsFor = vi.fn((value: SessionTemplate) => (value.accountId === 'acc-1' ? [5] : []));
    const relays = {
      send: vi.fn(async (tabIds: () => readonly number[], _wire: Omit<FanslyTransportRequest, 'session'>) =>
        new Response(String(tabIds()), { status: 200 })),
      whenReady: vi.fn(async () => undefined),
    };
    const transport = createFanslyTransport({ viaTab: async () => true, tabsFor, relays });

    const response = await transport({ ...wire(), session });
    expect(await response.text()).toBe('5');
    expect(relays.send.mock.calls[0]![1]).not.toHaveProperty('session');

    relays.send.mockRejectedValueOnce(new ChatGooseError('fansly_tab_unavailable'));
    await expect(transport({ ...wire(), session })).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unreadable settings keep the route every install has had', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const relays = { send: vi.fn(), whenReady: vi.fn(async () => undefined) };
    const transport = createFanslyTransport({ viaTab: async () => { throw new Error('storage'); }, tabsFor: () => [5], relays });
    await transport({ ...wire(), session });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(relays.send).not.toHaveBeenCalled();
  });
});

describe('E149 route readiness before a send takes custody', () => {
  const session = { accountId: 'acc-1' } as SessionTemplate;

  it('off: always ready, nothing is asked of the relays', async () => {
    const relays = { send: vi.fn(), whenReady: vi.fn(async () => undefined) };
    const transport = createFanslyTransport({ viaTab: async () => false, tabsFor: () => [5], relays });
    await expect(transport.ready!(session, new AbortController().signal)).resolves.toBeUndefined();
    expect(relays.whenReady).not.toHaveBeenCalled();
  });

  it('on: waits for a frame of the session\'s tab like a read, and names a missing one', async () => {
    vi.useFakeTimers();
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const transport = createFanslyTransport({ viaTab: async () => true, tabsFor: () => [5], relays: hub });

    const waiting = transport.ready!(session, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(500);
    hub.register(frameOf(5).port);
    await expect(waiting).resolves.toBeUndefined();

    const missing = createFanslyTransport({ viaTab: async () => true, tabsFor: () => [], relays: hub });
    await expect(missing.ready!(session, new AbortController().signal)).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });
  });

  it('FanslyClient.assertRoute asks the transport and is a no-op for the direct one', async () => {
    const store = new SessionStore();
    store.registerCapture(5, { accountId: 'acc-1', authorization: 'a', fanslyClientId: 'c', fanslySessionId: 's', fanslyClientTs: '1', fanslyClientCheck: null, routeKey: null });
    const live = store.getSessionForTab(5)!;
    await expect(new FanslyClient(store).assertRoute(live, new AbortController().signal)).resolves.toBeUndefined();
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const viaTab = new FanslyClient(store, undefined, createFanslyTransport({ viaTab: async () => true, tabsFor: () => [], relays: hub }));
    await expect(viaTab.assertRoute(live, new AbortController().signal)).rejects.toMatchObject({ key: 'fansly_tab_unavailable' });
  });
});

describe('E149 FanslyClient on the tab route', () => {
  function harness(viaTab: boolean) {
    const store = new SessionStore();
    store.registerCapture(5, {
      accountId: 'acc-1', authorization: 'auth', fanslyClientId: 'cid', fanslySessionId: 'sid',
      fanslyClientTs: '1', fanslyClientCheck: 'check', routeKey: 'account',
    });
    const hub = new FanslyRelayHub({ extensionId: EXTENSION_ID, relayUrl: RELAY_URL });
    const frame = frameOf(5);
    hub.register(frame.port);
    const client = new FanslyClient(store, undefined, createFanslyTransport({
      viaTab: async () => viaTab,
      tabsFor: (session) => store.getTabIdsForAccount(session.accountId),
      relays: hub,
    }));
    return { store, client, frame, session: store.getSessionForTab(5)! };
  }

  it('reads the account through the tab frame with the captured session headers', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { client, frame, session } = harness(true);
    const pending = client.getAuthenticatedAccount(session, new AbortController().signal);
    await vi.waitFor(() => expect(frame.commands).toHaveLength(1));
    const command = frame.commands[0]!;
    expect(command).toMatchObject({ type: 'request', method: 'GET', url: 'https://apiv3.fansly.com/api/v1/account/me?ngsw-bypass=true' });
    const headers = Object.fromEntries((command as { headers: Array<[string, string]> }).headers);
    expect(headers).toMatchObject({ authorization: 'auth', 'fansly-client-id': 'cid', 'fansly-session-id': 'sid', 'fansly-client-check': 'check' });

    frame.reply({ type: 'response', id: command.id, status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify({ success: true, response: { account: { id: '777', username: 'ari' } } }) });
    await expect(pending).resolves.toMatchObject({ id: '777', username: 'ari' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 401 through the tab still ends the session, like a direct one', async () => {
    const { client, frame, session, store } = harness(true);
    const pending = client.getAuthenticatedAccount(session, new AbortController().signal);
    await vi.waitFor(() => expect(frame.commands).toHaveLength(1));
    frame.reply({ type: 'response', id: frame.commands[0]!.id, status: 401, headers: [], body: '' });
    await expect(pending).rejects.toMatchObject({ key: 'session_expired' });
    expect(store.getSessionForTab(5)?.connected).toBe(false);
  });

  it('a follower message POST goes through the tab once; a lost frame leaves it unconfirmed, never retried', async () => {
    const { client, frame, session } = harness(true);
    const pending = client.sendFollowerMessage('123', 'hi', '777', session, new AbortController().signal);
    await vi.waitFor(() => expect(frame.commands).toHaveLength(1));
    expect(frame.commands[0]).toMatchObject({ method: 'POST', url: 'https://apiv3.fansly.com/api/v1/message?ngsw-bypass=true' });
    frame.drop();
    await expect(pending).rejects.toBeInstanceOf(TypeError);
    expect(frame.commands).toHaveLength(1);
  });

  it('off: the same read goes to fetch and the frame stays idle', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, response: { account: { id: '777', username: 'ari' } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { client, frame, session } = harness(false);
    await expect(client.getAuthenticatedAccount(session, new AbortController().signal)).resolves.toMatchObject({ id: '777' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(frame.commands).toEqual([]);
  });
});
