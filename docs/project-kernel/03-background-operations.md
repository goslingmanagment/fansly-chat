# Background — Operation Engine

## Scope

This map covers the six files of the background operation engine, read in full from source:

- `src/background/operations.ts` (~2666 lines) — `OperationCoordinator`, the class that owns the runtime `Port` per tab and drives every single-feature operation end to end.
- `src/background/operation-registry.ts` — `OperationRegistry`, in-flight/cancelled/reserved bookkeeping shared by feature + compare paths.
- `src/background/operation-timeouts.ts` — `OperationTimeoutController`, per-phase abort timers behind one `AbortSignal`.
- `src/background/operation-profiling.ts` — `createOperationProfiler` / `OperationProfiler`, timing + stage + LLM-usage snapshots attached to progress.
- `src/background/operation-cleanup.ts` — `clearFlushTimer` / `clearFlushTimers`, chunk-flush timer teardown helpers.
- `src/background/operation-utils.ts` — free functions: `parseGroupIdFromUrl`, `errorCode`, `resolveAbortChatGooseError`, `describeMessageLoadProgress`, `describeSubscriptionTraceStep`.

The Multi/compare path (`compare:*` messages) is delegated to `src/background/compare-operations.ts` and is out of scope here except where `operations.ts` hands off to it (`getCompareContext`, `startCompare`, `cancelCompare`).

External boundary contract tables live in `docs/project-kernel/boundaries.md`. This document does not re-derive those tables; it records how these files touch each boundary.

---

## Role in the system

`OperationCoordinator` is constructed once in the composition root `background/index.ts:27` and wired to seven dependencies (see below). `background/index.ts` calls exactly five of its public methods:

| Caller (`background/index.ts`) | Method | Trigger |
|---|---|---|
| `browser.runtime.onConnect` (`index.ts:37`) | `registerPort(port)` | content script opens the long-lived Port |
| `initializeSessionCapture` callback (`index.ts:43`) | `handleCapture(tabId, accountId)` | webRequest auth sniff resolved an account id |
| `browser.tabs.onRemoved` (`index.ts:55`) | `handleTabRemoved(tabId)` | tab closed |
| `browser.storage.onChanged` (`index.ts:73`) | `refreshAllTabs('settings:changed')` | any UI-relevant storage key changed |

`refreshTabState` is only reachable indirectly (through the four above and internal handlers). No other module imports `OperationCoordinator`.

### Constructor dependencies (`operations.ts:461-469`)

Injected, all `private readonly`:

1. `sessionStore: SessionStore` — tab→account/session mapping.
2. `tabContexts: TabContextStore` — per-tab route/account/fan/active-op state.
3. `fanslyClient: FanslyClient` — Fansly REST boundary.
4. `llmClient: LlmClient` — Anthropic/OpenRouter streaming boundary.
5. `storageCoordinator: StorageCoordinator` — `browser.storage.local` boundary + summary cache.
6. `agencyHubClient: AgencyHubClient` — Agency Hub ("core") boundary.
7. `agencyHubUsageReporter: Pick<AgencyHubUsageReporter, 'enqueue'>` — batched AI-usage reporting.

---

## `src/background/operations.ts`

### Imports (who this file depends on)

Shared modules: `../shared/agency-hub.js`, `../shared/constants.js`, `../shared/concurrency.js` (`mapWithConcurrency`), `../shared/feature-readiness.js`, `../shared/earnings.js`, `../shared/compare-cards.js`, `../shared/errors.js` (`ChatGooseError`, `createUserError`, `toDebugErrorPayload`, `toUserError`), `../shared/features.js`, `../shared/log.js` (`logDebug`), `../shared/model-registry.js`, `../shared/prompts.js` (`buildPromptRequest`), `../shared/protocol.js` (`isContentPortMessage`), `../shared/reply-output.js`, `../shared/summary-cache.js`, `../shared/subscriptions.js`, `../shared/transcript.js`, `../shared/xml.js`, `../shared/types.js` (types only).

Background modules: `./agency-hub-client.js`, `./agency-hub-usage-reporter.js` (type only), `./llm-cost.js`, `./compare-operations.js`, `./conversation-context-loader.js` (`loadMediaPurchaseEvidence`), `./fansly-client.js`, `./llm-client.js` (type only), `./operation-cleanup.js` (`clearFlushTimer`), `./operation-profiling.js`, `./operation-registry.js`, `./operation-timeouts.js`, `./operation-utils.js`, `./session-store.js`, `./storage-coordinator.js`, `./tab-context.js`.

### Module-level constants and types

- `NO_OP_PROFILER = createOperationProfiler(false)` (`operations.ts:161`) — shared disabled profiler used as default arg for `sendProgress`/`sendComplete`/`sendError`/`sendDiscarded`.
- `CAPTURE_IDENTITY_TIMEOUT_MS = 5_000` (`:162`) — cap on background identity resolution triggered by capture.
- `DEEP_OPERATION_TIMEOUTS` (`:163-168`) — `{ prep, llmTtfb, llmIdle, llmMaxStream }`, sourced from `constants.ts` (`180_000 / 45_000 / 45_000 / 300_000` ms).
- `AUTO_RETRY_RATE_LIMIT_MAX_MS = 60_000` (`:169`) — a rate-limit auto-retry is only taken when `retryAfterMs <= 60s`.
- `AUTO_RETRY_SERVICE_UNAVAILABLE_MS = 5_000` (`:170`) — fixed backoff before a `service_unavailable` retry.
- `OperationTimeoutKey` (`:171-176`) — `'quick-total' | 'deep-prep' | 'llm-ttfb' | 'llm-idle' | 'llm-max-stream'`.
- `ActiveOperation` (`:146-159`) — the in-flight record: `operationId, tabId, feature, groupId, routeNonce, startedAtMs, controller: AbortController, rawText, flushBuffer, flushTimer: number|null, llmSpend: LlmSpendSummary|null, profiler`.
- `ValidatedOperationStart` (`:178-185`) — `{ tab, urlGroupId, storage, session, legacyAccountId, messageCount }` returned by `validateStart`.
- `OperationPromptRequestArgs` (`:187-200`), `AgencyHubSummarySyncTask` (`:230-241`), `AgencyHubSummaryPrefetchResult` (`:243-248`) — internal shapes.

### Module-level helper functions

- `buildLlmSpendPayload(llmSpend?)` (`:202-206`) — returns `{ llmSpend }` or `{}`; spread into every Port message that carries spend.
- `hasApiKeyForSelectedModel(settings, feature)` (`:208-228`) — resolves the model for the feature via `resolveFeatureModelFeature` + `getModelEntry`; returns `{ ok, provider? }`. If no model entry, `ok` is true when either `claudeApiKey` or `openRouterApiKey` is set. Anthropic requires `claudeApiKey`; openrouter requires `openRouterApiKey`; any other provider → `ok:false`.
- `delay(ms, signal)` (`:250-273`) — abortable sleep; rejects with `DOMException('Aborted','AbortError')` on abort; resolves immediately if `ms<=0`. Used between LLM auto-retries.
- `createFanSummarySyncStatus(state, generatedAt, options?)` (`:275-298`) — builds a `FanSummarySyncStatus`, normalizing baseUrl via `normalizeAgencyHubBaseUrl` and trimming pageLabel.
- `shouldAttemptAgencyHubSummarySync(agencyHubClient, settings, summary)` (`:300-310`) — true when hub `isConfigured`, summary non-empty, and `measureUtf8Bytes(summary) <= AGENCY_HUB_PROFILE_MAX_BYTES`.
- `resolveSummarySyncStatusFromResult(result, generatedAt)` (`:312-350`) — maps `AgencyHubPushFanProfileResult.status` (`pushed`/`already-synced`→`saved`; `skipped`→`not-set-up` for `missing_base_url|missing_api_key|missing_host_permission|disabled` else `failed`; `failed`→`failed`).
- `resolveSummarySyncStatusFromHubFetch(result, generatedAt)` (`:352-363`) — always `saved` (a fetched-from-hub summary is by definition already stored).
- `usesDeepOperationTimeouts(feature)` (`:365-367`) — `getFeaturePolicy(feature).timeoutBucket === 'deep'`. Deep features per `features.ts`: `fan-summary`, `chat-review`. All others (`fast-reply`, `improve-draft`, `help-me`, `ping`, `hi-greeting`) are `quick`.
- `buildOperationPromptRequest(args)` (`:369-399`) — thin wrapper over `buildPromptRequest` (`shared/prompts.ts`), passing `promptCachingEnabled` separately.
- `buildFeatureResult(feature, rawText, replyMode?)` (`:401-433`) — switches on `getFeaturePolicy(feature).resultKind`: `help-me`→`parseHelpMeXml`; `chat-review`→`parseChatReviewXml`; `single-reply`→`normalizeSingleReplyPart`; `summary`→`{rawText}` only; `reply`→`normalizeVariantReplyParts` for `hi-greeting` else `normalizeReplyParts`, adding `splitModeRequested: replyMode==='preferSplit'` when the policy `supportsReplyMode`.
- `assertInsertableFeatureResult(feature, result)` (`:435-446`) — throws `ChatGooseError('ai_output_unusable')` when a `reply`/`single-reply` result produced zero `parts`.

### `OperationCoordinator` — instance state (`:449-459`)

- `portsByTabId: Map<number, browser.runtime.Port>` — the one live Port per tab.
- `lifecycle: OperationRegistry<ActiveOperation, ActiveCompareOperation>` — single source of truth for active feature ops, active compare ops, cancelled-id sets, and tab reservations.
- `pendingSummaryAvailabilityByKey: Map<string, Promise<void>>` — dedups concurrent summary prefetches; key = `tabId|groupId|personality.id|personality.updatedAt|modelId`.
- `pendingIdentityResolutionByLegacyAccountId: Map<string, { promise, waitingTabIds: Set<number> }>` — dedups capture-time identity resolution across tabs sharing a legacy account id.

Private getters (`:471-489`) expose the registry's internal maps/sets under the coordinator's original names: `activeByTabId`, `activeCompareByTabId`, `cancelledOperationIds`, `cancelledCompareOperationIds`, `startingTabIds`.

### Public methods

#### `registerPort(port)` (`:491-509`)
- Reads `port.sender?.tab?.id`; bails silently if absent.
- Stores port in `portsByTabId`.
- `onMessage`: for each message, if `isContentPortMessage(message)` → `void handlePortMessage(tabId, message)`.
- `onDisconnect`: only acts if the stored port is still this exact port (`:504`), then deletes it, `void cancelOperation(tabId)`, `cancelCompare(tabId)`.

#### `refreshTabState(tabId, messageType='tab:state')` (`:511-527`)
- Looks up the port; returns if none.
- Builds `TabUiState` via `buildTabUiState` and posts `{ type: messageType, state }` (a `TabStatePayload`; `messageType` ∈ `'tab:state' | 'settings:changed' | 'mapping:changed'`).
- If `!state.hasAvailableSummary`, fires `void prefetchAvailableSummary(tabId)` (best effort).

#### `refreshAllTabs(messageType='settings:changed')` (`:529-537`)
- `Promise.all` over all known tab ids calling `refreshTabState`. Default message type differs from `refreshTabState`'s default.

#### `handleCapture(tabId, accountId)` (`:539-543`)
- `tabContexts.setAccount(tabId, accountId)` → `refreshTabState(tabId)` → `void resolveCapturedIdentity(tabId, accountId)`.

#### `handleTabRemoved(tabId)` (`:545-551`)
- `await cancelOperation(tabId)`, `cancelCompare(tabId)`, `sessionStore.forgetTab(tabId)`, `tabContexts.remove(tabId)`, `portsByTabId.delete(tabId)`.

### Port message routing — `handlePortMessage` (`:553-592`)

Switch on `ContentPortMessage.type`:

| Incoming (`ContentPortMessage`) | Handler |
|---|---|
| `tab:init` | `tabContexts.setRoute(tabId, message.groupId, message.routeNonce)`; `tabContexts.setAccount(tabId, sessionStore.getAccountIdForTab(tabId))`; `refreshTabState(tabId,'tab:state')` |
| `tab:routeChanged` | `handleRouteChanged(tabId, message)` |
| `operation:start` | `startOperation(tabId, message)` |
| `compare:start` | `startCompare(tabId, message)` → `compare-operations.executeCompare` |
| `operation:cancel` | if the active feature op's `operationId` matches → `cancelOperation(tabId)` |
| `compare:cancel` | if the active compare op matches → `cancelCompare(tabId)` |

### Capture-time identity resolution — `resolveCapturedIdentity` (`:594-663`)

- No-op on empty `legacyAccountId`.
- If a resolution is already pending for that legacy id, this tab joins `waitingTabIds` and awaits the shared promise.
- Otherwise starts a task: if `sessionStore.getSessionByAccount(legacyAccountId)` is missing or already has `resolvedAccountId`, returns.
- Creates an `AbortController` aborted after `CAPTURE_IDENTITY_TIMEOUT_MS` (5s). Calls `fanslyClient.getAuthenticatedAccountId(session, signal)` (**Fansly REST boundary**), then `storageCoordinator.rekeyAccountIdentity(legacy, resolved)` (**storage boundary**).
- Broadcasts `refreshTabState(waitingTabId,'mapping:changed')` to every waiting tab; if the rekey migrated mappings / conflicted / changed known accounts, additionally `refreshAllTabs('mapping:changed')`.
- All failures swallowed ("best effort"). `finally` removes the pending entry from `pendingIdentityResolutionByLegacyAccountId`.

### Route change — `handleRouteChanged` (`:665-683`)

- Compares `previous.groupId` vs `payload.groupId`; sets new route via `tabContexts.setRoute`.
- If group changed **and** a feature op is active → `cancelOperation(tabId, new ChatGooseError('chat_changed'), notifyDiscard=true)` (emits `operation:discarded`).
- If group changed **and** a compare op is active → `cancelCompare(tabId, ChatGooseError('chat_changed'), true)`.
- Always ends with `refreshTabState(tabId,'tab:state')`.

### `buildTabUiState(tabId)` (`:685-724`) — **storage read**

Assembles `TabUiState`:
- `storageCoordinator.getState()`, `tabContexts.getOrCreate(tabId)`, `sessionStore.getSessionForTab(tabId)`.
- `legacyAccountId = sessionStore.getAccountIdForTab(tabId) ?? context.accountId`; `accountId = session?.resolvedAccountId ?? legacyAccountId`; writes it back with `tabContexts.setAccount`.
- `mappedPersonalityId` via `resolveMappedPersonalityId(accountMappings, accountId, legacyAccountId, accountAliases)`; `mappedPersonalityName` looked up in `storage.personalities`.
- Fields: `hasAvailableSummary` (`hasAvailableFanSummary(storage, groupId, mappedPersonalityId)`), `connected`, `hasApiKey` (either API key present), `modelProviderByFeature` (`buildModelProviderByFeature`), `apiKeyReadyByFeature` (`buildApiKeyReadyByFeature`), `hasPersonalities`, `mappedPersonalityId/Name`, `compareCardCount = getCompareDraftCount() + (mappedPersonalityId?1:0)`, `compareDraftCount`.

### Summary prefetch (background) — `prefetchAvailableSummary` / `cachePrefetchedSummary`

- `cachePrefetchedSummary(groupId, personality, modelId, prefetched)` (`:726-743`) — writes a full `SummaryCacheEntry` via `storageCoordinator.saveSummaryCache` marking `spendingDataVerified:true, subscriptionLookupVerified:true`, carrying `fanAccountId` and `agencyHubSync` from the hub fetch (**storage write**).
- `prefetchAvailableSummary(tabId)` (`:745-829`) — only proceeds when: groupId present, session connected, a `mappedPersonalityId` resolves to a real personality, and no available summary already exists. Dedups on `key`. The task calls `prefetchAgencyHubSummary(...)` with a fresh (never-aborted) `AbortController().signal`; on hit, caches it (unless a live `fan-summary` op for the same group is running) and, if the tab is still on the same group, `refreshTabState(tabId,'tab:state')`.

### Port emit helpers

- `send(tabId, message)` (`:831-833`) — `portsByTabId.get(tabId)?.postMessage(message)` (silent no-op if no port).
- `sendSummarySyncStatus(tabId, groupId, syncStatus)` (`:835-846`) — emits **`summary:syncStatus`** `{ groupId, generatedAt, syncStatus }`.
- `sendProgress` (`:848-861`) — emits **`operation:progress`** merging the `OperationProgressPayload`, optional `llmSpend`, and `profiler.snapshot()` under `profiling` (only if snapshot is defined).
- `sendComplete` (`:863-875`) — posts the given `CompletePayload` plus spend + profiling.
- `sendError` (`:877-889`) — posts the given `ErrorPayload` plus spend + profiling.
- `sendDiscarded` (`:891-903`) — posts the given `DiscardedPayload` plus spend + profiling.

All four attach spend via `buildLlmSpendPayload` and default `profiler` to `NO_OP_PROFILER` (snapshot returns `undefined`, so no `profiling` key when profiling is off).

### AI-usage reporting

- `buildAiUsageEvent({...})` (`:905-942`) — constructs an `AgencyHubAiUsageEvent`: maps model via `getAgencyHubModelId(model)`, copies `inputTokens/outputTokens/cacheWriteTokens/cacheReadTokens` from `spend`, `conversationId`, `durationMs = max(0, completedAtMs - startedAtMs)` (or null), `isCacheHit`, `isRegeneration`, `completedAt = new Date(completedAtMs).toISOString()`.
- `enqueueCompletedOperationUsage(settings, event)` (`:944-949`) — `agencyHubUsageReporter.enqueue(settings, event)` (settings narrowed to `agencyHubBaseUrl | agencyHubApiKey | debugMode`). Downstream this batches to **`POST api/v1/ai-usage/batch`** on the Agency Hub boundary.

### Streaming chunk flushing

- `flushChunks(tabId, operation)` (`:951-965`) — if `flushBuffer` empty, clears `flushTimer` and returns; otherwise drains the buffer and emits **`operation:chunk`** `{ operationId, text }`.
- `scheduleChunkFlush(tabId, operation)` (`:967-978`) — arms one `setTimeout(STREAM_CHUNK_FLUSH_MS=50ms)` if none pending; coalesces stream deltas into ~50ms batches.

### Start validation — `validateStart(tabId, payload)` (`:980-1030`)

- `Promise.all([browser.tabs.get(tabId), storageCoordinator.getState()])` (**browser-api + storage**).
- `urlGroupId = parseGroupIdFromUrl(tab.url)`. Throws `ChatGooseError('chat_changed')` unless the URL contains `fansly.com`, a groupId parsed, and it equals `payload.groupId`.
- Gets `session` / `legacyAccountId` from `sessionStore`.
- Throws in order: `missing_api_key` (with `details.provider` when known) if no key for the selected model; `no_personalities` if empty; `not_connected` if no session/account; `session_expired` if `!session.connected`.
- Returns `messageCount = resolveFeatureMessageCount(feature, settings)`.

### Cancellation / completion bookkeeping

- `cancelOperation(tabId, error?, notifyDiscard=false)` (`:1032-1051`) — `lifecycle.cancelFeature(tabId, clearFlushTimer)` (adds op id to cancelled set, aborts its controller, clears flush timer, removes from active map). If nothing was active, returns. Clears `tabContexts.setActiveOperation(tabId, null)`. When `notifyDiscard`, emits **`operation:discarded`** `{ operationId, error: toUserError(error ?? chat_changed) }` with the op's `llmSpend` (or zero) and its profiler.
- `clearCompletedOperation(tabId)` (`:1053-1060`) — `lifecycle.completeFeature(tabId, clearFlushTimer)` (removes from active map, drops id from cancelled set), then `setActiveOperation(null)`.
- `getActive(tabId)` (`:1062-1064`) — `lifecycle.getFeature(tabId)`.
- `assertActive(tabId, operationId)` (`:1248-1257`) — returns the active op or throws `ChatGooseError('chat_changed')` if missing/mismatched. Used as a staleness gate after each `await` boundary.

### Agency Hub summary sync (fan-summary only)

- `enqueueAgencyHubSummarySync(task)` (`:1066-1072`) — no-op unless `agencyHubClient.isConfigured(settings)`; otherwise fire-and-forget `void syncAgencyHubSummary(task)`.
- `persistSummarySyncStatus(groupId, generatedAt, syncStatus, fanAccountId?)` (`:1074-1091`) — `storageCoordinator.updateSummaryCache`; only mutates the entry when `entry.generatedAt === generatedAt` (guards against a newer summary racing in) (**storage write**).
- `resolveCreatorUsername(session, signal)` (`:1093-1103`) — returns `session.resolvedUsername` if present, else `fanslyClient.getAuthenticatedAccount(session, signal).username` (**Fansly REST**).
- `resolveFanAccountIdForSync(groupId, session, resolvedAccountId, fanAccountId, signal)` (`:1105-1123`) — returns the cached `fanAccountId` if set, otherwise `fanslyClient.getGroup(groupId,...)` and picks the first `user.userId !== resolvedAccountId` (**Fansly REST**).
- `prefetchAgencyHubSummary(groupId, settings, session, signal, debugEnabled)` (`:1125-1186`) — returns `null` unless hub configured. Arms a 5s timeout (`AGENCY_HUB_PREFETCH_TIMEOUT_MS`) combined with the caller signal via `AbortSignal.any`. Calls `agencyHubClient.fetchFanProfileByConversation({ settings, pageUsername, conversationId: groupId, signal })` (**Agency Hub: GET .../conversations/{convId}/profile**). Re-checks `signal.aborted` and rethrows AbortError. Returns `{ summary, generatedAt (= createdAtMs ?? now), syncStatus (saved), fanAccountId }` only when `status==='fetched' && body`. Non-abort errors are logged and swallowed (returns null). Clears the timeout in `finally`.
- `syncAgencyHubSummary(task)` (`:1188-1246`) — arms a 10s timeout (`AGENCY_HUB_SYNC_TIMEOUT_MS`). Resolves creator username + fan account id, then `agencyHubClient.pushFanProfile({ settings, pageUsername, platformUserId, body: summary, existingSync, generatedAt })` (**Agency Hub: PUT .../fans/{platformUserId}/profile**). Maps result → sync status; on thrown error uses `createFanSummarySyncStatus('failed', ..., { error: createUserError('hub_timeout') })`. Then `persistSummarySyncStatus(...)` (**storage**) and `sendSummarySyncStatus(...)` (**`summary:syncStatus` Port emit**).

### The main lifecycle — `startOperation(tabId, payload)` (`:1259-2636`)

This is the operation engine's core. Phases below correspond to `OperationPhase` values (`'idle' | 'loading-messages' | 'loading-earnings' | 'generating' | 'completed' | 'cancelled' | 'error'`) as reported in progress. NOTE (discrepancy): the code never emits the phase strings `'loading-earnings'`, `'completed'`, `'cancelled'`, or `'idle'` in `startOperation` — it only ever sets `phase` to `'loading-messages'` and `'generating'`. Earnings loading happens while the reported phase is still `'generating'` (the phase is switched to `'generating'` at `:1932-1937` before earnings fetch begins at `:1946`). Completion/cancellation/error are conveyed by distinct message *types* (`operation:complete` / `operation:discarded` / `operation:error`), not by a phase value.

Step-by-step:

1. **Concurrency guard** (`:1263-1287`): if `lifecycle.isBusy(tabId)` → emit `operation:error` with `ChatGooseError('another_operation')` and return (comment: "SPEC-CORRECT: BLOCK concurrent ops (don't auto-cancel like Codex)"). Requires a live port. Then `lifecycle.reserve(tabId)` synchronously **before the first await**; if reservation fails (a race), emits `another_operation` and returns. The reservation is released in the outer `finally` (`:2632-2635`).

2. **Validation** (`:1292`): `validateStart` (see above). `debugEnabled = storage.settings.debugMode`; `profiler = createOperationProfiler(debugEnabled)`.

3. **Timeout wiring** (`:1295-1336`): creates an `OperationTimeoutController<OperationTimeoutKey>`. Local closures:
   - `startLlmTtfbTimeout` — deep only: clear `deep-prep`, arm `llm-ttfb` (45s).
   - `startLlmStreamTimeouts` — deep only: clear `llm-ttfb`, arm `llm-idle` (45s) + `llm-max-stream` (300s).
   - `resetLlmIdleTimeout` — deep only: re-arm `llm-idle`.
   - `clearLlmTimeouts` — clear all three llm keys.
   - Initial arm: deep features arm `deep-prep` (180s); quick features arm `quick-total` (60s).
   - The combined abort signal = `AbortSignal.any([operationController.signal, operationTimeoutController.signal])` (`:1331-1336`). This `signal` is threaded into **every** Fansly/LLM/hub call in the operation.

4. **Activate** (`:1338-1359`): build the `ActiveOperation` record and `lifecycle.activateFeature(tabId, active)`, `tabContexts.setActiveOperation(tabId, operationId)`, `tabContexts.setRoute(tabId, urlGroupId, routeNonce)`.

5. **Progress plumbing** (`:1361-1468`): mutable `progressPhase` (init `'loading-messages'`), `progressMessage` (init `'Loading messages…'` only when `featureUsesPingSegment`), plus `currentPage/targetPages/statusCode/retryAtMs`. `sendOperationProgress(updates?)` merges updates into the running state and calls `sendProgress` with the op's current `llmSpend` and the profiler. `sendDebugProgress` only sends when `profiler.enabled`. `startStage/completeStage/failStage/skipStage` wrap the profiler and emit a debug progress. An initial `sendOperationProgress()` is sent at `:1468`.

6. **Stage `resolve-identity`** (`:1470-1507`): `fanslyClient.getAuthenticatedAccountId(session, signal)` (**Fansly REST**). On success sets `resolvedAccountId` + `authenticatedIdentityResolved=true`. On failure: for ping-segment features it logs "using legacy account id" and continues; for all others it rethrows (aborting the op).

7. **Rekey identity** (`:1509-1527`): `storageCoordinator.rekeyAccountIdentity(legacyAccountId, resolvedAccountId)` (**storage**); `storage = rekeyResult.state`.

8. **Personality resolution** (`:1528-1543`): `resolveMappedPersonalityId(...)`. Throws `ChatGooseError('no_mapping')` if no id or no matching personality.

9. **Draft guard** (`:1545-1547`): `featureRequiresDraft(feature) && !draftText.trim()` → `ChatGooseError('unknown_error')` (applies to `improve-draft`).

10. **Model resolution** (`:1549-1550`): `resolvedModel = settings.featureModels[resolveFeatureModelFeature(feature)]`.

11. **fan-summary cache path** (`:1552-1738`):
    - Stage `summary-cache-check`. `forceRegenerate` → `removeSummaryCache(groupId)` (**storage**) then treat cache as null; else `getSummaryCache(groupId)` and validate with `isValidSummaryCacheEntry(cache, personality.id, personality.updatedAt, resolvedModel)`.
    - **Cache hit** (`:1571-1666`): computes `syncStatus` (reuse if already saved for the current base URL; else `'saving'` + persist + enqueue background sync if `shouldAttemptSync`; else `'not-set-up'`). Emits `operation:complete` with `summaryMeta { generatedAt, stale:false, cached:true, syncStatus }`, zero spend, then `enqueueCompletedOperationUsage(... isCacheHit:true ...)`, `clearCompletedOperation`, and conditionally `enqueueAgencyHubSummarySync`. Returns.
    - **Hub prefetch** (`:1668-1727`): when not forcing, `prefetchAgencyHubSummary(...)`; on hit, `cachePrefetchedSummary`, emit `operation:complete` (`cached:true`, "hub hit"), report usage `isCacheHit:true`, `clearCompletedOperation`, return.
    - Otherwise `completeStage('summary-cache-check','cache miss'...)` and fall through to full generation.

12. **Stage `load-messages`** (`:1740-1776`): `fanslyClient.loadMessages(groupId, messageCount, session, signal, onProgress?)` (**Fansly REST**). Progress reporting is enabled when `profiler.enabled || isDeepFeature(feature)`; deep features stream user-visible `operation:progress` `{ phase:'loading-messages', currentPage, targetPages, message }`, otherwise only debug progress. `describeMessageLoadProgress` formats the profiler log line.

13. **Stage `group-lookup`** (`:1778-1814`): unless the feature is `ping` without a resolved identity, `fanslyClient.getGroup(groupId, session, signal)` (**Fansly REST**) → `groupUsers` filtered to `{userId}`. On error: `failStage` + `logDebug`, continues with `groupUsers=null`. When skipped, `skipStage`.

14. **Fan id + purchase evidence** (`:1816-1842`): `fanAccountId = groupUsers.find(u => u.userId !== resolvedAccountId)?.userId ?? null`. `loadMediaPurchaseEvidence({ fanslyClient, pages, fanAccountId, session, signal, debugEnabled })` (**Fansly REST**, via `conversation-context-loader`). `transcriptMessages = normalizeTranscript(pages, resolvedAccountId, fanAccountId, purchaseEvidence)`.

15. **History guards** (`:1844-1856`): deep feature with `< MIN_MESSAGES_FOR_DEEP (30)` → `ChatGooseError('not_enough_history')`; `hi-greeting` with `> HI_GREETING_MAX_TRANSCRIPT (10)` → `ChatGooseError('hi_too_many_messages')`.

16. **Stage `ping-analysis`** (`:1858-1887`): for ping-segment features, `analyzePingSegment(transcriptMessages, now)`. If `segment === 'active'`, emit `operation:error` `ChatGooseError('ping_blocked')` + `clearCompletedOperation` + return.

17. **Stage `account-name-lookup`** (`:1889-1929`): when `fanAccountId`, `fanslyClient.getAccountNames([fanAccountId], session, signal)` (**Fansly REST**). Resolves `fanDisplayName` from username/displayName/DOM/`'fan'`; for `hi-greeting` also captures `account.about` into `fanBio`. Errors → `failStage`; missing fan id → `skipStage`.

18. **Fan context write + phase → generating** (`:1931-1937`): `tabContexts.setFan(tabId, fanAccountId, fanDisplayName)`; `sendOperationProgress({ phase:'generating', message:'Generating…', currentPage:undefined, targetPages:undefined })`.

19. **Earnings + subscription** (`:1939-2182`): only when `getFeaturePolicy(feature).includesEarnings !== false` and `fanAccountId` present (`ping` sets `includesEarnings:false`). Stages `earnings` + `subscription-lookup` run together. `subscriptionLookupMode='full'` (constant). A trace handler collects `describeSubscriptionTraceStep` labels and profiler logs. `Promise.allSettled` over three Fansly calls:
    - `fanslyClient.getMonthlyEarnings(fanAccountId, 0, windowEndMs, session, signal)`
    - `fanslyClient.getEarnings(fanAccountId, 0, windowEndMs, session, signal)`
    - `fanslyClient.getFanSubscriptionContext(groupId, fanAccountId, session, signal, 'full', traceHandler?)` (trace handler only passed when `profiler.enabled`)

    Earnings are fail-open: if any of stats-aggregated / monthly totals / both-fulfilled hold, builds an `AggregatedEarnings` (falling back to summed monthly totals when the stats call failed), `spendingDataVerified = statsAggregated !== null`. For **deep features with monthly totals**, fetches per-month breakdowns for up to the recent 12 months via `mapWithConcurrency(recentMonths, 4, ...)` → additional `fanslyClient.getEarnings(...)` calls (**Fansly REST**), setting `monthlyBreakdowns` and `monthlyBreakdownsPartial` on failure. `spendingData = formatFanSpendingData(aggregated)`. Subscription: `subscriptionLookupVerified = (mode==='full')` when fulfilled; `subscriptionData = formatFanSubscriptionData(value)`. Both branches log profiler stage details. When skipped, `skipStage` with reason `'not included for this feature'` or `'fan account unavailable'`.

20. **Stage `prompt-build`** (`:2184-2225`): `formatTranscript(transcriptMessages)` → `buildOperationPromptRequest({ feature, personality, transcript, fanSpendingData, fanSubscriptionData, fanDisplayName, fanBio, draftText, pingSegment, replyMode, replyTone, promptCachingEnabled })` yielding `{ prompt, systemBlocks, userBlocks }`. `sendDebugPromptSnapshot(modelId)` (only when `profiler.enabled`) emits **`operation:debugPrompt`** `{ operationId, feature, snapshot: { feature, modelId, system, transcript, fanSpendingData, fanSubscriptionData, user } }`.

21. **LLM streaming** (`:2229-2471`): the heart. State: `sawProviderActivity`, `sawProviderActivityInAttempt`, `sawFirstChunk`, `actualModel` (init `resolvedModel`), `reasoningObserved`, `reasoningDebugText`, `latestLlmStopReason`, `latestLlmSpend`. Stage `llm-ttfb` armed via `startLlmTtfbTimeout()`.
    - `handleLlmUsage(usage)` (`:2243-2264`): `estimateLlmCost(actualModel, usage)` + `buildLlmSpendSummary` → sets `latestLlmSpend`, mutates the live op's `llmSpend`, records profiler usage/cost, `logDebug`, and emits an `operation:progress` (carrying spend) via `sendOperationProgress()`.
    - `markProviderActivity(ttfbDetail)` (`:2266-2283`): on first activity within an attempt, `startLlmStreamTimeouts()`; on first activity overall, completes `llm-ttfb` stage and starts `llm-stream`; subsequent activity re-arms the idle timeout.
    - `streamArgs` (`:2285-2349`): `{ settings, model: actualModel, temperature: FEATURE_TEMPERATURES[feature], systemBlocks, userBlocks, feature, reasoningEffort: settings.featureReasoning[modelFeature], signal, onText, onProgress, onUsage, onReasoningObserved, onReasoningDelta, onStopReason }`.
      - `onText(chunk)` — ignores chunks if the op is no longer active/matching (staleness gate); marks provider activity; appends to `rawText` and `flushBuffer`; `scheduleChunkFlush` (batched `operation:chunk`).
      - `onProgress`, `onUsage`, `onReasoningObserved`, `onReasoningDelta` — all call `markProviderActivity`; reasoning deltas accumulate into `reasoningDebugText` and `profiler.setReasoningBlock` when profiling.
      - `onStopReason(stopReason)` — records `latestLlmStopReason`.
    - **Retry loop** (`:2355-2470`): calls `llmClient.streamMessage({ ...streamArgs, model: actualModel })` (**Anthropic / OpenRouter boundary via `LlmClient`**). On error, extracts `errorKey`, `retryAfterMs`, `retryAtMs`, `code`. Three outcomes:
      - **Rate-limit auto-retry** (`canRetryRateLimit`): only if `!sawFirstChunk && !rateLimitRetried && errorKey==='rate_limited' && retryAfterMs <= 60s`. Clears llm timeouts, emits `operation:progress` `{ phase:'generating', message:'Rate limited. Waiting to retry…', statusCode, retryAtMs }`, `await delay(retryDelayMs, signal)`, resets progress to "Generating…", re-arms TTFB, `continue`.
      - **Service-unavailable auto-retry** (`canRetryServiceUnavailable`): only if `!sawFirstChunk && !serviceUnavailableRetried && errorKey==='service_unavailable'`. Fixed 5s backoff, message `"{providerLabel} unavailable. Retrying…"`, `continue`.
      - **Model fallback** (`:2452-2466`): `errorKey==='model_unavailable' && isAnthropicModelSelection(actualModel) && actualModel !== defaultModel` → switch `actualModel = DEFAULT_FEATURE_MODELS[modelFeature]`, re-emit debug prompt snapshot, reset TTFB timers if nothing streamed, `continue`.
      - Otherwise rethrow.
    - After success: `clearLlmTimeouts()`; completes `llm-stream` or (if no streamed text) completes `llm-ttfb` and skips `llm-stream`.

22. **Finalize stream** (`:2492-2509`): `assertActive` staleness gate; flush any residual buffer; if `latestLlmStopReason==='max_tokens'` and the feature's `promptMode==='reply'` → `ChatGooseError('ai_output_unusable')`. `buildFeatureResult(feature, rawText, replyMode)` then `assertInsertableFeatureResult`.

23. **fan-summary persistence** (`:2511-2542`): builds `summaryMeta` with initial sync status (`'saving'` if `shouldAttemptSync` else `'not-set-up'`). Persists to cache **only when** `spendingDataVerified && subscriptionLookupVerified && actualModel === resolvedModel` — i.e. a fallback model or unverified context prevents caching. `saveSummaryCache` writes `{ summary, personalityId, personalityUpdatedAt, generatedAt, spendingDataVerified:true, subscriptionLookupVerified:true, modelId: resolvedModel, fanAccountId, agencyHubSync }` (**storage write**).

24. **Completion emit** (`:2544-2583`): `operation:complete` `{ operationId, result, fanDisplayName }` with `completedSpend = latestLlmSpend ?? zero` and profiler. Then `enqueueCompletedOperationUsage(...)` (**Agency Hub usage**), `clearCompletedOperation(tabId)`, and for `fan-summary` with `syncStatus.state==='saving'` → `enqueueAgencyHubSummarySync(...)`.

25. **catch block** (`:2584-2631`): resolves `active`/`operationId`. If `lifecycle.consumeCancelledFeature(operationId)` returns true (this op was cancelled) → return silently (suppresses late error). `active?.profiler.finalizeRunningStages('operation failed')`. `resolveAbortChatGooseError(error, { active, timeoutSignal, cancelSignal })` maps AbortErrors: timeout→`timed_out`, cancel/inactive→`chat_changed`, else `network_error`. Emits `operation:error` (mapping to `chat_changed` when there's no active op). Then `logDebug`, `await cancelOperation(tabId)`, and `lifecycle.forgetCancelledFeature(operationId)` (comment explains cancelOperation re-added the id; the terminal path drops it to keep the set bounded).

26. **finally** (`:2632-2635`): `lifecycle.releaseReservation(tabId)`, `timeoutController?.clearAll()`.

### Compare handoff

- `getCompareContext()` (`:2638-2650`) — bundles `{ lifecycle, sessionStore, tabContexts, storageCoordinator, fanslyClient, llmClient, agencyHubUsageReporter, hasPort, send }` for `compare-operations.ts`.
- `cancelCompare(tabId, error?, notifyDiscard=false)` (`:2652-2658`) — delegates to `cancelCompareOperation`.
- `startCompare(tabId, payload)` (`:2660-2665`) — delegates to `executeCompare`.

### Every Port message the coordinator emits (feature path)

| `type` | Emitted by | Notes |
|---|---|---|
| `tab:state` | `refreshTabState` (default) | full `TabUiState` |
| `settings:changed` | `refreshTabState`/`refreshAllTabs` | same `TabUiState` shape, different type |
| `mapping:changed` | `resolveCapturedIdentity`, `startOperation` rekey paths | same shape |
| `summary:syncStatus` | `sendSummarySyncStatus` | `{ groupId, generatedAt, syncStatus }` |
| `operation:progress` | `sendProgress`/`sendOperationProgress`/`handleLlmUsage` | phase, message, pages, statusCode, retryAtMs, spend, profiling |
| `operation:chunk` | `flushChunks` | batched streamed text |
| `operation:debugPrompt` | `sendDebugPromptSnapshot` | only when `profiler.enabled` |
| `operation:complete` | `sendComplete` | result + fanDisplayName + spend + profiling |
| `operation:error` | `sendError` | UserFacingError + spend + profiling |
| `operation:discarded` | `sendDiscarded` | staleness/route-change discard |

Compare-path emits (`compare:ready/progress/chunk/cardComplete/cardError/error/complete/discarded`) originate in `compare-operations.ts` via the injected `send`.

### Dependency methods called (feature path)

- **FanslyClient**: `getAuthenticatedAccountId`, `getAuthenticatedAccount`, `getGroup`, `getAccountNames`, `loadMessages`, `getFanSubscriptionContext`, `getMonthlyEarnings`, `getEarnings` (last two also via `conversation-context-loader.loadMediaPurchaseEvidence`).
- **LlmClient**: `streamMessage`.
- **StorageCoordinator**: `getState`, `rekeyAccountIdentity`, `getSummaryCache`, `saveSummaryCache`, `removeSummaryCache`, `updateSummaryCache`.
- **AgencyHubClient**: `isConfigured`, `fetchFanProfileByConversation`, `pushFanProfile`.
- **AgencyHubUsageReporter**: `enqueue`.
- **SessionStore**: `getAccountIdForTab`, `getSessionForTab`, `getSessionByAccount`, `forgetTab`.
- **TabContextStore**: `setAccount`, `setRoute`, `getOrCreate`, `setActiveOperation`, `setFan`, `remove`.
- **OperationRegistry** (`lifecycle`): `isBusy`, `reserve`, `releaseReservation`, `activateFeature`, `getFeature`, `cancelFeature`, `completeFeature`, `consumeCancelledFeature`, `forgetCancelledFeature`, `hasActiveCompare`, `getCompare`.
- **browser.tabs**: `get`.

### Route-nonce / groupId staleness gating

- Every await-crossing point re-reads the live op via `getActive`/`assertActive` and compares `operationId`; mismatches throw `chat_changed` or silently drop (in `onText`).
- `handleRouteChanged` cancels with `notifyDiscard=true` → `operation:discarded` when `groupId` changes mid-op.
- `validateStart` rejects a start whose `payload.groupId` no longer matches the tab URL's parsed groupId.
- `routeNonce` from `payload`/`tab:init`/`tab:routeChanged` is stored on the `ActiveOperation` and in `tabContexts`; the coordinator itself gates primarily on `operationId` + `groupId` equality rather than comparing `routeNonce` numerically inside `startOperation`.

---

## `src/background/operation-registry.ts`

Generic bookkeeping over two operation kinds. Exports:

- `RegisteredOperation` — minimal shape `{ operationId, controller: AbortController }` both op types satisfy.
- `CompareOperationLifecycle<CompareOperation>` — the interface `compare-operations.ts` consumes (subset of the class).
- `OperationRegistry<FeatureOperation, CompareOperation>` — the class.

(`CleanupOperation<Operation> = (operation) => void`, `operation-registry.ts:6`, is a module-private type used for the cleanup callbacks — it is not exported.)

Internal maps/sets (`:35-39`): `featureByTabId`, `compareByTabId`, `cancelledFeatureOperationIds`, `cancelledCompareOperationIds`, `reservedTabIds`. Exposed via getters `featureOperations`, `compareOperations`, `cancelledFeatureIds`, `cancelledCompareIds`, `reservations`.

Key methods:

- `hasActiveFeature/hasActiveCompare/isReserved` (`:61-71`) — membership checks.
- `isBusy(tabId)` (`:73-79`) — active feature OR active compare OR reserved. This is the single mutual-exclusion predicate.
- `reserve(tabId)` (`:81-87`) — returns false if busy, else adds to `reservedTabIds`. **Synchronous claim** used to close the start race.
- `releaseReservation` (`:89-91`).
- `getFeature/getCompare` (`:93-99`) — `?? null`.
- `activateFeature/activateCompare` (`:101-107`) — map set.
- `cancelFeature(tabId, cleanup?)` (`:109-123`) — records id in cancelled set, **aborts the controller**, runs cleanup, removes from active map, returns the op (or null).
- `cancelCompare` (`:125-139`) — mirror for compare.
- `completeFeature(tabId, cleanup?)` (`:141-154`) — runs cleanup, removes from active map, **deletes id from cancelled set**, returns the op.
- `completeCompare` (`:156-169`) — mirror.
- `consumeCancelledFeature/Compare(operationId)` (`:171-177`) — `Set.delete` (returns whether present). Used in the catch block to detect "this op was cancelled".
- `forgetCancelledFeature/Compare(operationId)` (`:179-186`) — unconditional delete (bounds the set).

Callers: constructed and driven by `OperationCoordinator` (`operations.ts:450-451`); the `CompareOperationLifecycle` slice is consumed by `compare-operations.ts` through `getCompareContext`.

---

## `src/background/operation-timeouts.ts`

`OperationTimeoutController<Key extends string>` — a fan-in of many named timers into one `AbortController`.

- `signal` getter (`:5-7`) — the shared `AbortSignal`; any armed timer firing aborts it.
- `arm(key, ms)` (`:9-16`) — clears any existing timer for `key`, then `setTimeout` that deletes its handle and calls `controller.abort()`. Handle stored in `handlesByKey`.
- `clear(key)` (`:18-25`) — `clearTimeout` + delete for that key only.
- `clearAll()` (`:27-32`) — clears every handle and empties the map (does **not** reset the controller — once aborted it stays aborted).

Used exclusively by `startOperation` with `OperationTimeoutKey` values. The controller's `signal` is combined with the manual cancel controller via `AbortSignal.any` and threaded through all network calls. Timeout constants come from `shared/constants.ts`: `QUICK_OPERATION_TIMEOUT_MS=60000`, `DEEP_OPERATION_PREP_TIMEOUT_MS=180000`, `DEEP_OPERATION_LLM_TTFB_TIMEOUT_MS=45000`, `DEEP_OPERATION_LLM_IDLE_TIMEOUT_MS=45000`, `DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS=300000`.

---

## `src/background/operation-profiling.ts`

Debug-only timing/metrics recorder attached to progress/complete/error/discarded messages as `profiling`.

- `OperationProfiler` interface (`:9-29`) — `enabled`, `log`, `startStage`, `completeStage`, `failStage`, `skipStage`, `setLlmUsage`, `setLlmCost`, `setReasoningBlock`, `snapshot`, `finalizeRunningStages`.
- `createOperationProfiler(enabled)` (`:60-225`):
  - **Disabled** (`:61-75`): returns a struct where every method is a no-op and `snapshot`/`finalizeRunningStages` return `undefined` — this is why no `profiling` key is attached when `debugMode` is off.
  - **Enabled**: captures `startMs = Date.now()`; keeps `logEntries`, `stages` array, `stageByKey` map, and optional `llmUsage`, `llmCost`, `reasoningBlock`.
    - `elapsed()` — `max(0, now - startMs)`.
    - `startStage(key,label,detail?)` — no-op if key already present; pushes `{ key, label, status:'running', startedElapsedMs }`.
    - `endStage(key,status,detail?)` helper — only ends a `running` stage; sets `endedElapsedMs`, `durationMs`. `completeStage`→`'completed'`, `failStage`→`'failed'`.
    - `skipStage(key, labelOrDetail?, detail?)` — for an existing running stage marks it `'skipped'`; for a new key creates a zero-duration skipped stage. The `labelOrDetail`/`detail` overloading is disambiguated internally.
    - `setLlmUsage/setLlmCost/setReasoningBlock` — store copies.
    - `snapshot()` → `buildSnapshot`.
    - `finalizeRunningStages(detail?)` — force-fails any still-running stage, then snapshots (used in the operation catch block).
- `buildSnapshot(...)` (`:35-58`) → `OperationProfilingSnapshot { elapsedMs, activeLabel (running stage labels joined by ' + ' or null), logEntries (copied), stages (cloned), llmUsage?, llmCost?, reasoningBlock? (trimmed) }`.
- `cloneStage` (`:31-33`) — shallow copy.

Stage keys (`OperationProfilingStageKey`, `shared/types.ts:601-612`): `resolve-identity`, `summary-cache-check`, `load-messages`, `ping-analysis`, `group-lookup`, `account-name-lookup`, `earnings`, `subscription-lookup`, `prompt-build`, `llm-ttfb`, `llm-stream` — every one is driven from `startOperation`.

---

## `src/background/operation-cleanup.ts`

Flush-timer teardown used as the `cleanup` callback for registry cancel/complete.

- `FlushTimerState` (`:1-3`) — `{ flushTimer: number | null }` (structurally matched by `ActiveOperation`).
- `clearFlushTimer(state)` (`:5-13`) — if `flushTimer !== null`, `clearTimeout` + null it, returns `true` (whether a timer was cleared). In `startOperation` the boolean is used to decide whether to flush residual chunks before completion (`operations.ts:2493-2495`).
- `clearFlushTimers(states)` (`:15-19`) — iterates and clears each. (Not referenced from `operations.ts`; likely used by `compare-operations.ts`.)

`clearFlushTimer` is imported by `operations.ts` and passed to `lifecycle.cancelFeature` / `lifecycle.completeFeature`.

---

## `src/background/operation-utils.ts`

Free helpers imported by `operations.ts` (and `compare-operations.ts`).

- `parseGroupIdFromUrl(url?)` (`:13-19`) — regex `/\/messages\/([^/?#]+)/` on the tab URL; returns the conversation/group id or null. **This is the sole source of the operation's `groupId` from the Fansly URL** and is used both in `validateStart` and `TabContextStore` reconciliation.
- `errorCode(error)` (`:21-27`) — returns `error.key` for `ChatGooseError`, else a `.key` string if present, else `'unknown_error'`. Used for profiler/log detail strings.
- `resolveAbortChatGooseError(error, { active, timeoutSignal?, cancelSignal? })` (`:29-46`) — only acts on `AbortError` DOMExceptions: timeout signal aborted → `timed_out`; not-active or cancel signal aborted → `chat_changed`; else `network_error`. Returns null for non-abort errors (so the catch block falls through to `toUserError(error)`).
- `describeMessageLoadProgress(progress)` (`:48-52`) — formats `Loaded messages page {currentPage}/{targetPages} ({pageMessageCount} msgs, {collectedCount} collected)` for profiler logs.
- `describeSubscriptionTraceStep(event)` (`:54-79`) — maps each `SubscriptionLookupTraceEvent.type` (`cache-hit`, `cache-miss`, `cache-only-skip`, `groups-start/hit/miss/error`, `subscribers-start/hit/miss`) to a short label; `groups-error` includes `event.code`.

These import only `ChatGooseError` (`shared/errors.js`) and the `MessageLoadProgress` / `SubscriptionLookupTraceEvent` types from `./fansly-client.js`.

---

## Boundary crossings summary (for this file set)

| Boundary kind | Where | Endpoint / key / message |
|---|---|---|
| network (Fansly REST) | `startOperation`, `resolveCapturedIdentity`, `resolveCreatorUsername`, `resolveFanAccountIdForSync`, earnings block | `fanslyClient.{getAuthenticatedAccountId,getAuthenticatedAccount,getGroup,getAccountNames,loadMessages,getFanSubscriptionContext,getMonthlyEarnings,getEarnings}` (base `https://apiv3.fansly.com/api/v1`) |
| network (Anthropic / OpenRouter) | LLM streaming loop | `llmClient.streamMessage` → `https://api.anthropic.com/v1/messages` or `https://openrouter.ai/api/v1/messages` |
| network (Agency Hub / core) | prefetch, sync, usage | `agencyHubClient.fetchFanProfileByConversation` (GET `.../conversations/{convId}/profile`), `agencyHubClient.pushFanProfile` (PUT `.../fans/{platformUserId}/profile`), `agencyHubUsageReporter.enqueue` (→ POST `.../ai-usage/batch`) |
| storage (`browser.storage.local` via StorageCoordinator) | throughout | `getState`, `rekeyAccountIdentity`, summary cache: `getSummaryCache`/`saveSummaryCache`/`removeSummaryCache`/`updateSummaryCache` |
| ipc (runtime Port, Content↔Background) | `handlePortMessage`, all `send*` | in: `tab:init/routeChanged`, `operation:start/cancel`, `compare:start/cancel`; out: `tab:state`, `settings:changed`, `mapping:changed`, `summary:syncStatus`, `operation:progress/chunk/debugPrompt/complete/error/discarded` |
| browser-api | `validateStart` | `browser.tabs.get`; and (in `index.ts`) `browser.runtime.onConnect`, `browser.tabs.onRemoved`, `browser.storage.onChanged` drive the coordinator |

No DOM access occurs in these files — DOM reads/writes are done by content scripts; the coordinator only receives `domFanDisplayName` inside the `operation:start` payload and echoes/overrides it as `fanDisplayName`.
