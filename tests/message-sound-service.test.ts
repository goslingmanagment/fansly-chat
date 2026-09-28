import { describe, expect, it } from 'vitest';
import { createDefaultSettings } from '../src/shared/migrations.js';
import type { FanslyIncomingMessage } from '../src/shared/fansly-ws-frame.js';
import type { TabSessionIdentity } from '../src/shared/message-sound-decision.js';
import type { MessageSoundTone } from '../src/shared/message-sound-protocol.js';
import type { Settings } from '../src/shared/types.js';
import type { MessageSoundPlayer } from '../src/background/message-sound-player.js';
import {
  MessageSoundService,
  type MessageSoundState,
} from '../src/background/message-sound-service.js';

const NOW = 1_790_571_000_000;
const MODEL = '200';
const FAN = '999';

function message(overrides: Partial<FanslyIncomingMessage> = {}): FanslyIncomingMessage {
  return {
    v: 1, id: '5000', groupId: '6000', senderId: FAN, type: 1,
    createdAt: NOW / 1000 - 2, correlationId: null, inReplyTo: null, tip: false,
    ...overrides,
  };
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(options: {
  settings?: Partial<Settings>;
  sessions?: Record<number, TabSessionIdentity | null>;
  focusedGroupId?: string | null;
  openTabs?: number[];
  prepareOk?: boolean;
} = {}) {
  const state: MessageSoundState = {
    settings: { ...createDefaultSettings(), ...options.settings },
    knownAccounts: [MODEL],
    accountAliases: {},
  };
  const sessions: Record<number, TabSessionIdentity | null> = options.sessions ?? {
    1: { accountId: MODEL, resolvedAccountId: MODEL },
    2: { accountId: MODEL, resolvedAccountId: MODEL },
  };
  const openTabs = new Set(options.openTabs ?? [1, 2]);
  let focusedGroupId = options.focusedGroupId ?? null;
  let clock = NOW;
  let monotonic = 10_000;
  const played: Array<{ tone: MessageSoundTone; volume: number }> = [];
  let prepareGate: Deferred | null = null;
  let onPrepare: (() => void) | null = null;
  const player: MessageSoundPlayer = {
    prepare: async () => {
      onPrepare?.();
      if (prepareGate) await prepareGate.promise;
      return options.prepareOk ?? true;
    },
    start: (tone, volume) => {
      played.push({ tone, volume });
      return { stop: () => undefined };
    },
    diagnostics: () => ({ state: 'running', lastError: null }),
  };
  const service = new MessageSoundService({
    getState: async () => state,
    getTabSession: (tabId) => sessions[tabId] ?? null,
    isTabOpen: async (tabId) => openTabs.has(tabId),
    focusedConversationGroupId: async () => focusedGroupId,
    listFanslyTabIds: async () => [...openTabs],
    player,
    now: () => clock,
    monotonic: () => monotonic,
  });
  return {
    service,
    state,
    sessions,
    played,
    openTabs,
    setFocused: (groupId: string | null) => {
      focusedGroupId = groupId;
    },
    advance: (ms: number) => {
      clock += ms;
      monotonic += ms;
    },
    holdPrepare: () => {
      prepareGate = deferred();
      return prepareGate;
    },
    onPrepare: (callback: () => void) => {
      onPrepare = callback;
    },
  };
}

describe('MessageSoundService (E145)', () => {
  it('plays a fan message with the chosen tone and volume', async () => {
    const test = harness({ settings: { messageSoundTone: 'double', messageSoundVolume: 80 } });
    expect(await test.service.handleIncoming(1, message())).toBe('played');
    expect(test.played).toEqual([{ tone: 'double', volume: 80 }]);
  });

  it('rings once when the same message reaches two tabs', async () => {
    const test = harness();
    const outcomes = await Promise.all([
      test.service.handleIncoming(1, message()),
      test.service.handleIncoming(2, message()),
    ]);
    expect(outcomes).toEqual(['played', 'duplicate']);
    expect(test.played).toHaveLength(1);
  });

  it('throttles to one blip per 2 s; a silenced message does not spend the pause', async () => {
    const test = harness();
    expect(await test.service.handleIncoming(1, message({ id: '1' }))).toBe('played');
    test.advance(1_000);
    expect(await test.service.handleIncoming(1, message({ id: '2' }))).toBe('throttled');
    expect(await test.service.handleIncoming(1, message({ id: '3', senderId: MODEL }))).toBe('own');
    test.advance(1_000);
    expect(await test.service.handleIncoming(1, message({ id: '4' }))).toBe('played');
    // A throttled message is consumed: it never rings later.
    test.advance(5_000);
    expect(await test.service.handleIncoming(2, message({ id: '2' }))).toBe('duplicate');
  });

  it('stays silent for the chat open in the focused window, rings for any other', async () => {
    const test = harness({ focusedGroupId: '6000' });
    expect(await test.service.handleIncoming(1, message({ id: '1' }))).toBe('open-chat');
    test.setFocused('6001');
    expect(await test.service.handleIncoming(1, message({ id: '2' }))).toBe('played');
    test.advance(3_000);
    test.setFocused(null);
    expect(await test.service.handleIncoming(1, message({ id: '3' }))).toBe('played');
  });

  it('re-checks the switch, the tab and the focus after a slow audio start', async () => {
    // Each change lands while the player is waking up — after the first gate
    // has already let the message through.
    const test = harness();
    test.onPrepare(() => {
      test.state.settings = { ...test.state.settings, messageSoundEnabled: false };
    });
    expect(await test.service.handleIncoming(1, message({ id: '1' }))).toBe('disabled');

    test.state.settings = { ...test.state.settings, messageSoundEnabled: true };
    test.onPrepare(() => {
      test.state.settings = { ...test.state.settings, messageSoundMutedAccountIds: [MODEL] };
    });
    expect(await test.service.handleIncoming(1, message({ id: '2' }))).toBe('muted');

    test.state.settings = { ...test.state.settings, messageSoundMutedAccountIds: [] };
    test.onPrepare(() => test.setFocused('6000'));
    expect(await test.service.handleIncoming(1, message({ id: '3' }))).toBe('open-chat');

    test.setFocused(null);
    test.onPrepare(() => test.openTabs.delete(1));
    expect(await test.service.handleIncoming(1, message({ id: '4' }))).toBe('tab-closed');
    expect(test.played).toEqual([]);
  });

  it('never plays two different messages at once behind one slow audio start', async () => {
    const test = harness();
    const gate = test.holdPrepare();
    const first = test.service.handleIncoming(1, message({ id: '1' }));
    const second = test.service.handleIncoming(2, message({ id: '2' }));
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual(['played', 'throttled']);
    expect(test.played).toHaveLength(1);
  });

  it('lets a bound tab ring a message an unattributed tab could not decide', async () => {
    const test = harness({
      settings: { messageSoundMutedAccountIds: ['300'] },
      sessions: { 1: null, 2: { accountId: MODEL, resolvedAccountId: MODEL } },
    });
    expect(await test.service.handleIncoming(1, message())).toBe('account-unknown');
    expect(await test.service.handleIncoming(2, message())).toBe('played');
  });

  it('consumes a message that failed to play instead of retrying it', async () => {
    const test = harness({ prepareOk: false });
    expect(await test.service.handleIncoming(1, message())).toBe('audio-error');
    expect(await test.service.handleIncoming(2, message())).toBe('duplicate');
  });

  it('forgets a message after its 10-minute window', async () => {
    const test = harness();
    expect(await test.service.handleIncoming(1, message({ createdAt: null }))).toBe('played');
    test.advance(10 * 60 * 1000 + 1);
    expect(await test.service.handleIncoming(1, message({ createdAt: null }))).toBe('played');
  });

  it('counts every outcome and reports only tabs still on Fansly', async () => {
    const test = harness();
    test.service.recordTap(1, { v: 1, socket: 'open', framesSeen: 4, messagesParsed: 1, droppedByType: 2 });
    test.service.recordTap(3, { v: 1, socket: 'open', framesSeen: 1, messagesParsed: 0, droppedByType: 0 });
    await test.service.handleIncoming(1, message({ id: '1' }));
    await test.service.handleIncoming(1, message({ id: '2', tip: true }));
    test.service.recordInvalid();
    const status = await test.service.status();
    expect(status.fanslyTabs).toBe(2);
    expect(status.tabs.map((tab) => tab.tabId)).toEqual([1]);
    expect(status.tabs[0]).toMatchObject({ socket: 'open', framesSeen: 4, droppedByType: 2, lastIncomingAt: NOW });
    expect(status.outcomes).toMatchObject({ played: 1, tip: 1, invalid: 1, duplicate: 0 });
    expect(status.lastPlayedAt).toBe(NOW);
    test.service.forgetTab(1);
    expect((await test.service.status()).tabs).toEqual([]);
  });

  it('previews through the same player, bypassing every rule', async () => {
    const test = harness({ settings: { messageSoundEnabled: false } });
    expect(await test.service.previewSound('soft', 100)).toEqual({ ok: true });
    expect(test.played).toEqual([{ tone: 'soft', volume: 100 }]);
    const failing = harness({ prepareOk: false });
    expect(await failing.service.previewSound('blip', 50)).toMatchObject({ ok: false });
  });
});
