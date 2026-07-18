// Task 9 — the coach overlay chat render mode (keyed incremental renderer).
// These tests pin the renderer contract the way spec §3 describes it: a stable
// DOM node per feed item (keyed), a streaming update that mutates ONLY the
// pending answer's text node, composer focus/caret + feed scroll survival across
// renders, the Esc-while-streaming = cancel / Esc-while-idle = close split, draft
// cards whose acceptance carries the CARD's exchange operationId (not the live
// session op), failed-attempt Retry, recap steps that mutate in place, and the
// a11y roles. Prose must always render via textContent (never markdown/HTML).

import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../src/content/textarea.js', () => ({
  insertIntoFanslyTextarea: vi.fn(async () => undefined),
  copyToClipboard: vi.fn(async () => undefined),
  focusActiveConversationTextarea: vi.fn(() => null),
  getActiveConversationDraftText: vi.fn(() => ''),
}));

import { OverlayController } from '../src/content/overlay/overlay-controller.js';
import { installContentStyles } from '../src/content/dom-anchor.js';
import {
  copyToClipboard,
  insertIntoFanslyTextarea,
  getActiveConversationDraftText,
} from '../src/content/textarea.js';
import type {
  CoachOverlayFeedItem,
  CoachOverlaySessionView,
  OverlayViewModel,
} from '../src/shared/types.js';

type CoachModel = Extract<OverlayViewModel, { kind: 'coach' }>;

function createCoachModel(
  overrides?: Partial<CoachOverlaySessionView> & {
    operationId?: string | null;
    fanDisplayName?: string;
  },
): CoachModel {
  const {
    operationId = null,
    fanDisplayName = 'fan',
    ...sessionView
  } = overrides ?? {};
  return {
    kind: 'coach',
    fanDisplayName,
    operationId,
    sessionView: {
      feedItems: [],
      recapStatusLine: '',
      composerText: '',
      composerEnabled: true,
      sessionKey: 'acct|group',
      ...sessionView,
    },
  };
}

function exchangeItem(
  operationId: string,
  question: string,
  answerProse: string,
  drafts: Array<{ text: string; index: number }> = [],
): CoachOverlayFeedItem {
  return { kind: 'exchange', operationId, question, answerProse, drafts };
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing element for selector: ${selector}`);
  }
  return element as T;
}

const contentStyles = readFileSync(
  new URL('../src/content/styles.css', import.meta.url),
  'utf8',
);

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
  vi.stubGlobal('HTMLTextAreaElement', window.HTMLTextAreaElement);
  vi.stubGlobal('Text', window.Text);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('Event', window.Event);
  vi.stubGlobal('CustomEvent', window.CustomEvent);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
  vi.stubGlobal('KeyboardEvent', window.KeyboardEvent);
  return dom;
}

function makeController(overrides?: Partial<ConstructorParameters<typeof OverlayController>[0]>) {
  const callbacks = {
    onClose: vi.fn(),
    onCancel: vi.fn(),
    onRerun: vi.fn(),
    onCollapse: vi.fn(),
    onAcceptance: vi.fn(),
    onCoachSubmit: vi.fn(),
    onCoachNewDialog: vi.fn(),
    onCoachRecap: vi.fn(),
    onCoachRetry: vi.fn(),
    onCoachComposerInput: vi.fn(),
    ...overrides,
  };
  const controller = new OverlayController(callbacks);
  return { controller, callbacks };
}

describe('OverlayController — coach chat mode', () => {
  beforeEach(() => {
    installDom();
    // Clear leaked call history (restoreAllMocks does not reset vi.fn calls).
    vi.clearAllMocks();
    vi.mocked(getActiveConversationDraftText).mockReturnValue('');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the empty state with starter hints and a log-role feed when idle and empty', () => {
    const { controller } = makeController();
    controller.render(createCoachModel());

    const feed = requireElement<HTMLDivElement>('.chatgoose-coach-feed');
    expect(feed.getAttribute('role')).toBe('log');
    expect(document.querySelector('.chatgoose-coach-empty')).not.toBeNull();
    // Header eyebrow reflects the Coach surface.
    expect(requireElement<HTMLDivElement>('.chatgoose-eyebrow').textContent).toBe('Coach');
  });

  it('shows the recap status line and fires onCoachNewDialog from the header button', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel({ recapStatusLine: 'Full: 3d · Short: 10m' }));

    expect(requireElement<HTMLDivElement>('.chatgoose-coach-recap').textContent).toContain(
      'Full: 3d · Short: 10m',
    );

    const newDialog = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach button'),
    ).find((button) => /new dialog/i.test(button.textContent ?? ''));
    expect(newDialog).toBeDefined();
    newDialog!.click();
    expect(callbacks.onCoachNewDialog).toHaveBeenCalledOnce();
  });

  it('submits the composer on Enter and clears it, but not on Shift+Enter or while composing', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());

    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    textarea.value = 'how do I sell this?';

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    expect(callbacks.onCoachSubmit).not.toHaveBeenCalled();

    // isComposing must suppress the submit (IME).
    const composing = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    Object.defineProperty(composing, 'isComposing', { value: true });
    textarea.dispatchEvent(composing);
    expect(callbacks.onCoachSubmit).not.toHaveBeenCalled();

    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(callbacks.onCoachSubmit).toHaveBeenCalledWith('how do I sell this?');
    expect(textarea.value).toBe('');
  });

  it('reports composer edits through onCoachComposerInput', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());

    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    textarea.value = 'draft question';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    expect(callbacks.onCoachComposerInput).toHaveBeenCalledWith('draft question');
  });

  it('locks the composer and shows Cancel while a turn streams', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        operationId: 'op-stream',
        pendingQuestion: 'why is he cold?',
        pendingAnswerText: 'Because',
        composerEnabled: false,
      }),
    );

    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    expect(textarea.disabled).toBe(true);
    const cancel = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-composer button'),
    ).find((button) => !button.classList.contains('chatgoose-hidden') && /cancel|stop/i.test(button.textContent ?? ''));
    expect(cancel).toBeDefined();
    expect(requireElement<HTMLDivElement>('.chatgoose-coach-pending').getAttribute('aria-busy')).toBe('true');
  });

  it('mutates ONLY the pending answer text node during streaming (node identity + no childList churn)', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        operationId: 'op-1',
        pendingQuestion: 'q',
        pendingAnswerText: 'He',
        composerEnabled: false,
      }),
    );

    const pending = requireElement<HTMLDivElement>('.chatgoose-coach-pending');
    const answer = requireElement<HTMLDivElement>('.chatgoose-coach-pending .chatgoose-coach-answer');
    const textNode = answer.firstChild;
    expect(textNode?.nodeType).toBe(3);

    const feed = requireElement<HTMLDivElement>('.chatgoose-coach-feed');
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => records.push(...mutations));
    observer.observe(feed, { childList: true, subtree: true });

    controller.render(
      createCoachModel({
        operationId: 'op-1',
        pendingQuestion: 'q',
        pendingAnswerText: 'Hello there',
        composerEnabled: false,
      }),
    );
    observer.disconnect();

    expect(requireElement<HTMLDivElement>('.chatgoose-coach-pending')).toBe(pending);
    expect(requireElement<HTMLDivElement>('.chatgoose-coach-pending .chatgoose-coach-answer').firstChild).toBe(textNode);
    expect(answer.textContent).toBe('Hello there');
    expect(records).toHaveLength(0);
  });

  it('Esc while streaming cancels the turn and stays open; Esc while idle closes', () => {
    const { controller, callbacks } = makeController();

    controller.render(
      createCoachModel({
        operationId: 'op-esc',
        pendingQuestion: 'q',
        pendingAnswerText: 'partial',
        composerEnabled: false,
      }),
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(callbacks.onCancel).toHaveBeenCalledWith('op-esc');
    expect(callbacks.onClose).not.toHaveBeenCalled();

    controller.render(createCoachModel());
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(callbacks.onClose).toHaveBeenCalledOnce();
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps a stable DOM node per exchange as the feed grows (keyed rendering)', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({ feedItems: [exchangeItem('x1', 'q1', 'a1')] }),
    );

    const first = requireElement<HTMLDivElement>('.chatgoose-coach-items > *');

    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x1', 'q1', 'a1'), exchangeItem('x2', 'q2', 'a2')],
      }),
    );

    const items = document.querySelectorAll('.chatgoose-coach-items > *');
    expect(items).toHaveLength(2);
    expect(items[0]).toBe(first);
    expect(items[1]?.textContent).toContain('a2');
  });

  it('preserves composer focus and value across a re-render (no textarea rebuild)', () => {
    const { controller } = makeController();
    controller.render(createCoachModel());

    const textarea = requireElement<HTMLTextAreaElement>('.chatgoose-coach-input');
    textarea.focus();
    textarea.value = 'typing…';

    // A re-render driven by a recap-status change must not clobber the composer.
    controller.render(createCoachModel({ recapStatusLine: 'Full: 1d' }));

    expect(requireElement<HTMLTextAreaElement>('.chatgoose-coach-input')).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea.value).toBe('typing…');
  });

  it('preserves feed scroll position across renders when not near the bottom', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({ feedItems: [exchangeItem('x1', 'q1', 'a1')] }),
    );

    const feed = requireElement<HTMLDivElement>('.chatgoose-coach-feed');
    Object.defineProperty(feed, 'clientHeight', { configurable: true, get: () => 100 });
    Object.defineProperty(feed, 'scrollHeight', { configurable: true, get: () => 400 });
    feed.scrollTop = 40;

    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x1', 'q1', 'a1')],
        recapStatusLine: 'Full: 2d',
      }),
    );

    expect(feed.scrollTop).toBe(40);
  });

  it('renders coach prose via textContent so markdown/backticks never become HTML', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x1', 'q', 'Try **this** and `that`')],
      }),
    );

    const answer = requireElement<HTMLDivElement>('.chatgoose-coach-answer');
    expect(answer.querySelector('strong')).toBeNull();
    expect(answer.querySelector('code')).toBeNull();
    expect(answer.textContent).toBe('Try **this** and `that`');
  });

  it('draft Copy attributes acceptance to the CARD exchange operationId, not the live session op', async () => {
    const { controller, callbacks } = makeController();
    const mockCopy = vi.mocked(copyToClipboard);
    controller.render(
      createCoachModel({
        // idle: the live/top-level op is null — acceptance must still carry x-op.
        operationId: null,
        feedItems: [exchangeItem('x-op', 'q', 'advice', [{ text: 'Hey love', index: 0 }])],
      }),
    );

    const copy = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-draft .chatgoose-card-actions button'),
    ).find((button) => button.textContent === 'Copy');
    expect(copy).toBeDefined();
    copy!.click();

    await vi.waitFor(() => {
      expect(mockCopy).toHaveBeenCalledWith('Hey love');
    });
    expect(callbacks.onAcceptance).toHaveBeenCalledWith('x-op', 'copied', 0);
  });

  it('draft Insert into an empty Fansly composer inserts and attributes acceptance per-card', async () => {
    const { controller, callbacks } = makeController();
    vi.mocked(getActiveConversationDraftText).mockReturnValue('');
    const mockInsert = vi.mocked(insertIntoFanslyTextarea);
    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x-op', 'q', 'advice', [{ text: 'Draft body', index: 1 }])],
      }),
    );

    const insert = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-draft .chatgoose-card-actions button'),
    ).find((button) => /insert/i.test(button.textContent ?? ''));
    expect(insert).toBeDefined();
    insert!.click();

    await vi.waitFor(() => {
      expect(mockInsert).toHaveBeenCalledWith('Draft body');
    });
    expect(callbacks.onAcceptance).toHaveBeenCalledWith('x-op', 'inserted', 1);
  });

  it('draft Insert over a non-empty Fansly composer requires a two-step inline confirm', async () => {
    const { controller, callbacks } = makeController();
    vi.mocked(getActiveConversationDraftText).mockReturnValue('unsent draft');
    const mockInsert = vi.mocked(insertIntoFanslyTextarea);
    controller.render(
      createCoachModel({
        feedItems: [exchangeItem('x-op', 'q', 'advice', [{ text: 'Draft body', index: 0 }])],
      }),
    );

    const insert = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-draft .chatgoose-card-actions button'),
    ).find((button) => /replace/i.test(button.textContent ?? ''));
    expect(insert).toBeDefined();

    // First click ARMS the confirm — no insertion, no acceptance yet.
    insert!.click();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(callbacks.onAcceptance).not.toHaveBeenCalled();

    // Second click confirms.
    insert!.click();
    await vi.waitFor(() => {
      expect(mockInsert).toHaveBeenCalledWith('Draft body');
    });
    expect(callbacks.onAcceptance).toHaveBeenCalledWith('x-op', 'inserted', 0);
  });

  it('renders a failed-attempt with a Retry that replays the question; non-retryable omits Retry', () => {
    const { controller, callbacks } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [
          { kind: 'failed-attempt', question: 'stuck question', errorCode: 'CG-API-01', retryable: true },
        ],
      }),
    );

    const retry = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-failed button'),
    ).find((button) => /retry/i.test(button.textContent ?? ''));
    expect(retry).toBeDefined();
    retry!.click();
    expect(callbacks.onCoachRetry).toHaveBeenCalledWith('stuck question');

    controller.render(
      createCoachModel({
        feedItems: [
          { kind: 'failed-attempt', question: 'fatal', errorCode: 'CG-AUTH-01', retryable: false },
        ],
      }),
    );
    const noRetry = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach-failed button'),
    ).find((button) => /retry/i.test(button.textContent ?? ''));
    expect(noRetry).toBeUndefined();
  });

  it('updates a recap-step status in place without replacing its node', () => {
    const { controller } = makeController();
    controller.render(
      createCoachModel({
        feedItems: [{ kind: 'recap-step', mode: 'full', origin: 'explicit', status: 'running' }],
      }),
    );

    const step = requireElement<HTMLDivElement>('.chatgoose-coach-recap-step');
    expect(step.textContent).toMatch(/running|refresh/i);

    controller.render(
      createCoachModel({
        feedItems: [{ kind: 'recap-step', mode: 'full', origin: 'explicit', status: 'done' }],
      }),
    );

    expect(requireElement<HTMLDivElement>('.chatgoose-coach-recap-step')).toBe(step);
    expect(step.textContent).toMatch(/done|updated/i);
  });

  it('fires onCoachRecap from the header recap-refresh controls', () => {
    const { controller, callbacks } = makeController();
    controller.render(createCoachModel());

    const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.chatgoose-coach button'));
    const short = buttons.find((button) => /short/i.test(button.textContent ?? ''));
    const full = buttons.find((button) => /full/i.test(button.textContent ?? ''));
    expect(short).toBeDefined();
    expect(full).toBeDefined();
    short!.click();
    full!.click();
    expect(callbacks.onCoachRecap).toHaveBeenCalledWith('short');
    expect(callbacks.onCoachRecap).toHaveBeenCalledWith('full');
  });

  it('gives the coach panel its own scroll ownership (feed scrolls, panel does not)', () => {
    installContentStyles(contentStyles);
    const { controller } = makeController();
    controller.render(createCoachModel({ feedItems: [exchangeItem('x1', 'q', 'a')] }));

    const panel = requireElement<HTMLDivElement>('.chatgoose-overlay-panel');
    expect(panel.classList.contains('chatgoose-overlay-coach')).toBe(true);
    const feed = requireElement<HTMLDivElement>('.chatgoose-coach-feed');
    expect(window.getComputedStyle(feed).overflowY).toBe('auto');
  });
});
