# Voice and SDK readiness evidence — 2026-09-06

These are observations from this audit, not a permanently maintained production
version declaration. No deployment, flag change, synthesis, or fan message was
performed by this audit.

## SDK provenance and validation

- Public `GET https://gosling-agency.ru/api/v1/health` returned healthy API/DB
  and contract hash `46f7a01e6b6339c302b16cf4c592dd95199ee5ed2337536c11156d4154859fcc`.
- Running `agency-hub-api-1` and its production image both reported label
  `agency-hub.source-revision=7fac98f310d6`.
- The full source commit is `7fac98f310d673134c8dcb5dd6596e126e7f9e69`;
  its committed `packages/sdk/src/meta.ts` has that exact public health hash.
- A separate clean clone at `/tmp/fansly-ext-production-sdk-20260906` was
  checked out at that commit. Its dependency manifests and lockfile match the
  available Hub dependency installation, reused through ignored symlinks.
- The unmodified `scripts/vendor-sdk.mjs` generated a temporary candidate,
  then the complete extension `vendor/kernel-sdk` snapshot. No dirty override
  or hand edits were used. Candidate and installed snapshot compare identical;
  the source clone remains clean. The existing Hub checkout was not modified.
- Extension typecheck passes. Vendor + Voice tests: **209 passed, 9 files**.
  Root must run the full release check after integrating all agents' changes.

## Confirmed Voice fix

Paid create previously checked its live recipient before awaiting the session
repository acknowledgement. Navigation during that FIFO wait could therefore
reach the paid Hub call after the recipient route changed. `voice-service.ts`
now checks account/group/fan/routeNonce again immediately after acknowledgement
and before dispatch. Four regressions failed before the fix and pass after it.
Frozen request identity, same-id replay, and quota ambiguity rules are unchanged.

## LoraVie production observations

- A query using PostgreSQL role `read_only` maps Fansly `LoraVie` to page
  `lora-1`, page id 1, status active. Other allowlisted pages are `lora-2`
  (`LoraViex`) and `lora-3` (`LoraViexx`).
- The supported read-only command
  `docker exec agency-hub-api-1 node apps/runtime/dist/cli.js voice-profile show --page lora-1`
  reports voice `d3EGPAGU5WLkFDq5cI12`, model `eleven_v3`, output
  `mp3_44100_128`, stability `0.5`, profile version 1, updated
  `2026-07-21T16:20:45.744Z`.
- Running API environment: `VOICE_NOTES_ENABLED=false`, allowlist
  `lora-1,lora-2,lora-3`. ElevenLabs API key and all three service-proxy fields
  are configured. Only presence booleans were printed for credentials.
- **Current effective enabled state is not proven by the environment.** This
  flag and allowlist accept live DB overrides. The `read_only` role cannot
  read `config_settings` or the voice-profile table; no privilege bypass was
  attempted. The supported profile CLI was used for the profile instead.
- Root subsequently observed the Voice button appear in the live Lora-1 chat
  after the capability probe resolved. This is current positive UI capability
  evidence; the false boot environment is therefore not a demonstrated launch
  blocker. The exact override values still require the owner config view.

## Remaining release gate and prepared configuration sequence

1. Through an authenticated owner session, read `GET /api/v1/admin/config` and
   inspect the effective Voice switch, allowlist, script maximum, daily page
   budget, and global budget. This resolves the remaining enablement uncertainty.
2. Check in ElevenLabs that the configured voice exists in the intended account
   and is the desired voice. The stored profile alone does not prove this or
   establish audio quality; root owns the UI test.
3. If an enablement change is needed, prepare a separate owner-approved live
   config PATCH, one flag per verification window. Prefer a one-page canary:
   explicitly review the effective allowlist before enabling the master switch.
   The existing three-page boot allowlist must not silently widen a requested
   LoraVie-only canary. No restart is needed for these live fields.
4. After approval, run a short, explicitly paid canary: script, synthesize,
   preview/seek, download, exact-take native attachment. Send stays manual.
   Reconnect/reload recovery may resend the same approved create id; it is not
   a status-only test. An uncertain native attachment must never auto-repeat.

## Root's live canary and failure UX follow-up

Root subsequently performed the authorized short canary. The production API log
records admission at `2026-09-06T16:17:05.763Z` (HTTP 202), voice note 10, and
provider failure at `16:17:08.590Z` after 2612 ms. ElevenLabs returned HTTP 401
with structured `payment_required` / `payment_issue`: its subscription has a
failed or incomplete payment and requires completing the latest invoice.
The terminal outcome was `failed_definite`, so the no-character-charge label
was correct for this attempt. Root independently observed an unpaid invoice
in the ElevenLabs UI. The next canary requires resolving that billing issue;
no payment or automatic synthesis retry was performed by this audit.

The public Hub status currently exposes only state-derived
`voice_failed_definite`, not that provider payment cause. The extension cannot
truthfully diagnose the invoice from its current API payload. Failed takes now
show manager escalation guidance and the exact voice-note number for lookup.
Separately, `failed_after_dispatch` now says characters **may** have been charged;
the previous title incorrectly asserted a charge although Hub returns
`billed:null` for that outcome. Recovery remains explicitly manual.

The two terminal failure UI regressions pass alongside the controller and
service suite: **161 tests, 3 files**; scoped ESLint also passes. These latest
changes require a rebuilt candidate before root can verify their live rendering.

## Key replacement follow-up

The owner subsequently requested a replacement ElevenLabs key. The existing
production key was confirmed to match the masked ChatGoose Voice Production
key in the open ElevenLabs account. A new key, named
`ChatGoose Voice 2.0 — 2026-09-06`, was created with TTS access, Voices read and
User access for subscription diagnostics; other endpoints remain disabled.
Its value was never printed or committed.

Read-only checks used the production service SOCKS5 proxy with no direct
fallback. The new key returned HTTP 200 for both subscription and the exact
configured voice. Subscription details were `tier: creator`, `status: past_due`,
`character_count: 1747`, `character_limit: 131000`; the voice ID matched.
Thus the key and voice are accessible while the account's billing problem
remains. No additional synthesis was attempted, and production still uses its
original key. The owner chose to pay this account; completed payment has not yet
been confirmed.

The replacement must be applied to `/opt/agency-hub/.env.production` and picked
up by recreating only the API service, without building or deploying the dirty
Hub checkout. The active Voice synth path runs in the API process. Wait for a
quiet execution window, preserve the previous env file for rollback, then
verify health and a single normal extension canary after payment. Do not treat
the successful read-only key probes as successful audio generation.
