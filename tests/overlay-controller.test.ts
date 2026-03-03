import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { OverlayController } from '../src/content/overlay/overlay-controller.js';
import type {
  OperationProfilingSnapshot,
  OverlayInsertPart,
  OverlayViewModel,
} from '../src/shared/types.js';

function createLoadingModel(
  operationId: string,
  rawText: string,
  options?: {
    progressMessage?: string;
    profiling?: OperationProfilingSnapshot;
  },
): Extract<OverlayViewModel, { kind: 'loading' }> {
  return {
    kind: 'loading',
    feature: 'fast-reply',
    fanDisplayName: 'fan',
    progress: options?.progressMessage
      ? {
          operationId,
          feature: 'fast-reply',
          phase: 'generating',
          message: options.progressMessage,
        }
      : null,
    rawText,
    debugPrompt: undefined,
    profiling: options?.profiling,
    canCancel: true,
    canRegenerate: true,
    operationId,
  };
}

function createReplyModel(
  part: OverlayInsertPart,
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
    profiling: undefined,
    rerunActionLabel: 'Regenerate',
  };
}

function createHelpMeModel(): Extract<OverlayViewModel, { kind: 'helpMe' }> {
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
    profiling: undefined,
    rerunActionLabel: 'Regenerate',
  };
}

function createReadOnlyModel(): Extract<OverlayViewModel, { kind: 'readOnly' }> {
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
    profiling: undefined,
    rerunActionLabel: 'Refresh',
  };
}

function createProfilingSnapshot(): OperationProfilingSnapshot {
  return {
    elapsedMs: 1850,
    activeLabel: 'Load messages',
    logEntries: [
      { elapsedMs: 0, message: 'Resolve account identity' },
      { elapsedMs: 125, message: 'Loaded messages page 1/2 (25 msgs, 25 collected)' },
      { elapsedMs: 850, message: 'Loaded messages page 2/2 (5 msgs, 30 collected)' },
    ],
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
  return dom;
}

describe('OverlayController', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, '__CHATMUSE_OVERLAY_DEBUG__');
  });

  it('reuses the mounted overlay shell for same-operation loading updates', async () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
    });

    controller.render(createLoadingModel('stream-op', ''));

    const root = requireElement<HTMLDivElement>('#chatmuse-overlay-root');
    const shell = requireElement<HTMLDivElement>('.chatmuse-overlay-shell');
    const backdrop = requireElement<HTMLDivElement>('.chatmuse-overlay-backdrop');
    const panel = requireElement<HTMLDivElement>('.chatmuse-overlay-panel');
    const stream = requireElement<HTMLDivElement>('.chatmuse-stream');
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => {
      records.push(...mutations);
    });

    observer.observe(root, { childList: true, subtree: true });
    controller.render(createLoadingModel('stream-op', 'hello world'));
    await Promise.resolve();
    observer.disconnect();

    expect(requireElement<HTMLDivElement>('.chatmuse-overlay-shell')).toBe(shell);
    expect(requireElement<HTMLDivElement>('.chatmuse-overlay-backdrop')).toBe(backdrop);
    expect(requireElement<HTMLDivElement>('.chatmuse-overlay-panel')).toBe(panel);
    expect(requireElement<HTMLDivElement>('.chatmuse-stream')).toBe(stream);
    expect(stream.textContent).toBe('hello world');
    expect(records).toHaveLength(0);
  });

  it('renders a profiling log and live status in loading view when profiling is present', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
    });

    controller.render(
      createLoadingModel('profile-op', '', {
        progressMessage: 'Generating…',
        profiling: createProfilingSnapshot(),
      }),
    );

    expect(requireElement<HTMLDivElement>('.chatmuse-overlay-status').textContent).toContain('Load messages');
    expect(document.querySelector('.chatmuse-profiling')).not.toBeNull();
    expect(requireElement<HTMLDivElement>('.chatmuse-profiling-log').textContent).toContain(
      'Loaded messages page 1/2 (25 msgs, 25 collected)',
    );
  });

  it('keeps the non-debug loading fallback text when profiling is absent', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
    });

    controller.render(createLoadingModel('plain-op', ''));

    const grid = requireElement<HTMLDivElement>('.chatmuse-grid');
    expect(requireElement<HTMLDivElement>('.chatmuse-overlay-status').textContent).toBe('Generating…');
    expect(requireElement<HTMLDivElement>('.chatmuse-stream').textContent).toBe('Waiting for Claude…');
    expect(document.querySelector('.chatmuse-profiling')).toBeNull();
    expect(Array.from(grid.children).map((element) => element.className)).toEqual([
      'chatmuse-overlay-status',
      'chatmuse-stream',
      'chatmuse-overlay-actions',
    ]);
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('emits render diagnostics for repeated loading renders when debug tracing is enabled', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
    });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);

    Reflect.set(globalThis, '__CHATMUSE_OVERLAY_DEBUG__', true);
    controller.render(createLoadingModel('trace-op', ''));
    controller.render(createLoadingModel('trace-op', 'next chunk'));

    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy.mock.calls[1]?.[0]).toBe('[ChatMuse overlay render]');
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
    });
    const part: OverlayInsertPart = {
      id: 'part-1',
      sequenceIndex: 0,
      text: 'Hello there',
      insertedAt: null,
      insertedOnce: false,
    };

    controller.render(createReplyModel(part));
    const panel = requireElement<HTMLDivElement>('.chatmuse-overlay-panel');
    expect(requireElement<HTMLButtonElement>('.chatmuse-card-actions .chatmuse-button').textContent).toBe('Insert');

    part.insertedOnce = true;
    controller.render(createReplyModel(part));

    expect(requireElement<HTMLDivElement>('.chatmuse-overlay-panel')).toBe(panel);
    expect(requireElement<HTMLButtonElement>('.chatmuse-card-actions .chatmuse-button').textContent).toBe('Insert again');
    expect(requireElement<HTMLDivElement>('.chatmuse-card-status').textContent).toBe('Inserted earlier.');
  });

  it('renders a profiling summary in completed views when profiling is present', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
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

    expect(requireElement<HTMLDivElement>('.chatmuse-profiling-summary').textContent).toContain('Total');
    expect(requireElement<HTMLDivElement>('.chatmuse-profiling-summary').textContent).toContain('Load messages');
    expect(requireElement<HTMLDivElement>('.chatmuse-profiling-summary').textContent).toContain('2 pages, 30 transcript messages');
  });

  it('renders Help Me regenerate action through the generic rerun callback', () => {
    const onRerun = vi.fn();
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun,
    });

    controller.render(createHelpMeModel());

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.chatmuse-overlay-actions .chatmuse-button'))
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
    });

    controller.render(createReadOnlyModel());

    const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.chatmuse-overlay-actions .chatmuse-button'))
      .find((element) => element.textContent === 'Refresh');

    expect(button).toBeDefined();
    button!.click();
    expect(onRerun).toHaveBeenCalledWith('chat-review');
  });

  it('renders profiling summary below the error block when profiling is present', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRerun: () => undefined,
    });

    controller.render({
      kind: 'error',
      feature: 'fast-reply',
      fanDisplayName: 'fan',
      operationId: 'error-op',
      profiling: createProfilingSnapshot(),
      error: {
        code: 'unknown_error',
        message: 'Something broke',
      },
    });

    const grid = requireElement<HTMLDivElement>('.chatmuse-grid');
    expect(grid.firstElementChild?.textContent).toBe('Something broke');
    expect(grid.children[1]?.textContent).toContain('Pipeline Profiling');
  });
});
