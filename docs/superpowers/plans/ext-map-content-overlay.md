I now have a complete implementation map. Here is the raw data organized by your 7 sections.

---

# 1. OverlayController — `src/content/overlay/overlay-controller.ts` (1739 lines)

## Public interface

**Constructor** takes one `OverlayCallbacks` object (lines 46–57):
```ts
interface OverlayCallbacks {
  onClose: () => void;
  onCancel: (operationId: string) => void;
  onRerun: (feature: FeatureType) => void;
  onCollapse: () => void;
  onAcceptance?: (operationId: string, action: 'copied' | 'inserted', partIndex: number) => void;
  onOpenDebugPrompt?: () => void;
}
```
`constructor(private readonly callbacks: OverlayCallbacks)` at line 203. The instance is created in `index.ts` at line 285 (`this.overlay = new OverlayController({...})`).

**`render(model, options?)`** — the only public render entry (line 246):
```ts
render(model: OverlayViewModel, options?: OverlayRenderOptions | boolean): void
```
`OverlayRenderOptions` (lines 41–44): `{ preserveInlineError?: boolean; dismissMode?: OverlayDismissMode }`. A `boolean` positional is treated as `preserveInlineError` (line 247–248). `OverlayDismissMode = 'close' | 'cancel-and-close' | 'collapse-to-inline'` (line 39).

**View-model kinds accepted** — `OverlayViewModel` union, defined in `src/shared/types.ts:1242–1320`: `'hidden'`, `'loading'`, `'reply'`, `'helpMe'`, `'readOnly'`, `'error'`. There is **no chat/coach kind** today. Type helpers in the controller: `VisibleOverlayModel` (excludes hidden, line 66), `StaticOverlayKind` (excludes loading, line 67).

`titleForFeature(feature)` (lines 103–120) has a `switch` over all 7 `FeatureType`s and would need a new arm for any new feature — note it has no `default`, so an added feature is a compile error there.

## Lifecycle (mount / unmount / Esc / backdrop / dismissModes)

- **Root:** `private readonly root = ensureOverlayRoot()` (line 178) — the `#chatgoose-overlay-root` div from `dom-anchor.ts`.
- **Esc handling:** two `document.addEventListener('keydown', …)` in the constructor (lines 204–230). First handles `Escape` → `handleDismiss()` when `model.kind !== 'hidden'`. Second handles bare `Enter` → insert next part, only when `model.kind === 'reply' && model.feature === 'fast-reply'` and focus is not editable/interactive (lines 211–230).
- **`handleDismiss()`** (lines 233–244): branches on `this.dismissMode`. `'collapse-to-inline'` → `callbacks.onCollapse()`; `'cancel-and-close'` on a loading model → `callbacks.onCancel(operationId)` then `onClose()`; else `onClose()`.
- **Dismiss mode selection** in `render()` (lines 263–270): explicit `opts.dismissMode` wins; else `'cancel-and-close'` when `kind==='loading'`; else `'close'`.
- **Scroll lock / pointer events** (lines 271–272): `document.body.classList.toggle('chatgoose-scroll-lock', model.kind !== 'hidden')`; `this.root.style.pointerEvents = model.kind === 'hidden' ? 'none' : 'auto'`.
- **Mount:** `ensureShell()` (lines 360–439) builds the DOM once: `chatgoose-overlay-shell` > (`chatgoose-overlay-backdrop`, `chatgoose-overlay-panel`). Panel > (`chatgoose-overlay-header` [title block `chatgoose-eyebrow`/`chatgoose-title`/`chatgoose-subtitle` + `chatgoose-close` button], `chatgoose-inline-error chatgoose-hidden`, `chatgoose-overlay-body`). Returns `true` when it (re)built. `this.root.replaceChildren(shell)` at 427.
- **Backdrop click** (lines 380–385): dismisses unless `this.passThrough`. **Panel pointerdown** (389–395): clears `passThrough`. Close button (414–416) → `handleDismiss()`.
- **Unmount:** `teardownShell()` (lines 441–454) — `this.root.replaceChildren()` and nulls all element refs + `currentView` + `lastFocusedReplyOpId`. Called on `kind==='hidden'` (line 278).

## Loading view update-in-place vs body rebuild

- **`renderBody(model)`** (lines 499–542) returns `'rebuild-body' | 'update-loading'`. The in-place path (lines 504–507): when `model.kind === 'loading' && this.currentView?.kind === 'loading' && this.currentView.operationId === model.operationId`, it calls `updateLoadingView(this.currentView, model)` and returns `'update-loading'` — **no DOM rebuild**. Otherwise it builds `nextView` (createLoadingView / renderReply / renderHelpMe / renderReadOnly / renderError) and does `this.bodyEl.replaceChildren(nextView.root)` (line 525), sets `this.currentView = nextView`.
- **Auto-focus** for a newly visible completed `fast-reply` (lines 528–539): focuses first `.chatgoose-card-actions .chatgoose-button` when the op id differs from `lastFocusedReplyOpId`.
- `createLoadingView` (544–599) builds `chatgoose-grid` with `chatgoose-overlay-status`, `chatgoose-stream chatgoose-stream-live`, `chatgoose-loading-spend-host`, `chatgoose-overlay-actions` (Cancel button → `callbacks.onCancel(operationId)`), and stores Text nodes in `LoadingViewState` (interface lines 75–93) for cheap text-node updates.
- `updateLoadingView` (601–615) mutates in place: `syncLoadingSpend`, `syncLoadingProfiling`, `refreshLoadingStatus`, `syncLoadingStatusTimer`, then `view.streamText.data = streamText` (streamText = `model.rawText || 'Waiting for AI…'`), then `syncLoadingDebugPrompt`. Spend diffing via `view.spendHost.dataset.spendKey` (627–648). A `window.setInterval(…,100)` live-elapsed timer is managed by `syncLoadingStatusTimer` (885–908) / `clearLoadingElapsedTimer` (318–324).

## insertPart + operationId attribution (~:326)

`private async insertPart(part, options?)` (lines 326–349):
```ts
await insertIntoFanslyTextarea(part.text);
part.insertedOnce = true; part.insertedAt = Date.now();
this.inlineError = null;
if (options?.autoPassThrough) this.passThrough = true;
this.render(this.model);
const operationId = 'operationId' in this.model ? this.model.operationId : null;
if (operationId) {
  this.callbacks.onAcceptance?.(operationId, 'inserted', part.sequenceIndex);
  this.scheduleInsertedReset(part, operationId);
}
this.queueComposerFocus();
```
`scheduleInsertedReset` (351–358) clears `insertedAt` after `insertedFeedbackDelayMs()` (2000ms). The **Copy** acceptance path is in `createPartCard` (lines 1010–1027): `await copyToClipboard(part.text)` then `callbacks.onAcceptance?.(operationId, 'copied', part.sequenceIndex)`. Card body text click also inserts (lines 990–996), guarded against text-selection.

## State kept between renders (instance fields, lines 178–201)

`root`, `model` (last `OverlayViewModel`, default `{kind:'hidden'}`), `passThrough` (bool), element refs (`shellEl`, `backdropEl`, `panelEl`, `headerEyebrowEl`, `headerTitleEl`, `headerSubtitleEl`, `inlineErrorEl`, `bodyEl`), `currentView: OverlayViewState | null`, `inlineError: UserFacingError | null`, `debugPromptOpen` + `debugPromptOperationId`, `loadingElapsedTimer`, `dismissMode`, `renderTraceEnabledFromStorage`, `lastFocusedReplyOpId`, and `renderTraceState` (renderCount/lastKind/lastOperationId). The overlay keeps **no fan/account identity or transcript** — everything comes in via `render(model)`.

---

# 2. Surface planning — `src/content/surface-planner.ts` (115 lines) + `src/content/index.ts`

## SurfacePlannerInput / SurfacePlan shape

`SurfacePlannerInput` (lines 27–37):
```ts
activeFeature: FeatureType | null;
activeLoadingModel: OverlayViewModel | null;
activeRegenerableLoadingModel: OverlayViewModel | null;
activeCompareModel: CompareInlineViewModel | null;
comparePanelVisible: boolean;
quickSurfaceMode: QuickSurfaceMode;   // 'inline' | 'overlay'
quickInlineVisible: boolean;
cachedInlineModel: CompletedOverlayViewModel | null;
deepOverlayModel: OverlayViewModel | null;
```
`SurfacePlan` (lines 39–43): `{ overlay: OverlaySurfacePlan; inline: InlineSurfacePlan; resetQuickSurfaceMode: boolean }`. `OverlaySurfacePlan` (15–21) = `{kind:'hidden', model}` | `{kind:'render', model, dismissMode?:'collapse-to-inline'}`. `InlineSurfacePlan` (23–25) = `{kind:'hidden'}` | `{kind:'render', model: InlinePanelViewModel}`.

**`planSurfaces(input)`** (74–115) precedence: (1) overlay feature + loading → `overlayPlan(activeLoadingModel)`; (2) inline feature + regenerable loading → overlay w/ collapse-to-inline if mode='overlay', else inline if visible else hidden; (3) compare panel; (4) quickInline + cachedInline; (5) `deepOverlayModel` → `overlayPlan`; (6) `hiddenPlan(quickSurfaceMode==='overlay')`. `QuickSurfaceMode` exported at line 13. Uses `usesOverlayFeatureSurface` / `usesInlineFeatureSurface` from `../shared/features.js`.

## Where planSurfaces is called + the state fields live (index.ts)

- **`renderSurfaces()`** (index.ts:535–558): captures scroll snapshot, calls `this.applySurfacePlan(planSurfaces({...}))` mapping all instance state into the input, then `applyScrollCompensation`.
- **`applySurfacePlan(plan)`** (581–601): hides/renders inline and overlay per plan; `plan.overlay.dismissMode` forwarded as `{dismissMode}`; resets `quickSurfaceMode='inline'` if `plan.resetQuickSurfaceMode`.
- **`renderAll()`** (530–533): `renderSurfaces()` then `renderButtonBar()`.
- **State fields (index.ts class):** `deepOverlayModel: OverlayViewModel | null` (line 179), `overlayRawText = ''` (164), `quickSurfaceMode: 'inline'|'overlay'` (170), `quickInlineVisible` (171), `quickSurfaceEverOpened` (172), `activeFeature`/`activeOperationId`/`activeFanDisplayName` (147–149), `activeProgress`/`activeLlmSpend`/`activeProfiling`/`activeDebugPrompt`/`activeDebugEcho` (150–155), `activeCompareModel`/`comparePanelVisible`/`pendingCompareFingerprint` (165–167), `currentGroupId` (145), `routeNonce` (143), `suppressedTerminalOpIds` Set (174).
- `buildActiveLoadingModel(options?)` (603–618) constructs the `kind:'loading'` model from these fields (feeds `activeLoadingModel`/`activeRegenerableLoadingModel`).
- Loading renders are debounced via `scheduleLoadingRender()` / `cancelScheduledLoadingRender()` (620–641) using `requestAnimationFrame` and captured op-id/nonce guards.

## Route-change / fan-switch handling

- **route-watcher:** `src/content/route-watcher.ts` (23 lines) — `startRouteWatcher(onChange)` polls `window.location.pathname` every `ROUTE_POLL_INTERVAL_MS` (500ms, constants.ts:109) and calls `onChange(groupId)`. `parseGroupIdFromPath` regex `/^\/messages\/([^/?#]+)/`. Wired in `init()` (index.ts:382): `startRouteWatcher((groupId) => this.handleRouteChange(groupId))`.
- **`handleRouteChange(groupId)`** (index.ts:1044–1108): `routeNonce += 1`; sets `currentGroupId`; if changed resets `lastSentReplyTone='none'`; `completedOverlayCache.setActiveGroup(groupId)`, `completedCompareCache.setActiveGroup(groupId)`, `mountController.setActiveRoute(groupId)`. On change it branches by active surface:
  - inline feature in flight → `quickInlineVisible=false`, `quickSurfaceMode='inline'`, `suppressTerminalOperation(activeOperationId)`, `clearOperationState(true)`, `overlayRawText=''` (1058–1069).
  - active compare → hide, suppress, null out, clear compare cache (1070–1075).
  - overlay feature in flight → `suppressTerminalOperation`, `clearOperationState(true)`, `overlayRawText=''` (1076–1088).
  - no active feature → clear `quickInlineVisible`/`comparePanelVisible`/`deepOverlayModel`/`activeCompareModel`, `clearOperationState(true)`, `overlayRawText=''` (1089–1097).
  - Then sends `tab:init` (first time, `hasSentInit`) or `tab:routeChanged` on the port (1100–1105).
- **Operation-cancel-on-route-change** is the `suppressTerminalOperation` mechanism (1560–1572): op ids added to `suppressedTerminalOpIds`; `consumeSuppressedTerminalOperation` in `handleComplete`/`handleOperationError`/`handleCompareComplete`/`handleCompareTerminal` drops the terminal message so a previous fan's result never lands on the new conversation. Note: route change **suppresses** the terminal but does not itself send `operation:cancel` (explicit cancels go through `cancelActiveOperation`, 446–469).

---

# 3. Feature start flow — `src/content/index.ts`

## `startFeature(feature, forceRegenerate)` (lines 850–931)

Flow: (1) if same `activeFeature` and inline+non-draft, just reveal quick inline (852–862). (2) if any op in flight → `another_operation` toast, return (864–867). (3) clear compare panel state (869–872). (4) compute `draftText` (trim) when `featureRequiresDraft`, and `improveDraftCacheKey = buildFeatureCacheKey(...)` (874–877). (5) cache lookup via `completedOverlayCache.get(currentGroupId, feature, improveDraftCacheKey)` unless `forceRegenerate` → `restoreCachedFeatureResult` (879–890). (6) `ensureFeatureCanStart(feature)` gate (892–894). (7) `operationId = crypto.randomUUID()`, `domFanDisplayName = getActiveConversationDisplayName()`, `initializeFeatureOperation(...)` (896–903). (8) `buildOperationStartPayload(...)` (735–758) then `this.port.send(payload)` (905–912); on `!sent` tear down + `extension_reloaded` toast (913–922). (9) tone bookkeeping: `lastSentReplyTone`, `resetNextReplyTone()` when `featureSupportsReplyTone` (923–930).

- `ensureFeatureCanStart` (671–701): checks `tabState`, api key (`isApiKeyReadyForFeature`), `hasPersonalities`, `mappedPersonalityId`, `connected`, draft presence.
- `initializeFeatureOperation` (769–796): resets active* fields, sets `activeFeature`/`activeOperationId`/`activeFanDisplayName`/`lastFeature`, clears `overlayRawText`, for inline features resets `quickInlineVisible`/`quickSurfaceEverOpened`/`quickSurfaceMode`, then `renderSurfaces()`.
- `presentCompletedFeature` (798–822), `presentOperationError` (824–846), `restoreCachedFeatureResult` (653–669).

## How hotkeys reach startFeature

- **Keymap engine:** `src/shared/keymap.ts` — `createKeymap(bindings)` → `resolve(ev): action|null` (71–93), matching via `eventMatchesCombo` (54–63). `KeyEventLike` includes `inEditable` gating (mod/alt/escape fire while typing).
- **`installKeymap()`** (index.ts:389–408): global keydown → `keymap.resolve({key, metaKey, ctrlKey, altKey, shiftKey, inEditable})` → `dispatchHotkey(action)`; `preventDefault()` only when handled.
- **`dispatchHotkey(action)`** (410–433): `const feature = HOTKEY_FEATURE[action]` — if a feature, requires `currentGroupId` then `startFeature(feature, false)`. App actions in `switch`: `'cycle-tone'` → `cycleNextReplyTone()`; `'cancel'` → `cancelActiveOperation()`; `'spenders-board'` → `this.board.toggle()`; `'cheatsheet'` → `this.cheatsheet.toggle()`.
- **hotkeys.ts** (`src/shared/hotkeys.ts`): `HotkeyAction` union (25–36) includes the 7 features + `cycle-tone`, `cancel`, `spenders-board`, `cheatsheet`. `HOTKEY_FEATURE` (39–47) maps feature-actions 1:1 to `FeatureType` (app actions absent → `undefined`). `AI_HOTKEYS` table (75–86) defines letters (e.g. spenders-board = `'m'`). `buildHotkeyBindings(platform)` (88–105) builds `KeyBinding[]` with combo `${modifier}+${letter}` (mac `mod+shift`, other `alt+shift`) and pushes the bare `'?'` cheatsheet binding. `detectLabelPlatform`, `comboLabel`, `featureHotkeyLabel`, `CHEATSHEET_EXTRAS` also exported.

**Spenders-board / cheatsheet app actions end-to-end:**
- Instances built in index.ts: `this.board = new SpendersBoardController({...deps...})` (325–339), `this.launcher = new BoardLauncher(() => this.board.toggle())` (340), `this.cheatsheet = new CheatsheetController(this.hotkeyBindings)` (324). `hotkeyBindings` (322) + `keymap` (323) built in field initializers.
- Board is opened three ways: hotkey (`dispatchHotkey` → `board.toggle()`), the floating `$` launcher (`BoardLauncher`, `src/content/spenders/board-launcher.ts`, body-anchored `#chatgoose-launcher-root`), mounted in `init()` via `this.launcher.mount()` (385). `SpendersBoardController` is body-anchored (`ensureBoardRoot()` → `#chatgoose-board-root`, controller lines 68–76) — **not** a button-bar callback. Cheatsheet is body-anchored too (`ensureCheatsheetRoot()` → `#chatgoose-cheatsheet-root`).
- So spenders/cheatsheet are **not** wired through button-bar callbacks — they are standalone body-anchored controllers toggled from the keymap (and `$` launcher). The button bar only exposes feature/compare/tone/split callbacks (see below).

## button-bar.ts structure — `src/content/button-bar.ts` (291 lines)

- **Callbacks** `ButtonBarCallbacks` (44–52): `onFeatureClick(feature)`, `onCompareClick()`, `onCompareRestoreClick()`, `onReplyModeToggle()`, `onToneSelect(tone)`. Wired in index.ts:210–220.
- **`TOOLBAR_FEATURES`** (10–19): `fast-reply`="Reply", `improve-draft`="Fix", `hi-greeting`="Hi", `ping`="Ping", `fan-summary`="Recap". (`help-me`, `chat-review` are **hidden** — implemented but not in the bar.)
- **`TONE_OPTIONS`** (28–38): casual/flirty/upsell/spicy segments; **`TONE_CYCLE_LETTER = 'O'`** (42).
- **Bar v2 order (constructor `this.root.append(...)` at 153–164):** `replyButton`, `toneTrack`, `replyModeToggle` (Split), `makeSeparator()`, `fixButton`, `makeSeparator()`, `hiButton`, `pingButton`, `summaryButton`, `personalityLabel`. Comment at 149–152 notes "Help / Review / Compare stay implemented but hidden." Compare button + `compareRestoreButton` are created (103–116) and stored in the `buttons` map but **not appended** to the row; `render()` keeps `compareRestoreButton` `chatgoose-hidden` (270–271).
- **How to add a new button + callback:** (1) add a field to `ButtonBarCallbacks`; (2) create the `<button>` in the constructor (`type='button'`, `className='chatgoose-button chatgoose-toolbar-button'`, add `click` → `this.callbacks.xxx()`); store in `this.buttons` if it is a `ToolbarAction` (`type ToolbarAction = FeatureType | 'compare'`, line 5) — otherwise a plain field; (3) `this.root.append(...)` it in the desired order slot; (4) update `render(...)` (222–290) for enabled/active state. `render()` signature: `render(state, activeAction, nextReplyMode, nextReplyTone, hasDraftText, activeLoading=false, _showCompareRestore=false)`. `renderButtonBar()` in index.ts (509–528) computes `activeAction`/`activeLoading` and calls it.

---

# 4. Port protocol content ↔ background

## port-client.ts (`src/content/port-client.ts`, 78 lines)

`PortClientCallbacks` (5–8): `onMessage(BackgroundPortMessage)`, `onDisconnected()`. `connect()` (18–39): `browser.runtime.connect({ name: 'chatgoose-content' })`; on message, guards with `isBackgroundPortMessage` before `onMessage`; on disconnect nulls the port, fires `onDisconnected`, schedules reconnect; replays `lastInit` on reconnect. `scheduleReconnect` uses `PORT_RECONNECT_DELAYS_MS = [100,200,400]` (constants.ts:117). **`send(message): boolean`** (62–77): persists `tab:init`/`tab:routeChanged` into `lastInit` (replayed on reconnect); returns `false` when `this.port` is null (dropped) — callers of `operation:start`/`compare:start`/cancels must handle the `false`.

## protocol.ts (`src/shared/protocol.ts`, 411 lines)

- **Envelope:** every message is a discriminated union on `type` (see `PortEnvelopeBase.type` union in types.ts:931–958). `isObjectRecord` (54) is the base guard.
- **`operation:start` validator** `isOperationStartMessage` (171–180): requires `operationId` (string), `feature` (isFeatureType against `FEATURE_TYPES` set built from `FEATURE_POLICIES`, line 33), `isTabRouteMessage` (`groupId` nullable-string + `routeNonce` number), nullable `domFanDisplayName`, optional `draftText`, optional-bool `forceRegenerate`, `isOptionalReplyMode`, `isOptionalReplyTone`. `REPLY_MODES`/`REPLY_TONES` sets at 45–52.
- **`OperationStartPayload`** shape in types.ts:975–986 (type, operationId, feature, groupId, routeNonce, domFanDisplayName, draftText?, forceRegenerate?, replyMode?, replyTone?).
- **Streaming message kinds** — validated in `isBackgroundPortMessage` (324–391): `operation:chunk` (operationId + text, 330–331), `operation:complete` (346–348: operationId + `result` object + `fanDisplayName`), `operation:error`/`operation:discarded` (349–351: operationId + `error` object), `operation:progress` (383–384), plus compare twins (`compare:chunk`/`compare:cardComplete`/`compare:cardError`/`compare:complete`/`compare:error`/`compare:discarded`/`compare:ready`/`compare:progress`). Also `operation:debugPrompt`/`operation:debugPromptStatus` (334–344; the latter uses strict `hasExactKeys` to prevent prompt leakage into the page — E28).
- **`isContentPortMessage`** (297–322) validates the outbound side including `operation:acceptance` (310–315: operationId string, action ∈ `copied|inserted`, partIndex number).
- `sendRuntimeRequest<K>(type, payload?)` (393–411) — one-shot `browser.runtime.sendMessage` (used for spenders list/resolve, debug prompt viewer), separate from the port.

## Content receives streamed text — `handleChunk` (index.ts:1449–1474, dispatched at 1168–1169)

```ts
private handleChunk(operationId, text): void {
  if (this.activeOperationId !== operationId) return;
  this.overlayRawText += text;
  if (this.activeFeature && featureRequiresDraft(this.activeFeature)) return;   // Fix: no live surface
  if (this.activeFeature && usesInlineFeatureSurface(this.activeFeature)) {
    if (!this.quickSurfaceEverOpened) { this.quickSurfaceEverOpened = true; if (this.quickSurfaceMode==='inline') this.quickInlineVisible = true; }
    this.scheduleLoadingRender(); return;
  }
  this.scheduleLoadingRender();
}
```
`overlayRawText` is the single accumulator; `buildActiveLoadingModel` (603–618) puts it into `rawText`, and `handleComplete` sets `this.overlayRawText = message.result.rawText` (1491).

## operation:acceptance payload

`OperationAcceptancePayload` (types.ts:1020–1025): `{ type:'operation:acceptance'; operationId: string; action: 'copied'|'inserted'; partIndex: number }`. Sent from both the overlay callback (index.ts:286–288) and inline-panel callback (231–233): `this.port.send({ type:'operation:acceptance', operationId, action, partIndex })`.

---

# 5. Session / caches in content

## CompletedOverlayCache — `src/content/overlay/completed-overlay-cache.ts` (70 lines)

- Keyed by **active group** (single-group cache): `activeGroupId` + `completedByFeature: Map<FeatureType, {cacheKey: string|null, model: CompletedOverlayViewModel}>`.
- `setActiveGroup(groupId)` clears the map when the group changes (12–19). `get(groupId, feature, cacheKey?)` returns null unless `groupId===activeGroupId` and the stored `cacheKey` matches (21–40). `set(...)` (42–57), `clearFeature` (59–65), `clearAll` (67–69).
- Stores only completed models (`reply`/`helpMe`/`readOnly` — `CompletedOverlayViewModel`, types.ts:1322–1325). The `cacheKey` is the draft-text key for `improve-draft` (see `buildFeatureCacheKey`/`buildImproveDraftCacheKey` in index.ts:643–651, 1597–1600). Instantiated at index.ts:228. A sibling `CompletedCompareCache` (index.ts:229) is keyed by group with a `fingerprint`.

## summary-cache.ts — `src/shared/summary-cache.ts` (302 lines)

- **`SummaryCacheKey`** = `` `${SUMMARY_CACHE_PREFIX}${string}` `` (line 9); `SUMMARY_CACHE_PREFIX = 'summary:'` (constants.ts:11). `summaryCacheKey(groupId)` (23) → `summary:<groupId>`. **Persists in `browser.storage`** (chrome.storage) keyed by groupId — this is the deep fan-summary cache, distinct from the in-memory `CompletedOverlayCache`.
- `SummaryCacheEntry` fields (normalizer 52–93): `summary`, `personalityId`, `personalityUpdatedAt`, `generatedAt`, optional `spendingDataVerified`, `subscriptionLookupVerified`, `modelId`, `fanAccountId`, `agencyHubSync`. `SummaryCacheStore` class (185–259) with `get/save/update/remove` + eviction (`getSummaryCacheEvictionKeys`). `hasAvailableFanSummary(storage, groupId, mappedPersonalityId)` (277–302) drives `tabState.hasAvailableSummary`. This lives in the **background/storage** layer; the content script only sees the derived `hasAvailableSummary` boolean on `TabUiState`.

## Fan identity / groupId / accountId in content

- **groupId:** from the URL via route-watcher (`parseGroupIdFromPath`, `/messages/<groupId>`), held as `this.currentGroupId` (index.ts:145). It is the conversation identity.
- **accountId:** arrives on `TabUiState.accountId` from the background (`tab:state`/`settings:changed`/`mapping:changed`), stored in `this.tabState` (index.ts:1124). The board context key uses it: `getContextKey: () => accountId ? \`${accountId}:${boardContextGeneration}\` : null` (330–331).
- **conversation-dom.ts** (`src/content/conversation-dom.ts`, 116 lines): selectors `app-messages-conversation-route` (ROUTE_ROOT), `app-group-message-input` (INPUT_HOST), `app-account-username .user-name` / `app-group-message-input .label` (display name), textarea selectors (13–17). `getActiveConversationDom()` returns `{routeRoot, container, inputHost, inputParent, displayName}`. `getActiveConversationDisplayName()` (93–100) and `findActiveConversationTextarea()` (102–116). `getActiveConversationDisplayName()` is called in `startFeature`/`startCompare` to attach `domFanDisplayName` to the operation.
- `TabUiState` (types.ts:714–728): `tabId, accountId, groupId, hasAvailableSummary, connected, hasApiKey, modelProviderByFeature?, apiKeyReadyByFeature?, hasPersonalities, mappedPersonalityId, mappedPersonalityName, compareCardCount, compareDraftCount`.

## mapping-banner / persona mapping state

- **mapping-banner.ts** (`src/content/mapping-banner.ts`, 128 lines): `MappingBanner` renders the "assign this account to a personality" banner (`chatgoose-banner`). `render(accountId, mapped)` (36–127) hides when mapped, else builds a `<select>` of `state.personalities` and Save/Settings buttons; saves via `saveAccountMapping(accountId, personalityId)`. Instantiated index.ts:221–225; re-rendered on every `tab:state`/`settings:changed`/`mapping:changed` (index.ts:1125): `void this.mappingBanner.render(message.state.accountId, Boolean(message.state.mappedPersonalityId))`.
- Persona/mapping state in content is derived entirely from `tabState.mappedPersonalityId` / `mappedPersonalityName`; the personality catalog is loaded from storage via `loadStorageState()` (used in mapping-banner and `computeCompareFingerprint`, index.ts:1647–1657).

---

# 6. Textarea + toasts

## textarea.ts — `src/content/textarea.ts` (49 lines)

- `copyToClipboard(text)` (4–6): `navigator.clipboard.writeText`.
- `focusActiveConversationTextarea()` (8–22): focuses, moves caret to end.
- **`getActiveConversationDraftText()`** (24–26): `findActiveConversationTextarea()?.value ?? ''`.
- **`insertIntoFanslyTextarea(text)`** (28–49): focus + `select()`, tries `document.execCommand('insertText', false, text)`; if that fails/mismatch, sets `textarea.value = text` and dispatches synthetic `input` + `change` events (bubbles); throws `ChatGooseError('insertion_failed')` if the value still doesn't match or no textarea. This is a **replace-whole-value** insert (selects all first), not append. Used by `OverlayController.insertPart`, `InlinePanelController`, and `applyImproveDraftResult` (index.ts:1608).

## toast.ts — `src/content/toast.ts` (86 lines)

`ToastController` (root = `ensureToastRoot()` → `#chatgoose-toast-root`). **`show(message: string | UserFacingError, options?: ToastOptions)`** (22–74). `ToastOptions` (9–16): `actionLabel?`, `onAction?`, `durationMs?` (default 4500), `description?`, `dedupeKey?`, `tone?: 'info'|'success'|'warning'|'error'`. Dedup via `dedupeKey` (default `primaryText|description`); replaces existing toast with same key. Builds `chatgoose-toast chatgoose-toast-<tone>` with `chatgoose-toast-primary`, optional `chatgoose-toast-secondary`, optional `chatgoose-toast-actions` button. In index.ts wrapped by `showUserErrorToast(error, options?)` (348–370) which adds a "Settings" action when `userError.settingsLink`.

---

# 7. Styles — `src/content/styles.css` (2172 lines)

## Conventions

- **Class prefix:** every class is `chatgoose-*`. Sectioned with `/* ─── Name ─── */` comment banners.
- **CSS variables** in `:root` (lines 11–60) and dark twin `:root.chatgoose-theme-dark` (64–91). Palette tokens: `--chatgoose-bg0..bg3`, `--chatgoose-line`/`line-strong`, `--chatgoose-field`, `--chatgoose-ink`/`ink-mid`/`ink-low`, `--chatgoose-clay*` (terracotta accent), `--chatgoose-green*`, `--chatgoose-amber*`, `--chatgoose-bad`/`warn`/`online`, `--chatgoose-draft-bg`/`draft-hover`. Radii: `--chatgoose-radius-card:9px`, `-chip:7px`, `-menu:11px`, `-flat:5px`. `--chatgoose-shadow`, `--chatgoose-shadow-pop`, `--chatgoose-scrim`. Fonts: `--chatgoose-font` (Hanken Grotesk), `--chatgoose-font-serif`, `--chatgoose-font-mono`.
- **Theming:** `installUiTheme(uiTheme)` from `src/shared/theme.js` toggles `chatgoose-theme-dark` on `<html>` (called in `init()`, index.ts:378–380). Dark styles are scoped to the 6 roots: `#chatgoose-root, #chatgoose-overlay-root, #chatgoose-toast-root, #chatgoose-board-root, #chatgoose-cheatsheet-root, #chatgoose-launcher-root` (lines 101–112) — a Coach chat mode reusing the overlay root inherits theming automatically; a new body-anchored root would need adding to those selector lists.

## Where chat-mode styles would live

- **Overlay section:** `/* ─── Overlay ─── */` at line 917. `#chatgoose-overlay-root` (919–925, `position:fixed; inset:0; z-index:2147483646; pointer-events:none`). `.chatgoose-overlay-shell` (927–936), `.chatgoose-overlay-backdrop` (939–948, incl. `.chatgoose-pass-through` → `pointer-events:none`), `.chatgoose-overlay-panel` (950–966, `width:min(720px,100%); max-height:min(84vh,860px); display:grid; gap:14px; animation:chatgoose-slide-up`), `.chatgoose-overlay-body` (975–977), `.chatgoose-overlay-header` (994–999). Content classes reused by any new overlay view: `.chatgoose-grid` (1342), `.chatgoose-card`/`-recommended`/`-followup`/`-title`/`-hint`/`-status`/`-text`/`-text-insertable` (1170–1238), `.chatgoose-parts` (1164), `.chatgoose-stream`/`-stream-live` (1059/1075), `.chatgoose-overlay-status` (1050), `.chatgoose-overlay-actions`/`-action-status`, `.chatgoose-button`/`-secondary`/`-danger` (170–208), `.chatgoose-inline-error` (used at 1050+), `.chatgoose-hidden` (132), `body.chatgoose-scroll-lock` (1571).
- **Board section** (a full body-anchored modal template a Coach chat could mirror): `/* board */` — `#chatgoose-board-root` (1770–1775), `.chatgoose-board-backdrop` (1777–1788), `.chatgoose-board-panel` (1790–1801, `display:flex; flex-direction:column; width:min(940px,100%); max-height:88vh`), `.chatgoose-board-panel-enter` (1803–1805, slide-up), `.chatgoose-board-header` (1807–1814), plus `-title`/`-subtitle`/`-actions`/`-body`/`-chips`/`-list`/`-search`/`-section`/`-row` classes (1816–2172). Board is a scrollable flex-column panel — the closest structural analog for a chat transcript + composer.
- **Cheatsheet section** (1732+) and inline-panel scoping (`.chatgoose-inline-panel .chatgoose-*`, 640–765) are the other body/inline templates.

A chat-mode ("Coach") UI could either (a) add a new `OverlayViewModel` kind + `renderX` method in `overlay-controller.ts` and reuse `#chatgoose-overlay-root`/overlay CSS, or (b) follow the standalone body-anchored controller pattern (`SpendersBoardController`/`CheatsheetController`) with a new `ensureXRoot()` + a `#chatgoose-*-root` added to the dark-theme selector list at styles.css:101–112.