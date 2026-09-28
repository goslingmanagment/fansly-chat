// E145: the incoming-message sound — constants and settings normalization.
// Dependency-free on purpose: migrations and storage import it.

import { isMessageSoundTone, type MessageSoundTone } from './message-sound-protocol.js';

/** Desktop parity (`onlyfans-chat/.../lib/sound.ts`): at most one blip per 2 s. */
export const MESSAGE_SOUND_THROTTLE_MS = 2_000;
/** Fansly's own rule (`onMessagesEvent`): a message older than 180 s is a
 * possible redelivery, not news. */
export const FANSLY_STALE_MESSAGE_MS = 180_000;

export const MESSAGE_SOUND_TONE_DEFAULT: MessageSoundTone = 'blip';
/** 50 % is exactly the desktop blip's peak (0.06); the slider goes up to +12 dB. */
export const MESSAGE_SOUND_VOLUME_DEFAULT = 50;
export const MESSAGE_SOUND_VOLUME_MIN = 5;
export const MESSAGE_SOUND_VOLUME_MAX = 100;
export const MESSAGE_SOUND_VOLUME_STEP = 5;
export const MESSAGE_SOUND_MUTED_MAX = 100;
const MAX_PEAK_GAIN = 0.24;

const FANSLY_ID = /^\d{1,32}$/;

export function normalizeMessageSoundTone(raw: unknown): MessageSoundTone {
  return isMessageSoundTone(raw) ? raw : MESSAGE_SOUND_TONE_DEFAULT;
}

export function normalizeMessageSoundVolume(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return MESSAGE_SOUND_VOLUME_DEFAULT;
  const stepped = Math.round(value / MESSAGE_SOUND_VOLUME_STEP) * MESSAGE_SOUND_VOLUME_STEP;
  return Math.min(MESSAGE_SOUND_VOLUME_MAX, Math.max(MESSAGE_SOUND_VOLUME_MIN, stepped));
}

/** Muted models: Fansly ids only, no repeats, bounded. Stored as whatever id
 * the row had when it was muted — canonical or legacy; the decision matches
 * both through `accountAliases`. */
export function normalizeMutedAccountIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string' || !FANSLY_ID.test(value) || ids.includes(value)) continue;
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
