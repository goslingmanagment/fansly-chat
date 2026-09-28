// E145: the incoming-message sound — constants and settings normalization.
// Dependency-free on purpose: migrations and storage import it.

import { isMessageSoundTone, type MessageSoundTone } from './message-sound-protocol.js';

/** Desktop parity (`onlyfans-chat/.../lib/sound.ts`): at most one blip per 2 s. */
export const MESSAGE_SOUND_THROTTLE_MS = 2_000;
/** E146: a follow wave (a promo, a viral post) must not ring non-stop — and
 * must never take a message's ring: messages keep their own 2 s pause. */
export const FOLLOW_SOUND_THROTTLE_MS = 10_000;
/** Fansly's own rule (`onMessagesEvent`): a message older than 180 s is a
 * possible redelivery, not news. */
export const FANSLY_STALE_MESSAGE_MS = 180_000;

/** E146: Fansly's own chime — `blip` (the OnlyFans app's sound) stays a choice,
 * but a chatter working both clients must hear which one is ringing. */
export const MESSAGE_SOUND_TONE_DEFAULT: MessageSoundTone = 'chime';
/** E146: a follow sounds different from a message by default. */
export const FOLLOW_SOUND_TONE_DEFAULT: MessageSoundTone = 'double';
/** 50 % is exactly the desktop blip's peak (0.06); the slider goes up to +12 dB. */
export const MESSAGE_SOUND_VOLUME_DEFAULT = 50;
export const MESSAGE_SOUND_VOLUME_MIN = 5;
export const MESSAGE_SOUND_VOLUME_MAX = 100;
export const MESSAGE_SOUND_VOLUME_STEP = 5;
export const MESSAGE_SOUND_MUTED_MAX = 100;
const MAX_PEAK_GAIN = 0.24;

/** A row id: the canonical Fansly id is numeric, but the legacy key decoded
 * from the Authorization header is not guaranteed to be — accept any compact
 * token-like string rather than silently dropping a mute. */
const ACCOUNT_ID = /^[\w-]{1,64}$/;

export function normalizeMessageSoundTone(
  raw: unknown,
  fallback: MessageSoundTone = MESSAGE_SOUND_TONE_DEFAULT,
): MessageSoundTone {
  return isMessageSoundTone(raw) ? raw : fallback;
}

export function normalizeMessageSoundVolume(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return MESSAGE_SOUND_VOLUME_DEFAULT;
  const stepped = Math.round(value / MESSAGE_SOUND_VOLUME_STEP) * MESSAGE_SOUND_VOLUME_STEP;
  return Math.min(MESSAGE_SOUND_VOLUME_MAX, Math.max(MESSAGE_SOUND_VOLUME_MIN, stepped));
}

/** Muted models: compact ids only, no repeats, bounded. Stored as whatever id
 * the row had when it was muted — canonical or legacy; the decision matches
 * both through `accountAliases`. */
export function normalizeMutedAccountIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !ACCOUNT_ID.test(value) || ids.includes(value)) continue;
    ids.push(value);
    if (ids.length >= MESSAGE_SOUND_MUTED_MAX) break;
  }
  return ids;
}

/** Quadratic: loudness follows the slider the way ears expect. 50 → 0.06. */
export function volumeToGain(volume: number): number {
  const normalized = normalizeMessageSoundVolume(volume) / 100;
  return MAX_PEAK_GAIN * normalized * normalized;
}
