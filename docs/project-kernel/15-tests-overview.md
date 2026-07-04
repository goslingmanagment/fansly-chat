# 15 — Test Suite Overview

**Scope.** This is a legible coverage index for the ChatGoose test suite, not a deep audit. It covers `vitest.config.ts`, the three test-support files under `tests/` (`tests/helpers/port.ts`, `tests/jsdom.d.ts`, `tests/node-shims.d.ts`), and every one of the 53 `tests/**/*.test.ts` files. For each test file it records the module(s) under test, the technique used, the boundaries it exercises (stubbed `fetch`, mocked `browser.*`, jsdom DOM, the runtime Port), and any pinned behavior worth a reviewer's eye. Contract tables for the four external boundaries live in `boundaries.md` and are not re-derived here; this document records how the *tests* touch them.

> The assignment brief expected ~58 files and a jsdom global environment. Actual counts: **53** `*.test.ts` files + 3 support files + `vitest.config.ts`. The global Vitest environment is **`node`**, not `jsdom` (see the discrepancy note at the end). Both are flagged rather than papered over.

---

## 1. `vitest.config.ts`

`defineConfig` from `vitest/config`. Key settings:

- **`test.environment: 'node'`** — the global environment is Node, *not* jsdom. There is **no `setupFiles`** and no global setup. DOM-dependent tests each construct their own `new JSDOM(...)` and install globals with `vi.stubGlobal` (see §3.2).
- **`test.include: ['tests/**/*.test.ts']`**.
- **`test.globals: true`** — `describe/it/expect/vi` are global (files still import them explicitly from `vitest`).
- **`test.coverage.reporter: ['text', 'html']`**.
- **`define.__CHATGOOSE_BUILD_TIME__: '"test-build"'`** — replaces the build-time constant that production injects via esbuild.
- **Plugin `chatgoose-raw-text-assets`** — a `transform` hook: any import whose id ends in `.md` or `.css` is rewritten to `export default <JSON.stringify(source)>`. This is what lets `prompts.test.ts` import `../prompts/*.md` as strings and lets content modules import `styles.css` as a string. (`overlay-controller.test.ts` instead reads `src/content/styles.css` via `node:fs` `readFileSync`.)
- **Plugin `chatgoose-virtual-drafts`** — `resolveId`/`load` hooks that resolve the virtual module id `virtual:model-card-drafts` to `export default <object>`, where the object maps each file basename under `prompts/drafts/*.md` (sorted with a locale/numeric comparator, `.md` stripped) to its raw contents. `loadDrafts()` swallows read errors and returns `{}`. Consumed by `src/shared/compare-cards.ts`; `compare-cards.test.ts` overrides it with `vi.doMock('virtual:model-card-drafts', …)`, and `operations.test.ts` instead injects draft cards through the `globalThis.__CHATGOOSE_COMPARE_DRAFTS__` test hook.

---

## 2. Test-support files

### `tests/helpers/port.ts` — the runtime Port harness

The single shared harness. Exports:

- **`MockRuntimePort`** interface + **`createMockRuntimePort(tabId)`** — fabricates a fake `runtime.Port`: `sender.tab.id = tabId`, `vi.fn()` `postMessage`/`disconnect`, and `onMessage`/`onDisconnect` objects whose `addListener`/`removeListener` push into internal `Set`s. Adds two test-only escape hatches: `emitMessage(msg)` fans a message out to all message listeners, `emitDisconnect()` fires all disconnect listeners. This lets a test simulate the content→background direction (emit) and inspect the background→content direction (`postMessage` calls).
- **`postedMessages(port)`** — maps `port.postMessage.mock.calls` to `BackgroundPortMessage[]` for assertions.

Imported by `operations.test.ts` and `port-client.test.ts`. `content-app.test.ts` does not use it directly — it drives `app.port` (a real `PortClient`) by replacing `app.port.send` with a spy and by feeding messages through the app's own handler.

### `tests/jsdom.d.ts`

One line: `declare module 'jsdom';` — an ambient shim so the many `import { JSDOM } from 'jsdom'` statements typecheck without `@types/jsdom`.

### `tests/node-shims.d.ts`

Minimal ambient `declare module` shims for `node:os` (`tmpdir`), `node:path` (`join`), and `node:fs/promises` (`mkdtemp`, `mkdir`, `rm`, `writeFile`) — narrow surfaces used by config/test tooling so TS does not require full `@types/node`.

---

## 3. Recurring techniques (shared across files)

### 3.1 Fake-`fetch` (network doubles)
Client tests replace `global.fetch` with `vi.stubGlobal('fetch', vi.fn(...))` and return hand-built `Response` objects (or partial `{ status, ok, json, body }`). SSE streams are simulated by putting a `ReadableStream<Uint8Array>` on `response.body` that enqueues `TextEncoder`-encoded `event:`/`data:` lines. Used by: `anthropic-client`, `openrouter-client`, `fansly-client`, `agency-hub-client` (and indirectly `operations` via a mocked `AnthropicClient.streamMessage`).

### 3.2 jsdom DOM (manual install)
Because the global env is `node`, DOM tests build `new JSDOM('<!doctype html>…')` (often with `url: 'https://fansly.com/messages/example'` or an options-page URL) and `vi.stubGlobal` the pieces they need: `window`, `document`, `navigator`, `HTMLElement`/`HTMLButtonElement`/`HTMLSelectElement`/`Text`/`Node`/`Event`/`CustomEvent`/`KeyboardEvent`/`MutationObserver`, and often a `requestAnimationFrame`/`cancelAnimationFrame` polyfill backed by `setTimeout`. `afterEach` calls `vi.unstubAllGlobals()`. Files: `overlay-controller`, `inline-panel-controller`, `button-bar`, `content-app`, `conversation-mount-controller`, `scroll-compensation`, `spenders-board-controller`, `options-accounts`, `options-agency-hub`, `options-models`, `popup`.

### 3.3 `browser.storage.local` mock
A `let mockStorage: Record<string, unknown>` object plus `vi.fn` `get`/`set`/`remove` that read/write it, honoring the `null | string | string[]` key forms. Reset in `beforeEach`. Files: `storage-coordinator`, `storage-migration`, `runtime-api`, `content-app`, `operations`, and the options/popup loaders. `browser.permissions.contains`/`request` and `browser.runtime.onMessage`/`sendMessage`/`connect`/`getManifest` are mocked alongside as needed.

### 3.4 Dynamic import after mock
Many files call `vi.resetModules()` then `await import('…')` so the module under test binds to the just-installed `fetch`/`browser`/mock. Used by `anthropic-client`, `storage-migration`, `runtime-api`, `content-app`, `operations`, `compare-cards`, `scroll-compensation`, the prompt-caching fallback case, and every options/popup test.

### 3.5 Fake timers
`vi.useFakeTimers()` + `advanceTimersByTime[Async]`/`setSystemTime` drive time-based logic: `operation-timeouts`, `agency-hub-usage-reporter`, `conversation-mount-controller`, `fansly-client` (abort-during-backoff), `view-helpers`, and the deep-operation timeout cases in `operations`.

---

## 4. Master index: file → module under test → technique

| Test file | Module(s) under test | Technique |
| --- | --- | --- |
| `operations.test.ts` | `src/background/operations.ts` (`OperationCoordinator`) | Integration via `createMockRuntimePort`; mocked FanslyClient/AnthropicClient/AgencyHubClient/usage-reporter; `mockStorage`; real SessionStore/StorageCoordinator/TabContextStore. 98 cases. |
| `operation-registry.test.ts` | `src/background/operation-registry.ts` (`OperationRegistry`) | Unit (`AbortController` + fake cleanup fns) |
| `operation-timeouts.test.ts` | `src/background/operation-timeouts.ts` (`OperationTimeoutController`) | Unit, fake timers |
| `operation-profiling.test.ts` | `src/background/operation-profiling.ts` (`createOperationProfiler`) | Unit, `Date.now` spy |
| `conversation-context-loader.test.ts` | `src/background/conversation-context-loader.ts` (`loadMediaPurchaseEvidence`) | Unit, mock FanslyClient |
| `llm-client.test.ts` | `src/background/llm-client.ts` (`LlmClient`) | Unit, mock Anthropic/OpenRouter sub-clients |
| `llm-cost.test.ts` | `src/background/llm-cost.ts` (`estimateLlmCost`, `buildLlmSpendSummary`) | Unit |
| `anthropic-client.test.ts` | `src/background/anthropic-client.ts` (`AnthropicClient`) | Fake-fetch + SSE ReadableStream; dynamic import |
| `openrouter-client.test.ts` | `src/background/openrouter-client.ts` (`OpenRouterClient`) | Fake-fetch + SSE ReadableStream |
| `fansly-client.test.ts` | `src/background/fansly-client.ts` (`FanslyClient`) | Fake-fetch; real `SessionStore` harness; fake timers |
| `session-store.test.ts` | `src/background/session-store.ts` (`SessionStore`) | Unit |
| `session-capture.test.ts` | `src/background/session-capture.ts` (`normalizeRouteKey`) | Unit |
| `spenders-service.test.ts` | `src/background/spenders-service.ts` (`SpendersService`) | Unit, mock FanslyClient |
| `agency-hub-client.test.ts` | `src/background/agency-hub-client.ts` (`AgencyHubClient`) | Fake-fetch + `browser.permissions` mock |
| `agency-hub-usage-reporter.test.ts` | `src/background/agency-hub-usage-reporter.ts` (`AgencyHubUsageReporter`) | Unit, fake timers, mock client |
| `runtime-api.test.ts` | `src/background/runtime-api.ts` (`registerRuntimeApi`) | Integration via captured `onMessage` listener; mock `browser`; real stores |
| `storage-coordinator.test.ts` | `src/background/storage-coordinator.ts` (`StorageCoordinator`) | Storage mock + gated first `set` (concurrency) |
| `storage-migration.test.ts` | `src/shared/storage.ts`, `src/shared/migrations.ts`, `src/shared/personalities.ts` | Storage mock; top-level dynamic import |
| `storage-change-filter.test.ts` | Re-implemented copy of the `storage.onChanged` filter in `src/background/index.ts` | Unit of a hand-copied helper (does **not** import `index.ts`) |
| `summary-cache.test.ts` | `src/shared/summary-cache.ts` (`SummaryCacheStore` + pure helpers) | Unit + injected storage stub |
| `completed-overlay-cache.test.ts` | `src/content/overlay/completed-overlay-cache.ts` (`CompletedOverlayCache`) | Unit |
| `concurrency.test.ts` | `src/shared/concurrency.ts` (`mapWithConcurrency`) | Unit (real timers for in-flight count) |
| `surface-planner.test.ts` | `src/content/surface-planner.ts` (`planSurfaces`) | Unit (pure decision function) |
| `overlay-controller.test.ts` | `src/content/overlay/overlay-controller.ts` (`OverlayController`) | jsdom; `vi.mock` of `textarea.js`; reads `styles.css` via `fs` |
| `inline-panel-controller.test.ts` | `src/content/inline-panel/inline-panel-controller.ts` (`InlinePanelController`) | jsdom; `vi.mock` of `textarea.js`; dynamic import |
| `button-bar.test.ts` | `src/content/button-bar.ts` (`ButtonBar`) | jsdom |
| `content-app.test.ts` | `src/content/index.ts` (`ChatGooseContentApp`) | jsdom + `mockStorage`; drives `app.port.send` spy and feeds Port messages |
| `conversation-mount-controller.test.ts` | `src/content/conversation-mount-controller.ts` (`ConversationMountController`) | jsdom + fake timers |
| `scroll-compensation.test.ts` | `src/content/scroll-compensation.ts` (`captureScrollSnapshot`, `applyScrollCompensation`) | jsdom + hand-stubbed layout metrics |
| `spenders-board-controller.test.ts` | `src/content/spenders/spenders-board-controller.ts` (`SpendersBoardController`) | jsdom; injected `fetchList`/`openChat` |
| `spend-format.test.ts` | `src/content/spend-format.ts` | Unit |
| `view-helpers.test.ts` | `src/content/ui/view-helpers.ts` | Unit, fake timers |
| `port-client.test.ts` | `src/content/port-client.ts` (`PortClient`) | Unit; `createMockRuntimePort` + mock `browser.runtime.connect` |
| `compare-cards.test.ts` | `src/shared/compare-cards.ts` | Unit; `vi.doMock('virtual:model-card-drafts')` |
| `protocol.test.ts` | `src/shared/protocol.ts` (guards) | Unit |
| `errors.test.ts` | `src/shared/errors.ts` | Unit |
| `xml.test.ts` | `src/shared/xml.ts` (`parseHelpMeXml`, `parseChatReviewXml`) | Unit |
| `split.test.ts` | `src/shared/split.ts` (`splitByNext`) | Unit |
| `reply-output.test.ts` | `src/shared/reply-output.ts` | Unit |
| `prompt-injection.test.ts` | `src/shared/prompt-injection.ts` (`escapeForPrompt`) | Unit |
| `prompts.test.ts` | `src/shared/prompts.ts` + `prompts/*.md` (raw imports) | Unit; re-derives the flat builder; `vi.doMock` md for the fallback case |
| `transcript.test.ts` | `src/shared/transcript.ts` | Unit |
| `subscriptions.test.ts` | `src/shared/subscriptions.ts` (`formatFanSubscriptionData`) | Unit |
| `earnings.test.ts` | `src/shared/earnings.ts` | Unit |
| `spenders.test.ts` | `src/shared/spenders.ts` (tiering) | Unit |
| `log.test.ts` | `src/shared/log.ts` (`logDebug`, `isDebugEnabled`) | Unit, `console.debug` spy |
| `hotkeys.test.ts` | `src/shared/hotkeys.ts` (+ `keymap.ts`) | Unit |
| `keymap.test.ts` | `src/shared/keymap.ts` | Unit |
| `agency-hub.test.ts` | `src/shared/agency-hub.ts` (`buildAgencyHubOriginPattern`) | Unit |
| `options-accounts.test.ts` | `src/options/index.ts` (account + personality sections) | jsdom + mock `browser`; dynamic import |
| `options-agency-hub.test.ts` | `src/options/index.ts` (Agency Hub section) | jsdom + mock `browser.permissions`/`runtime` |
| `options-models.test.ts` | `src/options/index.ts` (AI Models section) | jsdom + mock `browser` |
| `popup.test.ts` | `src/popup/index.ts` | jsdom + mock `browser.runtime` |

---

## 5. Grouped notes

### 5.1 Background — operation coordinator (`operations.test.ts`)

The largest file (~181 KB, 98 `it`s, one top-level `describe('OperationCoordinator')`). `createCoordinatorHarness()` (operations.test.ts:246) dynamically imports `OperationCoordinator`, `SessionStore`, `StorageCoordinator`, `TabContextStore`; registers a session capture for tab 1; substitutes a `buildFanslyClientMock()` (loadMessages, getGroup, getAccountNames, getEarnings, getMonthlyEarnings, getFanSubscriptionContext, verifyMediaPurchaseStates, getAuthenticatedAccount[Id]) and a stub `anthropicClient.streamMessage`; wires a mock `agencyHubClient` and `agencyHubUsageReporter`; and registers a `createMockRuntimePort(1)`. Messages are pushed with `port.emitMessage(...)` and asserted with `postedMessages(port)`. `mockStorage` backs `browser.storage.local`; `currentNow`/`advanceNow` drive a monotonic clock. Compare drafts are injected through the `globalThis.__CHATGOOSE_COMPARE_DRAFTS__` hook (operations.test.ts:322). Coverage themes (from the `it` names):

- **Tab-state**: summary-availability flags, provider-aware API-key readiness, Agency-Hub prefetch marking a summary ready, mapping auto-recovery on new alias capture, multi-tab refresh after identity resolution.
- **Reply context**: full vs cache-only subscription lookup; PPV purchase evidence into prompts (verifier called / not called / capped by `FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT` / fails-open to unknown); tone injection into uncached user blocks.
- **Compare/Multi**: `compare_cards_unavailable` under two cards; one shared prep pass + per-card fast-reply model; per-card profiling isolation; mixed outcomes still complete; `compare:discarded` on cancel; `compare:error` on the shared timeout; `COMPARE_TEMPERATURE`.
- **Profiling gating**: profiling snapshots present in debug mode and absent from progress/completion/error/discarded payloads when debug is off, while `llmSpend` still flows.
- **Timeouts**: `QUICK_OPERATION_TIMEOUT_MS`; deep `PREP`/`TTFB`/`IDLE`/`MAX_STREAM` budgets; reasoning-before-text counts as provider activity; a >120s deep summary completes if progress continues.
- **Summary cache + Agency Hub sync**: local-cache hit skips Hub; Hub hit persists locally and is reused; stale-for-model triggers Hub prefetch then regen; forced refresh removes the durable cache and skips prefetch; push-after-completion marks synced; one-shot backfill per Hub config; base-URL change re-targets backfill; sync-failure does not block completion.
- **Model routing / retries**: per-feature model to `streamMessage`; OpenRouter routing + provider-aware missing-key errors; no fallback from an unavailable OpenRouter model; `model_unavailable` retry to default; rate-limit retry only when Retry-After ≤ 60s; `service_unavailable` retried once.
- **Feature specifics**: improve-draft single-part + `improveMessageCount`; ping `pingMessageCount`; fast-reply `quickMessageCount`; Gemini meta-text sanitization; unusable-output error when no insertable parts; `promptCachingEnabled: false` strips `cache_control` but preserves text/segmentation.
- **Usage reporting**: one event per successful op with feature/model/tokens/duration/timestamp; canonical OpenRouter ids via `getAgencyHubModelId`; cache hits reported as zero-token; failed/discarded ops not reported; per-successful-compare-card events with no aggregate event.

### 5.2 Background — LLM clients

- `anthropic-client.test.ts` pins the request contract to `api.anthropic.com/v1/messages`: header `anthropic-dangerous-direct-browser-access: true`, **no** `anthropic-beta` header even for 1h cache TTL; `MAX_TOKENS` per feature (`fast-reply:800, improve-draft:800, help-me:1200, fan-summary:8192, chat-review:1600, ping:800, hi-greeting:800`) with Claude-4.6 adaptive raises (8000/24000/16000); `thinking: {type:'adaptive', display:'summarized'}` + `output_config.effort` on 4.6, omitted when reasoning `off` or on non-adaptive models (haiku-4.5). Error mapping: 401/403→`invalid_api_key`, 429→`rate_limited`, 500→`service_unavailable`, 400+`not_found_error`→`model_unavailable`, other 400→`unknown_error`, no-body non-ok→`network_error`. SSE parsing: cumulative `onUsage` merging `cache_creation.ephemeral_5m/1h`, `onText` deltas, reasoning observation callbacks (`thinking_block`/`thinking_delta`/`signature_delta`), reader `.cancel()` on mid-stream error event.
- `openrouter-client.test.ts` pins `OPENROUTER_MESSAGES_API_URL`, `Authorization: Bearer …`, `cache_control` stripped from a **clone** (originals unmutated), Gemini `display:'omitted'` thinking, `max`→`high` effort mapping. SSE edge cases: CRLF blank-line separators, `: OPENROUTER PROCESSING` comment lines, data-only Anthropic events, `stop_reason`, Anthropic-vs-OpenAI usage shapes (prompt_tokens_details cached/write without double-counting), rejection of `chat.completion.chunk`/`[DONE]` OpenAI-completion chunks, data-only error payloads classified before validation, model errors mapped without a second endpoint attempt.
- `llm-client.test.ts` — provider routing by `anthropic:`/`openrouter:` prefix, bare upstream model id forwarded, provider-aware `missing_api_key` (`details.provider`).
- `llm-cost.test.ts` — `estimateLlmCost`/`buildLlmSpendSummary`: cache saved-vs-overhead, Opus-4.6 rates, Grok/Gemini `approximate` flags, OpenRouter cached usage without double-counting.

### 5.3 Background — Fansly + spenders

- `fansly-client.test.ts` — `getFanSubscriptionContext` cache-only vs full (`/messaging/groups` then `/subscribers`), `getMonthlyEarnings` (`/monthlystats/accounts`, 429→`rate_limited` + `retryAfterMs`, no retry on optional earnings), `verifyMediaPurchaseStates` (`/media/orderhistory` exact-match purchase logic, fail-open `verificationIncomplete`), abort-during-backoff yields an `AbortError` `DOMException`.
- `session-store.test.ts` — in-place credential refresh so in-flight refs see re-login, orphan drop on account switch, multi-tab reference counting, `forgetTab`, snapshot filtering.
- `session-capture.test.ts` — `normalizeRouteKey` URL→route mapping (earnings/subscribers/media/messagingGroups/group/message/account/null).
- `spenders-service.test.ts` — rank by lifetime gross, drop $0, per-fan earnings failure counted as $0, cache + refresh, abort throws and does not poison the cache.

### 5.4 Background — Agency Hub

- `agency-hub-client.test.ts` — `AgencyHubClient` against `http://localhost:3000`: page match by username (`GET /api/v1/pages`), `PUT …/fans/{id}/profile`, `POST /api/v1/ai-usage/batch` (100-event batch), `GET …/conversations/{convId}/profile`, `testConnection`. Status/reason shapes: `pushed`/`submitted`/`fetched`/`not-found`/`skipped(body_too_large|missing_host_permission|missing_base_url)`/`failed(hub_request_failed|aborted|…)`; Hub error codes `CG-HUB-03/04/07`; host permission checked via `browser.permissions.contains({origins:['http://localhost/*']})`; native-`fetch` bound to `globalThis`; 50 000-char body-size guard before any network call.
- `agency-hub-usage-reporter.test.ts` — debounce (~1000 ms) batching, 100-event split, per-Hub-target separation, retry backoff on failed *and* thrown submits using `AGENCY_HUB_AI_USAGE_REPORT_RETRY_DELAYS_MS`/`…_MAX_ATTEMPTS`, drop after max attempts, flush of events enqueued mid-retry.

### 5.5 Background/shared — storage

- `storage-migration.test.ts` — top-level `await import('../src/shared/storage.js')` after installing the storage mock. Covers `migrateState` (seed on null/non-object, ordered `MIGRATIONS` to `STORAGE_SCHEMA_VERSION`, legacy field backfill incl. `anthropicApiKey→claudeApiKey`, `pingMessageCount` seeded from `quickMessageCount`, `featureModels` defaults, `summary:*` carry-forward + corrupt-drop, agency-hub sync-metadata normalization), `sanitizeSettings` (clamps, trims, canonical Hub URL, model/reasoning validation), and the async storage APIs (`loadStorageState`, `savePersonalities`, `deletePersonality` cascade, `saveAccountMapping`, `registerKnownAccount`, `rekeyAccountIdentity`, `reconcileKnownAccounts`, summary-cache round-trip) — asserting both returned state and `mockStorage`/`browser.storage.local.remove` side effects. Bundled Lora seeding/versioning is pinned against `BUNDLED_LORA_PERSONALITY_ID`/`…_VERSION`.
- `storage-coordinator.test.ts` — serializes two concurrent `registerKnownAccount` calls (gate the first `set`) so neither write is dropped and the result is sorted.
- `storage-change-filter.test.ts` — **note**: re-implements `UI_RELEVANT_KEYS` and `shouldRefresh` locally in the test (a copy of the filter in `src/background/index.ts`) with a docstring saying `index.ts` has heavy side effects; it therefore tests the *logic shape*, not the shipped function.
- `summary-cache.test.ts` — pure helpers (`normalizeSummaryCacheEntry`, `collect…`, `getInvalid…`, `getOldest…`, `getSummaryCacheEvictionKeys`, model-id equivalence) plus `SummaryCacheStore` with an injected storage object exercising quota-retry eviction (invalid entries evicted before valid, oldest-first).

### 5.6 Content — overlay / inline / bar / mount / scroll / spenders / app

- `overlay-controller.test.ts` (40 `it`s) — `OverlayController` rendering in jsdom with `textarea.js` `vi.mock`ed. Loading/completed/error/helpMe/readOnly views, profiling log scroll-pinning, live rate-limit countdown, spend/cost rows, dismiss modes (`collapse-to-inline` vs `close` — Escape/backdrop/X routing to `onCollapse`/`onCancel`/`onClose`), debug prompt inspector, Fan Summary sync-status labels, Enter-to-insert focus/guard behavior. Reads real `src/content/styles.css` through `fs`.
- `inline-panel-controller.test.ts` (39 `it`s) — `InlinePanelController`: shell reuse via `Text.data` mutation, header meta/spend, reply Insert/Copy/Regenerate, error state, Escape suppression while focused in textarea/input, compare tabs (switch/regenerate-all/per-tab spend/summary/error), split-mode Enter targeting part 2.
- `button-bar.test.ts` — `ButtonBar.render(...)` toolbar composition: Scan row button (no `⋯` menu), hover-only hotkey chips with `aria-keyshortcuts`, summary-ready marker, tone pills (Flirty/Upsell/Horny → `onToneSelect`), Multi toggle (`aria-pressed`), Polish enable/disable, child ordering. `detectLabelPlatform`/`featureHotkeyLabel` from `hotkeys.ts`. Contains one **`describe.skip('ButtonBar compare button')`** block (the only skipped suite).
- `content-app.test.ts` (31 `it`s) — `ChatGooseContentApp` from `src/content/index.ts` in jsdom + `mockStorage`, driving `app.port.send` (spy) and feeding Port messages. Covers cached-reply reopen + insert-state, cache clear on conversation change, OpenRouter missing-key toast, tone selection with fast-reply and reset, improve-draft draft passing + per-draft caching, profiling continuity, suppressed-completion-after-route-change discard, disconnected-port drop, inline-vs-overlay surface routing, deep-features overlay-only, Fan Summary sync-status updates + coded failure toast, compare start/reopen/restore/invalidate/close, port-disconnect reset. It exercises the real `PortClient` inside the app.
- `conversation-mount-controller.test.ts` — retries past the 10s fast-attach window and attaches once the conversation subtree reappears (fake timers pointed at `window.setTimeout`).
- `scroll-compensation.test.ts` — jsdom with `Object.defineProperty` layout stubs (jsdom reports 0). Near-bottom threshold (96px), positive/negative/zero deltas, sibling/descendant container discovery, potential-container preference over distant scrollables, root-height fallback, clamp to `maxScroll`, fallback-cache recovery.
- `spenders-board-controller.test.ts` — jsdom board render grouped by tier, chips (All + populated tiers), row click→`openChat(groupId)`, J/K cursor + Enter, Escape close, tier-chip filter, error state. Selectors: `.chatgoose-board-row`, `.chatgoose-board-section`, `.chatgoose-board-chip`, `.chatgoose-board-state`.
- `completed-overlay-cache.test.ts` — `CompletedOverlayCache` get/set by group+feature(+optional cache key), object-identity preservation, clear on active-group change.
- `spend-format.test.ts` / `view-helpers.test.ts` / `surface-planner.test.ts` / `port-client.test.ts` — see the master table; all thin units. `port-client` pins that `PortClient` only forwards messages that pass `isBackgroundPortMessage`.

### 5.7 Shared domain + protocol

`protocol.test.ts` (runtime-request + Port-message guards), `errors.test.ts` (`ChatGooseError`/`toUserError`/`getErrorMessage`, code strings like `CG-FAN-01`/`CG-AUTH-01/02`/`CG-APP-01`), `xml.test.ts`, `split.test.ts`, `reply-output.test.ts` (Gemini leak stripping, injection-echo removal, `[VARIANT]` delimiter), `prompt-injection.test.ts` (order-critical `&`→`<`→`>` escaping), `prompts.test.ts` (system/user block builder byte-identical to a re-derived flat builder for all 7 features; cache breakpoints on final block of each cacheable segment; per-fan data kept out of the 1h-cached prefix; paid-media rule presence per template; placeholder-injection resistance; missing-anchor fallback with a warn), `transcript.test.ts` (normalize/dedupe/sort, media + tip + PPV labeling incl. the "tips ≠ purchases" and "viewer `purchased:true` ≠ fan order" regressions, bundle counting, ping-segment analysis, window/paging helpers), `subscriptions.test.ts`, `earnings.test.ts`, `spenders.test.ts`, `concurrency.test.ts`, `log.test.ts` (secret redaction incl. `sk-ant-*`/`sk-or-v1-*`, nested/array/Error payloads), `hotkeys.test.ts`/`keymap.test.ts` (mac vs Windows/Linux combos, reserved-letter avoidance, `mod`=meta|ctrl, in-editable suppression), `agency-hub.test.ts` (origin pattern strips port/path).

### 5.8 Options + popup

All load `src/options/index.ts` (or `src/popup/index.ts`) into jsdom with a mocked `browser` and `vi.waitFor` on rendered sections. `options-accounts` (snapshot-before-storage ordering via `callOrder`, connection-vs-offline-mapping separation, dedupe by canonical id, no-focus-steal name edit, dropdown disambiguation, clamped count write-back), `options-agency-hub` (permission `Grant Access` requested before storage write, denied/errored status lines, auto live connection test → `Connected ✓` / coded failure, save-before-retest), `options-models` (5 model + 5 reasoning dropdowns, provider optgroups, persisted init, reasoning capability toggling per model, message-count fields, builtin-personality metadata preservation), `popup` (account label render + unreachable-background fallback).

---

## 6. Notable pinned behaviors (for a reviewer)

- **Protocol validation at both boundaries** — `protocol.test.ts` + `port-client.test.ts` + the runtime-listener guard cases in `runtime-api.test.ts`/`operations.test.ts` pin that malformed `ContentPortMessage`/`BackgroundPortMessage`/runtime requests are dropped before dispatch.
- **Storage migration chain** — `MIGRATIONS` ordered up to `STORAGE_SCHEMA_VERSION`; legacy field backfill; corrupt-summary drop; bundled-Lora version gating (`storage-migration.test.ts`).
- **SSE parsing** — Anthropic and OpenRouter stream parsers exercised for text deltas, usage merging, reasoning callbacks, CRLF/comment lines, OpenAI-vs-Anthropic usage shapes, and error-event handling (`anthropic-client`, `openrouter-client`).
- **Retry / backoff** — Anthropic `model_unavailable`/rate-limit(≤60s)/`service_unavailable` retries (`operations`); usage-reporter exponential backoff + drop (`agency-hub-usage-reporter`); Fansly abort-during-backoff (`fansly-client`).
- **PPV purchase verification** — exact fan-order matching, viewer-side `purchased:true` treated as *unknown* without a fan order, fail-open `verificationIncomplete`, cap overflow left unknown (`transcript`, `conversation-context-loader`, `fansly-client`, `operations`).
- **Prompt caching breakpoints** — cache-control placed only on the final block of each cacheable prefix; per-fan data excluded from the 1h prefix; flatten equals the legacy flat prompt byte-for-byte (`prompts.test.ts`).
- **Debug-gated profiling** — profiling snapshots only leave the coordinator in debug mode; `llmSpend` always flows (`operations`, `overlay-controller`).

---

## 7. Discrepancies & open questions

1. **jsdom environment**: `vitest.config.ts` sets `environment: 'node'` with no `setupFiles`. DOM tests each build `new JSDOM(...)` and `vi.stubGlobal` the globals. The brief's "environment (jsdom), setup, globals" description matches only `globals: true`; there is no jsdom environment and no setup file. No file uses a `// @vitest-environment` pragma.
2. **File count**: 53 `*.test.ts` files (brief said ~58). Total support surface: 53 tests + `helpers/port.ts` + `jsdom.d.ts` + `node-shims.d.ts` + `vitest.config.ts`.
3. **`storage-change-filter.test.ts` tests a copy, not the source.** It re-declares `UI_RELEVANT_KEYS`/`shouldRefresh` inline rather than importing from `src/background/index.ts`; a divergence between that copy and the shipped filter would not be caught. Keys asserted: `settings`, `personalities`, `accountMappings`, `accountAliases`, `knownAccounts`, `schemaVersion` (and `summary:*` explicitly ignored).
4. **`describe.skip('ButtonBar compare button')`** in `button-bar.test.ts` (comment: "Additional compare button behavior coverage remains skipped for now") — the entire Compare/Reopen button suite is not executed. It is the only skipped block in the suite.
5. **`node-shims.d.ts` / `jsdom.d.ts`** are ambient TS shims only; they gate compilation, not runtime behavior, and would silently mask an upgrade to real `@types/*` packages.
