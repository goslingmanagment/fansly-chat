import type { FeatureType, ModelSelectableFeatureType, Settings } from './types.js';
import { FEATURE_POLICIES } from './features.js';
import type { FeaturePolicy } from './features.js';

// ─── Storage ─────────────────────────────────────────────────────────────

export const STORAGE_SCHEMA_VERSION = 3;
export const SUMMARY_CACHE_PREFIX = 'summary:';
export const KNOWN_ACCOUNTS_KEY = 'knownAccounts';
export const SUMMARY_EVICTION_COUNT = 10;

// ─── Claude API ──────────────────────────────────────────────────────────

export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';
export const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export interface ClaudeModelEntry {
  id: string;
  label: string;
  description: string;
}

export const CLAUDE_MODELS: ClaudeModelEntry[] = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', description: 'Recommended' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', description: 'Balanced' },
  { id: 'claude-opus-4-6',   label: 'Claude Opus 4.6',   description: 'Best quality' },
  { id: 'claude-opus-4-5',   label: 'Claude Opus 4.5',   description: 'Best quality (older)' },
  { id: 'claude-haiku-4-5',  label: 'Claude Haiku 4.5',  description: 'Fastest & cheapest' },
];

export const CLAUDE_MODEL_IDS = new Set(CLAUDE_MODELS.map((m) => m.id));

export const DEFAULT_FEATURE_MODELS: Record<ModelSelectableFeatureType, string> = {
  'fast-reply': DEFAULT_MODEL_ID,
  'help-me': DEFAULT_MODEL_ID,
  'fan-summary': DEFAULT_MODEL_ID,
  'chat-review': DEFAULT_MODEL_ID,
  'ping': DEFAULT_MODEL_ID,
};

export const MAX_TOKENS: Record<FeatureType, number> = {
  'fast-reply': 800,
  'improve-draft': 800,
  'help-me': 1200,
  'fan-summary': 1600,
  'chat-review': 1600,
  'ping': 800,
};

export const FEATURE_TEMPERATURES: Record<FeatureType, number> = {
  'fast-reply': 0.65,
  'improve-draft': 0.65,
  'help-me': 0.45,
  'fan-summary': 0.4,
  'chat-review': 0.25,
  'ping': 0.65,
};

export const COMPARE_TEMPERATURE = 0.35;

// ─── Fansly API ──────────────────────────────────────────────────────────

export const FANSLY_API_BASE = 'https://apiv3.fansly.com/api/v1';
export const FANSLY_PAGE_LIMIT = 25;
export const FANSLY_REQUEST_TIMEOUT_MS = 30_000;
export const FANSLY_PAGINATION_DELAY_MS = 300;
export const FANSLY_RETRY_DELAYS_MS = [1000, 2000, 4000];

// ─── Message Counts ──────────────────────────────────────────────────────

export const QUICK_DEFAULT_MESSAGE_COUNT = 100;
export const QUICK_MIN_MESSAGE_COUNT = 5;
export const QUICK_MAX_MESSAGE_COUNT = 200;
export const IMPROVE_DEFAULT_MESSAGE_COUNT = 25;
export const IMPROVE_MIN_MESSAGE_COUNT = QUICK_MIN_MESSAGE_COUNT;
export const IMPROVE_MAX_MESSAGE_COUNT = QUICK_MAX_MESSAGE_COUNT;
export const DEEP_DEFAULT_MESSAGE_COUNT = 500;
export const DEEP_MIN_MESSAGE_COUNT = 100;
export const DEEP_MAX_MESSAGE_COUNT = 1000;

// ─── Timeouts ────────────────────────────────────────────────────────────

export const QUICK_OPERATION_TIMEOUT_MS = 60_000;
export const DEEP_OPERATION_TIMEOUT_MS = 120_000;

// ─── Intervals & Throttles ──────────────────────────────────────────────

export const ROUTE_POLL_INTERVAL_MS = 500;
export const STREAM_CHUNK_FLUSH_MS = 50;
export const CONVERSATION_ATTACH_TIMEOUT_MS = 10_000;
export const CONVERSATION_ATTACH_RETRY_MS = 50;
export const PORT_RECONNECT_DELAYS_MS = [100, 200, 400];

// ─── Feature Thresholds ─────────────────────────────────────────────────

export const MIN_MESSAGES_FOR_DEEP = 30;
export const PING_ACTIVE_DAYS = 5;
export const PING_MIN_FAN_MESSAGES = 3;

// ─── Earnings ────────────────────────────────────────────────────────────

export const EARNINGS_FALLBACK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

// ─── UI ──────────────────────────────────────────────────────────────────

export const OVERLAY_Z_INDEX = 2147483646;
export const CHATMUSE_NAMESPACE = 'chatmuse';

// ─── Feature Categories ─────────────────────────────────────────────────

export const DEEP_FEATURES: FeatureType[] = (
  Object.entries(FEATURE_POLICIES) as Array<[FeatureType, FeaturePolicy]>
)
  .filter(([, policy]) => policy.messageCountBucket === 'deep')
  .map(([feature]) => feature);
export const QUICK_FEATURES: FeatureType[] = (
  Object.entries(FEATURE_POLICIES) as Array<[FeatureType, FeaturePolicy]>
)
  .filter(([, policy]) => policy.messageCountBucket !== 'deep')
  .map(([feature]) => feature);

export const FEATURE_LABELS: Record<FeatureType, string> = {
  'fast-reply': 'Reply',
  'improve-draft': 'Fix',
  'help-me': 'Help',
  'fan-summary': 'Summary',
  'chat-review': 'Review',
  'ping': 'Ping',
};

// ─── Default Settings ───────────────────────────────────────────────────

export const DEFAULT_SETTINGS: Settings = {
  claudeApiKey: '',
  quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
  improveMessageCount: IMPROVE_DEFAULT_MESSAGE_COUNT,
  deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
  debugMode: false,
  promptCachingEnabled: true,
  featureModels: { ...DEFAULT_FEATURE_MODELS },
};

// ─── Build ──────────────────────────────────────────────────────────────

export const BUILD_TIME = __CHATMUSE_BUILD_TIME__;
