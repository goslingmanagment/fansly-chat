> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# ChatGoose — Codebase Map: Overview & Reading Guide

**What this folder is.** A complete, factual map of the ChatGoose codebase as it
stands at commit `1586f07` (release `1.6.0`, post kernel-migration). It is
written for a reviewer stitching ChatGoose together with its sibling projects
(the `core` / Agency Hub backend and the ChatGoose desktop app). It describes the
code *as it is now*, strictly descriptively — no ratings or recommendations.
Older spec/plan/audit files in the repo (`SPEC_FINAL.md`, `TODO.md`,
`CHANGELOG.md`, `README.md`) and the repo's own `CLAUDE.md` prose are **not**
treated as ground truth; only the code is (where they disagree with the code, the
maps record the code's actual behavior). The Pass 1 pre-migration maps live in
`docs/project-kernel/` under superseded banners.

**One-line description.** ChatGoose is a Firefox (MV3) WebExtension that injects
an AI reply/assistant toolbar into the Fansly.com creator messaging UI. It reads
the live Fansly conversation (DOM + REST) client-side and streams AI generations
through the **kernel feature lane** (`POST /api/v1/ai/features/:feature`, SSE) of
the user-configured `core`/Agency Hub backend; it also pulls/pushes fan profiles,
renders a kernel-fed top-spenders board, and reports acceptance telemetry. It
holds **no** vendor AI keys, assembles **no** prompts, and computes **no** money —
those are kernel-side (the Stage 32 cutover).

---

## 1. Feature surface

The injected toolbar runs one **feature** per button. The canonical set is the
seven `FeatureType` values with policies in `src/shared/features.ts`
(`FEATURE_POLICIES`) and labels in `src/shared/constants.ts:123-131`
(`FEATURE_LABELS`); the toolbar renders its own button labels from
`src/content/button-bar.ts` (`TOOLBAR_FEATURES`), which differ in wording.

| `FeatureType` | `FEATURE_LABELS` | Bucket / surface | Purpose |
|---|---|---|---|
| `fast-reply` | Reply | quick / inline-reply | Draft a reply to the current fan |
| `improve-draft` | Fix | improve / inline-reply | Rewrite the composer draft (requires draft) |
| `help-me` | Help | quick / overlay | Suggest what to say next |
| `fan-summary` | Summary | deep / overlay | Deep fan-relationship summary (syncs to the hub) |
| `chat-review` | Review | deep / overlay | Review the conversation |
| `ping` | Ping | ping / inline-reply | Re-engagement message for an idle fan |
| `hi-greeting` | Hi | hi / inline-reply | Opening greeting (fixed 25-message context) |

`fast-reply` carries a **tone** (`none/casual/flirty/upsell/spicy`) and a **reply
mode** (`default`/`preferSplit`); only `fast-reply` supports both
(`features.ts:33-44`). Two additional surfaces exist beyond the seven features:

- **Multi / compare** — several persona drafts side-by-side for one fan (`src/background/compare-operations.ts`, `09`/`04`). **Current state:** the compare-draft catalog (`virtual:model-card-drafts`) resolves to **empty** because the `prompts/drafts/` directory no longer exists in the repo; with `< 2` cards the toolbar gates the Multi button off (`button-bar.ts:195`, `04-background-compare.md`), so Multi is effectively unavailable as shipped.
- **Spenders board** — a ranked top-spenders list, now fed by the kernel `pageTopSpenders` endpoint by default; a legacy Fansly-scan rebuild survives behind the UI-less `spendersLegacyRebuild` setting (`10`/`07`).

---

## 2. Architecture at a glance

Four IIFE bundles (`esbuild.config.mjs`), each a separate extension context:

```
┌──────────────────────────── Firefox WebExtension (MV3) ────────────────────────────┐
│                                                                                     │
│  content.js  (content script, injected into fansly.com)                             │
│    • reads conversation DOM (fan @handle, draft), writes reply to composer          │
│    • polls SPA route → groupId (route-watcher, 500ms)                               │
│    • renders toolbar / streaming overlay / inline compare panel / spenders board    │
│    • long-lived Port ⇄ background  (+ one-shot runtime.sendMessage)                  │
│                                   │                                                  │
│  background.js  (non-persistent MV3 event page — the engine)                        │
│    • OperationCoordinator (feature ops) + compare engine                            │
│    • KernelFeatureGateway → core AI feature lane (SSE)                              │
│    • FanslyClient (REST), AgencyHubClient (kernel SDK), SpendersService             │
│    • SessionStore (Fansly auth captured via webRequest, in-memory only)             │
│    • StorageCoordinator (mirror of storage.local), AcceptanceReporter               │
│                                                                                     │
│  popup.js  (toolbar popup: getPopupStatus)     options.js  (settings page)          │
└─────────────────────────────────────────────────────────────────────────────────────┘
        │ apiv3.fansly.com          │ core / Agency Hub (user-configured host)
        ▼                           ▼
   Fansly REST + DOM (live)    kernel SDK: AI feature lane (SSE), pages, fan profiles,
                               top-spenders, acceptance ingest, device-token sign-in
```

**Composition root:** `src/background/index.ts` constructs every service with
constructor DI (no module-level mutable singletons) and wires the global
listeners (`runtime.onConnect`, `runtime.onMessage`, `webRequest` capture,
`tabs.onRemoved`, `storage.onChanged`). The background is a **non-persistent MV3
event page** (`manifest.json:20-24` uses `background.scripts`, not a
`service_worker` key), despite prose in places calling it a service worker.

**Single-feature operation flow:** toolbar click → content sends `operation:start`
over the Port → `OperationCoordinator` loads messages (`FanslyClient`) and fan
context (earnings/subscription, prior summary, hub fan profile) → builds the
transcript + fan display strings → `KernelFeatureGateway.streamFeature` opens the
SSE stream to `POST /api/v1/ai/features/:feature` → `content_delta` frames stream
back as `operation:chunk`/`progress`/`complete` over the Port → overlay renders →
creator inserts/copies into the Fansly composer → an `ai_acceptance` event is
spooled. Staleness is gated by **operation-id identity keyed per tab** (not by
`routeNonce`); route changes cancel by `groupId` comparison
(`03-background-operations.md`). Full detail in `03`.

---

## 3. Boundaries (start here for cross-project work)

All external contracts are catalogued in **`boundaries.md`**. Summary:

1. **Fansly REST** (`apiv3.fansly.com`) — outbound GET-only, session-header auth (`06`).
2. **Fansly credential capture** — passive `webRequest` sniff of the page's own 4 Fansly headers; kept in memory only (`02`).
3. **Fansly page DOM** — content reads identity/draft, writes the reply (`08`).
4. **Kernel / Agency Hub `core`** — the inter-project boundary: 9 SDK JSON operations + the `streamAiFeature` SSE helper, bearer-authed (device token or legacy chatter key) to a user-configured host (`04`/`05`/`07`/`15`).
5. **`storage.local`** — settings, personas, mappings, summary cache, acceptance spool (schema v10) (`14`).
6. **Distribution** — self-hosted Firefox auto-update via `ext.gosling-agency.ru/updates.json` (AMO-unlisted signing) (`01`).
7. **Internal IPC** — the content⇄background Port protocol + `runtime.sendMessage` request lane (`02`).

The **kernel** boundary (§4 of `boundaries.md`) is the one the reviewer most
needs: `pageLabel` (resolved by exact Fansly-username match over `GET /pages`) is
the join key between a ChatGoose creator session and a `core` "page"; the fan key
is the Fansly `platformUserId`. The substantive fan data crossing to the kernel is
the transcript string + fan display/earnings/subscription strings (in
`clientContext`) and generated fan-summary bodies; raw Fansly credentials never
cross it.

---

## 4. Source layout

| Path | Role | Doc |
|---|---|---|
| `src/background/` | background event-page engine (20 files) | `02`–`07` |
| `src/content/` | Fansly page injection + UI (23 files incl. `inline-panel/`, `overlay/`, `spenders/`, `ui/`) | `08`–`10` |
| `src/options/`, `src/popup/` | settings page + toolbar popup | `11` |
| `src/shared/` | types, protocol, storage, transcript, domain calc (~28 files) | `12`–`14` |
| `vendor/kernel-sdk/` | vendored compiled `@kernel/sdk` (the kernel contract) | `15` |
| `tests/` | vitest (node env + hand-rolled jsdom); 51 test files | `16` |
| build/deploy | `esbuild.config.mjs`, `manifest.json`, `scripts/`, CI | `01` |

Bundling: `esbuild` → IIFE per entry, `.md`/`.css` inlined as text
(`esbuild.config.mjs`). The `virtual:model-card-drafts` plugin still exists but
resolves to an empty catalog (no `prompts/` directory). Typecheck: `tsc --noEmit`
(also the kernel-contract breaking-change gate). Lint enforces the
content-cannot-import-background process split. `pnpm check` =
typecheck + lint + `pnpm gates` (AI-cutover greps) + tests + build.

---

## 5. Document set

| File | Covers |
|---|---|
| `boundaries.md` | **External contract catalog** (Fansly REST/DOM/capture, kernel/Agency Hub, storage, distribution, internal IPC) |
| `01-build-packaging.md` | esbuild pipeline, MV3 manifest, tsconfig/vitest/eslint, CI, AI-cutover gates, deploy/update scripts |
| `02-background-runtime-messaging.md` | composition root, `runtime.onMessage` surface, the Port protocol, `SessionStore`/`TabContextStore`, webRequest capture, storage-change fan-out |
| `03-background-operations.md` | `OperationCoordinator` — the single-feature operation engine, lifecycle, gating, timeouts, hub summary push |
| `04-background-compare.md` | compare/Multi engine + the (empty) compare-cards catalog |
| `05-background-kernel-ai.md` | `KernelFeatureGateway` (AI SSE lane), `device-token` sign-in, `acceptance-reporter`, client-version + hub URL helpers |
| `06-background-fansly-client.md` | `FanslyClient` REST client (every endpoint, retry/backoff, PPV verification) |
| `07-background-storage-spenders-hub.md` | `StorageCoordinator`, `SpendersService` (kernel vs legacy path), `AgencyHubClient` (the hub boundary) |
| `08-content-lifecycle-dom.md` | content bootstrap, SPA routing, Fansly DOM read/write, mount/re-attach, Port client, scroll compensation |
| `09-content-ui-surfaces.md` | toolbar, streaming overlay, inline compare panel, toasts, cheatsheet, mapping banner, styles |
| `10-content-spenders-board.md` | Spenders board UI + shared spenders/spend model |
| `11-options-popup.md` | options settings page (device-token sign-in, hub, personas, mappings, sessions) + toolbar popup |
| `12-shared-domain-model.md` | `types.ts`, feature policies, constants, error catalog, personas, small utilities |
| `13-shared-transcript-reply.md` | transcript assembly, reply-output parsing, split, earnings/subscription display strings (the clientContext values) |
| `14-shared-storage-migrations.md` | storage.local schema (v10), migration chain, summary cache |
| `15-vendor-kernel-sdk.md` | the vendored `@kernel/sdk` — pinning, public API, full operation surface vs the ops the extension uses, drift gate |
| `16-tests-overview.md` | vitest config, the two structural gates, the coverage index |

*(`prompt-1-map.md` in `docs/project-kernel/` is the generating prompt and is
left untouched.)*

---

## 6. Notable current-state facts & name-vs-behavior divergences

Recorded here because they are load-bearing and cross-cutting; each is anchored
in the referenced map:

- **Kernel-only AI.** No vendor AI SDK/keys/prompt assembly/cost math remain; `scripts/check-ai-cutover.mjs` greps the invariant (deleted modules incl. `shared/prompts`, `llm-client`, `model-registry`, `agency-hub-usage-reporter`). Prompt assembly is entirely kernel-side (`05`, `13`).
- **`issueAgencyHubDeviceToken` is unreachable as wired.** The handler exists (`runtime-api.ts:218-253`) and the options page sends the message, but `getRuntimeRequestType` (`protocol.ts:164-177`) has no case for it, so the listener returns `undefined` first (`02`, `boundaries.md` §7).
- **Hub auth is not uniform.** The AI lane, acceptance reporter, page-label resolution, and top-spenders use `resolveHubBearer` (device token preferred); `testConnection`, fan-profile push/fetch, and AI-usage batch use the legacy `agencyHubApiKey` only (`07`).
- **AI-usage batch is dormant.** `AgencyHubClient.submitAiUsageBatch` still exists but has no caller in `src/`; spend metering is kernel-side via gateway `usage` frames (`05`, `07`).
- **Multi/compare is effectively off** (empty draft catalog → button gated) (`04`).
- **Acceptance telemetry has no `shown` in practice.** The reporter type includes `shown`, but the content surfaces emit only `copied`/`inserted` (`protocol.ts:201-206`, `09`).
- **Storage schema is v10**, not the "v9" the prose says (`constants.ts:10`, `14`).
- **The background is an MV3 non-persistent event page**, not a service worker (`02`).
