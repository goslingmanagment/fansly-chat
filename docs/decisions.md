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
| E25 | 2026-07-11 | Board rows show the chatter's custom fan names (Fansly rename = account note contentType 12002; batched /account?ids= overlay, best-effort); chatter-eyes-only — never into prompts; boundary superseded by E115 |
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
| E54 | 2026-07-23 | Voice paid-attempt custody moves behind an acknowledged background `storage.session` RPC; supersedes E47's Firefox content-access premise |
| E55 | 2026-07-24 | Confirmed Voice attach completes the active session; explicit new-from-draft flow protects paid work |
| E56 | 2026-07-24 | Voice player uses decoded complete-buffer duration, persistent keyed media nodes, and explicit hidden-media suspension |
| E57 | 2026-07-24 | Kernel provider failures get exact Russian cause cards; unknown provider codes retain E38 fallback, truncation gets a dedicated fail-closed card |
| E58 | 2026-07-24 | Error registry cleanup: replay-only tombstones, producer-consistency gate, one lossless renderer, Russian chatter copy |
| E59 | 2026-07-25 | Options 2.0 «Кабинет» frame: hash-routed panes built once and hidden (never re-mounted), a Russian COPY dictionary, locally bundled family fonts; new page state goes into operational storage.local keys — the settings blob stays v15 — and the changelog stays a web page. **Amended (wave B):** the hero health strip is dismantled into «Статус» rows; readiness aggregates ACTIONABLE prerequisites only; «Проверить всё» never touches getSessionsSnapshot; the support report is secret-free by construction; the Контракт line is debug-only in «Статус» and always visible in Hub diagnostics; every device-token custody mutation runs under one auth FIFO. **Amended (wave C):** account presence + local labels are two more operational keys (v16 migration cancelled) — presence uses a leading write with 30s coalescing and a second hook after identity resolution, labels are written only by `setAccountLabel`, and `rekeyAccountIdentity` carries both onto the canonical id; `getAccountsView` reports live/seen/never plus an unattributed-tabs aggregate and never re-attributes a tab after a worker restart; an archived mapping counts as unmapped; a confirmed-empty persona catalog now stamps `fetchedAt`; «Хоткеи» is a drift-proof read-only cheatsheet (which enables the full rail) and «Вид» is three preview cards on the existing save path. **Amended (wave D):** the first-run checklist is gated by a DURABLE `chatgoose:onboarding` flag (never live form state) with host access ordered BEFORE sign-in; `chatgoose:lastSeenVersion` drives a «нов.» dot on a rail link to the WEB changelog, pinned to `deploy.sh`'s `BASE_URL` and deliberately anchor-less until the E42 page is deployed; error surfaces deep-link through one `openOptions` operation that re-points the SINGLE options tab (never a second settings writer), routed by registry code, and the page explains the code from the registry and highlights its row once that row exists. **Amended (post-campaign):** the device-token metadata is custody-grade — token + `issuedFrom` commit in ONE `storage.set`, and a revoke 401/403 with no readable metadata reports `unreachable`, never `already-invalid`; a custody-key change on disk is applied by EVERY open options tab (a dirty legacy-key input keeps only its text); the async Hub diagnostics rows declare `data-deeplink-ready` like the accounts table; local «Статус» availability is derived from settlement AND parse validity (a fulfilled `undefined` is «недоступно», a genuinely empty reply is not); a failed Fansly read reaches the support report instead of a zero-account claim. **Amended (post-campaign round 2):** the fence runs from the state of EVERY applied read (never a per-event flag the generation guard can discard) and invalidates this tab's pending credential write, while skipping the hub-check chain owned by this page's own custody RPC; the honest-outcome rule keys on the recorded issuing ADDRESS (`!meta.issuedFrom`), `alsoWrite` throws on a key the same write owns, `unavailable.fansly` starts TRUE, and the fence re-renders the sign-in meta line |
| E60 | 2026-07-26 | Cabinet frame R3: the shell fills the window — no width clamp on `<body>` — with a sticky rail that owns one viewport and a reading column capped at 1120px on the pane itself; the page root's permanent 24px bottom padding moves into that pane. Supersedes the 900px ribbon chosen when #46 was reverted (owner ruling on the R3 mockups, 2026-07-26). Narrow windows collapse the rail (BL-003 п.1), disabled controls finally look disabled, and the save whisper speaks Russian |
| E61 | 2026-07-26 | «Статус» and Agency Hub speak in WORDS: the mono badge column goes (it ran six vocabularies at once and its «—» meant four different things) and every row is dot · fixed label · fact · one right cell holding a detail OR an action. Each pane gets a HEAD (title, subline, its primary action) above cards that carry content only; «Статус» adds «Что мешает» — the open readiness steps with the button that closes each — plus a support card (version, storage schema, report) and cross-pane pointers. Hub loses its duplicated facts (host access and the check receipt were stated twice), gains the «Ядро» row it never had, un-nests its zones into four cards in two columns, fences «Выйти» inside the sign-in card, and stops printing a raw error code in a pill. **Amended (review fixes):** the `host-access` deep-link anchor covers the fact AND «Разрешить доступ» (the claim was false — the button sat in a sibling action row); `renderOnboarding` is the single writer of «Что мешает» too, not only of the hero (a fresh install listed the same three steps twice); «Проверить всё» and «Скопировать отчёт» get one live region each; the pane head wraps at ~320px, the <640px diagnostics row drops the 46px column of the deleted badge, and `.chatgoose-hub-srow` gets the author `[hidden]` guard its `display: grid` needs |
| E62 | 2026-07-26 | The five remaining panes: «Персоны» name the accounts sitting on each persona (the map was in memory, only its size was printed) and repaint when a mapping changes; «Аккаунты» group rows by state with a caption + count each, so the per-row «в работе» pill goes; «Генерация» splits into two card columns with a fixed numeric lane, bounds from the shared constants and a step that matches the range (the deep window stepped by 1 across 100–3000), and the clamp notice becomes its own chip instead of eating the range hint; «Хоткеи» give each group its own column and let names wrap, with the detected platform stated in the head; «Вид» previews the IN-CHAT panel the subtitle promises, says what «Системная» resolves to right now, and labels its radio group. **Amended (review fixes):** the numeric lane gets its own class (as a second bare `.chatgoose-row-control` rule it clipped the auto-recap segment's «Полный»); the degraded accounts path carries an explicit 'unknown' state so no row contradicts its group caption; the «Системная» note is computed from the OS scheme, never from the document's resolved class; the catalog source shows the WHOLE normalized base URL (two hubs on one host collapsed into one line); `chatgoose-account-rows` names one element again; dead CSS/copy deleted, and the weakened persona-catalog test is a node-identity guarantee again |
| E66 | 2026-07-31 | Voice concurrency: exact script-run identity; background per-attempt revision/CAS for save/remove; hidden recovered paid work joins the new-session warning; quota-denied replay remains indeterminate |
| E67 | 2026-07-31 | R4 polish, owner-approved pane by pane from «было/стало» mockups. A fact is stated ONCE per screen (the live-check receipt, a persona's account count, an unnamed account's id, the «сессий не было» caption), a control exists only while it has something to do («Переподключить» on a granted permission, «Выпущен» with no provenance, the second line of a row with nothing left to say), the hub's columns are re-cut hub-left / me-right with «Проверить связь» in the card head, and two CSS defects are fixed: the counter field's 62px never applied (a `.chatgoose-row .chatgoose-input` rule outranks it) and the stepper shrank to a clipped «+» (`overflow: hidden` zeroes its min-content contribution). «Хоткеи» deliberately untouched — the 8/4/2 columns stay E62's call |
| E68 | 2026-07-31 | The Spenders board header names WHICH feed stopped: `feedStateLabel` maps each `SpendersStreamState` to its own line («not updating: …» — projection off in the Hub / page not in the Hub allowlist / unsupported platform), replacing the catch-all «source paused» that collapsed all three into one unactionable phrase. Reading is never gated — rows keep showing, they just stop being refreshed |
| E69 | 2026-07-31 | The «Статус» Spenders row states a STOPPED FEED, not a refused access, and names the page + the age of the data; `pageLabel` rides `SpendersListResult`, the two observation fields are optional and read with `typeof` |
| E70 | 2026-07-31 | Deleted fans look deleted: kernel `entries[].deletedAt` (optional in the contract, compared with `!= null` everywhere) labels the row «deleted account» + a muted «deleted» chip and drops those ids from the Fansly name SWEEP — but not from the durable name cache, so a chatter's rename survives. The conversation outlives the account: a known `groupId` opens, a deleted fan who kept a name still gets the inbox search, and only an unsearchable row returns early; the spend always stays in the ranking. Session cache key → `spendersCacheV4`; the port guard now validates `deletedAt` (absent = alive) and the `pageLabel` E69 left unchecked |
| E71 | 2026-08-01 | The action bar drops the persona pill and tightens its density: 716px of content on a ~605px composer was scrolling Reply — the primary action — off the left edge. The persona NAME moves to Reply’s own tooltip, «Unmapped» defers to the mapping banner already open under the bar, and only the one state with no other surface («no Fansly account detected») keeps a chip. Gap 6→5, side padding 10→8, button padding 11→9, tone segment 30→27: measured 716 → 597px |
| E72 | 2026-08-01 | Recap's ready dot moves to a corner badge, freeing the 9px reserve that made it the row's widest chip with an off-centre label; width stays state-independent so the dot never reflows the bar (E27's rule). Second density pass — gap 5→4, button padding 9→8, tone segment 27→24 with padding 5→4, groove gap 2→1, seam margins dropped: measured 594 → 542px, headroom on the ~605px composer 8px → ~63px. Split stays labelled (icon-only was measured at −34px and declined, E24) |
| E73 | 2026-08-01 | Split moves into the Reply options capsule as a fifth cell behind a seam, loses its word, gains ⌘⇧L: `supportsReplyMode` is true for `fast-reply` alone, so it is an option, not an action (amends E24). A checkbox among radios is kept legible by FORM — armed tone rises, armed Split is pressed in — and the capsule is a plain container so the `radiogroup` role can stay on the inner track. 542 → 507px, though the icon-only variant measured 509px, so structure decided it, not pixels. Losing the word forced real hover hints for the whole bar, replacing the native `title`: rendered outside the `overflow-x: auto` bar, hover hit-tested on the container so DISABLED controls still explain themselves |
| E74 | 2026-08-01 | Owner feedback on E73: first hover dwell rises 400→1000ms and within-group swaps use a 250ms dwell (300ms grace), so crossing the row does not fire hints. Storage v16 adds default-on `showToolbarHints` under «Вид»; off suppresses pointer/focus bubbles live, immediately closes/cancels one in flight, and leaves accessible names + hotkeys intact |
| E75 | 2026-08-01 | Performance by work elision: two-stage Fansly bootstrap + isolated MV3 keepalive, narrow storage reads, incremental rendering/Voice dedupe, safe minification |
| E76 | 2026-08-01 | Action bar restores direct Help, Review, and Compare buttons; cached Compare gets contextual Reopen |
| E77 | 2026-08-01 | Help coaching and Review evaluation render the kernel #201 block labels as structured sections (display-only parser, plain-card fallback) |
| E78 | 2026-08-01 | The recap (fan-summary) joins the E77 analysis language: known section headings become dotted mono headers, strategy/next-move gets the clay card, money/quote decoration shared; unknown headings keep the old look |
| E79 | 2026-08-02 | Help routes into Coach as the kernel-owned `situation` preset: one-click analysis keeps follow-ups, real-question history, structured advice, and two positional draft captions; standalone help-me stays for cached and older-client results |
| E80 | 2026-08-02 | The Help button leaves the toolbar (owner ruling, supersedes E79's button-stays default and E76's Help restoration): Help's home is INSIDE Coach — a clay preset chip in the empty state and leading the follow-up row; hotkey H stays as the fast path |
| E81 | 2026-08-02 | Coach waits become narrated (stage progress + elapsed counter in the pending bubble), debugMode gains coach surfaces (live stage log, timings/tokens footer, per-turn «Промпт» opener, failure log), analysis headers unify on the recap treatment, and coach answers with model markdown render as structural blocks |
| E82 | 2026-08-02 | Full and short Recap remain independent end-to-end: exact two-slot UI availability + two completed-surface slots; either lights the ready dot, Refresh preserves size, and short remains excluded only from the single full Hub dossier |
| E83 | 2026-08-03 | The completed Review re-voices as the recap document (revises E77/E78's working-card split for Review only): evaluation + recommendations share one serif stream frame, numbered items become document entries; the «Как надо было» parser accepts a parenthetical placement note and shows it in the card label |
| E84 | 2026-09-06 | Release audit: cancellation fences post-stream finalization and queued recap writes; paid Voice rechecks the live recipient after custody acknowledgement; inline async feedback retains its originating operation and yields keyboard ownership to reference surfaces; Cabinet write failures remain visible and retryable |
| E85 | 2026-09-06 | Re-vendor the complete generated SDK from proven production Core 7fac98f310d6 for the 2.0 release gate; contract hash 46f7a01e6b6339c302b16cf4c592dd95199ee5ed2337536c11156d4154859fcc |
| E86 | 2026-09-06 | Prepare local 2.0.0 candidate metadata and current user documentation; candidate labels distinguish it from the published 1.9.11 feed; publication remains a separate step |
| E90 | 2026-09-07 | Add the implemented Hub prompt rework to the 2.0 walkthrough and changelogs, explicitly pending Hub rollout; distinguish it from the September 6 research and already-deployed Help/Review changes |
| E91 | 2026-09-07 | Proposed fan messages are always English; analysis keeps its own audience language. Hub prompts pending rollout; targeted client Cyrillic guard and separate Review commentary preserve original text |
| E92 | 2026-09-07 | One release journey: versionless ChatGoose landing, fixed 2.0 walkthrough, guide and version archive; links in Settings/popup, source-verified optimizations, walkthrough published before new extension entry points |
| E93 | 2026-09-07 | The 2.0 walkthrough leads with Voice and a three-step interactive reference; feature parameters and expandable technical notes add source-verified detail without changing release readiness |
| E94 | 2026-09-07 | Rewrite the 2.0 walkthrough in conversational Russian around chatter situations; preserve Voice-first order, technical parameters, readiness and all page behavior |
| E95 | 2026-09-07 | Restore the main landing's full product story: everyday writing, context and analysis, Spenders, then one compact 2.0 chapter; responsive writing examples replace the main Coach demo |
| E96 | 2026-09-07 | Give 2.0 more presence alongside the full product: early announcement, a Voice-led release chapter after writing, and illustrated Coach/Recap stories before the remaining core sections |
| E118 | 2026-09-14 | New-follower debug runs: scoped HTTP and decision timeline, extension-only viewer, bounded memory and full text export |
| E119 | 2026-09-14 | Minor release 2.3.0 authorized after independent review, larger diagnostic retention and 700-follower coverage; Telegram announcement deferred |
| E120 | 2026-09-14 | Owner corrects release numbering to patch 2.2.1; withdraw 2.3.0 from update discovery, preserve the complete logger and release history |
| E121 | 2026-09-14 | Creator-wide follower GET pacing and cooldown, human pause/resume, cached proof and lazy conversation preview with clearer progress |
| E122 | 2026-09-14 | Release E121 as 2.2.2 after independent adversarial review; retain the owner's corrected small-release numbering and skip Telegram |
| E123 | 2026-09-15 | One login and password for every client; legacy chatter key retired end to end (storage v17); named-401 self-healing; «Как начать» page; 2.4.0 |
| E124 | 2026-09-15 | Storage readiness waits for event acknowledgements with a one-second deadline instead of counting timer turns; missing acknowledgements still block Settings |

| E125 | 2026-09-15 | Signed-out Settings, popup and chat banner lead with sign-in; stale old-credential failures cannot invalidate the new sign-in view |
| E126 | 2026-09-16 | Re-vendor SDK 0.3.0 from the exact deployed Core identity release before publishing 2.4.1 |
| E127 | 2026-09-16 | Release 2.4.1 packages storage readiness and sign-in-first fixes, preserves settings and credentials, and uses the production-matched SDK |
| E128 | 2026-09-19 | Follower scan: saved-name reads leave the critical path, rate-limit penalty decays per five quiet minutes followed by twenty answered reads, `/account` reads 5 s apart; patch 2.4.2 |
| E129 | 2026-09-19 | Re-vendor the SDK from deployed Core `b1d3bb81` before publishing 2.4.2; the release gate stopped the first attempt before signing |
| E130 | 2026-09-20 | Fansly pacer replaces the follower read scheduler: policy per route family, learned spacing per key, 400 ms jittered lane gap, a limit slows its own key first, limits survive the background page; transient 404 rows rechecked once; unreleased until a live trace |
| E131 | 2026-09-20 | Owner releases E130 as 2.4.3 without the temporary-load trace; the first production scans are the live measurement, the feed is the rollback |
| E132 | 2026-09-20 | Re-vendor the SDK from Core `301a127a` (Core Decision 376, in-core Workboard v2 removed); merge only once production serves contractHash `42c705b8…` |
| E133 | 2026-09-20 | Pacer safety patch after two reviews and the first production trace: jitter on the binding deadline, a first limit widens the lane, FBuddy-grade cooldown, success only for a validated envelope, narrow delayed recheck with a fuse, writes refused under a cooldown, upward probing deleted |
| E134 | 2026-09-20 | New followers: an inbox listing or search miss is never «не писали»; the chat is resolved by identity (`POST /group`) at an explicit human action, never during a scan; saved fan → chat id; a blocked send is an error the chatter sees; text search demoted to a budgeted background hint |
| E135 | 2026-09-20 | Release E133 + E134 as 2.4.4 in one release on the owner's word, on the SDK re-vendored in E132; no live measurement yet, trace counters added for every unverified assumption |
| E136 | 2026-09-20 | Unified Hi greeting: one `hi-greeting` contract (`variantCount`, `personalMessageCount`) for the chat button and the New Followers window, one greeting-context module, one shared welcome-definitions service; the gate counts personal messages; needs Core Decision 379 deployed first; unreleased |
| E137 | 2026-09-20 | Release E136 as 2.4.5 on the owner's word, after Core Decision 379 (core `82571f3c`) is deployed, on the SDK re-vendored from that deployed commit; no independent review, validation synthetic plus a before/after prompt render |
| E138 | 2026-09-22 | New followers: fast positive-proof pass followed by one automatic identity/history queue for unresolved rows; group POST joins the creator lane, soft pause preserves an in-flight result, selected fan is next; no unverified sends, no release |
| E139 | 2026-09-22 | Owner authorizes release 2.4.6 for E138 after independent code review; package, manifest and release pages advance together; no Telegram announcement; live Fansly performance remains unmeasured |
| E140 | 2026-09-26 | Re-vendor the SDK from deployed Core `a51e687d` (Core Decision 381 alert digest kind + H3 events v2 platform filter, frame provenance, money facts route); production already serves `21a767b8…`, merge at once, no version bump, ships with the next release |
| E141 | 2026-09-27 | One hotkey scheme for the extension and the OnlyFans desktop app, vendored from the hub (`@chatgoose/hotkeys`): text actions ⌘/Ctrl + E I G P ., panels ⌘⇧ / Ctrl+Alt + H S O B L M C, physical-key matching, fresh-press roll-over guard; replaces ⌘⇧ / Alt+Shift; prepared as 2.5.0, not deployed |
| E142 | 2026-09-27 | Split on Fix: the same sticky Split flag now also sends `preferSplit` with Fix (Core #268 prompt); a Split result opens in the inline panel with an Insert per part, pinned to its draft so inserting or sending part 1 keeps the rest and Regenerate reruns that draft; one part still auto-inserts; not released |
| E143 | 2026-09-28 | Re-vendor the SDK from deployed Core `89134bb2` (core #267, OFAPI desktop media: `ofapiMediaResolve`, `ofapiMediaReports`, collection registry); production serves `abf87a65…`; the extension uses no OFAPI operation; unblocks the 2.5.1 release gate, no version bump |
| E144 | 2026-09-28 | AI image notes: the kernel transcript numbers the kept window's describable media (`[Photo #n]`, ` [Photo #n]` after a bundle label, ` (preview #n)` after a PPV label) and `clientContext.media` lists them by id (groupRef, message, sender, kind, accountMedia id, paid) — never a URL or bytes; label-like text in messages is neutralized; the hub restores plain labels while its describer is off; 2.6.0 |
| E145 | 2026-09-28 | Incoming-message sound (desktop parity): a MAIN-world `document_start` tap listens passively on Fansly's OWN wsv3 socket (Proxy over `window.WebSocket`, native object, no send/frame of ours), a text-free projection crosses an isolated relay, the background decides (own/automated/tip/stale 180 s/muted/open chat/2 s throttle) and plays a synthesized blip; settings v18 with a per-model mute list; no hub, no Fansly request, no new permission; 2.7.0 |
| E146 | 2026-09-28 | New-follower sound on the E145 path: the tap also forwards FollowerService (`serviceId 3`) `type 2` follows (`{id, accountId, followerId}`, no createdAt), the background rings a follow of one of our models (`accountId` ours, `followerId` not) with its own switch and tone (`double`), shared volume, throttle and player, per-model mute on the model the event names; five Fansly tones (message default `chime`, the OnlyFans `blip` a choice; a v18 `blip` re-defaulted); settings v19; 2.7.1 |
| E147 | 2026-10-11 | `scripts/setup-vps-ext.sh` is removed (the owner chose removal over repair): nothing in the repository creates or rewrites the nginx site of `ext.gosling-agency.ru`. The script had not run since 2026-03-24; its templates lacked what the live file had gained (the desktop feed's `/u/`, the latest-XPI no-cache rule), and its edit of the Hub's nginx site looked for markers that site does not carry, so a run against agency-de would have erased those locations and written a second `location ^~ /ext/` into the Hub's site. README «The site on the server» holds where the file lives, what the deploy scripts need from it, who else it serves and a dated copy. The same day, on the owner's request, the site's latest-XPI no-cache rule was pointed at `chatgoose-latest.xpi` on both servers |
| E148 | 2026-10-11 | Upload-host probe: before `web-ext sign` and before either page upload, the deploy scripts write a one-off marker into `REMOTE_DIR` over SSH, read it back through `BASE_URL` and remove it; the run goes on only if the marker comes back, otherwise it stops and says whether another server answers for the public name, the site refuses, or the name gave no answer; passes under a DNS switch and under forwarding; no skip flag |
| E149 | 2026-10-11 | «Fansly через вкладку» (opt-in, settings v20): every FanslyClient request rides a hidden extension frame inside a Fansly tab of the same session, so Multi-Account Containers' proxy carries it instead of the chatter's own line; no new permission, no proxy password, per-model route; session capture skips the frame; `fansly_tab_unavailable`; a send checks the route before custody; a failed follower scan no longer reads «Новых фоловеров нет»; 2.7.2 |
| E150 | 2026-10-11 | Re-vendor the SDK from deployed Core `2260ef73` (core #552); production serves `b9d4dd07…` and still lists the old `b95b765c…` in `compatibleClientSdks`, but the deploy gate compares `contractHash` exactly; SDK 0.4.0, no source change; unblocks the 2.7.2 release gate, no version bump |
| E151 | 2026-10-11 | The five public pages wear the agency identity (source: `~/code/1-platform/agency-site`): ChatGoose logo with the gosling, pond and yellow instead of terracotta, Literata + Golos Text, flat outlined mocks, one header and footer on every page; slogan headings rewritten as plain descriptions of what a tool does. Still single files: no new assets, `mascot.png` is the new badge. |
| E152 | 2026-10-11 | «Регистрация» in Fansly's chat header: a click shows when the fan registered (date and age), decoded from the fan's account id (a snowflake), never fetched; the id is free after a generation in the chat and one attempt of `GET /group/<id>` otherwise (no retries, nothing during a rate-limit cooldown), hence a click and not a read on every opened chat; mounted into Fansly's `.content-header-sub-row` after Gallery, selectors read from Fansly's bundle and not yet seen on a live session; one-to-one chats only; 2.8.0 |
| E154 | 2026-10-11 | The public pages lead to the common ChatGoose home: the header logo of all five links to `../` (it was the top of the landing on `install.html` and the landing on the other four), and `start.html` links to the desktop page as `../desktop/` instead of `https://ext.gosling-agency.ru/desktop/`. Relative, because the pages are read at `chatgoose.gosling-agency.ru/fansly/`, one level below the home (the site is `~/code/1-platform/agency-site`'s); the XPI link stays on `ext.`. Footer logo, texts, deploy scripts and tests untouched; no release. E153 is the icon change (PR #147), open when this was written |
| E155 | 2026-10-12 | «Новые»: a fan Fansly will not let the model DM (paid DM, unmet DM rules) is `closed`, «Нельзя написать» with the reason, read with Fansly's own `verifyNew` over the chat's `dmPermissionFlags`; nothing is generated, reserved or sent. «Исключить из очереди» on such a row only, remembered in this browser, dropped when the DMs open. A refused Hub reservation names the custody state instead of «Другой чаттер…». 2.8.1 |
| E156 | 2026-10-12 | Re-vendor the SDK from deployed Core `6ee3d627` (core #567): production answers `03012453…` after core #563 added `GET /api/v1/ops/live`; the deploy gate compares `contractHash` exactly; no source change; unblocks the 2.8.1 release gate, no version bump |
| E157 | 2026-10-12 | Fan notes panel: the fan's native Fansly notes (12000) and custom name (12002) in a ChatGoose panel — «Заметки» in the header row after «Регистрация» and ⌘⇧K / Ctrl+Alt+K (hub hotkey scheme 2, client `fansly`: this extension only). Views «Всегда справа» (docked in Fansly's empty right column, reads each opened chat after 0.7 s), «Справа по кнопке» (default) and «Окно по центру» (read on open); setting `fanNotesView`, storage v21. Reads: group (once per chat) + `/account?ids=`; writes: Fansly's own `POST /notes`, `/notes/edit`, `/notes/delete`; one attempt each, nothing during a cooldown. «+ По шаблону» = the agency questionnaire. Never in a prompt |
| E158 | 2026-10-12 | Release 2.9.0 = E157 (fan notes panel). The owner ordered the release («да выпускай канеш и релиз») without a number; 2.9.0 because it is a feature, as 2.8.0 was. Vendored SDK equals production (`03012453…`); hotkeys from hub `0a96105d` in all three clients. No new permission |
| E159 | 2026-10-12 | «✨ Заполнить из чата» in the notes editor: the kernel feature `fan-notes-fill` (Core, Sonnet 5.5 by default) fills a questionnaire (`Label: value` lines) from the whole chat, read like a full Recap (deep window, spending, subscription), no 30-message minimum. Only the labels travel (`noteFields`); empty fields are filled, a filled field is never overwritten — a different answer is offered as «было → станет». Nothing is saved until the chatter saves. Rides the tab's one operation; routed to the panel, not the overlay |
| E160 | 2026-10-12 | Release 2.10.0 = E159 (AI fill of the notes questionnaire). Core `fan-notes-fill` deployed first (Core `a3449f77`, #572, contract `a6f77fbb…`; Core keeps serving the SDK of 2.8.1/2.9.0, `030124…`), then the SDK re-vendored from the deployed commit. Version by the 2.9.0 rule (a feature), the owner ordered the chain |
| E161 | 2026-10-12 | 2.10.0 was signed by AMO but never served: the session running `deploy.sh` ended while it waited for the approval, before the upload, the feed and the tag. AMO versions are single-use and the script has no resume path, so the same build ships as 2.10.1 through the ordinary `deploy.sh`; the changelog names 2.10.1 only. No code change |
| E162 | 2026-10-13 | Chrome DevTools MCP по умолчанию для Fansly; карта исходников и общий справочник с chat-extension (X38), бандл и исследования; правило проверено в новой сессии Claude |
| E163 | 2026-10-13 | AGENTS.md — единственный файл правил; CLAUDE.md перенесён без потери инструкций, актуальные ссылки обновлены |
| E164 | 2026-10-13 | «✨ Заполнить из чата» merges instead of overwriting (release A, extension half): the questionnaire's values travel to Core (`noteValues`, merge mode on every fill; a narrowing of E157/E159 — the custom name and other notes still never travel), the template gains «График», «Планы и даты», «Другое», new lines and up to five AI-named fields (with «В Другое») go straight into the draft, rewrites stay «было → станет», a fact that cannot get a line goes into «Другое»; the fill's transcript carries day lines; each fact shows the fan's quote, dated by the background from the transcript it sent («не нашлось в переписке» otherwise), never saved. SDK vendored from Core `2ac5d541` for development |
| E165 | 2026-10-13 | Release 2.11.0 = E164 (the notes fill merges and shows its sources). The owner ordered the chain («мержи и выкатывай все») and chose to deploy the whole Core `main`: #593 merged as `bc0f6dbc` and deployed dist-only to agency-de together with 23 commits of other work merged since `a3449f77` (Project Browser, R20 HF; six migrations, 0270–0275, all dormant by their own PRs). Contract `663d132f…`; Core now registers the 2.10.1 SDK (`a6f77fbb…`) and keeps serving it. SDK re-vendored from the deployed commit. Version by the 2.9.0 rule (a feature) |
| E166 | 2026-10-13 | The notes panel reshaped after the owner's look at 2.11.0 on a live fan («элементы жирные», «сплошной текст нечитаем»): a questionnaire reads as a table (the label, its facts one per line, the month apart, empty fields folded) and is edited as fields, the one text kept under «Текстом»; the fill's rewrite sits under its field as the facts it adds or drops; the custom name is the panel's title, edited in place; a one-row footer; «✨ Заполнить из чата» becomes «✨ Дополнить из чата» and also starts from the note being read. The note's text, the Core contract and what travels to Core are unchanged. Core's half (hub #601) is which field a fact goes to; the owner kept the length of what the AI writes |
| E167 | 2026-10-14 | Release 2.12.0 = E166 (the notes panel as fields) with Core's half, hub #601 (one fact in one field, «Характеристика» is who the fan is, purchases in «Медиа» only). The owner ordered the chain («давай делай») and, asked about the scope, chose to deploy that change alone: production's commit `bc0f6dbc` plus #601 as the side commit `c2b1843c5eaa`, because Core `main` had ten commits of other work, a migration and a new contract hash that nobody on this release had checked. Contract `663d132f…` unchanged, no SDK re-vendor. Version by the 2.9.0 rule (a feature) |
| E168 | 2026-10-15 | The transcript every generation sends is in UTC (`[HH:MM]` and `--- YYYY-MM-DD ---` day lines), never the chatter's clock; day lines for every kernel-bound feature, not the notes fill alone (E164). Matches the hub's own transcript (hub #622). Every request says so (`clientContext.transcriptClock: 'utc'`, the owner's choice), so Core's `Now:` line calls it UTC; SDK vendored from Core `5b7eb095` for development. Not released |
| E169 | 2026-10-16 | Release 2.12.1 = E168 (the transcript in UTC with day lines, `transcriptClock: 'utc'`). Core's half (hub #622, #628) reached production with hub #643 (`305f4e18`, deployed 2026-10-15 23:17 UTC, contract `d4e21741…`); SDK re-vendored from that commit, replacing the development vendor of `5b7eb095`. A patch: the AI reads the chat's time right, nothing new for the chatter (E120) |
| E170 | 2026-10-17 | A note edit is confirmed the way Fansly's own modal confirms it: `success: true`, with whatever the answer carries (an id, a type or a fan it names must be this note's; its title and text win, else the ones sent). E157 asked for the whole note back, so an edit that landed in Fansly read «Не сохранено: CG-FAN-03» (ari-1, 2026-10-16, proved by the hub's next read of the fan). A note write's failure now shows its answer's shape (status, `success`, the keys of `response` with their types, never a text) after the error; the double period in that line is gone. A create stays strict. Not released |

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
**Boundary superseded by E115 (2026-09-11):** the saved name now DOES reach
the kernel, through its own `clientContext.fanCustomName` field, never through
`fanDisplayName` or the DOM label; the ping prompt owns the "name part only"
rule for tag-like labels.
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
unsent composer text untouched. Hardened through sixteen adversarial review rounds on PR #24 (claude +
codex, blind, with per-finding verification); the round-by-round record —
what each round found, what was fixed, and which findings were refuted —
lives in the published review reports on the PR, not here. The durable
rules that emerged: canned text (chips, Retry, chain resubmits) is never
written into the composer and every never-dispatched path restores a
composer-typed question and re-arms a Retry's re-read intent; the submit
preflight is a busy state locking composer, chips, hints and menu, keyed
per-session by token; «Новый диалог» is refused during a preflight and a
rotated sessionId aborts the raced submit; the draft-attach control ships
behind COACH_DRAFT_ATTACH_ENABLED (flip = one commit after core#22, with
its pin test); turnContext follows E43/E28 honesty (exact-keyed validation,
optional attachedRecaps, «нет данных» when the kernel did not report);
PortClient maps a throwing postMessage to its false contract; the recap
menu follows the WAI-ARIA menu-button pattern incl. Tab dismissal; the
transcript-cache epoch purge never touches other sessions; and the settings
snapshot swaps atomically under a generation guard on every settings-bearing
event including reconnect replays. Closing hardening: the «Рекап» menu is height-bounded
relative to the panel's own formula with internal scroll (a viewport-only cap
still clipped at ~300px heights inside the overflow-hidden ancestor), and an
INVALID turnContext degrades to «absent» at the consumer instead of rejecting
the whole paid operation:complete (the shape gate is isCoachTurnContext; E28
holds by ignoring, not by discarding terminals). Follow-up recorded: extract
the orchestration test harness so the ship-gate's dispatch site gains a
behavioural (unmocked) pin.

**E54 (2026-07-23).** Real Firefox 152.0.6 testing disproved E47's storage
premise: `browser.storage.session` is undefined in content scripts, and
`StorageArea.setAccessLevel()` is a Chrome-only member absent from Firefox
(Mozilla Bug 1724754 remains open). Consequently every Voice open previously
threw before the first usable state and the catch collapsed the cause into one
generic toast. E47 is superseded ONLY on that process-access claim; its
idempotency law, same-request recovery, exact-take/live-route attachment
attestation, memory-only audio, and post-worker-restart download-only attach
degradation remain binding.

Voice-attempt V2 custody is now owned exclusively by one background repository
over `browser.storage.session`, with no memory or `storage.local` fallback. It
uses only `voiceAttemptV1:*`/`voiceAttemptV2:*` keys, serializes writes per
attempt, scans with `get(null)`, adopts valid unexpired V2 records, lazily
deletes invalid/expired voice records and source-less V1 records, and never
clears unrelated session data. Snapshot types and validators are process
neutral. The content controller keeps its existing state machine and
`load`/`save`/`remove` contract through three versioned, acknowledged operations
on the existing central runtime listener (`voiceAttemptLoad`,
`voiceAttemptSave`, `voiceAttemptRemove`). The listener requires a Fansly
message-tab sender on the matching group and checks the account when worker
state can prove it. A write acknowledgement is returned only after
`storage.session.set()` resolves. Unknown, invalid, rejected, or mixed-version
responses fail closed and instruct the chatter to reload; they can never
bypass custody.

Immediately before the paid Voice create reaches Core, `VoiceService` now
requires the repository to contain the exact pending `clientRequestId`,
conversation pin, generation ref, script, Hub source fingerprint, page label,
and account/group binding with `sentOnce=true`. Account+group recovery remains
nonce-insensitive across a tab reload as established by E47, while the service's
independent live route-nonce/fan/source/page checks remain strict for the actual
call. A missing or mismatched row is a local refusal. The former startup
`setAccessLevel` shim is deleted, content has no direct `storage.session`
reference, storage schema stays v15 (session-ephemeral metadata only), and
recovery still intentionally ends with the complete Firefox session.

**E55 (2026-07-24).** A CONFIRMED voice attach completes the session: the
attached message in the Fansly thread is the source of truth, so client
custody of the ACTIVE attempt ends (record + storage removed, blobs revoked;
other boot-recovered attempts and all server artifacts untouched) and the
panel closes with an info toast whose «Очистить черновик» action is scoped to
the conversation AND exact draft it was minted for. While an unfinished
session lives, 🎙 still opens it, and «+ Новый войс из черновика» (reading the
LIVE composer text at click) is the explicit path to a fresh attempt; when the
session holds paid-at-stake work — completed-unattached, generating,
indeterminate takes, or a pending/needs-reconcile create with no visible take
yet — the row expands into an inline confirm before the existing discard path
displaces the session. New-session actions are unavailable during an attach
handoff (the pending outcome is bound to the current attempt), starts are
serialized against double clicks, and per-attempt view state (error, attach
phase, leftover hint) resets before dispatch. This supersedes only the
persistent post-attach panel behavior of the voice design (the leftover-draft
clear affordance moves to the completion toast); an `uncertain` attach outcome
still never completes a session. Spec:
docs/superpowers/specs/2026-07-24-voice-new-attempt-ux.md.

**E56 (2026-07-24).** Voice preview duration is content-owned evidence derived
from the complete in-memory MP3 `ArrayBuffer` with `decodeAudioData`, never from
Firefox's provisional `HTMLMediaElement.duration`. The exact decoded seconds
drive take title, clock, seek maximum, and accessibility value text. A decode
failure fails safe to unknown duration (`–:–`) with seeking disabled; playback
and explicit MP3 download remain available, and a real media/play failure
produces a row-local polite error instead of inventing a duration or silently
failing. This is an in-memory read of already-retrieved bytes: no new Fansly or
kernel egress, wire field, persistent snapshot field, or storage migration.

Take rows are reconciled by `voiceNoteId`; their player/audio nodes survive
routine panel renders and connected лента↔студия reparenting while the blob URL
is unchanged. The panel arbitrates one active player, uses animation-frame
updates only while playing (disabled for reduced motion), and delegates Firefox
fill geometry to `::-moz-range-progress`. Closing or tearing down first pauses
and unloads every media element, then the controller revokes URLs. A
controller-level suspended flag keeps late audio bytes in memory without
minting a hidden `blob:` URL until reopen. Paid-attempt idempotency, background
session custody, exact-take/live-route attach attestation, E47/E54 persistence
boundaries, and E55 completion semantics are unchanged.

**E57 (2026-07-24).** The extension adopts the family provider-error
classification emitted by the Agency Hub feature lane without changing the
open-string wire contract or vendored SDK. Known `provider_billing`,
`provider_auth`, `provider_rate_limited`, and `provider_unavailable` error
frames exact-match dedicated Russian chatter cards. The auth card explicitly
names the Hub's server-side provider credential, not the chatter's Agency Hub
credential. `provider_proxy_unreachable` and `provider_stream_failed` retain
E38's CG-HUB-10 infrastructure card, and any unknown future `provider*` code
keeps the same prefix fallback for rollback-safe degradation. A provider 429
threads its `retryAfterMs` into one absolute UI deadline and shows a manual-
retry countdown; it never triggers an automatic retry.

EOF without a `done` frame remains fail closed but now reports the dedicated
CG-HUB-16 truncation card (“generation stopped; result not shown”) instead of
CG-HUB-07. The content preflight now trusts the existing `TabUiState.hasApiKey`
semantics—normalized Hub URL plus either Hub credential—despite that field's
legacy name; obsolete per-provider key hints can no longer revive Claude or
OpenRouter setup copy. Device-token-shaped log fields and inline
`agency_hub_device_…` values are redacted. No storage schema, SDK, retry policy,
automatic send, or Fansly egress changes.

**E58 (2026-07-24).** The error registry is now producer-checked and
chatter-facing copy follows owner ruling Р1: Russian on every registry card.
The shared `rate_limited` card no longer promises a universal automatic retry:
it says that a Fansly request may continue after a short pause, while an Agency
Hub generation must be repeated manually. Options-only diagnostics may retain
their English shell copy.

The live definitions for `missing_api_key`/`invalid_api_key` (CG-AUTH-01/02)
and `insufficient_balance`/`model_unavailable`/`context_too_long`
(CG-API-02/03/04) are retired after the kernel cutover and E57 Hub preflight
fix. Their provider-specific OpenRouter override path is deleted. The five
codes remain permanently reserved as minimal read-only tombstones because a
persisted `SummaryCacheEntry.agencyHubSync.error` can outlive the producer and
be replayed after restart. Persisted errors are rebuilt from current registry
copy so stale vendor/English wording cannot return; live wire mapping excludes
the tombstones. Settings contain no registry key, completed operation UI caches
are memory-only, and a Voice attempt snapshot's open `errorCode` only pauses
polling—it does not restore an error card. This is a storage-read compatibility
boundary, not a schema change.

A static test walks `src/` for literal `ChatGooseError`, `toUserError`,
`getErrorMessage`, and `createUserError` producers and requires every
non-tombstone registry key to have at least one. The five replay tombstones are
the only explicit allowlist, and the test also requires them to have no live
literal producer.

`createUserErrorBlock` is the single DOM renderer for inline/overlay cards,
toasts, Voice, and the Spenders board while accepting per-surface class names.
Voice now shows the stable code and one technical-detail line; Spenders keeps
the full description/diagnostic and maps thrown implementation errors to the
registry's `unknown_error` instead of exposing raw `Error.message`. Options
keeps its layout and uses the shared technical-detail formatter. One
`resolveUserErrorRetryAtMs` helper gives cards and toasts the same absolute
deadline semantics, preferring `retryAtMs` and deriving it from
`retryAfterMs` only when needed. No automatic retry, send behavior, fail-closed
truncation rule, SDK pin, vendor code, or storage schema changes.

**E59 (2026-07-25).** The settings page becomes a «Кабинет»: a left rail of
sections with one pane visible at a time, «Статус» first. The frame is a
single-pass render — every pane is built ONCE and then shown or hidden, never
re-mounted. Re-mounting would hand a second writer to the serialized settings
chain and re-create custody inputs mid-flight (E19/E37/E51); showing/hiding
keeps element identity, so an in-progress edit survives navigation. `hidden`
alone does not hide a pane: an author `display` rule beats the UA
`[hidden] { display: none }` rule (origin precedes specificity), so
`.chatgoose-cabinet-pane[hidden] { display: none }` is a required companion of
any pane display rule and is pinned by a test.

The route lives in the URL hash and nowhere else: `#<pane>` or
`#<pane>:<code>`, parsed by the DOM-free `src/shared/options-routes.ts` so the
background and content script can deep-link into a pane (and later highlight an
E58 error code) without importing page modules. Unparseable input falls back to
«Статус» — a rotted link must never render a blank settings page. A rail click
only writes the hash; the `hashchange` listener paints it, so links and clicks
take the identical path, and `dispose()` (registered in the page's existing
render cleanup) drops that listener.

Copy is Russian and lives in one dictionary, `src/options/copy.ts`; panes never
inline a literal. Technical terms stay Latin (Agency Hub, device token, Fansly,
Spenders, Fan Summary). The dictionary does NOT carry error texts: the E58
registry in `src/shared/errors.ts` remains the single canonical source for every
error code, message and description, and string pins in tests import COPY rather
than duplicating it. Hotkey names are typed as a total `Record<HotkeyAction,
string>`, so a new shortcut fails typecheck until it is named.

The three extension pages stop reaching for the Google Fonts CDN: the family
faces ship from `assets/fonts`, copied to `dist/fonts` by the build, declared
with `@font-face url('fonts/…')` in the options and popup stylesheets, and
pinned by `tests/local-fonts.test.ts` (WOFF2 magic per file, no external font
host on any page, the build copy step). The pages are `lang="ru"`.

Two boundaries hold for the whole 2.0 effort. First, storage: everything the
cabinet learns about the install (daily operations, account presence, local
account labels, device-token metadata, last-seen version) belongs in its OWN
`storage.local` operational key with its own `version: 1` and a FIFO mutation
queue — the settings blob and its schema stay at v15, and hub credential
custody (E19) is untouched. Second, the changelog stays a WEB page next to the
update feed; the extension only links to it. Zero changelog content ships in
the XPI.

**E59 amendment — wave B «Статус и фон» (2026-07-25).** The hero health strip
(`heroStrip` and its four pills) is DELETED, not moved: its producers now write
into the «Статус» rows and the rail's micro-status, so every install fact has
exactly one owner. The rows are Fansly, Hub, Доступ, Квота AI, Активность,
Spenders and Контракт, each hydrated from its own source under
`Promise.allSettled` — a rejected read paints its own honest state and never
strands a sibling as a skeleton. Hub and Доступ additionally ride a
connection-signature guard checked twice (before issuing AND before painting)
plus a monotonic run id, so a slow hub A can never paint over hub B.

Readiness is an aggregate of ACTIONABLE prerequisites only: a working hub
credential, the host permission, at least one captured Fansly session, and an
active persona on every captured account. Observational rows — an unknown AI
quota, a board nobody has opened, a quiet day — describe the install and must
never turn the verdict red (the E41 model). The rail's «Статус» micro-status is
the same aggregate, not a second opinion.

«Проверить всё» re-runs the hub reads and the local reads and NOTHING else. It
must never call `getSessionsSnapshot`: that handler resolves unknown identities
against Fansly's own `/me`, and a settings button may not become out-of-band
Fansly egress (DP 1-B). It is throttled; the session rows instead refresh on a
throttled focus/visibility re-poll that rides the same snapshot+paint path.

«Скопировать отчёт» builds its text from an explicit report model that has no
credential field at all — the report is secret-free BY CONSTRUCTION rather than
by redaction, and a test greps the produced text for `agency_hub_`, `Bearer`
and the stored custody values. Version and schema come from
`browser.runtime.getManifest().version` and `STORAGE_SCHEMA_VERSION`; quota is
listed per `pageLabel`.

The Контракт line has two homes with two rules: in «Статус» it stays behind
debug mode (it is developer diagnostics, not shift information), while the Hub
pane's diagnostics card shows it unconditionally — that card exists to be pasted
into a support thread. Both read the SAME background-stamped health response:
the hub's `contractHash`, the vendored `KERNEL_CONTRACT_HASH`, and the vendor
manifest's `sourceCommit`. The options bundle still imports no SDK (E41). The
exported `KERNEL_SDK_VERSION` is deliberately not shown — it is the SDK package
version, not the core build, and would read as provenance it does not carry.

Two background stores land in this wave, both operational keys with their own
`version: 1` and a module-level FIFO mutation queue. `chatgoose:opsDaily` holds
one UTC day of facts — hub-lane failures (only `CG-HUB-` codes, an exact total
plus the last 20), the last ACCEPTED generation with the account→page binding it
proved, and the last Fan Summary push that actually landed. Its day boundary is
00:00 UTC, the same boundary the kernel's AI quota resets at, and a record from
a previous day reads as an empty day rather than yesterday's number. The
generation hook sits where the coordinator ACCEPTS a result, not in the gateway:
the gateway request carries no model account, and a stream can still fail
validation after the kernel has finished.

«Last accepted generation» means EVERY feature-lane generation the chatter
received, not only the single-result operations: a delivered Compare card
(`compare-operations`) and a delivered voice script (`voice-service`) each burn
the same quota and each record one generation, so «Активность» can never claim a
quiet day while the quota visibly drains. The same rule binds the error counter:
a compare card's terminal failure, the compare run's own terminal failure and a
voice-script terminal failure all go through `recordHubError`, whose `CG-HUB-`
filter keeps a Fansly/flow/AI code from inflating a counter labelled «Hub».

`chatgoose:deviceTokenMeta` records only which token is stored here (its prefix),
when it was issued, and WHICH hub issued it (`issuedFrom`, the normalized base
URL) — never the token. Sign-out revokes against `issuedFrom`: revoking against
whatever address the settings show now would, after a hub change, hit the wrong
hub, read its 401/403 as `already-invalid`, and report a clean sign-out while the
bearer stayed alive on the issuing hub. Its `expiresAt` is kept for support but
never rendered: hub expiry slides on every use, so a displayed date would be
wrong within minutes. A token issued before this version has no record, and the
pane says so instead of guessing; a record predating `issuedFrom` falls back to
the current address.

Every device-token custody mutation — sign-in, re-issue and sign-out — runs
inside ONE background FIFO. Without it a sign-in landing mid-sign-out could
store a fresh token that the sign-out's wipe then erases while its revoke kills a
different, captured token, orphaning a live and now un-revocable token on the
hub. `signOutAgencyHub` is wipe-first and background-owned: it captures the
token INSIDE the critical section, writes both custody keys to EMPTY strings
(never key removal — that would reopen the pre-v13 blob fallback, E19) and never
touches the settings blob, then best-effort revokes with the captured token. Its
four outcomes are reported honestly — `revoked`, `already-invalid`,
`unreachable` (wiped locally, the hub could not confirm) and the loud
`wipe-failed`; a rejected sign-out REQUEST is reported as `wipe-failed`, because
the background may have wiped nothing. The wipe happens TWICE: the page's
debounced settings chain writes `agencyHubApiKey` outside the auth FIFO, so a
delayed autosave (or a second options tab) could restore a usable legacy key
during the up-to-5s revoke. The page therefore cancels its pending write and
joins any running one before asking for the sign-out, and the background re-wipes
both custody keys once the revoke settles, whatever the outcome. A failed re-wipe
downgrades the answer to `wipe-failed` — local custody outranks server truth. The
post-sign-in status refresh introduced in 1.9.x is preserved and now also
repaints the «Статус» rows.

A LOCAL read that rejected is its own state, never an empty one: `[]` from
`getAiQuotaByPage` and `null` from `getSpendersStatus`/`getOpsDaily` are exactly
what a quiet install looks like, so falling back to them after a transport
failure would make the pane assert «сегодня генераций не было» and «доска ещё не
открывалась» about data nobody could read. Each of the three carries its own
failure flag into both the row and the support report.

Neither the AI quota nor the popup's `getAiQuotaStatus` operation changes: the
popup keeps its freshest-single read; the cabinet uses the new per-page map.

**E59 amendment — wave C «Разделы» (2026-07-25).** Two more operational keys, on
the same terms as wave B's (own `version: 1`, own module-level FIFO queue, never
the settings blob — the planned v16 migration is CANCELLED, and account labels
are the reason it is not needed). `chatgoose:accountPresence` remembers when this
browser last saw each account and the names identity resolution produced;
`chatgoose:accountLabels` holds the chatter's own row nicknames.

Presence is written with a LEADING write plus a 30s coalescing window per
account, never a trailing debounce: every Fansly request the tab makes is a
capture, and MV3 can suspend the worker before any tail would fire — a lost
sighting is exactly what makes the pane lie. The coalesced `lastSeenAt` is at
most 30s stale and never invented. An identity UPGRADE bypasses the window
because there are TWO hooks: `SessionStore.registerCapture` fires with names
still null (they do not exist until `account/me` answers), and
`FanslyClient.getAuthenticatedAccount` fires again once they do. A capture's null
names never erase a resolved one.

Labels have exactly ONE writer — the `setAccountLabel` runtime operation. The
options page never touches that key itself, so however many settings tabs are
open there is a single serialized path into it. A failed label write REJECTS
(unlike best-effort presence): a rename is a deliberate action, and the editor
must be able to stay open with the typed text instead of silently reverting on
reload. Labels are local by contract and outrank the model's public display name
in the row.

`rekeyAccountIdentity` now also moves presence and the label onto the canonical
id, BEFORE its "nothing changed" return — mappings and `knownAccounts` can
already be canonical while presence or a label still points at the legacy id.
Canonical wins on conflict and the legacy record is removed; without this the
pane grows a second, permanently «сессий не было» row for the same model and
loses her label. Both transfers are best-effort: they may never abort the
identity rekey the rest of the extension depends on.

`getAccountsView` says only what the background can prove. 'live' means a
captured session in THIS worker's memory, which is the only way a tab id is
knowable; 'seen' is a durable presence record with no live session; 'never' is a
known account with no observation at all. After a worker restart NO fansly.com
tab is attributable to an account, so `tabs.query` contributes only the
`unattributedFanslyTabs` AGGREGATE — a per-account claim would be invented, and
re-deriving one would mean reading Fansly (DP 1-B). Rows sort live → seen by
recency → never. An ARCHIVED mapping counts as unmapped: it cannot generate, so
the row shows the amber «AI отключён» rather than a false green. «к вкладке»
exists only on a live row and does `tabs.update(id, {active:true})` followed by
`windows.update(windowId, {focused:true})` — activating a tab in a background
window would otherwise leave it invisible. When the operation is unavailable the
pane degrades to knownAccounts + the live snapshot and deliberately claims LESS
(no 'seen', no tab id, no observed page).

The persona catalog's byte-identical write suppression now requires an already
stamped `fetchedAt`. `clearForSource` leaves `{catalog: [], source, fetchedAt:
null}`, so a server-confirmed EMPTY catalog is byte-identical to a cleared cache;
suppressing that commit left `fetchedAt` null forever and made «каталог пуст»
unreachable — the pane could only ever say «ещё не читался» about a source the hub
had actually answered for. «Персоны» stays read-only with four honest empty
states: no credentials, not-synced-for-these-credentials (source mismatch OR no
landed fetch — a failed refresh included), a server-confirmed empty catalog, and
a non-empty catalog whose every persona is archived and unreferenced. There is no
standalone catalog-refetch operation and none was invented: the catalog is
re-read after a SUCCESSFUL connection test, and the button's copy names that side
effect.

«Хоткеи» is a READ-ONLY reference, not an editor: the combos are fixed by
`src/shared/hotkeys.ts` (a content script cannot preventDefault a reserved
browser chord), so a rebinding UI would promise control the page does not have.
Every row is derived from `buildHotkeyBindings(detectLabelPlatform())` plus
`CHEATSHEET_EXTRAS`, so the pane cannot drift from what the keymap dispatches;
only the Russian action name comes from COPY, and each binding's English
`description` is never duplicated there. `COPY.hotkeys.actions` is a total
`Record<HotkeyAction, string>`, so a new shortcut fails typecheck until it is
named, and a test additionally fails on any row that fell back to an English
description. Enabling this pane is what switches the shell from wave A's filtered
rail to the full `OPTIONS_PANES` list.

«Вид» is three clickable CSS-preview cards (system split, light, dark). Each card
still wraps the SAME radio the settings writer reads, so a theme change rides the
existing debounced save path — no second writer and no new field. The radios are
clipped rather than `display: none` so they keep their tab order and the group's
arrow-key navigation, and the previews use FIXED hex instead of the theme
variables: a preview of the light theme has to look light while the page is dark.
Per the owner's rulings this wave adds no reset-to-default affordances, no
changed-from-default markers and no presets anywhere.

**E59 amendment — wave D «Онбординг и хвосты» (2026-07-25).** The first-run
checklist is gated by a DURABLE operational flag, `chatgoose:onboarding`
(`{version: 1, dismissedAt}`), written only by the background over the same FIFO
queue class the other operational keys use. «Fresh» means all three of: the flag
was never stamped, no custody credential is stored, and `knownAccounts` is empty
in the MOUNT snapshot. The durable half is what fixes v1's self-cancelling
predicate: it read live form state, so typing the hub URL dismissed the checklist
that was still explaining the next two steps. The `knownAccounts` half is what
keeps a sign-out from putting a working chatter back through onboarding. An
unreadable `getOnboardingState` reply counts as NOT fresh — an older background
must never resurrect the checklist over a configured install.

The steps run host access → sign-in → «Fansly и персона», which is E41's own
flow: sign-in cannot pass without the host permission (a `no_permission` hub read
is not a credential problem), so ordering sign-in first would send the chatter
into the failure. Each step reads the same sources the «Статус» rows do, but step
1 requires a GRANTED permission rather than the readiness row's lenient
`!== false`: on a fresh install nothing has been granted yet. Step 2 follows the
live identity read, not the presence of a token string — the credential either
works or it does not. When all three are done the flag is stamped ONCE and the
card retires; a failed write keeps the card rather than pretending setup is over.
Fresh empty states are honest rather than blank: ghost account rows (aria-hidden,
nothing focusable) next to the «open Fansly» instruction, the Russian
first-sign-in hint that says the password is not stored on the device, and rail
micros «настройка» / «—» (catalog never read) / «0» (a local count that IS zero).
The ghosts and «появится само» are gated on a hydration that SUCCEEDED: over a
failed sessions read the refresh-failed warning is the whole answer, because
nobody knows whether this browser has accounts. While the checklist is visible
the wave-B readiness hero is HIDDEN — the two would otherwise state the same
three steps twice, one card apart — and it returns the moment the flag is stamped
or on an install that was never fresh; `renderOnboarding` is the single writer of
both flags, and `.chatgoose-readiness[hidden]`/`.chatgoose-badge[hidden]` join the
author-origin guard list (without the badge guard every step wears the green
«готово», the same origin trap the pane and the card actions documented).

The changelog stays a WEB page: `CHANGELOG_URL` in shared constants is pinned
against `BASE_URL` in `scripts/deploy.sh` by a test, because the constant and the
deploy target are one fact stored in two files. The link ships WITHOUT a
`#v<X-Y-Z>` anchor — the anchored per-release page (E42) is not deployed, and a
link into an anchor that does not exist lands on a blank viewport. RELEASE GATE:
adding the anchor is a release-2.0 commit that must FOLLOW that page's deploy,
never precede it; the pin test fails on an anchor added early. «нов.» is shown
when `chatgoose:lastSeenVersion` differs from `getManifest().version`; a click
records the version and clears the dot, the tab opens regardless of how that
write settles, and a rejected write leaves the dot on (an unread release note is
the safe side). On a first run the version is recorded silently — there is
nothing to catch up on, and the checklist is already the message.

Error surfaces deep-link through ONE background operation, `openOptions
{pane, code?}`. It queries for an already-open options tab FIRST and re-points it
(`tabs.update` with the new hash + a window raise); `tabs.create` is only the
no-tab path. A second options tab is a second synchronous settings writer on
pagehide racing the first over the same blob, so it must never be created — the
handler reports whether it reused a tab, and a tab that vanished between the
query and the update falls back to creating one. The whole lookup→reuse→create
sequence runs under its OWN module-level FIFO: the query and the create are
separated by awaits, so two requests in one tick (the mapping banner's «Settings»
is not one-shot — a double click sends two) would both see «no tab» and both
create one. `OPTIONS_PAGE_PATH` is pinned to `manifest.json`'s `options_ui.page`
by a test: on a drift `tabs.query` silently stops matching and the singleton
degrades to always-create. Routing comes from the E58 registry by KEY (the stable
identifier), not by code string: `no_mapping` → «Аккаунты», `no_personalities` →
«Персоны», `CG-HUB-*` → «Agency Hub», anything
else that carries `settingsLink` → «Статус». That last branch is load bearing:
`settingsLink` is not a hub-only flag. The mapping banner covers TWO classes
through one callback, so the reason now travels with the click — «no active
personas exist» opens «Персоны», «this account has none assigned» opens
«Аккаунты». The popup's normal path uses the operation; its unavailable screen
KEEPS the native `openOptionsPage`, because that screen exists precisely because
the runtime did not answer. Content and popup fall back to the native opener when
the request rejects OR resolves `{opened:false}` — a refusal that resolves opened
nothing either, and a click that does nothing at all is worse than a second path;
in both cases nothing was opened, so the fallback cannot double-open.

On arrival the page shows ONE line, `<code> · <registry description>` — read from
`src/shared/errors.ts`, never restated in COPY — and highlights the row that code
names. The highlight is PENDING: hub diagnostics and account rows hydrate
asynchronously, so it fires the first time the target exists AND is really there,
which is why every relevant repaint calls the same hook. Nonempty text is NOT
that proof — the accounts table ships with a loading line, and an arm against it
would burn the one-shot on «Загружаем…» and expire (2s) before the snapshot
(up to 5s) paints the rows, with nothing left to re-arm. A container that
hydrates asynchronously therefore declares its own readiness
(`data-deeplink-ready`), and only that answer counts; rows painted from a single
value still use their text. A deep link into an already-open tab arrives as a
hash change, so the note and the highlight re-arm
on `hashchange` and the previous pane keeps neither. An unknown code still opens
its pane and explains nothing: a rotted link must degrade, never fabricate.

**E59 amendment — post-campaign fixes (2026-07-25).** The whole-campaign review
found two custody holes and three honesty holes; all five are closed here.

The device-token metadata record is CUSTODY-GRADE, not the «display convenience»
its wave-B comment claimed: sign-out aims the revoke at `meta.issuedFrom`, so the
record decides which hub receives the bearer. The issue path therefore commits the
custody key and the metadata in ONE `storage.local.set` (`saveSettings`'s
`alsoWrite`, still never the settings blob — schema stays v15, E19 intact). The
bug that forced this: a re-issue against hub B could commit the token while the
separate best-effort meta write failed, leaving `issuedFrom: A` on disk — sign-out
then sent B's bearer to A, A's 401 mapped to `already-invalid`, and B's token
stayed live with the UI reporting a clean sign-out. Second half of the same fix:
when NO readable metadata exists while a token IS stored, the revoke goes to a
GUESSED address, so its 401/403 is reported as `unreachable` («не подтверждён»)
rather than `already-invalid` — a 401 from a hub that never issued the token
proves nothing. With valid metadata the existing mapping stands, and the metadata
REMOVAL stays best-effort (it runs after the custody keys are already empty
strings, and a leftover record cannot resurrect a token).

Custody is fenced ACROSS TABS. `openOptions` guarantees a single settings tab only
for the paths it owns — a manually opened second tab is real — and that tab used to
keep the wiped token in memory after the other tab's «Выйти», still rendering
«Device token active ✓» and still willing to run a connection test with a
credential that no longer exists on disk. The page's `storage.onChanged` listener
now applies a custody-key change into this document's own settings and repaints the
hub state (signed-out after an external wipe, re-read metadata when the token
itself changed). A local unsaved edit wins over the input FIELD only: a dirty
legacy-key input keeps its typed text while the state and every signed-in
indicator tell the truth about what is stored. A change whose values already equal
this tab's in-memory pair is this tab's own write echoed back and is ignored, so
the fence never doubles the save path's hub checks.

Deep-link readiness now covers the Hub diagnostics rows, amending wave D's «rows
painted from a single value still use their text»: those rows PRE-FILL
«неизвестно», so text would arm the one-shot highlight on a placeholder and the
2s flash could expire before host access or identity hydrate — with nothing left
to re-arm. Every row whose value can only come from a read that has not landed
ships `data-deeplink-ready="false"` and flips to `"true"` the moment its own
source SETTLES (a failure is a real answer too); «Проверка» stays text-based
because its first paint is already complete from in-page state.

Two honesty rules are tightened. (1) Availability of the local «Статус» reads is
derived from settlement AND parse validity: a stale background can FULFIL with
`undefined`, which the parsers used to collapse into `[]`/`null` — the same shape a
quiet day produces — so the pane and the copied report asserted «сегодня генераций
не было» / «доска ещё не открывалась» about a reply nobody could use. The parsers
return `{ok, value}`, and an unusable reply paints the same «недоступно» a rejected
read does, while a genuinely empty map or a null board observation keeps its honest
empty. (2) A failed Fansly sessions read carries into `StatusReportModel`
(`unavailable.fansly`): the row was already honest, but the report printed the
zero-account claim from the same placeholder zero. A successful re-poll clears the
flag.

**E59 amendment — post-campaign round 2 (2026-07-25).** Two independent reviews of
the block above found the fence still losable and one rule mis-keyed; seven
corrections, and three of them supersede wording recorded one paragraph earlier.

The fence is applied from the STATE of every applied read, never gated on which
event started it. A per-event `custodyChanged` flag belongs to the read the
generation guard then discards: a `settings` or persona-catalog change landing one
tick after the wipe superseded the custody read, and the surviving callback (flag
`false`) left the tab holding a revoked token until the next custody event. The
in-fence equality check is the ONLY no-op suppressor, which is what makes the
unconditional call safe.

An external wipe now also invalidates THIS tab's pending credential write.
Wave B's quiesce covers only the tab that pressed «Выйти»; a second tab with a
typed-but-unsaved legacy key would let its 350 ms debounce fire after the wipe and
put a usable credential back on disk while the signing-out tab honestly reported
`revoked`. The fence cancels that pending snapshot, drops the credential's dirty
claim and bumps the snapshot versions (the future-schema barrier's instrument) so
an already-running persist can no longer move the in-memory key back. The typed
text stays in the field as a NON-PERSISTING draft — the cancelled snapshot is
deliberately not re-armed, because a save with the dirty claim gone writes the
stored value back into the field and would erase that draft; `settingsDirty`
survives, so the next edit, blur or pagehide still persists the non-credential
edits without the credential.

The fence must not double the hub checks it shares with this page's OWN custody
RPCs. The background's write arrives as a storage event that can beat the RPC
reply, so the equality check cannot see it coming. A page-level claim
(`ownCustodyWriteInFlight`) is held across sign-in / re-issue / «Выйти» AND the
refresh chain each of those paths owns; while it is held the fence still APPLIES
the new custody state (it is real) but skips permission → connection-test →
hydrate. This is what keeps the round-1 sentence about not doubling the save path's
hub checks true.

Round-2 correction (final review): the fence's OWN follow-up chain runs NO local
connection test at all — only the permission re-read and the status-row
hydration from the stored snapshot. A forced test from the fence mixes sources:
the form still shows THIS tab's base URL and possibly an uncommitted key draft
(blob fields the fence deliberately does not touch), while the token is the
freshly applied one — worst case sending the other hub's fresh token to the URL
in this form. The tab that performed the custody write already ran the checks;
the «Проверка» line keeps reporting the last test THIS tab ran.

Superseded wording, corrected: (1) the honest-outcome rule keys on the recorded
ADDRESS, not on the metadata record's existence — `!capturedMeta?.issuedFrom`. A
valid pre-`issuedFrom` v1 record is readable yet says nothing about who minted the
token, so its revoke also goes to a guess (the current base URL) and its 401/403
must read `unreachable` too. (2) `alsoWrite` no longer trusts its documented
invariant: a co-write colliding with `settings`, `schemaVersion` or a custody key
the same call owns THROWS, because a silent overwrite there is how a credential or
the schema stamp gets clobbered. (3) `unavailable.fansly` starts TRUE — before the
first sessions read there is no snapshot to speak about, and the report copied in
that window (up to 5s) would otherwise print «аккаунты не обнаружены» from the
placeholder zero; both branches of the first paint set the honest value.

Finally, the fence re-renders the sign-in meta line. `renderHubSignInState` fills
that line only when it is EMPTY, so an external wipe used to leave «Hub requests
use the device token …» — or, after a sign-in in the same session, «Device token
abc… issued (expires …)» — sitting next to a signed-out pill.

**E60 (2026-07-26).** The cabinet's FRAME, chosen from the R3 «было/стало»
mockups. `body { max-width: 900px }` put the whole cabinet — rail included — in
a ribbon in the middle of the canvas: on a 1870px window the shell used less
than half the width, and the rail scrolled away on the one long pane. The shell
now fills the window; the rail is `position: sticky` with `height: 100vh` and
its own overflow, so navigation survives Agency Hub; the reading column is
capped at 1120px and centred by `.chatgoose-cabinet-pane`, which is also where
the bottom breathing room now lives.

This supersedes the 900px choice recorded in BL-003 after the #46 revert. That
ruling settled a comparison between the .907 build (900px) and #46's 1280px
frame, which ALSO stretched cards and 56px badges; the owner's objection was to
that treatment, not to the window being used. R3 changes the frame alone — cards,
palette, row anatomy and the panes' contents are untouched in this wave — and the
1280px clamp is not reinstated: a capped, centred column is what keeps the line
length readable on a wide monitor.

`root.style.paddingBottom = '24px'` is gone from the cabinet path. It sat on top
of the shell's `min-height: 100vh`, so every pane — «Вид» with its three cards
included — was a scrolling page. The two recovery gates keep their own padding:
they render outside the shell and have no pane to hold it.

Narrow windows (BL-003 п.1, open since wave A) close here: below 900px the rail
gives back width, below 640px it stops being a rail and becomes a wrapped strip
above the content, and the dense rows (status, hub, accounts, persona catalog)
drop their right-hand mono column onto a second line instead of overflowing the
card. The rules live at the END of the stylesheet on purpose — a media block
placed before the base rules it overrides loses to them on source order.

Two honesty fixes ride along, both from the R3 diagnosis. Disabled controls had
NO styling anywhere in the stylesheet, so «Проверить связь» and «Разрешить
доступ» — off for the whole fresh-install flow — read as broken clay buttons;
they now wash out and drop the pointer. And the save whisper said «Saved ✓» on a
fully Russian page while `COPY.common.saved` sat unused.

Dead copy removed with the frame: the `hero` block (11 keys) died with the health
strip in wave B, `pageTitle`/`pageSubtitle` died with the page header the rail
replaced, and seven `sections.*` keys duplicated titles the panes own themselves
— every one of them verified unreferenced in `src/` and `tests/`.
`COPY.documentTitle` claimed to mirror the static `<title>` with nothing
enforcing it; a one-line test now pins the claim.

**E61 (2026-07-26).** Wave B of the R3 polish: the two panes a chatter opens
when something is wrong. Chosen from the «было/стало» mockups (variant С1).

The mono badge column is gone from «Статус» AND from the Hub diagnostics. It
spoke six vocabularies at once — cardinal counts, English state words
(UP/AUTH/DRIFT/RAMPED/FLAG OFF), an HTTP status, a Russian phrase, a wall clock
and an em dash — in a slot tuned with `tabular-nums` for numerals most of those
were not. «—» alone meant «unknown», «not observed», «read failed» and «no cap
reported», so a reader fell through to the fact text every time. Worse, the
column did not actually align: every row is its own grid, so `minmax(60px, auto)`
held the labels on one vertical only while the token stayed short — «НЕТ
ДОСТУПА» shoved its row 40–60px right, which is the opposite of what #48's
«Ровные колонки» promised. What the badge said now lives in the fact («1 в
работе — …», «ядро отвечает», «худшая {page} · осталось {n}», «{time} · {feature}
· {account}»), the tone still colours the dot, and the label sits in a FIXED
column so the facts genuinely share one vertical. In the Hub diagnostics the
badge was outright redundant: «OK» next to «успех», «0» next to «за сегодня 0».

Row hairlines moved to `border-top` on every row but the first. The old
`.chatgoose-status-row:last-of-type { border-bottom: 0 }` never matched anything
— the section's last DIV was a hint, not a row — so a full-width line hung under
the list, and a `:last-child` rewrite would still strand it above the hidden
debug-only Контракт row.

Panes now have a HEAD: title, subline, and the pane's own controls, above cards
that carry content only. «Проверить всё» sits there with a stamp beside it
(«обновлено HH:MM»), because a check that changed nothing used to be
indistinguishable from a check that never ran. The readiness headline stopped
being a card of its own and became the first block of the rows card — the two
plates said one thing twice — and it dropped the version pill, which was
positioned `top: 28px` for a card padded 16px and printed the version in a second
format next to the rail footer's. The open steps became «Что мешает»: one row per
step with the button that closes it, routed exactly where the first-run checklist
routes. The support card states version + storage schema + «Скопировать отчёт»
and shows the honesty clause as VISIBLE text (it had been demoted to a tooltip,
invisible to touch and keyboard). Two cross-pane pointers close the cabinet's
missing links.

The Hub pane stops repeating itself. «Доступ к хосту» was rendered twice under
the same label in two vocabularies; the diagnostics copy is deleted and the
`host-access` deep-link anchor moved onto the «Подключение» row — so `CG-HUB-04`
now flashes the row that CONTAINS «Разрешить доступ» instead of a read-only line
in another zone. The check receipt keeps a short form in «Подключение» and the
outcome form in «Диагностика» (summary and detail, no longer the same three
tokens rearranged). A new «Ядро» row states health + DB latency — the response
was already in hand and only «Статус» ever said it. The four zones became four
cards in two columns: connection + sign-in (one flow) on the left, account +
diagnostics on the right, so the pane no longer scrolls the rail away, and the
washed card-inside-a-card nesting is gone with `.chatgoose-card`. «Выйти» is
fenced at the bottom of the card that owns the credential, consequence left and
button right. The device token states its state on one line and its provenance
(«Выпущен») on the next instead of one «·»-joined sentence wrapping beside the
pill. A failed check puts a WORD in the pill («нет связи») and the registry code
in the mono receipt — pills speak words everywhere else in the cabinet. Core-page
chips finally have a CSS rule (they had none and rendered edge to edge), and the
«· {n}» template shared by two readers is split, so neither shows an orphan
middot.

Tests were updated deliberately, not around: the badge assertions became fact +
tone assertions, the readiness-step lookups point at «Что мешает», and the legacy
`getSectionByTitle` helper accepts a pane head's `<h1>` as well as a card's
`<h2>`.

**E61 amendment — review fixes (2026-07-26).** Five findings, every one of them
in what wave B MOVED rather than in what it wrote.

The `host-access` deep-link anchor sits on a BLOCK now — the «Доступ к хосту»
fact, its explanation and «Разрешить доступ» — not on the status row alone. The
claim above («`CG-HUB-04` flashes the row that CONTAINS «Разрешить доступ»») was
false as shipped: the button lived in the zone's shared action row, two siblings
away, so the flash framed the diagnosis without the cure. The grant button rides
its own line under the fact; «Проверить связь» stays the zone's only primary.

«Что мешает» is back under `renderOnboarding`'s single-writer rule, like the
readiness hero it was split from. The open-steps LIST left the hero for its own
card, so hiding the hero stopped suppressing it — and a genuinely fresh install
stated the same three setup steps twice, once with a CTA each and once in the
amber card beside them. One function (`applyReadinessVisibility`) writes both
flags; the list inside keeps painting either way, so it is right the moment the
checklist retires. The test that asserted the duplicate was corrected, not worked
around.

Each «Статус» action answers in its OWN live region. «Проверить всё» moved into
the pane head and left its only feedback element behind in «Поддержка», where the
throttle message read as a verdict on «Скопировать отчёт» — and a later check
silently wiped «Отчёт скопирован».

Three CSS trailers. The pane head WRAPS: its side cluster is `flex: none`, so at
~320px the title and the controls were pushed off the page. The <640px
diagnostics row dropped the 46px lead column it kept from the deleted mono badge,
which squeezed «Контракт SDK» into a third of the space it needs. And
`.chatgoose-hub-srow`'s author `display: grid` finally has its author `[hidden]`
guard — without it the «Выпущен» row stayed on screen, empty, on every signed-out
install and after «Выйти». The stylesheet test's FIXED class list is part of that
fix: it now names every class this stack hides with the IDL flag, so the next one
is caught by the same net.

**E62 (2026-07-26).** Wave C of the R3 polish — the five panes that were not
«Статус» or Agency Hub. The owner picked the additions from the mockups: account
chips on «Персоны», state groups on «Аккаунты», the chat-panel preview on «Вид»
(the «тратит квоту» marker for «Хоткеи» was NOT picked and is not built).

«Персоны» held `state.accountMappings` — the whole account→persona map — and
printed `аккаунтов · N`, throwing the identities away. A persona row now lists
the accounts sitting on it as chips, labelled exactly as «Аккаунты» labels them:
the accounts renderer is the single place that resolves a name, and it fills a
shared index the persona rows read. The count also stopped going stale — a
persona assignment writes ONLY the `accountMappings` key, which the storage
listener did not watch, so the number stayed wrong until a reload (BL-005). The
pane became two columns (the catalog left, its provenance and the archive right)
and finally says WHICH hub the catalog came from — `personaCatalogSource` was in
memory and shown nowhere. The catalog's staleness marker rides the card head, and
the label/value pair no longer says «Каталог» twice.

«Аккаунты» group by state — «В работе», «Видели раньше», «Сессий не было» — each
with a caption and a count, and an empty group is not drawn. The per-row «в
работе» pill goes with it: the group states it once for its whole block, and what
stays on a row is only what carries a problem or an action («AI отключён», «к
вкладке»). The live counter is a chip in the pane head; the two instructions that
used to be glued onto it («персона назначается на аккаунт · ID копируется
кликом») are the pane's subtitle. A row with no resolved name spells out the
invitation («✎ подписать») instead of the id twice.

«Генерация» splits into two card columns: the four context windows left, the
coach and the service switch right — «Служебное» was a mono caption floating over
a single row whose first- and last-child padding were both zeroed. The numeric
lane is fixed-width, so ranges align with ranges and steppers with steppers. The
bounds come from the SAME constants the storage clamp uses (they were string
literals, free to drift in silence), and each input gets a step that matches its
range: 5 for the 5–200 windows, 50 for the 100–3000 deep window, which stepped by
1 — 2900 clicks from end to end. The clamp notice moved out of the range hint
into its own amber chip under the row: it used to replace the bounds for 2.6s,
with a colour change as the only signal that the slot had changed meaning, and
its timer was never registered for cleanup.

«Хоткеи» give each group its own column (the old split was eight rows against
six, ragged at the bottom), let a name WRAP instead of ellipsising — a reference
that cuts «Закрыть оверлей, доску или шпаргалку» is not a reference — and state
the detected platform in the head, so a chatter comparing with a colleague's
screenshot knows why the combos differ.

«Вид» draws the surface its subtitle promises. The miniature drew the cabinet —
the one surface the chatter is already looking at — so a second card previews the
in-chat panel, in fixed colours like the theme miniatures (a preview of light
must look light while the page is dark). The miniatures gained the family's clay
button, «Системная» says which half is live right now (`resolveUiTheme` existed
and this pane never called it, and the resolved class is watched so the note stays
true when another tab or the OS flips it), and the three radios finally have a
group name.

**E62 amendment — review fixes (2026-07-26).** Six findings, plus one test that
had been weakened instead of updated.

The fixed numeric lane got its OWN class. It shipped as a second bare
`.chatgoose-row-control` rule — same specificity, later wins, for every wearer of
that class — and the auto-recap segment wears it too, so «Выкл / Короткий /
Полный» was clamped into the 66px range track: «Полный» was neither visible nor
clickable. `.chatgoose-row-control` is the generic inline-flex wrapper again;
`.chatgoose-row-numeric` is the lane, and the clamp chip hangs off it.

No account row may contradict the caption above it. State is a group CAPTION
since this entry, and the degraded path (an older background with no
`getAccountsView`) called every non-connected account 'never' while keeping its
`lastSeenAt` — so a row could sit under «Сессий не было» and say «была вчера
22:23», a verdict nothing established. The pane now carries a FOURTH state of its
own, 'unknown', for an account the live snapshot says nothing about; a snapshot
entry that exists but is disconnected is honestly 'seen'. The extra state never
travels: `asAccountsView` still admits only the contract's three.

«Системная» is described by `resolveUiTheme('system', …)`, not by the document's
resolved theme class. Read from the class, the note said «сейчас — тёмная» with
«Тёмная» explicitly picked — true of the page and false of the sentence it
claimed to explain — and it went stale when the OS flipped under an explicit
theme, because the class does not move then. It names the system out loud
(«система сейчас — …») and listens to the OS query instead of the class.

The catalog's source line shows the WHOLE normalized base URL.
`normalizeAgencyHubBaseUrl` deliberately preserves a non-root path, so printing
`new URL(...).host` collapsed two agencies on one host into one line. The
credential-fingerprint half of `personaCatalogSource` still never reaches the
screen, and the address WRAPS rather than pushing its card past a narrow window —
an ellipsis would hide exactly the path that distinguishes them.

`chatgoose-account-rows` names ONE element again — the table the `CG-FLOW-02`
deep link selects with `querySelector`. The per-group row list wore it too, so
the highlight landed on the right element only by DOM order; it is
`chatgoose-account-group-rows` now, sharing the rule and not the name. Dead
weight went with it: the `.chatgoose-persona-catrow` trio (the catalog row died
when «Обновлён» became a plain fact line), `COPY.accounts.stateLive`,
`COPY.hub.hostAccessLabel`/`hostAccessGranted`, and the ruleless
`chatgoose-chip-count`.

The persona-catalog test is a guarantee again. A node-identity assertion — that
session hydration does not rebuild the catalog — had been softened to
`toBeTruthy()` plus a dataset read that is true by construction. The catalog CARD
is asserted by node identity, the persona ROW is asserted to repaint exactly once
(the account labels it renders as chips only exist after the snapshot), and a
second poll with unchanged labels is asserted to leave it alone — which is what
the `labelsChanged` guard is for.

**E63 (2026-07-28).** The paid-attachment marker lost its em dash. `ppvSuffix`
emitted `[Video — PPV $80.00, purchased]`, and that marker rides into EVERY
generation, once per paid attachment in the transcript window, ahead of any
instruction the kernel writes. An em dash is the classic AI tell in fan-facing
chat, and a model mirrors the style of its own prompt, so the tell was being
taught by our own live read. The grammar is now `[Video - PPV $80.00, purchased]`
with a plain hyphen.

This is a two-repo change by construction. The same marker is also emitted
kernel-side by `prompts/transcript/normalize.ts` for archive-sourced transcripts,
and its grammar is quoted VERBATIM inside the fast-reply, help-me, improve-draft
and ping templates so the model knows what the tag means. If one side moved
alone, the quoted grammar would stop describing the live tag. Core Decision #189
carries the kernel half (both emitters, all quotes, and the em dashes in the rest
of the prompt prose); this change is its extension twin and the two ship together.

Nothing about purchase semantics moved: the same three states, the same listed
price, the same fail-closed `unknown`. Only the separator changed.

**E63 addendum — two clock-rotted tests.** Both were found by the gate, not by
the change, and both asserted a calendar-relative UI string from a fixture that
was not calendar-relative. `options-personas` pinned the catalog date to an
absolute `2026-07-25 14:05` and asserted «no staleness marker (<48h)» — from
2026-07-27 14:05 onward that fixture is stale and `main` went red with no commit
behind it. `options-accounts` set `lastSeenAt` to `now - 26h` and asserted
«вчера», but `formatSeenWhen` decides by LOCAL CALENDAR DAY: run the suite
between midnight and 02:00 and 26 hours ago is the day before yesterday. Fixtures
for a calendar-relative formatter are now built from the calendar (previous local
day, fixed clock time), and the date-format literal is left to the formatter's
own unit test.

**E64 (2026-07-29).** Stream-abort classification order is now normative:
terminal error frame → abort → truncation. The vendored SDK swallows every
exception once its abort signal fires (its final `.catch` returns on
`abort.signal.aborted`), so an aborted SSE stream used to surface as
`hub_stream_truncated` — the chatter read «Генерация оборвалась» (CG-HUB-16)
for a LOCAL timeout, and `recordHubError` counted it into «Ошибки генераций
(Hub)», blaming the kernel for the client's own clock. The gateway now captures
the mapped terminal-frame error before throwing it, and after `handle.done`
classifies in the fixed order above: a kernel error frame outranks the abort
verdict (the SDK swallow must not eat what the kernel actually said), an abort
re-raises as `AbortError` so `resolveAbortChatGooseError` maps armed timeouts
to `timed_out`/CG-NET-02, and only a genuinely terminal-frame-less EOF remains
CG-HUB-16. Fail-closed is unchanged: every non-`done` path still throws, no
partial text is ever presented. Semantics that moved: CG-HUB-16 now means
«поток оборвался БЕЗ аборта», and the daily Hub-error counter no longer grows
on local timeouts. The order itself is pinned by the abort-classification
tests in `tests/kernel-feature-gateway.test.ts`.

**E65 (2026-07-30).** The voice-attach observation budget is twenty seconds,
not ten (`ATTACHMENT_OBSERVATION_BUDGET_MS`, `src/content/voice/attach-adapter.ts`).
The budget was read as «how long an upload takes», which it is not: the adapter
hands the file to Fansly's own file input, Fansly opens ITS native Upload modal,
and the waveform preview the adapter polls for appears only after the HUMAN
clicks Upload inside that modal. So the clock also measures the chatter finding
the modal, reading it, and deciding — and ten seconds regularly expired on an
attach that then landed. The visible cost of expiring is not merely a soft hint:
`uncertain` renders «Проверьте composer» plus a «Прикрепить ещё раз» button that
mints a fresh token, so a late-landing attach invites a second one and the fan
hears the same paid take twice. Twenty seconds is the owner's call; waiting is
free while the modal is open. Unchanged: at-most-once token custody (a consumed
token is never re-armed automatically), the honest three-way outcome
(`confirmed`/`uncertain`/`aborted`), the softened leftover-draft prompt on
`uncertain`, and the explicit human re-arm — none of this becomes an auto-retry.
The new floor is pinned by «confirms a waveform that lands after the old
ten-second window» in `tests/voice-attach-adapter.test.ts`, and the terminal-
uncertain test now advances by the exported constant instead of a literal.

**E66 (2026-07-31).** E52 still permits concurrent tabs, but not stale
last-writer-wins custody. Voice V2 envelopes carry a monotonic revision
(revision-less V2 adopts 1); runtime RPC v2 makes background `save`/`remove`
compare it inside the per-attempt FIFO, while content serializes local writes
and fails closed with reload guidance on conflict. The paid-create assertion
joins that FIFO. There is no tab lease or `storage.local` schema bump, and
account/group reload recovery still ignores routeNonce.

Script callbacks/finally now require exact `ActiveScript` object identity, and
the new-session warning covers paid work in every recovered record. Because Core
no longer retains quota-denial rows, `voice_quota_denied` clears a definite
first send but a replay after `sentOnce=true` remains `needs-reconcile`.

**E67 (2026-07-31).** R4 polish of the cabinet, approved pane by pane from
«было/стало» mockups rendered against the live stylesheet. One principle runs
through it: **a fact is stated once, and a control exists only while it has
something to do.**

*Agency Hub.* The «Проверка» diagnostics row is gone — it printed the same
`lastConnectionCheck` (outcome, credential, clock, duration) that «Связь» already
carries in «Подключение», beside the button that produces it; the failed state's
mono line grew the receipt tail so nothing is lost when a check fails.
«Переподключить» is retired: with access granted it changed nothing, so the
action row now appears exactly when the pill is not «выдан» (its `[hidden]` guard
is load-bearing — the author `display: flex` beats the UA rule). «Проверить
связь» moved into the card head, where «Перевыпустить токен» already sits — one
action pattern per pane. The columns are re-cut: LEFT is the hub (address, reach,
core health), RIGHT is me (who signed in, with what) — the E61 cut left the right
column ~200px short and split the two cards a chatter compares. The identity row
is «Логин», not a second «Аккаунт»; «Ошибки Hub» is «Ошибки ядра» (the cabinet
says ядро/хаб, and «Ядро» is the label one line above); «Выпущен» is not drawn
when there is no provenance to state — «данные появятся после следующего входа»
was a fact about the row. Finally the pane has ONE vertical rhythm: the identity
rows stepped 4px against 17–19px everywhere else because `.chatgoose-status-body`
carries no vertical padding, so they take the diagnostics row's padding and
hairline, and a card head stands 31px whether or not it holds a button.

*Персоны.* «Каталог» beside «Каталог ядра» said nothing about what the card is
for — it is «Синхронизация». The mono «аккаунтов · N» at a row's right edge
counted the very chips printed below it (never truncated, unlike the hub's page
chips), so the count moved into the chips' own caption: «на ней · N». The local
archive stands under the persona list, where it belongs by subject, and the
columns stop ending ~120px apart on a small catalog.

*Аккаунты.* A group caption and its count sit together; `space-between` used to
fling the number ~850px to the card edge, where a lone digit reads as anything
but a group size. An unnamed row printed its id twice — shortened as the heading,
full on the line below; the heading IS the full id now and IS the copy button,
and the line below drops it. A row in «Сессий не было» no longer repeats that
caption verbatim, so an unnamed never-seen account with no observed page has
nothing left for line two: such a row renders as ONE line with the persona select
joining the action cluster (it keeps its 220px lane, so the list's right edge
stays one vertical). Named rows are untouched. Two rejected alternatives, for the
record: «без подписи» as the heading made three rows indistinguishable, and
keeping the fact line left a two-line row with a hole.

*Генерация.* Two CSS defects, one symptom (a clipped «+» on «Глубокое окно»).
`.chatgoose-row .chatgoose-input { width: auto }` (0,2,0) outranks
`.chatgoose-input-num { width: 62px }` (0,1,0), so the declared width never
applied and the field took the UA default; and `.chatgoose-stepper` carries
`overflow: hidden`, which zeroes its min-content contribution, so flex was free
to squeeze the −/+ buttons out of the row and did — measured 143/166/169px
against 109px for the row whose sublabel is longest. The width is restored at
matching specificity and the numeric lane is `flex: none`; the labels yield, as
their `min-width: 0` always intended. All four steppers now stand at 124px on one
right edge.

*«Хоткеи» deliberately untouched.* The 8/4/2 columns leave a 237px ragged edge
and were offered for the same treatment; the owner kept E62's «one group, one
column». Recorded so the next reader does not re-litigate it.

**E68 (2026-07-31).** The Spenders board header states WHICH feed stopped, not
merely that something did. The meta line used to append a single «source paused»
for every non-`ramped` `streamState`, so three different situations printed the
same four characters: the owner turned the spender projection off in the Hub;
this page was dropped from the Hub allowlist; the platform is unsupported
altogether. Only the second is a chatter-visible incident with a known fix, and
it is exactly the one that hid — `lora-1` sat out of the allowlist from
2026-07-17 to 2026-07-31 while its board kept drawing thirteen-day-old rows under
«source paused», and the matching amber row in «Кабинет» said «страница не в
allowlist», which reads as an access denial rather than a stopped feed. One line
per state now comes from `feedStateLabel` in
`src/content/spenders/spenders-board-controller.ts`, a total switch over
`SpendersStreamState` (so a future state cannot silently fall through to
silence), and `ramped` returns `null` — a flowing feed says nothing about itself,
leaving the existing failed-sync-attempts branch as the only thing that speaks.
Unchanged on purpose: reading is NOT gated, so the rows stay on screen and the
counts, freshness and «shown rows may be older» line are untouched; and the empty
states in `metaLine` and `renderList` are left alone — they already distinguish
all four cases. The board is English with inline literals (it has no copy module);
the Russian half of this fix lives in «Кабинет» and is recorded separately. The
new strings are pinned by «names which feed stopped instead of one catch-all
"source paused"» in `tests/spenders-board-controller.test.ts`; «source paused»
had no test at all, which is how it survived.

**E69 (2026-07-31).** The «Статус» Spenders row reports a STOPPED FEED, and it
names which page stopped and how old the data is. `lora-1` sat outside
`fanslyNewStreamPageAllowlist` from 2026-07-17 to 2026-07-31 while this row read
«страница не в allowlist» — an ACCESS claim, about no page in particular, next
to a board that kept drawing its 697 frozen rows. Reading is never gated here;
only the projection's feed is. So the two gated states say «приток остановлен:
проекция выключена в ядре» / «приток остановлен: страницы нет в allowlist ядра»,
and the row grows detail lines: «страница {page}» and a three-bucket data age
(свежие / N ч назад / N дн назад, `formatSpendersDataAge`). The same two lines
are drawn for a FAILED observation — «сборка не удалась» about an unnamed page
names nothing — and the support report carries both in its own technical
register, since support receives that artefact instead of the screen.

`pageLabel` rides `SpendersListResult`, not the observation site. `getList`
records the observation ~300 lines before `buildFromKernel` resolves the label,
and a session-cache hit or a shared in-flight build returns earlier still —
carrying it in the result is what makes all three paths agree. `builtAt` was
already there.

The FAILURE path needs its own carrier, because a throw leaves no result to read:
a mutable `SpendersBuildScope` is created in `getList`, filled in the moment the
label resolves and again the moment the ranking lands, adopted from the cache on
a cache hit and from the shared build by every late joiner. Nearly every real
failure — a Hub 500 on the ranking request, a build timeout, `session_expired`
during enrichment — happens well after the label is known, so writing a flat
`null` there reproduced the very anonymous verdict this entry is about. Only a
failure at `resolvePageLabelForUsername` genuinely has nothing to name, and it is
the one case that still records both as null.

Both new `SpendersObservation` fields are OPTIONAL, and every read of them is
`typeof x === 'number'` / a truthiness test — never `!== null`. The type lives in
`storage.session`, which survives an extension update, so records written before
this change come back missing the fields, and `undefined !== null` is true. The
failure mode of the strict form is worth stating exactly, because it is not the
obvious one: `undefined` would pass the guard, `Date.now() - undefined` is NaN,
and the formatter's own non-finite branch would then have answered «данные
свежие» — a false claim of freshness stacked on top of a 13-day outage, which is
strictly worse than visible garbage because nobody looks at it twice. So that
branch now returns nothing at all rather than a bucket, and the caller drops the
line. Both are pinned by tests, alongside the amber `not_allowlisted` branch that
went 13 days uncovered.

For the same reason the board's session cache normalises `pageLabel` on read:
the key stays `spendersCacheV3` (the bump belongs to a later change), so within
the TTL after an update an entry written without the field would otherwise enter
the app as a `SpendersListResult` in a shape its own type forbids. *(Superseded
in part by E70, which bumps the key to `spendersCacheV4`; the normalisation stays
as belt and braces.)*

Out of scope by construction: the board's own English header (its catch-all
«source paused» is E68) and anything about deleted fans.

**E70 (2026-07-31).** A fan who deleted their Fansly account LOOKS deleted on the
board, and the extension stops asking Fansly about them. Production numbers,
read from the `lora-1` projection on 2026-07-31: 709 rows, of which 238 carry
`deleted_detected_at`, and 209 of those 238 have neither `username` nor
`displayName`. Those 209 rendered as a bare numeric id — visually identical to a
name that simply had not loaded yet — next to a «find chat» chip that could never
resolve, because with no search term `resolveFanChat` returns `groupId: null`
without issuing a request and the row then printed «not found». Meanwhile the
name sweep re-requested all 238 dead ids on every build: Fansly does not return
deleted accounts at all, and a negative answer is not cacheable, so those Fansly
requests bought nothing. Kernel side, `entries[].deletedAt` (from
`fans.deleted_detected_at`, cleared as soon as any sync sees a name again) now
rides the `top-spenders` contract — chosen over the existing `pageDeletedFans`
route, whose `limit ≤ 200` cap is already below the 238 deleted fans this page
has today.

The field is `.optional()` in the contract and stays optional through the
vendored SDK, because the kernel deploys separately from the extension. Every
comparison in this repo is therefore `!= null`, never `!== null`: an older
kernel, or any row that predates the field, yields `undefined`, and
`undefined !== null` is true — the strict form would have marked EVERY row on the
board as deleted. `agency-hub-client` normalises the absence to `null` at the
boundary, so «this kernel does not report deletion» and «this fan is alive»
become the same value, which is correct: neither is a reason to mark a row.

Three behaviours change and one deliberately does not. A nameless deleted row
reads «deleted account» instead of its id; it carries a muted, border-free
«deleted» chip (a state, not an action — the dashed pill of «find chat» invites a
click this row cannot answer); and opening it does nothing.

That last one is scoped narrowly, and the scope is the point: THE CONVERSATION
OUTLIVES THE ACCOUNT. The early return fires only when the row is ALSO
unsearchable, and it sits after the existing `if (entry.groupId)` branch:

```ts
if (entry.deletedAt != null && !hasSearchTerm(entry)) return;
```

There are two independent ways a deleted fan's chat is still reachable, and both
are preserved. An already-enumerated `groupId` opens directly — a fan can delete
their account while the thread stays in the creator's inbox, and the chatter must
not lose the history of a spender who left. And a deleted fan who kept a
`username` or `displayName` still goes through the lazy inbox search: 29 of
`lora-1`'s 238 deleted spenders carry a name, so the resolver has a real term for
them, and deleted fans are by definition OLD — which makes their conversations
the ones most likely to sit outside the enumerated 150-conversation map, exactly
the case that search exists for. The unconditional return (the first version of
this change) removed a capability that worked before it. `hasSearchTerm` mirrors
the term `runtime-api`'s `resolveFanChat` builds (`username?.trim() ||
displayName?.trim()`), so the board's decision to search and the resolver's
ability to search cannot drift apart; `customName` is in neither, because the
chatter's private label never travels to the platform (E25). The «deleted» chip's
tooltip states that the conversation can still be opened whenever one of the two
routes applies, so an openable row does not look inert. Both directions are
pinned by tests that fail if the gate regresses either way.

Deleted fans also stay in the ranking — they really did spend that money, and
filtering them would stop the totals from adding up. The chip is not registered
in `chatStateChips`, and
`setChatState` returns early on `.chatgoose-board-row-gone`, because a repainted
row re-registers its chip by class: a resolve started while the fan was still
listed as alive could otherwise land afterwards and overwrite «deleted» with
«not found». That race is pinned by a test that fails without the guard.

The sweep gate covers the NETWORK half of `resolveFanNames` only, and the split
is load-bearing. That function does two things: it reads the durable
`spendersNames` cache in `storage.local`, and it issues the `/account?ids=`
batches. Filtering dead ids out before the call — the first version of this
change — skipped both, and the cache is exactly where a chatter's own rename
lives (E25 custom name, note type 12002, the name the team actually recognizes).
So a renamed fan whom the kernel later marked deleted would have collapsed from
«Max/Canada/45» to «deleted account» on the next build, while their spend stayed
in the ranking: a large ANONYMOUS row where a familiar one used to be, which is
worse than the numeric id this entry set out to remove. Platform names would have
survived (the mapping prefers `entry.displayName ?? names?.displayName`), so the
loss was specifically the most valuable name. Now every listed id gets its cache
lookup and only the network-missing set is narrowed to non-deleted ids — a cache
read costs no egress, so nothing about the Fansly saving changes. Ids outside
that set are also kept out of the progress total and the sweep budget: the
platform will never answer for them, so they are not «missing» in any useful
sense. Pinned by a test that fails against the filtered-too-early version.

The session cache key goes `spendersCacheV3` → `spendersCacheV4`. The whole
result, `entries[]` included, lives in `storage.session`, which outlives an
extension update by up to its TTL, and the read path normalises only the
top-level `pageLabel` (E69) — not inside the rows. Without the bump a V3 row
would have entered the board as a `SpenderListEntry` missing `deletedAt`, and
every deleted fan would have kept its numeric id and its unanswerable chip for
the rest of the session.

`isSpendersListResult` in `src/shared/protocol.ts` gains BOTH fields, and the
asymmetry between them is the point. `pageLabel` is checked as strictly required
(`string | null`, present): it never leaves the extension — the only producer of
`spenders:snapshot` is this same build's background — and E69 made it a required
field, so leaving it unvalidated let a snapshot without it narrow to a type that
promises it. That was a live unsoundness, fixed here rather than left for the
next reader. `deletedAt` is accepted as absent OR `string | null` and rejected
for any other type: it is the one field on this message whose origin is the
kernel, where the contract declares it optional by design, and absent already
means «alive» to every consumer.

**E71 (2026-08-01).** The action bar drops the persona pill and tightens its
density. The trigger was a screenshot: on the chatter's composer the bar was
scrolled sideways, `Reply` — the primary action — sat off the left edge, and the
first thing visible was the middle of the tone groove. Measured on a faithful
DOM specimen of the real geometry, the row needed **716px** of content against
a composer of **~605px** (derived from the screenshot: a 1210px crop at
retina ×2). Nothing was broken; there was simply more bar than composer.

**The pill carried three facts, and each one had a better home than 60px of the
row.** (a) The persona NAME (`Lora`) is something the chatter already knows —
they opened this account — so it moves to `Reply`'s own tooltip
(«Reply as Lora (⌘⇧R)»), the one control whose output the name actually
describes. (b) `Unmapped` repeated, word for word, the mapping banner that is
open directly under the bar in exactly that state, with a persona picker in it:
one fact, one place (E67), so the bar stops saying it. (c) `Not connected` — no
Fansly accountId — is the one state with NO second surface: `MappingBanner.render`
returns early without an accountId, so the bar would sit fully disabled and
silent about why. That case, and only that case, keeps a chip
(`.chatgoose-toolbar-warn`, amber — a problem, not a label). The pill was the
right idea in the wrong place: it paid its width on every message to be useful
on almost none.

**The rest of the savings came from density, not from removing controls.** Row
gap 6→5, bar side padding 10→8, button padding 11→9, tone segment min-width
30→27 with padding 7→5, seam margin 2→1, and the Recap ready-dot inset trimmed
to match its new padding. Together with the pill: **716 → 597px**, i.e. the
measured composer now fits with the bar in one row and no scroll. No control
was moved, collapsed into an overflow menu, or turned into an icon — the E24
meaning-groups, the visible four-tone groove (E24/E27) and the single right-pin
on Recap all stand exactly as they were.

**The remaining margin is 8px, and that is a known limit, not an oversight.** A
chatter on a laptop or with Fansly's right sidebar open will still scroll. Two
further options were mocked and measured against this same bench: wrapping to a
second row instead of scrolling (never hides Reply, costs ~38px of feed height),
and moving tone + Split into a pocket under Reply (fits from 432px, but takes
the four tones off the surface, against E24). Both were shown to the owner and
deliberately NOT taken now — this change is the uncontroversial half. If the
scroll comes back on a real composer, the wrap variant is the next step and
needs no new design work.

Tombstones: `.chatgoose-pill` (content only — the options/popup rule of the same
name is untouched), `.chatgoose-personality`, `.chatgoose-toolbar-pill` and
`.chatgoose-toolbar-personality-end` are deleted; they had no other consumer
once the pill left. `TabUiState.mappedPersonalityName` is unchanged and still
read — it just renders into a tooltip instead of a chip. The button-bar suite
pins the new shape: no persona text in the bar, the name present in Reply's
title (and absent when nothing is mapped), the chip hidden for an unmapped
account and shown when there is no accountId, and — with the warning visible —
Recap still the single toolbar child whose `margin-left` resolves to `auto`.

**E72 (2026-08-01).** The Recap "ready" dot becomes a corner badge, and the bar
takes a second density pass. E71 left the row 8px inside the measured composer —
too thin a margin to survive a laptop or an open Fansly sidebar, which E71 itself
recorded as a known limit. The trigger this time was the button, not the row: at
`padding-right: 18px` against the row's 9px, Recap was **9px wider than every
other chip and its label sat visibly off-centre** — a permanent reserve for a dot
that only renders when `hasAvailableSummary`, i.e. empty in the common state. The
dot now sits at `top/right: 3px`, ABOVE the label's cap height, so the reserve is
gone and the padding is symmetric again. Width stays state-independent (measured
identical with and without the dot): the dot appearing must never reflow a bar
that is one chip away from scrolling — the same rule E27 set for the tone groove.

**The rest is padding and gap only.** Row gap 5→4, button padding 9→8, tone
segment min-width 27→24 with padding 5→4, groove gap 2→1, and the seam margins
dropped (the row gap already spaced them — their own margins were doubling it).
On the same DOM bench that E71 used, `main` measures **594px** and this change
**542px**; against the ~605px composer the headroom goes from 8px to ~63px.
Nothing left the row: no label shortened, no control collapsed, and the E24
meaning-groups, the four-tone groove and Recap's single right-pin all stand.

Rejected, measured, on the owner's call: making Split icon-only saves a further
**34px** — the largest single win left in the row — but spends the word on a
control E24 deliberately gave a LABELLED checkbox to distinguish it from the
tone radio. The groove (107px after this change) remains the row's widest item
and the place to look if the scroll ever returns; folding Split into it as a
fifth segment is worth ~39px and is the same E24 trade, not taken.

**E73 (2026-08-01).** Split moves INSIDE the Reply options capsule, trades its
word for a square, and gains `⌘⇧L`; every control in the bar gets a real hover
hint. The trigger was the same screenshot habit as E71/E72 — the owner asking
what a 63px chip was buying — but the answer turned out to be structural, not
metric: `supportsReplyMode` is true for `fast-reply` ALONE, so Split is an
option of one button exactly like a tone, while it rendered as a raised chip,
i.e. as an action. E24's own rule ("actions are raised chips, options lie in the
sunken groove") puts it in the capsule; E24 kept it out because a checkbox among
radios could read as a fifth tone. **That objection is answered by form, not by
placement: an armed tone RISES as a light thumb, an armed Split is pressed INTO
the groove.** Two physics in one capsule; a hairline seam marks the boundary.
Width is state-independent in both, so arming still never reflows the row (E27).

The capsule is a new plain container: a checkbox cannot live inside a
`radiogroup`, so `.chatgoose-reply-options` carries the sunken styling and the
role stays on the inner `.chatgoose-tone-track`. Hiding now happens on the
capsule — hiding the track alone would strand the seam and the Split cell in an
empty pill. Split is `role="checkbox"` + `aria-checked` (was a button with
`aria-pressed`).

Measured on the E71/E72 bench: 542 → 507px, against a ~605px composer. The
icon-only variant that keeps the chip where it is was also measured — 509px, two
pixels apart — so the pixels did NOT decide this; the row simply has one fewer
free-standing element and one honest home for Reply's options.

**Losing the word forced the hints, and the hints are the larger half of the
change.** Every bar control used the native `title`: in Firefox a ~1s OS box,
unstyleable, unplaceable — no way to teach a row to a new chatter. The new
component renders OUTSIDE the bar (`overflow-x: auto` would clip a bubble drawn
inside it) and hit-tests hover on the CONTAINER rather than listening per
button, because disabled controls do not dispatch pointer events and the states
that most need explaining — `Fix` with an empty composer, the whole row with no
persona — are exactly the disabled ones. Bodies are thunks, so a hint reports
the CURRENT state. The combo is not repeated where a corner keycap already shows
it; the capsule's 24px cells have no keycap, so theirs carry it.

Hotkey letter `l` (spLit) — Firefox reserves ⌘⇧ R/T/P/B/A, and a test now pins
both facts (not reserved, not colliding with a bound letter). The cheatsheet and
the Options hotkeys pane render from the same table, and both are TOTAL records,
so the new action could not be added without being named in Russian for the UI.

Tombstones: `.chatgoose-toolbar-flag`, `.chatgoose-toolbar-flag-active` and
their `::before` are deleted — Split was their only consumer. The native
`title` is gone from every bar control; anything that must stay reachable
without hover lives in `aria-label`/`aria-keyshortcuts`, and the open hint is
announced through `aria-describedby`. Not touched: what Split SENDS (E49's
one-part violation note stands), its stickiness, and the tone groove's own
behaviour.

**E74 (2026-08-01).** Real-use feedback amends E73's hint timing and makes the
explanatory layer optional. The initial custom dwell shipped at 400ms, and once
one bubble was open the next anchor replaced it immediately. Crossing a compact
507px row therefore made controls speak before the chatter had stopped on one.
The first dwell is now **1000ms**; movement within an active hint group re-arms
on **250ms**, rather than swapping instantly, and the group returns to the full
dwell **300ms** after its last hint hides. Pointer movement resets the pending
anchor, so merely travelling across the row produces no bubble.

Storage schema **v16** adds `settings.showToolbarHints`, default-on for both new
and upgraded installs so E73 remains discoverable. «Вид» exposes it as
«Подсказки при наведении» through the existing serialized Settings
writer. `OperationCoordinator` carries the sanitized value in `TabUiState`, so
the ordinary settings-change refresh updates every open Fansly tab. Turning it
off is synchronous at the bar: an open hint hides, a pending dwell and group
grace are cancelled, and `aria-describedby` is removed. Pointer and focus
bubbles both stay silent while disabled; accessible names and
`aria-keyshortcuts` remain on the controls. A missing `TabUiState` field means
enabled, preserving behaviour during the brief old-background/new-content
overlap of an extension update. No kernel, contract, generation, send, or
Fansly-egress path changes.

**E75 (2026-08-01).** Performance work removes redundant local work; it does
not take product shortcuts. The global Fansly match remains because ChatGoose
must observe SPA navigation and expose its global actions, but the manifest now
starts only a small classic bootstrap: theme, launcher/hotkeys and route
watching. The full controller graph and `content.css` load as Fansly-scoped
web-accessible assets only on a current message route or an explicit ChatGoose
action. Live-path/route-nonce fences prevent a late import from creating the app
after its chat was left; cold actions that depend on `tab:state` wait for the
first snapshot; a visible manual Retry uses a fresh module URL so Firefox's
cached rejected import cannot poison every retry.

The bootstrap owns a separate reconnecting `chatgoose-bootstrap` port. This
preserves the previous best-effort MV3 lifetime for the five-minute persona
refresh before a chat opens without registering non-chat tabs in the operational
coordinator or Voice service. After the full app starts successfully its
`chatgoose-content` port takes over and the bootstrap port is retired. No host
permission was added, and the lazy web-accessible assets remain scoped to
`fansly.com`.

Steady-state storage reads request the fixed `PersistedState` keys plus only the
`summary:*` key needed by a specific correctness fence. An old schema or
incomplete v13 credential-custody layout still falls back to the complete raw
snapshot; the write-once persona-preservation barrier and future-schema
fail-closed behavior remain ahead of that path. `storage.onChanged` ignores
operational keys that own independent schemas/FIFOs while continuing to accept
dynamic summary keys. Storage schema, migrations, recap caches, identity rekey
and per-key credential custody are unchanged.

Rendering keeps keyed DOM nodes and listeners, updating text/state only when
data changes. Compare no longer repaints inactive cards, Coach streaming no
longer rebuilds/parses the full model per chunk, Voice repaint notifications are
coalesced through `requestAnimationFrame`, and an identical polled Voice status
does not mint another custody revision/persist/repaint (a completed attempt
without audio still retries the audio fetch). Scroll/layout measurements run
only for a surface that will actually render. The build also enables syntax and
whitespace minification without identifier mangling, keeps source maps, and
serves extension-page/content CSS as static files.

Unchanged: kernel contracts and prompt assembly, Fansly read/API cadence and
egress, AI call/cost semantics, human-send and indeterminate-retry rules, and
Voice at-most-once custody.

**E76 (2026-08-01).** The owner reverses E24's visibility choice for the
implemented secondary actions: Help, Review, and Compare return as direct
buttons in the action bar. A completed Compare result also exposes Reopen in
the same row while that result is restorable; without a cached result the
button remains hidden because it has no valid action. Existing prerequisites,
hotkeys, generation behavior, result surfaces, the Reply options capsule,
Coach, account-warning and Voice controls, and horizontal overflow behavior
are unchanged. No storage, protocol, kernel, prompt, retry, or send semantics
move.

### E77 — Help/Review results render the #201 blocks as structured sections (2026-08-01)

Owner feedback on the freshly deployed kernel Decision #201 output: the
content became dense and Russian, but the overlay still showed it as one
plain-text wall, so the important parts (the verdict, the money read, the
ready-to-send fixes) were invisible. Approved via a Было/Макс/Спокойный
mockup: the «Макс» variant with upright (non-italic) quote styling.

`src/content/overlay/analysis-blocks.ts` parses the labels the kernel prompt
now pins (Review evaluation: ВЕРДИКТ/ДЕНЬГИ/ПЕРСОНА/ОШИБКИ/ЧТО РАБОТАЕТ;
Help coaching: СИТУАЦИЯ/ЧТО УПУЩЕНО/СЛЕДУЮЩИЙ ХОД/РИСК) into headed
sections: verdict and next-move tinted clay, «что работает» green, mistakes
and recommendations split on `1.`-numbered items, and the «Как надо было:»
tail of a mistake rendered as a serif block on the draft background — the
existing coach-draft idiom for "text meant for the fan" (outer quotes
stripped only when a single pair wraps the whole message; the marker is NOT
line-anchored because real output puts it mid-sentence). Inline decoration
tints double-quoted transcript quotes clay and sets $-amounts in the mono
face; a money amount inside a quote stays part of the quote.

DISPLAY-ONLY by construction: parsing happens at render time; the stored
result, copy text, XML wire parsing, and acceptance flows keep the raw
string. Every entry point requires at least two labels (one accidental
«РИСК:» inside prose must not flip the layout) and returns null otherwise,
falling back to the previous plain card — which is exactly what pre-#201
cached results and format slips get. Recommendations follow the evaluation's
format (structured only when the evaluation parsed) so one result never
renders half-old, half-new. Model text is untrusted remote input: every node
is built with createElement/textContent, never innerHTML (same doctrine as
summary-markdown.ts). No storage, protocol, kernel, or prompt change.

### E78 — The recap joins the shared analysis language (2026-08-01)

Owner follow-up on E77: «кстати смотри там еще есть фан саммари, может
как-то объединить эт дело? привести к одному виду какому-то». Approved via
the same mockup (recap section added to the Было/Финал states).

`summary-markdown.ts` now recognizes the section names the kernel templates
pin (short recap EN: WHO / SPEND PATTERN / TRIGGERS / BOUNDARIES / ACTIVE
THREADS / NEXT MOVE; full recap RU with EN originals: ДОСЬЕ …​ СТРАТЕГИЯ)
after stripping the leading «N.» and a trailing colon. A known heading opens
a section container styled with the E77 header language: mono caps + a
semantic dot (money sections green, triggers amber, boundaries red, neutral
grey), and the strategy/next-move section gets the clay «what to do» card —
the same visual promise as СЛЕДУЮЩИЙ ХОД in Help — with its body switched
from the document serif to the working sans voice. Following blocks land
inside the open section; an unknown top-level heading closes it (so a recap
the model structured its own way degrades to exactly the previous look),
while `###` subheadings stay inside. Section numbers are dropped and the
short recap's English names display in Russian; the kernel prompts are NOT
touched — this is the same display-only doctrine as E77, createElement/
textContent throughout. The E77 inline decorator (`decorateInline`, now
exported from analysis-blocks.ts) runs over recap paragraphs, bullets, and
labels too, so money amounts and fan quotes read identically across Help,
Review, and the recap. The serif document body deliberately stays: the
recap is read as a dossier, Help/Review are scanned as working cards —
unification lives in the headers and accents, not in flattening the two
reading modes into one.

**Amended (owner feedback 2026-08-02):** inside the dense serif document the
10px ink-low section headers drowned between paragraphs («заголовки будто бы
теряются»). Recap headers regain the hairline separator and top padding the
old md-h2 provided (except the strategy card, which owns its frame; a
first-child section keeps no separator), one step of size (11px), and the
mid ink. The overlay Review/Help headers keep the lighter treatment: their
sans bodies do not swallow the header. CSS-only, scoped to `.chatgoose-md`.

**E79 (2026-08-02).** Help is now the zero-typing entry point into Coach,
following Core Decision #204. A toolbar click, H hotkey, or rerun of a cached
Help result opens Coach and dispatches `coachPreset: 'situation'` without a
client-authored `chatterQuestion`. The kernel returns its substituted canonical
question as `presetQuestion`; the extension stores that text in coach history
while the feed keeps the shorter label «Разбор ситуации». Preset turns use the
ordinary single-operation, auto-recap, cancellation, retry, acceptance, and
human-only insert lifecycle.

Coach answers now reuse E77's four-block situational renderer when its labels
parse, with the existing plain-text fallback otherwise. Exactly two drafts on
a preset exchange receive positional captions «Спокойный» and «Флирт»;
every other draft count keeps the ordinary titles. The standalone `help-me`
protocol, parser, cached-result view, and kernel route remain intact for older
clients and already-cached results. Physical cleanup is deferred until the
desktop app's `help-me` usage has been checked.

**E80 (2026-08-02).** The Help toolbar button is REMOVED (owner ruling on the
first E79 build: «мы же влили хелп в коача чтобы кнопки не было этой»). This
supersedes E79's spec default («the toolbar Help button stays») and the Help
part of E76's button restoration. Help's home is now INSIDE Coach: a
clay-accented «Разбор ситуации» chip sits in the empty state above the
prefill hints and leads the follow-up chips row mid-session; both DISPATCH
the kernel-owned situation preset (unlike the prefill hints around them, they
never touch the composer). The chip shares the hint class so the submit
preflight lock covers it. Hotkey H stays as the fast path (openCoachPreset),
and the Rerun of a cached standalone Help result still routes there; the
FEATURE_HINTS entry survives only to satisfy Record<FeatureType>. Review and
Compare keep their bar positions: Review now follows Ping directly.

**E81 (2026-08-02).** Owner feedback on the Coach panel, approved via a
«Было/Стало» mockup: the wait is opaque («не в кайф ждать непонятно че
происходит»), debug mode gives the coach nothing, section headers drown in
Help/Review the same way they did in the recap, and answers that arrive with
model-volunteered markdown render raw asterisks. Four display-only changes,
one decision:

1. *Wait narration.* The background already walks explicit profiler stages;
the coach pending bubble now narrates them. `operation:progress` grows an
optional `stageKey` (the stage that just STARTED), which coach-chat always
sends — a handful of tiny frames per turn; every other feature keeps the
debug-only cadence, and the quick-window seed reports page counts for coach
like deep features do. Content folds the live stage into the coach model
(`pendingWaitLabel` via `formatCoachWaitStatus` — three chatter-sized
phases: «Читаю переписку… n/k стр.» → «Собираю контекст…» → «Жду ответ
ядра…», unknown stages calmly bucket as context) plus a ticking elapsed
counter anchored at dispatch (`formatCoachWaitElapsed`, «47 с» → «1:23»).
The first streamed token swaps the wait row for the answer bubble — a class
flip on two nodes built once, preserving the streaming-mutates-only-a-text-
node discipline. A stale progress frame from a superseded op never captions
the live turn.

2. *Debug surfaces in the coach feed* (all keyed to debugMode via the
profiling snapshot's presence — llmSpend flows regardless and must not
decorate a non-debug feed). While pending: a collapsed «Отладка» `<details>`
with the live profiler log (open state survives updates; rows replaced).
On commit: the exchange retains a frozen `CoachTurnDebug` {profiling,
llmSpend, promptEcho} rendered as a mono footer — total/TTFB timings,
tokens/cost, and «Промпт ↗» opening the E28 viewer with THAT turn's token
(the feed outlives the active-op echo marker, so `onOpenDebugPrompt` learned
an optional per-exchange token; tokens stay in heap objects and this call,
never in the DOM — E28 holds). On failure: the profiler log on the
failed-attempt item shows where the turn died. Debug objects are
reference-stable per turn; the keyed renderer compares them by identity.

3. *Analysis headers unified* (amends E78's amendment): the recap's
strengthened header treatment — 11px, mid ink, hairline separator above
each following section — is promoted to the base `.chatgoose-analysis`
classes, so Help/Review read identically; tinted verdict/move/works cards
keep their own frames instead of a separator. CSS-only.

4. *Coach markdown.* Coach answers whose prose carries model-volunteered
markdown (`**bold**`, bold-only lines, dash lists, `#` headings) render as
blocks through `renderCoachProse` — the recap's structural builder reused
with recap-section styling OFF (a known section name must stay a plain
subheading in a 13px chat bubble, never a dotted card), and a line that is
one bold span promoted to a subheading. Plain prose keeps the raw pre-wrap
path byte-for-byte. Display-only: the stored raw answer, wire history,
draft parsing, and copy flows are untouched, and the createElement/
textContent injection contract still holds (the old «never becomes HTML»
test now pins exactly that against structural rendering).

**E82 (2026-08-02).** Owner feedback corrects the Recap storage/UI model: full
and short are independent results, not two values collapsed into one
`hasAvailableSummary` bit. They were already persisted correctly at both durable
layers: the extension uses `summary:<group>` + `summary-short:<group>`, and the
kernel generation archive records/selects separate `full` + `short` rows for
Coach/recap-status. The missing separation was above those stores.

`TabUiState.availableRecaps` now carries the two validated local slots; the old
boolean remains as a derived compatibility aggregate for an update overlap.
The ready dot answers "is either slot openable?" and therefore lights for short
too. Completed overlay surfaces also get bounded `recap-full` / `recap-short`
slots, so showing one never overwrites the other, and Refresh carries the
rendered result's mode instead of silently turning a short refresh into full.
A successfully persisted standalone or Coach recap projects only its own slot
immediately; a completed-but-unpersisted result remains visible for that run but
does not light the reopenable-result dot. Tab/popup reconstruction derives both
slots from validated durable storage after reload.

The Hub distinction remains intentional and precise: short is stored in the
kernel's two-slot generation archive, but it does not overwrite the separate
single `fan_profiles` dossier that other features consume as the durable full
profile. Consequently a short-only ready state never enters the full-dossier
retry path. No storage migration, SDK change, AI call semantics, or extra Fansly
egress is required. Suppressed/stale terminal operations still cannot update
either current-chat slot.

**E83 (2026-08-03).** The completed Review joins the recap's document voice
(owner ruling on a live #201 result: the working-card build read as broken
markup next to the recap — «сравни с рекапом просто»). This revises, for
REVIEW ONLY, E77/E78's split «the recap is read as a dossier, Help/Review are
scanned as working cards»: a Review is also a multi-screen text the chatter
READS, and rendering it as bare sans cards directly on the overlay surface is
why it looked unfinished — the recap owed its cohesion to the stream frame,
the serif document body, and terracotta staying scarce.

Display-only, on the shared analysis DOM: the structured evaluation and
recommendations now render inside ONE `chatgoose-stream` frame with a
`chatgoose-review-doc` modifier that re-voices the existing classes — serif
15px body, numbered mistakes/recommendations flatten from bordered working
cards to document entries («1.» in the margin, no box, no semantic-red chip),
and the «Как надо было» card stands on paper (`bg1`) because the draft fill
disappears against the frame's own draft background. The pre-#201 fallback
card path, Help's standalone overlay (a cached/legacy surface since E79/E80),
the coach feed's situational blocks, and copy/acceptance flows are untouched.

The same change fixes why the fix-card looked like a one-off glitch: the
marker parser only knew a bare «Как надо было:», while real output writes a
parenthetical placement between the phrase and the colon («Как надо было
(где-то после "Ok Lora 😘"): …») — on the motivating screenshot two of three
fixes drowned in item prose. `FIX_MARKER_RE` now accepts the parenthetical
(≤120 chars) and the note rides the card label in quiet lowercase ink
(«Как надо было · где-то после "Ok Lora 😘"»), keeping the WHERE from
outshouting the WHAT. Stored raw strings, wire history, and copy text remain
byte-identical; the createElement/textContent injection contract holds.

**E84 (2026-09-06).** The 2.0 release audit adds checks at asynchronous action
boundaries. Generation finalization rechecks active operation identity after a
fresh persona read, after recap persistence, and before delivering success.
Queued full/short recap writes also require that operation to remain active in
their existing newest-result/persona predicate. A browser storage write already
submitted cannot be cancelled atomically; these checks prevent abandoned queued
writes and late success without introducing rollback or deletion.

Paid Voice create rechecks account/group/fan/routeNonce immediately after its
custody FIFO acknowledgement and before Hub dispatch. Existing frozen request
identity, same-id recovery, and manual attachment semantics continue to apply.
Terminal Voice failures provide a support note id and a manager action without
inventing a provider cause absent from the status contract. A failure after
dispatch says symbols may have been charged; billed-null is not certain spend.
Inline Copy/Insert captures its originating result before awaiting completion;
acceptance cannot be attributed to a replacement result, and late feedback does
not redraw that result. Spenders and the cheatsheet own Enter/Escape while open.
Spenders takes focus in loading, error and result shells, traps Tab and late
underlying autofocus, and restores connected prior focus on close. Covered
Inline controls also cancel native Enter/Space activation and refuse Insert/Copy
callbacks; returning from a document shortcut alone does not stop native clicks.
Toolbar focus cancels stale hover dwell and detached/hidden anchors cannot open
hints. These are client lifecycle changes, with no new prompts or settings shape.

The Cabinet preserves the newest failed settings snapshot as dirty, displays a
persistent failure with explicit Retry, and reports failed account edits and
popup clipboard operations. Credential and future-schema fences still govern
retry. Account rename explains Enter/Escape and restores keyboard focus on
cancel. Status copy names actual information and the relevant block, independent
of column placement; secondary text is readable in both themes.
Persona connectivity checks now show pending and result text in the Persona
pane itself. A successful connectivity response does not assert that the
independent catalog fetch succeeded. Account ID copy and focus-tab failures are
visible beside the action; focus-tab requests remain single-flight.
The persona catalog date is labelled as a saved snapshot date. Identical catalog
polls intentionally avoid storage writes, so `personaCatalogFetchedAt` does not
measure the most recent successful poll; the E62 amber age badge is withdrawn
because an old unchanged snapshot does not prove stale synchronization.

Live Firefox testing also exposed Fansly creating its native textarea only on
focus inside a stable input host. Draft input/change observation now delegates
through the document while accepting only the existing strictly resolved active
conversation textarea. The first edit and replacement textarea update Fix and
Coach draft availability; unrelated fields remain outside this path. Native
draft reading and insertion semantics are unchanged.

Coach disables Send for an empty or whitespace-only question and updates the
control on edits, hint selection, restoration and submission. After a usable
Coach answer, an unavailable recap status is retried once through the existing
metadata read: the operation has now resolved the fan identity that a cold tab
may lack. Existing session identity checks reject a late response after close
or navigation; known statuses and stale/empty completions do not trigger it.
The standalone Recap picker waits for its initial metadata result before
enabling Open last, so a fast click cannot prefer an older full cache while a
newer short recap exists. Failed or invalid reads become unavailable under the
same picker fence and retain the existing local-cache fallback. Full and Short
remain explicit refresh actions and do not wait for this metadata.

The same live acceptance pass refines presentation without changing generation
contracts: Hi alternatives are labelled Variant with Choose one guidance in
both inline and expanded views, rather than implying sequential Split parts.
Completed read-only documents collapse profiling so the result leads; pending
operations and errors retain their diagnostic visibility. Spenders row
accessible names include fan identity and lifetime/month spend, while chat-state
help is linked through `aria-describedby` instead of replacing that identity
with a generic tooltip. Focused tests cover these changes; final GUI reloading
and release acceptance are tracked in `docs/release-2.0-acceptance.md`.

**E85 (2026-09-06).** The release SDK snapshot is generated from clean Core
`7fac98f310d673134c8dcb5dd6596e126e7f9e69`, independently identified by the running
API image revision and its committed SDK hash matching the public health route.
Generation uses Core's unmodified vendor script in an isolated clean checkout;
the working Hub checkout and production remain unchanged. The full generated
snapshot replaces the old `d19ee3a` pin, satisfying the exact deployed-contract
gate rather than weakening it. A second independent generation is byte-identical.

**E86 (2026-09-06).** `package.json` and `manifest.json` advance together to
2.0.0 as a local release candidate. README, install, guide and both changelogs
describe the Cabinet, Coach/Help, independent Recaps, Review, gated Voice and
current toolbar/Spenders behavior. Historical release text remains intact;
outdated present-tense guide instructions are superseded by the current paths.
Candidate labels remain until separately approved publication; no signing, feed
update or release announcement follows from this preparation. The public feed
was independently observed at 1.9.11. Writing research is a proposal for Hub
prompt experiments, not an implemented or measured model-quality change.

**E87 (2026-09-06).** The existing `install.html` becomes the ChatGoose 2.0
release landing page, retaining the self-hosted distribution path and the three
exact version-stamping slots used by both deployment scripts. The page extends
the paper/clay brand with Cyrillic Source Serif headings and product examples:
Coach scenarios, separate Recap formats, Review, and a light/dark Cabinet demo.
Examples are authored, fictional illustrations of the workflow, not captured
model results or claims about prompt-quality improvements. Spenders example
amounts follow the existing tier boundaries; Help is shown inside Coach.

The two tab groups support click, arrow/Home/End keys and roving focus; the
Cabinet theme switch changes only its local example. These controls make no
network or AI requests. CSS and script are inline, and the existing 128px icon
is embedded unchanged, so the landing adds no upload dependencies to the static
page deploy. The existing external font source remains in use. Installation
links name the current published build and target the production XPI explicitly,
including in local previews. Candidate and Voice readiness labels remain until
the corresponding release and live acceptance gates are satisfied.

**E88 (2026-09-06).** `whats-new-2.html` is a separate, practical release
walkthrough for existing ChatGoose users. The general `install.html` landing is
preserved. The new page covers only additions and changes in 2.0, explaining
entry points, work steps, context limits and retention rather than repeating the
full product catalogue. Its Cabinet explorer is a local seven-tab reference;
clicks do not change extension settings. On small screens Recap comparison rows
place their shared label above two readable format columns.

Implementation details were checked against current code: Coach uses the quick
window directly and obtains deep context through Recap; its memory and recap
storage have different lifetimes. Voice tone selection precedes script editing
because a tone change regenerates the script. The page retains candidate and
incomplete live Voice acceptance disclosures. This alternate page is not wired
into signing, the update feed or public deployment by this change.


**E89 (2026-09-06).** At the owner's request, the chat action bar removes
Compare entirely, together with its contextual Reopen button. This supersedes
the Compare/Reopen visibility parts of E76 and E80: Review now leads directly
into Recap. The button nodes, hover hints, prerequisites, event callbacks and
content-side reopen affordance checks are deleted. No replacement menu or
shortcut is introduced. Compare has no entry in the shared hotkey table.
The existing compare protocol/engine and result-handling code are retained;
this UI removal does not change storage, prompts or shared SDK contracts.
Current guide entries advertising Compare are removed; historical changelog
entries and generated architecture maps remain historical evidence.

**E90 (2026-09-07).** The release walkthrough and both changelogs include
the separately implemented Hub prompt work from `1746d006`, `f3bb7888` and
`1702c086` (Core Decision #252): Reply structural instructions and varied
positive examples, Fix draft-length examples, and revised Hi/Ping register.
The page labels these as prepared, pending Hub rollout. It also describes the
already-deployed Help/Review citation and next-action behavior (Core #201/#203).

Fresh read-only inspection found the running API image labelled
`agency-hub.source-revision=2475b3046332`; none of the three September prompt
commits is its ancestor. Its prompt tree matches the previously observed
`7fac98f` tree exactly. The running compiled `api.js` independently contains the
old Reply structure and Fix ban-list headings, while the new Reply v10 end-task
self-check, structural sentence and Fix one-liner sentence are absent. This
supersedes any inference that a newer API revision necessarily includes those
prompt changes. The September 6 research remains a historical read-only report;
the later implementation is distinct work. No prompt, model, persona, Hub
configuration or deployment is changed here.

The two landing examples are copied from the prepared prompt templates and
labelled as instructional examples, not observed generations. No judge win rate
is presented as a general quality or conversion metric. Prompt publication is
independent of installing the extension. Remove the pending label only after
the actual Hub rollout is verified.


**E91 (2026-09-07).** The owner clarifies the audience rule: every proposed
fan-facing message is English, regardless of the language of the fan, chatter,
source draft, persona notes or history. This supersedes the fan-language wording
in E79/E80 and earlier Help/Review descriptions for proposed messages only.
Help/Review analysis remains Russian; ordinary Coach advice follows the
chatter's language. Evidence quotes retain their original language.

The separate Hub patch applies this rule to Coach, Help, Review replacements,
Fix, Reply, Hi, Ping and generated Voice scripts. It removes competing
fan-language instructions and keeps Russian explanations outside draft fences,
suggestion tags and quoted replacement messages. The patch is pending rollout:
changing this extension or its documentation does not publish server prompts.
The earlier deployed citation/structured-analysis improvements remain distinct
from this pending language correction and the separate E90 style rework.

The client preserves the original Coach draft but disables Copy/Insert when it
contains Cyrillic, checking again at the acceptance boundary. This is a targeted
Cyrillic detector, not an English-language classifier: other languages can pass,
and an English sentence containing a Cyrillic name can be blocked. No automatic
translation, paid retry or silent text deletion is introduced. Review rendering
separates a clearly quoted replacement from following commentary; ambiguous
quoting retains the original text rather than guessing away content. Protocol,
SDK and storage shapes are unchanged. Final verification, packaged artifacts
and deployment evidence are tracked in `docs/release-2.0-language-fix.md`.


**E92 (2026-09-07).** The owner chooses one continuous release journey.
`install.html`, deployed as `index.html`, remains the ChatGoose product landing.
Its normal Reply/Fix/Hi/Ping introduction leads into a concise 2.0 section,
Coach example and linked feature cards. Voice has one full example on the main
page. The detailed scenarios, settings reference and limitations live in
`whats-new-2.html`; `guide.html` explains normal use and `changelog.html` keeps
the chronological archive. The four pages share paper/clay colors, Cyrillic
Source Serif headings, Hanken Grotesk text and the existing brand asset.

This supersedes E87's release-only main-page framing, duplicate Recap/Cabinet
interactive examples on that page and three mutable landing version slots.
The detailed examples remain in the walkthrough; the main retains its three
Coach scenarios. Only its footer is version-stamped now. The fixed 2.0 title,
URL and navigation label are historical content, unaffected by later version
bumps. E88's local-alternative-only deployment status is superseded: both
release scripts preflight, upload and verify the walkthrough. Its atomic
rename precedes the new latest XPI, update feed and pages linking to it. All
existing signing, clean-main, exact SDK and announcement gates remain.

Settings and the popup expose a prominent "Что нового в 2.0" web link plus
a separate "История версий" link. Settings retains E59's seen-version marker
and failure behavior. Popup links remain available when runtime status cannot
be read. No automatic tab opening, settings migration or AI request is added.

The optimization section is based on changes after published 1.9.11: lazy chat
UI loading and incremental/batched streaming rendering (`d9d54a0`), independent
completed recap results (`5ff8d49`) and visible Coach stages/elapsed time
(`aaa75b7`). The 1.9.11 tag and the separately recorded deployed revision have
identical trees. Progressive Spenders snapshots (`ea35aaba`) were already in
that release and are not claimed as new. No latency, token or percentage gain
is asserted without measurement; pending Hub cache work is not presented as
a deployed browser optimization.

Three independent GPT-6 Astra reviewers checked the implemented interfaces,
copy and publication path. Follow-up fixes remove duplicate mobile navigation,
synchronize Cabinet tab orientation with its layout, preserve archive text on
320px screens and clarify Review examples. Keyboard interaction, local links,
responsive layouts, release scripts and the complete client check are recorded
in `docs/release-2.0-landing.md`. This is prepared local source and preview, not
a website publication, Hub deployment, signed release or Firefox installation.
E90/E91 prompt rollout and live Voice acceptance remain separate pending work.


**E93 (2026-09-07).** The owner asks for a stronger feature presentation and
a little more technical information in `whats-new-2.html`, with Voice first.
Voice now leads the overview, navigation and numbered sections. The compact
overview cards open each section; Voice has an interactive text/takes/attachment
reference. Its example is authored and explicitly contains no playable audio.
Tone names are informational text, not inert buttons. Cabinet and Voice tab
groups maintain independent selection and accessible keyboard behavior.

Each major feature leads with a practical result and a short parameter strip.
Expandable details explain Voice profiles/output/recovery, Coach context,
Recap freshness, Cabinet storage/diagnostics, Hub prompts and incremental
rendering. Existing public fragment URLs and release-stamping rules remain.
The page identifies Voice defaults as profile defaults, not observed settings
of a particular account: ElevenLabs `eleven_v3`, `mp3_44100_128`, an advisory
600-character editor guide and a 14-characters/second duration estimate.
Multiple takes, character spend and manual attachment/send boundaries are
checked against the current client and Hub source. No speed, audio-quality or
live acceptance result is invented.

Prepared prompt work and incomplete paid Voice acceptance retain their labels.
This changes only the walkthrough presentation and its documentation, not
extension runtime, Hub configuration or publication state. Independent
GPT-6 Astra source and interface reviews, local route/tab/details checks and
320/390/1280px visual verification are recorded in the landing acceptance log.


**E94 (2026-09-07).** The owner finds the walkthrough copy too dry. Its
introductions, feature headings, examples and supporting labels now start from
familiar work situations: answering with a voice note, asking Coach about a
draft, returning to an old chat and finding a setting. The register is direct,
conversational Russian with restrained use of the Goose brand. Technical
parameters, audience-language rules, model/profile defaults and pending release
conditions remain explicit. Prompt improvements are described as instructions
and goals, not guaranteed model behavior.

This is a copy-only revision of E93. DOM structure, element attributes, CSS, JS,
links and interactive state behavior remain unchanged. An independent GPT-6
Astra editorial review checked tone and unsupported promises; its two wording
clarifications were incorporated. Browser layout checks and a structural
comparison are recorded in the landing acceptance log.


**E95 (2026-09-07).** The owner finds the main page too focused on 2.0. The
versionless product landing now introduces the entire ChatGoose workflow:
Reply/Fix/Hi/Ping examples, four tones, personas and Split, then Recap/Help/Review
and a standalone Spenders section. A chapter navigation exposes that breadth
after the hero. The hero's secondary action opens product capabilities and its
supporting copy identifies Agency Hub access as a requirement.

This supersedes E92's large three-scenario Coach example, five release cards
and separate Voice example on the main page. Those main-page presentations
and their unused styles are removed. One compact 2.0 chapter follows the core
features, leads with Voice and links to the detailed walkthrough. The E93/E94
Voice-first walkthrough, approved copy, release-readiness labels, historical
2.0 URLs and footer-only version stamping remain unchanged.

The main writing examples are authored local UI states, not live generations.
They switch between four scenarios with one visible panel and roving keyboard
focus. Below 800px the list becomes a compact horizontal row; its ARIA
orientation and arrow-key behavior track viewport changes. The fan dossier and
Spenders table use explicitly fictional data. AI never sends automatically.

The existing capabilities were checked against published 1.9.11. Conversational
Coach, independent short/full Recap results, the Cabinet, Voice and prepared
prompt changes remain in the separate 2.0 chapter. Copy does not claim that
streaming itself is new, that persona bindings originate in Hub, or that the
pending Hub prompt work has deployed. Independent GPT-6 Astra editorial and
visual reviews, responsive interaction checks and release-page validation are
recorded in `docs/release-2.0-landing.md`. This revision changes the local landing
and documentation only.


**E96 (2026-09-07).** The owner finds E95's compact release chapter too quiet.
The main now exposes a 2.0 announcement above the product hero and places the
expanded update chapter after the everyday writing examples. The hero,
Reply/Fix/Hi/Ping, personas, tones, Split, Recap/Help/Review and Spenders remain.
Chapter navigation follows the new reading order.

This supersedes E95's six small release links at the end of the core catalog.
Voice leads with a text-to-attachment illustration and a walkthrough link;
Coach and the two Recap formats have illustrated stories. Cabinet, prepared
prompt work and rendering optimizations follow in smaller linked descriptions.
The overview CTA is visually prominent. The approved detailed walkthrough is
unchanged. Voice examples contain no audio or playback control, generation
cost and Hub setup remain explicit, and publication readiness is unchanged.

Short Recap takes up to 300 messages; full Recap defaults to 3000 and exposes
its own depth setting. The illustration's note identifies that distinction.
The expanded main adds no AI call or new interactive example state. Independent
GPT-6 Astra editorial and desktop visual reviews and responsive verification
are recorded in `docs/release-2.0-landing.md`. No publication or runtime change.


**E97 (2026-09-07).** The owner requests fresh independent critics and a large
Telegram changelog. Three GPT-6 Astra agents review interface consistency,
source accuracy and announcement copy. Valid findings are fixed in the guide:
current action and tone names, Hi and Spenders coverage, accurate Coach context,
the pending English-only rollout, and a complete hotkey reference. Landing links
open the relevant guide fragments. Existing public anchors remain available.

Guide FAQ controls now use native details/summary with keyboard focus and
unclipped answers. Narrow-screen navigation no longer obscures anchor headings;
reduced-motion preferences are respected. Unsupported cache-limit and aggregate
deep-timeout claims are removed in favor of the actual storage and staged
operation behavior. These are documentation and page-interface corrections;
extension runtime is unchanged by this pass.

The Telegram draft contains four detailed messages, with Voice first and
specific changes to Coach, Recap, settings, prompts and rendering. It describes
preparation and keeps incomplete Voice acceptance and separate Hub rollout
explicit. Its public bodies are separate from editor-only evidence and release
checks. No Telegram message is sent. Page verification, independent final review
and a fresh read-only production snapshot are recorded in
`docs/release-2.0-pages-review.md`. Publication and signing remain unperformed.


**E98 (2026-09-07).** The owner asks to check how ChatGoose announcements
were actually written before. Read-only history from the configured ChatGoose
Telegram channel provides the primary style reference: version heading,
short release summary, grouped change bullets and specific technical details.
The 1.3.0, 1.4.x and 1.5.0 posts are the principal large-release examples;
1.2.x prompt updates show the same direct treatment of prompt changes.

This supersedes E97's four-message tutorial-style announcement. The revised
draft is one substantial release post: Voice first, then the other additions,
fixes and implementation details, without imagined work scenarios, repeated
introductions or transitions between installments. Existing features are not
reintroduced as new. The preparation status and pending Voice/Hub work remain
explicit; internal publication checks are kept outside the post body.

E39 already uses Rich Markdown `sendRichMessage` with a 32768-character local
validation limit, so the draft is validated as one post rather than split at
the plain-message limit. The draft remains separate from the automatic
announcer's `CHANGELOG.md` input until release copy is finalized. No posting,
deployment or runtime change is performed by this editorial revision.


**E99 (2026-09-07).** The owner wants the Telegram copy written for the
completed release, not as a preparation announcement. This supersedes E98's
preparation tense in the post body. The draft now opens with the release
announcement and describes the shipped client, pages and Hub prompt changes
in completed/present tense. Voice requirements, paid takes and the actual
limits of language checks remain part of the feature descriptions.

The separate editor note identifies this as copy for release day. It retains
the pending acceptance and deployment conditions and does not treat the new
wording as proof that production changed. Only the announcement draft and
editorial records change; no deployment, publication or message sending occurs.


**E100 (2026-09-07).** The owner asks whether the approved announcement will
actually be sent with the same formatting as earlier releases. The audit finds
that the standalone draft is correct but the real CLI still extracts the old
short preparation copy from CHANGELOG.md. The full E99 release-day body is now
the canonical `## 2.0.0` entry; older release entries remain unchanged. The
editor-only notes stay outside the send input. Exact output equality is checked
after extraction and composition, including the release heading.

Read-only Telegram retrieval confirms that published messages 48, 54, 55 and
57 are complete RichMessage objects for 1.6.0, 1.9.8, 1.9.9 and 1.9.11. Their
native heading/list/bold/code blocks explain why the generic history reader
returned an empty plain text field. The existing E39 sendRichMessage adapter
is retained unchanged. CLI preflight, 34 announce tests and an offline capture
of the exact outgoing Markdown pass. No live test post or release is sent.


**E101 (2026-09-07).** The owner recalls the Sonnet 5 low migration that the
production-only check missed. The prepared Hub branch worktree-prompt-audit-fixes
contains commit 298bb6f32a6ebd2b55feb71f9f250110a204d635 (Decision #252): Sonnet 5
with low effort for Reply/Ping and the delegated Fix/Hi/voice-script policies,
plus pricing and provider-request coverage. Help/Review/Coach retain Sonnet 4.6
medium; Recap retains Opus 4.6. The change is implemented and committed, while
the inspected main and production build still use the previous defaults.

The release-day announcement now includes this scoped model change in both
CHANGELOG.md and its review draft. The editor-only checklist requires deploying
the prepared Hub work before the announcement describes it as shipped. The
earlier production observation remains valid; it must not be generalized into
a claim that the migration had never been implemented. No Hub code, merge,
deployment or AI generation is performed by this documentation correction.


**E102 (2026-09-07).** The owner explicitly extends the prepared Sonnet 5
low defaults to Help, Review and Coach without requesting another comparative
generation test. This supersedes the retained Sonnet 4.6 medium scope in E101:
Reply, Fix, Hi, Ping, voice-script, Help, Review and Coach now belong to the
prepared Sonnet 5 low change; Recap remains on Opus 4.6. The Hub implementation
is prepared in worktree-prompt-audit-fixes on top of 298bb6f3. E101 and the
earlier production observations remain historical evidence, not the final
release scope. No measured improvement to analysis quality is asserted.

The canonical CHANGELOG.md section and its Telegram draft are synchronized
through the actual extractor/composer. The editor checklist requires the
additional Help/Review/Coach changes, not just 298bb6f3, before publication.
The exact post artifact, character count and SHA-256 are refreshed; only the
read-only announcement preflight runs in this documentation pass. No message,
release or deployment is sent by this change.


**E103 (2026-09-07).** The owner-authorized Hub rollout is confirmed by
`/Users/dmitriy/Documents/Codex/2026-09-07/chatgoose-hub-release/verification.json`,
recorded at 2026-09-07T17:54:39.300397+00:00 (20:54:39 Moscow). Production source
is b123b54b98e1b169d3b17cc5f9b749c1e62a2520. The deploy exits 0, API and sync
health return 200, and api/worker/scheduler are healthy. Production and local
API artifacts match; the local Hub CLI is rebuilt at the same source revision.

The deployed stack includes E90 prompt changes, the restored E91 English-only
audience boundary and all eight E102 Sonnet 5 low defaults; Recap remains on
Opus 4.6. The prepared branch Decision #252 is renumbered to Hub #273 on
integration. Compiled proof records nine English-only template occurrences.
This confirms delivery of the instructions, not guaranteed model compliance
or measured analysis-quality gains. Earlier production snapshots and E101/E102
preparation records are retained as history.

PR https://github.com/goslingmanagment/core/pull/146 is still awaiting
Static/Quality Gate and main merge at receipt time; deployment is not evidence
of a completed merge. Extension signing/feed/pages, exact SDK compatibility,
paid Voice acceptance and Telegram publication remain separate unfinished
gates. Only the draft editor checklist and these records change: the canonical
post stays 10990 characters with SHA-256
bbe2bde54faef906484ed39d7d1d4355761eaff429a3e48433f82fa84cf13547.


E103 completion at 2026-09-07T17:55:53Z: PR #146 passed Static, all three
Integration shards and Quality Gate, then merged as
`d575cfa84d4c908d4e5db0bbf50a49e8981b4d12`. Local main is fast-forwarded.
The merged and deployed commits have the same git tree
`55f2493f6a876d6c30e74272f519648bef557fdc`; their diff is empty. Production and
its pinned CLI retain the verified source revision b123b54b98e1, whose tree
matches the squash merge. The receipt now records both identities.

**E104 (2026-09-08).** The owner authorizes publishing extension 2.0.0 and
the prepared Telegram announcement after the E103 Hub rollout and client
compatibility check. The landing, fixed 2.0 walkthrough, changelog and README
now use release-day status dated September 8; earlier candidate observations
remain historical. Hub owns all model selection; the detailed changelogs name
the eight Sonnet 5 low features and retain Opus 4.6 for Recap. README links to
that record instead of embedding provider selection in client setup prose.

The approved outgoing Markdown remains byte-identical to E103: 10990 Unicode
characters, SHA-256
`bbe2bde54faef906484ed39d7d1d4355761eaff429a3e48433f82fa84cf13547`.
The sender and destination were independently resolved through Telegram:
`@gooseadminposterbot` to ChatGoose / `@goosemusechat`, channel
`-1003807184653`. The release script's announcement can be deferred with
`SKIP_ANNOUNCE=1` until the signed public XPI hashes are independently checked;
then the existing announcement CLI is called exactly once. An indeterminate
send requires reading the channel before any retry.

Voice remains an administrator-enabled, account-specific feature. A fresh
read-only check through the configured production service proxy returned
`missing_permissions` for subscription and voice metadata with the active
key; this does not establish its billing state or a synthesis failure. The
existing voice profile is present. Paid audio generation, listening, native
attachment and a fresh installed-Firefox run are not claimed as completed
by this publication. No payment, synthesis, Voice flag or key change is part
of this release operation.

Before committing, the final client check passed: 111 test files / 2108 tests,
typecheck, lint, cutover gates and build. Publication still requires the
normal clean-main, CI, exact production SDK, signing and served-feed gates.
Release receipts are collected under
`/Users/dmitriy/Documents/Codex/2026-09-08/chatgoose-2.0-release/`; a backup of
the previous public pages, feed and signed 1.9.11 packages was made before
deployment. This entry records authorization and preparation, not a completed
upload or delivered Telegram post.

**E105 (2026-09-08).** The 2.0 release SDK is regenerated in full from clean
Core `d575cfa84d4c908d4e5db0bbf50a49e8981b4d12`, whose git tree equals the
E103 deployed `b123b54b`. This supersedes E85's older production snapshot for
the upcoming signed package. The current production contract and generated
manifest both equal
`da876ec6191cf75b84db068747a43f17e878ad3789a224f49d8a9fcc2e24654b`.

The isolated source `/tmp/chatgoose-sdk-source-20260908` stayed clean after
official `pnpm contracts:generate` and `node scripts/vendor-sdk.mjs` runs.
All 83 generated files were verified against the saved per-file SHA-256
receipt; there were no hand edits or dirty-source override. The complete
extension check passed with this exact snapshot. The generated vendor and
this provenance record form their own commit, preserving the E37 exact
production-contract release gate rather than bypassing it on the basis of
the narrower AI compatibility check.

**E106 (2026-09-08).** The release PR's first CI run (`34165613928`) exhausts
the Node heap near 2 GiB in the three OperationCoordinator test partitions.
An unchanged local run with `NODE_OPTIONS=--max-old-space-size=2048`, `CI=true`
and two workers reproduces the same three worker failures. The ordinary local
Node runtime has a larger default heap, so its earlier green result did not
exercise this constraint.

`operations-suite.ts` now retains the actual `@kernel/sdk` module through a
transparent Vitest factory across its per-test `vi.resetModules()` calls.
The generated SDK/Zod graph is loaded once per isolated test file; stateful
application modules still reset for every test. No SDK export, schema, test
assertion or production behavior is replaced, and no CI heap limit is raised.
All 151 tests in the three affected files pass at the same 2 GiB limit and
two-worker setting after this change. The full check and GitHub CI remain
mandatory before signing; the failed run is not bypassed.

The complete `NODE_OPTIONS=--max-old-space-size=2048 CI=true pnpm check`
then passes: 111 files, 2108 tests, typecheck, lint, gates and build. GitHub's
rerun will validate the same change on its Node 22 Linux runner.

**E107 (2026-09-08).** A fresh mobile review of the published 2.0 walkthrough
finds no page-wide overflow at 320–1024 CSS pixels, but its overview descriptions
share a narrow column with the link arrow. At 320px the longest title exceeds
that column and leaves less than 1px before the arrow. Voice/Cabinet tabs and
standalone footer links also have smaller tap areas than the mobile target.

Below 580px, overview descriptions use the full card width with 13px text;
arrows occupy only the heading row. At 365px and below, tighter side padding
and column gaps give the title more room, with an emergency word-wrap fallback.
Navigation, standalone footer links and example tabs have a minimum 44px tap
height below 850px. This is CSS-only: the approved copy, fragment URLs, example
behavior and extension package remain unchanged.

Fresh browser checks cover 320, 360, 390, 430 and 768px plus both sides of the
580/700/850px breakpoints and desktop widths through 1280px. All six technical
disclosures open, all seven Cabinet panels switch, Voice steps switch and
mobile arrow-key navigation wraps correctly. DOM measurements find no outer
overflow, including with every disclosure open. The evidence is browser viewport
testing, not an on-device Safari or full assistive-technology acceptance test.
Current screenshots and measurements are recorded in
`docs/release-2.0-mobile-review.md` and its linked local evidence folder.


**E108 (2026-09-09).** The owner shows the flip side of E91: a Russian-speaking
fan (Serbian and Russian, the whole thread in Russian) pressed through Fix
receives an English message, because the Hub's #201 amendment made every
proposed fan message English regardless of the fan. Hub Decision #283 replaces
that blanket with the precise rule the amendment was reaching for: every
proposed fan message is written in the fan's language, where the fan's language
is English unless the fan's OWN transcript lines (`Fan:`) are in another
language, and the chatter's draft, question, coach history, recaps, dossier and
persona notes are never a language signal. The rule is identical for Reply, Fix,
Hi, Ping, Voice Script, Coach (including the situation preset), Help and Review
replacements, so no follow-up action flips the language. That prompt change
deploys with the Hub, not with this extension.

This extension keeps E91's Cyrillic guard on Coach Copy/Insert but scopes it to
the same signal. The background measures the fan's own text lines in the SAME
windowed transcript it ships to the kernel (`fanWritesCyrillic`, a script
detector, not a language classifier) and reports it in the typed
`CoachTurnContext`; the validator accepts only an optional boolean there. The
draft card and the acceptance boundary both honour it: a Cyrillic draft is
blocked, with the E91 note, only for a fan who never wrote Cyrillic; an absent
flag (an older background) keeps the guard fully on. The Review replacement
parser is language-agnostic for the quoted wording and needs no change. Kernel
SDK, storage and the kernel request shape are unchanged; the only protocol
change is the new optional field on the background→content turn context.
Copy/Insert still never happen without the chatter's click, and nothing is
translated or regenerated automatically. Tests cover the helper (fan-only
lines, model-side Russian ignored, system lines ignored), the validator, and
both guard branches in the overlay.

**E109 (2026-09-09).** The owner asks to fold the one-off SEX-001-CLEAN vault
queue (a console script that pushed 108 prepared files through Fansly's own
«Upload to Vault» form one at a time, verified by the album card, with a
localStorage checkpoint) into this extension as a first product: pick a folder,
preview the order, run, get a checked result — and survive an interruption
without the owner at the keyboard. The extension already owns the mechanism:
the Voice attach adapter's content-world DataTransfer handoff with the
page-context Xray fallback (E52), the launcher-plus-lazy-module bootstrap, and a
per-tab account identity in the background.

Design. A `content-vault.js` lazy ESM, loaded from a bootstrap-owned «Загрузка»
launcher that exists only on `/creator/vault`; the conversation app is never
loaded for it and it never loads the conversation app. The panel is a docked
card, not a modal, because the chatter still has to expand the form and scroll
the album. The pure half (`shared/vault-upload.ts`) builds the plan — natural
sort, extension-less NFC lower-case match keys because Fansly rewrites `JPG` to
`jpeg` on its cards, subfolders and unsupported files ignored and reported,
duplicate keys and empty picks blocking, non-ASCII names a warning — and derives
the upload sequence from the album order the chatter wants (Fansly lists the
newest first, so «первый файл сверху» uploads the last file first). Every Fansly
selector lives in one adapter with the date it was last seen working; the
runner reads a typed view and never learns Angular tag names.

Reliability is the product. The runner hands over one file, polls the album,
and moves on only after the card exists with no processing or failure marker,
the form is idle, and the new card is first; it re-reads the page after the
checkpoint write so a change in that gap is a definite stop rather than an
unknown. The checkpoint (`vaultUpload:<account>:<album>`, an operational store
outside `NORMALIZED_STORAGE_STATE_KEYS`, no schema migration) records the
in-flight name BEFORE the page sees the file. A file the page never confirmed —
timeout, indeterminate dispatch, the album or route changing mid-file, an
internal exception — becomes «неизвестно» and is never re-uploaded on the
panel's initiative: the chatter looks at the album and answers «есть»/«нет»
(same family law as an indeterminate send). A visible ready card auto-resolves
the question. A Fansly-reported failure is the one definite negative and is
retried only through the explicit «Продолжить». The queue is bound to the
account the background attributes to the tab (new `getTabAccountIdentity`
request, memory and the local label store only, null rather than a guess) and
to the album title read when Start is pressed; Start stays disabled until the
account, the album and the expanded form are all present.

Egress: none. Every byte goes through Fansly's own uploader in the chatter's
tab, exactly as a manual pick would; no request is added (same class as the
Voice attach, DP 1-B unaffected). Not in this change: local file preparation
(metadata strip, HEIC, transliteration stays the owner's script), the user
guide chapter, and a live re-verification of the selectors on the current
Fansly build — the adapter shows what it detects (account, album, form) before
any upload, so a redesign fails visibly in the facts row, not silently
mid-queue.

**E110 (2026-09-10).** Release 2.1.0 from `main` (95b6ca3 + this release
commit): the vault uploader (E109) and the scoped Coach Cyrillic guard (E108),
plus the mobile walkthrough fix (E107). Package and manifest are 2.1.0; the
committed changelog/install stamps read v2.1.0 so the repository matches what
deploy.sh serves. CHANGELOG.md gains the 2.1.0 section that becomes the
Telegram announce (preflight: 2914 chars, markdown subset clean);
changelog.html gains the matching block above 2.0.0 with the fixed 2.0
walkthrough left untouched; guide.html gains a versionless «Загрузка в волт»
chapter, feature card and nav link; README lists the feature and the date.
No Kernel SDK change (vendored contract da876ec6… — deploy.sh asserts it against production health before signing), no storage
migration, no new Fansly egress. Not verified in this release pass: the vault
selectors against the current Fansly build — the panel's facts row (account,
album, form) is the visible guard for that, and the chapter tells the chatter
what green means.

**E111 (2026-09-10).** The owner asks that the vault uploader (E109) cost
ordinary chatters nothing and be optimized in its own right. Measured first:
the «Загрузка» launcher, which lives in the classic bootstrap every Fansly page
runs, imported the panel's copy object for two strings, and esbuild cannot
tree-shake object properties — 20.6 KB of the 42 KB `content.js` was Russian
panel copy parsed on every page by every chatter; the launcher also appended
its root node to every page at bootstrap and ran a second 500 ms route timer;
the panel's 476 CSS lines rode in `content.css` for every conversation. On the
vault page itself the runner (1.5 s) and the panel (1 s) each walked the whole
album with innerText on every tick, every runner snapshot triggered another
read and a full re-render, and the render rebuilt the notes, the status and
the resume question every second — the focused «есть/нет» button was
recreated under the chatter's pointer once a second.

Decision, shared path first. The launcher owns its two strings
(`vault-launcher-copy.ts`) and its stylesheet (`vault-launcher.css`), installs
both on its first mount on `/creator/vault` and removes its root on unmount;
the panel sheet ships as `vault.css`, fetched with the module on the first
press (the tokens and shared buttons still come from `content.css`, so the
sheet is never installed alone); route polling is one shared interval per
bundle, subscribers come and go. `content.js` is 22 KB, of which ~3 KB is the
launcher; `bootstrap.css` and `styles.css` are byte-identical to their
pre-E109 state. The contract is pinned by a bundle-composition test that reads
esbuild's metafile: the bootstrap carries the launcher only (ceiling 28 KB)
and the vault module carries neither the chat app nor the settings graph.
While at it, all bundles are emitted as UTF-8 instead of `\uXXXX` escapes —
Firefox decodes every path we load scripts through as UTF-8 — which is a pure
size cut (content-chat 447 → 408 KB, background 1.23 → 1.16 MB).

Decision, the feature itself. One mutation-gated reader
(`createVaultViewReader`) serves the panel and the runner: a MutationObserver
on the album host — only the host, because Fansly's shell keeps mutating
elsewhere (unread counters, presence, relative times) and a document-wide
observer would have spoiled the cache every tick (review finding) — marks the
cached view stale on its first record and disconnects, so a quiet album costs
nothing and an uploading one costs one callback per read; the host leaving
the tree or being re-created is caught by `isConnected` on the cached host,
a missing host is never cached, and `takeRecords()` closes the same-task gap
after a handoff's synchronous change handler. The album title comes from the first host child
that renders text rather than the host's whole innerText (documented
equivalence: a title never straddles two top-level inline siblings). Panel
writes are idempotent, status lines are patched in place (the aria-live region
announces changes, not ticks), the notes and the question are rebuilt only on
content change, the row loop indexes the snapshot once, the refresh tick
pauses while the tab is hidden, and the runner emits a snapshot only when the
uploader line changed. Not changed: the family law of E109 (in-flight mark
before the handoff, «неизвестно» never re-uploaded, positive-evidence
confirmation), the selectors, the checkpoint format. A checkpoint written by
2.1.0 still matches when the new title reader yields the same string, which it
does for a block-level header; if it did not, the run would simply see no
checkpoint and detect the present cards from the album instead.

**E112 (2026-09-10).** Release 2.1.1 from `main` (4535890 + this release
commit): the E111 performance pass — the vault uploader off the shared content
path (launcher-only bootstrap, `vault.css` fetched with the module, one route
poll), mutation-gated album reads with a host-scoped observer, diffed panel
renders, the reopened-panel preview fix — and UTF-8 bundles. Package and
manifest are 2.1.1; the committed changelog/install stamps read v2.1.1.
CHANGELOG.md gains the 2.1.1 section that becomes the Telegram announce
(preflight: 1650 chars, markdown subset clean); changelog.html gains the
matching block above 2.1.0, whose badge drops «latest»; README lists the date.
guide.html is untouched (the chapter is versionless and the feature's
behaviour did not change). No Kernel SDK change, no storage migration, no new
Fansly egress. Still not verified in a release pass: the vault selectors and
the new title reader against the live Fansly build — the panel's facts row
remains the visible guard.

**E113 (2026-09-10).** The owner asks for the cabinet's P2 review tail
(BL-004…BL-006) and two housekeeping items to be fixed without a release.
Fixed, each with a test: the «Контракт» status row follows the debug switch
live instead of the value at render; hub/access rows that a dropped paint left
as skeletons are healed — the drop marks them stale and `healHubStatusRows`
repaints once the live form equals the saved snapshot (at the drop, after a
persist that ran no diagnostics, on the chatter's return to the tab); typing
cannot reach that state (an input event nulls the connection-test signature,
so every persist re-hydrates), only a programmatic move of the field can, and
that is what the test models. «AI отключён» is drawn by `renderMappingInfo`,
so a live `accountMappings`/catalog refresh repaints it — before, the refresh
wiped the badge for every row until a reload, the opposite of the stale badge
the backlog described. A successful rename moves focus to the rebuilt row's
rename control. A deep link to the hash the options tab already shows hops
through the bare pane first so the page gets a real hashchange (the hash
grammar is unchanged); two codes landing on one row force a style flush
between remove and add so the second flash is visible. A middle-click on the
changelog link records the version as seen through `auxclick` and leaves the
opening to the browser. An empty accounts table after a failed live read says
«Список не обновился», not «Пока пусто». Housekeeping: the 1.9.11 block of
changelog.html loses its second «latest» badge; the backlog note about the
Coach feed rebuilding on every chunk is retired (the feed reconciles by key)
and the closed items are struck through with their reason. Not touched:
BL-003's harness/interface notes, BL-007's debounce re-arm (a paired fix with
the field writeback), the `signOutAgencyHub` sender check.

**E114 (2026-09-10).** Release 2.1.2 from `main` (d0e888b + this release
commit): the cabinet's P2 review-tail fixes (E113) — live «Контракт» row,
healed hub/access skeletons, the «AI отключён» badge surviving a live refresh,
rename focus, the repeated deep link, middle-click on the changelog link, the
honest empty-accounts subtitle — and the changelog.html badge fix. Package and
manifest are 2.1.2; the committed changelog/install stamps read v2.1.2.
CHANGELOG.md gains the 2.1.2 section that becomes the Telegram announce
(preflight: 1482 chars, markdown subset clean); changelog.html the matching
block above 2.1.1, whose badge drops «latest»; README the date. No Kernel SDK
change, no storage migration, no new Fansly egress; guide.html untouched. The
vault selectors remain unverified against the live Fansly build (E110/E112).

**E115 (2026-09-11).** Ping gets the fan's names and bio; the E25 prompt
boundary is superseded. Field report (a chatter, 2026-09-11): every Ping
opened with "hey stranger" instead of the fan's name. Core Decision 290 fixes
the kernel side (the ping template quoted that opener twice, the segment-A
instruction quoted a second one in the recency slot, and the template had no
fan name at all: `fanDisplayName` was computed for every feature but only
hi-greeting rendered it). This change is the client half. Owner ruling, twice
confirmed: the chatter's saved fan name usually IS the fan's real name and
belongs in the prompt, with the chat taking precedence when the two disagree;
Hi stays the tool for fans who never wrote, Ping is reactivation, and no
gate or Hi change was wanted. Mechanism: the account lookup every generation
already makes (`GET /account?ids=`) carries the rename as note contentType
12002 (E25); `customNameFromAccount` moves from spenders-service into
`src/shared/fansly-custom-name.ts`, and `kernelFanCustomName` sends it trimmed
and code-point-bounded to the contract max (200) as the new optional
`clientContext.fanCustomName`, for every feature (the kernel decides which
template reads it; today ping only). No new Fansly egress. `fanDisplayName`
stays account-lookup only and still never the DOM label (ambiguous: platform
name or rename); the E25 guard tests keep passing unchanged. Ping's policy
turns `includesFanBio` on so `account.about` rides `fanBio` for pings, matching
the kernel policy flip; the compare lane is untouched (it never sent the bio
either). The vendored SDK is re-cut from core (contract hash `af58db69…`,
Decision 290 commit): `kernel-sdk.vendor.json` + dist regenerated by
`scripts/vendor-sdk.mjs`, never hand-edited. Verification: operations-suite
E115 cases (saved name beside the platform name on fast-reply; no key when
never renamed; a segment-A ping carries name + bio and the vendored contract
accepts the body), the shared-helper unit test (12000 vs 12002, trim, bound
on code points), the policy flag test; `pnpm check` green. Deploy order: core
first (the kernel rejects unknown `clientContext` keys on the strict schema),
then this release; until the core deploy this branch must not ship.

**E116 (2026-09-11).** Release 2.1.3 from `main` (57b2076 + this release
commit): Ping sends the chatter-saved fan name and the bio to the kernel
(E115), paired with core Decision 290 (ping template without its seeded
"hey stranger" openers, a Fan section with username / saved name / bio, the
name-priority rule), which was deployed to the hub first: the kernel's strict
`clientContext` schema had to accept `fanCustomName` before any client sent
it. Package and manifest are 2.1.3; the committed changelog/install stamps
read v2.1.3. CHANGELOG.md gains the 2.1.3 section that becomes the Telegram
announce; changelog.html the matching block above 2.1.2, whose badge drops
«latest»; README the date. Kernel SDK re-vendored (contract hash
`af58db69…`, core `32478124`); no storage migration; no new Fansly egress
(the saved name and bio ride the account lookup every generation already
made). Live acceptance: the reporting chatter's next pings after the update.



**E117 (2026-09-14).** New followers: owner-selected variant 2, compact queue
left and chat/composer right. Defaults to 48 hours (1/3/6/12/24/48/72/168/336/720).
Followers, avatar, bio, username, custom name (in parentheses), native inbox
search and history come directly from the current Fansly session. Follow age
comes from the follow RELATION snowflake, always shown in hours. No group is
created during a scan. Unknown/incomplete reads are not eligible for sending.

Welcome definitions are creator-scoped, single-flight, cached 24 hours in
storage.local with older text versions retained. Owner ruling: nonempty exact
text after whitespace normalization is sufficient to exclude a welcome;
manual identical text is excluded too. Type 2 and non-reply correlation IDs
exclude automation/mass messages. Type 1 alone is not proof of a personal DM.
Positive personal evidence is durable; negative history is reused only within
a scan after a live delta overlaps previously examined history. Fan-first
conversations produce replies. Missing old welcome versions cannot be inferred.

Before excluding a fan on text-based personal proof, refresh definitions once
per scan (creator-scoped single-flight); unavailable fresh definitions leave
that ambiguous case unknown. Retain the message classification fields, not a
boolean verdict, and reevaluate them against the refreshed welcome set. If an
old proof becomes a welcome, reread the full history for other personal DMs.
This repairs a definition edit racing the preceding scan. The 24-hour cache
still serves rows that carry independent automation markers or known welcomes.
Within-scan delta overlap retains only cached messages older than the freshly
read range; absent messages inside that range are removed and change the
review revision. Arbitrary deletions in the untouched older tail require a new
full scan.
Replacing a cached history replaces its completeness proof too. A refresh
that reaches the page cap becomes unknown and cannot turn into a complete
history merely by overlapping its own partial head on another send attempt.

Generation is explicit only, over the Hub hi-greeting feature lane's scoped
new-follower mode (Core 333). It produces one draft using profile values and an
avatar image; legacy Hi remains three variants. No local prompt/vendor keys.
Drafts are per creator/fan and persist on selection and window changes.

Sending is one direct session POST, using the Fbuddy group/message mechanism.
The background owns recipients and eligibility; content supplies an opaque
scan id. Session and Hub identity are fenced across async work. History is
rechecked before sending and after the shared Hub reservation. Hub holds only
send custody, not the follower list: reserved expires after 60s; dispatching
and sent never expire. Local custody is acknowledged before dispatch. Unknown
responses block replay; no auto-retry. Old clients/native Fansly/Fbuddy do not
participate in the shared lock, so a final live check reduces but cannot remove
that external race. Operational cache/custody keys do not change settings.

Release candidate 2.2.0 requires Core 333 deployed first. No real fan DM is sent
by the automated tests or release verification.

The shared runtime listener declines foreign and invalid message families
synchronously before entering its async handler. Returning an async undefined
would claim Firefox's reply channel and interfere with the dedicated follower
listener; a regression registers both real listeners and checks sole ownership.

E117 review follow-up: send carries the history revision actually shown to the
chatter; newly arrived messages stop delivery and refresh the chat while keeping
the draft. Closing/reopening fences late generation results and operation-owned
busy state. Missing creator-only notes trigger one batched profile hydration.
The first recent-inbox page resolves new-follower group ids in bulk; absence
there never proves no history. The isolated UI bundle excludes background Zod
validation (17.7 kB minified); the family stylesheet loads only on opening.

E117 Fable follow-up: a definite dispatch denial or a local abort before the
Hub dispatch request changes the local journal to aborted; a later explicit
attempt may proceed after a fresh live check and a new shared reservation.
Unknown Hub transitions and all issued Fansly POSTs retain permanent custody.
A failed aborted-journal write also remains fail-closed. The small crash gap
after shared dispatch custody remains deliberately non-retryable; no timeout
can safely release an attempt that might already have sent a platform DM.

Follower checks now run with separate 45-second row budgets, three workers,
and a 180-second pass deadline. Continue resumes only unfinished rows, keeping
the same scan, completed checks and drafts; it never re-fetches the follower
list or generates a draft. Profile-batch and welcome-refresh failures are
recoverable, and timeout copy is Russian. An empty message page remains the
absence proof even though the requested message page size is currently 25.

Avatar host/length validation matches Core. Signed avatar metadata is refreshed
on the explicit generation click, with a text-profile fallback if unavailable;
the AI request is never automatically retried. Generation context uses the last
30 messages, matching the history shown to the chatter and bounding its cost.


**E118 (2026-09-14).** The existing `debugMode` switch opts a new-follower
scan into a per-run diagnostic trace at startup; normal snapshots carry only
an optional run id. The explicit scope follows each Fansly call, including
GET retries and the single POST attempt, so concurrent rows/tabs cannot capture
one another's traffic. No requests are introduced by tracing. Runtime state
polls do not generate trace events.

The trace records the actual HTTP method/path/query, response status, retry
backoff, timeout/abort taxonomy, parent/fan correlation, UTC start time and
`performance.now()` offsets/durations. Service events explain follower cutoffs,
profile hydration, welcome cache/single-flight/freshness, personal-proof
revalidation, message classification by ID, group membership, history pagination
and delta overlap, final eligibility, pass continuation, identity rejection,
generation metadata and send custody. Hub spans describe whole client operations,
not an HTTP wire capture. Raw messages, prompts, request/response bodies, session
headers, signed avatar URLs and arbitrary exception text are not recorded.

`Отладка ↗` opens `debug-followers.html`; only that exact extension protocol,
host and path may read diagnostics, and current debug mode is rechecked on
access. The viewer polls incremental events, preserves readable output through
failures, filters by fan/text/error, and exports the complete retained run as
plain text even while the screen is filtered. Start failures and closed runs
remain inspectable. The background retains the newest eight runs, each bounded
by 100,000 events and 20,000,000 serialized characters, dropping oldest events
with an explicit omission count. This is volatile background memory, cleared
on restart; users save a text report for later sessions. No settings schema,
Fansly eligibility, retry policy, send authority or Hub contract changes are
introduced. The owner requested the larger per-run budget before release so
700-follower diagnostic sessions have room for individual message checks;
the eight-run retention limit is independent of the number of followers.
The viewer renders 2,000 events per page to avoid laying out the entire large
log on each update. Its initial page follows the newest events; page navigation,
whole-run filtering and full export preserve access to every retained event.
Review follow-ups restore fan options when switching between repeated runs
with identical fans and mark a closed paused scan as closed, since it can no
longer be continued.

**E119 (2026-09-14).** The owner authorizes minor release 2.3.0 with E118,
requires an independent pre-release correctness/architecture/regression review,
and explicitly defers the Telegram announcement. Use the normal signed-release
path with `SKIP_ANNOUNCE=1`; CHANGELOG validation still runs before signing.
The larger trace budget is covered by a 700-follower service scenario with
50 messages each: all classifications and verdicts are retained, while debug
on/off produce identical outcomes and Fansly call counts. No real fan DMs are
sent in release verification; account-by-account acceptance is a later owner
session. This entry records authorization and source scope, not proof of live
publication: verify the signed feed and release tag for deployment evidence.


**E120 (2026-09-14).** The owner clarifies that the requested small release
was patch 2.2.1 and explicitly authorizes correcting the published 2.3.0 number
while keeping every implementation change. E119 incorrectly attributed the
agent's SemVer interpretation to the owner; this entry corrects that record.

The 2.3.0 tag and signed artifact remain immutable evidence. Its changelog entry
is marked withdrawn, with the same implementation released as 2.2.1. Runtime,
debug limits, settings schema, Kernel SDK, and send behavior do not change.
Telegram posting remains prohibited for this release operation.

To stop further discovery of the withdrawn number while awaiting a new Mozilla
signature, restore the verified signed 2.2.0 package to the update feed and
latest alias, after backing up the published feed/package/pages outside the
web root. The owner-authorized withdrawal is separate from publishing 2.2.1;
the normal deploy.sh path then sees 2.2.0 < 2.2.1 and retains every preflight,
signing, hash, served-version, clean-main and tag check unchanged.
Firefox does not automatically downgrade an installed 2.3.0; that installation
would need a manual move to the corrected release. Pre-withdrawal server-log
inspection saw only curl/Python verification downloads, which is evidence of
requests, not an installation inventory. Verify the final feed and tag before
calling the correction published.


**E121 (2026-09-14).** The owner approves chat previews and request delays
following the Lora audit. Its 194-follower pass generated 118 HTTP 429 responses
because three workers retried independently; the server's actual threshold is
unknown. These observations justify conservative pacing, not a promise that
Fansly can never return 429.

Follower-owned session copies explicitly opt all their GET attempts into one
FIFO per resolved creator in the background Fansly client. Only one attempt
is in flight, with at least 1 second between GET starts and 1.5 seconds between
message-route starts. All follower windows and lazy previews share the lane;
other creators remain independent. On 429 the entire lane waits at least 30s,
then 60/120/240/300s for repeated limits, honors a longer numeric or HTTP-date
Retry-After without the old 5-second clamp, and doubles spacing up to 8s.
An idle lane is discarded after 15 minutes and after its cooldown expires;
closing/reopening a window does not erase an active cooldown. HTTP retries
remain bounded; exhaustion pauses the pass instead of advancing through every
remaining fan with an exhausted rate budget. Existing ordinary-chat traffic,
other devices and platform clients do not participate in this local lane.
POSTs never enter its retry loop. Identity is revalidated after the queue wait,
before dispatch. The existing per-attempt HTTP timeout starts after waiting.
Queue waits and cooldowns are traced without adding message bodies or secrets.

This supersedes E117's 45-second row / 180-second pass wall deadlines for
follower discovery/checks: intentional spacing is not an unknown verdict.
Pagination caps and HTTP-attempt timeouts remain, while a human Pause aborts
only the current checking pass. Continue preserves the scan, cutoff, completed
rows and drafts and checks unfinished rows. Initial discovery finishes before
Pause is available; closing the window cancels its owned requests at any stage.
Welcome definition reads remain shared and independent of an individual
window; their HTTP attempts use the same creator queue. A cancelled row stops
waiting for that shared read. Generation/send operation deadlines and one-attempt
send custody stay unchanged.

A positive proof now carries its message and date to the follower card;
legacy proof dates can be decoded from the message snowflake. New proofs also
retain the platform createdAt field. No settings or schema migration is needed
for this optional operational-cache field. For contacted/sent fans, selecting
a card opens a read-only conversation projection, reusing already fetched
history first. If missing, native search, participant verification and one
message page run through the same paced session client. Repeated selection
reuses that window's result; earlier pages load only on click, capped at 750
displayed messages with a verified Fansly chat link. Read errors retain the
proof and existing messages. Preview state cannot modify eligibility, history
completeness, the reviewed-send revision or send custody. Ready/reply fans keep
the existing composer and reviewed history path.

The window uses 'К обработке', separate status filters, discovery/profile/check
phases, exact local date boundaries, per-message dates, a shared cooldown
countdown and distinct empty-period copy. No generation or message send is
triggered by selection, opening history, pausing or resuming. Validation uses
mocked browser-session transport and synthetic UI data, including a 194-fan
mixed-status pass with a 429 and real pacing. Live rate behavior still needs
measurement after installation. This change does not bump or publish a version
and does not authorize a Telegram announcement.

E121 adversarial review follow-up: an independent reviewer checked the actual
uncommitted transport, service and UI changes and reproduced the defects before
fixes. Queue progress/completion no longer rebuilds a selected fan's composer;
DOM identity, focus and caret survive another fan leaving the pending list.
Both follower time bounds now use one captured start timestamp, so followers
arriving during a long welcome/queue wait belong to the next refresh, not to
an interval ending before they followed. The 750-message preview cap is an
informational truncated state with a hard no-fetch guard, not a retryable error.
The first real transcript after a cached proof or empty placeholder opens at
the latest messages; subsequent history reads preserve scrolling. The scroll
failure and fix were verified with actual browser geometry on 25 long messages.
Regression coverage also exercises repeated 429 through exhaustion, HTTP-date
Retry-After, abort during a long cooldown, reopening during cooldown and idle
lane expiry. These are synthetic transport/UI checks; they do not establish
Fansly's live rate threshold or constitute a deployment.

**E122 (2026-09-14).** The owner now authorizes publication of E121 and its
adversarial review fixes. Keep the previously clarified small-release numbering
(E120): package and manifest advance together from 2.2.1 to 2.2.2. The withdrawn
2.3.0 entry, tag and artifact remain historical evidence. Update both changelogs
and use the normal clean-main signing/deployment path with `SKIP_ANNOUNCE=1`;
the prior instruction not to post in Telegram still applies.

Independent adversarial review reproduced four UI/time-bound/history defects;
all four are fixed and no confirmed unresolved correctness or architecture
findings remain. The full local check passed 125 test files / 2292 tests before
release preparation, including synthetic 700-follower diagnostics and a
194-follower paced transport scenario. Run the final release check and CI before
signing. Real-account acceptance and measurement of Fansly's rate behavior
follow installation; the synthetic checks do not replace that evidence.
This entry records authorization and validation scope. Successful publication
must be established by the served feed, signed package hash and release tag.

**E123 (2026-09-15).** PR-E1 of the «Единый аккаунт чаттера» track. The chatter's
whole story becomes one login and one password: the owner sends an invite link,
the chatter sets a password there, and that pair signs him into the Fansly
extension and the OnlyFans desktop app alike.

*Sign-in protocol (plan Р2).* «Войти» calls the kernel's public
`POST /api/v1/auth/device-tokens/password` with `mode: 'active'` in a
bearer-less SDK client, and the caller commits the answer in ONE atomic
`storage.local.set` inside the custody FIFO. The Stage 32 ceremony —
cookie `login` → `authIssueDeviceToken` → `logout` — is deleted. Two things
made it wrong here: Firefox carries the hub session in the profile's own cookie
jar, so signing in from the extension logged the dashboard out of the same
browser; and the trailing `logout` was best-effort, so a stray session could
survive. There is no reserve→activate either: this client's custody is a single
key, and a pending credential parked in the live slot would answer 401 for the
whole reservation window.

*The legacy chatter key is gone, not deprecated.* Field, `Settings` member,
`DEFAULT_SETTINGS` entry, `NORMALIZED_STORAGE_STATE_KEYS` member, custody-layout
repair predicate, `stripSecretSettings`/`serializePersistedState` handling,
`resolveHubBearer` fallback, the options-page input with its whole
dirty/snapshot/retry machinery, the double wipe in `signOutAgencyHub` and the
v12-blob fallback branch all went out together. Storage **v17** REMOVES the
`agencyHubApiKey` key from `storage.local` — which makes this entry the
tombstone for **E19**'s «wipe to empty strings, never remove the key» rule *for
that key only*: the rule protected a fallback READ, and the read shipped out in
the same release. The live slot keeps the rule (its presence is what the layout
repair reads). An install that held only the key arrives signed out and is asked
to sign in; production holds no such install. **The device-token branch of the
v12 fallback STAYS** — the feed serves only the newest build, so a ≤1.8.0
install jumps straight to v17 and would otherwise lose a working sign-in
(pinned: a direct v12→v17 jump carries the credential and drops the key).
Existing sign-ins are NOT invalidated: nobody re-logs in after this update.

*Address.* `agencyHubBaseUrl` defaults to `https://gosling-agency.ru`, and the
v17 normalizer fills it in for an install that never had one (a deliberately
chosen address survives untouched). The field moves under «Дополнительно»: one
hub serves the agency, so it is not a question a new chatter answers.

*Host permission.* `https://gosling-agency.ru/*` joins `host_permissions`, which
Firefox grants in the INSTALL prompt. An UPDATE grants nothing (bug 1893232), so
the runtime `permissions.request` stays and now rides the «Войти» click — the one
user gesture the flow guarantees — and a refusal stops the sign-in with the
sentence that explains it instead of an opaque network error. `runtime.onInstalled`
records which of the two cases this profile is in.

*Errors.* `hub_invalid_api_key` → `hub_unauthorized` (CG-HUB-03), now
«Agency Hub отклонил вход с этого устройства». New: **CG-HUB-17** «Неверный логин
или пароль», **CG-HUB-18** «Владелец должен сбросить пароль», **CG-HUB-19**
«Сессия устройства завершена» (the self-healing card) and **CG-HUB-20** «Слишком
много попыток входа» for the route's per-IP rate limit, which would otherwise
have read as «хаб недоступен» and invited the retry that keeps the limit shut.

CG-HUB-18 is keyed off `body.error`, NOT `body.reason`:
`PasswordChangeRequiredError` is a plain `AppError`, so the kernel serializes its
machine code as `error` and attaches no `reason` at all (only `UnauthorizedError`
declares one). Reading `reason` alone sent a frozen account round the
«wrong password» loop no password can break.

Per §4.5, a 401 clears this device only when (a) the server named
`token_revoked` or `token_expired`, (b) the rejected bearer is still the stored
one (sha-256 digests, so no second copy is held) and (c) the check and wipe run
inside the custody FIFO. A bare 401 fails closed, exactly as before. The wipe
empties the live slot and removes the retired one. **The card follows the WIPE,
not the reason:** a named 401 whose bearer a newer sign-in has already replaced
heals nothing, and saying «сессия завершена» there would be a lie about a live
session — so it keeps the fail-closed card. The two callers that can ask to heal
the same bearer (the SDK's `onAuthError` hook, which covers raw/stream paths, and
the error mapper, which needs the answer) are reconciled by a per-bearer memo, so
the second caller cannot report «did not heal» about a device the first just
signed out.

*Identity.* «Страницы Fansly» lists Fansly pages only. The account is
platform-neutral — that is the point of this entry — and a chatter can hold pages
on both platforms (Grisha does), so an unfiltered list promised pages this client
cannot open.

*Vocabulary (plan §2), enforced.* `tests/copy-vocabulary.test.ts` reads every
Russian string in `src/options`, `src/popup`, `src/content`, the error registry,
the three chatter-facing pages and every CG-HUB card, and fails on «токен»,
«device token», «ключ», «API», «bearer», «активация», «резервация», «префикс».
Cyrillic look-behinds keep «подключение», «ключевые» and «реактивационный» out of
the net; a falsifiability case proves the gate still bites. The pane is renamed
«Аккаунт ChatGoose» and states «Вы вошли как grisha · чаттер» with the Fansly
pages, plus «Аккаунт» (`${baseUrl}/account`), «Выйти» and «Нужна помощь со
входом». The first-run checklist becomes the chatter's own three steps: open the
invite and set a password → sign in → open Fansly. The host permission is no
longer a step of its own, since «Войти» asks for it.

*Pages and release.* New static `start.html` («Как начать», two tabs:
Fansly = install + sign in, OnlyFans = download from
`ext.gosling-agency.ru/desktop/` + sign in) is what the invite, both clients and
the guide point at. The full release path publishes and verifies it like every
other page.

**Two publications, two orders, two gates — they are not the same event.**
`start.html` must be live BEFORE the dashboard's `/join` goes out, because the
first invite links to it; the XPI must ship AFTER the kernel's PR-1A, because a
signed build pins a vendored contract. So `deploy.sh --pages-only` publishes
`start.html` and nothing else: no stamping (the page has no version slot — it
describes a ceremony, not a build), no `index.html`, no `changelog.html`, no
`updates.json`, no XPI. Touching the landing early would have been the actual
bug: it is stamped from the LOCAL manifest, so an invited chatter would have
read about a pane his download did not have. That mode keeps the provenance
gates a public publish needs — main, clean tree, HEAD == origin/main — and
deliberately drops the contract-hash gate, which exists for signed builds and
would block the one case the mode was built for. The XPI path keeps every gate
it had, contract hash included.

Version **2.4.0** — `v2.3.0` is taken by the withdrawn release (E120/E122), and
a tag is never reused.

*Not done here:* `whats-new-3.html`. The per-release convention is
`CHANGELOG.md` + `changelog.html`, both updated; `whats-new-2.html` was a one-off
deep dive for 2.0 and stays a fixed historical page.

**E124 (2026-09-15).** After updating to 2.4.0, the owner observed
`ChatGoose Settings Unavailable` repeatedly before Settings eventually opened.
The page checks storage readiness before discovering Fansly tabs, so opening
Fansly is not a prerequisite for this barrier. The original failing console
trace was unavailable after recovery; the precise failed phase in that profile
is unconfirmed.

The reproducible defect is a premature acknowledgement timeout. The listener
probe allowed one `setTimeout(0)` turn, and repair set/remove acknowledgements
allowed three. Timer turns do not bound delivery latency of Firefox's
asynchronous storage events. A 50 ms delayed event reproduces a rejected
readiness handshake despite successful storage operations. E123's v17 upgrade
adds legacy-key removal, including its own arm/completion acknowledgements, to
the same startup path; the too-short waits predate that release.

All four waits now use an event-driven, **1,000 ms** acknowledgement deadline.
Observed events resolve immediately and cancel the timer. Three probe attempts,
the fresh-read-before-repair rule, late self-event suppression, credential
custody, and the Settings writer barrier remain in force. A missing event still
fails closed; this is neither a fixed startup sleep nor permission to bypass
the storage barrier. No settings shape change or schema bump.

Regression coverage delays the probe, full-state write, removal arm and removal
completion independently; it also verifies timeout rejection and preservation
of the existing sign-in/mappings. Missing-event tests use virtual time. The
runtime API harness explicitly reads its fixture on each call instead of
implicitly obtaining that behavior from perpetually unobserved probes.
This change is prepared locally; publication is a separate release step.


**E125 (2026-09-15).** Settings opens with one sign-in screen when this
device has no credential or the current identity check explicitly rejects the
current Hub URL + credential. The cabinet is hidden and inert, including when
a saved deep link targets another pane. A network failure, missing host
permission, invalid Hub URL or an authenticated account with zero pages does
not mean the person signed out. Health, identity and Fansly discovery are not
started for an initially signed-out device. The first real discovery after
sign-in owns its loading/error state; a skipped read is not an empty snapshot.

The gate reuses the cabinet's live form, feedback, help and advanced address
controls, with placeholders restoring their original locations after sign-in.
There is one credential writer and no duplicate password form. Submit/Enter
asks for Firefox host permission in the user gesture, prevents duplicate
issuance, reports permission/transport errors in place, and only opens the
cabinet after custody is read back. Sign-out, cross-tab changes and explicit
current-identity rejection return to the same screen. The requested pane and
local account/persona setup are retained; the password is cleared on success
and when entering the gate. Sign-out results remain visible on the gate.

The popup and chat banner likewise lead with sign-in before account/persona
setup. A separate `signedIn` projection expresses local credential presence;
transport configuration, Fansly-tab presence and assigned pages cannot answer
that question. Content tolerates the previous worker's missing projection
during an update. Popup replies and pending banner reads are generation-fenced
so an older result cannot replace a newer sign-out view.

An auth audit also reproduced a delayed-response defect in the self-healing
memo: after wiping an old credential and signing in again, a second old-401
consumer could incorrectly report that the new session had ended. The custody
FIFO now reads the current slot before reusing that memo, and only reuses it
while the slot remains empty. No credential or storage schema change. The
reported Nikita screenshot proves a missing local sign-in, not why it was
removed; v17 retires legacy key-only installations but preserves device
credentials, and the affected profile's pre-upgrade state is unavailable.

Regression coverage includes initial signed-out deep links, durable sign-in,
duplicate Enter, transport/permission refusal, source-bound rejection,
zero-page accounts, cross-tab changes, initial discovery failure, all sign-out
outcomes, popup/banner precedence and delayed old-credential errors. Full
`pnpm check` passed (127 files / 2,354 tests). Browser verification uses actual
compiled UI with synthetic browser APIs, light/dark themes and a 320 px window;
it does not issue or revoke real credentials. Publication remains a separate
release step.


**E126 (2026-09-16).** The owner authorized publishing E124/E125 as 2.4.1
after deploying the Core identity rework. The existing release gate requires
the shipped SDK contract to match live Core exactly. Re-vendor SDK 0.3.0
using the generator from clean Core commit
`579b0e34932020607d0ebdc44f9683f24360ffa9`, the actual deployed revision.
Contract hash: `8e9dda0b2352b0b7a106e515a3282493b0977db4c730466681e985e20e7c33b2`.

Core's changed administrative routes use immutable user IDs. This extension
does not call those operations; sign-in, self-device and feature routes stay
unchanged. The refresh preserves generated provenance and the contract gate;
no vendored files are edited by hand and no release check is bypassed.
No new extension permissions, settings schema or credential migration.


**E127 (2026-09-16).** Release 2.4.1 packages E124/E125 and the generated
Core pin from E126. Version fields, landing stamp and both changelogs move
together. No settings-schema migration or new extension permission is added;
existing device credentials and local setup remain intact. Publication uses
the standard main-only, clean-tree, exact-origin, Core-contract and AMO
unlisted-signing gates. An update is only claimed live after the public feed
and both XPI download paths are checked.

Prepublication verification: `pnpm check` passes all 127 suites / 2,354 tests,
typecheck, lint, cutover gates and production build. Self-hosted `web-ext lint`
has zero errors and three dynamic-import warnings. The first lint attempt
used Mozilla-hosted mode and rejected the required self-hosted update URL;
rerunning in the actual distribution mode resolves that mismatch without
changing the manifest or weakening publication checks. The changelog renders
in the browser and the announcement format validator passes. Functional UI
coverage and browser evidence for the fixes are described in E124/E125.


**E128 (2026-09-19).** The owner reports the new-follower window pausing on a
Fansly rate limit seconds into a 146-follower, 48-hour scan and supplies the
debug trace (run 192f8b94, 2.4.1). Measured: the lane entered the scan at
`intervalMs=2000` because the previous scan, 8.5 minutes earlier, had drawn one
429. Six GETs went out 2 s apart; `followersnew` x2, `messaging/groups` and two
`/account?ids=` reads answered 200; the third `/account?ids=` read, 4 s after
the first, answered 429 with no Retry-After. The carried penalty made that 429
cost 60 s and 4 s spacing for the ~365 reads still ahead. `profiles.plan` was
hydrated=8 / missing=138: follower pages already carry usernames, avatars and
bios, and the three blocking batches existed only to fetch creator-only notes
(the saved fan name, E117 follow-up) while rows showed bare ids and no check
could start. The earlier scan, at 1 s spacing, stalled in the same phase. This
shows a throttle specific to the `/account` route family or to ids per window.
It does not measure that threshold, and it does not prove the other routes safe
at the E121 pace, which neither scan reached.

Changes. (1) Rows take names, avatars and bios from discovery page by page. Only
a missing username still blocks a check (native search needs it) and keeps the
E117/E121 recover-on-Continue and pause-on-exhausted-429 behavior. (2) Notes are
read after the verdicts in chunks of 100 ids (the chunk size the FBuddy client
uses on the same endpoint), without retries, stopping at the first failure. That
read never changes a verdict, sets a scan error or pauses a pass; a 429 there
still opens the shared lane cooldown. The generation click already reads the
fan's account for a fresh signed avatar; the same read now also runs when the
fan's notes are unknown and supplies `fanCustomName`, so a throttled batch
cannot drop the saved name from a draft. (3) The lane keeps E121's base pace
(1 s, 1.5 s between message reads), the 30/60/120/240/300 s cooldowns and
spacing doubling up to 8 s, but the penalty decays: one level once five quiet
minutes have passed since the end of the last cooldown and Fansly has then
answered twenty reads 2xx at the slower pace. Reads inside the quiet period and
idle time forgive nothing, so a scan that follows a 429 always probes at the
penalised spacing first. Spacing and cooldown
level are one counter capped at 5; the 15-minute idle discard stays. (4)
`/account` reads are at least 5 s apart on the lane; other routes keep their
spacing. The 429 was both the third `/account?ids=` read and the fifth
`/account*` read in 10 s, and one trace cannot tell those apart, so follower
pages share the gap: a 20-page discovery takes up to 100 s instead of 20 s.
This is a precaution sized to one observation, not a measured limit. (5) The window
keeps composer focus and caret when the selected fan's card rebuilds, since a
saved name can now arrive while the chatter types. The trace records the route,
penalty decay, route-spacing waits and the notes phase.

The owner also asks whether the overall pace is too fast. This evidence does not
answer that: every throttled read was on `/account`, and the check-phase routes
were never reached under pacing. The base pace is therefore left unchanged
rather than tuned on a hunch; the lane slows itself when Fansly objects, and the
next live trace can answer the question. Validation is synthetic (mock
transport, fake timers, jsdom). This supersedes E121's penalty that lasted until
the idle discard and E117's pre-check notes hydration. No settings or schema
change, no new Fansly endpoint, fewer Fansly requests per scan. Version 2.4.2,
a patch per the owner's numbering. Publication is a separate owner step.

E128 adversarial review follow-up: two independent reviews (Opus, then Fable
at the owner's request) found no ship blocker. Both main findings were about
decay being more lenient than E121. The first draft forgave a level per five
idle minutes; the second still let twenty reads taken inside the quiet period
carry over an idle gap, so the owner's own case (429 mid-scan, scan goes on,
next scan 8.5 minutes later) would have restarted at 1 s. Now only reads
answered 2xx after the five-minute mark count, `status()` no longer mutates the
lane, and every decay step is traced from `acquire`. Also fixed: names are
applied per follower page, since the 5 s page gap made a multi-page list show
bare ids five times longer; the notes phase computes `canContinue` first,
swallows its own failures, skips with its own reason when the lane is cooling
down, and keeps Pause as the way out if a cooldown starts while its read is
queued; an empty answer to a non-empty batch does not mark anyone read, while a
fan a real answer leaves out is not asked again; the generation-click read
uses no retries when only the saved name is missing and clears the cached
avatar on every branch; focus restore does not scroll the card. Each of these
is pinned by a test that was checked to fail without the fix. Kept on purpose:
follower pages share the 5 s `/account` gap.


**E129 (2026-09-19).** The owner authorizes merging, deploying and releasing
E128 as 2.4.2. The first `scripts/deploy.sh` run stopped at the Core contract
gate, before the build and before any AMO request: production Core answered
contractHash `8e761076805a1c3e071707801bed12756385fcfc745b139a3120d25095ec6c27`
while the vendored SDK carried `8e9dda0b…` from Core `579b0e34` (E126). Nothing
was signed, uploaded, tagged or announced. Production runs Core source revision
`b1d3bb814809` (container label `agency-hub.source-revision`), which is Core
`origin/main`.

The SDK is regenerated by Core's `scripts/vendor-sdk.mjs` from a clean detached
worktree at `b1d3bb814809b160437ba98c429bdebf36cffee5`; the generated hash equals
the production hash exactly. The contract change is Core Decision 370 (API keys
retired): the admin API-key, admin device-token/password and the cookie-based
`authIssueDeviceToken`/`authReserveDeviceToken` operations are removed and the
`content_manager` role is dropped. The extension calls none of them; sign-in
stays on `authIssueDeviceTokenWithPassword`, and feature, self-device and
follower-outreach routes are unchanged. `pnpm check` passes on the regenerated
SDK (127 suites, 2,366 tests, typecheck, lint, gates, build). No vendored file
is edited by hand and no release check is bypassed or weakened. The release
version stays 2.4.2: nothing was published under that number.

**E130 (2026-09-20).** The owner supplies the first live trace of a scan that
reached the check phase under pacing (run 54bc95c0, 2.4.2, @itsaribae, 75
followers, 24 h) and finds it too slow. Measured: 79 GETs in 82 s, 0.96 per
second, exactly the E121 lane interval; no 429, no cooldown, no retry. About
70% of the lane's time was deliberate sleep (mean HTTP time ~0.3 s) and the
three workers only queued behind one lane. The scan needed ~112 reads (44
native searches, 31 chats at a participant read plus a history page), about two
minutes. Seven of the 79 reads answered 404 on routes that answered 200 around
them (`messaging/groups?search=`, `/message`, `/group/<id>`), three in a row at
16-18 s, two at 31-32 s, singles at 64 s and 77 s; for one fan the participant
read answered 200 and the history read of the same chat 404 three seconds
later. The failures follow time, not the fan. A 404 is not retried, so 7 of 59
rows ended «Не проверен» until a human Continue. The trace holds no response
body, so it cannot tell a sick node from a disguised throttle.

Reference: the FBuddy extension (`~/code/agency/fbuddy-analysis`, pacer
`fansly-api-pacer-v2`) paces each `METHOD /path` on its own with no coupling
between routes, starts every route at 400 ms, speeds up 0.78x per 16 answered
reads down to 25 ms and up to 8 concurrent requests, treats a 429 as routine
(5 s cooldown, 2.25x spacing, a remembered bad spacing for 12 h), adds up to
250 ms of jitter, keeps its state in `storage.local`, never reads Retry-After
and does not retry a 404. Its risk is spread over thousands of customer
accounts; ours is a handful of models. The owner's brief: fast enough rather
than fastest, at least twice the current pace, slightly safer than FBuddy, a
ban matters more than speed, and an architecture with room to grow.

Changes. `src/background/fansly-pacer/` replaces `follower-read-scheduler.ts`.
(1) `policy.ts` is data: a pace key is `METHOD /path` without the version prefix and with numeric segments
folded, and a family groups paths that evidence says share a limit. Default
policy: start 500 ms, floor 400 ms, ceiling 8 s. The `/account*` family keeps
E128's 5 s for follower pages and id reads alike, never accelerates, ceiling
20 s. A new family or pace is a row, not a scheduler change. The pace key is
no longer the `RouteKey` of the client-check header. (2) `controller.ts` is a
pure state machine per key: forty answered reads that actually ran at the
current spacing (started within 1.25x of it) earn a 0.9x step toward the
floor; a limit doubles the key, is remembered for 24 h and holds the key a
quarter above the limited spacing; reads before the cooldown's end plus five
quiet minutes count for nothing. (3) `pacer.ts` keeps E121's lane: one FIFO per
creator, one attempt in flight, the 30/60/120/240/300 s cooldowns on any 429,
Retry-After never shortened, E128's level decay unchanged, the 15-minute idle
reset. New: a 400 ms gap between any two starts plus 0-100 ms of jitter; the
first limit slows only its own key, and from the second unhealed level the lane
gap doubles per level up to 8 s. A rested lane drops its penalty but not a
remembered limit, and an earned faster pace is proved again after a rest.
(4) `store.ts` keeps an open cooldown, the level and every remembered limit in
`storage.local` under `chatgoose:fansly-pacer:v1:<creator>`, an operational
cache like the follower proofs: no schema change, best effort both ways (a read
that does not answer within a second is skipped, E124), and a
lane with nothing to remember writes nothing. The MV3 background page can
unload, and until now it forgot a cooldown when it did. (5) A row that fails
with `fansly_server_error`, `unknown_error` or `network_error` goes to the back
of the queue once, through the same lane, before it is left to Continue; an
expired session, a rate limit and an unconfirmed participant list are not
asked again. (6) A refused read records `http.error-body`: status, content
type, length, whether it is JSON and its error code, never its text. New trace
events: `http.pace`, `http.pace-restored`, `row.recheck`; `route` now carries
the pace key.

Safer than FBuddy at every moment: 400 ms is FBuddy's *starting* spacing per
route and only shrinks from there; here it is the gap of the whole creator
lane and the floor of every key, with one request in flight. Total pace tops
out near 2.2 reads per second. A replay of the scheduler over this trace's
request mix reproduces the live scan (116 s, 0.96/s) and gives 53 s for 75
followers, 100 s for 146 and 201 s for 300, 2.2-2.4x. These figures are a
simulation. Nothing here measures Fansly's threshold.

Not done, on purpose: no concurrent requests, no probing below 400 ms, no
treatment of a 404 as a throttle before its body is known, and the participant
read stays on every chat (moving it to send time would save a quarter of the
reads but is a custody change). Validation is synthetic: mock transport, fake
timers, twenty mutations of the pacing and recheck rules each killed by a
test. Supersedes E121's single lane interval and E128's lane-wide spacing
penalty and `ROUTE_SPACING_MS`; keeps their cooldowns, decay and `/account`
gap. No version bump: the owner loads the build as a temporary add-on, runs a
large scan and exports the trace; release follows that trace.

**E131 (2026-09-20).** The owner reads the E130 pull request and authorizes
releasing it as 2.4.3, then merging and cleaning up, without the temporary
add-on load that E130 planned as the first live measurement. The first
production scans therefore are that measurement. What bounds the risk is
unchanged from E130: one request in flight, a 400 ms lane gap that is FBuddy's
starting spacing per route, E121's cooldowns with Retry-After, a first limit
that returns its key to today's pace or slower, and a lane gap that doubles
from the second unhealed level. If Fansly objects, the next «Отладка ↗» export
names the key (`http.cooldown`, `http.pace`) and the fix is a row in
`policy.ts`; `http.error-body` answers what the passing 404 is. Rollback is a
feed release that restores the previous constants: the saved pacer key holds
only stricter state and needs no migration either way. Version 2.4.3, a patch
per the owner's numbering (E120); package and manifest advance together, both
changelogs, the landing stamp and the README move with them. The vendored SDK
already carries production's contract hash `8e761076…` (checked against
`/api/v1/health` before the bump), so no re-vendor is needed.

**E132 (2026-09-20).** Core Decision 376 removes the in-core Workboard v2 and
with it thirteen `workboardV2*` operations and the `workboard-closing` value of
the AI usage feature enum. The contract hash moves from `8e761076…` to
`42c705b8bc9a25afbc3ec1366399567072ef33d545aa7ffacf19dbf279fb0b39`. The extension
calls none of the removed operations in any shipped tag (2.0.0 through 2.4.3)
and never references the feature enum, so nothing changes at runtime; installed
builds only show the "SDK contract" row of the options page as drifted once
production moves. The release gate in `scripts/deploy.sh` is what requires the
refresh: it refuses to publish while the vendored hash differs from
production's.

The SDK is regenerated by Core's `scripts/vendor-sdk.mjs` from a clean detached
worktree at `301a127a2e5be8b83589dedf33873042270cca60` (Core `origin/main`). The
diff is the removed operations, their route schemas and the enum value, nothing
else. `pnpm check` passes on the regenerated SDK with a real install in the
worktree (128 suites, 2,376 tests, typecheck, lint, gates, build); a worktree
whose `node_modules` is a symlink to the main checkout resolves `@kernel/sdk`
to the main checkout's vendor directory and checks the old SDK instead. The
stale `workboardV2*` bullet leaves `docs/generated/15-vendor-kernel-sdk.md`. No
vendored file is edited by hand and no release check is bypassed or weakened.

Sequencing: when this entry was written production still ran Core `b1d3bb81`
with hash `8e761076…`. Merging earlier would block an extension release in the
opposite direction, so this change merges only after production's
`/api/v1/health` reports `42c705b8…`. No version bump: nothing user-visible
changes, and the refreshed SDK ships with the next release.

**E133 (2026-09-20).** The first production trace of 2.4.3 (148 followers,
48 h, first 34 s) confirms E130's pace: 55 check-phase reads in 27.6 s, all
200, no 429, no 404. It also shows what E130 got wrong: back-to-back reads of
one key started 500-506 ms apart every time. The jitter was added to the lane
gap only, the key spacing always bound later, so the dominant phase of a scan
went out as a metronome. Two independent reviews of `0d27c52` (a Fable
reviewer, then Codex blind) found no ship blocker and agree on the rest below;
a third pass asked only what could be deleted.

Corrections to E130. "Safer than FBuddy at every moment" was wrong on the
reaction to a limit. FBuddy's cooldown is `max(5 s x 2^(consecutive-1),
1.25 s x reads answered since the previous limit, spacing x clamp(answers,
8..120))` up to 300 s: after forty answered reads it is already 50 s, ours was
30 s. FBuddy also has one policy for every route, keys without the creator, no
Retry-After and dead "global" options: there is no per-route tuning to borrow.
And route independence is evidenced for `/account*` only (E128); for every
other key it was FBuddy's assumption, not ours to inherit.

Changes. (1) The jitter (0-100 ms) rides on whichever deadline binds, the lane
gap or the key spacing. (2) A limit on an ordinary key widens the whole lane
from the first one (400 ms x 2 per unhealed limit, 8 s at most); a policy
marked `isolated`, today only `/account*`, slows its own key first and the lane
from its second unhealed limit, as in E130. The lane gap comes back one step
per forgiven level and every limited key halves toward its floor with it.
(3) Cooldown = max(Retry-After capped at 6 h, the 30/60/120/240/300 s ladder,
1.25 s per read answered since the previous limit up to 300 s). An HTTP-date
from a skewed clock could park a creator for years and was persisted. (4) A
read counts as answered only after its envelope is validated; `success:false`
inside HTTP 200 earns nothing and its code is traced (`http.refused`). (5) The
upward probing of E130 is deleted, not disabled: it earned at most ~3 s a scan,
most keys never exercised it, and a 34-second clean trace says nothing about a
faster sustained pace. A key never runs faster than its policy; the controller
keeps the limit, its 24 h memory and the quarter margin. (6) The 1 s storage
deadline stays, but an answer that arrives late is merged in (the stricter of
each field) instead of discarded; a failed restore cannot wedge the lane; an
idle lane that only keeps a remembered limit no longer writes on every
acquire; a lane saved by 2.4.3 loads with its old gap rule. (7) Pace families
match their method. (8) Row recheck (E130) is narrowed: once, only after HTTP
404 or a network error, not sooner than 3 s (the live 404s came in runs of two
or three seconds), never after a 5xx (the transport already spent four
attempts), a refusal inside 200, or a search that gave up after twenty pages
(which cost forty requests for a short username). Five blips in a row stop the
pass with «Fansly отвечает ошибками…» and Continue resumes it. (9) Follower
writes stay one attempt and outside the spacing queue. `POST /group` is refused
at once with `rate_limited` while the lane is cooling down; `POST /message` is
never held: by then the hub holds a dispatch, and a wait that outlives the
send deadline would leave a permanent false «не подтверждено» for a message
that never left. A write Fansly limits counts against the lane. A refused
write carries `{status, code}` and a body-shape trace event; its error key
stays the ambiguous one, so send custody is unchanged. (10) Note batches wait
out the `/account*` key off the lane, first batch included and whatever a
limit has made of its spacing (the pacer reports when a key is next free):
inside the FIFO a batch sitting out its 5 s held every other read, and a send
made meanwhile took 13.5 s in the audited run.

E133 review follow-up (an independent Fable review of the pull request, no
ship blocker). A cooldown saved before the six-hour cap existed is cut to it
on restore. A late storage answer zeroes the heal counter: reads answered
before the penalty arrived ran at the unpenalised pace and forgive nothing
(E128). A read that got no HTTP answer at all carries `status: 0`, so a
network failure on the optional participant read is a blip like any other. A
run of 5xx trips the fuse too, without rechecks. Our own refusal of
`POST /group` is traced as `http.write-refused`, so an export cannot read it
as a 429 Fansly sent. The reviewer also showed that a send or a generation
started during a cooldown waits inside the lane until its own deadline
(60 s / 180 s) and fails with a raw timeout, now that a first cooldown can be
minutes long: the instant refusal at the entry of those actions ships with
E134, which owns that code. The success-scaled cooldown counts reads in
memory only, so a background restart starts it over; FBuddy's third cooldown
term (spacing x clamp(answers)) is not taken.

Not done, on purpose. The two-stage queue that would let ready keys pass a
waiting key: it is latency work on the ban-safety core, the observed stall has
the one-line cure above, and it does not remove a generation's own wait on the
`/account*` key. A clock stepping backwards can still put a lane to sleep for
the size of the step. A 404 is still not treated as a throttle: the first
production trace had none, and `http.error-body` has yet to see one.
Supersedes E130's jitter placement, first-limit rule, 30 s first cooldown,
`floorMs` and learned acceleration, and its broad recheck. This reverses one
line of the 2.4.3 changelog («Ограничение замедляет только своё»): it now
holds for `/account*` only. Validation is synthetic: mock transport, fake
timers, forty-eight manual mutations of these rules. Ships with E134 in one
release.

**E134 (2026-09-20).** An audit of a real 148-follower run (run e12f516f,
@itsaribae, 2.4.3, 48 h; report and raw trace in
`~/Documents/Codex/Logs/ari-extension-audit-2026-09-20/`)
shows that the scan called fans «не писали» on no evidence. All 115 inbox
searches of the run (59 at scan, 56 before send) returned nothing; every
correct «уже писали» came from the saved proof. `check()` read a search miss
as `groupId === null`, that as a complete history, and that as `ready` with
«Личной переписки ещё нет». Two fans with an old personal conversation came out
that way (KBilly212, colossal_torpedoes). On a creator with a cold cache 38 of
152 searches missed and most of those fans had a conversation. Why the search
misses (strong evidence, not needed for the fix): the inbox row carries
`partnerUsername = lower(displayName || username)` as a snapshot that goes
stale, the server `search` matches that field, and the scan searched by
username, so it missed every fan whose display name differs (~18%). One of the
two chats is absent even from a full enumeration of the inbox and still opens
by link, and the listing has no total: no listing and no search can prove
absence. `POST /group` is get-or-create by identity: in 45 of 56 sends it
answered with a group older than the request. The last line of defence held
(send resolves the group by `POST /group` and re-checks before the Hub
reserve), but it held silently: the screen looked exactly like a delivery, a
refresh brought the false `ready` back because the learned chat id lived for
one scan, and an `uncertain` row never re-read its history through the chat id
in its own journal. 10 of 55 history reads ~0.5 s after a send returned an
empty page with HTTP 200. All 56 messages of the session were typed by hand;
«Сгенерировать» was never pressed.

Changes. (1) A follower row says what a `ready`/`reply` verdict rests on:
`evidence: 'history'` (the chat was resolved and read to a confirmed end) or
`'unverified'` (no chat found, nothing proved; verdict reason `chat-not-found`,
`native-search-no-group` is retired). An unverified row stays workable, since
56 of the 59 in the audit were genuine newcomers, but the window says «Чат не
найден» in amber, not the red «Не писали», explains under the history pane that
this is not proof, and has its own status filter. «Личной переписки ещё нет» is
said only over a history read to its end; a chat that is known but unread says
«Историю прочитать не удалось» and its row is `unknown`, never «чат не найден».
(2) This amends E117's "No group is created during a scan": a chat may be
resolved by identity, `POST /group`, one attempt and never retried, at an
explicit human action before the send decision. The actions are the new
«Проверить чат» button (`verify`) and «Сгенерировать», where it happens after
the persona check and before any context is built or AI is spent; the send path
already did it. The row is then re-checked through the real history. A fan who
turns out to be contacted costs no generation, a fan who wrote first gets a
draft over the real transcript. Still forbidden: `POST /group` during a scan,
a Continue, a row selection (the window selects rows by itself), a preview or
the background phase; a test runs a scan, a preview, a pause and a Continue
over the real transport and sees only GETs. Nothing is sent or generated from
an unverified row: both paths require `evidence === 'history'` after their own
resolution, whatever the re-check returned. (3) An empty first history page is
believed only when no answer of this scan named a last message for the chat
(`GET /group`, the listing entry, the `POST /group` answer); otherwise the read
is lagging and the row is `unknown`. E117 is not weakened: a negative verdict
still needs the empty terminal page, the 30-page cap, errors and partial data
stay `unknown`. (4) The fan → chat id mapping is an operational cache,
`chatgoose:followers:v1:group:<creator>:<fan>`, written whenever an id passed a
participant check and read in the row's existing `storage.get`; the personal
proof carries the id too. Resolution order: this scan (listing, search hit,
`POST /group`), the saved id, the send journal's id. A saved id is a lead, not
a fact: every use passes the participant fence, and a mismatch or a 404 forgets
it while the check fails closed. It outlives a rename and lets the read-only
preview of an excluded fan open the real chat instead of searching. (5) A
re-check that takes a row out of a send or a generation throws with explicit
copy («Сообщение не отправлено: у фана уже есть личная переписка. Строка
перенесена в «Уже писали».») instead of returning a snapshot. The window shows
it as a banner that names the fan, keeps that fan on screen with the history
that was found until the chatter moves on, and leaves the typed draft alone:
never deleted, never sent, never turned into a continuation. (6) An
`uncertain` row is read through its journal's chat id. Finding a personal
message there is positive; not finding one changes nothing, and the retry
stays blocked. (7) The inbox listing is used for what it already returns. A
new client read takes the prefix of `/messaging/groups` as deep as the scan's
period (while the last row's `lastMessageId` snowflake is newer than the
cutoff, ten pages at most, page 0 once more for chats that jumped up
meanwhile) and replaces the fixed top 100; malformed `data` throws there. At
scan time an `aggregationData.groups[]` entry that lists exactly the creator
and the fan is the participant check and spares `GET /group`; a thin entry
falls back to it, and every human action still reads `GET /group`. A chat's
`lastMessage` by the creator that is personal under the history path's own
rule, with fresh welcome definitions, is a positive verdict without a history
read at scan time, and at any time it outvotes a history that does not show
it yet; it is never negative evidence. `inbox.page` and `group.search-page`
trace `count`, `groups`, `withUsers`. (8) The text search leaves every verdict
path. After the checks, outside `scanning`, a background phase searches the
still-unverified rows one request at a time by `displayName || username`,
accepts a hit only by `partnerAccountId`, and checks it like a listed chat; a
miss or a failed search changes nothing. It ends after 20 searches without a
hit (on some creators the search never finds anybody), at 150 per scan, on
Pause, close, a cooling lane or a rate limit, and gives way at once to a human
action on the same fan. «Проверено N из N» is shown as soon as the checks are
done and the hints are reported beside it. A matching search row with an
unusable chat id throws instead of reading as a miss. (9) The spenders board
resolves a chat by `displayName || username` too, and its hint says that the
search returned nothing, not that no conversation exists.

Deliberate deviations from the brief. The blocked-send error is a plain
`Error`, not a `ChatGooseError`: `followers-runtime` and `errorText` replace a
`ChatGooseError`'s message with its registry copy, so explicit copy survives
only on the plain errors this file already uses. A failed re-check of a row
whose chat has just become known turns the row `unknown` and offers Continue
(which needs no second `POST /group`), rather than leaving «чат не найден» on a
chat that was found. The page-0 re-read is skipped when only one page was
read, because nothing could have jumped over it.

Not verified live: whether `GET /group` and `POST /group` always carry
`lastMessage` for a chat with messages (an absent field is read as "no last
message", which is today's behaviour); how often the listing entry is thin;
whether the inbox order is strictly by `lastMessageId`; how many fans the
display-name search finds; what Fansly makes of one `POST /group` per
«Проверить чат». The scan issues far fewer reads than before (one listing in
place of a search per unlisted fan), so E130's pace figures no longer describe
it. Validation is synthetic: mocked transport, fake timers, jsdom, and manual
mutations of each new rule. No settings or schema migration; no version bump.

E134 integration follow-up (2026-09-20). A design audit that ran while this was
being built asked for a simpler shape; the implementer never received it (the
amendments reached it inside a tool result and it rightly ignored them), so
they were weighed against the finished code instead. Kept as built: the
budgeted background search and the `evidence` field, both already pinned by
tests and mutations. Changed on the merged branch: the search hint reads one
page only (a common display name would otherwise page twenty requests for one
fan, and a miss proves nothing either way); the inbox prefix stops as soon as
every wanted fan is matched; a listing `lastMessage` is a verdict only when it
carries `type`, `correlationId` and `inReplyTo` (Fansly's key sets drift, and an
absent `correlationId` would turn a mass DM into a personal one and hide a fan
as already greeted); verify, generate and send refuse at once while the lane is
in a cooldown, before anything is reserved (E133 made a first cooldown minutes
long, and an action that joined the lane burned its own 60 s / 180 s into a
bare timeout); a refused `POST /group` shows Fansly's own code («Fansly отказал
в открытии чата (код N)…») and guesses nothing about its meaning; the window no
longer loads the chat it has just written to (two reads a send); «Чат не
найден» is a neutral colour, because on some creators it is the normal state of
almost every newcomer. Not taken: confirming participants once per send
operation instead of three times (two fewer reads a send, sends being most of
a session's Fansly traffic). It is sound on paper and it is the send path, so
it waits for the owner's decision and a live trace.

**E135 (2026-09-20).** The owner authorizes releasing the pacer safety patch
(E133) and the chat-identity fix (E134) as 2.4.4, in one release as asked
(«релизы не дробить»). Production Core moved to contract hash `42c705b8…` the
same day, so the release rides on the SDK re-vendored from Core `301a127a`
(E132, merged first; its own condition — production serving that hash — was
checked against `/api/v1/health` before the merge). That re-vendor took the
number E132 on main first; this branch's decisions were renumbered to E133 and
E134 in the log, the code comments and the tests alike. Both changes went
through one pull request: the pacer branch was merged into the chat-identity
branch and its own pull request closed as superseded.

Validation is synthetic throughout: mock transport, fake timers, jsdom, and
about 150 manual mutations across the two changes, all killed but one that is
unreachable behind a second guard. Nothing here was measured against Fansly.
The first production scans are that measurement, and the trace now answers
each open question by itself: `inbox.page` / `group.search-page` count how
often a listing entry is thin, `group.last-message` whether `POST /group` and
`GET /group` carry a last message, `background.result` how many chats the
display-name search finds, `http.cooldown` / `http.refused` / `http.error-body`
what Fansly objects to and how. This reverses one line of the 2.4.3 changelog
(«Ограничение замедляет только своё» now holds for profile reads only); the
2.4.4 changelog says so. Still open and the owner's to decide: confirming
participants once per send operation instead of three times, and a truthful
status for fans whose DMs are restricted (needs one real `GET /group` capture
of such a chat). Rollback is a feed release; neither change migrates storage,
and the new operational keys (`chatgoose:fansly-pacer:v1:*`,
`chatgoose:followers:v1:group:*`) are ignored by older builds.

**E136 (2026-09-20).** Unified Hi greeting, the extension half of Core Decision
379 (core PR #246). Spec: `docs/specs/2026-09-20-unified-hi-greeting.md`. Written
as E133 on a branch cut before E132–E135 landed on `main`; renumbered to E136
here, in the code comments, the tests, the spec, the README and the guide, on
the merge. Until now the kernel flag
`greetingMode: "new-follower"` (E117) bundled four things (template, one draft,
extra inputs, gate skipped), so every context improvement reached one surface
only: the chat Hi had no avatar, no username, no saved name, no automation
labels, and its gate counted mass messages, locking out a fan with 11 automatic
messages and no personal one while the New Followers window greeted him.

What changed. (1) `src/shared/greeting-context.ts`, pure: profile fields bounded
to the Core contract (200/200/200/5000 UTF-16 units, never half a surrogate
pair), the avatar through the one Fansly URL check (`safeFanslyAvatarUrl`, split
out of `fanslyAvatarUrl`), the `[Automatic / mass message]` transcript label,
`isAutomatedGreetingMessage` (only the model's own message can be automated,
decided by `isAutomatedMessage` alone) and `personalMessageCount` over the
window the transcript formatter KEPT, so it can never exceed
`clientContext.messageCount` (Core rejects that with 400). These are context
values and labels; prompt assembly stays in the kernel. (2)
`src/background/welcome-definitions.ts`: the creator-scoped loader moved out of
`FollowersService` unchanged (same storage key and `{ texts, checkedAt }` shape,
24 h cache, one paced read per creator, stale fallback, older texts retained,
the `welcome.*` trace), plus `peek` (cached texts of any age, no network) and
`loadWithin` (below). ONE instance is built in `src/background/index.ts` and
injected into both surfaces. (3) Gateway: `variantCount?: 1 | 3` replaces
`greetingMode`; `fanUsername`, `fanAvatarUrl`, `personalMessageCount` and
`variantCount` are sent for `hi-greeting` only, guarded in the gateway because
Core answers 400 to them on any other feature. `greetingMode` no longer appears
in `src/`. (4) Followers: `variantCount: 1` and `personalMessageCount` instead
of the mode. (5) Chat Hi: `variantCount: 3`, the automation label on the model's
automated messages inside the chat's own media/PPV transcript, profile fields
from the shared module, `personalMessageCount`, and the new gate.

Decisions taken by the coordinating session during the work (reported to the
owner, not individually approved), where they differ from the first spec draft. **Avatar:** the chat's account read (`getAccountNames`) is live and
uncached on every generation, so the signed URL is fresh; no extra Fansly
request exists for the avatar and the draft's "refresh if cached" branch is
dropped. A failed lookup stays non-fatal and gives a text-only Hi. **Gate in
the chat:** Hi still reads ONE Fansly page (25 messages). If that page does not
reach the start of the conversation (`!providerReachedEnd`) the client fails
closed with `hi_too_many_messages`; otherwise more than 10 personal messages on
the page fail the same way. A fan with exactly 25 messages is cut (a full page
is not proof of the end), accepted. **Welcome definitions in the chat:**
cache-first and never in the way. A cache younger than 24 h answers with no
network; otherwise the normal paced load gets `HI_WELCOME_LOAD_TIMEOUT_MS`
(4 s) through a caller-only signal, and on timeout or failure the stale cached
texts are used, else an empty set, in which case automation is still seen by
its independent markers (type 2, a correlation id that is not a reply). The
shared read keeps running and fills the cache. The reason is the pacer: the
read rides the creator's follower lane, which a running scan or a 429 cooldown
can hold for minutes. The outcome is a `welcome-definitions` profiling stage, so
a slow or failed load is visible in debug mode. **Names in the chat Hi:** the
followers ordering, display name first, then username, then `fan`, with the
username in its own field (the kernel drops the username line when the two are
equal). Only for `hi-greeting`; every other feature keeps the username-first
`kernelFanDisplayName` of E115 / Core Decision 290, and in both cases the name
comes from the account lookup, never from the DOM label. **Custom name cap:**
for Hi it now goes through the shared module; `kernelFanCustomName` still cuts
by code points while Core counts UTF-16 units (a name of 100+ emoji would pass
the client and get a 400). Left alone for the other features, a follow-up.

Accepted behaviour changes. A follower with more than 10 personal messages in
the reviewed window (in practice: a fan who wrote 11+ unanswered messages) no
longer gets a one-line draft from the queue. The window refuses before any
further Fansly or hub read and says: "В переписке уже больше 10 личных
сообщений: это диалог, а не приветствие. Откройте чат и используйте Ответ
(Reply)."; the kernel's `gate_hi_greeting_limit` maps to the same wording, the
row stays composable by hand, and the `[VARIANT]|[NEXT]` guard and all
persona/session fencing stay. The `hi_too_many_messages` card now explains
personal messages and the one-page rule. The chat Hi opens for fans whose whole
history fits one page and holds at most 10 personal messages, mass messages no
longer counting.

Known limitation, an open owner question: a page that mass-messages daily puts
25+ automatic messages into a chat within weeks; that fan's history no longer
fits one page, so the chat Hi stays closed for him while the New Followers
window (which reads up to 30 pages) greets him. Closing the gap means reading
more than one page for Hi, which is extra Fansly egress on the chatter's own
session. Not done here.

Compatibility and rollout. The new fields are unknown keys to an older strict
kernel (400), so Core Decision 379 must be DEPLOYED before this ships; released
clients (<= 2.4.3, of-desktop) keep working through the deprecated
`greetingMode` alias. `vendor/kernel-sdk` is vendored from the core feature
branch `1c8532c1` (contract hash `2620650e…`), which is not a release vendor:
re-vendor from the deployed core commit at release time. Against main's E132
vendor (Core `301a127a`) it adds the hi-greeting contract only — `variantCount`,
`clientContext.personalMessageCount` and the refinement that keeps the latter at
or below `messageCount`. No version bump, no changelog:
the release is a separate owner step. No AI request is retried anywhere in this
change, no new Fansly route and no unpaced request are added, and no storage
migration is needed. Validation is synthetic (mock transport); live Fansly, the
live kernel and the browser were not exercised. Supersedes the "separate mode"
part of E117. Follow-ups: of-desktop migration to `variantCount`, the
code-point cap in `kernelFanCustomName`, removal of the alias once no supported
client sends it.

**E137 (2026-09-20).** The owner authorizes releasing the unified Hi greeting
(E136) as 2.4.5 on his word. Version 2.4.5, a patch per the owner's numbering
(E120); package and manifest advance together, both changelogs, the landing
stamp and the README release note move with them.

Sequencing. The kernel half, Core Decision 379, is merged as core `82571f3c` and
deployed to production before this release: an older strict kernel answers the
new fields (`variantCount`, `clientContext.personalMessageCount`) with 400, so
the client cannot ship first. `vendor/kernel-sdk` is re-vendored from that
deployed commit, contract hash
`2620650e66ddf368a8265f062712f37215ae3477fbb934ad6b3555ceb1b2d4bc`, replacing
the interim vendor E136 took from the core feature branch commit `1c8532c1`.
The release gate in `scripts/deploy.sh` refuses to publish while the vendored
hash differs from production's.

Validation. No independent code review was run on this change: the owner
declined one. What backs the release is the synthetic suite (mock transport,
fake timers, jsdom) that pins the followers request on the wire against the
vendored Core schema and covers the chat Hi gate, the automation labels, the
welcome-definitions fallbacks, the text-only fallback and the no-retry rule,
plus a before/after render of the kernel prompt. Not verified before the
release: live Fansly and the browser.

Follow-ups carried over from E136, none of them closed here: of-desktop still
sends the deprecated `greetingMode` alias and migrates to `variantCount` after
its own SDK re-vendor; `kernelFanCustomName` still caps by code points for the
features other than Hi, while Core counts UTF-16 units; the alias is removed in
core once no supported client sends it. The open owner question also stands: a
fan whose chat holds 25+ automatic messages no longer fits the one page the chat
Hi reads, so Hi stays closed for him while the New Followers window (up to 30
pages) greets him; closing that gap means multi-page reads for Hi, which is
extra Fansly egress on the chatter's own session.


**E138 (2026-09-22).** The owner requests a fast first pass followed automatically
by verification of only the unresolved remainder (for example, six of 67 fans),
while confirmed rows remain usable. The owner explicitly accepts that resolving
a chat by account IDs can create an empty technical chat. This supersedes
E134's ban on `POST /group` during a user-started scan/Continue and removes its
budgeted background text search. It does not authorize unattended runs,
generation, messages, a version bump or deployment.

Evidence. A recorded KBilly case was absent from the inbox and text search.
`POST /group` returned the old chat ID and the creator's `users[].userSettings`
with `hidden: 1`, but omitted `lastMessage`; subsequent group/history reads
showed an outgoing personal message. Omission of that field is not empty
history. The cause of `hidden: 1` on the old chat is not established, and is
not described as a human hiding it. A separately observed new empty chat also
had `hidden: 1`; neither observation changes that setting or proves the cause
for another chat. Regression tests use synthetic participants and messages.

Implementation. One scan has two phases. Discovery and existing positive
proofs, inbox matches and saved IDs are the fast pass. A miss becomes `pending`
(`В очереди`), with no eligibility evidence. The sequential second phase
rechecks local proof/custody, resolves only an unresolved identity with one
`POST /group`, validates exactly the creator/fan pair, saves the ID immediately,
then uses the same group/history checker. No negative classification comes
from a text search, an omitted POST `lastMessage`, or a hidden flag. Personal
outgoing evidence excludes the fan; a history read to its confirmed end is
required for `ready`/`reply`. An advertised last message with an empty first
history page remains unknown. Positive proofs, welcome/mass classification,
participant fences, history pagination bounds and live revision checks remain.

Queue and transport. One unresolved fan is processed at a time. Selection
moves only the next queued ID; it neither interrupts an in-flight opening nor
starts a separate run. Confirmed rows keep their statuses and drafts. All
mutating row actions share a creator/fan lock, and a human action joins an
active verification before taking that lock. Group POSTs share the existing
paced creator FIFO with GETs. Message POSTs bypass that lane after Hub dispatch.
Group POSTs and the second phase's group/history GETs have one attempt per
request: a first 429 stops the tail, retaining the shared cooldown and visible
stop reason. Five consecutive network/timeout/404/5xx failures trip a fuse.
A per-fan refusal such as HTTP 403 is recorded for that fan without tripping
the outage fuse. No failed group opening is automatically replayed in the
same pass; Continue is an explicit retry of the remaining rows.

Pause and continuation. Admission cancellation is separate from request
cancellation: Pause removes a group POST still waiting for a permit, but lets
an already dispatched opening complete and persist its verified ID. The queue
then stops before the next group/history read. Window close and session change
remain hard cancellation, and late responses cannot cache another session's
result. Continue does not reload followers or reset confirmed rows: it checks
only unfinished rows, follows the saved ID when available and resolves only
identities that still lack one. The UI reports confirmed counts and the
remainder separately, preserves composer focus/caret while other rows change,
and permits a pending draft while disabling generation/send until history is
confirmed. A legacy ready/reply row without history evidence fails closed.

Send custody is unchanged: an explicit send checks current history and the
reviewed revision, reserves and dispatches through Hub, journals the attempt,
and validates the Fansly message receipt. An indeterminate send is never
retried. Refresh and preview cannot authorize messages. POST message never
waits in the creator FIFO after custody has been granted.

Validation: real paced transport with mocked HTTP pins KBilly, queued versus
in-flight Pause, saved-ID reuse, late responses after close/session change,
GET/POST 429 stops, one-attempt failures and the outage fuse. Service tests pin
priority, confirmed-row use during the tail, shared row locks and existing
send preflight/custody. The 146- and 194-follower transport scenarios remain,
with the new identity-resolution contract. UI tests cover pending labels,
blocked actions, draft/focus/caret preservation and remaining-only Continue.
The full `pnpm check` gate passed. A local mocked Playwright browser preview
at 1280 and 430 px verified the ready/pending controls, remaining-only Continue
and actual textarea identity, focus, selection and draft preservation.
Live Fansly timing, request totals and rate-limit behavior of the new version
remain unmeasured; this decision makes no speed or deployment claim.

**E139 (2026-09-22).** After reviewing the E138 implementation, the owner asks
for a release ("вроде все, надо релиз"). Prepare 2.4.6, the next patch after
both freshly fetched `origin/main` (`6a76227`) and the published feed's 2.4.5.
Package and manifest advance together; both changelogs, the landing stamp and
README describe the two-phase verification. E138 remains the historical record
of implementation authorization before this separate release request.

The coordinating agent independently reviewed the queue, transport regressions
and local UI screenshots without finding a release blocker. Validation covers
the full `pnpm check` gate, mocked HTTP through the real pacer, jsdom and an
isolated Playwright preview. Live Fansly timing, request totals and rate-limit
behavior remain unmeasured. No Fansly messages are sent as part of validation.
No SDK or Core contract change is part of this patch.

Publication follows review and CI on the final release commit, through the
existing `scripts/deploy.sh` gates on clean, pushed `main`. This entry records
the authorization and prepared version, not a completed deployment; the signed
tag and served update feed remain release evidence. Use `SKIP_ANNOUNCE=1`:
the owner did not authorize messaging the Telegram channel. This suppresses
the send and its credential requirement while keeping the local changelog
preflight before signing.


**E140 (2026-09-26).** Production Core moved past the vendored SDK twice:
Core Decision 381 (core #253, `5d4cf1b1`) added the `alert_digest_scheduled`
notification delivery kind (contractHash `3653a5f4…`), and H3 (core #265,
`a51e687d`) added an optional `platform` filter on the v2 stream and snapshot
(cursor versions 5/6 bound to it), optional `transactionRef`, `provenance` and
`thread` on domain-event frames, and the new `eventsV2Facts` operation
(`GET /api/v1/events/v2/facts`). Production now runs Core `a51e687dbf6b` and
`/api/v1/health` answers contractHash
`21a767b83fbcd73c20f1d54a131f814b5eadc1b6b12f6c2be7c4ad8ececccf5a`, while the
vendored SDK still carried `2620650e…` from Core `82571f3c` (E137). The
extension calls none of the changed operations: it does not read the v2 event
stream, snapshot, facts or notification settings, so nothing changes at
runtime; installed builds only show the "SDK contract" row of the options page
as drifted. The release gate in `scripts/deploy.sh` is what requires the
refresh: no release passes while the vendored hash differs from production's.

The SDK is regenerated by Core's `scripts/vendor-sdk.mjs` from a clean detached
worktree at `a51e687dbf6be2bdb811f12c650651f285158e2f` (the deployed commit);
the generated hash equals production exactly and `sourceCommit` is clean. The
diff is the items above plus one Core doc comment, nothing else. `pnpm check`
passes on the regenerated SDK with a real install in the worktree (131 suites,
2,492 tests, typecheck, lint, gates, build). No vendored file is edited by hand
and no release check is bypassed or weakened. Production already serves the new
hash, so this merges at once. No version bump: nothing user-visible changes,
and the refreshed SDK ships with the next planned release.

**E141 (2026-09-27).** Chatters work both ChatGoose clients and complained that
the same action has different keys: the extension used ⌘⇧ + letter on macOS and
Alt+Shift + letter elsewhere, the desktop app bare ⌘/Ctrl + another set of
letters. The owner asked for one scheme everywhere and, after a three-model
design review, chose the one below. It is no longer defined in this repo: the
table, the matcher and the labels live in the hub's
`packages/chatgoose-hotkeys` (its README is the spec) and arrive here through
the hub's `scripts/vendor-hotkeys.mjs` as `vendor/chatgoose-hotkeys`
(`@chatgoose/hotkeys`, generated, never hand-edited; the vendor test pins every
file against the manifest, and both clients must ship the same sha256 from the
same hub commit — the source commit and sha256 are in
`vendor/chatgoose-hotkeys/chatgoose-hotkeys.vendor.json`).

The scheme: everything that writes into the reply field plus Cancel is
⌘ + key on macOS and Ctrl + key on Windows (E Reply, I Fix, G Hi, P Ping,
. Cancel); analysis, panels and toggles are ⌘⇧ + key on macOS and Ctrl+Alt + key
on Windows (H Help, S Recap, O tone, B Review, L Split, M Spenders, C Coach —
Coach is extension-only). `?` outside inputs stays the cheatsheet. Keys match by
`event.code`, so the Russian layout works without switching. Facts behind the
letters, from Firefox's `browser-sets.inc.xhtml`: among bare accel + letter only
N, T, W (and quit) are reserved, among accel+shift P and W; every combo used is
claimable by the page, and a missed press opens find, page info, print or a
sidebar — never a reload (R unused; F stays find-in-page, which the chatters use
in chats). ⌘⇧V stays paste-as-plain-text, so Review moved to B. Windows cannot
carry hotkeys on Ctrl+Shift or Alt+Shift: the team switches the input language
with both (and Win+Space). This corrects the old header of
`src/shared/hotkeys.ts` and `tests/hotkeys.test.ts`, which claimed Firefox
reserves ⌘⇧ R/T/B/A and that Ctrl+Shift + letter cannot be intercepted — the
source says neither.

Engine rules (vendored): strict modifiers per level and platform; a fresh-press
roll-over guard on Reply/Fix/Hi/Ping (a switch of input language followed by a
letter under the still-held modifier does nothing); auto-repeat is claimed but
never re-runs; macOS keeps the old ⌘⇧E/⌘⇧I/⌘⇧G and ⌘⇧X as the same actions and
swallows the retired ⌘⇧D/⌘⇧F in a chat. One engine instance per tab is shared by
the bootstrap and the conversation bundle (`src/content/hotkey-input.ts`, a
realm-global slot) so the guard sees every modifier. Inside a chat every
recognised combo is claimed (a blocked action keeps its reason toast); outside
one only Spenders and the cheatsheet are, and the browser keeps the rest. The
generic `src/shared/keymap.ts` engine is deleted.

The in-page cheatsheet and the Options «Хоткеи» pane render one list
(`buildHotkeyEntries`), grouped «Пишут текст» / «Разборы и панели» / «Справка» /
«Различается с приложением»; the stale «horny», «Fan Summary» and «Помоги-мне»
names are replaced with the product vocabulary. Prepared as 2.5.0 (package,
manifest, CHANGELOG, changelog.html, release pages, guide). Not deployed: the
desktop app must ship the same scheme first, since a non-updated desktop reads
the new ⌘E / Ctrl+E as its old Review. Live checks on real macOS and Windows
keyboards (EN/RU, the three language switches, Firefox full screen, Services on
⌘⇧L/⌘⇧M with selected text) remain before release. Deploy with
`SKIP_ANNOUNCE=1`: the owner posts the announcement.

**E142 (2026-09-27).** Split works on Fix, as it does on Improve in the
desktop app (its D42, Core #268). A chatter asked for it after the desktop got
it; the owner said «да давай сделаем». The name Fix stays (owner, the bar has
no room for «Improve»).

- One Split flag for Reply and Fix: the square in the Reply capsule and ⌘⇧L /
  Ctrl+Alt+L arm both, and Fix now sends `replyMode: preferSplit` because its
  policy has `supportsReplyMode`. The hint, aria label and hotkey label name
  both buttons. The square stays in the Reply capsule where chatters know it.
- The kernel writes the parts: with Split it cuts the draft at its natural
  seams into 2–3 messages without shortening it (a one-liner becomes two short
  texts); without Split the Fix prompt and result are unchanged.
  `buildFeatureResult` splits a `single-reply` on [NEXT] only for a feature
  with the Split policy that asked for it and marks `splitModeRequested`.
- Presentation: one part auto-inserts into the composer as before. Two or
  three parts open in the inline panel, each with its own Insert, the Split
  note, Enter-inserts-next and first-Insert focus (also when expanded to the
  overlay), like a Split Reply. The
  panel is pinned to the draft the result was made from (`inlineImprove`):
  its cache lookup no longer follows the live composer, so inserting or
  sending part 1 keeps parts 2–3, and Regenerate reruns that draft even when
  the composer is empty. Closing the panel, a new operation or a chat switch
  drops the pin.
- The Fix cache key carries the mode (`split\u0000<draft>`), so a Split Fix
  and a single Fix of the same draft never answer for each other.

Not released: ships with the next extension release after the owner's go.

**E143 (2026-09-28).** The 2.5.1 release stopped at the `scripts/deploy.sh`
contract gate before signing: production Core moved from `219d4386` (Core #268,
the Split prompt E142 relies on, contractHash `21a767b8…`) to `89134bb28b3f`
(Core #267, deployed 2026-09-27 20:53 UTC), and `/api/v1/health` now answers
`abf87a6567a774d16900db4b9f250a4c9c6a38ee9f071495d443881e66421f41`. Core #267
adds the OnlyFans desktop media operations (`ofapiMediaResolve`,
`ofapiMediaReports`) and reshapes the OFAPI collection registry and read
catalog. The extension calls no OFAPI operation, so nothing changes at runtime.

The SDK is regenerated by Core's `scripts/vendor-sdk.mjs` from a clean detached
worktree at `89134bb28b3f8df0a25efd96c36de735431545e6`; the generated hash
equals production exactly and `sourceCommit` is clean. No vendored file is
edited by hand and no release check is bypassed. No version bump: it ships
inside 2.5.1, which was not yet released.

**E144 (2026-09-28).** AI image notes — the extension side of Core's AI media
describer (owner-approved plan «AI понимает картинки в чатах», image arena
2026-09-27/28; Core PRs #269–#271). The hub describes chat images in the
background (one Anthropic call per file, text only stored) and fills ready
descriptions into the prompt; generation never waits for them.

- `normalizeTranscript` records, per message, which files behind its labels
  the kernel may describe (`mediaSlots`): a fan's photo/video, the creator's
  free media, a PPV's free teaser — never the body of a paid PPV.
- `formatTranscriptWithMediaForKernel` numbers the KEPT window's files in
  transcript order (newest 1000 at most) and returns `clientContext.media`:
  `groupRef` (the chat URL's canonical groupId) plus, per file, the number,
  placement (`inline` `[Photo #3]` replacing `[Photo]`; `appended`
  ` [Photo #4]` after a bundle label; `preview` ` (preview #8)` after a PPV
  label), message id and time, sender, kind, accountMedia id and paid flag.
  Ids only: no URL, no bytes, no new Fansly request. The kept window is
  exactly the legacy one (same oldest-first 300k cap); the newest files are
  numbered while their tokens still fit under the cap, older ones keep the
  plain label.
- A message text can never forge a label: `[Photo #3]`-like text gets a
  fullwidth `＃`. The kernel also refuses substitution when a token's count or
  order does not match the list.
- While the hub's describer is off for the page (or for fan-summary, which
  never gets descriptions), the kernel restores the plain labels, so the
  prompt is the legacy one. Main lane, Compare cards and Voice Script send
  it; the New Followers greeting has no window media and sends none.
- The SDK is re-vendored from the deployed Core that accepts the field (the
  hub deploys first; its strict schema would 400 an unknown field). Released
  as 2.6.0.

**E145 (2026-09-28).** Incoming-message sound — the chatters asked for the
desktop app's blip on Fansly (owner-approved plan from the 2026-09-28 arena:
Opus 5.5, Fable 5.1, gpt-6-astra; owner answers: only while a tab of the model
is open, tips silent as D39, volume/tone and a per-model switch, no OS
notification, straight to everyone).

- **Signal = the page's own socket.** Fansly creates `new WebSocket(uri)` on
  every (re)connect (`setUpConnection`, main.51b59e98940f00c0.js) and parses
  `t:10000 → serviceId 5 → JSON.parse(event).type 1` as a new message; `t:10001`
  is a batch of wrapper strings; `t:1` carries the session and is never parsed.
  `content-socket-tap.js` runs in the MAIN world at `document_start` and puts a
  Proxy over `window.WebSocket`: exactly one `Reflect.construct`, the NATIVE
  object back (`instanceof`, statics, `prototype`, `send`, `on*` untouched, a
  constructor exception reaches the page), a passive `message` listener only on
  `wss://wsv3.fansly.com`. The hub was rejected (Fansly messages reach its
  archive in minutes); a second socket of our own or polling would be new
  Fansly egress; the unread badge cannot tell a tip or our own message apart.
- **Bridge.** Only `{id, groupId, senderId, type, createdAt, correlationId,
  inReplyTo, tip}` leaves the page — no text, media, amounts or frames — as a
  `CustomEvent` with a JSON-string detail (not `postMessage`: Fansly has its own
  global `message` handlers). `type ≠ 1` is dropped in the page so a mass send
  from this tab never floods the background. `content-sound-relay.js` (ISOLATED,
  `document_start`, no zod) validates and forwards one-shot, reports the tap's
  state at most every 5 s, and arms/disarms the tap from the switch. The bridge
  is page-reachable: a forged event can at most ring once (throttled).
- **Decision in the background** (`message-sound-service.ts`), one candidate
  at a time: duplicate (LRU 2000 ids / 10 min, key = message id) → disabled →
  own (`senderId` ∈ the tab session under its legacy AND canonical id ∪ persisted
  `knownAccounts` ∪ both sides of `accountAliases` — `getAccountIdForTab` is the
  legacy key, so it alone is not enough) → automated (`type ≠ 1` or the existing
  `automationReason` correlation rule) → tip (attachment `contentType 7` or
  `totalTipAmount > 0`; live tips carry the attachment without the amount) →
  stale (older than 180 s — Fansly's own rule; no createdAt is live; no future
  bound) → muted / account-unknown (an unattributed tab rings only while no model
  is muted, and such a verdict does not consume the id) → audio ready → fresh
  settings, tab still open, open chat (active tab of the FOCUSED window on
  `/messages/<groupId>`) → one synchronous section: 2 s throttle, reserve, start.
- **Sound in the background page**: Firefox blocks audible autoplay in a tab
  until a click (`media.autoplay.default = 1`) and exempts extension background
  pages (`media.autoplay.allow-extension-background-pages = true`). `blip` at
  50 % is the desktop note (880→1320 Hz, 0.06, 0.2 s); `double`, `soft`;
  volume 5–100 % quadratic up to 0.24 (+12 dB). «Проверить звук» plays through
  the same player.
- **Settings v18** in the `settings` blob, written only by the options page
  (E59): `messageSoundEnabled` (on), `messageSoundTone`, `messageSoundVolume`,
  `messageSoundMutedAccountIds` (a mute list, so a new model rings; stored under
  the row's id, matched through aliases — the background never rewrites it,
  which would make it a second settings writer). Card «Звук» in «Вид», a switch
  per row in «Аккаунты», a «Статус» row and report lines (counters only). The
  master switch is also placed in the sign-in form: a rejected sign-in keeps
  the token stored and the cabinet closed, and the sound does not need the hub.
- Tabs opened before the update have no tap until reloaded; the status says so.
  Verified in Firefox 156 (logged-out fansly.com opens wsv3 and the tap sees
  it; a bridge event reaches the background and plays). Released as 2.7.0.

**E146 (2026-09-28).** New-follower sound — the owner asked for it right after
2.7.0, with separate switches for messages and follows, as 2.7.1.

- The model's own socket receives FollowerService events live: in the hub's
  captured frames for the week to 2026-09-28, `serviceId 3` `type 2` arrived
  with `follow: {id, accountId, followerId, …SortOrder}` about 600 times over
  4–5 pages, `accountId` being the page (a fan followed the model); `type 3` is
  an unfollow. Fansly's own client only handles a follow BY the session account,
  but the event reaches the followed account too.
- The tap projects `{id, accountId, followerId}` onto its own bridge event
  (`chatgoose:fansly-follow`) and runtime action (`follow`); unfollows are not
  forwarded. The relay arms the tap while EITHER sound is on.
- The background runs follows through the same serial chain, throttle and
  player: duplicate (key `follow:<id>`; there is no createdAt, so no freshness
  rule) → disabled (`followSoundEnabled`) → own (`followerId` is ours: the model
  followed someone) → not-ours (`accountId` is not one of our models) → muted
  (the per-model list, matched against the model the event names and the tab's
  session) → audio → fresh settings, tab open → throttle + start. No open-chat
  rule: a follow is not a chat. A follow never takes a message's ring: messages
  keep their own 2 s pause; a follow waits out a message ring (2 s) and the last
  follow ring (10 s), so a follow wave rings at most every 10 s. A `not-ours`
  verdict is not consumed (the tab's identity may be unresolved; a bound tab's
  copy must still ring). Counters are kept apart (`followOutcomes`); a 2.7.0 tap
  still living in a tab (no follow counter) counts as «reload».
- Settings v19: `followSoundEnabled` (on) and `followSoundTone` (`double`, to be
  told apart from the message blip); volume and the per-model mute are shared.
  The card gains «Звук новых фоловеров», «Сигнал фоловеров» and «Проверить звук
  фоловеров»; both switches ride into the sign-in form. A v18 record with the
  sound OFF (2.7.0's only switch) starts with the follower sound off too.
  Released as 2.7.1.
- **Fansly sounds unlike the OnlyFans app** (owner, same day: identical
  sounds on both clients mislead a chatter working both). Five synthesized
  tones join — `chime`, `drop`, `bell`, `arpeggio`, `knock` — for eight in all;
  the message default becomes `chime`, and the desktop `blip` stays as «Как в
  OnlyFans». A v18 record still on `blip` (2.7.0's default, hours old) adopts
  `chime` via a raw transform anchored on v18; a v19+ `blip` is kept.

**E147 (2026-10-11).** `scripts/setup-vps-ext.sh` is removed. Nothing in the
repository creates or rewrites the nginx site of `ext.gosling-agency.ru` any
more; the owner chose this over repairing the script.

- The script provisioned the site on 2026-03-24, when the extension moved
  from `gosling-agency.ru/ext/` to its own name. It rewrote
  `/etc/nginx/sites-available/ext.gosling-agency.ru` from two templates (HTTP,
  then HTTPS after certbot) and edited the Hub's nginx site
  (`cleanup_agency_hub`). It has not run since: the site file on the previous
  server is dated that day.
- Read on 2026-10-11 from both servers (read-only), the HTTPS template and the
  live file differ only by what the file gained on the server: `location =
  /goosemuse-latest.xpi`, there since March and written by no committed
  version of the script, and on agency-de `location /u/`, the Windows desktop
  update feed, added by the server move (`migrate/70-ext-feed.sh`) together
  with a temporary 403 guard. A run would have erased all three.
- The Hub edit was the worse half. The GooseMuse → ChatGoose rename (94ec263,
  two days after the run) renamed the markers the script looks for to
  `CHATGOOSE EXTENSION`, while the Hub's site still carries `GOOSEMUSE
  EXTENSION HARD CUTOFF`. Run on a copy of the live Hub site, the function's
  own code adds a second `location ^~ /ext/` to the same `server` block. nginx
  refuses a duplicate location (known nginx behaviour; no nginx binary was run
  for this), so `nginx -t` fails after both files are already written: the
  running nginx keeps its loaded configuration, and the next restart does not
  come up, for the Hub and every other site on the server. A second run breaks
  the file even with matching markers: the begin marker is a prefix of the
  cutoff marker, and the removal leaves ` HARD CUTOFF` behind as a bare line.
  The script itself asks to be run again when DNS has not propagated.
- Between its two reloads the script left an HTTP-only site. PR #140 pointed it
  at agency-de, where all of the above applies.
- Considered and not taken: keep the script, make the template equal the live
  file without the guard, drop the Hub edit, refuse to overwrite a live file
  that differs. The file serves three projects and is changed on the server,
  by hand and by server moves, so a template here falls behind again (twice
  since March). The script was last used in March, and the move to agency-de
  copied the file instead of running it.
- README «The site on the server» replaces it: where the file lives, what the
  deploy scripts need from the site, who else publishes into it, and a copy of
  the file as read on 2026-10-11 without the temporary guard. The copy is there
  because the server-move scripts are outside any repository and read the file
  from a server that is about to be closed.
- The upload-host test (`tests/release-pages.test.ts`) covers the two deploy
  scripts; the `EXPECTED_IP` pins added in #140 went with the script.
- Removing the script changed nothing on a server. Found on the way: the site
  served `chatgoose-latest.xpi`, the landing's install link, as immutable for
  a year, because the no-cache rule still named the pre-rename alias. On the
  owner's request the rule was pointed at the current name on both servers the
  same day: one line, `location = /chatgoose-latest.xpi`, with a copy of the
  previous file next to each (`….bak-before-latest-xpi`). The copy in the
  README is the file after that edit. A browser that already holds the alias
  as immutable keeps it for up to a year; auto-update brings such an install
  forward.

**E148 (2026-10-11).** The deploy scripts prove that the upload host is the
server behind the public name before anything is signed or uploaded.
`deploy.sh` and `deploy-pages.sh` upload to `VPS_HOST` over SSH and check the
result through `BASE_URL`; nothing tied the two together. With
`ext.gosling-agency.ru` moving to another server and the host replaceable
through `CHATGOOSE_VPS_HOST`, they can differ. Reproduced on 2026-10-11 with
`ssh`, `scp`, `curl`, `pnpm` and `web-ext` replaced by recorders: `deploy.sh`
passed every preflight, signed with AMO (the version is spent), uploaded to a
server nobody reads and failed about five minutes later on the versioned XPI;
`deploy.sh --pages-only` and `deploy-pages.sh` reported success on the other
server's old pages. E33 says a deterministic failure stops before the AMO
request.

- `assert_upload_host_serves_public_site` writes `.upload-host-probe.<32 hex>`
  into `REMOTE_DIR` over SSH (the content is the same random token), reads it
  through `BASE_URL`, removes it, and passes only on HTTP 200 with exactly
  that token. It runs after the Core gate and before `pnpm build` in the
  release path, after the provenance asserts in `--pages-only`, and after the
  feed-parity gate in `deploy-pages.sh`.
- It is not a DNS comparison. The move is planned as forwarding from the old
  server, with a DNS switch as the other way
  (`~/code/8-docs/2026-10-10-server-migration-netcup/plan.md` §9; the forward
  is installed by `migrate/70-ext-feed.sh switch` there). Under forwarding DNS
  names the old server while the upload host is the new one. The marker passes
  in both arrangements and fails in the mirror cases: the default host before
  the switch, a stale `CHATGOOSE_VPS_HOST` after it, the default host after
  the script's way `back`. So a release or a page publish in a mismatched
  state stops in preflight, whichever comes first, the host change or the
  switch.
- Every other outcome stops the run and says which it was. HTTP 401 or 403 is
  reported as a refusal, not as another server: the new server answers 403 to
  everyone but the old one until the name moves to it, and with DNS switched
  before that fence is lifted the upload host is right and the site still
  refuses. Any other answer that is not the marker is "served elsewhere", with
  the upload host and the status. No usable answer (no connection, 5xx) is
  "could not check". A failed SSH write and a failed removal have messages of
  their own. There is no skip flag; the host is chosen with
  `CHATGOOSE_VPS_HOST`.
- Checked read-only on both servers the same day. The site has no rule against
  dotfiles: an existing one is served by name from each server, as
  `application/octet-stream`. Neither nginx has `proxy_cache`,
  `open_file_cache` or `expires`, and there is no CDN in front. The forward
  the switch step installs is a whole-name `location /` with
  `proxy_buffering off`, like the ones already running for the hub and
  TaskIndex; only `/.well-known/acme-challenge/` on port 80 stays local, which
  is one reason the marker sits in the root and not under `.well-known/`. The
  marker name is new on every run, so a cache could not answer for it in any
  case; it must not end in `.xpi`, which is cached for a year.
- No way out leaves the marker unattended. It is removed before the verdict.
  Its name is kept from before the write until a removal has succeeded, and
  the EXIT trap removes whatever is still named: after Ctrl-C, after a closed
  terminal, after a failed write (ssh can fail with the file already there)
  and after a failed removal. The trap says whether the marker is gone. A
  leftover would matter during the move: `70-ext-feed.sh sync` refuses to run
  while the new server holds a file newer than its last copy. The probe never
  creates `REMOTE_DIR`: a host without it does not serve the site.
- `|| true` after the read sits outside the command substitution. With it
  inside, bash 5.3 skipped the EXIT trap when a SIGHUP reached the process
  group while curl ran (10 of 10 runs on the recorder stand; bash 3.2 ran the
  trap). Two older `$( curl … || true )` in `deploy.sh`, the persona-catalog
  status and `verify_http_200_with_retry`, have the same shape and were left
  alone: at those points the trap holds at most temporary files.
- The function is the same text in both scripts, which stay self-contained.
  `tests/release-pages.test.ts` pins that identity, the order inside the probe
  and its place before `web-ext sign` and before any upload.
- A side effect: an SSH host that cannot be reached now fails before the AMO
  request as well; it used to surface after signing.
- What the probe does not prove. The marker travels through `location /`. A
  forward that kept `/updates.json` or `*.xpi` on the old server's own disk
  would pass the probe and fail the checks after the upload; the planned
  forward hands over the whole name. And nothing removes the marker after
  `kill -9` or a power loss.
- Not measured end to end: the forward for this site is not installed yet. Its
  two halves were checked instead. The new server serves a dotfile by name to
  a request shaped like the forward's (from the old server's address, with
  `X-Forwarded-For`), and answers 403 to the same request from elsewhere; the
  forwards the old server already runs hand every path to the new one.

**E149 (2026-10-11).** «Fansly через вкладку» — an opt-in route for the
extension's own Fansly requests, for a chatter without a system-wide VPN. The
owner: «это нужно не всем, если мы всех будем пускать через прокси у нее
пропускной способности не хватит», «надо чето опциональное для таких случаев
как у вани».

- Case: Vanya (ari-1; Firefox 157; Multi-Account Containers with the page proxy
  per container; no system VPN; a home line in Russia). The follower scan and
  the recap died on 30 s timeouts with no response headers while the tab itself
  worked. Firefox gives a background request `tabId −1`; MAC's proxy handler
  answers `{}` for it, so the request leaves directly from the chatter's
  address. From a Russian network a direct connection to CloudFront
  (`apiv3.fansly.com`) freezes after ~8–17 KB downstream, and on one reused
  connection every later request gets zero bytes (from the RU server on
  2026-10-11: two 6 KB answers, then six requests with 0 bytes in 40 s). Small
  reads pass until the connection freezes; large ones never do; a retry rides
  the same frozen connection, and `fetch` cannot ask for a new one.
- Decision: with the switch on, both FanslyClient call sites (GET and POST)
  leave through a hidden extension frame inside a Fansly tab of the same
  session. Firefox attributes the frame's requests to the tab and its
  container, so MAC proxies them like the page's own; the frame holds the
  extension's host permission, so there is no CORS preflight and no Origin —
  the request shape of the background. Measured first on a Firefox 157 stand
  that copies MAC's proxy decision.
- Rejected: a content-script fetch (page-like CORS with a preflight per
  request, and the page's own JS sees every such URL in its resource timing;
  the frame's requests it does not see); the `proxy` permission with a proxy
  line typed into the extension (passwords in the extension, a per-model
  mapping by hand, pages mixable on one address); follower and history reads
  from the hub (the extension is the live reader, and a frozen connection
  kills the small reads too); a retry after a timeout (it cannot leave the
  frozen connection).
- Shape: `src/fansly-relay/` — the frame, web-accessible to fansly.com only,
  mounted by the bootstrap in a closed shadow root only while
  `fanslyViaTab === true` and removed when it goes off; it reconnects with a
  0.1 → 5 s backoff. `src/shared/fansly-relay-protocol.ts` — GET/POST to
  `https://apiv3.fansly.com/api/v1/` only; status, three headers and the body
  back. `src/background/fansly-transport.ts` — `FanslyRelayHub` takes only our
  page framed in a tab, the newest frame of a tab wins; a read waits up to 5 s
  for a loading tab, a write never waits; a lost frame fails its requests like
  a dropped connection, so a dispatched write stays unconfirmed.
  `createFanslyTransport` reads the switch per request and never falls back to
  the direct route. Pacing, retries and the one-attempt write rule are
  untouched: the transport only decides where a ready request leaves from.
- The route settles before the identity check, and dispatch posts before it
  yields: nothing asynchronous sits between the last check and the request,
  with the switch on or off. The frame answers like `fetch`: status and
  headers first, then the body, so a 429, 401 or 5xx counts even when its body
  breaks. (Both from the review: an earlier draft awaited the setting after
  the check and sent the status only with the full body.) A second frame of a
  tab never evicts the first, which would make them evict each other forever.
  A body nobody reads (a 401, 429 or retry acted on by status) is released by
  a cancel or after the request timeout, so a stalled one cannot hold the
  frame's request; a Pause that lands while a chat opening's route settles
  still stops it.
- Session capture skips requests whose document is the extension's own: the
  frame replays the captured session and must not overwrite the page's fresh
  template.
- Errors: `fansly_tab_unavailable` (CG-FAN-04) when no tab of the session has
  a frame; the follower fuses count it as an outage. A follower greeting asks
  for the route before it reserves anything in the hub, so a missing frame is a
  plain error, never an unconfirmed send. The network-error card and the
  follower timeout text point to the switch.
- Follower window: a failed scan with no rows says «Список не загружен» in the
  header and in the list instead of «Новых фоловеров нет».
- Settings v20: `fanslyViaTab`, off for every install; only an explicit `true`
  turns it on. No new permission, so the update prompts nothing.
- Verified: `pnpm check`, and the built extension on a Firefox 157 stand (MAC's
  proxy decision, a fake Fansly behind a container proxy, and a «chatter line»
  that freezes every connection after 12 KB). Off: the scan dies in 32 s with
  the new texts. On, same tab without a reload: the 41 KB follower page passes
  through the container proxy in 1 s, without Origin. After a reload the frame
  mounts at page start and nothing uses the chatter's line. Off again: the
  frame leaves the page. The page sees no iframe and no `moz-extension`
  address. Not verified: a real Fansly session, Vanya's line.
- Version 2.7.2 (patch, E120); published only on the owner's word.

**E150 (2026-10-11).** The 2.7.2 release stopped at the `scripts/deploy.sh`
contract gate before signing: production Core runs `2260ef739aa0` (Core #552;
the same image moved to agency-de on 2026-10-11), and `/api/v1/health`
answers `b9d4dd07b4d56e64a2912f86ff3730f05669b7a0aceb86ec98a2873ed42e9541`,
while the vendored SDK came from `e033e3ec` (`b95b765c…`). The health answer
also lists `b95b765c…` under `compatibleClientSdks`, so 2.7.1 in the field
keeps working, but the gate compares `contractHash` exactly; whether it should
accept the compatibility list is the owner's call, not this release's.

The SDK is regenerated by Core's `scripts/vendor-sdk.mjs` from a clean detached
worktree at `2260ef739aa0d64d03313b624318d52a45460739`; the generated hash
equals production exactly and `sourceCommit` is clean. SDK 0.3.0 → 0.4.0.
`pnpm check` passes with no source change. No vendored file is edited by hand
and no release check is bypassed. No version bump: it ships inside 2.7.2,
which was not yet released.

**E151 (2026-10-11).** The public pages (`install.html`, `start.html`,
`guide.html`, `whats-new-2.html`, `changelog.html`) are redrawn in the
agency's identity, on the owner's request. The identity lives in
`~/code/1-platform/agency-site` (`brand/out`, `src/styles/tokens.css`, its
`AGENTS.md` lists what the pages must not use). What changed here:

- Look: the ChatGoose logo with the gosling as inline SVG, pond blue for the
  first screen and the install block, yellow for the 2.0 strip and highlight
  panels, ink buttons, flat mocks with an ink outline, hairline tables. The
  terracotta palette, italic accent lines in headings, uppercase mono labels,
  numbered tabs, arrows in links, card shadows and stat tiles are gone.
- Type: Literata 800 for headings, Golos Text for the rest, both from the
  Google Fonts link the pages already used. Monospace only for keys and code.
- Words: headings and leads that read as slogans now say what the tool does
  («Держи нить. Веди диалог.» is «Помощник чаттера в Fansly»). Reference text,
  release notes and every pinned string are untouched.
- Contract: pages are still single self-contained files and the deploy
  uploads the same six files. `mascot.png` is a 512 px render of the ChatGoose
  badge. Version slots, ids and the pinned 2.0 link are unchanged; `pnpm
  check` passes without touching a test.
- Not changed: the extension itself, its icons, its texts.

**E152 (2026-10-11).** The owner asked for a way to see when a fan registered:
a small button next to the fan in the chat header.

- Source of the date: Fansly ids are snowflakes, so `id >> 22` plus Fansly's
  epoch (`1561494360000`) is the creation time. The owner's check on four
  accounts matched Fansly's own `createdAt` to the second. The decoder moved
  to `src/shared/fansly-id-time.ts`; the follower date (`followedAtFromId`)
  now uses the same one. Nothing is asked about the fan, and the hub is not
  read: its archive is pull-cadenced and a fresh fan, the case a chatter asks
  about, may not be in it yet.
- Cost: the fan's account id. Fansly keeps it in Angular state, not in the
  DOM. The background answers from the tab context when a generation already
  resolved the fan for this chat, and otherwise makes the `GET
  /group/<groupId>` every generation starts with. That is why the date
  appears on a click and not when a chat opens: an automatic read would add a
  Fansly request to every opened chat. The read is one attempt (`retry:
  'none'`, where a generation retries a 429 or a 5xx three times) and is not
  sent at all while the follower pacer reports a rate-limit cooldown for the
  account: the click answers `rate_limited` with the time to wait. The
  creator's id comes from the session's resolved identity; `/account/me` is
  asked only when the tab's identity is not resolved yet. The answer is kept
  per chat until the page reloads, so returning to a chat shows it without a
  request.
- Never a guess on the read: the fan is the other member of a group of
  exactly two that contains the authenticated creator; anything else answers
  CG-APP-02. The tab-context answer trusts the generation that put the fan
  there (the first member who is not the creator, group size unchecked); it
  is reachable only from the header row, which Fansly's template renders for
  exactly one partner. The group read is an optional one for generations, so
  its failures arrive as `unknown_error`; the handler names them
  (`network_error` for no HTTP answer, `fansly_server_error` otherwise). The
  group id is validated as a Fansly id before it reaches the URL path.
- Place: Fansly's own row under the name, «Last seen … | Gallery |
  Регистрация», in that row's size and colour; the hover is terracotta. After
  the click the control reads «28.04.2026 · 5 месяцев назад» (the chatter's
  time zone, whole calendar units), the exact time is in the tooltip. Not the
  icon row next to the name: that row is inside the profile link.
- Lifecycle (`src/content/fan-registration.ts`): Fansly reuses the header
  across chats and destroys it for the Gallery view. Every sync re-reads the
  open chat from the URL and re-homes the element; syncs come from the route
  change, from mutations of the conversation subtree and from a 2 s
  keep-alive. A previous fan's date cannot stay under a new name, and a click
  belongs to the chat that is open even inside the 500 ms route poll. A
  failure is a toast only while that chat is still open. A real account
  switch in the tab drops every answer, kept or in flight: two agency models
  share a chat id and see different partners in it. A control left in a
  reused row by the previous instance of the extension (an update) is removed
  when the new one takes the row.
- Selectors come from Fansly's production bundle `main.2e6b96097a4bb73b.js`
  (2026-10-11): `app-messages-conversation-route .message-content-header-contact
  .content-header-sub-row`, a row Fansly renders only for a one-to-one chat.
  If Fansly renames them the control does not appear; nothing else depends on
  it.
- Verified: `pnpm check`; the rendering on a stand built from Fansly's own
  header markup and stylesheets, dark and light. Not verified: a live Fansly
  session.
- Version 2.8.0: the owner named the number and ordered the release
  («2.8 выпускай», 2026-10-11).

**E154 (2026-10-11).** The public pages lead to the common home of the
ChatGoose clients. Since 2026-10-11 chatters have one site,
`https://chatgoose.gosling-agency.ru`: `/` is a home page with the three
clients and the account, `/fansly/` is these pages, `/chatspace/` is the
ChatSpace extension's site, `/desktop/` is the desktop download page. The site
is `~/code/1-platform/agency-site`'s (its README, «Addresses», and
`deploy/server-nginx.sh`): its nginx serves the files this repository
publishes into `/var/www/ext`, and the page addresses on
`ext.gosling-agency.ru` redirect to it. The pages had no link to that home,
and one link still named a neighbour by its old address.

- The logo in the header of `install.html`, `start.html`, `guide.html`,
  `whats-new-2.html` and `changelog.html` links to `../` and is labelled
  `aria-label="ChatGoose — все клиенты"`. It was `#main` on the landing and
  `index.html` on the other four; three of the five had no label on the link.
- «Скачать приложение» on `start.html` links to `../desktop/`. It was
  `https://ext.gosling-agency.ru/desktop/`.
- Relative on purpose: a page names no host for a neighbour, so the links
  hold under any name that serves this folder one level below the home.
  Opened from the root of a name, the way `ext.` served the pages until that
  day, `../` is that root and `../desktop/` is its `/desktop/`.
- The install link stays `https://ext.gosling-agency.ru/chatgoose-latest.xpi`:
  `/fansly/` serves only the pages and `mascot.png`; the XPI and
  `updates.json` answer on `ext.` alone.
- Not changed: the footer logo (still the landing), «Установить» in the
  header (the landing's install block), the sentence on `start.html` that
  spells `ext.gosling-agency.ru/desktop/` (the address redirects to the
  page), the addresses the extension opens (`src/shared/constants.ts`; they
  redirect as well), the deploy scripts and their `BASE_URL` (they read back
  through `ext.` and follow redirects). README «The site on the server»
  still holds the copy of the `ext.` site read before the redirect was
  added; the server was not read for this change.
- Verified: `pnpm check`, no test touched. The pages of the three clients
  served from one local folder laid out like the site (`/` a stub,
  `/fansly/`, `/chatspace/`, `/desktop/`): every header logo resolves to `/`
  and a click lands there, «Скачать приложение» lands on `/desktop/`. Read
  from the live site the same day: `/`, `/fansly/`, `/chatspace/` and
  `/desktop/` answer 200, `/fansly/start.html` is `start.html` of `main`
  before this change byte for byte, the old page addresses answer 302 to the
  new ones, `/fansly/chatgoose-latest.xpi` answers 404. Not verified: the
  links on the live pages; they are there once the pages are published.
- No release and no version change. The pages go out with
  `scripts/deploy-pages.sh` or with the next release, on the owner's word.
- The number: E153 is the icon change, PR #147, open when this was written.

**E155 (2026-10-12).** «Новые» knows when Fansly will not let the model DM a
fan. RS RS (@solorzanohermoso, fan `870152607614640128`) followed @itsaribae on
2026-10-11. He is a creator with a paid DM: Fansly's chat shows «Price Per
Message $1.70» and «Select $1.70 p/m» where its message box would be. The
window showed him as «Не писали»; at 20:34 UTC a chatter (Hub user 27) sent,
Fansly refused the `POST /message`, and by the custody rules that refusal is an
unconfirmed send: the Hub attempt `1161a180…` stays `dispatching`, which never
expires. From then on every chatter's window showed him «Не писали» and every
send ended in the Hub's refusal, worded «Другой чаттер уже отправляет или
отправил приветствие».

- How Fansly decides (its app bundle, `main.2e6b96097a4bb73b.js`, read
  2026-10-12): the chat object (`GET /group/<id>`, and the inbox listing's
  `aggregationData.groups[]`) carries `dmPermissionFlags`, the partner's rule
  sets, any one of which lets a sender in, and `accountDmPermissionFlags`,
  what this account already has toward the partner. Nothing else feeds the
  composer: `GET /groups/dmpermissionflags` is read only by the creator's own
  DM settings page. `verifyNew(rules,
  account, tip)` returns the unmet sets; while it returns any, the composer
  shows the permission rows instead of the message box. Bits: 1 price per
  message, 2 the sender follows the partner, 4 subscribes to them, 8 tips, 16
  the partner follows the sender, 32 media purchases, 64 the partner
  subscribes, 128 the partner's list. The price is in mills (Fansly's
  `balanceToDollars` is `floor(w/10)/100`), like the Hub's money. Every
  ordinary fan chat in the Hub's 2026-08 captures has the sets «16 met» and
  «64 unmet», which is open.
- `src/shared/fansly-dm-permissions.ts` ports `verifyNew` with no tip:
  `unmetDmRequirements` and `describeDmRequirements` («Платная личка: $1.70 за
  сообщение.», otherwise the conditions). The tier and list names Fansly reads
  there only label its screen and are not ported. A null price passes, as in
  Fansly (`0 >= null`); a missing price (unmet there too) or an unreadable
  rule (Fansly throws) is an unmet price of unknown size. Dollars come
  from `formatExactMills` in `src/shared/spenders.ts`, now exported.
- The row check reads the rules from `GET /group`, or at scan time from a
  listing or a `POST /group` answer that verified the pair; rules absent from
  an answer leave the chat open, as in Fansly, and every send and draft reads
  `GET /group` first. A
  personal DM found in the history still makes the row «Уже писали»;
  otherwise unmet rules make it the new status `closed` («Нельзя написать»),
  ahead of an unconfirmed local send journal. `closed` is not workable:
  generation, verification and sending stop before the AI, the Hub
  reservation or any Fansly write, and the send says why. The debug trace
  logs `dm.permissions` (rule bits, met bits, unmet bits, price) for the first
  live read.
- Exclusion, on the owner's choices (2026-10-12): a `closed` row stays in «К
  обработке» until the chatter presses «Исключить из очереди» (not
  automatic: the rules were not yet read on a live session); only a `closed`
  row has the button; the choice is kept in this browser
  (`chatgoose:followers:v1:excluded:<creator>:<fan>`), not in the Hub. An
  excluded row stays in «Все» as «Исключён · нельзя написать» with «Вернуть в
  очередь». A check that read the rules and found the DMs open drops the
  record; an answer without the rules keeps it. Nothing is
  read from or sent to Fansly or the Hub for it.
- A refused Hub reservation now names the state the Hub returned: `reserved`
  «другой чаттер сейчас отправляет», `sent` «уже отправили приветствие»,
  `dispatching` «прошлая отправка не подтверждена, повтор заблокирован».
- Not changed: the custody rules (a Fansly refusal of `POST /message` is
  still an unconfirmed send) and the Hub. On 2026-10-12 the Hub held 17
  `dispatching` attempts (16 on ari-1, 1 on lora-1); for 14 of them the
  archive has no chat with the fan at all, among them Mariagarrett222 and
  Richard_Hardenlong (the restricted DM of the 2026-09-20 audit). They were
  read, not touched: with this check a closed fan never reaches the
  reservation, and clearing them is a Hub change for the owner to order.
- One review pass (Opus); its findings fixed: a fan pinned on screen left
  the queue on exclusion, the empty queue no longer says everyone was
  written to when some were excluded, the null price, the `POST /group`
  rules, and the record kept on an answer without rules.
- Verified: `pnpm check`; the window on a local stand built from the real
  `FollowersWindow` with a stubbed background (a paid DM, a closed DM, an
  exclusion and its return, the narrow layout). Not verified: a live Fansly
  session; RS RS's chat object was not read, the rules are known from the
  bundle and the captures.
- Version 2.8.1.

**E156 (2026-10-12).** The 2.8.1 release preflight found the vendored SDK
behind production: Core runs `6ee3d627e204` (core #567, container started
2026-10-11 22:28 UTC) and `/api/v1/health` answers
`030124539ce7c649519ca0acafe8c6c131e3620025e7b858650857baa7119bbc`, while the
vendored SDK came from `2260ef73` (`b9d4dd07…`, E150). The contract change
between them is core #563, one new operation `opsLive`
(`GET /api/v1/ops/live`, the server monitor's read), which the extension does
not call. `compatibleClientSdks` now lists `03012453…` and `b95b765c…`; it
does not list `b9d4dd07…`, which 2.8.0 in the field carries. The list only
informs release gates; whether that matters to 2.8.0 was not examined, as
2.8.1 replaces it.

The SDK is regenerated by Core's `scripts/vendor-sdk.mjs` from a clean
detached worktree at `6ee3d627e204efd791424b5ae5802b9e4a48b82c`; the
generated hash equals production exactly. `pnpm check` passes with no source
change. No vendored file is edited by hand and no release check is bypassed.
No version bump: it ships inside 2.8.1 (E155).

**E157 (2026-10-12).** The owner asked for Fansly's native notes to be
reachable: Fansly hides them two clicks deep (the sticky icon beside the
name, then «Edit User Notes» in a dropdown) in a small modal. He picked a
convenient button, a hotkey, a panel, three views the chatters choose
themselves, and a questionnaire template (screenshots and a mockup approved
in the session, 2026-10-12).

- Source of truth: Fansly's production bundle `main.2e6b96097a4bb73b.js`,
  component `app-notes-edit-modal` and its `NotesApiService`. Notes are the
  fan's account notes as the creator's session reads them (`GET
  /account?ids=` → `notes[]`). A regular note is contentType 12000
  (`1000 × AccountService`), any number, title + text; the custom name is the
  one 12002 note, title «Custom Username». Writes are the modal's own calls:
  `POST /api/v1/notes` `{contentType, contentId, title, note}`,
  `/notes/edit` `{id, contentType, contentId, title, note}`, `/notes/delete`
  with the note. An empty custom name deletes the 12002 note (Fansly's
  «trash-undo»). The same notes show in Fansly's modal and any tool that
  reads them; nothing ChatGoose-specific is stored. The agency does not use
  FBuddy; its notes, if any, are ordinary 12000 notes here.
- Cost: reading a chat's notes is the group read (once per chat: the
  background remembers `creator:group → fan`, a chat's members never change;
  not the tab's generation context, which takes the first non-creator member
  unchecked — writes follow this read, so the fan is the other member of a
  chat of exactly two) plus one `/account?ids=`. Both ride the follower lane
  (`followerSession`): paced, and a 429 starts the cooldown every other read
  of the account respects. One attempt each, nothing during that cooldown,
  the answer kept for the tab's lifetime;
  «Обновить» rereads, a failed read waits for the chatter. «Справа по
  кнопке» (the default) and «Окно по центру» read nothing until the panel
  opens. «Всегда справа» reads each opened chat — the owner accepted that
  cost for chatters who pick it — but only after the chat stayed open
  0.7 s, so clicking through the inbox costs nothing. This is the one place
  that reads per opened chat; E152 kept the registration date on a click for
  exactly that reason, and it stays there.
- Writes go out only on «Создать» / «Сохранить», «Удалить» (after an in-card
  confirmation) or Enter / leaving the custom-name field when its text
  changed — never per keystroke (Fansly's modal saves the name every 300 ms of
  typing). One attempt (`postOnce`), never retried, on the same follower lane
  as the reads: a 429 on a write starts the shared cooldown too, and right
  before the dispatch the lane re-checks that the tab still works as the
  session the request came under (a tab that became another account while the
  write waited for its route answers `chat_changed`, nothing is sent). A
  failure keeps the draft and says a reread shows whether it landed. A failed create (a note or the
  custom name) is not sent again until «Обновить» has reread the notes — a
  second create could duplicate one that landed; an edit or a delete may be
  repeated. No reread starts while a write is in flight (its answer would land
  on a snapshot that is gone). Texts are never cut: the bounds (title 1 000,
  text 50 000, name 1 000 code points) sit far above real notes, and a longer
  text is refused with a message — a cut would drop the tail of a note
  written in Fansly's modal, which has no limit. A draft of a note deleted
  elsewhere becomes a new note after a reread. Delete takes regular notes
  only; the custom name goes through its own request. A write names the creator the
  notes were read under; a tab that became another account answers
  `chat_changed`. The confirmation of a create/edit is the note Fansly
  returns, checked to be the same fan, type and (edit) id; a delete has only
  `success`. Fansly's own modal and header keep their Angular cache: they show
  a ChatGoose edit after a reload.
- Views (`fanNotesView`, storage v21, default `drawer`): «Всегда справа»
  docks in the column Fansly's `--maxContentWidth: 70em` leaves right of the
  chat when it is ≥ 280 px, otherwise it opens over the chat on the button;
  «Справа по кнопке» uses the same column or lies over the chat's right edge
  under the header and above the composer; «Окно по центру» is a modal with a
  scrim that closes with its chat. The choice is made in the panel and every
  tab follows it; the options page, which writes its whole settings snapshot
  back, adopts the tab's choice from the storage change itself and re-applies
  the latest after each of its own writes. Residual: a save the options page
  dispatches in the milliseconds between a tab's write and the delivery of its
  change event still carries the old view — the same synchronous-write window
  the page documents for the schema barrier. The panel root sits at `2147483644`, under every overlay
  (Coach dims it), the launcher moved to `2147483643`. Esc closes it unless
  another ChatGoose surface (or «Новые») is open, and never while a field of
  the panel or of Fansly (outside the modal) has the focus; Esc in the editor
  leaves the field and keeps the draft. The centred window holds the focus:
  Tab cycles inside it and focus landing behind the scrim comes back. Drafts are kept per fan, so a chat
  switch mid-edit loses nothing. The button and the hotkey re-read the open
  chat from the URL at the press. A panel left by the previous instance of the
  extension is removed when the new one starts.
- Hotkey: hub `packages/chatgoose-hotkeys` scheme 2 adds `notes` on KeyK,
  panel level, and a hotkey client `fansly`: this extension runs every
  `extension` row plus its own, and its engine is created as `fansly`. Notes
  is `fansly` only, reserved in chat-extension (whose action catalog is
  pinned to the `extension` rows) and the desktop. N, the mnemonic, is
  forbidden (⌘⇧N reopens a closed window); Firefox's Web Console sits on
  Ctrl+Shift+K / Cmd+Option+K, so ⌘⇧K and Ctrl+Alt+K are free. The other two
  clients re-vendor the same manifest.
- Header: «Регистрация» and «Заметки» share `src/content/header-row-slot.ts`
  (the E152 placement logic, moved), each keeping its order in the row.
- Boundary: notes are chatter-eyes-only; nothing reaches the kernel or a
  prompt.
- Reviewed independently by Opus 5.5 and by gpt-6-astra (Codex) on the first
  commit; every finding was checked against the code and fixed here (silent
  truncation of a long note, unpaced reads and writes, a reread racing a
  write, a duplicate create after an ambiguous failure, an orphaned edit
  draft, the polled route at the press, the group-chat fan from the tab
  context, the options page reverting the view, a dead panel after an update,
  Esc dropping a draft, the modal leaking focus).
- Verified: `pnpm check`; the real panel, trigger and stylesheet on a stand
  built from Fansly's header markup, three views, dark and light. Not
  verified: a live Fansly session — the endpoints and bodies come from the
  bundle, not from captured traffic.

**E158 (2026-10-12).** Release 2.9.0 ships E157, the fan-notes panel. The
owner ordered it («да выпускай канеш и релиз») without naming a number; it is
2.9.0 because it is a feature, as 2.8.0 (E152) was, and 2.8.1 was the last
release. Preflight: the vendored SDK contract hash equals production
(`03012453…`), the served feed was 2.8.1, `announce-release.mjs --check`
passes. Settings v21 migrate on update; the hotkey scheme is 2 in all three
clients (hub `0a96105d`, sha256 `7850406c…`). Not verified before the
release: a live Fansly session — the note endpoints and bodies come from the
bundle, not from captured traffic; the first thing to compare if a chatter
reports a note that does not save.

**E159 (2026-10-12).** The owner asked, on the 2.9.0 panel, for a button
that fills the questionnaire «with the neural net from the whole chat», on
Sonnet by default. His rulings: a field the chatter filled is not touched,
but a different answer may be offered «что на что»; only what the fan said,
nothing invented; «Медиа» is what he bought and what content he likes;
«Характеристика» is what he likes and what he pays for.

- Kernel: a new AI feature `fan-notes-fill` (Core PR, default model
  `anthropic:claude-sonnet-5-5`, overridable like the others). The request
  carries the questionnaire's labels (`noteFields`, required there, refused
  elsewhere) and the usual Fansly `clientContext`; the answer is one
  `Label: value` line per label, an empty value where the chat has nothing.
  The template, the rules above and the transcript framing live in Core.
- Extension: the feature is an ordinary operation of the tab (one at a time,
  as every AI action) that reads the chat the way a full Recap does — the
  deep window, spending and subscription — but without the 30-message
  minimum: a fan's name in his fifth message is worth a field. Canonical refs
  (`conversationRef` = group, `fanRef` = fan), `transcriptCoverage` sent. Its
  port messages are routed to the notes panel (`ownsOperation`), never to the
  overlay or the inline surface; `surfaceKind: 'panel-only'`.
- Only the labels travel, never the chatter's values (the model answers from
  the chat alone, and nothing the chatter typed reaches a prompt). The panel
  merges: an empty field takes the answer; a filled one keeps the chatter's
  value and, when the answer differs, shows «было → станет» with «Заменить»
  / «Заменить все» / «Скрыть». A suggestion applies only while the field
  still holds the value it was made for.
- The editor is locked while the fill runs (status «Читаю переписку… N/M»,
  then «Заполняю анкету…», «Остановить»); a stopped fill drops its late
  answer. Nothing goes to Fansly until «Создать»/«Сохранить» — AI never
  writes a note by itself.
- A note is a questionnaire when at least two lines read `Label: value`
  (labels 1–60 characters with a letter, at most 30); the button shows only
  then.
- The bootstrap bundle ceiling rose 28 → 29 KB: the feature-policy table it
  carries gained the row; no UI entered the bootstrap.
- Not verified: a live Fansly session and the kernel feature on production
  data — checked on a stand with the real panel and a synthetic answer.

**E160 (2026-10-12).** Release 2.10.0 ships E159. The owner approved the
whole chain («4. ок делай»: Core deploy, re-vendor, release) and declined
model reviews for it («ревью моделями не надо»). Order: Core #572 merged
(`a3449f77`) and deployed dist-only to agency-de; production health then
answered the new contract `a6f77fbb…` and still listed `030124…` among
`compatibleClientSdks` (the released 2.8.1/2.9.0 SDK is registered in Core's
client-SDK registry as bundle `64a972fd6222`, so the retention gate keeps it
from now on). The SDK was re-vendored from that deployed commit, so the
release gate (`contractHash` == production) holds. Version 2.10.0: a feature,
by the rule 2.9.0 followed. Not verified before the release: the feature on a
live Fansly chat and production data.

**E161 (2026-10-12).** The 2.10.0 release stopped half-way: the Claude
session running `scripts/deploy.sh` ended while web-ext waited for AMO's
approval. AMO then signed 2.10.0 (unlisted, file sha256 `98a9ef69…`), but
nothing was uploaded: the feed stayed at 2.9.0, no tag, no announce.
`deploy.sh` cannot resume from a signed file (web-ext submits a new version
every time, and AMO refuses a version it already has), and completing the
upload by hand would skip the script's checks. The same build therefore ships
as 2.10.1 through the ordinary path; the CHANGELOG section, the changelog page
and the announce name 2.10.1, and 2.10.0 is left unused in AMO. Lesson for the
procedure: run `deploy.sh` where it outlives the session (a detached shell),
since the AMO wait is the longest step.

**E162 (2026-10-13).** Владелец попросил, чтобы Claude сам использовал Chrome DevTools MCP для
Fansly вместо Claude in Chrome и знал, где бандл/исследования обоих расширений. Общее решение —
[chat-extension X38](https://github.com/goslingmanagment/chat-extension/blob/main/docs/decisions.md#x38-fansly-chrome-devtools-mcp-и-общий-справочник-разработки-2026-10-13).
`CLAUDE.md` закрепляет выбор `chrome-devtools`, чтение уже открытой вкладки и границу между
осмотром и действиями с живой сессией. [docs/fansly-development.md](fansly-development.md) даёт
карту исходников этого клиента и ссылку на общий справочник в `chat-extension` (бандл, чат,
API/WS, FBuddy, хаб и материалы `~/code/8-docs`). Новая сессия Claude автоматически прочитала
инструкцию и выбрала DevTools; доступ к Fansly ранее проверен через этот MCP. Проверка сайта
в Chrome не заменяет проверку Firefox MV3. Код расширения, релиз и настройки аккаунтов не менялись.

**E163 (2026-10-13).** Владелец уточнил, что инструкции должны работать через `AGENTS.md`.
Файл теперь содержит полный прежний `CLAUDE.md` (изменён только заголовок), включая правило
Chrome DevTools MCP и справочник из E162; прежний `AGENTS.md` был лишь указателем.
`CLAUDE.md` удалён как заменённый документ: его единственный преемник —
[AGENTS.md](../AGENTS.md). Это tombstone по правилу сохранения документации выше.
Актуальные ссылки в README, справочнике Fansly, баннере исторической спецификации и двух
комментариях к коду/тестам обновлены.
Старые записи журнала и датированные исследования сохраняют имя `CLAUDE.md` как факт своего
времени; прежний файл доступен в истории Git.

На машине владельца Claude Code 2.1.296 настроен на `claude-md-or-agents-md`: наличие
проектного `CLAUDE.md` давало ему приоритет, без него нативно загружается `AGENTS.md`.
[Правило загрузки Claude Code](https://code.claude.com/docs/en/memory#agentsmd) проверено
на дату записи. Настройки пользователя не менялись; отдельный файл-обёртка не нужен.
Поведение, проверки и релизный процесс расширения не менялись.

**E164 (2026-10-13).** The owner approved release A of the «make the AI
notes really useful» brainstorm (chat, 2026-10-13): merge instead of
overwrite, and a quote per fact, in one release because they change the same
prompt and the same panel. Spec: [docs/specs/2026-10-13-notes-fill-merge.md](specs/2026-10-13-notes-fill-merge.md)
(owner rulings in its section 2). This entry is the extension half; Core
records its half in the `fan-notes-fill` note of `prompt-manifest.json` and
`docs/ai-gateway-contract.md`.

- Owner ruling 1, a narrowing of E157 («never in a prompt») and E159 («only
  the labels travel»): the questionnaire's values may travel to Core, for
  this fill now and for Reply/Coach later. The custom name (12002) and every
  other note still never travel. Rulings 5 and 6 as well: new lines go
  straight into the draft (only rewrites of filled fields stay suggestions),
  and the AI never touches the custom name.
- Request: `noteFields` = the note's labels in note order, then the template
  labels it lacks (compared as labels are: trimmed, NFC, case-insensitive), in
  template order; `noteValues` index-aligned, `""` for empty and appended
  fields. At most 30: missing template labels drop from the end of the
  template first, counting every field of the note. A value over 2 000 UTF-16
  code units is left out, label and all, and the merge never touches it. A new
  client sends `noteValues` on every fill (merge mode, also for an all-empty
  questionnaire); the content→background protocol now requires it with the
  labels. Template: Имя, Локация, Возраст, Работа, График, Хобби, Планы и
  даты, Фетиши, Характеристика, Медиа, Другое.
- Transcript: for the fill in merge mode only, a day line `--- YYYY-MM-DD ---`
  before each day's first message, in the browser's clock (the `[HH:MM]`
  one). The oldest-first 300k budget pays a day line together with its first
  kept message, so it counts them and never leaves one without a message;
  `clientContext.messageCount` still counts messages. Every other feature's
  transcript keeps its bytes (one budget routine with day lines off; tests pin
  the legacy output and a fast-reply request).
- Answer: field lines; `> «…»` quote lines attach to the field or `+` line
  above them (three at most; one with nothing above it is ignored; guillemets
  or straight/typographic quotes stripped); `+ Label: value` proposed fields,
  five at most with a value. Core escapes what it shows the model, so `&lt;`,
  `&gt;`, `&amp;` are decoded in one pass in every value, label and quote
  before anything is compared, written, located or shown. `Label:` and
  `Label: ` both read as empty.
- Merge: an empty field is filled in place; a filled one with the same value
  (decoded, whitespace- and case-insensitive) gives nothing; a different one
  gives «было → станет» with its quotes; a template label the note lacked and
  a usable proposed field become new lines right after the last field line
  (free text below stays below), template lines first. A proposed field whose
  label is invalid, repeats an asked or present label, or would take the
  questionnaire past 30 goes into «Другое» as `Label: value` with «; » (a
  `+ Другое` by its value alone): appended to the line, to both sides of a
  pending «Другое» rewrite, or a «Другое» line created at the end of the
  template lines; if creating it needs the 30th place, the last proposed line
  gives its place up. With no «Другое» and no room the fact stays where it
  was (its source rewrite is still only a suggestion). «В Другое» on a
  proposed field does the same by hand; without «Другое» the line is created
  before the other proposed lines still in the draft. `applyFieldSuggestion`
  and «Заменить все» keep their rule (a rewrite applies only to the value it
  was made for).
- Quotes: the background parses the answer with the panel's own parser and
  dates each quote by the newest Fan: message of the window it sent (the kept
  suffix of the normalized messages) whose text contains it after
  normalization (NFC, case fold, whitespace collapsed, typographic quotes,
  apostrophes, dashes and the ellipsis as ASCII; an ellipsis the model put at
  an end is ignored). The result rides the fill's own `operation:complete` as
  `noteQuotes: [{ quote, sentAt | null }]` (sentAt in epoch ms), a typed
  projection like Coach's `turnContext`: no new port message and no state kept
  between operations, the transcript never leaves the background. The panel
  validates it at the consumer; an invalid list degrades to undated quotes.
- Panel: notice «Заполнено полей: N. Добавлены строки: … Предложений: K.
  Проверьте и сохраните.» (empty parts left out; «Дополнено поле: Другое»
  when a filled «Другое» got a moved fact without a rewrite, a case the spec
  does not name); a row «Гусь завёл поле «…»» with «В Другое» per proposed
  field, gone once clicked or once its line leaves the draft; «Откуда Гусь это
  взял (N)», collapsed, N = quote lines, «Label — 14.09.2026 · quote» for
  fields filled in place, new lines and moved facts; quotes under each
  rewrite; «не нашлось в переписке · …» in the error colour for a quote not
  found; title «Гусь предлагает переписать:»; the button's new tooltip.
  Quotes live in the draft's panel state until the next fill or until the
  editor closes; they are never written into the note.
- SDK: vendored for development from Core `2ac5d541` («feat(ai):
  fan-notes-fill accepts noteValues (contract)», contract `1d3e8c62…`); a test
  pins the extension's bounds to the SDK's `AI_NOTE_*` and checks a built body
  against the SDK's body schema. The release re-vendors from the deployed Core
  commit (E160 order: Core first, then the extension).
- Verified: `pnpm check`; the real controller, panel and stylesheet in a
  headless-Chromium harness with fixture data (after the fill, the sources
  expanded, after «В Другое»; dark and light). Not verified: a live Fansly
  session and the prompt on production data; the owner or a chatter checks a
  real filled questionnaire before the release is called done.
- Review follow-ups (same day, Opus review of both halves): Core answers an
  unchanged field `Label: =` instead of echoing it, so the answer no longer
  grows with the questionnaire (a 30 × 2 000 echo could hit `max_tokens`) and
  an unchanged English value cannot come back translated; `=` reads as
  nothing for that field, its quotes are dropped, and `+ Label: =` is no
  proposed field. A label's leading list marker («- Имя») no longer counts,
  so a questionnaire written as a list matches the template instead of
  getting duplicate lines. An asked label that starts with «+» is that
  field, not a proposed one. A proposed field with no place at all is named
  in the notice («Не хватило места в анкете: …»). «Заменить» finds its field
  past 30 `Label: value` lines. The editor grows with its text up to half
  the window (only grows, so the chatter's typing and drag never jump it),
  and «В Другое» restates the notice («Другое» created, first filled or
  grown).

**E165 (2026-10-13).** Release 2.11.0 ships E164. The owner ordered the whole
chain («мержи и выкатывай все»). Core #593 was rebased twice over contract
changes other sessions merged meanwhile (#592, #594) and merged as
`bc0f6dbc`. Production still ran `a3449f77` (the E160 deploy), so deploying
`main` also shipped 23 commits of other work (Project Browser PRs 2–12, R20
HF) with six migrations (0270–0275); asked, the owner chose the whole `main`
over a side branch with this change alone. Those PRs state they are dormant
at merge (flags off, no page selects the new transport), and the deploy
script lists the six migrations as rollback-compatible. The dist-only deploy
to agency-de verified in 157 s: health `contractHash` `663d132f…`,
`compatibleClientSdks` lists `a6f77fbb…` (2.10.1, registered in Core by #593
after E159 left it out), `030124…` and `b95b765c…`; the app containers
healthy on `bc0f6dbc`. The SDK was re-vendored from that commit, so the
release gate (`contractHash` == production) holds. Version 2.11.0: a feature,
by the rule 2.9.0 followed. `guide.html`: the notes card no longer says «Без
AI» (it has had the AI fill since 2.10). Not verified before the release:
the merge-mode prompt on a real model and the feature on a live Fansly chat
(a production smoke run would write generation and spend rows nobody asked
for); the first filled questionnaire in the released extension is the check.

**E166 (2026-10-13).** The owner looked at 2.11.0 on a live fan and sent
screenshots with three complaints: the panel's elements are heavy and untidy,
some of the AI's notes are not useful, and the result is a wall of text. He
allowed any size of rework. A «Было/Стало» mockup (the real 2.11.0 panel and
a prototype in one frame, on a synthetic fan) was approved: edit by fields,
the custom name as in the mockup, «Характеристика» is the kind of fan and
not his purchases, one release for both halves. This entry is the extension
half: how the note is shown and typed.

The mockup also proposed that the AI write less (short facts, an importance
bar, at most three new facts a field). Shown the old and the new prompt's
answer for the same real fan side by side, the owner turned that down («не
надо вывод короче, лучше вывод как был»): the fuller answer is the useful
one, and reading it is this panel's job. Core's half (hub #601) is therefore
only where a fact goes: «Характеристика» is who the fan is, purchases live
in «Медиа» alone, one fact in one field. Do not propose shortening the fill
again without a new reason.

- A questionnaire is read as fields. `parseNoteForm` gives each field its
  facts: the parts of its value between «; », then the lines without a label
  written right under it (chatters write those by hand; a blank line ends
  them). A fact ending in Core's month stamp «(MM.YYYY)» shows the month at
  the right. Empty fields fold into one line «Не заполнено: …». A
  questionnaire the chatter left untitled is headed «Анкета»; the word is
  shown, never written.
- It is edited as the same rows with a field per label, one fact per line.
  The fields are a view over the note's one text, which stays what Fansly
  stores and Core reads: `setNoteFieldFacts` rewrites only the field typed
  in, as its one `Label: a; b` line (the lines under it join that line), and
  every other line keeps its bytes. «Текстом» / «Полями» switch the two views
  of one draft (`Draft.asText`); a note that is not a questionnaire is its
  text, as before. A field takes its height from a hidden twin in CSS, so
  nothing is measured and the panel's scroll does not jump; a repaint now
  keeps that scroll.
- The fill's result is read where it landed. The notice names the fields it
  wrote («Гусь вписал: Хобби, Другое. Предлагает 2 правки.»,
  `NoteFillMerge.filledLabels`); those rows are marked. «Слова фана» shows
  the fan's quotes under each such field (the collapsed list is gone); a
  quote the chat does not hold shows without being asked for. A rewrite of a
  filled field sits under that field as the facts it adds and the ones it
  drops (`diffNoteFacts`), each rewrite with its own «Принять» and «Не
  нужно», «Принять все» from two up; a taken rewrite marks its field like
  any other the fill wrote. The batch «Скрыть» is gone.
- A fill's new lines now go below the lines written under the last field: in
  between they would have taken those lines for their own.
- Chrome: the custom name is the panel's title, an input over Fansly's name,
  its hint shown while it is edited or a save has news; «Изменить» and
  «Удалить» are icons as in Fansly's own modal; notes are divided by a
  hairline, not boxed; the footer is one row (new note and the view while
  reading, the note's «Сохранить» and «Отмена» while editing, so they do not
  scroll away); «+ Анкета» is offered while the fan has no questionnaire.
  «✨ Заполнить из чата» is «✨ Дополнить из чата» (it adds to a note since
  E164) and is also on the questionnaire being read: one press opens it and
  fills.
- Unchanged: the request (the values after the labels; a line written under
  a field does not travel until the chatter edits that field and so makes it
  part of the value), the Core contract, storage, permissions, and when
  Fansly is read or written. Whether lines under a field should travel as
  they are is the owner's to decide: without them the AI can repeat a fact
  the chatter wrote there.
- Checked in Chromium by rendering this panel with the product stylesheet in
  the mockup's frame and clicking it through, and by the jsdom tests. Not
  checked in Firefox on a live Fansly page.

**E167 (2026-10-14).** Release 2.12.0 ships E166 together with Core's half.
The owner ordered the whole chain («давай делай»).

- Core. Production ran `bc0f6dbc` (the E165 deploy) and `main` had moved ten
  commits on: Project Browser (PRs 6 and 13, migration 0276), the R20 HF
  series for chat-extension, voice notes in the narrow token, and a new
  contract hash (`e6d7e8e8…`) under which the SDK of the released 2.11.0
  (`663d132f…`) is not listed. Asked, the owner chose to deploy this release's
  change alone. So #601 was cherry-picked onto `bc0f6dbc` (clean, no
  conflict), the prompt, manifest, digest and contract tests were run on that
  exact commit (272 passed, contract hash still `663d132f…`), the commit was
  pushed as `deploy/notes-fill-fields-on-bc0f6dbc` (`c2b1843c5eaa`) and
  deployed dist-only to agency-de from a clean detached worktree: verified in
  167 s, health `ok`, `contractHash` `663d132f…`, the same
  `compatibleClientSdks`, the four app containers healthy on `c2b1843c5eaa`,
  the new rule present in the image. #601 itself goes to `main` through its
  PR; the next deploy of `main` carries it with everything else.
- No re-vendor: the contract did not change, so the vendored SDK
  (`663d132f…`, from `bc0f6dbc`) already equals production and the release
  gate holds as it is.
- The owner turned down the shorter output the mockup had proposed (E166), so
  #601 changes three lines of the merge prompt: the definitions of
  «Характеристика» and «Медиа» and the rule «one fact, one field».
- Version 2.12.0: a feature, by the rule 2.9.0 followed.
- Not verified before the release: the prompt on the production model with a
  production key (1Password asked for the owner's approval, which did not
  come), and the panel in Firefox on a live Fansly page. The prompt was run
  on a real chat from the hub's archive through stand-in agents instead: the
  old prompt reproduced the owner's screenshot, the new one kept the same
  detail with purchases out of «Характеристика» and no fact twice.

**E168 (2026-10-15).** The transcript every generation sends to Core is in
UTC, with a day line before each UTC day's first message.

- Why: the Lora persona audit (hub, 2026-10-15) found drafts losing track of
  time. The transcript carried `[HH:MM]` only, in the chatter's machine clock
  (against the hub's archive: +5 h on ari-1, +3 h on lora-2), and nothing
  said which day a message came from. Hub #622 dates the hub's own
  transcript (UTC, `--- YYYY-MM-DD ---`) and opens the fan-facing prompts
  with a `Now:` line, but every Fansly generation rides the client lane,
  where Core keeps this extension's text as it is.
- Change (`src/shared/transcript.ts`): `[HH:MM]` and the day line use UTC,
  and every kernel-bound transcript carries day lines: Reply, Fix, Ping, Hi
  (overlay and New Followers), Coach, Recap, the notes fill, voice, Compare.
  The `dayLines` option (E164: the notes fill in merge mode only, in the
  browser's clock) is gone. The budget is E164's: a day line is paid with
  its first kept message and never left without one; `messageCount` counts
  messages, never lines.
- Unchanged: storage, what is read from Fansly. Dates shown to the chatter
  (the notes panel's quotes, the fan's registration) stay in the chatter's
  own clock.
- Core is told. Core's `Now:` line (hub #622) said on the client lane
  «Transcript times come from the chatter's device clock», which this change
  makes wrong. Asked to choose between a flag on `clientContext` and moving
  Fansly to the hub lane as chat-extension R20 does, the owner chose the flag
  (2026-10-15). Every request now carries `clientContext.transcriptClock:
  'utc'` (`src/background/kernel-feature-gateway.ts`), and Core's `Now:` line
  then says «Transcript times and day lines are UTC». Released clients send
  no flag and keep the device-clock sentence, which stays true for them.
- Core's half: hub #628, stacked on hub #622 (the optional contract field,
  new contract hash `207cf3d5…`). The schema is strict, so the Core that
  knows the field must be deployed before a client that sends it is
  released. The SDK here is vendored from Core `5b7eb095` for development;
  the release re-vendors from the deployed Core.
- Request: one optional field more; otherwise unchanged.
- Checked: the formatter's tests in UTC, UTC+3, UTC+5, UTC−7 and UTC+14
  hosts (midnight, month and year turns, a window of six weeks, the budget at
  every cap); the gateway's request carries the flag and passes the vendored
  schema. Not checked on a live Fansly page.

**E169 (2026-10-16).** Release 2.12.1 ships E168.

- Core. Hub #622 (UTC day lines and the `Now:` line) and #628 (the optional
  `clientContext.transcriptClock`) reached `main` with hub #643
  (`305f4e18`), deployed to agency-de on 2026-10-15 at 23:17 UTC. Production
  `/api/v1/health` (read over SSH and through the public origin) reports
  `contractHash` `d4e21741…`, and the persona catalog answers 401, so the
  release gate holds.
- SDK. Re-vendored with the hub's `scripts/vendor-sdk.mjs` from a clean
  detached checkout of `305f4e18`; a second run gives the same bytes. It
  replaces the development vendor of `5b7eb095` (hub #628's branch,
  `207cf3d5…`), so nothing from an unmerged hub ref ships. Against the
  released vendor (`bc0f6dbc`) the SDK also gains what Core added since:
  Agent Read Plane, Project Browser, Sync and voice-note routes, opt-in
  stream capabilities. All additive; this client calls none of them and
  asks for no capability.
- Every generation still goes through one gateway
  (`src/background/kernel-feature-gateway.ts`, the only caller of
  `streamAiFeature`), which sets `transcriptClock: 'utc'` on every request:
  Reply, Fix, Ping, Hi, Coach, Recap and the notes fill
  (`operations.ts`), New Followers (`followers-service.ts`), voice
  (`voice-service.ts`) and Compare (`compare-operations.ts`).
- Field SDKs. Production lists `d4e21741…`, `030124…`, `9137410d…`,
  `a6f77fbb…` and `b95b765c…` in `compatibleClientSdks`; the SDK of the
  released 2.11.0 and 2.12.0 (`663d132f…`) is not registered in Core, so
  2.12.0 in the field runs against a Core that does not test it. This release
  moves the field onto the contract Core serves.
- Version 2.12.1: a patch, as the owner reads a small fix (E120); the
  chatter sees no new control.
- Checked: `pnpm check` (156 test files, 2858 tests, build); the whole suite
  in UTC, Asia/Yekaterinburg, America/Los_Angeles and Pacific/Pago_Pago; the
  transcript and gateway tests in UTC, +3, +5, −7, +14 and −11. In
  Pacific/Kiritimati (UTC+14) three `tests/fan-registration.test.ts` tests
  fail, on `main` (`d4c174f`) too. Not checked on a live Fansly page.

**E170 (2026-10-17).** A note edit is confirmed the way Fansly's own notes
modal confirms it.

- What happened: a chatter on ari-1 saved the questionnaire of a fan
  (2026-10-16) and read «Не сохранено: CG-FAN-03: Fansly вернул ошибку..».
  The hub read the fan's old 150-character note at 20:37 UTC; its next read
  (`/account?ids=`, 20:59 UTC) holds exactly the draft from the screenshot:
  the edit landed. Five more notes the hub saw before 2026-10-13 now carry
  the fill's month marks, so earlier edits of existing notes landed too.
- Why: E157 took an edit's answer to be the whole note and required its id
  and type (`readWrittenNote`), and `postOnce` refused `success: true`
  without a `response` for every path but `/notes/delete`. Neither was
  checked on a live session (E157, E158 say so). Fansly's modal
  (`app-notes-edit-modal`, `main.1c19146fbffb67a3.js`) takes `success` as
  the confirmation and reads only `title` and `note` from the answer. The
  exact answer Fansly sends was not captured: ChatGoose traces no note write.
- Change (`src/background/fansly-client.ts`): `editAccountNote` accepts
  `success: true` with any `response`, or none. An id, a contentType or a
  contentId the answer does carry must be this note's (a string id equal to
  ours; anything else present is a mismatch, as before); its title and text
  are taken when they are strings, otherwise the ones sent; the note keeps
  its own id, type and fan. The custom name rides the same edit. A create
  stays strict: only its answer gives the new note's id.
- Diagnosis next time: a failed note write (`/notes`, `/notes/edit`,
  `/notes/delete`) carries `details.shape`, what the answer was and never
  what it said: `HTTP <status>` and the content type for a refused status;
  `success` and `response` as JSON types, an object as its keys with their
  types, one level deep, for a refusal inside 2xx or an answer that is not
  this note. `fanslyActionError` puts it in `serverDetail` and drops any
  other detail, so a body's text never reaches the panel; the panel adds it
  after the error: «Не сохранено: CG-FAN-03: Fansly вернул ошибку (ответ
  Fansly: success:true · response:{title:string,note:string}). …». Note
  writes carry no trace (only follower runs keep one), so the panel line is
  where the owner sees it, on a screenshot.
- The double period: the registry's message ends with its own period, and
  the panel added another.
- Checked: `tests/fansly-client-notes.test.ts` (an edit answered with the
  whole note, with title and text only, with `success` alone, `response:
  null` and `response: true`; another id, fan or type refused; the shape
  never holds a text; a create without a note refused),
  `tests/runtime-api.test.ts`, `tests/fan-notes-controller.test.ts`, `tsc`.
  Not checked on a live Fansly page. Not released: it ships with the next
  release.
