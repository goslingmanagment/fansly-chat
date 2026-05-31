import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ConversationMountController } from '../src/content/conversation-mount-controller.js';
import type { ActiveConversationDom } from '../src/content/conversation-dom.js';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
}

function buildConversationDom(): ActiveConversationDom {
  const routeParent = document.createElement('div');
  const routeRoot = document.createElement('div');
  routeParent.appendChild(routeRoot);
  const container = document.createElement('div');
  const inputParent = document.createElement('div');
  const inputHost = document.createElement('div');
  inputParent.appendChild(inputHost);
  document.body.append(routeParent, container, inputParent);
  return { routeRoot, container, inputHost, inputParent, displayName: null };
}

describe('ConversationMountController', () => {
  beforeEach(() => {
    installDom();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // The controller schedules via window.setTimeout; point it at the faked
    // global timers so advanceTimersByTime drives it.
    (globalThis.window as unknown as { setTimeout: typeof setTimeout }).setTimeout =
      globalThis.setTimeout;
    (globalThis.window as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout =
      globalThis.clearTimeout;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps retrying past the attach deadline until the conversation reappears', () => {
    const root = document.createElement('div');
    let conversation: ActiveConversationDom | null = null;
    const controller = new ConversationMountController(root, () => conversation);

    controller.setActiveRoute('group-1');
    expect(root.isConnected).toBe(false);

    // Advance well past the 10s fast-attach window — the old behavior gave up
    // here, leaving no observer and no retry.
    vi.advanceTimersByTime(15_000);
    expect(root.isConnected).toBe(false);

    // The conversation subtree is (re)built after the deadline; the slow poll
    // must still pick it up and attach.
    conversation = buildConversationDom();
    vi.advanceTimersByTime(2_000);

    expect(root.parentElement).toBe(conversation.inputParent);
    expect(root.nextSibling).toBe(conversation.inputHost);

    controller.destroy();
  });
});
