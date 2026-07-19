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
  | 'chat-review';

export interface FeaturePolicy {
  messageCountBucket: FeatureMessageCountBucket;
  timeoutBucket: FeatureTimeoutBucket;
  modelFeature: ModelSelectableFeatureType;
  surfaceKind: FeatureSurfaceKind;
  promptMode: FeaturePromptMode;
  resultKind: FeatureResultKind;
  supportsReplyMode: boolean;
  supportsReplyTone: boolean;
  requiresDraft: boolean;
  usesPingSegment: boolean;
  includesEarnings?: boolean;
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
