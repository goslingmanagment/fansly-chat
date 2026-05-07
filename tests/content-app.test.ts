import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
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
  vi.stubGlobal('HTMLTextAreaElement', window.HTMLTextAreaElement);
  vi.stubGlobal('Text', window.Text);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('CustomEvent', window.CustomEvent);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
  vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame);
  vi.stubGlobal('cancelAnimationFrame', window.cancelAnimationFrame);
  (window.document as Document & { execCommand?: ReturnType<typeof vi.fn> }).execCommand =
    vi.fn(() => false);
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

function readyState(overrides: Partial<TabUiState> = {}): TabUiState {
  return {
    tabId: 1,
    accountId: 'account-1',
    groupId: 'group-1',
    hasAvailableSummary: false,
    connected: true,
    hasApiKey: true,
    hasPersonalities: true,
    mappedPersonalityId: 'personality-1',
    mappedPersonalityName: 'Closer',
    compareCardCount: 2,
    compareDraftCount: 1,
    ...overrides,
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
      claudeApiKey: 'sk-test',
      quickMessageCount: 100,
      pingMessageCount: 100,
      improveMessageCount: 100,
      deepMessageCount: 500,
      debugMode: false,
      promptCachingEnabled: true,
      featureModels: { ...DEFAULT_FEATURE_MODELS },
      featureReasoning: { ...DEFAULT_FEATURE_REASONING },
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

function mountConversationComposer(initialValue = ''): HTMLTextAreaElement {
  const routeRoot = document.createElement('app-messages-conversation-route');
  const userName = document.createElement('app-account-username');
  const userNameText = document.createElement('span');
  userNameText.className = 'user-name';
  userNameText.textContent = '@alice';
  userName.append(userNameText);

  const container = document.createElement('app-group-message-container');
  const inputHost = document.createElement('app-group-message-input');
  const textarea = document.createElement('textarea');
  textarea.value = initialValue;
  Object.defineProperty(textarea, 'offsetParent', {
    configurable: true,
    get: () => routeRoot,
  });

  inputHost.append(textarea);
  container.append(inputHost);
  routeRoot.append(userName, container);
  document.body.append(routeRoot);
  return textarea;
}

async function loadAppClass() {
  vi.resetModules();
  const module = await import('../src/content/index.js');
  return module.ChatGooseContentApp;
}

describe('ChatGooseContentApp', () => {
  beforeEach(() => {
    mockStorageState = createStorageState();
    installDom();
  });

  afterEach(() => {
    (globalThis.window as Window | undefined)?.close?.();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reopens the cached completed reply in the inline panel and preserves insert state', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState({ hasAvailableSummary: false });
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
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(false);

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
    expect(inlineRoot.querySelector('.chatgoose-card-status')?.textContent).toBe('Inserted earlier.');
    expect(inlineRoot.querySelector('.chatgoose-card-actions .chatgoose-button')?.textContent).toBe('Insert again');
  });

  it('clears the completed-result session cache on conversation change and hides the inline panel', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(false);

    app.handleRouteChange('group-2');

    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(true);
    expect(app.completedOverlayCache.get('group-2', 'fast-reply')).toBeNull();

    sendSpy.mockClear();
    app.startFeature('fast-reply', false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'operation:start',
      feature: 'fast-reply',
      groupId: 'group-2',
    }));
  });

  it('shows an OpenRouter missing-key toast when the selected feature model uses OpenRouter', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState({
      hasApiKey: false,
      modelProviderByFeature: { 'fast-reply': 'openrouter' },
    });
    app.currentGroupId = 'group-1';

    app.startFeature('fast-reply', false);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain(
      'OpenRouter API key not configured.',
    );
  });

  it('clears the cached result before rerunning Chat Review from the overlay', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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

    const refreshButton = Array.from(document.querySelectorAll<HTMLButtonElement>('.chatgoose-overlay-actions .chatgoose-button'))
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
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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

  it('sends the current composer draft with improve-draft operations', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn();

    mountConversationComposer('hey babe how was your day');
    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';

    app.startFeature('improve-draft', false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'operation:start',
      feature: 'improve-draft',
      groupId: 'group-1',
      draftText: 'hey babe how was your day',
    }));
  });

  it('auto-inserts and caches completed improve-draft results by draft text', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const textarea = mountConversationComposer('hey babe how was your day');

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'improve-draft';
    app.activeOperationId = 'improve-op';
    app.activeFanDisplayName = 'alice';
    app.activeImproveDraftCacheKey = 'hey babe how was your day';

    app.handleComplete({
      type: 'operation:complete',
      operationId: 'improve-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Improved message',
        parts: ['Improved message'],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(textarea.value).toBe('Improved message');
    expect((app.inlinePanel.root as HTMLElement).classList.contains('chatgoose-hidden')).toBe(true);
    const cached = app.completedOverlayCache.get(
      'group-1',
      'improve-draft',
      'hey babe how was your day',
    );
    expect(cached?.kind).toBe('reply');
    if (!cached || cached.kind !== 'reply') {
      throw new Error('Expected cached improve reply.');
    }
    expect(cached.parts[0]?.text).toBe('Improved message');
    expect(cached.parts[0]?.insertedOnce).toBe(true);
  });

  it('reuses cached improve-draft results for the same draft text without another request', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn();
    const textarea = mountConversationComposer('hey babe how was your day');

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.completedOverlayCache.set(
      'group-1',
      'improve-draft',
      {
        kind: 'reply',
        feature: 'improve-draft',
        fanDisplayName: 'alice',
        operationId: 'cached-improve-op',
        parts: [
          {
            id: '0-improved',
            sequenceIndex: 0,
            text: 'Improved message',
            insertedAt: null,
            insertedOnce: false,
          },
        ],
        rawText: 'Improved message',
        rerunActionLabel: 'Regenerate',
      },
      'hey babe how was your day',
    );

    app.startFeature('improve-draft', false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendSpy).not.toHaveBeenCalled();
    expect(textarea.value).toBe('Improved message');
    expect((app.inlinePanel.root as HTMLElement).classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('keeps Fix loading hidden when progress only adds spend telemetry', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    mountConversationComposer('hey babe how was your day');
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'improve-draft';
    app.activeOperationId = 'improve-op';
    app.activeFanDisplayName = 'alice';
    app.quickSurfaceMode = 'inline';
    app.quickInlineVisible = false;

    app.handleProgress({
      type: 'operation:progress',
      operationId: 'improve-op',
      feature: 'improve-draft',
      phase: 'generating',
      llmSpend: {
        totalTokens: 123,
        inputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 23,
        totalUsd: 0.002,
        uncachedUsd: 0.002,
        cacheEffectUsd: 0,
        cacheEffectKind: 'neutral',
        cacheWriteUsd: 0,
        cacheReadUsd: 0,
        approximate: false,
      },
    });

    expect(app.quickInlineVisible).toBe(false);
    expect((app.inlinePanel.root as HTMLElement).classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('preserves profiling from progress through debug prompt, chunks, and completion', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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

    expect(document.querySelector('.chatgoose-grid .chatgoose-inline-error')?.textContent).toContain('Network failed');
    expect(document.querySelector('.chatgoose-profiling-summary')?.textContent).toContain('Load messages');
  });

  it('discards suppressed completion after route change instead of caching under new group', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(true);
    // quickSurfaceMode should be reset to 'inline'
    expect(app.quickSurfaceMode).toBe('inline');
  });

  it('opens inline panel on first chunk and shows streamed text', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'stream-op';
    app.lastFeature = 'fast-reply';
    app.activeFanDisplayName = 'alice';

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    // Panel should be hidden before first chunk
    expect(app.quickInlineVisible).toBe(false);
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(true);

    // First chunk opens the panel
    app.handleChunk('stream-op', 'Hello ');
    expect(app.quickInlineVisible).toBe(true);
    expect(app.quickSurfaceEverOpened).toBe(true);

    // Flush rAF-coalesced render
    app.renderSurfaces();

    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(false);
    expect(inlineRoot.querySelector('.chatgoose-stream')?.textContent).toContain('Hello ');
  });

  it('opens inline panel on zero-chunk completion', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

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
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(false);
    expect(inlineRoot.querySelector('.chatgoose-card-text')?.textContent).toBe('Instant reply');
  });

  it('expand during loading shows overlay with collapse-to-inline, collapse returns to inline', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

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
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(false);

    // Expand to overlay
    app.quickSurfaceMode = 'overlay';
    app.renderSurfaces();
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(true);

    // Collapse back to inline
    app.quickSurfaceMode = 'inline';
    app.quickInlineVisible = true;
    app.renderSurfaces();
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(false);
    expect(inlineRoot.querySelector('.chatgoose-stream')?.textContent).toContain('Streamed text');
  });

  it('deep features (chat-review) use overlay only, never inline panel', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'chat-review';
    app.activeOperationId = 'deep-op';
    app.activeFanDisplayName = 'alice';

    // renderSurfaces renders deep loading in overlay
    app.renderSurfaces();

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(true);
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
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('updates and preserves Fan Summary sync status from background sync messages', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fan-summary';
    app.activeOperationId = 'summary-op';
    app.activeFanDisplayName = 'alice';

    app.handleComplete({
      type: 'operation:complete',
      operationId: 'summary-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Fan summary text',
        summaryMeta: {
          generatedAt: 2000,
          stale: false,
          cached: false,
          syncStatus: {
            state: 'saving',
            generatedAt: 2000,
            updatedAt: 2000,
          },
        },
      },
    });

    expect(app.deepOverlayModel.summaryMeta.syncStatus.state).toBe('saving');
    expect(app.tabState.hasAvailableSummary).toBe(true);

    app.handlePortMessage({
      type: 'summary:syncStatus',
      groupId: 'group-1',
      generatedAt: 9999,
      syncStatus: {
        state: 'failed',
        generatedAt: 9999,
        updatedAt: 9999,
      },
    });

    expect(app.deepOverlayModel.summaryMeta.syncStatus.state).toBe('saving');

    app.handlePortMessage({
      type: 'summary:syncStatus',
      groupId: 'group-1',
      generatedAt: 2000,
      syncStatus: {
        state: 'saved',
        generatedAt: 2000,
        baseUrl: 'http://hub.test',
        pageLabel: 'creator-fs',
        syncedAt: 2100,
        updatedAt: 2100,
      },
    });

    expect(app.deepOverlayModel.summaryMeta.syncStatus.state).toBe('saved');
    expect(
      app.completedOverlayCache.get('group-1', 'fan-summary').summaryMeta.syncStatus.state,
    ).toBe('saved');

    app.deepOverlayModel = null;
    sendSpy.mockClear();
    app.startFeature('fan-summary', false);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(app.deepOverlayModel.summaryMeta.syncStatus.state).toBe('saved');
  });

  it('shows a coded toast when Fan Summary Hub sync fails after completion', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.port.send = vi.fn();
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fan-summary';
    app.activeOperationId = 'summary-op';
    app.activeFanDisplayName = 'alice';

    app.handleComplete({
      type: 'operation:complete',
      operationId: 'summary-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Fan summary text',
        summaryMeta: {
          generatedAt: 2000,
          stale: false,
          cached: false,
          syncStatus: {
            state: 'saving',
            generatedAt: 2000,
            updatedAt: 2000,
          },
        },
      },
    });

    app.handlePortMessage({
      type: 'summary:syncStatus',
      groupId: 'group-1',
      generatedAt: 2000,
      syncStatus: {
        state: 'failed',
        generatedAt: 2000,
        updatedAt: 2100,
        error: {
          key: 'hub_request_failed',
          code: 'CG-HUB-07',
          message: 'Agency Hub request failed.',
        },
      },
    });

    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('CG-HUB-08');
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain(
      'Hub sync failed, summary remains available locally.',
    );
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain(
      'Latest Hub error: CG-HUB-07: Agency Hub request failed.',
    );
  });

  it('starts a fresh compare run instead of reopening completed cached compare results', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
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
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

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
      inlineRoot.querySelectorAll('.chatgoose-inline-panel-action'),
    ) as HTMLButtonElement[]).find((button) => button.textContent === '\u00d7');
    closeButton?.click();

    expect(app.comparePanelVisible).toBe(false);
    expect(app.activeCompareModel).toBeNull();
    expect(app.completedCompareCache.get('group-1')).not.toBeNull();

    const reopenButton = (Array.from(buttonBarRoot.querySelectorAll('button')) as HTMLButtonElement[])
      .find((button) => button.textContent === 'Reopen');
    expect(reopenButton).toBeUndefined();

    await app.reopenCompletedCompare();

    expect(app.comparePanelVisible).toBe(true);
    expect(app.inlinePanel.root.querySelector('.chatgoose-compare-tab')?.textContent).toContain('Closer (current)');
  });

  it('invalidates closed completed compare cache when the fingerprint changes', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

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
    expect(reopenButton).toBeUndefined();

    await app.reopenCompletedCompare();

    expect(app.comparePanelVisible).toBe(false);
    expect(app.completedCompareCache.get('group-1')).toBeNull();
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('Saved compare is outdated. Run Compare again.');
  });

  it('closing a completed compare hides the panel and preserves the cache while compare stays hidden', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

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
      inlineRoot.querySelectorAll('.chatgoose-inline-panel-action'),
    ) as HTMLButtonElement[]).find((button) => button.textContent === '\u00d7');
    closeButton?.click();

    const reopenButton = (Array.from(buttonBarRoot.querySelectorAll('button')) as HTMLButtonElement[])
      .find((button) => button.textContent === 'Reopen');

    expect(app.comparePanelVisible).toBe(false);
    expect(app.activeCompareModel).toBeNull();
    expect(app.completedCompareCache.get('group-1')).not.toBeNull();
    expect(reopenButton).toBeUndefined();
  });

  it('port disconnect resets all surfaces and state', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

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
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(true);
    expect(app.activeFeature).toBeNull();
    expect(app.activeOperationId).toBeNull();
    expect(app.quickSurfaceMode).toBe('inline');
    expect(app.quickInlineVisible).toBe(false);
    expect(app.suppressedTerminalOpId).toBeNull();
    expect(app.deepOverlayModel).toBeNull();
  });
});
