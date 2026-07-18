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

  it('onCoachRecap runs a fan-summary op with the chosen summaryMode (T11 upgrades this)', async () => {
    const app = await makeReadyApp();
    app.openCoach();

    app.handleCoachRecap('short');

    expect(app.coachOverlayModel).toBeNull();
    const payload = (app.port.send as any).mock.calls.at(-1)[0];
    expect(payload).toMatchObject({
      type: 'operation:start',
      feature: 'fan-summary',
      summaryMode: 'short',
    });
  });

  it('dispatchHotkey handles the coach and recap-picker arms (returns true)', async () => {
    const app = await makeReadyApp();

    expect(app.dispatchHotkey('coach')).toBe(true);
    expect(app.dispatchHotkey('fan-summary')).toBe(true);
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
