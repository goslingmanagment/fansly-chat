import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import type {
  LlmSpendSummary,
  OverlayInsertPart,
  OverlayViewModel,
} from '../src/shared/types.js';

vi.mock('../src/content/textarea.js', () => ({
  insertIntoFanslyTextarea: vi.fn().mockResolvedValue(undefined),
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
  focusActiveConversationTextarea: vi.fn(),
}));

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
});
