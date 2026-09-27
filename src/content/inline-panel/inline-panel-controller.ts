import { FEATURE_LABELS } from '../../shared/constants.js';
import { ChatGooseError, toUserError } from '../../shared/errors.js';
import type {
  LlmSpendSummary,
  CompareInlineTabState,
  CompareInlineViewModel,
  FeatureType,
  InlinePanelViewModel,
  OverlayInsertPart,
  OverlayViewModel,
  UserFacingError,
} from '../../shared/types.js';
import {
  formatCacheEffectInline,
  formatSpendPrimary,
  formatSpendSecondary,
} from '../spend-format.js';
import { parseGroupIdFromPath } from '../route-watcher.js';
import { insertIntoFanslyTextarea, copyToClipboard, focusActiveConversationTextarea } from '../textarea.js';
import {
  createSplitContractNote,
  createUserErrorBlock,
  formatLoadingStatus,
  getInsertButtonLabel,
  getNextInsertablePart,
  getReplyPartTitle,
  getSplitContractNote,
  getSplitPartCardOptions,
  insertedFeedbackDelayMs,
  isEditableElement,
  isInsertFeedbackActive,
  isInteractiveElement,
} from '../ui/view-helpers.js';

interface InlinePanelCallbacks {
  onClose: () => void;
  /** A reference surface above the reply owns Enter/Escape while open. */
  isKeyboardBlocked?: () => boolean;
  onExpand: () => void;
  onCancel: (operationId: string) => void;
  onRerun: (feature: FeatureType) => void;
  onCompareRerun: () => void;
  onCompareTabSelect: (cardId: string) => void;
  /** Stage 32 Task 5: chatter took a suggestion (acceptance telemetry). */
  onAcceptance?: (operationId: string, action: 'copied' | 'inserted', partIndex: number) => void;
}

interface InlinePanelRenderOptions {
  preserveInlineError?: boolean;
}

interface LoadingViewState {
  kind: 'loading';
  operationId: string;
  root: HTMLElement;
  statusText: Text;
  streamText: Text;
}

interface StaticViewState {
  kind: 'reply' | 'error';
  operationId: string | null;
  root: HTMLElement;
}

interface CompareTabButtonView {
  button: HTMLButtonElement;
  label: HTMLSpanElement;
  labelText: Text;
  currentBadge: HTMLSpanElement | null;
  spinner: HTMLSpanElement | null;
}

interface CompareLoadingActiveView {
  kind: 'loading';
  cardId: string;
  root: HTMLElement;
  statusText: Text;
  streamText: Text;
}

interface CompareStaticActiveView {
  kind: 'reply' | 'error';
  cardId: string;
  root: HTMLElement;
  renderKey: string;
}

type CompareActiveView = CompareLoadingActiveView | CompareStaticActiveView;

interface CompareViewState {
  kind: 'compare';
  operationId: string | null;
  tabsIdentity: CompareInlineTabState[];
  root: HTMLElement;
  waiting: HTMLDivElement;
  waitingText: Text;
  summary: HTMLDivElement;
  summaryText: Text;
  tabsRoot: HTMLDivElement;
  tabButtons: Map<string, CompareTabButtonView>;
  activeHost: HTMLDivElement;
  activeViews: Map<string, CompareActiveView>;
  actions: HTMLDivElement;
  cancelButton: HTMLButtonElement;
  rerunButton: HTMLButtonElement;
}

type InlineViewState = LoadingViewState | StaticViewState | CompareViewState;

function reconcileChildren(parent: HTMLElement, desired: readonly Node[]): void {
  let cursor = parent.firstChild;
  for (const node of desired) {
    if (cursor === node) {
      cursor = cursor.nextSibling;
      continue;
    }
    parent.insertBefore(node, cursor);
  }

  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
}

function formatCompareSummary(tabs: CompareInlineTabState[]): string | null {
  const currentCount = tabs.filter((tab) => tab.source === 'current').length;
  const draftCount = tabs.filter((tab) => tab.source === 'draft').length;

  if (currentCount > 0 && draftCount > 0) {
    return `Comparing current + ${draftCount} draft${draftCount === 1 ? '' : 's'}`;
  }

  if (draftCount > 0) {
    return `Comparing ${draftCount} draft${draftCount === 1 ? '' : 's'}`;
  }

  if (currentCount > 0) {
    return 'Comparing current';
  }

  return null;
}

export class InlinePanelController {
  readonly root: HTMLDivElement;
  private readonly headerEl: HTMLDivElement;
  private readonly headerInfoEl: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly metaEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private readonly expandButton: HTMLButtonElement;
  private currentView: InlineViewState | null = null;
  private model: InlinePanelViewModel = { kind: 'hidden' };
  private inlineError: UserFacingError | null = null;
  private lastFocusedReplyOpId: string | null = null;
  private loadingStatusTimer: number | null = null;
  private headerMetaSignature: string | null = null;

  constructor(private readonly callbacks: InlinePanelCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'chatgoose-inline-panel chatgoose-hidden';

    // Header
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'chatgoose-inline-panel-header';

    this.headerInfoEl = document.createElement('div');
    this.headerInfoEl.className = 'chatgoose-inline-panel-header-info';

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'chatgoose-inline-panel-title';

    this.metaEl = document.createElement('div');
    this.metaEl.className = 'chatgoose-inline-panel-meta chatgoose-hidden';

    const actions = document.createElement('div');
    actions.className = 'chatgoose-inline-panel-actions';

    this.expandButton = document.createElement('button');
    this.expandButton.type = 'button';
    this.expandButton.className = 'chatgoose-inline-panel-action';
    this.expandButton.textContent = '\u2197';
    this.expandButton.title = 'Expand';
    this.expandButton.addEventListener('click', () => this.callbacks.onExpand());

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chatgoose-inline-panel-action';
    close.textContent = '\u00d7';
    close.title = 'Close';
    close.addEventListener('click', () => this.callbacks.onClose());

    actions.append(this.expandButton, close);
    this.headerInfoEl.append(this.titleEl, this.metaEl);
    this.headerEl.append(this.headerInfoEl, actions);

    // Body
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'chatgoose-inline-panel-body';

    this.root.append(this.headerEl, this.bodyEl);

    // Escape handler with scope guard
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || event.isComposing || this.callbacks.isKeyboardBlocked?.()) return;
      if (event.key === 'Escape' && this.model.kind !== 'hidden' && !this.root.classList.contains('chatgoose-hidden')) {
        if (isEditableElement(document.activeElement)) return;
        this.callbacks.onClose();
      }
    });

    // Enter-to-insert for completed fast replies
    document.addEventListener('keydown', (event) => {
      if (this.callbacks.isKeyboardBlocked?.()) {
        // Returning alone leaves native keyboard activation on a focused Insert
        // button alive. Cancel that default as well as the global shortcut.
        if ((event.key === 'Enter' || event.key === ' ') &&
          this.root.contains(document.activeElement)) event.preventDefault();
        return;
      }
      if (
        event.key !== 'Enter' || event.defaultPrevented || this.callbacks.isKeyboardBlocked?.() ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
        event.repeat || event.isComposing
      ) return;
      if (this.model.kind !== 'reply') return;
      if (this.root.classList.contains('chatgoose-hidden')) return;
      // Reply parts and Split Fix parts (E142) share the Enter-inserts-next flow.
      if ('feature' in this.model && this.model.feature !== 'fast-reply' && this.model.feature !== 'improve-draft') return;
      if (isEditableElement(document.activeElement)) return;
      if (isInteractiveElement(document.activeElement)) return;
      if (
        document.activeElement &&
        document.activeElement !== document.body &&
        !this.root.contains(document.activeElement)
      ) return;
      const parts = this.model.parts;
      const next = getNextInsertablePart(parts);
      if (!next) return;
      event.preventDefault();
      void this.insertPart(next);
    });
  }

  render(model: InlinePanelViewModel, options?: InlinePanelRenderOptions): void {
    if (model.kind === 'hidden') {
      this.hide();
      return;
    }

    if (model.kind !== 'loading') {
      this.clearLoadingStatusTimer();
    }

    this.model = model;

    if (model.kind === 'error') {
      this.inlineError = null;
    } else if (!options?.preserveInlineError) {
      this.inlineError = null;
    }

    // Update header
    const featureLabel = model.kind === 'compare'
      ? 'Compare'
      : ('feature' in model ? FEATURE_LABELS[model.feature] ?? model.feature : 'ChatGoose');
    const fanDisplayName = 'fanDisplayName' in model ? model.fanDisplayName : 'fan';
    const titleText = `${featureLabel} — @${fanDisplayName || 'fan'}`;
    if (this.titleEl.textContent !== titleText) {
      this.titleEl.textContent = titleText;
    }
    this.expandButton.style.display = model.kind === 'compare' ? 'none' : '';
    this.renderHeaderMeta(model);

    // Show panel
    this.root.classList.remove('chatgoose-hidden');

    // Render body
    this.renderBody(model);
  }

  hide(): void {
    if (
      this.model.kind === 'hidden' &&
      this.currentView === null &&
      this.root.classList.contains('chatgoose-hidden')
    ) {
      return;
    }
    this.model = { kind: 'hidden' };
    this.currentView = null;
    this.inlineError = null;
    this.lastFocusedReplyOpId = null;
    this.clearLoadingStatusTimer();
    this.bodyEl.replaceChildren();
    this.root.classList.add('chatgoose-hidden');
  }

  private renderBody(model: Exclude<InlinePanelViewModel, { kind: 'hidden' }>): void {
    // Smart diff for loading: update in-place if same operationId
    if (
      model.kind === 'loading' &&
      this.currentView?.kind === 'loading' &&
      this.currentView.operationId === model.operationId
    ) {
      this.updateLoadingView(this.currentView, model);
      return;
    }

    if (
      model.kind === 'compare' &&
      this.currentView?.kind === 'compare' &&
      this.canUpdateCompareView(this.currentView, model)
    ) {
      this.updateCompareView(this.currentView, model);
      return;
    }

    let view: InlineViewState;
    if (model.kind === 'loading') {
      view = this.createLoadingView(model);
    } else if (model.kind === 'compare') {
      view = this.createCompareView(model);
    } else if (model.kind === 'reply') {
      view = {
        kind: 'reply',
        operationId: model.operationId,
        root: this.renderReplyBody(model),
      };
    } else if (model.kind === 'error') {
      view = {
        kind: 'error',
        operationId: model.operationId,
        root: this.renderErrorBody(model),
      };
    } else {
      // helpMe, readOnly — shouldn't appear in inline, but handle gracefully
      return;
    }

    this.bodyEl.replaceChildren(view.root);
    this.currentView = view;

    // Auto-focus the first Insert button for newly visible completed fast replies
    // and Split Fix parts (E142)
    if (
      model.kind === 'reply' &&
      'feature' in model && (model.feature === 'fast-reply' || model.feature === 'improve-draft') &&
      model.operationId !== this.lastFocusedReplyOpId
    ) {
      this.lastFocusedReplyOpId = model.operationId;
      queueMicrotask(() => {
        const btn = view.root.querySelector<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button');
        btn?.focus();
      });
    }
  }

  private renderHeaderMeta(
    model: Exclude<InlinePanelViewModel, { kind: 'hidden' }>,
  ): void {
    if (model.kind === 'compare' || model.kind === 'coach' || model.kind === 'recap-picker') {
      // Coach and the Recap start dialog never surface inline (overlay-only, spec
      // §10/§5) and carry no spend meta; guard so the widened OverlayViewModel
      // union typechecks here.
      if (this.headerMetaSignature !== null || this.metaEl.childNodes.length > 0) {
        this.metaEl.replaceChildren();
      }
      this.headerMetaSignature = null;
      this.metaEl.classList.add('chatgoose-hidden');
      return;
    }

    const spend = model.llmSpend;
    if (!spend) {
      if (this.headerMetaSignature !== null || this.metaEl.childNodes.length > 0) {
        this.metaEl.replaceChildren();
      }
      this.headerMetaSignature = null;
      this.metaEl.classList.add('chatgoose-hidden');
      return;
    }

    this.setHeaderMetaContent(spend);
    this.metaEl.classList.remove('chatgoose-hidden');
  }

  private setHeaderMetaContent(spend: LlmSpendSummary): void {
    const primaryText = formatSpendPrimary(spend);
    const secondaryText = formatSpendSecondary(spend);
    const cacheEffect = formatCacheEffectInline(spend);
    const signature = `${primaryText}\u0000${secondaryText}\u0000` +
      `${cacheEffect?.kind ?? ''}\u0000${cacheEffect?.text ?? ''}`;
    if (signature === this.headerMetaSignature) {
      return;
    }
    this.headerMetaSignature = signature;

    const primary = document.createElement('div');
    primary.className = 'chatgoose-inline-panel-meta-primary';
    primary.textContent = primaryText;

    if (cacheEffect) {
      primary.append(
        document.createTextNode(' · '),
        (() => {
          const span = document.createElement('span');
          span.className = `chatgoose-spend-cache-${cacheEffect.kind}`;
          span.textContent = cacheEffect.text;
          return span;
        })(),
      );
    }

    primary.title = secondaryText;
    this.metaEl.replaceChildren(primary);
  }

  private createSpendStrip(
    spend?: LlmSpendSummary,
    placeholder = false,
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatgoose-spend-strip chatgoose-spend-strip-inline';

    const primary = document.createElement('div');
    primary.className = 'chatgoose-spend-strip-primary';

    const secondary = document.createElement('div');
    secondary.className = 'chatgoose-spend-strip-secondary';

    if (!spend && placeholder) {
      section.classList.add('chatgoose-spend-strip-pending');
      primary.textContent = 'Cost pending · Usage pending';
      secondary.textContent = 'in — · write — · read — · out —';
      section.append(primary, secondary);
      return section;
    }

    if (!spend) {
      return section;
    }

    primary.textContent = formatSpendPrimary(spend);
    const cacheEffect = formatCacheEffectInline(spend);
    if (cacheEffect) {
      primary.append(
        document.createTextNode(' · '),
        (() => {
          const span = document.createElement('span');
          span.className = `chatgoose-spend-cache-${cacheEffect.kind}`;
          span.textContent = cacheEffect.text;
          return span;
        })(),
      );
    }

    secondary.textContent = formatSpendSecondary(spend);

    section.append(primary, secondary);
    return section;
  }

  // ─── Loading ─────────────────────────────────────────────────────────

  private createLoadingView(model: Extract<OverlayViewModel, { kind: 'loading' }>): LoadingViewState {
    const section = document.createElement('div');
    section.className = 'chatgoose-grid';

    const status = document.createElement('div');
    status.className = 'chatgoose-overlay-status';
    const statusText = document.createTextNode('');
    status.append(statusText);

    const stream = document.createElement('div');
    stream.className = 'chatgoose-stream chatgoose-stream-live';
    const streamText = document.createTextNode('');
    stream.append(streamText);

    const actions = document.createElement('div');
    actions.className = 'chatgoose-card-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'chatgoose-button chatgoose-button-danger';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => {
      if (this.model.kind === 'loading') {
        this.callbacks.onCancel(this.model.operationId);
      }
    });
    actions.append(cancel);

    section.append(status, stream, actions);

    const view: LoadingViewState = {
      kind: 'loading',
      operationId: model.operationId,
      root: section,
      statusText,
      streamText,
    };
    this.updateLoadingView(view, model);
    return view;
  }

  private updateLoadingView(
    view: LoadingViewState,
    model: Extract<OverlayViewModel, { kind: 'loading' }>,
  ): void {
    const statusText = formatLoadingStatus(model.progress);
    const streamText = model.rawText || 'Waiting for AI\u2026';
    if (view.statusText.data !== statusText) {
      view.statusText.data = statusText;
    }
    if (view.streamText.data !== streamText) {
      view.streamText.data = streamText;
    }

    if (typeof model.progress?.retryAtMs === 'number') {
      if (this.loadingStatusTimer === null) {
        this.loadingStatusTimer = window.setInterval(() => {
          if (
            this.currentView?.kind !== 'loading' ||
            this.model.kind !== 'loading'
          ) {
            this.clearLoadingStatusTimer();
            return;
          }
          const nextStatusText = formatLoadingStatus(this.model.progress);
          if (this.currentView.statusText.data !== nextStatusText) {
            this.currentView.statusText.data = nextStatusText;
          }
        }, 250);
      }
    } else {
      this.clearLoadingStatusTimer();
    }
  }

  // ─── Reply ───────────────────────────────────────────────────────────

  private renderReplyBody(model: Extract<OverlayViewModel, { kind: 'reply' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatgoose-grid';

    // Inline error banner (from insert/copy failures)
    if (this.inlineError) {
      section.append(createUserErrorBlock(this.inlineError));
    }

    const splitNote = getSplitContractNote(
      model.splitModeRequested,
      Boolean(model.error),
      model.parts.length,
    );
    if (splitNote) {
      section.append(createSplitContractNote(splitNote));
    }

    if (model.error) {
      section.append(createUserErrorBlock(model.error));
    } else if (model.parts.length > 0) {
      if (model.feature === 'hi-greeting' && model.parts.length > 1) {
        const note = document.createElement('div');
        note.className = 'chatgoose-inline-note';
        note.textContent = 'Choose one greeting.';
        section.append(note);
      }
      const parts = document.createElement('div');
      parts.className = 'chatgoose-parts';
      model.parts.forEach((part) => {
        parts.append(
          this.createPartCard(
            model.feature === 'hi-greeting'
              ? `Variant ${part.sequenceIndex + 1}`
              : getReplyPartTitle(part, model.splitModeRequested),
            part,
            {
              ...getSplitPartCardOptions(part, model.splitModeRequested, model.parts.length),
              status: part.insertedOnce ? 'Inserted earlier.' : undefined,
            },
          ),
        );
      });
      section.append(parts);
    } else {
      const raw = document.createElement('div');
      raw.className = 'chatgoose-stream';
      raw.textContent = model.rawText;
      section.append(raw);
    }

    // Regenerate
    const actions = document.createElement('div');
    actions.className = 'chatgoose-card-actions';
    if (model.rerunActionLabel) {
      const rerun = document.createElement('button');
      rerun.type = 'button';
      rerun.className = 'chatgoose-button';
      rerun.textContent = model.rerunActionLabel;
      rerun.addEventListener('click', () => this.callbacks.onRerun(model.feature));
      actions.append(rerun);
    }
    section.append(actions);

    return section;
  }

  private canUpdateCompareView(
    view: CompareViewState,
    model: CompareInlineViewModel,
  ): boolean {
    if (view.operationId !== null && model.operationId !== null) {
      return view.operationId === model.operationId;
    }

    // The terminal compare model deliberately drops operationId, but keeps the
    // exact tabs array from the live model. That identity is the hand-off fence:
    // it lets the last loading view become completed in place without treating a
    // different cached completed Compare (also operationId=null) as the same run.
    return view.tabsIdentity === model.tabs;
  }

  private createCompareView(model: CompareInlineViewModel): CompareViewState {
    const root = document.createElement('div');
    root.className = 'chatgoose-grid';

    const waiting = document.createElement('div');
    waiting.className = 'chatgoose-stream';
    const waitingText = document.createTextNode('');
    waiting.append(waitingText);

    const summary = document.createElement('div');
    summary.className = 'chatgoose-compare-summary';
    const summaryText = document.createTextNode('');
    summary.append(summaryText);

    const tabsRoot = document.createElement('div');
    tabsRoot.className = 'chatgoose-compare-tabs';

    // This host is stable for the whole Compare operation. Switching cards or
    // moving loading → reply/error replaces only its child view; streaming
    // updates mutate the existing Text nodes below it.
    const activeHost = document.createElement('div');
    activeHost.className = 'chatgoose-compare-active';

    const actions = document.createElement('div');
    actions.className = 'chatgoose-card-actions';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'chatgoose-button chatgoose-button-danger';
    cancelButton.textContent = 'Cancel all';
    cancelButton.addEventListener('click', () => {
      if (this.model.kind === 'compare' && this.model.operationId) {
        this.callbacks.onCancel(this.model.operationId);
      }
    });

    const rerunButton = document.createElement('button');
    rerunButton.type = 'button';
    rerunButton.className = 'chatgoose-button';
    rerunButton.textContent = 'Regenerate all';
    rerunButton.addEventListener('click', () => this.callbacks.onCompareRerun());

    const view: CompareViewState = {
      kind: 'compare',
      operationId: model.operationId,
      tabsIdentity: model.tabs,
      root,
      waiting,
      waitingText,
      summary,
      summaryText,
      tabsRoot,
      tabButtons: new Map(),
      activeHost,
      activeViews: new Map(),
      actions,
      cancelButton,
      rerunButton,
    };
    this.updateCompareView(view, model);
    return view;
  }

  private updateCompareView(
    view: CompareViewState,
    model: CompareInlineViewModel,
  ): void {
    view.operationId = model.operationId;
    view.tabsIdentity = model.tabs;

    if (model.tabs.length === 0) {
      const waiting = model.progress?.message ?? 'Preparing compare…';
      if (view.waitingText.data !== waiting) {
        view.waitingText.data = waiting;
      }
      this.updateCompareTabButtons(view, model.tabs, null);
      this.updateCompareActiveView(view, model, null);
      reconcileChildren(view.actions, []);
      reconcileChildren(view.root, [view.waiting]);
      return;
    }

    const activeTab =
      model.tabs.find((tab) => tab.cardId === model.activeCardId) ??
      model.tabs[0] ??
      null;
    const effectiveActiveCardId = activeTab?.cardId ?? null;

    const summary = formatCompareSummary(model.tabs);
    if (summary !== null && view.summaryText.data !== summary) {
      view.summaryText.data = summary;
    }

    this.updateCompareTabButtons(view, model.tabs, effectiveActiveCardId);
    this.updateCompareActiveView(view, model, activeTab);

    const actionNodes: Node[] = [];
    if (model.canCancel && model.operationId) {
      actionNodes.push(view.cancelButton);
    }
    if (model.canRegenerate) {
      actionNodes.push(view.rerunButton);
    }
    reconcileChildren(view.actions, actionNodes);

    const rootNodes: Node[] = [];
    if (summary !== null) {
      rootNodes.push(view.summary);
    }
    rootNodes.push(view.tabsRoot);
    if (activeTab) {
      rootNodes.push(view.activeHost);
    }
    if (actionNodes.length > 0) {
      rootNodes.push(view.actions);
    }
    reconcileChildren(view.root, rootNodes);
  }

  private updateCompareTabButtons(
    view: CompareViewState,
    tabs: CompareInlineTabState[],
    activeCardId: string | null,
  ): void {
    const liveIds = new Set(tabs.map((tab) => tab.cardId));
    for (const [cardId, tabView] of view.tabButtons) {
      if (!liveIds.has(cardId)) {
        tabView.button.remove();
        view.tabButtons.delete(cardId);
        view.activeViews.delete(cardId);
      }
    }

    const desiredButtons: Node[] = [];
    for (const tab of tabs) {
      let tabView = view.tabButtons.get(tab.cardId);
      if (!tabView) {
        tabView = this.createCompareTabButton(tab.cardId);
        view.tabButtons.set(tab.cardId, tabView);
      }

      if (tabView.labelText.data !== tab.label) {
        tabView.labelText.data = tab.label;
      }

      if (tab.source === 'current' && !tabView.currentBadge) {
        const badge = document.createElement('span');
        badge.className = 'chatgoose-compare-tab-badge';
        badge.textContent = 'Current';
        tabView.currentBadge = badge;
      } else if (tab.source !== 'current' && tabView.currentBadge) {
        tabView.currentBadge = null;
      }

      if (tab.status === 'loading' && !tabView.spinner) {
        const spinner = document.createElement('span');
        spinner.className = 'chatgoose-spinner';
        tabView.spinner = spinner;
      } else if (tab.status !== 'loading' && tabView.spinner) {
        tabView.spinner = null;
      }

      const isActive = tab.cardId === activeCardId;
      tabView.button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      tabView.button.classList.toggle('chatgoose-compare-tab-active', isActive);
      reconcileChildren(
        tabView.button,
        [
          tabView.label,
          ...(tabView.currentBadge ? [tabView.currentBadge] : []),
          ...(tabView.spinner ? [tabView.spinner] : []),
        ],
      );
      desiredButtons.push(tabView.button);
    }

    reconcileChildren(view.tabsRoot, desiredButtons);
  }

  private createCompareTabButton(cardId: string): CompareTabButtonView {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chatgoose-compare-tab';
    button.addEventListener('click', () => this.callbacks.onCompareTabSelect(cardId));

    const label = document.createElement('span');
    const labelText = document.createTextNode('');
    label.append(labelText);
    button.append(label);

    return {
      button,
      label,
      labelText,
      currentBadge: null,
      spinner: null,
    };
  }

  private updateCompareActiveView(
    view: CompareViewState,
    model: CompareInlineViewModel,
    tab: CompareInlineTabState | null,
  ): void {
    if (!tab) {
      reconcileChildren(view.activeHost, []);
      return;
    }

    const activeView = view.activeViews.get(tab.cardId);
    if (
      tab.status === 'loading' &&
      activeView?.kind === 'loading'
    ) {
      const status = model.progress?.message ?? 'Generating…';
      const stream = tab.rawText || 'Waiting for AI…';
      if (activeView.statusText.data !== status) {
        activeView.statusText.data = status;
      }
      if (activeView.streamText.data !== stream) {
        activeView.streamText.data = stream;
      }
      reconcileChildren(view.activeHost, [activeView.root]);
      return;
    }

    const renderKey = this.compareStaticActiveRenderKey(tab);
    if (
      tab.status !== 'loading' &&
      activeView?.kind === tab.status &&
      activeView.renderKey === renderKey
    ) {
      reconcileChildren(view.activeHost, [activeView.root]);
      return;
    }

    const root = this.renderCompareActiveTab(model, tab);
    let nextView: CompareActiveView;
    if (tab.status === 'loading') {
      const status = root.querySelector('.chatgoose-overlay-status')?.firstChild;
      const stream = root.querySelector('.chatgoose-stream-live')?.firstChild;
      if (!(status instanceof Text) || !(stream instanceof Text)) {
        throw new Error('Compare loading view is missing its text nodes');
      }
      nextView = {
        kind: 'loading',
        cardId: tab.cardId,
        root,
        statusText: status,
        streamText: stream,
      };
    } else {
      nextView = {
        kind: tab.status,
        cardId: tab.cardId,
        root,
        renderKey,
      };
    }

    view.activeViews.set(tab.cardId, nextView);
    reconcileChildren(view.activeHost, [root]);
  }

  private compareStaticActiveRenderKey(tab: CompareInlineTabState): string {
    // Compare tabs are small, plain-data view models. A compact structural key
    // is much cheaper than rebuilding completed cards whenever an *inactive*
    // tab streams another chunk, while still repainting insert feedback, spend,
    // split guidance, or an error change.
    return JSON.stringify([tab, this.inlineError]);
  }

  private renderCompareActiveTab(
    model: CompareInlineViewModel,
    tab: CompareInlineTabState,
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatgoose-grid';

    if (this.inlineError) {
      section.append(createUserErrorBlock(this.inlineError));
    }

    if (tab.status === 'loading') {
      section.append(this.createSpendStrip(undefined, true));
      const status = document.createElement('div');
      status.className = 'chatgoose-overlay-status';
      status.textContent = model.progress?.message ?? 'Generating…';
      const stream = document.createElement('div');
      stream.className = 'chatgoose-stream chatgoose-stream-live';
      stream.textContent = tab.rawText || 'Waiting for AI…';
      section.append(status, stream);
      return section;
    }

    if (tab.status === 'error') {
      const spend = tab.llmSpend;
      if (spend) {
        section.append(this.createSpendStrip(spend));
      }
      section.append(createUserErrorBlock(tab.error ?? toUserError(null)));
      return section;
    }

    const spend = tab.llmSpend;
    if (spend) {
      section.append(this.createSpendStrip(spend));
    }

    const splitNote = getSplitContractNote(tab.splitModeRequested, false, tab.parts.length);
    if (splitNote) {
      section.append(createSplitContractNote(splitNote));
    }

    if (tab.parts.length > 0) {
      const parts = document.createElement('div');
      parts.className = 'chatgoose-parts';
      tab.parts.forEach((part) => {
        parts.append(
          this.createPartCard(
            getReplyPartTitle(part, tab.splitModeRequested),
            part,
            {
              ...getSplitPartCardOptions(part, tab.splitModeRequested, tab.parts.length),
              status: part.insertedOnce ? 'Inserted earlier.' : undefined,
            },
          ),
        );
      });
      section.append(parts);
      return section;
    }

    const raw = document.createElement('div');
    raw.className = 'chatgoose-stream';
    raw.textContent = tab.rawText;
    section.append(raw);
    return section;
  }

  private createPartCard(
    title: string,
    part: OverlayInsertPart,
    options: { hint?: string; emphasis?: 'recommended' | 'followup'; status?: string } = {},
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'chatgoose-card';
    if (options.emphasis === 'recommended') {
      card.classList.add('chatgoose-card-recommended');
    } else if (options.emphasis === 'followup') {
      card.classList.add('chatgoose-card-followup');
    }

    // Header row: title + hint + status + actions on one line
    const headerRow = document.createElement('div');
    headerRow.className = 'chatgoose-card-header-row';

    const label = document.createElement('span');
    label.className = 'chatgoose-card-title';
    label.textContent = title;
    headerRow.append(label);

    if (options.hint) {
      const hint = document.createElement('span');
      hint.className = 'chatgoose-card-hint';
      hint.textContent = options.hint;
      headerRow.append(hint);
    }

    if (options.status) {
      const statusEl = document.createElement('span');
      statusEl.className = 'chatgoose-card-status';
      statusEl.textContent = options.status;
      headerRow.append(statusEl);
    }

    const actions = document.createElement('div');
    actions.className = 'chatgoose-card-actions';

    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'chatgoose-button';
    insert.textContent = getInsertButtonLabel(part);
    insert.disabled = isInsertFeedbackActive(part);
    insert.addEventListener('click', () => {
      void this.insertPart(part);
    });

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'chatgoose-button chatgoose-button-secondary';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      if (this.callbacks.isKeyboardBlocked?.()) return;
      const actionModel = this.model;
      try {
        await copyToClipboard(part.text);
        if ('operationId' in actionModel && typeof actionModel.operationId === 'string') {
          this.callbacks.onAcceptance?.(actionModel.operationId, 'copied', part.sequenceIndex);
        }
        if (this.model !== actionModel) return;
        this.inlineError = null;
        this.render(this.model);
      } catch (error) {
        if (this.model !== actionModel) return;
        this.inlineError = toUserError(error);
        this.render(this.model, { preserveInlineError: true });
      }
    });

    actions.append(insert, copy);
    headerRow.append(actions);

    const text = document.createElement('div');
    text.className = 'chatgoose-card-text chatgoose-card-text-insertable';
    text.textContent = part.text;
    text.title = 'Click to insert';
    text.addEventListener('click', () => {
      // Selecting draft text (to copy a fragment) must not fire an insert.
      if (window.getSelection()?.toString()) {
        return;
      }
      void this.insertPart(part);
    });

    card.append(headerRow, text);
    return card;
  }

  private async insertPart(part: OverlayInsertPart): Promise<void> {
    if (this.callbacks.isKeyboardBlocked?.()) return;
    const actionModel = this.model;
    try {
      // LIVE route check (mirrors the overlay/coach guards): the polled route
      // lags a chat switch by up to 500ms — never insert into a foreign chat.
      const mintedGroupId = 'groupId' in this.model ? this.model.groupId : null;
      if (mintedGroupId !== null &&
        parseGroupIdFromPath(window.location.pathname) !== mintedGroupId) {
        throw new ChatGooseError('chat_changed');
      }
      await insertIntoFanslyTextarea(part.text);
      part.insertedOnce = true;
      part.insertedAt = Date.now();
      if ('operationId' in actionModel && typeof actionModel.operationId === 'string') {
        this.callbacks.onAcceptance?.(actionModel.operationId, 'inserted', part.sequenceIndex);
      }
      // Clipboard/insertion completion may arrive after a chat or result switch.
      // Attribute the action to its original operation and leave the new UI alone.
      if (this.model !== actionModel) {
        part.insertedAt = null;
        return;
      }
      this.inlineError = null;
      this.render(this.model);
      this.scheduleInsertedReset(part);
      this.queueComposerFocus();
    } catch (error) {
      if (this.model !== actionModel) return;
      this.inlineError = toUserError(error);
      this.render(this.model, { preserveInlineError: true });
    }
  }

  private scheduleInsertedReset(part: OverlayInsertPart): void {
    window.setTimeout(() => {
      part.insertedAt = null;
      if (this.model.kind !== 'hidden') {
        this.render(this.model);
      }
    }, insertedFeedbackDelayMs());
  }

  private queueComposerFocus(): void {
    window.requestAnimationFrame(() => {
      focusActiveConversationTextarea();
    });
  }

  private clearLoadingStatusTimer(): void {
    if (this.loadingStatusTimer === null) {
      return;
    }
    window.clearInterval(this.loadingStatusTimer);
    this.loadingStatusTimer = null;
  }

  // ─── Error ───────────────────────────────────────────────────────────

  private renderErrorBody(model: Extract<OverlayViewModel, { kind: 'error' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatgoose-grid';

    section.append(createUserErrorBlock(model.error));

    const actions = document.createElement('div');
    actions.className = 'chatgoose-card-actions';
    const rerun = document.createElement('button');
    rerun.type = 'button';
    rerun.className = 'chatgoose-button';
    rerun.textContent = 'Regenerate';
    rerun.addEventListener('click', () => this.callbacks.onRerun(model.feature));
    actions.append(rerun);
    section.append(actions);

    return section;
  }
}
