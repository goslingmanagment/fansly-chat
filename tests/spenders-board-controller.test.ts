import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

import { SpendersBoardController } from '../src/content/spenders/spenders-board-controller.js';
import { createUserError } from '../src/shared/errors.js';
import type {
  SpenderListEntry,
  SpendersListResponse,
  SpendersListResult,
} from '../src/shared/types.js';

function entry(
  fanAccountId: string,
  groupId: string,
  displayName: string | null,
  lifetimeUsd: number,
): SpenderListEntry {
  return {
    fanAccountId,
    groupId,
    displayName,
    username: displayName ? displayName.toLowerCase() : null,
    lifetimeMills: lifetimeUsd * 1000,
    lifetimeUsd,
  };
}

function makeResult(): SpendersListResult {
  return {
    entries: [
      entry('fan-1', 'group-1', 'Jonathan', 1078),
      entry('fan-2', 'group-2', 'Charles', 700),
      entry('fan-3', 'group-3', 'Ricky', 200),
      entry('fan-4', 'group-4', 'Brad', 40),
    ],
    builtAt: Date.now(),
    fanCount: 4,
    scannedCount: 120,
    truncated: false,
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
    const board = new SpendersBoardController({ fetchList, openChat: vi.fn() });

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
    const board = new SpendersBoardController({
      fetchList: async () => ({ ok: true, result: makeResult() }),
      openChat,
    });
    await board.show();

    rows()[1]!.click();
    expect(openChat).toHaveBeenCalledWith('group-2');
  });

  it('walks rows with J/K and opens the cursor row on Enter', async () => {
    const openChat = vi.fn();
    const board = new SpendersBoardController({
      fetchList: async () => ({ ok: true, result: makeResult() }),
      openChat,
    });
    await board.show();

    pressKey('j'); // 0 -> 1 (cursor starts at 0)
    pressKey('j'); // 1 -> 2
    pressKey('Enter');
    expect(openChat).toHaveBeenCalledWith('group-3');
  });

  it('closes on Escape', async () => {
    const board = new SpendersBoardController({
      fetchList: async () => ({ ok: true, result: makeResult() }),
      openChat: vi.fn(),
    });
    await board.show();
    expect(board.isOpen()).toBe(true);

    pressKey('Escape');
    expect(board.isOpen()).toBe(false);
    expect(rows()).toHaveLength(0);
  });

  it('filters to a single tier when a tier chip is clicked', async () => {
    const board = new SpendersBoardController({
      fetchList: async () => ({ ok: true, result: makeResult() }),
      openChat: vi.fn(),
    });
    await board.show();

    const whaleChip = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.chatgoose-board-chip'),
    ).find((c) => c.textContent?.includes('Whale'))!;
    whaleChip.click();

    expect(rows()).toHaveLength(2);
    expect(document.querySelectorAll('.chatgoose-board-section')).toHaveLength(1);
  });

  it('renders an error state when the request fails', async () => {
    const board = new SpendersBoardController({
      fetchList: async () => ({ ok: false, error: createUserError('not_connected') }),
      openChat: vi.fn(),
    });
    await board.show();

    expect(rows()).toHaveLength(0);
    const state = document.querySelector('.chatgoose-board-state');
    expect(state).not.toBeNull();
  });
});
