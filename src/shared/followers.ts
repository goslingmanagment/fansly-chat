import type { FanslyAccountResponse, FanslyMessage } from './types.js';

export const FOLLOWER_HOURS = [1, 3, 6, 12, 24, 48, 72, 168, 336, 720] as const;
export type { FollowersRequest } from './followers-protocol.js';
export type FollowerStatus = 'checking' | 'ready' | 'reply' | 'contacted' | 'unknown' | 'sending' | 'uncertain' | 'sent';
export interface FollowerRow {
  id: string;
  followedAt: number;
  username: string;
  displayName: string;
  customName: string | null;
  avatarUrl: string | null;
  bio: string;
  status: FollowerStatus;
  historyRevision: string;
  detail?: string;
  messages: Array<{ id: string; own: boolean; automated: boolean; text: string }>;
}
export interface FollowersSnapshot {
  scanId: string;
  creatorId: string;
  creatorName: string;
  hours: number;
  scanning: boolean;
  rows: FollowerRow[];
  error?: string;
}
export type FollowersResponse = { ok: true; snapshot?: FollowersSnapshot; text?: string } | { ok: false; error: string };

export function followedAtFromId(value: string, now = Date.now()): number {
  if (!/^\d{1,24}$/.test(value)) throw new Error('Некорректная дата подписки Fansly.');
  const ms = Number(BigInt(value) >> 22n) + 1561494360000;
  if (!Number.isSafeInteger(ms) || ms <= 1561494360000 || ms > now + 60_000) {
    throw new Error('Некорректная дата подписки Fansly.');
  }
  return ms;
}

/** Owner rule: nonempty exact text after whitespace normalization is enough. */
export function normalizeWelcome(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export type FollowerMessageEvidence = Pick<FanslyMessage, 'id' | 'senderId' | 'type' | 'content' | 'correlationId' | 'inReplyTo'>;

export function isAutomatedMessage(message: FollowerMessageEvidence, welcome: ReadonlySet<string>): boolean {
  return message.type === 2 ||
    Boolean(message.correlationId && message.correlationId !== '0' && (!message.inReplyTo || message.inReplyTo === '0')) ||
    Boolean(normalizeWelcome(message.content ?? '') && welcome.has(normalizeWelcome(message.content ?? '')));
}

export function isPersonalMessage(message: FollowerMessageEvidence, creatorId: string, welcome: ReadonlySet<string>): boolean {
  return message.senderId === creatorId && message.type === 1 && !isAutomatedMessage(message, welcome);
}

/** Definitions are read once per creator. Keep old texts when an automation is edited. */
export function welcomeTexts(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('Не удалось прочитать welcome-сообщения.');
  return raw.flatMap((value: unknown) => {
    if (!value || typeof value !== 'object' || !('messageTemplate' in value)) throw new Error('Неизвестный формат welcome-сообщения.');
    let template: unknown = value.messageTemplate;
    if (typeof template === 'string') template = JSON.parse(template) as unknown;
    if (!template || typeof template !== 'object') throw new Error('Неизвестный формат welcome-сообщения.');
    if (!('content' in template) || template.content === null) return [];
    if (typeof template.content !== 'string') throw new Error('Неизвестный формат welcome-сообщения.');
    return template.content.trim() ? [template.content] : [];
  });
}

export function fanslyAvatarUrl(account: FanslyAccountResponse): string | null {
  const avatar = account.avatar;
  if (!avatar) return null;
  const candidates = [...(avatar.variants ?? []).filter((v) => v.width && v.width <= 512).sort((a, b) => (b.width ?? 0) - (a.width ?? 0)), avatar];
  for (const candidate of candidates) {
    const location = candidate.locations?.[0];
    const raw = location?.location || candidate.location;
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || !url.hostname.endsWith('.fansly.com') || url.username || url.password || url.port) continue;
      for (const [key, value] of Object.entries(location?.metadata ?? {})) {
        if (['Key-Pair-Id', 'Policy', 'Signature'].includes(key) && typeof value === 'string') url.searchParams.set(key, value);
      }
      return url.href;
    } catch { /* A missing/broken avatar should use initials. */ }
  }
  return null;
}
