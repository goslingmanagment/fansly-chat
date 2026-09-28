import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it } from 'vitest';
import { installPageSocketTap } from '../src/content/page-socket-tap.js';
import {
  SOUND_BRIDGE_ARM_EVENT,
  SOUND_BRIDGE_MESSAGE_EVENT,
  SOUND_BRIDGE_RELAY_READY_EVENT,
  SOUND_BRIDGE_TAP_EVENT,
} from '../src/shared/message-sound-protocol.js';

type TestWindow = Window & typeof globalThis;

const FAN_FRAME = JSON.stringify({
  t: 10000,
  d: JSON.stringify({
    serviceId: 5,
    event: JSON.stringify({
      type: 1,
      message: { id: '11', groupId: '22', senderId: '33', type: 1, createdAt: 1790571000, attachments: [] },
    }),
  }),
});

let dom: InstanceType<typeof JSDOM> | null = null;

/** A stand-in for the browser's native WebSocket, recording what the page does
 * with it so a test can prove the tap changed nothing. */
function mountPage(): { window: TestWindow; created: FakeSocketInstance[]; FakeSocket: FakeSocketClass } {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fansly.com/messages/22' });
  const window = dom.window as unknown as TestWindow;
  const created: FakeSocketInstance[] = [];
  class FakeSocket extends window.EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly url: string;
    binaryType = 'blob';
    readyState = 0;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    readonly sent: unknown[] = [];
    closed = false;
    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      if (String(url) === 'wss://explode.example') throw new window.DOMException('bad url', 'SyntaxError');
      this.url = String(url);
      void protocols;
      created.push(this as unknown as FakeSocketInstance);
    }
    send(data: unknown): void {
      this.sent.push(data);
    }
    close(): void {
      this.closed = true;
      this.readyState = 3;
      const event = new window.Event('close');
      this.onclose?.(event);
      this.dispatchEvent(event);
    }
    open(): void {
      this.readyState = 1;
      const event = new window.Event('open');
      this.onopen?.(event);
      this.dispatchEvent(event);
    }
    receive(data: unknown): void {
      const event = new window.MessageEvent('message', { data });
      this.onmessage?.(event);
      this.dispatchEvent(event);
    }
  }
  Object.defineProperty(window, 'WebSocket', { configurable: true, writable: true, value: FakeSocket });
  return { window, created, FakeSocket: FakeSocket as unknown as FakeSocketClass };
}

interface FakeSocketInstance extends EventTarget {
  url: string;
  binaryType: string;
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  sent: unknown[];
  closed: boolean;
  send(data: unknown): void;
  close(): void;
  open(): void;
  receive(data: unknown): void;
}
type FakeSocketClass = { new (url: string): FakeSocketInstance; OPEN: number; CLOSED: number };

function bridge(window: TestWindow, name: string): unknown[] {
  const seen: unknown[] = [];
  window.addEventListener(name, (event) => {
    seen.push(JSON.parse((event as CustomEvent<string>).detail));
  });
  return seen;
}

describe('page socket tap (E145)', () => {
  afterEach(() => {
    dom?.window.close();
    dom = null;
  });

  it('replays Fansly setUpConnection exactly: the page keeps its native socket and every frame', () => {
    const { window, created, FakeSocket } = mountPage();
    const messages = bridge(window, SOUND_BRIDGE_MESSAGE_EVENT);
    expect(installPageSocketTap(window)).toBe(true);

    // main.51b59e98940f00c0.js: `this.con_=new WebSocket(this.uri_),this.con_.binaryType="arraybuffer",…`
    const Wrapped = window.WebSocket as unknown as FakeSocketClass;
    const con = new Wrapped('wss://wsv3.fansly.com?v=3');
    con.binaryType = 'arraybuffer';
    const pageFrames: unknown[] = [];
    con.onmessage = (event) => pageFrames.push(event.data);
    con.onopen = () => undefined;
    con.open();
    con.send('{"t":1,"d":"{}"}');
    con.receive(FAN_FRAME);
    con.receive(new ArrayBuffer(4));

    expect(created).toHaveLength(1);
    expect(con).toBe(created[0]);
    expect(con).toBeInstanceOf(FakeSocket);
    expect(con).toBeInstanceOf(Wrapped);
    expect(Wrapped.OPEN).toBe(1);
    expect(Wrapped.CLOSED).toBe(3);
    expect(Object.getPrototypeOf(con)).toBe(FakeSocket.prototype);
    expect(con.binaryType).toBe('arraybuffer');
    expect(con.sent).toEqual(['{"t":1,"d":"{}"}']);
    expect(pageFrames).toEqual([FAN_FRAME, expect.any(ArrayBuffer)]);
    expect(messages).toEqual([expect.objectContaining({ id: '11', groupId: '22', senderId: '33', type: 1 })]);
  });

  it('observes every reconnect, since Fansly builds a new socket each time', () => {
    const { window } = mountPage();
    const messages = bridge(window, SOUND_BRIDGE_MESSAGE_EVENT);
    installPageSocketTap(window);
    const Wrapped = window.WebSocket as unknown as FakeSocketClass;
    const first = new Wrapped('wss://wsv3.fansly.com?v=3');
    first.close();
    const second = new Wrapped('wss://wsv3.fansly.com?v=3');
    second.receive(FAN_FRAME);
    expect(messages).toHaveLength(1);
  });

  it('lets a constructor exception reach the page and creates no second socket', () => {
    const { window, created } = mountPage();
    installPageSocketTap(window);
    const Wrapped = window.WebSocket as unknown as FakeSocketClass;
    expect(() => new Wrapped('wss://explode.example')).toThrow('bad url');
    expect(created).toHaveLength(0);
  });

  it('supports subclassing through new.target', () => {
    const { window, FakeSocket } = mountPage();
    installPageSocketTap(window);
    const Wrapped = window.WebSocket as unknown as FakeSocketClass;
    class Child extends Wrapped {}
    const child = new Child('wss://wsv3.fansly.com?v=3');
    expect(child).toBeInstanceOf(Child);
    expect(child).toBeInstanceOf(FakeSocket);
  });

  it('ignores every other socket — the livestream chat included', () => {
    const { window } = mountPage();
    const messages = bridge(window, SOUND_BRIDGE_MESSAGE_EVENT);
    const statuses = bridge(window, SOUND_BRIDGE_TAP_EVENT);
    installPageSocketTap(window);
    statuses.length = 0;
    const Wrapped = window.WebSocket as unknown as FakeSocketClass;
    for (const url of ['wss://chatws.fansly.com?v=3', 'ws://wsv3.fansly.com', 'wss://wsv3.fansly.com.evil.example']) {
      new Wrapped(url).receive(FAN_FRAME);
    }
    expect(messages).toEqual([]);
    expect(statuses).toEqual([]);
  });

  it('reports its state, repeats it for a late relay, and counts frames', () => {
    const { window } = mountPage();
    const statuses = bridge(window, SOUND_BRIDGE_TAP_EVENT);
    installPageSocketTap(window);
    expect(statuses.at(-1)).toEqual({ v: 1, socket: 'none', framesSeen: 0, messagesParsed: 0, droppedByType: 0 });
    const Wrapped = window.WebSocket as unknown as FakeSocketClass;
    const con = new Wrapped('wss://wsv3.fansly.com?v=3');
    con.open();
    con.receive(FAN_FRAME);
    con.receive('{"t":2,"d":"{}"}');
    window.dispatchEvent(new window.CustomEvent(SOUND_BRIDGE_RELAY_READY_EVENT));
    expect(statuses.at(-1)).toEqual({ v: 1, socket: 'open', framesSeen: 2, messagesParsed: 1, droppedByType: 0 });
  });

  it('stops parsing while disarmed by the global switch', () => {
    const { window } = mountPage();
    const messages = bridge(window, SOUND_BRIDGE_MESSAGE_EVENT);
    installPageSocketTap(window);
    const con = new (window.WebSocket as unknown as FakeSocketClass)('wss://wsv3.fansly.com?v=3');
    window.dispatchEvent(new window.CustomEvent(SOUND_BRIDGE_ARM_EVENT, { detail: 'off' }));
    con.receive(FAN_FRAME);
    expect(messages).toEqual([]);
    window.dispatchEvent(new window.CustomEvent(SOUND_BRIDGE_ARM_EVENT, { detail: 'on' }));
    con.receive(FAN_FRAME);
    expect(messages).toHaveLength(1);
  });

  it('never lets a failure of ours reach the page handler', () => {
    const { window } = mountPage();
    installPageSocketTap(window);
    window.dispatchEvent = () => {
      throw new Error('bridge down');
    };
    const con = new (window.WebSocket as unknown as FakeSocketClass)('wss://wsv3.fansly.com?v=3');
    const pageFrames: unknown[] = [];
    con.onmessage = (event) => pageFrames.push(event.data);
    expect(() => con.receive(FAN_FRAME)).not.toThrow();
    expect(pageFrames).toEqual([FAN_FRAME]);
  });

  it('installs once per document', () => {
    const { window } = mountPage();
    expect(installPageSocketTap(window)).toBe(true);
    const once = window.WebSocket;
    expect(installPageSocketTap(window)).toBe(false);
    expect(window.WebSocket).toBe(once);
  });
});
