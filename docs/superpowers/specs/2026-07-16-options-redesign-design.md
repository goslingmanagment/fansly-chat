# Options page and changelog redesign (V3 "status-first")

Date: 2026-07-16. Status: approved by the owner (2026-07-16), after a codex
cross-review and a re-baseline to main 1.9.9. Docs are written in English by
owner preference; the product UI copy is Russian (decision §2.3). Mockups:
artifact «ChatGoose — редизайн настроек» (rev-5, variant V3 chosen).

## 1. Context and goals

The current options page (main, 1.9.9) is one long scroll in the family
tokens, but without the family components or structure. Personas are already
a read-only kernel catalog (E36/E37, since 1.9.7+): raw "key • version •
status" cards, a preservation note + export of legacy texts, and a recovery
page for a malformed snapshot. Confirmed pains: the Hub section is a wall of
status paragraphs (sign-in, legacy key, permission, connection interleaved);
there is no at-a-glance "is everything working"; the copy is English while
the team is Russian-speaking; the persona catalog is shown as raw keys and
versions with no human presentation.

Redesign goals, in priority order:

1. One page serves three roles: onboarding a new chatter, daily confidence
   ("all green — go work"), owner diagnostics (behind debug mode).
2. Structural parity with the desktop app: the same SettingsSurface shell
   (sticky nav + scrollspy + section cards) and the same control vocabulary
   (Button/Toggle/Chip/Badge, `.cap`/`.num`, the autosave flash).
3. Informativeness from data the kernel already provides: `/health`,
   `/auth/me`, quota from meta frames, spenders snapshot status, the persona
   catalog.

Non-goals: moving to a framework (plain TS + DOM stays), a language switcher
(fixed Russian with English terms), dark theme for install/guide.

## 2. Owner decisions on record (2026-07-16)

1. **Personas are backend-only.** Already shipped on main (E36 "Global
   personas are server-admin content", E37 follow-up): the editor and
   persona-sync are gone, the section reads the kernel catalog, mappings
   point at catalog keys, legacy texts are preserved + exportable, and a
   recovery mode exists. The redesign does NOT change the model — only the
   catalog presentation (§7) — and must keep preservation/recovery/export
   and the future-schema barrier intact.
2. **Sign-out is a single «Выйти» button:** best-effort device-token revoke
   on the hub + local wipe in every case, with an honest toast about the
   outcome. No separate "Forget locally" button.
3. **Language — fixed Russian** UI copy with English terms (Hub, device
   token, Spenders, Reply/Fix/Ping — feature names as in the toolbar).
4. **Web-page dark theme:** changelog.html gets a `prefers-color-scheme`
   swap; install/guide deliberately stay light.
5. **Fonts are bundled locally** (Source Serif 4 / Hanken Grotesk /
   IBM Plex Mono as extension files) — extension pages (options, popup,
   debug-prompt) stop hitting the Google Fonts CDN.

## 3. Information architecture

The shell is the desktop SettingsSurface: a sticky left nav (~150px) with
scrollspy, a single scrolling column of section cards (~740px max), a serif
page title «Настройки» + a version pill. A floating «Сохранено ✓» flash at
the bottom right (with a red twin on write failure).

Section order:

| # | Section | Contents |
|---|---------|----------|
| 0 | Readiness hero | checklist route / pulse line (§4) |
| 1 | Статус | read-only state rows (§5) |
| 2 | Agency Hub | address, device sign-in, Firefox access, legacy key, test |
| 3 | Персоны | read-only kernel catalog |
| 4 | Аккаунты | Fansly accounts: capture status + persona mapping |
| 5 | Генерация | context counters; Advanced: debug |
| 6 | Вид | theme (chips System/Light/Dark) |
| 7 | Версия | version, channel, Changelog button |

Today's "Account Mappings" and "Connection Status" merge into one
«Аккаунты» section: they are the same account list rendered twice.

## 4. Readiness hero

One card above the sections, two states:

**Route** (while steps remain open) — heading «До работы — N шагов» and
three ordered checks, each with a status and an action button:

1. «Agency Hub подключён» — address + an active credential (device token
   preferred) and the last connection test green → otherwise a «Войти»
   button (scrolls to the Hub section).
2. «Открой Fansly с аккаунтом модели» — at least one account with a
   captured session is known → otherwise «Открыть fansly.com»
   (`tabs.create`).
3. «Назначь персону аккаунту» — every account with a captured session maps
   to an active catalog persona → otherwise «К аккаунтам» (scroll).

**Pulse line** (all steps closed) — the card collapses to a single line:
green dot, «Всё работает», compact mono facts
(`Fansly 2 · Hub ✓ · AI 154 · Spenders 18 мин`), and «развернуть ▾»
expanding the full Статус rows.

The checks use the same sources as the Статус section; no new requests. Any
failing step is phrased as an action («токен истёк → Войти заново»), not a
diagnosis.

## 5. «Статус» section

The desktop Activity pattern: flat rows of "dot + mono badge + fact + right
detail", separated by hairlines. Read-only.

Kernel health and credential validity are different facts and different
rows: the public `/health` says nothing about authentication, and 401s come
only from authenticated calls (`me` / the connection test).

| Row | Badge | Source | Honest empty state |
|-----|-------|--------|--------------------|
| Fansly | `CAPTURED N мин назад` / `OFF` | current `getSessionsSnapshot`. Honest semantics: "session captured", NOT a live ping — `connected` means "credentials received and no 401 since". The store is worker memory: after a worker restart, known accounts without a tab render by id | «аккаунты не обнаружены — открой Fansly» |
| Hub (core) | `UP` / `DEGRADED` / `DOWN` | `/health` (public): status + db `latencyMs` (label it as DB latency). SDK nuance: the typed client throws before parsing a declared 503 body — DEGRADED is read via `raw('health')` + the vendored schema, or from `KernelApiError.body` | «адрес хаба не задан» |
| Доступ | `AUTH` / `401` / `НЕТ CREDENTIAL` | `me` (identity: username, role, pages) or the existing connection test; on 401 a «Войти заново» button right in the row | «войди или добавь ключ» |
| AI | `KERNEL` | quota snapshots from meta frames PER PAGE (the tracker already writes per-page — a new runtime read of the full map is needed instead of the popup's "freshest across pages" shortcut): per page «осталось N» (amber ≤20, red at 0 + reset time). No "out of N" meter (the kernel never reports the limit); NO dollar budget — E14 explicitly forbids rendering micro-USD locally (no-local-money-math) | «сегодня генераций не было — квота неизвестна» (the popup rule: never invent numbers) |
| Spenders | `RAMPED` / `FLAG OFF` / `NOT ALLOWLISTED` / `FAIL` | a new lightweight status tracker: an observation is recorded on EVERY board result (including errors/disabled/unsupported) with source identity and time; options NEVER calls `getSpendersList` (that performs Fansly requests and needs a tab). The board cache is not such a source: it is keyed by creator/hub/limit and deleted on disabled | «доска ещё не открывалась» |
| Контракт (debug only) | `MATCH` / `DRIFT` | the vendored SDK's `KERNEL_CONTRACT_HASH` vs `health.contractHash` | — |

Rows never block page render: each hydrates asynchronously with a skeleton.
Status color is always doubled by a word — never color alone.

## 6. «Agency Hub» section

Label-left rows (desktop pattern, ~150px label column):

- **Адрес хаба** — input; changing it resets the test status and recomputes
  the host permission, as today.
- **Вход устройства** — two states:
  - *signed out:* username + password + «Войти и выпустить token» (the
    current `issueAgencyHubDeviceToken` flow; the password is never
    stored);
  - *signed in:* an «активен» badge, an identity line from `/auth/me`
    (`username · role · pages: …`), a mono token line
    (`agency_hub_device_XXXX… · продлевается при работе`). The prefix is
    derived from the stored token; **no exact expiry date is shown**:
    issuance metadata is not persisted, `/me` does not return it, and the
    sliding expiry would make a stored issuance date a lie. The exact date
    appears only in the transient message right after sign-in (as today).
    A future core current-token-info operation is out of scope
    (cross-repo).
  - The **«Выйти»** button is a protocol — wipe-then-revoke, in the
    BACKGROUND (amended 2026-07-17; supersedes the earlier
    revoke-then-wipe order — a pagehide during the ~5s revoke window must
    not leave credentials on disk; local custody is the security
    boundary, and an unrevoked kernel token dies via sliding expiry or
    admin revoke):
    1) the page flushes its own pending writes by AWAITING the existing
       save chain (nothing cancelled — pending unrelated edits land in
       order), then clears the page's ownership of the custody field
       (dirty flag + visible input) so no later page write can replay
       the old key;
    2) the background `signOutAgencyHub` durably writes BOTH custody
       fields as EMPTY strings first (never key removal — removal would
       reopen the fallback to a legacy value embedded in the settings
       blob); the background outlives the page, so a close mid-operation
       cannot skip the wipe;
    3) then, best-effort: `DELETE /auth/device-tokens/current` with the
       explicit device-token bearer (the operation rejects API keys),
       ~5s timeout;
    4) outcomes are distinguished: «токен отозван на хабе» / «хаб
       ответил 401 — токен уже был недействителен» / «хаб недоступен —
       токен стёрт локально, на сервере умрёт по sliding-expiry»; a
       separate red toast when the LOCAL wipe itself failed (credentials
       are still present).
- **Доступ Firefox** — the host permission as a badge («разрешён» /
  «не выдан» + a «Разрешить» button) instead of today's four paragraphs of
  states. Permission-API error texts stay in the meta line.
- **Legacy chatter key** — a collapsed `<details>` («на период миграции»)
  holding the current field + Show/Hide. All custody logic (E19: dedicated
  storage keys, dirty tracking, save races) moves over unchanged.
- **Footer** — the last-test line («Проверено N мин назад — соединение OK»
  / an error code with explanation) + «Проверить соединение». Test
  semantics are unchanged; only the presentation shrinks from four status
  blocks to one line.

## 7. «Персоны» section (read-only catalog — presentation, not model)

The model already shipped (E36/E37, main): the kernel catalog lives in
persisted state (`personaCatalog` + `personaCatalogSource`/
`personaCatalogFetchedAt`), mappings are built from the catalog with the
`findActivePersona` gate, the Fan Summary cache is already keyed by
`personaDefinitionId`/`version`, legacy texts are preserved, export controls
and a malformed-snapshot recovery page exist. The redesign changes only the
presentation:

- A catalog row instead of the raw "key • version N • status" string: bold
  name, a `built-in` badge for `builtin:lora` (client-side check against
  `BUNDLED_LORA_PERSONALITY_ID`), mono `vN`, and an "аккаунтов: N" count
  from local mappings. There is NO per-persona update time and we do not
  draw one — the catalog schema carries only key/displayName/version/
  definitionId/status. Archived personas render dimmed and only while a
  mapping still references them (hint: «выбери замену»).
- Section footer: «каталог изменялся N мин назад» from
  `personaCatalogFetchedAt` — deliberately "changed": the timestamp does
  not advance on a byte-identical refresh; it is last-changed, not
  last-checked.
- Honest editing copy: «голоса управляются на сервере агентства;
  редактирование сейчас заморожено — включится владельческой консолью
  хаба». Today personas can be authored NOWHERE: dashboard mutations are
  disabled by flag and the routes answer 409 (core #151, until the
  legacy-LWW lane closes); writing "the owner edits them in the hub" would
  be a lie until that core release. The cross-repo prerequisite is recorded
  in the plan.
- Offline nuance: the catalog cache is bound to the exact source
  (`baseUrl|sha256(bearer)`) — an authority boundary, not an offline
  cache: rotating the token or changing the address hides the catalog
  until the first successful refresh, and mappings look "not in the
  catalog" meanwhile. In that state the UI says «каталог для новых кредов
  ещё не загружен», not "persona deleted".
- The preservation note and legacy-text export controls stay in the
  section, restyled (ghost button + meta line).
- **The recovery page** (`renderLegacyPersonaRecovery`) remains a
  full-screen gate OUTSIDE the new shell — it deliberately blocks normal
  settings; it gets the new tokens/components but no navigation.
- **The future-schema barrier (E37) carries over as is**: the
  `schemaVersion` observer is installed before the first read; pagehide
  never serializes a stale form. The new shell must not add write paths
  that bypass the barrier.

Not doing: the full-text `aiPersonasList` stays unused (the extension does
not need persona text); no persona storage migration (none is needed); the
editor does not come back. A chatter cannot create a voice — that is an
owner action (hub/desktop), and the UI says so plainly.

## 8. «Аккаунты» section

One row per known account: an avatar placeholder (initials),
`displayName @handle`, a dot + honest word status («захвачена · N мин
назад» / «нет сессии») — a credential-capture fact, not a live ping.
Name/handle live in worker memory: for a known account with no open tab
after a worker restart, the row honestly degrades to the account id
(persistent account metadata is out of scope; if ever wanted, that is a
separate v15). On the right, a persona select fed by the catalog.
Unmapped — an amber «AI отключён» badge (the desktop formula: unmapped =
gate). Empty state: «аккаунты не обнаружены — открой Fansly» + a button.
Mapping saves work as today (`saveAccountMapping`); the select locks while
writing.

## 9. «Генерация», «Вид», «Версия» sections

- **Генерация:** the four counters (Reply+Help, Ping, Fix, Deep) in a 2×2
  grid, mono inputs, current clamps preserved. An `Advanced` block
  (micro-cap): the «Debug mode» toggle with the hint «окно отладки промпта
  + ряд Контракт в статусе».
- **Вид:** theme chips `Системная / Светлая / Тёмная` (replacing the
  select).
- **Версия:** mono `v X.Y.Z` from the manifest, «канал: self-hosted feed»,
  a «Changelog» button → `tabs.create` to
  `https://…/changelog.html#v<major>-<minor>-<patch>`, hint «Firefox
  обновляет сам; форсировать — about:addons».

## 10. Components and execution

- Primitives port from the desktop 1:1 per the visual spec (values in the
  desktop-repo report and the mockups): Button (primary/ghost/danger), the
  18×32 pill Toggle with clay fill, Chip with inverted selected state,
  Badge (neutral/green/amber/bad/clay + a mono variant), `.cap` (10px,
  0.12em, uppercase), `.num` (mono + tabular-nums), the section card
  (radius 9px, `--chatgoose-shadow`, serif 15px title + 12px hint).
- Tokens are already shared — `src/options/styles.css` grows component
  classes; dark theme remains a pure variable swap.
- Plain TS + DOM, no framework (repo convention). `src/options/index.ts`
  (1531 lines on main) stays the single orchestrator through P1
  (shell/primitives/copy extracted); per-section modules are carved out
  incrementally in P2 (status/hub) and P3 (personas) as those phases
  rebuild each section — extracting race-sensitive save wiring with zero
  behavior change is not worth doing twice.
- All existing save discipline survives: debounce + flush on
  blur/change/pagehide, custody keys, "first read never mutates",
  non-blocking account hydration, serialized writes. After the split there
  is still ONE central write controller: sections never read or write
  storage on their own.
- Every async status request (health/me/catalog/quota) carries a
  generation/signature of the current connection: a slow reply from hub A
  must not paint the status of an already-entered hub B (the pattern
  already exists in the connection test — extend it to the new rows).
- The autosave flash: green «Сохранено ✓» on success, red with the error
  text on failure; `prefers-reduced-motion` respected.
- Fonts — local woff2 in the extension bundle, `@font-face`; Google Fonts
  removed from ALL extension pages (options AND popup both hit the CDN
  today; check debug-prompt). This is `esbuild.config.mjs` work (the copy
  target currently ships only icons) — a new assets copier for fonts.

## 11. Changelog.html

The family web register (like install.html): Fraunces + Hanken Grotesk +
mono, the `--paper/#f6f2ea … --clay/#c4704b` palette, the goose mascot in
the header.

- Versions in mono, an `id="v1-9-6"` anchor per release. Dates only where
  they are trustworthy: there are just 16 tags and they start at v1.7.0
  (the first three are retro-tags with approximate dates), so dates come
  from tags for 1.7.0+ and are stamped on each release going forward;
  older cards stay dateless — more honest than an invented backfill.
- Canon: `CHANGELOG.md` is the full archive (62 versions); the page
  historically started later (54 cards; the eight 1.2.x releases were
  never on it) — do NOT backfill; the divergence is recorded as
  deliberate: the page = "what users saw", the markdown = full history.
- The release summary is set in serif as the loudest text of the card;
  groups are cap labels with a dot: Исправлено (green), Изменено
  (neutral), Новое (clay); milestones get a clay card border. The old
  page's blue goes away (the family has no blue).
- «Технически» groups collapse into `<details>`; releases older than the
  latest three render collapsed to their summary.
- Dark theme: a `prefers-color-scheme` token swap.
- **Deploy invariant:** both stamp slots keep their markup byte-exact per
  deploy.sh templates — `<span class="nav-version">vX…</span>` and the
  footer `<p>vX… &middot; Gosling Agency &middot; Kernel-served AI</p>`;
  `release-pages.test.ts` keeps pinning slot cardinality and grows checks
  for: anchor uniqueness, a current-version anchor, date format, version
  order, and the "latest three expanded / older collapsed" invariant.
  The content of all existing releases (30+, up to the current 1.9.9)
  transfers without rewriting the texts.

## 12. Data and failure modes

Kernel operations used (presence in the vendored SDK verified): `health`
(public; DEGRADED read via `raw('health')`/`KernelApiError.body` — the
typed client throws before the 503 body), `me`, `aiPersonaCatalog`,
`authRevokeCurrentDeviceToken`, plus the existing
`issueAgencyHubDeviceToken` / connection test. Quota — a per-page map of
local meta-frame snapshots (a new runtime read; micro-USD still never
rendered — E14). Spenders — the new lightweight observation tracker
(written on every board result); options initiates no Fansly requests. No
new Fansly egress at all (DP 1-B does not widen). Every source fails
independently and honestly ("unknown" instead of an invented value); an
unreachable hub never blocks local settings. Quota and spenders
observations are session-scale and do not move the storage schema.

## 13. Phases

1. **P1 — shell and vocabulary.** Nav + scrollspy, cards, primitives,
   Russian copy, the autosave flash, the «Аккаунты» merge, the legacy key
   collapse, local fonts. No new data. The page already feels like the
   desktop.
2. **P2 — informativeness.** *Shipped 2026-07-17 (E41): the Статус section
   (Fansly/Hub/Доступ/AI/Spenders/Контракт rows), the readiness hero, the
   per-page quota read, the spenders observation tracker, and the anchored
   Changelog button all landed; sign-out and the persona catalog rows remain
   P3; the changelog.html port remains the parallel track.* The Статус section + readiness hero: health
   (UP/DEGRADED/DOWN) and Доступ (me/test) as separate rows, the per-page
   quota read, the spenders status tracker, the debug-only contract row,
   the Changelog button with the anchor (the page deploys before this
   release).
3. **P3 — persona presentation + sign-out.** The catalog section in the
   new visual (preservation/export carried over, the recovery page on the
   new tokens), the «Выйти» button per the §6 protocol. No storage
   migration.
4. **Parallel track — changelog.html** (independent of extension code):
   the web-register port, dates, anchors, collapses, dark theme, stamp
   slots.

Each phase ships as its own release and is useful on its own. Ordering is
hard in exactly one place: the updated changelog.html with anchors deploys
before (or together with) the P2 release that adds the anchored button — a
link must not ship before its target. No storage migrations in any phase.

## 14. Acceptance (key checks)

- Fresh-profile onboarding: the hero reaches all-green in ≤3 actions; every
  step is clickable and lands in the right section.
- Hub unreachable: the page opens, local settings work, status rows degrade
  one by one with honest wording; «Выйти» wipes locally and says so. Kernel
  health and credential validity are never merged into one indicator.
- «Выйти» covers the cases: successful revoke / hub answered 401 / hub
  unreachable / local write failed — four distinct outcomes with distinct
  messages; after any sign-out, pagehide never brings credentials back.
- Quota: no generations today — "unknown"; after a generation — the number
  from the meta frame FOR EACH page separately; exhaustion — amber/red with
  the reset time; no dollars anywhere on the page (E14).
- Accounts: after a worker restart, a not-reopened account degrades to its
  id without breakage or an invented name; the copy says «захвачена», not
  «жива».
- Personas: the E36/E37 preservation/recovery/export machinery survives
  (their tests stay green, none weakened); an archived persona in a mapping
  is visible and demands a replacement.
- Deploy: `pnpm check` green, the changelog stamp slots pass
  `release-pages.test.ts`, `scripts/deploy.sh` stamps with no edits.
- Dark theme on both surfaces is a pure token swap, with no per-component
  styling.
