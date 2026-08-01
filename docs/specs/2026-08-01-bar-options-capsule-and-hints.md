# Action bar — the Reply options capsule, and hover hints for the whole row

Date: 2026-08-01 · Status: DRAFT, awaiting owner review · Scope: fansly-ext only
(no kernel, no contract change) · Builds on: E71 (density pass, persona pill
removed), E72 (Recap corner badge + second density pass — uncommitted on branch
`ui/recap-badge-width` at the time of writing).

Provenance: owner brainstorm 2026-08-01. Variants were measured on a DOM bench
reproducing the real row (dark + light themes, Hanken fallback as in the content
script, composer width 605px derived from E71's screenshot).

## 1. Decisions

| # | Question | Decision |
|---|---|---|
| 1 | Where does Split live | INSIDE the Reply options capsule, as a fifth cell behind a hairline seam — not as a standalone chip in the row. Amends E24, which placed it outside |
| 2 | Does Split keep its word | No. The cell is the square checkbox glyph alone; the word moves into the hover hint (§5) and the new hotkey (§4) |
| 3 | How is armed Split shown | The square is **pressed INTO** the groove (clay fill + inset shadow). The armed TONE stays a **raised** thumb. Two different physics in one capsule, not two icons |
| 4 | Does the cell change width when armed | No. E27 stands: arming anything must never reflow the row |
| 5 | Hover hints | A new in-house hint component, applied to **every control in the bar**, replacing the native `title` on those controls |
| 6 | Hotkey | `⌘⇧L` on macOS, `Alt+Shift+L` elsewhere — `L` for spLit, free and outside Firefox's reserved ⌘⇧ set (R/T/P/B/A) |
| 7 | Corner keycap | Stays on the feature buttons — it is instant and teaches the key, so their hints do NOT repeat the combo. The capsule's cells (4 tones + Split) are 24px and cannot host a keycap, so THEIR hints carry the combo as the second line |

Rejected, with reasons, so they are not re-proposed:

- **Icon-only Split in place** (chip stays where it is, just loses the word):
  measured 509px vs 507px for the capsule variant — 2px apart, so the pixel
  argument is void, and the lone square between the groove and `Fix` reads as an
  orphan with no context.
- **Split as an indicator on Reply, toggled only by hotkey**: the largest saving
  (−63px) but it hides a control the owner describes as situational behind
  knowledge of a shortcut.
- **Armed Split expanding to show a word**: proposed and dropped by the owner —
  a pressed square already reads, and expansion would reflow the row.
- **Deciding split AFTER generation** (a "split this" action on the result
  card): the owner keeps the pre-armed flag; split stays part of the request.

## 2. Why Split belongs in the capsule

`supportsReplyMode: true` is set for exactly one feature — `fast-reply`
(`src/shared/features.ts`). Fix, Hi, Ping, Recap all have it `false`. Split is
therefore an OPTION of a single button, exactly like the tone groove, and E24's
own principle — "actions are raised chips, options lie in a sunken groove
pressed against Reply" — puts it inside the groove. E24 placed it outside for a
different reason: a checkbox among radios could read as a fifth tone. Decision 3
answers that objection with the press/raise contrast, which is a stronger
separator than the square-vs-round glyph shape alone.

The row after the move: `Reply` + one options capsule + seam + draft tools +
openers + the right-pinned fan cluster. One fewer free-standing element.

## 3. Structure

The capsule today is a single `role="radiogroup"` element. A checkbox cannot
live inside a radiogroup, so the visual capsule and the radio group must become
two different elements:

```
div.chatgoose-reply-options            ← visual capsule: sunken groove styling
  div.chatgoose-tone-track             ← role="radiogroup", aria-label="Reply tone"
    button.chatgoose-tone-seg × 4      ← role="radio", unchanged
  span.chatgoose-options-seam          ← aria-hidden="true"
  button.chatgoose-split-seg           ← role="checkbox", aria-checked
```

The sunken styling (`background: bg3`, border, `inset` shadow, `border-radius:
999px`, `padding: 3px`) MOVES from `.chatgoose-tone-track` to
`.chatgoose-reply-options`; the track keeps only `display: inline-flex; gap`.
`.chatgoose-hidden` toggling that today targets the track must move to the
capsule, otherwise hiding the groove (not connected / no key) leaves the seam
and the Split cell floating in an empty pill.

`.chatgoose-toolbar-flag` and `.chatgoose-toolbar-flag-active` lose their only
consumer and are deleted (tombstone in `docs/decisions.md`).

### The Split cell

- Geometry identical to a tone segment: `min-height: 22px; min-width: 24px;
  padding: 0 4px` — the row must not care which cell is which.
- Glyph: the existing 9px rounded square, `1.5px` border in `line-strong`,
  transparent fill — carried over from `.chatgoose-toolbar-flag::before` so the
  checkbox form E24 chose survives the move.
- Armed: `background: clay-bg`, `border-color: clay-line`, `box-shadow: inset 0
  1px 3px rgba(31,30,29,.32)`, glyph filled `clay`. The fill and the square
  shape are the primary signal; the inset is a supporting cue (it is subtle at
  22px — do not rely on it alone).
- Disabled: `opacity: .3`, as the tone segments.

## 4. Hotkey

Add to `AI_HOTKEYS` in `src/shared/hotkeys.ts`, following the `cycle-tone`
precedent exactly (it is an action, not a `FeatureType`):

```ts
{ action: 'toggle-split', letter: 'l', description: 'Split — reply as 2–3 messages' }
```

- `HotkeyAction` gains `'toggle-split'`.
- `src/content/index.ts` dispatches it next to `case 'cycle-tone':` →
  `toggleNextFastReplyMode()`, which already guards against firing during an
  active operation.
- Free by construction: taken letters are e f g h d s c v o x m; Firefox
  reserves ⌘⇧ R/T/P/B/A on macOS.
- The cheatsheet (`?`) and the Options hotkeys pane both render from the same
  table, so the new key appears in both with no extra work.
- `aria-keyshortcuts` on the Split cell mirrors the feature buttons:
  `Meta+Shift+L` / `Alt+Shift+L` by platform.

## 5. Hover hints

### Why a component

Everything in the bar uses the native `title` attribute. In Firefox that means
~1s delay, an OS-styled box, and no control over placement — unusable as the
thing that explains the row to a new chatter, and doubly so now that Split has
no word.

### Placement

`.chatgoose-toolbar` is `overflow-x: auto`. **A hint rendered inside the bar
gets clipped.** The component therefore owns one singleton layer element outside
the bar, positioned `fixed` from the anchor's `getBoundingClientRect()`.

- Opens ABOVE the bar by default — the bar sits directly on top of the composer,
  and a downward hint would cover the textarea the chatter is about to type in.
- Flips below only when the anchor's top leaves less than the hint's height plus
  8px.
- Horizontally clamped to the viewport with an 8px margin; the arrow tracks the
  anchor centre.
- Hidden on: pointer leave, click, `Escape`, scroll, any operation start, and
  bar re-render/detach. The layer is removed with the bar (no orphan node in the
  Fansly DOM).

### Timing

- Show after **1000ms** of holding still; hide immediately. (Shipped at 400ms
  and raised after the owner used it: crossing the bar to reach Reply passes
  over three or four controls, and they all spoke.)
- While a hint is already open, moving to another control re-arms on a shorter
  **250ms** dwell — not instantly, or a sweep machine-guns the row — returning
  to the full second 300ms after the last hint hides.
- Also shows on `:focus-visible`, so keyboard users get the same copy.

### Disabled controls

The most confusing state is a greyed-out control (`Fix` without a draft, the
whole row without a mapped persona), and disabled buttons do not reliably
dispatch pointer events. The hint must therefore listen on the CAPSULE/BAR
container (`mousemove` + hit-testing child rects), not on each button.
**Verify the exact Firefox behaviour during implementation** — if delegation
turns out to be enough on its own, prefer it; the requirement is that a disabled
control still explains itself, not a particular mechanism.

### Content

Two lines: the control's name (bold), then one sentence of plain Russian. For
the feature buttons that is all — the corner keycap shows the combo on the same
hover (decision 7). For the capsule's cells, which have no keycap, the combo is
appended to the second line. Native `title` is REMOVED from every control that
gets a hint, otherwise both appear.

| Control | Hint |
|---|---|
| Reply | Ответ на текущую переписку — с учётом персоны и выбранного тона |
| 😌 Casual | Спокойный дружеский тон — без флирта и продаж |
| 😏 Flirt | Флирт — тепло, игра, притяжение |
| 💰 Sell | Мягкая продажа контента — без давления |
| 🔥 Spice | Горячо и прямо — телесный, заряженный тон |
| ▣ Split | Ответ придёт серией из 2–3 сообщений. Отправлять руками, по одному · ⌘⇧L |
| Fix | Переписывает ТВОЙ черновик — не сочиняет новый. Без текста в поле недоступен |
| Hi | Заходы для первого сообщения новому фану |
| Ping | Сообщение, чтобы расшевелить замолчавшего фана |
| Recap | Досье по фану: кто он, на что тратил, о чём уже говорили |
| Coach | Спросить ИИ про этого фана своими словами |
| 🎙 Voice | Голосовая заметка на текущем черновике |

Tone rows reuse the strings already in `TONE_OPTIONS`; the tones' existing
"клик армирует следующий Reply · ⌘⇧O циклирует" tail moves into the hint's
second line unchanged.

## 6. Edge cases

- **Groove hidden** (not connected / no API key): the whole capsule hides,
  Split included — same rule as today.
- **Connected but unmapped**: capsule visible, all cells disabled; hints still
  work (§5) and are the only place explaining why.
- **Operation running**: Split disabled like the tones; the hotkey is a no-op
  through the existing guard in `toggleNextFastReplyMode`.
- **Split armed, kernel returns one part**: unchanged — E49's violation note
  ("expected at least 2 messages") still fires. Nothing in this spec touches the
  request or the result contract.
- **Split stays armed across chats** (sticky per page session, reset only on
  port disconnect): unchanged, and now more visible thanks to the pressed cell.

## 7. Testing

`tests/button-bar.test.ts` (28 cases today) needs these updated — they pin the
old shape and will fail loudly, which is the point:

- L149–152: "Split is a labelled pill with no bound key" → now a cell with a key.
- L290: `role="radiogroup"` is asserted on the track — must stay on the track,
  with the new capsule wrapper asserted around it.
- L365: "hides the groove and the Split flag" → one capsule now hides.
- L377–421 (`ButtonBar Split flag` block): selector, `textContent`, and
  `aria-pressed` → `role="checkbox"` + `aria-checked`.
- L546: the child-order assertion.

New coverage:

- Split cell renders inside the capsule but OUTSIDE the radiogroup.
- `aria-checked` and the armed class follow `nextReplyMode`.
- Clicking still fires `onReplyModeToggle`; the hotkey fires the same path.
- The cheatsheet and Options pane list the new key.
- Hint component: opens after the delay, swaps without delay, flips when the
  anchor is near the top, is removed on detach, and does not double up with a
  native `title`.

Width invariance (armed == unarmed) cannot be asserted in jsdom — it is a
visual check on the bench, recorded here so nobody assumes a test covers it.

## 8. Sequencing

ONE PR, two commits in this order — the hint is what makes losing the word
acceptable, so it must exist before Split loses it, but that is a commit
ordering constraint, not a reason to split the review:

1. **Hints for the whole bar.** Self-contained, no layout change.
2. **The options capsule.** DOM restructure + hotkey + tests + the E73 entry in
   `docs/decisions.md` amending E24 (Split's placement) and re-affirming E27
   (no reflow on arm).

The copy in §5 is settled with the owner in the spec review, before
implementation — it is not a reason to stage the delivery.

Out of scope, named so they are not smuggled in: the tone groove's own width,
the labels' language (the row stays English, hints are Russian — same split as
E-era coach copy), and any change to what Split sends to the kernel.
