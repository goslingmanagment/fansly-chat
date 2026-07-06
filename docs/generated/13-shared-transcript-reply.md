> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# Shared: transcript, reply-output, split, earnings, subscriptions

This module documents five files under `src/shared/` that turn raw Fansly data
into the plain strings the extension ships to the kernel as `clientContext`, and
that turn the model's returned text back into insertable message parts:

- `src/shared/transcript.ts` — builds the conversation transcript string.
- `src/shared/earnings.ts` — normalizes fan earnings into the spending-data string.
- `src/shared/subscriptions.ts` — normalizes fan subscription status into the subscription-data string.
- `src/shared/reply-output.ts` — parses the model's raw text into cleaned reply parts.
- `src/shared/split.ts` — splits raw text on `[NEXT]` / `[VARIANT]` markers.

## No prompt assembly in this repo

Post-1.6.0, prompt ASSEMBLY (system/user templates, personas, platform wording,
budgets, capture, ledger) is **kernel-side**. `src/shared/prompts.ts` does not
exist (confirmed: `ls src/shared/prompts.ts` → no such file). There is no
`applyPlatformWording`, no `buildPrompt`/`assemblePrompt`, and no
`systemBlocks`/`userBlocks` construction anywhere in `src/` (grep returns
nothing outside dead type declarations). The types `PromptBuildInput`,
`PromptPayload`, and `PromptTextBlock` still exist in
`src/shared/types.ts:147-223` but are **not referenced** by any code — they are
residual declarations.

The comment "Does NOT escape — escaping happens in the prompt builder" in
`src/shared/subscriptions.ts:64` describes a prompt builder that no longer lives
in this repo; the functions here return raw strings and nothing in the extension
escapes or wraps them into a template afterward.

At generation time the extension sends the persona by **id only**
(`personaKey: personality.id`, `src/background/operations.ts:2076`); the
personality's `content` field is never assembled into a prompt here. The
extension's job in this territory is: (1) assemble the transcript string plus the
fan display / spending / subscription VALUE strings that ride in `clientContext`
(see [What crosses to the kernel](#what-crosses-to-the-kernel-as-clientcontext)),
and (2) parse the model's returned text back into reply parts.

---

## Transcript assembly (`transcript.ts`)

### `normalizeTranscript(pages, modelAccountId, fanAccountId=null, purchaseEvidenceOverride={})`

`src/shared/transcript.ts:471-520`. Turns an array of
`FanslyMessagePageResponse` pages into a sorted `NormalizedTranscriptMessage[]`.

- **Media/bundle maps** are collected across all pages first
  (`collectPageMaps`, `src/shared/transcript.ts:367-384`); **purchase evidence**
  is built from `accountMediaOrders` filtered to the fan
  (`buildPurchaseEvidence`, `src/shared/transcript.ts:321-365`).
- **Dedup by message id, first occurrence wins**: a message id already in the
  map is skipped (`src/shared/transcript.ts:483-486`). Confirmed by
  `tests/transcript.test.ts:64` ("first occurrence kept").
- **Sender label** is `'Model'` when `message.senderId === modelAccountId`, else
  `'Fan'` (`src/shared/transcript.ts:506`).
- **Text**: for `type === 1` messages it is `message.content` trimmed; for any
  other type it is the literal `'[System message]'`
  (`src/shared/transcript.ts:508`).
- **Labels** (an array of bracketed tags) are computed per message:
  - Each attachment is described via `describeAttachment`
    (`src/shared/transcript.ts:265-308`); a `null` result is dropped
    (`src/shared/transcript.ts:491-496`).
  - If `message.totalTipAmount > 0`, a `[Tip: $<usd>]` label is appended
    (`src/shared/transcript.ts:498-500`), where `<usd>` is `millsToUsd`.
  - Tip **attachments** (contentType 7) return `null` and are NOT labelled as
    media — the money is surfaced only through `totalTipAmount`
    (`src/shared/transcript.ts:274-277`).

**Attachment labels** (`describeMedia` / `describeBundle`,
`src/shared/transcript.ts:193-263`):

- Single media classify to `[Photo]`, `[Video]`, `[Audio]`, or `[Media]`
  (`mediaLabelInner`, `src/shared/transcript.ts:71-82`); classification reads
  `media.media.type` (1/2/3) first, then mimetype prefix
  (`classifyMedia`, `src/shared/transcript.ts:46-69`).
- Bundles render `[Media Bundle: N Photos, M Videos]` (photo/video counts only;
  audio/other are counted-skipped), or `[Media Bundle]` when no counts resolve
  (`src/shared/transcript.ts:226-263`).
- PPV media append a suffix from `ppvSuffix`
  (`src/shared/transcript.ts:180-191`): ` — PPV[ $<price>], purchased` /
  `, not purchased` / `, unknown`, e.g. `[Video — PPV $80.00, purchased]`
  (`tests/transcript.test.ts:142`). The price fragment is omitted when no
  positive price is known (`[Video — PPV, unknown]`,
  `tests/transcript.test.ts:622`). Purchase state degrades to `unknown` when
  `fanAccountId` is null/unknown; `not purchased` requires explicit
  checked-not-purchased evidence (`deriveAttachmentState`,
  `src/shared/transcript.ts:139-174`).
- Prices come from `extractPpvPriceMills` which prefers a positive numeric
  `price`, else a JSON-encoded `metadata` string, else null
  (`src/shared/transcript.ts:116-137`).

**Ordering**: the final array is sorted ascending by `createdAt`; ties break by
`compareMessageIds`, a numeric-aware `localeCompare` on the id string
(`src/shared/transcript.ts:40-42`, `514-519`). So the transcript reads
oldest → newest.

### `formatTranscript(messages)`

`src/shared/transcript.ts:531-543`. Renders the normalized array into the single
string that crosses to the kernel.

- Empty input returns the literal `'No conversation history.'`
  (`src/shared/transcript.ts:532-534`; `tests/transcript.test.ts:779`).
- Each message becomes one line:
  `[HH:MM] <SenderLabel>: <payload>` where `<payload>` is the labels joined by a
  space, then the text, joined by a space and trimmed
  (`src/shared/transcript.ts:536-541`). Confirmed shape
  `^\[\d{2}:\d{2}\] Fan: hi there$` (`tests/transcript.test.ts:785`) and
  `[Tip: $5.00] love you` (`tests/transcript.test.ts:791`).
- `[HH:MM]` is **local wall-clock time** of the machine running the background
  script: `formatLocalTime` uses `Date.getHours()`/`getMinutes()` on
  `createdAt * 1000` (`src/shared/transcript.ts:526-529`) — `createdAt` is in
  seconds. This is not UTC.
- Lines are joined with `\n` (`src/shared/transcript.ts:542`).

### Related helpers (not part of the string, but in this file)

- `analyzePingSegment` / `resolvePingSegment`
  (`src/shared/transcript.ts:556-586`): classify the conversation into
  `'active'` / `'segment-a'` / `'segment-b'` from fan text-message recency and
  count. `active` when the latest fan text is within
  `PING_ACTIVE_WINDOW_MS` (5 days, `src/shared/transcript.ts:16`); `segment-a`
  when ≥ `PING_MIN_FAN_MESSAGES` (3, `src/shared/constants.ts:92`) fan texts;
  else `segment-b`. Only `type === 1` non-empty messages count
  (`isAuthoredTextMessage`, `src/shared/transcript.ts:552-554`). The resulting
  `pingSegment` rides in `clientContext` for ping features.
- `buildTranscriptWindowStart` (`src/shared/transcript.ts:545-550`),
  `estimateTargetPages` (`src/shared/transcript.ts:588-590`, `ceil(count/25)`),
  `extractOldestMessageId` (`src/shared/transcript.ts:592-594`) — paging
  utilities used by the message loader, not part of the emitted strings.
- `collectUnverifiedPpvAttachmentRequests` (`src/shared/transcript.ts:421-469`)
  enumerates PPV attachments needing orderhistory verification.

---

## What crosses to the kernel as `clientContext`

The consumer type is `KernelFeatureClientContext`
(`src/background/kernel-feature-gateway.ts:18-26`):

```
transcript: string;
messageCount: number;
fanDisplayName: string;
fanSpendingData: string;
fanSubscriptionData: string;
fanBio?: string;
pingSegment?: PingSegment;
```

These are assembled in `src/background/operations.ts:2081-2089`:

- `clientContext.transcript` = the exact return value of
  `formatTranscript(transcriptMessages)`
  (`src/background/operations.ts:2057`, `2082`). It is the newline-joined
  `[HH:MM] Model/Fan: labels text` block described above (or
  `'No conversation history.'`). No further templating is applied.
- `messageCount` = `transcriptMessages.length`
  (`src/background/operations.ts:2083`).
- `fanSpendingData` = the return of `formatFanSpendingData(...)` — see below;
  may be `''` when earnings were skipped/failed
  (`src/background/operations.ts:1811`, `1992`, `2085`).
- `fanSubscriptionData` = the return of `formatFanSubscriptionData(...)`; may be
  `''` when no subscription/tier was found
  (`src/background/operations.ts:1813`, `2015`, `2086`).
- `fanBio` is included only for the `hi-greeting` feature, sourced from the fan
  account's `about` field (`src/background/operations.ts:1775-1777`, `2087`).
- `pingSegment` is included only for ping features
  (`src/background/operations.ts:2088`).

The gateway module header states the design explicitly: the extension "keeps
loading context itself" and the request "carries `clientContext` VALUES; prompt
ASSEMBLY (templates, personas, platform wording, budgets, capture, ledger) is
kernel-side" (`src/background/kernel-feature-gateway.ts:6-9`). The same intent is
repeated at the call site (`src/background/operations.ts:2058-2061`).

---

## Fan spending data string (`earnings.ts`)

### `millsToUsd(value)`

`src/shared/earnings.ts:21-23`. `(value / 1000).toFixed(2)` — divides by 1000
and renders exactly two decimals. So `millsToUsd(10000)` → `"10.00"`,
`millsToUsd(500)` → `"0.50"` (`tests/earnings.test.ts:28-42`). Sub-cent
precision is rounded away by `toFixed(2)`. This is the money formatter reused by
`transcript.ts` and `subscriptions.ts` (imported at
`src/shared/transcript.ts:14`, `src/shared/subscriptions.ts:1`).

### `formatFanSpendingData(aggregated)`

`src/shared/earnings.ts:93-128`. Builds a multi-line block from an
`AggregatedEarnings`. Lines, in order:

1. `FAN SPENDING DATA:`
2. `Correlation account ID: <id>`
3. `Total gross (all-time): $<usd>`
4. `Total net (all-time): $<usd>`
5. If breakdown non-empty: `Type breakdown (all-time):` then one
   `- <label>: $<gross-usd>` per entry
   (`src/shared/earnings.ts:101-106`).
6. If `monthlyTotals` non-empty: `Monthly totals:` then
   `- <Mon Year>: $<gross-usd>` per row (`src/shared/earnings.ts:108-113`).
7. If `monthlyBreakdowns` non-empty: `Monthly breakdown by type:` then
   `- <Mon Year>: <label $usd>, ...` per month
   (`src/shared/earnings.ts:115-122`).
8. If `monthlyBreakdownsPartial`: `(some months could not be fetched)`
   (`src/shared/earnings.ts:123-125`).

Joined with `\n` (`src/shared/earnings.ts:127`).

**Type labels** come from `LABELS` (`src/shared/earnings.ts:9-14`):
`2110 → Subscription`, `2116 → Subscription renewal`,
`7101 → Tip or media purchase`, `15001 → Message tip / paid message`; unknown
types render `Unknown (type <n>)` (`src/shared/earnings.ts:59`).

`aggregateEarnings` (`src/shared/earnings.ts:64-83`) sums gross/net per type,
sorts breakdown descending by gross (`src/shared/earnings.ts:53-62`), and always
sets `monthlyTotals: []`. Monthly totals/breakdowns are attached later by the
caller (`src/background/operations.ts:1984-1990`) — `formatFanSpendingData` only
renders whatever is present on the object.

---

## Fan subscription data string (`subscriptions.ts`)

### `formatFanSubscriptionData(subscription, tier=null, now=Date.now())`

`src/shared/subscriptions.ts:66-85`. Returns `''` when both `subscription` and
`tier` are null (`src/shared/subscriptions.ts:71-73`;
`tests/subscriptions.test.ts:51`). Otherwise the first line is
`FAN SUBSCRIPTION DATA:` and one of two branches runs.

**With a subscription** (`formatWithSubscription`,
`src/shared/subscriptions.ts:87-193`) — lines are conditionally emitted:

- `Source: <sub.source>` (either `/api/v1/messaging/groups` or
  `/api/v1/subscribers`), `Subscriber account ID: <id>`,
  `Tier: <name> (<renewPrice-or-price>/<cycle>)`
  (`src/shared/subscriptions.ts:98-100`).
- **Status** (`src/shared/subscriptions.ts:103-125`): active statuses (3 or 4,
  `isActive`, `src/shared/subscriptions.ts:33-35`) render `Status: Active`, with
  a gift nuance (`isGift`: `giftCodeId` non-null/non-`'0'` and `price === 0`,
  `src/shared/subscriptions.ts:37-39`) or a promo nuance (`isPromoActive`,
  `src/shared/subscriptions.ts:41-49`). Non-active statuses use
  `SUBSCRIPTION_STATUS_LABELS` (`3→Active`, `4→Active (alternate)`,
  `5→Expired`, else `Unknown`, `src/shared/subscriptions.ts:6-10`) and, when an
  `endsAtIso` exists, append `(ended <date> — <n> days ago)` plus
  `Was subscribed for: <n> days`.
- `Subscribed since: <date> (<n> days ago)` when `createdAtIso` is present
  (`src/shared/subscriptions.ts:128-132`).
- `Current period ends: <date> (in <n> days)` for active subs with a future
  `endsAtIso`; if the `endsAt` is already past while still marked active
  (Fansly data lag), it renders `(ended <n> days ago — period lapsed)` instead
  of a phantom future date (`src/shared/subscriptions.ts:134-145`;
  `tests/subscriptions.test.ts:64-69`).
- Auto-renew: `Auto-renew: On (renews at <tierPrice>)` or
  `Auto-renew: Off — will NOT renew (churn risk)`
  (`src/shared/subscriptions.ts:148-154`).
- `Billing cycle: <n> days` (`src/shared/subscriptions.ts:157-159`);
  cycle words are `month`/`3 months`/`6 months`/`year` for 30/90/180/365, else
  `<n> days` (`billingCycleLabel`, `src/shared/subscriptions.ts:12-18`).
- Promo lines (`Promo active: Yes`, `Promo price`, optional `Promo duration`)
  when a promo is active (`src/shared/subscriptions.ts:161-168`).
- `Gift code: <id>` when gifted (`src/shared/subscriptions.ts:170-173`).
- `Benefits:` list from the tier, and `Available plans:` list (only when more
  than one active plan) (`src/shared/subscriptions.ts:175-192`).

**Tier only, no subscription** (`formatTierDetails`,
`src/shared/subscriptions.ts:195-209`): emits `Status: Not subscribed`
(`src/shared/subscriptions.ts:80`) then `Available tier: <name> ($<price>/<cycle>)`
and a `Benefits:` list, preferring the active 30-day plan's price.

Dates are formatted via `toLocaleDateString('en-US', …, timeZone: 'UTC')`
(`formatShortDate`, `src/shared/subscriptions.ts:20-27`) — dates are UTC, unlike
the transcript's local `[HH:MM]`. Prices use `millsToUsd`; a null price renders
`Unknown` (`formatUsd`, `src/shared/subscriptions.ts:51-53`).

---

## Reply-output parsing (`reply-output.ts`)

Turns the model's raw returned text into an array of cleaned, insertable
message parts. The pipeline (`normalizeParts`, `src/shared/reply-output.ts:88-95`):

1. `stripThinkBlocks` on the whole text (`src/shared/reply-output.ts:26-30`):
   removes `<think>…</think>` and fenced ```` ```think/thinking/reasoning/
   chain-of-thought ```` blocks.
2. Split into parts by the provided splitter (`splitByNext` or `splitByVariant`).
3. `sanitizeReplyPart` each part (`src/shared/reply-output.ts:70-75`): strip
   think blocks again → `removeMetaLeakLines` → `stripReplyPrefix` →
   `stripWrappingQuotes`.
4. `filter(isInsertableReplyPart)` (`src/shared/reply-output.ts:77-86`): drops
   empty parts, bracket garbage (`[`, `]`, `["`, `"]`, `['`, `']`,
   `src/shared/reply-output.ts:3`), and lines that match a meta-leak pattern.

**Meta-leak patterns** (`META_LEAK_PATTERNS`,
`src/shared/reply-output.ts:5-24`) strip prompt-leak/injection echoes such as
"the prompt says", "system prompt", "ignore … instructions", "as an ai",
"stay in character", "single message", "output only". The `instructions` match
is deliberately narrow: a bare "instructions" is not filtered so in-character
lines survive ("just follow my instructions baby" is kept, but "Ignore previous
instructions." is dropped) — `src/shared/reply-output.ts:9-14`;
`tests/reply-output.test.ts:32-50`.

**Prefix/quote stripping**: `stripReplyPrefix`
(`src/shared/reply-output.ts:47-52`) removes leading `Message 1:`, `Reply:`,
`Response:`, or `Here's a reply:` style prefixes; `stripWrappingQuotes`
(`src/shared/reply-output.ts:32-45`) iteratively peels matched straight and
curly wrapping quotes.

**Public entry points**:

- `normalizeReplyParts(rawText)` — split on `[NEXT]`
  (`src/shared/reply-output.ts:97-99`). Default reply parsing.
- `normalizeVariantReplyParts(rawText)` — split on `[VARIANT]`
  (`src/shared/reply-output.ts:101-103`). Used for `hi-greeting` (greeting
  options).
- `normalizeSingleReplyPart(rawText)` — sanitize the whole text as one part;
  returns `[]` if not insertable (`src/shared/reply-output.ts:111-114`). Used
  for single-reply features (e.g. `improve-draft`).
- `normalizeProvidedReplyParts(parts)` — sanitize already-split parts without
  re-joining or re-splitting (`src/shared/reply-output.ts:105-109`).

**Where these run**: the background builds `FeatureResult.parts` in
`buildFeatureResult` (`src/background/operations.ts:325-357`) — `single-reply`
→ `normalizeSingleReplyPart`, `reply` → `normalizeReplyParts` (or
`normalizeVariantReplyParts` for `hi-greeting`). The content script re-derives
part texts in `resultPartTexts` (`src/content/index.ts:89-109`), preferring
`normalizeProvidedReplyParts(result.parts)` when parts are already present.

---

## Split mode (`split.ts`)

Two marker splitters, both trim each part and drop empties
(`src/shared/split.ts`):

- `splitByNext(text)` (`src/shared/split.ts:6-11`): splits on the literal
  `[NEXT]`. Case-sensitive — `[next]` is not a separator
  (`tests/split.test.ts:41-43`). Runs of markers and leading/trailing markers
  collapse to no empty parts; `'[NEXT]'` alone → `[]`
  (`tests/split.test.ts:29-35`).
- `splitByVariant(text)` (`src/shared/split.ts:17-22`): identical logic on the
  literal `[VARIANT]`, used for greeting variants.

The header comment notes splitting happens only after the stream completes
(`src/shared/split.ts:1-5`).

**`preferSplit` reply mode**: this is a display/formatting flag, not a change to
parsing. `buildFeatureResult` sets `splitModeRequested: replyMode === 'preferSplit'`
on the result for features that support reply mode
(`src/background/operations.ts:348-353`); compare operations do the same
(`src/background/compare-operations.ts:1141`). The parsing splitter is always
`[NEXT]`/`[VARIANT]` regardless of `replyMode` — `preferSplit` does not select a
different delimiter. The flag flows to the UI (`splitModeRequested` on the
overlay/inline view models, `src/shared/types.ts:541`, `1050`, `1087`), which
renders parts as numbered separate messages when `splitModeRequested` is true
and there is more than one part (`src/content/overlay/overlay-controller.ts:1051`,
`src/content/inline-panel/inline-panel-controller.ts:453`). The multi-message
toggle in the button bar switches `nextReplyMode` between `'preferSplit'` and
`'default'` (`src/content/index.ts:945`, `src/content/button-bar.ts:226`).
