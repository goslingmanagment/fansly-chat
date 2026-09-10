import type {
  FeatureType,
  ModelSelectableFeatureType,
  Settings,
} from './types.js';

export type FeatureMessageCountBucket = 'quick' | 'ping' | 'improve' | 'deep' | 'hi';
export type FeatureTimeoutBucket = 'quick' | 'deep';
export type FeatureSurfaceKind = 'inline-reply' | 'overlay' | 'panel-only';
export type FeaturePromptMode = 'reply' | 'analysis';
export type FeatureResultKind =
  | 'reply'
  | 'single-reply'
  | 'help-me'
  | 'summary'
  | 'chat-review'
  | 'coach-chat';

export interface FeaturePolicy {
  messageCountBucket: FeatureMessageCountBucket;
  timeoutBucket: FeatureTimeoutBucket;
  /** PREP-stage (live-read pagination) budget, split from `timeoutBucket` which
   * sizes the STREAM. Only meaningful for deep-timeout features. 'quick' caps prep
   * at QUICK_OPERATION_TIMEOUT_MS (coach reads a small quick window — ~4 pages —
   * so it needs no 360s prep budget); absent/'deep' keeps the deep prep budget
   * (fan-summary/chat-review paginate the full deep window). */
  prepTimeoutBucket?: FeatureTimeoutBucket;
  modelFeature: ModelSelectableFeatureType;
  surfaceKind: FeatureSurfaceKind;
  promptMode: FeaturePromptMode;
  resultKind: FeatureResultKind;
  supportsReplyMode: boolean;
  supportsReplyTone: boolean;
  requiresDraft: boolean;
  usesPingSegment: boolean;
  includesEarnings?: boolean;
  /** Whether the kernel request carries the fan's bio (account `about`). Mirrors
   * core's `includesFanBio` policy (spec §7): hi-greeting (existing), help-me
   * (its absence was a bug), and coach-chat. Absent ⇒ no bio. */
  includesFanBio?: boolean;
}

export const FEATURE_POLICIES = {
  'fast-reply': {
    messageCountBucket: 'quick',
    timeoutBucket: 'quick',
    modelFeature: 'fast-reply',
    surfaceKind: 'inline-reply',
    promptMode: 'reply',
    resultKind: 'reply',
    supportsReplyMode: true,
    supportsReplyTone: true,
    requiresDraft: false,
    usesPingSegment: false,
  },
  'improve-draft': {
    messageCountBucket: 'improve',
    timeoutBucket: 'quick',
    modelFeature: 'fast-reply',
    surfaceKind: 'inline-reply',
    promptMode: 'reply',
    resultKind: 'single-reply',
    supportsReplyMode: false,
    supportsReplyTone: false,
    requiresDraft: true,
    usesPingSegment: false,
  },
  'help-me': {
    messageCountBucket: 'quick',
    timeoutBucket: 'quick',
    modelFeature: 'help-me',
    surfaceKind: 'overlay',
    promptMode: 'analysis',
    resultKind: 'help-me',
    supportsReplyMode: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    includesFanBio: true,
  },
  'fan-summary': {
    messageCountBucket: 'deep',
    timeoutBucket: 'deep',
    modelFeature: 'fan-summary',
    surfaceKind: 'overlay',
    promptMode: 'analysis',
    resultKind: 'summary',
    supportsReplyMode: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
  },
  'chat-review': {
    messageCountBucket: 'deep',
    timeoutBucket: 'deep',
    modelFeature: 'chat-review',
    surfaceKind: 'overlay',
    promptMode: 'analysis',
    resultKind: 'chat-review',
    supportsReplyMode: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
  },
  ping: {
    messageCountBucket: 'ping',
    timeoutBucket: 'quick',
    modelFeature: 'ping',
    surfaceKind: 'inline-reply',
    promptMode: 'reply',
    resultKind: 'reply',
    supportsReplyMode: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: true,
    // E115: the fan's bio is a ping hook; Core Decision 290 flips the kernel
    // policy the same way, both sides gate by this flag.
    includesFanBio: true,
  },
  'hi-greeting': {
    messageCountBucket: 'hi',
    timeoutBucket: 'quick',
    modelFeature: 'fast-reply',
    surfaceKind: 'inline-reply',
    promptMode: 'reply',
    resultKind: 'reply',
    supportsReplyMode: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    includesEarnings: false,
    includesFanBio: true,
  },
  'coach-chat': {
    // The two buckets are deliberately SPLIT. Message count stays 'quick' (coach
    // reads a small live window, no deep pagination or MIN_MESSAGES_FOR_DEEP
    // gate), but the TIMEOUT bucket is 'deep': a coach answer is free-form advice
    // capped at COACH_ANSWER_MAX_CHARS (64 000 chars), so the quick 60s TOTAL
    // budget (QUICK_OPERATION_TIMEOUT_MS) would abort a long stream mid-answer
    // and — per the fail-closed rule — cost the chatter the whole generation plus
    // the spend. 'deep' timeouts give it TTFB + idle + max-stream budgets sized
    // for a long SSE stream instead of one 60s total ceiling.
    messageCountBucket: 'quick',
    timeoutBucket: 'deep',
    // Coach reads only the quick window (~4 pages), so its PREP budget is 'quick'
    // (60s) even though its STREAM budget is 'deep' (a 64k-char answer). Without
    // this it inherited the 360s deep-prep budget — a hung Fansly read during Coach
    // would freeze the chatter for 6 minutes vs 60s for any other quick-window feature.
    prepTimeoutBucket: 'quick',
    modelFeature: 'coach-chat',
    surfaceKind: 'overlay',
    promptMode: 'analysis',
    resultKind: 'coach-chat',
    supportsReplyMode: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    includesFanBio: true,
  },
  'voice-script': {
    messageCountBucket: 'quick',
    timeoutBucket: 'quick',
    modelFeature: 'voice-script',
    // Voice owns a dedicated panel/controller and never enters the generic
    // inline-reply or overlay operation surfaces.
    surfaceKind: 'panel-only',
    promptMode: 'analysis',
    // The dedicated runner forwards raw script text; this inert value keeps
    // the generic result builder non-insertable if the boundary ever regresses.
    resultKind: 'summary',
    supportsReplyMode: false,
    supportsReplyTone: true,
    requiresDraft: true,
    usesPingSegment: false,
    includesEarnings: false,
  },
} as const satisfies Record<FeatureType, FeaturePolicy>;

export function getFeaturePolicy(feature: FeatureType): FeaturePolicy {
  return FEATURE_POLICIES[feature];
}

export function isDeepFeature(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).messageCountBucket === 'deep';
}

export function usesInlineFeatureSurface(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).surfaceKind === 'inline-reply';
}

export function usesOverlayFeatureSurface(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).surfaceKind === 'overlay';
}

export function featureSupportsReplyMode(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).supportsReplyMode;
}

export function featureSupportsReplyTone(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).supportsReplyTone;
}

export function featureRequiresDraft(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).requiresDraft;
}

export function featureUsesPingSegment(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).usesPingSegment;
}

/** Whether the kernel request for this feature carries the fan's bio (spec §7). */
export function featureIncludesFanBio(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).includesFanBio === true;
}

export function resolveFeatureMessageCount(
  feature: FeatureType,
  settings: Settings,
): number {
  switch (getFeaturePolicy(feature).messageCountBucket) {
    case 'deep':
      return settings.deepMessageCount;
    case 'ping':
      return settings.pingMessageCount;
    case 'improve':
      return settings.improveMessageCount;
    case 'quick':
      return settings.quickMessageCount;
    case 'hi':
      return 25; // fixed: 1 Fansly API page, no user setting
  }
}

export function resolveFeatureModelFeature(
  feature: FeatureType,
): ModelSelectableFeatureType {
  return getFeaturePolicy(feature).modelFeature;
}
