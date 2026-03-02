import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { OverlayController } from '../src/content/overlay/overlay-controller.js';
import type { OverlayInsertPart, OverlayViewModel } from '../src/shared/types.js';

function createLoadingModel(
  operationId: string,
  rawText: string,
): Extract<OverlayViewModel, { kind: 'loading' }> {
  return {
    kind: 'loading',
    feature: 'fast-reply',
    fanDisplayName: 'fan',
    progress: null,
    rawText,
    debugPrompt: undefined,
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
    canRegenerate: true,
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
      onRegenerate: () => undefined,
      onRefreshSummary: () => undefined,
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

  it('emits render diagnostics for repeated loading renders when debug tracing is enabled', () => {
    const controller = new OverlayController({
      onClose: () => undefined,
      onCancel: () => undefined,
      onRegenerate: () => undefined,
      onRefreshSummary: () => undefined,
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
      onRegenerate: () => undefined,
      onRefreshSummary: () => undefined,
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
});
