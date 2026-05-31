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
  // The popup only reads accountLabel/accountId/groupId/connected.
  return {
    accountId: 'acc-1',
    groupId: 'group-1',
    connected: true,
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
});
