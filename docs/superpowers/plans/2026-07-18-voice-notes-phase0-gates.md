# Voice Notes Phase 0 — Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the two go/no-go gates from the voice-notes spec — the
ElevenLabs policy/capability facts and the Fansly composer attach seam —
and record the verdicts so Phase 1 (core) and Phase 2 (extension) plans can
be written against facts instead of assumptions.

**Architecture:** No product code in this phase. Task 1 is web research
producing recorded verdicts; Task 2 is a live-DOM spike in the owner's
browser producing an attach-mechanism verdict. Both write their findings
into the spec's "External facts" section and a new findings file, committed
to the docs branch.

**Tech Stack:** Web research; Firefox/Chrome devtools console on
fansly.com; a local MP3; git.

**Spec:** `docs/superpowers/specs/2026-07-18-voice-notes-design.md`

## Global Constraints

- The extension (and this spike) must NEVER call a Fansly upload or
  message-send endpoint out-of-band — the page itself performs any upload
  (spec: Delivery decision; repo hard rule: Fansly egress).
- Nothing is ever sent to a real fan: the spike works in a conversation
  with an agency-controlled test fan account only, and no message is sent
  at all (attach → observe → remove attachment).
- AI never sends without explicit human action (family law) — the spike
  proves Send stays manual; it does not exercise Send.
- Docs commits go by explicit file path only (the canonical checkout may
  carry unrelated uncommitted work; never `git add -A`).
- A failed gate is a valid outcome: record the verdict and STOP — do not
  improvise workarounds inside this phase.

---

### Task 1: ElevenLabs policy and capability verification

**Files:**
- Modify: `docs/superpowers/specs/2026-07-18-voice-notes-design.md`
  (section "External facts to verify at implementation")
- Create: `docs/superpowers/plans/2026-07-18-voice-notes-phase0-findings.md`

**Interfaces:**
- Consumes: the question list frozen in the spec's "External facts" section.
- Produces: a per-question verdict table (fact, source URL, date checked,
  verdict) in the findings file; the spec section rewritten from
  "unverified" to verified statements; a single go/no-go line:
  `EL gate: GO | NO-GO | GO-WITH-CONSTRAINTS: <list>`.

- [ ] **Step 1: Clone-creation requirements (descoped policy gate)**

Owner decision 2026-07-18: voice-note scripts are non-explicit (greetings
and casual chat), so the adult-content policy gate is DROPPED — no NO-GO
path remains in this task. What survives from the policy block is
operational: what does creating an Instant vs Professional voice clone
require (sample length/quality, verification steps, processing time), and
which plan tiers include each? Answer with official URLs.

Expected: one answer with sources; the "EL gate" verdict line in the
findings file becomes `EL gate: GO` unless Step 2 uncovers a hard
technical blocker.

- [ ] **Step 2: Verify the API/capability questions**

Answer from official ElevenLabs docs, each with URL and date:

1. v3 audio tags: the current documented tag vocabulary (needed for the
   kernel's allowlist) and the model's script length limit per request.
2. TTS response headers: are `request-id`, `x-trace-id`, `character-cost`
   documented? Is there ANY native idempotency primitive?
3. Zero-retention (`enable_logging=false`): which plan tier gates it, and
   what breaks when enabled (history/retrieval)?
4. Instant vs Professional clone quality on v3: current official guidance.
5. API keys: scope restriction to TTS, key-level credit quota, IP
   allowlisting — all three confirmed or refuted.
6. Pricing: characters per plan tier at current prices; compute characters
   per average voice note (~300 chars) to size a plan for pilot volume
   (~50 notes/day → ~450k chars/month; state the tier that covers it).

Expected: six answers with URLs; any question with no official answer is
recorded as "no official source found" (that is itself a finding).

- [ ] **Step 3: Write the findings file**

Create `docs/superpowers/plans/2026-07-18-voice-notes-phase0-findings.md`
with this skeleton filled in (no empty cells — "no official source found"
is a valid cell value):

```markdown
# Voice notes Phase 0 — findings

Date checked: YYYY-MM-DD

## EL gate verdict

EL gate: GO | NO-GO | GO-WITH-CONSTRAINTS: <constraints>

## Policy

| # | Question | Verdict | Controlling quote | Source URL |
|---|----------|---------|-------------------|------------|

## API facts

| # | Fact | Value | Source URL |
|---|------|-------|------------|

## Plan sizing

<tier, chars/month, price, headroom vs pilot volume>
```

- [ ] **Step 4: Update the spec's "External facts" section**

In `2026-07-18-voice-notes-design.md`, rewrite the "External facts to
verify at implementation (unverified, 2026-07-18)" section: replace the
unverified list with one line per fact stating the verified value and a
pointer to the findings file. Keep genuinely-unresolved items explicitly
marked unresolved.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-07-18-voice-notes-phase0-findings.md \
        docs/superpowers/specs/2026-07-18-voice-notes-design.md
git commit -m "docs: voice notes phase 0 — ElevenLabs gate verdicts"
```

---

### Task 2: Fansly composer attach spike

**Files:**
- Modify: `docs/superpowers/plans/2026-07-18-voice-notes-phase0-findings.md`
  (add "Attach seam" section)

**Interfaces:**
- Consumes: a local MP3 file (any real MP3; see Step 1) and a Fansly chat
  open on a conversation with an AGENCY-CONTROLLED test fan account.
- Produces: verdict `attach: native-input | drop | FAILED`, plus the notes
  Phase 2's attach-adapter task needs: working selector(s), which event
  sequence the composer honors, whether the upload request matches a
  manual attach, and any Xray/page-context caveats observed.

- [ ] **Step 1: Prepare a test MP3**

Use any existing MP3, or generate one:

```bash
say -o /tmp/voice-spike.aiff "hi mike good morning" \
  && afconvert -f mp4f -d aac /tmp/voice-spike.aiff /tmp/voice-spike.m4a
```

If only the m4a is available, ALSO test with a real MP3 file — Fansly may
gate on extension/MIME, and MP3 is the format the kernel will produce.
Expected: a small audio file on disk that plays locally.

- [ ] **Step 2: Record the manual baseline**

In the test conversation, with devtools Network open (filter
`apiv3.fansly.com`): attach the file MANUALLY via the composer's own
attach button. Write down: the request sequence (endpoints, order, which
one carries the bytes), the composer preview shown (voice-note style vs
generic file?), whether PPV price controls appear, then REMOVE the
attachment (do not send). Expected: a recorded baseline sequence.

- [ ] **Step 3: Try the native-input handoff**

In the same conversation, paste into the devtools console:

```js
// Pick the local file once by hand, then hand it to Fansly's own input
// programmatically — what's under test is the synthetic handoff, not the
// file's provenance.
const pick = document.createElement('input');
pick.type = 'file';
pick.accept = 'audio/*';
pick.onchange = () => {
  const file = pick.files[0];
  const target = document.querySelector('input[type="file"]');
  if (!target) { console.log('NO FILE INPUT FOUND'); return; }
  const dt = new DataTransfer();
  dt.items.add(file);
  target.files = dt.files;
  target.dispatchEvent(new Event('change', { bubbles: true }));
  console.log('handed off to', target);
};
pick.click();
```

If `querySelector('input[type="file"]')` finds nothing, inspect the attach
button's DOM for the real input (it may mount lazily — click the attach
area once first, or enumerate `document.querySelectorAll('input')`).
Record the working selector. Expected: composer shows the same attachment
preview as Step 2, and Network shows the same upload sequence.

NOTE: the devtools console runs in PAGE context; the extension's attach
adapter will run in the content-script sandbox (Xray boundaries). This
spike proves the page-context leg — record that explicitly in the
findings; if the content-script leg later hits Xray issues, the adapter
injects the page-context handoff (session-capture precedent).

- [ ] **Step 4: Try the drop-event path (only if Step 3 failed)**

```js
const pick = document.createElement('input');
pick.type = 'file';
pick.accept = 'audio/*';
pick.onchange = () => {
  const file = pick.files[0];
  const dt = new DataTransfer();
  dt.items.add(file);
  const zone = document.querySelector('textarea')?.closest('form')
    ?? document.body;
  for (const type of ['dragenter', 'dragover', 'drop']) {
    zone.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, dataTransfer: dt,
    }));
  }
  console.log('dropped on', zone);
};
pick.click();
```

Adjust `zone` to the composer's actual drop target if needed and record
what worked. Expected: same composer preview + upload sequence as Step 2.

- [ ] **Step 5: Verify the proof checklist and clean up**

Confirm and write down each item from the spec's Spike 0 list:

1. the composer accepted the synthetic handoff (which path);
2. the upload sequence matches the manual baseline exactly;
3. the preview and PPV price controls look identical to manual;
4. no request was made by anything other than the page itself;
5. Send was never pressed; the attachment is REMOVED before leaving.

Expected: all five recorded; the test conversation carries no sent
message.

- [ ] **Step 6: Record the attach verdict in the findings file**

Append to `2026-07-18-voice-notes-phase0-findings.md`:

```markdown
## Attach seam

Verdict: attach: native-input | drop | FAILED
Working selector(s): <exact selector>
Event sequence honored: <change | dragenter/dragover/drop>
Upload parity with manual attach: <yes/no + endpoints observed>
Composer preview: <voice-note style | generic file>
PPV controls present: <yes/no>
Caveats for the content-script port (Xray/page-context): <notes>
```

If FAILED on both paths: the verdict line reads `attach: FAILED —
download-only UX`, and the spec's Delivery decision needs a one-line
amendment in the same commit (fallback becomes the primary UX; whether the
feature still ships is the owner's call recorded in the findings).

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/plans/2026-07-18-voice-notes-phase0-findings.md \
        docs/superpowers/specs/2026-07-18-voice-notes-design.md
git commit -m "docs: voice notes phase 0 — Fansly attach seam verdict"
```

---

## After Phase 0

Both gates GO → write the Phase 1 plan (core: tables, contracts, provider
adapter, egress policy, `voice-script` feature, voice-notes endpoints —
its own plan doc in core's conventions, executed in a core worktree), then
the Phase 2 plan (extension: SDK re-vendor, gateway, UI, port protocol,
attach adapter built exactly on this spike's recorded selectors/sequence).
EL gate NO-GO → stop; the spec stays as the record of the design.
Attach FAILED → owner decides download-only vs shelve before Phase 1.
