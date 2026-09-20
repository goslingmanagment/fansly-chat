> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# 15 — The vendored `@kernel/sdk` (compiled contract surface)

`vendor/kernel-sdk/` is a self-contained compiled snapshot of the core repo's
`packages/sdk` (plus its contracts runtime), produced by core's
`scripts/vendor-sdk.mjs`. It is the extension's only sanctioned way to reach the
kernel/core backend: it carries the operation manifest, the request/response
Zod schemas, the SSE stream helpers, and the frozen contract hash. The
extension's `package.json` wires it in as a local link — `"@kernel/sdk":
"link:./vendor/kernel-sdk"` (`package.json:38`) — so every `import … from
'@kernel/sdk'` resolves to this vendored directory.

## What the vendored SDK is + how it is pinned

- The vendored package identity: `name` `@kernel/sdk`, `version` `0.1.0`,
  `private: true`, `type: module`, one export map entry `.` →
  `dist/index.js` / `dist/index.d.ts`, single runtime dependency `zod ^4.1.5`
  (`vendor/kernel-sdk/package.json:2-15`).
- The pin lives in `vendor/kernel-sdk/kernel-sdk.vendor.json`:
  - `contractHash`:
    `e8c867e8861a47a3b781a6c1ba634f99542d439a46d61effb8637e495787baae`
    (`kernel-sdk.vendor.json:2`)
  - `sourceCommit`: `cedb00a6340b1e846bfe0a16ce3e38db3c9f74de`
    (`kernel-sdk.vendor.json:3`)
  - `source`: `core scripts/vendor-sdk.mjs` (`kernel-sdk.vendor.json:4`)
- The same hash and commit are echoed in `vendor/kernel-sdk/README.md:12-13`,
  which states the file is GENERATED (do not edit) and is regenerated from the
  core repo root with `node scripts/vendor-sdk.mjs <path-to-this-directory>`
  (`README.md:3-10`). The README also notes the contract hash is exported at
  runtime as `KERNEL_CONTRACT_HASH` and that drift CI compares it against
  core@main (`README.md:15-18`).
- The runtime constants are declared in `dist/meta.d.ts`:
  `KERNEL_CONTRACT_HASH = "e8c867e8…787baae"` (`dist/meta.d.ts:2`) and
  `KERNEL_SDK_VERSION = "0.1.0"` (`dist/meta.d.ts:3`). The hash is described in
  its doc comment as "sha256 over the normalized OpenAPI document — the
  cross-repo drift key" (`dist/meta.d.ts:1`).

## Public API surface (`dist/index.d.ts`)

The package's single entry (`dist/index.d.ts`) re-exports from
`./contracts/index` and `./operations` / `./meta`:

- Client construction: `createClient(options: KernelClientOptions):
  KernelClient` (`dist/index.d.ts:6`), plus the lower-level
  `createKernelClient` and `executeKernelRequest`
  (`dist/index.d.ts:2`, `dist/contracts/index.d.ts:85-93`).
- SSE / streaming helpers (`dist/index.d.ts:3`): `streamAiFeature`,
  `streamAiGateway`, `subscribeSyncEvents`, `subscribeDomainEvents`,
  `ofapiRead`, `decodeDomainEventCursor`, and the raw `routeSchemas`.
- Manifest + metadata: `kernelOperations` (`dist/index.d.ts:4`),
  `KERNEL_CONTRACT_HASH`, `KERNEL_SDK_VERSION` (`dist/index.d.ts:5`).
- Error class and the excluded-op list: `KernelApiError`,
  `SDK_EXCLUDED_OPERATIONS` (`dist/index.d.ts:2`).
- Types (`dist/index.d.ts:2-3`): `KernelClient`, `KernelClientOptions`,
  `KernelErrorCategory`, `KernelOperationDef`, `KernelOperationKey`,
  `KernelOperationRequest`, `KernelOperationResponse`, `KernelSdkMethodKey`,
  `AiGatewayStreamFrame`, `DomainEventFrame`, `DomainEventsSnapshotRequired`,
  `KernelStreamHandle`, `SyncEvent`, `SyncSnapshotRequired`.

### `KernelClient` shape

`KernelClient` is a mapped type (`dist/contracts/index.d.ts:44-58`): one method
per non-excluded operation key, whose input is `KernelOperationRequest<K>`
(a `{ params }`/`{ query }`/`{ body }` object assembled from the operation's Zod
schema) and whose output is the parsed `KernelOperationResponse<K>`. Operations
with no request fields are callable with no arguments. There is one additional
member, `raw(key, input?): Promise<Response>` — the escape hatch that can send
any operation (including the excluded ones) with the manifest method/path and
the client's auth plumbing, returning the unvalidated `Response`
(`dist/contracts/index.d.ts:46-57`).

### `KernelApiError` categories

`KernelApiError extends Error` (`dist/contracts/index.d.ts:60-66`) carries
`category: KernelErrorCategory`, `status: number | null`, `code: string | null`,
and `body: unknown`. The category union
(`dist/contracts/index.d.ts:59`) is:
`auth`, `validation`, `not_found`, `conflict`, `rate_limit`, `server`,
`network`, `contract`.

### `AiGatewayStreamFrame` variants

`AiGatewayStreamFrame = z.infer<typeof aiGatewayStreamFrameSchema>`
(`dist/contracts/routes.d.ts:19985`). The schema is a discriminated union on
`type` (`dist/contracts/routes.d.ts:3745-3798`) with six variants:

| `type` | payload | source |
|---|---|---|
| `meta` | `requestId`, `clientRequestId`, `feature` (the nine AI features), `pageLabel`, `model`, `provider` (`anthropic`/`openrouter`), `providerResponseId`, `quota` (`accepted`, `remainingRequestsToday`, `remainingMicroUsdToday`) | `routes.d.ts:3746-3771` |
| `content_delta` | `text` | `routes.d.ts:3773-3774` |
| `reasoning_delta` | `text` | `routes.d.ts:3776-3777` |
| `usage` | `usage` (`inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `costMicroUsd`, `costApproximate`), `providerResponseId`, `cacheHit` | `routes.d.ts:3779-3789` |
| `error` | `code`, `message`, `retryAfterMs` | `routes.d.ts:3791-3794` |
| `done` | `stopReason` | `routes.d.ts:3796-3797` |

Both `streamAiFeature` and `streamAiGateway` deliver these frames to an
`onFrame(frame: AiGatewayStreamFrame)` callback and return a
`KernelStreamHandle` — `{ done: Promise<void>; close: () => void }`
(`dist/contracts/sdk-runtime.d.ts:96-100, 123-133`). `streamAiFeature` targets
`POST /api/v1/ai/features/:feature` (kernel Stage 30), `streamAiGateway` targets
`POST /api/v1/ai/gateway/stream`; both share the `event: ai` SSE framing
(`dist/contracts/sdk-runtime.d.ts:117-133`).

## Auth modes (`KernelClientOptions`)

`KernelClientOptions` (`dist/contracts/index.d.ts:67-84`):

- `baseUrl: string` — required.
- `auth?` — a union of exactly two modes:
  - `{ mode: "cookie" }` (`dist/contracts/index.d.ts:70`): the browser's own
    cookie jar carries the session; requests must ride `credentials: 'include'`
    via a custom `fetch`.
  - `{ mode: "bearer"; token: () => string | Promise<string> }`
    (`dist/contracts/index.d.ts:71-73`): a lazy token thunk resolved per
    request into the `Authorization` header.
- `headers?` — extra headers on every request.
- `fetch?` — a `fetch` override (the seam the extension uses to inject its
  own credential/abort/version plumbing).
- `onAuthError?(error, operation)` — invoked on every 401/403 before the error
  is thrown; the operation key (or `null` for raw/stream) lets a failed `login`
  be distinguished from an expired session (`dist/contracts/index.d.ts:78-83`).

How the extension picks a mode:

- Cookie mode is used only for one-time device-token issuance: the options page
  logs in with username+password, and because Set-Cookie is a forbidden
  response header in the browser, every call rides `credentials: 'include'`
  (`src/background/device-token.ts:39-47`, header comment at
  `device-token.ts:9-13`).
- Bearer mode is used everywhere else. The bearer is resolved by
  `resolveHubBearer(settings)` (device token preferred, legacy chatter key as
  fallback) and threaded through `token: () => bearer`
  (`src/background/agency-hub-client.ts:150-157`,
  `src/background/acceptance-reporter.ts:129-134`,
  `src/background/kernel-feature-gateway.ts:184-189`).

## Full operation surface (`dist/operations.d.ts`)

`kernelOperations` is a frozen map of `{ method, path }` per operation key
(`dist/operations.d.ts:1-598`). It contains **149** operations. Of those, six
have no plain JSON request/response shape and are enumerated in
`SDK_EXCLUDED_OPERATIONS` (`dist/contracts/index.d.ts:15`) — `ofapiWebhookReceive`
(HMAC server intake), `eventsStream`, `eventsV2Stream`, `aiGatewayStream` (SSE,
served by dedicated helpers), `ofapiReadGateway` (wildcard proxy), and
`adminOfapiCreditsLedgerCsv` (text/csv). They are not client methods but remain
reachable through `client.raw(...)`. The callable `KernelClient` therefore
exposes 149 − 6 = **143** typed methods (`KernelSdkMethodKey` =
`Exclude<KernelOperationKey, KernelSdkExcludedKey>`,
`dist/contracts/index.d.ts:16-17`).

Notable groups (by key prefix / path):

- `admin*` — ~52 owner-console operations: users, pages, models, API keys,
  device tokens, config (incl. staged flips), sync blocks/runs, proxy tests,
  notifications, and the OFAPI credits/webhook admin surface
  (`dist/operations.d.ts:2-209`).
- `ai*` — 8 gateway/persona operations: `aiFeatureStream`, `aiGatewayStream`,
  persona list/upsert/archive, restricted-generation read routes, `aiUsageBatch`
  (`dist/operations.d.ts:210-241`).
- `page*` — ~23 per-page read/write routes: conversations, fans, profiles
  (+ versions), transactions, revenue/subscribers/followers dailies, sync
  blocks, spender autolists, `pageTopSpenders`
  (`dist/operations.d.ts:418-505`).
- `spenders`/`spender*` — 4 v2 spender routes (list, batch, detail, series)
  under `/api/v2/spenders` (`dist/operations.d.ts:514-529`).
- `*ofapi*` — ~14–17 OnlyFans-API routes (credits ledger/summary/daily, webhook
  register/status, read gateway, commands create/get/cancel), spanning both
  `admin/ofapi/*` and `ofapi/*` paths (`dist/operations.d.ts:94-125, 258-268,
  378-389`).
- `notifications*` (~9), `overview*` (~5), plus cross-page fan/transaction
  routes, archive search, events snapshots/streams, health, and auth
  (`login`, `logout`, `me`, `authChangePassword`, `authIssueDeviceToken`).

## Operations the extension actually uses

Despite the 143-method surface, the ChatGoose Firefox extension calls only nine
typed operations plus the one `streamAiFeature` helper. Every call site is in
`src/background/`:

| SDK member | Kernel route | Call site |
|---|---|---|
| `client.login` | `POST /api/v1/auth/login` | `src/background/device-token.ts:50` |
| `client.authIssueDeviceToken` | `POST /api/v1/auth/device-tokens` | `src/background/device-token.ts:68` |
| `client.logout` | `POST /api/v1/auth/logout` | `src/background/device-token.ts:84` |
| `client.pages` | `GET /api/v1/pages` | `src/background/agency-hub-client.ts:198` |
| `client.pageConversationProfile` | `GET /api/v1/pages/:pageLabel/conversations/:conversationId/profile` | `src/background/agency-hub-client.ts:234` |
| `client.upsertFanProfile` | `PUT /api/v1/pages/:pageLabel/fans/:platformUserId/profile` | `src/background/agency-hub-client.ts:255` |
| `client.aiUsageBatch` | `POST /api/v1/ai-usage/batch` | `src/background/agency-hub-client.ts:271` |
| `client.pageTopSpenders` | `GET /api/v1/pages/:pageLabel/top-spenders` | `src/background/agency-hub-client.ts:319` |
| `client.ingestObservations` | `POST /api/v1/ingest/observations` | `src/background/acceptance-reporter.ts:154` |
| `streamAiFeature(...)` | `POST /api/v1/ai/features/:feature` (SSE) | `src/background/kernel-feature-gateway.ts:183` |

Notes on the usages:

- `device-token.ts` runs the one-time cookie-mode ceremony: `login` →
  `authIssueDeviceToken` → `logout` (best-effort in a `finally`), trading a
  username/password session for a device-bound bearer
  (`src/background/device-token.ts:42-85`).
- `agency-hub-client.ts` builds a per-call bearer client via `sdkFor(...)`
  (`src/background/agency-hub-client.ts:150-157`) and maps `KernelApiError`
  back onto the extension's `ChatGooseError` keys — 404 from
  `pageConversationProfile` is treated as a domain "unknown" result, not an
  error (`src/background/agency-hub-client.ts:239-241`).
- `kernel-feature-gateway.ts` is the extension's only post-cutover AI transport
  (`src/background/kernel-feature-gateway.ts:1-9`). It consumes
  `AiGatewayStreamFrame` frames — handling `meta`/`content_delta`/
  `reasoning_delta`/`usage`/`done`
  (`kernel-feature-gateway.ts:148-181`) — and fails closed if the stream ends
  without the terminal `done` frame (`kernel-feature-gateway.ts:226-232`).
- `acceptance-reporter.ts` batch-posts observation events via
  `ingestObservations`; a 400 is treated as a non-retriable contract bug and
  the batch is dropped (`src/background/acceptance-reporter.ts:154-161`).

`KernelApiError` is imported and switched on at all four call sites
(`device-token.ts:15`, `agency-hub-client.ts:1`,
`kernel-feature-gateway.ts:11`, `acceptance-reporter.ts:12`). No other SDK
export (`streamAiGateway`, `subscribeSyncEvents`, `subscribeDomainEvents`,
`ofapiRead`, `kernelOperations`, `client.raw`, `routeSchemas`) is referenced
from `src/`.

## Shared types re-exported by the SDK (`dist/shared/*`)

`dist/shared/index.d.ts` re-exports three modules (`dist/shared/index.d.ts:1-3`):

- `types` (`dist/shared/types.d.ts`): platform/transaction enums and helpers —
  `platforms` (`fansly`, `onlyfans`), `transactionTypes`,
  `transactionClassificationByType`, `userRoles`, `creatableUserRoles`,
  `fanFlagTypes`, `aiUsageFeatures` (the nine features, `types.d.ts:61`),
  `FanslySessionBundle` / `OnlyMonsterTokenBundle` /
  `StoredPlatformCredentialBundle`, and the HTTP-request telemetry event types.
- `time` (`dist/shared/time.d.ts`): timezone constants
  (`Europe/Moscow`, `UTC`), the `Period` / `SpenderPeriod` /
  `SpenderSeriesGranularity` option sets, and business-date / period-bounds
  resolvers (`time.d.ts:2-90`).
- `spender-retention` (`dist/shared/spender-retention.d.ts`): the retention
  status set (`all`, `active`, `cooling`, `inactive`, `needs_reactivation`),
  the day thresholds (`ACTIVE_DAYS = 14`, `INACTIVE_DAYS = 45`), the
  reactivation lifetime-net threshold (`100000` mills), and `classifyRetention`
  (`spender-retention.d.ts:1-11`).

## The drift gate

Two mechanisms keep the vendored snapshot honest, both inside `pnpm check`
(`package.json:13` — `typecheck && lint && gates && test && build`):

- Runtime pin, `tests/kernel-sdk-vendor.test.ts`: it imports
  `KERNEL_CONTRACT_HASH`, `KERNEL_SDK_VERSION`, `createClient`,
  `kernelOperations` from `@kernel/sdk` and the JSON manifest, then asserts the
  exported hash is 64 hex chars, that `vendorManifest.contractHash ===
  KERNEL_CONTRACT_HASH` (`kernel-sdk-vendor.test.ts:11-13`), that a bearer
  `createClient(...)` returns an object, and that `kernelOperations` holds
  more than 100 keys (`kernel-sdk-vendor.test.ts:16-24`). Its header comment
  records that this test replaced the Stage-20 standalone
  `check-kernel-contract.mjs` (`kernel-sdk-vendor.test.ts:1-3`).
- Typecheck: because every used SDK method is fully typed from the vendored
  `routeSchemas`, `tsc --noEmit` (`package.json:18`) fails if a call site
  diverges from the pinned request/response shapes.
