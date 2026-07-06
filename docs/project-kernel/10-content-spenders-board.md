> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Content — Spenders Board

## Scope

This map covers the content-side Spenders board feature end to end, across exactly three files:

- `src/content/spenders/board-launcher.ts` — the floating `$` launcher button.
- `src/content/spenders/spenders-board-controller.ts` — the full-screen board overlay (fetch, render, states, keyboard, sorting).
- `src/shared/spenders.ts` — the pure tier/ranking/formatting domain logic shared by the board and the background `SpendersService`.

For the canonical contract tables of the four external boundaries (Fansly REST, Anthropic, OpenRouter, Agency Hub) see `docs/project-kernel/boundaries.md`; this document does not re-derive them. It does document how these three files touch the internal `getSpendersList` runtime IPC, the DOM, and browser navigation. Background pieces referenced but NOT owned here: `src/background/runtime-api.ts` (request handler) and the `SpendersService` (list builder).

---

## 1. `src/shared/spenders.ts` — pure domain logic

No imports. No side effects. No DOM/network/storage. Consumed by both the board controller (this feature) and the background `SpendersService` (out of scope). File header states the design intent: unlike ChatGoose Desktop (tiers from named OnlyMonster lists), Fansly has no named lists, so tiers are computed client-side from a lifetime-spend USD threshold table. All amounts are creator-facing USD; callers convert Fansly mills → USD before calling.

### Exported types

| Symbol | Kind | Shape / notes |
|---|---|---|
| `SpenderTierId` | type | Union: `'whale' \| 'top' \| 'prime' \| 'base' \| 'low' \| 'micro'` (highest→lowest). |
| `SpenderTier` | interface | `{ id: SpenderTierId; title: string; emoji: string; minUsd: number; maxUsd: number \| null; band: string }`. `minUsd` inclusive lower bound; `maxUsd` exclusive upper bound, `null` = open-ended top tier; `band` is the display string. |
| `SpenderLike` | interface | `{ lifetimeUsd: number }` — minimal shape the ranking/grouping generics require. |
| `SpenderTierGroup<T extends SpenderLike>` | interface | `{ tier: SpenderTier; entries: T[] }`. |

### `SPENDER_TIERS` (const, `spenders.ts:21`)

`readonly SpenderTier[]`, ordered highest→lowest. Exact table:

| id | title | emoji | minUsd | maxUsd | band |
|---|---|---|---|---|---|
| `whale` | Whale | 🐳 | 600 | `null` | `$600+` |
| `top` | Top | ⭐ | 350 | 600 | `$350–600` |
| `prime` | Prime | ✅ | 150 | 350 | `$150–350` |
| `base` | Base | ③ | 50 | 150 | `$50–150` |
| `low` | Low | ② | 25 | 50 | `$25–50` |
| `micro` | Micro | ① | 1 | 25 | `$1–25` |

Note the `base`/`low`/`micro` emojis are the circled-digit glyphs `③`/`②`/`①` (U+2462/U+2461/U+2460), not ASCII. Comment says bands mirror the Desktop reference design.

`TIER_BY_ID` (`spenders.ts:30`) — module-private `Map<SpenderTierId, SpenderTier>` built once from `SPENDER_TIERS` for O(1) lookup.

### Exported functions

- **`getSpenderTier(id: SpenderTierId): SpenderTier`** (`spenders.ts:34`) — `TIER_BY_ID.get(id)`; throws `Error(\`Unknown spender tier: ${id}\`)` if missing. Used by the board when rendering a single-tier filtered view.

- **`assignSpenderTier(lifetimeUsd: number): SpenderTierId | null`** (`spenders.ts:43`) — the core classifier. Returns `null` when `lifetimeUsd` is non-finite OR below the micro floor (`SPENDER_TIERS[last].minUsd` = `1`). Otherwise walks tiers top→bottom, returning the first whose `minUsd <= lifetimeUsd` and (`maxUsd === null` OR `lifetimeUsd < maxUsd`). Falls through to `null` if no match. Effect: anything `< $1` is untierd (excluded from the board's tier sections/chips even if spend > 0).

- **`compareByLifetimeDesc(a, b): number`** (`spenders.ts:65`) — highest-spend-first comparator. Primary key `b.lifetimeUsd - a.lifetimeUsd`; tie-break by optional `fanAccountId` string (ascending, missing id treated as `''`) for stable ordering.

- **`sortByLifetimeDesc<T extends SpenderLike & { fanAccountId?: string }>(entries): T[]`** (`spenders.ts:75`) — returns a new array (`[...entries].sort(compareByLifetimeDesc)`); does not mutate input.

- **`groupSpendersByTier<T>(entries): SpenderTierGroup<T>[]`** (`spenders.ts:85`) — buckets entries by `assignSpenderTier`, dropping `null` (below micro floor). Emits groups in `SPENDER_TIERS` order, skipping empty tiers; each group's `entries` is `sortByLifetimeDesc`-sorted. Used by the board's "All" view.

- **`countByTier(entries): { all: number; byTier: Record<SpenderTierId, number> }`** (`spenders.ts:110`) — counts entries per tier for chip badges. `byTier` initialized to all-zero record; `null`-tier entries skipped; `all` = sum of tiered entries (i.e. count of entries `>= $1`). Used for the chip badges AND the "All" chip count.

- **`formatSpenderAmount(usd: number): string`** (`spenders.ts:133`) — returns `''` for non-finite or `<= 0`; otherwise `Math.round(usd)` with thousands separators via regex `/\B(?=(\d{3})+(?!\d))/g`, prefixed `$`. Example `'$1,078'`. No cents. Used for the per-row amount.

---

## 2. `src/content/spenders/board-launcher.ts` — floating `$` launcher

File header: a small unobtrusive floating `$` launcher for the Spenders board (ChatGoose Desktop entry point adapted for an injected page), body-anchored so it is independent of the per-conversation mount lifecycle.

### Imports
- `comboLabel`, `detectLabelPlatform` from `../../shared/hotkeys.js` — to build the tooltip hotkey hint.

### `ensureLauncherRoot(): HTMLElement` (module fn, `board-launcher.ts:7`)
Finds-or-creates a `<div id="chatgoose-launcher-root">` appended to `document.body`. Idempotent (reuses an existing element if already an `HTMLElement`). **DOM write:** creates/attaches `#chatgoose-launcher-root` to `document.body`.

### `class BoardLauncher` (`board-launcher.ts:17`)
State:
- `root` — the `#chatgoose-launcher-root` element (from `ensureLauncherRoot()`, evaluated at construction).
- `button: HTMLButtonElement | null` — the current button, `null` until mounted.

Constructor: `constructor(private readonly onClick: () => void)`. Stores the click callback only; no DOM work.

- **`mount(): void`** (`board-launcher.ts:23`) — idempotent (`if (this.button) return`). Creates a `<button type="button">`:
  - `className = 'chatgoose-launcher'`
  - `title = \`Spenders board (${comboLabel('m', detectLabelPlatform())})\`` → e.g. `Spenders board (⌘⇧M)` on mac, `Spenders board (Alt+Shift+M)` elsewhere. The `'m'` letter matches the `spenders-board` hotkey (`AI_HOTKEYS` in `shared/hotkeys.ts`).
  - `aria-label = 'Open spenders board'`
  - `textContent = '$'`
  - click listener → `this.onClick()`.
  Then `this.root.replaceChildren(button)` (**DOM write**, replaces launcher-root contents) and stores `this.button`.

- **`unmount(): void`** (`board-launcher.ts:36`) — `this.root.replaceChildren()` (empties launcher-root) and `this.button = null`.

### Callers
Wired in `src/content/index.ts`:
- `private readonly launcher = new BoardLauncher(() => this.board.toggle());` (`content/index.ts:311`) — click toggles the board controller.
- `this.launcher.mount();` inside `init()` (`content/index.ts:348`) — mounted unconditionally at content-script init, body-anchored, independent of conversation route. No `unmount()` call was found in `content/index.ts` (grep for `launcher` in that file shows only construction + `mount`).

---

## 3. `src/content/spenders/spenders-board-controller.ts` — the board overlay (~434 lines)

File header: a body-anchored, full-screen overlay that survives fansly.com route changes (NOT mounted in the per-conversation root the AI surfaces use). Ranks fans by lifetime spend into client-side tiers and opens a fan's chat on click/Enter. Data comes from the background `getSpendersList` request (injected as `fetchList` for testability); navigation injected as `openChat`.

### Imports
- From `../../shared/spenders.js`: `assignSpenderTier`, `countByTier`, `formatSpenderAmount`, `getSpenderTier`, `groupSpendersByTier`, `SPENDER_TIERS`, `sortByLifetimeDesc`, `type SpenderTierId`.
- From `../../shared/types.js` (types): `SpenderListEntry`, `SpendersListResponse`, `SpendersListResult`.
- From `../../shared/errors.js`: `formatUserFacingError`.
- From `../ui/kbd.js`: `makeKbd` (builds `<kbd class="chatgoose-kbd">` chips for the footer legend).

### Injected dependencies
```ts
interface SpendersBoardDeps {
  fetchList: (refresh: boolean) => Promise<SpendersListResponse>;
  openChat: (groupId: string) => void;
}
```
Wired in `content/index.ts:306`:
- `fetchList: (refresh) => sendRuntimeRequest('getSpendersList', refresh ? { refresh: true } : undefined)` — **IPC boundary** (see §4).
- `openChat: (groupId) => this.openFanChat(groupId)` — navigation (see §5).

`type ActiveTier = 'all' | SpenderTierId` (`spenders-board-controller.ts:32`) — the current chip filter.

### Data model consumed (`SpenderListEntry`, `SpendersListResult`, from `shared/types.ts:716`)
- `SpenderListEntry`: `{ fanAccountId, groupId, displayName: string|null, username: string|null, lifetimeMills, lifetimeUsd }`. `groupId` is the Fansly messaging group id / route target; `lifetimeUsd` is what all tier/format logic uses (`lifetimeMills` is carried but unused by the controller).
- `SpendersListResult`: `{ entries, builtAt (epoch ms), fanCount (spend > 0), scannedCount, truncated }`.
- `SpendersListResponse` = `{ ok: true; result } | { ok: false; error: UserFacingError }`.

### Module helper functions
- `ensureBoardRoot()` (`:34`) — finds-or-creates `<div id="chatgoose-board-root">` on `document.body`. **DOM write.**
- `initials(entry)` (`:44`) — from `displayName || username || '?'`, up to first 2 whitespace-split parts, first char of each, uppercased; fallbacks to first char or `'?'`. Used for the row avatar.
- `entryName(entry)` (`:51`) — `displayName || username || fanAccountId`.
- `relativeTime(builtAt)` (`:55`) — `Date.now() - builtAt` clamped to ≥0; `< 1 min` → `'just now'`, `< 60 min` → `'{m}m ago'`, else `'{h}h ago'`. No day granularity.

### `class SpendersBoardController` (`:64`)

**State fields:**
| Field | Type / init | Meaning |
|---|---|---|
| `root` | `#chatgoose-board-root` element | overlay mount |
| `open` | `boolean = false` | is the board shown |
| `loading` | `boolean = false` | fetch in progress (gates the Refresh button `disabled`) |
| `result` | `SpendersListResult \| null = null` | last successful snapshot (acts as an in-memory cache) |
| `activeTier` | `ActiveTier = 'all'` | current chip filter |
| `cursorIndex` | `number = -1` | keyboard cursor into `visibleEntries` |
| `visibleEntries` | `SpenderListEntry[] = []` | rows currently rendered, in display order |
| `rowEls` | `HTMLElement[] = []` | the row DOM nodes, parallel to `visibleEntries` |

**Constructor** (`:74`): stores `deps`; registers a **single** `document.addEventListener('keydown', …)` for the lifetime of the controller (never removed). The handler no-ops unless `open`.

**Public methods:**
- `isOpen(): boolean` (`:78`) — returns `this.open`.
- `toggle(): void` (`:82`) — if open → `close()`; else → `void show()`. This is the entry point from both the launcher click (`content/index.ts:311`) and the `spenders-board` hotkey (`content/index.ts:389`).
- `async show(): Promise<void>` (`:90`) — sets `open = true`; **DOM write:** `document.body.classList.add('chatgoose-scroll-lock')`. If `this.result` already cached → `renderBoard()` (no refetch). Else → `await this.load(false)`.
- `close(): void` (`:100`) — `open = false`, `cursorIndex = -1`; **DOM write:** removes `chatgoose-scroll-lock` body class and `this.root.replaceChildren()` (empties overlay). Does NOT clear `this.result` (so reopening reuses the cache).

**`private async load(refresh: boolean)`** (`:107`) — the fetch/render orchestrator:
1. `loading = true`; `renderLoading(refresh)`.
2. `await this.deps.fetchList(refresh)` (the IPC round trip).
3. Guard: `if (!this.open) return` — if the user closed the board mid-fetch, bail without rendering (leaves `loading` true; note it is not reset on this early-return path).
4. `loading = false`. On `response.ok`: store `this.result`, reset `activeTier = 'all'`, `renderBoard()`. On `!ok`: `renderError(formatUserFacingError(response.error))` → renders `"{code}: {message}"`.
5. `catch`: same `if (!this.open) return` guard, then `loading = false`, `renderError(error.message ?? 'Could not load spenders.')`. Handles a rejected `fetchList` promise (e.g. IPC failure).

#### Rendering (all methods below do DOM writes into `#chatgoose-board-root`)

- **`shell(body)`** (`:130`) — builds the overlay skeleton: `.chatgoose-board-backdrop` > `.chatgoose-board-panel` containing `buildHeader()` + `body`. Backdrop `mousedown` where `event.target === backdrop` (click outside panel) → `close()`. `this.root.replaceChildren(backdrop)`.

- **`buildHeader()`** (`:145`) — `.chatgoose-board-header` with:
  - title block: `.chatgoose-board-title` = `'Spenders'`; `.chatgoose-board-subtitle` = `metaLine(result)` when a result exists, else `'Top spenders by lifetime spend'`.
  - `.chatgoose-board-actions`: a `↻ Refresh` button (`.chatgoose-board-action`, `disabled = this.loading`, click → `void this.load(true)`) and a `Close (Esc)` button (click → `close()`).

- **`metaLine(result)`** (`:183`) — joins with ` · `: `"{fanCount} spender[s]"`, `"scanned {scannedCount}"`, `"updated {relativeTime(builtAt)}"`, and, when `result.truncated`, also `"among most-recent {scannedCount} chats"`. (Note `scannedCount` appears in two of the parts.)

- **`renderLoading(refresh)`** (`:195`) — `.chatgoose-board-state` with text: refresh → `'Rebuilding the board…'`; initial → `'Building the board — fetching lifetime spend per fan. This can take a moment.'`. Wrapped via `shell()`.

- **`renderError(message)`** (`:204`) — `.chatgoose-board-state` with the message text + a `Try again` button (`.chatgoose-board-action`, click → `void this.load(false)` — retries WITHOUT force-refresh).

- **`renderBoard()`** (`:223`) — the main list render. Returns early if `!this.result`. Builds `.chatgoose-board-body` containing:
  1. `buildChips(result.entries)` (tier filter chips).
  2. `.chatgoose-board-list` list host. Resets `this.rowEls = []` and `this.visibleEntries = []` first (so `buildRow` can index into a fresh list).
     - **Empty:** if `result.entries.length === 0` → `.chatgoose-board-state` `'No paying fans found in the scanned conversations yet.'`.
     - **All view** (`activeTier === 'all'`): for each `group` from `groupSpendersByTier(result.entries)` → a `buildSectionHeader(emoji, title, band, count)` then a `buildRow` per entry.
     - **Single-tier view:** `getSpenderTier(activeTier)`, then `sortByLifetimeDesc(entries.filter(e => assignSpenderTier(e.lifetimeUsd) === activeTier))`; one section header + rows.
  3. `.chatgoose-board-footer` legend built from `makeKbd('J')`, `makeKbd('K')` ` move · `, `makeKbd('Enter')` ` open chat · `, `makeKbd('Esc')` ` close` (text nodes interleaved).
  - After `shell(body)`: sets `cursorIndex = visibleEntries.length > 0 ? 0 : -1` (cursor starts on the top spender) and `applyCursor(false)` (highlight, no scroll).

- **`buildChips(entries)`** (`:282`) — `.chatgoose-board-chips`. Always computes `countByTier(entries)` over ALL entries. Emits an `'all'` chip labelled `'All'` with `counts.all`, then for each tier in `SPENDER_TIERS` with `count > 0` a chip labelled `\`${emoji} ${title}\`` with that count. Tiers with zero members are omitted.

- **`buildChip(tier, label, count)`** (`:297`) — `<button class="chatgoose-board-chip">` (+ `chatgoose-board-chip-active` when `activeTier === tier`), a label `<span>` and a `.chatgoose-board-chip-count` badge `<span>` with `String(count)`. Click: no-op if already active, else set `activeTier = tier` and `renderBoard()`.

- **`buildSectionHeader(emoji, title, band, count)`** (`:320`) — `.chatgoose-board-section` with `.chatgoose-board-section-title` = `\`${emoji} ${title}\``, `.chatgoose-board-section-band` = `band`, `.chatgoose-board-section-count` = `String(count)`.

- **`buildRow(entry)`** (`:340`) — pushes `entry` into `visibleEntries` (capturing its index), builds `.chatgoose-board-row` (`role="button"`, `tabIndex = -1`) containing:
  - `.chatgoose-board-avatar` = `initials(entry)`.
  - `.chatgoose-board-row-main`: `.chatgoose-board-row-name` = `entryName(entry)`; `.chatgoose-board-row-handle` = `entry.username ? '@'+username : ''`.
  - `.chatgoose-board-row-amount` = `formatSpenderAmount(entry.lifetimeUsd)`.
  - Click listener: set `cursorIndex = index`, `applyCursor(false)`, then `this.deps.openChat(entry.groupId)`.
  - Pushes the row into `this.rowEls`.

#### Cursor / keyboard (`:378`)

- **`handleKeydown(event)`** (`:380`) — early `if (!this.open) return`. Switch on `event.key`:
  - `Escape` → `preventDefault()` + `close()`. **No modifier guard** — Escape closes even with meta/ctrl/alt held.
  - `j` / `J` / `ArrowDown` → if `meta||ctrl||alt` held, return (no preventDefault, lets browser default through); else `preventDefault()` + `moveCursor(1)`.
  - `k` / `K` / `ArrowUp` → same modifier guard; else `preventDefault()` + `moveCursor(-1)`.
  - `Enter` → modifier guard; else `openCursor(event)`.
  - default → return.
  - There is no editable-target guard here; the board is a full-screen overlay with no text inputs.

- **`moveCursor(delta)`** (`:410`) — no-op if `visibleEntries.length === 0`. If `cursorIndex < 0`, jumps to `0` (delta>0) or last index (delta<0); else wraps modulo `visibleEntries.length`. Sets `cursorIndex`, `applyCursor(true)` (with scroll).

- **`openCursor(event)`** (`:419`) — reads `visibleEntries[cursorIndex]`; if none, return. Else `event.preventDefault()` and `this.deps.openChat(entry.groupId)`. (preventDefault happens here, not in `handleKeydown`.)

- **`applyCursor(scroll)`** (`:426`) — toggles `chatgoose-board-row-active` on each `rowEls[i]` where `i === cursorIndex`; if `scroll && cursorIndex >= 0`, `rowEls[cursorIndex]?.scrollIntoView({ block: 'nearest' })`.

### CSS classes / ids written (DOM contract)
Ids: `chatgoose-board-root` (this file), `chatgoose-launcher-root` (launcher). Body classes toggled: `chatgoose-scroll-lock` (added on `show`, removed on `close`). Element classes: `chatgoose-launcher`, `chatgoose-board-backdrop`, `chatgoose-board-panel`, `chatgoose-board-header`, `chatgoose-board-title`, `chatgoose-board-subtitle`, `chatgoose-board-actions`, `chatgoose-board-action`, `chatgoose-board-state`, `chatgoose-board-body`, `chatgoose-board-chips`, `chatgoose-board-chip`, `chatgoose-board-chip-active`, `chatgoose-board-chip-count`, `chatgoose-board-list`, `chatgoose-board-section`, `chatgoose-board-section-title`, `chatgoose-board-section-band`, `chatgoose-board-section-count`, `chatgoose-board-row`, `chatgoose-board-row-active`, `chatgoose-board-avatar`, `chatgoose-board-row-main`, `chatgoose-board-row-name`, `chatgoose-board-row-handle`, `chatgoose-board-row-amount`, `chatgoose-board-footer`, plus `chatgoose-kbd` (via `makeKbd`). The stylesheet defining these is out of scope (installed via `installContentStyles` in `content/index.ts`).

---

## 4. IPC boundary — `getSpendersList`

The board's only network-adjacent boundary is the internal one-shot runtime request, dispatched via `fetchList`:

- **Send** (`content/index.ts:308`): `sendRuntimeRequest('getSpendersList', refresh ? { refresh: true } : undefined)`. `sendRuntimeRequest` (`shared/protocol.ts:272`) wraps `browser.runtime.sendMessage({ type: 'getSpendersList', ...payload })` and returns the typed `SpendersListResponse`.
- **Request type** `GetSpendersListRequest` (`shared/types.ts:711`): `{ refresh?: boolean }`. Refresh forces a rebuild bypassing the per-creator cache (semantics implemented background-side).
- **Validation** (`shared/protocol.ts:173`): accepted only if `refresh` is an optional boolean.
- **Response** `SpendersListResponse` (`shared/types.ts:740`): `{ ok: true; result: SpendersListResult } | { ok: false; error: UserFacingError }`.
- **Background handler** (out of scope, `background/runtime-api.ts:216`): requires the sender tab to have a connected Fansly `session`; returns `not_connected` error otherwise. On success calls `spendersService.getList(session, signal, { refresh })` under a `SPENDERS_BUILD_TIMEOUT_MS` abort; on abort returns a `timed_out` UserFacingError, else `toUserError`.

The board treats all non-`ok` responses uniformly via `formatUserFacingError` → the error state UI. It does not special-case `not_connected` / `timed_out`.

---

## 5. Navigation boundary — opening a fan chat

`openChat(groupId)` is injected as `this.openFanChat(groupId)` (`content/index.ts:434`):
```ts
private openFanChat(groupId: string): void {
  this.board.close();
  window.location.assign(`/messages/${groupId}`);
}
```
- **Browser-API / DOM navigation:** `window.location.assign('/messages/{groupId}')` — a same-origin full navigation to the Fansly messages route for that group. `groupId` is `SpenderListEntry.groupId` (the Fansly messaging group id). The board is closed first.
- Triggered from a row click (`buildRow`, `:371`) or keyboard Enter (`openCursor`, `:423`).

---

## 6. Dependency / call-site summary

**`board-launcher.ts`** imports: `shared/hotkeys` (`comboLabel`, `detectLabelPlatform`). Instantiated + mounted by `content/index.ts` (`:311`, `:348`).

**`spenders-board-controller.ts`** imports: `shared/spenders` (7 symbols), `shared/types` (3 types), `shared/errors` (`formatUserFacingError`), `content/ui/kbd` (`makeKbd`). Instantiated by `content/index.ts:306`; `toggle()` invoked from the launcher click and the `spenders-board` hotkey action (`content/index.ts:389`, key letter `m`, combo `mod+shift+m` / `alt+shift+m` per `shared/hotkeys.ts`).

**`shared/spenders.ts`** imports: none. Consumers: this board controller AND the background `SpendersService` (the shared model the assignment notes both sides use). The `getSpendersList` background handler (`background/runtime-api.ts`) invokes `SpendersService.getList`, which produces the `SpenderListEntry[]` the board tier-classifies.

---

## 7. Observations / discrepancies (descriptive, not judgments)

- **`fanCount` vs. the "All" chip count differ by definition.** The header subtitle prints `result.fanCount` = spenders with spend `> 0` (per `SpendersListResult` doc-comment, computed background-side). The chips' "All" count is `countByTier(entries).all`, which counts only entries `>= $1` (`assignSpenderTier` returns `null` below the `micro` floor of `$1`). A fan with `0 < lifetimeUsd < 1` would be included in `fanCount` but excluded from tier chips, section groups, and rows. Such a fan is thus counted in the subtitle yet invisible in the list.
- **`renderBoard` renders nothing for a fan below `$1`.** `groupSpendersByTier` drops `null`-tier entries, and the single-tier filter uses `assignSpenderTier(...) === activeTier`, so sub-`$1` entries never appear even though they are present in `result.entries`.
- **`load` early-return leaves `loading = true`.** On the `if (!this.open) return` guard (both the success path `:112` and the catch `:122`), `loading` is not reset. On a subsequent `show()` with a cached `result`, `renderBoard`/`buildHeader` reads `this.loading` for the Refresh button's `disabled` state; if the board was closed during an in-flight fetch, the stale `loading = true` can disable Refresh on the next open until a new `load` resets it. (`load` sets `loading = true` at start and `false` after the guard passes, so a fresh `load` corrects it.)
- **Escape ignores modifiers; j/k/Enter do not.** `handleKeydown` closes on any `Escape` (even with meta/ctrl/alt), but returns early for j/k/Enter when a modifier is held.
- **`metaLine` uses `scannedCount` twice** — once as `"scanned {n}"` and, when `truncated`, again as `"among most-recent {n} chats"`.
- **`lifetimeMills` is carried on `SpenderListEntry` but unused by the controller;** all display/tier logic uses `lifetimeUsd`.
- **`formatUserFacingError` output is raw** `"{code}: {message}"` (`shared/errors.ts:399`); the board shows this verbatim in the error state. A separate `getUserErrorDescription` exists but is not used here.
- **Launcher has no unmount call site.** `BoardLauncher.unmount()` exists but no caller was found in `content/index.ts`; the `$` launcher persists once `init()` mounts it.
