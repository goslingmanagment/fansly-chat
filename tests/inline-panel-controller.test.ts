import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type {
  OverlayInsertPart,
  OverlayViewModel,
} from '../src/shared/types.js';

vi.mock('../src/content/textarea.js', () => ({
  insertIntoFanslyTextarea: vi.fn().mockResolvedValue(undefined),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  focusActiveConversationTextarea: vi.fn(),
}));

function createLoadingModel(
  operationId: string,
  rawText: string,
  options?: { progressMessage?: string },
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
    profiling: undefined,
    canCancel: true,
    canRegenerate: true,
    operationId,
  };
}

function createReplyModel(
  parts: OverlayInsertPart[],
  options?: { operationId?: string },
): Extract<OverlayViewModel, { kind: 'reply' }> {
  return {
    kind: 'reply',
    feature: 'fast-reply',
    fanDisplayName: 'fan',
    operationId: options?.operationId ?? 'reply-op',
    parts,
    rawText: parts.map((p) => p.text).join('\n'),
    splitModeRequested: false,
    debugPrompt: undefined,
    profiling: undefined,
    rerunActionLabel: 'Regenerate',
  };
}

function createErrorModel(): Extract<OverlayViewModel, { kind: 'error' }> {
  return {
    kind: 'error',
    feature: 'fast-reply',
    fanDisplayName: 'fan',
    operationId: 'error-op',
    profiling: undefined,
    error: {
      code: 'unknown_error',
      message: 'Something broke',
    },
  };
}

function createPart(text: string, index = 0): OverlayInsertPart {
  return {
    id: `part-${index}`,
    sequenceIndex: index,
    text,
    insertedAt: null,
    insertedOnce: false,
  };
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

function requireElement<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element for selector: ${selector}`);
  }
  return element as T;
}

describe('InlinePanelController', () => {
  // Dynamic import so the mocked textarea module is used
  let InlinePanelController: typeof import('../src/content/inline-panel/inline-panel-controller.js').InlinePanelController;

  beforeEach(async () => {
    installDom();
    const mod = await import('../src/content/inline-panel/inline-panel-controller.js');
    InlinePanelController = mod.InlinePanelController;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function createController(overrides?: Partial<{
    onClose: () => void;
    onExpand: () => void;
    onCancel: (operationId: string) => void;
    onRerun: (feature: string) => void;
  }>) {
    return new InlinePanelController({
      onClose: overrides?.onClose ?? (() => undefined),
      onExpand: overrides?.onExpand ?? (() => undefined),
      onCancel: overrides?.onCancel ?? (() => undefined),
      onRerun: overrides?.onRerun ?? (() => undefined),
    });
  }

  it('reuses loading shell for same-operation chunk updates via Text.data mutation', async () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('stream-op', ''));
    const stream = requireElement<HTMLDivElement>(controller.root, '.chatmuse-stream');
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => {
      records.push(...mutations);
    });

    observer.observe(controller.root, { childList: true, subtree: true });
    controller.render(createLoadingModel('stream-op', 'hello world'));
    await Promise.resolve();
    observer.disconnect();

    expect(stream.textContent).toBe('hello world');
    // Text.data mutation does not produce childList mutation records
    expect(records).toHaveLength(0);
  });

  it('shows default status and stream text for initial loading', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', ''));

    expect(requireElement(controller.root, '.chatmuse-overlay-status').textContent).toBe('Generating\u2026');
    expect(requireElement(controller.root, '.chatmuse-stream').textContent).toBe('Waiting for Claude\u2026');
  });

  it('updates stream text with incoming chunks', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', 'Hello'));
    expect(requireElement(controller.root, '.chatmuse-stream').textContent).toBe('Hello');

    controller.render(createLoadingModel('op', 'Hello there'));
    expect(requireElement(controller.root, '.chatmuse-stream').textContent).toBe('Hello there');
  });

  it('renders reply with Insert and Copy buttons', () => {
    const controller = createController();
    document.body.append(controller.root);

    const part = createPart('Hey there!');
    controller.render(createReplyModel([part]));

    expect(controller.root.classList.contains('chatmuse-hidden')).toBe(false);
    expect(requireElement(controller.root, '.chatmuse-card-text').textContent).toBe('Hey there!');
    const buttons = controller.root.querySelectorAll<HTMLButtonElement>('.chatmuse-card-actions .chatmuse-button');
    expect(buttons[0]?.textContent).toBe('Insert');
    expect(buttons[1]?.textContent).toBe('Copy');
  });

  it('renders error state with message and Regenerate button', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createErrorModel());

    expect(requireElement(controller.root, '.chatmuse-inline-error').textContent).toBe('Something broke');
    expect(requireElement<HTMLButtonElement>(controller.root, '.chatmuse-card-actions .chatmuse-button').textContent).toBe('Regenerate');
  });

  it('error Regenerate button calls onRerun', () => {
    const onRerun = vi.fn();
    const controller = createController({ onRerun });
    document.body.append(controller.root);

    controller.render(createErrorModel());
    requireElement<HTMLButtonElement>(controller.root, '.chatmuse-card-actions .chatmuse-button').click();

    expect(onRerun).toHaveBeenCalledWith('fast-reply');
  });

  it('hide() removes body content and adds chatmuse-hidden', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', 'text'));
    expect(controller.root.classList.contains('chatmuse-hidden')).toBe(false);
    expect(controller.root.querySelector('.chatmuse-inline-panel-body')?.childElementCount).toBeGreaterThan(0);

    controller.hide();

    expect(controller.root.classList.contains('chatmuse-hidden')).toBe(true);
    expect(controller.root.querySelector('.chatmuse-inline-panel-body')?.childElementCount).toBe(0);
  });

  it('expand button calls onExpand', () => {
    const onExpand = vi.fn();
    const controller = createController({ onExpand });
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', ''));
    const expandButton = Array.from(controller.root.querySelectorAll<HTMLButtonElement>('.chatmuse-inline-panel-action'))
      .find((btn) => btn.title === 'Expand');
    expandButton!.click();

    expect(onExpand).toHaveBeenCalledOnce();
  });

  it('close button calls onClose', () => {
    const onClose = vi.fn();
    const controller = createController({ onClose });
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', ''));
    const closeButton = Array.from(controller.root.querySelectorAll<HTMLButtonElement>('.chatmuse-inline-panel-action'))
      .find((btn) => btn.title === 'Close');
    closeButton!.click();

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Escape calls onClose when panel is visible', () => {
    const onClose = vi.fn();
    const controller = createController({ onClose });
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', ''));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Escape does NOT call onClose when focus is in a textarea', () => {
    const onClose = vi.fn();
    const controller = createController({ onClose });
    document.body.append(controller.root);

    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();

    controller.render(createLoadingModel('op', ''));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape does NOT call onClose when focus is in an input', () => {
    const onClose = vi.fn();
    const controller = createController({ onClose });
    document.body.append(controller.root);

    const input = document.createElement('input');
    document.body.append(input);
    input.focus();

    controller.render(createLoadingModel('op', ''));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape does NOT call onClose when panel is hidden', () => {
    const onClose = vi.fn();
    const controller = createController({ onClose });
    document.body.append(controller.root);

    // Panel starts hidden and never rendered
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(onClose).not.toHaveBeenCalled();
  });

  it('Cancel button in loading calls onCancel with operationId', () => {
    const onCancel = vi.fn();
    const controller = createController({ onCancel });
    document.body.append(controller.root);

    controller.render(createLoadingModel('cancel-op', ''));
    const cancelButton = Array.from(controller.root.querySelectorAll<HTMLButtonElement>('.chatmuse-button'))
      .find((btn) => btn.textContent === 'Cancel');
    cancelButton!.click();

    expect(onCancel).toHaveBeenCalledWith('cancel-op');
  });

  it('renders header with feature label and fan display name', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', ''));

    expect(requireElement(controller.root, '.chatmuse-inline-panel-title').textContent).toContain('Reply');
    expect(requireElement(controller.root, '.chatmuse-inline-panel-title').textContent).toContain('@fan');
  });

  it('rebuilds body when loading operationId changes', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op-1', 'first'));
    const stream1 = requireElement(controller.root, '.chatmuse-stream');

    controller.render(createLoadingModel('op-2', 'second'));
    const stream2 = requireElement(controller.root, '.chatmuse-stream');

    // Different operationId → body rebuilt, new stream element
    expect(stream2).not.toBe(stream1);
    expect(stream2.textContent).toBe('second');
  });

  it('shows Inserted earlier status when part.insertedOnce is true', () => {
    const controller = createController();
    document.body.append(controller.root);

    const part = createPart('Hello');
    part.insertedOnce = true;
    controller.render(createReplyModel([part]));

    expect(requireElement(controller.root, '.chatmuse-card-status').textContent).toBe('Inserted earlier.');
  });

  // ─── Header Row Structure ────────────────────────────────────

  it('card has chatmuse-card-header-row as direct child containing title and actions', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createReplyModel([createPart('Hello')]));

    const card = requireElement(controller.root, '.chatmuse-card');
    const headerRow = requireElement(card, ':scope > .chatmuse-card-header-row');
    expect(headerRow).toBeTruthy();
    expect(requireElement(headerRow, '.chatmuse-card-title').textContent).toBe('Message 1');
    expect(requireElement(headerRow, '.chatmuse-card-actions')).toBeTruthy();
    // Actions should NOT be a sibling of card-text
    expect(card.querySelector(':scope > .chatmuse-card-actions')).toBeNull();
  });

  it('status renders inside header row when insertedOnce is true', () => {
    const controller = createController();
    document.body.append(controller.root);

    const part = createPart('Hello');
    part.insertedOnce = true;
    controller.render(createReplyModel([part]));

    const headerRow = requireElement(controller.root, '.chatmuse-card-header-row');
    expect(requireElement(headerRow, '.chatmuse-card-status').textContent).toBe('Inserted earlier.');
  });

  it('hint renders inside header row in split mode', () => {
    const controller = createController();
    document.body.append(controller.root);

    const model = createReplyModel([createPart('First', 0), createPart('Second', 1)]);
    model.splitModeRequested = true;
    controller.render(model);

    const cards = controller.root.querySelectorAll('.chatmuse-card');
    expect(cards).toHaveLength(2);
    const firstHeaderRow = requireElement(cards[0] as HTMLElement, '.chatmuse-card-header-row');
    expect(requireElement(firstHeaderRow, '.chatmuse-card-hint').textContent).toBe('Suggested first send.');
  });

  it('reply Regenerate button calls onRerun', () => {
    const onRerun = vi.fn();
    const controller = createController({ onRerun });
    document.body.append(controller.root);

    controller.render(createReplyModel([createPart('Hello')]));
    const regenButton = Array.from(controller.root.querySelectorAll<HTMLButtonElement>('.chatmuse-button'))
      .find((btn) => btn.textContent === 'Regenerate');
    regenButton!.click();

    expect(onRerun).toHaveBeenCalledWith('fast-reply');
  });
});
