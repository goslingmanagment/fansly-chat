/* eslint-disable @typescript-eslint/no-explicit-any --
   legacy suite pokes ChatGooseContentApp privates via `as any` throughout;
   typed access is a Stage 32 Task 3 rewrite concern (the app surface changes
   there anyway). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import {
  STORAGE_SCHEMA_VERSION,
} from '../src/shared/constants.js';
import type {
  CompareInlineViewModel,
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
});
