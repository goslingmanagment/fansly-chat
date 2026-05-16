// ─── Enums & Literal Unions ───────────────────────────────────────────────

export type FeatureType = 'fast-reply' | 'improve-draft' | 'help-me' | 'fan-summary' | 'chat-review' | 'ping' | 'hi-greeting';
export type OperationPhase = 'idle' | 'loading-messages' | 'loading-earnings' | 'generating' | 'completed' | 'cancelled' | 'error';
export type PingSegment = 'segment-a' | 'segment-b' | 'active';
export type RouteKey = 'message' | 'group' | 'account' | 'earnings' | 'messagingGroups' | 'subscribers' | 'media';
export type FanSubscriptionSource = '/api/v1/messaging/groups' | '/api/v1/subscribers';
export type SubscriptionLookupMode = 'full' | 'cache-only';
export type ReplyMode = 'default' | 'preferSplit';
export type ReplyTone = 'none' | 'casual' | 'flirty' | 'upsell' | 'spicy';
export type ModelSelectableFeatureType = Exclude<FeatureType, 'improve-draft' | 'hi-greeting'>;
export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high' | 'max';

// ─── Settings & Storage ──────────────────────────────────────────────────

export interface Settings {
  claudeApiKey: string;
  openRouterApiKey: string;
  agencyHubBaseUrl: string;
  agencyHubApiKey: string;
  quickMessageCount: number;
  pingMessageCount: number;
  improveMessageCount: number;
  deepMessageCount: number;
  debugMode: boolean;
  promptCachingEnabled: boolean;
  featureModels: Record<ModelSelectableFeatureType, string>;
  featureReasoning: Record<ModelSelectableFeatureType, ReasoningEffort>;
}

export interface Personality {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
  builtin?: boolean;
  builtinVersion?: number;
}

export interface CompareDraftCard {
  id: string;
  label: string;
  content: string;
}

export interface CompareModelCard extends CompareDraftCard {
  source: 'draft' | 'current';
}

export type FanSummarySyncState =
  | 'not-set-up'
  | 'saving'
  | 'saved'
  | 'failed';

export interface FanSummarySyncStatus {
  state: FanSummarySyncState;
  generatedAt: number;
  baseUrl?: string;
  pageLabel?: string;
  syncedAt?: number;
  updatedAt?: number;
  error?: UserFacingError;
}

export interface LegacyAgencyHubSummarySyncMetadata {
  generatedAt: number;
  baseUrl: string;
  pageLabel: string;
  syncedAt: number;
  updatedAt?: number;
  state?: undefined;
}

export type AgencyHubSummarySyncMetadata =
  | FanSummarySyncStatus
  | LegacyAgencyHubSummarySyncMetadata;

export interface FanSummaryMeta {
  generatedAt: number;
  stale: boolean;
  cached: boolean;
  syncStatus?: FanSummarySyncStatus;
}

export interface SummaryCacheEntry {
  summary: string;
  personalityId: string;
  personalityUpdatedAt: number;
  generatedAt: number;
  spendingDataVerified?: boolean;
  subscriptionLookupVerified?: boolean;
  modelId?: string;
  fanAccountId?: string | null;
  agencyHubSync?: AgencyHubSummarySyncMetadata;
}

export interface PersistedState {
  schemaVersion: number;
  settings: Settings;
  personalities: Personality[];
  accountMappings: Record<string, string>;
  accountAliases: Record<string, string>;
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
  fanBio?: string;
  draftText?: string;
  pingSegment?: PingSegment;
  replyMode?: ReplyMode;
  replyTone?: ReplyTone;
}

export interface PromptCacheControl {
  type: 'ephemeral';
  ttl?: '1h';
}

export interface PromptTextBlock {
  type: 'text';
  text: string;
  cache_control?: PromptCacheControl;
}

export interface LlmCacheCreationUsage {
  ephemeral_5m_input_tokens: number;
  ephemeral_1h_input_tokens: number;
}

export interface LlmUsageMetrics {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cache_creation?: LlmCacheCreationUsage;
}

export type LlmReasoningSignal =
  | 'thinking_block'
  | 'redacted_thinking_block'
  | 'thinking_delta'
  | 'signature_delta'
  | 'reasoning_delta';

export interface LlmCostEstimate {
  modelId: string;
  inputUsd: number;
  cacheWrite5mUsd: number;
  cacheWrite1hUsd: number;
  cacheReadUsd: number;
  outputUsd: number;
  totalUsd: number;
  approximate: boolean;
}

export interface LlmSpendSummary {
  totalTokens: number;
  inputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalUsd: number;
  uncachedUsd: number;
  cacheEffectUsd: number;
  cacheEffectKind: 'saved' | 'overhead' | 'neutral';
  cacheWriteUsd: number;
  cacheReadUsd: number;
  approximate: boolean;
}

export interface PromptPayload {
  system: string;
  user: string;
  systemBlocks: PromptTextBlock[];
  userBlocks: PromptTextBlock[];
}

export interface PromptDebugSnapshot {
  feature: FeatureType;
  modelId: string;
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
  pos?: number;
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

export interface FanslyMediaPermissionFlag {
  flags?: number;
  price?: number;
  metadata?: string;
  type?: number;
}

export interface FanslyMediaPermissions {
  permissionFlags?: FanslyMediaPermissionFlag[];
}

// Real `accountMedia[i].media` payload — `type` and `mimetype` live here on the
// wire. Top-level `accountMedia.{type,mimetype}` are null on real items and are
// kept only as a legacy fallback.
export interface FanslyMediaInner {
  id?: string;
  type?: number;
  mimetype?: string;
  metadata?: string;
}

export interface FanslyMedia {
  id: string;
  accountId?: string;
  media?: FanslyMediaInner;
  // Legacy fallbacks. Current API responses leave these null/undefined for
  // accountMedia entries; read them only after `media.media.{type,mimetype}`.
  mimetype?: string;
  type?: number;
  // Viewer-perspective access flags. NOT fan-purchase proof — in a model
  // session these are essentially always `true` for the model's own content.
  purchased?: boolean;
  access?: boolean;
  whitelisted?: boolean;
  permissionFlags?: number;
  price?: number;
  permissions?: FanslyMediaPermissions;
}

export interface FanslyMediaBundleContentEntry {
  accountMediaId?: string;
  pos?: number;
}

export interface FanslyMediaBundle {
  id: string;
  accountId?: string;
  accountMediaIds?: string[];
  bundleContent?: FanslyMediaBundleContentEntry[];
  // Same viewer-perspective warning as FanslyMedia.
  purchased?: boolean;
  access?: boolean;
  whitelisted?: boolean;
  permissionFlags?: number;
  price?: number;
  permissions?: FanslyMediaPermissions;
}

// Inline order rows from the `/api/v1/message` page. The bundle id lives in
// `accountMediaId` (with `type === 2`); `accountMediaBundleId` only appears on
// the `/media/orderhistory` shape and is supported defensively.
export interface FanslyAccountMediaOrder {
  accountId?: string;
  accountMediaId?: string;
  accountMediaBundleId?: string;
  type?: number;
  createdAt?: number;
}

export interface FanslyMediaOrderHistoryResponse {
  accountMediaOrderHistory?: FanslyAccountMediaOrder[];
  aggregationData?: {
    accountMediaOrders?: FanslyAccountMediaOrder[];
  };
}

export interface FanslyMessagePageResponse {
  messages: FanslyMessage[];
  accountMedia: FanslyMedia[];
  accountMediaBundles: FanslyMediaBundle[];
  accountMediaOrders?: FanslyAccountMediaOrder[];
}

export interface FanslyGroupResponse {
  id: string;
  users: Array<{ userId: string }>;
}

export interface FanslyAccountResponse {
  id: string;
  username?: string | null;
  displayName?: string | null;
  about?: string | null;
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
  monthlyTotals: MonthlyEarningsTotal[];
  monthlyBreakdowns?: MonthlyTypeBreakdown[];
  monthlyBreakdownsPartial?: boolean;
}

export interface MonthlyEarningsRow {
  year: number;
  month: number;
  totalGross: number;
  totalNet: number;
  accountId: string;
  correlationAccountId: string;
  timestamp: number;
}

export interface MonthlyEarningsTotal {
  year: number;
  month: number;
  totalGross: number;
  totalNet: number;
}

export interface MonthlyTypeBreakdown {
  year: number;
  month: number;
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

// ─── Subscription Tiers (richer) ──────────────────────────

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
  summaryMeta?: FanSummaryMeta;
}

// ─── Errors ──────────────────────────────────────────────────────────────

export interface ChatGooseErrorDetails {
  status?: number;
  responseSnippet?: string;
  retryAfterMs?: number;
  retryAtMs?: number;
  providerMessage?: string;
  provider?: string;
}

export type UserErrorKey =
  | 'not_connected'
  | 'session_expired'
  | 'fansly_server_error'
  | 'missing_api_key'
  | 'invalid_api_key'
  | 'rate_limited'
  | 'insufficient_balance'
  | 'no_personalities'
  | 'not_enough_history'
  | 'another_operation'
  | 'ping_blocked'
  | 'network_error'
  | 'timed_out'
  | 'no_mapping'
  | 'chat_changed'
  | 'extension_reloaded'
  | 'model_unavailable'
  | 'context_too_long'
  | 'service_unavailable'
  | 'ai_output_unusable'
  | 'hub_invalid_url'
  | 'hub_missing_api_key'
  | 'hub_invalid_api_key'
  | 'hub_missing_permission'
  | 'hub_page_match_failed'
  | 'hub_timeout'
  | 'hub_request_failed'
  | 'hub_sync_failed'
  | 'compare_cards_unavailable'
  | 'hi_too_many_messages'
  | 'insertion_failed'
  | 'unknown_error';

export interface UserFacingError {
  key: UserErrorKey;
  code: string;
  message: string;
  description?: string;
  settingsLink?: boolean;
  retryAtMs?: number;
  retryAfterMs?: number;
}

// ─── Operation Profiling ─────────────────────────────────────────────────

export type OperationProfilingStageKey =
  | 'resolve-identity'
  | 'summary-cache-check'
  | 'load-messages'
  | 'ping-analysis'
  | 'group-lookup'
  | 'account-name-lookup'
  | 'earnings'
  | 'subscription-lookup'
  | 'prompt-build'
  | 'llm-ttfb'
  | 'llm-stream';

export type OperationProfilingStageStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface OperationProfilingLogEntry {
  elapsedMs: number;
  message: string;
}

export interface OperationProfilingStage {
  key: OperationProfilingStageKey;
  label: string;
  status: OperationProfilingStageStatus;
  startedElapsedMs: number;
  endedElapsedMs?: number;
  durationMs?: number;
  detail?: string;
}

export interface OperationProfilingSnapshot {
  elapsedMs: number;
  activeLabel: string | null;
  logEntries: OperationProfilingLogEntry[];
  stages: OperationProfilingStage[];
  llmUsage?: LlmUsageMetrics;
  llmCost?: LlmCostEstimate;
  reasoningBlock?: string;
}

// ─── Operation Progress ──────────────────────────────────────────────────

export interface OperationProgressPayload {
  operationId: string;
  feature: FeatureType;
  phase: OperationPhase;
  currentPage?: number;
  targetPages?: number;
  message?: string;
  statusCode?: string;
  retryAtMs?: number;
  llmSpend?: LlmSpendSummary;
  profiling?: OperationProfilingSnapshot;
}

// ─── Tab UI State ────────────────────────────────────────────────────────

export interface TabUiState {
  tabId: number;
  accountId: string | null;
  groupId: string | null;
  hasAvailableSummary: boolean;
  connected: boolean;
  hasApiKey: boolean;
  modelProviderByFeature?: Partial<Record<ModelSelectableFeatureType, 'anthropic' | 'openrouter'>>;
  apiKeyReadyByFeature?: Partial<Record<ModelSelectableFeatureType, boolean>>;
  hasPersonalities: boolean;
  mappedPersonalityId: string | null;
  mappedPersonalityName: string | null;
  compareCardCount: number;
  compareDraftCount: number;
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
  testAgencyHubConnection: AgencyHubConnectionTestRequest;
}

export interface RuntimeResponseMap {
  getPopupStatus: PopupStatus;
  getSessionsSnapshot: SessionSnapshotEntry[];
  testAgencyHubConnection: AgencyHubConnectionTestResponse;
}

export interface AgencyHubConnectionTestRequest {
  settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey'>;
}

export interface AgencyHubConnectionTestResponse {
  ok: boolean;
  error?: UserFacingError;
}

export interface AgencyHubAiUsageEvent {
  clientEventId: string;
  feature: FeatureType;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  conversationId: string | null;
  durationMs: number | null;
  isCacheHit: boolean;
  isRegeneration: boolean;
  completedAt: string;
}

export interface AgencyHubAiUsageBatchResponse {
  receivedCount: number;
  insertedCount: number;
  dedupedCount: number;
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
    | 'compare:start'
    | 'compare:cancel'
    | 'compare:ready'
    | 'compare:progress'
    | 'compare:chunk'
    | 'compare:cardComplete'
    | 'compare:cardError'
    | 'compare:error'
    | 'compare:complete'
    | 'compare:discarded'
    | 'settings:changed'
    | 'mapping:changed'
    | 'summary:syncStatus';
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
  draftText?: string;
  forceRegenerate?: boolean;
  replyMode?: ReplyMode;
  replyTone?: ReplyTone;
}

export interface CompareStartPayload extends PortEnvelopeBase {
  type: 'compare:start';
  operationId: string;
  groupId: string | null;
  routeNonce: number;
  domFanDisplayName: string | null;
  forceRegenerate?: boolean;
  replyMode?: ReplyMode;
  replyTone?: ReplyTone;
}

export interface OperationCancelPayload extends PortEnvelopeBase {
  type: 'operation:cancel';
  operationId: string;
}

export interface CompareCancelPayload extends PortEnvelopeBase {
  type: 'compare:cancel';
  operationId: string;
}

export type ContentPortMessage =
  | TabInitPayload
  | RouteChangedPayload
  | OperationStartPayload
  | OperationCancelPayload
  | CompareStartPayload
  | CompareCancelPayload;

// Background → Content

export interface ChunkPayload extends PortEnvelopeBase {
  type: 'operation:chunk';
  operationId: string;
  text: string;
}

export interface CompareReadyPayload extends PortEnvelopeBase {
  type: 'compare:ready';
  operationId: string;
  fanDisplayName: string;
  cards: Array<Pick<CompareModelCard, 'id' | 'label' | 'source'>>;
}

export interface CompareChunkPayload extends PortEnvelopeBase {
  type: 'compare:chunk';
  operationId: string;
  cardId: string;
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
  llmSpend?: LlmSpendSummary;
  profiling?: OperationProfilingSnapshot;
}

export interface ErrorPayload extends PortEnvelopeBase {
  type: 'operation:error';
  operationId: string;
  error: UserFacingError;
  llmSpend?: LlmSpendSummary;
  profiling?: OperationProfilingSnapshot;
}

export interface DiscardedPayload extends PortEnvelopeBase {
  type: 'operation:discarded';
  operationId: string;
  error: UserFacingError;
  llmSpend?: LlmSpendSummary;
  profiling?: OperationProfilingSnapshot;
}

export interface CompareCardCompletePayload extends PortEnvelopeBase {
  type: 'compare:cardComplete';
  operationId: string;
  cardId: string;
  result: FeatureResult;
  fanDisplayName: string;
  llmSpend?: LlmSpendSummary;
  profiling?: OperationProfilingSnapshot;
}

export interface CompareCardErrorPayload extends PortEnvelopeBase {
  type: 'compare:cardError';
  operationId: string;
  cardId: string;
  error: UserFacingError;
  llmSpend?: LlmSpendSummary;
  profiling?: OperationProfilingSnapshot;
}

export interface CompareErrorPayload extends PortEnvelopeBase {
  type: 'compare:error';
  operationId: string;
  error: UserFacingError;
  profiling?: OperationProfilingSnapshot;
}

export interface CompareCompletePayload extends PortEnvelopeBase {
  type: 'compare:complete';
  operationId: string;
  fanDisplayName: string;
  profiling?: OperationProfilingSnapshot;
}

export interface CompareDiscardedPayload extends PortEnvelopeBase {
  type: 'compare:discarded';
  operationId: string;
  error: UserFacingError;
  profiling?: OperationProfilingSnapshot;
}

export interface TabStatePayload extends PortEnvelopeBase {
  type: 'tab:state' | 'settings:changed' | 'mapping:changed';
  state: TabUiState;
}

export interface SummarySyncStatusPayload extends PortEnvelopeBase {
  type: 'summary:syncStatus';
  groupId: string;
  generatedAt: number;
  syncStatus: FanSummarySyncStatus;
}

export interface ProgressEnvelope extends PortEnvelopeBase, OperationProgressPayload {
  type: 'operation:progress';
}

export interface CompareProgressPayload {
  operationId: string;
  phase: OperationPhase;
  currentPage?: number;
  targetPages?: number;
  message?: string;
  fanDisplayName?: string;
  profiling?: OperationProfilingSnapshot;
}

export interface CompareProgressEnvelope extends PortEnvelopeBase, CompareProgressPayload {
  type: 'compare:progress';
}

export type BackgroundPortMessage =
  | ChunkPayload
  | CompareReadyPayload
  | CompareChunkPayload
  | DebugPromptPayload
  | CompletePayload
  | ErrorPayload
  | DiscardedPayload
  | CompareCardCompletePayload
  | CompareCardErrorPayload
  | CompareErrorPayload
  | CompareCompletePayload
  | CompareDiscardedPayload
  | TabStatePayload
  | SummarySyncStatusPayload
  | ProgressEnvelope
  | CompareProgressEnvelope;

// ─── Overlay View Model ──────────────────────────────────────────────────

export interface OverlayInsertPart {
  id: string;
  sequenceIndex: number;
  text: string;
  insertedAt: number | null;
  insertedOnce: boolean;
}

export type OverlayRerunActionLabel = 'Regenerate' | 'Refresh';

export interface CompareInlineTabState {
  cardId: string;
  label: string;
  source: 'draft' | 'current';
  status: 'loading' | 'reply' | 'error';
  rawText: string;
  parts: OverlayInsertPart[];
  llmSpend?: LlmSpendSummary;
  splitModeRequested?: boolean;
  error?: UserFacingError;
}

export interface CompareInlineViewModel {
  kind: 'compare';
  fanDisplayName: string;
  operationId: string | null;
  tabs: CompareInlineTabState[];
  activeCardId: string | null;
  progress: CompareProgressPayload | null;
  canCancel: boolean;
  canRegenerate: boolean;
}

export type OverlayViewModel =
  | { kind: 'hidden' }
  | {
      kind: 'loading';
      feature: FeatureType;
      fanDisplayName: string;
      progress: OperationProgressPayload | null;
      rawText: string;
      debugPrompt?: PromptDebugSnapshot;
      llmSpend?: LlmSpendSummary;
      profiling?: OperationProfilingSnapshot;
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
      llmSpend?: LlmSpendSummary;
      profiling?: OperationProfilingSnapshot;
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
      llmSpend?: LlmSpendSummary;
      profiling?: OperationProfilingSnapshot;
      rerunActionLabel?: OverlayRerunActionLabel;
      debugPrompt?: PromptDebugSnapshot;
      error?: UserFacingError;
    }
  | {
      kind: 'readOnly';
      feature: FeatureType;
      fanDisplayName: string;
      operationId: string;
      rawText: string;
      summaryMeta?: FanSummaryMeta;
      reviewMeta?: {
        rating: number | null;
        evaluation: string | null;
        recommendations: string | null;
        parseFallback: boolean;
      };
      llmSpend?: LlmSpendSummary;
      profiling?: OperationProfilingSnapshot;
      rerunActionLabel?: OverlayRerunActionLabel;
      debugPrompt?: PromptDebugSnapshot;
      error?: UserFacingError;
    }
  | {
      kind: 'error';
      feature: FeatureType;
      fanDisplayName: string;
      operationId: string | null;
      debugPrompt?: PromptDebugSnapshot;
      llmSpend?: LlmSpendSummary;
      profiling?: OperationProfilingSnapshot;
      error: UserFacingError;
    };

export type CompletedOverlayViewModel = Extract<
  OverlayViewModel,
  { kind: 'reply' | 'helpMe' | 'readOnly' }
>;

export type InlinePanelViewModel =
  | OverlayViewModel
  | CompareInlineViewModel;
