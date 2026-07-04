# Shared — Domain Model, Feature Policies & Model Registry

## Scope

This document maps the `src/shared/` files that hold the vocabulary the whole
extension shares — the type system, the per-feature policy table, the
feature-readiness derivations, the AI model catalog, model reasoning
capabilities, and the tuning constants. Files covered (all read in full from
source):

- `src/shared/types.ts` (1119 lines) — all exported enums, unions, interfaces.
- `src/shared/features.ts` — `FEATURE_POLICIES` and derived helpers.
- `src/shared/feature-readiness.ts` — `buildModelProviderByFeature` / `buildApiKeyReadyByFeature`.
- `src/shared/model-registry.ts` — `AI_MODELS` catalog, providers, groups, lookups.
- `src/shared/model-capabilities.ts` — adaptive-thinking / reasoning-config gating.
- `src/shared/constants.ts` — storage schema, API URLs, per-feature tuning, defaults.

These files are almost entirely declarations. They perform no network, DOM, or
storage I/O themselves; they *define* the contracts (URLs, storage keys, IPC
message `type` strings, wire-shape interfaces) that the background/content/
options/popup layers execute against. Each boundary constant/type is flagged
below with the module that consumes it.

The external-boundary tables (Fansly REST, Anthropic, OpenRouter, Agency Hub)
are owned by `docs/project-kernel/boundaries.md`; this document does not
re-derive them but notes where the shared vocabulary touches each.

---

## 1. `src/shared/types.ts`

**Imports:** none (self-contained pure type module — no runtime code, no
`import` statements).
**Consumed by:** 34 modules (`grep -rl "shared/types" src`), i.e. essentially
the entire background, content, options, and popup code plus the other shared
modules.

### 1.1 Enums & literal unions (lines 3–12)

| Type | Members |
|---|---|
| `FeatureType` (3) | `'fast-reply' \| 'improve-draft' \| 'help-me' \| 'fan-summary' \| 'chat-review' \| 'ping' \| 'hi-greeting'` — 7 features |
| `OperationPhase` (4) | `'idle' \| 'loading-messages' \| 'loading-earnings' \| 'generating' \| 'completed' \| 'cancelled' \| 'error'` |
| `PingSegment` (5) | `'segment-a' \| 'segment-b' \| 'active'` |
| `RouteKey` (6) | `'message' \| 'group' \| 'account' \| 'earnings' \| 'messagingGroups' \| 'subscribers' \| 'media'` |
| `FanSubscriptionSource` (7) | `'/api/v1/messaging/groups' \| '/api/v1/subscribers'` (Fansly endpoint paths used as tags) |
| `SubscriptionLookupMode` (8) | `'full' \| 'cache-only'` |
| `ReplyMode` (9) | `'default' \| 'preferSplit'` |
| `ReplyTone` (10) | `'none' \| 'casual' \| 'flirty' \| 'upsell' \| 'spicy'` |
| `ModelSelectableFeatureType` (11) | `Exclude<FeatureType, 'improve-draft' \| 'hi-greeting'>` → 5 features: `fast-reply, help-me, fan-summary, chat-review, ping` |
| `ReasoningEffort` (12) | `'off' \| 'low' \| 'medium' \| 'high' \| 'max'` |

`ModelSelectableFeatureType` is the load-bearing derivation: `improve-draft` and
`hi-greeting` are *not* independently model/reasoning-selectable; they borrow the
`fast-reply` model via `FeaturePolicy.modelFeature` (see §2).

### 1.2 Settings & storage (lines 16–105)

- **`Settings`** (16–29): `claudeApiKey`, `openRouterApiKey`, `agencyHubBaseUrl`,
  `agencyHubApiKey` (all strings); message-count knobs `quickMessageCount`,
  `pingMessageCount`, `improveMessageCount`, `deepMessageCount` (numbers);
  `debugMode` (bool); `promptCachingEnabled` (bool);
  `featureModels: Record<ModelSelectableFeatureType, string>` (5 model-id
  entries); `featureReasoning: Record<ModelSelectableFeatureType, ReasoningEffort>`.
  Default instance is `DEFAULT_SETTINGS` in `constants.ts` (§6.9).
- **`Personality`** (31–38): `id, name, content, updatedAt`; optional
  `builtin?`, `builtinVersion?` flags.
- **`CompareDraftCard`** (40–44) / **`CompareModelCard`** (46–48): id/label/content;
  `CompareModelCard` adds `source: 'draft' | 'current'` (the Multi/compare path).
- **`FanSummarySyncState`** (50–54): `'not-set-up' | 'saving' | 'saved' | 'failed'`.
- **`FanSummarySyncStatus`** (56–64): `{ state, generatedAt, baseUrl?, pageLabel?,
  syncedAt?, updatedAt?, error?: UserFacingError }`.
- **`LegacyAgencyHubSummarySyncMetadata`** (66–73) and the union
  **`AgencyHubSummarySyncMetadata`** (75–77) = `FanSummarySyncStatus |
  LegacyAgencyHubSummarySyncMetadata` — the legacy shape has a required
  `baseUrl/pageLabel/syncedAt` and `state?: undefined` to discriminate.
- **`FanSummaryMeta`** (79–84): `{ generatedAt, stale, cached, syncStatus? }`.
- **`SummaryCacheEntry`** (86–96): cached fan summary — `summary, personalityId,
  personalityUpdatedAt, generatedAt`, optional `spendingDataVerified?`,
  `subscriptionLookupVerified?`, `modelId?`, `fanAccountId?`,
  `agencyHubSync?: AgencyHubSummarySyncMetadata`. (Storage key prefix
  `SUMMARY_CACHE_PREFIX = 'summary:'`, see §6.1.)
- **`PersistedState`** (98–105): the top-level `browser.storage.local` document —
  `schemaVersion, settings, personalities[], accountMappings: Record<string,string>,
  accountAliases: Record<string,string>, knownAccounts: string[]`.

### 1.3 Session & tab context (lines 109–140)

- **`SessionTemplate`** (109–122): captured Fansly session — `accountId`, resolved
  `resolvedAccountId/Username/DisplayName`, `authorization`, `fanslyClientId`,
  `fanslySessionId`, `latestTs`, `latestCheck`, `routeChecks: Partial<Record<RouteKey,string>>`,
  `lastSeenAt`, `connected`.
- **`CapturedSessionHeaders`** (124–130): the raw sniffed headers —
  `authorization, fanslyClientId, fanslyClientTs, fanslySessionId, fanslyClientCheck?`.
  These are the exact Fansly auth headers produced by the webRequest capture
  (`session-capture.ts`) and consumed by `fansly-client.ts`.
- **`TabContext`** (132–140): `tabId, accountId, groupId, fanAccountId,
  fanDisplayName, activeOperationId, routeNonce`.

### 1.4 Prompt building & LLM usage (lines 144–230)

- **`PromptBuildInput`** (144–156): `feature, personality, transcript,
  fanSpendingData, fanSubscriptionData, fanDisplayName`, optional `fanBio?,
  draftText?, pingSegment?, replyMode?, replyTone?`.
- **`PromptCacheControl`** (158–161): `{ type: 'ephemeral'; ttl?: '1h' }` — the
  Anthropic cache-control block shape.
- **`PromptTextBlock`** (163–167): `{ type: 'text'; text; cache_control? }` — a
  content block for Anthropic/OpenRouter messages.
- **`LlmCacheCreationUsage`** (169–172): `{ ephemeral_5m_input_tokens,
  ephemeral_1h_input_tokens }`.
- **`LlmUsageMetrics`** (174–180): `{ input_tokens, cache_creation_input_tokens,
  cache_read_input_tokens, output_tokens, cache_creation? }` — mirrors the
  Anthropic `usage` object. Consumed by `llm-cost.ts` and the usage reporter.
- **`LlmReasoningSignal`** (182–187): `'thinking_block' |
  'redacted_thinking_block' | 'thinking_delta' | 'signature_delta' |
  'reasoning_delta'` — stream-event discriminators for reasoning output.
- **`LlmCostEstimate`** (189–198): `{ modelId, inputUsd, cacheWrite5mUsd,
  cacheWrite1hUsd, cacheReadUsd, outputUsd, totalUsd, approximate }`.
- **`LlmSpendSummary`** (200–213): rolled-up spend for the overlay —
  `totalTokens, inputTokens, cacheWriteTokens, cacheReadTokens, outputTokens,
  totalUsd, uncachedUsd, cacheEffectUsd, cacheEffectKind: 'saved'|'overhead'|'neutral',
  cacheWriteUsd, cacheReadUsd, approximate`.
- **`PromptPayload`** (215–220): `{ system, user, systemBlocks: PromptTextBlock[],
  userBlocks: PromptTextBlock[] }`.
- **`PromptDebugSnapshot`** (222–230): debug-mode capture —
  `{ feature, modelId, system, transcript, fanSpendingData, fanSubscriptionData, user }`.

### 1.5 Transcript & ping (lines 234–250)

- **`PingSegmentAnalysis`** (234–240): `{ segment, fanTextMessageCount,
  latestFanTextAtMs, latestOverallTextSender: 'Model'|'Fan'|null,
  latestOverallTextAtMs }`.
- **`NormalizedTranscriptMessage`** (242–250): `{ id, createdAt, senderId,
  senderLabel: 'Model'|'Fan', type: number, text, labels: string[] }`.

### 1.6 Fansly API wire types (lines 254–367)

These interfaces model Fansly REST responses; several carry inline comments that
document *actual* wire behavior diverging from field names:

- **`FanslyAttachment`** (254–260): `{ contentType?, contentId?, fileName?,
  mimetype?, pos? }`.
- **`FanslyMessage`** (262–272): `{ id, type: number, content, groupId, senderId,
  createdAt, attachments[], embeds: unknown[], totalTipAmount? }`.
- **`FanslyMediaPermissionFlag`** (274–279) / **`FanslyMediaPermissions`** (281–283).
- **`FanslyMediaInner`** (288–293): comment (285–287) states the real `type` and
  `mimetype` live on `accountMedia[i].media`; the top-level fields are null on
  real items and kept only as legacy fallback.
- **`FanslyMedia`** (295–311): comment (303–305) warns `purchased/access/whitelisted`
  are *viewer-perspective* flags — in a model's own session they are ~always
  `true` and are NOT fan-purchase proof.
- **`FanslyMediaBundleContentEntry`** (313–316) / **`FanslyMediaBundle`** (318–330):
  same viewer-perspective warning (323).
- **`FanslyAccountMediaOrder`** (335–341): comment (332–334) notes the bundle id is
  in `accountMediaId` with `type === 2` for the `/message` page shape;
  `accountMediaBundleId` only appears on `/media/orderhistory` and is supported
  defensively.
- **`FanslyMediaOrderHistoryResponse`** (343–348): `accountMediaOrderHistory?` plus
  `aggregationData.accountMediaOrders?`.
- **`FanslyMessagePageResponse`** (350–355): `{ messages, accountMedia,
  accountMediaBundles, accountMediaOrders? }` — the core `/api/v1/message` page.
- **`FanslyGroupResponse`** (357–360): `{ id, users: [{ userId }] }`.
- **`FanslyAccountResponse`** (362–367): `{ id, username?, displayName?, about? }`.

### 1.7 Earnings (lines 371–420)

- **`EarningsRow`** (371–378): `{ type: number, totalGross, totalNet, accountId,
  correlationAccountId, timestamp }`.
- **`EarningsBreakdownEntry`** (380–385): `{ label, type: number, gross, net }`.
- **`AggregatedEarnings`** (387–397): `{ correlationAccountId, windowStartIso,
  windowEndIso, totalGross, totalNet, breakdown[], monthlyTotals[],
  monthlyBreakdowns?[], monthlyBreakdownsPartial? }`.
- **`MonthlyEarningsRow`** (399–407), **`MonthlyEarningsTotal`** (409–414),
  **`MonthlyTypeBreakdown`** (416–420).

### 1.8 Subscriptions (lines 424–515)

- **`FanslySubscribersStats`** (424–428): `{ totalActive, totalExpired, total }`.
- **`FanslySubscriberSubscriptionRecord`** (430–451): full subscription row with
  `status: number`, prices, promo fields, `renewDate?/endsAt?/createdAt?` epoch
  numbers (mostly `?| null`).
- **`FanslySubscribersResponse`** (453–456): `{ stats?, subscriptions? }` (from
  `/api/v1/subscribers`).
- **`FanslyMessagingGroupEntry`** (458–462) / **`FanslyMessagingGroupAccount`**
  (464–467) / **`FanslyMessagingGroupsResponse`** (469–474): the
  `/api/v1/messaging/groups` shape, with `aggregationData.accounts[].subscriberSubscription`.
- **`FanSubscriptionContext`** (476–498): the normalized subscription record used
  internally — `source: FanSubscriptionSource`, `subscriptionId,
  subscriberAccountId, status, subscriptionTierId, subscriptionTierName, planId,
  price, renewPrice, autoRenew: boolean|null, billingCycle`, and Iso-string
  variants of every date (`promoStartsAtIso, promoEndsAtIso, renewDateIso,
  endsAtIso, createdAtIso`).
- **`FanslySubscriptionTier`** (502–508) / **`FanslySubscriptionPlan`** (510–515):
  richer tier shape with `subscriptionBenefits[]` and `plans[]`.

### 1.9 Parse results & errors (lines 519–597)

- **`HelpMeParsed`** (519–525): `{ coaching, engaging, flirty, raw, valid }` —
  XML parse result for `help-me`.
- **`ChatReviewParsed`** (527–533): `{ rating: number|null, evaluation,
  recommendations, raw, valid }`.
- **`FeatureResult`** (535–542): `{ rawText, parts?, splitModeRequested?, helpMe?,
  chatReview?, summaryMeta? }` — the unified operation result.
- **`ChatGooseErrorDetails`** (546–553): `{ status?, responseSnippet?,
  retryAfterMs?, retryAtMs?, providerMessage?, provider? }`.
- **`UserErrorKey`** (555–587): the closed set of error keys (32 members):
  `not_connected, session_expired, fansly_server_error, missing_api_key,
  invalid_api_key, rate_limited, insufficient_balance, no_personalities,
  not_enough_history, another_operation, ping_blocked, network_error, timed_out,
  no_mapping, chat_changed, extension_reloaded, model_unavailable,
  context_too_long, service_unavailable, ai_output_unusable, hub_invalid_url,
  hub_missing_api_key, hub_invalid_api_key, hub_missing_permission,
  hub_page_match_failed, hub_timeout, hub_request_failed, hub_sync_failed,
  compare_cards_unavailable, hi_too_many_messages, insertion_failed, unknown_error`.
- **`UserFacingError`** (589–597): `{ key: UserErrorKey, code, message,
  description?, settingsLink?, retryAtMs?, retryAfterMs? }`.

### 1.10 Operation profiling (lines 601–643)

- **`OperationProfilingStageKey`** (601–612): 11 stages —
  `resolve-identity, summary-cache-check, load-messages, ping-analysis,
  group-lookup, account-name-lookup, earnings, subscription-lookup, prompt-build,
  llm-ttfb, llm-stream`.
- **`OperationProfilingStageStatus`** (614–618): `running|completed|failed|skipped`.
- **`OperationProfilingLogEntry`** (620–623), **`OperationProfilingStage`** (625–633),
  **`OperationProfilingSnapshot`** (635–643): the snapshot carries
  `elapsedMs, activeLabel, logEntries[], stages[], llmUsage?, llmCost?, reasoningBlock?`.

### 1.11 Operation progress & tab UI state (lines 647–689)

- **`OperationProgressPayload`** (647–658): `{ operationId, feature, phase,
  currentPage?, targetPages?, message?, statusCode?, retryAtMs?, llmSpend?,
  profiling? }`.
- **`TabUiState`** (662–676): the state pushed to popup/content —
  `tabId, accountId, groupId, hasAvailableSummary, connected, hasApiKey,
  modelProviderByFeature?: Partial<Record<ModelSelectableFeatureType,
  'anthropic'|'openrouter'>>, apiKeyReadyByFeature?: Partial<Record<...,boolean>>,
  hasPersonalities, mappedPersonalityId, mappedPersonalityName, compareCardCount,
  compareDraftCount`. The two `…ByFeature` maps are produced by
  `feature-readiness.ts` (§3).
- **`PopupStatus`** (678–680): `TabUiState & { accountLabel: string }`.
- **`SessionSnapshotEntry`** (682–689): `{ legacyAccountId, resolvedAccountId,
  username, displayName, connected, lastSeenAt }`.

### 1.12 Runtime one-shot API (lines 693–772)

**`RuntimeRequestMap`** (693–698) / **`RuntimeResponseMap`** (700–705) — the typed
`browser.runtime.sendMessage` request/response registry (IPC channel b):

| Request key | Request type | Response type |
|---|---|---|
| `getPopupStatus` | `GetPopupStatusRequest \| undefined` (`{ tabId? }`, 707–709) | `PopupStatus` |
| `getSessionsSnapshot` | `undefined` | `SessionSnapshotEntry[]` |
| `testAgencyHubConnection` | `AgencyHubConnectionTestRequest` (744–746: `{ settings: Pick<Settings,'agencyHubBaseUrl'\|'agencyHubApiKey'> }`) | `AgencyHubConnectionTestResponse` (748–751: `{ ok, error? }`) |
| `getSpendersList` | `GetSpendersListRequest \| undefined` (711–714: `{ refresh? }`) | `SpendersListResponse` |

Spenders payloads:
- **`SpenderListEntry`** (716–726): `{ fanAccountId, groupId, displayName,
  username, lifetimeMills, lifetimeUsd }`. `groupId` doc-commented as the Fansly
  messaging group id (route target). `lifetimeMills` is spend in Fansly mills.
- **`SpendersListResult`** (728–738): `{ entries[], builtAt, fanCount,
  scannedCount, truncated }`.
- **`SpendersListResponse`** (740–742): discriminated `{ ok: true; result } |
  { ok: false; error: UserFacingError }`.

Agency Hub usage payloads (POST `api/v1/ai-usage/batch`):
- **`AgencyHubAiUsageEvent`** (753–766): `{ clientEventId, feature, model,
  inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, conversationId,
  durationMs, isCacheHit, isRegeneration, completedAt }`.
- **`AgencyHubAiUsageBatchResponse`** (768–772): `{ receivedCount, insertedCount,
  dedupedCount }`.

### 1.13 Port messages — discriminated unions (lines 776–1000)

The long-lived runtime `Port` (IPC channel a). **`PortEnvelopeBase`** (776–802)
declares the *full* `type` union (all 24 message tags used in both directions).

**Content → Background — `ContentPortMessage`** (852–858):

| Interface | `type` | Notable fields |
|---|---|---|
| `TabInitPayload` (806–810) | `tab:init` | `groupId, routeNonce` |
| `RouteChangedPayload` (812–816) | `tab:routeChanged` | `groupId, routeNonce` |
| `OperationStartPayload` (818–829) | `operation:start` | `operationId, feature, groupId, routeNonce, domFanDisplayName, draftText?, forceRegenerate?, replyMode?, replyTone?` |
| `CompareStartPayload` (831–840) | `compare:start` | `operationId, groupId, routeNonce, domFanDisplayName, forceRegenerate?, replyMode?, replyTone?` |
| `OperationCancelPayload` (842–845) | `operation:cancel` | `operationId` |
| `CompareCancelPayload` (847–850) | `compare:cancel` | `operationId` |

**Background → Content — `BackgroundPortMessage`** (984–1000):

| Interface | `type` | Notable fields |
|---|---|---|
| `ChunkPayload` (862–866) | `operation:chunk` | `operationId, text` (streaming) |
| `CompareReadyPayload` (868–873) | `compare:ready` | `fanDisplayName, cards: Pick<CompareModelCard,'id'\|'label'\|'source'>[]` |
| `CompareChunkPayload` (875–880) | `compare:chunk` | `cardId, text` |
| `DebugPromptPayload` (882–887) | `operation:debugPrompt` | `feature, snapshot: PromptDebugSnapshot` |
| `CompletePayload` (889–896) | `operation:complete` | `result: FeatureResult, fanDisplayName, llmSpend?, profiling?` |
| `ErrorPayload` (898–904) | `operation:error` | `error: UserFacingError, llmSpend?, profiling?` |
| `DiscardedPayload` (906–912) | `operation:discarded` | `error, llmSpend?, profiling?` |
| `CompareCardCompletePayload` (914–922) | `compare:cardComplete` | `cardId, result, fanDisplayName, llmSpend?, profiling?` |
| `CompareCardErrorPayload` (924–931) | `compare:cardError` | `cardId, error, llmSpend?, profiling?` |
| `CompareErrorPayload` (933–938) | `compare:error` | `error, profiling?` |
| `CompareCompletePayload` (940–945) | `compare:complete` | `fanDisplayName, profiling?` |
| `CompareDiscardedPayload` (947–952) | `compare:discarded` | `error, profiling?` |
| `TabStatePayload` (954–957) | **three tags:** `tab:state \| settings:changed \| mapping:changed` | `state: TabUiState` |
| `SummarySyncStatusPayload` (959–964) | `summary:syncStatus` | `groupId, generatedAt, syncStatus: FanSummarySyncStatus` |
| `ProgressEnvelope` (966–968) | `operation:progress` | extends `OperationProgressPayload` |
| `CompareProgressEnvelope` (980–982) | `compare:progress` | extends `CompareProgressPayload` (970–978: `operationId, phase, currentPage?, targetPages?, message?, fanDisplayName?, profiling?`) |

Discrepancy note: `TabStatePayload` (954–957) is a *single* interface carrying
three distinct `type` values (`tab:state`, `settings:changed`, `mapping:changed`)
rather than one interface per tag — the discriminant does not narrow to a unique
interface for those three. All three share the identical `{ state: TabUiState }`
body.

### 1.14 Overlay / inline-panel view models (lines 1004–1119)

- **`OverlayInsertPart`** (1004–1010): `{ id, sequenceIndex, text, insertedAt,
  insertedOnce }` — a splittable reply fragment tracked for insertion into the
  Fansly composer.
- **`OverlayRerunActionLabel`** (1012): `'Regenerate' | 'Refresh'`.
- **`CompareInlineTabState`** (1014–1024): `{ cardId, label, source, status:
  'loading'|'reply'|'error', rawText, parts: OverlayInsertPart[], llmSpend?,
  splitModeRequested?, error? }`.
- **`CompareInlineViewModel`** (1026–1035): `{ kind: 'compare', fanDisplayName,
  operationId, tabs[], activeCardId, progress, canCancel, canRegenerate }`.
- **`OverlayViewModel`** (1037–1110): discriminated by `kind` —
  `'hidden' | 'loading' | 'reply' | 'helpMe' | 'readOnly' | 'error'`. The
  `helpMe` variant is pinned to `feature: 'help-me'` and carries `coaching`,
  `engagingParts`, `flirtyParts`, `parseFallback`; `readOnly` carries
  `summaryMeta?` and inline `reviewMeta?` (rating/evaluation/recommendations/
  parseFallback).
- **`CompletedOverlayViewModel`** (1112–1115): `Extract<OverlayViewModel, { kind:
  'reply'|'helpMe'|'readOnly' }>`.
- **`InlinePanelViewModel`** (1117–1119): `OverlayViewModel | CompareInlineViewModel`.

---

## 2. `src/shared/features.ts`

**Imports:** `FeatureType, ModelSelectableFeatureType, Settings` from `./types.js`.
**Consumed by:** `src/background/operations.ts`, `src/content/index.ts`,
`src/content/surface-planner.ts`, and re-derived in `src/shared/constants.ts`
(`DEEP_FEATURES`/`QUICK_FEATURES`).

### 2.1 Policy vocabulary (lines 7–30)

Derived bucket unions:
- `FeatureMessageCountBucket` = `'quick'|'ping'|'improve'|'deep'|'hi'`.
- `FeatureTimeoutBucket` = `'quick'|'deep'`.
- `FeatureSurfaceKind` = `'inline-reply'|'overlay'`.
- `FeaturePromptMode` = `'reply'|'analysis'`.
- `FeatureResultKind` = `'reply'|'single-reply'|'help-me'|'summary'|'chat-review'`.

**`FeaturePolicy`** (18–30): `{ messageCountBucket, timeoutBucket, modelFeature:
ModelSelectableFeatureType, surfaceKind, promptMode, resultKind, supportsReplyMode:
bool, supportsReplyTone: bool, requiresDraft: bool, usesPingSegment: bool,
includesEarnings?: bool }`.

### 2.2 `FEATURE_POLICIES` (lines 32–118)

`as const satisfies Record<FeatureType, FeaturePolicy>`. Per-feature table:

| Feature | msgCountBucket | timeout | modelFeature | surface | promptMode | resultKind | replyMode | replyTone | requiresDraft | pingSegment | includesEarnings |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `fast-reply` | quick | quick | fast-reply | inline-reply | reply | reply | ✔ | ✔ | – | – | (unset) |
| `improve-draft` | improve | quick | **fast-reply** | inline-reply | reply | single-reply | – | – | **✔** | – | (unset) |
| `help-me` | quick | quick | help-me | **overlay** | **analysis** | help-me | – | – | – | – | (unset) |
| `fan-summary` | **deep** | **deep** | fan-summary | overlay | analysis | summary | – | – | – | – | (unset) |
| `chat-review` | deep | deep | chat-review | overlay | analysis | chat-review | – | – | – | – | (unset) |
| `ping` | ping | quick | ping | inline-reply | reply | reply | – | – | – | **✔** | (unset) |
| `hi-greeting` | hi | quick | **fast-reply** | inline-reply | reply | reply | – | – | – | – | **false** |

Notes / discrepancies:
- Only `fast-reply` sets both `supportsReplyMode` and `supportsReplyTone` true;
  all others are false.
- `includesEarnings` is declared optional on `FeaturePolicy` but is set on
  exactly one feature — `hi-greeting`, and there it is `false` (line 116). No
  feature sets `includesEarnings: true`; for all other features the field is
  absent (`undefined`). So the flag currently never enables earnings for any
  feature via this table.
- `improve-draft` and `hi-greeting` both point `modelFeature` at `fast-reply`
  (they inherit `fast-reply`'s selected model/reasoning; they are excluded from
  `ModelSelectableFeatureType`).

### 2.3 Helper functions (lines 120–175)

- `getFeaturePolicy(feature)` (120–122) → the policy object.
- `isDeepFeature(feature)` (124–126) → `messageCountBucket === 'deep'`.
- `usesInlineFeatureSurface` (128–130) / `usesOverlayFeatureSurface` (132–134).
- `featureSupportsReplyMode` (136–138) / `featureSupportsReplyTone` (140–142).
- `featureRequiresDraft` (144–146) / `featureUsesPingSegment` (148–150).
- **`resolveFeatureMessageCount(feature, settings)`** (152–168): maps bucket →
  `settings.deepMessageCount` / `pingMessageCount` / `improveMessageCount` /
  `quickMessageCount`; the `'hi'` bucket returns a **hardcoded `25`** (comment:
  "fixed: 1 Fansly API page, no user setting") — `hi-greeting` ignores all
  Settings message-count knobs.
- `resolveFeatureModelFeature(feature)` (170–174) → `policy.modelFeature`.

---

## 3. `src/shared/feature-readiness.ts`

**Imports:** `getModelEntry` from `./model-registry.js`; `Settings, TabUiState`
from `./types.js`.
**Consumed by:** `src/background/operations.ts`, `src/background/runtime-api.ts`
(the header comment states both the background operation coordinator and the
popup/options runtime API use these so tab-UI gating never drifts).

- **`buildModelProviderByFeature(settings)`** (9–18): iterates
  `settings.featureModels` entries, resolves each model id via `getModelEntry`,
  and emits `[feature, provider]` only when a provider resolves (unknown models
  are dropped). Returns `TabUiState['modelProviderByFeature']`
  (`Partial<Record<ModelSelectableFeatureType,'anthropic'|'openrouter'>>`).
- **`buildApiKeyReadyByFeature(settings)`** (24–39): for each
  `featureModels` entry — provider `anthropic` → readiness =
  `Boolean(settings.claudeApiKey)`; provider `openrouter` →
  `Boolean(settings.openRouterApiKey)`; unknown/unresolved provider → readiness =
  `Boolean(claudeApiKey || openRouterApiKey)` (either key counts). Returns
  `TabUiState['apiKeyReadyByFeature']`.

Both iterate only over the 5 `ModelSelectableFeatureType` keys present in
`featureModels`; `improve-draft`/`hi-greeting` are not represented directly.

---

## 4. `src/shared/model-registry.ts`

**Imports:** none (self-contained).
**Consumed by:** `background/compare-operations.ts`, `background/llm-client.ts`,
`background/llm-cost.ts`, `background/operations.ts`, `content/spend-format.ts`,
`options/index.ts`, `shared/constants.ts` (re-exports a subset),
`shared/feature-readiness.ts`, `shared/model-capabilities.ts`,
`shared/storage.ts`, `shared/summary-cache.ts`.

### 4.1 Types & providers (lines 1–25)

- `AiProvider` = `'anthropic' | 'openrouter'`.
- **`ModelPricing`** (3–9): `{ inputUsdPerMillion, outputUsdPerMillion,
  cacheWrite5mUsdPerMillion?, cacheWrite1hUsdPerMillion?, cacheReadUsdPerMillion? }`.
- **`AiModelEntry`** (11–22): `{ id, provider, providerModelId, providerLabel,
  label, description, pricing, supportsPromptCache, costApproximate?, pricingNote? }`.
- `ANTHROPIC_PROVIDER = 'anthropic'` (24), `OPENROUTER_PROVIDER = 'openrouter'` (25).

### 4.2 Defaults & catalog (lines 27–156)

- `DEFAULT_MODEL_ID = 'anthropic:claude-sonnet-4-6'` (27).
- `DEFAULT_FAN_SUMMARY_MODEL_ID = 'anthropic:claude-opus-4-6'` (28).

**`AI_MODELS`** (30–156) — 8 entries. `id` format is `provider:providerModelId`:

| `id` | provider | providerModelId | label | supportsPromptCache | input / output USD-per-M | cacheWrite 5m/1h / read |
|---|---|---|---|---|---|---|
| `anthropic:claude-sonnet-4-6` | anthropic | `claude-sonnet-4-6` | Claude Sonnet 4.6 ("Recommended") | ✔ | 3 / 15 | 3.75 / 6 / 0.30 |
| `anthropic:claude-sonnet-4-5` | anthropic | `claude-sonnet-4-5` | Claude Sonnet 4.5 ("Balanced") | ✔ | 3 / 15 | 3.75 / 6 / 0.30 |
| `anthropic:claude-opus-4-6` | anthropic | `claude-opus-4-6` | Claude Opus 4.6 ("Best quality") | ✔ | 5 / 25 | 6.25 / 10 / 0.50 |
| `anthropic:claude-opus-4-5` | anthropic | `claude-opus-4-5` | Claude Opus 4.5 ("Best quality (older)") | ✔ | 5 / 25 | 6.25 / 10 / 0.50 |
| `anthropic:claude-haiku-4-5` | anthropic | `claude-haiku-4-5` | Claude Haiku 4.5 ("Fastest & cheapest") | ✔ | 1 / 5 | 1.25 / 2 / 0.10 |
| `openrouter:google/gemini-3.1-pro-preview` | openrouter | `google/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview | ✗ | 2 / 12 | — |
| `openrouter:x-ai/grok-4.20` | openrouter | `x-ai/grok-4.20` | Grok 4.20 | ✗ (`costApproximate: true`) | 1.25 / 2.50 | read 0.20 |
| `openrouter:x-ai/grok-4.3` | openrouter | `x-ai/grok-4.3` | Grok 4.3 | ✗ (`costApproximate: true`) | 1.25 / 2.50 | read 0.20 |

Both Grok entries carry a `pricingNote` warning that the OpenRouter Grok
cache-read rate is a placeholder/unconfirmed; Grok 4.3's note adds that base-tier
pricing applies below 200k total tokens. OpenRouter entries have
`supportsPromptCache: false`.

### 4.3 Derived collections (lines 158–184)

- `AI_MODEL_IDS` (158): `Set` of all 8 `id`s.
- `CLAUDE_MODELS` (159) / `OPENROUTER_MODELS` (160): filtered by provider.
- `CLAUDE_MODEL_IDS` (161): `Set` of Claude `id`s.
- **`LEGACY_CLAUDE_MODEL_IDS`** (162): `Set` of Claude *`providerModelId`s* (bare,
  e.g. `claude-sonnet-4-6`) — the legacy pre-`provider:` id form, used for
  migration/normalization.
- `AI_MODEL_GROUPS` (164–179): two groups (Anthropic Direct → `CLAUDE_MODELS`,
  OpenRouter → `OPENROUTER_MODELS`) for grouped `<select>` rendering in options.
- Internal maps: `MODELS_BY_ID` (181) and `ANTHROPIC_BY_PROVIDER_ID` (182–184,
  keyed by bare Claude providerModelId).

### 4.4 Lookup functions (lines 186–247)

- **`normalizeModelId(id)`** (186–202): trims; returns the id if it is a known
  full id; else if it matches a bare Claude `providerModelId`, returns the
  corresponding full `id` (legacy Anthropic migration); else `null`. OpenRouter
  bare ids are **not** legacy-migrated (no reverse map for them).
- `getModelEntry(id)` (204–207): normalize → `MODELS_BY_ID.get` or `null`.
- `getModelDisplayName(id, fallback='AI model')` (209–214).
- `isSupportedModelSelection` (216–218), `isAnthropicModelSelection` (220–222),
  `isOpenRouterModelSelection` (224–226).
- `modelSelectionsEquivalent(left, right)` (228–235): true only when both
  normalize to the same non-null id.
- `getProviderModelId(modelId)` (237–239): entry's `providerModelId`, else the
  raw input.
- **`getAgencyHubModelId(modelId)`** (241–247): for Anthropic → bare
  `providerModelId` (e.g. `claude-sonnet-4-6`); for OpenRouter → the full `id`
  (e.g. `openrouter:x-ai/grok-4.3`); unknown → raw input. (Asymmetric by design —
  what the Agency Hub `model` field carries per provider.)

---

## 5. `src/shared/model-capabilities.ts`

**Imports:** `FeatureType` from `./types.js`; `ANTHROPIC_PROVIDER, getModelEntry,
OPENROUTER_PROVIDER` from `./model-registry.js`.
**Consumed by:** `background/anthropic-client.ts`, `background/openrouter-client.ts`,
`options/index.ts`.

### 5.1 Internal tables (lines 8–29)

- **`ANTHROPIC_ADAPTIVE_THINKING_MODELS`** (8–11): `Set(['claude-sonnet-4-6',
  'claude-opus-4-6'])`. Discrepancy to flag: only the two newest Claude models
  support adaptive thinking — `claude-sonnet-4-5`, `claude-opus-4-5`, and
  `claude-haiku-4-5` are **excluded** despite also being Claude models.
- **`ANTHROPIC_ADAPTIVE_THINKING_MAX_TOKENS`** (13–21): per-feature thinking
  budget (all 7 features): `fast-reply 8000, improve-draft 8000, help-me 16000,
  fan-summary 24000, chat-review 16000, ping 8000, hi-greeting 8000`.
- **`OPENROUTER_GEMINI_THINKING_MAX_TOKENS`** (23–29): only 5 features have
  entries — `fast-reply 1600, improve-draft 1600, hi-greeting 1600, ping 1600,
  help-me 2000`. `fan-summary` and `chat-review` are **absent** (so Gemini
  thinking is not enabled for those two — see `supportsOpenRouterGeminiThinking`).

### 5.2 Functions (lines 31–79)

- `supportsAnthropicAdaptiveThinking(providerModelId)` (31–33): membership in the
  set above.
- `getAnthropicAdaptiveThinkingMaxTokens(feature)` (35–39): looks up the token
  table by feature (independent of model support).
- `isOpenRouterGeminiModel(providerModelId)` (41–43): `startsWith('google/gemini-')`.
  Matches the registry's `google/gemini-3.1-pro-preview`.
- `getOpenRouterGeminiThinkingMaxTokens(feature)` (45–49): from the Gemini token
  table (undefined for fan-summary/chat-review).
- `supportsOpenRouterGeminiThinking(providerModelId, feature)` (51–59): true only
  when the model is a Gemini model *and* the feature has a max-token entry.
- **`supportsModelReasoningConfig(modelId, feature)`** (61–79): resolves the
  entry; Anthropic → `supportsAnthropicAdaptiveThinking(providerModelId)`;
  OpenRouter → `supportsOpenRouterGeminiThinking(providerModelId, feature)`;
  unknown/other → `false`. This is the single gate deciding whether the
  reasoning-effort UI/param is offered for a (model, feature) pair.

---

## 6. `src/shared/constants.ts`

**Imports:** `FeatureType, ModelSelectableFeatureType, ReasoningEffort, Settings`
from `./types.js`; `FEATURE_POLICIES` + type `FeaturePolicy` from `./features.js`;
`DEFAULT_FAN_SUMMARY_MODEL_ID, DEFAULT_MODEL_ID` from `./model-registry.js`.
**Re-exports** (lines 9–18) from `model-registry.js`: `AI_MODEL_GROUPS,
AI_MODEL_IDS, AI_MODELS, CLAUDE_MODEL_IDS, CLAUDE_MODELS, DEFAULT_MODEL_ID,
LEGACY_CLAUDE_MODEL_IDS, OPENROUTER_MODELS` — so importers of `shared/constants`
transitively get the registry symbols.
**Consumed by:** 16 modules across background/, content/, options/ (see
`grep -rl "shared/constants" src`), including all four API clients, the storage
coordinator, spenders service, and inline-panel controller.

### 6.1 Storage (lines 26–29)

| Constant | Value | Boundary |
|---|---|---|
| `STORAGE_SCHEMA_VERSION` | `7` | `browser.storage.local` schema version (migrations) |
| `SUMMARY_CACHE_PREFIX` | `'summary:'` | storage-key prefix for cached fan summaries |
| `KNOWN_ACCOUNTS_KEY` | `'knownAccounts'` | storage key |
| `SUMMARY_EVICTION_COUNT` | `10` | LRU eviction batch size for summary cache |

### 6.2 AI provider APIs (lines 33–75)

| Constant | Value |
|---|---|
| `CLAUDE_API_URL` | `'https://api.anthropic.com/v1/messages'` |
| `OPENROUTER_MESSAGES_API_URL` | `'https://openrouter.ai/api/v1/messages'` |
| `ANTHROPIC_VERSION` | `'2023-06-01'` (anthropic-version header) |
| `DEFAULT_FEATURE_MODELS` | `Record<ModelSelectableFeatureType,string>`: `fast-reply/help-me/chat-review/ping = DEFAULT_MODEL_ID`, `fan-summary = DEFAULT_FAN_SUMMARY_MODEL_ID` (37–43) |
| `REASONING_EFFORTS` | `['off','low','medium','high','max']` (45) |
| `DEFAULT_FEATURE_REASONING` | all 5 selectable features default to `'medium'` (47–53) |
| `MAX_TOKENS` | per-feature output cap (55–63): fast-reply 800, improve-draft 800, help-me 1200, fan-summary 8192, chat-review 1600, ping 800, hi-greeting 800 |
| `FEATURE_TEMPERATURES` | per-feature temp (65–73): fast-reply 0.65, improve-draft 0.65, help-me 0.45, fan-summary 0.4, chat-review 0.25, ping 0.65, hi-greeting 0.7 |
| `COMPARE_TEMPERATURE` | `0.35` (75) — Multi/compare path |

### 6.3 Fansly API (lines 79–90)

| Constant | Value | Note |
|---|---|---|
| `FANSLY_API_BASE` | `'https://apiv3.fansly.com/api/v1'` | REST base |
| `FANSLY_PAGE_LIMIT` | `25` | page size |
| `FANSLY_REQUEST_TIMEOUT_MS` | `30_000` | per-request timeout |
| `FANSLY_PAGINATION_DELAY_MS` | `300` | inter-page delay |
| `FANSLY_RETRY_DELAYS_MS` | `[1000, 2000, 4000]` | retry backoff |
| `FANSLY_RETRY_MAX_BACKOFF_MS` | `5_000` | cap on Retry-After honored per retry (else surfaces `rate_limited`) |
| `FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT` | `10` | media items verified per op |
| `FANSLY_MEDIA_PURCHASE_VERIFICATION_CONCURRENCY` | `3` | |
| `FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS` | `3_000` | |
| `FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS` | `5 * 60 * 1000` (5 min) | |

### 6.4 Spenders board (lines 99–105)

| Constant | Value | Note |
|---|---|---|
| `SPENDERS_MAX_FANS` | `150` | most-recent conversations scanned for lifetime spend before ranking |
| `SPENDERS_EARNINGS_CONCURRENCY` | `4` | concurrent per-fan earnings fetches |
| `SPENDERS_CACHE_TTL_MS` | `10 * 60 * 1000` (10 min) | per-creator board reuse window |
| `SPENDERS_BUILD_TIMEOUT_MS` | `120_000` | overall board-build budget |

Header comment (92–97) states a ranked top-spenders list has no single Fansly
endpoint — it enumerates conversations then fetches lifetime earnings per fan
(one call each), hence the bounded/low-concurrency/cached design.

### 6.5 Message counts (lines 109–120)

`QUICK_DEFAULT=100, QUICK_MIN=5, QUICK_MAX=200`. `PING_*` alias the `QUICK_*`
values. `IMPROVE_DEFAULT=25, IMPROVE_MIN=QUICK_MIN(5), IMPROVE_MAX=QUICK_MAX(200)`.
`DEEP_DEFAULT=1500, DEEP_MIN=100, DEEP_MAX=3000`.

### 6.6 Timeouts (lines 124–128)

`QUICK_OPERATION_TIMEOUT_MS=60_000`; `DEEP_OPERATION_PREP_TIMEOUT_MS=180_000`;
`DEEP_OPERATION_LLM_TTFB_TIMEOUT_MS=45_000`; `DEEP_OPERATION_LLM_IDLE_TIMEOUT_MS=45_000`;
`DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS=300_000`.

### 6.7 Intervals & throttles (lines 132–140)

`ROUTE_POLL_INTERVAL_MS=500`; `STREAM_CHUNK_FLUSH_MS=50`;
`CONVERSATION_ATTACH_TIMEOUT_MS=10_000`; `CONVERSATION_ATTACH_RETRY_MS=50`;
`CONVERSATION_ATTACH_SLOW_RETRY_MS=2_000` (slow re-check cadence after fast-attach
window lapses); `PORT_RECONNECT_DELAYS_MS=[100,200,400]`.

### 6.8 Feature thresholds & earnings/hub (lines 144–158)

- `MIN_MESSAGES_FOR_DEEP=30`; `HI_GREETING_MAX_TRANSCRIPT=10`; `PING_ACTIVE_DAYS=5`;
  `PING_MIN_FAN_MESSAGES=3`.
- `EARNINGS_FALLBACK_WINDOW_MS = 90 * 24 * 60 * 60 * 1000` (90 days).
- Agency Hub: `AGENCY_HUB_PREFETCH_TIMEOUT_MS=5_000`; `AGENCY_HUB_SYNC_TIMEOUT_MS=10_000`;
  `AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS=100`; `AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS=1_000`;
  `AGENCY_HUB_AI_USAGE_REPORT_TIMEOUT_MS=5_000`; `AGENCY_HUB_AI_USAGE_REPORT_MAX_ATTEMPTS=3`;
  `AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS=[5_000, 15_000]`.

### 6.9 UI, feature categories, defaults, build (lines 162–207)

- `OVERLAY_Z_INDEX = 2147483646`; `CHATGOOSE_NAMESPACE = 'chatgoose'`.
- **`DEEP_FEATURES`** (167–171) / **`QUICK_FEATURES`** (172–176): derived at module
  load by filtering `FEATURE_POLICIES` on `messageCountBucket === 'deep'` / `'quick'`.
  (Deep = `fan-summary, chat-review`; Quick = `fast-reply, help-me`. `improve-draft`,
  `ping`, `hi-greeting` fall in neither list — their buckets are `improve`/`ping`/`hi`.)
- **`FEATURE_LABELS`** (178–186): display strings — `fast-reply→'Reply'`,
  `improve-draft→'Fix'`, `help-me→'Help'`, `fan-summary→'Summary'`,
  `chat-review→'Review'`, `ping→'Ping'`, `hi-greeting→'Hi'`.
- **`DEFAULT_SETTINGS`** (190–203): the `Settings` seed — empty keys/URLs,
  `debugMode:false`, `promptCachingEnabled:true`, message counts from the
  `*_DEFAULT_MESSAGE_COUNT` constants, `featureModels: {...DEFAULT_FEATURE_MODELS}`,
  `featureReasoning: {...DEFAULT_FEATURE_REASONING}`.
- **`BUILD_TIME = __CHATGOOSE_BUILD_TIME__`** (207): a build-time global —
  declared in `src/env.d.ts`, injected as an ISO timestamp by
  `esbuild.config.mjs` (lines 97, 122) and as `'test-build'` by
  `vitest.config.ts` (line 32).

---

## Cross-module dependency summary

- `types.ts` is the leaf: imported by everything, imports nothing.
- `features.ts` depends only on `types.ts`.
- `model-registry.ts` is a leaf (no imports); `feature-readiness.ts`,
  `model-capabilities.ts`, and `constants.ts` all depend on it (and on `types.ts`).
- `constants.ts` depends on `features.ts` (`FEATURE_POLICIES` for the derived
  `DEEP_FEATURES`/`QUICK_FEATURES`) and re-exports 8 registry symbols.
- `feature-readiness.ts` depends on `model-registry.ts` (`getModelEntry`) and
  `types.ts`; there is no dependency between `feature-readiness.ts` and
  `features.ts`.

## Boundary touch-points defined here (executed elsewhere)

- **Network endpoints (string constants):** `CLAUDE_API_URL`,
  `OPENROUTER_MESSAGES_API_URL`, `FANSLY_API_BASE`, `ANTHROPIC_VERSION`
  (constants.ts) — consumed by the four background clients.
- **Wire-shape types:** all `Fansly*` interfaces (types.ts §1.6–1.8),
  `AgencyHubAiUsageEvent`/`AgencyHubAiUsageBatchResponse`, `PromptTextBlock`/
  `PromptCacheControl`/`LlmUsageMetrics` (Anthropic/OpenRouter message + usage
  shapes).
- **Storage keys/schema:** `STORAGE_SCHEMA_VERSION=7`, `SUMMARY_CACHE_PREFIX`,
  `KNOWN_ACCOUNTS_KEY`; `PersistedState`/`SummaryCacheEntry` shapes.
- **IPC:** `PortEnvelopeBase` type union + all `ContentPortMessage`/
  `BackgroundPortMessage` variants (channel a); `RuntimeRequestMap`/
  `RuntimeResponseMap` (channel b).

## Discrepancies / open questions found

1. `FeaturePolicy.includesEarnings` is declared but set on only one feature
   (`hi-greeting`, and to `false`); no feature enables earnings via this flag
   (`features.ts:116`).
2. `TabStatePayload` (`types.ts:954-957`) carries three `type` tags
   (`tab:state | settings:changed | mapping:changed`) in one interface, so the
   port-message discriminated union does not narrow those three to distinct
   interfaces.
3. Adaptive-thinking support is restricted to `claude-sonnet-4-6` and
   `claude-opus-4-6` only (`model-capabilities.ts:8-11`); the three older Claude
   models (sonnet-4-5, opus-4-5, haiku-4-5) are excluded even though they are
   Claude models with `supportsPromptCache: true`.
4. OpenRouter Gemini thinking is unavailable for `fan-summary` and `chat-review`
   because those features have no entry in `OPENROUTER_GEMINI_THINKING_MAX_TOKENS`
   (`model-capabilities.ts:23-29`).
5. `resolveFeatureMessageCount` hardcodes `25` for the `hi` bucket
   (`features.ts:166`) — `hi-greeting` ignores every Settings message-count knob;
   separately `HI_GREETING_MAX_TRANSCRIPT=10` gates the feature.
6. `normalizeModelId` legacy-migrates only bare *Anthropic* provider ids to full
   `provider:` ids; there is no reverse map for OpenRouter bare ids
   (`model-registry.ts:186-202`).
7. `getAgencyHubModelId` returns different id forms per provider (bare
   `providerModelId` for Anthropic, full `id` for OpenRouter)
   (`model-registry.ts:241-247`), so the `model` field sent to
   `POST api/v1/ai-usage/batch` differs in shape by provider.
