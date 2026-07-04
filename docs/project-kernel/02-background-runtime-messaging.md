# Background — Composition Root, Messaging & Session Capture

## Scope

This map covers the service-worker composition root, the one-shot runtime
request API, the per-tab context and per-account session state, the Fansly
credential-capture boundary, and the IPC protocol type guards. Exact files:

- `src/background/index.ts` — composition root / global listeners
- `src/background/runtime-api.ts` — one-shot `runtime.onMessage` request handlers
- `src/background/tab-context.ts` — `TabContextStore` (per-tab UI/route state)
- `src/background/session-store.ts` — `SessionStore` (per-account captured credentials)
- `src/background/session-capture.ts` — `webRequest` Fansly-auth boundary
- `src/shared/protocol.ts` — runtime + Port message type guards and the request-send helper

Supporting symbols in other files are cited where these files call into them
(`operations.ts`, `storage-coordinator.ts`, `fansly-client.ts`,
`agency-hub-client.ts`, `spenders-service.ts`, `summary-cache.ts`,
`compare-cards.ts`, `feature-readiness.ts`, `operation-utils.ts`, `errors.ts`,
`constants.ts`, `types.ts`) but are documented in full elsewhere.

Note on the environment: this is a Firefox MV3 extension whose background is a
non-module classic script (`manifest.json` `background.scripts: ["background.js"]`,
not `service_worker`), though the composition-root comment calls it the
"service-worker composition root". Host permissions granted at install:
`*://fansly.com/*`, `*://apiv3.fansly.com/*`, `*://api.anthropic.com/*`,
`https://openrouter.ai/*`; static permissions `storage`, `unlimitedStorage`,
`webRequest`, `tabs`. Content script `content.js` is injected on `*://fansly.com/*`
at `document_idle`.

---

## 1. `src/background/index.ts` — Composition Root

Top-of-file module code that runs once when the background script loads. No
exported symbols; the file's effect is entirely in its side effects (object
construction + global listener registration). No module-level mutable state
beyond the DI singletons (comment at `index.ts:15`).

### 1.1 DI wiring (`index.ts:17-35`)

Constructs the singletons in dependency order and hands each its collaborators:

| Singleton | Constructor args | File |
|---|---|---|
| `sessionStore` | — | `session-store.ts` |
| `tabContexts` | — | `tab-context.ts` |
| `storageCoordinator` | — | `storage-coordinator.ts` |
| `fanslyClient` | `sessionStore` | `fansly-client.ts` |
| `spendersService` | `fanslyClient` | `spenders-service.ts` |
| `anthropicClient` | — | `anthropic-client.ts` |
| `openRouterClient` | — | `openrouter-client.ts` |
| `llmClient` | `anthropicClient, openRouterClient` | `llm-client.ts` |
| `agencyHubClient` | — | `agency-hub-client.ts` |
| `agencyHubUsageReporter` | `agencyHubClient` | `agency-hub-usage-reporter.ts` |
| `coordinator` (`OperationCoordinator`) | `sessionStore, tabContexts, fanslyClient, llmClient, storageCoordinator, agencyHubClient, agencyHubUsageReporter` | `operations.ts` |

### 1.2 Global listeners registered

1. **`browser.runtime.onConnect`** (`index.ts:37-39`) → `coordinator.registerPort(port)`.
   This is the entry point for the long-lived content↔background Port (see §6.2).
   `registerPort` (`operations.ts:491`) reads `port.sender?.tab?.id`; returns
   early if absent, otherwise stores the port in `portsByTabId`, attaches
   `onMessage` (guarded by `isContentPortMessage`) and `onDisconnect`
   (cancels the tab's operations and drops the port).

2. **`initializeSessionCapture(sessionStore, onCapture)`** (`index.ts:41-44`).
   The `onCapture` callback (runs on every accepted Fansly request, see §5.4)
   is `async (tabId, accountId) => { await storageCoordinator.registerKnownAccount(accountId); await coordinator.handleCapture(tabId, accountId); }`.
   - `registerKnownAccount` (`storage-coordinator.ts:102`) appends the
     base64-decoded `accountId` to the persisted `knownAccounts` array
     (storage key `knownAccounts`) if not already present, sorted.
   - `handleCapture` (`operations.ts:539`) sets the tab's account on
     `tabContexts`, refreshes tab UI state, and kicks off identity resolution.

3. **`registerRuntimeApi({...})`** (`index.ts:46-53`) — passes
   `agencyHubClient, fanslyClient, sessionStore, spendersService, tabContexts,
   storageCoordinator` (note: `llmClient`, `coordinator`, and the usage reporter
   are NOT passed to the runtime API). See §2.

4. **`browser.tabs.onRemoved`** (`index.ts:55-57`) → `void coordinator.handleTabRemoved(tabId)`.
   `handleTabRemoved` (`operations.ts:545`) cancels the tab's feature + compare
   operations, calls `sessionStore.forgetTab(tabId)`, `tabContexts.remove(tabId)`,
   and deletes the tab's port from `portsByTabId`.

5. **`browser.storage.onChanged`** (`index.ts:68-75`):
   - Always calls `storageCoordinator.applyStorageChanges(changes, areaName)`
     to keep the in-memory `PersistedState` cache coherent
     (`storage-coordinator.ts:77` — no-op unless `areaName === 'local'` and a
     state cache already exists).
   - Returns early if `areaName !== 'local'`.
   - If any changed key is in `UI_RELEVANT_KEYS`, calls
     `void coordinator.refreshAllTabs('settings:changed')` (pushes a
     `settings:changed` Port message with fresh `TabUiState` to every connected tab).

   `UI_RELEVANT_KEYS` (`index.ts:59-66`) = `Set(['settings', 'personalities',
   'accountMappings', 'accountAliases', 'knownAccounts', 'schemaVersion'])`.
   Summary-cache keys (`summary:*`) are deliberately excluded from this trigger set.

6. **`void storageCoordinator.init()`** (`index.ts:77`) — primes the in-memory
   state cache by loading persisted storage (`storage-coordinator.ts:54`, just
   calls `getState()`).

### 1.3 Imports

`agency-hub-client`, `agency-hub-usage-reporter`, `anthropic-client`,
`fansly-client`, `llm-client`, `openrouter-client`, `operations`, `runtime-api`,
`session-capture`, `session-store`, `spenders-service`, `storage-coordinator`,
`tab-context`. This is the only file that imports `session-capture` and
`runtime-api`. Nothing imports `index.ts` (it is the background entry point).

---

## 2. `src/background/runtime-api.ts` — One-shot Runtime Request API

### 2.1 Structure

- `SESSION_IDENTITY_TIMEOUT_MS = 5_000` (`runtime-api.ts:28`) — per-session
  enrichment timeout in `getSessionsSnapshot`.
- `interface RuntimeApiDeps` (`runtime-api.ts:30-37`) — the six collaborators
  listed in §1.2 item 3.
- `export function registerRuntimeApi(deps)` (`runtime-api.ts:39`) — registers a
  single `async` `browser.runtime.onMessage` listener (`runtime-api.ts:47`).
  The listener resolves to the typed response for the four known request types
  and resolves to `undefined` for anything else. `sender` is used only by
  `getSpendersList`.

The listener's first step is `getRuntimeRequestType(message)` (from
`protocol.ts`, §6.1). If it returns `null`, the handler returns `undefined`
(`runtime-api.ts:49-52`). This function is the sole `RuntimeRequestMap` dispatch
in the background. Only `index.ts` calls `registerRuntimeApi`.

### 2.2 `getPopupStatus` → `PopupStatus` (`runtime-api.ts:54-136`)

Callers: popup (`src/popup/index.ts`) and options (`src/options/index.ts`) via
`sendRuntimeRequest('getPopupStatus', { tabId? })`.

Tab resolution:
- If `message.tabId` is a number → `browser.tabs.get(requestedTabId)`, uses
  `tab.id ?? requestedTabId` and `tab.url`.
- Otherwise → `browser.tabs.query({ active: true, currentWindow: true })`,
  uses `activeTab?.id` and `activeTab?.url`.

If no `tabId` resolves, returns a disconnected stub (`runtime-api.ts:75-88`):
`{ tabId: -1, accountId: null, groupId: null, hasAvailableSummary: false,
connected: false, hasApiKey: false, hasPersonalities: false,
mappedPersonalityId: null, mappedPersonalityName: null, compareCardCount: 0,
compareDraftCount: 0, accountLabel: 'Not connected' }`. (This branch omits the
optional `modelProviderByFeature` / `apiKeyReadyByFeature` fields — allowed by
`satisfies PopupStatus` since both are optional on `TabUiState`.)

Otherwise assembles the full `PopupStatus`:
- `state = await storageCoordinator.getState()` — persisted `PersistedState`.
- `session = sessionStore.getSessionForTab(tabId)`; `legacyAccountId =
  sessionStore.getAccountIdForTab(tabId)`; `accountId =
  session?.resolvedAccountId ?? legacyAccountId` (resolved identity wins,
  legacy base64-decoded id is the fallback).
- `context = tabContexts.getOrCreate(tabId)`.
- `displayGroupId = context.groupId ?? parseGroupIdFromUrl(tabUrl)`
  (`operation-utils.ts:13`, regex `/\/messages\/([^/?#]+)/`). The comment
  (`runtime-api.ts:96-98`) states the popup read must not clobber the content
  script's authoritative route, so it prefers the tracked `context.groupId`.
- Side effect: `context.accountId = accountId` (`runtime-api.ts:100`) — the
  popup read writes the resolved account back onto the tab context.
- `mappedPersonalityId = resolveMappedPersonalityId(state.accountMappings,
  accountId, legacyAccountId, state.accountAliases)` (`compare-cards.ts:16`),
  which walks `buildAccountLookupOrder(...)` (aliases + both ids).
- `mappedPersonalityName` = matching `state.personalities[].name` or `null`.
- `connected = Boolean(session?.connected)`.
- `compareDraftCount = getCompareDraftCount()` (`compare-cards.ts:37`, number of
  build-time model-card drafts).

Returned `PopupStatus` fields (`runtime-api.ts:114-135`):

| Field | Value |
|---|---|
| `tabId` | resolved tab id |
| `accountId` | `session?.resolvedAccountId ?? legacyAccountId` |
| `groupId` | `displayGroupId` |
| `hasAvailableSummary` | `hasAvailableFanSummary(state, displayGroupId, mappedPersonalityId)` (`summary-cache.ts:278`) |
| `connected` | `Boolean(session?.connected)` |
| `hasApiKey` | `Boolean(state.settings.claudeApiKey \|\| state.settings.openRouterApiKey)` |
| `modelProviderByFeature` | `buildModelProviderByFeature(state.settings)` (`feature-readiness.ts:9`) |
| `apiKeyReadyByFeature` | `buildApiKeyReadyByFeature(state.settings)` (`feature-readiness.ts:24`) |
| `hasPersonalities` | `state.personalities.length > 0` |
| `mappedPersonalityId` | resolved mapping |
| `mappedPersonalityName` | mapped personality name or `null` |
| `compareCardCount` | `compareDraftCount + (mappedPersonalityId ? 1 : 0)` |
| `compareDraftCount` | `compareDraftCount` |
| `accountLabel` | `mappedPersonalityName ?? (accountId ? 'Unmapped account' : 'Not connected')` |

### 2.3 `getSessionsSnapshot` → `SessionSnapshotEntry[]` (`runtime-api.ts:138-190`)

Caller: options UI (`src/options/index.ts`) via `sendRuntimeRequest('getSessionsSnapshot')`.

1. `unresolvedSessions` = `sessionStore.getSessions()` filtered to sessions that
   are `connected` AND (`!resolvedAccountId` OR (`!resolvedUsername` AND
   `!resolvedDisplayName`)) (`runtime-api.ts:139-147`). Note: `getSessions()`
   returns **all** entries in `sessionsByAccount` (including accounts with no
   currently-bound tab), whereas `snapshot()` (step 3) returns only accounts
   referenced by a live tab — the enrichment set can be a superset of the
   returned set.
2. `await Promise.allSettled(...)`: for each unresolved session, creates an
   `AbortController` with a `SESSION_IDENTITY_TIMEOUT_MS` (5s) timeout and calls
   `fanslyClient.getAuthenticatedAccount(session, controller.signal)`
   (`fansly-client.ts:427`). That call fetches `GET
   https://apiv3.fansly.com/api/v1/account/me` (RouteKey `account`) and mutates
   the session in place, setting `resolvedAccountId`, `resolvedUsername`,
   `resolvedDisplayName`. Errors are swallowed ("best-effort enrichment").
   `clearTimeout` in `finally`.
3. `snapshot = sessionStore.snapshot()` (`session-store.ts:121`) — one entry per
   account currently bound to a tab.
4. **Rekey:** for each snapshot entry where `resolvedAccountId` exists and
   differs from `legacyAccountId`, `await
   storageCoordinator.rekeyAccountIdentity(legacyAccountId, resolvedAccountId)`
   (`storage-coordinator.ts:140`) — migrates `accountAliases`,
   `accountMappings`, and `knownAccounts` from the legacy id to the resolved id
   (writes storage keys `accountAliases`, `accountMappings`, `knownAccounts`).
5. **Reconcile:** `await
   storageCoordinator.reconcileKnownAccounts(snapshot.map(s =>
   s.resolvedAccountId ?? s.legacyAccountId))` (`storage-coordinator.ts:119`) —
   rewrites `knownAccounts` to the union of active canonical ids + all
   `accountMappings` keys, sorted.
6. Returns `snapshot` (`SessionSnapshotEntry[]`).

### 2.4 `testAgencyHubConnection` → `AgencyHubConnectionTestResponse` (`runtime-api.ts:192-214`)

Caller: options UI via `sendRuntimeRequest('testAgencyHubConnection', { settings })`.

- Validates `message.settings` with `isAgencyHubConnectionTestSettings`
  (`protocol.ts:180`, requires string `agencyHubBaseUrl` and `agencyHubApiKey`).
  If invalid → `{ ok: false, error: createUserError('hub_request_failed') }`.
- Otherwise `AbortController` with `AGENCY_HUB_PREFETCH_TIMEOUT_MS` (5s,
  `constants.ts:152`); returns `await agencyHubClient.testConnection(settings,
  controller.signal)` (`agency-hub-client.ts:289`). `clearTimeout` in `finally`.
  `testConnection` normalizes the base URL, checks host permission, and hits
  `GET api/v1/pages` (the Agency Hub boundary; documented with that client),
  mapping failures to `hub_*` `UserErrorKey`s.

### 2.5 `getSpendersList` → `SpendersListResponse` (`runtime-api.ts:216-241`)

Caller: content spenders board (`src/content/spenders/spenders-board-controller.ts`)
via `sendRuntimeRequest('getSpendersList', { refresh? })`.

- `tabId = sender.tab?.id` (unlike other handlers, this keys off the **calling
  tab**, not the active/queried tab). `session =
  sessionStore.getSessionForTab(tabId)`.
- If no session or `!session.connected` → `{ ok: false, error:
  createUserError('not_connected') }`.
- `refresh = message.refresh === true`. `AbortController` with
  `SPENDERS_BUILD_TIMEOUT_MS` (120s, `constants.ts:105`).
- `result = await spendersService.getList(session, controller.signal, {
  refresh })` (`spenders-service.ts:41`). On success → `{ ok: true, result }`.
- On error: `AbortError` DOMException → `createUserError('timed_out')`;
  otherwise `toUserError(error)` (`errors.ts:353`). `clearTimeout` in `finally`.

### 2.6 Imports / dependency surface

Imports from `constants` (`AGENCY_HUB_PREFETCH_TIMEOUT_MS`,
`SPENDERS_BUILD_TIMEOUT_MS`), `compare-cards` (`getCompareDraftCount`,
`resolveMappedPersonalityId`), `errors` (`createUserError`, `toUserError`),
`feature-readiness` (`buildApiKeyReadyByFeature`, `buildModelProviderByFeature`),
`protocol` (`getRuntimeRequestType`, `isAgencyHubConnectionTestSettings`,
`isObjectRecord`), `summary-cache` (`hasAvailableFanSummary`), `types`
(`PopupStatus`), and the five injected classes plus `parseGroupIdFromUrl` from
`operation-utils`. Note `FanslyClient`, `SessionStore`, `SpendersService`,
`StorageCoordinator`, `TabContextStore` are imported as concrete classes (used
only as types here).

---

## 3. `src/background/tab-context.ts` — `TabContextStore`

Per-tab mutable UI/route state, keyed by numeric `tabId`. Backing store:
`private readonly contexts = new Map<number, TabContext>()`. `TabContext` shape
(`types.ts:132-140`): `{ tabId, accountId, groupId, fanAccountId, fanDisplayName,
activeOperationId, routeNonce }`. No storage, no network.

Methods:

| Method | Behavior |
|---|---|
| `getOrCreate(tabId)` | Returns existing or creates a fresh context: `accountId:null, groupId:null, fanAccountId:null, fanDisplayName:null, activeOperationId:null, routeNonce:0` (`tab-context.ts:6-24`). |
| `setAccount(tabId, accountId)` | Sets `context.accountId` (`:26`). |
| `setRoute(tabId, groupId, routeNonce)` | Sets `groupId` + `routeNonce`; **if `groupId` is falsy also clears `fanAccountId` and `fanDisplayName`** (`:32-41`). |
| `setFan(tabId, fanAccountId, fanDisplayName)` | Sets both fan fields (`:43`). |
| `setActiveOperation(tabId, operationId)` | Sets `activeOperationId` (`:50`). |
| `get(tabId)` | Returns context or `null` (`:56`). |
| `remove(tabId)` | Deletes the entry (`:60`). |

`routeNonce` is a monotone counter supplied by the content script on
`tab:init`/`tab:routeChanged` and stored here; it is used by the operation
coordinator to detect stale route changes. `TabContextStore` is instantiated in
`index.ts` and used by `runtime-api.ts` (`getOrCreate` in `getPopupStatus`),
`operations.ts`, and `compare-operations.ts` (route/fan/operation mutations).

---

## 4. `src/background/session-store.ts` — `SessionStore`

Holds captured Fansly credentials per account plus the tab→account binding.
Two `Map`s (`session-store.ts:14-15`):

- `sessionsByAccount: Map<string, SessionTemplate>` keyed by the **legacy
  account id** (base64-decoded authorization, see §5.2).
- `accountByTabId: Map<number, string>` — which legacy account id each tab last
  captured for.

`SessionCaptureResult` interface (`session-store.ts:3-11`): `{ accountId,
authorization, fanslyClientId, fanslySessionId, fanslyClientTs, fanslyClientCheck:
string|null, routeKey: RouteKey|null }`.

`SessionTemplate` (`types.ts:109-122`): `{ accountId, resolvedAccountId,
resolvedUsername, resolvedDisplayName, authorization, fanslyClientId,
fanslySessionId, latestTs, latestCheck, routeChecks: Partial<Record<RouteKey,
string>>, lastSeenAt, connected }`. Two-tier identity: `accountId` = legacy id
(the map key); `resolvedAccountId`/`resolvedUsername`/`resolvedDisplayName` are
filled later by `fanslyClient.getAuthenticatedAccount` from
`/api/v1/account/me`.

### 4.1 Methods

**`registerCapture(tabId, capture) → SessionTemplate`** (`session-store.ts:17-62`) —
called from `session-capture.ts` on every accepted request:
- If the tab was previously bound to a **different** account, deletes the
  tab→account entry and prunes the old session if now orphaned
  (`pruneOrphanedSession`).
- Reuses the existing `SessionTemplate` object identity when the same account
  re-captures (comment `:24-27`: a re-login refreshes credentials in place so an
  in-flight request holding the reference picks up the new token instead of
  401ing on a stale copy). On reuse it overwrites `authorization`,
  `fanslyClientId`, `fanslySessionId`, `latestTs`, `latestCheck`, `lastSeenAt`,
  `connected=true`, and preserves `resolvedAccountId`/`resolvedUsername`/
  `resolvedDisplayName` and accumulated `routeChecks`.
- New session: seeds all fields, `resolved*: null`, `routeChecks: {}`,
  `connected: true`, `lastSeenAt: Date.now()`.
- If both `capture.routeKey` and `capture.fanslyClientCheck` are present, stores
  `session.routeChecks[routeKey] = fanslyClientCheck` (`:55-57`) — the per-route
  `fansly-client-check` token accumulator.
- Writes both maps and returns the session.

**`getSessionByAccount(accountId)`** (`:64-81`) — direct lookup by legacy id,
then a linear scan matching `resolvedAccountId`; else `null`. Null/empty id → `null`.

**`getSessionForTab(tabId)`** (`:83-86`) — resolves via `accountByTabId` then
`getSessionByAccount`.

**`getSessions()`** (`:88-90`) — all `sessionsByAccount` values (includes
tab-less accounts).

**`getAccountIdForTab(tabId)`** (`:92-94`) — the legacy id or `null`.

**`getDisplayAccountIdForTab(tabId)`** (`:96-99`) — `resolvedAccountId ??
accountId ?? null` for the tab's session.

**`markDisconnected(accountId)`** (`:101-110`) — sets `connected=false` in place
(comment: so an in-flight request observes the disconnect). No-op if unknown.

**`forgetTab(tabId)`** (`:112-119`) — removes the tab→account binding and prunes
the session if now unreferenced. Called by `handleTabRemoved`.

**`snapshot() → SessionSnapshotEntry[]`** (`:121-141`) — one entry per **distinct
account currently referenced by a tab** (`new Set(accountByTabId.values())`);
each `{ legacyAccountId, resolvedAccountId, username: resolvedUsername,
displayName: resolvedDisplayName, connected, lastSeenAt }`. Accounts with no
live tab are excluded even if still in `sessionsByAccount`.

**`pruneOrphanedSession(accountId)`** / **`isAccountReferenced(accountId)`**
(`:143-153`, private) — deletes a session from `sessionsByAccount` when no tab
references it.

`SessionStore` is imported by `fansly-client.ts`, `operations.ts`,
`runtime-api.ts`, `compare-operations.ts`, `session-capture.ts`, `index.ts`.

---

## 5. `src/background/session-capture.ts` — Fansly Auth Boundary

This is boundary #1 (Fansly REST auth). It sniffs outbound request headers on
Fansly API calls made by the Fansly web app in the content tab and turns them
into `SessionCaptureResult`s. Browser API used: `browser.webRequest.onBeforeSendHeaders`.

### 5.1 `normalizeRouteKey(url) → RouteKey | null` (`session-capture.ts:14-37`)

Ordered substring test mapping request URL → `RouteKey` (`types.ts:6`). Order
matters (first match wins):

| Substring tested | `RouteKey` |
|---|---|
| `/api/v1/account/wallets/earnings/` | `earnings` |
| `/api/v1/subscribers` | `subscribers` |
| `/api/v1/media/orderhistory` | `media` |
| `/api/v1/messaging/groups` | `messagingGroups` |
| `/api/v1/group/` | `group` |
| `/api/v1/message` | `message` |
| `/api/v1/account?` | `account` |
| (none) | `null` |

`earnings` is tested before the generic `/api/v1/account?` so the earnings
wallet URL is not mis-tagged. `messagingGroups` precedes `message` and `group`.
(`/api/v1/message` is not a substring of `/api/v1/messaging/...` because
`message` ≠ `messaging`.)

### 5.2 `decodeLegacyAccountKey(authorization) → string | null` (`:4-12`)

`atob(authorization)` (base64 decode), split on `:`, take `[0].trim()`; returns
the account id or `null` on empty/decode error. This is the source of the
**legacy account id** that keys `SessionStore.sessionsByAccount`. The Fansly
authorization token base64-decodes to `"<accountId>:<...>"`.

### 5.3 `extractCapture(headers, url) → SessionCaptureResult | null` (`:39-79`)

- Returns `null` if `headers` undefined.
- Lower-cases all header names into a `Map`.
- Reads the four **mandatory** headers: `authorization`, `fansly-client-id`,
  `fansly-client-ts`, `fansly-session-id`. If any is missing → `null`
  (comment `:60` "All 4 headers are mandatory").
- `accountId = decodeLegacyAccountKey(authorization)`; if falsy → `null`.
- Builds `SessionCaptureResult`: the four headers, plus optional
  `fanslyClientCheck = normalized.get('fansly-client-check') ?? null` and
  `routeKey = normalizeRouteKey(url)`.

Header→field mapping (all string values from the wire):

| HTTP header | field |
|---|---|
| `authorization` | `authorization` (and, decoded, `accountId`) |
| `fansly-client-id` | `fanslyClientId` |
| `fansly-client-ts` | `fanslyClientTs` |
| `fansly-session-id` | `fanslySessionId` |
| `fansly-client-check` (optional) | `fanslyClientCheck` |

### 5.4 `initializeSessionCapture(sessionStore, onCapture)` (`:81-103`)

Registers `browser.webRequest.onBeforeSendHeaders` with:
- filter `{ urls: ['https://apiv3.fansly.com/*'] }` (only the `https` scheme,
  though `manifest.json` grants `*://apiv3.fansly.com/*`),
- extra info spec `['requestHeaders']`.

Listener body:
- Ignores `details.tabId < 0` (non-tab requests, e.g. the extension's own
  background fetches — comment `:87`).
- `capture = extractCapture(details.requestHeaders, details.url)`; returns if `null`.
- `sessionStore.registerCapture(details.tabId, capture)`.
- `void onCapture(details.tabId, capture.accountId)` — fires the composition-root
  callback (register known account + `coordinator.handleCapture`, §1.2 item 2).

The listener returns nothing (no `blocking` in the extra-info spec) — it is a
read-only observer that never modifies or blocks requests. Only `index.ts`
imports/initializes this module.

---

## 6. `src/shared/protocol.ts` — IPC Protocol Guards

Runtime validation and typing for both IPC channels. Pure functions, no state
except three module-level `Set`s built from other modules. Imports
`FEATURE_POLICIES` (`features.js`) and many types (`types.js`).

### 6.1 Runtime one-shot channel

Module `Set`s used for validation:
- `FEATURE_TYPES` = keys of `FEATURE_POLICIES` (`fast-reply`, `improve-draft`,
  `help-me`, `fan-summary`, `chat-review`, `ping`, `hi-greeting`).
- `OPERATION_PHASES` = `idle, loading-messages, loading-earnings, generating,
  completed, cancelled, error`.
- `REPLY_MODES` = `default, preferSplit`.
- `REPLY_TONES` = `none, casual, flirty, upsell, spicy`.

Exported helpers:
- **`isObjectRecord(value)`** (`:54`) — object, non-null, non-array. Used widely
  in `runtime-api.ts` too.
- **`getRuntimeRequestType(message) → RuntimeRequestType | null`** (`:159-178`):
  switches on `message.type`:
  - `getPopupStatus` → valid only if `tabId` is `undefined` or a finite number.
  - `getSessionsSnapshot` → always valid.
  - `testAgencyHubConnection` → always valid (settings validated later, §2.4).
  - `getSpendersList` → valid only if `refresh` is absent or boolean.
  - default → `null`.
- **`isAgencyHubConnectionTestSettings(value)`** (`:180-186`) — object with
  string `agencyHubBaseUrl` and string `agencyHubApiKey`.
- **`sendRuntimeRequest(type, payload?)`** (`:264-282`) — overloaded typed
  wrapper over `browser.runtime.sendMessage`. Builds `{ type }` or `{ type,
  ...payload }` and returns `RuntimeResponseMap[type]`. Two overloads separate
  optional-payload request types (`getPopupStatus`, `getSessionsSnapshot`,
  `getSpendersList`) from required-payload (`testAgencyHubConnection`). Callers:
  `content/index.ts`, `content/spenders/spenders-board-controller.ts`,
  `options/index.ts`, `popup/index.ts`.

Request/response maps (`types.ts:693-705`):

| type | request payload | response |
|---|---|---|
| `getPopupStatus` | `{ tabId?: number }` (optional) | `PopupStatus` |
| `getSessionsSnapshot` | none | `SessionSnapshotEntry[]` |
| `testAgencyHubConnection` | `{ settings: { agencyHubBaseUrl, agencyHubApiKey } }` | `AgencyHubConnectionTestResponse` |
| `getSpendersList` | `{ refresh?: boolean }` (optional) | `SpendersListResponse` |

### 6.2 Port channel (long-lived `runtime.Port`)

The Port is opened by the content script:
`browser.runtime.connect({ name: 'chatgoose-content' })` (`content/port-client.ts:23`),
accepted by `browser.runtime.onConnect` → `coordinator.registerPort`
(`operations.ts:491`). Content→background messages are validated with
`isContentPortMessage` (in `registerPort`); background→content messages with
`isBackgroundPortMessage` (`content/port-client.ts:25`).

**`isContentPortMessage(message)`** (`:188-207`) — Content → Background:

| `type` | validated shape |
|---|---|
| `tab:init`, `tab:routeChanged` | `isTabRouteMessage`: nullable-string `groupId` + finite-number `routeNonce` |
| `operation:start` | `isOperationStartMessage`: string `operationId`, `feature` ∈ FEATURE_TYPES, `isTabRouteMessage`, nullable-string `domFanDisplayName`, optional-string `draftText`, optional-boolean `forceRegenerate`, optional `replyMode` ∈ REPLY_MODES, optional `replyTone` ∈ REPLY_TONES |
| `compare:start` | `isCompareStartMessage`: string `operationId`, `isTabRouteMessage`, nullable-string `domFanDisplayName`, optional-boolean `forceRegenerate`, optional `replyMode`, optional `replyTone` (no `feature`) |
| `operation:cancel`, `compare:cancel` | `hasOperationId`: string `operationId` |
| default | `false` |

**`isBackgroundPortMessage(message)`** (`:209-262`) — Background → Content:

| `type` | validated shape |
|---|---|
| `operation:chunk` | `operationId` + string `text` |
| `compare:chunk` | `operationId` + string `cardId` + string `text` |
| `operation:debugPrompt` | `operationId` + `feature` ∈ FEATURE_TYPES + object `snapshot` |
| `operation:complete` | `operationId` + object `result` + string `fanDisplayName` |
| `operation:error`, `operation:discarded` | `operationId` + object `error` |
| `compare:ready` | `operationId` + string `fanDisplayName` + array `cards` |
| `compare:cardComplete` | `operationId` + `cardId` + object `result` + string `fanDisplayName` |
| `compare:cardError` | `operationId` + `cardId` + object `error` |
| `compare:error`, `compare:discarded` | `operationId` + object `error` |
| `compare:complete` | `operationId` + string `fanDisplayName` |
| `tab:state`, `settings:changed`, `mapping:changed` | object `state` (all three share the identical `TabStatePayload` guard) |
| `summary:syncStatus` | string `groupId` + finite-number `generatedAt` + object `syncStatus` |
| `operation:progress` | `hasOperationProgressShape` + `feature` ∈ FEATURE_TYPES |
| `compare:progress` | `hasOperationProgressShape` + optional-string `fanDisplayName` |
| default | `false` |

Internal predicates: `isString`, `isNumber` (finite), `isBoolean`,
`isNullableString`, `isOptionalString/Number/Boolean` (undefined-or-typed),
`isFeatureType`, `isOperationPhase`, `isReplyMode`, `isReplyTone`,
`isOptionalReplyMode`, `isOptionalReplyTone`, `hasOperationId`, `hasCardId`,
`hasFeatureResult` (object `result`), `hasUserFacingError` (object `error`),
`isTabRouteMessage`. `hasOperationProgressShape` (`:118-125`) requires string
`operationId`, `phase` ∈ OPERATION_PHASES, optional-number `currentPage`/
`targetPages`, optional-string `message`, and `isObjectRecord(record.profiling
?? {})` — i.e. `profiling` must be absent or an object; its inner shape is not
checked. These guards validate the discriminant `type` and a subset of fields;
they do not deeply validate nested payloads (`result`, `error`, `snapshot`,
`cards`, `state`, `syncStatus`, `profiling` are only checked to be
objects/arrays, not against their full interfaces).

The full discriminated-union payload interfaces live in `types.ts:776-1000`
(`PortEnvelopeBase`, `ContentPortMessage`, `BackgroundPortMessage` and members).

---

## 7. Cross-module dependency summary

- `index.ts` constructs everything and is imported by nothing.
- `runtime-api.ts`: ← `index.ts` only; → `SessionStore`, `TabContextStore`,
  `StorageCoordinator`, `FanslyClient`, `SpendersService`, `AgencyHubClient`,
  and shared helpers (`compare-cards`, `feature-readiness`, `summary-cache`,
  `protocol`, `errors`, `operation-utils`, `constants`).
- `session-capture.ts`: ← `index.ts` only; → `SessionStore` + `RouteKey` type.
- `session-store.ts`: ← `session-capture`, `fansly-client`, `operations`,
  `compare-operations`, `runtime-api`, `index`.
- `tab-context.ts`: ← `runtime-api`, `operations`, `compare-operations`, `index`.
- `protocol.ts`: ← `runtime-api`, `operations` (background) and `options/index`,
  `content/port-client`, `content/index`, `popup/index` (frontends); → `features`
  + `types`.

---

## 8. Boundary crossings originating in these files

| Kind | Where | Detail / data crossing |
|---|---|---|
| browser-api / network (Fansly auth) | `session-capture.ts:85-102` | `webRequest.onBeforeSendHeaders` filter `https://apiv3.fansly.com/*`, `['requestHeaders']`; reads `authorization`, `fansly-client-id`, `fansly-client-ts`, `fansly-session-id`, optional `fansly-client-check`. Read-only (non-blocking). |
| network (Fansly) | `runtime-api.ts:157` → `fansly-client.ts:427` | `getSessionsSnapshot` enrichment → `GET https://apiv3.fansly.com/api/v1/account/me`; 5s abort. Mutates session `resolved*`. |
| network (Fansly, indirect) | `runtime-api.ts:230` → `spenders-service` | `getSpendersList` → Fansly conversation enumeration + per-fan earnings (120s abort). |
| network (Agency Hub) | `runtime-api.ts:210` → `agency-hub-client.ts:289` | `testAgencyHubConnection` → `GET api/v1/pages` at configured base URL, Bearer `agencyHubApiKey`; 5s abort. |
| storage (local) | `index.ts:41-42`, `:68-75` | On capture: `registerKnownAccount` writes key `knownAccounts`. `storage.onChanged` mirrors changes into the in-memory `PersistedState` and refreshes tabs on `UI_RELEVANT_KEYS`. |
| storage (local) | `runtime-api.ts:176-187` | `getSessionsSnapshot` writes `accountAliases`, `accountMappings`, `knownAccounts` via `rekeyAccountIdentity` / `reconcileKnownAccounts`. |
| storage (local, read) | `runtime-api.ts:91` | `getPopupStatus` reads full `PersistedState` via `storageCoordinator.getState()`. |
| ipc (runtime one-shot) | `runtime-api.ts:47` | `runtime.onMessage` handling `getPopupStatus`, `getSessionsSnapshot`, `testAgencyHubConnection`, `getSpendersList` (schemas §6.1). |
| ipc (long-lived Port) | `index.ts:37-39` → `operations.ts:491` | `runtime.onConnect` for Port `chatgoose-content`; `ContentPortMessage` in, `BackgroundPortMessage` out (guards §6.2). |
| browser-api (tabs) | `runtime-api.ts:62,66`; `index.ts:55` | `tabs.get`, `tabs.query({active,currentWindow})`, `tabs.onRemoved`. |
