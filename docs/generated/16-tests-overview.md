> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# 16 — Tests Overview

The ChatGoose Firefox extension ships a single vitest suite under `tests/`.
It runs via `pnpm test` (`vitest run`) and is one link of `pnpm check`
(`pnpm typecheck && pnpm lint && pnpm gates && pnpm test && pnpm build`, see
`package.json`). The `pnpm gates` step is a separate node script
(`scripts/check-ai-cutover.mjs`) rather than a vitest test; it is described in
"The two structural gates" below.

As of this snapshot there are **51 `tests/*.test.ts` files** plus one helper
(`tests/helpers/port.ts`) and two ambient declaration files
(`tests/jsdom.d.ts`, `tests/node-shims.d.ts`).

## Test runner config

`vitest.config.ts` defines the whole environment:

- `test.environment: 'node'` (`vitest.config.ts:61`). There is no global jsdom
  environment; DOM is set up per-file (see "Notable conventions").
- `test.include: ['tests/**/*.test.ts']` (`vitest.config.ts:62`) and
  `test.globals: true` (`vitest.config.ts:63`), so `describe`/`it`/`expect`/`vi`
  are available without import (most files still import them explicitly).
- `define.__CHATGOOSE_BUILD_TIME__: '"test-build"'` (`vitest.config.ts:31-33`)
  supplies the build-time constant esbuild otherwise injects.
- Coverage is configured with the `text` + `html` reporters
  (`vitest.config.ts:64-66`).

Two custom Vite plugins mirror the esbuild loaders the source relies on:

- **`chatgoose-raw-text-assets`** (`vitest.config.ts:35-43`) — any import ending
  in `.md` or `.css` is transformed to `export default <stringified source>`, so
  modules that inline markdown prompt fragments or CSS load as raw strings under
  test.
- **`chatgoose-virtual-drafts`** (`vitest.config.ts:44-58`) — resolves and loads
  the virtual module `virtual:model-card-drafts`. `loadDrafts()`
  (`vitest.config.ts:14-28`) reads `prompts/drafts/*.md` from disk, sorts them
  with a numeric/base-insensitive locale compare (`compareDraftNames`,
  `vitest.config.ts:7-12`), strips the `.md` suffix from the keys, and returns a
  `Record<name, contents>`; a missing directory yields `{}`.

## Helpers & shims

- **`tests/helpers/port.ts`** — mocks the WebExtension `browser.runtime.Port`
  (the background↔content messaging channel that streams operation chunks, the
  suite's SSE-equivalent lane). `createMockRuntimePort(tabId)`
  (`tests/helpers/port.ts:23-54`) returns a `MockRuntimePort` with vi-fn
  `postMessage`/`disconnect`, `onMessage`/`onDisconnect` listener registries
  backed by `Set`s, and imperative `emitMessage`/`emitDisconnect` methods that
  fan a payload to the registered listeners. `postedMessages(port)`
  (`tests/helpers/port.ts:56-62`) reads back `port.postMessage.mock.calls`
  typed as `BackgroundPortMessage[]`. Used by `port-client.test.ts` and
  `operations.test.ts`.
- **`tests/jsdom.d.ts`** — one line, `declare module 'jsdom';`
  (`tests/jsdom.d.ts:1`), so the browser-pure tsconfig accepts the
  `import { JSDOM } from 'jsdom'` used by DOM-oriented tests.
- **`tests/node-shims.d.ts`** — minimal ambient typings for the node built-ins
  the tests touch (`node:os` `tmpdir`, `node:path` `join`, and
  `node:fs/promises` `mkdtemp`/`mkdir`/`rm`/`writeFile`), again because the
  repo's tsconfig targets the browser.

## The two structural gates

Two mechanisms assert the Stage 32 kernel cutover is structurally enforced
rather than merely conventional:

### `tests/kernel-sdk-vendor.test.ts` — vendored `@kernel/sdk` drift gate

Replaces the retired standalone `check-kernel-contract.mjs`
(`tests/kernel-sdk-vendor.test.ts:1-3`). It imports the vendored SDK
(`@kernel/sdk`, a `link:` dependency per `package.json`) and
`vendor/kernel-sdk/kernel-sdk.vendor.json`, then asserts:

- `KERNEL_CONTRACT_HASH` is a 64-hex string and `vendorManifest.contractHash`
  equals it (`tests/kernel-sdk-vendor.test.ts:11-12`) — the contract-hash pin.
- `KERNEL_SDK_VERSION` is truthy (`tests/kernel-sdk-vendor.test.ts:13`).
- `createClient(...)` builds and `Object.keys(kernelOperations).length > 100`
  (`tests/kernel-sdk-vendor.test.ts:17-24`) — the SDK exposes the operations the
  extension consumes.

### `tests/ai-cutover-gates.test.ts` — the manifest half of the AI cutover

Per its header (`tests/ai-cutover-gates.test.ts:1-4`), "the shrunk permission
surface IS the no-direct-AI proof." It imports `manifest.json` and asserts
`manifest.host_permissions` equals exactly
`['*://fansly.com/*', '*://apiv3.fansly.com/*']`
(`tests/ai-cutover-gates.test.ts:10-15`) — no vendor (Anthropic/OpenRouter) host
permissions, so new direct AI calls are structurally impossible.

### `scripts/check-ai-cutover.mjs` — the grep half (run via `pnpm gates`)

The source-grep companion to the manifest test, run outside vitest because the
repo tsconfig is browser-pure (`scripts/check-ai-cutover.mjs:1-4`). It greps
`src/**/*.ts` and fails if it finds:

- vendor endpoints `api.anthropic.com|openrouter.ai`
  (`scripts/check-ai-cutover.mjs:25-28`);
- imports of deleted modules — `llm-client`, `anthropic-client`,
  `openrouter-client`, `llm-cost`, `llm-stream-utils`, `model-registry`,
  `model-capabilities`, `feature-readiness`, `agency-hub-usage-reporter`,
  `shared/prompts` (`scripts/check-ai-cutover.mjs:30-35`).

On any hit it prints the offending paths and exits non-zero
(`scripts/check-ai-cutover.mjs:37-41`).

## Coverage index

| Test file | Subject under test (import) | Verifies |
|---|---|---|
| `acceptance-reporter.test.ts` | `background/acceptance-reporter.ts` | storage.local acceptance spool: drop-oldest with a persisted dropped counter, 400 drops loudly, transients retry with capped attempts |
| `agency-hub-client.test.ts` | `background/agency-hub-client.ts` | kernel HTTP client: request shaping, auth/bearer resolution, response/error handling (mocks `browser` + `fetch` via `jsonResponse`) |
| `agency-hub.test.ts` | `shared/agency-hub.ts` | `buildAgencyHubOriginPattern` strips ports/paths to Firefox-compatible host-permission patterns; null for invalid URLs |
| `ai-cutover-gates.test.ts` | `manifest.json` | manifest carries only the two Fansly host permissions (no vendor AI hosts) — see gates section |
| `button-bar.test.ts` | `content/button-bar.ts` | in-page action bar rendering/state against a jsdom DOM; hotkey labels via `detectLabelPlatform`/`featureHotkeyLabel` |
| `client-version.test.ts` | `shared/client-version.ts` | `extensionClientVersion()`/`clientVersionHeaders()` name the extension + manifest version; header ride-along through the feature gateway |
| `compare-cards.test.ts` | compare-card view models (`shared/types.ts`) | building compare-card view models from persisted state |
| `completed-overlay-cache.test.ts` | `content/overlay/completed-overlay-cache.ts` | LRU-style cache of completed overlay view models keyed by operationId |
| `concurrency.test.ts` | `shared/concurrency.ts` | `mapWithConcurrency` preserves result order, handles empty input, bounds parallelism |
| `content-app.test.ts` | `content/*` app shell | `ChatGooseContentApp` wiring/lifecycle via jsdom + `browser` stub + dynamic import (legacy `as any` seams) |
| `conversation-context-loader.test.ts` | `background/conversation-context-loader.ts` | `loadMediaPurchaseEvidence` assembles media-purchase context from Fansly message pages |
| `conversation-mount-controller.test.ts` | `content/conversation-mount-controller.ts` | mount/unmount of the active-conversation DOM via jsdom + MutationObserver |
| `device-token.test.ts` | `background/device-token.ts`, `agency-hub-client.ts` | `issueAgencyHubDeviceToken` browser flow and `resolveHubBearer` bearer fallback (fetch mocked) |
| `earnings.test.ts` | `shared/earnings.ts` | earnings aggregation (`aggregateEarnings`/`aggregateMonthlyEarnings`), `millsToUsd`, `monthWindowMs`, per-fan formatting |
| `errors.test.ts` | `shared/errors.ts` | `ChatGooseError` codes/keys, `toUserError`, `getErrorMessage` |
| `fansly-client.test.ts` | `background/fansly-client.ts`, `session-store.ts` | Fansly API client requests, subscription/earnings parsing, session-capture header use |
| `hotkeys.test.ts` | `shared/hotkeys.ts` (+ `keymap.ts`) | `buildHotkeyBindings`, `comboLabel`, cheatsheet extras, feature-hotkey mapping |
| `inline-panel-controller.test.ts` | `content/inline-panel/inline-panel-controller.ts` | inline-panel controller against jsdom; textarea insertion mocked; uses `let X: typeof import(...)` + dynamic import idiom |
| `kernel-feature-gateway.test.ts` | `background/kernel-feature-gateway.ts` | kernel feature lane adapter: refs + clientContext on the wire, frame fan-out, gate-message mapping, fail-closed termination |
| `kernel-sdk-vendor.test.ts` | `@kernel/sdk` + vendor manifest | vendored SDK loads and its contract hash matches the exported hash — see gates section |
| `keymap.test.ts` | `shared/keymap.ts` | `createKeymap`, `parseCombo`, `eventMatchesCombo` combo parsing/matching |
| `log.test.ts` | `shared/log.ts` | `logDebug`/`isDebugEnabled` gate console output on the debug flag |
| `operation-profiling.test.ts` | `background/operation-profiling.ts` | `createOperationProfiler` phase timings (Date.now spied for deterministic clocks) |
| `operation-registry.test.ts` | `background/operation-registry.ts` | operation registry lifecycle: register/lookup/abort/cleanup with AbortControllers |
| `operation-timeouts.test.ts` | `background/operation-timeouts.ts` | `OperationTimeoutController` arms/aborts named timeouts (fake timers) |
| `operations.test.ts` | `background` OperationCoordinator | largest suite (~4.1k lines): end-to-end operation streaming through the mock runtime port (`createMockRuntimePort`/`postedMessages`), availability/state/error/dedup paths |
| `options-accounts.test.ts` | options-page accounts view | jsdom-rendered accounts UI over persisted state/session snapshots; `browser` stub + dynamic import |
| `options-agency-hub.test.ts` | options-page Agency Hub view | jsdom-rendered hub-connection settings; permission-grant flow, connection test request shape |
| `overlay-controller.test.ts` | `content/overlay/overlay-controller.ts` | overlay controller (~1.2k lines) against jsdom; textarea/clipboard mocked; reads a CSS asset via `readFileSync` |
| `popup.test.ts` | `popup` UI | browser-action popup rendering against jsdom with a rooted DOM + `browser` stub |
| `port-client.test.ts` | `content/port-client.ts` | `PortClient` boundary guard: only well-formed `BackgroundPortMessage`s from the real port listener are dispatched (uses `createMockRuntimePort`) |
| `protocol.test.ts` | `shared/protocol.ts` | runtime-request/port-message type guards (`getRuntimeRequestType`, `isBackgroundPortMessage`, `isContentPortMessage`) |
| `reply-output.test.ts` | `shared/reply-output.ts` | reply-part normalization (single/variant/provided), removal of prompt-leak fragments without dropping short valid replies |
| `runtime-api.test.ts` | `background` runtime message API | runtime `onMessage` handlers over a mocked storage + `browser`; settings/capture request handling |
| `scroll-compensation.test.ts` | `content/scroll-compensation.ts` | `captureScrollSnapshot`/`applyScrollCompensation` against jsdom; `let X: typeof import(...)` + dynamic import idiom |
| `session-capture.test.ts` | `background/session-capture.ts` | `normalizeRouteKey` maps Fansly API URLs to canonical route keys |
| `session-store.test.ts` | `background/session-store.ts` | per-account session-capture storage/lookup |
| `spend-format.test.ts` | `content/spend-format.ts` | AI spend/token formatting (`formatUsd`, `formatCompactTokens`, primary/secondary/cache-effect strings) |
| `spenders.test.ts` | `shared/spenders.ts` | tier assignment (`assignSpenderTier`), grouping/counting/sorting by lifetime spend |
| `spenders-board-controller.test.ts` | `content/spenders/spenders-board-controller.ts` | spenders board controller rendering/state against jsdom |
| `spenders-service.test.ts` | `background/spenders-service.ts` | spenders listing service over the Fansly client + session template |
| `split.test.ts` | `shared/split.ts` | `splitByNext` splits reply text on `[NEXT]` markers |
| `storage-change-filter.test.ts` | `background/index.ts` filter logic | `storage.onChanged` allowlist + `areaName === 'local'` filtering (logic tested directly, not via index.ts) |
| `storage-coordinator.test.ts` | `background/storage-coordinator.ts` | storage read/write coordination over a mock storage + bundled personalities/defaults |
| `storage-migration.test.ts` | `shared/migrations.ts` | `migrateState`/`MIGRATIONS`, `sanitizeSettings`, `loadStorageState`, `deletePersonality`, schema-version handling |
| `subscriptions.test.ts` | `shared/subscriptions.ts` | `formatFanSubscriptionData` from Fansly subscription tiers/context |
| `summary-cache.test.ts` | `shared/summary-cache.ts` | summary-cache entry validity/model-matching, eviction/oldest-key selection, `SummaryCacheStore` |
| `surface-planner.test.ts` | `content/surface-planner.ts` | `planSurfaces` chooses overlay/compare/completed surfaces per view-model kind |
| `transcript.test.ts` | `shared/transcript.ts` | transcript normalize/format, ping-segment analysis, window-start/target-page estimation, oldest-message extraction |
| `view-helpers.test.ts` | `content/ui/view-helpers.ts` | loading-status formatting, insert-button label/next-part selection, insert-feedback state |
| `xml.test.ts` | `shared/xml.ts` | `parseHelpMeXml`/`parseChatReviewXml` tag parsing + validity flags |

## Notable conventions

- **Dynamic-import mock idiom.** DOM/singleton-heavy modules are imported
  *after* the environment is stubbed so module-top side effects see the fakes.
  Ten files use `await import(...)` (e.g. `content-app.test.ts`,
  `options-accounts.test.ts`, `overlay-controller.test.ts`,
  `storage-coordinator.test.ts`, `popup.test.ts`). Two of them additionally
  declare typed placeholders and assign them after import — the
  `let X: typeof import('...').X;` form at
  `inline-panel-controller.test.ts:179` and
  `scroll-compensation.test.ts:42-43`. Other files instead hoist `vi.mock(...)`
  factories above the static import (e.g. `inline-panel-controller.test.ts:10`,
  `overlay-controller.test.ts:5-9` mocking `content/textarea.js`).
- **Browser global stub.** There is no persistent `browser` global; each suite
  assigns `(globalThis as Record<string, unknown>).browser = { runtime: {...},
  storage: {...}, permissions: {...} }` in `beforeEach`/per test and
  `delete (globalThis as Record<string, unknown>).browser` in `afterEach`.
  Seen in `port-client.test.ts:11-16`, `popup.test.ts:30-48`,
  `content-app.test.ts:44`, `runtime-api.test.ts:57`,
  `storage-coordinator.test.ts:60`, `options-agency-hub.test.ts:150`,
  `options-accounts.test.ts:78`, and repeatedly in `agency-hub-client.test.ts`.
- **jsdom is per-file, not global.** With `environment: 'node'`, DOM-facing
  suites build their own document via `new JSDOM('<!doctype html>...')` and
  `vi.stubGlobal('window'/'document'/'navigator'/'HTMLElement'/…, ...)`
  (e.g. `button-bar.test.ts:7-17`, `overlay-controller.test.ts:258-277`,
  `content-app.test.ts:19-41`, `scroll-compensation.test.ts:4-10`). Eleven test
  files import `jsdom`. Some pass a `url` option so `location` is populated
  (e.g. `scroll-compensation.test.ts:6` uses a `fansly.com/messages/...` URL;
  `popup.test.ts:8` a popup URL).
- **The runtime port as the streaming lane.** Operation-streaming tests drive
  the background→content channel through `createMockRuntimePort` + the
  imperative `emitMessage`/`emitDisconnect` emitters, then assert on
  `postedMessages(port)` (`port-client.test.ts`, `operations.test.ts:17-19`
  and the many `postedMessages(port)` reads through that file). This mock
  runtime port is the extension's SSE-equivalent seam.
- **Fetch/HTTP mocking via `jsonResponse`.** Hub-client and device-token suites
  build real `Response` objects through a local `jsonResponse(payload, status)`
  helper (`agency-hub-client.test.ts:6-11`, `device-token.test.ts:8-13`) and a
  stubbed `fetch`.
- **Deterministic time.** Timer/profiling suites use `vi.useFakeTimers()` with
  `vi.useRealTimers()` teardown (`operation-timeouts.test.ts:5-13`) or spy
  `Date.now` (`operation-profiling.test.ts:5-14`).
- **Import extensions.** Tests import source with explicit `.js` ESM specifiers
  pointing at `src/**` (e.g. `../src/shared/errors.js`), consistent with the
  extension's ESM/TS-strict build.
