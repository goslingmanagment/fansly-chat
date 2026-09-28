// E145: which incoming Fansly messages ring. Pure — the background service
// owns the order of the asynchronous steps (focus, audio) around it.

import type { FanslyIncomingMessage } from './fansly-ws-frame.js';
import { automationReason } from './followers.js';
import { FANSLY_STALE_MESSAGE_MS } from './message-sound.js';

export type MessageSoundOutcome =
  | 'invalid'
  | 'duplicate'
  | 'disabled'
  | 'own'
  | 'automated'
  | 'tip'
  | 'stale'
  | 'muted'
  | 'account-unknown'
  | 'tab-closed'
  | 'open-chat'
  | 'throttled'
  | 'played'
  | 'audio-error';

export const MESSAGE_SOUND_OUTCOMES: readonly MessageSoundOutcome[] = [
  'invalid',
  'duplicate',
  'disabled',
  'own',
  'automated',
  'tip',
  'stale',
  'muted',
  'account-unknown',
  'tab-closed',
  'open-chat',
  'throttled',
  'played',
  'audio-error',
];

/** The tab's captured session, as far as identity goes. */
export interface TabSessionIdentity {
  /** The legacy key decoded from the Authorization header. */
  accountId: string;
  /** The canonical Fansly id, once `account/me` answered. */
  resolvedAccountId: string | null;
}

/** Every id that is ours, not a fan's: this tab's session under both names,
 * plus every model this browser ever captured (persisted, so it survives a
 * worker restart) and both sides of every alias. A fan is never among them. */
export function ownSenderIds(
  session: TabSessionIdentity | null,
  knownAccounts: readonly string[],
  accountAliases: Readonly<Record<string, string>>,
): Set<string> {
  const ids = new Set<string>(knownAccounts);
  if (session) {
    ids.add(session.accountId);
    if (session.resolvedAccountId) ids.add(session.resolvedAccountId);
  }
  for (const [legacy, canonical] of Object.entries(accountAliases)) {
    ids.add(legacy);
    ids.add(canonical);
  }
  return ids;
}

/** Every name the tab's model may be muted under. */
export function tabAccountEquivalents(
  session: TabSessionIdentity,
  accountAliases: Readonly<Record<string, string>>,
): Set<string> {
  const ids = new Set<string>([session.accountId]);
  if (session.resolvedAccountId) ids.add(session.resolvedAccountId);
  for (const [legacy, canonical] of Object.entries(accountAliases)) {
    if (ids.has(legacy)) ids.add(canonical);
  }
  for (const [legacy, canonical] of Object.entries(accountAliases)) {
    if (ids.has(canonical)) ids.add(legacy);
  }
  return ids;
}

/** An id and every alias that names the same model — for the per-model switch
 * in «Аккаунты», whose row id may be the canonical or the legacy one. */
export function accountIdEquivalents(
  accountId: string,
  accountAliases: Readonly<Record<string, string>>,
): Set<string> {
  return tabAccountEquivalents({ accountId, resolvedAccountId: null }, accountAliases);
}

export function isStaleMessage(createdAtSeconds: number | null, nowMs: number): boolean {
  // Fansly: `if (p.createdAt && now - 1000 * p.createdAt > 180000) continue` —
  // no createdAt is live, and there is no bound in the future.
  return createdAtSeconds !== null && nowMs - createdAtSeconds * 1000 > FANSLY_STALE_MESSAGE_MS;
}

export interface MessageSoundGateContext {
  enabled: boolean;
  session: TabSessionIdentity | null;
  knownAccounts: readonly string[];
  accountAliases: Readonly<Record<string, string>>;
  mutedAccountIds: readonly string[];
  nowMs: number;
}

const NO_WELCOME_TEXTS: ReadonlySet<string> = new Set();

/**
 * The synchronous part of the decision, in order. Null = still eligible; the
 * caller then checks the open chat, readies the audio and throttles.
 */
export function gateIncomingMessage(
  message: FanslyIncomingMessage,
  context: MessageSoundGateContext,
): MessageSoundOutcome | null {
  if (!context.enabled) return 'disabled';
  if (ownSenderIds(context.session, context.knownAccounts, context.accountAliases).has(message.senderId)) {
    return 'own';
  }
  // The projection carries no text, so the welcome-text rule never applies;
  // `type 2` and a correlation without a reply do.
  if (
    message.type !== 1 ||
    automationReason({
      id: message.id,
      senderId: message.senderId,
      type: message.type,
      content: '',
      correlationId: message.correlationId,
      inReplyTo: message.inReplyTo,
    }, NO_WELCOME_TEXTS) !== null
  ) {
    return 'automated';
  }
  if (message.tip) return 'tip';
  if (isStaleMessage(message.createdAt, context.nowMs)) return 'stale';
  if (context.session === null) {
    // After a worker restart a tab is unattributed until its next Fansly
    // request. The sender is already known not to be ours, so this is a fan —
    // but with a model muted, this tab might be that model.
    return context.mutedAccountIds.length > 0 ? 'account-unknown' : null;
  }
  const equivalents = tabAccountEquivalents(context.session, context.accountAliases);
  return context.mutedAccountIds.some((id) => equivalents.has(id)) ? 'muted' : null;
}
