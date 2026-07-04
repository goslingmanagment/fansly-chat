# 08 — Content: Lifecycle, SPA Routing & Fansly DOM Boundary

## Scope

This map covers the content-script runtime of the ChatGoose Firefox extension — the code injected into `fansly.com` pages that renders the toolbar/overlays and reads/writes the Fansly DOM. Files covered (all under repo root `src/content/`):

- `src/content/index.ts` — the content-script app (`ChatGooseContentApp`), bootstrap, controller wiring, hotkeys, Port message dispatch, feature/compare lifecycle.
- `src/content/route-watcher.ts` — location polling and groupId extraction.
- `src/content/conversation-mount-controller.ts` — attaching the UI root to the active conversation subtree, retry cadence, MutationObserver re-anchoring.
- `src/content/conversation-dom.ts` — **the Fansly-DOM READ boundary** (selectors, display-name parsing, textarea discovery).
- `src/content/textarea.ts` — **the Fansly-DOM WRITE boundary** (insert into composer, focus, clipboard, draft read).
- `src/content/dom-anchor.ts` — injected style/root elements.
- `src/content/surface-planner.ts` — pure decision function choosing inline vs overlay surface.
- `src/content/scroll-compensation.ts` — scroll-container discovery and scroll-offset compensation.
- `src/content/port-client.ts` — the long-lived runtime Port client (connect/reconnect/send/receive).

Referenced but documented elsewhere: `docs/project-kernel/boundaries.md` (the four external boundaries — do not re-derive here). UI surface controllers (`button-bar.ts`, `overlay/*`, `inline-panel/*`, `toast.ts`, `mapping-banner.ts`, `cheatsheet-controller.ts`, `spenders/*`) are wired by `index.ts` but are out of this map's file set; only their interaction points are noted.

---

## 0. Entry point & injection

- **Manifest** (`manifest.json:27-37`): `content_scripts` entry matches `*://fansly.com/*`, injects a single bundle `content.js`, `run_at: "document_idle"`. The build bundles `src/content/index.ts` → `content.js`.
- **Bootstrap guard** (`index.ts:1649-1651`): at module top-level, `if (window.location.hostname.endsWith('fansly.com')) { new ChatGooseContentApp().init(); }`.
  - Discrepancy / note: the manifest `matches` only covers the exact host `fansly.com` (`*://fansly.com/*`), while the runtime guard `hostname.endsWith('fansly.com')` would also admit any subdomain (e.g. `apiv3.fansly.com`, `foo.fansly.com`). The manifest, not the guard, is the effective gate on where the script loads; the guard is a secondary check.
- `ChatGooseContentApp.init()` (`index.ts:343-349`) runs, in order:
  1. `installContentStyles(contentStyles)` — inject `<style id="chatgoose-style">` (see dom-anchor).
  2. `this.port.connect()` — open the background Port.
  3. `startRouteWatcher((groupId) => this.handleRouteChange(groupId))` — begin route polling; fires synchronously once with the initial groupId.
  4. `this.installKeymap()` — attach the global `keydown` listener.
  5. `this.launcher.mount()` — mount the Spenders board launcher button (`BoardLauncher`).

`contentStyles` is imported from `./styles.css` (`index.ts:1`) via the bundler's CSS-as-string import.

---

## 1. `src/content/index.ts` — `ChatGooseContentApp`

~1651 lines; a single exported class `ChatGooseContentApp` plus three module-private helpers. This is the content-script orchestrator: it holds all UI state, wires every controller, translates user actions into Port messages, and applies streamed Port results to the surfaces.

### 1.1 Imports (who it depends on)

Content-local: `ButtonBar`, `getActiveConversationDisplayName`/`findActiveConversationTextarea` (`conversation-dom.js`), `ConversationMountController`, `installContentStyles` (`dom-anchor.js`), `CompletedCompareCache`, `InlinePanelController`, `MappingBanner`, `CompletedOverlayCache`, `OverlayController`, `PortClient`, `CheatsheetController`, `BoardLauncher`, `SpendersBoardController`, `startRouteWatcher`, `captureScrollSnapshot`/`applyScrollCompensation` (`scroll-compensation.js`), `planSurfaces`/`SurfacePlan` (`surface-planner.js`), `getActiveConversationDraftText`/`insertIntoFanslyTextarea` (`textarea.js`), `ToastController`, `isEditableElement` (`ui/view-helpers.js`).

Shared: `buildHotkeyBindings`, `detectLabelPlatform`, `HOTKEY_FEATURE`, `HotkeyAction` (`../shared/hotkeys.js`); `createKeymap` (`../shared/keymap.js`); `sendRuntimeRequest` (`../shared/protocol.js`); `getCompareCardsFingerprintForPersonality` (`../shared/compare-cards.js`); error helpers (`../shared/errors.js`); feature-policy predicates (`../shared/features.js`); reply-part normalizers (`../shared/reply-output.js`); `loadStorageState` (`../shared/storage.js`); many types from `../shared/types.js`.

Called by: nobody imports this module; it is the bundle entry. It self-instantiates at file bottom.

### 1.2 Module-private helpers (`index.ts:79-136`)

- `createParts(parts: string[]): OverlayInsertPart[]` — wraps reply strings into insertable parts with `id = ${index}-${text.slice(0,12)}`, `sequenceIndex`, `insertedAt:null`, `insertedOnce:false`.
- `resultPartTexts(feature, result, rawText): string[]` — normalizes a `FeatureResult` into part strings. If `result.parts` is an array → `normalizeProvidedReplyParts`. Otherwise switches on `getFeaturePolicy(feature).resultKind`: `single-reply` → `normalizeSingleReplyPart(rawText)`; `reply` → `normalizeVariantReplyParts` for `hi-greeting`, else `normalizeReplyParts`; `help-me`/`summary`/`chat-review` → `[]`.
- `applyFanSummarySyncStatus(model, generatedAt, syncStatus): boolean` — mutates a `readOnly`/`fan-summary` overlay model's `summaryMeta.syncStatus` in place when `summaryMeta.generatedAt` matches; returns whether it changed.
- `getMessageLlmSpend(message)` — returns `message.llmSpend`.

### 1.3 State fields (`index.ts:139-168`)

| Field | Type / init | Meaning |
|---|---|---|
| `routeNonce` | `0` | Monotonic counter, bumped each route change; stamped into `tab:init`/`tab:routeChanged`/`operation:start`/`compare:start` payloads so background can discard stale work. |
| `currentGroupId` | `string \| null` | Active conversation groupId parsed from URL. |
| `tabState` | `TabUiState \| null` | Latest snapshot pushed by background (`tab:state`/`settings:changed`/`mapping:changed`). |
| `activeFeature` | `FeatureType \| null` | Feature of the in-flight single operation. |
| `activeOperationId` | `string \| null` | `crypto.randomUUID()` of in-flight single op. |
| `activeFanDisplayName` | `string \| null` | Display name captured at op start (defaults `'fan'`). |
| `activeDebugPrompt` | `PromptDebugSnapshot \| null` | Latest debug-prompt snapshot from background. |
| `activeLlmSpend` | `LlmSpendSummary \| null` | Latest spend summary. |
| `activeProfiling` | `OperationProfilingSnapshot \| null` | Latest profiling snapshot. |
| `activeProgress` | `OperationProgressPayload \| null` | Latest progress payload. |
| `lastFeature` | `FeatureType \| null` | Last feature run (survives clearing `activeFeature`), used for cache lookup. |
| `nextFastReplyMode` | `ReplyMode` = `'default'` | Armed reply-mode for the next fast-reply/compare (`'default'`/`'preferSplit'`). |
| `nextReplyTone` | `ReplyTone` = `'none'` | Armed tone for the next reply. |
| `hasSentInit` | `false` | Whether `tab:init` has been sent (first route change sends init, subsequent send `tab:routeChanged`). |
| `overlayRawText` | `''` | Accumulated streamed text for the overlay/inline reply. |
| `activeCompareModel` | `CompareInlineViewModel \| null` | Multi-draft ("compare"/Multi) view model. |
| `comparePanelVisible` | `false` | Whether compare panel is shown. |
| `pendingCompareFingerprint` | `string \| null` | Compare-cards fingerprint captured at compare start, stored with the completed cache entry. |
| `quickSurfaceMode` | `'inline' \| 'overlay'` = `'inline'` | Which surface an inline-reply feature currently occupies. |
| `quickInlineVisible` | `false` | Whether the inline quick panel is visible. |
| `quickSurfaceEverOpened` | `false` | Whether the inline surface auto-opened during this op (prevents re-opening after user close). |
| `pendingLoadingFrame` | `number \| null` | `requestAnimationFrame` handle used to coalesce loading re-renders. |
| `suppressedTerminalOpIds` | `Set<string>` | Op ids whose terminal messages must be swallowed (route changed mid-flight). |
| `activeImproveDraftCacheKey` | `string \| null` | Cache key for draft-requiring features (trimmed draft text). |
| `observedDraftTextarea` | `HTMLTextAreaElement \| null` | Textarea currently observed for `input`/`change`. |
| `hasDraftText` | `false` | Whether the composer has non-empty trimmed text. |
| `deepOverlayModel` | `OverlayViewModel \| null` | Completed/error/cache-hit model for overlay features. |

`handleDraftInput` (`index.ts:170-177`) is a bound arrow: recomputes `hasDraftText` and re-renders the button bar only when it flips.

### 1.4 Controllers wired in field initializers (`index.ts:179-311`)

- `toast = new ToastController()`.
- `port = new PortClient({ onMessage, onDisconnected })`.
  - `onMessage` → `handlePortMessage`.
  - `onDisconnected` (`index.ts:182-197`): shows `extension_reloaded` toast; clears both completed caches; resets `quickInlineVisible`, `comparePanelVisible`, `activeCompareModel`, `pendingCompareFingerprint`, `quickSurfaceMode='inline'`; clears `suppressedTerminalOpIds`; `detachDraftTextareaObserver()`; `clearOperationState(true)`; resets mode/tone; `renderAll()`.
- `buttonBar = new ButtonBar({...})` (`index.ts:199-209`): callbacks `onFeatureClick`→`startFeature(feature,false)`, `onCompareClick`→`startCompare(false)`, `onCompareRestoreClick`→`reopenCompletedCompare()`, `onReplyModeToggle`→`toggleNextFastReplyMode()`, `onToneSelect`→`startTonedReply(tone)`.
- `mappingBanner = new MappingBanner({ onOpenSettings: browser.runtime.openOptionsPage })`.
- `root = document.createElement('div')` — `id = 'chatgoose-root'`; children appended in constructor: `inlinePanel.root`, `buttonBar.root`, `mappingBanner.root`.
- `mountController = new ConversationMountController(this.root)` (built in constructor, `index.ts:316`).
- `completedOverlayCache = new CompletedOverlayCache()`, `completedCompareCache = new CompletedCompareCache()`.
- `inlinePanel = new InlinePanelController({...})` (`index.ts:219-270`): callbacks `onClose`, `onExpand` (switch quick surface to overlay), `onCancel` (sends `compare:cancel` or `operation:cancel`), `onRerun(feature)`, `onCompareRerun`, `onCompareTabSelect(cardId)`.
- `overlay = new OverlayController({...})` (`index.ts:271-301`): `onClose`, `onCancel` (sends `operation:cancel`), `onRerun`, `onCollapse` (switch overlay→inline).
- `hotkeyBindings = buildHotkeyBindings(detectLabelPlatform())`; `keymap = createKeymap(this.hotkeyBindings)`; `cheatsheet = new CheatsheetController(this.hotkeyBindings)`.
- `board = new SpendersBoardController({ fetchList, openChat })` (`index.ts:306-310`): `fetchList(refresh)` → `sendRuntimeRequest('getSpendersList', refresh ? {refresh:true} : undefined)`; `openChat(groupId)` → `this.openFanChat(groupId)`.
- `launcher = new BoardLauncher(() => this.board.toggle())`.

### 1.5 Hotkeys (`index.ts:353-432`)

- `installKeymap()` adds a `document` `keydown` listener. Ignores `event.repeat`. Builds a resolve request `{ key, metaKey, ctrlKey, altKey, shiftKey, inEditable: isEditableElement(document.activeElement) }` and calls `keymap.resolve(...)`. If a `HotkeyAction` resolves and `dispatchHotkey(action)` returns `true`, calls `event.preventDefault()` (only then — an inapplicable AI key with no open conversation does not swallow a browser default).
- `dispatchHotkey(action)`:
  - If `HOTKEY_FEATURE[action]` maps to a `FeatureType`: returns `false` when `!currentGroupId`; else `startFeature(feature,false)` and returns `true`.
  - `'cycle-tone'` → `cycleNextReplyTone()`; `'cancel'` → `cancelActiveOperation()`; `'spenders-board'` → `board.toggle()`; `'cheatsheet'` → `cheatsheet.toggle()`; default `false`.
- Binding combos come from `../shared/hotkeys.ts` `AI_HOTKEYS`: fast-reply=E, improve-draft=F, help-me=H, hi-greeting=G, ping=D, fan-summary=S, chat-review=V, cycle-tone=O, cancel=X, spenders-board=M (all `mod+shift+<letter>` on mac / `alt+shift+<letter>` elsewhere), plus cheatsheet=`?`.
- `cycleNextReplyTone()` (`index.ts:399-407`): no-op if a feature or compare op is active; cycles `nextReplyTone` through `['none','flirty','upsell','spicy']` and re-renders the bar. Comment notes the bar pills read Flirty/Upsell/Horny (`'spicy'` surfaces as "Horny"); `'casual'` is intentionally not in the cycle.
- `cancelActiveOperation()` (`index.ts:409-432`): if a compare op is in flight → send `compare:cancel`, clear compare state, `renderAll()`. Else if a single op is active → send `operation:cancel`, hide quick inline, `clearOperationState(true)`, and (for overlay features only) reset mode/tone, `renderAll()`.
- `openFanChat(groupId)` (`index.ts:434-437`): `board.close()` then `window.location.assign(\`/messages/${groupId}\`)` — a full same-tab SPA navigation.

### 1.6 Surface rendering (`index.ts:441-533`)

- `renderButtonBar()` — calls `syncDraftTextareaObserver()` then `buttonBar.render(tabState, activeAction, nextFastReplyMode, nextReplyTone, hasDraftText, activeLoading, hasRestorableCompletedCompare())`. `activeAction` = `'compare'` if a compare op is live, else `activeFeature`.
- `renderAll()` = `renderSurfaces()` + `renderButtonBar()`.
- `renderSurfaces()` (`index.ts:467-490`): cancels any scheduled loading frame; **captures a scroll snapshot of `this.root`** (`captureScrollSnapshot`), computes a `SurfacePlan` via `planSurfaces({...})` with the current state, applies it, and in a `finally` restores scroll with `applyScrollCompensation(this.root, snapshot)`. This wraps every surface mutation so growing the panel does not scroll the conversation.
- `getCachedInlineModelForCurrentState()` (`index.ts:492-511`): returns the cached completed inline model for `lastFeature` (only if `quickInlineVisible` and `lastFeature` is inline-surface), keyed with the draft cache key when the feature requires a draft (**reads composer via `getActiveConversationDraftText()`**).
- `applySurfacePlan(plan)` (`index.ts:513-533`): hides/renders inline panel and overlay per plan; honors `plan.overlay.dismissMode`; resets `quickSurfaceMode` to `'inline'` when `plan.resetQuickSurfaceMode`.
- `buildActiveLoadingModel(options)` (`index.ts:535-549`): assembles a `kind:'loading'` `OverlayViewModel` from active op state (feature, fan name, progress, `overlayRawText`, debug prompt, spend, profiling, `operationId`).
- `scheduleLoadingRender()` / `cancelScheduledLoadingRender()` (`index.ts:551-572`): coalesce streamed re-renders into one `requestAnimationFrame`. The frame re-checks `activeOperationId`, compare op id, and `routeNonce` against captured values and aborts the render if any changed (stale-frame guard).

### 1.7 Feature lifecycle — single ops (`index.ts:602-852`)

- `ensureFeatureCanStart(feature)` (`index.ts:602-632`): gate checks against `tabState`. Fails (with a toast) when: no tabState; API key not ready (`isApiKeyReadyForFeature` → `getMissingApiKeyError` toast); `!hasPersonalities` (`no_personalities`); `!mappedPersonalityId` (`no_mapping`); `!connected` (`not_connected`); or a draft-requiring feature with empty composer (warning toast "Write a draft in the composer first, then use Fix." — **reads composer via `computeHasDraftText()`**).
- `isApiKeyReadyForFeature(feature)` (`index.ts:634-639`): reads `tabState.apiKeyReadyByFeature[modelFeature]` (via `resolveFeatureModelFeature`), falling back to `tabState.hasApiKey`.
- `getMissingApiKeyError` / `getCompareMissingApiKeyError` (`index.ts:641-664`): pick provider-specific `missing_api_key` error when `modelProviderByFeature[...] === 'openrouter'`.
- `buildOperationStartPayload(...)` (`index.ts:666-689`): builds the `operation:start` message — `{ type, operationId, feature, groupId: currentGroupId, routeNonce, domFanDisplayName, draftText, forceRegenerate, replyMode (if featureSupportsReplyMode), replyTone (if featureSupportsReplyTone) }`.
- `initializeFeatureOperation(...)` (`index.ts:691-717`): resets active op snapshots, sets `activeFeature`/`activeOperationId`/`activeFanDisplayName` (defaulting to `'fan'`)/`lastFeature`, clears `overlayRawText`, sets `activeImproveDraftCacheKey`, hides compare panel; for inline-surface features hides quick inline and resets `quickSurfaceEverOpened`/`quickSurfaceMode`. Then `renderSurfaces()`.
- **`startFeature(feature, forceRegenerate)`** (`index.ts:771-852`) — the main user-action entry:
  1. If the same feature is already active and inline & non-draft: re-open its quick inline panel if hidden and not suppressed; return.
  2. If another op/compare is running → `another_operation` toast, return.
  3. Clears any lingering compare panel/model.
  4. For draft features: `draftText = getActiveConversationDraftText().trim()` (**DOM read**); computes `improveDraftCacheKey`.
  5. Cache hit (unless forced) → `restoreCachedFeatureResult`, return.
  6. `ensureFeatureCanStart` gate.
  7. `operationId = crypto.randomUUID()`; `domFanDisplayName = getActiveConversationDisplayName()` (**DOM read**); `initializeFeatureOperation(...)`.
  8. `port.send(buildOperationStartPayload(...))`. If `send` returns **false** (port mid-reconnect, message dropped) → `clearOperationState(true)`, `extension_reloaded` toast, re-render, return (no terminal message would arrive).
  9. On success, reset armed mode/tone if the feature supports them; `renderButtonBar()`.
- `restoreCachedFeatureResult(feature, cachedResult)` (`index.ts:584-600`): sets `lastFeature`; draft features with a `reply` model → `applyImproveDraftResult` (**DOM write**); inline features → show quick inline; overlay features → set `deepOverlayModel`; then `renderSurfaces()`.
- `presentCompletedFeature` / `presentOperationError` (`index.ts:719-767`): route a completed/error model to inline panel, overlay, or a toast depending on `usesInlineFeatureSurface`, `quickSurfaceMode`, and `quickInlineVisible`.

### 1.8 Compare / Multi lifecycle (`index.ts:854-957`, `1139-1305`, `1511-1566`)

- **`startCompare(forceRegenerate)`** (`index.ts:854-929`): if a compare op is live, re-open the panel if hidden/not-suppressed and return. Gate: `another_operation` if a single feature is active; require `tabState`, `isApiKeyReadyForFeature('fast-reply')`, `connected`, and `tabState.compareCardCount >= 2` (`compare_cards_unavailable` otherwise). Computes `fingerprint = await computeCompareFingerprint()`, mints `operationId`, reads `getActiveConversationDisplayName()` (**DOM read**), clears completed-compare cache, seeds `pendingCompareFingerprint` and a fresh `activeCompareModel` (`kind:'compare'`, empty tabs). Sends `compare:start` `{ type, operationId, groupId, routeNonce, domFanDisplayName, forceRegenerate, replyMode: nextFastReplyMode, replyTone: nextReplyTone }`. If `send` returns false → tear down pending compare, `extension_reloaded` toast. On success resets mode/tone.
- `reopenCompletedCompare()` / `restoreCompletedComparePanel()` / `restoreCompletedComparePanelInternal(notifyOnStale)` (`index.ts:931-933`, `1523-1566`): reload the cached completed compare model, but **re-validate its `fingerprint`** against a freshly computed one (`computeCompareFingerprint`). On mismatch: clear cache, optionally toast "Saved compare is outdated. Run Compare again."; on match: restore `activeCompareModel` and show panel.
- `hasRestorableCompletedCompare()` (`index.ts:1527-1534`): true when no active feature/compare/panel and the completed-compare cache holds an entry for `currentGroupId`.
- Compare Port handlers: `handleCompareReady` (build tabs from `message.cards`), `handleCompareProgress`, `handleCompareChunk` (append per-card `rawText`), `handleCompareCardComplete` (finalize a card's parts via `resultPartTexts('fast-reply', …)`; empty → error `ai_output_unusable`), `handleCompareCardError`, `handleCompareComplete` (freeze model to `operationId:null`, store in `completedCompareCache` with `pendingCompareFingerprint`), `handleCompareTerminal` (`compare:error`/`compare:discarded` → drop model, clear cache, toast on error). Each first consults `activeCompareFor(operationId)`/`findCompareTab(...)` so messages for a stale op are ignored, and consults `consumeSuppressedTerminalOperation` for suppressed terminals.

### 1.9 Reply mode & tone (`index.ts:935-957`)

- `toggleNextFastReplyMode()` — toggles `nextFastReplyMode` between `'preferSplit'`/`'default'` (no-op while an op is active).
- `resetNextFastReplyMode()` → `'default'`; `resetNextReplyTone()` → `'none'`.
- `startTonedReply(tone)` — arms `nextReplyTone` then immediately `startFeature('fast-reply', false)`; `startFeature`'s payload reads the tone and resets it afterward.

### 1.10 Route handling (`index.ts:961-1020`)

**`handleRouteChange(groupId)`** is the callback given to `startRouteWatcher`. On every call:
1. Compute `changed = currentGroupId !== groupId`; capture `previousGroupId`.
2. **`routeNonce += 1`** (the nonce is bumped here, not in `route-watcher.ts`).
3. Set `currentGroupId = groupId`; update both caches' active group (`completedOverlayCache.setActiveGroup`, `completedCompareCache.setActiveGroup`); `mountController.setActiveRoute(groupId)`.
4. If `changed`, tear down in-flight work per surface kind (`index.ts:970-1010`):
   - inline feature in flight → hide quick inline, reset mode, **`suppressTerminalOperation(activeOperationId)`**, `clearOperationState(true)`.
   - compare op in flight → hide panel, suppress its terminal, drop model, clear `previousGroupId`'s compare cache.
   - overlay feature in flight → suppress terminal (so the previous fan's result is neither shown over the new chat nor cached under the new group), `clearOperationState(true)`.
   - nothing active → clear quick/compare/deep-overlay state.
5. First route change ever → send `tab:init { groupId, routeNonce }` and set `hasSentInit=true`; otherwise send `tab:routeChanged { groupId, routeNonce }`.
6. `renderButtonBar()`.

### 1.11 Port message dispatch (`index.ts:1024-1421`)

`handlePortMessage(message: BackgroundPortMessage)` switches on `message.type`:

| Incoming `type` | Handler | Effect summary |
|---|---|---|
| `tab:state` / `settings:changed` / `mapping:changed` | inline | `tabState = message.state`; `mappingBanner.render(accountId, hasMapping)`; `renderButtonBar()`. |
| `summary:syncStatus` | `handleSummarySyncStatus` | If `groupId===currentGroupId`, apply sync status to cached + visible fan-summary models; `state==='failed'` → warning toast (`hub_sync_failed`, deduped per group+generatedAt). |
| `operation:progress` | `handleProgress` | Guards on op id; stores spend/profiling/progress; may auto-open inline surface; `scheduleLoadingRender()`. |
| `compare:ready` | `handleCompareReady` | Build tabs, show panel. |
| `compare:progress` | `handleCompareProgress` | Update progress; scheduled render. |
| `compare:chunk` | `handleCompareChunk` | Append per-card streamed text. |
| `compare:cardComplete` | `handleCompareCardComplete` | Finalize a card. |
| `compare:cardError` | `handleCompareCardError` | Mark a card errored. |
| `compare:complete` | `handleCompareComplete` | Freeze + cache compare. |
| `compare:error` / `compare:discarded` | `handleCompareTerminal` | Drop model, toast on error. |
| `operation:debugPrompt` | `handleDebugPrompt` | Store `activeDebugPrompt`; scheduled render. |
| `operation:chunk` | `handleChunk` | Append to `overlayRawText`; auto-open inline for inline features; scheduled render (skipped body for draft features — see below). |
| `operation:complete` | `handleComplete` | Build completed model, cache it, present. |
| `operation:error` / `operation:discarded` | `handleOperationError` | Build error model, present, or toast if not the active op. |

- `handleChunk(operationId, text)` (`index.ts:1315-1340`): ignores non-active op; appends to `overlayRawText`; for draft-requiring features returns early (no live surface — draft results are inserted into the composer on completion, not streamed); for inline features auto-opens quick inline on first chunk (when `quickSurfaceMode==='inline'`); else scheduled render.
- `handleComplete(message)` (`index.ts:1342-1385`): consumes suppressed terminal ids first (tear down silently); ignores mismatched op; builds `completedModel` via `buildCompletedOverlayModel`; if `feature==='fan-summary'` sets `tabState.hasAvailableSummary=true`; writes to `completedOverlayCache` (with the draft cache key for draft features); then `presentCompletedFeature`.
- `handleOperationError` (`index.ts:1387-1421`): consumes suppressed ids; if it's the active op, builds a `kind:'error'` overlay model and `presentOperationError`; otherwise surfaces a toast.

### 1.12 Suppression & state helpers (`index.ts:1425-1509`)

- `suppressTerminalOperation` / `isTerminalOperationSuppressed` / `consumeSuppressedTerminalOperation` — the `Set<string>` guard that lets a route change drop a still-arriving terminal message for the previous conversation.
- `clearOperationState(fullReset)` — nulls the active-op snapshot fields; `fullReset` additionally clears `activeDebugPrompt` and `deepOverlayModel`.
- `currentFanDisplayName()` → `activeFanDisplayName ?? 'fan'`.
- `computeHasDraftText()` → `getActiveConversationDraftText().trim().length > 0` (**DOM read**).
- `buildImproveDraftCacheKey(draftText)` → trimmed text or null (the cache key for draft-requiring features is the draft text itself).
- `applyImproveDraftResult(model)` (`index.ts:1466-1489`): the draft-improve path — computes `nextText` from `model.parts[0].text` (fallback rawText) and **`await insertIntoFanslyTextarea(nextText)`** (DOM write). On success marks the part inserted, hides quick inline. On failure (`insertion_failed`) re-shows the inline panel and toasts the error.
- `detachDraftTextareaObserver()` / `syncDraftTextareaObserver()` (`index.ts:1491-1509`): keep `input`/`change` listeners bound to the **current** composer textarea (via `findActiveConversationTextarea()` — DOM read), re-binding when the element identity changes, and recompute `hasDraftText`.
- `computeCompareFingerprint()` (`index.ts:1511-1521`): `await loadStorageState()` (**storage read**), then `getCompareCardsFingerprintForPersonality(storage, tabState.mappedPersonalityId)`.

### 1.13 Completed-model construction (`index.ts:1568-1646`)

`buildCompletedOverlayModel(feature, operationId, fanDisplayName, result, llmSpend?, profiling?)` builds a `CompletedOverlayViewModel` keyed on `getFeaturePolicy(feature).resultKind`: `help-me` → `kind:'helpMe'` (coaching + engaging/flirty parts, `parseFallback`); `summary` → `kind:'readOnly'` fan-summary with `summaryMeta`; `chat-review` → `kind:'readOnly'` with `reviewMeta` (rating/evaluation/recommendations/parseFallback); default → `kind:'reply'` with `parts` from `resultPartTexts`, `splitModeRequested`, and an `ai_output_unusable` error attached when no parts survived.

---

## 2. `src/content/route-watcher.ts` — SPA route polling

- Imports `ROUTE_POLL_INTERVAL_MS` (= **500** ms) from `../shared/constants.js`.
- Called by `index.ts:346` (`startRouteWatcher(handleRouteChange)`).
- **`parseGroupIdFromPath(pathname): string | null`** — regex `/^\/messages\/([^/?#]+)/` on `pathname`; returns the first path segment after `/messages/`, else `null`. Any URL not under `/messages/…` yields `null` (the "no conversation open" state).
- **`startRouteWatcher(onChange)`**: computes the initial groupId from `window.location.pathname`, **calls `onChange` synchronously once**, then `window.setInterval(...)` every 500 ms re-reads `window.location.pathname`, and calls `onChange(nextGroupId)` only when the parsed groupId differs from the last one. Returns a disposer that clears the interval.
- Mechanism note: this is pure polling of `window.location` — it does **not** hook `history.pushState`/`popstate`; SPA navigations are detected within one 500 ms poll. It tracks only the `/messages/:groupId` segment; query/hash changes and non-messages routes are collapsed to their groupId (or `null`).
- **Discrepancy vs. assignment description:** the assignment attributes "routeNonce bumping, tab:init/tab:routeChanged emission" to this file. In the actual code, `route-watcher.ts` only polls and reports the groupId; `routeNonce` bumping and `tab:init`/`tab:routeChanged` sends live in `index.ts:handleRouteChange` (§1.10).

---

## 3. `src/content/conversation-mount-controller.ts` — attaching the UI root

Keeps `this.root` (the `#chatgoose-root` element) inserted immediately before the Fansly composer host, and re-anchors it when Angular rebuilds the subtree.

- Imports `CONVERSATION_ATTACH_RETRY_MS` (**50** ms), `CONVERSATION_ATTACH_SLOW_RETRY_MS` (**2000** ms), `CONVERSATION_ATTACH_TIMEOUT_MS` (**10000** ms) from constants; `getActiveConversationDom` / `ActiveConversationDom` from `./conversation-dom.js`.
- Constructed by `index.ts:316` as `new ConversationMountController(this.root)`. The DOM resolver defaults to `getActiveConversationDom` but is injectable (`ConversationDomResolver`).

State: `activeGroupId`, `sessionId` (monotonic; bumped on every route/attach change so stale timers/observers no-op), `retryTimer`, `retryDeadlineMs`, `stopObserver`, and mounted anchors `mountedInputHost` / `mountedRouteRoot` / `mountedObservationRoot`.

Methods:
- `setActiveRoute(groupId)` (`26-43`): stores groupId, bumps `sessionId`, resets mount state, detaches root. If `groupId` is null → stay detached. Else `detachRoot()`, try `syncNow()` immediately; if that fails, set `retryDeadlineMs = Date.now()+10000` and `scheduleRetry`.
- `syncNow()` (`45-57`): resolves the conversation DOM; if found, `attach(...)` and return true.
- `detach()` / `destroy()` (`59-68`): clear group, bump session, reset, detach root.
- `attach(conversation, sessionId)` (`70-81`): inserts `this.root` before `conversation.inputHost` inside `conversation.inputParent` (only if not already positioned there); records mounted anchors; **`mountedObservationRoot` = `routeRoot.parentElement` if it's an HTMLElement, else `routeRoot`**; clears retry; starts the MutationObserver.
- `handleObservedChange(sessionId)` (`83-104`): ignores stale sessions; if `isAnchorValid()` still holds, no-op; otherwise stop observing, drop anchors, detach root, try `syncNow()`, else reschedule with a fresh 10 s deadline.
- `isAnchorValid()` (`106-116`): true only when groupId set, `root.isConnected`, all three mounted anchors `.isConnected`, `root.parentElement === mountedInputHost.parentElement`, and `root.nextSibling === mountedInputHost` (i.e. the root is still the immediate previous sibling of the composer host).
- `scheduleRetry(sessionId)` (`118-145`): single pending timer. **Cadence**: while `Date.now() < retryDeadlineMs` uses the fast 50 ms interval; once the 10 s window lapses it falls back to the slow 2000 ms interval and **keeps polling indefinitely** until the conversation is re-discovered or the route changes (it never gives up and leaves the UI detached). On each tick: bail if session changed or no group; `syncNow()`; else reschedule.
- `startObserver(sessionId)` (`147-177`): a `MutationObserver` on `mountedObservationRoot` with `{ childList:true, subtree:true }`. Callbacks are debounced through a single `setTimeout(…, 0)` (`pending` flag) into `handleObservedChange`. `stopObserver` disconnects and clears the pending timer.
- `resetMountState` / `stopObserving` / `clearRetry` / `detachRoot` (`179-202`): housekeeping; `detachRoot()` = `this.root.remove()`.

Boundary: reads DOM only through the injected resolver (`conversation-dom.ts`); mutates DOM by inserting/removing `#chatgoose-root` relative to `app-group-message-input`.

---

## 4. `src/content/conversation-dom.ts` — **Fansly-DOM READ boundary**

The single module that knows Fansly's conversation DOM structure. Exported `ActiveConversationDom` interface: `{ routeRoot, container, inputHost, inputParent, displayName }`.

### 4.1 Selector / heuristic contract (exact strings)

| Constant | Value | Purpose |
|---|---|---|
| `ROUTE_ROOT_SELECTOR` | `app-messages-conversation-route` | The active-conversation route element (query on `document`). |
| `INPUT_HOST_SELECTOR` | `app-group-message-input` | The composer host inside the route root. |
| `USER_NAME_SELECTOR` | `app-account-username .user-name` | Element holding the fan's `@handle`/name in the header. |
| `COMPOSER_LABEL_SELECTOR` | `app-group-message-input .label` | Fallback text source for the display name. |
| `TEXTAREA_SELECTORS` | `['app-group-message-input textarea', 'textarea.message-input', 'textarea[placeholder*="message"]']` | Ordered candidates for the composer `<textarea>`. |
| (in `getActiveConversationDom`) | `app-group-message-container` | `inputHost.closest(...)` — the container scoping textarea search. |

### 4.2 Functions

- `getActiveConversationRouteRoot()` (`19-22`): `document.querySelector('app-messages-conversation-route')`; returns it only if an `HTMLElement`.
- `parseDisplayName(text)` (`24-27`): regex `/@([^\s]+)/` → the first `@handle` (without the `@`). If no `@`, falls back to `text` with a leading `Message ` (case-insensitive `^Message\s+`) stripped and trimmed; empty → `null`.
- `getDirectTextContent(element)` (`29-35`): joins only **direct** child text nodes (`nodeType === Node.TEXT_NODE`) with spaces and trims — deliberately ignores nested element text.
- `resolveDisplayName(routeRoot)` (`37-57`): tries `USER_NAME_SELECTOR`'s direct text first → `parseDisplayName`; else falls back to `COMPOSER_LABEL_SELECTOR`'s full `textContent` → `parseDisplayName`; else `null`.
- `isUsableTextarea(element)` (`59-66`): type guard — `HTMLTextAreaElement` **and** `!disabled` **and** `!readOnly` **and** `offsetParent !== null` (i.e. currently rendered/visible).
- **`getActiveConversationDom()`** (`68-91`): returns `null` unless: route root exists; `INPUT_HOST_SELECTOR` matches an `HTMLElement` with a `parentElement`; and `inputHost.closest('app-group-message-container')` is an `HTMLElement`. On success returns `{ routeRoot, container, inputHost, inputParent: inputHost.parentElement, displayName: resolveDisplayName(routeRoot) }`.
- `getActiveConversationDisplayName()` (`93-100`): route root → `resolveDisplayName`; used by `index.ts` at op start to stamp `domFanDisplayName`.
- **`findActiveConversationTextarea()`** (`102-116`): resolves the conversation DOM, then iterates `TEXTAREA_SELECTORS` **scoped to `conversation.container`** (`app-group-message-container`), returning the first `isUsableTextarea` match, else `null`.

Called by: `conversation-mount-controller.ts` (`getActiveConversationDom`), `textarea.ts` (`findActiveConversationTextarea`), `index.ts` (`getActiveConversationDisplayName`, `findActiveConversationTextarea`).

---

## 5. `src/content/textarea.ts` — **Fansly-DOM WRITE boundary**

Imports `ChatGooseError` (`../shared/errors.js`) and `findActiveConversationTextarea` (`./conversation-dom.js`). All four functions operate on the composer textarea resolved by `findActiveConversationTextarea()`.

- `copyToClipboard(text)` (`4-6`): `await navigator.clipboard.writeText(text)` — **browser clipboard API** (not the Fansly DOM). Note: exported but not referenced from the files in this map (used by the UI-surface controllers).
- `focusActiveConversationTextarea()` (`8-22`): finds the textarea (or returns `null`), `.focus()`, then `setSelectionRange(end, end)` inside a try/catch (keeps focus even if the browser rejects manual selection). Returns the element.
- `getActiveConversationDraftText()` (`24-26`): returns `findActiveConversationTextarea()?.value ?? ''` — the **draft read** used across `index.ts` for `hasDraftText`, cache keys, and the draft-improve payload.
- **`insertIntoFanslyTextarea(text)`** (`28-49`) — the write path:
  1. Resolve textarea; if none → throw `ChatGooseError('insertion_failed')`.
  2. `.focus()` then `.select()` (select-all so the insert replaces existing content).
  3. Primary path: `document.execCommand('insertText', false, text)`. If it returns truthy **and** `textarea.value === text`, return (this dispatches native `input` events Angular listens to).
  4. Fallback: set `textarea.value = text`, then dispatch a synthetic `new Event('input', { bubbles:true })` and `new Event('change', { bubbles:true })` so the Fansly (Angular) model syncs.
  5. If after the fallback `textarea.value !== text` → throw `ChatGooseError('insertion_failed')`.

Called by: `index.ts` (`getActiveConversationDraftText`, `insertIntoFanslyTextarea`). `focusActiveConversationTextarea`/`copyToClipboard` are used by other UI controllers outside this map.

---

## 6. `src/content/dom-anchor.ts` — injected style & root elements

Creates the extension's own DOM anchors (not Fansly's). No imports.

- `ensureStyles(stylesText)` (private, `1-10`): if `#chatgoose-style` already exists, no-op; else create `<style id="chatgoose-style">` with `textContent = stylesText` and append to `document.head`.
- `installContentStyles(stylesText)` (`12-14`): thin wrapper over `ensureStyles`; called once by `index.ts:344`.
- `ensureOverlayRoot()` (`16-24`): idempotently create/return `<div id="chatgoose-overlay-root">` appended to `document.body`.
- `ensureToastRoot()` (`26-34`): idempotently create/return `<div id="chatgoose-toast-root">` appended to `document.body`.

Injected element IDs (browser DOM): `chatgoose-style`, `chatgoose-overlay-root`, `chatgoose-toast-root` (plus `chatgoose-root` created in `index.ts` and `chatgoose-toast-root` consumed by `toast.ts`). Called by: `index.ts` (`installContentStyles`), `toast.ts` (`ensureToastRoot`); `ensureOverlayRoot` is used by the overlay controller.

---

## 7. `src/content/surface-planner.ts` — pure surface decision

A pure function (no DOM, no side effects) mapping current UI state to which surface (overlay vs inline) should render what. Imports `usesInlineFeatureSurface`/`usesOverlayFeatureSurface` (`../shared/features.js`) and view-model types.

- Types: `QuickSurfaceMode = 'inline' | 'overlay'`; `OverlaySurfacePlan` (`hidden` | `render` with optional `dismissMode:'collapse-to-inline'`); `InlineSurfacePlan` (`hidden` | `render`); `SurfacePlannerInput` (10 fields mirroring `index.ts` state); `SurfacePlan { overlay, inline, resetQuickSurfaceMode }`.
- Helpers `hiddenPlan`/`overlayPlan`/`inlinePlan` build the three plan shapes.
- **`planSurfaces(input)`** (`74-115`) — priority order:
  1. Active overlay feature + `activeLoadingModel` → overlay renders loading.
  2. Active inline feature + `activeRegenerableLoadingModel`: if `quickSurfaceMode==='overlay'` → overlay (`collapse-to-inline`); else inline if `quickInlineVisible`, else hidden.
  3. `comparePanelVisible && activeCompareModel` → inline renders the compare model.
  4. `quickInlineVisible && cachedInlineModel` → overlay (`collapse-to-inline`) if mode is overlay, else inline.
  5. `deepOverlayModel` → overlay.
  6. Otherwise hidden; `resetQuickSurfaceMode` true iff `quickSurfaceMode==='overlay'`.

Called by: `index.ts:renderSurfaces` (`472`).

---

## 8. `src/content/scroll-compensation.ts` — scroll preservation

Prevents the conversation list from jumping when the extension panel grows/shrinks. No imports. Module-level cache: `cachedRoot` / `cachedContainer`.

- Constants: `NEAR_BOTTOM_THRESHOLD_PX = 96`, `MIN_HEIGHT_DELTA_PX = 1`, `SHOW_ELEMENT = 1`, `DOCUMENT_POSITION_DISCONNECTED = 1`.
- `ScrollSnapshot` interface: `{ container, maxScrollBefore, bottomGapBefore, rootHeightBefore }`.
- Scrollability predicates (`16-38`): `isOverflowScrollable` (`auto`/`scroll`/`overlay`); `scrollGap = scrollHeight - clientHeight`; `isScrollableElement` (scrollable overflow **and** currently overflowing); `isPotentialScrollContainer` (scrollable overflow **and** `clientHeight > 0`, i.e. visible but maybe not yet overflowing).
- Generic search helpers (`45-99`): `findAncestorBy`, `findBestInSubtreeBy` (uses `document.createTreeWalker(root, SHOW_ELEMENT)` and a scoring function), `findInSiblingBranchesBy` (walk previous/next siblings, best-in-subtree per branch).
- Cache validity (`103-122`): `isCachedContainerValid` requires same root, both connected, same `ownerDocument`, not `DOCUMENT_POSITION_DISCONNECTED`, and container still a potential scroll container. `setCache`/`clearCache` manage the module-level pair.
- **`findScrollContainer(seed)`** (`126-181`) — discovery order: (1) nearest scrollable **ancestor**; (2) level-by-level sibling search interleaving currently-scrollable (scored by `scrollGap`) then potential containers (scored by `clientHeight`); (3) potential **ancestor** (checked after siblings so `body`/`html` don't shadow a real sibling); (4) fallback to `document.scrollingElement` (**not cached**, so a later-rendered real container is re-searched). Results from 1–3 are cached.
- **`captureScrollSnapshot(root)`** (`185-196`): returns `null` if `root` disconnected or no container; else records `maxScrollBefore`, `bottomGapBefore` (distance from bottom), `rootHeightBefore = root.offsetHeight`.
- **`applyScrollCompensation(root, snapshot)`** (`198-225`): no-op if snapshot null, root/container disconnected, or the user was scrolled up (`bottomGapBefore > 96px`). Computes `delta = maxScrollAfter - maxScrollBefore`; if the container's own layout didn't change (`delta < 1`), falls back to the **root height delta** (`root.offsetHeight - rootHeightBefore`) — this handles the case where the panel lives in a separate DOM branch from the scroll container. If a positive delta remains, adds it to `container.scrollTop` (clamped to `maxScrollAfter`).

Called by: `index.ts:renderSurfaces` — `captureScrollSnapshot(this.root)` before applying the plan and `applyScrollCompensation(this.root, snapshot)` in `finally`.

---

## 9. `src/content/port-client.ts` — the long-lived Port

Wraps the `browser.runtime.Port` between content and background with reconnect and init-replay. Imports `PORT_RECONNECT_DELAYS_MS` (= **[100, 200, 400]** ms), `isBackgroundPortMessage` (`../shared/protocol.js`), and message types.

- `PortClientCallbacks`: `{ onMessage(BackgroundPortMessage), onDisconnected() }`.
- State: `port` (or null), `reconnectTimer`, `reconnectAttempt`, `lastInit` (the last `tab:init` message, kept for replay).
- **`connect()`** (`18-39`): no-op if already connected. `browser.runtime.connect({ name: 'chatgoose-content' })` — this **port name** is what the background side receives (`background/index.ts:37` `onConnect` → `coordinator.registerPort(port)`; the background does not filter on the name). Adds `onMessage` (guards each message with `isBackgroundPortMessage` before forwarding) and `onDisconnect` (nulls port, fires `onDisconnected`, schedules reconnect). Resets `reconnectAttempt=0` and, if a `lastInit` exists, **replays it** so a reconnected content script re-registers its tab/route.
- `scheduleReconnect()` (private, `41-53`): single pending timer; delay = `PORT_RECONNECT_DELAYS_MS[min(reconnectAttempt, 2)]` (so 100→200→400→400…); increments `reconnectAttempt`; on fire, `connect()`.
- **`send(message: ContentPortMessage): boolean`** (`62-77`): persists `tab:init` into `lastInit`; for `tab:routeChanged` (when a prior `lastInit` exists) updates `lastInit`'s `groupId`/`routeNonce` so the replayed init reflects the current route. If `port` is null (mid-reconnect) returns **`false`** (message dropped). Otherwise `port.postMessage(message)` and returns `true`. Per the doc-comment: dropped `tab:init`/`tab:routeChanged` are recovered via replay, but `operation:start`/`compare:start`/cancels are lost — callers in `index.ts` check the `false` return and surface `extension_reloaded`.

Called by: `index.ts` constructs one `PortClient`; `connect()` in `init()`, `send(...)` throughout, and reacts to `onMessage`/`onDisconnected`.

---

## 10. Boundary summary

### 10.1 Fansly DOM — reads (`conversation-dom.ts`, plus consumers)

| What | Selector / access | Where |
|---|---|---|
| Active route root | `document.querySelector('app-messages-conversation-route')` | `conversation-dom.ts:20` |
| Composer host | `routeRoot.querySelector('app-group-message-input')` | `conversation-dom.ts:74` |
| Container scope | `inputHost.closest('app-group-message-container')` | `conversation-dom.ts:79` |
| Fan display name | `app-account-username .user-name` (direct text) → `@handle` regex; fallback `app-group-message-input .label` | `conversation-dom.ts:11-12,37-57` |
| Composer textarea | `app-group-message-input textarea` → `textarea.message-input` → `textarea[placeholder*="message"]`, scoped to container, must be enabled+visible | `conversation-dom.ts:13-17,102-116` |
| Draft text | `textarea.value` | `textarea.ts:25` (`getActiveConversationDraftText`) |
| Draft change events | `input`/`change` listeners on the live textarea | `index.ts:1500-1507` |
| Scroll container | computed-style `overflow-y` walk from `#chatgoose-root` | `scroll-compensation.ts:126-181` |

### 10.2 Fansly DOM — writes / mutations

| What | Mechanism | Where |
|---|---|---|
| Mount UI root | insert `#chatgoose-root` before `app-group-message-input`; `root.remove()` on detach | `conversation-mount-controller.ts:70-73,201` |
| Insert reply into composer | `.focus()` + `.select()` + `document.execCommand('insertText', …)`, fallback `value=` + synthetic `input`/`change` events; throws `ChatGooseError('insertion_failed')` on failure | `textarea.ts:28-49` |
| Focus composer / set caret | `.focus()` + `setSelectionRange(end,end)` | `textarea.ts:8-22` |
| Adjust scroll offset | `container.scrollTop = …` | `scroll-compensation.ts:221` |
| Inject own DOM anchors | `#chatgoose-style` (head), `#chatgoose-overlay-root`, `#chatgoose-toast-root`, `#chatgoose-root` (body) | `dom-anchor.ts`, `index.ts:314` |
| SPA navigation | `window.location.assign('/messages/<groupId>')` | `index.ts:436` |

### 10.3 IPC — runtime Port (name `chatgoose-content`)

Content → background (`ContentPortMessage`) sent from `index.ts`: `tab:init`, `tab:routeChanged`, `operation:start`, `operation:cancel`, `compare:start`, `compare:cancel`.

Background → content (`BackgroundPortMessage`) handled in `handlePortMessage`: `tab:state`, `settings:changed`, `mapping:changed`, `summary:syncStatus`, `operation:progress`, `operation:chunk`, `operation:complete`, `operation:error`, `operation:discarded`, `operation:debugPrompt`, `compare:ready`, `compare:progress`, `compare:chunk`, `compare:cardComplete`, `compare:cardError`, `compare:complete`, `compare:error`, `compare:discarded`.

### 10.4 IPC — one-shot runtime request

`sendRuntimeRequest('getSpendersList', refresh ? { refresh:true } : undefined)` — `index.ts:307-308` (via `SpendersBoardController.fetchList`).

### 10.5 Storage

`loadStorageState()` (`browser.storage.local`) in `computeCompareFingerprint` (`index.ts:1516`) to fingerprint compare cards for the mapped personality.

### 10.6 Browser APIs

- `browser.runtime.connect({ name:'chatgoose-content' })` / Port messaging (`port-client.ts`).
- `browser.runtime.openOptionsPage()` (`index.ts:212,337` — mapping banner & error "Settings" action).
- `navigator.clipboard.writeText` (`textarea.ts:5`).
- `crypto.randomUUID()` for operation ids (`index.ts:817,888`).
- `requestAnimationFrame`/`cancelAnimationFrame`, `window.setInterval`/`setTimeout`, `MutationObserver`, `document.createTreeWalker`, `getComputedStyle`, `document.execCommand`.

### 10.7 Distribution / injection

- `manifest.json:27-37` — content script matches `*://fansly.com/*`, `content.js`, `run_at:document_idle`.
- Runtime host guard `hostname.endsWith('fansly.com')` (`index.ts:1649`).

---

## 11. Constants used (from `src/shared/constants.ts`)

| Constant | Value | File | Effect |
|---|---|---|---|
| `ROUTE_POLL_INTERVAL_MS` | 500 ms | route-watcher | Location poll cadence. |
| `CONVERSATION_ATTACH_RETRY_MS` | 50 ms | mount-controller | Fast attach retry within the window. |
| `CONVERSATION_ATTACH_SLOW_RETRY_MS` | 2000 ms | mount-controller | Slow retry after the window lapses (runs indefinitely). |
| `CONVERSATION_ATTACH_TIMEOUT_MS` | 10000 ms | mount-controller | Fast-retry window length. |
| `PORT_RECONNECT_DELAYS_MS` | [100,200,400] ms | port-client | Reconnect backoff (last value repeats). |
| `NEAR_BOTTOM_THRESHOLD_PX` | 96 | scroll-compensation | Only compensate when within 96px of bottom. |
| `MIN_HEIGHT_DELTA_PX` | 1 | scroll-compensation | Minimum delta to act on. |

---

## 12. Discrepancies & notes for the reviewer

1. **`routeNonce` / init emission location.** The assignment brief attributes `routeNonce` bumping and `tab:init`/`tab:routeChanged` emission to `route-watcher.ts`; the code puts routeNonce and all Port emission in `index.ts:handleRouteChange` (§1.10). `route-watcher.ts` only polls and reports the groupId.
2. **Host match vs. runtime guard mismatch.** Manifest `matches` is `*://fansly.com/*` (exact host); the runtime guard `hostname.endsWith('fansly.com')` (`index.ts:1649`) is broader (would admit subdomains). The manifest is the effective gate.
3. **Port name is unenforced on the background side.** Content connects with `name:'chatgoose-content'`, but `background/index.ts:37` registers any connecting port without checking `port.name`.
4. **Dropped non-init messages are silently lossy at the transport layer.** `PortClient.send` returns `false` mid-reconnect and only `tab:init`/`tab:routeChanged` are replayed; `index.ts` compensates for `operation:start`/`compare:start` by checking the boolean and tearing down + toasting, but `operation:cancel`/`compare:cancel`/`compare:cancel` sent while disconnected are dropped without a caller-side check (e.g. `inlinePanel.onCancel`, `cancelActiveOperation`).
5. **Fallback scroll container is `document.scrollingElement` and deliberately uncached** (`scroll-compensation.ts:176-180`) — so early renders before Angular finishes may compensate against the document root until a real container appears.
6. **`insertIntoFanslyTextarea` replaces the entire composer** (it `.select()`s all before inserting), it does not append at the caret — relevant to how draft-improve overwrites the user's text.
7. **Display-name parsing is `@handle`-first** (`parseDisplayName` regex `/@([^\s]+)/`), with a `Message `-prefix-stripping fallback; a header without an `@handle` yields the stripped label text or `null`.
8. **`copyToClipboard` and `focusActiveConversationTextarea` are exported from `textarea.ts` but not referenced by any file in this map's set** — they are consumed by the UI-surface controllers (overlay/inline panels) outside this file group.
