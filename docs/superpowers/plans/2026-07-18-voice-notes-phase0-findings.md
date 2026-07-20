# Voice notes Phase 0 — findings

Date checked: 2026-07-17 (owner-run research against official ElevenLabs
docs/pricing), recorded 2026-07-18. Sources: numbered list at the bottom;
per-fact source column references it.

## EL gate verdict

EL gate: **GO-WITH-CONSTRAINTS**: kernel-side idempotency is mandatory (EL
has none); the audio-tag allowlist is our own product vocabulary (EL has no
enum); clone type is IVC for v3; v1 runs default logging on a self-serve
tier (zero-retention is select-Enterprise-only). No blocker found. The
adult-policy gate was dropped 2026-07-18 by owner decision (voice scripts
are non-explicit greetings/casual chat).

## API facts

| # | Fact | Value | Source |
|---|------|-------|--------|
| 1 | v3 max text per TTS request | **5,000 chars** (`eleven_v3`). DOC CONFLICT: API pricing page groups v2/v3 at 40,000 — enforce 5,000; read `maximum_text_length_per_request` from `GET /v1/models` at runtime | [1][2] |
| 2 | v3 audio-tag vocabulary | **No closed enum exists** — tags are natural-language instructions; official examples explicitly non-exhaustive; effectiveness varies per voice. Kernel allowlist is OUR product decision. Starting production vocabulary: `[warmly] [cheerfully] [thoughtful] [excited] [whispers] [chuckles] [giggles] [sighs] [short pause] [long pause]`; ≤1–2 tags per short note; SSML `<break>` NOT supported on v3 | [3][4][5] |
| 3 | Response headers | `character-cost`, `request-id`, `x-trace-id` documented; `x-region` in the latency guide. Ledger records all four | [6][7] |
| 4 | Native idempotency | **None documented** (no idempotency key, no client token, no dedup billing guarantee; `seed` is best-effort determinism, not idempotency; `previous_request_ids` is prosody stitching). Kernel job table with unique `(user_id, client_request_id)` is the only dedup layer; every uncontrolled retry is potentially billable | [7] |
| 5 | Zero-retention (`enable_logging=false`) | **Select Enterprise only**; kills history + request stitching + EL-side diagnostics; does NOT cover clone training samples. v1 default: normal logging on self-serve tier — EL retains script text + audio in generation history | [8] |
| 6 | API key controls | All three confirmed: endpoint scope restriction (TTS-only), per-key credit limit (a cap against workspace usage, not a separate balance), IP allowlist (1–100 entries, public IPv4/IPv6/CIDR; others get 403) | [9] |
| 7 | Clone type for v3 | **IVC officially recommended**; PVC "currently not fully optimized" for v3. IVC: ≥1 min samples (1–2 min recommended, >3 min can hurt), instant, rights/consent attestation, Starter+, CANNOT be shared between accounts → lives in the production workspace. PVC: 30 min–3 h samples, live voice verification, ~2–6 h processing, Creator+ (1 slot), can be shared — but only the voice OWNER can create her own PVC | [4][10][11][12][13][14] |
| 8 | Output format | Default `mp3_44100_128` — the v1 choice. 30 s @128 kbps ≈ **480 KB** (informs the audio GET size ceiling; short greetings proportionally less). 192 kbps has conflicting tier docs (Creator vs Pro) — avoid depending on it | [7][16][17] |
| 9 | Latency | No official full-render benchmark for a ~30 s v3 clip; published 250–300 ms figures are latency indicators, not completion times; v3 is explicitly not for real-time. Benchmark p50/p95 on the pilot page before promising an SLA; standard (non-streaming) endpoint fits our store-then-preview flow | [7][18] |
| 10 | Stability preset | v3 presets Creative/Natural/Robust; **Natural** is the safe default for creator voice notes — part of the kernel voice-profile settings | [4] |

## Plan sizing

REVISED 2026-07-18 (owner): real expected volume is ~20–30 ONE-SENTENCE
notes/day (~80 chars incl. tag) ≈ **60k chars/month** — Starter's included
60k v3 pool roughly covers it entirely; realistic cost **$6–12/month**
(Starter $6 + a one-time $5 PAYG buffer for regenerations). Whether EL
bills a per-request character minimum is unverified — the ledger records
`character-cost` from the first pilot call, so actual short-note pricing
is observable on day one. The table below kept for the original
300-char/50-day assumption as the growth scenario:

Original scenario: 50 notes/day × ~300 chars ≈ 450k chars/month. v3 API
rate $0.10 / 1k chars → **~$45/month**, ~$56 with 25% headroom.

| Option | Included v3 chars | Total at 450k | When |
|--------|------------------:|--------------:|------|
| Starter + PAYG | 60k | ~$45 | **v1 choice** (IVC unlocked at Starter) |
| Creator + PAYG | 220k | ~$45 | only if PVC becomes needed |
| Pro | 990k | $99 flat | fixed headroom (~110 notes/day) |
| Enterprise | custom | custom | only if zero-retention becomes mandatory |

PAYG is prepaid top-up (min $5, auto top-up available, service pauses at
zero balance, funds expire in 12 months, no postpaid overage). Budget
**$55–60/month** for the pilot.

## Baseline voice profile for Phase 1

```text
clone:      IVC (recorded 90–120 s: neutral + warm greeting + mild
            excitement + subdued + natural chuckle; same mic/room/style)
model:      eleven_v3
stability:  Natural
output:     mp3_44100_128
per-request: one complete note (no chunking, no stitching)
key:        TTS-scoped, per-key credit limit, VPS IP allowlisted
logging:    default (enable_logging omitted)
```

## Sources

1. https://elevenlabs.io/docs/overview/models
2. https://elevenlabs.io/pricing/api
3. https://elevenlabs.io/docs/overview/capabilities/text-to-dialogue
4. https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices
5. https://help.elevenlabs.io/hc/en-us/articles/24352686926609
6. https://elevenlabs.io/docs/api-reference/introduction
7. https://elevenlabs.io/docs/api-reference/text-to-speech/convert
8. https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode
9. https://elevenlabs.io/docs/overview/administration/workspaces/api-keys
10. https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/instant-voice-cloning
11. https://elevenlabs.io/docs/eleven-creative/voices/voice-cloning/professional-voice-cloning
12. https://elevenlabs.io/docs/eleven-api/guides/how-to/voices/professional-voice-cloning
13. https://help.elevenlabs.io/hc/en-us/articles/17677424903697
14. https://help.elevenlabs.io/hc/en-us/articles/36842751624209
15. https://help.elevenlabs.io/hc/en-us/articles/18448048908305
16. https://elevenlabs.io/docs/overview/capabilities/text-to-speech
17. https://elevenlabs.io/pricing
18. https://elevenlabs.io/docs/eleven-api/guides/how-to/best-practices/latency-optimization
19. https://elevenlabs.io/docs/overview/administration/pay-as-you-go

## Attach seam

Date checked: 2026-07-18 in Firefox, in a live Fansly conversation with an
agency-controlled test fan. The same valid 3 s, 44.1 kHz, 128 kbps MP3 was
used for the manual baseline and the synthetic handoff. No message was sent.

Verdict: **attach: native-input**

Working selector(s): `app-group-message-input input[type="file"]`. It matched
exactly one element during the spike. The input is hidden, has `multiple`, and
accepts `audio/mp3` and `audio/*` among the native image/video/audio types. Its
immediate ancestry was `input` -> `div.collapsable-actions` ->
`div.flex-row.flex-align-center` -> `app-group-message-input`.

Event sequence honored: assign a one-file `DataTransfer.files` to
`target.files`, then dispatch one bubbling `change` event. No `input`, drop, or
drag event was needed. A direct `pick.click()` from the Firefox console was
correctly blocked without user activation; a real click on a temporary
page-context test button populated the source `File`, after which the
`DataTransfer` handoff succeeded. That source picker was spike scaffolding only
-- the product already constructs its `File` from verified audio bytes.

Upload parity with manual attach: **yes**. Both paths opened the same native
`Upload media` modal and, after its native Upload action, produced the same
page-owned sequence (CORS preflights omitted):

1. `POST https://mediav2.fansly.com/api/v1/media/upload/create` -> 200.
2. `PUT https://fansly-upload.s3.eu-central-1.amazonaws.com/<signed-object>`
   -> 200; this request carried the MP3 bytes.
3. `POST https://mediav2.fansly.com/api/v1/media/upload/complete` -> 200.
4. Repeated `GET https://mediav2.fansly.com/api/v1/media/upload/<id>` -> 200
   until verification completed.

The synthetic path produced a different media id, as expected, but the methods,
hosts, order, responses, transferred audio size, verification behavior, and
composer result matched the manual baseline. The Fansly page initiated the
network requests; the spike code only assigned the native input and dispatched
`change`. No ChatGoose or out-of-band Fansly request was made.

Composer preview: **voice-note/audio style** -- waveform tile with Play/Mute
controls and the same native permission badge as the manual attachment. Fansly's
Send arrow appeared separately and remained manual.

PPV controls present: **yes**. The native modal exposed `Require Purchase`
alongside subscription/follow permissions; pricing remains Fansly-native and
was not exercised by this gate.

Caveats for the content-script port (Xray/page-context): the successful
handoff was proved in PAGE context. The Firefox content-script/Xray leg remains
unproven and must be checked in Phase 2; if direct assignment/event dispatch is
blocked there, inject only this small page-context handoff leg, following the
session-capture precedent. A co-installed FBuddy content script logged an
`InvalidStateError`/telemetry warning during the synthetic change, but Fansly's
modal, upload sequence, verification, and preview completed normally.

Cleanup: both manual and synthetic composer attachments were removed after
observation. Send was never pressed, and the test conversation received no
message.
