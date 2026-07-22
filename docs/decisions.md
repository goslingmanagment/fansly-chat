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
| E38 | 2026-07-15 | Kernel SSE error frames surface as their named cause: gateway maps provider* codes to hub_provider_failed/hub_request_failed, error surfaces render one technical-detail line, frame code matched by prefix not enum |
| E39 | 2026-07-15 | Releases announce themselves in the ChatGoose Telegram channel: `--check` fails deploy.sh preflight before AMO signing, the real send runs only after tag_release and never fails a live deploy, load_env stops exporting `.env.deploy` |
| E40 | 2026-07-17 | Options P1 shell redesign: desktop SettingsSurface shape + family control vocabulary, one «Аккаунты» section, Russian copy with EN-term glossary, local fonts (Google CDN removed) — zero behavior change, schema stays v14 |
| E41 | 2026-07-17 | Options P2 informativeness: read-only «Статус» section + readiness hero, four independent runtime reads (health raw-503, me, per-page quota, spenders observations), persisted-signature hydration guard, no_permission first-class — schema stays v14, read-only throughout |
| E42 | 2026-07-17 | changelog.html rebuilt in the family web register (Fraunces/paper/clay, uniform collapsed cards + inline opener, dark theme): zero release-text rewrites (317 li preserved), canon+dates via committed tests/fixtures/changelog-manifest.ts, both deploy stamp slots byte-exact |
| E43 | 2026-07-17 | Options P3: persona catalog presented as human rows (built-in badge, vN, аккаунтов-счётчик, honest empty-states incl. fetchedAt-stamped confirmed-empty), «Выйти» = background signOutAgencyHub (durable wipe-first, then best-effort revoke; four honest outcomes), identity line rides P2 statusModel — schema stays v14 |
| E44 | 2026-07-18 | 1.9.11 restores the 1.9.9 runtime after the accidental 1.9.10 Settings preview; E40–E43 move to 2.0, storage stays v14, production-aligned generated SDK stays |
| E45 | 2026-07-18 | Coach settings-shape ships as storage schema v15 (coachHistoryLimit, coachAutoRecap; deep-window default 1500→3000 via a raw pre-v15 bump; durable schemaVersion stamped on every save); Fansly-egress/cost assessed; output-exhaustion fail-closed extended to fan-summary + compare cards + an empty-output guard; `trustedTerminal` invalidates every pre-guard local recap; the former Hub residual is resolved by Core #177 |
| E46 | 2026-07-19 | Coach feature (client-side): per-fan in-memory sessions, canonical conversationRef=groupId + required fanRef, transcript overlap-and-replace cache, recap two sizes + picker (`summary-short:` key, short never syncs to Hub), auto-recap STOP/PROCEED taxonomy (timed_out/network_error STOP by design), serialization on lifecycle.reserve, empty-pageLabel acceptance fallback, custom-name rule both lanes |
| E47 | 2026-07-20 | Voice notes: fan-pinned paid recovery, exact-take/live-route attach custody, bounded MP3 handoff, and explicit storage.session/MV3 limits |
| E48 | 2026-07-20 | Docs cleanup: `docs/project-kernel/` retired (tombstone); superseded Pass-1 maps deleted and their living regeneration prompt moved under `docs/generated/` |
| E49 | 2026-07-20 | Split-contract presentation is shared across overlay, default inline reply, and Compare: one part warns in amber, successful Split guidance stays neutral, and part-card hints/emphasis come from one helper; follows core Decision #156 without changing wire/output parsing |
| E50 | 2026-07-20 | Ping sends a bounded whole-day fan-silence gap from the same clock and latest fan text as segment selection; follows Core Decision #127 and current SDK contract |
| E51 | 2026-07-21 | Options waits for a durable MV3 storage-readiness barrier; custody-layout repair is independent of schemaVersion and failures render no settings writer |
| E52 | 2026-07-21 | Voice hardening: fail-closed/bounded script SSE, V2 Hub-principal+page custody, bounded paid/free requests, single-flight monotonic status, explicit cancel; custom-name and cross-tab behavior remain intentional |
| E53 | 2026-07-22 | Coach panel UI redesign (presentation-only, no migration): coach-scoped header/CSS polish, one «Рекап ▾» menu replacing three buttons, structured recap status line, grouped empty state, per-turn draft-attach intent (`draftText` sent only when the live Fansly draft is non-empty at dispatch), a content-owned `transcriptEpoch` reseed key, a coach settings snapshot, and `turnContext` plumbing (background stops discarding `attachedRecaps`); Russian copy for all coach-owned strings |

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

**E39 (2026-07-15).** Releases announce themselves in the ChatGoose Telegram
channel: `scripts/announce-release.mjs` posts the released CHANGELOG.md
section via Bot API `sendRichMessage` (Rich Markdown carries the section
nearly verbatim; the 32768-char limit is enforced, bare `$` is escaped
because Rich Markdown parses `$…$` as math, and markdown outside the
supported subset fails preflight instead of being silently mis-escaped).
`deploy.sh` runs `--check` before `web-ext sign` (E33 fail-early, including
credential presence when the send is not skipped) and the real send only
after `tag_release`; an announce failure warns but never fails a live
deploy, and any transport failure after dispatch is indeterminate — never
auto-retried (family law); only an explicit 429 with `retry_after ≤ 60s`
gets one retry. `load_env` no longer `set -a`-exports `.env.deploy`, so the
bot token is not handed to child processes; the CLI loads the file itself.
Backfill = the same CLI with `--version X.Y.Z --silent` per missing
release, channel inventory via the user-session tooling (bots cannot read
channel history).
**E40 (2026-07-17).** Options P1 shell redesign: the settings page adopts
the desktop SettingsSurface shape (sticky nav + scroll-scanline scrollspy +
9px section cards) and the family control vocabulary (badge/toggle/chips/
cap/num, saved-flash autosave feedback), merges Account Mappings +
Connection Status into one «Аккаунты» section (persona-availability info
node and newest-snapshot-wins preserved; capture times tick), re-wraps the
Hub section into label rows with a four-state permission badge computed
before every status exit, collapses the legacy chatter key behind
<details>, moves the options surface to Russian copy with an English-term
glossary (options-reachable hub error strings in shared/errors.ts included
— they also serve the in-page surface by recorded intent), and bundles the
family fonts locally (Google Fonts CDN removed from options and popup;
debug-prompt deliberately stays on system fonts). Cyrillic body text
intentionally renders in the system sans — Hanken Grotesk has no Cyrillic
subset, matching the desktop's Russian-locale behavior; Hanken serves
Latin glossary terms and figures. Zero behavior change: the single central
write controller, custody discipline (E19), persona preservation/recovery
(E36/E37) and the future-schema barrier move verbatim (pinned by a new
initial-read catch-up regression test); storage schema stays v14.
Per-section module extraction is deferred to P2/P3 (spec §10 amended on
the docs branch). Spec: docs/superpowers/specs/2026-07-16-options-redesign-
design.md (P1); plan rev 5 after one codex-ultra and two double-blind
toolkit reviews.
**E41 (2026-07-17).** Options P2 informativeness: a read-only «Статус»
section (Fansly capture / Hub /health UP·DEGRADED·DOWN·НЕТ ДОСТУПА / Доступ me
AUTH·401·НЕТ CREDENTIAL·НЕИЗВЕСТНО / per-page AI quota / Spenders observation /
debug-only Контракт MATCH·DRIFT) plus a readiness hero that reaches all-green in
≤3 actions and collapses to a pulse line. Four new runtime reads
(getAgencyHubHealth, getAgencyHubIdentity, getAiQuotaByPage, getSpendersStatus)
— the options page never calls the kernel directly; each source hydrates
independently (Promise.allSettled — one reject never strands a sibling row) with
a skeleton and fails honestly ("unknown", never an invented number). DEGRADED is
read via client.raw('health') + the vendored 200 schema (the typed client throws
before the declared 503 body); the debug Контракт row compares the health
contractHash to a background-stamped KERNEL_CONTRACT_HASH, so the options bundle
imports no SDK. Health and credential validity stay SEPARATE rows and requests
(never one indicator): no_permission is first-class (checkIdentity propagates it,
the Hub row owns the «Разрешить доступ» grant, the Доступ badge stays neutral),
so a fresh install is never a false red. Hub-status hydration fires at mount, on
the post-persist connection-test boundary, and on the auth events (sign-in
success, permission grant) — never per-keystroke — each caller passing the
signature of the snapshot it persisted; the guard binds to that signature
(checked before issuing AND before painting, no generation counter), so a
re-typed field never gets a stale paint and a freshly-issued device token flips
Доступ to AUTH in place. Readiness step 3 checks only accounts with
captured sessions (an offline archived mapping never blocks all-green). Quota and
spenders observations are storage.session-scale — schema stays v14; no new Fansly
egress (DP 1-B). The Версия «Changelog» button links the anchored changelog page,
gated on that page deploying first. Read-only throughout: the one central write
controller, E19 custody, and the E37 barrier are untouched. Spec:
docs/superpowers/specs/2026-07-16-options-redesign-design.md (P2).
**E42 (2026-07-17).** changelog.html rebuilt in the family WEB register
(install.html's palette: Fraunces serif + paper/clay, goose mascot header) —
distinct from the extension's in-app tokens by design. Every release card is
uniform collapsed <details class="release-detail"> markup; a tiny inline
footer script opens the latest three at load (no-JS = all collapsed to
readable serif summaries — accepted). Dark theme is a prefers-color-scheme
token swap on THIS page only (install/guide deliberately stay light).
Release canon and dates ride ONE committed manifest
(tests/fixtures/changelog-manifest.ts: ordered version list, dates only for
1.7.0+ from real tag creatordates — the 11.07.2026 bulk retro-tag cluster
recorded as-is); release-pages.test.ts asserts the page's card sequence
equals the manifest exactly (catches deletions/reorders forever), every
manifest date renders, anchors stay unique with the current version present,
and BOTH deploy stamp slots (deploy.sh and deploy-pages.sh regex forms)
match byte-exactly — proven by a dual-stamp dry-run test. The transformation
was scripted with a text-preservation assertion: 54 cards, 317 list items,
42 summaries carried over byte-identical; zero release texts rewritten. A
routine release = one uniform card insert + one manifest line, no other
churn. Plan: docs/superpowers/plans/2026-07-17-changelog-web-register.md.

**E43 (2026-07-17).** Options P3 — persona presentation + sign-out. The
persona section renders the kernel catalog as human rows (bold displayName,
`built-in` badge for builtin:lora, mono vN, «аккаунтов: N» from local
mappings; archived personas dimmed only while a mapping references them,
with «выбери замену»), a footer «каталог изменялся N мин назад» (— when
unknown) and honest frozen-editing copy (authoring stays frozen until core
#151; the UI never promises owner-side creation). Empty-states are honest
end-to-end: a confirmed-empty catalog response now STAMPS
personaCatalogFetchedAt (the byte-identical refresh skip requires a
non-null stored stamp), so «Сервер вернул пустой каталог» renders only
after a real fetch, while a failed refresh after rotation keeps «каталог
для новых кредов ещё не загружен»; the live-rotation storage listener
re-reads settings so the source check never uses stale credentials.
«Выйти» is the background `signOutAgencyHub`: durable EMPTY-string wipe of
both custody keys FIRST (survives a page close mid-operation), then a
best-effort authRevokeCurrentDeviceToken (~5s, device-token bearer only);
four honest outcomes (revoked / already-invalid — only when the token is
absent or the hub answered 401/403, never for a missing URL / unreachable
→ sliding-expiry / wipe-failed → red flash, credentials still present).
The page handler awaits the existing save chain (pending unrelated edits
land in order; queueSettingsSave semantics untouched — no fences, no
version bumps) and releases custody-field ownership before delegating; a
pagehide after sign-out cannot replay the old key. The signed-in block
shows the spec §6 identity line (username · role · страниц: N) as a pure
reader of P2's guarded statusModel. The recovery gate is restyled on the
family tokens but stays OUTSIDE the shell. Schema stays v14; E36/E37
preservation/recovery/export machinery verbatim. Spec:
docs/superpowers/specs/2026-07-16-options-redesign-design.md (§6 as
amended wipe-then-revoke, §7, §13.3).

**E44 (2026-07-18).** Release 1.9.10 accidentally carried the E40–E43
Settings/Options preview from `main`, although that work belongs to the 2.0
release line. Published history is immutable: tag/feed version 1.9.10 remains a
real release and is not deleted or reused. Release 1.9.11 is therefore a
forward-version corrective release that restores application, popup, Options,
and background behavior to v1.9.9; the exact 1.9.10 tree is preserved on
`release/2.0-options` for continued 2.0 work. The storage schema remains v14,
so this is not a data-schema downgrade and no credential, mapping, persona
snapshot, or cache cleanup is introduced. The generated kernel SDK snapshot
remains aligned to the currently deployed Core contract as release evidence;
keeping generated contract bytes does not enable any E40–E43 call path. The
E40–E43 technical decisions and their hand-curated plans/spec stay in history
with explicit 2.0-deferred banners rather than being deleted.

**E45 (2026-07-18).** The Coach feature's settings-shape change ships as storage
schema **v15**, not v14. v14 already shipped and lives on `main` (E37 persona
catalog; kept live through the 1.9.11 corrective, E44) — so per the forward-only
migration law a NEW shape change takes the next number rather than reusing a
released one. v15 adds two Settings fields (`coachHistoryLimit` default 10,
clamped [1,20]; `coachAutoRecap` `off|short|full`, junk → `off`) and raises the
deep-window default `DEEP_DEFAULT_MESSAGE_COUNT` 1500 → 3000. The default bump is
a RAW pre-normalization transform (`bumpLegacyDeepMessageCountDefault`) keyed on
the INCOMING record's `schemaVersion`: a pre-v15 record whose `deepMessageCount`
is exactly the old default 1500 silently adopts 3000, any other stored value
(including a deliberate 1499) is preserved, and a record already at the current
schema never re-runs it — so a chatter who sets 1500 AFTER v15 keeps it. Because
v14 shipped with the 1500 default, this deliberately upgrades in-the-wild v14
installs on the old default too (14 < 15). E19 credential custody,
`serializePersistedState`, and the E37 future-schema barrier are untouched: the
single jump-to-current normalizer auto-targets v15 via the `MIGRATIONS` entry.
**Fansly-egress + cost blast radius (assessed).** The 3000 default is a SHARED
deep-window value: `resolveFeatureMessageCount` feeds it to the whole `deep`
message-count bucket, so raising it doubles the live-read pagination (~60 → ~120
Fansly pages) not only for coach's recap but for `fan-summary` AND `chat-review`
on every old-default install the bump touches. This is accepted, not overlooked:
the larger window is owner-chosen for the recap path; `chat-review` inherits it
deliberately — it is hidden from the action bar since E24 and is a low-usage
analysis feature, so its share of the extra egress is small. Crucially the
pagination PACING is unchanged — `FANSLY_PAGINATION_DELAY_MS` stays 300 ms, so
the request RATE against Fansly (the actual model-ban risk surface per CLAUDE.md)
is identical; only the page COUNT per deep operation rises, and only for the two
overlay analysis features, never the high-frequency inline reply path. The
matching latency cost was absorbed by doubling `DEEP_OPERATION_PREP_TIMEOUT_MS`
180 s → 360 s so a full-window load no longer times out mid-pagination. If the
non-coach blast radius is later judged too wide, the fix is to split a dedicated
coach/recap window constant off the shared deep default rather than to lower it.

**Output-exhaustion + empty-output fail-closed — UNCONDITIONAL (review rounds 4–13).**
The family "a truncated stream is an error, never presented" rule keys on the SDK's
`isOutputExhausted` (normalizes kernel `max_tokens` + provider `length`). It began
narrowed to reply/coach/fan-summary, but since round 12 it fires for EVERY
FeatureType before the result is built — help-me/chat-review are NOT exempt (their
XML parsers return `valid:false` rather than throwing, so a truncated analysis body
would otherwise present as a `valid:false` card). Symmetrically, since round 13 an
EMPTY/whitespace-only output ALSO fails closed for every feature: `parseHelpMeXml('')`
/`parseChatReviewXml('')` return `valid:false` (they do NOT throw) and
`assertInsertableFeatureResult` guards only reply kinds, so an empty analysis result
would otherwise reach operation:complete and render an empty card as success (the
earlier "empty body already fails that parse" scope note was factually wrong and is
retracted here). Both guards sit before the result build and the summary-cache
write, so nothing truncated or empty is ever presented or cached — no feature
exceptions (do not re-narrow either guard to a feature list).

**`trustedTerminal` cache invalidation — one-time fleet cost (accepted).** A
cached recap is a valid cache HIT only if it carries a `trustedTerminal` marker,
which is written ONLY on entries produced behind the exhaustion+empty guards
(`isValidSummaryCacheEntry` requires it; `normalizeSummaryCacheEntry` preserves it
through migration; it is not a required field, so legacy entries survive
normalization but fail the hit). Consequence, deliberately accepted because a
legacy entry cannot be proven un-truncated: EVERY recap cached by a shipped 1.9.x
lacks the marker, so (1) the FIRST Recap per fan after upgrade is a forced
regeneration — real AI spend plus a full deep-window live read at the new 3000-msg
/ ~120-page default; (2) `hasAvailableFanSummary` flips to false for every fan
until each is re-run, so the popup/status `hasAvailableSummary` flag reports "no
summary" in the interim; (3) the dead entries occupy the summary-cache budget
until LRU eviction. Cheap and self-healing (one recap per fan). The forced
regeneration MUST be called out in CHANGELOG.md when this stack ships (the coach
feature is unreleased today, so there is no release entry to carry it yet) so the
one-time fleet spend is not a surprise on the bill.

**Hub-residual gap (round 9; resolved by Core Decision #177).**
`trustedTerminal` still guards the LOCAL cache and the opportunistic Hub re-push
still refuses an untrusted entry. Core now independently admits a Hub dossier to
prompts only when its exact body matches Core's own usable, completed full-summary
terminal record for the same page/fan. A pre-guard exhausted or indeterminate
recap therefore remains an auditable profile version but cannot feed any prompt;
fresh trusted regeneration plus the existing auto-sync remains the self-heal path.
No extension wire field or SDK change was needed.

**E46 (2026-07-19).** The Coach feature ships as a client-side conversational
coaching lane over the same kernel feature-lane (SSE) as the other AI actions.
**Sessions:** per-fan in-memory coach sessions (LRU, ≤5 per tab) hold the exchange
history; nothing coach-specific persists to storage. **Canonical identity:** Coach
and the new Recap requests adopt the contract's identity split —
`conversationRef = Fansly groupId` and `fanRef = fanAccountId` — instead of the
legacy `fanAccountId ?? groupId` collapse; the attach lookup searches both keys
during transition. Coach-chat REQUIRES a resolved fanRef and fails closed with
`coach_fan_unresolved` BEFORE the kernel call, so acquiring context never burns a
generation (spec §4/§5). **Transcript strategy:** per-turn freshness without ~40
Fansly requests uses a background session cache with **overlap-and-replace**
(`coach-transcript-cache.ts`) — the first turn seeds the full quick window (≤4
pages at defaults), follow-up turns fetch only page 1 (newest 25) and replace the
cached suffix that page overlaps (Fansly rows are mutable: edits/deletions land
within the refreshed region; no blind concat), keep paging on no-overlap, and
full-reload before the kernel call when continuity is impossible. The client
history sent on the wire (`serializeCoachHistory`) is an OPTIMIZATION, not the
source of truth — the kernel is authoritative. **Recap: two sizes + picker
(client-side):** short and full recaps are distinct, mode-qualified summary-cache
keys — short gets its own `summary-short:` prefix (`SUMMARY_SHORT_CACHE_PREFIX`)
so it never overwrites the full recap, and a short recap NEVER syncs to the Hub
dossier (dossier stays full-recap only). **Auto-recap chain**
(`coachAutoRecap: off|short|full`; per-session override `inherit|off|short|full`;
24h staleness `COACH_RECAP_FRESH_MS`; at most once per session) runs a `recap-step`
then optionally chains the coach turn, governed by a STOP/PROCEED taxonomy
(`classifyRecapChainFailure`): user cancel, route/account change, auth/credential/
setup failure, global quota, and transcript-acquisition failure STOP the chain
(question preserved in the composer); a recap-specific model failure or a feature
ceiling PROCEEDS to the coach turn with the older/no recap and honest fallback
copy. The implementation is a closed PROCEED allowlist (`ai_output_unusable`,
including Core's empty-output terminal, and `not_enough_history`); every new or
ambiguous error defaults to STOP. **Documented deviation from spec §5's letter:** `timed_out` and
`network_error` are classified STOP even though a *kernel recap-stream* stall would
by the letter PROCEED — those two codes cover BOTH Fansly-pagination failure and a
kernel-stream stall and the client cannot tell them apart, so the deliberate safe
direction is to never answer the coach question while silently pretending the
recap succeeded (`hub_quota_exceeded` is STOP for the same safe reason: a per-
feature ceiling is indistinguishable from global quota). **Storage schema is v15**
— see E45; not restated here. **Serialization guarantee:** coach transcript-cache
concurrency rests ENTIRELY on the background `lifecycle.reserve` single-op-per-tab
gate — a streaming coach turn holds the tab's only op slot, so two turns never
touch a session's cache at once; there is deliberately NO cache-level single-
flight. **Acceptance-fallback degradation:** after an SW restart (or 50-entry
op→ref eviction) the in-memory acceptance context is gone, so a coach accept/
dismiss enqueues with an EMPTY `pageLabel` (recovering it would cost a Hub round-
trip) — the kernel correlates the event by `generationRef`, which the coach feed
still carries, so the degraded pageLabel is acceptable. **Custom-name rule (spec
§4) held end to end:** the kernel-facing `clientContext.fanDisplayName` is account-
lookup only (username/displayName) and degrades to the neutral `"fan"` on lookup
failure — the chatter's private custom fan name (the DOM label) rides ONLY the
UI-facing display name and never reaches a prompt, on both the reply and compare
lanes (named guard tests in `tests/operations.test.ts`). Recorded in the same PR
that implements the feature (family law). Spec:
docs/superpowers/specs/2026-07-17-coach-chat-design.md; plan:
docs/superpowers/plans/2026-07-18-coach-chat-extension.md.

**E47 (2026-07-20).** Voice notes extension lane (phase 2 of the voice
effort; kernel half = core #15 / Decisions #174–#175). The extension gains a
dedicated `voice:*` port protocol — deliberately NOT `operation:*`, so paid
voice recovery is exempt from generic disconnect cleanup and transparent
`service_unavailable` retry. `voice-script` is panel-only and remains excluded
from insert/accept/compare surfaces via `isOperationFeatureType`.

The content attempt controller owns one `clientRequestId` per take. The free
script step must first resolve the Fansly fan account id; `scriptComplete`
returns that canonical id, and content freezes it as both `conversationRef`
and `pinnedConversationRef` in the versioned `storage.session` snapshot BEFORE
the paid create is posted. Group-id and unresolved-fan fallbacks are forbidden.
Boot/reconnect replays only the same frozen id and payload. Once a dispatch may
have occurred, a later replay rejection remains `needs-reconcile`; only the
kernel's durable `voice_quota_denied` record proves the id unbilled and burns
it. The recovery UI therefore says it restores the same approved request, not
that it performs a free status-only read.

Attach custody is bound to the exact clicked `voiceNoteId`. Background grants
only after comparing the current tab/account/group/fan/routeNonce tuple; token
single-use is enforced by the content adapter, not claimed as a background
consume protocol. The adapter also checks the real live pathname both at the
human click and immediately before the native file-input mutation, closing the
polling route-watcher gap. An uncertain handoff never auto-repeats; PPV and Send
remain manual in Fansly. The adapter uses the spike-proven DataTransfer/change
handoff with the Firefox page-context fallback. The студия and лента retain one
controller and the overlay collapses before Fansly's Upload modal opens.

The background streams audio under the 2 MiB cap and validates `audio/mpeg`,
MP3 structure, declared/actual length, and sha256 before bytes cross the port.
Audio remains memory-only behind revocable blob URLs. Attempt snapshots contain
the frozen script and refs but never audio; keys use `voiceAttemptV1:` and a
6-hour TTL. Expired-key deletion is lazy on the next store load, not an eager
timer. Firefox exposes `storage.session` to content with the area-wide
`TRUSTED_AND_UNTRUSTED_CONTEXTS` access level: this also makes the existing
spenders and quota session keys available to extension content contexts. Fansly
page JavaScript remains in a separate world without direct WebExtension API
access. This area-wide widening and lazy TTL are accepted for the pilot; no
`storage.local` schema migration is implied.

After an MV3 worker restart, persisted create/status recovery still works, but
the background's in-memory attach attestation is gone, so already-created takes
degrade to Download MP3 rather than weakening recipient checks. The Voice UI is
hidden unless the kernel capability hint is true, while the default-off kernel
kill switch and fail-closed allowlist remain authoritative for every paid call.

**E48 (2026-07-20).** The obsolete `docs/project-kernel/` archive is retired now
that the Project-Kernel migration is complete. Tombstone (family anti-deletion
law): the 17 superseded Pass-1 pre-migration maps (`00-overview` through
`15-tests-overview`, plus `boundaries.md`) and `pass3-migration.md` are deleted;
each is recoverable from Git and fully replaced by the point-in-time maps under
`docs/generated/`. The one living file, `prompt-1-map.md`, moves to
`docs/generated/REGENERATION-PROMPT.md` with its title and output paths updated.
Generated-map banners still cite the historical path and will self-correct on
the next regeneration; generated documentation is exempt from hand editing.

**E49 (2026-07-20).** Split-result presentation is one shared contract across
the expanded overlay, the default inline reply surface, and Compare tabs. Core
Decision #156 makes `preferSplit` a strict prompt request for 2–3 parts while
deliberately keeping provider output tolerant; consequently a completed
one-part result remains usable but carries an amber warning and an explicit
Regenerate suggestion on every surface. Two or more parts get neutral manual-
send guidance. Green is not used because it remains reserved for money.

`getSplitContractNote` owns the note semantics and
`getSplitPartCardOptions` owns the matching first-send/follow-up hints and
emphasis, preventing per-surface drift. Errors and empty results retain their
existing fail-closed surfaces, and output above the requested maximum is not
silently truncated. This is presentation-only: no storage migration, kernel
contract, parsing, automatic send, or retry behavior changes.

**E50 (2026-07-20).** Ping now sends the model the missing magnitude behind
its existing segment label: optional `clientContext.fanSilenceDays` is the
floored whole-day gap since the latest authored fan text. A later creator/model
message does not reset it, no fan text omits it, future timestamps clamp to
zero, and implausibly old timestamps clamp to the strict `20_000` wire ceiling.
The gap and `pingSegment` share one `Date.now()` sample so they cannot disagree
at a time boundary. This follows Core Decision #127; prompt assembly remains
kernel-only and the extension still performs only its existing live Fansly
read.

The SDK is regenerated, not hand-edited, from Core
`12a9515aa6b08b8d6b6f03cb815b1974f34d7f38` (contract
`692d858456403456f7045c76851b199b97b363e9915fa5411dfe4663e680bd52`).
Core must deploy first because older strict request schemas reject the new
field. No storage schema, automatic send, or retry behavior changes; the old
stranded implementation branch is archaeology and was not merged wholesale.

**E51 (2026-07-21).** Options may become a writer only after the MV3 background
worker confirms that the current storage snapshot is durably normalized. Storage
repair now treats credential custody as a layout invariant independent of
`schemaVersion`: either missing top-level Hub credential key, or either credential
still present in the `settings` blob, requires the background coordinator to run
a fenced full persist through `serializePersistedState`. Generic readers only
report that need and never persist a current-schema snapshot, so they cannot
overwrite newer custody values. Thus a current-v15 record whose older v12→v13
custody write never completed is still repaired; existing top-level values retain
precedence over stale blob values.

Options installs its future-schema observer first, then sends the internal
`ensureStorageReady` handshake before reading state, starting Fansly session
discovery, or rendering any editable control. The coordinator may normally expose
a read-only normalized state after an unobserved startup-listener probe, but this
durable barrier retries the deferred repair and throws while it remains
unproven. A failed or old worker produces a static reload screen and no settings
writer; the successful path preserves the existing synchronous pagehide
`storage.set`. Storage stays v15 because this repairs the v13 physical layout and
adds no logical field. The distinct mixed-version v16→v15 observer-delivery window
still follows E37's mandatory reload-on-extension-update rule; closing it without
a storage CAS would require moving all Options writes behind a background journal.

**E52 (2026-07-21).** Voice closes three pilot boundary gaps without changing
its paid-send or recipient policy. The free `voice-script` stream now shares the
repository's fail-closed terminal rule: provider exhaustion (`max_tokens` or
provider-equivalent `length`) and empty/whitespace output produce
`ai_output_unusable`, never `scriptComplete`. Its whole live-Fansly + kernel lane
has a 60-second wall-clock bound and an explicit chatter Cancel action.

Every recoverable attempt now freezes a credential-safe Hub source fingerprint
(normalized base URL + sha256 of the selected device-token/API-key bearer) and
the exact resolved `pageLabel` alongside the fan and generation refs. Paid
create, free status/audio reads, and attach grants require exact agreement with
that binding and the current Hub principal/page. `storage.session` therefore
moves to `voiceAttemptV2:`; source-less `voiceAttemptV1:` records are ephemeral
and deleted on load because they cannot be recovered safely. This is not a
`storage.local` settings-shape change and does not increment schema v15. An MV3
worker restart may still recover status/audio, but only after re-resolving the
same source and page; attachment continues to require its worker-memory route
attestation as established by E47.

The script/create/retrieval budgets are respectively 60s/30s/15s. A paid-create
timeout is intentionally ambiguous: content preserves the frozen idempotency
snapshot as `needs-reconcile` and never auto-mints or retries another paid take.
Status reads are single-flight per attempt/take, and their state reducer rejects
backward or terminal-resurrecting responses (with `completed → artifact_expired`
the deliberate expiry transition), so late reads cannot revoke valid completed
audio or restart polling.

Two product choices from the review remain unchanged. Voice intentionally may
use the live TabContext fan label, including a chatter custom name, as its
`clientContext.fanDisplayName` fallback when account-name enrichment is
unavailable; E46's stricter reply/compare rule is not extended to Voice. No
single-tab lease is added to an attempt: concurrent tab/content lifecycles are
an accepted pilot behavior, while source/page, fan, route, exact-take, and
explicit-human-attach guards remain authoritative.

**E53 (2026-07-22).** The Coach panel gets the layout/localization pass its
behavior spec (E46) never had (spec:
`docs/superpowers/specs/2026-07-21-coach-ui-layout.md`). It is presentation-plus-
plumbing only: **no storage migration** (§7 reuses the existing v15
`coachHistoryLimit`/`coachAutoRecap` fields), no vendor SDK change, and no new
out-of-band Fansly request. **Header/CSS:** the shared overlay shell is
untouched; the clay eyebrow «Коуч», the bare `@<fan>` title (feature name lives
in the eyebrow, no subtitle), and the header hairline are all scoped under
`.chatgoose-overlay-coach`, and the long-referenced-but-undefined
`--chatgoose-clay-soft` question-bubble token is finally added to both theme
blocks. **Topbar:** the three recap buttons collapse into one `role="menu"`
«Рекап ▾» (short/full refresh, «Обновить переписку», and the «Авто-рекап» radio
group mapped 1:1 to the per-session `inherit|off|short|full` override); Esc with
the menu open closes the MENU, not the overlay, and returns focus to the trigger.
**Draft attach (§5):** «Приложить мой недописанный ответ» holds an INTENT stored
next to `composerText`; the live Fansly draft is read ONCE immediately before the
`operation:start` dispatch (after any recap step) via
`getActiveConversationDraftText`, and only non-empty text is actually sent as the
already-contracted `draftText` (`includedDraft` means «sent», not «requested»).
The intent resets after every DISPATCHED attempt and is preserved when the chain
stops before dispatch (auto-recap STOP, route change, port-send failure); Retry
re-reads the CURRENT live draft rather than resenting a stale one. Core still
ignores `draftText` for coach today, so this must not ship enabled before the
core optional-draft PR lands (fail-honest); it accumulates for the 2.0 release
with the rest of the coach stack — no deploy. **Freshness (§8.4):** «Обновить
переписку» bumps a content-owned `transcriptEpoch` folded into the background
transcript-cache key, so the next turn is a guaranteed miss + full quick-window
reseed with no live read on click and no dependency on a live service worker.
**Turn context (§8.2):** the gateway already parsed the kernel's post-attach
`attachedRecaps`, but the operation callback discarded it; the coach
`operation:complete` message now carries an optional `turnContext` (kept-count,
coverage, attached-recap ages), retained on the exchange and rendered as the
collapsed «Отправлено коучу…» line. It follows E28's counts-only declassification
rule — a typed, numbers-only projection, never the raw meta payload — and an
absent field (old background) simply renders no line. **Settings (§7):** a
content-owned snapshot of the two v15 coach fields hydrates on open and refreshes
on the existing `settings:changed` path (stale-session guarded), positioning the
memory-window divider (§8.1, derived from feed exchange identities, not the
50-capped `completedExchanges.length`) and labelling «По настройке (<x>)».
Follow-up chips (§8.3) submit a canned question with normal semantics, leaving
unsent composer text untouched. Review round (2026-07-22, same PR): the
retry's live-draft re-read intent is carried on the recap-chain state and a
chain STOP re-arms the stored intent (a never-dispatched turn must not consume
it); follow-up chips anchor to the latest EXCHANGE, scanning past recap steps;
the settings snapshot hydrates under a monotonic generation, invalidated
BEFORE the first render on open and on settings:changed (a session-reference
guard cannot tell close/reopen apart); the `turnContext` validator enforces
exact keys and non-negative-integer counts at every level (it IS the E28
declassification boundary, and the background floors ages to match); the
intent toggle rebuilds the model so no later render repaints a stale checkbox;
the memory divider stays attached across renders (no per-frame detach/reinsert
churn); the coach age formatter is one shared module; and the regression tests
the UI rewrite had dropped (cross-fan insert guard, failed-insert inline
error, IME suppression, recap-picker keyboard/unknown states, fallback-note
render, «Новый диалог» blur/«Оставить» disarm and composer-text arming, the
composer input path) are restored. Review round 2: the draft-attach control is
built behind a SHIP-GATE constant (`COACH_DRAFT_ATTACH_ENABLED = false`,
`src/shared/coach-draft-gate.ts`) — §10.2's fail-honest rule is now enforced in
code, not just sequencing; the flip is one commit after core#22 merges. The
dispatch consumes the intent BEFORE the pre-dispatch render (no armed checkbox
on a streaming turn; restored on a failed send), the checkbox locks while the
composer is locked, every pre-dispatch exit of submitCoachQuestion re-arms a
Retry's re-read intent, and the transcript cache purges prior-epoch entries of
the same logical session so «Обновить переписку» cannot evict other sessions'
windows. Round 3: the send/cancel group right-aligns via its own auto margin
(space-between with the gated-off draft block's lone child parked «Отправить»
left); route-change and disconnect chain teardowns re-arm the retry intent like
every other pre-dispatch stop; a discarded coach view disposes its menu's
document-level outside-click listener; the background producer lane
(turnContext flooring/shape, epoch→reseed threading) is coordinator-tested.
Round 4: the snapshot also refreshes on 'mapping:changed' — an ordinary
settings write classifies as mapping:changed per storage-change-policy, and
the settings:changed-only guard left an open Coach showing a stale «По
настройке» label and divider; the test pins the classifier output and the
handler together. Round 5: the dispatch conjunct lives in
coachDraftAttachAllowed() so the UNMOCKED gate pin covers the dispatch site; a
settings change no longer nulls the shown snapshot (the round-2 invalidation
made the divider blink and shift scroll on every Options save — it now swaps
atomically on resolve, generation-guarded, with null-on-open retained);
«Обновить переписку» acknowledges the click with an info toast (state-only
semantics unchanged); the epoch purge ignores quickMessageCount so a
count-change between epochs cannot strand a dead LRU window. Round 6
(correction): the round-5 claim that the unmocked gate pin covers the dispatch
SITE was overstated — the orchestration suite mocks the module, so the dispatch
site is pinned by a source-text assertion beside the unmocked semantics pin,
and the render gate remains the load-bearing layer; menu arrow-navigation and
outside-click close are behaviour-tested; a THROWING port send gets the same
never-dispatched rollback as a false return; multi-draft acceptance attributes
the card's own index (nonzero-index pin restored). Round 7: the submit
preflight projects as busy the moment it starts and a rejected Send restores
the cleared composer text (the preflight window could silently eat typed
text); typing in the Fansly composer re-renders an open coach surface so the
draft checkbox tracks the live field; the «Рекап ▾» radios live in a labelled
role="group" (a bare div inside role="menu" is invalid ARIA); the menu-item
hover override matches the base button-hover specificity (the clay chip frame
no longer appears on borderless rows); the turn-context expansion carries the
provenance split (browser pre-budget vs kernel post-attach) instead of
restating the summary. Round 8: follow-up chips lock with the composer during
the submit preflight, and a rejected CANNED submit (chip, Retry) is never
written into the composer — the round-7 restore applies to composer-typed
questions only (a chip double-click used to inject its canned text into an
empty field). Round 9: the auto-recap chain CARRIES the question's origin, so
a post-recap resubmit failure restores the chatter's own text (round 8 had
mislabeled chain resubmits as canned — three rejection paths silently ate the
typed question); the preflight admission guard is per-session like the busy
projection (another fan's coach both looks usable AND is usable; the
post-await re-check covers the cross-session dispatch race), and the lock is
set inside the try whose finally resets it, so a throwing render cannot strand
the coach rejecting every future question. Round 10: the finally clears only
its OWN lock (an overlapping second-session preflight legitimately takes it —
finishing A must not unlock a still-running B); the settings snapshot also
rehydrates on 'tab:state' (a reconnect replay — a settings change made while
the port was down had no event to carry it; the generation-guarded atomic swap
makes an unchanged re-read a no-op); the chain STOP/teardown restores gate on
the held question's origin too, so a chip-started chain STOP never parks
canned text in the composer; the divider-skipping cursor walk is pinned for
the append-new-exchange path. Round 11: the question's origin rides the
DISPATCHED attempt too (CoachAttempt.fromComposer), so the route-change and
disconnect teardowns no longer park a canned chip/Retry string in the
composer; the epoch purge's safety property — never evicting OTHER sessions —
is pinned across all four identity conjuncts (other sessions stay cache-hits). Round 12: the preflight lock is a Map of per-call
tokens (a single pointer misbehaved under overlapping preflights in either
completion order — each finally releases only its own token); `turnContext
.attachedRecaps` is OPTIONAL end-to-end, so a kernel that did not report the
attach renders «рекап: нет данных» instead of a confirmed «нет» (the E43
honest-empty-state rule this file already applies to the status line); the
empty-state hint chips lock with the composer during the submit preflight.
Round 13: Tab out of the open «Рекап ▾» menu dismisses it without stealing
focus back (WAI-ARIA menu-button); the pre-dispatch abort (restore + re-arm +
re-render) is one helper instead of ten hand-copies in three spellings.
Round 14: PortClient.send maps a throwing postMessage (dead port whose
disconnect has not landed yet) to its documented false return AT THE SOURCE —
every dispatch site, including the recap-chain start that used to leak the
exception into a menu click handler, now takes its own never-dispatched
rollback; the producer's «kernel did not report attachedRecaps» branch is
coordinator-pinned. Round 15: «Новый диалог» is refused during the submit
preflight AND the submit aborts on a rotated sessionId (a raced reset must
never receive the discarded dialog's question); a model-side restore lands in
an empty focused textarea (the caret guard only protects non-empty fields —
after a rejected Send the restore was invisible until blur); the PortClient
throw→false mapping is pinned at its own level. All coach-OWNED copy is now Russian; the shared
`toUserError` map, toolbar label, Options, and popup are deliberately excluded
until the extension-wide localization pass.
