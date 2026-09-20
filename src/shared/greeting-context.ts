import { isAutomatedMessage, safeFanslyAvatarUrl, type FollowerMessageEvidence } from './followers.js';

/** The one place that turns "fan profile + classified message window" into the
 * greeting part of the kernel `clientContext`. Pure: no I/O, no clock.
 *
 * Both Hi surfaces use it (the chat button and the New Followers window).
 * Each surface keeps its own message acquisition and its own transcript
 * formatter (the chat has the media/PPV labels, the followers window a plain
 * one); what is shared is the profile fields with Core's bounds, the avatar
 * check, the automation label and the personal-message count.
 *
 * These are context VALUES and transcript labels. What they mean to the model
 * is the kernel template's business: no prompt text is assembled here. */

/** Transcript label for the model's welcome and mass messages. */
export const AUTOMATED_MESSAGE_LABEL = '[Automatic / mass message]';

/** Core `clientContext` bounds (contracts `routes.ts`): `fanDisplayName`,
 * `fanUsername`, `fanCustomName` max 200; `fanBio` max 5000. */
export const GREETING_NAME_MAX_CHARS = 200;
export const GREETING_BIO_MAX_CHARS = 5000;

/** Field names match `FollowerRow`, so a row is a profile as it stands. */
export interface GreetingProfile {
  displayName: string;
  username?: string | null;
  customName?: string | null;
  bio?: string | null;
  /** A Fansly avatar URL (`fanslyAvatarUrl(account)`); checked again here. */
  avatarUrl?: string | null;
}

/** One message of the window handed to the transcript formatter. */
export interface GreetingWindowMessage {
  automated: boolean;
}

export interface GreetingProfileFields {
  fanDisplayName: string;
  fanUsername?: string;
  fanCustomName?: string;
  fanBio?: string;
  fanAvatarUrl?: string;
}

export interface GreetingContext extends GreetingProfileFields {
  /** Messages of the SHIPPED window that are not automated: every fan message
   * plus the model's personal ones. Never above the kept `messageCount`. */
  personalMessageCount: number;
}

export interface GreetingContextInput {
  profile: GreetingProfile;
  /** The window given to the surface's transcript formatter, oldest first. */
  messages: readonly GreetingWindowMessage[];
  /** The formatter's result for that window. `messageCount` is the KEPT
   * count: `formatTranscriptForKernel` drops the oldest lines of a giant chat,
   * and the kernel rejects a personal count above what the transcript holds. */
  transcript: { messageCount: number };
}

/** Core bounds strings in UTF-16 units. Cut there, but never leave half of a
 * surrogate pair at the cut. */
function cap(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Automation is decided by `isAutomatedMessage` alone, and only the model's
 * own message can be automated: a fan message is always personal. */
export function isAutomatedGreetingMessage(message: FollowerMessageEvidence, creatorId: string, welcome: ReadonlySet<string>): boolean {
  return message.senderId === creatorId && isAutomatedMessage(message, welcome);
}

export function countPersonalMessages(messages: readonly GreetingWindowMessage[]): number {
  return messages.reduce((count, message) => count + (message.automated ? 0 : 1), 0);
}

/** A field is sent when the surface supplied a string and omitted on
 * null/undefined, so each surface keeps deciding what it knows. The avatar is
 * sent only when it passes the shared Fansly URL check. */
export function greetingProfileFields(profile: GreetingProfile): GreetingProfileFields {
  const avatar = typeof profile.avatarUrl === 'string' ? safeFanslyAvatarUrl(profile.avatarUrl) : null;
  return {
    fanDisplayName: cap(profile.displayName, GREETING_NAME_MAX_CHARS),
    ...(typeof profile.username === 'string' ? { fanUsername: cap(profile.username, GREETING_NAME_MAX_CHARS) } : {}),
    ...(typeof profile.customName === 'string' ? { fanCustomName: cap(profile.customName, GREETING_NAME_MAX_CHARS) } : {}),
    ...(typeof profile.bio === 'string' ? { fanBio: cap(profile.bio, GREETING_BIO_MAX_CHARS) } : {}),
    ...(avatar ? { fanAvatarUrl: avatar } : {}),
  };
}

export function buildGreetingContext(input: GreetingContextInput): GreetingContext {
  const kept = Math.min(input.messages.length, Math.max(0, Math.trunc(input.transcript.messageCount) || 0));
  return {
    ...greetingProfileFields(input.profile),
    // `slice(-0)` is the whole array, hence the explicit empty window.
    personalMessageCount: kept > 0 ? countPersonalMessages(input.messages.slice(-kept)) : 0,
  };
}
