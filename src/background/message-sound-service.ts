// E145: the background decides whether an incoming Fansly message rings.
//
// Candidates are processed ONE AT A TIME (a serial chain, no queue of delayed
// sounds): two different messages can never pass the throttle on the same
// stale timestamp, and a copy of a message delivered to a second tab waits
// behind the first and finds it already consumed. Order:
//   duplicate → gate (disabled, own, automated, tip, stale, muted /
//   account-unknown) → audio ready → fresh settings, tab still open, open chat
//   → one synchronous section: throttle, reserve, start.
// A message id is consumed by every final outcome except `account-unknown`:
// an unattributed tab must not swallow the copy a correctly bound tab gets.

import type { FanslyFollowEvent, FanslyIncomingMessage } from '../shared/fansly-ws-frame.js';
import {
  MESSAGE_SOUND_OUTCOMES,
  gateFollowEvent,
  gateIncomingMessage,
  type MessageSoundOutcome,
  type TabSessionIdentity,
} from '../shared/message-sound-decision.js';
import { MESSAGE_SOUND_THROTTLE_MS } from '../shared/message-sound.js';
import type {
  MessageSoundReply,
  MessageSoundStatus,
  MessageSoundTabDiagnostics,
  MessageSoundTone,
  SocketTapStatus,
} from '../shared/message-sound-protocol.js';
import type { PersistedState } from '../shared/types.js';
import type { PlayingTone } from '../shared/sound-synth.js';
import type { MessageSoundPlayer } from './message-sound-player.js';

const SEEN_MAX = 2_000;
const SEEN_TTL_MS = 10 * 60 * 1000;

export type MessageSoundState = Pick<PersistedState, 'settings' | 'knownAccounts' | 'accountAliases'>;

export interface MessageSoundServiceDependencies {
  getState: () => Promise<MessageSoundState>;
  getTabSession: (tabId: number) => TabSessionIdentity | null;
  isTabOpen: (tabId: number) => Promise<boolean>;
  /** The `groupId` open in the active tab of the FOCUSED window, if that tab
   * is a Fansly conversation; null otherwise (including no focused window). */
  focusedConversationGroupId: () => Promise<string | null>;
  /** Tabs currently on fansly.com — diagnostics only. */
  listFanslyTabIds: () => Promise<number[]>;
  player: MessageSoundPlayer;
  /** Wall clock, for message ages and diagnostics. */
  now: () => number;
  /** Monotonic clock, for the throttle. */
  monotonic: () => number;
}

class SeenMessages {
  private readonly expiries = new Map<string, number>();

  has(id: string, now: number): boolean {
    const expiry = this.expiries.get(id);
    if (expiry === undefined) return false;
    if (expiry > now) return true;
    this.expiries.delete(id);
    return false;
  }

  consume(id: string, now: number): void {
    this.expiries.delete(id);
    this.expiries.set(id, now + SEEN_TTL_MS);
    while (this.expiries.size > SEEN_MAX) {
      const oldest = this.expiries.keys().next().value;
      if (oldest === undefined) break;
      this.expiries.delete(oldest);
    }
  }
}

function emptyOutcomes(): Record<MessageSoundOutcome, number> {
  return Object.fromEntries(MESSAGE_SOUND_OUTCOMES.map((outcome) => [outcome, 0])) as Record<
    MessageSoundOutcome,
    number
  >;
}

export class MessageSoundService {
  private readonly seen = new SeenMessages();
  private readonly outcomes = emptyOutcomes();
  private readonly followOutcomes = emptyOutcomes();
  private readonly tabs = new Map<number, MessageSoundTabDiagnostics>();
  private readonly since: number;
  private chain: Promise<unknown> = Promise.resolve();
  private lastRingAt = Number.NEGATIVE_INFINITY;
  private lastPlayedAt: number | null = null;
  private preview: PlayingTone | null = null;

  constructor(private readonly deps: MessageSoundServiceDependencies) {
    this.since = deps.now();
  }

  handleIncoming(tabId: number, message: FanslyIncomingMessage): Promise<MessageSoundOutcome> {
    const tab = this.tabFor(tabId);
    tab.lastIncomingAt = this.deps.now();
    const run = this.chain.then(() => this.decide(tabId, message));
    this.chain = run.catch(() => undefined);
    return run.then(
      (outcome) => this.count(outcome),
      () => this.count('audio-error'),
    );
  }

  /** E146: a new follower — the same chain, throttle and player as messages. */
  handleFollow(tabId: number, follow: FanslyFollowEvent): Promise<MessageSoundOutcome> {
    this.tabFor(tabId);
    const run = this.chain.then(() => this.decideFollow(tabId, follow));
    this.chain = run.catch(() => undefined);
    return run.then(
      (outcome) => this.countFollow(outcome),
      () => this.countFollow('audio-error'),
    );
  }

  recordInvalid(): void {
    this.count('invalid');
  }

  recordTap(tabId: number, status: SocketTapStatus): void {
    const tab = this.tabFor(tabId);
    tab.socket = status.socket;
    tab.framesSeen = status.framesSeen;
    tab.messagesParsed = status.messagesParsed;
    tab.followsParsed = status.followsParsed;
    tab.droppedByType = status.droppedByType;
  }

  forgetTab(tabId: number): void {
    this.tabs.delete(tabId);
  }

  /** «Проверить звук»: through the same player, minus every rule. A second
   * press cuts the first instead of stacking on it. */
  async previewSound(tone: MessageSoundTone, volume: number): Promise<MessageSoundReply> {
    if (!await this.deps.player.prepare()) {
      return { ok: false, error: this.deps.player.diagnostics().lastError ?? 'audio unavailable' };
    }
    try {
      this.preview?.stop();
      this.preview = this.deps.player.start(tone, volume);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async status(): Promise<MessageSoundStatus> {
    let openFanslyTabs: Set<number> | null = null;
    try {
      openFanslyTabs = new Set(await this.deps.listFanslyTabIds());
    } catch {
      openFanslyTabs = null;
    }
    // A tab that navigated away from Fansly keeps its diagnostics until it
    // closes; «слушаем N вкладок» counts only the ones still on Fansly.
    const tabs = Array.from(this.tabs.values())
      .filter((tab) => openFanslyTabs === null || openFanslyTabs.has(tab.tabId))
      .map((tab) => ({ ...tab }));
    return {
      v: 1,
      since: this.since,
      fanslyTabs: openFanslyTabs?.size ?? null,
      tabs,
      outcomes: { ...this.outcomes },
      followOutcomes: { ...this.followOutcomes },
      lastPlayedAt: this.lastPlayedAt,
      audio: this.deps.player.diagnostics(),
    };
  }

  private count(outcome: MessageSoundOutcome): MessageSoundOutcome {
    this.outcomes[outcome] += 1;
    return outcome;
  }

  private countFollow(outcome: MessageSoundOutcome): MessageSoundOutcome {
    this.followOutcomes[outcome] += 1;
    return outcome;
  }

  private tabFor(tabId: number): MessageSoundTabDiagnostics {
    let tab = this.tabs.get(tabId);
    if (!tab) {
      tab = {
        tabId,
        socket: 'none',
        framesSeen: 0,
        messagesParsed: 0,
        followsParsed: 0,
        droppedByType: 0,
        lastIncomingAt: null,
      };
      this.tabs.set(tabId, tab);
    }
    return tab;
  }

  private async decide(tabId: number, message: FanslyIncomingMessage): Promise<MessageSoundOutcome> {
    if (this.seen.has(message.id, this.deps.now())) return 'duplicate';
    const outcome = await this.evaluate(tabId, message);
    if (outcome !== 'account-unknown') this.seen.consume(message.id, this.deps.now());
    return outcome;
  }

  private async evaluate(tabId: number, message: FanslyIncomingMessage): Promise<MessageSoundOutcome> {
    const session = this.deps.getTabSession(tabId);
    const state = await this.deps.getState();
    const gated = gateIncomingMessage(message, {
      enabled: state.settings.messageSoundEnabled,
      session,
      knownAccounts: state.knownAccounts,
      accountAliases: state.accountAliases,
      mutedAccountIds: state.settings.messageSoundMutedAccountIds,
      nowMs: this.deps.now(),
    });
    if (gated !== null) return gated;

    if (!await this.deps.player.prepare()) return 'audio-error';

    // Everything that may have changed while the audio woke up: the switch,
    // the mute list, the tab itself, the chat in focus.
    const fresh = await this.deps.getState();
    const regated = gateIncomingMessage(message, {
      enabled: fresh.settings.messageSoundEnabled,
      session: this.deps.getTabSession(tabId) ?? session,
      knownAccounts: fresh.knownAccounts,
      accountAliases: fresh.accountAliases,
      mutedAccountIds: fresh.settings.messageSoundMutedAccountIds,
      nowMs: this.deps.now(),
    });
    if (regated !== null) return regated;
    if (!await this.deps.isTabOpen(tabId)) return 'tab-closed';
    let focusedGroupId: string | null = null;
    try {
      focusedGroupId = await this.deps.focusedConversationGroupId();
    } catch {
      focusedGroupId = null;
    }
    if (focusedGroupId === message.groupId) return 'open-chat';

    return this.startNow(fresh.settings.messageSoundTone, fresh.settings.messageSoundVolume);
  }

  private async decideFollow(tabId: number, follow: FanslyFollowEvent): Promise<MessageSoundOutcome> {
    // Follow ids and message ids are different Fansly entities; keep them apart.
    const key = `follow:${follow.id}`;
    if (this.seen.has(key, this.deps.now())) return 'duplicate';
    const outcome = await this.evaluateFollow(tabId, follow);
    this.seen.consume(key, this.deps.now());
    return outcome;
  }

  private async evaluateFollow(tabId: number, follow: FanslyFollowEvent): Promise<MessageSoundOutcome> {
    const gate = (state: MessageSoundState): MessageSoundOutcome | null => gateFollowEvent(follow, {
      enabled: state.settings.followSoundEnabled,
      session: this.deps.getTabSession(tabId),
      knownAccounts: state.knownAccounts,
      accountAliases: state.accountAliases,
      mutedAccountIds: state.settings.messageSoundMutedAccountIds,
    });
    const gated = gate(await this.deps.getState());
    if (gated !== null) return gated;
    if (!await this.deps.player.prepare()) return 'audio-error';
    const fresh = await this.deps.getState();
    const regated = gate(fresh);
    if (regated !== null) return regated;
    if (!await this.deps.isTabOpen(tabId)) return 'tab-closed';
    return this.startNow(fresh.settings.followSoundTone, fresh.settings.messageSoundVolume);
  }

  /** One synchronous section: no await between the throttle and the start. */
  private startNow(tone: MessageSoundTone, volume: number): MessageSoundOutcome {
    const at = this.deps.monotonic();
    if (at - this.lastRingAt < MESSAGE_SOUND_THROTTLE_MS) return 'throttled';
    try {
      this.deps.player.start(tone, volume);
    } catch {
      return 'audio-error';
    }
    // Reserved only for a sound that actually started.
    this.lastRingAt = at;
    this.lastPlayedAt = this.deps.now();
    return 'played';
  }
}
