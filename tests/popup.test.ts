import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { PopupStatus } from '../src/shared/types.js';
import { AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY, CHANGELOG_URL, WHATS_NEW_2_URL } from '../src/shared/constants.js';

type StorageListener = (changes: Record<string, browser.storage.StorageChange>, areaName: string) => void;
let storageListeners: StorageListener[] = [];

function installDom() {
  const dom = new JSDOM(
    '<!doctype html><html><head></head><body><div id="chatgoose-popup-root"></div></body></html>',
    { url: 'https://example.test/popup.html' },
  );
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
}

function makeStatus(overrides: Partial<PopupStatus> = {}): PopupStatus {
  // The popup reads accountLabel/accountId/accountName/groupId/fanName/
  // connected/hasApiKey/aiQuota.
  return {
    accountId: 'acc-1',
    groupId: 'group-1',
    connected: true,
    hasApiKey: true,
    signedIn: true,
    accountName: null,
    fanName: null,
    aiQuota: null,
    accountLabel: 'Closer',
    ...overrides,
  } as unknown as PopupStatus;
}

async function loadPopup(sendMessage: (message?: unknown) => Promise<unknown>): Promise<void> {
  vi.resetModules();
  installDom();
  storageListeners = [];
  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: { get: vi.fn(async () => ({})) },
      onChanged: { addListener: vi.fn((listener: StorageListener) => storageListeners.push(listener)) },
    },
    runtime: {
      getManifest: vi.fn(() => ({ version: '1.0.0' })),
      sendMessage: vi.fn(sendMessage),
      openOptionsPage: vi.fn(async () => undefined),
    },
  };
  await import('../src/popup/index.js');
}

function rootText(): string {
  return document.getElementById('chatgoose-popup-root')?.textContent ?? '';
}

function notifySignInChanged(): void {
  for (const listener of storageListeners) {
    listener({ [AGENCY_HUB_DEVICE_TOKEN_STORAGE_KEY]: {} }, 'local');
  }
}

describe('Popup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).browser;
  });

  it('renders the account label returned by the background', async () => {
    await loadPopup(async () => makeStatus({ accountLabel: 'Closer' }));
    await vi.waitFor(() => {
      expect(rootText()).toContain('Closer');
    });
  });

  it('renders a usable fallback when the background is unreachable', async () => {
    await loadPopup(async () => {
      throw new Error('Could not establish connection');
    });
    await vi.waitFor(() => {
      expect(rootText()).toContain('Не удалось связаться с ChatGoose');
      expect(rootText()).toContain('Открыть настройки');
    });
    expect(rootText()).not.toContain('Войти в ChatGoose');
  });

  it.each([false, true])('offers the release guide and archive even with unreachable runtime (%s)', async (unavailable) => {
    await loadPopup(async () => {
      if (unavailable) throw new Error('unreachable');
      return makeStatus();
    });
    await vi.waitFor(() => expect(document.querySelectorAll('.chatgoose-popup-release-links a')).toHaveLength(2));
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('.chatgoose-popup-release-links a'));
    expect(links.map((link) => [link.textContent, link.href])).toEqual([
      ['Что нового в 2.0', WHATS_NEW_2_URL],
      ['История версий', CHANGELOG_URL],
    ]);
    for (const link of links) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toContain('noopener');
    }
  });

  it('shows the Fansly connection state as a pill', async () => {
    await loadPopup(async () => makeStatus({ connected: false }));
    await vi.waitFor(() => {
      expect(rootText()).toContain('Fansly не подключён');
    });

    await loadPopup(async () => makeStatus({ connected: true }));
    await vi.waitFor(() => {
      expect(rootText()).toContain('Fansly подключён');
      expect(rootText()).not.toContain('Fansly не подключён');
    });
  });

  it('keeps a saved sign-in when the Hub configuration is invalid', async () => {
    await loadPopup(async () => makeStatus({ hasApiKey: false }));
    await vi.waitFor(() => {
      expect(rootText()).toContain('Проверьте подключение ChatGoose');
    });
    expect(rootText()).not.toContain('Войти в ChatGoose');

    await loadPopup(async () => makeStatus({ hasApiKey: true }));
    await vi.waitFor(() => {
      expect(rootText()).toContain('Fansly подключён');
    });
    expect(rootText()).not.toContain('Проверьте подключение ChatGoose');
  });

  it('shows only the sign-in path before Fansly context and cached quota', async () => {
    await loadPopup(async () => makeStatus({
      signedIn: false,
      hasApiKey: false,
      aiQuota: { pageLabel: 'lora-1', remainingRequestsToday: 494, exhausted: false, observedAt: 1 },
    }));
    await vi.waitFor(() => expect(rootText()).toContain('Войти в ChatGoose'));
    expect(rootText()).toContain('Вход в Fansly выполняется отдельно');
    expect(rootText()).not.toContain('Closer');
    expect(rootText()).not.toContain('Fansly подключён');
    expect(rootText()).not.toContain('Квота AI');
    expect(document.querySelector('.chatgoose-popup-panel')).toBeNull();
    document.querySelector<HTMLButtonElement>('.chatgoose-button')?.click();
    expect(browser.runtime.sendMessage).toHaveBeenLastCalledWith({
      type: 'openOptions', pane: 'hub', code: 'CG-HUB-02',
    });
  });

  it.each(['refused', 'rejected'])('keeps a native sign-in path when routing is %s', async (failure) => {
    await loadPopup(async (message) => {
      if ((message as { type: string }).type === 'openOptions') {
        if (failure === 'rejected') throw new Error('worker restarting');
        return { opened: false, reused: false };
      }
      return makeStatus({ signedIn: false });
    });
    await vi.waitFor(() => expect(rootText()).toContain('Войти в ChatGoose'));
    document.querySelector<HTMLButtonElement>('.chatgoose-button')?.click();
    await vi.waitFor(() => expect(browser.runtime.openOptionsPage).toHaveBeenCalledTimes(1));
  });

  it('updates both ways when sign-in changes while the popup is open', async () => {
    let signedIn = true;
    await loadPopup(async () => makeStatus({ signedIn }));
    await vi.waitFor(() => expect(rootText()).toContain('Closer'));
    signedIn = false;
    notifySignInChanged();
    await vi.waitFor(() => expect(rootText()).toContain('Войти в ChatGoose'));
    expect(rootText()).not.toContain('Closer');
    signedIn = true;
    notifySignInChanged();
    await vi.waitFor(() => expect(rootText()).toContain('Closer'));
    expect(rootText()).not.toContain('Войти в ChatGoose');
  });

  it.each(['resolved', 'rejected'])('ignores an old status read that %s after sign-out', async (outcome) => {
    let resolveOld!: (value: PopupStatus) => void;
    let rejectOld!: (error: Error) => void;
    const oldRead = new Promise<PopupStatus>((resolve, reject) => {
      resolveOld = resolve;
      rejectOld = reject;
    });
    let calls = 0;
    await loadPopup(async () => ++calls === 1 ? oldRead : makeStatus({ signedIn: false }));
    notifySignInChanged();
    await vi.waitFor(() => expect(rootText()).toContain('Войти в ChatGoose'));
    if (outcome === 'resolved') resolveOld(makeStatus());
    else rejectOld(new Error('worker restarted'));
    await vi.waitFor(() => {
      expect(vi.mocked(browser.runtime.sendMessage).mock.settledResults[0]?.type)
        .toBe(outcome === 'resolved' ? 'fulfilled' : 'rejected');
    });
    expect(rootText()).toContain('Войти в ChatGoose');
    expect(rootText()).not.toContain('Closer');
    expect(rootText()).not.toContain('Не удалось связаться');
  });

  it('opens Settings through the runtime on the normal path, natively on the fallback', async () => {
    // The runtime just answered getPopupStatus, so the deep link is the right
    // path: it lands in the ONE options tab the background owns.
    const openOptionsReply = (message: unknown): unknown =>
      (message as { type?: unknown } | undefined)?.type === 'openOptions'
        ? { opened: true, reused: false }
        : makeStatus();
    await loadPopup(async (message) => openOptionsReply(message));
    await vi.waitFor(() => {
      expect(rootText()).toContain('Открыть настройки');
    });
    const runtime = (globalThis as unknown as {
      browser: { runtime: { sendMessage: ReturnType<typeof vi.fn>; openOptionsPage: ReturnType<typeof vi.fn> } };
    }).browser.runtime;
    const settingsButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-button'),
    ).find((button) => button.textContent === 'Открыть настройки');
    settingsButton?.click();
    expect(runtime.sendMessage).toHaveBeenLastCalledWith({ type: 'openOptions', pane: 'status' });
    expect(runtime.openOptionsPage).not.toHaveBeenCalled();

    // The unavailable screen exists BECAUSE the runtime did not answer, so its
    // button keeps the native opener — the independent path.
    await loadPopup(async () => {
      throw new Error('Could not establish connection');
    });
    await vi.waitFor(() => {
      expect(rootText()).toContain('Не удалось связаться с ChatGoose');
    });
    const fallbackRuntime = (globalThis as unknown as {
      browser: { runtime: { openOptionsPage: ReturnType<typeof vi.fn> } };
    }).browser.runtime;
    document.querySelector<HTMLButtonElement>('.chatgoose-button')?.click();
    expect(fallbackRuntime.openOptionsPage).toHaveBeenCalledTimes(1);
  });

  it('takes the native path when the background answers that it opened nothing', async () => {
    // `{opened:false}` is a refusal that RESOLVES (tabs.create denied). Treating
    // it as success left the button dead — one click, nothing happens, no error.
    await loadPopup(async (message) =>
      (message as { type?: unknown } | undefined)?.type === 'openOptions'
        ? { opened: false, reused: false }
        : makeStatus(),
    );
    await vi.waitFor(() => {
      expect(rootText()).toContain('Открыть настройки');
    });
    const runtime = (globalThis as unknown as {
      browser: { runtime: { openOptionsPage: ReturnType<typeof vi.fn> } };
    }).browser.runtime;
    Array.from(document.querySelectorAll<HTMLButtonElement>('.chatgoose-button'))
      .find((button) => button.textContent === 'Открыть настройки')
      ?.click();

    await vi.waitFor(() => {
      // Nothing was opened, so the fallback cannot produce a second tab.
      expect(runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    });
  });

  it('shortens long ids and copies the full value on click', async () => {
    const writeText = vi.fn(async () => undefined);
    await loadPopup(async () =>
      makeStatus({ accountId: '737077689877278720', groupId: null }),
    );
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await vi.waitFor(() => {
      expect(rootText()).toContain('7370…8720');
    });
    expect(rootText()).toContain('Нет активного чата');

    const button = document.querySelector<HTMLButtonElement>('.chatgoose-popup-copy');
    expect(button?.title).toBe('Скопировать 737077689877278720');
    button?.click();

    expect(writeText).toHaveBeenCalledWith('737077689877278720');
    await vi.waitFor(() => {
      expect(rootText()).toContain('Скопировано');
    });
  });

  it.each([false, true])('shows copy failure when clipboard is unavailable or rejects (%s)', async (available) => {
    await loadPopup(async () => makeStatus({ groupId: null }));
    vi.stubGlobal('navigator', available
      ? { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } }
      : {});
    await vi.waitFor(() => expect(rootText()).toContain('acc-1'));
    document.querySelector<HTMLButtonElement>('.chatgoose-popup-copy')!.click();
    await vi.waitFor(() => expect(rootText()).toContain('Не удалось скопировать'));
  });

  it('prefers human names over ids and still copies the id', async () => {
    const writeText = vi.fn(async () => undefined);
    await loadPopup(async () =>
      makeStatus({
        accountId: '737077689877278720',
        accountName: 'Lora Belle (@lorabelle)',
        groupId: '766790514371469312',
        fanName: 'BigTipper92',
      }),
    );
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await vi.waitFor(() => {
      expect(rootText()).toContain('Lora Belle (@lorabelle)');
      expect(rootText()).toContain('BigTipper92');
    });
    expect(rootText()).not.toContain('7370…8720');

    const button = document.querySelector<HTMLButtonElement>('.chatgoose-popup-copy');
    expect(button?.title).toBe('Скопировать 737077689877278720');
    button?.click();

    expect(writeText).toHaveBeenCalledWith('737077689877278720');
    await vi.waitFor(() => {
      expect(rootText()).toContain('Скопировано');
    });
  });

  it('renders the remaining AI quota', async () => {
    await loadPopup(async () =>
      makeStatus({
        aiQuota: {
          pageLabel: 'lora-1',
          remainingRequestsToday: 494,
          exhausted: false,
          observedAt: 1,
        },
      }),
    );
    await vi.waitFor(() => {
      expect(rootText()).toContain('Квота AI');
      expect(rootText()).toContain('494');
      expect(rootText()).toContain('осталось сегодня');
    });
  });

  it('renders quota exhaustion with the reset time', async () => {
    await loadPopup(async () =>
      makeStatus({
        aiQuota: {
          pageLabel: 'lora-1',
          remainingRequestsToday: 0,
          exhausted: true,
          observedAt: 1,
        },
      }),
    );
    await vi.waitFor(() => {
      expect(rootText()).toContain('обновится в 00:00 UTC');
    });
  });
});
