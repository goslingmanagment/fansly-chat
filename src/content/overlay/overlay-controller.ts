import { toUserError } from '../../shared/errors.js';
import type {
  FeatureType,
  OverlayInsertPart,
  OverlayViewModel,
  PromptDebugSnapshot,
  UserFacingError,
} from '../../shared/types.js';
import { ensureOverlayRoot } from '../dom-anchor.js';
import { insertIntoFanslyTextarea, copyToClipboard, focusActiveConversationTextarea } from '../textarea.js';

interface OverlayCallbacks {
  onClose: () => void;
  onCancel: (operationId: string) => void;
  onRegenerate: (feature: FeatureType) => void;
  onRefreshSummary: () => void;
}

interface PartCardOptions {
  hint?: string;
  emphasis?: 'recommended' | 'followup';
  status?: string;
  autoPassThrough?: boolean;
}

function titleForFeature(feature: FeatureType): string {
  switch (feature) {
    case 'fast-reply':
      return 'Fast Reply';
    case 'help-me':
      return 'Help Me';
    case 'fan-summary':
      return 'Fan Summary';
    case 'chat-review':
      return 'Chat Review';
    case 'ping':
      return 'Ping';
  }
}

function relativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.max(1, Math.round(diffMs / 60_000));
  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  return `${Math.round(diffHours / 24)}d ago`;
}

function ratingClass(rating: number): string {
  if (rating >= 9) return 'chatmuse-rating-excellent';
  if (rating >= 7) return 'chatmuse-rating-good';
  if (rating >= 5) return 'chatmuse-rating-average';
  if (rating >= 3) return 'chatmuse-rating-below';
  return 'chatmuse-rating-poor';
}

export class OverlayController {
  private readonly root = ensureOverlayRoot();
  private model: OverlayViewModel = { kind: 'hidden' };
  private passThrough = false;
  private backdropEl: HTMLDivElement | null = null;
  private inlineError: UserFacingError | null = null;
  private debugPromptOpen = false;
  private debugPromptOperationId: string | null = null;

  constructor(private readonly callbacks: OverlayCallbacks) {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.model.kind !== 'hidden') {
        if ('operationId' in this.model && this.model.operationId) {
          if (this.model.kind === 'loading') {
            this.callbacks.onCancel(this.model.operationId);
          }
        }
        this.callbacks.onClose();
      }
    });
  }

  render(model: OverlayViewModel, preserveInlineError = false): void {
    this.model = model;
    if (model.kind === 'error') {
      this.inlineError = null;
    } else if (!preserveInlineError) {
      this.inlineError = null;
    }
    if (model.kind === 'hidden' || model.kind === 'loading' || model.kind === 'error') {
      this.passThrough = false;
    }
    this.backdropEl = null;
    this.root.replaceChildren();
    document.body.classList.toggle('chatmuse-scroll-lock', model.kind !== 'hidden');
    this.root.style.pointerEvents = model.kind === 'hidden' ? 'none' : 'auto';

    if (model.kind === 'hidden') {
      this.debugPromptOpen = false;
      this.debugPromptOperationId = null;
      return;
    }

    if ('operationId' in model) {
      if (!model.operationId) {
        this.debugPromptOpen = false;
        this.debugPromptOperationId = null;
      } else if (model.operationId !== this.debugPromptOperationId) {
        this.debugPromptOpen = false;
        this.debugPromptOperationId = model.operationId;
      }
    }

    const shell = document.createElement('div');
    shell.className = 'chatmuse-overlay-shell';

    const backdrop = document.createElement('div');
    backdrop.className = 'chatmuse-overlay-backdrop';
    this.backdropEl = backdrop;
    this.syncBackdropPassThrough();
    backdrop.addEventListener('click', () => {
      if (!this.passThrough) {
        if ('operationId' in model && model.kind === 'loading') {
          this.callbacks.onCancel(model.operationId);
        }
        this.callbacks.onClose();
      }
    });

    const panel = document.createElement('div');
    panel.className = 'chatmuse-overlay-panel';
    panel.addEventListener('pointerdown', () => {
      if (!this.passThrough) {
        return;
      }
      this.passThrough = false;
      this.syncBackdropPassThrough();
    });

    panel.append(this.renderHeader(model));

    if (model.kind !== 'error' && this.inlineError) {
      const error = document.createElement('div');
      error.className = 'chatmuse-inline-error';
      error.textContent = this.inlineError.message;
      panel.append(error);
    }

    switch (model.kind) {
      case 'loading':
        panel.append(this.renderLoading(model));
        break;
      case 'reply':
        panel.append(this.renderReply(model));
        break;
      case 'helpMe':
        panel.append(this.renderHelpMe(model));
        break;
      case 'readOnly':
        panel.append(this.renderReadOnly(model));
        break;
      case 'error':
        panel.append(this.renderError(model));
        break;
      default:
        break;
    }

    shell.append(backdrop, panel);
    this.root.append(shell);
  }

  private syncBackdropPassThrough(): void {
    this.backdropEl?.classList.toggle('chatmuse-pass-through', this.passThrough);
  }

  private queueComposerFocus(): void {
    window.requestAnimationFrame(() => {
      focusActiveConversationTextarea();
    });
  }

  private scheduleInsertedReset(part: OverlayInsertPart, operationId: string): void {
    window.setTimeout(() => {
      part.insertedAt = null;
      if ('operationId' in this.model && this.model.operationId === operationId) {
        this.render(this.model);
      }
    }, 2000);
  }

  private partTitle(part: OverlayInsertPart, splitModeRequested?: boolean): string {
    const number = part.sequenceIndex + 1;
    return splitModeRequested && part.sequenceIndex > 0 ? `Follow-up ${number}` : `Message ${number}`;
  }

  // ─── Header ─────────────────────────────────────────────────────────

  private renderHeader(model: Exclude<OverlayViewModel, { kind: 'hidden' }>): HTMLElement {
    const header = document.createElement('div');
    header.className = 'chatmuse-overlay-header';

    const title = document.createElement('div');
    title.className = 'chatmuse-overlay-title';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'chatmuse-eyebrow';
    const feature =
      model.kind === 'helpMe'
        ? 'Help Me'
        : model.kind === 'loading' || model.kind === 'reply' || model.kind === 'readOnly'
          ? titleForFeature(model.feature)
          : 'ChatMuse';
    eyebrow.textContent = feature;
    const h1 = document.createElement('div');
    h1.className = 'chatmuse-title';
    h1.textContent =
      model.kind === 'error' ? 'ChatMuse' : `${feature} — @${model.fanDisplayName || 'fan'}`;
    const subtitle = document.createElement('div');
    subtitle.className = 'chatmuse-subtitle';
    subtitle.textContent = model.kind === 'error' ? 'Something went wrong' : 'Preview only. You send messages manually.';
    title.append(eyebrow, h1, subtitle);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chatmuse-close';
    close.textContent = '\u00d7';
    close.addEventListener('click', () => {
      if (model.kind === 'loading') {
        this.callbacks.onCancel(model.operationId);
      }
      this.callbacks.onClose();
    });

    header.append(title, close);
    return header;
  }

  // ─── Loading ────────────────────────────────────────────────────────

  private renderLoading(model: Extract<OverlayViewModel, { kind: 'loading' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    const status = document.createElement('div');
    status.className = 'chatmuse-overlay-status';
    status.textContent = model.progress?.message ?? 'Generating\u2026';

    const stream = document.createElement('div');
    stream.className = 'chatmuse-stream';
    stream.textContent = model.rawText || 'Waiting for Claude\u2026';

    const debugPrompt = model.debugPrompt ? this.renderDebugPrompt(model.debugPrompt) : null;

    const actions = document.createElement('div');
    actions.className = 'chatmuse-overlay-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'chatmuse-button chatmuse-button-danger';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => this.callbacks.onCancel(model.operationId));
    actions.append(cancel);

    section.append(status, stream);
    if (debugPrompt) {
      section.append(debugPrompt);
    }
    section.append(actions);
    return section;
  }

  // ─── Part Card ──────────────────────────────────────────────────────

  private createPartCard(title: string, part: OverlayInsertPart, options: PartCardOptions = {}): HTMLElement {
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
        if (options.autoPassThrough) {
          this.passThrough = true;
        }
        this.render(this.model);
        const operationId = 'operationId' in this.model ? this.model.operationId : null;
        if (operationId) {
          this.scheduleInsertedReset(part, operationId);
        }
        this.queueComposerFocus();
      } catch (error) {
        this.inlineError = toUserError(error);
        this.render(this.model, true);
      }
    });

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'chatmuse-button chatmuse-button-secondary';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      await copyToClipboard(part.text);
      this.inlineError = null;
      this.render(this.model);
    });

    actions.append(insert, copy);
    card.append(label);
    if (hint) {
      card.append(hint);
    }
    if (statusEl) {
      card.append(statusEl);
    }
    card.append(text, actions);
    return card;
  }

  // ─── Reply ──────────────────────────────────────────────────────────

  private renderReply(model: Extract<OverlayViewModel, { kind: 'reply' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    if (model.splitModeRequested) {
      const helper = document.createElement('div');
      helper.className = 'chatmuse-inline-note';
      helper.textContent =
        model.parts.length > 1
          ? 'Split mode was on. Start with message 1, send it manually in Fansly, then use the follow-up if it still feels right.'
          : 'Split mode was on, but Claude kept this as one message because a natural split did not fit this reply.';
      section.append(helper);
    }

    if (model.parts.length > 0) {
      const parts = document.createElement('div');
      parts.className = 'chatmuse-parts';
      model.parts.forEach((part) => {
        const isSplit = model.splitModeRequested && model.parts.length > 1;
        parts.append(
          this.createPartCard(this.partTitle(part, model.splitModeRequested), part, {
            hint: isSplit
              ? (part.sequenceIndex === 0 ? 'Suggested first send.' : 'Suggested follow-up after message 1.')
              : undefined,
            emphasis: isSplit
              ? (part.sequenceIndex === 0 ? 'recommended' : 'followup')
              : undefined,
            status: part.insertedOnce ? 'Inserted earlier.' : undefined,
            autoPassThrough: true,
          }),
        );
      });
      section.append(parts);
    } else {
      const raw = document.createElement('div');
      raw.className = 'chatmuse-stream';
      raw.textContent = model.rawText;
      section.append(raw);
    }

    if (model.debugPrompt) {
      section.append(this.renderDebugPrompt(model.debugPrompt));
    }

    const actions = document.createElement('div');
    actions.className = 'chatmuse-overlay-actions';
    if (model.canRegenerate) {
      const regenerate = document.createElement('button');
      regenerate.type = 'button';
      regenerate.className = 'chatmuse-button';
      regenerate.textContent = 'Regenerate';
      regenerate.addEventListener('click', () => this.callbacks.onRegenerate(model.feature));
      actions.append(regenerate);
    }
    section.append(actions);
    return section;
  }

  // ─── Help Me ────────────────────────────────────────────────────────

  private renderHelpMe(model: Extract<OverlayViewModel, { kind: 'helpMe' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    const coaching = document.createElement('div');
    coaching.className = 'chatmuse-card';
    const coachingTitle = document.createElement('div');
    coachingTitle.className = 'chatmuse-card-title';
    coachingTitle.textContent = 'Coaching';
    const coachingText = document.createElement('div');
    coachingText.className = 'chatmuse-card-text';
    coachingText.textContent = model.coaching ?? model.rawText;
    coaching.append(coachingTitle, coachingText);
    section.append(coaching);

    const suggestions = document.createElement('div');
    suggestions.className = 'chatmuse-parts';
    model.engagingParts.forEach((part, index) =>
      suggestions.append(this.createPartCard(`Engaging ${index + 1}`, part, { autoPassThrough: true })),
    );
    model.flirtyParts.forEach((part, index) =>
      suggestions.append(this.createPartCard(`Flirty ${index + 1}`, part, { autoPassThrough: true })),
    );
    if (suggestions.childElementCount > 0) {
      section.append(suggestions);
    }

    if (model.parseFallback) {
      const fallback = document.createElement('div');
      fallback.className = 'chatmuse-stream';
      fallback.textContent = model.rawText;
      section.append(fallback);
    }

    return section;
  }

  // ─── Read Only (Summary, Review) ───────────────────────────────────

  private renderReadOnly(model: Extract<OverlayViewModel, { kind: 'readOnly' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    if (model.reviewMeta?.rating) {
      const ratingSection = document.createElement('div');
      ratingSection.className = 'chatmuse-rating-section';

      const badge = document.createElement('div');
      badge.className = `chatmuse-rating-badge ${ratingClass(model.reviewMeta.rating)}`;
      badge.textContent = String(model.reviewMeta.rating);

      const ratingLabel = document.createElement('div');
      ratingLabel.className = 'chatmuse-rating-label';
      ratingLabel.textContent = `${model.reviewMeta.rating}/10`;

      ratingSection.append(badge, ratingLabel);
      section.append(ratingSection);
    }

    if (model.summaryMeta) {
      const meta = document.createElement('div');
      meta.className = 'chatmuse-overlay-status';
      meta.textContent = model.summaryMeta.cached
        ? `Cached ${relativeTime(model.summaryMeta.generatedAt)}`
        : `Generated ${relativeTime(model.summaryMeta.generatedAt)}`;
      section.append(meta);
    }

    if (model.reviewMeta && !model.reviewMeta.parseFallback) {
      if (model.reviewMeta.evaluation) {
        const evalSection = document.createElement('div');
        evalSection.className = 'chatmuse-card';
        const evalTitle = document.createElement('div');
        evalTitle.className = 'chatmuse-card-title';
        evalTitle.textContent = 'Evaluation';
        const evalText = document.createElement('div');
        evalText.className = 'chatmuse-card-text';
        evalText.textContent = model.reviewMeta.evaluation;
        evalSection.append(evalTitle, evalText);
        section.append(evalSection);
      }

      if (model.reviewMeta.recommendations) {
        const recSection = document.createElement('div');
        recSection.className = 'chatmuse-card';
        const recTitle = document.createElement('div');
        recTitle.className = 'chatmuse-card-title';
        recTitle.textContent = 'Recommendations';
        const recText = document.createElement('div');
        recText.className = 'chatmuse-card-text';
        recText.textContent = model.reviewMeta.recommendations;
        recSection.append(recTitle, recText);
        section.append(recSection);
      }
    } else {
      const body = document.createElement('div');
      body.className = 'chatmuse-stream';
      body.textContent = model.rawText;
      section.append(body);
    }

    const actions = document.createElement('div');
    actions.className = 'chatmuse-overlay-actions';
    if (model.canRefresh) {
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'chatmuse-button';
      refresh.textContent = 'Refresh';
      refresh.addEventListener('click', () => this.callbacks.onRefreshSummary());
      actions.append(refresh);
    }
    section.append(actions);
    return section;
  }

  // ─── Error ──────────────────────────────────────────────────────────

  private renderError(model: Extract<OverlayViewModel, { kind: 'error' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    const block = document.createElement('div');
    block.className = 'chatmuse-inline-error';
    block.textContent = model.error.message;
    section.append(block);

    if (model.debugPrompt) {
      section.append(this.renderDebugPrompt(model.debugPrompt));
    }

    return section;
  }

  // ─── Debug Prompt Inspector ─────────────────────────────────────────

  private renderDebugPrompt(snapshot: PromptDebugSnapshot): HTMLElement {
    const details = document.createElement('details');
    details.className = 'chatmuse-debug-inspector';
    details.open = this.debugPromptOpen;
    details.addEventListener('toggle', () => {
      this.debugPromptOpen = details.open;
    });

    const summary = document.createElement('summary');
    summary.className = 'chatmuse-debug-summary';
    summary.textContent = 'Claude Input';
    details.append(summary);

    const content = document.createElement('div');
    content.className = 'chatmuse-debug-content';
    content.append(
      this.createDebugSection('System Prompt', snapshot.system),
      this.createDebugSection('Transcript Sent to Claude', snapshot.transcript),
      this.createDebugSection('Fan Spending Data', snapshot.fanSpendingData.trim() || 'Not included'),
      this.createDebugSection('Fan Subscription Data', snapshot.fanSubscriptionData.trim() || 'Not included'),
      this.createDebugSection('Final User Prompt', snapshot.user),
    );
    details.append(content);
    return details;
  }

  private createDebugSection(title: string, content: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-debug-section';

    const label = document.createElement('div');
    label.className = 'chatmuse-debug-label';
    label.textContent = title;

    const text = document.createElement('div');
    text.className = 'chatmuse-debug-text';
    text.textContent = content;

    section.append(label, text);
    return section;
  }
}
