import { describe, expect, it, vi } from 'vitest';
import { startFanslyRelay } from '../src/fansly-relay/index.js';
import {
  parseFanslyRelayCommand,
  parseFanslyRelayReply,
} from '../src/shared/fansly-relay-protocol.js';

const URL_OK = 'https://apiv3.fansly.com/api/v1/message?groupId=1&ngsw-bypass=true';

function fakePort() {
  const messageListeners = new Set<(message: unknown) => void>();
  const disconnectListeners = new Set<() => void>();
  const posted: unknown[] = [];
  let dead = false;
  return {
    port: {
      postMessage: (message: unknown) => {
        if (dead) throw new Error('Attempt to postMessage on disconnected port');
        posted.push(message);
      },
      onMessage: { addListener: (listener: (message: unknown) => void) => messageListeners.add(listener) },
      onDisconnect: { addListener: (listener: () => void) => disconnectListeners.add(listener) },
    } as unknown as browser.runtime.Port,
    posted,
    deliver: (message: unknown) => { for (const listener of messageListeners) listener(message); },
    disconnect: () => { dead = true; for (const listener of disconnectListeners) listener(); },
  };
}

function mount(fetchImpl: (url: string, init: RequestInit) => Promise<Response>) {
  const ports: Array<ReturnType<typeof fakePort>> = [];
  const timers: Array<{ callback: () => void; delayMs: number }> = [];
  let now = 0;
  let failConnect = false;
  const fetchMock = vi.fn(fetchImpl);
  startFanslyRelay({
    connect: () => {
      if (failConnect) throw new Error('Extension context invalidated');
      const next = fakePort();
      ports.push(next);
      return next.port;
    },
    fetch: fetchMock,
    setTimeout: (callback, delayMs) => { timers.push({ callback, delayMs }); },
    now: () => now,
  });
  return {
    ports,
    timers,
    fetchMock,
    advance: (ms: number) => { now += ms; },
    setFailConnect: (value: boolean) => { failConnect = value; },
    runTimer: () => timers.shift()!.callback(),
  };
}

const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

describe('E149 relay protocol', () => {
  it('accepts only GET and POST to the Fansly API prefix', () => {
    const base = { type: 'request', id: '1', method: 'GET', url: URL_OK, headers: [['authorization', 'a']] };
    expect(parseFanslyRelayCommand(base)).toEqual(base);
    expect(parseFanslyRelayCommand({ ...base, method: 'POST', body: '{}' })).toEqual({ ...base, method: 'POST', body: '{}' });
    expect(parseFanslyRelayCommand({ type: 'abort', id: '1' })).toEqual({ type: 'abort', id: '1' });
    for (const url of [
      'https://fansly.com/api/v1/message',
      'https://apiv3.fansly.com.evil.example/api/v1/message',
      'http://apiv3.fansly.com/api/v1/message',
      'https://apiv3.fansly.com/other',
      'https://gosling-agency.ru/api/v1/pages',
      'moz-extension://x/options.html',
      42,
    ]) {
      expect(parseFanslyRelayCommand({ ...base, url }), String(url)).toBeNull();
    }
    for (const broken of [
      null, 'request', { ...base, id: '' }, { ...base, id: 7 }, { ...base, method: 'DELETE' }, { ...base, type: 'other' },
      { ...base, headers: [['a']] }, { ...base, headers: 'a' }, { ...base, headers: [['a', 1]] }, { ...base, body: {} },
    ]) {
      expect(parseFanslyRelayCommand(broken)).toBeNull();
    }
  });

  it('reads replies strictly', () => {
    expect(parseFanslyRelayReply({ type: 'response', id: '1', status: 200, headers: [['content-type', 'application/json']], body: '{}' }))
      .toEqual({ type: 'response', id: '1', status: 200, headers: [['content-type', 'application/json']], body: '{}' });
    expect(parseFanslyRelayReply({ type: 'failure', id: '1', aborted: true })).toEqual({ type: 'failure', id: '1', aborted: true });
    expect(parseFanslyRelayReply({ type: 'failure', id: '1' })).toEqual({ type: 'failure', id: '1', aborted: false });
    for (const broken of [
      null, {}, { type: 'response', id: '1', status: '200', headers: [], body: '' }, { type: 'response', id: '1', status: 200.5, headers: [], body: '' },
      { type: 'response', id: '1', status: 200, headers: [], body: null }, { type: 'response', id: '', status: 200, headers: [], body: '' },
    ]) {
      expect(parseFanslyRelayReply(broken)).toBeNull();
    }
  });
});

describe('E149 relay frame', () => {
  it('performs the request it is handed and returns status, the three headers and the body', async () => {
    const relay = mount(async () => new Response('{"success":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'retry-after': '3', 'x-amz-cf-pop': 'FRA1', 'set-cookie': 'a=b' },
    }));
    relay.ports[0]!.deliver({ type: 'request', id: '7', method: 'GET', url: URL_OK, headers: [['authorization', 'auth'], ['fansly-client-id', 'cid']] });
    await flush();

    expect(relay.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = relay.fetchMock.mock.calls[0]!;
    expect(url).toBe(URL_OK);
    expect(init).toMatchObject({ method: 'GET', credentials: 'omit', headers: [['authorization', 'auth'], ['fansly-client-id', 'cid']] });
    expect(init).not.toHaveProperty('body');
    expect(relay.ports[0]!.posted).toEqual([{
      type: 'response', id: '7', status: 200,
      headers: [['content-type', 'application/json'], ['retry-after', '3']],
      body: '{"success":true}',
    }]);
  });

  it('passes a POST body through unchanged and reports an HTTP refusal as a response', async () => {
    const relay = mount(async () => new Response('Too Many Requests', { status: 429 }));
    relay.ports[0]!.deliver({ type: 'request', id: '8', method: 'POST', url: 'https://apiv3.fansly.com/api/v1/message?ngsw-bypass=true', headers: [['content-type', 'application/json']], body: '{"content":"hi"}' });
    await flush();

    expect(relay.fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST', body: '{"content":"hi"}', credentials: 'omit' });
    expect(relay.ports[0]!.posted).toEqual([expect.objectContaining({ type: 'response', id: '8', status: 429, body: 'Too Many Requests' })]);
  });

  it('never fetches anything outside the Fansly API, whatever the port says', async () => {
    const relay = mount(async () => new Response('', { status: 200 }));
    relay.ports[0]!.deliver({ type: 'request', id: '1', method: 'GET', url: 'https://gosling-agency.ru/api/v1/auth/me', headers: [] });
    relay.ports[0]!.deliver({ type: 'request', id: '2', method: 'DELETE', url: URL_OK, headers: [] });
    relay.ports[0]!.deliver({ type: 'nonsense' });
    await flush();

    expect(relay.fetchMock).not.toHaveBeenCalled();
    expect(relay.ports[0]!.posted).toEqual([]);
  });

  it('aborts the one request it is told to and answers with an aborted failure', async () => {
    const signals: AbortSignal[] = [];
    const relay = mount((_url, init) => new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    relay.ports[0]!.deliver({ type: 'request', id: '1', method: 'GET', url: URL_OK, headers: [] });
    relay.ports[0]!.deliver({ type: 'request', id: '2', method: 'GET', url: URL_OK, headers: [] });
    // A second command with a live id is not a second request.
    relay.ports[0]!.deliver({ type: 'request', id: '2', method: 'GET', url: URL_OK, headers: [] });
    await flush();
    expect(relay.fetchMock).toHaveBeenCalledTimes(2);

    relay.ports[0]!.deliver({ type: 'abort', id: '1' });
    await flush();

    expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
    expect(relay.ports[0]!.posted).toEqual([{ type: 'failure', id: '1', aborted: true }]);
  });

  it('reports a request that got no HTTP answer as a plain failure', async () => {
    const relay = mount(async () => { throw new TypeError('NetworkError when attempting to fetch resource.'); });
    relay.ports[0]!.deliver({ type: 'request', id: '3', method: 'GET', url: URL_OK, headers: [] });
    await flush();

    expect(relay.ports[0]!.posted).toEqual([{ type: 'failure', id: '3', aborted: false }]);
  });

  it('drops its requests when the background goes away and reconnects with a growing pause', async () => {
    const signals: AbortSignal[] = [];
    const relay = mount((_url, init) => new Promise((_resolve, reject) => {
      const signal = init.signal as AbortSignal;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    relay.ports[0]!.deliver({ type: 'request', id: '1', method: 'GET', url: URL_OK, headers: [] });
    await flush();

    relay.ports[0]!.disconnect();
    await flush();
    expect(signals[0]!.aborted).toBe(true);
    // Nobody is left to hear the failure; a dead port must not throw out of the frame.
    expect(relay.ports[0]!.posted).toEqual([]);
    expect(relay.timers.map((timer) => timer.delayMs)).toEqual([100]);

    // A port that is refused at once backs off instead of spinning.
    relay.runTimer();
    relay.ports[1]!.disconnect();
    relay.runTimer();
    relay.ports[2]!.disconnect();
    relay.runTimer();
    relay.ports[3]!.disconnect();
    relay.runTimer();
    relay.ports[4]!.disconnect();
    expect(relay.timers.map((timer) => timer.delayMs)).toEqual([5_000]);

    // A connection that held is a fresh start for the next loss.
    relay.runTimer();
    relay.advance(6_000);
    relay.ports[5]!.disconnect();
    expect(relay.timers.map((timer) => timer.delayMs)).toEqual([100]);
  });

  it('keeps trying when the extension context cannot open a port yet', () => {
    const relay = mount(async () => new Response('', { status: 200 }));
    relay.ports[0]!.disconnect();
    relay.setFailConnect(true);
    relay.runTimer();
    expect(relay.ports).toHaveLength(1);
    expect(relay.timers).toHaveLength(1);
    relay.setFailConnect(false);
    relay.runTimer();
    expect(relay.ports).toHaveLength(2);
  });
});
