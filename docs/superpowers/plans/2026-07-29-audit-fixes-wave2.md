# Audit Fixes Wave 2 — Implementation Plan

**Goal:** Fix 8 verified findings from the 2026-07-28 pre-demo audit: surface layering lies, coach UX honesty, a dead paid voice take, English popup, timeout misclassification, status-pane honesty, and voice capability blocking first paint.

**Architecture:** All changes live in the extension (`/Users/dmitriy/code/chatgoose`), no kernel changes, no contract changes, no storage-schema changes. Each task is one worktree → one branch → one PR, executable in parallel — tasks share no new APIs. Base: `origin/main` at `48a9fb7` or later.

**Tech stack:** Plain TS + esbuild, vitest + jsdom (`tests/`), no frameworks in content scripts.

## Global Constraints (verbatim, every task)

1. **Worktree only.** From `/Users/dmitriy/code/chatgoose` run:
   ```bash
   git fetch origin
   git worktree add /Users/dmitriy/code/.worktrees/chatgoose/<slug> -b ai/<slug> origin/main
   ln -s /Users/dmitriy/code/chatgoose/node_modules /Users/dmitriy/code/.worktrees/chatgoose/<slug>/node_modules
   ```
   Never edit the primary checkout. Never touch `/Users/dmitriy/code/core`. Never touch `vendor/kernel-sdk` (the node_modules symlink is safe ONLY because you don't).
2. **`pnpm check` green** (typecheck + lint + gates + 1849+ tests + build) inside the worktree before committing. CI enforces it on the PR.
3. **Push + open PR, do NOT merge:**
   ```bash
   git push -u origin ai/<slug>
   gh pr create --title "<RU title>" --body "<RU body>"
   ```
   Report the PR URL. The PR will get an external codex review before merge — write the PR body for a reviewer with zero context.
4. **RU copy vocabulary:** user-facing strings say «ядро» / «хаб» / «Agency Hub», never «кернел». Match the tone of existing strings in `src/options/copy.ts`. Russian UI copy, English code comments.
5. **Family law stays intact:** AI never sends without explicit human action; a truncated stream is an error, never a result; fail-closed on any doubt. Tasks 6 and 8 touch these paths — preserve the invariants and say so in tests.
6. **When flipping a test that pinned the old behavior,** the new test's comment must state that the old pin WAS the bug (see `tests/voice-attempt-controller.test.ts` «a tone preset never erases a completed paid take» for the house style).
7. Do not edit `docs/decisions.md` (these are bug fixes, not decisions). Do not bump versions. Do not touch `CHANGELOG.md`.
8. Commit style: RU one-line summary + RU body explaining the user-visible lie being fixed. End with:
   ```
   Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
   ```

Line anchors below were verified on `main@48a9fb7`. If a file drifted, re-locate by the quoted code, not the number.

---

### Task 1: Toasts above every scrim + hotkey gate under reference surfaces

**Slug:** `260729b-toast-hotkey-layers`

**Files:**
- Modify: `src/content/styles.css:857` (`#chatgoose-toast-root`, z-index 2147483645), `:2257` (`#chatgoose-cheatsheet-root`, 2147483647)
- Modify: `src/content/index.ts:778` (`dispatchHotkey`)
- Test: `tests/content-app.test.ts` (hotkey dispatch), new `tests/styles-layering.test.ts`

**Interfaces:**
- Consumes: `this.cheatsheet.isOpen(): boolean` (`src/content/cheatsheet-controller.ts:48`), `this.board.isOpen(): boolean` (`src/content/spenders/spenders-board-controller.ts:141`), `this.toast.show(...)`.
- Produces: nothing other tasks rely on.

Current lie #1: toast root (2147483645) sits UNDER the coach overlay scrim (`#chatgoose-overlay-root`, 2147483646, backdrop `pointer-events: auto`) — every toast shown while coach is open is dimmed and unclickable, and «Рекап ▾ → Обновить переписку»'s ONLY feedback is a toast. Current lie #2: `dispatchHotkey` starts paid generations while the cheatsheet (2147483647) or spenders board (2147483646) covers the result surface — `⌘⇧E` from an open cheatsheet spends quota blind.

- [ ] Step: styles.css — re-band the whole z map so toasts are STRICTLY topmost and every other relative order is preserved. Root creation order matters: the toast root is created EARLIEST (content boot), the cheatsheet/board/voice roots later — at an equal z-index a later sibling wins, so toast must not tie with anything. New map (each value strictly distinct per band):
  ```css
  #chatgoose-toast-root        { z-index: 2147483647; } /* was ...645 — feedback is always visible and clickable */
  #chatgoose-cheatsheet-root   { z-index: 2147483646; } /* was ...647 — still above overlay/board/voice, below toasts */
  #chatgoose-overlay-root      { z-index: 2147483645; } /* was ...646 */
  #chatgoose-board-root        { z-index: 2147483645; } /* was ...646 — keeps its current DOM-order tie with overlay */
  #chatgoose-voice-studio-root { z-index: 2147483645; } /* was ...646 — same band, same DOM-order semantics as today */
  #chatgoose-launcher-root     { z-index: 2147483644; } /* unchanged */
  ```
  This preserves today's cheatsheet-above-everything-but-toasts and the existing overlay/board/voice DOM-order ties, and ONLY moves toasts to the top. Do not introduce mutual exclusion of cheatsheet/board in this task.
- [ ] Step: `dispatchHotkey` — gate feature-starting actions while a reference surface is open. `'cancel'` MUST pass through: the cheatsheet/board toggles have no busy-guard, so a generation can be live under an open sheet, and `cancelActiveOperation` legitimately cancels recap chains, coach turns, compare and plain ops — swallowing it would trap the user with a running paid op they can't stop:
  ```ts
  // A reference surface (cheatsheet / spenders board) covers the result
  // surfaces. Starting a paid generation under it spends quota blind — the
  // loader and result render beneath the sheet. The surfaces' own toggles and
  // CANCEL pass (an operation can already be running under the sheet);
  // feature-starting actions are swallowed with an explanation.
  const referenceSurfaceOpen = this.cheatsheet.isOpen() || this.board.isOpen();
  if (
    referenceSurfaceOpen &&
    action !== 'cheatsheet' && action !== 'spenders-board' && action !== 'cancel'
  ) {
    this.toast.show('Сначала закройте справку (Esc) — панель ChatGoose под ней не видна.', {
      tone: 'warning',
    });
    return true; // handled: never fall through to a browser default
  }
  ```
  (The toast copy is deliberately about the PANEL, not «генерация» — the gate also swallows the free `cycle-tone` toggle, and a message about paid generation would lie for it. `cancel` maps to the letter `x`; Esc closes the cheatsheet through its own document listener, not through this keymap — so excluding `cancel` here never traps Esc.)
- [ ] Step: new `tests/styles-layering.test.ts` — parse `src/content/styles.css` with a regex over `#chatgoose-*-root { ... z-index: N }` blocks and assert: toast STRICTLY greater than every other root; cheatsheet strictly greater than overlay/board/voice-studio; launcher strictly least. This pins the layering contract that jsdom cannot render.
- [ ] Step: hotkey tests — the existing `dispatchHotkey` tests live in `tests/coach-orchestration.test.ts` (4 usages; NOT in content-app.test.ts — an earlier draft of this plan was wrong about that). Add there: (a) with cheatsheet open, a feature hotkey action does NOT call `startFeature` (spy) and shows the warning toast; (b) `'cheatsheet'`/`'spenders-board'` still toggle while open; (c) a RUNNING operation + open cheatsheet + `'cancel'` action → the cancel is dispatched (operation:cancel sent), not swallowed.
- [ ] Verify: `pnpm check` green in the worktree.
- [ ] Commit: `fix(content): тосты поверх всех скримов; хоткеи не стартуют генерацию под шпаргалкой`

---

### Task 2: Coach opens ready-to-type and refuses honestly

**Slug:** `260729c-coach-open-honesty`

**Files:**
- Modify: `src/content/index.ts:1949` area (`openCoach`) and `submitCoachQuestion` (the orchestrator's async method; note `sendCoachTurn` itself is SYNCHRONOUS — `private sendCoachTurn(` — searching for `async sendCoachTurn` finds nothing)
- Modify: `src/content/overlay/overlay-controller.ts` (`createCoachView` — search `composerTextarea`, and the recap-picker focus precedent at `queueMicrotask(() => full.focus())`)
- Test: `tests/coach-overlay.test.ts`, `tests/coach-orchestration.test.ts`

**Interfaces:**
- Consumes: `this.ensureFeatureCanStart(feature): boolean` (`src/content/index.ts:1258`) — shows the reason toast itself and returns false.
- Produces: `OverlayController.focusCoachComposer(): void` (new public method, used only by `openCoach`).

Current lies: `openCoach()` promises "open/focus" in its doc comment but never focuses — after `⌘⇧C` the DOM focus stays in the Fansly composer and the next keystrokes go UNDER the overlay. And coach is the only feature whose dispatch path skips `ensureFeatureCanStart`: on an unmapped account the hotkey opens a live-looking panel whose submit then fails in the background with a bare code.

- [ ] Step: `overlay-controller.ts` — in `createCoachView`, after the composer textarea is created and attached, add:
  ```ts
  // Spec §3 "open or focus": the panel opens ready to type. Only on CREATE —
  // updateCoachView re-renders must never steal focus mid-conversation.
  queueMicrotask(() => view.composerTextarea.focus());
  ```
  Add public method:
  ```ts
  /** Re-focus the coach composer of an already-open coach view (spec §3
   * "focus if open" — openCoach on an open session). No-op otherwise. */
  focusCoachComposer(): void {
    if (this.currentView?.kind === 'coach') {
      this.currentView.composerTextarea.focus();
    }
  }
  ```
  (Adjust to the file's actual view-holder field name — search `currentView`.)
- [ ] Step: `openCoach()` — in the already-open early-return branch (comment «Already streaming or idle-open: just re-render to focus»), call `this.overlay.focusCoachComposer()` after `renderSurfaces()`. In the fresh-open path, add the precondition gate after the existing account/group check:
  ```ts
  // Coach rides the same preconditions as every generation (hub transport,
  // catalog, mapping, connection). The button bar already refuses for these
  // reasons; the hotkey must not open a panel whose submit is doomed to a
  // bare background error.
  if (!this.ensureFeatureCanStart('coach-chat')) {
    return;
  }
  ```
- [ ] Step: the submit-time backstop goes into `submitCoachQuestion` (the orchestrator method in `src/content/index.ts`), NOT as a bare `return` deeper in the pipeline. Critical mechanic: the RENDERER clears the textarea BEFORE `onCoachSubmit` fires (`overlay-controller.ts` `submitCoachQuestion`: `textarea.value = ''` → `onCoachSubmit`), so any refusal after that point must restore the question or it is silently eaten. The orchestrator already owns the exact rollback — `abortCoachSubmit(session, trimmed, opts)` (`src/content/index.ts`, search `private abortCoachSubmit`) which restores the composer text and the draft-read intent; the existing `another_operation` branch in `submitCoachQuestion` is the house pattern to mirror. Add, after the existing rechecks and BEFORE the auto-recap/`sendCoachTurn` dispatch:
  ```ts
  if (!this.ensureFeatureCanStart('coach-chat')) {
    // ensureFeatureCanStart already showed the reason toast. The renderer
    // cleared the textarea before onCoachSubmit — put the question back
    // exactly like the another_operation refusal above does.
    this.abortCoachSubmit(session, trimmed, opts);
    return;
  }
  ```
  The test must assert the question is BACK in the composer and the draft-read intent survived — not merely that nothing was sent.
- [ ] Step: focus-steal guard — a coach view is also re-CREATED when a covering deep overlay closes (renderBody sees `currentView.kind !== 'coach'` and rebuilds; Task 3's Esc fix makes that path more common). Auto-focusing there is acceptable UX (the coach just became the visible surface), but it must never steal focus from an element INSIDE the overlay: wrap the microtask in a check — focus only when `document.activeElement` is body/null/outside the overlay root. Then run the existing focus tests around the recap menu (`tests/coach-overlay.test.ts` ~1268-1301) — they must stay green.
- [ ] Step: tests. (a) `coach-overlay.test.ts`: after rendering a fresh coach model, `document.activeElement` is the coach composer textarea (flush microtasks; jsdom supports focus); a subsequent `updateCoachView` render with focus moved elsewhere does NOT steal it back. (b) `coach-orchestration.test.ts`: `openCoach()` on a state with `mappedPersonalityId: null` shows the `no_mapping` toast and leaves `coachOverlayModel` null; a gated submit restores the question (see the submit-time step). Place the new `it()` blocks next to the hotkey-arm tests (~line 693 area) — Task 3 adds its tests elsewhere in the same file (~542 and ~1237), keeping the two PRs textually merge-safe.
- [ ] Verify: `pnpm check` green.
- [ ] Commit: `fix(coach): фокус в композере при открытии; ⌘⇧C уважает предусловия — честный отказ вместо голого кода`

---

### Task 3: No dead coach panel on account switch; Esc closes what's visible

**Slug:** `260729d-coach-stale-esc`

**Files:**
- Modify: `src/content/index.ts` — the `personaChanged || accountChanged` branch (search `personaChanged || accountChanged`, around the `case 'mapping:changed'` handler), and the overlay `onClose` at `src/content/index.ts:571-612`
- Test: `tests/coach-orchestration.test.ts` / `tests/content-app.test.ts` (whichever already exercises `mapping:changed`)

**Interfaces:** consumes nothing new; produces nothing.

Current lies: (a) the `personaChanged || accountChanged` branch tears the coach store down (`resetAll`, `closeCoach`) but re-renders surfaces only when `personaChanged` — an account-only change (background resolves the canonical accountId and refreshes with `'mapping:changed'`, `operations.ts:780`) leaves the DEAD coach panel of the previous account on screen, scroll-lock included. (b) In overlay `onClose`, the idle-coach branch (`if (this.coachOverlayModel)`, `index.ts:602`) runs BEFORE `this.deepOverlayModel = null` — with a completed recap rendered ABOVE an idle coach, the first Esc closes the invisible coach and visibly does nothing.

- [ ] Step: the handler's tail already contains the render — it is just gated on the wrong condition. Verified on main@48a9fb7, the `mapping:changed` case ends with:
  ```ts
  void this.mappingBanner.render(message.state.accountId, Boolean(message.state.mappedPersonalityId));
  if (personaChanged) {
    this.renderSurfaces();
  }
  this.renderButtonBar();
  ```
  The fix is exactly:
  ```ts
  if (personaChanged || accountChanged) {
    // An account-only change (background resolving the canonical accountId,
    // operations.ts refreshTabState('mapping:changed')) tears the coach state
    // down above but used to skip this render — leaving the DEAD panel of the
    // previous account on screen, scroll-lock included.
    this.renderSurfaces();
  }
  ```
- [ ] Step: overlay `onClose` — before the `if (this.coachOverlayModel)` idle-coach branch, close a VISIBLE deep overlay first:
  ```ts
  // A completed deep result (e.g. recap opened over an idle coach via ⌘⇧S)
  // renders above the coach panel — Esc must close what the user sees, not
  // the invisible coach beneath it. Verify against surface-planner precedence.
  if (this.deepOverlayModel && this.coachOverlayModel) {
    this.deepOverlayModel = null;
    this.renderAll();
    return;
  }
  ```
  Precedence is confirmed: the planner renders ONE overlay surface and a completed deep model REPLACES an idle coach (`surface-planner.ts:136-153`, pinned by `surface-planner.test.ts:220`) — «above» is model-level, not DOM stacking; word the code comment accordingly. The recap-picker and live-chain branches above must stay untouched.
  Side effects the new branch must NOT skip: today closing a deep overlay through the tail also disarms the armed reply tone (E24: «closing a surface disarms the tone», tail of onClose ~607-615) — call `this.resetNextReplyTone()` in the new branch too, and run the E24 pins (`tests/content-app.test.ts:678, :707`). Evaluate `clearOperationState(true)` deliberately: with an idle coach beneath, blindly clearing operation state may wipe coach-adjacent state — replicate ONLY the tone disarm unless a failing E24/behavior test proves more is needed, and say which in the PR body.
- [ ] Step: test placement — put the account-change case next to the existing mapping test (`tests/coach-orchestration.test.ts` ~542) and the Esc-ordering case next to the chain-teardown tests (~1237). Task 2 adds its tests near the hotkey-arm block (~693) — disjoint regions keep the two PRs merge-safe.
- [ ] Step: tests. (a) simulate `mapping:changed` with a changed `accountId` and unchanged persona while a coach overlay is open → coach store reset AND the overlay DOM is gone/hidden after the handler. (b) open coach idle → open recap picker → complete a full recap (existing helpers in the suite) → first `onClose` hides the recap, coach panel remains; second closes coach.
- [ ] Verify: `pnpm check` green.
- [ ] Commit: `fix(coach): смена аккаунта убирает панель с экрана; Esc закрывает видимую поверхность, а не невидимого коуча`

---

### Task 4: A paid take whose audio failed to download gets a free retry

**Slug:** `260729e-voice-take-recovery`

**Files:**
- Modify: `src/content/voice/voice-panel.ts:1397` (`renderTakeRecovery`), `:1408-1421` (free-check button)
- Modify: `src/content/voice/voice-panel.ts` message handling (search `voice:audioBytes` in the panel; if absent, the controller's `notifyChange` re-render path)
- Test: `tests/voice-panel.test.ts`

**Interfaces:**
- Consumes: `controller.checkStatus(voiceNoteId): boolean` (`src/content/voice/attempt-controller.ts:449`) — free status re-read; on a `completed` view the controller already re-drives the audio fetch (`attempt-controller.ts:987`: `if (view.state === 'completed') this.fetchAudio(record, take)`), and both in-flight guards are cleared on error, so one `checkStatus` call restarts the whole status→audio chain.
- Produces: nothing.

Current lie: a `completed` take whose audio fetch failed (15s timeout, network, 403, sha mismatch) keeps `state === 'completed'` with an `errorCode` and no `blobUrl` — `renderTakeRecovery` returns `null` for it (`needsFreeCheck` covers only `indeterminate`/queued/dispatched, `needsPaidRegen` only indeterminate/failed_after_dispatch/artifact_expired). The chatter paid, sees «Вариант N · –:–» with zero controls, and the error card says «Повторите действие» with nothing to press. Recovery today = reload the tab.

- [ ] Step: extend the free-check predicate:
  ```ts
  const audioMissing = state === 'completed' && !take.blobUrl && Boolean(take.view.errorCode);
  const needsFreeCheck = audioMissing || state === 'indeterminate' || (
    (state === 'queued' || state === 'dispatched') && Boolean(take.view.errorCode)
  );
  ```
  and label the button for this case honestly — «Скачать аудио ещё раз — бесплатно» when `audioMissing`, the existing «Проверить статус — бесплатно» otherwise. Same `checkStatus` handler for both (status→audio chain; the fresh server view arrives WITHOUT the optional `errorCode` field, and the `{...view}` replacement drops the stale code).
- [ ] Step: sticky error card — when the retried audio actually arrives, the panel-level `lastError` from the failed fetch must not sit above a now-working player. The current `lastError` is a bare `UserFacingError` with NO source/take context (`voice-panel.ts`, search `private lastError`) — status/audio errors of DIFFERENT takes collapse into one field, so a naive «clear when any take becomes playable» could erase a still-true error about take A when take B recovers. Do it context-aware: store `lastErrorTakeId: number | null` next to `lastError` (set it where audio/status errors for a specific take set `lastError`; null for non-take errors), and clear BOTH only when the take with that exact id becomes playable. Errors without a take id are never auto-cleared. (An earlier draft claimed a test pins «lastError survives re-renders» — no such test exists; `tests/voice-panel.test.ts` only checks immediate display. Don't go hunting for it.)
- [ ] Step: out-of-scope note (record it in the PR body): the contract also allows `completed` with `audioSha256/audioBytesLen === null`, where `fetchAudio` silently returns `false` and no `errorCode` ever appears — that dead-take variant stays dead after this task. Kernel-side semantics of such a row are unverified; fixing it blind risks a wrong client-side invention. Explicitly deferred.
- [ ] Step: tests. (a) build a completed take, feed a `voice:noteError` with `source: 'audio'` → the take row shows «Скачать аудио ещё раз — бесплатно»; click → `checkStatus` called with the note id. (b) then feed `voice:noteView` (completed, fresh) + `voice:audioBytes` → player renders, the free-retry button disappears, the stale error card is gone.
- [ ] Verify: `pnpm check` green.
- [ ] Commit: `fix(voice): у оплаченного тейка без аудио — бесплатная повторная загрузка вместо мёртвой строки`

---

### Task 5: Popup speaks Russian

**Slug:** `260729f-popup-ru`

**Files:**
- Modify: `src/popup/index.ts` (all user-visible strings; the file is small — read it whole)
- Test: whatever suite asserts popup strings (search `Fansly connected` under `tests/`); update in place

**Interfaces:** none.

The options «Кабинет» is fully Russian; the popup — the FIRST thing anyone opens — is fully English. Translate every user-visible string. Vocabulary: «ядро»/«хаб»/«Agency Hub» (never «кернел»), tone matching `src/options/copy.ts`. The mapping (adjust to what the file actually contains — read it, don't trust this list blindly):

| English | Russian |
|---|---|
| `Couldn't reach ChatGoose. Reopen this popup after it reconnects.` | `Не удалось связаться с ChatGoose. Откройте попап заново после переподключения.` |
| `Open Settings` | `Открыть настройки` |
| `Fansly connected` / `Fansly not connected` | `Fansly подключён` / `Fansly не подключён` |
| `Agency Hub not set up` | `Agency Hub не настроен` |
| `Account` / `No account` | `Аккаунт` / `Нет аккаунта` |
| `Conversation` / `No active chat` | `Диалог` / `Нет активного чата` |
| `AI quota` / `left today` | `Квота AI` / `осталось сегодня` |
| `Used up — resets at 00:00 UTC` | `Исчерпана — обновится в 00:00 UTC` |
| `Copied` | `Скопировано` |
| `Not connected` | `Не подключено` |

- [ ] Step: translate every string; keep `ChatGoose` and `Agency Hub` as proper names; keep data values (IDs, numbers) untouched.
- [ ] Step: two popup strings are NOT in `popup/index.ts` — they are structural sentinels minted by the background popup-status builder in `src/background/runtime-api.ts` (search `'Unmapped account'` / `'Not connected'` in the `accountLabel:` expression). Translate them AT THE SOURCE: `'Unmapped account'` → `'Аккаунт без персоны'`, `'Not connected'` → `'Не подключено'`. These are popup-only (`PopupStatus.accountLabel`); translate ONLY the sentinels, never the data path (`mappedPersonalityName` is user data). Also the copy-button tooltip `` `Copy ${id}` `` in `popup/index.ts` → `` `Скопировать ${id}` `` — it is pinned by `tests/popup.test.ts` (search `Copy `), update the pin.
- [ ] Step: update the pinned strings in the popup test suite (including the runtime-api sentinel pins if any — search both suites for `Unmapped account`); add none.
- [ ] Verify: `pnpm check` green; `grep -n "[A-Za-z]\{4,\}" src/popup/index.ts` output reviewed — remaining Latin is identifiers/proper names only.
- [ ] Commit: `fix(popup): русская копия — попап догоняет «Кабинет»`

---

### Task 6: A local timeout is a timeout, not «поток оборвался», and not a Hub error

**Slug:** `260729g-gateway-abort`

**Files:**
- Modify: `src/background/kernel-feature-gateway.ts:468` (the `if (!done)` fail-closed check; `signal` is in scope — parameter of `streamFeature`, line 298)
- Test: `tests/kernel-feature-gateway.test.ts` (has ZERO abort tests today), comment-only touch in `tests/operations-suite.ts` if needed

**Interfaces:**
- Consumes: existing `resolveAbortChatGooseError` mapping in `src/background/operation-utils.ts:33` — it requires `error instanceof DOMException && error.name === 'AbortError'` and maps armed-timeout aborts to `timed_out` (CG-NET-02).
- Produces: behavior only.

Proven with a live probe during the audit: the vendored SDK swallows aborts (`vendor/kernel-sdk/dist/contracts/sdk-runtime.js:338`: `.catch((error) => { if (abort.signal.aborted) { return; } throw error; })`), so `handle.done` RESOLVES on abort, the gateway sees `done === false` and throws `hub_stream_truncated` (CG-HUB-16) — a plain ChatGooseError that `resolveAbortChatGooseError` ignores. Every LLM-stage timeout (llm-ttfb / llm-idle / llm-max-stream) therefore shows «Генерация оборвалась» instead of «Время ожидания истекло», AND falsely increments the «Ошибки генераций (Hub)» daily counter (`ops-daily.ts` counts `CG-HUB-*` prefixes; CG-NET-02 is not counted). Prep-stage timeouts are fine (fansly-client rethrows the raw DOMException) — the bug is exactly the three LLM timeouts.

- [ ] Step: the SDK's final `.catch` swallows EVERY exception once the signal is aborted (`vendor/kernel-sdk/dist/contracts/sdk-runtime.js`, the `})().catch((error) => { if (abort.signal.aborted) { return; } throw error; })` tail) — including the gateway's own terminal-error-frame throw when the abort races the teardown. So a naive «if aborted → AbortError» would misreport a REAL kernel error frame as a timeout. The fix needs a gateway-side capture. In `streamFeature`:
  1. Where the gateway's frame handler throws the mapped kernel error for a terminal `error` frame, FIRST record it: `terminalFrameError = mapped;` (a `let terminalFrameError: unknown = null` in the closure), then throw as today. The mapping itself does not change.
  2. After `await handle.done` (which, thanks to the SDK swallow, RESOLVES both on abort and on a swallowed frame error), classify in this exact order:
  ```ts
  if (terminalFrameError !== null) {
    // The kernel spoke: its terminal error frame outranks both the abort and
    // the truncation verdicts — the SDK's abort-swallow must not eat it.
    throw terminalFrameError;
  }
  if (!done) {
    if (signal.aborted) {
      // The vendored SDK swallows aborts, so an aborted stream arrives here
      // as a resolved handle with no terminal frame. Re-raise as AbortError
      // so operation-utils maps it honestly (timed_out for armed timeouts) —
      // a local timeout is NOT a truncated stream and NOT a Hub error.
      throw new DOMException('The operation was aborted.', 'AbortError');
    }
    // Stream ended without the terminal frame — fail closed, never present
    // a possibly-truncated generation as complete.
    throw new ChatGooseError('hub_stream_truncated', {
      message: 'AI stream ended without completing.',
    });
  }
  ```
  Mind the existing `try/catch` around `await handle.done` (it maps NON-swallowed rejections): the captured `terminalFrameError` must end up mapped exactly as it would have been on the rejection path — if the capture stores the already-mapped ChatGooseError, throwing it after the try/catch is equivalent. Keep the `personaDefinitionValidated` check where it is.
- [ ] Step: gateway tests (this suite currently has no abort coverage) — drive the REAL gateway against a scripted SSE like the existing tests do:
  (a) abort the signal mid-stream after some `content_delta` → rejects with `DOMException` named `AbortError`, NOT `hub_stream_truncated`;
  (b) EOF without `done` and WITHOUT abort → still `hub_stream_truncated` (the fail-closed pin);
  (c) a terminal `error` frame, then the signal aborts during teardown, then EOF → the FRAME's error surfaces (the capture outranks the abort) — this is exactly the race the SDK swallow used to eat.
- [ ] Step: note-in-passing — `tests/operations-suite.ts` mocks `streamFeature` to reject with `AbortError` on abort; until now that mock CONTRADICTED the real gateway and pinned the desired-but-false behavior green. After this fix the mock matches reality. Add one comment line at the mock saying so (no behavior change).
- [ ] Verify: `pnpm check` green; specifically `pnpm vitest run tests/kernel-feature-gateway.test.ts tests/operations-suite.ts tests/ops-daily.test.ts`.
- [ ] Commit: `fix(gateway): аборт стрима — это AbortError, а не CG-HUB-16; локальный таймаут больше не растит счётчик ошибок Hub`

---

### Task 7: «Статус» stops calling a down kernel «не настроен», and the token pill stops overclaiming

**Slug:** `260729h-status-honesty`

**Files:**
- Modify: `src/options/index.ts:2627` (`{ key: 'hub', ... done: statusModel.identity?.ok === true }` in the «Что мешает» steps builder — read the whole builder), `src/options/index.ts:1970` (token pill)
- Modify: `src/options/copy.ts` (`deviceTokenActive: 'активен'` at line ~305; add a neutral step-state string if needed)
- Test: `tests/options-status.test.ts`, `tests/options-hub-pane.test.ts`, `tests/options-onboarding.test.ts` (they pin these strings — search `активен` and `stepHub`)

**Interfaces:** consumes `AgencyHubIdentityResponse` reasons: `ok:false` carries `reason: 'no_credential' | 'no_base_url' | 'no_permission' | 'unauthorized' | 'unreachable'` (see `src/background/agency-hub-client.ts` `checkIdentity`). Produces nothing.

Current lies: (a) the «Что мешает» card marks the hub step un-done whenever `identity.ok !== true` — including `unreachable`/`no_permission`, where the credential may be perfectly fine and the kernel is simply down; the pane then demands «подключить Agency Hub» one line above an honest «ядро недоступно». (b) The pill «Device token · активен» is computed from `Boolean(settings.agencyHubDeviceToken.trim())` — string presence, no liveness — while a revoked token both shows green AND shadows a working legacy key (`resolveHubBearer` prefers the token unconditionally).

- [ ] Step: steps builder — a two-state model cannot express this honestly. Simply DROPPING the hub step when the kernel is unreachable creates a WORSE lie: with every other step done, `open.length === 0` flips the hero to «Готово к смене» with the subtitle «Hub на связи, аккаунт в работе, персона назначена» (see the `open.length === 0` branch in the readiness renderer and `readySubtitle` in copy.ts) — a fully down Hub declared «на связи». Use three states:
  ```ts
  type ReadinessStepState = 'done' | 'open' | 'indeterminate';
  ```
  The hub step becomes `indeterminate` ONLY when credentials are actually stored (`normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl)` non-empty AND a bearer — device token or legacy key — present) and the identity failure is connectivity-shaped (`reason === 'unreachable' || reason === 'no_permission'`). No stored credentials → the step is genuinely `open` («подключить» is true advice). Note: the pane converts runtime rejections into `unreachable` too (search `'unreachable'` in options/index.ts around the identity refresh) — that is exactly why the credential-presence check is required.
  Rendering rules:
  - `indeterminate` steps are EXCLUDED from the CTA list and from the «Нужно N действий» count;
  - but they BLOCK the ready state: the «Готово к смене» hero (and its micro-OK) requires `open.length === 0 && indeterminate.length === 0`;
  - an indeterminate hub renders as a neutral non-actionable line, e.g. `hubStepIndeterminate: 'Hub недоступен — статус подключения проверить нельзя'` (new copy.ts string), with no button.
  The invariant, stated twice because both halves matter: a down kernel must never produce the CTA «подключить Agency Hub» for already-entered credentials, AND must never let the pane claim «Hub на связи».
  Two adjacent consumers of the same truth, both in scope:
  - the readiness list feeds the SUPPORT REPORT (`statusModel.readiness` assignment right before the hero branch) — the indeterminate hub line must appear there as «неизвестно», never silently vanish;
  - `onboardingStepStates.signIn` (same file, ~2655) is also `identity?.ok === true` — apply the same indeterminate treatment there, or the onboarding checklist stays permanently «unfinishable» while the kernel is down.
  Test-pin reality check: the suites pin the token pill through the `COPY.hub.deviceTokenActive` KEY (≥6 sites in `options-hub-pane.test.ts`), so the key rename self-fixes via typecheck; `stepHub` appears in NO test — don't hunt for string pins that aren't there.
- [ ] Step: token pill honesty — `copy.ts`: `deviceTokenActive: 'активен'` → `deviceTokenStored: 'сохранён'` (rename the key so no call site claims liveness by accident; fix the single usage at `options/index.ts:1970`). The «Выпущен …» row and the identity-driven «Доступ» row remain the liveness signals.
- [ ] Step: update the three options test suites where they pin `активен` / the hub step; add: (a) identity `{ ok:false, reason:'unreachable' }` with stored credentials → the todo card does NOT contain «подключить», and the headline count excludes the hub step; (b) identity `{ ok:false, reason:'unauthorized' }` → hub step IS in the todo (a rejected credential is actionable).
- [ ] Verify: `pnpm check` green.
- [ ] Commit: `fix(options): лежащее ядро ≠ «подключить хаб»; плашка токена говорит «сохранён», а не «активен»`

---

### Task 8: Voice capability off the first-paint critical path

**Slug:** `260729i-voice-cap-budget`

**Files:**
- Modify: `src/background/voice-service.ts` (`resolveCapability`, line ~497; the capability cache write is in `resolvePageForTab`, ~1231)
- Modify: `src/background/runtime-api.ts` (`getPopupStatus`, the `await voiceService?.resolveCapability(tabId)` at ~498)
- Modify: `src/background/operations.ts` (`buildTabUiState`, ~826 — the probe deliberately runs FIRST)
- Modify: `src/background/index.ts` (composition — wire the late-resolution callback)
- Test: `tests/voice-service.test.ts`, `tests/runtime-api.test.ts`

**Interfaces:**
- Consumes: `operations.refreshTabState(tabId, 'tab:state')` (`src/background/operations.ts:562`) — the existing re-push channel to content.
- Produces: `VoiceService.resolveCapabilityFast(tabId: number, budgetMs: number): Promise<boolean>` — returns the cached value instantly when fresh; otherwise races the real probe against the budget, returns `false` on budget expiry, lets the probe finish in the background, and invokes a new dep `onCapabilityResolvedLate(tabId: number)` when the late probe lands with a DIFFERENT value than the one returned.

Current problem: `getPopupStatus` awaits `resolveCapability` (probe budget = `AGENCY_HUB_PREFETCH_TIMEOUT_MS` = 5000ms) and `buildTabUiState` runs the probe FIRST (deliberately — it resolves the session's canonical identity as a side effect, see the comment at `operations.ts:828-832`). On a cold worker with an unwarmed cache the popup and the whole injected toolbar can sit empty for up to ~5s.

Invariants that must survive (state them in tests):
1. **Fail-closed:** the budget path never reports `true` unless the real probe returned `true`. Budget expiry → `false`.
2. The kernel stays authoritative: this changes WHEN the hint arrives, never WHETHER a paid call is allowed (the kernel re-checks every gate on POST).
3. The identity-resolution side effect of the probe still happens — the probe always runs to completion in the background even when the budget loses the race.
4. A late `true` reaches content: `onCapabilityResolvedLate` → `refreshTabState(tabId, 'tab:state')` → the 🎙 button appears without a reload.

- [ ] Step: BOTH plan audits flagged the same two traps here — design around them:
  **Trap 1 (identity invariant).** The probe's identity side effect is PINNED: `tests/operations-suite.ts:1037` «returns the identity resolved during the voice-capability probe in the same state» (the probe may update `resolvedAccountId/resolvedUsername` via `getAuthenticatedAccount`). A late callback that fires only on a CHANGED capability verdict silently drops the identity correction for every non-voice account (`false == false`) — content keeps the legacy account id until an unrelated refresh. **Therefore the late callback fires on every late probe SUCCESS, regardless of verdict.** This cannot loop: a successful probe populates the 5-minute capability cache, so the refresh triggered by the callback hits the cache instead of re-probing. A late probe FAILURE never fires the callback (failures are not cached — firing would loop probe→refresh→probe).
  **Trap 2 (settle race).** Setting flags AFTER `await Promise.race` loses the late callback when the probe's `.then` runs in the microtask gap. Use one settle function assigned from INSIDE each competing branch, and clear the budget timer when the probe wins:
  ```ts
  async resolveCapabilityFast(tabId: number, budgetMs: number): Promise<boolean> {
    const pending = this.fastProbesByTab.get(tabId);
    if (pending) return pending.race;          // single-flight: popup + tab:init share one probe
    let timer: number | undefined;
    let settled = false;
    let settle!: (value: boolean) => void;
    const race = new Promise<boolean>((resolve) => {
      settle = (value) => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        resolve(value);
      };
    });
    const probe = this.resolveCapability(tabId)
      .then((capable) => {
        const wasSettled = settled;   // read BEFORE settle(capable) below
        settle(capable);
        if (wasSettled) {
          // The budget already answered (false, fail-closed). The probe
          // finished successfully afterwards: re-push tab state so a late
          // capability AND the identity it resolved reach content. Success
          // populated the capability cache — the refresh cannot re-probe.
          this.deps.onCapabilityResolvedLate?.(tabId);
        }
      })
      .catch(() => { settle(false); }) // failure: fail closed, NO late callback
      .finally(() => { this.fastProbesByTab.delete(tabId); });
    void probe;
    timer = globalThis.setTimeout(() => settle(false), budgetMs) as unknown as number;
    this.fastProbesByTab.set(tabId, { race });
    return race;
  }
  ```
  (Adapt field/typing details to the file's style; the load-bearing properties are: single settle, timer cleared, single-flight map keyed by tabId, late callback on post-settle SUCCESS only.) Add `onCapabilityResolvedLate?: (tabId: number) => void` to the service deps type. Note `refreshTabState` is a no-op for a tab without a live port — a late callback for a dead tab is safe.
- [ ] Step: call sites — the capability resolver reaches consumers by INJECTION, not direct import: `src/background/index.ts:87` (`setVoiceCapabilityResolver`) is the real switch-over point for `buildTabUiState` (which calls the injected resolver at `operations.ts:833`), and `getPopupStatus` consumes it through `RuntimeApiDeps` — update the `Pick<VoiceService, 'resolveCapability'>` type there (`runtime-api.ts` ~213-226) and the mock in `tests/runtime-api.test.ts` (~817-830; typecheck will point at every site). Budget: 800ms both places. In `buildTabUiState` KEEP the probe first in order — the identity side-effect comment survives verbatim; only the awaited budget shrinks.
- [ ] Step: composition (`src/background/index.ts`) — `voiceService` is constructed BEFORE the coordinator (~line 62 vs ~78), so the callback cannot be a constructor dep: add a setter (`voiceService.setOnCapabilityResolvedLate(cb)` or a late-bound deps field) wired AFTER the coordinator exists: `(tabId) => { void coordinator.refreshTabState(tabId, 'tab:state'); }` — the variable is named `coordinator` in that file, not `operations`.
- [ ] Step: tests with fake timers. (a) probe resolves 100ms `true` → fast returns `true`, timer cleared, no late callback. (b) probe 3000ms `true`, budget 800 → returns `false` at 800, late callback at 3000. (c) probe 3000ms resolves `false` (SUCCESS) → returns `false` at 800, late callback STILL fires at 3000 (identity may have changed; cache absorbs the refresh). (c') probe REJECTS late → no callback. (d) warm tab binding + fresh capability cache → resolves without any hub network call (assert the injected client's `pages`/auth methods were not hit — there is no synchronous cache view, so assert «no network», not «no probe»). (e) concurrent `resolveCapabilityFast` from popup + tab:init on a cold cache → ONE underlying probe, one late callback. (f) `runtime-api.test.ts`: popup status with a slow probe answers within budget with `voiceNotesCapable: false`. (g) integration through the coordinator (`tests/operations-suite.ts`): late success → `refreshTabState` pushes a fresh `tab:state`; and re-run the pinned identity test at `operations-suite.ts:1037` — with an instant resolver it must stay green AND a new sibling test with a slow resolver must show the late refresh carrying the corrected identity.
- [ ] Verify: `pnpm check` green.
- [ ] Commit: `perf(voice): капабилити с бюджетом 800мс на первую отрисовку — попап и панель не ждут холодную пробу 5с`

---

## Self-review notes

- Coverage: 8 findings ↔ 8 tasks; the two design forks (attach 10s window, auto-recap question visibility) and all kernel-side quota work are deliberately OUT of scope — they need the owner's decision.
- Type consistency: the only new cross-file API is `resolveCapabilityFast` + `onCapabilityResolvedLate` (Task 8, self-contained) and `focusCoachComposer` (Task 2, self-contained).
- Tasks 2 and 3 both edit `src/content/index.ts` in disjoint regions AND both add tests to `tests/coach-orchestration.test.ts` — the per-task test-placement pins (~693 vs ~542/~1237) exist precisely to keep the second squash-merge clean. If the second merge still conflicts, it conflicts in tests only; resolve by keeping both blocks.
- Line anchors verified on main@48a9fb7 on 2026-07-29.
- This plan passed a dual adversarial audit (codex + Fable, independently) on 2026-07-29. Every high-severity finding was verified against the code and folded in: the terminal-frame-error capture in Task 6, the `abortCoachSubmit` gate in Task 2, the three-state readiness in Task 7, the success-only late callback + single-flight + settle-race fix in Task 8, the z re-band + cancel pass-through in Task 1, the context-aware `lastError` in Task 4, and the runtime-api sentinel strings in Task 5. Where the audits named phantom anchors (async sendCoachTurn, content-app hotkey tests, a «lastError survives re-renders» pin), the plan now says so explicitly so nobody hunts for them.
