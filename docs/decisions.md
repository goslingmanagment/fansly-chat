# Decision log — ChatGoose (Fansly extension)

Append-only. Numbered entries, newest last. Cross-repo decisions live in
core's `docs/decisions.md` and are REFERENCED here, never copied.

## Family law (recorded per kernel Stage 35; binding in this repo)

- **Anti-deletion rule:** removing or superseding any hand-curated document
  requires a tombstone entry in this log; deprecated specs get a banner,
  never deletion. Generated docs (`docs/generated/`) are exempt.
- **Updated-in-change:** hand-curated docs are updated in the same change
  that invalidates them.
- **Cross-repo decisions** are recorded in core's log; this log points at
  them by number.

## Quick reference

| # | Date | Decision |
|---|---|---|
| E1 | 2026-07-06 | Stage 32 Task 1: npm/commonjs → pnpm/ESM, ESLint, CI lint |
| E2 | 2026-07-06 | Stage 32 Task 2: @kernel/sdk vendored; device-token sign-in; storage v8 |
| E3 | 2026-07-06 | Stage 32 Task 3: kernel-only AI; vendor host permissions removed; Settings v9 |
| E4 | 2026-07-06 | Compare/Multi rides fast-reply per card (kernel compare deferred — core #112 era deviation) |
| E5 | 2026-07-06 | clientContext on the feature lane (Fansly archive is pull-cadenced; extension reads live) |
| E6 | 2026-07-06 | Board = one kernel top-spenders query; legacy rebuild behind spendersLegacyRebuild for ONE release |
| E7 | 2026-07-06 | Released 1.6.0 (kernel AI + kernel board + acceptance telemetry) |
| E8 | 2026-07-07 | Map regen found + fixed unreachable device-token sign-in (missing protocol case); ships next release |
| E9 | 2026-07-07 | 1.7.0: device-token preferred in all hub ops; legacy board rebuild deleted (v11); chatter-key path deferred one release |
| E10 | 2026-07-07 | Pre-ship audit: Bearer-"set" poisoning, key-gated token flow, null-unsafe bearer — all fixed + pinned |
| E11 | 2026-07-07 | 1.7.0 RELEASED (feed asserts ran in anger); watch device-token adoption + kernel-only board |
| E12 | 2026-07-07 | Hub connection failures made self-diagnosing: HTTP status + server body reach the options UI, rejection copy names the actual bearer, hub failures always logged (redacted) |
| E13 | 2026-07-10 | Family restyle: injected UI = desktop dark-twin tokens, popup/options = family light; terracotta accent, green = money-only, serif AI text, mono numbers |
| E14 | 2026-07-10 | uiTheme setting (system/light/dark, storage v12) supersedes E13's fixed split; click-to-insert draft cards + streaming caret; popup AI-quota indicator off the meta frame |
| E15 | 2026-07-10 | 1.8.0 RELEASED (E13/E14 scope); releases now go from main — bar-tone-menu retired, CLAUDE.md updated; watch theme adoption + quota row + v12 migration |

## Entries

**E1 (2026-07-06).** Toolchain to the family standard: `"type": "module"`,
pnpm pinned, ESLint flat config (content scripts may not import
background-only modules), CI runs `pnpm check`. 74 initial lint errors
driven to zero.

**E2 (2026-07-06).** `@kernel/sdk` vendored (`vendor/kernel-sdk`, generated
by core `scripts/vendor-sdk.mjs`; `link:` dependency so bundler resolution
applies; drift gate pins manifest hash == exported hash). The four legacy
hub routes ride validated SDK ops. Device-token sign-in uses the browser
cookie jar (`credentials: 'include'` — Set-Cookie is unreadable in
extensions); the legacy chatter key stays as dual-accepted fallback.
Storage schema v7→v8 (`agencyHubDeviceToken`).

**E3 (2026-07-06).** Stage 32 AI cutover: kernel feature lane only. Deleted
both vendor clients, price tables, model registry, the local prompt library
(kernel twins byte-verified through the named platform substitution),
prompt-injection, feature-readiness, the usage self-reporter. Settings v9
drops vendor keys + model/reasoning selections. `api.anthropic.com` and
`openrouter.ai` left `manifest.json` host permissions — direct calls are
structurally impossible. Gates: `scripts/check-ai-cutover.mjs` in
`pnpm check`. Core context: decisions #108–#111.

**E4 (2026-07-06).** A single-call kernel `compare` feature is DEFERRED:
kernel-held draft variants don't exist (prompts/drafts/ was absent from
shipped builds), so Multi runs the mapped persona card as one fast-reply
generation; local draft cards error explicitly (`compare_cards_unavailable`).

**E5 (2026-07-06).** The feature request carries `clientContext` (transcript,
counts, spending/subscription blocks): Fansly has no webhook lane and the
kernel archive is pull-cadenced (30 min / 24 h), while the extension reads
the conversation live at generation time. Prompt ASSEMBLY stays kernel-side.

**E6 (2026-07-06).** The spenders board reads ONE kernel query
(`pageTopSpenders` over the Stage 16 projection) instead of the ~150-call
per-fan Fansly sweep; one conversations enumeration remains as the
fan→groupId map (DP 1-B reader role). `builtAt` = the projection's freshest
observation. The legacy rebuild survives ONE release behind the hidden
`spendersLegacyRebuild` setting, then dies (with the legacy chatter-key
path).

**E7 (2026-07-06).** 1.6.0 signed and published
(`https://ext.gosling-agency.ru/updates.json`, sha256-pinned). §5
week-watch: fleet on the version header, kernel-only network panel +
measured quota drop, chatter walkthrough, acceptance observations under
producer `chatgoose-extension@1.6.0`.

**E8 (2026-07-07).** The Stage 35 map regeneration found that
`issueAgencyHubDeviceToken` was UNREACHABLE in shipped 1.6.0:
`getRuntimeRequestType` (src/shared/protocol.ts) had no case for it, so the
options-page sign-in message died before the handler
(src/background/runtime-api.ts) ever ran — device-token sign-in from the
options page silently failed while the legacy chatter-key path kept
everything working (which is why the walkthrough missed it). Fixed by adding
the protocol case, pinned by a test in tests/protocol.test.ts; full check
green. Ships with the NEXT release (alongside the E6 fallback deletions) —
no emergency release, the chatter-key path covers the interim. Add "issue a
device token from the options page" to that release's §5 checks.

**Correction to E3 (2026-07-07, found by the Stage 35 orientation drill):**
E3's line "vendor hosts left in manifest.json host permissions" described a
draft state — the SHIPPED 1.6.0 manifest carries NO vendor AI hosts
(`host_permissions` = fansly.com + apiv3.fansly.com only; the hub rides
`optional_host_permissions`). The current-state authority is CLAUDE.md's
header. E3's text stays as written (append-only log).

**E9 (2026-07-07).** 1.7.0 scope settled: (a) the E8 fix ships (device-token
sign-in reachable); (b) the four legacy-key-only hub ops (testConnection,
pushFanProfile, fetchFanProfileByConversation, submitAiUsageBatch) now
prefer the device token via resolveHubBearer — prerequisite for key-path
deletion; (c) the spendersLegacyRebuild fallback and the legacy per-fan
board rebuild are DELETED (storage v11 drops the setting); (d) the legacy
chatter-key path itself is DEFERRED one more release, against E6's plan —
device_tokens on the kernel is EMPTY (sign-in was broken in 1.6.0, E8), so
deleting the key path now would strand the whole fleet. Delete it only
after the fleet demonstrably holds device tokens.

**E10 (2026-07-07).** Pre-ship GPT-5.5(xhigh) audit of the 1.7.0 diff found
three real defects, all fixed before signing: (1) the options page stored the
placeholder string "set" as the device token after sign-in, which
resolveHubBearer would then SEND as `Bearer set` in the connection test — the
options page now re-reads the real stored settings after sign-in; (2) the
connection test + permission UI were still key-gated, locking out
token-only installs — either credential now unlocks them (helpers take the
token, signature includes it so issuing a token triggers an auto-retest);
(3) resolveHubBearer threw on legacy message shapes without the token field —
now null-safe. Pinned in tests/agency-hub-audit-fixes.test.ts. NOTED, not
changed: the device token lives in storage.local alongside the legacy key
(the E2 custody class; page context cannot read extension storage) — moving
hub credentials out of content-script-readable storage is future hardening,
tracked for the chatter-key-deletion release.

**E11 (2026-07-07 ~22:50 UTC).** 1.7.0 RELEASED — signed and live on
https://ext.gosling-agency.ru (sha256:580234b3…). The deploy script's new
version asserts ran in anger for the first time (package==manifest before
signing; served==1.7.0 after upload). Watch items: device-token sign-in now
actually works from the options page — expect device_tokens rows on the
kernel as chatters re-auth; the board must serve from the kernel only
(legacy sweep is gone).

**E12 (2026-07-07).** A field report (CG-HUB-03 on a live install, undebuggable
from the screen) exposed that hub diagnostics were collected and then thrown
away: `toHubError` captured the HTTP status and response snippet in
`ChatGooseError.details`, but `toUserError` dropped them, and the options page
showed a bare error code under a contradictory "Sync ready" banner. Decisions:
(a) `UserFacingError` carries optional `httpStatus`/`serverDetail`; the
connection-test failure line now renders "Hub responded NNN: <body>" — the
snippet prefers `KernelApiError.body` (the server's actual response) over the
SDK's synthetic message; (b) CG-HUB-03 copy names the credential that was
actually sent (resolveHubBearer prefers the device token, so "check the API
key" was a lie whenever a stale token was stored) and points key users at
device-token sign-in; (c) the permission block never claims sync readiness —
that's the live test's job ("Host access granted" replaced "Sync ready");
(d) every hub op failure logs to the background console via a new redaction-
aware `logWarn` (NOT debug-gated: failures must leave a trace on default
chatter setups), tagged with the operation name. Server-side distinguishable
401 reasons (revoked vs unknown vs non-chatter role — `roleCanUseApiKey` is
chatter-only, so an owner's key reads as "invalid") stay a core-repo follow-up.

**E13 (2026-07-10).** Visual restyle to the family design language (style
only, no behavior): the extension drops its Fansly-native navy/periwinkle
theme for the desktop app's palette (which core's dashboard shares).
Split by surface: the INJECTED UI (toolbar, overlay, inline panel, board,
toasts, cheatsheet) uses the desktop's dark-twin tokens (`#1b1a17`/`#262420`
warm charcoal ladder) because it lives inside Fansly's dark page — a cream
panel there would glare on night shifts; popup + options use the family
light theme (cream `#efece4` / ivory `#faf9f5`), matching core's dashboard
and the public pages. Family invariants adopted: terracotta `#d97757` is
the ONLY accent (constant across themes); green is reserved for money
(board amounts/tips — mono, tabular); amber = pending/attention; AI-authored
text renders serif inside dashed-terracotta draft cards ("the machine speaks
in serif"); numbers/timestamps/keycaps are mono; micro-caps labels
(10px/0.12em) replace ad-hoc eyebrows; radius scale 9/7/11; two soft
shadows, backdrop blur removed (family anti-goal); `prefers-reduced-motion`
respected; `color-scheme` no longer set on the host page's `:root` (scoped
to chatgoose roots). Token layer: full `--chatgoose-*` custom-property set
per entry CSS (content dark twin; options/popup light) — popup/options
inline styles in TS now reference tokens only (no color literals left in
TS). Fonts: Hanken Grotesk / Source Serif 4 / IBM Plex Mono via Google
Fonts on extension pages, font-stack fallbacks (Georgia, ui-monospace) in
the injected UI — no fonts are shipped into Fansly. The dead Outfit font
link was replaced. Static pages (install/guide/changelog) were already in
the warm family and are untouched.

**E14 (2026-07-10).** Three owner-approved follow-ups to E13, one change-set:
(a) **Both themes everywhere** — E13's fixed per-surface split (injected
dark, pages light) is superseded by a `uiTheme` setting (`system | light |
dark`, default `system`; storage v11→v12) applied to ALL surfaces. Light is
the base token set in each entry CSS; dark is a pure variable swap under
`.chatgoose-theme-dark` on `<html>` (the desktop's theming discipline —
components read tokens only, no per-component dark styling). Terracotta and
`green-fill` stay constant across themes; a `--chatgoose-clay-ink` token
carries text-on-clay-tint (deep in light, bright in dark). Resolution lives
in `src/shared/theme.ts` (mirrors desktop `resolveUiTheme`), kept live via
`storage.onChanged` + `matchMedia`; selector in Options → Appearance.
Content color-scheme is scoped to chatgoose roots, never the host `:root`.
(b) **Click-to-insert + streaming caret** (desktop UX parity): clicking a
draft card's text inserts it (guarded — an active text selection never
fires an insert; the Insert button stays for keyboard flow), and the
loading stream carries a blinking terracotta caret (`chatgoose-stream-live`,
loading views only, so raw-text fallbacks never blink). Insert ≠ send —
the no-send-without-human-action law is untouched.
(c) **Popup AI-quota indicator**: the kernel's meta frame ships a quota
snapshot (`remainingRequestsToday`/`remainingMicroUsdToday`) that the
gateway previously dropped; a new background quota-tracker records it per
page (storage.session, memory fallback) plus 429 `quota_denied` denials,
and `getPopupStatus` serves the freshest same-UTC-day snapshot (day-scoped:
never served across the kernel's 00:00 UTC reset; the popup shows requests
only — remaining micro-USD is deliberately NOT rendered to keep money
formatting kernel-side per the no-local-money-math rule). Popup states:
quiet count → amber ≤20 → red "used up, resets 00:00 UTC". Rejected:
Reply-as-split-button with tone dropdown (owner: less convenient than the
tone pill row). Pinned: storage-migration (v12 uiTheme), overlay
click-to-insert, quota-tracker day-scoping tests.

**E15 (2026-07-10).** 1.8.0 RELEASED — signed and live on
https://ext.gosling-agency.ru (sha256:84395f6fdd…), served-feed assert green
(updates.json == manifest == package.json == 1.8.0). Scope = E13 + E14: the
family restyle, switchable light/dark on all surfaces (storage v12), draft
click-to-insert + streaming caret, popup AI-quota indicator. Release-process
correction recorded in CLAUDE.md in this change: the `bar-tone-menu` release
branch no longer exists — 1.7.x and 1.8.0 shipped straight from `main`, so
the documented flow now says main + version bump + CHANGELOG/changelog.html +
deploy.sh. §5 watch items for the week: (a) the v12 migration lands silently
on the fleet (no settings resets); (b) the quota row populates after the
first generation of the day and goes red exactly on CG-HUB-09 denials;
(c) chatter feedback on the dark/light default ('system') inside Fansly's
dark UI; (d) click-to-insert does not produce accidental inserts (the
selection guard holds on real chatter copy-flows).

**E16 (2026-07-11).** Release hygiene remainder (core plan W9.1/A19): deploy.sh
now refuses to sign unless branch == main, `git status --porcelain` is empty,
HEAD is an ancestor of origin/main, no `v<version>` tag exists yet, and the
served feed's version is strictly older (semver) than the release — all
asserted BEFORE `web-ext sign`, because signing is the irreversible step. A
green deploy ends with `git tag -a v<version>` (annotated with the served base
URL + xpi sha256 — the tag records what was actually signed and served) and a
tag push. Retro-tags for the untagged history (v1.7.0=5bd719c, v1.7.1=021f7e9,
v1.8.0=363ef32, provenance evidence in each tag message) are owner-run — this
change only ships the commands; authoritative in-script tagging starts at
1.8.1. The dead `bar-tone-menu` branch entry left ci.yml (the branch was
retired in E15's release-process correction).

**E17 (2026-07-11).** Custom personas sync to the kernel (core plan W9.2/A7).
Since Stage 32 every generation has sent `personaKey: personality.id`, but
"Add personality" minted raw UUIDs the kernel's `ai_personas` never learned —
generations on custom-persona accounts died with an opaque 400 (the 1.6.0
changelog's "personas sync with server" was false in code). Zero kernel work:
the Stage 31 routes (aiPersonasList/Upsert/Archive) and the vendored SDK
already suffice — no contracts change, no re-vendor. Design:
`src/background/persona-sync.ts` diffs `personalities` storage changes
(options saves upsert changed customs with key = the LOCAL id, body
{displayName ≤120, systemBlock ≤50k — kernel schema mirrored client-side};
deletes archive), plus ONE boot reconcile that lists kernel personas and
upserts local customs that are missing or differ (local text wins for
extension-owned keys; kernel-only keys — e.g. desktop personas — are never
archived or touched). Sync is best-effort: hub failures warn and wait for the
next change/boot; a save never fails on hub unreachability. Builtin
`builtin:lora`: options card locked READ-ONLY (owner default per plan —
upserting it would mutate the persona the desktop picker shares; the local
edit was silently ignored at assembly anyway, which was the drift). Archive
404 = already absent = success. Blast radius accepted: extension personas
appear in the desktop picker, hence the displayName hygiene above. Pinned in
tests/persona-sync.test.ts (17 cases: exact key/body, archive-on-delete,
builtin never syncs, reconcile skips in-sync + kernel-only, queue ordering).

**E18 (2026-07-11).** Top-spenders board honest empty state (core plan
W9.3/A20, MINIMAL variant). The kernel's "page not ramped" signal
(`pageTopSpenders.builtAt: null`) already reached the extension and was
destroyed at spenders-service.ts: null was rewritten to `Date.now()`, so a
never-walked page showed "No paying fans found… updated just now" — false on
both counts — and cached it for 10 minutes. Now: `SpendersListResult.builtAt`
is `number | null`, null passes through verbatim, the board renders a
distinct "Spender rankings aren't enabled for this page yet" state (header
meta says "Rankings not enabled…", never "updated …"), and a null-builtAt
result is never cached (neither the background's 10-min cache nor the
board's in-memory across open/close) so the board flips the moment the
kernel ramps the page. NOT taken: the richer 3-state copy consuming W8.1's
`source.streamState` — W8 has not shipped, so this wave does no SDK
re-vendor anywhere (plan's cross-review contract-law note therefore moot).
No legacy-fallback resurrection (deleted in 1.7.0/storage v11 — would
restore the ~150-calls-per-10-min pattern the migration killed). Pinned in
the spenders-service and spenders-board-controller suites.

**E19 (2026-07-11).** Storage v13 — per-key credential custody (core plan
W9.4 / A41/I116-4, the E10 "future hardening" note's first half). The v12
layout kept `agencyHubDeviceToken` (and the legacy key) inside the `settings`
blob while every `saveSettings` was a whole-blob read-modify-write — an
options-page debounced save racing a token issuance could persist the stale
token over the fresh one. v13 moves BOTH hub credentials to their own
storage.local keys: the persisted blob never carries them
(`stripSecretSettings` / `serializePersistedState` — every full-state persist
goes through the serializer), `saveSettings` writes a custody key only when
the patch names it as an own property (callers state intent per key; the
options page never names the token), and hydration precedence is custody-key-
wins-when-string so a stale v12-shaped blob write can never resurrect an old
token. One-release fallback READ of v12 blobs kept (the migration write is
the move). In-memory `Settings` shape is unchanged — consumers still read
`settings.agencyHub*`; the StorageCoordinator seeds custody keys from memory
when replaying storage changes so a secret-free blob change cannot blank the
token in its view. The custody keys joined UI_RELEVANT_KEYS (a token
issuance changes hub readiness without touching the blob). NOT done (E10's
second half, unchanged): moving credentials out of content-script-readable
storage entirely — still tracked for the chatter-key-deletion release.
Pinned in tests/storage-v13-token-custody.test.ts (10 cases, incl. the
interleaved stale-save race verbatim).

**E20 (2026-07-11).** Client-side transcript cap (core plan W9.4/A26). The
kernel rejects `clientContext.transcript` above 300k chars (core routes.ts
aiFeatureStreamBodySchema) — a giant live-read chat previously 400-ed the
whole generation at the boundary. `formatTranscriptForKernel` (mirrored
constant KERNEL_TRANSCRIPT_MAX_CHARS = 300_000) truncates OLDEST-first —
newest context is what a reply needs — reports `messageCount` as the KEPT
count (never claim more messages than the transcript carries), keeps the
tail of a single over-budget newest message, and is applied on BOTH lanes
(operations + compare cards, same clientContext schema). Acceptance pinned
against the VENDORED schema: 3000 long messages → ≤300k AND
`routeSchemas.aiFeatureStream.body.safeParse` passes.

**E21 (2026-07-11).** Acceptance-reporter hardening + revived fan-summary
cache write (core plan W9.4, A18 + A40 extension halves — the audit's own
cheap-hardening list). Three gaps closed: (1) the reporter's `onWarn` was
never wired at the composition root, so 400-batch drops and max-attempt
exhaustions were SILENT — they now reach the background console; (2) only
the overflow path fed the persisted dropped counter — the 400 and
max-attempts drop paths now increment it too, so `stats()` keeps every gap
visible across restarts; (3) one startup `flushNow()` after storage init —
events spooled when the previous background instance died no longer wait
for the next enqueue's debounce. Plus A18 proper: the fan-summary cache
write was gated on `actualModel === resolvedModel`, but post-cutover
resolvedModel is the 'kernel' cache sentinel while actualModel becomes the
meta frame's real vendor model id — in production the equality never held
and fresh summaries were never cached (the prefetch path masked it). Gate
removed; the sentinel stays the cache identity. Mutation-checked: the new
pin fails against the old gate.

**E22 (2026-07-11).** Opportunistic hub re-push of a ready Scan on chat open
(companion to core #136 — the kernel now injects the HUB copy of the fan
dossier into fast-reply/improve-draft/help-me/ping prompts, kernel-side,
zero wire change; compare inherits via fast-reply). The extension's summary
sync was fire-and-forget after generation with a retry only when the
chatter reopened Scan — a failed push could leave the hub without the
dossier indefinitely while every other feature wanted it. `refreshTabState`
now branches: no available summary → the existing availability prefetch;
available summary whose `agencyHubSync` is not `saved` for the current
(baseUrl, generatedAt) → `retrySummaryHubSync`, which reuses the same
`syncAgencyHubSummary` path the generation uses. Bounded on purpose:
in-flight dedup + `SUMMARY_SYNC_RETRY_COOLDOWN_MS` (3 min) per
`groupId|generatedAt|baseUrl` key (a NEW Scan or hub retarget gets a fresh
key; the key clears once saved), and the hub side already dedups
`already-synced` by (baseUrl, pageLabel, generatedAt). No UI change; the
existing sync-status pill picks up the result message.
