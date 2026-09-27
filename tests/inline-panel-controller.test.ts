import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type {
  LlmSpendSummary,
  CompareInlineViewModel,
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
  options?: { progressMessage?: string; llmSpend?: LlmSpendSummary },
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
    llmSpend: options?.llmSpend,
    profiling: undefined,
    canCancel: true,
    canRegenerate: true,
    operationId,
  };
}

function createReplyModel(
  parts: OverlayInsertPart[],
  options?: { operationId?: string; llmSpend?: LlmSpendSummary; groupId?: string },
): Extract<OverlayViewModel, { kind: 'reply' }> {
  return {
    kind: 'reply',
    feature: 'fast-reply',
    fanDisplayName: 'fan',
    operationId: options?.operationId ?? 'reply-op',
    // Matches the suite's JSDOM /messages/example URL — see the insert guard.
    groupId: options?.groupId ?? 'example',
    parts,
    rawText: parts.map((p) => p.text).join('\n'),
    splitModeRequested: false,
    debugPrompt: undefined,
    llmSpend: options?.llmSpend,
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
      key: 'unknown_error',
      code: 'CG-APP-01',
      message: 'Something broke',
    },
  };
}

function createCompareModel(
  overrides?: Partial<CompareInlineViewModel>,
): CompareInlineViewModel {
  return {
    kind: 'compare',
    fanDisplayName: 'fan',
    operationId: 'compare-op',
    activeCardId: 'current',
    progress: {
      operationId: 'compare-op',
      phase: 'generating',
      message: 'Generating compare replies…',
    },
    canCancel: true,
    canRegenerate: false,
    tabs: [
      {
        cardId: 'current',
        label: 'Current',
        source: 'current',
        status: 'reply',
        rawText: 'Current reply',
        parts: [createPart('Current reply')],
      },
      {
        cardId: 'draft',
        label: 'Draft',
        source: 'draft',
        status: 'loading',
        rawText: '',
        parts: [],
      },
    ],
    ...overrides,
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
    isKeyboardBlocked: () => boolean;
    onExpand: () => void;
    onCancel: (operationId: string) => void;
    onRerun: (feature: string) => void;
    onCompareRerun: () => void;
    onCompareTabSelect: (cardId: string) => void;
    onAcceptance: (operationId: string, action: 'copied' | 'inserted', partIndex: number) => void;
  }>) {
    return new InlinePanelController({
      onClose: overrides?.onClose ?? (() => undefined),
      isKeyboardBlocked: overrides?.isKeyboardBlocked,
      onExpand: overrides?.onExpand ?? (() => undefined),
      onCancel: overrides?.onCancel ?? (() => undefined),
      onRerun: overrides?.onRerun ?? (() => undefined),
      onCompareRerun: overrides?.onCompareRerun ?? (() => undefined),
      onCompareTabSelect: overrides?.onCompareTabSelect ?? (() => undefined),
      onAcceptance: overrides?.onAcceptance,
    });
  }

  it('reuses loading shell for same-operation chunk updates via Text.data mutation', async () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('stream-op', ''));
    const stream = requireElement<HTMLDivElement>(controller.root, '.chatgoose-stream');
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

    expect(requireElement(controller.root, '.chatgoose-overlay-status').textContent).toBe('Generating\u2026');
    expect(requireElement(controller.root, '.chatgoose-stream').textContent).toBe('Waiting for AI\u2026');
  });

  it('hides header meta while loading before usage arrives', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', ''));

    const meta = requireElement(controller.root, '.chatgoose-inline-panel-meta');
    expect(meta.classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('shows header meta once spend arrives during loading', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', 'chunk', {
      llmSpend: createSpendSummary(),
    }));

    const meta = requireElement(controller.root, '.chatgoose-inline-panel-meta');
    expect(meta.classList.contains('chatgoose-hidden')).toBe(false);
    expect(requireElement(controller.root, '.chatgoose-inline-panel-meta-primary').textContent).toContain('$0.002982');
  });

  it('updates stream text with incoming chunks', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', 'Hello'));
    expect(requireElement(controller.root, '.chatgoose-stream').textContent).toBe('Hello');

    controller.render(createLoadingModel('op', 'Hello there'));
    expect(requireElement(controller.root, '.chatgoose-stream').textContent).toBe('Hello there');
  });

  it('renders reply with Insert and Copy buttons', () => {
    const controller = createController();
    document.body.append(controller.root);

    const part = createPart('Hey there!');
    controller.render(createReplyModel([part]));

    expect(controller.root.classList.contains('chatgoose-hidden')).toBe(false);
    expect(requireElement(controller.root, '.chatgoose-card-text').textContent).toBe('Hey there!');
    const buttons = controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button');
    expect(buttons[0]?.textContent).toBe('Insert');
    expect(buttons[1]?.textContent).toBe('Copy');
  });

  it('renders spend as single line in header with token breakdown in tooltip', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(
      createReplyModel([createPart('Hey there!')], {
        llmSpend: createSpendSummary({ cacheEffectKind: 'saved', cacheEffectUsd: 0.00045 }),
      }),
    );

    const primary = requireElement<HTMLElement>(controller.root, '.chatgoose-inline-panel-meta-primary');
    expect(primary.textContent).toContain('$0.002982');
    expect(primary.textContent).toContain('saved');
    // Secondary info moved to tooltip
    expect(primary.title).toContain('in ');
    expect(primary.title).toContain('out ');
  });

  it('renders error state with message and Regenerate button', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createErrorModel());

    expect(requireElement(controller.root, '.chatgoose-inline-error').textContent).toContain('CG-APP-01');
    expect(requireElement(controller.root, '.chatgoose-inline-error').textContent).toContain('Something broke');
    expect(requireElement<HTMLButtonElement>(controller.root, '.chatgoose-card-actions .chatgoose-button').textContent).toBe('Regenerate');
  });

  it('error Regenerate button calls onRerun', () => {
    const onRerun = vi.fn();
    const controller = createController({ onRerun });
    document.body.append(controller.root);

    controller.render(createErrorModel());
    requireElement<HTMLButtonElement>(controller.root, '.chatgoose-card-actions .chatgoose-button').click();

    expect(onRerun).toHaveBeenCalledWith('fast-reply');
  });

  it('hide() removes body content and adds chatgoose-hidden', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', 'text'));
    expect(controller.root.classList.contains('chatgoose-hidden')).toBe(false);
    expect(controller.root.querySelector('.chatgoose-inline-panel-body')?.childElementCount).toBeGreaterThan(0);

    controller.hide();

    expect(controller.root.classList.contains('chatgoose-hidden')).toBe(true);
    expect(controller.root.querySelector('.chatgoose-inline-panel-body')?.childElementCount).toBe(0);
  });

  it('expand button calls onExpand', () => {
    const onExpand = vi.fn();
    const controller = createController({ onExpand });
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', ''));
    const expandButton = Array.from(controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-inline-panel-action'))
      .find((btn) => btn.title === 'Expand');
    expandButton!.click();

    expect(onExpand).toHaveBeenCalledOnce();
  });

  it('close button calls onClose', () => {
    const onClose = vi.fn();
    const controller = createController({ onClose });
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', ''));
    const closeButton = Array.from(controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-inline-panel-action'))
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
    const cancelButton = Array.from(controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-button'))
      .find((btn) => btn.textContent === 'Cancel');
    cancelButton!.click();

    expect(onCancel).toHaveBeenCalledWith('cancel-op');
  });

  it('renders header with feature label and fan display name', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', ''));

    expect(requireElement(controller.root, '.chatgoose-inline-panel-title').textContent).toContain('Reply');
    expect(requireElement(controller.root, '.chatgoose-inline-panel-title').textContent).toContain('@fan');
  });

  it('rebuilds body when loading operationId changes', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op-1', 'first'));
    const stream1 = requireElement(controller.root, '.chatgoose-stream');

    controller.render(createLoadingModel('op-2', 'second'));
    const stream2 = requireElement(controller.root, '.chatgoose-stream');

    // Different operationId → body rebuilt, new stream element
    expect(stream2).not.toBe(stream1);
    expect(stream2.textContent).toBe('second');
  });

  it('labels Hi results as alternative greetings without changing Split or Ping headings', () => {
    const controller = createController();
    document.body.append(controller.root);
    const model = createReplyModel([createPart('Hello', 0), createPart('Hey', 1)]);
    model.feature = 'hi-greeting';
    controller.render(model);
    const titles = () => Array.from(controller.root.querySelectorAll('.chatgoose-card-title')).map((node) => node.textContent);
    expect(titles()).toEqual(['Variant 1', 'Variant 2']);
    expect(controller.root.textContent).toContain('Choose one greeting.');
    controller.render({ ...model, feature: 'fast-reply', splitModeRequested: true });
    expect(titles()).toEqual(['Message 1', 'Follow-up 2']);
    expect(controller.root.textContent).not.toContain('Choose one greeting.');
    controller.render({ ...model, feature: 'ping', parts: [model.parts[0]!] });
    expect(titles()).toEqual(['Message 1']);
  });

  it('shows Inserted earlier status when part.insertedOnce is true', () => {
    const controller = createController();
    document.body.append(controller.root);

    const part = createPart('Hello');
    part.insertedOnce = true;
    controller.render(createReplyModel([part]));

    expect(requireElement(controller.root, '.chatgoose-card-status').textContent).toBe('Inserted earlier.');
  });

  // ─── Header Row Structure ────────────────────────────────────

  it('card has chatgoose-card-header-row as direct child containing title and actions', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createReplyModel([createPart('Hello')]));

    const card = requireElement(controller.root, '.chatgoose-card');
    const headerRow = requireElement(card, ':scope > .chatgoose-card-header-row');
    expect(headerRow).toBeTruthy();
    expect(requireElement(headerRow, '.chatgoose-card-title').textContent).toBe('Message 1');
    expect(requireElement(headerRow, '.chatgoose-card-actions')).toBeTruthy();
    // Actions should NOT be a sibling of card-text
    expect(card.querySelector(':scope > .chatgoose-card-actions')).toBeNull();
  });

  it('status renders inside header row when insertedOnce is true', () => {
    const controller = createController();
    document.body.append(controller.root);

    const part = createPart('Hello');
    part.insertedOnce = true;
    controller.render(createReplyModel([part]));

    const headerRow = requireElement(controller.root, '.chatgoose-card-header-row');
    expect(requireElement(headerRow, '.chatgoose-card-status').textContent).toBe('Inserted earlier.');
  });

  it('hint renders inside header row in split mode', () => {
    const controller = createController();
    document.body.append(controller.root);

    const model = createReplyModel([createPart('First', 0), createPart('Second', 1)]);
    model.splitModeRequested = true;
    controller.render(model);

    const cards = controller.root.querySelectorAll('.chatgoose-card');
    expect(cards).toHaveLength(2);
    const firstHeaderRow = requireElement(cards[0] as HTMLElement, '.chatgoose-card-header-row');
    expect(requireElement(firstHeaderRow, '.chatgoose-card-hint').textContent).toBe('Suggested first send.');
    expect((cards[0] as HTMLElement).classList.contains('chatgoose-card-recommended')).toBe(true);
    const secondHeaderRow = requireElement(cards[1] as HTMLElement, '.chatgoose-card-header-row');
    expect(requireElement(secondHeaderRow, '.chatgoose-card-hint').textContent).toBe(
      'Suggested follow-up after message 1.',
    );
    expect((cards[1] as HTMLElement).classList.contains('chatgoose-card-followup')).toBe(true);
  });

  it('shows a one-part Split violation while preserving Insert and Regenerate', () => {
    const controller = createController();
    document.body.append(controller.root);

    const model = createReplyModel([createPart('Only one')]);
    model.splitModeRequested = true;
    controller.render(model);

    const note = requireElement(controller.root, '.chatgoose-inline-note');
    expect(note.classList.contains('chatgoose-inline-note-warn')).toBe(true);
    expect(note.textContent).toContain('Try Regenerate');
    const buttons = Array.from(
      controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-button'),
    ).map((button) => button.textContent);
    expect(buttons).toContain('Insert');
    expect(buttons).toContain('Regenerate');
  });

  it('shows neutral guidance for a successful two-part Split', () => {
    const controller = createController();
    document.body.append(controller.root);

    const model = createReplyModel([createPart('First', 0), createPart('Second', 1)]);
    model.splitModeRequested = true;
    controller.render(model);

    const note = requireElement(controller.root, '.chatgoose-inline-note');
    expect(note.classList.contains('chatgoose-inline-note-warn')).toBe(false);
    expect(note.textContent).toContain('Split mode was on');
  });

  it('shows a one-part Split violation on the active Compare tab', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createCompareModel({
      progress: null,
      canCancel: false,
      tabs: [
        {
          cardId: 'current',
          label: 'Current',
          source: 'current',
          status: 'reply',
          rawText: 'Only one',
          parts: [createPart('Only one')],
          splitModeRequested: true,
        },
      ],
    }));

    const note = requireElement(controller.root, '.chatgoose-inline-note');
    expect(note.classList.contains('chatgoose-inline-note-warn')).toBe(true);
    expect(note.textContent).toContain('at least 2 messages');
  });

  it('reply Regenerate button calls onRerun', () => {
    const onRerun = vi.fn();
    const controller = createController({ onRerun });
    document.body.append(controller.root);

    controller.render(createReplyModel([createPart('Hello')]));
    const regenButton = Array.from(controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-button'))
      .find((btn) => btn.textContent === 'Regenerate');
    regenButton!.click();

    expect(onRerun).toHaveBeenCalledWith('fast-reply');
  });

  it('renders compare tabs and notifies when switching tabs', () => {
    const onCompareTabSelect = vi.fn();
    const controller = createController({ onCompareTabSelect });
    document.body.append(controller.root);

    controller.render(createCompareModel());

    expect(requireElement(controller.root, '.chatgoose-compare-summary').textContent).toBe('Comparing current + 1 draft');
    const tabs = controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-compare-tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.textContent).toContain('Current');
    expect(tabs[1]?.textContent).toContain('Draft');
    expect(tabs[1]?.querySelector('.chatgoose-spinner')).not.toBeNull();
    expect(tabs[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(tabs[1]?.getAttribute('aria-pressed')).toBe('false');

    tabs[1]!.click();
    expect(onCompareTabSelect).toHaveBeenCalledWith('draft');
  });

  it('reuses the Compare shell, tabs, active host, and streaming Text for same-operation chunks', async () => {
    const controller = createController();
    document.body.append(controller.root);
    const model = createCompareModel({ activeCardId: 'draft' });

    controller.render(model);
    const compareRoot = requireElement(
      controller.root,
      '.chatgoose-inline-panel-body > .chatgoose-grid',
    );
    const tabsRoot = requireElement(controller.root, '.chatgoose-compare-tabs');
    const activeHost = requireElement(controller.root, '.chatgoose-compare-active');
    const stream = requireElement(controller.root, '.chatgoose-stream-live');
    const streamText = stream.firstChild;
    const tabButtons = Array.from(
      controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-compare-tab'),
    );
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => records.push(...mutations));
    observer.observe(compareRoot, { childList: true, subtree: true });

    model.tabs[1]!.rawText = 'Hello from the draft';
    model.progress = {
      operationId: 'compare-op',
      phase: 'generating',
      message: 'Writing the draft…',
    };
    controller.render(model);
    await Promise.resolve();
    observer.disconnect();

    expect(
      requireElement(controller.root, '.chatgoose-inline-panel-body > .chatgoose-grid'),
    ).toBe(compareRoot);
    expect(requireElement(controller.root, '.chatgoose-compare-tabs')).toBe(tabsRoot);
    expect(requireElement(controller.root, '.chatgoose-compare-active')).toBe(activeHost);
    expect(requireElement(controller.root, '.chatgoose-stream-live')).toBe(stream);
    expect(stream.firstChild).toBe(streamText);
    expect(streamText).toBeInstanceOf(Text);
    expect(streamText?.textContent).toBe('Hello from the draft');
    expect(requireElement(controller.root, '.chatgoose-overlay-status').textContent).toBe(
      'Writing the draft…',
    );
    expect(
      Array.from(controller.root.querySelectorAll('.chatgoose-compare-tab')),
    ).toEqual(tabButtons);
    expect(records).toHaveLength(0);
  });

  it('keeps keyed Compare tabs and the active host while switching cards without duplicating listeners', () => {
    const onCompareTabSelect = vi.fn();
    const controller = createController({ onCompareTabSelect });
    document.body.append(controller.root);
    const model = createCompareModel();

    controller.render(model);
    const compareRoot = requireElement(
      controller.root,
      '.chatgoose-inline-panel-body > .chatgoose-grid',
    );
    const tabsRoot = requireElement(controller.root, '.chatgoose-compare-tabs');
    const activeHost = requireElement(controller.root, '.chatgoose-compare-active');
    const currentBody = activeHost.firstElementChild;
    const [currentButton, draftButton] = Array.from(
      controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-compare-tab'),
    );

    model.activeCardId = 'draft';
    controller.render(model);
    const draftBody = activeHost.firstElementChild;
    const draftStream = requireElement(controller.root, '.chatgoose-stream-live');
    const draftStreamText = draftStream.firstChild;
    controller.render(model);

    expect(
      requireElement(controller.root, '.chatgoose-inline-panel-body > .chatgoose-grid'),
    ).toBe(compareRoot);
    expect(requireElement(controller.root, '.chatgoose-compare-tabs')).toBe(tabsRoot);
    expect(requireElement(controller.root, '.chatgoose-compare-active')).toBe(activeHost);
    const updatedButtons = Array.from(
      controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-compare-tab'),
    );
    expect(updatedButtons[0]).toBe(currentButton);
    expect(updatedButtons[1]).toBe(draftButton);
    expect(currentButton?.getAttribute('aria-pressed')).toBe('false');
    expect(draftButton?.getAttribute('aria-pressed')).toBe('true');
    expect(activeHost.firstElementChild).toBe(draftBody);
    expect(requireElement(controller.root, '.chatgoose-stream-live')).toBe(draftStream);
    expect(draftStream.firstChild).toBe(draftStreamText);

    model.activeCardId = 'current';
    controller.render(model);
    expect(activeHost.firstElementChild).toBe(currentBody);

    // An inactive card may keep streaming. The visible completed body does not
    // rebuild, and switching back revives the same loading Text node with the
    // latest accumulated text.
    model.tabs[1]!.rawText = 'Streaming while hidden';
    controller.render(model);
    expect(activeHost.firstElementChild).toBe(currentBody);
    model.activeCardId = 'draft';
    controller.render(model);
    expect(activeHost.firstElementChild).toBe(draftBody);
    expect(draftStream.firstChild).toBe(draftStreamText);
    expect(draftStreamText?.textContent).toBe('Streaming while hidden');

    draftButton?.click();
    expect(onCompareTabSelect).toHaveBeenCalledTimes(1);
    expect(onCompareTabSelect).toHaveBeenCalledWith('draft');
  });

  it('updates tab completion and terminal actions in place across the live-to-completed hand-off', () => {
    const onCompareRerun = vi.fn();
    const controller = createController({ onCompareRerun });
    document.body.append(controller.root);
    const model = createCompareModel({ activeCardId: 'draft' });

    controller.render(model);
    const compareRoot = requireElement(
      controller.root,
      '.chatgoose-inline-panel-body > .chatgoose-grid',
    );
    const tabsRoot = requireElement(controller.root, '.chatgoose-compare-tabs');
    const activeHost = requireElement(controller.root, '.chatgoose-compare-active');
    const actions = requireElement(controller.root, '.chatgoose-grid > .chatgoose-card-actions');
    const draftButton = Array.from(
      controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-compare-tab'),
    )[1]!;
    expect(draftButton.querySelector('.chatgoose-spinner')).not.toBeNull();

    const draft = model.tabs[1]!;
    draft.status = 'reply';
    draft.rawText = 'Finished draft';
    draft.parts = [createPart('Finished draft')];
    model.operationId = null;
    model.progress = null;
    model.canCancel = false;
    model.canRegenerate = true;
    controller.render(model);

    expect(
      requireElement(controller.root, '.chatgoose-inline-panel-body > .chatgoose-grid'),
    ).toBe(compareRoot);
    expect(requireElement(controller.root, '.chatgoose-compare-tabs')).toBe(tabsRoot);
    expect(requireElement(controller.root, '.chatgoose-compare-active')).toBe(activeHost);
    expect(requireElement(controller.root, '.chatgoose-grid > .chatgoose-card-actions')).toBe(
      actions,
    );
    expect(
      Array.from(controller.root.querySelectorAll('.chatgoose-compare-tab'))[1],
    ).toBe(draftButton);
    expect(draftButton.querySelector('.chatgoose-spinner')).toBeNull();
    expect(requireElement(controller.root, '.chatgoose-card-text').textContent).toBe(
      'Finished draft',
    );
    expect(
      Array.from(actions.querySelectorAll('button')).some(
        (button) => button.textContent === 'Cancel all',
      ),
    ).toBe(false);
    const regenerate = Array.from(actions.querySelectorAll('button')).find(
      (button) => button.textContent === 'Regenerate all',
    );
    regenerate?.click();
    expect(onCompareRerun).toHaveBeenCalledOnce();
  });

  it('updates an active Compare tab to error without recreating its shell or tab listener', () => {
    const onCancel = vi.fn();
    const controller = createController({ onCancel });
    document.body.append(controller.root);
    const model = createCompareModel({ activeCardId: 'draft' });

    controller.render(model);
    const compareRoot = requireElement(
      controller.root,
      '.chatgoose-inline-panel-body > .chatgoose-grid',
    );
    const activeHost = requireElement(controller.root, '.chatgoose-compare-active');
    const draftButton = Array.from(
      controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-compare-tab'),
    )[1]!;
    const cancel = Array.from(controller.root.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent === 'Cancel all',
    )!;

    const draft = model.tabs[1]!;
    draft.status = 'error';
    draft.error = {
      key: 'unknown_error',
      code: 'CG-APP-01',
      message: 'Draft failed incrementally',
    };
    controller.render(model);
    controller.render(model);

    expect(
      requireElement(controller.root, '.chatgoose-inline-panel-body > .chatgoose-grid'),
    ).toBe(compareRoot);
    expect(requireElement(controller.root, '.chatgoose-compare-active')).toBe(activeHost);
    expect(
      Array.from(controller.root.querySelectorAll('.chatgoose-compare-tab'))[1],
    ).toBe(draftButton);
    expect(draftButton.querySelector('.chatgoose-spinner')).toBeNull();
    expect(requireElement(controller.root, '.chatgoose-inline-error').textContent).toContain(
      'Draft failed incrementally',
    );
    expect(
      Array.from(controller.root.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent === 'Cancel all',
      ),
    ).toBe(cancel);
    cancel.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith('compare-op');
  });

  it('rebuilds the Compare body for a different live operation', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createCompareModel({ operationId: 'compare-one' }));
    const firstRoot = requireElement(
      controller.root,
      '.chatgoose-inline-panel-body > .chatgoose-grid',
    );

    controller.render(createCompareModel({ operationId: 'compare-two' }));

    expect(
      requireElement(controller.root, '.chatgoose-inline-panel-body > .chatgoose-grid'),
    ).not.toBe(firstRoot);
  });

  it('renders compare reply content for the active tab and supports regenerate all', () => {
    const onCompareRerun = vi.fn();
    const controller = createController({ onCompareRerun });
    document.body.append(controller.root);

    controller.render(createCompareModel({
      operationId: null,
      canCancel: false,
      canRegenerate: true,
    }));

    expect(requireElement(controller.root, '.chatgoose-card-text').textContent).toBe('Current reply');
    const buttons = Array.from(controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button'));
    expect(buttons.some((button) => button.textContent === 'Insert')).toBe(true);
    expect(buttons.some((button) => button.textContent === 'Copy')).toBe(true);

    const regenerate = buttons.find((button) => button.textContent === 'Regenerate all');
    expect(regenerate).toBeDefined();
    regenerate!.click();
    expect(onCompareRerun).toHaveBeenCalledOnce();
  });

  it('renders spend details for the active compare tab and updates when switching tabs', () => {
    const onCompareTabSelect = vi.fn();
    const controller = createController({ onCompareTabSelect });
    document.body.append(controller.root);

    controller.render(
      createCompareModel({
        tabs: [
          {
            cardId: 'current',
            label: 'Current',
            source: 'current',
            status: 'reply',
            rawText: 'Current reply',
            parts: [createPart('Current reply')],
            llmSpend: createSpendSummary({ totalUsd: 0.001111 }),
          },
          {
            cardId: 'draft',
            label: 'Draft',
            source: 'draft',
            status: 'reply',
            rawText: 'Draft reply',
            parts: [createPart('Draft reply')],
            llmSpend: createSpendSummary({ totalUsd: 0.002222 }),
          },
        ],
      }),
    );

    expect(requireElement(controller.root, '.chatgoose-spend-strip-primary').textContent).toContain(
      '$0.001111',
    );

    const draftTab = Array.from(
      controller.root.querySelectorAll<HTMLButtonElement>('.chatgoose-compare-tab'),
    ).find((button) => button.textContent?.includes('Draft'));
    draftTab?.click();
    expect(onCompareTabSelect).toHaveBeenCalledWith('draft');

    controller.render(
      createCompareModel({
        activeCardId: 'draft',
        tabs: [
          {
            cardId: 'current',
            label: 'Current',
            source: 'current',
            status: 'reply',
            rawText: 'Current reply',
            parts: [createPart('Current reply')],
            llmSpend: createSpendSummary({ totalUsd: 0.001111 }),
          },
          {
            cardId: 'draft',
            label: 'Draft',
            source: 'draft',
            status: 'reply',
            rawText: 'Draft reply',
            parts: [createPart('Draft reply')],
            llmSpend: createSpendSummary({ totalUsd: 0.002222 }),
          },
        ],
      }),
    );

    expect(requireElement(controller.root, '.chatgoose-spend-strip-primary').textContent).toContain(
      '$0.002222',
    );
  });

  it('renders compare summary for multiple draft tabs', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createCompareModel({
      tabs: [
        {
          cardId: 'current',
          label: 'Current',
          source: 'current',
          status: 'reply',
          rawText: 'Current reply',
          parts: [createPart('Current reply')],
        },
        {
          cardId: 'draft-1',
          label: 'Draft 1',
          source: 'draft',
          status: 'reply',
          rawText: 'Draft 1 reply',
          parts: [createPart('Draft 1 reply')],
        },
        {
          cardId: 'draft-2',
          label: 'Draft 2',
          source: 'draft',
          status: 'reply',
          rawText: 'Draft 2 reply',
          parts: [createPart('Draft 2 reply')],
        },
        {
          cardId: 'draft-3',
          label: 'Draft 3',
          source: 'draft',
          status: 'reply',
          rawText: 'Draft 3 reply',
          parts: [createPart('Draft 3 reply')],
        },
      ],
    }));

    expect(requireElement(controller.root, '.chatgoose-compare-summary').textContent).toBe('Comparing current + 3 drafts');
    expect(controller.root.querySelectorAll('.chatgoose-compare-tab')).toHaveLength(4);
  });

  it('renders compare error state for the active tab', () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createCompareModel({
      activeCardId: 'draft',
      tabs: [
        {
          cardId: 'current',
          label: 'Current',
          source: 'current',
          status: 'reply',
          rawText: 'Current reply',
          parts: [createPart('Current reply')],
        },
        {
          cardId: 'draft',
          label: 'Draft',
          source: 'draft',
          status: 'error',
          rawText: '',
          parts: [],
          error: {
            key: 'unknown_error',
            code: 'CG-APP-01',
            message: 'Draft failed',
          },
        },
      ],
    }));

    expect(requireElement(controller.root, '.chatgoose-inline-error').textContent).toContain('CG-APP-01');
    expect(requireElement(controller.root, '.chatgoose-inline-error').textContent).toContain('Draft failed');
  });

  it.each(['copy', 'insert'] as const)('keeps delayed %s acceptance attached to its original operation', async (action) => {
    const textarea = await import('../src/content/textarea.js');
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const method = action === 'copy' ? textarea.copyToClipboard : textarea.insertIntoFanslyTextarea;
    vi.mocked(method).mockReturnValueOnce(pending);
    const onAcceptance = vi.fn();
    const controller = createController({ onAcceptance });
    document.body.append(controller.root);
    controller.render(createReplyModel([createPart('Old reply')], { operationId: 'old-op' }));
    const selector = action === 'copy'
      ? '.chatgoose-card-actions .chatgoose-button-secondary'
      : '.chatgoose-card-actions .chatgoose-button';
    requireElement<HTMLButtonElement>(controller.root, selector).click();
    controller.render(createReplyModel([createPart('New reply')], { operationId: 'new-op' }));
    const newCard = requireElement(controller.root, '.chatgoose-card');
    finish();
    await vi.waitFor(() => {
      expect(onAcceptance).toHaveBeenCalledWith('old-op', action === 'copy' ? 'copied' : 'inserted', 0);
    });
    expect(onAcceptance).toHaveBeenCalledTimes(1);
    expect(requireElement(controller.root, '.chatgoose-card')).toBe(newCard);
  });

  it('does not put a delayed clipboard failure onto the next result', async () => {
    const { copyToClipboard } = await import('../src/content/textarea.js');
    let fail!: (error: Error) => void;
    vi.mocked(copyToClipboard).mockReturnValueOnce(new Promise<void>((_, reject) => { fail = reject; }));
    const controller = createController();
    document.body.append(controller.root);
    controller.render(createReplyModel([createPart('Old reply')]));
    requireElement<HTMLButtonElement>(controller.root, '.chatgoose-card-actions .chatgoose-button-secondary').click();
    controller.render(createReplyModel([createPart('New reply')], { operationId: 'new-op' }));
    fail(new Error('Clipboard denied'));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.root.querySelector('.chatgoose-inline-error')).toBeNull();
    expect(controller.root.textContent).toContain('New reply');
  });

  // ─── Enter-to-insert ─────────────────────────────────────────

  it.each(['Enter', ' '])('cancels native %s activation of a covered focused Insert button', async (key) => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    let covered = false;
    const controller = createController({ isKeyboardBlocked: () => covered });
    document.body.append(controller.root);
    controller.render(createReplyModel([createPart('Must stay out of composer')]));
    const insert = requireElement<HTMLButtonElement>(controller.root, '.chatgoose-card-actions .chatgoose-button');
    insert.focus();
    covered = true;
    const keydown = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    // jsdom does not synthesize native button activation. Model the browser's
    // default click only if the keydown was not cancelled by the page.
    if (insert.dispatchEvent(keydown)) insert.click();
    await Promise.resolve();
    expect(keydown.defaultPrevented).toBe(true);
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
    // A queued/native click must be fenced at the action boundary too.
    insert.click();
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('leaves Enter and Escape to the covering reference surface', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const onClose = vi.fn();
    const controller = createController({ onClose, isKeyboardBlocked: () => true });
    document.body.append(controller.root);
    controller.render(createReplyModel([createPart('Hidden behind board')]));
    (document.activeElement as HTMLElement)?.blur?.();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Enter inserts the first part for a visible fast-reply', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    const controller = createController();
    document.body.append(controller.root);

    const part = createPart('Hey there!');
    controller.render(createReplyModel([part]));
    // Clear focus from auto-focus so Enter handler treats it as body focus
    (document.activeElement as HTMLElement)?.blur?.();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => {
      expect(insertIntoFanslyTextarea).toHaveBeenCalledWith('Hey there!');
    });
  });

  it('after part 1 is marked inserted, Enter targets part 2 for split replies', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    const controller = createController();
    document.body.append(controller.root);

    const part1 = createPart('First', 0);
    part1.insertedOnce = true;
    const part2 = createPart('Second', 1);
    const model = createReplyModel([part1, part2]);
    model.splitModeRequested = true;
    controller.render(model);
    (document.activeElement as HTMLElement)?.blur?.();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => {
      expect(insertIntoFanslyTextarea).toHaveBeenCalledWith('Second');
    });
  });

  it('Split Fix parts focus the first Insert and Enter walks to the follow-up (E142)', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = createController();
    document.body.append(controller.root);

    const part1 = createPart('First', 0);
    const part2 = createPart('Second', 1);
    const model = { ...createReplyModel([part1, part2], { operationId: 'fix-op' }), feature: 'improve-draft' as const };
    model.splitModeRequested = true;
    controller.render(model);
    await vi.waitFor(() => {
      const btn = controller.root.querySelector<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button');
      expect(document.activeElement).toBe(btn);
    });

    part1.insertedOnce = true;
    controller.render(model);
    (document.activeElement as HTMLElement)?.blur?.();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.waitFor(() => {
      expect(insertIntoFanslyTextarea).toHaveBeenCalledWith('Second');
    });
  });

  it('refuses to insert a result minted for another chat — live URL wins', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = createController();
    document.body.append(controller.root);

    // JSDOM sits on /messages/example; the model was minted for another group —
    // the ≤500ms post-switch window where the polled route still lags. The
    // click must surface chat_changed instead of writing into the foreign chat.
    controller.render(createReplyModel([createPart('Hey there!')], { groupId: 'other-fan' }));

    const insertButton = controller.root.querySelector<HTMLButtonElement>(
      '.chatgoose-card-actions .chatgoose-button',
    );
    expect(insertButton?.textContent).toBe('Insert');
    insertButton!.click();

    await vi.waitFor(() => {
      expect(requireElement(controller.root, '.chatgoose-inline-error').textContent)
        .toContain('Контекст переписки изменился');
    });
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('Enter is ignored for hidden panel', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = createController();
    document.body.append(controller.root);

    // Panel starts hidden
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('Enter is ignored during loading state', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createLoadingModel('op', 'text'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('Enter is ignored for error state', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createErrorModel());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('Enter is ignored when focus is in a textarea', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createReplyModel([createPart('Hello')]));

    const textarea = document.createElement('textarea');
    document.body.append(textarea);
    textarea.focus();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('Enter with modifier keys is ignored', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createReplyModel([createPart('Hello')]));
    (document.activeElement as HTMLElement)?.blur?.();

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });

  it('newly rendered fast reply focuses the first Insert button', async () => {
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createReplyModel([createPart('Hello')]));
    await vi.waitFor(() => {
      const btn = controller.root.querySelector<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button');
      expect(document.activeElement).toBe(btn);
    });
  });

  it('Enter on the focused Insert button only inserts once', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createReplyModel([createPart('Hello')]));
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(
        controller.root.querySelector('.chatgoose-card-actions .chatgoose-button'),
      );
    });

    const insertButton = requireElement<HTMLButtonElement>(
      controller.root,
      '.chatgoose-card-actions .chatgoose-button',
    );
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

  it('Enter is ignored for compare state', async () => {
    const { insertIntoFanslyTextarea } = await import('../src/content/textarea.js');
    vi.mocked(insertIntoFanslyTextarea).mockClear();
    const controller = createController();
    document.body.append(controller.root);

    controller.render(createCompareModel());
    (document.activeElement as HTMLElement)?.blur?.();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(insertIntoFanslyTextarea).not.toHaveBeenCalled();
  });
});
