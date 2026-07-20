# Voice notes (ElevenLabs TTS) — design

Date: 2026-07-18, rev 2. Status: implemented in core #15 and extension #21;
later hardening is recorded in core Decisions #174–#175 and extension E47.
Rev 1 was settled with the owner and cross-reviewed by codex; rev 2 incorporates
a second adversarial codex review (13 findings; every code-level claim
re-verified against both repos before adoption). Cross-repo: covers both `core`
(kernel) and `chatgoose` (extension); they ship separately (see Rollout).

## Problem

Chatters want to send voice messages in the model's voice. Fans expect the
actual model's voice (GFE); a voice note is either free (retention) or
PPV-priced — on Fansly the price is just an attribute of the same chat
attachment, set in the native composer at send time. The extension has no
audio generation today, and the kernel has no TTS vendor.

## Product decisions (fixed during brainstorm)

- **One flow, not two:** the voice note is an audio attachment in the chat
  composer; the chatter optionally sets a PPV price with Fansly's native UI
  and clicks Send manually. No separate PPV pipeline.
- **Voice = per-model ElevenLabs voice clone.** Instant Voice Clone (v3
  guidance, see phase-0 findings), created in the production EL workspace
  from owner-collected samples; the "Fansly page → EL voice ID" mapping
  lives kernel-side.
- **Delivery = the page's own attach flow.** The extension hands the file
  to Fansly's native file-input/drop handling in page context; the PAGE
  uploads it. The extension never calls a Fansly upload or message-send
  endpoint (its Fansly client is read-only today and stays that way).
  Fallback is a download button — never a direct-upload fallback.
- **Script adaptation before synthesis.** Chat-style text is adapted
  kernel-side by an LLM step into a speakable script with EL v3 audio
  tags; the chatter reviews/edits the script before any EL characters are
  spent. Because the chatter can edit, the FINAL submitted script is
  re-validated server-side at synthesis time (length, tag allowlist,
  markup) — the voice-script output validation alone proves nothing about
  what actually gets synthesized. Scripts are non-explicit by owner
  decision (product usage, not a technical guarantee; EL-side moderation
  is the backstop).
- **Family law holds:** AI never sends without explicit human action; Send
  is always manual; no automatic retry of anything indeterminate; zero
  automatic vendor retries.

## Architecture: two-step, kernel-owned

```text
draft → voice-script (SSE feature lane) → chatter reviews/edits script
      → explicit "Generate voice" → POST voice-notes (admission + async dispatch)
      → GET voice-notes/:id (status poll) → GET voice-notes/:id/audio (binary)
      → local preview player → explicit "To chat" (attested native attach)
      → chatter sets price → manual Send
```

Rejected alternatives: single call that adapts+synthesizes in one shot
(spends EL characters before the script can be corrected; a possible later
"quick mode" ON TOP of this contract); extension→ElevenLabs direct
(violates E3 kernel-only AI); synchronous long-held create (rev 1 shape —
dropped because v3 full-render latency is unbenchmarked, the extension's
quick-operation budget is 60 s, and recovery via re-POST would require the
client to retain and resend the whole payload through mutable admission
logic).

## Kernel half (core)

### 1. `voice-script` — a text feature on the existing SSE lane

A new feature in the Stage-30 registry, but a **distinct result kind**, not
another `single-reply`: it must not inherit reply sanitization, insertion
actions, split behavior, acceptance semantics, or the generic operation
path's transparent `service_unavailable` retry (voice-script uses manual
retry like the rest of the voice flow). Adding it is NOT a one-line
registry entry — the Phase 1 plan must cover the full ripple: DB feature
enum migration, shared/contracts unions, prompt template + result-kind
union + manifest, provider token/temperature maps, ledger configuration,
and a dedicated result parser.

Policy: requires `draftText` (existing `gate_draft_required` pattern), a
short transcript window (the script step needs the draft plus a little
tone context, not the deep-feature transcript minimum), no
earnings/subscription/dossier context, a product-level script length cap
well below EL's 5,000-char v3 request cap, and output validation with an
**allowlist of permitted v3 audio tags** (our own product vocabulary —
EL has no closed enum; unknown bracketed tags are rejected, not silently
stripped). The SSE `generationRef` is delivered to the CONTENT side over
the voice protocol (see extension half) and sent to synthesis as
`sourceGenerationRef`.

### 2. Voice-note resource — async create + status + binary audio

```http
POST /api/v1/pages/:pageLabel/voice-notes          → 202 + JSON {voiceNoteId, status}
GET  /api/v1/pages/:pageLabel/voice-notes/:id      → JSON status (never contacts EL)
GET  /api/v1/pages/:pageLabel/voice-notes/:id/audio → audio/mpeg
```

All three routes carry an explicit declarative `scope:"page"` auth
declaration (kernel Stage 19 — path placement alone is not enforcement).
Create body: `{ clientRequestId (uuid), conversationRef,
sourceGenerationRef, script }`.

**Admission (new jobs only).** On first admission the handler checks:
principal owns the page; platform is Fansly; the NEW-DISPATCH kill switch;
page allowlist; a live voice profile; final-script validation (length,
tag allowlist, markup rejection, canonical Unicode/newline normalization —
the same canonical bytes feed hashing, storage, and the provider);
`sourceGenerationRef` must reference a COMPLETED `voice-script` generation
owned by the same user/page/conversation; quota reservation. The profile
(voice id, model, settings, output format, version) is snapshotted into
the job at admission — replays never re-resolve it.

**Idempotency.** Unique `(user_id, client_request_id)`. The request hash
covers CLIENT INTENT ONLY: page, conversationRef, sourceGenerationRef,
canonical script bytes. Mutable server config (profile version, kill
switches, quotas) is deliberately NOT part of the hash — a paid completion
must stay replayable after a profile change or de-allowlisting. Duplicate
POST with the same id: same hash → return the existing job's state (this
is also the recovery path — admission gates are NOT re-run; only authn +
page access are); different hash → `409 idempotency_mismatch`. Retrieval
(status/audio GET) re-checks authn + page access only, plus a separate
RETRIEVAL kill switch; audio rows are looked up by the ownership tuple
(voiceNoteId + pageId + userId), mismatches return an indistinguishable
404, responses are `Cache-Control: private, no-store` + `nosniff`.

**Durable at-most-once dispatch (decision #158 pattern).** Admission
persists the job row (`queued`); a CAS transition with an attempt token
grants dispatch; `dispatch_committed` is persisted BEFORE the network
write to EL; the EL call runs detached from the request (the POST returns
202 after the CAS, it does not await synthesis; client disconnect never
cancels a dispatched job; no new worker process for the pilot — a restart
mid-flight is caught by the sweep). States:

```text
queued → dispatched → completed
                    → failed_definite      (EL refused before billing)
                    → failed_after_dispatch (billed but artifact bad:
                       truncated bytes, MIME, store-write failure —
                       "Generate again" is a NEW paid attempt; the UI says so)
                    → indeterminate        (lease expired with no outcome)
queued → quota_denied (admission-time, terminal)
completed → artifact_expired (retention purge; audio GET → 410)
```

A sweeper moves abandoned `queued` rows (crash between commit and CAS) and
lease-expired `dispatched` rows to their terminal/indeterminate states and
releases quota/concurrency reservations; late EL completions are accepted
only from the matching attempt token. Each outcome is classified
billed/unbilled explicitly (EL `character-cost` header when present). A
new EL dispatch happens ONLY from an explicit "Generate again" click
(fresh `clientRequestId`); status/audio reads can never spend characters.

### 3. Artifact storage — explicit decision, supersedes core #36

Core decision #36 says "Postgres text/JSON only; no binary or object
storage in v1", and production mounts no writable shared artifact volume —
so voice audio storage is a RECORDED core decision, not an implementation
detail. v1 choice: **BYTEA in Postgres**, bounded and honest: per-row size
cap (2 MB — a 30 s note at `mp3_44100_128` is ~480 KB), per-page count
cap, and an explicit retention job (audio bytes purge after a TTL that
comfortably exceeds a work shift — 7 days; metadata rows stay durable;
purge is a recorded, logged deleter — core retention law forbids a quiet
TTL cleaner). At pilot volume (~50 notes/day) this is ~25 MB/day worst
case, trivially inside Postgres and nightly backups. Object/volume storage
is the recorded escape hatch if volume grows past the pilot. The core
decision-log entry superseding #36 for this bounded class ships with the
Phase 1 change — owner signs it off there.

### 4. TTS usage ledger — its own table

`ai_usage_events` cannot take EL rows as-is (provider CHECK constraint
permits only `anthropic|openrouter`; fields are token-shaped). TTS gets a
character-oriented table: input characters (canonical count), provider
`character-cost`, pricing/config version, micro-USD + `costApproximate`,
provider request/trace ids + `x-region`, page/user/conversation,
voice-profile snapshot version, attempt token, outcome + billed flag +
duration, artifact size/hash/content type, `sourceGenerationRef`,
original-script hash, final-script hash, `scriptEdited`. Character budget
is reserved atomically at admission; caps: per-request, per-page/day,
global/day, max concurrent syntheses; reservations are settled or released
by the terminal transition (sweeper included). The `voice-script` LLM step
meters through the NORMAL AI ledger as an ordinary feature.

### 5. Egress: a non-platform vendor class + provider adapter

The egress resolver rejects unknown vendors AND the pacer maps vendors to
the social-platform enum (`ofapi→onlyfans`, `fansly→fansly`) — ElevenLabs
must NOT masquerade as a platform. Phase 1 introduces an explicit
non-platform vendor egress class (direct from the VPS, its own metrics,
no Fansly proxy or session material, zero automatic retries, deliberately
unpaced or trivially paced) and extends the raw-fetch ratchets/tests
accordingly. All EL HTTP lives in one provider adapter. A dedicated EL API
key restricted to TTS, with a per-key credit limit (a cap against
workspace usage, not a separate balance) and the VPS IP allowlisted — all
three controls verified 2026-07-18.

### 6. Voice profiles + capability flag

Per-page voice profile: EL voice id, model (`eleven_v3`), stability
(Natural), output format (`mp3_44100_128`), version (snapshotted into jobs
at admission). Owner-managed via the kernel CLI first (the `page
set-proxy` precedent). Availability reaches the extension as an optional
`capabilities.voiceNotes` boolean added to the assigned-page schema of the
existing visible-pages response — no voice id is ever exposed; a missing
field means disabled (old kernels and rollbacks stay compatible). The flag
is a UI hint only; the create endpoint stays authoritative.

## Extension half (chatgoose)

### UI (inline panel) — settled UX (owner-agreed 2026-07-18)

A "Voice" action on the current draft opens the voice flow in the panel;
the flow is three actions inside ChatGoose (script → generate → attach),
followed by Fansly's own native Upload/PPV/Send.

- **Two views, one controller (owner decision 2026-07-18, mockup round):**
  the voice UI is built as shared components (script editor + meta, tone
  chips, takes list, attach/download actions) driven by ONE content-side
  attempt controller, rendered in two containers: the default compact
  "лента" in the existing inline panel, and an optional two-column
  "студия" overlay (script left, takes right) opened via an expand
  control and closed back to the panel — mini-player ↔ full-player
  pattern; state is shared, switching loses nothing. The overlay rides
  the extension's existing overlay surface. Build order inside Phase 2:
  лента first (the pilot needs only it), студия immediately after on the
  same components. Whether the script collapses to a one-line row once
  takes exist is a deliberate open toggle — decided on the live panel,
  not in mockups (both behaviors are one conditional render).

- **Script step:** opens with the ADAPTED script already in the editor;
  "Restore original" swaps the raw draft back; a character counter
  (mirroring the kernel cap) and an estimated duration (~13–15 chars/sec)
  sit alongside. 2–3 tone preset buttons re-run the voice-script LLM step
  (free of EL characters) — script edits and tone presets spin the TEXT;
  they never spend EL characters, and the UI says so.
- **Generation is non-blocking:** the panel stays usable ("you can keep
  working — the result will be kept"); completion shows a prominent
  indicator. No autoplay — the chatter presses play when convenient.
- **Takes, not replacement:** each "Another take — costs ~N characters"
  click synthesizes the SAME script again under a fresh `clientRequestId`
  (a new voice-note row server-side; v3 is non-deterministic, so takes
  differ). The panel lists takes ("Take 1 · 0:06 …"), each with a manual
  play/pause/seek player and Download; the chatter selects one. Editing
  the script marks ALL takes stale. Spend is bounded by the daily
  character budget.
- **Attach:** the button reads "Attach for @<fan username>" (the name
  comes from the same background attestation that guards the attach) and
  binds to the SELECTED take's voiceNoteId. After the handoff, focus
  moves to Fansly's native dialog with the hint "choose Free/PPV and
  confirm Upload". Success criterion: the waveform preview appearing in
  the composer; an unclear outcome shows "check the composer" and never
  auto-repeats.
- **Degradation:** the adapter self-checks the composer selector BEFORE
  rendering the attach button — if Fansly's DOM changed, the button is
  replaced by "Download MP3" outright, never a dead click.
- **Source text and the leftover draft:** the voice source is the NATIVE
  Fansly composer draft (typed by the chatter or inserted by an AI reply
  — the same live-DOM read improve-draft uses; `requiresDraft` gives the
  empty-field error). The panel edits the adapted SCRIPT; the composer
  draft stays untouched. Because Fansly sends text + attachment as one
  message, a confirmed attach (waveform observed) shows a hint: "Текст
  остался в поле — фан получит и текст, и войс. Убрать?" with a one-click
  clear; the original stays recoverable in the panel. Never auto-clear —
  silently mutating the composer right before a manual Send is a
  surprise; a chatter who wants a text caption just ignores the hint.
- **Money-honest wording everywhere:** "Check status — free" vs
  "Generate again — costs characters".

Preview audio uses `blob:` URLs created in the content context, revoked
on regeneration, navigation, or panel close. Deliberately NOT the
reply-draft component (no insert/[NEXT]/acceptance semantics). The Voice
button renders only when the tab's page has
`capabilities.voiceNotes` — which requires plumbing that does not exist
yet: today `pages()` is called transiently for label resolution and its
result is discarded, and `TabUiState` carries no capability. Phase 2 adds:
resolve capability at tab/account init, carry it through `TabUiState`,
bounded cache with invalidation, fail closed when absent/stale.

### Voice protocol and MV3 recovery (new surface, not reuse)

The existing operation protocol cannot carry this flow: `operation:complete`
does not expose `generationRef` to content, content wipes operation state
on port disconnect, and background port loss cancels active operations. So
the voice flow gets a DEDICATED port protocol: the voice-script completion
message delivers `generationRef` to content; voice attempt state is owned
by content, exempt from the generic disconnect cleanup, and re-armed via an
explicit reconnect handshake. The content controller owns the attempt:
`clientRequestId`, the exact canonical payload snapshot (script bytes,
conversationRef, sourceGenerationRef), and the flow phase — persisted as
minimal versioned metadata in TTL-bounded `storage.session` (survives a
content reload within the browser session; never audio bytes; session
storage is ephemeral, so the "no storage migration" claim stands). After
reconnect or event-page death the controller re-issues the same idempotent
create/status calls from the snapshot — billing correctness never depends
on background memory. A voice-script SSE stream lost mid-flight is a
failed LLM attempt requiring manual regeneration (the SSE lane is not
replayable); only the synthesis resource is.

Audio moves background→content as an `ArrayBuffer` over the port
(structured clone). The SDK gains binary-response support IN CORE
(`sdk-runtime` + generator): a dedicated audio helper that parses
structured error envelopes, classifies `410 artifact_expired` as a typed
CG-VOICE error, and validates content type, declared length, size ceiling,
and sha256 (from status metadata) before handing bytes to UI. Building the
helper extension-side would violate the vendoring rule.

### Attach adapter (the risky seam — spike first)

An isolated content module. Prefer handing a `File` to the native file
input via `DataTransfer`; synthetic drop events are the brittle path. The
devtools-console spike proves the PAGE context; the adapter itself runs in
the content-script sandbox (Xray) — if Xray boundaries block the handoff,
the adapter injects the page-context leg (session-capture precedent); the
spike records which context works.

Attach is gated by a **fresh background attestation**: content cannot see
canonical fan identity (it lives in background `TabContext`), so
immediately before attach the content requests a single-use attach token;
background compares the attempt's bound tuple (tab, account, group, fan,
route nonce) against the CURRENT TabContext and refuses on any drift —
navigation during synthesis blocks attach rather than risking the wrong
conversation. Attach is at-most-once: the token is consumed on dispatch,
the adapter observes the composer's native confirmation, and an uncertain
outcome lands in a terminal "inspect composer / remove attachment" state
that requires explicit re-arming — never an automatic repeat. If the
script is edited after synthesis, the audio is marked stale and attach is
disabled until regenerated (or the exact script restored). The adapter
never touches Fansly network endpoints.

### Storage

No new persisted (`storage.local`) extension state: capability rides the
kernel response, attempt metadata lives in `storage.session` (ephemeral),
script/audio in memory. No storage migration.

## Error handling

Kernel structured codes map to typed CG-VOICE-xx errors (the existing
gate-code pattern): no profile / not allowlisted (defensive — button
hidden), quota denied, script over cap / tag rejected, EL definite
failure, `failed_after_dispatch` (billed — UI says "Generate again will
cost characters"), `indeterminate`, `idempotency_mismatch`, artifact
expired (410). UI rules: `indeterminate` offers "check status" (status
GET — free); a NEW synthesis happens only via explicit "Generate again"
(new id); truncated stream, decode failure, or sha256 mismatch fail
closed — a broken artifact is never attached. Manual retry everywhere;
zero auto-retries anywhere in the voice flow (including no inheritance of
the generic lane's transparent `service_unavailable` retry).

## Custody and retention

- Artifact class: recorded in core's decision log with the Phase 1 change
  (see §3 — bounded BYTEA + explicit logged purge, superseding #36 for
  this class; owner signs off there).
- Never log scripts, voice ids, audio bytes, or provider bodies. Script
  hashes (not text) go in the usage ledger; if final script text is
  stored, it goes in the restricted content class.
- EL-side retention: zero-retention is select-Enterprise-only (verified
  2026-07-18). v1 default: normal logging on a self-serve tier — EL
  retains script text and audio in its generation history; revisit if
  retention requirements change.
- Both repos record decision-log entries in the implementing changes —
  family law.

## External facts — phase-0 gates verified 2026-07-18

EL gate: **GO** (full table and sources in
`../plans/2026-07-18-voice-notes-phase0-findings.md`). Design-relevant:
v3 cap 5,000 chars (docs conflict — enforce 5,000, read `GET /v1/models`
at runtime); no closed tag vocabulary (kernel allowlist is our product
decision); headers `request-id`/`x-trace-id`/`character-cost`/`x-region`
confirmed (ledger records all four); NO native idempotency (kernel job
table is the only dedup layer); zero-retention select-Enterprise-only;
clone type IVC (PVC not yet v3-optimized; only the voice owner can create
her own PVC; IVC lives in the production workspace, non-shareable);
baseline profile `eleven_v3` + IVC + Natural + `mp3_44100_128` (~480 KB
per 30 s); plan Starter + PAYG — at the owner's stated real volume
(~20–30 one-sentence notes/day ≈ 60k chars/month) Starter's included pool
roughly covers everything, realistic cost $6–12/month ($45–60 was the
300-char growth scenario). The
adult-policy gate was dropped 2026-07-18 by owner decision (scripts are
non-explicit product usage; final-script validation + EL moderation are
the backstops).

Fansly gate: **GO — attach: native-input** (full evidence in the same findings
file). In Firefox, assigning a one-file `DataTransfer.files` to the unique
`app-group-message-input input[type="file"]` and dispatching one bubbling
`change` event opened the native Upload media flow. Manual and synthetic paths
matched on upload sequence, audio preview, and native PPV controls; Send stayed
manual and was never pressed. PAGE context is proved; the content-script/Xray
leg remains a Phase 2 adapter check with the already-designed injected
page-context fallback.

## Spike 0 — attach seam verdict: GO

Completed 2026-07-18 with a valid local MP3 in an agency-controlled test
conversation. The native-input path passed every checklist item: Fansly's page
owned the upload, preview and PPV UI matched the manual baseline, both composer
attachments were removed, and no message was sent. Phase 1 planning is
unblocked. Download-only remains the fallback if a future Fansly DOM change
invalidates both the recorded input seam and its page-context adapter.

## Rollout

1. Spike 0 (attach seam) — COMPLETE 2026-07-18 (`attach: native-input`).
2. Core: artifact-storage decision (supersedes #36) + tables, contracts
   (incl. binary SDK support), provider adapter, egress vendor class —
   behind a global-off kill switch.
3. `capabilities.voiceNotes` added to the visible-pages schema.
4. SDK re-vendor into chatgoose from a clean core commit (own change).
5. Extension release with the UI hidden when capability is absent.
6. Configure one voice profile; allowlist exactly one page.
7. On that page verify: dedup replay, quota denial + reservation release,
   background restart mid-flight, content reload mid-flight
   (storage.session recovery), lost-response recovery, wrong-route attach
   block, stale-script block, MIME/size/hash validation, artifact expiry
   (410), native upload parity.
8. Expand page by page. Quick mode and any PPV-specific tooling come
   later, on top of the same contract.

## Testing

- Core unit: feature policy for `voice-script` (draft gate, context
  minimalism, tag allowlist), the full transition table of the job state
  machine (every duplicate rule, CAS/lease/sweeper paths, quota
  settlement on every terminal state, late-completion fencing), final-
  script revalidation, ownership-tuple retrieval, ledger writes, egress
  vendor class, contract tests incl. the binary audio helper.
- Extension vitest: gateway mapping for the new feature kind and CG-VOICE
  codes, voice protocol shapes, storage.session attempt recovery (same
  `clientRequestId` reissued after reconnect AND after content reload),
  attach attestation (tuple drift refusal, single-use token, staleness,
  at-most-once terminal state).
- Drills on the pilot page: the rollout step-7 checklist; `pnpm check`
  green in both repos as always.
