> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Background service worker: composition root, runtime/messaging, Fansly session custody

This document maps the extension's background context: how its singletons are
wired, which global browser listeners it installs, the `runtime.onMessage`
request/response surface, the content⇄background `Port` protocol, the Fansly
credential-capture boundary, and the storage-change fan-out.

The background is declared as a non-persistent MV3 event page — a single classic
script, not a `service_worker` key: `manifest.json:20` `"background": {
"scripts": ["background.js"] }`. Target is Gecko/Firefox (`browser_specific_settings.gecko`,
`manifest.json:53`, `strict_min_version` `142.0`). Static permissions include
`webRequest`, `tabs`, `storage`, `unlimitedStorage` (`manifest.json:6`), static
host permissions for `*://fansly.com/*` and `*://apiv3.fansly.com/*`
(`manifest.json:12`), and `optional_host_permissions` covering all http/https
origins (`manifest.json:16`) — the hub base URL is granted at runtime out of
that optional set.

## Composition root & DI graph

`src/background/index.ts` is the composition root. It constructs every singleton
once at module load with no module-level mutable state beyond these consts
(`src/background/index.ts:13`).

Construction order and wiring (`src/background/index.ts:15`–`45`):

| Singleton | Constructed at | Dependencies injected |
|---|---|---|
| `sessionStore` (`SessionStore`) | `index.ts:15` | none |
| `tabContexts` (`TabContextStore`) | `index.ts:16` | none |
| `storageCoordinator` (`StorageCoordinator`) | `index.ts:17` | none |
| `fanslyClient` (`FanslyClient`) | `index.ts:18` | `sessionStore` |
| `spendersService` (`SpendersService`) | `index.ts:19` | `fanslyClient`, an inline hub adapter (two closures over `agencyHubClient`), and a settings getter closure over `storageCoordinator` |
| `agencyHubClient` (`AgencyHubClient`) | `index.ts:29` | none |
| `kernelGateway` (`createKernelFeatureGateway()`) | `index.ts:30` | factory-built |
| `acceptanceReporter` (`createAcceptanceReporter(...)`) | `index.ts:33` | `browser.storage.local` + a settings getter closure over `storageCoordinator` |
| `coordinator` (`OperationCoordinator`) | `index.ts:37` | `sessionStore`, `tabContexts`, `fanslyClient`, `kernelGateway`, `storageCoordinator`, `agencyHubClient`, `acceptanceReporter` |

Note an ordering detail: `spendersService` (`index.ts:19`) references
`agencyHubClient` inside two arrow-function callbacks (`index.ts:22`–`25`) that
are defined before `agencyHubClient` is declared (`index.ts:29`). The callbacks
capture the binding lexically and are only invoked later (when a spenders
request runs), so no temporal-dead-zone error occurs at construction time.

`acceptanceReporter` is described in comments (`index.ts:31`) as a drop-oldest
spool in `storage.local` — a recoverable signal, not custody-grade audit — and
is passed to the coordinator as the acceptance sink.

`OperationCoordinator`, `StorageCoordinator`, `SpendersService`,
`AgencyHubClient`, and `FanslyClient` are documented elsewhere; this file treats
them as boundaries. The coordinator surface this root touches is
`registerPort` / `handleCapture` / `handleTabRemoved` / `refreshAllTabs`
(`src/background/operations.ts:431`, `:479`, `:485`, `:469`).

## Global listeners

All installed from the composition root at module load
(`src/background/index.ts`):

| Listener | Registered at | Effect |
|---|---|---|
| `browser.runtime.onConnect` | `index.ts:47` | `coordinator.registerPort(port)` — binds a content-script Port to its tab |
| `webRequest.onBeforeSendHeaders` | via `initializeSessionCapture(...)` `index.ts:51` | Fansly credential sniff (see boundary section); the capture callback runs `storageCoordinator.registerKnownAccount(accountId)` then `coordinator.handleCapture(tabId, accountId)` (`index.ts:51`–`54`) |
| `browser.runtime.onMessage` | via `registerRuntimeApi({...})` `index.ts:56` | request/response API surface (see next section) |
| `browser.tabs.onRemoved` | `index.ts:65` | `void coordinator.handleTabRemoved(tabId)` — cancels ops, forgets the session/tab-context/port |
| `browser.storage.onChanged` | `index.ts:78` | cache-coherency patch + conditional UI fan-out (see storage-change section) |

After registering listeners, the root fires `void storageCoordinator.init()`
(`index.ts:87`) to warm the in-memory `PersistedState` cache.

`registerRuntimeApi` receives an explicit `RuntimeApiDeps` bag —
`agencyHubClient`, `fanslyClient`, `sessionStore`, `spendersService`,
`tabContexts`, `storageCoordinator` (`src/background/runtime-api.ts:30`,
`:39`) — note `kernelGateway` and `acceptanceReporter` are NOT passed to the
runtime API; those flow only into the coordinator.

## The `runtime.onMessage` API surface

A single `browser.runtime.onMessage` listener is installed
(`src/background/runtime-api.ts:47`). It is `async`, so its return value is
always delivered to the sender as the resolved response. The first step calls
`getRuntimeRequestType(message)` (`runtime-api.ts:49`); if that yields no type,
the listener returns `undefined` immediately (`runtime-api.ts:50`–`52`) — every
unrecognized or malformed envelope resolves to `undefined` for the sender.

`getRuntimeRequestType` (`src/shared/protocol.ts:159`) is the runtime guard. Its
switch recognizes exactly four `type` values: `getPopupStatus`,
`getSessionsSnapshot`, `testAgencyHubConnection`, `getSpendersList`
(`protocol.ts:164`–`177`). `getPopupStatus` is rejected (returns `null`) unless
`tabId` is absent or a number; `getSpendersList` is rejected unless `refresh` is
absent or a boolean.

| `type` (command) | Handler at | Request payload (beyond `type`) | Response shape | Delegates to |
|---|---|---|---|---|
| `getPopupStatus` | `runtime-api.ts:54`–`138` | `tabId?: number` | `PopupStatus` (`src/shared/types.ts:681`) | `browser.tabs.get`/`query`, `storageCoordinator.getState`, `sessionStore`, `tabContexts` |
| `getSessionsSnapshot` | `runtime-api.ts:140`–`192` | none | `SessionSnapshotEntry[]` (`types.ts:685`) | `fanslyClient.getAuthenticatedAccount`, `sessionStore.snapshot`, `storageCoordinator.rekeyAccountIdentity` + `reconcileKnownAccounts` |
| `testAgencyHubConnection` | `runtime-api.ts:194`–`216` | `settings: {agencyHubBaseUrl, agencyHubApiKey, agencyHubDeviceToken}` | `AgencyHubConnectionTestResponse` (`{ok, error?}`) | `agencyHubClient.testConnection(settings, signal)` |
| `getSpendersList` | `runtime-api.ts:255`–`280` | `refresh?: boolean` | `SpendersListResponse` (`{ok:true, result}` \| `{ok:false, error}`) | `spendersService.getList(session, signal, {refresh})` |

### `getPopupStatus` details (`runtime-api.ts:54`)
Resolves the target tab either from an explicit `message.tabId` via
`browser.tabs.get` (`runtime-api.ts:61`–`64`) or, when absent, from the active
tab via `browser.tabs.query({active, currentWindow})` (`runtime-api.ts:65`–`72`).
When no tab id can be resolved it returns a fixed `tabId: -1` "Not connected"
`PopupStatus` (`runtime-api.ts:74`–`89`). Otherwise it composes account id
(preferring `session.resolvedAccountId`, else legacy), display group id
(preferring `tabContexts` tracked `groupId`, else `parseGroupIdFromUrl(tabUrl)`;
comment at `runtime-api.ts:96`), mapped personality, and readiness. `hasApiKey`
is computed as: normalized hub base URL present AND (device token or legacy API
key non-empty) (`runtime-api.ts:125`–`128`) — i.e. "kernel lane configured"
rather than any vendor key. `accountLabel` falls back to
`'Unmapped account'` / `'Not connected'` (`runtime-api.ts:134`).

### `getSessionsSnapshot` details (`runtime-api.ts:140`)
Selects connected sessions lacking a resolved id or resolved name
(`runtime-api.ts:141`–`149`), enriches each via
`fanslyClient.getAuthenticatedAccount` under a per-session `AbortController` with
`SESSION_IDENTITY_TIMEOUT_MS = 5_000` (`runtime-api.ts:28`, `:151`–`169`), using
`Promise.allSettled` so failures are swallowed. It then snapshots the store
(`runtime-api.ts:171`), rekeys storage identity for every session whose
`resolvedAccountId` differs from its legacy id
(`storageCoordinator.rekeyAccountIdentity`, `runtime-api.ts:173`–`183`), and
reconciles `knownAccounts` against the resolved-or-legacy id set
(`runtime-api.ts:185`–`189`). The test at `tests/runtime-api.test.ts:138`
confirms the rekey/prune behavior; `tests/runtime-api.test.ts:184` confirms
mapped-but-offline accounts are retained.

### `testAgencyHubConnection` details (`runtime-api.ts:194`)
Validates `message.settings` via `isAgencyHubConnectionTestSettings`
(`protocol.ts:180`; requires string `agencyHubBaseUrl` and string
`agencyHubApiKey`). On invalid input returns
`{ok:false, error: createUserError('hub_request_failed')}`
(`runtime-api.ts:200`–`205`). Otherwise calls
`agencyHubClient.testConnection(settings, signal)` under an `AbortController`
timed out at `AGENCY_HUB_PREFETCH_TIMEOUT_MS` (`runtime-api.ts:206`–`215`).

### `getSpendersList` details (`runtime-api.ts:255`)
Uses `sender.tab?.id` to find the session (`runtime-api.ts:256`–`257`) — this
command is sent from the content script, not the popup. Requires a connected
session or returns `{ok:false, error: createUserError('not_connected')}`
(`runtime-api.ts:258`–`260`). Builds via `spendersService.getList` under an
`AbortController` timed out at `SPENDERS_BUILD_TIMEOUT_MS`
(`runtime-api.ts:263`–`279`); an `AbortError` maps to `createUserError('timed_out')`
(`runtime-api.ts:272`–`275`). Confirmed by `tests/runtime-api.test.ts:405`
(builds for sender tab) and `:445` (not_connected).

### `issueAgencyHubDeviceToken` — handler present but unreachable via this listener
A full handler for `issueAgencyHubDeviceToken` exists at
`runtime-api.ts:218`–`253` (validates `{baseUrl, username, password}`,
normalizes the base URL, calls `issueAgencyHubDeviceToken(...)`, and on success
persists `{agencyHubBaseUrl, agencyHubDeviceToken}` via `saveSettings` while
returning only `{ok, keyPrefix, label, expiresAt}` — the token itself never
crosses back over the runtime-message boundary, comment at `runtime-api.ts:236`).
`issueAgencyHubDeviceToken` and its request/response are declared in
`RuntimeRequestMap`/`RuntimeResponseMap` (`src/shared/types.ts:700`, `:708`),
so `RuntimeRequestType` (`= keyof RuntimeRequestMap`, `protocol.ts:14`) includes
it and the `requestType === 'issueAgencyHubDeviceToken'` comparison at
`runtime-api.ts:218` type-checks.

Actual runtime behavior: `getRuntimeRequestType`'s switch has NO case for
`issueAgencyHubDeviceToken` (`protocol.ts:164`–`177`), so a message of that type
yields `null`, and the listener returns `undefined` at `runtime-api.ts:50`–`52`
before reaching the handler. `getRuntimeRequestType` is the only registered
`browser.runtime.onMessage` guard (grep confirms a single
`browser.runtime.onMessage.addListener`, `runtime-api.ts:47`). The options page
does send this request (`src/options/index.ts:560`
`sendRuntimeRequest('issueAgencyHubDeviceToken', …)`) and reads `response.ok`
(`src/options/index.ts:565`); because the background resolves the message to
`undefined`, the handler block at `runtime-api.ts:218`–`253` is dead as wired.

### The typed sender helper
`sendRuntimeRequest<K>(type, payload?)` (`protocol.ts:270`–`288`) is the typed
client wrapper: it builds `{type, ...payload}` and calls
`browser.runtime.sendMessage`, casting the reply to `RuntimeResponseMap[K]`.
Callers observed: popup `getPopupStatus` (`src/popup/index.ts:62`), options
`getSessionsSnapshot`/`testAgencyHubConnection`/`issueAgencyHubDeviceToken`
(`src/options/index.ts:58`, `:292`, `:560`), content `getSpendersList`
(`src/content/index.ts:314`).

## The Port protocol (content ⇄ background)

The Port is opened by the content script via `browser.runtime.connect` and
accepted at `browser.runtime.onConnect` → `coordinator.registerPort`
(`src/background/index.ts:47`, `src/background/operations.ts:431`). The
coordinator keys the port by `port.sender?.tab?.id` and drops the mapping (plus
cancels the tab's operations) on `port.onDisconnect`
(`operations.ts:432`–`448`). Messages in both directions are validated by type
guards in `src/shared/protocol.ts` before dispatch.

- Background boundary (content → background): every inbound port message is
  gated by `isContentPortMessage` (`protocol.ts:188`) inside the port listener
  (`operations.ts:438`–`442`); invalid messages are dropped silently.
- Content boundary (background → content): every inbound port message is gated
  by `isBackgroundPortMessage` (`protocol.ts:215`) in the content `PortClient`
  listener (`src/content/port-client.ts:24`); `tests/port-client.test.ts:14`
  confirms only valid `BackgroundPortMessage`s are dispatched.

The discriminated-union declarations live in `src/shared/types.ts`:
`ContentPortMessage` (`types.ts:870`) and `BackgroundPortMessage`
(`types.ts:1012`); the full `type` enum is `PortEnvelopeBase` (`types.ts:793`).

### Content → Background messages (`isContentPortMessage`, `protocol.ts:188`)

| `type` | Payload fields | Guard check |
|---|---|---|
| `tab:init` | `groupId: string\|null`, `routeNonce: number` | `isTabRouteMessage` (`protocol.ts:135`) |
| `tab:routeChanged` | `groupId: string\|null`, `routeNonce: number` | `isTabRouteMessage` |
| `operation:start` | `operationId`, `feature: FeatureType`, `groupId`, `routeNonce`, `domFanDisplayName: string\|null`, `draftText?`, `forceRegenerate?`, `replyMode?`, `replyTone?` | `isOperationStartMessage` (`protocol.ts:139`) |
| `compare:start` | `operationId`, `groupId`, `routeNonce`, `domFanDisplayName: string\|null`, `forceRegenerate?`, `replyMode?`, `replyTone?` | `isCompareStartMessage` (`protocol.ts:150`) |
| `operation:acceptance` | `operationId`, `action: 'copied'\|'inserted'`, `partIndex: number` | inline (`protocol.ts:201`–`206`) |
| `operation:cancel` | `operationId` | `hasOperationId` (`protocol.ts:110`) |
| `compare:cancel` | `operationId` | `hasOperationId` |

Dispatch of these lives in `OperationCoordinator.handlePortMessage`
(`operations.ts:493`–`543`): `tab:init` sets route+account and refreshes
`tab:state`; `tab:routeChanged` → `handleRouteChanged`; `operation:start` →
`startOperation`; `compare:start` → `startCompare`; `operation:acceptance`
enqueues into the acceptance reporter using a remembered per-`operationId`
context; `operation:cancel`/`compare:cancel` cancel only if the active
`operationId` matches.

### Background → Content messages (`isBackgroundPortMessage`, `protocol.ts:215`)

| `type` | Payload fields (beyond `type`) | Guard check |
|---|---|---|
| `operation:chunk` | `operationId`, `text: string` | `protocol.ts:221`–`222` |
| `compare:chunk` | `operationId`, `cardId`, `text: string` | `protocol.ts:223`–`224` |
| `operation:debugPrompt` | `operationId`, `feature: FeatureType`, `snapshot: object` | `protocol.ts:225`–`228` |
| `operation:complete` | `operationId`, `result: object`, `fanDisplayName: string`, `llmSpend?`, `profiling?` | `protocol.ts:229`–`232` |
| `operation:error` | `operationId`, `error: object`, `llmSpend?`, `profiling?` | `protocol.ts:233`–`235` |
| `operation:discarded` | `operationId`, `error: object`, … | `protocol.ts:233`–`235` (shared case) |
| `compare:ready` | `operationId`, `fanDisplayName: string`, `cards: array` | `protocol.ts:236`–`239` |
| `compare:cardComplete` | `operationId`, `cardId`, `result: object`, `fanDisplayName: string` | `protocol.ts:240`–`244` |
| `compare:cardError` | `operationId`, `cardId`, `error: object` | `protocol.ts:245`–`246` |
| `compare:error` | `operationId`, `error: object` | `protocol.ts:247`–`249` |
| `compare:discarded` | `operationId`, `error: object` | `protocol.ts:247`–`249` (shared case) |
| `compare:complete` | `operationId`, `fanDisplayName: string` | `protocol.ts:250`–`251` |
| `tab:state` | `state: TabUiState` | `protocol.ts:252`–`255` |
| `settings:changed` | `state: TabUiState` | `protocol.ts:252`–`255` (shared case) |
| `mapping:changed` | `state: TabUiState` | `protocol.ts:252`–`255` (shared case) |
| `summary:syncStatus` | `groupId: string`, `generatedAt: number`, `syncStatus: object` | `protocol.ts:256`–`259` |
| `operation:progress` | `OperationProgressPayload` fields + `feature: FeatureType` (`operationId`, `phase`, `currentPage?`, `targetPages?`, `message?`, `profiling?`, …) | `hasOperationProgressShape` + `isFeatureType` (`protocol.ts:260`–`261`) |
| `compare:progress` | progress fields + `fanDisplayName?` | `hasOperationProgressShape` (`protocol.ts:262`–`264`) |

Outbound sends flow through `OperationCoordinator.send` /
`postMessage` on the tab's port (`operations.ts:781`); `tab:state`,
`settings:changed`, and `mapping:changed` all carry a freshly built `TabUiState`
via `refreshTabState` (`operations.ts:451`). The enum-level `type` list that
covers both directions is `PortEnvelopeBase` (`types.ts:793`).

`hasOperationProgressShape` (`protocol.ts:118`) requires `operationId`,
`isOperationPhase(phase)`, optional numeric `currentPage`/`targetPages`, optional
string `message`, and an object `profiling`. Phase, feature, reply-mode, and
reply-tone are validated against fixed `Set`s built from `FEATURE_POLICIES`
keys and literal unions (`protocol.ts:33`–`52`).

## Fansly session capture boundary

The only place platform credentials enter the background is the
`webRequest.onBeforeSendHeaders` sniff in
`src/background/session-capture.ts:86`–`103`. This is an inbound, passive
boundary: the listener is registered with filter `{ urls:
['https://apiv3.fansly.com/*'] }` and `extraInfoSpec ['requestHeaders']`
(`session-capture.ts:101`–`102`) — no `'blocking'`, so it observes outgoing
Fansly request headers without modifying or blocking them (it returns nothing).

Flow per request:
1. Requests with `details.tabId < 0` (non-tab, e.g. the extension's own
   background fetches) are ignored (`session-capture.ts:89`).
2. `extractCapture(details.requestHeaders, details.url)`
   (`session-capture.ts:40`) lowercases header names into a `Map`
   (`session-capture.ts:48`–`54`) and reads four mandatory headers:
   `authorization`, `fansly-client-id`, `fansly-client-ts`, `fansly-session-id`
   (`session-capture.ts:56`–`59`). If any is missing, capture aborts (returns
   `null`, `session-capture.ts:62`–`64`). A fifth header, `fansly-client-check`,
   is optional and stored as `null` when absent (`session-capture.ts:77`).
3. The account id is decoded from the `authorization` header by
   `decodeLegacyAccountKey` (`session-capture.ts:5`–`13`): `atob(authorization)`,
   split on `':'`, first field trimmed. A decode failure or empty id aborts the
   capture (`session-capture.ts:66`–`69`). This is the "legacy account key" —
   later reconciled to a resolved Fansly account id elsewhere.
4. `normalizeRouteKey(url)` (`session-capture.ts:15`–`38`) classifies the URL
   into a `RouteKey` by substring match, in this precedence:
   `/api/v1/account/wallets/earnings/` → `earnings`; `/api/v1/subscribers` →
   `subscribers`; `/api/v1/media/orderhistory` → `media`;
   `/api/v1/messaging/groups` → `messagingGroups`; `/api/v1/group/` → `group`;
   `/api/v1/message` → `message`; `/api/v1/account?` → `account`; else `null`.
   Confirmed by `tests/session-capture.test.ts:4`.
5. On success: `sessionStore.registerCapture(details.tabId, capture)` then
   fire-and-forget `void onCapture(details.tabId, capture.accountId)`
   (`session-capture.ts:98`–`99`). The `onCapture` supplied by the root
   registers the known account and calls `coordinator.handleCapture`
   (`src/background/index.ts:51`–`54`).

`SessionCaptureResult` (the shape crossing into the store) is
`{accountId, authorization, fanslyClientId, fanslySessionId, fanslyClientTs,
fanslyClientCheck: string|null, routeKey: RouteKey|null}`
(`src/background/session-store.ts:3`–`11`).

### `SessionStore` custody (`src/background/session-store.ts`)
Two in-memory `Map`s hold all state — nothing here is written to
`storage.local`: `sessionsByAccount: Map<accountId, SessionTemplate>` and
`accountByTabId: Map<tabId, accountId>` (`session-store.ts:14`–`15`).
`SessionTemplate` (`src/shared/types.ts:112`) carries `accountId`,
`resolvedAccountId`, `resolvedUsername`, `resolvedDisplayName`, `authorization`,
`fanslyClientId`, `fanslySessionId`, `latestTs`, `latestCheck`, `routeChecks:
Partial<Record<RouteKey,string>>`, `lastSeenAt`, `connected`.

Behavioral notes:
- `registerCapture` (`session-store.ts:17`): if the tab was previously mapped to
  a different account, it drops the old tab mapping and prunes the orphaned
  session (`session-store.ts:18`–`22`). On re-capture of the same account it
  reuses the existing `SessionTemplate` object identity and refreshes
  credentials in place (`session-store.ts:28`–`53`), so an in-flight request
  holding the reference observes the re-login rather than a stale copy
  (comment `session-store.ts:24`; `tests/session-store.test.ts:17`). Per-route
  `routeChecks[routeKey]` is recorded only when both `routeKey` and
  `fanslyClientCheck` are present (`session-store.ts:55`–`57`).
- `markDisconnected` (`session-store.ts:101`) mutates `connected = false` in
  place; `forgetTab` (`session-store.ts:112`) removes the tab mapping and prunes
  the session if no other tab references it.
- Lookups: `getSessionByAccount` matches a direct key, then falls back to a scan
  by `resolvedAccountId` (`session-store.ts:64`–`81`); `getSessionForTab`,
  `getAccountIdForTab`, and `getDisplayAccountIdForTab` (the last prefers
  `resolvedAccountId`) at `session-store.ts:83`–`99`.
- `snapshot` (`session-store.ts:121`) returns entries only for accounts still
  backed by an active tab, as `SessionSnapshotEntry`
  (`legacyAccountId`, `resolvedAccountId`, `username`, `displayName`,
  `connected`, `lastSeenAt`; `types.ts:685`). `tests/session-store.test.ts:72`
  confirms only active-tab-backed sessions appear.

Lifetime: captured credentials live only in these Maps for the life of the
background event page; only the derived account id is ever persisted (to the
`knownAccounts` list via `storageCoordinator.registerKnownAccount`, called from
the capture callback). Device tokens issued through the hub are the one
credential written to storage, and they land in the settings record directly
rather than through the runtime-message reply (`runtime-api.ts:236`–`238`,
`src/background/device-token.ts`).

### `TabContextStore` (`src/background/tab-context.ts`)
A single `Map<tabId, TabContext>` (`tab-context.ts:4`) holding per-tab
conversation context. `TabContext` (`types.ts:135`): `tabId`, `accountId`,
`groupId`, `fanAccountId`, `fanDisplayName`, `activeOperationId`, `routeNonce`.
`getOrCreate` seeds all fields null / `routeNonce: 0` (`tab-context.ts:6`–`24`).
`setRoute` clears `fanAccountId`/`fanDisplayName` whenever `groupId` becomes null
(`tab-context.ts:32`–`41`). `setAccount`, `setFan`, `setActiveOperation`, `get`,
and `remove` round out the surface (`tab-context.ts:26`–`62`). The coordinator
owns the write cadence (route changes, account rekey, active-operation
tracking).

## Storage-change fan-out

The `browser.storage.onChanged` listener (`src/background/index.ts:78`–`85`) does
two things on every change event:

1. Unconditionally calls `storageCoordinator.applyStorageChanges(changes,
   areaName)` (`index.ts:79`) to keep the in-memory `PersistedState` cache
   coherent. That method no-ops unless `areaName === 'local'` and the state is
   already loaded, then splits changes into set-items (`newValue !== undefined`)
   and remove-keys and applies a raw patch
   (`src/background/storage-coordinator.ts:77`–`100`).
2. Gates a UI fan-out: only for `areaName === 'local'`, and only when at least
   one changed key is in `UI_RELEVANT_KEYS`, it fires
   `void coordinator.refreshAllTabs('settings:changed')` (`index.ts:80`–`84`).
   `refreshAllTabs` pushes a rebuilt `TabUiState` as a `settings:changed` port
   message to every connected tab (`operations.ts:469`–`477`).

`UI_RELEVANT_KEYS` (`index.ts:69`–`76`): `settings`, `personalities`,
`accountMappings`, `accountAliases`, `knownAccounts`, `schemaVersion`. Keys
outside this set — notably the `summary:*` fan-summary cache entries — do not
trigger a fan-out. `tests/storage-change-filter.test.ts` mirrors this exact
allowlist and confirms: non-`local` areas never refresh
(`storage-change-filter.test.ts:26`), `summary:*` keys are ignored (`:31`), each
allowlisted key triggers a refresh (`:36`–`58`), and a mixed change with any
relevant key triggers (`:60`).

## Boundary summary (what crosses, and which way)

- Fansly `apiv3.fansly.com` → background: passive header observation of outgoing
  Fansly API requests; the four mandatory `authorization` /
  `fansly-client-id` / `fansly-client-ts` / `fansly-session-id` headers (+
  optional `fansly-client-check`) plus the request URL cross in; nothing is
  written back to the request (`session-capture.ts:86`).
- Extension pages (popup / options / content) → background: `runtime.onMessage`
  request/response, four live commands (`getPopupStatus`,
  `getSessionsSnapshot`, `testAgencyHubConnection`, `getSpendersList`); requests
  and responses are plain JSON-serializable objects
  (`runtime-api.ts:47`, `protocol.ts:159`).
- Content script ⇄ background: long-lived `Port`, bidirectional streaming of the
  operation/compare/tab/summary message catalog above, each side guarded
  (`operations.ts:431`, `port-client.ts:24`).
- Background → Agency Hub / kernel: outbound only, via `agencyHubClient`,
  `fanslyClient`, `kernelGateway`, and the one-time device-token login flow
  (`@kernel/sdk` `createClient`, cookie-jar `credentials: 'include'`,
  `login` → `authIssueDeviceToken` → `logout`,
  `src/background/device-token.ts:42`–`85`) — documented in their own maps.
