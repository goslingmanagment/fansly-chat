import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../src/content/textarea.js', () => ({
  insertIntoFanslyTextarea: vi.fn(async () => undefined),
  copyToClipboard: vi.fn(async () => undefined),
  focusActiveConversationTextarea: vi.fn(() => null),
}));

import { OverlayController } from '../src/content/overlay/overlay-controller.js';
import { installContentStyles } from '../src/content/dom-anchor.js';
import { copyToClipboard } from '../src/content/textarea.js';
import type {
  LlmSpendSummary,
  OperationProfilingSnapshot,
  OverlayInsertPart,
  OverlayViewModel,
  PromptDebugSnapshot,
  UserFacingError,
} from '../src/shared/types.js';

function createLoadingModel(
  operationId: string,
  rawText: string,
  options?: {
    progressMessage?: string;
    statusCode?: string;
    retryAtMs?: number;
    profiling?: OperationProfilingSnapshot;
    llmSpend?: LlmSpendSummary;
  },
): Extract<OverlayViewModel, { kind: 'loading' }> {
  return {
    kind: 'loading',
    feature: 'fast-reply',
    fanDisplayName: 'fan',
    progress: options?.progressMessage || options?.statusCode
      ? {
          operationId,
          feature: 'fast-reply',
          phase: 'generating',
          message: options.progressMessage,
          ...(options?.statusCode ? { statusCode: options.statusCode } : {}),
          ...(typeof options?.retryAtMs === 'number' ? { retryAtMs: options.retryAtMs } : {}),
        }
      : null,
    rawText,
    debugPrompt: undefined,
    llmSpend: options?.llmSpend,
    profiling: options?.profiling,
    canCancel: true,
    canRegenerate: true,
    operationId,
  };
}

function createReplyModel(
  part: OverlayInsertPart,
  options?: {
    llmSpend?: LlmSpendSummary;
    profiling?: OperationProfilingSnapshot;
  },
): Extract<OverlayViewModel, { kind: 'reply' }> {
  return {
    kind: 'reply',
    feature: 'fast-reply',
    fanDisplayName: 'fan',
    operationId: 'reply-op',
    parts: [part],
    rawText: part.text,
    splitModeRequested: false,
    debugPrompt: undefined,
    llmSpend: options?.llmSpend,
    profiling: options?.profiling,
    rerunActionLabel: 'Regenerate',
  };
}

function createDebugSnapshot(): PromptDebugSnapshot {
  return {
    feature: 'fast-reply',
    modelId: 'claude-sonnet-4-20250514',
    system: 'You are a helpful assistant.',
    transcript: 'Fan: hello\nModel: hi there',
    fanSpendingData: '$50 total',
    fanSubscriptionData: 'Active sub',
    user: 'Reply to the fan.',
  };
}

function createHelpMeModel(
  options?: { debugPrompt?: PromptDebugSnapshot },
): Extract<OverlayViewModel, { kind: 'helpMe' }> {
  return {
    kind: 'helpMe',
    feature: 'help-me',
    fanDisplayName: 'fan',
    operationId: 'help-op',
    rawText: 'raw help',
    coaching: 'Be direct',
    engagingParts: [],
    flirtyParts: [],
    parseFallback: false,
    debugPrompt: options?.debugPrompt,
    profiling: undefined,
    rerunActionLabel: 'Regenerate',
  };
}

function createReadOnlyModel(
  options?: { debugPrompt?: PromptDebugSnapshot },
): Extract<OverlayViewModel, { kind: 'readOnly' }> {
  return {
    kind: 'readOnly',
    feature: 'chat-review',
    fanDisplayName: 'fan',
    operationId: 'review-op',
    rawText: 'review text',
    reviewMeta: {
      rating: 7,
      evaluation: 'Solid',
      recommendations: 'Keep pace',
      parseFallback: false,
    },
    debugPrompt: options?.debugPrompt,
    profiling: undefined,
    rerunActionLabel: 'Refresh',
  };
}

function createSummaryReadOnlyModel(
  options?: {
    debugPrompt?: PromptDebugSnapshot;
    syncState?: 'not-set-up' | 'saving' | 'saved' | 'failed';
    syncError?: UserFacingError;
  },
): Extract<OverlayViewModel, { kind: 'readOnly' }> {
  const generatedAt = Date.now();
  return {
    kind: 'readOnly',
    feature: 'fan-summary',
    fanDisplayName: 'fan',
    operationId: 'summary-op',
    rawText: 'Fan summary text',
    summaryMeta: {
      generatedAt,
      stale: false,
      cached: false,
      syncStatus: {
        state: options?.syncState ?? 'saved',
        generatedAt,
        ...(options?.syncError ? { error: options.syncError } : {}),
        updatedAt: Date.now(),
      },
    },
    debugPrompt: options?.debugPrompt,
    profiling: undefined,
    rerunActionLabel: 'Refresh',
  };
}

function createProfilingSnapshot(): OperationProfilingSnapshot {
  return {
    elapsedMs: 1850,
    activeLabel: 'Load messages',
    llmUsage: {
      input_tokens: 420,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 90,
      output_tokens: 11,
    },
    llmCost: {
      modelId: 'claude-sonnet-4-6',
      inputUsd: 0.00126,
      cacheWrite5mUsd: 0.00045,
      cacheWrite1hUsd: 0.00108,
      cacheReadUsd: 0.000027,
      outputUsd: 0.000165,
      totalUsd: 0.002982,
      approximate: false,
    },
    logEntries: [
      { elapsedMs: 0, message: 'Resolve account identity' },
      { elapsedMs: 900, message: 'Reasoning requested: medium (Claude Sonnet 4.6)' },
      { elapsedMs: 1100, message: 'Reasoning observed: yes (thinking_block)' },
      { elapsedMs: 125, message: 'Loaded messages page 1/2 (25 msgs, 25 collected)' },
      { elapsedMs: 850, message: 'Loaded messages page 2/2 (5 msgs, 30 collected)' },
    ],
    reasoningBlock: 'I should answer warmly.',
    stages: [
      {
        key: 'resolve-identity',
        label: 'Resolve account identity',
        status: 'completed',
        startedElapsedMs: 0,
        endedElapsedMs: 50,
        durationMs: 50,
        detail: 'resolved account-1',
      },
      {
        key: 'load-messages',
        label: 'Load messages',
        status: 'completed',
        startedElapsedMs: 50,
        endedElapsedMs: 850,
        durationMs: 800,
        detail: '2 pages, 30 transcript messages',
      },
    ],
  };
}

function createSpendSummary(
  overrides?: Partial<LlmSpendSummary>,
): LlmSpendSummary {
  return {
    totalTokens: 821,
    inputTokens: 420,
    cacheWriteTokens: 300,
    cacheReadTokens: 90,
    outputTokens: 11,
    totalUsd: 0.002982,
    uncachedUsd: 0.002595,
    cacheEffectUsd: 0.000387,
    cacheEffectKind: 'overhead',
    cacheWriteUsd: 0.00153,
    cacheReadUsd: 0.000027,
    approximate: false,
    ...overrides,
  };
}

const contentStyles = readFileSync(
  new URL('../src/content/styles.css', import.meta.url),
  'utf8',
);

function createPart(text: string, index = 0): OverlayInsertPart {
  return {
    id: `part-${index}`,
    sequenceIndex: index,
    text,
    insertedAt: null,
    insertedOnce: false,
  };
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element for selector: ${selector}`);
  }
  return element as T;
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://fansly.com/messages/example',
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
  vi.stubGlobal('KeyboardEvent', window.KeyboardEvent);
  return dom;
}

describe('OverlayController', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, '__CHATGOOSE_OVERLAY_DEBUG__');
  });

  it('reuses the mounted overlay shell for same-operation loading updates', async () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createLoadingModel('stream-op', ''));

    const root = requireElement<HTMLDivElement>('#chatgoose-overlay-root');
    const shell = requireElement<HTMLDivElement>('.chatgoose-overlay-shell');
    const backdrop = requireElement<HTMLDivElement>('.chatgoose-overlay-backdrop');
    const panel = requireElement<HTMLDivElement>('.chatgoose-overlay-panel');
    const stream = requireElement<HTMLDivElement>('.chatgoose-stream');
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => {
      records.push(...mutations);
    });

    observer.observe(root, { childList: true, subtree: true });
    controller.render(createLoadingModel('stream-op', 'hello world'));
    await Promise.resolve();
    observer.disconnect();

    expect(requireElement<HTMLDivElement>('.chatgoose-overlay-shell')).toBe(shell);
    expect(requireElement<HTMLDivElement>('.chatgoose-overlay-backdrop')).toBe(backdrop);
    expect(requireElement<HTMLDivElement>('.chatgoose-overlay-panel')).toBe(panel);
    expect(requireElement<HTMLDivElement>('.chatgoose-stream')).toBe(stream);
    expect(stream.textContent).toBe('hello world');
    expect(records).toHaveLength(0);
  });

  it('wraps rendered content in a dedicated overlay body container', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createLoadingModel('body-op', 'hello world'));

    const body = requireElement<HTMLDivElement>('.chatgoose-overlay-body');
    expect(body.firstElementChild).toBe(requireElement<HTMLDivElement>('.chatgoose-grid'));
  });

  it('keeps overlay scroll ownership on the panel instead of the nested body', () => {
    installContentStyles(contentStyles);

    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createLoadingModel('scroll-owner-op', 'hello world'));

    const panel = requireElement<HTMLDivElement>('.chatgoose-overlay-panel');
    const body = requireElement<HTMLDivElement>('.chatgoose-overlay-body');
    const panelStyle = window.getComputedStyle(panel);
    const bodyStyle = window.getComputedStyle(body);

    expect(panelStyle.overflowY).toBe('auto');
    expect(bodyStyle.overflowY).not.toBe('auto');
    expect(bodyStyle.overflowY).not.toBe('scroll');
  });

  it('renders a profiling log and live status in loading view when profiling is present', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(
      createLoadingModel('profile-op', '', {
        progressMessage: 'Generating…',
        profiling: createProfilingSnapshot(),
      }),
    );

    expect(requireElement<HTMLDivElement>('.chatgoose-overlay-status').textContent).toContain('Load messages');
    expect(document.querySelector('.chatgoose-profiling')).not.toBeNull();
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-log').textContent).toContain(
      'Loaded messages page 1/2 (25 msgs, 25 collected)',
    );
  });

  it('preserves loading profiling log scrollTop across appended progress entries', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });
    const initialProfiling = createProfilingSnapshot();

    controller.render(
      createLoadingModel('profile-scroll-op', '', {
        profiling: initialProfiling,
      }),
    );

    const log = requireElement<HTMLDivElement>('.chatgoose-profiling-log');
    log.scrollTop = 72;

    controller.render(
      createLoadingModel('profile-scroll-op', '', {
        profiling: {
          ...initialProfiling,
          elapsedMs: 9300,
          logEntries: [
            ...initialProfiling.logEntries,
            {
              elapsedMs: 1200,
              message: 'Loaded messages page 3/40 (25 msgs, 75 collected)',
            },
          ],
        },
      }),
    );

    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-log')).toBe(log);
    expect(log.scrollTop).toBe(72);
    expect(log.textContent).toContain('Loaded messages page 3/40 (25 msgs, 75 collected)');
  });

  it('keeps the loading profiling log pinned to the bottom when new entries append', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });
    const initialProfiling = createProfilingSnapshot();

    controller.render(
      createLoadingModel('profile-bottom-op', '', {
        profiling: initialProfiling,
      }),
    );

    const log = requireElement<HTMLDivElement>('.chatgoose-profiling-log');
    let scrollHeight = 180;
    Object.defineProperty(log, 'clientHeight', {
      configurable: true,
      get: () => 100,
    });
    Object.defineProperty(log, 'scrollHeight', {
      configurable: true,
      get: () => scrollHeight,
    });
    log.scrollTop = 80;

    scrollHeight = 220;
    controller.render(
      createLoadingModel('profile-bottom-op', '', {
        profiling: {
          ...initialProfiling,
          elapsedMs: 9300,
          logEntries: [
            ...initialProfiling.logEntries,
            {
              elapsedMs: 1200,
              message: 'Loaded messages page 3/40 (25 msgs, 75 collected)',
            },
          ],
        },
      }),
    );

    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-log')).toBe(log);
    expect(log.scrollTop).toBe(120);
  });

  it('updates the loading profiling header text in place when elapsed time changes', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });
    const initialProfiling = createProfilingSnapshot();

    controller.render(
      createLoadingModel('profile-header-op', '', {
        profiling: initialProfiling,
      }),
    );

    const header = requireElement<HTMLDivElement>('.chatgoose-profiling .chatgoose-debug-summary');
    expect(header.textContent).toBe('Pipeline Profiling • 1.9s');

    controller.render(
      createLoadingModel('profile-header-op', '', {
        profiling: {
          ...initialProfiling,
          elapsedMs: 9300,
        },
      }),
    );

    expect(requireElement<HTMLDivElement>('.chatgoose-profiling .chatgoose-debug-summary')).toBe(header);
    expect(header.textContent).toBe('Pipeline Profiling • 9.3s');
  });

  it('renders a spend placeholder in loading view before usage arrives', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createLoadingModel('pending-op', ''));

    expect(requireElement<HTMLDivElement>('.chatgoose-spend-strip').textContent).toContain(
      'pending',
    );
  });

  it('keeps the non-debug loading fallback text when profiling is absent', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createLoadingModel('plain-op', ''));

    const grid = requireElement<HTMLDivElement>('.chatgoose-grid');
    expect(requireElement<HTMLDivElement>('.chatgoose-overlay-status').textContent).toBe('Generating…');
    expect(requireElement<HTMLDivElement>('.chatgoose-stream').textContent).toBe('Waiting for AI…');
    expect(document.querySelector('.chatgoose-profiling')).toBeNull();
    expect(Array.from(grid.children).map((element) => element.className)).toEqual([
      'chatgoose-loading-spend-host',
      'chatgoose-overlay-status',
      'chatgoose-stream',
      'chatgoose-overlay-actions',
    ]);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('renders rate-limit status codes with a live retry countdown in loading view', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-21T12:00:00.000Z'));

    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(
      createLoadingModel('rate-limit-op', '', {
        progressMessage: 'Rate limited. Waiting to retry…',
        statusCode: 'CG-API-01',
        retryAtMs: Date.now() + 30_000,
      }),
    );

    const status = requireElement<HTMLDivElement>('.chatgoose-overlay-status');
    expect(status.textContent).toContain('CG-API-01');
    expect(status.textContent).toContain('Rate limited. Waiting to retry…');
    expect(status.textContent).toContain('(30s)');

    await vi.advanceTimersByTimeAsync(1_100);
    expect(status.textContent).toContain('(29s)');
  });

  it('emits render diagnostics for repeated loading renders when debug tracing is enabled', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    Reflect.set(globalThis, '__CHATGOOSE_OVERLAY_DEBUG__', true);
    controller.render(createLoadingModel('trace-op', ''));
    controller.render(createLoadingModel('trace-op', 'next chunk'));

    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy.mock.calls[1]?.[0]).toBe('[ChatGoose overlay render]');
    expect(debugSpy.mock.calls[1]?.[1]).toMatchObject({
      count: 2,
      kind: 'loading',
      operationId: 'trace-op',
      sameKindAsPrevious: true,
      sameOperationIdAsPrevious: true,
      bodyAction: 'update-loading',
    });
    expect(typeof debugSpy.mock.calls[1]?.[1]?.durationMs).toBe('number');
    expect(typeof debugSpy.mock.calls[1]?.[1]?.timestamp).toBe('string');
  });

  it('keeps the shell mounted while rebuilding low-frequency reply content', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });
    const part: OverlayInsertPart = {
      id: 'part-1',
      sequenceIndex: 0,
      text: 'Hello there',
      insertedAt: null,
      insertedOnce: false,
    };

    controller.render(createReplyModel(part));
    const panel = requireElement<HTMLDivElement>('.chatgoose-overlay-panel');
    expect(requireElement<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button').textContent).toBe('Insert');

    part.insertedOnce = true;
    controller.render(createReplyModel(part));

    expect(requireElement<HTMLDivElement>('.chatgoose-overlay-panel')).toBe(panel);
    expect(requireElement<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button').textContent).toBe('Insert again');
    expect(requireElement<HTMLDivElement>('.chatgoose-card-status').textContent).toBe('Inserted earlier.');
  });

  it('renders a profiling summary in completed views when profiling is present', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });
    const part: OverlayInsertPart = {
      id: 'part-1',
      sequenceIndex: 0,
      text: 'Hello there',
      insertedAt: null,
      insertedOnce: false,
    };

    controller.render({
      ...createReplyModel(part),
      profiling: createProfilingSnapshot(),
    });

    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('Total');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('Claude Sonnet 4.6 usage');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('cache read 90');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('input 420');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('Reasoning requested');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('medium');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('Reasoning observed');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('thinking_block');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('Reasoning block');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('I should answer warmly.');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('Load messages');
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain('2 pages, 30 transcript messages');
  });

  it('renders Help Me regenerate action through the generic rerun callback', () => {
    const onRerun = vi.fn();
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun,
      onCollapse: () => undefined,
    });

    controller.render(createHelpMeModel());

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.chatgoose-overlay-actions .chatgoose-button'))
      .find((element) => element.textContent === 'Regenerate');

    expect(button).toBeDefined();
    button!.click();
    expect(onRerun).toHaveBeenCalledWith('help-me');
  });

  it('renders Chat Review refresh action through the generic rerun callback', () => {
    const onRerun = vi.fn();
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun,
      onCollapse: () => undefined,
    });

    controller.render(createReadOnlyModel());

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.chatgoose-overlay-actions .chatgoose-button'))
      .find((element) => element.textContent === 'Refresh');

    expect(button).toBeDefined();
    button!.click();
    expect(onRerun).toHaveBeenCalledWith('chat-review');
  });

  it('renders Chat Review copy action and copies the formatted review text', async () => {
    const mockCopy = vi.mocked(copyToClipboard);
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createReadOnlyModel());

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.chatgoose-overlay-actions .chatgoose-button'))
      .find((element) => element.textContent === 'Copy');

    expect(button).toBeDefined();
    button!.click();

    await vi.waitFor(() => {
      expect(mockCopy).toHaveBeenCalledWith('Rating: 7/10\n\nEvaluation:\nSolid\n\nRecommendations:\nKeep pace');
    });
  });

  it('renders Fan Summary copy action next to Refresh and copies the summary text', async () => {
    const mockCopy = vi.mocked(copyToClipboard);
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createSummaryReadOnlyModel());

    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-overlay-actions .chatgoose-button'),
    );
    const syncStatus = document.querySelector('.chatgoose-overlay-action-status');

    expect(buttons.map((button) => button.textContent)).toEqual(['Refresh', 'Copy']);
    expect(syncStatus?.textContent).toBe('Server sync · saved');
    buttons[1]!.click();

    await vi.waitFor(() => {
      expect(mockCopy).toHaveBeenCalledWith('Fan summary text');
    });
  });

  it('renders the exact Fan Summary server sync status labels', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createSummaryReadOnlyModel({ syncState: 'saving' }));
    expect(document.querySelector('.chatgoose-overlay-action-status')?.textContent).toBe(
      'Server sync · saving...',
    );

    controller.render(createSummaryReadOnlyModel({ syncState: 'not-set-up' }));
    expect(document.querySelector('.chatgoose-overlay-action-status')?.textContent).toBe(
      'Server sync · not set up',
    );

    controller.render(createSummaryReadOnlyModel({ syncState: 'failed' }));
    expect(document.querySelector('.chatgoose-overlay-action-status')?.textContent).toBe(
      'Server sync · failed',
    );
  });

  it('renders the Fan Summary failed sync code when available', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createSummaryReadOnlyModel({
      syncState: 'failed',
      syncError: {
        key: 'hub_request_failed',
        code: 'CG-HUB-07',
        message: 'Agency Hub request failed.',
      },
    }));

    expect(document.querySelector('.chatgoose-overlay-action-status')?.textContent).toBe(
      'Server sync · failed (CG-HUB-07)',
    );
  });

  it('renders profiling summary below the error block when profiling is present', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render({
      kind: 'error',
      feature: 'fast-reply',
      fanDisplayName: 'fan',
      operationId: 'error-op',
      profiling: createProfilingSnapshot(),
      error: {
        key: 'unknown_error',
        code: 'CG-APP-01',
        message: 'Something broke',
      },
    });

    const grid = requireElement<HTMLDivElement>('.chatgoose-grid');
    expect(grid.firstElementChild?.textContent).toContain('CG-APP-01');
    expect(grid.firstElementChild?.textContent).toContain('Something broke');
    expect(grid.children[1]?.textContent).toContain('Pipeline Profiling');
  });

  it('renders spend summary and model cost row in completed reply views', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(
      createReplyModel(createPart('Reply text'), {
        llmSpend: createSpendSummary({
          cacheEffectKind: 'saved',
          cacheEffectUsd: 0.00045,
        }),
        profiling: createProfilingSnapshot(),
      }),
    );

    expect(requireElement<HTMLDivElement>('.chatgoose-spend-strip').textContent).toContain(
      '$0.002982',
    );
    expect(requireElement<HTMLDivElement>('.chatgoose-spend-strip').textContent).toContain(
      'saved',
    );
    expect(requireElement<HTMLDivElement>('.chatgoose-profiling-summary').textContent).toContain(
      'Claude Sonnet 4.6 cost',
    );
  });

  // ─── Dismiss Mode Tests ───────────────────────────────────────────────

  it('collapse-to-inline dismiss mode: Escape calls onCollapse', () => {
    const onCollapse = vi.fn();
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const controller = new OverlayController({
      onClose,
      onCancel,
      onRerun: () => undefined,
      onCollapse,
    });

    controller.render(createLoadingModel('collapse-op', 'text'), {
      dismissMode: 'collapse-to-inline',
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onCollapse).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('collapse-to-inline dismiss mode: backdrop click calls onCollapse', () => {
    const onCollapse = vi.fn();
    const onClose = vi.fn();
    const controller = new OverlayController({
      onClose,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse,
    });

    controller.render(createLoadingModel('collapse-op', 'text'), {
      dismissMode: 'collapse-to-inline',
    });
    const backdrop = document.querySelector('.chatgoose-overlay-backdrop') as HTMLElement;
    backdrop.click();

    expect(onCollapse).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('collapse-to-inline dismiss mode: X button calls onCollapse', () => {
    const onCollapse = vi.fn();
    const onClose = vi.fn();
    const controller = new OverlayController({
      onClose,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse,
    });

    controller.render(createLoadingModel('collapse-op', 'text'), {
      dismissMode: 'collapse-to-inline',
    });
    const closeBtn = document.querySelector('.chatgoose-close') as HTMLButtonElement;
    closeBtn.click();

    expect(onCollapse).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('default loading dismiss calls onCancel + onClose', () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const onCollapse = vi.fn();
    const controller = new OverlayController({
      onClose,
      onCancel,
      onRerun: () => undefined,
      onCollapse,
    });

    controller.render(createLoadingModel('default-op', 'text'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onCancel).toHaveBeenCalledWith('default-op');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it('default completed reply dismiss calls onClose only', () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const controller = new OverlayController({
      onClose,
      onCancel,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });
    const part: OverlayInsertPart = {
      id: 'part-1',
      sequenceIndex: 0,
      text: 'Hello',
      insertedAt: null,
      insertedOnce: false,
    };

    controller.render(createReplyModel(part));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('explicit Cancel button always calls onCancel regardless of dismissMode', () => {
    const onCancel = vi.fn();
    const onCollapse = vi.fn();
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel,
      onRerun: () => undefined,
      onCollapse,
    });

    controller.render(createLoadingModel('cancel-op', 'text'), {
      dismissMode: 'collapse-to-inline',
    });
    const cancelButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-overlay-actions .chatgoose-button'),
    ).find((element) => element.textContent === 'Cancel');

    expect(cancelButton).toBeDefined();
    cancelButton!.click();

    expect(onCancel).toHaveBeenCalledWith('cancel-op');
    // onCollapse should NOT be called by the explicit Cancel button
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it('close dismiss mode + Escape calls onClose only (no cancel)', () => {
    const onClose = vi.fn();
    const onCancel = vi.fn();
    const controller = new OverlayController({
      onClose,
      onCancel,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createLoadingModel('close-op', 'text'), {
      dismissMode: 'close',
    });
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
  });

  // ─── Debug Prompt Tests ──────────────────────────────────────────────

  it('renders debug prompt inspector in Help Me view when debugPrompt is present', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createHelpMeModel({ debugPrompt: createDebugSnapshot() }));

    const inspector = document.querySelector('.chatgoose-debug-inspector');
    expect(inspector).not.toBeNull();
    expect(inspector?.querySelector('.chatgoose-debug-summary')?.textContent).toBe('LLM Input');
  });

  it('renders debug prompt inspector in Read Only view when debugPrompt is present', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createReadOnlyModel({ debugPrompt: createDebugSnapshot() }));

    const inspector = document.querySelector('.chatgoose-debug-inspector');
    expect(inspector).not.toBeNull();
    expect(inspector?.querySelector('.chatgoose-debug-summary')?.textContent).toBe('LLM Input');
  });

  it('shows inline error when copy to clipboard fails (Bug 6)', async () => {
    const mockCopy = vi.mocked(copyToClipboard);
    mockCopy.mockRejectedValueOnce(new DOMException('Not allowed', 'NotAllowedError'));

    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    const part: OverlayInsertPart = {
      id: 'part-1',
      sequenceIndex: 0,
      text: 'Hello there',
      insertedAt: null,
      insertedOnce: false,
    };

    controller.render(createReplyModel(part));

    const copyButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button'),
    ).find((button) => button.textContent === 'Copy');
    expect(copyButton).toBeDefined();

    copyButton!.click();
    await vi.waitFor(() => {
      const errorEl = document.querySelector('.chatgoose-inline-error');
      expect(errorEl).not.toBeNull();
    });
  });

  it('shows inline error when Chat Review copy to clipboard fails', async () => {
    const mockCopy = vi.mocked(copyToClipboard);
    mockCopy.mockRejectedValueOnce(new DOMException('Not allowed', 'NotAllowedError'));

    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createReadOnlyModel());

    const copyButton = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-overlay-actions .chatgoose-button'),
    ).find((button) => button.textContent === 'Copy');
    expect(copyButton).toBeDefined();

    copyButton!.click();
    await vi.waitFor(() => {
      const errorEl = document.querySelector('.chatgoose-inline-error');
      expect(errorEl).not.toBeNull();
    });
  });

  // ─── Enter-to-insert ─────────────────────────────────────────

  it('Enter inserts the first part for a visible fast-reply', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createReplyModel(createPart('Hey there!')));
    (document.activeElement as HTMLElement)?.blur?.();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => {
      expect(insertIntoFanslyTextarea).toHaveBeenCalledWith('Hey there!');
    });
  });

  it('Enter is ignored for hidden overlay', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const _controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    // Never rendered
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('Enter is ignored during loading state', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createLoadingModel('op', 'text'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('Enter is ignored for helpMe view', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createHelpMeModel());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('Enter is ignored when focus is in an editable element', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createReplyModel(createPart('Hello')));

    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('Enter with modifier keys is ignored', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createReplyModel(createPart('Hello')));
    (document.activeElement as HTMLElement)?.blur?.();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('newly rendered fast reply focuses the first Insert button', async () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createReplyModel(createPart('Hello')));
    await vi.waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button');
      expect(document.activeElement).toBe(btn);
    });
  });

  it('Enter on the focused Insert button only inserts once', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
      onCollapse: () => undefined,
    });

    controller.render(createReplyModel(createPart('Hello')));
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        document.querySelector('.chatgoose-card-actions .chatgoose-button'),
      );
    });

    const insertButton = requireElement<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button');
    insertButton.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }));
    // Real browsers follow Enter on a focused button with a click activation.
    insertButton.click();

    await vi.waitFor(() => {
      expect(insertIntoFanslyTextarea).toHaveBeenCalledTimes(1);
    });
  });
});
