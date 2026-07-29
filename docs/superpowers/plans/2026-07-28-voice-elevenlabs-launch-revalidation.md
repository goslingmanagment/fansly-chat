# Voice / ElevenLabs launch revalidation

**Date:** 2026-07-28  
**Reviewed revisions:** `chatgoose@ed8289a87f4b7b7b4f692fa99dbde357dcda19f2`,
`core@0bb5cb03af40b66619cd9fb50ffd837af30a7509` (both equal to
`origin/main` when checked)  
**Scope:** extension UI and custody, Core API/provider/billing/queue/retention,
egress, launch configuration, and current official ElevenLabs documentation.

## Краткий итог

Критических P0/security-проблем не подтверждено. Большая часть прежних P1 была
завышена: MIME понижен до P3, vendor retention уже был явно принят продуктовым
решением, account race исправлен, process-local concurrency соответствует
текущей single-API topology.

Остался один честный P1 в смысле release blocker, а не security critical:
нажатие tone preset после готового take детерминированно удаляет из extension
локальную custody-ссылку на уже оплаченный артефакт. Серверные bytes живут до
семи дней, но `voiceNoteId` теряется и пользователь не может их вернуть через
UI. Минимальный фикс — блокировать tone после появления любого take и повторить
guard в controller.

Для закрытого одностраничного пилота после этого фикса достаточно добавить
бесплатный retry загрузки MP3, выполнить один paid canary точного production
profile и подтвердить принятую политику ElevenLabs History. До широкого запуска
нужно отдельно закрыть graceful drain, queued heartbeat, retention isolation и
route limits.

## Executive verdict

There is no confirmed P0/critical security issue and no evidence that the
current `Content-Type: audio/mpeg` check is a P1 production failure. Several
items from the previous review were overstated or have since been fixed.

The current build is **not ready for a broad launch unchanged**, because one
ordinary extension action can deterministically remove client custody of an
already-paid take. The smallest safe release gate is:

1. block tone regeneration once any take exists (UI and controller guard);
2. add a free manual MP3-download retry;
3. run one paid canary with the exact production key, voice, model, settings,
   and `mp3_44100_128`;
4. confirm the already-approved vendor-retention assumption still matches the
   actual privacy copy, DPA, and customer promise.

After those steps, a one-page fail-closed allowlist pilot is reasonable. Queue
leases, graceful shutdown, route limits, and retention isolation should be
closed before broad rollout or materially higher concurrency.

## Severity calibration

- **P1 / release blocker:** deterministic loss of custody for paid work through
  a normal, one-click flow; no recovery/library UI exists.
- **P2 / medium:** a realistic but conditional correctness, availability, or
  paid-artifact risk. Some P2 items are not blockers for the current one-page,
  single-API pilot, but become blockers before scale.
- **P3 / low:** hardening, contract uncertainty, or operational clarity with
  meaningful compensating controls.
- **Conditional policy gate:** a blocker only when a contractual, legal, or
  public product promise makes the condition mandatory.

## Validated findings

### F1 — P1: choosing another tone removes paid-take custody

The tone buttons remain enabled after a take exists in
`/Users/dmitriy/code/chatgoose/src/content/voice/voice-panel.ts:586`. Their click
calls `regenerateScript()`, which revokes blob URLs, clears the source binding,
sets `takes = []`, and persists the destructive snapshot **before** the free
script SSE succeeds in
`/Users/dmitriy/code/chatgoose/src/content/voice/attempt-controller.ts:331`.

If the free script request then fails, times out, or loses its port, the paid
artifact remains in Core for seven days but the extension has discarded its
`voiceNoteId`; there is no server library/list endpoint to recover it. The
current test at
`/Users/dmitriy/code/chatgoose/tests/voice-attempt-controller.test.ts:1327`
incorrectly pins that destruction as desired behavior. This also conflicts with
the design rule at
`/Users/dmitriy/code/chatgoose/docs/superpowers/specs/2026-07-18-voice-notes-design.md:238`,
where script changes make takes stale rather than erase them.

**Why P1 is not inflated:** the path is deterministic, requires no malicious
input or rare race, and can make a user pay again. P1 here means release
blocker, not critical security severity.

**Safe launch fix:** disable tone chips whenever `attempt.takes.length > 0`, add
the same defensive guard inside `regenerateScript()`, and direct the user to the
existing explicit new-voice/confirmation flow. Do not merely preserve `takes`
inside the current schema: source/script binding is attempt-level, not per-take,
so a failed regeneration could leave old audio attached to a new source.

### F2 — P2: detached synthesis is not drained on API shutdown

Core starts the provider task detached in
`/Users/dmitriy/code/core/apps/runtime/src/services/voice-notes.ts:460` and
`/Users/dmitriy/code/core/apps/runtime/src/services/voice-notes.ts:506`.
SIGTERM closes the HTTP server and app context, then exits, without awaiting
these tasks in `/Users/dmitriy/code/core/apps/runtime/src/api-runtime.ts:36`.

A deploy/restart during the up-to-60-second provider request can therefore lose
an already-billed response. The lease sweep safely prevents duplicate automatic
dispatch, but the row becomes `indeterminate` and the audio is unavailable.

**Fix:** keep a registry of in-flight voice promises; stop new admission during
shutdown and drain them for a bounded 65–75 seconds before closing the DB and
egress context.

### F3 — P2: completed audio has no manual free retry

An audio GET failure clears the in-flight marker and leaves the take completed
in `/Users/dmitriy/code/chatgoose/src/content/voice/attempt-controller.ts:981`.
The recovery UI in
`/Users/dmitriy/code/chatgoose/src/content/voice/voice-panel.ts:1388` does not
handle `completed` without a blob. Reconnect/reload can refetch it, so this is
not P1 and does not require another synthesis.

**Fix:** render `Повторить загрузку MP3 — бесплатно` for a completed take with no
blob and an audio error. Reuse the existing `checkStatus(voiceNoteId)` path; a
successful status response already re-enters `fetchAudio()`.

### F4 — P2: hidden parallel attempt can be deleted without confirmation

Boot deliberately supports multiple matching records, but the new-voice warning
only inspects `getAttempt()` in
`/Users/dmitriy/code/chatgoose/src/content/voice/voice-panel.ts:868`.
`startScript()` then removes every recovered record via
`/Users/dmitriy/code/chatgoose/src/content/voice/attempt-controller.ts:285` and
`/Users/dmitriy/code/chatgoose/src/content/voice/attempt-controller.ts:1247`.

The precondition (parallel content lifecycles/tabs followed by recovery) makes
this medium rather than P1, but a hidden completed or indeterminate paid take can
leave custody without any warning.

**Fix:** preferably displace only the active record, matching
`completeAttempt()` semantics. If product semantics require purge-all, aggregate
`getAttempts()` for the warning and explicitly state that all paid-at-stake
sessions will close.

### F5 — P2 at scale, P3 for the one-page pilot: live queued rows can be swept

A row waiting for the process-local permit is not heartbeated in
`/Users/dmitriy/code/core/apps/runtime/src/services/voice-notes.ts:547`.
The minutely sweep treats any queued row older than five minutes as abandoned in
`/Users/dmitriy/code/core/apps/runtime/src/services/voice-notes-sweep.ts:34` and
uses `created_at` in
`/Users/dmitriy/code/core/packages/db/src/repositories/voice-notes.ts:341`.

At concurrency two, a sustained tail of roughly 13 maximum-duration requests can
cross the cutoff. The important correction to the previous report is that these
rows have **not** reached ElevenLabs: the CAS loses, no provider call happens,
and the reservation is refunded. The impact is false abandonment/availability,
not billed-audio loss.

**Fix:** add a queued lease/heartbeat (for example `queue_lease_until` or
`updated_at`) while the waiter is alive and sweep only expired queued leases.
A larger fixed timeout alone is not a rigorous fix.

### F6 — P2 launch-readiness: profile compatibility is not verified end to end

The current service-egress verifier now checks proxy exit identity and
`GET /v1/user/subscription`, which closes much of the previous finding. However,
`/Users/dmitriy/code/core/apps/runtime/src/services/voice-profiles.ts:105`
accepts an arbitrary voice/model pair without checking voice access, model TTS
capability, output tier, or the exact production combination.

This is a launch checklist gate rather than proof of a code failure. It becomes
high only if the selected production voice is unavailable/incompatible. Eleven
v3 itself is current and left alpha on 2026-02-02; `eleven_v3` plus the current
`mp3_44100_128` default is reasonable. The remaining conditional caveat is the
selected voice: current ElevenLabs guidance says PVCs are not fully optimized
for v3, while owned IVC/designed voices are the safer launch choice.

**Fix:** add a profile-scoped `voice-profile verify --page <label>` that uses the
same service dispatcher/key for `GET /v1/models`, exact
`GET /v1/voices/{voiceId}`, voice-type/lifecycle metadata, and
subscription/quota assertions. Keep the paid request behind a separate explicit
`--paid-canary` action. Prefer `mp3_44100_128`; gate 192 kbps on a successful
plan check/canary because current ElevenLabs pages disagree on its minimum tier.

### F7 — P2 operational: local audio retention is coupled to unrelated cleanup

The daily handler runs raw payload, pending token, and sync-observability cleanup
before voice retention in
`/Users/dmitriy/code/core/apps/runtime/src/worker-services.ts:210`. A persistent
earlier failure prevents the seven-day voice purge and there is no dedicated
voice-retention lag/watermark alert.

**Fix:** give voice retention its own queue/schedule/worker with retries and a
last-success/oldest-audio metric. A smaller interim fix is isolated `try/catch`
execution plus an alert, but a dedicated queue is easier to reason about.

## P3 / hardening backlog

1. **Strict MIME is not a confirmed failure.** Core requires exact
   `audio/mpeg` in
   `/Users/dmitriy/code/core/apps/runtime/src/services/voice-elevenlabs-provider.ts:135`.
   Current Create Speech docs promise an audio file but no exact response MIME;
   official MP3 examples use `audio/mpeg`. Keep the paid canary. Optional
   hardening can allow `audio/mpeg`, `audio/mp3`, and
   `application/octet-stream` only for pinned MP3 output while retaining the
   existing structural MP3 validation. This is **P3, not P1**, until a real
   production response disproves compatibility.
2. **Voice route rate limits.** The global Fastify limiter is disabled and the
   three voice routes do not opt in. API-key auth, page authorization,
   fail-closed allowlist, script cap, and daily character budgets materially
   reduce risk. Add per-principal/page create limits plus status/audio limits and
   a maximum queue depth before broad rollout.
3. **All 4xx are treated as definitely unbilled.** ElevenLabs documents 4xx
   classes but no universal billing guarantee. Parse bounded
   `detail.code ?? detail.status`; refund only an allowlist of known
   pre-generation errors, and treat unknown future 4xx as billing-unknown. Never
   automatically replay the POST.
4. **`character-cost` bounds.** Current code accepts every finite number and
   clamps negative values later. Fractional values are plausible because model
   and voice multipliers exist; requiring an integer would itself be unsafe.
   Accept finite, non-negative values within a sane maximum; otherwise preserve
   the estimate as billing-unknown.
5. **Extension response hygiene.** Bound non-2xx audio error bodies and cancel
   response streams on every early return in
   `/Users/dmitriy/code/chatgoose/src/background/voice-service.ts:1014`.
6. **Status correlation.** Before emitting a status view, require
   `view.voiceNoteId === requested voiceNoteId` in
   `/Users/dmitriy/code/chatgoose/src/background/voice-service.ts:939`.
7. **Background map lifetime.** Add a TTL/size bound or explicit release message
   for `scriptAttemptIds`, `attemptsByTakeKey`, and related sets in
   `/Users/dmitriy/code/chatgoose/src/background/voice-service.ts:407`.
8. **Capability readiness.** The catalog hint checks voice/provider/profile but
   not AI-gateway readiness. Include it or return an explicit reason; this is a
   configuration UX issue, not paid loss.
9. **Production examples/docs.** Add `ELEVENLABS_API_KEY` and all
   `VOICE_NOTES_*` keys to `.env.production.example`; the config registry should
   say the API process, not the worker, must be recreated after key changes.
   Core `README.md:59` also points to the absent
   `docs/runbooks/service-egress-proxy.md`; restore that runbook or correct the
   link before operator handoff.

## Policy and conditional gates (not unconditional code findings)

- The provider request omits `enable_logging`, so ElevenLabs' documented default
  is history retention. This is explicitly accepted by the current product
  design at
  `/Users/dmitriy/code/chatgoose/docs/superpowers/specs/2026-07-18-voice-notes-design.md:349`.
  It is therefore not an undisclosed P1 code bug. It becomes a launch blocker if
  product copy, the DPA, consent, or regulation promises global seven-day
  deletion or no vendor retention. ZRM requires eligible Enterprise access and
  `enable_logging=false`; deletion outside ZRM may remain in backups for up to
  30 days.
- The hard-coded global ElevenLabs endpoint is P3 configurability under the
  approved self-serve setup. It becomes a compliance blocker only if regional
  residency is required; ElevenLabs documents separate Enterprise workspaces,
  keys, and API base URLs for those environments.
- A community voice can disappear, and legacy Default voices are documented to
  expire on 2026-12-31. Verify the exact production voice category/ownership and
  record a fallback. An owned IVC/designed voice is materially lower risk.
- The budget currently reserves input characters, then reconciles the provider's
  reported cost. If the model/voice multiplier makes actual cost larger, the
  stored counter can pass the configured threshold after spend. Treat the
  setting as an admission/input-character budget, or reserve a verified
  worst-case multiplier if it is promised as a hard credit ceiling.

## Closed or materially downgraded previous findings

- The legacy-to-canonical account race is fixed by `a09da68`; current tab-state
  refresh is newest-wins and canonical-preferred.
- E54 background-owned `storage.session` custody, paid-create snapshot fencing,
  exact-take attach, player duration, and E57/E58 error mapping passed review.
- Dedicated service SOCKS5 egress and a subscription preflight now exist after
  Core decision #180; the prior claim of no preflight is obsolete.
- Provider failures now preserve bounded `failureKind`/detail and successful
  rows retain request ID, trace ID, and region; the prior diagnostics finding is
  mostly closed.
- Process-local concurrency is explicitly acceptable for the documented single
  API topology. It becomes a finding only when the deployment scales to multiple
  API replicas without a shared permit.
- Vendor history retention is an owner-approved design assumption, not an
  accidental implementation omission. Re-open it only if the policy promise has
  changed.

## Potential fix set

### Patch A — required before the next release (extension, no schema migration)

```ts
// voice-panel.ts / renderTones
const hasExistingTakes = attempt.takes.length > 0;
chip.disabled = attempt.phase === 'generating' || pendingCreate || hasExistingTakes;

// attempt-controller.ts / regenerateScript
if (record.pendingCreate || record.attempt.takes.length > 0) {
  return;
}
```

Also replace the destructive controller test with a custody-preservation test,
add a panel test that all tone chips are disabled after any take, and add the
free completed-audio retry button/test. This is deliberately narrower than a
full stale-take redesign.

### Patch B — recommended before broad rollout (Core correctness/operations)

1. durable queued heartbeat/lease and a queue/sweep race test;
2. bounded shutdown drain for detached syntheses and a SIGTERM regression test;
3. independent voice-retention worker plus lag metric;
4. per-principal/page route limits and queue-depth admission;
5. exact voice/model/tier preflight and paid canary command.

### Patch C — low-risk hardening fixpack

1. MIME allowlist behind structural MP3 validation;
2. bounded modern ElevenLabs error parser and conservative unknown-4xx billing;
3. non-negative, sane-range `character-cost` parser;
4. extension response cancellation/body cap/status-ID correlation/map TTL;
5. production environment examples and API-restart wording.

## Required launch canary

Using the production service account/key and the same service proxy as runtime:

1. run the existing service-egress verification and record only masked route and
   exit IP;
2. read subscription, exact voice metadata, and model list;
3. verify `can_do_text_to_speech`, voice access/ownership/category, tier, quota,
   and the 128-kbps output format;
4. perform exactly one paid generation with the production profile;
5. record status, normalized MIME, audio size + MP3 structural check,
   `request-id`, `x-trace-id`, `x-region`, concurrency headers, and
   `character-cost` without logging script, voice ID, key, or audio bytes;
6. fetch it through Core and the extension, retry the free audio retrieval, and
   verify the local seven-day purge/monitoring path;
7. if ZRM is contractually required, pass `enable_logging=false` only after
   entitlement is confirmed and verify the generation is absent from History.

## Verification evidence

- Extension: 378 targeted voice/operations/runtime/protocol/error tests passed;
  typecheck, targeted ESLint, and architecture gates passed.
- Core: 87 targeted provider, egress, sweep, repository, service, and API tests
  passed. An independent rerun of 33 unit and 43 integration tests also passed.
- Current-head GitHub CI was green for both reviewed revisions.
- No live production ElevenLabs call and no production secret/config inspection
  were performed, so the paid canary remains an explicit evidence gap.

## Official ElevenLabs references checked on 2026-07-28

- Create Speech: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
- Models: https://elevenlabs.io/docs/api-reference/models/list
- Exact voice: https://elevenlabs.io/docs/api-reference/voices/get
- Subscription: https://elevenlabs.io/docs/api-reference/user/subscription/get
- Errors: https://elevenlabs.io/docs/eleven-api/resources/errors
- Zero Retention Mode: https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode
- Data residency: https://elevenlabs.io/docs/overview/administration/data-residency
- Eleven v3/PVC guidance:
  https://elevenlabs.io/docs/overview/capabilities/text-to-speech/best-practices
- Eleven v3 GA changelog:
  https://elevenlabs.io/docs/changelog/2026/2/2
- Default voice lifecycle:
  https://elevenlabs.io/docs/help-center/product/voice-customization/my-voices/how-do-i-access-eleven-labs-default-voices
