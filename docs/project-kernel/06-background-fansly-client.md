> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Background — Fansly REST Client

## Scope

Covers exactly one file:

- `src/background/fansly-client.ts` — `FanslyClient`, the caller side of the Fansly REST boundary (`https://apiv3.fansly.com/api/v1`). It builds every Fansly HTTP request, attaches the sniffed session headers, unwraps the `{success, response}` envelope, drives retries/timeouts, paginates, and holds two in-memory caches.

Supporting files are referenced where they define constants, types, or helpers this file depends on (`src/shared/constants.ts`, `src/shared/types.ts`, `src/shared/concurrency.ts`, `src/shared/earnings.ts`, `src/shared/transcript.ts`, `src/shared/errors.ts`, `src/background/llm-stream-utils.ts`, `src/background/session-store.ts`) but are documented in full elsewhere. The Fansly boundary contract tables live in `docs/project-kernel/boundaries.md`.

---

## Imports (dependencies)

`fansly-client.ts` imports:

| Symbol | From | Use |
| --- | --- | --- |
| `FANSLY_PAGINATION_DELAY_MS`, `FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS`, `FANSLY_MEDIA_PURCHASE_VERIFICATION_CONCURRENCY`, `FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS`, `FANSLY_PAGE_LIMIT`, `FANSLY_REQUEST_TIMEOUT_MS`, `FANSLY_RETRY_DELAYS_MS`, `FANSLY_RETRY_MAX_BACKOFF_MS` | `../shared/constants.js` | timing/limits (values below) |
| `mapWithConcurrency` | `../shared/concurrency.js` | bounded fan-out for media-purchase checks |
| `aggregateEarnings` | `../shared/earnings.js` | fold `EarningsRow[]` → `AggregatedEarnings` |
| `ChatGooseError` | `../shared/errors.js` | all thrown errors |
| `parseRetryAfterMs` | `./llm-stream-utils.js` | parse `Retry-After` header on 429 |
| `estimateTargetPages`, `extractOldestMessageId` | `../shared/transcript.js` | page-count estimate + oldest-id cursor |
| types `PpvAttachmentRequest`, `PurchaseEvidenceOverride` | `../shared/transcript.js` | PPV verify I/O |
| types `AggregatedEarnings`, `EarningsRow`, `FanslyAccountMediaOrder`, `FanslyAccountResponse`, `FanslyMediaOrderHistoryResponse`, `FanslyMessagingGroupsResponse`, `FanslyMessagePageResponse`, `FanslySubscriberSubscriptionRecord`, `FanslySubscribersResponse`, `FanSubscriptionContext`, `FanSubscriptionSource`, `MonthlyEarningsRow`, `RouteKey`, `SessionTemplate`, `SubscriptionLookupMode` | `../shared/types.js` | wire + domain shapes |
| `SessionStore` (class, value import) | `./session-store.js` | injected dependency; only `markDisconnected` is called |

## Consumers (who constructs / calls this file)

- Constructed once at the composition root: `background/index.ts:20` — `new FanslyClient(sessionStore)`. The instance is passed into `SpendersService` (`index.ts:21`) and into the runtime-api/operations wiring (`index.ts:30,48`).
- `background/operations.ts` (the `OperationCoordinator`) calls `getGroup`, `getAuthenticatedAccount`, `getAuthenticatedAccountId`, `loadMessages`, `getAccountNames`, `getEarnings`, `getMonthlyEarnings`, `getFanSubscriptionContext`.
- `background/compare-operations.ts` calls the same set (via a `context.fanslyClient` handle): `getAuthenticatedAccountId`, `loadMessages`, `getGroup`, `getAccountNames`, `getEarnings`, `getMonthlyEarnings`, `getFanSubscriptionContext`.
- `background/spenders-service.ts` calls `listFanAccounts`, `getEarnings`, `getAccountNames`.
- `background/conversation-context-loader.ts` calls `verifyMediaPurchaseStates` (caps requests to `FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT = 10` **before** calling; the client itself imposes no such cap).
- `background/runtime-api.ts:157` calls `getAuthenticatedAccount`.
- `getMessagePage` is **private-in-effect**: it is `async` and public but is only called from `loadMessages` within this file (no external call sites found).

The only cross-module *call* out of this file at runtime is `this.sessionStore.markDisconnected(session.accountId)` inside `fetchEnvelope` on 401/403.

---

## Module-level constants (defined in this file)

`fansly-client.ts:42-50`

| Name | Value | Meaning |
| --- | --- | --- |
| `MESSAGING_GROUPS_PAGE_SIZE` | `100` | `limit` for every `messaging/groups` request |
| `MESSAGING_GROUPS_MAX_PAGES` | `20` | hard cap on pages walked in both `listFanAccounts` and the messaging-groups subscription lookup |
| `SUBSCRIBERS_PAGE_SIZE` | `100` | `limit` for every `subscribers` request |
| `SUBSCRIPTION_CACHE_TTL_MS` | `5 * 60 * 1000` (5 min) | TTL of `subscriberSubscriptionCache` (locally defined; distinct constant from the imported media TTL but same value) |
| `ORDER_TYPE_SINGLE` | `1` | media-order `type` for a single item |
| `ORDER_TYPE_BUNDLE` | `2` | media-order `type` for a bundle |

Imported constants used (values from `src/shared/constants.ts:80-90`):

| Name | Value |
| --- | --- |
| `FANSLY_PAGE_LIMIT` | `25` (message page `limit`) |
| `FANSLY_REQUEST_TIMEOUT_MS` | `30_000` (per-attempt timeout) |
| `FANSLY_PAGINATION_DELAY_MS` | `300` (delay between pages) |
| `FANSLY_RETRY_DELAYS_MS` | `[1000, 2000, 4000]` (backoff schedule; `.length === 3` also sets max retries) |
| `FANSLY_RETRY_MAX_BACKOFF_MS` | `5_000` (cap on honored `Retry-After`) |
| `FANSLY_MEDIA_PURCHASE_VERIFICATION_CONCURRENCY` | `3` |
| `FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS` | `3_000` (per-check timeout) |
| `FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS` | `5 * 60 * 1000` (5 min) |
| `FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT` | `10` (applied by the caller, not here) |

---

## Local types

- `MediaPurchaseStatus = 'purchased' | 'not-purchased'` (`:52`).
- `CachedMediaPurchaseStatus { expiresAt: number; status: MediaPurchaseStatus }` (`:54`).
- `MediaPurchaseCheckResult { request: PpvAttachmentRequest; status: MediaPurchaseStatus }` (`:59`).
- `interface CachedSubscriberSubscription { expiresAt: number; value: FanSubscriptionContext | null }` (`:126`) — note it caches `null` (negative results are cached).
- Exported `interface MessageLoadResult { pages: FanslyMessagePageResponse[]; pagesLoaded: number; targetPages: number }` (`:101`).
- Exported `interface MessageLoadProgress { currentPage; targetPages; pageMessageCount; collectedCount }` (`:107`).
- Exported `type SubscriptionLookupTraceEvent` (`:114-124`) — discriminated union: `cache-hit`, `cache-miss`, `cache-only-skip`, `groups-start`, `groups-hit`, `groups-miss`, `groups-error` (carries `code: string`), `subscribers-start`, `subscribers-hit`, `subscribers-miss`.

---

## Module-level helper functions (not on the class)

| Function | Location | Behavior |
| --- | --- | --- |
| `withNgswBypass(url)` | `:64` | **Mutates** the passed `URL`: `searchParams.set('ngsw-bypass', 'true')` and returns it. Called on every request inside `fetchEnvelope`; because it sets the same key it is idempotent across retries. Purpose: bypass Fansly's Angular service worker (`ngsw`). |
| `delay(ms, signal?)` | `:69` | Promise that resolves after `ms`; rejects immediately with `DOMException('Aborted','AbortError')` if `signal` already aborted or aborts during the wait; clears its timeout on abort. Used for inter-page pacing and retry backoff. |
| `readResponseSnippet(response)` | `:93` | `await response.text()` sliced to first 400 chars; returns `''` on throw. Feeds `responseSnippet` in error details. |
| `normalizeOptionalString(v)` | `:131` | trimmed string or `null`. |
| `normalizeOptionalNumber(v)` | `:136` | finite number or `null`. |
| `timestampToIso(v)` | `:140` | finite `> 0` ms epoch → `new Date(v).toISOString()`, else `null`. |
| `extractOrderHistoryRows(response)` | `:146` | Merges `response.accountMediaOrderHistory` and `response.aggregationData.accountMediaOrders`. Returns `null` if either present-but-not-an-array (validation failure) or if **both** are `undefined`; otherwise the concatenated array filtered to truthy objects. |
| `orderMatchesPurchaseRequest(order, request, fanAccountId)` | `:174` | Order/PPV matching (see rules below). |
| `uniquePurchaseRequests(requests)` | `:201` | Dedupe by `` `${kind}:${contentId}` ``, dropping blank `contentId`; trims contentId; rebuilds each request as `{kind, contentId}`. |
| `normalizeSubscriberSubscription(record, source)` | `:219` | Maps a raw `FanslySubscriberSubscriptionRecord` → `FanSubscriptionContext`, stamping `source`. `autoRenew`: `null` stays `null`, otherwise `record.autoRenew > 0` → boolean. All timestamp fields run through `timestampToIso`; optional strings/numbers normalized. |

### `orderMatchesPurchaseRequest` rules (`:174`)

1. `order.accountId !== fanAccountId` → `false` (order must belong to the fan).
2. `request.kind === 'single'`: true iff `order.accountMediaId === request.contentId` **and** `order.accountMediaBundleId == null` **and** (`order.type == null` **or** `order.type === ORDER_TYPE_SINGLE`).
3. Else (bundle request) with `order.accountMediaBundleId` set: true iff `order.accountMediaBundleId === request.contentId` **and** `order.type !== ORDER_TYPE_SINGLE`.
4. Else (bundle request, inline `/message` shape where bundle id sits in `accountMediaId`): true iff `order.type === ORDER_TYPE_BUNDLE` **and** `order.accountMediaId === request.contentId`.

---

## Class `FanslyClient` (`:249`)

### State held

- `private readonly subscriberSubscriptionCache = new Map<string, CachedSubscriberSubscription>()` (`:250`).
- `private readonly mediaPurchaseVerificationCache = new Map<string, CachedMediaPurchaseStatus>()` (`:251`).
- Constructor: `constructor(private readonly sessionStore: SessionStore)` (`:253`). No other injected state.

Both caches are unbounded `Map`s that live for the lifetime of the background service worker; entries are only removed lazily on read when expired (no timer-based eviction, no size cap).

### Cache-key + cache-access helpers

| Method | Location | Key format / behavior |
| --- | --- | --- |
| `getSubscriberSubscriptionCacheKey(fanAccountId, session)` | `:255` | `` `${session.resolvedAccountId ?? session.accountId}:${fanAccountId}` `` — keyed on **creator** identity (resolved id preferred, capture id fallback) + fan id. |
| `readCachedSubscriberSubscription(cacheKey)` | `:259` | Returns `FanSubscriptionContext | null | undefined`. `undefined` = miss (absent or expired; expired entries are deleted). `null` = cached negative. A cached `null` is a **hit**. |
| `writeCachedSubscriberSubscription(cacheKey, value)` | `:271` | Stores value (may be `null`) with `expiresAt = Date.now() + SUBSCRIPTION_CACHE_TTL_MS` (5 min). |
| `getMediaPurchaseCacheKey(fanAccountId, request, session)` | `:278` | `[resolvedAccountId ?? accountId, fanAccountId, request.kind, request.contentId].join(':')`. |
| `readCachedMediaPurchaseStatus(cacheKey)` | `:291` | Returns `MediaPurchaseStatus | undefined`; deletes + returns `undefined` on expiry. |
| `writeCachedMediaPurchaseStatus(cacheKey, status)` | `:305` | `expiresAt = Date.now() + FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS` (5 min). Only definitive `'purchased'`/`'not-purchased'` are ever written (incomplete checks are not cached). |

---

## `fetchEnvelope<T>` — the single request primitive (`:315`)

Signature: `private async fetchEnvelope<T>(url, session, routeKey, signal, optional = false, retryPolicy: 'default' | 'none' = 'default'): Promise<T>`.

Every network method routes through here. Boundary: `fetch(...)` to `https://apiv3.fansly.com/api/v1/...` (the URL is passed in fully-formed by each method).

### Attempt / retry loop

- `maxAttempts = retryPolicy === 'none' ? 0 : FANSLY_RETRY_DELAYS_MS.length` → `0` or `3`.
- `for (let attempt = 0; ; attempt++)` — unbounded loop; exits only via `return` or `throw`.
- Retryable statuses (429 or `>= 500`) retry while `attempt < maxAttempts`, so:
  - `retryPolicy: 'default'` → up to **4 total network attempts** (initial + 3 retries at delays `[1000, 2000, 4000]` ms).
  - `retryPolicy: 'none'` → **exactly 1 attempt** (`0 < 0` is false), no backoff.

### Per-attempt timeout

- Each attempt creates its own `AbortController` + `setTimeout(() => controller.abort(), FANSLY_REQUEST_TIMEOUT_MS)` (30 s). Cleared in `finally` before the next loop iteration, so timeouts do **not** stack across retries.
- The fetch signal is `AbortSignal.any([signal, controller.signal])` — aborts on either the caller's op signal or the 30 s per-attempt timeout.

### Headers set per attempt (`:334`)

Fresh `Headers`:

| Header | Value source |
| --- | --- |
| `authorization` | `session.authorization` |
| `fansly-client-id` | `session.fanslyClientId` |
| `fansly-client-ts` | `String(Date.now())` — recomputed fresh each attempt (`requestTs`, `:331`). **Note:** `session.latestTs` (the captured ts) is *not* used here. |
| `fansly-session-id` | `session.fanslySessionId` |
| `fansly-client-check` | `session.routeChecks[routeKey] ?? session.latestCheck`; header only set when that value is truthy (`:341-344`). |

Fetch options: `method: 'GET'`, `signal: composite`, `credentials: 'omit'`. URL run through `withNgswBypass` (adds `ngsw-bypass=true`).

### Response handling (in order)

1. **401 / 403** (`:353`): `this.sessionStore.markDisconnected(session.accountId)` then `throw new ChatGooseError('session_expired', undefined, { status })`. This precedes the optional/retry logic — session_expired is thrown even for `optional` calls and is never retried.
2. Compute `retryAfterMs` only when status is 429, via `parseRetryAfterMs(headers.get('retry-after'))` (numeric seconds → ms, or HTTP-date → ms-from-now, clamped `>= 0`).
3. **Retryable + budget left** (`(429 || >= 500) && attempt < maxAttempts`, `:362`): backoff = `min(retryAfterMs, FANSLY_RETRY_MAX_BACKOFF_MS)` when a 429 supplied `Retry-After`, else `FANSLY_RETRY_DELAYS_MS[attempt]`. (5xx never has `retryAfterMs`, so 5xx always uses the fixed schedule.) `await delay(backoff, signal)` — waits against the **outer** signal only; `continue`.
4. **429, budget exhausted** (`:370`): `throw new ChatGooseError('rate_limited', { details: { status: 429, retryAfterMs?, retryAtMs? }, retryAfterMs?, retryAtMs? })` where `retryAtMs = Date.now() + retryAfterMs` when `Retry-After` was present.
5. **Other non-ok** (`:380`): reads a ≤400-char snippet, throws `ChatGooseError(optional ? 'unknown_error' : 'fansly_server_error', undefined, { status, responseSnippet })`.
6. **Envelope unwrap** (`:388`): `data = await response.json() as { success; response?; error? }`. If `!data.success || data.response === undefined` → `ChatGooseError(optional ? 'unknown_error' : 'fansly_server_error')`. Otherwise returns `data.response` (typed `T`).

### Catch / finally (`:394`)

- `ChatGooseError` → rethrown unchanged (so the classified errors above propagate).
- `DOMException` with `name === 'AbortError'` → rethrown unchanged (covers both caller-cancel and the 30 s per-attempt timeout).
- Anything else → `ChatGooseError(optional ? 'unknown_error' : 'network_error')`.
- `finally`: `clearTimeout(timeout)` (per-attempt timeout).

**Error-key mapping summary** (thrown `ChatGooseError.key`): 401/403 → `session_expired`; final 429 → `rate_limited`; other HTTP error / bad envelope → `fansly_server_error` (or `unknown_error` if `optional`); non-HTTP throw → `network_error` (or `unknown_error` if `optional`). `optional=true` demotes server/network failures to `unknown_error` but does **not** demote 401/403 or 429.

---

## Endpoint methods — full table

All URLs are under base `https://apiv3.fansly.com/api/v1`. "Retry" = the `retryPolicy` passed to `fetchEnvelope` (`default` = up to 4 attempts; `none` = 1). "Opt" = the `optional` flag.

| Method (`fansly-client.ts`) | HTTP path | Query params | RouteKey | Opt | Retry | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `getGroup` `:408` | `GET /group/{groupId}/` | (path only; `ngsw-bypass`) | `group` | `true` | default | Returns `{ users?: Array<{ userId }> }`. |
| `getAuthenticatedAccount` `:427` | `GET /account/me` | — | `account` | `false` | default | Short-circuits w/o network when `session.resolvedAccountId` set and one of `resolvedUsername`/`resolvedDisplayName` non-null. On success caches `resolvedAccountId/Username/DisplayName` **onto the session object**. Throws `unknown_error` if account id absent. |
| `getMessagePage` `:465` | `GET /message` | `groupId`, `limit=FANSLY_PAGE_LIMIT (25)`, `before` (only if truthy) | `message` | `false` | default | Internal to `loadMessages`. |
| `getMediaOrderHistory` (private) `:480` | `GET /media/orderhistory` | `accountMediaId` (single) **or** `accountMediaBundleId` (bundle), `accountIds={fanAccountId}`, `limit=100` | `media` | `true` | default | Called only by `verifyMediaPurchaseState`. |
| `getAccountNames` `:602` | `GET /account` | `ids={ids.join(',')}` | `account` | `true` | default | Accepts either a bare array response or `{ accounts: [...] }`; anything else → `[]`. |
| `getEarnings` `:626` | `GET /account/wallets/earnings/stats/accounts` | `correlationAccountId={fanAccountId}`, `before={windowEndMs}`, `after={windowStartMs}` | `earnings` | `true` | **none** | `before`=window END, `after`=window START. Empty/non-array → `null`; else `aggregateEarnings(rows, fanAccountId, windowStartMs, windowEndMs)`. |
| `getMonthlyEarnings` `:708` | `GET /account/wallets/earnings/monthlystats/accounts` | `correlationAccountId`, `before={windowEndMs}`, `after={windowStartMs}` | `earnings` | `true` | **none** | Returns `MonthlyEarningsRow[]` or `[]`. |
| `listFanAccounts` (per page) `:655` | `GET /messaging/groups` | `sortOrder=1`, `flags=0`, `subscriptionTierId=''`, `listIds=''`, `search=''`, `limit=100`, `offset={n*100}` | `messagingGroups` | `false` | default | Walk; see below. |
| `getActiveConversationSubscriptionFromMessagingGroups` (private, per page) `:729` | `GET /messaging/groups` | same 7 params as above | `messagingGroups` | `false` | default | Walk for a specific `groupId`; reads `aggregationData.accounts[].subscriberSubscription`. |
| `getSubscriptionFromSubscribers` (private, per page) `:785` | `GET /subscribers` | `before=''`, `after=''`, `status` (`'3,4'` then `'5'`), `limit=100`, `offset={n*100}`, `search=''`, `subscriptionTierId=''` | `subscribers` | `false` | default | Walk two status buckets; see below. |

`fansly-client-check` per route comes from `session.routeChecks[routeKey]` first (populated by `session-store.ts` from `webRequest`-sniffed per-route checks) then falls back to `session.latestCheck`.

---

## High-level method behavior

### `getAuthenticatedAccountId` (`:422`)

Thin wrapper: `(await this.getAuthenticatedAccount(...)).id`.

### `getAuthenticatedAccount` (`:427`)

Returns `FanslyAccountResponse` (`{ id, username, displayName }`). Cache-on-session behavior: if `session.resolvedAccountId` is set and either `resolvedUsername` or `resolvedDisplayName` is non-null, it returns from the session with no network call. Otherwise GETs `/account/me`, reads `response.account`, trims `id`; on empty id throws `unknown_error`. Mutates `session.resolvedAccountId/resolvedUsername/resolvedDisplayName` (username/displayName become trimmed value or `null`).

### `verifyMediaPurchaseStates` (`:552`) and `verifyMediaPurchaseState` (private, `:504`)

Public entry `verifyMediaPurchaseStates(requests, fanAccountId, session, signal)` → `PurchaseEvidenceOverride`:

1. `uniquePurchaseRequests(requests)` dedupes.
2. `mapWithConcurrency(uniqueRequests, FANSLY_MEDIA_PURCHASE_VERIFICATION_CONCURRENCY (3), verifyMediaPurchaseState)` — bounded 3-at-a-time fan-out.
3. Folds results into four `Set<string>` (`purchasedSingleIds`, `purchasedBundleIds`, `checkedNotPurchasedSingleIds`, `checkedNotPurchasedBundleIds`) plus a `verificationIncomplete` boolean set true whenever a per-request result is `null`.

Returns object `{ purchasedSingleIds, purchasedBundleIds, checkedNotPurchasedSingleIds, checkedNotPurchasedBundleIds, verificationIncomplete }`.

`verifyMediaPurchaseState(request, fanAccountId, session, signal)`:

- Cache lookup by `getMediaPurchaseCacheKey`; a cached `'purchased'`/`'not-purchased'` returns immediately (`if (cached)` — both statuses are truthy strings).
- Otherwise sets up a **per-check timeout**: `timeoutController` aborted after `FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS` (3 s); `composite = AbortSignal.any([signal, timeoutController.signal])` is passed to `getMediaOrderHistory` (so this bounds the underlying 30 s per-attempt timeout to 3 s wall-clock for the whole check, including any retries).
- `extractOrderHistoryRows(response)`; if `null` (missing/invalid shape) → returns `null` (incomplete).
- Status = `'purchased'` if any row satisfies `orderMatchesPurchaseRequest`, else `'not-purchased'`. Writes cache. Returns `{ request, status }`.
- Catch: **rethrows only when `signal.aborted`** (the outer op signal); a per-check timeout (`timeoutController` fired, outer signal not aborted) or any other error → returns `null` (counted as incomplete, not fatal). `finally` clears the 3 s timeout.

Caller note: `conversation-context-loader.ts` caps the request list to `FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT = 10` before calling and OR-folds its own `capOverflow` into `verificationIncomplete`.

### `getEarnings` (`:626`) / `getMonthlyEarnings` (`:708`)

Both use `retryPolicy: 'none'` and `optional: true` — intentionally best-effort: a transient failure returns `null`/`[]` (or throws `unknown_error`, which upstream discards) rather than spending the retry budget. `getEarnings` returns `AggregatedEarnings | null`; `getMonthlyEarnings` returns `MonthlyEarningsRow[]`. Callers: `spenders-service.getEarnings` (lifetime `after=0, before=now`), `operations.ts` / `compare-operations.ts` (both monthly totals and per-month breakdowns via repeated `getEarnings` with `monthWindowMs`).

### `listFanAccounts(maxFans, session, signal)` (`:655`)

Enumerates the creator's conversations newest-first as `{ groupId, fanAccountId }`, deduped by fan, bounded to `maxFans`.

- Walks up to `MESSAGING_GROUPS_MAX_PAGES` (20) pages of `/messaging/groups`, `offset += 100` each page, `delay(FANSLY_PAGINATION_DELAY_MS = 300ms)` between pages.
- `groups = response.data` (array-guarded). For each entry: `fanAccountId = entry.partnerAccountId`; skip when falsy or already in `seen`; else push `{ groupId: entry.groupId, fanAccountId }`.
- `truncated` semantics:
  - Hit `maxFans` mid-page → return early with `truncated = (more entries remain on this page) OR (this page was full, i.e. length === 100)`.
  - A page shorter than 100 → inbox exhausted → `truncated = false`.
  - Ran out at the 20-page cap with full pages throughout → `truncated = true`.

Returns `{ fans, truncated }`. Called by `SpendersService` with `SPENDERS_MAX_FANS = 150`.

### `getFanSubscriptionContext` (`:839`)

Signature: `(groupId, fanAccountId, session, signal, lookupMode: SubscriptionLookupMode = 'full', onTrace?)` → `FanSubscriptionContext | null`.

Flow, emitting `onTrace(SubscriptionLookupTraceEvent)` at each step:

1. Cache read by creator+fan key. If `!== undefined` (hit, incl. cached `null`): emit `cache-hit`, return the cached value.
2. Emit `cache-miss`. If `lookupMode === 'cache-only'`: emit `cache-only-skip`, return `null` (no network).
3. `groups-start` → `getActiveConversationSubscriptionFromMessagingGroups`. On a truthy result: `groups-hit`, write cache, return. Otherwise `groups-miss`.
   - Error handling inside this try: rethrow `AbortError`; rethrow `ChatGooseError` whose `key === 'session_expired'`; any other error → emit `groups-error` with `code = error.key` (or `'unknown_error'`) and fall through to the subscribers path (does **not** cache).
4. `subscribers-start` → `getSubscriptionFromSubscribers`. Emit `subscribers-hit`/`subscribers-miss`. **Write cache with the result (including `null`)** and return it.

Note: a hit from the messaging-groups path caches only on success; the subscribers path caches its result unconditionally (positive or negative). A `groups-error` fall-through still lets the subscribers result populate the cache.

Callers pass `subscriptionLookupMode` (full vs cache-only) and, when the debug profiler is enabled, an `onTrace` handler (`operations.ts:2003`, `compare-operations.ts:854`).

### `getActiveConversationSubscriptionFromMessagingGroups` (private, `:729`)

Walks `/messaging/groups` (same params/pacing as `listFanAccounts`) up to 20 pages looking for `entry.groupId === groupId`.

- On match: if `match.partnerAccountId !== fanAccountId` → `null`. Else read `response.aggregationData.accounts` (array-guarded), find `account.id === fanAccountId`, take `account.subscriberSubscription`; if `subscription.subscriberId === fanAccountId` → `normalizeSubscriberSubscription(subscription, '/api/v1/messaging/groups')`, else `null`.
- If a page returns `< 100` groups without a match → `null` (inbox exhausted).
- Reaching the 20-page cap without a match → `null` (caller then falls through to subscribers).

### `getSubscriptionFromSubscribers` (private, `:785`)

Iterates status buckets `'3,4'` (active) then `'5'` (expired). For each bucket, paginates `/subscribers` from `offset = 0`:

- Finds `entry.subscriberId === fanAccountId` in `response.subscriptions`; first match → `normalizeSubscriberSubscription(match, '/api/v1/subscribers')` (returns immediately across both buckets).
- `totalForStatus` read from `response.stats` — `totalActive` for `'3,4'`, `totalExpired` for `'5'`.
- Loop stops for a bucket when the page is short (`< 100`) **or** `offset + 100 >= totalForStatus`; otherwise `offset += 100`, `delay(300ms)`.
- No match in either bucket → `null`.

### `loadMessages(groupId, requestedCount, session, signal, onProgress?)` (`:904`)

Paginates `getMessagePage` until `collectedCount >= requestedCount`.

- `targetPages = estimateTargetPages(requestedCount)` = `max(1, ceil(requestedCount / 25))`.
- Accumulates each page into `pages[]`; cursor `before` starts `null`, then `extractOldestMessageId(messages)` (last element's `id`, oldest since pages are newest-first).
- After each page fires `onProgress({ currentPage, targetPages, pageMessageCount, collectedCount })`.
- Breaks when `!before` (empty page) or `messages.length < FANSLY_PAGE_LIMIT (25)` (last page). Otherwise `delay(FANSLY_PAGINATION_DELAY_MS = 300ms)` and continues.
- Returns `MessageLoadResult { pages, pagesLoaded: currentPage, targetPages }`.

---

## Boundary-crossing summary

- **Network (Fansly REST, `credentials: 'omit'`)** — nine distinct endpoints (see table): `GET /group/{id}/`, `GET /account/me`, `GET /account?ids=`, `GET /message?groupId&limit&before`, `GET /media/orderhistory?...`, `GET /account/wallets/earnings/stats/accounts?...`, `GET /account/wallets/earnings/monthlystats/accounts?...`, `GET /messaging/groups?...`, `GET /subscribers?...`. Every request carries headers `authorization`, `fansly-client-id`, `fansly-client-ts`, `fansly-session-id`, and conditionally `fansly-client-check`, plus query param `ngsw-bypass=true`.
- **Cross-module call** — `sessionStore.markDisconnected(session.accountId)` on 401/403.
- **No DOM access, no `browser.storage` access, no IPC messaging, no distribution/browser-API calls** occur in this file. Session credentials arrive via the injected `SessionTemplate` (populated elsewhere from `webRequest` sniffing); operation results are returned to callers, not posted over any port here.

## Notable behaviors / discrepancies

- **`fansly-client-ts` ignores the captured `session.latestTs`.** Requests always send `String(Date.now())` recomputed per attempt; `session.latestTs` exists on the template but is unused by this file.
- **`retryPolicy: 'none'` means one attempt, not "no retries after the first."** `maxAttempts` is `0`, so the very first retryable status throws immediately.
- **`optional` does not soften 401/403 or 429.** Those always surface as `session_expired` / `rate_limited`; only 5xx/other-non-ok/bad-envelope/network throws are demoted to `unknown_error`.
- **Two independent timeout scopes stack for media checks.** `verifyMediaPurchaseState` wraps `getMediaOrderHistory` in a 3 s (`FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS`) composite, which will cut off well before the inner 30 s per-attempt timeout and before the default retry schedule can fully play out.
- **Negative caching.** Both `getFanSubscriptionContext` (subscribers path) and the subscription cache store `null` results for 5 min; media checks cache only definitive purchased/not-purchased (never the incomplete `null`).
- **Unbounded, lazily-evicted caches.** Neither cache has a size cap or timer eviction; stale entries are dropped only when next read after expiry.
- **`getMessagePage` is public but has no external callers** — effectively internal to `loadMessages`.
- **Retry backoff waits on the outer signal only.** During `delay(backoff, signal)` between retries, the per-attempt 30 s timeout controller is not in scope (it was cleared in the prior `finally`), so only caller cancellation interrupts a backoff wait.
