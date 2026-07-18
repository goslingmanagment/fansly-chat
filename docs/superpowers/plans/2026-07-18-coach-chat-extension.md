# Coach Chat — Extension Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the Coach feature (chat-mode overlay, per-fan sessions, transcript session cache, recap picker/short mode/auto-recap, settings v14) in the ChatGoose Firefox extension against the merged core contract.

**Architecture:** Content owns dialog/feed/composer state (`CoachSession` store, LRU by `(accountId, groupId)`); background owns the transcript session cache and all kernel/Fansly I/O; the overlay gains a keyed-incremental chat render mode. Every coach turn is a normal feature-lane operation with `chatterQuestion` + projected `coachHistory`; recaps ride the existing fan-summary feature with `summaryMode:'short'` and are attached kernel-side (no client work per turn).

**Tech Stack:** Plain TS + esbuild, vitest, JSDOM for options/overlay tests. No frameworks (repo rule).

**Prerequisites:**
1. Core PR #14 merged; SDK re-vendored into this repo (core-plan Task 11) — brings `aiRecapStatus` op, `isOutputExhausted`, `COACH_ANSWER_MAX_CHARS`, coach body fields.
2. Implementation runs in a FRESH toolkit worktree: `~/code/agentic-control-plane/bin/agent task chatgoose coach-chat-impl` (the spec/plans branch `ai/260717d-coach-chat-spec` merges separately as a docs PR). Cherry-pick or rebase the docs if the spec branch hasn't merged yet — the plan/spec files must be readable from the impl worktree for briefs.

**Authoritative docs:**
- Spec (rev 2.2): `docs/superpowers/specs/2026-07-17-coach-chat-design.md` — §3 session model/UX, §4 context matrix, §5 recap, §6 transcript cache, §8 fail-closed, §9 settings, §10 files, §13 tests.
- Code maps (point-in-time, verified 2026-07-18, committed next to this plan): `docs/superpowers/plans/ext-map-content-overlay.md` and `docs/superpowers/plans/ext-map-background-storage.md` — exact line numbers, interfaces, and patterns for every file this plan touches. Copy relevant excerpts into task briefs.

## Global Constraints

- Family law: AI never sends without explicit human action; no auto-retry of an indeterminate send. Coach send = chatter presses Enter; draft insertion ≠ sending.
- Opening Coach creates NO generation and NO AI spend (the metadata recap-status read is allowed).
- Kernel-only AI (E3): extension ships raw DOM/API values in `clientContext`; no prompt assembly. `pnpm gates` (check-ai-cutover) must stay green.
- Fansly egress: no new endpoint classes; follow-up coach turns fetch ONE message page (overlap-and-replace); full reload only on reseed triggers.
- Canonical identity on coach + fan-summary requests: `conversationRef = groupId`, `fanRef = fanAccountId` (fanRef REQUIRED by core for coach-chat; a coach turn cannot start until fanAccountId is resolved).
- Kernel-facing `fanDisplayName` comes ONLY from the Fansly account lookup; on failure send `"fan"` — the DOM label (may carry chatter-only custom names) never reaches prompts. Applies to ALL features (spec §4).
- Wire bounds (core-enforced, client must satisfy): `chatterQuestion` 1–2000; `coachHistory` ≤20 entries, `question` ≤2000, `answer` ≤64_000 (COACH_ANSWER_MAX_CHARS from the vendored SDK); short recap `clientContext.messageCount` ≤300; `summaryMode` sent ONLY as `'short'` (full = omit).
- Client history projection (optimization, mirrors core): answers >10_000 chars → head 6_000 + `\n[… N chars omitted …]\n` + tail 3_800, code-point-safe; window = last `coachHistoryLimit` completed exchanges.
- Exhaustion fail-closed client-side: `isOutputExhausted(stopReason)` (vendored SDK) → coach turn non-committable; fan-summary (both modes) result never cached, never pushed to Hub dossier.
- Storage: migration v13→v14, forward-only; `deepMessageCount` default 1500→3000 (raw value exactly 1500 bumps, anything else preserved); new `coachHistoryLimit` (10, range 1–20), `coachAutoRecap` (`'off' | 'short' | 'full'`, default off). Every full-state persist through `serializePersistedState`.
- Short recap: fixed `SHORT_SUMMARY_MESSAGE_COUNT = 300` window (constant, not a setting); mode-qualified summary-cache keys (legacy unqualified = full); NEVER pushed to `fan_profiles`.
- Coach sessions: in-memory only, content-side, LRU 5, key `(creatorAccountId, groupId)`, new sessionId per page load, reset on account/persona mapping change.
- Acceptance lifecycle v1: `copied` and `inserted` only, attributed per-exchange via `generationRef`.
- Chatter-eyes-only fan notes/custom names NEVER enter requests (guard test).
- `pnpm check` green before every commit; releases untouched (accumulates for 2.0).
- Compat: structured `unknown_ai_feature` from core maps to a specific «Coach requires a newer Agency Hub» error; generic 404 must NOT.

---

### Task 1: Shared registration (FeatureType, policy, labels, result kind)

**Files:** Modify `src/shared/types.ts`, `src/shared/features.ts`, `src/shared/constants.ts` (FEATURE_LABELS + `SHORT_SUMMARY_MESSAGE_COUNT = 300` + `COACH_RECAP_FRESH_MS = 24h` + coach settings defaults are Task 3), `src/background/operations.ts` (`buildFeatureResult` arm), `src/content/overlay/overlay-controller.ts` (`titleForFeature` arm — compile-forced). Test: `tests/features-coach.test.ts` (new).

**Interfaces produced:** `FeatureType` += `'coach-chat'`; `FEATURE_POLICIES['coach-chat']` = `{ messageCountBucket: 'quick', timeoutBucket: 'quick', modelFeature: 'coach-chat', surfaceKind: 'overlay', promptMode: 'analysis', resultKind: 'coach-chat', supportsReplyMode: false, supportsReplyTone: false, requiresDraft: false, usesPingSegment: false }`; `ModelSelectableFeatureType` += coach; `FeatureResultKind` += `'coach-chat'`; `buildFeatureResult` passes rawText through for coach (no XML parsing); `FEATURE_LABELS['coach-chat'] = 'Coach'`; overlay title arm `'coach-chat' → 'Coach'`.

Steps: failing test asserting the policy row + label + result passthrough → implement → `pnpm typecheck` (catches every exhaustive switch needing an arm — fix each with the coach arm) → tests green → commit `feat(coach): register coach-chat feature`.

### Task 2: Hotkeys — coach + recap become app actions

**Files:** Modify `src/shared/hotkeys.ts` (map: `ext-map-content-overlay.md` §3). Test: extend `tests/` hotkey coverage (find the existing hotkeys test; create `tests/hotkeys-coach.test.ts` if none).

**Produced:** `HotkeyAction` += `'coach'`; `'fan-summary'` REMOVED from `HOTKEY_FEATURE` (both it and coach are app actions now — ⌘⇧S must open the recap picker, not start a generation); `AI_HOTKEYS` += `{ action: 'coach', letter: 'c', description: 'Coach — ask the AI anything about this fan' }`; fan-summary keeps letter `s` with description updated to mention the picker. `dispatchHotkey` arms are Task 10.

TDD steps as usual; commit `feat(coach): coach + recap picker hotkey actions`.

### Task 3: Storage migration v13→v14

**Files:** Modify `src/shared/constants.ts` (`STORAGE_SCHEMA_VERSION = 14`, `DEEP_DEFAULT_MESSAGE_COUNT = 3000`, `DEFAULT_SETTINGS` += `coachHistoryLimit: 10`, `coachAutoRecap: 'off'`, add `COACH_HISTORY_LIMIT_MIN = 1`/`MAX = 20`), `src/shared/types.ts` (Settings fields), `src/shared/migrations.ts` (raw transform + normalizer), `src/shared/storage.ts` (`sanitizeSettings` clamps). Test: extend `tests/storage-migration.test.ts`.

**Key mechanic (map §4):** migrations are a single jump-to-current normalizer. The v14 raw transform (deepMessageCount `=== 1500` → `3000`) must run on the RAW record BEFORE `migrateSettingsRecord` normalization — add it inside `normalizePersistedRecord`/`migrateSettingsRecord` guarded by `schemaVersion < 14` of the incoming record (the raw record's schemaVersion is available; do not bump user-modified values, and records already at v14 never re-transform).

Tests: raw v13 with 1500 → 3000; with 1499 → 1499; with missing deep → 3000; new fields absent → defaults; out-of-range coachHistoryLimit → clamped; junk coachAutoRecap → 'off'; v14 round-trip stable. Commit `feat(coach): settings v14 — coach fields + deep window default 3000`.

### Task 4: Options UI

**Files:** Modify `src/options/index.ts` (Generation section, map §5 has the exact numeric-input + select + wiring pattern incl. `collectSettingsPatch` at :666 and the event array at :829). Test: extend `tests/options-accounts.test.ts` or new `tests/options-coach.test.ts` (JSDOM harness pattern in map §7c).

**Produced:** number input «Coach dialog memory (exchanges)» (min 1 max 20) → `coachHistoryLimit`; select «Auto-Recap before coaching» (off/short/full) → `coachAutoRecap`, with a visible cost warning under the field when `full` is selected («Full Recap loads up to 3000 messages — slow and expensive»; plain `.chatgoose-section-desc`-style element toggled on select change). Deep input's max already 3000 — verify, don't change.

Commit `feat(coach): options for coach memory + auto-recap`.

### Task 5: Protocol + shared coach modules

**Files:** Modify `src/shared/protocol.ts` + `src/shared/types.ts`; Create `src/shared/coach-draft.ts`, `src/shared/coach-history.ts`. Tests: extend `tests/protocol.test.ts`; new `tests/coach-draft.test.ts`, `tests/coach-history.test.ts`.

**Produced (wire between content↔background):**
- `OperationStartPayload` += `chatterQuestion?: string`, `coachHistory?: Array<{question: string; answer: string}>`, `summaryMode?: 'short' | 'full'` (content→background; background maps `'full'` → omit on the kernel wire). Validators: bounds-checked array validator (first array field in the protocol — length ≤20, each entry exact keys, string bounds).
- `operation:complete` message += `generationRef?: string` (background fills from the meta frame's requestId for coach ops; content stores it on the exchange).
- New one-shot runtime request `getRecapStatus` (pattern: `getSpendersList` in map §4): request `{groupId: string, fanAccountId: string | null}` → response `{full: RecapSlot | null, short: RecapSlot | null}` mirroring the SDK response, plus `isRecapStatusResponse` guard.
- `src/shared/coach-draft.ts`: `parseCoachDrafts(answerRaw: string): { drafts: CoachDraft[]; prose: string }` — line-anchored ```` ```draft ```` fences, max 2, each ≤1500 chars, empty ignored, violations (unclosed/oversized/3rd+) stay escaped in prose; `CoachDraft = { text: string; index: number }`. Pin a fixture copied verbatim from core's `templates/coach-chat.md` fence grammar.
- `src/shared/coach-history.ts`: `projectCoachAnswer(answer: string): string` (head 6_000 + `\n[… N chars omitted …]\n` + tail 3_800, `Array.from` code-point-safe, no-op ≤10_000 — constants mirror core) and `serializeCoachHistory(exchanges: ReadonlyArray<{question: string; answerRaw: string}>, limit: number): Array<{question: string; answer: string}>` — last `limit` completed exchanges, answers projected.

Tests: protocol guards (valid/invalid payloads incl. 21 entries, oversize strings); draft grammar cases; projection both-ends/no-op/surrogate-safety; serialize window. Commit `feat(coach): protocol fields + draft parser + history projection`.

### Task 6: Background — transcript session cache + `reachedEnd`

**Files:** Create `src/background/coach-transcript-cache.ts`; Modify `src/background/fansly-client.ts` (`MessageLoadResult` += `reachedEnd: boolean` — true when pagination stopped on a short/empty page, map §3 shows the break at :995-998), `src/background/operations.ts` (coach path uses the cache). Tests: new `tests/coach-transcript-cache.test.ts`; extend `tests/operations.test.ts`.

**Produced:** `CoachTranscriptCache` keyed `${tabId}:${coachSessionId}:${accountId}:${groupId}:${quickMessageCount}` storing normalized pages + enrichment. API: `getOrSeed(key, loadFull)`, `refresh(key, loadPageOne)` implementing spec §6 overlap-and-replace verbatim: page-1 overlap → replace covered suffix (fresh wins for messages/media/bundles/purchase-evidence maps — NO blind concat, `normalizeTranscript` dedupe is first-write-wins per map §3); full page no overlap → page until overlap or window rebuilt; short page → replace snapshot; continuity failure → full reload BEFORE any kernel call; `invalidate(predicate)`. Operations: coach ops with a cached seed take the 1-page path; anything else (first turn, reseed triggers) full window. `reachedEnd` + `formatTranscriptForKernel` keptCount feed `transcriptCoverage = reachedEnd && !windowTrimmed && kept === normalized ? 'full-history' : 'window'`.

Tests: overlap replace (edit/delete inside tail), no-overlap paging, short-page snapshot, continuity→full reload, key invalidation (window change, session change), first-turn seeds. Commit `feat(coach): background transcript session cache with overlap-and-replace`.

### Task 7: Background — coach + recap kernel threading

**Files:** Modify `src/background/operations.ts`, `src/background/kernel-feature-gateway.ts`, `src/background/agency-hub-client.ts`, `src/background/runtime-api.ts`, `src/shared/summary-cache.ts`. Tests: extend `tests/operations.test.ts`, `tests/kernel-feature-gateway.test.ts`, `tests/runtime-api.test.ts`, `tests/summary-cache.test.ts`.

**Produced:**
- Kernel request for coach: `feature:'coach-chat'`, canonical `conversationRef: validated.urlGroupId`, `fanRef: fanAccountId` (REQUIRED — if unresolved, fail the turn with a user error BEFORE the kernel call), `chatterQuestion`, `coachHistory` (already projected by content), `clientContext` incl. `transcriptCoverage`. Fan-summary requests switch to canonical refs too; other features unchanged this phase.
- `KernelFeatureRequest` += the new fields; gateway body builder passes them; `summaryMode` only when `'short'`.
- Custom-name rule: the kernel-facing `fanDisplayName` drops the `payload.domFanDisplayName` fallback (map §1 line 2096-2100) → `account?.username?.trim() || account?.displayName?.trim() || 'fan'` for ALL features; DOM name still used for tab UI.
- Exhaustion: extend the stopReason check (map §1 :2690) — `isOutputExhausted(latestLlmStopReason)` throws `ai_output_unusable` when `promptMode === 'reply'` OR feature is `coach-chat`/`fan-summary`.
- Short recap: window = `SHORT_SUMMARY_MESSAGE_COUNT` (not deepMessageCount); result cached under mode-qualified key `summary-short:{groupId}` (extend `summary-cache.ts` — `summaryCacheKey(groupId, mode)`, legacy `summary:` = full; eviction covers both); Hub dossier sync (`enqueueAgencyHubSummarySync`) SKIPPED for short.
- Coach: results NEVER cached (skip CompletedOverlayCache path — content side, but background also must not save summary cache for coach); `operation:complete` carries `generationRef` (from `onMeta` requestId, map §1 :2566).
- Recap-status: `AgencyHubClient.getRecapStatus({pageLabel, conversationRef, fanRef})` via the vendored `aiRecapStatus` op (copy the `getConversationProfile` pattern, map §2 :287-305; 404/`unknown` → null slots); runtime-api handler for `getRecapStatus` resolving pageLabel the same way operations does.
- Compat: `unknown_ai_feature` error code from the gateway maps to a new `ChatGooseError('coach_requires_newer_hub')` with user copy «Coach requires a newer Agency Hub».

Commit per logical chunk (threading / naming rule / short-recap / status read).

### Task 8: Content — CoachSession store

**Files:** Create `src/content/coach-session.ts`. Test: `tests/coach-session.test.ts` (new).

**Produced (spec §3 verbatim):** `CoachFeedItem` / `CoachExchange` / `CoachSession` types; `CoachSessionStore` with `getOrCreate(accountId, groupId)`, LRU 5 eviction, `commitExchange(session, {operationId, generationRef, question, answerRaw})` (parses drafts via `parseCoachDrafts`, appends to both feedItems + completedExchanges, trims completedExchanges to a hard in-memory cap of 50), `recordFailedAttempt`, `beginPending`/`clearPending`, `resetSession` (forces transcript reseed flag), `resetAll` (persona/account change), `composerText` persistence. `serializeCoachHistory` consumed here with `settings.coachHistoryLimit`.

Tests: LRU touch/evict, keying isolation, commit-only-on-complete, failed attempt retains question + discards partial, reset semantics, wire serialization uses limit + projection. Commit `feat(coach): content session store`.

### Task 9: Content — overlay chat mode

**Files:** Modify `src/content/overlay/overlay-controller.ts`, `src/shared/types.ts` (`OverlayViewModel` += `{ kind: 'coach'; ... }`), `src/content/styles.css` (overlay section, map §7 conventions). Test: `tests/coach-overlay.test.ts` (new, JSDOM).

**Produced:** `CoachOverlayModel = { kind: 'coach'; sessionView: { feedItems, pendingQuestion?, pendingAnswerText?, recapStatusLine, composerText, composerEnabled, sessionKey } ; operationId: string | null }`. New `renderCoach(view)` + `updateCoachView` — KEYED incremental: stable DOM node per feed item (keyed by operationId/index), streaming appends mutate ONLY the pending answer's text node (pattern: `updateLoadingView` text-node mutation, map §1), feed scrolls separately from a sticky composer (structural model: the board panel's flex column, map §7), auto-scroll only when near bottom, `role="log"` + `aria-busy` on the pending item. Composer: Enter submits (`event.isComposing` guarded), Shift+Enter newline; callbacks extend `OverlayCallbacks` with `onCoachSubmit(question)`, `onCoachNewDialog()`, `onCoachRecap(mode)`, `onCoachRetry(question)`. Esc: streaming → `onCancel`, idle → `onClose` (existing dismissMode machinery). Draft cards reuse `.chatgoose-card` styling with Insert / «Replace draft…» (confirm when `getActiveConversationDraftText()` non-empty) / Copy; acceptance via the existing `onAcceptance` callback carrying the CARD's exchange operationId (not the top-level one). Coach models BYPASS `CompletedOverlayCache` and `overlayRawText`.

Tests: keyed updates preserve composer focus/caret and feed scroll across renders; Esc semantics; draft-card actions incl. replace-confirm; a11y attributes. Commit `feat(coach): overlay chat mode with keyed renderer`.

### Task 10: Content — orchestration (index.ts, planner, button bar)

**Files:** Modify `src/content/index.ts`, `src/content/surface-planner.ts`, `src/content/button-bar.ts`. Tests: extend `tests/spenders-board-controller.test.ts`-style content tests + new `tests/coach-orchestration.test.ts`.

**Produced:**
- Planner: `coachOverlayModel: OverlayViewModel | null` input slot rendered like `deepOverlayModel` but with precedence: active coach STREAMING op renders as coach model (not the generic loading overlay); idle coach open renders; any OTHER feature's activity wins over idle coach (coach closes, session retained).
- index.ts: `openCoach()` (builds/refreshes the coach model from the session store + fires the recap-status runtime request to fill the status line — no generation), `submitCoachQuestion(question)` (guards: no other op in flight; fanAccountId resolvable; builds `OperationStartPayload` with `chatterQuestion` + serialized history + coach feature; pending state into the session), `closeCoach()`, `resetCoachSession()` (confirm if non-empty). `dispatchHotkey` arms: `'coach'` → open/focus; `'fan-summary'` → recap picker (Task 11). Chunk handling: coach chunks append into the session's pending answer + rerender coach model (NOT overlayRawText). Complete: `commitExchange` with `generationRef` from the message; error/cancel/route-switch: `recordFailedAttempt`, preserve composer, existing suppression machinery unchanged (map §2 `handleRouteChange`) — coach sessions themselves survive fan switches (LRU keyed), only pending ops cancel.
- Concurrency: coach streaming blocks other features via the existing single-op gate; another feature while coach idle-open → close coach, proceed.
- Button bar: `onCoachClick` callback + Coach button appended after the Recap button (before `personalityLabel`); narrow-width check per bar overflow behavior.
- Persona/account change → `store.resetAll()`.

Tests: open-sends-no-generation (assert no port `operation:start`), submit sends exactly one with correct payload, chunk→pending, complete→commit, error→failed-attempt, route-switch preserves session + composer, concurrency both directions, button/hotkey wiring. Commit `feat(coach): coach lifecycle orchestration`.

### Task 11: Content — recap picker, coverage header, auto-recap chain

**Files:** Modify `src/content/index.ts`, overlay (recap start dialog rendering — a small `readOnly`-style dialog model or a dedicated `recap-picker` view), `src/content/overlay/summary-markdown.ts` surroundings for the coverage header. Tests: extend `tests/coach-orchestration.test.ts`.

**Produced (spec §5):**
- Standalone Recap (⌘⇧S / button) opens the picker: **Полный** (focused — ⌘⇧S+Enter keeps muscle memory) / **Короткий** / **Открыть последний** (renders the freshest stored recap via the status read + local cache, no generation); Esc cancels. Picking full/short starts a fan-summary op with `summaryMode`.
- Coverage header on recap results: «вся переписка (N сообщений)» vs «последние N — история длиннее» from `transcriptCoverage` + kept count (background passes them through on `operation:complete` for fan-summary; extend the message if needed).
- Coach auto-recap chain (spec §5 orchestration): per-session override `inherit | off | short | full`; on first question of a session with effective mode ≠ off and freshest matching recap older than `COACH_RECAP_FRESH_MS` (24h) or absent → run the recap op FIRST as a visible `recap-step` feed item (origin `coach-auto`, at most once per session even after failure), then auto-submit the question. Mode matching: `short` satisfied by fresh short OR full; `full` only by fresh full at current deepMessageCount. Failure taxonomy: cancel/route-change/auth/quota/transcript failures STOP the chain (question preserved in composer); recap-specific model failure → proceed with the coach turn, feed copy «обновить Recap не удалось — использую рекап от N назад» (or recap-less if none). Explicit refresh buttons in the coach header mirror the same machinery with origin `coach-explicit`. All explicit/auto refreshes bypass the summary cache (forceRegenerate).

Commit `feat(coach): recap picker + coverage + auto-recap chain`.

### Task 12: Guards, decisions, check, PR

- Guard test: chatter-eyes-only names/notes never reach the kernel request builder — sentinel custom name on the account-lookup failure path → wire carries `"fan"` (extends Task 7's tests; make it an explicit named test).
- Cutover gate: run `pnpm gates`; fix anything the AI-cutover grep flags.
- `docs/decisions.md`: new E-entry (coach feature, canonical refs, v14 migration, short-recap cache rules, projection-as-optimization, recap picker) in the SAME PR (family law).
- Full `pnpm check`; commit; push; Draft PR via toolkit flow; `agent review chatgoose --pr <N>` as the last step.

## Explicitly deferred (unchanged from spec §12)

Kernel sessions; archive/hybrid transcript; toolbar redesign / Help return; `edited`/`sent` provenance; two-slot Hub dossier (waits for core #136); pricing/media context; cross-device continuity.

## Self-review notes (writing-plans checklist)

- Spec coverage: §3→T8/T9/T10, §4→T7+T12 guard, §5→T7/T11, §6→T6, §7 client duties→T5/T7, §8→T7/T10, §9→T3/T4, §10 file list→matches, §13 tests→distributed per task.
- Type consistency: `CoachDraft`/`parseCoachDrafts` (T5) consumed by T8/T9; `serializeCoachHistory` (T5) consumed by T8; `generationRef` on `operation:complete` (T5) produced by T7, consumed by T8/T10; `getRecapStatus` request (T5) produced by T7, consumed by T10/T11.
- Known intentional looseness: T9/T10/T11 specify interfaces + behaviors rather than full code bodies — implementers are Opus-tier with the code maps in briefs; per-task reviewers gate against this plan + the spec.
