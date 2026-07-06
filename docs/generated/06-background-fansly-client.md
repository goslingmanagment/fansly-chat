> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Background: Fansly REST client

`src/background/fansly-client.ts` (964 lines) defines `FanslyClient`
(`src/background/fansly-client.ts:269`), the single module in the extension that
issues requests to Fansly's REST API. Every request is an HTTP `GET` against
host `apiv3.fansly.com`, path prefix `/api/v1`, and every request flows through
one private method, `fetchEnvelope` (`src/background/fansly-client.ts:335`),
which supplies auth headers, timeout, retry, and envelope unwrapping.

The client holds no credentials of its own. It is constructed with a
`SessionStore` reference (`src/background/fansly-client.ts:273`) and reads the
per-account `SessionTemplate` (headers captured from the model's live Fansly tab)
that each public method receives as an argument. Documented elsewhere:
`session-store.ts` (header capture source), `shared/subscriptions.ts` +
`shared/earnings.ts` (normalization consumers), `spenders-service.ts` (caller of
`listFanAccounts` / `getEarnings`).

## How requests are authenticated

Auth is entirely header-based; cookies are never sent — every `fetch` passes
`credentials: 'omit'` (`src/background/fansly-client.ts:370`). Headers are built
fresh per attempt in `fetchEnvelope` (`src/background/fansly-client.ts:354`):

| Header | Value | Source |
|---|---|---|
| `authorization` | `session.authorization` (a `Bearer …` token) | captured session (`src/shared/types.ts:117`) |
| `fansly-client-id` | `session.fanslyClientId` | captured session (`src/shared/types.ts:118`) |
| `fansly-client-ts` | `String(Date.now())` — a **freshly generated** timestamp per request, NOT the captured `session.latestTs` | generated at call time (`src/background/fansly-client.ts:351`, set at `:357`) |
| `fansly-session-id` | `session.fanslySessionId` | captured session (`src/shared/types.ts:119`) |
| `fansly-client-check` | `session.routeChecks[routeKey] ?? session.latestCheck`; set only when the resolved value is truthy | per-route anti-bot check token (`src/background/fansly-client.ts:361`) |

`routeKey` is one of `'message' | 'group' | 'account' | 'earnings' |
'messagingGroups' | 'subscribers' | 'media'` (`src/shared/types.ts:6`). The
per-route `fansly-client-check` token lets a request reuse the exact
`fansly-client-check` header that Fansly's frontend sent for that same route
family; if no route-specific token was captured it falls back to the most recent
one (`session.latestCheck`).

On HTTP `401` or `403` the client calls
`sessionStore.markDisconnected(session.accountId)` and throws
`ChatGooseError('session_expired')` — it does not retry
(`src/background/fansly-client.ts:373`).

Every request URL is rewritten by `withNgswBypass`
(`src/background/fansly-client.ts:84`) to append `?ngsw-bypass=true`, which
bypasses Fansly's Angular service worker cache.

Note: the URL host/prefix is hard-coded as the literal
`'https://apiv3.fansly.com/api/v1/…'` inside each method; the
`FANSLY_API_BASE` constant (`src/shared/constants.ts:24`) is defined but not
imported or used by this client.

## Endpoint catalog

Every endpoint below is `GET`, host `https://apiv3.fansly.com`. "Optional" means
`fetchEnvelope` was called with `optional = true`, which downgrades non-network
error keys to `unknown_error` (see Error taxonomy). "Retry" = `default` unless
noted `none`.

### 1. `GET /api/v1/group/{groupId}/`
- Method: `getGroup` (`src/background/fansly-client.ts:428`); routeKey `group`; optional; retry default.
- Purpose: fetch a messaging group's member list.
- Path param: `groupId` (interpolated into the path, with trailing slash).
- Query: none beyond `ngsw-bypass`.
- Response consumed: `{ users?: Array<{ userId: string }> }` (`src/background/fansly-client.ts:432`).

### 2. `GET /api/v1/account/me`
- Method: `getAuthenticatedAccount` (`src/background/fansly-client.ts:447`, URL at `:463`); routeKey `account`; not optional; retry default.
- Purpose: resolve the authenticated model's own account id / username / display name.
- Query: none.
- Response consumed: `{ account?: FanslyAccountResponse }`; reads `account.id`, `account.username`, `account.displayName` (`src/background/fansly-client.ts:468-476`). The resolved values are memoized onto the `SessionTemplate` (`resolvedAccountId`, `resolvedUsername`, `resolvedDisplayName`); on a subsequent call the network request is skipped entirely if `resolvedAccountId` plus either name is already set (`src/background/fansly-client.ts:451-460`). A missing/blank `account.id` throws `unknown_error` (`src/background/fansly-client.ts:470`).
- `getAuthenticatedAccountId` (`src/background/fansly-client.ts:442`) is a thin wrapper returning `.id`.

### 3. `GET /api/v1/message?groupId=…&limit=25&before=…`
- Method: `getMessagePage` (`src/background/fansly-client.ts:485`); routeKey `message`; not optional; retry default.
- Purpose: fetch one page of a conversation's messages (newest-first, walked backward via `before`).
- Query params: `groupId` (required); `limit` = `FANSLY_PAGE_LIMIT` (25, `src/shared/constants.ts:25`); `before` (a message id cursor) is set only when non-null (`src/background/fansly-client.ts:492-496`).
- Response type: `FanslyMessagePageResponse` (`src/shared/types.ts:353`) — `messages`, `accountMedia`, `accountMediaBundles`, optional `accountMediaOrders`. The client itself reads only `messages` (for cursor extraction and count in `loadMessages`); the full page object is returned upward to callers.

### 4. `GET /api/v1/media/orderhistory?…&accountIds=…&limit=100`
- Method: `getMediaOrderHistory` (`src/background/fansly-client.ts:500`, URL at `:506`); routeKey `media`; optional; retry default.
- Purpose: check whether a specific fan purchased a specific media item / bundle.
- Query params: exactly one of `accountMediaId` (when `request.kind === 'single'`) or `accountMediaBundleId` (bundle) set to `request.contentId`; `accountIds` = the fan's account id; `limit` = `'100'` (`src/background/fansly-client.ts:507-513`).
- Response type: `FanslyMediaOrderHistoryResponse` (`src/shared/types.ts:346`). Rows are gathered from BOTH `accountMediaOrderHistory` and `aggregationData.accountMediaOrders` by `extractOrderHistoryRows` (`src/background/fansly-client.ts:166`). Each row's `accountId`, `accountMediaId`, `accountMediaBundleId`, `type` are read for matching (`src/background/fansly-client.ts:194`).

### 5. `GET /api/v1/account?ids=<csv>`
- Method: `getAccountNames` (`src/background/fansly-client.ts:622`, URL at `:627`); routeKey `account`; optional; retry default.
- Purpose: batch-resolve display names for a set of account ids.
- Query param: `ids` = the id array joined by `,` (`src/background/fansly-client.ts:628`).
- Response: tolerant shape — a bare array is returned as-is; otherwise `response.accounts` if present; otherwise `[]` (`src/background/fansly-client.ts:631-643`). Each element is a `FanslyAccountResponse` (`id`, `username?`, `displayName?`, `about?`).

### 6. `GET /api/v1/account/wallets/earnings/stats/accounts?correlationAccountId=…&before=…&after=…`
- Method: `getEarnings` (`src/background/fansly-client.ts:646`, URL at `:653`); routeKey `earnings`; optional; **retry `none`** (`src/background/fansly-client.ts:661`).
- Purpose: lifetime/windowed earnings breakdown from one fan.
- Query params: `correlationAccountId` = fan id; `before` = `windowEndMs`; `after` = `windowStartMs` (millisecond epochs, stringified).
- Response type: `EarningsRow[]` (`src/shared/types.ts:374`) — `type`, `totalGross`, `totalNet`, `accountId`, `correlationAccountId`, `timestamp`. Empty/non-array → returns `null`; otherwise passed to `aggregateEarnings` (`src/background/fansly-client.ts:662-666`).

### 7. `GET /api/v1/messaging/groups?sortOrder=1&flags=0&subscriptionTierId=&listIds=&search=&limit=100&offset=…`
- Callers: `listFanAccounts` (`src/background/fansly-client.ts:675`, URL at `:685`) and `getActiveConversationSubscriptionFromMessagingGroups` (`src/background/fansly-client.ts:749`, URL at `:758`); routeKey `messagingGroups`; not optional; retry default.
- Purpose: enumerate the creator's conversations, newest activity first; also carries per-fan subscription context in `aggregationData`.
- Query params (all fixed except paging): `sortOrder='1'`, `flags='0'`, `subscriptionTierId=''`, `listIds=''`, `search=''`, `limit` = `MESSAGING_GROUPS_PAGE_SIZE` (100, `src/background/fansly-client.ts:62`), `offset` = walked in steps of 100.
- Response type: `FanslyMessagingGroupsResponse` (`src/shared/types.ts:472`). `listFanAccounts` reads `response.data[].groupId` + `response.data[].partnerAccountId` (`src/background/fansly-client.ts:700-708`). The subscription lookup additionally reads `aggregationData.accounts[]` and each account's `subscriberSubscription` record (`src/background/fansly-client.ts:781-787`).

### 8. `GET /api/v1/account/wallets/earnings/monthlystats/accounts?correlationAccountId=…&before=…&after=…`
- Method: `getMonthlyEarnings` (`src/background/fansly-client.ts:728`, URL at `:735`); routeKey `earnings`; optional; **retry `none`** (`src/background/fansly-client.ts:742`).
- Purpose: month-bucketed earnings from one fan.
- Query params: identical shape to endpoint 6 (`correlationAccountId`, `before`, `after`).
- Response type: `MonthlyEarningsRow[]` (`src/shared/types.ts:402`) — `year`, `month`, `totalGross`, `totalNet`, `accountId`, `correlationAccountId`, `timestamp`. Empty/non-array → `[]` (`src/background/fansly-client.ts:743-746`).

### 9. `GET /api/v1/subscribers?before=&after=&status=…&limit=100&offset=…&search=&subscriptionTierId=`
- Method: `getSubscriptionFromSubscribers` (`src/background/fansly-client.ts:805`, URL at `:815`); routeKey `subscribers`; not optional; retry default.
- Purpose: subscribers-list fallback to find a fan's subscription record when the messaging-groups lookup misses.
- Query params: `before=''`, `after=''`, `status` iterated over the two literals `'3,4'` (active) then `'5'` (expired) (`src/background/fansly-client.ts:810`); `limit` = `SUBSCRIBERS_PAGE_SIZE` (100, `src/background/fansly-client.ts:67`); `offset` walked in steps of 100; `search=''`; `subscriptionTierId=''`.
- Response type: `FanslySubscribersResponse` (`src/shared/types.ts:456`). Reads `response.subscriptions[]` (matched by `subscriberId === fanAccountId`) and `response.stats.totalActive` / `response.stats.totalExpired` for early stop (`src/background/fansly-client.ts:830-841`).

## Pagination model

Three distinct pagination schemes are used:

- **Message cursor (endpoints 3)** — `loadMessages` (`src/background/fansly-client.ts:924`) walks backward with `before` set to the id of the oldest message on the previous page. `extractOldestMessageId` returns `messages[messages.length - 1].id` (`src/shared/transcript.ts:592`). The walk stops when `collectedCount >= requestedCount`, or `before` is null, or a short page (`messages.length < FANSLY_PAGE_LIMIT`) is seen (`src/background/fansly-client.ts:951`). `targetPages` is `ceil(requestedCount / 25)` (`src/shared/transcript.ts:588`). A `FANSLY_PAGINATION_DELAY_MS` (300 ms, `src/shared/constants.ts:27`) sleep separates pages (`src/background/fansly-client.ts:955`). `onProgress` reports `{ currentPage, targetPages, pageMessageCount, collectedCount }`.
- **Offset over messaging/groups (endpoint 7)** — page size 100, `offset += 100` per page, hard-bounded at `MESSAGING_GROUPS_MAX_PAGES` = 20 pages (`src/background/fansly-client.ts:66`, loops at `:684` and `:757`). A short page (`groups.length < 100`) ends the walk; hitting the 20-page cap with full pages sets `truncated: true` in `listFanAccounts` (`src/background/fansly-client.ts:725`). 300 ms delay between pages.
- **Offset over subscribers (endpoint 9)** — page size 100 with `offset += 100`, run once per status bucket (`'3,4'` then `'5'`). The inner loop is a `while (true)` with no fixed page cap; it terminates on a short page OR when `offset + 100 >= totalForStatus` (from `stats.totalActive` / `stats.totalExpired`) (`src/background/fansly-client.ts:844-848`). 300 ms delay between pages.

Endpoints 1, 2, 5, 6, 8, and the media orderhistory (4) are single-request (no pagination); endpoint 4 caps its own result at `limit=100`.

## Retry / backoff, Retry-After, timeouts

All handled inside `fetchEnvelope` (`src/background/fansly-client.ts:335`):

- **Per-request timeout:** each attempt creates its own `AbortController` firing after `FANSLY_REQUEST_TIMEOUT_MS` = 30 000 ms (`src/shared/constants.ts:26`), composited with the caller's signal via `AbortSignal.any` (`src/background/fansly-client.ts:348-350`). The timeout is cleared in `finally` (`src/background/fansly-client.ts:423`) so retries don't stack timeouts.
- **Retry count:** `maxAttempts = FANSLY_RETRY_DELAYS_MS.length` (3) for `default`, or `0` for `retryPolicy === 'none'` (`src/background/fansly-client.ts:343`). Retries fire on HTTP `429` and any status `>= 500` while `attempt < maxAttempts` (`src/background/fansly-client.ts:382`) — up to 3 retries, i.e. 4 total requests, before giving up.
- **Backoff delays:** `FANSLY_RETRY_DELAYS_MS = [1000, 2000, 4000]` ms, indexed by attempt (`src/shared/constants.ts:28`).
- **Retry-After:** on a `429`, `parseRetryAfterMs` (`src/background/fansly-client.ts:21`) parses the `retry-after` header as either integer seconds or an HTTP-date, returning ms. When present it overrides the fixed backoff but is clamped to `FANSLY_RETRY_MAX_BACKOFF_MS` = 5 000 ms (`src/shared/constants.ts:31`, applied at `src/background/fansly-client.ts:383`). If the header requests a longer wait, the request is NOT stalled — after retries are exhausted it surfaces as `rate_limited` carrying `retryAfterMs` and `retryAtMs = Date.now() + retryAfterMs` (`src/background/fansly-client.ts:390-397`).
- **Backoff sleeps are abortable:** `delay` (`src/background/fansly-client.ts:89`) is passed the caller's `signal` and rejects with an `AbortError` `DOMException` if already/aborted — verified by the test that aborts mid-500-retry (`tests/fansly-client.test.ts:184`).
- Because `earnings` calls use `retryPolicy: 'none'`, a `429` there throws `rate_limited` on the first response with no retry (`tests/fansly-client.test.ts:242`), and a `5xx` there falls straight through to the not-ok branch (→ `unknown_error`, since those calls are optional).

## Response envelope

Every success path expects `{ success: boolean; response?: T; error?: string }`
(`src/background/fansly-client.ts:408`). If `success` is false or `response` is
`undefined`, it throws `fansly_server_error` (or `unknown_error` when optional)
(`src/background/fansly-client.ts:409-411`). The `error` string field is typed
but not surfaced. Only `response` is returned to callers.

## Media-purchase verification

Entry point `verifyMediaPurchaseStates` (`src/background/fansly-client.ts:572`):

1. Requests are deduped by `${kind}:${contentId}` and blank ids dropped by `uniquePurchaseRequests` (`src/background/fansly-client.ts:221`). Callers pre-cap the list to `FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT` = 10 before calling (`src/shared/constants.ts:32`; enforced in `src/background/conversation-context-loader.ts:40`).
2. Checks run through `mapWithConcurrency` at `FANSLY_MEDIA_PURCHASE_VERIFICATION_CONCURRENCY` = 3 (`src/shared/constants.ts:33`, `src/background/fansly-client.ts:585`).
3. Each `verifyMediaPurchaseState` (`src/background/fansly-client.ts:524`) first checks an in-memory cache keyed `resolvedAccountId|accountId : fanAccountId : kind : contentId` with TTL `FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS` = 5 min (`src/shared/constants.ts:35`, `src/background/fansly-client.ts:298-333`). Only definitive `purchased` / `not-purchased` outcomes are cached (`src/background/fansly-client.ts:560`).
4. On a cache miss it calls endpoint 4 under a further per-check `AbortController` timeout of `FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS` = 3 000 ms (`src/shared/constants.ts:34`, `src/background/fansly-client.ts:536-541`) composited with the caller's signal.
5. Rows from both `accountMediaOrderHistory` and `aggregationData.accountMediaOrders` are combined (`extractOrderHistoryRows`, `src/background/fansly-client.ts:166`), and matched by `orderMatchesPurchaseRequest` (`src/background/fansly-client.ts:194`):
   - `accountId` must equal the fan's id (`src/background/fansly-client.ts:199`).
   - `single`: `accountMediaId === contentId` AND `accountMediaBundleId == null` AND (`type` absent OR `type === 1` = `ORDER_TYPE_SINGLE`) (`src/background/fansly-client.ts:203-208`).
   - `bundle`: if `accountMediaBundleId` present → equals `contentId` AND `type !== 1`; else `type === 2` (`ORDER_TYPE_BUNDLE`) AND `accountMediaId === contentId` (`src/background/fansly-client.ts:211-218`).

**Fail-open semantics:** a malformed response (`extractOrderHistoryRows` returns
null) or a non-abort error yields `null` from the per-check function
(`src/background/fansly-client.ts:551`, `:566`), which the aggregator records as
`verificationIncomplete = true` and adds the id to neither the purchased nor the
"checked not purchased" set (`src/background/fansly-client.ts:595-597`;
tests at `tests/fansly-client.test.ts:383` and `:402`). An abort re-throws
(`src/background/fansly-client.ts:563`). The result
`PurchaseEvidenceOverride` (`src/shared/transcript.ts:32`) carries four id sets
(`purchasedSingleIds`, `purchasedBundleIds`, `checkedNotPurchasedSingleIds`,
`checkedNotPurchasedBundleIds`) plus `verificationIncomplete`.

## Subscription lookup

`getFanSubscriptionContext` (`src/background/fansly-client.ts:859`) resolves a
fan's subscription with a cache-then-groups-then-subscribers cascade, emitting
`SubscriptionLookupTraceEvent`s (`src/background/fansly-client.ts:134`):

1. In-memory cache keyed `resolvedAccountId|accountId : fanAccountId`, TTL `SUBSCRIPTION_CACHE_TTL_MS` = 5 min (`src/background/fansly-client.ts:68`, `:275-296`). A hit (including a cached `null`) short-circuits. `lookupMode === 'cache-only'` returns the cache value or `null` without any request (`src/background/fansly-client.ts:875`; `tests/fansly-client.test.ts:110`).
2. `full` mode first walks endpoint 7 (`getActiveConversationSubscriptionFromMessagingGroups`, `src/background/fansly-client.ts:749`): finds the group by `groupId`, requires `partnerAccountId === fanAccountId`, then reads `aggregationData.accounts[].subscriberSubscription` where `subscriberId === fanAccountId`, normalized with source `'/api/v1/messaging/groups'`.
3. On a groups miss it falls back to endpoint 9 (`getSubscriptionFromSubscribers`), normalized with source `'/api/v1/subscribers'` (`tests/fansly-client.test.ts:127`).
4. Error handling during the groups step: `AbortError` and `session_expired` re-throw; any other error is traced as `groups-error` and the cascade continues to subscribers (`src/background/fansly-client.ts:896-907`).
5. The resolved value (context or `null`) is written to the cache (`src/background/fansly-client.ts:891`, `:920`).

Normalization (`normalizeSubscriberSubscription`,
`src/background/fansly-client.ts:239`) maps a raw
`FanslySubscriberSubscriptionRecord` into a `FanSubscriptionContext`: timestamps
(`renewDate`, `endsAt`, `createdAt`, `promoStartsAt`, `promoEndsAt`) become ISO
strings via `timestampToIso`; `autoRenew` (a number) becomes a boolean
(`> 0`); string fields are trimmed-or-null.

## Error taxonomy

`fetchEnvelope` maps outcomes to `ChatGooseError` keys (definitions in
`src/shared/errors.ts`); `optional` downgrades the non-network server errors to
`unknown_error`:

| Condition | Thrown key | Retried? | Extra fields |
|---|---|---|---|
| HTTP 401 / 403 | `session_expired` (+ `markDisconnected`) | no | `{ status }` (`src/background/fansly-client.ts:373`) |
| HTTP 429, retries exhausted | `rate_limited` | via backoff first | `retryAfterMs`, `retryAtMs`, `details.status: 429` (`src/background/fansly-client.ts:390`) |
| HTTP >= 500 | `fansly_server_error` / `unknown_error` after retries | yes (backoff) | `{ status, responseSnippet }` (`src/background/fansly-client.ts:400`) |
| Other non-2xx | `fansly_server_error` / `unknown_error` | no | `{ status, responseSnippet }` |
| `success === false` or missing `response` | `fansly_server_error` / `unknown_error` | no | — (`src/background/fansly-client.ts:409`) |
| `AbortError` (`DOMException`) | re-thrown unchanged | no | — (`src/background/fansly-client.ts:418`) |
| Any other thrown error (e.g. `fetch` failure) | `network_error` / `unknown_error` | no | — (`src/background/fansly-client.ts:421`) |

`responseSnippet` is the response body truncated to the first 400 characters by
`readResponseSnippet` (`src/background/fansly-client.ts:113`), read only on the
non-ok, non-retry path.

## What crosses the Fansly boundary (data inventory)

**Outbound (extension → Fansly), all in headers or query string (no request body, no cookies):**
- Session credentials captured from the model's live Fansly tab: `authorization` bearer token, `fansly-client-id`, `fansly-session-id`, per-route `fansly-client-check`, plus a fresh `fansly-client-ts` (`src/background/fansly-client.ts:354`).
- Identifiers: conversation `groupId`, fan `accountId`(s), media/bundle `contentId`s, the model's own account resolution (`/account/me`).
- Parameters: paging (`limit`, `offset`, `before` cursor), time windows (`before`/`after` epoch ms), subscription `status` buckets, and fixed empties (`search=''`, etc.).

**Inbound (Fansly → extension), fields the client reads or forwards:**
- Messages: `messages[]` (id, type, content, senderId, createdAt, attachments, tips) plus `accountMedia` / `accountMediaBundles` / `accountMediaOrders` forwarded whole in `FanslyMessagePageResponse` (`src/shared/types.ts:353`).
- Account identity: `id`, `username`, `displayName`, `about` (`src/shared/types.ts:365`).
- Group membership: `users[].userId` (`src/background/fansly-client.ts:432`).
- Order history: `accountId`, `accountMediaId`, `accountMediaBundleId`, `type` per row (`src/shared/types.ts:338`).
- Earnings: per-type `totalGross` / `totalNet` with `accountId` / `correlationAccountId` / `timestamp`, and month-bucketed `year` / `month` totals (`src/shared/types.ts:374`, `:402`).
- Subscriptions: full `FanslySubscriberSubscriptionRecord` — price, renew/promo pricing, tier id/name, plan/gift/promo ids, `status`, and renew/end/created/promo timestamps (`src/shared/types.ts:433`) — plus subscriber `stats` totals (`src/shared/types.ts:427`).
- Rate-limit signal: the `retry-after` response header (`src/background/fansly-client.ts:379`).
