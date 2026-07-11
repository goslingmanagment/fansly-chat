// The Spenders board — a body-anchored, full-screen overlay that survives
// fansly.com route changes (it is NOT mounted in the per-conversation root the
// way the AI surfaces are). It ranks the creator's fans by lifetime spend,
// grouped into client-side tiers, and opens a fan's chat on click/Enter.
//
// Data comes from the background `getSpendersList` request (injected as
// `fetchList` for testability); navigation is injected as `openChat`. Entries
// without an enumerated conversation (groupId null, E23) resolve their chat
// lazily through the injected `resolveChat` when opened.

import {
  assignSpenderTier,
  countByTier,
  filterSpendersByQuery,
  formatMonthDelta,
  formatSpenderAmount,
  getSpenderTier,
  groupSpendersByTier,
  isNewSpender,
  SPENDER_TIERS,
  sortByLifetimeDesc,
  type SpenderTierId,
} from '../../shared/spenders.js';
import type {
  ResolveFanChatResponse,
  SpenderListEntry,
  SpendersListResponse,
  SpendersListResult,
} from '../../shared/types.js';
import { formatUserFacingError } from '../../shared/errors.js';
import { makeKbd } from '../ui/kbd.js';

export interface SpendersBoardDeps {
  fetchList: (refresh: boolean) => Promise<SpendersListResponse>;
  openChat: (groupId: string) => void;
  resolveChat: (entry: SpenderListEntry) => Promise<ResolveFanChatResponse>;
}

type ActiveTier = 'all' | SpenderTierId;

// The board can only re-read the hub's latest snapshot; the hub itself walks
// Fansly on its own schedule. Said once, in the meta line's tooltip, so a
// stale "data as of" never reads as a broken Refresh button.
const FRESHNESS_TOOLTIP =
  'Spend data comes from the Agency Hub, which re-reads Fansly earnings on ' +
  'a schedule (roughly hourly to daily). Refresh re-fetches the latest hub ' +
  'snapshot — it cannot make the hub re-walk Fansly.';

const NO_CHAT_TOOLTIP =
  'Not among your most-recent conversations — opening will search the inbox ' +
  'for this fan.';

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
  const source = entry.customName || entry.displayName || entry.username || '?';
  const parts = source.trim().split(/\s+/).slice(0, 2);
  const letters = parts.map((part) => part.charAt(0)).join('');
  return (letters || source.charAt(0) || '?').toUpperCase();
}

/** The chatter's own name for the fan wins — it is the name the team
 * actually recognizes (E25); platform names are the fallback. */
function entryName(entry: SpenderListEntry): string {
  return entry.customName || entry.displayName || entry.username || entry.fanAccountId;
}

function relativeTime(builtAt: number): string {
  const diffMs = Math.max(0, Date.now() - builtAt);
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export class SpendersBoardController {
  private readonly root = ensureBoardRoot();
  private open = false;
  private loading = false;
  private result: SpendersListResult | null = null;
  private activeTier: ActiveTier = 'all';
  private searchQuery = '';
  private cursorIndex = -1;
  private visibleEntries: SpenderListEntry[] = [];
  private rowEls: HTMLElement[] = [];
  private listHost: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private readonly chatStateChips = new Map<string, HTMLElement>();
  private resolvingFanId: string | null = null;

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
    this.listHost = null;
    this.searchInput = null;
    this.chatStateChips.clear();
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
        this.searchQuery = '';
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
    if (this.result && this.result.builtAt !== null) {
      sub.title = FRESHNESS_TOOLTIP;
    }
    titleWrap.append(title, sub);

    const actions = document.createElement('div');
    actions.className = 'chatgoose-board-actions';

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'chatgoose-board-action';
    refresh.textContent = '↻ Refresh';
    refresh.title = FRESHNESS_TOOLTIP;
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
    const shown = result.entries.length;
    // fanCount is the kernel's full spender total; when the query limit
    // truncates the list, say so instead of passing the cut off as the total.
    const head =
      result.fanCount > shown
        ? `top ${shown} of ${result.fanCount} spenders`
        : `${shown} spender${shown === 1 ? '' : 's'}`;
    return [
      head,
      `data as of ${relativeTime(result.builtAt)}`,
      `fetched ${relativeTime(result.fetchedAt)}`,
    ].join(' · ');
  }

  private renderLoading(refresh: boolean): void {
    const body = document.createElement('div');
    body.className = 'chatgoose-board-state';
    body.textContent = refresh
      ? 'Rebuilding the board…'
      : 'Building the board — fetching the top-spenders snapshot…';
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
    this.listHost = listHost;
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
      makeKbd('/'),
      document.createTextNode(' search · '),
      makeKbd('Esc'),
      document.createTextNode(' close'),
    );
    body.append(footer);

    this.shell(body);
    this.renderList();
  }

  /** (Re)fill the list host for the current tier + search query. Kept apart
   * from renderBoard so typing in the search box never rebuilds the input
   * it is typing into. */
  private renderList(): void {
    const result = this.result;
    const listHost = this.listHost;
    if (!result || !listHost) return;

    this.rowEls = [];
    this.visibleEntries = [];
    this.chatStateChips.clear();
    listHost.replaceChildren();

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
      empty.textContent = 'No paying fans in the hub data for this page yet.';
      listHost.append(empty);
    } else {
      const matched = filterSpendersByQuery(result.entries, this.searchQuery);
      if (matched.length === 0) {
        const none = document.createElement('div');
        none.className = 'chatgoose-board-state';
        none.textContent = 'No fans match the search.';
        listHost.append(none);
      } else if (this.activeTier === 'all') {
        for (const group of groupSpendersByTier(matched)) {
          listHost.append(this.buildSectionHeader(group.tier.emoji, group.tier.title, group.tier.band, group.entries.length));
          for (const entry of group.entries) {
            listHost.append(this.buildRow(entry));
          }
        }
      } else {
        const tier = getSpenderTier(this.activeTier);
        const activeTier = this.activeTier;
        const entries = sortByLifetimeDesc(
          matched.filter((entry) => assignSpenderTier(entry.lifetimeUsd) === activeTier),
        );
        listHost.append(this.buildSectionHeader(tier.emoji, tier.title, tier.band, entries.length));
        for (const entry of entries) {
          listHost.append(this.buildRow(entry));
        }
      }
    }

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

    this.searchInput = null;
    if (entries.length > 0) {
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'chatgoose-board-search';
      search.placeholder = 'Search fans…';
      search.setAttribute('aria-label', 'Search fans by name or username');
      search.value = this.searchQuery;
      search.addEventListener('input', () => {
        this.searchQuery = search.value;
        this.renderList();
      });
      this.searchInput = search;
      chips.append(search);
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
    const nameLine = document.createElement('div');
    nameLine.className = 'chatgoose-board-row-nameline';
    const name = document.createElement('div');
    name.className = 'chatgoose-board-row-name';
    name.textContent = entryName(entry);
    nameLine.append(name);
    if (isNewSpender(entry.lifetimeUsd, entry.monthUsd)) {
      const fresh = document.createElement('span');
      fresh.className = 'chatgoose-board-row-new';
      fresh.textContent = 'NEW';
      fresh.title = 'First spend this month';
      nameLine.append(fresh);
    }
    if (entry.groupId === null) {
      const chatState = document.createElement('span');
      chatState.className = 'chatgoose-board-row-chatstate';
      chatState.textContent = 'no recent chat';
      chatState.title = NO_CHAT_TOOLTIP;
      this.chatStateChips.set(entry.fanAccountId, chatState);
      nameLine.append(chatState);
    }
    const handle = document.createElement('div');
    handle.className = 'chatgoose-board-row-handle';
    handle.textContent = entry.username ? `@${entry.username}` : '';
    main.append(nameLine, handle);

    const amounts = document.createElement('div');
    amounts.className = 'chatgoose-board-row-amounts';
    const amount = document.createElement('div');
    amount.className = 'chatgoose-board-row-amount';
    amount.textContent = formatSpenderAmount(entry.lifetimeUsd);
    amounts.append(amount);
    const delta = formatMonthDelta(entry.monthUsd);
    if (delta) {
      const deltaEl = document.createElement('div');
      deltaEl.className = 'chatgoose-board-row-delta';
      deltaEl.textContent = delta;
      deltaEl.title = this.result?.monthWindow
        ? `This month (${this.result.monthWindow})`
        : 'This month';
      amounts.append(deltaEl);
    }

    row.append(avatar, main, amounts);
    row.addEventListener('click', () => {
      this.cursorIndex = index;
      this.applyCursor(false);
      this.openEntry(entry);
    });

    this.rowEls.push(row);
    return row;
  }

  // ─── Opening chats ──────────────────────────────────────────────────────

  private openEntry(entry: SpenderListEntry): void {
    if (entry.groupId) {
      this.deps.openChat(entry.groupId);
      return;
    }
    // E23 lazy resolve: one inbox search per open, one at a time.
    if (this.resolvingFanId !== null) return;
    this.resolvingFanId = entry.fanAccountId;
    this.setChatState(entry.fanAccountId, 'locating…', null);
    void this.deps
      .resolveChat(entry)
      .then((response) => {
        if (!this.open) return;
        if (response.ok && response.groupId) {
          // Memoize on the entry so a second open skips the search (the
          // content-side result is this board's own structured-clone copy).
          entry.groupId = response.groupId;
          this.deps.openChat(response.groupId);
          return;
        }
        this.setChatState(
          entry.fanAccountId,
          'not found',
          response.ok
            ? 'The inbox search found no conversation with this fan.'
            : formatUserFacingError(response.error),
        );
      })
      .catch(() => {
        if (!this.open) return;
        this.setChatState(entry.fanAccountId, 'not found', 'Could not search the inbox.');
      })
      .finally(() => {
        this.resolvingFanId = null;
      });
  }

  private setChatState(fanAccountId: string, label: string, title: string | null): void {
    const chip = this.chatStateChips.get(fanAccountId);
    if (!chip) return;
    chip.textContent = label;
    if (title !== null) {
      chip.title = title;
    }
  }

  // ─── Cursor / keyboard ──────────────────────────────────────────────────

  private handleKeydown(event: KeyboardEvent): void {
    if (!this.open) return;

    // Typing in the search box: letters filter (j/k must not move the
    // cursor); Esc clears-then-closes; Enter opens the top match; arrows
    // still steer the cursor.
    if (this.searchInput !== null && event.target === this.searchInput) {
      switch (event.key) {
        case 'Escape':
          event.preventDefault();
          if (this.searchInput.value) {
            this.searchInput.value = '';
            this.searchQuery = '';
            this.renderList();
          } else {
            this.close();
          }
          return;
        case 'Enter':
          event.preventDefault();
          this.openCursorEntry();
          return;
        case 'ArrowDown':
        case 'ArrowUp':
          event.preventDefault();
          this.moveCursor(event.key === 'ArrowDown' ? 1 : -1);
          return;
        default:
          return;
      }
    }

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
      case '/':
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        this.searchInput?.focus();
        return;
      case 'Enter':
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        this.openCursorEntry();
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

  private openCursorEntry(): void {
    const entry = this.visibleEntries[this.cursorIndex];
    if (!entry) return;
    this.openEntry(entry);
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
