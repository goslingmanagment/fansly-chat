import type {
  FeatureType,
  Settings,
} from './types.js';
import { FEATURE_POLICIES } from './features.js';
import type { FeaturePolicy } from './features.js';

// ─── Storage ─────────────────────────────────────────────────────────────

export const STORAGE_SCHEMA_VERSION = 10;
export const SUMMARY_CACHE_PREFIX = 'summary:';
export const KNOWN_ACCOUNTS_KEY = 'knownAccounts';
export const SUMMARY_EVICTION_COUNT = 10;

// Stage 32: model/provider config is kernel-side — the vendor endpoints,
// per-feature model/reasoning defaults, token caps, and temperatures died
// with the direct AI lane.


export const COMPARE_TEMPERATURE = 0.35;

// ─── Fansly API ──────────────────────────────────────────────────────────

export const FANSLY_API_BASE = 'https://apiv3.fansly.com/api/v1';
export const FANSLY_PAGE_LIMIT = 25;
export const FANSLY_REQUEST_TIMEOUT_MS = 30_000;
export const FANSLY_PAGINATION_DELAY_MS = 300;
export const FANSLY_RETRY_DELAYS_MS = [1000, 2000, 4000];
// Cap on how long a Retry-After header may delay a single retry, so a long
// server-requested wait surfaces as rate_limited instead of stalling the op.
export const FANSLY_RETRY_MAX_BACKOFF_MS = 5_000;
export const FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT = 10;
export const FANSLY_MEDIA_PURCHASE_VERIFICATION_CONCURRENCY = 3;
export const FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS = 3_000;
export const FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Spenders board ──────────────────────────────────────────────────────
// A ranked top-spenders list has no single Fansly endpoint: it enumerates
// conversations, then fetches lifetime earnings per fan (one call each). To
// keep the burst bounded and avoid hammering Fansly, the scan is capped, runs
// at low concurrency, and the result is cached per creator for a short window.

/** Most-recent conversations to fetch lifetime spend for before ranking. */
export const SPENDERS_MAX_FANS = 150;
/** Concurrent per-fan earnings fetches (matches the monthly-breakdown fan-out). */
export const SPENDERS_EARNINGS_CONCURRENCY = 4;
/** Reuse a built board for this long before a fresh scan is allowed. */
export const SPENDERS_CACHE_TTL_MS = 10 * 60 * 1000;
/** Overall budget for one board build (enumerate + per-fan earnings fan-out). */
export const SPENDERS_BUILD_TIMEOUT_MS = 120_000;

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
// After the fast-attach window lapses, keep re-checking at this slower cadence
// so a conversation subtree rebuilt later is still re-discovered instead of the
// UI vanishing until the next route change.
export const CONVERSATION_ATTACH_SLOW_RETRY_MS = 2_000;
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
export const AGENCY_HUB_AI_USAGE_REPORT_MAX_ATTEMPTS = 3;
export const AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS = [5_000, 15_000];

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
  agencyHubBaseUrl: '',
  agencyHubApiKey: '',
  agencyHubDeviceToken: '',
  spendersLegacyRebuild: false,
  quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
  pingMessageCount: PING_DEFAULT_MESSAGE_COUNT,
  improveMessageCount: IMPROVE_DEFAULT_MESSAGE_COUNT,
  deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
  debugMode: false,
  promptCachingEnabled: true,
};

// ─── Build ──────────────────────────────────────────────────────────────

export const BUILD_TIME = __CHATGOOSE_BUILD_TIME__;
