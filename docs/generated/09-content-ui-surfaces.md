> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Content-script UI surfaces

The injected DOM surfaces that the Fansly content script renders on top of the
page: the feature toolbar, the streaming result overlay, the inline
compare/Multi panel, the two completed-result caches, toasts, the shortcut
cheatsheet, the account→persona mapping banner, and shared UI helpers/styles.
All controllers in this territory are pure DOM builders driven by view-model
objects; the wiring that decides *when* to render each model, the port
messaging, hotkey dispatch, and the acceptance-telemetry send live in
`src/content/index.ts` (documented elsewhere).

## DOM roots and z-index layering

Surfaces attach to the page in two ways:

- **In-flow, inside `#chatgoose-root`** (a `display: grid` container inserted
  near the composer; `styles.css:29`): the toolbar (`ButtonBar.root`), the
  inline panel (`InlinePanelController.root`), and the mapping banner
  (`MappingBanner.root`). These controllers only construct and expose a `.root`
  element; `content/index.ts` mounts it.
- **Fixed, full-viewport overlay roots** created lazily by id, each with a
  distinct z-index near the top of the 32-bit range (`styles.css`):

| Root id | Created by | z-index | Surface |
|---|---|---|---|
| `#chatgoose-cheatsheet-root` | `cheatsheet-controller.ts:10` | 2147483647 | Shortcut cheatsheet (top-most) |
| `#chatgoose-overlay-root` | `dom-anchor.ts:16` (`ensureOverlayRoot`) | 2147483646 | Streaming result overlay |
| `#chatgoose-board-root` | (controller outside this territory) | 2147483646 | Spenders board |
| `#chatgoose-toast-root` | `dom-anchor.ts:26` (`ensureToastRoot`) | 2147483645 | Toasts (fixed bottom-right) |
| `#chatgoose-launcher-root` | (controller outside this territory) | 2147483644 | Floating `$` launcher |

The stylesheet itself is installed once as a `<style id="chatgoose-style">` in
`<head>` by `installContentStyles` (`dom-anchor.ts:1`).

## Toolbar — `content/button-bar.ts`

`ButtonBar` builds a single horizontal row (`chatgoose-bar chatgoose-toolbar`,
`button-bar.ts:54`) of labelled feature buttons plus tone pills, a Multi toggle,
and a right-pinned personality pill. It takes a callback bag
(`ButtonBarCallbacks`, `button-bar.ts:31`) and is redrawn by `render()`.

### Buttons are features

`TOOLBAR_FEATURES` (`button-bar.ts:9`) fixes the button set and labels, and the
label text differs from the internal feature id: `fast-reply`→"Reply",
`improve-draft`→"Polish", `hi-greeting`→"Hi", `ping`→"Ping",
`fan-summary`→"Scan". Each is a plain labelled button (no overflow `⋯` menu;
`button-bar.test.ts:91`). Reply gets `chatgoose-toolbar-button-primary`
(`button-bar.ts:68`); Scan gets `chatgoose-toolbar-button-summary`
(`button-bar.ts:74`). A "Compare" button and a "Reopen" (`compareRestoreButton`)
button are constructed (`button-bar.ts:76`, `button-bar.ts:83`) but are **not
appended** to the row — `render()` always keeps `compareRestoreButton` hidden
and disabled (`button-bar.ts:222`), and the confirmed order appended at
`button-bar.ts:128` is: Reply, Multi toggle, Polish, tone row, Hi, Ping, Scan,
personality pill (asserted by `button-bar.test.ts:422`). Help/Review/Compare are
intentionally absent from the row (`button-bar.test.ts:160`).

Each feature button carries a hover-only key-cap hint: `renderFeatureButton`
(`button-bar.ts:148`) sets `aria-keyshortcuts` (Meta on mac, Alt otherwise) and
appends a decorative `makeKbd` chip (`chatgoose-toolbar-hotkey`,
`button-bar.ts:161`) that is `aria-hidden`; the chip is CSS-revealed only on
hover/focus (`styles.css:287`). The button's `title` carries the full combo
(`button-bar.ts:141`). During an active operation the active button re-renders
with an appended `chatgoose-spinner` while keeping its hotkey chip
(`button-bar.ts:167`, `button-bar.test.ts:138`).

### render() gating

`render(state, activeAction, nextReplyMode, nextReplyTone, hasDraftText,
activeLoading, _showCompareRestore)` (`button-bar.ts:174`):

- Hides the whole bar when there is no `state.groupId` (`button-bar.ts:184`).
- The personality pill shows `state.mappedPersonalityName`, else "Unmapped"
  (has `accountId`) or "Not connected" (`button-bar.ts:189`).
- `disableForPrereqs` disables every feature button and tone pill unless
  connected + has API key + has personalities + a mapped personality
  (`button-bar.ts:192`). Polish additionally requires `hasDraftText`
  (`button-bar.ts:200`). Any active action disables the *other* buttons
  (`button-bar.ts:201`).
- Scan shows a green "ready" dot (`chatgoose-toolbar-button-summary-ready`,
  `styles.css:196`) and swaps its title to "Scan ready to open" when
  `state.hasAvailableSummary` (`button-bar.ts:209`).

### Tone selectors and Multi toggle

`TONE_OPTIONS` (`button-bar.ts:21`) are three pills — labels "Flirty", "Upsell",
"Horny" mapping to tones `flirty`/`upsell`/`spicy`. Clicking a pill fires
`onToneSelect(tone)` (`button-bar.ts:119`); per the header comment and the test
suite this arms the tone AND immediately starts one fast-reply (one click = one
generation, `button-bar.test.ts:295`). The armed tone (`nextReplyTone`) is
mirrored as the active pill via `aria-pressed` + `chatgoose-tone-pill-active`
(`button-bar.ts:237`). The whole tone row is hidden when not connected or no API
key, but stays visible-yet-disabled when connected/keyed but unmapped
(`button-bar.ts:235`, `button-bar.test.ts:315`). The pill tooltip mentions the
`⌘⇧O`-style cycle combo (`button-bar.ts:111`).

The Multi toggle (`chatgoose-toolbar-toggle`, `button-bar.ts:93`) reflects
`nextReplyMode === 'preferSplit'`: `aria-pressed` + green
`chatgoose-toolbar-toggle-active` (`button-bar.ts:226`). Clicking fires
`onReplyModeToggle` (`button-bar.ts:99`). It has no bound hotkey — no chip, no
`aria-keyshortcuts` (`button-bar.test.ts:131`). It disables during any active
operation and when not connected/keyed (`button-bar.ts:227`).

## Streaming overlay — `content/overlay/overlay-controller.ts`

`OverlayController` owns the modal result overlay mounted in
`#chatgoose-overlay-root`. It is a persistent-shell renderer keyed on an
`OverlayViewModel` discriminated union whose `kind` is one of `hidden`,
`loading`, `reply`, `helpMe`, `readOnly`, `error` (`overlay-controller.ts:60`).
Its callbacks are `onClose`, `onCancel`, `onRerun`, `onCollapse`, and the
optional acceptance hook `onAcceptance` (`overlay-controller.ts:44`).

### Shell lifecycle and render diffing

`render(model, options)` (`overlay-controller.ts:239`) is the single entry
point. It toggles `body.chatgoose-scroll-lock` and the root's `pointer-events`
by whether the model is hidden (`overlay-controller.ts:264`), then:

- `kind: 'hidden'` tears the shell down entirely (`teardownShell`,
  `overlay-controller.ts:434`) and clears the elapsed timer / debug state.
- Otherwise `ensureShell` (`overlay-controller.ts:353`) lazily builds the
  backdrop + panel + header (eyebrow/title/subtitle) + inline-error slot + body,
  reusing them if still connected (returns `false` = "reused"). The mounted
  shell is preserved across same-operation loading updates (verified by a
  MutationObserver seeing zero childList records, `overlay-controller.test.ts:294`).
- The body is rebuilt per kind by `renderBody` (`overlay-controller.ts:492`),
  *except* loading→loading with the same `operationId`, which updates the
  existing `LoadingViewState` in place (`updateLoadingView`,
  `overlay-controller.ts:497`). Rendered content lives inside a dedicated
  `.chatgoose-overlay-body` wrapper (`overlay-controller.test.ts:327`).

A render-trace diagnostic (`logRenderTrace`, `overlay-controller.ts:915`) logs
per-render `{count, kind, operationId, shellAction, bodyAction, durationMs}` to
`console.debug` when `globalThis.__CHATGOOSE_OVERLAY_DEBUG__ === true` or
`localStorage['chatgoose:overlay-debug'] === '1'` (`overlay-controller.ts:897`).

### Loading state (operation:chunk → complete)

`createLoadingView` (`overlay-controller.ts:537`) builds a `chatgoose-grid` of:
a spend host, a status line, a live stream text node, and a Cancel button. On
each update:

- The stream text node's `.data` is mutated to `model.rawText` (falling back to
  "Waiting for AI…"), so streamed chunks never rebuild DOM
  (`overlay-controller.ts:597`, `overlay-controller.test.ts:264` in the inline
  suite mirrors this).
- Spend renders through `renderSpendStrip(..., {placeholder:true})` keyed by a
  `spendKey` dataset string so it only re-renders when spend numbers change; a
  "Cost pending · Tokens pending" placeholder shows before usage arrives
  (`overlay-controller.ts:619`, `overlay-controller.ts:1337`).
- Status text comes from `formatLoadingStatus` (view-helpers), enriched with the
  profiling `activeLabel` and a live elapsed clock when profiling is present
  (`loadingStatusText`, `overlay-controller.ts:642`). A 100 ms interval
  (`syncLoadingStatusTimer`, `overlay-controller.ts:872`) drives the live clock
  and the rate-limit retry countdown; it is only armed when profiling or a
  `retryAtMs` is present, and is cleared otherwise (asserted by
  `overlay-controller.test.ts:518`).
- Optional profiling log (`syncLoadingProfiling`, `overlay-controller.ts:667`)
  appends rows append-only when the entry list only grew, preserving the user's
  scroll position and re-pinning to the bottom only if they were already pinned
  (`syncLoadingProfilingLogEntries`, `overlay-controller.ts:755`;
  `overlay-controller.test.ts:385`/`:424`).
- An optional streamed prompt-debug inspector (`syncLoadingDebugPrompt`,
  `overlay-controller.ts:850`).

### Completed states, insert/copy, acceptance

`renderReply` (`overlay-controller.ts:1022`) renders a `chatgoose-parts` list of
part cards (plus an optional spend strip, profiling summary, a split-mode helper
note, a raw fallback when there are no parts, and a completed-actions row).
`renderHelpMe` (`overlay-controller.ts:1083`) renders a Coaching card plus
Engaging/Flirty suggestion cards. `renderReadOnly` (`overlay-controller.ts:1136`)
renders Fan Summary / Chat Review output, including a colored rating badge whose
class comes from `ratingClass` (`overlay-controller.ts:128`), a
cached/generated `relativeTime` line, and Evaluation/Recommendations cards.
`renderError` (`overlay-controller.ts:1302`) renders a user-error block, with
profiling/debug below.

Part cards (`createPartCard`, `overlay-controller.ts:948`) carry an **Insert**
and a **Copy** button. The Insert label is driven by `getInsertButtonLabel`
(view-helpers): "Insert" / "Insert again" / "Inserted ✓". Actions:

- **Insert** → `insertPart` (`overlay-controller.ts:319`): calls
  `insertIntoFanslyTextarea`, marks `part.insertedOnce`/`insertedAt`, optionally
  sets `passThrough`, re-renders, then (if `operationId` present) fires
  `onAcceptance(operationId, 'inserted', part.sequenceIndex)`
  (`overlay-controller.ts:334`) and schedules a 2 s "Inserted ✓" reset before
  refocusing the composer. Failure sets an inline error.
- **Copy** → `copyToClipboard` then `onAcceptance(operationId, 'copied',
  part.sequenceIndex)` (`overlay-controller.ts:998`). Failure sets an inline
  error preserved across the re-render (`render(model, true)`).

`renderCompletedActions` (`overlay-controller.ts:1249`) builds the bottom row:
an optional Rerun button (label from `model.rerunActionLabel`, e.g.
"Regenerate"/"Refresh") firing `onRerun(feature)`, an optional Copy of the whole
result (`getReadOnlyCopyText` assembles Chat Review's Rating/Evaluation/
Recommendations text, `overlay-controller.ts:1224`), and a Fan Summary server
sync status label (`formatFanSummarySyncStatus`, `overlay-controller.ts:136`,
one of "not set up"/"saving..."/"saved"/"failed (code)").

### States, errors, dismissal, keyboard

- **Dismiss modes** (`OverlayDismissMode`, `overlay-controller.ts:37`): `close`,
  `cancel-and-close` (default for loading), `collapse-to-inline`. `handleDismiss`
  (`overlay-controller.ts:226`) routes Escape / backdrop-click / `×`-button:
  collapse-to-inline calls `onCollapse`; cancel-and-close on a loading model
  calls `onCancel(operationId)` then `onClose`; otherwise `onClose`. The Cancel
  *button* always calls `onCancel` regardless of dismiss mode
  (`overlay-controller.ts:562`; `overlay-controller.test.ts:951`).
- **Escape** listener (`overlay-controller.ts:197`) and a separate
  **Enter-to-insert** listener (`overlay-controller.ts:204`) are installed once
  in the constructor. Enter inserts the next insertable part only for a visible
  completed `fast-reply`, when focus is on body/inside the overlay and not on an
  editable/interactive element, with no modifier/repeat/composition
  (`overlay-controller.ts:204`; the whole guard matrix is exercised across
  `overlay-controller.test.ts:1087`–`:1188`).
- A newly visible completed fast-reply auto-focuses its first Insert button via
  `queueMicrotask` (`overlay-controller.ts:521`;
  `overlay-controller.test.ts:1190`).
- **Pass-through**: after an Enter/auto insert, `passThrough` makes the backdrop
  ignore clicks (`chatgoose-pass-through`, `overlay-controller.ts:301`) so the
  user can keep typing in Fansly; a `pointerdown` on the panel clears it
  (`overlay-controller.ts:382`). It is force-reset for hidden/loading/error
  (`overlay-controller.ts:253`).

The spend strip (`renderSpendStrip`, `overlay-controller.ts:1324`) and the
profiling summary/log (`renderProfilingSummary`, `overlay-controller.ts:1406`;
`renderProfilingLog`, `overlay-controller.ts:1393`) use the `spend-format`
helpers and render token/cost rows, a reasoning-requested/observed pair parsed
out of the profiling log entries (`extractReasoningEntries`,
`overlay-controller.ts:1535`), a collapsible reasoning block, and per-stage
durations. The debug prompt inspector (`renderDebugPrompt`,
`overlay-controller.ts:1594`) is a `<details>` titled "LLM Input" with System /
Transcript / Fan Spending / Fan Subscription / Final User Prompt sections whose
open state is remembered per operation (`debugPromptOpen`,
`overlay-controller.ts:1597`).

## Inline compare/Multi panel — `content/inline-panel/inline-panel-controller.ts`

`InlinePanelController` is a compact in-flow panel (`chatgoose-inline-panel`,
`inline-panel-controller.ts:97`) that renders a subset of view kinds inline near
the composer: `loading`, `reply`, `error`, and `compare`; `helpMe`/`readOnly` are
ignored inline (`inline-panel-controller.ts:251`). Callbacks add `onExpand`,
`onCompareRerun`, `onCompareTabSelect` to the overlay set, and the same
`onAcceptance` hook (`inline-panel-controller.ts:31`).

- Header: a title `"<FeatureLabel> — @<fan>"` (compare titles as "Compare"), an
  Expand button (`↗`, hidden for compare) firing `onExpand`, and a Close (`×`)
  firing `onClose` (`inline-panel-controller.ts:112`). A single-line spend meta
  with the token breakdown in a `title` tooltip is shown when spend is present
  (`setHeaderMetaContent`, `inline-panel-controller.ts:293`).
- Body diffing mirrors the overlay: same-operation loading updates mutate the
  stream/status Text nodes in place (`updateLoadingView`,
  `inline-panel-controller.ts:402`); a changed `operationId` rebuilds
  (`inline-panel-controller.test.ts:444`). A completed fast-reply auto-focuses
  its first Insert button (`inline-panel-controller.ts:260`).

### Multi-draft compare cards

`renderCompareBody` (`inline-panel-controller.ts:494`) renders a
`CompareInlineViewModel`:

- A summary line built by `formatCompareSummary`
  (`inline-panel-controller.ts:62`) — e.g. "Comparing current + 2 drafts".
- A horizontally scrollable tab strip of `chatgoose-compare-tab` buttons, one
  per `model.tabs` entry, with `aria-pressed`/active class on the
  `activeCardId`, a "Current" badge for the current-draft source, and a spinner
  for tabs still `loading` (`inline-panel-controller.ts:514`). Clicking a tab
  fires `onCompareTabSelect(cardId)`.
- The active tab's content (`renderCompareActiveTab`,
  `inline-panel-controller.ts:581`): a loading placeholder+stream for `loading`,
  a user-error block for `error`, or a spend strip + part cards / raw text for a
  completed tab.
- A footer actions row with a "Cancel all" button (when `canCancel` and an
  `operationId`) firing `onCancel`, and a "Regenerate all" button (when
  `canRegenerate`) firing `onCompareRerun` (`inline-panel-controller.ts:556`).

### Inline part cards and acceptance

The inline `createPartCard` (`inline-panel-controller.ts:650`) puts title/hint/
status/actions on a single `chatgoose-card-header-row` above the text (distinct
from the overlay's stacked layout; `inline-panel-controller.test.ts:472`).
Insert/Copy behave as in the overlay: `insertPart`
(`inline-panel-controller.ts:727`) inserts, marks the part, fires
`onAcceptance(operationId, 'inserted', sequenceIndex)`
(`inline-panel-controller.ts:734`), schedules the 2 s reset, and refocuses the
composer; Copy fires `onAcceptance(..., 'copied', ...)`
(`inline-panel-controller.ts:706`). Escape closes only when visible and focus is
not in an editable element (`inline-panel-controller.ts:140`); Enter-to-insert is
scoped the same way as the overlay but also requires the panel not hidden and the
model's `feature === 'fast-reply'` (`inline-panel-controller.ts:148`).

## Completed-result caches

Two small in-memory caches let a previously completed result be re-shown without
regenerating; both key on the active conversation `groupId` and self-clear when
the active group changes.

- **`overlay/completed-overlay-cache.ts`** — `CompletedOverlayCache` stores one
  `CompletedOverlayViewModel` per `FeatureType` for the active group, plus an
  optional `cacheKey` string so the same feature can hold distinct results
  (e.g. tone/draft variants); `get` returns `null` on group mismatch or
  cacheKey mismatch (`completed-overlay-cache.ts:21`). `setActiveGroup` clears
  everything when the id changes (`completed-overlay-cache.ts:12`);
  `clearFeature`/`clearAll` are the targeted evictions. It preserves object
  identity — a mutation to a cached part's `insertedOnce` persists
  (`completed-overlay-cache.test.ts:84`). Consumed in `content/index.ts`
  (`get`/`set`/`clearFeature`/`clearAll`/`setActiveGroup`).
- **`inline-panel/completed-compare-cache.ts`** — `CompletedCompareCache` holds a
  single `{model, fingerprint}` `CompletedCompareEntry` per active group. The
  `fingerprint` lets `content/index.ts` invalidate the cached compare when the
  underlying inputs change (`content/index.ts:1554` compares fingerprints and
  clears on mismatch).

## Toast — `content/toast.ts`

`ToastController` renders stacked toasts into `#chatgoose-toast-root`.
`show(message, options)` (`toast.ts:22`) accepts a string or a `UserFacingError`
(formatted via `formatUserFacingError`, with `getUserErrorDescription` as the
secondary line). Toasts dedupe by `dedupeKey` (default `primary|description`,
`toast.ts:31`): an existing toast with the same key is removed and replaced.
Tone (`info`/`success`/`warning`/`error`) sets `chatgoose-toast-<tone>`
(`toast.ts:40`). An optional action button (`actionLabel` + `onAction`) fires
then dismisses. Each toast auto-dismisses after `durationMs` (default 4500 ms,
`toast.ts:70`); `activeToasts` tracks node + timeout for cleanup.

## Cheatsheet — `content/cheatsheet-controller.ts`

`CheatsheetController` is the `?`-key modal listing every shortcut, mounted in
`#chatgoose-cheatsheet-root`. It is constructed from the same
`KeyBinding<HotkeyAction>[]` table the keymap dispatches, so displayed keys can't
drift from live bindings (`cheatsheet-controller.ts:39`). `render`
(`cheatsheet-controller.ts:70`) lists one `row(label, description)` per binding
(skipping `hideFromCheatsheet`) followed by the `CHEATSHEET_EXTRAS`; each key is
a `makeKbd` chip. `toggle`/`show`/`close` manage the open flag; Escape closes
(`cheatsheet-controller.ts:41`), as does a mousedown on the backdrop
(`cheatsheet-controller.ts:73`). Footer reads "Press ? to toggle · Esc to close".

## Mapping banner — `content/mapping-banner.ts`

`MappingBanner` prompts the operator to bind a Fansly account to a model
personality. `render(accountId, mapped)` (`mapping-banner.ts:32`) hides the
banner (`chatgoose-hidden`) when there is no account or it is already mapped.
Otherwise it loads storage state (`loadStorageState`): with zero personalities it
shows a "create a personality in Settings" message and an "Open Settings" button
(→ `onOpenSettings`); with personalities it renders a `<select>` of persona names
plus a "Save Mapping" button (enabled once a persona is chosen) and a "Settings"
button. Saving calls `saveAccountMapping(accountId, personaId)` and hides the
banner (`mapping-banner.ts:85`).

## UI helpers

- **`content/ui/kbd.ts`** — `makeKbd(label, {decorative})` builds a single
  `<kbd class="chatgoose-kbd">` chip; decorative chips get `aria-hidden="true"`
  so the host element's accessible name/`aria-keyshortcuts` carries the hint
  (`kbd.ts:4`). Shared by the toolbar hover hints and the cheatsheet.
- **`content/ui/view-helpers.ts`** — shared pure helpers used by both result
  surfaces: `isEditableElement`/`isInteractiveElement` (keyboard-scope guards),
  `formatLoadingStatus` (status-code + message + `formatRetryCountdown`,
  `view-helpers.ts:40`), `createUserErrorBlock` (the `chatgoose-inline-error`
  primary/secondary block), `getReplyPartTitle` ("Message N" / "Follow-up N",
  `view-helpers.ts:73`), and the insert-feedback trio driven by the 2000 ms
  `INSERT_FEEDBACK_MS` constant: `isInsertFeedbackActive`, `getInsertButtonLabel`
  (Insert / Insert again / "Inserted ✓"), and `getNextInsertablePart` (prefers
  the first not-yet-inserted available part, then any available part;
  `view-helpers.ts:97`).

## Styles and namespacing — `content/styles.css`

A single ~1692-line stylesheet, all selectors prefixed `chatgoose-` to avoid
collisions with the host page (`styles.css:5`). Design tokens are CSS custom
properties `--chatgoose-*` on `:root` with `color-scheme: dark`
(`styles.css:7`), giving a dark-navy Fansly-native theme. Structure follows the
surfaces, in order: root container + `.chatgoose-hidden` utility; button
bar/toolbar (buttons, tone pills, Multi toggle, personality pill, hover hotkey
chip); inline panel (base + a "compact overrides" block scoped under
`.chatgoose-inline-panel`, plus compare tabs); mapping banner; form elements;
toast; overlay (root/shell/backdrop/panel/header/status/stream/cards/rating/
errors); spend strip; profiling; debug inspector; scroll-lock; spinner;
keyframes (`chatgoose-fade-in`, `-slide-up`, `-slide-down`, `-spin`); a
`max-width: 720px` responsive block; the cheatsheet; the shared `.chatgoose-kbd`
chip; and — styled here though their controllers live outside this territory —
the spenders board (`#chatgoose-board-root`) and the floating `$` launcher
(`#chatgoose-launcher-root`). The fixed overlay roots stack by the z-index scale
in the table above; the overlay panel owns its own scroll (`overflow-y: auto`,
`styles.css:788`) while `.chatgoose-overlay-body` does not
(`overlay-controller.test.ts:341`).

## Acceptance telemetry tie-back

Only two user actions on a completed suggestion are reported as acceptance
telemetry, and only from the overlay and inline-panel part cards: **inserted**
and **copied**. Both surfaces call `onAcceptance(operationId, action,
partIndex)` where `partIndex` is the part's `sequenceIndex`
(`overlay-controller.ts:334`/`:998`; `inline-panel-controller.ts:734`/`:706`).
`content/index.ts` forwards each to the background as an
`operation:acceptance` port message (`content/index.ts:220`/`:275`); the payload
type fixes the action union to exactly `'copied' | 'inserted'` with no `'shown'`
variant (`shared/types.ts:879`). Merely *showing* a result (rendering, focusing
the Insert button, streaming) emits no acceptance event.
