import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TAP_STATUS_MIN_INTERVAL_MS, startSoundRelay } from '../src/content/sound-relay.js';
import {
  SOUND_BRIDGE_ARM_EVENT,
  SOUND_BRIDGE_FOLLOW_EVENT,
  SOUND_BRIDGE_MESSAGE_EVENT,
  SOUND_BRIDGE_RELAY_READY_EVENT,
  SOUND_BRIDGE_TAP_EVENT,
  type MessageSoundRequest,
} from '../src/shared/message-sound-protocol.js';

const PROJECTION = {
  v: 1, id: '11', groupId: '22', senderId: '33', type: 1, createdAt: 1790571000,
  correlationId: null, inReplyTo: null, tip: false,
};

let dom: InstanceType<typeof JSDOM> | null = null;

function mount(settings: unknown = { messageSoundEnabled: true }) {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://fansly.com/' });
  const window = dom.window as unknown as Window & typeof globalThis;
  vi.stubGlobal('CustomEvent', window.CustomEvent);
  const sent: MessageSoundRequest[] = [];
  const arms: unknown[] = [];
  let relayReady = 0;
  window.addEventListener(SOUND_BRIDGE_ARM_EVENT, (event) => arms.push((event as CustomEvent).detail));
  window.addEventListener(SOUND_BRIDGE_RELAY_READY_EVENT, () => {
    relayReady += 1;
  });
  let settingsListener: ((value: unknown) => void) | null = null;
  let now = 1_000;
  startSoundRelay({
    target: window,
    sendMessage: async (message) => {
      sent.push(message);
    },
    readSettings: async () => settings,
    onSettingsChanged: (listener) => {
      settingsListener = listener;
    },
    now: () => now,
  });
  const page = (name: string, detail: unknown) =>
    window.dispatchEvent(new window.CustomEvent(name, { detail }));
  return {
    window,
    sent,
    arms,
    relayReady: () => relayReady,
    page,
    advance: (ms: number) => {
      now += ms;
    },
    changeSettings: (value: unknown) => settingsListener?.(value),
  };
}

describe('sound relay (E145)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    dom?.window.close();
    dom = null;
  });

  it('asks the tap to repeat its state as soon as it listens', () => {
    const relay = mount();
    expect(relay.relayReady()).toBe(1);
  });

  it('forwards a valid projection and drops anything else', () => {
    const relay = mount();
    relay.page(SOUND_BRIDGE_MESSAGE_EVENT, JSON.stringify(PROJECTION));
    relay.page(SOUND_BRIDGE_MESSAGE_EVENT, JSON.stringify({ ...PROJECTION, id: 'abc' }));
    relay.page(SOUND_BRIDGE_MESSAGE_EVENT, '{broken');
    relay.page(SOUND_BRIDGE_MESSAGE_EVENT, JSON.stringify({ ...PROJECTION, extra: 'x'.repeat(5000) }));
    relay.page(SOUND_BRIDGE_MESSAGE_EVENT, undefined);
    expect(relay.sent).toEqual([{ type: 'messageSound', action: 'incoming', message: PROJECTION }]);
  });

  it('never forwards fields outside the projection', () => {
    const relay = mount();
    relay.page(SOUND_BRIDGE_MESSAGE_EVENT, JSON.stringify({ ...PROJECTION, content: 'secret text' }));
    expect(JSON.stringify(relay.sent)).not.toContain('secret text');
  });

  it('reports the tap state at most every 5 s unless the socket state changes', () => {
    const relay = mount();
    const status = (socket: string, framesSeen: number) => JSON.stringify({
      v: 1, socket, framesSeen, messagesParsed: 0, droppedByType: 0,
    });
    relay.page(SOUND_BRIDGE_TAP_EVENT, status('connecting', 0));
    relay.page(SOUND_BRIDGE_TAP_EVENT, status('open', 0));
    relay.page(SOUND_BRIDGE_TAP_EVENT, status('open', 1));
    relay.advance(TAP_STATUS_MIN_INTERVAL_MS);
    relay.page(SOUND_BRIDGE_TAP_EVENT, status('open', 2));
    relay.page(SOUND_BRIDGE_TAP_EVENT, '{"v":1,"socket":"exploded"}');
    expect(relay.sent.map((message) => message.action === 'tap' && message.status.framesSeen))
      .toEqual([0, 0, 2]);
  });

  it('arms the tap from the global switch and follows its changes', async () => {
    const relay = mount({ messageSoundEnabled: false, followSoundEnabled: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(relay.arms).toEqual(['off']);
    relay.changeSettings({ messageSoundEnabled: false, followSoundEnabled: true });
    relay.changeSettings(undefined);
    relay.changeSettings({ messageSoundEnabled: false, followSoundEnabled: false });
    // Either sound keeps the tap parsing; only both off disarm it.
    expect(relay.arms).toEqual(['off', 'on', 'on', 'off']);
  });

  it('E146: forwards a valid follow projection and drops a broken one', () => {
    const relay = mount();
    relay.page(SOUND_BRIDGE_FOLLOW_EVENT, JSON.stringify({ v: 1, id: '5', accountId: '6', followerId: '7' }));
    relay.page(SOUND_BRIDGE_FOLLOW_EVENT, JSON.stringify({ v: 1, id: '5', accountId: 'x', followerId: '7' }));
    expect(relay.sent).toEqual([
      { type: 'messageSound', action: 'follow', follow: { v: 1, id: '5', accountId: '6', followerId: '7' } },
    ]);
  });

  it('accepts a 2.7.0 tap status without followsParsed', () => {
    const relay = mount();
    relay.page(SOUND_BRIDGE_TAP_EVENT, JSON.stringify({ v: 1, socket: 'open', framesSeen: 1, messagesParsed: 0, droppedByType: 0 }));
    expect(relay.sent).toEqual([{
      type: 'messageSound', action: 'tap',
      status: { v: 1, socket: 'open', framesSeen: 1, messagesParsed: 0, followsParsed: 0, droppedByType: 0 },
    }]);
  });
});
