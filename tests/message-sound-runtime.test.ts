import { describe, expect, it, vi } from 'vitest';
import {
  focusedFanslyConversation,
  handleMessageSoundMessage,
} from '../src/background/message-sound-runtime.js';
import type { MessageSoundService } from '../src/background/message-sound-service.js';

const RUNTIME = { id: 'chatgoose@gosling.agency', origin: 'moz-extension://abc/' };
const PROJECTION = {
  v: 1, id: '11', groupId: '22', senderId: '33', type: 1, createdAt: 1790571000,
  correlationId: null, inReplyTo: null, tip: false,
};

function fakeService() {
  return {
    handleIncoming: vi.fn(async () => 'played' as const),
    recordTap: vi.fn(),
    recordInvalid: vi.fn(),
    previewSound: vi.fn(async () => ({ ok: true as const })),
    status: vi.fn(async () => ({ v: 1 })),
  };
}

type Sender = browser.runtime.MessageSender;
const FANSLY_TAB: Sender = {
  id: RUNTIME.id, frameId: 0, url: 'https://fansly.com/messages/22', tab: { id: 7 } as browser.tabs.Tab,
};
const OPTIONS_PAGE: Sender = {
  id: RUNTIME.id, url: 'moz-extension://abc/options.html', tab: { id: 9 } as browser.tabs.Tab,
};

function call(service: ReturnType<typeof fakeService>, message: unknown, sender: Sender) {
  return handleMessageSoundMessage(service as unknown as MessageSoundService, message, sender, RUNTIME);
}

describe('messageSound runtime family (E145)', () => {
  it('declines every other message family synchronously', () => {
    const service = fakeService();
    expect(call(service, { type: 'followers', action: 'scan' }, FANSLY_TAB)).toBeUndefined();
    expect(call(service, null, FANSLY_TAB)).toBeUndefined();
    expect(call(service, 'messageSound', FANSLY_TAB)).toBeUndefined();
  });

  it('accepts incoming messages and tap states only from a Fansly top frame', async () => {
    const service = fakeService();
    await expect(call(service, { type: 'messageSound', action: 'incoming', message: PROJECTION }, FANSLY_TAB))
      .resolves.toEqual({ ok: true, outcome: 'played' });
    expect(service.handleIncoming).toHaveBeenCalledWith(7, PROJECTION);

    const refused = [
      { ...FANSLY_TAB, id: 'someone-else' },
      { ...FANSLY_TAB, frameId: 3 },
      { ...FANSLY_TAB, url: 'https://evil.example/' },
      { ...FANSLY_TAB, url: 'http://fansly.com/' },
      { ...FANSLY_TAB, tab: undefined },
      OPTIONS_PAGE,
    ];
    for (const sender of refused) {
      await expect(call(service, { type: 'messageSound', action: 'incoming', message: PROJECTION }, sender))
        .resolves.toMatchObject({ ok: false });
      await expect(call(service, {
        type: 'messageSound', action: 'tap',
        status: { v: 1, socket: 'open', framesSeen: 1, messagesParsed: 0, droppedByType: 0 },
      }, sender)).resolves.toMatchObject({ ok: false });
    }
    expect(service.handleIncoming).toHaveBeenCalledTimes(1);
    expect(service.recordTap).not.toHaveBeenCalled();
  });

  it('counts a malformed projection instead of deciding on it', async () => {
    const service = fakeService();
    await expect(call(service, {
      type: 'messageSound', action: 'incoming', message: { ...PROJECTION, senderId: 'x' },
    }, FANSLY_TAB)).resolves.toMatchObject({ ok: false });
    expect(service.recordInvalid).toHaveBeenCalledTimes(1);
    expect(service.handleIncoming).not.toHaveBeenCalled();
  });

  it('serves preview and status only to the extension pages', async () => {
    const service = fakeService();
    await expect(call(service, { type: 'messageSound', action: 'preview', tone: 'soft', volume: 70 }, OPTIONS_PAGE))
      .resolves.toEqual({ ok: true });
    await expect(call(service, { type: 'messageSound', action: 'status' }, OPTIONS_PAGE))
      .resolves.toEqual({ v: 1 });
    await expect(call(service, { type: 'messageSound', action: 'preview', tone: 'soft', volume: 70 }, FANSLY_TAB))
      .resolves.toMatchObject({ ok: false });
    await expect(call(service, { type: 'messageSound', action: 'status' }, FANSLY_TAB))
      .resolves.toMatchObject({ ok: false });
    await expect(call(service, { type: 'messageSound', action: 'preview', tone: 'siren', volume: 70 }, OPTIONS_PAGE))
      .resolves.toMatchObject({ ok: false });
    expect(service.previewSound).toHaveBeenCalledTimes(1);
    expect(service.status).toHaveBeenCalledTimes(1);
  });
});

describe('focusedFanslyConversation (E145)', () => {
  const windowWith = (focused: boolean, url?: string) => ({
    getLastFocused: vi.fn(async () => ({
      focused,
      tabs: [{ active: false, url: 'https://fansly.com/messages/1' }, { active: true, url }],
    })),
  }) as unknown as Pick<typeof browser.windows, 'getLastFocused'>;

  it('names the conversation in the active tab of the focused window', async () => {
    await expect(focusedFanslyConversation(windowWith(true, 'https://fansly.com/messages/42')))
      .resolves.toBe('42');
  });

  it('is null for an unfocused window, another site, or a non-chat Fansly page', async () => {
    await expect(focusedFanslyConversation(windowWith(false, 'https://fansly.com/messages/42'))).resolves.toBeNull();
    await expect(focusedFanslyConversation(windowWith(true, 'https://example.com/messages/42'))).resolves.toBeNull();
    await expect(focusedFanslyConversation(windowWith(true, 'https://fansly.com/creator/vault'))).resolves.toBeNull();
    await expect(focusedFanslyConversation(windowWith(true, undefined))).resolves.toBeNull();
  });
});
