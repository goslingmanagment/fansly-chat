import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY,
  PERSONA_CATALOG_SOURCE_STORAGE_KEY,
  PERSONA_CATALOG_STORAGE_KEY,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import { personaCatalogSource } from '../src/shared/persona-catalog.js';
import type { PersistedState, SessionSnapshotEntry } from '../src/shared/types.js';

let dom: InstanceType<typeof JSDOM>;
let currentState: PersistedState;
let currentSessions: SessionSnapshotEntry[] = [];
let callOrder: string[] = [];
let onSnapshotRequest: (() => void) | null = null;
let onStorageRead: (() => void) | null = null;
let snapshotResponsePromise: Promise<SessionSnapshotEntry[]> | null = null;
let releaseFirstStorageSet: (() => void) | null = null;
let stallNextStorageSet: (() => void) | null = null;
let failNextStorageSet: (() => void) | null = null;
type StorageChangeListener = (
  changes: Record<string, browser.storage.StorageChange>,
  areaName: string,
) => void;
let storageChangeListeners = new Set<StorageChangeListener>();

function emitStorageChanges(
  changes: Record<string, browser.storage.StorageChange>,
  areaName = 'local',
): void {
  for (const listener of storageChangeListeners) {
    listener(changes, areaName);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
}

function makeState(overrides?: Partial<PersistedState>): PersistedState {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: {
      agencyHubBaseUrl: '',
      agencyHubApiKey: '',
      agencyHubDeviceToken: '',
      quickMessageCount: 30,
      pingMessageCount: 30,
      improveMessageCount: 45,
      deepMessageCount: 200,
      debugMode: false,
      promptCachingEnabled: true,
      uiTheme: 'system',
    },
    personalities: [{ id: 'p1', name: 'Closer', content: 'be nice', updatedAt: 1 }],
    personaCatalog: [{
      key: 'p1',
      displayName: 'Closer',
      definitionId: 'v1:persona-one-definition',
      version: 1,
      status: 'active',
    }],
    personaCatalogSource: null,
    personaCatalogFetchedAt: null,
    accountMappings: {},
    accountAliases: {},
    knownAccounts: [],
    ...overrides,
  };
}

function installDom() {
  dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="chatgoose-options-root"></div></body></html>',
    { url: 'https://example.test/options.html' },
  );
  const { window } = dom;

  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('navigator', window.navigator);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLSelectElement', window.HTMLSelectElement);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event);
}

function getSectionByTitle(title: string): HTMLElement {
  const sections = Array.from(document.querySelectorAll<HTMLElement>('section'));
  const section = sections.find(
    (candidate) => candidate.querySelector('h2')?.textContent === title,
  );

  if (!section) {
    throw new Error(`Missing section: ${title}`);
  }

  return section;
}

async function loadOptionsPage(options: {
  state: PersistedState;
  sessions: SessionSnapshotEntry[];
  onSnapshotRequest?: () => void;
  onStorageRead?: () => void;
  onRuntimeRequest?: (message: unknown) => unknown | Promise<unknown>;
  snapshotPromise?: Promise<SessionSnapshotEntry[]>;
  waitForHydration?: boolean;
}): Promise<void> {
  vi.resetModules();
  installDom();
  currentState = options.state;
  currentSessions = options.sessions;
  callOrder = [];
  onSnapshotRequest = options.onSnapshotRequest ?? null;
  onStorageRead = options.onStorageRead ?? null;
  snapshotResponsePromise = options.snapshotPromise ?? null;
  releaseFirstStorageSet = null;
  stallNextStorageSet = null;
  failNextStorageSet = null;
  storageChangeListeners = new Set();
  let nextStorageSetGate: ReturnType<typeof deferred<void>> | null = null;
  let nextStorageSetError: Error | null = null;
  stallNextStorageSet = () => {
    const gate = deferred<void>();
    nextStorageSetGate = gate;
    releaseFirstStorageSet = () => gate.resolve();
  };
  failNextStorageSet = () => {
    nextStorageSetError = new Error('transient storage failure');
  };

  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: vi.fn(async () => {
          callOrder.push('storage');
          const snapshot = structuredClone(currentState);
          onStorageRead?.();
          return snapshot;
        }),
        set: vi.fn(async (items: Partial<PersistedState>) => {
          const failure = nextStorageSetError;
          nextStorageSetError = null;
          if (failure) {
            throw failure;
          }
          const gate = nextStorageSetGate;
          nextStorageSetGate = null;
          currentState = {
            ...currentState,
            ...items,
          };
          if (gate) {
            await gate.promise;
          }
        }),
        remove: vi.fn(async () => undefined),
      },
      onChanged: {
        addListener: vi.fn((listener: StorageChangeListener) => {
          storageChangeListeners.add(listener);
        }),
        removeListener: vi.fn((listener: StorageChangeListener) => {
          storageChangeListeners.delete(listener);
        }),
      },
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
      sendMessage: vi.fn(async (message: unknown) => {
        const requestType = message && typeof message === 'object'
          ? (message as { type?: unknown }).type
          : undefined;
        if (requestType === 'getSessionsSnapshot') {
          callOrder.push('snapshot');
          onSnapshotRequest?.();
          return snapshotResponsePromise ?? currentSessions;
        }
        return options.onRuntimeRequest
          ? await options.onRuntimeRequest(message)
          : currentSessions;
      }),
      openOptionsPage: vi.fn(async () => undefined),
    },
    permissions: {
      contains: vi.fn(async () => false),
      request: vi.fn(async () => false),
    },
  };

  await import('../src/options/index.js');
  await vi.waitFor(() => {
    getSectionByTitle('Аккаунты');
  }, { timeout: 2000 });
  if (options.waitForHydration !== false) {
    await vi.waitFor(() => {
      expect(getSectionByTitle('Аккаунты').dataset.sessionHydration).toBe('ready');
    }, { timeout: 2000 });
  }
}

describe('Options page account sections', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves legacy personas before session discovery and hydrates rekeyed accounts cleanly', async () => {
    await loadOptionsPage({
      state: makeState({
        accountMappings: {
          mappedOffline: 'p1',
        },
        knownAccounts: ['mappedOffline', 'stale'],
      }),
      sessions: [
        {
          legacyAccountId: 'legacy',
          resolvedAccountId: 'active-resolved',
          username: 'creator',
          displayName: 'Creator',
          connected: true,
          lastSeenAt: 20,
        },
      ],
      onSnapshotRequest: () => {
        currentState = makeState({
          accountMappings: {
            mappedOffline: 'p1',
          },
          knownAccounts: ['active-resolved', 'mappedOffline'],
        });
      },
    });

    const accountsSection = getSectionByTitle('Аккаунты');

    expect(callOrder.slice(0, 2)).toEqual(['storage', 'snapshot']);
    expect(accountsSection.textContent).toContain('ID аккаунта: active-resolved');
    expect(accountsSection.textContent).toContain('ID аккаунта: mappedOffline');
    expect(accountsSection.textContent).not.toContain('stale');
    // The merged section shows all known accounts; active-resolved is the live
    // connected session, so its capture line renders.
    expect(accountsSection.textContent).toContain('захвачена');
  });

  it('renders local settings before a slow session snapshot and hydrates only account sections', async () => {
    const snapshot = deferred<SessionSnapshotEntry[]>();
    await loadOptionsPage({
      state: makeState({
        knownAccounts: ['legacy'],
      }),
      sessions: [],
      snapshotPromise: snapshot.promise,
      waitForHydration: false,
    });

    const personalityCard = getSectionByTitle('Персоны')
      .querySelector<HTMLElement>('[data-persona-key="p1"]')!;
    const accountsSection = getSectionByTitle('Аккаунты');

    expect(personalityCard.textContent).toContain('Closer');
    expect(accountsSection.dataset.sessionHydration).toBe('loading');
    expect(accountsSection.textContent).toContain('Загружаю аккаунты Fansly');
    expect(callOrder.slice(0, 2)).toEqual(['storage', 'snapshot']);

    // getSessionsSnapshot owns identity rekey/reconciliation in the real
    // background. Simulate that committed state immediately before its reply.
    currentState = makeState({
      personalities: [{ id: 'p1', name: 'Closer', content: 'be nice', updatedAt: 1 }],
      knownAccounts: ['canonical'],
    });
    snapshot.resolve([{
      legacyAccountId: 'legacy',
      resolvedAccountId: 'canonical',
      username: 'creator',
      displayName: 'Creator',
      connected: true,
      lastSeenAt: 20,
    }]);

    await vi.waitFor(() => {
      expect(accountsSection.dataset.sessionHydration).toBe('ready');
      expect(accountsSection.textContent).toContain('ID аккаунта: canonical');
    });

    // Session hydration refreshes «аккаунтов: N» on the read-only catalog (no
    // editable inputs there), so the row may be rebuilt — but its content is
    // preserved and no form state is touched.
    expect(getSectionByTitle('Персоны')
      .querySelector<HTMLElement>('[data-persona-key="p1"]')?.textContent).toContain('Closer');
    expect(currentState.personalities[0]?.name).toBe('Closer');
  });

  it('does not write a stale local migration over an identity rekey', async () => {
    const snapshot = deferred<SessionSnapshotEntry[]>();
    let firstStorageRead = true;
    const sessions: SessionSnapshotEntry[] = [{
      legacyAccountId: 'legacy',
      resolvedAccountId: 'canonical',
      username: 'creator',
      displayName: 'Creator',
      connected: true,
      lastSeenAt: 20,
    }];

    await loadOptionsPage({
      state: makeState({
        accountMappings: { legacy: 'p1' },
        accountAliases: {},
        knownAccounts: ['legacy'],
      }),
      sessions: [],
      snapshotPromise: snapshot.promise,
      onStorageRead: () => {
        if (!firstStorageRead) {
          return;
        }
        firstStorageRead = false;

        // storage.get has already captured the legacy snapshot. Complete the
        // background-owned rekey before that read resumes. A mutating initial
        // load would now persist its stale full state over this canonical one.
        queueMicrotask(() => {
          currentState = makeState({
            accountMappings: { canonical: 'p1' },
            accountAliases: { legacy: 'canonical' },
            knownAccounts: ['canonical'],
          });
          snapshot.resolve(sessions);
        });
      },
    });

    expect(currentState.accountMappings).toEqual({ canonical: 'p1' });
    expect(currentState.accountAliases).toEqual({ legacy: 'canonical' });
    expect(currentState.knownAccounts).toEqual(['canonical']);
    expect(getSectionByTitle('Аккаунты').textContent).toContain('ID аккаунта: canonical');
    expect(getSectionByTitle('Аккаунты').textContent).not.toContain('ID аккаунта: legacy');
  });

  it('keeps local settings usable and marks only account sections failed when session loading rejects', async () => {
    const snapshot = deferred<SessionSnapshotEntry[]>();
    await loadOptionsPage({
      state: makeState({ knownAccounts: ['offline-account'] }),
      sessions: [],
      snapshotPromise: snapshot.promise,
      waitForHydration: false,
    });

    const quickInput = document.querySelector<HTMLInputElement>('input[type="number"][max="200"]')!;
    expect(quickInput.value).toBe('30');

    snapshot.reject(new Error('Fansly identity timed out'));
    await vi.waitFor(() => {
      expect(getSectionByTitle('Аккаунты').dataset.sessionHydration).toBe('failed');
    });

    expect(getSectionByTitle('Аккаунты').textContent).toContain('ID аккаунта: offline-account');
    expect(getSectionByTitle('Аккаунты').textContent)
      .toContain('Не удалось обновить живой статус аккаунтов');
    // Hydration failed: the capture line must NOT assert a proven "нет сессии"
    // (a claim we never verified). It shows the honest unknown state and skips
    // the ticker because no dataset.captureAt is stamped.
    expect(getSectionByTitle('Аккаунты').textContent).toContain('статус неизвестен');
    expect(getSectionByTitle('Аккаунты').textContent).not.toContain('нет сессии');
    expect(document.body.contains(quickInput)).toBe(true);

    quickInput.value = '40';
    quickInput.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(currentState.settings.quickMessageCount).toBe(40);
    }, { timeout: 2000 });
  });

  it('renders one merged Аккаунты section with capture status and no Connection Status', async () => {
    await loadOptionsPage({
      state: makeState({ knownAccounts: ['acc-1'] }),
      sessions: [
        {
          legacyAccountId: 'legacy',
          resolvedAccountId: 'acc-1',
          username: 'creator',
          displayName: 'Creator',
          connected: true,
          lastSeenAt: Date.now(),
        },
      ],
    });
    const section = getSectionByTitle('Аккаунты');
    expect(section.dataset.sessionHydration).toBe('ready');
    expect(section.textContent).toContain('захвачена');
    expect(section.querySelector('[data-role="mapping-info"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('Connection Status');
  });

  it('newest session snapshot wins for a duplicated account id', async () => {
    // ORDER IS THE TEST: the NEWER (connected, larger lastSeenAt) session is
    // FIRST, the older disconnected one SECOND. Last-wins picks the second
    // (disconnected → "нет сессии") and fails; newest-wins keeps the first.
    await loadOptionsPage({
      state: makeState({ knownAccounts: ['resolved'] }),
      sessions: [
        {
          legacyAccountId: 'legacy-newer',
          resolvedAccountId: 'resolved',
          username: 'newer',
          displayName: 'Newer',
          connected: true,
          lastSeenAt: Date.now(),
        },
        {
          legacyAccountId: 'legacy-older',
          resolvedAccountId: 'resolved',
          username: 'older',
          displayName: 'Older',
          connected: false,
          lastSeenAt: Date.now() - 60 * 60_000,
        },
      ],
    });
    const section = getSectionByTitle('Аккаунты');
    expect(section.textContent).toContain('захвачена');
  });

  it('unmapped account carries the amber AI badge next to identity', async () => {
    await loadOptionsPage({
      state: makeState({ knownAccounts: ['acc-1'], accountMappings: {} }),
      sessions: [],
    });
    const badge = getSectionByTitle('Аккаунты').querySelector('.chatgoose-badge-amber');
    expect(badge?.textContent).toBe('AI отключён');
  });

  it('reticks each capture line from its stored timestamp as minutes pass', async () => {
    // Fake timers must be active BEFORE the page mounts so the section's
    // window.setInterval is created under them (an interval scheduled under
    // real timers is invisible to advanceTimers). shouldAdvanceTime keeps the
    // harness's vi.waitFor progressing during hydration.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const base = Date.now();
    await loadOptionsPage({
      state: makeState({ knownAccounts: ['acc-1'] }),
      sessions: [
        {
          legacyAccountId: 'legacy',
          resolvedAccountId: 'acc-1',
          username: 'creator',
          displayName: 'Creator',
          connected: true,
          lastSeenAt: base,
        },
      ],
    });
    const captureLine = getSectionByTitle('Аккаунты')
      .querySelector<HTMLElement>('[data-role="capture-status"]')!;
    expect(captureLine.textContent).toBe('захвачена только что');

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(captureLine.textContent).toBe('захвачена 5 мин назад');
  });
});

describe('Options page settings and read-only personas', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders server metadata without persona authoring controls or legacy writes', async () => {
    const legacy = [{ id: 'p1', name: 'Legacy name', content: 'secret text', updatedAt: 1 }];
    await loadOptionsPage({
      state: makeState({
        personalities: legacy,
      }),
      sessions: [],
    });

    const section = getSectionByTitle('Персоны');
    expect(section.textContent).toContain('Closer');
    // P3 human row: mono version badge replaces the raw «версия 1» meta line.
    expect(section.querySelector('[data-persona-key="p1"] .chatgoose-badge-mono')?.textContent)
      .toBe('v1');
    expect(section.querySelector('input[data-role="name"]')).toBeNull();
    expect(section.querySelector('textarea[data-role="content"]')).toBeNull();
    expect(Array.from(section.querySelectorAll('button')).map((button) => button.textContent))
      .not.toContain('Add Personality');
    expect(currentState.personalities).toEqual(legacy);
  });

  it('updates an open page when an admin archives a server persona', async () => {
    await loadOptionsPage({
      state: makeState({
        accountMappings: { account: 'p1' },
        knownAccounts: ['account'],
      }),
      sessions: [],
    });

    currentState = {
      ...currentState,
      personaCatalog: [{
        key: 'p1',
        displayName: 'Closer',
        definitionId: 'v1:persona-one-archived',
        version: 2,
        status: 'archived',
      }],
    };
    emitStorageChanges({
      personaCatalog: {
        oldValue: [{ key: 'p1', displayName: 'Closer', definitionId: 'v1:persona-one-definition', version: 1, status: 'active' }],
        newValue: currentState.personaCatalog,
      },
    });

    await vi.waitFor(() => {
      // Archived-and-still-referenced → dimmed row + mono v2 + replacement hint.
      const row = getSectionByTitle('Персоны').querySelector<HTMLElement>('[data-persona-key="p1"]');
      expect(row?.className).toContain('chatgoose-persona-row-archived');
      expect(row?.textContent).toContain('в архиве · выбери замену');
    });
    expect(getSectionByTitle('Персоны')
      .querySelector('[data-persona-key="p1"] .chatgoose-badge-mono')?.textContent).toBe('v2');
    const mappingSelect = getSectionByTitle('Аккаунты')
      .querySelector<HTMLSelectElement>('select[data-account-id="account"]')!;
    const archivedOption = Array.from(mappingSelect.options)
      .find((option) => option.value === 'p1');
    expect(archivedOption?.disabled).toBe(true);
    expect(mappingSelect.closest('[data-account-mapping-row]')?.textContent)
      .toContain('недоступна');
    expect(currentState.accountMappings).toEqual({ account: 'p1' });
  });

  it.each([
    'settings',
    'agencyHubDeviceToken',
    'agencyHubApiKey',
  ] as const)(
    'drops source-A catalog rows immediately when the Hub source changes via %s',
    async (sourceChangeKey) => {
      const usesLegacyKey = sourceChangeKey === 'agencyHubApiKey';
      const settingsA = {
        ...makeState().settings,
        agencyHubBaseUrl: 'https://hub-a.example.test',
        agencyHubDeviceToken: usesLegacyKey ? '' : 'device-a',
        agencyHubApiKey: usesLegacyKey ? 'legacy-a' : '',
      };
      await loadOptionsPage({
        state: makeState({
          settings: settingsA,
          personaCatalog: [{
            key: 'source-a-persona',
            displayName: 'Source A',
            definitionId: 'v1:source-a-persona',
            version: 1,
            status: 'active',
          }],
          personaCatalogSource: personaCatalogSource(settingsA),
          personaCatalogFetchedAt: '2026-07-13T12:00:00.000Z',
          accountMappings: { account: 'source-a-persona' },
          knownAccounts: ['account'],
        }),
        sessions: [],
      });

      expect(getSectionByTitle('Персоны').textContent).toContain('Source A');

      let changes: Record<string, browser.storage.StorageChange>;
      if (sourceChangeKey === 'settings') {
        const settingsB = {
          ...settingsA,
          agencyHubBaseUrl: 'https://hub-b.example.test',
        };
        currentState = { ...currentState, settings: settingsB };
        changes = {
          settings: { oldValue: settingsA, newValue: settingsB },
        };
      } else {
        const nextCredential = sourceChangeKey === 'agencyHubDeviceToken'
          ? 'device-b'
          : 'legacy-b';
        (currentState as unknown as Record<string, unknown>)[sourceChangeKey] = nextCredential;
        changes = {
          [sourceChangeKey]: {
            oldValue: sourceChangeKey === 'agencyHubDeviceToken' ? 'device-a' : 'legacy-a',
            newValue: nextCredential,
          },
        };
      }

      // No personaCatalog* event follows: this models the background refresh
      // being queued behind a hung source-A request. The normalized storage
      // read itself must enforce the source fence for the open Options page.
      emitStorageChanges(changes);

      await vi.waitFor(() => {
        // Rotated to source B without a catalog event: the stored source (A) no
        // longer matches, so the source-A rows drop and an honest empty state
        // (never «персона удалена») replaces them.
        expect(getSectionByTitle('Персоны')
          .querySelector('[data-persona-key="source-a-persona"]')).toBeNull();
      });
      const droppedSection = getSectionByTitle('Персоны').textContent ?? '';
      expect(droppedSection).not.toContain('Source A');
      expect(droppedSection).not.toContain('удалена');

      const mappingSelect = getSectionByTitle('Аккаунты')
        .querySelector<HTMLSelectElement>('select[data-account-id="account"]')!;
      const unresolved = Array.from(mappingSelect.options)
        .find((option) => option.value === 'source-a-persona');
      expect(unresolved?.disabled).toBe(true);
      expect(unresolved?.textContent).toContain('Персона недоступна');
      expect(currentState.accountMappings).toEqual({ account: 'source-a-persona' });
    },
  );

  async function loadRotatableCatalogPage(): Promise<{
    settingsA: PersistedState['settings'];
    settingsB: PersistedState['settings'];
  }> {
    const settingsA = {
      ...makeState().settings,
      agencyHubBaseUrl: 'https://hub-a.example.test',
      agencyHubDeviceToken: 'device-a',
    };
    await loadOptionsPage({
      state: makeState({
        settings: settingsA,
        personaCatalog: [{
          key: 'source-a-persona',
          displayName: 'Source A',
          definitionId: 'v1:source-a-persona',
          version: 1,
          status: 'active',
        }],
        personaCatalogSource: personaCatalogSource(settingsA),
        personaCatalogFetchedAt: '2026-07-13T12:00:00.000Z',
        accountMappings: {},
        knownAccounts: [],
      }),
      sessions: [],
    });
    expect(getSectionByTitle('Персоны').textContent).toContain('Source A');
    return { settingsA, settingsB: { ...settingsA, agencyHubDeviceToken: 'device-b' } };
  }

  it('a live rotation to an unconfirmed source reports «ещё не загружен», never «пустой каталог»', async () => {
    const { settingsA, settingsB } = await loadRotatableCatalogPage();

    // Rotation performed elsewhere: the new creds and the cleared catalog land
    // together — new source, empty catalog, fetchedAt null (the clearForSource
    // triple, exactly what a still-in-flight or failed refresh leaves behind).
    currentState = {
      ...currentState,
      settings: settingsB,
      personaCatalog: [],
      personaCatalogSource: personaCatalogSource(settingsB),
      personaCatalogFetchedAt: null,
    };
    emitStorageChanges({
      settings: { oldValue: settingsA, newValue: settingsB },
      [PERSONA_CATALOG_STORAGE_KEY]: { oldValue: [{ key: 'source-a-persona' }], newValue: [] },
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: {
        oldValue: personaCatalogSource(settingsA),
        newValue: personaCatalogSource(settingsB),
      },
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: { oldValue: '2026-07-13T12:00:00.000Z', newValue: null },
    });

    await vi.waitFor(() => {
      expect(getSectionByTitle('Персоны')
        .querySelector('[data-role="persona-empty"]')?.textContent)
        .toContain('ещё не загружен');
    });
    expect(getSectionByTitle('Персоны').textContent ?? '').not.toContain('пустой каталог');
    expect(getSectionByTitle('Персоны').textContent ?? '').not.toContain('Source A');
  });

  it('a live rotation whose refresh confirms an empty catalog reports «пустой каталог» (fresh settings, honest verdict)', async () => {
    const { settingsA, settingsB } = await loadRotatableCatalogPage();

    // Same rotation, but this time the background refresh COMPLETED and confirmed
    // an empty catalog for the new creds — fetchedAt is stamped. The verdict must
    // flip to «пустой каталог», which is only correct if the handler adopted the
    // fresh settings (a stale source would keep it stuck on «ещё не загружен»).
    currentState = {
      ...currentState,
      settings: settingsB,
      personaCatalog: [],
      personaCatalogSource: personaCatalogSource(settingsB),
      personaCatalogFetchedAt: '2026-07-13T13:00:00.000Z',
    };
    emitStorageChanges({
      settings: { oldValue: settingsA, newValue: settingsB },
      [PERSONA_CATALOG_SOURCE_STORAGE_KEY]: {
        oldValue: personaCatalogSource(settingsA),
        newValue: personaCatalogSource(settingsB),
      },
      [PERSONA_CATALOG_FETCHED_AT_STORAGE_KEY]: {
        oldValue: '2026-07-13T12:00:00.000Z',
        newValue: '2026-07-13T13:00:00.000Z',
      },
    });

    await vi.waitFor(() => {
      expect(getSectionByTitle('Персоны')
        .querySelector('[data-role="persona-empty"]')?.textContent)
        .toContain('пустой каталог');
    });
  });

  it('copies a complete legacy JSON export including raw persona text and mappings', async () => {
    await loadOptionsPage({ state: makeState({ accountMappings: { creator: 'p1' } }), sessions: [] });
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const section = getSectionByTitle('Персоны');
    const copy = Array.from(section.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Скопировать JSON легаси-персон')!;
    copy.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const exported = JSON.parse(writeText.mock.calls[0]![0]);
    expect(exported.preservedSnapshot.raw.personalities[0].content).toBe('be nice');
    expect(exported.currentLegacyData.accountMappings).toEqual({ creator: 'p1' });
  });

  it('flushes a settings edit on blur without waiting for the debounce timer', async () => {
    await loadOptionsPage({ state: makeState(), sessions: [] });
    vi.useFakeTimers();

    const quickInput = document.querySelector<HTMLInputElement>('input[type="number"][max="200"]')!;
    quickInput.value = '77';
    quickInput.dispatchEvent(new Event('input', { bubbles: true }));
    quickInput.dispatchEvent(new dom.window.FocusEvent('blur'));
    await flushMicrotasks();

    expect(currentState.settings.quickMessageCount).toBe(77);
  });

  it('starts the pending settings write synchronously on pagehide', async () => {
    await loadOptionsPage({ state: makeState(), sessions: [] });
    vi.useFakeTimers();

    const quickInput = document.querySelector<HTMLInputElement>('input[type="number"][max="200"]')!;
    quickInput.value = '88';
    quickInput.dispatchEvent(new Event('input', { bubbles: true }));
    const storageSet = vi.mocked(browser.storage.local.set);
    const callsBeforePageHide = storageSet.mock.calls.length;

    window.dispatchEvent(new Event('pagehide'));

    expect(storageSet.mock.calls.length).toBeGreaterThan(callsBeforePageHide);
    await flushMicrotasks();
    expect(currentState.settings.quickMessageCount).toBe(88);
  });

  it('starts the latest settings write on pagehide while an older write is still pending', async () => {
    await loadOptionsPage({
      state: makeState(),
      sessions: [],
    });
    stallNextStorageSet?.();
    vi.useFakeTimers();

    const quickInput = document.querySelector<HTMLInputElement>('input[type="number"][max="200"]')!;
    const storageSet = vi.mocked(browser.storage.local.set);
    const callsBeforeEdit = storageSet.mock.calls.length;
    quickInput.value = '44';
    quickInput.dispatchEvent(new Event('input', { bubbles: true }));
    quickInput.dispatchEvent(new dom.window.FocusEvent('blur'));
    expect(storageSet).toHaveBeenCalledTimes(callsBeforeEdit + 1);

    quickInput.value = '99';
    quickInput.dispatchEvent(new Event('input', { bubbles: true }));
    window.dispatchEvent(new Event('pagehide'));

    // The close-path snapshot must invoke storage.set directly, not wait on
    // the unresolved promise belonging to the first write.
    expect(storageSet).toHaveBeenCalledTimes(callsBeforeEdit + 2);
    expect(currentState.settings.quickMessageCount).toBe(99);
    releaseFirstStorageSet?.();
    await flushMicrotasks();
    expect(currentState.settings.quickMessageCount).toBe(99);
  });

  it('cancels queued and pagehide writes after observing a future storage schema', async () => {
    await loadOptionsPage({ state: makeState(), sessions: [] });
    stallNextStorageSet?.();
    vi.useFakeTimers();

    const quickInput = document.querySelector<HTMLInputElement>('input[type="number"][max="200"]')!;
    const storageSet = vi.mocked(browser.storage.local.set);
    const callsBeforeEdit = storageSet.mock.calls.length;

    quickInput.value = '44';
    quickInput.dispatchEvent(new Event('input', { bubbles: true }));
    quickInput.dispatchEvent(new dom.window.FocusEvent('blur'));
    expect(storageSet).toHaveBeenCalledTimes(callsBeforeEdit + 1);

    // This snapshot is serialized behind the stalled write. The future-schema
    // event must cancel it when the chain eventually reaches persist().
    quickInput.value = '99';
    quickInput.dispatchEvent(new Event('input', { bubbles: true }));
    quickInput.dispatchEvent(new dom.window.FocusEvent('blur'));
    currentState = {
      ...currentState,
      schemaVersion: STORAGE_SCHEMA_VERSION + 1,
    };
    emitStorageChanges({
      schemaVersion: {
        oldValue: STORAGE_SCHEMA_VERSION,
        newValue: STORAGE_SCHEMA_VERSION + 1,
      },
    });

    const barrier = document.querySelector<HTMLElement>('[data-future-schema-barrier="true"]');
    expect(barrier?.getAttribute('role')).toBe('alert');
    expect(quickInput.disabled).toBe(true);

    releaseFirstStorageSet?.();
    await flushMicrotasks();
    expect(storageSet).toHaveBeenCalledTimes(callsBeforeEdit + 1);

    // The synchronous close path is fenced by the same observation.
    window.dispatchEvent(new Event('pagehide'));
    expect(storageSet).toHaveBeenCalledTimes(callsBeforeEdit + 1);
  });

  it('future-schema catch-up during the initial read still disables the section controls', async () => {
    // Initial-read path (vs the listener path above): the future-schema
    // listener is installed BEFORE the first readStorageState(). Emitting a v15
    // change while that read is in flight sets futureSchemaObserved before the
    // barrier block runs its synchronous catch-up, which disables controls via
    // root.querySelectorAll — so the sections must already be mounted in `root`
    // at that moment. This regression guards the ordered registration block
    // staying anchored before the barrier: move it after and the catch-up's
    // one-shot sweep finds no real controls, leaving them silently enabled.
    //
    // Emit only the change event, never mutate the stored schemaVersion: a v15
    // in the record would make migrateState throw on the very read being hooked.
    // Gate on storageChangeListeners so the emit lands on the first read AFTER
    // the future-schema listener registers (the pre-listener snapshot read would
    // otherwise swallow it), and only once.
    let armed = false;
    await loadOptionsPage({
      state: makeState(),
      sessions: [],
      onStorageRead: () => {
        if (armed || storageChangeListeners.size === 0) {
          return;
        }
        armed = true;
        emitStorageChanges({
          schemaVersion: {
            oldValue: STORAGE_SCHEMA_VERSION,
            newValue: STORAGE_SCHEMA_VERSION + 1,
          },
        });
      },
    });

    expect(document.querySelector('[data-future-schema-barrier="true"]')?.getAttribute('role'))
      .toBe('alert');
    const quickInput = getSectionByTitle('Генерация').querySelector('input') as HTMLInputElement;
    expect(quickInput.disabled).toBe(true);
  });

  it('makes a Hub test wait for the active shared settings save without writing twice', async () => {
    await loadOptionsPage({
      state: makeState({
        settings: {
          ...makeState().settings,
          agencyHubBaseUrl: 'https://hub.example.test',
          agencyHubApiKey: 'key',
        },
      }),
      sessions: [],
    });
    stallNextStorageSet?.();

    const quickInput = document.querySelector<HTMLInputElement>('input[type="number"][max="200"]')!;
    const storageSet = vi.mocked(browser.storage.local.set);
    const callsBeforeEdit = storageSet.mock.calls.length;
    quickInput.value = '71';
    quickInput.dispatchEvent(new Event('input', { bubbles: true }));
    quickInput.dispatchEvent(new dom.window.FocusEvent('blur'));

    expect(storageSet).toHaveBeenCalledTimes(callsBeforeEdit + 1);
    const testButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Проверить соединение')!;
    testButton.click();
    await flushMicrotasks();

    // The Hub action joins the active chain. It must not start a competing
    // read-modify-write or enqueue an identical second form snapshot.
    expect(storageSet).toHaveBeenCalledTimes(callsBeforeEdit + 1);
    releaseFirstStorageSet?.();
    await flushMicrotasks();
    expect(storageSet).toHaveBeenCalledTimes(callsBeforeEdit + 1);
    expect(currentState.settings.quickMessageCount).toBe(71);
  });

  it('keeps a freshly issued device token when an older form save acknowledges later', async () => {
    const issueResponse = deferred<{
      ok: true;
      keyPrefix: string;
      label: string;
      expiresAt: number;
    }>();
    const connectionTokens: string[] = [];
    await loadOptionsPage({
      state: makeState({
        settings: {
          ...makeState().settings,
          agencyHubBaseUrl: 'https://hub.example.test',
        },
      }),
      sessions: [],
      onRuntimeRequest: async (message) => {
        const request = message as {
          type?: string;
          settings?: { agencyHubDeviceToken?: string };
        };
        if (request.type === 'issueAgencyHubDeviceToken') {
          return await issueResponse.promise;
        }
        if (request.type === 'testAgencyHubConnection') {
          connectionTokens.push(request.settings?.agencyHubDeviceToken ?? '');
          return { ok: true };
        }
        return undefined;
      },
    });

    const username = document.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
    const password = document.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
    const signIn = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Войти и выпустить token')!;
    username.value = 'owner';
    password.value = 'secret';
    signIn.click();
    await vi.waitFor(() => {
      expect(vi.mocked(browser.runtime.sendMessage).mock.calls.some(
        ([message]) => (message as { type?: string }).type === 'issueAgencyHubDeviceToken',
      )).toBe(true);
    });

    // Start a local form write after sign-in has begun, and hold only its ack.
    // The background can issue/store the custody token while this promise is pending.
    stallNextStorageSet?.();
    const quickInput = document.querySelector<HTMLInputElement>('input[type="number"][max="200"]')!;
    quickInput.value = '72';
    quickInput.dispatchEvent(new Event('input', { bubbles: true }));
    quickInput.dispatchEvent(new dom.window.FocusEvent('blur'));

    (currentState as unknown as Record<string, unknown>).agencyHubDeviceToken = 'device-token-new';
    issueResponse.resolve({
      ok: true,
      keyPrefix: 'device-new',
      label: 'Firefox',
      expiresAt: Date.now() + 86_400_000,
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain('Device token активен');
    });

    releaseFirstStorageSet?.();
    await flushMicrotasks();

    const testButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Проверить соединение')!;
    await vi.waitFor(() => expect(testButton.disabled).toBe(false));
    testButton.click();
    await vi.waitFor(() => {
      expect(connectionTokens.at(-1)).toBe('device-token-new');
    });
    expect(document.body.textContent).toContain('Device token активен');
  });

  it('does not rewrite a rotated API-key custody value from an unrelated count edit', async () => {
    await loadOptionsPage({
      state: makeState({
        settings: {
          ...makeState().settings,
          agencyHubBaseUrl: 'https://hub.example.test',
          agencyHubApiKey: 'stale-visible-key',
        },
      }),
      sessions: [],
    });
    (currentState as unknown as Record<string, unknown>).agencyHubApiKey = 'rotated-key';

    const storageSet = vi.mocked(browser.storage.local.set);
    const callsBeforeEdit = storageSet.mock.calls.length;
    const quickInput = document.querySelector<HTMLInputElement>('input[type="number"][max="200"]')!;
    quickInput.value = '73';
    quickInput.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => expect(storageSet.mock.calls.length).toBeGreaterThan(callsBeforeEdit));
    const formWrite = storageSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(formWrite, 'agencyHubApiKey')).toBe(false);
    expect((currentState as unknown as Record<string, unknown>).agencyHubApiKey).toBe('rotated-key');
  });

  it('does write the API-key custody value after an explicit key-field edit', async () => {
    await loadOptionsPage({
      state: makeState({
        settings: {
          ...makeState().settings,
          agencyHubBaseUrl: 'https://hub.example.test',
          agencyHubApiKey: 'old-key',
        },
      }),
      sessions: [],
    });

    const storageSet = vi.mocked(browser.storage.local.set);
    const callsBeforeEdit = storageSet.mock.calls.length;
    const keyInput = getSectionByTitle('Agency Hub')
      .querySelector<HTMLInputElement>('input[type="password"][autocomplete="off"]')!;
    keyInput.value = 'new-key';
    keyInput.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => expect(storageSet.mock.calls.length).toBeGreaterThan(callsBeforeEdit));
    const formWrite = storageSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(formWrite.agencyHubApiKey).toBe('new-key');
  });

  it('does not resurrect a legacy API key after another Options tab signs out', async () => {
    await loadOptionsPage({
      state: makeState({
        settings: {
          ...makeState().settings,
          agencyHubBaseUrl: 'https://hub.example.test',
          agencyHubApiKey: 'legacy-key',
          agencyHubDeviceToken: 'device-token',
        },
      }),
      sessions: [],
    });

    const keyInput = getSectionByTitle('Agency Hub')
      .querySelector<HTMLInputElement>('input[type="password"][autocomplete="off"]')!;
    expect(keyInput.value).toBe('legacy-key');

    // The background wipe from tab B is already durable when tab A receives
    // this event. Its old form snapshot must immediately stop owning the key.
    (currentState as unknown as Record<string, unknown>)[AGENCY_HUB_API_KEY_STORAGE_KEY] = '';
    (currentState as unknown as Record<string, unknown>)[AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY] = '';
    emitStorageChanges({
      [AGENCY_HUB_API_KEY_STORAGE_KEY]: { oldValue: 'legacy-key', newValue: '' },
      [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: { oldValue: 'device-token', newValue: '' },
    });
    await flushMicrotasks();

    const storageSet = vi.mocked(browser.storage.local.set);
    storageSet.mockClear();
    const grantButton = Array.from(
      getSectionByTitle('Agency Hub').querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Разрешить доступ')!;
    grantButton.click();

    await vi.waitFor(() => expect(storageSet).toHaveBeenCalled());
    expect(keyInput.value).toBe('');
    expect(getSectionByTitle('Agency Hub')
      .querySelector<HTMLElement>('[data-role="hub-signed-in"]')?.hidden).toBe(true);
    expect(storageSet.mock.calls.every(([items]) => !Object.prototype.hasOwnProperty.call(
      items,
      AGENCY_HUB_API_KEY_STORAGE_KEY,
    ))).toBe(true);
    expect((currentState as unknown as Record<string, unknown>)[AGENCY_HUB_API_KEY_STORAGE_KEY])
      .toBe('');
  });

  it('retries an explicitly edited API key with the next unrelated settings save after a transient failure', async () => {
    await loadOptionsPage({
      state: makeState({
        settings: {
          ...makeState().settings,
          agencyHubBaseUrl: 'https://hub.example.test',
          agencyHubApiKey: 'old-key',
        },
      }),
      sessions: [],
    });

    failNextStorageSet?.();
    const storageSet = vi.mocked(browser.storage.local.set);
    const keyInput = getSectionByTitle('Agency Hub')
      .querySelector<HTMLInputElement>('input[type="password"][autocomplete="off"]')!;
    keyInput.value = 'new-key';
    keyInput.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();
    expect((currentState as unknown as Record<string, unknown>).agencyHubApiKey)
      .not.toBe('new-key');

    const quickInput = document.querySelector<HTMLInputElement>('input[type="number"][max="200"]')!;
    quickInput.value = '74';
    quickInput.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect((currentState as unknown as Record<string, unknown>).agencyHubApiKey)
        .toBe('new-key');
      expect(currentState.settings.quickMessageCount).toBe(74);
    });
    const retryWrite = storageSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(retryWrite.agencyHubApiKey).toBe('new-key');
  });

  it('retries a failed explicit API-key write on pagehide without another edit', async () => {
    await loadOptionsPage({
      state: makeState({
        settings: {
          ...makeState().settings,
          agencyHubBaseUrl: 'https://hub.example.test',
          agencyHubApiKey: 'old-key',
        },
      }),
      sessions: [],
    });

    failNextStorageSet?.();
    const storageSet = vi.mocked(browser.storage.local.set);
    const keyInput = getSectionByTitle('Agency Hub')
      .querySelector<HTMLInputElement>('input[type="password"][autocomplete="off"]')!;
    keyInput.value = 'new-key';
    keyInput.dispatchEvent(new Event('change', { bubbles: true }));
    await flushMicrotasks();
    const callsBeforePageHide = storageSet.mock.calls.length;

    window.dispatchEvent(new Event('pagehide'));

    expect(storageSet.mock.calls.length).toBe(callsBeforePageHide + 1);
    const retryWrite = storageSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(retryWrite.agencyHubApiKey).toBe('new-key');
    await flushMicrotasks();
    expect((currentState as unknown as Record<string, unknown>).agencyHubApiKey)
      .toBe('new-key');
  });

  it('does not let an older API-key acknowledgement clear a newer explicit key snapshot', async () => {
    await loadOptionsPage({
      state: makeState({
        settings: {
          ...makeState().settings,
          agencyHubBaseUrl: 'https://hub.example.test',
          agencyHubApiKey: 'old-key',
        },
      }),
      sessions: [],
    });

    stallNextStorageSet?.();
    const keyInput = getSectionByTitle('Agency Hub')
      .querySelector<HTMLInputElement>('input[type="password"][autocomplete="off"]')!;
    keyInput.value = 'first-new-key';
    keyInput.dispatchEvent(new Event('change', { bubbles: true }));

    keyInput.value = 'final-new-key';
    keyInput.dispatchEvent(new Event('change', { bubbles: true }));
    releaseFirstStorageSet?.();

    await vi.waitFor(() => {
      expect((currentState as unknown as Record<string, unknown>).agencyHubApiKey)
        .toBe('final-new-key');
    });
    expect(keyInput.value).toBe('final-new-key');
  });

  it('disambiguates duplicate personality names in the mapping dropdown', async () => {
    await loadOptionsPage({
      state: makeState({
        personaCatalog: [
          { key: 'aaaaaa11', displayName: 'Luna', definitionId: 'v1:luna-persona-one', version: 1, status: 'active' },
          { key: 'bbbbbb22', displayName: 'Luna', definitionId: 'v1:luna-persona-two', version: 2, status: 'active' },
        ],
        knownAccounts: ['acc-1'],
      }),
      sessions: [],
    });

    const section = getSectionByTitle('Аккаунты');
    const lunaOptions = Array.from(section.querySelectorAll('option'))
      .map((option) => option.textContent)
      .filter((text) => text?.startsWith('Luna'));
    expect(lunaOptions).toContain('Luna · aaaaaa');
    expect(lunaOptions).toContain('Luna · bbbbbb');
  });

  it('keeps an archived mapping selected and disabled without pruning it', async () => {
    await loadOptionsPage({
      state: makeState({
        personaCatalog: [{ key: 'p1', displayName: 'Closer', definitionId: 'v1:persona-one-archived', version: 2, status: 'archived' }],
        knownAccounts: ['acc-1'],
        accountMappings: { 'acc-1': 'p1' },
      }),
      sessions: [],
    });
    const mappingSection = getSectionByTitle('Аккаунты');
    const mappingSelect = mappingSection.querySelector<HTMLSelectElement>('select')!;
    expect(mappingSelect.value).toBe('p1');
    expect(mappingSelect.querySelector<HTMLOptionElement>('option[value="p1"]')?.disabled)
      .toBe(true);
    expect(mappingSection.querySelector<HTMLElement>('[data-role="mapping-info"]')?.textContent)
      .toContain('недоступна');
    expect(currentState.accountMappings).toEqual({ 'acc-1': 'p1' });
  });

  it('writes the clamped message count back into an unfocused field', async () => {
    await loadOptionsPage({ state: makeState(), sessions: [] });

    const deepInput = document.querySelector<HTMLInputElement>('input[type="number"][max="3000"]')!;
    expect(deepInput).toBeTruthy();

    deepInput.value = '9999';
    deepInput.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(currentState.settings.deepMessageCount).toBe(3000);
    }, { timeout: 2000 });

    // The field reflects the clamped value, not the rejected 9999.
    await vi.waitFor(() => expect(deepInput.value).toBe('3000'));
  });

  it('updates a mapping without mutating the raw legacy persona array', async () => {
    await loadOptionsPage({
      state: makeState({
        knownAccounts: ['acc-1'],
      }),
      sessions: [],
    });

    const legacyBefore = structuredClone(currentState.personalities);

    const mappingSelect = getSectionByTitle('Аккаунты')
      .querySelector<HTMLSelectElement>('select')!;
    mappingSelect.value = 'p1';
    mappingSelect.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(currentState.accountMappings['acc-1']).toBe('p1');
    });
    expect(currentState.personalities).toEqual(legacyBefore);
  });
});
