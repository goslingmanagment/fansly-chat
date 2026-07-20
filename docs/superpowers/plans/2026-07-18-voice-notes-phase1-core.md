# Voice Notes Phase 1 (core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the kernel half of voice notes — the `voice-script` feature,
the durable idempotent voice-note resource with binary audio retrieval, the
ElevenLabs provider behind the egress seam, character-budget ledger,
sweeper/purge jobs, voice-profile CLI, and the `capabilities.voiceNotes`
flag — all behind a global-off kill switch.

**Architecture:** Per the spec
(`chatgoose/docs/superpowers/specs/2026-07-18-voice-notes-design.md`, rev 2):
async create (202) + status GET + binary audio GET, decision-#158-style
admission→CAS→dispatch state machine, client-intent-only request hash with
admission-time profile snapshot, BYTEA artifact storage superseding core
decision #36 for this bounded class.

**Tech Stack:** core repo (`/Users/dmitriy/code/core`): Fastify + Zod
contracts, Drizzle + hand-written SQL migrations, pg-boss jobs, commander
CLI, vitest + Testcontainers.

## Global Constraints

- Execute in a dedicated core worktree on branch `ai/voice-notes-core`
  (use `~/code/agentic-control-plane/bin/agent task core voice-notes` if
  core is registered in its `repos.yaml`, else `git worktree add`). Never
  commit in the canonical core checkout; never `git add -A` (shared tree).
- Everything ships inert: `VOICE_NOTES_ENABLED` defaults to false; no
  behavior change until the owner flips it.
- Zero automatic vendor retries anywhere (spec family law). The EL HTTP
  client makes exactly one attempt per dispatch.
- Never log script text, voice ids, audio bytes, or provider bodies.
- Migrations are forward-only, hand-written, numbered after the current
  latest (`0104_…` at planning time → `0105`/`0106`; re-check `ls
  packages/db/migrations | tail -1` before naming).
- After any `packages/contracts/src/routes.ts` edit: `pnpm
  contracts:generate` and commit the regenerated
  `reference/agency-hub.openapi.json`, `contract-hash.ts`, `packages/sdk`,
  `docs/generated/authorization-policy.md` — CI diffs them.
- `pnpm check` green before every commit. Decision-log entries ship in the
  same change that implements them (family law).
- The plan references exact line numbers observed on 2026-07-18; treat
  them as anchors, not gospel — re-locate by symbol name if the file moved.

---

### Task 1: Config keys + kill switches + allowlist

**Files:**
- Modify: `packages/shared/src/config.ts` (envSchema ~L69, AppConfig
  ~L243, loadConfig mapping ~L430)
- Modify: `packages/shared/src/config-registry.ts` (CONFIG_DESCRIPTORS
  ~L98)
- Test: `tests/config-registry.test.ts`, `tests/effective-config.test.ts`

**Interfaces:**
- Produces AppConfig fields consumed by later tasks:
  `elevenLabsApiKey: string | undefined`,
  `voiceNotesEnabled: boolean` (dispatch kill switch, default false),
  `voiceNotesRetrievalEnabled: boolean` (retrieval kill switch, default
  true — retrieval is free; the switch exists for incident shutdown),
  `voiceNotesPageAllowlist: string` (CSV of page labels, empty = none —
  note: OPPOSITE default from `FANSLY_NEW_STREAM_PAGE_ALLOWLIST`, where
  empty = all; voice must fail closed),
  `voiceNotesDailyCharBudget: number` (per-page/day, default 5000),
  `voiceNotesGlobalDailyCharBudget: number` (default 20000),
  `voiceNotesScriptMaxChars: number` (default 600),
  `voiceNotesMaxConcurrentSyntheses: number` (default 2).

- [ ] **Step 1: Write the failing registry-parity test expectation**

`tests/config-registry.test.ts` asserts descriptors match
`ENV_CONFIG_KEYS` — adding env keys without descriptors fails it. Run it
first to confirm green baseline: `pnpm vitest run tests/config-registry.test.ts`.

- [ ] **Step 2: Add env keys to `envSchema`**

```ts
// packages/shared/src/config.ts — inside envSchema, near the CHATMUSE_* block
ELEVENLABS_API_KEY: optionalTrimmedStringSchema,
VOICE_NOTES_ENABLED: booleanSchema.default(false),
VOICE_NOTES_RETRIEVAL_ENABLED: booleanSchema.default(true),
VOICE_NOTES_PAGE_ALLOWLIST: z.string().default(""),
VOICE_NOTES_DAILY_CHAR_BUDGET: optionalPositiveIntSchema.default(5000),
VOICE_NOTES_GLOBAL_DAILY_CHAR_BUDGET: optionalPositiveIntSchema.default(20000),
VOICE_NOTES_SCRIPT_MAX_CHARS: optionalPositiveIntSchema.default(600),
VOICE_NOTES_MAX_CONCURRENT_SYNTHESES: optionalPositiveIntSchema.default(2),
```

Add the camelCase fields to `AppConfig` and the `loadConfig` return
mapping (three-place rule).

- [ ] **Step 3: Add registry descriptors**

Follow the precedents: `ELEVENLABS_API_KEY` copies the
`ANTHROPIC_API_KEY` descriptor (`kind:"secret"`, editability NEVER,
`runtimeApply:"none"`, `comparable:false`, config-registry.ts ~L217).
`VOICE_NOTES_ENABLED`, `VOICE_NOTES_PAGE_ALLOWLIST`, budgets: EDITABLE +
`runtimeApply:"live"` (the #136 `CHATMUSE_AI_FAN_PROFILE_CONTEXT_FEATURES`
pattern, ~L221). `VOICE_NOTES_RETRIEVAL_ENABLED`: EDITABLE + live.

- [ ] **Step 4: Run config tests, then commit**

```bash
pnpm vitest run tests/config-registry.test.ts tests/effective-config.test.ts
git add packages/shared/src/config.ts packages/shared/src/config-registry.ts
git commit -m "feat(voice): config keys and kill switches for voice notes (inert)"
```

---

### Task 2: DB — enum value, voice-profile table, voice-notes job table, char-budget

**Files:**
- Create: `packages/db/migrations/0105_voice_script_feature.sql`
- Create: `packages/db/migrations/0106_voice_notes.sql`
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/src/repositories/voice-notes.ts`
- Create: `packages/db/src/repositories/voice-profiles.ts`
- Modify: `packages/db/src/index.ts` (re-exports)
- Modify: `packages/shared/src/types.ts` (`aiUsageFeatures` ~L112: add
  `"voice-script"`)
- Test: `tests/voice-notes.repository.integration.test.ts` (new)

**Interfaces (produced for Tasks 5–8):**
- `upsertVoiceProfile(db, {platformAccountId, voiceId, model, settings, outputFormat}) → {version}` (version auto-increments)
- `getVoiceProfile(db, platformAccountId) → VoiceProfileRow | null`
- `clearVoiceProfile(db, platformAccountId)`
- `insertVoiceNoteJob(db, row) → {inserted: boolean}` (onConflictDoNothing on `(user_id, client_request_id)`)
- `getVoiceNoteByClientRequestId(db, userId, clientRequestId)`
- `getVoiceNoteById(db, id)`
- `casVoiceNoteDispatch(db, {id, attemptToken, leaseUntil}) → boolean`
- `settleVoiceNoteTerminal(db, {id, attemptToken, state, billedChars, providerRequestId, providerTraceId, providerRegion, audioBytes, audioSha256, audioBytesLen, durationMs}) → boolean` (fenced: `WHERE attempt_token = $token AND state = 'dispatched'`)
- `sweepVoiceNotes(db, now) → {abandonedQueued, leaseExpired}`
- `purgeExpiredVoiceNoteAudio(db, cutoff) → number` (bytes → NULL, state → 'artifact_expired')
- `reserveVoiceCharBudget(db, {pageId, chars, pageBudget, globalBudget, now}) → boolean` (atomic, `reserveOfapiDayCredits` pattern, packages/db/src/repositories/ofapi.ts ~L1336)
- `settleVoiceCharBudget(db, {pageId, charsDelta, now})`

- [ ] **Step 1: Write migration 0105 (enum value)**

Copy the `0072_ai_restricted_class.sql:39` form exactly:

```sql
-- 0105_voice_script_feature.sql
ALTER TYPE "ai_usage_feature" ADD VALUE IF NOT EXISTS 'voice-script';
```

- [ ] **Step 2: Write migration 0106 (tables)**

```sql
-- 0106_voice_notes.sql
CREATE TABLE IF NOT EXISTS "page_voice_profiles" (
  "platform_account_id" bigint PRIMARY KEY REFERENCES "pages"("id") ON DELETE CASCADE,
  "voice_id" text NOT NULL,
  "model" text NOT NULL DEFAULT 'eleven_v3',
  "settings" jsonb NOT NULL DEFAULT '{}',
  "output_format" text NOT NULL DEFAULT 'mp3_44100_128',
  "version" integer NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "voice_notes" (
  "id" bigserial PRIMARY KEY,
  "user_id" bigint NOT NULL,
  "platform_account_id" bigint NOT NULL REFERENCES "pages"("id"),
  "conversation_ref" text NOT NULL,
  "source_generation_ref" text NOT NULL,
  "client_request_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "script_chars" integer NOT NULL,
  "original_script_sha256" text NOT NULL,
  "final_script_sha256" text NOT NULL,
  "script_edited" boolean NOT NULL,
  "profile_voice_id" text NOT NULL,
  "profile_model" text NOT NULL,
  "profile_settings" jsonb NOT NULL,
  "profile_output_format" text NOT NULL,
  "profile_version" integer NOT NULL,
  "state" text NOT NULL DEFAULT 'queued',
  "attempt_token" uuid,
  "lease_until" timestamptz,
  "billed" boolean,
  "billed_chars" integer,
  "provider_request_id" text,
  "provider_trace_id" text,
  "provider_region" text,
  "duration_ms" integer,
  "audio_bytes" bytea,
  "audio_sha256" text,
  "audio_bytes_len" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "voice_notes_state_check" CHECK ("state" IN
    ('queued','dispatched','completed','failed_definite',
     'failed_after_dispatch','indeterminate','quota_denied','artifact_expired')),
  CONSTRAINT "voice_notes_chars_positive" CHECK ("script_chars" > 0),
  CONSTRAINT "voice_notes_audio_cap" CHECK ("audio_bytes_len" IS NULL OR "audio_bytes_len" <= 2097152)
);
CREATE UNIQUE INDEX IF NOT EXISTS "voice_notes_user_client_request"
  ON "voice_notes" ("user_id", "client_request_id");
CREATE INDEX IF NOT EXISTS "voice_notes_lease_idx"
  ON "voice_notes" ("state", "lease_until");
CREATE INDEX IF NOT EXISTS "voice_notes_purge_idx"
  ON "voice_notes" ("state", "created_at") WHERE "audio_bytes" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "voice_char_budget" (
  "scope" text NOT NULL,
  "utc_day" date NOT NULL,
  "spent_chars" integer NOT NULL DEFAULT 0,
  PRIMARY KEY ("scope", "utc_day")
);
```

- [ ] **Step 3: Mirror in schema.ts + write repositories**

Drizzle mirrors follow `wbClosingSettings` (schema.ts ~L2175) and
`ofapiCommands` (~L1185) shapes: `.$type<VoiceNoteState>()` on `state`,
`uniqueIndex`, `check(...)`. Repositories implement the Interfaces block;
`reserveVoiceCharBudget` is a single conditional upsert (page scope AND
global scope both checked in one transaction — reserve page row first,
then global row; roll back both on either failure), copying the
`reserveOfapiDayCredits` conditional-`ON CONFLICT DO UPDATE … WHERE (spent
+ estimate) <= budget RETURNING` idiom.

- [ ] **Step 4: Write failing repository integration test, run, implement, re-run**

`tests/voice-notes.repository.integration.test.ts` (Testcontainers via
`startIntegrationTestDatabase()`): covers insert-dedup (second insert with
same `(user, clientRequestId)` returns `inserted:false`), CAS grants
dispatch exactly once under concurrent calls, fenced settle rejects a
stale attempt token, sweep moves lease-expired `dispatched` →
`indeterminate` and abandoned `queued` → `indeterminate`, purge nulls
bytes and flips state, char-budget reserve refuses when over budget and
settles deltas. Run: `pnpm vitest run tests/voice-notes.repository.integration.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/db packages/shared/src/types.ts tests/voice-notes.repository.integration.test.ts
git commit -m "feat(voice): voice_notes state machine tables, profiles, char budget (0105-0106)"
```

---

### Task 3: `voice-script` feature (prompt + ledger vocabularies)

**Files:**
- Modify: `apps/runtime/src/modules/ai/prompts/types.ts` (FeatureType ~L9)
- Modify: `apps/runtime/src/modules/ai/prompts/feature-policies.ts`
  (OPERATION_FEATURES ~L96, FEATURE_POLICIES ~L106)
- Modify: `apps/runtime/src/modules/ai/prompts/builder.ts`
  (PROMPT_POLICIES ~L101, DEFAULT_TEMPLATES ~L111)
- Modify: `apps/runtime/src/modules/ai/prompts/templates.ts` +
  Create: `apps/runtime/src/modules/ai/prompts/templates/voice-script.md`
- Modify: `apps/runtime/src/modules/ai/prompts/prompt-manifest.json`
- Modify: `apps/runtime/src/services/ai-gateway-anthropic.ts` (three maps
  ~L56/L70/L90)
- Test: `tests/ai-prompts-templates-sync.test.ts` (7→8),
  `tests/ai-prompts-builder.test.ts`,
  `tests/ai-feature-service.integration.test.ts`

**Interfaces:**
- Produces: feature key `'voice-script'` valid on
  `POST /api/v1/ai/features/voice-script`; its SSE meta frame carries the
  `generationRef` Task 5 validates as `sourceGenerationRef`.

- [ ] **Step 1: Extend both vocabularies (compile-driven)**

`types.ts` FeatureType: add `'voice-script'`. `aiUsageFeatures` was
already extended in Task 2. Then let `pnpm typecheck` enumerate every
`Record<…Feature,…>` that now fails — that IS the checklist.

- [ ] **Step 2: Policy entry**

```ts
// feature-policies.ts — FEATURE_POLICIES
'voice-script': {
  surface: 'panel-tab',
  resultKind: 'single-reply',   // one script text; no [NEXT], no variants
  promptMode: 'reply',
  timeoutBucket: 'quick',
  messageCountBucket: 'quick',
  modelFeature: 'fast-reply',   // delegates model selection (improve-draft precedent)
  includesEarnings: false,
  minMessages: 0,
  rerunAction: 'regenerate',
  supportsReplyMode: false,
  supportsReplyTone: true,   // UX decision 2026-07-18: tone presets re-run
                             // the script step (free of EL chars); template
                             // must include {toneInstructions}
  requiresDraft: true,
  usesPingSegment: false,
  usesFanProfile: false,
},
```

- [ ] **Step 3: Template**

`templates/voice-script.md` must contain the cache anchors
(`## Conversation Transcript`, `## Current Draft`, trailing `## Your
Task`) or block caching silently degrades (builder.ts `splitTemplate`
~L186). Content: rewrite `{draftSection}` into a natural spoken one-liner
for the model's voice; keep meaning; strip emoji/abbreviations; at most
1–2 audio tags from the allowed vocabulary `[warmly] [cheerfully]
[thoughtful] [excited] [whispers] [chuckles] [giggles] [sighs] [short
pause] [long pause]`; output ONLY the script text, no quotes, no
commentary. Register `VOICE_SCRIPT_TEMPLATE` in `templates.ts`,
`DEFAULT_TEMPLATES`, `PROMPT_POLICIES`, and add the manifest entry
(post-freeze pattern, Decision-#136 note lines).

- [ ] **Step 4: Provider maps**

```ts
// ai-gateway-anthropic.ts
FEATURE_MAX_TOKENS:            'voice-script': 400,
FEATURE_TEMPERATURES:          'voice-script': 0.4,
ANTHROPIC_ADAPTIVE_MAX_TOKENS: 'voice-script': 800,
```

- [ ] **Step 5: Tests, then commit**

Update `tests/ai-prompts-templates-sync.test.ts` (TEMPLATE_FILES array +
`toHaveLength(8)`); add a builder test asserting the voice-script prompt
contains the draft and the tag vocabulary instruction; extend
`ai-feature-service.integration.test.ts` with a voice-script stream
happy-path + `gate_draft_required` when draftText is missing.

```bash
pnpm vitest run tests/ai-prompts-templates-sync.test.ts tests/ai-prompts-builder.test.ts tests/ai-feature-service.integration.test.ts
git add apps/runtime/src/modules/ai apps/runtime/src/services/ai-gateway-anthropic.ts tests/
git commit -m "feat(voice): voice-script feature on the SSE lane"
```

---

### Task 4: ElevenLabs provider + egress vendor branch

**Files:**
- Create: `apps/runtime/src/services/voice-elevenlabs-provider.ts`
- Modify: `apps/runtime/src/services/egress/resolver.ts` (~L49 vendor branch)
- Modify: `apps/runtime/src/bootstrap.ts` (~L213 provider wiring + AppContext)
- Modify: `scripts/raw-fetch-budget.json` (14→15, comment `+ elevenlabs
  provider 1`)
- Test: `tests/voice-elevenlabs-provider.test.ts` (new, mock fetch),
  `tests/egress-resolver.integration.test.ts` (vendor branch)

**Interfaces:**
- Produces:
  ```ts
  interface VoiceTtsProvider {
    synthesize(input: {
      voiceId: string; model: string; settings: Record<string, unknown>;
      outputFormat: string; text: string; signal: AbortSignal;
    }): Promise<
      | { ok: true; audio: Buffer; characterCost: number | null;
          requestId: string | null; traceId: string | null; region: string | null }
      | { ok: false; refusedBeforeBilling: boolean; status: number; snippet: string }
    >;
  }
  ```
  wired as `app.voiceTtsProvider: VoiceTtsProvider | undefined`
  (constructed only when `voiceNotesEnabled && elevenLabsApiKey`,
  bootstrap ~L213 pattern).
- Egress: `resolveEgress(app, { kind: "vendor", vendor: "elevenlabs" })`
  returns `{ egressKey: "vendor:elevenlabs", dispatcher: null,
  pace: async () => 0, close: noop }` — direct, unpaced, no platform
  masquerade (`EGRESS_VENDOR_PROVIDERS` and `PLATFORM_VENDORS` untouched).

- [ ] **Step 1: Failing egress test** — assert the new vendor scope
  resolves (and `fansly` still throws). Run; expect `Unknown egress
  vendor "elevenlabs"`.

- [ ] **Step 2: Resolver branch + provider implementation**

Provider: one `fetch` to
`https://api.elevenlabs.io/v1/text-to-speech/{voiceId}?output_format=…`
with `xi-api-key`, JSON body `{ text, model_id }` + settings; 60 s
AbortSignal; ZERO retries; reads `character-cost`, `request-id`,
`x-trace-id`, `x-region` headers; buffers the body; never logs text or
audio. `refusedBeforeBilling` is true only for pre-synthesis rejections
(4xx validation/auth); 5xx/timeout after dispatch is NOT refused (the
caller maps that to `indeterminate`). Bump the raw-fetch budget with the
justification comment.

- [ ] **Step 3: Run tests, commit**

```bash
pnpm vitest run tests/voice-elevenlabs-provider.test.ts tests/egress-resolver.integration.test.ts
git add apps/runtime/src/services scripts/raw-fetch-budget.json tests/
git commit -m "feat(voice): elevenlabs provider behind a direct vendor egress class"
```

---

### Task 5: Voice-notes service (admission, state machine, dispatch)

**Files:**
- Create: `apps/runtime/src/services/voice-notes.ts`
- Create: `apps/runtime/src/services/voice-script-validation.ts`
- Test: `tests/voice-notes-service.integration.test.ts` (new)

**Interfaces:**
- Consumes: Task 2 repos, Task 4 `app.voiceTtsProvider`, Task 1 config.
- Produces (for Task 6 handlers):
  ```ts
  createVoiceNote(app, principal, pageLabel, body: {
    clientRequestId: string; conversationRef: string;
    sourceGenerationRef: string; script: string;
  }): Promise<VoiceNoteStatusView>       // throws typed errors; 202 semantics
  getVoiceNoteStatus(app, principal, pageLabel, id): Promise<VoiceNoteStatusView>
  getVoiceNoteAudio(app, principal, pageLabel, id): Promise<{ bytes: Buffer; sha256: string }>
  // VoiceNoteStatusView = { voiceNoteId, state, scriptChars, billed,
  //   audioSha256, audioBytesLen, createdAt, errorCode? } — never audio
  //   bytes; createdAt gives the takes list a stable order client-side
  ```
- Canonicalization (shared with the extension via docs, not code):
  Unicode NFC + `\r\n`→`\n` + trim; `request_hash = sha256(pageId + "\n"
  + conversationRef + "\n" + sourceGenerationRef + "\n" + canonicalScript)`.
- Tag validation: reject any `[...]` group not in the allowlist (exact
  strings, case-sensitive); reject `<` and `>` entirely (no SSML/markup).
- Structured error codes (body `code` field, gate-error pattern):
  `voice_disabled`, `voice_not_allowlisted`, `voice_no_profile`,
  `voice_script_invalid`, `voice_source_invalid`, `voice_quota_denied`,
  `idempotency_mismatch` (409), `artifact_expired` (410),
  `voice_retrieval_disabled`.

- [ ] **Step 1: Failing service tests first** — the duplicate-behavior
  matrix from the spec, each as a test: same id+hash completed → replay
  without re-admission (verify by breaking a gate between calls: flip
  allowlist off, replay still succeeds); same id+hash dispatched → status,
  no second provider call (spy); different hash → 409; quota over budget →
  `quota_denied` state + ledger row + budget released… Run: all fail.

- [ ] **Step 2: Implement `createVoiceNote`**

Order inside: (1) lookup existing by `(user, clientRequestId)` — if found:
authn + `canAccessPage` only, hash-compare (409 on mismatch), return view.
(2) New job: full admission — kill switch, allowlist
(`voiceNotesPageAllowlist` CSV via effective config), profile exists
(snapshot it), canonical script validation (length ≤
`voiceNotesScriptMaxChars`, tag allowlist, markup), source generation:
query `ai_usage_events`/generation content by `sourceGenerationRef`, must
be `feature='voice-script'`, terminal-success, same user+page. (3)
`reserveVoiceCharBudget` (page + global) — refusal inserts the job row in
`quota_denied` and throws `voice_quota_denied`. (4) Insert `queued` row
(unique-race: on `inserted:false` re-read and go to (1)). (5)
`casVoiceNoteDispatch` with fresh `attemptToken`, `lease_until = now() +
120 s`. (6) Fire-and-forget dispatch (`void dispatchVoiceNote(...)`) —
the request returns the `queued/dispatched` view immediately; the
detached task calls the provider, then `settleVoiceNoteTerminal` (fenced
by attempt token): ok→`completed` (+bytes, sha256, headers,
`settleVoiceCharBudget` delta), refusedBeforeBilling→`failed_definite`
(release budget), other→`failed_after_dispatch` or leave for lease sweep
(`indeterminate`). Client disconnect never aborts the detached task.

- [ ] **Step 3: Implement status/audio reads**

Status: authn + page access + retrieval switch; lookup by
`(id, pageId, userId)` tuple; miss → 404 (indistinguishable). Audio:
same, plus `state === 'completed'` with bytes; `artifact_expired` → 410
with code; verify stored sha256 before returning.

- [ ] **Step 4: Run the matrix green, commit**

```bash
pnpm vitest run tests/voice-notes-service.integration.test.ts
git add apps/runtime/src/services tests/
git commit -m "feat(voice): voice-note admission, CAS dispatch, fenced settle"
```

---

### Task 6: Routes, contracts, SDK (incl. binary helper), capability flag

**Files:**
- Modify: `packages/contracts/src/routes.ts` (three entries + params/body/
  response schemas; `assignedPageSchema` ~L569: add
  `capabilities: z.object({ voiceNotes: z.boolean() }).optional()`)
- Create: `apps/runtime/src/modules/voice/index.ts` (+ register in
  `buildApiServer`, server.ts ~L469)
- Modify: `apps/runtime/src/api/server.ts` `normalizeOpenApiDocument`
  (~L139): rewrite audio route 200 media type `application/json` →
  `audio/mpeg` (OpenAPI `{param}` brace syntax)
- Modify: `packages/contracts/src/sdk-runtime.ts`:
  `SDK_EXCLUDED_OPERATIONS` += `"voiceNoteAudio"`; add exported helper
  `fetchVoiceNoteAudio(options, { pageLabel, id }): Promise<Response>`
  (model: `ofapiRead` ~L653)
- Modify: `packages/contracts/src/generate-sdk.ts` export list (helper)
- Modify: the pages-list handler (module that serves `assignedPageSchema`)
  to compute `capabilities.voiceNotes = enabled && allowlisted && profile
  exists`
- Modify: `tests/contracts-auth-declarations.test.ts` (hardcoded
  page-scoped key list += `voiceNoteCreate`, `voiceNoteStatus`,
  `voiceNoteAudio`)
- Test: `tests/api.integration.test.ts`, `tests/sdk.integration.test.ts`

**Interfaces:**
- Produces the vendored-SDK surface Phase 2 consumes:
  `client.voiceNoteCreate({ params:{pageLabel}, body })` → 202 view,
  `client.voiceNoteStatus({ params:{pageLabel, id} })` → view,
  `fetchVoiceNoteAudio(options, {pageLabel, id})` → raw `Response`.
- 410 stays category `validation` in `categoryForStatus` BY DECISION —
  clients match the structured body code `artifact_expired`, not the
  category (the existing gate-code pattern). Record this in the route
  entry description.

- [ ] **Step 1: Contract entries** (auth `{ kind:"apiKey", scope:"page" }`
  on all three; create declares `response: { 202: voiceNoteStatusSchema,
  400/401/403/404/409: errorResponseSchema }`; audio declares `200:
  z.string().describe("Binary audio/mpeg …")` per the CSV precedent
  routes.ts ~L5154, plus 401/403/404/410).
- [ ] **Step 2: Handlers** in `modules/voice/index.ts` — JSON routes
  return objects (202 via `reply.code(202)`); audio route buffers first,
  then `reply.hijack()` + `raw.writeHead(200, { "content-type":
  "audio/mpeg", "content-length": …, "cache-control": "private,
  no-store", "x-content-type-options": "nosniff" })` + `raw.end(buffer)`
  (ops CSV handler precedent ~L520).
- [ ] **Step 3: Regenerate + fix pinned tests**

```bash
pnpm contracts:generate
pnpm vitest run tests/contracts-auth-declarations.test.ts tests/sdk.integration.test.ts
```

- [ ] **Step 4: Integration tests** — in `tests/api.integration.test.ts`:
  202 shape; status view; audio `content-type: audio/mpeg` + bytes
  round-trip; page-scope 403/404; 409 mismatch; 410 body code; capability
  flag appears only when switch+allowlist+profile all true. In
  `tests/sdk.integration.test.ts`: typed create/status round-trip + the
  binary helper (CSV-raw test pattern ~L166).
- [ ] **Step 5: Commit**

```bash
git add packages/contracts packages/sdk reference/ docs/generated/ apps/runtime/src tests/
git commit -m "feat(voice): voice-note routes, binary SDK helper, capabilities.voiceNotes"
```

---

### Task 7: Sweeper + retention purge jobs

**Files:**
- Create: `apps/runtime/src/services/voice-notes-sweep.ts` (three-export
  pattern: `VOICE_NOTES_SWEEP_QUEUE`, `ensureVoiceNotesSweepQueue`,
  `ensureVoiceNotesSweepSchedule` (`*/1 * * * *`), `runVoiceNotesSweep`)
- Modify: `apps/runtime/src/services/schedules.ts` (~L32 registerAllSchedules)
- Modify: `apps/runtime/src/worker-services.ts` (register `boss.work`)
- Modify: the nightly cleanup handler (worker-services.ts ~L193
  RAW_PAYLOAD_CLEANUP pattern): add `purgeExpiredVoiceNoteAudio(db, now -
  7 days)`
- Test: `tests/voice-notes-sweep.test.ts`

**Interfaces:**
- Consumes Task 2 `sweepVoiceNotes` / `purgeExpiredVoiceNoteAudio`.
- Sweep semantics: `queued` older than 5 min (crash between insert and
  CAS) → `indeterminate` + release budget; `dispatched` past `lease_until`
  → `indeterminate` (budget stays reserved — billing unknown; the nightly
  job releases reservations for `indeterminate` rows older than 24 h,
  conservative direction).

- [ ] **Step 1: failing sweep test → implement → green → commit**

```bash
pnpm vitest run tests/voice-notes-sweep.test.ts
git add apps/runtime/src tests/
git commit -m "feat(voice): voice-notes lease sweeper and 7-day audio purge"
```

---

### Task 8: CLI `voice-profile` + decision-log entries

**Files:**
- Modify: `apps/runtime/src/cli.ts` (new `voice-profile` group; `page
  set-proxy` pattern ~L992)
- Create: `apps/runtime/src/services/voice-profiles.ts` (service the CLI
  calls; `page-proxies.ts` pattern)
- Modify: `docs/decisions.md` (core)
- Test: `tests/voice-profiles.test.ts`

**Interfaces:**
- `voice-profile set --page <label> --voice-id <id> [--model eleven_v3]
  [--stability natural] [--output-format mp3_44100_128]` → upsert,
  version++ ; `voice-profile show --page <label>` ; `voice-profile clear
  --page <label>`.

- [ ] **Step 1: service + CLI + test, commit**
- [ ] **Step 2: Decision-log entry** (next free number; #158 was latest at
  planning time). One entry covering: the voice-notes lane (three routes,
  state machine per #158 pattern, structured codes); artifact storage —
  bounded BYTEA (≤2 MB/row) with logged 7-day purge, explicitly
  superseding #36 for this class; the `vendor:"elevenlabs"` direct
  unpaced egress class; character-budget ledger separate from
  `ai_usage_events`. **This entry is the owner sign-off point for the #36
  supersession — flag it in the PR description.**

```bash
git add apps/runtime/src docs/decisions.md tests/
git commit -m "feat(voice): voice-profile CLI + decision entry (supersedes #36 for voice audio)"
```

---

### Task 9: Full check, PR, re-vendor readiness

- [ ] **Step 1:** `pnpm check` green in the worktree (typecheck + lint +
  gates + tests + build; Testcontainers suites need Docker running).
- [ ] **Step 2:** Push `ai/voice-notes-core`, open a Draft PR titled
  `feat(voice): voice-notes kernel lane (inert, kill-switch off)`; body
  lists the decision entry (#36 supersession) for explicit owner sign-off.
  If the control-plane toolkit manages core, finish with
  `agent review core --pr <N>`.
- [ ] **Step 3:** AFTER merge (owner-only): from a CLEAN core checkout run
  `node scripts/vendor-sdk.mjs ../chatgoose/vendor/kernel-sdk` and commit
  the vendor refresh in chatgoose as its own change — that unlocks the
  Phase 2 plan.

---

## Self-review notes (spec → plan coverage)

Spec §1 voice-script → Task 3; §2 resource/idempotency/state machine →
Tasks 2+5+6; §3 storage decision → Tasks 2+8 (decision entry); §4 ledger/
budget → Tasks 2+5 (char budget; `character-cost` recorded on the job row
AND settled into the budget counter — a separate analytics table was
dropped as YAGNI: the `voice_notes` row itself is the per-synthesis
ledger, spec's field list maps onto its columns); §5 egress/key → Tasks
1+4; §6 profiles/capability → Tasks 2+6+8; error codes → Task 5;
sweeper/purge → Task 7; rollout steps 2–4 → Tasks 1–9 order. Known
deviation from spec §4: no separate `voice_usage_events` table — the job
table is append-only per attempt and carries every ledger field; recorded
here deliberately (revisit only if multi-attempt-per-row ever appears,
which the fresh-clientRequestId rule forbids).
