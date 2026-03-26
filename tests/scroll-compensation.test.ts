import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://fansly.com/messages/example',
  });
  const { window } = dom;

  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window));

  return { dom, window };
}

/**
 * JSDOM doesn't implement layout, so offsetHeight / scrollHeight / clientHeight
 * are always 0.  We work around this by injecting property descriptors onto the
 * concrete elements used in each test.
 */
function stubLayout(
  el: HTMLElement,
  dims: { offsetHeight?: number; scrollHeight?: number; scrollTop?: number; clientHeight?: number },
) {
  if (dims.offsetHeight !== undefined) {
    Object.defineProperty(el, 'offsetHeight', { value: dims.offsetHeight, configurable: true });
  }
  if (dims.scrollHeight !== undefined) {
    Object.defineProperty(el, 'scrollHeight', { value: dims.scrollHeight, configurable: true });
  }
  if (dims.clientHeight !== undefined) {
    Object.defineProperty(el, 'clientHeight', { value: dims.clientHeight, configurable: true });
  }
  if (dims.scrollTop !== undefined) {
    Object.defineProperty(el, 'scrollTop', { value: dims.scrollTop, writable: true, configurable: true });
  }
}

describe('scroll-compensation', () => {
  let captureScrollSnapshot: typeof import('../src/content/scroll-compensation.js').captureScrollSnapshot;
  let applyScrollCompensation: typeof import('../src/content/scroll-compensation.js').applyScrollCompensation;

  beforeEach(async () => {
    installDom();
    const mod = await import('../src/content/scroll-compensation.js');
    captureScrollSnapshot = mod.captureScrollSnapshot;
    applyScrollCompensation = mod.applyScrollCompensation;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function buildScrollableTree(rootHeight: number, containerDims: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
    const container = document.createElement('div');
    // getComputedStyle returns '' for overflow-y by default in JSDOM,
    // so we set it via the style property.
    container.style.overflowY = 'auto';
    stubLayout(container, containerDims);

    const root = document.createElement('div');
    stubLayout(root, { offsetHeight: rootHeight });

    container.appendChild(root);
    document.body.appendChild(container);
    return { root, container };
  }

  it('adjusts scrollTop when near bottom and height delta is positive', () => {
    const { root, container } = buildScrollableTree(0, {
      scrollHeight: 1000,
      clientHeight: 600,
      scrollTop: 400, // gap = 1000 - 400 - 600 = 0 (at bottom)
    });

    const snapshot = captureScrollSnapshot(root);
    expect(snapshot).not.toBeNull();

    // Simulate panel appearing (height goes from 0 to 280)
    // Container scrollHeight also increases by the same delta
    stubLayout(root, { offsetHeight: 280 });
    stubLayout(container, { scrollHeight: 1280, clientHeight: 600 });

    applyScrollCompensation(root, snapshot);
    expect(container.scrollTop).toBe(400 + 280);
  });

  it('does not adjust scrollTop when far from bottom', () => {
    const { root, container } = buildScrollableTree(0, {
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 200, // gap = 2000 - 200 - 600 = 1200 (far from bottom)
    });

    const snapshot = captureScrollSnapshot(root);

    stubLayout(root, { offsetHeight: 280 });
    applyScrollCompensation(root, snapshot);
    expect(container.scrollTop).toBe(200); // unchanged
  });

  it('does not adjust scrollTop during streaming updates when height delta is ~0', () => {
    const { root, container } = buildScrollableTree(280, {
      scrollHeight: 1000,
      clientHeight: 600,
      scrollTop: 400,
    });

    const snapshot = captureScrollSnapshot(root);

    // Streaming text update keeps the panel height effectively unchanged.
    applyScrollCompensation(root, snapshot);
    expect(container.scrollTop).toBe(400);
  });

  it('does not adjust when height delta is negative', () => {
    const { root, container } = buildScrollableTree(280, {
      scrollHeight: 1000,
      clientHeight: 600,
      scrollTop: 400,
    });

    const snapshot = captureScrollSnapshot(root);

    stubLayout(root, { offsetHeight: 100 }); // shrunk
    applyScrollCompensation(root, snapshot);
    expect(container.scrollTop).toBe(400);
  });

  it('returns null snapshot when root is disconnected', () => {
    const root = document.createElement('div'); // not in DOM
    const snapshot = captureScrollSnapshot(root);
    expect(snapshot).toBeNull();
  });

  it('no-ops when snapshot is null', () => {
    const root = document.createElement('div');
    // Should not throw
    applyScrollCompensation(root, null);
  });

  it('adjusts when within the 96px threshold', () => {
    const { root, container } = buildScrollableTree(0, {
      scrollHeight: 1000,
      clientHeight: 600,
      scrollTop: 310, // gap = 1000 - 310 - 600 = 90 (within 96)
    });

    const snapshot = captureScrollSnapshot(root);
    stubLayout(root, { offsetHeight: 200 });
    stubLayout(container, { scrollHeight: 1200, clientHeight: 600 });
    applyScrollCompensation(root, snapshot);
    expect(container.scrollTop).toBe(310 + 200);
  });

  it('does not adjust when just outside the 96px threshold', () => {
    const { root, container } = buildScrollableTree(0, {
      scrollHeight: 1000,
      clientHeight: 600,
      scrollTop: 303, // gap = 1000 - 303 - 600 = 97 (just outside 96)
    });

    const snapshot = captureScrollSnapshot(root);
    stubLayout(root, { offsetHeight: 200 });
    applyScrollCompensation(root, snapshot);
    expect(container.scrollTop).toBe(303); // unchanged
  });

  it('clamps scrollTop to maxScroll', () => {
    const { root, container } = buildScrollableTree(0, {
      scrollHeight: 1000,
      clientHeight: 600,
      scrollTop: 400, // at bottom
    });

    const snapshot = captureScrollSnapshot(root);

    // Simulate external scroll between capture and apply (browser transient state),
    // then a small maxScroll increase.  scrollTop + delta would overshoot maxScrollAfter.
    container.scrollTop = 450;
    stubLayout(container, { scrollHeight: 1050, clientHeight: 600 });
    // maxScrollAfter = 1050 - 600 = 450, delta = 450 - 400 = 50
    // scrollTop + delta = 450 + 50 = 500 > 450  → clamped to 450

    applyScrollCompensation(root, snapshot);
    expect(container.scrollTop).toBeLessThanOrEqual(1050 - 600);
  });

  it('finds and adjusts sibling message scroll container', () => {
    // Simulates Fansly layout:
    //   layoutRoot
    //     ├── messagesBranch
    //     │    └── wrapper
    //     │         └── messageScroll (overflow-y: auto, scrollable)
    //     └── composerBranch
    //          └── inputParent
    //         └── root
    const layoutRoot = document.createElement('div');
    const messagesBranch = document.createElement('section');
    const wrapper = document.createElement('div');
    const messageScroll = document.createElement('div');
    messageScroll.style.overflowY = 'auto';
    stubLayout(messageScroll, {
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 1400, // at bottom: gap = 2000 - 1400 - 600 = 0
    });

    wrapper.appendChild(messageScroll);
    messagesBranch.appendChild(wrapper);

    const composerBranch = document.createElement('section');
    const inputParent = document.createElement('div');
    const root = document.createElement('div');
    stubLayout(root, { offsetHeight: 0 });

    inputParent.appendChild(root);
    composerBranch.appendChild(inputParent);
    layoutRoot.append(messagesBranch, composerBranch);
    document.body.appendChild(layoutRoot);

    const snapshot = captureScrollSnapshot(root);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.container).toBe(messageScroll);

    // Panel appears
    stubLayout(root, { offsetHeight: 280 });
    stubLayout(messageScroll, { scrollHeight: 2000, clientHeight: 320 });

    applyScrollCompensation(root, snapshot);
    expect(messageScroll.scrollTop).toBe(1400 + 280);
  });

  it('finds scroll container that is a direct sibling of root', () => {
    // Fansly layout where #chatgoose-root is inserted as a sibling of the
    // message scroll pane inside the same parent:
    //   parent
    //     ├── messageScroll (overflow-y: auto, scrollable)
    //     ├── root
    //     └── inputHost
    const parent = document.createElement('div');
    const messageScroll = document.createElement('div');
    messageScroll.style.overflowY = 'auto';
    stubLayout(messageScroll, {
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 1400, // at bottom: gap = 2000 - 1400 - 600 = 0
    });

    const root = document.createElement('div');
    stubLayout(root, { offsetHeight: 0 });

    const inputHost = document.createElement('div');

    parent.append(messageScroll, root, inputHost);
    document.body.appendChild(parent);

    const snapshot = captureScrollSnapshot(root);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.container).toBe(messageScroll);

    // Panel appears (root grows from 0 to 280px)
    stubLayout(root, { offsetHeight: 280 });
    stubLayout(messageScroll, { scrollHeight: 2000, clientHeight: 320 });

    applyScrollCompensation(root, snapshot);
    expect(messageScroll.scrollTop).toBe(1400 + 280);
  });

  it('discovers container with overflow-y but no current overflow (short conversation)', () => {
    // The message container has overflow-y: auto but scrollHeight <= clientHeight
    // (few messages, nothing to scroll).  The panel appearing later will shrink
    // clientHeight via flex, creating overflow for the first time.
    const parent = document.createElement('div');
    const messageScroll = document.createElement('div');
    messageScroll.style.overflowY = 'auto';
    // No overflow: scrollHeight == clientHeight → scrollGap = 0
    stubLayout(messageScroll, {
      scrollHeight: 400,
      clientHeight: 400,
      scrollTop: 0,
    });

    const root = document.createElement('div');
    stubLayout(root, { offsetHeight: 0 });

    parent.append(messageScroll, root);
    document.body.appendChild(parent);

    // Container should still be found via the potential-container pass
    const snapshot = captureScrollSnapshot(root);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.container).toBe(messageScroll);

    // Panel appears → flex shrinks messageScroll, creating overflow
    stubLayout(messageScroll, {
      scrollHeight: 400,
      clientHeight: 200,
      scrollTop: 0,
    });

    applyScrollCompensation(root, snapshot);
    // maxScrollBefore = 400 - 400 = 0, maxScrollAfter = 400 - 200 = 200
    // delta = 200, scrollTop = min(0 + 200, 200) = 200
    expect(messageScroll.scrollTop).toBe(200);
  });

  it('recovers from fallback cache when real container appears', () => {
    // First call: no scroll container in the DOM yet → returns null or
    // document.scrollingElement fallback.  Either way, the fallback is NOT
    // cached, so the next call should re-discover the real container once
    // it's rendered.
    const root = document.createElement('div');
    stubLayout(root, { offsetHeight: 0 });
    document.body.appendChild(root);

    // Warm the cache with a miss / fallback
    captureScrollSnapshot(root);

    // Angular finishes rendering — real scroll container appears as sibling
    const messageScroll = document.createElement('div');
    messageScroll.style.overflowY = 'auto';
    stubLayout(messageScroll, {
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 1400,
    });
    root.parentElement!.insertBefore(messageScroll, root);

    const snap2 = captureScrollSnapshot(root);
    expect(snap2).not.toBeNull();
    expect(snap2!.container).toBe(messageScroll);
  });

  it('finds sibling scroll container when messages branch is after composer branch', () => {
    const layoutRoot = document.createElement('div');
    const composerBranch = document.createElement('section');
    const inputParent = document.createElement('div');
    const root = document.createElement('div');
    stubLayout(root, { offsetHeight: 0 });
    inputParent.appendChild(root);
    composerBranch.appendChild(inputParent);

    const messagesBranch = document.createElement('section');
    const wrapper = document.createElement('div');
    const messageScroll = document.createElement('div');
    messageScroll.style.overflowY = 'auto';
    stubLayout(messageScroll, {
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 1400,
    });
    wrapper.appendChild(messageScroll);
    messagesBranch.appendChild(wrapper);

    layoutRoot.append(composerBranch, messagesBranch);
    document.body.appendChild(layoutRoot);

    const snapshot = captureScrollSnapshot(root);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.container).toBe(messageScroll);
  });

  it('uses root height delta as fallback when container layout is unchanged', () => {
    // Simulates separate DOM branches: panel appears but container dims don't change.
    const parent = document.createElement('div');
    const messageScroll = document.createElement('div');
    messageScroll.style.overflowY = 'auto';
    stubLayout(messageScroll, {
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2310, // bottomGap = 3000 - 2310 - 600 = 90 (within threshold)
    });

    const root = document.createElement('div');
    stubLayout(root, { offsetHeight: 0 });

    parent.append(messageScroll, root);
    document.body.appendChild(parent);

    const snapshot = captureScrollSnapshot(root);

    // Panel appears but container dimensions are unchanged (separate branches).
    stubLayout(root, { offsetHeight: 280 });
    // messageScroll scrollHeight and clientHeight stay the same.

    applyScrollCompensation(root, snapshot);
    // containerDelta = 0, rootDelta = 280
    // maxScrollAfter = 2400, scrollTop = min(2310 + 280, 2400) = 2400
    expect(messageScroll.scrollTop).toBe(2400);
  });

  it('prefers nearby potential container over distant scrollable on early init', () => {
    // Bug: early init where the correct container (sibling of root) has
    // scrollGap=0 because messages haven't loaded, but a distant sidebar
    // element IS scrollable.  The old sequential two-pass approach would
    // find the sidebar in Pass 1 and never run Pass 2.
    //
    //   grandparent
    //     +-- sidebarBranch
    //     |     +-- sidebar (overflow-y: auto, scrollGap: 909)
    //     +-- mainBranch
    //           +-- messageScroll (overflow-y: auto, scrollGap: 0)
    //           +-- root
    const grandparent = document.createElement('div');

    const sidebarBranch = document.createElement('div');
    const sidebar = document.createElement('div');
    sidebar.style.overflowY = 'auto';
    stubLayout(sidebar, {
      scrollHeight: 1509,
      clientHeight: 600,
      scrollTop: 0,
    }); // scrollGap = 909

    sidebarBranch.appendChild(sidebar);

    const mainBranch = document.createElement('div');
    const messageScroll = document.createElement('div');
    messageScroll.style.overflowY = 'auto';
    stubLayout(messageScroll, {
      scrollHeight: 400,
      clientHeight: 400,
      scrollTop: 0,
    }); // scrollGap = 0 (messages not loaded yet)

    const root = document.createElement('div');
    stubLayout(root, { offsetHeight: 0 });

    mainBranch.append(messageScroll, root);
    grandparent.append(sidebarBranch, mainBranch);
    document.body.appendChild(grandparent);

    // First call: should find messageScroll (nearby) NOT sidebar (distant)
    const snapshot = captureScrollSnapshot(root);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.container).toBe(messageScroll);

    // Messages load — messageScroll now has scrollGap > 0.
    // Cache from first call should not have been poisoned.
    stubLayout(messageScroll, {
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 1400,
    });

    const snapshot2 = captureScrollSnapshot(root);
    expect(snapshot2).not.toBeNull();
    expect(snapshot2!.container).toBe(messageScroll);
  });

  it('does not use root height fallback when root height is unchanged', () => {
    const parent = document.createElement('div');
    const messageScroll = document.createElement('div');
    messageScroll.style.overflowY = 'auto';
    stubLayout(messageScroll, {
      scrollHeight: 3000,
      clientHeight: 600,
      scrollTop: 2310, // bottomGap = 90 (within threshold)
    });

    const root = document.createElement('div');
    stubLayout(root, { offsetHeight: 280 }); // already at full height

    parent.append(messageScroll, root);
    document.body.appendChild(parent);

    const snapshot = captureScrollSnapshot(root);

    // Neither container nor root changes
    applyScrollCompensation(root, snapshot);
    expect(messageScroll.scrollTop).toBe(2310); // unchanged
  });
});
