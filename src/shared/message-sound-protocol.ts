// E145: the bridge between the page-world socket tap, the isolated relay and
// the background. Hand-written guards, no zod: the tap and the relay are tiny
// `document_start` scripts on every Fansly page.
//
// The bridge is an UNTRUSTED channel — the page can dispatch these events
// itself. Nothing it carries can do more than ring once (the background
// throttles) or skew a diagnostics counter.

import type { FanslyFollowEvent, FanslyIncomingMessage } from './fansly-ws-frame.js';
import type { MessageSoundOutcome } from './message-sound-decision.js';

/** page → relay: one incoming message projection (detail = JSON string). */
export const SOUND_BRIDGE_MESSAGE_EVENT = 'chatgoose:fansly-message';
/** page → relay: one follow projection (detail = JSON string). E146. */
export const SOUND_BRIDGE_FOLLOW_EVENT = 'chatgoose:fansly-follow';
/** page → relay: the tap's state (detail = JSON string). */
export const SOUND_BRIDGE_TAP_EVENT = 'chatgoose:fansly-socket';
/** relay → page: «I am listening, repeat your state» (no detail). */
export const SOUND_BRIDGE_RELAY_READY_EVENT = 'chatgoose:relay-ready';
/** relay → page: `'on'` / `'off'` — the global switch gates parsing. */
export const SOUND_BRIDGE_ARM_EVENT = 'chatgoose:sound-arm';

/** A projection is a handful of ids; anything longer is not ours. */
export const SOUND_BRIDGE_MAX_DETAIL_CHARS = 2048;

export type FanslySocketState = 'none' | 'connecting' | 'open' | 'closed';

export interface SocketTapStatus {
  v: 1;
  socket: FanslySocketState;
  framesSeen: number;
  messagesParsed: number;
  /** E146. `null` = a 2.7.0 tap still living in a tab opened before the
   * update: it forwards messages but no follows, so the tab needs a reload. */
  followsParsed: number | null;
  droppedByType: number;
}

/** `blip` is the OnlyFans desktop app's sound; E146 adds five of Fansly's own
 * so the two clients need not sound alike. */
export type MessageSoundTone =
  | 'chime'
  | 'drop'
  | 'bell'
  | 'arpeggio'
  | 'knock'
  | 'double'
  | 'soft'
  | 'blip';
export const MESSAGE_SOUND_TONES: readonly MessageSoundTone[] = [
  'chime',
  'drop',
  'bell',
  'arpeggio',
  'knock',
  'double',
  'soft',
  'blip',
];

/** One Fansly tab as the background saw it — in memory since `since`. */
export interface MessageSoundTabDiagnostics {
  tabId: number;
  socket: FanslySocketState;
  framesSeen: number;
  messagesParsed: number;
  followsParsed: number | null;
  droppedByType: number;
  lastIncomingAt: number | null;
}

/** «Статус» / «Скопировать отчёт» / the sound card. No message content, ever. */
export interface MessageSoundStatus {
  v: 1;
  /** When this background instance started counting. */
  since: number;
  /** Open Fansly tabs, or null when the count could not be read. */
  fanslyTabs: number | null;
  /** Tabs whose tap reported in — fewer than `fanslyTabs` means «reload». */
  tabs: MessageSoundTabDiagnostics[];
  outcomes: Record<MessageSoundOutcome, number>;
  /** E146: the same counters for new-follower events. */
  followOutcomes: Record<MessageSoundOutcome, number>;
  lastPlayedAt: number | null;
  audio: { state: string | null; lastError: string | null };
}

export type MessageSoundReply =
  | { ok: true }
  | { ok: false; error: string };

export type MessageSoundRequest =
  | { type: 'messageSound'; action: 'incoming'; message: FanslyIncomingMessage }
  | { type: 'messageSound'; action: 'follow'; follow: FanslyFollowEvent }
  | { type: 'messageSound'; action: 'tap'; status: SocketTapStatus }
  | { type: 'messageSound'; action: 'preview'; tone: MessageSoundTone; volume: number }
  | { type: 'messageSound'; action: 'status' };

const FANSLY_ID = /^\d{1,32}$/;
const SOCKET_STATES: readonly FanslySocketState[] = ['none', 'connecting', 'open', 'closed'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && FANSLY_ID.test(value);
}

function isNullableId(value: unknown): value is string | null {
  return value === null || isId(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseIncomingMessage(value: unknown): FanslyIncomingMessage | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { id, groupId, senderId, type, createdAt, correlationId, inReplyTo, tip } = value;
  if (!isId(id) || !isId(groupId) || !isId(senderId)) return null;
  if (typeof type !== 'number' || !Number.isSafeInteger(type)) return null;
  if (createdAt !== null && !(typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0)) {
    return null;
  }
  if (!isNullableId(correlationId) || !isNullableId(inReplyTo) || typeof tip !== 'boolean') return null;
  return { v: 1, id, groupId, senderId, type, createdAt, correlationId, inReplyTo, tip };
}

export function parseFollowEvent(value: unknown): FanslyFollowEvent | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { id, accountId, followerId } = value;
  if (!isId(id) || !isId(accountId) || !isId(followerId)) return null;
  return { v: 1, id, accountId, followerId };
}

export function parseSocketTapStatus(value: unknown): SocketTapStatus | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { socket, framesSeen, messagesParsed, droppedByType } = value;
  const followsParsed = value.followsParsed ?? null;
  if (!SOCKET_STATES.includes(socket as FanslySocketState)) return null;
  if (
    !isCount(framesSeen) || !isCount(messagesParsed) || !isCount(droppedByType) ||
    (followsParsed !== null && !isCount(followsParsed))
  ) {
    return null;
  }
  return { v: 1, socket: socket as FanslySocketState, framesSeen, messagesParsed, followsParsed, droppedByType };
}

/** Parse a bridge event's JSON-string detail; null for anything else. */
export function parseBridgeDetail(detail: unknown): unknown {
  if (typeof detail !== 'string' || detail.length > SOUND_BRIDGE_MAX_DETAIL_CHARS) return null;
  try {
    return JSON.parse(detail) as unknown;
  } catch {
    return null;
  }
}

export function isMessageSoundTone(value: unknown): value is MessageSoundTone {
  return MESSAGE_SOUND_TONES.includes(value as MessageSoundTone);
}
