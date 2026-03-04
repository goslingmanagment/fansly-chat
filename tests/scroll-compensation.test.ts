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

  it('does not adjust when height delta is zero', () => {
    const { root, container } = buildScrollableTree(280, {
      scrollHeight: 1000,
      clientHeight: 600,
      scrollTop: 400,
    });

    const snapshot = captureScrollSnapshot(root);

    // No height change
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
    stubLayout(root, { offsetHeight: 500 }); // large delta

    // scrollHeight is still 1000 in our stub, so maxScroll = 1000 - 600 = 400
    applyScrollCompensation(root, snapshot);
    expect(container.scrollTop).toBeLessThanOrEqual(1000 - 600);
  });

  it('finds scroll container that is a sibling (flex layout)', () => {
    // Simulates Fansly layout:
    //   flexParent
    //     ├── messageScroll  (overflow-y: auto, scrollable)
    //     └── inputParent
    //         └── root
    const flexParent = document.createElement('div');
    const messageScroll = document.createElement('div');
    messageScroll.style.overflowY = 'auto';
    stubLayout(messageScroll, {
      scrollHeight: 2000,
      clientHeight: 600,
      scrollTop: 1400, // at bottom: gap = 2000 - 1400 - 600 = 0
    });

    const inputParent = document.createElement('div');
    const root = document.createElement('div');
    stubLayout(root, { offsetHeight: 0 });

    inputParent.appendChild(root);
    flexParent.appendChild(messageScroll);
    flexParent.appendChild(inputParent);
    document.body.appendChild(flexParent);

    const snapshot = captureScrollSnapshot(root);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.container).toBe(messageScroll);

    // Panel appears
    stubLayout(root, { offsetHeight: 280 });
    stubLayout(messageScroll, { scrollHeight: 2000, clientHeight: 320 });

    applyScrollCompensation(root, snapshot);
    expect(messageScroll.scrollTop).toBe(1400 + 280);
  });
});
