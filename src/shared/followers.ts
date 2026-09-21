import type { FanslyAccountResponse, FanslyMessage } from './types.js';

export const FOLLOWER_HOURS = [1, 3, 6, 12, 24, 48, 72, 168, 336, 720] as const;
export type { FollowersRequest } from './followers-protocol.js';
export type FollowerStatus = 'checking' | 'pending' | 'ready' | 'reply' | 'contacted' | 'unknown' | 'sending' | 'uncertain' | 'sent';
export interface FollowerDisplayMessage { id: string; own: boolean; automated: boolean; text: string; createdAt?: number }
export interface FollowerConversation {
  groupId?: string;
  messages: FollowerDisplayMessage[];
  loading: boolean;
  hasMore: boolean;
  truncated?: boolean;
  error?: string;
}
export interface FollowerRow {
  id: string;
  followedAt: number;
  username: string;
  displayName: string;
  customName: string | null;
  avatarUrl: string | null;
  bio: string;
  status: FollowerStatus;
  /** Only history read to a confirmed end makes a ready/reply row eligible.
   * A listing miss remains pending, never a negative history verdict. */
  evidence?: 'history';
  /** A chat with this fan is known, whether or not its history could be read. */
  chatKnown?: boolean;
  /** Published only after this run has confirmed the two participants. */
  groupId?: string;
  historyRevision: string;
  detail?: string;
  messages: FollowerDisplayMessage[];
  proof?: { message: FollowerDisplayMessage; source: 'cache' | 'live'; observedAt?: number };
  conversation?: FollowerConversation;
}
export interface FollowersSnapshot {
  scanId: string;
  creatorId: string;
  creatorName: string;
  hours: number;
  scanning: boolean;
  canContinue?: boolean;
  phase?: 'welcome' | 'followers' | 'profiles' | 'checking' | 'notes';
  cutoff?: number;
  startedAt?: number;
  pacing?: { cooldownUntil: number; intervalMs: number };
  /** The second phase resolves only the rows the fast pass could not prove.
   * Ready rows remain usable while this bounded queue runs. */
  verification?: { active: boolean; remaining: number; total: number; fanId?: string; stopped?: 'paused' | 'cooldown' | 'errors' };
  rows: FollowerRow[];
  error?: string;
  debug?: { traceId: string };
}
export type FollowersResponse = { ok: true; snapshot?: FollowersSnapshot; text?: string } | { ok: false; error: string; debug?: { traceId: string } };

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

export type FollowerMessageEvidence = Pick<FanslyMessage, 'id' | 'senderId' | 'type' | 'content' | 'correlationId' | 'inReplyTo'> & Partial<Pick<FanslyMessage, 'createdAt'>>;

export function isAutomatedMessage(message: FollowerMessageEvidence, welcome: ReadonlySet<string>): boolean {
  return automationReason(message, welcome) !== null;
}

export function automationReason(message: FollowerMessageEvidence, welcome: ReadonlySet<string>): 'type-2' | 'non-reply-correlation' | 'welcome-text-match' | null {
  if (message.type === 2) return 'type-2';
  if (message.correlationId && message.correlationId !== '0' && (!message.inReplyTo || message.inReplyTo === '0')) return 'non-reply-correlation';
  const normalized = normalizeWelcome(message.content ?? '');
  return normalized && welcome.has(normalized) ? 'welcome-text-match' : null;
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

/** The one avatar URL check, mirroring Core's `fanslyAvatarUrlSchema`: https,
 * a direct `*.fansly.com` host, at most 4096 chars. Signed-URL metadata, when
 * given, is folded into the query first. Null when the URL must not be sent.
 * Idempotent: an accepted URL is returned unchanged when checked again. */
export function safeFanslyAvatarUrl(raw: string, metadata?: Record<string, unknown> | null): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !/^[-a-z0-9]+\.fansly\.com$/i.test(url.hostname) || url.username || url.password || url.port) return null;
    for (const [key, value] of Object.entries(metadata ?? {})) {
      if (['Key-Pair-Id', 'Policy', 'Signature'].includes(key) && typeof value === 'string') url.searchParams.set(key, value);
    }
    return url.href.length > 4096 ? null : url.href;
  } catch { return null; /* A missing/broken avatar should use initials. */ }
}

export function fanslyAvatarUrl(account: FanslyAccountResponse): string | null {
  const avatar = account.avatar;
  if (!avatar) return null;
  const candidates = [...(avatar.variants ?? []).filter((v) => v.width && v.width <= 512).sort((a, b) => (b.width ?? 0) - (a.width ?? 0)), avatar];
  for (const candidate of candidates) {
    const location = candidate.locations?.[0];
    const raw = location?.location || candidate.location;
    const url = raw ? safeFanslyAvatarUrl(raw, location?.metadata) : null;
    if (url) return url;
  }
  return null;
}
