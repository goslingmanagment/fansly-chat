import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { PopupStatus } from '../src/shared/types.js';

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
    accountName: null,
    fanName: null,
    aiQuota: null,
    accountLabel: 'Closer',
    ...overrides,
  } as unknown as PopupStatus;
}

async function loadPopup(sendMessage: () => Promise<unknown>): Promise<void> {
  vi.resetModules();
  installDom();
  (globalThis as Record<string, unknown>).browser = {
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
      expect(rootText()).toContain("Couldn't reach ChatGoose");
      expect(rootText()).toContain('Open Settings');
    });
  });

  it('shows the Fansly connection state as a pill', async () => {
    await loadPopup(async () => makeStatus({ connected: false }));
    await vi.waitFor(() => {
      expect(rootText()).toContain('Fansly not connected');
    });

    await loadPopup(async () => makeStatus({ connected: true }));
    await vi.waitFor(() => {
      expect(rootText()).toContain('Fansly connected');
      expect(rootText()).not.toContain('Fansly not connected');
    });
  });

  it('flags a missing Agency Hub configuration and stays quiet otherwise', async () => {
    await loadPopup(async () => makeStatus({ hasApiKey: false }));
    await vi.waitFor(() => {
      expect(rootText()).toContain('Agency Hub not set up');
    });

    await loadPopup(async () => makeStatus({ hasApiKey: true }));
    await vi.waitFor(() => {
      expect(rootText()).toContain('Fansly connected');
    });
    expect(rootText()).not.toContain('Agency Hub not set up');
  });

  it('opens Settings through the runtime on the normal path, natively on the fallback', async () => {
    // The runtime just answered getPopupStatus, so the deep link is the right
    // path: it lands in the ONE options tab the background owns.
    await loadPopup(async () => makeStatus());
    await vi.waitFor(() => {
      expect(rootText()).toContain('Open Settings');
    });
    const runtime = (globalThis as unknown as {
      browser: { runtime: { sendMessage: ReturnType<typeof vi.fn>; openOptionsPage: ReturnType<typeof vi.fn> } };
    }).browser.runtime;
    const settingsButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-button'),
    ).find((button) => button.textContent === 'Open Settings');
    settingsButton?.click();
    expect(runtime.sendMessage).toHaveBeenLastCalledWith({ type: 'openOptions', pane: 'status' });
    expect(runtime.openOptionsPage).not.toHaveBeenCalled();

    // The unavailable screen exists BECAUSE the runtime did not answer, so its
    // button keeps the native opener — the independent path.
    await loadPopup(async () => {
      throw new Error('Could not establish connection');
    });
    await vi.waitFor(() => {
      expect(rootText()).toContain("Couldn't reach ChatGoose");
    });
    const fallbackRuntime = (globalThis as unknown as {
      browser: { runtime: { openOptionsPage: ReturnType<typeof vi.fn> } };
    }).browser.runtime;
    document.querySelector<HTMLButtonElement>('.chatgoose-button')?.click();
    expect(fallbackRuntime.openOptionsPage).toHaveBeenCalledTimes(1);
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
    expect(rootText()).toContain('No active chat');

    const button = document.querySelector<HTMLButtonElement>('.chatgoose-popup-copy');
    expect(button?.title).toBe('Copy 737077689877278720');
    button?.click();

    expect(writeText).toHaveBeenCalledWith('737077689877278720');
    await vi.waitFor(() => {
      expect(rootText()).toContain('Copied');
    });
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
    expect(button?.title).toBe('Copy 737077689877278720');
    button?.click();

    expect(writeText).toHaveBeenCalledWith('737077689877278720');
    await vi.waitFor(() => {
      expect(rootText()).toContain('Copied');
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
      expect(rootText()).toContain('AI quota');
      expect(rootText()).toContain('494');
      expect(rootText()).toContain('left today');
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
      expect(rootText()).toContain('resets at 00:00 UTC');
    });
  });
});
