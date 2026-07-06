> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Background — LLM Provider Clients

## Scope

This document maps the LLM dispatch and provider-client layer of the ChatGoose background service worker. It covers exactly these five files (all read fully from source):

- `src/background/llm-client.ts` — `LlmClient`, the provider-routing façade.
- `src/background/anthropic-client.ts` — `AnthropicClient`, direct POST to the Anthropic Messages API.
- `src/background/openrouter-client.ts` — `OpenRouterClient`, POST to OpenRouter's Anthropic-compatible Messages API.
- `src/background/llm-stream-utils.ts` — shared SSE-parsing, reasoning-extraction, usage-merge, and retry-after helpers.
- `src/background/llm-cost.ts` — token→USD cost estimation and spend-summary construction.

Supporting shared modules are described only where these five touch them: `shared/constants.ts`, `shared/model-registry.ts`, `shared/model-capabilities.ts`, `shared/types.ts`, `shared/errors.ts`.

The four external boundaries are catalogued centrally in `docs/project-kernel/boundaries.md`. This document does not re-derive its contract tables but documents how these five files cross boundaries 4 (Anthropic) and 5 (OpenRouter).

---

## Dispatch chain (overview)

```
OperationCoordinator (operations.ts:2363)          ─┐
CompareCoordinator  (compare-operations.ts:1040)   ─┴─▶ LlmClient.streamMessage(args)
                                                          │  getModelEntry(args.model) → provider
                                                          │  guard: missing_api_key / model_unavailable
                                                          ├─ ANTHROPIC_PROVIDER  ▶ AnthropicClient.streamMessage  ▶ POST api.anthropic.com/v1/messages
                                                          └─ OPENROUTER_PROVIDER ▶ OpenRouterClient.streamMessage ▶ POST openrouter.ai/api/v1/messages
                                                                                     both use llm-stream-utils for SSE parsing / usage merge
```

Cost accounting (`llm-cost.ts`) is a **sibling** module: the provider clients emit `LlmUsageMetrics` via the `onUsage` callback; the operation coordinators (`operations.ts`, `compare-operations.ts`) then call `estimateLlmCost` / `buildLlmSpendSummary`. The provider clients themselves never import `llm-cost.ts`.

---

## `src/background/llm-client.ts`

Thin provider-routing façade. No network, storage, DOM, or streaming logic of its own.

### Imports
- `ChatGooseError` from `../shared/errors.js`.
- `ANTHROPIC_PROVIDER`, `getModelEntry`, `OPENROUTER_PROVIDER` from `../shared/model-registry.js`.
- Types `LlmUsageMetrics`, `FeatureType`, `LlmReasoningSignal`, `PromptTextBlock`, `ReasoningEffort`, `Settings` from `../shared/types.js`.
- `AnthropicClient` from `./anthropic-client.js`, `OpenRouterClient` from `./openrouter-client.js`.

### `interface LlmStreamArgs` (exported, `llm-client.ts:18-33`)
The public arg shape the operation layer passes. Fields:

| Field | Type | Notes |
|---|---|---|
| `settings` | `Pick<Settings, 'claudeApiKey' \| 'openRouterApiKey'>` | Only the two API-key fields are read. |
| `model` | `string` | Registry id, e.g. `anthropic:claude-sonnet-4-6` (not the raw provider id). |
| `temperature` | `number` | |
| `systemBlocks` | `PromptTextBlock[]` | `{ type: 'text'; text; cache_control? }`. |
| `userBlocks` | `PromptTextBlock[]` | |
| `feature` | `FeatureType` | Drives `max_tokens` + thinking-token tables. |
| `reasoningEffort` | `ReasoningEffort` | `'off' \| 'low' \| 'medium' \| 'high' \| 'max'`. |
| `signal` | `AbortSignal` | Passed straight to `fetch`. |
| `onText` | `(text: string) => void` | Required; text deltas. |
| `onUsage?` | `(usage: LlmUsageMetrics) => void` | Fired on usage change. |
| `onProgress?` | `() => void` | Fired per parsed SSE payload. |
| `onReasoningObserved?` | `(signal: LlmReasoningSignal) => void` | |
| `onReasoningDelta?` | `(text: string) => void` | Summarized thinking text. |
| `onStopReason?` | `(stopReason: string \| null) => void` | |

### `class LlmClient` (exported, `llm-client.ts:35-75`)
- Constructor takes `anthropicClient: AnthropicClient` and `openRouterClient: OpenRouterClient` (both `private readonly`). Wired in `background/index.ts:24` as `new LlmClient(anthropicClient, openRouterClient)`.

- `async streamMessage(args: LlmStreamArgs): Promise<string>` — control flow:
  1. `const model = getModelEntry(args.model)`. If `null` → `throw new ChatGooseError('model_unavailable')` (`llm-client.ts:42-45`). `getModelEntry` normalizes legacy raw Anthropic ids to registry ids first (`model-registry.ts:186-207`).
  2. `if (model.provider === ANTHROPIC_PROVIDER)`: if `!args.settings.claudeApiKey` → `throw new ChatGooseError('missing_api_key', { details: { provider: ANTHROPIC_PROVIDER } })`. Else `return this.anthropicClient.streamMessage({ ...args, apiKey: args.settings.claudeApiKey, model: model.providerModelId })` (`llm-client.ts:47-58`).
  3. `if (model.provider === OPENROUTER_PROVIDER)`: symmetric — guard `openRouterApiKey`, `details.provider = OPENROUTER_PROVIDER`, call `openRouterClient.streamMessage({ ...args, apiKey: args.settings.openRouterApiKey, model: model.providerModelId })` (`llm-client.ts:60-71`).
  4. Fallthrough `throw new ChatGooseError('model_unavailable')` (`llm-client.ts:73`) — defensive; unreachable given the registry only holds these two providers.

- **`providerModelId` translation:** the caller-facing `model` (e.g. `anthropic:claude-sonnet-4-6`) is replaced by `model.providerModelId` (e.g. `claude-sonnet-4-6`) before hitting the provider client. Downstream capability checks (`supportsAnthropicAdaptiveThinking`, `isOpenRouterGeminiModel`) key off this raw provider id.

- **Discrepancy (harmless):** `{ ...args }` spreads the whole `LlmStreamArgs` — including `settings` — into the provider call. Neither `AnthropicStreamArgs` nor `OpenRouterStreamArgs` declares a `settings` field, so the extra property is carried through and ignored (the API keys are supplied explicitly via `apiKey`).

---

## `src/background/anthropic-client.ts`

Direct streaming client for the Anthropic Messages API. Boundary 4.

### Imports
- `ANTHROPIC_VERSION`, `CLAUDE_API_URL`, `MAX_TOKENS` from `../shared/constants.js`.
- `ChatGooseError` from `../shared/errors.js`.
- `getAnthropicAdaptiveThinkingMaxTokens`, `supportsAnthropicAdaptiveThinking` from `../shared/model-capabilities.js`.
- Types `LlmUsageMetrics`, `FeatureType`, `LlmReasoningSignal`, `PromptTextBlock`, `ReasoningEffort` from `../shared/types.js`.
- `extractReasoningDeltaText`, `mergeUsage`, `parseRetryAfterMs`, `parseSseBlock`, `usageEquals` from `./llm-stream-utils.js`.

### Constants consumed
- `CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'` (`constants.ts:33`).
- `ANTHROPIC_VERSION = '2023-06-01'` (`constants.ts:35`).
- `MAX_TOKENS[feature]` (`constants.ts:55-63`): fast-reply 800, improve-draft 800, help-me 1200, fan-summary 8192, chat-review 1600, ping 800, hi-greeting 800.
- Adaptive-thinking token table `ANTHROPIC_ADAPTIVE_THINKING_MAX_TOKENS` (`model-capabilities.ts:13-21`): fast-reply 8000, improve-draft 8000, help-me 16000, fan-summary 24000, chat-review 16000, ping 8000, hi-greeting 8000.
- Adaptive-thinking model set `ANTHROPIC_ADAPTIVE_THINKING_MODELS` (`model-capabilities.ts:8-11`): `claude-sonnet-4-6`, `claude-opus-4-6` **only** (sonnet-4-5, opus-4-5, haiku-4-5 are excluded).

### `interface AnthropicStreamArgs` (`anthropic-client.ts:22-37`)
Same callback shape as `LlmStreamArgs` but with `apiKey: string` and `model: string` (the raw provider id) and **no** `settings`.

### `type AnthropicThinkingEffort = Exclude<ReasoningEffort, 'off'>` (`anthropic-client.ts:51`)
i.e. `'low' | 'medium' | 'high' | 'max'` — the effort value passed straight through to `output_config.effort`.

### `resolveMaxTokens(model, feature)` (`anthropic-client.ts:53-58`)
- If `supportsAnthropicAdaptiveThinking(model)` → `getAnthropicAdaptiveThinkingMaxTokens(feature) ?? MAX_TOKENS[feature]`.
- Else → `MAX_TOKENS[feature]`.
- **Subtlety:** keyed only on whether the *model* supports adaptive thinking, **not** on whether thinking is actually enabled. A `claude-sonnet-4-6` request with `reasoningEffort: 'off'` still gets the larger adaptive `max_tokens` (e.g. 8000 for fast-reply) even though no thinking config is sent. `max_tokens` is decoupled from the presence of the thinking block.

### `buildAdaptiveThinkingConfig(model, reasoningEffort)` (`anthropic-client.ts:60-75`)
- Returns `{}` when `!supportsAnthropicAdaptiveThinking(model) || reasoningEffort === 'off'`.
- Otherwise returns:
  ```
  { thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: reasoningEffort } }
  ```

### `detectReasoningSignal(payload)` (`anthropic-client.ts:77-101`) → `LlmReasoningSignal | null`
Maps SSE payload shape to a reasoning signal:

| Condition | Signal |
|---|---|
| `content_block.type === 'thinking'` | `'thinking_block'` |
| `content_block.type === 'redacted_thinking'` | `'redacted_thinking_block'` |
| `delta.type === 'thinking_delta'` | `'thinking_delta'` |
| `delta.type === 'signature_delta'` | `'signature_delta'` |
| `delta.reasoning !== undefined \|\| reasoning !== undefined` | `'reasoning_delta'` |
| otherwise | `null` |

### Error-reading helpers
- `getHeader(response, name)` (`anthropic-client.ts:103-108`) — null-safe `response.headers.get(name)`.
- `readAnthropicError(response)` (`anthropic-client.ts:110-126`) — `await response.json()` (guarded by `typeof response.json === 'function'`), returns `{ type, message }` from `body.error`, or `null` on absence/parse failure.
- `matchesMessage(message, patterns)` (`anthropic-client.ts:128-130`) — `patterns.some(p => message.includes(p))`.

### Error classification predicates
- `isInsufficientBalanceError(type, message)` (`anthropic-client.ts:132-146`): `type === 'insufficient_balance_error' || type === 'payment_required_error'` OR message includes any of `insufficient balance`, `insufficient credits`, `credit balance is too low`, `payment required`. (Comment: bare `billing` intentionally excluded.)
- `isModelUnavailableError(type, message)` (`anthropic-client.ts:148-161`): `type === 'not_found_error'` OR message includes `model not found`, `does not exist`, `is unavailable`, `deprecated`. (Comment: bare `not found` intentionally excluded so it does not spuriously trigger model fallback.)
- `isContextTooLongError(type, message)` (`anthropic-client.ts:163-175`): `type === 'context_window_exceeded_error'` OR message includes `prompt is too long`, `context length`, `maximum context length`, `too many tokens`, `request is too large`, `input is too long`.

### `buildAnthropicError(status, info, retryAfterMs?)` (`anthropic-client.ts:177-229`) → `ChatGooseError`
Normalizes `type` (trim+lowercase), `message`, `normalizedMessage`. Builds a `details` object with (conditionally present) `status` (if `>0`), `providerMessage` (if message), `retryAfterMs`, and `retryAtMs = Date.now() + retryAfterMs`. **Classification, in order (first match wins):**

| # | Condition | `ChatGooseError` key | Extras |
|---|---|---|---|
| 1 | `status === 429` OR `type === 'rate_limit_error'` OR message ⊃ `rate limit` | `rate_limited` | `retryAfterMs`, `retryAtMs` propagated onto the error |
| 2 | `isInsufficientBalanceError` | `insufficient_balance` | |
| 3 | `status === 401` OR `403` | `invalid_api_key` | |
| 4 | `isModelUnavailableError` | `model_unavailable` | |
| 5 | `status === 413` OR `isContextTooLongError` | `context_too_long` | |
| 6 | `status === 529` OR `status >= 500` OR `type === 'overloaded_error'` | `service_unavailable` | |
| 7 | `status === 400` | `unknown_error` | |
| 8 | `status === 0` | `service_unavailable` | (used for mid-stream error events, which call `buildAnthropicError(0, …)`) |
| 9 | otherwise | `network_error` | |

`details.provider` is **not** set by the Anthropic client (contrast OpenRouter). Consequently `toUserError` (`errors.ts:353`) applies no provider-specific re-wording, and the Anthropic-worded registry strings (e.g. `insufficient_balance` → "Anthropic balance is insufficient.") surface as-is.

### `class AnthropicClient.streamMessage(args)` (`anthropic-client.ts:231-392`) → `Promise<string>`
Returns the accumulated **text-delta** string (`rawText`); reasoning/thinking text is *not* included in the return value.

**Request build (`anthropic-client.ts:248-274`):**
- `adaptiveThinkingConfig = buildAdaptiveThinkingConfig(model, reasoningEffort)`.
- `requestBody` (`Record<string, unknown>`):
  | Field | Value |
  |---|---|
  | `model` | raw provider id |
  | `stream` | `true` |
  | `max_tokens` | `resolveMaxTokens(model, feature)` |
  | `thinking` | `{ type: 'adaptive', display: 'summarized' }` — only when adaptive thinking active |
  | `output_config` | `{ effort: reasoningEffort }` — only when adaptive thinking active |
  | `system` | `systemBlocks` (`PromptTextBlock[]`, cache_control preserved) |
  | `messages` | `[{ role: 'user', content: userBlocks }]` |
  | `temperature` | `temperature` — **only added when `!adaptiveThinkingConfig.thinking`** (`anthropic-client.ts:260-262`), i.e. omitted whenever thinking is enabled |
- **`fetch(CLAUDE_API_URL, …)`** — `method: 'POST'`, `signal`, `body: JSON.stringify(requestBody)`. Headers:
  | Header | Value |
  |---|---|
  | `content-type` | `application/json` |
  | `x-api-key` | `apiKey` (user's `claudeApiKey`) |
  | `anthropic-version` | `2023-06-01` |
  | `anthropic-dangerous-direct-browser-access` | `true` |

**Response guards:**
- `!response.ok` → `readAnthropicError`, `parseRetryAfterMs(getHeader(response, 'retry-after'))`, then `throw buildAnthropicError(response.status, errorInfo, retryAfterMs)` (`anthropic-client.ts:276-280`).
- `!response.body` → `throw new ChatGooseError('network_error')` (`anthropic-client.ts:282-284`).

**SSE read loop (`anthropic-client.ts:286-388`):**
- `TextDecoder`, growing `buffer`, `response.body.getReader()`.
- Each iteration: `reader.read()`, `buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done })`.
- Split on blank-line boundaries with `buffer.split(/\r?\n\r?\n/)` (tolerates CRLF); last element retained in `buffer` as the partial (`blocks.pop()`).
- Per block: `parseSseBlock(block)`. Skip if `null` or `parsed.data === '[DONE]'`. `JSON.parse(parsed.data)`; on parse error `continue`.
- `onProgress?.()` fires for every successfully-parsed payload (including `error` payloads, *before* the throw).
- **Mid-stream error:** `if (parsed.event === 'error' || payload.type === 'error') throw buildAnthropicError(0, payload.error ?? null)` (`anthropic-client.ts:329-331`).
- Reasoning: `detectReasoningSignal(payload)` → `onReasoningObserved?.(signal)`; `extractReasoningDeltaText(payload)` → `onReasoningDelta?.(text)` (`anthropic-client.ts:333-340`).
- `message_start` (`anthropic-client.ts:342-352`): `nextUsage = mergeUsage(usage, payload.message?.usage)`; if `!usageEquals(usage, nextUsage)` update and `onUsage?.(usage)`; else still assign `usage = nextUsage`.
- `message_delta` (`anthropic-client.ts:354-367`): if `'stop_reason' in (payload.delta ?? {})` → `onStopReason?.(payload.delta?.stop_reason ?? null)`; then usage merge from `payload.usage` (same change-detect logic).
- **Text:** `content_block_delta` && `delta.type === 'text_delta'` && `delta.text` → `rawText += payload.delta.text; onText(payload.delta.text)` (`anthropic-client.ts:369-376`).
- `if (done) break`.
- **`finally`** (`anthropic-client.ts:383-388`): `reader.cancel().catch(() => {})` on every exit path (including throws from inside the loop) to release the HTTP body/reader lock. Comment notes mid-stream error throws do not abort `signal` and would otherwise leave the body locked.

---

## `src/background/openrouter-client.ts`

Streaming client for OpenRouter's **Anthropic-compatible Messages API** (`/api/v1/messages`, not the OpenAI chat-completions shape). Boundary 5. Request/response follow the same Anthropic Messages streaming semantics; OpenAI-style `chat.completion.chunk` payloads are explicitly rejected.

### Imports
- `MAX_TOKENS`, `OPENROUTER_MESSAGES_API_URL` from `../shared/constants.js`.
- `ChatGooseError` from `../shared/errors.js`.
- `getOpenRouterGeminiThinkingMaxTokens`, `isOpenRouterGeminiModel`, `supportsOpenRouterGeminiThinking` from `../shared/model-capabilities.js`.
- Same shared types + the same five `llm-stream-utils` helpers as the Anthropic client.

### Constants consumed
- `OPENROUTER_MESSAGES_API_URL = 'https://openrouter.ai/api/v1/messages'` (`constants.ts:34`).
- Gemini thinking-token table `OPENROUTER_GEMINI_THINKING_MAX_TOKENS` (`model-capabilities.ts:23-29`): fast-reply 1600, improve-draft 1600, hi-greeting 1600, ping 1600, help-me 2000. **`fan-summary` and `chat-review` are absent** → no thinking config on Gemini for those features.
- `isOpenRouterGeminiModel(id)` = `id.startsWith('google/gemini-')` (`model-capabilities.ts:41-43`).

### `interface OpenRouterStreamArgs` (`openrouter-client.ts:23-38`)
Not exported. Same shape as `AnthropicStreamArgs` (`apiKey`, `model`, callbacks).

### `const SUPPORTED_OPENROUTER_SSE_EVENTS` (`openrouter-client.ts:54-63`)
`Set` of: `message_start`, `message_delta`, `message_stop`, `content_block_start`, `content_block_delta`, `content_block_stop`, `ping`, `error`. Any event not in this set is either ignored (forward-compat metadata) or, if it looks like an OpenAI chat-completion chunk, rejected.

### `type OpenRouterUsagePayload` (`openrouter-client.ts:65-72`)
`Partial<LlmUsageMetrics>` plus OpenAI-style fields: `prompt_tokens?`, `completion_tokens?`, `prompt_tokens_details?: { cached_tokens?; cache_write_tokens? }`.

### `type OpenRouterThinkingEffort = Exclude<ReasoningEffort, 'off' | 'max'>` (`openrouter-client.ts:74`)
i.e. `'low' | 'medium' | 'high'`. `'max'` is folded to `'high'` before use.

### `resolveMaxTokens(model, feature)` (`openrouter-client.ts:76-81`)
- `isOpenRouterGeminiModel(model)` → `getOpenRouterGeminiThinkingMaxTokens(feature) ?? MAX_TOKENS[feature]`; else `MAX_TOKENS[feature]`.
- **Subtlety:** for Gemini fan-summary/chat-review, `getOpenRouterGeminiThinkingMaxTokens` returns `undefined` → falls back to `MAX_TOKENS` (8192 / 1600). For thinking-eligible features it uses the smaller Gemini table (e.g. 1600) even when `reasoningEffort === 'off'` (thinking config empty). Like the Anthropic client, `max_tokens` is decoupled from whether the thinking block is actually emitted.

### `buildGeminiThinkingConfig(model, feature, reasoningEffort)` (`openrouter-client.ts:83-100`)
- Returns `{}` when `!supportsOpenRouterGeminiThinking(model, feature) || reasoningEffort === 'off'`.
- Else `effort = reasoningEffort === 'max' ? 'high' : reasoningEffort`, and returns:
  ```
  { thinking: { type: 'adaptive', display: 'omitted' },
    output_config: { effort } }
  ```
- **Difference vs Anthropic:** `display: 'omitted'` (Anthropic uses `'summarized'`), and `'max'` effort is downgraded to `'high'`. `supportsOpenRouterGeminiThinking` (`model-capabilities.ts:51-59`) = Gemini model AND a thinking-token entry exists for the feature.

### `detectReasoningSignal(payload)` (`openrouter-client.ts:102-131`)
Same content_block/delta mapping as the Anthropic version, plus a chat-completion path: if neither the top-level nor `delta` carries a `reasoning` own-property, it inspects `payload.choices[].delta` / `payload.choices[].message` via `hasReasoningProperty` and returns `'reasoning_delta'` if any choice has one.

### `hasReasoningProperty(value)` (`openrouter-client.ts:133-139`)
`typeof value === 'object' && value !== null && Object.prototype.hasOwnProperty.call(value, 'reasoning')`.

### `stripCacheControl(blocks)` (`openrouter-client.ts:141-150`)
Maps each `PromptTextBlock` to `{ type, text }`, **dropping `cache_control`**. Comment: OpenRouter Grok prompt caching is automatic (no breakpoints needed); Gemini is marked `supportsPromptCache=false` and no Gemini breakpoints are built. Applied to both `systemBlocks` and `userBlocks` before send.

### `normalizeUsage(usage)` (`openrouter-client.ts:152-202`) → `Partial<LlmUsageMetrics> | undefined`
Converts an OpenRouter usage payload into the internal `LlmUsageMetrics` shape.

- Returns `undefined` if `usage` is falsy.
- `outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : usage.completion_tokens`.
- **OpenAI-style branch** (`typeof usage.input_tokens !== 'number' && typeof usage.prompt_tokens === 'number'`, `openrouter-client.ts:165-181`):
  - `cacheReadTokens = prompt_tokens_details.cached_tokens ?? 0`.
  - `cacheWriteTokens = prompt_tokens_details.cache_write_tokens ?? 0`.
  - `input_tokens = max(0, prompt_tokens − cacheRead − cacheWrite)`.
  - `cache_creation_input_tokens = max(0, cacheWrite)`.
  - `cache_read_input_tokens = max(0, cacheRead)`.
- **Anthropic-style passthrough branch** (`openrouter-client.ts:182-195`): copies `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, and `cache_creation` when each is present/numeric.
- `output_tokens = outputTokens` if numeric.
- Returns `undefined` when the normalized object ends up empty (`Object.keys(...).length === 0`).

### Error helpers
- `getHeader` — identical to the Anthropic version (`openrouter-client.ts:204-209`).
- `readOpenRouterError(response)` (`openrouter-client.ts:211-228`) — returns `{ code, type, message }` from `body.error` (note the extra `code`, which may be `number | string`).
- `matchesMessage` — identical predicate helper (`openrouter-client.ts:230-232`).

### `buildOpenRouterError(status, info, retryAfterMs?)` (`openrouter-client.ts:234-320`) → `ChatGooseError`
Normalizes `type`, `code` (`toString().trim().toLowerCase()`), `message`, `normalizedMessage`. `details` always includes **`provider: 'openrouter'`** plus conditional `status`/`providerMessage`/`retryAfterMs`/`retryAtMs`. **Classification, in order:**

| # | Condition | key |
|---|---|---|
| 1 | `status === 429` OR `code === '429'` OR message ⊃ `rate limit` | `rate_limited` (+ `retryAfterMs`/`retryAtMs`) |
| 2 | `status === 402` OR `code === '402'` OR message ⊃ `insufficient credits` / `insufficient balance` / `payment required` | `insufficient_balance` |
| 3 | `status === 401`\|`403` OR `code === '401'`\|`'403'` | `invalid_api_key` |
| 4 | `status === 404` OR `type === 'not_found_error'` OR message ⊃ `model not found` / `invalid model` / `not a valid model` / `does not exist` / `is unavailable` | `model_unavailable` |
| 5 | `status === 413` OR message ⊃ `context length` / `maximum context` / `too many tokens` / `prompt is too long` / `request is too large` | `context_too_long` |
| 6 | `status === 502`\|`503` OR `status >= 500` | `service_unavailable` |
| 7 | `status === 400` | `unknown_error` |
| 8 | `status === 0` | `service_unavailable` |
| 9 | otherwise | `network_error` |

Because `details.provider === 'openrouter'`, `providerUserErrorOverrides` (`errors.ts:309-351`) re-words these keys for OpenRouter: `missing_api_key`, `invalid_api_key`, `rate_limited`, `insufficient_balance`, `service_unavailable`, `model_unavailable`. `context_too_long`, `unknown_error`, and `network_error` have no OpenRouter override and keep their provider-neutral registry strings.

### `class OpenRouterClient.streamMessage(args)` (`openrouter-client.ts:322-503`) → `Promise<string>`
Returns accumulated `rawText`.

**Request build (`openrouter-client.ts:339-358`):** `fetch(OPENROUTER_MESSAGES_API_URL, …)`, `method: 'POST'`, `signal`. Headers:
| Header | Value |
|---|---|
| `authorization` | `Bearer ${apiKey}` (user's `openRouterApiKey`) |
| `content-type` | `application/json` |
| `x-openrouter-title` | `ChatGoose` |

Body (`JSON.stringify`):
| Field | Value |
|---|---|
| `model` | raw provider id (e.g. `google/gemini-3.1-pro-preview`, `x-ai/grok-4.3`) |
| `temperature` | `temperature` — **always sent** (contrast Anthropic, which omits it when thinking is on) |
| `stream` | `true` |
| `max_tokens` | `resolveMaxTokens(model, feature)` |
| `thinking` / `output_config` | from `buildGeminiThinkingConfig` (only for eligible Gemini feature/effort) |
| `system` | `stripCacheControl(systemBlocks)` |
| `messages` | `[{ role: 'user', content: stripCacheControl(userBlocks) }]` |

**Response guards:**
- `!response.ok` → `readOpenRouterError`, `parseRetryAfterMs(getHeader(..., 'retry-after'))`, `throw buildOpenRouterError(response.status, errorInfo, retryAfterMs)` (`openrouter-client.ts:360-364`).
- `!response.body` → `throw new ChatGooseError('network_error', { details: { provider: 'openrouter' } })` (`openrouter-client.ts:366-370`).

**SSE read loop (`openrouter-client.ts:372-499`):** same decoder/buffer/`\r?\n\r?\n` split as the Anthropic client. Differences:
- Error detection also checks the truthy `payload.error`: `if (parsed.event === 'error' || payload.type === 'error' || payload.error) throw buildOpenRouterError(0, payload.error ?? null)` (`openrouter-client.ts:417-419`).
- **`effectiveEvent`** (`openrouter-client.ts:421-424`): if `parsed.event === 'message'` and `payload.type` is a string, use `payload.type`; else use `parsed.event`. This maps Anthropic-style JSON payloads that arrive over a generic SSE `message` event to their real event name.
- **Unsupported-event gate** (`openrouter-client.ts:426-438`): if `!SUPPORTED_OPENROUTER_SSE_EVENTS.has(effectiveEvent)`:
  - If `payload.object === 'chat.completion.chunk'` OR `Array.isArray(payload.choices)` → `throw new ChatGooseError('unknown_error', { details: { provider: 'openrouter', providerMessage: 'Unsupported OpenRouter chat completion stream chunk' } })`.
  - Otherwise `continue` (silently ignore forward-compatible metadata events).
- **Reasoning observed only after the gate** (`openrouter-client.ts:440-450`) — comment: so a chunk about to be rejected cannot first emit reasoning activity that would feed the caller's TTFB/idle timers. `onProgress?.()` however runs *before* the gate (`openrouter-client.ts:415`), for every parsed payload including ignored/rejected ones.
- `message_start` / `message_delta` usage handling mirrors Anthropic but wraps payloads with `normalizeUsage(...)` (`openrouter-client.ts:452-477`). `message_delta` also handles `stop_reason` → `onStopReason`.
- Text: `effectiveEvent === 'content_block_delta'` && `delta.type === 'text_delta'` && `delta.text` → `rawText += …; onText(…)` (`openrouter-client.ts:479-486`).
- `finally`: `reader.cancel().catch(() => {})` (`openrouter-client.ts:493-499`).

---

## `src/background/llm-stream-utils.ts`

Provider-agnostic SSE/usage helpers. Imports only types `LlmCacheCreationUsage`, `LlmUsageMetrics` from `../shared/types.js`. All five functions are exported except `extractReasoningText` (internal).

### `parseSseBlock(block)` (`llm-stream-utils.ts:6-29`) → `{ event: string; data: string } | null`
- Splits `block` on `'\n'`, trims each line.
- `event` defaults to `'message'`; lines starting `event:` set it (value after prefix, trimmed).
- Lines starting `data:` are collected (value after prefix, trimmed); blank lines skipped; all other lines ignored (e.g. `id:`, comments).
- Returns `null` if no data lines. Otherwise `{ event, data: dataLines.join('\n') }` (multi-line `data:` fields are newline-joined). Both provider clients treat `data === '[DONE]'` as a sentinel to skip.

### `extractReasoningText(value)` (internal, `llm-stream-utils.ts:31-54`) → `string`
- `string` → returned as-is.
- Non-object / `null` → `''`.
- Object → first `string` found among keys `thinking`, `reasoning`, `text`, `content` (in that order); else `''`.

### `extractReasoningDeltaText(payload)` (`llm-stream-utils.ts:56-88`) → `string`
- If `delta.type === 'thinking_delta'` → `extractReasoningText(delta.thinking)`.
- Else `directReasoning = extractReasoningText(delta.reasoning ?? reasoning)`; return it if truthy.
- Else iterate `payload.choices`; for each, `extractReasoningText(choice.delta.reasoning ?? choice.message.reasoning)`; return first non-empty.
- Else `''`.

### `mergeUsage(current, next?)` (`llm-stream-utils.ts:90-132`) → `LlmUsageMetrics | null`
- `!next` → returns `current` unchanged.
- Merges `cache_creation` (`ephemeral_5m_input_tokens`, `ephemeral_1h_input_tokens`): each field prefers `next`'s numeric value, else `current`'s, else `0`; the `cache_creation` object is present only if `next` or `current` had one.
- Returns a fresh `LlmUsageMetrics` where `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens` each prefer `next`'s numeric value else `current ?? 0`. (Field-wise "latest numeric wins" merge, not additive.)

### `usageEquals(left, right)` (`llm-stream-utils.ts:134-155`) → `boolean`
- Reference-equal → `true`. Either `null` → `false`.
- Compares the four token fields plus `cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` (each defaulting to `0`). Used by both clients to suppress duplicate `onUsage` callbacks.

### `parseRetryAfterMs(value)` (`llm-stream-utils.ts:157-178`) → `number | undefined`
- `null` / empty-after-trim → `undefined`.
- Numeric seconds (`Number(trimmed)` finite and `>= 0`) → `Math.round(seconds * 1000)`.
- Else parse as HTTP-date (`Date.parse`): if finite → `Math.max(0, timestamp − Date.now())`; if not → `undefined`.
- Also imported by `src/background/fansly-client.ts:14` and used at `fansly-client.ts:359` for Fansly 429 retry timing (boundary 1) — this helper is shared across all three network clients.

---

## `src/background/llm-cost.ts`

Pure token→USD estimation and spend-summary construction. No network/DOM/storage/IPC. Imports types `LlmCostEstimate`, `LlmSpendSummary`, `LlmUsageMetrics` from `../shared/types.js`, and `getModelDisplayName`, `getModelEntry`, `ModelPricing` from `../shared/model-registry.js`.

### Constants & primitives
- `USD_PRECISION = 1_000_000`, `TOKENS_PER_MILLION = 1_000_000` (`llm-cost.ts:9-10`).
- `roundUsd(value)` (`llm-cost.ts:12-14`): rounds to 6 decimal places via `Math.round((value + Number.EPSILON) * 1e6) / 1e6`.
- `priceTokens(tokens, usdPerMillion)` (`llm-cost.ts:16-18`): `roundUsd(max(0, tokens) * usdPerMillion / 1e6)`.

### `resolvePricing(modelId)` (`llm-cost.ts:20-34`)
- `getModelEntry(modelId)`; if not found → **throws a plain `Error`** (`Unsupported model for cost estimation: ${modelId}`), not a `ChatGooseError`.
- Returns `{ normalizedModelId: entry.id, pricing: entry.pricing, approximate: Boolean(entry.costApproximate) }`.

### Pricing source — `ModelPricing` from the registry (`model-registry.ts:3-9`, `30-156`)
`ModelPricing`: `inputUsdPerMillion`, `outputUsdPerMillion`, optional `cacheWrite5mUsdPerMillion`, `cacheWrite1hUsdPerMillion`, `cacheReadUsdPerMillion`. Registry table (USD per 1M tokens):

| Registry id | input | cacheWrite5m | cacheWrite1h | cacheRead | output | flags |
|---|---|---|---|---|---|---|
| `anthropic:claude-sonnet-4-6` | 3 | 3.75 | 6 | 0.30 | 15 | |
| `anthropic:claude-sonnet-4-5` | 3 | 3.75 | 6 | 0.30 | 15 | |
| `anthropic:claude-opus-4-6` | 5 | 6.25 | 10 | 0.50 | 25 | |
| `anthropic:claude-opus-4-5` | 5 | 6.25 | 10 | 0.50 | 25 | |
| `anthropic:claude-haiku-4-5` | 1 | 1.25 | 2 | 0.10 | 5 | |
| `openrouter:google/gemini-3.1-pro-preview` | 2 | — | — | — | 12 | no cache fields |
| `openrouter:x-ai/grok-4.20` | 1.25 | — | — | 0.20 | 2.50 | `costApproximate: true`, `pricingNote` |
| `openrouter:x-ai/grok-4.3` | 1.25 | — | — | 0.20 | 2.50 | `costApproximate: true`, `pricingNote` |

The two Grok entries carry `costApproximate: true` (→ `approximate` in every estimate) and a `pricingNote` flagging cache-read pricing as unconfirmed placeholder.

### `resolveCacheWriteTokens(usage)` (`llm-cost.ts:36-79`) → `{ cacheWrite5mTokens, cacheWrite1hTokens, approximate }`
Splits `usage.cache_creation_input_tokens` (clamped `>= 0`, = `totalCacheWriteTokens`) into 5m/1h buckets:
- **No `cache_creation` object** → all tokens to 5m; `approximate = totalCacheWriteTokens > 0`.
- Else `raw5m`/`raw1h` from `cache_creation` (each clamped `>= 0`); `accounted = raw5m + raw1h`:
  - `accounted === total` → exact split, `approximate: false`.
  - `accounted < total` → remainder `(total − accounted)` added to 5m, `approximate: true`.
  - `accounted > total` → `cacheWrite1h = min(raw1h, total)`, `5m = max(0, total − 1h)`, `approximate: true`.

### `estimateLlmCost(modelId, usage)` (`llm-cost.ts:81-132`) → `LlmCostEstimate` (exported)
- `resolvePricing` + `resolveCacheWriteTokens`.
- `unpricedCacheWrite = cache_creation_input_tokens > 0 && cacheWrite5mUsdPerMillion === undefined && cacheWrite1hUsdPerMillion === undefined`.
- `unpricedCacheRead = cache_read_input_tokens > 0 && cacheReadUsdPerMillion === undefined`.
- Component costs via `priceTokens` (missing cache rates default to `0` in the multiply): `inputUsd`, `cacheWrite5mUsd`, `cacheWrite1hUsd`, `cacheReadUsd`, `outputUsd`.
- Returns `{ modelId: normalizedModelId, inputUsd, cacheWrite5mUsd, cacheWrite1hUsd, cacheReadUsd, outputUsd, totalUsd: roundUsd(sum of five), approximate: modelApproximate || cacheApproximate || unpricedCacheWrite || unpricedCacheRead }`.
- Interaction: Grok models have no cache-write pricing but a `cacheReadUsdPerMillion`; since `stripCacheControl` removes cache_control and Grok caching is automatic, any cache-read tokens OpenRouter reports (via `normalizeUsage` from `prompt_tokens_details.cached_tokens`) are priced at 0.20, while cache-write tokens (none expected) would price at 0 and set `unpricedCacheWrite`. Gemini has no cache fields at all → any reported cache tokens set `approximate`.

### `buildLlmSpendSummary(modelId, usage, cost?)` (`llm-cost.ts:134-178`) → `LlmSpendSummary` (exported)
- `resolvedCost = cost ?? estimateLlmCost(modelId, usage)`; `pricing` re-resolved.
- `baselineInputTokens = input + cache_creation + cache_read`.
- `uncachedInputUsd = priceTokens(baselineInputTokens, inputUsdPerMillion)` (all input priced at the non-cache input rate).
- `uncachedUsd = roundUsd(uncachedInputUsd + resolvedCost.outputUsd)`.
- `rawCacheEffectUsd = roundUsd(abs(uncachedUsd − totalUsd))`.
- `cacheEffectKind`: `uncached > total` → `'saved'`; `uncached < total` → `'overhead'`; else `'neutral'`.
- Returns full `LlmSpendSummary`: `totalTokens` (sum of all four token fields), `inputTokens`, `cacheWriteTokens = cache_creation_input_tokens`, `cacheReadTokens = cache_read_input_tokens`, `outputTokens`, `totalUsd`, `uncachedUsd`, `cacheEffectUsd`, `cacheEffectKind`, `cacheWriteUsd = roundUsd(cacheWrite5mUsd + cacheWrite1hUsd)`, `cacheReadUsd`, `approximate`.

### `createZeroLlmSpendSummary()` (`llm-cost.ts:180-195`) → `LlmSpendSummary` (exported)
All numeric fields `0`, `cacheEffectKind: 'neutral'`, `approximate: false`. Used by the operation coordinators as the default/placeholder spend (e.g. `operations.ts:1049,1629,1703,1883,2545`; `compare-operations.ts:1175,1215,1229`).

### `formatModelUsageLog(modelId, usage)` (`llm-cost.ts:197-203`) → `string` (exported)
`"<displayName> usage: input_tokens=…, cache_creation_input_tokens=…, cache_read_input_tokens=…, output_tokens=…"` via `getModelDisplayName`.

### `formatModelCostLog(cost)` (`llm-cost.ts:205-208`) → `string` (exported)
`"<displayName> cost: model=…, total_usd=… (6dp), input_usd=…, cache_write_5m_usd=…, cache_write_1h_usd=…, cache_read_usd=…, output_usd=…, approximate=…"`. All USD via `.toFixed(6)`.

Both formatters are logging-only (fed to `profiler.log` in `operations.ts:2255-2256` and `compare-operations.ts:1076-1077`); no side effects, no persistence.

---

## External boundary crossings (these five files)

| Kind | Where | Detail / data crossing |
|---|---|---|
| network | `anthropic-client.ts:264` `fetch(CLAUDE_API_URL)` | **POST `https://api.anthropic.com/v1/messages`**. Headers: `content-type: application/json`, `x-api-key: <claudeApiKey>`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`. Body out: `model`, `stream:true`, `max_tokens`, optional `thinking`/`output_config`, `system` blocks, `messages`, optional `temperature`. In: SSE stream (`message_start`/`message_delta`/`content_block_delta`/`error`) carrying text deltas + `usage`; or JSON error body `{ error: { type, message } }` + `retry-after` header. Aborted via caller's `AbortSignal`. |
| network | `openrouter-client.ts:341` `fetch(OPENROUTER_MESSAGES_API_URL)` | **POST `https://openrouter.ai/api/v1/messages`** (Anthropic-compatible Messages API). Headers: `authorization: Bearer <openRouterApiKey>`, `content-type: application/json`, `x-openrouter-title: ChatGoose`. Body out: `model`, `temperature`, `stream:true`, `max_tokens`, optional Gemini `thinking`/`output_config`, `system`/`messages` with `cache_control` stripped. In: Anthropic-style SSE (or generic `message` events whose JSON carries a `type`), plus rejection of `chat.completion.chunk`/`choices` payloads; JSON error `{ error: { code, type, message } }` + `retry-after`. |
| browser-api | both clients | `fetch`, `Response.body.getReader()`, `TextDecoder`, `AbortSignal`. No `browser.*` extension APIs are called in these five files. |

**Not touched by these files:** DOM, `browser.storage.*`, `browser.runtime` messaging/ports, distribution/update endpoints. The API keys (`claudeApiKey`, `openRouterApiKey` storage keys) are read elsewhere and arrive as plain `apiKey` args; these files never read storage themselves. The `onText`/`onUsage`/`onProgress`/`onReasoning*`/`onStopReason` callbacks are in-process function references supplied by the operation coordinators (no IPC inside these files).

---

## Cross-module dependencies & callers

**Imports (out):**
- `llm-client.ts` → `shared/errors` (`ChatGooseError`), `shared/model-registry` (`ANTHROPIC_PROVIDER`, `OPENROUTER_PROVIDER`, `getModelEntry`), `shared/types`, `./anthropic-client`, `./openrouter-client`.
- `anthropic-client.ts` → `shared/constants` (`ANTHROPIC_VERSION`, `CLAUDE_API_URL`, `MAX_TOKENS`), `shared/errors`, `shared/model-capabilities` (`getAnthropicAdaptiveThinkingMaxTokens`, `supportsAnthropicAdaptiveThinking`), `shared/types`, `./llm-stream-utils`.
- `openrouter-client.ts` → `shared/constants` (`MAX_TOKENS`, `OPENROUTER_MESSAGES_API_URL`), `shared/errors`, `shared/model-capabilities` (`getOpenRouterGeminiThinkingMaxTokens`, `isOpenRouterGeminiModel`, `supportsOpenRouterGeminiThinking`), `shared/types`, `./llm-stream-utils`.
- `llm-stream-utils.ts` → `shared/types` only.
- `llm-cost.ts` → `shared/types`, `shared/model-registry` (`getModelDisplayName`, `getModelEntry`, `ModelPricing`).

**Callers (in):**
- `LlmClient` constructed at `background/index.ts:24` (composition root) and injected into `OperationCoordinator` (`index.ts:27-35`). `streamMessage` invoked at `operations.ts:2363` and `compare-operations.ts:1040` (both inside a rate-limit/service-unavailable retry loop — see `operations.ts:2355-2398`).
- `AnthropicClient` / `OpenRouterClient` constructed at `background/index.ts:22-23`; called only through `LlmClient`.
- `llm-cost` exports (`estimateLlmCost`, `buildLlmSpendSummary`, `createZeroLlmSpendSummary`, `formatModelUsageLog`, `formatModelCostLog`) imported by `operations.ts:112-117` and `compare-operations.ts:49-54`.
- `llm-stream-utils.parseRetryAfterMs` additionally imported by `fansly-client.ts:14`.

---

## Open Questions / Discrepancies

1. **`settings` leaks into provider calls.** `LlmClient.streamMessage` spreads `...args` (which still contains `settings`) into `anthropicClient.streamMessage` / `openRouterClient.streamMessage`, whose arg interfaces do not declare `settings`. The property is passed and ignored (`llm-client.ts:53-57`, `66-70`).
2. **`max_tokens` decoupled from thinking activation.** In both clients `resolveMaxTokens` keys on whether the *model* supports thinking, not on whether `reasoningEffort` actually enabled it. A thinking-capable model run with `reasoningEffort: 'off'` still gets the larger thinking-table `max_tokens` while sending no thinking config and (Anthropic) sending `temperature` (`anthropic-client.ts:53-58`, `260-262`; `openrouter-client.ts:76-81`).
3. **`temperature` handling differs by provider.** Anthropic omits `temperature` when the adaptive-thinking block is present; OpenRouter always sends `temperature`, including alongside a Gemini thinking config (`anthropic-client.ts:260-262` vs `openrouter-client.ts:350-354`).
4. **Thinking `display` differs.** Anthropic uses `display: 'summarized'`; OpenRouter/Gemini uses `display: 'omitted'`, and `'max'` effort is downgraded to `'high'` (`anthropic-client.ts:72` vs `openrouter-client.ts:95-98`).
5. **Gemini thinking excludes two features.** `OPENROUTER_GEMINI_THINKING_MAX_TOKENS` has no entry for `fan-summary` or `chat-review`, so Gemini gets no thinking config for those features regardless of `reasoningEffort` (`model-capabilities.ts:23-29`, `51-59`). Anthropic adaptive thinking is limited to `claude-sonnet-4-6` and `claude-opus-4-6` only (`model-capabilities.ts:8-11`).
6. **`resolvePricing` throws a plain `Error`.** Unlike the rest of the LLM layer (which throws `ChatGooseError`), `llm-cost.ts:26-28` throws a bare `Error` for an unknown model. Callers pass an already-resolved model id, so this is a guard against an unregistered id reaching cost estimation.
7. **Grok cache-read pricing is a flagged placeholder.** Both Grok entries set `costApproximate: true` with a `pricingNote` that the cache-read USD rate is unconfirmed; every estimate for them is marked `approximate` (`model-registry.ts:132-155`, propagated at `llm-cost.ts:126-131`).
8. **`onProgress` fires before rejection/error throws.** In both clients `onProgress?.()` runs for every parsed payload prior to the mid-stream error check and (OpenRouter) the unsupported-event gate, so a payload that is about to throw still counts as provider progress toward the caller's timers (`anthropic-client.ts:327-331`; `openrouter-client.ts:415-419`). OpenRouter deliberately defers *reasoning* observation until after the gate (`openrouter-client.ts:440-450`).
9. **Anthropic-worded error strings for OpenRouter fall through in some cases.** `providerUserErrorOverrides` re-words only six keys for `provider === 'openrouter'`; `context_too_long`, `unknown_error`, and `network_error` keep their registry strings (these happen to be provider-neutral). The Anthropic client sets no `provider` on its errors, so all Anthropic-path errors use the Anthropic-worded registry strings (`errors.ts:309-351`).
