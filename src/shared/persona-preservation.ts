import { LEGACY_PERSONA_SNAPSHOT_KEY } from './constants.js';

export const LEGACY_PERSONA_SNAPSHOT_SCHEMA_VERSION = 1;
export const LEGACY_PERSONA_EXPORT_SCHEMA_VERSION = 1;

export interface PersonaPreservationStorage {
  get(keys: string | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface LegacyPersonaSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  origin: {
    client: 'chatgoose-firefox-extension';
    extensionVersion: string;
    storageSchemaVersion: number | null;
    agencyHubBaseUrl: string | null;
    reason: 'global-personas-became-server-managed';
  };
  raw: {
    personalitiesPresent: boolean;
    personalities: unknown;
    accountMappingsPresent: boolean;
    accountMappings: unknown;
    accountAliasesPresent: boolean;
    accountAliases: unknown;
  };
}

const readyStorage = new WeakSet<object>();
const inFlightByStorage = new WeakMap<object, Promise<LegacyPersonaSnapshot>>();

export class InvalidLegacyPersonaSnapshotError extends Error {
  constructor() {
    super('Legacy persona snapshot key exists but is invalid; refusing to overwrite evidence');
    this.name = 'InvalidLegacyPersonaSnapshotError';
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableStorageSchemaVersion(value: unknown): value is number | null {
  return value === null || (
    Number.isSafeInteger(value) &&
    (value as number) >= 0
  );
}

function rawValueMatchesPresence(
  raw: Record<string, unknown>,
  presentKey: string,
  valueKey: string,
  isPresentValue: (value: unknown) => boolean,
): boolean {
  if (typeof raw[presentKey] !== 'boolean' || !hasOwn(raw, valueKey)) {
    return false;
  }
  return raw[presentKey] === true
    ? isPresentValue(raw[valueKey])
    : raw[valueKey] === null;
}

export function isLegacyPersonaSnapshot(value: unknown): value is LegacyPersonaSnapshot {
  if (!isRecord(value)) return false;
  const record = value;
  const origin = record.origin;
  const raw = record.raw;
  return record.schemaVersion === LEGACY_PERSONA_SNAPSHOT_SCHEMA_VERSION &&
    isCanonicalIsoTimestamp(record.capturedAt) &&
    isRecord(origin) &&
    origin.client === 'chatgoose-firefox-extension' &&
    typeof origin.extensionVersion === 'string' &&
    origin.extensionVersion.length > 0 &&
    isNullableStorageSchemaVersion(origin.storageSchemaVersion) &&
    isNullableString(origin.agencyHubBaseUrl) &&
    origin.reason === 'global-personas-became-server-managed' &&
    isRecord(raw) &&
    rawValueMatchesPresence(raw, 'personalitiesPresent', 'personalities', Array.isArray) &&
    rawValueMatchesPresence(raw, 'accountMappingsPresent', 'accountMappings', isRecord) &&
    rawValueMatchesPresence(raw, 'accountAliasesPresent', 'accountAliases', isRecord);
}

function extensionVersion(): string {
  try {
    return browser.runtime?.getManifest?.().version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function legacyHubBaseUrl(stored: Record<string, unknown>): string | null {
  const settings = stored.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return null;
  const value = (settings as Record<string, unknown>).agencyHubBaseUrl;
  return typeof value === 'string' ? value : null;
}

/**
 * Write-once preservation barrier for the old full-text persona data.
 *
 * The complete payload is one storage value, so a successful `set` cannot
 * expose a partially populated snapshot. A rejected write leaves the source
 * keys untouched and rejects the caller; the next service-worker attempt can
 * retry. Once a valid snapshot exists, it is never replaced.
 */
export async function ensureLegacyPersonaSnapshot(
  storage: PersonaPreservationStorage = browser.storage.local,
  options: { now?: () => Date; extensionVersion?: string } = {},
): Promise<LegacyPersonaSnapshot> {
  if (readyStorage.has(storage as object)) {
    const stored = await storage.get(LEGACY_PERSONA_SNAPSHOT_KEY);
    const snapshot = stored[LEGACY_PERSONA_SNAPSHOT_KEY];
    if (isLegacyPersonaSnapshot(snapshot)) return snapshot;
    readyStorage.delete(storage as object);
    // WebExtension storage cannot persist `undefined`, but several compatible
    // storage adapters return `{ key: undefined }` for a missing string key.
    // Treat that representation as absent; any concrete malformed value still
    // fails closed and is never overwritten.
    if (hasOwn(stored, LEGACY_PERSONA_SNAPSHOT_KEY) && snapshot !== undefined) {
      throw new InvalidLegacyPersonaSnapshotError();
    }
  }

  const existingTask = inFlightByStorage.get(storage as object);
  if (existingTask) return existingTask;

  const task = (async () => {
    // A valid write-once snapshot is the overwhelmingly common steady state.
    // Check that one key before asking WebExtension storage to clone the whole
    // area. A new extension realm (content page/options/worker restart) has an
    // empty WeakSet, but the durable evidence already on disk is sufficient to
    // cross the barrier. If it is absent, the full raw read below still captures
    // every legacy byte before any migration can write.
    const preserved = await storage.get(LEGACY_PERSONA_SNAPSHOT_KEY);
    const preservedSnapshot = preserved[LEGACY_PERSONA_SNAPSHOT_KEY];
    if (isLegacyPersonaSnapshot(preservedSnapshot)) {
      readyStorage.add(storage as object);
      return preservedSnapshot;
    }
    if (
      hasOwn(preserved, LEGACY_PERSONA_SNAPSHOT_KEY) &&
      preservedSnapshot !== undefined
    ) {
      throw new InvalidLegacyPersonaSnapshotError();
    }

    // One raw read captures source fields before migration/normalization can
    // write anything back. Empty strings and arbitrarily large drafts are
    // copied as-is; there is deliberately no trim or length limit here.
    const stored = await storage.get(null);
    const existing = stored[LEGACY_PERSONA_SNAPSHOT_KEY];
    if (isLegacyPersonaSnapshot(existing)) {
      readyStorage.add(storage as object);
      return existing;
    }
    if (hasOwn(stored, LEGACY_PERSONA_SNAPSHOT_KEY) && existing !== undefined) {
      throw new InvalidLegacyPersonaSnapshotError();
    }

    const snapshot: LegacyPersonaSnapshot = {
      schemaVersion: LEGACY_PERSONA_SNAPSHOT_SCHEMA_VERSION,
      capturedAt: (options.now?.() ?? new Date()).toISOString(),
      origin: {
        client: 'chatgoose-firefox-extension',
        extensionVersion: options.extensionVersion ?? extensionVersion(),
        storageSchemaVersion: Number.isSafeInteger(stored.schemaVersion) &&
          (stored.schemaVersion as number) >= 0
          ? stored.schemaVersion as number
          : null,
        // Provenance only. Never copy the full legacy settings object: v12
        // could still contain bearer credentials inside it.
        agencyHubBaseUrl: legacyHubBaseUrl(stored),
        reason: 'global-personas-became-server-managed',
      },
      raw: {
        personalitiesPresent: hasOwn(stored, 'personalities'),
        personalities: hasOwn(stored, 'personalities') ? stored.personalities : null,
        accountMappingsPresent: hasOwn(stored, 'accountMappings'),
        accountMappings: hasOwn(stored, 'accountMappings') ? stored.accountMappings : null,
        accountAliasesPresent: hasOwn(stored, 'accountAliases'),
        accountAliases: hasOwn(stored, 'accountAliases') ? stored.accountAliases : null,
      },
    };

    // The preservation value must satisfy the same durable contract used on
    // every later read. If the legacy source itself is structurally corrupt,
    // fail into recovery without writing an invalid snapshot or allowing the
    // migration/network caller past the barrier.
    if (!isLegacyPersonaSnapshot(snapshot)) {
      throw new InvalidLegacyPersonaSnapshotError();
    }
    await storage.set({ [LEGACY_PERSONA_SNAPSHOT_KEY]: snapshot });
    readyStorage.add(storage as object);
    return snapshot;
  })().finally(() => {
    inFlightByStorage.delete(storage as object);
  });
  inFlightByStorage.set(storage as object, task);
  return task;
}

export async function buildLegacyPersonaExport(
  storage: PersonaPreservationStorage = browser.storage.local,
  options: { now?: () => Date; extensionVersion?: string } = {},
): Promise<Record<string, unknown>> {
  let snapshot: unknown;
  let snapshotValid = true;
  try {
    snapshot = await ensureLegacyPersonaSnapshot(storage, options);
  } catch (error) {
    if (!(error instanceof InvalidLegacyPersonaSnapshotError)) throw error;
    snapshotValid = false;
  }
  const current = await storage.get(null);
  if (!snapshotValid) {
    snapshot = current[LEGACY_PERSONA_SNAPSHOT_KEY];
  }
  return {
    schemaVersion: LEGACY_PERSONA_EXPORT_SCHEMA_VERSION,
    exportedAt: (options.now?.() ?? new Date()).toISOString(),
    origin: {
      client: 'chatgoose-firefox-extension',
      extensionVersion: options.extensionVersion ?? extensionVersion(),
    },
    preservedSnapshot: snapshot,
    preservedSnapshotValid: snapshotValid,
    currentLegacyData: {
      personalities: hasOwn(current, 'personalities') ? current.personalities : null,
      accountMappings: hasOwn(current, 'accountMappings') ? current.accountMappings : null,
      accountAliases: hasOwn(current, 'accountAliases') ? current.accountAliases : null,
    },
  };
}
