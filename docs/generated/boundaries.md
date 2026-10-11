> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Boundaries — External Contract Catalog (from ChatGoose's side)

Every contract ChatGoose has with the outside world, described from this side:
what it exposes and for whom, what it calls, and exactly what data crosses. This
is the doc to read first for cross-project stitching. Deep detail per boundary
is in the numbered maps; this file is the index + the data-crossing inventory.

The extension has **three external counterparties**: Fansly (page DOM + REST +
credential capture), the kernel / Agency Hub "core" backend (the inter-project
boundary), and the self-hosted update feed. Everything else (`storage.local`,
the internal Port/runtime IPC) is an internal boundary within the extension.

Post-Stage-32 there is **no** direct boundary to any AI vendor (Anthropic /
OpenRouter). Vendor keys, prompt assembly, and cost math are all kernel-side; the
extension reaches AI only through the kernel feature lane (Boundary 4). The
grep gate `scripts/check-ai-cutover.mjs` enforces the absence of vendor endpoints.

---

## Boundary 1 — Fansly REST (`https://apiv3.fansly.com`)

**Direction:** outbound. **Auth:** the chatter's own captured Fansly session
headers (Boundary 2). **Detail:** `06-background-fansly-client.md`.

`FanslyClient` (`src/background/fansly-client.ts`) issues **GET-only** requests,
all to hard-coded `https://apiv3.fansly.com/api/v1/...` URLs, through one
`fetchEnvelope` (`fansly-client.ts:335`) with `credentials: 'omit'` (headers-only
auth, `fansly-client.ts:370`). Endpoints called (`fansly-client.ts:434-836`):

| Endpoint | Purpose | Data pulled |
|---|---|---|
| `GET /group/:groupId/` | resolve a conversation group | group members, fan account id |
| `GET /account/me` | authenticated creator identity | creator account id/username |
| `GET /account?ids=` | resolve fan/creator accounts | display name, username, bio |
| `GET /message` (paged) | conversation messages | message text, sender, timestamps |
| `GET /messaging/groups` (paged) | enumerate conversations | groupIds, subscription hints |
| `GET /subscribers` | subscription status fallback | tier, dates, price |
| `GET /media/orderhistory` | PPV purchase verification | purchased media ids |
| `GET /account/wallets/earnings/stats/accounts` | lifetime earnings per fan | gross totals |
| `GET /account/wallets/earnings/monthlystats/accounts` | monthly earnings breakdown | period gross |

Retry only on HTTP 429 and ≥500, max 3, delays `[1000,2000,4000]`ms
(`constants.ts:28`); `earnings` calls opt out of retry (`fansly-client.ts:661,742`).
`Retry-After` is honored but clamped to 5000ms, over-long waits surfacing as
`rate_limited` (`fansly-client.ts:383-390`, `constants.ts:31`). Media-purchase
verification **fails open** — an ambiguous result marks
`verificationIncomplete` rather than asserting purchased/not-purchased
(`fansly-client.ts:551-595`). The `fansly-client-ts` header is a freshly
generated `Date.now()` per attempt, not the captured timestamp
(`fansly-client.ts:351`).

**Family rule (`CLAUDE.md` DP 1-B):** the extension is the LIVE reader here; it
rides the chatter's browser session and adds no out-of-band Fansly traffic beyond
what these reads require.

## Boundary 2 — Fansly credential capture (`webRequest`)

**Direction:** passive inbound sniff of the page's own requests. **Detail:**
`02-background-runtime-messaging.md`.

`initializeSessionCapture` registers `browser.webRequest.onBeforeSendHeaders`
filtered to `https://apiv3.fansly.com/*` with `['requestHeaders']` only — **not
blocking** (`src/background/session-capture.ts:82-103`). It extracts four
mandatory headers or discards the capture: `authorization`, `fansly-client-id`,
`fansly-client-ts`, `fansly-session-id` (`session-capture.ts:56-64`);
`fansly-client-check` is optional. The account id is decoded as
`atob(authorization).split(':')[0]` (`session-capture.ts:5-13`). Captured
credentials live only in in-memory Maps in `SessionStore`
(`src/background/session-store.ts:14-15`) keyed per tab/account — **nothing
token-bearing is persisted to storage**. This is how Boundary 1 is authed
without the extension ever holding a Fansly password.

## Boundary 3 — Fansly page DOM

**Direction:** inbound reads + outbound writes into the live page. **Detail:**
`08-content-lifecycle-dom.md`. This is a selector-level coupling to Fansly's
Angular markup.

- **Route/identity read:** groupId parsed from `window.location.pathname` via `/^\/messages\/([^/?#]+)/`, polled every 500ms (`src/content/route-watcher.ts:3-18`, `constants.ts:77`). Fan identity read from `app-account-username .user-name` (fallback `app-group-message-input .label`), `@handle` extracted by `/@([^\s]+)/` (`src/content/conversation-dom.ts:11-57`).
- **Draft read:** the chatter's current composer text.
- **Reply write:** `insertIntoFanslyTextarea` focuses/selects and uses `document.execCommand('insertText', ...)`, falling back to setting `.value` + dispatching `input`/`change`, throwing `insertion_failed` if the value doesn't stick (`src/content/textarea.ts:28-49`).

The content script never talks to the network; it reaches the background only
over the internal Port (Boundary 7) — enforced by an eslint boundary rule
(`eslint.config.mjs:57-74`).

## Boundary 4 — Kernel / Agency Hub "core" (the inter-project boundary)

**Direction:** outbound HTTP(S) to the user-configured `agencyHubBaseUrl`
(an `optional_host_permissions` origin granted at runtime). **Auth is
per-operation, not uniform:** the AI feature lane, the acceptance reporter,
page-label resolution (`resolvePageLabelForUsername`), and `pageTopSpenders`
authenticate via `resolveHubBearer` — **device token preferred, legacy chatter
key (`agencyHubApiKey`) as fallback** (`src/background/agency-hub-client.ts:56-61,288,314`);
but `testConnection`, `pushFanProfile`, `fetchFanProfileByConversation`, and
`aiUsageBatch` authenticate with the legacy `agencyHubApiKey` **only**
(`agency-hub-client.ts:343,378,460,588`); the one-time sign-in uses cookie mode.
A device-token-only install can therefore read the spenders board and stream AI
features, but cannot push/fetch fan profiles or test the connection. Every
request carries `x-client-version: chatgoose-extension/<version>`
(`src/shared/client-version.ts:6-16`). **Detail:**
`05-background-kernel-ai.md`, `07-background-storage-spenders-hub.md`,
`15-vendor-kernel-sdk.md`.

All access goes through the **vendored compiled SDK** `@kernel/sdk`
(`vendor/kernel-sdk`, pinned by `contractHash e8c867e8…787baae`, source commit
`cedb00a6…`, `vendor/kernel-sdk/kernel-sdk.vendor.json`). The SDK exposes ~149
kernel operations; the extension calls **nine JSON operations + one SSE helper**:

| Kernel operation | Method + path | Caller | Data OUT | Data IN |
|---|---|---|---|---|
| `streamAiFeature` | `POST /api/v1/ai/features/:feature` (SSE) | `kernel-feature-gateway.ts:183` | feature, clientRequestId(=operationId), pageLabel, platform=fansly, conversationRef(fan id), tone/mode/persona/draft/isRegeneration, `clientContext`(transcript + fanDisplayName + fanSpendingData + fanSubscriptionData + optional fanBio/pingSegment) | SSE frames: `meta`(requestId, model, quota), `content_delta`, `reasoning_delta`, `usage`(tokens + costMicroUsd), `done`, `error` |
| `pages` | `GET /api/v1/pages` | `agency-hub-client.ts:198` | — | page list (label, platform, username) → page-label resolution |
| `pageConversationProfile` | `GET /api/v1/pages/:pageLabel/conversations/:conversationId/profile` | `agency-hub-client.ts:234` | pageLabel, conversationId | stored fan profile body + fan platformUserId/display |
| `upsertFanProfile` | `PUT /api/v1/pages/:pageLabel/fans/:platformUserId/profile` | `agency-hub-client.ts:255` | fan-summary body (≤50 000 UTF-8 bytes) | ack |
| `pageTopSpenders` | `GET /api/v1/pages/:pageLabel/top-spenders?window=lifetime&limit=` | `agency-hub-client.ts:319` | pageLabel, window, limit | ranked spenders (platformUserId, username, displayName, grossMills) + builtAt |
| `aiUsageBatch` | `POST /api/v1/ai-usage/batch` | `agency-hub-client.ts:271` (**no live caller** — see note) | ai-usage events | batch ack |
| `ingestObservations` | `POST /api/v1/ingest/observations` | `acceptance-reporter.ts:154` | `ai_acceptance` events (operationId, requestId/generationRef, feature, action, pageLabel, conversationId) | ack |
| `login` | `POST /api/v1/auth/login` | `device-token.ts:50` (cookie mode) | username, password | session cookie |
| `authIssueDeviceToken` | `POST /api/v1/auth/device-tokens` | `device-token.ts:68` | label | token, keyPrefix, label, expiresAt |
| `logout` | `POST /api/v1/auth/logout` | `device-token.ts:84` | — | — |

`testConnection` (options "Test Connection") is a `pages` call under the hood
(`agency-hub-client.ts:338-370`). Every hub call is gated by
`hasHostPermission` (`agency-hub-client.ts:130-145`) — an ungranted origin makes
the call a no-op `skipped`.

**The join key** is `pageLabel`: resolved by an exact, single-match lowercase
compare of the signed-in Fansly creator's username against the `pages` list,
filtered to `platform === 'fansly'` (`agency-hub-client.ts:204-224`). A non-unique
or missing match yields `null` (unmapped). The fan key across the boundary is the
Fansly `platformUserId` (fan account id) and, for profile reads, the
`conversationId`.

**AI-usage batch is dormant:** `AgencyHubClient.submitAiUsageBatch` /
`postAiUsageBatch` still exist (`agency-hub-client.ts:264-277,372-448`) but have
**no caller in `src/`** — the Stage 32 cutover deleted the usage reporter, and
spend metering now happens kernel-side from the gateway `usage` frames
(`costMicroUsd`). The capability remains wired in the client but unreferenced.

**Substantive fan data leaving the browser for the kernel:** the conversation
transcript string, the fan's display name, and the earnings/subscription display
strings (in `clientContext`), plus generated fan-summary bodies (`upsertFanProfile`)
and acceptance events. **No raw Fansly credentials cross this boundary** — those
stay in `SessionStore` and are used only against Fansly.

## Boundary 5 — `storage.local` (persisted state, schema v10)

**Direction:** internal persistence. **Detail:**
`14-shared-storage-migrations.md`. `STORAGE_SCHEMA_VERSION = 10`
(`src/shared/constants.ts:10`; note `CLAUDE.md` prose says "v9" — the live
constant is 10). Top-level keys: `schemaVersion`, `settings`, `personalities`,
`accountMappings`, `accountAliases`, `knownAccounts`, dynamic `summary:<groupId>`
entries, and the two acceptance-spool keys `acceptanceSpool` /
`acceptanceSpoolDropped` (`src/background/acceptance-reporter.ts:18-19`).

`Settings` (`DEFAULT_SETTINGS`, `constants.ts:135-146`) holds `agencyHubBaseUrl`,
`agencyHubApiKey` (legacy chatter key), `agencyHubDeviceToken`,
`spendersLegacyRebuild`, the four message-count settings, `debugMode`,
`promptCachingEnabled`. **Custody:** both hub credentials (legacy key + device
token) live in the `settings` record in plaintext — same custody class
(`device-token.ts:1-7`). Migrations are a single collapse-to-current pass, not a
per-version walk (`src/shared/migrations.ts:101-107`).

## Boundary 6 — Distribution / auto-update feed

**Direction:** outbound (the browser polls) + the release pipeline's uploads.
**Detail:** `01-build-packaging.md`. The extension is AMO-signed **unlisted** and
served only from the self-hosted feed `https://ext.gosling-agency.ru/updates.json`
(`manifest.json:57`). `scripts/deploy.sh` signs, builds `updates.json` with the
version, `update_link`, and `update_hash: sha256:<sha>`, uploads to VPS
`152.53.191.242:/var/www/ext`, and asserts the served feed version matches the
release. `strict_min_version: 142.0` (Gecko). The feed shares the VPS with the
kernel API but is a distinct nginx site (README, «The site on the server»).

## Boundary 7 — Internal IPC (Port protocol + runtime messaging)

**Direction:** internal, content ⇄ background. **Detail:**
`02-background-runtime-messaging.md`.

- **Long-lived Port** (`browser.runtime.onConnect`): the operation-streaming lane. Content → background: `tab:init`, `tab:routeChanged`, `operation:start`, `compare:start`, `operation:acceptance` (action only `'copied'|'inserted'`, `protocol.ts:201-206`), `operation:cancel`, `compare:cancel`. Background → content: `operation:chunk`/`progress`/`complete`/`error`/`discarded`/`debugPrompt`, the `compare:*` equivalents, `tab:state`, `settings:changed`, `mapping:changed`, `summary:syncStatus` (`src/shared/protocol.ts:188-268`).
- **One-shot `runtime.sendMessage`** (`sendRuntimeRequest`): the request/response lane. **Reachable** request types (`getRuntimeRequestType`, `protocol.ts:164-177`): `getPopupStatus`, `getSessionsSnapshot`, `testAgencyHubConnection`, `getSpendersList`.

**Observed name-vs-behavior divergence:** `issueAgencyHubDeviceToken` has a full
background handler (`src/background/runtime-api.ts:218-253`) and is declared in
the request-type map, and the options page sends it
(`src/options/index.ts:560`); but `getRuntimeRequestType`
(`protocol.ts:164-177`) has **no case** for it, so the sole `onMessage` listener
returns `undefined` before reaching the handler (`runtime-api.ts:49-52`). As
wired, that message resolves to `undefined` rather than executing the issuance
path. Recorded as actual behavior; the reviewer forms its own judgment.
