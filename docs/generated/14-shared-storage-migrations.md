> Generated 2026-07-07 from docs/project-kernel/prompt-1-map.md at commit 1586f07.
> Machine-generated reference — regenerate by re-running that prompt in a
> fresh session; do not hand-edit.

# 14 — Shared storage, migrations, and the summary cache

The ChatGoose Firefox extension persists all of its long-lived state in a single
`browser.storage.local` area. There is no use of `storage.sync` or
`storage.session` anywhere in `src/` (verified: the only storage areas referenced
are `browser.storage.local`). This document enumerates every persisted key, the
`Settings` shape, the migration mechanism (and the ACTUAL current schema version),
the per-fan summary cache, and the credential custody class of this store.

## Schema version — the actual number

`STORAGE_SCHEMA_VERSION` is defined as **`10`** in
`src/shared/constants.ts:10`.

This differs from prose that calls the extension "currently v9": the code's own
comments and tests refer to historical versions as labels — `src/shared/migrations.ts:39`
comments "Stage 32 (v9)", `tests/storage-migration.test.ts:338` is titled
"Stage 32 (v9): drops vendor keys", and `tests/storage-migration.test.ts:136`
references "pre-v8" and "v8" records — but the live constant that every write
stamps is `10` (`src/shared/migrations.ts:28`, `src/shared/storage.ts:67`,
`src/shared/migrations.ts:144`). Those intermediate version numbers (pre-v8, v8,
v9) exist only as comment/test labels; they are NOT discrete registered migration
steps in code (see "The migration mechanism" below).

## storage.local key inventory

`browser.storage.local` holds two categories of top-level keys: the migrated
`PersistedState` fields, and independently-managed keys that migration never
touches.

### Migrated `PersistedState` fields

Shape defined at `src/shared/types.ts:101-108`; seeded by `createSeedState`
(`src/shared/migrations.ts:26-35`).

| Key | Type | Meaning | Anchor |
|---|---|---|---|
| `schemaVersion` | `number` | Stamped schema version; current value `10` | `src/shared/types.ts:102`, `src/shared/migrations.ts:28` |
| `settings` | `Settings` | The settings record (see next section) | `src/shared/types.ts:103` |
| `personalities` | `Personality[]` | Saved personalities (`{id,name,content,updatedAt,builtin?,builtinVersion?}`, `src/shared/types.ts:34-41`); bundled Lora is reconciled in on load | `src/shared/types.ts:104` |
| `accountMappings` | `Record<string,string>` | canonical accountId → personalityId | `src/shared/types.ts:105` |
| `accountAliases` | `Record<string,string>` | legacy accountId → resolved (canonical) accountId | `src/shared/types.ts:106` |
| `knownAccounts` | `string[]` | Sorted list of known account ids; key literal is `KNOWN_ACCOUNTS_KEY = 'knownAccounts'` (`src/shared/constants.ts:12`) | `src/shared/types.ts:107` |

### Dynamic summary-cache keys

| Key pattern | Type | Meaning | Anchor |
|---|---|---|---|
| `summary:<groupId>` | `SummaryCacheEntry` | One per fan/conversation; prefix `SUMMARY_CACHE_PREFIX = 'summary:'` (`src/shared/constants.ts:11`) | `src/shared/summary-cache.ts:9,23-25` |

These are stored flat at the top level of `storage.local` (not nested inside
`settings`), keyed by the Fansly messaging group id. They are covered in detail
in the "Summary cache" section.

### Independently-managed keys (NOT part of `PersistedState`, not migrated)

Written by the Stage 32 acceptance-telemetry spool
(`src/background/acceptance-reporter.ts`), which uses its own storage helper and
is never processed by `migrateState`/`normalizePersistedRecord`:

| Key | Type | Meaning | Anchor |
|---|---|---|---|
| `acceptanceSpool` | `SpooledEvent[]` | Bounded (cap 300, drop-oldest) queue of `ai_acceptance` events awaiting hub delivery | `src/background/acceptance-reporter.ts:18,20` |
| `acceptanceSpoolDropped` | `number` | Lifetime count of events dropped on overflow (keeps the gap visible) | `src/background/acceptance-reporter.ts:19,192-193` |

These two survive `loadStorageState`'s writeback because
`browser.storage.local.set(state)` (`src/shared/storage.ts:70`) merges keys
rather than replacing the whole area — the migrated `PersistedState` does not
enumerate them, so they are neither carried into the in-memory state nor deleted.

### UI-refresh trigger set

The background page treats only a subset of keys as UI-relevant: a change to
`settings`, `personalities`, `accountMappings`, `accountAliases`, `knownAccounts`,
or `schemaVersion` triggers a tab refresh (`src/background/index.ts:69-85`).
Changes to `summary:*` or the acceptance-spool keys do not.

## `Settings` shape and `createDefaultSettings`

`Settings` is defined at `src/shared/types.ts:16-32`. The default record is
produced by `createDefaultSettings` (`src/shared/migrations.ts:11-24`):

| Field | Default | Notes | Anchor |
|---|---|---|---|
| `agencyHubBaseUrl` | `''` | Kernel/hub base URL (normalized on sanitize) | `src/shared/migrations.ts:13` |
| `agencyHubApiKey` | `''` | Legacy chatter key (custody: see last section) | `src/shared/migrations.ts:14` |
| `agencyHubDeviceToken` | `''` | Stage 32 device-bound bearer (`agency_hub_device_…`, sliding 90 d); preferred over `agencyHubApiKey` | `src/shared/types.ts:19-21`, `src/shared/migrations.ts:15` |
| `spendersLegacyRebuild` | `false` | HIDDEN one-release fallback flag (no UI; forces the legacy per-fan earnings sweep) | `src/shared/types.ts:22-25`, `src/shared/migrations.ts:16` |
| `quickMessageCount` | `100` (`QUICK_DEFAULT_MESSAGE_COUNT`) | Clamped to [5, 200] | `src/shared/constants.ts:54-56` |
| `pingMessageCount` | `100` (`PING_DEFAULT_MESSAGE_COUNT` = quick default) | Clamped to [5, 200] | `src/shared/constants.ts:57-59` |
| `improveMessageCount` | `25` (`IMPROVE_DEFAULT_MESSAGE_COUNT`) | Clamped to [5, 200] | `src/shared/constants.ts:60-62` |
| `deepMessageCount` | `1500` (`DEEP_DEFAULT_MESSAGE_COUNT`) | Clamped to [100, 3000] | `src/shared/constants.ts:63-65` |
| `debugMode` | `false` | — | `src/shared/migrations.ts:21` |
| `promptCachingEnabled` | `true` | Legacy records missing it default to `true` | `src/shared/migrations.ts:22`, `tests/storage-migration.test.ts:322-327` |

### `createDefaultSettings` vs `DEFAULT_SETTINGS`

There are two separate definitions of the same defaults:
- `createDefaultSettings()` (`src/shared/migrations.ts:11-24`) — the LIVE one used
  by migration (`src/shared/migrations.ts:38`), `sanitizeSettings`
  (`src/shared/storage.ts:77`), and `createSeedState`.
- `DEFAULT_SETTINGS` (`src/shared/constants.ts:135-146`) — an exported constant
  with byte-identical field values.

They are maintained in parallel and produce the same shape; migration/storage code
paths use `createDefaultSettings()`, not the constant.

### `sanitizeSettings`

`sanitizeSettings` (`src/shared/storage.ts:76-108`) is the write-time guard applied
by `loadStorageState` and `saveSettings`:
- `agencyHubBaseUrl` → `normalizeAgencyHubBaseUrl` (trims, requires http/https,
  strips trailing slashes; invalid → `''`) (`src/shared/agency-hub.ts:9-26`).
- `agencyHubApiKey` and `agencyHubDeviceToken` → `String(...).trim()`.
- The four message counts → `Number(...)`, non-finite falls back to the default,
  then clamped between the per-feature MIN/MAX constants.
- `spendersLegacyRebuild`, `debugMode`, `promptCachingEnabled` → `Boolean(...)`.

## The migration mechanism

Entry point: `migrateState(raw)` (`src/shared/migrations.ts:136-154`).

Despite the "forward-only numbered chain" framing, the ACTUAL implementation is a
single collapse-to-current normalize pass, not a per-version incremental chain:

- **`MIGRATIONS`** (`src/shared/migrations.ts:101-107`) is an array with exactly
  ONE `MigrationStep`, whose `toVersion` is `STORAGE_SCHEMA_VERSION` (10) and whose
  `migrate` calls `normalizePersistedRecord(record, 10)`. A test pins this:
  `MIGRATIONS.map(m => m.toVersion)` must equal `[STORAGE_SCHEMA_VERSION]`
  (`tests/storage-migration.test.ts:58-62`).
- The `MigrationStep` interface (`toVersion` + `migrate`,
  `src/shared/migrations.ts:67-70`) and `applyMigrations`
  (`src/shared/migrations.ts:109-127`) are built to support a multi-step chain
  (each step applied when `schemaVersion < step.toVersion`), but only the single
  terminal step is registered. So any stored version below 10 is normalized to 10
  in one pass; there is no v0→v1→…→v10 walk.

Control flow of `migrateState`:
1. `null`/non-object raw → `createSeedState()` (fresh install)
   (`src/shared/migrations.ts:137-139`, `tests/storage-migration.test.ts:64-77`).
2. Stored `schemaVersion === 10` → `normalizePersistedRecord(record, 10)` — a
   guard pass (re-coerces corrupt `personalities`/`accountMappings` etc. even at
   the current version, preventing a bricked load) (`src/shared/migrations.ts:144-150`,
   `tests/storage-migration.test.ts:96-108`).
3. Otherwise (older/absent version) → `applyMigrations(record, schemaVersion)`
   (`src/shared/migrations.ts:152-153`).

The migration is **data-preserving**: it fills defaults for missing fields but
does not wipe existing data to seed state — the only wipe path is the
null/non-object branch (comment `src/shared/migrations.ts:129-135`,
`tests/storage-migration.test.ts:110-125`).

### What actually changes across versions (all inside the single pass)

`normalizePersistedRecord` (`src/shared/migrations.ts:72-99`) rebuilds each field
with a guard, and:
- Delegates settings to `migrateSettingsRecord`
  (`src/shared/migrations.ts:37-63`), which is where the observable per-version
  field transforms live:
  - **Stage 32 ("v9") vendor-key drop:** old fields `claudeApiKey`,
    `openRouterApiKey`, `featureModels`, `featureReasoning` are simply not read,
    so they fall away (comment `src/shared/migrations.ts:39-40`,
    `tests/storage-migration.test.ts:338-356`).
  - **`agencyHubDeviceToken` default:** absent in pre-"v8" records → defaults to
    `''`, and a stored token survives re-migration byte-for-byte (idempotent)
    (`tests/storage-migration.test.ts:136-153`).
  - **`pingMessageCount` seeding:** when missing, it is seeded from
    `quickMessageCount` (`raw?.pingMessageCount ?? raw?.quickMessageCount ?? default`,
    `src/shared/migrations.ts:55`; `tests/storage-migration.test.ts:155-168`).
- Guards `personalities`/`accountMappings`/`accountAliases`/`knownAccounts`,
  substituting seed defaults (`[]` / `{}`) for non-array/non-object values
  (`tests/storage-migration.test.ts:259-267`).
- Spreads `...collectSummaryCacheEntries(record)` (`src/shared/migrations.ts:97`)
  so that valid `summary:*` keys are carried forward and corrupt ones are dropped
  during migration (`tests/storage-migration.test.ts:173-198`).

### Persistence after load

`loadStorageState` (`src/shared/storage.ts:50-74`) runs `migrateState`, then
`sanitizeSettings`, then `reconcileBundledPersonalities`. It writes the migrated
state back (`browser.storage.local.set(state)`) only when the stored
`schemaVersion` differs from `10` OR bundled personalities changed
(`src/shared/storage.ts:66-71`). Separately, it removes any invalid `summary:*`
keys detected by `getInvalidSummaryCacheKeys` before returning
(`src/shared/storage.ts:52,61-65`).

## Summary cache (`src/shared/summary-cache.ts`)

Per-fan generated summaries, cached flat in `storage.local`.

### Key scheme and entry shape

- Key: `summaryCacheKey(groupId) = `${SUMMARY_CACHE_PREFIX}${groupId}`` →
  `summary:<groupId>` (`src/shared/summary-cache.ts:23-25`); `isSummaryCacheKey`
  matches any key with the `summary:` prefix (`src/shared/summary-cache.ts:27-29`).
- `groupId` is the Fansly messaging group id (the conversation).
- `SummaryCacheEntry` (`src/shared/types.ts:89-99`): required `summary`,
  `personalityId`, `personalityUpdatedAt`, `generatedAt`; optional
  `spendingDataVerified`, `subscriptionLookupVerified`, `modelId`,
  `fanAccountId` (`string | null`), `agencyHubSync`.
- `normalizeSummaryCacheEntry` (`src/shared/summary-cache.ts:52-93`) is the
  boundary validator: it requires `summary` and `personalityId` to be strings and
  `personalityUpdatedAt`/`generatedAt` to be finite numbers, else returns `null`;
  optional fields are copied only when present and correctly typed.

### Eviction

- `SUMMARY_EVICTION_COUNT = 10` (`src/shared/constants.ts:13`).
- `SummaryCacheStore.save` (`src/shared/summary-cache.ts:198-217`) first attempts
  the write; on ANY thrown error (e.g. quota) it computes eviction keys via
  `getSummaryCacheEvictionKeys(all, 10)`, removes them, and retries the write once.
- `getSummaryCacheEvictionKeys` (`src/shared/summary-cache.ts:171-183`) returns
  invalid/corrupt keys FIRST, then the oldest valid entries by `generatedAt`
  ascending (`getOldestSummaryCacheKeys`, `src/shared/summary-cache.ts:161-169`),
  sliced to `count`. Tests confirm corrupt entries are evicted ahead of valid ones
  and that a retry can free space by dropping a corrupt raw entry
  (`tests/summary-cache.test.ts:86-97,144-185`).

### Cache-validity pin

- `isValidSummaryCacheEntry` (`src/shared/summary-cache.ts:261-275`) requires the
  entry's `personalityId` and `personalityUpdatedAt` to match, `modelId` (or
  `null`) to match, and BOTH `spendingDataVerified === true` and
  `subscriptionLookupVerified === true`.
- `hasAvailableFanSummary` (`src/shared/summary-cache.ts:277-302`) pins `modelId`
  to the sentinel string `'kernel'` (Stage 32: models are kernel-side config).
  Pre-cutover entries pinned to vendor model ids therefore invalidate once
  (`tests/summary-cache.test.ts:14-33`).

### Sync-metadata state machine (`agencyHubSync`)

- States: `FanSummarySyncState = 'not-set-up' | 'saving' | 'saved' | 'failed'`
  (`src/shared/types.ts:53-57`).
- `FanSummarySyncStatus` (`src/shared/types.ts:59-67`): `{state, generatedAt,
  baseUrl?, pageLabel?, syncedAt?, updatedAt?, error?}`. A separate legacy shape
  `LegacyAgencyHubSummarySyncMetadata` (`src/shared/types.ts:69-76`) has no
  `state`; `AgencyHubSummarySyncMetadata` is the union of the two
  (`src/shared/types.ts:78-80`).
- `normalizeAgencyHubSummarySyncMetadata` (`src/shared/agency-hub.ts:53-70`)
  defaults a missing `state` to `'saved'` — i.e. legacy success-only metadata is
  interpreted as `saved` (`tests/storage-migration.test.ts:227-257`).
- `normalizeSummarySyncMetadata` inside the cache
  (`src/shared/summary-cache.ts:35-50`) only accepts metadata whose `generatedAt`
  is a finite number, else drops it.

### Store class and the background mirror

- `SummaryCacheStore` (`src/shared/summary-cache.ts:185-259`) wraps a storage area
  with `get`/`save`/`update`/`remove` and optional `afterSet`/`afterRemove` hooks.
- The shared module builds a fresh store per call against `browser.storage.local`
  (`src/shared/storage.ts:37-43`, exposed via `getSummaryCache`/`saveSummaryCache`/
  `removeSummaryCache`, `src/shared/storage.ts:270-280`).
- `StorageCoordinator` (`src/background/storage-coordinator.ts:36-268`) is the
  background-page mirror: it holds one in-memory `PersistedState`, hydrates it once
  via `loadStorageState`, and keeps it in sync by re-running
  `migrateState`+`sanitizeSettings` on every `storage.onChanged` patch
  (`applyRawStoragePatch`, `src/background/storage-coordinator.ts:18-34,77-100`).
  Its own `SummaryCacheStore` (`src/background/storage-coordinator.ts:40-52`) uses
  `afterSet`/`afterRemove` hooks to fold each cache write into the mirror.

## Custody class of this storage

`storage.local` is an unencrypted, extension-scoped store, and it is where this
extension's hub credentials live:

- The **legacy chatter key** (`agencyHubApiKey`) and the **Stage 32 device token**
  (`agencyHubDeviceToken`, a device-bound bearer `agency_hub_device_…`, sliding
  90 days) both sit in the `settings` record — the SAME `storage.local` custody
  class (comment `src/background/device-token.ts:1-7`).
- `resolveHubBearer` (`src/background/agency-hub-client.ts:56-61`) prefers the
  trimmed device token and falls back to the legacy API key.
- The **acceptance spool** (`acceptanceSpool` + `acceptanceSpoolDropped`) also
  lives in `storage.local` and is explicitly documented as "recoverable signal,
  not custody-grade audit" — bounded drop-oldest with a visible dropped counter
  (`src/background/acceptance-reporter.ts:6-10`, `src/background/index.ts:31-32`).

No secret in this store is encrypted at rest by the extension; both hub
credentials and the summary cache (which may contain fan-derived text) are held in
plaintext in the extension's local storage.
