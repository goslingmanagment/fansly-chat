# ChatGoose — Project Kernel: Overview & Reading Guide

**What this folder is.** A complete, factual map of the ChatGoose codebase, written for a reviewer who will later stitch ChatGoose together with two sibling projects (the `core` backend / "Agency Hub", and a desktop app). It describes the code *as it is now*. It is strictly descriptive — no ratings or recommendations. Older spec/plan/audit files in the repo (`SPEC_FINAL.md`, `TODO.md`, `CHANGELOG.md`, the `prompts/` design notes) are **not** treated as ground truth here; only the code is.

**One-line description.** ChatGoose is a Firefox (Manifest V3) WebExtension that injects an AI reply/assistant toolbar into the Fansly.com creator messaging UI, generates replies/summaries/etc. via Anthropic or OpenRouter using the creator's own API keys, and optionally syncs fan summaries and AI-usage telemetry to a user-configured `core`/Agency Hub backend.

---

## 1. What it does (feature surface)

ChatGoose adds a toolbar next to the Fansly message composer. Each button runs a **feature** (`shared/features.ts` `FEATURE_POLICIES`):

| Feature | Label | Purpose |
|---|---|---|
| `fast-reply` | Reply | Draft a reply to the current fan conversation |
| `improve-draft` | Fix | Rewrite the creator's current composer draft |
| `help-me` | Help | Suggest what to say next |
| `fan-summary` | Summary | Deep summary of the fan relationship (large context; can sync to Agency Hub) |
| `chat-review` | Review | Review the conversation |
| `ping` | Ping | Draft a re-engagement message for an idle fan |
| `hi-greeting` | Hi | Draft an opening greeting |
| *(compare / "Multi")* | Multi | Generate several personality drafts side-by-side for one fan |
| *(Spenders board)* | Scan | Rank a creator's top-spending fans |

Replies can carry a **tone** (`none/casual/flirty/upsell/spicy`) and a **reply mode** (`default`/`preferSplit`). Output streams live into an overlay; the creator inserts it into the Fansly composer or copies it.

---

## 2. Architecture at a glance

Four bundled entry points (`esbuild.config.mjs`), each a separate extension context:

```
┌─────────────────────────── Firefox WebExtension ───────────────────────────┐
│                                                                             │
│  content.js  (content script, injected into fansly.com pages)               │
│    • reads conversation DOM (fan @handle, draft), writes reply to composer  │
│    • watches SPA route → groupId/routeNonce                                 │
│    • renders toolbar / overlay / inline compare panel / spenders board      │
│    • long-lived Port ⇄ background                                           │
│                                   │  Port + runtime.sendMessage             │
│  background.js  (service worker — the engine)                               │
│    • OperationCoordinator: feature ops + compare ops                        │
│    • FanslyClient (REST), LlmClient→Anthropic/OpenRouter, AgencyHubClient   │
│    • SessionStore (Fansly auth captured via webRequest)                     │
│    • StorageCoordinator (mirror of storage.local), SpendersService          │
│                                                                             │
│  popup.js  (toolbar popup)      options.js  (settings page)                 │
│    • getPopupStatus              • API keys, per-feature models, personas,  │
│                                    account→persona mappings, sessions, Hub  │
└─────────────────────────────────────────────────────────────────────────────┘
        │ apiv3.fansly.com        │ api.anthropic.com / openrouter.ai   │ core/Agency Hub
        ▼                         ▼                                     ▼
   Fansly REST + DOM         AI providers (user keys)             fan profiles + usage
```

**Composition root:** `src/background/index.ts` constructs all background services with constructor DI (no module-level mutable singletons) and wires the global listeners (`runtime.onConnect`, `webRequest` capture, `tabs.onRemoved`, `storage.onChanged`).

**Operation flow (single feature):** user clicks toolbar → content sends `operation:start` over the Port → `OperationCoordinator` loads messages (`FanslyClient.loadMessages`) and fan context (earnings/subscription, prior summary, Agency Hub profile) → builds prompt (`shared/prompts.ts` + `shared/transcript.ts`) → streams from `LlmClient` → emits `operation:chunk`/`progress`/`complete` back over the Port → overlay renders → creator inserts into composer. Stale results are gated by `groupId`/`routeNonce` (`operation:discarded`). Full detail in `03-background-operations.md`.

---

## 3. Boundaries (start here for cross-project work)

All contracts with the outside world are catalogued in **`boundaries.md`**. Summary:

1. **Fansly REST** (`apiv3.fansly.com`) — outbound GETs authed by session headers.
2. **Fansly auth capture** — passive `webRequest` sniff of the page's own Fansly credentials.
3. **Fansly DOM** — content script reads conversation identity/draft, writes the reply.
4. **Anthropic Messages API** — outbound streaming POST, user's Claude key.
5. **OpenRouter** — outbound streaming POST (Anthropic-compatible `/messages`), user's key.
6. **Agency Hub / `core`** — the inter-project boundary: `GET /pages`, `GET .../conversations/{id}/profile`, `PUT .../fans/{id}/profile`, `POST /ai-usage/batch`, Bearer-authed to a user-configured host.
7. **`storage.local`** — settings, personalities, mappings, summary cache (schema v7).
8. **Distribution** — self-hosted Firefox auto-update via `ext.gosling-agency.ru/updates.json`.

The **`core`/Agency Hub** boundary (§6 of `boundaries.md`) is the one the reviewer most needs: `pageLabel` is the join key between a ChatGoose creator session and a `core` "page"; ChatGoose pushes fan summary bodies + AI-usage metering and pulls stored fan profiles.

---

## 4. Source layout

| Path | Role | Doc |
|---|---|---|
| `src/background/` | service-worker engine (24 files) | `02`–`07` |
| `src/content/` | Fansly page injection + UI (23 files) | `08`–`10` |
| `src/options/`, `src/popup/` | settings + toolbar popup | `11` |
| `src/shared/` | types, protocol, storage, prompts, domain calc (30 files) | `12`–`14` |
| `prompts/*.md` | bundled AI prompt templates | `13` |
| `tests/` | vitest + jsdom suite (58 files) | `15` |
| build/deploy | `esbuild.config.mjs`, `manifest.json`, `scripts/`, CI | `01` |

Bundling: `esbuild` produces IIFE bundles per entry; `.md`/`.css` are inlined as text; a `virtual:model-card-drafts` plugin bundles `prompts/drafts/*.md` into the compare-cards catalog. Tests: `vitest` (jsdom). Typecheck: `tsc --noEmit`.

---

## 5. Document set

| File | Covers |
|---|---|
| `boundaries.md` | **External contract catalog** (Fansly REST/DOM/auth, Anthropic, OpenRouter, Agency Hub, storage, distribution, internal IPC) |
| `01-build-packaging.md` | esbuild pipeline, MV3 manifest, tsconfig/vitest, CI, deploy/update scripts |
| `02-background-runtime-messaging.md` | composition root, runtime API, protocol guards, `SessionStore`/`TabContextStore`, webRequest capture |
| `03-background-operations.md` | `OperationCoordinator` — the single-feature operation engine |
| `04-background-compare.md` | compare/Multi multi-draft engine + `compare-cards.ts` |
| `05-background-llm-clients.md` | `LlmClient`, Anthropic + OpenRouter clients, SSE utils, cost |
| `06-background-fansly-client.md` | `FanslyClient` REST client (every endpoint) |
| `07-background-storage-context-spenders-hub.md` | `StorageCoordinator`, context loader, `SpendersService`, usage reporter |
| `08-content-lifecycle-dom.md` | content bootstrap, SPA routing, Fansly DOM read/write, Port client |
| `09-content-ui-surfaces.md` | toolbar, overlay, inline compare panel, toasts, cheatsheet |
| `10-content-spenders-board.md` | Spenders board UI + shared spenders model |
| `11-options-popup.md` | options settings page + toolbar popup |
| `12-shared-domain-model.md` | `types.ts`, feature policies, model registry, capabilities, constants |
| `13-shared-prompts-transcript.md` | prompt assembly, prompt templates, transcript building, reply parsing, earnings/subscriptions |
| `14-shared-storage-migrations-utils.md` | storage schema, migrations, summary cache, errors, hotkeys, utils |
| `15-tests-overview.md` | test coverage index |

*(`prompt-1-map.md` is the generating prompt for this pass and is left untouched.)*
