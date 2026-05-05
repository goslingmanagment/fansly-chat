import type { FeatureType, ModelSelectableFeatureType, Settings } from './types.js';
import { FEATURE_POLICIES } from './features.js';
import type { FeaturePolicy } from './features.js';
export {
  AI_MODEL_GROUPS,
  AI_MODEL_IDS,
  AI_MODELS,
  CLAUDE_MODEL_IDS,
  CLAUDE_MODELS,
  DEFAULT_MODEL_ID,
  LEGACY_CLAUDE_MODEL_IDS,
  OPENROUTER_MODELS,
} from './model-registry.js';
import {
  DEFAULT_FAN_SUMMARY_MODEL_ID,
  DEFAULT_MODEL_ID,
} from './model-registry.js';

// ─── Storage ─────────────────────────────────────────────────────────────

export const STORAGE_SCHEMA_VERSION = 6;
export const SUMMARY_CACHE_PREFIX = 'summary:';
export const KNOWN_ACCOUNTS_KEY = 'knownAccounts';
export const SUMMARY_EVICTION_COUNT = 10;

// ─── AI Provider APIs ────────────────────────────────────────────────────

export const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
export const OPENROUTER_MESSAGES_API_URL = 'https://openrouter.ai/api/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export const DEFAULT_FEATURE_MODELS: Record<ModelSelectableFeatureType, string> = {
  'fast-reply': DEFAULT_MODEL_ID,
  'help-me': DEFAULT_MODEL_ID,
  'fan-summary': DEFAULT_FAN_SUMMARY_MODEL_ID,
  'chat-review': DEFAULT_MODEL_ID,
  'ping': DEFAULT_MODEL_ID,
};

export const MAX_TOKENS: Record<FeatureType, number> = {
  'fast-reply': 800,
  'improve-draft': 800,
  'help-me': 1200,
  'fan-summary': 8192,
  'chat-review': 1600,
  'ping': 800,
  'hi-greeting': 800,
};

export const FEATURE_TEMPERATURES: Record<FeatureType, number> = {
  'fast-reply': 0.65,
  'improve-draft': 0.65,
  'help-me': 0.45,
  'fan-summary': 0.4,
  'chat-review': 0.25,
  'ping': 0.65,
  'hi-greeting': 0.7,
};

export const COMPARE_TEMPERATURE = 0.35;

// ─── Fansly API ──────────────────────────────────────────────────────────

export const FANSLY_API_BASE = 'https://apiv3.fansly.com/api/v1';
export const FANSLY_PAGE_LIMIT = 25;
export const FANSLY_REQUEST_TIMEOUT_MS = 30_000;
export const FANSLY_PAGINATION_DELAY_MS = 300;
export const FANSLY_RETRY_DELAYS_MS = [1000, 2000, 4000];
export const FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT = 10;
export const FANSLY_MEDIA_PURCHASE_VERIFICATION_CONCURRENCY = 3;
export const FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS = 3_000;
export const FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Message Counts ──────────────────────────────────────────────────────

export const QUICK_DEFAULT_MESSAGE_COUNT = 100;
export const QUICK_MIN_MESSAGE_COUNT = 5;
export const QUICK_MAX_MESSAGE_COUNT = 200;
export const PING_DEFAULT_MESSAGE_COUNT = QUICK_DEFAULT_MESSAGE_COUNT;
export const PING_MIN_MESSAGE_COUNT = QUICK_MIN_MESSAGE_COUNT;
export const PING_MAX_MESSAGE_COUNT = QUICK_MAX_MESSAGE_COUNT;
export const IMPROVE_DEFAULT_MESSAGE_COUNT = 25;
export const IMPROVE_MIN_MESSAGE_COUNT = QUICK_MIN_MESSAGE_COUNT;
export const IMPROVE_MAX_MESSAGE_COUNT = QUICK_MAX_MESSAGE_COUNT;
export const DEEP_DEFAULT_MESSAGE_COUNT = 1500;
export const DEEP_MIN_MESSAGE_COUNT = 100;
export const DEEP_MAX_MESSAGE_COUNT = 3000;

// ─── Timeouts ────────────────────────────────────────────────────────────

export const QUICK_OPERATION_TIMEOUT_MS = 60_000;
export const DEEP_OPERATION_PREP_TIMEOUT_MS = 180_000;
export const DEEP_OPERATION_LLM_TTFB_TIMEOUT_MS = 45_000;
export const DEEP_OPERATION_LLM_IDLE_TIMEOUT_MS = 45_000;
export const DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS = 300_000;

// ─── Intervals & Throttles ──────────────────────────────────────────────

export const ROUTE_POLL_INTERVAL_MS = 500;
export const STREAM_CHUNK_FLUSH_MS = 50;
export const CONVERSATION_ATTACH_TIMEOUT_MS = 10_000;
export const CONVERSATION_ATTACH_RETRY_MS = 50;
export const PORT_RECONNECT_DELAYS_MS = [100, 200, 400];

// ─── Feature Thresholds ─────────────────────────────────────────────────

export const MIN_MESSAGES_FOR_DEEP = 30;
export const HI_GREETING_MAX_TRANSCRIPT = 10;
export const PING_ACTIVE_DAYS = 5;
export const PING_MIN_FAN_MESSAGES = 3;

// ─── Earnings ────────────────────────────────────────────────────────────

export const EARNINGS_FALLBACK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
export const AGENCY_HUB_PREFETCH_TIMEOUT_MS = 5_000;
export const AGENCY_HUB_SYNC_TIMEOUT_MS = 10_000;
export const AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS = 100;
export const AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS = 1_000;
export const AGENCY_HUB_AI_USAGE_REPORT_TIMEOUT_MS = 5_000;

// ─── UI ──────────────────────────────────────────────────────────────────

export const OVERLAY_Z_INDEX = 2147483646;
export const CHATGOOSE_NAMESPACE = 'chatgoose';

// ─── Feature Categories ─────────────────────────────────────────────────

export const DEEP_FEATURES: FeatureType[] = (
  Object.entries(FEATURE_POLICIES) as Array<[FeatureType, FeaturePolicy]>
)
  .filter(([, policy]) => policy.messageCountBucket === 'deep')
  .map(([feature]) => feature);
export const QUICK_FEATURES: FeatureType[] = (
  Object.entries(FEATURE_POLICIES) as Array<[FeatureType, FeaturePolicy]>
)
  .filter(([, policy]) => policy.messageCountBucket === 'quick')
  .map(([feature]) => feature);

export const FEATURE_LABELS: Record<FeatureType, string> = {
  'fast-reply': 'Reply',
  'improve-draft': 'Fix',
  'help-me': 'Help',
  'fan-summary': 'Summary',
  'chat-review': 'Review',
  'ping': 'Ping',
  'hi-greeting': 'Hi',
};

// ─── Default Settings ───────────────────────────────────────────────────

export const DEFAULT_SETTINGS: Settings = {
  claudeApiKey: '',
  openRouterApiKey: '',
  agencyHubBaseUrl: '',
  agencyHubApiKey: '',
  quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
  pingMessageCount: PING_DEFAULT_MESSAGE_COUNT,
  improveMessageCount: IMPROVE_DEFAULT_MESSAGE_COUNT,
  deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
  debugMode: false,
  promptCachingEnabled: true,
  featureModels: { ...DEFAULT_FEATURE_MODELS },
};

// ─── Build ──────────────────────────────────────────────────────────────

export const BUILD_TIME = __CHATGOOSE_BUILD_TIME__;
