# Shared — Prompt Assembly, Transcript & Reply Parsing

## Scope

This document maps the shared modules that turn Fansly domain data + a personality + a bundled `.md` template into an Anthropic/OpenRouter prompt, and that parse raw LLM output back into structured replies. Files covered (all under `src/shared/` unless noted):

- `src/shared/prompts.ts` — per-feature system/user prompt block assembly, cache-breakpoint placement, template placeholder substitution.
- `src/shared/prompt-injection.ts` — `escapeForPrompt` (the only injection-defense primitive).
- `src/shared/personalities.ts` — the bundled "Lora" personality + personality normalization/reconciliation.
- `src/shared/transcript.ts` — normalize `FanslyMessagePageResponse[]` into a transcript string, PPV/purchase evidence, ping-segment analysis, pagination helpers.
- `src/shared/reply-output.ts` — sanitize/parse raw LLM text into insertable reply parts.
- `src/shared/split.ts` — `[NEXT]` / `[VARIANT]` splitting.
- `src/shared/xml.ts` — `<tag>` extraction for `help-me` and `chat-review` structured output.
- `src/shared/subscriptions.ts` — `formatFanSubscriptionData` (subscription context → prompt text).
- `src/shared/earnings.ts` — `aggregateEarnings`, `formatFanSpendingData`, `millsToUsd`, monthly aggregation.
- Bundled templates `prompts/*.md`: `fast-reply.md`, `improve-draft.md`, `help-me.md`, `fan-summary.md`, `chat-review.md`, `ping.md`, `hi-greeting.md`.

These are pure/deterministic modules (aside from `Date.now()`/timezone reads). They perform **no** network, DOM, or storage I/O directly; the four external boundaries (Fansly REST, Anthropic, OpenRouter, Agency Hub — see `boundaries.md`) are crossed by their **callers** in `src/background/`. This module's boundary surface is therefore: (a) the **content of the prompt strings** shipped to Anthropic/OpenRouter (assembled here, sent by `background/anthropic-client.ts` / `openrouter-client.ts` / `llm-client.ts`), and (b) the `prompts/*.md` files bundled as text at build time.

---

## Cross-cutting: how the pieces compose

The end-to-end prompt pipeline (orchestrated by `background/operations.ts` and `background/compare-operations.ts`, not by these files) is:

1. `fansly-client.ts` fetches message pages + earnings; `conversation-context-loader.ts` builds `PurchaseEvidenceOverride`.
2. `transcript.normalizeTranscript(pages, modelAccountId, fanAccountId, override)` → `NormalizedTranscriptMessage[]`; `transcript.formatTranscript(...)` → transcript string.
3. `earnings.aggregateEarnings(...)` + `earnings.formatFanSpendingData(...)` → fan-spending string; `subscriptions.formatFanSubscriptionData(...)` → subscription string.
4. Caller assembles a `PromptBuildInput` and calls `prompts.buildPromptRequest(input, promptCachingEnabled)` → `{ prompt, systemBlocks, userBlocks }`.
5. LLM client streams; the caller collects `rawText` and calls into `reply-output.ts` (`normalizeReplyParts` / `normalizeVariantReplyParts` / `normalizeSingleReplyPart` / `normalizeProvidedReplyParts`) and/or `xml.ts` (`parseHelpMeXml` / `parseChatReviewXml`).

`.md` template import mechanism: templates are imported as default string exports (e.g. `import fastReplyTemplate from '../../prompts/fast-reply.md'`). `esbuild.config.mjs` registers `loader: { '.md': 'text' }` (lines 93, 118), and `src/env.d.ts` declares `declare module '*.md' { const value: string; export default value; }`. So each template is a compile-time string constant.

---

## `src/shared/prompts.ts` (~430 lines)

Assembles the system and user prompt for a feature. Imports the seven `.md` templates; `getFeaturePolicy` / `featureUsesPingSegment` from `./features.js`; `escapeForPrompt` from `./prompt-injection.js`; types from `./types.js`. **Called by** `background/operations.ts:383` and `background/compare-operations.ts:1010` (both via `buildPromptRequest`).

### Constants & static text

- `PING_SEGMENT_INSTRUCTIONS: Record<PingSegment, string>` (`prompts.ts:21`) — per-segment strategy text for `segment-a`, `segment-b`, `active` (the `active` string states this segment "should not be used for ping generation").
- `REPLY_SAFETY_PREAMBLE` (`prompts.ts:29`) — roleplay/stay-in-character safety block used when `promptMode === 'reply'`.
- `ANALYSIS_SAFETY_PREAMBLE` (`prompts.ts:38`) — analysis/coaching safety block used when `promptMode === 'analysis'`.
- `EPHEMERAL_CACHE_CONTROL = { type: 'ephemeral' }` (`prompts.ts:46`) — 5-minute cache breakpoint.
- `ONE_HOUR_CACHE_CONTROL = { type: 'ephemeral', ttl: '1h' }` (`prompts.ts:50`) — 1-hour cache breakpoint.
- Anchor strings used both in the templates and for segmentation:
  - `SYSTEM_PERSONALITY_ANCHOR = '\n\n## Model Personality\n\n'` (`prompts.ts:55`)
  - `USER_TRANSCRIPT_ANCHOR = '## Conversation Transcript'` (`prompts.ts:56`)
  - `USER_DRAFT_ANCHOR = '## Current Draft'` (`prompts.ts:57`)
  - `USER_TASK_ANCHOR = '## Your Task'` (`prompts.ts:58`)
- `TONE_INSTRUCTIONS: Record<Exclude<ReplyTone,'none'>, string>` (`prompts.ts:108`) — override text for `casual`, `flirty`, `upsell` (labelled "SOFT UPSELL"), `spicy` (labelled "HORNY").
- `TONE_FOOTER` (`prompts.ts:125`) — appended after any tone override.

### Segmentation / caching plan

`USER_TEMPLATE_PLANS: Record<FeatureType, UserTemplatePlan>` (`prompts.ts:86`) is built once by `createStandardUserTemplatePlan(feature, template)` (`prompts.ts:147`) for all seven features. The plan is either:

- `segmented` — three ordered `PromptSegmentPlan`s: `user-static` (1h cache), `user-dynamic` (5m/ephemeral cache), `user-task` (no cache).
- `fallback` — a single unsegmented block; emitted when the required anchors are missing/out of order.

Segmentation logic in `createStandardUserTemplatePlan`:

- `contextAnchor` = `USER_DRAFT_ANCHOR` when `getFeaturePolicy(feature).requiresDraft`, else `USER_TRANSCRIPT_ANCHOR`.
- `contextIndex = template.indexOf(contextAnchor)`; if `< 0` → `fallback` with `warningAnchor = contextAnchor`.
- `taskIndex = template.lastIndexOf(USER_TASK_ANCHOR)`; if `< 0` **or** `contextIndex >= taskIndex` → `fallback` with `warningAnchor = USER_TASK_ANCHOR`.
- Otherwise: `user-static = slice(0, contextIndex)` (1h cache), `user-dynamic = slice(contextIndex, taskIndex)` (ephemeral cache), `user-task = slice(taskIndex)` (no cache).

Consequence worth noting: the 1h-cached "static" prefix ends at the first occurrence of the context anchor. For `improve-draft` the anchor is `## Current Draft`, which appears at the very top of `improve-draft.md` (line 3), so `user-static` is essentially just the opening sentence and virtually all template text (draft + transcript + rules) lands in the ephemeral `user-dynamic` block. For `fast-reply` the transcript anchor is near the end (after all examples/rules), so `user-static` holds the large rules/examples block.

### Input normalization

`normalizePromptBuildInput(input)` (`prompts.ts:193`) uses the feature policy to null-out fields the feature does not use:
- `draftText`: trimmed only if `policy.requiresDraft`, else `undefined`.
- `pingSegment`: kept only if `policy.usesPingSegment`.
- `replyMode`: `input.replyMode ?? 'default'` if `policy.supportsReplyMode`, else `undefined`.
- `replyTone`: `input.replyTone ?? 'none'` if `policy.supportsReplyTone`, else `undefined`.

### Section builders (all escape their dynamic content via `escapeForPrompt`)

- `buildSafetyPreamble(feature)` (`prompts.ts:208`) → REPLY vs ANALYSIS preamble by `promptMode`.
- `buildSplitReplyInstructions(feature, replyMode)` (`prompts.ts:214`) → non-empty only when `supportsReplyMode` **and** `replyMode === 'preferSplit'`; returns the `[NEXT]` split-mode bullet list. (Only `fast-reply` has `supportsReplyMode: true`.)
- `buildToneInstructions(feature, replyTone)` (`prompts.ts:232`) → `TONE_INSTRUCTIONS[replyTone] + '\n' + TONE_FOOTER` when `supportsReplyTone` and tone ≠ `none`. (Only `fast-reply` has `supportsReplyTone: true`.)
- `buildFanSpendingSection(data)` (`prompts.ts:246`) → `""` if blank, else `## Fan Spending Data\n\n<fan_spending_data>\n{escaped}\n</fan_spending_data>`.
- `buildFanSubscriptionSection(data)` (`prompts.ts:254`) → `""` if blank, else `## Fan Subscription Data\n\n<fan_subscription_data>\n{escaped}\n</fan_subscription_data>`.
- `buildFanBioSection(bio)` (`prompts.ts:262`) → `""` if blank, else `Fan bio: {escaped}`.
- `buildDraftSection(draftText)` (`prompts.ts:270`) → `""` if blank, else `<current_draft>\n{escaped}\n</current_draft>` (the `## Current Draft` heading lives in the template, not here — comment at `prompts.ts:275` notes emitting it here duplicated the heading).

### Placeholder substitution

`PromptTemplateReplacements` (`prompts.ts:128`) keys: `personality`, `transcript`, `fanSpendingSection`, `fanSubscriptionSection`, `fanDisplayName`, `fanBioSection`, `draftSection`, `splitReplyInstructions`, `toneInstructions`, `segmentInstructions`.

`buildPromptReplacements(input)` (`prompts.ts:352`) populates them:
- `personality = input.personality.content` — **not escaped** (trusted, model-owner content).
- `transcript = escapeForPrompt(input.transcript)`.
- `fanDisplayName = escapeForPrompt(input.fanDisplayName)`.
- `segmentInstructions` = `PING_SEGMENT_INSTRUCTIONS[input.pingSegment]` only when `featureUsesPingSegment(feature)` and a segment is present, else `""`.
- The rest come from the section builders above.

`applyTemplate(template, replacements)` (`prompts.ts:280`) — replaces every `/\{(\w+)\}/g` token with `replacements[key] ?? match` (unknown `{token}` is left verbatim). Runs once per rendered block.

### Block builders & cache-control handling

- `createTextBlock(text, cacheControl?)` (`prompts.ts:291`) → `{ type:'text', text }` plus `cache_control` when provided.
- `buildSystemBlocks(feature, personality)` (`prompts.ts:340`) → **two** blocks: `[0]` `safetyPreamble + SYSTEM_PERSONALITY_ANCHOR` (no cache), `[1]` the raw personality content with `ONE_HOUR_CACHE_CONTROL`. The cache breakpoint sits at the end of the personality block, so the cached system prefix = preamble + anchor + personality.
- `buildUserBlocks(feature, replacements)` (`prompts.ts:398`) → dispatches on the precomputed plan: `fallback` → `buildFallbackUserBlocks`; `segmented` → `renderSegmentBlocks`.
- `buildFallbackUserBlocks(feature, plan, replacements)` (`prompts.ts:377`) → calls `warnPromptCachingFallback` then returns a single uncached block of the fully-substituted template.
- `warnPromptCachingFallback(feature, anchor)` (`prompts.ts:331`) → `console.warn('[ChatGoose] Prompt caching disabled for {feature}: missing or invalid anchor "{anchor}"')`.
- `renderSegmentBlocks(segments, replacements)` (`prompts.ts:386`) → maps each segment through `applyTemplate` + its `cacheControl`.

### Exports

- `flattenPromptBlocks(blocks)` (`prompts.ts:300`) → concatenates `block.text` with **no separator** (`join('')`).
- `stripPromptCacheControl(blocks)` (`prompts.ts:306`) → clones blocks dropping `cache_control`.
- `buildPrompt(input): PromptPayload` (`prompts.ts:415`) → normalizes input, builds system + user blocks, returns `{ system: flatten(systemBlocks), user: flatten(userBlocks), systemBlocks, userBlocks }`. Docstring (`prompts.ts:409`) states personality is not escaped; transcript/draft/earnings/subscriptions/display-name are.
- `buildPromptRequest(input, promptCachingEnabled): PromptRequestBlocks` (`prompts.ts:315`) → calls `buildPrompt`, then returns the raw blocks when caching enabled or `stripPromptCacheControl`-ed blocks when disabled. `PromptRequestBlocks` = `{ prompt, systemBlocks, userBlocks }`. This is the primary entry point used by both operation coordinators.

### Boundary note

All strings produced here are shipped verbatim as the `system` string and user `content` blocks to **Anthropic** (`api.anthropic.com/v1/messages`) and **OpenRouter** (`openrouter.ai/api/v1/messages`). The `cache_control` markers map to Anthropic prompt-caching (`ephemeral`, `ttl:'1h'`). Escaping via `escapeForPrompt` is the injection defense applied to fan-derived fields before they enter these strings.

---

## `src/shared/prompt-injection.ts`

Single export `escapeForPrompt(text)` (`prompt-injection.ts:9`). Replaces, in order: `&`→`&amp;`, then `<`→`&lt;`, then `>`→`&gt;`. Order-critical (comment cites "spec §8.3"): `&` first to avoid double-encoding. No other characters touched (quotes, braces, brackets pass through). **Only imported by** `prompts.ts`. This is the sole sanitization layer for fan/transcript/draft text entering prompts.

---

## `src/shared/personalities.ts`

Owns the built-in "Lora" personality and personality persistence normalization. Imports `BUILD_TIME` from `./constants.js` and `Personality` type. **Called by** `shared/storage.ts` (`normalizeSavedPersonality`, `reconcileBundledPersonalities`) and referenced by `shared/migrations.ts`; tests import `createBundledPersonalities` and the two exported constants.

- `BUNDLED_LORA_PERSONALITY_ID = 'builtin:lora'` (`personalities.ts:4`).
- `BUNDLED_LORA_PERSONALITY_VERSION = 2` (`personalities.ts:5`).
- `LORA_PERSONALITY_CONTENT` (`personalities.ts:7`) — the full Lora persona markdown (a 22-year-old Minsk woman texting style, do/don't rules, sexting mode, message-length rules, offer guidance, hard limits). This is the string injected verbatim (unescaped) into the system prompt personality block.
- `bundledUpdatedAt` (`personalities.ts:176`) — IIFE: `Date.parse(BUILD_TIME)` if finite, else `0`.
- `BUNDLED_PERSONALITIES: Personality[]` (`personalities.ts:181`) — one entry: `{ id, name:'Lora', content, updatedAt: bundledUpdatedAt, builtin:true, builtinVersion:2 }`.

Exports:
- `createBundledPersonalities()` (`personalities.ts:192`) → shallow-clones each bundled entry (fresh array/objects).
- `normalizeSavedPersonality(personality)` (`personalities.ts:196`) → recomputes `updatedAt` (keep if finite & >0, else `Date.now()`); trims `name` (fallback `'Unnamed'`); for builtins preserves `builtin:true` and a numeric `builtinVersion` (only if `Number(builtinVersion)` is finite); non-builtins keep name/content/updatedAt.
- `reconcileBundledPersonalities(personalities)` (`personalities.ts:222`) → ensures the bundled Lora is present and current:
  - empty input → returns fresh bundled set, `changed:true`.
  - for each bundled: if missing by `id` → push it (`changed:true`); if present but `existing.builtin !== true` **or** `existing.builtinVersion !== bundled.builtinVersion` → replace in place (`changed:true`); otherwise leave. Copy-on-write of the array before first mutation.

---

## `src/shared/transcript.ts` (~594 lines)

Turns raw Fansly message pages into a chronological transcript string plus purchase/PPV evidence and ping analysis. Imports Fansly types + `NormalizedTranscriptMessage`, `PingSegmentAnalysis`, `PingSegment` from `./types.js`; `PING_MIN_FAN_MESSAGES` from `./constants.js`; `millsToUsd` from `./earnings.js`. **Called by** `background/fansly-client.ts` (`estimateTargetPages`, `extractOldestMessageId`, plus the `PpvAttachmentRequest`/`PurchaseEvidenceOverride` types), `background/conversation-context-loader.ts` (`buildPurchaseEvidence`, `collectUnverifiedPpvAttachmentRequests`), `background/operations.ts` and `background/compare-operations.ts` (`normalizeTranscript`, `formatTranscript`, `analyzePingSegment`). `buildTranscriptWindowStart` and `resolvePingSegment` are exercised only by `tests/transcript.test.ts` (no `src/` caller found).

### Constants

- `PING_ACTIVE_WINDOW_MS = 5*24*60*60*1000` (`transcript.ts:16`) — 5 days.
- Attachment content types: `ATTACHMENT_CONTENT_TYPE_MEDIA = 1`, `_BUNDLE = 2`, `_TIP = 7` (`transcript.ts:18`).
- Order types: `ORDER_TYPE_SINGLE = 1`, `ORDER_TYPE_BUNDLE = 2` (`transcript.ts:22`).

### Exported types

- `PpvAttachmentKind = 'single' | 'bundle'` (`transcript.ts:25`).
- `PpvAttachmentRequest { kind, contentId }` (`transcript.ts:27`).
- `PurchaseEvidenceOverride` (`transcript.ts:32`) — optional iterables `purchasedSingleIds`, `purchasedBundleIds`, `checkedNotPurchasedSingleIds`, `checkedNotPurchasedBundleIds`, plus `verificationIncomplete?: boolean`.
- `PurchaseEvidence` (`transcript.ts:88`) — `fanAccountKnown` + four `Set<string>` + `verificationIncomplete`.

### Media classification & PPV pricing

- `compareMessageIds(l, r)` (`transcript.ts:40`) — `localeCompare(..., 'en', { numeric:true })`, used as tie-breaker in sort.
- `classifyMedia(media)` (`transcript.ts:46`) — `media.media?.type ?? media.type`: `1`→photo, `2`→video, `3`→audio; else fall back to mimetype prefix (`image/`/`video/`/`audio/`); else `other`.
- `mediaLabelInner` (`transcript.ts:71`) — `Photo`/`Video`/`Audio`/`Media`.
- `formatCount(count, singular)` (`transcript.ts:84`) — `"N Photo"`/`"N Photos"` (pluralize unless count===1).
- `findPpvPermission(item)` (`transcript.ts:103`) — first `permissions.permissionFlags` entry with `(flags & 1) === 1`; presence of this flag is what marks an item as PPV.
- `extractPpvPriceMills(ppv)` (`transcript.ts:116`) — prefer numeric `ppv.price > 0`; else parse the JSON-encoded `ppv.metadata` string of shape `{"1":"{\"price\": <mills>}"}` and read `inner.price` if `>0`; else `null`. Malformed metadata → `null` (try/catch).
- `MediaState` (`transcript.ts:97`) — `free | ppv-purchased | ppv-not-purchased | ppv-unknown`, each PPV variant carries `priceMills: number | null`.
- `deriveAttachmentState(item, attachmentId, kind, evidence)` (`transcript.ts:139`) — no PPV flag → `free`. With PPV flag: if `!evidence.fanAccountKnown` → `ppv-unknown`; if the id is in the purchased set → `ppv-purchased`; if in the checked-not-purchased set → `ppv-not-purchased`; else `ppv-unknown`. Comment (`transcript.ts:169`) notes inline message orders are positive proof only; the not-purchased sets come from exact orderhistory verification.
- `formatPriceFragment(priceMills)` (`transcript.ts:176`) — `" $X.XX"` via `millsToUsd` when `>0`, else `""`.
- `ppvSuffix(state)` (`transcript.ts:180`) — `""` | `" — PPV$price, purchased"` | `" — PPV$price, not purchased"` | `" — PPV$price, unknown"`.
- `describeMedia(media, id, evidence)` (`transcript.ts:193`) → `[Photo — PPV $4.99, purchased]`-style label.
- `collectBundleChildIds(bundle)` (`transcript.ts:203`) — dedup ids from `bundle.bundleContent[].accountMediaId`, fallback to `bundle.accountMediaIds`.
- `describeBundle(bundle, id, mediaMap, evidence)` (`transcript.ts:226`) — counts photo/video children present in `mediaMap`; body `Media Bundle: N Photos, M Videos` (or bare `Media Bundle`) + `ppvSuffix`.
- `describeAttachment(attachment, mediaMap, bundleMap, evidence)` (`transcript.ts:265`) — TIP type → `null` (tips rendered via `totalTipAmount`); missing `contentId` → `null`; MEDIA → resolved `describeMedia` or literal `[Media]`; BUNDLE → resolved `describeBundle` or literal `[Media Bundle]`; `contentType === undefined` (legacy) → try bundle then media map, else `null`.

### Purchase evidence

- `addAll(target, values)` (`transcript.ts:310`) — adds non-empty string values into a set.
- `buildPurchaseEvidence(pages, fanAccountId, override = {})` (`transcript.ts:321`) — scans `page.accountMediaOrders` where `order.accountId === fanAccountId`:
  - `order.accountMediaBundleId && order.type !== ORDER_TYPE_SINGLE` → purchased **bundle**.
  - `order.type === ORDER_TYPE_SINGLE && order.accountMediaId` → purchased **single**.
  - `order.type === ORDER_TYPE_BUNDLE && order.accountMediaId` → purchased **bundle**.
  Then merges the override sets via `addAll`. Returns `PurchaseEvidence` with `fanAccountKnown = fanAccountId !== null && length>0` and `verificationIncomplete = Boolean(override.verificationIncomplete)`. When `fanAccountId` is falsy, no inline orders are scanned.
- `collectPageMaps(pages)` (`transcript.ts:367`) — `mediaMap` keyed by `accountMedia.id`, `bundleMap` keyed by `accountMediaBundles.id`.
- `isAlreadyResolved(evidence, kind, contentId)` (`transcript.ts:386`) — true if id already in the purchased or checked-not-purchased set for that kind.
- `pushUniquePpvRequest(requests, seen, evidence, kind, contentId)` (`transcript.ts:403`) — skips already-resolved ids and duplicates (`"{kind}:{contentId}"` seen-set).
- `collectUnverifiedPpvAttachmentRequests(pages, evidence)` (`transcript.ts:421`) — walks every message attachment; for PPV media/bundles not yet resolved, emits a de-duplicated `PpvAttachmentRequest[]`. Handles the legacy `contentType === undefined` case by trying bundle then media. This is the list `fansly-client.ts` uses to decide which orderhistory lookups to perform.

### Normalization & formatting

- `normalizeTranscript(pages, modelAccountId, fanAccountId = null, purchaseEvidenceOverride = {})` (`transcript.ts:471`) →
  - builds `mediaMap`/`bundleMap` and `evidence`;
  - dedupes messages by `message.id` (first occurrence wins across pages);
  - per message: builds `labels[]` from attachments (via `describeAttachment`, dropping `null`), appends `[Tip: $X.XX]` when `totalTipAmount > 0`;
  - `senderLabel = senderId === modelAccountId ? 'Model' : 'Fan'`;
  - `text`: `message.type === 1` → trimmed `content` (empty string if missing); otherwise the literal `'[System message]'`;
  - returns array sorted ascending by `createdAt`, tie-broken by `compareMessageIds(id)`.
- `pad(value)` / `formatLocalTime(createdAtSeconds)` (`transcript.ts:522`) — `HH:MM` in **local** timezone (`new Date(seconds*1000)`, `getHours`/`getMinutes`).
- `formatTranscript(messages)` (`transcript.ts:531`) — `'No conversation history.'` when empty; otherwise one line per message: `[HH:MM] {senderLabel}: {labels joined by space} {text}` (labels + text filtered for empties, joined by `\n`). This is the string that becomes `{transcript}` in the templates (then escaped by `buildPromptReplacements`).
- `buildTranscriptWindowStart(messages, nowMs)` (`transcript.ts:545`) — `nowMs - 90 days` when empty, else `messages[0].createdAt * 1000` (oldest message). Note: the 90-day literal duplicates `EARNINGS_FALLBACK_WINDOW_MS` in `constants.ts` but is hardcoded here rather than imported.

### Ping-segment analysis

- `isAuthoredTextMessage(m)` (`transcript.ts:552`) — `type === 1 && text.trim().length > 0`.
- `analyzePingSegment(messages, nowMs): PingSegmentAnalysis` (`transcript.ts:556`) — filters to authored text messages, then fan-authored ones. Default segment `segment-b`. If a latest fan text exists: `active` when its timestamp ≥ `nowMs - PING_ACTIVE_WINDOW_MS` (within 5 days); else `segment-a` when `fanTextMessages.length >= PING_MIN_FAN_MESSAGES` (3). Returns segment plus `fanTextMessageCount`, `latestFanTextAtMs`, `latestOverallTextSender`, `latestOverallTextAtMs`.
- `resolvePingSegment(messages, nowMs)` (`transcript.ts:584`) — `analyzePingSegment(...).segment`.

### Pagination helpers

- `estimateTargetPages(requestedCount)` (`transcript.ts:588`) — `Math.max(1, Math.ceil(requestedCount / 25))` (Fansly returns 25 messages/page).
- `extractOldestMessageId(messages)` (`transcript.ts:592`) — `messages[messages.length - 1].id` or `null`; treats the last array element as oldest (Fansly `/message` returns newest-first), used as the `before` cursor by `fansly-client.ts`.

---

## `src/shared/reply-output.ts`

Sanitizes raw LLM text into clean, insertable reply parts. Imports `splitByNext`, `splitByVariant` from `./split.js`. **Called by** `background/operations.ts` (`normalizeReplyParts`, `normalizeSingleReplyPart`, `normalizeVariantReplyParts`), `background/compare-operations.ts` (`normalizeReplyParts`), and `content/index.ts` (all four `normalize*` exports, including `normalizeProvidedReplyParts` for pre-split parts and re-normalizing parsed `help-me` `engaging`/`flirty` sections).

### Filters & cleaners

- `BRACKET_GARBAGE` (`reply-output.ts:3`) — set of stray bracket tokens (`[`, `]`, `["`, `"]`, `['`, `']`) that get discarded.
- `META_LEAK_PATTERNS` (`reply-output.ts:5`) — 16 regexes catching prompt/instruction leakage and AI-tell phrases, e.g. `prompt says`, `system prompt`, `ignore ... instructions`, `untrusted user input`, `stay in character`, `as an ai`, `generated (reply|message|response)`, plus split-instruction echoes (`single message`, `single reply`, `most replies should`, `output only`). Comment (`reply-output.ts:8`) explains a bare "instructions" match was deliberately avoided to keep legitimate in-character lines (e.g. JOI "follow my instructions").
- `stripThinkBlocks(text)` (`reply-output.ts:26`) — removes `<think>…</think>` tags and fenced ` ```think|thinking|reasoning|chain-of-thought ` code blocks.
- `stripWrappingQuotes(text)` (`reply-output.ts:32`) — repeatedly strips matched surrounding straight/curly single/double quotes until stable.
- `stripReplyPrefix(text)` (`reply-output.ts:47`) — removes leading `message N:` / `reply:` / `response:` and `here's a reply:` style prefixes.
- `isMetaLeakLine(line)` (`reply-output.ts:54`) — true if a non-empty trimmed line matches any `META_LEAK_PATTERNS`.
- `removeMetaLeakLines(text)` (`reply-output.ts:62`) — drops offending lines (line-by-line), trims.

### Public functions

- `sanitizeReplyPart(part)` (`reply-output.ts:70`) — pipeline: strip think blocks → remove meta-leak lines → strip reply prefix → strip wrapping quotes.
- `isInsertableReplyPart(part)` (`reply-output.ts:77`) — false for empty, bracket-garbage, or meta-leak lines.
- `normalizeParts(rawText, split)` (`reply-output.ts:88`, internal) — `split(stripThinkBlocks(rawText)).map(sanitizeReplyPart).filter(isInsertableReplyPart)`.
- `normalizeReplyParts(rawText)` (`reply-output.ts:97`) — split on `[NEXT]`.
- `normalizeVariantReplyParts(rawText)` (`reply-output.ts:101`) — split on `[VARIANT]` (used for `hi-greeting`).
- `normalizeProvidedReplyParts(parts)` (`reply-output.ts:105`) — sanitize+filter an already-split array.
- `normalizeSingleReplyPart(rawText)` (`reply-output.ts:111`) — sanitize as one unit (no splitting); returns `[part]` or `[]` (used for `improve-draft`, which forbids `[NEXT]`).

---

## `src/shared/split.ts`

Marker-based splitting (spec §8.2, split only after stream completes). Two exports:

- `splitByNext(text)` (`split.ts:6`) — `text.split('[NEXT]')`, trim each, drop empties.
- `splitByVariant(text)` (`split.ts:17`) — same on `[VARIANT]`.

**Called by** `reply-output.ts` only.

---

## `src/shared/xml.ts`

Extracts structured output from `help-me`/`chat-review` responses. Imports `ChatReviewParsed`, `HelpMeParsed` types. **Called by** `background/operations.ts:408,410` (`parseHelpMeXml`, `parseChatReviewXml`).

- `extractTag(raw, tag)` (`xml.ts:3`, internal) — `new RegExp('<tag>([\\s\\S]*?)</tag>', 'i')`; non-greedy, case-insensitive, single-shot; returns the trimmed capture or `null`. No un-escaping of entities.
- `parseHelpMeXml(raw): HelpMeParsed` (`xml.ts:8`) — extracts `coaching`, `engaging`, `flirty`; `valid = Boolean(coaching && engaging && flirty)`; carries `raw`.
- `parseChatReviewXml(raw): ChatReviewParsed` (`xml.ts:22`) — extracts `rating` (only if `/^\d+$/`), `evaluation`, `recommendations`; `validRating` requires `1 ≤ rating ≤ 10` (else `null`); `valid = Boolean(validRating && evaluation && recommendations)`; carries `raw`.

These tags correspond to the `## Output Format` XML in `help-me.md` (`<coaching>/<engaging>/<flirty>`) and `chat-review.md` (`<rating>/<evaluation>/<recommendations>`).

---

## `src/shared/subscriptions.ts`

Formats a normalized `FanSubscriptionContext` (+ optional `FanslySubscriptionTier`) into the `{fanSubscriptionData}` prompt block. Imports `millsToUsd` from `./earnings.js` and the two types. **Called by** `background/operations.ts:2143` and `background/compare-operations.ts:937` (`formatFanSubscriptionData`). Output is later escaped and wrapped by `buildFanSubscriptionSection` in `prompts.ts`.

### Constants / helpers

- `MS_PER_DAY = 86_400_000` (`subscriptions.ts:4`).
- `SUBSCRIPTION_STATUS_LABELS` (`subscriptions.ts:6`) — `3:'Active'`, `4:'Active (alternate)'`, `5:'Expired'`.
- `billingCycleLabel(days)` (`subscriptions.ts:12`) — `30→month`, `90→3 months`, `180→6 months`, `365→year`, else `"{days} days"`.
- `formatShortDate(ms)` (`subscriptions.ts:20`) — `en-US`, `{month:'short',day:'numeric',year:'numeric'}`, **UTC**.
- `daysBetween(from, to)` (`subscriptions.ts:29`) — `floor(abs(to-from)/day)`.
- `isActive(status)` (`subscriptions.ts:33`) — `status === 3 || 4`.
- `isGift(sub)` (`subscriptions.ts:37`) — `giftCodeId !== null && giftCodeId !== '0' && price === 0`.
- `isPromoActive(sub)` (`subscriptions.ts:41`) — `promoPrice !== null` and (`promoStatus === 1` when non-null, else defaults true).
- `formatUsd(value)` (`subscriptions.ts:51`) — `'Unknown'` when null, else `"$X.XX"`.

### Exports / structure

- `formatFanSubscriptionData(subscription, tier = null, now = Date.now()): string` (`subscriptions.ts:66`) — returns `''` when both null; otherwise starts `['FAN SUBSCRIPTION DATA:']` and dispatches to `formatWithSubscription` (when subscription present) or, tier-only, pushes `Status: Not subscribed` + `formatTierDetails`. Joined by `\n`.
- `formatWithSubscription(lines, sub, tier, now)` (`subscriptions.ts:87`) emits, conditionally:
  - `Source`, `Subscriber account ID`, `Tier: {name} ({renewPrice or price}/{cycle})`.
  - Status: for active subs, base `Active` + gift note (`gift subscription — paid $X, renewal price …`) or promo note (`promotional price: $X`); for inactive, `SUBSCRIPTION_STATUS_LABELS[status]` with ended-date + days-ago + "Was subscribed for: N days" when `endsAtIso`/`createdAtIso` available (fallback `Status: {label} ({status})`).
  - `Subscribed since: {date} (N days ago)`.
  - For active + `endsAtIso`: `Current period ends: {date} (in N days)` when future, else `(ended N days ago — period lapsed)` (comment `subscriptions.ts:140` notes this avoids `daysBetween`'s abs-value misreporting when Fansly leaves an active status with a past `endsAt`).
  - Auto-renew: `On (renews at {tierPrice})` / `Off — will NOT renew (churn risk)`.
  - `Billing cycle: N days`.
  - Promo block (`Promo active: Yes`, `Promo price`, optional `Promo duration`).
  - Gift block (`Gift code: {id}`).
  - `Benefits:` list from `tier.subscriptionBenefits`.
  - `Available plans:` list — only when `tier.plans` filtered to `status === 1` has **more than one** entry.
- `formatTierDetails(lines, tier)` (`subscriptions.ts:195`) — tier-only path: picks a `billingCycle === 30` active plan for the base price/cycle (else first active plan, else `tier.price`/month), emits `Available tier: {name} ($X/{cycle})` + benefits.

---

## `src/shared/earnings.ts`

Aggregates Fansly earnings rows and formats the `{fanSpendingData}` prompt block; also owns `millsToUsd` (mills→USD, used across transcript/subscriptions). Imports earnings types from `./types.js`. **Called by** `background/fansly-client.ts:646` (`aggregateEarnings`), `background/operations.ts` (`aggregateMonthlyEarnings`, `formatFanSpendingData`, `monthWindowMs`), `background/compare-operations.ts` (`aggregateMonthlyEarnings`, `formatFanSpendingData`); `millsToUsd` is imported by `transcript.ts` and `subscriptions.ts`.

### Constants / helpers

- `LABELS` (`earnings.ts:10`) — earnings type → label: `2110:'Subscription'`, `2116:'Subscription renewal'`, `7101:'Tip or media purchase'`, `15001:'Message tip / paid message'`. Unknown types render as `"Unknown (type N)"`.
- `MONTH_NAMES` (`earnings.ts:17`) — `Jan…Dec`.
- `millsToUsd(value)` (`earnings.ts:22`) — `(value/1000).toFixed(2)` (Fansly amounts are in mills).
- `monthWindowMs(year, month)` (`earnings.ts:26`) — `{ start: Date.UTC(year, month-1, 1), end: Date.UTC(year, month, 1) }` (1-based month input).
- `buildBreakdownMap(rows)` (`earnings.ts:43`) — sums `gross`/`net` per `row.type`.
- `breakdownFromMap(map)` (`earnings.ts:54`) — to `EarningsBreakdownEntry[]` (`label`, `type`, `gross`, `net`), sorted by `gross` descending.

### Exports

- `aggregateMonthlyEarnings(rows)` (`earnings.ts:32`) — maps `MonthlyEarningsRow[]` → `MonthlyEarningsTotal[]` (`year/month/totalGross/totalNet`), sorted year-desc then month-desc.
- `aggregateEarnings(rows, correlationAccountId, windowStartMs, windowEndMs): AggregatedEarnings` (`earnings.ts:65`) — builds breakdown + `totalGross`/`totalNet` (summed from breakdown), sets `windowStartIso`/`windowEndIso` from the passed window, and returns `monthlyTotals: []` (empty; callers fill monthly data separately via `aggregateMonthlyEarnings`).
- `formatMonthLabel(year, month)` (`earnings.ts:86`) — `"{Mon} {year}"`.
- `formatBreakdownLine(entry)` (`earnings.ts:90`) — `"{label} $X.XX"` (gross).
- `formatFanSpendingData(aggregated): string` (`earnings.ts:94`) — emits:
  - Header `FAN SPENDING DATA:`, `Correlation account ID`, `Total gross (all-time): $X`, `Total net (all-time): $X`.
  - `Type breakdown (all-time):` bullet list when `breakdown.length > 0`.
  - `Monthly totals:` bullet list when `monthlyTotals.length > 0`.
  - `Monthly breakdown by type:` list when `monthlyBreakdowns?.length > 0` (each month's `formatBreakdownLine` joined by `, `).
  - `(some months could not be fetched)` when `monthlyBreakdownsPartial`.
  - Joined by `\n`. Output is later escaped/wrapped by `buildFanSpendingSection` in `prompts.ts`.

Note on labeling: the header lines say "all-time" unconditionally even though `aggregateEarnings` records a specific `windowStart/EndIso`; the window ISO fields are stored on the object but are not surfaced by `formatFanSpendingData`. `EARNINGS_FALLBACK_WINDOW_MS` (90 days) lives in `constants.ts:151`, not in this file; this module receives the window as explicit `windowStartMs`/`windowEndMs` arguments.

---

## Bundled templates `prompts/*.md`

Each template is imported as a text string and rendered via `applyTemplate`. Placeholders are `{name}` tokens matched by `/\{(\w+)\}/g` (see `PromptTemplateReplacements`). All feature templates except `hi-greeting.md` use the `## Conversation Transcript` context anchor; `improve-draft.md` uses `## Current Draft`. Every template ends with a `## Your Task` section (the `user-task` segment).

| Template | Role | Placeholders present | Structured output | Segmentation anchor |
|---|---|---|---|---|
| `fast-reply.md` | Generate the next in-character reply to the fan; heavy GOOD/BAD example set; short-reply guidance; explains PPV/media tag semantics | `{transcript}`, `{fanSpendingSection}`, `{fanSubscriptionSection}`, `{splitReplyInstructions}`, `{toneInstructions}` | plain text; may use `[NEXT]` | `## Conversation Transcript` (line 72); `## Your Task` (line 82) |
| `improve-draft.md` | Rewrite a chatter's draft in the model's voice; preserve intent/prices/emotion; translate to fan's language; strong anti-AI rules; forbids `[NEXT]` | `{draftSection}`, `{transcript}`, `{fanSpendingSection}`, `{fanSubscriptionSection}` | one plain-text message | `## Current Draft` (line 3, near top → tiny static segment); `## Your Task` (line 48) |
| `help-me.md` | Coaching + two ready-to-send suggestions | `{transcript}`, `{fanSpendingSection}`, `{fanSubscriptionSection}` | XML `<coaching>`,`<engaging>`,`<flirty>` → `parseHelpMeXml` | `## Conversation Transcript` (line 35); `## Your Task` (line 44) |
| `fan-summary.md` | Full 7-section fan dossier/profile **written in Russian**; skip empty sections | `{transcript}`, `{fanSpendingSection}`, `{fanSubscriptionSection}` | plain text (sectioned) | `## Conversation Transcript` (line 72); `## Your Task` (line 81) |
| `chat-review.md` | Rate & review the chatter's performance (1–10) across 5 dimensions | `{transcript}`, `{fanSpendingSection}`, `{fanSubscriptionSection}` | XML `<rating>`,`<evaluation>`,`<recommendations>` → `parseChatReviewXml` | `## Conversation Transcript` (line 34); `## Your Task` (line 43) |
| `ping.md` | Reactivation "ping" to a quiet fan; segment strategy injected; PPV-tag semantics; anti-AI/anti-generic rules | `{transcript}`, `{fanSpendingSection}`, `{fanSubscriptionSection}`, `{segmentInstructions}` | plain text; may use `[NEXT]` | `## Conversation Transcript` (line 42); `## Your Task` (line 51) |
| `hi-greeting.md` | Cold-open / greeting DM; extract a name from the username; produce **3 variants** | `{transcript}`, `{fanDisplayName}`, `{fanBioSection}` | plain text with `[VARIANT]` separators → `normalizeVariantReplyParts` | `## Conversation Transcript` (line 44); `## Your Task` (line 55) |

The PPV/media-tag semantics paragraph (identical wording) appears in `fast-reply.md`, `improve-draft.md`, `help-me.md`, and `ping.md`, teaching the model to read the `[… — PPV $X.XX, purchased/not purchased/unknown]` and `[Media Bundle: N Photos, M Videos]` labels emitted by `transcript.ts` without quoting them back.

Note: `hi-greeting.md` does **not** reference `{fanSpendingSection}`/`{fanSubscriptionSection}` (consistent with its policy `includesEarnings: false` in `features.ts`); `buildPromptReplacements` still computes those keys, but `applyTemplate` never substitutes them because the tokens are absent. Its `{fanDisplayName}`/`{fanBioSection}` land in the ephemeral `user-dynamic` segment (they follow the transcript anchor), so the fan name/bio are not part of the 1h-cached prefix.

---

## Boundary crossings (this module's surface)

These files do no direct I/O; the "boundary" is the **prompt content** they emit for the LLM boundaries and the bundled template assets.

| Kind | Detail | Data crossing |
|---|---|---|
| network (indirect) | Anthropic Messages API `https://api.anthropic.com/v1/messages` — via `anthropic-client.ts`/`llm-client.ts` | `system` string + user `content` blocks assembled by `buildPromptRequest`; `cache_control: {type:'ephemeral'[, ttl:'1h']}` breakpoints |
| network (indirect) | OpenRouter `https://openrouter.ai/api/v1/messages` — via `openrouter-client.ts` | same assembled blocks (cache-control stripped when `promptCachingEnabled` false) |
| distribution | `prompts/fast-reply.md`, `improve-draft.md`, `help-me.md`, `fan-summary.md`, `chat-review.md`, `ping.md`, `hi-greeting.md` bundled as text (`esbuild` `.md:'text'` loader) | template strings compiled into the extension |
| ipc / data-shape | `PromptBuildInput` / `PromptPayload` / `PromptTextBlock` (`types.ts`) consumed/produced here; `HelpMeParsed`/`ChatReviewParsed` produced by `xml.ts`; `NormalizedTranscriptMessage`, `PpvAttachmentRequest`, `PurchaseEvidenceOverride` produced/consumed by `transcript.ts` and its background callers | typed structs passed between `background/` and `content/` |

No `browser.storage.*`, no DOM access, no `runtime.sendMessage`/Port usage inside these files.

---

## Cross-module dependencies

- `prompts.ts` → `./features.js` (`getFeaturePolicy`, `featureUsesPingSegment`), `./prompt-injection.js` (`escapeForPrompt`), the seven `prompts/*.md`, `./types.js`.
- `prompt-injection.ts` → (none) — imported only by `prompts.ts`.
- `personalities.ts` → `./constants.js` (`BUILD_TIME`), `./types.js`; imported by `shared/storage.ts`, `shared/migrations.ts`.
- `transcript.ts` → `./constants.js` (`PING_MIN_FAN_MESSAGES`), `./earnings.js` (`millsToUsd`), `./types.js`; imported by `background/{fansly-client,conversation-context-loader,operations,compare-operations}.ts`.
- `reply-output.ts` → `./split.js`; imported by `background/{operations,compare-operations}.ts` and `content/index.ts`.
- `split.ts` → (none) — imported only by `reply-output.ts`.
- `xml.ts` → `./types.js`; imported by `background/operations.ts`.
- `subscriptions.ts` → `./earnings.js` (`millsToUsd`), `./types.js`; imported by `background/{operations,compare-operations}.ts`.
- `earnings.ts` → `./types.js`; imported by `transcript.ts`, `subscriptions.ts`, `background/{fansly-client,operations,compare-operations}.ts`.

---

## Discrepancies / open questions found

1. **`improve-draft` 1h cache prefix is near-empty.** Because `createStandardUserTemplatePlan` ends the 1h-cached `user-static` segment at the first `## Current Draft` occurrence, and that anchor is at the very top of `improve-draft.md` (line 3), the "static/cacheable" user block is just the opening sentence; the transcript, rules, and anti-AI rules all fall into the ephemeral `user-dynamic` block. (Behavioral, not a bug — noting because the segment names imply a larger stable prefix.)
2. **"all-time" label vs. windowed data.** `formatFanSpendingData` labels totals as "(all-time)" unconditionally, while `aggregateEarnings` records concrete `windowStartIso`/`windowEndIso` from its `windowStartMs`/`windowEndMs` arguments (those ISO fields are never surfaced in the formatted output). Whether the passed window is truly all-time depends on the caller.
3. **`aggregateEarnings` returns empty `monthlyTotals`.** The function always sets `monthlyTotals: []` (and leaves `monthlyBreakdowns` undefined); monthly data is produced separately by `aggregateMonthlyEarnings` and merged onto the object by the background callers, so `formatFanSpendingData`'s monthly sections only render if the caller populated them.
4. **Duplicated 90-day literal.** `buildTranscriptWindowStart` hardcodes `90 * 24 * 60 * 60 * 1000` rather than importing `EARNINGS_FALLBACK_WINDOW_MS` (`constants.ts:151`), which holds the same value.
5. **`buildTranscriptWindowStart` / `resolvePingSegment` have no `src/` callers.** Both are exported and covered by `tests/transcript.test.ts` but are not referenced by any background/content code found; live ping logic uses `analyzePingSegment` directly (`operations.ts:1861`).
6. **`formatLocalTime` uses local timezone, `subscriptions`/`earnings` dates use UTC.** Transcript timestamps render in the extension host's local time (`getHours`/`getMinutes`), whereas subscription/earnings dates are formatted with `timeZone:'UTC'`. The two prompt sections can therefore express different timezones for the same fan.
7. **`ppvSuffix` reports listed price, not paid price.** The `$X.XX` in a PPV tag is the listing/asking price from `permissionFlags`, which the templates explicitly warn is "not necessarily what the fan paid." The `ppv-purchased` state comes from order matching in `buildPurchaseEvidence` and does not carry the actual paid amount.
8. **`PurchaseEvidence.verificationIncomplete` is threaded but unused in formatting.** It is set from the override and stored on the evidence object, but `deriveAttachmentState`/`ppvSuffix` never read it; unverified items simply render as `unknown`.
