> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Background — Compare / Multi-Draft Engine

## Scope

This document maps the "compare" / "Multi" multi-draft engine, covering exactly two source files:

- `src/background/compare-operations.ts` (~1333 lines) — the background orchestrator that, in one pass, generates several personality "cards" (drafts) for one Fansly conversation and streams each independently to the content script.
- `src/shared/compare-cards.ts` (159 lines) — the card model, personality-mapping resolution, the bundled draft-card catalog, and content fingerprinting helpers.

Supporting symbols in other files (the DI context, the lifecycle registry, message types, the build-time drafts plugin, and call sites) are described only insofar as these two files touch them. The four external network boundaries (Fansly REST, Anthropic, OpenRouter, Agency Hub) are documented in full in `docs/project-kernel/boundaries.md`; this file describes only how the compare engine crosses them.

---

## 1. What the feature is

"Compare" (surfaced in the UI as "Multi") produces N draft replies for a single fan in one operation. Each draft is a **card**: one system/user prompt built from one personality, streamed by one LLM call, rendered as one tab/panel in the content overlay. The card set is:

- optionally the **mapped personality** for the current creator account (`source: 'current'`), prepended first; plus
- the **bundled draft cards** (`source: 'draft'`) — markdown files shipped in `prompts/drafts/`, compiled into the bundle via a virtual module.

`compare-operations.ts` owns the runtime operation (streaming, concurrency, cancellation, usage reporting). `compare-cards.ts` owns the pure resolution of *which* cards exist and their content.

The engine runs entirely under the **`fast-reply` feature identity**: it reads `settings.featureModels['fast-reply']`, `settings.featureReasoning['fast-reply']`, calls `buildPromptRequest({ feature: 'fast-reply', … })`, and reports usage with `feature: 'fast-reply'`. There is no dedicated "compare" feature policy.

---

## 2. `src/shared/compare-cards.ts`

### 2.1 Imports and data model

```
import modelCardDrafts from 'virtual:model-card-drafts';   // Record<string,string>, build-time virtual module
import { buildAccountLookupOrder } from './account-aliases.js';
import type { CompareModelCard, PersistedState } from './types.js';
```

Card types live in `src/shared/types.ts:40-48`:

```ts
interface CompareDraftCard { id: string; label: string; content: string; }
interface CompareModelCard extends CompareDraftCard { source: 'draft' | 'current'; }
```

- `id` — for draft cards this is the draft's file basename (label); for the mapped personality it is `current:${personality.id}` (`compare-cards.ts:98`).
- `label` — display name (draft basename, or personality name, possibly suffixed `" (current)"`).
- `content` — the personality/draft body used as the system prompt personality.
- `source` — `'draft'` or `'current'`.

### 2.2 The bundled draft source

`virtual:model-card-drafts` is a **build-time virtual module** (declared in `src/virtual-drafts.d.ts` as `Record<string,string>`). Two independent implementations produce it:

- **esbuild** (`esbuild.config.mjs:26-65`, `modelCardDraftsPlugin`): on resolve of `virtual:model-card-drafts`, reads `prompts/drafts/`, keeps `*.md` files, sorts them with `localeCompare('en', {sensitivity:'base', numeric:true})`, and emits `export default { "<basename-without-.md>": <fileContents>, … }`. On any `readdir` failure it yields `{}` (empty catalog). A file watcher (`esbuild.config.mjs:142-162`) rebuilds when `drafts` changes.
- **vitest** (`vitest.config.ts:14-58`, `loadDrafts` + `chatgoose-virtual-drafts` plugin): same directory, same filter/sort, `export default <json>`; `{}` on error.

Runtime override hook (`compare-cards.ts:5-14`):

```ts
type CompareDraftOverrideGlobal = typeof globalThis & { __CHATGOOSE_COMPARE_DRAFTS__?: Record<string,string> };
function getCompareDraftSource(): Record<string,string> {
  return globalThis.__CHATGOOSE_COMPARE_DRAFTS__ ?? modelCardDrafts;
}
```

Every draft-reading function goes through `getCompareDraftSource()`, so a test/host can override the whole catalog by setting `globalThis.__CHATGOOSE_COMPARE_DRAFTS__`.

> Discrepancy / state note: the working tree has **no `prompts/drafts/` directory** (verified: `prompts/` holds only feature prompt `*.md` files; `prompts/drafts` is missing). With the real bundle, `getCompareDraftSource()` therefore returns `{}` and `getCompareDraftCount()` returns `0`. Consequences downstream (see §3): `resolveCompareModelCards` yields at most the single mapped-personality card, and `executeCompare` then throws `compare_cards_unavailable` because it requires `>= 2` cards. Draft cards only appear once `prompts/drafts/*.md` files exist (or the global override is set). This is the actual behavior, not a name/comment mismatch.

### 2.3 Exported / internal functions

| Symbol | Kind | Behavior |
|---|---|---|
| `resolveMappedPersonalityId(accountMappings, resolvedAccountId, legacyAccountId, accountAliases={})` | export `compare-cards.ts:16-35` | Builds candidate account IDs via `buildAccountLookupOrder(accountAliases, resolvedAccountId, legacyAccountId)`; returns the first `accountMappings[accountId]` that is truthy, else `null`. |
| `getCompareDraftCount()` | export `:37-39` | `Object.keys(getCompareDraftSource()).length`. |
| `normalizeLabel(label)` | internal `:41-43` | `label.trim().toLowerCase()`. |
| `compareDraftNames(left, right)` | internal `:45-50` | `localeCompare('en', {sensitivity:'base', numeric:true})` — same sort as the build plugin. |
| `resolveCompareDraftCards(drafts)` | export `:52-63` | `Object.entries(drafts)` sorted by label, mapped to `{ id: label, label, content, source: 'draft' }`. |
| `getDraftCards()` | internal `:65-67` | `resolveCompareDraftCards(getCompareDraftSource())`. |
| `resolveCompareModelCardsForPersonality(storage, personalityId)` | export `:69-78` | Delegates to `resolveCompareModelCardsForDrafts(storage, personalityId, getCompareDraftSource())`. |
| `resolveCompareModelCardsForDrafts(storage, personalityId, drafts)` | export `:80-105` | See below. |
| `resolveCompareModelCards(storage, resolvedAccountId, legacyAccountId)` | export `:107-119` | Resolves `personalityId` via `resolveMappedPersonalityId(storage.accountMappings, …, storage.accountAliases)`, then `resolveCompareModelCardsForPersonality`. This is the entry point used by the background engine. |
| `hashString(seed, value)` | internal `:121-128` | FNV-1a-style: `hash ^= charCodeAt; hash = Math.imul(hash, 16777619); return hash>>>0`. |
| `fingerprintCompareCardContents(cards)` | export `:130-139` | Folds `${content.length}:` then `content` for each card into an FNV seed `2166136261`; returns 8-char zero-padded hex. Order-sensitive. |
| `getCompareCardsFingerprint(storage, resolvedAccountId, legacyAccountId)` | export `:141-149` | Fingerprint of `resolveCompareModelCards(...)`. |
| `getCompareCardsFingerprintForPersonality(storage, personalityId)` | export `:151-158` | Fingerprint of `resolveCompareModelCardsForPersonality(...)`. |

**`resolveCompareModelCardsForDrafts` detail** (`:80-105`):
1. `draftCards = resolveCompareDraftCards(drafts)`.
2. Look up `personality` by `personalityId` in `storage.personalities` (null if `personalityId` is null or not found).
3. If no personality → return `draftCards` unchanged.
4. Else build a `currentCard`: `id = current:${personality.id}`, `source = 'current'`, `content = personality.content`. If any draft label matches the personality name under `normalizeLabel` (case/space-insensitive), `label` becomes `"${personality.name} (current)"`; otherwise the raw `personality.name`.
5. Return `[currentCard, ...draftCards]` — the current card is always **first**.

### 2.4 Who calls `compare-cards.ts`

- `src/background/compare-operations.ts:7,654` — `resolveCompareModelCards` (the runtime card set).
- `src/background/operations.ts:33-35` — imports `getCompareDraftCount`, `resolveMappedPersonalityId`; used in `buildTabUiState` (`:694-722`, sets `compareCardCount = compareDraftCount + (mappedPersonalityId ? 1 : 0)` and `compareDraftCount`) and `prefetchAvailableSummary` (`:761`).
- `src/background/runtime-api.ts:5,102,112` — `resolveMappedPersonalityId` + `getCompareDraftCount` when building popup status.
- `src/content/index.ts:34-35,1517` — `getCompareCardsFingerprintForPersonality` in `computeCompareFingerprint`, used to detect a stale cached compare panel.
- `tests/compare-cards.test.ts`, `tests/operations.test.ts` — coverage.

The fingerprint helpers exist to let the content script decide whether a previously-completed compare panel (cached client-side) still matches the current card set/personality contents; the background engine itself does not read the fingerprints.

---

## 3. `src/background/compare-operations.ts`

### 3.1 Imports (boundary-relevant)

Shared: `COMPARE_TEMPERATURE` (=`0.35`), `DEFAULT_FEATURE_MODELS`, `QUICK_OPERATION_TIMEOUT_MS` (=`60_000`), `STREAM_CHUNK_FLUSH_MS` (=`50`) from `../shared/constants.js`; `resolveCompareModelCards` from `../shared/compare-cards.js`; `aggregateMonthlyEarnings`, `formatFanSpendingData` from `../shared/earnings.js`; `ChatGooseError`, `toUserError` from `../shared/errors.js`; `logDebug`; model-registry helpers (`getAgencyHubModelId`, `getModelDisplayName`, `getModelEntry`, `isAnthropicModelSelection`); `buildPromptRequest` from `../shared/prompts.js`; `normalizeReplyParts` from `../shared/reply-output.js`; `formatFanSubscriptionData`; `formatTranscript`, `normalizeTranscript`; many `../shared/types.js` types.

Background: `llm-cost.js` (`buildLlmSpendSummary`, `createZeroLlmSpendSummary`, `estimateLlmCost`, `formatModelCostLog`, `formatModelUsageLog`); `FanslyClient` + `SubscriptionLookupTraceEvent` types; `operation-profiling.js` (`createOperationProfiler`, `OperationProfiler`); `operation-cleanup.js` (`clearFlushTimer`, `clearFlushTimers`); `OperationTimeoutController`; `CompareOperationLifecycle` type from `operation-registry.js`; `operation-utils.js` (`describeMessageLoadProgress`, `describeSubscriptionTraceStep`, `errorCode`, `parseGroupIdFromUrl`, `resolveAbortChatGooseError`); `SessionStore`, `StorageCoordinator`, `TabContextStore`, `AgencyHubUsageReporter`, `LlmClient` types; `loadMediaPurchaseEvidence` from `conversation-context-loader.js`.

### 3.2 State shapes

```ts
interface ActiveCompareCardState {        // :80-85 — one per card
  card: Pick<CompareModelCard,'id'|'label'|'source'>;
  rawText: string;      // full accumulated LLM text
  flushBuffer: string;  // text not yet flushed to content
  flushTimer: number | null;
}
interface ActiveCompareOperation {        // :87-96 — one per tab operation
  operationId; tabId; groupId; routeNonce; startedAtMs;
  controller: AbortController;
  profiler: OperationProfiler;
  compareCards: Map<string, ActiveCompareCardState>;  // keyed by card.id
}
interface CompareOperationsContext {      // :98-108 — DI surface (built by OperationCoordinator.getCompareContext, operations.ts:2638)
  lifecycle: CompareOperationLifecycle<ActiveCompareOperation>;
  sessionStore; tabContexts; storageCoordinator; fanslyClient; llmClient;
  agencyHubUsageReporter: Pick<AgencyHubUsageReporter,'enqueue'>;
  hasPort: (tabId)=>boolean;
  send: (tabId, message: BackgroundPortMessage)=>void;
}
interface ValidatedCompareStart {         // :110-117
  tab; urlGroupId; storage; session; legacyAccountId; messageCount;
}
const NO_OP_PROFILER = createOperationProfiler(false);  // :119
```

`compareCards` on `ActiveCompareOperation` is the only per-operation store; it is held in the `OperationRegistry.compareByTabId` map (one active compare per tab). Compare state is tracked **separately** from feature operations — feature operations own `tabContexts.activeOperationId`; compare does not (comment at `:500`).

### 3.3 The DI context and call sites

`CompareOperationsContext` is built once per call by `OperationCoordinator.getCompareContext()` (`operations.ts:2638-2650`), wiring the coordinator's own stores plus `hasPort: tabId => this.portsByTabId.has(tabId)` and `send: (tabId,msg) => this.send(tabId,msg)` where `send` is `this.portsByTabId.get(tabId)?.postMessage(message)` (`operations.ts:831-833`).

Public entry points and their triggers:

| Export | Called from | Trigger |
|---|---|---|
| `executeCompare(context, tabId, payload)` | `OperationCoordinator.startCompare` (`operations.ts:2660-2665`) ← `handlePortMessage` case `'compare:start'` (`operations.ts:572-573`) | content sends `compare:start` port message. |
| `cancelCompareOperation(context, tabId, error?, notifyDiscard=false)` | `OperationCoordinator.cancelCompare` (`operations.ts:2652-2658`) | `compare:cancel` matching operationId (`:582-587`), route change (`:679-681`, error `chat_changed`, `notifyDiscard=true`), tab removed (`:547`), port disconnect (`:507`), and internally from `executeCompare`'s catch. |
| `hasActiveCompare(context, tabId)` | not called outside file directly; the registry method `lifecycle.hasActiveCompare` is used instead in `operations.ts` (`:679`) and `operation-registry.ts` (`isBusy`). | — |

### 3.4 Helper functions

- `hasApiKeyForSelectedCompareModel(storage)` (`:121-139`) — resolves the `fast-reply` model via `getModelEntry(storage.settings.featureModels['fast-reply'])`. If no entry: ok if either `claudeApiKey` or `openRouterApiKey` is set. If provider `anthropic`: needs `claudeApiKey`. If `openrouter`: needs `openRouterApiKey`. Otherwise `{ ok:false, provider }`.
- `buildCompareCardProfilingSnapshot(profiler, usage?, cost?)` (`:141-156`) — `profiler.snapshot()` merged with `{ llmUsage }` / `{ llmCost }` when present; `undefined` when the profiler has no snapshot (debug off).
- `buildLlmSpendPayload(llmSpend?)` (`:158-162`) — `{ llmSpend }` or `{}`.
- `buildAiUsageEvent({...})` (`:164-197`) — constructs an `AgencyHubAiUsageEvent` with **`feature: 'fast-reply'`** (hard-coded), `model: getAgencyHubModelId(model)`, token counts from the `LlmSpendSummary`, `conversationId`, `durationMs = max(0, completedAtMs - startedAtMs)` (or `null`), `isCacheHit: false`, `isRegeneration`, `completedAt: ISO string`. `clientEventId` is supplied by the caller as `${operationId}:${cardId}` (`:1251`).

### 3.5 The send wrappers (message types crossing the port)

All go through `context.send(tabId, …)` → `port.postMessage`. Profiling is attached only when the profiler has a snapshot (debug mode).

| Wrapper (`compare-operations.ts`) | `type` value | Payload highlights |
|---|---|---|
| `sendCompareReady` `:199` | `compare:ready` | `operationId`, `fanDisplayName`, `cards: [{id,label,source}]` (the full card list). |
| `sendCompareProgress` `:207` | `compare:progress` | `phase`, `message`, `currentPage`, `targetPages`, `fanDisplayName`, optional `profiling`. |
| `sendCompareChunk` `:221` | `compare:chunk` | `operationId`, `cardId`, `text` (streamed delta). |
| `sendCompareCardComplete` `:229` | `compare:cardComplete` | `operationId`, `cardId`, `result: FeatureResult`, `fanDisplayName`, `llmSpend`, `profiling`. |
| `sendCompareCardError` `:244` | `compare:cardError` | `operationId`, `cardId`, `error: UserFacingError`, `llmSpend`, `profiling`. |
| `sendCompareError` `:259` | `compare:error` | `operationId`, `error`, `profiling` (operation-level failure, no `llmSpend` field). |
| `sendCompareComplete` `:272` | `compare:complete` | `operationId`, `fanDisplayName`, `profiling`. |
| `sendCompareDiscarded` `:285` | `compare:discarded` | `operationId`, `error`, `profiling`. |

These correspond 1:1 to the `BackgroundPortMessage` union members in `types.ts:984-1000`. The content-side inbound messages are `CompareStartPayload` / `CompareCancelPayload` (`types.ts:831-850`) in `ContentPortMessage`.

### 3.6 Chunk buffering (per card)

Streaming text is coalesced per card to avoid one `postMessage` per token:

- `flushCompareChunks(context, tabId, operation, cardId)` (`:305-329`) — if the card has a `flushBuffer`, empties it, clears the timer, and emits one `compare:chunk` with the buffered text.
- `scheduleCompareChunkFlush(context, tabId, operation, cardId)` (`:331-345`) — if no timer pending, sets a `setTimeout(flush, STREAM_CHUNK_FLUSH_MS)` = **50 ms**. The timer id is stored on `cardState.flushTimer`.

Each card flushes on its own 50 ms cadence, independently of other cards.

### 3.7 `validateCompareStart` (`:347-392`)

Runs before any state is committed:
1. `Promise.all([browser.tabs.get(tabId), storageCoordinator.getState()])`.
2. `urlGroupId = parseGroupIdFromUrl(tab.url)`. Throws `ChatGooseError('chat_changed')` if the tab URL does not include `fansly.com`, has no group id, or `urlGroupId !== payload.groupId`.
3. Reads `session = sessionStore.getSessionForTab(tabId)` and `legacyAccountId = sessionStore.getAccountIdForTab(tabId)`.
4. `hasApiKeyForSelectedCompareModel(storage)` — throws `ChatGooseError('missing_api_key', { details:{provider} })` if not ok.
5. Throws `ChatGooseError('no_personalities')` if `storage.personalities.length === 0`.
6. Throws `ChatGooseError('not_connected')` if `!legacyAccountId || !session`.
7. Throws `ChatGooseError('session_expired')` if `!session.connected`.
8. Returns `{ tab, urlGroupId, storage, session, legacyAccountId, messageCount: storage.settings.quickMessageCount }`.

> Note: the "no personalities" guard fires even though compare can be built entirely from draft cards. If `storage.personalities` is empty, compare is rejected before any card resolution runs.

### 3.8 Lifecycle helpers

- `getActiveCompare(context, tabId)` (`:298-303`) — `lifecycle.getCompare(tabId)`.
- `clearCompareOperation(context, tabId)` (`:394-406`) — if an active compare exists, `lifecycle.completeCompare(tabId, op => clearFlushTimers(op.compareCards.values()))` (deletes from map, removes cancelled id, clears all timers).
- `cancelCompareOperation(context, tabId, error?, notifyDiscard=false)` (`:415-442`) — if active, `lifecycle.cancelCompare(...)` (adds `operationId` to cancelled set, `controller.abort()`, clears all card timers, deletes from map). If `notifyDiscard`, emits `compare:discarded` with `toUserError(error ?? new ChatGooseError('chat_changed'))`.
- `hasActiveCompare(context, tabId)` (`:408-413`) — `lifecycle.hasActiveCompare(tabId)`.

The registry (`operation-registry.ts`) maintains `compareByTabId` (active ops) and `cancelledCompareOperationIds` (a `Set<string>`), plus a shared `reservedTabIds`. `isBusy(tabId)` = active feature OR active compare OR reserved (`operation-registry.ts:73-79`). `reserve` fails if busy.

### 3.9 `executeCompare` — control flow

Signature: `executeCompare(context, tabId, payload: CompareStartPayload): Promise<void>` (`:444-1333`).

`CompareStartPayload` (`types.ts:831-840`): `type:'compare:start'`, `operationId`, `groupId`, `routeNonce`, `domFanDisplayName`, optional `forceRegenerate`, `replyMode`, `replyTone`.

**Guard prelude** (`:449-471`):
- If `lifecycle.isBusy(tabId)` → emit `compare:error` (`another_operation`), return.
- If `!context.hasPort(tabId)` → silent return (no port to stream to).
- `lifecycle.reserve(tabId)` synchronously **before the first await** so a racing start cannot slip past during `validateCompareStart`. If reserve fails → `compare:error` (`another_operation`), return.

Local mutable trackers: `timeoutController`, `controller`, `debugEnabled` — used by the `finally` and the `catch`.

**Main try** (`:475-1286`):

1. **Validate + arm** (`:476-506`):
   - `validated = await validateCompareStart(...)`; `debugEnabled = storage.settings.debugMode`.
   - `profiler = createOperationProfiler(debugEnabled)`.
   - `OperationTimeoutController<'quick-total'>`; `.arm('quick-total', QUICK_OPERATION_TIMEOUT_MS)` = **60 s**.
   - `compareController = new AbortController()`; `signal = AbortSignal.any([compareController.signal, timeoutController.signal])` — the shared abort signal passed to every Fansly and LLM call.
   - Build `active: ActiveCompareOperation` (empty `compareCards` map).
   - `lifecycle.activateCompare(tabId, active)`; `tabContexts.setRoute(tabId, urlGroupId, routeNonce)`.

2. **Progress plumbing** (`:508-609`): closures over mutable `progressPhase/Message/CurrentPage/TargetPages/FanDisplayName`.
   - `sendCompareOperationProgress(updates?)` merges updates and emits `compare:progress`.
   - `sendDebugCompareProgress(updates?)` — no-op unless `profiler.enabled` (debug mode); the profiling stage transitions send debug progress only.
   - `startStage/completeStage/failStage/skipStage` wrap `profiler.*Stage` + `profiler.log` + `sendDebugCompareProgress`.

3. **Resolve account identity** (`:611-647`, stage `resolve-identity`): `fanslyClient.getAuthenticatedAccountId(session, signal)` → `resolvedAccountId`. On failure logs stage + rethrows.

4. **Rekey + resolve cards** (`:649-674`):
   - `rekeyResult = await storageCoordinator.rekeyAccountIdentity(legacyAccountId, resolvedAccountId)`; `storage = rekeyResult.state` (**re-read** post-rekey; note `validated.storage` is still used later for `settings`).
   - `compareCards = resolveCompareModelCards(storage, resolvedAccountId, legacyAccountId)` (from `compare-cards.ts`).
   - **`if (compareCards.length < 2) throw ChatGooseError('compare_cards_unavailable')`** — compare requires at least 2 cards.
   - Seed `active.compareCards` map: one `ActiveCompareCardState` per card (`rawText:''`, `flushBuffer:''`, `flushTimer:null`).

5. **Announce cards** (`:676-686`): emit `compare:ready` with `fanDisplayName` (= `domFanDisplayName ?? 'fan'` at this point) and the full `cards: [{id,label,source}]`. Then one `sendCompareOperationProgress()`.
   - `resolvedModel = validated.storage.settings.featureModels['fast-reply']` (`:688`) — the model used for all cards.

6. **Load messages** (`:690-721`, stage `load-messages`): `fanslyClient.loadMessages(urlGroupId, validated.messageCount, session, signal, onProgress)`. `messageCount = settings.quickMessageCount`. The progress callback emits `compare:progress` (`phase:'loading-messages'`, `currentPage/targetPages`, `"Loading messages… X/Y pages"`).

7. **Group lookup** (`:723-751`, stage `group-lookup`): `fanslyClient.getGroup(urlGroupId, session, signal)`; `groupUsers` = users with a non-empty `userId`. **Fail-open**: on error logs the stage as failed and continues with `groupUsers = null`.

8. **Identify fan + purchase evidence** (`:753-771`):
   - `fanAccountId = groupUsers?.find(u => u.userId !== resolvedAccountId)?.userId ?? null`.
   - `purchaseEvidence = await loadMediaPurchaseEvidence({ fanslyClient, pages: messageLoad.pages, fanAccountId, session, signal, debugEnabled })` (media-purchase enrichment — a Fansly boundary crossing owned by `conversation-context-loader.ts`).
   - `transcriptMessages = normalizeTranscript(messageLoad.pages, resolvedAccountId, fanAccountId, purchaseEvidence)` — normalizes *after* group lookup so labels use fan-perspective purchase state; falls back to `"unknown"` when `fanAccountId` is null.

9. **Fan display name** (`:772-811`, stage `account-name-lookup`): if `fanAccountId`, `fanslyClient.getAccountNames([fanAccountId], session, signal)`; `fanDisplayName = username || displayName || domFanDisplayName || 'fan'`. Fail-open on error. Skipped when no `fanAccountId`.
   - `tabContexts.setFan(tabId, fanAccountId, fanDisplayName)` (`:813`).
   - Progress → `phase:'loading-earnings'`, `"Loading fan context…"`.

10. **Earnings + subscription** (`:822-970`): only if `fanAccountId`. Stages `earnings` + `subscription-lookup`. Runs **three** Fansly calls concurrently via `Promise.allSettled`:
    - `fanslyClient.getMonthlyEarnings(fanAccountId, 0, windowEndMs, session, signal)`
    - `fanslyClient.getEarnings(fanAccountId, 0, windowEndMs, session, signal)`
    - `fanslyClient.getFanSubscriptionContext(urlGroupId, fanAccountId, session, signal, 'full', [handleSubscriptionTrace])` — the trace callback is passed **only when `profiler.enabled`** (`:853-868`); otherwise the 5-arg overload.
    - Earnings assembly (`:889-933`): if stats fetch succeeded uses it; else if monthly rows exist, synthesizes an `AggregatedEarnings` from `aggregateMonthlyEarnings(monthlyRows)` (summing `totalGross`/`totalNet`, empty `breakdown`). `spendingData = formatFanSpendingData(aggregated)`. If neither → fail-open (empty `spendingData`).
    - Subscription (`:935-962`): if fulfilled and truthy, `subscriptionData = formatFanSubscriptionData(value)`; trace steps logged into stage detail. Fail-open otherwise.
    - When `!fanAccountId`, both stages `skipStage(... 'fan account unavailable')` and `spendingData`/`subscriptionData` stay empty (`:963-970`).

11. **Build prompt inputs** (`:972-999`, stage `prompt-build`): `formattedTranscript = formatTranscript(transcriptMessages)`; `promptInputs = { transcript, fanSpendingData, fanSubscriptionData, fanDisplayName, replyMode: payload.replyMode ?? 'default', replyTone: payload.replyTone ?? 'none' }`. Progress → `phase:'generating'`, `"Generating compare replies…"`.

12. **Per-card generation** — `runCard` (`:1001-1260`), run for all cards with **`await Promise.all(compareCards.map(runCard))`** (`:1262`). Full concurrency: every card streams simultaneously, sharing one `signal`, one `resolvedModel`, one `promptInputs`, one profiler.

    Inside `runCard(card)`:
    - **Liveness re-check** (`:1002-1008`): bail if the active op is gone or its `operationId` changed (superseded/cancelled).
    - **Prompt build per card** (`:1010-1024`): `buildPromptRequest({ feature:'fast-reply', personality:{ id:card.id, name:card.label, content:card.content, updatedAt:Date.now() }, transcript, fanSpendingData, fanSubscriptionData, fanDisplayName, replyMode, replyTone }, validated.storage.settings.promptCachingEnabled)` → `{ systemBlocks, userBlocks }`. Each card wraps its draft/personality content as a synthetic `personality`.
    - **`streamToCard(model)`** (`:1033-1128`): sets `actualModel = model`; reads `reasoningEffort = settings.featureReasoning['fast-reply']`; calls `context.llmClient.streamMessage({ settings, model, temperature: COMPARE_TEMPERATURE (0.35), systemBlocks, userBlocks, feature:'fast-reply', reasoningEffort, signal, onText, onUsage, onReasoningObserved, onStopReason })`.
      - `onText(chunk)`: re-fetches active op, matches `operationId`, appends to `cardState.rawText` and `cardState.flushBuffer`, `scheduleCompareChunkFlush`. If the op/card is gone the chunk is dropped.
      - `onUsage(usage)`: computes `cost = estimateLlmCost(actualModel, usage)`, `spend = buildLlmSpendSummary(actualModel, usage, cost)`; stores `cardUsage/cardCost/cardSpend` (copies); logs; debug progress.
      - `onReasoningObserved(sig)`: one-shot flag `reasoningObserved`; logs.
      - `onStopReason(sr)`: stores `latestStopReason`.
      - `.then(text)`: if `reasoningEffort !== 'off' && !reasoningObserved`, logs "Reasoning observed: no".
    - **Model fallback + error classification** (`:1130-1182`): first attempt `streamToCard(resolvedModel)`. On throw:
      - `defaultModel = DEFAULT_FEATURE_MODELS['fast-reply']`.
      - `isModelError` = error key `model_unavailable`.
      - `abortError = resolveAbortChatGooseError(error, { active: Boolean(getActiveCompare), timeoutSignal, cancelSignal })`.
      - If `isModelError && isAnthropicModelSelection(resolvedModel) && resolvedModel !== defaultModel` → retry `streamToCard(defaultModel)` (per-card silent fallback to the default Anthropic model).
      - Else if `abortError.key === 'timed_out'` → **rethrow** (propagates to the operation-level catch, failing the whole op).
      - Else if `abortError.key === 'chat_changed'` → **return** (silently drop this card; the cancel path handles cleanup).
      - Else → clear this card's flush timer (so a buffered chunk can't fire after cardError while siblings stream), build a profiling snapshot, emit `compare:cardError` with `error = toUserError(abortError ?? error)` and `llmSpend = cardSpend ?? createZeroLlmSpendSummary()`, return.
    - **Post-stream liveness** (`:1184-1197`): re-check op + card; if a pending flush timer is cleared, immediately `flushCompareChunks` to emit remaining buffered text before completion.
    - **Output validation** (`:1199-1221`): `parts = normalizeReplyParts(rawText)`. If `latestStopReason === 'max_tokens'` OR `parts.length === 0` → `compare:cardError` with `ChatGooseError('ai_output_unusable')` and the card's spend; return.
    - **Card complete** (`:1223-1259`): `result: FeatureResult = { rawText, splitModeRequested: payload.replyMode === 'preferSplit', parts }`. Emit `compare:cardComplete` with `result`, `fanDisplayName`, `llmSpend = cardSpend ?? zero`, and a fresh profiling snapshot. Then `agencyHubUsageReporter.enqueue({ agencyHubBaseUrl, agencyHubApiKey, debugMode }, buildAiUsageEvent({ clientEventId: `${operationId}:${cardId}`, model: actualModel, spend, conversationId: urlGroupId, startedAtMs: activeCompare.startedAtMs, completedAtMs, isRegeneration: Boolean(payload.forceRegenerate) }))`. Each card enqueues one Agency Hub `ai-usage` event (feature `fast-reply`).

13. **Completion** (`:1264-1286`):
    - Re-fetch `completedActive`. If missing or `operationId` changed → the session was cancelled/superseded but every card swallowed the abort (returned rather than threw), so the catch never ran; call `lifecycle.forgetCancelledCompare(payload.operationId)` to stop the cancelled-id set from growing, then return (no `compare:complete`).
    - Else emit `compare:complete` (`operationId`, `fanDisplayName`) and `clearCompareOperation` (completes + clears timers).

**Catch** (`:1287-1328`):
- `active = getActiveCompare`; `operationId = active?.operationId ?? payload.operationId`.
- If `lifecycle.consumeCancelledCompare(operationId)` → this operation was already cancelled; swallow and return (no error emitted).
- `active?.profiler.finalizeRunningStages('compare failed')`.
- `abortError = resolveAbortChatGooseError(error, { active, timeoutSignal, cancelSignal })`. Emit `compare:error`: if `abortError` and active → `toUserError(abortError)`; if abortError and not active → `chat_changed`; else `toUserError(error)`.
- `cancelCompareOperation(context, tabId)` (aborts, clears timers, re-adds cancelled id), then `lifecycle.forgetCancelledCompare(operationId)` (terminal failure — nothing late to suppress).

**Finally** (`:1329-1332`): `lifecycle.releaseReservation(tabId)`; `timeoutController?.clearAll()`.

### 3.10 Concurrency, cancellation, supersession model

- **One active compare per tab**, tracked in `compareByTabId`; `reserve()` guards the window between the sync guard and `activateCompare`.
- **All cards stream concurrently** under a single `AbortSignal.any([cancelSignal, timeoutSignal])`. Aborting cancels every in-flight card.
- **Two aborts, different fates** inside a card: `timed_out` rethrows (kills the whole operation → catch → `compare:error`); `chat_changed` returns silently (each card independently drops). This asymmetry is why the completion block (`:1264-1274`) must detect a silently-superseded operation and prune the cancelled id manually.
- **Cancelled-id set** (`cancelledCompareOperationIds`): added on `cancelCompare`, drained by `consumeCancelledCompare` (catch) or `forgetCancelledCompare` (both the superseded-completion path and the terminal-failure path) to prevent unbounded growth. This is the same double-bookkeeping pattern the feature path uses in `operations.ts`.
- **Liveness checks** guard every callback and continuation by re-reading `getActiveCompare` and comparing `operationId`, so a stale card cannot write chunks or completion for a superseded operation.
- **Flush-timer discipline**: on card error the card's timer is cleared to prevent a stray `compare:chunk` after `compare:cardError`; on card complete a pending flush is forced first so buffered text is not lost.

### 3.11 Caching

`compare-operations.ts` holds **no result cache of its own**. It relies on:
- FanslyClient-internal caches (messages, groups, account names, subscription context) — same caches the single-op path uses.
- `storageCoordinator.rekeyAccountIdentity` (identity/alias reconciliation, shared).
- The **content script** owns `completedCompareCache` (keyed by groupId) and uses `getCompareCardsFingerprintForPersonality` (`content/index.ts:1517`) to decide whether a cached completed panel is still valid — the background never persists compare results.
- `compare-cards.ts` computes fingerprints purely from card `content` (order-sensitive FNV over `length:` + content).

### 3.12 Sharing with the single-op / feature path

The compare engine **duplicates rather than reuses** the single-op message/earnings loading logic. It performs the same sequence the single `fast-reply` operation does (identity → rekey → loadMessages → getGroup → purchase evidence → normalizeTranscript → account names → earnings/subscription → prompt build), but implemented inline in `executeCompare`, with its own profiler stages and its own `compare:*` message vocabulary, rather than calling shared operation helpers. What is genuinely shared:
- Same `FanslyClient` methods (identity, messages, group, account names, monthly earnings, earnings, subscription context, media-purchase evidence).
- Same `LlmClient.streamMessage`, `buildPromptRequest`, `normalizeReplyParts`, `normalizeTranscript`, `formatTranscript`, earnings/subscription formatters.
- Same `OperationTimeoutController<'quick-total'>` / `QUICK_OPERATION_TIMEOUT_MS` (60 s), `STREAM_CHUNK_FLUSH_MS` (50 ms), profiler, and cost/usage/spend helpers.
- Same `OperationRegistry` reservation/cancellation machinery (compare-specific methods).
Divergences: `temperature` is fixed at `COMPARE_TEMPERATURE` (0.35) rather than a feature default; the operation fans out into N parallel LLM streams; `feature` is always `'fast-reply'` regardless of which card.

---

## 4. External boundaries touched

Only the compare engine's crossings are listed; full contracts live in `docs/project-kernel/boundaries.md`.

| Kind | Target | Where | Data crossing |
|---|---|---|---|
| browser-api | `browser.tabs.get(tabId)` | `validateCompareStart` `:353` | reads tab `url` for group-id validation. |
| network (Fansly) | `getAuthenticatedAccountId` | `:621` | resolves creator account id. |
| network (Fansly) | `loadMessages(groupId, count, …)` | `:700` | conversation pages; `count = settings.quickMessageCount`. |
| network (Fansly) | `getGroup(groupId, …)` | `:726` | group users → identify fan. Fail-open. |
| network (Fansly) | `loadMediaPurchaseEvidence` → FanslyClient (via `conversation-context-loader`) | `:756` | per-message purchase state. |
| network (Fansly) | `getAccountNames([fanAccountId], …)` | `:776` | fan username/displayName. Fail-open. |
| network (Fansly) | `getMonthlyEarnings`, `getEarnings`, `getFanSubscriptionContext` | `:870-887` | per-fan spend + subscription context (Promise.allSettled, fail-open). |
| network (Anthropic / OpenRouter via `LlmClient`) | `llmClient.streamMessage(...)` per card | `:1040` | model `settings.featureModels['fast-reply']` (with fallback to `DEFAULT_FEATURE_MODELS['fast-reply']`), `temperature=0.35`, `feature:'fast-reply'`, reasoning `featureReasoning['fast-reply']`; streams text/usage/reasoning/stopReason. |
| network (Agency Hub) | `agencyHubUsageReporter.enqueue({agencyHubBaseUrl, agencyHubApiKey, debugMode}, event)` | `:1244` | one `AgencyHubAiUsageEvent` per completed card (`feature:'fast-reply'`, `clientEventId=${operationId}:${cardId}`) → eventually `POST api/v1/ai-usage/batch`. |
| storage | `storageCoordinator.getState()` | `:354` | reads `settings`, `personalities`, `accountMappings`, `accountAliases`, `quickMessageCount`, api keys, `debugMode`, `promptCachingEnabled`, `agencyHub*`. |
| storage | `storageCoordinator.rekeyAccountIdentity(legacy, resolved)` | `:649` | reconciles/persists account identity aliases; returns fresh state. |
| ipc (port, Background→Content) | `compare:ready` / `compare:progress` / `compare:chunk` / `compare:cardComplete` / `compare:cardError` / `compare:error` / `compare:complete` / `compare:discarded` | `send*` wrappers | see §3.5 table. |
| ipc (port, Content→Background) | `compare:start` / `compare:cancel` | dispatched in `operations.ts:572,582` | `CompareStartPayload` / `CompareCancelPayload`. |
| dom | none directly | — | compare-operations does no DOM read/write; the content script reads the conversation and writes the composer. `payload.domFanDisplayName` is a DOM-derived value passed in via IPC. |
| distribution (build) | `virtual:model-card-drafts` | `compare-cards.ts:1`, `esbuild.config.mjs`, `vitest.config.ts` | `prompts/drafts/*.md` compiled into the bundle as `Record<basename, contents>`. |

---

## 5. Cross-module dependencies

- `compare-operations.ts` → `compare-cards.ts` (`resolveCompareModelCards`) — the single call that resolves the card set at runtime.
- `compare-operations.ts` depends on: `constants` (`COMPARE_TEMPERATURE`, `QUICK_OPERATION_TIMEOUT_MS`, `STREAM_CHUNK_FLUSH_MS`, `DEFAULT_FEATURE_MODELS`), `earnings`, `errors`, `model-registry`, `prompts`, `reply-output`, `subscriptions`, `transcript`, `types`; and background `llm-cost`, `fansly-client`, `operation-profiling`, `operation-cleanup`, `operation-timeouts`, `operation-registry` (type), `operation-utils`, `session-store`/`tab-context`/`storage-coordinator`/`agency-hub-usage-reporter`/`llm-client` (types), `conversation-context-loader`.
- `compare-cards.ts` depends on: `account-aliases` (`buildAccountLookupOrder`), `types`, and the `virtual:model-card-drafts` module.
- Callers of these two files: `operations.ts` (`OperationCoordinator` — builds the context, dispatches `compare:start`/`compare:cancel`, and independently uses `resolveMappedPersonalityId`/`getCompareDraftCount` for tab UI state), `runtime-api.ts` (popup status), `content/index.ts` (fingerprint for cached-panel staleness), and the test suites.

---

## 6. Open questions / discrepancies

1. **No `prompts/drafts/` directory in the tree.** `getCompareDraftSource()` therefore returns `{}` in real builds → `getCompareDraftCount() === 0` → `resolveCompareModelCards` yields at most 1 card (the mapped personality) → `executeCompare` throws `compare_cards_unavailable` (needs `>= 2`). So with the current tree the Multi feature is effectively unavailable unless `prompts/drafts/*.md` files or the `__CHATGOOSE_COMPARE_DRAFTS__` global override are supplied. Actual behavior, not a naming issue.
2. **`no_personalities` gate blocks draft-only compare.** `validateCompareStart` rejects when `storage.personalities.length === 0`, even though a valid card set could consist solely of draft cards. A user with zero personalities but ≥2 draft cards still cannot run compare.
3. **Two `storage` snapshots in flight.** `validated.storage` (pre-rekey) is used for all `settings` reads (`featureModels`, `featureReasoning`, `promptCachingEnabled`, api keys, `agencyHub*`, `debugMode`), while the post-rekey `storage` (`:653`) is used only to resolve the card set. Settings changes made between validation and rekey would not be picked up for the run; the card set uses the fresher state.
4. **`resolvedModel` captured once.** All cards use `validated.storage.settings.featureModels['fast-reply']`; per-card fallback only ever switches to `DEFAULT_FEATURE_MODELS['fast-reply']` and only for Anthropic selections on a `model_unavailable` error. There is no per-card model selection.
5. **Usage event feature is hard-coded `'fast-reply'`.** Every compare card's Agency Hub usage event reports `feature:'fast-reply'` (`buildAiUsageEvent` `:184`), so compare usage is indistinguishable from single fast-reply usage in the Hub, aside from `clientEventId` carrying `${operationId}:${cardId}`.
6. **Boundary contracts referenced, not re-derived.** The full external-contract tables live in `docs/project-kernel/boundaries.md`; the boundary references above only note this engine's crossings.
