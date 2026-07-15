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
| E16 | 2026-07-11 | deploy.sh preflight asserts (branch/clean/ancestor/tag/served-older) + in-script release tagging; retro-tags owner-run |
| E17 | 2026-07-11 | Custom personas sync to kernel ai_personas (diff on save + boot reconcile); builtin card read-only |
| E18 | 2026-07-11 | Honest not-ramped board state: builtAt null passes through, never cached, distinct copy |
| E19 | 2026-07-11 | Storage v13: hub credentials in own storage keys (per-key custody; blob never carries them) |
| E20 | 2026-07-11 | Client-side 300k transcript cap, oldest-first truncation, both lanes |
| E21 | 2026-07-11 | Acceptance-reporter hardening (onWarn wired, all drop paths counted, startup flush) + fan-summary cache write revived |
| E22 | 2026-07-11 | Opportunistic hub re-push of a ready Scan on chat open (preflight-classified, cooldown-bounded, generatedAtMs) |
| E23 | 2026-07-11 | Spenders board v2: enumeration = map not membership gate (lazy inbox-search chat resolve), kernel limit 500, month +$N column + NEW badge, board search, two-timestamp meta, SPA chat-open with verified fallback, storage.session cache |
| E24 | 2026-07-11 | Action bar v2: tone groove (radio, arm-only, 😌😏💰🔥 + casual back) + Split flag (sticky) + regen keeps mode/tone; renames Fix/Recap/Split; tolerant [NEXT]; meaning-group seams |
| E25 | 2026-07-11 | Board rows show the chatter's custom fan names (Fansly rename = account note contentType 12002; batched /account?ids= overlay, best-effort); chatter-eyes-only — never into prompts |
| E26 | 2026-07-11 | Name cache → storage.local (survives browser restart, 6h TTL, size-capped); cold-build progress reported over the content port (counted name sweep + hairline bar) |
| E27 | 2026-07-12 | Armed tone stays emoji-only: fixed-width highlight replaces the expanding word so the narrow composer never shifts or scrolls |
| E28 | 2026-07-11 | Debug mode asks the kernel to echo its assembled prompt (core #140 capability header); echo stays in the SW, Fansly DOM gets only a typed counts projection + token, full prompt opens on an extension-origin page |
| E29 | 2026-07-12 | Spenders correctness/performance hardening: source-aware empty states, correlated builds, race-safe async UI, bounded optional reads, serialized scoped caches, incremental DOM updates |
| E30 | 2026-07-12 | Spenders scope/amount/freshness honesty: truncated controls name the loaded slice, sub-$1 spenders remain visible, tier-boundary amounts retain mills, builtAt is explicitly newest-projection freshness |
| E31 | 2026-07-12 | Spenders current-page completeness: Core #142 cap 1000, V3 bound-aware cache, exact old-Core 500 fallback, measured Firefox 1000-row render gate |
| E32 | 2026-07-12 | Kernel-only UX truth: dynamic server model catalog, owner-gated prompt debug, inert client prompt-caching control removed |
| E33 | 2026-07-12 | Release pages are validated and stamped pre-sign; release HEAD must exactly equal fetched origin/main; guide remains versionless |
| E34 | 2026-07-13 | Progressive Spenders snapshot/single-flight and nonblocking Settings hydration |
| E35 | 2026-07-13 | Confirmed reliability/performance fixes: recoverable persona sync, precise autosave revisions, capture/cache backoff, and stale async-result guards |
| E36 | 2026-07-13 | Global personas are server-admin content; the extension consumes metadata only and preserves legacy local definitions |
| E37 | 2026-07-14 | Read-only persona follow-up: narrow refreshes, future-schema barrier, durable Scan fences, and exact deployed-contract release gate |

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
`already-synced` by (baseUrl, pageLabel, generatedAt). REVIEW HARDENING
(same day): the re-push is not blind — a preflight GET of the hub's current
profile classifies first: identical body → just record "saved" (a lost
ack), no duplicate version append; a DIFFERENT hub profile that is not
older than ours (by `sourceGeneratedAtMs` when present, upload time
fallback) → never superseded by our stale local body, the key parks for
the worker lifetime (another device re-scanned); inconclusive fetch → no
blind push, cooldown governs. Pushes now carry `generatedAtMs` (when the
Scan actually ran) so the kernel's dossier age policy (#136) doesn't reset
on delayed re-pushes — needs the re-vendored SDK (core @ ai/scan-dossier);
old kernels ignore the extra key (non-strict schema), so deploy order is
free. No UI change; the existing sync-status pill picks up the result
message. Round-3 review: hub-prefetch hydration now records the SOURCE
generation time (`sourceGeneratedAtMs ?? createdAtMs ?? now`) — hydrating
with the append time made an old dossier look locally fresh and would
re-propagate that wrong stamp as `generatedAtMs` on a later re-push; and
the write race the client preflight can't close is closed ATOMICALLY
kernel-side (core 103ce92, appendFanProfile under its advisory lock:
identical body no-ops, a non-newer sourced write no-ops), so the preflight
here is an optimization, not the guarantee.

**E23 (2026-07-11).** Spenders board v2 — completeness, month movement, and
workflow speed (owner-approved scope a/b/d/e; recency/retention deferred).
(a) **The conversation enumeration is a MAP, not a membership gate.** Since
E6 the board filtered kernel spenders to those present in the most-recent-150
fan→groupId map — a whale who hadn't messaged recently silently vanished, and
the header counted the survivors. Now every kernel entry is listed;
`SpenderListEntry.groupId` is nullable, unmapped rows carry a "no recent
chat" chip, and opening one resolves the chat lazily: a new `resolveFanChat`
runtime request (protocol case pinned — the E8 lesson) runs ONE bounded
`/messaging/groups?search=<username|displayName>` request, matched by
partnerAccountId. Egress note: that is the same endpoint+param the page's own
inbox search box issues — no new Fansly egress class. The kernel query limit
rose to SPENDERS_KERNEL_LIMIT=500 (kernel max); the enumeration stays at 150
and only bounds direct-open coverage. `fanCount` now carries the kernel's
total (meta says "top N of M spenders" when truncated). (b) **Month-to-date
column:** a second, best-effort kernel query over the current 'YYYY-MM'
window feeds a green "+$N" per row and a NEW badge
(lifetime−month < $1 ∧ month > 0, the desktop's isNewSpender ported); a
failed or empty month window degrades the column to unknown (null, never a
misleading $0) and the board renders without it. Board search: client-side
substring filter over name/handle ('/' focuses it; typing never moves the
J/K cursor; the list re-renders apart from the input so focus survives).
Honest freshness meta: "data as of <builtAt> · fetched <fetchedAt>" — the
tooltip explains the hub walks Fansly on its own cadence and Refresh only
re-reads the snapshot. (d) **SPA chat-open:** the board navigates via
pushState + a synthesized popstate (what Fansly's Angular Location listens
for) instead of location.assign; the route is verified after
SPENDERS_SPA_NAV_VERIFY_MS (conversation DOM appears / container replaced /
header name changed) with a hard-load fallback, and a user who navigated
elsewhere meanwhile is never hijacked. Send surfaces untouched — this only
reaches the NATIVE chat faster. (e) **Cache custody:** the 10-minute board
cache is write-through to storage.session (quota-tracker pattern; memory
fallback), so an MV3 worker restart stops costing a rebuild; not-ramped
results stay uncacheable (E18) in both layers. NOT taken: recency/retention
badges (the vendored spender-retention module + auto-list ops need verified
Fansly-side data first), quick-look chat preview (egress question), net/gross
display. Pinned in spenders-service / spenders-board-controller / protocol /
runtime-api / fansly-client suites.

**E24 (2026-07-11).** Action bar v2 — the Reply cluster becomes OPTIONS + one
trigger (owner-driven redesign, mockup-iterated). (a) **Tones are radio
options in a sunken groove**, not buttons: segments 😌 casual / 😏 flirty /
💰 upsell / 🔥 spicy (emoji = the chatters' own language; precedent — the
Spenders tier chips), Russian hover hints, the armed segment surfaces as a
thumb and expands with its word (label appears exactly when the choice
matters). Clicking ARMS (or disarms) — the pre-1.5.5 one-shot
click-generates is deliberately gone; only Reply fires. `casual` returned to
the bar and to the ⌘⇧O cycle (dropped in 1.5.5 only to keep pills⇄cycle
lock-step — the groove restores both). (b) **Split (ex-Multi) is a
checkbox-flag, orthogonal to tone** (a flirty reply can be split): square-dot
pill OUTSIDE the groove — one groove per dimension, the merged-track draft
read as "a fourth tone" and was rejected. Split is now STICKY: the old
after-send reset made Regenerate silently lose the split — one of the two
real causes behind "сплит иногда не делает перенос". Regenerate now re-rolls
the same ask: sticky mode + a per-conversation memo of the last sent tone
(cleared on route change). (c) **Renames** (result-naming rule): Multi→Split
(the mode's real name — preferSplit), Polish→Fix (the bar had drifted from
FEATURE_LABELS), Scan→Recap (names the dossier, not the process;
FEATURE_LABELS updated — one name everywhere). Hotkey descriptions follow.
(d) **The other split cause** — the kernel prompt's opt-out ("if a split
would feel forced, return one clean message") — is fixed kernel-side (core
branch, split = ALWAYS ≥2 parts, ≤3); client-side, splitByNext is now
tolerant of marker drift (`[next]`, `[ NEXT ]` — bracket forms only; the old
case-sensitivity pin reversed). (e) Bar regrouped by meaning with hairline
seams: Reply+options │ Fix │ Hi·Ping │ → Recap+persona (right-pinned).
Pinned in button-bar / content-app / split suites.

**E25 (2026-07-11).** Spenders board rows carry the chatter's OWN names for
fans. The board showed platform display names (mostly == username, sometimes
a bare numeric id), while the team recognizes fans by the names they set via
Fansly's native rename ("change display names — it's for your eyes only").
Mechanism, established from the fbuddy-analysis clean-room docs: the rename
is stored as a creator-visible ACCOUNT NOTE with contentType 12002 whose
note text IS the name (the [FB] CRM tool reads the same field; its own CRM
blobs use contentType 12000 and are never confused for names). The service
overlays names in buildFromKernel via batched `GET /account?ids=`
(SPENDERS_NAME_LOOKUP_BATCH=50 → ≤10 extra requests per build, 10-min
cached; the endpoint is already in this client's surface — no new egress
class), best-effort per batch: a failed batch degrades its fans to platform
names, never the board; abort still aborts. The same payload backfills
displayName/username for fans the projection knows only by id (fixes the
"?"-avatar numeric rows). Row name precedence customName > displayName >
username > id; search matches all three; the @handle stays as the stable
identity line. BOUNDARY: custom names are CHATTER-EYES-ONLY UI — they are
never sent into prompts/clientContext (fanDisplayName stays the live-DOM
platform name; a model addressing the fan as "Max/Canada/45" would be a
product incident). §5 watch: contentType 12002 is pinned from the clean-room
analysis, not a live capture — verify on the first walkthrough that names
appear; if they don't, that constant is the first suspect. Pinned in
spenders-service / spenders-board-controller / spenders suites.
SAME-DAY HOTFIX (field report: board froze on "Building the board…"): the
sweep ran up to 10 back-to-back batches, each with the DEFAULT retry budget
(4 × 30s timeouts + backoff) — rate-limited batches stacked toward the
120s build abort. Now: per-batch retryPolicy 'none', an inter-batch
FANSLY_PAGINATION_DELAY_MS pause, a hard SPENDERS_NAME_SWEEP_BUDGET_MS=12s
wall-clock budget (out of budget → ship the board with the names in hand),
and a SEPARATE session name cache (SPENDERS_NAMES_CACHE_TTL_MS=6h,
merge-write) so later builds — including Refresh — fetch only unknown ids.
Names are decoration; the board never hangs on them again.

**E26 (2026-07-11).** Board cold-build: cheaper and no longer silent.
(a) **Name cache moved from storage.session to storage.LOCAL** (E25's hotfix
put it in session): a browser restart re-bought all ~10 batched
`/account?ids=` requests per creator, which is exactly the load the owner
questioned. Local + 6h TTL means the sweep is paid roughly once per 6h per
machine; the map is size-capped (SPENDERS_NAMES_CACHE_MAX = 2000, this
build's names win on overflow) because storage.local outlives the browser
and must not grow without bound. NOT taken (owner's call): lazily sweeping
only the top tiers — the full sweep stays, it is now cheap enough.
(b) **Cold-build progress.** The board rides a one-shot runtime request and
therefore had no channel to report anything, so a cold build sat on
"Building the board…" with no signal. The background now pushes
`spenders:progress` frames over the tab's EXISTING content port (a new
`OperationCoordinator.sendToTab`, wired at the composition root; protocol
case + guard pinned — the E8 lesson), and the board renders them: the
ranking phase keeps honest prose (no fake percentage — the kernel query has
no progress to report), and the name sweep, which is the part a chatter
actually waits on, reports counts ("Resolving fan names — 250 of 500…")
behind a determinate terracotta hairline. Failed batches still advance the
count (their fans are done being tried — they keep platform names), so the
bar can never stall. A warm cache skips the sweep entirely and the board
opens with no bar at all. Pinned in spenders-service / board-controller /
protocol suites.

**E27 (2026-07-12).** The armed tone no longer expands with its English word.
That E24 detail added ~40px exactly when a tone was selected, pushing the
right-pinned persona out of the narrow Fansly composer and introducing a
horizontal jump/scroll. The four segments now keep identical emoji-only
geometry in idle and armed states; selection remains explicit through the
light thumb, terracotta border, and `aria-checked`, while the full name and
Russian explanation remain available through `aria-label` and the hover hint.
No behavior changed: a tone still arms/disarms, Reply remains the only trigger,
and ⌘⇧O still cycles the same four options. Pinned in the button-bar suite.

**E28 (2026-07-11).** Debug mode shows what the model ACTUALLY received. Since
the kernel cutover the prompt is assembled server-side, so the "LLM Input" panel
could only ever show the client's own context plus two `[assembled kernel-side]`
placeholders — the persona, the templates and the fan dossier the kernel injects
(#136) were invisible precisely to the person debugging a bad reply. Now, with
debug mode on, the request advertises `x-kernel-ai-capabilities: debug-input-v1`
and the kernel — inside an owner-set, ≤24h window naming this chatter (core
#140) — answers with a `debug_input_v1` frame carrying the exact prompt blocks
plus its `contextManifest`. Silence means "window closed", never an error: the
panel says so, and generation is untouched. The capability rides a HEADER, so an
old kernel simply ignores it — a kernel rollback can never 400 a generation from
a new client.

The custody rule is the design: **the echo never enters the Fansly DOM.** The
page shares its document with Fansly's own JS, and the echo is agency IP. So the
background keeps it in memory only (`debug-prompt-store.ts`: 12-min TTL, 10
entries, random viewer token — never storage, never a log), the content script
gets a SEPARATE strict message (`operation:debugPromptStatus`, whose validator
cannot carry prompt text) with an opaque token and a typed counts projection
(`kernel-context.ts` — dossier version/age/chars/dropped, transcript-union
counts, and unknown manifest keys reduced to their NAMES), and the token lives
only in the content script's own heap, never in an attribute. The full prompt
opens in `debug-prompt.html`, an extension-origin tab; the background hands over
a snapshot only to a sender whose origin AND path match that page (exact match,
not a prefix), so the Fansly content script cannot spend the token it carries. A
cached Scan reports "no LLM call" rather than an empty inspector.

**E29 (2026-07-12).** Spenders hardening after an adversarial data/render
review. The board now carries the kernel stream status (`flag_off`,
`not_allowlisted`, `ramped`, `unsupported_platform`) end to end, so disabled,
pending, successfully-empty, stale, and failed sources no longer collapse into
the same "No paying fans" state. A missing fan in a bounded monthly top-500 is
unknown, not `$0`; NEW is allowed only for finite, internally consistent month
data. Optional reads have focused abort deadlines: a wedged monthly Hub query
degrades only the `+$N` column, an empty kernel result cancels the speculative
chat map, and name lookup stops at the first rate limit. Parent abort and
session expiry remain fatal. A page-wide `lastSyncedAt` proves an empty monthly
window only when that sync belongs to the requested UTC month.

Every board open gets a `buildId`; background progress frames echo it and the
content controller ignores older loads, progress, and lazy chat resolutions
after close/reopen or Refresh. An unfinished close/reopen load is reused rather
than duplicated only while the connected account + settings generation is the
same; a context change closes the old board and terminal responses re-check the
context before rendering. The background remains the owner of the 10-minute
TTL — the controller asks it on every open instead of pinning an unbounded
renderer copy.
Board session-cache keys include Hub origin + creator identity, credential or
settings changes invalidate all snapshots, in-flight old-source builds cannot
repopulate them, and a per-key build sequence prevents an older concurrent
response from overwriting a newer snapshot. Aggregate storage.session/local
writes are serialized and awaited so concurrent creators cannot erase one
another. Hub URL/credential/permission failures keep their own error codes
instead of being mislabeled as a page-mapping miss.

Rendering keeps one shell across tier/search changes, reuses row DOM, commits
through a DocumentFragment, delegates row clicks once, updates only the old/new
cursor rows, skips off-screen row paint, and coalesces search input (with
synchronous keyboard flush and composition-aware IME handling). Tier chips
expose `aria-pressed`; initials are grapheme-safe; load/close release detached
row/chip/progress references and timers. Deliberately NOT taken: list
virtualization — the bounded 500-row DOM is now linear and covered by a real
500-row structural test, while virtualization would add focus/scroll risk
without measured need. Pinned across spenders-service, agency-hub-client,
shared spenders/protocol, runtime-api, and board-controller suites.

**E30 (2026-07-12).** Spenders presentation no longer over-claims what the
bounded kernel response means. `pageTopSpenders` accepts only `window` plus
`limit <= 500` and has no cursor/offset, so `fanCount=694` alongside 500 rows
cannot be completed by repeating the request — rows 501–694 require a
Core-first contract change and an SDK re-vendor. Until then a truncated board
visibly names the loaded top-N scope, scopes search copy and tier-count
accessibility to it, and keeps empty-search copy inside that same boundary.
Positive spenders below the named `$1+` tiers remain visible in a Below-$1
section, so loaded/searchable never falsely means silently discarded.
Tier membership still uses exact kernel mills; only amounts whose whole-dollar
rounding would visually cross a boundary retain two or three decimal digits
(`$599.60` remains Top instead of appearing as a `$600` Whale). `builtAt`
remains `max(observed_at)` across the page/window projection (not necessarily a
returned top-N row), so the UI now calls it the newest Hub observation and
states that shown rows do not share that timestamp — never a coherent
`data as of` claim. Full list virtualization remains deferred until a Firefox
profile finds a measured long task; it cannot recover rows the API did not
return. Pinned in the shared spenders and board-controller suites.

**E31 (2026-07-12).** The current 694-spender page is complete in one bounded
read. Core #142 raises only `pageTopSpenders`'s maximum from 500 to 1000 (default
150); the extension now asks 1000 for lifetime and current month. Pagination is
still deliberately absent: splitting a projection that updates in place across
requests, without a snapshot-bound cursor, would create duplicate/skip races.
If `fanCount` later exceeds 1000 the existing `top N of M` copy remains honest,
and that real demand should add snapshot semantics plus keyset pagination rather
than another unbounded increase.

Normal rollout is Core first. For independent rollback safety, this extension
recognizes ONLY the old Core's exact Zod/Fastify limit-500 response and retries
once at 500; unrelated 400s, auth, network, and abort failures are never treated
as compatibility. That fallback still produces the honest truncated UI and is
temporary for the compatibility window. The board session namespace moves from
V2 to V3 and the requested limit is part of each key, so a warm top-500 snapshot
cannot survive the upgrade. A response shorter than `min(fanCount, 1000)` is not
cached, so a fallback result cannot remain for ten minutes after Core recovers.
The vendored SDK intentionally stays pinned: this is
the same operation and numeric query, its runtime serializes requests without
request-schema parsing, and the response shape is unchanged; Core alone refreshes
its generated OpenAPI/SDK/hash.

Virtualization remains deferred by measurement, not assumption. In real Firefox
152 on macOS, five fresh navigations at 1000 rows measured cold open 19–23 ms,
search list commits 4–6 ms (166–174 ms end-to-end including the intentional
150 ms debounce), tier commits 3 ms, 200 consecutive J presses at p95/max 1 ms,
Refresh 38–39 ms, close 16–17 ms, and reopen 24–29 ms. The current 694-row case
was at or below those bounds after browser startup. Close left zero DOM rows,
row references, and cached row nodes. Firefox does not expose the Long Tasks API,
so the gate uses direct operation/commit timing; none of the measured synchronous
paths crossed 50 ms. Adding virtualization now would introduce focus/scroll
state risk without a measured benefit. Structural 1000-row service/render tests
pin coverage, O(1) cursor work, coalesced search, row reuse, and cleanup.

**E32 (2026-07-12).** Kernel-only ownership is reflected in the operator UI
instead of preserving dead client controls or a stale provider catalog. The
Prompt Caching checkbox was inert after the kernel cutover: it only rewrote an
old storage field and could not affect the server policy, so the control and its
guide copy are removed while the persisted field remains readable for backward
compatibility. Model availability, routing, cost, and provider selection are
described as dynamic server state. Debug documentation follows E28: an exact
assembled prompt is visible only during an owner-controlled window and only on
an extension-origin page, never in the Fansly DOM. Device-token preference is
also stated without hiding the temporarily dual-accepted legacy Hub key.

**E33 (2026-07-12).** Release pages now fail safely before the irreversible AMO request. `deploy.sh`
fetches `origin/main` plus tags and requires exact commit identity with
`origin/main`; install/changelog version slots are validated and stamped before
`web-ext sign`. The guide is intentionally versionless and is uploaded
unchanged, with the signed update feed as version truth. Changelog copy names
kernel-served AI rather than the retired client-selected provider model. Offline
tests pin slot cardinality, substitution, guide versionlessness, and sign order.
**E34 (2026-07-13).** Slow optional discovery no longer blocks the first useful
Settings or Spenders UI. Settings starts `getSessionsSnapshot` immediately but
renders Appearance, Generation, Agency Hub, and Model Personalities from a
non-mutating local read; only Account Mappings and Connection Status remain in
an explicit hydration state. After the background-owned identity rekey finishes,
Settings re-reads storage and merges only mappings, aliases, and known accounts,
then replaces only those two sections. Mapping saves follow the same narrow
rerender path, so a persona textarea and its pending debounced edit survive.
The initial read is deliberately read-only: a concurrent full-state migration
write captured before the rekey could otherwise restore legacy account IDs over
the canonical state. Snapshot failure leaves all local controls usable and
marks only the account-owned sections failed.

Spenders now publishes the authoritative lifetime ranking as a correlated
`spenders:snapshot` as soon as that query resolves. The one-shot request remains
open while month spend, chat IDs, and custom names enrich concurrently; only the
final enriched result enters the 10-minute board cache. The controller keeps the
preliminary rows interactive, ignores stale build IDs, preserves the active tier
and search while keeping the focused input/caret intact, and rebuilds only row
nodes so enriched values actually repaint. Concurrent non-refresh cold requests
for the same creator/Hub key share one internally-owned build with per-caller
progress/snapshot fan-out and late-join replay. A caller abort detaches only
that caller; the upstream work
is cancelled when no waiters remain or invalidation makes it unsafe. This removes
the optional 12-second month/chat-map budgets and name sweep from time-to-first-
row, and removes the up-to-5-second live identity lookup from Settings' initial
local render. Pinned in options accounts, spenders service/controller,
runtime API, and protocol suites.

**E35 (2026-07-13).** Follow-up fixes are limited to failures reproduced in
tests or demonstrated through complete execution paths. Persona synchronization
keeps the latest desired snapshot, reconciles after a Hub source or credential
change and after a successful connection, and retries transient writes with a
bounded delay. Deletions are persisted as individual local journal entries
before the remote archive call: each delete synchronously starts its encoded
journal write before the first await, so neither an initial aggregate read failure nor
a Manifest V3 worker restart can silently forget it. Archive acknowledgement or
same-ID recreation removes only that key; a later reconciliation retries only
those explicit IDs. Missing or empty custom personas are not valid mappings:
existing stale mappings now surface the mapping banner and cannot reach
generation, prefetch, popup, or
comparison-card persona paths.

Normal Options saves are serialized and flushed on change/blur. The pagehide
path directly dispatches the newest dirty snapshot even if an older write is
still awaiting acknowledgement. Hub actions join an identical active snapshot
or force exactly one current snapshot; ordinary form completion preserves a
newer background-issued device token, and the API-key custody key is written
only after an explicit key edit. A persona receives a new monotonic `updatedAt`
only when its own draft changes; unrelated rerenders preserve the other revisions.
Failed explicit API-key writes retain ownership and are retried by the next save
or pagehide. A successful persona save refreshes only mapping options, so
empty-to-usable transitions appear immediately without replacing the focused
persona input. The mapping banner similarly carries a render generation and
rechecks its desired account after asynchronous persona loading, preventing an
older render or detached controls from reopening or saving a mapping for the
wrong account.

Background startup proves that Firefox has registered `storage.onChanged` with
a bounded private probe, then takes a fresh non-mutating snapshot. Only an
observed probe permits migration or bundled-persona repair writes; otherwise the
normalized state remains available read-only and a later access retries. Patches
arriving during the read or repair are merged and replayed, late self-events are
consumed, valid summary writes remain raw, and custody keys never re-enter the
settings blob. This avoids depending on an early change event that Firefox may
drop before parent-side listener registration.

Routine authenticated captures still refresh the in-memory session template,
but UI refresh and prefetch run only for first/account/reconnect/auth/session
changes. Legacy unresolved account IDs retain an independent 30-second identity
retry cooldown, so making the heavy path conditional cannot make a transient
lookup failure permanent. Hub summary not-found results use a bounded 60-second
negative cache while transient failures are never cached, and Spenders snapshots
are invalidated only by normalized Hub source or credential custody changes.
Final Spenders enrichment restores the keyboard cursor by `fanAccountId` (or the
nearest surviving row) while retaining search focus/caret. Tests pin restart
recovery, stale async completions, pagehide ordering, precise persona revisions,
startup storage races and listener loss, cursor identity, capture retry behavior,
and cache invalidation boundaries.

**E36 (2026-07-13).** Global persona authoring and lifecycle ownership move to
Core administrators. This supersedes only the client-authoring and persona-sync
parts of E17 and E35; those entries remain as historical records. Chatter
clients may fetch the authenticated metadata catalog (`key`, `displayName`,
`version`, and `status`) but never receive or write a global persona's
`systemBlock`. The extension no longer exposes persona add, edit, delete, or
sync controls.

Storage schema v14 keeps the old `personalities` array byte-for-byte separate
from the server metadata catalog. Before any migration write or first catalog
request, the extension creates a write-once preservation snapshot containing
the complete legacy definitions, mappings, and aliases. A failed snapshot write
or malformed existing snapshot fails closed instead of overwriting evidence or
continuing with a network/migration mutation. Settings offers copy and JSON
download export of the preservation data. Legacy definitions are not silently
deleted.

Mappings remain local. Active catalog entries are selectable; mappings to a
missing or archived key remain stored and visible as unresolved, but cannot be
used for generation. Catalog refresh runs on startup, normalized Hub source or
credential changes, a successful connection test, and a bounded five-minute
loop while the worker remains alive. Responses from an obsolete source are
discarded. Server persona `version` participates in generation and comparison
cache identity so an administrator update invalidates stale results without
exposing prompt bodies. Preservation, source-change races, archived/missing
mappings, export completeness, refresh cadence, and cache invalidation are
pinned in focused tests.

Catalog bytes are usable only while their stored source fingerprint exactly
matches the normalized Hub URL and current credential. Migration and the
background storage coordinator enforce that fence synchronously, before a
queued refresh can finish, so a hung old-source request or worker crash cannot
carry Hub A persona metadata into Hub B. Ordinary completed-result caches are
likewise pinned to persona key and version and are cleared on remap, archive,
or revision change.

The current Hub fan-profile contract does not include persona key/version
provenance. Consequently the extension never adopts a pulled profile body as a
current local Summary or stamps it with the current persona revision; a local
cache miss runs the kernel gateway. Post-generation profile PUSH and its
conflict preflight remain enabled. A malformed preservation snapshot renders a
minimal copy/download recovery page before any runtime or Hub request.

Persona-dependent identity is the complete catalog-source/key/version tuple,
not key/version alone. Summary caches persist that source (legacy source-less
entries invalidate once), and tab, completed-overlay, and Compare fingerprints
carry it through the UI. At every terminal save/send and immediately before
kernel or Hub transport, the background reads browser storage directly instead
of trusting a possibly lagging `storage.onChanged` projection. Per-conversation
Scan tokens preserve click order across tabs and validation latency; conditional
save operations run inside the storage write queue, so an older Scan cannot
overwrite a newer cache. Forced regeneration bypasses the old cache without
deleting it up front; a verified success overwrites it, while a failed or
superseded run leaves the last-good value intact. Hub profile append performs
one last callback fence after page resolution and immediately before PUT.

Release ordering is executable policy: `.env.deploy` must name the production
`AGENCY_HUB_BASE_URL`, and `deploy.sh` requires the unauthenticated persona
catalog route to return exactly 401 before AMO signing. A 404 therefore blocks
an extension-first release against an old Core.

**E37 (2026-07-14).** Persona-catalog polling is state-sensitive rather than a
five-minute UI reset. A byte-identical normalized catalog performs no storage
write. Freshness timestamps are operational metadata and do not refresh tabs;
changed catalog, mapping, alias, and account metadata use the narrow
`mapping:changed` message. Only an actual normalized Hub-origin or credential
custody change uses `settings:changed` and invalidates the Spenders context.
Consequently an owner metadata refresh cannot close an open board or discard
unrelated work, while a real source/principal replacement still does.

Storage v14 fails closed if either startup migration or a later fresh deferred
read sees a schema newer than this build. The coordinator drops its cached
projection and buffered patches, refuses subsequent reads and writes, and never
downgrades the unknown layout. Browser storage has no transactional compare-and-
set primitive: a write already in flight when a newer worker commits its schema
cannot be retroactively cancelled, and already-shipped v13 workers cannot be
changed. Rollout therefore reloads every old extension context, including
Fansly tabs and Options, after the update. Coordinator-managed writes check the
barrier immediately before their queued task executes, and every future schema
discovered by a fresh coordinator read permanently closes that worker. The
write-once namespaced legacy snapshot may be added before full schema discovery;
it never serializes, removes, or downgrades the newer state layout.

Per-conversation Scan commit tokens are correctness fences, not an LRU cache.
They have no arbitrary 200-group eviction: a slow operation may still be
finishing its durable save or Hub append after many unrelated conversations
were opened. The map is worker-lifetime scoped and is intentionally allowed to
grow by one small tuple per distinct group; a later Scan for the same group
replaces its row.

Core's metadata catalog adds the required opaque `definitionId` in addition to
the numeric revision. It identifies exact definition bytes across restore or
revision rollback. Clients send it as the generation precondition, require the
successful stream metadata to echo the same applied identity, and use it for
persona-dependent cache and in-flight fences; they compare it but never parse
its current `v1:` representation. The old
E36 field list remains historical and is superseded by this additive metadata
contract. Release provenance is similarly content-based: deploy accepts only
the exact canonical `https://gosling-agency.ru` origin, requires healthy Core
to expose the normalized-OpenAPI `contractHash` equal to the vendored SDK
manifest, and then proves the catalog route is auth-protected with 401 before
AMO signing. No deployed source-SHA ancestry is inferred.

**E38 (2026-07-15).** Kernel SSE `error` frames surface as their named cause,
never as the generic truncation error. Trigger: lora-2's dead page proxy made
every generation fail as `CG-HUB-07: Agency Hub request failed` — the kernel
HAD named the cause (`error` frame, code `provider_stream_failed`) but the
gateway's frame switch ignored the frame, so EOF-without-`done` collapsed it
into "AI stream ended without completing", and a day of screenshots was spent
rediscovering what the wire already said. Three rulings: (1) the feature-lane
gateway maps `provider*` error-frame codes to the new `hub_provider_failed`
(CG-HUB-10, "infrastructure for this page, tell a manager" — retry-neutral
wording because a dead proxy is never fixed by retrying), any other frame code
to `hub_request_failed`, both carrying `code: message` as `serverDetail` and
passing `retryAfterMs` through; the frame check runs BEFORE the persona
provenance barrier because a terminal error is not a provenance violation and
must not be misreported as `chat_changed`. (2) Error surfaces (inline card and
toast) render one mono `formatUserErrorTechnicalDetail` line — `HTTP <status>
• <serverDetail>` — whenever the error carries diagnostics; the fields already
rode `UserFacingError` end-to-end and were simply never rendered. (3) The
error-frame `code` stays an open string in the contract (kernel can add
`provider_proxy_unreachable` etc. without a re-vendor); the extension matches
by prefix, not by enum. Fail-closed behavior is unchanged: an error frame
still means no result is presented.
