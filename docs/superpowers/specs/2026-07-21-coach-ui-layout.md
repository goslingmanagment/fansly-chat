# Coach — panel UI layout & localization (design addendum)

Date: 2026-07-21 · Rev 2: 2026-07-22 (codex design review folded in — every
adopted finding was verified against both repos' code before adoption) ·
Status: approved by owner · Scope: chatgoose + one small core PR (§5)
Companion to `2026-07-17-coach-chat-design.md` (rev 2.2): that spec defined the
behavior; the panel's visual layout was never designed before implementation.
This addendum closes that gap. Provenance: mockup review with the owner
(artifact «Coach — мокапы раскладки», 2026-07-21/22); codex spec review
2026-07-22.

## 1. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Panel position | KEEP the current shell placement (horizontally centered, top-inset panel over the scrim — the shell is top-aligned, not vertically centered; recorded as-is). Rationale: the session survives close/reopen including unsent composer text, so «Esc → glance at the fan chat → reopen» is cheap. Side-dock and shifted-modal variants rejected by owner. |
| 2 | Topbar | Collapse the three recap controls into ONE «Рекап ▾» menu button (§3). «Новый диалог» stays a standalone button with its existing two-step inline confirm. |
| 3 | Question bubble | Terracotta: define the missing `--chatgoose-clay-soft` token (§4). Today the CSS references it and silently falls back to grey `bg2`. |
| 4 | Draft include | Implement the per-turn draft attach — with a clear Russian label, an explicit state machine (§5), and a REQUIRED core prerequisite (core ignores `draftText` for coach today, §5). |
| 5 | Language | All coach-OWNED copy (the strings listed in §6) becomes Russian. Shared surfaces (the `toUserError` map, toolbar labels, Options, popup) are intentionally excluded — extension-wide localization is its own follow-up. |

## 2. Panel structure

Existing structure is ratified: shared overlay shell → coach header, topbar
(status left, actions right), separately scrolling `role="log"` feed
(exchanges, failed attempts, recap steps, empty state), sticky composer.
All existing interaction rules stand: Esc semantics, streaming composer lock,
keyed incremental renderer, auto-scroll only near bottom, session retention on
close, «после Insert оверлей сворачивается».

**Header (changed, coach-scoped):** clay micro-caps eyebrow «Коуч» + title
`@<fan>` (feature name lives in the eyebrow — no «Коуч / Коуч» doubling), NO
subtitle (removed: the manual-send reassurance is behavior, not copy; the rest
duplicated the composer placeholder), close ✕, hairline under the header.
The clay eyebrow and the hairline are NEW (today the eyebrow is `ink-low` and
the shared header has no border) and MUST be scoped under
`.chatgoose-overlay-coach` — the shell is shared by every overlay surface.

### 2.1 Visual polish (mockup-approved 2026-07-22)

- **Directional bubbles:** question — clay-soft fill, radius `12 12 4 12`,
  max-width 82%, right-aligned; answer — `bg2` fill, NO border, radius
  `12 12 12 4`, max-width 92%, left-aligned.
- **Answer prose is sans** — an APPROVED exception to the E13 «AI text is
  serif» family rule (conversational UI reads better in the UI face); the
  fan-facing draft-card text stays serif, dashed clay border and all.
- **Exchange rhythm:** question/answer/card grouped tight (~8px); ~20px
  between exchanges.
- **Draft card:** stays a SIBLING of the answer inside the exchange (as the
  code already builds it) — never nested inside the answer bubble. Mono
  micro-caps «ЧЕРНОВИК» title in clay-ink; «Вставить» clay-tinted (clay-soft
  bg, clay-line border, clay-ink text), «Копировать» ghost.
- **Recap-step feed item:** centered system line with hairline rules on both
  sides.
- **Composer:** checkbox with its helper line stacked UNDER the label,
  indented past the box (this is the canonical placement — §5 follows it);
  «Отправить» filled clay, slightly larger than secondary buttons.
- **Empty state:** vertically centered; heading + one muted context line
  («Контекст подтянется сам: переписка, траты, рекап, персона модели»); the
  9 hints in three columns with mono micro-caps group labels (§6). Narrow
  overlay (≤ ~560px content width): columns stack vertically, groups keep
  their labels.
- **Status line (changed format):** «Рекап — полный: 3 дн · короткий: 10 мин»
  — label muted (`ink-low`), values emphasized (`ink-mid`, semibold), 12px.
  This REPLACES the current «Полный: … · Короткий: …» format and requires
  structured markup (label + value nodes), not a single text node. The
  unavailable fallback stays «Рекап: не удалось проверить»; '' still hides
  the line.

## 3. Topbar: the «Рекап ▾» menu

- **Trigger:** one secondary button «Рекап ▾» replaces `Auto-recap: default`,
  `Short recap`, `Full recap`.
- **Menu contents:** «Короткий рекап» / «Полный рекап» (explicit refresh; same
  operations and cache-bypass semantics as the buttons they replace);
  separator; «Обновить переписку» (§8.4); separator; radio group «Авто-рекап»:
  «По настройке (<resolved>)» / «Выкл» / «Короткий» / «Полный» mapped 1:1 to
  the existing per-session override `inherit | off | short | full` (replaces
  the cycle button). The resolved-setting label needs the settings snapshot
  from §7.
- **Behavior:** opens on click; closes on item select, outside click, or Esc.
  Esc with the menu open closes the MENU only, never the overlay. Trigger
  disabled while the coach is busy (streaming turn or running recap step). No
  `window.confirm` anywhere.
- **a11y:** `aria-haspopup="menu"`, `aria-expanded`; `role="menu"` with
  `menuitem`/`menuitemradio`; arrow-key focus within; focus returns to the
  trigger on close.
- «Новый диалог» keeps its armed-confirm flow, relabeled per §6.

## 4. Question bubble token

Add `--chatgoose-clay-soft` to BOTH theme blocks of `src/content/styles.css`:
light `#f7e8e1`, dark `#3f2b21` (clay-bg's current values, deliberately a
separate token so the bubble tint can be tuned independently later). No markup
change — `.chatgoose-coach-question` already resolves
`var(--chatgoose-clay-soft, var(--chatgoose-bg2))`.

## 5. Draft attach — «Приложить мой недописанный ответ»

**Core prerequisite (verified failed 2026-07-22, so this is a REQUIRED core
PR, not a check):** core ignores `draftText` for coach — the coach policy has
`requiresDraft: false`, the prompt builder emits the draft section only for
`requiresDraft` features, and `templates/coach-chat.md` has no draft input
slot (its only «draft» mentions are the OUTPUT fence grammar). Do NOT flip
`requiresDraft: true` (that would make every coach turn demand a draft).
Core PR: an optional-draft mechanism (policy flag or always-optional template
slot), template placement, prompt-safety escaping, budget-shed priority (below
question/transcript, alongside other optional context), and tests for
draft-present and draft-absent turns. No contract/schema change — `draftText`
is already in the shared body — so no SDK re-vendor.

**Extension UI:** checkbox in the composer actions row, left of «Отправить»;
helper line under the label (§2.1): «Коуч увидит текст, набранный в поле
ответа Fansly.» Disabled (dimmed, force-unchecked, helper becomes «Поле
ответа Fansly пустое») while the live Fansly composer is empty; re-evaluated
on render.

**State machine (explicit):**

- The checkbox holds an INTENT, stored in the session alongside
  `composerText` (survives close/reopen; reset by «Новый диалог»).
- Default off; intent survives an auto-recap chain unchanged.
- The live draft is read ONCE, immediately before the coach
  `operation:start` dispatch (after any recap step) via
  `getActiveConversationDraftText`. Non-empty → sent as `draftText`;
  empty at dispatch → turn proceeds WITHOUT the field.
- The attempt records `includedDraft = true` only when non-empty text was
  actually sent (meaning «sent», not «requested»).
- Intent resets to off after every DISPATCHED attempt — completed, failed,
  or cancelled. If the chain stops BEFORE dispatch (auto-recap STOP taxonomy,
  route change, port-send failure), the intent is preserved together with the
  preserved question.
- Retry (after failure or cancel): if the failed attempt had
  `includedDraft`, Retry re-reads the CURRENT live draft (empty now →
  proceed without; a stale draft is never resent from memory).

## 6. Russian copy (coach-owned strings only)

| Where | Current (EN) | New (RU) |
|---|---|---|
| Header eyebrow | `Coach` | «Коуч» |
| Header title | `Coach — @<fan>` | «@<fan>» (eyebrow carries the feature name) |
| Header subtitle | `Ask about this fan. You send messages manually.` | REMOVED |
| Composer placeholder | `Ask about this fan…` | «Спроси про этого фана…» |
| Send / Cancel | `Send` / `Cancel` | «Отправить» / «Отменить» |
| New dialog / armed / keep | `New dialog` / `Confirm new dialog` / `Keep` | «Новый диалог» / «Точно сбросить?» / «Оставить» |
| Recap menu | `Auto-recap: …`, `Short recap`, `Full recap` | «Рекап ▾» → «Короткий рекап», «Полный рекап», «Обновить переписку», «Авто-рекап: По настройке (<x>) / Выкл / Короткий / Полный» |
| Status line | `Full: … · Short: …` (already RU) | «Рекап — полный: 3 дн · короткий: 10 мин» (§2.1 format) |
| Empty-state heading | `Ask the coach about this fan` | «Спроси коуча про этого фана» + context line (§2.1) |
| Starter hints | 3 flat chips | 9 hints, 3 labeled groups (owner 2026-07-22). «Продать»: «Не знаю, как продать — подскажи» / «Как подать цену, чтобы не спугнуть?» / «Просит скидку — что ответить?». «Вернуть»: «Как оживить остывший чат?» / «Прочитал и молчит — что написать?» / «Пропал после цены — как вернуть?». «Понять»: «Что этому фану реально заходит?» / «Разбери его: что за человек?» / «О чём говорить, кроме продаж?». Click prefills the composer (existing mechanism). |
| Draft card | `Draft` / `Insert` / `Replace draft…` / `Confirm replace` / `Keep draft` / `Copy` | «Черновик» / «Вставить» / «Заменить черновик…» / «Подтвердить замену» / «Оставить мой» / «Копировать» |
| Failed attempt | `Couldn't finish this turn (<code>).` / `Retry` | «Не получилось закончить ответ (<код>).» / «Повторить» |
| Recap steps | `Short recap (auto) · updated` etc. | «Короткий/Полный рекап (авто/вручную) · обновляется… / обновлён / не удался» |
| Follow-up chips | — (new, §8.3) | «Другой вариант» / «Сделай короче» / «А если откажет?» |
| Memory divider | — (new, §8.1) | «выше — не входит в окно памяти коуча» |
| Context line | — (new, §8.2) | «Отправлено коучу: …» |

Boundary: inline/toast error copy comes from the SHARED `toUserError` map and
stays as-is until the extension-wide localization pass; only the coach-owned
`failed-attempt` line above is translated now. Toolbar «Coach» label likewise
stays.

## 7. Coach UI settings snapshot (new, required by §3 and §8.1)

The renderer needs live values the view model does not carry today
(`CoachOverlaySessionView` has neither; the app reads settings only at
question-submit time): `coachHistoryLimit` (memory divider position) and the
global `coachAutoRecap` default (the «По настройке (<x>)» label). Add a
content-owned snapshot of these two v15 fields to the coach view model,
hydrated when the overlay opens and refreshed on the existing
`settings:changed` path, with a stale-session guard. Fallback while unknown:
menu label «По настройке» without the value, divider not rendered. No
migration — the fields already exist in v15.

## 8. Post-review additions (owner-approved 2026-07-22)

- **8.1 Memory-window boundary divider.** Copy: «выше — не входит в окно
  памяти коуча» (core may shed further for prompt budget — the divider claims
  window membership, not final-prompt survival). Semantics: count COMPLETED
  exchange feed items only (failed attempts and recap steps occupy no memory
  slots); render iff that count exceeds the current `coachHistoryLimit`
  (§7 snapshot); position: immediately before the oldest exchange of the
  last-N tail; derive from feed exchange identities, NOT
  `completedExchanges.length` (the canonical list is capped at
  `COACH_COMPLETED_EXCHANGES_CAP = 50` while older exchanges stay visible in
  the feed). Re-derives when the limit setting changes.
- **8.2 Per-turn context line — «Отправлено коучу».** A collapsed muted line
  under each completed answer: «▶ Отправлено коучу: <N> сообщ.
  (<окно|вся история>) · рекап: <attached, с возрастом|нет>». Expands in
  place. Honest semantics: transcript count/coverage describe what the
  BROWSER sent (pre-budget); the recap part comes from the kernel's
  post-attach `attachedRecaps` report. NO dossier claim (no ordinary per-turn
  dossier signal exists — that stays the E28 prompt echo's job; this line is
  its lightweight sibling, not a replacement). Plumbing (verified missing
  2026-07-22): the gateway parses `attachedRecaps` but the operation callback
  discards it, and kept-count/coverage never leave the background on coach
  turns — the coach `operation:complete` message gains an optional
  `turnContext` field (types + protocol validator: kept-count, coverage,
  attached recaps with ages), retained on `CoachExchange`. Absent field →
  line not rendered (old-background tolerance). Any DOM-visible projection
  follows E28's typed/counts-only declassification rule — no raw kernel
  payload passthrough.
- **8.3 Follow-up chips.** Under the LATEST completed answer only (hidden
  while streaming or when the latest item is a failed attempt): «Другой
  вариант», «Сделай короче», «А если откажет?». A click SUBMITS the canned
  question with NORMAL submission semantics: exactly one coach question; the
  configured auto-recap may prepend one recap step per the standard chain
  (§5 of the behavior spec). Unsent composer text is deliberately preserved
  untouched by a chip click.
- **8.4 «Обновить переписку» menu item.** Own group in the «Рекап» menu
  (§3). Mechanism: the coach session holds a content-owned `transcriptEpoch`
  counter included in the background transcript-cache key; the item bumps the
  epoch — the next turn is a guaranteed cache miss and full quick-window
  reseed, with NO dependency on a live service worker and NO immediate Fansly
  read on click. Feed, composer, auto-recap state, and completed history are
  untouched. Disabled while busy, like the rest of the menu.

Deferred follow-ups (recorded, deliberately NOT in this change): 👍/👎 answer
feedback into kernel usage events (needs core work); «спросить коуча про
выделенное» (DOM-selection integration); pinned/saved advice (conflicts with
deliberate session ephemerality, E46).

## 9. Testing

- Renderer: RU strings exact-match; hint-group rendering incl. narrow-width
  stacking; hint click prefill; keyed updates preserve focus/caret/scroll.
- Token: vitest asserting `--chatgoose-clay-soft:` appears in BOTH theme
  blocks of `styles.css`.
- Menu: busy-disable; Esc closes menu not overlay; focus returns to trigger;
  radio ↔ override mapping; «Короткий/Полный рекап» fire the same ops (incl.
  cache bypass) as the removed buttons; «По настройке (<x>)» reflects a
  `settings:changed` update (§7 hydration + stale-session guard).
- Draft attach: full §5 state machine — intent persistence across
  close/reopen and recap chain, reset rules (dispatched vs never-dispatched),
  live-read at dispatch, empty-at-dispatch, `includedDraft` = actually-sent,
  Retry re-read after failure AND cancel, disabled-on-empty force-uncheck;
  `draftText` on the wire only when non-empty (protocol + gateway threading).
- Memory divider: absent while completed exchanges ≤ limit; correct position
  vs feed identities incl. past the 50-cap; ignores failed/recap items; moves
  on limit change.
- Context line: renders from `turnContext`; absent when the field is absent
  and on failed attempts; expand/collapse preserves feed scroll.
- Follow-up chips: only under latest completed exchange; hidden while
  streaming; click submits the canned text, composer text untouched;
  auto-recap chain composes normally.
- «Обновить переписку»: epoch bump → next turn full reseed (cache key miss),
  session/feed untouched; disabled while busy; survives SW restart.
- Core side: optional-draft policy/template/escaping/shedding, both draft
  branches, restricted-store capture unchanged.

## 10. Sequencing

1. **Core PR:** optional coach draft consumption (§5) + tests + core
   decision-log entry. No contract change → no SDK re-vendor.
2. **Extension PR** from a task branch: token + coach-scoped header/CSS polish
   + menu + settings snapshot + draft state machine + `turnContext` plumbing +
   epoch reseed + RU copy + §9 tests, with the `docs/decisions.md` E-entry in
   the same change (family law). The draft checkbox must not ship enabled
   before the core PR lands (fail-honest: a checkbox that silently does
   nothing is worse than none).
3. No deploy: accumulates for the 2.0 release like the rest of the coach
   stack.
