> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Background: storage mirror, spenders board, Agency Hub client

This map covers three background-service units in the ChatGoose Firefox
extension and the one inter-project boundary they cross:

- `src/background/storage-coordinator.ts` — an in-memory mirror of
  `storage.local` that every other background unit reads through.
- `src/background/spenders-service.ts` — the ranked top-spenders board, now
  fed by a single kernel query with a hidden legacy Fansly-scan fallback.
- `src/background/agency-hub-client.ts` + `src/shared/agency-hub.ts` — the
  Agency Hub ("core" kernel) boundary: every kernel operation the extension
  calls, via the vendored `@kernel/sdk` (`createClient`), documented per
  operation below.

The kernel-side SDK contract these calls resolve against is pinned in
`vendor/kernel-sdk/kernel-sdk.vendor.json`
(`contractHash: e8c867e8…`, `sourceCommit: cedb00a6…`); the SDK itself is
documented in `15-vendor-kernel-sdk.md`.

---

## StorageCoordinator (`src/background/storage-coordinator.ts`)

### Mirror model

`StorageCoordinator` holds a single materialized `PersistedState` object in
`private state` (`storage-coordinator.ts:37`) and hands the same reference to
every caller through `getState()`. `PersistedState`
(`src/shared/types.ts:101-108`) is `{ schemaVersion, settings, personalities,
accountMappings, accountAliases, knownAccounts }`. The mirror is the read
source for background units — e.g. the composition root's `getSettings`
closures pull `(await storageCoordinator.getState()).settings`
(`src/background/index.ts:27,35`).

`init()` is a thin alias for `getState()` (`storage-coordinator.ts:54-56`).

### Lazy load with in-flight dedup

`getState()` returns the cached `state` if present; otherwise it starts exactly
one `loadStorageState()` load, memoized in `loadingState` so concurrent callers
share one promise, and clears `loadingState` in `.finally`
(`storage-coordinator.ts:58-75`). `loadStorageState` lives in
`src/shared/storage.ts` (imported at `storage-coordinator.ts:7`).

### Applying `storage.local` change events

`applyStorageChanges(changes, areaName)` (`storage-coordinator.ts:77-100`) is
the `browser.storage.onChanged` sink. It early-returns unless
`areaName === 'local'` **and** the mirror is already loaded (`this.state`
truthy) — changes that arrive before the first load are dropped, not queued
(`storage-coordinator.ts:81`). It splits each change into `setItems`
(`change.newValue !== undefined`) and `removeKeys` (`change.newValue ===
undefined`, i.e. deletions), and no-ops when both are empty
(`storage-coordinator.ts:87-97`).

All raw patches run through `applyRawStoragePatch(state, setItems, removeKeys)`
(`storage-coordinator.ts:18-34`): it spreads `setItems` over the current
`state`, deletes `removeKeys`, then runs `migrateState(raw)`
(`src/shared/migrations.js`), re-sanitizes `settings` via `sanitizeSettings`,
and backfills `schemaVersion` to `STORAGE_SCHEMA_VERSION` (currently `10`,
`src/shared/constants.ts:10`) when absent. So the mirror is always a migrated,
sanitized state — never the raw stored bytes.

### Known-account tracking (`knownAccounts` key)

The stored key name is `KNOWN_ACCOUNTS_KEY = 'knownAccounts'`
(`src/shared/constants.ts:12`).

- `registerKnownAccount(accountId)` (`storage-coordinator.ts:102-117`):
  no-ops on empty id or when already present; otherwise appends, sorts, writes
  to `browser.storage.local`, and mirrors the write via `commitLocalWrite`.
- `reconcileKnownAccounts(activeCanonicalAccountIds)`
  (`storage-coordinator.ts:119-138`): unions the active canonical ids (empties
  filtered) with `Object.keys(state.accountMappings)`, sorts, and writes only
  when the set actually changed (`arraysEqual`, `storage-coordinator.ts:14-16`).
- `rekeyAccountIdentity(legacyAccountId, resolvedAccountId)`
  (`storage-coordinator.ts:140-220`): records an alias
  (`accountAliases[legacy] = resolved`), migrates the `accountMappings` entry
  to the resolved id (or drops the legacy entry as a *conflict* when both ids
  already map), and rewrites `knownAccounts` (legacy id → resolved id, sorted,
  deduped). Returns `{ state, mappingMigrated, mappingConflict,
  knownAccountsChanged }`; writes to storage only when something changed.

### Summary cache delegation

The coordinator owns a `SummaryCacheStore`
(`storage-coordinator.ts:40-52`, from `src/shared/summary-cache.js`) whose
`afterSet`/`afterRemove` hooks call back into `commitLocalWrite` so the mirror
stays in step with cache writes. `getSummaryCache`, `saveSummaryCache`,
`updateSummaryCache`, `removeSummaryCache`
(`storage-coordinator.ts:222-246`) proxy to it. The `agencyHubSync` metadata
that the profile-push dedup reads (below) is carried inside these
`SummaryCacheEntry` records (`src/shared/types.ts:89-99`).

### Write serialization

Every mutating path runs inside `enqueueWrite(task)`
(`storage-coordinator.ts:260-267`), which chains tasks onto a single
`writeQueue` promise (each `task` runs whether the previous settled or
rejected). The storage-coordinator test verifies this: concurrent
`registerKnownAccount` calls never drop entries
(`tests/storage-coordinator.test.ts:91`). `commitLocalWrite(setItems,
removeKeys)` (`storage-coordinator.ts:248-258`) is the private mirror-update
helper that re-runs `applyRawStoragePatch` and returns the new state (or `null`
if the mirror is not yet loaded).

---

## SpendersService (`src/background/spenders-service.ts`)

The ranked top-spenders board. Two build paths converge in
`getList(session, signal, options?)` (`spenders-service.ts:75-102`); which one
runs is decided by a hidden setting.

### Path selection — `spendersLegacyRebuild`

`useKernel` is true only when a `kernelSource` was injected, settings loaded,
and `settings.spendersLegacyRebuild === false`
(`spenders-service.ts:91-98`). `spendersLegacyRebuild`
(`src/shared/types.ts:22-25`) is a hidden, UI-less boolean (default `false`)
flipped only via storage; when `true` it forces `buildLegacy`. Its documented
role is a one-release diagnostic fallback that is deleted next release. When no
`kernelSource`/`getSettings` was supplied at all (e.g. bare unit tests,
`tests/spenders-service.test.ts:60`), the legacy path also runs.

### Kernel path — `buildFromKernel` (`spenders-service.ts:104-155`)

1. Resolve the signed-in creator's kernel page label:
   `kernelSource.resolvePageLabelForUsername(settings,
   session.resolvedUsername?.trim() || null, signal)`
   (`spenders-service.ts:110-115`). A null label throws
   `ChatGooseError('hub_page_match_failed')`.
2. Run **one** bounded Fansly conversations enumeration —
   `fanslyClient.listFanAccounts(SPENDERS_MAX_FANS, session, signal)`
   (`SPENDERS_MAX_FANS = 150`, `src/shared/constants.ts:44`) — to build the
   `fan → groupId` map (`groupByFanId`, `spenders-service.ts:122-127`). This is
   the only Fansly read that remains; it exists because the board needs
   `groupId` to open a chat, which the kernel snapshot does not carry.
3. Fetch the ranking in one call:
   `kernelSource.fetchTopSpenders(settings, pageLabel, SPENDERS_MAX_FANS,
   signal)` (`spenders-service.ts:129-134`).
4. Intersect: keep only kernel entries whose `platformUserId` appears in
   `groupByFanId` (`spenders-service.ts:136-137`) — a kernel-ranked fan with no
   open Fansly conversation is dropped. Map each to a `SpenderListEntry`
   (`src/shared/types.ts:733-743`): `lifetimeMills = grossMills`,
   `lifetimeUsd = grossMills / 1000` (`spenders-service.ts:138-145`).

The returned `SpendersListResult` (`src/shared/types.ts:745-755`) sets
`builtAt` to the projection's freshest observation —
`Date.parse(snapshot.builtAt)` when non-null, else `nowMs`
(`spenders-service.ts:150`) — i.e. honest staleness, not "now". `fanCount` is
the **post-intersection** entry count (`entries.length`, not
`snapshot.fanCount`), `scannedCount = fans.length`, and `truncated` comes from
`listFanAccounts` (`spenders-service.ts:147-154`).

### Legacy path — `buildLegacy` (`spenders-service.ts:159-214`)

The pre-cutover rebuild: enumerate fans (same bounded `listFanAccounts`), then
fan out `fetchLifetimeMills` per fan at `SPENDERS_EARNINGS_CONCURRENCY = 4`
(`src/shared/constants.ts:46`) via `mapWithConcurrency`. Each per-fan fetch
swallows every error — including aborts — and returns `0`
(`fetchLifetimeMills`, `spenders-service.ts:222-234`), so an abandoned worker
cannot reject the batch; a real timeout is re-detected by checking
`signal.aborted` **after** the fan-out settles and re-thrown as an
`AbortError` (`spenders-service.ts:182-184`). Fans with `> 0` lifetime are kept,
names resolved in batches of `ACCOUNT_NAME_BATCH = 50`
(`spenders-service.ts:32,236-259`; name failures are cosmetic and swallowed
unless they are aborts), and entries are sorted descending by `lifetimeMills`.
`builtAt` here is `nowMs` (`spenders-service.ts:209`).

### Cache

An in-memory `Map` keyed by `session.resolvedAccountId ?? session.accountId`
(`cacheKey`, `spenders-service.ts:71-73`). A cached result is served when
`now - cached.builtAt < SPENDERS_CACHE_TTL_MS` (`10 * 60 * 1000` = 10 min,
`src/shared/constants.ts:48`) and `options.refresh` is not set
(`spenders-service.ts:83-88`). Note the cache-entry `builtAt` is the wall-clock
build time (`now` at store, `spenders-service.ts:100`), distinct from the
result's honest `builtAt`. Because `getList` throws before caching on abort,
an aborted build never poisons the cache
(`tests/spenders-service.test.ts:103-110`). `invalidate(session)`
(`spenders-service.ts:261-263`) drops one key.

### Injection

`SpendersService` receives the kernel source as a small
`SpendersKernelSource` interface (`spenders-service.ts:39-56`), not the whole
client. The composition root wires it to `AgencyHubClient`
(`src/background/index.ts:19-28`): `resolvePageLabelForUsername` and
`fetchTopSpenders` are thin forwarders, and `getSettings` reads the storage
mirror.

---

## AgencyHubClient — the Agency Hub / core boundary (`src/background/agency-hub-client.ts`)

Post-1.6.0 the client speaks to the kernel **only** through the vendored SDK's
`createClient` (`@kernel/sdk`, `agency-hub-client.ts:1`); there is no
hand-rolled `fetch` or `as` casting left — the SDK contract-validates every
response.

### The per-call SDK seam — `sdkFor` (`agency-hub-client.ts:150-157`)

Every operation builds a fresh client bound to one call:

```
createClient({
  baseUrl: baseUrl.replace(/\/+$/, ''),           // trailing slashes stripped
  auth: { mode: 'bearer', token: () => bearer },  // Authorization: Bearer <bearer>
  headers: clientVersionHeaders(),                // x-client-version
  fetch: (input, init) => this.fetchImpl(input, { ...init, signal }),
})
```

The `AbortSignal` and bearer ride the fetch seam because the vendored SDK has
no per-operation signal parameter (`agency-hub-client.ts:147-149`).
`clientVersionHeaders()` sends `x-client-version:
chatgoose-extension/<manifest.version>` (`src/shared/client-version.ts:6-16`) —
the extension's producer identity on every kernel request. The injectable
`fetchImpl` (constructor default is `globalThis.fetch`,
`agency-hub-client.ts:117-121`) is what tests stub.

### Auth: `resolveHubBearer` vs. raw chatter key

`resolveHubBearer(settings)` (`agency-hub-client.ts:56-61`, exported) returns
the trimmed `agencyHubDeviceToken` when present, else the trimmed
`agencyHubApiKey` (the legacy chatter key) — kernel dual-acceptance holds
through the Stage 32 rollout (`tests/device-token.test.ts:15-23`).

The actual code does **not** apply this preference uniformly. Only the two
Stage 32 feature-lane operations send `resolveHubBearer`:

| Client method | Bearer sent |
|---|---|
| `resolvePageLabelForUsername` (`agency-hub-client.ts:288`) | `resolveHubBearer(settings)` — device token preferred |
| `fetchTopSpenders` (`agency-hub-client.ts:314`) | `resolveHubBearer(settings)` — device token preferred |
| `testConnection` (`agency-hub-client.ts:343`) | `settings.agencyHubApiKey.trim()` only |
| `submitAiUsageBatch` (`agency-hub-client.ts:378`) | `settings.agencyHubApiKey.trim()` only |
| `pushFanProfile` (`agency-hub-client.ts:460`) | `settings.agencyHubApiKey.trim()` only |
| `fetchFanProfileByConversation` (`agency-hub-client.ts:588`) | `settings.agencyHubApiKey.trim()` only |

So a device token alone (no `agencyHubApiKey`) authorizes the spenders board
and page-label lookup but **not** profile push/fetch, AI-usage batch, or the
connection test — those still require the legacy chatter key. `isConfigured`
(`agency-hub-client.ts:123-128`) uses `resolveHubBearer`, so a device-token-only
install reports configured while those apiKey-only routes would skip on
`missing_api_key`.

### Host-permission gating — `hasHostPermission` (`agency-hub-client.ts:130-145`)

Builds the origin pattern via `buildAgencyHubOriginPattern(baseUrl)` and calls
`browser.permissions.contains({ origins: [pattern] })`. If
`browser.permissions.contains` is not a function it returns `true` (permissive
unit-test path, `agency-hub-client.ts:136-138`); any thrown error returns
`false`. Which methods gate:

- `resolvePageLabelForUsername` → returns `null` when the permission is absent
  (`agency-hub-client.ts:289`).
- `testConnection` → `hub_missing_permission` (`agency-hub-client.ts:351-353`).
- `submitAiUsageBatch` / `pushFanProfile` / `fetchFanProfileByConversation` →
  `status: 'skipped', reason: 'missing_host_permission'`
  (`agency-hub-client.ts:408-414, 478-485, 606-613`).
- `fetchTopSpenders` does **not** check host permission itself
  (`agency-hub-client.ts:313-322`) — in the spenders flow the check happens
  earlier, inside `resolvePageLabelForUsername`.

### Per-operation catalogue (SDK method → HTTP)

All routes are kernel `/api/v1/…`; auth `kind` is the route's declared
principal class in `vendor/kernel-sdk/dist/contracts/routes.d.ts`.

**`pages()` — `GET /api/v1/pages`** (auth `kind: "any"`, routes.d.ts:10933-10967)
Called via private `listVisiblePages` (`agency-hub-client.ts:192-202`). No
request body/params. The 200 response is an array of page objects
(`id, label, platform, modelSlug, modelName, username, displayName,
followerCount, subscriberCount, lastLightSyncAt, lastFollowerSyncAt`); the
client narrows it to `{ label, platform, username }` (`AgencyHubPageSummary`,
`agency-hub-client.ts:26-30`) and consumes only those three. This is the join
lookup behind page-label resolution, `testConnection`, `pushFanProfile`, and
`fetchFanProfileByConversation`.

**`pageConversationProfile({ params: { pageLabel, conversationId } })` —
`GET /api/v1/pages/:pageLabel/conversations/:conversationId/profile`**
(auth `kind: "any", scope: "page"`, routes.d.ts:12311-12360)
Called via `getConversationProfile` (`agency-hub-client.ts:226-244`). Response
`{ fan: { platform, platformUserId, username, displayName, createdAtExternal,
pageAlias }, profile: { version, body, source: 'chatmuse', createdAt,
createdByUserId } | null }`. A `404` is treated as a domain result — the method
returns `null` rather than throwing (`agency-hub-client.ts:239-241`). The
public wrapper `fetchFanProfileByConversation` consumes `profile.body` (trimmed),
`profile.createdAt` (parsed to `createdAtMs` when finite), and
`fan.platformUserId` (→ `fanAccountId`) (`agency-hub-client.ts:656-698`).

**`upsertFanProfile({ params: { pageLabel, platformUserId }, body: { body } })`
— `PUT /api/v1/pages/:pageLabel/fans/:platformUserId/profile`**
(auth `kind: "any", scope: "page"`, routes.d.ts:12362-12385)
Called via `putFanProfile` (`agency-hub-client.ts:246-262`). Request body is a
single `{ body: string }` (`upsertFanProfileBodySchema`, routes.d.ts:3554-3556);
the response (a new profile version record) is not consumed — the wrapper only
reports `status: 'pushed'`.

**`aiUsageBatch({ body: { events } })` — `POST /api/v1/ai-usage/batch`**
(auth `kind: "apiKey"`, **`deprecated: true`** "gateway ledger is
authoritative", routes.d.ts:9592-9598)
Called via `postAiUsageBatch` (`agency-hub-client.ts:264-277`). Each event is
`{ clientEventId, feature, model, inputTokens, outputTokens, cacheWriteTokens,
cacheReadTokens, conversationId?, durationMs?, isCacheHit, isRegeneration,
completedAt }` (`aiUsageBatchBodySchema`, routes.d.ts:3610-3635;
`AgencyHubAiUsageEvent`, `src/shared/types.ts:770-783`). Response
`{ receivedCount, insertedCount, invalidCount, dedupedCount }`
(routes.d.ts:3636-3641); the client's mirror type
(`AgencyHubAiUsageBatchResponse`, `src/shared/types.ts:785-789`) omits
`invalidCount`. The `apiKey` auth kind matches this method sending only
`agencyHubApiKey`. The batch is capped at
`AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS = 100`
(`src/shared/constants.ts:99`); an over-cap batch returns `status: 'failed',
reason: 'too_many_events'` (`agency-hub-client.ts:401-407`).

**`pageTopSpenders({ params: { pageLabel }, query: { window: 'lifetime',
limit } })` — `GET /api/v1/pages/:pageLabel/top-spenders`**
(auth `kind: "any", scope: "page"`, routes.d.ts:11870-11914)
Called directly in `fetchTopSpenders` (`agency-hub-client.ts:298-336`). The
`window` query is hard-coded to `'lifetime'` and `limit` is passed through
(the SpendersService supplies `SPENDERS_MAX_FANS = 150`). The 200 response is
`{ window, builtAt: string|null, fanCount, entries: [{ platformUserId,
username, displayName, grossMills, netMills, currency, observedAt }] }`; the
client keeps `builtAt`, `fanCount`, and per-entry `{ platformUserId, username,
displayName, grossMills }` (`agency-hub-client.ts:323-332`) — `netMills`,
`currency`, `observedAt` are dropped.

### Public wrapper results & error handling

The write/report wrappers never throw for expected conditions; they return a
tagged result extending `AgencyHubResultBase` (`agency-hub-client.ts:63-107`):
`pushFanProfile → 'pushed' | 'already-synced' | 'skipped' | 'failed'`,
`fetchFanProfileByConversation → 'fetched' | 'not-found' | 'skipped' |
'failed'`, `submitAiUsageBatch → 'submitted' | 'skipped' | 'failed'`. `skipped`
covers pre-flight gaps (missing base URL / api key / host permission / empty
body / empty batch). `testConnection` returns `{ ok, error? }`
(`src/shared/types.ts:765-768`), mapping an abort to `hub_timeout`
(`agency-hub-client.ts:359-361`).

By contrast the two feature-lane reads — `resolvePageLabelForUsername` and
`fetchTopSpenders` — do throw: the former returns `null` only for
missing-config / permission / no-match; `fetchTopSpenders` throws
`ChatGooseError('hub_missing_api_key')` when unconfigured
(`agency-hub-client.ts:315-317`) and rethrows mapped SDK errors.

### SDK-error mapping — `toHubError` (`agency-hub-client.ts:163-190`)

Callers do `throw this.toHubError(error)`. The mapping:

- `KernelApiError` with `category === 'network'`, `code === 'aborted'` →
  **throws** a fresh `DOMException(..., 'AbortError')`.
- `KernelApiError` `category === 'network'` (other) → **throws** a bare
  `Error(error.message)` so the message survives into a result `reason`.
- `KernelApiError` with `status` 401/403 → **returns**
  `ChatGooseError('hub_invalid_api_key')`; any other status → **returns**
  `ChatGooseError('hub_request_failed')`. Both carry
  `details: { status, responseSnippet: message.slice(0, 400) }`.
- An already-typed `ChatGooseError` or an `AbortError` `DOMException` is
  **rethrown** unchanged.
- Anything else → **returns** `ChatGooseError('hub_request_failed')`.

The wrappers then translate: an `AbortError` becomes `reason: 'aborted'` /
`hub_timeout`, a `ChatGooseError` becomes a user error via `toUserError`,
otherwise `hub_request_failed` (e.g. `agency-hub-client.ts:560-578`).
`tests/agency-hub-client.test.ts` pins the status codes: `401 →
hub_invalid_api_key` (CG-HUB-03), `503 → hub_request_failed` (CG-HUB-07),
missing permission → `hub_missing_permission` (CG-HUB-04).

---

## Page-label resolution — the join key (`agency-hub-client.ts:204-224`)

Every page-scoped kernel call needs a `pageLabel`, and the extension only knows
the signed-in creator's Fansly **username**. `resolvePageLabel(pages,
pageUsername)` is the join:

1. Normalize the target username via `normalizeAgencyHubUsername`
   (strip leading `@`, trim, lowercase; `src/shared/agency-hub.ts:44-47`);
   a null/empty result returns `null`.
2. Filter `pages` to those with `platform === 'fansly'` whose normalized
   `username` equals the target (`agency-hub-client.ts:213-216`) — OnlyFans
   pages are never matched.
3. Require **exactly one** match: `matches.length !== 1` → `null`
   (`agency-hub-client.ts:218-220`). Zero or ambiguous matches both fail.
4. Return the matched page's trimmed `label`, or `null` if blank.

The public `resolvePageLabelForUsername` (`agency-hub-client.ts:282-294`) wraps
this over a live `pages()` fetch (guarded on base URL, bearer, and host
permission). A `null` here is the caller's "unmapped page" signal — the
spenders service turns it into `ChatGooseError('hub_page_match_failed')`
(`spenders-service.ts:116-118`), and the profile wrappers surface
`page_match_failed`. Beyond spenders, the same resolver feeds the feature lane
(`src/background/operations.ts:2063`) and compare flow
(`src/background/compare-operations.ts:937`).

---

## Profile push: dedup + byte cap (`pushFanProfile`, `agency-hub-client.ts:450-579`)

Ordered pre-flight before any network call: missing base URL → `skipped`
(`hub_invalid_url`); missing api key → `skipped` (`hub_missing_api_key`);
missing host permission → `skipped` (`hub_missing_permission`); empty body →
`skipped` (`empty_body`); **byte cap** — `measureUtf8Bytes(body) >
AGENCY_HUB_PROFILE_MAX_BYTES` (`50_000`, `src/shared/agency-hub.ts:7`) →
`skipped` (`body_too_large`, `agency-hub-client.ts:489-498`); missing
normalized page username → `failed` (`hub_page_match_failed`); missing/blank
`platformUserId` → `failed`. `measureUtf8Bytes` counts UTF-8 bytes via
`TextEncoder` (`src/shared/agency-hub.ts:49-51`), not characters.

Then it fetches `pages()`, resolves the label, and performs the **sync
dedup**: when `generatedAt` was supplied and `hasAgencyHubSyncMetadata(
existingSync, baseUrl, pageLabel, generatedAt)` is true, it returns
`status: 'already-synced'` without writing (`agency-hub-client.ts:534-544`).
`hasAgencyHubSyncMetadata` (`src/shared/agency-hub.ts:88-102`) requires the
prior metadata to be `state === 'saved'` with an exact `baseUrl`, `pageLabel`,
and `generatedAt` match (via `normalizeAgencyHubSummarySyncMetadata`). Only if
the dedup misses does it call `upsertFanProfile` and report `status: 'pushed'`.
The stored profile that `fetchFanProfileByConversation` reads back is subject
to the same 50 000-byte cap (`agency-hub-client.ts:675-685`, there a `failed`
rather than a `skipped`).

---

## Shared Agency Hub helpers (`src/shared/agency-hub.ts`)

- `normalizeAgencyHubBaseUrl(value)` (`agency-hub.ts:9-26`): trims, parses as a
  `URL`, rejects non-`http(s)` protocols (returns `''`), and returns
  `origin + pathname` with trailing slashes stripped (a bare `/` path becomes
  empty). `''` is the "not configured / invalid" sentinel used throughout the
  client.
- `buildAgencyHubOriginPattern(baseUrl)` (`agency-hub.ts:28-36`): normalizes,
  then returns `scheme://hostname/*` — **port and path dropped** — the
  Firefox-compatible host-permission match pattern. `tests/agency-hub.test.ts`
  pins `http://localhost:3000 → http://localhost/*` and
  `https://example.com:8443/base/path → https://example.com/*`;
  invalid/`ftp://` inputs → `null`.
- `buildAgencyHubUrl(baseUrl, path)` (`agency-hub.ts:38-42`): normalized-base
  URL join (leading slashes on `path` stripped). Retained helper; the SDK
  handles URL construction for the live calls above.
- `normalizeAgencyHubUsername` (`agency-hub.ts:44-47`): the join-key
  normalizer described above.
- `measureUtf8Bytes` (`agency-hub.ts:49-51`): the byte-cap measure.
- `normalizeAgencyHubSummarySyncMetadata` (`agency-hub.ts:53-70`): folds both
  the current `FanSummarySyncStatus` and the `Legacy…` sync-metadata shapes
  (`src/shared/types.ts:53-80`) into one `FanSummarySyncStatus` (default
  `state: 'saved'`, base URL re-normalized). `hasAgencyHubSyncMetadata`
  (`agency-hub.ts:88-102`, the push dedup) and
  `isAgencyHubSummarySavedForBaseUrl` (`agency-hub.ts:72-86`) are the two
  predicates built on it; both require `state === 'saved'` plus exact field
  matches.

---

## Test anchors

- `tests/storage-coordinator.test.ts:91` — concurrent known-account writes
  never drop entries (`enqueueWrite` serialization).
- `tests/spenders-service.test.ts:158` — kernel path issues no earnings sweep,
  honest `builtAt`, group intersection; `:195` — `spendersLegacyRebuild`
  forces the legacy sweep; `:205` — null page label fails.
- `tests/agency-hub-client.test.ts:300` — `testConnection` lists pages with
  `Authorization: Bearer hub-key`; `:334` / `:365` — permission and 401
  mappings; `:219` — `body_too_large`; `:613` — 404 conversation lookup →
  `not-found`.
- `tests/device-token.test.ts:15` — `resolveHubBearer` prefers the device
  token, falls back to the legacy key.
- `tests/agency-hub.test.ts:5` — origin-pattern port/path stripping.
