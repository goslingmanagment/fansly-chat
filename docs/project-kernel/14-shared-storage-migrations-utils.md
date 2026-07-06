> **SUPERSEDED (Stage 35, 2026-07-07):** this is the Pass 1 (pre-migration)
> codebase map, kept as the migration's historical record. The regenerated
> post-migration maps live in `docs/generated/` in this repo.

# Shared — Storage Schema, Migrations, Errors & Utilities

## Scope

This document maps the `src/shared/` persistence layer and the cross-cutting
utilities layered on top of it. Every file below was read in full from source:

- `src/shared/storage.ts` (313 lines) — typed read/write helpers over `browser.storage.local`; the durable schema surface.
- `src/shared/migrations.ts` (168 lines) — default/seed builders, settings migration, and the schema-version migration framework (`STORAGE_SCHEMA_VERSION = 7`).
- `src/shared/summary-cache.ts` (302 lines) — the `summary:<groupId>` fan-summary cache: key helpers, validation/normalization, eviction, `SummaryCacheStore`, availability checks.
- `src/shared/account-aliases.ts` (72 lines) — legacy→canonical account-id alias resolution.
- `src/shared/concurrency.ts` (24 lines) — `mapWithConcurrency` bounded fan-out.
- `src/shared/errors.ts` (427 lines) — `ChatGooseError`, the full `ERROR_REGISTRY` catalog, and the `toUserError`/`createUserError` conversion helpers.
- `src/shared/log.ts` (92 lines) — the debug-gated logger with secret redaction.
- `src/shared/hotkeys.ts` (132 lines) — the ChatGoose keyboard-shortcut table (letters, combos, labels).
- `src/shared/keymap.ts` (93 lines) — the DOM-free key-matching engine (`createKeymap`, `eventMatchesCombo`).
- `src/shared/agency-hub.ts` (102 lines) — pure Agency-Hub URL/username normalization + summary-sync-metadata helpers shared between the background Hub client and the options page (the Hub *wire* contract itself is in `boundaries.md` §6).

The four external network boundaries (Fansly REST, Anthropic, OpenRouter, Agency
Hub) are owned by `docs/project-kernel/boundaries.md`; this document does not
re-derive those contract tables but flags where these files touch them. The one
boundary these files own directly is **`browser.storage.local`** (the local
extension storage area). Type shapes referenced below (`PersistedState`,
`Settings`, `Personality`, `SummaryCacheEntry`, `UserFacingError`,
`UserErrorKey`, `AgencyHubSummarySyncMetadata`) are defined in
`src/shared/types.ts` and mapped in `12-shared-domain-model.md`.

---

## 0. The `browser.storage.local` schema (the boundary these files own)

`PersistedState` (`types.ts:98`) is stored **flattened at the top level** of
`browser.storage.local` — it is NOT nested under one key. The concrete keys are:

| Storage key | Value shape | Written by |
|---|---|---|
| `schemaVersion` | `number` (current `7`) | `loadStorageState`, `migrateState` output |
| `settings` | `Settings` object (see §1.2) | `saveSettings`, `loadStorageState` |
| `personalities` | `Personality[]` | `savePersonalities`, `deletePersonality` |
| `accountMappings` | `Record<string,string>` (accountId → personalityId) | `saveAccountMapping`, `deletePersonality`, `rekeyAccountIdentity` |
| `accountAliases` | `Record<string,string>` (legacy accountId → resolved accountId) | `rekeyAccountIdentity` |
| `knownAccounts` | `string[]` (sorted) — key literal `'knownAccounts'` via `KNOWN_ACCOUNTS_KEY` | `registerKnownAccount`, `reconcileKnownAccounts`, `rekeyAccountIdentity` |
| `summary:<groupId>` | `SummaryCacheEntry` — one key per cached fan summary, prefix `'summary:'` via `SUMMARY_CACHE_PREFIX` | `SummaryCacheStore.save/update`, `saveSummaryCache` |

Constants come from `constants.ts`: `STORAGE_SCHEMA_VERSION = 7` (`constants.ts:26`),
`SUMMARY_CACHE_PREFIX = 'summary:'` (`:27`), `KNOWN_ACCOUNTS_KEY = 'knownAccounts'`
(`:28`), `SUMMARY_EVICTION_COUNT = 10` (`:29`).

Note: `browser.storage.onChanged` filtering (reacting to these keys) lives in
`background/index.ts:68` and `background/storage-coordinator.ts` (out of scope
for this document). `storage.ts` itself registers **no** change listener — it is
pure read/write helpers.

---

## 1. `src/shared/storage.ts`

**Imports:** `constants.ts` (message-count bounds, `KNOWN_ACCOUNTS_KEY`,
`SUMMARY_EVICTION_COUNT`, `STORAGE_SCHEMA_VERSION`, `REASONING_EFFORTS`),
`model-registry.ts` (`normalizeModelId`), `account-aliases.ts`
(`collectAliasKeysForCanonical`, `resolveCanonicalAccountId`), `agency-hub.ts`
(`normalizeAgencyHubBaseUrl`), `migrations.ts` (`createDefaultSettings`,
`migrateState`), `personalities.ts` (`normalizeSavedPersonality`,
`reconcileBundledPersonalities`), `summary-cache.ts`
(`getInvalidSummaryCacheKeys`, `getSummaryCacheKeysForPersonality`,
`getSummaryCacheKeysReferencingPersonality`, `SummaryCacheStore`), `types.ts`.

**Consumed by (grep):** `options/index.ts` (heaviest, 21 refs),
`background/storage-coordinator.ts` (13), `background/operations.ts` (6),
`content/mapping-banner.ts` (3), `content/index.ts` (2),
`background/runtime-api.ts` (2), `background/index.ts` (1),
`background/compare-operations.ts` (1).

Every function in this file performs `browser.storage.local` I/O.

### 1.1 `loadStorageState()` → `Promise<PersistedState>` (`storage.ts:62`)

The single canonical read path. Control flow:

1. `raw = await browser.storage.local.get(null)` — reads the **entire** local
   storage area (all keys, including every `summary:*` entry).
2. `invalidSummaryKeys = getInvalidSummaryCacheKeys(raw)` — finds `summary:*`
   keys whose value fails normalization (§3.4).
3. `state = migrateState(raw)` — migrate/normalize into `PersistedState` (§2.6).
4. `state.settings = sanitizeSettings(state.settings)` — clamp/coerce (§1.2).
5. `reconcileBundledPersonalities(state.personalities)` (external, `personalities.ts`)
   — returns `{ personalities, changed }`; result replaces `state.personalities`.
6. **Side-effect writes** (this is a read that can mutate storage):
   - If `invalidSummaryKeys.length > 0`: `browser.storage.local.remove(...)` —
     passes a single string if exactly one key, else the array (`:73`–`77`).
   - If the on-disk `schemaVersion !== STORAGE_SCHEMA_VERSION` **or**
     `personalitiesChanged`: `browser.storage.local.set(state)` writes the full
     migrated state back (`:78`–`83`).
7. Returns the in-memory `state`.

Consequence: a load at the current schema with valid personalities does no write;
a load at an older/absent schema version, or one that reconciles bundled
personalities, or one with corrupt summary keys, rewrites storage as a
by-product.

### 1.2 `sanitizeSettings(input: Partial<Settings>)` → `Settings` (`storage.ts:88`)

Coerces a partial settings object into a fully-populated, bounded `Settings`.
Starts from `createDefaultSettings()` (§2.1). Rules:

- **Message counts** — `quickMessageCount`, `pingMessageCount`,
  `improveMessageCount`, `deepMessageCount`: `Number(...)`, replaced by the
  default if not `Number.isFinite`, then clamped with `Math.min(MAX, Math.max(MIN, v))`.
  Bounds (from `constants.ts`): quick `5..200`, ping `5..200`, improve `5..200`,
  deep `100..3000`.
- **`featureModels`** (`:99`) — for each key of `defaults.featureModels`
  (`ModelSelectableFeatureType`: `fast-reply`, `help-me`, `fan-summary`,
  `chat-review`, `ping`), runs candidate through `normalizeModelId`; keeps the
  normalized id only if truthy, else the default. Non-object input → all defaults.
- **`featureReasoning`** (`:111`) — per key, `normalizeReasoningEffort` accepts
  the value only if it is a string in `REASONING_EFFORTS`
  (`['off','low','medium','high','max']`), else the per-feature default.
- **API keys / URLs** — `claudeApiKey`, `openRouterApiKey`, `agencyHubApiKey`:
  `String(...).trim()`. `agencyHubBaseUrl`: `normalizeAgencyHubBaseUrl(String(...))`
  (parses URL, requires http/https, strips trailing slashes; `agency-hub.ts:9`).
- **Booleans** — `debugMode`, `promptCachingEnabled`: `Boolean(input.x ?? default)`.
  Note `promptCachingEnabled` defaults to `true`, so `Boolean(false ?? true)` = `false`
  correctly preserves an explicit `false`.

Internal helpers: `normalizeReasoningEffort` (`:53`), `arraysEqual` (`:49`).

### 1.3 `saveSettings(patch: Partial<Settings>)` → `Promise<Settings>` (`storage.ts:143`)

Load full state, merge `{ ...state.settings, ...patch }`, `sanitizeSettings`,
then `browser.storage.local.set({ settings: nextSettings })` (only the `settings`
key). Returns the sanitized result.

### 1.4 `savePersonalities(personalities)` → `Promise<Personality[]>` (`storage.ts:150`)

Maps each through `normalizeSavedPersonality`, then
`reconcileBundledPersonalities` (external), sets `{ personalities: reconciled }`.
Does not touch `accountMappings` or summaries.

### 1.5 `deletePersonality(personalityId)` → `Promise<void>` (`storage.ts:158`)

- Loads state; finds the target. **Guard:** if `target?.builtin` is truthy,
  returns without changing anything (built-ins cannot be deleted).
- Filters the personality out; strips `accountMappings` entries whose mapped
  value equals the deleted `personalityId` (`Object.fromEntries` filter).
- Re-reads raw storage and computes summary-cache removals as the **union** of
  `getSummaryCacheKeysForPersonality(state, id)` (uses the typed state) and
  `getSummaryCacheKeysReferencingPersonality(raw, id)` (scans raw values) — a
  `new Set` de-dup.
- Writes `{ personalities, accountMappings }`; if removals exist, a separate
  `browser.storage.local.remove(removals)`.

### 1.6 `saveAccountMapping(accountId, personalityId | null)` → `Promise<void>` (`storage.ts:181`)

Alias-aware. Resolves `canonicalAccountId = resolveCanonicalAccountId(aliases, accountId) ?? accountId`;
collects all alias keys pointing at that canonical via `collectAliasKeysForCanonical`.
Deletes mapping entries for the set `{accountId, canonicalAccountId, ...aliasKeys}`.
If `personalityId` is non-null, sets `nextMappings[canonicalAccountId] = personalityId`
(mapping is always stored under the **canonical** id). Writes `{ accountMappings }`.

### 1.7 `registerKnownAccount(accountId)` → `Promise<void>` (`storage.ts:202`)

No-op if already present. Otherwise appends and re-sorts (`[...known, id].sort()`),
writes `{ [KNOWN_ACCOUNTS_KEY]: knownAccounts }`.

### 1.8 `reconcileKnownAccounts(activeCanonicalAccountIds: string[])` → `Promise<PersistedState>` (`storage.ts:212`)

Computes `knownAccounts` = sorted unique union of the passed non-empty active ids
and `Object.keys(state.accountMappings)`. If `arraysEqual` to the existing list,
returns state unchanged (no write). Else writes `{ [KNOWN_ACCOUNTS_KEY]: ... }`
and returns `{ ...state, knownAccounts }`.

### 1.9 `rekeyAccountIdentity(legacyAccountId, resolvedAccountId)` (`storage.ts:231`)

Migrates an account's identity from a legacy id to a resolved id. Returns
`{ state, mappingMigrated, mappingConflict, knownAccountsChanged }`.

- **Early return** (no change) if either id is falsy or they are equal (`:242`).
- **Alias write:** if `accountAliases[legacy] !== resolved`, adds
  `aliases[legacy] = resolved` (`accountAliasesChanged`).
- **Mapping merge:**
  - Both legacy and resolved already mapped → delete the legacy entry, set
    `mappingConflict = true` (resolved mapping wins).
  - Only legacy mapped → move it to `resolved`, delete legacy, `mappingMigrated = true`.
  - Only resolved mapped / neither → no mapping change.
- **knownAccounts:** if it contains `legacy`, remap each occurrence to `resolved`,
  de-dup, sort; `knownAccountsChanged` via `arraysEqual`.
- Writes `{ accountMappings, accountAliases, [KNOWN_ACCOUNTS_KEY]: knownAccounts }`
  only if any of the three changed. Returned `state` is a fresh spread only when
  something changed, else the original `state` object.

### 1.10 Summary-cache pass-throughs

`createSummaryCacheStore()` (`storage.ts:41`) constructs a `SummaryCacheStore`
bound to `browser.storage.local`, `loadStorageState`, and
`{ evictionCount: SUMMARY_EVICTION_COUNT }` (i.e. `10`). It supplies **no**
`afterSet`/`afterRemove` hooks (those are only wired in `storage-coordinator.ts`).

- `getSummaryCache(groupId)` → `store.get(groupId)` (`:303`).
- `saveSummaryCache(groupId, entry)` → `store.save(groupId, entry)` (`:307`).
- `removeSummaryCache(groupId)` → `store.remove(groupId)` (`:311`).

Each of these constructs a **new** store per call.

---

## 2. `src/shared/migrations.ts`

**Imports:** `constants.ts` (default message counts, `DEFAULT_FEATURE_MODELS`,
`DEFAULT_FEATURE_REASONING`, `STORAGE_SCHEMA_VERSION`), `summary-cache.ts`
(`collectSummaryCacheEntries`), `types.ts`.
**Consumed by:** `storage.ts` (`createDefaultSettings`, `migrateState`), plus
`createDefaultSettings`/`createSeedState` used in tests and elsewhere.

### 2.1 `createDefaultSettings()` → `Settings` (`migrations.ts:13`)

Returns the baseline `Settings`: empty API keys/URL, message counts from the
`*_DEFAULT_MESSAGE_COUNT` constants (quick 100, ping 100, improve 25, deep 1500),
`debugMode: false`, `promptCachingEnabled: true`, and **fresh copies** of
`DEFAULT_FEATURE_MODELS` / `DEFAULT_FEATURE_REASONING` (spread to avoid shared
references). Mirrors `DEFAULT_SETTINGS` in `constants.ts:190` but is a live
factory rather than a shared literal.

### 2.2 `createSeedState()` → `PersistedState` (`migrations.ts:30`)

The clean-slate state for empty/corrupt storage: `schemaVersion: 7`, default
settings, empty `personalities`, `accountMappings`, `accountAliases`,
`knownAccounts`. No summary keys.

### 2.3 `migrateSettingsRecord(raw)` → `Settings` (`migrations.ts:41`) — the real legacy transform

This is where legacy field renaming happens:

- **`anthropicApiKey` → `claudeApiKey`** (`:43`–`48`): prefers a non-empty
  `raw.claudeApiKey`; otherwise falls back to legacy `raw.anthropicApiKey`;
  otherwise the default (empty). This is the primary historical rename.
- **`pingMessageCount` falls back to `quickMessageCount`** (`:61`):
  `Number(raw.pingMessageCount ?? raw.quickMessageCount ?? default)` — old data
  that only had a quick count seeds the ping count from it.
- Other fields copied when the correct type is present, else default.
  `featureModels`/`featureReasoning` are passed through **only** if present and
  `typeof === 'object'` — **not** validated per-key here (that validation is
  `sanitizeSettings`'s job, applied afterward in `loadStorageState`).
- Numeric fields are `Number(...)`-coerced but **not** clamped here.

### 2.4 `normalizePersistedRecord(record, schemaVersion)` → `PersistedState` (`migrations.ts:86`)

Builds a well-formed `PersistedState` from a raw record, guarding each field:

- `settings`: `migrateSettingsRecord` if `record.settings` is an object, else
  default settings.
- `personalities`: kept only if `Array.isArray`, else `[]`.
- `accountMappings` / `accountAliases`: kept only if object, else `{}`.
- `knownAccounts`: kept only if `Array.isArray`, else `[]`.
- Spreads `...collectSummaryCacheEntries(record)` (§3.3) so any valid `summary:*`
  keys survive into the returned object (this is how summaries are carried
  through a full-state rewrite).
- Stamps the passed `schemaVersion`.

### 2.5 The migration framework — `MigrationStep`, `MIGRATIONS`, `applyMigrations`

- `MigrationStep` interface (`:81`): `{ toVersion: number; migrate: (record) => record }`.
- `MIGRATIONS` (`:115`) is a **single-entry** array: one step with
  `toVersion: STORAGE_SCHEMA_VERSION` (7) whose `migrate` just calls
  `normalizePersistedRecord(record, 7)`.
  - **Discrepancy vs. the assignment's framing:** there are **no incremental
    per-version steps** (no v1→v2, v2→v3, …). The framework is shaped to support
    a chain of steps, but in practice any old version is collapsed directly to 7
    by one normalization pass. "What each migration transforms" is entirely
    embodied in `migrateSettingsRecord` (the `anthropicApiKey` rename + ping
    fallback) and `normalizePersistedRecord`'s type-guarding. The bump from
    prior schema numbers up to 7 carries no version-specific field rewrites
    beyond those.
- `applyMigrations(record, schemaVersion)` (`:123`): iterates `MIGRATIONS`,
  skipping steps whose `toVersion <=` the current version; runs the rest and sets
  `migrated`. If nothing ran, falls back to `normalizePersistedRecord(record, 7)`.

### 2.6 `migrateState(raw: unknown)` → `PersistedState` (`migrations.ts:150`) — the entry point

- `raw` falsy or non-object → `createSeedState()` (fresh install / corrupt store).
- Reads `schemaVersion` (`typeof number ? value : 0`).
- If `schemaVersion === 7`: returns `normalizePersistedRecord(record, 7)`
  directly. The in-code comment (`:158`–`162`) states the reason: even at the
  current version a corrupt value (e.g. a non-array `personalities` from a
  partial `set`) must be guarded so `reconcileBundledPersonalities` downstream
  cannot throw and "brick every load including the settings UI."
- Otherwise: `applyMigrations(record, schemaVersion)`.
- Doc comment (`:143`) notes the deliberate difference from a sibling codebase:
  it **preserves** existing data during migration instead of wiping to seed
  state; seed state is only produced for null/non-object raw input.

---

## 3. `src/shared/summary-cache.ts`

**Imports:** `constants.ts` (`SUMMARY_CACHE_PREFIX`), `agency-hub.ts`
(`normalizeAgencyHubSummarySyncMetadata`), `model-registry.ts`
(`modelSelectionsEquivalent`), `types.ts`.
**Consumed by:** `storage.ts` (key helpers + `SummaryCacheStore`),
`migrations.ts` (`collectSummaryCacheEntries`),
`background/storage-coordinator.ts` (constructs its own `SummaryCacheStore` with
`afterSet`/`afterRemove` hooks and calls `.update`),
`background/operations.ts`, `background/runtime-api.ts` (grep hits on
`hasAvailableFanSummary` / validity helpers).

### 3.1 Key type & helpers

- `SummaryCacheKey` = template literal type `` `summary:${string}` `` (`:10`).
- `summaryCacheKey(groupId)` → `` `${SUMMARY_CACHE_PREFIX}${groupId}` `` (`:24`).
- `isSummaryCacheKey(key)` → `key.startsWith('summary:')` (`:28`).

`SummaryCacheEntry` shape (`types.ts:86`): required `summary: string`,
`personalityId: string`, `personalityUpdatedAt: number`, `generatedAt: number`;
optional `spendingDataVerified?`, `subscriptionLookupVerified?`, `modelId?`,
`fanAccountId?: string | null`, `agencyHubSync?: AgencyHubSummarySyncMetadata`.

### 3.2 `normalizeSummaryCacheEntry(value)` → `SummaryCacheEntry | null` (`:53`)

The validator/normalizer. Returns `null` unless `value` is an object with a
string `summary`, string `personalityId`, and finite-number `personalityUpdatedAt`
and `generatedAt` (`isFiniteNumber`, `:32`). Then copies optional fields **only
when correctly typed**:

- `spendingDataVerified` / `subscriptionLookupVerified` — only if `boolean`.
- `modelId` — only if `string`.
- `fanAccountId` — only if `string` **or** explicit `null`.
- `agencyHubSync` — routed through `normalizeSummarySyncMetadata` (`:36`), which
  requires a finite `generatedAt` then delegates to
  `normalizeAgencyHubSummarySyncMetadata` (`agency-hub.ts:53`). That function
  defaults missing `state` to `'saved'` and re-normalizes `baseUrl`, so a
  **legacy** metadata shape (no `state`) is upgraded to a
  `FanSummarySyncStatus` with `state: 'saved'`.

### 3.3 Bulk collectors / selectors (all pure, operate on a raw storage object)

- `collectSummaryCacheEntries(storage)` (`:96`) → `Record<SummaryCacheKey, SummaryCacheEntry>`
  of every valid `summary:*` entry. Used by `normalizePersistedRecord`.
- `getInvalidSummaryCacheKeys(storage)` (`:114`) → `summary:*` keys whose value
  fails `normalizeSummaryCacheEntry`. Used by `loadStorageState` to prune corrupt
  entries and by eviction.
- `listSummaryCacheEntries(storage)` (`:122`) → `[key, entry][]` of valid entries.
- `getSummaryCacheEntry(storage, groupId)` (`:131`) → single normalized entry or `null`.
- `getSummaryCacheKeysForPersonality(storage, personalityId)` (`:139`) — filters
  **valid** entries by `entry.personalityId`.
- `getSummaryCacheKeysReferencingPersonality(storage, personalityId)` (`:148`) —
  scans **raw** values (not requiring validity) for `.personalityId === id`.
  Both used together in `deletePersonality` so even malformed entries tied to a
  deleted personality get removed.
- `getOldestSummaryCacheKeys(storage, count)` (`:162`) — valid entries sorted
  ascending by `generatedAt`, first `count`.
- `getSummaryCacheEvictionKeys(storage, count)` (`:172`) — returns `[]` if
  `count <= 0`; else concatenates invalid keys first, then oldest keys, sliced to
  `count`. (Invalid entries are evicted before valid-but-old ones.)

### 3.4 `class SummaryCacheStore` (`:186`)

Constructed with `(storage: SummaryCacheStorageArea, loadState: () => Promise<object>, options)`.
`SummaryCacheStorageArea` (`:12`) is a minimal `get/set/remove` interface
(satisfied by `browser.storage.local`). `options` (`:18`): `evictionCount`,
optional `afterSet(items)`, optional `afterRemove(keys)`.

- `get(groupId)` (`:193`): `storage.get(key)` then normalize; `null` if invalid/absent.
- `save(groupId, entry)` (`:199`): normalizes first — **throws `Error('Invalid
  summary cache entry')`** if invalid. Attempts `setEntry`. On any thrown error
  (e.g. `QUOTA_BYTES` overflow) it recovers: reads the whole area, computes
  `getSummaryCacheEvictionKeys(all, evictionCount)` (10), removes those keys, and
  retries `setEntry` once. A second failure propagates.
- `update(groupId, updater)` (`:220`): reads the current entry via
  `getSummaryCacheEntry(await loadState(), groupId)`; returns `null` if absent;
  applies `updater`, re-normalizes (**throws** if the updater produced an invalid
  entry), writes, returns the new entry. This is the path
  `storage-coordinator.ts:238` uses to patch `agencyHubSync` after a Hub sync.
- `remove(groupId)` (`:239`) → `removeKeys([key])`.
- Private `setEntry` (`:243`): `storage.set({ [key]: entry })` then
  `afterSet?.(items)`.
- Private `removeKeys` (`:252`): no-op on empty; passes a single string when one
  key else the array; then `afterRemove?.(keys)`.

### 3.5 Availability / validity checks

- `isValidSummaryCacheEntry(entry, personalityId, personalityUpdatedAt, modelId)`
  (`:262`, type-guard) — `true` only if all hold: entry exists; matching
  `personalityId`; matching `personalityUpdatedAt`; `modelSelectionsEquivalent(entry.modelId, modelId)`
  (model-registry equivalence, tolerates alias/normalization); **and both**
  `spendingDataVerified === true` and `subscriptionLookupVerified === true`. So a
  summary generated without verified spend/subscription data is treated as not
  reusable.
- `hasAvailableFanSummary(storage: PersistedState, groupId, mappedPersonalityId)`
  (`:278`) — `false` if either id is null, or the mapped personality is not
  found. Else fetches the cache entry and validates it against that personality's
  `id` + `updatedAt` and `storage.settings.featureModels['fan-summary']`.
  This is the gate the UI/operations use to decide a cached summary is fresh
  enough to skip regeneration.

---

## 4. `src/shared/account-aliases.ts`

**Imports:** none (pure). **Consumed by:** `storage.ts`
(`resolveCanonicalAccountId`, `collectAliasKeysForCanonical`), plus
`buildAccountLookupOrder` used by the background context/session layers (grep:
`background/fansly-client.ts`, `conversation-context-loader.ts`, `operations.ts`).

The alias map (`accountAliases`, `Record<legacyId, resolvedId>`) records that a
legacy account id now resolves to a canonical id (written by
`rekeyAccountIdentity`).

- `resolveCanonicalAccountId(aliases, accountId)` → `string | null` (`:1`):
  `null` for falsy input. Follows the alias chain
  (`current → aliases[current]`) until a terminal id (no alias, or self-alias) is
  reached. **Cycle-safe:** a `seen` set breaks loops and returns the **original**
  `accountId` if a cycle is detected (`:15`).
- `buildAccountLookupOrder(aliases, resolvedAccountId, legacyAccountId)` →
  `string[]` (`:29`): de-duplicated, order-preserving list of
  `[canonical(resolved), resolved, canonical(legacy), legacy]`, dropping
  falsy/duplicate entries. Used to try mappings/summaries under multiple ids.
- `collectAliasKeysForCanonical(aliases, canonicalAccountId)` → `string[]`
  (`:52`): every alias key (excluding the canonical id itself) whose chain
  resolves to `canonicalAccountId`. Used by `saveAccountMapping` to clear stale
  mappings under old ids.

---

## 5. `src/shared/concurrency.ts`

**Imports:** none. **Consumed by (grep):** `background/operations.ts`,
`background/spenders-service.ts`, `background/agency-hub-usage-reporter.ts`,
and the Fansly earnings fan-out paths.

`mapWithConcurrency<T,R>(items, limit, fn)` → `Promise<R[]>` (`:1`): bounded
parallel map preserving input order (`results[i]` written by index). Spawns
`workerCount = items.length === 0 ? 0 : Math.max(1, Math.min(limit, items.length))`
workers; each worker pulls the next index from a shared `index++` counter in a
`while (true)` loop (iterative, not recursive — the in-code comment notes this
keeps promise-chain depth flat regardless of `items.length`). Results resolve via
`Promise.all`. Rejections propagate (no per-item error isolation).

---

## 6. `src/shared/errors.ts`

**Imports:** `types.ts` (`ChatGooseErrorDetails`, `UserErrorKey`,
`UserFacingError`). **Consumed by:** background clients and operation
coordinators throughout (`operations.ts`, `compare-operations.ts`, the API
clients, `agency-hub-*`), plus content/options rendering of `UserFacingError`.

### 6.1 `ERROR_REGISTRY` — the full catalog (`errors.ts:15`, re-exported at `:427`)

`Record<UserErrorKey, {key, code, message, description?, settingsLink?}>`. Every
entry, with its stable `code` and user-facing `message`:

| key | code | message | settingsLink |
|---|---|---|---|
| `not_connected` | CG-FAN-01 | Fansly connection not found. | |
| `session_expired` | CG-FAN-02 | Fansly session expired. | |
| `fansly_server_error` | CG-FAN-03 | Fansly request failed. | |
| `missing_api_key` | CG-AUTH-01 | Claude API key not configured. | ✓ |
| `invalid_api_key` | CG-AUTH-02 | Claude API key is invalid. | ✓ |
| `rate_limited` | CG-API-01 | Rate limit reached. | |
| `insufficient_balance` | CG-API-02 | Anthropic balance is insufficient. | |
| `no_personalities` | CG-FLOW-01 | No model personalities are configured. | ✓ |
| `no_mapping` | CG-FLOW-02 | No model personality is assigned for this account. | ✓ |
| `not_enough_history` | CG-FLOW-03 | Not enough conversation history. | |
| `another_operation` | CG-FLOW-04 | Another operation is already running. | |
| `ping_blocked` | CG-FLOW-05 | This fan is still active. | |
| `chat_changed` | CG-FLOW-06 | Conversation changed. | |
| `extension_reloaded` | CG-FLOW-07 | Extension reloaded. | |
| `compare_cards_unavailable` | CG-FLOW-08 | Compare needs at least two model cards. | |
| `hi_too_many_messages` | CG-FLOW-09 | This conversation has too many messages for a greeting. | |
| `network_error` | CG-NET-01 | Network request failed. | |
| `timed_out` | CG-NET-02 | Operation timed out. | |
| `model_unavailable` | CG-API-03 | Selected Claude model is unavailable. | ✓ |
| `context_too_long` | CG-API-04 | Prompt is too large for this model. | |
| `service_unavailable` | CG-API-05 | Anthropic service is unavailable. | |
| `ai_output_unusable` | CG-API-06 | AI reply could not be used. | |
| `hub_invalid_url` | CG-HUB-01 | Agency Hub URL is invalid. | ✓ |
| `hub_missing_api_key` | CG-HUB-02 | Agency Hub API key is missing. | ✓ |
| `hub_invalid_api_key` | CG-HUB-03 | Agency Hub API key is invalid. | ✓ |
| `hub_missing_permission` | CG-HUB-04 | Agency Hub host access is not granted. | ✓ |
| `hub_page_match_failed` | CG-HUB-05 | Agency Hub page mapping failed. | ✓ |
| `hub_timeout` | CG-HUB-06 | Agency Hub request timed out. | |
| `hub_request_failed` | CG-HUB-07 | Agency Hub request failed. | |
| `hub_sync_failed` | CG-HUB-08 | Hub sync failed, summary remains available locally. | |
| `insertion_failed` | CG-UI-01 | Could not insert into the Fansly message box. | |
| `unknown_error` | CG-APP-01 | Something went wrong. | |

Each entry also carries a `description` (guidance string); e.g.
`not_enough_history` states "This feature needs at least 30 messages",
`hi_too_many_messages` states "10 messages or fewer". `ERROR_KEYS` (`:220`) is a
`Set` of the registry keys for membership checks. The `UserErrorKey` union in
`types.ts:555` and this registry must stay in lockstep (registry is typed
`Record<UserErrorKey, …>`, so a missing key is a compile error).

### 6.2 `class ChatGooseError extends Error` (`:230`)

Fields: `key`, `code` (looked up from registry), optional `details`
(`ChatGooseErrorDetails`: `status`, `responseSnippet`, `retryAfterMs`,
`retryAtMs`, `providerMessage`, `provider`), `isOptional` (default `false`),
`retryAtMs`, `retryAfterMs`. **Two constructor overloads** (`:238`–`244`):
positional `(key, message?, details?, isOptional?)` and options-object
`(key, options?)`. The implementation (`:245`) disambiguates: if the second arg
is a string OR `arguments.length > 2`, it treats args positionally; else the
second arg is an options bag. `super(message ?? key)` sets the `Error.message`;
`name = 'ChatGooseError'`. `retryAtMs`/`retryAfterMs` fall back to
`details?.retryAtMs`/`details?.retryAfterMs`.

### 6.3 Type guards & lookups

- `isUserErrorKey(value)` (`:270`) — string ∈ `ERROR_KEYS`.
- `isUserFacingError(value)` (`:274`) — object with a valid `key`, string `code`,
  string `message`.
- `getErrorMessage(key)` → `UserFacingError` (`:284`) — projects a registry entry
  to the wire shape, conditionally including `description` and `settingsLink`.

### 6.4 Construction & conversion helpers

- `createUserError(key, overrides?)` (`:295`) — base from `getErrorMessage`, then
  applies optional `message`/`description`/`retryAtMs`/`retryAfterMs` overrides
  (only when present/number).
- `providerUserErrorOverrides(key, provider)` (`:309`) — **only** when
  `provider === 'openrouter'`, rewrites the copy for `missing_api_key`,
  `invalid_api_key`, `rate_limited`, `insufficient_balance`,
  `service_unavailable`, `model_unavailable` to OpenRouter-specific wording
  ("OpenRouter API key not configured.", etc.). All other providers/keys → `null`
  (Anthropic wording is the default).
- `toUserError(error: unknown)` → `UserFacingError` (`:353`) — the central
  normalizer used to render any thrown thing:
  1. `ChatGooseError` → `createUserError(key, {...providerOverrides, retryAtMs, retryAfterMs})`
     using `error.details?.provider`.
  2. A plain object carrying a valid `key` and string `details.provider` with a
     matching provider override → apply it (+ retry hints).
  3. Already a `UserFacingError` → returned as-is.
  4. Any object with a valid `key` (no provider match) → `createUserError` with
     retry hints and any provider overrides.
  5. Fallback → `getErrorMessage('unknown_error')`.
- `formatUserFacingError(error)` (`:399`) → `"${code}: ${message}"`.
- `getUserErrorDescription(error)` (`:403`) → trimmed `description` or `null`.
- `toDebugErrorPayload(error)` (`:407`) — for debug prompts/logs: for
  `ChatGooseError` emits `{key, code, message, isOptional, retryAtMs?, retryAfterMs?, details?}`;
  for a `UserFacingError` returns it; otherwise returns the error unchanged (may
  leak a raw Error — redaction is `log.ts`'s job at the logging boundary).

---

## 7. `src/shared/log.ts`

**Imports:** `types.ts` (`SessionTemplate`, `Settings`). **Consumed by:**
background operation/coordinator layers and clients wherever a debug trace is
gated on `settings.debugMode`.

- `SENSITIVE_KEY_PATTERNS` (`:3`): lowercased substrings `authorization`,
  `claudeapikey`, `openrouterapikey`, `agencyhubapikey`, `fanslyclient`,
  `fanslysession`. Any object key whose lowercase form **contains** one of these
  is replaced with `'[REDACTED]'`.
- `API_KEY_REGEX` (`:11`): `/(sk-ant-[a-zA-Z0-9_-]+|sk-or-v1-[a-zA-Z0-9_-]+)/g` —
  redacts Anthropic (`sk-ant-…`) and OpenRouter (`sk-or-v1-…`) keys embedded in
  **string values**, wherever they appear.
- `serializeError(error)` (`:13`): `{name, message, stack?}` plus any own
  enumerable properties via `Object.entries(error)` — so a `ChatGooseError`'s
  enumerable `key`/`code`/`details` are captured too.
- `redactValue(value)` (`:30`): recursive. Strings → regex-redacted; `Error` →
  serialize then redact; arrays → map; objects → per-key sensitive-name check
  then recurse; primitives → returned as-is.
- `logDebug(enabled, label, payload?)` (`:59`): **no-op when `enabled` is false**.
  When enabled, `console.debug('[ChatGoose] ' + label)` and, if a payload is
  given, the `redactValue(payload)` result as a second arg.
- `isDebugEnabled(settings)` (`:72`) → `Boolean(settings?.debugMode)`.
- `snapshotSessionForDebug(session)` (`:76`): projects a `SessionTemplate` to a
  fixed field subset (`accountId`, `authorization`, `fanslyClientId`,
  `fanslySessionId`, `latestTs`, `latestCheck`, `routeChecks`, `lastSeenAt`,
  `connected`) or `null`. **Note:** it returns the raw `authorization`/client/
  session ids **unredacted**; redaction only happens if the snapshot is later
  passed through `logDebug` (whose `SENSITIVE_KEY_PATTERNS` match
  `authorization`, `fanslyClientId`→`fanslyclient`, `fanslySessionId`→`fanslysession`).

---

## 8. `src/shared/hotkeys.ts`

**Imports:** `keymap.ts` (`KeyBinding` type), `types.ts` (`FeatureType`).
**Consumed by (grep):** `content/index.ts`, `content/button-bar.ts`,
`content/cheatsheet-controller.ts`, `content/spenders/board-launcher.ts`.

The file header documents the platform rationale: macOS uses `⌘⇧<letter>`
(Cmd+Shift), Windows/Linux uses `Alt+Shift+<letter>`, chosen to avoid
browser-reserved combos and because content scripts cannot `preventDefault`
Ctrl+Shift chrome shortcuts.

- `LabelPlatform` = `'mac' | 'other'`.
- `HotkeyAction` union (`:25`): `fast-reply`, `improve-draft`, `help-me`,
  `hi-greeting`, `ping`, `fan-summary`, `chat-review`, `cycle-tone`, `cancel`,
  `spenders-board`, `cheatsheet`.
- `HOTKEY_FEATURE` (`:39`): `Partial<Record<HotkeyAction, FeatureType>>` mapping
  the seven AI actions 1:1 to `FeatureType`. App actions (`cycle-tone`, `cancel`,
  `spenders-board`, `cheatsheet`) are **absent** (not features).
- `detectLabelPlatform()` (`:49`): regex `/mac|iphone|ipad|ipod/i` on
  `navigator.platform || navigator.userAgent` → `'mac'` else `'other'`. **Reads
  `navigator` (browser API).**
- `modifierCombo(platform)` (`:58`): `'mod+shift'` (mac) or `'alt+shift'`. The
  `mod` token is what the keymap matches against ⌘/Ctrl.
- `comboLabel(letter, platform)` (`:63`): `` `⌘⇧${SHOWN}` `` (mac) or
  `` `Alt+Shift+${SHOWN}` ``. Single letters are upper-cased.

**`AI_HOTKEYS` table (`:75`)** — the source of truth for combos and cheatsheet
rows (letter → action, description):

| letter | action | description |
|---|---|---|
| E | `fast-reply` | Fast Reply |
| F | `improve-draft` | Polish draft (Fix) |
| H | `help-me` | Help Me (coaching) |
| G | `hi-greeting` | Hi — greeting openers |
| D | `ping` | Ping — reactivation message |
| S | `fan-summary` | Scan — deep fan profile |
| V | `chat-review` | Chat review — rate this chat |
| O | `cycle-tone` | Cycle tone (flirty / upsell / horny) |
| X | `cancel` | Cancel running AI operation |
| M | `spenders-board` | Spenders — board of top spenders |

- `buildHotkeyBindings(platform)` → `KeyBinding<HotkeyAction>[]` (`:88`): maps
  `AI_HOTKEYS` to bindings `{action, combo: '<modifier>+<letter>', label, description}`,
  then appends the bare-key `cheatsheet` binding `{combo:'?', label:'?'}`.
- `featureHotkeyLabel(feature, platform)` (`:116`): scans `AI_HOTKEYS` for the
  action whose `HOTKEY_FEATURE` maps to `feature`; returns `{full, short}`
  (`full` = platform combo, `short` = upper-cased bare letter) or `null`. Feeds
  the toolbar button chips so they cannot drift from the live bindings.
- `CHEATSHEET_EXTRAS` (`:129`): two extra rows for keys handled outside the
  keymap — `Enter` ("Insert the next reply part …") and `Esc` ("Dismiss the
  overlay / board / cheatsheet").

Note: `improve-draft` (F) is in `AI_HOTKEYS` and thus gets a binding, even though
its `HOTKEY_FEATURE` mapping exists but it is not model-selectable elsewhere; it
is a normal feature action here.

---

## 9. `src/shared/keymap.ts`

**Imports:** none (DOM-free by design; the header notes this keeps it
unit-testable). **Consumed by:** `content/index.ts` (feeds real
`KeyboardEvent`s), `content/button-bar.ts`, cheatsheet/board controllers, via
`createKeymap(buildHotkeyBindings(...))`.

- `KeyEventLike` (`:9`): normalized event `{key, metaKey, ctrlKey, altKey,
  shiftKey, inEditable}`. `inEditable` = focus is inside input/textarea/select/
  contenteditable (computed by the caller).
- `KeyBinding<A>` (`:19`): `{action, combo, label, description,
  allowInEditable?, hideFromCheatsheet?}`. `combo` grammar examples:
  `'mod+shift+e'`, `'?'`, `'escape'`; `mod` = ⌘ or Ctrl.
- `parseCombo(combo)` (`:39`): lowercases and splits on `+`; last token is the
  `key`; flags `mod`/`shift`/`alt` from token membership.
- `SHIFT_AGNOSTIC = /^[^a-z0-9]$/` (`:52`): single non-alphanumeric keys (e.g.
  `?`) already imply Shift to type the glyph, so the shift flag is **not**
  required to match for them.
- `eventMatchesCombo(ev, combo)` (`:54`): matches when lowercased `ev.key` equals
  parsed key, `ev.metaKey || ev.ctrlKey` equals the `mod` flag, `ev.altKey`
  equals `alt`, and (unless the key is shift-agnostic) `ev.shiftKey` equals
  `shift`.
- `Keymap<A>` (`:65`): `{bindings, resolve(ev) => A | null}`.
- `createKeymap(bindings)` (`:71`): `resolve` returns the **first** matching
  binding's action. **Editable gating:** when `ev.inEditable`, a match still
  fires only if `binding.allowInEditable === true`, OR the combo uses `mod`, OR
  it uses `alt`, OR the key is `escape`; otherwise the match is skipped (so bare
  `?` does nothing while typing, but ⌘⇧/Alt+Shift combos and Escape always fire).

---

## 10. `src/shared/agency-hub.ts`

Pure, DOM-free helpers for the Agency Hub / `core` boundary, shared between the
background client (`background/agency-hub-client.ts`) and the options page. It
holds **no** network code — the wire contract (endpoints, headers, request/
response shapes) is in `boundaries.md` §6. Exports (9):

- **`AGENCY_HUB_PROFILE_MAX_BYTES`** (`= 50_000`) — UTF-8 byte cap enforced on
  both pushed and fetched fan-profile bodies.
- **`normalizeAgencyHubBaseUrl(value)`** (`:9`) → `string`. Trims; parses as
  `URL`; returns `''` unless protocol is `http:`/`https:`; strips trailing
  slashes; yields `origin + path` (empty path when just `/`). The canonical
  form used as the storage/settings value and for all comparisons.
- **`buildAgencyHubOriginPattern(baseUrl)`** (`:28`) → `'<proto>//<hostname>/*'`
  or `null` — the WebExtension optional-permission match pattern for the
  configured host. Used by the background `permissions.contains` gate and by the
  options `permissions.request` flow.
- **`buildAgencyHubUrl(baseUrl, path)`** (`:38`) → `URL` — joins a normalized
  base with a leading-slash-stripped path.
- **`normalizeAgencyHubUsername(value)`** (`:44`) → `string | null` — trims,
  strips leading `@`(s), lowercases; `null` when empty. Used to match the Fansly
  page username against `GET /pages` results (`resolvePageLabel`).
- **`measureUtf8Bytes(text)`** (`:49`) → `number` — `TextEncoder().encode().byteLength`;
  backs the 50 000-byte guard.
- **`normalizeAgencyHubSummarySyncMetadata(metadata)`** (`:53`) →
  `FanSummarySyncStatus | undefined` — coerces the stored `agencyHubSync`
  metadata (including the `LegacyAgencyHubSummarySyncMetadata` variant, whose
  `state` defaults to `'saved'`) into the current `FanSummarySyncStatus` shape,
  normalizing `baseUrl` and copying through `pageLabel`/`syncedAt`/`updatedAt`/`error`.
- **`isAgencyHubSummarySavedForBaseUrl(metadata, baseUrl, generatedAt)`** (`:72`)
  → `boolean` — true when the cached summary's sync metadata is `state: 'saved'`,
  matches `generatedAt`, matches the normalized `baseUrl`, and carries a
  `pageLabel`. Consumed by `background/operations.ts` (≈`:1583`) to decide whether
  a regenerated summary still needs a Hub push.
- **`hasAgencyHubSyncMetadata(metadata, baseUrl, pageLabel, generatedAt)`** (`:88`)
  → `boolean` — stricter variant also requiring an exact `pageLabel` match; used
  by `AgencyHubClient.pushFanProfile` for its `already-synced` idempotency check.

**Consumers:** `background/agency-hub-client.ts` (URL/username/bytes/sync helpers),
`background/operations.ts` (`isAgencyHubSummarySavedForBaseUrl`), `options/*`
(`buildAgencyHubOriginPattern` via `agency-hub-settings.ts`). The `agencyHubSync`
metadata itself lives on `SummaryCacheEntry` (§3) and on the `summary:syncStatus`
Port message.

---

## Cross-file relationships (persistence flow)

1. `loadStorageState` (storage.ts) is the funnel: `browser.storage.local.get(null)`
   → `migrateState` (migrations.ts, which pulls valid summaries via
   `collectSummaryCacheEntries`) → `sanitizeSettings` → `reconcileBundledPersonalities`
   → conditional write-back. Corrupt `summary:*` keys are pruned here via
   `getInvalidSummaryCacheKeys`.
2. Account identity: `rekeyAccountIdentity` writes `accountAliases`;
   `resolveCanonicalAccountId`/`collectAliasKeysForCanonical`/`buildAccountLookupOrder`
   (account-aliases.ts) read it; `saveAccountMapping` stores mappings under the
   canonical id.
3. Summaries: `SummaryCacheStore` (summary-cache.ts) is the only writer of
   `summary:*` keys; `hasAvailableFanSummary` + `isValidSummaryCacheEntry` gate
   reuse (requiring matching personality version/model and both verification
   flags). `agencyHubSync` metadata is normalized on read and patched via
   `.update` after a Hub sync.
4. Errors/log/keymap are orthogonal cross-cutting utilities consumed broadly by
   background/content layers.

## Open questions / discrepancies flagged

- **Migrations are not incremental.** `MIGRATIONS` has a single step to version 7
  (`migrations.ts:115`); there are no per-version transforms. Any older version
  is collapsed straight to 7 by `normalizePersistedRecord`. The only historical
  field rewrites are inside `migrateSettingsRecord` (`anthropicApiKey` →
  `claudeApiKey`; `pingMessageCount` ← `quickMessageCount` fallback). If the
  reviewer expects a numbered ladder of migration steps for versions 1–6, it does
  not exist.
- **`snapshotSessionForDebug` returns secrets unredacted.** It copies raw
  `authorization`/`fanslyClientId`/`fanslySessionId`. Safety depends on the
  snapshot always being routed through `logDebug`/`redactValue` before display;
  `snapshotSessionForDebug` alone provides no redaction (`log.ts:76`).
- **`toDebugErrorPayload` may return a raw `Error`** (fallback branch,
  `errors.ts:424`) without redaction; redaction is applied only if the payload
  later passes through `log.ts`.
- **`loadStorageState` is a read with write side-effects** (rewrites full state on
  schema mismatch or personality reconciliation, and prunes invalid summary keys)
  — callers treating it as read-only should be aware.
- **`promptCachingEnabled` default is `true`.** `sanitizeSettings`
  (`Boolean(input.promptCachingEnabled ?? true)`) preserves an explicit stored
  `false`, but a missing value resolves to `true`.
