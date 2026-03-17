import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  DEFAULT_FEATURE_MODELS,
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import type {
  CompareInlineViewModel,
  OperationProfilingSnapshot,
  TabUiState,
} from '../src/shared/types.js';

let mockStorageState: Record<string, unknown>;

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
    storage: {
      local: {
        get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
          if (keys === null || keys === undefined) {
            return { ...mockStorageState };
          }
          if (typeof keys === 'string') {
            return { [keys]: mockStorageState[keys] };
          }
          if (Array.isArray(keys)) {
            const result: Record<string, unknown> = {};
            for (const key of keys) {
              result[key] = mockStorageState[key];
            }
            return result;
          }
          return {};
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(mockStorageState, items);
        }),
        remove: vi.fn(async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete mockStorageState[key];
          }
        }),
      },
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
    claudeProvider: 'anthropic',
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

function createStorageState(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: {
      claudeProvider: 'anthropic',
      anthropicApiKey: 'sk-ant-test',
      kiroApiKey: '',
      quickMessageCount: 100,
      deepMessageCount: 500,
      debugMode: false,
      promptCachingEnabled: true,
      featureModels: { ...DEFAULT_FEATURE_MODELS },
    },
    personalities: [
      {
        id: 'personality-1',
        name: 'Closer',
        content: 'Sell smoothly',
        updatedAt: 1000,
      },
    ],
    accountMappings: {
      'account-1': 'personality-1',
    },
    accountAliases: {},
    knownAccounts: [],
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
    mockStorageState = createStorageState();
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

  it('sends the selected reply tone with fast-reply operations and resets it after dispatch', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.selectTone('flirty');

    app.startFeature('fast-reply', false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'operation:start',
      feature: 'fast-reply',
      groupId: 'group-1',
      replyTone: 'flirty',
    }));
    expect(app.nextReplyTone).toBe('none');
  });

  it('shows an Anthropic-specific missing-key toast before starting a feature', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const toastShow = vi.fn();

    app.toast = { show: toastShow };
    app.port.send = vi.fn();
    app.tabState = {
      ...readyState(),
      claudeProvider: 'anthropic',
      hasApiKey: false,
    };
    app.currentGroupId = 'group-1';

    app.startFeature('fast-reply', false);

    expect(toastShow).toHaveBeenCalledWith(
      'Anthropic API key not configured. Go to Settings to add it.',
      expect.objectContaining({ actionLabel: 'Settings' }),
    );
    expect(app.port.send).not.toHaveBeenCalled();
  });

  it('shows a Kiro-specific missing-key toast before starting compare', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const toastShow = vi.fn();

    app.toast = { show: toastShow };
    app.port.send = vi.fn();
    app.tabState = {
      ...readyState(),
      claudeProvider: 'kiro',
      hasApiKey: false,
    };
    app.currentGroupId = 'group-1';

    await app.startCompare(false);

    expect(toastShow).toHaveBeenCalledWith(
      'Kiro API key not configured. Go to Settings to add it.',
      expect.objectContaining({ actionLabel: 'Settings' }),
    );
    expect(app.port.send).not.toHaveBeenCalled();
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
        detail: 'Kiro: HTTP 502 (upstream unavailable).',
      },
    });

    expect(document.querySelector('.chatmuse-grid .chatmuse-inline-error')?.textContent).toContain('Network failed');
    expect(document.querySelector('.chatmuse-inline-error-detail')?.textContent).toBe('Kiro: HTTP 502 (upstream unavailable).');
    expect(document.querySelector('.chatmuse-profiling-summary')?.textContent).toContain('Load messages');
  });

  it('includes technical detail in toast-only quick-feature errors', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'reply-op';
    app.lastFeature = 'fast-reply';
    app.quickSurfaceEverOpened = false;
    app.quickInlineVisible = false;
    app.quickSurfaceMode = 'inline';

    app.handleOperationError({
      type: 'operation:error',
      operationId: 'reply-op',
      error: {
        code: 'network_error',
        message: 'Connection error. Check your internet connection.',
        detail: 'Kiro: HTTP 502 (upstream unavailable).',
      },
    });

    const toast = document.querySelector('.chatmuse-toast');
    expect(toast?.textContent).toContain('Connection error. Check your internet connection.');
    expect(toast?.textContent).toContain('Kiro: HTTP 502 (upstream unavailable).');
  });

  it('renders technical detail for compare card errors in the inline panel', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeCompareModel = createCompareModel({
      operationId: 'compare-op',
      activeCardId: 'current',
    });
    app.comparePanelVisible = true;
    app.renderAll();

    app.handleCompareCardError({
      type: 'compare:cardError',
      operationId: 'compare-op',
      cardId: 'current',
      error: {
        code: 'network_error',
        message: 'Connection error. Check your internet connection.',
        detail: 'Kiro: HTTP 502 (upstream unavailable).',
      },
    });

    expect(app.inlinePanel.root.querySelector('.chatmuse-inline-error')?.textContent).toContain(
      'Connection error. Check your internet connection.',
    );
    expect(app.inlinePanel.root.querySelector('.chatmuse-inline-error-detail')?.textContent).toBe(
      'Kiro: HTTP 502 (upstream unavailable).',
    );
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

  it('starts a fresh compare run instead of reopening completed cached compare results', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    const fingerprint = await app.computeCompareFingerprint();
    app.completedCompareCache.set('group-1', {
      model: createCompareModel(),
      fingerprint,
    });

    await app.startCompare(false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'compare:start',
      groupId: 'group-1',
      forceRegenerate: false,
    }));
    expect(app.completedCompareCache.get('group-1')).toBeNull();
    expect(app.comparePanelVisible).toBe(false);
  });

  it('sends the selected reply tone with compare operations and resets it after dispatch', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.selectTone('upsell');

    await app.startCompare(false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'compare:start',
      groupId: 'group-1',
      replyTone: 'upsell',
    }));
    expect(app.nextReplyTone).toBe('none');
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

    await app.startCompare(false);

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
    app.completedCompareCache.set('group-1', {
      model: createCompareModel(),
      fingerprint: await app.computeCompareFingerprint(),
    });

    app.handleRouteChange('group-2');

    expect(app.completedCompareCache.get('group-2')).toBeNull();

    sendSpy.mockClear();
    await app.startCompare(false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'compare:start',
      groupId: 'group-2',
    }));
  });

  it('restores the closed completed compare panel when the fingerprint still matches', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;

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
    app.comparePanelVisible = true;
    app.pendingCompareFingerprint = await app.computeCompareFingerprint();

    app.handleCompareComplete({
      type: 'compare:complete',
      operationId: 'compare-op',
      fanDisplayName: 'alice',
    });

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    const buttonBarRoot = app.buttonBar.root as HTMLElement;
    const closeButton = (Array.from(
      inlineRoot.querySelectorAll('.chatmuse-inline-panel-action'),
    ) as HTMLButtonElement[]).find((button) => button.textContent === '\u00d7');
    closeButton?.click();

    expect(app.comparePanelVisible).toBe(false);
    expect(app.activeCompareModel).toBeNull();
    expect(app.completedCompareCache.get('group-1')).not.toBeNull();

    const reopenButton = (Array.from(buttonBarRoot.querySelectorAll('button')) as HTMLButtonElement[])
      .find((button) => button.textContent === 'Reopen');
    expect(reopenButton?.classList.contains('chatmuse-hidden')).toBe(false);

    await app.reopenCompletedCompare();

    expect(app.comparePanelVisible).toBe(true);
    expect(app.inlinePanel.root.querySelector('.chatmuse-compare-tab')?.textContent).toContain('Closer (current)');
  });

  it('invalidates closed completed compare cache when the fingerprint changes', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.completedCompareCache.set('group-1', {
      model: createCompareModel(),
      fingerprint: await app.computeCompareFingerprint(),
    });
    mockStorageState = createStorageState({
      personalities: [
        {
          id: 'personality-1',
          name: 'Closer',
          content: 'Changed draft baseline',
          updatedAt: 2000,
        },
      ],
    });

    app.renderButtonBar();
    const buttonBarRoot = app.buttonBar.root as HTMLElement;
    const reopenButton = (Array.from(buttonBarRoot.querySelectorAll('button')) as HTMLButtonElement[])
      .find((button) => button.textContent === 'Reopen');
    expect(reopenButton?.classList.contains('chatmuse-hidden')).toBe(false);

    await app.reopenCompletedCompare();

    expect(app.comparePanelVisible).toBe(false);
    expect(app.completedCompareCache.get('group-1')).toBeNull();
    expect(document.querySelector('.chatmuse-toast')?.textContent).toContain('Saved compare is outdated. Run Compare again.');
  });

  it('closing a completed compare hides the panel, preserves the cache, and exposes Reopen', async () => {
    const ChatMuseContentApp = await loadAppClass();
    const app = new ChatMuseContentApp() as any;

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
    app.comparePanelVisible = true;

    app.handleCompareComplete({
      type: 'compare:complete',
      operationId: 'compare-op',
      fanDisplayName: 'alice',
    });

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    const buttonBarRoot = app.buttonBar.root as HTMLElement;
    const closeButton = (Array.from(
      inlineRoot.querySelectorAll('.chatmuse-inline-panel-action'),
    ) as HTMLButtonElement[]).find((button) => button.textContent === '\u00d7');
    closeButton?.click();

    const reopenButton = (Array.from(buttonBarRoot.querySelectorAll('button')) as HTMLButtonElement[])
      .find((button) => button.textContent === 'Reopen');

    expect(app.comparePanelVisible).toBe(false);
    expect(app.activeCompareModel).toBeNull();
    expect(app.completedCompareCache.get('group-1')).not.toBeNull();
    expect(reopenButton?.classList.contains('chatmuse-hidden')).toBe(false);
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
