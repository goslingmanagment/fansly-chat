import { FEATURE_LABELS } from '../../shared/constants.js';
import {
  formatUserFacingError,
  getUserErrorDescription,
  toUserError,
} from '../../shared/errors.js';
import type {
  AnthropicSpendSummary,
  CompareInlineTabState,
  CompareInlineViewModel,
  FeatureType,
  InlinePanelViewModel,
  OperationProgressPayload,
  OverlayInsertPart,
  OverlayViewModel,
  UserFacingError,
} from '../../shared/types.js';
import {
  formatCacheEffectInline,
  formatSpendPrimary,
  formatSpendSecondary,
} from '../spend-format.js';
import { insertIntoFanslyTextarea, copyToClipboard, focusActiveConversationTextarea } from '../textarea.js';

interface InlinePanelCallbacks {
  onClose: () => void;
  onExpand: () => void;
  onCancel: (operationId: string) => void;
  onRerun: (feature: FeatureType) => void;
  onCompareRerun: () => void;
  onCompareTabSelect: (cardId: string) => void;
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
  kind: 'reply' | 'error' | 'compare';
  operationId: string | null;
  root: HTMLElement;
}

type InlineViewState = LoadingViewState | StaticViewState;

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

function isInteractiveElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'BUTTON' || tag === 'A' || tag === 'SELECT' || tag === 'SUMMARY';
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

function formatRetryCountdown(retryAtMs: number): string {
  const remainingSeconds = Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000));
  return `${remainingSeconds}s`;
}

function formatLoadingStatus(progress: OperationProgressPayload | null | undefined): string {
  if (progress?.statusCode) {
    const countdown = typeof progress.retryAtMs === 'number'
      ? ` (${formatRetryCountdown(progress.retryAtMs)})`
      : '';
    return `${progress.statusCode} • ${progress.message ?? 'Waiting to retry…'}${countdown}`;
  }

  return progress?.message ?? 'Generating…';
}

function createUserErrorBlock(error: UserFacingError): HTMLDivElement {
  const block = document.createElement('div');
  block.className = 'goosemuse-inline-error';

  const primary = document.createElement('div');
  primary.className = 'goosemuse-error-primary';
  primary.textContent = formatUserFacingError(error);
  block.append(primary);

  const description = getUserErrorDescription(error);
  if (description) {
    const secondary = document.createElement('div');
    secondary.className = 'goosemuse-error-secondary';
    secondary.textContent = description;
    block.append(secondary);
  }

  return block;
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

  constructor(private readonly callbacks: InlinePanelCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'goosemuse-inline-panel goosemuse-hidden';

    // Header
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'goosemuse-inline-panel-header';

    this.headerInfoEl = document.createElement('div');
    this.headerInfoEl.className = 'goosemuse-inline-panel-header-info';

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'goosemuse-inline-panel-title';

    this.metaEl = document.createElement('div');
    this.metaEl.className = 'goosemuse-inline-panel-meta goosemuse-hidden';

    const actions = document.createElement('div');
    actions.className = 'goosemuse-inline-panel-actions';

    this.expandButton = document.createElement('button');
    this.expandButton.type = 'button';
    this.expandButton.className = 'goosemuse-inline-panel-action';
    this.expandButton.textContent = '\u2197';
    this.expandButton.title = 'Expand';
    this.expandButton.addEventListener('click', () => this.callbacks.onExpand());

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'goosemuse-inline-panel-action';
    close.textContent = '\u00d7';
    close.title = 'Close';
    close.addEventListener('click', () => this.callbacks.onClose());

    actions.append(this.expandButton, close);
    this.headerInfoEl.append(this.titleEl, this.metaEl);
    this.headerEl.append(this.headerInfoEl, actions);

    // Body
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'goosemuse-inline-panel-body';

    this.root.append(this.headerEl, this.bodyEl);

    // Escape handler with scope guard
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.model.kind !== 'hidden' && !this.root.classList.contains('goosemuse-hidden')) {
        if (isEditableElement(document.activeElement)) return;
        this.callbacks.onClose();
      }
    });

    // Enter-to-insert for completed fast replies
    document.addEventListener('keydown', (event) => {
      if (
        event.key !== 'Enter' ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey ||
        event.repeat || event.isComposing
      ) return;
      if (this.model.kind !== 'reply') return;
      if (this.root.classList.contains('goosemuse-hidden')) return;
      if ('feature' in this.model && this.model.feature !== 'fast-reply') return;
      if (isEditableElement(document.activeElement)) return;
      if (isInteractiveElement(document.activeElement)) return;
      if (
        document.activeElement &&
        document.activeElement !== document.body &&
        !this.root.contains(document.activeElement)
      ) return;
      const parts = this.model.parts;
      const next = this.getNextInsertablePart(parts);
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
      : ('feature' in model ? FEATURE_LABELS[model.feature] ?? model.feature : 'GooseMuse');
    const fanDisplayName = 'fanDisplayName' in model ? model.fanDisplayName : 'fan';
    const titleText = `${featureLabel} — @${fanDisplayName || 'fan'}`;
    if (this.titleEl.textContent !== titleText) {
      this.titleEl.textContent = titleText;
    }
    this.expandButton.style.display = model.kind === 'compare' ? 'none' : '';
    this.renderHeaderMeta(model);

    // Show panel
    this.root.classList.remove('goosemuse-hidden');

    // Render body
    this.renderBody(model);
  }

  hide(): void {
    this.model = { kind: 'hidden' };
    this.currentView = null;
    this.inlineError = null;
    this.lastFocusedReplyOpId = null;
    this.clearLoadingStatusTimer();
    this.bodyEl.replaceChildren();
    this.root.classList.add('goosemuse-hidden');
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

    let view: InlineViewState;
    if (model.kind === 'loading') {
      view = this.createLoadingView(model);
    } else if (model.kind === 'compare') {
      view = {
        kind: 'compare',
        operationId: model.operationId,
        root: this.renderCompareBody(model),
      };
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
    if (
      model.kind === 'reply' &&
      'feature' in model && model.feature === 'fast-reply' &&
      model.operationId !== this.lastFocusedReplyOpId
    ) {
      this.lastFocusedReplyOpId = model.operationId;
      queueMicrotask(() => {
        const btn = view.root.querySelector<HTMLButtonElement>('.goosemuse-card-actions .goosemuse-button');
        btn?.focus();
      });
    }
  }

  private renderHeaderMeta(
    model: Exclude<InlinePanelViewModel, { kind: 'hidden' }>,
  ): void {
    if (model.kind === 'compare') {
      this.metaEl.replaceChildren();
      this.metaEl.classList.add('goosemuse-hidden');
      return;
    }

    const spend = model.anthropicSpend;
    if (!spend) {
      this.metaEl.replaceChildren();
      this.metaEl.classList.add('goosemuse-hidden');
      return;
    }

    this.setHeaderMetaContent(spend);
    this.metaEl.classList.remove('goosemuse-hidden');
  }

  private setHeaderMetaContent(spend: AnthropicSpendSummary): void {
    const primary = document.createElement('div');
    primary.className = 'goosemuse-inline-panel-meta-primary';
    primary.textContent = formatSpendPrimary(spend);

    const cacheEffect = formatCacheEffectInline(spend);
    if (cacheEffect) {
      primary.append(
        document.createTextNode(' · '),
        (() => {
          const span = document.createElement('span');
          span.className = `goosemuse-spend-cache-${cacheEffect.kind}`;
          span.textContent = cacheEffect.text;
          return span;
        })(),
      );
    }

    primary.title = formatSpendSecondary(spend);
    this.metaEl.replaceChildren(primary);
  }

  private createSpendStrip(
    spend?: AnthropicSpendSummary,
    placeholder = false,
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'goosemuse-spend-strip goosemuse-spend-strip-inline';

    const primary = document.createElement('div');
    primary.className = 'goosemuse-spend-strip-primary';

    const secondary = document.createElement('div');
    secondary.className = 'goosemuse-spend-strip-secondary';

    if (!spend && placeholder) {
      section.classList.add('goosemuse-spend-strip-pending');
      primary.textContent = 'Cost pending · Tokens pending';
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
          span.className = `goosemuse-spend-cache-${cacheEffect.kind}`;
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
    section.className = 'goosemuse-grid';

    const status = document.createElement('div');
    status.className = 'goosemuse-overlay-status';
    const statusText = document.createTextNode('');
    status.append(statusText);

    const stream = document.createElement('div');
    stream.className = 'goosemuse-stream';
    const streamText = document.createTextNode('');
    stream.append(streamText);

    const actions = document.createElement('div');
    actions.className = 'goosemuse-card-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'goosemuse-button goosemuse-button-danger';
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
    const streamText = model.rawText || 'Waiting for Claude\u2026';
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
    section.className = 'goosemuse-grid';

    // Inline error banner (from insert/copy failures)
    if (this.inlineError) {
      section.append(createUserErrorBlock(this.inlineError));
    }

    if (model.parts.length > 0) {
      const parts = document.createElement('div');
      parts.className = 'goosemuse-parts';
      model.parts.forEach((part) => {
        const isSplit = model.splitModeRequested && model.parts.length > 1;
        parts.append(
          this.createPartCard(
            this.partTitle(part, model.splitModeRequested),
            part,
            {
              hint: isSplit
                ? (part.sequenceIndex === 0 ? 'Suggested first send.' : 'Suggested follow-up after message 1.')
                : undefined,
              emphasis: isSplit
                ? (part.sequenceIndex === 0 ? 'recommended' : 'followup')
                : undefined,
              status: part.insertedOnce ? 'Inserted earlier.' : undefined,
            },
          ),
        );
      });
      section.append(parts);
    } else {
      const raw = document.createElement('div');
      raw.className = 'goosemuse-stream';
      raw.textContent = model.rawText;
      section.append(raw);
    }

    // Regenerate
    const actions = document.createElement('div');
    actions.className = 'goosemuse-card-actions';
    if (model.rerunActionLabel) {
      const rerun = document.createElement('button');
      rerun.type = 'button';
      rerun.className = 'goosemuse-button';
      rerun.textContent = model.rerunActionLabel;
      rerun.addEventListener('click', () => this.callbacks.onRerun(model.feature));
      actions.append(rerun);
    }
    section.append(actions);

    return section;
  }

  private renderCompareBody(model: CompareInlineViewModel): HTMLElement {
    const section = document.createElement('div');
    section.className = 'goosemuse-grid';

    if (model.tabs.length === 0) {
      const waiting = document.createElement('div');
      waiting.className = 'goosemuse-stream';
      waiting.textContent = model.progress?.message ?? 'Preparing compare…';
      section.append(waiting);
      return section;
    }

    const summaryText = formatCompareSummary(model.tabs);
    if (summaryText) {
      const summary = document.createElement('div');
      summary.className = 'goosemuse-compare-summary';
      summary.textContent = summaryText;
      section.append(summary);
    }

    const tabs = document.createElement('div');
    tabs.className = 'goosemuse-compare-tabs';
    model.tabs.forEach((tab) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'goosemuse-compare-tab';
      const isActive = tab.cardId === model.activeCardId;
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      if (isActive) {
        button.classList.add('goosemuse-compare-tab-active');
      }
      button.addEventListener('click', () => this.callbacks.onCompareTabSelect(tab.cardId));

      const label = document.createElement('span');
      label.textContent = tab.label;
      button.append(label);

      if (tab.source === 'current') {
        const badge = document.createElement('span');
        badge.className = 'goosemuse-compare-tab-badge';
        badge.textContent = 'Current';
        button.append(badge);
      }

      if (tab.status === 'loading') {
        const spinner = document.createElement('span');
        spinner.className = 'goosemuse-spinner';
        button.append(spinner);
      }

      tabs.append(button);
    });
    section.append(tabs);

    const activeTab =
      model.tabs.find((tab) => tab.cardId === model.activeCardId) ??
      model.tabs[0] ??
      null;
    if (activeTab) {
      section.append(this.renderCompareActiveTab(model, activeTab));
    }

    const actions = document.createElement('div');
    actions.className = 'goosemuse-card-actions';
    if (model.canCancel && model.operationId) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'goosemuse-button goosemuse-button-danger';
      cancel.textContent = 'Cancel all';
      cancel.addEventListener('click', () => this.callbacks.onCancel(model.operationId!));
      actions.append(cancel);
    }
    if (model.canRegenerate) {
      const rerun = document.createElement('button');
      rerun.type = 'button';
      rerun.className = 'goosemuse-button';
      rerun.textContent = 'Regenerate all';
      rerun.addEventListener('click', () => this.callbacks.onCompareRerun());
      actions.append(rerun);
    }
    if (actions.childElementCount > 0) {
      section.append(actions);
    }

    return section;
  }

  private renderCompareActiveTab(
    model: CompareInlineViewModel,
    tab: CompareInlineTabState,
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'goosemuse-grid';

    if (this.inlineError) {
      section.append(createUserErrorBlock(this.inlineError));
    }

    if (tab.status === 'loading') {
      section.append(this.createSpendStrip(undefined, true));
      const status = document.createElement('div');
      status.className = 'goosemuse-overlay-status';
      status.textContent = model.progress?.message ?? 'Generating…';
      const stream = document.createElement('div');
      stream.className = 'goosemuse-stream';
      stream.textContent = tab.rawText || 'Waiting for Claude…';
      section.append(status, stream);
      return section;
    }

    if (tab.status === 'error') {
      if (tab.anthropicSpend) {
        section.append(this.createSpendStrip(tab.anthropicSpend));
      }
      section.append(createUserErrorBlock(tab.error ?? toUserError(null)));
      return section;
    }

    if (tab.anthropicSpend) {
      section.append(this.createSpendStrip(tab.anthropicSpend));
    }

    if (tab.parts.length > 0) {
      const parts = document.createElement('div');
      parts.className = 'goosemuse-parts';
      tab.parts.forEach((part) => {
        const isSplit = tab.splitModeRequested && tab.parts.length > 1;
        parts.append(
          this.createPartCard(
            this.partTitle(part, tab.splitModeRequested),
            part,
            {
              hint: isSplit
                ? (part.sequenceIndex === 0 ? 'Suggested first send.' : 'Suggested follow-up after message 1.')
                : undefined,
              emphasis: isSplit
                ? (part.sequenceIndex === 0 ? 'recommended' : 'followup')
                : undefined,
              status: part.insertedOnce ? 'Inserted earlier.' : undefined,
            },
          ),
        );
      });
      section.append(parts);
      return section;
    }

    const raw = document.createElement('div');
    raw.className = 'goosemuse-stream';
    raw.textContent = tab.rawText;
    section.append(raw);
    return section;
  }

  private partTitle(part: OverlayInsertPart, splitModeRequested?: boolean): string {
    const number = part.sequenceIndex + 1;
    return splitModeRequested && part.sequenceIndex > 0 ? `Follow-up ${number}` : `Message ${number}`;
  }

  private createPartCard(
    title: string,
    part: OverlayInsertPart,
    options: { hint?: string; emphasis?: 'recommended' | 'followup'; status?: string } = {},
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'goosemuse-card';
    if (options.emphasis === 'recommended') {
      card.classList.add('goosemuse-card-recommended');
    } else if (options.emphasis === 'followup') {
      card.classList.add('goosemuse-card-followup');
    }

    // Header row: title + hint + status + actions on one line
    const headerRow = document.createElement('div');
    headerRow.className = 'goosemuse-card-header-row';

    const label = document.createElement('span');
    label.className = 'goosemuse-card-title';
    label.textContent = title;
    headerRow.append(label);

    if (options.hint) {
      const hint = document.createElement('span');
      hint.className = 'goosemuse-card-hint';
      hint.textContent = options.hint;
      headerRow.append(hint);
    }

    if (options.status) {
      const statusEl = document.createElement('span');
      statusEl.className = 'goosemuse-card-status';
      statusEl.textContent = options.status;
      headerRow.append(statusEl);
    }

    const actions = document.createElement('div');
    actions.className = 'goosemuse-card-actions';

    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'goosemuse-button';
    insert.textContent = part.insertedAt ? 'Inserted \u2713' : part.insertedOnce ? 'Insert again' : 'Insert';
    insert.disabled = Boolean(part.insertedAt && Date.now() - part.insertedAt < 2000);
    insert.addEventListener('click', () => {
      void this.insertPart(part);
    });

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'goosemuse-button goosemuse-button-secondary';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await copyToClipboard(part.text);
        this.inlineError = null;
        this.render(this.model);
      } catch (error) {
        this.inlineError = toUserError(error);
        this.render(this.model, { preserveInlineError: true });
      }
    });

    actions.append(insert, copy);
    headerRow.append(actions);

    const text = document.createElement('div');
    text.className = 'goosemuse-card-text';
    text.textContent = part.text;

    card.append(headerRow, text);
    return card;
  }

  private async insertPart(part: OverlayInsertPart): Promise<void> {
    try {
      await insertIntoFanslyTextarea(part.text);
      part.insertedOnce = true;
      part.insertedAt = Date.now();
      this.inlineError = null;
      this.render(this.model);
      this.scheduleInsertedReset(part);
      this.queueComposerFocus();
    } catch (error) {
      this.inlineError = toUserError(error);
      this.render(this.model, { preserveInlineError: true });
    }
  }

  private getNextInsertablePart(parts: OverlayInsertPart[]): OverlayInsertPart | null {
    const isAvailable = (p: OverlayInsertPart) =>
      !p.insertedAt || Date.now() - p.insertedAt >= 2000;
    return (
      parts.find((p) => !p.insertedOnce && isAvailable(p)) ??
      parts.find((p) => isAvailable(p)) ??
      null
    );
  }

  private scheduleInsertedReset(part: OverlayInsertPart): void {
    window.setTimeout(() => {
      part.insertedAt = null;
      if (this.model.kind !== 'hidden') {
        this.render(this.model);
      }
    }, 2000);
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
    section.className = 'goosemuse-grid';

    section.append(createUserErrorBlock(model.error));

    const actions = document.createElement('div');
    actions.className = 'goosemuse-card-actions';
    const rerun = document.createElement('button');
    rerun.type = 'button';
    rerun.className = 'goosemuse-button';
    rerun.textContent = 'Regenerate';
    rerun.addEventListener('click', () => this.callbacks.onRerun(model.feature));
    actions.append(rerun);
    section.append(actions);

    return section;
  }
}
