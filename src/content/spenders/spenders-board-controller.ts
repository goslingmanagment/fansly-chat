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
  formatTierAwareSpenderAmount,
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
  SpendersProgressPayload,
  SpendersSnapshotPayload,
  SpendersStreamState,
  UserFacingError,
} from '../../shared/types.js';
import {
  formatUserErrorPlainText,
  toUserError,
} from '../../shared/errors.js';
import { createUserErrorBlock } from '../ui/view-helpers.js';
import { makeKbd } from '../ui/kbd.js';

export interface SpendersBoardDeps {
  fetchList: (refresh: boolean, buildId: string) => Promise<SpendersListResponse>;
  /** Stable only while the connected creator + Hub source context is unchanged. */
  getContextKey: () => string | null;
  openChat: (groupId: string) => void;
  resolveChat: (entry: SpenderListEntry) => Promise<ResolveFanChatResponse>;
}

type ActiveTier = 'all' | SpenderTierId;

// The board can only re-read the hub's latest snapshot; the hub itself walks
// Fansly on its own schedule. Said once, in the meta line's tooltip, so a
// stale freshness never reads as a broken Refresh button. `builtAt` is the
// newest observation in the page/window projection, not a coherent timestamp
// for every shown row (and not necessarily one of the returned top N).
const FRESHNESS_TOOLTIP =
  'Spend data comes from the Agency Hub, which re-reads Fansly earnings on ' +
  'a schedule (roughly hourly to daily). Refresh re-fetches the latest hub ' +
  'snapshot — it cannot make the hub re-walk Fansly. The freshness value is ' +
  'the newest Hub observation for this page and window, not a timestamp shared ' +
  'by the shown rows; individual rows may be older.';

const NO_CHAT_TOOLTIP =
  'A direct chat link is unavailable — opening will search the inbox for this fan.';

/** One line per stream state. "source paused" used to stand for all three, so
 *  a chatter could not tell "the owner disabled the projection" from "this page
 *  was left out of the allowlist" from "this platform is unsupported" — and the
 *  matching amber row in the options pane read like an access denial. Reading
 *  is never gated: rows keep showing, they just stop being refreshed. */
function feedStateLabel(state: SpendersStreamState): string | null {
  switch (state) {
    case 'ramped':
      return null;
    case 'flag_off':
      return 'not updating: spender projection is off in the Hub';
    case 'not_allowlisted':
      return 'not updating: this page is not in the Hub allowlist';
    case 'unsupported_platform':
      return 'not updating: unsupported platform';
  }
}

const SEARCH_RENDER_DELAY_MS = 150;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function firstGrapheme(value: string): string {
  const iterator = GRAPHEME_SEGMENTER.segment(value)[Symbol.iterator]();
  return iterator.next().value?.segment ?? '';
}

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
  const letters = parts.map(firstGrapheme).join('');
  return (letters || firstGrapheme(source) || '?').toUpperCase();
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
  private readonly rowCache = new Map<string, HTMLElement>();
  private listHost: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;
  private buildProgress: SpendersProgressPayload | null = null;
  private progressLabel: HTMLElement | null = null;
  private progressBar: HTMLElement | null = null;
  private readonly chatStateChips = new Map<string, HTMLElement>();
  private readonly tierChips = new Map<ActiveTier, HTMLButtonElement>();
  private searchRenderTimer: number | null = null;
  private resolvingFanId: string | null = null;
  private loadGeneration = 0;
  private resolveGeneration = 0;
  private buildCounter = 0;
  private activeBuildId: string | null = null;
  private hasPreliminaryResult = false;
  private pendingListRequest: {
    buildId: string;
    contextKey: string;
    promise: Promise<SpendersListResponse>;
  } | null = null;

  constructor(private readonly deps: SpendersBoardDeps) {
    document.addEventListener('keydown', (event) => this.handleKeydown(event));
  }

  isOpen(): boolean {
    return this.open;
  }

  /** Account/Hub source changed under this content script. A board from the
   * previous context must neither remain visible nor be reused on reopen. */
  invalidateContext(): void {
    this.pendingListRequest = null;
    this.hasPreliminaryResult = false;
    this.result = null;
    if (this.open) this.close();
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
    // The background owns the 10-minute cache. Always ask it on open so a
    // content-script instance cannot pin a result for the lifetime of a tab.
    await this.load(false);
  }

  close(): void {
    this.open = false;
    this.loading = false;
    this.loadGeneration += 1;
    this.resolveGeneration += 1;
    this.activeBuildId = null;
    this.resolvingFanId = null;
    this.releaseListReferences();
    this.buildProgress = null;
    this.releaseProgressReferences();
    document.body.classList.remove('chatgoose-scroll-lock');
    this.root.replaceChildren();
  }

  /** Cold-build progress pushed from the background over the content port
   * (the board's own request is one-shot, so it has no channel). Ignored
   * unless a build is actually on screen. */
  setBuildProgress(progress: SpendersProgressPayload): void {
    if (
      !this.open ||
      !this.loading ||
      progress.buildId === undefined ||
      progress.buildId !== this.activeBuildId
    ) return;
    this.buildProgress = progress;
    this.renderProgress();
  }

  /** Lifetime ranking is usable before optional enrichment completes. Keep
   * the request alive, but replace the spinner with interactive rows. */
  setBuildSnapshot(snapshot: SpendersSnapshotPayload): void {
    if (
      !this.open ||
      !this.loading ||
      snapshot.buildId === undefined ||
      snapshot.buildId !== this.activeBuildId
    ) return;
    const firstSnapshot = !this.hasPreliminaryResult;
    this.hasPreliminaryResult = true;
    this.result = snapshot.result;
    if (firstSnapshot) {
      this.activeTier = 'all';
      this.searchQuery = '';
    }
    this.releaseListReferences();
    this.releaseProgressReferences();
    this.renderBoard();
  }

  private async load(refresh: boolean): Promise<void> {
    const generation = ++this.loadGeneration;
    // A new result invalidates any lazy lookup started from the old rows.
    this.resolveGeneration += 1;
    this.resolvingFanId = null;
    this.releaseListReferences();
    this.releaseProgressReferences();

    const contextKey = this.deps.getContextKey();
    let request = !refresh && contextKey !== null &&
      this.pendingListRequest?.contextKey === contextKey
      ? this.pendingListRequest
      : null;
    const buildId = request?.buildId ?? `board-${Date.now()}-${++this.buildCounter}`;
    this.activeBuildId = buildId;
    this.loading = true;
    this.buildProgress = null;
    if (request !== null && this.hasPreliminaryResult && this.result !== null) {
      this.renderBoard();
    } else {
      this.hasPreliminaryResult = false;
      this.result = null;
      this.renderLoading(refresh);
    }
    try {
      if (request === null) {
        request = {
          buildId,
          contextKey: contextKey ?? `unresolved-${buildId}`,
          promise: this.deps.fetchList(refresh, buildId),
        };
        this.pendingListRequest = request;
      }
      const response = await request.promise;
      if (!this.open || generation !== this.loadGeneration) return;
      if (this.deps.getContextKey() !== contextKey) {
        this.close();
        return;
      }
      this.loading = false;
      this.activeBuildId = null;
      this.buildProgress = null;
      this.releaseProgressReferences();
      if (response.ok) {
        const enrichInPlace = this.hasPreliminaryResult;
        this.hasPreliminaryResult = false;
        this.result = response.result;
        if (!enrichInPlace) {
          this.activeTier = 'all';
          this.searchQuery = '';
        }
        if (!enrichInPlace || !this.renderEnrichedBoardInPlace()) {
          this.releaseListReferences();
          this.renderBoard();
        }
      } else {
        this.hasPreliminaryResult = false;
        this.renderError(response.error);
      }
    } catch (error) {
      if (!this.open || generation !== this.loadGeneration) return;
      this.loading = false;
      this.activeBuildId = null;
      this.buildProgress = null;
      this.hasPreliminaryResult = false;
      this.releaseProgressReferences();
      this.renderError(toUserError(error));
    } finally {
      if (request !== null && this.pendingListRequest === request) {
        this.pendingListRequest = null;
      }
    }
  }

  private releaseListReferences(): void {
    this.cancelSearchRender();
    this.cursorIndex = -1;
    this.visibleEntries = [];
    this.rowEls = [];
    this.rowCache.clear();
    this.listHost = null;
    this.searchInput = null;
    this.chatStateChips.clear();
    this.tierChips.clear();
  }

  private releaseProgressReferences(): void {
    this.progressLabel = null;
    this.progressBar = null;
  }

  // ─── Rendering ──────────────────────────────────────────────────────────

  private shell(body: HTMLElement): void {
    this.cancelSearchRender();
    const entering = this.root.childElementCount === 0;
    const backdrop = document.createElement('div');
    backdrop.className = 'chatgoose-board-backdrop';
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) this.close();
    });

    const panel = document.createElement('div');
    panel.className = 'chatgoose-board-panel';
    if (entering) {
      panel.classList.add('chatgoose-board-panel-enter');
    }
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
    refresh.className = 'chatgoose-board-action chatgoose-board-refresh';
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
    if (result.entries.length === 0) {
      switch (result.source.streamState) {
        case 'flag_off':
          return 'Spender rankings are disabled in the Agency Hub';
        case 'not_allowlisted':
          return 'Rankings not enabled for this page yet';
        case 'unsupported_platform':
          return 'Spender rankings are unavailable for this platform';
        case 'ramped': {
          const head = result.source.lastSyncedAt === null
            ? 'Waiting for the first spender sync'
            : `0 spenders · synced ${relativeTime(result.source.lastSyncedAt)}`;
          const failures = result.source.consecutiveFailures ?? 0;
          return failures > 0
            ? `${head} · ${failures} failed sync attempt${failures === 1 ? '' : 's'}`
            : head;
        }
      }
    }
    const shown = result.entries.length;
    // fanCount is the kernel's full spender total; when the query limit
    // truncates the list, say so instead of passing the cut off as the total.
    const head =
      result.fanCount > shown
        ? `top ${shown} of ${result.fanCount} spenders`
        : `${shown} spender${shown === 1 ? '' : 's'}`;
    const parts = [
      head,
      result.builtAt === null
        ? 'no spend observation timestamp'
        : `newest Hub observation ${relativeTime(result.builtAt)}`,
    ];
    if (result.builtAt !== null) {
      parts.push('shown rows may be older');
    }
    parts.push(`fetched ${relativeTime(result.fetchedAt)}`);
    const feedLabel = feedStateLabel(result.source.streamState);
    if (feedLabel !== null) {
      parts.push(feedLabel);
    } else if ((result.source.consecutiveFailures ?? 0) > 0) {
      parts.push(`${result.source.consecutiveFailures} failed sync attempt${result.source.consecutiveFailures === 1 ? '' : 's'}`);
    }
    return parts.join(' · ');
  }

  private renderLoading(refresh: boolean): void {
    const body = document.createElement('div');
    body.className = 'chatgoose-board-state';

    const label = document.createElement('div');
    label.className = 'chatgoose-board-progress-label';
    label.textContent = refresh ? 'Rebuilding the board…' : 'Building the board…';
    this.progressLabel = label;

    // A determinate hairline, filled only once the name sweep reports counts
    // (the kernel snapshot has no honest percentage to show).
    const track = document.createElement('div');
    track.className = 'chatgoose-board-progress-track';
    const bar = document.createElement('div');
    bar.className = 'chatgoose-board-progress-bar';
    bar.style.width = '0%';
    track.append(bar);
    this.progressBar = bar;

    body.append(label, track);
    this.shell(body);
    this.renderProgress();
  }

  /** Repaint the loading copy + bar for the current progress frame. */
  private renderProgress(): void {
    const label = this.progressLabel;
    const bar = this.progressBar;
    if (!label || !bar) return;

    const progress = this.buildProgress;
    if (!progress || progress.phase === 'ranking') {
      label.textContent = this.hasPreliminaryResult
        ? 'Ranking ready — adding month spend, chat links, and fan names…'
        : 'Building the board — fetching the top-spenders snapshot…';
      bar.style.width = '0%';
      return;
    }

    const total = progress.total ?? 0;
    const done = Math.min(progress.done ?? 0, total);
    if (total === 0) {
      label.textContent = 'Building the board — resolving fan names…';
      bar.style.width = '0%';
      return;
    }
    label.textContent = `Resolving fan names — ${done} of ${total}…`;
    bar.style.width = `${Math.round((done / total) * 100)}%`;
  }

  private renderError(error: UserFacingError): void {
    const body = document.createElement('div');
    body.className = 'chatgoose-board-state';

    const errorBlock = createUserErrorBlock(error);

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'chatgoose-board-action';
    retry.textContent = 'Повторить';
    retry.addEventListener('click', () => {
      void this.load(false);
    });

    body.append(errorBlock, retry);
    this.shell(body);
  }

  private renderBoard(): void {
    const result = this.result;
    if (!result) return;

    const body = document.createElement('div');
    body.className = 'chatgoose-board-body';
    if (this.loading) {
      const progress = document.createElement('div');
      progress.className = 'chatgoose-board-progress-inline';
      const label = document.createElement('div');
      label.className = 'chatgoose-board-progress-label';
      const track = document.createElement('div');
      track.className = 'chatgoose-board-progress-track';
      const bar = document.createElement('div');
      bar.className = 'chatgoose-board-progress-bar';
      track.append(bar);
      progress.append(label, track);
      this.progressLabel = label;
      this.progressBar = bar;
      body.append(progress);
      this.renderProgress();
    }
    body.append(this.buildChips(result));

    const listHost = document.createElement('div');
    listHost.className = 'chatgoose-board-list';
    listHost.addEventListener('click', (event) => this.handleListClick(event));
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

    this.renderList();
    this.shell(body);
  }

  /** Replace enrichment-owned data without replacing the controls the chatter
   * is using. A final response may arrive during search input or IME
   * composition; rebuilding the shell would drop focus and the caret. */
  private renderEnrichedBoardInPlace(): boolean {
    const result = this.result;
    const body = this.root.querySelector<HTMLElement>('.chatgoose-board-body');
    if (!result || !body || !this.listHost) {
      return false;
    }

    const selectedFanAccountId =
      this.visibleEntries[this.cursorIndex]?.fanAccountId ?? null;
    const previousCursorIndex = this.cursorIndex;

    body.querySelector('.chatgoose-board-progress-inline')?.remove();
    const subtitle = this.root.querySelector<HTMLElement>('.chatgoose-board-subtitle');
    if (subtitle) {
      subtitle.textContent = this.metaLine(result);
      subtitle.title = result.builtAt === null ? '' : FRESHNESS_TOOLTIP;
    }
    const refresh = this.root.querySelector<HTMLButtonElement>('.chatgoose-board-refresh');
    if (refresh) {
      refresh.disabled = false;
    }

    // Preliminary rows carry null month/chat/name decoration. Rebuild only the
    // list so final values repaint while chips/search DOM and focus stay intact.
    this.rowCache.clear();
    this.renderList({ selectedFanAccountId, previousCursorIndex });
    return true;
  }

  /** (Re)fill the list host for the current tier + search query. Kept apart
   * from renderBoard so typing in the search box never rebuilds the input
   * it is typing into. */
  private renderList(preserveCursor?: {
    selectedFanAccountId: string | null;
    previousCursorIndex: number;
  }): void {
    this.cancelSearchRender();
    const result = this.result;
    const listHost = this.listHost;
    if (!result || !listHost) return;

    const fragment = document.createDocumentFragment();
    const nextRowEls: HTMLElement[] = [];
    const nextVisibleEntries: SpenderListEntry[] = [];
    this.chatStateChips.clear();

    const appendEntry = (entry: SpenderListEntry): void => {
      const index = nextVisibleEntries.length;
      let row = this.rowCache.get(entry.fanAccountId);
      if (!row) {
        row = this.buildRow(entry, index);
        this.rowCache.set(entry.fanAccountId, row);
      } else {
        row.dataset.spenderIndex = String(index);
        row.classList.remove('chatgoose-board-row-active');
        const chatState = row.querySelector<HTMLElement>('.chatgoose-board-row-chatstate');
        if (chatState) this.chatStateChips.set(entry.fanAccountId, chatState);
      }
      nextVisibleEntries.push(entry);
      nextRowEls.push(row);
      fragment.append(row);
    };

    const appendNoMatch = (message: string): void => {
      const none = document.createElement('div');
      none.className = 'chatgoose-board-state';
      none.textContent = message;
      fragment.append(none);
    };

    if (result.entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chatgoose-board-state';
      switch (result.source.streamState) {
        case 'flag_off':
          empty.textContent = 'Spender rankings are disabled in the Agency Hub.';
          break;
        case 'not_allowlisted':
          empty.textContent =
            "Spender rankings aren't enabled for this page yet. Ask the owner to enable them in the Agency Hub.";
          break;
        case 'unsupported_platform':
          empty.textContent = 'Spender rankings are not supported for this platform.';
          break;
        case 'ramped':
          empty.textContent = result.source.lastSyncedAt === null
            ? 'Spender rankings are enabled and waiting for their first sync.'
            : 'No paying fans were found in the latest Hub sync for this page.';
          break;
      }
      fragment.append(empty);
    } else {
      const matched = filterSpendersByQuery(result.entries, this.searchQuery);
      const truncated = result.fanCount > result.entries.length;
      const searchScope = truncated ? `loaded top ${result.entries.length}` : null;
      if (matched.length === 0) {
        appendNoMatch(
          searchScope ? `No fans match in the ${searchScope}.` : 'No fans match the search.',
        );
      } else if (this.activeTier === 'all') {
        const groups = groupSpendersByTier(matched);
        const belowTier = sortByLifetimeDesc(
          matched.filter(
            (entry) =>
              Number.isFinite(entry.lifetimeUsd) &&
              entry.lifetimeUsd > 0 &&
              assignSpenderTier(entry.lifetimeUsd) === null,
          ),
        );
        if (groups.length === 0 && belowTier.length === 0) {
          appendNoMatch(
            this.searchQuery.trim()
              ? searchScope
                ? `No fans match in the ${searchScope}.`
                : 'No fans match the search.'
              : 'No fans fall within the displayed spend tiers.',
          );
        }
        for (const group of groups) {
          fragment.append(this.buildSectionHeader(group.tier.emoji, group.tier.title, group.tier.band, group.entries.length));
          for (const entry of group.entries) {
            appendEntry(entry);
          }
        }
        if (belowTier.length > 0) {
          fragment.append(this.buildSectionHeader('', 'Below $1', '<$1', belowTier.length));
          for (const entry of belowTier) {
            appendEntry(entry);
          }
        }
      } else {
        const tier = getSpenderTier(this.activeTier);
        const activeTier = this.activeTier;
        const entries = sortByLifetimeDesc(
          matched.filter((entry) => assignSpenderTier(entry.lifetimeUsd) === activeTier),
        );
        if (entries.length === 0) {
          appendNoMatch(
            this.searchQuery.trim()
              ? searchScope
                ? `No fans in this tier match within the ${searchScope}.`
                : 'No fans in this tier match the search.'
              : 'No fans in this tier.',
          );
        } else {
          fragment.append(this.buildSectionHeader(tier.emoji, tier.title, tier.band, entries.length));
          for (const entry of entries) {
            appendEntry(entry);
          }
        }
      }
    }

    listHost.replaceChildren(fragment);
    this.rowEls = nextRowEls;
    this.visibleEntries = nextVisibleEntries;
    this.cursorIndex = -1;
    let nextCursorIndex = this.visibleEntries.length > 0 ? 0 : -1;
    if (preserveCursor !== undefined && this.visibleEntries.length > 0) {
      const selectedIndex = preserveCursor.selectedFanAccountId === null
        ? -1
        : this.visibleEntries.findIndex(
          (entry) => entry.fanAccountId === preserveCursor.selectedFanAccountId,
        );
      nextCursorIndex = selectedIndex >= 0
        ? selectedIndex
        : Math.min(
          Math.max(preserveCursor.previousCursorIndex, 0),
          this.visibleEntries.length - 1,
        );
    }
    this.setCursor(nextCursorIndex, false);
  }

  private buildChips(result: SpendersListResult): HTMLElement {
    const entries = result.entries;
    const chips = document.createElement('div');
    chips.className = 'chatgoose-board-chips';
    this.tierChips.clear();

    const counts = countByTier(entries);
    const truncated = result.fanCount > entries.length;
    const scope = truncated
      ? { loaded: entries.length, total: result.fanCount }
      : null;
    chips.append(this.buildChip('all', 'All', counts.all, scope));
    for (const tier of SPENDER_TIERS) {
      const count = counts.byTier[tier.id];
      if (count > 0) {
        chips.append(this.buildChip(tier.id, `${tier.emoji} ${tier.title}`, count, scope));
      }
    }
    if (scope !== null) {
      const scopeNote = document.createElement('span');
      scopeNote.className = 'chatgoose-board-scope';
      scopeNote.textContent =
        `Top ${scope.loaded} loaded of ${scope.total}; search and tier counts use these fans.`;
      chips.append(scopeNote);
    }

    this.searchInput = null;
    if (entries.length > 0) {
      const search = document.createElement('input');
      search.type = 'search';
      search.className = 'chatgoose-board-search';
      search.placeholder = truncated
        ? `Search loaded ${entries.length} fans…`
        : 'Search fans…';
      search.setAttribute(
        'aria-label',
        truncated
          ? `Search the loaded top ${entries.length} of ${result.fanCount} total by name, username, or ID`
          : 'Search fans by name, username, or ID',
      );
      if (truncated) {
        search.title = `Search covers the loaded top ${entries.length} of ${result.fanCount} total spenders.`;
      }
      search.value = this.searchQuery;
      search.addEventListener('compositionstart', () => this.cancelSearchRender());
      search.addEventListener('input', (event) => {
        this.searchQuery = search.value;
        if ((event as InputEvent).isComposing) return;
        this.scheduleSearchRender();
      });
      search.addEventListener('compositionend', () => {
        this.searchQuery = search.value;
        this.scheduleSearchRender();
      });
      this.searchInput = search;
      chips.append(search);
    }
    return chips;
  }

  private buildChip(
    tier: ActiveTier,
    label: string,
    count: number,
    scope: { loaded: number; total: number } | null,
  ): HTMLButtonElement {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chatgoose-board-chip';
    const active = this.activeTier === tier;
    if (active) {
      chip.classList.add('chatgoose-board-chip-active');
    }
    chip.setAttribute('aria-pressed', String(active));
    const countDescription = scope === null
      ? String(count)
      : `${count} within the loaded top ${scope.loaded} of ${scope.total} total`;
    chip.setAttribute('aria-label', `${label}: ${countDescription}`);
    if (scope !== null) {
      chip.title = `${label}: ${countDescription}`;
    }

    const text = document.createElement('span');
    text.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'chatgoose-board-chip-count';
    badge.textContent = String(count);

    chip.append(text, badge);
    this.tierChips.set(tier, chip);
    chip.addEventListener('click', () => {
      if (this.activeTier === tier) return;
      this.activeTier = tier;
      this.updateTierChips();
      // renderList cancels a pending search render and synchronously applies
      // both the latest query and the newly-selected tier in one commit.
      this.renderList();
    });
    return chip;
  }

  private updateTierChips(): void {
    for (const [tier, chip] of this.tierChips) {
      const active = tier === this.activeTier;
      chip.classList.toggle('chatgoose-board-chip-active', active);
      chip.setAttribute('aria-pressed', String(active));
    }
  }

  private buildSectionHeader(emoji: string, title: string, band: string, count: number): HTMLElement {
    const header = document.createElement('div');
    header.className = 'chatgoose-board-section';

    const left = document.createElement('span');
    left.className = 'chatgoose-board-section-title';
    left.textContent = emoji ? `${emoji} ${title}` : title;

    const mid = document.createElement('span');
    mid.className = 'chatgoose-board-section-band';
    mid.textContent = band;

    const right = document.createElement('span');
    right.className = 'chatgoose-board-section-count';
    right.textContent = String(count);

    header.append(left, mid, right);
    return header;
  }

  private buildRow(entry: SpenderListEntry, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'chatgoose-board-row';
    row.setAttribute('role', 'button');
    row.tabIndex = -1;
    row.dataset.spenderIndex = String(index);

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
      chatState.textContent = 'find chat';
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
    amount.textContent = formatTierAwareSpenderAmount(entry.lifetimeMills);
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
    return row;
  }

  private handleListClick(event: MouseEvent): void {
    const target = event.target;
    const listHost = this.listHost;
    if (!(target instanceof HTMLElement) || !listHost) return;
    const row = target.closest<HTMLElement>('.chatgoose-board-row');
    if (!row || !listHost.contains(row)) return;
    const index = Number(row.dataset.spenderIndex);
    if (!Number.isInteger(index)) return;
    const entry = this.visibleEntries[index];
    if (!entry) return;
    this.setCursor(index, false);
    this.openEntry(entry);
  }

  private scheduleSearchRender(): void {
    this.cancelSearchRender();
    this.searchRenderTimer = window.setTimeout(() => {
      this.searchRenderTimer = null;
      if (this.open) {
        this.renderList();
      }
    }, SEARCH_RENDER_DELAY_MS);
  }

  private flushSearchRender(): void {
    if (this.searchRenderTimer === null) return;
    this.cancelSearchRender();
    this.renderList();
  }

  private cancelSearchRender(): void {
    if (this.searchRenderTimer === null) return;
    window.clearTimeout(this.searchRenderTimer);
    this.searchRenderTimer = null;
  }

  // ─── Opening chats ──────────────────────────────────────────────────────

  private openEntry(entry: SpenderListEntry): void {
    if (entry.groupId) {
      this.deps.openChat(entry.groupId);
      return;
    }
    // E23 lazy resolve: one inbox search per open, one at a time.
    if (this.resolvingFanId !== null) return;
    const generation = ++this.resolveGeneration;
    this.resolvingFanId = entry.fanAccountId;
    this.setChatState(entry.fanAccountId, 'locating…', null);
    void this.deps
      .resolveChat(entry)
      .then((response) => {
        if (!this.open || generation !== this.resolveGeneration) return;
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
            : formatUserErrorPlainText(response.error),
        );
      })
      .catch((error: unknown) => {
        if (!this.open || generation !== this.resolveGeneration) return;
        this.setChatState(
          entry.fanAccountId,
          'not found',
          formatUserErrorPlainText(toUserError(error)),
        );
      })
      .finally(() => {
        if (generation === this.resolveGeneration) {
          this.resolvingFanId = null;
        }
      });
  }

  private setChatState(fanAccountId: string, label: string, title: string | null): void {
    // The row may be temporarily filtered out. Update its cached DOM too so a
    // completed lookup cannot reappear later with a stale "locating…" label.
    const chip = this.chatStateChips.get(fanAccountId) ??
      this.rowCache.get(fanAccountId)?.querySelector<HTMLElement>(
        '.chatgoose-board-row-chatstate',
      );
    if (!chip) return;
    chip.textContent = label;
    if (title !== null) {
      chip.title = title;
    }
  }

  // ─── Cursor / keyboard ──────────────────────────────────────────────────

  private handleKeydown(event: KeyboardEvent): void {
    if (!this.open || event.isComposing) return;

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
          if (event.repeat) return;
          event.preventDefault();
          this.flushSearchRender();
          this.openCursorEntry();
          return;
        case 'ArrowDown':
        case 'ArrowUp':
          event.preventDefault();
          this.flushSearchRender();
          this.moveCursor(event.key === 'ArrowDown' ? 1 : -1);
          return;
        default:
          return;
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }

    // Let focused controls keep their native keyboard activation. Without
    // this guard Enter on Refresh/Close/tier chips opened the cursor row.
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest('button, a, input, textarea, select, [contenteditable="true"]')
    ) return;

    switch (event.key) {
      case 'j':
      case 'J':
      case 'ArrowDown':
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        this.flushSearchRender();
        this.moveCursor(1);
        return;
      case 'k':
      case 'K':
      case 'ArrowUp':
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        this.flushSearchRender();
        this.moveCursor(-1);
        return;
      case '/':
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        event.preventDefault();
        this.searchInput?.focus();
        return;
      case 'Enter':
        if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
        event.preventDefault();
        this.flushSearchRender();
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
    this.setCursor(next, true);
  }

  private openCursorEntry(): void {
    const entry = this.visibleEntries[this.cursorIndex];
    if (!entry) return;
    this.openEntry(entry);
  }

  private setCursor(nextIndex: number, scroll: boolean): void {
    const previousIndex = this.cursorIndex;
    if (previousIndex !== nextIndex) {
      this.rowEls[previousIndex]?.classList.remove('chatgoose-board-row-active');
      this.cursorIndex = nextIndex;
      this.rowEls[nextIndex]?.classList.add('chatgoose-board-row-active');
    }
    if (scroll && nextIndex >= 0) {
      this.rowEls[nextIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }
}
