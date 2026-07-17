# Coach — interactive AI coach chat (design spec)

Date: 2026-07-17 · Status: awaiting owner review · Scope: chatgoose (extension) + core (kernel)
Provenance: brainstormed with the owner; independently reviewed by codex (design pass +
transcript-sourcing follow-up); every reviewer claim referenced here was verified against
the code of both repos before adoption.

## 1. What and why

Coach is an interactive AI chat inside the Fansly conversation view: the chatter asks
free-form questions about the current fan («не знаю как продать», «как подать фану эту
инфу») and gets streamed, agency-methodology-grounded advice, with optional ready-made
wording they can insert into the composer.

Today's closest feature, `help-me`, is one-shot, has a fixed 3-section output, and takes
no user question. Coach is its conversational sibling; `help-me` stays (the owner plans
to return it to the toolbar separately). Value over "chatter pastes into ChatGPT":
zero copy-paste, fan context auto-attached, data stays in kernel custody, agency
methodology in the prompt, and per-feature usage visibility in `ai_usage_events`.

## 2. Settled product decisions

- **Context-bound:** Coach always works on the current fan conversation; transcript and
  fan data auto-attached. General sales questions are asked from the same place.
- **Multi-turn, rolling window:** the dialog never hits a wall; the coach "remembers"
  only the last N completed exchanges (N = setting, default 10). Old exchanges silently
  leave the model context but stay visible in the feed.
- **Advice + draft insertion:** proposed fan-message wording renders as a card with an
  explicit insert button. Sending is always the chatter's manual action (family law).
- **Surface:** chat mode inside the existing overlay shell. History survives close/
  reopen and fan switches (per-fan sessions, in-memory, tab-scoped).
- **Recap is a first-class input:** the kernel always attaches the freshest stored
  recap for free; the chatter can explicitly refresh it (short or full) before/at any
  point; an opt-in setting automates that refresh.

## 3. Behavior

### Entry and surface

- **Coach button** in the button bar + hotkey **⌘⇧C / Alt+Shift+C** (`c` is free; macOS
  reserved-combo list re-checked). Coach is an **app action** (like `spenders-board`),
  NOT a `HOTKEY_FEATURE` entry: opening the panel never spends anything.
  `openCoach()` / `submitCoachQuestion()` / `closeCoach()` / `resetCoachSession()` are
  distinct operations.
- Overlay chat mode: message feed (chatter/coach turns) + composer. Enter sends,
  Shift+Enter = newline, `event.isComposing` respected. Esc while streaming = cancel;
  Esc while idle = close (session retained). Empty state shows a placeholder with
  starter hints and the recap status line (§5).
- While a turn streams the composer is locked; Cancel available (button + ⌘⇧X).
- **Concurrency rule:** a coach turn is a regular single active operation — starting any
  other feature while it streams is blocked with the existing `another_operation` toast.
  When Coach is open but idle, another feature's hotkey closes Coach (session retained)
  and proceeds normally.

### Sessions and memory

- Session key: `(creator account id, Fansly group id)` — never fan display name alone.
  LRU of 5 sessions, in-memory in the content script; page reload clears all. Session
  resets when the account/persona mapping for the tab changes (no cross-persona bleed).
- Session state:

  ```ts
  interface CoachExchange {
    operationId: string;
    question: string;
    answerRaw: string;
    drafts: CoachDraft[];   // parsed on completion
    completedAt: number;
  }
  interface CoachSession {
    exchanges: CoachExchange[];      // completed only; drives feed AND wire history
    composerText: string;            // unsent question survives close/switch
    pending?: CoachAttempt;          // in-flight question; NEVER serialized to wire
    transcriptCache: TranscriptCache; // §6
    recapStatus: RecapStatus;         // §5
  }
  ```

- An exchange is committed **only** when its stream completes usably (§8). `pending`
  never enters `coachHistory`; Retry reuses the pending question with a fresh
  operation id and freshly loaded fan context.
- «Новый диалог» button clears exchanges (confirm if non-empty) and forces a full
  transcript reseed on the next question.

### Draft cards

- The kernel prompt contract wraps proposed fan wording in fenced ```` ```draft ````
  blocks. Grammar: line-anchored open/close fences, max 2 blocks per answer, max 1500
  chars each, empty blocks ignored. Parsed **only** from successfully completed answers;
  the block is stripped from prose rendering (no duplication). A fixture of the core
  output format is pinned against the extension parser test.
- Card actions: **Insert** (composer empty) / **Replace draft…** (composer non-empty —
  confirm; the existing insertion selects-and-replaces the whole textarea) / **Copy**.
  After insert: overlay collapses (session retained), Fansly composer focused.
- Each card carries its exchange's `operationId` so acceptance lifecycle events
  (`inserted`/`edited`/`sent`) attribute to the right generation in a multi-operation
  feed (the current overlay attributes to a single top-level operation — not reusable).

## 4. Coach context matrix

Included every turn (assembled kernel-side; the extension ships raw values only):

| # | Input | Mechanism |
|---|---|---|
| 1 | Fan transcript, `quickMessageCount` window | session transcript cache, §6 |
| 2 | Fan display name | existing account lookup |
| 3 | Spend + subscription data | existing `includesEarnings` path, enabled for coach |
| 4 | Fan bio | NEW shared policy flag `includesFanBio` (§7) |
| 5 | Model persona (voice, boundaries) | `personaKey` already in every request; coach prompt must consume it |
| 6 | Kernel fan dossier | `usesFanProfile: true` under the existing env rollout gate |
| 7 | Freshest stored recap + its age | kernel-side attach, §5 |
| 8 | Coach dialog history (rolling window) | `coachHistory`, §7 |
| 9 | The chatter's question | `chatterQuestion`, §7 |
| 10 | Transcript coverage flag | `transcriptCoverage`, §6 |

Optional (per-turn checkbox in the coach composer, default off):
**«Include my current unsent draft»** → existing `draftText` field.

Explicitly excluded (invariant + test): chatter-eyes-only fan notes / custom names
(never enter prompts — family rule), any other fan's data (spenders board etc.).

The agency methodology lives in the kernel system prompt; the extension knows nothing
about it.

## 5. Recap integration

Recap (`fan-summary`) becomes two-sized and coach-aware:

- **Full recap:** window = `deepMessageCount` setting. Default bumped **1500 → 3000**
  (migration preserves user-modified values, §9).
- **Short recap (new):** fixed 300-message window (`SHORT_SUMMARY_MESSAGE_COUNT`
  const — deliberately not a setting), compact kernel prompt (key facts, spend
  patterns, triggers, boundaries, active threads). Contract: optional
  `summaryMode: 'short' | 'full'` on the feature request, valid for `fan-summary`
  only, rejected elsewhere. Both sizes log as `fan-summary` generations.
- **Standalone Recap UX change (owner request):** pressing Recap (button / ⌘⇧S) now
  opens the overlay in a start state with two choices — **Полный** (focused, so
  ⌘⇧S+Enter keeps the old muscle memory) / **Короткий**; Esc cancels.
- **Coverage indicator:** the message loader already knows why pagination stopped;
  expose `reachedEnd` in `MessageLoadResult`. Recap header shows «вся переписка
  (N сообщений)» vs «последние N (история длиннее)»; the same fact ships to the kernel
  as `transcriptCoverage: 'full-history' | 'window'` so the prompt can frame the
  profile honestly.

Coach-side plumbing:

- **(б) Kernel-side attach, always on:** when assembling a coach prompt, core pulls the
  freshest completed recap for this `(page, conversationRef)` from its generation store
  (it records every generation verbatim) and includes it labeled with age and size
  («short recap, 10 min ago»). No client fields, no client traffic. Recap age is
  surfaced back to the client for the status line. (Store lookup path is an
  implementation detail to confirm in the core plan; the design decision is firm.)
- **(а) Explicit refresh:** coach empty state / header shows «Recap: 2 ч назад / нет»
  + buttons «Сделать Recap: Короткий / Полный» (runs as a visible system step in the
  coach feed).
- **(в) Auto-recap, opt-in:** setting `coachAutoRecap: 'off' | 'short' | 'full'`
  (default `'off'`; per-session toggle override in the coach header). When enabled and
  the freshest recap is absent or older than 24h (`COACH_RECAP_FRESH_MS` const), the
  first question of a session first runs the recap (visible progress step), then sends
  the question — the kernel attach picks up the fresh recap automatically.
- Recap failure never blocks coaching: the turn proceeds with whatever the kernel has,
  labeled «Recap не удался, отвечаю без него».

## 6. Transcript strategy (per-turn freshness without 40 requests)

Verified reality: transcripts are NOT read from the DOM — every generation paginates
`apiv3.fansly.com/api/v1/message` (25/page). A naive 10-exchange coach dialog at the
100-message quick window would cost ~40 message-page requests; visibility to Fansly is
the risk (model ban = failure mode).

**v1 = client session cache with overlap-and-replace** (codex concurrence; kernel-
archive alternatives rejected for v1 — see §12):

1. First turn: load the full quick window (as any feature today, ≤4 pages), cache in
   the session keyed `(creator account id, group id)`.
2. Follow-up turns: fetch page 1 (newest 25). If it overlaps cached message ids —
   **replace the cached suffix covered by that page** with the fresh rows (edited
   messages update, deleted messages disappear; Fansly messages are NOT immutable —
   the core sync upsert overwrites on conflict, verified). Fresh rows win for media /
   bundles / purchase-evidence maps too; no blind array concat (`normalizeTranscript`
   dedupe semantics are not merge-safe).
3. Full page with no overlap → keep paging until overlap or the window is rebuilt.
   Short page → treat as exhaustive, replace the snapshot.
4. Continuity impossible to establish → full reload; decided **before** calling the
   kernel (context acquisition must not burn a generation).
5. Sort, cap to the window, format normally.

Escape hatches: «Новый диалог» reseeds fully (§3); a manual «Обновить контекст» action
does the same without resetting the dialog. Cache invalidates on route/account/persona
change, reload, LRU eviction.

Net cost of a 10-exchange dialog: ~13 message-page requests vs ~40 naive (vs 10 for a
future kernel hybrid — not worth its cost now).

## 7. Kernel contract (work in core)

- New feature **`coach-chat`** in the AI feature registry; `POST
  /api/v1/ai/features/coach-chat`; SSE stream like every feature; fail-closed on
  truncation (existing gateway behavior).
- Request additions (the body schema is one generic strict object shared by all
  features, so):
  - `chatterQuestion: string` — optional in the schema; **required** for `coach-chat`
    in `prepareAiFeatureStream`, **rejected** for every other feature. Bounds 1–2000
    chars.
  - `coachHistory: Array<{question: string; answer: string}>` — completed exchanges
    only, oldest first. Optional in schema; coach-only. Kernel hard ceiling:
    ≤20 entries, per-entry `question` ≤2000 / `answer` ≤10000 chars, aggregate ≤120k
    chars. The client trims (drop oldest whole exchanges) to satisfy BOTH its own
    window setting and these bounds, so a valid client never gets rejected.
  - `summaryMode: 'short' | 'full'` — optional; `fan-summary` only (§5).
  - `transcriptCoverage: 'full-history' | 'window'` — optional clientContext addition
    (fansly-only like the rest of clientContext).
- `clientContext` otherwise as today (transcript, name, spend, subscription, bio).
- **`includesFanBio` policy flag** replaces the hard-coded
  `feature === "hi-greeting"` bio checks on both sides. Enabled for: `hi-greeting`
  (unchanged), `help-me` (owner: its absence was a bug), `coach-chat`.
- Prompt assembly: agency methodology (system) + context matrix (§4) + history +
  question; persona consumed; recap attach (§5); chatter question and prior model
  answers pass through the existing prompt-safety escaping/labeling pipeline.
- Output contract: free text + the ```draft`` grammar (§3); fixture pinned.
- **DB migration (mandatory):** `ai_usage_events.feature` is a closed Postgres enum —
  add `coach-chat` in a numbered forward migration.
- Model/reasoning policy for `coach-chat` set in core's feature policy tables
  (kernel-owned model selection; no new client model configuration).
- Worst-case request (max transcript + max history) tested against HTTP body, model
  context, and cost limits.
- Compat: an old core answering 404/unknown-feature maps to a specific client error —
  «Coach requires a newer Agency Hub» — not a generic failure.

## 8. Errors and fail-closed rules

- Transport truncation (already) AND **`stopReason === 'max_tokens'`** make a coach
  attempt non-committable (today max_tokens is only rejected for reply-mode features —
  verified; coach extends this via its policy). Empty/whitespace output fails too.
- A failed/cancelled attempt: partial text is discarded or visibly marked
  «Incomplete — discarded»; never rendered as a normal answer; drafts never parsed
  from it; the exchange never enters history.
- Error card in the feed with manual **Retry** (new operation id + client request id,
  same completed history, freshly refreshed transcript). No auto-retry, with one
  documented inherited exception: the pipeline's single pre-stream
  `service_unavailable` retry (safe — a coach turn is not a fan send; decided to
  inherit).
- Fan/route switch mid-stream cancels the operation (existing behavior); the pending
  question is preserved in that session's `composerText`.

## 9. Settings, storage, options (extension)

Migration **v13 → v14** (numbered, forward-only):

- `coachHistoryLimit: number` — default 10, range 1–20 (kernel ceiling 20, §7).
- `coachAutoRecap: 'off' | 'short' | 'full'` — default `'off'`.
- `deepMessageCount` default 1500 → **3000**; existing stored value bumped to 3000
  **iff** it still equals the old default (user-modified values preserved).

Options UI: the two new coach fields join the existing AI settings section;
`coach-chat` appears in the per-feature model view via the existing
`ModelSelectableFeatureType` pattern (runtime-only, no persisted model map — verified).

Nothing else is persisted: coach sessions are in-memory only. (Caveat for honest
wording anywhere user-facing: the KERNEL deliberately records all prompts and
completions verbatim in its restricted store — «ephemeral» refers to the client only.)

## 10. Extension architecture (files)

- `src/shared/types.ts` / `features.ts`: `FeatureType` += `'coach-chat'`; policy:
  overlay surface, analysis mode, `resultKind: 'coach-chat'`, quick bucket, own
  `modelFeature`, `failOnMaxTokens`-style flag (§8), `includesFanBio` flag (§4).
- `src/shared/protocol.ts`: `chatterQuestion`, `coachHistory`, `summaryMode`,
  `transcriptCoverage` in the feature-start message (validators; `coachHistory` is the
  first array-valued field here — dedicated validator + tests).
- `src/background/operations.ts` / `kernel-feature-gateway.ts`: thread the new fields;
  transcript session-cache read path (§6) with the follow-up single-page mode;
  `reachedEnd` from `loadMessages`.
- `src/content/coach-session.ts` (new): `CoachSession` store, LRU, keying, trimming,
  transcript cache, invalidation.
- `src/content/overlay/`: chat render mode — **keyed incremental renderer** (stable
  DOM per exchange, in-place streaming append), separately scrolling feed + sticky
  composer, auto-scroll only near bottom, `role="log"` + `aria-busy` + restrained
  announcements. Bypasses `CompletedOverlayCache` and `overlayRawText` entirely.
- `src/content/surface-planner.ts`: persistent `coachOverlayModel` slot (analogous to
  `deepOverlayModel`) + arbitration rules (§3).
- `src/shared/coach-draft.ts` (new): draft-fence parser (grammar §3).
- `src/shared/hotkeys.ts`: `coach` **app action**, letter `c`; button bar gets
  `onCoachClick`.
- Recap start dialog + coverage header in the existing recap overlay flow.

## 11. Limits and cost

- Dialog window: client setting (≤20) + kernel hard ceiling + char budgets (§7).
- Existing kernel guards apply: 500 requests/day and $10/day per chatter/page defaults,
  $5/request, per-feature daily $ ceilings available via live config. No coach-specific
  product limit in v1; watch `ai_usage_events` (coach is separately visible) and add a
  feature ceiling/alert if rollout shows abuse.
- Input cost grows ~quadratically over a dialog (history resent each turn) — bounded by
  the caps above; accepted for v1.

## 12. Explicitly out of scope (v1)

- **Kernel-side chat sessions** (`conversationRef` state) — client-held history chosen;
  a later migration is possible but NOT trivial (session auth/expiry/ordering).
- **Kernel-archive / hybrid transcript sourcing** — rejected for v1 (verified: the PR3
  union reader is OnlyFans-only in SQL and flag; Fansly archive cadence 30min/24h
  violates DP 1-B freshness; identity mismatch — extension sends `fanAccountId ??
  groupId` as `conversationRef` while the archive keys by group id; media/PPV material
  parity missing). If ever revisited: shadow measurements first (overlap rates, parity,
  latency), serve only on proof.
- Toolbar redesign / returning Help to the bar (separate effort; Coach does not
  supersede `help-me`).
- Adding the short/full picker anywhere beyond Recap + Coach; pricing/media-catalog
  context; cross-device dialog continuity.

## 13. Testing

Vitest, alongside `pnpm check` (typecheck, lint, gates incl. AI-cutover, build):

- Policy table entries; hotkey table (app action, no feature mapping).
- Coach session: LRU touch/eviction, keying + account/group/persona isolation, window
  + char-budget trimming, fail-closed commit rules, composer preservation, reset.
- Transcript cache: overlap-and-replace (edit/delete refresh), no-overlap paging,
  short-page snapshot replace, continuity failure → full reload before kernel call.
- Draft parser: grammar, fixtures pinned to core output, no parsing of failed
  attempts; insertion Replace-confirm path; per-card operation attribution.
- Protocol validation incl. the array field; gateway threading; `summaryMode` /
  `transcriptCoverage` routing; `reachedEnd`.
- Open-coach-sends-nothing; submit sends exactly one; cache bypass; chunk/complete/
  error keyed to pending operation; `max_tokens` / truncation / cancel / route-switch /
  service-worker-restart never commit; Retry = new UUID + fresh transcript.
- Migration v14 (both new fields; deep default bump preserves modified values).
- Renderer: keyed updates preserve focus/caret/scroll; Esc semantics; a11y roles.
- Guard test: chatter-eyes-only notes never reach the request builder.
- Core side (in core's suite): feature-specific body validation, prompt escaping, enum
  migration, recap attach, worst-case payload, restricted-capture rows.

## 14. Sequencing

1. **core PR:** enum migration + contract fields + `coach-chat` feature (prompt incl.
   methodology/persona/recap attach) + short-recap prompt + validation + tests; core
   decision-log entry in the same PR.
2. **Re-vendor SDK** into chatgoose (`vendor-sdk.mjs`), own commit.
3. **extension PR:** everything in §9–§10 + tests; `docs/decisions.md` E-entry in the
   same PR. Via branch + PR per repo rules; `pnpm check` green.
4. **No deploy:** accumulates for the 2.0 release. At release: deploy core first
   (migration + runtime), smoke `coach-chat` against prod, then ship the extension.
