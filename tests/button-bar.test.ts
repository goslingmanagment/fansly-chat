import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ButtonBar } from '../src/content/button-bar.js';
import { detectLabelPlatform, featureHotkeyLabel } from '../src/shared/hotkeys.js';
import type { TabUiState } from '../src/shared/types.js';

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLDivElement', window.HTMLDivElement);
  vi.stubGlobal('HTMLButtonElement', window.HTMLButtonElement);
  return dom;
}

function buildState(overrides: Partial<TabUiState> = {}): TabUiState {
  return {
    tabId: 1,
    accountId: 'account-1',
    groupId: 'group-1',
    hasAvailableSummary: false,
    connected: true,
    hasApiKey: true,
    hasPersonalities: true,
    mappedPersonalityId: 'personality-1',
    mappedPersonalityName: 'Closer',
    compareCardCount: 2,
    compareDraftCount: 1,
    ...overrides,
  };
}

// A feature button's label now leads its children with an inline hotkey <kbd>
// chip after it, so its textContent is e.g. 'ScanS'. Match on the label text
// node instead.
function labelOf(el: Element): string {
  return el.firstChild?.textContent ?? '';
}

describe('ButtonBar toolbar visibility', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps Compare out of the toolbar even when compare cards are available', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const compare = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Compare');

    expect(compare).toBeUndefined();
  });

  it('shows Scan in the toolbar', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const labels = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .map(labelOf);

    expect(labels).toContain('Scan');
  });

  it('renders a hotkey chip and tooltip on feature buttons with a bound key', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const platform = detectLabelPlatform();
    const replyHotkey = featureHotkeyLabel('fast-reply', platform)!;

    const buttons = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'));
    const reply = buttons.find((button) => labelOf(button) === 'Reply');
    const chip = reply?.querySelector('.chatgoose-kbd');
    // The chip is the bare letter on every platform — the shared ⌘⇧ / Alt+Shift
    // modifier would only crowd the bar. The full combo stays in the tooltip.
    expect(chip?.textContent).toBe(replyHotkey.short);
    expect(reply?.title).toContain(replyHotkey.full);
    // The chip is decorative; the shortcut reaches AT via aria-keyshortcuts and
    // the accessible name stays the clean label.
    expect(chip?.getAttribute('aria-hidden')).toBe('true');
    expect(reply?.getAttribute('aria-keyshortcuts')).toBe(
      `${platform === 'mac' ? 'Meta' : 'Alt'}+Shift+${replyHotkey.short}`,
    );

    // The Multi reply-mode toggle has no bound key — no chip, no keyshortcuts.
    const multi = buttons.find((button) => labelOf(button) === 'Multi');
    expect(multi?.querySelector('.chatgoose-kbd')).toBeNull();
    expect(multi?.getAttribute('aria-keyshortcuts')).toBeNull();
  });

  it('keeps the hotkey chip through the active loading spinner', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), 'fast-reply', 'default', 'none', true, true, false);

    const reply = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => labelOf(button) === 'Reply');
    expect(reply?.querySelector('.chatgoose-kbd')).not.toBeNull();
    expect(reply?.querySelector('.chatgoose-spinner')).not.toBeNull();
  });

  it('marks Scan when a ready summary is available', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState({ hasAvailableSummary: true }), null, 'default', 'none', true, false, false);

    const summary = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => labelOf(button) === 'Scan');

    expect(summary?.classList.contains('chatgoose-toolbar-button-summary-ready')).toBe(true);
    expect(summary?.title).toContain('Scan ready to open');
  });

  it('keeps Help, Review, and Compare out of the toolbar', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const labels = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .map(labelOf);

    expect(labels).not.toContain('Help');
    expect(labels).not.toContain('Review');
    expect(labels).not.toContain('Compare');
    expect(labels).not.toContain('Reopen');
  });
});

// Additional compare button behavior coverage remains skipped for now.
describe.skip('ButtonBar compare button', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('enables Compare when two compare cards are available even without a mapped personality', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState({
      hasPersonalities: false,
      mappedPersonalityId: null,
      mappedPersonalityName: null,
      compareCardCount: 2,
      compareDraftCount: 2,
    }), null, 'default', 'none', true, false, false);

    const buttons = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'));
    const reply = buttons.find((button) => labelOf(button) === 'Reply');
    const compare = buttons.find((button) => labelOf(button) === 'Compare');

    expect(reply?.disabled).toBe(true);
    expect(compare?.disabled).toBe(false);
  });

  it('disables Compare when fewer than two compare cards are available', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState({
      compareCardCount: 1,
      compareDraftCount: 1,
    }), null, 'default', 'none', true, false, false);

    const compare = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Compare');

    expect(compare?.disabled).toBe(true);
  });

  it('hides Reopen when there is no completed compare cache to restore', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const reopen = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Reopen');

    expect(reopen?.classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('shows enabled Reopen when a completed compare can be restored even without connection or API key', () => {
    const restoreSpy = vi.fn();
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: restoreSpy,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState({
      connected: false,
      hasApiKey: false,
    }), null, 'default', 'none', true, false, true);

    const buttons = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'));
    const compare = buttons.find((button) => button.textContent === 'Compare');
    const reopen = buttons.find((button) => button.textContent === 'Reopen');

    expect(compare?.disabled).toBe(true);
    expect(reopen?.classList.contains('chatgoose-hidden')).toBe(false);
    expect(reopen?.disabled).toBe(false);

    reopen?.click();
    expect(restoreSpy).toHaveBeenCalledTimes(1);
  });
});

describe('ButtonBar tone menu', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders a Reply tone caret and a four-item tone menu', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const caret = bar.root.querySelector('.chatgoose-reply-caret');
    expect(caret?.getAttribute('aria-haspopup')).toBe('menu');

    const items = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('.chatgoose-tone-menu-item'));
    expect(items.map((item) => item.textContent)).toEqual(['Casual', 'Flirty', 'Upsell', 'Horny']);
  });

  it('marks the armed tone in the menu', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'flirty', true, false, false);

    const items = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('.chatgoose-tone-menu-item'));
    const flirty = items.find((item) => item.textContent === 'Flirty');
    const horny = items.find((item) => item.textContent === 'Horny');

    expect(flirty?.classList.contains('chatgoose-tone-menu-item-active')).toBe(true);
    expect(flirty?.getAttribute('aria-checked')).toBe('true');
    expect(horny?.classList.contains('chatgoose-tone-menu-item-active')).toBe(false);
    expect(horny?.getAttribute('aria-checked')).toBe('false');
  });

  it('disables the tone caret during an active operation', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), 'fast-reply', 'default', 'none', true, true, false);

    const caret = bar.root.querySelector<HTMLButtonElement>('.chatgoose-reply-caret');
    expect(caret?.disabled).toBe(true);
  });

  it('disables the tone caret when not connected', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState({ connected: false }), null, 'default', 'none', true, false, false);

    const caret = bar.root.querySelector<HTMLButtonElement>('.chatgoose-reply-caret');
    expect(caret?.disabled).toBe(true);
  });

  it('enables the tone caret when connected, keyed and mapped', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const caret = bar.root.querySelector<HTMLButtonElement>('.chatgoose-reply-caret');
    expect(caret?.disabled).toBe(false);
  });

  it('opens on caret click, generates the chosen tone, then closes', () => {
    const toneSpy = vi.fn();
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: toneSpy,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const caret = bar.root.querySelector<HTMLButtonElement>('.chatgoose-reply-caret')!;
    const menu = bar.root.querySelector('.chatgoose-tone-menu')!;
    expect(menu.classList.contains('chatgoose-hidden')).toBe(true);

    caret.click();
    expect(menu.classList.contains('chatgoose-hidden')).toBe(false);
    expect(caret.getAttribute('aria-expanded')).toBe('true');

    const items = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('.chatgoose-tone-menu-item'));
    const flirty = items.find((item) => item.textContent === 'Flirty');
    flirty?.click();

    expect(toneSpy).toHaveBeenCalledWith('flirty');
    expect(menu.classList.contains('chatgoose-hidden')).toBe(true);
  });
});

describe('ButtonBar improve draft state', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('disables Polish when the composer draft is empty', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', false, false, false);

    const improve = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => labelOf(button) === 'Polish');

    expect(improve?.disabled).toBe(true);
  });

  it('renders Multi, then Polish, then Scan before the personality pill', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const children = Array.from(bar.root.children);
    const multiIndex = children.findIndex((child) => labelOf(child) === 'Multi');
    const polishIndex = children.findIndex((child) => labelOf(child) === 'Polish');
    const pingIndex = children.findIndex((child) => labelOf(child) === 'Ping');
    const summaryIndex = children.findIndex((child) => labelOf(child) === 'Scan');
    const personalityIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-personality-end'),
    );

    expect(multiIndex).toBeGreaterThan(-1);
    expect(polishIndex).toBeGreaterThan(-1);
    expect(pingIndex).toBeGreaterThan(-1);
    expect(summaryIndex).toBeGreaterThan(-1);
    expect(personalityIndex).toBeGreaterThan(-1);
    expect(polishIndex).toBe(multiIndex + 1);
    expect(summaryIndex).toBe(pingIndex + 1);
    expect(summaryIndex).toBe(personalityIndex - 1);
  });
});
