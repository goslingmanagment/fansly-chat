import { FEATURE_LABELS } from '../../shared/constants.js';
import { toUserError } from '../../shared/errors.js';
import type {
  FeatureType,
  OverlayInsertPart,
  OverlayViewModel,
  UserFacingError,
} from '../../shared/types.js';
import { insertIntoFanslyTextarea, copyToClipboard, focusActiveConversationTextarea } from '../textarea.js';

interface InlinePanelCallbacks {
  onClose: () => void;
  onExpand: () => void;
  onCancel: (operationId: string) => void;
  onRerun: (feature: FeatureType) => void;
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

type InlineViewState = LoadingViewState | StaticViewState;

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export class InlinePanelController {
  readonly root: HTMLDivElement;
  private readonly headerEl: HTMLDivElement;
  private readonly titleEl: HTMLDivElement;
  private readonly bodyEl: HTMLDivElement;
  private currentView: InlineViewState | null = null;
  private model: OverlayViewModel = { kind: 'hidden' };
  private inlineError: UserFacingError | null = null;

  constructor(private readonly callbacks: InlinePanelCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'chatmuse-inline-panel chatmuse-hidden';

    // Header
    this.headerEl = document.createElement('div');
    this.headerEl.className = 'chatmuse-inline-panel-header';

    this.titleEl = document.createElement('div');
    this.titleEl.className = 'chatmuse-inline-panel-title';

    const actions = document.createElement('div');
    actions.className = 'chatmuse-inline-panel-actions';

    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'chatmuse-inline-panel-action';
    expand.textContent = '\u2197';
    expand.title = 'Expand';
    expand.addEventListener('click', () => this.callbacks.onExpand());

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chatmuse-inline-panel-action';
    close.textContent = '\u00d7';
    close.title = 'Close';
    close.addEventListener('click', () => this.callbacks.onClose());

    actions.append(expand, close);
    this.headerEl.append(this.titleEl, actions);

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

  render(model: OverlayViewModel, options?: InlinePanelRenderOptions): void {
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
    const feature = 'feature' in model ? model.feature : null;
    const fanDisplayName = 'fanDisplayName' in model ? model.fanDisplayName : 'fan';
    const featureLabel = feature ? FEATURE_LABELS[feature] ?? feature : 'ChatMuse';
    const titleText = `${featureLabel} — @${fanDisplayName || 'fan'}`;
    if (this.titleEl.textContent !== titleText) {
      this.titleEl.textContent = titleText;
    }

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

  private renderBody(model: Exclude<OverlayViewModel, { kind: 'hidden' }>): void {
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
            model.operationId,
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

  private partTitle(part: OverlayInsertPart, splitModeRequested?: boolean): string {
    const number = part.sequenceIndex + 1;
    return splitModeRequested && part.sequenceIndex > 0 ? `Follow-up ${number}` : `Message ${number}`;
  }

  private createPartCard(
    title: string,
    part: OverlayInsertPart,
    operationId: string,
    options: { hint?: string; emphasis?: 'recommended' | 'followup'; status?: string } = {},
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'chatmuse-card';
    if (options.emphasis === 'recommended') {
      card.classList.add('chatmuse-card-recommended');
    } else if (options.emphasis === 'followup') {
      card.classList.add('chatmuse-card-followup');
    }

    const label = document.createElement('div');
    label.className = 'chatmuse-card-title';
    label.textContent = title;

    const hint = options.hint ? document.createElement('div') : null;
    if (hint) {
      hint.className = 'chatmuse-card-hint';
      hint.textContent = options.hint ?? null;
    }

    const statusEl = options.status ? document.createElement('div') : null;
    if (statusEl) {
      statusEl.className = 'chatmuse-card-status';
      statusEl.textContent = options.status ?? null;
    }

    const text = document.createElement('div');
    text.className = 'chatmuse-card-text';
    text.textContent = part.text;

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
        this.scheduleInsertedReset(part, operationId);
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
    card.append(label);
    if (hint) card.append(hint);
    if (statusEl) card.append(statusEl);
    card.append(text, actions);
    return card;
  }

  private scheduleInsertedReset(part: OverlayInsertPart, operationId: string): void {
    window.setTimeout(() => {
      part.insertedAt = null;
      if ('operationId' in this.model && (this.model as { operationId?: string }).operationId === operationId) {
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
