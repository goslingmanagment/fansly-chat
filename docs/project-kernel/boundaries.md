# ChatGoose — External Boundary Contract Catalog

**Scope.** This document catalogs every contract ChatGoose has with the world outside its own extension code, described *from ChatGoose's side*: what it calls, what it observes, what it exposes, and exactly what data crosses each boundary. It is the primary reference for stitching ChatGoose together with the `core` backend ("Agency Hub") and the Fansly platform. Wire-level and DOM-level details are authoritative here; the per-module `NN-*.md` docs describe how each module *uses* these boundaries.

Everything runs inside a Firefox WebExtension (Manifest V3, `manifest.json`). There is no ChatGoose-owned server in this repo — the only ChatGoose-operated remote host is the extension **update/download server** (`ext.gosling-agency.ru`), described in §8. All AI and data traffic goes directly from the user's browser to third-party APIs or to a user-configured `core`/Agency Hub instance.

---

## 0. Boundary index

| # | Boundary | Direction | Transport | Auth | Primary code |
|---|----------|-----------|-----------|------|--------------|
| 1 | **Fansly REST API** (`apiv3.fansly.com`) | ChatGoose → Fansly | `fetch` GET, JSON | Fansly session headers (sniffed) | `src/background/fansly-client.ts` |
| 2 | **Fansly auth capture** | Fansly page → ChatGoose (observed) | `webRequest.onBeforeSendHeaders` | n/a (passive header sniff) | `src/background/session-capture.ts`, `session-store.ts` |
| 3 | **Fansly DOM** (`fansly.com` page) | ChatGoose ↔ page DOM | Content script (read + write) | n/a (runs in page) | `src/content/conversation-dom.ts`, `textarea.ts`, `route-watcher.ts` |
| 4 | **Anthropic Messages API** (`api.anthropic.com`) | ChatGoose → Anthropic | `fetch` POST, SSE stream | `x-api-key` (user's `claudeApiKey`) | `src/background/anthropic-client.ts` |
| 5 | **OpenRouter API** (`openrouter.ai`) | ChatGoose → OpenRouter | `fetch` POST, SSE stream | `Bearer` (user's `openRouterApiKey`) | `src/background/openrouter-client.ts` |
| 6 | **Agency Hub / `core`** (configurable host) | ChatGoose ↔ core | `fetch` GET/PUT/POST, JSON | `Bearer` (user's `agencyHubApiKey`) | `src/background/agency-hub-client.ts`, `shared/agency-hub.ts` |
| 7 | **Browser storage** (`storage.local`) | ChatGoose ↔ browser | `browser.storage.local` | n/a | `src/shared/storage.ts`, `background/storage-coordinator.ts` |
| 8 | **Distribution / auto-update** | Firefox → ChatGoose server | HTTPS static files | n/a | `manifest.json`, `scripts/deploy.sh` |
| 9 | **Other browser APIs** (`tabs`, `permissions`, `clipboard`, `runtime`) | ChatGoose ↔ browser | WebExtension APIs | n/a | various |
| — | *(Internal)* content ↔ background ↔ popup/options IPC | intra-extension | `runtime.connect` Port + `runtime.sendMessage` | n/a | `src/shared/protocol.ts`, `types.ts` |

**Declared permissions** (`manifest.json`):
- `permissions`: `storage`, `unlimitedStorage`, `webRequest`, `tabs`.
- `host_permissions` (granted at install): `*://fansly.com/*`, `*://apiv3.fansly.com/*`, `*://api.anthropic.com/*`, `https://openrouter.ai/*`.
- `optional_host_permissions`: `http://*/*`, `https://*/*` — requested on demand so the user's chosen Agency Hub origin (any host) can be reached (see §6; the request is issued from `src/options/index.ts:493`).
- `content_scripts`: `content.js` injected at `document_idle` on `*://fansly.com/*` only.
- `browser_specific_settings.gecko.data_collection_permissions.required`: `authenticationInfo`, `personallyIdentifyingInfo`, `personalCommunications`, `financialAndPaymentInfo`, `websiteContent` — Firefox's declared data-collection categories for this add-on.

---

## 1. Fansly REST API (outbound)

**File:** `src/background/fansly-client.ts` (class `FanslyClient`). **Base:** `https://apiv3.fansly.com/api/v1` (`FANSLY_API_BASE` in `constants.ts`, though the client builds full URLs inline). All calls are `GET` with `credentials: 'omit'`; auth travels entirely in headers copied from a captured session (see §2). Every request URL gets `ngsw-bypass=true` appended (`withNgswBypass`, `fansly-client.ts:64`) to skip Fansly's Angular service worker.

### 1.1 Request envelope, headers, and reliability (`fetchEnvelope`, `fansly-client.ts:315`)

Headers set on every request:

| Header | Source | Notes |
|--------|--------|-------|
| `authorization` | `session.authorization` | Fansly bearer/legacy token, captured in §2 |
| `fansly-client-id` | `session.fanslyClientId` | captured |
| `fansly-client-ts` | `String(Date.now())` | fresh per request |
| `fansly-session-id` | `session.fanslySessionId` | captured |
| `fansly-client-check` | `session.routeChecks[routeKey] ?? session.latestCheck` | per-route anti-abuse token; omitted if none captured |

Behavior:
- **Timeout:** each attempt has its own `AbortController` firing at `FANSLY_REQUEST_TIMEOUT_MS` = 30 000 ms, composed with the caller's signal via `AbortSignal.any`.
- **Retry:** `FANSLY_RETRY_DELAYS_MS = [1000, 2000, 4000]` (max 3 retries) on `429` and `>=500`. `retryPolicy: 'none'` disables retries (used by best-effort earnings calls).
- **429 handling:** `Retry-After` parsed (`parseRetryAfterMs`, from `llm-stream-utils.ts`); a retry honors it but caps the wait at `FANSLY_RETRY_MAX_BACKOFF_MS` = 5 000 ms. If retries are exhausted, throws `ChatGooseError('rate_limited')` with `retryAfterMs`/`retryAtMs`.
- **401/403:** calls `sessionStore.markDisconnected(session.accountId)` and throws `ChatGooseError('session_expired')`.
- **Envelope:** expects `{ success: boolean, response?: T, error?: string }`; on `!success` or missing `response` throws `fansly_server_error` (or `unknown_error` when `optional`).
- **`optional` flag:** on failure throws `unknown_error` instead of `fansly_server_error` (used where the caller discards failures).
- **Pagination pacing:** `FANSLY_PAGINATION_DELAY_MS` = 300 ms between pages.

### 1.2 Endpoint catalog

| Method / path | Query params | RouteKey | Retry | Purpose (caller) |
|---|---|---|---|---|
| `GET /group/{groupId}/` | — | `group` | default, `optional` | Group→user members (`getGroup`) |
| `GET /account/me` | — | `account` | default | Authenticated creator identity (`getAuthenticatedAccount`) — sets `resolvedAccountId/Username/DisplayName` on the session |
| `GET /account` | `ids=<csv>` | `account` | default, `optional` | Batch account name/displayName lookup (`getAccountNames`); tolerates array or `{accounts:[]}` |
| `GET /message` | `groupId`, `limit` (=`FANSLY_PAGE_LIMIT` 25), `before?` | `message` | default | Paginated conversation messages (`getMessagePage` / `loadMessages`) |
| `GET /media/orderhistory` | `accountMediaId`\|`accountMediaBundleId`, `accountIds`, `limit=100` | `media` | default, `optional` | PPV purchase verification (`getMediaOrderHistory`) |
| `GET /account/wallets/earnings/stats/accounts` | `correlationAccountId`, `before`(=windowEndMs), `after`(=windowStartMs) | `earnings` | **none**, `optional` | Per-fan lifetime/window earnings (`getEarnings`) |
| `GET /account/wallets/earnings/monthlystats/accounts` | `correlationAccountId`, `before`, `after` | `earnings` | **none**, `optional` | Per-fan monthly breakdown (`getMonthlyEarnings`) |
| `GET /messaging/groups` | `sortOrder=1`, `flags=0`, `subscriptionTierId=`, `listIds=`, `search=`, `limit=100`, `offset` | `messagingGroups` | default | Enumerate conversations + inline subscription data (`listFanAccounts`, `getActiveConversationSubscriptionFromMessagingGroups`) |
| `GET /subscribers` | `before=`, `after=`, `status`(`3,4` then `5`), `limit=100`, `offset`, `search=`, `subscriptionTierId=` | `subscribers` | default | Subscription fallback lookup by subscriber id (`getSubscriptionFromSubscribers`) |

### 1.3 Notable multi-call flows

- **`loadMessages`** (`fansly-client.ts:904`): pages backward using the oldest message id as the `before` cursor (`extractOldestMessageId` from `transcript.ts`) until `requestedCount` collected or a short page arrives. `estimateTargetPages` sets the progress denominator.
- **PPV purchase verification** (`verifyMediaPurchaseStates`, `:552`): dedupes `PpvAttachmentRequest[]`, fetches order history per unique item at concurrency `FANSLY_MEDIA_PURCHASE_VERIFICATION_CONCURRENCY` (3) with a per-check timeout `FANSLY_MEDIA_PURCHASE_VERIFICATION_TIMEOUT_MS` (3 000 ms), and matches orders (single vs bundle, order `type` constants `1`/`2`). Returns a `PurchaseEvidenceOverride` (sets of purchased/checked-not-purchased single/bundle ids + `verificationIncomplete`). Results cached in `mediaPurchaseVerificationCache` for `FANSLY_MEDIA_PURCHASE_VERIFICATION_CACHE_TTL_MS` (5 min).
- **Spenders enumeration** (`listFanAccounts`, `:655`): walks `/messaging/groups` up to `MESSAGING_GROUPS_MAX_PAGES` (20) × 100 = 2 000 conversations, dedupes by `partnerAccountId`, bounded by `maxFans`; returns `{fans, truncated}`. Feeds `SpendersService`.
- **Subscription context** (`getFanSubscriptionContext`, `:839`): cache → `/messaging/groups` inline `aggregationData.accounts[].subscriberSubscription` → fallback `/subscribers` scan (active `status=3,4`, then expired `status=5`). Emits `SubscriptionLookupTraceEvent`s. Result cached in `subscriberSubscriptionCache` for 5 min. `lookupMode: 'cache-only'` short-circuits. Normalized into `FanSubscriptionContext` with `source` tag `/api/v1/messaging/groups` or `/api/v1/subscribers`.

### 1.4 Data leaving ChatGoose
Only the captured Fansly session headers and query params above. No ChatGoose- or AI-derived data is ever sent to Fansly over REST. Data returned from Fansly (messages, earnings, subscriptions, account identities) is used to build transcripts/context and, selectively, forwarded to the AI providers (§4/§5) and Agency Hub (§6).

---

## 2. Fansly auth capture (passive observation)

**File:** `src/background/session-capture.ts`; stored by `src/background/session-store.ts`. Wired in `background/index.ts:41`.

ChatGoose never logs into Fansly. It **observes the Fansly web app's own API requests** to obtain session credentials:

- Listener: `browser.webRequest.onBeforeSendHeaders`, filter `{ urls: ['https://apiv3.fansly.com/*'] }`, extraInfo `['requestHeaders']`.
- Requests with `details.tabId < 0` (non-tab / extension-origin) are ignored.
- `extractCapture` requires **4 mandatory headers**: `authorization`, `fansly-client-id`, `fansly-client-ts`, `fansly-session-id`. Optional 5th: `fansly-client-check`.
- The account id is derived by base64-decoding the `authorization` value and taking the substring before the first `:` (`decodeLegacyAccountKey`, `:4`).
- `normalizeRouteKey(url)` (`:14`) maps the observed URL to a `RouteKey` (`earnings`/`subscribers`/`media`/`messagingGroups`/`group`/`message`/`account`). The per-route `fansly-client-check` is retained so §1 replays the correct check token per route (`routeChecks[routeKey]`).
- Result is a `SessionCaptureResult` registered per tab via `sessionStore.registerCapture(tabId, capture)`, and `onCapture(tabId, accountId)` fires (→ `storageCoordinator.registerKnownAccount` + `coordinator.handleCapture`).

**Data crossing:** Fansly credentials flow one way, page→extension, and are held **in memory** in `SessionStore` (per tab). They are replayed only against `apiv3.fansly.com` (§1). (Whether/where they are persisted is documented in `02-background-runtime-messaging.md` and `14-shared-storage-migrations-utils.md`.)

---

## 3. Fansly DOM boundary (content script read + write)

**Files:** `src/content/conversation-dom.ts` (read), `src/content/textarea.ts` (write), `src/content/route-watcher.ts` (route), plus mount logic in `conversation-mount-controller.ts`. The content script runs inside the `fansly.com` page and depends on Fansly's Angular component tag names.

### 3.1 Route detection (`route-watcher.ts`)
Polls `location` every `ROUTE_POLL_INTERVAL_MS` (500 ms). The conversation **`groupId`** is parsed from the URL and a monotonically increasing `routeNonce` is bumped on change; `tab:init` / `tab:routeChanged` Port messages carry `{ groupId, routeNonce }` to the background (used to gate stale operations).

### 3.2 Reading the conversation (`conversation-dom.ts`)
Selectors (exact strings):

| Constant | Selector | Use |
|---|---|---|
| `ROUTE_ROOT_SELECTOR` | `app-messages-conversation-route` | active conversation root |
| `INPUT_HOST_SELECTOR` | `app-group-message-input` | composer host |
| (container) | `app-group-message-container` (via `.closest`) | mount container |
| `USER_NAME_SELECTOR` | `app-account-username .user-name` | fan display name (primary) |
| `COMPOSER_LABEL_SELECTOR` | `app-group-message-input .label` | fan display name (fallback) |
| `TEXTAREA_SELECTORS` | `app-group-message-input textarea`, `textarea.message-input`, `textarea[placeholder*="message"]` | composer textarea (first usable wins) |

- `getActiveConversationDom()` returns `{ routeRoot, container, inputHost, inputParent, displayName }` or `null`.
- Display name parsing (`parseDisplayName`): extracts `@handle` via `/@([^\s]+)/`, else strips a leading `Message ` prefix.
- `isUsableTextarea` requires an enabled, non-readonly, visible (`offsetParent !== null`) `HTMLTextAreaElement`.

### 3.3 Writing the reply (`textarea.ts`)
- `insertIntoFanslyTextarea(text)`: focuses + selects the textarea, tries `document.execCommand('insertText', false, text)`; if the value doesn't match, falls back to setting `.value` and dispatching bubbling `input` + `change` events (to drive Angular's model). Throws `ChatGooseError('insertion_failed')` if no textarea or if the value still doesn't match.
- `getActiveConversationDraftText()` reads the current composer value (used to feed `improve-draft`/compare draft context).
- `focusActiveConversationTextarea()` focuses and moves the caret to end. `copyToClipboard(text)` uses `navigator.clipboard.writeText`.

**Data crossing:** ChatGoose reads the fan's `@handle`/display name and the creator's current draft text out of the DOM, and writes generated reply text into the composer. It does **not** read the message history from the DOM — message content comes from the REST API (§1).

---

## 4. Anthropic Messages API (outbound)

**File:** `src/background/anthropic-client.ts` (`AnthropicClient.streamMessage`). Reached via `LlmClient` (`llm-client.ts`) when the resolved model's provider is `ANTHROPIC_PROVIDER`. **URL:** `https://api.anthropic.com/v1/messages` (`CLAUDE_API_URL`). **Method:** `POST`, streaming SSE.

**Headers:**
| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `x-api-key` | user's `settings.claudeApiKey` |
| `anthropic-version` | `2023-06-01` (`ANTHROPIC_VERSION`) |
| `anthropic-dangerous-direct-browser-access` | `true` (enables direct browser calls / CORS) |

**Request body:**
- `model` — provider model id (from registry `providerModelId`).
- `stream: true`.
- `max_tokens` — `resolveMaxTokens(model, feature)`: adaptive-thinking models use `getAnthropicAdaptiveThinkingMaxTokens(feature)`, else `MAX_TOKENS[feature]` (per-feature caps in `constants.ts`, e.g. `fan-summary` 8192).
- Adaptive thinking (when `supportsAnthropicAdaptiveThinking(model)` and effort ≠ `off`): `thinking: { type: 'adaptive', display: 'summarized' }` and `output_config: { effort }` where effort ∈ `low|medium|high|max`. When thinking is on, `temperature` is **omitted**; otherwise `temperature` (per-feature, `FEATURE_TEMPERATURES` / `COMPARE_TEMPERATURE`) is sent.
- `system` — `PromptTextBlock[]` (text blocks that may carry `cache_control` breakpoints; prompt caching is on by `settings.promptCachingEnabled`).
- `messages` — `[{ role: 'user', content: userBlocks }]` (`PromptTextBlock[]`).

**Response handling:** SSE parsed by `parseSseBlock` (blocks split on `\r?\n\r?\n`). Consumes `message_start` / `message_delta` (usage + `stop_reason`), `content_block_delta` with `text_delta` (appended + streamed via `onText`), plus reasoning signals (`thinking`/`redacted_thinking`/`thinking_delta`/`signature_delta`/`reasoning`). Usage accumulated into `LlmUsageMetrics` (`input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `cache_creation.ephemeral_{5m,1h}_input_tokens`). The reader is always `cancel()`ed on exit.

**Error classification** (`buildAnthropicError`, `anthropic-client.ts:177`) → `ChatGooseError` keys:
| Condition | Error key |
|---|---|
| 429 / `rate_limit_error` / "rate limit" | `rate_limited` |
| `insufficient_balance_error`/`payment_required_error` or phrase match | `insufficient_balance` |
| 401 / 403 | `invalid_api_key` |
| `not_found_error` / model phrases | `model_unavailable` |
| 413 / context phrases | `context_too_long` |
| 529 / ≥500 / `overloaded_error` | `service_unavailable` |
| 400 | `unknown_error` |
| 0 / other | `service_unavailable` / `network_error` |

**Data crossing:** the assembled prompt — system prompt + personality + a transcript of the fan↔creator conversation (message text, PPV/purchase context, fan spend/subscription context) + the creator's draft — leaves the browser to Anthropic under the user's own API key. Token-usage metrics come back and feed cost estimation (`llm-cost.ts`) and Agency Hub AI-usage reporting (§6).

---

## 5. OpenRouter API (outbound)

**File:** `src/background/openrouter-client.ts` (`OpenRouterClient.streamMessage`). Reached via `LlmClient` when provider is `OPENROUTER_PROVIDER`. **URL:** `https://openrouter.ai/api/v1/messages` (`OPENROUTER_MESSAGES_API_URL`) — the Anthropic-compatible Messages endpoint, not the OpenAI `chat/completions` shape. **Method:** `POST`, streaming SSE.

**Headers:** `authorization: Bearer <openRouterApiKey>`, `content-type: application/json`, `x-openrouter-title: ChatGoose`.

**Request body:** `model`, `temperature`, `stream: true`, `max_tokens` (`resolveMaxTokens`; Gemini uses `getOpenRouterGeminiThinkingMaxTokens`), optional Gemini thinking config `{ thinking: { type: 'adaptive', display: 'omitted' }, output_config: { effort } }` (effort `max`→`high`), `system` and `messages` as `PromptTextBlock[]` **with `cache_control` stripped** (`stripCacheControl`, `:141` — OpenRouter Grok caches automatically; Gemini explicit caching is intentionally not wired).

**Response handling:** same SSE loop as Anthropic, but gated to `SUPPORTED_OPENROUTER_SSE_EVENTS` (`message_start/delta/stop`, `content_block_*`, `ping`, `error`). If an OpenAI-style `chat.completion.chunk` / `choices` array arrives, it throws `unknown_error` (explicitly rejects the non-Messages shape). Usage is normalized (`normalizeUsage`, `:152`): maps `prompt_tokens`/`completion_tokens` and `prompt_tokens_details.{cached_tokens,cache_write_tokens}` into the `LlmUsageMetrics` cache fields.

**Error classification** (`buildOpenRouterError`, `:234`): 429→`rate_limited`; 402/credit phrases→`insufficient_balance`; 401/403→`invalid_api_key`; 404/model phrases→`model_unavailable`; 413/context phrases→`context_too_long`; 502/503/≥500→`service_unavailable`; 400→`unknown_error`; 0→`service_unavailable`; else `network_error`. `details.provider = 'openrouter'` is attached.

**Data crossing:** identical prompt payload as §4, sent to OpenRouter under the user's OpenRouter key when an OpenRouter-hosted model is selected for a feature.

---

## 6. Agency Hub / `core` (the inter-project boundary)

**Files:** `src/background/agency-hub-client.ts` (`AgencyHubClient`), `src/shared/agency-hub.ts` (URL/username normalization + sync-metadata helpers), `src/background/agency-hub-usage-reporter.ts` (batching). This is ChatGoose's contract with the `core` backend documented in its own pass. It is **optional and user-configured**: `settings.agencyHubBaseUrl` + `settings.agencyHubApiKey`.

**Configuration & gating:**
- `isConfigured` requires a normalized base URL + non-empty API key.
- `normalizeAgencyHubBaseUrl` (`agency-hub.ts:9`): trims, requires `http:`/`https:`, strips trailing slashes; `buildAgencyHubUrl(base, path)` joins path onto `base + '/'`.
- **Host permission:** because the base URL is arbitrary, every call first checks `browser.permissions.contains({ origins: [ '<proto>//<host>/*' ] })` (`buildAgencyHubOriginPattern`, in `shared/agency-hub.ts`). If absent → result `skipped`/error `hub_missing_permission`. The options page requests this optional permission (`optional_host_permissions`, §0) with `browser.permissions.request(...)` in `src/options/index.ts:493`; `src/options/agency-hub-settings.ts` only performs the `permissions.contains` pre-check (`getAgencyHubPermissionCheck`, `:79`), not the request.
- **Auth:** `authorization: Bearer <agencyHubApiKey>` on every request.

**Endpoints called** (all under the configured base):

| Method / path | Request body | Success response (parsed shape) | Caller |
|---|---|---|---|
| `GET api/v1/pages` | — | `AgencyHubPageSummary[]` = `{ label, platform: 'fansly'\|'onlyfans', username: string\|null }` | `listVisiblePages` — used by every profile op + connection test |
| `GET api/v1/pages/{pageLabel}/conversations/{conversationId}/profile` | — | `{ fan: { platform, platformUserId, username, displayName, createdAtExternal }, profile: { version, body, source, createdAt, createdByUserId } \| null }`; `404`→`null` | `getConversationProfile` (fetch stored fan profile) |
| `PUT api/v1/pages/{pageLabel}/fans/{platformUserId}/profile` | `{ body: string }` (JSON) | (status only) | `putFanProfile` (push generated fan summary) |
| `POST api/v1/ai-usage/batch` | `{ events: AgencyHubAiUsageEvent[] }` | `AgencyHubAiUsageBatchResponse` = `{ receivedCount, insertedCount, dedupedCount }` | `postAiUsageBatch` (usage telemetry) |

**Page resolution:** `resolvePageLabel` (`agency-hub-client.ts:180`) matches the current Fansly page username against `GET /pages` (platform `fansly`, normalized username) and requires **exactly one** match to obtain the `pageLabel` used in path segments; ambiguous/zero matches → `hub_page_match_failed`.

**Fan profile push** (`pushFanProfile`, `:401`): guards missing base/key/permission/body; enforces `AGENCY_HUB_PROFILE_MAX_BYTES` = 50 000 UTF-8 bytes; resolves page label; **idempotency** via `hasAgencyHubSyncMetadata(existingSync, baseUrl, pageLabel, generatedAt)` → returns `already-synced` without a PUT when the same generation was already synced. Otherwise `PUT`s the summary body keyed by the fan's Fansly `platformUserId`. Result statuses: `pushed | already-synced | skipped | failed`, each with a `reason` and optional `UserFacingError`.

**Fan profile fetch** (`fetchFanProfileByConversation`, `:532`): resolves page label, `GET`s the conversation profile, returns the stored `body` (+ `createdAtMs`, `fanAccountId`) as context to prepend to prompts; also size-checked at 50 000 bytes. Statuses: `fetched | not-found | skipped | failed`. Consumed by `conversation-context-loader.ts`.

**Connection test** (`testConnection`, `:289`): validates URL/key/permission then calls `GET /pages`; used by the options page (`testAgencyHubConnection` runtime request, §internal). Timeout `AGENCY_HUB_PREFETCH_TIMEOUT_MS` = 5 000 ms.

**AI-usage telemetry** (`agency-hub-usage-reporter.ts` buffers events via its `enqueue` method, then calls `AgencyHubClient.submitAiUsageBatch` — defined in `agency-hub-client.ts:323` — to POST them): each `AgencyHubAiUsageEvent` carries:
```
{ clientEventId, feature, model, inputTokens, outputTokens,
  cacheWriteTokens, cacheReadTokens, conversationId|null,
  durationMs|null, isCacheHit, isRegeneration, completedAt(ISO) }
```
Batching: debounce `AGENCY_HUB_AI_USAGE_REPORT_DEBOUNCE_MS` (1 000 ms), max `AGENCY_HUB_AI_USAGE_BATCH_MAX_EVENTS` (100) per POST (over-cap → `failed`/`too_many_events`), retry up to `AGENCY_HUB_AI_USAGE_REPORT_MAX_ATTEMPTS` (3) with delays `[5000, 15000]` ms, POST timeout `AGENCY_HUB_AI_USAGE_REPORT_TIMEOUT_MS` (5 000 ms). Statuses: `submitted | skipped | failed`.

**HTTP error mapping** (`createHubResponseError`, `:144`): `401`/`403` → `hub_invalid_api_key`, else `hub_request_failed`; a ≤400-char response snippet is attached to `details`. Abort → `hub_timeout`.

**Data crossing (both directions):**
- **ChatGoose → core:** the Fansly page username (to resolve the label), the fan's Fansly `platformUserId`/`conversationId`, AI-generated fan **summary text** (the `body`), and AI-usage metering (model, token counts, feature, conversation id, timing). The `core` `pageLabel` acts as the join key between a ChatGoose creator session and a `core` "page".
- **core → ChatGoose:** the visible page list (`label`/`platform`/`username`), and a previously-stored fan profile `body` + fan identity (`platformUserId`, `username`, `displayName`, `createdAtExternal`).

---

## 7. Browser storage (`storage.local`)

**Files:** `src/shared/storage.ts`, mirrored in-memory by `src/background/storage-coordinator.ts`. Persisted under `browser.storage.local` (with `unlimitedStorage`). Top-level keys (from `PersistedState`, `types.ts:98`, and `constants.ts`):
- `schemaVersion` (current `STORAGE_SCHEMA_VERSION` = 7; migrations in `shared/migrations.ts`).
- `settings` (`Settings`: `claudeApiKey`, `openRouterApiKey`, `agencyHubBaseUrl`, `agencyHubApiKey`, message counts, `debugMode`, `promptCachingEnabled`, `featureModels`, `featureReasoning`).
- `personalities` (`Personality[]`), `accountMappings` (`Record<accountId, personalityId>`), `accountAliases` (`Record<legacyId, resolvedId>`), `knownAccounts` (`string[]`).
- Per-fan summary cache entries under prefix `summary:` (`SUMMARY_CACHE_PREFIX`), each a `SummaryCacheEntry` (includes `agencyHubSync` metadata linking a cached summary to a §6 push).

`background/index.ts:68` listens to `storage.onChanged`; changes to `UI_RELEVANT_KEYS` (`settings`, `personalities`, `accountMappings`, `accountAliases`, `knownAccounts`, `schemaVersion`) trigger a `settings:changed` broadcast to all tabs. API keys are stored in `storage.local` in plaintext (the extension's trust model).

---

## 8. Distribution & auto-update (ChatGoose-operated host)

**Files:** `manifest.json` (`browser_specific_settings.gecko`), `scripts/deploy.sh`, `scripts/deploy-pages.sh`, `scripts/setup-vps-ext.sh`, `.env.deploy`. Detailed in `01-build-packaging.md`.

- The add-on is **self-distributed** (not via AMO listing): `gecko.update_url = https://ext.gosling-agency.ru/updates.json`. Firefox polls that JSON for new signed XPI versions; a missing `applications.gecko` compatibility block in `updates.json` silently breaks auto-update (a known operational hazard for this project).
- `gecko.id = chatgoose@gosling.agency`, `strict_min_version = 142.0`.
- `deploy.sh` builds (`esbuild`), signs the XPI (`web-ext` with `WEB_EXT_API_KEY`/`WEB_EXT_API_SECRET` from `.env.deploy`), and uploads the XPI + `updates.json` to the VPS host. `deploy-pages.sh` publishes the static `guide.html`/`install.html`/`changelog.html` (user-facing pages) to GitHub Pages. `setup-vps-ext.sh` provisions the VPS.

**Data crossing:** the browser downloads XPI packages and `updates.json` from `ext.gosling-agency.ru` over HTTPS. No user data flows to this host from the extension at runtime.

---

## 9. Other browser-API boundaries

- **`tabs`**: `runtime-api.ts` uses `browser.tabs.get` / `browser.tabs.query` (active tab) to resolve popup status; `background/index.ts` listens to `tabs.onRemoved` to tear down per-tab state.
- **`permissions`**: optional host-permission checks/requests for the Agency Hub origin (§6).
- **`clipboard`**: `navigator.clipboard.writeText` in `content/textarea.ts` (copy reply).
- **`runtime`**: `runtime.connect` (Port) and `runtime.sendMessage` for internal IPC (below).

---

## (Internal) Content ↔ Background ↔ Popup/Options IPC

Not an external boundary, but the seam between the extension's own contexts; the reviewer may treat it as the extension's internal API. Defined by `src/shared/types.ts` and validated by `src/shared/protocol.ts`.

**Channel A — long-lived Port** (`runtime.connect`, content↔background): carries operation streaming.
- Content→bg (`ContentPortMessage`): `tab:init`, `tab:routeChanged` (`{groupId, routeNonce}`), `operation:start` (`{operationId, feature, groupId, routeNonce, domFanDisplayName, draftText?, forceRegenerate?, replyMode?, replyTone?}`), `compare:start`, `operation:cancel`, `compare:cancel` (`{operationId}`).
- Bg→content (`BackgroundPortMessage`): `operation:chunk` / `operation:progress` / `operation:complete` / `operation:error` / `operation:discarded` / `operation:debugPrompt`; `compare:ready` / `compare:chunk` (`{cardId}`) / `compare:cardComplete` / `compare:cardError` / `compare:complete` / `compare:error` / `compare:discarded` / `compare:progress`; plus broadcast `tab:state`, `settings:changed`, `mapping:changed`, `summary:syncStatus`. Every message is shape-checked by `isContentPortMessage` / `isBackgroundPortMessage`.

**Channel B — one-shot `runtime.sendMessage`** (popup/options/content→background), typed by `RuntimeRequestMap`/`RuntimeResponseMap` and dispatched in `runtime-api.ts`:
| Request | Payload | Response |
|---|---|---|
| `getPopupStatus` | `{tabId?}` | `PopupStatus` (connection, api-key readiness, mapped personality, compare card counts, account label) |
| `getSessionsSnapshot` | — | `SessionSnapshotEntry[]` (options sessions list; enriches identities via §1 `/account/me`) |
| `testAgencyHubConnection` | `{settings:{agencyHubBaseUrl,agencyHubApiKey}}` | `AgencyHubConnectionTestResponse` (§6 test) |
| `getSpendersList` | `{refresh?}` | `SpendersListResponse` (`{ok,result:{entries[],builtAt,fanCount,scannedCount,truncated}}` or `{ok:false,error}`) |
