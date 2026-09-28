import { describe, expect, it } from 'vitest';
import type { FanslyIncomingMessage } from '../src/shared/fansly-ws-frame.js';
import {
  accountIdEquivalents,
  gateFollowEvent,
  gateIncomingMessage,
  isStaleMessage,
  ownSenderIds,
  type MessageSoundGateContext,
} from '../src/shared/message-sound-decision.js';
import {
  normalizeMutedAccountIds,
  normalizeMessageSoundVolume,
  volumeToGain,
} from '../src/shared/message-sound.js';

const NOW = 1_790_571_000_000;
const MODEL_LEGACY = '100';
const MODEL = '200';
const OTHER_MODEL = '300';
const FAN = '999';

function message(overrides: Partial<FanslyIncomingMessage> = {}): FanslyIncomingMessage {
  return {
    v: 1,
    id: '5000',
    groupId: '6000',
    senderId: FAN,
    type: 1,
    createdAt: NOW / 1000 - 5,
    correlationId: null,
    inReplyTo: null,
    tip: false,
    ...overrides,
  };
}

function context(overrides: Partial<MessageSoundGateContext> = {}): MessageSoundGateContext {
  return {
    enabled: true,
    session: { accountId: MODEL_LEGACY, resolvedAccountId: MODEL },
    knownAccounts: [MODEL, OTHER_MODEL],
    accountAliases: { [MODEL_LEGACY]: MODEL },
    mutedAccountIds: [],
    nowMs: NOW,
    ...overrides,
  };
}

describe('gateIncomingMessage (E145)', () => {
  it('lets a fresh fan message through', () => {
    expect(gateIncomingMessage(message(), context())).toBeNull();
  });

  it('checks the global switch first', () => {
    expect(gateIncomingMessage(message({ senderId: MODEL, tip: true }), context({ enabled: false })))
      .toBe('disabled');
  });

  it('treats the tab session under both names, every known model and every alias as ours', () => {
    expect(gateIncomingMessage(message({ senderId: MODEL }), context())).toBe('own');
    expect(gateIncomingMessage(message({ senderId: MODEL_LEGACY }), context())).toBe('own');
    expect(gateIncomingMessage(message({ senderId: OTHER_MODEL }), context())).toBe('own');
    // After a worker restart the tab session is gone; the persisted lists still know.
    expect(gateIncomingMessage(message({ senderId: MODEL }), context({ session: null }))).toBe('own');
    expect(gateIncomingMessage(message({ senderId: MODEL_LEGACY }), context({
      session: null, knownAccounts: [],
    }))).toBe('own');
  });

  it('silences automation: non-1 types and a correlation without a reply', () => {
    expect(gateIncomingMessage(message({ type: 2 }), context())).toBe('automated');
    expect(gateIncomingMessage(message({ type: 3 }), context())).toBe('automated');
    expect(gateIncomingMessage(message({ correlationId: '777' }), context())).toBe('automated');
    // A reply that carries its correlation is a person answering, not automation.
    expect(gateIncomingMessage(message({ correlationId: '777', inReplyTo: '4999' }), context())).toBeNull();
    expect(gateIncomingMessage(message({ correlationId: '0' }), context())).toBeNull();
  });

  it('keeps tips silent (D39 parity)', () => {
    expect(gateIncomingMessage(message({ tip: true }), context())).toBe('tip');
  });

  it('drops a message older than 180 s like Fansly itself, and keeps one without createdAt', () => {
    expect(gateIncomingMessage(message({ createdAt: NOW / 1000 - 181 }), context())).toBe('stale');
    expect(gateIncomingMessage(message({ createdAt: NOW / 1000 - 179 }), context())).toBeNull();
    expect(gateIncomingMessage(message({ createdAt: null }), context())).toBeNull();
    // No bound in the future: a chatter clock running behind must not silence everything.
    expect(gateIncomingMessage(message({ createdAt: NOW / 1000 + 600 }), context())).toBeNull();
    expect(isStaleMessage(null, NOW)).toBe(false);
  });

  it('mutes a model under its canonical id, its legacy id, or either alias side', () => {
    expect(gateIncomingMessage(message(), context({ mutedAccountIds: [MODEL] }))).toBe('muted');
    expect(gateIncomingMessage(message(), context({ mutedAccountIds: [MODEL_LEGACY] }))).toBe('muted');
    // Muted by legacy id before identity resolved; the tab now knows its canonical id only.
    expect(gateIncomingMessage(message(), context({
      session: { accountId: 'unrelated-legacy', resolvedAccountId: MODEL },
      accountAliases: { [MODEL_LEGACY]: MODEL },
      mutedAccountIds: [MODEL_LEGACY],
    }))).toBe('muted');
    expect(gateIncomingMessage(message(), context({ mutedAccountIds: [OTHER_MODEL] }))).toBeNull();
  });

  it('rings for an unattributed tab only while no model is muted', () => {
    expect(gateIncomingMessage(message(), context({ session: null }))).toBeNull();
    expect(gateIncomingMessage(message(), context({ session: null, mutedAccountIds: [OTHER_MODEL] })))
      .toBe('account-unknown');
  });

  it('builds the own-id set and the equivalents the options switch uses', () => {
    expect([...ownSenderIds(null, ['1'], { '2': '3' })].sort()).toEqual(['1', '2', '3']);
    expect([...accountIdEquivalents(MODEL, { [MODEL_LEGACY]: MODEL })].sort()).toEqual([MODEL_LEGACY, MODEL]);
    expect([...accountIdEquivalents(MODEL_LEGACY, { [MODEL_LEGACY]: MODEL })].sort()).toEqual([MODEL_LEGACY, MODEL]);
  });
});

describe('message sound settings helpers (E145)', () => {
  it('maps 50 % to the desktop peak and grows quadratically to +12 dB', () => {
    expect(volumeToGain(50)).toBeCloseTo(0.06, 10);
    expect(volumeToGain(100)).toBeCloseTo(0.24, 10);
    expect(volumeToGain(5)).toBeLessThan(volumeToGain(10));
    expect(volumeToGain(0)).toBe(volumeToGain(5));
  });

  it('clamps and steps the volume, and cleans the mute list', () => {
    expect(normalizeMessageSoundVolume(0)).toBe(5);
    expect(normalizeMessageSoundVolume(101)).toBe(100);
    expect(normalizeMessageSoundVolume(47)).toBe(45);
    expect(normalizeMessageSoundVolume(Number.NaN)).toBe(50);
    expect(normalizeMutedAccountIds(['1', '1', '', 'a b', 2, '3', 'acc-1'])).toEqual(['1', '3', 'acc-1']);
    expect(normalizeMutedAccountIds(Array.from({ length: 150 }, (_, index) => String(index)))).toHaveLength(100);
    expect(normalizeMutedAccountIds('1')).toEqual([]);
  });
});

describe('gateFollowEvent (E146)', () => {
  const follow = (accountId: string, followerId: string) => ({ v: 1 as const, id: '1', accountId, followerId });
  const ctx = {
    enabled: true,
    session: { accountId: MODEL_LEGACY, resolvedAccountId: MODEL },
    knownAccounts: [MODEL, OTHER_MODEL],
    accountAliases: { [MODEL_LEGACY]: MODEL },
    mutedAccountIds: [] as string[],
  };

  it('rings for a fan following one of our models', () => {
    expect(gateFollowEvent(follow(MODEL, FAN), ctx)).toBeNull();
    // After a worker restart the event itself names the model.
    expect(gateFollowEvent(follow(OTHER_MODEL, FAN), { ...ctx, session: null })).toBeNull();
  });

  it('stays silent for a follow BY the model, of a stranger, or with the switch off', () => {
    expect(gateFollowEvent(follow('555', MODEL), ctx)).toBe('own');
    expect(gateFollowEvent(follow('555', FAN), ctx)).toBe('not-ours');
    expect(gateFollowEvent(follow(MODEL, FAN), { ...ctx, enabled: false })).toBe('disabled');
  });

  it('honours the per-model mute under either id', () => {
    expect(gateFollowEvent(follow(MODEL, FAN), { ...ctx, mutedAccountIds: [MODEL_LEGACY] })).toBe('muted');
    expect(gateFollowEvent(follow(MODEL, FAN), { ...ctx, session: null, mutedAccountIds: [MODEL_LEGACY] })).toBe('muted');
    expect(gateFollowEvent(follow(MODEL, FAN), { ...ctx, mutedAccountIds: [OTHER_MODEL] })).toBeNull();
  });
});
