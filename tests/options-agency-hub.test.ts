import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
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
      agencyHubDeviceToken: 'hub-key',
      quickMessageCount: 30,
      pingMessageCount: 30,
      improveMessageCount: 45,
      deepMessageCount: 200,
      debugMode: false,
      promptCachingEnabled: true,
      uiTheme: 'system',
      showToolbarHints: true,
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
  // A pane that lays out its own cards states its title in the pane HEAD (an
  // <h1> above the cards, E61); the older single-card panes still carry an <h2>
  // inside the card. Accept either, and return the block that owns the heading.
  const heading = Array.from(document.querySelectorAll<HTMLElement>('h1, h2')).find(
    (candidate) => candidate.textContent === title,
  );
  const section = heading?.closest<HTMLElement>('section')
    ?? (heading ? heading.closest<HTMLElement>('.chatgoose-cabinet-pane') : null);
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
    getSectionByTitle('Аккаунт ChatGoose');
  }, { timeout: 2000 });

  return { permissionsOnAdded, permissionsOnRemoved };
}

describe('Options page — «Аккаунт ChatGoose»', () => {
  beforeEach(() => {
    vi.resetModules();
    installDom();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders the sign-in pane with the address folded away, and the host status', async () => {
    await loadOptionsPage(makeState());

    const section = getSectionByTitle('Аккаунт ChatGoose');
    const urlInput = section.querySelector<HTMLInputElement>('input[type="url"]');

    // E123: no credential field of any kind lives on this page.
    expect(section.querySelector('input[type="password"][autocomplete="off"]')).toBeNull();
    // The address is still editable, but under «Дополнительно».
    expect(urlInput?.value).toBe('http://localhost:3000');
    expect(urlInput?.closest('details')?.textContent).toContain('Дополнительно');
    expect(section.textContent).toContain('http://localhost/*');
    expect(permissionsContains).toHaveBeenCalled();
  });

  it('persists an edited hub address, and never a credential', async () => {
    await loadOptionsPage(makeState({
      agencyHubBaseUrl: '',
      agencyHubDeviceToken: '',
    }));

    const section = getSectionByTitle('Аккаунт ChatGoose');
    const urlInput = section.querySelector<HTMLInputElement>('input[type="url"]')!;

    urlInput.value = ' http://localhost:3000/ ';
    urlInput.dispatchEvent(new Event('input'));

    await vi.waitFor(() => {
      if (!savedSettings) {
        throw new Error('Settings have not been saved yet');
      }
    }, { timeout: 2000 });

    // v17 custody: the blob carries no credential, and this page writes none —
    // the sign-in is minted and stored background-side, inside the FIFO.
    expect(savedSettings).toMatchObject({ agencyHubBaseUrl: 'http://localhost:3000' });
    expect(savedSettings).not.toHaveProperty('agencyHubApiKey');
    expect(savedSettings).not.toHaveProperty('agencyHubDeviceToken');
    expect(savedCustody).toEqual({});
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

    const section = getSectionByTitle('Аккаунт ChatGoose');
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
      // Granted: the pill word flips and every «Синк выключен» sentence is gone.
      expect(section.textContent).toContain('выдан');
      expect(section.textContent).not.toContain('Синк выключен');
    }, { timeout: 2000 });
  });

  it('surfaces a denied permission request in the status line', async () => {
    await loadOptionsPage(makeState(), {
      permissionsRequestImpl: async () => false,
    });

    const section = getSectionByTitle('Аккаунт ChatGoose');
    const button = getGrantAccessButton(section);

    button.click();

    await vi.waitFor(() => {
      expect(section.textContent).toContain('Синк выключен: доступ к хосту не выдан.');
      expect(section.textContent).toContain('Firefox не выдал доступ для http://localhost/*.');
    }, { timeout: 2000 });
  });

  it('logs and surfaces permission request errors in the status line', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await loadOptionsPage(makeState(), {
      permissionsRequestImpl: async () => {
        throw new Error('May only request permissions from a user input handler');
      },
    });

    const section = getSectionByTitle('Аккаунт ChatGoose');
    const button = getGrantAccessButton(section);

    button.click();

    await vi.waitFor(() => {
      expect(section.textContent).toContain('Синк выключен: запрос доступа не удался.');
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

    const section = getSectionByTitle('Аккаунт ChatGoose');
    await vi.waitFor(() => {
      // Success: the pill flips to «есть» and the mono receipt states when the
      // check ran and how long it took. One credential class — nothing to name.
      expect(section.textContent).toContain('есть');
      expect(section.textContent).toContain('мс');
    }, { timeout: 2000 });

    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: 'testAgencyHubConnection',
      settings: {
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubDeviceToken: 'hub-key',
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

    const section = getSectionByTitle('Аккаунт ChatGoose');
    await vi.waitFor(() => {
      expect(section.textContent).toContain('CG-HUB-07');
      expect(section.textContent).toContain('Ошибка запроса к Agency Hub.');
      expect(section.textContent).toContain('Hub вернул ошибку или недоступен.');
    }, { timeout: 2000 });
  });

  it('keeps the live connection test idle until this device is signed in', async () => {
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
      agencyHubDeviceToken: '',
    }), {
      permissionsContainsImpl: async () => true,
      runtimeSendMessageImpl: runtimeSendMessage,
    });

    const section = getSectionByTitle('Аккаунт ChatGoose');
    const button = getTestConnectionButton(section);

    expect(button.disabled).toBe(true);
    expect(section.textContent).toContain('не проверялась');
    expect(section.textContent).toContain('Войди — тогда проверим связь.');
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

    const section = getSectionByTitle('Аккаунт ChatGoose');
    await vi.waitFor(() => {
      expect(section.textContent).toContain('CG-HUB-07');
      expect(section.textContent).toContain('Ошибка запроса к Agency Hub.');
      expect(section.textContent).toContain('Проверка связи не завершилась.');
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
            key: 'hub_unauthorized',
            code: 'CG-HUB-03',
            message: 'Agency Hub отклонил вход с этого устройства.',
            description: 'Откройте Настройки и войдите заново логином и паролем.',
            httpStatus: 401,
            serverDetail: '{"message":"Unauthorized"}',
          },
        };
      }
      return undefined;
    });

    // Signed in already — the retest is about the ADDRESS the chatter just
    // corrected under «Дополнительно», not about a credential.
    await loadOptionsPage(makeState({
      agencyHubBaseUrl: '',
      agencyHubDeviceToken: 'hub-key',
    }), {
      permissionsContainsImpl: async () => true,
      runtimeSendMessageImpl: runtimeSendMessage,
    });

    const section = getSectionByTitle('Аккаунт ChatGoose');
    const urlInput = section.querySelector<HTMLInputElement>('input[type="url"]')!;
    const button = getTestConnectionButton(section);

    urlInput.value = ' http://localhost:3000/ ';
    urlInput.dispatchEvent(new Event('input'));
    button.click();

    await vi.waitFor(() => {
      expect(savedSettings).toMatchObject({
        agencyHubBaseUrl: 'http://localhost:3000',
      });
      expect(savedCustody).toEqual({});
      expect(section.textContent).toContain('CG-HUB-03');
      expect(section.textContent).toContain('Agency Hub отклонил вход с этого устройства.');
      expect(section.textContent).toContain('Откройте Настройки и войдите заново логином и паролем.');
      expect(section.textContent).toContain('HTTP 401 • {"message":"Unauthorized"}');
    }, { timeout: 2000 });

    // Not `toHaveBeenLastCalledWith`: the same post-persist path also refreshes
    // the Статус rows, so the hub reads land after the test-connection request.
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: 'testAgencyHubConnection',
      settings: {
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubDeviceToken: 'hub-key',
      },
    });
  });
});
