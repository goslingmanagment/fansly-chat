> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Shared Domain Model

The `src/shared/` module holds the extension's cross-cutting surface: the
central TypeScript type registry, the per-feature policy table, tuning
constants, the error catalog, the persona model, and a handful of DOM-free
utilities (keymap, hotkeys, logging redaction, bounded concurrency, XML
extraction, account-alias resolution). It is imported by the background service
worker, the content script, the popup/options React apps, and the Fansly/hub
clients alike.

Documented elsewhere (not covered here): `shared/storage.ts`,
`shared/migrations.ts`, `shared/transcript.ts`.

Post-1.6.0 note: there is no model registry, model-capabilities table, or
feature-readiness surface in this module. Stage 32 moved vendor endpoints,
per-feature model/reasoning defaults, token caps, and temperatures to the
kernel; the shared feature policy is trimmed to what the kernel AI lane needs
(`src/shared/constants.ts:15`).

---

## Type surface overview (`src/shared/types.ts`)

The file is one flat module of interfaces and unions, sectioned by comment
banners. Groups below reference the banner line and key members.

### Enums & literal unions (`types.ts:1`–`12`)

- `FeatureType` (`types.ts:3`): the seven AI features — `'fast-reply'`,
  `'improve-draft'`, `'help-me'`, `'fan-summary'`, `'chat-review'`, `'ping'`,
  `'hi-greeting'`.
- `OperationPhase` (`types.ts:4`): `'idle' | 'loading-messages' |
  'loading-earnings' | 'generating' | 'completed' | 'cancelled' | 'error'`.
- `PingSegment` (`types.ts:5`): `'segment-a' | 'segment-b' | 'active'`.
- `RouteKey` (`types.ts:6`): Fansly route buckets used for per-route freshness
  checks (`'message' | 'group' | 'account' | 'earnings' | 'messagingGroups' |
  'subscribers' | 'media'`).
- `FanSubscriptionSource` (`types.ts:7`): the two Fansly endpoints a
  subscription record can come from.
- `SubscriptionLookupMode` (`types.ts:8`): `'full' | 'cache-only'`.
- `ReplyMode` (`types.ts:9`): `'default' | 'preferSplit'`.
- `ReplyTone` (`types.ts:10`): `'none' | 'casual' | 'flirty' | 'upsell' |
  'spicy'`.
- `ModelSelectableFeatureType` (`types.ts:11`): `FeatureType` minus
  `'improve-draft'` and `'hi-greeting'` — the features that carry a
  per-feature model/provider selection.
- `ReasoningEffort` (`types.ts:12`): `'off' | 'low' | 'medium' | 'high' |
  'max'`.

### Settings & storage (`types.ts:14`–`108`)

- `Settings` (`types.ts:16`): the persisted preference bag. Fields:
  `agencyHubBaseUrl`, `agencyHubApiKey`, `agencyHubDeviceToken` (Stage 32
  device-bound credential, preferred over the API key when present —
  `types.ts:19`), `spendersLegacyRebuild` (hidden one-release fallback forcing
  the legacy per-fan Fansly earnings sweep; no UI, flipped via storage —
  `types.ts:22`), `quickMessageCount`, `pingMessageCount`,
  `improveMessageCount`, `deepMessageCount`, `debugMode`,
  `promptCachingEnabled`. There are no vendor API-key fields here — AI runs
  through the hub.
- `Personality` (`types.ts:34`): `id`, `name`, `content`, `updatedAt`, optional
  `builtin` / `builtinVersion`.
- `CompareDraftCard` / `CompareModelCard` (`types.ts:43`, `49`): compare-mode
  card view models; `CompareModelCard.source` is `'draft' | 'current'`.
- Fan-summary sync types: `FanSummarySyncState` (`types.ts:53`,
  `'not-set-up' | 'saving' | 'saved' | 'failed'`), `FanSummarySyncStatus`
  (`types.ts:59`), `LegacyAgencyHubSummarySyncMetadata` (`types.ts:69`), the
  union `AgencyHubSummarySyncMetadata` (`types.ts:78`), `FanSummaryMeta`
  (`types.ts:82`), and `SummaryCacheEntry` (`types.ts:89`, the persisted
  per-fan summary cache row).
- `PersistedState` (`types.ts:101`): the top-level persisted document —
  `schemaVersion`, `settings`, `personalities`, `accountMappings`,
  `accountAliases`, `knownAccounts`.

### Session & tab context (`types.ts:110`–`143`)

- `SessionTemplate` (`types.ts:112`): the captured Fansly session for one
  account — resolved identity, `authorization`, `fanslyClientId`,
  `fanslySessionId`, `latestTs`/`latestCheck`, per-`RouteKey` `routeChecks`,
  `connected`.
- `CapturedSessionHeaders` (`types.ts:127`): the raw request headers scraped
  from live Fansly traffic.
- `TabContext` (`types.ts:135`): the background's per-tab bookkeeping —
  `tabId`, `accountId`, `groupId`, `fanAccountId`, `fanDisplayName`,
  `activeOperationId`, `routeNonce`.

### Prompt building & LLM accounting (`types.ts:145`–`233`)

- `PromptBuildInput` (`types.ts:147`): everything the prompt assembler needs —
  `feature`, `personality`, `transcript`, `fanSpendingData`,
  `fanSubscriptionData`, `fanDisplayName`, optional `fanBio`, `draftText`,
  `pingSegment`, `replyMode`, `replyTone`.
- `PromptCacheControl` / `PromptTextBlock` (`types.ts:161`, `166`): the
  Anthropic-style cache-controlled text block shape.
- `LlmCacheCreationUsage`, `LlmUsageMetrics`, `LlmCostEstimate`,
  `LlmSpendSummary` (`types.ts:172`–`216`): token-usage and USD-cost
  accounting. `LlmSpendSummary.cacheEffectKind` is `'saved' | 'overhead' |
  'neutral'` (`types.ts:212`).
- `LlmReasoningSignal` (`types.ts:185`): stream-event kinds that mark reasoning
  output.
- `PromptPayload` (`types.ts:218`): `system` / `user` strings plus their block
  arrays.
- `PromptDebugSnapshot` (`types.ts:225`): the debug-mode prompt dump.

### Transcript & ping (`types.ts:235`–`253`)

- `PingSegmentAnalysis` (`types.ts:237`): counts and timestamps used to classify
  a conversation into a `PingSegment`.
- `NormalizedTranscriptMessage` (`types.ts:245`): a canonicalized message with
  `senderLabel: 'Model' | 'Fan'`, numeric `type`, `text`, and `labels`.

### Fansly API types (`types.ts:255`–`370`)

Wire-shape interfaces for Fansly responses: `FanslyAttachment`,
`FanslyMessage`, `FanslyMediaPermissionFlag`/`FanslyMediaPermissions`,
`FanslyMediaInner` (`types.ts:291` — the real payload where `type`/`mimetype`
live; top-level `FanslyMedia.{type,mimetype}` are legacy fallbacks per the
inline comments at `types.ts:288` and `302`), `FanslyMedia`,
`FanslyMediaBundleContentEntry`/`FanslyMediaBundle`, `FanslyAccountMediaOrder`
(`types.ts:338` — bundle id lives in `accountMediaId` with `type === 2`),
`FanslyMediaOrderHistoryResponse`, `FanslyMessagePageResponse`,
`FanslyGroupResponse`, `FanslyAccountResponse`. Inline comments warn that
viewer-perspective flags (`purchased`/`access`/`whitelisted`) are essentially
always `true` in a model session and are not fan-purchase proof (`types.ts:306`,
`326`).

### Earnings (`types.ts:372`–`423`)

`EarningsRow`, `EarningsBreakdownEntry`, `AggregatedEarnings` (window totals +
`breakdown` + `monthlyTotals`/`monthlyBreakdowns`), `MonthlyEarningsRow`,
`MonthlyEarningsTotal`, `MonthlyTypeBreakdown`.

### Subscriptions (`types.ts:425`–`518`)

`FanslySubscribersStats`, `FanslySubscriberSubscriptionRecord` (the raw wire
record with nullable promo/renew fields), `FanslySubscribersResponse`,
`FanslyMessagingGroupEntry`/`FanslyMessagingGroupAccount`/`FanslyMessagingGroupsResponse`,
and `FanSubscriptionContext` (`types.ts:479` — the normalized, ISO-stringified
subscription used downstream). Richer tier shapes `FanslySubscriptionTier` /
`FanslySubscriptionPlan` at `types.ts:505`, `513`.

### XML-parsing results & feature result (`types.ts:520`–`545`)

- `HelpMeParsed` (`types.ts:522`): `coaching` / `engaging` / `flirty` / `raw` /
  `valid`.
- `ChatReviewParsed` (`types.ts:530`): `rating` (nullable) / `evaluation` /
  `recommendations` / `raw` / `valid`.
- `FeatureResult` (`types.ts:538`): the unified operation result — `rawText`,
  optional `parts`, `splitModeRequested`, `helpMe`, `chatReview`,
  `summaryMeta`.

### Errors (`types.ts:547`–`600`)

- `ChatGooseErrorDetails` (`types.ts:549`): `status`, `responseSnippet`,
  `retryAfterMs`, `retryAtMs`, `providerMessage`, `provider`.
- `UserErrorKey` (`types.ts:558`): the 32-member union of error keys (catalog
  enumerated below).
- `UserFacingError` (`types.ts:592`): the serializable error the UI renders —
  `key`, `code`, `message`, optional `description`, `settingsLink`, `retryAtMs`,
  `retryAfterMs`.

### Operation profiling & progress (`types.ts:602`–`661`)

- `OperationProfilingStageKey` (`types.ts:604`): the ordered pipeline stages
  (`resolve-identity`, `summary-cache-check`, `load-messages`, `ping-analysis`,
  `group-lookup`, `account-name-lookup`, `earnings`, `subscription-lookup`,
  `prompt-build`, `llm-ttfb`, `llm-stream`).
- `OperationProfilingStageStatus` (`types.ts:617`): `'running' | 'completed' |
  'failed' | 'skipped'`.
- `OperationProfilingLogEntry`, `OperationProfilingStage`,
  `OperationProfilingSnapshot` (`types.ts:623`, `628`, `638`).
- `OperationProgressPayload` (`types.ts:650`): the progress event body —
  `operationId`, `feature`, `phase`, page counters, optional `llmSpend`,
  `profiling`.

### Tab UI state & runtime API (`types.ts:663`–`789`)

- `TabUiState` (`types.ts:665`): the popup/overlay-facing per-tab snapshot.
  Notably `modelProviderByFeature?: Partial<Record<ModelSelectableFeatureType,
  'anthropic' | 'openrouter'>>` (`types.ts:672`) and
  `apiKeyReadyByFeature?` (`types.ts:673`) still carry a per-feature provider
  distinction (`'anthropic' | 'openrouter'`).
- `PopupStatus` (`types.ts:681`): `TabUiState` plus `accountLabel`.
- `SessionSnapshotEntry` (`types.ts:685`): a per-account row for the options
  page.
- `RuntimeRequestMap` / `RuntimeResponseMap` (`types.ts:696`, `704`): the typed
  request→response map for `chrome.runtime` messaging — `getPopupStatus`,
  `getSessionsSnapshot`, `testAgencyHubConnection`, `issueAgencyHubDeviceToken`,
  `getSpendersList`.
- Agency-hub device-token flow: `AgencyHubDeviceTokenRequest` (`types.ts:713`)
  and `AgencyHubDeviceTokenResponse` (`types.ts:720`, a success/failure union
  that never carries the token itself).
- Spenders board: `GetSpendersListRequest` (`types.ts:728`), `SpenderListEntry`
  (`types.ts:733` — carries both `lifetimeMills` and `lifetimeUsd`),
  `SpendersListResult` (`types.ts:745`), `SpendersListResponse` (`types.ts:757`).
- Agency-hub connection test: `AgencyHubConnectionTestRequest`/`Response`
  (`types.ts:761`, `765`).
- AI-usage reporting: `AgencyHubAiUsageEvent` (`types.ts:770`) and
  `AgencyHubAiUsageBatchResponse` (`types.ts:785`).

### Port messages — discriminated unions (`types.ts:791`–`1028`)

- `PortEnvelopeBase` (`types.ts:793`): the `type` string-literal set covering
  every content↔background port message.
- Content→Background payloads: `TabInitPayload`, `RouteChangedPayload`,
  `OperationStartPayload`, `OperationCancelPayload`, `OperationAcceptancePayload`
  (`types.ts:881` — Stage 32 Task 5 acceptance capture, `action: 'copied' |
  'inserted'`), `CompareStartPayload`, `CompareCancelPayload`, unioned as
  `ContentPortMessage` (`types.ts:870`).
- Background→Content payloads: `ChunkPayload`, `CompareReadyPayload`,
  `CompareChunkPayload`, `DebugPromptPayload`, `CompletePayload`,
  `ErrorPayload`, `DiscardedPayload`, the five compare-card payloads,
  `TabStatePayload`, `SummarySyncStatusPayload`, `ProgressEnvelope`,
  `CompareProgressEnvelope`, unioned as `BackgroundPortMessage`
  (`types.ts:1012`).

### Overlay view model (`types.ts:1030`–`1147`)

- `OverlayInsertPart` (`types.ts:1032`): one insertable reply part with
  insertion state.
- `CompareInlineTabState` / `CompareInlineViewModel` (`types.ts:1042`, `1054`):
  compare-mode inline panel state.
- `OverlayViewModel` (`types.ts:1065`): the discriminated union the overlay
  renders — `kind` ∈ `'hidden' | 'loading' | 'reply' | 'helpMe' | 'readOnly' |
  'error'`.
- `CompletedOverlayViewModel` (`types.ts:1140`): `Extract` of the `'reply' |
  'helpMe' | 'readOnly'` variants.
- `InlinePanelViewModel` (`types.ts:1145`): `OverlayViewModel |
  CompareInlineViewModel`.

---

## Feature policy table (`src/shared/features.ts`)

`FEATURE_POLICIES` (`features.ts:32`) is a `const` object typed
`satisfies Record<FeatureType, FeaturePolicy>` (`features.ts:118`). The
`FeaturePolicy` interface (`features.ts:18`) fields:

- `messageCountBucket`: `'quick' | 'ping' | 'improve' | 'deep' | 'hi'`
  (`features.ts:7`) — selects which `Settings` count applies.
- `timeoutBucket`: `'quick' | 'deep'` (`features.ts:8`).
- `modelFeature`: the `ModelSelectableFeatureType` the feature bills/selects
  under.
- `surfaceKind`: `'inline-reply' | 'overlay'` (`features.ts:9`).
- `promptMode`: `'reply' | 'analysis'` (`features.ts:10`).
- `resultKind`: `'reply' | 'single-reply' | 'help-me' | 'summary' |
  'chat-review'` (`features.ts:11`).
- `supportsReplyMode`, `supportsReplyTone`, `requiresDraft`, `usesPingSegment`
  booleans; optional `includesEarnings`.

| Feature | msgCount | timeout | modelFeature | surface | promptMode | resultKind | replyMode | replyTone | reqDraft | pingSeg | label |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `fast-reply` | quick | quick | `fast-reply` | inline-reply | reply | reply | yes | yes | no | no | Reply |
| `improve-draft` | improve | quick | `fast-reply` | inline-reply | reply | single-reply | no | no | **yes** | no | Fix |
| `help-me` | quick | quick | `help-me` | overlay | analysis | help-me | no | no | no | no | Help |
| `fan-summary` | deep | deep | `fan-summary` | overlay | analysis | summary | no | no | no | no | Summary |
| `chat-review` | deep | deep | `chat-review` | overlay | analysis | chat-review | no | no | no | no | Review |
| `ping` | ping | quick | `ping` | inline-reply | reply | reply | no | no | no | **yes** | Ping |
| `hi-greeting` | hi | quick | `fast-reply` | inline-reply | reply | reply | no | no | no | no | Hi |

(Policy fields: `features.ts:33`–`117`. Labels from `FEATURE_LABELS`,
`constants.ts:123`.) Only `fast-reply` sets both `supportsReplyMode` and
`supportsReplyTone`; only `improve-draft` requires a draft; only `ping` uses a
ping segment. `hi-greeting` is the sole entry to spell out `includesEarnings:
false` (`features.ts:116`); no other feature sets the optional flag.

Helper functions over the table (`features.ts:120`–`174`): `getFeaturePolicy`,
`isDeepFeature`, `usesInlineFeatureSurface`, `usesOverlayFeatureSurface`,
`featureSupportsReplyMode`, `featureSupportsReplyTone`, `featureRequiresDraft`,
`featureUsesPingSegment`, `resolveFeatureMessageCount` (`features.ts:152` —
maps the bucket to a `Settings` field, returning the fixed `25` for `hi` at
`features.ts:166`), and `resolveFeatureModelFeature`.

---

## Constants by section (`src/shared/constants.ts`)

- **Storage** (`constants.ts:8`): `STORAGE_SCHEMA_VERSION = 10`
  (`constants.ts:10`), `SUMMARY_CACHE_PREFIX = 'summary:'`, `KNOWN_ACCOUNTS_KEY`,
  `SUMMARY_EVICTION_COUNT = 10`. Comment at `constants.ts:15` records that
  model/provider config now lives kernel-side. `COMPARE_TEMPERATURE = 0.35`
  (`constants.ts:20`).
- **Fansly API** (`constants.ts:22`): `FANSLY_API_BASE`, `FANSLY_PAGE_LIMIT =
  25`, `FANSLY_REQUEST_TIMEOUT_MS = 30_000`, `FANSLY_PAGINATION_DELAY_MS = 300`,
  `FANSLY_RETRY_DELAYS_MS = [1000, 2000, 4000]`, `FANSLY_RETRY_MAX_BACKOFF_MS =
  5_000`, and the four media-purchase-verification constants (limit 10,
  concurrency 3, timeout 3_000 ms, cache TTL 5 min).
- **Spenders board** (`constants.ts:37`): `SPENDERS_MAX_FANS = 150`,
  `SPENDERS_EARNINGS_CONCURRENCY = 4`, `SPENDERS_CACHE_TTL_MS = 10 min`,
  `SPENDERS_BUILD_TIMEOUT_MS = 120_000`.
- **Message counts** (`constants.ts:52`): quick 100 / 5–200, ping mirrors quick,
  improve default 25, deep default 1500 / 100–3000.
- **Timeouts** (`constants.ts:67`): `QUICK_OPERATION_TIMEOUT_MS = 60_000` and
  the deep-operation prep/TTFB/idle/max-stream timeouts.
- **Intervals & throttles** (`constants.ts:75`): route poll 500 ms, stream flush
  50 ms, conversation-attach timeouts/retries, `PORT_RECONNECT_DELAYS_MS =
  [100, 200, 400]`.
- **Feature thresholds** (`constants.ts:87`): `MIN_MESSAGES_FOR_DEEP = 30`,
  `PING_MIN_PERSONAL_MESSAGES = 10`, `PING_ACTIVE_DAYS = 5`,
  `PING_MIN_FAN_MESSAGES = 3`.
- **Earnings / agency hub** (`constants.ts:94`): earnings fallback window 90
  days; hub prefetch/sync timeouts; AI-usage batch cap 100, debounce 1 s,
  report timeout 5 s, max 3 attempts, retry delays `[5_000, 15_000]`.
- **UI** (`constants.ts:105`): `OVERLAY_Z_INDEX = 2147483646`,
  `CHATGOOSE_NAMESPACE = 'chatgoose'`.
- **Feature categories** (`constants.ts:110`): `DEEP_FEATURES` and
  `QUICK_FEATURES` are derived at module load by filtering `FEATURE_POLICIES` on
  `messageCountBucket`; `FEATURE_LABELS` (`constants.ts:123`) maps each
  `FeatureType` to its short UI label.
- **Default settings** (`constants.ts:135`): `DEFAULT_SETTINGS` mirrors the
  `Settings` shape with empty hub URL/key/token, `spendersLegacyRebuild: false`,
  the default message counts, `debugMode: false`, `promptCachingEnabled: true`.
- **Build** (`constants.ts:148`): `BUILD_TIME = __CHATGOOSE_BUILD_TIME__`
  (build-time injected).

---

## Error catalog (`src/shared/errors.ts`)

`ERROR_REGISTRY` (`errors.ts:15`) is keyed by `UserErrorKey`; each entry carries
a stable `code`, a `message`, an optional `description`, and an optional
`settingsLink` flag. `ChatGooseError` (`errors.ts:230`) is the thrown class
(dual constructor: positional `message/details/isOptional` or an options
object); `getErrorMessage` (`errors.ts:284`) projects a registry entry to a
`UserFacingError`, and `toUserError` (`errors.ts:353`) normalizes any thrown
value into one.

| Key | Code | settingsLink | Message |
|---|---|---|---|
| `not_connected` | CG-FAN-01 | | Fansly connection not found. |
| `session_expired` | CG-FAN-02 | | Fansly session expired. |
| `fansly_server_error` | CG-FAN-03 | | Fansly request failed. |
| `missing_api_key` | CG-AUTH-01 | yes | Claude API key not configured. |
| `invalid_api_key` | CG-AUTH-02 | yes | Claude API key is invalid. |
| `rate_limited` | CG-API-01 | | Rate limit reached. |
| `insufficient_balance` | CG-API-02 | | Anthropic balance is insufficient. |
| `no_personalities` | CG-FLOW-01 | yes | No model personalities are configured. |
| `no_mapping` | CG-FLOW-02 | yes | No model personality is assigned for this account. |
| `not_enough_history` | CG-FLOW-03 | | Not enough conversation history. |
| `another_operation` | CG-FLOW-04 | | Another operation is already running. |
| `ping_blocked` | CG-FLOW-05 | | This fan is still active. |
| `chat_changed` | CG-FLOW-06 | | Conversation changed. |
| `extension_reloaded` | CG-FLOW-07 | | Extension reloaded. |
| `compare_cards_unavailable` | CG-FLOW-08 | | Compare needs at least two model cards. |
| `network_error` | CG-NET-01 | | Network request failed. |
| `timed_out` | CG-NET-02 | | Operation timed out. |
| `model_unavailable` | CG-API-03 | yes | Selected Claude model is unavailable. |
| `context_too_long` | CG-API-04 | | Prompt is too large for this model. |
| `service_unavailable` | CG-API-05 | | Anthropic service is unavailable. |
| `ai_output_unusable` | CG-API-06 | | AI reply could not be used. |
| `hub_invalid_url` | CG-HUB-01 | yes | Agency Hub URL is invalid. |
| `hub_missing_api_key` | CG-HUB-02 | yes | Agency Hub API key is missing. |
| `hub_invalid_api_key` | CG-HUB-03 | yes | Agency Hub API key is invalid. |
| `hub_missing_permission` | CG-HUB-04 | yes | Agency Hub host access is not granted. |
| `hub_page_match_failed` | CG-HUB-05 | yes | Agency Hub page mapping failed. |
| `hub_timeout` | CG-HUB-06 | | Agency Hub request timed out. |
| `hub_request_failed` | CG-HUB-07 | | Agency Hub request failed. |
| `hub_sync_failed` | CG-HUB-08 | | Hub sync failed, summary remains available locally. |
| `hi_too_many_messages` | CG-FLOW-09 | | This conversation has too many messages for a greeting. |
| `ping_too_few_messages` | CG-FLOW-10 | | Ping needs at least 10 personal messages. |
| `insertion_failed` | CG-UI-01 | | Could not insert into the Fansly message box. |
| `unknown_error` | CG-APP-01 | | Something went wrong. |

(Registry entries: `errors.ts:16`–`217`. The `UserErrorKey` union in
`types.ts:558` lists the same 32 keys.) The full `description` text for each key
lives beside the entry in `errors.ts`.

### Provider-aware overrides

Although the default messages name Claude/Anthropic, `providerUserErrorOverrides`
(`errors.ts:309`) rewrites a subset of keys when the error's `details.provider`
is `'openrouter'` — `missing_api_key`, `invalid_api_key`, `rate_limited`,
`insufficient_balance`, `service_unavailable`, `model_unavailable` all get
OpenRouter-worded message/description (`errors.ts:317`–`349`). `toUserError`
(`errors.ts:353`) applies these overrides and threads through `retryAtMs` /
`retryAfterMs`.

### Other error helpers

- `isUserErrorKey` (`errors.ts:270`) / `isUserFacingError` (`errors.ts:274`):
  runtime type guards.
- `createUserError` (`errors.ts:295`): builds a `UserFacingError` with optional
  message/description/retry overrides.
- `formatUserFacingError` (`errors.ts:399`): `"CODE: message"`.
- `getUserErrorDescription` (`errors.ts:403`): trimmed description or `null`.
- `toDebugErrorPayload` (`errors.ts:407`): a debug-mode serialization that
  preserves `key`/`code`/`isOptional`/`details`.
- `ERROR_REGISTRY` is re-exported at `errors.ts:427`.

---

## Personas model (`src/shared/personalities.ts`)

- The bundled built-in persona is "Lora": `BUNDLED_LORA_PERSONALITY_ID =
  'builtin:lora'` (`personalities.ts:4`), `BUNDLED_LORA_PERSONALITY_VERSION = 2`
  (`personalities.ts:5`). Its full markdown content is a module-level string
  literal (`personalities.ts:7`–`174`).
- `bundledUpdatedAt` (`personalities.ts:176`) parses `BUILD_TIME`, falling back
  to `0` when unparseable.
- `BUNDLED_PERSONALITIES` (`personalities.ts:181`) is the single-element array of
  the Lora `Personality` (`builtin: true`, `builtinVersion: 2`).
- `createBundledPersonalities` (`personalities.ts:192`): returns fresh shallow
  clones.
- `normalizeSavedPersonality` (`personalities.ts:196`): coerces `updatedAt` to a
  positive number (defaulting to `Date.now()`), trims `name` to `'Unnamed'` when
  empty, and preserves `builtin`/`builtinVersion` for built-ins.
- `reconcileBundledPersonalities` (`personalities.ts:222`): ensures each bundled
  persona is present and up to date. If the stored list is empty it seeds the
  bundled set; otherwise it replaces an existing entry when it is not `builtin`
  or its `builtinVersion` differs from the bundled version (`personalities.ts:254`),
  copying the array only when a change is made and reporting `changed`.

---

## Small utilities

### Keymap engine (`src/shared/keymap.ts`)

A DOM-free keyboard matcher ported from the desktop keymap. `KeyEventLike`
(`keymap.ts:9`) is the abstracted event (includes `inEditable`). `KeyBinding`
(`keymap.ts:19`) declares `action`, `combo` (e.g. `'mod+shift+e'`, where `mod`
matches Meta **or** Ctrl), display `label`, `description`, and optional
`allowInEditable` / `hideFromCheatsheet`. `parseCombo` (`keymap.ts:39`) splits a
combo; `eventMatchesCombo` (`keymap.ts:54`) matches key + modifiers, treating
punctuation keys as shift-agnostic via `SHIFT_AGNOSTIC` (`keymap.ts:52`).
`createKeymap` (`keymap.ts:71`) returns a `Keymap` whose `resolve` returns the
first matching binding's action; while focus is in an editable field only
mod-/alt-combos, Escape, or `allowInEditable` bindings fire (`keymap.ts:77`).

### Hotkey table (`src/shared/hotkeys.ts`)

The single ChatGoose hotkey table built on the keymap engine. `HotkeyAction`
(`hotkeys.ts:25`) enumerates the actions; `HOTKEY_FEATURE` (`hotkeys.ts:39`)
maps the seven AI actions 1:1 to `FeatureType`. `detectLabelPlatform`
(`hotkeys.ts:49`) returns `'mac' | 'other'`; on macOS the command modifier is
`mod+shift` and labels render as `⌘⇧E`, on other platforms `alt+shift` and
`Alt+Shift+E` (`modifierCombo` `hotkeys.ts:58`, `comboLabel` `hotkeys.ts:63`).
The `AI_HOTKEYS` letter table (`hotkeys.ts:75`) assigns letters — e.g. `e`
fast-reply, `f` improve-draft, `h` help-me, `g` hi-greeting, `d` ping, `s`
fan-summary, `v` chat-review, `o` cycle-tone, `x` cancel, `m` spenders-board.
`buildHotkeyBindings` (`hotkeys.ts:88`) produces `KeyBinding<HotkeyAction>[]` for
a platform and appends the bare `?` cheatsheet binding. `featureHotkeyLabel`
(`hotkeys.ts:116`) returns `{ full, short }` label parts for a feature button.
`CHEATSHEET_EXTRAS` (`hotkeys.ts:129`) lists Enter/Esc rows handled outside the
keymap.

### Logging & redaction (`src/shared/log.ts`)

`logDebug(enabled, label, payload)` (`log.ts:59`) is a no-op unless `enabled`,
prefixing `[ChatGoose]` and deep-redacting the payload. `redactValue`
(`log.ts:30`) masks values whose object key matches `SENSITIVE_KEY_PATTERNS`
(`log.ts:3` — authorization, the vendor/hub API keys, fansly client/session) and
replaces any `sk-ant-…` / `sk-or-v1-…` token in strings via `API_KEY_REGEX`
(`log.ts:11`). `isDebugEnabled` (`log.ts:72`) reads `settings.debugMode`;
`snapshotSessionForDebug` (`log.ts:76`) extracts a session's non-secret-shaped
fields (note it still includes `authorization` and the fansly ids —
`log.ts:81`).

### Bounded concurrency (`src/shared/concurrency.ts`)

`mapWithConcurrency(items, limit, fn)` (`concurrency.ts:1`) runs `fn` over
`items` with at most `limit` in-flight, preserving input order in the result
array. It uses an iterative shared-index worker pool (`concurrency.ts:11`) so
the promise chain stays flat; the worker count is `min(limit, items.length)`,
zero for an empty input (`concurrency.ts:21`).

### XML extraction (`src/shared/xml.ts`)

`extractTag` (`xml.ts:3`) is a case-insensitive single-tag regex extractor.
`parseHelpMeXml` (`xml.ts:8`) pulls `<coaching>`/`<engaging>`/`<flirty>` and sets
`valid` only when all three are present. `parseChatReviewXml` (`xml.ts:22`) pulls
`<rating>` (accepting only a bare integer, then clamping validity to 1–10),
`<evaluation>`, `<recommendations>`; `valid` requires a valid rating plus both
prose fields.

### Account aliases (`src/shared/account-aliases.ts`)

`resolveCanonicalAccountId` (`account-aliases.ts:1`) follows the
`accountAliases` chain to its canonical id, guarding against cycles with a
`seen` set (returning the original id if a loop is detected —
`account-aliases.ts:15`). `buildAccountLookupOrder` (`account-aliases.ts:29`)
produces a de-duplicated candidate order (canonical-of-resolved, resolved,
canonical-of-legacy, legacy). `collectAliasKeysForCanonical`
(`account-aliases.ts:52`) returns every alias key that resolves to a given
canonical id (excluding the canonical id itself).
