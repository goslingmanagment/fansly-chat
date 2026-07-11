import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { SpendersBoardController } from '../src/content/spenders/spenders-board-controller.js';
import { createUserError } from '../src/shared/errors.js';
import type {
  ResolveFanChatResponse,
  SpenderListEntry,
  SpendersListResponse,
  SpendersListResult,
} from '../src/shared/types.js';

function entry(
  fanAccountId: string,
  groupId: string | null,
  displayName: string | null,
  lifetimeUsd: number,
  monthUsd: number | null = null,
  customName: string | null = null,
): SpenderListEntry {
  return {
    fanAccountId,
    groupId,
    customName,
    displayName,
    username: displayName ? displayName.toLowerCase() : null,
    lifetimeMills: lifetimeUsd * 1000,
    lifetimeUsd,
    monthMills: monthUsd === null ? null : monthUsd * 1000,
    monthUsd,
  };
}

function makeResult(overrides: Partial<SpendersListResult> = {}): SpendersListResult {
  const now = Date.now();
  return {
    entries: [
      entry('fan-1', 'group-1', 'Jonathan', 1078),
      entry('fan-2', 'group-2', 'Charles', 700),
      entry('fan-3', 'group-3', 'Ricky', 200),
      entry('fan-4', 'group-4', 'Brad', 40),
    ],
    builtAt: now,
    source: {
      streamState: 'ramped',
      lastSyncedAt: now,
      consecutiveFailures: 0,
    },
    fanCount: 4,
    monthWindow: null,
    fetchedAt: now,
    ...overrides,
  };
}

function makeDeps(overrides: {
  fetchList?: (refresh: boolean, buildId: string) => Promise<SpendersListResponse>;
  getContextKey?: () => string | null;
  openChat?: (groupId: string) => void;
  resolveChat?: (entry: SpenderListEntry) => Promise<ResolveFanChatResponse>;
} = {}) {
  return {
    fetchList:
      overrides.fetchList ??
      (async () => ({ ok: true, result: makeResult() }) as SpendersListResponse),
    getContextKey: overrides.getContextKey ?? (() => 'creator-1:1'),
    openChat: overrides.openChat ?? vi.fn(),
    resolveChat:
      overrides.resolveChat ?? (async () => ({ ok: true, groupId: null }) as ResolveFanChatResponse),
  };
}

function installDom() {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'https://fansly.com/messages/example',
  });
  const { window } = dom;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('navigator', window.navigator);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('HTMLButtonElement', window.HTMLButtonElement);
  vi.stubGlobal('KeyboardEvent', window.KeyboardEvent);
  return dom;
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('.chatgoose-board-row'));
}

function pressKey(key: string): void {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
}

function searchInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('.chatgoose-board-search');
  if (!input) throw new Error('search input not rendered');
  return input;
}

function typeSearch(value: string): void {
  const input = searchInput();
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

describe('SpendersBoardController', () => {
  beforeEach(() => {
    installDom();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches on open and renders rows grouped by tier with chips', async () => {
    const fetchList = vi.fn<(refresh: boolean) => Promise<SpendersListResponse>>(
      async () => ({ ok: true, result: makeResult() }),
    );
    const board = new SpendersBoardController(makeDeps({ fetchList }));

    await board.show();

    expect(fetchList).toHaveBeenCalledWith(false, expect.any(String));
    expect(rows()).toHaveLength(4);
    // Whale section sorted desc: Jonathan ($1,078) before Charles ($700).
    expect(rows()[0]!.querySelector('.chatgoose-board-row-name')!.textContent).toBe('Jonathan');
    expect(rows()[0]!.querySelector('.chatgoose-board-row-amount')!.textContent).toBe('$1,078');
    // 3 tier sections present (whale, prime, low).
    expect(document.querySelectorAll('.chatgoose-board-section')).toHaveLength(3);
    // Chips: All + the three populated tiers.
    const chipLabels = Array.from(
      document.querySelectorAll('.chatgoose-board-chip'),
    ).map((c) => c.textContent);
    expect(chipLabels[0]).toContain('All');
    expect(chipLabels).toHaveLength(4);
  });

  it('opens a fan chat on row click', async () => {
    const openChat = vi.fn();
    const board = new SpendersBoardController(makeDeps({ openChat }));
    await board.show();

    rows()[1]!.querySelector<HTMLElement>('.chatgoose-board-row-name')!.click();
    expect(openChat).toHaveBeenCalledWith('group-2');
  });

  it('walks rows with J/K and opens the cursor row on Enter', async () => {
    const openChat = vi.fn();
    const board = new SpendersBoardController(makeDeps({ openChat }));
    await board.show();

    pressKey('j'); // 0 -> 1 (cursor starts at 0)
    pressKey('j'); // 1 -> 2
    pressKey('Enter');
    expect(openChat).toHaveBeenCalledWith('group-3');
  });

  it('closes on Escape', async () => {
    const board = new SpendersBoardController(makeDeps());
    await board.show();
    expect(board.isOpen()).toBe(true);

    typeSearch('jon');

    pressKey('Escape');
    expect(board.isOpen()).toBe(false);
    expect(rows()).toHaveLength(0);
    const internals = board as unknown as {
      rowEls: HTMLElement[];
      visibleEntries: SpenderListEntry[];
      searchRenderTimer: number | null;
    };
    expect(internals.rowEls).toHaveLength(0);
    expect(internals.visibleEntries).toHaveLength(0);
    expect(internals.searchRenderTimer).toBeNull();
  });

  it('filters to a single tier when a tier chip is clicked', async () => {
    const board = new SpendersBoardController(makeDeps());
    await board.show();

    const panel = document.querySelector('.chatgoose-board-panel');
    const header = document.querySelector('.chatgoose-board-header');
    const input = searchInput();
    const allChip = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-board-chip'),
    ).find((c) => c.textContent?.includes('All'))!;
    const whaleChip = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-board-chip'),
    ).find((c) => c.textContent?.includes('Whale'))!;
    whaleChip.focus();
    whaleChip.click();

    expect(rows()).toHaveLength(2);
    expect(document.querySelectorAll('.chatgoose-board-section')).toHaveLength(1);
    expect(document.querySelector('.chatgoose-board-panel')).toBe(panel);
    expect(document.querySelector('.chatgoose-board-header')).toBe(header);
    expect(searchInput()).toBe(input);
    expect(document.activeElement).toBe(whaleChip);
    expect(whaleChip.getAttribute('aria-pressed')).toBe('true');
    expect(allChip.getAttribute('aria-pressed')).toBe('false');
  });

  it('does not steal Enter from focused board controls', async () => {
    const openChat = vi.fn();
    const board = new SpendersBoardController(makeDeps({ openChat }));
    await board.show();
    const whaleChip = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-board-chip'),
    ).find((chip) => chip.textContent?.includes('Whale'))!;
    whaleChip.focus();

    const enter = new window.KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    whaleChip.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(false);
    expect(openChat).not.toHaveBeenCalled();
  });

  // ── E23: entries without an enumerated conversation ──────────────────────

  it('renders unmapped entries with a chat-state chip instead of hiding them', async () => {
    const result = makeResult({
      entries: [
        entry('fan-1', 'group-1', 'Jonathan', 1078),
        entry('fan-ghost', null, 'Ghost', 900),
      ],
      fanCount: 2,
    });
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: true, result }) }),
    );
    await board.show();

    expect(rows()).toHaveLength(2);
    const ghostRow = rows()[1]!;
    expect(ghostRow.querySelector('.chatgoose-board-row-name')!.textContent).toBe('Ghost');
    expect(ghostRow.querySelector('.chatgoose-board-row-chatstate')!.textContent).toBe(
      'find chat',
    );
    expect(rows()[0]!.querySelector('.chatgoose-board-row-chatstate')).toBeNull();
  });

  it('lazily resolves the chat for an unmapped entry and opens it', async () => {
    const openChat = vi.fn();
    const resolveChat = vi.fn(
      async (): Promise<ResolveFanChatResponse> => ({ ok: true, groupId: 'group-found' }),
    );
    const result = makeResult({
      entries: [entry('fan-ghost', null, 'Ghost', 900)],
      fanCount: 1,
    });
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: true, result }), openChat, resolveChat }),
    );
    await board.show();

    rows()[0]!.click();
    expect(resolveChat).toHaveBeenCalledWith(expect.objectContaining({ fanAccountId: 'fan-ghost' }));
    await vi.waitFor(() => expect(openChat).toHaveBeenCalledWith('group-found'));

    // Memoized: a second open skips the search.
    rows()[0]!.click();
    await vi.waitFor(() => expect(openChat).toHaveBeenCalledTimes(2));
    expect(resolveChat).toHaveBeenCalledTimes(1);
  });

  it('marks the row not-found when the resolve comes back empty', async () => {
    const openChat = vi.fn();
    const result = makeResult({
      entries: [entry('fan-ghost', null, 'Ghost', 900)],
      fanCount: 1,
    });
    const board = new SpendersBoardController(
      makeDeps({
        fetchList: async () => ({ ok: true, result }),
        openChat,
        resolveChat: async () => ({ ok: true, groupId: null }),
      }),
    );
    await board.show();

    rows()[0]!.click();
    await vi.waitFor(() =>
      expect(rows()[0]!.querySelector('.chatgoose-board-row-chatstate')!.textContent).toBe(
        'not found',
      ),
    );
    expect(openChat).not.toHaveBeenCalled();
  });

  // ── Month-to-date column + NEW badge ──────────────────────────────────────

  it('updates a cached row when chat resolution finishes while it is filtered out', async () => {
    let resolveChat!: (response: ResolveFanChatResponse) => void;
    const result = makeResult({
      entries: [entry('fan-ghost', null, 'Ghost', 900)],
      fanCount: 1,
    });
    const board = new SpendersBoardController(
      makeDeps({
        fetchList: async () => ({ ok: true, result }),
        resolveChat: async () => await new Promise<ResolveFanChatResponse>((resolve) => {
          resolveChat = resolve;
        }),
      }),
    );
    await board.show();
    rows()[0]!.click();
    expect(document.querySelector('.chatgoose-board-row-chatstate')?.textContent).toBe('locating…');

    typeSearch('nobody');
    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    resolveChat({ ok: true, groupId: null });
    await Promise.resolve();
    typeSearch('');
    await vi.waitFor(() => expect(rows()).toHaveLength(1));

    expect(document.querySelector('.chatgoose-board-row-chatstate')?.textContent).toBe('not found');
  });

  it('renders the month delta and the NEW badge from month data', async () => {
    const result = makeResult({
      entries: [
        // Long-time whale who also spent this month → delta, no NEW.
        entry('fan-1', 'group-1', 'Jonathan', 1078, 120),
        // Entire lifetime landed this month → delta + NEW.
        entry('fan-2', 'group-2', 'Charles', 700, 700),
        // No spend this month → no delta.
        entry('fan-3', 'group-3', 'Ricky', 200, 0),
      ],
      fanCount: 3,
      monthWindow: '2026-07',
    });
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: true, result }) }),
    );
    await board.show();

    expect(rows()[0]!.querySelector('.chatgoose-board-row-delta')!.textContent).toBe('+$120');
    expect(rows()[0]!.querySelector('.chatgoose-board-row-new')).toBeNull();
    expect(rows()[1]!.querySelector('.chatgoose-board-row-delta')!.textContent).toBe('+$700');
    expect(rows()[1]!.querySelector('.chatgoose-board-row-new')!.textContent).toBe('NEW');
    expect(rows()[2]!.querySelector('.chatgoose-board-row-delta')).toBeNull();
  });

  it('shows neither delta nor NEW when the month window is unknown', async () => {
    const board = new SpendersBoardController(makeDeps());
    await board.show();

    expect(document.querySelector('.chatgoose-board-row-delta')).toBeNull();
    expect(document.querySelector('.chatgoose-board-row-new')).toBeNull();
  });

  // ── Search ────────────────────────────────────────────────────────────────

  it('filters rows by name via the search box without losing the input', async () => {
    const board = new SpendersBoardController(makeDeps());
    await board.show();

    const input = searchInput();
    input.focus();
    typeSearch('rick');
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]!.querySelector('.chatgoose-board-row-name')!.textContent).toBe('Ricky');
    // The input element itself survives the list re-render (focus keeper).
    expect(document.querySelector('.chatgoose-board-search')).toBe(input);
    expect(document.activeElement).toBe(input);

    typeSearch('');
    await vi.waitFor(() => expect(rows()).toHaveLength(4));
  });

  it('typing j/k in the search box filters instead of moving the cursor', async () => {
    const openChat = vi.fn();
    const board = new SpendersBoardController(makeDeps({ openChat }));
    await board.show();

    const input = searchInput();
    input.focus();
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    // No row cursor movement happened; Enter in the box opens the top match.
    typeSearch('charles');
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
    );
    expect(openChat).not.toHaveBeenCalled();
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(openChat).toHaveBeenCalledWith('group-2');
  });

  it('waits for IME composition to finish before rebuilding the list', async () => {
    vi.useFakeTimers();
    const board = new SpendersBoardController(makeDeps());
    await board.show();
    const input = searchInput();
    input.value = 'ricky';
    input.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new window.InputEvent('input', {
      bubbles: true,
      data: 'ricky',
      inputType: 'insertCompositionText',
      isComposing: true,
    }));

    await vi.advanceTimersByTimeAsync(300);
    expect(rows()).toHaveLength(4);

    input.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }));
    await vi.advanceTimersByTimeAsync(150);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.querySelector('.chatgoose-board-row-name')?.textContent).toBe('Ricky');
  });

  it('Escape in a non-empty search box clears it; a second Escape closes', async () => {
    const board = new SpendersBoardController(makeDeps());
    await board.show();

    const input = searchInput();
    input.focus();
    typeSearch('rick');
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(board.isOpen()).toBe(true);
    expect(rows()).toHaveLength(4);

    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(board.isOpen()).toBe(false);
  });

  // ── E25: chatter custom names ─────────────────────────────────────────────

  it('renders the custom name as the row name and keeps the handle', async () => {
    const result = makeResult({
      entries: [entry('fan-1', 'group-1', 'BseriesGod', 1744, null, 'Max/Canada/45')],
      fanCount: 1,
    });
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: true, result }) }),
    );
    await board.show();

    expect(rows()[0]!.querySelector('.chatgoose-board-row-name')!.textContent).toBe(
      'Max/Canada/45',
    );
    expect(rows()[0]!.querySelector('.chatgoose-board-row-handle')!.textContent).toBe(
      '@bseriesgod',
    );
  });

  it('search matches the custom name too', async () => {
    const result = makeResult({
      entries: [
        entry('fan-1', 'group-1', 'BseriesGod', 1744, null, 'Max/Canada/45'),
        entry('fan-2', 'group-2', 'Charles', 700),
      ],
      fanCount: 2,
    });
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: true, result }) }),
    );
    await board.show();

    typeSearch('canada');
    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]!.querySelector('.chatgoose-board-row-name')!.textContent).toBe(
      'Max/Canada/45',
    );
  });

  it('renders emoji initials as complete graphemes', async () => {
    const result = makeResult({
      entries: [
        entry('fan-1', 'group-1', 'Wayne', 1000, null, '🐳⭐Wayne/NY/40'),
        entry('fan-2', 'group-2', 'Family', 900, null, '👨‍👩‍👧‍👦 John'),
      ],
      fanCount: 2,
    });
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: true, result }) }),
    );
    await board.show();

    const avatars = Array.from(
      document.querySelectorAll<HTMLElement>('.chatgoose-board-avatar'),
    ).map((avatar) => avatar.textContent);
    expect(avatars).toEqual(['🐳', '👨‍👩‍👧‍👦J']);
    expect(avatars.join('')).not.toContain('�');
  });

  it('shows an empty state when search matches only outside the selected tier', async () => {
    const board = new SpendersBoardController(makeDeps());
    await board.show();

    const whaleChip = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-board-chip'),
    ).find((chip) => chip.textContent?.includes('Whale'))!;
    whaleChip.click();
    typeSearch('ricky');

    await vi.waitFor(() => expect(rows()).toHaveLength(0));
    expect(document.querySelectorAll('.chatgoose-board-section')).toHaveLength(0);
    expect(document.querySelector('.chatgoose-board-state')?.textContent).toBe(
      'No fans in this tier match the search.',
    );
  });

  it('keeps 500-row cursor updates O(1) and coalesces a search burst into one commit', async () => {
    const entries = Array.from({ length: 500 }, (_, index) =>
      entry(
        `fan-${String(index).padStart(3, '0')}`,
        `group-${index}`,
        `Fan ${String(index).padStart(3, '0')}`,
        1000 - index,
      ),
    );
    const result = makeResult({ entries, fanCount: entries.length });
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: true, result }) }),
    );
    await board.show();

    expect(rows()).toHaveLength(500);
    const fan499Row = rows().find(
      (row) => row.querySelector('.chatgoose-board-row-name')?.textContent === 'Fan 499',
    );
    const removeClass = vi.spyOn(window.DOMTokenList.prototype, 'remove');
    const addClass = vi.spyOn(window.DOMTokenList.prototype, 'add');
    pressKey('j');
    expect(removeClass).toHaveBeenCalledTimes(1);
    expect(addClass).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('.chatgoose-board-row-active')).toHaveLength(1);

    const list = document.querySelector<HTMLElement>('.chatgoose-board-list')!;
    const replaceChildren = vi.spyOn(list, 'replaceChildren');
    typeSearch('fan 4');
    typeSearch('fan 49');
    typeSearch('fan 499');
    expect(replaceChildren).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(rows()).toHaveLength(1));
    expect(rows()[0]).toBe(fan499Row);
    expect(rows()[0]!.querySelector('.chatgoose-board-row-name')?.textContent).toBe('Fan 499');
    expect(replaceChildren).toHaveBeenCalledTimes(1);
    expect(replaceChildren.mock.calls[0]).toHaveLength(1);
    expect(replaceChildren.mock.calls[0]![0]).toBeInstanceOf(window.DocumentFragment);
  });

  // ── E26: cold-build progress ──────────────────────────────────────────────

  it('shows name-sweep progress while building, then the board', async () => {
    let resolveList: ((response: SpendersListResponse) => void) | null = null;
    const board = new SpendersBoardController(
      makeDeps({
        fetchList: () =>
          new Promise<SpendersListResponse>((resolve) => {
            resolveList = resolve;
          }),
      }),
    );
    void board.show();
    const activeBuildId = (board as unknown as { activeBuildId: string }).activeBuildId;

    // Ranking phase: honest copy, empty bar.
    board.setBuildProgress({ type: 'spenders:progress', buildId: activeBuildId, phase: 'ranking' });
    expect(document.querySelector('.chatgoose-board-progress-label')!.textContent).toContain(
      'top-spenders snapshot',
    );
    expect(
      document.querySelector<HTMLElement>('.chatgoose-board-progress-bar')!.style.width,
    ).toBe('0%');

    // Name sweep: counted, and the bar tracks it.
    board.setBuildProgress({
      type: 'spenders:progress',
      buildId: activeBuildId,
      phase: 'names',
      done: 250,
      total: 500,
    });
    expect(document.querySelector('.chatgoose-board-progress-label')!.textContent).toBe(
      'Resolving fan names — 250 of 500…',
    );
    expect(
      document.querySelector<HTMLElement>('.chatgoose-board-progress-bar')!.style.width,
    ).toBe('50%');

    resolveList!({ ok: true, result: makeResult() });
    await vi.waitFor(() => expect(rows()).toHaveLength(4));
    expect(document.querySelector('.chatgoose-board-progress-bar')).toBeNull();
  });

  it('ignores progress frames when no build is on screen', async () => {
    const board = new SpendersBoardController(makeDeps());
    await board.show();

    board.setBuildProgress({ type: 'spenders:progress', phase: 'names', done: 1, total: 2 });
    expect(document.querySelector('.chatgoose-board-progress-label')).toBeNull();
    expect(rows()).toHaveLength(4);
  });

  // ── Meta line ─────────────────────────────────────────────────────────────

  it('meta line reports data-as-of + fetched, and the truncated total honestly', async () => {
    const result = makeResult({
      builtAt: Date.now() - 7 * 60 * 60 * 1000,
      fetchedAt: Date.now(),
      fanCount: 480,
    });
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: true, result }) }),
    );
    await board.show();

    const subtitle = document.querySelector('.chatgoose-board-subtitle')!;
    expect(subtitle.textContent).toContain('top 4 of 480 spenders');
    expect(subtitle.textContent).toContain('freshest data 7h ago');
    expect(subtitle.textContent).toContain('fetched just now');
    expect(subtitle.textContent).not.toContain('scanned');
    // The freshness story lives in the tooltip.
    expect(subtitle.getAttribute('title')).toContain('Agency Hub');
  });

  // ── W9.3/A20: not-ramped page (builtAt null) ─────────────────────────────

  it('renders the not-enabled state for a null builtAt, not "no paying fans"', async () => {
    const notRamped = makeResult({
      entries: [],
      builtAt: null,
      source: {
        streamState: 'not_allowlisted',
        lastSyncedAt: null,
        consecutiveFailures: null,
      },
      fanCount: 0,
    });
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: true, result: notRamped }) }),
    );
    await board.show();

    const state = document.querySelector('.chatgoose-board-state');
    expect(state?.textContent).toContain("Spender rankings aren't enabled for this page yet");
    expect(state?.textContent).not.toContain('No paying fans');
    // The header meta must not claim a build time ("updated just now" was the lie).
    const subtitle = document.querySelector('.chatgoose-board-subtitle');
    expect(subtitle?.textContent).toContain('not enabled');
    expect(subtitle?.textContent).not.toContain('updated');
    expect(subtitle?.textContent).not.toContain('fetched');
  });

  it('does not hide failed sync attempts on an empty ramped source', async () => {
    const result = makeResult({
      entries: [],
      builtAt: null,
      source: {
        streamState: 'ramped',
        lastSyncedAt: Date.now() - 60_000,
        consecutiveFailures: 2,
      },
      fanCount: 0,
    });
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: true, result }) }),
    );

    await board.show();

    expect(document.querySelector('.chatgoose-board-subtitle')?.textContent).toContain(
      '2 failed sync attempts',
    );
  });

  it('re-fetches on every open while not ramped (no sticky in-memory result)', async () => {
    const notRamped = makeResult({ entries: [], builtAt: null, fanCount: 0 });
    const fetchList = vi.fn<(refresh: boolean, buildId: string) => Promise<SpendersListResponse>>(
      async () => ({ ok: true, result: notRamped }),
    );
    const board = new SpendersBoardController(makeDeps({ fetchList }));

    await board.show();
    board.close();
    await board.show();
    expect(fetchList).toHaveBeenCalledTimes(2);

    // Ramped results still re-enter the background cache on every open.
    fetchList.mockResolvedValue({ ok: true, result: makeResult() });
    board.close();
    await board.show();
    expect(fetchList).toHaveBeenCalledTimes(3);
    board.close();
    await board.show();
    expect(fetchList).toHaveBeenCalledTimes(4);
  });

  it('reuses an unfinished load across a quick close and reopen', async () => {
    const pending: Array<(response: SpendersListResponse) => void> = [];
    const fetchList = vi.fn(
      async () => await new Promise<SpendersListResponse>((resolve) => pending.push(resolve)),
    );
    const board = new SpendersBoardController(makeDeps({ fetchList }));

    const firstShow = board.show();
    const firstBuildId = (board as unknown as { activeBuildId: string }).activeBuildId;
    board.close();
    const secondShow = board.show();
    const secondBuildId = (board as unknown as { activeBuildId: string }).activeBuildId;

    expect(fetchList).toHaveBeenCalledTimes(1);
    expect(secondBuildId).toBe(firstBuildId);
    pending[0]!({
      ok: true,
      result: makeResult({
        entries: [entry('new', 'new-group', 'New result', 900)],
        fanCount: 1,
      }),
    });
    await Promise.all([firstShow, secondShow]);
    expect(rows()[0]!.querySelector('.chatgoose-board-row-name')?.textContent).toBe('New result');
  });

  it('does not reuse an unfinished load after the creator/source context changes', async () => {
    const pending: Array<(response: SpendersListResponse) => void> = [];
    const fetchList = vi.fn(
      async () => await new Promise<SpendersListResponse>((resolve) => pending.push(resolve)),
    );
    let contextKey = 'creator-a:1';
    const board = new SpendersBoardController(makeDeps({
      fetchList,
      getContextKey: () => contextKey,
    }));

    const firstShow = board.show();
    board.close();
    contextKey = 'creator-b:2';
    const secondShow = board.show();
    expect(fetchList).toHaveBeenCalledTimes(2);

    pending[1]!({
      ok: true,
      result: makeResult({
        entries: [entry('new', 'new-group', 'Creator B', 900)],
        fanCount: 1,
      }),
    });
    await secondShow;
    pending[0]!({
      ok: true,
      result: makeResult({
        entries: [entry('old', 'old-group', 'Creator A', 1000)],
        fanCount: 1,
      }),
    });
    await firstShow;

    expect(rows()[0]!.querySelector('.chatgoose-board-row-name')?.textContent).toBe('Creator B');
  });

  it('does not render an in-flight response after its context changes', async () => {
    let resolveList!: (response: SpendersListResponse) => void;
    let contextKey = 'creator-a:1';
    const board = new SpendersBoardController(makeDeps({
      getContextKey: () => contextKey,
      fetchList: async () => await new Promise<SpendersListResponse>((resolve) => {
        resolveList = resolve;
      }),
    }));

    const show = board.show();
    contextKey = 'creator-b:2';
    resolveList({ ok: true, result: makeResult() });
    await show;

    expect(board.isOpen()).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('ignores stale progress from a previous board build', async () => {
    const pending: Array<(response: SpendersListResponse) => void> = [];
    const board = new SpendersBoardController(
      makeDeps({
        fetchList: async () => await new Promise<SpendersListResponse>((resolve) => pending.push(resolve)),
      }),
    );

    const firstShow = board.show();
    const firstBuildId = (board as unknown as { activeBuildId: string }).activeBuildId;
    pending[0]!({ ok: true, result: makeResult() });
    await firstShow;
    board.close();
    const secondShow = board.show();
    const secondBuildId = (board as unknown as { activeBuildId: string }).activeBuildId;
    expect(secondBuildId).not.toBe(firstBuildId);

    board.setBuildProgress({
      type: 'spenders:progress',
      buildId: firstBuildId,
      phase: 'names',
      done: 9,
      total: 10,
    });
    expect(document.querySelector('.chatgoose-board-progress-label')?.textContent).toContain(
      'top-spenders snapshot',
    );

    board.setBuildProgress({
      type: 'spenders:progress',
      buildId: secondBuildId,
      phase: 'names',
      done: 2,
      total: 10,
    });
    expect(document.querySelector('.chatgoose-board-progress-label')?.textContent).toBe(
      'Resolving fan names — 2 of 10…',
    );

    board.close();
    pending[1]!({ ok: true, result: makeResult() });
    await secondShow;
  });

  it('does not open a chat from a stale lazy resolve after close and reopen', async () => {
    let resolveChat!: (response: ResolveFanChatResponse) => void;
    const openChat = vi.fn();
    const result = makeResult({
      entries: [entry('fan-ghost', null, 'Ghost', 900)],
      fanCount: 1,
    });
    const board = new SpendersBoardController(
      makeDeps({
        fetchList: async () => ({ ok: true, result }),
        openChat,
        resolveChat: async () => await new Promise<ResolveFanChatResponse>((resolve) => {
          resolveChat = resolve;
        }),
      }),
    );
    await board.show();
    rows()[0]!.click();

    board.close();
    await board.show();
    resolveChat({ ok: true, groupId: 'stale-group' });
    await Promise.resolve();

    expect(openChat).not.toHaveBeenCalled();
  });

  it('does not open a chat from a lazy resolve started before Refresh', async () => {
    let resolveChat!: (response: ResolveFanChatResponse) => void;
    const openChat = vi.fn();
    const fetchList = vi.fn(async () => ({
      ok: true,
      result: makeResult({
        entries: [entry('fan-ghost', null, 'Ghost', 900)],
        fanCount: 1,
      }),
    }) as SpendersListResponse);
    const board = new SpendersBoardController(
      makeDeps({
        fetchList,
        openChat,
        resolveChat: async () => await new Promise<ResolveFanChatResponse>((resolve) => {
          resolveChat = resolve;
        }),
      }),
    );
    await board.show();
    rows()[0]!.click();

    const refresh = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Refresh'))!;
    refresh.click();
    await vi.waitFor(() => expect(fetchList).toHaveBeenCalledTimes(2));
    resolveChat({ ok: true, groupId: 'stale-group' });
    await Promise.resolve();

    expect(openChat).not.toHaveBeenCalled();
  });

  it('releases detached row and progress references during a failed Refresh', async () => {
    const entries = Array.from({ length: 500 }, (_, index) =>
      entry(`fan-${index}`, `group-${index}`, `Fan ${index}`, 1000 - index),
    );
    let resolveRefresh!: (response: SpendersListResponse) => void;
    const fetchList = vi.fn(async (refresh: boolean) => {
      if (!refresh) {
        return { ok: true, result: makeResult({ entries, fanCount: entries.length }) } as const;
      }
      return await new Promise<SpendersListResponse>((resolve) => {
        resolveRefresh = resolve;
      });
    });
    const board = new SpendersBoardController(makeDeps({ fetchList }));
    await board.show();
    expect(rows()).toHaveLength(500);

    const refresh = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('Refresh'))!;
    refresh.click();
    const internals = board as unknown as {
      rowEls: HTMLElement[];
      visibleEntries: SpenderListEntry[];
      rowCache: Map<string, HTMLElement>;
      listHost: HTMLElement | null;
      searchInput: HTMLInputElement | null;
      chatStateChips: Map<string, HTMLElement>;
      tierChips: Map<string, HTMLElement>;
      progressLabel: HTMLElement | null;
      progressBar: HTMLElement | null;
    };
    expect(internals.rowEls).toHaveLength(0);
    expect(internals.visibleEntries).toHaveLength(0);
    expect(internals.rowCache.size).toBe(0);
    expect(internals.listHost).toBeNull();
    expect(internals.searchInput).toBeNull();
    expect(internals.chatStateChips.size).toBe(0);
    expect(internals.tierChips.size).toBe(0);

    resolveRefresh({ ok: false, error: createUserError('hub_request_failed') });
    await vi.waitFor(() => {
      expect(document.querySelector('.chatgoose-board-state')?.textContent).toContain(
        'Agency Hub request failed',
      );
    });
    expect(internals.progressLabel).toBeNull();
    expect(internals.progressBar).toBeNull();
  });

  it('renders an error state when the request fails', async () => {
    const board = new SpendersBoardController(
      makeDeps({ fetchList: async () => ({ ok: false, error: createUserError('not_connected') }) }),
    );
    await board.show();

    expect(rows()).toHaveLength(0);
    const state = document.querySelector('.chatgoose-board-state');
    expect(state).not.toBeNull();
  });
});
