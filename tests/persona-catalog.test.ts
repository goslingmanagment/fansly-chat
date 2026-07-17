import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createPersonaCatalogController,
  startPersonaCatalogRefreshLoop,
  type PersonaCatalogHub,
  type PersonaCatalogStorage,
} from '../src/background/persona-catalog.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import {
  LEGACY_PERSONA_SNAPSHOT_KEY,
  PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY,
  PERSONA_CATALOG_SOURCE_STORAGE_KEY,
  PERSONA_CATALOG_STORAGE_KEY,
} from '../src/shared/constants.js';
import {
  createDefaultSettings,
  UnsupportedFutureStorageSchemaError,
} from '../src/shared/migrations.js';
import {
  findActivePersona,
  normalizePersonaCatalog,
} from '../src/shared/persona-catalog.js';
import {
  buildLegacyPersonaExport,
  ensureLegacyPersonaSnapshot,
  InvalidLegacyPersonaSnapshotError,
  isLegacyPersonaSnapshot,
} from '../src/shared/persona-preservation.js';
import type { PersonaCatalogEntry, Settings } from '../src/shared/types.js';

function configuredSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    ...createDefaultSettings(),
    agencyHubBaseUrl: 'https://hub.example.test',
    agencyHubDeviceToken: 'device-token',
    ...overrides,
  };
}

function makeStorage(initial: Record<string, unknown>): {
  storage: PersonaCatalogStorage;
  data: Record<string, unknown>;
  writes: Array<Record<string, unknown>>;
  failNextSet: () => void;
} {
  const data = structuredClone(initial);
  const writes: Array<Record<string, unknown>> = [];
  let shouldFail = false;
  const storage: PersonaCatalogStorage = {
    get: vi.fn(async () => structuredClone(data)),
    set: vi.fn(async (items) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('storage write failed');
      }
      writes.push(structuredClone(items));
      Object.assign(data, structuredClone(items));
    }),
  };
  return { storage, data, writes, failNextSet: () => { shouldFail = true; } };
}

function makeHub(): {
  hub: PersonaCatalogHub;
  fetchAiPersonaCatalog: ReturnType<typeof vi.fn>;
} {
  const fetchAiPersonaCatalog = vi.fn(async () => [{
    key: 'persona-1',
    displayName: 'Closer',
    definitionId: 'v1:persona-one-definition',
    version: 7,
    status: 'active' as const,
  }]);
  return {
    fetchAiPersonaCatalog,
    hub: {
      isConfigured: (settings) => Boolean(personaCatalogSource(settings)),
      fetchAiPersonaCatalog,
    },
  };
}

function makeController(options: {
  hub: PersonaCatalogHub;
  storage: PersonaCatalogStorage;
  settings?: Settings;
  readSettings?: () => Promise<Settings>;
  onWarn?: (message: string) => void;
  timeoutMs?: number;
  now?: () => Date;
}) {
  let currentSettings = options.settings ?? configuredSettings();
  const controller = createPersonaCatalogController({
    hub: options.hub,
    storage: options.storage,
    readSettings: options.readSettings ?? (async () => currentSettings),
    ...(options.onWarn ? { onWarn: options.onWarn } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    controller,
    setSettings(settings: Settings) {
      currentSettings = settings;
    },
  };
}

describe('legacy persona preservation', () => {
  it('captures empty and large drafts, mappings, aliases and v12 Hub provenance without credentials', async () => {
    const large = 'x'.repeat(120_000);
    const legacy = makeStorage({
      schemaVersion: 12,
      settings: {
        agencyHubBaseUrl: 'https://hub.example.test/path',
        agencyHubApiKey: 'must-not-be-exported-from-settings',
        agencyHubDeviceToken: 'also-secret',
      },
      personalities: [
        { id: 'empty', name: 'Empty draft', content: '', updatedAt: 1 },
        { id: 'large', name: 'Large draft', content: large, updatedAt: 2 },
      ],
      accountMappings: { creator: 'large' },
      accountAliases: { legacy: 'creator' },
    });

    const snapshot = await ensureLegacyPersonaSnapshot(legacy.storage, {
      now: () => new Date('2026-07-13T12:00:00.000Z'),
      extensionVersion: '1.9.7-test',
    });

    expect(snapshot.origin).toEqual({
      client: 'chatgoose-firefox-extension',
      extensionVersion: '1.9.7-test',
      storageSchemaVersion: 12,
      agencyHubBaseUrl: 'https://hub.example.test/path',
      reason: 'global-personas-became-server-managed',
    });
    expect(snapshot.raw.personalities).toEqual(legacy.data.personalities);
    expect(JSON.stringify(snapshot)).toContain(large);
    expect(JSON.stringify(snapshot)).not.toContain('must-not-be-exported');
    expect(JSON.stringify(snapshot)).not.toContain('also-secret');
    expect(snapshot.raw.accountMappings).toEqual({ creator: 'large' });
    expect(snapshot.raw.accountAliases).toEqual({ legacy: 'creator' });
  });

  it('is idempotent across a simulated worker restart and never rewrites a valid snapshot', async () => {
    const first = makeStorage({
      schemaVersion: 13,
      settings: { agencyHubBaseUrl: 'https://hub.example.test' },
      agencyHubDeviceToken: 'top-level-secret',
      personalities: [{ id: 'p', name: 'P', content: 'full text', updatedAt: 1 }],
      accountMappings: {},
      accountAliases: {},
    });
    const snapshot = await ensureLegacyPersonaSnapshot(first.storage, {
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    // A new wrapper around the same durable data bypasses the module WeakSet,
    // exactly like a restarted service worker importing the module afresh.
    const restartedWrites: Array<Record<string, unknown>> = [];
    const restarted: PersonaCatalogStorage = {
      get: vi.fn(async () => structuredClone(first.data)),
      set: vi.fn(async (items) => {
        restartedWrites.push(items);
        Object.assign(first.data, items);
      }),
    };
    const afterRestart = await ensureLegacyPersonaSnapshot(restarted);

    expect(afterRestart).toEqual(snapshot);
    expect(restartedWrites).toEqual([]);
    expect(JSON.stringify(afterRestart)).not.toContain('top-level-secret');
  });

  it('rejects incomplete or structurally invalid preservation snapshots', () => {
    const valid = {
      schemaVersion: 1,
      capturedAt: '2026-07-13T12:00:00.000Z',
      origin: {
        client: 'chatgoose-firefox-extension',
        extensionVersion: '1.9.7-test',
        storageSchemaVersion: 13,
        agencyHubBaseUrl: 'https://hub.example.test',
        reason: 'global-personas-became-server-managed',
      },
      raw: {
        personalitiesPresent: true,
        personalities: [],
        accountMappingsPresent: true,
        accountMappings: {},
        accountAliasesPresent: true,
        accountAliases: {},
      },
    };

    expect(isLegacyPersonaSnapshot(valid)).toBe(true);
    expect(isLegacyPersonaSnapshot({
      ...valid,
      raw: {
        personalitiesPresent: true,
        accountMappingsPresent: true,
        accountAliasesPresent: true,
      },
    })).toBe(false);
    expect(isLegacyPersonaSnapshot({ ...valid, capturedAt: 'not-a-timestamp' })).toBe(false);
    expect(isLegacyPersonaSnapshot({
      ...valid,
      origin: { ...valid.origin, reason: 'wrong-reason' },
    })).toBe(false);
    expect(isLegacyPersonaSnapshot({
      ...valid,
      origin: { ...valid.origin, storageSchemaVersion: 13.5 },
    })).toBe(false);
    expect(isLegacyPersonaSnapshot({
      ...valid,
      raw: { ...valid.raw, personalities: {} },
    })).toBe(false);
    expect(isLegacyPersonaSnapshot({
      ...valid,
      raw: { ...valid.raw, accountMappings: [] },
    })).toBe(false);
    expect(isLegacyPersonaSnapshot({
      ...valid,
      raw: { ...valid.raw, accountAliases: [] },
    })).toBe(false);
    expect(isLegacyPersonaSnapshot({
      ...valid,
      raw: {
        personalitiesPresent: false,
        personalities: null,
        accountMappingsPresent: false,
        accountMappings: null,
        accountAliasesPresent: false,
        accountAliases: null,
      },
    })).toBe(true);
  });

  it('fails closed on a header-only pre-existing key and export exposes it without replacement', async () => {
    // This shape used to pass the validator because it supplied the three
    // presence booleans while omitting the data they claimed was captured.
    const malformed = {
      schemaVersion: 1,
      capturedAt: '2026-07-13T12:00:00.000Z',
      origin: {
        client: 'chatgoose-firefox-extension',
        extensionVersion: '1.9.7-test',
        storageSchemaVersion: 13,
        agencyHubBaseUrl: 'https://hub.example.test',
        reason: 'global-personas-became-server-managed',
      },
      raw: {
        personalitiesPresent: true,
        accountMappingsPresent: true,
        accountAliasesPresent: true,
      },
    };
    const local = makeStorage({
      [LEGACY_PERSONA_SNAPSHOT_KEY]: malformed,
      personalities: [{ id: 'p', content: 'still here' }],
      accountMappings: { a: 'p' },
      accountAliases: {},
    });

    await expect(ensureLegacyPersonaSnapshot(local.storage))
      .rejects.toBeInstanceOf(InvalidLegacyPersonaSnapshotError);
    expect(local.writes).toEqual([]);

    const exported = await buildLegacyPersonaExport(local.storage);
    expect(exported.preservedSnapshotValid).toBe(false);
    expect(exported.preservedSnapshot).toEqual(malformed);
    expect(local.data[LEGACY_PERSONA_SNAPSHOT_KEY]).toEqual(malformed);
  });

  it('does not write or cross the barrier when the raw legacy source has invalid container types', async () => {
    const local = makeStorage({
      schemaVersion: 13,
      personalities: { not: 'an array' },
      accountMappings: {},
      accountAliases: {},
    });

    await expect(ensureLegacyPersonaSnapshot(local.storage))
      .rejects.toBeInstanceOf(InvalidLegacyPersonaSnapshotError);
    expect(local.writes).toEqual([]);
    expect(local.data[LEGACY_PERSONA_SNAPSHOT_KEY]).toBeUndefined();
  });
});

describe('read-only persona catalog controller', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves legacy-valid persona key and display-name bytes exactly', () => {
    const catalog = normalizePersonaCatalog([
      {
        key: ' legacy.persona ',
        displayName: ' Legacy display name ',
        definitionId: ' opaque definition bytes ',
        version: 4,
        status: 'active',
      },
    ]);

    expect(catalog).toEqual([{
      key: ' legacy.persona ',
      displayName: ' Legacy display name ',
      definitionId: ' opaque definition bytes ',
      version: 4,
      status: 'active',
    }]);
    expect(findActivePersona(catalog, ' legacy.persona ')?.version).toBe(4);
    expect(findActivePersona(catalog, 'legacy.persona')).toBeNull();
  });

  it('requires an opaque definition id and preserves its bytes exactly', () => {
    const catalog = normalizePersonaCatalog([
      {
        key: 'missing-definition',
        displayName: 'Missing',
        version: 1,
        status: 'active',
      },
      {
        key: 'valid',
        displayName: 'Valid',
        definitionId: ' opaque definition bytes ',
        version: 1,
        status: 'active',
      },
    ]);

    expect(catalog).toEqual([expect.objectContaining({
      key: 'valid',
      definitionId: ' opaque definition bytes ',
    })]);
  });

  it('persists only metadata after the preservation write and never touches legacy personalities', async () => {
    const local = makeStorage({
      schemaVersion: 13,
      settings: { agencyHubBaseUrl: 'https://hub.example.test' },
      personalities: [{ id: 'legacy', name: 'Legacy', content: '', updatedAt: 1 }],
      accountMappings: { creator: 'legacy' },
      accountAliases: { old: 'creator' },
    });
    const originalPersonalities = structuredClone(local.data.personalities);
    const { hub, fetchAiPersonaCatalog } = makeHub();
    const { controller } = makeController({
      hub,
      storage: local.storage,
      settings: configuredSettings(),
      now: () => new Date('2026-07-13T12:00:00.000Z'),
    });

    await controller.refresh();

    expect(fetchAiPersonaCatalog).toHaveBeenCalledTimes(1);
    expect(local.data.personalities).toEqual(originalPersonalities);
    expect(local.data[PERSONA_CATALOG_STORAGE_KEY]).toEqual([{
      key: 'persona-1',
      displayName: 'Closer',
      definitionId: 'v1:persona-one-definition',
      version: 7,
      status: 'active',
    }]);
    expect(local.data[PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY])
      .toBe('2026-07-13T12:00:00.000Z');
    expect(local.writes.every((write) => !Object.hasOwn(write, 'personalities'))).toBe(true);
  });

  it('does not rewrite storage when a periodic refresh returns byte-identical catalog metadata', async () => {
    const settings = configuredSettings();
    const source = personaCatalogSource(settings);
    const catalog = [{ key: 'persona-1', displayName: 'Closer', definitionId: 'v1:persona-one-definition', version: 7, status: 'active' as const }];
    const local = makeStorage({
      schemaVersion: 14,
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      [PERSONA_CATALOG_STORAGE_KEY]: catalog,
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: source,
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: '2026-07-13T12:00:00.000Z',
    });
    const { hub } = makeHub();
    const { controller } = makeController({
      hub,
      storage: local.storage,
      settings,
      now: () => new Date('2026-07-13T12:05:00.000Z'),
    });
    await ensureLegacyPersonaSnapshot(local.storage);
    local.writes.length = 0;

    await controller.refresh();

    expect(local.writes).toEqual([]);
    expect(local.data[PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY])
      .toBe('2026-07-13T12:00:00.000Z');
  });

  it('leaves fetchedAt null when the post-rotation refresh REJECTS (nothing was confirmed)', async () => {
    const oldSettings = configuredSettings({ agencyHubDeviceToken: 'old' });
    const newSettings = configuredSettings({ agencyHubDeviceToken: 'new' });
    const local = makeStorage({
      schemaVersion: 14,
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      [PERSONA_CATALOG_STORAGE_KEY]: [{
        key: 'old',
        displayName: 'Old',
        definitionId: 'v1:old-persona-definition',
        version: 1,
        status: 'active',
      }],
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: personaCatalogSource(oldSettings),
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: '2026-07-13T12:00:00.000Z',
    });
    await ensureLegacyPersonaSnapshot(local.storage);
    local.writes.length = 0;
    const { hub, fetchAiPersonaCatalog } = makeHub();
    fetchAiPersonaCatalog.mockRejectedValueOnce(new Error('catalog refresh failed'));
    const { controller } = makeController({
      hub,
      storage: local.storage,
      settings: newSettings,
    });

    await controller.refresh();

    // The rotation clears to the new source (empty catalog, fetchedAt null), but
    // the fetch that would confirm it failed — so fetchedAt must STAY null and the
    // Options classifier reports «ещё не загружен», never «пустой каталог».
    expect(fetchAiPersonaCatalog).toHaveBeenCalledTimes(1);
    expect(local.data[PERSONA_CATALOG_SOURCE_STORAGE_KEY])
      .toBe(personaCatalogSource(newSettings));
    expect(local.data[PERSONA_CATALOG_STORAGE_KEY]).toEqual([]);
    expect(local.data[PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]).toBeNull();
  });

  it('stamps fetchedAt when a confirmed EMPTY catalog is byte-identical to the cleared cache', async () => {
    const settings = configuredSettings();
    const source = personaCatalogSource(settings);
    // The exact triple clearForSource leaves after a rotation: source already
    // matches, catalog already empty, fetchedAt still null (never confirmed).
    const local = makeStorage({
      schemaVersion: 14,
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      [PERSONA_CATALOG_STORAGE_KEY]: [],
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: source,
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: null,
    });
    await ensureLegacyPersonaSnapshot(local.storage);
    local.writes.length = 0;
    const { hub, fetchAiPersonaCatalog } = makeHub();
    fetchAiPersonaCatalog.mockResolvedValueOnce([]);
    const { controller } = makeController({
      hub,
      storage: local.storage,
      settings,
      now: () => new Date('2026-07-13T12:05:00.000Z'),
    });

    await controller.refresh();

    // Byte-identical to the cleared cache, but a null stored fetchedAt means the
    // server response was never confirmed — the commit must run and stamp
    // fetchedAt so the Options classifier can tell confirmed-empty from
    // never-loaded.
    expect(fetchAiPersonaCatalog).toHaveBeenCalledTimes(1);
    expect(local.writes).toHaveLength(1);
    expect(local.data[PERSONA_CATALOG_STORAGE_KEY]).toEqual([]);
    expect(local.data[PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY])
      .toBe('2026-07-13T12:05:00.000Z');
  });

  it('persists an ID-only definition change even when the numeric version is unchanged', async () => {
    const settings = configuredSettings();
    const source = personaCatalogSource(settings);
    const local = makeStorage({
      schemaVersion: 14,
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      [PERSONA_CATALOG_STORAGE_KEY]: [{
        key: 'persona-1',
        displayName: 'Closer',
        definitionId: 'v1:old-persona-definition',
        version: 7,
        status: 'active',
      }],
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: source,
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: '2026-07-13T12:00:00.000Z',
    });
    const { hub, fetchAiPersonaCatalog } = makeHub();
    fetchAiPersonaCatalog.mockResolvedValueOnce([{
      key: 'persona-1',
      displayName: 'Closer',
      definitionId: 'v1:new-persona-definition',
      version: 7,
      status: 'active',
    }]);
    const { controller } = makeController({
      hub,
      storage: local.storage,
      settings,
      now: () => new Date('2026-07-13T12:05:00.000Z'),
    });
    await ensureLegacyPersonaSnapshot(local.storage);
    local.writes.length = 0;

    await controller.refresh();

    expect(local.writes).toHaveLength(1);
    expect(local.data[PERSONA_CATALOG_STORAGE_KEY]).toEqual([
      expect.objectContaining({ definitionId: 'v1:new-persona-definition', version: 7 }),
    ]);
  });

  it('aborts catalog mutation and fetch when the preservation write fails, then retries cleanly', async () => {
    const local = makeStorage({
      schemaVersion: 12,
      personalities: [{ id: 'legacy', content: 'recover me' }],
      accountMappings: {},
      accountAliases: {},
    });
    local.failNextSet();
    const { hub, fetchAiPersonaCatalog } = makeHub();
    const { controller } = makeController({
      hub,
      storage: local.storage,
      settings: configuredSettings(),
    });

    await expect(controller.refresh()).rejects.toThrow('storage write failed');
    expect(fetchAiPersonaCatalog).not.toHaveBeenCalled();
    expect(local.data[PERSONA_CATALOG_STORAGE_KEY]).toBeUndefined();

    await controller.refresh();
    expect(fetchAiPersonaCatalog).toHaveBeenCalledTimes(1);
    expect(local.data[LEGACY_PERSONA_SNAPSHOT_KEY]).toBeDefined();
  });

  it('keeps mappings while archived and malformed catalog rows remain unavailable', async () => {
    const local = makeStorage({
      schemaVersion: 14,
      personalities: [],
      accountMappings: { creator: 'archived' },
      accountAliases: {},
    });
    const { hub, fetchAiPersonaCatalog } = makeHub();
    fetchAiPersonaCatalog.mockResolvedValueOnce([
      { key: 'archived', displayName: 'Old', definitionId: 'v1:archived-persona', version: 3, status: 'archived' },
      { key: 'bad', displayName: 'Bad', definitionId: 'v1:invalid-persona-row', version: 0, status: 'active' },
    ]);
    const { controller } = makeController({
      hub,
      storage: local.storage,
      settings: configuredSettings(),
    });

    await controller.refresh();

    expect(local.data.accountMappings).toEqual({ creator: 'archived' });
    expect(local.data[PERSONA_CATALOG_STORAGE_KEY]).toEqual([
      { key: 'archived', displayName: 'Old', definitionId: 'v1:archived-persona', version: 3, status: 'archived' },
    ]);
  });

  it('discards an older source response when credentials change mid-flight', async () => {
    const local = makeStorage({
      schemaVersion: 14,
      personalities: [],
      accountMappings: {},
      accountAliases: {},
    });
    let releaseFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => { releaseFirst = resolve; });
    const { hub, fetchAiPersonaCatalog } = makeHub();
    fetchAiPersonaCatalog
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce([{ key: 'new', displayName: 'New', definitionId: 'v1:new-persona-definition', version: 2, status: 'active' }]);
    const oldSettings = configuredSettings({ agencyHubDeviceToken: 'old' });
    const newSettings = configuredSettings({ agencyHubDeviceToken: 'new' });
    const { controller, setSettings } = makeController({
      hub,
      storage: local.storage,
      settings: oldSettings,
    });

    const oldRefresh = controller.refresh();
    await vi.waitFor(() => expect(fetchAiPersonaCatalog).toHaveBeenCalledTimes(1));
    setSettings(newSettings);
    const newRefresh = controller.refresh();
    releaseFirst([{ key: 'old', displayName: 'Old', definitionId: 'v1:old-persona-definition', version: 1, status: 'active' }]);
    await Promise.all([oldRefresh, newRefresh]);

    expect(local.data[PERSONA_CATALOG_STORAGE_KEY]).toEqual([
      { key: 'new', displayName: 'New', definitionId: 'v1:new-persona-definition', version: 2, status: 'active' },
    ]);
    expect(local.data[PERSONA_CATALOG_SOURCE_STORAGE_KEY])
      .toBe(personaCatalogSource(newSettings));
  });

  it('does not commit a fetched catalog after the current source changes without a newer refresh call', async () => {
    const oldSettings = configuredSettings({ agencyHubDeviceToken: 'old' });
    const newSettings = configuredSettings({ agencyHubDeviceToken: 'new' });
    const oldCatalog = [{
      key: 'old',
      displayName: 'Old',
      definitionId: 'v1:old-persona-definition',
      version: 1,
      status: 'active' as const,
    }];
    const local = makeStorage({
      schemaVersion: 14,
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      [PERSONA_CATALOG_STORAGE_KEY]: oldCatalog,
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: personaCatalogSource(oldSettings),
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: '2026-07-13T12:00:00.000Z',
    });
    await ensureLegacyPersonaSnapshot(local.storage);
    local.writes.length = 0;
    let releaseFetch!: (value: PersonaCatalogEntry[]) => void;
    const fetchPending = new Promise<PersonaCatalogEntry[]>((resolve) => {
      releaseFetch = resolve;
    });
    const { hub, fetchAiPersonaCatalog } = makeHub();
    fetchAiPersonaCatalog.mockReturnValueOnce(fetchPending);
    const { controller, setSettings } = makeController({
      hub,
      storage: local.storage,
      settings: oldSettings,
    });

    const refresh = controller.refresh();
    await vi.waitFor(() => expect(fetchAiPersonaCatalog).toHaveBeenCalledTimes(1));
    setSettings(newSettings);
    releaseFetch([{
      key: 'stale',
      displayName: 'Stale',
      definitionId: 'v1:stale-persona-definition',
      version: 2,
      status: 'active',
    }]);
    await refresh;

    expect(local.writes).toEqual([]);
    expect(local.data[PERSONA_CATALOG_STORAGE_KEY]).toEqual(oldCatalog);
  });

  it('performs a final future-schema read before committing a fetched catalog', async () => {
    const currentSettings = configuredSettings();
    const local = makeStorage({
      schemaVersion: 14,
      personalities: [],
      accountMappings: {},
      accountAliases: {},
      [PERSONA_CATALOG_STORAGE_KEY]: [],
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: personaCatalogSource(currentSettings),
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: null,
    });
    await ensureLegacyPersonaSnapshot(local.storage);
    local.writes.length = 0;
    let futureSchema = false;
    let releaseFetch!: (value: PersonaCatalogEntry[]) => void;
    const fetchPending = new Promise<PersonaCatalogEntry[]>((resolve) => {
      releaseFetch = resolve;
    });
    const { hub, fetchAiPersonaCatalog } = makeHub();
    fetchAiPersonaCatalog.mockReturnValueOnce(fetchPending);
    const { controller } = makeController({
      hub,
      storage: local.storage,
      readSettings: async () => {
        if (futureSchema) throw new UnsupportedFutureStorageSchemaError(15);
        return currentSettings;
      },
    });

    const refresh = controller.refresh();
    await vi.waitFor(() => expect(fetchAiPersonaCatalog).toHaveBeenCalledTimes(1));
    futureSchema = true;
    releaseFetch([{
      key: 'new',
      displayName: 'New',
      definitionId: 'v1:new-persona-definition',
      version: 1,
      status: 'active',
    }]);

    await expect(refresh).rejects.toBeInstanceOf(UnsupportedFutureStorageSchemaError);
    expect(local.writes).toEqual([]);
  });

  it('refreshes on a bounded interval while the worker remains alive', async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => undefined);
    const stop = startPersonaCatalogRefreshLoop({ refresh, intervalMs: 300_000 });

    await vi.advanceTimersByTimeAsync(299_999);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
