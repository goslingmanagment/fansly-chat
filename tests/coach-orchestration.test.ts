/* eslint-disable @typescript-eslint/no-explicit-any --
   like content-app.test.ts, this suite drives ChatGooseContentApp privates via
   `as any`: the coach lifecycle (Task 10) is wired through private methods and
   closure-held state, and the app surface is intentionally not a public API. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { STORAGE_SCHEMA_VERSION } from '../src/shared/constants.js';
import type { TabUiState } from '../src/shared/types.js';

let mockStorageState: Record<string, unknown>;
let recapStatusResponse: unknown;

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
  (globalThis as Record<string, unknown>).browser = {
    runtime: {
      openOptionsPage: vi.fn(async () => undefined),
      sendMessage: vi.fn(async () => recapStatusResponse),
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
    voiceNotesCapable: false,
    connected: true,
    hasApiKey: true,
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

function createStorageState(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    schemaVersion: STORAGE_SCHEMA_VERSION,
    settings: {
      quickMessageCount: 100,
      pingMessageCount: 100,
      improveMessageCount: 100,
      deepMessageCount: 3000,
      coachHistoryLimit: 10,
      coachAutoRecap: 'off',
      debugMode: false,
      promptCachingEnabled: true,
    },
    personalities: [
      { id: 'personality-1', name: 'Closer', content: 'Sell smoothly', updatedAt: 1000 },
    ],
    accountMappings: { 'account-1': 'personality-1' },
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

/** Construct an app with a ready tab state, group, and a send-succeeds port. */
async function makeReadyApp(): Promise<any> {
  const ChatGooseContentApp = await loadAppClass();
  const app = new ChatGooseContentApp() as any;
  app.port.send = vi.fn(() => true);
  app.mountController = { setActiveRoute: vi.fn() };
  app.tabState = readyState();
  app.currentGroupId = 'group-1';
  return app;
}

/** The operationId the pending coach turn is running under. */
function pendingOpId(app: any): string {
  return app.activeCoachSession.pending.operationId as string;
}

/** Flush pending microtasks + the setTimeout(0)-based rAF shim so the async
 * recap-status read and the auto-recap chain's follow-up submit settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function freshSlot(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: new Date().toISOString(),
    ageMs: 60_000, // 1 min — well under the 24h freshness threshold
    transcriptCoverage: 'full-history',
    requestedCount: 3000,
    keptCount: 200,
    ...overrides,
  };
}

function staleSlot(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: 'old',
    ageMs: 48 * 60 * 60 * 1000, // 48h — stale
    transcriptCoverage: 'window',
    requestedCount: 3000,
    keptCount: 200,
    ...overrides,
  };
}

/** The last op:start payload the app sent. */
function lastSent(app: any): any {
  const calls = (app.port.send as any).mock.calls;
  return calls.at(-1)?.[0];
}

describe('Coach orchestration', () => {
  beforeEach(() => {
    mockStorageState = createStorageState();
    recapStatusResponse = { full: null, short: null };
    installDom();
  });

  afterEach(() => {
    (globalThis.window as Window | undefined)?.close?.();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('opening Coach creates no generation (no operation:start on the port)', async () => {
    const app = await makeReadyApp();

    app.openCoach();

    expect(app.port.send).not.toHaveBeenCalled();
    expect(app.coachOverlayModel).not.toBeNull();
    expect(app.coachOverlayModel.kind).toBe('coach');
    expect(app.activeFeature).toBeNull();
  });

  it('opening Coach with no resolvable fan/group shows a toast and does not open', async () => {
    const app = await makeReadyApp();
    app.currentGroupId = null;

    app.openCoach();

    expect(app.coachOverlayModel).toBeNull();
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('CG-APP-02');
  });

  it('submit sends exactly one coach operation with the coach payload fields', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    (app.port.send as any).mockClear();

    await app.submitCoachQuestion('  how do I sell this PPV?  ');

    expect(app.port.send).toHaveBeenCalledTimes(1);
    const payload = (app.port.send as any).mock.calls[0][0];
    expect(payload).toMatchObject({
      type: 'operation:start',
      feature: 'coach-chat',
      groupId: 'group-1',
      chatterQuestion: 'how do I sell this PPV?',
      coachHistory: [],
      coachSessionId: app.activeCoachSession.sessionId,
    });
    // Carry-forward 2: the session id must ride the payload (not a per-tab key).
    expect(typeof payload.coachSessionId).toBe('string');
    expect(payload.coachSessionId.length).toBeGreaterThan(0);
    // The pending marker is armed and the composer cleared (carry-forward 7).
    expect(app.activeCoachSession.pending.question).toBe('how do I sell this PPV?');
    expect(app.activeCoachSession.composerText).toBe('');
    expect(app.activeFeature).toBe('coach-chat');
  });

  it('replays prior completed exchanges as serialized coachHistory on the next turn', async () => {
    const app = await makeReadyApp();
    app.openCoach();

    await app.submitCoachQuestion('first question');
    const opId1 = pendingOpId(app);
    app.handleComplete({
      type: 'operation:complete',
      operationId: opId1,
      fanDisplayName: 'alice',
      result: { rawText: 'first answer', parts: [] },
      generationRef: 'gen-1',
    });

    (app.port.send as any).mockClear();
    await app.submitCoachQuestion('second question');

    const payload = (app.port.send as any).mock.calls[0][0];
    expect(payload.coachHistory).toEqual([
      { question: 'first question', answer: 'first answer' },
    ]);
  });

  it('blocks submit when the port drops the start and clears the pending marker', async () => {
    const app = await makeReadyApp();
    app.port.send = vi.fn(() => false);
    app.openCoach();

    await app.submitCoachQuestion('dropped');

    expect(app.activeCoachSession.pending).toBeUndefined();
    expect(app.activeFeature).toBeNull();
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('CG-FLOW-07');
    // A dropped start never became a turn — no failed-attempt feed item.
    expect(app.activeCoachSession.feedItems).toHaveLength(0);
  });

  it('appends streamed chunks into the pending answer (never overlayRawText)', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await app.submitCoachQuestion('why');
    const opId = pendingOpId(app);

    app.handleChunk(opId, 'Because ');
    app.handleChunk(opId, 'she likes it.');

    expect(app.coachPendingAnswerText).toBe('Because she likes it.');
    expect(app.overlayRawText).toBe('');
    expect(app.coachOverlayModel.sessionView.pendingAnswerText).toBe('Because she likes it.');
  });

  it('commits the completed stream as an exchange carrying its generationRef', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await app.submitCoachQuestion('advise me');
    const opId = pendingOpId(app);
    app.handleChunk(opId, 'ignored partial');

    app.handleComplete({
      type: 'operation:complete',
      operationId: opId,
      fanDisplayName: 'alice',
      result: { rawText: 'Try this angle.\n```draft\nHey love!\n```', parts: [] },
      generationRef: 'gen-ref-9',
    });

    const exchanges = app.activeCoachSession.completedExchanges;
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]).toMatchObject({
      operationId: opId,
      generationRef: 'gen-ref-9',
      question: 'advise me',
      answerRaw: 'Try this angle.\n```draft\nHey love!\n```',
    });
    expect(exchanges[0].drafts.map((d: any) => d.text)).toEqual(['Hey love!']);
    // Op state cleared, coach overlay retained.
    expect(app.activeFeature).toBeNull();
    expect(app.activeCoachSession.pending).toBeUndefined();
    expect(app.coachOverlayModel).not.toBeNull();
    // Never routed through the completed-overlay / deep path (carry-forwards 5/6).
    expect(app.deepOverlayModel).toBeNull();
  });

  it('surfaces a coach error as an in-feed failed-attempt, not a separate error overlay', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await app.submitCoachQuestion('will this fail?');
    const opId = pendingOpId(app);

    app.handleOperationError({
      type: 'operation:error',
      operationId: opId,
      error: { code: 'CG-AI-01', message: 'Generation failed.' },
    });

    const failed = app.activeCoachSession.feedItems.find((i: any) => i.kind === 'failed-attempt');
    expect(failed).toBeDefined();
    expect(failed.question).toBe('will this fail?');
    // No separate error overlay — the failure lives inside the coach feed.
    expect(app.deepOverlayModel).toBeNull();
    expect(app.coachOverlayModel.kind).toBe('coach');
    expect(app.activeFeature).toBeNull();
  });

  it('user cancel records a cancelled failed-attempt (recordFailedAttempt, not clearPending)', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await app.submitCoachQuestion('cancel me');
    const opId = pendingOpId(app);
    app.handleChunk(opId, 'partial answer');

    // ⌘⇧X path.
    app.cancelActiveOperation();

    const failed = app.activeCoachSession.feedItems.find((i: any) => i.kind === 'failed-attempt');
    // If clearPending had run first, recordFailedAttempt's guard would drop the
    // item — its presence proves the carry-forward-3 ordering.
    expect(failed).toBeDefined();
    expect(failed.question).toBe('cancel me');
    expect(failed.errorCode).toBe('cancelled');
    expect(failed.retryable).toBe(true);
    expect(app.activeCoachSession.pending).toBeUndefined();
    expect(app.activeFeature).toBeNull();
    // The terminal that follows the cancel must be suppressed (silent).
    expect(app.suppressedTerminalOpIds.has(opId)).toBe(true);
  });

  it('route switch preserves the session + pending question in the composer', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await app.submitCoachQuestion('unsent while streaming');
    const opId = pendingOpId(app);

    app.handleRouteChange('group-2');

    // The op is torn down via the existing suppression machinery.
    expect(app.suppressedTerminalOpIds.has(opId)).toBe(true);
    expect(app.activeFeature).toBeNull();
    // Overlay closed; session RETAINED in the store keyed by (account, group).
    expect(app.coachOverlayModel).toBeNull();
    expect(app.activeCoachSession).toBeNull();

    const retained = app.coachStore.getOrCreate('account-1', 'group-1');
    expect(retained.composerText).toBe('unsent while streaming');
    expect(retained.pending).toBeUndefined();

    // Returning to the fan restores the dialog with the preserved composer.
    app.handleRouteChange('group-1');
    app.openCoach();
    expect(app.coachOverlayModel.sessionView.composerText).toBe('unsent while streaming');
  });

  it('coach streaming blocks another feature (single active operation)', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await app.submitCoachQuestion('streaming');
    (app.port.send as any).mockClear();

    app.startFeature('fast-reply', false);

    expect(app.port.send).not.toHaveBeenCalled();
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('CG-FLOW-04');
    expect(app.activeFeature).toBe('coach-chat');
  });

  it('idle Coach yields to another feature: closes (session retained) and proceeds', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    expect(app.coachOverlayModel).not.toBeNull();

    app.startFeature('fast-reply', false);

    expect(app.coachOverlayModel).toBeNull();
    expect(app.activeCoachSession).toBeNull();
    expect(app.port.send).toHaveBeenCalledWith(expect.objectContaining({
      type: 'operation:start',
      feature: 'fast-reply',
    }));
    // The session survives in the store.
    expect(app.coachStore.getOrCreate('account-1', 'group-1')).toBeDefined();
  });

  it('opens Coach over a cached inline result instead of silently no-opping', async () => {
    const app = await makeReadyApp();
    // A completed reply is showing in the inline panel.
    app.activeFeature = 'fast-reply';
    app.activeOperationId = 'reply-op';
    app.lastFeature = 'fast-reply';
    app.quickSurfaceEverOpened = true;
    app.quickInlineVisible = true;
    app.handleComplete({
      type: 'operation:complete',
      operationId: 'reply-op',
      fanDisplayName: 'alice',
      result: { rawText: 'Hi there', parts: ['Hi there'] },
    });
    const inlineRoot = app.inlinePanel.root as HTMLElement;
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(false);

    app.openCoach();

    expect(app.coachOverlayModel?.kind).toBe('coach');
    expect(app.quickInlineVisible).toBe(false);
    // The coach overlay actually renders; the cached inline panel is hidden.
    expect(inlineRoot.classList.contains('chatgoose-hidden')).toBe(true);
    expect(document.querySelector('.chatgoose-coach')).not.toBeNull();
  });

  it('opens Coach over a completed compare panel', async () => {
    const app = await makeReadyApp();
    app.activeCompareModel = {
      kind: 'compare',
      fanDisplayName: 'alice',
      operationId: null,
      tabs: [],
      activeCardId: null,
      progress: null,
      canCancel: false,
      canRegenerate: true,
    };
    app.comparePanelVisible = true;

    app.openCoach();

    expect(app.coachOverlayModel?.kind).toBe('coach');
    expect(app.activeCompareModel).toBeNull();
    expect(app.comparePanelVisible).toBe(false);
    expect(document.querySelector('.chatgoose-coach')).not.toBeNull();
  });

  it('persona / account mapping change wipes every coach session', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await app.submitCoachQuestion('hi');
    const opId = pendingOpId(app);
    app.handleComplete({
      type: 'operation:complete',
      operationId: opId,
      fanDisplayName: 'alice',
      result: { rawText: 'answer', parts: [] },
      generationRef: 'g',
    });
    expect(app.coachStore.getOrCreate('account-1', 'group-1').completedExchanges).toHaveLength(1);

    app.handlePortMessage({
      type: 'mapping:changed',
      state: readyState({
        mappedPersonalityId: 'personality-2',
        mappedPersonalityName: 'Other',
      }),
    });

    // resetAll wiped the store: getOrCreate now mints a fresh empty session.
    expect(app.coachStore.getOrCreate('account-1', 'group-1').completedExchanges).toHaveLength(0);
    expect(app.coachOverlayModel).toBeNull();
    expect(app.activeCoachSession).toBeNull();
  });

  it('persists live composer edits into the session (carry-forward 7)', async () => {
    const app = await makeReadyApp();
    app.openCoach();

    app.handleCoachComposerInput('half-typed question');

    expect(app.activeCoachSession.composerText).toBe('half-typed question');
  });

  it('New dialog resets the session in place with a fresh sessionId', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await app.submitCoachQuestion('q');
    const opId = pendingOpId(app);
    app.handleComplete({
      type: 'operation:complete',
      operationId: opId,
      fanDisplayName: 'alice',
      result: { rawText: 'a', parts: [] },
      generationRef: 'g',
    });
    const oldSessionId = app.activeCoachSession.sessionId;

    app.resetCoachSession();

    expect(app.activeCoachSession.completedExchanges).toHaveLength(0);
    expect(app.activeCoachSession.feedItems).toHaveLength(0);
    expect(app.activeCoachSession.sessionId).not.toBe(oldSessionId);
  });

  it('Retry replays a failed attempt as a fresh coach operation', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await app.submitCoachQuestion('retry me');
    const opId = pendingOpId(app);
    app.handleOperationError({
      type: 'operation:error',
      operationId: opId,
      error: { code: 'CG-AI-01', message: 'nope' },
    });
    (app.port.send as any).mockClear();

    await app.handleCoachRetry('retry me');

    const payload = (app.port.send as any).mock.calls[0][0];
    expect(payload).toMatchObject({ feature: 'coach-chat', chatterQuestion: 'retry me' });
    // A NEW operation id (spec §8: retry = fresh UUID + fresh transcript).
    expect(payload.operationId).not.toBe(opId);
  });

  it('explicit recap refresh (onCoachRecap) runs an in-feed recap step, Coach stays open, no question chains', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await flush();
    (app.port.send as any).mockClear();

    app.handleCoachRecap('short');

    // Coach overlay stays; a running recap step appears; the op is a
    // forceRegenerate fan-summary with the chosen mode.
    expect(app.coachOverlayModel.kind).toBe('coach');
    const step = app.activeCoachSession.feedItems.find((i: any) => i.kind === 'recap-step');
    expect(step).toMatchObject({ mode: 'short', origin: 'explicit', status: 'running' });
    const payload = lastSent(app);
    expect(payload).toMatchObject({ feature: 'fan-summary', summaryMode: 'short', forceRegenerate: true });
    expect(app.coachRecapChain).not.toBeNull();

    // Completing it marks the step done and chains NO question (explicit).
    const recapOpId = app.coachRecapChain.operationId;
    (app.port.send as any).mockClear();
    app.handleComplete({
      type: 'operation:complete',
      operationId: recapOpId,
      fanDisplayName: 'alice',
      result: { rawText: 'recap body', parts: [] },
    });
    await flush();
    expect(step.status).toBe('done');
    expect(app.coachRecapChain).toBeNull();
    // No coach-chat op followed the explicit refresh.
    expect((app.port.send as any).mock.calls.every((c: any) => c[0].feature !== 'coach-chat')).toBe(true);
  });

  it('dispatchHotkey handles the coach and recap-picker arms (returns true)', async () => {
    const app = await makeReadyApp();

    expect(app.dispatchHotkey('coach')).toBe(true);
    expect(app.dispatchHotkey('fan-summary')).toBe(true);
  });

  // ─── Recap picker (spec §5) ──────────────────────────────────────────

  it('⌘⇧S opens the recap picker without starting a generation', async () => {
    const app = await makeReadyApp();

    app.dispatchHotkey('fan-summary');

    expect(app.recapPickerModel).not.toBeNull();
    expect(app.recapPickerModel.kind).toBe('recap-picker');
    // No op:start went out — the picker is spend-free until a mode is picked.
    expect((app.port.send as any).mock.calls.some((c: any) => c[0]?.type === 'operation:start')).toBe(false);
  });

  it('picking Полный / Короткий starts a fan-summary op with summaryMode + forceRegenerate', async () => {
    const app = await makeReadyApp();
    app.openRecapPicker();
    (app.port.send as any).mockClear();

    app.pickStandaloneRecap('full');
    expect(app.recapPickerModel).toBeNull();
    expect(lastSent(app)).toMatchObject({ feature: 'fan-summary', summaryMode: 'full', forceRegenerate: true });
    expect(app.activeFeature).toBe('fan-summary');

    app.clearOperationState(true);
    app.openRecapPicker();
    (app.port.send as any).mockClear();
    app.pickStandaloneRecap('short');
    expect(lastSent(app)).toMatchObject({ feature: 'fan-summary', summaryMode: 'short', forceRegenerate: true });
  });

  it('«Открыть последний» dispatches a view-cached-only fan-summary (no forceRegenerate)', async () => {
    const app = await makeReadyApp();
    recapStatusResponse = { full: freshSlot(), short: null };
    app.openRecapPicker();
    await flush();
    (app.port.send as any).mockClear();

    app.openLastRecap();

    const payload = lastSent(app);
    expect(payload).toMatchObject({ feature: 'fan-summary', viewCachedOnly: true, forceRegenerate: false });
  });

  it('«Открыть последний» toasts when the status is loaded and empty (no op)', async () => {
    const app = await makeReadyApp();
    recapStatusResponse = { full: null, short: null };
    app.openRecapPicker();
    await flush();
    (app.port.send as any).mockClear();

    app.openLastRecap();

    expect((app.port.send as any).mock.calls.some((c: any) => c[0]?.type === 'operation:start')).toBe(false);
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('CG-APP-03');
  });

  it('no_saved_recap surfaces as a toast, not an error overlay', async () => {
    const app = await makeReadyApp();
    recapStatusResponse = { full: null, short: null };
    app.openRecapPicker();
    await flush();
    app.openLastRecap(); // status unknown-less path is empty → but force the op path:
    // Directly drive the op path with an unknown status to exercise the error map.
    app.recapPickerModel = null;
    app.initializeFeatureOperation('fan-summary', 'view-op', 'alice', undefined);
    app.handleOperationError({
      type: 'operation:error',
      operationId: 'view-op',
      error: { key: 'no_saved_recap', code: 'CG-APP-03', message: 'No saved recap' },
    });

    expect(app.deepOverlayModel).toBeNull();
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('CG-APP-03');
  });

  // ─── Auto-recap chain (spec §5) ──────────────────────────────────────

  it('auto-recap (stale full) runs a recap step FIRST, then auto-submits the question', async () => {
    const app = await makeReadyApp();
    (mockStorageState.settings as Record<string, unknown>).coachAutoRecap = 'full';
    recapStatusResponse = { full: staleSlot(), short: null };
    app.openCoach();
    await flush();
    (app.port.send as any).mockClear();

    await app.submitCoachQuestion('how do I sell this?');

    // No coach turn yet — a recap step is running and the question is held.
    expect(app.coachRecapChain).not.toBeNull();
    expect(app.coachRecapChain.pendingQuestion).toBe('how do I sell this?');
    const step = app.activeCoachSession.feedItems.find((i: any) => i.kind === 'recap-step');
    expect(step).toMatchObject({ origin: 'auto', mode: 'full', status: 'running' });
    expect(lastSent(app)).toMatchObject({ feature: 'fan-summary', forceRegenerate: true });
    expect(app.activeCoachSession.autoRecapAttempted).toBe(true);

    // Recap completes → step done → the held question auto-submits as coach-chat.
    const recapOpId = app.coachRecapChain.operationId;
    (app.port.send as any).mockClear();
    app.handleComplete({
      type: 'operation:complete',
      operationId: recapOpId,
      fanDisplayName: 'alice',
      result: { rawText: 'fresh recap', parts: [] },
    });
    await flush();
    expect(step.status).toBe('done');
    expect(lastSent(app)).toMatchObject({ feature: 'coach-chat', chatterQuestion: 'how do I sell this?' });
  });

  it('auto-recap mode matching: short is satisfied by a fresh FULL recap (no chain)', async () => {
    const app = await makeReadyApp();
    (mockStorageState.settings as Record<string, unknown>).coachAutoRecap = 'short';
    recapStatusResponse = { full: freshSlot(), short: null };
    app.openCoach();
    await flush();
    (app.port.send as any).mockClear();

    await app.submitCoachQuestion('quick q');

    // A fresh full satisfies a short request → no recap chain, straight coach turn.
    expect(app.coachRecapChain).toBeNull();
    expect(lastSent(app)).toMatchObject({ feature: 'coach-chat', chatterQuestion: 'quick q' });
  });

  it('auto-recap full is NOT satisfied by a full at a different deepMessageCount', async () => {
    const app = await makeReadyApp();
    (mockStorageState.settings as Record<string, unknown>).coachAutoRecap = 'full';
    // Fresh full but generated at 1500, current deepMessageCount is 3000.
    recapStatusResponse = { full: freshSlot({ requestedCount: 1500 }), short: null };
    app.openCoach();
    await flush();
    (app.port.send as any).mockClear();

    await app.submitCoachQuestion('deep q');

    expect(app.coachRecapChain).not.toBeNull();
    expect(lastSent(app)).toMatchObject({ feature: 'fan-summary', forceRegenerate: true });
  });

  it('auto-recap runs at most once per session, even after a failure', async () => {
    const app = await makeReadyApp();
    (mockStorageState.settings as Record<string, unknown>).coachAutoRecap = 'full';
    recapStatusResponse = { full: staleSlot(), short: null };
    app.openCoach();
    await flush();

    await app.submitCoachQuestion('q1');
    const recapOpId = app.coachRecapChain.operationId;
    // Recap fails with a STOP-category error → chain stops, question preserved.
    app.handleOperationError({
      type: 'operation:error',
      operationId: recapOpId,
      error: { key: 'session_expired', code: 'CG-FAN-02', message: 'expired' },
    });
    await flush();
    expect(app.coachRecapChain).toBeNull();
    expect(app.activeCoachSession.autoRecapAttempted).toBe(true);

    // A SECOND question does NOT auto-recap again — it sends a coach turn directly.
    (app.port.send as any).mockClear();
    await app.submitCoachQuestion('q2');
    expect(app.coachRecapChain).toBeNull();
    expect(lastSent(app)).toMatchObject({ feature: 'coach-chat', chatterQuestion: 'q2' });
  });

  it('failure taxonomy — STOP: an auth failure preserves the question in the composer, no coach turn', async () => {
    const app = await makeReadyApp();
    (mockStorageState.settings as Record<string, unknown>).coachAutoRecap = 'full';
    recapStatusResponse = { full: staleSlot(), short: null };
    app.openCoach();
    await flush();

    await app.submitCoachQuestion('preserved q');
    const recapOpId = app.coachRecapChain.operationId;
    (app.port.send as any).mockClear();
    app.handleOperationError({
      type: 'operation:error',
      operationId: recapOpId,
      error: { key: 'hub_quota_exceeded', code: 'CG-HUB-09', message: 'quota' },
    });
    await flush();

    // Chain stopped: no coach-chat op, the question is back in the composer.
    expect((app.port.send as any).mock.calls.some((c: any) => c[0]?.feature === 'coach-chat')).toBe(false);
    expect(app.activeCoachSession.composerText).toBe('preserved q');
    const step = app.activeCoachSession.feedItems.find((i: any) => i.kind === 'recap-step');
    expect(step.status).toBe('failed');
    expect(step.note).toBeUndefined();
  });

  it('failure taxonomy — PROCEED: a recap-specific model failure answers anyway with a fallback note', async () => {
    const app = await makeReadyApp();
    (mockStorageState.settings as Record<string, unknown>).coachAutoRecap = 'full';
    // An older recap exists (short slot), so the note references its age.
    recapStatusResponse = { full: staleSlot(), short: staleSlot({ ageMs: 3 * 24 * 60 * 60 * 1000 }) };
    app.openCoach();
    await flush();

    await app.submitCoachQuestion('answer me anyway');
    const recapOpId = app.coachRecapChain.operationId;
    (app.port.send as any).mockClear();
    app.handleOperationError({
      type: 'operation:error',
      operationId: recapOpId,
      error: { key: 'ai_output_unusable', code: 'CG-API-06', message: 'truncated' },
    });
    await flush();

    // The step is failed WITH a fallback note, and the coach turn proceeded.
    const step = app.activeCoachSession.feedItems.find((i: any) => i.kind === 'recap-step');
    expect(step.status).toBe('failed');
    expect(step.note).toContain('обновить Recap не удалось');
    expect(lastSent(app)).toMatchObject({ feature: 'coach-chat', chatterQuestion: 'answer me anyway' });
  });

  it('cancelling the recap chain stops it and preserves the question', async () => {
    const app = await makeReadyApp();
    (mockStorageState.settings as Record<string, unknown>).coachAutoRecap = 'full';
    recapStatusResponse = { full: staleSlot(), short: null };
    app.openCoach();
    await flush();

    await app.submitCoachQuestion('cancel my recap');
    const recapOpId = app.coachRecapChain.operationId;
    (app.port.send as any).mockClear();

    app.cancelActiveOperation();

    expect(app.coachRecapChain).toBeNull();
    expect(app.suppressedTerminalOpIds.has(recapOpId)).toBe(true);
    expect(app.activeCoachSession.composerText).toBe('cancel my recap');
    const step = app.activeCoachSession.feedItems.find((i: any) => i.kind === 'recap-step');
    expect(step.status).toBe('failed');
  });

  it('off (default) auto-recap sends a coach turn directly, no recap step', async () => {
    const app = await makeReadyApp();
    // coachAutoRecap is 'off' by default in createStorageState.
    recapStatusResponse = { full: null, short: null };
    app.openCoach();
    await flush();
    (app.port.send as any).mockClear();

    await app.submitCoachQuestion('no auto recap');

    expect(app.coachRecapChain).toBeNull();
    expect(app.activeCoachSession.feedItems.some((i: any) => i.kind === 'recap-step')).toBe(false);
    expect(lastSent(app)).toMatchObject({ feature: 'coach-chat' });
  });

  it('the per-session override forces auto-recap even when the setting is off', async () => {
    const app = await makeReadyApp();
    // Setting off, but the session override cycles to 'full'.
    recapStatusResponse = { full: staleSlot(), short: null };
    app.openCoach();
    await flush();
    // inherit → off → short → full
    app.cycleCoachAutoRecapOverride();
    app.cycleCoachAutoRecapOverride();
    app.cycleCoachAutoRecapOverride();
    expect(app.activeCoachSession.autoRecapOverride).toBe('full');
    (app.port.send as any).mockClear();

    await app.submitCoachQuestion('override on');

    expect(app.coachRecapChain).not.toBeNull();
    expect(lastSent(app)).toMatchObject({ feature: 'fan-summary', forceRegenerate: true });
  });

  // ─── Review fixes ────────────────────────────────────────────────────

  it('P1: port disconnect recovers a locked coach session (pending → composer)', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await flush();
    await app.submitCoachQuestion('mid-stream question');
    expect(app.activeCoachSession.pending).toBeDefined();
    // The composer is locked while streaming.
    expect(app.coachOverlayModel.sessionView.composerEnabled).toBe(false);

    app.recoverCoachOnDisconnect();

    // Pending dropped, question restored, composer usable again (no terminal can
    // repair a dead port, so recovery must).
    expect(app.activeCoachSession.pending).toBeUndefined();
    expect(app.activeCoachSession.composerText).toBe('mid-stream question');
    expect(app.coachOverlayModel.sessionView.composerEnabled).toBe(true);
    expect(app.coachOverlayModel.operationId).toBeNull();
  });

  it('P1: port disconnect recovers a coach recap chain (question preserved, step failed)', async () => {
    const app = await makeReadyApp();
    (mockStorageState.settings as Record<string, unknown>).coachAutoRecap = 'full';
    recapStatusResponse = { full: staleSlot(), short: null };
    app.openCoach();
    await flush();
    await app.submitCoachQuestion('chained question');
    expect(app.coachRecapChain).not.toBeNull();

    app.recoverCoachOnDisconnect();

    expect(app.coachRecapChain).toBeNull();
    expect(app.activeCoachSession.composerText).toBe('chained question');
    const step = app.activeCoachSession.feedItems.find((i: any) => i.kind === 'recap-step');
    expect(step.status).toBe('failed');
  });

  it('P2: a settings-load failure after submit restores the question, arms nothing', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await flush();
    // The renderer clears the composer BEFORE calling submit; then settings fail.
    app.activeCoachSession.composerText = '';
    (globalThis.browser.storage.local.get as any).mockRejectedValueOnce(new Error('storage down'));

    await app.submitCoachQuestion('important question');

    expect(app.activeCoachSession.composerText).toBe('important question');
    expect(app.activeCoachSession.pending).toBeUndefined();
    expect(app.activeFeature).toBeNull();
    expect((app.port.send as any).mock.calls.some((c: any) => c[0]?.type === 'operation:start')).toBe(false);
    // A dedicated settings-load toast, not the generic extension_reloaded one.
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('CG-APP-04');
  });

  it('P2: a standalone SHORT recap does not mark a full summary available or cache it', async () => {
    const app = await makeReadyApp();
    app.openRecapPicker();
    app.pickStandaloneRecap('short');
    const opId = app.activeOperationId;

    app.handleComplete({
      type: 'operation:complete',
      operationId: opId,
      fanDisplayName: 'alice',
      result: {
        rawText: 'short recap body',
        parts: [],
        summaryMeta: { generatedAt: 1, stale: false, cached: false },
      },
    });

    // Shown once, but NOT marked available and NOT cached under fan-summary.
    expect(app.deepOverlayModel).not.toBeNull();
    expect(app.tabState.hasAvailableSummary).toBeFalsy();
    expect(
      app.completedOverlayCache.get('group-1', 'fan-summary', app.overlayCacheIdentity(null)),
    ).toBeNull();
  });

  it('P2 control: a standalone FULL recap DOES mark availability + cache', async () => {
    const app = await makeReadyApp();
    app.openRecapPicker();
    app.pickStandaloneRecap('full');
    const opId = app.activeOperationId;

    app.handleComplete({
      type: 'operation:complete',
      operationId: opId,
      fanDisplayName: 'alice',
      result: {
        rawText: 'full recap body',
        parts: [],
        summaryMeta: { generatedAt: 1, stale: false, cached: false },
      },
    });

    expect(app.tabState.hasAvailableSummary).toBe(true);
    expect(
      app.completedOverlayCache.get('group-1', 'fan-summary', app.overlayCacheIdentity(null)),
    ).not.toBeNull();
  });

  it('P2: coach draft acceptance carries the exchange generationRef', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await flush();
    await app.submitCoachQuestion('q');
    const opId = pendingOpId(app);
    app.handleComplete({
      type: 'operation:complete',
      operationId: opId,
      fanDisplayName: 'alice',
      result: { rawText: 'A tip.\n```draft\nHey!\n```', parts: [] },
      generationRef: 'gen-accept-1',
    });

    // The overlay model's exchange carries the generationRef for acceptance.
    const exchange = app.coachOverlayModel.sessionView.feedItems.find((i: any) => i.kind === 'exchange');
    expect(exchange.generationRef).toBe('gen-accept-1');
  });

  // ─── Chain-teardown holes (second review wave) ───────────────────────

  it('«Новый диалог» is refused mid-recap-chain (chain intact, session not reset)', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await flush();
    app.handleCoachRecap('full'); // explicit refresh → running recap step, no coach op
    expect(app.coachRecapChain).not.toBeNull();
    const chainBefore = app.coachRecapChain;

    app.resetCoachSession();

    // Refused: chain intact and the running step survives (resetSession would wipe it).
    expect(app.coachRecapChain).toBe(chainBefore);
    expect(app.activeCoachSession.feedItems.some((i: any) => i.kind === 'recap-step')).toBe(true);
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('Дождись');
  });

  it('onClose during an auto-recap chain tears it down cleanly and preserves the question', async () => {
    const app = await makeReadyApp();
    (mockStorageState.settings as Record<string, unknown>).coachAutoRecap = 'full';
    recapStatusResponse = { full: staleSlot(), short: null };
    app.openCoach();
    await flush();
    await app.submitCoachQuestion('held during insert');
    expect(app.coachRecapChain).not.toBeNull();
    const recapOpId = app.coachRecapChain.operationId;
    (app.port.send as any).mockClear();

    // Draft Insert during a running step fires onClose (activeFeature is
    // 'fan-summary', so the old idle-coach branch would have dropped the chain).
    app.overlay.callbacks.onClose();

    expect(app.coachRecapChain).toBeNull();
    expect(app.suppressedTerminalOpIds.has(recapOpId)).toBe(true);
    expect(app.port.send).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'operation:cancel', operationId: recapOpId }),
    );
    // Question preserved in the retained store session; overlay collapsed.
    expect(app.coachStore.getOrCreate('account-1', 'group-1').composerText).toBe('held during insert');
    expect(app.coachOverlayModel).toBeNull();
  });

  it('onClose during a SHORT recap chain suppresses the terminal — no cache pollution', async () => {
    const app = await makeReadyApp();
    app.openCoach();
    await flush();
    app.handleCoachRecap('short'); // explicit short refresh chain
    const recapOpId = app.coachRecapChain.operationId;

    app.overlay.callbacks.onClose();
    expect(app.suppressedTerminalOpIds.has(recapOpId)).toBe(true);

    // The escaped completion is suppressed — it never reaches the full-summary
    // availability/cache path (the P2-short-cache side door is closed).
    app.handleComplete({
      type: 'operation:complete',
      operationId: recapOpId,
      fanDisplayName: 'alice',
      result: { rawText: 'short body', parts: [], summaryMeta: { generatedAt: 1, stale: false, cached: false } },
    });
    expect(app.tabState.hasAvailableSummary).toBeFalsy();
    expect(
      app.completedOverlayCache.get('group-1', 'fan-summary', app.overlayCacheIdentity(null)),
    ).toBeNull();
  });

  it('«Открыть последний» falls back full → short → toast on a cache miss', async () => {
    const app = await makeReadyApp();
    // Unknown status → try the durable full first, then short.
    app.recapPickerModel = { kind: 'recap-picker', fanDisplayName: 'fan', recapStatus: null };

    app.openLastRecap();
    let payload = lastSent(app);
    expect(payload).toMatchObject({ feature: 'fan-summary', viewCachedOnly: true });
    expect(payload.summaryMode).toBeUndefined(); // full
    const fullOpId = app.activeOperationId;

    (app.port.send as any).mockClear();
    app.handleOperationError({
      type: 'operation:error',
      operationId: fullOpId,
      error: { key: 'no_saved_recap', code: 'CG-APP-03', message: 'none' },
    });
    payload = lastSent(app);
    expect(payload).toMatchObject({ feature: 'fan-summary', viewCachedOnly: true, summaryMode: 'short' });
    const shortOpId = app.activeOperationId;

    (app.port.send as any).mockClear();
    app.handleOperationError({
      type: 'operation:error',
      operationId: shortOpId,
      error: { key: 'no_saved_recap', code: 'CG-APP-03', message: 'none' },
    });
    // No third op — both sizes missed, so toast.
    expect((app.port.send as any).mock.calls.some((c: any) => c[0]?.type === 'operation:start')).toBe(false);
    expect(document.querySelector('.chatgoose-toast')?.textContent).toContain('CG-APP-03');
  });

  it('startCompare clears an open recap picker (mirror startFeature)', async () => {
    const app = await makeReadyApp();
    app.openRecapPicker();
    expect(app.recapPickerModel).not.toBeNull();

    await app.startCompare(false);

    expect(app.recapPickerModel).toBeNull();
  });

  it('renders a Coach button in the bar wired to openCoach', async () => {
    const app = await makeReadyApp();
    const openSpy = vi.spyOn(app, 'openCoach').mockImplementation(() => {});
    app.renderButtonBar();

    const coachButton = Array.from(
      (app.buttonBar.root as HTMLElement).querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === 'Coach');
    expect(coachButton).toBeDefined();

    coachButton!.click();
    expect(openSpy).toHaveBeenCalled();
  });
});
