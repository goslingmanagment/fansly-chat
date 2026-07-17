import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
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
    (candidate) => candidate.textContent?.includes('Разрешить доступ'),
  );
  if (!button) {
    throw new Error('Missing Agency Hub access button');
  }
  return button;
}

function getTestConnectionButton(section: HTMLElement): HTMLButtonElement {
  const button = Array.from(section.querySelectorAll<HTMLButtonElement>('button')).find(
    (candidate) => candidate.textContent?.includes('Проверить соединение'),
  );
  if (!button) {
    throw new Error('Missing Agency Hub test connection button');
  }
  return button;
}

function getSignOutButton(section: HTMLElement): HTMLButtonElement {
  const button = Array.from(section.querySelectorAll<HTMLButtonElement>('button'))
    .find((candidate) => candidate.textContent === 'Выйти');
  if (!button) throw new Error('Missing «Выйти» button');
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

  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: vi.fn(async () => state),
        set: vi.fn(async (data: Record<string, unknown>) => {
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
      sendMessage: vi.fn(options.runtimeSendMessageImpl ?? (async (message: { type: string }) => {
        if (message.type === 'getSessionsSnapshot') {
          return [];
        }
        if (message.type === 'testAgencyHubConnection') {
          return {
            ok: false,
            error: {
              key: 'hub_request_failed',
              code: 'CG-HUB-07',
              message: 'Запрос к Agency Hub не удался.',
            },
          };
        }
        return undefined;
      })),
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
    expect(section.textContent).toContain('Синк отключён: доступ к хосту не выдан.');
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
      expect(section.textContent).toContain('Доступ к хосту выдан.');
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
      expect(section.textContent).toContain('Синк отключён: доступ к хосту не выдан.');
      expect(section.textContent).toContain('Firefox не выдал доступ к http://localhost/*.');
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
      expect(section.textContent).toContain('Синк отключён: не удалось запросить доступ к хосту.');
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
      expect(section.textContent).toContain('Соединение OK ✓');
      expect(section.textContent).toContain(
        'Живой тест соединения прошёл: http://localhost:3000.',
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
      expect(section.textContent).toContain('Соединение не удалось: CG-HUB-07');
      expect(section.textContent).toContain('Запрос к Agency Hub не удался.');
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
    expect(section.textContent).toContain('Ещё не проверялось.');
    expect(section.textContent).toContain(
      'Сохрани адрес Hub и ключ, чтобы запустить живой тест соединения.',
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
      expect(section.textContent).toContain('Соединение не удалось: CG-HUB-07');
      expect(section.textContent).toContain('Запрос к Agency Hub не удался.');
      expect(section.textContent).toContain('Не удалось выполнить проверку соединения.');
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
            message: 'Ключ Agency Hub недействителен.',
            description: 'Проверь ключ в настройках Agency Hub и попробуй снова.',
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
      expect(section.textContent).toContain('Соединение не удалось: CG-HUB-03');
      expect(section.textContent).toContain('Ключ Agency Hub недействителен.');
      expect(section.textContent).toContain('Проверь ключ в настройках Agency Hub и попробуй снова.');
      expect(section.textContent).toContain('Hub ответил 401: {"message":"Unauthorized"}');
    }, { timeout: 2000 });

    // Not `toHaveBeenLastCalledWith`: a persisted hub change now re-hydrates the
    // Статус rows (getAgencyHubHealth/getAgencyHubIdentity) AFTER the connection
    // test, so the test call is no longer the final runtime message. The intent
    // here is that the connection test carried the right settings.
    expect(runtimeSendMessage).toHaveBeenCalledWith({
      type: 'testAgencyHubConnection',
      settings: {
        agencyHubBaseUrl: 'http://localhost:3000',
        agencyHubApiKey: 'invalid-key',
        agencyHubDeviceToken: '',
      },
    });
  });

  it('renders the hub section as labeled rows with a permission badge', async () => {
    await loadOptionsPage(makeState());

    const section = getSectionByTitle('Agency Hub');
    const labels = Array.from(section.querySelectorAll('.chatgoose-lrow-label'), (n) => n.textContent);
    expect(labels).toEqual(['Адрес Hub', 'Вход устройства', 'Доступ Firefox']);
    expect(section.querySelector('[data-hub-permission-badge]')).not.toBeNull();
  });

  it('legacy key lives inside a collapsed details block and permission status text survives', async () => {
    await loadOptionsPage(makeState());

    const section = getSectionByTitle('Agency Hub');
    const details = section.querySelector('details.chatgoose-hub-legacy') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toContain('Legacy chatter key');
    expect(details.querySelector('input[type="password"]')).not.toBeNull();
    // the status node all permission states write to is still rendered:
    expect(section.textContent).toContain('Синк отключён'); // Task-9 Russian state text
  });

  it('a failed permission check shows «не удалось проверить», not «не выдан»', async () => {
    await loadOptionsPage(makeState(), {
      permissionsContainsImpl: async () => {
        throw new Error('permissions.contains blew up');
      },
    });

    const badge = getSectionByTitle('Agency Hub').querySelector('[data-hub-permission-badge]');
    expect(badge?.textContent).toBe('не удалось проверить');
    expect(badge?.className).toContain('chatgoose-badge-neutral');
  });

  it('permission badge shows разрешён when host access is granted but no credential is set', async () => {
    await loadOptionsPage(makeState({
      agencyHubApiKey: '',
      agencyHubDeviceToken: '',
    }), {
      permissionsContainsImpl: async () => true,
    });

    const badge = getSectionByTitle('Agency Hub').querySelector('[data-hub-permission-badge]');
    expect(badge?.textContent).toBe('разрешён');
    expect(badge?.className).toContain('chatgoose-badge-green');
  });

  it('permission badge shows не выдан when the origin is valid but access is not granted', async () => {
    await loadOptionsPage(makeState(), {
      permissionsContainsImpl: async () => false,
    });

    const badge = getSectionByTitle('Agency Hub').querySelector('[data-hub-permission-badge]');
    expect(badge?.textContent).toBe('не выдан');
    expect(badge?.className).toContain('chatgoose-badge-amber');
  });

  it('permission badge shows нет адреса when the Hub URL is empty', async () => {
    await loadOptionsPage(makeState({ agencyHubBaseUrl: '' }));

    const badge = getSectionByTitle('Agency Hub').querySelector('[data-hub-permission-badge]');
    expect(badge?.textContent).toBe('нет адреса');
    expect(badge?.className).toContain('chatgoose-badge-neutral');
  });
});

describe('Options page - device-token sign-out (P3)', () => {
  beforeEach(() => {
    vi.resetModules();
    installDom();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('mounts signed-OUT without a ReferenceError: renderHubSignInState runs at mount', async () => {
    // Pins the TDZ fix: the first renderHubSignInState() reads hubSignInRow and
    // hubSignedInBlock, so both must be constructed ABOVE that call. If they are
    // not, the module throws at mount and this load never resolves the section.
    await loadOptionsPage(makeState()); // default agencyHubDeviceToken: '' → signed out
    const section = getSectionByTitle('Agency Hub');
    const userInput = section.querySelector('input[autocomplete="username"]') as HTMLInputElement;
    expect(userInput.closest('[hidden]')).toBeNull(); // sign-in row visible while signed out
    expect(section.querySelector('[data-role="hub-signed-in"]')?.hasAttribute('hidden')).toBe(true);
  });

  it('signed-in state shows the active badge, a masked token line and «Выйти»; hides sign-in inputs', async () => {
    await loadOptionsPage(makeState({ agencyHubDeviceToken: 'agency_hub_device_abcdef0123456789' }));
    const section = getSectionByTitle('Agency Hub');
    expect(section.querySelector('.chatgoose-badge-green')?.textContent).toBe('активен');
    expect(section.querySelector('[data-role="hub-token-line"]')?.textContent)
      .toContain('продлевается при работе');
    expect(section.querySelector('[data-role="hub-token-line"]')?.textContent)
      .not.toContain('agency_hub_device_abcdef0123456789'); // masked prefix, no full token
    expect(section.querySelector('[data-role="hub-identity-line"]')).not.toBeNull(); // identity line present
    const userInput = section.querySelector('input[autocomplete="username"]') as HTMLInputElement;
    expect(userInput.closest('[hidden]')).not.toBeNull(); // sign-in row hidden while signed in
    getSignOutButton(section); // present
  });

  it('«Выйти»: successful revoke wipes both custody keys to EMPTY strings and reports it', async () => {
    await loadOptionsPage(
      makeState({ agencyHubDeviceToken: 'agency_hub_device_abc', agencyHubApiKey: 'legacy-key' }),
      { runtimeSendMessageImpl: async (message) => {
          if (message.type === 'signOutAgencyHub') {
            // Stand-in for the background: the REAL handler wipes custody itself
            // (Task 2); the page harness's mock must mirror that write so
            // savedCustody observes it.
            savedCustody.agencyHubDeviceToken = '';
            savedCustody.agencyHubApiKey = '';
            return { outcome: 'revoked' };
          }
          if (message.type === 'getSessionsSnapshot') return [];
          return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
        } },
    );
    const section = getSectionByTitle('Agency Hub');
    getSignOutButton(section).click();
    await vi.waitFor(() => {
      expect(savedCustody.agencyHubDeviceToken).toBe(''); // EMPTY string, not undefined/absent
      expect(savedCustody.agencyHubApiKey).toBe('');
    });
    expect(section.textContent).toContain('отозван на хабе');
  });

  it('«Выйти»: a 401 says the token was already invalid, and still wipes', async () => {
    await loadOptionsPage(
      makeState({ agencyHubDeviceToken: 'agency_hub_device_abc' }),
      { runtimeSendMessageImpl: async (message) => {
          if (message.type === 'signOutAgencyHub') {
            savedCustody.agencyHubDeviceToken = '';
            return { outcome: 'already-invalid' };
          }
          if (message.type === 'getSessionsSnapshot') return [];
          return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
        } },
    );
    const section = getSectionByTitle('Agency Hub');
    getSignOutButton(section).click();
    await vi.waitFor(() => expect(savedCustody.agencyHubDeviceToken).toBe(''));
    expect(section.textContent).toContain('401');
  });

  it('«Выйти»: an unreachable hub wipes locally and says the token dies by sliding-expiry', async () => {
    await loadOptionsPage(
      makeState({ agencyHubDeviceToken: 'agency_hub_device_abc' }),
      { runtimeSendMessageImpl: async (message) => {
          if (message.type === 'signOutAgencyHub') {
            savedCustody.agencyHubDeviceToken = '';
            return { outcome: 'unreachable' };
          }
          if (message.type === 'getSessionsSnapshot') return [];
          return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
        } },
    );
    const section = getSectionByTitle('Agency Hub');
    getSignOutButton(section).click();
    await vi.waitFor(() => expect(savedCustody.agencyHubDeviceToken).toBe(''));
    expect(section.textContent).toContain('sliding-expiry');
  });

  it('«Выйти»: a failed LOCAL wipe (background outcome) shows the red saved-flash and keeps the signed-in block', async () => {
    await loadOptionsPage(
      makeState({ agencyHubDeviceToken: 'agency_hub_device_abc' }),
      { runtimeSendMessageImpl: async (message) => {
          // The background reports its own storage failure — the token is still on
          // disk, so the mock does NOT touch savedCustody.
          if (message.type === 'signOutAgencyHub') return { outcome: 'wipe-failed' };
          if (message.type === 'getSessionsSnapshot') return [];
          return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
        } },
    );
    const flash = document.querySelector('[data-saved-flash]') as HTMLElement;
    const section = getSectionByTitle('Agency Hub');
    getSignOutButton(section).click();
    await vi.waitFor(() => {
      expect(flash.className).toContain('chatgoose-saved-flash-bad');
    });
    // Credentials are still present → the signed-in block stays up.
    expect(section.querySelector('[data-role="hub-signed-in"]')?.hasAttribute('hidden')).toBe(false);
  });

  it('signed-in block renders the identity line (username · role · pages) from P2 statusModel', async () => {
    // The page harness answers P2's getAgencyHubIdentity (fired by
    // hydrateHubStatusRows at mount); P3's line is a pure reader of the
    // resulting statusModel.identity — pages is string[] per the P2 contract.
    await loadOptionsPage(
      makeState({ agencyHubDeviceToken: 'agency_hub_device_abc' }),
      { runtimeSendMessageImpl: async (message) => {
          if (message.type === 'getAgencyHubIdentity') {
            return { ok: true, username: 'nova', role: 'chatter', pages: ['Mia', 'Lina', 'Ari'] };
          }
          if (message.type === 'getSessionsSnapshot') return [];
          return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
        } },
    );
    const section = getSectionByTitle('Agency Hub');
    await vi.waitFor(() => {
      expect(section.querySelector('[data-role="hub-identity-line"]')?.textContent)
        .toBe('nova · chatter · страниц: 3');
    });
  });

  it('identity line falls back to «identity недоступна» when getAgencyHubIdentity fails', async () => {
    await loadOptionsPage(
      makeState({ agencyHubDeviceToken: 'agency_hub_device_abc' }),
      { runtimeSendMessageImpl: async (message) => {
          if (message.type === 'getAgencyHubIdentity') {
            return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
          }
          if (message.type === 'getSessionsSnapshot') return [];
          return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
        } },
    );
    const section = getSectionByTitle('Agency Hub');
    await vi.waitFor(() => {
      expect(section.querySelector('[data-role="hub-identity-line"]')?.textContent)
        .toBe('identity недоступна');
    });
  });

  it('«Выйти» AWAITS the in-flight save chain: a pending key edit lands first, the wipe lands last', async () => {
    const releaseStaleWrite = createDeferred<void>();
    let sawStaleWrite = false;
    let signOutServed = false;
    await loadOptionsPage(
      makeState({ agencyHubDeviceToken: 'agency_hub_device_abc', agencyHubApiKey: 'old-key' }),
      {
        runtimeSendMessageImpl: async (message) => {
          if (message.type === 'signOutAgencyHub') {
            // The handler must be reached only AFTER the page's own chain settled —
            // i.e. after the held stale write was released and committed.
            signOutServed = true;
            expect(sawStaleWrite).toBe(true);
            savedCustody.agencyHubDeviceToken = '';
            savedCustody.agencyHubApiKey = '';
            return { outcome: 'revoked' };
          }
          if (message.type === 'getAgencyHubIdentity') {
            return { ok: true, username: 'u', role: 'chatter', pages: ['p'] };
          }
          if (message.type === 'getSessionsSnapshot') return [];
          return { ok: false, error: { key: 'hub_request_failed', code: 'X', message: 'x' } };
        },
        // Hold the in-flight edited-key write open across the «Выйти» click: the
        // handler must WAIT for it (preserving the edit's place in the chain), not
        // race it — the background wipe then lands strictly afterwards.
        storageSetImpl: async (data) => {
          if (!sawStaleWrite
              && Object.prototype.hasOwnProperty.call(data, 'agencyHubApiKey')
              && data.agencyHubApiKey === 'edited-key') {
            sawStaleWrite = true;
            await releaseStaleWrite.promise;
          }
        },
      },
    );
    const section = getSectionByTitle('Agency Hub');
    const keyInput = section.querySelector('input[aria-label="Legacy chatter key"]') as HTMLInputElement;
    keyInput.value = 'edited-key';
    keyInput.dispatchEvent(new Event('input'));
    keyInput.dispatchEvent(new Event('change'));   // flush → the persist is now in flight (held)
    getSignOutButton(section).click();             // must await the chain, not bypass it
    expect(signOutServed).toBe(false);             // still waiting on the held write
    releaseStaleWrite.resolve();
    await vi.waitFor(() => {
      expect(signOutServed).toBe(true);
      // Final custody state: the wipe is the last word.
      expect(savedCustody.agencyHubApiKey).toBe('');
      expect(savedCustody.agencyHubDeviceToken).toBe('');
    });
    // pagehide after sign-out must not replay the key: dirty flags were cleared.
    window.dispatchEvent(new Event('pagehide'));
    expect(savedCustody.agencyHubApiKey).toBe('');
  });
});
