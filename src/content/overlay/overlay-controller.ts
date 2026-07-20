import { COACH_QUESTION_MAX_CHARS } from '../../shared/constants.js';
import { toUserError } from '../../shared/errors.js';
import type {
  CoachAutoRecapOverride,
  CoachOverlayDraft,
  CoachOverlayFeedItem,
  CoachOverlaySessionView,
  DebugPromptEchoStatus,
  LlmSpendSummary,
  LlmUsageMetrics,
  FanSummarySyncStatus,
  FeatureType,
  OverlayInsertPart,
  OverlayRerunActionLabel,
  OverlayViewModel,
  OperationProfilingSnapshot,
  PromptDebugSnapshot,
  UserFacingError,
} from '../../shared/types.js';
import { ensureOverlayRoot } from '../dom-anchor.js';
import { renderSummaryMarkdown } from './summary-markdown.js';
import {
  formatLlmCostSummary,
  formatCacheEffectInline,
  formatModelCostLabel,
  formatModelUsageLabel,
  formatSpendPrimary,
  formatSpendSecondary,
  formatUsd,
} from '../spend-format.js';
import {
  insertIntoFanslyTextarea,
  copyToClipboard,
  focusActiveConversationTextarea,
  getActiveConversationDraftText,
} from '../textarea.js';
import {
  createUserErrorBlock,
  formatLoadingStatus,
  getInsertButtonLabel,
  getNextInsertablePart,
  getReplyPartTitle,
  insertedFeedbackDelayMs,
  isEditableElement,
  isInsertFeedbackActive,
  isInteractiveElement,
} from '../ui/view-helpers.js';

// 'coach' is the coach-specific dismiss discipline (spec §3): Esc/backdrop while
// a turn STREAMS cancels the turn but keeps the overlay open (unlike
// 'cancel-and-close'); while idle it closes (the store retains the session).
type OverlayDismissMode = 'close' | 'cancel-and-close' | 'collapse-to-inline' | 'coach';

interface OverlayRenderOptions {
  preserveInlineError?: boolean;
  dismissMode?: OverlayDismissMode;
}

interface OverlayCallbacks {
  onClose: () => void;
  onCancel: (operationId: string) => void;
  onRerun: (feature: FeatureType) => void;
  onCollapse: () => void;
  /** Stage 32 Task 5: chatter took a suggestion (acceptance telemetry).
   * `generationRef` (coach only) is the correlation fallback for acceptance
   * after the background's op→ref map is gone (P2). */
  onAcceptance?: (
    operationId: string,
    action: 'copied' | 'inserted',
    partIndex: number,
    generationRef?: string,
  ) => void;
  /** E28: open the kernel's real prompt on the extension's own page. The token
   * stays with the caller — this surface never learns it, so it cannot leak it
   * into the Fansly DOM it renders into. */
  onOpenDebugPrompt?: () => void;
  /** Coach chat (spec §3). Optional so non-coach constructions stay valid. */
  onCoachSubmit?: (question: string) => void;
  /** «New dialog» — clears the session (the orchestrator confirms if non-empty). */
  onCoachNewDialog?: () => void;
  /** Explicit recap refresh from within coach (short/full, spec §5). */
  onCoachRecap?: (mode: 'short' | 'full') => void;
  /** Cycle the per-session auto-recap override (spec §5 topbar control). */
  onCoachAutoRecapCycle?: () => void;
  /** Retry a failed/cancelled turn — replays its question (spec §8). */
  onCoachRetry?: (question: string) => void;
  /** Live composer edits, so the orchestrator can persist `composerText`
   * across close/switch (spec §3 "unsent question survives close/switch").
   * Optional: the renderer never depends on it for its own correctness. */
  onCoachComposerInput?: (text: string) => void;
  /** Standalone Recap start dialog (spec §5): pick a mode to generate. */
  onRecapPick?: (mode: 'short' | 'full') => void;
  /** Standalone Recap start dialog (spec §5): «Открыть последний». */
  onRecapOpenLast?: () => void;
}

interface PartCardOptions {
  hint?: string;
  emphasis?: 'recommended' | 'followup';
  status?: string;
  autoPassThrough?: boolean;
}

type VisibleOverlayModel = Exclude<OverlayViewModel, { kind: 'hidden' }>;
// Coach has its own CoachViewState (not a StaticViewState), so it must be
// excluded here — otherwise `kind: 'coach'` cannot discriminate the two.
type StaticOverlayKind = Exclude<VisibleOverlayModel['kind'], 'loading' | 'coach'>;

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
  profilingHeaderText: Text | null;
  profilingLogEl: HTMLDivElement | null;
  profilingLogEntries: OperationProfilingSnapshot['logEntries'];
  profilingLogScrollHeight: number | null;
  debugHost: HTMLDivElement;
  actions: HTMLDivElement;
  debugSnapshot: PromptDebugSnapshot | null;
  debugEcho: DebugPromptEchoStatus | null;
  liveElapsedBaseMs: number | null;
  liveElapsedStartedAt: number | null;
}

/** Persistent DOM handles for the coach chat mode. The feed is rendered with a
 * KEYED incremental diff: `itemNodes` maps a per-item key (exchange operationId,
 * or feed index for failed/recap items) to its stable DOM node, so a re-render
 * never rebuilds a committed exchange and streaming mutates ONLY the pending
 * answer's text node (the `updateLoadingView` text-node pattern). */
interface CoachViewState {
  kind: 'coach';
  /** The live/top-level streaming op (null == idle); mirrors the model. */
  operationId: string | null;
  root: HTMLElement;
  /** Scroll container (role="log"); scrolls separately from the sticky composer. */
  feedEl: HTMLDivElement;
  /** Holds ONLY the keyed committed feed items, so their ordering is managed
   * independently of the pending / empty-state nodes appended after it. */
  itemsEl: HTMLDivElement;
  recapStatusEl: HTMLDivElement;
  recapStatusText: Text;
  /** The per-session auto-recap override cycle button (spec §5). */
  autoRecapButton: HTMLButtonElement;
  composerTextarea: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  itemNodes: Map<string, HTMLElement>;
  /** The last-rendered item per key, so a reused index-key whose content
   * changed (feed reset) rebuilds instead of showing a stale node. */
  renderedItems: Map<string, CoachOverlayFeedItem>;
  /** The in-flight turn's node (question bubble + streaming answer); null idle. */
  pendingNode: HTMLElement | null;
  /** The ONLY node mutated as stream chunks arrive. */
  pendingAnswerTextNode: Text | null;
  pendingQuestion: string | null;
  emptyStateNode: HTMLElement | null;
}

type OverlayViewState = StaticViewState | LoadingViewState | CoachViewState;

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
    case 'hi-greeting':
      return 'Hi Greeting';
    case 'help-me':
      return 'Help Me';
    case 'fan-summary':
      return 'Fan Summary';
    case 'chat-review':
      return 'Chat Review';
    case 'ping':
      return 'Ping';
    case 'voice-script':
      throw new Error('voice-script uses the dedicated voice panel');
    case 'coach-chat':
      return 'Coach';
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
  if (rating >= 9) return 'chatgoose-rating-excellent';
  if (rating >= 7) return 'chatgoose-rating-good';
  if (rating >= 5) return 'chatgoose-rating-average';
  if (rating >= 3) return 'chatgoose-rating-below';
  return 'chatgoose-rating-poor';
}

function formatFanSummarySyncStatus(
  syncStatus: FanSummarySyncStatus | undefined,
): string | null {
  switch (syncStatus?.state) {
    case 'not-set-up':
      return 'Server sync · not set up';
    case 'saving':
      return 'Server sync · saving...';
    case 'saved':
      return 'Server sync · saved';
    case 'failed':
      return syncStatus.error
        ? `Server sync · failed (${syncStatus.error.code})`
        : 'Server sync · failed';
    default:
      return null;
  }
}

function formatProfilingElapsed(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatLlmUsageSummary(usage: LlmUsageMetrics): string {
  return `input ${usage.input_tokens} • cache create ${usage.cache_creation_input_tokens} • cache read ${usage.cache_read_input_tokens} • output ${usage.output_tokens}`;
}

function operationIdForModel(model: OverlayViewModel): string | null {
  return 'operationId' in model ? model.operationId ?? null : null;
}

/** Empty-state starter prompts (spec §3): clicking one prefills the composer. */
const COACH_STARTER_HINTS: readonly string[] = [
  'How do I sell this to him?',
  'What is he actually into?',
  'How do I re-open a cold chat?',
];

/** Structural equality for a feed item at a reused key — drives the rebuild vs
 * reuse decision (exchanges are content-stable by op id; failed/recap items are
 * compared field-by-field). */
function sameCoachFeedItem(
  previous: CoachOverlayFeedItem | undefined,
  next: CoachOverlayFeedItem,
): boolean {
  if (!previous || previous.kind !== next.kind) {
    return false;
  }
  if (previous.kind === 'exchange' && next.kind === 'exchange') {
    return previous.operationId === next.operationId;
  }
  if (previous.kind === 'failed-attempt' && next.kind === 'failed-attempt') {
    return (
      previous.question === next.question &&
      previous.errorCode === next.errorCode &&
      previous.retryable === next.retryable
    );
  }
  if (previous.kind === 'recap-step' && next.kind === 'recap-step') {
    return (
      previous.mode === next.mode &&
      previous.origin === next.origin &&
      previous.status === next.status &&
      previous.note === next.note
    );
  }
  return false;
}

/** The per-session auto-recap override cycle button label (spec §5). */
function autoRecapLabel(override: CoachAutoRecapOverride): string {
  const value =
    override === 'inherit'
      ? 'default'
      : override === 'off'
        ? 'off'
        : override === 'short'
          ? 'short'
          : 'full';
  return `Auto-recap: ${value}`;
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
      // Escape during an IME composition cancels the composition, not the
      // overlay — never dismiss mid-compose (matters for the coach composer).
      if (event.key === 'Escape' && this.model.kind !== 'hidden' && !event.isComposing) {
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
      const next = getNextInsertablePart(this.model.parts);
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
      return;
    }
    if (mode === 'coach') {
      // Spec §3: Esc/backdrop while a turn streams cancels it but STAYS OPEN —
      // the orchestrator re-renders the idle session (with a failed-attempt).
      // Idle coach closes (the store retains the session for reopen).
      if (this.model.kind === 'coach' && this.model.operationId) {
        this.callbacks.onCancel(this.model.operationId);
        return;
      }
      this.callbacks.onClose();
      return;
    }
    if (mode === 'cancel-and-close' && this.model.kind === 'loading' && 'operationId' in this.model && this.model.operationId) {
      this.callbacks.onCancel(this.model.operationId);
    }
    this.callbacks.onClose();
  }

  render(model: OverlayViewModel, options?: OverlayRenderOptions | boolean): void {
    const opts: OverlayRenderOptions =
      typeof options === 'boolean' ? { preserveInlineError: options } : (options ?? {});
    const renderStart = performance.now();
    const operationId = operationIdForModel(model);
    let shellAction: 'mounted' | 'reused' | 'hidden' = 'reused';
    let bodyAction: 'none' | 'rebuild-body' | 'update-loading' | 'rebuild-coach' | 'update-coach' = 'none';

    this.model = model;
    if (model.kind === 'error') {
      this.inlineError = null;
    } else if (!opts.preserveInlineError) {
      this.inlineError = null;
    }
    if (
      model.kind === 'hidden' ||
      model.kind === 'loading' ||
      model.kind === 'error' ||
      model.kind === 'coach'
    ) {
      this.passThrough = false;
    }
    // Set dismiss mode: explicit option > default based on kind
    if (opts.dismissMode) {
      this.dismissMode = opts.dismissMode;
    } else if (model.kind === 'coach') {
      this.dismissMode = 'coach';
    } else if (model.kind === 'loading') {
      this.dismissMode = 'cancel-and-close';
    } else {
      this.dismissMode = 'close';
    }
    document.body.classList.toggle('chatgoose-scroll-lock', model.kind !== 'hidden');
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
    // Coach swaps the panel from a scrolling grid into a fixed-height flex
    // column whose FEED scrolls (not the panel) beneath a sticky composer.
    this.panelEl?.classList.toggle('chatgoose-overlay-coach', model.kind === 'coach');
    this.updateHeader(model);
    this.updateInlineError(model);
    bodyAction = this.renderBody(model);
    this.logRenderTrace(renderStart, model, operationId, shellAction, bodyAction);
  }

  private syncBackdropPassThrough(): void {
    this.backdropEl?.classList.toggle('chatgoose-pass-through', this.passThrough);
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
        this.callbacks.onAcceptance?.(operationId, 'inserted', part.sequenceIndex);
        this.scheduleInsertedReset(part, operationId);
      }
      this.queueComposerFocus();
    } catch (error) {
      this.inlineError = toUserError(error);
      this.render(this.model, true);
    }
  }

  private scheduleInsertedReset(part: OverlayInsertPart, operationId: string): void {
    window.setTimeout(() => {
      part.insertedAt = null;
      if ('operationId' in this.model && this.model.operationId === operationId) {
        this.render(this.model);
      }
    }, insertedFeedbackDelayMs());
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
    shell.className = 'chatgoose-overlay-shell';

    const backdrop = document.createElement('div');
    backdrop.className = 'chatgoose-overlay-backdrop';
    backdrop.addEventListener('click', () => {
      if (this.passThrough) {
        return;
      }
      this.handleDismiss();
    });

    const panel = document.createElement('div');
    panel.className = 'chatgoose-overlay-panel';
    panel.addEventListener('pointerdown', () => {
      if (!this.passThrough) {
        return;
      }
      this.passThrough = false;
      this.syncBackdropPassThrough();
    });

    const header = document.createElement('div');
    header.className = 'chatgoose-overlay-header';

    const title = document.createElement('div');
    title.className = 'chatgoose-overlay-title';
    const eyebrow = document.createElement('div');
    eyebrow.className = 'chatgoose-eyebrow';
    const h1 = document.createElement('div');
    h1.className = 'chatgoose-title';
    const subtitle = document.createElement('div');
    subtitle.className = 'chatgoose-subtitle';
    title.append(eyebrow, h1, subtitle);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'chatgoose-close';
    close.textContent = '\u00d7';
    close.addEventListener('click', () => {
      this.handleDismiss();
    });

    header.append(title, close);
    const inlineError = document.createElement('div');
    inlineError.className = 'chatgoose-inline-error chatgoose-hidden';

    const body = document.createElement('div');
    body.className = 'chatgoose-overlay-body';

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
        : model.kind === 'coach'
          ? 'Coach'
          : model.kind === 'recap-picker'
            ? 'Recap'
            : 'ChatGoose';
    const titleText =
      model.kind === 'error'
        ? 'ChatGoose'
        : `${feature} — @${model.fanDisplayName || 'fan'}`;
    const subtitleText =
      model.kind === 'error'
        ? 'Something went wrong'
        : model.kind === 'coach'
          ? 'Ask about this fan. You send messages manually.'
          : model.kind === 'recap-picker'
            ? 'Choose a recap. Nothing is generated until you pick.'
            : 'Preview only. You send messages manually.';

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
      const content = createUserErrorBlock(this.inlineError);
      this.inlineErrorEl.replaceChildren(...Array.from(content.childNodes));
      this.inlineErrorEl.classList.remove('chatgoose-hidden');
      return;
    }

    if (this.inlineErrorEl.childNodes.length > 0) {
      this.inlineErrorEl.replaceChildren();
    }
    this.inlineErrorEl.classList.add('chatgoose-hidden');
  }

  private renderBody(
    model: VisibleOverlayModel,
  ): 'rebuild-body' | 'update-loading' | 'rebuild-coach' | 'update-coach' {
    if (!this.bodyEl) {
      return 'rebuild-body';
    }

    if (model.kind === 'loading' && this.currentView?.kind === 'loading' && this.currentView.operationId === model.operationId) {
      this.updateLoadingView(this.currentView, model);
      return 'update-loading';
    }

    // Coach: keyed incremental renderer with its own view state. An existing
    // coach view is reconciled in place (committed nodes reused, only changed
    // bits touched — during streaming that is JUST the pending text node).
    if (model.kind === 'coach') {
      if (this.currentView?.kind === 'coach') {
        this.updateCoachView(this.currentView, model);
        return 'update-coach';
      }
      const view = this.createCoachView(model);
      this.bodyEl.replaceChildren(view.root);
      this.currentView = view;
      // A rebuild is a (re)open: the feed is only measurable once attached
      // (createCoachView runs updateCoachView while detached → scrollHeight 0),
      // so pin it to the newest turn HERE, after attach.
      this.scrollCoachFeedToBottom(view);
      return 'rebuild-coach';
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
                    : model.kind === 'recap-picker'
                      ? this.renderRecapPicker(model)
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
        const btn = nextView.root.querySelector<HTMLButtonElement>('.chatgoose-card-actions .chatgoose-button');
        btn?.focus();
      });
    }

    return 'rebuild-body';
  }

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

    const spendHost = document.createElement('div');
    spendHost.className = 'chatgoose-loading-spend-host';

    const debugHost = document.createElement('div');

    const actions = document.createElement('div');
    actions.className = 'chatgoose-overlay-actions';
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

    section.append(spendHost, status, stream, actions);

    const view: LoadingViewState = {
      kind: 'loading',
      operationId: model.operationId,
      root: section,
      statusText,
      streamText,
      spendHost,
      profilingHost: null,
      profilingHeaderText: null,
      profilingLogEl: null,
      profilingLogEntries: [],
      profilingLogScrollHeight: null,
      debugHost,
      actions,
      debugSnapshot: null,
      debugEcho: null,
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
    const streamText = model.rawText || 'Waiting for AI\u2026';

    this.syncLoadingSpend(view, model);
    this.syncLoadingProfiling(view, model);
    this.refreshLoadingStatus(view, model);
    this.syncLoadingStatusTimer(view, model);
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
    const spend = model.llmSpend;
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
    const baseStatus = formatLoadingStatus(model.progress);
    if (!model.profiling) {
      return baseStatus;
    }

    const label = model.progress?.statusCode
      ? baseStatus
      : (
          model.profiling.activeLabel ??
          baseStatus
        );
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
      view.profilingHeaderText = null;
      view.profilingLogEl = null;
      view.profilingLogEntries = [];
      view.profilingLogScrollHeight = null;
      return;
    }

    if (!view.profilingHost || !view.profilingHeaderText || !view.profilingLogEl) {
      const profilingView = this.createLoadingProfilingView(snapshot);
      view.profilingHost = profilingView.host;
      view.profilingHeaderText = profilingView.headerText;
      view.profilingLogEl = profilingView.log;
      view.profilingLogEntries = snapshot.logEntries.map((entry) => ({ ...entry }));
      view.profilingLogScrollHeight = profilingView.log.scrollHeight;
      const stream = view.streamText.parentElement;
      if (stream) {
        view.root.insertBefore(view.profilingHost, stream);
      } else {
        view.root.insertBefore(view.profilingHost, view.actions);
      }
    } else {
      this.updateLoadingProfilingView(view, snapshot);
    }

    view.liveElapsedBaseMs = snapshot.elapsedMs;
    view.liveElapsedStartedAt = Date.now();
  }

  private createLoadingProfilingView(
    snapshot: OperationProfilingSnapshot,
  ): { host: HTMLDivElement; headerText: Text; log: HTMLDivElement } {
    const host = document.createElement('div');
    const card = document.createElement('div');
    card.className = 'chatgoose-profiling';

    const header = document.createElement('div');
    header.className = 'chatgoose-debug-summary';
    const headerText = document.createTextNode('');
    header.append(headerText);

    const log = document.createElement('div');
    log.className = 'chatgoose-profiling-log';

    card.append(header, log);
    host.append(card);

    this.updateLoadingProfilingHeaderText(headerText, snapshot);
    this.replaceLoadingProfilingLogEntries(log, snapshot.logEntries);

    return { host, headerText, log };
  }

  private updateLoadingProfilingView(
    view: LoadingViewState,
    snapshot: OperationProfilingSnapshot,
  ): void {
    if (!view.profilingHeaderText || !view.profilingLogEl) {
      return;
    }

    this.updateLoadingProfilingHeaderText(view.profilingHeaderText, snapshot);
    this.syncLoadingProfilingLogEntries(view, snapshot.logEntries);
  }

  private updateLoadingProfilingHeaderText(
    headerText: Text,
    snapshot: OperationProfilingSnapshot,
  ): void {
    const nextText =
      `Pipeline Profiling • ${formatProfilingElapsed(snapshot.elapsedMs)}`;
    if (headerText.data !== nextText) {
      headerText.data = nextText;
    }
  }

  private syncLoadingProfilingLogEntries(
    view: LoadingViewState,
    nextEntries: OperationProfilingSnapshot['logEntries'],
  ): void {
    const log = view.profilingLogEl;
    if (!log) {
      return;
    }

    const previousScrollTop = log.scrollTop;
    const previousScrollHeight =
      typeof view.profilingLogScrollHeight === 'number' &&
      view.profilingLogScrollHeight > 0
        ? view.profilingLogScrollHeight
        : log.clientHeight > 0
          ? Math.max(0, previousScrollTop + log.clientHeight)
          : log.scrollHeight;
    const wasPinnedToBottom = this.isScrolledToBottom(
      log,
      previousScrollHeight,
    );
    const previousEntries = view.profilingLogEntries;
    const isAppendOnly =
      nextEntries.length >= previousEntries.length &&
      previousEntries.every((entry, index) =>
        this.isSameProfilingLogEntry(entry, nextEntries[index]),
      );

    if (isAppendOnly && nextEntries.length > previousEntries.length) {
      for (const entry of nextEntries.slice(previousEntries.length)) {
        log.append(this.createProfilingLogRow(entry));
      }
      log.scrollTop = wasPinnedToBottom
        ? Math.max(0, log.scrollHeight - log.clientHeight)
        : previousScrollTop;
    } else if (!isAppendOnly) {
      this.replaceLoadingProfilingLogEntries(log, nextEntries);
      log.scrollTop = wasPinnedToBottom
        ? Math.max(0, log.scrollHeight - log.clientHeight)
        : previousScrollTop;
    }

    view.profilingLogEntries = nextEntries.map((entry) => ({ ...entry }));
    view.profilingLogScrollHeight = log.scrollHeight;
  }

  private isScrolledToBottom(
    log: HTMLDivElement,
    scrollHeight = log.scrollHeight,
  ): boolean {
    const maxScrollTop = Math.max(0, scrollHeight - log.clientHeight);
    if (maxScrollTop === 0) {
      return log.scrollTop <= 0;
    }
    return maxScrollTop - log.scrollTop <= 4;
  }

  private replaceLoadingProfilingLogEntries(
    container: HTMLDivElement,
    entries: OperationProfilingSnapshot['logEntries'],
  ): void {
    container.replaceChildren(
      ...entries.map((entry) => this.createProfilingLogRow(entry)),
    );
  }

  private createProfilingLogRow(
    entry: OperationProfilingSnapshot['logEntries'][number],
  ): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'chatgoose-profiling-entry';

    const elapsed = document.createElement('div');
    elapsed.className = 'chatgoose-profiling-elapsed';
    elapsed.textContent = `+${formatProfilingElapsed(entry.elapsedMs)}`;

    const message = document.createElement('div');
    message.className = 'chatgoose-profiling-message';
    message.textContent = entry.message;

    row.append(elapsed, message);
    return row;
  }

  private isSameProfilingLogEntry(
    left: OperationProfilingSnapshot['logEntries'][number],
    right: OperationProfilingSnapshot['logEntries'][number] | undefined,
  ): boolean {
    return Boolean(
      right &&
      left.elapsedMs === right.elapsedMs &&
      left.message === right.message,
    );
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
      view.debugEcho = null;
      return;
    }

    if (!view.debugHost.isConnected) {
      view.root.insertBefore(view.debugHost, view.actions);
    }
    // The echo lands mid-stream, after the client snapshot — so a changed echo
    // must repaint too, not just a changed snapshot.
    const echo = model.debugEcho ?? null;
    if (view.debugSnapshot !== snapshot || view.debugEcho !== echo) {
      view.debugHost.replaceChildren(this.renderDebugPrompt(snapshot, echo ?? undefined));
      view.debugSnapshot = snapshot;
      view.debugEcho = echo;
    }
  }

  private syncLoadingStatusTimer(
    _view: LoadingViewState,
    model: Extract<OverlayViewModel, { kind: 'loading' }>,
  ): void {
    if (!model.profiling && typeof model.progress?.retryAtMs !== 'number') {
      this.clearLoadingElapsedTimer();
      return;
    }

    if (this.loadingElapsedTimer !== null) {
      return;
    }

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

  private isRenderTraceEnabled(): boolean {
    if ((globalThis as { __CHATGOOSE_OVERLAY_DEBUG__?: unknown }).__CHATGOOSE_OVERLAY_DEBUG__ === true) {
      return true;
    }

    if (this.renderTraceEnabledFromStorage !== null) {
      return this.renderTraceEnabledFromStorage;
    }

    try {
      this.renderTraceEnabledFromStorage = window.localStorage.getItem('chatgoose:overlay-debug') === '1';
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
    bodyAction: 'none' | 'rebuild-body' | 'update-loading' | 'rebuild-coach' | 'update-coach',
  ): void {
    const durationMs = performance.now() - renderStart;
    const count = this.renderTraceState.renderCount + 1;
    const sameKindAsPrevious = this.renderTraceState.lastKind === model.kind;
    const sameOperationIdAsPrevious = this.renderTraceState.lastOperationId === operationId;

    if (this.isRenderTraceEnabled()) {
      console.debug('[ChatGoose overlay render]', {
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

  // ─── Coach Chat ─────────────────────────────────────────────────────

  private createCoachView(model: Extract<OverlayViewModel, { kind: 'coach' }>): CoachViewState {
    const root = document.createElement('div');
    root.className = 'chatgoose-coach';

    // Topbar: recap freshness line + explicit refresh controls + New dialog.
    const topbar = document.createElement('div');
    topbar.className = 'chatgoose-coach-topbar';

    const recap = document.createElement('div');
    recap.className = 'chatgoose-coach-recap';
    const recapText = document.createTextNode('');
    recap.append(recapText);

    const topbarActions = document.createElement('div');
    topbarActions.className = 'chatgoose-coach-topbar-actions';
    const shortRecap = this.createCoachButton('Short recap', 'chatgoose-button-secondary', () =>
      this.callbacks.onCoachRecap?.('short'),
    );
    const fullRecap = this.createCoachButton('Full recap', 'chatgoose-button-secondary', () =>
      this.callbacks.onCoachRecap?.('full'),
    );
    // Per-session auto-recap override cycle (spec §5): inherit → off → short →
    // full. Its label is refreshed in updateCoachView.
    const autoRecap = this.createCoachButton(
      autoRecapLabel(model.sessionView.autoRecapOverride),
      'chatgoose-button-secondary chatgoose-coach-autorecap',
      () => this.callbacks.onCoachAutoRecapCycle?.(),
    );
    // «Новый диалог» — a two-step inline confirm (spec §3), mirroring the
    // Replace-draft button below: NO window.confirm (it blocks the extension).
    // A NON-EMPTY dialog arms a "Confirm new dialog" state on the first click;
    // the second click resets. An EMPTY dialog resets immediately. Blur /
    // outside-click / «Keep» abandons the confirm so a stale armed state never
    // lingers. Emptiness is read live from the current model at click time.
    const newDialog = document.createElement('button');
    newDialog.type = 'button';
    newDialog.className = 'chatgoose-button chatgoose-button-secondary';
    newDialog.textContent = 'New dialog';
    const newDialogKeep = document.createElement('button');
    newDialogKeep.type = 'button';
    newDialogKeep.className = 'chatgoose-button chatgoose-button-secondary chatgoose-hidden';
    newDialogKeep.textContent = 'Keep';
    let newDialogArmed = false;
    const disarmNewDialog = (): void => {
      newDialogArmed = false;
      newDialog.classList.remove('chatgoose-coach-newdialog-armed');
      newDialogKeep.classList.add('chatgoose-hidden');
      newDialog.textContent = 'New dialog';
    };
    newDialogKeep.addEventListener('click', () => disarmNewDialog());
    newDialog.addEventListener('blur', () => {
      if (newDialogArmed) {
        disarmNewDialog();
      }
    });
    newDialog.addEventListener('click', () => {
      // Unsent composer text is also content worth confirming before it is wiped
      // (resetSession clears composerText too) — not just committed feed items.
      const hasContent =
        this.model.kind === 'coach' &&
        (this.model.sessionView.feedItems.length > 0 ||
          this.model.sessionView.composerText.trim().length > 0);
      if (hasContent && !newDialogArmed) {
        newDialogArmed = true;
        newDialog.textContent = 'Confirm new dialog';
        newDialog.classList.add('chatgoose-coach-newdialog-armed');
        newDialogKeep.classList.remove('chatgoose-hidden');
        return;
      }
      disarmNewDialog();
      this.callbacks.onCoachNewDialog?.();
    });
    topbarActions.append(autoRecap, shortRecap, fullRecap, newDialog, newDialogKeep);
    topbar.append(recap, topbarActions);

    // Feed — a separately-scrolling log. Committed items live in itemsEl so
    // their order is managed independently of the pending / empty-state nodes.
    const feed = document.createElement('div');
    feed.className = 'chatgoose-coach-feed';
    feed.setAttribute('role', 'log');
    feed.setAttribute('aria-live', 'polite');
    feed.setAttribute('aria-relevant', 'additions');
    const items = document.createElement('div');
    items.className = 'chatgoose-coach-items';
    feed.append(items);

    // Sticky composer.
    const composer = document.createElement('div');
    composer.className = 'chatgoose-coach-composer';
    const textarea = document.createElement('textarea');
    textarea.className = 'chatgoose-coach-input';
    textarea.rows = 2;
    textarea.placeholder = 'Ask about this fan…';
    // Cap the question at the kernel bound (spec §7) at the DOM level so an
    // over-long question is prevented up front, not failed late + generic.
    textarea.maxLength = COACH_QUESTION_MAX_CHARS;
    textarea.value = model.sessionView.composerText;
    textarea.addEventListener('input', () => {
      this.autosizeCoachComposer(textarea);
      this.callbacks.onCoachComposerInput?.(textarea.value);
    });
    textarea.addEventListener('keydown', (event) => {
      // Enter submits; Shift+Enter is a newline; an IME composition never submits.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submitCoachQuestion(textarea);
      }
    });

    const composerActions = document.createElement('div');
    composerActions.className = 'chatgoose-coach-composer-actions';
    const send = this.createCoachButton('Send', '', () => this.submitCoachQuestion(textarea));
    send.classList.add('chatgoose-coach-send');
    const cancel = this.createCoachButton('Cancel', 'chatgoose-button-danger', () => {
      if (this.model.kind === 'coach' && this.model.operationId) {
        this.callbacks.onCancel(this.model.operationId);
      }
    });
    cancel.classList.add('chatgoose-coach-cancel', 'chatgoose-hidden');
    composerActions.append(send, cancel);
    composer.append(textarea, composerActions);

    root.append(topbar, feed, composer);

    const view: CoachViewState = {
      kind: 'coach',
      operationId: model.operationId,
      root,
      feedEl: feed,
      itemsEl: items,
      recapStatusEl: recap,
      recapStatusText: recapText,
      autoRecapButton: autoRecap,
      composerTextarea: textarea,
      sendButton: send,
      cancelButton: cancel,
      itemNodes: new Map(),
      renderedItems: new Map(),
      pendingNode: null,
      pendingAnswerTextNode: null,
      pendingQuestion: null,
      emptyStateNode: null,
    };
    this.updateCoachView(view, model);
    return view;
  }

  private updateCoachView(
    view: CoachViewState,
    model: Extract<OverlayViewModel, { kind: 'coach' }>,
  ): void {
    const sv = model.sessionView;
    view.operationId = model.operationId;
    const streaming = model.operationId !== null;

    // Recap status line (guarded — an unchanged line is not rewritten).
    if (view.recapStatusText.data !== sv.recapStatusLine) {
      view.recapStatusText.data = sv.recapStatusLine;
    }
    view.recapStatusEl.classList.toggle('chatgoose-hidden', sv.recapStatusLine === '');

    // Composer lock + Send/Cancel affordance (all guarded).
    const disabled = !sv.composerEnabled;

    // Auto-recap override label (guarded); the control is disabled while the
    // coach is busy (a streaming turn or a running recap step) — the mode must
    // not change mid-turn.
    const autoRecapText = autoRecapLabel(sv.autoRecapOverride);
    if (view.autoRecapButton.textContent !== autoRecapText) {
      view.autoRecapButton.textContent = autoRecapText;
    }
    if (view.autoRecapButton.disabled !== disabled) {
      view.autoRecapButton.disabled = disabled;
    }

    if (view.composerTextarea.disabled !== disabled) {
      view.composerTextarea.disabled = disabled;
    }
    if (view.sendButton.disabled !== disabled) {
      view.sendButton.disabled = disabled;
    }
    view.sendButton.classList.toggle('chatgoose-hidden', streaming);
    view.cancelButton.classList.toggle('chatgoose-hidden', !streaming);
    // Restore the composer text ONLY when unfocused — never clobber a live caret.
    if (
      document.activeElement !== view.composerTextarea &&
      view.composerTextarea.value !== sv.composerText
    ) {
      view.composerTextarea.value = sv.composerText;
    }

    // Snapshot the scroll pin BEFORE any feed mutation so streaming (or a new
    // committed item) only auto-scrolls when the chatter was already at bottom.
    const wasNearBottom = this.isScrolledToBottom(view.feedEl);

    this.reconcileCoachFeed(view, sv);
    this.reconcileCoachPending(view, model);
    this.reconcileCoachEmptyState(view, model);

    if (wasNearBottom) {
      this.scrollCoachFeedToBottom(view);
    }
  }

  /** Pin the feed to its newest turn. Called unconditionally on a (re)open
   * rebuild (after attach) and on an incremental update only when the chatter
   * was already at the bottom. */
  private scrollCoachFeedToBottom(view: CoachViewState): void {
    view.feedEl.scrollTop = Math.max(0, view.feedEl.scrollHeight - view.feedEl.clientHeight);
  }

  private reconcileCoachFeed(view: CoachViewState, sv: CoachOverlaySessionView): void {
    const desiredKeys: string[] = [];
    const nodesByKey = new Map<string, HTMLElement>();

    sv.feedItems.forEach((item, index) => {
      const key = this.coachFeedKey(item, index);
      desiredKeys.push(key);
      const existing = view.itemNodes.get(key);
      if (!existing) {
        const node = this.createCoachFeedNode(item, key);
        view.itemNodes.set(key, node);
        nodesByKey.set(key, node);
      } else if (item.kind === 'recap-step') {
        // A recap step transitions running → done/failed on the SAME node.
        this.updateCoachRecapStepNode(existing, item);
        nodesByKey.set(key, existing);
      } else if (!sameCoachFeedItem(view.renderedItems.get(key), item)) {
        // A reused index-key whose content changed (e.g. a feed reset that
        // skipped an empty render) — rebuild rather than reuse a stale node.
        const node = this.createCoachFeedNode(item, key);
        existing.replaceWith(node);
        view.itemNodes.set(key, node);
        nodesByKey.set(key, node);
      } else {
        nodesByKey.set(key, existing);
      }
      view.renderedItems.set(key, item);
    });

    // Drop nodes whose keys are gone (a «New dialog» reset clears everything).
    for (const [key, node] of view.itemNodes) {
      if (!nodesByKey.has(key)) {
        node.remove();
        view.itemNodes.delete(key);
        view.renderedItems.delete(key);
      }
    }

    // Order itemsEl to match desiredKeys — append-only in practice, so an
    // unchanged feed performs no DOM moves at all.
    desiredKeys.forEach((key, index) => {
      const node = nodesByKey.get(key)!;
      if (view.itemsEl.children[index] !== node) {
        view.itemsEl.insertBefore(node, view.itemsEl.children[index] ?? null);
      }
    });
  }

  private reconcileCoachPending(
    view: CoachViewState,
    model: Extract<OverlayViewModel, { kind: 'coach' }>,
  ): void {
    const sv = model.sessionView;
    const streaming = model.operationId !== null && sv.pendingQuestion !== undefined;
    if (!streaming) {
      if (view.pendingNode) {
        view.pendingNode.remove();
        view.pendingNode = null;
        view.pendingAnswerTextNode = null;
        view.pendingQuestion = null;
      }
      return;
    }

    const question = sv.pendingQuestion ?? '';
    if (!view.pendingNode || view.pendingQuestion !== question) {
      // New turn — (re)build the pending node once; from here only its answer
      // text node is mutated as chunks arrive.
      const built = this.createCoachPendingNode(question);
      if (view.pendingNode) {
        view.pendingNode.replaceWith(built.wrapper);
      } else {
        view.feedEl.append(built.wrapper);
      }
      view.pendingNode = built.wrapper;
      view.pendingAnswerTextNode = built.answerText;
      view.pendingQuestion = question;
    }
    const answer = sv.pendingAnswerText && sv.pendingAnswerText.length > 0 ? sv.pendingAnswerText : '…';
    if (view.pendingAnswerTextNode && view.pendingAnswerTextNode.data !== answer) {
      view.pendingAnswerTextNode.data = answer;
    }
  }

  private reconcileCoachEmptyState(
    view: CoachViewState,
    model: Extract<OverlayViewModel, { kind: 'coach' }>,
  ): void {
    const showEmpty = model.sessionView.feedItems.length === 0 && model.operationId === null;
    if (showEmpty) {
      if (!view.emptyStateNode) {
        view.emptyStateNode = this.createCoachEmptyState(view);
        view.feedEl.append(view.emptyStateNode);
      }
    } else if (view.emptyStateNode) {
      view.emptyStateNode.remove();
      view.emptyStateNode = null;
    }
  }

  private submitCoachQuestion(textarea: HTMLTextAreaElement): void {
    if (this.model.kind !== 'coach' || !this.model.sessionView.composerEnabled) {
      return;
    }
    const question = textarea.value.trim();
    if (!question) {
      return;
    }
    // Defensive guard (maxLength already caps typing/paste): never submit — and
    // never clear — an over-long question; keep it so the chatter can trim it.
    if (question.length > COACH_QUESTION_MAX_CHARS) {
      textarea.classList.add('chatgoose-coach-input-overlimit');
      return;
    }
    textarea.classList.remove('chatgoose-coach-input-overlimit');
    textarea.value = '';
    this.autosizeCoachComposer(textarea);
    // Keep the orchestrator's persisted composerText in sync with the clear.
    this.callbacks.onCoachComposerInput?.('');
    this.callbacks.onCoachSubmit?.(question);
  }

  private autosizeCoachComposer(textarea: HTMLTextAreaElement): void {
    textarea.style.height = 'auto';
    if (textarea.scrollHeight > 0) {
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    }
  }

  private coachFeedKey(item: CoachOverlayFeedItem, index: number): string {
    // Exchanges are keyed by their own op id (stable identity); failed / recap
    // items by feed index (append-only, so an index is stable for its lifetime).
    return item.kind === 'exchange' ? `x:${item.operationId}` : `${item.kind[0]}:${index}`;
  }

  private createCoachFeedNode(item: CoachOverlayFeedItem, key: string): HTMLElement {
    const node =
      item.kind === 'exchange'
        ? this.createCoachExchangeNode(item)
        : item.kind === 'failed-attempt'
          ? this.createCoachFailedNode(item)
          : this.createCoachRecapStepNode(item);
    node.dataset.coachKey = key;
    return node;
  }

  private createCoachExchangeNode(
    item: Extract<CoachOverlayFeedItem, { kind: 'exchange' }>,
  ): HTMLDivElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'chatgoose-coach-exchange';
    wrapper.append(this.createCoachQuestionBubble(item.question));

    if (item.answerProse) {
      const answer = document.createElement('div');
      answer.className = 'chatgoose-coach-answer';
      // textContent ONLY — the T5 parser neutralises column-0 fences but not
      // every CommonMark form; textContent moots the whole injection class.
      answer.textContent = item.answerProse;
      wrapper.append(answer);
    }

    if (item.drafts.length > 0) {
      const drafts = document.createElement('div');
      drafts.className = 'chatgoose-parts chatgoose-coach-drafts';
      for (const draft of item.drafts) {
        drafts.append(this.createCoachDraftCard(item.operationId, item.generationRef, draft));
      }
      wrapper.append(drafts);
    }
    return wrapper;
  }

  private createCoachFailedNode(
    item: Extract<CoachOverlayFeedItem, { kind: 'failed-attempt' }>,
  ): HTMLDivElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'chatgoose-coach-exchange chatgoose-coach-failed';
    wrapper.append(this.createCoachQuestionBubble(item.question));

    const error = document.createElement('div');
    error.className = 'chatgoose-coach-error';
    error.textContent = `Couldn't finish this turn (${item.errorCode}).`;
    wrapper.append(error);

    if (item.retryable) {
      const actions = document.createElement('div');
      actions.className = 'chatgoose-coach-failed-actions';
      actions.append(
        this.createCoachButton('Retry', 'chatgoose-button-secondary', () =>
          this.callbacks.onCoachRetry?.(item.question),
        ),
      );
      wrapper.append(actions);
    }
    return wrapper;
  }

  private createCoachRecapStepNode(
    item: Extract<CoachOverlayFeedItem, { kind: 'recap-step' }>,
  ): HTMLDivElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'chatgoose-coach-recap-step';
    this.updateCoachRecapStepNode(wrapper, item);
    return wrapper;
  }

  private updateCoachRecapStepNode(
    node: HTMLElement,
    item: Extract<CoachOverlayFeedItem, { kind: 'recap-step' }>,
  ): void {
    node.dataset.status = item.status;
    const text = this.coachRecapStepLabel(item);
    if (node.textContent !== text) {
      node.textContent = text;
    }
  }

  private coachRecapStepLabel(
    item: Extract<CoachOverlayFeedItem, { kind: 'recap-step' }>,
  ): string {
    const mode = item.mode === 'full' ? 'Full recap' : 'Short recap';
    const origin = item.origin === 'auto' ? 'auto' : 'manual';
    const status =
      item.status === 'running' ? 'refreshing…' : item.status === 'done' ? 'updated' : 'failed';
    const base = `${mode} (${origin}) · ${status}`;
    // A failed-but-proceeded auto-recap carries the fallback copy (spec §5).
    return item.note ? `${base} · ${item.note}` : base;
  }

  private createCoachQuestionBubble(question: string): HTMLDivElement {
    const bubble = document.createElement('div');
    bubble.className = 'chatgoose-coach-question';
    bubble.textContent = question;
    return bubble;
  }

  private createCoachPendingNode(question: string): { wrapper: HTMLDivElement; answerText: Text } {
    const wrapper = document.createElement('div');
    wrapper.className = 'chatgoose-coach-exchange chatgoose-coach-pending';
    wrapper.setAttribute('aria-busy', 'true');
    wrapper.append(this.createCoachQuestionBubble(question));

    const answer = document.createElement('div');
    answer.className = 'chatgoose-coach-answer chatgoose-coach-answer-streaming';
    const answerText = document.createTextNode('…');
    answer.append(answerText);
    wrapper.append(answer);
    return { wrapper, answerText };
  }

  private createCoachEmptyState(view: CoachViewState): HTMLDivElement {
    const empty = document.createElement('div');
    empty.className = 'chatgoose-coach-empty';

    const heading = document.createElement('div');
    heading.className = 'chatgoose-coach-empty-heading';
    heading.textContent = 'Ask the coach about this fan';
    empty.append(heading);

    const hintList = document.createElement('div');
    hintList.className = 'chatgoose-coach-empty-hints';
    for (const hint of COACH_STARTER_HINTS) {
      const chip = this.createCoachButton(hint, 'chatgoose-coach-hint', () => {
        view.composerTextarea.value = hint;
        this.autosizeCoachComposer(view.composerTextarea);
        this.callbacks.onCoachComposerInput?.(hint);
        view.composerTextarea.focus();
      });
      hintList.append(chip);
    }
    empty.append(hintList);
    return empty;
  }

  private createCoachDraftCard(
    exchangeOperationId: string,
    generationRef: string | undefined,
    draft: CoachOverlayDraft,
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'chatgoose-card chatgoose-coach-draft';

    const title = document.createElement('div');
    title.className = 'chatgoose-card-title';
    title.textContent = draft.index === 0 ? 'Draft' : `Draft ${draft.index + 1}`;

    const text = document.createElement('div');
    text.className = 'chatgoose-card-text';
    text.textContent = draft.text; // textContent — draft bodies are never HTML.

    const actions = document.createElement('div');
    actions.className = 'chatgoose-card-actions';

    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'chatgoose-button';

    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'chatgoose-button chatgoose-button-secondary chatgoose-hidden';
    keep.textContent = 'Keep draft';

    // Two-step inline confirm — NO browser dialog (window.confirm blocks the
    // extension). Insert into an empty composer is one click; replacing an
    // unsent draft arms a "Confirm replace" state first.
    let armed = false;
    const disarm = (): void => {
      armed = false;
      insert.classList.remove('chatgoose-coach-draft-armed');
      keep.classList.add('chatgoose-hidden');
      insert.textContent = getActiveConversationDraftText().trim() ? 'Replace draft…' : 'Insert';
    };
    keep.addEventListener('click', () => disarm());
    // Moving focus away from an armed Replace abandons the confirm (outside
    // click / blur), so a stale "Confirm replace" never lingers.
    insert.addEventListener('blur', () => {
      if (armed) {
        disarm();
      }
    });
    insert.addEventListener('click', () => {
      const hasDraft = getActiveConversationDraftText().trim() !== '';
      if (hasDraft && !armed) {
        armed = true;
        insert.textContent = 'Confirm replace';
        insert.classList.add('chatgoose-coach-draft-armed');
        keep.classList.remove('chatgoose-hidden');
        return;
      }
      disarm();
      void this.acceptCoachDraft(exchangeOperationId, generationRef, draft, 'inserted');
    });
    insert.textContent = getActiveConversationDraftText().trim() ? 'Replace draft…' : 'Insert';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'chatgoose-button chatgoose-button-secondary';
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      void this.acceptCoachDraft(exchangeOperationId, generationRef, draft, 'copied');
    });

    actions.append(insert, keep, copy);
    card.append(title, text, actions);
    return card;
  }

  /** Insert/Copy a draft, attributing acceptance to the CARD's exchange
   * operationId (spec §3) — NOT the session's live/top-level op. */
  private async acceptCoachDraft(
    exchangeOperationId: string,
    generationRef: string | undefined,
    draft: CoachOverlayDraft,
    action: 'inserted' | 'copied',
  ): Promise<void> {
    try {
      if (action === 'inserted') {
        await insertIntoFanslyTextarea(draft.text);
      } else {
        await copyToClipboard(draft.text);
      }
      this.inlineError = null;
      this.callbacks.onAcceptance?.(exchangeOperationId, action, draft.index, generationRef);
      if (action === 'inserted') {
        // Spec §3: after insert the overlay collapses and the Fansly composer
        // is focused. Closing does NOT touch the store — the session is retained
        // and reopens intact. Copy leaves the overlay open.
        this.queueComposerFocus();
        this.callbacks.onClose();
      }
    } catch (error) {
      // A failed insert must NOT close — surface the error inline and stay open.
      this.inlineError = toUserError(error);
      this.render(this.model, true);
    }
  }

  private createCoachButton(
    label: string,
    extraClass: string,
    onClick: () => void,
  ): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = extraClass ? `chatgoose-button ${extraClass}` : 'chatgoose-button';
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
  }

  // ─── Part Card ──────────────────────────────────────────────────────

  private createPartCard(title: string, part: OverlayInsertPart, options: PartCardOptions = {}): HTMLElement {
    const card = document.createElement('div');
    card.className = 'chatgoose-card';
    if (options.emphasis === 'recommended') {
      card.classList.add('chatgoose-card-recommended');
    } else if (options.emphasis === 'followup') {
      card.classList.add('chatgoose-card-followup');
    }

    const label = document.createElement('div');
    label.className = 'chatgoose-card-title';
    label.textContent = title;

    const hint = options.hint ? document.createElement('div') : null;
    if (hint) {
      hint.className = 'chatgoose-card-hint';
      hint.textContent = options.hint ?? null;
    }

    const statusEl = options.status ? document.createElement('div') : null;
    if (statusEl) {
      statusEl.className = 'chatgoose-card-status';
      statusEl.textContent = options.status ?? null;
    }

    const text = document.createElement('div');
    text.className = 'chatgoose-card-text chatgoose-card-text-insertable';
    text.textContent = part.text;
    text.title = 'Click to insert';
    text.addEventListener('click', () => {
      // Selecting draft text (to copy a fragment) must not fire an insert.
      if (window.getSelection()?.toString()) {
        return;
      }
      void this.insertPart(part, { autoPassThrough: options.autoPassThrough });
    });

    const actions = document.createElement('div');
    actions.className = 'chatgoose-card-actions';

    const insert = document.createElement('button');
    insert.type = 'button';
    insert.className = 'chatgoose-button';
    insert.textContent = getInsertButtonLabel(part);
    insert.disabled = isInsertFeedbackActive(part);
    insert.addEventListener('click', () => {
      void this.insertPart(part, { autoPassThrough: options.autoPassThrough });
    });

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'chatgoose-button chatgoose-button-secondary';
    copy.textContent = 'Copy';
    copy.addEventListener('click', async () => {
      try {
        await copyToClipboard(part.text);
        const operationId = 'operationId' in this.model ? this.model.operationId : null;
        if (operationId) {
          this.callbacks.onAcceptance?.(operationId, 'copied', part.sequenceIndex);
        }
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
    section.className = 'chatgoose-grid';

    const spend = model.llmSpend;
    if (spend) {
      section.append(this.renderSpendStrip(spend));
    }

    if (model.profiling) {
      section.append(this.renderProfilingCard(model.profiling, 'summary'));
    }

    if (model.splitModeRequested && !model.error) {
      const helper = document.createElement('div');
      helper.className = 'chatgoose-inline-note';
      helper.textContent =
        model.parts.length > 1
          ? 'Split mode was on. Start with message 1, send it manually in Fansly, then use the follow-up if it still feels right.'
          : 'Split mode expected at least 2 messages, but this result contains one. Try Regenerate to retry the split.';
      section.append(helper);
    }

    if (model.error) {
      section.append(createUserErrorBlock(model.error));
    } else if (model.parts.length > 0) {
      const parts = document.createElement('div');
      parts.className = 'chatgoose-parts';
      model.parts.forEach((part) => {
        const isSplit = model.splitModeRequested && model.parts.length > 1;
        parts.append(
          this.createPartCard(getReplyPartTitle(part, model.splitModeRequested), part, {
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
      raw.className = 'chatgoose-stream';
      raw.textContent = model.rawText;
      section.append(raw);
    }

    if (model.debugPrompt) {
      section.append(this.renderDebugPrompt(model.debugPrompt, model.debugEcho));
    }

    section.append(this.renderCompletedActions(model.feature, model.rerunActionLabel));
    return section;
  }

  // ─── Help Me ────────────────────────────────────────────────────────

  private renderHelpMe(model: Extract<OverlayViewModel, { kind: 'helpMe' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatgoose-grid';

    const spend = model.llmSpend;
    if (spend) {
      section.append(this.renderSpendStrip(spend));
    }

    if (model.profiling) {
      section.append(this.renderProfilingCard(model.profiling, 'summary'));
    }

    const coaching = document.createElement('div');
    coaching.className = 'chatgoose-card';
    const coachingTitle = document.createElement('div');
    coachingTitle.className = 'chatgoose-card-title';
    coachingTitle.textContent = 'Coaching';
    const coachingText = document.createElement('div');
    coachingText.className = 'chatgoose-card-text';
    coachingText.textContent = model.coaching ?? model.rawText;
    coaching.append(coachingTitle, coachingText);
    section.append(coaching);

    const suggestions = document.createElement('div');
    suggestions.className = 'chatgoose-parts';
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
      fallback.className = 'chatgoose-stream';
      fallback.textContent = model.rawText;
      section.append(fallback);
    }

    if (model.debugPrompt) {
      section.append(this.renderDebugPrompt(model.debugPrompt, model.debugEcho));
    }

    section.append(this.renderCompletedActions(model.feature, model.rerunActionLabel));
    return section;
  }

  // ─── Recap start dialog (spec §5) ──────────────────────────────────

  /** The standalone Recap picker (spec §5): Полный (focused; Enter keeps the old
   * ⌘⇧S+Enter muscle memory) / Короткий / «Открыть последний» (view the stored
   * recap, no generation). Nothing generates until a mode is picked; Esc cancels
   * via the overlay's global dismiss. */
  private renderRecapPicker(
    model: Extract<OverlayViewModel, { kind: 'recap-picker' }>,
  ): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatgoose-grid chatgoose-recap-picker';

    const prompt = document.createElement('div');
    prompt.className = 'chatgoose-recap-picker-prompt';
    prompt.textContent = 'Какой рекап нужен?';
    section.append(prompt);

    const actions = document.createElement('div');
    actions.className = 'chatgoose-recap-picker-actions';

    // Полный is the default (focused) — ⌘⇧S+Enter still fires a full recap.
    const full = this.createCoachButton('Полный', '', () => this.callbacks.onRecapPick?.('full'));
    full.classList.add('chatgoose-recap-picker-full');
    const short = this.createCoachButton('Короткий', 'chatgoose-button-secondary', () =>
      this.callbacks.onRecapPick?.('short'),
    );
    const hasStored = Boolean(model.recapStatus && (model.recapStatus.full || model.recapStatus.short));
    const openLast = this.createCoachButton(
      'Открыть последний',
      'chatgoose-button-secondary',
      () => this.callbacks.onRecapOpenLast?.(),
    );
    openLast.classList.add('chatgoose-recap-picker-last');
    // A loaded-and-empty status greys the button out (nothing to open); an
    // unloaded status leaves it live (the background is the source of truth).
    if (model.recapStatus && !hasStored) {
      openLast.disabled = true;
    }
    actions.append(full, short, openLast);
    section.append(actions);

    // Enter (unmodified) picks Полный — the ⌘⇧S+Enter muscle memory (spec §5).
    section.addEventListener('keydown', (event) => {
      if (
        event.key === 'Enter' &&
        !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey &&
        !event.isComposing
      ) {
        event.preventDefault();
        this.callbacks.onRecapPick?.('full');
      }
    });

    queueMicrotask(() => full.focus());
    return section;
  }

  // ─── Read Only (Summary, Review) ───────────────────────────────────

  private renderReadOnly(model: Extract<OverlayViewModel, { kind: 'readOnly' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatgoose-grid';

    const spend = model.llmSpend;
    if (spend) {
      section.append(this.renderSpendStrip(spend));
    }

    if (model.profiling) {
      section.append(this.renderProfilingCard(model.profiling, 'summary'));
    }

    if (model.reviewMeta?.rating) {
      const ratingSection = document.createElement('div');
      ratingSection.className = 'chatgoose-rating-section';

      const badge = document.createElement('div');
      badge.className = `chatgoose-rating-badge ${ratingClass(model.reviewMeta.rating)}`;
      badge.textContent = String(model.reviewMeta.rating);

      const ratingLabel = document.createElement('div');
      ratingLabel.className = 'chatgoose-rating-label';
      ratingLabel.textContent = `${model.reviewMeta.rating}/10`;

      ratingSection.append(badge, ratingLabel);
      section.append(ratingSection);
    }

    if (model.summaryMeta) {
      const meta = document.createElement('div');
      meta.className = 'chatgoose-overlay-status';
      meta.textContent = model.summaryMeta.cached
        ? `Cached ${relativeTime(model.summaryMeta.generatedAt)}`
        : `Generated ${relativeTime(model.summaryMeta.generatedAt)}`;
      section.append(meta);

      // Recap coverage header (spec §5): «вся переписка (N сообщений)» when the
      // whole history was kept, else «последние N — история длиннее». Present
      // only on freshly generated recaps (a cache hit carries no coverage).
      const { transcriptCoverage, keptCount } = model.summaryMeta;
      if (transcriptCoverage && typeof keptCount === 'number') {
        const coverage = document.createElement('div');
        coverage.className = 'chatgoose-recap-coverage';
        coverage.textContent =
          transcriptCoverage === 'full-history'
            ? `вся переписка (${keptCount} сообщений)`
            : `последние ${keptCount} — история длиннее`;
        section.append(coverage);
      }
    }

    if (model.reviewMeta && !model.reviewMeta.parseFallback) {
      if (model.reviewMeta.evaluation) {
        const evalSection = document.createElement('div');
        evalSection.className = 'chatgoose-card';
        const evalTitle = document.createElement('div');
        evalTitle.className = 'chatgoose-card-title';
        evalTitle.textContent = 'Evaluation';
        const evalText = document.createElement('div');
        evalText.className = 'chatgoose-card-text';
        evalText.textContent = model.reviewMeta.evaluation;
        evalSection.append(evalTitle, evalText);
        section.append(evalSection);
      }

      if (model.reviewMeta.recommendations) {
        const recSection = document.createElement('div');
        recSection.className = 'chatgoose-card';
        const recTitle = document.createElement('div');
        recTitle.className = 'chatgoose-card-title';
        recTitle.textContent = 'Recommendations';
        const recText = document.createElement('div');
        recText.className = 'chatgoose-card-text';
        recText.textContent = model.reviewMeta.recommendations;
        recSection.append(recTitle, recText);
        section.append(recSection);
      }
    } else if (model.feature === 'fan-summary' && model.rawText.trim()) {
      const body = document.createElement('div');
      body.className = 'chatgoose-stream chatgoose-md';
      body.append(renderSummaryMarkdown(model.rawText));
      section.append(body);
    } else {
      const body = document.createElement('div');
      body.className = 'chatgoose-stream';
      body.textContent = model.rawText;
      section.append(body);
    }

    if (model.debugPrompt) {
      section.append(this.renderDebugPrompt(model.debugPrompt, model.debugEcho));
    }

    section.append(
      this.renderCompletedActions(
        model.feature,
        model.rerunActionLabel,
        this.getReadOnlyCopyText(model),
        model.feature === 'fan-summary'
          ? model.summaryMeta?.syncStatus
          : undefined,
      ),
    );
    return section;
  }

  private getReadOnlyCopyText(model: Extract<OverlayViewModel, { kind: 'readOnly' }>): string | null {
    if (model.feature === 'chat-review') {
      const sections: string[] = [];

      if (model.reviewMeta?.rating !== null && model.reviewMeta?.rating !== undefined) {
        sections.push(`Rating: ${model.reviewMeta.rating}/10`);
      }

      if (model.reviewMeta?.evaluation) {
        sections.push(`Evaluation:\n${model.reviewMeta.evaluation}`);
      }

      if (model.reviewMeta?.recommendations) {
        sections.push(`Recommendations:\n${model.reviewMeta.recommendations}`);
      }

      const formattedReview = sections.join('\n\n').trim();
      if (formattedReview) {
        return formattedReview;
      }
    }

    return model.rawText.trim() || null;
  }

  private renderCompletedActions(
    feature: FeatureType,
    rerunActionLabel: OverlayRerunActionLabel | undefined,
    copyText?: string | null,
    syncStatus?: FanSummarySyncStatus,
  ): HTMLElement {
    const actions = document.createElement('div');
    actions.className = 'chatgoose-overlay-actions';

    if (!rerunActionLabel && !copyText && !syncStatus) {
      return actions;
    }

    if (rerunActionLabel) {
      const rerun = document.createElement('button');
      rerun.type = 'button';
      rerun.className = 'chatgoose-button';
      rerun.textContent = rerunActionLabel;
      rerun.addEventListener('click', () => this.callbacks.onRerun(feature));
      actions.append(rerun);
    }

    if (copyText) {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'chatgoose-button chatgoose-button-secondary';
      copy.textContent = 'Copy';
      copy.addEventListener('click', async () => {
        try {
          await copyToClipboard(copyText);
          this.inlineError = null;
          this.render(this.model);
        } catch (error) {
          this.inlineError = toUserError(error);
          this.render(this.model, true);
        }
      });
      actions.append(copy);
    }

    const syncStatusText = formatFanSummarySyncStatus(syncStatus);
    if (syncStatusText) {
      const status = document.createElement('span');
      status.className = 'chatgoose-overlay-action-status';
      status.textContent = syncStatusText;
      actions.append(status);
    }

    return actions;
  }

  // ─── Error ──────────────────────────────────────────────────────────

  private renderError(model: Extract<OverlayViewModel, { kind: 'error' }>): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatgoose-grid';

    const spend = model.llmSpend;
    if (spend) {
      section.append(this.renderSpendStrip(spend));
    }

    section.append(createUserErrorBlock(model.error));

    if (model.profiling) {
      section.append(this.renderProfilingCard(model.profiling, 'summary'));
    }

    if (model.debugPrompt) {
      section.append(this.renderDebugPrompt(model.debugPrompt, model.debugEcho));
    }

    return section;
  }

  private renderSpendStrip(
    spend?: LlmSpendSummary,
    options?: { placeholder?: boolean },
  ): HTMLElement {
    const strip = document.createElement('div');
    strip.className = 'chatgoose-spend-strip';

    const primary = document.createElement('div');
    primary.className = 'chatgoose-spend-strip-primary';

    const secondary = document.createElement('div');
    secondary.className = 'chatgoose-spend-strip-secondary';

    if (!spend && options?.placeholder) {
      strip.classList.add('chatgoose-spend-strip-pending');
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
          span.className = `chatgoose-spend-cache-${cacheEffect.kind}`;
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
    card.className = 'chatgoose-profiling';
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
    header.className = 'chatgoose-debug-summary';
    header.textContent = `Pipeline Profiling • ${formatProfilingElapsed(snapshot.elapsedMs)}`;
    return header;
  }

  private renderProfilingLog(
    snapshot: OperationProfilingSnapshot,
  ): HTMLElement {
    const container = document.createElement('div');
    container.className = 'chatgoose-profiling-log';

    for (const entry of snapshot.logEntries) {
      container.append(this.createProfilingLogRow(entry));
    }

    return container;
  }

  private renderProfilingSummary(
    snapshot: OperationProfilingSnapshot,
  ): HTMLElement {
    const container = document.createElement('div');
    container.className = 'chatgoose-profiling-summary';

    const total = document.createElement('div');
    total.className = 'chatgoose-profiling-stage';

    const totalLabel = document.createElement('div');
    totalLabel.className = 'chatgoose-profiling-stage-label';
    totalLabel.textContent = 'Total';

    const totalDuration = document.createElement('div');
    totalDuration.className = 'chatgoose-profiling-stage-duration';
    totalDuration.textContent = formatProfilingElapsed(snapshot.elapsedMs);

    total.append(totalLabel, totalDuration);
    container.append(total);

    const usage = snapshot.llmUsage;
    const cost = snapshot.llmCost;
    if (usage) {
      const usageRow = document.createElement('div');
      usageRow.className = 'chatgoose-profiling-stage';

      const usageLabel = document.createElement('div');
      usageLabel.className = 'chatgoose-profiling-stage-label';
      usageLabel.textContent = formatModelUsageLabel(cost);

      const usageDuration = document.createElement('div');
      usageDuration.className = 'chatgoose-profiling-stage-duration';
      usageDuration.textContent = 'tokens';

      const usageDetail = document.createElement('div');
      usageDetail.className = 'chatgoose-profiling-stage-detail';
      usageDetail.textContent = formatLlmUsageSummary(
        usage,
      );

      usageRow.append(usageLabel, usageDuration, usageDetail);
      container.append(usageRow);
    }

    if (cost) {
      const costRow = document.createElement('div');
      costRow.className = 'chatgoose-profiling-stage';

      const costLabel = document.createElement('div');
      costLabel.className = 'chatgoose-profiling-stage-label';
      costLabel.textContent = formatModelCostLabel(cost);

      const costDuration = document.createElement('div');
      costDuration.className = 'chatgoose-profiling-stage-duration';
      costDuration.textContent = formatUsd(
        cost.totalUsd,
        cost.approximate,
      );

      const costDetail = document.createElement('div');
      costDetail.className = 'chatgoose-profiling-stage-detail';
      costDetail.textContent = formatLlmCostSummary(cost);

      costRow.append(costLabel, costDuration, costDetail);
      container.append(costRow);
    }

    for (const reasoningEntry of this.extractReasoningEntries(snapshot)) {
      const row = document.createElement('div');
      row.className = 'chatgoose-profiling-stage';

      const label = document.createElement('div');
      label.className = 'chatgoose-profiling-stage-label';
      label.textContent = reasoningEntry.label;

      const value = document.createElement('div');
      value.className = 'chatgoose-profiling-stage-duration';
      value.textContent = reasoningEntry.value;

      row.append(label, value);

      if (reasoningEntry.detail) {
        const detail = document.createElement('div');
        detail.className = 'chatgoose-profiling-stage-detail';
        detail.textContent = reasoningEntry.detail;
        row.append(detail);
      }

      container.append(row);
    }

    if (snapshot.reasoningBlock?.trim()) {
      container.append(this.renderProfilingReasoningBlock(snapshot.reasoningBlock.trim()));
    }

    for (const stage of snapshot.stages) {
      const row = document.createElement('div');
      row.className = 'chatgoose-profiling-stage';

      const label = document.createElement('div');
      label.className = 'chatgoose-profiling-stage-label';
      label.textContent = stage.label;

      const duration = document.createElement('div');
      duration.className = 'chatgoose-profiling-stage-duration';
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
        detail.className = 'chatgoose-profiling-stage-detail';
        detail.textContent = stage.detail;
        row.append(detail);
      }

      container.append(row);
    }

    return container;
  }

  private extractReasoningEntries(
    snapshot: OperationProfilingSnapshot,
  ): Array<{ label: string; value: string; detail?: string }> {
    const requested = [...snapshot.logEntries]
      .reverse()
      .find((entry) => entry.message.startsWith('Reasoning requested: '));
    const observed = [...snapshot.logEntries]
      .reverse()
      .find((entry) => entry.message.startsWith('Reasoning observed: '));
    const entries: Array<{ label: string; value: string; detail?: string }> = [];

    if (requested) {
      const match = /^Reasoning requested: ([^(]+)(?: \((.+)\))?$/.exec(requested.message);
      entries.push({
        label: 'Reasoning requested',
        value: match?.[1]?.trim() || 'yes',
        ...(match?.[2] ? { detail: match[2] } : {}),
      });
    }

    if (observed) {
      const match = /^Reasoning observed: (yes|no)(?: \((.+)\))?$/.exec(observed.message);
      entries.push({
        label: 'Reasoning observed',
        value: match?.[1] ?? observed.message.replace('Reasoning observed: ', ''),
        ...(match?.[2] ? { detail: match[2] } : {}),
      });
    }

    return entries;
  }

  private renderProfilingReasoningBlock(reasoningBlock: string): HTMLElement {
    const details = document.createElement('details');
    details.className = 'chatgoose-profiling-reasoning';

    const summary = document.createElement('summary');
    summary.className = 'chatgoose-profiling-reasoning-summary';

    const label = document.createElement('span');
    label.className = 'chatgoose-profiling-stage-label';
    label.textContent = 'Reasoning block';

    const value = document.createElement('span');
    value.className = 'chatgoose-profiling-stage-duration';
    value.textContent = 'text';

    summary.append(label, value);

    const text = document.createElement('div');
    text.className = 'chatgoose-debug-text chatgoose-profiling-reasoning-text';
    text.textContent = reasoningBlock;

    details.append(summary, text);
    return details;
  }

  // ─── Debug Prompt Inspector ─────────────────────────────────────────

  private renderDebugPrompt(
    snapshot: PromptDebugSnapshot,
    echo?: DebugPromptEchoStatus,
  ): HTMLElement {
    const details = document.createElement('details');
    details.className = 'chatgoose-debug-inspector';
    details.open = this.debugPromptOpen;
    details.addEventListener('toggle', () => {
      this.debugPromptOpen = details.open;
    });

    const summary = document.createElement('summary');
    summary.className = 'chatgoose-debug-summary';
    summary.textContent = 'LLM Input';
    details.append(summary);

    const content = document.createElement('div');
    content.className = 'chatgoose-debug-content';
    content.append(
      // What the CLIENT sent. The kernel's own additions — persona, templates,
      // dossier — are never rendered here: this panel lives in Fansly's DOM,
      // which Fansly's own JS can read. They live one click away, on our page.
      this.createDebugSection('System Prompt', snapshot.system),
      this.createDebugSection('Transcript Sent to LLM', snapshot.transcript),
      this.createDebugSection('Fan Spending Data', snapshot.fanSpendingData.trim() || 'Not included'),
      this.createDebugSection('Fan Subscription Data', snapshot.fanSubscriptionData.trim() || 'Not included'),
      this.createDebugSection('Final User Prompt', snapshot.user),
    );
    if (echo) {
      content.append(this.renderKernelEcho(echo));
    }
    details.append(content);
    return details;
  }

  /** E28: the echo's status — and, when it exists, the counts projection plus
   * the button that opens the real prompt on the extension's own page. */
  private renderKernelEcho(echo: DebugPromptEchoStatus): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatgoose-debug-section';

    const label = document.createElement('div');
    label.className = 'chatgoose-debug-label';
    label.textContent = 'Kernel Context';
    section.append(label);

    if (echo.state !== 'available') {
      const text = document.createElement('div');
      text.className = 'chatgoose-debug-text';
      text.textContent = echo.state === 'cache-hit'
        ? 'Served from cache — no LLM call, so there is no prompt to show.'
        : 'Prompt echo is off on the kernel (owner opens a time-boxed window).';
      section.append(text);
      return section;
    }

    const { dossier, transcript, otherKeys } = echo.kernelContext;
    const lines: string[] = [];
    if (dossier) {
      const parts = [
        `v${dossier.version ?? '?'}`,
        dossier.ageDays !== null ? `${dossier.ageDays}d old` : null,
        dossier.chars !== null ? `${dossier.chars} chars` : null,
        dossier.truncated ? 'truncated' : null,
      ].filter((part): part is string => part !== null);
      lines.push(`Fan dossier: ${parts.join(' · ')}`);
      if (dossier.droppedSections.length > 0) {
        lines.push(`Dropped sections: ${dossier.droppedSections.join(', ')}`);
      }
    } else {
      lines.push('Fan dossier: not injected');
    }
    if (transcript) {
      const parts = [
        transcript.source ? `source ${transcript.source}` : null,
        transcript.mode ? `mode ${transcript.mode}` : null,
        transcript.archiveCount !== null ? `archive ${transcript.archiveCount}` : null,
        transcript.unionCount !== null ? `union ${transcript.unionCount}` : null,
        transcript.stale ? 'stale' : null,
      ].filter((part): part is string => part !== null);
      if (parts.length > 0) {
        lines.push(`Kernel transcript: ${parts.join(' · ')}`);
      }
    }
    if (otherKeys.length > 0) {
      lines.push(`Other manifest keys: ${otherKeys.join(', ')}`);
    }

    const text = document.createElement('div');
    text.className = 'chatgoose-debug-text';
    text.textContent = lines.join('\n');
    section.append(text);

    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chatgoose-debug-open';
    open.textContent = 'Open the real prompt →';
    open.addEventListener('click', () => {
      this.callbacks.onOpenDebugPrompt?.();
    });
    section.append(open);
    return section;
  }

  private createDebugSection(title: string, content: string): HTMLElement {
    const section = document.createElement('div');
    section.className = 'chatgoose-debug-section';

    const label = document.createElement('div');
    label.className = 'chatgoose-debug-label';
    label.textContent = title;

    const text = document.createElement('div');
    text.className = 'chatgoose-debug-text';
    text.textContent = content;

    section.append(label, text);
    return section;
  }
}
