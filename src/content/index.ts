import contentStyles from './styles.css';
import { ButtonBar } from './button-bar.js';
import {
  createCoachSessionStore,
  type CoachSession,
  type CoachRecapStepFeedItem,
} from './coach-session.js';
import { getActiveConversationDisplayName, getActiveConversationDom } from './conversation-dom.js';
import { ConversationMountController } from './conversation-mount-controller.js';
import { installContentStyles } from './dom-anchor.js';
import { CompletedCompareCache } from './inline-panel/completed-compare-cache.js';
import { InlinePanelController } from './inline-panel/inline-panel-controller.js';
import { MappingBanner } from './mapping-banner.js';
import {
  CompletedOverlayCache,
  type CompletedOverlayCacheIdentity,
} from './overlay/completed-overlay-cache.js';
import { OverlayController } from './overlay/overlay-controller.js';
import { PortClient } from './port-client.js';
import { CheatsheetController } from './cheatsheet-controller.js';
import { BoardLauncher } from './spenders/board-launcher.js';
import { SpendersBoardController } from './spenders/spenders-board-controller.js';
import { startRouteWatcher } from './route-watcher.js';
import { captureScrollSnapshot, applyScrollCompensation } from './scroll-compensation.js';
import {
  planSurfaces,
  type SurfacePlan,
} from './surface-planner.js';
import { findActiveConversationTextarea } from './conversation-dom.js';
import { getActiveConversationDraftText, insertIntoFanslyTextarea } from './textarea.js';
import { ToastController } from './toast.js';
import { isEditableElement } from './ui/view-helpers.js';
import {
  buildHotkeyBindings,
  detectLabelPlatform,
  HOTKEY_FEATURE,
  type HotkeyAction,
} from '../shared/hotkeys.js';
import { createKeymap } from '../shared/keymap.js';
import { COACH_RECAP_FRESH_MS, SPENDERS_SPA_NAV_VERIFY_MS } from '../shared/constants.js';
import { parseCoachDrafts } from '../shared/coach-draft.js';
import { isRecapStatusResponse, sendRuntimeRequest } from '../shared/protocol.js';
import { projectDebugPromptEcho } from '../shared/kernel-context.js';
import {
  getCompareCardsFingerprintForPersonality,
} from '../shared/compare-cards.js';
import {
  createUserError,
  formatUserFacingError,
  getErrorMessage,
  isUserFacingError,
  toUserError,
} from '../shared/errors.js';
import {
  featureRequiresDraft,
  featureSupportsReplyMode,
  featureSupportsReplyTone,
  getFeaturePolicy,
  resolveFeatureModelFeature,
  usesInlineFeatureSurface,
  usesOverlayFeatureSurface,
} from '../shared/features.js';
import {
  normalizeProvidedReplyParts,
  normalizeReplyParts,
  normalizeSingleReplyPart,
  normalizeVariantReplyParts,
} from '../shared/reply-output.js';
import { loadStorageState } from '../shared/storage.js';
import { installUiTheme } from '../shared/theme.js';
import type {
  CoachAutoRecapOverride,
  CoachOverlayFeedItem,
  DebugPromptEchoStatus,
  LlmSpendSummary,
  BackgroundPortMessage,
  CompareInlineTabState,
  CompareInlineViewModel,
  CompletedOverlayViewModel,
  FanSummarySyncStatus,
  FeatureType,
  FeatureResult,
  OverlayInsertPart,
  OverlayViewModel,
  OperationProgressPayload,
  OperationProfilingSnapshot,
  OperationStartPayload,
  PromptDebugSnapshot,
  RecapStatusResponse,
  RecapSlot,
  ReplyMode,
  ReplyTone,
  TabUiState,
  UserErrorKey,
} from '../shared/types.js';

function createParts(parts: string[]): OverlayInsertPart[] {
  return parts.map((text, index) => ({
    id: `${index}-${text.slice(0, 12)}`,
    sequenceIndex: index,
    text,
    insertedAt: null,
    insertedOnce: false,
  }));
}

function resultPartTexts(
  feature: FeatureType,
  result: FeatureResult,
  rawText: string,
): string[] {
  if (Array.isArray(result.parts)) {
    return normalizeProvidedReplyParts(result.parts);
  }
  switch (getFeaturePolicy(feature).resultKind) {
    case 'single-reply':
      return normalizeSingleReplyPart(rawText);
    case 'reply':
      return feature === 'hi-greeting'
        ? normalizeVariantReplyParts(rawText)
        : normalizeReplyParts(rawText);
    // coach-chat: synthesizes no reply parts from raw text; any draft cards
    // arrive pre-split on result.parts (handled above), nothing to derive here.
    case 'help-me':
    case 'summary':
    case 'chat-review':
    case 'coach-chat':
      return [];
  }
}

function applyFanSummarySyncStatus(
  model: OverlayViewModel | CompletedOverlayViewModel | null,
  generatedAt: number,
  syncStatus: FanSummarySyncStatus,
): boolean {
  if (
    !model ||
    model.kind !== 'readOnly' ||
    model.feature !== 'fan-summary' ||
    model.summaryMeta?.generatedAt !== generatedAt
  ) {
    return false;
  }

  model.summaryMeta = {
    ...model.summaryMeta,
    syncStatus,
  };
  return true;
}

function getMessageLlmSpend(
  message: { llmSpend?: LlmSpendSummary },
): LlmSpendSummary | undefined {
  return message.llmSpend;
}

/** Coarse age label for the coach recap status line (spec §5 «Полный: 3 дн ·
 * Короткий: 10 мин»). A rough bucket is enough — the authoritative recap picker
 * lands in T11. */
function formatCoachRecapAge(ageMs: number): string {
  const minutes = Math.max(0, Math.floor(ageMs / 60_000));
  if (minutes < 60) {
    return `${minutes} мин`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ч`;
  }
  return `${Math.floor(hours / 24)} дн`;
}

/** The pre-formatted recap freshness line for the coach empty state (spec §5),
 * or '' when nothing is stored (the renderer hides the line on ''). */
function formatCoachRecapStatusLine(status: RecapStatusResponse | null): string {
  if (!status) {
    return '';
  }
  // Honest empty-state (E43): the Hub could not be REACHED (not connected, no
  // page match, Hub down/absent) — that is NOT "no recap". Surface it distinctly
  // so the chatter doesn't read a false «нет рекапа» and regenerate needlessly.
  if (status.state === 'unavailable') {
    return 'Рекап: не удалось проверить';
  }
  const parts: string[] = [];
  if (status.full) {
    parts.push(`Полный: ${formatCoachRecapAge(status.full.ageMs)}`);
  }
  if (status.short) {
    parts.push(`Короткий: ${formatCoachRecapAge(status.short.ageMs)}`);
  }
  return parts.join(' · ');
}

/** The auto-recap mode a session runs with: `inherit` defers to the setting. */
function resolveEffectiveAutoRecap(
  override: CoachAutoRecapOverride,
  setting: 'off' | 'short' | 'full',
): 'off' | 'short' | 'full' {
  return override === 'inherit' ? setting : override;
}

/** A slot is "fresh" when younger than the 24h staleness threshold (spec §5). */
function recapSlotFresh(slot: RecapSlot | null | undefined): boolean {
  return Boolean(slot && slot.ageMs <= COACH_RECAP_FRESH_MS);
}

/** Auto-recap mode matching (spec §5): a `short` request is satisfied by any
 * fresh short OR full recap; a `full` request only by a fresh full generated at
 * the CURRENT `deepMessageCount` (a full recap at a different window does not
 * count). Returns true when no auto-recap refresh is needed. */
function hasFreshMatchingRecap(
  status: RecapStatusResponse | null,
  mode: 'short' | 'full',
  deepMessageCount: number,
): boolean {
  if (!status) {
    return false;
  }
  if (mode === 'short') {
    return recapSlotFresh(status.short) || recapSlotFresh(status.full);
  }
  return recapSlotFresh(status.full) && status.full?.requestedCount === deepMessageCount;
}

/** «Открыть последний»: the mode of the freshest stored slot (spec §5), or null
 * when neither slot exists. Ties and full-only both resolve to full (the
 * durable primary recap). */
function pickFreshestSlotMode(status: RecapStatusResponse | null): 'short' | 'full' | null {
  if (!status) {
    return null;
  }
  const full = status.full;
  const short = status.short;
  if (full && short) {
    return short.ageMs < full.ageMs ? 'short' : 'full';
  }
  if (full) {
    return 'full';
  }
  if (short) {
    return 'short';
  }
  return null;
}

/** Age of the freshest stored slot (either mode), or null when none exists — the
 * «использую рекап от N назад» age for the auto-recap PROCEED note (spec §5). */
function freshestSlotAgeMs(status: RecapStatusResponse | null): number | null {
  if (!status) {
    return null;
  }
  const ages = [status.full?.ageMs, status.short?.ageMs].filter(
    (age): age is number => typeof age === 'number',
  );
  return ages.length > 0 ? Math.min(...ages) : null;
}

/** Auto-recap failure taxonomy (spec §5). A recap step that fails STOPS the
 * chain (question preserved in the composer) for the ENUMERATED categories —
 * user cancel / route change (both handled structurally), auth/credential/setup
 * failure, global quota exhaustion, and transcript-acquisition failure. Every
 * OTHER recap failure is a "recap-specific model failure or feature ceiling" and
 * PROCEEDS to the coach turn with the older/no recap (the default). The
 * extension cannot distinguish a per-feature ceiling from global quota (both are
 * `hub_quota_exceeded`), so quota is treated as the safe STOP branch. */
const RECAP_CHAIN_STOP_KEYS: ReadonlySet<UserErrorKey> = new Set<UserErrorKey>([
  // Auth / credential / setup — the coach turn cannot generate either.
  'not_connected',
  'session_expired',
  'missing_api_key',
  'invalid_api_key',
  'hub_missing_api_key',
  'hub_invalid_api_key',
  'hub_missing_permission',
  'hub_invalid_url',
  'no_mapping',
  'no_personalities',
  'hub_page_match_failed',
  'coach_fan_unresolved',
  'coach_requires_newer_hub',
  // Global quota exhaustion.
  'hub_quota_exceeded',
  // Transcript-acquisition failure (Fansly-side / network during pagination).
  'fansly_server_error',
  'network_error',
  'timed_out',
  // Context / route boundary.
  'chat_changed',
  'another_operation',
  'extension_reloaded',
]);

function classifyRecapChainFailure(errorKey: string): 'stop' | 'proceed' {
  return RECAP_CHAIN_STOP_KEYS.has(errorKey as UserErrorKey) ? 'stop' : 'proceed';
}

/** The topbar auto-recap override cycle order (spec §5 per-session control). */
const AUTO_RECAP_CYCLE: readonly CoachAutoRecapOverride[] = ['inherit', 'off', 'short', 'full'];

export class ChatGooseContentApp {
  private routeNonce = 0;
  private boardContextGeneration = 0;
  private currentGroupId: string | null = null;
  private tabState: TabUiState | null = null;
  private activeFeature: FeatureType | null = null;
  private activeOperationId: string | null = null;
  private activePersonaKey: string | null = null;
  private activePersonaDefinitionId: string | null = null;
  private activePersonaSource: string | null = null;
  private activeFanDisplayName: string | null = null;
  private activeDebugPrompt: PromptDebugSnapshot | null = null;
  /** E28: the kernel echo's fate + its viewer token. Closure-only, never DOM. */
  private activeDebugEcho: DebugPromptEchoStatus | null = null;
  private activeLlmSpend: LlmSpendSummary | null = null;
  private activeProfiling: OperationProfilingSnapshot | null = null;
  private activeProgress: OperationProgressPayload | null = null;
  private lastFeature: FeatureType | null = null;
  private nextFastReplyMode: ReplyMode = 'default';
  private nextReplyTone: ReplyTone = 'none';
  /** Tone the LAST fast-reply/compare was generated with — a Regenerate
   * re-rolls the same ask, so it reuses this when nothing new is armed
   * (E24; tones are one-shot, so nextReplyTone is already 'none' by then). */
  private lastSentReplyTone: ReplyTone = 'none';
  private hasSentInit = false;
  private overlayRawText = '';
  private activeCompareModel: CompareInlineViewModel | null = null;
  private comparePanelVisible = false;
  private pendingCompareFingerprint: string | null = null;

  // Inline quick surface state
  private quickSurfaceMode: 'inline' | 'overlay' = 'inline';
  private quickInlineVisible = false;
  private quickSurfaceEverOpened = false;
  private pendingLoadingFrame: number | null = null;
  private readonly suppressedTerminalOpIds = new Set<string>();
  private activeImproveDraftCacheKey: string | null = null;
  private observedDraftTextarea: HTMLTextAreaElement | null = null;
  private hasDraftText = false;
  // Deep feature overlay model (completed/error/cache-hit shown in overlay)
  private deepOverlayModel: OverlayViewModel | null = null;

  // ─── Coach (spec §3) ──────────────────────────────────────────────────────
  // The content script owns the coach dialog/feed/composer state; the store
  // holds an LRU of 5 per-fan sessions keyed by (creator account, group).
  private readonly coachStore = createCoachSessionStore();
  // The coach chat model rendered in the overlay, or null when Coach is closed.
  // A coach turn reuses the single active-op markers (`activeFeature` becomes
  // `'coach-chat'`, `activeOperationId` its op) so all existing route/persona/
  // cancel machinery applies unchanged; its RESULTS never touch overlayRawText,
  // buildCompletedOverlayModel, or CompletedOverlayCache (spec §10, carry-fwd 5/6).
  private coachOverlayModel: OverlayViewModel | null = null;
  // The open session, mirrored from the store for the lifetime of the overlay.
  private activeCoachSession: CoachSession | null = null;
  // The streamed answer of the in-flight coach turn, accumulated chunk-by-chunk
  // for the pending render only; the committed answer uses the completion's
  // authoritative rawText (never this) so a dropped/late chunk cannot corrupt it.
  private coachPendingAnswerText = '';
  // The standalone Recap start dialog (spec §5), or null when it is closed. Set
  // only while fully idle (openRecapPicker guards on another op); the planner
  // renders it above the idle surfaces and clears on any op start.
  private recapPickerModel: Extract<OverlayViewModel, { kind: 'recap-picker' }> | null = null;
  // An in-flight coach recap step (spec §5 orchestration): a fan-summary op that
  // runs INSIDE the coach feed as a visible recap-step, keeping the coach overlay
  // rendered (activeFeature is 'fan-summary', so the planner needs the chain flag
  // to keep coach on top). `pendingQuestion` is the auto-recap's held question,
  // auto-submitted after the step resolves; null for an explicit refresh.
  private coachRecapChain:
    | {
        operationId: string;
        session: CoachSession;
        step: CoachRecapStepFeedItem;
        origin: 'auto' | 'explicit';
        pendingQuestion: string | null;
      }
    | null = null;
  // Synchronous re-entrancy guard for submitCoachQuestion across its settings
  // await (the auto-recap decision needs live settings before arming anything).
  private coachSubmitInFlight = false;

  private readonly handleDraftInput = (): void => {
    const nextHasDraftText = this.computeHasDraftText();
    if (nextHasDraftText === this.hasDraftText) {
      return;
    }
    this.hasDraftText = nextHasDraftText;
    this.renderButtonBar();
  };

  private readonly toast = new ToastController();
  private readonly port = new PortClient({
    onMessage: (message) => this.handlePortMessage(message),
    onDisconnected: () => {
      this.showUserErrorToast(getErrorMessage('extension_reloaded'));
      this.completedOverlayCache.clearAll();
      this.completedCompareCache.clearAll();
      this.quickInlineVisible = false;
      this.comparePanelVisible = false;
      this.activeCompareModel = null;
      this.pendingCompareFingerprint = null;
      this.quickSurfaceMode = 'inline';
      this.suppressedTerminalOpIds.clear();
      this.detachDraftTextareaObserver();
      this.clearOperationState(true);
      this.resetNextFastReplyMode();
      this.resetNextReplyTone();
      this.renderAll();
    },
  });
  private readonly buttonBar = new ButtonBar({
    onFeatureClick: (feature) => {
      // The Recap button opens the start dialog (spec §5/§10), not an instant
      // generation; every other feature button starts its op directly.
      if (feature === 'fan-summary') {
        this.openRecapPicker();
        return;
      }
      this.startFeature(feature, false);
    },
    onCompareClick: () => {
      void this.startCompare(false);
    },
    onCompareRestoreClick: () => {
      void this.reopenCompletedCompare();
    },
    onReplyModeToggle: () => this.toggleNextFastReplyMode(),
    onToneSelect: (tone) => this.armReplyTone(tone),
    onCoachClick: () => this.openCoach(),
  });
  private readonly mappingBanner = new MappingBanner({
    onOpenSettings: () => {
      void browser.runtime.openOptionsPage();
    },
  });
  private readonly root = document.createElement('div');
  private readonly mountController: ConversationMountController;
  private readonly completedOverlayCache = new CompletedOverlayCache();
  private readonly completedCompareCache = new CompletedCompareCache();
  private readonly inlinePanel = new InlinePanelController({
    onAcceptance: (operationId, action, partIndex) => {
      this.port.send({ type: 'operation:acceptance', operationId, action, partIndex });
    },
    onClose: () => {
      if (this.activeCompareModel?.operationId) {
        this.comparePanelVisible = false;
      } else if (this.activeCompareModel) {
        this.comparePanelVisible = false;
        this.activeCompareModel = null;
      } else {
        this.quickInlineVisible = false;
      }
      this.renderAll();
    },
    onExpand: () => {
      if (this.activeCompareModel) {
        return;
      }
      this.quickSurfaceMode = 'overlay';
      this.renderSurfaces();
    },
    onCancel: (operationId) => {
      if (this.activeCompareModel?.operationId === operationId) {
        this.port.send({ type: 'compare:cancel', operationId });
        this.activeCompareModel = null;
        this.comparePanelVisible = false;
        this.pendingCompareFingerprint = null;
        this.completedCompareCache.clear(this.currentGroupId);
        this.renderAll();
        return;
      }
      this.port.send({ type: 'operation:cancel', operationId });
      this.quickInlineVisible = false;
      this.clearOperationState(true);
      this.renderAll();
    },
    onRerun: (feature) => {
      this.completedOverlayCache.clearFeature(this.currentGroupId, feature);
      this.startFeature(feature, true);
    },
    onCompareRerun: () => {
      this.completedCompareCache.clear(this.currentGroupId);
      void this.startCompare(true);
    },
    onCompareTabSelect: (cardId) => {
      const compareModel = this.activeCompareModel;
      if (!compareModel) {
        return;
      }
      compareModel.activeCardId = cardId;
      this.comparePanelVisible = true;
      this.renderSurfaces();
    },
  });
  private readonly overlay = new OverlayController({
    onAcceptance: (operationId, action, partIndex) => {
      this.port.send({ type: 'operation:acceptance', operationId, action, partIndex });
    },
    onOpenDebugPrompt: () => {
      void this.openDebugPromptViewer();
    },
    onClose: () => {
      // Esc/backdrop over the recap start dialog just cancels it (spec §5) — no
      // generation was started, nothing to tear down.
      if (this.recapPickerModel) {
        this.closeRecapPicker();
        this.renderAll();
        return;
      }
      // Idle coach close (Esc/backdrop while not streaming): retain the session
      // in the store for reopen (spec §3), just drop the overlay.
      if (this.coachOverlayModel && this.activeFeature !== 'coach-chat') {
        this.closeCoach();
        this.renderAll();
        return;
      }
      this.deepOverlayModel = null;
      if (
        !this.activeFeature ||
        !usesInlineFeatureSurface(this.activeFeature)
      ) {
        this.clearOperationState(true);
        // E24: Split is sticky — closing a surface disarms the tone only.
        this.resetNextReplyTone();
      }
      this.renderAll();
    },
    onCancel: (operationId) => {
      // A cancellable coach recap chain (spec §5): Esc/Cancel aborts the whole
      // chain, marks the recap step failed, and preserves the held question.
      if (this.coachRecapChain) {
        this.cancelCoachRecapChain();
        return;
      }
      // A streaming coach turn's Esc/Cancel cancels the turn but stays open,
      // recording a cancelled failed-attempt (carry-forward 3).
      if (this.activeFeature === 'coach-chat') {
        this.cancelCoachTurn();
        return;
      }
      this.port.send({ type: 'operation:cancel', operationId });
      this.quickInlineVisible = false;
      this.clearOperationState(true);
      this.resetNextReplyTone();
      this.renderAll();
    },
    onRerun: (feature) => {
      this.completedOverlayCache.clearFeature(this.currentGroupId, feature);
      this.startFeature(feature, true);
    },
    onCollapse: () => {
      this.quickSurfaceMode = 'inline';
      this.quickInlineVisible = true;
      this.renderSurfaces();
    },
    onCoachSubmit: (question) => {
      void this.submitCoachQuestion(question);
    },
    onCoachNewDialog: () => this.resetCoachSession(),
    onCoachRecap: (mode) => this.handleCoachRecap(mode),
    onCoachAutoRecapCycle: () => this.cycleCoachAutoRecapOverride(),
    onCoachRetry: (question) => {
      void this.handleCoachRetry(question);
    },
    onCoachComposerInput: (text) => this.handleCoachComposerInput(text),
    onRecapPick: (mode) => this.pickStandaloneRecap(mode),
    onRecapOpenLast: () => this.openLastRecap(),
  });

  private readonly hotkeyBindings = buildHotkeyBindings(detectLabelPlatform());
  private readonly keymap = createKeymap(this.hotkeyBindings);
  private readonly cheatsheet = new CheatsheetController(this.hotkeyBindings);
  private readonly board = new SpendersBoardController({
    fetchList: (refresh, buildId) =>
      sendRuntimeRequest('getSpendersList', { refresh, buildId }),
    getContextKey: () => {
      const accountId = this.tabState?.accountId;
      return accountId ? `${accountId}:${this.boardContextGeneration}` : null;
    },
    openChat: (groupId) => this.openFanChat(groupId),
    resolveChat: (entry) =>
      sendRuntimeRequest('resolveFanChat', {
        fanAccountId: entry.fanAccountId,
        username: entry.username,
        displayName: entry.displayName,
      }),
  });
  private readonly launcher = new BoardLauncher(() => this.board.toggle());

  constructor() {
    this.root.id = 'chatgoose-root';
    this.root.append(this.inlinePanel.root, this.buttonBar.root, this.mappingBanner.root);
    this.mountController = new ConversationMountController(this.root);
  }

  private showUserErrorToast(
    error: unknown,
    options?: {
      dedupeKey?: string;
      description?: string;
      tone?: 'info' | 'success' | 'warning' | 'error';
      durationMs?: number;
    },
  ): void {
    const userError = isUserFacingError(error) ? error : toUserError(error);
    this.toast.show(userError, {
      tone: options?.tone ?? 'error',
      dedupeKey: options?.dedupeKey,
      description: options?.description,
      durationMs: options?.durationMs,
      ...(userError.settingsLink
        ? {
            actionLabel: 'Settings',
            onAction: () => { void browser.runtime.openOptionsPage(); },
          }
        : {}),
    });
  }

  init(): void {
    installContentStyles(contentStyles);
    // Theme rides one class on <html>; resolved from settings + OS scheme,
    // kept live via storage.onChanged / matchMedia inside installUiTheme.
    // Never blocks boot: without readable settings it stays on the light
    // default.
    void loadStorageState()
      .then((state) => installUiTheme(state.settings.uiTheme))
      .catch(() => {});
    this.port.connect();
    startRouteWatcher((groupId) => this.handleRouteChange(groupId));
    this.installKeymap();
    this.launcher.mount();
  }

  // ─── Hotkeys ────────────────────────────────────────────────────────────

  private installKeymap(): void {
    document.addEventListener('keydown', (event) => {
      if (event.repeat) return;
      const action = this.keymap.resolve({
        key: event.key,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        inEditable: isEditableElement(document.activeElement),
      });
      if (action === null) return;
      // preventDefault only when we actually handle it, so an inapplicable
      // shortcut (e.g. an AI key with no conversation open) doesn't silently
      // swallow a browser default.
      if (this.dispatchHotkey(action)) {
        event.preventDefault();
      }
    });
  }

  private dispatchHotkey(action: HotkeyAction): boolean {
    const feature = HOTKEY_FEATURE[action];
    if (feature) {
      if (!this.currentGroupId) return false;
      this.startFeature(feature, false);
      return true;
    }
    switch (action) {
      case 'cycle-tone':
        this.cycleNextReplyTone();
        return true;
      case 'cancel':
        this.cancelActiveOperation();
        return true;
      case 'spenders-board':
        this.board.toggle();
        return true;
      case 'cheatsheet':
        this.cheatsheet.toggle();
        return true;
      case 'coach':
        // App action (spec §3): open/focus Coach. openCoach itself toasts when
        // the fan/group is unresolvable — the arm is ALWAYS handled so ⌘⇧C never
        // falls through to a browser default (carry-forward 1).
        this.openCoach();
        return true;
      case 'fan-summary':
        // App action (spec §5): opens the recap picker (T11). Handled here so
        // ⌘⇧S never falls through to the Firefox screenshot shortcut while the
        // picker is still pending (carry-forward 1).
        this.openRecapPicker();
        return true;
      default:
        return false;
    }
  }

  /** Open the standalone Recap start dialog (spec §5): Полный (focused; Enter
   * keeps the old ⌘⇧S+Enter muscle memory) / Короткий / «Открыть последний».
   * Creates NO generation (only the metadata-only recap-status read) until a
   * mode is picked. Handled always so ⌘⇧S never falls through to the Firefox
   * screenshot shortcut (carry-forward 1). */
  private openRecapPicker(): void {
    if (!this.currentGroupId) {
      return;
    }
    // A live op blocks the picker (it would race a second generation) — mirror
    // the other app actions and toast rather than silently swallowing ⌘⇧S.
    if (this.activeFeature || this.activeCompareModel?.operationId || this.coachRecapChain) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    // Taking over the overlay surface: drop any lingering completed surfaces so
    // the picker actually renders (mirrors openCoach's takeover).
    this.deepOverlayModel = null;
    this.quickInlineVisible = false;
    this.comparePanelVisible = false;
    if (this.activeCompareModel && !this.activeCompareModel.operationId) {
      this.activeCompareModel = null;
    }
    this.recapPickerModel = {
      kind: 'recap-picker',
      fanDisplayName: getActiveConversationDisplayName() ?? 'fan',
      recapStatus: null,
    };
    this.renderAll();
    // Metadata-only recap-status read (spec §5) — enables/labels «Открыть
    // последний»; best-effort, never blocks opening.
    void this.refreshRecapPickerStatus();
  }

  /** Close the recap start dialog (Esc/pick). */
  private closeRecapPicker(): void {
    this.recapPickerModel = null;
  }

  /** A picker pick (Полный / Короткий): close the dialog and start a fresh
   * recap generation. Standalone recaps are explicit refreshes — they bypass the
   * summary cache (forceRegenerate, spec §5) so the pick always regenerates. */
  private pickStandaloneRecap(mode: 'short' | 'full'): void {
    this.closeRecapPicker();
    this.startStandaloneRecap(mode);
  }

  /** Fire the metadata-only recap-status read for the OPEN picker (spec §5) and
   * fold both slots into its model. Best-effort. */
  private async refreshRecapPickerStatus(): Promise<void> {
    const groupId = this.currentGroupId;
    const picker = this.recapPickerModel;
    if (!groupId || !picker) {
      return;
    }
    try {
      const status = await sendRuntimeRequest('getRecapStatus', {
        groupId,
        fanAccountId: null,
      });
      if (!isRecapStatusResponse(status) || this.recapPickerModel !== picker) {
        return;
      }
      this.recapPickerModel = { ...picker, recapStatus: status };
      this.renderSurfaces();
    } catch {
      // Best-effort — the picker just leaves «Открыть последний» disabled.
    }
  }

  /** Start a standalone recap generation (spec §5) rendered via the normal
   * fan-summary overlay path. Always regenerates (explicit refresh bypasses the
   * cache). Reused by both the picker picks and the ⌘⇧S+Enter muscle memory. */
  private startStandaloneRecap(mode: 'short' | 'full'): void {
    if (this.activeFeature || this.activeCompareModel?.operationId || this.coachRecapChain) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    if (!this.ensureFeatureCanStart('fan-summary')) {
      return;
    }
    const operationId = crypto.randomUUID();
    const domFanDisplayName = getActiveConversationDisplayName();
    this.initializeFeatureOperation('fan-summary', operationId, domFanDisplayName, undefined);
    const payload: OperationStartPayload = {
      ...this.buildOperationStartPayload('fan-summary', operationId, domFanDisplayName, undefined, true),
      summaryMode: mode,
    };
    const sent = this.port.send(payload);
    if (!sent) {
      this.clearOperationState(true);
      this.showUserErrorToast(getErrorMessage('extension_reloaded'));
      this.renderSurfaces();
      this.renderButtonBar();
      return;
    }
    this.renderButtonBar();
  }

  /** «Открыть последний» (spec §5): view the freshest STORED recap without any
   * generation. Dispatches a view-cached-only fan-summary (background serves the
   * local cache or fails with `no_saved_recap`, which surfaces as a toast). The
   * mode is the freshest stored slot; when neither slot exists we toast without
   * even sending the op. */
  private openLastRecap(): void {
    const status = this.recapPickerModel?.recapStatus ?? this.activeCoachSession?.recapStatus ?? null;
    this.closeRecapPicker();
    let mode: 'short' | 'full';
    if (status) {
      const picked = pickFreshestSlotMode(status);
      if (picked === null) {
        // Status is loaded and empty — no round-trip needed, just toast.
        this.showUserErrorToast(getErrorMessage('no_saved_recap'));
        this.renderAll();
        return;
      }
      mode = picked;
    } else {
      // Status unknown (read pending/failed): let the background be the source
      // of truth — attempt the durable full recap; a real miss 404s to a toast.
      mode = 'full';
    }
    if (this.activeFeature || this.activeCompareModel?.operationId || this.coachRecapChain) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    if (!this.ensureFeatureCanStart('fan-summary')) {
      return;
    }
    const operationId = crypto.randomUUID();
    const domFanDisplayName = getActiveConversationDisplayName();
    this.initializeFeatureOperation('fan-summary', operationId, domFanDisplayName, undefined);
    const payload: OperationStartPayload = {
      ...this.buildOperationStartPayload('fan-summary', operationId, domFanDisplayName, undefined, false),
      viewCachedOnly: true,
      ...(mode === 'short' ? { summaryMode: 'short' as const } : {}),
    };
    const sent = this.port.send(payload);
    if (!sent) {
      this.clearOperationState(true);
      this.showUserErrorToast(getErrorMessage('extension_reloaded'));
      this.renderSurfaces();
      this.renderButtonBar();
      return;
    }
    this.renderButtonBar();
  }

  private cycleNextReplyTone(): void {
    if (this.activeFeature || this.activeCompareModel?.operationId) return;
    // Mirrors the bar's tone groove (😌 Casual / 😏 Flirt / 💰 Sell / 🔥 Spice)
    // so the cycle and the visible segments stay in lock-step — casual
    // returned to the bar in E24.
    const order: ReplyTone[] = ['none', 'casual', 'flirty', 'upsell', 'spicy'];
    const index = order.indexOf(this.nextReplyTone);
    this.nextReplyTone = order[(index + 1) % order.length]!;
    this.renderButtonBar();
  }

  private cancelActiveOperation(): void {
    // A coach recap chain is cancellable as a whole (spec §5) — before the
    // generic coach/feature paths, since its op rides `activeFeature`='fan-summary'.
    if (this.coachRecapChain) {
      this.cancelCoachRecapChain();
      return;
    }
    if (this.activeFeature === 'coach-chat') {
      this.cancelCoachTurn();
      return;
    }
    if (this.activeCompareModel?.operationId) {
      this.port.send({ type: 'compare:cancel', operationId: this.activeCompareModel.operationId });
      this.activeCompareModel = null;
      this.comparePanelVisible = false;
      this.pendingCompareFingerprint = null;
      this.completedCompareCache.clear(this.currentGroupId);
      this.renderAll();
      return;
    }
    if (this.activeFeature && this.activeOperationId) {
      // Mirror the surface's own cancel: overlay features reset mode/tone (see
      // overlay.onCancel), inline features keep them (see inlinePanel.onCancel).
      const isOverlayFeature = usesOverlayFeatureSurface(this.activeFeature);
      this.port.send({ type: 'operation:cancel', operationId: this.activeOperationId });
      this.quickInlineVisible = false;
      this.clearOperationState(true);
      if (isOverlayFeature) {
        // E24: Split is sticky — cancelling disarms the tone only.
        this.resetNextReplyTone();
      }
      this.renderAll();
    }
  }

  // Opening a chat from the board rides Fansly's own SPA router (pushState +
  // popstate is what Angular's Location listens for) instead of a full page
  // load. The send surface is untouched — this only routes to the NATIVE
  // chat faster. Because a router that ignored the popstate leaves the URL
  // and the view disagreeing (which would also poison our route tracking),
  // the navigation is verified and falls back to a hard load.
  private openFanChat(groupId: string): void {
    this.board.close();
    if (this.currentGroupId === groupId) return;
    const target = `/messages/${groupId}`;
    const before = getActiveConversationDom();
    try {
      window.history.pushState(null, '', target);
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    } catch {
      window.location.assign(target);
      return;
    }
    window.setTimeout(() => {
      // The user may have navigated elsewhere meanwhile — never hijack that.
      if (window.location.pathname !== target) return;
      const after = getActiveConversationDom();
      // From no-conversation: any conversation appearing = success. From
      // conversation A: Angular may reuse the component, so a replaced
      // container OR a changed header name counts (two fans with the same
      // display name would false-trigger one hard load — today's behavior).
      const navigated = before === null
        ? after !== null
        : after !== null &&
          (after.container !== before.container || after.displayName !== before.displayName);
      if (!navigated) {
        window.location.assign(target);
      }
    }, SPENDERS_SPA_NAV_VERIFY_MS);
  }

  // ─── Surface Rendering ──────────────────────────────────────────────

  private renderButtonBar(): void {
    this.syncDraftTextareaObserver();
    const activeAction =
      this.activeCompareModel?.operationId
        ? 'compare'
        : this.activeFeature;
    const activeLoading = Boolean(
      this.activeCompareModel?.operationId ||
      (this.activeFeature !== null && this.activeOperationId !== null),
    );
    this.buttonBar.render(
      this.tabState,
      activeAction,
      this.nextFastReplyMode,
      this.nextReplyTone,
      this.hasDraftText,
      activeLoading,
      this.hasRestorableCompletedCompare(),
    );
  }

  private renderAll(): void {
    this.renderSurfaces();
    this.renderButtonBar();
  }

  private renderSurfaces(): void {
    this.cancelScheduledLoadingRender();

    const scrollSnapshot = captureScrollSnapshot(this.root);
    try {
      this.applySurfacePlan(planSurfaces({
        activeFeature: this.activeFeature,
        activeLoadingModel: this.activeFeature
          ? this.buildActiveLoadingModel()
          : null,
        activeRegenerableLoadingModel: this.activeFeature
          ? this.buildActiveLoadingModel({ canRegenerate: true })
          : null,
        activeCompareModel: this.activeCompareModel,
        comparePanelVisible: this.comparePanelVisible,
        quickSurfaceMode: this.quickSurfaceMode,
        quickInlineVisible: this.quickInlineVisible,
        cachedInlineModel: this.getCachedInlineModelForCurrentState(),
        deepOverlayModel: this.deepOverlayModel,
        coachOverlayModel: this.coachOverlayModel,
        coachRecapChainActive: this.coachRecapChain !== null,
        recapPickerModel: this.recapPickerModel,
      }));
    } finally {
      applyScrollCompensation(this.root, scrollSnapshot);
    }
  }

  private getCachedInlineModelForCurrentState(): CompletedOverlayViewModel | null {
    if (
      !this.quickInlineVisible ||
      !this.lastFeature ||
      !usesInlineFeatureSurface(this.lastFeature)
    ) {
      return null;
    }

    return this.completedOverlayCache.get(
      this.currentGroupId,
      this.lastFeature,
      this.overlayCacheIdentity(
        this.buildFeatureCacheKey(
          this.lastFeature,
          featureRequiresDraft(this.lastFeature)
            ? getActiveConversationDraftText()
            : undefined,
        ),
      ),
    );
  }

  private overlayCacheIdentity(
    variantKey: string | null | undefined,
    personaKey = this.tabState?.mappedPersonalityId ?? null,
    personaDefinitionId = this.tabState?.mappedPersonaDefinitionId ?? null,
    personaSource = this.tabState?.mappedPersonaSource ?? null,
  ): CompletedOverlayCacheIdentity {
    return {
      personaKey,
      personaDefinitionId,
      personaSource,
      variantKey: variantKey ?? null,
    };
  }

  private applySurfacePlan(plan: SurfacePlan): void {
    if (plan.inline.kind === 'hidden') {
      this.inlinePanel.hide();
    }

    if (plan.overlay.kind === 'hidden') {
      this.overlay.render(plan.overlay.model);
    } else if (plan.overlay.dismissMode) {
      this.overlay.render(plan.overlay.model, { dismissMode: plan.overlay.dismissMode });
    } else {
      this.overlay.render(plan.overlay.model);
    }

    if (plan.inline.kind === 'render') {
      this.inlinePanel.render(plan.inline.model);
    }

    if (plan.resetQuickSurfaceMode) {
      this.quickSurfaceMode = 'inline';
    }
  }

  private buildActiveLoadingModel(options?: { canRegenerate?: boolean }): OverlayViewModel {
    return {
      kind: 'loading',
      feature: this.activeFeature!,
      fanDisplayName: this.currentFanDisplayName(),
      progress: this.activeProgress,
      rawText: this.overlayRawText,
      debugPrompt: this.activeDebugPrompt ?? undefined,
      debugEcho: this.activeDebugEcho ?? undefined,
      llmSpend: this.activeLlmSpend ?? undefined,
      profiling: this.activeProfiling ?? undefined,
      canCancel: true,
      canRegenerate: options?.canRegenerate ?? false,
      operationId: this.activeOperationId!,
    };
  }

  private scheduleLoadingRender(): void {
    if (this.pendingLoadingFrame !== null) return;
    const capturedOpId = this.activeOperationId;
    const capturedCompareOpId = this.activeCompareModel?.operationId ?? null;
    const capturedNonce = this.routeNonce;
    this.pendingLoadingFrame = requestAnimationFrame(() => {
      this.pendingLoadingFrame = null;
      if (
        this.activeOperationId !== capturedOpId ||
        (this.activeCompareModel?.operationId ?? null) !== capturedCompareOpId ||
        this.routeNonce !== capturedNonce
      ) return;
      this.renderSurfaces();
    });
  }

  private cancelScheduledLoadingRender(): void {
    if (this.pendingLoadingFrame !== null) {
      cancelAnimationFrame(this.pendingLoadingFrame);
      this.pendingLoadingFrame = null;
    }
  }

  private buildFeatureCacheKey(
    feature: FeatureType,
    draftText: string | undefined,
  ): string | undefined {
    if (!featureRequiresDraft(feature)) {
      return undefined;
    }
    return this.buildImproveDraftCacheKey(draftText) ?? undefined;
  }

  private restoreCachedFeatureResult(
    feature: FeatureType,
    cachedResult: CompletedOverlayViewModel,
  ): void {
    this.lastFeature = feature;
    if (featureRequiresDraft(feature) && cachedResult.kind === 'reply') {
      void this.applyImproveDraftResult(cachedResult);
      return;
    }
    if (usesInlineFeatureSurface(feature)) {
      this.quickInlineVisible = true;
      this.quickSurfaceMode = 'inline';
    } else {
      this.deepOverlayModel = cachedResult;
    }
    this.renderSurfaces();
  }

  private ensureFeatureCanStart(feature: FeatureType): boolean {
    if (!this.tabState) {
      return false;
    }

    if (!this.isApiKeyReadyForFeature(feature)) {
      this.showUserErrorToast(this.getMissingApiKeyError(feature));
      return false;
    }
    if (!this.tabState.hasPersonalities) {
      this.showUserErrorToast(getErrorMessage('no_personalities'));
      return false;
    }
    if (!this.tabState.mappedPersonalityId) {
      this.showUserErrorToast(getErrorMessage('no_mapping'));
      return false;
    }
    if (!this.tabState.connected) {
      this.showUserErrorToast(getErrorMessage('not_connected'));
      return false;
    }
    if (featureRequiresDraft(feature) && !this.computeHasDraftText()) {
      this.toast.show('Write a draft in the composer first, then use Fix.', {
        tone: 'warning',
      });
      this.renderButtonBar();
      return false;
    }

    return true;
  }

  private isApiKeyReadyForFeature(feature: FeatureType): boolean {
    const modelFeature = resolveFeatureModelFeature(feature);
    return this.tabState?.apiKeyReadyByFeature?.[modelFeature] ??
      this.tabState?.hasApiKey ??
      false;
  }

  private getMissingApiKeyError(feature: FeatureType): ReturnType<typeof getErrorMessage> {
    const modelFeature = resolveFeatureModelFeature(feature);
    const provider = this.tabState?.modelProviderByFeature?.[modelFeature];
    if (provider === 'openrouter') {
      return toUserError({
        key: 'missing_api_key',
        details: { provider },
      });
    }

    return getErrorMessage('missing_api_key');
  }

  private getCompareMissingApiKeyError(): ReturnType<typeof getErrorMessage> {
    const provider = this.tabState?.modelProviderByFeature?.['fast-reply'];
    if (provider === 'openrouter') {
      return toUserError({
        key: 'missing_api_key',
        details: { provider },
      });
    }

    return getErrorMessage('missing_api_key');
  }

  private buildOperationStartPayload(
    feature: FeatureType,
    operationId: string,
    domFanDisplayName: string | null,
    draftText: string | undefined,
    forceRegenerate: boolean,
  ): OperationStartPayload {
    return {
      type: 'operation:start',
      operationId,
      feature,
      groupId: this.currentGroupId,
      routeNonce: this.routeNonce,
      domFanDisplayName,
      draftText,
      forceRegenerate,
      replyMode: featureSupportsReplyMode(feature)
        ? this.nextFastReplyMode
        : undefined,
      replyTone: featureSupportsReplyTone(feature)
        ? this.resolveReplyToneForSend(forceRegenerate)
        : undefined,
    };
  }

  /** The tone a generation should ride: the armed one, or — on a Regenerate
   * with nothing armed — the tone the original was generated with. */
  private resolveReplyToneForSend(forceRegenerate: boolean): ReplyTone {
    if (this.nextReplyTone !== 'none') {
      return this.nextReplyTone;
    }
    return forceRegenerate ? this.lastSentReplyTone : 'none';
  }

  private initializeFeatureOperation(
    feature: FeatureType,
    operationId: string,
    domFanDisplayName: string | null,
    improveDraftCacheKey: string | undefined,
  ): void {
    this.cancelScheduledLoadingRender();
    this.activeDebugPrompt = null;
    this.activeDebugEcho = null;
    this.activeLlmSpend = null;
    this.activeProfiling = null;
    this.activeProgress = null;
    this.activeFeature = feature;
    this.activeOperationId = operationId;
    this.activePersonaKey = this.tabState?.mappedPersonalityId ?? null;
    this.activePersonaDefinitionId = this.tabState?.mappedPersonaDefinitionId ?? null;
    this.activePersonaSource = this.tabState?.mappedPersonaSource ?? null;
    this.activeFanDisplayName = domFanDisplayName ?? 'fan';
    this.lastFeature = feature;
    this.overlayRawText = '';
    this.activeImproveDraftCacheKey = improveDraftCacheKey ?? null;
    this.comparePanelVisible = false;

    if (usesInlineFeatureSurface(feature)) {
      this.quickInlineVisible = false;
      this.quickSurfaceEverOpened = false;
      this.quickSurfaceMode = 'inline';
    }

    this.renderSurfaces();
  }

  private presentCompletedFeature(
    feature: FeatureType,
    completedModel: CompletedOverlayViewModel,
  ): void {
    if (featureRequiresDraft(feature)) {
      this.clearOperationState(false);
      if (completedModel.kind === 'reply') {
        void this.applyImproveDraftResult(completedModel);
      } else {
        this.renderAll();
      }
      return;
    }

    if (usesInlineFeatureSurface(feature)) {
      if (!this.quickSurfaceEverOpened) {
        this.quickInlineVisible = true;
      }
      this.clearOperationState(false);
    } else {
      this.deepOverlayModel = completedModel;
      this.clearOperationState(false);
    }
    this.renderAll();
  }

  private presentOperationError(
    feature: FeatureType,
    errorModel: OverlayViewModel,
    error: unknown,
  ): void {
    if (usesInlineFeatureSurface(feature)) {
      this.cancelScheduledLoadingRender();
      if (this.quickSurfaceMode === 'overlay') {
        this.overlay.render(errorModel, { dismissMode: 'close' });
      } else if (this.quickInlineVisible) {
        this.inlinePanel.render(errorModel);
      } else {
        this.showUserErrorToast(error);
      }
      this.clearOperationState(false);
      this.renderButtonBar();
      return;
    }

    this.deepOverlayModel = errorModel;
    this.clearOperationState(false);
    this.renderAll();
  }

  // ─── Feature Lifecycle ──────────────────────────────────────────────

  private startFeature(feature: FeatureType, forceRegenerate: boolean): void {
    if (this.activeFeature === feature) {
      if (usesInlineFeatureSurface(feature) && !featureRequiresDraft(feature)) {
        if (
          !this.quickInlineVisible &&
          !this.isTerminalOperationSuppressed(this.activeOperationId)
        ) {
          this.quickInlineVisible = true;
          this.renderSurfaces();
        }
      }
      return;
    }

    if (this.activeFeature || this.activeCompareModel?.operationId) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }

    // An idle open coach yields to any other feature (spec §3): close it,
    // retaining the session in the store for reopen. The standalone Recap dialog
    // is likewise superseded.
    if (this.coachOverlayModel) {
      this.closeCoach();
    }
    this.recapPickerModel = null;

    this.comparePanelVisible = false;
    if (this.activeCompareModel && !this.activeCompareModel.operationId) {
      this.activeCompareModel = null;
    }

    const draftText = featureRequiresDraft(feature)
      ? getActiveConversationDraftText().trim()
      : undefined;
    const improveDraftCacheKey = this.buildFeatureCacheKey(feature, draftText);

    const cachedResult =
      !forceRegenerate
        ? this.completedOverlayCache.get(
            this.currentGroupId,
            feature,
            this.overlayCacheIdentity(improveDraftCacheKey),
          )
        : null;
    if (cachedResult) {
      this.restoreCachedFeatureResult(feature, cachedResult);
      return;
    }

    if (!this.ensureFeatureCanStart(feature)) {
      return;
    }

    const operationId = crypto.randomUUID();
    const domFanDisplayName = getActiveConversationDisplayName();
    this.initializeFeatureOperation(
      feature,
      operationId,
      domFanDisplayName,
      improveDraftCacheKey,
    );

    const payload = this.buildOperationStartPayload(
      feature,
      operationId,
      domFanDisplayName,
      draftText,
      forceRegenerate,
    );
    const sent = this.port.send(payload);
    if (!sent) {
      // The port is mid-reconnect; the start never reached the background, so
      // no terminal message will arrive. Tear down the loading state and ask
      // the user to retry instead of leaving the surface stuck spinning.
      this.clearOperationState(true);
      this.showUserErrorToast(getErrorMessage('extension_reloaded'));
      this.renderSurfaces();
      this.renderButtonBar();
      return;
    }
    // E24: Split (replyMode) is a sticky flag — it survives generations and
    // only its own click turns it off. Tones stay one-shot: consumed by this
    // send, remembered for a potential Regenerate of the same ask.
    if (featureSupportsReplyTone(feature)) {
      this.lastSentReplyTone = payload.replyTone ?? 'none';
      this.resetNextReplyTone();
    }
    this.renderButtonBar();
  }

  private async startCompare(forceRegenerate: boolean): Promise<void> {
    if (this.activeCompareModel?.operationId) {
      if (
        !this.comparePanelVisible &&
        !this.isTerminalOperationSuppressed(this.activeCompareModel.operationId)
      ) {
        this.comparePanelVisible = true;
        this.renderSurfaces();
      }
      return;
    }

    if (this.activeFeature) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }

    // An idle open coach yields to Compare too (spec §3), session retained.
    if (this.coachOverlayModel) {
      this.closeCoach();
    }

    if (!this.tabState) {
      return;
    }
    if (!this.isApiKeyReadyForFeature('fast-reply')) {
      this.showUserErrorToast(this.getCompareMissingApiKeyError());
      return;
    }
    if (!this.tabState.connected) {
      this.showUserErrorToast(getErrorMessage('not_connected'));
      return;
    }
    if (this.tabState.compareCardCount < 2) {
      this.showUserErrorToast(getErrorMessage('compare_cards_unavailable'));
      return;
    }

    const fingerprint = await this.computeCompareFingerprint();
    const operationId = crypto.randomUUID();
    const domFanDisplayName = getActiveConversationDisplayName();
    this.cancelScheduledLoadingRender();
    this.completedCompareCache.clear(this.currentGroupId);
    this.pendingCompareFingerprint = fingerprint;
    this.activeCompareModel = {
      kind: 'compare',
      fanDisplayName: domFanDisplayName ?? 'fan',
      operationId,
      tabs: [],
      activeCardId: null,
      progress: null,
      canCancel: true,
      canRegenerate: false,
    };
    this.quickInlineVisible = false;
    this.comparePanelVisible = false;
    this.renderButtonBar();

    const compareReplyTone = this.resolveReplyToneForSend(forceRegenerate);
    const sent = this.port.send({
      type: 'compare:start',
      operationId,
      groupId: this.currentGroupId,
      routeNonce: this.routeNonce,
      domFanDisplayName,
      forceRegenerate,
      replyMode: this.nextFastReplyMode,
      replyTone: compareReplyTone,
    });
    if (!sent) {
      // The port is mid-reconnect; the compare start was dropped, so tear down
      // the pending compare surface and ask the user to retry.
      this.activeCompareModel = null;
      this.pendingCompareFingerprint = null;
      this.showUserErrorToast(getErrorMessage('extension_reloaded'));
      this.renderSurfaces();
      this.renderButtonBar();
      return;
    }
    // E24: Split stays armed (sticky flag); the tone is consumed + remembered.
    this.lastSentReplyTone = compareReplyTone;
    this.resetNextReplyTone();
  }

  private async reopenCompletedCompare(): Promise<void> {
    await this.restoreCompletedComparePanelInternal(true);
  }

  private toggleNextFastReplyMode(): void {
    if (this.activeFeature || this.activeCompareModel?.operationId) {
      return;
    }
    this.nextFastReplyMode = this.nextFastReplyMode === 'preferSplit' ? 'default' : 'preferSplit';
    this.renderButtonBar();
  }

  private resetNextFastReplyMode(): void {
    this.nextFastReplyMode = 'default';
  }

  private armReplyTone(tone: ReplyTone): void {
    if (this.activeFeature || this.activeCompareModel?.operationId) return;
    // Options model (E24): a tone segment ARMS the next Reply — the only
    // trigger is Reply itself. Clicking the armed segment disarms it. The
    // pre-E24 one-shot (click = immediate generation) is gone on purpose:
    // tones and Split now share one toggle model.
    this.nextReplyTone = this.nextReplyTone === tone ? 'none' : tone;
    this.renderButtonBar();
  }

  private resetNextReplyTone(): void {
    this.nextReplyTone = 'none';
  }

  // ─── Route ──────────────────────────────────────────────────────────

  private handleRouteChange(groupId: string | null): void {
    const changed = this.currentGroupId !== groupId;
    const previousGroupId = this.currentGroupId;
    this.routeNonce += 1;
    this.currentGroupId = groupId;
    if (changed) {
      // The regen-tone memo is per-conversation — never bleed a tone from
      // one fan's chat into a Regenerate in another's.
      this.lastSentReplyTone = 'none';
    }
    this.completedOverlayCache.setActiveGroup(groupId);
    this.completedCompareCache.setActiveGroup(groupId);
    this.mountController.setActiveRoute(groupId);

    if (changed) {
      this.pendingCompareFingerprint = null;
      // Coach sessions survive fan switches (LRU keyed): close the overlay and
      // preserve the pending question into the composer (spec §8). A streaming
      // coach op is torn down by the overlay-feature suppression branch below,
      // since `coach-chat` rides `usesOverlayFeatureSurface`.
      this.closeCoachOnRouteChange();
      if (
        this.activeFeature &&
        usesInlineFeatureSurface(this.activeFeature)
      ) {
        this.quickInlineVisible = false;
        this.quickSurfaceMode = 'inline';
        this.suppressTerminalOperation(this.activeOperationId);
        this.clearOperationState(true);
        this.overlayRawText = '';
        this.renderSurfaces();
      } else if (this.activeCompareModel?.operationId) {
        this.comparePanelVisible = false;
        this.suppressTerminalOperation(this.activeCompareModel.operationId);
        this.activeCompareModel = null;
        this.completedCompareCache.clear(previousGroupId);
        this.renderSurfaces();
      } else if (
        this.activeFeature &&
        usesOverlayFeatureSurface(this.activeFeature)
      ) {
        // An overlay feature (Scan/Summary/Review/Help) is in flight: suppress
        // its terminal message so the previous fan's result is neither shown
        // over the new conversation nor cached/marked under the new group.
        // handleComplete/handleOperationError consume suppressed terminal ids
        // before touching the cache or hasAvailableSummary.
        this.suppressTerminalOperation(this.activeOperationId);
        this.clearOperationState(true);
        this.overlayRawText = '';
        this.renderSurfaces();
      } else if (!this.activeFeature) {
        this.quickInlineVisible = false;
        this.comparePanelVisible = false;
        this.deepOverlayModel = null;
        this.activeCompareModel = null;
        this.clearOperationState(true);
        this.overlayRawText = '';
        this.renderSurfaces();
      }
    }

    if (!this.hasSentInit) {
      this.port.send({ type: 'tab:init', groupId, routeNonce: this.routeNonce });
      this.hasSentInit = true;
    } else {
      this.port.send({ type: 'tab:routeChanged', groupId, routeNonce: this.routeNonce });
    }

    this.renderButtonBar();
  }

  // ─── Coach (spec §3) ────────────────────────────────────────────────

  /** Open (or focus) the coach chat overlay. Creates NO generation and incurs
   * NO AI spend — it only fires the metadata-only recap-status read (spec §3
   * invariant). */
  openCoach(): void {
    // Already streaming or idle-open: just re-render to focus (spec §3 "focus if
    // open"); the renderer preserves composer caret/scroll.
    if (this.activeFeature === 'coach-chat' || this.activeCoachSession) {
      this.rebuildCoachModel();
      this.renderSurfaces();
      return;
    }
    // Coach is a single active operation like any other (spec §3): another op in
    // flight blocks opening.
    if (this.activeFeature || this.activeCompareModel?.operationId) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    const accountId = this.tabState?.accountId ?? null;
    const groupId = this.currentGroupId;
    if (!accountId || !groupId) {
      this.showUserErrorToast(getErrorMessage('coach_fan_unresolved'));
      return;
    }
    // Opening Coach supersedes the standalone Recap dialog if it is up.
    this.recapPickerModel = null;
    // Opening Coach as a distinct app action TAKES OVER the overlay surface —
    // mirror startFeature so the coach overlay wins over a cached inline result
    // or a completed compare panel too. Both sit ABOVE the idle-coach floor in
    // the planner, so without this openCoach would set all coach state yet
    // render nothing (a LIVE compare op was already blocked above; only a
    // completed, operationId-null compare model can linger here).
    this.deepOverlayModel = null;
    this.quickInlineVisible = false;
    this.comparePanelVisible = false;
    if (this.activeCompareModel && !this.activeCompareModel.operationId) {
      this.activeCompareModel = null;
    }
    // getOrCreate touches this session as most-recently-used. LRU eviction of a
    // session with a LIVE pending cannot happen through this path: a streaming
    // coach turn sets `activeFeature === 'coach-chat'`, which blocks openCoach
    // above, so a 6th session is never created while one streams (carry-fwd 4).
    const session = this.coachStore.getOrCreate(accountId, groupId);
    this.activeCoachSession = session;
    this.coachPendingAnswerText = '';
    this.rebuildCoachModel();
    this.renderAll();
    // Recap-status read (spec §5): async, best-effort — it must never block or
    // break opening; null slots are fine.
    void this.refreshCoachRecapStatus(session);
  }

  /** Drop the coach overlay while RETAINING the store session for reopen (spec
   * §3). Does NOT cancel a streaming op — only ever called for an idle coach or
   * after the op has been torn down elsewhere. */
  private closeCoach(): void {
    this.coachOverlayModel = null;
    this.activeCoachSession = null;
    this.coachPendingAnswerText = '';
    // A lingering chain would reference the now-detached session; drop it. (The
    // op itself, if any, is torn down by the caller's suppression path.)
    this.coachRecapChain = null;
  }

  /** Send the chatter's question as a coach turn (spec §3), possibly gated by an
   * auto-recap chain (spec §5). Async because the auto-recap decision AND the
   * wire history need live settings (`coachAutoRecap`, `deepMessageCount`,
   * `coachHistoryLimit`); a synchronous `coachSubmitInFlight` guard blocks a
   * re-entrant submit across the await. */
  async submitCoachQuestion(question: string): Promise<void> {
    const session = this.activeCoachSession;
    if (!session) {
      return;
    }
    const trimmed = question.trim();
    if (!trimmed) {
      return;
    }
    if (
      this.activeFeature ||
      this.activeCompareModel?.operationId ||
      this.coachRecapChain ||
      this.coachSubmitInFlight
    ) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    const groupId = this.currentGroupId;
    if (!groupId) {
      this.showUserErrorToast(getErrorMessage('coach_fan_unresolved'));
      return;
    }

    this.coachSubmitInFlight = true;
    let settings;
    try {
      ({ settings } = await loadStorageState());
    } finally {
      this.coachSubmitInFlight = false;
    }
    // A route/persona change during the await tore the session/route down.
    if (this.activeCoachSession !== session || this.currentGroupId !== groupId) {
      return;
    }
    // Defensive re-check: the in-flight guard blocked re-entrant submits, but a
    // terminal elsewhere could conceivably have armed an op during the await.
    if (this.activeFeature || this.activeCompareModel?.operationId || this.coachRecapChain) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }

    // Auto-recap chain (spec §5): the FIRST question of a session (with an
    // effective mode ≠ off) refreshes a stale/absent matching recap FIRST, as a
    // visible recap step, then auto-submits this question. At most once per
    // session, even after failure — the decision point flips `autoRecapAttempted`
    // so a later turn never re-triggers it.
    const effectiveMode = resolveEffectiveAutoRecap(session.autoRecapOverride, settings.coachAutoRecap);
    if (!session.autoRecapAttempted && effectiveMode !== 'off') {
      session.autoRecapAttempted = true;
      if (!hasFreshMatchingRecap(session.recapStatus, effectiveMode, settings.deepMessageCount)) {
        this.startCoachRecapChain(session, effectiveMode, 'auto', trimmed);
        return;
      }
    }

    this.sendCoachTurn(session, groupId, trimmed, settings.coachHistoryLimit);
  }

  /** Arm the single-op markers + pending marker and send a coach turn (spec §3).
   * Synchronous — settings are already resolved by the caller. */
  private sendCoachTurn(
    session: CoachSession,
    groupId: string,
    trimmed: string,
    coachHistoryLimit: number,
  ): void {
    const operationId = crypto.randomUUID();
    this.activeFeature = 'coach-chat';
    this.activeOperationId = operationId;
    this.activePersonaKey = this.tabState?.mappedPersonalityId ?? null;
    this.activePersonaDefinitionId = this.tabState?.mappedPersonaDefinitionId ?? null;
    this.activePersonaSource = this.tabState?.mappedPersonaSource ?? null;
    this.activeFanDisplayName = getActiveConversationDisplayName() ?? 'fan';
    this.lastFeature = 'coach-chat';
    this.coachStore.beginPending(session, trimmed, operationId);
    this.coachPendingAnswerText = '';
    // Carry-forward 7: submit clears the composer (the renderer also emits '').
    session.composerText = '';
    this.rebuildCoachModel();
    this.renderAll();

    const coachHistory = this.coachStore.serializeForWire(session, coachHistoryLimit);
    const domFanDisplayName = getActiveConversationDisplayName();
    const payload: OperationStartPayload = {
      type: 'operation:start',
      operationId,
      feature: 'coach-chat',
      groupId,
      routeNonce: this.routeNonce,
      domFanDisplayName,
      forceRegenerate: false,
      chatterQuestion: trimmed,
      coachHistory,
      // Carry-forward 2: the session id keys the background transcript cache; a
      // per-tab fallback would lose «Новый диалог» reseed isolation.
      coachSessionId: session.sessionId,
    };
    const sent = this.port.send(payload);
    if (!sent) {
      // The port is mid-reconnect; the start never reached the background so no
      // terminal will arrive. The turn never started — clearPending (not a
      // failed-attempt) and ask the user to retry.
      this.coachStore.clearPending(session);
      this.clearCoachOperationState();
      this.showUserErrorToast(getErrorMessage('extension_reloaded'));
      this.rebuildCoachModel();
      this.renderAll();
    }
  }

  /** Retry a failed/cancelled turn: replays its question as a FRESH operation
   * (new UUID, freshly refreshed transcript background-side) — spec §8. */
  private async handleCoachRetry(question: string): Promise<void> {
    await this.submitCoachQuestion(question);
  }

  /** «Новый диалог» (spec §3): reset the open session in place — new sessionId
   * forces the background transcript reseed. The renderer confirms first with a
   * two-step arm when the dialog is non-empty; an empty dialog fires straight
   * through, so no confirm is needed here. */
  private resetCoachSession(): void {
    const session = this.activeCoachSession;
    if (!session) {
      return;
    }
    // The composer is locked while streaming, but the topbar New-dialog button
    // is not — refuse a reset mid-turn (the turn must terminate first) and say so.
    if (this.activeFeature === 'coach-chat') {
      this.toast.show('Дождись ответа коуча, потом начинай новый диалог.', {
        tone: 'warning',
      });
      return;
    }
    this.coachStore.resetSession(session);
    this.coachPendingAnswerText = '';
    this.rebuildCoachModel();
    this.renderAll();
  }

  /** Live composer edits persisted into the session so the unsent question
   * survives close/switch (spec §3, carry-forward 7). No re-render: the renderer
   * owns the textarea; the value is restored on the next model rebuild. */
  private handleCoachComposerInput(text: string): void {
    if (this.activeCoachSession) {
      this.activeCoachSession.composerText = text;
    }
  }

  /** Explicit recap refresh from the coach header (spec §5): the same machinery
   * as the auto-recap chain but with origin 'explicit' — a visible in-feed recap
   * step, no coach-question chaining, Coach stays open. */
  private handleCoachRecap(mode: 'short' | 'full'): void {
    const session = this.activeCoachSession;
    if (!session) {
      return;
    }
    this.startCoachRecapChain(session, mode, 'explicit', null);
  }

  /** Cycle the per-session auto-recap override (spec §5 topbar control):
   * inherit → off → short → full → inherit. */
  private cycleCoachAutoRecapOverride(): void {
    const session = this.activeCoachSession;
    if (!session) {
      return;
    }
    const index = AUTO_RECAP_CYCLE.indexOf(session.autoRecapOverride);
    const next = AUTO_RECAP_CYCLE[(index + 1) % AUTO_RECAP_CYCLE.length]!;
    this.coachStore.setAutoRecapOverride(session, next);
    this.rebuildCoachModel();
    this.renderAll();
  }

  /** Run a recap step INSIDE the coach feed (spec §5 orchestration). A
   * fan-summary op with `summaryMode` + `forceRegenerate` (bypasses the cache)
   * renders as a `recap-step` feed item while the coach overlay stays on top
   * (the planner's chain flag). On complete/failure the chain resolves via
   * {@link handleCoachRecapChainComplete}/{@link handleCoachRecapChainError};
   * an 'auto' chain auto-submits its held question, an 'explicit' one does not. */
  private startCoachRecapChain(
    session: CoachSession,
    mode: 'short' | 'full',
    origin: 'auto' | 'explicit',
    pendingQuestion: string | null,
  ): void {
    if (this.activeFeature || this.activeCompareModel?.operationId || this.coachRecapChain) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    // Prereqs unmet (no connection/mapping/persona): can't refresh. For an auto
    // chain this is a STOP — preserve the held question in the composer.
    if (!this.ensureFeatureCanStart('fan-summary')) {
      if (origin === 'auto' && pendingQuestion && session.composerText === '') {
        session.composerText = pendingQuestion;
        this.rebuildCoachModel();
        this.renderAll();
      }
      return;
    }
    const step = this.coachStore.recordRecapStep(session, mode, origin);
    const operationId = crypto.randomUUID();
    const domFanDisplayName = getActiveConversationDisplayName();
    // Set the chain BEFORE initializeFeatureOperation so its renderSurfaces keeps
    // the coach overlay on top (the running step is already in the feed).
    this.coachRecapChain = { operationId, session, step, origin, pendingQuestion };
    this.initializeFeatureOperation('fan-summary', operationId, domFanDisplayName, undefined);
    this.rebuildCoachModel();
    // Recap refresh bypasses the summary/overlay caches (spec §5): forceRegenerate.
    const payload: OperationStartPayload = {
      ...this.buildOperationStartPayload('fan-summary', operationId, domFanDisplayName, undefined, true),
      summaryMode: mode,
    };
    const sent = this.port.send(payload);
    if (!sent) {
      // The start never reached the background — treat as a STOP: fail the step,
      // preserve an auto chain's question, and drop the op markers.
      step.status = 'failed';
      if (origin === 'auto' && pendingQuestion && session.composerText === '') {
        session.composerText = pendingQuestion;
      }
      this.coachRecapChain = null;
      this.clearCoachOperationState();
      this.showUserErrorToast(getErrorMessage('extension_reloaded'));
      this.rebuildCoachModel();
      this.renderAll();
      return;
    }
    this.renderAll();
  }

  /** A recap step completed (spec §5): mark it done, refresh the recap status so
   * the just-generated recap shows, then — for an auto chain — auto-submit the
   * held question. */
  private handleCoachRecapChainComplete(operationId: string): void {
    const chain = this.coachRecapChain;
    if (!chain || chain.operationId !== operationId) {
      this.clearCoachOperationState();
      this.renderButtonBar();
      return;
    }
    chain.step.status = 'done';
    this.coachRecapChain = null;
    this.clearCoachOperationState();
    if (chain.session === this.activeCoachSession) {
      // The freshly generated recap changes the status slots — refresh them so a
      // later decision (and the status line) reflect it.
      void this.refreshCoachRecapStatus(chain.session);
    }
    this.rebuildCoachModel();
    this.renderAll();
    if (chain.origin === 'auto' && chain.pendingQuestion && chain.session === this.activeCoachSession) {
      // autoRecapAttempted is already set, so this submit sends a plain turn.
      void this.submitCoachQuestion(chain.pendingQuestion);
    }
  }

  /** A recap step failed (spec §5 failure taxonomy). STOP categories preserve the
   * held question in the composer and end the chain; a recap-specific model
   * failure or feature ceiling PROCEEDS to the coach turn (auto) with a fallback
   * note. An explicit refresh never chains a question either way. */
  private handleCoachRecapChainError(
    message: Extract<BackgroundPortMessage, { type: 'operation:error' | 'operation:discarded' }>,
  ): void {
    const chain = this.coachRecapChain;
    if (!chain || chain.operationId !== message.operationId) {
      this.clearCoachOperationState();
      this.renderButtonBar();
      return;
    }
    const errorKey = message.error?.key ?? 'unknown_error';
    const classification = classifyRecapChainFailure(errorKey);
    const { origin, pendingQuestion, session, step } = chain;
    step.status = 'failed';
    this.coachRecapChain = null;
    this.clearCoachOperationState();

    if (classification === 'stop') {
      // Chain-stopping failure: preserve the held question for a manual resend.
      if (origin === 'auto' && pendingQuestion && session.composerText === '') {
        session.composerText = pendingQuestion;
      }
      this.rebuildCoachModel();
      this.renderAll();
      return;
    }

    // PROCEED: a recap-specific model failure. An auto chain answers anyway using
    // the older/no recap, with a note; an explicit refresh just shows the failed
    // step.
    if (origin === 'auto' && pendingQuestion) {
      step.note = this.buildRecapFallbackNote(session);
      this.rebuildCoachModel();
      this.renderAll();
      if (session === this.activeCoachSession) {
        void this.submitCoachQuestion(pendingQuestion);
      }
      return;
    }
    this.rebuildCoachModel();
    this.renderAll();
  }

  /** Cancel the whole recap chain (spec §5 "cancellable as a whole"): a STOP —
   * fail the step, preserve an auto chain's held question, suppress the op's
   * terminal. */
  private cancelCoachRecapChain(): void {
    const chain = this.coachRecapChain;
    if (!chain) {
      return;
    }
    this.suppressTerminalOperation(chain.operationId);
    this.port.send({ type: 'operation:cancel', operationId: chain.operationId });
    chain.step.status = 'failed';
    if (chain.origin === 'auto' && chain.pendingQuestion && chain.session.composerText === '') {
      chain.session.composerText = chain.pendingQuestion;
    }
    this.coachRecapChain = null;
    this.clearCoachOperationState();
    this.rebuildCoachModel();
    this.renderAll();
  }

  /** The «использую рекап от N назад» fallback copy (spec §5): the age of the
   * freshest existing recap, or the recap-less variant when none exists. */
  private buildRecapFallbackNote(session: CoachSession): string {
    const ageMs = freshestSlotAgeMs(session.recapStatus);
    if (ageMs === null) {
      return 'обновить Recap не удалось — отвечаю без него';
    }
    return `обновить Recap не удалось — использую рекап от ${formatCoachRecapAge(ageMs)}`;
  }

  /** Cancel a streaming coach turn (Esc / ⌘⇧X): the terminal that follows is
   * suppressed, and the abandoned attempt becomes a cancelled failed-attempt
   * feed item. recordFailedAttempt is called DIRECTLY — never clearPending
   * first, or the guarded record would drop the spec-mandated item
   * (carry-forward 3). */
  private cancelCoachTurn(): void {
    const session = this.activeCoachSession;
    const operationId = this.activeOperationId;
    if (!session || !operationId) {
      return;
    }
    const question = session.pending?.question ?? '';
    this.suppressTerminalOperation(operationId);
    this.port.send({ type: 'operation:cancel', operationId });
    this.coachStore.recordFailedAttempt(session, operationId, question, 'cancelled', true);
    this.clearCoachOperationState();
    this.rebuildCoachModel();
    this.renderAll();
  }

  /** Commit a completed coach stream as an exchange carrying its generationRef
   * (spec §3). Empty/whitespace output fails closed as a failed-attempt (spec
   * §8) rather than committing a blank turn. */
  private handleCoachComplete(
    message: Extract<BackgroundPortMessage, { type: 'operation:complete' }>,
  ): void {
    const session = this.activeCoachSession;
    const operationId = message.operationId;
    if (!session || session.pending?.operationId !== operationId) {
      // Superseded/stale completion — drop it, just release the op markers.
      this.clearCoachOperationState();
      this.renderButtonBar();
      return;
    }
    const question = session.pending.question;
    const answerRaw = message.result.rawText;
    if (answerRaw.trim().length === 0) {
      this.coachStore.recordFailedAttempt(session, operationId, question, 'ai_output_unusable', true);
    } else {
      this.coachStore.commitExchange(session, {
        operationId,
        generationRef: message.generationRef ?? '',
        question,
        answerRaw,
      });
    }
    this.clearCoachOperationState();
    this.rebuildCoachModel();
    this.renderAll();
  }

  /** A coach turn failed: surface it as an in-feed failed-attempt (spec §3/§8,
   * carry-forward 5) — never a separate error overlay. recordFailedAttempt is
   * called DIRECTLY (carry-forward 3). */
  private handleCoachError(
    message: Extract<
      BackgroundPortMessage,
      { type: 'operation:error' | 'operation:discarded' }
    >,
  ): void {
    const session = this.activeCoachSession;
    const operationId = message.operationId;
    if (!session || session.pending?.operationId !== operationId) {
      this.clearCoachOperationState();
      this.renderButtonBar();
      return;
    }
    const question = session.pending.question;
    const errorCode = message.error?.code ?? 'unknown_error';
    this.coachStore.recordFailedAttempt(session, operationId, question, errorCode, true);
    this.clearCoachOperationState();
    this.rebuildCoachModel();
    this.renderAll();
  }

  /** Close the coach overlay on a route change (spec §8): preserve the pending
   * question in the session's composer (a switch cancels the turn but never
   * records a failed-attempt), clear the pending marker, and RETAIN the session
   * in the store. The streaming op itself is torn down by the caller's existing
   * overlay-feature suppression branch. */
  private closeCoachOnRouteChange(): void {
    // A recap chain (fan-summary op) is torn down below by the overlay-feature
    // suppression branch; preserve its held question into the composer first.
    const chain = this.coachRecapChain;
    if (chain) {
      if (chain.pendingQuestion && chain.session.composerText === '') {
        chain.session.composerText = chain.pendingQuestion;
      }
      chain.step.status = 'failed';
      this.coachRecapChain = null;
    }
    const session = this.activeCoachSession;
    if (session) {
      if (session.pending && !session.composerText) {
        session.composerText = session.pending.question;
      }
      this.coachStore.clearPending(session);
    }
    this.coachOverlayModel = null;
    this.activeCoachSession = null;
    this.coachPendingAnswerText = '';
  }

  /** Release the shared single-op markers + the streaming accumulator when a
   * coach turn ends. Leaves the coach overlay/session intact (the feed +
   * composer persist) and never touches the deep-overlay path. */
  private clearCoachOperationState(): void {
    this.clearOperationState(false);
    this.coachPendingAnswerText = '';
  }

  /** Recompute {@link coachOverlayModel} from the open session (or null it out
   * when Coach is closed). */
  private rebuildCoachModel(): void {
    this.coachOverlayModel = this.activeCoachSession
      ? this.buildCoachModel(this.activeCoachSession)
      : null;
  }

  /** Project the content-side {@link CoachSession} into the overlay's coach
   * view model (spec §3). Prose is the draft-stripped answer; drafts carry their
   * per-exchange index for acceptance attribution. */
  private buildCoachModel(session: CoachSession): Extract<OverlayViewModel, { kind: 'coach' }> {
    const feedItems: CoachOverlayFeedItem[] = session.feedItems.map((item) => {
      if (item.kind === 'exchange') {
        const exchange = item.ref;
        const { prose } = parseCoachDrafts(exchange.answerRaw);
        return {
          kind: 'exchange',
          operationId: exchange.operationId,
          question: exchange.question,
          answerProse: prose,
          drafts: exchange.drafts.map((draft) => ({ text: draft.text, index: draft.index })),
        };
      }
      if (item.kind === 'failed-attempt') {
        return {
          kind: 'failed-attempt',
          question: item.question,
          errorCode: item.errorCode,
          retryable: item.retryable,
        };
      }
      return {
        kind: 'recap-step',
        mode: item.mode,
        origin: item.origin,
        status: item.status,
        ...(item.note !== undefined ? { note: item.note } : {}),
      };
    });
    const streaming = Boolean(session.pending);
    // "Busy" also covers a running recap step for THIS session (spec §5): the
    // composer locks and the whole chain is cancellable via the top-level op.
    const chainOpId =
      this.coachRecapChain?.session === session ? this.coachRecapChain.operationId : null;
    const busy = streaming || chainOpId !== null;
    return {
      kind: 'coach',
      fanDisplayName: getActiveConversationDisplayName() ?? 'fan',
      operationId: session.pending?.operationId ?? chainOpId,
      sessionView: {
        feedItems,
        pendingQuestion: session.pending?.question,
        pendingAnswerText: streaming ? this.coachPendingAnswerText : undefined,
        recapStatusLine: formatCoachRecapStatusLine(session.recapStatus),
        composerText: session.composerText,
        composerEnabled: !busy,
        autoRecapOverride: session.autoRecapOverride,
        // (creator account, group) identity — a change swaps the whole feed.
        // Coach is context-bound and closes on route/persona change, so the
        // current tab identity always matches the open session's key.
        sessionKey: `${this.tabState?.accountId ?? ''}|${this.currentGroupId ?? ''}`,
      },
    };
  }

  /** Fire the metadata-only recap-status read (spec §5) and fold the result into
   * the session's status line. Best-effort: any failure leaves the line hidden
   * and never disturbs the open dialog. */
  private async refreshCoachRecapStatus(session: CoachSession): Promise<void> {
    const groupId = this.currentGroupId;
    if (!groupId) {
      return;
    }
    try {
      const status = await sendRuntimeRequest('getRecapStatus', {
        groupId,
        // The background resolves the fan for the canonical fanRef (§5); content
        // has no reliable fan account id, so it sends null.
        fanAccountId: null,
      });
      if (!isRecapStatusResponse(status) || this.activeCoachSession !== session) {
        return;
      }
      session.recapStatus = status;
      this.rebuildCoachModel();
      this.renderSurfaces();
    } catch {
      // Recap status is best-effort; a failure just leaves the line empty.
    }
  }

  // ─── Port Messages ──────────────────────────────────────────────────

  private personaIdentityChanged(next: TabUiState): boolean {
    return Boolean(
      this.tabState &&
      (
        this.tabState.mappedPersonalityId !== next.mappedPersonalityId ||
        this.tabState.mappedPersonaDefinitionId !== next.mappedPersonaDefinitionId ||
        this.tabState.mappedPersonaSource !== next.mappedPersonaSource
      )
    );
  }

  private clearPersonaBoundFeatureState(): void {
    this.completedOverlayCache.clearAll();
    if (this.activeFeature && this.activeOperationId) {
      this.suppressTerminalOperation(this.activeOperationId);
      this.port.send({ type: 'operation:cancel', operationId: this.activeOperationId });
    }
    if (this.activeCompareModel?.operationId) {
      this.suppressTerminalOperation(this.activeCompareModel.operationId);
      this.port.send({
        type: 'compare:cancel',
        operationId: this.activeCompareModel.operationId,
      });
    }
    this.quickInlineVisible = false;
    this.deepOverlayModel = null;
    this.activeCompareModel = null;
    this.comparePanelVisible = false;
    this.pendingCompareFingerprint = null;
    this.completedCompareCache.clearAll();
    this.lastFeature = null;
    this.overlayRawText = '';
    this.clearOperationState(true);
  }

  private handlePortMessage(message: BackgroundPortMessage): void {
    switch (message.type) {
      case 'tab:state':
      case 'settings:changed':
      case 'mapping:changed': {
        const personaChanged = this.personaIdentityChanged(message.state);
        const accountChanged = Boolean(
          this.tabState && this.tabState.accountId !== message.state.accountId,
        );
        if (
          message.type === 'settings:changed' ||
          this.tabState?.accountId !== message.state.accountId
        ) {
          this.boardContextGeneration += 1;
          this.board.invalidateContext();
        }
        if (personaChanged) {
          this.clearPersonaBoundFeatureState();
        }
        if (personaChanged || accountChanged) {
          // Coach sessions must not bleed across persona/account (spec §3):
          // wipe the whole store and close any open coach overlay. A persona
          // change already tore any active coach op down via
          // clearPersonaBoundFeatureState; an account-only change (no persona
          // change) with a live coach turn is torn down here.
          if (
            !personaChanged &&
            this.activeFeature === 'coach-chat' &&
            this.activeOperationId
          ) {
            this.suppressTerminalOperation(this.activeOperationId);
            this.port.send({ type: 'operation:cancel', operationId: this.activeOperationId });
            this.clearCoachOperationState();
          }
          // A running recap chain (fan-summary op) rides `activeFeature`, so a
          // persona change already cancelled its op via clearPersonaBoundFeatureState;
          // an account-only change cancels it here. Either way drop the chain.
          if (this.coachRecapChain) {
            if (!personaChanged && this.activeOperationId) {
              this.suppressTerminalOperation(this.activeOperationId);
              this.port.send({ type: 'operation:cancel', operationId: this.activeOperationId });
              this.clearCoachOperationState();
            }
            this.coachRecapChain = null;
          }
          this.coachStore.resetAll();
          this.closeCoach();
        }
        this.tabState = message.state;
        void this.mappingBanner.render(message.state.accountId, Boolean(message.state.mappedPersonalityId));
        if (personaChanged) {
          this.renderSurfaces();
        }
        this.renderButtonBar();
        break;
      }
      case 'summary:syncStatus':
        this.handleSummarySyncStatus(message);
        break;
      case 'spenders:progress':
        this.board.setBuildProgress(message);
        break;
      case 'spenders:snapshot':
        this.board.setBuildSnapshot(message);
        break;
      case 'operation:progress':
        this.handleProgress(message);
        break;
      case 'compare:ready':
        this.handleCompareReady(message);
        break;
      case 'compare:progress':
        this.handleCompareProgress(message);
        break;
      case 'compare:chunk':
        this.handleCompareChunk(message);
        break;
      case 'compare:cardComplete':
        this.handleCompareCardComplete(message);
        break;
      case 'compare:cardError':
        this.handleCompareCardError(message);
        break;
      case 'compare:complete':
        this.handleCompareComplete(message);
        break;
      case 'compare:error':
      case 'compare:discarded':
        this.handleCompareTerminal(message);
        break;
      case 'operation:debugPrompt':
        this.handleDebugPrompt(message);
        break;
      case 'operation:debugPromptStatus':
        this.handleDebugPromptStatus(message);
        break;
      case 'operation:chunk':
        this.handleChunk(message.operationId, message.text);
        break;
      case 'operation:complete':
        this.handleComplete(message);
        break;
      case 'operation:error':
      case 'operation:discarded':
        this.handleOperationError(message);
        break;
      default:
        break;
    }
  }

  private handleSummarySyncStatus(
    message: Extract<BackgroundPortMessage, { type: 'summary:syncStatus' }>,
  ): void {
    if (message.groupId !== this.currentGroupId) {
      return;
    }

    const cachedModel = this.completedOverlayCache.get(
      this.currentGroupId,
      'fan-summary',
      this.overlayCacheIdentity(null),
    );
    const updatedCachedModel = applyFanSummarySyncStatus(
      cachedModel,
      message.generatedAt,
      message.syncStatus,
    );
    const updatedVisibleModel = applyFanSummarySyncStatus(
      this.deepOverlayModel,
      message.generatedAt,
      message.syncStatus,
    );

    if (updatedCachedModel || updatedVisibleModel) {
      this.renderAll();
    }

    if (message.syncStatus.state === 'failed') {
      this.showUserErrorToast(getErrorMessage('hub_sync_failed'), {
        dedupeKey: `hub-sync-failed:${message.groupId}:${message.generatedAt}`,
        description: message.syncStatus.error
          ? `Latest Hub error: ${formatUserFacingError(message.syncStatus.error)}`
          : undefined,
        tone: 'warning',
        durationMs: 6500,
      });
    }
  }

  private handleProgress(message: Extract<BackgroundPortMessage, { type: 'operation:progress' }>): void {
    if (this.activeOperationId !== message.operationId) {
      return;
    }
    const llmSpend = getMessageLlmSpend(message);
    this.activeLlmSpend = llmSpend ?? this.activeLlmSpend;
    if (
      llmSpend &&
      this.activeFeature &&
      usesInlineFeatureSurface(this.activeFeature) &&
      !featureRequiresDraft(this.activeFeature) &&
      this.quickSurfaceMode === 'inline' &&
      !this.quickInlineVisible
    ) {
      this.quickSurfaceEverOpened = true;
      this.quickInlineVisible = true;
    }
    this.activeProfiling = message.profiling ?? null;
    this.activeProgress = message;
    this.scheduleLoadingRender();
  }

  private activeCompareFor(operationId: string): CompareInlineViewModel | null {
    if (!this.activeCompareModel || this.activeCompareModel.operationId !== operationId) {
      return null;
    }
    return this.activeCompareModel;
  }

  private findCompareTab(
    operationId: string,
    cardId: string,
  ): CompareInlineTabState | null {
    const model = this.activeCompareFor(operationId);
    if (!model) {
      return null;
    }
    return model.tabs.find((tab) => tab.cardId === cardId) ?? null;
  }

  private handleCompareReady(
    message: Extract<BackgroundPortMessage, { type: 'compare:ready' }>,
  ): void {
    const model = this.activeCompareFor(message.operationId);
    if (!model) {
      return;
    }
    model.fanDisplayName = message.fanDisplayName;
    model.tabs = message.cards.map((card) => ({
      cardId: card.id,
      label: card.label,
      source: card.source,
      status: 'loading',
      rawText: '',
      parts: [],
    }));
    model.activeCardId = model.tabs[0]?.cardId ?? null;
    this.comparePanelVisible = true;
    this.renderAll();
  }

  private handleCompareProgress(
    message: Extract<BackgroundPortMessage, { type: 'compare:progress' }>,
  ): void {
    const model = this.activeCompareFor(message.operationId);
    if (!model) {
      return;
    }
    if (message.fanDisplayName) {
      model.fanDisplayName = message.fanDisplayName;
    }
    model.progress = message;
    this.scheduleLoadingRender();
  }

  private handleCompareChunk(
    message: Extract<BackgroundPortMessage, { type: 'compare:chunk' }>,
  ): void {
    const tab = this.findCompareTab(message.operationId, message.cardId);
    if (!tab) {
      return;
    }
    tab.rawText += message.text;
    this.scheduleLoadingRender();
  }

  private handleCompareCardComplete(
    message: Extract<BackgroundPortMessage, { type: 'compare:cardComplete' }>,
  ): void {
    const model = this.activeCompareFor(message.operationId);
    const tab = this.findCompareTab(message.operationId, message.cardId);
    if (!model || !tab) {
      return;
    }
    model.fanDisplayName = message.fanDisplayName;
    tab.status = 'reply';
    const partTexts = resultPartTexts('fast-reply', message.result, message.result.rawText);
    tab.rawText = partTexts.length > 0 ? message.result.rawText : '';
    tab.parts = createParts(partTexts);
    if (tab.parts.length === 0) {
      tab.status = 'error';
      tab.error = createUserError('ai_output_unusable');
    } else {
      tab.error = undefined;
    }
    tab.llmSpend = getMessageLlmSpend(message);
    tab.splitModeRequested = Boolean(message.result.splitModeRequested);
    this.renderSurfaces();
  }

  private handleCompareCardError(
    message: Extract<BackgroundPortMessage, { type: 'compare:cardError' }>,
  ): void {
    const tab = this.findCompareTab(message.operationId, message.cardId);
    if (!tab) {
      return;
    }
    tab.status = 'error';
    tab.llmSpend = getMessageLlmSpend(message);
    tab.error = message.error;
    this.renderSurfaces();
  }

  private handleCompareComplete(
    message: Extract<BackgroundPortMessage, { type: 'compare:complete' }>,
  ): void {
    if (this.consumeSuppressedTerminalOperation(message.operationId)) {
      if (this.activeCompareModel?.operationId === message.operationId) {
        this.activeCompareModel = null;
        this.comparePanelVisible = false;
        this.pendingCompareFingerprint = null;
      }
      this.renderButtonBar();
      return;
    }

    const model = this.activeCompareFor(message.operationId);
    if (!model) {
      return;
    }

    const completedModel: CompareInlineViewModel = {
      kind: 'compare',
      fanDisplayName: message.fanDisplayName,
      operationId: null,
      tabs: model.tabs,
      activeCardId: model.activeCardId,
      progress: null,
      canCancel: false,
      canRegenerate: true,
    };
    this.completedCompareCache.set(this.currentGroupId, {
      model: completedModel,
      fingerprint: this.pendingCompareFingerprint,
    });
    this.pendingCompareFingerprint = null;
    this.activeCompareModel = completedModel;
    this.comparePanelVisible = true;
    this.renderAll();
  }

  private handleCompareTerminal(
    message: Extract<
      BackgroundPortMessage,
      { type: 'compare:error' | 'compare:discarded' }
    >,
  ): void {
    if (this.consumeSuppressedTerminalOperation(message.operationId)) {
      if (this.activeCompareModel?.operationId === message.operationId) {
        this.activeCompareModel = null;
        this.comparePanelVisible = false;
        this.pendingCompareFingerprint = null;
      }
      this.renderButtonBar();
      return;
    }

    if (this.activeCompareModel?.operationId === message.operationId) {
      this.activeCompareModel = null;
      this.comparePanelVisible = false;
      this.pendingCompareFingerprint = null;
      this.completedCompareCache.clear(this.currentGroupId);
      this.renderButtonBar();
    }

    if (message.type === 'compare:error') {
      this.showUserErrorToast(message.error);
    }
  }

  private handleDebugPrompt(message: Extract<BackgroundPortMessage, { type: 'operation:debugPrompt' }>): void {
    if (this.activeOperationId !== message.operationId) {
      return;
    }
    this.activeDebugPrompt = message.snapshot;
    this.scheduleLoadingRender();
  }

  private handleDebugPromptStatus(
    message: Extract<BackgroundPortMessage, { type: 'operation:debugPromptStatus' }>,
  ): void {
    if (this.activeOperationId !== message.operationId) {
      return;
    }
    // Rebuilt, not adopted: only the modelled fields cross into this process,
    // whatever the port handed us. The token then lives here in the content
    // script's own heap — never in an attribute, a dataset entry, or anything
    // else the Fansly page can read out of the shared DOM (E28).
    this.activeDebugEcho = projectDebugPromptEcho(message.echo);
    this.scheduleLoadingRender();
  }

  private async openDebugPromptViewer(): Promise<void> {
    const echo = this.activeDebugEcho;
    if (echo?.state !== 'available') {
      return;
    }
    try {
      await browser.runtime.sendMessage({
        type: 'openDebugPrompt',
        viewerToken: echo.viewerToken,
      });
    } catch {
      // The worker restarted and dropped the snapshot; the panel already says
      // the echo can expire, so there is nothing useful to add here.
    }
  }

  private handleChunk(operationId: string, text: string): void {
    if (this.activeOperationId !== operationId) {
      return;
    }
    // A coach recap step (spec §5) is a status pill, not a streamed body — the
    // recap's fan-summary text never renders in the coach feed. Swallow its
    // chunks so they neither hit overlayRawText nor the coach pending answer.
    if (this.coachRecapChain?.operationId === operationId) {
      return;
    }
    // Coach streams into the session-scoped pending answer, NOT overlayRawText
    // (carry-forward 6); the keyed coach renderer mutates only the pending node.
    if (this.activeFeature === 'coach-chat') {
      this.coachPendingAnswerText += text;
      this.rebuildCoachModel();
      this.scheduleLoadingRender();
      return;
    }
    this.overlayRawText += text;

    if (this.activeFeature && featureRequiresDraft(this.activeFeature)) {
      return;
    }

    if (
      this.activeFeature &&
      usesInlineFeatureSurface(this.activeFeature)
    ) {
      if (!this.quickSurfaceEverOpened) {
        this.quickSurfaceEverOpened = true;
        if (this.quickSurfaceMode === 'inline') {
          this.quickInlineVisible = true;
        }
      }
      this.scheduleLoadingRender();
      return;
    }

    this.scheduleLoadingRender();
  }

  private handleComplete(message: Extract<BackgroundPortMessage, { type: 'operation:complete' }>): void {
    if (this.consumeSuppressedTerminalOperation(message.operationId)) {
      if (this.activeOperationId === message.operationId) {
        this.clearOperationState(true);
      }
      this.renderButtonBar();
      return;
    }

    if (this.activeOperationId !== message.operationId || !this.activeFeature) {
      return;
    }

    // A coach recap step (spec §5): resolve the chain (mark done, maybe chain the
    // held question) — the fan-summary result NEVER renders as a deep overlay.
    if (this.coachRecapChain?.operationId === message.operationId) {
      this.handleCoachRecapChainComplete(message.operationId);
      return;
    }

    // Coach commits via its own path — it NEVER reaches overlayRawText,
    // buildCompletedOverlayModel, or CompletedOverlayCache (carry-forwards 5/6).
    if (this.activeFeature === 'coach-chat') {
      this.handleCoachComplete(message);
      return;
    }

    const feature = this.activeFeature;
    const rawText = message.result.rawText;
    this.overlayRawText = rawText;
    const completedModel = this.buildCompletedOverlayModel(
      feature,
      message.operationId,
      message.fanDisplayName,
      message.result,
      getMessageLlmSpend(message) ?? this.activeLlmSpend ?? undefined,
      message.profiling ?? this.activeProfiling ?? undefined,
    );
    if (feature === 'fan-summary' && this.tabState) {
      this.tabState = {
        ...this.tabState,
        hasAvailableSummary: true,
      };
    }
    const improveDraftCacheKey = this.activeImproveDraftCacheKey;
    this.completedOverlayCache.set(
      this.currentGroupId,
      feature,
      completedModel,
      this.overlayCacheIdentity(
        featureRequiresDraft(feature) ? improveDraftCacheKey : null,
        this.activePersonaKey ?? this.tabState?.mappedPersonalityId ?? null,
        this.activePersonaDefinitionId ?? this.tabState?.mappedPersonaDefinitionId ?? null,
        this.activePersonaSource ?? this.tabState?.mappedPersonaSource ?? null,
      ),
    );

    this.presentCompletedFeature(feature, completedModel);
  }

  private handleOperationError(
    message: Extract<
      BackgroundPortMessage,
      { type: 'operation:error' | 'operation:discarded' }
    >,
  ): void {
    if (this.consumeSuppressedTerminalOperation(message.operationId)) {
      if (this.activeOperationId === message.operationId) {
        this.clearOperationState(true);
      }
      this.renderButtonBar();
      return;
    }

    if (this.activeOperationId === message.operationId) {
      // A coach recap step failed (spec §5): classify + resolve the chain in the
      // feed (stop vs proceed) — never a separate error overlay.
      if (this.coachRecapChain?.operationId === message.operationId) {
        this.handleCoachRecapChainError(message);
        return;
      }

      // Coach failures surface as an in-feed failed-attempt (carry-forward 5) —
      // never a separate error overlay while Coach is open.
      if (this.activeFeature === 'coach-chat') {
        this.handleCoachError(message);
        return;
      }

      // «Открыть последний» found nothing stored (spec §5): a soft, expected
      // outcome — toast it rather than showing a full error overlay.
      if (message.error?.key === 'no_saved_recap') {
        this.clearOperationState(true);
        this.showUserErrorToast(getErrorMessage('no_saved_recap'));
        this.renderAll();
        return;
      }

      const feature = this.activeFeature ?? this.lastFeature ?? 'fast-reply';

      const errorModel: OverlayViewModel = {
        kind: 'error',
        feature,
        fanDisplayName: this.currentFanDisplayName(),
        operationId: message.operationId,
        debugPrompt: this.activeDebugPrompt ?? undefined,
      debugEcho: this.activeDebugEcho ?? undefined,
        llmSpend:
          getMessageLlmSpend(message) ?? this.activeLlmSpend ?? undefined,
        profiling: message.profiling ?? this.activeProfiling ?? undefined,
        error: message.error,
      };

      this.presentOperationError(feature, errorModel, message.error);
      return;
    }

    this.showUserErrorToast(message.error);
  }

  // ─── State Helpers ──────────────────────────────────────────────────

  private suppressTerminalOperation(operationId: string | null): void {
    if (operationId) {
      this.suppressedTerminalOpIds.add(operationId);
    }
  }

  private isTerminalOperationSuppressed(operationId: string | null): boolean {
    return Boolean(operationId && this.suppressedTerminalOpIds.has(operationId));
  }

  private consumeSuppressedTerminalOperation(operationId: string): boolean {
    return this.suppressedTerminalOpIds.delete(operationId);
  }

  private clearOperationState(fullReset: boolean): void {
    this.activeFeature = null;
    this.activeOperationId = null;
    this.activePersonaKey = null;
    this.activePersonaDefinitionId = null;
    this.activePersonaSource = null;
    this.activeFanDisplayName = null;
    this.activeLlmSpend = null;
    this.activeProfiling = null;
    this.activeProgress = null;
    this.activeImproveDraftCacheKey = null;
    if (fullReset) {
      this.activeDebugPrompt = null;
      this.activeDebugEcho = null;
      this.deepOverlayModel = null;
    }
  }

  private currentFanDisplayName(): string {
    return this.activeFanDisplayName ?? 'fan';
  }

  private computeHasDraftText(): boolean {
    return getActiveConversationDraftText().trim().length > 0;
  }

  private buildImproveDraftCacheKey(draftText: string | undefined): string | null {
    const trimmed = draftText?.trim() ?? '';
    return trimmed || null;
  }

  private async applyImproveDraftResult(
    model: Extract<CompletedOverlayViewModel, { kind: 'reply' }>,
  ): Promise<void> {
    const nextText = model.parts[0]?.text ?? (model.rawText.trim() || model.rawText);

    try {
      await insertIntoFanslyTextarea(nextText);
      const firstPart = model.parts[0];
      if (firstPart) {
        firstPart.insertedOnce = true;
        firstPart.insertedAt = null;
      }
      this.quickInlineVisible = false;
      this.quickSurfaceMode = 'inline';
      this.renderAll();
    } catch (error) {
      this.quickInlineVisible = true;
      this.quickSurfaceMode = 'inline';
      this.showUserErrorToast(toUserError(error));
      this.overlay.render({ kind: 'hidden' });
      this.inlinePanel.render(model);
      this.renderButtonBar();
    }
  }

  private detachDraftTextareaObserver(): void {
    if (!this.observedDraftTextarea) {
      return;
    }
    this.observedDraftTextarea.removeEventListener('input', this.handleDraftInput);
    this.observedDraftTextarea.removeEventListener('change', this.handleDraftInput);
    this.observedDraftTextarea = null;
  }

  private syncDraftTextareaObserver(): void {
    const textarea = findActiveConversationTextarea();
    if (textarea !== this.observedDraftTextarea) {
      this.detachDraftTextareaObserver();
      this.observedDraftTextarea = textarea;
      this.observedDraftTextarea?.addEventListener('input', this.handleDraftInput);
      this.observedDraftTextarea?.addEventListener('change', this.handleDraftInput);
    }
    this.hasDraftText = this.computeHasDraftText();
  }

  private async computeCompareFingerprint(): Promise<string | null> {
    if (!this.tabState) {
      return null;
    }

    const storage = await loadStorageState();
    return getCompareCardsFingerprintForPersonality(
      storage,
      this.tabState.mappedPersonalityId,
    );
  }

  private async restoreCompletedComparePanel(): Promise<boolean> {
    return this.restoreCompletedComparePanelInternal(false);
  }

  private hasRestorableCompletedCompare(): boolean {
    return Boolean(
      !this.activeFeature &&
      !this.activeCompareModel &&
      !this.comparePanelVisible &&
      this.completedCompareCache.get(this.currentGroupId),
    );
  }

  private async restoreCompletedComparePanelInternal(
    notifyOnStale: boolean,
  ): Promise<boolean> {
    if (this.activeCompareModel?.operationId) {
      return false;
    }

    const cached = this.completedCompareCache.get(this.currentGroupId);
    if (!cached) {
      return false;
    }

    const fingerprint = await this.computeCompareFingerprint();
    if (cached.fingerprint !== fingerprint) {
      this.completedCompareCache.clear(this.currentGroupId);
      this.activeCompareModel = null;
      this.comparePanelVisible = false;
      this.renderAll();
      if (notifyOnStale) {
        this.toast.show('Saved compare is outdated. Run Compare again.', {
          tone: 'warning',
        });
      }
      return false;
    }

    this.activeCompareModel = cached.model;
    this.comparePanelVisible = true;
    this.renderAll();
    return true;
  }

  private buildCompletedOverlayModel(
    feature: FeatureType,
    operationId: string,
    fanDisplayName: string,
    result: FeatureResult,
    llmSpend?: LlmSpendSummary,
    profiling?: OperationProfilingSnapshot,
  ): CompletedOverlayViewModel {
    const rawText = result.rawText;

    const resultKind = getFeaturePolicy(feature).resultKind;
    switch (resultKind) {
      case 'coach-chat':
        // Coach normally renders via its OWN overlay path
        // (OverlayController.renderCoach off the CoachSession store); on the full
        // stack handleComplete intercepts a coach completion before this function,
        // so this arm is dead code there. It is kept as a graceful DEFENSIVE arm
        // (and makes part 1 standalone-correct, before that interceptor lands):
        // surface the coach advice READ-ONLY rather than fall through to the reply
        // path — where resultPartTexts('coach-chat') → [] would discard the answer
        // and show a bogus ai_output_unusable error. Read-only degrades gracefully
        // where the earlier throw would crash a misrouted (but complete) result.
        return {
          kind: 'readOnly',
          feature: 'coach-chat',
          fanDisplayName,
          operationId,
          rawText,
          debugPrompt: this.activeDebugPrompt ?? undefined,
          debugEcho: this.activeDebugEcho ?? undefined,
          llmSpend,
          profiling,
          rerunActionLabel: 'Regenerate',
        };
      case 'help-me': {
        const parsed = result.helpMe;
        return {
          kind: 'helpMe',
          feature: 'help-me',
          fanDisplayName,
          operationId,
          rawText,
          coaching: parsed?.coaching ?? null,
          engagingParts: parsed?.engaging ? createParts(normalizeReplyParts(parsed.engaging)) : [],
          flirtyParts: parsed?.flirty ? createParts(normalizeReplyParts(parsed.flirty)) : [],
          parseFallback: !parsed?.valid,
          debugPrompt: this.activeDebugPrompt ?? undefined,
          debugEcho: this.activeDebugEcho ?? undefined,
          llmSpend,
          profiling,
          rerunActionLabel: 'Regenerate',
        };
      }
      case 'summary':
        return {
          kind: 'readOnly',
          feature: 'fan-summary',
          fanDisplayName,
          operationId,
          rawText,
          summaryMeta: result.summaryMeta,
          debugPrompt: this.activeDebugPrompt ?? undefined,
          debugEcho: this.activeDebugEcho ?? undefined,
          llmSpend,
          profiling,
          rerunActionLabel: 'Refresh',
        };
      case 'chat-review':
        return {
          kind: 'readOnly',
          feature: 'chat-review',
          fanDisplayName,
          operationId,
          rawText,
          summaryMeta: result.summaryMeta,
          reviewMeta: {
            rating: result.chatReview?.rating ?? null,
            evaluation: result.chatReview?.evaluation ?? null,
            recommendations: result.chatReview?.recommendations ?? null,
            parseFallback: !result.chatReview?.valid,
          },
          debugPrompt: this.activeDebugPrompt ?? undefined,
          debugEcho: this.activeDebugEcho ?? undefined,
          llmSpend,
          profiling,
          rerunActionLabel: 'Refresh',
        };
    }

    // Exhaustiveness gate: only the reply-shaped kinds reach here. Assigning the
    // now-narrowed discriminant to the reply-kind union makes tsc fail if a future
    // resultKind is added without a case above — closing the silent-fallthrough
    // that let coach-chat render as an empty error (round-9 P2).
    const replyKind: 'reply' | 'single-reply' = resultKind;
    void replyKind;

    const partTexts = resultPartTexts(feature, result, rawText);
    return {
      kind: 'reply',
      feature,
      fanDisplayName,
      operationId,
      parts: createParts(partTexts),
      rawText: partTexts.length > 0 ? rawText : '',
      splitModeRequested: Boolean(result.splitModeRequested),
      debugPrompt: this.activeDebugPrompt ?? undefined,
      debugEcho: this.activeDebugEcho ?? undefined,
      llmSpend,
      profiling,
      rerunActionLabel: 'Regenerate',
      ...(partTexts.length > 0 ? {} : { error: createUserError('ai_output_unusable') }),
    };
  }
}

if (window.location.hostname.endsWith('fansly.com')) {
  new ChatGooseContentApp().init();
}
