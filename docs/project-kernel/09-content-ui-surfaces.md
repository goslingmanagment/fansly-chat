> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Content — UI Surfaces (Toolbar, Overlay, Inline Panel, Toasts)

## Scope

Territory map of every injected content-script UI surface and the DOM/render
helpers they share. Files covered (all under `src/content/`):

- `button-bar.ts` — the composer toolbar.
- `overlay/overlay-controller.ts` — full-screen streaming reply overlay (~1629 lines).
- `overlay/completed-overlay-cache.ts` — per-operation result cache for the overlay.
- `inline-panel/inline-panel-controller.ts` — the compact inline panel + multi-draft compare panel.
- `inline-panel/completed-compare-cache.ts` — completed-compare result cache.
- `cheatsheet-controller.ts` — the `?` keyboard cheatsheet modal.
- `mapping-banner.ts` — the unmapped-account/personality banner.
- `toast.ts` — transient notifications.
- `spend-format.ts` — currency/token/cost formatting for display.
- `ui/kbd.ts` — the `<kbd>` key-cap chip factory.
- `ui/view-helpers.ts` — shared DOM/render/state helpers for reply parts, errors, loading status.
- `styles.css` — all injected CSS (namespaced `chatgoose-`).

These surfaces are **presentational**. None opens a Port or calls
`browser.runtime.sendMessage` directly. Each takes a callbacks object at
construction; the composition root `src/content/index.ts` (class not in scope
here) wires those callbacks to `this.port.send(...)`, `sendRuntimeRequest(...)`,
storage, and `browser.runtime.openOptionsPage()`. The surfaces render from
view-model objects that `index.ts` builds from `BackgroundPortMessage`s. All
mount points, callback→message mappings, and boundary crossings are listed per
file below.

Related maps (do not re-derive): `boundaries.md` for the four network
contracts; `src/content/index.ts` orchestration is covered by the content
coordinator map.

---

## DOM anchors & namespacing (context)

Root elements the surfaces attach to (created lazily by `dom-anchor.ts`, not in
scope but referenced heavily):

| id | created by | z-index (styles.css) | holds |
|---|---|---|---|
| `#chatgoose-root` | `index.ts` constructor | (in-flow, `margin:10px 0 8px`) | inline panel + button bar + mapping banner |
| `#chatgoose-overlay-root` | `dom-anchor.ensureOverlayRoot()` | `2147483646` | overlay shell |
| `#chatgoose-toast-root` | `dom-anchor.ensureToastRoot()` | `2147483645` | toasts |
| `#chatgoose-cheatsheet-root` | `cheatsheet-controller.ensureCheatsheetRoot()` | `2147483647` | cheatsheet modal |
| `#chatgoose-board-root` | (spenders board, not in scope) | `2147483646` | — |
| `#chatgoose-launcher-root` | (launcher, not in scope) | `2147483644` | — |
| `#chatgoose-style` | `dom-anchor.ensureStyles()` | — | `<style>` with all of `styles.css` |

**Namespacing.** Every injected class and id is prefixed `chatgoose-` /
`chatgoose` (see `styles.css` header comment, lines 1–5). `.chatgoose-hidden`
(`display:none !important`) is the universal show/hide toggle. The constants
`CHATGOOSE_NAMESPACE = 'chatgoose'` and `OVERLAY_Z_INDEX = 2147483646` exist in
`src/shared/constants.ts:162-163` **but are never imported anywhere** — the CSS
and TS both hardcode the `chatgoose-` prefix and the numeric z-indexes as
literals. Flag: the constants are dead; the map between them and the actual
values is by convention only, and `styles.css` `#chatgoose-overlay-root` z-index
(`2147483646`) happens to equal `OVERLAY_Z_INDEX` but does not reference it.

---

## `button-bar.ts` — the composer toolbar

Renders `class ButtonBar`. Root `<div class="chatgoose-bar chatgoose-toolbar">`
exposed as `readonly root` and mounted by `index.ts` into `#chatgoose-root`
between the inline panel and the mapping banner (`index.ts:315`).

### Imports / callers
- Imports `comboLabel`, `detectLabelPlatform`, `featureHotkeyLabel` from `../shared/hotkeys.js`; `makeKbd` from `./ui/kbd.js`; types `FeatureType, ReplyMode, ReplyTone, TabUiState`.
- Instantiated at `index.ts:199`; `render(...)` driven by `index.ts` `renderButtonBar()` (`index.ts:441-460`).

### What it actually renders (vs. the assignment description)
The row appended to `this.root` (`button-bar.ts:128-137`), left→right:

1. **Reply** — `fast-reply`, primary style (`chatgoose-toolbar-button-primary`).
2. **Multi** toggle — the `replyModeToggle` pill.
3. **Polish** — `improve-draft`.
4. **Tone row** — the three tone pills.
5. **Hi** — `hi-greeting`.
6. **Ping** — `ping`.
7. **Scan** — `fan-summary` (`chatgoose-toolbar-button-summary`).
8. **Personality pill** — pinned right (`chatgoose-toolbar-personality-end`).

Discrepancies to flag against the assignment brief and the class comments:
- Feature set is **Reply / Polish / Hi / Ping / Scan only**. `TOOLBAR_FEATURES` (`button-bar.ts:9-15`) does **not** include `help-me` or `chat-review`; there are no Help or Review buttons. Labels are `Polish` (not "Fix") and `Scan` (not "Summary"), even though `FEATURE_LABELS` in `constants.ts` maps `improve-draft→'Fix'` and `fan-summary→'Summary'`.
- **"Multi" is the reply-mode (`preferSplit`) toggle, not the compare toggle.** `replyModeToggle` (`button-bar.ts:93-99`) fires `callbacks.onReplyModeToggle`. The multi-draft *Compare* action is a separate `compareButton` labelled `'Compare'` (`button-bar.ts:76-81`) that is created and stored in the `buttons` map **but never appended to `this.root`** — it is invisible; `onCompareClick` is unreachable from the bar.
- **`compareRestoreButton`** (label `'Reopen'`, `button-bar.ts:83-88`, `onCompareRestoreClick`) is likewise never appended, and `render()` unconditionally force-hides + disables it (`button-bar.ts:222-223`). The `render()` param `showCompareRestore` (`button-bar.ts:181`) is accepted but never read. `index.ts` still passes `hasRestorableCompletedCompare()` into it (`index.ts:458`).
- There is **no `⋯` overflow / Scan menu** in this file. The header comment (`button-bar.ts:7-8`) states "Scan included; no overflow ⋯ menu"; the `⋯` menu appears in git history (commits `d7fba13`, `022764b`) but the current code has none.
- Tone options are **Flirty / Upsell / Horny** only (`TONE_OPTIONS`, `button-bar.ts:21-25`: tones `flirty`/`upsell`/`spicy`). There is no `none`, `casual`, or `spicy`-labelled "Spicy" pill — `spicy` renders as `'Horny'`; `casual` and `none` are intentionally not surfaced (see `index.ts` `cycleNextReplyTone` order `['none','flirty','upsell','spicy']`, `index.ts:403`).

### Constants
- `TOOLBAR_FEATURES` (`:9`) — array of `{feature,label}` for the five visible buttons.
- `TONE_OPTIONS` (`:21`) — `[{flirty,'Flirty'},{upsell,'Upsell'},{spicy,'Horny'}]`.
- `TONE_CYCLE_LETTER = 'O'` (`:29`) — only used to build the tone pills' tooltip via `comboLabel('O', platform)` (e.g. "⌘⇧O cycles tone").

### State held
- `platform` = `detectLabelPlatform()` (mac vs other, drives key labels).
- `personalityLabel: HTMLElement` — the right-pinned pill.
- `replyModeToggle`, `compareRestoreButton`, `toneRow: HTMLElement`.
- `tonePills: Map<Exclude<ReplyTone,'none'>, HTMLButtonElement>`.
- `buttons: Map<ToolbarAction, HTMLButtonElement>` where `ToolbarAction = FeatureType | 'compare'`.

### Construction (`constructor`, `:52-138`)
Builds each feature button via `renderFeatureButton`, sets `title` via
`featureTitle`, wires `click → callbacks.onFeatureClick(feature)`. Reply gets the
primary class; Scan gets `chatgoose-toolbar-button-summary` (reserves space for a
"ready" dot). Tone pills get `aria-pressed="false"`, tooltip `"{label} tone —
{combo} cycles tone"`, and `click → callbacks.onToneSelect(tone)`.

### Methods
- `featureTitle(feature,label)` (`:141`) — `"{label} ({hotkey.full})"` when `featureHotkeyLabel` returns a combo, else just `label`.
- `renderFeatureButton(button,feature,label,loading)` (`:148`) — sets text; if a hotkey exists, sets `aria-keyshortcuts` (`"Meta+Shift+X"` on mac else `"Alt+Shift+X"`) and appends a **decorative** `makeKbd(short,{decorative:true})` chip class `chatgoose-toolbar-hotkey` (CSS shows it only on hover/focus, `styles.css:270-291`); appends a `chatgoose-spinner` span when `loading`.
- `render(state, activeAction, nextReplyMode, nextReplyTone, hasDraftText, activeLoading=false, showCompareRestore=false)` (`:174-244`) — the single update entry point:
  - Toggles `chatgoose-hidden` on the whole bar based on `state?.groupId`; early-returns when `state` is null.
  - Personality label = `state.mappedPersonalityName ?? (state.accountId ? 'Unmapped' : 'Not connected')`.
  - `disableForPrereqs` = not `connected` OR no `hasApiKey` OR no `hasPersonalities` OR no `mappedPersonalityId`.
  - `disableCompareForPrereqs` = not connected / no key / `compareCardCount < 2`.
  - Per feature button: `disabled` if another action is active, or prereqs fail, or (`improve-draft` and `!hasDraftText`); re-renders with spinner when `isActive && activeLoading`.
  - **Scan "ready" state**: toggles `chatgoose-toolbar-button-summary-ready` and swaps the tooltip to `'Scan ready to open'` when `state.hasAvailableSummary` (`:208-216`). The green dot is a CSS `::after` (`styles.css:196-207`), hidden on hover.
  - **Multi toggle**: armed when `nextReplyMode === 'preferSplit'`; sets `disabled` (any active action / not connected / no key), `aria-pressed`, and `chatgoose-toolbar-toggle-active` (green).
  - **Tone pills**: whole `toneRow` hidden when `!connected || !hasApiKey`; when connected-but-unmapped the pills stay visible-but-disabled (track `disableForPrereqs`); active pill = `nextReplyTone === tone` via `aria-pressed` + `chatgoose-tone-pill-active`.

### Boundary crossings
- **DOM**: creates/updates its own subtree; reads/writes only its own nodes. No network, storage, or clipboard.
- **IPC (indirect)**: callbacks → `index.ts` → `startFeature` / `startTonedReply` / `toggleNextFastReplyMode` / `startCompare` / `reopenCompletedCompare` (which eventually send `operation:start` / `compare:start` over the Port). The bar itself sends nothing.

---

## `overlay/overlay-controller.ts` — streaming reply overlay

`class OverlayController`. Full-viewport modal over `#chatgoose-overlay-root`
(`ensureOverlayRoot()`, `:170`). Instantiated at `index.ts:271`. This is the
single largest surface; it renders **loading**, **reply**, **helpMe**,
**readOnly** (summary/review), and **error** view-model kinds.

### Imports
- `toUserError` (`../../shared/errors`); many types from `../../shared/types`.
- `ensureOverlayRoot` (`../dom-anchor`).
- Spend formatters from `../spend-format`: `formatLlmCostSummary, formatCacheEffectInline, formatModelCostLabel, formatModelUsageLabel, formatSpendPrimary, formatSpendSecondary, formatUsd`.
- Composer/clipboard from `../textarea`: `insertIntoFanslyTextarea, copyToClipboard, focusActiveConversationTextarea`.
- View helpers from `../ui/view-helpers`: `createUserErrorBlock, formatLoadingStatus, getInsertButtonLabel, getNextInsertablePart, getReplyPartTitle, insertedFeedbackDelayMs, isEditableElement, isInsertFeedbackActive, isInteractiveElement`.

### Callbacks (`OverlayCallbacks`, `:45-50`)
`onClose`, `onCancel(operationId)`, `onRerun(feature)`, `onCollapse`. Wired at
`index.ts:271-301`:
- `onClose` → clears deep overlay model, may `clearOperationState`, resets mode/tone.
- `onCancel(id)` → `port.send({ type: 'operation:cancel', operationId })` then clears state/mode/tone.
- `onRerun(feature)` → clears the feature's completed-overlay cache and `startFeature(feature, true)`.
- `onCollapse` → switches `quickSurfaceMode` to `'inline'` (moves the result into the inline panel).

### View-model types
- `OverlayViewModel` (from types) discriminated by `kind`: `'hidden' | 'loading' | 'reply' | 'helpMe' | 'readOnly' | 'error'`.
- Internal `OverlayViewState` = `StaticViewState | LoadingViewState` caching the mounted DOM per current view so loading can update in place.

### Shell lifecycle
- `ensureShell()` (`:351-430`) builds the shell once: `chatgoose-overlay-shell` → `chatgoose-overlay-backdrop` + `chatgoose-overlay-panel`; the panel holds header (eyebrow/title/subtitle + `×` close), an inline-error slot, and `chatgoose-overlay-body`. Returns `true` when it (re)mounted.
- `teardownShell()` (`:432-445`) clears the root and nulls all cached element refs + timers.
- `render(model, options?)` (`:238-298`) — the entry point. `options` may be a boolean (legacy `preserveInlineError`) or `{preserveInlineError?, dismissMode?}`.
  - Toggles `body.classList` `chatgoose-scroll-lock` for any non-hidden model, and sets `root.style.pointerEvents` (`none` when hidden, else `auto`).
  - Sets `dismissMode`: explicit option wins; else `'cancel-and-close'` for loading, `'close'` otherwise.
  - On `kind==='hidden'`: clears timers, resets debug state, tears down shell, logs trace, returns.
  - Else ensures shell, syncs backdrop pass-through, updates header + inline error, renders body, logs trace.

### Dismiss / keyboard
Constructor (`:195-223`) attaches two `document` `keydown` listeners:
- **Escape** (when model not hidden) → `handleDismiss()`.
- **Enter** (no modifiers, not repeat/composing) → only for a completed `reply` of feature `fast-reply`, only when focus is not editable/interactive and is inside the overlay root or body; inserts `getNextInsertablePart(parts)` with `autoPassThrough:true`.

`handleDismiss()` (`:225-236`): if `dismissMode==='collapse-to-inline'` →
`onCollapse`; else if `'cancel-and-close'` on a loading model with an
`operationId` → `onCancel(id)` then `onClose`; else `onClose`.

### Backdrop "pass-through" mode
`passThrough` boolean lets clicks fall through the backdrop to the page after an
insert (so the user can immediately edit the Fansly composer). `insertPart(...,
{autoPassThrough:true})` sets it; a `pointerdown` on the panel resets it
(`:380-386`); backdrop gets `chatgoose-pass-through` (`pointer-events:none`) via
`syncBackdropPassThrough()`. A backdrop click while `passThrough` is a no-op.

### Insert flow
`insertPart(part, options?)` (`:318-340`):
1. `await insertIntoFanslyTextarea(part.text)` — **writes the Fansly composer DOM**.
2. Marks `part.insertedOnce = true`, `part.insertedAt = Date.now()`.
3. Optionally sets `passThrough`.
4. Re-renders; schedules `scheduleInsertedReset` (clears `insertedAt` after `insertedFeedbackDelayMs()` = 2000 ms, `view-helpers.ts:11`) so the "Inserted ✓" label reverts.
5. `queueComposerFocus()` → `requestAnimationFrame(() => focusActiveConversationTextarea())`.
On error: `inlineError = toUserError(error)` and re-render preserving it.

### Header
`updateHeader(model)` (`:447-470`): eyebrow = `titleForFeature(feature)`
(`:95-112`, maps `fast-reply→'Fast Reply'`, `improve-draft→'Fix Draft'`,
`hi-greeting→'Hi Greeting'`, `help-me→'Help Me'`, `fan-summary→'Fan Summary'`,
`chat-review→'Chat Review'`, `ping→'Ping'`) or `'ChatGoose'` for error; title =
`"{feature} — @{fanDisplayName||'fan'}"`; subtitle = `'Preview only. You send
messages manually.'` (or `'Something went wrong'` for error).

### Body renderers
`renderBody(model)` (`:490-533`) diffs: if same-op loading, update in place;
else rebuild via `createLoadingView` / `renderReply` / `renderHelpMe` /
`renderReadOnly` / `renderError`. For a fresh completed `fast-reply` it
`queueMicrotask`-focuses the first `.chatgoose-card-actions .chatgoose-button`
(guarded by `lastFocusedReplyOpId`).

- **Loading** (`createLoadingView`/`updateLoadingView`, `:535-605`): a `chatgoose-grid` of spend host (placeholder strip), status text, `chatgoose-stream` live text (defaults `"Waiting for AI…"`), and a red **Cancel** button (`onCancel(operationId)`). Optional **profiling** card and **debug prompt** inspector are inserted before the actions. Status line = `loadingStatusText` = `formatLoadingStatus(progress)` optionally suffixed `" • {elapsed}"` (from live profiling clock). A 100 ms `setInterval` (`loadingElapsedTimer`) ticks the elapsed/retry countdown when profiling or `progress.retryAtMs` is present (`syncLoadingStatusTimer`, `:870-893`).
  - Spend strip keyed by `dataset.spendKey` to avoid rebuilds (`syncLoadingSpend`, `:617-638`).
  - Profiling log is append-optimized with scroll-pin preservation (`syncLoadingProfilingLogEntries`, `:753-797`; `isScrolledToBottom` tolerance 4px).
- **Reply** (`renderReply`, `:1016-1073`): optional spend strip + profiling summary; a `chatgoose-inline-note` when `splitModeRequested` (different text for 1 vs many parts, `:1029-1037`); either an error block, a list of **part cards**, or a raw `chatgoose-stream`; optional debug prompt; then completed actions. Split parts get `emphasis:'recommended'` (first) / `'followup'` (rest) and hint text.
- **Help Me** (`renderHelpMe`, `:1077-1126`): a "Coaching" card (`model.coaching ?? rawText`), then `Engaging N` and `Flirty N` suggestion part cards, an optional raw fallback (`parseFallback`), debug prompt, completed actions.
- **Read Only** (`renderReadOnly`, `:1130-1216`): summary/review. Optional rating badge (`ratingClass`, `:127-133`, `chatgoose-rating-excellent…poor`) + `N/10`; `summaryMeta` "Cached/Generated {relativeTime}" line (`relativeTime`, `:114-125`, m/h/d ago); Evaluation + Recommendations cards for reviews (else raw stream); debug prompt; completed actions with a **Copy** built from `getReadOnlyCopyText` and, for `fan-summary`, a server-sync status label.
- **Error** (`renderError`, `:1296-1316`): optional spend strip, `createUserErrorBlock(model.error)`, optional profiling + debug prompt.

### Part cards
`createPartCard(title, part, options)` (`:946-1012`): `chatgoose-card` (with
`-recommended`/`-followup` variants), title, optional hint/status, the part text,
and actions **Insert** (label from `getInsertButtonLabel`, disabled while
`isInsertFeedbackActive`) + **Copy** (`copyToClipboard(part.text)` — **clipboard
write**). Insert calls `insertPart`; copy errors surface as inline error.

### Completed actions
`renderCompletedActions(feature, rerunActionLabel, copyText?, syncStatus?)`
(`:1243-1292`): a **Regenerate** button (label = `rerunActionLabel`, →
`onRerun(feature)`), an optional **Copy**, and an optional sync-status span
(`formatFanSummarySyncStatus`, `:135-152`: `not-set-up / saving / saved / failed
(code)`).

### Spend / profiling / debug rendering
- `renderSpendStrip(spend?, {placeholder?})` (`:1318-1361`): primary
  `formatSpendPrimary` + inline cache-effect span (`chatgoose-spend-cache-saved`
  / `-overhead`); secondary `formatSpendSecondary`; placeholder shows "Cost
  pending · Tokens pending".
- `renderProfilingCard/…Summary/…Log` (`:1363-1527`): "Pipeline Profiling •
  {elapsed}" header; summary lists Total, model usage/cost rows
  (`formatModelUsageLabel/…CostLabel`, `formatLlmUsageSummary`,
  `formatLlmCostSummary`), reasoning entries parsed from log messages
  (`extractReasoningEntries`, regex on `"Reasoning requested: …"` /
  `"Reasoning observed: …"`, `:1529-1559`), an optional collapsible
  `<details>` reasoning block, and per-stage rows (`skipped`/`failed`/duration).
- `renderDebugPrompt(snapshot)` (`:1588-1612`): a `<details class="chatgoose-debug-inspector">` (open state persisted per operation in `debugPromptOpen`/`debugPromptOperationId`) with sections System Prompt, Transcript Sent to LLM, Fan Spending Data (or "Not included"), Fan Subscription Data (or "Not included"), Final User Prompt.

### Debug / instrumentation
- `isRenderTraceEnabled()` (`:895-911`): true if `globalThis.__CHATGOOSE_OVERLAY_DEBUG__ === true` **or** `window.localStorage.getItem('chatgoose:overlay-debug') === '1'` (cached in `renderTraceEnabledFromStorage`).
- `logRenderTrace(...)` (`:913-942`): `console.debug('[ChatGoose overlay render]', {...})` per render when enabled; always updates `renderTraceState`.

### Boundary crossings
- **DOM write** (composer): `insertIntoFanslyTextarea` on Insert / Enter-to-insert.
- **DOM read/write**: builds its subtree; toggles `document.body` scroll-lock; `document.addEventListener('keydown')` ×2.
- **Clipboard**: `copyToClipboard` on Copy buttons.
- **Browser API / storage-like**: `window.localStorage` read for the render-debug flag; `globalThis.__CHATGOOSE_OVERLAY_DEBUG__` read.
- **IPC (indirect)**: `onCancel` → `operation:cancel`; `onRerun` → `operation:start`; reacts to `operation:chunk/progress/complete/error` (via models `index.ts` builds).

---

## `overlay/completed-overlay-cache.ts` — per-op result cache

`class CompletedOverlayCache`. Holds the last completed overlay view-model **per
feature within one conversation group**.

- State: `activeGroupId: string|null`, `completedByFeature: Map<FeatureType, {cacheKey, model}>`.
- `setActiveGroup(groupId)` — clears the whole map on group change (`:12-19`).
- `get(groupId, feature, cacheKey?)` (`:21-40`) — returns the cached `CompletedOverlayViewModel` only when `groupId` matches the active group **and** `cacheKey` matches the stored one (both normalized to `null`); else `null`.
- `set(groupId, feature, model, cacheKey?)` (`:42-57`) — no-op if `groupId` is falsy; switches active group then stores.
- `clearFeature(groupId, feature)` (`:59-65`), `clearAll()` (`:67-69`).
- Callers: `index.ts` (`completedOverlayCache`, `:217`) uses `get` to re-open a completed result without re-running, `clearFeature` on rerun, `clearAll` on port disconnect.
- No boundary crossings (pure in-memory).

---

## `inline-panel/inline-panel-controller.ts` — inline panel + compare panel

`class InlinePanelController`. Compact panel mounted in-flow inside
`#chatgoose-root` (its `root`, `chatgoose-inline-panel`, is the first child,
`index.ts:315`). Instantiated at `index.ts:219`. Renders `loading`, `reply`,
`error`, and the multi-draft **`compare`** kinds. `helpMe`/`readOnly` are
explicitly skipped here (`:250-253` comment "shouldn't appear in inline").

### Imports
- `FEATURE_LABELS` (`../../shared/constants`), `toUserError` (`../../shared/errors`), many types.
- Spend formatters `formatCacheEffectInline, formatSpendPrimary, formatSpendSecondary` (`../spend-format`).
- `insertIntoFanslyTextarea, copyToClipboard, focusActiveConversationTextarea` (`../textarea`).
- Same view-helpers set as the overlay (`../ui/view-helpers`).

### Callbacks (`InlinePanelCallbacks`, `:32-39`)
`onClose`, `onExpand`, `onCancel(operationId)`, `onRerun(feature)`,
`onCompareRerun`, `onCompareTabSelect(cardId)`. Wired at `index.ts:219-270`:
- `onClose` → hides the relevant surface (compare vs quick inline) and re-renders.
- `onExpand` → `quickSurfaceMode='overlay'` (promotes the quick result into the overlay); disabled for compare.
- `onCancel(id)` → for compare: `port.send({type:'compare:cancel', operationId})`, clear compare state + `completedCompareCache`; for quick: `port.send({type:'operation:cancel', operationId})`.
- `onRerun(feature)` → clear overlay cache, `startFeature(feature, true)`.
- `onCompareRerun` → clear `completedCompareCache`, `startCompare(true)`.
- `onCompareTabSelect(cardId)` → set `activeCardId` on the live compare model, re-render.

### Structure
Header (`chatgoose-inline-panel-header`) = info (`title` +
`meta` spend line, hidden by default) + actions (`↗` **Expand** →
`onExpand`, `×` **Close** → `onClose`). Body =
`chatgoose-inline-panel-body`. The Expand button is `display:none` for the
`compare` kind (`:198`).

### `render(model, options?)` (`:171-206`)
- `hidden` → `hide()`.
- Non-loading → clears the retry-countdown timer.
- Title = `'Compare'` for compare, else `FEATURE_LABELS[feature]` (so inline shows **`Fix`/`Summary`** etc., unlike the bar's `Polish`/`Scan`), formatted `"{label} — @{fan}"`.
- `renderHeaderMeta` (`:272-312`): compare hides meta; otherwise shows a compact spend primary + cache-effect chip, with `formatSpendSecondary` as the element `title` (hover tooltip).
- Un-hides the panel, then `renderBody`.

### `hide()` (`:208-216`)
Resets model to `hidden`, clears view/inline-error/focus/timer, empties body,
adds `chatgoose-hidden`.

### Body diff (`renderBody`, `:218-270`)
Same in-place-update-for-same-op-loading pattern as the overlay; builds
`createLoadingView` / `renderCompareBody` / `renderReplyBody` /
`renderErrorBody`; auto-focuses first insert button for a fresh completed
fast-reply.

### Loading (`createLoadingView`/`updateLoadingView`, `:361-433`)
`chatgoose-grid` of status text + `chatgoose-stream` (`"Waiting for AI…"`
default) + red **Cancel** (`onCancel(operationId)`). Status = `formatLoadingStatus(progress)`; when `progress.retryAtMs` is set a **250 ms**
`loadingStatusTimer` refreshes the countdown (`:414-432`).

### Reply (`renderReplyBody`, `:437-491`)
Optional inline-error banner (insert/copy failures), then error block / part
cards / raw stream, then a **Regenerate** button (`rerunActionLabel` →
`onRerun(feature)`). Split-mode hints/emphasis mirror the overlay.

### Compare panel (the multi-draft surface)
- `renderCompareBody(model: CompareInlineViewModel)` (`:493-578`):
  - Empty tabs → a waiting `chatgoose-stream` (`progress.message ?? 'Preparing compare…'`).
  - `formatCompareSummary(tabs)` (`:61-78`) → e.g. "Comparing current + N drafts" / "Comparing N drafts" / "Comparing current".
  - A horizontal **tab strip** (`chatgoose-compare-tabs`): one `chatgoose-compare-tab` button per card; active tab = `aria-pressed=true` + `chatgoose-compare-tab-active`; a `Current` badge when `tab.source==='current'`; a `chatgoose-spinner` while `tab.status==='loading'`; click → `onCompareTabSelect(cardId)`.
  - Active-tab body (`renderCompareActiveTab`, `:580-647`): loading → placeholder spend strip + status + stream; error → optional spend strip + error block; done → spend strip + part cards (or raw stream).
  - Footer actions: **Cancel all** (`onCancel(operationId)`, when `canCancel`) and **Regenerate all** (`onCompareRerun`, when `canRegenerate`).

### Part cards (`createPartCard`, `:649-721`)
Inline variant packs title/hint/status/actions into a single
`chatgoose-card-header-row`, text below. Insert → `insertPart`; Copy →
`copyToClipboard`.

### Insert flow (`insertPart`, `:723-736`)
Same as overlay minus pass-through: `insertIntoFanslyTextarea` → mark
inserted → re-render → `scheduleInsertedReset` (2000 ms) →
`queueComposerFocus()`. Errors set `inlineError` and re-render with
`preserveInlineError`.

### Keyboard
Constructor (`:139-168`): **Escape** (panel visible, not editable focus) →
`onClose`; **Enter** (no modifiers) → insert next part for a visible completed
`fast-reply` when focus is not editable/interactive and within the panel.

### Boundary crossings
- **DOM write** (composer): `insertIntoFanslyTextarea`.
- **DOM read/write**: builds subtree; `document.addEventListener('keydown')` ×2.
- **Clipboard**: `copyToClipboard`.
- **IPC (indirect)**: `onCancel` → `operation:cancel` / `compare:cancel`; `onCompareRerun`/`onRerun` → `compare:start`/`operation:start`; reacts to `operation:*` and `compare:ready/chunk/cardComplete/cardError/complete/error/progress` models.

---

## `inline-panel/completed-compare-cache.ts` — completed compare cache

`class CompletedCompareCache`. Single completed compare result per conversation
group.

- `CompletedCompareEntry = { model: CompareInlineViewModel; fingerprint: string|null }`.
- State: `activeGroupId`, `completedEntry`.
- `setActiveGroup` clears on group change; `get(groupId)` returns the entry only for the active group; `set(groupId, entry)`; `clear(groupId)`; `clearAll()`.
- Callers: `index.ts` (`completedCompareCache`, `:218`) — cleared on cancel/rerun/disconnect; the `fingerprint` gates whether a cached compare can be reopened (`pendingCompareFingerprint`).
- No boundary crossings.

---

## `cheatsheet-controller.ts` — the `?` shortcut modal

`class CheatsheetController`. Body-anchored modal in
`#chatgoose-cheatsheet-root` (created by `ensureCheatsheetRoot()`, `:10-18`).
Instantiated at `index.ts:305` with the live `hotkeyBindings` array; toggled by
the `cheatsheet` hotkey action (`index.ts:391-393`, the `?` key).

- Imports `HotkeyAction`, `CHEATSHEET_EXTRAS` (`../shared/hotkeys`), `KeyBinding` type (`../shared/keymap`), `makeKbd` (`./ui/kbd`).
- State: `open: boolean`.
- Constructor adds a `document` `keydown` listener: **Escape** while open → `preventDefault` + `close()`.
- `isOpen()`, `toggle()`, `show()`, `close()` (`:48-68`). `close()` empties the root.
- `render()` (`:70-105`): builds `chatgoose-cheatsheet-backdrop` (mousedown on the backdrop itself → close) → `chatgoose-cheatsheet-panel` with title "ChatGoose shortcuts", a list of `row(label, description)` for every binding **not** flagged `hideFromCheatsheet`, then the `CHEATSHEET_EXTRAS` rows, then footer "Press ? to toggle · Esc to close".
- `row(label, description)` (`:20-33`): a `makeKbd(label)` chip (class `chatgoose-cheatsheet-key`) + description. Built from the same `KeyBinding` table the keymap dispatches, so displayed keys can't drift from live bindings.
- Boundary crossings: DOM only (own subtree + one keydown listener). No network/storage/IPC.

---

## `mapping-banner.ts` — unmapped-account / personality banner

`class MappingBanner`. `chatgoose-banner` root, mounted last in
`#chatgoose-root` (`index.ts:315`). Instantiated at `index.ts:210` with
`onOpenSettings` → `browser.runtime.openOptionsPage()`.

- Imports `loadStorageState, saveAccountMapping` from `../shared/storage`.
- Static structure: copy block (title "Which model is this account?" + body text) + an `actions` container.
- `async render(accountId, mapped)` (`:32-94`):
  - When no `accountId` or already `mapped` → hide + clear actions, return.
  - Else `await loadStorageState()` — **reads `browser.storage.local`** — and unhide.
  - **No personalities**: body prompts to create one; renders an **Open Settings** button → `onOpenSettings`.
  - **Has personalities**: body `"Assign Fansly account {accountId} to a model personality."`; renders a `<select>` populated from `state.personalities` (`id`→value, `name`→text), a **Save Mapping** button (disabled until a selection), and a secondary **Settings** button (→ `onOpenSettings`).
  - Save → `await saveAccountMapping(accountId, select.value)` — **writes `browser.storage.local`** — then hides the banner.
- Boundary crossings:
  - **Storage read**: `loadStorageState()`.
  - **Storage write**: `saveAccountMapping(accountId, personalityId)` (persists the account→personality mapping; the exact keys are owned by the storage map).
  - **Browser API (indirect)**: `onOpenSettings` → `browser.runtime.openOptionsPage()`.
  - **DOM**: own subtree only.

---

## `toast.ts` — transient notifications

`class ToastController`. Renders into `#chatgoose-toast-root`
(`ensureToastRoot()`). Instantiated at `index.ts:179`; called via
`index.ts` `showUserErrorToast(...)` (`:319-341`) and other sites.

- Imports `formatUserFacingError, getUserErrorDescription, isUserFacingError` (`../shared/errors`), `UserFacingError` type, `ensureToastRoot` (`./dom-anchor`).
- `ToastOptions` (`:9-16`): `actionLabel`, `onAction`, `durationMs`, `description`, `dedupeKey`, `tone` (`'info'|'success'|'warning'|'error'`).
- State: `activeToasts: Map<dedupeKey, {node, timeout}>`.
- `show(message, options)` (`:22-74`):
  - Primary text: if `message` is a `UserFacingError` → `formatUserFacingError`, else the string.
  - Description: option, else `getUserErrorDescription(message)` for errors.
  - `dedupeKey` default = `"{primary}|{description}"`; an existing toast with the same key is removed (timeout cleared) before showing the new one.
  - Node = `chatgoose-toast chatgoose-toast-{tone}` with primary text, optional secondary, and an optional action button (`onAction()` then dismiss).
  - Auto-dismiss after `durationMs ?? 4500` ms via `setTimeout` → `removeToast`.
- `removeToast(key)` (`:76-85`): clears timeout, removes node, deletes map entry.
- Boundary crossings: DOM only; timers. No network/storage/IPC. (`showUserErrorToast` in `index.ts` adds a "Settings" action → `openOptionsPage()` when the error has a `settingsLink`, but that wiring lives in `index.ts`, not here.)

---

## `spend-format.ts` — currency / token / cost formatting

Pure formatting helpers (no DOM, no I/O). Imported by the overlay and the
inline panel.

- Imports `LlmCostEstimate, LlmSpendSummary` types and `getModelDisplayName` (`../shared/model-registry`).
- `formatCompactTokens(n)` (`:4-13`): `<1000` verbatim; `<10k` → `"1.2k"` (trims `.0`); `<1M` → `"12k"`; else `"1.2M"`.
- `formatUsd(value, approximate=false)` (`:15-18`): `~`-prefixed when approximate; precision 2/4/6 digits by magnitude (`≥1`, `≥0.01`, else).
- `formatSpendPrimary(spend)` (`:20-22`): `"{usd} · {tokens} tokens"`.
- `formatSpendSecondary(spend)` (`:24-31`): `"in X · write Y · read Z · out W"` (compact tokens).
- `formatCacheEffectInline(spend)` (`:33-43`): `null` for neutral / zero effect; else `{text:"saved|overhead $X", kind}` (drives `chatgoose-spend-cache-saved`/`-overhead`).
- `formatLlmCostSummary(cost)` (`:45-56`): `"total … • input … • write (5m+1h) … • read … • output …"`.
- `formatModelCostLabel(cost)` / `formatModelUsageLabel(cost?)` (`:58-64`): `"{modelDisplayName} cost"` / `"… usage"` (falls back to `"Model usage"`).
- Boundary crossings: none.

---

## `ui/kbd.ts` — key-cap chip factory

- `makeKbd(label, options?)` (`:4-14`): returns a `<kbd class="chatgoose-kbd">` with `label` text. When `options.decorative` → sets `aria-hidden="true"` (used for the hover-only toolbar hotkey badges so the host button's `aria-keyshortcuts` carries the a11y name); standalone chips (cheatsheet) stay readable.
- Callers: `button-bar.renderFeatureButton` (decorative) and `cheatsheet-controller.row` (readable).
- Boundary crossings: none.

---

## `ui/view-helpers.ts` — shared render/state helpers

Constant `INSERT_FEEDBACK_MS = 2000` (`:11`). Imported by both the overlay and
inline panel.

- `isEditableElement(el)` (`:13-24`): true for `TEXTAREA`/`INPUT`/`contentEditable`.
- `isInteractiveElement(el)` (`:26-33`): true for `BUTTON`/`A`/`SELECT`/`SUMMARY`.
- `formatRetryCountdown(retryAtMs)` (`:35-38`): `"{n}s"` remaining (min 1).
- `formatLoadingStatus(progress)` (`:40-51`): when `progress.statusCode` → `"{code} • {message} ({countdown})"`; else `progress.message ?? 'Generating…'`.
- `createUserErrorBlock(error)` (`:53-71`): `chatgoose-inline-error` block with `formatUserFacingError` primary + optional `getUserErrorDescription` secondary. Used by overlay + inline panel for both inline (insert/copy) errors and model error states.
- `getReplyPartTitle(part, splitModeRequested?)` (`:73-81`): `"Follow-up N"` for split parts after the first, else `"Message N"`.
- `isInsertFeedbackActive(part, now?)` (`:83-88`): true within 2000 ms of `insertedAt` (drives the disabled "Inserted ✓" state).
- `getInsertButtonLabel(part)` (`:90-95`): `"Inserted ✓"` (while `insertedAt`), else `"Insert again"` (if `insertedOnce`), else `"Insert"`.
- `getNextInsertablePart(parts, now?)` (`:97-108`): first not-yet-inserted & available part, else first available, else `null` (used by Enter-to-insert).
- `insertedFeedbackDelayMs()` (`:110-112`): returns `INSERT_FEEDBACK_MS` (2000).
- Boundary crossings: none (reads `document.activeElement` tag/flags only via passed elements).

---

## `styles.css` — injected stylesheet

Loaded once as the text content of `#chatgoose-style`
(`dom-anchor.ensureStyles`). ~1693 lines, single stylesheet, all selectors
`chatgoose-`-prefixed. Notable structure:

- **CSS variables** on `:root` (`:7-25`): dark navy theme (`--chatgoose-bg/panel/text/muted/accent/danger/success/warning/border/shadow/font`), `color-scheme: dark`.
- **`.chatgoose-hidden`** = `display:none !important` (`:45-47`) — the show/hide primitive used everywhere.
- **Toolbar** (`:49-351`): `.chatgoose-bar`/`.chatgoose-toolbar` (horizontal scroll, `flex-wrap:nowrap`), buttons (`-primary`/`-secondary`/`-danger`), the summary "ready" dot `::after` (`:196-207`), the hover-reveal hotkey badge `.chatgoose-toolbar-hotkey` (`:270-291`), the `Multi` toggle `.chatgoose-toolbar-toggle(-active)` (green when armed), tone pills `.chatgoose-tone-pill(-active)`, and the right-pinned personality via `margin-left:auto`.
- **Inline panel** (`:353-620`): base + compact overrides; compare summary/tabs/tab-badge/spinner; part card header-row layout; media-query fallbacks.
- **Mapping banner** (`:622-654`) and **form elements** (`:656-676`).
- **Toast** (`:678-737`): fixed bottom-right, `z-index:2147483645`; tone variants.
- **Overlay** (`:739-1041`): `#chatgoose-overlay-root` `z-index:2147483646` `pointer-events:none`; shell/backdrop (`.chatgoose-pass-through` disables backdrop pointer events); panel `min(720px,100%)` `max-height:min(84vh,860px)` slide-up animation; header/eyebrow/title/subtitle/close; stream, cards (`-recommended`/`-followup`), rating badges, error/note blocks.
- **Spend strip** (`:1049-1074`) incl. cache-effect colors; **profiling** (`:1076-1166`); **debug inspector** (`:1168-1242`).
- **`body.chatgoose-scroll-lock`** (`:1244-1248`): `overflow:hidden !important` — toggled by the overlay while visible.
- **Spinner** + keyframes (`:1250-1293`).
- **Responsive** `@media (max-width:720px)` (`:1295-1323`).
- **Cheatsheet** (`:1325-1413`): `#chatgoose-cheatsheet-root` `z-index:2147483647` (highest); the shared `.chatgoose-kbd` chip is defined here (`:1392-1407`).
- **Spenders board** (`:1415-1661`) and **floating `$` launcher** (`:1663-1693`) — styling for surfaces not in this map's scope but present in the same file.

Flag: z-index values are literals in the CSS; they are not derived from
`OVERLAY_Z_INDEX` in `constants.ts`.

---

## Cross-cutting notes / discrepancies

- The whole set is **presentation-only**: no surface owns a Port or `sendMessage`. All IPC is via callbacks resolved in `src/content/index.ts`, and all rendering is driven by view-models `index.ts` builds from `BackgroundPortMessage`s. To trace a button to a wire message, follow the callback name into `index.ts:199-311`.
- **Label divergence**: the toolbar shows `Polish`/`Scan`; the inline panel header and `FEATURE_LABELS` use `Fix`/`Summary`; the overlay header uses long forms (`Fix Draft`/`Fan Summary`). Same features, three label vocabularies.
- **"Multi" ≠ Compare**: the visible `Multi` toggle arms `preferSplit` reply mode. The multi-draft *Compare* action and its *Reopen* control exist in `button-bar.ts` but are **never mounted** (created, given click handlers and disable-logic, but not appended to the bar). `render()`'s `showCompareRestore` param is dead. There is no `⋯`/Scan overflow menu in the current code.
- **`OVERLAY_Z_INDEX` / `CHATGOOSE_NAMESPACE` constants are unused** — no imports; the prefix and z-indexes are hardcoded in TS and CSS.
- **Timers**: overlay uses a 100 ms elapsed/retry ticker; inline panel a 250 ms retry-countdown ticker; both clear on non-loading render and on port disconnect. Insert-feedback reset is a 2000 ms `setTimeout`.
