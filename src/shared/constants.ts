import type { ClaudeProvider, FeatureType, Settings } from './types.js';

// ─── Storage ─────────────────────────────────────────────────────────────

export const STORAGE_SCHEMA_VERSION = 5;
export const SUMMARY_CACHE_PREFIX = 'summary:';
export const KNOWN_ACCOUNTS_KEY = 'knownAccounts';
export const SUMMARY_EVICTION_COUNT = 10;

// ─── Claude API ──────────────────────────────────────────────────────────

export const DEFAULT_MODEL_ID = 'claude-sonnet-4-6';
export const ANTHROPIC_API_BASE_URL = 'https://api.anthropic.com/v1';
export const KIRO_API_BASE_URL = 'https://api.kiro.cheap/v1';
export const DEFAULT_CLAUDE_PROVIDER: ClaudeProvider = 'anthropic';
export const CLAUDE_API_BASE_URL = ANTHROPIC_API_BASE_URL;
export const CLAUDE_API_URL = `${ANTHROPIC_API_BASE_URL}/messages`;
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

export const DEFAULT_FEATURE_MODELS: Record<FeatureType, string> = {
  'fast-reply': DEFAULT_MODEL_ID,
  'help-me': DEFAULT_MODEL_ID,
  'fan-summary': DEFAULT_MODEL_ID,
  'chat-review': DEFAULT_MODEL_ID,
  'ping': DEFAULT_MODEL_ID,
};

export const MAX_TOKENS: Record<FeatureType, number> = {
  'fast-reply': 800,
  'help-me': 1200,
  'fan-summary': 1600,
  'chat-review': 1600,
  'ping': 800,
};

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

export const DEEP_FEATURES: FeatureType[] = ['fan-summary', 'chat-review'];
export const QUICK_FEATURES: FeatureType[] = ['fast-reply', 'help-me', 'ping'];

export const FEATURE_LABELS: Record<FeatureType, string> = {
  'fast-reply': 'Reply',
  'help-me': 'Help',
  'fan-summary': 'Summary',
  'chat-review': 'Review',
  'ping': 'Ping',
};

// ─── Default Settings ───────────────────────────────────────────────────

export const DEFAULT_SETTINGS: Settings = {
  claudeProvider: DEFAULT_CLAUDE_PROVIDER,
  anthropicApiKey: '',
  kiroApiKey: '',
  quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
  deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
  debugMode: false,
  promptCachingEnabled: true,
  featureModels: { ...DEFAULT_FEATURE_MODELS },
};

// ─── Build ──────────────────────────────────────────────────────────────

export const BUILD_TIME = __CHATMUSE_BUILD_TIME__;
