# Coach Chat — Core Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `coach-chat` AI feature (multi-turn coach with recap attach), the short recap variant, the recap-status read, and supporting contract/DB/provider changes to core, ending with a re-vendored SDK in chatgoose.

**Architecture:** One new feature in core's existing stateless SSE feature lane. The coach prompt is assembled kernel-side from clientContext + client-held dialog history + kernel-stored recaps (two-slot attach from `ai_generation_content`). Short recap is a template/max-tokens variant of `fan-summary`, not a new enum value. All work follows core's established registration surfaces (two enum worlds: `FeatureType` prompt lane + `AiUsageFeature` ledger lane).

**Tech Stack:** TypeScript, Fastify, Drizzle (hand-written numbered SQL migrations), Zod contracts, Vitest.

**Repo:** ALL tasks except the last run in `~/code/core`. Per workspace rules, create the worktree first: `~/code/agentic-control-plane/bin/agent task core coach-chat` and work there (paths below are repo-relative). The final task runs in the chatgoose spec worktree.

**Spec:** `docs/superpowers/specs/2026-07-17-coach-chat-design.md` (chatgoose worktree `260717d-coach-chat-spec`), §5 (recap), §7 (kernel contract), §8 (fail-closed).

## Global Constraints

- `chatterQuestion`: 1–2000 chars, coach-chat only (required there, rejected elsewhere).
- `coachHistory`: ≤20 entries `{question ≤2000, answer ≤10000}`, aggregate ≤120_000 chars, coach-chat only.
- `summaryMode`: only `'short'` ever appears on the wire (omitted = legacy full); fan-summary only.
- `transcriptCoverage`: `'full-history' | 'window'`, optional clientContext field, fansly-only by construction.
- Short recap output hard cap: 2048 tokens. Coach output cap: 2500 base tokens (answers must serialize into the 10k-char history bound).
- Output exhaustion = provider stopReason `'max_tokens'` (Anthropic) or `'length'` (OpenRouter) — one shared predicate.
- Recap attach: two slots (full/short), usable = completed + non-empty + not exhausted + has `summaryMode` in params; `ORDER BY created_at DESC, id DESC`; fail-open with manifest note.
- Canonical identity for coach/recap: `conversationRef = groupId`, `fanRef = fanAccountId`; attach lookup also searches the legacy collapsed ref during transition.
- Migrations: next free 4-digit number (`0105` as of writing — re-check `ls packages/db/migrations | tail -1` before creating).
- Every commit message: `type(scope): summary`. Run `pnpm test:unit` before each commit; full `pnpm check` before the PR.

---

### Task 1: Ledger enum `coach-chat` (shared list, DB migration, gateway records, dashboard)

**Files:**
- Modify: `packages/shared/src/types.ts:112-124`
- Create: `packages/db/migrations/0105_ai_usage_feature_coach_chat.sql`
- Modify: `apps/runtime/src/services/ai-gateway-anthropic.ts:56-100`
- Modify: `apps/dashboard/src/pages/UsagePage.tsx:9-18`
- Modify: `apps/runtime/src/cli.ts:721` (help string)
- Test: `tests/ai-usage-coach-chat.test.ts` (new)

**Interfaces:**
- Produces: `AiUsageFeature` now includes `'coach-chat'`; `FEATURE_MAX_TOKENS['coach-chat'] = 2500`, `FEATURE_TEMPERATURES['coach-chat'] = 0.5`, `ANTHROPIC_ADAPTIVE_MAX_TOKENS['coach-chat'] = 16000`. Later tasks rely on the string literal `'coach-chat'`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai-usage-coach-chat.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { aiUsageFeatures } from "@agency_hub_core/shared";

describe("coach-chat ledger registration", () => {
  it("is a ledger feature", () => {
    expect(aiUsageFeatures).toContain("coach-chat");
  });

  it("has a DB enum migration", () => {
    const sql = readFileSync(
      "packages/db/migrations/0105_ai_usage_feature_coach_chat.sql",
      "utf8",
    );
    expect(sql).toMatch(
      /alter type "ai_usage_feature" add value if not exists 'coach-chat';/i,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/ai-usage-coach-chat.test.ts`
Expected: FAIL (`aiUsageFeatures` does not contain `coach-chat`; migration file missing).

- [ ] **Step 3: Implement**

In `packages/shared/src/types.ts`, add to the array (keep order — append before the closing bracket):

```ts
export const aiUsageFeatures = [
  "fast-reply", "improve-draft", "help-me", "fan-summary",
  "chat-review", "scan", "ping", "hi-greeting",
  "workboard-closing", "coach-chat",
] as const;
```

Create `packages/db/migrations/0105_ai_usage_feature_coach_chat.sql` (pattern = `0004_ai_usage_feature_scan.sql`; ADD VALUE inside the runner's per-file transaction is safe on PG 16 because this file never uses the value):

```sql
alter type "ai_usage_feature" add value if not exists 'coach-chat';
```

In `apps/runtime/src/services/ai-gateway-anthropic.ts` add one entry to each of the three exhaustive records (TS now fails to compile without them):

```ts
// FEATURE_MAX_TOKENS (~:56)
"coach-chat": 2500,
// FEATURE_TEMPERATURES (~:70)
"coach-chat": 0.5,
// ANTHROPIC_ADAPTIVE_MAX_TOKENS (~:90)
"coach-chat": 16000,
```

In `apps/dashboard/src/pages/UsagePage.tsx` append to `FEATURE_ORDER`:

```ts
{ key: "coach-chat", label: "Coach" },
```

In `apps/runtime/src/cli.ts:721` append `coach-chat` to the `--feature` option's key list string.

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run tests/ai-usage-coach-chat.test.ts && pnpm typecheck`
Expected: PASS (typecheck confirms the three exhaustive records are complete).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types.ts packages/db/migrations/0105_ai_usage_feature_coach_chat.sql apps/runtime/src/services/ai-gateway-anthropic.ts apps/dashboard/src/pages/UsagePage.tsx apps/runtime/src/cli.ts tests/ai-usage-coach-chat.test.ts
git commit -m "feat(ai): register coach-chat in the usage ledger lane"
```

---

### Task 2: Shared output-exhaustion predicate

**Files:**
- Create: `packages/shared/src/ai-stop-reason.ts`
- Modify: `packages/shared/src/index.ts` (add export)
- Test: `tests/ai-stop-reason.test.ts` (new)

**Interfaces:**
- Produces: `isOutputExhausted(stopReason: string | null | undefined): boolean` — true for `'max_tokens'` and `'length'`. Consumed by Task 6 (attach filter) and by the extension later (via SDK-adjacent shared knowledge; the extension gets the raw stopReason on the done frame and applies the same rule client-side).

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai-stop-reason.test.ts
import { describe, expect, it } from "vitest";
import { isOutputExhausted } from "@agency_hub_core/shared";

describe("isOutputExhausted", () => {
  it("flags provider exhaustion reasons", () => {
    expect(isOutputExhausted("max_tokens")).toBe(true);  // Anthropic
    expect(isOutputExhausted("length")).toBe(true);       // OpenRouter
  });
  it("passes normal terminals", () => {
    expect(isOutputExhausted("end_turn")).toBe(false);
    expect(isOutputExhausted("stop")).toBe(false);
    expect(isOutputExhausted(null)).toBe(false);
    expect(isOutputExhausted(undefined)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/ai-stop-reason.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/ai-stop-reason.ts
/** Provider-native output-exhaustion stop reasons, normalized to one
 * predicate. Anthropic reports 'max_tokens'; OpenRouter (OpenAI-style)
 * reports 'length'. An exhausted generation is truncated mid-thought and
 * must never be committed as a usable coach answer or attached as a recap. */
const EXHAUSTED_STOP_REASONS = new Set(["max_tokens", "length"]);

export function isOutputExhausted(stopReason: string | null | undefined): boolean {
  return stopReason != null && EXHAUSTED_STOP_REASONS.has(stopReason);
}
```

Add `export * from "./ai-stop-reason.js";` (match the existing export style in `packages/shared/src/index.ts`).

- [ ] **Step 4: Run test**

Run: `pnpm vitest run tests/ai-stop-reason.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/ai-stop-reason.ts packages/shared/src/index.ts tests/ai-stop-reason.test.ts
git commit -m "feat(ai): shared output-exhaustion predicate for provider stop reasons"
```

---

### Task 3: Prompt-lane registration (`FeatureType`, policies, `includesFanBio` flag)

**Files:**
- Modify: `apps/runtime/src/modules/ai/prompts/types.ts:9-20`
- Modify: `apps/runtime/src/modules/ai/prompts/feature-policies.ts:26-219`
- Modify: `apps/runtime/src/modules/ai/features/index.ts:208,247-249` (bio hardcode → policy)
- Test: `tests/ai-feature-policies-coach.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `FeatureType` includes `'coach-chat'`; `ModelSelectableFeature` includes `'coach-chat'`; `FeaturePolicy` gains `includesFanBio: boolean`; `FEATURE_POLICIES['coach-chat']` exists; `DEFAULT_FEATURE_MODELS['coach-chat']`, `DEFAULT_FEATURE_REASONING['coach-chat']`. Task 4/5 rely on `policy.includesFanBio`; Task 7 relies on the coach policy row.

- [ ] **Step 1: Write the failing test**

```ts
// tests/ai-feature-policies-coach.test.ts
import { describe, expect, it } from "vitest";
import {
  FEATURE_POLICIES,
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
} from "../apps/runtime/src/modules/ai/prompts/feature-policies.js";

describe("coach-chat feature policy", () => {
  it("registers coach-chat with the agreed policy", () => {
    const p = FEATURE_POLICIES["coach-chat"];
    expect(p).toMatchObject({
      surface: "panel-tab",
      promptMode: "analysis",
      timeoutBucket: "quick",
      messageCountBucket: "quick",
      modelFeature: "coach-chat",
      includesEarnings: true,
      usesFanProfile: true,
      includesFanBio: true,
      supportsReplyMode: false,
      supportsReplyTone: false,
      requiresDraft: false,
      usesPingSegment: false,
    });
    expect(DEFAULT_FEATURE_MODELS["coach-chat"]).toBeTruthy();
    expect(DEFAULT_FEATURE_REASONING["coach-chat"]).toBe("medium");
  });

  it("moves the bio decision into policy", () => {
    expect(FEATURE_POLICIES["hi-greeting"].includesFanBio).toBe(true);
    expect(FEATURE_POLICIES["help-me"].includesFanBio).toBe(true); // owner: absence was a bug
    expect(FEATURE_POLICIES["fast-reply"].includesFanBio).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/ai-feature-policies-coach.test.ts`
Expected: FAIL (`coach-chat` missing; `includesFanBio` not a property).

- [ ] **Step 3: Implement**

`types.ts`: add `| 'coach-chat'` to `FeatureType` and to `ModelSelectableFeature`.

`feature-policies.ts`:
1. Add `includesFanBio: boolean;` to the `FeaturePolicy` interface (`:26-48`).
2. Add `includesFanBio: false` to every existing entry EXCEPT `hi-greeting` and `help-me` which get `true` (the `satisfies Record<OperationFeature, FeaturePolicy>` makes omissions a compile error).
3. Add `'coach-chat'` to `OPERATION_FEATURES` (`:96-104`).
4. Add the policy row (model help-me's shape at `:139-154`):

```ts
'coach-chat': {
  surface: 'panel-tab',
  resultKind: 'text',
  promptMode: 'analysis',
  timeoutBucket: 'quick',
  messageCountBucket: 'quick',
  modelFeature: 'coach-chat',
  includesEarnings: true,
  minMessages: 0,
  rerunAction: 'regenerate',
  supportsReplyMode: false,
  supportsReplyTone: false,
  requiresDraft: false,
  usesPingSegment: false,
  usesFanProfile: true,
  includesFanBio: true,
},
```

`resultKind: 'text'` extends the existing union — first `grep -rn "resultKind" apps/runtime/src packages | grep -v test` and add `'text'` to the union type; if any consumer switches on resultKind exhaustively, give `'text'` the same handling as `'xml'` minus parsing (free text passes through).

5. `DEFAULT_FEATURE_MODELS['coach-chat'] = DEFAULT_MODEL_ID;` and `DEFAULT_FEATURE_REASONING['coach-chat'] = 'medium';`.

`features/index.ts`: replace both `feature === "hi-greeting"` bio gates:
- `:208` → `fanBio: policy.includesFanBio ? clientContext.fanBio : undefined,`
- `:247-249` (kernel-context path) → `const fanBio = policy.includesFanBio ? await loadFanBio(...) : undefined;` (keep the existing loader call shape at that site).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm vitest run tests/ai-feature-policies-coach.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Run the existing AI suite to catch policy regressions**

Run: `pnpm vitest run tests/ai-prompts-builder.test.ts tests/ai-fan-profile-context.test.ts`
Expected: PASS (no behavior change for existing features except help-me bio, which has no test asserting absence — if one exists and fails, update it citing the spec §7).

- [ ] **Step 6: Commit**

```bash
git add apps/runtime/src/modules/ai/prompts/types.ts apps/runtime/src/modules/ai/prompts/feature-policies.ts apps/runtime/src/modules/ai/features/index.ts tests/ai-feature-policies-coach.test.ts
git commit -m "feat(ai): coach-chat prompt-lane policy + includesFanBio policy flag"
```

---

### Task 4: Contract fields (`chatterQuestion`, `coachHistory`, `summaryMode`, `transcriptCoverage`)

**Files:**
- Modify: `packages/contracts/src/routes.ts:2014-2045` (aiFeatureStreamBodySchema + clientContext)
- Modify: `apps/runtime/src/modules/ai/features/index.ts:63-92` (AiFeatureRequestBody)
- Test: `tests/contracts-coach-body.test.ts` (new)

**Interfaces:**
- Produces (wire + internal types):
  - body: `chatterQuestion?: string(1..2000)`, `coachHistory?: Array<{question: string(1..2000), answer: string(1..10_000)}>(max 20)`, `summaryMode?: 'short'`
  - clientContext: `transcriptCoverage?: 'full-history' | 'window'`
- Task 5 consumes these from `body`; Task 7 consumes them in prompt assembly.

- [ ] **Step 1: Write the failing test**

```ts
// tests/contracts-coach-body.test.ts
import { describe, expect, it } from "vitest";
import { routeSchemas } from "@agency_hub_core/contracts";

const base = {
  clientRequestId: "5f0c9d5e-3b6a-4d3e-9a10-6a3d2b1c0e9f",
  pageLabel: "demo-page",
  platform: "fansly",
  conversationRef: "group-123",
};

describe("aiFeatureStream body — coach fields", () => {
  const schema = routeSchemas.aiFeatureStream.body;

  it("accepts coach fields within bounds", () => {
    const r = schema.safeParse({
      ...base,
      chatterQuestion: "как продать ppv?",
      coachHistory: [{ question: "q1", answer: "a1" }],
      clientContext: {
        transcript: "fan: hi", messageCount: 1, fanDisplayName: "Bob",
        transcriptCoverage: "window",
      },
    });
    expect(r.success, JSON.stringify(r)).toBe(true);
  });

  it("rejects out-of-bounds history", () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      question: `q${i}`, answer: `a${i}`,
    }));
    expect(schema.safeParse({ ...base, coachHistory: tooMany }).success).toBe(false);
    expect(schema.safeParse({
      ...base,
      coachHistory: [{ question: "q", answer: "x".repeat(10_001) }],
    }).success).toBe(false);
  });

  it("accepts summaryMode 'short' only", () => {
    expect(schema.safeParse({ ...base, summaryMode: "short" }).success).toBe(true);
    expect(schema.safeParse({ ...base, summaryMode: "full" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/contracts-coach-body.test.ts`
Expected: FAIL (strict schema rejects unknown keys).

- [ ] **Step 3: Implement**

In `aiFeatureStreamBodySchema` (`routes.ts:2014`), add before `clientContext`:

```ts
chatterQuestion: z.string().min(1).max(2_000).optional(),
coachHistory: z
  .array(
    z.object({
      question: z.string().min(1).max(2_000),
      answer: z.string().min(1).max(10_000),
    }).strict(),
  )
  .max(20)
  .optional(),
summaryMode: z.literal("short").optional(),
```

In the nested `clientContext` object add:

```ts
transcriptCoverage: z.enum(["full-history", "window"]).optional(),
```

Mirror all four in the internal `AiFeatureRequestBody` type (`features/index.ts:63-92`):

```ts
chatterQuestion?: string;
coachHistory?: Array<{ question: string; answer: string }>;
summaryMode?: "short";
// inside clientContext:
transcriptCoverage?: "full-history" | "window";
```

- [ ] **Step 4: Run test**

Run: `pnpm vitest run tests/contracts-coach-body.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/routes.ts apps/runtime/src/modules/ai/features/index.ts tests/contracts-coach-body.test.ts
git commit -m "feat(contracts): coach-chat request fields + transcriptCoverage"
```

(`contracts:generate` is deliberately deferred to Task 10 — one regen, one diff.)

---

### Task 5: Feature-specific validation gates in `prepareAiFeatureStream`

**Files:**
- Modify: `apps/runtime/src/modules/ai/features/index.ts:136-272` (gate section)
- Test: extend `tests/ai-feature-service.integration.test.ts`

**Interfaces:**
- Consumes: Task 4 body fields.
- Produces: the validation behavior later tasks and the extension rely on:
  - coach-chat without `chatterQuestion` → 400 `BadRequestError("coach-chat requires chatterQuestion")`
  - any non-coach feature WITH `chatterQuestion`/`coachHistory` → 400
  - any non-fan-summary feature WITH `summaryMode` → 400
  - `coachHistory` aggregate > 120_000 chars → 400
  - unknown feature → `404 {error:"unknown_ai_feature"}` (structured code; the extension's «Coach requires a newer Agency Hub» mapping keys on this code, never on generic 404).

- [ ] **Step 1: Write failing integration tests**

Add to `tests/ai-feature-service.integration.test.ts` (reuse the file's existing seeded fansly page + `chatterKey` + `capturingProvider` helpers; follow its `inject` style at `:196-238`):

```ts
describe("coach-chat gates", () => {
  const coachPayload = (over: Record<string, unknown> = {}) => ({
    clientRequestId: crypto.randomUUID(),
    pageLabel: fanslyPageLabel,
    platform: "fansly",
    conversationRef: "group-777",
    fanRef: "fan-42",
    clientContext: { transcript: "fan: hi", messageCount: 1, fanDisplayName: "Bob" },
    ...over,
  });

  it("requires chatterQuestion for coach-chat", async () => {
    const res = await apiServer.inject({
      method: "POST", url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload(),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toMatch(/chatterQuestion/);
  });

  it("rejects coach fields on other features", async () => {
    const res = await apiServer.inject({
      method: "POST", url: "/api/v1/ai/features/fast-reply",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({ chatterQuestion: "hm?" }),
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it("rejects summaryMode outside fan-summary", async () => {
    const res = await apiServer.inject({
      method: "POST", url: "/api/v1/ai/features/help-me",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({ summaryMode: "short" }),
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it("rejects oversized aggregate history", async () => {
    const res = await apiServer.inject({
      method: "POST", url: "/api/v1/ai/features/coach-chat",
      headers: { authorization: `Bearer ${chatterKey}` },
      payload: coachPayload({
        chatterQuestion: "q",
        coachHistory: Array.from({ length: 13 }, () => ({
          question: "q".repeat(1000), answer: "a".repeat(9000),
        })), // 13 * 10000 = 130k > 120k
      }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().message).toMatch(/coachHistory/);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/ai-feature-service.integration.test.ts -t "coach-chat gates"`
Expected: FAIL (coach-chat streams without question / other features accept the stray fields).

- [ ] **Step 3: Implement the gates**

In `prepareAiFeatureStream`, directly after the `requiresDraft` gate (`:142-144`), add:

```ts
const COACH_HISTORY_AGGREGATE_MAX_CHARS = 120_000;

if (feature === "coach-chat") {
  if (!body.chatterQuestion?.trim()) {
    throw new BadRequestError("coach-chat requires chatterQuestion");
  }
  const aggregate = (body.coachHistory ?? []).reduce(
    (sum, e) => sum + e.question.length + e.answer.length, 0,
  );
  if (aggregate > COACH_HISTORY_AGGREGATE_MAX_CHARS) {
    throw new BadRequestError(
      `coachHistory aggregate exceeds ${COACH_HISTORY_AGGREGATE_MAX_CHARS} chars`,
    );
  }
} else {
  if (body.chatterQuestion !== undefined || body.coachHistory !== undefined) {
    throw new BadRequestError(`${feature} does not accept coach fields`);
  }
}
if (body.summaryMode !== undefined && feature !== "fan-summary") {
  throw new BadRequestError(`${feature} does not accept summaryMode`);
}
```

(Constant at module scope next to the other feature constants.)

Also make the unknown-feature rejection structured (spec §7 compat): in
`apps/runtime/src/services/errors.ts` add

```ts
export class UnknownAiFeatureError extends AppError {
  constructor(message: string) {
    super(message, 404, "unknown_ai_feature");
  }
}
```

(match the file's actual `AppError` constructor signature — copy `NotFoundError`'s
shape) and switch `features/index.ts:136-138` to `throw new
UnknownAiFeatureError(\`Unknown AI feature: ${featureKey}\`)`. Add a test in the
"coach-chat gates" describe:

```ts
it("rejects unknown features with a structured code", async () => {
  const res = await apiServer.inject({
    method: "POST", url: "/api/v1/ai/features/nope",
    headers: { authorization: `Bearer ${chatterKey}` },
    payload: coachPayload(),
  });
  expect(res.statusCode).toBe(404);
  expect(res.json().error).toBe("unknown_ai_feature");
});
```

- [ ] **Step 4: Run the integration tests**

Run: `pnpm vitest run tests/ai-feature-service.integration.test.ts`
Expected: the four new tests PASS; existing cases unaffected. (coach-chat happy-path streaming stays red until Task 7 gives it a template — the gates tests above do not stream.)

- [ ] **Step 5: Commit**

```bash
git add apps/runtime/src/modules/ai/features/index.ts tests/ai-feature-service.integration.test.ts
git commit -m "feat(ai): coach-chat validation gates (question, history bounds, field isolation)"
```

---

### Task 6: Recap selection repository (two slots) + params recording

**Files:**
- Modify: `packages/db/src/repositories/ai-restricted.ts`
- Modify: `apps/runtime/src/services/ai-gateway.ts:69-79` (terminal input) and `:387-397` (params)
- Modify: `apps/runtime/src/modules/ai/features/index.ts` (pass featureParams for fan-summary)
- Test: `tests/ai-recap-selection.integration.test.ts` (new)

**Interfaces:**
- Produces:
  - `getFreshestUsableRecaps(db, input: { pageId: number; conversationRefs: string[] }): Promise<{ full: AiGenerationContentRow | null; short: AiGenerationContentRow | null }>`
  - `AiGatewayTerminalRecordInput` gains nothing; instead the STREAM input gains `featureParams?: Record<string, unknown>` which `recordTerminal` spreads into `params`.
  - fan-summary generations now record `params.summaryMode` (`'full'`/`'short'`), `params.transcriptCoverage`, `params.requestedCount`, `params.keptCount`.
- Consumed by Task 7 (attach) and Task 8 (status read).

- [ ] **Step 1: Write the failing integration test**

```ts
// tests/ai-recap-selection.integration.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import {
  insertAiGenerationContent,
  getFreshestUsableRecaps,
} from "@agency_hub_core/db";
// use the existing DB harness exactly as tests/ai-feature-service.integration.test.ts does:
// startIntegrationTestDatabase / resetIntegrationDatabase from tests/helpers/db.ts

const PAGE_ID = 1;
const row = (over: Partial<Parameters<typeof insertAiGenerationContent>[1]> = {}) => ({
  usageEventId: null, generationRef: crypto.randomUUID(),
  feature: "fan-summary", model: "m", provider: "anthropic",
  userId: null, pageId: PAGE_ID, conversationRef: "group-1",
  promptBlocks: [], completion: "profile text",
  params: { summaryMode: "full", outcome: "completed", stopReason: "end_turn" },
  ...over,
});

describe("getFreshestUsableRecaps", () => {
  it("returns the newest usable per slot and skips unusable rows", async () => {
    await insertAiGenerationContent(db, row({ params: { summaryMode: "full", outcome: "completed", stopReason: "end_turn" } }));
    await insertAiGenerationContent(db, row({ params: { summaryMode: "short", outcome: "completed", stopReason: "end_turn" }, completion: "short profile" }));
    // unusable: exhausted, failed, empty, legacy (no summaryMode), other feature
    await insertAiGenerationContent(db, row({ params: { summaryMode: "short", outcome: "completed", stopReason: "max_tokens" } }));
    await insertAiGenerationContent(db, row({ params: { summaryMode: "full", outcome: "failed", stopReason: null } }));
    await insertAiGenerationContent(db, row({ completion: "", params: { summaryMode: "full", outcome: "completed", stopReason: null } }));
    await insertAiGenerationContent(db, row({ params: { outcome: "completed", stopReason: null } })); // legacy
    await insertAiGenerationContent(db, row({ feature: "help-me" }));

    const out = await getFreshestUsableRecaps(db, {
      pageId: PAGE_ID, conversationRefs: ["group-1", "fan-42"],
    });
    expect(out.full?.completion).toBe("profile text");
    expect(out.short?.completion).toBe("short profile");
  });

  it("searches legacy refs too", async () => {
    await insertAiGenerationContent(db, row({ conversationRef: "fan-42" }));
    const out = await getFreshestUsableRecaps(db, {
      pageId: PAGE_ID, conversationRefs: ["group-1", "fan-42"],
    });
    expect(out.full).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/ai-recap-selection.integration.test.ts`
Expected: FAIL (`getFreshestUsableRecaps` not exported).

- [ ] **Step 3: Implement the repository function**

In `packages/db/src/repositories/ai-restricted.ts` (drizzle `sql` operators as in the file's existing style; the existing composite index `ai_generation_content_page_conversation_idx (pageId, conversationRef)` serves this query — no new index):

```ts
export interface FreshestRecapsInput {
  pageId: number;
  conversationRefs: string[]; // canonical groupId first, legacy fanAccountId second
}

export interface FreshestRecaps {
  full: typeof aiGenerationContent.$inferSelect | null;
  short: typeof aiGenerationContent.$inferSelect | null;
}

/** Two-slot recap selection (spec §5): newest usable full + newest usable
 * short for one conversation. Usable = completed outcome, non-empty
 * completion, not output-exhausted, and modern params (summaryMode present —
 * legacy rows are excluded from attach by design). */
export async function getFreshestUsableRecaps(
  db: DrizzleDb,
  input: FreshestRecapsInput,
): Promise<FreshestRecaps> {
  const pick = async (mode: "full" | "short") => {
    const rows = await db
      .select()
      .from(aiGenerationContent)
      .where(and(
        eq(aiGenerationContent.pageId, input.pageId),
        inArray(aiGenerationContent.conversationRef, input.conversationRefs),
        eq(aiGenerationContent.feature, "fan-summary"),
        sql`${aiGenerationContent.params} ->> 'summaryMode' = ${mode}`,
        sql`${aiGenerationContent.params} ->> 'outcome' = 'completed'`,
        sql`coalesce(${aiGenerationContent.params} ->> 'stopReason', '') not in ('max_tokens', 'length')`,
        sql`${aiGenerationContent.completion} <> ''`,
      ))
      .orderBy(desc(aiGenerationContent.createdAt), desc(aiGenerationContent.id))
      .limit(1);
    return rows[0] ?? null;
  };
  const [full, short] = await Promise.all([pick("full"), pick("short")]);
  return { full, short };
}
```

- [ ] **Step 4: Record fan-summary params**

`apps/runtime/src/services/ai-gateway.ts`: add `featureParams?: Record<string, unknown>` to the prepared-stream input type (next to `isRegeneration` in the input the feature service builds), and in `recordTerminal` params (`:387-397`) spread it first:

```ts
params: {
  ...(input.featureParams ?? {}),
  maxTokens: input.maxTokens ?? null,
  // ...existing keys unchanged
},
```

`apps/runtime/src/modules/ai/features/index.ts`: when `feature === "fan-summary"`, pass into the gateway call (`:341-355` object):

```ts
featureParams: {
  summaryMode: body.summaryMode ?? "full",
  transcriptCoverage: body.clientContext?.transcriptCoverage ?? null,
  requestedCount: body.messageCount ?? null,
  keptCount: body.clientContext?.messageCount ?? null,
},
```

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/ai-recap-selection.integration.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/repositories/ai-restricted.ts apps/runtime/src/services/ai-gateway.ts apps/runtime/src/modules/ai/features/index.ts tests/ai-recap-selection.integration.test.ts
git commit -m "feat(ai): two-slot recap selection + fan-summary params provenance"
```

---

### Task 7: Coach prompt (template, history/recap/question sections, shedding, attach)

**Files:**
- Create: `apps/runtime/src/modules/ai/prompts/templates/coach-chat.md`
- Modify: `apps/runtime/src/modules/ai/prompts/templates.ts` (add `COACH_CHAT_TEMPLATE`)
- Modify: `apps/runtime/src/modules/ai/prompts/builder.ts` (policies, templates map, new sections, shedding)
- Modify: `apps/runtime/src/modules/ai/prompts/prompt-manifest.json`
- Modify: `apps/runtime/src/modules/ai/features/index.ts` (attach + pass-through)
- Test: `tests/ai-prompts-coach.test.ts` (new), extend `tests/ai-prompts-templates-sync.test.ts`, extend `tests/ai-feature-service.integration.test.ts`

**Interfaces:**
- Consumes: Task 6 `getFreshestUsableRecaps`; Task 3 policy row; Task 4 body fields.
- Produces: `buildPrompt` accepts `coachHistory?: Array<{question,answer}>`, `chatterQuestion?: string`, `recapAttach?: { full: {body: string; ageMs: number} | null; short: {body: string; ageMs: number} | null }`; `contextManifest.recapAttach` records what was attached (or `{ lookupFailed: true }`).

- [ ] **Step 1: Write failing builder tests**

```ts
// tests/ai-prompts-coach.test.ts
import { describe, expect, it } from "vitest";
import { buildPrompt } from "../apps/runtime/src/modules/ai/prompts/builder.js";
import { COACH_CHAT_TEMPLATE } from "../apps/runtime/src/modules/ai/prompts/templates.js";

const baseInput = {
  feature: "coach-chat" as const,
  personality: { content: "PERSONA", id: "p1" },
  platform: "fansly" as const,
  transcript: "fan: hi",
  fanSpendingData: "", fanSubscriptionData: "",
  fanDisplayName: "Bob",
  chatterQuestion: "как продать ppv?",
};

describe("coach-chat prompt", () => {
  it("includes question, dated recaps, and history with escaping", () => {
    const built = buildPrompt({
      ...baseInput,
      coachHistory: [{ question: "q<1>", answer: "a1" }],
      recapAttach: {
        full: { body: "FULL RECAP", ageMs: 3 * 86_400_000 },
        short: { body: "SHORT RECAP", ageMs: 10 * 60_000 },
      },
    });
    const text = JSON.stringify(built.blocks);
    expect(text).toContain("как продать ppv?");
    expect(text).toContain("q&lt;1&gt;");        // history escaped
    expect(text).toContain("FULL RECAP");
    expect(text).toContain("SHORT RECAP");
    expect(text).toMatch(/full recap.*3 day/i);   // age labels
  });

  it("sheds oldest history entries over the prompt budget", () => {
    const big = Array.from({ length: 20 }, (_, i) => ({
      question: `q${i} ` + "x".repeat(1900),
      answer: `a${i} ` + "y".repeat(9900),
    }));
    const built = buildPrompt({ ...baseInput, coachHistory: big });
    const text = JSON.stringify(built.blocks);
    expect(text).toContain("q19");                 // newest kept
    expect(text).not.toContain("q0 ");             // oldest shed
  });

  it("template carries the cache anchors and draft grammar", () => {
    expect(COACH_CHAT_TEMPLATE).toContain("## Conversation Transcript");
    expect(COACH_CHAT_TEMPLATE).toContain("## Your Task");
    expect(COACH_CHAT_TEMPLATE).toContain("```draft");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/ai-prompts-coach.test.ts`
Expected: FAIL (no `COACH_CHAT_TEMPLATE`, `buildPrompt` rejects unknown keys).

- [ ] **Step 3: Write the template**

Create `apps/runtime/src/modules/ai/prompts/templates/coach-chat.md` (and the byte-identical `COACH_CHAT_TEMPLATE` export in `templates.ts`):

```markdown
You are an experienced OnlyFans-agency sales coach. A chatter working THIS fan
conversation is asking you for advice. Answer the chatter (never the fan),
concretely and directly, grounded in this fan's actual history and the agency
method below.

## Rules

- Advise the chatter in the language they ask in.
- Ground every recommendation in the transcript, the fan profile data, and the
  recaps below. If the data contradicts a generic play, say so.
- Respect the persona's voice and boundaries in any suggested wording.
- Be specific: name the next message to send, the price to quote, the objection
  to expect. No generic sales platitudes.
- When you propose exact wording for a message TO THE FAN, wrap each proposal
  in a fenced block that starts with ```draft and ends with ``` — at most two
  such blocks, each under 1500 characters. Advice text stays outside the
  fences. Never put anything except the ready-to-send fan message inside a
  draft fence.

{recapSection}

{fanProfileSection}

## Coach Dialog So Far

{coachHistorySection}

## Conversation Transcript

{transcriptCoverageNote}
<transcript>
{transcript}
</transcript>

{fanSpendingSection}
{fanSubscriptionSection}
{fanBioSection}

## Your Task

The chatter asks:

<chatter_question>
{chatterQuestion}
</chatter_question>

Answer the chatter now. Use a draft fence for any proposed fan message.
```

Register in `builder.ts`: `PROMPT_POLICIES['coach-chat'] = ANALYSIS_POLICY;`, `DEFAULT_TEMPLATES['coach-chat'] = COACH_CHAT_TEMPLATE;`.

- [ ] **Step 4: Implement the new sections + shedding in `builder.ts`**

Add to the `buildPrompt` input type: `coachHistory?`, `chatterQuestion?`, `recapAttach?` (shapes from Interfaces above). Add template values (all untrusted text through `escapeForPrompt`, XML-wrapped, matching `wrappedDataSection` style):

```ts
// Types shared by builder + feature service (export from builder.ts):
export interface CoachHistoryEntry { question: string; answer: string }
export interface RecapAttach {
  full: { body: string; ageMs: number } | null;
  short: { body: string; ageMs: number } | null;
}

const COACH_PROMPT_HISTORY_BUDGET_CHARS = 60_000;
const RECAP_ATTACH_MAX_CHARS = 30_000; // per slot; oldest recap text is a
// summary already — hard-truncate the TAIL beyond this (keep the head: recap
// sections lead with the most load-bearing facts).

function coachHistorySection(history: CoachHistoryEntry[] | undefined): string {
  if (!history?.length) return "(no prior coach dialog — this is the first question)";
  // Deterministic shedding: keep newest entries whole, drop oldest first.
  const kept: CoachHistoryEntry[] = [];
  let used = 0;
  for (const entry of [...history].reverse()) {
    const size = entry.question.length + entry.answer.length;
    if (used + size > COACH_PROMPT_HISTORY_BUDGET_CHARS && kept.length > 0) break;
    kept.unshift(entry);
    used += size;
  }
  return kept
    .map((e, i) =>
      `<coach_exchange n="${i + 1}">\n<chatter>${escapeForPrompt(e.question)}</chatter>\n<coach>${escapeForPrompt(e.answer)}</coach>\n</coach_exchange>`)
    .join("\n");
}

function formatAge(ageMs: number): string {
  const m = Math.round(ageMs / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

function recapSection(attach: RecapAttach | undefined): string {
  if (!attach || (!attach.full && !attach.short)) return "";
  const parts: string[] = ["## Fan Recaps\n"];
  const bounded = (body: string) => body.length > RECAP_ATTACH_MAX_CHARS
    ? body.slice(0, RECAP_ATTACH_MAX_CHARS) + "\n[recap truncated]"
    : body;
  if (attach.full) parts.push(
    `<full_recap generated="${formatAge(attach.full.ageMs)}">\n${escapeForPrompt(bounded(attach.full.body))}\n</full_recap>`);
  if (attach.short) parts.push(
    `<short_recap generated="${formatAge(attach.short.ageMs)}">\n${escapeForPrompt(bounded(attach.short.body))}\n</short_recap>`);
  return parts.join("\n");
}
```

Wire into `templateValues` (`:292-315`): `coachHistorySection`, `chatterQuestion: escapeForPrompt(input.chatterQuestion ?? "")`, `recapSection`, and the coverage framing note (spec §5 — the prompt states honestly whether it sees the whole history):

```ts
transcriptCoverageNote:
  input.transcriptCoverage === "full-history"
    ? "(the transcript below covers the ENTIRE conversation history)"
    : input.transcriptCoverage === "window"
      ? "(the transcript below is the most recent window only — the history is longer)"
      : "",
```

`buildPrompt` input gains `transcriptCoverage?: 'full-history' | 'window'`; the feature service passes `body.clientContext?.transcriptCoverage` for coach-chat and fan-summary.

- [ ] **Step 5: Implement the attach in `features/index.ts`**

After the dossier block (`:280-321`), add (fail-open like the dossier):

```ts
let recapAttach: RecapAttach | undefined;
if (feature === "coach-chat") {
  try {
    const refs = [body.conversationRef, ...(body.fanRef ? [body.fanRef] : [])];
    const found = await getFreshestUsableRecaps(app.db, {
      pageId: stored.page.id, conversationRefs: refs,
    });
    // Attach rule (spec §5): full-only when full is newer; both when short is newer.
    const fullAt = found.full?.createdAt?.getTime() ?? null;
    const shortAt = found.short?.createdAt?.getTime() ?? null;
    const now = Date.now();
    recapAttach = {
      full: found.full ? { body: found.full.completion, ageMs: now - fullAt! } : null,
      short:
        found.short && (fullAt === null || shortAt! > fullAt)
          ? { body: found.short.completion, ageMs: now - shortAt! }
          : null,
    };
    contextManifest.recapAttach = {
      full: fullAt, short: recapAttach.short ? shortAt : null,
    };
  } catch (error) {
    app.log.warn({ err: error }, "coach-chat recap attach failed open");
    contextManifest.recapAttach = { lookupFailed: true };
  }
}
```

Dossier dedupe: when `policy.usesFanProfile` injected a profile AND `recapAttach.full` has identical body text, drop `recapAttach.full` (keep the dossier copy):

```ts
if (recapAttach?.full && fanProfile?.body === recapAttach.full.body) {
  recapAttach.full = null;
}
```

Pass `coachHistory: body.coachHistory`, `chatterQuestion: body.chatterQuestion`, `recapAttach` into `buildPrompt` (`:323-339`).

- [ ] **Step 6: Update template-sync + manifest**

- `tests/ai-prompts-templates-sync.test.ts`: add `coach-chat` to `TEMPLATE_FILES`; bump `toHaveLength(7)` → `toHaveLength(8)` (`:38`).
- Regenerate `prompt-manifest.json` hashes the way the sync test expects (run the test; follow its failure instructions for adding the file entry).

- [ ] **Step 7: Extend the integration test with the happy path**

In `tests/ai-feature-service.integration.test.ts`:

```ts
it("streams coach-chat and records the ledger row", async () => {
  const res = await apiServer.inject({
    method: "POST", url: "/api/v1/ai/features/coach-chat",
    headers: { authorization: `Bearer ${chatterKey}` },
    payload: coachPayload({ chatterQuestion: "как продать ppv?" }),
  });
  expect(res.statusCode, res.body).toBe(200);
  const frames = aiFrames(res.body);
  expect(frames.find((f) => f.type === "meta")?.feature).toBe("coach-chat");
  expect(frames.at(-1)?.type).toBe("done");
  // capturingProvider saw the assembled prompt:
  const prompt = JSON.stringify(capturingProvider.lastInput);
  expect(prompt).toContain("как продать ppv?");
});
```

- [ ] **Step 8: Run everything so far**

Run: `pnpm vitest run tests/ai-prompts-coach.test.ts tests/ai-prompts-templates-sync.test.ts tests/ai-feature-service.integration.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/runtime/src/modules/ai/prompts apps/runtime/src/modules/ai/features/index.ts tests/ai-prompts-coach.test.ts tests/ai-prompts-templates-sync.test.ts tests/ai-feature-service.integration.test.ts
git commit -m "feat(ai): coach-chat prompt with dialog history, two-slot recap attach, shedding"
```

---

### Task 8: Short-recap template + max-tokens override

**Files:**
- Create: `apps/runtime/src/modules/ai/prompts/templates/fan-summary-short.md`
- Modify: `apps/runtime/src/modules/ai/prompts/templates.ts` (add `FAN_SUMMARY_SHORT_TEMPLATE`)
- Modify: `apps/runtime/src/modules/ai/prompts/builder.ts` (template pick by summaryMode)
- Modify: `apps/runtime/src/modules/ai/features/index.ts` (maxTokens override)
- Test: extend `tests/ai-prompts-coach.test.ts`, `tests/ai-prompts-templates-sync.test.ts`, `tests/ai-feature-service.integration.test.ts`

**Interfaces:**
- Consumes: Task 4 `summaryMode`.
- Produces: `buildPrompt` input gains `summaryMode?: 'short'`; fan-summary with `summaryMode:'short'` uses `FAN_SUMMARY_SHORT_TEMPLATE` and gateway `maxTokens: 2048` (`SHORT_SUMMARY_MAX_TOKENS`).

- [ ] **Step 1: Write the failing tests**

Append to `tests/ai-prompts-coach.test.ts`:

```ts
describe("fan-summary short variant", () => {
  it("selects the short template", () => {
    const built = buildPrompt({
      feature: "fan-summary", summaryMode: "short",
      personality: { content: "PERSONA", id: "p1" }, platform: "fansly",
      transcript: "fan: hi", fanSpendingData: "", fanSubscriptionData: "",
      fanDisplayName: "Bob",
    });
    expect(JSON.stringify(built.blocks)).toContain("COMPACT RECAP");
  });
});
```

Integration (in `tests/ai-feature-service.integration.test.ts`): POST `fan-summary` with `summaryMode: "short"`, assert 200 and `capturingProvider.lastInput.maxTokens === 2048`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run tests/ai-prompts-coach.test.ts -t "short variant"`
Expected: FAIL.

- [ ] **Step 3: Write the short template**

`templates/fan-summary-short.md` (+ byte-identical `FAN_SUMMARY_SHORT_TEMPLATE`):

```markdown
You are building a COMPACT RECAP of one fan for the chatter working them right
now. 300 recent messages max are provided. Be dense: facts only, no prose
padding. Hard limit: keep the whole recap under 350 words.

## Rules

- Only claims grounded in the transcript/data below; no speculation.
- Money numbers verbatim from the spending data.

## Sections

1. WHO — name/persona facts the fan revealed; how they address the model.
2. SPEND PATTERN — recent purchases, tips, price points accepted/refused.
3. TRIGGERS — what makes them engage, buy, or go cold.
4. BOUNDARIES — stated limits, sore topics, things that annoyed them.
5. ACTIVE THREADS — open loops, promises, scheduled events, running jokes.
6. NEXT MOVE — the single most promising next action for the chatter.

## Conversation Transcript

{transcriptCoverageNote}
<transcript>
{transcript}
</transcript>

{fanSpendingSection}
{fanSubscriptionSection}

## Your Task

Write the compact recap now, sections 1-6, under 350 words total.
```

- [ ] **Step 4: Implement selection + cap**

`builder.ts`: add `summaryMode?: 'short'` to the input; where the template is resolved (`DEFAULT_TEMPLATES[feature]`), use:

```ts
const template =
  input.feature === "fan-summary" && input.summaryMode === "short"
    ? FAN_SUMMARY_SHORT_TEMPLATE
    : DEFAULT_TEMPLATES[feature];
```

`features/index.ts`: pass `summaryMode: body.summaryMode` into `buildPrompt`, and in the gateway body (`:341-355`):

```ts
const SHORT_SUMMARY_MAX_TOKENS = 2048;
// ...
maxTokens:
  feature === "fan-summary" && body.summaryMode === "short"
    ? SHORT_SUMMARY_MAX_TOKENS
    : undefined,
```

(`ai-gateway-anthropic.ts:206` already honors `input.maxTokens ?? tuning.maxTokens`; OpenRouter provider `:47` likewise.)

Template-sync: add `fan-summary-short` to `TEMPLATE_FILES`, bump length 8 → 9, regenerate manifest entry.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/ai-prompts-coach.test.ts tests/ai-prompts-templates-sync.test.ts tests/ai-feature-service.integration.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/runtime/src/modules/ai/prompts apps/runtime/src/modules/ai/features/index.ts tests/
git commit -m "feat(ai): short fan-summary variant (compact template, 2048-token cap)"
```

---

### Task 9: Recap-status metadata read (`GET /api/v1/ai/recap-status`)

**Files:**
- Modify: `packages/contracts/src/routes.ts` (schemas + `routeSchemas` entry)
- Modify: `apps/runtime/src/modules/ai/index.ts` (`registerAiRoutes`)
- Test: extend `tests/ai-feature-service.integration.test.ts`

**Interfaces:**
- Consumes: Task 6 `getFreshestUsableRecaps`.
- Produces (wire): `GET /api/v1/ai/recap-status?pageLabel=...&conversationRef=...&fanRef=...` → `200 { full: RecapSlot | null, short: RecapSlot | null }` where `RecapSlot = { generatedAt: string(ISO), ageMs: number, transcriptCoverage: 'full-history'|'window'|null, requestedCount: number|null, keptCount: number|null }`. Auth: apiKey (same as the stream). No generation, no AI spend — this is the §3 invariant's "metadata-only read".

- [ ] **Step 1: Write the failing integration test**

```ts
describe("recap-status read", () => {
  it("returns both slots without creating any generation", async () => {
    // seed one full + one short row via insertAiGenerationContent (Task 6 helper shapes)
    const res = await apiServer.inject({
      method: "GET",
      url: `/api/v1/ai/recap-status?pageLabel=${fanslyPageLabel}&conversationRef=group-777&fanRef=fan-42`,
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.full?.generatedAt).toBeTruthy();
    expect(typeof body.full?.ageMs).toBe("number");
    expect(body.short).toBeDefined();
  });

  it("404s an unknown page label", async () => {
    const res = await apiServer.inject({
      method: "GET",
      url: "/api/v1/ai/recap-status?pageLabel=nope&conversationRef=g",
      headers: { authorization: `Bearer ${chatterKey}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run tests/ai-feature-service.integration.test.ts -t "recap-status"`
Expected: FAIL (route not found).

- [ ] **Step 3: Contracts**

In `routes.ts` near the persona-catalog schemas:

```ts
export const aiRecapStatusQuerySchema = z.object({
  pageLabel: z.string().min(1).max(120),
  conversationRef: z.string().min(1).max(255),
  fanRef: z.string().min(1).max(255).optional(),
}).strict();

const aiRecapSlotSchema = z.object({
  generatedAt: z.string(),
  ageMs: z.number().int().min(0),
  transcriptCoverage: z.enum(["full-history", "window"]).nullable(),
  requestedCount: z.number().int().nullable(),
  keptCount: z.number().int().nullable(),
}).strict();

export const aiRecapStatusResponseSchema = z.object({
  full: aiRecapSlotSchema.nullable(),
  short: aiRecapSlotSchema.nullable(),
}).strict();
```

`routeSchemas` entry (model: `aiPersonaCatalog` at `:5989-5998`):

```ts
aiRecapStatus: {
  auth: { kind: "apiKey" },
  tags: ["ai"],
  summary: "Freshest usable recap metadata (full + short slots) for one conversation",
  query: aiRecapStatusQuerySchema,
  response: { 200: aiRecapStatusResponseSchema, 400: errorSchema, 401: errorSchema, 403: errorSchema, 404: errorSchema },
},
```

(Match the file's exact `query`/`querystring` key and error-schema naming used by the neighboring GET entries — copy the persona-catalog entry's shape verbatim and adjust.)

- [ ] **Step 4: Route**

In `registerAiRoutes` (`apps/runtime/src/modules/ai/index.ts`, next to `GET /api/v1/ai/persona-catalog` at `:113`):

```ts
server.get("/api/v1/ai/recap-status", { schema: routeSchemas.aiRecapStatus }, async (request, reply) => {
  const principal = await requireApiKeyPrincipal(request); // same helper the stream route uses
  const { pageLabel, conversationRef, fanRef } = request.query as AiRecapStatusQuery;
  const stored = await resolveAuthorizedPage(appContext, principal, pageLabel); // same resolution the stream uses; NotFoundError on unknown
  const refs = [conversationRef, ...(fanRef ? [fanRef] : [])];
  const found = await getFreshestUsableRecaps(appContext.db, {
    pageId: stored.page.id, conversationRefs: refs,
  });
  const slot = (row: typeof found.full) => row === null ? null : {
    generatedAt: row.createdAt.toISOString(),
    ageMs: Math.max(0, Date.now() - row.createdAt.getTime()),
    transcriptCoverage: (row.params["transcriptCoverage"] as "full-history" | "window" | null) ?? null,
    requestedCount: (row.params["requestedCount"] as number | null) ?? null,
    keptCount: (row.params["keptCount"] as number | null) ?? null,
  };
  return reply.send({ full: slot(found.full), short: slot(found.short) });
});
```

(Use the file's actual page-resolution/auth helper names — copy from the `aiFeatureStream` handler at `:270-287`; the names above are descriptive.)

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run tests/ai-feature-service.integration.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/contracts/src/routes.ts apps/runtime/src/modules/ai/index.ts tests/ai-feature-service.integration.test.ts
git commit -m "feat(ai): recap-status metadata read (two slots, no generation)"
```

---

### Task 10: Contracts regeneration + full check + Draft PR

**Files:**
- Modify (generated): `reference/agency-hub.openapi.json`, `packages/contracts/src/contract-hash.ts`, `docs/generated/authorization-policy.md`, `packages/sdk/**`
- Modify: `docs/decisions.md` (new numbered decision)

- [ ] **Step 1: Regenerate contracts**

Run: `pnpm contracts:generate`
Expected: rewrites the OpenAPI doc, `KERNEL_CONTRACT_HASH`, auth-policy doc, and `packages/sdk` files. `git status` shows exactly those.

- [ ] **Step 2: Record the decision**

Append to core's `docs/decisions.md` (next free number) — one entry covering: coach-chat feature (stateless multi-turn, client-held history), two-slot recap attach from the restricted store, short fan-summary variant, `includesFanBio` policy flag, recap-status read, canonical `conversationRef=groupId`/`fanRef=fanAccountId` for coach/recap requests. Reference the extension spec path.

- [ ] **Step 3: Full check**

Run: `pnpm check`
Expected: green (typecheck + lint + test:unit + dashboard build). Then run the integration suite: `pnpm test` — green.

- [ ] **Step 4: Commit + Draft PR + toolkit review**

```bash
git add -A
git commit -m "feat(ai): coach-chat core phase — contracts regen + decision entry"
git push -u origin HEAD
gh pr create --draft --title "feat(ai): coach-chat feature lane (coach + short recap + recap attach)" --body "Core phase of the Coach feature. Spec: chatgoose docs/superpowers/specs/2026-07-17-coach-chat-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
~/code/agentic-control-plane/bin/agent review core --pr <N>
```

---

### Task 11: Re-vendor the SDK into chatgoose (after the core PR merges)

**Files (chatgoose spec worktree `/Users/dmitriy/code/.worktrees/chatgoose/260717d-coach-chat-spec`):**
- Modify (generated): `vendor/kernel-sdk/**`

- [ ] **Step 1: Vendor from the merged core main**

```bash
cd ~/code/core && git checkout main && git pull
node scripts/vendor-sdk.mjs /Users/dmitriy/code/.worktrees/chatgoose/260717d-coach-chat-spec/vendor/kernel-sdk
```

Expected: refuses if the core tree is dirty (do NOT pass `--allow-dirty` — provenance matters; if dirty, the parallel Codex session is mid-work → coordinate first, per the shared-checkout hazard).

- [ ] **Step 2: Verify the vendor gates in chatgoose**

```bash
cd /Users/dmitriy/code/.worktrees/chatgoose/260717d-coach-chat-spec
pnpm vitest run tests/kernel-sdk-vendor.test.ts && pnpm typecheck
```

Expected: PASS (manifest hash == `KERNEL_CONTRACT_HASH`; no call sites break — the extension has not consumed the new ops yet).

- [ ] **Step 3: Commit (vendor as its own change, per CLAUDE.md)**

```bash
git add vendor/kernel-sdk
git commit -m "chore(sdk): re-vendor kernel SDK with coach-chat contract"
```

---

## Deployment note (2.0 release, not part of this plan's execution)

- Deploy core first (migration `0105` runs at startup), smoke `coach-chat` + `recap-status` against prod, then ship the extension.
- Set the initial cost ceiling via env (restart-applied, NOT live-patchable — `runtimeApply: "none"`): `CHATMUSE_AI_GATEWAY_FEATURE_DAILY_MICRO_USD_LIMITS='{"coach-chat": 2000000}'` ($2/day fleet-wide to start). The spec's word "live" is corrected by this plan: making it live-patchable is a separate core change and is NOT in scope.

## Deferred to the extension-phase plan (written after Task 11)

Everything in spec §3/§4 client-side, §6, §9, §10: coach session store, overlay chat mode, transcript cache, recap start dialog, settings v14, hotkeys, custom-name rule (extension side), draft parser, acceptance attribution, and the extension decision-log entry.
