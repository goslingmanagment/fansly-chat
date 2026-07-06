> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Background — Storage Coordinator, Context Loader, Spenders Service & Hub Usage Reporter

## Scope

Territory map for four background-worker modules, read from source at commit `f4b413f`:

- `src/background/storage-coordinator.ts` — in-memory authoritative mirror of `browser.storage.local`, account-identity bookkeeping, summary-cache write funnel.
- `src/background/conversation-context-loader.ts` — despite the file name, this contains only `loadMediaPurchaseEvidence` (PPV purchase-state verification). It does **not** assemble cached fan-summaries or Agency Hub stored profiles; see the discrepancy note in its section.
- `src/background/spenders-service.ts` — builds the ranked top-spenders board over Fansly conversations + per-fan earnings.
- `src/background/agency-hub-usage-reporter.ts` — buffers/debounces/retries AI-usage events and POSTs them to the Agency Hub `ai-usage/batch` endpoint.

The Agency Hub / Fansly REST **wire contracts** (URLs, headers, request/response shapes) are documented in `docs/project-kernel/boundaries.md`; this map describes how these four files **consume** those boundaries, not the wire contracts themselves.

---

## 1. `storage-coordinator.ts` — `StorageCoordinator`

Single owner of the process's cached view of `browser.storage.local`. Constructed once in the composition root (`background/index.ts:19`) and passed to `OperationCoordinator`, `runtime-api`, and the storage-change listener.

### Imports / dependencies
| Symbol | From | Use |
|---|---|---|
| `KNOWN_ACCOUNTS_KEY` (`'knownAccounts'`), `STORAGE_SCHEMA_VERSION` (`7`), `SUMMARY_EVICTION_COUNT` (`10`) | `../shared/constants.js` | storage key + schema/eviction constants |
| `migrateState` | `../shared/migrations.js` | run migrations on every patch |
| `loadStorageState`, `sanitizeSettings` | `../shared/storage.js` | initial load + settings normalization |
| `getSummaryCacheEntry`, `SummaryCacheStore` | `../shared/summary-cache.js` | read/write per-conversation summary cache |
| types `PersistedState`, `SummaryCacheEntry` | `../shared/types.js` | |

### Module-level helpers
- `arraysEqual(left, right)` — length + positional equality of `string[]`.
- `applyRawStoragePatch(state, setItems, removeKeys=[])` (`:18`) — the core reducer. Builds `raw = { ...state, ...setItems }`, deletes each `removeKeys` entry, runs `migrateState(raw)`, then `sanitizeSettings(nextState.settings)`, and forces `schemaVersion` to `STORAGE_SCHEMA_VERSION` if not numeric. Returns the new `PersistedState`. Every in-place state mutation in the class goes through this, so migrations + settings sanitization run on every patch, not just at load.

### State held
- `state: PersistedState | null` — the authoritative mirror (`null` until first load).
- `loadingState: Promise<PersistedState> | null` — de-dupes concurrent first-load calls.
- `writeQueue: Promise<void>` — serializes all mutating operations (see `enqueueWrite`).
- `summaryCache: SummaryCacheStore` — constructed with `browser.storage.local`, a `() => this.getState()` state supplier, `evictionCount: SUMMARY_EVICTION_COUNT`, and `afterSet`/`afterRemove` callbacks that call `commitLocalWrite(...)` so the in-memory mirror stays consistent after the store writes directly to `browser.storage.local`.

`PersistedState` shape (from `shared/types.ts:98`): `{ schemaVersion, settings, personalities, accountMappings: Record<string,string>, accountAliases: Record<string,string>, knownAccounts: string[] }`.

### Public methods

- **`init(): Promise<PersistedState>`** (`:54`) — thin wrapper that just calls `getState()`. Migrations are *not* run directly here; they run inside `loadStorageState()` (which `getState()` triggers) and inside `applyRawStoragePatch`. Called fire-and-forget at `index.ts:77` (`void storageCoordinator.init()`).

- **`getState(): Promise<PersistedState>`** (`:58`) — returns cached `state` if present; else lazily calls `loadStorageState()` once (guarded by `loadingState`), stores the result in `this.state`, and clears `loadingState` in `.finally`. `loadStorageState()` (`shared/storage.ts:62`) does `browser.storage.local.get(null)`, collects invalid summary keys, `migrateState`, `sanitizeSettings`, reconciles bundled personalities, removes invalid summary keys, and writes the whole state back **only if** `schemaVersion` differs or personalities changed — i.e. a first `getState()` can itself perform a `storage.local.remove` and/or `storage.local.set`.

- **`applyStorageChanges(changes, areaName): void`** (`:77`) — the `browser.storage.onChanged` sink. No-op unless `areaName === 'local'` and `state` is loaded. Splits `changes` into `setItems` (has `newValue`) and `removeKeys` (`newValue === undefined`); returns early if both empty; otherwise replaces `this.state = applyRawStoragePatch(...)`. **Does not broadcast** — UI refresh is driven separately by `index.ts` (see Broadcasting below).

- **`registerKnownAccount(accountId): Promise<void>`** (`:102`) — enqueued write. No-op on empty id or if already in `knownAccounts`. Otherwise appends + `.sort()`, does `browser.storage.local.set({ knownAccounts })`, then `commitLocalWrite`. Called from `index.ts:42` inside the session-capture callback (`await storageCoordinator.registerKnownAccount(accountId)`).

- **`reconcileKnownAccounts(activeCanonicalAccountIds): Promise<PersistedState>`** (`:119`) — enqueued write. Recomputes `knownAccounts` as the sorted union of the (truthy-filtered) active canonical ids and `Object.keys(state.accountMappings)`. If unchanged (`arraysEqual`) returns current state without writing; else `storage.local.set({ knownAccounts })`, `commitLocalWrite`, returns new state (`?? state`). Called from `runtime-api.ts:183` in the `getSessionsSnapshot` handler.

- **`rekeyAccountIdentity(legacyAccountId, resolvedAccountId): Promise<{ state, mappingMigrated, mappingConflict, knownAccountsChanged }>`** (`:140`) — enqueued write. Migrates state from a legacy (pre-resolution) account id to the canonical resolved id. Logic:
  - No-op (all flags false) when either id is empty or the two are equal.
  - Records an alias: `accountAliases[legacyAccountId] = resolvedAccountId` (only if not already set).
  - If **both** `accountMappings[legacy]` and `accountMappings[resolved]` exist → deletes the legacy mapping, sets `mappingConflict = true` (resolved wins, legacy discarded).
  - Else if **only** `accountMappings[legacy]` exists → moves it to `resolvedAccountId`, deletes legacy, sets `mappingMigrated = true`.
  - Rewrites `knownAccounts`, replacing `legacyAccountId` with `resolvedAccountId` (deduped via `Set`, `.sort()`), computes `knownAccountsChanged`.
  - If any of mappings/aliases/knownAccounts changed → single `storage.local.set({ accountMappings, accountAliases, knownAccounts })`, then `commitLocalWrite`, returns the new state + flags. Otherwise returns unchanged state + flags.
  - Called from `runtime-api.ts:176` in `getSessionsSnapshot` for every session whose `resolvedAccountId` differs from its `legacyAccountId`.

- **Summary-cache pass-throughs** (all funnel through `enqueueWrite` except the read):
  - `getSummaryCache(groupId): Promise<SummaryCacheEntry | null>` (`:222`) — read-only; `getSummaryCacheEntry(await getState(), groupId)`. Not enqueued.
  - `saveSummaryCache(groupId, entry)` (`:227`) — `summaryCache.save(...)`.
  - `updateSummaryCache(groupId, updater): Promise<SummaryCacheEntry | null>` (`:233`) — `summaryCache.update(...)`.
  - `removeSummaryCache(groupId)` (`:242`) — `summaryCache.remove(...)`.
  - `SummaryCacheStore` (`shared/summary-cache.ts:186`) writes summary entries under keys `` `${SUMMARY_CACHE_PREFIX}${groupId}` `` directly to `browser.storage.local`; on a quota failure during `save` it evicts up to `SUMMARY_EVICTION_COUNT` (10) invalid+oldest keys then retries. Its `afterSet`/`afterRemove` hooks re-sync the coordinator mirror via `commitLocalWrite`.

### Private methods
- `commitLocalWrite(setItems, removeKeys=[]): PersistedState | null` (`:248`) — returns `null` if no state; else `this.state = applyRawStoragePatch(this.state, setItems, removeKeys)` and returns it. This is the "mirror updater" invoked after every direct `storage.local` write so callers don't wait for the `onChanged` round-trip.
- `enqueueWrite<T>(task): Promise<T>` (`:260`) — serializes tasks on `writeQueue` using `.then(task, task)` (task runs regardless of the previous task's success/failure); `writeQueue` itself always resolves (errors swallowed) so one failed write does not deadlock the chain.

### Broadcasting
`StorageCoordinator` itself sends no port/runtime messages. Broadcasting is the caller's job: `index.ts:68` registers `browser.storage.onChanged`, calls `applyStorageChanges`, and — for `areaName === 'local'` when any changed key is in `UI_RELEVANT_KEYS` (`'settings'`, `'personalities'`, `'accountMappings'`, `'accountAliases'`, `'knownAccounts'`, `'schemaVersion'`) — calls `coordinator.refreshAllTabs('settings:changed')`.

### Storage keys touched
`'knownAccounts'`, `'accountMappings'`, `'accountAliases'`, whole-state writes (via `loadStorageState`), and `` `${SUMMARY_CACHE_PREFIX}<groupId>` `` keys (via `SummaryCacheStore`).

---

## 2. `conversation-context-loader.ts` — `loadMediaPurchaseEvidence`

> **Discrepancy — file name vs contents.** The assignment (and the file name) suggest this module assembles prior conversation context (cached fan-summary + Agency Hub stored profile) before prompt build, via `summary-cache` and `AgencyHubClient.fetchFanProfileByConversation`. **It does not.** The file exports a single function, `loadMediaPurchaseEvidence`, concerned only with verifying PPV (pay-per-view) media purchase states. The Agency Hub profile fetch (`fetchFanProfileByConversation`) actually lives in `agency-hub-client.ts:532` and is called from `operations.ts:1145`; cached-fan-summary assembly lives in `operations.ts` (see `prefetchAgencyHubSummary` / summary-cache-hit paths around `operations.ts:1610–1726`) and `shared/summary-cache.ts`. None of that is in this file.

### Imports / dependencies
| Symbol | From |
|---|---|
| `FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT` (`10`) | `../shared/constants.js` |
| `toDebugErrorPayload` | `../shared/errors.js` |
| `logDebug` | `../shared/log.js` |
| `buildPurchaseEvidence`, `collectUnverifiedPpvAttachmentRequests`, type `PurchaseEvidenceOverride` | `../shared/transcript.js` |
| types `FanslyMessagePageResponse`, `SessionTemplate` | `../shared/types.js` |
| type `FanslyClient` | `./fansly-client.js` |

### `loadMediaPurchaseEvidence({ fanslyClient, pages, fanAccountId, session, signal, debugEnabled }): Promise<PurchaseEvidenceOverride>` (`:15`)
Control flow:
1. If `fanAccountId` is null → return `{}` (no evidence).
2. `inlineEvidence = buildPurchaseEvidence(pages, fanAccountId)` — derives purchase state already present in the loaded message `pages`.
3. `unresolved = collectUnverifiedPpvAttachmentRequests(pages, inlineEvidence)` — PPV attachments whose purchase state can't be inferred inline.
4. If `unresolved.length === 0` → return `{}`.
5. `capped = unresolved.slice(0, FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT)` (max **10**); `capOverflow = unresolved.length > capped.length`.
6. `try`: `verified = await fanslyClient.verifyMediaPurchaseStates(capped, fanAccountId, session, signal)` (Fansly REST call, contract in `fansly-client.ts:552`), returns `{ ...verified, verificationIncomplete: Boolean(verified.verificationIncomplete || capOverflow) }`.
7. `catch`: if `signal.aborted` → rethrow (abort propagates to the operation). Otherwise **fail-open**: `logDebug(debugEnabled, 'media purchase verification failed (fail-open)', { fanAccountId, requested, capOverflow, error })` and return `{ verificationIncomplete: true }`.

`PurchaseEvidenceOverride` (`shared/transcript.ts:32`): `{ purchasedSingleIds?, purchasedBundleIds?, checkedNotPurchasedSingleIds?, checkedNotPurchasedBundleIds?, verificationIncomplete? }`.

### Boundary crossings
- **Fansly REST (indirect):** via `fanslyClient.verifyMediaPurchaseStates(...)`. This module passes already-loaded `pages` in and reads no DOM and no storage itself.
- No storage, no IPC, no DOM directly.

### Callers
- `operations.ts:1824` (single-operation transcript build).
- `compare-operations.ts:756` (multi-draft / Multi transcript build).
Both pass `messageLoad.pages`, the resolved `fanAccountId`, `validated.session`, the operation `signal`, and `debugEnabled`.

---

## 3. `spenders-service.ts` — `SpendersService`

Builds the ranked top-spenders board. The header comment states Fansly exposes no "all fans by spend" endpoint, so this enumerates the creator's conversations and fetches lifetime earnings per fan (one call each), bounded, cached per creator. Constructed at `index.ts:21` (`new SpendersService(fanslyClient)`).

### Imports / dependencies
| Symbol | From | Value / use |
|---|---|---|
| `SPENDERS_CACHE_TTL_MS` | `../shared/constants.js` | `10 * 60 * 1000` (10 min) cache window |
| `SPENDERS_EARNINGS_CONCURRENCY` | `../shared/constants.js` | `4` — per-fan earnings fan-out width |
| `SPENDERS_MAX_FANS` | `../shared/constants.js` | `150` — conversation scan cap |
| `mapWithConcurrency` | `../shared/concurrency.js` | bounded parallel map |
| types `FanslyAccountResponse`, `SessionTemplate`, `SpenderListEntry`, `SpendersListResult` | `../shared/types.js` | |
| type `FanslyClient` | `./fansly-client.js` | |

> `SPENDERS_BUILD_TIMEOUT_MS` (`120_000`, 120s) is **not** referenced in this file. The build timeout is applied by the caller `runtime-api.ts:225` which wraps `getList` in an `AbortController` (`setTimeout(() => controller.abort(), SPENDERS_BUILD_TIMEOUT_MS)`).

Module-local: `ACCOUNT_NAME_BATCH = 50` (`:21`); `isAbortError(error)` → `error instanceof DOMException && error.name === 'AbortError'` (`:28`); `interface CacheEntry { builtAt: number; result: SpendersListResult }`.

### State held
- `cache: Map<string, CacheEntry>` — keyed by `cacheKey(session)` = `session.resolvedAccountId ?? session.accountId` (`:37`). One entry per creator.

### `getList(session, signal, options?: { refresh?: boolean }): Promise<SpendersListResult>` (`:41`)
1. `key = cacheKey(session)`, `now = Date.now()`.
2. Unless `options.refresh` is truthy: if a cache entry exists and `now - builtAt < SPENDERS_CACHE_TTL_MS` (10 min) → return the cached `result` (no Fansly calls).
3. `{ fans, truncated } = await fanslyClient.listFanAccounts(SPENDERS_MAX_FANS, session, signal)` — **Fansly REST** `GET /api/v1/messaging/groups` (paged), returns up to 150 `{ groupId, fanAccountId }` (deduped by fan). `truncated` = more conversations exist beyond the scanned set.
4. `spend = await mapWithConcurrency(fans, SPENDERS_EARNINGS_CONCURRENCY /*4*/, fan => ({ fan, lifetimeMills: await fetchLifetimeMills(fan.fanAccountId, now, session, signal) }))`.
5. **Abort surfacing:** after the fan-out settles, `if (signal.aborted) throw new DOMException('Aborted', 'AbortError')`. Because per-fan fetches swallow aborts (returning `$0`, see `fetchLifetimeMills`), a timeout would otherwise silently yield a partial/empty board; this re-check turns it into a thrown abort before any board is built or cached.
6. `payers = spend.filter(row => row.lifetimeMills > 0)`.
7. `nameById = await resolveNames(payers.map(fanAccountId), session, signal)`.
8. Build `entries: SpenderListEntry[]` = for each payer: `{ fanAccountId, groupId, displayName: account?.displayName ?? null, username: account?.username ?? null, lifetimeMills, lifetimeUsd: lifetimeMills / 1000 }`, then `.sort((a,b) => b.lifetimeMills - a.lifetimeMills)` (descending spend).
9. `result: SpendersListResult = { entries, builtAt: now, fanCount: entries.length, scannedCount: fans.length, truncated }`.
10. `cache.set(key, { builtAt: now, result })`; return `result`.

`SpenderListEntry` / `SpendersListResult` shapes are in `shared/types.ts:716` / `:728`. `lifetimeMills` = Fansly "mills"; `lifetimeUsd = lifetimeMills / 1000`.

### Private methods
- `fetchLifetimeMills(fanAccountId, nowMs, session, signal): Promise<number>` (`:117`) — `try { const earnings = await fanslyClient.getEarnings(fanAccountId, 0, nowMs, session, signal); return earnings?.totalGross ?? 0 } catch { return 0 }`. **Fansly REST** `GET /api/v1/account/wallets/earnings/stats/accounts` over the window `[0, now]` (lifetime). **All** failures, including aborts, become `0` — deliberately, so one failing/aborted worker cannot reject the whole `mapWithConcurrency` batch or orphan siblings.
- `resolveNames(fanAccountIds, session, signal): Promise<Map<string, FanslyAccountResponse>>` (`:131`) — iterates in `ACCOUNT_NAME_BATCH` (50) chunks calling `fanslyClient.getAccountNames(batch, session, signal)` — **Fansly REST** `GET /api/v1/account?ids=`. On abort → rethrow (`isAbortError`); on any other error → swallow (names are cosmetic; ids/usernames render blank). Populates the map by `account.id`.
- `invalidate(session): void` (`:156`) — `cache.delete(cacheKey(session))`. **No callers found anywhere in `src`** (grep for `.invalidate(` on the spenders service returns nothing); currently dead code — cache entries expire only by TTL or `refresh: true`.

### Boundary crossings
- **Fansly REST** (all via `FanslyClient`): `listFanAccounts` → `/api/v1/messaging/groups`; `getEarnings` → `/api/v1/account/wallets/earnings/stats/accounts`; `getAccountNames` → `/api/v1/account`.
- **IPC:** exposed to the UI via the one-shot `getSpendersList` runtime request (`runtime-api.ts:216`), returning `SpendersListResponse` (`{ ok:true, result }` or `{ ok:false, error }`). The handler requires a connected session (else `not_connected`), reads `refresh` from `message.refresh === true`, wraps `getList` in the 120s abort timeout, and maps an `AbortError` to a `timed_out` user error.

### Callers
- `runtime-api.ts:230` (`getSpendersList`). Wired at `index.ts:21`/`:50`.

---

## 4. `agency-hub-usage-reporter.ts` — `AgencyHubUsageReporter`

Buffers AI-usage telemetry, debounces + batches it per Agency Hub target, retries on failure, and submits via `AgencyHubClient.submitAiUsageBatch` → **POST `api/v1/ai-usage/batch`** (wire contract in `boundaries.md`). Constructed at `index.ts:26` (`new AgencyHubUsageReporter(agencyHubClient)`) and passed into `OperationCoordinator`.

### Imports / dependencies
| Symbol | From | Value |
|---|---|---|
| `AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS` | `../shared/constants.js` | `100` |
| `AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS` | `../shared/constants.js` | `1_000` |
| `AGENCY_HUB_AI_USAGE_REPORT_MAX_ATTEMPTS` | `../shared/constants.js` | `3` |
| `AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS` | `../shared/constants.js` | `[5_000, 15_000]` |
| `AGENCY_HUB_AI_USAGE_REPORT_TIMEOUT_MS` | `../shared/constants.js` | `5_000` |
| `normalizeAgencyHubBaseUrl` | `../shared/agency-hub.js` | base-URL normalization |
| `logDebug` | `../shared/log.js` | |
| types `AgencyHubAiUsageEvent`, `Settings` | `../shared/types.js` | |
| type `AgencyHubClient` (only `Pick<..., 'submitAiUsageBatch'>`) | `./agency-hub-client.js` | |

Internal types: `QueuedUsageEvent { event: AgencyHubAiUsageEvent; attempts: number }`; `UsageReporterTargetState { baseUrl, apiKey, debugEnabled, events: QueuedUsageEvent[], flushTimer: number | null, flushing: boolean }`; `UsageReporterSettings = Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'debugMode'>`.

### State held
- `queuesByTarget: Map<string, UsageReporterTargetState>` — one independent queue/timer/flush-lock **per (baseUrl, apiKey) pair**, so switching Hub credentials starts a fresh buffer. Key built by `buildTargetKey(baseUrl, apiKey)` = `` `${baseUrl} ${apiKey}` `` (NUL separator).

### `enqueue(settings, event): void` (`:39`)
1. `baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl)`, `apiKey = settings.agencyHubApiKey.trim()`.
2. If either is empty → **silently drop** the event (no queue created).
3. `key = buildTargetKey(...)`; `state = getOrCreateTargetState(...)`.
4. `state.events.push({ event: { ...event }, attempts: 0 })` (defensive shallow copy of the event), refresh `state.debugEnabled` from `settings.debugMode`, then `ensureFlushScheduled(key, state)`.

### Scheduling / lifecycle
- `ensureFlushScheduled(key, state, delayMs = AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS /*1000*/)` (`:89`) — no-op if a timer is already set or a flush is in progress; else `state.flushTimer = setTimeout(() => { flushTimer = null; void flushTarget(key) }, delayMs)`. This is the debounce: bursts of enqueues within 1s coalesce into one flush.
- `cleanupTargetState(key, state)` (`:104`) — deletes the target's queue from the map once `events` is empty, `flushTimer` is null, and not `flushing`.
- `requeueFailedBatch(state, batch): number | null` (`:117`) — increments `attempts` on each event, keeps only those with `attempts < AGENCY_HUB_AI_USAGE_REPORT_MAX_ATTEMPTS` (3), and `unshift`s the survivors back to the **front** of the queue (retried before newer events). Returns the retry delay = `AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS[min(highestAttempt - 1, len - 1)]` (i.e. `5_000` after 1st failure, `15_000` after 2nd), falling back to the last delay or `DEBOUNCE_MS`. Returns `null` when nothing is retriable (all events exhausted their 3 attempts and are dropped).

### `flushTarget(key): Promise<void>` (`:145`)
1. Return if no `state`.
2. If `state.flushing` → `ensureFlushScheduled` and return (never runs two flushes concurrently for one target).
3. If `events.length === 0` → `cleanupTargetState`, return.
4. Set `flushing = true`. Loop while `events.length > 0`:
   - `batch = state.events.splice(0, AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS /*100*/)` — drains up to 100.
   - New `AbortController` + `setTimeout(() => controller.abort(), AGENCY_HUB_AI_USAGE_REPORT_TIMEOUT_MS /*5000*/)` — per-batch 5s network timeout.
   - `result = await agencyHubClient.submitAiUsageBatch({ settings: { agencyHubBaseUrl: state.baseUrl, agencyHubApiKey: state.apiKey }, events: batch.map(q => q.event), signal })`.
   - `logDebug(state.debugEnabled, 'agency hub ai usage batch', { baseUrl, status, reason, eventCount, response })`.
   - If `result.status === 'failed'` → `retryDelayMs = requeueFailedBatch(state, batch)` and `break`.
   - **`thrown`/timeout:** `catch` → `retryDelayMs = requeueFailedBatch(...)`, `logDebug(..., status:'failed', reason: error.message ?? 'thrown')`, `break`.
   - `finally`: `clearTimeout(timeoutHandle)`.
5. Outer `finally`: `flushing = false`; if events remain → `ensureFlushScheduled(key, state, retryDelayMs ?? DEBOUNCE_MS)`; else `cleanupTargetState`.

> **Behavior note — `skipped` is treated as success.** The loop only requeues when `result.status === 'failed'`. `submitAiUsageBatch` returns `status: 'skipped'` for `missing_base_url`, `missing_api_key`, `empty_batch`, and **`missing_host_permission`** (`agency-hub-client.ts:333–364`). In all those cases the spliced batch is **not** requeued and is dropped. So if the Hub host permission is absent, buffered usage events are silently discarded rather than retried. (`status: 'submitted'` also falls through, which is the intended success path.)

### AI-usage event contents (`AgencyHubAiUsageEvent`, `shared/types.ts:753`)
Each event carries:
| Field | Meaning |
|---|---|
| `clientEventId` | idempotency key; the operation id (compare path uses `` `${operationId}:${cardId}` ``) |
| `feature` | `FeatureType` (single-op path uses `payload.feature`; compare path hardcodes `'fast-reply'`) |
| `model` | `getAgencyHubModelId(model)` (registry-mapped Hub model id, `model-registry.ts:241`) |
| `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens` | from the operation's `LlmSpendSummary` (all zero for cache/prefetch hits) |
| `conversationId` | `string \| null` — the URL group id |
| `durationMs` | `max(0, completedAtMs - startedAtMs)` or `null` when `startedAtMs` is not numeric |
| `isCacheHit` | boolean |
| `isRegeneration` | boolean (`Boolean(payload.forceRegenerate)`) |
| `completedAt` | `new Date(completedAtMs).toISOString()` |

### When events are enqueued
Constructed by `buildAiUsageEvent` and handed to `enqueue`:

- **`operations.ts` (single-op, method `OperationCoordinator.buildAiUsageEvent` at `:905`, enqueued via `enqueueCompletedOperationUsage` → `agencyHubUsageReporter.enqueue` at `:948`):**
  - Summary-cache hit (`:1636`) — `spend = zeroSpend`, `isCacheHit: true`, `isRegeneration: forceRegenerate`.
  - Agency Hub prefetched-summary hit (`:1710`) — `spend = zeroSpend`, `isCacheHit: true`.
  - Normal completion (`:2552`) — `spend = latestLlmSpend ?? zero`, `isCacheHit: Boolean(result.summaryMeta?.cached)`, `model = actualModel`, `feature = payload.feature`.
- **`compare-operations.ts` (multi-draft, module-level `buildAiUsageEvent` at `:164`, enqueued at `:1244` via `context.agencyHubUsageReporter.enqueue`):** one event **per card** on `cardComplete`, `feature: 'fast-reply'` (hardcoded), `isCacheHit: false`, `clientEventId = ` `` `${payload.operationId}:${card.id}` ``.

In every case, `enqueue` receives a settings slice `{ agencyHubBaseUrl, agencyHubApiKey, debugMode }` from `validated.storage.settings`; when Hub base URL or key is blank the event is dropped at the top of `enqueue`.

### Boundary crossings
- **Agency Hub (network, consumed):** `submitAiUsageBatch` → `POST api/v1/ai-usage/batch` (Bearer `agencyHubApiKey`, base URL `agencyHubBaseUrl`). Contract in `boundaries.md`. Result consumed here: `{ status: 'submitted'|'skipped'|'failed', reason, baseUrl, response? }`, where `response` (present on `submitted`) is `AgencyHubAiUsageBatchResponse` `{ receivedCount, insertedCount, dedupedCount }`.
- No storage, DOM, or port IPC. Only `enqueue` is called by other background modules.

### Callers
- `operations.ts` (`enqueueCompletedOperationUsage`), `compare-operations.ts` (`context.agencyHubUsageReporter.enqueue`). Wired at `index.ts:26`/`:34`.

---

## Cross-module dependency summary
- `StorageCoordinator` → `shared/storage.ts` (`loadStorageState`, `sanitizeSettings`), `shared/migrations.ts` (`migrateState`), `shared/summary-cache.ts` (`SummaryCacheStore`, `getSummaryCacheEntry`), `browser.storage.local`. Consumed by `index.ts`, `runtime-api.ts`, `operations.ts`, `compare-operations.ts`.
- `loadMediaPurchaseEvidence` → `FanslyClient.verifyMediaPurchaseStates`, `shared/transcript.ts`. Consumed by `operations.ts`, `compare-operations.ts`.
- `SpendersService` → `FanslyClient` (`listFanAccounts`, `getEarnings`, `getAccountNames`), `shared/concurrency.ts` (`mapWithConcurrency`). Consumed by `runtime-api.ts` (`getSpendersList`).
- `AgencyHubUsageReporter` → `AgencyHubClient.submitAiUsageBatch`, `shared/agency-hub.ts` (`normalizeAgencyHubBaseUrl`). Consumed by `operations.ts`, `compare-operations.ts`.

## Open questions / discrepancies
1. **`conversation-context-loader.ts` name vs contents.** The file contains only `loadMediaPurchaseEvidence` (PPV verification), not fan-summary / Agency-Hub-profile assembly. The behavior the file name implies lives in `operations.ts` (summary-cache + `prefetchAgencyHubSummary` paths) and `agency-hub-client.ts` (`fetchFanProfileByConversation`).
2. **`SpendersService.invalidate` is uncalled** (no references in `src`). The spenders cache is only bypassed by the 10-min TTL or an explicit `refresh: true`.
3. **`AgencyHubUsageReporter` drops events on `status: 'skipped'`** (including `missing_host_permission`) without retry — only `'failed'` triggers requeue. Events whose attempts reach 3 are also dropped by `requeueFailedBatch`.
4. **`applyStorageChanges` does not broadcast**; UI refresh depends on `index.ts`'s `onChanged` listener re-checking `UI_RELEVANT_KEYS`. A write path that mutates the mirror via `commitLocalWrite` but whose changed key set is not in `UI_RELEVANT_KEYS` would not trigger a tab refresh (all keys these modules write — `settings`, `personalities`, `accountMappings`, `accountAliases`, `knownAccounts`, `schemaVersion` — are in the set; summary-cache keys are not, and are not expected to refresh tabs).
