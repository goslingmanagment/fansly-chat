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
