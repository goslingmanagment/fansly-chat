import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ButtonBar } from '../src/content/button-bar.js';
import { installContentStyles } from '../src/content/dom-anchor.js';
import { detectLabelPlatform, featureHotkeyLabel } from '../src/shared/hotkeys.js';
import type { TabUiState } from '../src/shared/types.js';

const contentStyles = readFileSync(
  new URL('../src/content/styles.css', import.meta.url),
  'utf8',
);

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>');
  const { window } = dom;
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLDivElement', window.HTMLDivElement);
  vi.stubGlobal('HTMLButtonElement', window.HTMLButtonElement);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
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
    voiceNotesCapable: false,
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
    onVoiceClick: noop,
    onCoachClick: noop,
    ...overrides,
  });
}

function voiceButton(root: ParentNode): HTMLButtonElement | null {
  return root.querySelector<HTMLButtonElement>('.chatgoose-toolbar-voice');
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

    const reply = buttonByLabel(bar.root, 'Reply');
    const replyChip = reply?.querySelector('.chatgoose-toolbar-hotkey');
    expect(replyChip?.textContent).toBe(replyHotkey.short);
    expect(replyChip?.getAttribute('aria-hidden')).toBe('true');
    expect(reply?.title).toContain(replyHotkey.full);
    expect(reply?.getAttribute('aria-keyshortcuts')).toBe(
      `${platform === 'mac' ? 'Meta' : 'Alt'}+Shift+${replyHotkey.short}`,
    );

    // Recap left HOTKEY_FEATURE in the Coach extension phase (plan §Task 2):
    // ⌘⇧S now opens the recap picker (an app action), not this button's direct
    // fan-summary start — so featureHotkeyLabel('fan-summary') is null and the
    // button no longer advertises a (now-mismatched) shortcut chip.
    expect(featureHotkeyLabel('fan-summary', platform)).toBeNull();
    const recap = buttonByLabel(bar.root, 'Recap');
    expect(recap).toBeDefined();
    expect(recap?.querySelector('.chatgoose-toolbar-hotkey')).toBeNull();
    expect(recap?.getAttribute('aria-keyshortcuts')).toBeNull();

    // The Split reply-mode flag is a labelled pill with no bound key — no chip,
    // no keyshortcuts.
    const split = splitFlag(bar.root);
    expect(split?.textContent).toBe('Split');
    expect(split?.querySelector('.chatgoose-kbd')).toBeNull();
    expect(split?.getAttribute('aria-keyshortcuts')).toBeNull();
  });

  it('keeps the hotkey and the same hidden spinner after loading ends', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), 'fast-reply', 'default', 'none', true, true, false);

    const reply = buttonByLabel(bar.root, 'Reply');
    const spinner = reply?.querySelector('.chatgoose-spinner');
    expect(reply?.querySelector('.chatgoose-toolbar-hotkey')).not.toBeNull();
    expect(spinner).not.toBeNull();
    expect(spinner?.classList.contains('chatgoose-hidden')).toBe(false);
    expect(reply?.classList.contains('chatgoose-toolbar-button-loading')).toBe(true);

    bar.render(buildState(), null, 'default', 'none', true, false, false);
    const idleSpinner = reply?.querySelector('.chatgoose-spinner');
    expect(idleSpinner).toBe(spinner);
    expect(idleSpinner?.classList.contains('chatgoose-hidden')).toBe(true);
    expect(reply?.querySelector('.chatgoose-toolbar-hotkey')).not.toBeNull();
    expect(reply?.classList.contains('chatgoose-toolbar-button-loading')).toBe(false);
  });

  it('does not mutate a feature button child list on an identical rerender', () => {
    const bar = makeBar();
    document.body.append(bar.root);
    const state = buildState();
    bar.render(state, 'fast-reply', 'default', 'none', true, true, false);

    const reply = buttonByLabel(bar.root, 'Reply')!;
    const children = Array.from(reply.childNodes);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((mutations) => records.push(...mutations));
    observer.observe(reply, { childList: true, subtree: true });

    bar.render(state, 'fast-reply', 'default', 'none', true, true, false);
    records.push(...observer.takeRecords());
    observer.disconnect();

    expect(Array.from(reply.childNodes)).toEqual(children);
    expect(records).toHaveLength(0);
  });

  it('renders a Coach button after Recap that fires onCoachClick', () => {
    const onCoachClick = vi.fn();
    const bar = makeBar({ onCoachClick });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const coach = buttonByLabel(bar.root, 'Coach');
    expect(coach).toBeDefined();

    // Ordering: Coach sits after Recap.
    const buttons = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button'));
    const recapIndex = buttons.findIndex((b) => b.textContent === 'Recap');
    const coachIndex = buttons.findIndex((b) => b.textContent === 'Coach');
    expect(coachIndex).toBeGreaterThan(recapIndex);

    coach!.click();
    expect(onCoachClick).toHaveBeenCalledTimes(1);
  });

  it('disables Coach while another feature operation is active', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), 'fast-reply', 'default', 'none', true, true, false);
    expect(buttonByLabel(bar.root, 'Coach')?.disabled).toBe(true);

    bar.render(buildState(), null, 'default', 'none', true, false, false);
    expect(buttonByLabel(bar.root, 'Coach')?.disabled).toBe(false);
  });

  it('marks a ready summary on the Recap button', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState({ hasAvailableSummary: true }), null, 'default', 'none', true, false, false);

    const recap = buttonByLabel(bar.root, 'Recap');
    expect(recap?.classList.contains('chatgoose-toolbar-button-summary-ready')).toBe(true);
    expect(recap?.title).toContain('Recap ready to open');
  });

  it('hides the 🎙 Voice button unless the page is voice-capable', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState({ voiceNotesCapable: false }), null, 'default', 'none', true, false, false);
    expect(voiceButton(bar.root)?.classList.contains('chatgoose-hidden')).toBe(true);

    bar.render(buildState({ voiceNotesCapable: true }), null, 'default', 'none', true, false, false);
    const voice = voiceButton(bar.root);
    expect(voice?.classList.contains('chatgoose-hidden')).toBe(false);
    expect(voice?.textContent).toBe('🎙');
    expect(voice?.disabled).toBe(false);
  });

  it('disables the 🎙 Voice button when the Fansly session is not connected', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(
      buildState({ voiceNotesCapable: true, connected: false }),
      null,
      'default',
      'none',
      true,
      false,
      false,
    );

    expect(voiceButton(bar.root)?.disabled).toBe(true);
  });

  it('fires onVoiceClick when the 🎙 Voice button is clicked', () => {
    const voiceSpy = vi.fn();
    const bar = makeBar({ onVoiceClick: voiceSpy });
    document.body.append(bar.root);

    bar.render(buildState({ voiceNotesCapable: true }), null, 'default', 'none', true, false, false);
    voiceButton(bar.root)!.click();

    expect(voiceSpy).toHaveBeenCalledTimes(1);
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

  it('orders Reply through Recap, Coach, personality, then Voice', () => {
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
    const coachIndex = children.findIndex((child) => labelOf(child) === 'Coach');
    const personalityIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-personality-end'),
    );
    const voiceIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-voice'),
    );

    // Reply cluster (trigger + options) → draft tool → openers → fan side.
    expect(replyIndex).toBe(0);
    expect(toneIndex).toBe(replyIndex + 1);
    expect(splitIndex).toBe(toneIndex + 1);
    expect(fixIndex).toBeGreaterThan(splitIndex);
    expect(hiIndex).toBeGreaterThan(fixIndex);
    expect(pingIndex).toBe(hiIndex + 1);
    expect(recapIndex).toBe(pingIndex + 1);
    // Coach joins the fan-side cluster right after Recap (spec §10).
    expect(coachIndex).toBe(recapIndex + 1);
    expect(personalityIndex).toBe(coachIndex + 1);
    expect(voiceIndex).toBe(personalityIndex + 1);

    // Meaning-groups are seamed with hairlines, and Recap opens the
    // right-pinned cluster.
    expect(bar.root.querySelectorAll('.chatgoose-toolbar-sep')).toHaveLength(2);
    expect(
      children[recapIndex]!.classList.contains('chatgoose-toolbar-right-start'),
    ).toBe(true);
  });
});

describe('ButtonBar right-pin invariant (real stylesheet)', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // The row's ONE right-pin lives on Recap (.chatgoose-toolbar-right-start).
  // A second auto margin in the same nowrap row (the persona pill carried a
  // pre-E24 leftover until 1.9.9) makes flexbox split the free space between
  // the margins, stranding Recap mid-bar on wide composers — invisible on
  // narrow windows where both margins collapse to zero. jsdom computes the
  // cascade (not layout), which is exactly what broke, so pin the cascade:
  // Recap is the single toolbar child whose margin-left resolves to auto.
  it('gives Recap the only auto left margin in the toolbar row', () => {
    installContentStyles(contentStyles);
    const bar = makeBar();
    document.body.append(bar.root);
    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const recap = buttonByLabel(bar.root, 'Recap')!;
    const persona = bar.root.querySelector('.chatgoose-toolbar-personality-end')!;
    const autoPinned = Array.from(bar.root.children).filter(
      (child) => window.getComputedStyle(child).marginLeft === 'auto',
    );

    expect(window.getComputedStyle(recap).marginLeft).toBe('auto');
    expect(window.getComputedStyle(persona).marginLeft).not.toBe('auto');
    expect(autoPinned).toEqual([recap]);
  });
});
