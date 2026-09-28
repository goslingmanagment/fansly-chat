// E145: the bridge between the page-world socket tap, the isolated relay and
// the background. Hand-written guards, no zod: the tap and the relay are tiny
// `document_start` scripts on every Fansly page.
//
// The bridge is an UNTRUSTED channel — the page can dispatch these events
// itself. Nothing it carries can do more than ring once (the background
// throttles) or skew a diagnostics counter.

import type { FanslyIncomingMessage } from './fansly-ws-frame.js';
import type { MessageSoundOutcome } from './message-sound-decision.js';

/** page → relay: one incoming message projection (detail = JSON string). */
export const SOUND_BRIDGE_MESSAGE_EVENT = 'chatgoose:fansly-message';
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
  droppedByType: number;
}

export type MessageSoundTone = 'blip' | 'double' | 'soft';
export const MESSAGE_SOUND_TONES: readonly MessageSoundTone[] = ['blip', 'double', 'soft'];

/** One Fansly tab as the background saw it — in memory since `since`. */
export interface MessageSoundTabDiagnostics {
  tabId: number;
  socket: FanslySocketState;
  framesSeen: number;
  messagesParsed: number;
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
  lastPlayedAt: number | null;
  audio: { state: string | null; lastError: string | null };
}

export type MessageSoundReply =
  | { ok: true }
  | { ok: false; error: string };

export type MessageSoundRequest =
  | { type: 'messageSound'; action: 'incoming'; message: FanslyIncomingMessage }
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

export function parseSocketTapStatus(value: unknown): SocketTapStatus | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { socket, framesSeen, messagesParsed, droppedByType } = value;
  if (!SOCKET_STATES.includes(socket as FanslySocketState)) return null;
  if (!isCount(framesSeen) || !isCount(messagesParsed) || !isCount(droppedByType)) return null;
  return { v: 1, socket: socket as FanslySocketState, framesSeen, messagesParsed, droppedByType };
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
