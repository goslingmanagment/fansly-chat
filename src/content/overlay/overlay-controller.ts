import { COACH_QUESTION_MAX_CHARS } from '../../shared/constants.js';
import {
  formatCoachAgeMs,
  formatCoachWaitElapsed,
} from '../../shared/coach-format.js';
import { ChatGooseError, toUserError } from '../../shared/errors.js';
import type {
  CoachAutoRecapOverride,
  CoachOverlayDraft,
  CoachOverlayFeedItem,
  CoachOverlaySessionView,
  CoachRecapStatusView,
  CoachTurnContext,
  CoachTurnDebug,
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
import { COACH_SITUATION_DRAFT_CAPTIONS, COACH_SITUATION_PRESET_LABEL } from '../coach-copy.js';
import { parseGroupIdFromPath } from '../route-watcher.js';
import {
  renderCoachingBlocks,
  renderReviewEvaluation,
  renderReviewRecommendations,
} from './analysis-blocks.js';
import { renderCoachProse, renderSummaryMarkdown } from './summary-markdown.js';
import {
  formatLlmCostSummary,
  formatCacheEffectInline,
  formatCompactTokens,
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
  onRerun: (feature: FeatureType, recapMode?: 'full' | 'short') => void;
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
  /** E28: open the kernel's real prompt on the extension's own page. Without a
   * token the caller resolves the ACTIVE op's echo; a coach exchange passes its
   * own turn's token (E81 — the feed outlives the active-op marker). Tokens
   * live only in heap-held models and this call — never in the DOM. */
  onOpenDebugPrompt?: (viewerToken?: string) => void;
  /** Coach chat (spec §3). Optional so non-coach constructions stay valid. */
  /** `origin` distinguishes a composer-typed question from a canned one (chip)
   * — a rejected canned submit must NOT be restored into the composer. */
  onCoachSubmit?: (question: string, origin?: 'composer' | 'canned') => void;
  /** E80: the situation preset chip inside Coach (Help's new home). */
  onCoachPreset?: () => void;
  /** «New dialog» — clears the session (the orchestrator confirms if non-empty). */
  onCoachNewDialog?: () => void;
  /** Explicit recap refresh from within coach (short/full, spec §5). */
  onCoachRecap?: (mode: 'short' | 'full') => void;
  /** Set the per-session auto-recap override from the «Рекап ▾» radio group
   * (spec §3). */
  onCoachSetAutoRecap?: (override: CoachAutoRecapOverride) => void;
  /** «Обновить переписку» (spec §8.4): reseed the transcript on the next turn. */
  onCoachRefreshTranscript?: () => void;
  /** Draft-attach intent toggled in the composer (spec §5). */
  onCoachDraftIntentChange?: (intent: boolean) => void;
  /** Retry a failed/cancelled turn — replays its question (spec §8). `includedDraft`
   * is the failed attempt's honest sent-flag; Retry re-reads the live draft when
   * true (spec §5). */
  onCoachRetry?: (question: string, includedDraft: boolean, preset?: true) => void;
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
  /** Serialized signature of the last-rendered recap status, so an unchanged
   * structured line performs no DOM rebuild. */
  recapStatusSig: string;
  /** The «Рекап ▾» topbar menu (spec §3). */
  recapMenu: CoachRecapMenu;
  /** The draft-attach checkbox + its helper line (spec §5). Absent while the
   * ship-gate is off (spec §10.2 — core must consume draftText first). */
  draftCheckbox?: HTMLInputElement;
  draftHelperText?: Text;
  composerTextarea: HTMLTextAreaElement;
  sendButton: HTMLButtonElement;
  cancelButton: HTMLButtonElement;
  itemNodes: Map<string, HTMLElement>;
  /** The last-rendered item per key, so a reused index-key whose content
   * changed (feed reset) rebuilds instead of showing a stale node. */
  renderedItems: Map<string, CoachOverlayFeedItem>;
  /** The memory-window divider (spec §8.1), positioned before the oldest tail
   * exchange; null when not shown. */
  memoryDividerNode: HTMLElement | null;
  /** The follow-up chips row under the latest completed answer (spec §8.3). */
  followupsNode: HTMLElement | null;
  /** The in-flight turn's node (question bubble + streaming answer); null idle. */
  pendingNode: HTMLElement | null;
  /** The ONLY node mutated as stream chunks arrive. */
  pendingAnswerTextNode: Text | null;
  pendingQuestion: string | null;
  /** E81 wait narration: the pre-first-token status row (label + elapsed) and
   * the streaming answer bubble it swaps with once text arrives. */
  pendingWaitEl: HTMLElement | null;
  pendingWaitLabelNode: Text | null;
  pendingWaitElapsedNode: Text | null;
  pendingAnswerEl: HTMLElement | null;
  /** Dispatch timestamp anchoring the ticking elapsed counter. */
  pendingStartedAt: number | null;
  /** E81 debug: the collapsed «Отладка» stage log under the wait row
   * (debugMode only); `pendingDebugLogEl` is the replaceable rows host. */
  pendingDebugEl: HTMLDetailsElement | null;
  pendingDebugLogEl: HTMLDivElement | null;
  emptyStateNode: HTMLElement | null;
}

/** The «Рекап ▾» topbar menu handle (spec §3). Owns the trigger + popup; the
 * controller drives it (busy-disable, auto-recap radio state) and consults
 * `isOpen()`/`close()` so an Esc closes the MENU, not the overlay. */
interface CoachRecapMenu {
  root: HTMLDivElement;
  trigger: HTMLButtonElement;
  isOpen(): boolean;
  close(): void;
  /** close() for a DISCARDED view: drops the document-level outside-click
   * listener without touching focus (the trigger may already be detached) —
   * review P2: the listener used to outlive the view. */
  dispose(): void;
  setBusy(busy: boolean): void;
  updateAutoRecap(
    override: CoachAutoRecapOverride,
    resolvedDefault: 'off' | 'short' | 'full' | null,
  ): void;
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
    case 'fan-notes-fill':
      throw new Error('fan-notes-fill uses the notes panel');
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

/** Empty-state starter prompts (spec §6): 9 hints in three labeled groups.
 * Clicking one prefills the composer (existing mechanism). */
interface CoachHintGroup {
  label: string;
  hints: readonly string[];
}
// A targeted guard for Cyrillic leaking into fan-facing drafts, not a general
// language classifier. Preserve every original byte for the chatter to review.
// E108: the guard applies only to a fan who never wrote Cyrillic themselves
// (the background measures the fan's own transcript lines into
// turnContext.fanWritesCyrillic); for a Russian-speaking fan a Cyrillic draft
// is the intended output, not a leak. An absent flag (old background) keeps
// the guard fully on.
const COACH_DRAFT_CYRILLIC = /\p{Script=Cyrillic}/u;
const COACH_DRAFT_LANGUAGE_NOTE =
  'В черновике есть кириллица. Попроси Coach переписать его на английском.';

const COACH_HINT_GROUPS: readonly CoachHintGroup[] = [
  {
    label: 'Продать',
    hints: [
      'Не знаю, как продать — подскажи',
      'Как подать цену, чтобы не спугнуть?',
      'Просит скидку — что ответить?',
    ],
  },
  {
    label: 'Вернуть',
    hints: [
      'Как оживить остывший чат?',
      'Прочитал и молчит — что написать?',
      'Пропал после цены — как вернуть?',
    ],
  },
  {
    label: 'Понять',
    hints: [
      'Что этому фану реально заходит?',
      'Разбери его: что за человек?',
      'О чём говорить, кроме продаж?',
    ],
  },
];

/** Follow-up chips under the latest completed answer (spec §8.3). A click SUBMITS
 * the canned question (normal semantics); the composer text is untouched. */
const COACH_FOLLOWUP_CHIPS: readonly string[] = [
  'Другой вариант',
  'Сделай короче',
  'А если откажет?',
];

/** The «Авто-рекап» radio item labels (spec §3/§6). The `inherit` label carries
 * the resolved global default in parentheses when the §7 snapshot is known. */
function autoRecapItemLabel(
  override: CoachAutoRecapOverride,
  resolvedDefault: 'off' | 'short' | 'full' | null,
): string {
  switch (override) {
    case 'inherit': {
      if (resolvedDefault === null) {
        return 'По настройке';
      }
      const resolved =
        resolvedDefault === 'off' ? 'выкл' : resolvedDefault === 'short' ? 'короткий' : 'полный';
      return `По настройке (${resolved})`;
    }
    case 'off':
      return 'Выкл';
    case 'short':
      return 'Короткий';
    case 'full':
      return 'Полный';
  }
}

/** The four «Авто-рекап» radio options, in menu order (spec §3). */
const COACH_AUTO_RECAP_OPTIONS: readonly CoachAutoRecapOverride[] = [
  'inherit',
  'off',
  'short',
  'full',
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
    // `debug` is attached at commit and reference-stable afterwards (E81), so
    // identity — not deep equality — is the correct cheap comparison.
    return previous.operationId === next.operationId && previous.debug === next.debug;
  }
  if (previous.kind === 'failed-attempt' && next.kind === 'failed-attempt') {
    return (
      previous.question === next.question &&
      previous.errorCode === next.errorCode &&
      previous.retryable === next.retryable &&
      previous.includedDraft === next.includedDraft &&
      previous.preset === next.preset &&
      // Reference-stable per item (E81), same contract as exchange.debug.
      previous.profiling === next.profiling
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


export class OverlayController {
  private rootElement: HTMLElement | null = null;
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
  /** E81: 1s tick for the coach pending bubble's elapsed counter. Started with
   * the wait row, cleared when the pending node leaves or the view is torn
   * down — the same lifecycle discipline as `loadingElapsedTimer`. */
  private coachWaitTimer: number | null = null;
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
        // Spec §3: Esc with the «Рекап ▾» menu open closes the MENU only, never
        // the overlay. Focus returns to the trigger inside close().
        if (this.currentView?.kind === 'coach' && this.currentView.recapMenu.isOpen()) {
          this.currentView.recapMenu.close();
          return;
        }
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
      // Reply parts and Split Fix parts (E142) share the Enter-inserts-next flow.
      if (this.model.feature !== 'fast-reply' && this.model.feature !== 'improve-draft') return;
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

  private get root(): HTMLElement {
    return this.rootElement ??= ensureOverlayRoot();
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

  /** True while any overlay surface (a result, Coach, the Recap picker) shows. */
  isVisible(): boolean {
    return this.model.kind !== 'hidden';
  }

  render(model: OverlayViewModel, options?: OverlayRenderOptions | boolean): void {
    const opts: OverlayRenderOptions =
      typeof options === 'boolean' ? { preserveInlineError: options } : (options ?? {});
    const renderStart = performance.now();
    const operationId = operationIdForModel(model);
    let shellAction: 'mounted' | 'reused' | 'hidden' = 'reused';
    let bodyAction: 'none' | 'rebuild-body' | 'update-loading' | 'rebuild-coach' | 'update-coach' = 'none';

    if (model.kind === 'hidden' && this.model.kind === 'hidden') {
      return;
    }
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

  /** Re-focus the coach composer of an already-open coach view (spec §3
   * "focus if open" — openCoach on an open session). No-op otherwise. */
  focusCoachComposer(): void {
    if (this.currentView?.kind === 'coach') {
      this.currentView.composerTextarea.focus();
    }
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

  private clearCoachWaitTimer(): void {
    if (this.coachWaitTimer === null) {
      return;
    }
    window.clearInterval(this.coachWaitTimer);
    this.coachWaitTimer = null;
  }

  private async insertPart(
    part: OverlayInsertPart,
    options?: { autoPassThrough?: boolean },
  ): Promise<void> {
    try {
      // LIVE route check (same guard the coach draft path runs below): the
      // orchestrator's polled route lags a chat switch by up to 500ms, so a
      // click landing in that window would put fan A's text into fan B's
      // composer without this.
      const mintedGroupId = 'groupId' in this.model ? this.model.groupId : null;
      if (mintedGroupId !== null &&
        parseGroupIdFromPath(window.location.pathname) !== mintedGroupId) {
        throw new ChatGooseError('chat_changed');
      }
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
    this.disposeCoachView();
    this.currentView = null;
    return true;
  }

  /** Drop a discarded coach view's document-level menu listener (review P2)
   * and its elapsed-counter interval (E81). */
  private disposeCoachView(): void {
    if (this.currentView?.kind === 'coach') {
      this.currentView.recapMenu.dispose();
      this.clearCoachWaitTimer();
    }
  }

  private teardownShell(): void {
    this.clearLoadingElapsedTimer();
    this.disposeCoachView();
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
          ? 'Коуч'
          : model.kind === 'recap-picker'
            ? 'Recap'
            : 'ChatGoose';
    // Coach header (spec §2/§6): the feature name lives in the clay eyebrow, so
    // the title is bare «@<fan>» — no «Коуч / Коуч» doubling.
    const titleText =
      model.kind === 'error'
        ? 'ChatGoose'
        : model.kind === 'coach'
          ? `@${model.fanDisplayName || 'fan'}`
          : `${feature} — @${model.fanDisplayName || 'fan'}`;
    // Coach has NO subtitle (spec §2): '' hides the row.
    const subtitleText =
      model.kind === 'error'
        ? 'Something went wrong'
        : model.kind === 'coach'
          ? ''
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
    this.headerSubtitleEl.classList.toggle('chatgoose-hidden', subtitleText === '');
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
      // Dispose the OLD view BEFORE creating the new one: createCoachView may
      // start the shared coach wait timer (E81), which a late dispose of the
      // discarded view would then kill.
      this.disposeCoachView();
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
    this.disposeCoachView();
    this.currentView = nextView;

    // Auto-focus the first Insert button for newly visible completed fast replies
    // and Split Fix parts (E142)
    if (
      model.kind === 'reply' &&
      (model.feature === 'fast-reply' || model.feature === 'improve-draft') &&
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

    // Topbar: recap freshness line (left) + «Рекап ▾» menu + «Новый диалог».
    const topbar = document.createElement('div');
    topbar.className = 'chatgoose-coach-topbar';

    const recap = document.createElement('div');
    recap.className = 'chatgoose-coach-recap';

    const topbarActions = document.createElement('div');
    topbarActions.className = 'chatgoose-coach-topbar-actions';
    const recapMenu = this.createCoachRecapMenu();

    // «Новый диалог» — a two-step inline confirm (spec §3), mirroring the
    // Replace-draft button below: NO window.confirm (it blocks the extension).
    // A NON-EMPTY dialog arms a «Точно сбросить?» state on the first click; the
    // second click resets. An EMPTY dialog resets immediately. Blur /
    // outside-click / «Оставить» abandons the confirm so a stale armed state
    // never lingers. Emptiness is read live from the current model at click time.
    const newDialog = document.createElement('button');
    newDialog.type = 'button';
    newDialog.className = 'chatgoose-button chatgoose-button-secondary';
    newDialog.textContent = 'Новый диалог';
    const newDialogKeep = document.createElement('button');
    newDialogKeep.type = 'button';
    newDialogKeep.className = 'chatgoose-button chatgoose-button-secondary chatgoose-hidden';
    newDialogKeep.textContent = 'Оставить';
    let newDialogArmed = false;
    const disarmNewDialog = (): void => {
      newDialogArmed = false;
      newDialog.classList.remove('chatgoose-coach-newdialog-armed');
      newDialogKeep.classList.add('chatgoose-hidden');
      newDialog.textContent = 'Новый диалог';
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
        newDialog.textContent = 'Точно сбросить?';
        newDialog.classList.add('chatgoose-coach-newdialog-armed');
        newDialogKeep.classList.remove('chatgoose-hidden');
        return;
      }
      disarmNewDialog();
      this.callbacks.onCoachNewDialog?.();
    });
    topbarActions.append(recapMenu.root, newDialog, newDialogKeep);
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
    textarea.placeholder = 'Спроси про этого фана…';
    // Cap the question at the kernel bound (spec §7) at the DOM level so an
    // over-long question is prevented up front, not failed late + generic.
    textarea.maxLength = COACH_QUESTION_MAX_CHARS;
    textarea.value = model.sessionView.composerText;
    textarea.addEventListener('input', () => {
      this.autosizeCoachComposer(textarea);
      send.disabled = textarea.disabled || !textarea.value.trim();
      this.callbacks.onCoachComposerInput?.(textarea.value);
    });
    textarea.addEventListener('keydown', (event) => {
      // Enter submits; Shift+Enter is a newline; an IME composition never submits.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.submitCoachQuestion(textarea);
      }
    });

    // Draft-attach block (spec §5/§2.1): checkbox + helper line stacked under
    // the label, left of the send/cancel buttons. Built ONLY behind the ship
    // gate (spec §10.2, review P1): until core consumes draftText for coach,
    // a rendered checkbox would silently do nothing — worse than none.
    let draftAttach: HTMLDivElement | null = null;
    let draftCheckbox: HTMLInputElement | undefined;
    let draftHelperText: Text | undefined;
    if (model.sessionView.draftAttachEnabled) {
      draftAttach = document.createElement('div');
      draftAttach.className = 'chatgoose-coach-draft-attach';
      const draftLabel = document.createElement('label');
      draftLabel.className = 'chatgoose-coach-draft-attach-label';
      draftCheckbox = document.createElement('input');
      draftCheckbox.type = 'checkbox';
      draftCheckbox.className = 'chatgoose-coach-draft-attach-box';
      const draftLabelText = document.createElement('span');
      draftLabelText.textContent = 'Приложить мой недописанный ответ';
      draftLabel.append(draftCheckbox, draftLabelText);
      const draftHelper = document.createElement('div');
      draftHelper.className = 'chatgoose-coach-draft-attach-help';
      draftHelperText = document.createTextNode('');
      draftHelper.append(draftHelperText);
      draftAttach.append(draftLabel, draftHelper);
      const box = draftCheckbox;
      box.addEventListener('change', () => {
        this.callbacks.onCoachDraftIntentChange?.(box.checked);
      });
    }

    const composerActions = document.createElement('div');
    composerActions.className = 'chatgoose-coach-composer-actions';
    const buttons = document.createElement('div');
    buttons.className = 'chatgoose-coach-composer-buttons';
    const send = this.createCoachButton('Отправить', '', () => this.submitCoachQuestion(textarea));
    send.classList.add('chatgoose-coach-send');
    const cancel = this.createCoachButton('Отменить', 'chatgoose-button-danger', () => {
      if (this.model.kind === 'coach' && this.model.operationId) {
        this.callbacks.onCancel(this.model.operationId);
      }
    });
    cancel.classList.add('chatgoose-coach-cancel', 'chatgoose-hidden');
    buttons.append(send, cancel);
    if (draftAttach) {
      composerActions.append(draftAttach);
    }
    composerActions.append(buttons);
    composer.append(textarea, composerActions);

    root.append(topbar, feed, composer);

    const view: CoachViewState = {
      kind: 'coach',
      operationId: model.operationId,
      root,
      feedEl: feed,
      itemsEl: items,
      recapStatusEl: recap,
      recapStatusSig: '',
      recapMenu,
      ...(draftCheckbox !== undefined ? { draftCheckbox } : {}),
      ...(draftHelperText !== undefined ? { draftHelperText } : {}),
      composerTextarea: textarea,
      sendButton: send,
      cancelButton: cancel,
      itemNodes: new Map(),
      renderedItems: new Map(),
      memoryDividerNode: null,
      followupsNode: null,
      pendingNode: null,
      pendingAnswerTextNode: null,
      pendingQuestion: null,
      pendingWaitEl: null,
      pendingWaitLabelNode: null,
      pendingWaitElapsedNode: null,
      pendingAnswerEl: null,
      pendingStartedAt: null,
      pendingDebugEl: null,
      pendingDebugLogEl: null,
      emptyStateNode: null,
    };
    this.updateCoachView(view, model);
    // Spec §3 "open or focus": the panel opens ready to type. Only on CREATE —
    // updateCoachView re-renders must never steal focus mid-conversation.
    // A coach view is also re-created when a covering deep overlay closes; there
    // the auto-focus is welcome (coach just became the visible surface) but it
    // must never yank focus out of something the chatter is already using INSIDE
    // the overlay, so the guard runs at focus time, not at build time.
    queueMicrotask(() => {
      if (this.currentView !== view) {
        return;
      }
      const active = document.activeElement;
      if (active && active !== document.body && this.root.contains(active)) {
        return;
      }
      view.composerTextarea.focus();
    });
    return view;
  }

  private updateCoachView(
    view: CoachViewState,
    model: Extract<OverlayViewModel, { kind: 'coach' }>,
  ): void {
    const sv = model.sessionView;
    view.operationId = model.operationId;
    const streaming = model.operationId !== null;

    // Recap status line (guarded — an unchanged structured line is not rebuilt).
    this.renderCoachRecapStatus(view, sv.recapStatusLine);

    // Composer lock + Send/Cancel affordance (all guarded).
    const disabled = !sv.composerEnabled;

    // «Рекап ▾» menu: disabled while busy (a streaming turn / running recap step)
    // — no refresh, reseed, or mode change mid-turn (spec §3). The resolved
    // auto-recap radio state + «По настройке (<x>)» label come from the §7
    // snapshot; absent → the label drops its value.
    view.recapMenu.setBusy(disabled);
    view.recapMenu.updateAutoRecap(
      sv.autoRecapOverride,
      sv.settingsSnapshot?.coachAutoRecap ?? null,
    );

    // Draft-attach checkbox (spec §5): force-unchecked + disabled while the live
    // Fansly composer is empty; else reflects the session intent. Re-evaluated
    // every render.
    this.reconcileCoachDraftAttach(view, sv);

    if (view.composerTextarea.disabled !== disabled) {
      view.composerTextarea.disabled = disabled;
    }
    view.sendButton.classList.toggle('chatgoose-hidden', streaming);
    view.cancelButton.classList.toggle('chatgoose-hidden', !streaming);
    // Restore the composer text when unfocused — never clobber a live caret.
    // Exception (review round 15): restoring into an EMPTY focused textarea is
    // safe (there is no caret work to lose) and required — after a rejected
    // Send the focus stays in the field, and the model-side restore was
    // invisible until blur.
    if (
      (document.activeElement !== view.composerTextarea ||
        view.composerTextarea.value === '') &&
      view.composerTextarea.value !== sv.composerText
    ) {
      view.composerTextarea.value = sv.composerText;
    }
    view.sendButton.disabled = disabled || !view.composerTextarea.value.trim();

    // Snapshot the scroll pin BEFORE any feed mutation so streaming (or a new
    // committed item) only auto-scrolls when the chatter was already at bottom.
    const wasNearBottom = this.isScrolledToBottom(view.feedEl);

    this.reconcileCoachFeed(view, sv);
    this.reconcileCoachMemoryDivider(view, sv);
    this.reconcileCoachPending(view, model);
    this.reconcileCoachFollowups(view, model);
    this.reconcileCoachEmptyState(view, model);

    if (wasNearBottom) {
      this.scrollCoachFeedToBottom(view);
    }
  }

  /** Reflect the draft-attach checkbox from the live Fansly composer + session
   * intent (spec §5/§2.1). Empty live draft → dimmed, force-unchecked, helper
   * «Поле ответа Fansly пустое»; never mutates the stored intent. */
  private reconcileCoachDraftAttach(view: CoachViewState, sv: CoachOverlaySessionView): void {
    if (!view.draftCheckbox || !view.draftHelperText) {
      return; // ship-gate off (spec §10.2) — no control was built
    }
    const draftAvailable = getActiveConversationDraftText().trim() !== '';
    const checked = draftAvailable && sv.draftIntent;
    // Busy turns lock the checkbox too (review P1): a dispatched attempt's
    // composition can no longer be changed, so the control must not look live.
    const disabled = !draftAvailable || !sv.composerEnabled;
    if (view.draftCheckbox.checked !== checked) {
      view.draftCheckbox.checked = checked;
    }
    if (view.draftCheckbox.disabled !== disabled) {
      view.draftCheckbox.disabled = disabled;
    }
    const helper = draftAvailable
      ? 'Коуч увидит текст, набранный в поле ответа Fansly.'
      : 'Поле ответа Fansly пустое';
    if (view.draftHelperText.data !== helper) {
      view.draftHelperText.data = helper;
    }
  }

  /** Rebuild the structured recap freshness line (spec §2.1) — label muted, age
   * values emphasized — only when its serialized signature changed. */
  private renderCoachRecapStatus(view: CoachViewState, status: CoachRecapStatusView): void {
    const sig = JSON.stringify(status);
    if (view.recapStatusSig === sig) {
      return;
    }
    view.recapStatusSig = sig;
    view.recapStatusEl.replaceChildren();
    view.recapStatusEl.classList.toggle('chatgoose-hidden', status.state === 'hidden');
    if (status.state === 'hidden') {
      return;
    }
    if (status.state === 'unavailable') {
      view.recapStatusEl.textContent = 'Рекап: не удалось проверить';
      return;
    }
    const lead = document.createElement('span');
    lead.className = 'chatgoose-coach-recap-lead';
    lead.textContent = 'Рекап —';
    view.recapStatusEl.append(lead);
    const slots: Array<{ label: string; value: string }> = [];
    if (status.fullAge !== null) {
      slots.push({ label: 'полный:', value: status.fullAge });
    }
    if (status.shortAge !== null) {
      slots.push({ label: 'короткий:', value: status.shortAge });
    }
    slots.forEach((slot, index) => {
      const label = document.createElement('span');
      label.className = 'chatgoose-coach-recap-label';
      // The « · » separator is folded into the label prefix so spacing stays
      // exact — «Рекап — полный: 3 дн · короткий: 10 мин».
      label.textContent = `${index === 0 ? ' ' : ' · '}${slot.label} `;
      const value = document.createElement('span');
      value.className = 'chatgoose-coach-recap-value';
      value.textContent = slot.value;
      view.recapStatusEl.append(label, value);
    });
  }

  /** The «Рекап ▾» topbar menu (spec §3): explicit short/full refresh, «Обновить
   * переписку» (§8.4), and the «Авто-рекап» radio group (1:1 with the session
   * override). Opens on click; closes on item select, outside click, or Esc
   * (Esc is intercepted at the controller level so it never dismisses the
   * overlay). a11y: aria-haspopup/expanded, role=menu, menuitem/menuitemradio,
   * arrow-key focus, focus returns to the trigger on close. */
  private createCoachRecapMenu(): CoachRecapMenu {
    const root = document.createElement('div');
    root.className = 'chatgoose-coach-recap-menu';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className =
      'chatgoose-button chatgoose-button-secondary chatgoose-coach-recap-trigger';
    trigger.textContent = 'Рекап ▾';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');

    const panel = document.createElement('div');
    panel.className = 'chatgoose-coach-recap-panel chatgoose-hidden';
    panel.setAttribute('role', 'menu');

    let open = false;
    let outsideHandler: ((event: MouseEvent) => void) | null = null;

    const menuItems = (): HTMLButtonElement[] =>
      Array.from(panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"],[role="menuitemradio"]'));

    const close = (): void => {
      if (!open) {
        return;
      }
      open = false;
      panel.classList.add('chatgoose-hidden');
      trigger.setAttribute('aria-expanded', 'false');
      if (outsideHandler) {
        document.removeEventListener('mousedown', outsideHandler);
        outsideHandler = null;
      }
      if (!trigger.disabled) {
        trigger.focus();
      }
    };

    const dispose = (): void => {
      open = false;
      panel.classList.add('chatgoose-hidden');
      trigger.setAttribute('aria-expanded', 'false');
      if (outsideHandler) {
        document.removeEventListener('mousedown', outsideHandler);
        outsideHandler = null;
      }
    };

    const openMenu = (): void => {
      if (open || trigger.disabled) {
        return;
      }
      open = true;
      panel.classList.remove('chatgoose-hidden');
      trigger.setAttribute('aria-expanded', 'true');
      outsideHandler = (event: MouseEvent): void => {
        if (!root.contains(event.target as Node)) {
          close();
        }
      };
      document.addEventListener('mousedown', outsideHandler);
      menuItems()[0]?.focus();
    };

    trigger.addEventListener('click', () => {
      if (open) {
        close();
      } else {
        openMenu();
      }
    });

    // Arrow-key focus within the menu (spec §3 a11y). Esc is handled at the
    // controller level so it closes the menu, not the overlay.
    panel.addEventListener('keydown', (event) => {
      const items = menuItems();
      if (items.length === 0) {
        return;
      }
      const activeIndex = items.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        items[(activeIndex + 1 + items.length) % items.length]?.focus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        items[(activeIndex - 1 + items.length) % items.length]?.focus();
      } else if (event.key === 'Home') {
        event.preventDefault();
        items[0]?.focus();
      } else if (event.key === 'End') {
        event.preventDefault();
        items[items.length - 1]?.focus();
      } else if (event.key === 'Tab') {
        // WAI-ARIA menu-button pattern (spec §3, review round 13): tabbing out
        // dismisses the menu. dispose(), not close() — focus is moving away by
        // the user's own choice, so it must not be stolen back to the trigger.
        dispose();
      }
    });

    const addItem = (label: string, role: 'menuitem' | 'menuitemradio', onSelect: () => void): HTMLButtonElement => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'chatgoose-button chatgoose-coach-recap-item';
      item.setAttribute('role', role);
      item.textContent = label;
      item.addEventListener('click', () => {
        close();
        onSelect();
      });
      panel.append(item);
      return item;
    };

    const addSeparator = (): void => {
      const sep = document.createElement('div');
      sep.className = 'chatgoose-coach-recap-menu-sep';
      sep.setAttribute('role', 'separator');
      panel.append(sep);
    };

    addItem('Короткий рекап', 'menuitem', () => this.callbacks.onCoachRecap?.('short'));
    addItem('Полный рекап', 'menuitem', () => this.callbacks.onCoachRecap?.('full'));
    addSeparator();
    addItem('Обновить переписку', 'menuitem', () => this.callbacks.onCoachRefreshTranscript?.());
    addSeparator();

    // Valid menu ARIA (review P2): a bare div inside role="menu" is ignored or
    // read unpredictably — the label is presentational and NAMES the radio
    // group, and the four menuitemradio buttons live inside role="group".
    const groupLabel = document.createElement('div');
    groupLabel.className = 'chatgoose-coach-recap-menu-group';
    groupLabel.textContent = 'Авто-рекап';
    groupLabel.id = `chatgoose-coach-autorecap-label-${crypto.randomUUID()}`;
    groupLabel.setAttribute('role', 'presentation');
    panel.append(groupLabel);
    const radioGroup = document.createElement('div');
    radioGroup.setAttribute('role', 'group');
    radioGroup.setAttribute('aria-labelledby', groupLabel.id);
    panel.append(radioGroup);

    const radioItems = new Map<CoachAutoRecapOverride, HTMLButtonElement>();
    for (const override of COACH_AUTO_RECAP_OPTIONS) {
      const item = addItem(autoRecapItemLabel(override, null), 'menuitemradio', () =>
        this.callbacks.onCoachSetAutoRecap?.(override),
      );
      radioGroup.append(item);
      item.setAttribute('aria-checked', 'false');
      radioItems.set(override, item);
    }

    root.append(trigger, panel);

    return {
      root,
      trigger,
      isOpen: () => open,
      close,
      dispose,
      setBusy: (busy: boolean) => {
        if (trigger.disabled !== busy) {
          trigger.disabled = busy;
        }
        if (busy) {
          close();
        }
      },
      updateAutoRecap: (override, resolvedDefault) => {
        const inheritItem = radioItems.get('inherit');
        if (inheritItem) {
          const label = autoRecapItemLabel('inherit', resolvedDefault);
          if (inheritItem.textContent !== label) {
            inheritItem.textContent = label;
          }
        }
        for (const [value, item] of radioItems) {
          const checked = value === override ? 'true' : 'false';
          if (item.getAttribute('aria-checked') !== checked) {
            item.setAttribute('aria-checked', checked);
          }
          item.classList.toggle('chatgoose-coach-recap-item-checked', value === override);
        }
      },
    };
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
    // unchanged feed performs no DOM moves at all. The memory divider (§8.1)
    // stays ATTACHED and is skipped by the walk (review P2: the old
    // detach/reinsert churned two DOM mutations per streaming frame);
    // reconcileCoachMemoryDivider then moves it only when its target changed.
    let cursor: ChildNode | null = view.itemsEl.firstChild;
    for (const key of desiredKeys) {
      while (cursor !== null && cursor === view.memoryDividerNode) {
        cursor = cursor.nextSibling;
      }
      const node = nodesByKey.get(key)!;
      if (cursor === node) {
        cursor = node.nextSibling;
      } else {
        view.itemsEl.insertBefore(node, cursor);
      }
    }
  }

  private reconcileCoachPending(
    view: CoachViewState,
    model: Extract<OverlayViewModel, { kind: 'coach' }>,
  ): void {
    const sv = model.sessionView;
    const streaming = model.operationId !== null && sv.pendingQuestion !== undefined;
    if (!streaming) {
      this.clearCoachWaitTimer();
      if (view.pendingNode) {
        view.pendingNode.remove();
        view.pendingNode = null;
        view.pendingAnswerTextNode = null;
        view.pendingQuestion = null;
        view.pendingWaitEl = null;
        view.pendingWaitLabelNode = null;
        view.pendingWaitElapsedNode = null;
        view.pendingAnswerEl = null;
        view.pendingStartedAt = null;
        view.pendingDebugEl = null;
        view.pendingDebugLogEl = null;
      }
      return;
    }

    const question = sv.pendingQuestion ?? '';
    if (!view.pendingNode || view.pendingQuestion !== question) {
      // New turn — (re)build the pending node once; from here only its answer
      // text node, the wait row's texts, and the debug log rows are mutated.
      const built = this.createCoachPendingNode(question);
      if (view.pendingNode) {
        view.pendingNode.replaceWith(built.wrapper);
      } else {
        view.feedEl.append(built.wrapper);
      }
      view.pendingNode = built.wrapper;
      view.pendingAnswerTextNode = built.answerText;
      view.pendingQuestion = question;
      view.pendingWaitEl = built.waitEl;
      view.pendingWaitLabelNode = built.waitLabel;
      view.pendingWaitElapsedNode = built.waitElapsed;
      view.pendingAnswerEl = built.answerEl;
      view.pendingDebugEl = null;
      view.pendingDebugLogEl = null;
    }
    view.pendingStartedAt = sv.pendingStartedAt ?? null;

    // First streamed token flips the bubble: wait narration out, answer in
    // (E81). Both nodes persist — the flip is a class toggle, not a rebuild.
    const hasAnswerText = Boolean(sv.pendingAnswerText && sv.pendingAnswerText.length > 0);
    view.pendingWaitEl?.classList.toggle('chatgoose-hidden', hasAnswerText);
    view.pendingAnswerEl?.classList.toggle('chatgoose-hidden', !hasAnswerText);
    if (hasAnswerText) {
      this.clearCoachWaitTimer();
      const answer = sv.pendingAnswerText ?? '';
      if (view.pendingAnswerTextNode && view.pendingAnswerTextNode.data !== answer) {
        view.pendingAnswerTextNode.data = answer;
      }
    } else {
      const label = sv.pendingWaitLabel ?? 'Думаю…';
      if (view.pendingWaitLabelNode && view.pendingWaitLabelNode.data !== label) {
        view.pendingWaitLabelNode.data = label;
      }
      this.refreshCoachWaitElapsed(view);
      if (this.coachWaitTimer === null) {
        this.coachWaitTimer = window.setInterval(() => {
          if (this.currentView?.kind !== 'coach' || !this.currentView.pendingWaitEl) {
            this.clearCoachWaitTimer();
            return;
          }
          this.refreshCoachWaitElapsed(this.currentView);
        }, 1000);
      }
    }

    this.reconcileCoachPendingDebug(view, sv);
  }

  /** Tick the pending wait row's elapsed counter (E81). */
  private refreshCoachWaitElapsed(view: CoachViewState): void {
    if (!view.pendingWaitElapsedNode || view.pendingStartedAt === null) {
      return;
    }
    const text = formatCoachWaitElapsed(Date.now() - view.pendingStartedAt);
    if (view.pendingWaitElapsedNode.data !== text) {
      view.pendingWaitElapsedNode.data = text;
    }
  }

  /** The collapsed live «Отладка» stage log under the pending wait row (E81,
   * debugMode only). The <details> node persists across updates so the
   * open/closed toggle survives; only the log rows are replaced. */
  private reconcileCoachPendingDebug(
    view: CoachViewState,
    sv: CoachOverlaySessionView,
  ): void {
    const snapshot = sv.pendingProfiling;
    if (!snapshot) {
      if (view.pendingDebugEl) {
        view.pendingDebugEl.remove();
        view.pendingDebugEl = null;
        view.pendingDebugLogEl = null;
      }
      return;
    }
    if (!view.pendingDebugEl || !view.pendingDebugLogEl) {
      const details = document.createElement('details');
      details.className = 'chatgoose-coach-debug';
      const summary = document.createElement('summary');
      summary.className = 'chatgoose-coach-debug-summary';
      summary.textContent = 'Отладка';
      const log = document.createElement('div');
      log.className = 'chatgoose-coach-debug-log';
      details.append(summary, log);
      view.pendingNode?.append(details);
      view.pendingDebugEl = details;
      view.pendingDebugLogEl = log;
    }
    view.pendingDebugLogEl.replaceChildren(
      ...snapshot.logEntries.map((entry) => this.createProfilingLogRow(entry)),
    );
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
      // The submit preflight is a busy state (review round 12): the hint chips
      // lock with the composer they prefill.
      const locked = !model.sessionView.composerEnabled;
      for (const chip of view.emptyStateNode.querySelectorAll<HTMLButtonElement>(
        '.chatgoose-coach-hint',
      )) {
        if (chip.disabled !== locked) {
          chip.disabled = locked;
        }
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
    if (this.currentView?.kind === 'coach' && this.currentView.composerTextarea === textarea) {
      this.currentView.sendButton.disabled = true;
    }
    this.autosizeCoachComposer(textarea);
    // Keep the orchestrator's persisted composerText in sync with the clear.
    this.callbacks.onCoachComposerInput?.('');
    this.callbacks.onCoachSubmit?.(question, 'composer');
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
      // createElement/textContent ONLY (never innerHTML) — the T5 parser
      // neutralises column-0 fences but not every CommonMark form. Three
      // display tiers: E79/Core #204 preset advice with pinned labels gets
      // E77's structured Help blocks; otherwise model-volunteered markdown
      // (bold headers, lists) renders as blocks via the recap's structural
      // builder (E81); plain prose keeps the raw pre-wrap text path.
      const structured = renderCoachingBlocks(item.answerProse);
      const blocks = structured ? null : renderCoachProse(item.answerProse);
      if (structured) {
        answer.append(structured);
      } else if (blocks) {
        answer.classList.add('chatgoose-md', 'chatgoose-coach-answer-md');
        answer.append(blocks);
      } else {
        answer.textContent = item.answerProse;
      }
      wrapper.append(answer);
    }

    if (item.drafts.length > 0) {
      const drafts = document.createElement('div');
      drafts.className = 'chatgoose-parts chatgoose-coach-drafts';
      for (const [position, draft] of item.drafts.entries()) {
        const caption = item.preset && item.drafts.length === 2
          ? COACH_SITUATION_DRAFT_CAPTIONS[position]
          : undefined;
        drafts.append(
          this.createCoachDraftCard(
            item.operationId,
            item.generationRef,
            draft,
            item.turnContext?.fanWritesCyrillic === true,
            caption,
          ),
        );
      }
      wrapper.append(drafts);
    }

    // Collapsed «Отправлено коучу…» context line (spec §8.2); absent turnContext
    // (old background) → no line.
    if (item.turnContext) {
      wrapper.append(this.createCoachTurnContextLine(item.turnContext));
    }

    // Debug footer (E81): timings + tokens + the «Промпт» opener. Exists only
    // when debugMode was on during the turn (the debug object's presence).
    if (item.debug) {
      wrapper.append(this.createCoachDebugFooter(item.debug));
    }
    return wrapper;
  }

  /** The completed exchange's one-line debug footer (E81): total / TTFB
   * timings, priced tokens, and — while the E28 echo token is alive — the
   * «Промпт» button opening the real prompt on the extension-origin page. */
  private createCoachDebugFooter(debug: CoachTurnDebug): HTMLDivElement {
    const footer = document.createElement('div');
    footer.className = 'chatgoose-coach-debug-footer';

    const parts: string[] = [];
    const profiling = debug.profiling;
    if (profiling) {
      const ttfb = profiling.stages.find((stage) => stage.key === 'llm-ttfb');
      parts.push(
        ttfb?.durationMs !== undefined
          ? `${formatProfilingElapsed(profiling.elapsedMs)} · ttfb ${formatProfilingElapsed(ttfb.durationMs)}`
          : formatProfilingElapsed(profiling.elapsedMs),
      );
    }
    const spend = debug.llmSpend;
    if (spend) {
      parts.push(
        `${formatCompactTokens(spend.totalTokens)} tok · ${formatUsd(spend.totalUsd, spend.approximate)}`,
      );
    }
    for (const part of parts) {
      const span = document.createElement('span');
      span.textContent = part;
      footer.append(span);
    }

    if (debug.promptEcho?.state === 'available') {
      const token = debug.promptEcho.viewerToken;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'chatgoose-coach-debug-prompt';
      open.textContent = 'Промпт ↗';
      // The token travels ONLY through this closure into the runtime call
      // (E28) — never into an attribute the page could read.
      open.addEventListener('click', () => {
        this.callbacks.onOpenDebugPrompt?.(token);
      });
      footer.append(open);
    }
    return footer;
  }

  /** Collapsed «Отладка» stage log for a feed node (E81, debugMode only). */
  private createCoachDebugLogDetails(
    profiling: OperationProfilingSnapshot,
  ): HTMLDetailsElement {
    const details = document.createElement('details');
    details.className = 'chatgoose-coach-debug';
    const summary = document.createElement('summary');
    summary.className = 'chatgoose-coach-debug-summary';
    summary.textContent = 'Отладка';
    const log = document.createElement('div');
    log.className = 'chatgoose-coach-debug-log';
    log.append(...profiling.logEntries.map((entry) => this.createProfilingLogRow(entry)));
    details.append(summary, log);
    return details;
  }

  /** The collapsed, expand-in-place «Отправлено коучу…» line (spec §8.2). The
   * transcript figures are what the BROWSER sent (pre-budget); the recap part is
   * the kernel's post-attach report. Native <details> expands in place, so the
   * feed scroll is preserved. */
  private createCoachTurnContextLine(turnContext: CoachTurnContext): HTMLDetailsElement {
    const details = document.createElement('details');
    details.className = 'chatgoose-coach-turncontext';

    const coverage =
      turnContext.transcriptCoverage === 'full-history' ? 'вся история' : 'окно';
    const recapParts: string[] = [];
    if (turnContext.attachedRecaps?.full) {
      recapParts.push(`полный ${formatCoachAgeMs(turnContext.attachedRecaps.full.ageMs)}`);
    }
    if (turnContext.attachedRecaps?.short) {
      recapParts.push(`короткий ${formatCoachAgeMs(turnContext.attachedRecaps.short.ageMs)}`);
    }
    // «Не сообщено» ≠ «нет» (round 12, E43): a kernel that did not report the
    // attach must not be quoted as confirming an empty one.
    const recapSummary =
      recapParts.length > 0
        ? recapParts.join(', ')
        : turnContext.attachedRecaps !== undefined
          ? 'нет'
          : 'нет данных';

    const summary = document.createElement('summary');
    summary.className = 'chatgoose-coach-turncontext-summary';
    summary.textContent =
      `Отправлено коучу: ${turnContext.sentMessageCount} сообщ. (${coverage}) · рекап: ${recapSummary}`;
    details.append(summary);

    // The expansion carries what the summary does NOT (review P2 — it used to
    // restate the same two values): the provenance split. Transcript figures
    // are the browser's PRE-budget send; the recap line is the kernel's
    // POST-attach confirmation; the kernel may shed further for prompt budget.
    const detail = document.createElement('div');
    detail.className = 'chatgoose-coach-turncontext-detail';
    const transcriptLine = document.createElement('div');
    transcriptLine.textContent =
      `Переписка: ${turnContext.sentMessageCount} сообщ. (${coverage}) — отправлено браузером, до бюджета ядра`;
    const recapLine = document.createElement('div');
    recapLine.textContent =
      turnContext.attachedRecaps !== undefined
        ? `Рекап: ${recapSummary} — подтверждено ядром после сборки промпта`
        : 'Рекап: нет данных — ядро не сообщило состав приложенного';
    const caveatLine = document.createElement('div');
    caveatLine.textContent =
      'Ядро может дополнительно ужать контекст под бюджет промпта.';
    detail.append(transcriptLine, recapLine, caveatLine);
    details.append(detail);
    return details;
  }

  private createCoachFailedNode(
    item: Extract<CoachOverlayFeedItem, { kind: 'failed-attempt' }>,
  ): HTMLDivElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'chatgoose-coach-exchange chatgoose-coach-failed';
    wrapper.append(this.createCoachQuestionBubble(item.question));

    const error = document.createElement('div');
    error.className = 'chatgoose-coach-error';
    // A deliberate cancel is the USER's action, not a failure — naming it
    // «не получилось» (with a raw English token on top) blames the panel for
    // what the person just did. Kernel/internal codes keep the failure copy.
    error.textContent = item.errorCode === 'cancelled'
      ? 'Остановлено вами.'
      : `Не получилось закончить ответ (${item.errorCode}).`;
    wrapper.append(error);

    if (item.retryable) {
      const actions = document.createElement('div');
      actions.className = 'chatgoose-coach-failed-actions';
      actions.append(
        this.createCoachButton('Повторить', 'chatgoose-button-secondary', () =>
          this.callbacks.onCoachRetry?.(item.question, item.includedDraft, item.preset),
        ),
      );
      wrapper.append(actions);
    }

    // E81 (debugMode only): the stage log shows WHERE the turn died.
    if (item.profiling) {
      wrapper.append(this.createCoachDebugLogDetails(item.profiling));
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
    const mode = item.mode === 'full' ? 'Полный рекап' : 'Короткий рекап';
    const origin = item.origin === 'auto' ? 'авто' : 'вручную';
    const status =
      item.status === 'running' ? 'обновляется…' : item.status === 'done' ? 'обновлён' : 'не удался';
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

  private createCoachPendingNode(question: string): {
    wrapper: HTMLDivElement;
    answerText: Text;
    waitEl: HTMLDivElement;
    waitLabel: Text;
    waitElapsed: Text;
    answerEl: HTMLDivElement;
  } {
    const wrapper = document.createElement('div');
    wrapper.className = 'chatgoose-coach-exchange chatgoose-coach-pending';
    wrapper.setAttribute('aria-busy', 'true');
    wrapper.append(this.createCoachQuestionBubble(question));

    // E81 wait narration: stage label + elapsed counter live in the bubble
    // until the first streamed token swaps in the answer node (a class flip
    // in reconcileCoachPending — both nodes are built once, here).
    const waitEl = document.createElement('div');
    waitEl.className = 'chatgoose-coach-wait';
    waitEl.setAttribute('role', 'status');
    const waitLabelEl = document.createElement('span');
    waitLabelEl.className = 'chatgoose-coach-wait-label';
    const waitLabel = document.createTextNode('Думаю…');
    waitLabelEl.append(waitLabel);
    const waitElapsedEl = document.createElement('span');
    waitElapsedEl.className = 'chatgoose-coach-wait-elapsed';
    const waitElapsed = document.createTextNode('0 с');
    waitElapsedEl.append(waitElapsed);
    waitEl.append(waitLabelEl, waitElapsedEl);
    wrapper.append(waitEl);

    const answerEl = document.createElement('div');
    answerEl.className =
      'chatgoose-coach-answer chatgoose-coach-answer-streaming chatgoose-hidden';
    const answerText = document.createTextNode('');
    answerEl.append(answerText);
    wrapper.append(answerEl);
    return { wrapper, answerText, waitEl, waitLabel, waitElapsed, answerEl };
  }

  private createCoachEmptyState(view: CoachViewState): HTMLDivElement {
    const empty = document.createElement('div');
    empty.className = 'chatgoose-coach-empty';

    const heading = document.createElement('div');
    heading.className = 'chatgoose-coach-empty-heading';
    heading.textContent = 'Спроси коуча про этого фана';
    empty.append(heading);

    const context = document.createElement('div');
    context.className = 'chatgoose-coach-empty-context';
    context.textContent = 'Контекст подтянется сам: переписка, траты, рекап, персона модели';
    empty.append(context);

    // E80: Help lives INSIDE Coach now — the preset chip is the zero-typing
    // entry point. It DISPATCHES the kernel-owned situation turn (unlike the
    // hint chips below, which only prefill the composer).
    const preset = this.createCoachButton(
      COACH_SITUATION_PRESET_LABEL,
      'chatgoose-coach-hint chatgoose-coach-preset-chip',
      () => this.callbacks.onCoachPreset?.(),
    );
    empty.append(preset);

    // 9 hints in three labeled columns (spec §6); a click prefills the composer.
    const groups = document.createElement('div');
    groups.className = 'chatgoose-coach-empty-groups';
    for (const group of COACH_HINT_GROUPS) {
      const column = document.createElement('div');
      column.className = 'chatgoose-coach-empty-group';
      const label = document.createElement('div');
      label.className = 'chatgoose-coach-empty-group-label';
      label.textContent = group.label;
      column.append(label);
      for (const hint of group.hints) {
        const chip = this.createCoachButton(hint, 'chatgoose-coach-hint', () => {
          view.composerTextarea.value = hint;
          view.sendButton.disabled = view.composerTextarea.disabled || !hint.trim();
          this.autosizeCoachComposer(view.composerTextarea);
          this.callbacks.onCoachComposerInput?.(hint);
          view.composerTextarea.focus();
        });
        column.append(chip);
      }
      groups.append(column);
    }
    empty.append(groups);
    return empty;
  }

  /** The memory-window boundary divider (spec §8.1). */
  private createCoachMemoryDivider(): HTMLDivElement {
    const divider = document.createElement('div');
    divider.className = 'chatgoose-coach-memory-divider';
    const label = document.createElement('span');
    label.className = 'chatgoose-coach-memory-divider-label';
    label.textContent = 'выше — не входит в окно памяти коуча';
    divider.append(label);
    return divider;
  }

  /** The follow-up chips row (spec §8.3): a click SUBMITS the canned question. */
  private createCoachFollowups(): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'chatgoose-coach-followups';
    // E80: the situation preset is always one chip away mid-session too.
    wrap.append(
      this.createCoachButton(
        COACH_SITUATION_PRESET_LABEL,
        'chatgoose-coach-followup-chip chatgoose-coach-preset-chip',
        () => this.callbacks.onCoachPreset?.(),
      ),
    );
    for (const chip of COACH_FOLLOWUP_CHIPS) {
      wrap.append(
        this.createCoachButton(chip, 'chatgoose-coach-followup-chip', () => {
          // Normal submission (spec §8.3); the composer text is untouched.
          this.callbacks.onCoachSubmit?.(chip, 'canned');
        }),
      );
    }
    return wrap;
  }

  /** Position the memory-window divider (spec §8.1). Counts COMPLETED exchange
   * feed items only; renders iff that count exceeds `coachHistoryLimit`
   * (§7 snapshot); sits immediately before the oldest exchange of the last-N
   * tail. Derived from feed exchange identities — NOT completedExchanges.length,
   * which the 50-cap can trim while older exchanges stay visible. */
  private reconcileCoachMemoryDivider(view: CoachViewState, sv: CoachOverlaySessionView): void {
    const limit = sv.settingsSnapshot?.coachHistoryLimit;
    const exchangeKeys: string[] = [];
    sv.feedItems.forEach((item, index) => {
      if (item.kind === 'exchange') {
        exchangeKeys.push(this.coachFeedKey(item, index));
      }
    });
    const show = limit !== undefined && exchangeKeys.length > limit;
    const targetKey = show ? exchangeKeys[exchangeKeys.length - limit] : undefined;
    const targetNode = targetKey !== undefined ? view.itemNodes.get(targetKey) : undefined;
    if (!show || !targetNode) {
      if (view.memoryDividerNode) {
        view.memoryDividerNode.remove();
        view.memoryDividerNode = null;
      }
      return;
    }
    if (!view.memoryDividerNode) {
      view.memoryDividerNode = this.createCoachMemoryDivider();
    }
    if (targetNode.previousSibling !== view.memoryDividerNode) {
      view.itemsEl.insertBefore(view.memoryDividerNode, targetNode);
    }
  }

  /** Show the follow-up chips (spec §8.3) under the LATEST completed answer:
   * recap steps after an answer must NOT hide them (review P1 — an explicit
   * refresh used to bury the chips for good); only streaming or a NEWER failed
   * attempt suppresses (a failed question is retried, not followed up). */
  private reconcileCoachFollowups(
    view: CoachViewState,
    model: Extract<OverlayViewModel, { kind: 'coach' }>,
  ): void {
    const sv = model.sessionView;
    let anchor: CoachOverlayFeedItem | undefined;
    for (let i = sv.feedItems.length - 1; i >= 0; i -= 1) {
      const item = sv.feedItems[i]!;
      if (item.kind === 'recap-step') {
        continue;
      }
      anchor = item;
      break;
    }
    // Busy covers the submit PREFLIGHT too (review round 8): chips stayed
    // clickable in that window and a rejected click injected its canned text.
    const show =
      model.operationId === null && sv.composerEnabled && anchor?.kind === 'exchange';
    if (!show) {
      if (view.followupsNode) {
        view.followupsNode.remove();
        view.followupsNode = null;
      }
      return;
    }
    if (!view.followupsNode) {
      view.followupsNode = this.createCoachFollowups();
    }
    // Keep it the last child of the feed (directly under the newest exchange).
    if (view.feedEl.lastChild !== view.followupsNode) {
      view.feedEl.append(view.followupsNode);
    }
  }

  private createCoachDraftCard(
    exchangeOperationId: string,
    generationRef: string | undefined,
    draft: CoachOverlayDraft,
    allowCyrillic: boolean,
    caption?: string,
  ): HTMLElement {
    const card = document.createElement('div');
    card.className = 'chatgoose-card chatgoose-coach-draft';

    const title = document.createElement('div');
    // Mono micro-caps: ordinary turns say «Черновик»; the situation
    // preset may supply one of its two positional captions.
    title.className = 'chatgoose-card-title chatgoose-coach-draft-title';
    title.textContent = caption ?? (
      draft.index === 0 ? 'Черновик' : `Черновик ${draft.index + 1}`
    );

    const text = document.createElement('div');
    text.className = 'chatgoose-card-text';
    text.textContent = draft.text; // textContent — draft bodies are never HTML.

    const actions = document.createElement('div');
    actions.className = 'chatgoose-card-actions';

    const insert = document.createElement('button');
    insert.type = 'button';
    // «Вставить» clay-tinted (spec §2.1): clay-soft bg, clay-line border, clay-ink.
    insert.className = 'chatgoose-button chatgoose-coach-draft-insert';

    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'chatgoose-button chatgoose-button-secondary chatgoose-hidden';
    keep.textContent = 'Оставить мой';

    // Two-step inline confirm — NO browser dialog (window.confirm blocks the
    // extension). Insert into an empty composer is one click; replacing an
    // unsent draft arms a «Подтвердить замену» state first.
    let armed = false;
    const disarm = (): void => {
      armed = false;
      insert.classList.remove('chatgoose-coach-draft-armed');
      keep.classList.add('chatgoose-hidden');
      insert.textContent = getActiveConversationDraftText().trim() ? 'Заменить черновик…' : 'Вставить';
    };
    keep.addEventListener('click', () => disarm());
    // Moving focus away from an armed Replace abandons the confirm (outside
    // click / blur), so a stale «Подтвердить замену» never lingers.
    insert.addEventListener('blur', () => {
      if (armed) {
        disarm();
      }
    });
    insert.addEventListener('click', () => {
      const hasDraft = getActiveConversationDraftText().trim() !== '';
      if (hasDraft && !armed) {
        armed = true;
        insert.textContent = 'Подтвердить замену';
        insert.classList.add('chatgoose-coach-draft-armed');
        keep.classList.remove('chatgoose-hidden');
        return;
      }
      disarm();
      void this.acceptCoachDraft(exchangeOperationId, generationRef, draft, 'inserted', allowCyrillic);
    });
    insert.textContent = getActiveConversationDraftText().trim() ? 'Заменить черновик…' : 'Вставить';

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'chatgoose-button chatgoose-button-secondary';
    copy.textContent = 'Копировать';
    copy.addEventListener('click', () => {
      void this.acceptCoachDraft(exchangeOperationId, generationRef, draft, 'copied', allowCyrillic);
    });

    const blockedCyrillic = !allowCyrillic && COACH_DRAFT_CYRILLIC.test(draft.text);
    insert.disabled = blockedCyrillic;
    copy.disabled = blockedCyrillic;
    actions.append(insert, keep, copy);
    card.append(title, text);
    if (blockedCyrillic) {
      const note = document.createElement('div');
      note.className = 'chatgoose-inline-error';
      note.dataset.role = 'coach-draft-language-note';
      note.setAttribute('role', 'status');
      note.textContent = COACH_DRAFT_LANGUAGE_NOTE;
      card.append(note);
    }
    card.append(actions);
    return card;
  }

  /** Insert/Copy a draft, attributing acceptance to the CARD's exchange
   * operationId (spec §3) — NOT the session's live/top-level op. */
  private async acceptCoachDraft(
    exchangeOperationId: string,
    generationRef: string | undefined,
    draft: CoachOverlayDraft,
    action: 'inserted' | 'copied',
    allowCyrillic: boolean,
  ): Promise<void> {
    // Recheck at the side-effect boundary too: stale/cached cards and callers
    // bypassing a disabled control must not copy or insert Cyrillic drafts
    // for a fan who never wrote Cyrillic (E108).
    if (!allowCyrillic && COACH_DRAFT_CYRILLIC.test(draft.text)) return;
    try {
      if (action === 'inserted') {
        const expectedGroupId = this.model.kind === 'coach'
          ? this.model.sessionView.groupId
          : null;
        if (parseGroupIdFromPath(window.location.pathname) !== expectedGroupId) {
          throw new ChatGooseError('chat_changed');
        }
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
          this.createPartCard(model.feature === 'hi-greeting'
              ? `Variant ${part.sequenceIndex + 1}`
              : getReplyPartTitle(part, model.splitModeRequested), part, {
            ...getSplitPartCardOptions(part, model.splitModeRequested, model.parts.length),
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

    // E77: since kernel #201 the coaching text carries pinned block labels
    // (СИТУАЦИЯ/ЧТО УПУЩЕНО/СЛЕДУЮЩИЙ ХОД/РИСК) — render them as sections;
    // an unlabeled text (old cache, format slip) keeps the plain card.
    const structuredCoaching = model.coaching
      ? renderCoachingBlocks(model.coaching)
      : null;
    if (structuredCoaching) {
      section.append(structuredCoaching);
    } else {
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
    }

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
    // Wait for initial metadata so an early click cannot choose an older full
    // recap before learning about a newer short slot. An answered empty status
    // confirms nothing is stored; unavailable still permits local-cache lookup.
    if (!model.recapStatus || (model.recapStatus.state !== 'unavailable' && !hasStored)) {
      openLast.disabled = true;
    }
    actions.append(full, short, openLast);
    section.append(actions);
    if (model.recapStatus === null) {
      const loading = document.createElement('div');
      loading.className = 'chatgoose-recap-picker-status';
      loading.setAttribute('role', 'status');
      loading.textContent = 'Проверяю сохранённые рекапы…';
      section.append(loading);
    }

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
      // whole history was kept, else «последние N — история длиннее». Current
      // cache entries preserve this metadata; legacy entries simply omit it.
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
      // E77: since kernel #201 the evaluation carries pinned block labels
      // (ВЕРДИКТ/ДЕНЬГИ/ПЕРСОНА/ОШИБКИ/ЧТО РАБОТАЕТ) — render them as
      // sections. Recommendations follow the evaluation's format so a
      // pre-#201 result never renders half-old, half-new.
      const structuredEvaluation = model.reviewMeta.evaluation
        ? renderReviewEvaluation(model.reviewMeta.evaluation)
        : null;

      if (structuredEvaluation) {
        // E83: the structured Review re-voices as the recap document — the
        // evaluation and recommendations share one stream frame and read as
        // a single serif dossier instead of two bare card stacks.
        const doc = document.createElement('div');
        doc.className = 'chatgoose-stream chatgoose-review-doc';
        doc.append(structuredEvaluation);
        if (model.reviewMeta.recommendations) {
          doc.append(renderReviewRecommendations(model.reviewMeta.recommendations));
        }
        section.append(doc);
      } else if (model.reviewMeta.evaluation) {
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

      if (model.reviewMeta.recommendations && !structuredEvaluation) {
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

    if (model.profiling) {
      // Completed dossiers lead with their result. Keep the full diagnostic
      // snapshot one disclosure away; live progress and error diagnosis retain
      // their expanded render paths.
      const details = document.createElement('details');
      details.className = 'chatgoose-debug-inspector chatgoose-completed-profiling';
      const summary = document.createElement('summary');
      summary.className = 'chatgoose-debug-summary';
      summary.textContent = `Отладка · ${formatProfilingElapsed(model.profiling.elapsedMs)}`;
      details.append(summary, this.renderProfilingCard(model.profiling, 'summary'));
      section.append(details);
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
        model.recapMode,
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
    recapMode?: 'full' | 'short',
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
      rerun.addEventListener('click', () => {
        if (recapMode) {
          this.callbacks.onRerun(feature, recapMode);
        } else {
          this.callbacks.onRerun(feature);
        }
      });
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
      primary.textContent = 'Cost pending · Usage pending';
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
      usageDuration.textContent = 'usage';

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
      lines.push(`Other manifest fields: ${otherKeys.join(', ')}`);
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
