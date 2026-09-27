/* eslint-disable @typescript-eslint/no-explicit-any --
   legacy suite pokes ChatGooseContentApp privates via `as any` throughout;
   typed access is a Stage 32 Task 3 rewrite concern (the app surface changes
   there anyway). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import { getErrorMessage } from '../src/shared/errors.js';
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
      // Deep links into Settings ride the runtime API (one options tab, routed
      // by error code); the native page opener is only the dead-runtime path.
      sendMessage: vi.fn(async () => ({ opened: true, reused: false })),
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
    voiceNotesCapable: false,
    hasPersonalities: true,
    mappedPersonalityId: 'personality-1',
    mappedPersonalityName: 'Closer',
    mappedPersonaVersion: 1,
    mappedPersonaDefinitionId: 'v1:persona-one-definition',
    mappedPersonaSource: 'source-a',
    compareCardCount: 2,
    compareDraftCount: 1,
    ...overrides,
  };
}

function overlayIdentity(variantKey: string | null = null) {
  return {
    personaKey: 'personality-1',
    personaDefinitionId: 'v1:persona-one-definition',
    personaSource: 'source-a',
    variantKey,
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
      quickMessageCount: 100,
      pingMessageCount: 100,
      improveMessageCount: 100,
      deepMessageCount: 500,
      debugMode: false,
      promptCachingEnabled: true,
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

  it('waits for the first tab state before opening a cold Spenders board', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const toggle = vi.fn();
    const invalidateContext = vi.fn();
    app.boardController = {
      toggle,
      invalidateContext,
      isOpen: () => false,
    };
    app.mappingBanner = { render: vi.fn(async () => undefined) };
    app.renderButtonBar = vi.fn();

    app.openSpendersBoard();
    expect(toggle).not.toHaveBeenCalled();

    app.handlePortMessage({ type: 'tab:state', state: readyState() });
    await Promise.resolve();

    expect(invalidateContext).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('drops a cold conversation hotkey when navigation changed during startup', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    app.dispatchHotkey = vi.fn(() => true);
    app.mappingBanner = { render: vi.fn(async () => undefined) };
    app.renderButtonBar = vi.fn();

    expect(app.dispatchBootstrapHotkey('fast-reply', 'group-1')).toBe(true);
    window.history.replaceState({}, '', '/messages/group-2');
    app.handlePortMessage({
      type: 'tab:state',
      state: readyState({ groupId: 'group-2' }),
    });
    await Promise.resolve();

    expect(app.dispatchHotkey).not.toHaveBeenCalled();
  });

  it('dispatches a cold conversation hotkey once when its route is still current', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    app.dispatchHotkey = vi.fn(() => true);
    app.mappingBanner = { render: vi.fn(async () => undefined) };
    app.renderButtonBar = vi.fn();

    expect(app.dispatchBootstrapHotkey('fast-reply', 'group-1')).toBe(true);
    app.handlePortMessage({ type: 'tab:state', state: readyState() });
    await Promise.resolve();

    expect(app.dispatchHotkey).toHaveBeenCalledTimes(1);
    expect(app.dispatchHotkey).toHaveBeenCalledWith('fast-reply');
  });

  it('boots a recoverable voice attempt before applying the empty-draft gate', async () => {
    mountConversationComposer('');
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const boot = vi.fn(async () => ({ attemptId: 'recovered-attempt' }));
    const resumeBlobUrls = vi.fn();
    const open = vi.fn();
    const setFanUsername = vi.fn();

    app.tabState = readyState({ voiceNotesCapable: true });
    app.currentGroupId = 'group-1';
    app.createVoiceController = vi.fn(() => {
      app.voiceController = { boot, resumeBlobUrls };
      app.voicePanel = { open, setFanUsername };
    });

    app.openVoicePanel();

    await vi.waitFor(() => expect(boot).toHaveBeenCalledTimes(1));
    expect(app.createVoiceController).toHaveBeenCalledTimes(1);
    expect(resumeBlobUrls).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(setFanUsername).toHaveBeenCalledWith('alice');
    expect(document.querySelector('.chatgoose-toast')?.textContent ?? '')
      .not.toContain('Напишите черновик');
  });

  it('unloads voice media before hiding and revoking URLs on panel close', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const calls: string[] = [];
    app.voiceStudio = { isOpen: () => false };
    app.voicePanel = {
      suspendPlayers: () => calls.push('unload'),
      hide: () => calls.push('hide'),
    };
    app.voiceController = {
      suspendBlobUrls: () => calls.push('revoke'),
    };

    app.closeVoicePanel();

    expect(calls).toEqual(['unload', 'hide', 'revoke']);
  });

  it('tears down a stale-tab paid create on custody conflict before noteCreate and asks for reload', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sent: Array<{ type: string }> = [];
    let revision = 0;
    let conflict = false;
    const runtimeSend = (globalThis as any).browser.runtime.sendMessage as ReturnType<typeof vi.fn>;
    runtimeSend.mockImplementation(async (request: { type: string }) => {
      if (request.type !== 'voiceAttemptSave') {
        throw new Error(`unexpected runtime request: ${request.type}`);
      }
      if (conflict) {
        return { version: 2, ok: false, error: 'revision_conflict' };
      }
      revision += 1;
      return { version: 2, ok: true, revision };
    });
    app.port.send = vi.fn((message: { type: string }) => {
      sent.push(message);
      return true;
    });
    app.tabState = readyState({
      voiceNotesCapable: true,
      accountId: 'account-1',
      groupId: 'group-1',
    });
    app.currentGroupId = 'group-1';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    app.createVoiceController();
    const controller = app.voiceController;
    await controller.startScript('Draft', 'none');
    const attemptId = controller.getAttempt().attemptId;
    await controller.handleMessage({
      type: 'voice:scriptComplete',
      attemptId,
      script: 'Ready script',
      generationRef: 'generation-1',
      conversationRef: 'fan-1',
      sourceFingerprint: 'https://hub.test|credential-hash',
      pageLabel: 'creator-fs',
    });

    conflict = true;
    await expect(controller.generateTake()).rejects.toMatchObject({
      name: 'VoiceAttemptCustodyError',
      code: 'conflict',
    });

    expect(sent.filter((message) => message.type === 'voice:noteCreate')).toHaveLength(0);
    expect(app.voiceController).toBeNull();
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain(
      'Перезагрузите эту вкладку Fansly',
    );
  });

  it('shows a one-part Split warning on the default inline surface (E49)', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    app.port.send = vi.fn();
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
        rawText: 'Only one message',
        parts: ['Only one message'],
        splitModeRequested: true,
      },
    });

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(false);
    const note = inlineRoot.querySelector('.chatgoose-inline-note');
    expect(note).not.toBeNull();
    expect(note!.classList.contains('chatgoose-inline-note-warn')).toBe(true);
    expect(note!.textContent).toContain('Try Regenerate');
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
    const cached = app.completedOverlayCache.get('group-1', 'fast-reply', overlayIdentity());
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
    const sendSpy = vi.fn(() => true);

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
    expect(app.completedOverlayCache.get('group-2', 'fast-reply', overlayIdentity())).toBeNull();

    sendSpy.mockClear();
    app.startFeature('fast-reply', false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'operation:start',
      feature: 'fast-reply',
      groupId: 'group-2',
    }));
  });

  it('hides a visible completed result when the mapped persona definition changes', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.tabState = readyState({ mappedPersonaDefinitionId: 'v1:persona-one-definition' });
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
        rawText: 'Persona v1 reply',
        parts: ['Persona v1 reply'],
      },
    });

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(false);

    app.handlePortMessage({
      type: 'settings:changed',
      state: readyState({ mappedPersonaDefinitionId: 'v1:persona-two-definition' }),
    });

    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(true);
    expect(app.quickInlineVisible).toBe(false);
    expect(app.lastFeature).toBeNull();
    expect(app.completedOverlayCache.get(
      'group-1',
      'fast-reply',
      overlayIdentity(),
    )).toBeNull();
  });

  it('keeps persona-bound UI when only numeric catalog metadata changes', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.tabState = readyState({
      mappedPersonaVersion: 7,
      mappedPersonaDefinitionId: 'v1:persona-one-definition',
    });
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
        rawText: 'Stable definition reply',
        parts: ['Stable definition reply'],
      },
    });

    app.handlePortMessage({
      type: 'mapping:changed',
      state: readyState({
        mappedPersonaVersion: 1,
        mappedPersonaDefinitionId: 'v1:persona-one-definition',
      }),
    });

    expect(app.quickInlineVisible).toBe(true);
    expect(app.lastFeature).toBe('fast-reply');
    expect(app.completedOverlayCache.get(
      'group-1',
      'fast-reply',
      overlayIdentity(),
    )).not.toBeNull();
  });

  it('hides completed and in-flight results when the Hub source changes with the same key/version', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn(() => true);
    app.port.send = sendSpy;
    app.tabState = readyState({ mappedPersonaSource: 'source-a' });
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'reply-op';
    app.activePersonaKey = 'personality-1';
    app.activePersonaVersion = 1;
    app.activePersonaSource = 'source-a';

    app.handlePortMessage({
      type: 'settings:changed',
      state: readyState({ mappedPersonaSource: 'source-b' }),
    });

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'operation:cancel',
      operationId: 'reply-op',
    });
    expect(app.activeFeature).toBeNull();
    expect(app.completedOverlayCache.get(
      'group-1',
      'fast-reply',
      { ...overlayIdentity(), personaSource: 'source-b' },
    )).toBeNull();
  });

  it('keeps an open Spenders context for a metadata-only mapping refresh', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    const invalidateContext = vi.spyOn(app.board, 'invalidateContext');

    app.handlePortMessage({
      type: 'mapping:changed',
      state: readyState(),
    });

    expect(invalidateContext).not.toHaveBeenCalled();

    app.handlePortMessage({
      type: 'settings:changed',
      state: readyState(),
    });

    expect(invalidateContext).toHaveBeenCalledTimes(1);
  });

  it('cancels and discards an in-flight feature when the mapped persona changes', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn(() => true);

    app.port.send = sendSpy;
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'chat-review';
    app.activeOperationId = 'review-op';
    app.activePersonaKey = 'personality-1';
    app.activePersonaVersion = 1;

    app.handlePortMessage({
      type: 'mapping:changed',
      state: readyState({
        mappedPersonalityId: 'personality-2',
        mappedPersonalityName: 'Other',
        mappedPersonaVersion: 1,
      }),
    });

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'operation:cancel',
      operationId: 'review-op',
    });
    expect(app.activeFeature).toBeNull();

    app.handleComplete({
      type: 'operation:complete',
      operationId: 'review-op',
      fanDisplayName: 'alice',
      result: {
        rawText: '<rating>9</rating>',
        chatReview: {
          rating: 9,
          evaluation: 'Stale evaluation',
          recommendations: 'Stale recommendation',
          raw: '<rating>9</rating>',
          valid: true,
        },
      },
    });

    expect(app.deepOverlayModel).toBeNull();
    expect(app.completedOverlayCache.get('group-1', 'chat-review', {
      personaKey: 'personality-2',
      personaVersion: 1,
      personaSource: 'source-a',
      variantKey: null,
    })).toBeNull();
  });

  it('shows Hub configuration truth when legacy provider hints disagree', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState({
      hasApiKey: false,
      modelProviderByFeature: { 'fast-reply': 'openrouter' },
      apiKeyReadyByFeature: { 'fast-reply': true },
    });
    app.currentGroupId = 'group-1';

    app.startFeature('fast-reply', false);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain(
      'CG-HUB-02: Вы не вошли в ChatGoose.',
    );
    expect(document.querySelector('.chatgoose-toast')?.textContent)
      .not.toContain('OpenRouter');
  });

  it('clears the cached result before rerunning Chat Review from the overlay', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn(() => true);

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

    expect(app.completedOverlayCache.get('group-1', 'chat-review', overlayIdentity())).not.toBeNull();
    refreshButton!.click();

    expect(app.completedOverlayCache.get('group-1', 'chat-review', overlayIdentity())).toBeNull();
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'operation:start',
      feature: 'chat-review',
      groupId: 'group-1',
      forceRegenerate: true,
    }));
  });

  it('arming a tone never generates by itself; Reply rides it and resets after dispatch (E24)', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy.mockReturnValue(true);
    app.tabState = readyState();
    app.currentGroupId = 'group-1';

    // A tone segment click ARMS only — the trigger is Reply itself.
    app.armReplyTone('flirty');
    expect(sendSpy).not.toHaveBeenCalled();
    expect(app.nextReplyTone).toBe('flirty');

    // Clicking the armed segment again disarms it.
    app.armReplyTone('flirty');
    expect(app.nextReplyTone).toBe('none');

    app.armReplyTone('flirty');
    app.startFeature('fast-reply', false);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'operation:start',
      feature: 'fast-reply',
      groupId: 'group-1',
      replyTone: 'flirty',
    }));
    expect(app.nextReplyTone).toBe('none');
  });

  it('keeps Split armed across generations and reuses the tone on Regenerate (E24)', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy.mockReturnValue(true);
    app.tabState = readyState();
    app.currentGroupId = 'group-1';

    app.toggleNextFastReplyMode();
    app.armReplyTone('spicy');
    app.startFeature('fast-reply', false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      replyMode: 'preferSplit',
      replyTone: 'spicy',
    }));
    // Split is a sticky flag — it does NOT silently reset after the send
    // (the pre-E24 reset made a Regenerate quietly lose the split).
    expect(app.nextFastReplyMode).toBe('preferSplit');
    // The tone is one-shot…
    expect(app.nextReplyTone).toBe('none');

    // …but a Regenerate re-rolls the same ask: same mode, same tone.
    sendSpy.mockClear();
    app.clearOperationState(true);
    app.startFeature('fast-reply', true);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      forceRegenerate: true,
      replyMode: 'preferSplit',
      replyTone: 'spicy',
    }));

    // A fresh (non-regenerate) reply does NOT inherit the old tone.
    sendSpy.mockClear();
    app.clearOperationState(true);
    app.startFeature('fast-reply', false);
    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      replyMode: 'preferSplit',
      replyTone: 'none',
    }));
  });

  it('enables Fix on the first edit when Fansly creates its textarea after toolbar mount', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const textarea = mountConversationComposer();
    const host = textarea.parentElement!;
    textarea.remove();
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.renderButtonBar();
    const fix = app.buttonBar.buttons.get('improve-draft') as HTMLButtonElement;
    expect(fix.disabled).toBe(true);

    // The host and route survive; only the editor is materialized on focus.
    host.append(textarea);
    textarea.value = 'hey Alex hope your Sunday is going good';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fix.disabled).toBe(false);
    textarea.value = '';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fix.disabled).toBe(true);
  });

  it('tracks a replaced composer while ignoring unrelated inputs and detaches on disconnect', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const previous = mountConversationComposer();
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.renderButtonBar();
    const fix = app.buttonBar.buttons.get('improve-draft') as HTMLButtonElement;
    const replacement = document.createElement('textarea');
    previous.replaceWith(replacement);
    // Give jsdom the visible layout result that the live browser provides.
    Object.defineProperty(replacement, 'offsetParent', { configurable: true, get: () => replacement.parentElement });
    replacement.value = 'new draft';
    const unrelated = document.createElement('textarea');
    document.body.append(unrelated);
    unrelated.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fix.disabled).toBe(true);
    replacement.dispatchEvent(new Event('change', { bubbles: true }));
    expect(fix.disabled).toBe(false);

    app.detachDraftTextareaObserver();
    replacement.value = '';
    replacement.dispatchEvent(new Event('input', { bubbles: true }));
    expect(fix.disabled).toBe(false);
  });

  it('sends the current composer draft with improve-draft operations', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn(() => true);

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
      overlayIdentity('hey babe how was your day'),
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
        // Matches the suite's /messages/group-1 URL — the insert guard
        // compares the minted group against the live location.
        groupId: 'group-1',
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
      overlayIdentity('hey babe how was your day'),
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

    const cached = app.completedOverlayCache.get('group-1', 'fast-reply', overlayIdentity());
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

    expect(app.suppressedTerminalOpIds.has('reply-op')).toBe(true);
    expect(app.activeFeature).toBeNull();
    expect(app.activeOperationId).toBeNull();
    expect((app.inlinePanel.root as HTMLElement).classList.contains('chatgoose-hidden')).toBe(true);

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
    expect(app.completedOverlayCache.get('group-2', 'fast-reply', overlayIdentity())).toBeNull();
    // Operation state must be fully cleared
    expect(app.activeFeature).toBeNull();
    expect(app.activeOperationId).toBeNull();
    expect(app.suppressedTerminalOpIds.size).toBe(0);
  });

  it('keeps a newer operation running when a suppressed old completion arrives', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.port.send = vi.fn();
    app.mountController = { setActiveRoute: vi.fn() };
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'old-reply-op';
    app.lastFeature = 'fast-reply';

    app.handleRouteChange('group-2');
    expect(app.suppressedTerminalOpIds.has('old-reply-op')).toBe(true);

    app.activeFeature = 'ping';
    app.activeOperationId = 'new-ping-op';
    app.lastFeature = 'ping';
    app.activeFanDisplayName = 'bob';

    app.handleComplete({
      type: 'operation:complete',
      operationId: 'old-reply-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Stale result from group-1',
        parts: ['Stale result from group-1'],
      },
    });

    expect(app.completedOverlayCache.get('group-2', 'fast-reply', overlayIdentity())).toBeNull();
    expect(app.activeFeature).toBe('ping');
    expect(app.activeOperationId).toBe('new-ping-op');
    expect(app.suppressedTerminalOpIds.size).toBe(0);
  });

  it('clears the loading state when a feature start is dropped by a disconnected port', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.port.send = vi.fn(() => false);
    const toastSpy = vi.spyOn(app, 'showUserErrorToast').mockImplementation(() => {});
    app.tabState = readyState();
    app.currentGroupId = 'group-1';

    app.startFeature('fast-reply', false);

    // The start never reached the background, so the UI must not be left stuck.
    expect(app.activeFeature).toBeNull();
    expect(app.activeOperationId).toBeNull();
    expect(toastSpy).toHaveBeenCalled();
  });

  it('suppresses an in-flight overlay feature after route change instead of polluting the new group', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.port.send = vi.fn();
    app.mountController = { setActiveRoute: vi.fn() };
    app.tabState = readyState({ hasAvailableSummary: false });
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fan-summary';
    app.activeOperationId = 'summary-op';
    app.activeFanDisplayName = 'alice';
    app.activeProgress = {
      operationId: 'summary-op',
      feature: 'fan-summary',
      phase: 'generating',
      message: 'Still working',
    };
    app.overlayRawText = 'Stale summary stream';
    app.lastFeature = 'fan-summary';
    app.renderSurfaces();
    expect(document.body.textContent).toContain('Stale summary stream');

    // Navigate away while the deep overlay operation is in-flight.
    app.handleRouteChange('group-2');

    expect(app.suppressedTerminalOpIds.has('summary-op')).toBe(true);
    expect(app.activeFeature).toBeNull();
    expect(app.activeOperationId).toBeNull();
    expect(app.activeProgress).toBeNull();
    expect(app.overlayRawText).toBe('');
    expect(document.body.textContent).not.toContain('Stale summary stream');

    // The stale summary completion arrives for the old conversation.
    app.handleComplete({
      type: 'operation:complete',
      operationId: 'summary-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Stale summary from group-1',
        parts: ['Stale summary from group-1'],
      },
    });

    // Must not cache under or mark the new group as summary-ready.
    expect(app.completedOverlayCache.get('group-2', 'fan-summary', overlayIdentity())).toBeNull();
    expect(app.tabState.hasAvailableSummary).toBe(false);
    expect(app.activeFeature).toBeNull();
    expect(app.suppressedTerminalOpIds.size).toBe(0);
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
      app.completedOverlayCache.get(
        'group-1', 'fan-summary', overlayIdentity(), 'recap-full',
      ).summaryMeta.syncStatus.state,
    ).toBe('saved');

    app.deepOverlayModel = null;
    sendSpy.mockClear();
    app.startFeature('fan-summary', false);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(app.deepOverlayModel.summaryMeta.syncStatus.state).toBe('saved');
  });

  it('never applies a full-dossier sync update to a short recap with the same timestamp', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.port.send = vi.fn(() => true);
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeFeature = 'fan-summary';
    app.activeOperationId = 'full-op';
    app.activeFanDisplayName = 'alice';
    app.handleComplete({
      type: 'operation:complete',
      operationId: 'full-op',
      fanDisplayName: 'alice',
      result: {
        rawText: 'Full recap',
        summaryMeta: {
          generatedAt: 2000,
          stale: false,
          cached: false,
          syncStatus: { state: 'saving', generatedAt: 2000, updatedAt: 2000 },
        },
      },
    });

    app.startStandaloneRecap('short');
    app.handleComplete({
      type: 'operation:complete',
      operationId: app.activeOperationId,
      fanDisplayName: 'alice',
      result: {
        rawText: 'Short recap',
        summaryMeta: { generatedAt: 2000, stale: false, cached: false },
      },
    });
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

    expect(app.deepOverlayModel.recapMode).toBe('short');
    expect(app.deepOverlayModel.summaryMeta.syncStatus).toBeUndefined();
    expect(app.completedOverlayCache.get(
      'group-1', 'fan-summary', overlayIdentity(), 'recap-full',
    ).summaryMeta.syncStatus.state).toBe('saved');
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
          message: 'Ошибка запроса к Agency Hub.',
        },
      },
    });

    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('CG-HUB-08');
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain(
      'Не удалось синхронизировать рекап с Hub.',
    );
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain(
      'Последняя ошибка Hub: CG-HUB-07: Ошибка запроса к Agency Hub.',
    );
  });

  it('starts a fresh compare run instead of reopening completed cached compare results', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn(() => true);

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

    app.port.send = sendSpy.mockReturnValue(true);
    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    // Compare uses whatever tone is armed (a tone segment or the ⌘⇧O cycle).
    app.nextReplyTone = 'upsell';

    await app.startCompare(false);

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'compare:start',
      groupId: 'group-1',
      replyTone: 'upsell',
    }));
    expect(app.nextReplyTone).toBe('none');
  });

  it('blocks compare on missing Hub transport without reviving provider-key copy', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn();

    app.port.send = sendSpy;
    app.tabState = readyState({
      hasApiKey: false,
      modelProviderByFeature: { 'fast-reply': 'openrouter' },
      apiKeyReadyByFeature: { 'fast-reply': true },
    });
    app.currentGroupId = 'group-1';

    await app.startCompare(false);

    expect(sendSpy).not.toHaveBeenCalled();
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain(
      'CG-HUB-02: Вы не вошли в ChatGoose.',
    );
    expect(document.querySelector('.chatgoose-toast')?.textContent)
      .not.toContain('OpenRouter');
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

  it('cancels and discards an in-flight compare when the persona definition changes', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn(() => true);

    app.port.send = sendSpy;
    app.tabState = readyState({ mappedPersonaDefinitionId: 'v1:persona-one-definition' });
    app.currentGroupId = 'group-1';
    app.activeCompareModel = createCompareModel({
      operationId: 'compare-op',
      canCancel: true,
      canRegenerate: false,
    });
    app.comparePanelVisible = true;
    app.pendingCompareFingerprint = 'persona-v1';

    app.handlePortMessage({
      type: 'settings:changed',
      state: readyState({ mappedPersonaDefinitionId: 'v1:persona-two-definition' }),
    });

    expect(sendSpy).toHaveBeenCalledWith({
      type: 'compare:cancel',
      operationId: 'compare-op',
    });
    expect(app.activeCompareModel).toBeNull();
    expect(app.comparePanelVisible).toBe(false);
    expect(app.pendingCompareFingerprint).toBeNull();

    app.handleCompareComplete({
      type: 'compare:complete',
      operationId: 'compare-op',
      fanDisplayName: 'alice',
    });
    expect(app.completedCompareCache.get('group-1')).toBeNull();
  });

  it('clears a completed compare immediately when the account is remapped', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    app.activeCompareModel = createCompareModel();
    app.comparePanelVisible = true;
    app.completedCompareCache.set('group-1', {
      model: createCompareModel(),
      fingerprint: 'persona-a-v1',
    });

    app.handlePortMessage({
      type: 'mapping:changed',
      state: readyState({
        mappedPersonalityId: 'personality-2',
        mappedPersonalityName: 'Other',
        mappedPersonaVersion: 1,
      }),
    });

    expect(app.completedCompareCache.get('group-1')).toBeNull();
    expect(app.activeCompareModel).toBeNull();
    expect(app.comparePanelVisible).toBe(false);
  });

  it('clears cached compare results on conversation change and starts a new compare request', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const sendSpy = vi.fn(() => true);

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

    // The toolbar entry is gone; the retained internal restore path still
    // accepts a matching cached result without generating again.
    expect(await app.restoreCompletedComparePanel()).toBe(true);
    expect(app.comparePanelVisible).toBe(true);

    expect(app.inlinePanel.root.querySelector('.chatgoose-compare-tab')?.textContent).toContain('Closer (current)');
  });

  it('invalidates closed completed compare cache when the fingerprint changes', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    app.tabState = readyState();
    app.currentGroupId = 'group-1';
    mockStorageState = createStorageState({
      personaCatalog: [
        { key: 'personality-1', displayName: 'Closer', definitionId: 'v1:persona-one-definition', version: 1, status: 'active' },
      ],
    });
    app.completedCompareCache.set('group-1', {
      model: createCompareModel(),
      fingerprint: await app.computeCompareFingerprint(),
    });
    mockStorageState = createStorageState({
      personaCatalog: [
        { key: 'personality-1', displayName: 'Closer', definitionId: 'v1:persona-two-definition', version: 2, status: 'active' },
      ],
    });

    app.renderButtonBar();
    const buttonBarRoot = app.buttonBar.root as HTMLElement;
    const reopenButton = (Array.from(buttonBarRoot.querySelectorAll('button')) as HTMLButtonElement[])
      .find((button) => button.textContent === 'Reopen');
    expect(reopenButton).toBeUndefined();

    expect(await app.restoreCompletedComparePanelInternal(true)).toBe(false);
    expect(app.completedCompareCache.get('group-1')).toBeNull();

    expect(app.comparePanelVisible).toBe(false);
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('Saved compare is outdated. Run Compare again.');
  });

  it('closing a completed compare hides the panel and preserves the cache without adding Reopen', async () => {
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
    app.suppressedTerminalOpIds.add('some-op');

    // Simulate disconnect
    app.completedOverlayCache.clearAll();
    app.quickInlineVisible = false;
    app.quickSurfaceMode = 'inline';
    app.suppressedTerminalOpIds.clear();
    app.clearOperationState(true);
    app.renderAll();

    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(true);
    expect(app.activeFeature).toBeNull();
    expect(app.activeOperationId).toBeNull();
    expect(app.quickSurfaceMode).toBe('inline');
    expect(app.quickInlineVisible).toBe(false);
    expect(app.suppressedTerminalOpIds.size).toBe(0);
    expect(app.deepOverlayModel).toBeNull();
  });

  it('builds a read-only completed overlay model for a coach completion, not an error', async () => {
    // Round-9 P2: buildCompletedOverlayModel must have a coach-chat case. Without
    // it, coach falls through to the reply path (resultPartTexts→[]) and renders a
    // bogus ai_output_unusable error, discarding the advice. On the full stack a
    // coach completion is intercepted earlier; this keeps slice 1 correct anyway.
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;

    const advice = 'Open with a question about her weekend, then bridge to the PPV.';
    const model = app.buildCompletedOverlayModel('coach-chat', 'coach-op', 'alice', {
      rawText: advice,
    });

    expect(model.kind).toBe('readOnly');
    expect(model.feature).toBe('coach-chat');
    expect(model.rawText).toBe(advice);
    // The advice is surfaced, NOT swallowed into an unusable-output error.
    expect(model.error).toBeUndefined();
  });

  it('deep-links an error toast to the pane that can fix that error', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const runtime = (globalThis as any).browser.runtime;

    app.showUserErrorToast(getErrorMessage('no_mapping'));
    const action = document.querySelector<HTMLButtonElement>(
      '.chatgoose-toast-actions .chatgoose-button',
    );
    expect(action?.textContent).toBe('Настройки');
    action?.click();

    // «Настройте персону» lands on the pane that assigns one — with the code, so
    // the page can say why it opened there.
    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'openOptions',
      pane: 'accounts',
      code: 'CG-FLOW-02',
    });
    // The native opener is the DEAD-runtime path only: using it here would risk a
    // second options tab, i.e. a second pagehide settings writer.
    expect(runtime.openOptionsPage).not.toHaveBeenCalled();
  });

  it('routes a hub error toast to the Hub pane', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const runtime = (globalThis as any).browser.runtime;

    app.showUserErrorToast(getErrorMessage('hub_missing_permission'));
    document.querySelector<HTMLButtonElement>(
      '.chatgoose-toast-actions .chatgoose-button',
    )?.click();

    expect(runtime.sendMessage).toHaveBeenCalledWith({
      type: 'openOptions',
      pane: 'hub',
      code: 'CG-HUB-04',
    });
  });

  it('offers sign-in before persona setup and routes it to the sign-in pane', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    app.handlePortMessage({
      type: 'tab:state',
      state: readyState({ signedIn: false, hasApiKey: false }),
    });
    const banner = app.mappingBanner.root as HTMLElement;
    expect(banner.textContent).toContain('Войдите в ChatGoose');
    expect(banner.querySelector('select')).toBeNull();
    banner.querySelector<HTMLButtonElement>('button')?.click();
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'openOptions', pane: 'hub', code: 'CG-HUB-02',
    });
    app.handlePortMessage({ type: 'settings:changed', state: readyState({ signedIn: true }) });
    expect(banner.classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('falls back to the native opener when the runtime cannot answer', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const runtime = (globalThis as any).browser.runtime;
    runtime.sendMessage.mockRejectedValueOnce(new Error('Could not establish connection'));

    app.showUserErrorToast(getErrorMessage('no_mapping'));
    document.querySelector<HTMLButtonElement>(
      '.chatgoose-toast-actions .chatgoose-button',
    )?.click();
    await vi.waitFor(() => {
      // A rejected request opened nothing, so the fallback cannot double-open.
      expect(runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    });
  });

  it('falls back natively when the runtime answers that it opened nothing', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const runtime = (globalThis as any).browser.runtime;
    // A resolved refusal (tabs.create denied), not a rejection: treating it as
    // success left «Настройки» dead — one click and nothing happens at all.
    runtime.sendMessage.mockResolvedValueOnce({ opened: false, reused: false });

    app.showUserErrorToast(getErrorMessage('no_mapping'));
    document.querySelector<HTMLButtonElement>(
      '.chatgoose-toast-actions .chatgoose-button',
    )?.click();
    await vi.waitFor(() => {
      expect(runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    });
  });

  it('sends the mapping banner to the pane matching WHICH gap it reported', async () => {
    const ChatGooseContentApp = await loadAppClass();
    const app = new ChatGooseContentApp() as any;
    const runtime = (globalThis as any).browser.runtime;

    // No active personas exist at all: the fix is in «Персоны».
    mockStorageState = createStorageState({ personaCatalog: [] });
    await app.mappingBanner.render('account-1', false);
    (app.mappingBanner.root as HTMLElement)
      .querySelector<HTMLButtonElement>('button')?.click();
    expect(runtime.sendMessage).toHaveBeenLastCalledWith({
      type: 'openOptions',
      pane: 'personas',
      code: 'CG-FLOW-01',
    });

    // A persona exists but this account has none: the fix is in «Аккаунты».
    mockStorageState = createStorageState({
      personaCatalog: [
        { key: 'personality-1', displayName: 'Closer', definitionId: 'v1:persona-one-definition', version: 1, status: 'active' },
      ],
      accountMappings: {},
    });
    await app.mappingBanner.render('account-1', false);
    const buttons = Array.from(
      (app.mappingBanner.root as HTMLElement).querySelectorAll('button'),
    ) as HTMLButtonElement[];
    buttons.find((button) => button.textContent === 'Settings')?.click();
    expect(runtime.sendMessage).toHaveBeenLastCalledWith({
      type: 'openOptions',
      pane: 'accounts',
      code: 'CG-FLOW-02',
    });
  });
  describe('keyboard → the shared hotkey engine', () => {
    const ENGINE_SLOT = Symbol.for('chatgoose.hotkeys.engine');

    async function keyboardApp(platform: 'MacIntel' | 'Win32') {
      delete (globalThis as unknown as Record<symbol, unknown>)[ENGINE_SLOT];
      Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
      const ChatGooseContentApp = await loadAppClass();
      const app = new ChatGooseContentApp() as any;
      app.dispatchBootstrapHotkey = vi.fn((action: string, groupId: string | null) =>
        groupId !== null || action === 'spenders-board' || action === 'cheatsheet');
      app.installKeymap();
      return app;
    }

    function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): boolean {
      const event = new window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    }

    const metaDown = () => key('keydown', { key: 'Meta', code: 'MetaLeft', metaKey: true });
    const ctrlDown = () => key('keydown', { key: 'Control', code: 'ControlLeft', ctrlKey: true });

    it('runs Reply on ⌘E in the Russian layout and swallows the auto-repeat', async () => {
      const app = await keyboardApp('MacIntel');
      metaDown();
      expect(key('keydown', { key: 'у', code: 'KeyE', metaKey: true })).toBe(true);
      expect(key('keydown', { key: 'у', code: 'KeyE', metaKey: true, repeat: true })).toBe(true);
      expect(app.dispatchBootstrapHotkey).toHaveBeenCalledTimes(1);
      expect(app.dispatchBootstrapHotkey).toHaveBeenCalledWith('fast-reply', 'group-1');
    });

    it('swallows the retired ⌘⇧D / ⌘⇧F in a chat and leaves ⌘F to Firefox', async () => {
      const app = await keyboardApp('MacIntel');
      metaDown();
      key('keydown', { key: 'Shift', code: 'ShiftLeft', metaKey: true, shiftKey: true });
      expect(key('keydown', { key: 'D', code: 'KeyD', metaKey: true, shiftKey: true })).toBe(true);
      key('keyup', { key: 'Shift', code: 'ShiftLeft', metaKey: true });
      key('keyup', { key: 'Meta', code: 'MetaLeft' });
      metaDown();
      expect(key('keydown', { key: 'f', code: 'KeyF', metaKey: true })).toBe(false);
      expect(app.dispatchBootstrapHotkey).not.toHaveBeenCalled();
    });

    it('keeps ⌘⇧E as Reply and ⌘⇧H as Help', async () => {
      const app = await keyboardApp('MacIntel');
      metaDown();
      key('keydown', { key: 'Shift', code: 'ShiftLeft', metaKey: true, shiftKey: true });
      expect(key('keydown', { key: 'E', code: 'KeyE', metaKey: true, shiftKey: true })).toBe(true);
      expect(key('keydown', { key: 'H', code: 'KeyH', metaKey: true, shiftKey: true })).toBe(true);
      expect(app.dispatchBootstrapHotkey.mock.calls.map((call: unknown[]) => call[0]))
        .toEqual(['fast-reply', 'help-me']);
    });

    it('swallows a Windows roll-over after a Ctrl+Shift language switch', async () => {
      const app = await keyboardApp('Win32');
      ctrlDown();
      key('keydown', { key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true });
      key('keyup', { key: 'Shift', code: 'ShiftLeft', ctrlKey: true });
      expect(key('keydown', { key: 'у', code: 'KeyE', ctrlKey: true })).toBe(true);
      expect(app.dispatchBootstrapHotkey).not.toHaveBeenCalled();
      key('keyup', { key: 'Control', code: 'ControlLeft' });
      ctrlDown();
      expect(key('keydown', { key: 'e', code: 'KeyE', ctrlKey: true })).toBe(true);
      expect(app.dispatchBootstrapHotkey).toHaveBeenCalledWith('fast-reply', 'group-1');
    });

    it('outside a chat leaves Ctrl+E to Firefox but still opens Spenders on Ctrl+Alt+M', async () => {
      const app = await keyboardApp('Win32');
      window.history.replaceState({}, '', '/home');
      ctrlDown();
      expect(key('keydown', { key: 'e', code: 'KeyE', ctrlKey: true })).toBe(false);
      key('keyup', { key: 'Control', code: 'ControlLeft' });
      ctrlDown();
      key('keydown', { key: 'Alt', code: 'AltLeft', ctrlKey: true, altKey: true });
      expect(key('keydown', { key: 'm', code: 'KeyM', ctrlKey: true, altKey: true })).toBe(true);
      expect(app.dispatchBootstrapHotkey).toHaveBeenLastCalledWith('spenders-board', null);
    });
  });
});
