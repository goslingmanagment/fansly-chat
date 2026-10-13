# Notes fill that merges and shows its sources: the AI rewrites the questionnaire without losing what the chatter wrote

Date: 2026-10-13. Owner-approved direction (chat, 2026-10-13): release A of
the "make the AI notes really useful" brainstorm, features 1 (merge instead of
overwrite) and 2 (a quote per fact), shipped together because they change the
same prompt and the same panel. The owner's verdicts on the others: the «Что
нового» dated note (release B), the fan's local time and the questionnaire in
replies (release C) are in, each with its own spec; «Не забудь» and «кому
продать сет» are dropped.

Status: design agreed, implementation started 2026-10-13.

Repos: `~/code/1-platform/hub` (Core, the kernel: contract, prompt) and
`~/code/1-platform/fansly-chat` (this extension: request, merge, panel).
Builds on E157 (notes panel) and E159 (`fan-notes-fill`).

## 1. Problem

E159 sends Core the questionnaire's labels only. The model answers every field
from the chat without seeing what the chatter recorded, and the panel offers
every difference as «было → станет». On a real fan (owner's screenshot,
2026-10-13) that gave five rewrites:

- Each rewrite buried a real new fact (night shifts 4 on 4 off, born in New
  Zealand, Cities Skylines 2 / Knockout / NRL, Advanced $50, content he likes)
  inside a Russian retelling of the old value.
- Accepting a rewrite erased what the model never saw: «Характеристика» held
  the fan's biography (Māori and Dutch, Japan at the end of the year, a past
  trip around Europe), the prompt defines that field as "what he likes and
  pays for", so «Заменить» would drop the biography. «Медиа: Sexting 1» (a
  chatter's marker) would be replaced too.
- Translation-only differences («Australia, Brisbane → Брисбен, Австралия»)
  are noise the chatter has to read and dismiss.

## 2. Owner rulings (2026-10-13)

1. The questionnaire's values may travel to Core: into `fan-notes-fill` (this
   spec) and into replies (Reply/Coach, a separate later feature). The custom
   name (12002) and every other note never travel. This narrows E157's "never
   in a prompt" and E159's "only the labels travel" for the questionnaire only.
2. Rewriting a filled field is fine whenever the result is better; the chatter
   approves every replacement. Losing what was recorded is not fine: an
   important fact that fits no field goes to «Другое» rather than disappear.
   Only when a fact clearly deserves a line of its own may the AI propose a
   field it names itself; the chatter keeps that line or moves it into
   «Другое» with one click (second round, same day).
3. Everything the AI writes is in Russian (names, places and brands as the fan
   wrote them).
4. The template gains «График», «Планы и даты» and «Другое».
5. New lines (template fields the note lacks, the AI's proposed fields) go
   straight into the draft, like empty fields are filled today; only rewrites
   of filled fields stay suggestions. (Mockup with both options shown, "сразу
   в черновик" chosen.)
6. The custom name is not touched by the AI.
7. Each fact the AI adds comes with the fan's own words, so the chatter checks
   it without rereading the chat (feature 2). A quote is shown while
   reviewing, never saved into the note.
8. Facts that go stale (where he lives or stays, his job, his schedule, his
   plans) carry the month he said them, so a later reader (the chatter, and
   in release C the Reply prompt) can judge whether they still hold. No fixed
   age threshold: the reader judges by the situation.

## 3. Goals and non-goals

Goals:

1. The model sees the current values and rewrites a filled field only when the
   chat adds to it or a fact in it belongs elsewhere; a field with nothing new
   comes back unchanged and produces no suggestion.
2. No fact of the current questionnaire is lost by accepting all suggestions,
   except what the fan himself later contradicted.
3. Facts with no field land in a template field the note lacks («График»,
   «Планы и даты», «Другое»); rarely, in a field the AI proposes, which the
   chatter keeps or moves into «Другое».
4. Every new or rewritten value comes with up to three quotes of the fan's
   own words; the extension finds each in the chat it sent and shows its date,
   or marks it «не нашлось в переписке».
5. Released clients (2.10.1) keep working unchanged: a request without
   `noteValues` gets today's prompt byte for byte.

Non-goals:

- The dated «Что нового» note, the questionnaire in Reply/Coach, the fan's
  local time (separate specs).
- Highlighting added lines inside the editor: it is a plain textarea; the
  notice names the added lines instead.
- Per-suggestion provenance ("moved to «Другое»") and any automatic check that
  a rewrite kept every fact. The guarantee is the prompt plus the added lines
  already in the draft; the chatter still sees «было → станет» before
  accepting.
- The custom name and free (non-questionnaire) notes.

## 4. Design

### 4.1 Contract (Core)

`POST /api/v1/ai/features/fan-notes-fill` gains an optional `noteValues`:

- An array index-aligned with `noteFields`, same length (400 `bad_request`
  otherwise). `""` for an empty field and for a template field the note does
  not have yet.
- Each value trimmed, 0–2 000 UTF-16 code units, no line break (`\r`, `\n`,
  U+2028, U+2029): a questionnaire value is one line of the note. Any
  character otherwise, including `<`, `>`, `&` (escaped in the prompt like all
  untrusted text).
- Refused on every other feature (`<feature> does not accept noteValues`).
- Present (merge mode): the prompt of 4.2. Absent (legacy mode): today's
  prompt byte for byte, pinned by a digest test; 2.10.1 sends no
  `noteValues`. The new texts ride slots of the one template that render
  empty, or today's text, in legacy mode.
- A new client sends `noteValues` on every fill, also when every value is
  empty (a new questionnaire), so it always gets merge mode.
- `AI_FEATURE_STREAM_BODY_LIMIT_BYTES` stays; the measured worst case in
  `tests/contracts-coach-body.test.ts` grows by 30 × 2 000 code units.
- `docs/ai-gateway-contract.md` documents the field next to `noteFields`.

### 4.2 Prompt (Core, `fan-notes-fill` template, merge mode)

The task block lists each field with its current value:

```
<note_fields>
Имя: Ethan
Локация: Australia, Brisbane
График:
…
</note_fields>
```

Rules added (wording is Core's; the substance is fixed here):

- A current value is what the chatter recorded. He may know it from outside
  this chat, so it stays true unless the fan himself contradicts it later in
  the conversation.
- When the chat adds nothing to a field and nothing in it has to move, output
  the current value exactly as given, character for character, even if it is
  in English.
- Otherwise rewrite the field in Russian: every fact of the current value
  (translated, names, places and brands as written) plus the new ones. A fact
  the fan contradicted is replaced by his latest statement.
- A fact of the current value that belongs to another listed field by the
  field definitions may move there; one that fits no listed field moves to
  «Другое». It must appear somewhere in the answer. Nothing of a current value
  is dropped except what the fan contradicted.
- Text in a current value the model does not understand (a chatter's marker
  like «Sexting 1») stays in its field verbatim.
- An empty current value is filled from the chat, as today.
- Facts that go stale (where he lives or stays, his job, his schedule, his
  plans) carry the month and year he said them, in parentheses
  («Флорида (08.2026)»), when the transcript's day lines give it. A dated
  fact the fan restated later takes the later date.
- «Локация» reads «город, штат или регион, страна» as far as he said it
  (release C turns it into his local time).

Transcript: in merge mode the transcript carries day lines `--- YYYY-MM-DD ---`
before the first message of each day (4.3); the prompt says what they are.
They are the only source of dates; the `[HH:MM]` prefix stays as it is.

Field definitions added to the existing ones («Характеристика», «Медиа»,
«Фетиши» unchanged, E159):

- «График»: when he works, sleeps and is free, as he told it (shifts, days
  off, hours).
- «Планы и даты»: upcoming events and dates he mentioned (trips, birthday,
  interviews, holidays) with the date or period he gave.
- «Другое»: important facts about him that fit no other field (origin,
  family, pets, health, a big life event). Only what matters for talking to
  him; never small talk.

Proposed fields: after the listed fields the answer may add at most two
lines `+ Label: value`, only for a fact (or a group of facts) substantial
enough that a chatter would want a line of its own, whether moved out of a
current value or new from the chat. A listed field, «Другое» included, is
always preferred when one fits. The label is Russian, one to three words, not
equal (case-insensitively) to any listed label, and follows the label rules
(no `:`, `<`, `>`, `&`, line break; at most 60 code units).

Quotes: after a field line (or a `+` line) whose value is new or differs
from the current value, zero to three lines `> «…»`, each a verbatim fragment
of one of the fan's own messages (a line marked Fan:) that states a fact of
that value, in the fan's language, at most 200 characters, cut only at its
ends. No quote for a value returned unchanged, and none for a fact taken from
the bio or the spending data (those have no message to quote).

Output format: one `Label: value` line per listed field in the listed order,
each followed by its `>` quote lines, then zero to two `+ Label: value` lines,
each followed by its `>` quote lines; nothing else.

### 4.3 Extension: request

- `FAN_NOTE_TEMPLATE_TEXT` (`src/shared/fan-notes.ts`) becomes: Имя, Локация,
  Возраст, Работа, График, Хобби, Планы и даты, Фетиши, Характеристика, Медиа,
  Другое.
- `noteFields` = the note's labels in note order, then the template labels the
  note lacks (compared like labels today: trimmed, NFC, case-insensitive), in
  template order. At most 30 (Core's bound, and `parseNoteTemplate`'s): the
  missing template labels are dropped from the end of the template order
  first, so template additions never push a questionnaire past 30 fields
  (proposed fields: 4.4).
- `noteValues` = the note's value per label, `""` for the appended template
  labels.
- A field whose value is over 2 000 code units is left out of the request
  entirely and never touched by the merge (a truncated value would invite a
  rewrite that drops its tail).
- The custom name and other notes are never read into the request (unchanged).
- The transcript (`clientContext.transcript`) gets a day line
  `--- YYYY-MM-DD ---` before the first message of each day, in the same
  clock as the `[HH:MM]` prefixes (the browser's), only for this feature and
  only in merge mode. The kernel-bound budget (oldest lines dropped first)
  counts the day lines; a day line is never left without a message after it.
  `clientContext.messageCount` still counts messages.

### 4.4 Extension: parse and merge

`parseFilledFields` also returns, per field and per proposed field, the
quotes of the `> «…»` lines that follow it (up to three, the guillemets
stripped; a `>` line before any field line, or a fourth, is ignored).

It also returns proposed fields: lines `+ Label: value` with
a non-empty value; up to five (the prompt asks for at most two, but a model
that writes a third may have moved a fact there, and dropping that line would
lose it; past five the answer is treated as runaway and the rest is ignored).
A proposed field whose label is invalid, equals an asked label or a label
already in the note, or that would take the questionnaire past 30 fields is
not dropped: it goes into «Другое» as below.

`mergeFilledFields`:

| Answer for | Result |
|---|---|
| note field, empty, non-empty answer | filled in place (today) |
| note field, filled, same value (whitespace/case-insensitive, after decoding `&lt; &gt; &amp;`) | nothing |
| note field, filled, different | suggestion «было → станет» (today) |
| template label the note lacks, non-empty answer | new line appended |
| proposed field | new line appended, after the template ones, with «В Другое» |

New lines go right after the last field line of the questionnaire (free text
below it stays below), template additions first in template order, then
proposed fields in answer order.

«В Другое» on a proposed field removes its line and appends `Label: value` to
«Другое» with «; » (creating the «Другое» line at the template position if the
draft has none). If «Другое» has a pending suggestion, the same text is
appended to both its «было» and «станет», so the suggestion stays applicable.
The fallback for an unusable proposed field (above) is the same append, done
by the merge itself. `applyFieldSuggestion` and
«Заменить все» keep their rule: a suggestion applies only while the field
still holds the value it was made for.

### 4.5 Panel copy

- Notice: «Заполнено полей: N. Добавлены строки: График, Другое.
  Предложений: K. Проверьте и сохраните.» (parts with zero omitted; nothing at
  all keeps «В переписке не нашлось ничего нового для анкеты.»).
- Each proposed field gets a row under the notice: «Гусь завёл поле
  «Происхождение»» with the button «В Другое»; the row disappears once
  clicked or once the line is gone from the draft.
- Quotes. Under each «было → станет» suggestion, its quotes as muted lines:
  «14.09.2026 · I work nights, 4 on 4 off». For fields filled in place, added
  template lines and proposed fields, a collapsed «Откуда Гусь это взял (N)»
  under the notice lists «Label — date · quote». A quote not found in the
  chat reads «не нашлось в переписке · …» instead of a date, so an invented
  fact stands out. Quotes live in the panel until the next fill or until the
  editor closes; they are never written into the note.

### 4.5a Extension: locating quotes

The extension keeps the normalized messages of the transcript it sent for
the fill. A quote is found when its text, normalized (NFC, case folded,
whitespace collapsed, typographic quotes and apostrophes and dashes mapped to
ASCII), is a substring of one Fan: message's text normalized the same way;
the date shown is that message's (the newest such message when several
match). The lookup happens where those messages live (the background), and
the panel gets `quote → date | null` with the fill's result.
- Suggestions title: «Гусь предлагает переписать:» (was «В чате нашлось
  другое — заполненные поля Гусь не трогал:»).
- «✨ Заполнить из чата» tooltip: «ИИ дополнит анкету по всей переписке:
  заполнит пустые поля, допишет новые строки, переписать заполненные
  предложит».
- Copy checked against `copy.ts` vocabulary at implementation time.

### 4.6 Edge cases

- A questionnaire at 30 fields: no template additions; a proposed field goes
  into «Другое» if the note has it, else the fact stays where it was (the
  model's rewrite of that field is still only a suggestion).
- The chatter typed a label that matches a template label with other case:
  matched, no duplicate line.
- «Другое» already filled: a fact moved there arrives as a rewrite of
  «Другое». Accepting the source field's rewrite but not this one drops the
  fact; accepted by the owner (the chatter approves every replacement,
  «Заменить все» takes both).
- The model translates an unchanged value anyway: an ordinary suggestion
  (noise, caught by the eval below), never data loss.
- The fill is stopped or fails: nothing changes (today).
- Nothing is saved to Fansly until «Создать»/«Сохранить» (today; AI never
  writes a note by itself).

### 4.7 Compatibility and rollout

Order, as E160: Core PR (contract + prompt + tests) merged and deployed
dist-only to agency-de; production health answers the new contract and keeps
the released SDKs in `compatibleClientSdks`; then the SDK is re-vendored from
the deployed commit and the extension ships. The extension sends
`noteValues` only after the re-vendor, so no window exists where a client
sends a field Core refuses.

## 5. Testing

- Extension unit tests (`tests/`): request building (template labels appended
  and capped, values aligned, long values excluded), day lines in the fill
  transcript (budget, no orphan day line, legacy feature unchanged), quote
  parsing and location (normalization, newest match, not found), merge table
  rows above,
  insertion point, entity decoding in the comparison, `+` parsing (cap,
  invalid and duplicate labels, preamble), the «В Другое» move with and
  without a pending «Другое» suggestion.
- Core: contract tests (length mismatch, line breaks, bounds, refused on other
  features, absent = old behavior), body-limit worst case, templates sync,
  `tests/ai-fan-notes-fill.test.ts` for the new task block, and a digest pin
  proving a request without `noteValues` renders today's prompt byte for
  byte.
- Prompt eval on a synthetic fixture modelled on the 2026-10-13 screenshot
  (no real fan data in the repos): a filled questionnaire whose
  «Характеристика» holds a biography and «Медиа» a marker, a chat that adds
  shifts, hobbies and preferences. Pass: unchanged fields come back verbatim;
  every fact of the old values is present somewhere in the answer; the
  biography lands in «Планы и даты» and «Другое» (or one proposed field);
  «Sexting 1» survives; at most two `+` lines; every quote is a verbatim
  fragment of a Fan: line; a stale-prone new fact carries its month.
- Live check on Fansly by the owner or a chatter on a real filled
  questionnaire before the release is called done (E159's fill itself was not
  verified live either).

## 6. Records

- Extension: one E entry (number taken from `origin/main` at implementation)
  for the merge, recording ruling 1 as a narrowing of E157/E159; one for the
  release.
- Core keeps no decision log (its AGENTS.md): the change is recorded in the
  `fan-notes-fill` note of `prompt-manifest.json`, in
  `docs/ai-gateway-contract.md` and in the PR.
