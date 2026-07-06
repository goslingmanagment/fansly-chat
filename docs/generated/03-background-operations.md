> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Background operations — the single-feature Operation engine

This document describes `OperationCoordinator`
(`src/background/operations.ts`), the background-side engine that runs one
single-feature AI generation per browser tab. It reads conversation context
live from Fansly and the Agency Hub, streams a generation through the kernel
feature gateway, and emits result frames back to the content script over the
per-tab `browser.runtime.Port`.

Since the 1.6.0 kernel cutover the engine no longer holds vendor LLM keys or
assembles prompts: it hands **context values** to the kernel's
`POST /api/v1/ai/features/:feature` SSE endpoint through
`KernelFeatureGateway.streamFeature` (`kernel-feature-gateway.ts:138`), and the
kernel does prompt assembly, budgeting, capture, and pricing. The extension
still loads Fansly context itself because Fansly has no webhook lane
(`kernel-feature-gateway.ts:4-9`).

The multi-card "compare" flow lives in a sibling module
(`compare-operations.ts`) and is only wired in here through
`getCompareContext` / `startCompare` / `cancelCompare`
(`src/background/operations.ts:2451-2478`); it is not documented in detail
below.

## Collaborators (constructor)

`OperationCoordinator` is constructed with
(`src/background/operations.ts:385-393`):

- `sessionStore: SessionStore` — per-tab Fansly session templates and captured
  account ids.
- `tabContexts: TabContextStore` — per-tab route (`groupId`/`routeNonce`),
  account, fan, and active-operation-id state.
- `fanslyClient: FanslyClient` — every read of Fansly data.
- `kernelGateway: KernelFeatureGateway` — configuration probe + the AI stream.
- `storageCoordinator: StorageCoordinator` — persisted settings, personalities,
  account mappings, and the durable summary cache.
- `agencyHubClient: AgencyHubClient` — fan-profile fetch/push and page-label
  resolution against the hub.
- `acceptance?: Pick<AcceptanceReporter, 'enqueue'>` — optional acceptance
  telemetry spool.

Per-tab live state is held in maps keyed by `tabId`: `portsByTabId`
(`src/background/operations.ts:373`), an `OperationRegistry` (`lifecycle`,
`src/background/operations.ts:374-375`), and bounded correlation/dedup maps
`acceptanceContexts` (newest-wins, capped at 50 entries,
`src/background/operations.ts:396-409`),
`pendingSummaryAvailabilityByKey` and
`pendingIdentityResolutionByLegacyAccountId`
(`src/background/operations.ts:376-383`).

## Port wiring & inbound frames

`registerPort` (`src/background/operations.ts:431-449`) records the port under
`port.sender.tab.id`, subscribes to `onMessage` (filtering through
`isContentPortMessage`, `src/background/operations.ts:439`), and on
`onDisconnect` deletes the port and cancels any active feature and compare
operations (`src/background/operations.ts:443-448`).

`handlePortMessage` (`src/background/operations.ts:493-543`) dispatches the
content→background `ContentPortMessage` union
(`src/shared/types.ts:870-877`):

- `tab:init` — set route + account in `tabContexts`, then push `tab:state`
  (`src/background/operations.ts:498-505`).
- `tab:routeChanged` — `handleRouteChanged` (`src/background/operations.ts:506-507`).
- `operation:start` — `startOperation` (`src/background/operations.ts:509-510`).
- `compare:start` — `startCompare` (`src/background/operations.ts:512-513`).
- `operation:acceptance` — look up the remembered acceptance context by
  `operationId` and, if present with a reporter, enqueue a `copied`/`inserted`
  event stamped `at: new Date().toISOString()`
  (`src/background/operations.ts:515-525`).
- `operation:cancel` — cancel only if the tab's active op matches the given
  `operationId` (`src/background/operations.ts:526-532`).
- `compare:cancel` — analogous for compare (`src/background/operations.ts:533-539`).

`OperationStartPayload` fields (`src/shared/types.ts:836-847`): `operationId`,
`feature`, `groupId`, `routeNonce`, `domFanDisplayName`, and optional
`draftText`, `forceRegenerate`, `replyMode`, `replyTone`. The port-message
validator requires the operationId, a known `FeatureType`, a `groupId`
(nullable) + numeric `routeNonce`, and validates the optional fields
(`src/shared/protocol.ts:139-148`).

## Operation lifecycle (start → complete)

`startOperation` (`src/background/operations.ts:1159-2449`) is the whole engine.
Ordered steps with anchors:

1. **Concurrency guard.** If the tab is busy (`isBusy` = active feature, active
   compare, or a reservation), emit `operation:error` with `another_operation`
   and return — concurrent ops are blocked, not auto-cancelled
   (`src/background/operations.ts:1163-1171`;
   `src/background/operation-registry.ts:73-79`).
2. **Reserve the tab synchronously** before the first `await` via
   `lifecycle.reserve(tabId)`, so a racing start cannot slip past the guard
   while `validateStart` is in flight; a failed reservation also emits
   `another_operation` (`src/background/operations.ts:1178-1187`).
3. **Validate** (`validateStart`, `src/background/operations.ts:884-930`). Reads
   `browser.tabs.get(tabId)` and `storageCoordinator.getState()` in parallel.
   Rejections:
   - URL not on `fansly.com`, or the URL-parsed group id is missing or does not
     equal `payload.groupId` → `chat_changed`
     (`src/background/operations.ts:892-899`; group id parsed by
     `parseGroupIdFromUrl` regex `/\/messages\/([^/?#]+)/`,
     `src/background/operation-utils.ts:13-19`).
   - `kernelGateway.isConfigured(settings)` false → `hub_missing_api_key`
     (`src/background/operations.ts:906-908`). Configured means a normalized
     `agencyHubBaseUrl` plus a resolvable hub bearer
     (`kernel-feature-gateway.ts:132-135`).
   - No personalities → `no_personalities`; no session/legacy account id →
     `not_connected`; session not connected → `session_expired`
     (`src/background/operations.ts:909-917`).
   - Resolves the requested `messageCount` from the feature's bucket
     (`src/background/operations.ts:925-928`; buckets below).
4. **Set up profiler + timeouts.** `createOperationProfiler(debugMode)` (a
   no-op profiler when debug is off, `operation-profiling.ts:60-75`); an
   `OperationTimeoutController`. Deep features arm `deep-prep`
   (`DEEP_OPERATION_PREP_TIMEOUT_MS`); quick features arm a single `quick-total`
   (`QUICK_OPERATION_TIMEOUT_MS`)
   (`src/background/operations.ts:1195-1230`). Closures
   `startLlmTtfbTimeout` / `startLlmStreamTimeouts` / `resetLlmIdleTimeout` /
   `clearLlmTimeouts` manage the deep LLM-phase timers
   (`src/background/operations.ts:1197-1225`) — all no-ops for quick features.
5. **Build the abort signal.** `AbortSignal.any([operationController.signal,
   operationTimeoutController.signal])` — this combined `signal` is threaded
   into every Fansly/hub/gateway call, so both cancellation and any armed
   timeout abort the same downstream work
   (`src/background/operations.ts:1231-1236`).
6. **Register the active operation.** Create `ActiveOperation`
   (`src/background/operations.ts:1238-1259`; shape at
   `src/background/operations.ts:134-147`: `operationId`, `tabId`, `feature`,
   `groupId`, `routeNonce`, `startedAtMs`, `controller`, `rawText`,
   `flushBuffer`, `flushTimer`, `llmSpend`, `profiler`),
   `lifecycle.activateFeature`, and record the active id + route in
   `tabContexts`.
7. **Emit first progress** (phase `loading-messages`;
   `src/background/operations.ts:1261-1368`). Progress state is accumulated in
   locals and flushed through `sendOperationProgress`; a debug-gated variant
   `sendDebugProgress` only sends when the profiler is enabled
   (`src/background/operations.ts:1317-1322`).
8. **Resolve account identity** (`resolve-identity` stage). Calls
   `fanslyClient.getAuthenticatedAccountId`; on failure it re-throws for most
   features but for ping-segment features it degrades to the legacy account id
   (`src/background/operations.ts:1370-1407`). Then
   `storageCoordinator.rekeyAccountIdentity` migrates mappings from the legacy
   id to the resolved id (`src/background/operations.ts:1409-1425`).
9. **Resolve personality.** `resolveMappedPersonalityId` over the (possibly
   rekeyed) mappings/aliases; missing → `no_mapping`
   (`src/background/operations.ts:1428-1443`). Draft-requiring features with an
   empty `draftText` → `unknown_error`
   (`src/background/operations.ts:1445-1447`).
10. **fan-summary short-circuits** (only for `feature === 'fan-summary'`,
    `src/background/operations.ts:1456-1610`):
    - `forceRegenerate` removes the durable cache entry first
      (`src/background/operations.ts:1458-1461`).
    - Local cache hit (`isValidSummaryCacheEntry` against personality id,
      `personality.updatedAt`, and the `'kernel'` model sentinel) → reconcile
      the hub sync status, emit `operation:complete` with zero spend, and if
      needed enqueue a background hub push; **return without any generation**
      (`src/background/operations.ts:1473-1553`).
    - Otherwise (unless `forceRegenerate`) attempt a hub prefetch via
      `prefetchAgencyHubSummary`; on a hub hit, cache it locally and emit
      `operation:complete` with zero spend, then return
      (`src/background/operations.ts:1555-1598`).
    - On miss, fall through to full generation
      (`src/background/operations.ts:1601-1610`).
11. **Load messages** (`load-messages` stage). `fanslyClient.loadMessages`
    fetches up to `messageCount` messages; a progress callback is supplied when
    the profiler is on or the feature is deep, and deep features surface page
    progress (`current/target pages`) to the panel
    (`src/background/operations.ts:1612-1648`).
12. **Group lookup** (`group-lookup` stage) — `fanslyClient.getGroup` to get
    group users; skipped for `ping` when authenticated identity was not
    resolved; failures are logged fail-open, leaving `groupUsers` null
    (`src/background/operations.ts:1650-1686`). The fan account id is the first
    group user that is not the resolved model account
    (`src/background/operations.ts:1688-1694`).
13. **Media purchase evidence** — `loadMediaPurchaseEvidence`
    (`conversation-context-loader.ts:15-68`, see below); used to label PPV
    purchase state (`src/background/operations.ts:1696-1703`).
14. **Normalize transcript** — `normalizeTranscript(pages, resolvedAccountId,
    fanAccountId, purchaseEvidence)` after group-lookup so PPV labels can use
    the resolved fan id; a null fan id degrades PPV labels to "unknown" rather
    than misclassifying (`src/background/operations.ts:1705-1714`).
15. **Feature gates on transcript size**: deep features with fewer than
    `MIN_MESSAGES_FOR_DEEP` (30) messages → `not_enough_history`; `hi-greeting`
    with more than `HI_GREETING_MAX_TRANSCRIPT` (10) → `hi_too_many_messages`
    (`src/background/operations.ts:1716-1728`;
    `src/shared/constants.ts:89-90`).
16. **Ping analysis** (`ping-analysis` stage, ping-segment features only).
    `analyzePingSegment` picks a `PingSegment`; segment `active` emits
    `operation:error` `ping_blocked` and returns before any generation
    (`src/background/operations.ts:1730-1759`).
17. **Fan display name** (`account-name-lookup` stage). `getAccountNames`
    resolves `fanDisplayName` (username → displayName → DOM name → `'fan'`); for
    `hi-greeting`, `account.about` becomes `fanBio`; failures are logged
    fail-open (`src/background/operations.ts:1761-1801`). Then `tabContexts.setFan`
    and a `generating` progress frame
    (`src/background/operations.ts:1803-1809`).
18. **Earnings + subscription** (`earnings` + `subscription-lookup` stages,
    skipped when the feature's `includesEarnings === false` — i.e.
    `hi-greeting` — or no fan id). `Promise.allSettled` over
    `getMonthlyEarnings`, `getEarnings`, and `getFanSubscriptionContext`
    (lookup mode `'full'`); deep features additionally fan out up to 12 recent
    months of per-type breakdown at concurrency 4; both are formatted into
    `spendingData` / `subscriptionData` strings and are fail-open
    (`src/background/operations.ts:1811-2054`).
19. **Build context** (`prompt-build` stage). Formats the transcript, resolves
    the creator username, and resolves the hub page label via
    `agencyHubClient.resolvePageLabelForUsername`; **a missing page label throws
    `hub_page_match_failed`** (`src/background/operations.ts:2056-2070`). Builds
    the `KernelFeatureRequest` (`src/background/operations.ts:2071-2090`; fields
    below). Prompt assembly itself is kernel-side; the debug snapshot marks the
    system/user blocks as `[assembled kernel-side]`
    (`src/background/operations.ts:2097-2118`).
20. **Stream the generation.** `llm-ttfb` stage armed
    (`src/background/operations.ts:2128-2131`), then a retry loop calls
    `kernelGateway.streamFeature(settings, kernelRequest, streamCallbacks,
    signal)` (`src/background/operations.ts:2247-2299`). Callbacks
    (`src/background/operations.ts:2177-2243`):
    - `onText` — gated to the still-active matching op; on the first text chunk
      it enqueues an acceptance `shown` event and logs; appends to `rawText` +
      `flushBuffer` and schedules a chunk flush
      (`src/background/operations.ts:2178-2208`).
    - `onMeta` — records the kernel-named `model` and remembers the acceptance
      context keyed by `operationId` with the generation `requestId`
      (`src/background/operations.ts:2209-2224`).
    - `onUsage` — `handleKernelUsage` builds the gateway-priced
      `LlmSpendSummary`, stores it on the active op, records profiler usage, and
      re-emits progress (`src/background/operations.ts:2134-2156`,
      `2225-2228`).
    - `onReasoningDelta` — marks provider activity and, in debug, accumulates
      the reasoning block (`src/background/operations.ts:2229-2239`).
    - `onStopReason` — captures the terminal stop reason
      (`src/background/operations.ts:2240-2242`).
21. **Finalize stream.** Clear LLM timeouts, complete/skip the stream stages,
    flush any buffered chunk (`src/background/operations.ts:2300-2324`). A
    `max_tokens` stop reason on a `reply`-mode feature throws
    `ai_output_unusable` (`src/background/operations.ts:2326-2331`).
22. **Build the result** — `buildFeatureResult` shapes the raw text per the
    feature's `resultKind`; `assertInsertableFeatureResult` throws
    `ai_output_unusable` when a reply/single-reply has no insertable parts
    (`src/background/operations.ts:2333-2338`, `325-370`).
23. **fan-summary persistence + sync** — stamp `summaryMeta`, save to the
    durable cache only when spending + subscription were verified and the model
    matched, then (post-complete) enqueue a background hub push when the sync
    state is `saving` (`src/background/operations.ts:2340-2396`).
24. **Complete.** Emit `operation:complete` with the result, `fanDisplayName`,
    the final spend (or a zeroed summary), and the profiling snapshot; then
    `clearCompletedOperation` (`src/background/operations.ts:2372-2380`,
    `953-960`).
25. **Error path** (catch, `src/background/operations.ts:2397-2444`). If the
    op's id is in the cancelled set (`consumeCancelledFeature`) the error is
    swallowed silently (a cancellation already notified). Otherwise running
    profiler stages are finalized, an `AbortError` is mapped via
    `resolveAbortChatGooseError` (timeout → `timed_out`; inactive/cancelled →
    `chat_changed`; else `network_error`,
    `src/background/operation-utils.ts:29-46`), and `operation:error` is emitted
    with spend + profiling; then `cancelOperation` runs and the id is dropped
    from the cancelled set to keep it bounded.
26. **Finally** — always `lifecycle.releaseReservation(tabId)` and
    `timeoutController.clearAll()` (`src/background/operations.ts:2445-2448`).

## The `KernelFeatureRequest` / `clientContext` the engine builds

Built at `src/background/operations.ts:2071-2090` and forwarded by the gateway
at `kernel-feature-gateway.ts:190-215`. Request fields and their sources:

| Field | Value / source |
|---|---|
| `feature` | `payload.feature` (`operations.ts:2072`) |
| `clientRequestId` | `payload.operationId` — the kernel dedup/correlation key; must be a UUID (`operations.ts:2073`; `kernel-feature-gateway.ts:30-31`) |
| `pageLabel` | `agencyHubClient.resolvePageLabelForUsername(settings, pageUsername, signal)`; missing → `hub_page_match_failed` (`operations.ts:2063-2069`) |
| `conversationRef` | `fanAccountId ?? urlGroupId` — the Fansly fan account id, falling back to the group id (`operations.ts:2075`) |
| `personaKey` | `personality.id` (`operations.ts:2076`) |
| `replyTone` | `payload.replyTone` (`operations.ts:2077`) |
| `replyMode` | `payload.replyMode` (`operations.ts:2078`) |
| `draftText` | `payload.draftText` (`operations.ts:2079`) |
| `isRegeneration` | `Boolean(payload.forceRegenerate)` (`operations.ts:2080`) |
| `clientContext` | object below (`operations.ts:2081-2089`) |

`clientContext` (`KernelFeatureClientContext`,
`kernel-feature-gateway.ts:18-26`) carries the live-read context **values**
(never assembled prompt text):

- `transcript` — `formatTranscript(transcriptMessages)`
  (`operations.ts:2057,2082`).
- `messageCount` — `transcriptMessages.length` (`operations.ts:2083`).
- `fanDisplayName` — resolved display name (`operations.ts:2084`).
- `fanSpendingData` — `formatFanSpendingData(...)` string, or empty
  (`operations.ts:2085`).
- `fanSubscriptionData` — `formatFanSubscriptionData(...)` string, or empty
  (`operations.ts:2086`).
- `fanBio` — only for `hi-greeting`, only when present
  (`operations.ts:2087`).
- `pingSegment` — only for ping-segment features
  (`operations.ts:2088`).

The gateway additionally injects a fixed `platform: 'fansly'` into the wire body
(`kernel-feature-gateway.ts:195`), sets bearer auth from the hub settings, adds
`clientVersionHeaders()`, and streams to
`POST /api/v1/ai/features/:feature` via the vendored `@kernel/sdk`
`streamAiFeature` (`kernel-feature-gateway.ts:138-219`). It accumulates
`content_delta` frames into the returned raw text, maps `meta`/`usage`/
`reasoning_delta`/`done` frames onto the callbacks, and **fails closed**
(`hub_request_failed`) if the stream ends without a terminal `done` frame
(`kernel-feature-gateway.ts:148-234`). Gateway/HTTP errors are mapped to
CG error keys, including product-gate 400s → `not_enough_history` /
`hi_too_many_messages` / `ping_blocked`, 429 → `rate_limited`, 502/503 →
`service_unavailable`, 401/403 → `hub_invalid_api_key`
(`kernel-feature-gateway.ts:65-115`).

## Feature-specific behavior

Feature policy is data-driven from `FEATURE_POLICIES`
(`src/shared/features.ts:32-118`). The seven features:

- **fast-reply** — quick timeout; message bucket `quick`
  (`settings.quickMessageCount`); `resultKind: 'reply'` via
  `normalizeReplyParts`; supports `replyMode` and `replyTone`; earnings +
  subscription loaded (`src/shared/features.ts:33-44`;
  `src/background/operations.ts:342-355`).
- **improve-draft** — quick; message bucket `improve`
  (`settings.improveMessageCount`, default 25); requires `draftText`
  (`featureRequiresDraft` → empty draft becomes `unknown_error` at
  `operations.ts:1445-1447`); `resultKind: 'single-reply'`
  (`normalizeSingleReplyPart`); no reply mode/tone
  (`src/shared/features.ts:45-56`).
- **help-me** — quick; `promptMode: 'analysis'`, `resultKind: 'help-me'`
  parsed by `parseHelpMeXml`; overlay surface
  (`src/shared/features.ts:57-68`; `operations.ts:331-332`).
- **fan-summary** — deep bucket + deep timeouts; `resultKind: 'summary'`; the
  only feature with cache/prefetch short-circuits, durable-cache persistence,
  and Agency Hub summary push (steps 10 and 23 above;
  `src/shared/features.ts:69-80`).
- **chat-review** — deep bucket + deep timeouts; `resultKind: 'chat-review'`
  parsed by `parseChatReviewXml`; overlay surface
  (`src/shared/features.ts:81-92`; `operations.ts:333-334`).
- **ping** — quick timeout; message bucket `ping`
  (`settings.pingMessageCount`); `usesPingSegment: true` — runs ping analysis
  and blocks when the segment is `active`; group-lookup is skipped when the
  authenticated identity failed to resolve; identity-resolution failure is
  tolerated (`src/shared/features.ts:93-104`;
  `operations.ts:1651,1680-1686,1730-1759`).
- **hi-greeting** — quick; fixed message count of **25** ("1 Fansly API page, no
  user setting", `src/shared/features.ts:166`); `includesEarnings: false` so the
  earnings/subscription stages are skipped
  (`operations.ts:1816,2044-2054`); capped at 10 transcript messages
  (`hi_too_many_messages`); pulls the fan `about` into `fanBio`; `resultKind:
  'reply'` via `normalizeVariantReplyParts`
  (`src/shared/features.ts:105-117`; `operations.ts:342-345,1723-1728`).

`resolveFeatureMessageCount` maps the buckets to settings values
(`src/shared/features.ts:152-168`). Deep features are those whose
`messageCountBucket === 'deep'` (`isDeepFeature`,
`src/shared/features.ts:124-126`); deep timeouts are keyed off
`timeoutBucket === 'deep'` (`usesDeepOperationTimeouts`,
`src/background/operations.ts:321-323`).

## Staleness & cancellation gating

There is at most one active feature operation per tab, keyed by `tabId` in the
registry (`src/background/operation-registry.ts:35`), so staleness is enforced
by **operation-id identity**, not by comparing `routeNonce` at stream time:

- Streamed `onText`/`onUsage` only apply when
  `getActive(tabId).operationId === payload.operationId`; otherwise the chunk is
  dropped (`src/background/operations.ts:2138-2141`, `2179-2185`).
- `assertActive(tabId, operationId)` throws `chat_changed` when the tab's active
  op is no longer this one — used before finalizing cache-hit/hub-hit summaries
  and before the final flush (`src/background/operations.ts:1148-1157`, `1524`,
  `1583`, `2321`).
- `validateStart` re-checks that the current tab URL still parses to the same
  `groupId` as `payload.groupId`, so a start that arrives after the route
  already moved fails with `chat_changed`
  (`src/background/operations.ts:892-899`).

Route changes: `handleRouteChanged` compares `previous.groupId` to
`payload.groupId`; on an actual group change with an active operation it cancels
with `chat_changed` **and** `notifyDiscard = true` (emitting
`operation:discarded`); an unchanged `routeNonce`-only update just records the
route and refreshes state (`src/background/operations.ts:616-634`). The
`routeNonce` from the start payload is stored on the `ActiveOperation` and in
`tabContexts` (`src/background/operations.ts:1243,1255-1259`) but is not
re-consulted to gate chunks.

Cancellation mechanics live in `OperationRegistry.cancelFeature`
(`src/background/operation-registry.ts:109-123`): it adds the operation id to
`cancelledFeatureOperationIds`, aborts the operation's `AbortController`, runs
the cleanup (`clearFlushTimer`), and removes the tab entry. The aborted
`streamFeature` throws an `AbortError` that the catch block swallows because
`consumeCancelledFeature(operationId)` returns true
(`src/background/operations.ts:2400-2401`). `cancelOperation`
(`src/background/operations.ts:932-951`) optionally emits `operation:discarded`
with the last-known spend and profiler. A completed op is cleared via
`completeFeature`, which also removes the id from the cancelled set
(`operation-registry.ts:141-154`). `isBusy` (active feature OR active compare OR
reserved) is what blocks a second start (`operation-registry.ts:73-79`).

Ports disconnecting or tabs being removed both cancel the active operation
(`src/background/operations.ts:443-448`, `485-491`).

## Timeouts & profiling

`OperationTimeoutController<Key>` (`src/background/operation-timeouts.ts`) owns a
single `AbortController` and a map of named `setTimeout` handles; `arm(key, ms)`
(re)schedules a handle that aborts the shared signal when it fires; `clear`,
`clearAll` tear them down (`operation-timeouts.ts:9-32`). That signal is merged
with the cancellation controller via `AbortSignal.any`
(`src/background/operations.ts:1231-1236`).

Timeout keys and values (`src/background/operations.ts:153-165`;
`src/shared/constants.ts:69-73`):

- Quick features: one `quick-total` = `QUICK_OPERATION_TIMEOUT_MS` (60 s) armed
  up front (`operations.ts:1229`).
- Deep features: `deep-prep` = `DEEP_OPERATION_PREP_TIMEOUT_MS` (180 s) covers
  everything through prep; at TTFB it is cleared and `llm-ttfb` =
  `DEEP_OPERATION_LLM_TTFB_TIMEOUT_MS` (45 s) is armed; once provider activity
  starts, `llm-ttfb` is cleared and `llm-idle` =
  `DEEP_OPERATION_LLM_IDLE_TIMEOUT_MS` (45 s, reset on each activity) plus
  `llm-max-stream` = `DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS` (300 s) are armed
  (`operations.ts:1197-1225`, `2158-2175`). All are no-ops for quick features.

A one-shot transparent retry: when the gateway reports `service_unavailable`
and nothing has streamed yet, the loop waits `AUTO_RETRY_SERVICE_UNAVAILABLE_MS`
(5 s), surfaces a "Provider unavailable. Retrying…" progress frame (with
`statusCode`/`retryAtMs`), re-arms the TTFB timeout, and retries once
(`src/background/operations.ts:159`, `2245-2299`).

Profiling (`operation-profiling.ts`) is fully disabled unless
`settings.debugMode` is on — `createOperationProfiler(false)` returns an
all-no-op profiler (`operation-profiling.ts:60-75`). When enabled it records
timestamped log entries and per-stage timings (`startStage`/`completeStage`/
`failStage`/`skipStage`) plus LLM usage/cost and the reasoning block, exposed
via `snapshot()` (`operation-profiling.ts:109-224`). Stage keys:
`resolve-identity`, `summary-cache-check`, `load-messages`, `ping-analysis`,
`group-lookup`, `account-name-lookup`, `earnings`, `subscription-lookup`,
`prompt-build`, `llm-ttfb`, `llm-stream` (`src/shared/types.ts:604-615`). The
snapshot rides on `operation:progress`, `operation:complete`, `operation:error`,
and `operation:discarded` frames only when present
(`src/background/operations.ts:798-853`). `finalizeRunningStages` closes any
still-running stages as `failed` on the error path
(`operation-profiling.ts:202-224`; called at `operations.ts:2403`).

## conversation-context-loader.ts (`loadMediaPurchaseEvidence`)

Despite older descriptions, the current
`src/background/conversation-context-loader.ts` does **not** fetch an Agency Hub
fan profile — the hub fan-profile prefetch is `prefetchAgencyHubSummary` inside
`operations.ts` (`src/background/operations.ts:1025-1086`). The module's sole
export, `loadMediaPurchaseEvidence`
(`conversation-context-loader.ts:15-68`), returns PPV purchase evidence used
when normalizing the transcript:

- Returns `{}` immediately when there is no `fanAccountId`
  (`conversation-context-loader.ts:30-32`).
- Builds inline evidence from the message pages
  (`buildPurchaseEvidence`) and collects PPV attachments still unverified
  (`collectUnverifiedPpvAttachmentRequests`); returns `{}` when none are
  outstanding (`conversation-context-loader.ts:34-38`).
- Caps outstanding requests at `FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT` (10),
  tracking `capOverflow` (`conversation-context-loader.ts:40-41`;
  `src/shared/constants.ts:32`).
- Calls `fanslyClient.verifyMediaPurchaseStates` and merges the result,
  marking `verificationIncomplete` when the verifier said so or when the cap
  overflowed (`conversation-context-loader.ts:43-55`).
- Fails open: a rejected verification (unless the signal aborted) is logged and
  returns `{ verificationIncomplete: true }`
  (`conversation-context-loader.ts:56-67`).

## Fan-summary → Agency Hub push

The push side runs only for `fan-summary` and only when the hub client is
configured (`enqueueAgencyHubSummarySync`,
`src/background/operations.ts:966-972`). `syncAgencyHubSummary`
(`src/background/operations.ts:1088-1146`) runs under a
`AGENCY_HUB_SYNC_TIMEOUT_MS` (10 s) abort, resolves the creator username and the
fan account id (`resolveFanAccountIdForSync` re-reads the group when needed,
`src/background/operations.ts:1005-1023`), then calls
`agencyHubClient.pushFanProfile` with the summary body, page username, fan
`platformUserId`, `existingSync`, and `generatedAt`. The result is mapped to a
`FanSummarySyncStatus` (`saved`/`not-set-up`/`failed`,
`src/background/operations.ts:268-306`), persisted onto the cache entry **only
when its `generatedAt` still matches** (`persistSummarySyncStatus`,
`src/background/operations.ts:974-991`), and pushed to the panel as a
`summary:syncStatus` frame (`src/background/operations.ts:785-796`, `1145`). A
thrown sync (e.g. timeout) yields a `failed` status with a `hub_timeout` error
and never blocks the already-emitted completion
(`src/background/operations.ts:1125-1133`).

The pull side, `prefetchAgencyHubSummary`
(`src/background/operations.ts:1025-1086`), runs under
`AGENCY_HUB_PREFETCH_TIMEOUT_MS` (5 s), calls
`agencyHubClient.fetchFanProfileByConversation`, and on a `fetched` result
returns the summary body + `generatedAt` + a `saved` sync status + the fan
account id. It is used both at fan-summary start (step 10) and opportunistically
by `prefetchAvailableSummary` to populate `tab:state` availability
(`src/background/operations.ts:695-779`).

## Acceptance events emitted

Acceptance telemetry is optional (the `acceptance` collaborator) and rides the
capture lane. Correlation context is remembered per operation on the `onMeta`
frame (`operationId`, gateway `requestId`, `feature`, `pageLabel`,
`conversationRef`) via `rememberAcceptanceContext`
(`src/background/operations.ts:2214-2220`, `398-409`). Events enqueued:

- `shown` — on the first streamed text chunk
  (`src/background/operations.ts:2195-2203`).
- `copied` / `inserted` — when the content script sends an
  `operation:acceptance` port message; the remembered context is looked up by
  `operationId` and merged with `action` + `at`
  (`src/background/operations.ts:515-525`).

The `AcceptanceReporter` (`acceptance-reporter.ts`) spools events to
`storage.local` (bounded, drop-oldest with a persisted dropped counter),
debounces flushes, and posts them as `kind: 'ai_acceptance'` observations to the
hub; a 400 drops the batch loudly, transient errors retry up to `MAX_ATTEMPTS`
(`acceptance-reporter.ts:1-218`). Failed and route-change-discarded operations
do **not** emit acceptance events (only `shown`, which requires a streamed
chunk, plus explicit copy/insert) — confirmed by
`tests/operations.test.ts:4039` ("does not report failed operations") and
`tests/operations.test.ts:4065` ("does not report discarded operations").

## Frames emitted (background → content)

All emitted through `send` → `port.postMessage`
(`src/background/operations.ts:781-783`); validated shape at
`src/shared/protocol.ts:215-268`:

- `operation:progress` — phase (`loading-messages`/`generating`/…), optional
  `currentPage`/`targetPages`/`message`/`statusCode`/`retryAtMs`, optional
  `llmSpend`, optional `profiling` (`sendProgress`,
  `src/background/operations.ts:798-811`).
- `operation:chunk` — buffered streamed text, flushed every
  `STREAM_CHUNK_FLUSH_MS` (50 ms) via `scheduleChunkFlush`/`flushChunks`
  (`src/background/operations.ts:855-882`; `src/shared/constants.ts:78`).
- `operation:complete` — `result: FeatureResult`, `fanDisplayName`, optional
  `llmSpend` + `profiling` (`sendComplete`,
  `src/background/operations.ts:813-825`).
- `operation:error` / `operation:discarded` — `UserFacingError` + optional
  spend/profiling (`sendError`/`sendDiscarded`,
  `src/background/operations.ts:827-853`).
- `operation:debugPrompt` — only in debug; the context snapshot with the
  system/user blocks marked `[assembled kernel-side]`
  (`src/background/operations.ts:2097-2118`).
- `summary:syncStatus` — the fan-summary hub sync status
  (`src/background/operations.ts:785-796`).
- `tab:state` / `settings:changed` / `mapping:changed` — `TabUiState`, where
  `hasApiKey` is `kernelGateway.isConfigured(settings)` (i.e. hub transport up,
  not a vendor key) (`buildTabUiState`,
  `src/background/operations.ts:636-674`, esp. `667`).

## Error surface (CG error keys raised by the engine)

Raised as `ChatGooseError` and delivered as `UserFacingError` on
`operation:error`/`operation:discarded`:

- `another_operation` — tab busy / reservation lost
  (`src/background/operations.ts:1168`, `1184`).
- `chat_changed` — URL/group mismatch at validate, route change, or an abort
  while inactive (`src/background/operations.ts:898`, `627`, `1154`;
  `operation-utils.ts:41-43`).
- `hub_missing_api_key` — kernel lane not configured
  (`src/background/operations.ts:907`; `kernel-feature-gateway.ts:142`).
- `no_personalities` / `not_connected` / `session_expired` — validate failures
  (`src/background/operations.ts:909-917`).
- `no_mapping` — no personality mapped to the account
  (`src/background/operations.ts:1435`, `1442`).
- `unknown_error` — draft-requiring feature with empty draft
  (`src/background/operations.ts:1446`).
- `not_enough_history` / `hi_too_many_messages` / `ping_blocked` — feature gates
  (`src/background/operations.ts:1720`, `1727`, `1754`), also mapped from kernel
  400 gate messages (`kernel-feature-gateway.ts:70-79`).
- `hub_page_match_failed` — no hub page label for the creator username
  (`src/background/operations.ts:2069`).
- `ai_output_unusable` — `max_tokens` on a reply feature or an empty
  insertable result (`src/background/operations.ts:2330`, `368`).
- `timed_out` / `network_error` — mapped from aborts by
  `resolveAbortChatGooseError` (`operation-utils.ts:29-46`).
- Gateway-mapped: `service_unavailable` (retried once), `rate_limited`,
  `hub_invalid_api_key`, `hub_request_failed` — from
  `kernel-feature-gateway.ts:82-115` (`hub_request_failed` also on a stream that
  ends without `done`, `kernel-feature-gateway.ts:226-232`).
