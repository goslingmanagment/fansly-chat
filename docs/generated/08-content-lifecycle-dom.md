> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# 08 — Content-script lifecycle & the Fansly DOM boundary

Scope: the content script that runs inside `fansly.com` pages — its injection
and bootstrap, how it watches the Fansly SPA route, exactly what it **reads**
from and **writes** back to the Fansly DOM, how it attaches its UI to the live
conversation subtree, its long-lived Port to the background service worker,
scroll compensation, and the pure surface planner that decides which UI surface
is shown. UI surfaces themselves (button bar, overlay, inline panel, spenders
board, toast, cheatsheet, mapping banner) are documented in maps 09/10 and are
only referenced here where the lifecycle wires them.

The content script is the LIVE reader of the Fansly DOM/API for the chatter. It
holds no vendor keys and computes no money; it collects the fan identity, the
draft text, and the route, ships them to the background over the Port, and
paints the results back — inserting the chosen reply into Fansly's composer.

Territory files:
`src/content/index.ts`, `src/content/route-watcher.ts`,
`src/content/conversation-dom.ts`, `src/content/dom-anchor.ts`,
`src/content/conversation-mount-controller.ts`, `src/content/port-client.ts`,
`src/content/scroll-compensation.ts`, `src/content/textarea.ts`,
`src/content/surface-planner.ts`, plus `src/shared/constants.ts`,
`src/shared/protocol.ts`, `src/shared/types.ts`, and `manifest.json`.

---

## 1. Injection & bootstrap

### Manifest injection
`manifest.json:25-35` declares one content script: `content.js`, matched on
`*://fansly.com/*`, injected at `run_at: "document_idle"`. `manifest.json` is
MV3 (`manifest_version: 3`, line 2), version `1.6.0` (line 4). The background is
a classic (non-module) service worker script `background.js`
(`manifest.json:20-24`). `host_permissions` cover `*://fansly.com/*` and
`*://apiv3.fansly.com/*` (`manifest.json:12-15`); broader host access is
requested only as `optional_host_permissions` (lines 16-19). The declared
`data_collection_permissions` include `personalCommunications`,
`financialAndPaymentInfo`, and `websiteContent` (`manifest.json:58-66`),
reflecting that this script reads DM content and fan identity off the page.

### Build entry
The bundled `content.js` is built from `src/content/index.ts`
(`esbuild.config.mjs:12-14`, `content: path.join(root, 'src/content/index.ts')`).

### Bootstrap gate & construction
The module's bottom is a host guard: it only instantiates when
`window.location.hostname.endsWith('fansly.com')`
(`src/content/index.ts:1655-1657`), i.e. `new ChatGooseContentApp().init()` runs
only on Fansly hosts even though the manifest match already constrains injection.

`ChatGooseContentApp.init()` (`src/content/index.ts:349-355`) does, in order:
1. `installContentStyles(contentStyles)` — injects the bundled CSS once
   (`src/content/dom-anchor.ts:1-14`, guarded by element id `chatgoose-style`).
2. `this.port.connect()` — opens the long-lived Port (see §7).
3. `startRouteWatcher((groupId) => this.handleRouteChange(groupId))` — begins
   SPA route polling (see §2).
4. `this.installKeymap()` — a document-level `keydown` listener that resolves
   hotkeys through `createKeymap` and dispatches features/actions
   (`src/content/index.ts:359-403`).
5. `this.launcher.mount()` — mounts the spenders board launcher (map 09/10).

The app's own DOM root is a single `<div id="chatgoose-root">`
(`src/content/index.ts:215`, `320`) into which the inline panel, button bar, and
mapping banner roots are appended at construction
(`src/content/index.ts:321`). That root is handed to the
`ConversationMountController` (`src/content/index.ts:322`), which is what places
it into (and keeps it inside) the Fansly conversation subtree (see §5). The
overlay and toast use their own body-level roots created lazily
(`ensureOverlayRoot` / `ensureToastRoot`, `src/content/dom-anchor.ts:16-34`).

---

## 2. SPA route watching (groupId / routeNonce)

Fansly is a client-routed SPA; there is no page reload between conversations, so
the script polls the URL rather than listening for navigations.

`src/content/route-watcher.ts`:
- `parseGroupIdFromPath(pathname)` runs `/^\/messages\/([^/?#]+)/` against the
  path and returns capture group 1, else `null`
  (`src/content/route-watcher.ts:3-6`). The groupId is therefore the first path
  segment after `/messages/` (a Fansly conversation/group id), stopping at
  `/`, `?`, or `#`.
- `startRouteWatcher(onChange)` seeds `lastGroupId` from the current path,
  calls `onChange` once immediately, then `setInterval`-polls
  `window.location.pathname` every `ROUTE_POLL_INTERVAL_MS`; it only fires
  `onChange` when the parsed groupId differs from the last one
  (`src/content/route-watcher.ts:8-23`). It returns a disposer that clears the
  interval.
- `ROUTE_POLL_INTERVAL_MS = 500` (`src/shared/constants.ts:77`).

The app owns `routeNonce` and `currentGroupId`. On every route change,
`handleRouteChange(groupId)` (`src/content/index.ts:967-1026`):
- increments `this.routeNonce` (monotonic per tab; `src/content/index.ts:970`)
  and sets `currentGroupId` — even a change to `null` (leaving `/messages/...`)
  counts as a route change,
- rebinds the caches and the mount controller to the new group
  (`setActiveGroup` / `setActiveRoute`, `src/content/index.ts:972-974`),
- on an actual group change, tears down any in-flight surface for the *previous*
  fan: inline features hide + `suppressTerminalOperation`, compare suppresses +
  drops its cache, overlay features suppress their terminal so a late result is
  neither shown over the new conversation nor cached under the new group
  (`src/content/index.ts:976-1016`; the suppression set is consumed by the
  terminal handlers before they touch the cache — §7),
- sends the Port `tab:init` on the very first route resolution (guarded by
  `hasSentInit`), and `tab:routeChanged` thereafter, each carrying
  `{ groupId, routeNonce }` (`src/content/index.ts:1018-1023`).

`routeNonce` is stamped into every `operation:start` / `compare:start`
(`src/content/index.ts:684`, `916`) so the background can discard results whose
route has since changed. `scheduleLoadingRender` also captures the nonce and
bails if it changed before the animation frame runs
(`src/content/index.ts:561-568`).

---

## 3. Fansly DOM READ — the identity/draft boundary

`src/content/conversation-dom.ts` is the single reader of Fansly's conversation
DOM. The selectors ARE the coupling to Fansly's Angular component markup:

| Constant | Selector | Purpose | Line |
|---|---|---|---|
| `ROUTE_ROOT_SELECTOR` | `app-messages-conversation-route` | the active conversation route element | `conversation-dom.ts:9` |
| `INPUT_HOST_SELECTOR` | `app-group-message-input` | the composer host element | `conversation-dom.ts:10` |
| `USER_NAME_SELECTOR` | `app-account-username .user-name` | fan @handle / display source | `conversation-dom.ts:11` |
| `COMPOSER_LABEL_SELECTOR` | `app-group-message-input .label` | fallback identity source | `conversation-dom.ts:12` |
| `TEXTAREA_SELECTORS` | `app-group-message-input textarea`, `textarea.message-input`, `textarea[placeholder*="message"]` | draft composer textareas (tried in order) | `conversation-dom.ts:13-17` |

### Fan identity
`resolveDisplayName(routeRoot)` (`src/content/conversation-dom.ts:37-57`):
1. Queries `app-account-username .user-name`. If found, it reads only that
   element's **direct** text nodes via `getDirectTextContent`
   (`conversation-dom.ts:29-35`, filters `Node.TEXT_NODE`) — so nested
   badge/child elements do not pollute the name — and passes it to
   `parseDisplayName`.
2. If that yields nothing, it falls back to `app-group-message-input .label`
   `textContent` and parses that.
3. Returns `null` if neither is present.

`parseDisplayName(text)` (`src/content/conversation-dom.ts:24-27`) extracts the
handle with `/@([^\s]+)/` — the first `@`-prefixed non-whitespace token — and,
failing a match, falls back to `text` with a leading `Message ` prefix stripped
(case-insensitive), trimmed, or `null`. So the identity captured is the fan's
Fansly **@handle** when present (e.g. `@alice` → `alice`).

Public read entry points:
- `getActiveConversationDisplayName()` (`conversation-dom.ts:93-100`) — resolves
  the route root and returns the display name; used at `operation:start` /
  `compare:start` to stamp `domFanDisplayName` (`src/content/index.ts:824`,
  `895`).
- `getActiveConversationDom()` (`conversation-dom.ts:68-91`) — resolves the full
  `ActiveConversationDom` record: `routeRoot`, `container`
  (`inputHost.closest('app-group-message-container')`), `inputHost`,
  `inputParent` (`inputHost.parentElement`), and `displayName`. Returns `null`
  unless the route root, an `app-group-message-input` with a parent, and an
  enclosing `app-group-message-container` all exist.

### Draft text
- `findActiveConversationTextarea()` (`conversation-dom.ts:102-116`) resolves the
  conversation DOM, then queries each `TEXTAREA_SELECTORS` entry in order within
  `container`, returning the first `isUsableTextarea` match.
- `isUsableTextarea` (`conversation-dom.ts:59-66`) requires an
  `HTMLTextAreaElement` that is not `disabled`, not `readOnly`, and has
  `offsetParent !== null` (i.e. rendered/visible).
- `getActiveConversationDraftText()` (`src/content/textarea.ts:24-26`) returns
  the textarea's `.value` or `''`. `computeHasDraftText()`
  (`src/content/index.ts:1463-1465`) trims it to decide whether draft-requiring
  features (e.g. `improve-draft`/"Fix") may run. The draft is read at feature
  start and `.trim()`-ed into the `operation:start` payload
  (`src/content/index.ts:801-803`, sent at `832-840`).

### Draft-change observation
The app watches the live composer so the button bar reflects "has draft" state:
`syncDraftTextareaObserver()` (`src/content/index.ts:1506-1515`) re-resolves the
active textarea each render, and when it differs from the observed one, detaches
old `input`/`change` listeners and attaches `handleDraftInput`
(`src/content/index.ts:170-177`) to the new one.
`detachDraftTextareaObserver()` (`src/content/index.ts:1497-1504`) removes them;
it is also called on Port disconnect (`src/content/index.ts:192`).

---

## 4. Fansly DOM WRITE — composer insertion

The only write into Fansly's DOM is inserting the generated reply into the
composer textarea. `insertIntoFanslyTextarea(text)`
(`src/content/textarea.ts:28-49`):
1. Resolves the active textarea; throws `ChatGooseError('insertion_failed')` if
   none (`textarea.ts:29-32`).
2. `textarea.focus()` then `textarea.select()` (`textarea.ts:34-35`).
3. Primary path: `document.execCommand('insertText', false, text)`. If it
   reports success **and** `textarea.value === text`, it returns — this path
   goes through the browser's editing pipeline so Fansly's Angular bindings see
   a native user edit (`textarea.ts:37-40`).
4. Fallback: set `textarea.value = text` directly, then dispatch bubbling
   `input` and `change` events so the framework picks up the change
   (`textarea.ts:42-44`).
5. Re-verifies `textarea.value === text`; throws `insertion_failed` if the write
   did not stick (`textarea.ts:46-48`).

Insertion is invoked from `applyImproveDraftResult`
(`src/content/index.ts:1472-1495`) — for draft-requiring features the completed
reply is written straight into the composer (first part's text), and on failure
the result is surfaced in the inline panel plus an error toast instead. Non-draft
reply parts are inserted from the surfaces (map 09/10) via the same function.

`focusActiveConversationTextarea()` (`src/content/textarea.ts:8-22`) focuses and
moves the caret to the end (best-effort `setSelectionRange`).
`copyToClipboard` (`textarea.ts:4-6`) wraps `navigator.clipboard.writeText`.

---

## 5. Mount / attach lifecycle & re-attach

`ConversationMountController` (`src/content/conversation-mount-controller.ts`)
keeps the `#chatgoose-root` div placed **immediately before** the Fansly
composer, and survives Angular re-rendering the conversation subtree.

### Placement
`attach(conversation, sessionId)` (`conversation-mount-controller.ts:70-81`)
inserts `root` into `conversation.inputParent` right before
`conversation.inputHost` via `insertBefore` — but only if it is not already in
that exact position (`lines 71-73`). It records the mounted anchors
(`mountedInputHost`, `mountedRouteRoot`, and an `mountedObservationRoot` =
`routeRoot.parentElement` when it is an element, else the route root itself),
clears any retry, and starts a MutationObserver.

### Route binding
`setActiveRoute(groupId)` (`conversation-mount-controller.ts:26-43`) is called
from `handleRouteChange` (`src/content/index.ts:974`). It bumps `sessionId`
(invalidating any in-flight retry/observer callbacks that captured the old id),
resets mount state, and detaches the root. If `groupId` is `null` it stays
detached. Otherwise it tries `syncNow()` immediately; if the conversation DOM
isn't present yet, it sets a deadline `now + CONVERSATION_ATTACH_TIMEOUT_MS` and
schedules a retry.

`syncNow()` (`conversation-mount-controller.ts:45-57`) resolves the conversation
DOM (default resolver `getActiveConversationDom`) and attaches if present.

### Retry cadence (two-phase)
`scheduleRetry(sessionId)` (`conversation-mount-controller.ts:118-145`): inside
the attach window it re-checks every `CONVERSATION_ATTACH_RETRY_MS = 50`ms; once
the deadline lapses it falls back to `CONVERSATION_ATTACH_SLOW_RETRY_MS =
2_000`ms and keeps polling indefinitely (it never gives up while the route is
active), so a subtree rebuilt long after navigation is still re-discovered
(`src/shared/constants.ts:79-84`; behavior pinned by
`tests/conversation-mount-controller.test.ts` "keeps retrying past the attach
deadline"). `CONVERSATION_ATTACH_TIMEOUT_MS = 10_000` (`constants.ts:79`).

### Re-attach on DOM churn
`startObserver(sessionId)` (`conversation-mount-controller.ts:147-177`) observes
`mountedObservationRoot` with `{ childList: true, subtree: true }`, coalescing
bursts through a `setTimeout(…, 0)` (a `pending` flag) into a single
`handleObservedChange`. `handleObservedChange`
(`conversation-mount-controller.ts:83-104`) ignores stale sessions, and if
`isAnchorValid()` is false it stops observing, clears the mounted anchors,
detaches, and re-runs `syncNow()`/retry to re-place the root.

`isAnchorValid()` (`conversation-mount-controller.ts:106-116`) requires: an
active group; the root and all three mounted anchors still `isConnected`; the
root's parent still equals the input host's parent; and the root is still the
input host's immediate previous sibling (`root.nextSibling === inputHost`). Any
drift triggers a re-attach.

`detach()`/`destroy()` (`lines 59-68`) null the group, bump the session, reset
state, and remove the root. `detachRoot()` is `this.root.remove()` (`line 200`).

---

## 6. DOM anchors & injected roots

`src/content/dom-anchor.ts` owns the singleton DOM anchors:
- `installContentStyles` → `ensureStyles` appends one `<style id="chatgoose-style">`
  to `document.head`, idempotent by id (`dom-anchor.ts:1-14`).
- `ensureOverlayRoot()` lazily creates `<div id="chatgoose-overlay-root">` on
  `document.body` (`dom-anchor.ts:16-24`).
- `ensureToastRoot()` lazily creates `<div id="chatgoose-toast-root">` on
  `document.body` (`dom-anchor.ts:26-34`).

The overlay/toast roots live at body level (not inside the mounted conversation
root), so they are independent of conversation re-mounts. `OVERLAY_Z_INDEX =
2147483646` (`src/shared/constants.ts:107`).

---

## 7. Port client (long-lived Port to background)

`PortClient` (`src/content/port-client.ts`) is the internal boundary between the
content script and the background service worker. It is a single
`browser.runtime.Port`, not per-request messaging (that path is
`sendRuntimeRequest`, §8).

### Connect / dispatch
`connect()` (`port-client.ts:18-39`) opens `browser.runtime.connect({ name:
'chatgoose-content' })`, wires `onMessage` through the `isBackgroundPortMessage`
type guard before forwarding to `callbacks.onMessage` (invalid shapes are
dropped — pinned by `tests/port-client.test.ts`), and registers `onDisconnect`.
On (re)connect it resets `reconnectAttempt` and, if a `lastInit` exists,
replays it (`port-client.ts:35-38`).

### Reconnect
On disconnect (`port-client.ts:29-33`) the port is nulled, `onDisconnected` is
invoked (the app then shows an "extension reloaded" toast, clears caches, resets
operation state, and detaches the draft observer — `src/content/index.ts:182-197`),
and `scheduleReconnect` runs. `scheduleReconnect` (`port-client.ts:41-53`) backs
off through `PORT_RECONNECT_DELAYS_MS = [100, 200, 400]` (clamped to the last
entry) (`src/shared/constants.ts:85`), then calls `connect()` again.

### Send semantics & replay
`send(message)` (`port-client.ts:62-77`) returns a boolean:
- `tab:init` is stored in `lastInit`; `tab:routeChanged` mutates the stored
  `lastInit`'s `groupId`/`routeNonce` (`port-client.ts:63-71`) — so on reconnect
  the background is re-primed with the current route.
- If the port is `null` (mid-reconnect) it returns `false` and the message is
  dropped. Only `tab:init`/`tab:routeChanged` survive via replay; other messages
  (`operation:start`, `compare:start`, cancels) are lost, and callers must
  handle the `false` return. The app does: a dropped `operation:start` /
  `compare:start` tears down the pending loading surface and shows a retry toast
  (`src/content/index.ts:841-850`, `923-932`).

### Content → Background messages (the write side of the Port)
Defined as `ContentPortMessage` (`src/shared/types.ts:870-877`), validated by
`isContentPortMessage` (`src/shared/protocol.ts:188-213`):
- `tab:init`, `tab:routeChanged` — `{ groupId: string | null, routeNonce }`
  (`types.ts:824-834`).
- `operation:start` — `{ operationId, feature, groupId, routeNonce,
  domFanDisplayName, draftText?, forceRegenerate?, replyMode?, replyTone? }`
  (`types.ts:836-847`); built by `buildOperationStartPayload`
  (`src/content/index.ts:672-695`).
- `compare:start` — like above without `feature`/`draftText`
  (`types.ts:849-858`).
- `operation:cancel`, `compare:cancel` — `{ operationId }`.
- `operation:acceptance` — `{ operationId, action: 'copied' | 'inserted',
  partIndex }` (`types.ts:881-886`); emitted when the chatter copies/inserts a
  suggestion (Stage 32 acceptance capture).

### Background → Content messages (the read side)
`BackgroundPortMessage` (`src/shared/types.ts:1012+`), validated by
`isBackgroundPortMessage` (`src/shared/protocol.ts:215-268`) and dispatched in
`handlePortMessage` (`src/content/index.ts:1030-1083`):
- `tab:state` / `settings:changed` / `mapping:changed` → refresh `tabState`,
  re-render button bar + mapping banner (`index.ts:1032-1038`).
- `operation:progress`, `operation:debugPrompt`, `operation:chunk`,
  `operation:complete`, `operation:error`, `operation:discarded` — the
  single-generation lifecycle (`index.ts:1067-1079`).
- `compare:ready`/`progress`/`chunk`/`cardComplete`/`cardError`/`complete`/
  `error`/`discarded` — the multi-card compare lifecycle
  (`index.ts:1045-1066`).
- `summary:syncStatus` — Hub sync status for a fan summary (`index.ts:1039-1040`).

Every handler gates on `activeOperationId`/`activeCompareModel.operationId`
matching, and the terminal handlers first consult
`consumeSuppressedTerminalOperation` so results for a route the user already
left are swallowed (`src/content/index.ts:1348-1355`, `1399-1405`,
`1249-1257`). `crypto.randomUUID()` mints each `operationId`
(`src/content/index.ts:823`, `894`).

---

## 8. Runtime request channel (not the Port)

Separate from the Port, `sendRuntimeRequest(type, payload?)`
(`src/shared/protocol.ts:270-288`) is a typed one-shot `browser.runtime.sendMessage`
request/response. The content script uses it for the spenders board data
(`getSpendersList`, `src/content/index.ts:312-316`). Request types are validated
by `getRuntimeRequestType` (`protocol.ts:159-178`): `getPopupStatus`,
`getSessionsSnapshot`, `testAgencyHubConnection`, `getSpendersList`.

---

## 9. Scroll compensation

Because the mounted root sits *above* the composer and can grow (inline panel),
inserting it can push the visible message list. `scroll-compensation.ts` keeps
the conversation pinned near the bottom across a render.

`renderSurfaces()` wraps every surface mutation:
`captureScrollSnapshot(root)` before, `applyScrollCompensation(root, snapshot)`
in a `finally` (`src/content/index.ts:473-496`).

- `captureScrollSnapshot(root)` (`scroll-compensation.ts:185-196`): resolves the
  scroll container, and records `maxScrollBefore` (`scrollHeight - clientHeight`),
  `bottomGapBefore` (distance from bottom), and `rootHeightBefore`
  (`root.offsetHeight`). Returns `null` if root is disconnected or no container.
- `findScrollContainer(seed)` (`scroll-compensation.ts:126-181`) searches, with a
  module-level cache keyed on the seed root (`isCachedContainerValid`,
  `lines 103-112`): (1) a currently-scrollable ancestor; (2) a level-by-level
  sibling walk preferring a currently-scrollable sibling, then a "potential"
  container (overflow-y scrollable + visible but not yet overflowing); (3) a
  potential ancestor; (4) fallback to `document.scrollingElement`
  (intentionally uncached). "Scrollable" means `overflow-y` in
  `auto`/`scroll`/`overlay` (`lines 16-18`).
- `applyScrollCompensation(root, snapshot)` (`scroll-compensation.ts:198-225`):
  no-ops if either element disconnected, or if `bottomGapBefore >
  NEAR_BOTTOM_THRESHOLD_PX` (96px) — i.e. only compensates when the user was
  already near the bottom. It computes `delta = maxScrollAfter -
  maxScrollBefore`; if the container's own metrics didn't change (separate DOM
  branch) it falls back to the root's height delta; if `delta <
  MIN_HEIGHT_DELTA_PX` (1px) it bails; otherwise it bumps `scrollTop` by `delta`
  clamped to `maxScrollAfter`.

---

## 10. Surface planner

`surface-planner.ts` is a **pure** function deciding which of two mounted
surfaces (overlay at body-level, inline panel inside the conversation root) to
render and whether to reset the quick-surface mode. It maps app state → a
`SurfacePlan` with no DOM access.

`planSurfaces(input)` (`src/content/surface-planner.ts:74-115`), in priority
order:
1. An active **overlay** feature (Scan/Summary/Review/Help) with a loading model
   → overlay (`lines 87-89`).
2. An active **inline** feature (Reply/Fix) loading: overlay-mode →
   overlay with `collapse-to-inline`; inline-mode → inline if
   `quickInlineVisible`, else hidden (`lines 91-98`).
3. `comparePanelVisible` with an `activeCompareModel` → inline compare panel
   (`lines 100-102`).
4. `quickInlineVisible` with a cached inline model → overlay (if overlay-mode)
   or inline (`lines 104-108`).
5. `deepOverlayModel` present → overlay (`lines 110-112`).
6. Otherwise hidden, resetting the quick-surface mode iff currently overlay
   (`line 114`).

`applySurfacePlan(plan)` (`src/content/index.ts:519-539`) applies it: hides or
renders the inline panel and renders the overlay (honoring `dismissMode`), and
resets `quickSurfaceMode` to `'inline'` if the plan asks. Feature routing
(inline vs overlay) is driven by `usesInlineFeatureSurface` /
`usesOverlayFeatureSurface` from `src/shared/features.js`
(imported at `surface-planner.ts:1-4`). Behavior pinned by
`tests/surface-planner.test.ts`.

---

## 11. Loading-render batching

Streaming chunks/progress do not re-render synchronously.
`scheduleLoadingRender()` (`src/content/index.ts:557-571`) coalesces into one
`requestAnimationFrame`; the callback captures `activeOperationId`, the compare
operation id, and `routeNonce`, and no-ops if any of them changed before the
frame — so a stale in-flight generation can't paint over a newer state.
`cancelScheduledLoadingRender()` (`lines 573-578`) cancels a pending frame and is
called before feature (re)initialization and at each `renderSurfaces()`.

---

## 12. DOM contract summary (the Fansly coupling)

Everything the content script depends on in Fansly's markup, in one place — these
selectors and shapes are the brittle boundary:

**Reads**
- Route: `window.location.pathname` matching `^/messages/([^/?#]+)` → groupId
  (`route-watcher.ts:4`).
- Route root element: `app-messages-conversation-route`
  (`conversation-dom.ts:9`).
- Composer host: `app-group-message-input`, enclosed by
  `app-group-message-container` (`conversation-dom.ts:10`, `79`).
- Fan identity: `app-account-username .user-name` (direct text), fallback
  `app-group-message-input .label`; handle parsed as `@([^\s]+)`
  (`conversation-dom.ts:11-12`, `24-27`, `37-57`).
- Draft textarea: first usable of `app-group-message-input textarea`,
  `textarea.message-input`, `textarea[placeholder*="message"]`, requiring
  enabled + not-readonly + visible (`conversation-dom.ts:13-17`, `59-66`).

**Writes**
- Reply into the resolved composer textarea via `execCommand('insertText')`
  with a `value` + dispatched `input`/`change` fallback
  (`textarea.ts:28-49`).
- The `#chatgoose-root` UI div inserted as the immediate previous sibling of
  `app-group-message-input` inside its parent
  (`conversation-mount-controller.ts:70-73`, `113-114`).
