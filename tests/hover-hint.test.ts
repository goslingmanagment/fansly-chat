import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { HoverHintController } from '../src/content/ui/hover-hint.js';

let dom: InstanceType<typeof JSDOM>;

function installDom() {
  dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  return dom;
}

/** jsdom has no layout, so every anchor gets the rect its test needs. */
function placeAt(element: HTMLElement, rect: Partial<DOMRect>): void {
  const full = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, ...rect };
  element.getBoundingClientRect = () =>
    ({ ...full, toJSON: () => full }) as DOMRect;
}

function makeAnchor(id: string, rect: Partial<DOMRect>): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.id = id;
  placeAt(button, rect);
  return button;
}

function hover(container: HTMLElement, x: number, y: number): void {
  const event = new dom.window.MouseEvent('pointermove', { clientX: x, clientY: y });
  container.dispatchEvent(event);
}

function layer(): HTMLElement | null {
  return document.querySelector('.chatgoose-hint');
}

function visibleText(): { title: string; body: string } | null {
  const node = layer();
  if (!node || node.classList.contains('chatgoose-hidden')) {
    return null;
  }
  return {
    title: node.querySelector('.chatgoose-hint-title')?.textContent ?? '',
    body: node.querySelector('.chatgoose-hint-body')?.textContent ?? '',
  };
}

describe('HoverHintController', () => {
  let container: HTMLElement;
  let first: HTMLButtonElement;
  let second: HTMLButtonElement;
  let hints: HoverHintController;

  beforeEach(() => {
    vi.useFakeTimers();
    installDom();
    container = document.createElement('div');
    document.body.append(container);
    // Two 30×30 cells, side by side, 200px down the page.
    first = makeAnchor('first', { left: 0, right: 30, top: 200, bottom: 230, width: 30, height: 30 });
    second = makeAnchor('second', { left: 40, right: 70, top: 200, bottom: 230, width: 30, height: 30 });
    container.append(first, second);
    hints = new HoverHintController();
    hints.register(first, () => ({ title: 'Reply', body: 'Ответ на переписку' }));
    hints.register(second, () => ({ title: 'Fix', body: 'Переписывает черновик' }));
    hints.attach(container);
  });

  afterEach(() => {
    hints.destroy();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('needs a full second of holding still before the first hint appears', () => {
    hover(container, 10, 210);
    expect(visibleText()).toBeNull();

    vi.advanceTimersByTime(999);
    expect(visibleText()).toBeNull();

    vi.advanceTimersByTime(1);
    expect(visibleText()).toEqual({ title: 'Reply', body: 'Ответ на переписку' });
  });

  it('does not fire for a pointer merely crossing the row', () => {
    // The way to Reply passes over its neighbours; none of them may speak.
    hover(container, 10, 210);
    vi.advanceTimersByTime(120);
    hover(container, 50, 210);
    vi.advanceTimersByTime(120);
    hover(container, 500, 500);
    vi.advanceTimersByTime(2000);
    expect(visibleText()).toBeNull();
  });

  it('re-arms on a shorter dwell while a hint is open', () => {
    hover(container, 10, 210);
    vi.advanceTimersByTime(1000);
    expect(visibleText()?.title).toBe('Reply');

    hover(container, 50, 210);
    // Not instant — a sweep past the neighbour must not flash its hint…
    expect(visibleText()?.title).toBe('Reply');
    vi.advanceTimersByTime(250);
    // …but deliberately comparing two controls stays quick.
    expect(visibleText()?.title).toBe('Fix');
  });

  it('restores the full dwell once the group grace has lapsed', () => {
    hover(container, 10, 210);
    vi.advanceTimersByTime(1000);
    hover(container, 500, 500); // off every anchor — hides
    expect(visibleText()).toBeNull();

    vi.advanceTimersByTime(300); // grace over
    hover(container, 50, 210);
    vi.advanceTimersByTime(250);
    expect(visibleText()).toBeNull();
    vi.advanceTimersByTime(750);
    expect(visibleText()?.title).toBe('Fix');
  });

  it('hides on pointer leave, on Escape and on scroll', () => {
    const open = () => {
      hover(container, 10, 210);
      vi.advanceTimersByTime(1000);
    };

    open();
    container.dispatchEvent(new dom.window.Event('pointerleave'));
    expect(visibleText()).toBeNull();

    vi.advanceTimersByTime(300);
    open();
    document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    expect(visibleText()).toBeNull();

    vi.advanceTimersByTime(300);
    open();
    window.dispatchEvent(new dom.window.Event('scroll'));
    expect(visibleText()).toBeNull();
  });

  it('opens above the anchor, and flips below only when there is no room', () => {
    hover(container, 10, 210);
    vi.advanceTimersByTime(1000);
    expect(layer()?.classList.contains('chatgoose-hint-below')).toBe(false);

    hints.hide();
    // An anchor hugging the top edge cannot host a bubble above it.
    placeAt(first, { left: 0, right: 30, top: 2, bottom: 32, width: 30, height: 30 });
    hover(container, 10, 10);
    vi.advanceTimersByTime(1000);
    expect(layer()?.classList.contains('chatgoose-hint-below')).toBe(true);
  });

  it('describes the control it is open for, and stops when it closes', () => {
    hover(container, 10, 210);
    vi.advanceTimersByTime(1000);
    const layerId = layer()?.id;
    expect(layerId).toBeTruthy();
    expect(first.getAttribute('aria-describedby')).toBe(layerId);

    hints.hide();
    expect(first.hasAttribute('aria-describedby')).toBe(false);
  });

  it('skips anchors that are hidden or unrendered', () => {
    first.classList.add('chatgoose-hidden');
    hover(container, 10, 210);
    vi.advanceTimersByTime(1000);
    expect(visibleText()).toBeNull();
  });

  it('shows a focused control at once — focus is already deliberate', () => {
    second.dispatchEvent(new dom.window.Event('focus'));
    expect(visibleText()?.title).toBe('Fix');

    second.dispatchEvent(new dom.window.Event('blur'));
    expect(visibleText()).toBeNull();
  });

  it('stays silent while disabled and starts with the full dwell when re-enabled', () => {
    hints.setEnabled(false);

    hover(container, 10, 210);
    vi.advanceTimersByTime(2000);
    first.dispatchEvent(new dom.window.Event('focus'));
    expect(visibleText()).toBeNull();

    hints.setEnabled(true);
    hover(container, 10, 210);
    vi.advanceTimersByTime(999);
    expect(visibleText()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(visibleText()?.title).toBe('Reply');
  });

  it('closes an open hint and cancels a pending dwell as soon as it is disabled', () => {
    hover(container, 10, 210);
    vi.advanceTimersByTime(500);
    hints.setEnabled(false);
    vi.advanceTimersByTime(1000);
    expect(visibleText()).toBeNull();

    hints.setEnabled(true);
    hover(container, 10, 210);
    vi.advanceTimersByTime(1000);
    expect(visibleText()?.title).toBe('Reply');
    expect(first.hasAttribute('aria-describedby')).toBe(true);

    hints.setEnabled(false);
    expect(visibleText()).toBeNull();
    expect(first.hasAttribute('aria-describedby')).toBe(false);
  });

  it('leaves no layer behind and goes quiet after destroy', () => {
    hover(container, 10, 210);
    vi.advanceTimersByTime(1000);
    expect(layer()).not.toBeNull();

    hints.destroy();
    expect(layer()).toBeNull();

    hover(container, 10, 210);
    vi.advanceTimersByTime(1000);
    expect(layer()).toBeNull();
  });
});
