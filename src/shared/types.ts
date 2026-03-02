// ─── Enums & Literal Unions ───────────────────────────────────────────────

export type FeatureType = 'fast-reply' | 'help-me' | 'fan-summary' | 'chat-review' | 'ping';
export type OperationPhase = 'idle' | 'loading-messages' | 'loading-earnings' | 'generating' | 'completed' | 'cancelled' | 'error';
export type PingSegment = 'segment-a' | 'segment-b' | 'active';
export type RouteKey = 'message' | 'group' | 'account' | 'earnings' | 'messagingGroups' | 'subscribers';
export type FanSubscriptionSource = '/api/v1/messaging/groups' | '/api/v1/subscribers';
export type ReplyMode = 'default' | 'preferSplit';

// ─── Settings & Storage ──────────────────────────────────────────────────

export interface Settings {
  claudeApiKey: string;
  quickMessageCount: number;
  deepMessageCount: number;
  debugMode: boolean;
}

export interface Personality {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
}

export interface SummaryCacheEntry {
  summary: string;
  personalityId: string;
  personalityUpdatedAt: number;
  generatedAt: number;
  spendingDataVerified?: boolean;
  subscriptionLookupVerified?: boolean;
}

export interface PersistedState {
  schemaVersion: number;
  settings: Settings;
  personalities: Personality[];
  accountMappings: Record<string, string>;
  knownAccounts: string[];
  [summaryKey: `summary:${string}`]: SummaryCacheEntry | unknown;
}

// ─── Session & Tab Context ───────────────────────────────────────────────

export interface SessionTemplate {
  accountId: string;
  resolvedAccountId: string | null;
  resolvedUsername: string | null;
  resolvedDisplayName: string | null;
  authorization: string;
  fanslyClientId: string;
  fanslySessionId: string;
  latestTs: string;
  latestCheck: string | null;
  routeChecks: Partial<Record<RouteKey, string>>;
  lastSeenAt: number;
  connected: boolean;
}

export interface CapturedSessionHeaders {
  authorization: string;
  fanslyClientId: string;
  fanslyClientTs: string;
  fanslySessionId: string;
  fanslyClientCheck?: string;
}

export interface TabContext {
  tabId: number;
  accountId: string | null;
  groupId: string | null;
  fanAccountId: string | null;
  fanDisplayName: string | null;
  activeOperationId: string | null;
  routeNonce: number;
}

// ─── Prompt Building ─────────────────────────────────────────────────────

export interface PromptBuildInput {
  feature: FeatureType;
  personality: Personality;
  transcript: string;
  fanSpendingData: string;
  fanSubscriptionData: string;
  fanDisplayName: string;
  pingSegment?: PingSegment;
  replyMode?: ReplyMode;
}

export interface PromptPayload {
  system: string;
  user: string;
}

export interface PromptDebugSnapshot {
  feature: FeatureType;
  system: string;
  transcript: string;
  fanSpendingData: string;
  fanSubscriptionData: string;
  user: string;
}

// ─── Transcript & Ping ──────────────────────────────────────────────────

export interface PingSegmentAnalysis {
  segment: PingSegment;
  fanTextMessageCount: number;
  latestFanTextAtMs: number | null;
  latestOverallTextSender: 'Model' | 'Fan' | null;
  latestOverallTextAtMs: number | null;
}

export interface NormalizedTranscriptMessage {
  id: string;
  createdAt: number;
  senderId: string;
  senderLabel: 'Model' | 'Fan';
  type: number;
  text: string;
  labels: string[];
}

// ─── Fansly API Types ────────────────────────────────────────────────────

export interface FanslyAttachment {
  contentType?: number;
  contentId?: string;
  fileName?: string;
  mimetype?: string;
}

export interface FanslyMessage {
  id: string;
  type: number;
  content: string;
  groupId: string;
  senderId: string;
  createdAt: number;
  attachments: FanslyAttachment[];
  embeds: unknown[];
  totalTipAmount?: number;
}

export interface FanslyMedia {
  id: string;
  mimetype?: string;
  type?: number;
}

export interface FanslyMediaBundleItem {
  media?: { type?: number }[];
}

export interface FanslyMediaBundle {
  id: string;
  accountMedia?: FanslyMediaBundleItem[];
}

export interface FanslyMessagePageResponse {
  messages: FanslyMessage[];
  accountMedia: FanslyMedia[];
  accountMediaBundles: FanslyMediaBundle[];
}

export interface FanslyGroupResponse {
  id: string;
  users: Array<{ userId: string }>;
}

export interface FanslyAccountResponse {
  id: string;
  username?: string | null;
  displayName?: string | null;
}

// ─── Earnings ────────────────────────────────────────────────────────────

export interface EarningsRow {
  type: number;
  totalGross: number;
  totalNet: number;
  accountId: string;
  correlationAccountId: string;
  timestamp: number;
}

export interface EarningsBreakdownEntry {
  label: string;
  type: number;
  gross: number;
  net: number;
}

export interface AggregatedEarnings {
  correlationAccountId: string;
  windowStartIso: string;
  windowEndIso: string;
  totalGross: number;
  totalNet: number;
  breakdown: EarningsBreakdownEntry[];
}

// ─── Subscriptions ───────────────────────────────────────────────────────

export interface FanslySubscribersStats {
  totalActive: number;
  totalExpired: number;
  total: number;
}

export interface FanslySubscriberSubscriptionRecord {
  id: string;
  subscriberId: string;
  subscriptionTierId: string;
  subscriptionTierName?: string | null;
  planId?: string | null;
  status: number;
  price: number;
  renewPrice?: number | null;
  autoRenew?: number | null;
  billingCycle?: number | null;
  giftCodeId?: string | null;
  promoId?: string | null;
  promoPrice?: number | null;
  promoDuration?: number | null;
  promoStatus?: number | null;
  promoStartsAt?: number | null;
  promoEndsAt?: number | null;
  renewDate?: number | null;
  endsAt?: number | null;
  createdAt?: number | null;
}

export interface FanslySubscribersResponse {
  stats?: FanslySubscribersStats;
  subscriptions?: FanslySubscriberSubscriptionRecord[];
}

export interface FanslyMessagingGroupEntry {
  groupId: string;
  partnerAccountId?: string | null;
  subscriptionTierId?: string | null;
}

export interface FanslyMessagingGroupAccount {
  id: string;
  subscriberSubscription?: FanslySubscriberSubscriptionRecord | null;
}

export interface FanslyMessagingGroupsResponse {
  data?: FanslyMessagingGroupEntry[];
  aggregationData?: {
    accounts?: FanslyMessagingGroupAccount[];
  };
}

export interface FanSubscriptionContext {
  source: FanSubscriptionSource;
  subscriptionId: string;
  subscriberAccountId: string;
  status: number;
  subscriptionTierId: string;
  subscriptionTierName: string | null;
  planId: string | null;
  price: number;
  renewPrice: number | null;
  autoRenew: boolean | null;
  billingCycle: number | null;
  giftCodeId: string | null;
  promoId: string | null;
  promoPrice: number | null;
  promoDuration: number | null;
  promoStatus: number | null;
  promoStartsAtIso: string | null;
  promoEndsAtIso: string | null;
  renewDateIso: string | null;
  endsAtIso: string | null;
  createdAtIso: string | null;
}

// ─── Subscription Tiers (from Claude — richer) ──────────────────────────

export interface FanslySubscriptionTier {
  id: string;
  name: string;
  price: number;
  subscriptionBenefits: string[];
  plans: FanslySubscriptionPlan[];
}

export interface FanslySubscriptionPlan {
  id: string;
  status: number;
  billingCycle: number;
  price: number;
}

// ─── XML Parsing Results ─────────────────────────────────────────────────

export interface HelpMeParsed {
  coaching: string | null;
  engaging: string | null;
  flirty: string | null;
  raw: string;
  valid: boolean;
}

export interface ChatReviewParsed {
  rating: number | null;
  evaluation: string | null;
  recommendations: string | null;
  raw: string;
  valid: boolean;
}

export interface FeatureResult {
  rawText: string;
  parts?: string[];
  splitModeRequested?: boolean;
  helpMe?: HelpMeParsed;
  chatReview?: ChatReviewParsed;
  summaryMeta?: { generatedAt: number; stale: boolean; cached: boolean };
}

// ─── Errors ──────────────────────────────────────────────────────────────

export interface FanslyApiErrorDetails {
  status?: number;
  responseSnippet?: string;
}

export type UserErrorCode =
  | 'not_connected'
  | 'session_expired'
  | 'fansly_server_error'
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'claude_overloaded'
  | 'no_personalities'
  | 'not_enough_history'
  | 'another_operation'
  | 'ping_blocked'
  | 'network_error'
  | 'timed_out'
  | 'no_mapping'
  | 'chat_changed'
  | 'extension_reloaded'
  | 'insertion_failed'
  | 'unknown_error';

export interface UserFacingError {
  code: UserErrorCode;
  message: string;
  settingsLink?: boolean;
}

// ─── Operation Progress ──────────────────────────────────────────────────

export interface OperationProgressPayload {
  operationId: string;
  feature: FeatureType;
  phase: OperationPhase;
  currentPage?: number;
  targetPages?: number;
  message?: string;
}

// ─── Tab UI State ────────────────────────────────────────────────────────

export interface TabUiState {
  tabId: number;
  accountId: string | null;
  groupId: string | null;
  connected: boolean;
  hasApiKey: boolean;
  hasPersonalities: boolean;
  mappedPersonalityId: string | null;
  mappedPersonalityName: string | null;
}

export interface PopupStatus extends TabUiState {
  accountLabel: string;
}

export interface SessionSnapshotEntry {
  legacyAccountId: string;
  resolvedAccountId: string | null;
  username: string | null;
  displayName: string | null;
  connected: boolean;
  lastSeenAt: number;
}

// ─── Runtime API ─────────────────────────────────────────────────────────

export interface RuntimeRequestMap {
  getPopupStatus: undefined;
  getSessionsSnapshot: undefined;
}

export interface RuntimeResponseMap {
  getPopupStatus: PopupStatus;
  getSessionsSnapshot: SessionSnapshotEntry[];
}

// ─── Port Messages (Discriminated Unions) ────────────────────────────────

export interface PortEnvelopeBase {
  type:
    | 'tab:init'
    | 'tab:routeChanged'
    | 'tab:state'
    | 'operation:start'
    | 'operation:cancel'
    | 'operation:debugPrompt'
    | 'operation:progress'
    | 'operation:chunk'
    | 'operation:complete'
    | 'operation:error'
    | 'operation:discarded'
    | 'settings:changed'
    | 'mapping:changed';
}

// Content → Background

export interface TabInitPayload extends PortEnvelopeBase {
  type: 'tab:init';
  groupId: string | null;
  routeNonce: number;
}

export interface RouteChangedPayload extends PortEnvelopeBase {
  type: 'tab:routeChanged';
  groupId: string | null;
  routeNonce: number;
}

export interface OperationStartPayload extends PortEnvelopeBase {
  type: 'operation:start';
  operationId: string;
  feature: FeatureType;
  groupId: string | null;
  routeNonce: number;
  domFanDisplayName: string | null;
  forceRegenerate?: boolean;
  replyMode?: ReplyMode;
}

export interface OperationCancelPayload extends PortEnvelopeBase {
  type: 'operation:cancel';
  operationId: string;
}

export type ContentPortMessage =
  | TabInitPayload
  | RouteChangedPayload
  | OperationStartPayload
  | OperationCancelPayload;

// Background → Content

export interface ChunkPayload extends PortEnvelopeBase {
  type: 'operation:chunk';
  operationId: string;
  text: string;
}

export interface DebugPromptPayload extends PortEnvelopeBase {
  type: 'operation:debugPrompt';
  operationId: string;
  feature: FeatureType;
  snapshot: PromptDebugSnapshot;
}

export interface CompletePayload extends PortEnvelopeBase {
  type: 'operation:complete';
  operationId: string;
  result: FeatureResult;
  fanDisplayName: string;
}

export interface ErrorPayload extends PortEnvelopeBase {
  type: 'operation:error';
  operationId: string;
  error: UserFacingError;
}

export interface DiscardedPayload extends PortEnvelopeBase {
  type: 'operation:discarded';
  operationId: string;
  error: UserFacingError;
}

export interface TabStatePayload extends PortEnvelopeBase {
  type: 'tab:state' | 'settings:changed' | 'mapping:changed';
  state: TabUiState;
}

export interface ProgressEnvelope extends PortEnvelopeBase, OperationProgressPayload {
  type: 'operation:progress';
}

export type BackgroundPortMessage =
  | ChunkPayload
  | DebugPromptPayload
  | CompletePayload
  | ErrorPayload
  | DiscardedPayload
  | TabStatePayload
  | ProgressEnvelope;

// ─── Overlay View Model ──────────────────────────────────────────────────

export interface OverlayInsertPart {
  id: string;
  sequenceIndex: number;
  text: string;
  insertedAt: number | null;
  insertedOnce: boolean;
}

export type OverlayRerunActionLabel = 'Regenerate' | 'Refresh';

export type OverlayViewModel =
  | { kind: 'hidden' }
  | {
      kind: 'loading';
      feature: FeatureType;
      fanDisplayName: string;
      progress: OperationProgressPayload | null;
      rawText: string;
      debugPrompt?: PromptDebugSnapshot;
      canCancel: boolean;
      canRegenerate: boolean;
      operationId: string;
    }
  | {
      kind: 'reply';
      feature: FeatureType;
      fanDisplayName: string;
      operationId: string;
      parts: OverlayInsertPart[];
      rawText: string;
      splitModeRequested?: boolean;
      debugPrompt?: PromptDebugSnapshot;
      rerunActionLabel?: OverlayRerunActionLabel;
      error?: UserFacingError;
    }
  | {
      kind: 'helpMe';
      feature: 'help-me';
      fanDisplayName: string;
      operationId: string;
      rawText: string;
      coaching: string | null;
      engagingParts: OverlayInsertPart[];
      flirtyParts: OverlayInsertPart[];
      parseFallback: boolean;
      rerunActionLabel?: OverlayRerunActionLabel;
      error?: UserFacingError;
    }
  | {
      kind: 'readOnly';
      feature: FeatureType;
      fanDisplayName: string;
      operationId: string;
      rawText: string;
      summaryMeta?: { generatedAt: number; stale: boolean; cached: boolean };
      reviewMeta?: {
        rating: number | null;
        evaluation: string | null;
        recommendations: string | null;
        parseFallback: boolean;
      };
      rerunActionLabel?: OverlayRerunActionLabel;
      error?: UserFacingError;
    }
  | {
      kind: 'error';
      feature: FeatureType;
      fanDisplayName: string;
      operationId: string | null;
      debugPrompt?: PromptDebugSnapshot;
      error: UserFacingError;
    };

export type CompletedOverlayViewModel = Extract<
  OverlayViewModel,
  { kind: 'reply' | 'helpMe' | 'readOnly' }
>;
