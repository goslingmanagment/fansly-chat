> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Spenders board (content overlay + shared model)

The Spenders board is a body-anchored, full-screen overlay injected into
`fansly.com`. It ranks the creator's paying fans by lifetime spend, groups them
into client-side tiers, and opens a fan's chat on click/Enter. This document
covers the UI (`src/content/spenders/`), the shared spenders domain model
(`src/shared/spenders.ts`), and the request→response path into the background
service. The background service and the kernel SDK call are documented in
`07-*`; they are summarized here only where the UI depends on their shape.

## What the board shows

The overlay is a backdrop + panel (`src/content/spenders/spenders-board-controller.ts:130`–`143`):

- **Header** (`:145`–`181`): the title `Spenders`; a subtitle that is either
  `Top spenders by lifetime spend` (before data) or the meta line (after data);
  a `↻ Refresh` button (disabled while loading, triggers a cache-bypassing
  rebuild); and a `Close (Esc)` button.
- **Meta line** (`:183`–`193`): `<n> spender(s) · scanned <scannedCount> ·
  updated <relative>`, and when the underlying scan was truncated it appends
  `among most-recent <scannedCount> chats`. `updated` is a coarse relative time
  (`just now` / `<m>m ago` / `<h>h ago`, `:55`–`62`) computed from
  `result.builtAt`.
- **Tier chips** (`:282`–`318`): an `All` chip plus one chip per populated tier
  (`<emoji> <title>` with a count badge). Clicking a chip filters the list to
  that single tier; the active chip carries `chatgoose-board-chip-active`.
- **List** (`:223`–`280`): when the active filter is `all`, entries are grouped
  into tier sections in tier order via `groupSpendersByTier`; when a single tier
  is active, only that tier's entries (re-filtered by `assignSpenderTier` on
  `lifetimeUsd` and re-sorted by `sortByLifetimeDesc`) are shown under one
  section header (`:242`–`259`).
- **Section header** (`:320`–`338`): `<emoji> <title>`, the band string (e.g.
  `$600+`), and the count.
- **Row** (`:340`–`376`): a circular avatar with initials, the entry name and
  `@username` handle, and the formatted dollar amount. Avatar initials come from
  `displayName || username || '?'` (first char of up to two whitespace-split
  words, upper-cased, `:44`–`49`); the row name is `displayName || username ||
  fanAccountId` (`:51`–`53`); the amount is `formatSpenderAmount(entry.lifetimeUsd)`
  (`:365`).
- **Footer** (`:263`–`275`): a keyboard legend — `J`/`K` move, `Enter` open chat,
  `Esc` close (rendered via `makeKbd`).
- **Empty state** (`:237`–`241`): when `result.entries.length === 0`, the list
  host shows `No paying fans found in the scanned conversations yet.`

## Launch / trigger

Two entry points open the board, both calling `SpendersBoardController.toggle()`:

- **Floating launcher** (`src/content/spenders/board-launcher.ts`): a small
  `$` button appended to its own body-anchored root `chatgoose-launcher-root`
  (`:7`–`15`), mounted once during content init (`src/content/index.ts:354`).
  Its `title` shows the board hotkey via `comboLabel('m', detectLabelPlatform())`
  (`board-launcher.ts:28`) and its `aria-label` is `Open spenders board`. Its
  click handler is `() => this.board.toggle()` (wired at
  `src/content/index.ts:317`).
- **Hotkey** `spenders-board` (`src/content/index.ts:394`–`396`), bound to the
  letter `m` in `src/shared/hotkeys.ts:85`. The rendered combo is `⌘⇧M` on macOS
  and `Alt+Shift+M` elsewhere (`src/shared/hotkeys.ts:63`–`66`).

`toggle()` (`spenders-board-controller.ts:82`–`88`) closes an open board or, when
closed, calls `show()`. `show()` (`:90`–`98`) marks the board open, adds
`chatgoose-scroll-lock` to `document.body`, and either re-renders a cached
`result` immediately or calls `load(false)` to fetch. `close()` (`:100`–`105`)
clears the open flag, resets the cursor, removes the scroll lock, and empties the
board root `chatgoose-board-root` (`:34`–`42`).

## Request → response path

The controller is constructed with two injected deps (`:27`–`30`), wired in the
content entry point (`src/content/index.ts:312`–`316`):

- `fetchList: (refresh) => sendRuntimeRequest('getSpendersList', refresh ?
  { refresh: true } : undefined)`
- `openChat: (groupId) => this.openFanChat(groupId)`

`sendRuntimeRequest` (`src/shared/protocol.ts:278`–`289`) sends the request over
`browser.runtime.sendMessage` — a one-shot runtime message, not a long-lived
Port (the content script's `Port` is used for other traffic, not this request).
The request frame is validated by `classifyRuntimeRequest`
(`src/shared/protocol.ts:173`–`174`): `getSpendersList` is accepted when
`refresh` is an optional boolean. The request/response contract is typed in
`RuntimeRequestMap`/`RuntimeResponseMap` (`src/shared/types.ts:701`,`:709`) as
`GetSpendersListRequest` → `SpendersListResponse`.

The background handler (`src/background/runtime-api.ts:255`–`280`):

1. Looks up the `SessionTemplate` for the sender tab; if there is no connected
   session it returns `{ ok: false, error: not_connected }` (`:256`–`260`).
2. Reads `refresh` from the message (`:262`).
3. Opens an `AbortController` with a `SPENDERS_BUILD_TIMEOUT_MS` (120000 ms,
   `src/shared/constants.ts:50`) timeout and calls
   `spendersService.getList(session, signal, { refresh })` (`:263`–`269`).
4. On success returns `{ ok: true, result }`; on an `AbortError` it maps to the
   `timed_out` user error, otherwise `toUserError(error)` (`:271`–`276`).

`SpendersService.getList` (`src/background/spenders-service.ts:75`–`102`) is
cache-fronted: the cache key is `session.resolvedAccountId ?? session.accountId`
(`:71`–`73`); unless `refresh` is set, a cached entry younger than
`SPENDERS_CACHE_TTL_MS` (10 minutes, `constants.ts:48`) is returned as-is. On a
miss it chooses a build path (see next section) and caches the result under the
current wall-clock time.

`openChat` resolves to `openFanChat` (`src/content/index.ts:440`–`443`), which
closes the board and navigates the page with
`window.location.assign('/messages/<groupId>')`.

## Kernel path vs legacy scan (from the UI's perspective)

The UI is path-agnostic — it always receives a `SpendersListResult` and renders
identically. The path is chosen inside the service
(`spenders-service.ts:90`–`98`):

```
useKernel = kernelSource !== undefined
         && settings !== undefined
         && !settings.spendersLegacyRebuild
```

- **Kernel path** (`buildFromKernel`, `:104`–`155`) is the default post-1.6.0
  behavior. It (a) resolves the page label for the session username via
  `resolvePageLabelForUsername` (throwing `hub_page_match_failed` when no page
  matches, `:116`–`118`), (b) performs the one remaining Fansly read —
  `fanslyClient.listFanAccounts(SPENDERS_MAX_FANS, …)` — purely to build the
  `fanAccountId → groupId` map the board needs to open chats (`:120`–`127`), and
  (c) fetches ranked spend from the kernel via `fetchTopSpenders` (`:129`–`134`).
  Kernel entries are filtered to those present in the group map (fans with no
  enumerated conversation are dropped) and mapped to `SpenderListEntry`
  (`:136`–`145`). `builtAt` is the projection's freshest observation
  (`Date.parse(snapshot.builtAt)`), falling back to `now` when null (`:150`);
  `scannedCount` is the number of enumerated Fansly conversations and `truncated`
  reflects whether that enumeration was bounded (`:151`–`154`). Money arrives
  pre-computed: each kernel entry carries `grossMills`, stored verbatim as
  `lifetimeMills` and divided by 1000 for `lifetimeUsd` (`:143`–`144`).
- **Legacy scan** (`buildLegacy`, `:159`–`214`) runs only behind the hidden
  `spendersLegacyRebuild` setting (`src/shared/types.ts:25`; no UI — flipped via
  storage). It enumerates fans, fetches per-fan lifetime earnings with
  `mapWithConcurrency` at `SPENDERS_EARNINGS_CONCURRENCY` (4, `constants.ts:46`),
  keeps payers with `lifetimeMills > 0`, resolves display names in batches of 50
  (`:236`–`259`), and sorts by `lifetimeMills` descending. Here `builtAt` is the
  wall-clock build time (`:209`).

`fetchTopSpenders` (`src/background/agency-hub-client.ts:298`–`336`) calls the
generated SDK's `pageTopSpenders({ params: { pageLabel }, query: { window:
'lifetime', limit } })` and returns `{ builtAt, fanCount, entries[] }` where each
entry is `{ platformUserId, username, displayName, grossMills }`.

## Shared spenders model

`SpenderListEntry` (`src/shared/types.ts:733`–`743`):

| Field | Type | Notes |
|---|---|---|
| `fanAccountId` | `string` | Fansly account id; tie-breaker in the sort |
| `groupId` | `string` | Fansly messaging group id — route target for opening the chat |
| `displayName` | `string \| null` | |
| `username` | `string \| null` | rendered as `@username` |
| `lifetimeMills` | `number` | lifetime gross in Fansly mills |
| `lifetimeUsd` | `number` | lifetime gross in USD (`mills / 1000`); tiering + row amount read this |

`SpendersListResult` (`:745`–`755`): `entries`, `builtAt` (epoch ms), `fanCount`
(spenders with spend > 0), `scannedCount` (conversations scanned), `truncated`
(more conversations exist than were scanned). `SpendersListResponse`
(`:757`–`759`) is a discriminated union of `{ ok: true; result }` or
`{ ok: false; error: UserFacingError }`.

### Tiers and pure logic (`src/shared/spenders.ts`)

Tiers are computed client-side from a lifetime-spend threshold table
(`:21`–`28`); Fansly has no named-list equivalent, so the bands mirror the
Desktop reference design:

| id | title | emoji | band | bounds (USD) |
|---|---|---|---|---|
| `whale` | Whale | 🐳 | `$600+` | ≥ 600 |
| `top` | Top | ⭐ | `$350–600` | 350 ≤ x < 600 |
| `prime` | Prime | ✅ | `$150–350` | 150 ≤ x < 350 |
| `base` | Base | ③ | `$50–150` | 50 ≤ x < 150 |
| `low` | Low | ② | `$25–50` | 25 ≤ x < 50 |
| `micro` | Micro | ① | `$1–25` | 1 ≤ x < 25 |

- `assignSpenderTier(lifetimeUsd)` (`:43`–`53`) returns the tier id, or `null`
  below the $1 micro floor or for non-finite input.
- `getSpenderTier(id)` (`:34`–`40`) throws on an unknown id.
- `compareByLifetimeDesc` / `sortByLifetimeDesc` (`:65`–`79`): highest spend
  first; ties break by `fanAccountId` ascending (deterministic).
- `groupSpendersByTier` (`:85`–`107`): buckets entries into tier sections in tier
  order, drops empty tiers and untiered (< $1) entries, sorts each section
  highest-first.
- `countByTier` (`:110`–`130`): per-tier tallies plus an `all` total, ignoring
  untiered entries (feeds the chip badges).
- `formatSpenderAmount(usd)` (`:133`–`138`): rounded whole dollars with thousands
  separators and no cents (e.g. `$1,078`); returns an empty string for
  `usd <= 0` or non-finite input.

## Money formatting note (`spend-format.ts` / `spend.ts`)

The board's row amount and section bands are formatted entirely by
`formatSpenderAmount` in `src/shared/spenders.ts` (imported at
`spenders-board-controller.ts:12`, used at `:365`). Despite being listed under
the board's territory, `src/content/spend-format.ts` and `src/shared/spend.ts`
format **AI/LLM generation spend**, not fan platform money, and are not imported
by the board:

- `src/content/spend-format.ts` formats `LlmSpendSummary`/`LlmCostEstimate` for
  the AI panel — `formatUsd` (2/4/6 fractional digits by magnitude, optional `~`
  approximate prefix, `:14`–`17`), `formatCompactTokens` (`:3`–`12`),
  `formatSpendPrimary`/`Secondary` and the cache-effect labels (`:19`–`63`). Its
  dollar values are AI spend, not fan spend.
- `src/shared/spend.ts` (Stage 32) builds `LlmSpendSummary` from the kernel's
  `costMicroUsd` usage frame (`totalUsd = costMicroUsd / 1_000_000`,
  `:37`–`54`); the cache-effect decomposition reads neutral/zero because the
  per-token price tables no longer live client-side (`:34`–`36`). This is
  **micro-USD** AI spend, a different unit from the board's platform **mills**.

## States and errors

`load(refresh)` (`spenders-board-controller.ts:107`–`126`) drives the state
machine:

- **Loading** (`renderLoading`, `:195`–`202`): `Rebuilding the board…` on a
  refresh, otherwise `Building the board — fetching lifetime spend per fan. This
  can take a moment.`
- **Success**: stores `result`, resets the active tier to `all`, and calls
  `renderBoard`.
- **Error** (`renderError`, `:204`–`221`): shows the message plus a `Try again`
  button that re-runs `load(false)`. A response `{ ok: false }` is formatted via
  `formatUserFacingError(response.error)` (`:119`); a thrown error uses its
  `message` or the fallback `Could not load spenders.` (`:124`). Both `load`
  branches early-return when the board was closed mid-flight (`:112`,`:122`).
- Error identities originate in the background: `not_connected` (no connected
  session), `timed_out` (build exceeded 120 s), or hub/`ChatGooseError`
  values such as `hub_page_match_failed` mapped through `toUserError`.

## Cursor / keyboard

A single `document`-level `keydown` listener is registered in the controller
constructor (`:74`–`76`) and is a no-op while the board is closed (`:381`).
Bindings (`handleKeydown`, `:380`–`408`): `Escape` closes; `j`/`J`/`ArrowDown`
move the cursor forward and `k`/`K`/`ArrowUp` back (all ignored when
meta/ctrl/alt is held); `Enter` opens the cursor row's chat. `moveCursor`
(`:410`–`417`) wraps modulo the visible-entry count. After each render the cursor
is set to row 0 when any rows are visible (`:278`–`279`); `applyCursor`
(`:426`–`433`) toggles `chatgoose-board-row-active` and, on keyboard moves,
scrolls the active row into view. A row click also sets the cursor and opens the
chat (`:368`–`372`).
