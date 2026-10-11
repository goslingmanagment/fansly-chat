import {
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  COACH_HISTORY_LIMIT_DEFAULT,
  DEFAULT_AGENCY_HUB_BASE_URL,
  DEEP_DEFAULT_MESSAGE_COUNT,
  IMPROVE_DEFAULT_MESSAGE_COUNT,
  PING_DEFAULT_MESSAGE_COUNT,
  QUICK_DEFAULT_MESSAGE_COUNT,
  STORAGE_SCHEMA_VERSION,
} from './constants.js';
import {
  FOLLOW_SOUND_TONE_DEFAULT,
  MESSAGE_SOUND_TONE_DEFAULT,
  MESSAGE_SOUND_VOLUME_DEFAULT,
  normalizeMessageSoundTone,
  normalizeMessageSoundVolume,
  normalizeMutedAccountIds,
} from './message-sound.js';
import { collectSummaryCacheEntries } from './summary-cache.js';
import {
  normalizePersonaCatalog,
  personaCatalogSource,
} from './persona-catalog.js';
import type { PersistedState, Settings } from './types.js';

export function createDefaultSettings(): Settings {
  return {
    agencyHubBaseUrl: DEFAULT_AGENCY_HUB_BASE_URL,
    agencyHubDeviceToken: '',
    quickMessageCount: QUICK_DEFAULT_MESSAGE_COUNT,
    pingMessageCount: PING_DEFAULT_MESSAGE_COUNT,
    improveMessageCount: IMPROVE_DEFAULT_MESSAGE_COUNT,
    deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT,
    debugMode: false,
    promptCachingEnabled: true,
    uiTheme: 'system',
    showToolbarHints: true,
    coachHistoryLimit: COACH_HISTORY_LIMIT_DEFAULT,
    coachAutoRecap: 'off',
    messageSoundEnabled: true,
    messageSoundTone: MESSAGE_SOUND_TONE_DEFAULT,
    messageSoundVolume: MESSAGE_SOUND_VOLUME_DEFAULT,
    messageSoundMutedAccountIds: [],
    followSoundEnabled: true,
    followSoundTone: FOLLOW_SOUND_TONE_DEFAULT,
    fanslyViaTab: false,
  };
}

export function createSeedState(): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: createDefaultSettings(),
    personalities: [],
    personaCatalog: [],
    personaCatalogSource: null,
    personaCatalogFetchedAt: null,
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
  };
}

interface SecretCustody {
  deviceToken: unknown;
}

function migrateSettingsRecord(
  raw: Record<string, unknown> | null | undefined,
  custody: SecretCustody,
): Settings {
  const defaults = createDefaultSettings();
  // Stage 32 (v9): vendor keys and model/reasoning selections are DROPPED —
  // AI rides the kernel; models are kernel config. Old fields fall away here.
  // 1.7.0 (v11): spendersLegacyRebuild DROPPED — the legacy board rebuild is
  // deleted; the kernel query is the only ranking source.
  // 1.8.0 (v12): uiTheme ADDED (system | light | dark) — the family restyle
  // ships switchable light/dark; pre-v12 installs default to 'system'.
  // 1.8.1 (v13, A41/I116-4): hub credentials MOVED to their own top-level
  // storage keys. Hydration precedence: the custody key wins whenever it is
  // a string (post-migration truth — a stale v12-shaped settings blob must
  // never resurrect an old token); the blob value is the one-release
  // fallback read for pre-v13 data.
  // (v14): personaCatalog top-level fields ADDED — no SETTINGS-shape change,
  // so this per-field normalizer was untouched by it.
  // v15 (Coach): coachHistoryLimit + coachAutoRecap ADDED; the deep-window
  // default also rose 1500 → 3000 — but that bump is a RAW pre-normalization
  // transform (bumpLegacyDeepMessageCountDefault, keyed on the incoming
  // record's version) so a user-modified value survives; here we only default
  // the two new fields.
  // v16: showToolbarHints ADDED, default-on so upgrading keeps the explanatory
  // layer until the chatter explicitly disables it in «Вид».
  // v17 (E123): agencyHubApiKey REMOVED — field, custody slot, blob fallback and
  // storage key. agencyHubBaseUrl gains a real default; an empty stored address
  // adopts it. The device-token blob fallback below STAYS: the feed serves only
  // the newest build, so a ≤1.8.0 install (pre-v13) jumps straight to v17 and
  // would lose a working sign-in without it. The dedicated custody slot always
  // beats the blob.
  // v18 (E145): messageSound* ADDED — the incoming-message sound. On by default
  // (desktop parity: the chatters asked for it), desktop tone and loudness, no
  // model muted.
  // v19 (E146): followSound* ADDED — a sound for a new follower, its own switch
  // (on, like the message sound) and tone (`double`, to tell it apart). Five
  // Fansly tones join; the message default becomes `chime` (a v18 `blip` is
  // re-defaulted by adoptFanslyMessageToneDefault before this normalizer).
  // v20 (E149): fanslyViaTab ADDED — «Fansly через вкладку», off for everyone:
  // the request route changes only where a chatter switches it on.
  return {
    // v17: an EMPTY address is the pre-E123 default nobody chose — the fleet has
    // one hub, so it is filled in rather than left blank for the chatter to
    // type. A non-empty stored address is a deliberate choice and survives.
    agencyHubBaseUrl:
      typeof raw?.agencyHubBaseUrl === 'string' && raw.agencyHubBaseUrl.trim()
        ? raw.agencyHubBaseUrl
        : defaults.agencyHubBaseUrl,
    agencyHubDeviceToken:
      typeof custody.deviceToken === 'string'
        ? custody.deviceToken
        : typeof raw?.agencyHubDeviceToken === 'string'
          ? raw.agencyHubDeviceToken
          : defaults.agencyHubDeviceToken,
    quickMessageCount: Number(raw?.quickMessageCount ?? defaults.quickMessageCount),
    pingMessageCount: Number(raw?.pingMessageCount ?? raw?.quickMessageCount ?? defaults.pingMessageCount),
    improveMessageCount: Number(raw?.improveMessageCount ?? defaults.improveMessageCount),
    deepMessageCount: Number(raw?.deepMessageCount ?? defaults.deepMessageCount),
    debugMode: Boolean(raw?.debugMode ?? defaults.debugMode),
    promptCachingEnabled: Boolean(
      raw?.promptCachingEnabled ?? defaults.promptCachingEnabled,
    ),
    uiTheme:
      raw?.uiTheme === 'light' || raw?.uiTheme === 'dark' || raw?.uiTheme === 'system'
        ? raw.uiTheme
        : defaults.uiTheme,
    showToolbarHints: Boolean(raw?.showToolbarHints ?? defaults.showToolbarHints),
    coachHistoryLimit: Number(raw?.coachHistoryLimit ?? defaults.coachHistoryLimit),
    coachAutoRecap:
      raw?.coachAutoRecap === 'short' ||
      raw?.coachAutoRecap === 'full' ||
      raw?.coachAutoRecap === 'off'
        ? raw.coachAutoRecap
        : defaults.coachAutoRecap,
    messageSoundEnabled: Boolean(raw?.messageSoundEnabled ?? defaults.messageSoundEnabled),
    messageSoundTone: normalizeMessageSoundTone(raw?.messageSoundTone),
    messageSoundVolume: normalizeMessageSoundVolume(raw?.messageSoundVolume ?? defaults.messageSoundVolume),
    messageSoundMutedAccountIds: normalizeMutedAccountIds(raw?.messageSoundMutedAccountIds),
    followSoundEnabled: Boolean(raw?.followSoundEnabled ?? defaults.followSoundEnabled),
    followSoundTone: normalizeMessageSoundTone(raw?.followSoundTone, defaults.followSoundTone),
    fanslyViaTab: raw?.fanslyViaTab === true,
  };
}

type MigrationRecord = Record<string, unknown>;

/** The deep-window default before v15. A pre-v15 install still sitting on this
 * exact value never chose it — it is the old default — so v15 silently adopts
 * the new one. Any other stored value (including a deliberate 1499) is the
 * chatter's and is preserved. */
const PRE_V15_DEEP_MESSAGE_COUNT_DEFAULT = 1500;

/**
 * The schema version at which the deep-window default rose 1500 → 3000. The
 * legacy bump is anchored HERE as a FIXED historical constant, NOT to
 * STORAGE_SCHEMA_VERSION. It must fire only for records that genuinely PREDATE
 * v15 (their stored 1500 is the old default they never chose). A record at v15
 * or beyond that still reads exactly 1500 chose it deliberately, and a LATER
 * schema bump must never silently re-adopt the new default on top of that choice
 * (E45). Guarding against the moving STORAGE_SCHEMA_VERSION was the bug: at v16 a
 * v15 record with a deliberate 1500 passed `15 < 16` and got clobbered.
 */
export const DEEP_DEFAULT_BUMP_SCHEMA_VERSION = 15;

/**
 * v15 RAW transform: run on the incoming settings blob BEFORE field
 * normalization, and ONLY when the record predates v15
 * (DEEP_DEFAULT_BUMP_SCHEMA_VERSION). A record at v15 or beyond must never re-run
 * this — otherwise a chatter who deliberately set 1500 AFTER v15 would be
 * silently bumped on a later schema migration. Keyed on the INCOMING record's
 * schemaVersion against a FIXED anchor, not the moving migration target.
 * Exported so the anchor's refusal (incomingSchemaVersion ≥ 15) is unit-tested
 * directly, independent of the current STORAGE_SCHEMA_VERSION.
 */
export function bumpLegacyDeepMessageCountDefault(
  rawSettings: Record<string, unknown>,
  incomingSchemaVersion: number,
): Record<string, unknown> {
  if (incomingSchemaVersion >= DEEP_DEFAULT_BUMP_SCHEMA_VERSION) {
    return rawSettings;
  }
  if (rawSettings.deepMessageCount !== PRE_V15_DEEP_MESSAGE_COUNT_DEFAULT) {
    return rawSettings;
  }
  return { ...rawSettings, deepMessageCount: DEEP_DEFAULT_MESSAGE_COUNT };
}

/**
 * v19 (E146) RAW transform. 2.7.0 (v18) stored the OnlyFans app's `blip` as
 * every install's message tone — the default nobody chose, released hours
 * earlier — and a chatter working both clients could not tell which one rang.
 * A v18 record still on `blip` adopts Fansly's own default; a v19+ `blip` is a
 * deliberate choice and stays. Anchored on the FIXED version, like the v15 bump.
 */
export const FANSLY_TONE_DEFAULT_SCHEMA_VERSION = 18;

export function adoptFanslyMessageToneDefault(
  rawSettings: Record<string, unknown>,
  incomingSchemaVersion: number,
): Record<string, unknown> {
  if (incomingSchemaVersion !== FANSLY_TONE_DEFAULT_SCHEMA_VERSION) return rawSettings;
  let next = rawSettings;
  if (next.messageSoundTone === 'blip') {
    const { messageSoundTone: _desktopDefault, ...rest } = next;
    next = rest;
  }
  // In 2.7.0 «Звук входящих» was the ONLY sound switch: «off» meant «no
  // sounds», so the new follower sound starts off for that chatter too.
  if (next.messageSoundEnabled === false && next.followSoundEnabled === undefined) {
    next = { ...next, followSoundEnabled: false };
  }
  return next;
}

export class UnsupportedFutureStorageSchemaError extends Error {
  constructor(readonly storedVersion: number) {
    super(
      `Storage schema ${storedVersion} is newer than this extension supports (${STORAGE_SCHEMA_VERSION})`,
    );
    this.name = 'UnsupportedFutureStorageSchemaError';
  }
}

/** The persisted `settings` blob (v13+): everything EXCEPT the credentials,
 * which live in their own storage keys (per-key custody, A41/I116-4). */
export function stripSecretSettings(
  settings: Settings,
): Omit<Settings, 'agencyHubDeviceToken'> {
  const { agencyHubDeviceToken: _deviceToken, ...persisted } = settings;
  return persisted;
}

/** In-memory PersistedState → the v13 storage.local layout: credentials as
 * their own keys, settings blob stripped of them. Every full-state persist
 * MUST go through this — writing the in-memory shape verbatim would put
 * secrets back into the blob and reopen the RMW clobber. */
export function serializePersistedState(
  state: PersistedState,
): Record<string, unknown> {
  return {
    ...state,
    settings: stripSecretSettings(state.settings),
    [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: state.settings.agencyHubDeviceToken,
  };
}

export interface MigrationStep {
  toVersion: number;
  migrate: (record: MigrationRecord) => MigrationRecord;
}

function normalizePersistedRecord(
  record: MigrationRecord,
  schemaVersion: number,
): PersistedState {
  const defaults = createSeedState();
  const custody: SecretCustody = {
    deviceToken: record[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY],
  };
  // The RAW deep-window bump keys on the record's OWN version, not the target:
  // a record already at the current schema (or written by a future build) must
  // not re-run it. `normalizePersistedRecord` is called both for current-schema
  // records (schemaVersion === STORAGE_SCHEMA_VERSION here) and for older ones
  // migrating up, so we read the incoming version off the record itself.
  const incomingSchemaVersion =
    typeof record.schemaVersion === 'number' ? record.schemaVersion : 0;
  const rawSettings =
    record.settings && typeof record.settings === 'object'
      ? adoptFanslyMessageToneDefault(
          bumpLegacyDeepMessageCountDefault(
            record.settings as Record<string, unknown>,
            incomingSchemaVersion,
          ),
          incomingSchemaVersion,
        )
      : null;
  const settings = rawSettings
    ? migrateSettingsRecord(rawSettings, custody)
    : migrateSettingsRecord(null, custody);

  const personalities = Array.isArray(record.personalities) ? record.personalities : defaults.personalities;
  const storedPersonaCatalogSource = typeof record.personaCatalogSource === 'string'
    ? record.personaCatalogSource
    : null;
  // Catalog bytes are capability-scoped to the exact normalized Hub origin
  // and credential. Hide them synchronously when settings/custody change;
  // the queued controller refresh may still be behind a hung request from the
  // old source, or the worker may crash before it gets a chance to clear disk.
  const catalogSourceMatches = storedPersonaCatalogSource === personaCatalogSource(settings);
  const personaCatalog = catalogSourceMatches
    ? normalizePersonaCatalog(record.personaCatalog)
    : [];
  const personaCatalogFetchedAt = catalogSourceMatches &&
    typeof record.personaCatalogFetchedAt === 'string'
    ? record.personaCatalogFetchedAt
    : null;
  const accountMappings = record.accountMappings && typeof record.accountMappings === 'object'
    ? (record.accountMappings as Record<string, string>)
    : defaults.accountMappings;
  const accountAliases = record.accountAliases && typeof record.accountAliases === 'object'
    ? (record.accountAliases as Record<string, string>)
    : defaults.accountAliases;
  const knownAccounts = Array.isArray(record.knownAccounts) ? record.knownAccounts : defaults.knownAccounts;

  return {
    schemaVersion,
    settings,
    personalities: personalities as PersistedState['personalities'],
    personaCatalog,
    personaCatalogSource: storedPersonaCatalogSource,
    personaCatalogFetchedAt,
    accountMappings,
    accountAliases,
    knownAccounts: knownAccounts as string[],
    ...collectSummaryCacheEntries(record),
  };
}

export const MIGRATIONS: readonly MigrationStep[] = [
  {
    toVersion: STORAGE_SCHEMA_VERSION,
    migrate: (record) =>
      normalizePersistedRecord(record, STORAGE_SCHEMA_VERSION) as unknown as MigrationRecord,
  },
];

function applyMigrations(
  record: MigrationRecord,
  schemaVersion: number,
): PersistedState {
  let state: MigrationRecord = record;
  let migrated = false;

  for (const migration of MIGRATIONS) {
    if (schemaVersion >= migration.toVersion) {
      continue;
    }
    state = migration.migrate(state);
    migrated = true;
  }

  return migrated
    ? state as unknown as PersistedState
    : normalizePersistedRecord(record, STORAGE_SCHEMA_VERSION);
}

/**
 * Migrate raw storage data to the current schema.
 *
 * Key difference from Codex: preserves existing data during migration
 * instead of wiping to seed state. Only creates seed state when raw
 * data is null/undefined/not-object.
 */
export function migrateState(raw: unknown): PersistedState {
  if (!raw || typeof raw !== 'object') {
    return createSeedState();
  }

  const record = raw as Record<string, unknown>;
  const schemaVersion = typeof record.schemaVersion === 'number' ? record.schemaVersion : 0;

  // Never normalize a future layout back to this build's schema. In-place
  // downgrade would discard fields the newer extension owns and can create an
  // MV3 old/new-context write ping-pong. Fail closed until the matching worker
  // is active; callers already crossed the preservation barrier before here.
  if (schemaVersion > STORAGE_SCHEMA_VERSION) {
    throw new UnsupportedFutureStorageSchemaError(schemaVersion);
  }

  if (schemaVersion === STORAGE_SCHEMA_VERSION) {
    // Guard personalities/accountMappings the same way the incremental branch
    // does: a corrupt value at the current version (e.g. a non-array after a
    // partial storage.set) would otherwise reach reconcileBundledPersonalities
    // and throw, bricking every load including the settings UI.
    return normalizePersistedRecord(record, STORAGE_SCHEMA_VERSION);
  }

  // Incremental migration: preserve what exists, fill in defaults for missing fields.
  return applyMigrations(record, schemaVersion);
}
