// The Spenders board — a body-anchored, full-screen overlay that survives
// fansly.com route changes (it is NOT mounted in the per-conversation root the
// way the AI surfaces are). It ranks the creator's fans by lifetime spend,
// grouped into client-side tiers, and opens a fan's chat on click/Enter.
//
// Data comes from the background `getSpendersList` request (injected as
// `fetchList` for testability); navigation is injected as `openChat`.

import {
  assignSpenderTier,
  countByTier,
  formatSpenderAmount,
  getSpenderTier,
  groupSpendersByTier,
  SPENDER_TIERS,
  sortByLifetimeDesc,
  type SpenderTierId,
} from '../../shared/spenders.js';
import type {
  SpenderListEntry,
  SpendersListResponse,
  SpendersListResult,
} from '../../shared/types.js';
import { formatUserFacingError } from '../../shared/errors.js';
import { makeKbd } from '../ui/kbd.js';

export interface SpendersBoardDeps {
  fetchList: (refresh: boolean) => Promise<SpendersListResponse>;
  openChat: (groupId: string) => void;
}

type ActiveTier = 'all' | SpenderTierId;

function ensureBoardRoot(): HTMLElement {
  let root = document.getElementById('chatgoose-board-root');
  if (!(root instanceof HTMLElement)) {
    root = document.createElement('div');
    root.id = 'chatgoose-board-root';
    document.body.append(root);
  }
  return root;
}

function initials(entry: SpenderListEntry): string {
  const source = entry.displayName || entry.username || '?';
  const parts = source.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part.charAt(0)).join('');
  return (letters || source.charAt(0) || '?').toUpperCase();
}

function entryName(entry: SpenderListEntry): string {
  return entry.displayName || entry.username || entry.fanAccountId;
}

function relativeTime(builtAt: number): string {
  const diffMs = Math.max(0, Date.now() - builtAt);
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  return `${hours}h ago`;
}

export class SpendersBoardController {
  private readonly root = ensureBoardRoot();
  private open = false;
  private loading = false;
  private result: SpendersListResult | null = null;
  private activeTier: ActiveTier = 'all';
  private cursorIndex = -1;
  private visibleEntries: SpenderListEntry[] = [];
  private rowEls: HTMLElement[] = [];

  constructor(private readonly deps: SpendersBoardDeps) {
    document.addEventListener('keydown', (event) => this.handleKeydown(event));
  }

  isOpen(): boolean {
    return this.open;
  }

  toggle(): void {
    if (this.open) {
      this.close();
    } else {
      void this.show();
    }
  }

  async show(): Promise<void> {
    this.open = true;
    document.body.classList.add('chatgoose-scroll-lock');
    // W9.3/A20: a not-ramped result (builtAt null) is a live question, not a
    // snapshot — re-ask on every open so the board flips the moment rankings
    // are enabled kernel-side (the background skips its 10-min cache too).
    if (this.result && this.result.builtAt !== null) {
      this.renderBoard();
    } else {
      await this.load(false);
    }
  }

  close(): void {
    this.open = false;
    this.cursorIndex = -1;
    document.body.classList.remove('chatgoose-scroll-lock');
    this.root.replaceChildren();
  }

  private async load(refresh: boolean): Promise<void> {
    this.loading = true;
    this.renderLoading(refresh);
    try {
      const response = await this.deps.fetchList(refresh);
      if (!this.open) return;
      this.loading = false;
      if (response.ok) {
        this.result = response.result;
        this.activeTier = 'all';
        this.renderBoard();
      } else {
        this.renderError(formatUserFacingError(response.error));
      }
    } catch (error) {
      if (!this.open) return;
      this.loading = false;
      this.renderError(error instanceof Error ? error.message : 'Could not load spenders.');
    }
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  private shell(body: HTMLElement): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'chatgoose-board-backdrop';
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) this.close();
    });

    const panel = document.createElement('div');
    panel.className = 'chatgoose-board-panel';
    panel.append(this.buildHeader(), body);

    backdrop.append(panel);
    this.root.replaceChildren(backdrop);
  }

  private buildHeader(): HTMLElement {
    const header = document.createElement('div');
    header.className = 'chatgoose-board-header';

    const titleWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'chatgoose-board-title';
    title.textContent = 'Spenders';
    const sub = document.createElement('div');
    sub.className = 'chatgoose-board-subtitle';
    sub.textContent = this.result
      ? this.metaLine(this.result)
      : 'Top spenders by lifetime spend';
    titleWrap.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'chatgoose-board-actions';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'chatgoose-board-action';
    refresh.textContent = '↻ Refresh';
    refresh.disabled = this.loading;
    refresh.addEventListener('click', () => {
      void this.load(true);
    });

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chatgoose-board-action';
    close.textContent = 'Close (Esc)';
    close.addEventListener('click', () => this.close());

    actions.append(refresh, close);
    header.append(titleWrap, actions);
    return header;
  }

  private metaLine(result: SpendersListResult): string {
    // W9.3/A20: builtAt === null = the kernel never built a snapshot for
    // this page — claiming a spender count or an "updated …" time would lie.
    if (result.builtAt === null) {
      return 'Rankings not enabled for this page yet';
    }
    const parts = [
      `${result.fanCount} spender${result.fanCount === 1 ? '' : 's'}`,
      `scanned ${result.scannedCount}`,
      `updated ${relativeTime(result.builtAt)}`,
    ];
    if (result.truncated) {
      parts.push(`among most-recent ${result.scannedCount} chats`);
    }
    return parts.join(' · ');
  }

  private renderLoading(refresh: boolean): void {
    const body = document.createElement('div');
    body.className = 'chatgoose-board-state';
    body.textContent = refresh
      ? 'Rebuilding the board…'
      : 'Building the board — fetching lifetime spend per fan. This can take a moment.';
    this.shell(body);
  }

  private renderError(message: string): void {
    const body = document.createElement('div');
    body.className = 'chatgoose-board-state';

    const text = document.createElement('div');
    text.textContent = message;

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'chatgoose-board-action';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => {
      void this.load(false);
    });

    body.append(text, retry);
    this.shell(body);
  }

  private renderBoard(): void {
    const result = this.result;
    if (!result) return;

    const body = document.createElement('div');
    body.className = 'chatgoose-board-body';
    body.append(this.buildChips(result.entries));

    const listHost = document.createElement('div');
    listHost.className = 'chatgoose-board-list';

    this.rowEls = [];
    this.visibleEntries = [];

    if (result.builtAt === null) {
      // Not ramped ≠ zero spenders: the kernel has never walked this page's
      // earnings, so "no paying fans" would be false. Honest copy instead.
      const notRamped = document.createElement('div');
      notRamped.className = 'chatgoose-board-state';
      notRamped.textContent =
        "Spender rankings aren't enabled for this page yet. Ask the owner to enable it in the Agency Hub — until then the board has no data to show.";
      listHost.append(notRamped);
    } else if (result.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chatgoose-board-state';
      empty.textContent = 'No paying fans found in the scanned conversations yet.';
      listHost.append(empty);
    } else if (this.activeTier === 'all') {
      for (const group of groupSpendersByTier(result.entries)) {
        listHost.append(this.buildSectionHeader(group.tier.emoji, group.tier.title, group.tier.band, group.entries.length));
        for (const entry of group.entries) {
          listHost.append(this.buildRow(entry));
        }
      }
    } else {
      const tier = getSpenderTier(this.activeTier);
      const activeTier = this.activeTier;
      const entries = sortByLifetimeDesc(
        result.entries.filter((entry) => assignSpenderTier(entry.lifetimeUsd) === activeTier),
      );
      listHost.append(this.buildSectionHeader(tier.emoji, tier.title, tier.band, entries.length));
      for (const entry of entries) {
        listHost.append(this.buildRow(entry));
      }
    }

    body.append(listHost);

    const footer = document.createElement('div');
    footer.className = 'chatgoose-board-footer';
    footer.append(
      makeKbd('J'),
      document.createTextNode(' '),
      makeKbd('K'),
      document.createTextNode(' move · '),
      makeKbd('Enter'),
      document.createTextNode(' open chat · '),
      makeKbd('Esc'),
      document.createTextNode(' close'),
    );
    body.append(footer);

    this.shell(body);
    this.cursorIndex = this.visibleEntries.length > 0 ? 0 : -1;
    this.applyCursor(false);
  }

  private buildChips(entries: readonly SpenderListEntry[]): HTMLElement {
    const chips = document.createElement('div');
    chips.className = 'chatgoose-board-chips';

    const counts = countByTier(entries);
    chips.append(this.buildChip('all', 'All', counts.all));
    for (const tier of SPENDER_TIERS) {
      const count = counts.byTier[tier.id];
      if (count > 0) {
        chips.append(this.buildChip(tier.id, `${tier.emoji} ${tier.title}`, count));
      }
    }
    return chips;
  }

  private buildChip(tier: ActiveTier, label: string, count: number): HTMLElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chatgoose-board-chip';
    if (this.activeTier === tier) {
      chip.classList.add('chatgoose-board-chip-active');
    }

    const text = document.createElement('span');
    text.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'chatgoose-board-chip-count';
    badge.textContent = String(count);

    chip.append(text, badge);
    chip.addEventListener('click', () => {
      if (this.activeTier === tier) return;
      this.activeTier = tier;
      this.renderBoard();
    });
    return chip;
  }

  private buildSectionHeader(emoji: string, title: string, band: string, count: number): HTMLElement {
    const header = document.createElement('div');
    header.className = 'chatgoose-board-section';

    const left = document.createElement('span');
    left.className = 'chatgoose-board-section-title';
    left.textContent = `${emoji} ${title}`;

    const mid = document.createElement('span');
    mid.className = 'chatgoose-board-section-band';
    mid.textContent = band;

    const right = document.createElement('span');
    right.className = 'chatgoose-board-section-count';
    right.textContent = String(count);

    header.append(left, mid, right);
    return header;
  }

  private buildRow(entry: SpenderListEntry): HTMLElement {
    const index = this.visibleEntries.length;
    this.visibleEntries.push(entry);

    const row = document.createElement('div');
    row.className = 'chatgoose-board-row';
    row.setAttribute('role', 'button');
    row.tabIndex = -1;

    const avatar = document.createElement('div');
    avatar.className = 'chatgoose-board-avatar';
    avatar.textContent = initials(entry);

    const main = document.createElement('div');
    main.className = 'chatgoose-board-row-main';
    const name = document.createElement('div');
    name.className = 'chatgoose-board-row-name';
    name.textContent = entryName(entry);
    const handle = document.createElement('div');
    handle.className = 'chatgoose-board-row-handle';
    handle.textContent = entry.username ? `@${entry.username}` : '';
    main.append(name, handle);

    const amount = document.createElement('div');
    amount.className = 'chatgoose-board-row-amount';
    amount.textContent = formatSpenderAmount(entry.lifetimeUsd);

    row.append(avatar, main, amount);
    row.addEventListener('click', () => {
      this.cursorIndex = index;
      this.applyCursor(false);
      this.deps.openChat(entry.groupId);
    });

    this.rowEls.push(row);
    return row;
  }

  // ─── Cursor / keyboard ──────────────────────────────────────────────────

  private handleKeydown(event: KeyboardEvent): void {
    if (!this.open) return;
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        this.close();
        return;
      case 'j':
      case 'J':
      case 'ArrowDown':
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        this.moveCursor(1);
        return;
      case 'k':
      case 'K':
      case 'ArrowUp':
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        this.moveCursor(-1);
        return;
      case 'Enter':
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        this.openCursor(event);
        return;
      default:
        return;
    }
  }

  private moveCursor(delta: number): void {
    if (this.visibleEntries.length === 0) return;
    const next = this.cursorIndex < 0
      ? (delta > 0 ? 0 : this.visibleEntries.length - 1)
      : (this.cursorIndex + delta + this.visibleEntries.length) % this.visibleEntries.length;
    this.cursorIndex = next;
    this.applyCursor(true);
  }

  private openCursor(event: KeyboardEvent): void {
    const entry = this.visibleEntries[this.cursorIndex];
    if (!entry) return;
    event.preventDefault();
    this.deps.openChat(entry.groupId);
  }

  private applyCursor(scroll: boolean): void {
    this.rowEls.forEach((el, index) => {
      el.classList.toggle('chatgoose-board-row-active', index === this.cursorIndex);
    });
    if (scroll && this.cursorIndex >= 0) {
      this.rowEls[this.cursorIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }
}
