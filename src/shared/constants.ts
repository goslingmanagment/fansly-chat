import type {
  FeatureType,
  Settings,
} from './types.js';
import { FEATURE_POLICIES } from './features.js';
import {
  FOLLOW_SOUND_TONE_DEFAULT,
  MESSAGE_SOUND_TONE_DEFAULT,
  MESSAGE_SOUND_VOLUME_DEFAULT,
} from './message-sound.js';
import type { FeaturePolicy } from './features.js';

// ─── Agency Hub ──────────────────────────────────────────────────────────

/** The one hub this fleet talks to (E123). Pre-filled so a new install has
 * nothing to type: the chatter opens «Аккаунт ChatGoose» and signs in. The
 * field stays editable under «Дополнительно» for a staging/self-hosted core. */
export const DEFAULT_AGENCY_HUB_BASE_URL = 'https://gosling-agency.ru';

// ─── Storage ─────────────────────────────────────────────────────────────

export const STORAGE_SCHEMA_VERSION = 21;
/** Full-recap local cache prefix (legacy/unqualified keys read as FULL). */
export const SUMMARY_CACHE_PREFIX = 'summary:';
/** Short-recap local cache prefix (spec §5 persistence-collision rule): a short
 * run must never overwrite the durable full dossier, so it gets its own key and
 * is NEVER pushed to `fan_profiles`. Disjoint from `summary:` (the ':' vs '-'
 * at index 7 means neither prefix matches the other's keys). */
export const SUMMARY_SHORT_CACHE_PREFIX = 'summary-short:';
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
/** TOMBSTONE (E123, v17). The legacy chatter API key is gone — from the UI, the
 * Settings shape, the bearer resolver and the storage layout. This constant
 * survives for exactly one purpose: naming the storage.local key the v17
 * migration REMOVES. E19's «wipe to empty strings, never remove the key» rule
 * protected a fallback READ that no longer exists, so the key itself is
 * retired; nothing in this build ever writes or reads it as a credential. */
export const LEGACY_AGENCY_HUB_API_KEY_STORAGE_KEY = 'agencyHubApiKey';
/** Operational (NOT custody, NOT settings-blob) metadata about the stored
 * device token — its prefix and when it was issued, so the Hub pane can say
 * WHICH token is live without ever reading the token itself. Own key, own
 * `version`; schema v15 is untouched. */
export const AGENCY_HUB_DEVICE_TOKEN_META_STORAGE_KEY = 'chatgoose:deviceTokenMeta';
/** «Выйти» best-effort hub revoke budget. */
export const AGENCY_HUB_DEVICE_TOKEN_REVOKE_TIMEOUT_MS = 5_000;
/** Operational: whether the first-run checklist has been completed. Durable on
 * purpose — the predicate must not depend on a form field, or typing the hub
 * URL would dismiss the checklist that is still explaining what to do next.
 * Own key, own `version`; schema v15 is untouched. */
export const ONBOARDING_STORAGE_KEY = 'chatgoose:onboarding';
/** Operational: the extension version whose changelog the chatter has already
 * opened. Drives the rail's «нов.» dot and nothing else. Own key, own
 * `version`; schema v15 is untouched. */
export const LAST_SEEN_VERSION_STORAGE_KEY = 'chatgoose:lastSeenVersion';

// ─── Release pages ───────────────────────────────────────────────────────

/** The changelog is a WEB page next to the update feed — zero changelog content
 * ships in the XPI (E59). The host MUST equal `BASE_URL` in `scripts/deploy.sh`
 * (the only place that publishes this page); `tests/release-pages.test.ts` fails
 * the build if the two drift apart.
 *
 * No `#v<X-Y-Z>` anchor yet, deliberately: the anchored per-release page (E42)
 * is not deployed, and a link to an anchor that does not exist lands on a blank
 * viewport. Adding the anchor is a release-2.0 commit that MUST follow the
 * anchored page's deploy, never precede it. */
export const CHANGELOG_URL = 'https://ext.gosling-agency.ru/changelog.html';
/** Detailed 2.0 release guide; deployed beside the chronological archive. */
export const WHATS_NEW_2_URL = 'https://ext.gosling-agency.ru/whats-new-2.html';
/** «Как начать»: the one page both clients point a new chatter at (plan §6.2).
 * Static, published beside the update feed by `scripts/deploy.sh`. */
export const START_PAGE_URL = 'https://ext.gosling-agency.ru/start.html';
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
/** Abort reason stamped by the runtime-api build-timeout handler. The
 * spenders-service getList wrapper reads `signal.reason` to tell a real timeout
 * (record a FAIL observation, so the Статус row stops showing stale RAMPED)
 * apart from a user-cancel / superseded build (not a board outcome — skip). */
export const SPENDERS_BUILD_TIMEOUT_REASON = 'spenders-build-timeout';
/** Budget for lazily resolving a fan's chat via one inbox search on open. */
export const SPENDERS_RESOLVE_TIMEOUT_MS = 15_000;
/** Budget for the one group read behind a fan's registration date (E152). */
export const FAN_REGISTRATION_TIMEOUT_MS = 15_000;
/** Budget for one fan-notes answer: the group read when the fan is not known
 * yet, then the account read (E157). */
export const FAN_NOTES_READ_TIMEOUT_MS = 20_000;
/** Budget for one note write; a single attempt, never retried (E157). */
export const FAN_NOTES_WRITE_TIMEOUT_MS = 15_000;
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
/** Strict Core wire bound for `clientContext.fanSilenceDays` (Decision #127).
 * The SDK barrel does not export the contract constant, so keep the matching
 * finite ceiling here and pin it against the vendored schema in tests. */
export const FAN_SILENCE_DAYS_MAX = 20_000;
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

/** Fixed message window for a SHORT recap (spec §5) — a constant, never a
 * user setting (full recap uses `deepMessageCount`). Also the hard ceiling the
 * client clamps the loaded window to before sending, so a short recap's
 * `clientContext.messageCount` is always ≤ this. */
export const SHORT_SUMMARY_MESSAGE_COUNT = 300;

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

/** Staleness threshold for the auto-recap decision (spec §5): a stored recap
 * older than this is considered stale and the auto-recap chain refreshes it
 * before the first coach question. 24h. */
export const COACH_RECAP_FRESH_MS = 24 * 60 * 60 * 1000;

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
/** Hi is for a conversation that has barely started: at most this many
 * PERSONAL messages (fan messages plus the model's own personal ones; welcome
 * and mass messages do not count). Mirrors Core's `gate_hi_greeting_limit`. */
export const HI_GREETING_MAX_TRANSCRIPT = 10;
/** How long the chat Hi waits for welcome definitions when the 24 h cache is
 * cold. The read rides the paced follower lane, which a running scan or a
 * cooldown can hold for minutes; past this the stale cache (or nothing) is
 * used and the shared read finishes in the background. */
export const HI_WELCOME_LOAD_TIMEOUT_MS = 4_000;
export const PING_ACTIVE_DAYS = 5;
export const PING_MIN_FAN_MESSAGES = 3;

// ─── Voice Notes ────────────────────────────────────────────────────────

/** Advisory mirror of the kernel cap; the server remains authoritative. */
export const VOICE_SCRIPT_MAX_CHARS_ADVISORY = 600;
export const VOICE_CHARS_PER_SECOND = 14;
export const VOICE_AUDIO_MAX_BYTES = 2_097_152;
/** V2 binds every recoverable take to the exact Hub principal + page that
 * created it. Source-less V1 snapshots cannot be recovered safely. */
export const VOICE_ATTEMPT_SESSION_KEY_PREFIX = 'voiceAttemptV2:';
export const VOICE_ATTEMPT_LEGACY_SESSION_KEY_PREFIX = 'voiceAttemptV1:';
export const VOICE_ATTEMPT_TTL_MS = 6 * 3600_000;
export const VOICE_STATUS_POLL_MS = 1500;
/** Voice-script owns a dedicated lane, but retains the quick-operation wall
 * clock budget so a silent SSE can never strand the editor indefinitely. */
export const VOICE_SCRIPT_TIMEOUT_MS = QUICK_OPERATION_TIMEOUT_MS;
/** Paid create is never auto-retried after this ambiguity boundary; content
 * moves the frozen idempotency snapshot to needs-reconcile instead. */
export const VOICE_CREATE_TIMEOUT_MS = 30_000;
/** Free status/audio reads are single-flight and manually retryable. */
export const VOICE_RETRIEVAL_TIMEOUT_MS = 15_000;
/** First-paint budget for the voice capability hint. The probe itself keeps
 * the full AGENCY_HUB_PREFETCH_TIMEOUT_MS, but neither the popup nor the
 * injected toolbar may wait that long for a cold one: past this budget the
 * hint is reported fail-closed (false) and the finished probe re-pushes tab
 * state. Purely a rendering deadline — the kernel re-checks every gate on
 * POST, so a late hint never widens what is allowed. */
export const VOICE_CAPABILITY_BUDGET_MS = 800;

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
  // voice-script has a quick transcript policy but a dedicated runner; it
  // must not become a generic quick operation.
  .filter(([feature, policy]) =>
    feature !== 'voice-script' && policy.messageCountBucket === 'quick')
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
  'voice-script': 'Voice',
  'coach-chat': 'Coach',
};

// ─── Default Settings ───────────────────────────────────────────────────

export const DEFAULT_SETTINGS: Settings = {
  agencyHubBaseUrl: DEFAULT_AGENCY_HUB_BASE_URL,
  agencyHubDeviceToken: '',
  quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
  pingMessageCount: PING_DEFAULT_MESSAGE_COUNT,
  improveMessageCount: IMPROVE_DEFAULT_MESSAGE_COUNT,
  deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
  debugMode: false,
  promptCachingEnabled: true,
  uiTheme: 'system',
  showToolbarHints: true,
  coachHistoryLimit: COACH_HISTORY_LIMIT_DEFAULT,
  coachAutoRecap: 'off',
  messageSoundEnabled: true,
  messageSoundTone: MESSAGE_SOUND_TONE_DEFAULT,
  messageSoundVolume: MESSAGE_SOUND_VOLUME_DEFAULT,
  messageSoundMutedAccountIds: [],
  followSoundEnabled: true,
  followSoundTone: FOLLOW_SOUND_TONE_DEFAULT,
  fanslyViaTab: false,
  // FAN_NOTES_VIEW_DEFAULT, spelled out: fan-notes.ts imports this module.
  fanNotesView: 'drawer',
};

// ─── Build ──────────────────────────────────────────────────────────────

export const BUILD_TIME = __CHATGOOSE_BUILD_TIME__;
