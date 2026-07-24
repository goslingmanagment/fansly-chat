// The toast is the other error surface besides the inline card — it must
// show the same one-line technical diagnostic when the error carries one.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ToastController } from '../src/content/toast.js';
import { getErrorMessage } from '../src/shared/errors.js';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
  vi.stubGlobal('HTMLDivElement', dom.window.HTMLDivElement);
  return dom;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('toast technical diagnostics', () => {
  it('renders the diagnostic line when the user error carries server detail', () => {
    const dom = installDom();
    const toasts = new ToastController();
    toasts.show({
      ...getErrorMessage('hub_provider_failed'),
      serverDetail: 'provider_stream_failed: AI gateway provider stream failed',
    }, { tone: 'error' });

    const detail = dom.window.document.querySelector('.chatgoose-toast-detail');
    expect(detail?.textContent).toBe(
      'provider_stream_failed: AI gateway provider stream failed',
    );
  });

  it('omits the diagnostic line when the error has none', () => {
    const dom = installDom();
    const toasts = new ToastController();
    toasts.show(getErrorMessage('hub_request_failed'), { tone: 'error' });

    expect(dom.window.document.querySelector('.chatgoose-toast-detail')).toBeNull();
    // The primary line still renders as usual.
    expect(dom.window.document.querySelector('.chatgoose-toast-primary')?.textContent)
      .toBe('CG-HUB-07: Agency Hub request failed.');
  });

  it('renders a provider rate-limit countdown without retrying', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-24T12:00:00.000Z'));
    const dom = installDom();
    const toasts = new ToastController();
    toasts.show({
      ...getErrorMessage('hub_provider_rate_limited'),
      retryAtMs: Date.now() + 15_000,
    }, { tone: 'error', durationMs: 30_000 });

    const retry = dom.window.document.querySelector('.chatgoose-toast-retry');
    expect(retry?.textContent).toBe('Повторить вручную можно через 15 с.');

    await vi.advanceTimersByTimeAsync(1_100);
    expect(retry?.textContent).toBe('Повторить вручную можно через 14 с.');
  });
});
