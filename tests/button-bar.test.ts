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

function labelOf(el: Element): string {
  return el.firstChild?.textContent ?? '';
}

function buttonByLabel(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => labelOf(button) === label,
  );
}

function multiToggle(root: ParentNode): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>('.chatgoose-toolbar-toggle');
}

function tonePills(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.chatgoose-tone-pill'));
}

function tonePill(root: ParentNode, label: string): HTMLButtonElement | undefined {
  return tonePills(root).find((pill) => pill.textContent === label);
}

const noop = () => undefined;
function makeBar(overrides: Partial<ConstructorParameters<typeof ButtonBar>[0]> = {}) {
  return new ButtonBar({
    onFeatureClick: noop,
    onCompareClick: noop,
    onCompareRestoreClick: noop,
    onReplyModeToggle: noop,
    onToneSelect: noop,
    ...overrides,
  });
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
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const compare = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Compare');

    expect(compare).toBeUndefined();
  });

  it('renders Scan as a row button (no overflow ⋯ menu)', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    expect(buttonByLabel(bar.root, 'Scan')).toBeDefined();
    expect(bar.root.querySelector('.chatgoose-more')).toBeNull();
    expect(bar.root.querySelector('.chatgoose-more-menu')).toBeNull();
  });

  it('renders hover-only hotkey chips while exposing shortcut metadata', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const platform = detectLabelPlatform();
    const replyHotkey = featureHotkeyLabel('fast-reply', platform)!;
    const scanHotkey = featureHotkeyLabel('fan-summary', platform)!;

    const reply = buttonByLabel(bar.root, 'Reply');
    const replyChip = reply?.querySelector('.chatgoose-toolbar-hotkey');
    expect(replyChip?.textContent).toBe(replyHotkey.short);
    expect(replyChip?.getAttribute('aria-hidden')).toBe('true');
    expect(reply?.title).toContain(replyHotkey.full);
    expect(reply?.getAttribute('aria-keyshortcuts')).toBe(
      `${platform === 'mac' ? 'Meta' : 'Alt'}+Shift+${replyHotkey.short}`,
    );

    const scan = buttonByLabel(bar.root, 'Scan');
    const scanChip = scan?.querySelector('.chatgoose-toolbar-hotkey');
    expect(scanChip?.textContent).toBe(scanHotkey.short);
    expect(scanChip?.getAttribute('aria-hidden')).toBe('true');
    expect(scan?.title).toContain(scanHotkey.full);
    expect(scan?.getAttribute('aria-keyshortcuts')).toBe(
      `${platform === 'mac' ? 'Meta' : 'Alt'}+Shift+${scanHotkey.short}`,
    );

    // The Multi reply-mode toggle is a labelled pill with no bound key — no chip,
    // no keyshortcuts.
    const multi = multiToggle(bar.root);
    expect(multi?.textContent).toBe('Multi');
    expect(multi?.querySelector('.chatgoose-kbd')).toBeNull();
    expect(multi?.getAttribute('aria-keyshortcuts')).toBeNull();
  });

  it('keeps the hover-only hotkey through the active loading spinner', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), 'fast-reply', 'default', 'none', true, true, false);

    const reply = buttonByLabel(bar.root, 'Reply');
    expect(reply?.querySelector('.chatgoose-toolbar-hotkey')).not.toBeNull();
    expect(reply?.querySelector('.chatgoose-spinner')).not.toBeNull();
    expect(reply?.classList.contains('chatgoose-toolbar-button-loading')).toBe(true);

    bar.render(buildState(), null, 'default', 'none', true, false, false);
    expect(reply?.querySelector('.chatgoose-spinner')).toBeNull();
    expect(reply?.classList.contains('chatgoose-toolbar-button-loading')).toBe(false);
  });

  it('marks a ready summary on the Scan button', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState({ hasAvailableSummary: true }), null, 'default', 'none', true, false, false);

    const scan = buttonByLabel(bar.root, 'Scan');
    expect(scan?.classList.contains('chatgoose-toolbar-button-summary-ready')).toBe(true);
    expect(scan?.title).toContain('Scan ready to open');
  });

  it('keeps Help, Review, and Compare out of the toolbar', () => {
    const bar = makeBar();
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
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState({
      hasPersonalities: false,
      mappedPersonalityId: null,
      mappedPersonalityName: null,
      compareCardCount: 2,
      compareDraftCount: 2,
    }), null, 'default', 'none', true, false, false);

    const reply = buttonByLabel(bar.root, 'Reply');
    const compare = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Compare');

    expect(reply?.disabled).toBe(true);
    expect(compare?.disabled).toBe(false);
  });

  it('disables Compare when fewer than two compare cards are available', () => {
    const bar = makeBar();
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
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const reopen = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent === 'Reopen');

    expect(reopen?.classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('shows enabled Reopen when a completed compare can be restored even without connection or API key', () => {
    const restoreSpy = vi.fn();
    const bar = makeBar({ onCompareRestoreClick: restoreSpy });
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

describe('ButtonBar tone pills', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders the three tone pills', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    expect(tonePills(bar.root).map((pill) => pill.textContent)).toEqual([
      'Flirty',
      'Upsell',
      'Horny',
    ]);
  });

  it('marks the armed tone pill active', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'flirty', true, false, false);

    const flirty = tonePill(bar.root, 'Flirty');
    const horny = tonePill(bar.root, 'Horny');

    expect(flirty?.classList.contains('chatgoose-tone-pill-active')).toBe(true);
    expect(flirty?.getAttribute('aria-pressed')).toBe('true');
    expect(horny?.classList.contains('chatgoose-tone-pill-active')).toBe(false);
    expect(horny?.getAttribute('aria-pressed')).toBe('false');
  });

  it('clicking a tone pill fires onToneSelect with that tone (one click = one generation)', () => {
    const toneSpy = vi.fn();
    const bar = makeBar({ onToneSelect: toneSpy });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    tonePill(bar.root, 'Upsell')?.click();
    expect(toneSpy).toHaveBeenCalledWith('upsell');
  });

  it('disables the tone pills during an active operation', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), 'fast-reply', 'default', 'none', true, true, false);

    expect(tonePills(bar.root).every((pill) => pill.disabled)).toBe(true);
  });

  it('disables the tone pills when connected and keyed but unmapped', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(
      buildState({ mappedPersonalityId: null, mappedPersonalityName: null }),
      null,
      'default',
      'none',
      true,
      false,
      false,
    );

    const row = bar.root.querySelector('.chatgoose-toolbar-tone-row');
    // The row stays visible (tracks Reply, which is also visible-but-disabled)…
    expect(row?.classList.contains('chatgoose-hidden')).toBe(false);
    // …but the pills can't generate without a mapped personality.
    expect(tonePills(bar.root).every((pill) => pill.disabled)).toBe(true);
  });

  it('hides the tone row when not connected', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState({ connected: false }), null, 'default', 'none', true, false, false);

    const row = bar.root.querySelector('.chatgoose-toolbar-tone-row');
    expect(row?.classList.contains('chatgoose-hidden')).toBe(true);
  });
});

describe('ButtonBar multi toggle', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders a labelled Multi toggle, unpressed by default', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const multi = multiToggle(bar.root)!;
    expect(multi.textContent).toBe('Multi');
    expect(multi.getAttribute('aria-pressed')).toBe('false');
    expect(multi.classList.contains('chatgoose-toolbar-toggle-active')).toBe(false);
  });

  it('reflects an armed Multi mode with aria-pressed and the active style', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'preferSplit', 'none', true, false, false);

    const multi = multiToggle(bar.root)!;
    expect(multi.getAttribute('aria-pressed')).toBe('true');
    expect(multi.classList.contains('chatgoose-toolbar-toggle-active')).toBe(true);
  });

  it('clicking the Multi toggle fires onReplyModeToggle', () => {
    const toggleSpy = vi.fn();
    const bar = makeBar({ onReplyModeToggle: toggleSpy });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    multiToggle(bar.root)!.click();
    expect(toggleSpy).toHaveBeenCalledTimes(1);
  });

  it('disables the Multi toggle during an active operation and when not connected', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), 'fast-reply', 'default', 'none', true, true, false);
    expect(multiToggle(bar.root)!.disabled).toBe(true);

    bar.render(buildState({ connected: false }), null, 'default', 'none', true, false, false);
    expect(multiToggle(bar.root)!.disabled).toBe(true);
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
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', false, false, false);

    expect(buttonByLabel(bar.root, 'Polish')?.disabled).toBe(true);
  });

  it('orders Reply, Multi, Polish, tone row, Hi, Ping, Scan, then the personality pill', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const children = Array.from(bar.root.children);
    const replyIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-button-primary'),
    );
    const multiIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-toggle'),
    );
    const polishIndex = children.findIndex((child) => labelOf(child) === 'Polish');
    const toneIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-tone-row'),
    );
    const hiIndex = children.findIndex((child) => labelOf(child) === 'Hi');
    const pingIndex = children.findIndex((child) => labelOf(child) === 'Ping');
    const scanIndex = children.findIndex((child) => labelOf(child) === 'Scan');
    const personalityIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-personality-end'),
    );

    expect(replyIndex).toBe(0);
    expect(multiIndex).toBe(replyIndex + 1);
    expect(polishIndex).toBe(multiIndex + 1);
    expect(toneIndex).toBe(polishIndex + 1);
    expect(hiIndex).toBe(toneIndex + 1);
    expect(pingIndex).toBe(hiIndex + 1);
    expect(scanIndex).toBe(pingIndex + 1);
    expect(personalityIndex).toBe(scanIndex + 1);
  });
});
