import type {
  FeatureType,
  Settings,
} from './types.js';
import { FEATURE_POLICIES } from './features.js';
import type { FeaturePolicy } from './features.js';

// ─── Storage ─────────────────────────────────────────────────────────────

export const STORAGE_SCHEMA_VERSION = 15;
export const SUMMARY_CACHE_PREFIX = 'summary:';
export const KNOWN_ACCOUNTS_KEY = 'knownAccounts';
export const LEGACY_PERSONA_SNAPSHOT_KEY = 'legacyPersonaSnapshotV1';
export const PERSONA_CATALOG_STORAGE_KEY = 'personaCatalog';
export const PERSONA_CATALOG_SOURCE_STORAGE_KEY = 'personaCatalogSource';
export const PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY = 'personaCatalogFetchedAt';
// 1.8.1 (v13, A41/I116-4): hub credentials live in their OWN storage.local
// keys (per-key custody, atomic single-key set) — the options page's
// read-modify-write of the `settings` blob can no longer clobber a token
// issued mid-edit. The in-memory Settings shape still carries both fields
// (hydrated at load); only the PERSISTED layout changed.
export const AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY = 'agencyHubDeviceToken';
export const AGENCY_HUB_API_KEY_STORAGE_KEY = 'agencyHubApiKey';
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
// Rankings come from the kernel top-spenders query (lifetime window, plus a
// best-effort month-window twin for the +$N column). The only Fansly read is
// one bounded conversation enumeration — the fan→groupId map for opening
// chats; it does NOT gate board membership (kernel spenders outside it get a
// lazy inbox-search resolve on open).

/** Most-recent conversations to enumerate for the fan→groupId map. */
export const SPENDERS_MAX_FANS = 150;
/** Kernel top-spenders query size (Core decision #142 caps limit at 1000). */
export const SPENDERS_KERNEL_LIMIT = 1000;
/** One-release compatibility fallback for Core versions predating #142. */
export const SPENDERS_KERNEL_LEGACY_LIMIT = 500;
/** Fans per /account?ids= batch when resolving board-row names. */
export const SPENDERS_NAME_LOOKUP_BATCH = 50;
/** Soft wall-clock budget for the whole name sweep per build. Names are
 * decoration — the board must never hang on them (1.9.1 field report:
 * retrying batches stacked into a "Building the board…" freeze). */
export const SPENDERS_NAME_SWEEP_BUDGET_MS = 12_000;
/** Resolved fan names live this long in storage.LOCAL (renames are rare, and
 * a browser restart must not re-buy every name); later builds fetch only ids
 * the cache does not know. */
export const SPENDERS_NAMES_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/** Hard cap on cached names per creator — the cache must never grow without
 * bound across a long-lived profile. */
export const SPENDERS_NAMES_CACHE_MAX = 2_000;
/** Fansly account-note contentType that stores the creator's custom display
 * name for a fan (the native "change display names — it's for your eyes
 * only" feature; the note text IS the name). */
export const FANSLY_CUSTOM_NAME_NOTE_TYPE = 12002;
/** Reuse a built board for this long before re-asking the kernel. */
export const SPENDERS_CACHE_TTL_MS = 10 * 60 * 1000;
/** Overall budget for one board build. */
export const SPENDERS_BUILD_TIMEOUT_MS = 120_000;
/** Budget for lazily resolving a fan's chat via one inbox search on open. */
export const SPENDERS_RESOLVE_TIMEOUT_MS = 15_000;
/** How long the Fansly SPA router gets to react to a board chat-open before
 * the extension falls back to a full page load. */
export const SPENDERS_SPA_NAV_VERIFY_MS = 2_000;

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
// v15: the deep-window default rose 1500 → 3000. The forward-only migration
// (src/shared/migrations.ts) bumps a pre-v15 install still on the OLD default
// to this new one; a user-chosen value is left untouched.
export const DEEP_DEFAULT_MESSAGE_COUNT = 3000;
export const DEEP_MIN_MESSAGE_COUNT = 100;
export const DEEP_MAX_MESSAGE_COUNT = 3000;

// ─── Coach ───────────────────────────────────────────────────────────────

/** How many prior coach turns are retained/replayed by default. */
export const COACH_HISTORY_LIMIT_DEFAULT = 10;
export const COACH_HISTORY_LIMIT_MIN = 1;
export const COACH_HISTORY_LIMIT_MAX = 20;

/** Wire ceiling for a single replayed coach answer, MIRRORING the vendored
 * kernel SDK's `COACH_ANSWER_MAX_CHARS` (contracts/routes:
 * `coachHistory[].answer` and the coach output stream both cap here). That
 * constant is defined in the SDK but is NOT re-exported through the
 * `@kernel/sdk` barrel, so the boundary validator mirrors its value here rather
 * than importing it (the value is pinned by the coach body contract test in
 * core; a drift would fail the kernel's own zod bound at request time). */
export const COACH_ANSWER_MAX_CHARS = 64_000;

/** Kernel-side ceiling for a coach question, mirroring the SDK schema bound.
 * Enforced HERE only for replayed `coachHistory[].question` entries (the
 * boundary array validator); the live `chatterQuestion` is passed through as a
 * plain optional string and the kernel body schema is its real gate. */
export const COACH_QUESTION_MAX_CHARS = 2_000;

// ─── Timeouts ────────────────────────────────────────────────────────────

export const QUICK_OPERATION_TIMEOUT_MS = 60_000;
// Budget for the deep-feature PREP stage (live-read pagination of the Fansly DOM
// before the LLM stream). Sized for the deep window ceiling: 3000 msgs = 120
// pages × 300ms pagination delay ≈ 36s of pure pacing floor, before per-request
// network latency stacks on top. The old 180s was sized for a 1500-msg window;
// the v15 deep default doubled to 3000 (DEEP_DEFAULT_MESSAGE_COUNT), so the
// prep budget doubles to 360s to keep a full-window coach/recap load from
// timing out mid-pagination.
export const DEEP_OPERATION_PREP_TIMEOUT_MS = 360_000;
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
// The hub copy of a ready Scan feeds other features' prompts (core #136),
// so an unsaved summary gets an opportunistic re-push on chat open — but a
// persistently failing hub must not be hammered on every tab refresh.
export const SUMMARY_SYNC_RETRY_COOLDOWN_MS = 3 * 60_000;
// A missing Hub profile is stable enough to suppress repeated route/capture
// probes, but bounded so a summary created on another device appears soon.
export const AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS = 100;
// W9.4/A26: mirrors the kernel's clientContext.transcript cap (core
// routes.ts aiFeatureStreamBodySchema: z.string().max(300_000)). A giant
// live-read transcript must be truncated OLDEST-FIRST client-side instead
// of 400-ing the whole generation at the kernel boundary.
export const KERNEL_TRANSCRIPT_MAX_CHARS = 300_000;
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
  // E24: one name per feature everywhere — the bar used to say 'Scan' while
  // this map said 'Summary'; 'Recap' names the dossier the chatter gets.
  'fan-summary': 'Recap',
  'chat-review': 'Review',
  'ping': 'Ping',
  'hi-greeting': 'Hi',
  'coach-chat': 'Coach',
};

// ─── Default Settings ───────────────────────────────────────────────────

export const DEFAULT_SETTINGS: Settings = {
  agencyHubBaseUrl: '',
  agencyHubApiKey: '',
  agencyHubDeviceToken: '',
  quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
  pingMessageCount: PING_DEFAULT_MESSAGE_COUNT,
  improveMessageCount: IMPROVE_DEFAULT_MESSAGE_COUNT,
  deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
  debugMode: false,
  promptCachingEnabled: true,
  uiTheme: 'system',
  coachHistoryLimit: COACH_HISTORY_LIMIT_DEFAULT,
  coachAutoRecap: 'off',
};

// ─── Build ──────────────────────────────────────────────────────────────

export const BUILD_TIME = __CHATGOOSE_BUILD_TIME__;
