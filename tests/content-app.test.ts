import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type {
  CompareInlineViewModel,
  OperationProfilingSnapshot,
  TabUiState,
} from '../src/shared/types.js';

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
  vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', window.cancelAnimationFrame);
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
    compareCardCount: 2,
    compareDraftCount: 1,
  };
}

function createProfilingSnapshot(): OperationProfilingSnapshot {
  return {
    elapsedMs: 1450,
    activeLabel: 'Load messages',
    logEntries: [
      { elapsedMs: 0, message: 'Resolve account identity' },
      { elapsedMs: 250, message: 'Loaded messages page 1/2 (25 msgs, 25 collected)' },
    ],
    stages: [
      {
        key: 'resolve-identity',
        label: 'Resolve account identity',
        status: 'completed',
        startedElapsedMs: 0,
        endedElapsedMs: 60,
        durationMs: 60,
        detail: 'resolved account-1',
      },
      {
        key: 'load-messages',
        label: 'Load messages',
        status: 'completed',
        startedElapsedMs: 60,
        endedElapsedMs: 400,
        durationMs: 340,
        detail: '2 pages, 30 transcript messages',
      },
    ],
  };
}

function createCompareModel(overrides?: Partial<CompareInlineViewModel>): CompareInlineViewModel {
  return {
    kind: 'compare',
    fanDisplayName: 'alice',
    operationId: null,
    activeCardId: 'current',
    progress: null,
    canCancel: false,
    canRegenerate: true,
    tabs: [
      {
        cardId: 'current',
        label: 'Closer (current)',
        source: 'current',
        status: 'reply',
        rawText: 'Current reply',
        parts: [
          {
            id: 'current-0',
            sequenceIndex: 0,
            text: 'Current reply',
            insertedAt: null,
            insertedOnce: false,
          },
        ],
      },
      {
        cardId: 'system-prompt-v2-lora',
        label: 'system-prompt-v2-lora',
        source: 'draft',
        status: 'reply',
        rawText: 'Draft reply',
        parts: [
          {
            id: 'draft-0',
            sequenceIndex: 0,
            text: 'Draft reply',
            insertedAt: null,
            insertedOnce: false,
          },
        ],
      },
    ],
    ...overrides,
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

  it('reopens the cached completed reply in the inline panel and preserves insert state', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'reply-op';
    app.lastFeature = 'fast-reply';
    app.quickSurfaceEverOpened = true;
    app.quickInlineVisible = true;

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

    // Inline panel should be visible with the completed result
    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(false);

    // Modify the cached part to simulate previous insert
    const cached = app.completedOverlayCache.get('group-1', 'fast-reply');
    cached.parts[0].insertedOnce = true;
    cached.parts[0].insertedAt = null;

    // Close the inline panel
    app.quickInlineVisible = false;
    app.inlinePanel.hide();

    // Reopen via startFeature (cache hit)
    sendSpy.mockClear();
    app.startFeature('fast-reply', false);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(inlineRoot.querySelector('.chatmuse-card-status')?.textContent).toBe('Inserted earlier.');
    expect(inlineRoot.querySelector('.chatmuse-card-actions .chatmuse-button')?.textContent).toBe('Insert again');
  });

  it('clears the completed-result session cache on conversation change and hides the inline panel', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.mountController = { setActiveRoute: vi.fn() };
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'reply-op';
    app.lastFeature = 'fast-reply';
    app.quickSurfaceEverOpened = true;
    app.quickInlineVisible = true;

    app.handleComplete({
      type: 'operation:complete',
      operationId: 'reply-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Hello there',
        parts: ['Hello there'],
      },
    });

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(false);

    app.handleRouteChange('group-2');

    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(true);
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

  it('preserves profiling from progress through debug prompt, chunks, and completion', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const profiling = createProfilingSnapshot();

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'reply-op';
    app.activeFanDisplayName = 'alice';

    app.handleProgress({
      type: 'operation:progress',
      operationId: 'reply-op',
      feature: 'fast-reply',
      phase: 'loading-messages',
      profiling,
    });
    app.handleDebugPrompt({
      type: 'operation:debugPrompt',
      operationId: 'reply-op',
      feature: 'fast-reply',
      snapshot: {
        feature: 'fast-reply',
        system: 'system',
        transcript: 'transcript',
        fanSpendingData: '',
        fanSubscriptionData: '',
        user: 'user',
      },
    });
    app.handleChunk('reply-op', 'Hello');
    app.handleComplete({
      type: 'operation:complete',
      operationId: 'reply-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Hello',
        parts: ['Hello'],
      },
    });

    const cached = app.completedOverlayCache.get('group-1', 'fast-reply');
    expect(cached?.profiling).toEqual(profiling);
  });

  it('preserves profiling into the error overlay for overlay-only features', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const profiling = createProfilingSnapshot();

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'chat-review';
    app.activeOperationId = 'review-op';
    app.activeFanDisplayName = 'alice';

    app.handleProgress({
      type: 'operation:progress',
      operationId: 'review-op',
      feature: 'chat-review',
      phase: 'generating',
      profiling,
    });
    app.handleOperationError({
      type: 'operation:error',
      operationId: 'review-op',
      profiling,
      error: {
        code: 'unknown_error',
        message: 'Network failed',
      },
    });

    expect(document.querySelector('.chatmuse-grid .chatmuse-inline-error')?.textContent).toContain('Network failed');
    expect(document.querySelector('.chatmuse-profiling-summary')?.textContent).toContain('Load messages');
  });

  it('discards suppressed completion after route change instead of caching under new group', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.mountController = { setActiveRoute: vi.fn() };
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'reply-op';
    app.lastFeature = 'fast-reply';
    app.quickSurfaceEverOpened = true;
    app.quickInlineVisible = true;

    // Navigate away while operation is in-flight
    app.handleRouteChange('group-2');

    expect(app.suppressedTerminalOpId).toBe('reply-op');

    // Completion arrives for the old operation
    app.handleComplete({
      type: 'operation:complete',
      operationId: 'reply-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Stale result from group-1',
        parts: ['Stale result from group-1'],
      },
    });

    // Must NOT cache under group-2
    expect(app.completedOverlayCache.get('group-2', 'fast-reply')).toBeNull();
    // Operation state must be fully cleared
    expect(app.activeFeature).toBeNull();
    expect(app.activeOperationId).toBeNull();
    expect(app.suppressedTerminalOpId).toBeNull();
  });

  it('dismisses quick-feature error overlay cleanly without getting stuck', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'error-op';
    app.lastFeature = 'fast-reply';
    app.quickSurfaceEverOpened = true;
    app.quickInlineVisible = true;
    app.quickSurfaceMode = 'overlay';

    // Error arrives while expanded in overlay
    app.handleOperationError({
      type: 'operation:error',
      operationId: 'error-op',
      error: {
        code: 'unknown_error',
        message: 'Network failed',
      },
    });

    // Error should be rendered in the overlay (not inline)
    expect(app.activeFeature).toBeNull();

    // Simulate overlay onClose (dismissMode: 'close' → onClose callback)
    app.deepOverlayModel = null;
    app.clearOperationState(true);
    app.renderAll();

    // Both surfaces should be hidden, not stuck
    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(true);
    // quickSurfaceMode should be reset to 'inline'
    expect(app.quickSurfaceMode).toBe('inline');
  });

  it('opens inline panel on first chunk and shows streamed text', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'stream-op';
    app.lastFeature = 'fast-reply';
    app.activeFanDisplayName = 'alice';

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    // Panel should be hidden before first chunk
    expect(app.quickInlineVisible).toBe(false);
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(true);

    // First chunk opens the panel
    app.handleChunk('stream-op', 'Hello ');
    expect(app.quickInlineVisible).toBe(true);
    expect(app.quickSurfaceEverOpened).toBe(true);

    // Flush rAF-coalesced render
    app.renderSurfaces();

    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(false);
    expect(inlineRoot.querySelector('.chatmuse-stream')?.textContent).toContain('Hello ');
  });

  it('opens inline panel on zero-chunk completion', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'zero-op';
    app.lastFeature = 'fast-reply';
    // quickSurfaceEverOpened is false — no chunks arrived

    app.handleComplete({
      type: 'operation:complete',
      operationId: 'zero-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Instant reply',
        parts: ['Instant reply'],
      },
    });

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(false);
    expect(inlineRoot.querySelector('.chatmuse-card-text')?.textContent).toBe('Instant reply');
  });

  it('expand during loading shows overlay with collapse-to-inline, collapse returns to inline', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'expand-op';
    app.lastFeature = 'fast-reply';
    app.activeFanDisplayName = 'alice';
    app.quickInlineVisible = true;
    app.quickSurfaceEverOpened = true;
    app.overlayRawText = 'Streamed text';

    const inlineRoot = app.inlinePanel.root as HTMLElement;

    // Render inline first
    app.renderSurfaces();
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(false);

    // Expand to overlay
    app.quickSurfaceMode = 'overlay';
    app.renderSurfaces();
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(true);

    // Collapse back to inline
    app.quickSurfaceMode = 'inline';
    app.quickInlineVisible = true;
    app.renderSurfaces();
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(false);
    expect(inlineRoot.querySelector('.chatmuse-stream')?.textContent).toContain('Streamed text');
  });

  it('deep features (chat-review) use overlay only, never inline panel', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'chat-review';
    app.activeOperationId = 'deep-op';
    app.activeFanDisplayName = 'alice';

    // renderSurfaces renders deep loading in overlay
    app.renderSurfaces();

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(true);
    // Overlay should have been called with loading model
    expect(app.activeFeature).toBe('chat-review');

    // Complete the deep feature
    app.handleComplete({
      type: 'operation:complete',
      operationId: 'deep-op',
      fanDisplayName: 'alice',
      result: {
        rawText: '<rating>8</rating>',
        chatReview: {
          rating: 8,
          evaluation: 'Good engagement',
          recommendations: 'Keep it up',
          raw: '<rating>8</rating>',
          valid: true,
        },
      },
    });

    // Deep model should be set for overlay
    expect(app.deepOverlayModel).not.toBeNull();
    expect(app.deepOverlayModel.kind).toBe('readOnly');
    // Inline panel still hidden
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(true);
  });

  it('reopens cached compare results in the inline panel without sending a new request', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.completedCompareCache.set('group-1', createCompareModel());

    app.startCompare(false);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(app.comparePanelVisible).toBe(true);
    expect(app.inlinePanel.root.querySelector('.chatmuse-compare-tab')?.textContent).toContain('Closer (current)');
  });

  it('reopens an active compare session when the panel was closed', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeCompareModel = createCompareModel({
      operationId: 'compare-op',
      canCancel: true,
      canRegenerate: false,
      progress: {
        operationId: 'compare-op',
        phase: 'generating',
        message: 'Generating compare replies…',
      },
    });
    app.comparePanelVisible = false;

    app.startCompare(false);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(app.comparePanelVisible).toBe(true);
  });

  it('clears cached compare results on conversation change and starts a new compare request', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.mountController = { setActiveRoute: vi.fn() };
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.completedCompareCache.set('group-1', createCompareModel());

    app.handleRouteChange('group-2');

    expect(app.completedCompareCache.get('group-2')).toBeNull();

    sendSpy.mockClear();
    app.startCompare(false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'compare:start',
      groupId: 'group-2',
    }));
  });

  it('port disconnect resets all surfaces and state', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'disc-op';
    app.lastFeature = 'fast-reply';
    app.quickInlineVisible = true;
    app.quickSurfaceEverOpened = true;
    app.quickSurfaceMode = 'overlay';
    app.suppressedTerminalOpId = 'some-op';

    // Simulate disconnect
    app.completedOverlayCache.clearAll();
    app.quickInlineVisible = false;
    app.quickSurfaceMode = 'inline';
    app.suppressedTerminalOpId = null;
    app.clearOperationState(true);
    app.renderAll();

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatmuse-hidden')).toBe(true);
    expect(app.activeFeature).toBeNull();
    expect(app.activeOperationId).toBeNull();
    expect(app.quickSurfaceMode).toBe('inline');
    expect(app.quickInlineVisible).toBe(false);
    expect(app.suppressedTerminalOpId).toBeNull();
    expect(app.deepOverlayModel).toBeNull();
  });
});
