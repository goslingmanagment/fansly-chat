> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# 04 — Background: the compare / "Multi" multi-draft engine

This map covers the compare (a.k.a. "Multi") engine — the background operation
that fans out several draft variants for one fan and streams each into its own
tab of the inline panel. The engine lives in
`src/background/compare-operations.ts`; the card catalog it draws from lives in
`src/shared/compare-cards.ts`.

## What "Multi" / compare does

The compare engine takes one fan conversation, resolves a set of "model cards"
(persona/draft variants), and runs **one generation per card in parallel**,
streaming every card's text into a separate tab in the inline compare panel.
The entry point is `executeCompare(context, tabId, payload)`
(`src/background/compare-operations.ts:384`), reached from the port router:
`operations.ts` handles the `compare:start` frame
(`src/background/operations.ts:512-513`) → `startCompare`
(`operations.ts:2473-2478`) → `executeCompare`. The content script sends
`compare:start` when the "Multi" button fires
(`src/content/index.ts:913-922`).

Post-1.6.0 (Stage 32) each card is **one kernel `fast-reply` generation** routed
through the kernel feature lane, not a vendor LLM call. The comment at
`compare-operations.ts:966-970` states the design: "a compare card = one kernel
fast-reply generation with the card's persona. Only kernel-known personas can
run ('current' cards — the mapped personality, kernel-synced); local draft cards
died with the local prompt library (the folder was already absent from shipped
builds — the recorded 32.1 deviation)."

### Actual current behavior: the draft catalog is empty, so compare is effectively unavailable

The engine requires **at least two cards** or it aborts:
`if (compareCards.length < 2) throw new ChatGooseError('compare_cards_unavailable')`
(`compare-operations.ts:599-601`). Cards come from `resolveCompareModelCards`
(`compare-operations.ts:594-598`), which returns `[currentCard, ...draftCards]`
(`compare-cards.ts:100`). The only draft cards come from the
`virtual:model-card-drafts` catalog, and **that catalog resolves to an empty
object in shipped builds** (see next section). With zero draft cards, the engine
can produce at most one card — the account's mapped personality ("current"). As
a result:

- The "Multi" button is disabled: `state.compareCardCount < 2` gates it in
  `src/content/button-bar.ts:195`, and `compareCardCount` is computed as
  `compareDraftCount + (mappedPersonalityId ? 1 : 0)` in
  `src/background/operations.ts:671` and `src/background/runtime-api.ts:132`,
  where `compareDraftCount = getCompareDraftCount()` (currently `0`).
- If a start is nonetheless issued, the content guard rejects it with a
  `compare_cards_unavailable` toast (`src/content/index.ts:888-891`), and the
  background would throw the same error at `compare-operations.ts:599-601`.
- Even if a draft card existed, `runCard` rejects any card whose `source` is not
  `'current'` up front with a per-card `compare_cards_unavailable` error
  (`compare-operations.ts:971-986`).

So the multi-**persona** fan-out that the name and older docs imply is inert:
today the engine's only runnable card is the single "current" personality card,
which is below the two-card minimum.

## Persona / draft-variant sourcing and the model-card-drafts catalog

Card resolution lives entirely in `src/shared/compare-cards.ts`:

- **Draft cards** are built from a `Record<string,string>` (label → content) by
  `resolveCompareDraftCards` (`compare-cards.ts:52-63`); each becomes a card with
  `source: 'draft'`, sorted stably by `localeCompare` with numeric collation
  (`compare-cards.ts:45-50`).
- **The "current" card** is the account's mapped personality:
  `resolveMappedPersonalityId` (`compare-cards.ts:16-35`) walks the account
  lookup order (aliases → resolved id → legacy id) against
  `storage.accountMappings`, and `resolveCompareModelCardsForDrafts`
  (`compare-cards.ts:76-101`) prepends a card with `source: 'current'`, id
  `current:${personality.id}`, content = `personality.content`. Its label is the
  personality name, suffixed `" (current)"` if a draft shares the name
  (`compare-cards.ts:90-98`).

### `virtual:model-card-drafts` resolves to `{}` at build time

`compare-cards.ts:1` imports `modelCardDrafts` from `virtual:model-card-drafts`.
`getCompareDraftSource` (`compare-cards.ts:9-14`) returns
`globalThis.__CHATGOOSE_COMPARE_DRAFTS__` if a test/runtime override is present,
otherwise the virtual module.

The virtual module is materialized by two build tools, both of which read
`prompts/drafts/` — **a directory that does not exist in the repo** (verified:
`prompts/` itself is absent). Both fall back to an empty set:

- **esbuild** (`esbuild.config.mjs:26-65`): `modelCardDraftsPlugin`'s `onLoad`
  does `readdir(draftsDir)` inside a `try`; on failure `catch { files = []; }`
  (`esbuild.config.mjs:39-45`), then emits `export default { };`. `draftsDir` is
  `prompts/drafts` (`esbuild.config.mjs:9-10`).
- **vitest** (`vitest.config.ts:44-58`): the `chatgoose-virtual-drafts` plugin's
  `load` returns `export default ${JSON.stringify(loadDrafts())}`; `loadDrafts`
  (`vitest.config.ts:14-28`) wraps `readdirSync(draftsDir)` in `try/catch` and
  `return {}` on failure. `draftsDir` is `prompts/drafts`
  (`vitest.config.ts:5`).

So `modelCardDrafts` (and thus `getCompareDraftSource()` /
`getCompareDraftCount()`) is `{}` / `0` in every shipped build and in tests.
`tests/compare-cards.test.ts` exercises this by mocking the virtual module —
including the empty case (`tests/compare-cards.test.ts:44-52`, "returns no draft
cards when the virtual drafts module is empty") — and passing explicit draft
records to `resolveCompareModelCardsForDrafts` for the populated cases
(`tests/compare-cards.test.ts:54-137`).

### Fingerprinting

`fingerprintCompareCardContents` (`compare-cards.ts:126-135`) hashes only ordered
card contents via an FNV-style mix (`hashString`, `compare-cards.ts:117-124`);
`getCompareCardsFingerprint*` (`compare-cards.ts:137-154`) expose it. The content
script computes the fingerprint before starting a run
(`src/content/index.ts:1517-1523`, via
`getCompareCardsFingerprintForPersonality`) and uses it to decide whether a
cached completed compare can be reused (see Caching below).

## The compare operation lifecycle and Port frames

`executeCompare` (`compare-operations.ts:384-1232`) runs a linear pipeline,
emitting progress and streaming frames over the port. The context object it
receives (`CompareOperationsContext`, `compare-operations.ts:87-97`) is assembled
in `operations.ts:2451-2463` and carries the lifecycle registry, the Fansly
client, the kernel gateway, the agency-hub client, and `send`.

Ordered stages (each wrapped in the profiler via `startStage`/`completeStage`/
`failStage`/`skipStage`, `compare-operations.ts:507-549`):

1. **Guard + reserve.** `isBusy` check (`compare-operations.ts:389-396`),
   `hasPort` check (398-400), then a synchronous `lifecycle.reserve(tabId)` before
   the first `await` so a racing start cannot slip past the guard
   (`compare-operations.ts:402-411`). Failure emits `compare:error` with
   `another_operation`.
2. **Validate** (`validateCompareStart`, `compare-operations.ts:289-332`):
   confirms the tab is still on the same Fansly group, the kernel gateway is
   configured (`hub_missing_api_key`), personalities exist, and the session is
   connected; reads `quickMessageCount` as the message budget.
3. **Activate.** Builds `ActiveCompareOperation`
   (`compare-operations.ts:429-438`), calls `lifecycle.activateCompare`
   (441) and `tabContexts.setRoute` (442-446).
4. **resolve-identity** (`compare-operations.ts:551-587`): resolves the
   authenticated account id via `fanslyClient.getAuthenticatedAccountId`, then
   `storageCoordinator.rekeyAccountIdentity` (589-592).
5. **Resolve cards + `compare:ready`** (`compare-operations.ts:594-626`): resolves
   cards, enforces the `< 2` minimum, seeds `active.compareCards` per card, and
   emits `compare:ready` (`sendCompareReady`, 141-147) carrying `{id,label,source}`
   per card. The content script builds one panel tab per card on receipt
   (`src/content/index.ts:1163-1182`).
6. **load-messages** (`compare-operations.ts:631-662`): `fanslyClient.loadMessages`
   with per-page progress → `compare:progress` frames.
7. **group-lookup** (664-692) and **account-name-lookup** (713-752): resolve the
   fan account id and display name; `tabContexts.setFan` (754).
8. **earnings + subscription-lookup** (763-911): `Promise.allSettled` over monthly
   earnings, earnings stats, and subscription context; both fail open (empty
   strings) on rejection.
9. **prompt-build** (913-949): formats the transcript and assembles
   `promptInputs` (the client-context VALUES), then resolves the kernel
   `pageLabel` from the creator username via
   `agencyHubClient.resolvePageLabelForUsername` — throwing
   `hub_page_match_failed` if unmatched (`compare-operations.ts:937-944`).
10. **generating** (951-1161): fan-out — see Concurrency & streaming.
11. **Terminal.** `compare:complete` (`sendCompareComplete`, 214-225) on success
    then `clearCompareOperation` (1185); or `compare:error` from the outer catch
    (1186-1227). Cancelled/superseded runs are dropped via
    `forgetCancelledCompare` (1171, 1227). `finally` releases the reservation and
    clears timeouts (1228-1231).

Port frame types (all `BackgroundPortMessage`, defined in
`src/shared/types.ts`): inbound `compare:start` (`types.ts:849-858`) and
`compare:cancel` (`types.ts:865-868`); outbound `compare:ready`
(`types.ts:896-901`), `compare:progress` (`types.ts:998-1010`), `compare:chunk`
(`types.ts:903-908`), `compare:cardComplete` (`types.ts:942-950`),
`compare:cardError` (`types.ts:952-959`), `compare:complete`
(`types.ts:968-973`), `compare:error` (`types.ts:961-966`), and
`compare:discarded` (`types.ts:975-980`). Frames are routed to `send` (the
per-tab port) through the small `sendCompare*` helpers
(`compare-operations.ts:141-238`), each of which optionally attaches a profiling
snapshot. The content-side handlers live at `src/content/index.ts:1045-1064`
and `1163-1311`.

## Concurrency & streaming

**Concurrency.** All cards run at once, unbounded, via
`await Promise.all(compareCards.map((card) => runCard(card)))`
(`compare-operations.ts:1161`). The engine does **not** use the shared
`src/shared/concurrency.ts` limiter — there is no import of it in
`compare-operations.ts`, and the fan-out has no per-run concurrency cap. (In
practice at most one card ever runs, since the two-card minimum is not met — see
above.) `runCard` (`compare-operations.ts:957-1159`) re-checks that the operation
is still the active one before and after streaming
(`compare-operations.ts:958-964`, `1104-1110`), so cards from a superseded run
short-circuit.

**Streaming.** Each `runCard` derives `personaKey` from the card id
(`compare-operations.ts:987-989`) and calls
`context.kernelGateway.streamFeature(...)` (`compare-operations.ts:996-1062`).
The gateway's `onText` callback appends each chunk to both `cardState.rawText`
(the full accumulator) and `cardState.flushBuffer`, then schedules a flush
(`compare-operations.ts:1017-1037`). Chunks are **coalesced**:
`scheduleCompareChunkFlush` (273-287) arms a `setTimeout` of
`STREAM_CHUNK_FLUSH_MS` (= 50 ms, `src/shared/constants.ts:78`), and
`flushCompareChunks` (247-271) emits one `compare:chunk` carrying the buffered
text and clears the buffer. On card completion, any pending flush timer is
cleared and drained (`compare-operations.ts:1115-1117`) before parts are
normalized (`normalizeReplyParts`, 1119) and `compare:cardComplete` fires
(1145-1158). The content script appends chunk text into the matching tab and
schedules a render (`src/content/index.ts:1198-1207`).

## Caching & cancellation

**Caching.** The background engine keeps **no** result cache — every
`compare:start` recomputes from scratch. Result reuse is entirely content-side:
`CompletedCompareCache`
(`src/content/inline-panel/completed-compare-cache.ts:8-49`) holds a single
completed compare view-model keyed by the active group id plus the card
fingerprint. On `compare:complete` the content script stores the finished model
with `this.pendingCompareFingerprint`
(`src/content/index.ts:1264-1281`); it is invalidated when the group changes
(`completed-compare-cache.ts:11-19`) or on cancel/terminal error
(`src/content/index.ts:1300-1306`, `415-423`). The fingerprint (from
`compare-cards.ts`) lets the panel decide whether the cached model still matches
the current card contents.

**Cancellation.** Two abort sources are combined into one signal via
`AbortSignal.any([controller.signal, timeoutController.signal])`
(`compare-operations.ts:424-427`):

- **Timeout:** `OperationTimeoutController` armed with `QUICK_OPERATION_TIMEOUT_MS`
  (= 60 000 ms, `src/shared/constants.ts:69`) at
  `compare-operations.ts:419-421`; a fired timeout surfaces as a `timed_out`
  error (`resolveAbortChatGooseError`, used at 1068-1073 and 1194-1198).
- **Explicit cancel:** `compare:cancel` from content
  (`src/content/index.ts:243`, `417`) → `operations.ts:533-538` →
  `cancelCompareOperation` (`compare-operations.ts:355-382`), which calls
  `lifecycle.cancelCompare` (aborting the controller and clearing flush timers)
  and optionally emits `compare:discarded`.

The registry (`OperationRegistry` / `CompareOperationLifecycle`,
`src/background/operation-registry.ts`) tracks cancelled ids so a late frame from
an aborted run is suppressed: `cancelCompare` records the id
(`operation-registry.ts:125-139`); the outer catch checks
`consumeCancelledCompare` (`compare-operations.ts:1189-1191`); and both the
superseded-completion path (1171) and terminal-failure path (1227) call
`forgetCancelledCompare` to keep the cancelled-id set from growing unbounded.
Per-card abort handling distinguishes `timed_out` (rethrown, fails the whole
run) from `chat_changed` (silently returns) from other errors (emits
`compare:cardError`) at `compare-operations.ts:1067-1102`.

## Boundary — what each card sends to the kernel gateway

Every card streams through `KernelFeatureGateway.streamFeature`
(`src/background/kernel-feature-gateway.ts:138-235`), which is the extension's
only AI transport after the Stage 32 cutover (vendor SDKs removed;
`kernel-feature-gateway.ts:1-9`). It issues one SSE stream against
`POST /api/v1/ai/features/:feature` via the vendored `@kernel/sdk`
(`streamAiFeature`, `kernel-feature-gateway.ts:11`, `183-219`).

Per card, `compare-operations.ts:997-1015` sends a `KernelFeatureRequest` with:

- `feature: 'fast-reply'` — the only feature compare uses.
- `clientRequestId: crypto.randomUUID()` — a fresh dedup/correlation id **per
  card** (not the operationId).
- `pageLabel` — resolved once per run from the creator username
  (`compare-operations.ts:937-944`).
- `conversationRef: fanAccountId ?? validated.urlGroupId`.
- `personaKey` — the card's persona (the mapped personality key stripped of the
  `current:` prefix, `compare-operations.ts:987-989`).
- `replyTone`, `replyMode`, and `isRegeneration: Boolean(payload.forceRegenerate)`.
- `clientContext`: the loaded VALUES only — `transcript`, `messageCount`,
  `fanDisplayName`, `fanSpendingData`, `fanSubscriptionData`
  (`compare-operations.ts:1008-1014`). Prompt ASSEMBLY (templates, personas,
  platform wording, budgets, capture, ledger) is kernel-side, per the header
  comment `kernel-feature-gateway.ts:1-9`. The request body is fixed to
  `platform: 'fansly'` (`kernel-feature-gateway.ts:195`).

Streaming callbacks (`compare-operations.ts:1016-1059`) map gateway frames:
`onText` (buffered chunking), `onMeta` records the real `model`,
`onUsage` builds a `LlmSpendSummary` from gateway-priced usage
(`buildKernelSpendSummary`, attached to `compare:cardComplete`/`compare:cardError`
as `llmSpend`), and `onStopReason` records the terminal reason — a `max_tokens`
stop or zero usable parts yields an `ai_output_unusable` card error
(`compare-operations.ts:1120-1137`). The gateway maps kernel HTTP/gate errors to
`ChatGooseError` keys (`kernel-feature-gateway.ts:65-115`) and fails closed if the
stream ends without a terminal `done` frame (`kernel-feature-gateway.ts:226-232`).
Note the meta frame names the real model; the engine's local `resolvedModel`
placeholder is the literal string `'kernel'` (`compare-operations.ts:629`).
