# Voice: entering a NEW attempt — attach completes the session, explicit new-from-draft

**Date:** 2026-07-24 · **Status:** owner-approved direction, spec for review
**Owner symptom:** typed a fresh message in the Fansly composer, pressed 🎙 — the
panel reopened the PREVIOUS attempt (already attached), with no path to "make a
voice from this new text".

## Why it behaves this way today

- A successful attach only marks the take `attached: true`; the attempt stays
  live in custody and `openVoicePanel()` deliberately reopens it without
  re-reading the draft (paid takes must not be silently discarded).
- The ↺ control restores the attempt's ORIGINAL draft into the script — there
  is no control anywhere that reads the CURRENT composer text while an attempt
  exists.

## Decisions (owner, 2026-07-24)

1. **A confirmed attach COMPLETES the session.** An attached voice is delivered
   work; the Fansly thread is now the source of truth.
2. **While an unfinished session lives, 🎙 opens it** (paid work stays visible),
   with a prominent explicit «+ Новый войс из черновика» action inside.
3. **One live session per conversation.** A new voice displaces the old one only
   through an explicit confirmation when paid unattached takes exist.

## Behavior specification

### 1. Attach completion

- Trigger: the attach outcome `confirmed` (existing adapter outcome; `uncertain`
  and `aborted` are NOT completion — their current re-arm/verify paths are
  unchanged).
- Controller gains `completeAttempt()`: stop polling, revoke blob URLs, remove
  the stored custody record for this attempt (existing discard machinery — no
  new storage semantics), release the in-memory controller.
- Panel: studio collapses if open (existing close path), panel closes, toast
  `«Войс прикреплён»` (tone: success).
- All other takes of the completed attempt retire with it. Rationale: the
  chatter chose a take and delivered it; keeping siblings alive is what caused
  the reopen confusion. (The takes remain server-side artifacts until their
  server expiry — nothing money-bearing is destroyed; only client custody ends.)
- Next 🎙 click: no session exists → the existing fresh-start path runs (draft
  gate included: empty composer → existing toast «Напишите черновик…»).

### 2. «+ Новый войс из черновика» inside a live session

- Placement: full-width row at the bottom of the лента panel, below takes,
  above the attach region; styled like the existing «+ Ещё вариант» action
  (secondary, clay text) but clearly separated — it ends THIS session.
- Label: `+ Новый войс из черновика`; when the live composer draft is empty at
  render time the row is disabled with hint text
  `Напишите черновик в поле Fansly` (re-evaluated on panel open/render, and at
  click time — click re-reads the LIVE draft).
- Click, when the session has NO completed-and-unattached takes (script-only,
  or all takes failed/expired): immediately discard the current attempt
  (existing `discardAllStoredAttempts`) and `startScript(liveDraft, 'none')`.
- Click, when completed unattached takes exist: the row expands INLINE (no
  modal) into a confirm:
  `Вариант N не прикреплён и будет закрыт. Начать новый войс?`
  `[Начать новый]  [Отмена]`
  — «Начать новый» is the explicit human action required by family law before
  paid work leaves the screen. There is no auto-timeout; Отмена collapses the
  row back.
- The studio mirrors the same row (it borrows panel nodes — no extra work
  expected beyond layout verification).

### 3. Unchanged

- One-session-per-conversation custody model, idempotency machinery, TTLs,
  route binding, recovery-after-reload, the ↺ restore-source control, the
  draft gate for the no-session case, «+ Ещё вариант» (new take, same script).
- No storage schema change; completion and displacement ride the existing
  discard paths.

## Edge cases

- Attach `confirmed` arriving while the studio is expanded: collapse first
  (existing `closeVoicePanel` ordering), then teardown + toast.
- Attach `uncertain` → later manual «проверить» resolves to attached: the
  status/reconcile view marks the take attached but does NOT auto-complete the
  session (no surprise closures without a user action); the next explicit
  panel interaction with an all-attached attempt shows the new-from-draft row
  as the primary action.
- New-from-draft clicked while a take is still generating (`queued`/
  `dispatched`): the confirm text includes the generating take
  (`Вариант N ещё генерируется…`); starting new aborts the script stream per
  the existing route-invalidation path — the paid-create custody rules already
  cover in-flight takes (indeterminate stays indeterminate, never silently
  refunded).
- Composer draft identical to the current attempt's source: no special case —
  the user asked for a new session; start it.

## Tests

- `confirmed` attach → custody record removed, panel closed, toast shown;
  subsequent boot recovers nothing; 🎙 starts from the draft.
- `uncertain` attach → session survives (existing tests keep passing).
- New-from-draft: disabled on empty composer; immediate start when no paid
  unattached takes; inline confirm when they exist; Отмена keeps the session
  byte-identical; confirm discards custody and starts from the LIVE draft
  (not the old source).
- Generating take present → confirm mentions it; start aborts the stream.

## Non-goals

- Multiple parallel sessions per chat, a take history/library UI, changing any
  paid-custody or idempotency semantics, server-side changes (none required).
