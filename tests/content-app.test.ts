import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type { TabUiState } from '../src/shared/types.js';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://example.test/messages/group-1',
  });
  const { window } = dom;
  window.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(window.performance.now()), 0)) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = ((handle: number) =>
    window.clearTimeout(handle)) as typeof window.cancelAnimationFrame;

  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('navigator', window.navigator);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLDivElement', window.HTMLDivElement);
  vi.stubGlobal('HTMLButtonElement', window.HTMLButtonElement);
  vi.stubGlobal('Text', window.Text);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('CustomEvent', window.CustomEvent);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
  (globalThis as Record<string, unknown>).browser = {
    runtime: {
      openOptionsPage: vi.fn(async () => undefined),
    },
  };
  return dom;
}

function readyState(): TabUiState {
  return {
    tabId: 1,
    accountId: 'account-1',
    groupId: 'group-1',
    connected: true,
    hasApiKey: true,
    hasPersonalities: true,
    mappedPersonalityId: 'personality-1',
    mappedPersonalityName: 'Closer',
  };
}

async function loadAppClass() {
  vi.resetModules();
  const module = await import('../src/content/index.js');
  return module.ChatMuseContentApp;
}

describe('ChatMuseContentApp', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reopens the cached completed reply without starting a new operation and preserves insert state', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'reply-op';

    app.handleComplete({
      type: 'operation:complete',
      operationId: 'reply-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'First message[NEXT]Follow-up',
        parts: ['First message', 'Follow-up'],
        splitModeRequested: true,
      },
    });

    const cached = app.completedOverlayCache.get('group-1', 'fast-reply');
    cached.parts[0].insertedOnce = true;
    cached.parts[0].insertedAt = null;
    app.overlay.render(cached);

    document.querySelector<HTMLButtonElement>('.chatmuse-close')!.click();
    expect(document.querySelector('.chatmuse-overlay-shell')).toBeNull();

    app.startFeature('fast-reply', false);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLDivElement>('.chatmuse-card-status')?.textContent).toBe('Inserted earlier.');
    expect(document.querySelector<HTMLButtonElement>('.chatmuse-card-actions .chatmuse-button')?.textContent).toBe('Insert again');
  });

  it('clears the completed-result session cache on conversation change and hides the completed overlay', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.mountController = { setActiveRoute: vi.fn() };
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'reply-op';

    app.handleComplete({
      type: 'operation:complete',
      operationId: 'reply-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Hello there',
        parts: ['Hello there'],
      },
    });

    expect(document.querySelector('.chatmuse-overlay-shell')).not.toBeNull();

    app.handleRouteChange('group-2');

    expect(document.querySelector('.chatmuse-overlay-shell')).toBeNull();
    expect(app.completedOverlayCache.get('group-2', 'fast-reply')).toBeNull();

    sendSpy.mockClear();
    app.startFeature('fast-reply', false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'operation:start',
      feature: 'fast-reply',
      groupId: 'group-2',
    }));
  });

  it('clears the cached result before rerunning Chat Review from the overlay', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'chat-review';
    app.activeOperationId = 'review-op';

    app.handleComplete({
      type: 'operation:complete',
      operationId: 'review-op',
      fanDisplayName: 'alice',
      result: {
        rawText: '<rating>7</rating>',
        chatReview: {
          rating: 7,
          evaluation: 'Solid pacing',
          recommendations: 'Push toward a clear CTA',
          raw: '<rating>7</rating>',
          valid: true,
        },
      },
    });

    const refreshButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.chatmuse-overlay-actions .chatmuse-button'))
      .find((element) => element.textContent === 'Refresh');

    expect(app.completedOverlayCache.get('group-1', 'chat-review')).not.toBeNull();
    refreshButton!.click();

    expect(app.completedOverlayCache.get('group-1', 'chat-review')).toBeNull();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'operation:start',
      feature: 'chat-review',
      groupId: 'group-1',
      forceRegenerate: true,
    }));
  });
});
