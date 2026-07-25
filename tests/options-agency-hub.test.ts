import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  AGENCY_HUB_API_KEY_STORAGE_KEY,
  AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import { COPY } from '../src/options/copy.js';
import { stripSecretSettings } from '../src/shared/migrations.js';
import { createBundledPersonalities } from '../src/shared/personalities.js';
import type { AgencyHubConnectionTestRequest, PersistedState } from '../src/shared/types.js';

let dom: InstanceType<typeof JSDOM>;
let savedSettings: Record<string, unknown> | null;
// v13 (A41): credentials ride their own storage keys, never the blob.
let savedCustody: Record<string, unknown>;
let permissionGranted = false;
let permissionsContains: ReturnType<typeof vi.fn>;
let permissionsRequest: ReturnType<typeof vi.fn>;

interface MockPermissionsEvent {
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
  emit: () => void;
}

interface LoadOptionsPageOptions {
  permissionsContainsImpl?: () => Promise<boolean>;
  permissionsRequestImpl?: () => Promise<boolean>;
  runtimeSendMessageImpl?: (
    message: {
      type: string;
      settings?: AgencyHubConnectionTestRequest['settings'];
    },
  ) => Promise<unknown>;
  storageReadyImpl?: () => Promise<unknown>;
  storageSetImpl?: (data: Record<string, unknown>) => Promise<void>;
}

function makeState(overrides?: Partial<PersistedState['settings']>): PersistedState {
  const [bundledLora] = createBundledPersonalities();
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: {
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: 'hub-key',
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
      ...overrides,
    },
    personalities: [
      { id: 'p1', name: 'Closer', content: 'be nice', updatedAt: 1 },
      ...(bundledLora ? [bundledLora] : []),
    ],
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
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function createPermissionsEvent(): MockPermissionsEvent {
  const listeners = new Set<() => void>();

  return {
    addListener: vi.fn((listener: () => void) => {
      listeners.add(listener);
    }),
    removeListener: vi.fn((listener: () => void) => {
      listeners.delete(listener);
    }),
    emit: () => {
      listeners.forEach((listener) => listener());
    },
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
  vi.stubGlobal('HTMLInputElement', window.HTMLInputElement);
  vi.stubGlobal('HTMLButtonElement', window.HTMLButtonElement);
  vi.stubGlobal('HTMLSelectElement', window.HTMLSelectElement);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event);
}

function getSectionByTitle(title: string): HTMLElement {
  const section = Array.from(document.querySelectorAll<HTMLElement>('section')).find(
    (candidate) => candidate.querySelector('h2')?.textContent === title,
  );
  if (!section) {
    throw new Error(`Missing section: ${title}`);
  }
  return section;
}

function getGrantAccessButton(section: HTMLElement): HTMLButtonElement {
  const button = Array.from(section.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent === COPY.status.grantAccess,
  );
  if (!button) {
    throw new Error('Missing Agency Hub access button');
  }
  return button;
}

function getTestConnectionButton(section: HTMLElement): HTMLButtonElement {
  const button = Array.from(section.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent === COPY.hub.testConnection,
  );
  if (!button) {
    throw new Error('Missing Agency Hub test connection button');
  }
  return button;
}

async function loadOptionsPage(
  state: PersistedState,
  options: LoadOptionsPageOptions = {},
): Promise<{ permissionsOnAdded: MockPermissionsEvent; permissionsOnRemoved: MockPermissionsEvent }> {
  savedSettings = null;
  savedCustody = {};
  permissionGranted = false;
  permissionsContains = vi.fn(options.permissionsContainsImpl ?? (async () => permissionGranted));
  permissionsRequest = vi.fn(options.permissionsRequestImpl ?? (async () => {
    permissionGranted = true;
    return true;
  }));

  const permissionsOnAdded = createPermissionsEvent();
  const permissionsOnRemoved = createPermissionsEvent();
  const storageRecord: Record<string, unknown> = {
    ...state,
    settings: stripSecretSettings(state.settings),
    [AGENCY_HUB_API_KEY_STORAGE_KEY]: state.settings.agencyHubApiKey,
    [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: state.settings.agencyHubDeviceToken,
  };

  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: vi.fn(async () => ({ ...storageRecord })),
        set: vi.fn(async (data: Record<string, unknown>) => {
          Object.assign(storageRecord, data);
          if (data.settings) {
            savedSettings = data.settings as Record<string, unknown>;
          }
          for (const custodyKey of ['agencyHubApiKey', 'agencyHubDeviceToken']) {
            if (Object.prototype.hasOwnProperty.call(data, custodyKey)) {
              savedCustody[custodyKey] = data[custodyKey];
            }
          }
          await options.storageSetImpl?.(data);
        }),
        remove: vi.fn(async () => undefined),
      },
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
      sendMessage: vi.fn(async (message: { type: string; settings?: AgencyHubConnectionTestRequest['settings'] }) => {
        if (message.type === 'ensureStorageReady') {
          return options.storageReadyImpl
            ? await options.storageReadyImpl()
            : { ready: true };
        }
        if (options.runtimeSendMessageImpl) {
          return options.runtimeSendMessageImpl(message);
        }
        if (message.type === 'getSessionsSnapshot') {
          return [];
        }
        if (message.type === 'testAgencyHubConnection') {
          return {
            ok: false,
            error: {
              key: 'hub_request_failed',
              code: 'CG-HUB-07',
              message: 'Agency Hub request failed.',
            },
          };
        }
        return undefined;
      }),
      openOptionsPage: vi.fn(async () => undefined),
    },
    permissions: {
      contains: permissionsContains,
      request: permissionsRequest,
      onAdded: permissionsOnAdded,
      onRemoved: permissionsOnRemoved,
    },
  };

  await import('../src/options/index.js');
  await vi.waitFor(() => {
    getSectionByTitle('Agency Hub');
  }, { timeout: 2000 });

  return { permissionsOnAdded, permissionsOnRemoved };
}

describe('Options page - Agency Hub section', () => {
  beforeEach(() => {
    vi.resetModules();
    installDom();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the Agency Hub fields and permission status', async () => {
    await loadOptionsPage(makeState());

    const section = getSectionByTitle('Agency Hub');
    const urlInput = section.querySelector<HTMLInputElement>('input[type="url"]');
    const keyInput = section.querySelector<HTMLInputElement>('input[type="password"][autocomplete="off"]');

    expect(urlInput?.value).toBe('http://localhost:3000');
    expect(keyInput?.value).toBe('hub-key');
    expect(section.textContent).toContain('Sync disabled: host access not granted.');
    expect(section.textContent).toContain('http://localhost/*');
    expect(permissionsContains).toHaveBeenCalled();
  });

  it('saves the Agency Hub URL and API key through the shared settings path', async () => {
    await loadOptionsPage(makeState({
      agencyHubBaseUrl: '',
      agencyHubApiKey: '',
      agencyHubDeviceToken: '',
    }));

    const section = getSectionByTitle('Agency Hub');
    const urlInput = section.querySelector<HTMLInputElement>('input[type="url"]')!;
    const keyInput = section.querySelector<HTMLInputElement>('input[type="password"][autocomplete="off"]')!;

    urlInput.value = ' http://localhost:3000/ ';
    urlInput.dispatchEvent(new Event('input'));
    keyInput.value = ' hub-key ';
    keyInput.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      if (!savedSettings) {
        throw new Error('Settings have not been saved yet');
      }
    }, { timeout: 2000 });

    // v13 custody: the blob carries no credentials; the edited key rides its
    // own storage key, and the untouched token key is not written at all.
    expect(savedSettings).toMatchObject({ agencyHubBaseUrl: 'http://localhost:3000' });
    expect(savedSettings).not.toHaveProperty('agencyHubApiKey');
    expect(savedSettings).not.toHaveProperty('agencyHubDeviceToken');
    expect(savedCustody).toEqual({ agencyHubApiKey: 'hub-key' });
  });

  it('requests host access before storage writes and refreshes the status', async () => {
    const requestDeferred = createDeferred<boolean>();
    const storageDeferred = createDeferred<void>();
    const callOrder: string[] = [];

    await loadOptionsPage(makeState(), {
      permissionsRequestImpl: () => {
        callOrder.push('permissions.request');
        return requestDeferred.promise;
      },
      storageSetImpl: async (data) => {
        if (data.settings) {
          callOrder.push('storage.set');
          await storageDeferred.promise;
        }
      },
    });

    const section = getSectionByTitle('Agency Hub');
    const button = getGrantAccessButton(section);

    callOrder.length = 0;
    button.click();

    expect(permissionsRequest).toHaveBeenCalledWith({
      origins: ['http://localhost/*'],
    });
    expect(callOrder).toEqual(['permissions.request']);

    permissionGranted = true;
    requestDeferred.resolve(true);

    await vi.waitFor(() => {
      expect(callOrder).toContain('storage.set');
    }, { timeout: 2000 });

    storageDeferred.resolve();

    await vi.waitFor(() => {
      expect(section.textContent).toContain('Host access granted.');
      // Readiness is claimed only by the live connection test, never by the
      // local permission check (they contradicted each other on screen).
      expect(section.textContent).not.toContain('Sync ready');
    }, { timeout: 2000 });
  });

  it('surfaces a denied permission request in the status line', async () => {
    await loadOptionsPage(makeState(), {
      permissionsRequestImpl: async () => false,
    });

    const section = getSectionByTitle('Agency Hub');
    const button = getGrantAccessButton(section);

    button.click();

    await vi.waitFor(() => {
      expect(section.textContent).toContain('Sync disabled: host access not granted.');
      expect(section.textContent).toContain('Firefox did not grant access for http://localhost/*.');
    }, { timeout: 2000 });
  });

  it('logs and surfaces permission request errors in the status line', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await loadOptionsPage(makeState(), {
      permissionsRequestImpl: async () => {
        throw new Error('May only request permissions from a user input handler');
      },
    });

    const section = getSectionByTitle('Agency Hub');
    const button = getGrantAccessButton(section);

    button.click();

    await vi.waitFor(() => {
      expect(section.textContent).toContain('Sync disabled: failed to request host access.');
      expect(section.textContent).toContain('May only request permissions from a user input handler');
    }, { timeout: 2000 });
    expect(consoleError).toHaveBeenCalledWith(
      'Agency Hub permission request failed',
      expect.any(Error),
    );
  });

  it('auto-tests the Hub connection on load and shows the live success status', async () => {
    const runtimeSendMessage = vi.fn(async (message: {
      type: string;
      settings?: AgencyHubConnectionTestRequest['settings'];
    }) => {
      if (message.type === 'getSessionsSnapshot') {
        return [];
      }
      if (message.type === 'testAgencyHubConnection') {
        return { ok: true };
      }
      return undefined;
    });

    await loadOptionsPage(makeState(), {
      permissionsContainsImpl: async () => true,
      runtimeSendMessageImpl: runtimeSendMessage,
    });

    const section = getSectionByTitle('Agency Hub');
    await vi.waitFor(() => {
      expect(section.textContent).toContain('Connected ✓');
      expect(section.textContent).toContain(
        'Live connection test succeeded for http://localhost:3000.',
      );
    }, { timeout: 2000 });

    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: 'testAgencyHubConnection',
      settings: {
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'hub-key',
        agencyHubDeviceToken: '',
      },
    });
  });

  it('falls back to the registry-backed Hub request error when the runtime result omits error details', async () => {
    const runtimeSendMessage = vi.fn(async (message: {
      type: string;
      settings?: AgencyHubConnectionTestRequest['settings'];
    }) => {
      if (message.type === 'getSessionsSnapshot') {
        return [];
      }
      if (message.type === 'testAgencyHubConnection') {
        return { ok: false };
      }
      return undefined;
    });

    await loadOptionsPage(makeState(), {
      permissionsContainsImpl: async () => true,
      runtimeSendMessageImpl: runtimeSendMessage,
    });

    const section = getSectionByTitle('Agency Hub');
    await vi.waitFor(() => {
      expect(section.textContent).toContain('Connection failed: CG-HUB-07');
      expect(section.textContent).toContain('Ошибка запроса к Agency Hub.');
      expect(section.textContent).toContain('Hub вернул ошибку или недоступен.');
    }, { timeout: 2000 });
  });

  it('keeps the live connection test idle until both Hub fields are present', async () => {
    const runtimeSendMessage = vi.fn(async (message: {
      type: string;
      settings?: AgencyHubConnectionTestRequest['settings'];
    }) => {
      if (message.type === 'getSessionsSnapshot') {
        return [];
      }
      if (message.type === 'testAgencyHubConnection') {
        return { ok: true };
      }
      return undefined;
    });

    await loadOptionsPage(makeState({
      agencyHubBaseUrl: 'http://localhost:3000',
      agencyHubApiKey: '',
      agencyHubDeviceToken: '',
    }), {
      permissionsContainsImpl: async () => true,
      runtimeSendMessageImpl: runtimeSendMessage,
    });

    const section = getSectionByTitle('Agency Hub');
    const button = getTestConnectionButton(section);

    expect(button.disabled).toBe(true);
    expect(section.textContent).toContain('Not tested yet.');
    expect(section.textContent).toContain(
      'Save a Hub URL and API key to run a live connection test.',
    );
    expect(runtimeSendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'testAgencyHubConnection',
      }),
    );
  });

  it('uses the custom catch-path description when the Hub connection test throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runtimeError = new Error('background disconnected');

    await loadOptionsPage(makeState(), {
      permissionsContainsImpl: async () => true,
      runtimeSendMessageImpl: async (message) => {
        if (message.type === 'getSessionsSnapshot') {
          return [];
        }
        if (message.type === 'testAgencyHubConnection') {
          throw runtimeError;
        }
        return undefined;
      },
    });

    const section = getSectionByTitle('Agency Hub');
    await vi.waitFor(() => {
      expect(section.textContent).toContain('Connection failed: CG-HUB-07');
      expect(section.textContent).toContain('Ошибка запроса к Agency Hub.');
      expect(section.textContent).toContain('The connection test could not be completed.');
    }, { timeout: 2000 });
    expect(consoleError).toHaveBeenCalledWith(
      'Agency Hub connection test failed',
      runtimeError,
    );
  });

  it('saves normalized Hub settings before a manual retest and shows coded failure feedback', async () => {
    const runtimeSendMessage = vi.fn(async (message: {
      type: string;
      settings?: AgencyHubConnectionTestRequest['settings'];
    }) => {
      if (message.type === 'getSessionsSnapshot') {
        return [];
      }
      if (message.type === 'testAgencyHubConnection') {
        return {
          ok: false,
          error: {
            key: 'hub_invalid_api_key',
            code: 'CG-HUB-03',
            message: 'Agency Hub API key is invalid.',
            description: 'Check the key in Agency Hub settings and try again.',
            httpStatus: 401,
            serverDetail: '{"message":"Unauthorized"}',
          },
        };
      }
      return undefined;
    });

    await loadOptionsPage(makeState({
      agencyHubBaseUrl: '',
      agencyHubApiKey: '',
      agencyHubDeviceToken: '',
    }), {
      permissionsContainsImpl: async () => true,
      runtimeSendMessageImpl: runtimeSendMessage,
    });

    const section = getSectionByTitle('Agency Hub');
    const urlInput = section.querySelector<HTMLInputElement>('input[type="url"]')!;
    const keyInput = section.querySelector<HTMLInputElement>('input[type="password"][autocomplete="off"]')!;
    const button = getTestConnectionButton(section);

    urlInput.value = ' http://localhost:3000/ ';
    urlInput.dispatchEvent(new Event('input'));
    keyInput.value = ' invalid-key ';
    keyInput.dispatchEvent(new Event('input'));
    button.click();

    await vi.waitFor(() => {
      expect(savedSettings).toMatchObject({
        agencyHubBaseUrl: 'http://localhost:3000',
      });
      expect(savedCustody).toEqual({ agencyHubApiKey: 'invalid-key' });
      expect(section.textContent).toContain('Connection failed: CG-HUB-03');
      expect(section.textContent).toContain('Agency Hub API key is invalid.');
      expect(section.textContent).toContain('Check the key in Agency Hub settings and try again.');
      expect(section.textContent).toContain('HTTP 401 • {"message":"Unauthorized"}');
    }, { timeout: 2000 });

    // Not `toHaveBeenLastCalledWith`: the same post-persist path also refreshes
    // the Статус rows, so the hub reads land after the test-connection request.
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: 'testAgencyHubConnection',
      settings: {
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'invalid-key',
        agencyHubDeviceToken: '',
      },
    });
  });
});
