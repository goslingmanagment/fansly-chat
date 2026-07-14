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
    mappedPersonaVersion: 1,
    mappedPersonaDefinitionId: 'v1:persona-one-definition',
    mappedPersonaSource: 'source-a',
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

function splitFlag(root: ParentNode): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>('.chatgoose-toolbar-flag');
}

function toneSegments(root: ParentNode): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.chatgoose-tone-seg'));
}

function toneSegment(root: ParentNode, emoji: string): HTMLButtonElement | undefined {
  return toneSegments(root).find((segment) =>
    segment.querySelector('.chatgoose-tone-seg-emoji')?.textContent === emoji,
  );
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

  it('renders Recap as a row button (no overflow ⋯ menu)', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    expect(buttonByLabel(bar.root, 'Recap')).toBeDefined();
    expect(bar.root.querySelector('.chatgoose-more')).toBeNull();
    expect(bar.root.querySelector('.chatgoose-more-menu')).toBeNull();
  });

  it('renders hover-only hotkey chips while exposing shortcut metadata', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const platform = detectLabelPlatform();
    const replyHotkey = featureHotkeyLabel('fast-reply', platform)!;
    const recapHotkey = featureHotkeyLabel('fan-summary', platform)!;

    const reply = buttonByLabel(bar.root, 'Reply');
    const replyChip = reply?.querySelector('.chatgoose-toolbar-hotkey');
    expect(replyChip?.textContent).toBe(replyHotkey.short);
    expect(replyChip?.getAttribute('aria-hidden')).toBe('true');
    expect(reply?.title).toContain(replyHotkey.full);
    expect(reply?.getAttribute('aria-keyshortcuts')).toBe(
      `${platform === 'mac' ? 'Meta' : 'Alt'}+Shift+${replyHotkey.short}`,
    );

    const recap = buttonByLabel(bar.root, 'Recap');
    const recapChip = recap?.querySelector('.chatgoose-toolbar-hotkey');
    expect(recapChip?.textContent).toBe(recapHotkey.short);
    expect(recapChip?.getAttribute('aria-hidden')).toBe('true');
    expect(recap?.title).toContain(recapHotkey.full);
    expect(recap?.getAttribute('aria-keyshortcuts')).toBe(
      `${platform === 'mac' ? 'Meta' : 'Alt'}+Shift+${recapHotkey.short}`,
    );

    // The Split reply-mode flag is a labelled pill with no bound key — no chip,
    // no keyshortcuts.
    const split = splitFlag(bar.root);
    expect(split?.textContent).toBe('Split');
    expect(split?.querySelector('.chatgoose-kbd')).toBeNull();
    expect(split?.getAttribute('aria-keyshortcuts')).toBeNull();
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

  it('marks a ready summary on the Recap button', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState({ hasAvailableSummary: true }), null, 'default', 'none', true, false, false);

    const recap = buttonByLabel(bar.root, 'Recap');
    expect(recap?.classList.contains('chatgoose-toolbar-button-summary-ready')).toBe(true);
    expect(recap?.title).toContain('Recap ready to open');
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

describe('ButtonBar tone groove (E24)', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders four emoji segments in a radio groove with Russian hints', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const track = bar.root.querySelector('.chatgoose-tone-track');
    expect(track?.getAttribute('role')).toBe('radiogroup');
    const segments = toneSegments(bar.root);
    expect(segments.map((s) => s.querySelector('.chatgoose-tone-seg-emoji')?.textContent))
      .toEqual(['😌', '😏', '💰', '🔥']);
    // Idle segments carry the glyph only — no word.
    expect(bar.root.querySelector('.chatgoose-tone-seg-word')).toBeNull();
    // Hover hint is Russian and mentions the cycle combo.
    expect(toneSegment(bar.root, '😏')?.title).toContain('Флирт');
    expect(toneSegment(bar.root, '💰')?.title).toContain('продажа');
    expect(toneSegment(bar.root, '😌')?.title).toContain('дружеский');
    expect(toneSegment(bar.root, '🔥')?.title).toContain('Горячо');
  });

  it('the armed segment surfaces as a fixed-width thumb without adding a word', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'flirty', true, false, false);

    const flirty = toneSegment(bar.root, '😏')!;
    const spicy = toneSegment(bar.root, '🔥')!;

    expect(flirty.classList.contains('chatgoose-tone-seg-active')).toBe(true);
    expect(flirty.getAttribute('aria-checked')).toBe('true');
    expect(flirty.textContent).toBe('😏');
    expect(flirty.querySelector('.chatgoose-tone-seg-word')).toBeNull();
    expect(spicy.classList.contains('chatgoose-tone-seg-active')).toBe(false);
    expect(spicy.getAttribute('aria-checked')).toBe('false');
    expect(spicy.textContent).toBe('🔥');
    expect(spicy.querySelector('.chatgoose-tone-seg-word')).toBeNull();
  });

  it('clicking a segment fires onToneSelect with that tone (arming only — no generation here)', () => {
    const toneSpy = vi.fn();
    const bar = makeBar({ onToneSelect: toneSpy });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    toneSegment(bar.root, '💰')?.click();
    expect(toneSpy).toHaveBeenCalledWith('upsell');
    toneSegment(bar.root, '😌')?.click();
    expect(toneSpy).toHaveBeenCalledWith('casual');
  });

  it('disables the segments during an active operation', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), 'fast-reply', 'default', 'none', true, true, false);

    expect(toneSegments(bar.root).every((segment) => segment.disabled)).toBe(true);
  });

  it('disables the segments when connected and keyed but unmapped', () => {
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

    const track = bar.root.querySelector('.chatgoose-tone-track');
    // The groove stays visible (tracks Reply, which is also visible-but-disabled)…
    expect(track?.classList.contains('chatgoose-hidden')).toBe(false);
    // …but arming a tone is pointless without a mapped personality.
    expect(toneSegments(bar.root).every((segment) => segment.disabled)).toBe(true);
  });

  it('hides the groove and the Split flag when not connected', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState({ connected: false }), null, 'default', 'none', true, false, false);

    const track = bar.root.querySelector('.chatgoose-tone-track');
    expect(track?.classList.contains('chatgoose-hidden')).toBe(true);
    expect(splitFlag(bar.root)?.classList.contains('chatgoose-hidden')).toBe(true);
  });
});

describe('ButtonBar Split flag', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders a labelled Split flag, unpressed by default', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const split = splitFlag(bar.root)!;
    expect(split.textContent).toBe('Split');
    expect(split.getAttribute('aria-pressed')).toBe('false');
    expect(split.classList.contains('chatgoose-toolbar-flag-active')).toBe(false);
  });

  it('reflects an armed Split mode with aria-pressed and the active style', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'preferSplit', 'none', true, false, false);

    const split = splitFlag(bar.root)!;
    expect(split.getAttribute('aria-pressed')).toBe('true');
    expect(split.classList.contains('chatgoose-toolbar-flag-active')).toBe(true);
  });

  it('clicking the Split flag fires onReplyModeToggle', () => {
    const toggleSpy = vi.fn();
    const bar = makeBar({ onReplyModeToggle: toggleSpy });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    splitFlag(bar.root)!.click();
    expect(toggleSpy).toHaveBeenCalledTimes(1);
  });

  it('disables the Split flag during an active operation and when not connected', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), 'fast-reply', 'default', 'none', true, true, false);
    expect(splitFlag(bar.root)!.disabled).toBe(true);

    bar.render(buildState({ connected: false }), null, 'default', 'none', true, false, false);
    expect(splitFlag(bar.root)!.disabled).toBe(true);
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

  it('disables Fix when the composer draft is empty', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', false, false, false);

    expect(buttonByLabel(bar.root, 'Fix')?.disabled).toBe(true);
  });

  it('orders Reply, tone groove, Split, Fix, Hi, Ping, Recap, then the personality pill', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const children = Array.from(bar.root.children);
    const replyIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-button-primary'),
    );
    const toneIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-tone-track'),
    );
    const splitIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-flag'),
    );
    const fixIndex = children.findIndex((child) => labelOf(child) === 'Fix');
    const hiIndex = children.findIndex((child) => labelOf(child) === 'Hi');
    const pingIndex = children.findIndex((child) => labelOf(child) === 'Ping');
    const recapIndex = children.findIndex((child) => labelOf(child) === 'Recap');
    const personalityIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-personality-end'),
    );

    // Reply cluster (trigger + options) → draft tool → openers → fan side.
    expect(replyIndex).toBe(0);
    expect(toneIndex).toBe(replyIndex + 1);
    expect(splitIndex).toBe(toneIndex + 1);
    expect(fixIndex).toBeGreaterThan(splitIndex);
    expect(hiIndex).toBeGreaterThan(fixIndex);
    expect(pingIndex).toBe(hiIndex + 1);
    expect(recapIndex).toBe(pingIndex + 1);
    expect(personalityIndex).toBe(recapIndex + 1);

    // Meaning-groups are seamed with hairlines, and Recap opens the
    // right-pinned cluster.
    expect(bar.root.querySelectorAll('.chatgoose-toolbar-sep')).toHaveLength(2);
    expect(
      children[recapIndex]!.classList.contains('chatgoose-toolbar-right-start'),
    ).toBe(true);
  });
});
