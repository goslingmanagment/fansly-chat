import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
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
      coachHistoryLimit: 10,
      coachAutoRecap: 'off',
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
    getSectionByTitle('Connection Status');
  }, { timeout: 2000 });
  if (options.waitForHydration !== false) {
    await vi.waitFor(() => {
      expect(getSectionByTitle('Connection Status').dataset.sessionHydration).toBe('ready');
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

    const mappingsSection = getSectionByTitle('Account Mappings');
    const connectionSection = getSectionByTitle('Connection Status');

    expect(callOrder.slice(0, 2)).toEqual(['storage', 'snapshot']);
    expect(mappingsSection.textContent).toContain('Account ID: active-resolved');
    expect(mappingsSection.textContent).toContain('Account ID: mappedOffline');
    expect(mappingsSection.textContent).not.toContain('stale');
    expect(connectionSection.textContent).toContain('Account ID: active-resolved');
    expect(connectionSection.textContent).not.toContain('mappedOffline');
    expect(connectionSection.textContent).not.toContain('stale');
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

    const personalityCard = getSectionByTitle('Model Personalities')
      .querySelector<HTMLElement>('[data-persona-key="p1"]')!;
    const connectionSection = getSectionByTitle('Connection Status');
    const mappingsSection = getSectionByTitle('Account Mappings');

    expect(personalityCard.textContent).toContain('Closer');
    expect(connectionSection.dataset.sessionHydration).toBe('loading');
    expect(connectionSection.textContent).toContain('Loading live connection status');
    expect(mappingsSection.dataset.sessionHydration).toBe('loading');
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
      expect(connectionSection.dataset.sessionHydration).toBe('ready');
      expect(mappingsSection.textContent).toContain('Account ID: canonical');
    });

    // Session hydration must not rebuild unrelated catalog UI.
    expect(getSectionByTitle('Model Personalities')
      .querySelector('[data-persona-key="p1"]')).toBe(personalityCard);
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
    expect(getSectionByTitle('Account Mappings').textContent).toContain('Account ID: canonical');
    expect(getSectionByTitle('Account Mappings').textContent).not.toContain('Account ID: legacy');
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
      expect(getSectionByTitle('Connection Status').dataset.sessionHydration).toBe('failed');
      expect(getSectionByTitle('Account Mappings').dataset.sessionHydration).toBe('failed');
    });

    expect(getSectionByTitle('Account Mappings').textContent).toContain('Account ID: offline-account');
    expect(getSectionByTitle('Connection Status').textContent).toContain('Could not load live connection status');
    expect(document.body.contains(quickInput)).toBe(true);

    quickInput.value = '40';
    quickInput.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => {
      expect(currentState.settings.quickMessageCount).toBe(40);
    }, { timeout: 2000 });
  });

  it('dedupes connection status rows by canonical account id using the newest snapshot entry', async () => {
    await loadOptionsPage({
      state: makeState(),
      sessions: [
        {
          legacyAccountId: 'legacy-1',
          resolvedAccountId: 'resolved',
          username: 'older',
          displayName: 'Older',
          connected: true,
          lastSeenAt: 10,
        },
        {
          legacyAccountId: 'legacy-2',
          resolvedAccountId: 'resolved',
          username: 'newer',
          displayName: 'Newer',
          connected: true,
          lastSeenAt: 20,
        },
      ],
    });

    const connectionSection = getSectionByTitle('Connection Status');
    const cards = connectionSection.querySelectorAll('.chatgoose-card');

    expect(cards).toHaveLength(1);
    expect(connectionSection.textContent).toContain('Newer');
    expect(connectionSection.textContent).not.toContain('Older');
    expect(connectionSection.textContent).toContain('Account ID: resolved');
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

    const section = getSectionByTitle('Model Personalities');
    expect(section.textContent).toContain('Closer');
    expect(section.textContent).toContain('version 1');
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
      expect(getSectionByTitle('Model Personalities').textContent)
        .toContain('version 2 • archived');
    });
    const mappingSelect = getSectionByTitle('Account Mappings')
      .querySelector<HTMLSelectElement>('select[data-account-id="account"]')!;
    const archivedOption = Array.from(mappingSelect.options)
      .find((option) => option.value === 'p1');
    expect(archivedOption?.disabled).toBe(true);
    expect(mappingSelect.closest('[data-account-mapping-row]')?.textContent)
      .toContain('unavailable');
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

      expect(getSectionByTitle('Model Personalities').textContent).toContain('Source A');

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
        expect(getSectionByTitle('Model Personalities').textContent)
          .toContain('No server personas are available yet');
      });
      expect(getSectionByTitle('Model Personalities').textContent).not.toContain('Source A');

      const mappingSelect = getSectionByTitle('Account Mappings')
        .querySelector<HTMLSelectElement>('select[data-account-id="account"]')!;
      const unresolved = Array.from(mappingSelect.options)
        .find((option) => option.value === 'source-a-persona');
      expect(unresolved?.disabled).toBe(true);
      expect(unresolved?.textContent).toContain('Unavailable persona');
      expect(currentState.accountMappings).toEqual({ account: 'source-a-persona' });
    },
  );

  it('copies a complete legacy JSON export including raw persona text and mappings', async () => {
    await loadOptionsPage({ state: makeState({ accountMappings: { creator: 'p1' } }), sessions: [] });
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const section = getSectionByTitle('Model Personalities');
    const copy = Array.from(section.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Copy legacy persona JSON')!;
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
      .find((button) => button.textContent === 'Test Connection')!;
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
      .find((button) => button.textContent === 'Sign in & issue device token')!;
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
      expect(document.body.textContent).toContain('Device token active');
    });

    releaseFirstStorageSet?.();
    await flushMicrotasks();

    const testButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Test Connection')!;
    await vi.waitFor(() => expect(testButton.disabled).toBe(false));
    testButton.click();
    await vi.waitFor(() => {
      expect(connectionTokens.at(-1)).toBe('device-token-new');
    });
    expect(document.body.textContent).toContain('Device token active');
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

    const section = getSectionByTitle('Account Mappings');
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
    const mappingSection = getSectionByTitle('Account Mappings');
    const mappingSelect = mappingSection.querySelector<HTMLSelectElement>('select')!;
    expect(mappingSelect.value).toBe('p1');
    expect(mappingSelect.querySelector<HTMLOptionElement>('option[value="p1"]')?.disabled)
      .toBe(true);
    expect(mappingSection.querySelector<HTMLElement>('[data-role="mapping-info"]')?.textContent)
      .toContain('unavailable');
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

    const mappingSelect = getSectionByTitle('Account Mappings')
      .querySelector<HTMLSelectElement>('select')!;
    mappingSelect.value = 'p1';
    mappingSelect.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(currentState.accountMappings['acc-1']).toBe('p1');
    });
    expect(currentState.personalities).toEqual(legacyBefore);
  });
});

describe('Options page coach settings', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const getCoachMemoryInput = (): HTMLInputElement =>
    document.querySelector<HTMLInputElement>('input[type="number"][max="20"]')!;

  const getRecapSelect = (): HTMLSelectElement =>
    Array.from(document.querySelectorAll<HTMLSelectElement>('select')).find((select) =>
      Array.from(select.options).some((option) => option.value === 'full'),
    )!;

  const getRecapWarning = (): HTMLElement | null =>
    Array.from(
      getSectionByTitle('Generation').querySelectorAll<HTMLElement>('.chatgoose-section-desc'),
    ).find((node) => node.textContent?.includes('Full Recap loads up to 3000 messages')) ?? null;

  it('renders coach memory + auto-recap fields with stored defaults and a hidden warning', async () => {
    await loadOptionsPage({ state: makeState(), sessions: [] });

    const memoryInput = getCoachMemoryInput();
    expect(memoryInput).toBeTruthy();
    expect(memoryInput.min).toBe('1');
    expect(memoryInput.max).toBe('20');
    expect(memoryInput.value).toBe('10');

    const recapSelect = getRecapSelect();
    expect(recapSelect).toBeTruthy();
    expect(Array.from(recapSelect.options).map((option) => option.value)).toEqual([
      'off',
      'short',
      'full',
    ]);
    expect(recapSelect.value).toBe('off');

    const warning = getRecapWarning();
    expect(warning).toBeTruthy();
    expect(warning!.hidden).toBe(true);
  });

  it('reflects stored non-default coach settings on load (memory value + visible warning)', async () => {
    await loadOptionsPage({
      state: makeState({
        settings: {
          ...makeState().settings,
          coachHistoryLimit: 5,
          coachAutoRecap: 'full',
        },
      }),
      sessions: [],
    });

    expect(getCoachMemoryInput().value).toBe('5');
    const recapSelect = getRecapSelect();
    expect(recapSelect.value).toBe('full');
    expect(getRecapWarning()!.hidden).toBe(false);
  });

  it('persists an edited coach memory value through the settings patch', async () => {
    await loadOptionsPage({ state: makeState(), sessions: [] });

    const memoryInput = getCoachMemoryInput();
    memoryInput.value = '15';
    memoryInput.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(currentState.settings.coachHistoryLimit).toBe(15);
    }, { timeout: 2000 });
  });

  it('clamps and reflects an out-of-range coach memory value into the unfocused field', async () => {
    await loadOptionsPage({ state: makeState(), sessions: [] });

    const memoryInput = getCoachMemoryInput();
    memoryInput.value = '99';
    memoryInput.dispatchEvent(new Event('change', { bubbles: true }));

    await vi.waitFor(() => {
      expect(currentState.settings.coachHistoryLimit).toBe(20);
    }, { timeout: 2000 });
    await vi.waitFor(() => expect(memoryInput.value).toBe('20'));
  });

  it('persists the auto-recap choice and toggles the cost warning on change', async () => {
    await loadOptionsPage({ state: makeState(), sessions: [] });

    const recapSelect = getRecapSelect();
    const warning = getRecapWarning()!;
    expect(warning.hidden).toBe(true);

    recapSelect.value = 'full';
    recapSelect.dispatchEvent(new Event('change', { bubbles: true }));

    expect(warning.hidden).toBe(false);
    await vi.waitFor(() => {
      expect(currentState.settings.coachAutoRecap).toBe('full');
    }, { timeout: 2000 });

    recapSelect.value = 'short';
    recapSelect.dispatchEvent(new Event('change', { bubbles: true }));

    expect(warning.hidden).toBe(true);
    await vi.waitFor(() => {
      expect(currentState.settings.coachAutoRecap).toBe('short');
    }, { timeout: 2000 });
  });
});
