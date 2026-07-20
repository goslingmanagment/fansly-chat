# Voice Notes Phase 2 (extension) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the extension half of voice notes — the voice flow UI
(лента default + студия overlay on shared components), the dedicated voice
port protocol with `storage.session` recovery, kernel transport over the
re-vendored SDK, and the attach adapter on the spike-proven selector — all
gated by `capabilities.voiceNotes`.

**Architecture:** Per the spec
(`docs/superpowers/specs/2026-07-18-voice-notes-design.md`, rev 2 + UX
sections). Server contract is FROZEN (core `cc06ac66`, SDK hash
`2a556e33`): `voiceNoteCreate` (202 + replay semantics), `voiceNoteStatus`
(free poll), `fetchVoiceNoteAudio` (binary Response), voice-script on the
SSE feature lane, structured `voice_*` codes + `artifact_expired`.

**Tech Stack:** chatgoose repo — plain TS + esbuild, no framework in
content scripts; vitest + jsdom; vendored `@kernel/sdk`.

## Global Constraints

- Execute in a chatgoose task worktree (`agent task chatgoose voice-ext` →
  `ai/<id>-voice-ext`), based on main AFTER the SDK re-vendor PR #20
  merges. Never commit in the canonical checkout; never `git add -A`.
- Kernel-only AI (E3): all voice traffic rides the vendored SDK / feature
  gateway. The attach adapter performs ZERO network calls — the page
  uploads.
- Family law: Send is manual; attach is at-most-once behind a single-use
  attested token; NO automatic retry of `voiceNoteCreate` (manual clicks
  only — status polling and audio GET are free and may retry); the voice
  flow must NOT inherit the generic operation path's transparent
  `service_unavailable` retry.
- Server-frozen semantics the client must honor: a `quota_denied`
  clientRequestId is BURNED (replay returns 429 forever — a new attempt
  needs a fresh UUID); `artifact_expired` arrives as HTTP 410 with body
  code `artifact_expired` (SDK category stays `validation` — match the
  BODY CODE, never the category); `createdAt` in the status view orders
  takes; refs must not contain control characters.
- Canonicalization law (must match the server byte-for-byte or replay
  409s): NFC normalize, CRLF→LF, trim. Canonicalize ONCE at snapshot time;
  every resend uses the stored canonical bytes, never re-reads the editor.
- Audio validation before any UI use: content-type `audio/mpeg`, byteLength
  equals the status view's `audioBytesLen` and ≤ 2 MiB, sha256
  (crypto.subtle) equals `audioSha256`. Fail closed — a broken artifact is
  never attached.
- No `storage.local` changes, no storage migration. Attempt metadata lives
  in `storage.session` (versioned key, TTL-bounded, never audio bytes).
- Never log or persist script text beyond the attempt snapshot; blob: URLs
  revoked on regeneration, navigation, panel close.
- UI strings are money-honest: free actions say free, paid actions carry
  the character cost («потратит ~N символов»); «Проверить статус —
  бесплатно» vs «Сгенерировать заново — потратит символы».
- `pnpm check` green before every commit; decisions.md entry (next E-num)
  ships with the implementing change; Draft PR + `agent review chatgoose`
  at the end.

---

### Task 1: Shared types + voice port protocol

**Files:**
- Modify: `src/shared/types.ts` (FeatureType union + voice message types)
- Modify: `src/shared/features.ts` (policy table entry)
- Modify: `src/shared/protocol.ts` (guards for new messages)
- Modify: `src/shared/errors.ts` (CG-VOICE codes)
- Modify: `src/shared/constants.ts` (voice constants)
- Test: `tests/protocol.test.ts`

**Interfaces (produced for all later tasks):**
- `FeatureType` gains `'voice-script'`; its features.ts policy marks it
  panel-only, draft-required, tone-supported — and EXCLUDED from generic
  operation surfaces (no insert/accept/compare wiring).
- Constants: `VOICE_SCRIPT_MAX_CHARS_ADVISORY = 600` (advisory mirror of
  the kernel cap — server is authoritative), `VOICE_CHARS_PER_SECOND = 14`
  (duration estimate), `VOICE_AUDIO_MAX_BYTES = 2_097_152`,
  `VOICE_ATTEMPT_SESSION_KEY_PREFIX = 'voiceAttemptV1:'`,
  `VOICE_ATTEMPT_TTL_MS = 6 * 3600_000`, `VOICE_STATUS_POLL_MS = 1500`.
- Dedicated port messages (NOT `operation:*` — the voice flow is exempt
  from generic disconnect cleanup):
  ```ts
  // content → background
  | { type: 'voice:scriptStart'; attemptId: string; draftText: string;
      replyTone: ReplyTone }              // voice-script SSE run
  | { type: 'voice:scriptCancel'; attemptId: string }
  | { type: 'voice:noteCreate'; attemptId: string; clientRequestId: string;
      conversationRef: string; sourceGenerationRef: string; script: string }
  | { type: 'voice:noteStatus'; attemptId: string; voiceNoteId: number }
  | { type: 'voice:audioFetch'; attemptId: string; voiceNoteId: number;
      expectedSha256: string; expectedBytes: number }
  | { type: 'voice:attachToken'; attemptId: string; voiceNoteId: number }
  // background → content
  | { type: 'voice:scriptDelta'; attemptId: string; text: string }
  | { type: 'voice:scriptComplete'; attemptId: string; script: string;
      generationRef: string }
  | { type: 'voice:scriptError'; attemptId: string; code: string; message: string }
  | { type: 'voice:noteView'; attemptId: string; view: VoiceNoteStatusView }
  | { type: 'voice:noteError'; attemptId: string; code: string; message: string;
      status: number }
  | { type: 'voice:audioBytes'; attemptId: string; voiceNoteId: number;
      bytes: ArrayBuffer }
  | { type: 'voice:attachGrant'; attemptId: string; token: string;
      fanUsername: string }
  | { type: 'voice:attachRefuse'; attemptId: string; reason:
      'route_changed' | 'fan_mismatch' | 'unknown' }
  ```
- `VoiceNoteStatusView` mirrors the SDK response verbatim (voiceNoteId,
  state, scriptChars, billed, audioSha256, audioBytesLen, createdAt,
  errorCode?).
- CG-VOICE error keys: map body codes 1:1 (`voice_disabled`,
  `voice_not_allowlisted`, `voice_no_profile`, `voice_script_invalid`,
  `voice_source_invalid`, `voice_quota_denied`, `idempotency_mismatch`,
  `artifact_expired`, `voice_retrieval_disabled`,
  `voice_provider_unavailable`, `voice_artifact_corrupt`,
  `gate_voice_disabled`) with user strings per the money-honest rule.

- [ ] **Step 1:** failing protocol tests (guards accept the new shapes,
  reject malformed); **Step 2:** implement; **Step 3:**
  `pnpm vitest run tests/protocol.test.ts` green + typecheck; **Step 4:**
  commit `feat(voice): shared voice types, port protocol, error codes`.

---

### Task 2: Background — voice service (transport + attestation + capability)

**Files:**
- Create: `src/background/voice-service.ts`
- Modify: `src/background/index.ts` (wire port messages)
- Modify: `src/background/kernel-feature-gateway.ts` (only if
  `voice-script` needs a request-shape tweak — it should pass through as a
  normal feature with `replyTone`)
- Modify: `src/background/agency-hub-client.ts` (+ typed voice ops passthrough)
- Modify: `src/background/tab-context.ts` / `src/background/runtime-api.ts`
  (capability plumbing into TabUiState)
- Modify: `src/shared/types.ts` (TabUiState `+ voiceNotesCapable: boolean`)
- Test: `tests/voice-service.test.ts` (new), `tests/runtime-api.test.ts`

**Interfaces:**
- Consumes SDK: `client.voiceNoteCreate({params:{pageLabel}, body})`,
  `client.voiceNoteStatus({params:{pageLabel, id}})`,
  `fetchVoiceNoteAudio(options, {pageLabel, id})`.
- Produces (over the port): the background half of the Task-1 protocol.
- voice-script runs through `kernelGateway.streamFeature` with feature
  `'voice-script'` — a DEDICATED runner in voice-service (not the
  operation registry): no acceptance capture, no transparent
  `service_unavailable` retry, deltas → `voice:scriptDelta`, meta frame's
  `requestId` → `generationRef` in `voice:scriptComplete` (this is the
  piece the generic path never exposed to content).
- `voice:noteCreate` → SDK create; SDK/HTTP errors map body codes to
  `voice:noteError {code, status}`. 202/replay both yield `voice:noteView`.
- `voice:audioFetch` → `fetchVoiceNoteAudio` → validate content-type,
  byteLength === expectedBytes ≤ 2 MiB, sha256 (crypto.subtle) ===
  expectedSha256 → `voice:audioBytes` (ArrayBuffer over structured clone);
  any mismatch → `voice:noteError {code:'voice_artifact_corrupt'}` local.
  401/403 flow through the existing hub auth-error path (the SDK helper
  fires onAuthError — verify wiring).
- `voice:attachToken` → compare the attempt's bound tuple (tabId, accountId,
  groupId, fanAccountId, routeNonce captured at noteCreate time) against
  the CURRENT TabContext → single-use token + `fanUsername` (from
  TabContext fanDisplayName / account names) or `voice:attachRefuse`.
  Tokens: `crypto.randomUUID()`, Map<token, attemptId>, consumed on first
  `voice:attachToken`-granted use, invalidated on route change.
- Capability: on tab init (and hub credential change), resolve the page's
  `capabilities.voiceNotes` from the SDK pages list (the existing
  `listVisiblePages` call path); cache per pageLabel with a 5-min TTL;
  absent/error → false (fail closed); surface as
  `TabUiState.voiceNotesCapable`.
- `conversationRef` = `fanAccountId ?? urlGroupId` — EXACTLY the existing
  operations.ts:2404 convention (erasure linkage depends on it).

- [ ] **Step 1:** failing tests: script runner delivers deltas+generationRef
  and does NOT retry on service_unavailable (spy gateway); create maps a
  429 `voice_quota_denied` body to `voice:noteError` with status 429;
  audio validation rejects wrong sha256/size/content-type; attach token
  granted once, refused on tuple drift and on second use; capability
  fail-closed on pages error. **Step 2:** implement. **Step 3:**
  `pnpm vitest run tests/voice-service.test.ts tests/runtime-api.test.ts`
  + typecheck. **Step 4:** commit
  `feat(voice): background voice service — SSE runner, SDK transport, attach attestation, capability`.

---

### Task 3: Content — attempt controller + storage.session recovery

**Files:**
- Create: `src/content/voice/attempt-controller.ts`
- Create: `src/content/voice/attempt-store.ts` (storage.session persistence)
- Test: `tests/voice-attempt-controller.test.ts` (new)

**Interfaces:**
- The controller is the single state owner both views render from:
  ```ts
  interface VoiceAttempt {
    attemptId: string;                    // ui correlation
    phase: 'script' | 'generating' | 'takes' | 'attached';
    draftText: string;                    // original composer draft
    script: string;                       // current editor text
    canonicalScript: string | null;       // frozen at generate-click
    generationRef: string | null;
    tone: ReplyTone;
    takes: VoiceTake[];                   // ordered by createdAt
    selectedTakeId: number | null;
    stale: boolean;                       // script edited after synthesis
    boundRoute: { accountId: string; groupId: string; routeNonce: number };
  }
  interface VoiceTake {
    voiceNoteId: number; clientRequestId: string;
    view: VoiceNoteStatusView;
    audio: ArrayBuffer | null; blobUrl: string | null;
  }
  ```
- Rules the tests must pin:
  - `clientRequestId` minted per TAKE (`crypto.randomUUID()`), frozen in
    the snapshot; a `voice_quota_denied` response marks that id BURNED —
    «Ещё вариант» after a quota denial mints a fresh id, never reuses.
  - Canonicalize (NFC, CRLF→LF, trim) once when «Сгенерировать» is
    clicked; the canonical string goes into the snapshot and every
    create/resend for that take.
  - Recovery: on controller boot, read `storage.session`; for each live
    attempt (TTL not expired, route tuple matches current route) resume:
    takes with a voiceNoteId → `voice:noteStatus` poll; a take whose create
    was in flight → re-issue `voice:noteCreate` with the SAME snapshot
    (server replays idempotently). A voice-script SSE that died → phase
    back to 'script' with the last delta text (manual regenerate — the SSE
    lane is not replayable).
  - Persist AFTER every transition (snapshot without `audio`/`blobUrl` —
    bytes are refetched via the free audio GET on resume).
  - Script edit while takes exist → `stale = true` (attach disabled);
    restoring the EXACT canonical text clears staleness.
  - Status polling: `VOICE_STATUS_POLL_MS` while any take is
    queued/dispatched; stop on terminal states; `voice_indeterminate`
    view → UI offers «Проверить статус — бесплатно» (manual re-poll), a
    new synthesis only via explicit «Сгенерировать заново» (fresh id).
  - Port reconnect: re-arm via an explicit handshake (the voice flow is
    EXEMPT from the generic on-disconnect state wipe — verify content
    index.ts's disconnect handler leaves voice state alone).

- [ ] **Step 1:** failing controller tests (fake port + fake
  storage.session) covering every rule above; **Step 2:** implement;
  **Step 3:** green + typecheck; **Step 4:** commit
  `feat(voice): content attempt controller with session recovery`.

---

### Task 4: Content — attach adapter

**Files:**
- Create: `src/content/voice/attach-adapter.ts`
- Test: `tests/voice-attach-adapter.test.ts` (new, jsdom fixture mirroring
  the spike DOM: `app-group-message-input` wrapping a hidden
  `input[type="file"]` with `multiple` + audio accepts)

**Interfaces:**
- `probeComposer(): { ok: true; input: HTMLInputElement } | { ok: false }`
  — self-check for `app-group-message-input input[type="file"]` (exactly
  one match required). The UI calls this BEFORE rendering the attach
  button; `ok:false` → Download-only UI, never a dead click.
- `attach(input, file: File): AttachOutcome` — the spike-proven handoff:
  `DataTransfer.items.add(file)` → `input.files = dt.files` → dispatch
  bubbling `change`. No drag events, no clicks.
- Xray note (spike caveat): construct `DataTransfer` in the page context
  when the content-script world's assignment is rejected —
  `window.wrappedJSObject` + `cloneInto`/`exportFunction` (session-capture
  precedent). Implement content-world first; the page-context leg goes
  behind a feature check `try { input.files = dt.files } catch → page leg`.
- Success observation: after the handoff, poll the composer subtree (300ms
  interval, 10s budget) for the attachment/waveform element appearing;
  resolve `'confirmed'`, else `'uncertain'` (UI shows «Проверьте composer»
  and the adapter refuses re-fire until explicitly re-armed).
- At-most-once: `attach` consumes the attestation token BEFORE dispatching;
  an `uncertain` outcome never auto-repeats.
- The adapter never touches the network; the File is built by the caller
  (`new File([bytes], 'voice-note.mp3', { type: 'audio/mpeg' })`).

- [ ] **Step 1:** failing jsdom tests (probe finds/misses the input;
  handoff sets files + fires change exactly once; token consumed before
  dispatch; uncertain state blocks re-fire); **Step 2:** implement;
  **Step 3:** green; **Step 4:** commit
  `feat(voice): attach adapter on the spike-proven native-input handoff`.

---

### Task 5: UI — лента (shared voice components)

**Files:**
- Create: `src/content/voice/voice-panel.ts` (лента container + shared
  components: script editor, meta row, tone chips, takes list, actions)
- Modify: `src/content/button-bar.ts` (🎙 Voice button, rendered only when
  `TabUiState.voiceNotesCapable`)
- Modify: `src/content/index.ts` (mount wiring; voice state exempt from
  generic disconnect cleanup)
- Modify: `src/content/styles.css` (family theme: terracotta accent, serif
  script, mono counters — chatgoose- prefixed classes)
- Test: `tests/voice-panel.test.ts` (new)

**Interfaces (per the spec's settled-UX section — all copy verbatim from
the spec/mockups):**
- Script phase: adapted script in a serif editor; `Исходник · <draft> · ↺`
  one-line row (ellipsized, ↺ restores); meta row `N / 600 · ≈K сек`
  (advisory count + duration at 14 chars/s); tone chips (Тёплый/Игривый/
  Спокойный → replyTone casual/flirty/none mapping decided here; chips
  re-run voice-script — «пресеты бесплатны»); primary button
  «Сгенерировать войс — потратит ~N символов».
- Generation is non-blocking: panel stays interactive, busy row «Вариант K
  генерируется… можно продолжать работать», prominent completion
  indicator; NO autoplay.
- Takes phase: takes list ordered by createdAt («Вариант 1 · 0:06»),
  manual player (play/pause/progress via `<audio>` on the blob URL), ⬇
  download per take, radio selection; header link «+ Ещё вариант · ~N
  симв.»; stale badge «устарело — текст изменён» + disabled attach when
  stale; primary «Прикрепить для @<fanUsername>» (from the attach grant);
  degradation: probe fails → primary becomes «Скачать MP3» + amber notice
  «Не нашли окно вложений Fansly».
- After confirmed attach: focus hint «Выберите Free/PPV и подтвердите
  Upload»; leftover-draft hint «Текст остался в поле — фан получит и
  текст, и войс. Убрать?» with one-click clear (composer clear via the
  existing textarea.ts write path; original stays recoverable in the
  panel).
- Error surfaces: every CG-VOICE code renders its money-honest string;
  `voice_indeterminate` → «Проверить статус — бесплатно»; billed failures
  say «Сгенерировать заново — потратит символы».

- [ ] **Step 1:** failing DOM tests (capability-gated button; phase
  renders; stale flow; degradation swap; leftover hint after confirmed
  attach); **Step 2:** implement; **Step 3:** green + visual pass in the
  live extension build; **Step 4:** commit
  `feat(voice): лента voice panel on shared components`.

---

### Task 6: UI — студия overlay

**Files:**
- Create: `src/content/voice/voice-studio.ts` (two-column overlay: script
  left, takes right — SAME components, second container)
- Modify: `src/content/voice/voice-panel.ts` (⤢ expand control)
- Modify: `src/content/overlay/*` (mount into the existing overlay surface)
- Test: `tests/voice-studio.test.ts`

**Interfaces:** «⤢ развернуть в студию» in the лента header ↔ «свернуть»
in the студия header; one controller instance — switching views loses
nothing (same attempt object, same takes, same selection). The
collapse-script-after-generation toggle from the mockups stays an open
UI-level conditional — implement BOTH renders behind a boolean constant,
default false (decide on the live panel, per the spec).

- [ ] **Steps:** failing mount/switch state-preservation tests →
  implement → green → commit `feat(voice): студия overlay on shared components`.

---

### Task 7: Integration, decision entry, PR

**Files:**
- Modify: `docs/decisions.md` (next E-number: the voice extension lane —
  dedicated protocol, session recovery, attested attach, two views)
- Test: full suite

- [ ] **Step 1:** `pnpm check` green (typecheck + lint + gates + tests +
  build) — the AI-cutover gate must stay green (voice rides the kernel
  lane, no new vendor surfaces).
- [ ] **Step 2:** decision entry in the same change; commit
  `feat(voice): decisions entry for the extension voice lane`.
- [ ] **Step 3:** push, Draft PR
  (`feat(voice): voice notes extension lane (лента + студия)`), then
  `agent review chatgoose --pr <N>` as the control-plane last step.
- [ ] **Step 4:** manual smoke on a live Fansly page with the pilot page
  allowlisted (owner-assisted): script → takes → attach → waveform →
  manual send; verify the rollout checklist items from the spec (step-7
  list) that are client-observable.

---

## Self-review notes (spec → plan coverage)

Spec UI/UX section → Tasks 5–6 (all settled-UX items enumerated, copy
verbatim); voice protocol + MV3 recovery → Tasks 1–3; attach adapter +
attestation → Tasks 2+4 (spike selector, waveform observation, Xray
fallback); capability plumbing → Task 2; storage rules → Task 3 (session
only, no migration); error/money wording → Tasks 1+5; leftover-draft hint
→ Task 5; two views one controller → Tasks 5–6; server-frozen semantics
(burned quota ids, 410 body-code matching, createdAt ordering, canonical
bytes) → Global Constraints + Tasks 2–3. Deliberately deferred (recorded
in the spec): quick mode, PPV tooling, voice-profile self-service UI,
last-view memory.
