import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { ButtonBar } from '../src/content/button-bar.js';
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
      .map((button) => button.textContent);

    expect(labels).toContain('Scan');
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
      .find((button) => button.textContent === 'Scan');

    expect(summary?.classList.contains('chatgoose-toolbar-button-summary-ready')).toBe(true);
    expect(summary?.title).toBe('Scan ready to open');
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
      .map((button) => button.textContent);

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
    const reply = buttons.find((button) => button.textContent === 'Reply');
    const compare = buttons.find((button) => button.textContent === 'Compare');

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

describe('ButtonBar tone row', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('renders three tone pills', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'none', true, false, false);

    const pills = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('.chatgoose-tone-pill'));
    expect(pills).toHaveLength(3);
    expect(pills.map((p) => p.textContent)).toEqual(['Flirty', 'Upsell', 'Horny']);
  });

  it('marks the active tone pill', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), null, 'default', 'flirty', true, false, false);

    const pills = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('.chatgoose-tone-pill'));
    const flirty = pills.find((p) => p.textContent === 'Flirty');
    const horny = pills.find((p) => p.textContent === 'Horny');

    expect(flirty?.classList.contains('chatgoose-tone-pill-active')).toBe(true);
    expect(flirty?.getAttribute('aria-pressed')).toBe('true');
    expect(horny?.classList.contains('chatgoose-tone-pill-active')).toBe(false);
    expect(horny?.getAttribute('aria-pressed')).toBe('false');
  });

  it('disables tone pills during active operation', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState(), 'fast-reply', 'default', 'none', true, true, false);

    const pills = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('.chatgoose-tone-pill'));
    for (const pill of pills) {
      expect(pill.disabled).toBe(true);
    }
  });

  it('hides tone row when not connected', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState({ connected: false }), null, 'default', 'none', true, false, false);

    const toneRow = bar.root.querySelector('.chatgoose-toolbar-tone-row');
    expect(toneRow?.classList.contains('chatgoose-hidden')).toBe(true);
  });

  it('shows tone row without mapped personality when connected with API key', () => {
    const bar = new ButtonBar({
      onFeatureClick: () => undefined,
      onCompareClick: () => undefined,
      onCompareRestoreClick: () => undefined,
      onReplyModeToggle: () => undefined,
      onToneSelect: () => undefined,
    });
    document.body.append(bar.root);

    bar.render(buildState({
      mappedPersonalityId: null,
      mappedPersonalityName: null,
      compareCardCount: 2,
    }), null, 'default', 'none', true, false, false);

    const toneRow = bar.root.querySelector('.chatgoose-toolbar-tone-row');
    expect(toneRow?.classList.contains('chatgoose-hidden')).toBe(false);
  });

  it('calls onToneSelect when a pill is clicked', () => {
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

    const pills = Array.from(bar.root.querySelectorAll<HTMLButtonElement>('.chatgoose-tone-pill'));
    const flirty = pills.find((p) => p.textContent === 'Flirty');
    flirty?.click();

    expect(toneSpy).toHaveBeenCalledWith('flirty');
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
      .find((button) => button.textContent === 'Polish');

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
    const multiIndex = children.findIndex((child) => child.textContent === 'Multi');
    const polishIndex = children.findIndex((child) => child.textContent === 'Polish');
    const pingIndex = children.findIndex((child) => child.textContent === 'Ping');
    const summaryIndex = children.findIndex((child) => child.textContent === 'Scan');
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
