I now have a comprehensive map. Here is the implementation map organized by your 7 sections. All paths are absolute; line numbers are from the current `chore/docs-cleanup` checkout.

---

# 1. Operation pipeline — `/Users/dmitriy/code/chatgoose/src/background/operations.ts` (2849 lines)

**Class:** `OperationCoordinator` (line 392). Constructor (416-428) takes `sessionStore`, `tabContexts`, `fanslyClient`, `kernelGateway: KernelFeatureGateway`, `storageCoordinator`, `agencyHubClient`, optional `acceptance?: Pick<AcceptanceReporter,'enqueue'>`, and a debug-prompt store.

**Port entry / dispatch:**
- `registerPort` (465) wires `port.onMessage` → `handlePortMessage`.
- `handlePortMessage` (562); the `switch` on message type at 578: `case 'operation:start': await this.startOperation(tabId, message)` (578-579); `'compare:start'` (581), `'operation:acceptance'` (584-594) reads `acceptanceContexts` and calls `this.acceptance.enqueue({...context, action, at})`, `'operation:cancel'` (595), `'compare:cancel'` (602).

**Lifecycle helper methods & line ranges:**
- `startOperation` (1469-2766) — the whole feature lifecycle.
- `validateStart` (1181-1227): parallel `browser.tabs.get` + `storageCoordinator.getState()`, `parseGroupIdFromUrl`, throws `chat_changed`/`hub_missing_api_key` (via `this.kernelGateway.isConfigured`, 1203)/`no_personalities`/`not_connected`/`session_expired`; returns `messageCount: resolveFeatureMessageCount(payload.feature, storage.settings)`.
- `cancelOperation` (1229), `clearCompletedOperation` (1250), `getActive` (1259), `assertActive` (1458), `flushChunks` (1152), `scheduleChunkFlush` (1168).
- `send`/`sendSummarySyncStatus`/`sendProgress`/`sendComplete`/`sendError`/`sendDiscarded` (1071-1151).
- `buildTabUiState` (706-747), `refreshTabState` (485), `handleCapture` (518), `handleTabRemoved` (554).

**Reservation / concurrency:** `startOperation` blocks concurrent ops via `this.lifecycle.isBusy(tabId)` (1474) → sends `another_operation`; synchronous `this.lifecycle.reserve(tabId)` (1490) before first await. `ActiveOperation` object built at 1548-1561 and `this.lifecycle.activateFeature(tabId, active)` (1563).

**clientContext assembly (the transcript-load block, 1938-2135):**
- `load-messages` stage → `this.fanslyClient.loadMessages(...)` (1943-1969).
- `group-lookup` → `this.fanslyClient.getGroup(...)` (1980-2005); `groupUsers` filtered (1985).
- `fanAccountId` resolved from groupUsers (2017-2020): `groupUsers?.find(u => u.userId !== resolvedAccountId)?.userId ?? null`.
- `let fanDisplayName = payload.domFanDisplayName ?? 'fan'` (2015) — the DOM fallback seed; `let fanBio: string | undefined` (2016).
- `loadMediaPurchaseEvidence({...})` (2022-2029) → `normalizeTranscript(messageLoad.pages, resolvedAccountId, fanAccountId, purchaseEvidence)` (2035).
- Deep gate: `< MIN_MESSAGES_FOR_DEEP` → `not_enough_history` (2042-2047); hi-greeting `> HI_GREETING_MAX_TRANSCRIPT` → `hi_too_many_messages` (2049-2054).
- `analyzePingSegment` (2056-2085); `pingSegment === 'active'` → sends `ping_blocked` and returns.
- **fanDisplayName resolution + bio (2087-2108):** when `fanAccountId`, calls `this.fanslyClient.getAccountNames([fanAccountId], ...)` (2090); `fanDisplayName = account?.username?.trim() || account?.displayName?.trim() || payload.domFanDisplayName || 'fan'` (2096-2100); **bio only for hi-greeting**: `if (payload.feature === 'hi-greeting' && account?.about?.trim()) { fanBio = account.about.trim(); }` (2101-2103).
- `this.tabContexts.setFan(tabId, fanAccountId, fanDisplayName)` (2129).
- **spend/subscription (2137-2382):** parallel `Promise.allSettled` over `getMonthlyEarnings`, `getEarnings`, `getFanSubscriptionContext` — destructured `[monthlyResult, earningsResult, subscriptionResult]` (2217-2233). `subscriptionLookupMode: SubscriptionLookupMode = 'full'` (2141). Spending: `spendingData = formatFanSpendingData(aggregated)` (2318), `spendingDataVerified` (2319). Subscription: `subscriptionData = formatFanSubscriptionData(subscriptionResult.value...)` (2341); `subscriptionLookupVerified = subscriptionLookupMode === 'full'` (2339). Subscription trace steps via `describeSubscriptionTraceStep` / `handleSubscriptionTrace` (2148-2199).

**Kernel request build (~2400):**
- `formatTranscriptForKernel(transcriptMessages)` → `{ transcript: formattedTranscript, messageCount: keptMessageCount }` (2385-2386).
- `pageUsername = await this.resolveCreatorUsername(...)` (2391); `pageLabel = await this.agencyHubClient.resolvePageLabelForUsername(...)` (2392-2396); no match → `throw new ChatGooseError('hub_page_match_failed')` (2398).
- `const kernelRequest = { feature, clientRequestId: payload.operationId, pageLabel, conversationRef: fanAccountId ?? validated.urlGroupId, personaKey: personality.id, replyTone, replyMode, draftText, isRegeneration: Boolean(payload.forceRegenerate), debugPromptEcho: profiler.enabled, clientContext: { transcript, messageCount, fanDisplayName, fanSpendingData, fanSubscriptionData, ...(fanBio), ...(pingSegment) } } as const` (2400-2422).

**Personality/model resolution (1752-1794):** `resolveMappedPersonalityId(...)` (1753) → `no_mapping` if absent; `findUsablePersonality(...)` (1763) → `no_mapping`; `featureRequiresDraft` check → `unknown_error` (1768-1770); `const resolvedModel = KERNEL_MODEL_ID` (1775, where `KERNEL_MODEL_ID = 'kernel'` at line 159). Summary-cache hit path returns early (1796-1893) with `sendDebugEchoStatus({ state: 'cache-hit' })`.

**operationId → generationRef acceptance map (~430):**
- `private readonly acceptanceContexts = new Map<string, Omit<AcceptanceEventInput,'action'|'at'>>()` (430).
- `rememberAcceptanceContext(operationId, context)` (432-443): stores, evicts oldest when `size > 50` (437).
- Populated in the `onMeta` callback (2566-2581): `requestId: meta.requestId` = generation ref: `this.rememberAcceptanceContext(payload.operationId, { operationId, requestId: meta.requestId, feature, pageLabel, conversationRef })`.
- First-text-chunk enqueues acceptance `'shown'` (2551-2560) using `this.acceptanceContexts.get(payload.operationId)?.requestId ?? null`.

**Stream callbacks (2534-2601):** `onText` (2535) staleness-guarded on operationId, appends to `current.rawText`/`flushBuffer`, `scheduleChunkFlush`; `onMeta` (2566); `onUsage` (2582) → `handleKernelUsage` (2466-2488, builds `buildKernelSpendSummary(usage)`); `onReasoningDelta` (2586); `onStopReason: (r) => { latestLlmStopReason = r }` (2597-2599); `onDebugInput: handleDebugInput` (2600, defined 2510-2532).

**Single service_unavailable retry (~2603):**
- `let serviceUnavailableRetried = false` (2603); `while (true)` loop (2605) calls `rawText = await this.kernelGateway.streamFeature(validated.storage.settings, kernelRequest, streamCallbacks, signal)` (2610-2615).
- On catch, duck-typed `errorKey` (2620-2622); condition `if (!sawFirstChunk && !serviceUnavailableRetried && errorKey === 'service_unavailable')` (2625) → sets flag, `clearLlmTimeouts()`, `retryDelayMs = AUTO_RETRY_SERVICE_UNAVAILABLE_MS` (2628, constant `= 5_000` at line 168), sends "Provider unavailable. Retrying…" progress, `await delay(retryDelayMs, signal)` (2642), resets `sawProviderActivityInAttempt=false`, `startLlmTtfbTimeout()`, `continue`. Otherwise `throw err` (2655).

**stopReason handling (~2690):** `if (latestLlmStopReason === 'max_tokens' && getFeaturePolicy(payload.feature).promptMode === 'reply') { throw new ChatGooseError('ai_output_unusable'); }` (2690-2695).

**Results flow back:**
- `flushChunks` (1152-1167): posts `operation:chunk` with `operation.flushBuffer`, clears buffer.
- `buildFeatureResult(feature, rawText, replyMode)` (345-377): switches on `getFeaturePolicy(feature).resultKind` — `help-me`/`chat-review`/`single-reply`/`summary`/`reply` (hi-greeting → `normalizeVariantReplyParts`, else `normalizeReplyParts`).
- `assertInsertableFeatureResult` (379-390): `reply`/`single-reply` with no parts → `ai_output_unusable`.
- fan-summary caching (2704-2741): builds `summaryMeta`, `await this.storageCoordinator.saveSummaryCache(...)` when `spendingDataVerified && subscriptionLookupVerified` (2728) with `modelId: resolvedModel`.
- `this.sendComplete(tabId, { type:'operation:complete', operationId, result, fanDisplayName }, completedSpend, profiler)` (2743-2748); `clearCompletedOperation` (2750); fan-summary Hub sync enqueued (2751-2766).
- Error path (2767-...): `resolveAbortChatGooseError`, `consumeCancelledFeature` short-circuit.

---

# 2. Kernel gateway + SDK — `/Users/dmitriy/code/chatgoose/src/background/kernel-feature-gateway.ts` (291 lines)

**Import:** `import { KernelApiError, streamAiFeature, type AiFeatureStreamFrame } from '@kernel/sdk';` (11). Also `clientVersionHeaders` (13), `normalizeAgencyHubBaseUrl` (15), `resolveHubBearer` (16), `recordQuotaDenied`/`recordQuotaSnapshot` (17).

**Interfaces:**
- `KernelFeatureClientContext` (19-27): `transcript, messageCount, fanDisplayName, fanSpendingData, fanSubscriptionData, fanBio?, pingSegment?`.
- `KernelFeatureRequest` (29-47): `feature, clientRequestId` (=operationId, "Must be a UUID"), `pageLabel, conversationRef, personaKey?, replyTone?, replyMode?, draftText?, isRegeneration?, clientContext, debugPromptEcho?`.
- `KernelFeatureDebugInput` (50-54): `systemBlocks[], userBlocks[], contextManifest`.
- `KernelFeatureUsage` (56-64): `inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, costMicroUsd, costApproximate`.
- `KernelFeatureCallbacks` (66-76): `onText, onMeta?, onUsage?, onReasoningDelta?, onStopReason?, onDebugInput?`.
- `KernelFeatureGateway` (154-163): `isConfigured(settings)` + `streamFeature(settings, request, callbacks, signal): Promise<string>`.

**Error mapping:** `KERNEL_GATE_KEYS` (80-85) maps `gate_min_messages→not_enough_history`, `gate_hi_greeting_limit→hi_too_many_messages`, `gate_ping_active→ping_blocked`, `gate_draft_required→unknown_error`. `mapKernelGateError` (91-112, 400-only). `toChatGooseError` (114-152): 429 `quota_denied`→`hub_quota_exceeded` else `rate_limited`; 503/502→`service_unavailable`; 401/403→`hub_invalid_api_key`; network aborted→AbortError DOMException; else `hub_request_failed`.

**Factory `createKernelFeatureGateway(fetchImpl = ...)` (165-291):**
- `isConfigured` (169-173): `Boolean(normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl) && resolveHubBearer(settings))`.
- `streamFeature` (175-290): resolves `baseUrl`/`bearer` (176-180, throws `hub_missing_api_key`); tracks `let text=''`, `let done=false`.
- **SSE frame handling** `handleFrame(frame: AiFeatureStreamFrame)` (185-231) switch on `frame.type`:
  - `'debug_input_v1'` → `onDebugInput` (187-193);
  - `'meta'` → `recordQuotaSnapshot(frame.pageLabel, frame.quota.remainingRequestsToday)` (197-200) + `onMeta({requestId, clientRequestId, model})` (201-205);
  - `'content_delta'` → `text += frame.text; onText(frame.text)` (207-210);
  - `'reasoning_delta'` → `onReasoningDelta` (211-213);
  - `'usage'` → `onUsage({...frame.usage})` (214-223);
  - `'done'` → `done = true; onStopReason(frame.stopReason ?? null)` (224-227) — **this is where stopReason lands**.
- Calls `streamAiFeature({ baseUrl, auth:{mode:'bearer', token:()=>bearer}, headers: clientVersionHeaders(), fetch: fetchImpl }, { feature, body:{ clientRequestId, pageLabel, platform:'fansly', conversationRef, ...personaKey, ...replyTone, ...replyMode, ...draftText, isRegeneration:false-default, clientContext:{...} }, ...(debugPromptEcho), onFrame: handleFrame, signal })` (233-270).
- `await handle.done` (273); on error maps + `recordQuotaDenied` on quota (274-280). `if (!done) throw new ChatGooseError('hub_request_failed', {message:'AI stream ended without completing.'})` (281-287). Returns `text`.

**Vendored SDK** at `/Users/dmitriy/code/chatgoose/vendor/kernel-sdk` (linked via `package.json:38 "@kernel/sdk": "link:./vendor/kernel-sdk"`). Only `dist/*.js`+`.d.ts` present (no `src/`; generated by core `scripts/vendor-sdk.mjs`, do not edit).

**Exports** (`dist/index.d.ts`): `createClient`, `createKernelClient`, `KernelApiError`, `SDK_EXCLUDED_OPERATIONS`, `streamAiFeature`, `streamAiGateway`, `ofapiRead`, `subscribeDomainEvents`, `subscribeSyncEvents`, `kernelOperations`, `KERNEL_CONTRACT_HASH`, `KERNEL_SDK_VERSION`, plus types.

**Operations pattern for a NEW GET (recap-status):**
- `kernelOperations` (`dist/operations.d.ts`) is the manifest of `{method, path}` per operation key. Existing recap-adjacent GETs already present: `pageFanProfile` `GET /api/v1/pages/:pageLabel/fans/:platformUserId/profile` (446-449), `pageFanProfileVersions` (454-457), `pageConversationProfile` `GET /api/v1/pages/:pageLabel/conversations/:conversationId/profile` (434-437). A new op would be added to this manifest + `routeSchemas`.
- `createClient(options)` returns a `KernelClient` where **each non-excluded operation is a typed method**: `client.<opKey>({ params, query, body })` → `Promise<KernelOperationResponse>` (`sdk-runtime.d.ts` 44-58). Escape hatch `client.raw(key, {params, query, body, headers})` → raw `Response` (52-57).
- `KernelClientOptions` (67-84): `baseUrl`, `auth: {mode:'bearer', token:()=>...}`, `headers`, `fetch`, `onAuthError`.
- **How the extension actually calls a GET** — the pattern to copy is in `/Users/dmitriy/code/chatgoose/src/background/agency-hub-client.ts`:
  - `sdkFor(baseUrl, bearer, signal)` (202-209): `createClient({ baseUrl: baseUrl.replace(/\/+$/,''), auth:{mode:'bearer', token:()=>bearer}, headers: clientVersionHeaders(), fetch:(input,init)=>this.fetchImpl(input,{...init, signal}) })` — the SDK has no per-op signal, so it rides the fetch seam.
  - Parametrized GET example `getConversationProfile` (287-305): `await this.sdkFor(...).pageConversationProfile({ params: { pageLabel, conversationId } })`; **404 handled as domain null** (300-302); other errors → `this.toHubError(error, 'conversation profile fetch')`.
  - No-arg GET example `listVisiblePages` (253-263): `await this.sdkFor(...).pages()`.
  - `resolveHubBearer(settings)` (agency-hub-client.ts:65) prefers device token over API key.
- device-token.ts (15,42) and acceptance-reporter.ts (12,122-129) also use `createClient`.

---

# 3. Fansly client + transcript

## `/Users/dmitriy/code/chatgoose/src/background/fansly-client.ts` (1009 lines)

**Constants imported (from constants.ts):** `FANSLY_PAGINATION_DELAY_MS`, `FANSLY_PAGE_LIMIT`, `FANSLY_RETRY_DELAYS_MS`, `FANSLY_RETRY_MAX_BACKOFF_MS` (lines 2-9). Local module constants: `MESSAGING_GROUPS_PAGE_SIZE = 100` (62), `MESSAGING_GROUPS_MAX_PAGES = 20` (66), `SUBSCRIBERS_PAGE_SIZE = 100` (67), `SUBSCRIPTION_CACHE_TTL_MS = 5*60*1000` (68), `ORDER_TYPE_SINGLE = 1` / `ORDER_TYPE_BUNDLE = 2` (69-70).

**`loadMessages` (969-1008):**
- `targetPages = estimateTargetPages(requestedCount)` (976).
- `while (collectedCount < requestedCount)` loop (982): `getMessagePage(groupId, before, session, signal)` (983), pushes page, increments `currentPage`, fires `onProgress?` (988-993).
- `before = extractOldestMessageId(messages)` (995); `if (!before || messages.length < FANSLY_PAGE_LIMIT) break` (996-998); `await delay(FANSLY_PAGINATION_DELAY_MS, signal)` (1000).
- Returns `{ pages, pagesLoaded: currentPage, targetPages }`.
- `FANSLY_PAGE_LIMIT = 25`, `FANSLY_PAGINATION_DELAY_MS = 300` (constants.ts 32,34).
- `getMessagePage` (485-498) sets `limit`=FANSLY_PAGE_LIMIT and optional `before`.

**Enrichment calls:**
- `getGroup(groupId, session, signal)` (428-440) → `GET /api/v1/group/{groupId}/`; returns `{users?}`. Not cached.
- `getAuthenticatedAccount` (447-483) / `getAuthenticatedAccountId` (442-445) → `/api/v1/account/me`; memoizes onto the `session` object (474-476).
- `getAccountNames(ids, session, signal, retryPolicy='default')` (622-652) → `GET /api/v1/account?ids=...`. Not cached (batch name lookup).
- `getEarnings(fanAccountId, windowStartMs, windowEndMs, ...)` (654-675) → `.../earnings/stats/accounts`, retryPolicy `'none'`, → `aggregateEarnings(...)`. Not cached.
- `getMonthlyEarnings(...)` (773-792) → `.../earnings/monthlystats/accounts`, retryPolicy `'none'`. Not cached.
- `getFanSubscriptionContext(groupId, fanAccountId, session, signal, lookupMode='full', onTrace?)` (904-967): **cached** via `subscriberSubscriptionCache`. Cache-check (912-917) with trace `cache-hit`; `cache-only` short-circuit (920-923); tries messaging-groups path `getActiveConversationSubscriptionFromMessagingGroups` (927-938) then `getSubscriptionFromSubscribers` (955), writes cache (936, 965).
- PPV/media purchase evidence: `verifyMediaPurchaseStates` (572), `verifyMediaPurchaseState` (524-560), `getMediaOrderHistory` (500). **cached** via `mediaPurchaseVerificationCache` (271, keyed by `getMediaPurchaseCacheKey` 298-309, TTL `FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS = 5*60*1000` constants.ts:42).
- `listFanAccounts` (683-741, spenders), `findGroupIdForFan` (743).

**Caches (fields):** `subscriberSubscriptionCache = new Map<string, CachedSubscriberSubscription>()` (270); `mediaPurchaseVerificationCache = new Map<string, CachedMediaPurchaseStatus>()` (271). Read/write helpers with `expiresAt`-based expiry (279-330).

**PPV evidence loader** — `/Users/dmitriy/code/chatgoose/src/background/conversation-context-loader.ts` `loadMediaPurchaseEvidence({fanslyClient, pages, fanAccountId, session, signal, debugEnabled})` (15-68): returns `{}` when no fanAccountId; `buildPurchaseEvidence` + `collectUnverifiedPpvAttachmentRequests`; caps at `FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT` (40, =10 constants.ts:39); calls `fanslyClient.verifyMediaPurchaseStates`; fail-open sets `verificationIncomplete: true`.

## `/Users/dmitriy/code/chatgoose/src/shared/transcript.ts` (633 lines)

- **`normalizeTranscript(pages, modelAccountId, fanAccountId=null, purchaseEvidenceOverride={})` (471-520):** dedupe via `const messageMap = new Map<string, NormalizedTranscriptMessage>()` (477); `const existing = messageMap.get(message.id); if (existing) continue;` (483-486) — **first-write-wins dedupe by message.id**. Builds `labels` from attachments (`describeAttachment`) + tip label (498-500); `senderLabel: message.senderId === modelAccountId ? 'Model' : 'Fan'` (506); `text: message.type === 1 ? content.trim() : '[System message]'` (508). Returns array sorted by `createdAt` then `compareMessageIds` (514-519).
- **`formatTranscriptForKernel(messages, maxChars = KERNEL_TRANSCRIPT_MAX_CHARS)` (551-582):** oldest-first truncation — iterates from newest (`index = length-1` down, 561), each line cost `line.length + (keptLines.length>0 ? 1 : 0)` (563), breaks when `totalChars + cost > maxChars` (564-566); if none fit, keeps the newest message's tail `newest.slice(-maxChars)` with `messageCount: 1` (571-576); else `{ transcript: keptLines.reverse().join('\n'), messageCount: keptLines.length }`. **`KERNEL_TRANSCRIPT_MAX_CHARS = 300_000`** (constants.ts:144; mirrors kernel `z.string().max(300_000)`).
- Other exports: `buildPurchaseEvidence` (321), `collectUnverifiedPpvAttachmentRequests` (421), `formatTranscript` (537), `analyzePingSegment` (595), `resolvePingSegment` (623), `estimateTargetPages` (627, `Math.ceil(requestedCount/25)`), `extractOldestMessageId` (631), `buildTranscriptWindowStart` (584).

---

# 4. Storage + migrations + constants

## `/Users/dmitriy/code/chatgoose/src/shared/constants.ts` (197 lines)
- **`export const STORAGE_SCHEMA_VERSION = 13;`** (10). `SUMMARY_CACHE_PREFIX = 'summary:'` (11), `KNOWN_ACCOUNTS_KEY = 'knownAccounts'` (12), `AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY = 'agencyHubDeviceToken'` (18), `AGENCY_HUB_API_KEY_STORAGE_KEY = 'agencyHubApiKey'` (19), `SUMMARY_EVICTION_COUNT = 10` (20).
- Message counts (84-97): `QUICK_DEFAULT_MESSAGE_COUNT = 100`, `QUICK_MIN=5`, `QUICK_MAX=200`; `PING_*` mirror quick (89-91); `IMPROVE_DEFAULT=25`, min=5, max=200 (92-94); `DEEP_DEFAULT_MESSAGE_COUNT = 1500`, `DEEP_MIN=100`, `DEEP_MAX=3000` (95-97).
- **`DEFAULT_SETTINGS` (182-193)** — the defaults block ~186: `{ agencyHubBaseUrl:'', agencyHubApiKey:'', agencyHubDeviceToken:'', quickMessageCount, pingMessageCount, improveMessageCount, deepMessageCount, debugMode:false, promptCachingEnabled:true, uiTheme:'system' }`.
- `FEATURE_LABELS` (168-178): note `'fan-summary': 'Recap'` (174) — "Recap" is the dossier name (relevant if Coach reuses recap).
- Thresholds: `MIN_MESSAGES_FOR_DEEP = 30` (121), `HI_GREETING_MAX_TRANSCRIPT = 10` (122), `PING_MIN_FAN_MESSAGES = 3` (124).

## `/Users/dmitriy/code/chatgoose/src/shared/migrations.ts` (211 lines)
- `createDefaultSettings()` (13-26): returns the Settings object (no `agencyHubApiKey`/`deviceToken` stripping here — full shape).
- `createSeedState()` (28-37): `{ schemaVersion: STORAGE_SCHEMA_VERSION, settings, personalities:[], accountMappings:{}, accountAliases:{}, knownAccounts:[] }`.
- `migrateSettingsRecord(raw, custody: SecretCustody)` (44-88): the per-field normalizer. Header comment documents the version history: v9 dropped vendor keys/models; v11 dropped `spendersLegacyRebuild`; v12 added `uiTheme`; **v13 moved hub credentials to their own top-level keys** with hydration precedence (custody key wins when string, blob is one-release fallback) (55-59, 63-74). `pingMessageCount` seeds from `quickMessageCount` (76).
- `stripSecretSettings(settings)` (94-103): `Omit<Settings,'agencyHubApiKey'|'agencyHubDeviceToken'>`.
- **`serializePersistedState(state)` (109-118):** `{ ...state, settings: stripSecretSettings(state.settings), [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: ..., [AGENCY_HUB_API_KEY_STORAGE_KEY]: ... }` — every full-state persist must route through this.
- `normalizePersistedRecord(record, schemaVersion)` (125-156): builds `custody` from the two top-level keys (130-133), migrates settings, guards personalities/mappings/aliases/knownAccounts, spreads `...collectSummaryCacheEntries(record)` (154).
- **`MIGRATIONS` (158-164):** a single step `{ toVersion: STORAGE_SCHEMA_VERSION, migrate: (record) => normalizePersistedRecord(record, STORAGE_SCHEMA_VERSION) }` — the "single jump-to-current normalizer" you referenced (~158).
- `applyMigrations` (166-184): iterates MIGRATIONS skipping already-satisfied versions; else falls back to `normalizePersistedRecord`.
- **`migrateState(raw)` (193-211):** null/non-object → `createSeedState()`; `schemaVersion === STORAGE_SCHEMA_VERSION` → `normalizePersistedRecord` (guards corrupt data at current version, 201-207); else `applyMigrations`.
- **What a v14 raw-transform looks like:** because migration is a single normalizer today, a genuine v14 would bump `STORAGE_SCHEMA_VERSION` to 14, add a new field default in `createDefaultSettings`/`DEFAULT_SETTINGS`, extend `migrateSettingsRecord` to read/default that field from `raw`, and add clamping in `sanitizeSettings` (storage.ts). The `MIGRATIONS` array's single entry auto-targets the new version. If a structural raw transform were needed, you'd add a discrete `MigrationStep` with an intermediate `toVersion` before the final normalizer.

## `/Users/dmitriy/code/chatgoose/src/shared/storage.ts` (358 lines)
- `sanitizeSettings(input: Partial<Settings>)` (129-162): clamps counts with `Math.min(MAX, Math.max(MIN, n))` (148-154), `normalizeAgencyHubBaseUrl`, trims key/token, validates `uiTheme`.
- `loadStorageState()` (109-127): reads snapshot, removes invalid summary keys, and if `repair.persistState` writes `serializePersistedState(state)` (123) — the v12→v13 secret move IS this write.
- `readStorageStateSnapshot` (94-97) / `readStorageState` (105-107) (non-writing).
- `saveSettings(settingsPatch, baseSettings?)` (169-189): per-key custody — writes `settings: stripSecretSettings(next)` always; writes the credential keys **only when the patch names them** (181-186).
- Summary-cache facade: `getSummaryCache`/`saveSummaryCache`/`removeSummaryCache` (348-358) via `createSummaryCacheStore()` (45-51) bound to `browser.storage.local`.

## Summary-cache persistence — `/Users/dmitriy/code/chatgoose/src/shared/summary-cache.ts` (303 lines)
- **Storage area: `browser.storage.local`** (storage.ts:47). **Keying:** `summaryCacheKey(groupId) = \`summary:${groupId}\`` (23-25); type `SummaryCacheKey` (9). One key per group id.
- `SummaryCacheStore` (185-259): `get`/`save`/`update`/`remove`; on quota failure evicts via `getSummaryCacheEvictionKeys` (invalid keys + oldest by `generatedAt`, 171-183) then retries.
- `isValidSummaryCacheEntry(entry, personalityId, personalityUpdatedAt, modelId)` (261-275): requires matching personality id + updatedAt + modelId, and `spendingDataVerified === true && subscriptionLookupVerified === true`.
- `hasAvailableFanSummary(storage, groupId, mappedPersonalityId)` (277-302): validates with model pin `'kernel'` (300).
- `SummaryCacheEntry` type (types.ts 88-98): `summary, personalityId, personalityUpdatedAt, generatedAt, spendingDataVerified?, subscriptionLookupVerified?, modelId?, fanAccountId?, agencyHubSync?`.

**Settings interface** (types.ts 18-31): `agencyHubBaseUrl, agencyHubApiKey, agencyHubDeviceToken, quickMessageCount, pingMessageCount, improveMessageCount, deepMessageCount, debugMode, promptCachingEnabled, uiTheme`. (Note: there is **no** separate "quickMessageCount/deepMessageCount/pingMessageCount" split beyond these four; no dedicated Coach setting exists yet.)

---

# 5. Options page — `/Users/dmitriy/code/chatgoose/src/options/index.ts` (1451) + `dom.ts` (109)

**Section creation helpers (`dom.ts`):**
- `createSection(title, description?)` (7-29): `<section class="chatgoose-section">` with `<h2>` title + optional `.chatgoose-section-desc`.
- `labeledField(labelText, input)` (31-40): `<label>` grid wrapper with bold `<span>` + input.
- `createButton(label, secondary?, danger?)` (42-52), `createVersionTag` (54-59), `injectStyles` (1-5), `debounce<T>(callback, waitMs)` → `Debounced<T>` with `cancel`/`flush` (61-109).

**Generation section (~137):** `render()` (66). Appearance section first (117-135) — the theme `<select class="chatgoose-select">` built by looping `themeChoices` (123-133), `themeSelect.value = state.settings.uiTheme` (134), appended via `labeledField('Theme', themeSelect)` (135).
- `const apiSection = createSection('Generation')` (138).
- **Numeric input pattern** (repeated 4×, 140-166): `document.createElement('input')`; `.type='number'`; `.className='chatgoose-input'`; `.min`/`.max` (e.g. quick `'5'`/`'200'`, deep `'100'`/`'3000'`); `.value = String(state.settings.<count>)`.
- `debugInput` checkbox (168-177).
- Appended (179-185): `labeledField('Reply + Help message count', quickInput)`, `'Ping message count'`, `'Fix message count'`, `'Deep feature message count'`, plus `debugLabel`.
- Agency Hub section (188-...), Model Personalities (898), Account Mappings (1148), Connection Status (1161).

**How a setting is persisted:**
- `collectSettingsPatch(forceHubSnapshot=false)` (666-686): builds `Partial<Settings>` from DOM: `uiTheme: themeSelect.value as UiThemeSetting`, `agencyHubBaseUrl`, `quickMessageCount: Number(quickInput.value)`, `pingMessageCount`, `improveMessageCount`, `deepMessageCount`, `debugMode: debugInput.checked` (667-675); conditionally adds `agencyHubApiKey` only when dirty (679-684).
- `queueSettingsSave` (708-798): serializes writes via `settingsSaveChain`; `persist()` calls `await saveSettings(patch, state.settings)` (720), reflects sanitized/clamped values back with `writeCount(input,value)` (753-761, skips the focused input).
- `saveSettingsDebounced = debounce(queueSettingsSave, 350)` (800); `scheduleSettingsSave` (801-804).
- **Event wiring (829-855):** iterates `[themeSelect, agencyHubUrlInput, agencyHubKeyInput, quickInput, pingInput, improveInput, deepInput, debugInput]` and adds `'input'` → `scheduleSettingsSave()`, `'change'` → schedule + `flush()`, `'blur'` → `flush()`. `pagehide` handler flushes (1141).
- A new numeric setting + select would follow the same pattern: create input/select with class + min/max, seed `.value` from `state.settings`, append via `labeledField`, add to the wiring array (829-838), add the field to `collectSettingsPatch` (666-675), add clamping to `sanitizeSettings` (storage.ts).

---

# 6. Session capture + persona + tab UI state

## `/Users/dmitriy/code/chatgoose/src/background/session-capture.ts` (126 lines)
- `normalizeRouteKey(url)` (15-38): maps Fansly API URLs → `RouteKey` (earnings/subscribers/media/messagingGroups/group/message/account).
- `extractCapture(headers, url)` (40-80): requires all 4 headers `authorization`, `fansly-client-id`, `fansly-client-ts`, `fansly-session-id` (56-64); decodes legacy account id from base64 authorization via `decodeLegacyAccountKey` (5-13, 66); returns `SessionCaptureResult` with `fanslyClientCheck` + `routeKey`.
- `initializeSessionCapture(sessionStore, onCapture)` (82-126): registers `browser.webRequest.onBeforeSendHeaders` for `https://apiv3.fansly.com/*` (123). Computes `isMaterialCapture` (104-111: new/changed accountId, no/disconnected prior session, or changed auth/clientId/sessionId). `sessionStore.registerCapture(...)` on every request (117); `void onCapture(tabId, accountId, isMaterialCapture)` (121) — expensive side effects gated on material transitions.

## `/Users/dmitriy/code/chatgoose/src/background/persona-sync.ts` (509 lines)
- Header comment (1-25): every generation sends `personaKey: personality.id`; this module upserts/archives custom personas kernel-side so that key exists. Builtins (`builtin:lora`) never synced.
- Constants: `PERSONA_SYSTEM_BLOCK_MAX_CHARS = 50_000` (30), `PERSONA_DISPLAY_NAME_MAX_CHARS = 120` (31), `PERSONA_SYNC_TIMEOUT_MS = 15_000` (32), `PERSONA_SYNC_RETRY_DELAYS_MS = [1_000,5_000,30_000]` (33), `PERSONA_ARCHIVE_JOURNAL_PREFIX = 'personaSyncArchiveIntentV1:'` (34).
- Interfaces: `PersonaSyncStorage` (36-40), `PersonaSyncHub` (42-55, `listAiPersonas`/`upsertAiPersona`/`archiveAiPersona`/`isConfigured`), `PersonaSyncOptions` (57-65), `PersonaSync` (67-72, `handlePersonalitiesChange`/`reconcile`).
- `toPersonaUpsertBody(personality)` (90-105): returns null for builtin or empty content; `{ displayName (≤120), systemBlock (≤50k) }`.
- `diffPersonalities(oldValue, newValue)` (115-137): `{ upserts: Personality[], archives: string[] }`, builtins excluded.
- `createPersonaSync(options)` (139-...): `enqueue` (158), `upsertOne`/`archiveOne` (173/195), archive journal helpers (233-372), `reconcileSnapshot` (388) calls `hub.listAiPersonas`, `reconcileLatest` (442).
- **personaKey/mappedPersonalityId flow:** the mapping is `accountId → personalityId` (`resolveMappedPersonalityId`, defined in `/Users/dmitriy/code/chatgoose/src/shared/compare-cards.ts:17`); `findUsablePersonality` in `/Users/dmitriy/code/chatgoose/src/shared/personalities.ts:13`. In `startOperation`, `personaKey: personality.id` is put on the kernel request (operations.ts:2405).

## TabUiState — `/Users/dmitriy/code/chatgoose/src/shared/types.ts:714-728`
`{ tabId, accountId, groupId, hasAvailableSummary, connected, hasApiKey, modelProviderByFeature?, apiKeyReadyByFeature?, hasPersonalities, mappedPersonalityId, mappedPersonalityName, compareCardCount, compareDraftCount }`. `PopupStatus extends TabUiState` adds `accountLabel` + `aiQuota` (740-744).

## `hasAvailableSummary` flow — `/Users/dmitriy/code/chatgoose/src/background/runtime-api.ts` (113-156)
- `getPopupStatus` handler; no tabId → default status with `hasAvailableSummary: false` (108-124).
- Resolves `state = await storageCoordinator.getState()` (126), session/legacy/account (127-129), `displayGroupId = context.groupId ?? parseGroupIdFromUrl(tabUrl)` (134).
- `resolveMappedPersonalityId(...)` (137) → `findUsablePersonality(...)` (143) → `mappedPersonalityId` (147).
- `hasAvailableSummary: hasAvailableFanSummary(state, displayGroupId, mappedPersonalityId)` (156-160).
- `hasApiKey` computed inline (163-166): base URL + (device token or api key).
- The parallel background computation is `OperationCoordinator.buildTabUiState` (operations.ts:706-747), which uses `hasAvailableFanSummary(storage, context.groupId, mappedPersonalityId)` (712-718) and `hasApiKey: this.kernelGateway.isConfigured(storage.settings)` (740).

## storage-coordinator.ts — `/Users/dmitriy/code/chatgoose/src/background/storage-coordinator.ts` (766 lines)
- `class StorageCoordinator` (140); `init()` (166), `getState()` (170); summary-cache: `getSummaryCache` (402-405, via `getSummaryCacheEntry(state, groupId)`), `saveSummaryCache` (407), `updateSummaryCache` (413), `removeSummaryCache` (422). Startup repair/patch replay: `repairStartupStorage` (440), `proveStorageListener` (473), `replayStartupPatches` (569), `applyStorageChanges` (used by tests).

---

# 7. Tests conventions — `/Users/dmitriy/code/chatgoose/tests/` (flat dir, 60 `*.test.ts`; only helper: `tests/helpers/port.ts`)

Framework: **Vitest** (`import { describe, expect, it, vi } from 'vitest'`). Browser APIs are hand-mocked onto `globalThis.browser`; modules are dynamically imported after mocks are installed (`vi.resetModules()` per test).

**(a) Operations test w/ fake kernel gateway — `tests/operations.test.ts` (2000+ lines).**
- File-level `eslint-disable` for `as any` seams (1-4); comment: "operations surface rewritten onto kernel feature services in Stage 32 Task 3".
- `createCoordinatorHarness(options?)` (286-353): dynamically imports `OperationCoordinator`/`SessionStore`/`StorageCoordinator`/`TabContextStore` (299-305); builds the **fake gateway** as `{ isConfigured: vi.fn(()=>true), streamFeature: vi.fn(async ()=> options?.anthropicRawText ?? 'Result') }` (311-314); a fake `agencyHubClient` with `resolvePageLabelForUsername: vi.fn(async ()=>'creator-fs')` (318); constructs `new OperationCoordinator(sessionStore, new TabContextStore(), fanslyClient as never, kernelGateway as never, storageCoordinator, agencyHubClient as never) as any` (333-340); `port = createMockRuntimePort(1)` + `coordinator.registerPort(port)` (341-342).
- Assertion helpers: `kernelRequestFromStreamCall(kernelGateway)` reads `streamFeature.mock.calls[i][1]` (261-266); tests use `expect(request).toMatchObject({ feature, personaKey, pageLabel })` (1517-1521) and `expect(kernelGateway.streamFeature).toHaveBeenCalledTimes(1)` (1516).
- Streaming behavior tested by supplying a custom `streamFeature: vi.fn(async (_settings, _request, callbacks) => { callbacks.onText('...'); return '...'; })` (1478-1485).
- Style: `postedMessages(port)` + typed `.filter` narrowing on `BackgroundPortMessage` union (1499-1507); `Date.now` stubbed to `currentNow` (390).

**(b) Storage-migration test — `tests/storage-migration.test.ts` (~360+ lines).**
- Hand-rolls `browser.storage.local` `get/set/remove` on a mutable `mockStorage` object (20-46); `const storage = await import('../src/shared/storage.js')` after mock (49).
- `describe('migrateState')` (57): tests ordered-migrations invariant (58), seed for null/non-object (64,74), as-is when schemaVersion matches (79), corruption coercion at current version (96), preserve data from schemaVersion 0 (110), fill defaults for missing fields (127), pre-v8 `agencyHubDeviceToken` idempotency (136), pre-v12 `uiTheme` default + junk rejection (155-172), `pingMessageCount` seeded from quick (172), `summary:*` carry-forward (190) and corrupt-entry drops (199), legacy agency-hub sync metadata (217,244), `knownAccounts` defaults (276).
- `describe('sanitizeSettings')` (289): clamps counts (290-315), uiTheme fallback (315), trims key (323), canonicalizes URL (328), Stage 32 vendor-key drop (362).
- Style: constructs raw records with explicit `schemaVersion` then asserts `result.schemaVersion` / field values.

**(c) Options DOM test — `tests/options-agency-hub.test.ts` (~600+ lines).**
- Uses **JSDOM** (`import { JSDOM } from 'jsdom'`, 2); `installDom()` (89-105) creates `<div id="chatgoose-options-root">` and `vi.stubGlobal`s `window`/`document`/`navigator`/`HTMLElement`/`HTMLInputElement`/`HTMLButtonElement`/`HTMLSelectElement`/`Node`/`Event`.
- `makeState(overrides?)` (34-59) builds a full `PersistedState` with bundled Lora persona.
- DOM query helpers by visible text: `getSectionByTitle(title)` finds `<section>` by `<h2>` textContent (107-115); `getGrantAccessButton`/`getTestConnectionButton` find buttons by `textContent.includes(...)` (117-135).
- `loadOptionsPage(state, options)` (137-...) wires mocked `permissions.contains/request`, `runtime.sendMessage`, `storage.set`; captures `savedSettings` and (v13) `savedCustody` separately (11-12,141-142).
- `createDeferred<T>()` (62-71) and `createPermissionsEvent()` (73-87) for async/event assertions.

**(d) Protocol validation test — `tests/protocol.test.ts`.**
- Imports `getRuntimeRequestType`, `isBackgroundPortMessage`, `isContentPortMessage` from `../src/shared/protocol.js` (2-6).
- `describe('protocol boundary guards')` (8): asserts each request `type` string round-trips through `getRuntimeRequestType(...)` (e.g. `getPopupStatus`, `getSessionsSnapshot`, `testAgencyHubConnection`, `issueAgencyHubDeviceToken`, `resolveFanChat`, `getSpendersList`) and rejects malformed envelopes. Style: many small `expect(...).toBe(...)` assertions; comments cite the shipped regressions each case guards against (E8/E23/Stage 35). A new request type / port message would need a case added here and would be caught by this suite if missing.

**Also directly relevant:** `tests/kernel-feature-gateway.test.ts` — the SSE-frame/gateway adapter test. `sseResponse(frames)` builds `event: ai\ndata: {json}\n\n` bodies (41-47); `META`/`request()`/`settings()` fixtures (10-58); `fetchMock` injected via `createKernelFeatureGateway(fetchMock)`; asserts refs+clientContext on the wire, frame fan-out, gate-message mapping, and fail-closed termination. Other useful ones: `tests/persona-sync.test.ts`, `tests/storage-coordinator.test.ts`, `tests/storage-v13-token-custody.test.ts`, `tests/summary-cache.test.ts`, `tests/transcript.test.ts`, `tests/runtime-api.test.ts`, `tests/session-capture.test.ts`, `tests/kernel-sdk-vendor.test.ts`, `tests/acceptance-reporter.test.ts`.

---

**Extra facts likely load-bearing for the Coach feature:**
- There is **no existing "Coach" feature, no recap-status GET, and no session/transcript cache keyed for Coach** in the current tree — this is greenfield. The nearest analogues: fan-summary ("Recap") uses `SummaryCacheStore` keyed `summary:{groupId}` in `storage.local`; the SDK GET pattern to copy is `AgencyHubClient.getConversationProfile` (agency-hub-client.ts:287-305) / `pageFanProfile` op.
- `FeatureType` union + `FEATURE_POLICIES` live in `/Users/dmitriy/code/chatgoose/src/shared/features.ts` and `types.ts`; a new AI feature is added there, plus `FEATURE_LABELS` (constants.ts:168) and `getFeaturePolicy` (drives `resultKind`/`promptMode`/`messageCountBucket` used at operations.ts:350, 2692).
- The kernel feature route is fixed: `aiFeatureStream` `POST /api/v1/ai/features/:feature` (operations.d.ts:218-221); a Coach generation would reuse `streamAiFeature` with a new `feature` value, while a recap-status metadata check would be a new GET op added to `kernelOperations`/`routeSchemas` and called via `createClient(...).<opKey>(...)`.