import { FEATURE_LABELS } from '../../shared/constants.js';
import { toUserError } from '../../shared/errors.js';
import type {
  AnthropicSpendSummary,
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

  constructor(private readonly callbacks: InlinePanelCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'chatmuse-inline-panel chatmuse-hidden';

    // Header
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'chatmuse-inline-panel-header';

    this.headerInfoEl = document.createElement('div');
    this.headerInfoEl.className = 'chatmuse-inline-panel-header-info';

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'chatmuse-inline-panel-title';

    this.metaEl = document.createElement('div');
    this.metaEl.className = 'chatmuse-inline-panel-meta chatmuse-hidden';

    const actions = document.createElement('div');
    actions.className = 'chatmuse-inline-panel-actions';

    this.expandButton = document.createElement('button');
    this.expandButton.type = 'button';
    this.expandButton.className = 'chatmuse-inline-panel-action';
    this.expandButton.textContent = '\u2197';
    this.expandButton.title = 'Expand';
    this.expandButton.addEventListener('click', () => this.callbacks.onExpand());

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chatmuse-inline-panel-action';
    close.textContent = '\u00d7';
    close.title = 'Close';
    close.addEventListener('click', () => this.callbacks.onClose());

    actions.append(this.expandButton, close);
    this.headerInfoEl.append(this.titleEl, this.metaEl);
    this.headerEl.append(this.headerInfoEl, actions);

    // Body
    this.bodyEl = document.createElement('div');
    this.bodyEl.className = 'chatmuse-inline-panel-body';

    this.root.append(this.headerEl, this.bodyEl);

    // Escape handler with scope guard
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.model.kind !== 'hidden' && !this.root.classList.contains('chatmuse-hidden')) {
        if (isEditableElement(document.activeElement)) return;
        this.callbacks.onClose();
      }
    });
  }

  render(model: InlinePanelViewModel, options?: InlinePanelRenderOptions): void {
    if (model.kind === 'hidden') {
      this.hide();
      return;
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
      : ('feature' in model ? FEATURE_LABELS[model.feature] ?? model.feature : 'ChatMuse');
    const fanDisplayName = 'fanDisplayName' in model ? model.fanDisplayName : 'fan';
    const titleText = `${featureLabel} — @${fanDisplayName || 'fan'}`;
    if (this.titleEl.textContent !== titleText) {
      this.titleEl.textContent = titleText;
    }
    this.expandButton.style.display = model.kind === 'compare' ? 'none' : '';
    this.renderHeaderMeta(model);

    // Show panel
    this.root.classList.remove('chatmuse-hidden');

    // Render body
    this.renderBody(model);
  }

  hide(): void {
    this.model = { kind: 'hidden' };
    this.currentView = null;
    this.inlineError = null;
    this.bodyEl.replaceChildren();
    this.root.classList.add('chatmuse-hidden');
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
  }

  private renderHeaderMeta(
    model: Exclude<InlinePanelViewModel, { kind: 'hidden' }>,
  ): void {
    if (model.kind === 'compare') {
      this.metaEl.replaceChildren();
      this.metaEl.classList.add('chatmuse-hidden');
      return;
    }

    const spend = model.anthropicSpend;
    if (!spend) {
      this.metaEl.replaceChildren();
      this.metaEl.classList.add('chatmuse-hidden');
      return;
    }

    this.setHeaderMetaContent(spend);
    this.metaEl.classList.remove('chatmuse-hidden');
  }

  private setHeaderMetaContent(spend: AnthropicSpendSummary): void {
    const primary = document.createElement('div');
    primary.className = 'chatmuse-inline-panel-meta-primary';
    primary.textContent = formatSpendPrimary(spend);

    const cacheEffect = formatCacheEffectInline(spend);
    if (cacheEffect) {
      primary.append(
        document.createTextNode(' · '),
        (() => {
          const span = document.createElement('span');
          span.className = `chatmuse-spend-cache-${cacheEffect.kind}`;
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
    section.className = 'chatmuse-spend-strip chatmuse-spend-strip-inline';

    const primary = document.createElement('div');
    primary.className = 'chatmuse-spend-strip-primary';

    const secondary = document.createElement('div');
    secondary.className = 'chatmuse-spend-strip-secondary';

    if (!spend && placeholder) {
      section.classList.add('chatmuse-spend-strip-pending');
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
          span.className = `chatmuse-spend-cache-${cacheEffect.kind}`;
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
    section.className = 'chatmuse-grid';

    const status = document.createElement('div');
    status.className = 'chatmuse-overlay-status';
    const statusText = document.createTextNode('');
    status.append(statusText);

    const stream = document.createElement('div');
    stream.className = 'chatmuse-stream';
    const streamText = document.createTextNode('');
    stream.append(streamText);

    const actions = document.createElement('div');
    actions.className = 'chatmuse-card-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'chatmuse-button chatmuse-button-danger';
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
    const statusText = model.progress?.message ?? 'Generating\u2026';
    const streamText = model.rawText || 'Waiting for Claude\u2026';
    if (view.statusText.data !== statusText) {
      view.statusText.data = statusText;
    }
    if (view.streamText.data !== streamText) {
      view.streamText.data = streamText;
    }
  }

  // ─── Reply ───────────────────────────────────────────────────────────

  private renderReplyBody(model: Extract<OverlayViewModel, { kind: 'reply' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    // Inline error banner (from insert/copy failures)
    if (this.inlineError) {
      const errorBanner = document.createElement('div');
      errorBanner.className = 'chatmuse-inline-error';
      errorBanner.textContent = this.inlineError.message;
      section.append(errorBanner);
    }

    if (model.parts.length > 0) {
      const parts = document.createElement('div');
      parts.className = 'chatmuse-parts';
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
      raw.className = 'chatmuse-stream';
      raw.textContent = model.rawText;
      section.append(raw);
    }

    // Regenerate
    const actions = document.createElement('div');
    actions.className = 'chatmuse-card-actions';
    if (model.rerunActionLabel) {
      const rerun = document.createElement('button');
      rerun.type = 'button';
      rerun.className = 'chatmuse-button';
      rerun.textContent = model.rerunActionLabel;
      rerun.addEventListener('click', () => this.callbacks.onRerun(model.feature));
      actions.append(rerun);
    }
    section.append(actions);

    return section;
  }

  private renderCompareBody(model: CompareInlineViewModel): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    if (model.tabs.length === 0) {
      const waiting = document.createElement('div');
      waiting.className = 'chatmuse-stream';
      waiting.textContent = model.progress?.message ?? 'Preparing compare…';
      section.append(waiting);
      return section;
    }

    const summaryText = formatCompareSummary(model.tabs);
    if (summaryText) {
      const summary = document.createElement('div');
      summary.className = 'chatmuse-compare-summary';
      summary.textContent = summaryText;
      section.append(summary);
    }

    const tabs = document.createElement('div');
    tabs.className = 'chatmuse-compare-tabs';
    model.tabs.forEach((tab) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'chatmuse-compare-tab';
      const isActive = tab.cardId === model.activeCardId;
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      if (isActive) {
        button.classList.add('chatmuse-compare-tab-active');
      }
      button.addEventListener('click', () => this.callbacks.onCompareTabSelect(tab.cardId));

      const label = document.createElement('span');
      label.textContent = tab.label;
      button.append(label);

      if (tab.source === 'current') {
        const badge = document.createElement('span');
        badge.className = 'chatmuse-compare-tab-badge';
        badge.textContent = 'Current';
        button.append(badge);
      }

      if (tab.status === 'loading') {
        const spinner = document.createElement('span');
        spinner.className = 'chatmuse-spinner';
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
    actions.className = 'chatmuse-card-actions';
    if (model.canCancel && model.operationId) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'chatmuse-button chatmuse-button-danger';
      cancel.textContent = 'Cancel all';
      cancel.addEventListener('click', () => this.callbacks.onCancel(model.operationId!));
      actions.append(cancel);
    }
    if (model.canRegenerate) {
      const rerun = document.createElement('button');
      rerun.type = 'button';
      rerun.className = 'chatmuse-button';
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
    section.className = 'chatmuse-grid';

    if (this.inlineError) {
      const errorBanner = document.createElement('div');
      errorBanner.className = 'chatmuse-inline-error';
      errorBanner.textContent = this.inlineError.message;
      section.append(errorBanner);
    }

    if (tab.status === 'loading') {
      section.append(this.createSpendStrip(undefined, true));
      const status = document.createElement('div');
      status.className = 'chatmuse-overlay-status';
      status.textContent = model.progress?.message ?? 'Generating…';
      const stream = document.createElement('div');
      stream.className = 'chatmuse-stream';
      stream.textContent = tab.rawText || 'Waiting for Claude…';
      section.append(status, stream);
      return section;
    }

    if (tab.status === 'error') {
      if (tab.anthropicSpend) {
        section.append(this.createSpendStrip(tab.anthropicSpend));
      }
      const error = document.createElement('div');
      error.className = 'chatmuse-inline-error';
      error.textContent = tab.error?.message ?? 'Something went wrong.';
      section.append(error);
      return section;
    }

    if (tab.anthropicSpend) {
      section.append(this.createSpendStrip(tab.anthropicSpend));
    }

    if (tab.parts.length > 0) {
      const parts = document.createElement('div');
      parts.className = 'chatmuse-parts';
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
    raw.className = 'chatmuse-stream';
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
    card.className = 'chatmuse-card';
    if (options.emphasis === 'recommended') {
      card.classList.add('chatmuse-card-recommended');
    } else if (options.emphasis === 'followup') {
      card.classList.add('chatmuse-card-followup');
    }

    // Header row: title + hint + status + actions on one line
    const headerRow = document.createElement('div');
    headerRow.className = 'chatmuse-card-header-row';

    const label = document.createElement('span');
    label.className = 'chatmuse-card-title';
    label.textContent = title;
    headerRow.append(label);

    if (options.hint) {
      const hint = document.createElement('span');
      hint.className = 'chatmuse-card-hint';
      hint.textContent = options.hint;
      headerRow.append(hint);
    }

    if (options.status) {
      const statusEl = document.createElement('span');
      statusEl.className = 'chatmuse-card-status';
      statusEl.textContent = options.status;
      headerRow.append(statusEl);
    }

    const actions = document.createElement('div');
    actions.className = 'chatmuse-card-actions';

    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'chatmuse-button';
    insert.textContent = part.insertedAt ? 'Inserted \u2713' : part.insertedOnce ? 'Insert again' : 'Insert';
    insert.disabled = Boolean(part.insertedAt && Date.now() - part.insertedAt < 2000);
    insert.addEventListener('click', async () => {
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
    });

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'chatmuse-button chatmuse-button-secondary';
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
    text.className = 'chatmuse-card-text';
    text.textContent = part.text;

    card.append(headerRow, text);
    return card;
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

  // ─── Error ───────────────────────────────────────────────────────────

  private renderErrorBody(model: Extract<OverlayViewModel, { kind: 'error' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    const block = document.createElement('div');
    block.className = 'chatmuse-inline-error';
    block.textContent = model.error.message;
    section.append(block);

    const actions = document.createElement('div');
    actions.className = 'chatmuse-card-actions';
    const rerun = document.createElement('button');
    rerun.type = 'button';
    rerun.className = 'chatmuse-button';
    rerun.textContent = 'Regenerate';
    rerun.addEventListener('click', () => this.callbacks.onRerun(model.feature));
    actions.append(rerun);
    section.append(actions);

    return section;
  }
}
