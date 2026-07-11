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
): SpenderListEntry {
  return {
    fanAccountId,
    groupId,
    displayName,
    username: displayName ? displayName.toLowerCase() : null,
    lifetimeMills: lifetimeUsd * 1000,
    lifetimeUsd,
    monthMills: monthUsd === null ? null : monthUsd * 1000,
    monthUsd,
  };
}

function makeResult(overrides: Partial<SpendersListResult> = {}): SpendersListResult {
  return {
    entries: [
      entry('fan-1', 'group-1', 'Jonathan', 1078),
      entry('fan-2', 'group-2', 'Charles', 700),
      entry('fan-3', 'group-3', 'Ricky', 200),
      entry('fan-4', 'group-4', 'Brad', 40),
    ],
    builtAt: Date.now(),
    fanCount: 4,
    monthWindow: null,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

function makeDeps(overrides: {
  fetchList?: (refresh: boolean) => Promise<SpendersListResponse>;
  openChat?: (groupId: string) => void;
  resolveChat?: (entry: SpenderListEntry) => Promise<ResolveFanChatResponse>;
} = {}) {
  return {
    fetchList:
      overrides.fetchList ??
      (async () => ({ ok: true, result: makeResult() }) as SpendersListResponse),
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
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetches on open and renders rows grouped by tier with chips', async () => {
    const fetchList = vi.fn<(refresh: boolean) => Promise<SpendersListResponse>>(
      async () => ({ ok: true, result: makeResult() }),
    );
    const board = new SpendersBoardController(makeDeps({ fetchList }));

    await board.show();

    expect(fetchList).toHaveBeenCalledWith(false);
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

    rows()[1]!.click();
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

    pressKey('Escape');
    expect(board.isOpen()).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('filters to a single tier when a tier chip is clicked', async () => {
    const board = new SpendersBoardController(makeDeps());
    await board.show();

    const whaleChip = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-board-chip'),
    ).find((c) => c.textContent?.includes('Whale'))!;
    whaleChip.click();

    expect(rows()).toHaveLength(2);
    expect(document.querySelectorAll('.chatgoose-board-section')).toHaveLength(1);
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
      'no recent chat',
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
    typeSearch('rick');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.querySelector('.chatgoose-board-row-name')!.textContent).toBe('Ricky');
    // The input element itself survives the list re-render (focus keeper).
    expect(document.querySelector('.chatgoose-board-search')).toBe(input);

    typeSearch('');
    expect(rows()).toHaveLength(4);
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
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(openChat).toHaveBeenCalledWith('group-2');
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
    expect(subtitle.textContent).toContain('data as of 7h ago');
    expect(subtitle.textContent).toContain('fetched just now');
    expect(subtitle.textContent).not.toContain('scanned');
    // The freshness story lives in the tooltip.
    expect(subtitle.getAttribute('title')).toContain('Agency Hub');
  });

  // ── W9.3/A20: not-ramped page (builtAt null) ─────────────────────────────

  it('renders the not-enabled state for a null builtAt, not "no paying fans"', async () => {
    const notRamped = makeResult({ entries: [], builtAt: null, fanCount: 0 });
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

  it('re-fetches on every open while not ramped (no sticky in-memory result)', async () => {
    const notRamped = makeResult({ entries: [], builtAt: null, fanCount: 0 });
    const fetchList = vi.fn<(refresh: boolean) => Promise<SpendersListResponse>>(
      async () => ({ ok: true, result: notRamped }),
    );
    const board = new SpendersBoardController(makeDeps({ fetchList }));

    await board.show();
    board.close();
    await board.show();
    expect(fetchList).toHaveBeenCalledTimes(2);

    // A ramped result IS kept across open/close (existing behavior).
    fetchList.mockResolvedValue({ ok: true, result: makeResult() });
    board.close();
    await board.show();
    expect(fetchList).toHaveBeenCalledTimes(3);
    board.close();
    await board.show();
    expect(fetchList).toHaveBeenCalledTimes(3);
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
