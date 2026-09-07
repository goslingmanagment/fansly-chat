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
  return root.querySelector<HTMLButtonElement>('.chatgoose-split-seg');
}

function toneSegments(root: ParentNode): HTMLButtonElement[] {
  // Split shares the cell geometry class, so exclude it: these helpers are
  // about the four TONES.
  return Array.from(
    root.querySelectorAll<HTMLButtonElement>('.chatgoose-tone-seg:not(.chatgoose-split-seg)'),
  );
}

function toneSegment(root: ParentNode, emoji: string): HTMLButtonElement | undefined {
  return toneSegments(root).find((segment) =>
    segment.querySelector('.chatgoose-tone-seg-emoji')?.textContent === emoji,
  );
}

/** Open a control's hover hint and read it. Focus shows it with no dwell, which
 *  keeps these assertions free of fake timers; the hover path has its own
 *  tests in `hover-hint.test.ts`. */
function hintFor(element: Element | null | undefined): { title: string; body: string } {
  element?.dispatchEvent(new window.Event('focus'));
  const layer = document.querySelector('.chatgoose-hint');
  return {
    title: layer?.querySelector('.chatgoose-hint-title')?.textContent ?? '',
    body: layer?.querySelector('.chatgoose-hint-body')?.textContent ?? '',
  };
}

const noop = () => undefined;
function makeBar(overrides: Partial<ConstructorParameters<typeof ButtonBar>[0]> = {}) {
  return new ButtonBar({
    onFeatureClick: noop,
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

  it('never mounts Compare or contextual Reopen, including a cached result', () => {
    const bar = makeBar();
    document.body.append(bar.root);
    for (const restorable of [false, true]) {
      bar.render(buildState(), null, 'default', 'none', true, false, restorable);
      const labels = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button')).map(labelOf);
      expect(labels).not.toContain('Compare');
      expect(labels).not.toContain('Reopen');
    }
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
    // The combo lives on the keycap, so the hint does NOT repeat it — it
    // spends its two lines on explaining the control instead.
    expect(reply?.title).toBe('');
    expect(hintFor(reply).body).not.toContain(replyHotkey.full);
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

    // The Split cell is 24px: no room for a keycap chip, so the combo is
    // exposed as metadata only and spelled out in the hint.
    const split = splitFlag(bar.root);
    expect(split?.querySelector('.chatgoose-kbd')).toBeNull();
    expect(split?.getAttribute('aria-keyshortcuts')).toBe(
      `${platform === 'mac' ? 'Meta' : 'Alt'}+Shift+L`,
    );
  });

  it('applies the toolbar-hint preference live without removing control metadata', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(
      buildState({ showToolbarHints: false }),
      null,
      'default',
      'none',
      true,
      false,
      false,
    );
    const reply = buttonByLabel(bar.root, 'Reply');
    reply?.dispatchEvent(new window.Event('focus'));
    expect(document.querySelector('.chatgoose-hint')).toBeNull();
    expect(labelOf(reply!)).toBe('Reply');
    expect(reply?.getAttribute('aria-keyshortcuts')).toBeTruthy();

    bar.render(
      buildState({ showToolbarHints: true }),
      null,
      'default',
      'none',
      true,
      false,
      false,
    );
    reply?.dispatchEvent(new window.Event('focus'));
    expect(hintFor(reply).title).toBe('Reply');

    bar.render(
      buildState({ showToolbarHints: false }),
      null,
      'default',
      'none',
      true,
      false,
      false,
    );
    expect(document.querySelector('.chatgoose-hint')?.classList.contains('chatgoose-hidden'))
      .toBe(true);
    expect(reply?.hasAttribute('aria-describedby')).toBe(false);
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
    expect(hintFor(recap).body).toContain('Готовый рекап');
  });

  it('derives the Recap marker from the exact short slot, not the legacy aggregate', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState({
      hasAvailableSummary: false,
      availableRecaps: { full: false, short: true },
    }), null, 'default', 'none', true, false, false);

    expect(buttonByLabel(bar.root, 'Recap')?.classList
      .contains('chatgoose-toolbar-button-summary-ready')).toBe(true);
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

  it('keeps Review while Help and Compare have no toolbar entry', () => {
    const bar = makeBar();
    document.body.append(bar.root);
    bar.render(buildState(), null, 'default', 'none', true, false, false);
    const labels = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('button')).map(labelOf);
    expect(labels).not.toContain('Help');
    expect(labels).not.toContain('Compare');
    expect(labels).not.toContain('Reopen');
    expect(labels).toContain('Review');
    expect(hintFor(buttonByLabel(bar.root, 'Review')).body).toContain('Оценка');
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
    // Hover hint is Russian and — these cells being too small for a keycap —
    // carries the cycle combo itself.
    expect(hintFor(toneSegment(bar.root, '😏')).body).toContain('Флирт');
    expect(hintFor(toneSegment(bar.root, '💰')).body).toContain('продажа');
    expect(hintFor(toneSegment(bar.root, '😌')).body).toContain('дружеский');
    const spicy = hintFor(toneSegment(bar.root, '🔥'));
    expect(spicy.body).toContain('Горячо');
    expect(spicy.body).toContain('циклирует');
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

  it('hides the whole options capsule when not connected', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState({ connected: false }), null, 'default', 'none', true, false, false);

    // Hiding the inner track alone would strand the seam and the Split cell in
    // an empty pill, so the capsule is what carries the class.
    const capsule = bar.root.querySelector('.chatgoose-reply-options');
    expect(capsule?.classList.contains('chatgoose-hidden')).toBe(true);
  });
});

describe('ButtonBar Split cell (E73)', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sits inside the capsule but OUTSIDE the radio group, as a checkbox', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const capsule = bar.root.querySelector('.chatgoose-reply-options')!;
    const track = capsule.querySelector('.chatgoose-tone-track')!;
    const split = splitFlag(bar.root)!;
    // A checkbox inside a radiogroup is an a11y violation — the capsule holds
    // both, the role stays on the inner track.
    expect(track.getAttribute('role')).toBe('radiogroup');
    expect(capsule.contains(split)).toBe(true);
    expect(track.contains(split)).toBe(false);
    expect(split.getAttribute('role')).toBe('checkbox');
    // The word is gone; the hint and the combo carry it now.
    expect(split.textContent).toBe('');
    expect(split.getAttribute('aria-label')).toContain('Split');
    expect(split.getAttribute('aria-keyshortcuts')).toMatch(/\+Shift\+L$/);
    expect(hintFor(split).body).toContain('2–3 сообщений');
  });

  it('renders unchecked by default', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const split = splitFlag(bar.root)!;
    expect(split.getAttribute('aria-checked')).toBe('false');
    expect(split.classList.contains('chatgoose-split-seg-active')).toBe(false);
  });

  it('reflects an armed Split mode with aria-checked and the pressed style', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'preferSplit', 'none', true, false, false);

    const split = splitFlag(bar.root)!;
    expect(split.getAttribute('aria-checked')).toBe('true');
    expect(split.classList.contains('chatgoose-split-seg-active')).toBe(true);
  });

  it('clicking the Split cell fires onReplyModeToggle', () => {
    const toggleSpy = vi.fn();
    const bar = makeBar({ onReplyModeToggle: toggleSpy });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    splitFlag(bar.root)!.click();
    expect(toggleSpy).toHaveBeenCalledTimes(1);
  });

  it('disables the Split cell during an active operation and when not connected', () => {
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

  // ─── E71: the persona pill left the bar ──────────────────────────────────

  it('renders no persona pill and names the persona on Reply instead', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    expect(bar.root.textContent).not.toContain('Closer');
    const reply = bar.root.querySelector<HTMLButtonElement>(
      '.chatgoose-toolbar-button-primary',
    )!;
    expect(hintFor(reply).body).toContain('«Closer»');
  });

  it('drops the persona from Reply’s hint when nothing is mapped', () => {
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

    const reply = bar.root.querySelector<HTMLButtonElement>(
      '.chatgoose-toolbar-button-primary',
    )!;
    const body = hintFor(reply).body;
    expect(body).not.toContain('Closer');
    expect(body).toContain('с учётом персоны');
  });

  it('explains a greyed-out Fix instead of leaving it silent', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    // Disabled controls are exactly the ones a chatter needs explained, and the
    // native tooltip never reached them.
    bar.render(buildState(), null, 'default', 'none', false, false, false);
    const fix = buttonByLabel(bar.root, 'Fix')!;
    expect(fix.disabled).toBe(true);
    expect(hintFor(fix).body).toContain('в поле нет текста');

    bar.render(buildState(), null, 'default', 'none', true, false, false);
    expect(hintFor(fix).body).not.toContain('в поле нет текста');
  });

  it('stays quiet about an unmapped account — the mapping banner covers it', () => {
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

    const warn = bar.root.querySelector('.chatgoose-toolbar-warn')!;
    expect(warn.classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('warns in the bar when no Fansly account was detected', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    // No accountId ⇒ MappingBanner.render() returns early, so the bar is the
    // only surface that can say why every button is dead.
    bar.render(
      buildState({
        accountId: null,
        mappedPersonalityId: null,
        mappedPersonalityName: null,
      }),
      null,
      'default',
      'none',
      true,
      false,
      false,
    );

    const warn = bar.root.querySelector('.chatgoose-toolbar-warn')!;
    expect(warn.classList.contains('chatgoose-hidden')).toBe(false);
    expect(warn.textContent).toBe('Аккаунт не определён');
  });

  it('orders every toolbar action before Recap, Coach, the account warning, then Voice', () => {
    const bar = makeBar();
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const children = Array.from(bar.root.children);
    const replyIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-button-primary'),
    );
    const optionsIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-reply-options'),
    );
    const fixIndex = children.findIndex((child) => labelOf(child) === 'Fix');
    const hiIndex = children.findIndex((child) => labelOf(child) === 'Hi');
    const pingIndex = children.findIndex((child) => labelOf(child) === 'Ping');
    const reviewIndex = children.findIndex((child) => labelOf(child) === 'Review');
    const recapIndex = children.findIndex((child) => labelOf(child) === 'Recap');
    const coachIndex = children.findIndex((child) => labelOf(child) === 'Coach');
    const warningIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-warn'),
    );
    const voiceIndex = children.findIndex((child) =>
      child.classList.contains('chatgoose-toolbar-voice'),
    );

    // Reply cluster (trigger + options) → draft tool → openers → fan side.
    expect(replyIndex).toBe(0);
    // One capsule now, not a track plus a free-standing flag (E73).
    expect(optionsIndex).toBe(replyIndex + 1);
    expect(fixIndex).toBeGreaterThan(optionsIndex);
    expect(hiIndex).toBeGreaterThan(fixIndex);
    expect(pingIndex).toBe(hiIndex + 1);
    // E80: Review follows Ping directly — the bar has no Help button.
    expect(reviewIndex).toBe(pingIndex + 1);
    expect(recapIndex).toBe(reviewIndex + 1);
    // Coach joins the fan-side cluster right after Recap (spec §10).
    expect(coachIndex).toBe(recapIndex + 1);
    expect(warningIndex).toBe(coachIndex + 1);
    expect(voiceIndex).toBe(warningIndex + 1);

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
  // The pill itself is gone since E71; the warning chip that replaced it sits
  // in the same tail position and must not reintroduce the second pin.
  it('gives Recap the only auto left margin in the toolbar row', () => {
    installContentStyles(contentStyles);
    const bar = makeBar();
    document.body.append(bar.root);
    bar.render(buildState({ accountId: null }), null, 'default', 'none', true, false, false);

    const recap = buttonByLabel(bar.root, 'Recap')!;
    const warn = bar.root.querySelector('.chatgoose-toolbar-warn')!;
    const autoPinned = Array.from(bar.root.children).filter(
      (child) => window.getComputedStyle(child).marginLeft === 'auto',
    );

    expect(warn.classList.contains('chatgoose-hidden')).toBe(false);
    expect(window.getComputedStyle(recap).marginLeft).toBe('auto');
    expect(window.getComputedStyle(warn).marginLeft).not.toBe('auto');
    expect(autoPinned).toEqual([recap]);
  });
});
