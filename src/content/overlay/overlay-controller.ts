import { toUserError } from '../../shared/errors.js';
import type {
  AnthropicSpendSummary,
  AnthropicUsageMetrics,
  FeatureType,
  OverlayInsertPart,
  OverlayRerunActionLabel,
  OverlayViewModel,
  OperationProfilingSnapshot,
  PromptDebugSnapshot,
  UserFacingError,
} from '../../shared/types.js';
import { ensureOverlayRoot } from '../dom-anchor.js';
import {
  formatAnthropicCostSummary,
  formatCacheEffectInline,
  formatSpendPrimary,
  formatSpendSecondary,
  formatUsd,
} from '../spend-format.js';
import { insertIntoFanslyTextarea, copyToClipboard, focusActiveConversationTextarea } from '../textarea.js';

type OverlayDismissMode = 'close' | 'cancel-and-close' | 'collapse-to-inline';

interface OverlayRenderOptions {
  preserveInlineError?: boolean;
  dismissMode?: OverlayDismissMode;
}

interface OverlayCallbacks {
  onClose: () => void;
  onCancel: (operationId: string) => void;
  onRerun: (feature: FeatureType) => void;
  onCollapse: () => void;
}

interface PartCardOptions {
  hint?: string;
  emphasis?: 'recommended' | 'followup';
  status?: string;
  autoPassThrough?: boolean;
}

type VisibleOverlayModel = Exclude<OverlayViewModel, { kind: 'hidden' }>;
type StaticOverlayKind = Exclude<VisibleOverlayModel['kind'], 'loading'>;

interface StaticViewState {
  kind: StaticOverlayKind;
  operationId: string | null;
  root: HTMLElement;
}

interface LoadingViewState {
  kind: 'loading';
  operationId: string;
  root: HTMLElement;
  statusText: Text;
  streamText: Text;
  spendHost: HTMLDivElement;
  profilingHost: HTMLDivElement | null;
  debugHost: HTMLDivElement;
  actions: HTMLDivElement;
  debugSnapshot: PromptDebugSnapshot | null;
  liveElapsedBaseMs: number | null;
  liveElapsedStartedAt: number | null;
}

type OverlayViewState = StaticViewState | LoadingViewState;

interface OverlayRenderTraceState {
  renderCount: number;
  lastKind: OverlayViewModel['kind'] | null;
  lastOperationId: string | null;
}

function titleForFeature(feature: FeatureType): string {
  switch (feature) {
    case 'fast-reply':
      return 'Fast Reply';
    case 'improve-draft':
      return 'Fix Draft';
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

function formatProfilingElapsed(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatAnthropicUsageSummary(usage: AnthropicUsageMetrics): string {
  return `input ${usage.input_tokens} • cache create ${usage.cache_creation_input_tokens} • cache read ${usage.cache_read_input_tokens} • output ${usage.output_tokens}`;
}


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

function operationIdForModel(model: OverlayViewModel): string | null {
  return 'operationId' in model ? model.operationId ?? null : null;
}

export class OverlayController {
  private readonly root = ensureOverlayRoot();
  private model: OverlayViewModel = { kind: 'hidden' };
  private passThrough = false;
  private shellEl: HTMLDivElement | null = null;
  private backdropEl: HTMLDivElement | null = null;
  private panelEl: HTMLDivElement | null = null;
  private headerEyebrowEl: HTMLDivElement | null = null;
  private headerTitleEl: HTMLDivElement | null = null;
  private headerSubtitleEl: HTMLDivElement | null = null;
  private inlineErrorEl: HTMLDivElement | null = null;
  private bodyEl: HTMLDivElement | null = null;
  private currentView: OverlayViewState | null = null;
  private inlineError: UserFacingError | null = null;
  private debugPromptOpen = false;
  private debugPromptOperationId: string | null = null;
  private loadingElapsedTimer: number | null = null;
  private dismissMode: OverlayDismissMode = 'close';
  private renderTraceEnabledFromStorage: boolean | null = null;
  private lastFocusedReplyOpId: string | null = null;
  private readonly renderTraceState: OverlayRenderTraceState = {
    renderCount: 0,
    lastKind: null,
    lastOperationId: null,
  };

  constructor(private readonly callbacks: OverlayCallbacks) {
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.model.kind !== 'hidden') {
        this.handleDismiss();
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
      if (this.model.feature !== 'fast-reply') return;
      if (isEditableElement(document.activeElement)) return;
      if (isInteractiveElement(document.activeElement)) return;
      if (
        document.activeElement &&
        document.activeElement !== document.body &&
        !this.root.contains(document.activeElement)
      ) return;
      const next = this.getNextInsertablePart(this.model.parts);
      if (!next) return;
      event.preventDefault();
      void this.insertPart(next, { autoPassThrough: true });
    });
  }

  private handleDismiss(): void {
    if (this.model.kind === 'hidden') return;
    const mode = this.dismissMode;
    if (mode === 'collapse-to-inline') {
      this.callbacks.onCollapse();
    } else {
      if (mode === 'cancel-and-close' && this.model.kind === 'loading' && 'operationId' in this.model && this.model.operationId) {
        this.callbacks.onCancel(this.model.operationId);
      }
      this.callbacks.onClose();
    }
  }

  render(model: OverlayViewModel, options?: OverlayRenderOptions | boolean): void {
    const opts: OverlayRenderOptions =
      typeof options === 'boolean' ? { preserveInlineError: options } : (options ?? {});
    const renderStart = performance.now();
    const operationId = operationIdForModel(model);
    let shellAction: 'mounted' | 'reused' | 'hidden' = 'reused';
    let bodyAction: 'none' | 'rebuild-body' | 'update-loading' = 'none';

    this.model = model;
    if (model.kind === 'error') {
      this.inlineError = null;
    } else if (!opts.preserveInlineError) {
      this.inlineError = null;
    }
    if (model.kind === 'hidden' || model.kind === 'loading' || model.kind === 'error') {
      this.passThrough = false;
    }
    // Set dismiss mode: explicit option > default based on kind
    if (opts.dismissMode) {
      this.dismissMode = opts.dismissMode;
    } else if (model.kind === 'loading') {
      this.dismissMode = 'cancel-and-close';
    } else {
      this.dismissMode = 'close';
    }
    document.body.classList.toggle('chatmuse-scroll-lock', model.kind !== 'hidden');
    this.root.style.pointerEvents = model.kind === 'hidden' ? 'none' : 'auto';

    if (model.kind === 'hidden') {
      this.clearLoadingElapsedTimer();
      this.debugPromptOpen = false;
      this.debugPromptOperationId = null;
      this.teardownShell();
      shellAction = 'hidden';
      this.logRenderTrace(renderStart, model, operationId, shellAction, bodyAction);
      return;
    }

    if (model.kind !== 'loading') {
      this.clearLoadingElapsedTimer();
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

    if (this.ensureShell()) {
      shellAction = 'mounted';
    }
    this.syncBackdropPassThrough();
    this.updateHeader(model);
    this.updateInlineError(model);
    bodyAction = this.renderBody(model);
    this.logRenderTrace(renderStart, model, operationId, shellAction, bodyAction);
  }

  private syncBackdropPassThrough(): void {
    this.backdropEl?.classList.toggle('chatmuse-pass-through', this.passThrough);
  }

  private queueComposerFocus(): void {
    window.requestAnimationFrame(() => {
      focusActiveConversationTextarea();
    });
  }

  private clearLoadingElapsedTimer(): void {
    if (this.loadingElapsedTimer === null) {
      return;
    }
    window.clearInterval(this.loadingElapsedTimer);
    this.loadingElapsedTimer = null;
  }

  private async insertPart(
    part: OverlayInsertPart,
    options?: { autoPassThrough?: boolean },
  ): Promise<void> {
    try {
      await insertIntoFanslyTextarea(part.text);
      part.insertedOnce = true;
      part.insertedAt = Date.now();
      this.inlineError = null;
      if (options?.autoPassThrough) {
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

  private ensureShell(): boolean {
    if (
      this.shellEl &&
      this.shellEl.isConnected &&
      this.backdropEl &&
      this.panelEl &&
      this.headerEyebrowEl &&
      this.headerTitleEl &&
      this.headerSubtitleEl &&
      this.inlineErrorEl &&
      this.bodyEl
    ) {
      return false;
    }

    const shell = document.createElement('div');
    shell.className = 'chatmuse-overlay-shell';

    const backdrop = document.createElement('div');
    backdrop.className = 'chatmuse-overlay-backdrop';
    backdrop.addEventListener('click', () => {
      if (this.passThrough) {
        return;
      }
      this.handleDismiss();
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

    const header = document.createElement('div');
    header.className = 'chatmuse-overlay-header';

    const title = document.createElement('div');
    title.className = 'chatmuse-overlay-title';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'chatmuse-eyebrow';
    const h1 = document.createElement('div');
    h1.className = 'chatmuse-title';
    const subtitle = document.createElement('div');
    subtitle.className = 'chatmuse-subtitle';
    title.append(eyebrow, h1, subtitle);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chatmuse-close';
    close.textContent = '\u00d7';
    close.addEventListener('click', () => {
      this.handleDismiss();
    });

    header.append(title, close);
    const inlineError = document.createElement('div');
    inlineError.className = 'chatmuse-inline-error chatmuse-hidden';

    const body = document.createElement('div');
    body.className = 'chatmuse-overlay-body';

    panel.append(header, inlineError, body);
    shell.append(backdrop, panel);
    this.root.replaceChildren(shell);

    this.shellEl = shell;
    this.backdropEl = backdrop;
    this.panelEl = panel;
    this.headerEyebrowEl = eyebrow;
    this.headerTitleEl = h1;
    this.headerSubtitleEl = subtitle;
    this.inlineErrorEl = inlineError;
    this.bodyEl = body;
    this.currentView = null;
    return true;
  }

  private teardownShell(): void {
    this.clearLoadingElapsedTimer();
    this.root.replaceChildren();
    this.shellEl = null;
    this.backdropEl = null;
    this.panelEl = null;
    this.headerEyebrowEl = null;
    this.headerTitleEl = null;
    this.headerSubtitleEl = null;
    this.inlineErrorEl = null;
    this.bodyEl = null;
    this.currentView = null;
    this.lastFocusedReplyOpId = null;
  }

  private updateHeader(model: VisibleOverlayModel): void {
    if (!this.headerEyebrowEl || !this.headerTitleEl || !this.headerSubtitleEl) {
      return;
    }

    const feature =
      model.kind === 'loading' || model.kind === 'reply' || model.kind === 'helpMe' || model.kind === 'readOnly'
        ? titleForFeature(model.feature)
        : 'ChatMuse';
    const titleText =
      model.kind === 'error' ? 'ChatMuse' : `${feature} — @${model.fanDisplayName || 'fan'}`;
    const subtitleText =
      model.kind === 'error' ? 'Something went wrong' : 'Preview only. You send messages manually.';

    if (this.headerEyebrowEl.textContent !== feature) {
      this.headerEyebrowEl.textContent = feature;
    }
    if (this.headerTitleEl.textContent !== titleText) {
      this.headerTitleEl.textContent = titleText;
    }
    if (this.headerSubtitleEl.textContent !== subtitleText) {
      this.headerSubtitleEl.textContent = subtitleText;
    }
  }

  private updateInlineError(model: VisibleOverlayModel): void {
    if (!this.inlineErrorEl) {
      return;
    }

    if (model.kind !== 'error' && this.inlineError) {
      if (this.inlineErrorEl.textContent !== this.inlineError.message) {
        this.inlineErrorEl.textContent = this.inlineError.message;
      }
      this.inlineErrorEl.classList.remove('chatmuse-hidden');
      return;
    }

    if (this.inlineErrorEl.textContent) {
      this.inlineErrorEl.textContent = '';
    }
    this.inlineErrorEl.classList.add('chatmuse-hidden');
  }

  private renderBody(model: VisibleOverlayModel): 'rebuild-body' | 'update-loading' {
    if (!this.bodyEl) {
      return 'rebuild-body';
    }

    if (model.kind === 'loading' && this.currentView?.kind === 'loading' && this.currentView.operationId === model.operationId) {
      this.updateLoadingView(this.currentView, model);
      return 'update-loading';
    }

    const nextView =
      model.kind === 'loading'
        ? this.createLoadingView(model)
        : {
            kind: model.kind,
            operationId: operationIdForModel(model),
            root:
              model.kind === 'reply'
                ? this.renderReply(model)
                : model.kind === 'helpMe'
                  ? this.renderHelpMe(model)
                  : model.kind === 'readOnly'
                    ? this.renderReadOnly(model)
                    : this.renderError(model),
          };

    this.bodyEl.replaceChildren(nextView.root);
    this.currentView = nextView;

    // Auto-focus the first Insert button for newly visible completed fast replies
    if (
      model.kind === 'reply' &&
      model.feature === 'fast-reply' &&
      operationIdForModel(model) !== this.lastFocusedReplyOpId
    ) {
      this.lastFocusedReplyOpId = operationIdForModel(model);
      queueMicrotask(() => {
        const btn = nextView.root.querySelector<HTMLButtonElement>('.chatmuse-card-actions .chatmuse-button');
        btn?.focus();
      });
    }

    return 'rebuild-body';
  }

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

    const spendHost = document.createElement('div');
    spendHost.className = 'chatmuse-loading-spend-host';

    const debugHost = document.createElement('div');

    const actions = document.createElement('div');
    actions.className = 'chatmuse-overlay-actions';
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

    section.append(spendHost, status, stream, actions);

    const view: LoadingViewState = {
      kind: 'loading',
      operationId: model.operationId,
      root: section,
      statusText,
      streamText,
      spendHost,
      profilingHost: null,
      debugHost,
      actions,
      debugSnapshot: null,
      liveElapsedBaseMs: null,
      liveElapsedStartedAt: null,
    };
    this.updateLoadingView(view, model);
    return view;
  }

  private updateLoadingView(
    view: LoadingViewState,
    model: Extract<OverlayViewModel, { kind: 'loading' }>,
  ): void {
    const streamText = model.rawText || 'Waiting for Claude\u2026';

    this.syncLoadingSpend(view, model);
    this.syncLoadingProfiling(view, model);
    this.refreshLoadingStatus(view, model);
    if (view.streamText.data !== streamText) {
      view.streamText.data = streamText;
    }
    this.syncLoadingDebugPrompt(view, model);
  }

  private refreshLoadingStatus(
    view: LoadingViewState,
    model: Extract<OverlayViewModel, { kind: 'loading' }>,
  ): void {
    const statusText = this.loadingStatusText(view, model);
    if (view.statusText.data !== statusText) {
      view.statusText.data = statusText;
    }
  }

  private syncLoadingSpend(
    view: LoadingViewState,
    model: Extract<OverlayViewModel, { kind: 'loading' }>,
  ): void {
    const spend = model.anthropicSpend;
    const spendKey = spend
      ? [
          spend.totalTokens,
          spend.totalUsd,
          spend.cacheEffectUsd,
          spend.cacheEffectKind,
          spend.approximate ? 'approx' : 'exact',
        ].join(':')
      : 'pending';
    if (view.spendHost.dataset.spendKey === spendKey) {
      return;
    }
    view.spendHost.dataset.spendKey = spendKey;
    view.spendHost.replaceChildren(
      this.renderSpendStrip(spend, { placeholder: true }),
    );
  }

  private loadingStatusText(
    view: LoadingViewState,
    model: Extract<OverlayViewModel, { kind: 'loading' }>,
  ): string {
    if (!model.profiling) {
      return model.progress?.message ?? 'Generating\u2026';
    }

    const label =
      model.profiling.activeLabel ??
      model.progress?.message ??
      'Generating\u2026';
    const elapsedMs =
      view.liveElapsedBaseMs !== null &&
      view.liveElapsedStartedAt !== null
        ? view.liveElapsedBaseMs +
          Math.max(0, Date.now() - view.liveElapsedStartedAt)
        : model.profiling.elapsedMs;

    return `${label} • ${formatProfilingElapsed(elapsedMs)}`;
  }

  private syncLoadingProfiling(
    view: LoadingViewState,
    model: Extract<OverlayViewModel, { kind: 'loading' }>,
  ): void {
    const snapshot = model.profiling ?? null;
    if (!snapshot) {
      view.liveElapsedBaseMs = null;
      view.liveElapsedStartedAt = null;
      if (view.profilingHost) {
        view.profilingHost.replaceChildren();
        view.profilingHost.remove();
        view.profilingHost = null;
      }
      this.clearLoadingElapsedTimer();
      return;
    }

    if (!view.profilingHost) {
      view.profilingHost = document.createElement('div');
      const stream = view.streamText.parentElement;
      if (stream) {
        view.root.insertBefore(view.profilingHost, stream);
      } else {
        view.root.insertBefore(view.profilingHost, view.actions);
      }
    }

    view.liveElapsedBaseMs = snapshot.elapsedMs;
    view.liveElapsedStartedAt = Date.now();
    view.profilingHost.replaceChildren(
      this.renderProfilingCard(snapshot, 'loading'),
    );

    if (this.loadingElapsedTimer === null) {
      this.loadingElapsedTimer = window.setInterval(() => {
        if (
          this.currentView?.kind !== 'loading' ||
          this.model.kind !== 'loading'
        ) {
          this.clearLoadingElapsedTimer();
          return;
        }
        this.refreshLoadingStatus(this.currentView, this.model);
      }, 100);
    }
  }

  private syncLoadingDebugPrompt(
    view: LoadingViewState,
    model: Extract<OverlayViewModel, { kind: 'loading' }>,
  ): void {
    const snapshot = model.debugPrompt ?? null;
    if (!snapshot) {
      if (view.debugHost.isConnected) {
        view.debugHost.remove();
      }
      view.debugSnapshot = null;
      return;
    }

    if (!view.debugHost.isConnected) {
      view.root.insertBefore(view.debugHost, view.actions);
    }
    if (view.debugSnapshot !== snapshot) {
      view.debugHost.replaceChildren(this.renderDebugPrompt(snapshot));
      view.debugSnapshot = snapshot;
    }
  }

  private isRenderTraceEnabled(): boolean {
    if ((globalThis as { __CHATMUSE_OVERLAY_DEBUG__?: unknown }).__CHATMUSE_OVERLAY_DEBUG__ === true) {
      return true;
    }

    if (this.renderTraceEnabledFromStorage !== null) {
      return this.renderTraceEnabledFromStorage;
    }

    try {
      this.renderTraceEnabledFromStorage = window.localStorage.getItem('chatmuse:overlay-debug') === '1';
    } catch {
      this.renderTraceEnabledFromStorage = false;
    }

    return this.renderTraceEnabledFromStorage;
  }

  private logRenderTrace(
    renderStart: number,
    model: OverlayViewModel,
    operationId: string | null,
    shellAction: 'mounted' | 'reused' | 'hidden',
    bodyAction: 'none' | 'rebuild-body' | 'update-loading',
  ): void {
    const durationMs = performance.now() - renderStart;
    const count = this.renderTraceState.renderCount + 1;
    const sameKindAsPrevious = this.renderTraceState.lastKind === model.kind;
    const sameOperationIdAsPrevious = this.renderTraceState.lastOperationId === operationId;

    if (this.isRenderTraceEnabled()) {
      console.debug('[ChatMuse overlay render]', {
        count,
        timestamp: new Date().toISOString(),
        kind: model.kind,
        operationId,
        sameKindAsPrevious,
        sameOperationIdAsPrevious,
        shellAction,
        bodyAction,
        durationMs: Number(durationMs.toFixed(2)),
      });
    }

    this.renderTraceState.renderCount = count;
    this.renderTraceState.lastKind = model.kind;
    this.renderTraceState.lastOperationId = operationId;
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
    insert.addEventListener('click', () => {
      void this.insertPart(part, { autoPassThrough: options.autoPassThrough });
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
        this.render(this.model, true);
      }
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

    if (model.anthropicSpend) {
      section.append(this.renderSpendStrip(model.anthropicSpend));
    }

    if (model.profiling) {
      section.append(this.renderProfilingCard(model.profiling, 'summary'));
    }

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

    section.append(this.renderCompletedActions(model.feature, model.rerunActionLabel));
    return section;
  }

  // ─── Help Me ────────────────────────────────────────────────────────

  private renderHelpMe(model: Extract<OverlayViewModel, { kind: 'helpMe' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    if (model.anthropicSpend) {
      section.append(this.renderSpendStrip(model.anthropicSpend));
    }

    if (model.profiling) {
      section.append(this.renderProfilingCard(model.profiling, 'summary'));
    }

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

    if (model.debugPrompt) {
      section.append(this.renderDebugPrompt(model.debugPrompt));
    }

    section.append(this.renderCompletedActions(model.feature, model.rerunActionLabel));
    return section;
  }

  // ─── Read Only (Summary, Review) ───────────────────────────────────

  private renderReadOnly(model: Extract<OverlayViewModel, { kind: 'readOnly' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    if (model.anthropicSpend) {
      section.append(this.renderSpendStrip(model.anthropicSpend));
    }

    if (model.profiling) {
      section.append(this.renderProfilingCard(model.profiling, 'summary'));
    }

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

    if (model.debugPrompt) {
      section.append(this.renderDebugPrompt(model.debugPrompt));
    }

    section.append(this.renderCompletedActions(model.feature, model.rerunActionLabel));
    return section;
  }

  private renderCompletedActions(
    feature: FeatureType,
    rerunActionLabel: OverlayRerunActionLabel | undefined,
  ): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'chatmuse-overlay-actions';

    if (!rerunActionLabel) {
      return actions;
    }

    const rerun = document.createElement('button');
    rerun.type = 'button';
    rerun.className = 'chatmuse-button';
    rerun.textContent = rerunActionLabel;
    rerun.addEventListener('click', () => this.callbacks.onRerun(feature));
    actions.append(rerun);
    return actions;
  }

  // ─── Error ──────────────────────────────────────────────────────────

  private renderError(model: Extract<OverlayViewModel, { kind: 'error' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatmuse-grid';

    if (model.anthropicSpend) {
      section.append(this.renderSpendStrip(model.anthropicSpend));
    }

    const block = document.createElement('div');
    block.className = 'chatmuse-inline-error';
    block.textContent = model.error.message;
    section.append(block);

    if (model.profiling) {
      section.append(this.renderProfilingCard(model.profiling, 'summary'));
    }

    if (model.debugPrompt) {
      section.append(this.renderDebugPrompt(model.debugPrompt));
    }

    return section;
  }

  private renderSpendStrip(
    spend?: AnthropicSpendSummary,
    options?: { placeholder?: boolean },
  ): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'chatmuse-spend-strip';

    const primary = document.createElement('div');
    primary.className = 'chatmuse-spend-strip-primary';

    const secondary = document.createElement('div');
    secondary.className = 'chatmuse-spend-strip-secondary';

    if (!spend && options?.placeholder) {
      strip.classList.add('chatmuse-spend-strip-pending');
      primary.textContent = 'Cost pending · Tokens pending';
      secondary.textContent = 'in — · write — · read — · out —';
      strip.append(primary, secondary);
      return strip;
    }

    if (!spend) {
      return strip;
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

    strip.append(primary, secondary);
    return strip;
  }

  private renderProfilingCard(
    snapshot: OperationProfilingSnapshot,
    mode: 'loading' | 'summary',
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'chatmuse-profiling';
    card.append(
      this.createProfilingHeader(snapshot),
      mode === 'loading'
        ? this.renderProfilingLog(snapshot)
        : this.renderProfilingSummary(snapshot),
    );
    return card;
  }

  private createProfilingHeader(
    snapshot: OperationProfilingSnapshot,
  ): HTMLElement {
    const header = document.createElement('div');
    header.className = 'chatmuse-debug-summary';
    header.textContent = `Pipeline Profiling • ${formatProfilingElapsed(snapshot.elapsedMs)}`;
    return header;
  }

  private renderProfilingLog(
    snapshot: OperationProfilingSnapshot,
  ): HTMLElement {
    const container = document.createElement('div');
    container.className = 'chatmuse-profiling-log';

    for (const entry of snapshot.logEntries) {
      const row = document.createElement('div');
      row.className = 'chatmuse-profiling-entry';

      const elapsed = document.createElement('div');
      elapsed.className = 'chatmuse-profiling-elapsed';
      elapsed.textContent = `+${formatProfilingElapsed(entry.elapsedMs)}`;

      const message = document.createElement('div');
      message.className = 'chatmuse-profiling-message';
      message.textContent = entry.message;

      row.append(elapsed, message);
      container.append(row);
    }

    return container;
  }

  private renderProfilingSummary(
    snapshot: OperationProfilingSnapshot,
  ): HTMLElement {
    const container = document.createElement('div');
    container.className = 'chatmuse-profiling-summary';

    const total = document.createElement('div');
    total.className = 'chatmuse-profiling-stage';

    const totalLabel = document.createElement('div');
    totalLabel.className = 'chatmuse-profiling-stage-label';
    totalLabel.textContent = 'Total';

    const totalDuration = document.createElement('div');
    totalDuration.className = 'chatmuse-profiling-stage-duration';
    totalDuration.textContent = formatProfilingElapsed(snapshot.elapsedMs);

    total.append(totalLabel, totalDuration);
    container.append(total);

    if (snapshot.anthropicUsage) {
      const usageRow = document.createElement('div');
      usageRow.className = 'chatmuse-profiling-stage';

      const usageLabel = document.createElement('div');
      usageLabel.className = 'chatmuse-profiling-stage-label';
      usageLabel.textContent = 'Claude usage';

      const usageDuration = document.createElement('div');
      usageDuration.className = 'chatmuse-profiling-stage-duration';
      usageDuration.textContent = 'tokens';

      const usageDetail = document.createElement('div');
      usageDetail.className = 'chatmuse-profiling-stage-detail';
      usageDetail.textContent = formatAnthropicUsageSummary(
        snapshot.anthropicUsage,
      );

      usageRow.append(usageLabel, usageDuration, usageDetail);
      container.append(usageRow);
    }

    if (snapshot.anthropicCost) {
      const costRow = document.createElement('div');
      costRow.className = 'chatmuse-profiling-stage';

      const costLabel = document.createElement('div');
      costLabel.className = 'chatmuse-profiling-stage-label';
      costLabel.textContent = 'Claude cost';

      const costDuration = document.createElement('div');
      costDuration.className = 'chatmuse-profiling-stage-duration';
      costDuration.textContent = formatUsd(
        snapshot.anthropicCost.totalUsd,
        snapshot.anthropicCost.approximate,
      );

      const costDetail = document.createElement('div');
      costDetail.className = 'chatmuse-profiling-stage-detail';
      costDetail.textContent = formatAnthropicCostSummary(snapshot.anthropicCost);

      costRow.append(costLabel, costDuration, costDetail);
      container.append(costRow);
    }

    for (const stage of snapshot.stages) {
      const row = document.createElement('div');
      row.className = 'chatmuse-profiling-stage';

      const label = document.createElement('div');
      label.className = 'chatmuse-profiling-stage-label';
      label.textContent = stage.label;

      const duration = document.createElement('div');
      duration.className = 'chatmuse-profiling-stage-duration';
      duration.textContent =
        stage.status === 'skipped'
          ? 'skipped'
          : stage.status === 'failed'
            ? `${formatProfilingElapsed(stage.durationMs ?? 0)} failed`
            : stage.durationMs !== undefined
              ? formatProfilingElapsed(stage.durationMs)
              : stage.status;

      row.append(label, duration);

      if (stage.detail) {
        const detail = document.createElement('div');
        detail.className = 'chatmuse-profiling-stage-detail';
        detail.textContent = stage.detail;
        row.append(detail);
      }

      container.append(row);
    }

    return container;
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
