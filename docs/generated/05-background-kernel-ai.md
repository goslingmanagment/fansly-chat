> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# 05 — Background: Kernel AI Lane, Device Token, Acceptance Telemetry, Hub Transport Helpers

Post-Stage-32 the extension holds **no** vendor AI SDKs, keys, prompt templates,
or cost math. Every AI generation is one SSE stream through the kernel feature
lane. This file covers the kernel-transport layer: `kernel-feature-gateway.ts`
(the AI stream), `device-token.ts` (sign-in / token issuance),
`acceptance-reporter.ts` (post-generation telemetry spool), and the two shared
helpers every kernel call depends on (`shared/client-version.ts`,
`shared/agency-hub.ts`). The higher-level Agency-Hub data client
(`agency-hub-client.ts`) is documented in `07-background-storage-spenders-hub.md`;
the vendored SDK surface in `15-vendor-kernel-sdk.md`.

## 1. The kernel feature gateway (`src/background/kernel-feature-gateway.ts`)

One generation = one `POST /api/v1/ai/features/:feature` SSE stream via the
vendored SDK's `streamAiFeature` helper (`src/background/kernel-feature-gateway.ts:11, 183-219`).
The extension still loads Fansly conversation context itself (the header comment
at `:1-9` states why: Fansly has no webhook lane, and the panel reads the live
conversation at generation time), so the request carries **client-context
values**; prompt **assembly** (templates, personas, platform wording, budgets,
capture, ledger, pricing) is kernel-side.

### Public interface

`KernelFeatureGateway` (`:117-126`) exposes:
- `isConfigured(settings)` → true when a normalized hub base URL and a bearer both resolve (`:132-136`).
- `streamFeature(settings, request, callbacks, signal)` → streams one generation and resolves with the full accumulated raw text (`:138-234`).

Constructed by `createKernelFeatureGateway(fetchImpl = globalThis.fetch)`
(`:128-236`); wired in the composition root at `src/background/index.ts:30, 37-45`
and passed into `OperationCoordinator`.

### Request shape (`KernelFeatureRequest`, `:28-41`) → wire body (`:190-215`)

- `feature: FeatureType`, `clientRequestId` (= operationId, "must be a UUID", the kernel dedup/correlation key), `pageLabel`, `conversationRef` (Fansly fan account id), optional `personaKey`, `replyTone` (`none|casual|flirty|upsell|spicy`), `replyMode` (`default|preferSplit`), `draftText`, `isRegeneration`.
- `platform: 'fansly'` is hard-coded into the body (`:196`).
- `clientContext` (`KernelFeatureClientContext`, `:18-26`, sent at `:202-214`): `transcript` (string), `messageCount`, `fanDisplayName`, `fanSpendingData` (string), `fanSubscriptionData` (string), optional `fanBio`, optional `pingSegment` (`active|segment-a|segment-b`). Optional fields are omitted when `undefined` rather than sent as null. These strings are built by `shared/transcript.ts` / `shared/earnings.ts` / `shared/subscriptions.ts` (see `13-shared-transcript-reply.md`).

The kernel-side contract this maps onto is `aiFeatureStreamBodySchema`
(`vendor/kernel-sdk/dist/contracts/routes.d.ts:3823-3867`), which additionally
accepts `fanRef`, `model`, `reasoningEffort`, `messageCount` — fields the
extension does **not** send (the model/reasoning selection is kernel-side).

### Stream frames → callbacks (`handleFrame`, `:148-181`)

The SSE frames are the `AiGatewayStreamFrame` discriminated union
(`vendor/kernel-sdk/dist/contracts/routes.d.ts:3745-3798`); the gateway handles:
- `meta` → `callbacks.onMeta({ requestId, clientRequestId, model })` (`:150-156`). `requestId` is the generation ref used for acceptance correlation. (The full meta frame also carries `feature`, `provider`, `providerResponseId`, and a `quota` object — the extension consumes only the three named fields.)
- `content_delta` → accumulates into `text` and calls `callbacks.onText` (`:157-160`).
- `reasoning_delta` → `callbacks.onReasoningDelta` (`:161-163`).
- `usage` → `callbacks.onUsage(KernelFeatureUsage)` (`:164-173`): `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `costMicroUsd` (gateway-priced micro-USD — "the only spend source post-cutover", `:48-50`), `costApproximate`.
- `done` → sets `done = true` and calls `callbacks.onStopReason` (`:174-177`).
- (The `error` frame variant is surfaced by the SDK as a thrown `KernelApiError`, mapped below.)

### Fail-closed completion (`:221-233`)

After `await handle.done`, if the terminal `done` frame never arrived, the
gateway throws `ChatGooseError('hub_request_failed', { message: 'AI stream ended
without completing.' })` — a truncated stream is **never** returned as a
complete generation.

### Error mapping (`toChatGooseError`, `:82-115`; `mapKernelGateError`, `:65-80`)

Kernel product-gate messages (HTTP 400) are mapped **before** the generic HTTP
mapping so gate wording stays user-meaningful:
- `"requires at least"` → `not_enough_history`
- `"at most" + "hi-greeting"` → `hi_too_many_messages`
- `"blocked while the conversation is active"` → `ping_blocked`

Then generic HTTP mapping: 429 → `rate_limited`; 502/503 → `service_unavailable`;
401/403 → `hub_invalid_api_key`; a network-category `aborted` error is re-thrown
as a DOM `AbortError`; anything else → `hub_request_failed` with the status +
first 400 chars of the message.

### Auth & headers

Base URL via `normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl)` and bearer
via `resolveHubBearer(settings)` (`:139-143`); both must be present or
`hub_missing_api_key` is thrown. Auth rides the SDK as
`{ mode: 'bearer', token: () => bearer }` and `headers: clientVersionHeaders()`
(`:186-188`).

## 2. Producer identity (`src/shared/client-version.ts`)

Every kernel request carries `x-client-version`. `extensionClientVersion()`
returns `chatgoose-extension/<manifest version>` (`src/shared/client-version.ts:6-12`,
guarded so unit tests without a `browser` global fall back to
`chatgoose-extension/unknown`); `clientVersionHeaders()` wraps it as
`{ 'x-client-version': … }` (`:14-16`). Used by `kernel-feature-gateway.ts`,
`agency-hub-client.ts`, `device-token.ts`, and `acceptance-reporter.ts`. The
header comment (`:1-4`) states core's capture lane reads this as the producer
version.

## 3. Hub URL / identity helpers (`src/shared/agency-hub.ts`)

Pure helpers shared across the hub transport:
- `normalizeAgencyHubBaseUrl(value)` (`:9-26`): trims, requires `http:`/`https:`, strips a trailing slash-only path; returns `''` for anything invalid.
- `buildAgencyHubOriginPattern(baseUrl)` (`:28-36`): `<proto>//<host>/*` — the match pattern used for the optional host-permission check.
- `buildAgencyHubUrl(baseUrl, path)` (`:38-42`).
- `normalizeAgencyHubUsername(value)` (`:44-47`): lowercases, strips leading `@`.
- `measureUtf8Bytes(text)` (`:49-51`): the byte counter used for the 50 000-byte profile cap.
- Sync-metadata helpers `normalizeAgencyHubSummarySyncMetadata` / `isAgencyHubSummarySavedForBaseUrl` / `hasAgencyHubSyncMetadata` (`:53-102`): drive the fan-summary "already synced" dedup (see `07` and `14`).
- `AGENCY_HUB_PROFILE_MAX_BYTES = 50_000` (`:7`).

`resolveHubBearer(settings)` itself lives in `agency-hub-client.ts:56-61`:
**device token preferred, legacy chatter key (`agencyHubApiKey`) as fallback** —
"kernel dual-acceptance holds through the Stage 32 rollout window." Note the
callers are not uniform: `resolveHubBearer` is used by this gateway, the
acceptance reporter, `resolvePageLabelForUsername`, and `pageTopSpenders`, but
several `AgencyHubClient` data methods (`testConnection`, `pushFanProfile`,
`fetchFanProfileByConversation`, `aiUsageBatch`) authenticate with the legacy
`agencyHubApiKey` only (`agency-hub-client.ts:343,378,460,588`) — see
`07-background-storage-spenders-hub.md`.

## 4. Device-token sign-in (`src/background/device-token.ts`)

One-time issuance of a device-bound bearer (kernel Stage 22 adoption). The
chatter signs in once with username + password in the options page; the
extension trades the hub session for a device token
(`agency_hub_device_…`, sliding 90 days per the header comment `:1-13`) stored in
the settings record where the legacy chatter key lives (same `storage.local`
custody class). The legacy key stays accepted as a fallback.

`issueAgencyHubDeviceToken(input)` (`:35-86`):
1. Builds a **credentialed** fetch that forces `credentials: 'include'` (`:38-40`) — the browser's own cookie jar carries the hub session across login → issue → logout, because (per `:11-13`) `Set-Cookie` is a forbidden response header in this context and the session cookie cannot be read off the login response.
2. `createClient({ auth: { mode: 'cookie' }, headers: clientVersionHeaders(), fetch: credentialedFetch })` (`:42-47`).
3. `client.login({ body: { username, password } })` (`:50-52`) → `POST /api/v1/auth/login`; 401/403 → `ChatGooseError('hub_invalid_api_key', … 'Invalid username or password.')`, other errors → `hub_request_failed`.
4. `client.authIssueDeviceToken({ body: { label } })` (`:68`) → `POST /api/v1/auth/device-tokens`, returning `{ token, keyPrefix, label, expiresAt }` (`:69-74`).
5. `finally` best-effort `client.logout()` — never fails the issuance (`:82-85`).

`IssuedDeviceToken` (`:28-33`): `{ token, keyPrefix, label, expiresAt }`. The
`label` is shown in the owner's device-token admin list. Invoked from the
options page (`src/options/agency-hub-settings.ts`, see `11-options-popup.md`).

## 5. Acceptance telemetry (`src/background/acceptance-reporter.ts`)

Post-generation "did the chatter use it" signal. Events ride the kernel Stage 11
**capture lane** (`POST /api/v1/ingest/observations`, `kind: 'ai_acceptance'`)
rather than a bespoke endpoint (`:1-4, 154`). Wired in `src/background/index.ts:31-45`
against `browser.storage.local` and emitted by `OperationCoordinator` /
overlay actions (see `03` and `09`).

### Event & correlation

`AcceptanceEventInput` (`:27-36`): `operationId` (= gateway `clientRequestId`),
`requestId` (the meta-frame generation ref; **null when the meta never arrived**,
`:29`), `feature`, `action` (`AcceptanceAction = 'shown' | 'copied' | 'inserted'`,
`:25`), `pageLabel`, `conversationRef`, `at` (ISO). Wire mapping `toWireEvent`
(`:64-80`): payload carries `operationId`, and when present both `requestId` and
`generationRef` (`:71-73`), `feature`, `action`, `pageLabel`, and
`conversationId` (= `conversationRef`). Each spooled event gets a
`clientEventId = crypto.randomUUID()` at enqueue, reused on resends as the
kernel-side dedup key (`:38-42, 189`).

### Spool semantics (deliberately unlike the desktop's never-drop spool)

Storage-local spool, **bounded drop-oldest** with a persisted dropped counter so
the gap stays visible (`:1-10, 18-23`): `ACCEPTANCE_SPOOL_KEY = 'acceptanceSpool'`,
`ACCEPTANCE_DROPPED_KEY = 'acceptanceSpoolDropped'`, `SPOOL_CAP = 300`,
`BATCH_MAX = 100`, `FLUSH_DEBOUNCE_MS = 1000`, `MAX_ATTEMPTS = 5`. Enqueue
overflow trims the oldest and increments the dropped counter (`:187-196`).
Read-modify-writes are serialized through a `writeQueue` promise chain so rapid
enqueues/flushes cannot lose an update (`:87-99`).

### Flush (`flush`, `:137-180`)

Debounced. Resolves a bearer-auth SDK client via `clientFor()` (`:122-135`);
returns early (spool waits) when the hub is unconfigured. Sends batches of ≤100
via `client.ingestObservations(...)`. Delivery is **telemetry-grade, not
custody-grade**: a `KernelApiError` status **400** drops the batch loudly
(logs, advances the spool — never retried verbatim, `:157-161`); transient
errors bump per-event `attempts`, drop events past `MAX_ATTEMPTS`, and reschedule
(`:162-174`). `flushNow()` and `stats()` (pending + lifetime-dropped) support
diagnostics (`:198-209`).

## 6. Boundary summary (from this side)

Everything here crosses one boundary: the kernel / Agency Hub HTTP API at the
user-configured `agencyHubBaseUrl`, authenticated with a bearer (device token or
legacy chatter key) or, for sign-in only, a cookie session. Outbound requests
originated by this layer:

| Purpose | Kernel operation (method + path) | Sends | Receives |
|---|---|---|---|
| AI generation | `aiFeatureStream` `POST /api/v1/ai/features/:feature` (SSE) | feature, clientRequestId, pageLabel, platform=fansly, conversationRef, tone/mode/persona/draft/isRegeneration, clientContext (transcript + fan display values) | SSE frames: meta, content_delta, reasoning_delta, usage, done, error |
| Sign-in | `login` `POST /api/v1/auth/login` | username, password (cookie session) | session cookie |
| Token issue | `authIssueDeviceToken` `POST /api/v1/auth/device-tokens` | label | token, keyPrefix, label, expiresAt |
| Sign-out | `logout` `POST /api/v1/auth/logout` | — | — |
| Acceptance | `ingestObservations` `POST /api/v1/ingest/observations` | batch of `ai_acceptance` events (operationId, requestId/generationRef, feature, action, pageLabel, conversationId) | ack |

The transcript, fan display name, and earnings/subscription strings are the
substantive fan data leaving the browser for the kernel; no raw Fansly
credentials cross this boundary (those stay in `SessionStore`, used only against
Fansly — see `02`/`06`).
