# Coach — interactive AI coach chat (design spec)

Date: 2026-07-17 · Rev 2: 2026-07-18 · Status: awaiting owner review
Scope: chatgoose (extension) + core (kernel)
Provenance: brainstormed with the owner; codex design review + transcript-sourcing
follow-up + spec review (rev 2 folds in its verified must-fixes). Every reviewer claim
referenced here was verified against the code of both repos before adoption.

## 1. What and why

Coach is an interactive AI chat inside the Fansly conversation view: the chatter asks
free-form questions about the current fan («не знаю как продать», «как подать фану эту
инфу») and gets streamed, agency-methodology-grounded advice, with optional ready-made
wording they can insert into the composer.

Today's closest feature, `help-me`, is one-shot, has a fixed 3-section output, and takes
no user question. Coach is its conversational sibling; `help-me` stays (the owner plans
to return it to the toolbar separately). Value over "chatter pastes into ChatGPT":
zero copy-paste, fan context auto-attached, data stays in kernel custody, agency
methodology in the prompt, and per-feature usage visibility.

## 2. Settled product decisions

- **Context-bound:** Coach always works on the current fan conversation; transcript and
  fan data auto-attached. General sales questions are asked from the same place.
- **Multi-turn, rolling window:** the dialog never hits a wall; the coach "remembers"
  only the last N completed exchanges (N = setting, default 10). Older exchanges leave
  the model context but stay visible in the feed.
- **Advice + draft insertion:** proposed fan-message wording renders as a card with an
  explicit insert button. Sending is always the chatter's manual action (family law).
- **Surface:** chat mode inside the existing overlay shell. History survives close/
  reopen and fan switches (per-fan sessions, in-memory, tab-scoped).
- **Recap is a first-class input:** the kernel attaches the freshest stored recap on
  every coach turn (no extra generation); the chatter can explicitly refresh it (short
  or full); an opt-in setting automates that refresh. Recap comes in two sizes.

## 3. Behavior

### Entry and surface

- **Coach button** in the button bar + hotkey **⌘⇧C / Alt+Shift+C** (`c` is free; macOS
  reserved-combo list re-checked). Coach is an **app action** (like `spenders-board`),
  NOT a `HOTKEY_FEATURE` entry. **Invariant: opening Coach creates no AI generation and
  incurs no AI spend** (it MAY issue the metadata-only recap-status read, §5).
  `openCoach()` / `submitCoachQuestion()` / `closeCoach()` / `resetCoachSession()` are
  distinct operations.
- **The standalone Recap hotkey/button becomes an app action too** (§5): with the new
  start dialog, ⌘⇧S must open the picker, not instantly start a generation. Both
  leave `HOTKEY_FEATURE`'s 1:1 map.
- Overlay chat mode: message feed (chatter/coach turns) + composer. Enter sends,
  Shift+Enter = newline, `event.isComposing` respected. Esc while streaming = cancel;
  Esc while idle = close (session retained). Empty state shows starter hints and the
  recap status line (§5).
- While a turn streams the composer is locked; Cancel available (button + ⌘⇧X).
- **Concurrency rule:** a coach turn is a regular single active operation — starting any
  other feature while it streams is blocked with the existing `another_operation` toast.
  When Coach is open but idle, another feature's hotkey closes Coach (session retained)
  and proceeds normally.

### Session state model

Visible history and wire history are **separate structures** (a rolling window plus
error/system items means the feed is a superset of the wire history):

```ts
type CoachFeedItem =
  | { kind: 'exchange'; ref: CoachExchangeRef }        // completed Q/A
  | { kind: 'failed-attempt'; question: string;         // partial text DISCARDED
      errorCode: string; retryable: boolean }
  | { kind: 'recap-step'; mode: 'short' | 'full';       // visible recap run
      origin: 'auto' | 'explicit'; status: 'running' | 'done' | 'failed' };

interface CoachExchange {
  operationId: string;
  generationRef: string;      // from stream meta; survives SW restart with the session
  question: string;
  answerRaw: string;
  drafts: CoachDraft[];       // parsed on completion
  completedAt: number;
}

interface CoachSession {
  sessionId: string;               // random per page-load; part of the bg cache key
  feedItems: CoachFeedItem[];      // what the chatter sees (incl. failures, recap steps)
  completedExchanges: CoachExchange[]; // canonical dialog; only source for the wire
  composerText: string;            // unsent question survives close/switch
  pending?: CoachAttempt;          // in-flight; never serialized to wire
  recapStatus: RecapStatus;        // from the metadata read, §5
}

// serializeCoachHistory(session, settings): CoachHistoryEntry[]
// — the bounded tail: last N completed exchanges (N = coachHistoryLimit),
//   further trimmed (drop oldest whole exchanges) to the kernel char budgets (§7).
```

- Session key: `(creator account id, Fansly group id)` — never fan display name alone.
  LRU of 5 sessions, in-memory in the content script; page reload creates new
  `sessionId`s (this is the "reload clears" rule). Session resets when the
  account/persona mapping for the tab changes (no cross-persona bleed).
- An exchange is committed **only** when its stream completes usably (§8). A failed/
  cancelled attempt becomes a `failed-attempt` feed item retaining the question and a
  Retry action; its partial answer text is discarded (one behavior, no "or"). Retry
  reuses the question with a fresh operation id and freshly refreshed transcript.
- Serializability constraint: core caps coach output (§7) below the per-entry history
  bound, so every committed answer is always serializable — dropping old exchanges is
  never needed to "repair" the newest one.
- «Новый диалог» clears the session (confirm if non-empty) and forces a full
  transcript reseed on the next question.

### Transcript cache ownership (content vs background)

Message fetching, PPV enrichment, and normalization live in the **background** (that is
where they happen today); the content script owns only dialog/feed/composer state:

- Background keeps the normalized transcript snapshot + enrichment cache keyed by
  `(tabId, coachSessionId, creatorAccountId, groupId, quickMessageCount)`. A changed
  `quickMessageCount` (or any key part) is a miss; increasing the window forces a
  reseed, decreasing may trim.
- A service-worker restart is a plain cache miss → safe full quick-window reload on the
  next turn. Nothing about the dialog is lost (it lives in content).
- `transcriptCoverage` (§6) is derived in background after pagination + formatting; it
  is **not** a content→background protocol field — it exists only on the
  background→kernel `clientContext`.

### Draft cards

- The kernel prompt contract wraps proposed fan wording in fenced ```` ```draft ````
  blocks. Grammar: line-anchored open/close fences, max 2 blocks per answer, max 1500
  chars each, empty blocks ignored. Violations (unclosed, oversized, third block)
  render as escaped prose and never become insertable cards. Parsed **only** from
  successfully completed answers; blocks are stripped from prose rendering. A fixture
  of the core output format is pinned against the extension parser test.
- Card actions: **Insert** (composer empty) / **Replace draft…** (composer non-empty —
  confirm; the existing insertion selects-and-replaces the whole textarea) / **Copy**.
  After insert: overlay collapses (session retained), Fansly composer focused.
- Acceptance attribution: each exchange retains its kernel `generationRef` (the
  background op→ref map is a bounded in-memory cache and dies with the service
  worker — not sufficient for a long-lived feed). Lifecycle scope in v1 is
  **`copied` and `inserted` only** — the extension protocol supports exactly those;
  `edited`/`sent` provenance is out of scope.

## 4. Coach context matrix

Included every turn (assembled kernel-side; the extension ships raw values only):

| # | Input | Mechanism |
|---|---|---|
| 1 | Fan transcript, `quickMessageCount` window | background session cache, §6 |
| 2 | Fan display name | account lookup ONLY — see the custom-name rule below |
| 3 | Spend + subscription data | existing `includesEarnings` path, enabled for coach |
| 4 | Fan bio | NEW shared policy flag `includesFanBio` (§7) |
| 5 | Model persona (voice, boundaries) | `personaKey` already in every request; coach prompt must consume it |
| 6 | Kernel fan dossier | `usesFanProfile: true` under the existing env rollout gate |
| 7 | Freshest usable stored recap + age/mode | kernel-side attach, §5 |
| 8 | Coach dialog history (rolling window) | `coachHistory`, §7 |
| 9 | The chatter's question | `chatterQuestion`, §7 |
| 10 | Transcript coverage flag | `transcriptCoverage`, §6 |

Optional (per-turn checkbox in the coach composer, default off):
**«Include my current unsent draft»** → existing `draftText` field.

**Custom-name rule (implementation rule, not just a test):** for every policy-covered
feature, the kernel-facing `fanDisplayName` comes ONLY from the Fansly account
response (username/display name); if the lookup fails, send a neutral `"fan"`. The
DOM label is chatter-only display state (it can carry the chatter's custom fan name)
and today it is used as a fallback — that fallback must not reach prompts. DOM/custom
names remain local UI labels. Tested with a sentinel custom name on the lookup-failure
path.

Also excluded: chatter fan notes, any other fan's data (spenders board etc.).
The agency methodology lives in the kernel system prompt; the extension knows nothing
about it.

## 5. Recap: two sizes, status, attach, orchestration

### Sizes and the standalone feature

- **Full recap:** window = `deepMessageCount` setting. Default bumped **1500 → 3000**
  (migration §9). Continues to populate the local summary cache and the Hub dossier
  (`fan_profiles`) exactly as today.
- **Short recap (new):** fixed 300-message window (`SHORT_SUMMARY_MESSAGE_COUNT`
  const), compact kernel prompt (key facts, spend patterns, triggers, boundaries,
  active threads) **with a hard mode-specific output cap** (a compact prompt alone
  does not bound output; full's adaptive reservation must not apply). Contract:
  optional `summaryMode: 'short' | 'full'` — but **omitted means legacy full** and the
  field is only ever SENT for short (rollback compatibility, §7). Valid for
  `fan-summary` only, rejected elsewhere.
- **Persistence collision rule:** there is one local summary-cache key per group and
  every completed fan-summary is pushed to the Hub dossier today. Therefore: short
  recap is stored under a mode-qualified local cache key (legacy unqualified keys read
  as full) and is **never pushed to `fan_profiles`** — a short run must not overwrite
  the durable full dossier. Full behaves as today.
- **Standalone Recap UX (owner request):** Recap (button / ⌘⇧S) opens a start dialog —
  **Полный** (focused; ⌘⇧S+Enter keeps old muscle memory) / **Короткий** / «Открыть
  последний» (view the stored recap without regenerating); Esc cancels. Recap's hotkey
  becomes an app action (§3).
- **Coverage indicator:** the loader exposes `reachedEnd`; but reaching Fansly's end is
  not alone "full history" — the kernel-bound formatter drops oldest lines over its
  char cap and reports the KEPT count. Definition:
  `full-history = providerReachedEnd && no window trimming && kept == normalized`.
  The recap header shows the **kept** count («вся переписка, N сообщений» / «последние
  N — история длиннее»), and `transcriptCoverage: 'full-history' | 'window'` ships to
  the kernel.

### Recap status (before any question)

The coach empty state and the auto-recap decision need an authoritative answer to
«when was this fan last recapped, and how» — local state is not authoritative (other
tabs/devices, erasure). Add a **metadata-only, page-scoped SDK read** (no generation,
no AI spend — consistent with the §3 invariant): returns freshest usable recap's mode,
generated-at, coverage, requested/kept counts, or "none". The coach stream's response
additionally reports which recap was actually attached (it can differ from the earlier
status read) — delivered without changing the meta frames old clients parse (§7).

### Kernel-side attach (defined contract, not an impl detail)

On every coach turn core selects the freshest **usable** recap:

- Match page + canonical conversation identity (below); `feature = 'fan-summary'`;
  terminal outcome = completed; non-empty completion; no output-exhaustion stop
  reason; deterministic `ORDER BY created_at DESC, id DESC`.
- Generation `params` must record `summaryMode`, coverage, requested/kept counts, and
  persona — rows predating these fields (legacy) are excluded from attach.
- A composite index supports the lookup. Lookup failure **fails open** (coach proceeds
  recap-less) and is recorded in the context manifest.
- Attached recap is labeled with age + size in the prompt. **Dedupe:** if the attached
  recap is the same content as the injected dossier, inject once; if a short recap and
  an older full dossier are both present, label their distinct roles and budget them
  separately (§7).

**Canonical identity:** new Recap and Coach requests send
`conversationRef = Fansly groupId` and `fanRef = fanAccountId` (the contract already
separates these; the extension currently collapses them into `fanAccountId ?? groupId`).
During transition the attach lookup searches both the canonical and the legacy key.

### Orchestration (explicit state machine)

Recap runs have an **origin**: `standalone-full | standalone-short | coach-explicit |
coach-auto`; a coach question may chain after `coach-auto`. Rules:

- Every explicit/auto refresh **bypasses** `CompletedOverlayCache`, the local summary
  cache, and Hub dossier prefetch — otherwise it may serve a cache instead of
  generating.
- Setting `coachAutoRecap: 'off' | 'short' | 'full'` (default `'off'`); per-session
  override typed `inherit | off | short | full`. Staleness threshold 24h
  (`COACH_RECAP_FRESH_MS` const). **Mode matching:** `short` is satisfied by any fresh
  short OR full; `full` only by a fresh full generated at the current
  `deepMessageCount`.
- Auto-recap runs at most **once per coach session**, even after failure.
- The chain is cancellable as a whole; the visible recap step is a `recap-step` feed
  item (§3).
- **Failure taxonomy:** user cancel, route/account change, auth failure, global quota
  exhaustion, transcript-acquisition failure → **stop the chain**, preserve the
  question in the composer. A recap-specific model failure or a fan-summary feature
  ceiling → proceed to the coach turn; if an older recap exists the copy says
  «обновить Recap не удалось — использую рекап от <возраст>», not «отвечаю без него».
- Seed optimization (SHOULD): a just-completed auto-recap's newest pages seed the
  coach quick-window cache.

## 6. Transcript strategy (per-turn freshness without 40 requests)

Verified reality: transcripts are NOT read from the DOM — every generation paginates
`apiv3.fansly.com/api/v1/message` (25/page). A naive 10-exchange coach dialog at the
100-message quick window would cost ~40 message-page requests; visibility to Fansly is
the risk (model ban = failure mode).

**v1 = background session cache with overlap-and-replace** (codex concurrence; kernel-
archive alternatives rejected for v1 — §12):

1. First turn: load the full quick window (≤4 pages at defaults), cache in background
   (§3 ownership/keying).
2. Follow-up turns: fetch page 1 (newest 25). On id overlap — **replace the cached
   suffix covered by that page** with the fresh rows (Fansly messages are NOT
   immutable — the core sync upsert overwrites on conflict, verified; edits update,
   deletions disappear *within the refreshed region*). Fresh rows win for media /
   bundles / purchase-evidence maps too; no blind array concat (`normalizeTranscript`
   dedupe semantics are not merge-safe).
3. Full page with no overlap → keep paging until overlap or the window is rebuilt.
   Short page → treat as exhaustive, replace the snapshot.
4. Continuity impossible → full reload; decided **before** calling the kernel (context
   acquisition must not burn a generation).
5. Sort, cap to the window, format normally.

**Honest freshness guarantee (narrowed):** the newest tail is refreshed every turn;
older quick-window rows are snapshot data from the last (re)seed. Bounded reseeds
restore full-window correctness: «Новый диалог», the manual «Обновить контекст»
action, and cache invalidation (route/account/persona change, reload, LRU eviction,
window-setting change, SW restart).

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
    chars. The client's `serializeCoachHistory` trims (drop oldest whole exchanges) to
    satisfy BOTH the window setting and these bounds, so a valid client never gets
    rejected. Core caps coach output tokens so a committed answer always fits the
    per-entry bound (§3 serializability).
  - `summaryMode: 'short'` — optional; `fan-summary` only; **sent only for short**
    (omitted = legacy full; an old core never sees the field from a full run).
  - `transcriptCoverage: 'full-history' | 'window'` — optional clientContext addition
    (fansly-only), sent only for coach-chat and short-recap requests
    (capability-gating keeps old-core rollback safe).
- `clientContext` otherwise as today (transcript, name, spend, subscription, bio).
- **`includesFanBio` policy flag** replaces the hard-coded
  `feature === "hi-greeting"` bio checks on both sides. Enabled for: `hi-greeting`
  (unchanged), `help-me` (owner: its absence was a bug), `coach-chat`.
- Identity: `conversationRef = groupId`, `fanRef = fanAccountId` for coach + recap
  requests (§5); other features migrate opportunistically later.
- Prompt assembly: agency methodology (system) + context matrix (§4) + history +
  question; persona consumed; recap attach (§5); chatter question and prior model
  answers pass through the existing prompt-safety escaping/labeling pipeline.
- **Prompt budget is a runtime policy, not a test:** with worst-case inputs (max
  transcript + 120k history + full recap + dossier + bio + spend + draft + escaping
  expansion), core sheds deterministically — protect the question, safety/methodology,
  and the newest transcript; then drop oldest coach exchanges, then trim/dedupe
  recap/dossier to explicit bounds. Worst case additionally covered by tests.
- **Output-exhaustion normalization:** providers differ (Anthropic `max_tokens`,
  OpenRouter `length`) — normalize to one core-level exhaustion signal; fail-closed on
  it for **coach and both recap sizes** (a truncated recap must never be cached,
  pushed as dossier, or attached).
- Output contract: free text + the ```draft`` grammar (§3); fixture pinned.
- **DB migration (mandatory):** `ai_usage_events.feature` is a closed Postgres enum —
  add `coach-chat` in a numbered forward migration. Add coach to the owner Usage
  dashboard's feature column list (it is fixed, not derived).
- Recap-status metadata read (§5) as a new SDK operation; recap-attach repository
  query + composite index (§5).
- Model/reasoning policy for `coach-chat` set in core's feature policy tables
  (kernel-owned model selection; the extension gets NO model configuration — Options
  has none today and this feature adds none).
- Compat: only a **structured `unknown_ai_feature` error** maps to «Coach requires a
  newer Agency Hub» (a generic 404 may mean an unauthorized/missing page and must not
  be mislabeled). Compatibility tests: new-client/old-core, old-client/new-core, and
  rollback-after-extension-release.

## 8. Errors and fail-closed rules

- Transport truncation (already) AND the normalized **output-exhaustion signal** (§7)
  make a coach attempt non-committable. Empty/whitespace output fails too.
- A failed/cancelled attempt becomes a `failed-attempt` feed item (§3): partial text
  discarded, question retained, manual **Retry** (new operation id + client request
  id, same completed history, freshly refreshed transcript). Drafts never parsed from
  failed attempts.
- No auto-retry, with one documented inherited exception: the pipeline's single
  pre-stream `service_unavailable` retry (safe — a coach turn is not a fan send).
- Fan/route switch mid-stream cancels the operation (existing behavior); the pending
  question is preserved in that session's `composerText`.
- Recap-chain failures: taxonomy in §5.

## 9. Settings, storage, options (extension)

Migration **v13 → v14** (numbered, forward-only). Mechanically: the migration table is
a single jump-to-current normalizer, so v14 transforms the RAW v13 record (numeric
`deepMessageCount === 1500` → `3000`) **before** normalization with the new defaults:

- `coachHistoryLimit: number` — default 10, range 1–20 (kernel ceiling 20, §7).
- `coachAutoRecap: 'off' | 'short' | 'full'` — default `'off'`.
- `deepMessageCount` default 1500 → **3000**; every stored value other than exactly
  `1500` is preserved (a user who deliberately chose 1500 is indistinguishable from
  the old default — accepted).

Options UI: the two new coach fields join the Generation section; the `coachAutoRecap:
'full'` option carries a visible cost/latency warning (§11). No model UI (models are
kernel-owned).

Short-recap local cache uses mode-qualified summary-cache keys (additive; legacy keys
read as full — no key migration needed). Coach dialog state is not persisted anywhere.
(Kernel-side, core deliberately records all prompts and completions verbatim in its
restricted store — «ephemeral» refers to the client only. Restricted context metadata
gains `recapMode`, origin, attached-recap age, prompt bytes, history-entry count.)

## 10. Extension architecture (files)

- `src/shared/types.ts` / `features.ts`: `FeatureType` += `'coach-chat'`; policy:
  overlay surface, analysis mode, `resultKind: 'coach-chat'`, quick bucket, own
  `modelFeature`, fail-on-exhaustion flag (§8), `includesFanBio` flag (§4).
- `src/shared/protocol.ts`: `chatterQuestion`, `coachHistory`, `summaryMode` in the
  feature-start message (validators; `coachHistory` is the first array-valued field
  here — dedicated validator + tests). `transcriptCoverage` is NOT here (§3 — it is
  background-derived, kernel-bound only).
- `src/background/operations.ts` / `kernel-feature-gateway.ts` / `fansly-client.ts`:
  thread the new fields; transcript session cache (§3/§6) with the follow-up
  single-page mode; `reachedEnd`; kept-count coverage computation; canonical
  `conversationRef`/`fanRef` for coach + recap; custom-name rule (§4); recap-status
  read; generationRef delivery to content.
- `src/content/coach-session.ts` (new): `CoachSession` store (§3), LRU, keying,
  `serializeCoachHistory`, invalidation.
- `src/content/overlay/`: chat render mode — **keyed incremental renderer** (stable
  DOM per feed item, in-place streaming append), separately scrolling feed + sticky
  composer, auto-scroll only near bottom, `role="log"` + `aria-busy` + restrained
  announcements; long-feed virtualization (SHOULD). Bypasses `CompletedOverlayCache`
  and `overlayRawText` entirely. Recap start dialog (+ «Открыть последний»).
- `src/content/surface-planner.ts`: persistent `coachOverlayModel` slot (analogous to
  `deepOverlayModel`) + arbitration rules (§3).
- `src/shared/coach-draft.ts` (new): draft-fence parser (grammar + violations §3).
- `src/shared/hotkeys.ts`: `coach` AND `fan-summary` become app actions (§3); button
  bar gets `onCoachClick`; Recap button routes to the start dialog.

## 11. Limits, cost, operational risk

- Dialog window: client setting (≤20) + kernel hard ceiling + char budgets (§7).
- Existing kernel guards apply (daily request/$ limits, per-request $ cap, per-feature
  daily ceilings via live config). **Configure a conservative live `coach-chat`
  feature-cost ceiling for initial rollout**; no user-facing coach quota in v1. Recap
  attach is not "free" — it adds input tokens and restricted-store bytes every turn
  (that is the accepted price; no extra generation though).
- Input cost grows ~quadratically over a dialog (history resent each turn) — bounded
  by the caps above; accepted for v1.
- **Full recap at 3000 messages is heavy:** up to 120 message pages; pagination delay
  alone ≥35.7s before network latency, against a 180s deep-preparation budget. Before
  release: measure real 3000-message conversations (time + success rate), keep the
  whole recap→coach chain cancellable, and add request-count telemetry for ALL Fansly
  call classes (messages, group, account, earnings, subscription, PPV verification).

## 12. Explicitly out of scope (v1)

- **Kernel-side chat sessions** (state on the server) — client-held history chosen; a
  later migration is possible but NOT trivial (session auth/expiry/ordering).
- **Kernel-archive / hybrid transcript sourcing** — rejected for v1 (verified: the PR3
  union reader is OnlyFans-only in SQL and flag; Fansly archive cadence 30min/24h
  violates DP 1-B freshness; media/PPV material parity missing). If ever revisited:
  shadow measurements first, serve only on proof. The canonical
  `conversationRef`/`fanRef` split (§5) removes the identity blocker in advance.
- Toolbar redesign / returning Help to the bar (separate effort; Coach does not
  supersede `help-me`).
- `edited`/`sent` acceptance provenance (v1 = copied/inserted, §3).
- Pricing/media-catalog context; cross-device dialog continuity; periodic full-window
  auto-reseed (manual + bounded reseeds only, §6).

## 13. Testing

Vitest, alongside `pnpm check` (typecheck, lint, gates incl. AI-cutover, build):

- Policy table entries; hotkey table (BOTH new app actions, no feature mapping).
- Coach session: LRU touch/eviction, keying + account/group/persona isolation,
  `serializeCoachHistory` window + char-budget trimming, feed/wire separation
  (failed attempts and recap steps never serialize), commit rules, composer
  preservation, reset.
- Transcript cache: overlap-and-replace (edit/delete refresh within the tail),
  no-overlap paging, short-page snapshot replace, continuity failure → full reload
  before kernel call, cache-key invalidation incl. `quickMessageCount` change and SW
  restart.
- Draft parser: grammar, violation cases (unclosed/oversized/third block → escaped
  prose), fixtures pinned to core output, no parsing of failed attempts; Replace-
  confirm path; per-card `generationRef` attribution (copied/inserted only).
- Protocol validation incl. the array field; gateway threading; `summaryMode` sent
  only for short; `transcriptCoverage` only on the kernel edge; coverage definition
  (`reachedEnd` + kept==normalized); kept-count header.
- Open-coach-sends-no-generation; submit sends exactly one; cache bypass on
  explicit/auto recap refresh; chunk/complete/error keyed to pending operation;
  exhaustion/truncation/cancel/route-switch/SW-restart never commit; Retry = new UUID
  + fresh transcript; one-auto-recap-per-session.
- Recap: short never pushes to Hub dossier; mode-qualified cache keys (legacy = full);
  auto-mode matching; failure taxonomy branches (stop-chain vs proceed-with-older).
- Custom-name rule: sentinel custom name on lookup failure → `"fan"` on the wire.
- Migration v14: both new fields; `1500 → 3000` raw-value transform; any other value
  preserved.
- Renderer: keyed updates preserve focus/caret/scroll; Esc semantics; a11y roles.
- Core side (in core's suite): feature-specific body validation, prompt escaping +
  shedding priorities, enum migration, recap selection query (usable-only, ordering,
  legacy exclusion, dual-key transition), attach fail-open + manifest, dedupe vs
  dossier, short output cap, exhaustion normalization across providers, worst-case
  payload, compat matrix (new/old × client/core + rollback), restricted-capture rows.

## 14. Sequencing

1. **core PR:** enum migration + contract fields + `coach-chat` feature (prompt incl.
   methodology/persona/recap attach + budget shedding) + short-recap prompt/cap +
   recap-status read + recap selection query/index + exhaustion normalization +
   validation + tests; core decision-log entry in the same PR.
2. **Re-vendor SDK** into chatgoose (`vendor-sdk.mjs`), own commit.
3. **extension PR:** everything in §9–§10 + tests; `docs/decisions.md` E-entry in the
   same PR. Via branch + PR per repo rules; `pnpm check` green.
4. **No deploy:** accumulates for the 2.0 release. At release: deploy core first
   (migration + runtime), smoke `coach-chat` against prod, then ship the extension.
