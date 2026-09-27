import { ButtonBar } from './button-bar.js';
import { COACH_SITUATION_PRESET_LABEL } from './coach-copy.js';
import {
  formatCoachAgeMs,
  formatCoachWaitStatus,
} from '../shared/coach-format.js';
import { isCoachTurnContext } from '../shared/protocol.js';
import { COACH_DRAFT_ATTACH_ENABLED, coachDraftAttachAllowed } from '../shared/coach-draft-gate.js';
import {
  createCoachSessionStore,
  type CoachSession,
  type CoachRecapStepFeedItem,
} from './coach-session.js';
import { getActiveConversationDisplayName, getActiveConversationDom } from './conversation-dom.js';
import { ConversationMountController } from './conversation-mount-controller.js';
import { CompletedCompareCache } from './inline-panel/completed-compare-cache.js';
import { InlinePanelController } from './inline-panel/inline-panel-controller.js';
import { MappingBanner } from './mapping-banner.js';
import {
  CompletedOverlayCache,
  type CompletedOverlayCacheIdentity,
  type CompletedOverlayCacheSlot,
} from './overlay/completed-overlay-cache.js';
import { OverlayController } from './overlay/overlay-controller.js';
import { PortClient } from './port-client.js';
import { VoiceAttemptController } from './voice/attempt-controller.js';
import { VoiceAttemptCustodyError } from './voice/attempt-store.js';
import { VoiceAttachAdapter } from './voice/attach-adapter.js';
import { VoicePanel } from './voice/voice-panel.js';
import { VoiceStudio } from './voice/voice-studio.js';
import { CheatsheetController } from './cheatsheet-controller.js';
import { BoardLauncher } from './spenders/board-launcher.js';
import { SpendersBoardController } from './spenders/spenders-board-controller.js';
import { parseGroupIdFromPath, startRouteWatcher } from './route-watcher.js';
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
  detectLabelPlatform,
  HOTKEY_FEATURE,
  type HotkeyAction,
} from '../shared/hotkeys.js';
import { isGlobalHotkeyAction, resolveHotkeyKeydown } from './hotkey-input.js';
import { COACH_RECAP_FRESH_MS, SPENDERS_SPA_NAV_VERIFY_MS } from '../shared/constants.js';
import { parseCoachDrafts } from '../shared/coach-draft.js';
import { isRecapStatusResponse } from '../shared/protocol.js';
import { sendRuntimeRequest } from '../shared/runtime-request.js';
import { resolveOptionsRouteForCode } from '../shared/options-routes.js';
import { projectDebugPromptEcho } from '../shared/kernel-context.js';
import {
  getCompareCardsFingerprintForPersonality,
} from '../shared/compare-cards.js';
import {
  ChatGooseError,
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
  usesInlineFeatureSurface,
  usesOverlayFeatureSurface,
} from '../shared/features.js';
import {
  normalizeProvidedReplyParts,
  normalizeReplyParts,
  normalizeSingleReplyPart,
  normalizeVariantReplyParts,
} from '../shared/reply-output.js';
import { readStorageState } from '../shared/storage.js';
import type {
  CoachAutoRecapOverride,
  CoachOverlayFeedItem,
  CoachRecapStatusView,
  CoachSettingsSnapshot,
  CoachTurnDebug,
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

type RecapMode = 'full' | 'short';

function recapOverlayCacheSlot(mode: RecapMode): CompletedOverlayCacheSlot {
  return mode === 'short' ? 'recap-short' : 'recap-full';
}

function hotkeyNeedsInitialTabState(action: HotkeyAction): boolean {
  return HOTKEY_FEATURE[action] !== undefined ||
    action === 'coach' ||
    action === 'fan-summary' ||
    action === 'spenders-board';
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
    model.recapMode === 'short' ||
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

/** The structured recap freshness line for the coach empty state (spec §2.1/§5),
 * or `{ state: 'hidden' }` when nothing is stored (the renderer draws nothing). */
function formatCoachRecapStatusLine(status: RecapStatusResponse | null): CoachRecapStatusView {
  if (!status) {
    return { state: 'hidden' };
  }
  // Honest empty-state (E43): the Hub could not be REACHED (not connected, no
  // page match, Hub down/absent) — that is NOT "no recap". Surface it distinctly
  // so the chatter doesn't read a false «нет рекапа» and regenerate needlessly.
  if (status.state === 'unavailable') {
    return { state: 'unavailable' };
  }
  const fullAge = status.full ? formatCoachAgeMs(status.full.ageMs) : null;
  const shortAge = status.short ? formatCoachAgeMs(status.short.ageMs) : null;
  if (fullAge === null && shortAge === null) {
    return { state: 'hidden' };
  }
  return { state: 'ages', fullAge, shortAge };
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

/** Auto-recap failure taxonomy (spec §5). Only known recap-specific output or
 * history ceilings may continue to Coach. Everything else — including new or
 * infrastructure errors — stops and preserves the question. */
const RECAP_CHAIN_PROCEED_KEYS: ReadonlySet<UserErrorKey> = new Set<UserErrorKey>([
  'ai_output_unusable',
  'not_enough_history',
]);

function classifyRecapChainFailure(errorKey: string): 'stop' | 'proceed' {
  return RECAP_CHAIN_PROCEED_KEYS.has(errorKey as UserErrorKey) ? 'proceed' : 'stop';
}

function restoreCoachComposerText(session: CoachSession, question: string): void {
  if (session.composerText === '') {
    session.composerText = question;
  }
}

/** Options threaded through {@link ChatGooseContentApp.submitCoachQuestion}. */
interface CoachSubmitOpts {
  forceDraftRead?: boolean;
  /** False for canned sources (chips, Retry, chain resubmits): a rejected
   * canned submit must never be written into the composer (review round 8). */
  fromComposer?: boolean;
  /** Dispatch the kernel-owned situation preset with no chatterQuestion. */
  preset?: true;
}

export class ChatGooseContentApp {
  private routeNonce = 0;
  private boardContextGeneration = 0;
  private currentGroupId: string | null = null;
  private tabState: TabUiState | null = null;
  private activeFeature: FeatureType | null = null;
  private activeOperationId: string | null = null;
  /** Group the active operation was STARTED for — stamped into completed
   * models so insert guards can compare against the live URL. `currentGroupId`
   * is 500ms-poll-stale by design; this capture is not. */
  private activeOperationGroupId: string | null = null;
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
  private voiceRenderFrame: number | null = null;
  private readonly suppressedTerminalOpIds = new Set<string>();
  private activeImproveDraftCacheKey: string | null = null;
  private activeImproveDraftText: string | null = null;
  /** E142: a Split Fix shown in the inline panel, pinned to the draft it was
   * made from. The panel looks its result up by this key instead of the live
   * composer, so inserting or sending part 1 does not drop parts 2–3, and
   * Regenerate reruns that draft. */
  private inlineImprove: { variantKey: string; draftText: string } | null = null;
  private observedDraftDocument: Document | null = null;
  private hasDraftText = false;
  // Deep feature overlay model (completed/error/cache-hit shown in overlay)
  private deepOverlayModel: OverlayViewModel | null = null;

  // ─── Voice (лента) ────────────────────────────────────────────────────────
  // A dedicated, route-bound lane. Its controller owns the attempt and is
  // deliberately EXEMPT from the generic port-disconnect teardown: a dropped
  // background never cancels an in-flight paid synthesis. Created lazily on the
  // first 🎙 open for a conversation, and torn down only on route change.
  private voiceController: VoiceAttemptController | null = null;
  private voicePanel: VoicePanel | null = null;
  private voiceStudio: VoiceStudio | null = null;
  private voiceReconnectPending = false;
  private voiceNewStartInFlight = false;

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
        /** Retry's live-draft re-read intent (spec §5): must survive the chain so
         * the post-recap dispatch still re-reads the CURRENT Fansly draft
         * (review P1 — it used to be dropped at both continuations). */
        forceDraftRead: boolean;
        /** Whether the held question was COMPOSER-typed (review round 9): the
         * chain resubmit must keep the original origin, or a post-recap
         * rejection silently eats the chatter's own text. */
        fromComposer: boolean;
        /** Preserve a Help preset through an automatic recap step. */
        preset: boolean;
      }
    | null = null;
  // Synchronous re-entrancy guard for submitCoachQuestion across its settings
  // await (the auto-recap decision needs live settings before arming anything).
  // The submit preflight locks, keyed by SESSION with a per-call token (review
  // rounds 8/9/12): both the busy projection AND the admission guard must
  // agree, or another fan's coach looks usable while every Send bounces. A
  // same-session re-entry is blocked; different sessions proceed
  // independently, and each finally releases ONLY its own token — a single
  // pointer could be overwritten/cleared by an overlapping preflight in either
  // completion order.
  private readonly coachSubmitPreflights = new Map<CoachSession, symbol>();
  // Opening Coach and successful recap steps start metadata reads without
  // blocking normal Coach turns. Only a still-unconsumed first auto-recap
  // decision awaits the latest read, so stale status cannot trigger duplicate
  // generation while fresher metadata is in flight.
  private coachRecapStatusRead: { session: CoachSession; promise: Promise<void> } | null = null;
  // The size of the ACTIVE fan-summary op (standalone recap / «Открыть
  // последний»), or null for a legacy/plain full run. Completed full and short
  // results occupy independent availability + display-cache slots.
  private activeSummaryMode: RecapMode | null = null;
  // «Открыть последний»: the OTHER recap size to try once if the current
  // view-cached-only op 404s with no_saved_recap (the local cache may hold one
  // size but not the other), or null when there is nothing left to fall back to.
  private viewLastFallbackMode: 'short' | 'full' | null = null;
  // Content-owned snapshot of the two v15 coach settings the renderer needs live
  // (spec §7): coachHistoryLimit (memory-window divider §8.1) + the global
  // coachAutoRecap default (the «По настройке (<x>)» menu label §3). Null until
  // hydrated on openCoach; refreshed on the settings:changed path. Fallbacks are
  // in buildCoachModel (menu label drops the value; divider not rendered).
  private coachSettingsSnapshot: CoachSettingsSnapshot | null = null;
  // Monotonic guard for snapshot hydration (review P1): bumped on every open and
  // settings change; a read that resolves under an older generation is discarded
  // (a mere session-reference check cannot tell close/reopen apart — getOrCreate
  // returns the same object).
  private coachSettingsSnapshotGeneration = 0;
  private resolveInitialTabState: (() => void) | null = null;
  private readonly initialTabStateReady = new Promise<void>((resolve) => {
    this.resolveInitialTabState = resolve;
  });
  private pendingInitialHotkeyGeneration = 0;

  private readonly handleDraftInput = (event: Event): void => {
    // Fansly creates/replaces the native textarea on focus without replacing
    // the mounted input host. Resolve each event against the live composer so
    // its first edit is observed, while Coach/search/other inputs stay outside.
    if (event.target !== findActiveConversationTextarea()) {
      return;
    }
    const nextHasDraftText = this.computeHasDraftText();
    if (nextHasDraftText === this.hasDraftText) {
      return;
    }
    this.hasDraftText = nextHasDraftText;
    this.renderButtonBar();
    // An open coach surface reflects the live Fansly draft in its checkbox
    // (review P2): typing into / clearing the Fansly composer must update the
    // disabled state immediately, not on the next unrelated render.
    if (this.activeCoachSession && this.coachOverlayModel) {
      this.renderSurfaces();
    }
  };

  private toastController: ToastController | null = null;
  private readonly port = new PortClient({
    onMessage: (message) => this.handlePortMessage(message),
    onConnected: () => {
      if (this.voiceController) {
        this.voiceReconnectPending = false;
        this.runVoiceControllerTask(this.voiceController.handlePortReconnect());
      }
    },
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
      // A disconnect kills the port mid-turn: no terminal will ever arrive, so a
      // coach turn/recap chain left "pending" would lock the composer forever
      // (streaming is derived from pending). Recover the session before clearing
      // op state — restore the question, drop the pending marker.
      this.recoverCoachOnDisconnect();
      this.clearOperationState(true);
      this.resetNextFastReplyMode();
      this.resetNextReplyTone();
      // Voice is EXEMPT from this teardown (billing correctness must not depend
      // on the background staying alive): keep the controller + its stored
      // attempt, just stop its polling and mark it for a reconnect handshake.
      if (this.voiceController) {
        this.voiceReconnectPending = true;
        this.runVoiceControllerTask(this.voiceController.handlePortDisconnected());
      }
      this.renderAll();
    },
  });
  private readonly buttonBar = new ButtonBar({
    onFeatureClick: (feature) => {
      // Recap opens its picker; Help opens Coach and starts the situation preset.
      // The remaining feature buttons start their operation directly.
      if (feature === 'fan-summary') {
        this.openRecapPicker();
        return;
      }
      if (feature === 'help-me') {
        this.openCoachPreset();
        return;
      }
      this.startFeature(feature, false);
    },
    onReplyModeToggle: () => this.toggleNextFastReplyMode(),
    onToneSelect: (tone) => this.armReplyTone(tone),
    onVoiceClick: () => this.openVoicePanel(),
    onCoachClick: () => this.openCoach(),
  });
  private readonly mappingBanner = new MappingBanner({
    // The banner stands in for a registry error, so it deep-links exactly like
    // that error's toast would. Sign-in belongs to «Аккаунт ChatGoose» and
    // precedes persona setup on «Персоны» or «Аккаунты».
    onOpenSettings: (reason) => {
      this.openSettings(
        getErrorMessage(reason === 'signed-out'
          ? 'hub_missing_api_key'
          : reason === 'no-personalities' ? 'no_personalities' : 'no_mapping').code,
      );
    },
  });
  private readonly root = document.createElement('div');
  private readonly mountController: ConversationMountController;
  private readonly completedOverlayCache = new CompletedOverlayCache();
  private readonly completedCompareCache = new CompletedCompareCache();
  private readonly inlinePanel = new InlinePanelController({
    isKeyboardBlocked: () =>
      (this.cheatsheetController?.isOpen() ?? false) ||
      (this.boardController?.isOpen() ?? false),
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
        this.inlineImprove = null;
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
    onRerun: (feature) => this.rerunFeature(feature),
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
    onAcceptance: (operationId, action, partIndex, generationRef) => {
      this.port.send({
        type: 'operation:acceptance',
        operationId,
        action,
        partIndex,
        ...(generationRef ? { generationRef } : {}),
      });
    },
    onOpenDebugPrompt: (viewerToken?: string) => {
      void this.openDebugPromptViewer(viewerToken);
    },
    onClose: () => {
      // Esc/backdrop over the recap start dialog just cancels it (spec §5) — no
      // generation was started, nothing to tear down.
      if (this.recapPickerModel) {
        this.closeRecapPicker();
        this.renderAll();
        return;
      }
      // A live recap chain runs under `activeFeature === 'fan-summary'`, so an
      // onClose (e.g. draft Insert during a running step) would otherwise hit the
      // idle-coach branch below and drop the chain WITHOUT cancelling/suppressing
      // its op — losing the held question and leaking a short recap into the full
      // cache. Tear the chain down first (cancel + suppress + preserve the held
      // question + fail the step), THEN collapse the overlay (the close intent).
      if (this.coachRecapChain) {
        this.cancelCoachRecapChain();
        this.closeCoach();
        this.renderAll();
        return;
      }
      // Draft Insert closes the Coach overlay even when another turn is
      // streaming. Cancel/suppress that live turn before collapsing so its paid
      // terminal cannot be orphaned and leave the session permanently pending.
      if (this.activeFeature === 'coach-chat') {
        this.cancelCoachTurn();
        this.closeCoach();
        this.renderAll();
        return;
      }
      // A completed deep result (e.g. a standalone recap started over an idle
      // coach via ⌘⇧S) OUTRANKS the idle coach in the surface planner, so it is
      // the surface the chatter actually sees. Esc must close what is visible —
      // closing the invisible coach beneath it made the first Esc a no-op.
      // Mirrors the tail's teardown for the deep surface: E24 — closing a
      // surface disarms the armed tone. `clearOperationState(true)` is
      // deliberately NOT replicated: no operation is live on this path (a live
      // coach turn / recap chain returned above, and a live overlay feature
      // renders its own loading surface), and blindly clearing it here would
      // touch state the idle coach beneath still owns. The DEBUG viewer state
      // is the exception: it belongs to the dismissed deep result, and leaving
      // it behind lets a later cached model's «Open the real prompt» open the
      // dismissed recap's prompt instead (codex review P2 on this PR).
      if (this.deepOverlayModel && this.coachOverlayModel) {
        this.deepOverlayModel = null;
        this.activeDebugPrompt = null;
        this.activeDebugEcho = null;
        this.resetNextReplyTone();
        this.renderAll();
        return;
      }
      // Idle coach close (Esc/backdrop while not streaming): retain the session
      // in the store for reopen (spec §3), just drop the overlay.
      if (this.coachOverlayModel) {
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
    onRerun: (feature, recapMode) => this.rerunFeature(feature, recapMode),
    onCollapse: () => {
      this.quickSurfaceMode = 'inline';
      this.quickInlineVisible = true;
      this.renderSurfaces();
    },
    onCoachSubmit: (question, origin) => {
      void this.submitCoachQuestion(question, { fromComposer: origin !== 'canned' });
    },
    onCoachPreset: () => this.openCoachPreset(),
    onCoachNewDialog: () => this.resetCoachSession(),
    onCoachRecap: (mode) => this.handleCoachRecap(mode),
    onCoachSetAutoRecap: (override) => this.setCoachAutoRecapOverride(override),
    onCoachRetry: (question, includedDraft, preset) => {
      void this.handleCoachRetry(question, includedDraft, preset);
    },
    onCoachComposerInput: (text) => this.handleCoachComposerInput(text),
    onCoachDraftIntentChange: (intent) => this.handleCoachDraftIntentChange(intent),
    onCoachRefreshTranscript: () => this.handleCoachRefreshTranscript(),
    onRecapPick: (mode) => this.pickStandaloneRecap(mode),
    onRecapOpenLast: () => this.openLastRecap(),
  });

  private cheatsheetController: CheatsheetController | null = null;
  private boardController: SpendersBoardController | null = null;
  private readonly launcher = new BoardLauncher(() => this.board.toggle());

  constructor() {
    this.root.id = 'chatgoose-root';
    this.root.append(this.inlinePanel.root, this.buttonBar.root, this.mappingBanner.root);
    this.mountController = new ConversationMountController(this.root);
  }

  private get toast(): ToastController {
    return this.toastController ??= new ToastController();
  }

  private get cheatsheet(): CheatsheetController {
    return this.cheatsheetController ??=
      new CheatsheetController(detectLabelPlatform());
  }

  private get board(): SpendersBoardController {
    return this.boardController ??= new SpendersBoardController({
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
            actionLabel: 'Настройки',
            // Land on the pane that can actually fix THIS error, with the code
            // carried along so the page can say why it opened there.
            onAction: () => { this.openSettings(userError.code); },
          }
        : {}),
    });
  }

  /**
   * Open the settings page on the pane that owns `code`.
   *
   * The background resolves this to exactly one options tab (a second tab would
   * be a second pagehide settings writer). `openOptionsPage` remains the
   * fallback for a runtime that cannot answer at all — otherwise a worker
   * restarting at that moment would leave a dead button. A runtime that answers
   * `{opened:false}` opened nothing either, so it takes the same fallback: the
   * chatter clicked «Настройки» and must end up in Settings.
   */
  private openSettings(code: string): void {
    const route = resolveOptionsRouteForCode(code);
    void sendRuntimeRequest('openOptions', {
      pane: route.pane,
      ...(route.code ? { code: route.code } : {}),
    })
      .then((response) => {
        if (!response?.opened) {
          void browser.runtime.openOptionsPage();
        }
      })
      .catch(() => {
        void browser.runtime.openOptionsPage();
      });
  }

  init(): void {
    this.port.connect();
    startRouteWatcher((groupId) => this.handleRouteChange(groupId));
    this.installKeymap();
    this.launcher.mount();
  }

  openSpendersBoard(): void {
    this.dispatchBootstrapHotkey(
      'spenders-board',
      parseGroupIdFromPath(window.location.pathname),
    );
  }

  dispatchBootstrapHotkey(
    action: HotkeyAction,
    expectedGroupId: string | null,
  ): boolean {
    const generation = ++this.pendingInitialHotkeyGeneration;
    const conversationBound = !isGlobalHotkeyAction(action);
    if (conversationBound && expectedGroupId === null) {
      return false;
    }
    if (hotkeyNeedsInitialTabState(action) && !this.tabState) {
      void this.whenInitialTabStateReady().then(() => {
        if (generation !== this.pendingInitialHotkeyGeneration) {
          return;
        }
        if (
          conversationBound &&
          parseGroupIdFromPath(window.location.pathname) !== expectedGroupId
        ) {
          return;
        }
        this.dispatchHotkey(action);
      });
      return true;
    }
    if (
      conversationBound &&
      parseGroupIdFromPath(window.location.pathname) !== expectedGroupId
    ) {
      return false;
    }
    return this.dispatchHotkey(action);
  }

  /** Cold bootstrap actions that depend on account/persona state wait for the
   * first authoritative background projection. Opening Board or firing a
   * feature against the constructor's null state would otherwise flicker shut
   * or silently discard the user's first click. */
  whenInitialTabStateReady(): Promise<void> {
    return this.tabState ? Promise.resolve() : this.initialTabStateReady;
  }

  // ─── Hotkeys ────────────────────────────────────────────────────────────

  private installKeymap(): void {
    // Takes over from the bootstrap listener, feeding the same shared engine
    // (content/hotkey-input.ts) with EVERY keydown — modifiers included.
    document.addEventListener('keydown', (event) => {
      const decision = resolveHotkeyKeydown(
        event,
        isEditableElement(document.activeElement),
      );
      if (decision === null) return;
      const expectedGroupId = parseGroupIdFromPath(window.location.pathname);
      // Inside a chat every ChatGoose combo is ours: a retired habit, a
      // roll-over or an action that cannot run right now must not fall through
      // to find / print / page info. Outside a chat only the global actions
      // (Spenders, the cheatsheet) are claimed; the browser keeps the rest.
      const inChat = expectedGroupId !== null;
      if (decision.kind === 'swallow') {
        if (inChat) event.preventDefault();
        return;
      }
      if (decision.repeat) {
        if (inChat || isGlobalHotkeyAction(decision.action)) event.preventDefault();
        return;
      }
      if (this.dispatchBootstrapHotkey(decision.action, expectedGroupId) || inChat) {
        event.preventDefault();
      }
    });
  }

  private dispatchHotkey(action: HotkeyAction): boolean {
    // A reference surface (cheatsheet / spenders board) covers the result
    // surfaces. Starting a paid generation under it spends quota blind — the
    // loader and result render beneath the sheet. The surfaces' own toggles and
    // CANCEL pass (an operation can already be running under the sheet);
    // feature-starting actions are swallowed with an explanation.
    const referenceSurfaceOpen =
      (this.cheatsheetController?.isOpen() ?? false) ||
      (this.boardController?.isOpen() ?? false);
    if (
      referenceSurfaceOpen &&
      action !== 'cheatsheet' && action !== 'spenders-board' && action !== 'cancel'
    ) {
      this.toast.show('Сначала закройте справку (Esc) — панель ChatGoose под ней не видна.', {
        tone: 'warning',
      });
      return true; // handled: never fall through to a browser default
    }
    const feature = HOTKEY_FEATURE[action];
    if (feature) {
      if (!this.currentGroupId) return false;
      if (feature === 'help-me') {
        this.openCoachPreset();
      } else {
        this.startFeature(feature, false);
      }
      return true;
    }
    switch (action) {
      case 'cycle-tone':
        this.cycleNextReplyTone();
        return true;
      case 'toggle-split':
        this.toggleNextFastReplyMode();
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
    const personaDefinitionId = this.tabState?.mappedPersonaDefinitionId?.trim();
    if (!personaDefinitionId) {
      // No mapped definition means there is no safe persona scope for the Hub
      // read. Do not issue an unscoped query that could confirm another
      // persona's recap; keep the picker in its honest unavailable state.
      this.recapPickerModel = {
        ...picker,
        recapStatus: { state: 'unavailable', full: null, short: null },
      };
      this.renderSurfaces();
      return;
    }
    try {
      const status = await sendRuntimeRequest('getRecapStatus', {
        groupId,
        fanAccountId: null,
        personaDefinitionId,
      });
      if (this.recapPickerModel !== picker) {
        return;
      }
      this.recapPickerModel = {
        ...picker,
        recapStatus: isRecapStatusResponse(status)
          ? status
          : { state: 'unavailable', full: null, short: null },
      };
      this.renderSurfaces();
    } catch {
      if (this.recapPickerModel !== picker) {
        return;
      }
      this.recapPickerModel = {
        ...picker,
        recapStatus: { state: 'unavailable', full: null, short: null },
      };
      this.renderSurfaces();
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
    this.activeSummaryMode = mode;
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
   * local cache or fails with `no_saved_recap`). It tries the freshest slot
   * first, then falls back to the OTHER size before giving up with a toast — the
   * local cache may hold one size but not the other (e.g. a short generated here
   * while the full lives only on the Hub, or an unknown status defaulting to
   * full). When neither slot is known to exist we toast without an op. */
  private openLastRecap(): void {
    const status = this.recapPickerModel?.recapStatus ?? this.activeCoachSession?.recapStatus ?? null;
    this.closeRecapPicker();
    let mode: 'short' | 'full';
    let fallback: 'short' | 'full' | null;
    if (status && status.state !== 'unavailable') {
      const picked = pickFreshestSlotMode(status);
      if (picked === null) {
        // Status is loaded and empty — no round-trip needed, just toast.
        this.showUserErrorToast(getErrorMessage('no_saved_recap'));
        this.renderAll();
        return;
      }
      mode = picked;
      fallback =
        picked === 'full' ? (status.short ? 'short' : null) : (status.full ? 'full' : null);
    } else {
      // Status unknown/unavailable: let the local cache be the source of truth —
      // try the durable full recap first, then short (two real misses toast).
      mode = 'full';
      fallback = 'short';
    }
    if (this.activeFeature || this.activeCompareModel?.operationId || this.coachRecapChain) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    if (!this.ensureFeatureCanStart('fan-summary')) {
      return;
    }
    this.viewLastFallbackMode = fallback;
    this.dispatchViewCachedRecap(mode);
  }

  /** Send a single view-cached-only recap op (spec §5). Caller has already run
   * the prereq guards; a `no_saved_recap` terminal retries {@link
   * viewLastFallbackMode} once (in the error handler) before toasting. */
  private dispatchViewCachedRecap(mode: 'short' | 'full'): void {
    const operationId = crypto.randomUUID();
    const domFanDisplayName = getActiveConversationDisplayName();
    this.initializeFeatureOperation('fan-summary', operationId, domFanDisplayName, undefined);
    this.activeSummaryMode = mode;
    const payload: OperationStartPayload = {
      ...this.buildOperationStartPayload('fan-summary', operationId, domFanDisplayName, undefined, false),
      viewCachedOnly: true,
      ...(mode === 'short' ? { summaryMode: 'short' as const } : {}),
    };
    const sent = this.port.send(payload);
    if (!sent) {
      this.viewLastFallbackMode = null;
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
    this.boardController?.close();
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
    );
  }

  private renderAll(): void {
    this.renderSurfaces();
    this.renderButtonBar();
  }

  private renderSurfaces(): void {
    this.cancelScheduledLoadingRender();

    const plan = planSurfaces({
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
    });
    // Scroll compensation protects the Fansly conversation only when our
    // inline surface can grow beside the composer. Body-level Overlay/Coach
    // renders do not change this root; probing their every streaming frame
    // forced two needless layouts of the large host subtree.
    const scrollSnapshot =
      plan.inline.kind === 'render'
        ? captureScrollSnapshot(this.root)
        : null;
    try {
      this.applySurfacePlan(plan);
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

    const variantKey =
      featureRequiresDraft(this.lastFeature) && this.inlineImprove
        ? this.inlineImprove.variantKey
        : this.buildFeatureCacheKey(
            this.lastFeature,
            featureRequiresDraft(this.lastFeature)
              ? getActiveConversationDraftText()
              : undefined,
          );
    return this.completedOverlayCache.get(
      this.currentGroupId,
      this.lastFeature,
      this.overlayCacheIdentity(variantKey),
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
    return this.buildImproveDraftCacheKey(
      draftText,
      featureSupportsReplyMode(feature) ? this.nextFastReplyMode : undefined,
    ) ?? undefined;
  }

  private restoreCachedFeatureResult(
    feature: FeatureType,
    cachedResult: CompletedOverlayViewModel,
    improvePin: { variantKey: string; draftText: string } | null,
  ): void {
    this.lastFeature = feature;
    if (featureRequiresDraft(feature) && cachedResult.kind === 'reply') {
      this.presentImproveDraftResult(cachedResult, improvePin);
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

  private ensureFeatureCanStart(feature: FeatureType, draftText?: string): boolean {
    if (!this.tabState) {
      return false;
    }

    if (!this.isHubTransportConfigured()) {
      this.showUserErrorToast(getErrorMessage('hub_missing_api_key'));
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
    if (featureRequiresDraft(feature) && !(draftText ?? getActiveConversationDraftText()).trim()) {
      this.toast.show('Write a draft in the composer first, then use Fix.', {
        tone: 'warning',
      });
      this.renderButtonBar();
      return false;
    }

    return true;
  }

  private isHubTransportConfigured(): boolean {
    // Despite its legacy name, hasApiKey is produced from the normalized Hub
    // URL plus either Hub credential. Provider-specific key hints are dead
    // pre-kernel state and must not override that transport truth.
    return this.tabState?.hasApiKey ?? false;
  }

  /** Refresh keeps recap size identity. Full and short retain separate last-good
   * surfaces while the replacement runs; every other feature keeps the legacy
   * single-slot clear-before-rerun behavior. */
  private rerunFeature(feature: FeatureType, recapMode?: RecapMode): void {
    if (feature === 'fan-summary') {
      this.startStandaloneRecap(recapMode ?? 'full');
      return;
    }
    // E142: Regenerate on a pinned Split Fix rewrites the draft it came from,
    // even after part 1 was inserted or sent.
    const pinnedDraft = featureRequiresDraft(feature) ? this.inlineImprove?.draftText : undefined;
    this.completedOverlayCache.clearFeature(this.currentGroupId, feature);
    // E79: a cached standalone Help result reruns as Coach's situation preset.
    if (feature === 'help-me') {
      this.openCoachPreset();
      return;
    }
    this.startFeature(feature, true, pinnedDraft);
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
    // Same tick as buildOperationStartPayload's `groupId: this.currentGroupId`,
    // so the capture always matches the group the kernel request names.
    this.activeOperationGroupId = this.currentGroupId;
    this.activePersonaKey = this.tabState?.mappedPersonalityId ?? null;
    this.activePersonaDefinitionId = this.tabState?.mappedPersonaDefinitionId ?? null;
    this.activePersonaSource = this.tabState?.mappedPersonaSource ?? null;
    this.activeFanDisplayName = domFanDisplayName ?? 'fan';
    this.lastFeature = feature;
    this.overlayRawText = '';
    this.activeImproveDraftCacheKey = improveDraftCacheKey ?? null;
    this.inlineImprove = null;
    // Default to a full-summary run; standalone short/«Открыть последний» set
    // this AFTER init so completion selects the matching availability/display
    // slot and Refresh can preserve the exact size.
    this.activeSummaryMode = null;
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
      const improvePin = this.activeImproveDraftCacheKey && this.activeImproveDraftText
        ? { variantKey: this.activeImproveDraftCacheKey, draftText: this.activeImproveDraftText }
        : null;
      this.clearOperationState(false);
      if (completedModel.kind === 'reply') {
        this.presentImproveDraftResult(completedModel, improvePin);
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

  private startFeature(
    feature: FeatureType,
    forceRegenerate: boolean,
    draftOverride?: string,
  ): void {
    // Defensive routing fence: every production caller handles Help explicitly,
    // and a future generic caller still must not revive standalone generation.
    if (feature === 'help-me') {
      this.openCoachPreset();
      return;
    }
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
      ? (draftOverride ?? getActiveConversationDraftText()).trim()
      : undefined;
    const improveDraftCacheKey = this.buildFeatureCacheKey(feature, draftText);
    const improvePin = improveDraftCacheKey !== undefined && draftText
      ? { variantKey: improveDraftCacheKey, draftText }
      : null;

    const cachedResult =
      !forceRegenerate
        ? this.completedOverlayCache.get(
            this.currentGroupId,
            feature,
            this.overlayCacheIdentity(improveDraftCacheKey),
            feature === 'fan-summary' ? recapOverlayCacheSlot('full') : 'default',
          )
        : null;
    if (cachedResult) {
      this.restoreCachedFeatureResult(feature, cachedResult, improvePin);
      return;
    }

    if (!this.ensureFeatureCanStart(feature, draftText)) {
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
    this.activeImproveDraftText = improvePin?.draftText ?? null;

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

    // An idle open coach yields to Compare too (spec §3), session retained; the
    // standalone Recap dialog is likewise superseded (mirror startFeature).
    if (this.coachOverlayModel) {
      this.closeCoach();
    }
    this.recapPickerModel = null;

    if (!this.tabState) {
      return;
    }
    if (!this.isHubTransportConfigured()) {
      this.showUserErrorToast(getErrorMessage('hub_missing_api_key'));
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

  // ─── Voice (лента) ──────────────────────────────────────────────────

  private openVoicePanel(): void {
    if (!this.tabState?.voiceNotesCapable || !this.currentGroupId) {
      return;
    }
    // Reopen an existing attempt for this conversation without re-reading the
    // draft (the flow may already be past the script step). Close revoked the
    // take blob: URLs but kept the audio bytes — re-mint them so retained takes
    // are playable again.
    if (this.voiceController && this.voicePanel) {
      this.voiceController.resumeBlobUrls();
      this.voicePanel.setFanUsername(getActiveConversationDisplayName());
      this.voicePanel.open();
      return;
    }

    // Boot first: an already-paid/recoverable attempt belongs to this route
    // even when the composer is now empty. The draft gate applies only when no
    // session attempt exists and we would start a brand-new script.
    const draft = getActiveConversationDraftText().trim();
    this.createVoiceController();
    void this.startVoiceFlow(draft);
  }

  private createVoiceController(): void {
    const groupId = this.currentGroupId;
    if (!groupId) {
      return;
    }
    const adapter = new VoiceAttachAdapter(document, groupId);
    const controller = new VoiceAttemptController({
      port: { send: (message) => this.port.send(message) },
      route: {
        accountId: this.tabState?.accountId ?? '',
        groupId,
        routeNonce: this.routeNonce,
      },
      // The panel is constructed hidden while boot/recovery runs. Late audio
      // may arrive in that window, so object URLs are minted only at open.
      blobUrlsInitiallySuspended: true,
      onChange: () => this.scheduleVoicePanelRender(),
      onError: (message) => this.voicePanel?.handleError(message),
      onAttachGrant: (message) => {
        const task = this.voicePanel?.handleAttachGrant(message);
        if (task) {
          this.runVoiceControllerTask(task);
        }
      },
      onCustodyFailure: (error) => {
        this.handleVoiceFlowFailure(controller, error, 'runtime');
      },
    });
    this.voiceController = controller;

    const panel = new VoicePanel({
      controller,
      probeComposer: () => adapter.probeComposer(),
      attach: async ({ voiceNoteId, audio, token }) => {
        const probe = adapter.probeComposer();
        if (!probe.ok) {
          return 'uncertain';
        }
        const file = new File([audio], `voice-note-${voiceNoteId}.mp3`, {
          type: 'audio/mpeg',
        });
        // The token is armed only at the moment of the final attach action.
        adapter.arm(token);
        return adapter.attach(probe.input, file);
      },
      getDraftText: () => getActiveConversationDraftText(),
      setDraftText: async (text) => {
        try {
          await insertIntoFanslyTextarea(text);
        } catch {
          // The composer went away; the panel already keeps the original text.
        }
      },
      onClose: () => this.closeVoicePanel(),
      onExpand: () => this.expandVoiceStudio(),
      onAttachConfirmed: () => {
        // Spec 2026-07-24 (E55): a confirmed attach completes the session —
        // the Fansly thread is the source of truth now. Storage cleanup
        // finishes in the background; a failure there is recovered by TTL.
        const completing = this.voiceController;
        void completing?.completeAttempt().catch(() => undefined);
        this.teardownVoice();
        // The old panel offered to clear the leftover source text; the panel
        // now closes, so the affordance rides the toast — SCOPED to the
        // conversation and draft it was minted for (review P1: the toast
        // outlives route changes and later typing; never clear foreign or
        // newer text).
        const mintedGroupId = this.currentGroupId;
        const mintedDraft = getActiveConversationDraftText();
        this.toast.show('Войс прикреплён.', {
          tone: 'info',
          actionLabel: 'Очистить черновик',
          onAction: () => {
            if (
              this.currentGroupId !== mintedGroupId ||
              getActiveConversationDraftText() !== mintedDraft
            ) {
              return;
            }
            void insertIntoFanslyTextarea('').catch(() => undefined);
          },
        });
      },
      onStartNewFromDraft: (draft) => {
        const controller = this.voiceController;
        // Serialized (review P2): a double click before the async discard/
        // persist settles could mint two attempts and orphan one custody row.
        if (!controller || this.voiceNewStartInFlight) {
          return;
        }
        this.voiceNewStartInFlight = true;
        void controller.startScript(draft, 'none')
          .catch((error) => {
            this.handleVoiceFlowFailure(controller, error, 'start');
          })
          .finally(() => {
            this.voiceNewStartInFlight = false;
          });
      },
      // Collapse the студия the moment the attach handoff begins so Fansly's
      // native Upload modal isn't stranded behind the studio scrim. No-op when
      // the студия is already folded (the лента attach path).
      onAttachHandoff: () => this.voiceStudio?.collapse(),
    });
    this.voicePanel = panel;
    this.root.append(panel.root);

    // The студия is the same components in a two-column overlay, driven by the
    // same controller. Built lazily here so «⤢ развернуть в студию» has a target.
    this.voiceStudio = new VoiceStudio({
      panel,
      onCollapse: () => undefined,
    });
  }

  private expandVoiceStudio(): void {
    this.voiceStudio?.expand();
  }

  private async startVoiceFlow(draft: string): Promise<void> {
    const controller = this.voiceController;
    if (!controller) {
      return;
    }
    let recovered;
    try {
      recovered = await controller.boot();
    } catch (error) {
      this.handleVoiceFlowFailure(controller, error, 'recovery');
      return;
    }
    if (this.voiceController !== controller) {
      return;
    }
    if (!recovered) {
      if (!draft) {
        this.toast.show('Напишите черновик в поле — из него сделаем войс.', {
          tone: 'warning',
        });
        this.teardownVoice();
        return;
      }
      try {
        await controller.startScript(draft, 'none');
      } catch (error) {
        this.handleVoiceFlowFailure(controller, error, 'start');
        return;
      }
    }
    if (this.voiceController !== controller || !this.voicePanel) {
      return;
    }
    try {
      controller.resumeBlobUrls();
      this.voicePanel.setFanUsername(getActiveConversationDisplayName());
      this.voicePanel.open();
    } catch (error) {
      this.handleVoiceFlowFailure(controller, error, 'start');
    }
  }

  private handleVoiceFlowFailure(
    controller: VoiceAttemptController,
    error: unknown,
    stage: 'recovery' | 'start' | 'runtime',
  ): void {
    console.error(`[ChatGoose][voice] ${stage} failed`, error);
    if (this.voiceController !== controller) {
      return;
    }
    this.teardownVoice();
    if (error instanceof VoiceAttemptCustodyError) {
      // 'rejected' is a background validation refusal (historically a transient
      // identity race) — advising a tab reload here was actively harmful: the
      // reload re-triggers the captures that recreated the race. 'unavailable'
      // is a transport failure (background gone/waking) — retry is the honest
      // advice. Only a truly mixed-version protocol ('reload_required') earns
      // the reload advice.
      this.toast.show(
        error.code === 'rejected'
          ? 'Не удалось подтвердить чат для войса — попробуйте ещё раз.'
          : error.code === 'unavailable'
            ? 'Фон расширения не ответил — попробуйте ещё раз через пару секунд.'
            : error.code === 'conflict'
              ? 'Войс изменился в другой вкладке. Перезагрузите эту вкладку Fansly, чтобы продолжить.'
              : 'Хранилище войса недоступно. Перезагрузите вкладку Fansly после обновления расширения.',
        { tone: 'warning' },
      );
      return;
    }
    if (stage === 'recovery') {
      this.toast.show(
        'Не удалось восстановить сохранённый войс. Перезагрузите вкладку и попробуйте ещё раз.',
        { tone: 'warning' },
      );
      return;
    }
    this.toast.show(
      'Не удалось начать войс. Проверьте подключение и попробуйте ещё раз.',
      { tone: 'warning' },
    );
  }

  /** Custody failures already reached handleVoiceFlowFailure synchronously.
   * This shared sink prevents intentionally fire-and-forget Port/reconnect
   * tasks from leaking rejected promises after teardown. */
  private runVoiceControllerTask(task: Promise<unknown>): void {
    void task.catch((error) => {
      if (!(error instanceof VoiceAttemptCustodyError)) {
        console.error('[ChatGoose][voice] controller task failed', error);
      }
    });
  }

  private scheduleVoicePanelRender(): void {
    if (this.voiceRenderFrame !== null) {
      return;
    }
    const controller = this.voiceController;
    this.voiceRenderFrame = window.requestAnimationFrame(() => {
      this.voiceRenderFrame = null;
      if (this.voiceController !== controller) {
        return;
      }
      this.voicePanel?.render();
    });
  }

  private cancelVoicePanelRender(): void {
    if (this.voiceRenderFrame === null) {
      return;
    }
    window.cancelAnimationFrame(this.voiceRenderFrame);
    this.voiceRenderFrame = null;
  }

  private closeVoicePanel(): void {
    // If the студия is open, fold its borrowed nodes back into the лента first
    // so the panel is whole before it hides (blob URLs are only suspended, not
    // revoked, by the collapse itself).
    if (this.voiceStudio?.isOpen()) {
      this.voiceStudio.collapse();
    }
    // Release the media engines before revoking their backing object URLs.
    this.voicePanel?.suspendPlayers();
    this.voicePanel?.hide();
    // Drop the take object URLs while the panel is hidden (the audio bytes stay
    // in memory); reopen re-mints them.
    this.voiceController?.suspendBlobUrls();
  }

  private teardownVoice(): void {
    this.cancelVoicePanelRender();
    this.voiceStudio?.destroy();
    this.voiceStudio = null;
    // Clear <audio src> + load() before the controller revokes blob URLs.
    this.voicePanel?.dispose();
    this.voiceController?.destroy();
    this.voiceController = null;
    this.voicePanel?.root.remove();
    this.voicePanel = null;
    this.voiceReconnectPending = false;
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
      this.inlineImprove = null;
      // Voice is bound to the conversation route (its attach attestation checks
      // the exact tuple): a new conversation gets a fresh controller. The old
      // attempt survives in storage.session, recoverable if the chatter returns.
      this.teardownVoice();
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
        // before touching either completed cache or recap-availability slot.
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
      // The re-render reconciles the EXISTING coach view in place, so it never
      // moves focus by itself — «focus if open» has to be asked for explicitly.
      this.overlay.focusCoachComposer();
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
    // Coach rides the same preconditions as every generation (hub transport,
    // catalog, mapping, connection). The button bar already refuses for these
    // reasons; the hotkey must not open a panel whose submit is doomed to a
    // bare background error. ensureFeatureCanStart shows the reason itself.
    if (!this.ensureFeatureCanStart('coach-chat')) {
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
    // Review P1: a snapshot from a prior open/settings state must never be
    // rendered — drop it BEFORE the first rebuild (fallbacks apply until the
    // fresh read lands under this open's generation).
    this.coachSettingsSnapshot = null;
    this.coachSettingsSnapshotGeneration += 1;
    this.rebuildCoachModel();
    this.renderAll();
    // Recap-status read (spec §5): async, best-effort — it must never block or
    // break opening; null slots are fine.
    const promise = this.refreshCoachRecapStatus(session);
    this.coachRecapStatusRead = { session, promise };
    // Coach UI settings snapshot (spec §7): async, best-effort — a failure just
    // leaves the menu label without its value and the memory divider unrendered.
    void this.refreshCoachSettingsSnapshot(this.coachSettingsSnapshotGeneration);
  }

  /** Help is a zero-typing Coach turn. The canonical question stays in the
   * kernel (Core Decision #204); this client sends only the preset literal. */
  private openCoachPreset(): void {
    this.openCoach();
    if (
      !this.activeCoachSession ||
      this.activeFeature ||
      this.activeCompareModel?.operationId ||
      this.coachRecapChain ||
      this.coachSubmitPreflights.has(this.activeCoachSession)
    ) {
      return;
    }
    void this.submitCoachQuestion('', { preset: true, fromComposer: false });
  }

  /** Drop the coach overlay while RETAINING the store session for reopen (spec
   * §3). This does NOT itself tear down a streaming coach turn or a recap-chain
   * op — every caller must have already cancelled/suppressed any live op first
   * (onClose routes a live chain through cancelCoachRecapChain; route/persona
   * paths suppress + cancel). The `coachRecapChain = null` below is only a
   * belt-and-braces reference drop for an ALREADY-torn-down chain, never an op
   * teardown — reaching here with an un-cancelled op would leak it. */
  private closeCoach(): void {
    this.coachOverlayModel = null;
    this.activeCoachSession = null;
    this.coachPendingAnswerText = '';
    this.coachRecapChain = null;
  }

  /** Send the chatter's question as a coach turn (spec §3), possibly gated by an
   * auto-recap chain (spec §5). Async because the auto-recap decision AND the
   * wire history need live settings (`coachAutoRecap`, `deepMessageCount`,
   * `coachHistoryLimit`); a synchronous same-session preflight guard blocks a
   * re-entrant submit across the await. */
  /** The ONE pre-dispatch abort (review round 13 — it was hand-duplicated in
   * three spellings): restore a composer-typed question, re-arm a Retry's
   * re-read intent, optionally re-render. Canned questions are never written
   * into the composer (round 8); the failed-attempt «Повторить» remains their
   * recovery affordance. */
  private abortCoachSubmit(
    session: CoachSession,
    question: string,
    opts: CoachSubmitOpts | undefined,
    options: { render?: boolean } = {},
  ): void {
    if (opts?.fromComposer !== false) {
      restoreCoachComposerText(session, question);
    }
    if (opts?.forceDraftRead) {
      this.coachStore.setDraftIntent(session, true);
    }
    if (options.render !== false && this.activeCoachSession === session) {
      this.rebuildCoachModel();
      this.renderAll();
    }
  }

  async submitCoachQuestion(
    question: string,
    opts?: CoachSubmitOpts,
  ): Promise<void> {
    const session = this.activeCoachSession;
    if (!session) {
      return;
    }
    const trimmed = opts?.preset ? COACH_SITUATION_PRESET_LABEL : question.trim();
    if (!trimmed) {
      return;
    }
    if (
      this.activeFeature ||
      this.activeCompareModel?.operationId ||
      this.coachRecapChain ||
      this.coachSubmitPreflights.has(session)
    ) {
      // The renderer clears the textarea BEFORE onCoachSubmit, so a rejected
      // submit must put the question back or it is silently lost (review P1).
      this.abortCoachSubmit(session, trimmed, opts);
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    const groupId = this.currentGroupId;
    if (!groupId) {
      this.showUserErrorToast(getErrorMessage('coach_fan_unresolved'));
      return;
    }

    const preflightToken = Symbol('coach-preflight');
    // «Новый диалог» during the await rotates sessionId on the SAME object
    // (review round 15): a reset dialog must never receive the pre-reset
    // question, so the submit aborts silently when the id changed (the reset's
    // own confirm already warned about unsent text).
    const sessionIdAtStart = session.sessionId;
    this.coachSubmitPreflights.set(session, preflightToken);
    let settings;
    try {
      // Project the lock immediately (review P1) — the await below opens a real
      // interaction window on slow storage. Inside the try (review round 9): a
      // throwing render must not strand the lock the finally alone resets.
      this.rebuildCoachModel();
      this.renderAll();
      ({ settings } = await readStorageState());
      const effectiveMode = resolveEffectiveAutoRecap(
        session.autoRecapOverride,
        settings.coachAutoRecap,
      );
      const statusRead = this.coachRecapStatusRead;
      if (
        !session.autoRecapAttempted &&
        effectiveMode !== 'off' &&
        statusRead?.session === session
      ) {
        await statusRead.promise;
      }
    } catch {
      // The settings read failed AFTER the renderer already cleared the composer
      // (it emits onCoachComposerInput('') before onCoachSubmit). Nothing was
      // armed yet — settings are read first — so restore the question into the
      // composer so it is not silently lost, and tell the user to retry.
      this.abortCoachSubmit(session, trimmed, opts);
      this.showUserErrorToast(getErrorMessage('settings_load_failed'));
      return;
    } finally {
      // Release only OUR token (review rounds 10/12): overlapping preflights of
      // other sessions — in either completion order — keep theirs.
      if (this.coachSubmitPreflights.get(session) === preflightToken) {
        this.coachSubmitPreflights.delete(session);
      }
      // Rebuild whatever coach is active NOW (review round 8): the preflight
      // may have started on a different fan's session.
      if (this.activeCoachSession) {
        this.rebuildCoachModel();
        this.renderAll();
      }
    }
    // «Новый диалог» during the await: the question belonged to the DISCARDED
    // dialog — do not dispatch it into the fresh one, do not restore it.
    if (session.sessionId !== sessionIdAtStart) {
      return;
    }
    // A route/persona change during the await tore the session/route down.
    if (this.activeCoachSession !== session || this.currentGroupId !== groupId) {
      this.abortCoachSubmit(session, trimmed, opts, { render: false });
      return;
    }
    // Defensive re-check: the in-flight guard blocked re-entrant submits, but a
    // terminal elsewhere could conceivably have armed an op during the await.
    if (this.activeFeature || this.activeCompareModel?.operationId || this.coachRecapChain) {
      this.abortCoachSubmit(session, trimmed, opts);
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    // Submit-time backstop: the preconditions can break while the panel is open
    // (mapping revoked, hub creds cleared, the conversation lost). Refusing HERE
    // — before the auto-recap chain and before the dispatch — is what keeps the
    // failure a named reason instead of a bare background error code.
    if (!this.ensureFeatureCanStart('coach-chat')) {
      // ensureFeatureCanStart already showed the reason toast. The renderer
      // cleared the textarea before onCoachSubmit — put the question back
      // exactly like the another_operation refusal above does.
      this.abortCoachSubmit(session, trimmed, opts);
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
        this.startCoachRecapChain(
          session,
          effectiveMode,
          'auto',
          trimmed,
          opts?.forceDraftRead ?? false,
          opts?.fromComposer !== false,
          opts?.preset ?? false,
        );
        return;
      }
    }

    this.sendCoachTurn(
      session,
      groupId,
      trimmed,
      settings.coachHistoryLimit,
      opts?.forceDraftRead ?? false,
      opts?.fromComposer !== false,
      opts?.preset ?? false,
    );
  }

  /** Arm the single-op markers + pending marker and send a coach turn (spec §3).
   * Synchronous — settings are already resolved by the caller.
   *
   * Draft attach (spec §5): the live Fansly draft is read ONCE here, immediately
   * before dispatch (after any recap step), when the session intent is armed OR a
   * Retry forces it (`forceDraftRead`). Only non-empty text is actually SENT
   * (`includedDraft = "sent"`, not "requested"). A dispatched turn consumes the
   * intent — reset to off after the start reaches the background; a
   * never-dispatched turn preserves it for the manual retry. */
  private sendCoachTurn(
    session: CoachSession,
    groupId: string,
    trimmed: string,
    coachHistoryLimit: number,
    forceDraftRead: boolean,
    fromComposer: boolean,
    preset: boolean,
  ): void {
    // Live draft read (spec §5): once, right before dispatch. `getActive…` is
    // synchronous, so nothing can mutate the composer between this read and the
    // start below.
    const attachDraft = coachDraftAttachAllowed(session.draftIntent || forceDraftRead);
    const liveDraft = attachDraft ? getActiveConversationDraftText().trim() : '';
    const draftText = liveDraft.length > 0 ? liveDraft : undefined;
    const includedDraft = draftText !== undefined;
    // Consume the intent BEFORE the pre-dispatch render (review P1: an armed,
    // clickable checkbox must not survive into the streaming turn's view) —
    // restored below if the start never reaches the background.
    const priorIntent = session.draftIntent;
    this.coachStore.setDraftIntent(session, false);

    const operationId = crypto.randomUUID();
    this.activeFeature = 'coach-chat';
    this.activeOperationId = operationId;
    this.activePersonaKey = this.tabState?.mappedPersonalityId ?? null;
    this.activePersonaDefinitionId = this.tabState?.mappedPersonaDefinitionId ?? null;
    this.activePersonaSource = this.tabState?.mappedPersonaSource ?? null;
    this.activeFanDisplayName = getActiveConversationDisplayName() ?? 'fan';
    this.lastFeature = 'coach-chat';
    this.coachStore.beginPending(
      session,
      trimmed,
      operationId,
      includedDraft,
      fromComposer,
      preset ? true : undefined,
    );
    this.coachPendingAnswerText = '';
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
      ...(preset
        ? { coachPreset: 'situation' as const }
        : { chatterQuestion: trimmed }),
      coachHistory,
      // Carry-forward 2: the session id keys the background transcript cache; a
      // per-tab fallback would lose «Новый диалог» reseed isolation.
      coachSessionId: session.sessionId,
      // «Обновить переписку» reseed key (spec §8.4).
      transcriptEpoch: session.transcriptEpoch,
      // Only a non-empty draft rides the wire (spec §5 / §9 protocol test).
      ...(draftText !== undefined ? { draftText } : {}),
    };
    // A throwing send is the same never-dispatched outcome as a false return
    // (review round 6): the rollback below must run for both.
    let sent = false;
    try {
      sent = this.port.send(payload);
    } catch {
      sent = false;
    }
    if (!sent) {
      // The port is mid-reconnect; the start never reached the background so no
      // terminal will arrive. The turn never started — clearPending (not a
      // failed-attempt), preserve the draft intent (never dispatched), and ask
      // the user to retry.
      this.coachStore.clearPending(session);
      // Never dispatched (spec §5): the consumed intent — and a Retry's re-read
      // intent — are restored for the manual resend (review P1).
      this.coachStore.setDraftIntent(session, priorIntent || forceDraftRead);
      if (fromComposer) {
        restoreCoachComposerText(session, trimmed);
      }
      this.clearCoachOperationState();
      this.showUserErrorToast(getErrorMessage('extension_reloaded'));
      this.rebuildCoachModel();
      this.renderAll();
      return;
    }
  }

  /** Retry a failed/cancelled turn: replays its question as a FRESH operation
   * (new UUID, freshly refreshed transcript background-side) — spec §8. If the
   * failed attempt had actually SENT a draft, Retry re-reads the CURRENT live
   * draft (spec §5): empty now → proceed without; a stale draft is never resent
   * from memory. */
  private async handleCoachRetry(
    question: string,
    includedDraft: boolean,
    preset?: true,
  ): Promise<void> {
    await this.submitCoachQuestion(question, {
      forceDraftRead: includedDraft,
      fromComposer: false,
      ...(preset ? { preset } : {}),
    });
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
    // A submit preflight is an armed question (review round 15): refuse the
    // reset like a mid-turn reset, instead of racing it.
    if (this.coachSubmitPreflights.has(session)) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    // The composer is locked while streaming, but the topbar New-dialog button
    // is not — refuse a reset mid-turn (the turn must terminate first) and say
    // so. A running recap step counts too: it rides `activeFeature ===
    // 'fan-summary'`, so guard on `coachRecapChain` as well or a mid-step reset
    // would orphan the chain (running step vanishes, composer locks on an
    // invisible op, and the OLD held question auto-submits into the reset dialog).
    if (this.activeFeature === 'coach-chat' || this.coachRecapChain) {
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
    this.startCoachRecapChain(session, mode, 'explicit', null, false, false, false);
  }

  /** Set the per-session auto-recap override from the «Рекап ▾» menu radio group
   * (spec §3): the four items map 1:1 to `inherit | off | short | full`. */
  private setCoachAutoRecapOverride(override: CoachAutoRecapOverride): void {
    const session = this.activeCoachSession;
    if (!session) {
      return;
    }
    if (session.autoRecapOverride === override) {
      return;
    }
    this.coachStore.setAutoRecapOverride(session, override);
    this.rebuildCoachModel();
    this.renderAll();
  }

  /** Toggle the draft-attach intent (spec §5). The model is rebuilt immediately
   * (no render — the checkbox already shows the clicked state) so a LATER render
   * from any path — e.g. the failed-insert inline error — cannot repaint the
   * checkbox from a stale view (review P2). */
  private handleCoachDraftIntentChange(intent: boolean): void {
    if (this.activeCoachSession) {
      this.coachStore.setDraftIntent(this.activeCoachSession, intent);
      this.rebuildCoachModel();
    }
  }

  /** «Обновить переписку» (spec §8.4): bump the content-owned transcript epoch so
   * the NEXT coach turn misses the background cache and reseeds the full quick
   * window. Feed, composer, auto-recap state, and history are untouched; there is
   * no live Fansly read on click and no dependency on a live service worker. */
  private handleCoachRefreshTranscript(): void {
    const session = this.activeCoachSession;
    if (!session) {
      return;
    }
    // Busy guard: the menu disables the item while streaming/recapping, but a
    // mid-turn epoch bump would still be harmless (it only affects the next
    // turn's cache key); refuse it anyway to match the menu's disabled state.
    if (this.activeFeature === 'coach-chat' || this.coachRecapChain) {
      return;
    }
    this.coachStore.bumpTranscriptEpoch(session);
    // Review round 5: the bump is state-only by design (spec §8.4 — no click-time
    // Fansly read), but the CLICK still needs an acknowledgment or the chatter
    // re-clicks a seemingly dead menu item.
    this.toast.show('Переписка обновится со следующим вопросом', {
      tone: 'info',
      dedupeKey: 'coach-refresh-transcript',
    });
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
    forceDraftRead: boolean,
    fromComposer: boolean,
    preset: boolean,
  ): void {
    if (this.activeFeature || this.activeCompareModel?.operationId || this.coachRecapChain) {
      this.showUserErrorToast(getErrorMessage('another_operation'));
      return;
    }
    // Prereqs unmet (no connection/mapping/persona): can't refresh. For an auto
    // chain this is a STOP — preserve the held question in the composer.
    if (!this.ensureFeatureCanStart('fan-summary')) {
      // A never-dispatched retry keeps its live-draft re-read intent (spec §5).
      if (forceDraftRead) {
        this.coachStore.setDraftIntent(session, true);
      }
      if (origin === 'auto' && fromComposer && pendingQuestion && session.composerText === '') {
        session.composerText = pendingQuestion;
      }
      // Render UNCONDITIONALLY after the mutations above (closing round): a
      // re-armed intent without a rebuild left the checkbox showing unchecked
      // while the session would attach — the state≠view class again.
      this.rebuildCoachModel();
      this.renderAll();
      return;
    }
    const step = this.coachStore.recordRecapStep(session, mode, origin);
    const operationId = crypto.randomUUID();
    const domFanDisplayName = getActiveConversationDisplayName();
    // Set the chain BEFORE initializeFeatureOperation so its renderSurfaces keeps
    // the coach overlay on top (the running step is already in the feed).
    this.coachRecapChain = {
      operationId,
      session,
      step,
      origin,
      pendingQuestion,
      forceDraftRead,
      fromComposer,
      preset,
    };
    this.initializeFeatureOperation('fan-summary', operationId, domFanDisplayName, undefined);
    this.rebuildCoachModel();
    // Recap refresh bypasses the summary/overlay caches (spec §5): forceRegenerate.
    const payload: OperationStartPayload = {
      ...this.buildOperationStartPayload('fan-summary', operationId, domFanDisplayName, undefined, true),
      summaryMode: mode,
    };
    // Belt-and-braces beside the PortClient-level mapping (round 14): a throw
    // here must take the same STOP rollback as a false return.
    let sent = false;
    try {
      sent = this.port.send(payload);
    } catch {
      sent = false;
    }
    if (!sent) {
      // The start never reached the background — treat as a STOP: fail the step,
      // preserve an auto chain's question, and drop the op markers.
      step.status = 'failed';
      if (forceDraftRead) {
        this.coachStore.setDraftIntent(session, true);
      }
      if (origin === 'auto' && fromComposer && pendingQuestion && session.composerText === '') {
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
  private handleCoachRecapChainComplete(
    message: Extract<BackgroundPortMessage, { type: 'operation:complete' }>,
  ): void {
    const { operationId } = message;
    const chain = this.coachRecapChain;
    if (!chain || chain.operationId !== operationId) {
      this.clearCoachOperationState();
      this.renderButtonBar();
      return;
    }
    chain.step.status = 'done';
    // A successful explicit refresh satisfies this session's one automatic
    // recap opportunity even if the following metadata GET is unavailable.
    // Otherwise an immediate first question can pay for the same recap twice.
    chain.session.autoRecapAttempted = true;
    // A successful full OR short recap makes the toolbar's ready badge honest:
    // the badge means there is something cached to open, not specifically a
    // Hub-synced full dossier.
    if (message.result.summaryMeta?.storedLocally !== false) {
      this.markRecapAvailable(chain.step.mode);
    }
    this.coachRecapChain = null;
    this.clearCoachOperationState();
    if (chain.session === this.activeCoachSession) {
      // The freshly generated recap changes the status slots — refresh them so a
      // later decision (and the status line) reflect it.
      const promise = this.refreshCoachRecapStatus(chain.session);
      this.coachRecapStatusRead = { session: chain.session, promise };
    }
    this.rebuildCoachModel();
    this.renderAll();
    if (chain.origin === 'auto' && chain.pendingQuestion && chain.session === this.activeCoachSession) {
      // autoRecapAttempted is already set, so this submit sends a plain turn.
      void this.submitCoachQuestion(chain.pendingQuestion, {
        forceDraftRead: chain.forceDraftRead,
        fromComposer: chain.fromComposer,
        ...(chain.preset ? { preset: true } : {}),
      });
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
    const { origin, pendingQuestion, session, step, forceDraftRead, fromComposer, preset } = chain;
    step.status = 'failed';
    this.coachRecapChain = null;
    this.clearCoachOperationState();

    if (classification === 'stop') {
      // Chain-stopping failure: preserve the held question for a manual resend;
      // a never-dispatched retry also keeps its re-read intent (spec §5).
      if (forceDraftRead) {
        this.coachStore.setDraftIntent(session, true);
      }
      if (origin === 'auto' && fromComposer && pendingQuestion && session.composerText === '') {
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
        void this.submitCoachQuestion(pendingQuestion, {
          forceDraftRead,
          fromComposer,
          ...(preset ? { preset: true } : {}),
        });
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
    if (chain.forceDraftRead) {
      this.coachStore.setDraftIntent(chain.session, true);
    }
    if (chain.origin === 'auto' && chain.fromComposer && chain.pendingQuestion && chain.session.composerText === '') {
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
    return `обновить Recap не удалось — использую рекап от ${formatCoachAgeMs(ageMs)}`;
  }

  /** Cancel a streaming coach turn (Esc / ⌘. / Ctrl+.): the terminal that follows is
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
    const preset = session.pending.preset;
    const answerRaw = message.result.rawText;
    // E81: debug provenance for the turn — priced spend + pipeline profile off
    // the complete payload, plus the E28 echo status accumulated mid-stream.
    // All three exist only while debugMode is on; captured BEFORE the op-state
    // clear below releases the echo/profiling markers.
    const debug = this.buildCoachTurnDebug(
      message.llmSpend,
      message.profiling ?? this.activeProfiling ?? undefined,
    );
    if (answerRaw.trim().length === 0) {
      this.coachStore.recordFailedAttempt(
        session,
        operationId,
        question,
        'ai_output_unusable',
        true,
        debug?.profiling,
      );
    } else {
      this.coachStore.commitExchange(session, {
        operationId,
        generationRef: message.generationRef ?? '',
        // A preset's display label is never replayed to the model. Core #204
        // returns the exact substituted question in meta for session history.
        question:
          preset && isCoachTurnContext(message.turnContext) && message.turnContext.presetQuestion
            ? message.turnContext.presetQuestion
            : question,
        answerRaw,
        ...(preset ? { preset } : {}),
        // Post-attach turn context (spec §8.2); absent from an old background →
        // the collapsed «Отправлено коучу…» line is simply not rendered. An
        // INVALID shape degrades the same way (closing round): validating it in
        // the message conjunction dropped the whole paid complete over a purely
        // presentational field — E28 holds by ignoring, not by rejecting.
        ...(isCoachTurnContext(message.turnContext) ? { turnContext: message.turnContext } : {}),
        ...(debug !== undefined ? { debug } : {}),
      });
    }
    this.clearCoachOperationState();
    this.rebuildCoachModel();
    this.renderAll();
    // A cold tab cannot check recap metadata until an operation resolves its
    // fan identity. Retry that unavailable read once after a usable answer;
    // refreshCoachRecapStatus fences the response to this same open session.
    if (answerRaw.trim() && session.recapStatus?.state === 'unavailable') {
      const promise = this.refreshCoachRecapStatus(session);
      this.coachRecapStatusRead = { session, promise };
    }
  }

  /** Assemble a coach turn's debug provenance (E81), or undefined when the
   * turn ran without debugMode. The profiling snapshot is the debug key: it is
   * attached to terminals only while the profiler is enabled, whereas llmSpend
   * flows regardless — so its presence alone must NOT decorate a non-debug
   * feed. The echo token stays in this heap object (E28): display wiring only
   * ever hands it to the runtime `openDebugPrompt` call, never to the DOM. */
  private buildCoachTurnDebug(
    llmSpend: LlmSpendSummary | undefined,
    profiling: OperationProfilingSnapshot | undefined,
  ): CoachTurnDebug | undefined {
    if (profiling === undefined) {
      return undefined;
    }
    const promptEcho = this.activeDebugEcho ?? undefined;
    return {
      profiling,
      ...(llmSpend !== undefined ? { llmSpend } : {}),
      ...(promptEcho !== undefined ? { promptEcho } : {}),
    };
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
    // E81: with debugMode on, retain the pipeline profile on the failed item —
    // the collapsed «Отладка» log shows WHERE the turn died.
    const profiling = message.profiling ?? this.activeProfiling ?? undefined;
    this.coachStore.recordFailedAttempt(session, operationId, question, errorCode, true, profiling);
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
      if (chain.fromComposer && chain.pendingQuestion && chain.session.composerText === '') {
        chain.session.composerText = chain.pendingQuestion;
      }
      // A never-dispatched retry keeps its live-draft re-read intent (spec §5,
      // review P1 — route/disconnect teardowns used to drop it).
      if (chain.forceDraftRead) {
        this.coachStore.setDraftIntent(chain.session, true);
      }
      chain.step.status = 'failed';
      this.coachRecapChain = null;
    }
    const session = this.activeCoachSession;
    if (session) {
      // Composer-typed pending questions only (review round 11): a dispatched
      // chip/Retry turn torn down here must not park its canned string.
      if (session.pending?.fromComposer && !session.composerText) {
        session.composerText = session.pending.question;
      }
      this.coachStore.clearPending(session);
    }
    this.coachOverlayModel = null;
    this.activeCoachSession = null;
    this.coachPendingAnswerText = '';
  }

  /** Port disconnect recovery (P1): a dead port means no terminal will arrive,
   * so a coach turn or recap chain left in-flight would keep the composer locked
   * forever (the model derives "busy" from a live pending / chain). Restore the
   * in-flight question into the composer and drop the pending marker / chain so
   * the reopened session is usable again. The coach OVERLAY is retained (the feed
   * survives); the shared op markers are cleared by the caller. */
  private recoverCoachOnDisconnect(): void {
    const chain = this.coachRecapChain;
    if (chain) {
      if (chain.fromComposer && chain.pendingQuestion && chain.session.composerText === '') {
        chain.session.composerText = chain.pendingQuestion;
      }
      // A never-dispatched retry keeps its live-draft re-read intent (spec §5,
      // review P1 — route/disconnect teardowns used to drop it).
      if (chain.forceDraftRead) {
        this.coachStore.setDraftIntent(chain.session, true);
      }
      chain.step.status = 'failed';
      this.coachRecapChain = null;
    }
    const session = this.activeCoachSession;
    if (session?.pending) {
      if (session.pending.fromComposer && !session.composerText) {
        session.composerText = session.pending.question;
      }
      this.coachStore.clearPending(session);
    }
    this.coachPendingAnswerText = '';
    this.rebuildCoachModel();
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
          // Correlation fallback for draft acceptance after SW restart (P2).
          ...(exchange.generationRef ? { generationRef: exchange.generationRef } : {}),
          question: exchange.preset ? COACH_SITUATION_PRESET_LABEL : exchange.question,
          ...(exchange.preset ? { preset: exchange.preset } : {}),
          answerProse: prose,
          drafts: exchange.drafts.map((draft) => ({ text: draft.text, index: draft.index })),
          // Collapsed «Отправлено коучу…» line (spec §8.2); absent → no line.
          ...(exchange.turnContext !== undefined ? { turnContext: exchange.turnContext } : {}),
          // Debug provenance (E81): the SAME object as the store's — the
          // renderer's rebuild decision relies on reference stability.
          ...(exchange.debug !== undefined ? { debug: exchange.debug } : {}),
        };
      }
      if (item.kind === 'failed-attempt') {
        return {
          kind: 'failed-attempt',
          question: item.question,
          errorCode: item.errorCode,
          retryable: item.retryable,
          includedDraft: item.includedDraft,
          ...(item.preset ? { preset: item.preset } : {}),
          ...(item.profiling !== undefined ? { profiling: item.profiling } : {}),
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
    // E81: progress is trusted only when it belongs to the live pending op —
    // a stale frame from a superseded turn must not caption the new one.
    const pendingProgress =
      session.pending && this.activeProgress?.operationId === session.pending.operationId
        ? this.activeProgress
        : null;
    // "Busy" also covers a running recap step for THIS session (spec §5): the
    // composer locks and the whole chain is cancellable via the top-level op.
    const chainOpId =
      this.coachRecapChain?.session === session ? this.coachRecapChain.operationId : null;
    // The submit preflight (settings/status await) counts as busy too (review
    // P1): the composer, chips and topbar must lock the moment a chip fires,
    // or a second Send in that window clears text the guard then rejects.
    const busy = streaming || chainOpId !== null || this.coachSubmitPreflights.has(session);
    return {
      kind: 'coach',
      fanDisplayName: getActiveConversationDisplayName() ?? 'fan',
      operationId: session.pending?.operationId ?? chainOpId,
      sessionView: {
        feedItems,
        pendingQuestion: session.pending?.question,
        pendingAnswerText: streaming ? this.coachPendingAnswerText : undefined,
        // E81: wait narration + elapsed anchor + (debug-only) live stage log
        // for the pending bubble.
        ...(session.pending
          ? {
              pendingWaitLabel: formatCoachWaitStatus(
                pendingProgress?.stageKey,
                pendingProgress?.currentPage,
                pendingProgress?.targetPages,
              ),
              pendingStartedAt: session.pending.startedAt,
              ...(pendingProgress?.profiling !== undefined
                ? { pendingProfiling: pendingProgress.profiling }
                : {}),
            }
          : {}),
        recapStatusLine: formatCoachRecapStatusLine(session.recapStatus),
        composerText: session.composerText,
        composerEnabled: !busy,
        autoRecapOverride: session.autoRecapOverride,
        draftAttachEnabled: COACH_DRAFT_ATTACH_ENABLED,
        draftIntent: session.draftIntent,
        // §7 snapshot: absent (fallbacks) until the async read lands.
        ...(this.coachSettingsSnapshot !== null
          ? { settingsSnapshot: this.coachSettingsSnapshot }
          : {}),
        groupId: this.currentGroupId ?? '',
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
    const personaDefinitionId = this.tabState?.mappedPersonaDefinitionId?.trim();
    if (!personaDefinitionId) {
      if (this.activeCoachSession === session) {
        session.recapStatus = { state: 'unavailable', full: null, short: null };
        this.rebuildCoachModel();
        this.renderSurfaces();
      }
      return;
    }
    try {
      const status = await sendRuntimeRequest('getRecapStatus', {
        groupId,
        // The background resolves the fan for the canonical fanRef (§5); content
        // has no reliable fan account id, so it sends null.
        fanAccountId: null,
        personaDefinitionId,
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

  /** Hydrate/refresh the coach UI settings snapshot (spec §7): the two v15 fields
   * the renderer needs live — `coachHistoryLimit` (memory divider §8.1) and the
   * global `coachAutoRecap` default (the «По настройке (<x>)» menu label §3).
   * Best-effort: a read failure leaves the snapshot as-is (fallbacks apply).
   * Stale-session guard: only fold the result in while the SAME coach session is
   * still open, so a late read after close/switch never disturbs a new dialog. */
  private async refreshCoachSettingsSnapshot(generation: number): Promise<void> {
    let snapshot: CoachSettingsSnapshot;
    try {
      const { settings } = await readStorageState();
      snapshot = {
        coachHistoryLimit: settings.coachHistoryLimit,
        coachAutoRecap: settings.coachAutoRecap,
      };
    } catch {
      // Snapshot stays null under this generation → honest fallbacks (menu label
      // without its value, divider unrendered) — never a stale prior value.
      return;
    }
    if (generation !== this.coachSettingsSnapshotGeneration || !this.activeCoachSession) {
      return;
    }
    this.coachSettingsSnapshot = snapshot;
    this.rebuildCoachModel();
    this.renderSurfaces();
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
    // A message means the port is live again: re-arm any recoverable voice work
    // (the same idempotent create/status calls) from the persisted snapshot.
    if (this.voiceReconnectPending && this.voiceController) {
      this.voiceReconnectPending = false;
      this.runVoiceControllerTask(this.voiceController.handlePortReconnect());
    }
    switch (message.type) {
      case 'tab:state':
      case 'settings:changed':
      case 'mapping:changed': {
        const personaChanged = this.personaIdentityChanged(message.state);
        // An id that differs but ALIASES the previous one is an identity
        // REFINEMENT: the background's budgeted capability probe resolved the
        // canonical account id after the first push (legacy → canonical, same
        // creator). Tearing coach/voice/board down for it wiped a typed coach
        // question in the 0.8–5s cold-start window — the review finding that
        // minted accountIdAliases. Only a REAL switch tears down.
        const previousAccountId = this.tabState?.accountId ?? null;
        const accountRefined = Boolean(
          previousAccountId &&
          previousAccountId !== message.state.accountId &&
          (message.state.accountIdAliases ?? []).includes(previousAccountId),
        );
        const accountChanged = Boolean(
          this.tabState &&
          previousAccountId !== message.state.accountId &&
          !accountRefined,
        );
        if (
          message.type === 'settings:changed' ||
          (previousAccountId !== message.state.accountId && !accountRefined)
        ) {
          this.boardContextGeneration += 1;
          this.boardController?.invalidateContext();
        }
        if (personaChanged) {
          this.clearPersonaBoundFeatureState();
        }
        if (personaChanged || accountChanged) {
          // Voice custody is bound to the creator account as well as the group.
          // Preserve the old attempt in session storage, but never keep its
          // live controller across an account switch.
          if (accountChanged) {
            this.teardownVoice();
          }
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
        this.resolveInitialTabState?.();
        this.resolveInitialTabState = null;
        // Coach UI settings snapshot (spec §7): a settings change may alter
        // coachHistoryLimit / coachAutoRecap while Coach is open — refresh the
        // snapshot so the menu label and memory divider stay current. ALL
        // THREE events qualify: an ordinary settings write classifies as
        // 'mapping:changed', 'settings:changed' is the broad hub-context
        // event, and 'tab:state' replays after a port RECONNECT (review round
        // 10 — a settings change made while the port was down had no event to
        // carry it). The shown snapshot is KEPT until the fresh read resolves
        // (review round 5: nulling first made the memory divider blink) — the
        // generation guard discards stale resolves, and the atomic swap makes
        // an unchanged re-read a no-op.
        if (this.activeCoachSession) {
          this.coachSettingsSnapshotGeneration += 1;
          void this.refreshCoachSettingsSnapshot(this.coachSettingsSnapshotGeneration);
        }
        void this.mappingBanner.render(
          message.state.accountId,
          Boolean(message.state.mappedPersonalityId),
          message.state.signedIn,
        );
        if (personaChanged || accountChanged) {
          // An account-only change (background resolving the canonical accountId,
          // operations.ts refreshTabState('mapping:changed')) tears the coach
          // state down above but used to skip this render — leaving the DEAD
          // panel of the previous account on screen, scroll-lock included.
          this.renderSurfaces();
        }
        this.renderButtonBar();
        break;
      }
      case 'summary:syncStatus':
        this.handleSummarySyncStatus(message);
        break;
      case 'spenders:progress':
        this.boardController?.setBuildProgress(message);
        break;
      case 'spenders:snapshot':
        this.boardController?.setBuildSnapshot(message);
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
      case 'voice:scriptDelta':
      case 'voice:scriptComplete':
      case 'voice:scriptError':
      case 'voice:noteView':
      case 'voice:noteError':
      case 'voice:audioBytes':
      case 'voice:attachGrant':
      case 'voice:attachRefuse':
        if (this.voiceController) {
          this.runVoiceControllerTask(this.voiceController.handleMessage(message));
        }
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
      recapOverlayCacheSlot('full'),
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
          ? `Последняя ошибка Hub: ${formatUserFacingError(message.syncStatus.error)}`
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
    // E81: a coach turn narrates its wait in the pending bubble — fold the
    // fresh stage into the coach model before the scheduled paint.
    if (this.activeCoachSession?.pending?.operationId === message.operationId) {
      this.rebuildCoachModel();
    }
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
    const model = this.activeCompareFor(message.operationId);
    const tab = model?.tabs.find(({ cardId }) => cardId === message.cardId);
    if (!model || !tab) {
      return;
    }
    tab.rawText += message.text;
    // Parallel cards keep accumulating off-screen, but only the selected card
    // can change the visible body. Completion/error still render every card so
    // their tab status remains live.
    if (model.activeCardId === message.cardId) {
      this.scheduleLoadingRender();
    }
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

  private async openDebugPromptViewer(viewerToken?: string): Promise<void> {
    // E81: a coach exchange passes ITS turn's token (the feed outlives the
    // active-op echo marker); the loading/completed surfaces keep the
    // active-op default.
    const token =
      viewerToken ??
      (this.activeDebugEcho?.state === 'available'
        ? this.activeDebugEcho.viewerToken
        : undefined);
    if (token === undefined) {
      return;
    }
    try {
      await browser.runtime.sendMessage({
        type: 'openDebugPrompt',
        viewerToken: token,
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
      if (this.coachOverlayModel?.kind === 'coach') {
        this.coachOverlayModel.sessionView.pendingAnswerText =
          this.coachPendingAnswerText;
      }
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
      this.handleCoachRecapChainComplete(message);
      return;
    }

    // Coach commits via its own path — it NEVER reaches overlayRawText,
    // buildCompletedOverlayModel, or CompletedOverlayCache (carry-forwards 5/6).
    if (this.activeFeature === 'coach-chat') {
      this.handleCoachComplete(message);
      return;
    }

    const feature = this.activeFeature;
    const recapMode: RecapMode | null =
      feature === 'fan-summary' ? this.activeSummaryMode ?? 'full' : null;
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
    // A served view-cached recap ends any pending open-last fallback.
    if (recapMode) {
      this.viewLastFallbackMode = null;
      if (message.result.summaryMeta?.storedLocally !== false) {
        this.markRecapAvailable(recapMode);
      }
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
      recapMode ? recapOverlayCacheSlot(recapMode) : 'default',
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
      // outcome. Try the OTHER recap size once if one is pending (the local
      // cache may hold one size but not the other), else toast — never a full
      // error overlay.
      if (message.error?.key === 'no_saved_recap') {
        const fallback = this.viewLastFallbackMode;
        this.viewLastFallbackMode = null;
        this.clearOperationState(true);
        if (fallback) {
          this.dispatchViewCachedRecap(fallback);
          return;
        }
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

  /** Project a successful recap into the exact local slot immediately. The
   * legacy aggregate remains for old background/content overlap; before the
   * slot field existed that aggregate was full-only, so it is the safe fallback
   * when upgrading an already-open tab. */
  private markRecapAvailable(mode: RecapMode): void {
    if (!this.tabState) {
      return;
    }
    const current = this.tabState.availableRecaps ?? {
      full: this.tabState.hasAvailableSummary,
      short: false,
    };
    const availableRecaps = {
      ...current,
      [mode]: true,
    };
    this.tabState = {
      ...this.tabState,
      hasAvailableSummary: true,
      availableRecaps,
    };
  }

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
    this.activeImproveDraftText = null;
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

  private buildImproveDraftCacheKey(
    draftText: string | undefined,
    replyMode?: ReplyMode,
  ): string | null {
    const trimmed = draftText?.trim() ?? '';
    if (!trimmed) {
      return null;
    }
    // A Split Fix and a single Fix of the same draft are different results.
    return replyMode === 'preferSplit' ? `split\u0000${trimmed}` : trimmed;
  }

  /** One part auto-inserts as before. Split parts (E142) open in the inline
   * panel, each with its own Insert, pinned to the draft they were made from. */
  private presentImproveDraftResult(
    model: Extract<CompletedOverlayViewModel, { kind: 'reply' }>,
    improvePin: { variantKey: string; draftText: string } | null,
  ): void {
    if (model.parts.length > 1 && improvePin) {
      this.inlineImprove = improvePin;
      this.quickInlineVisible = true;
      this.quickSurfaceMode = 'inline';
      this.renderAll();
      return;
    }
    this.inlineImprove = null;
    void this.applyImproveDraftResult(model);
  }

  private async applyImproveDraftResult(
    model: Extract<CompletedOverlayViewModel, { kind: 'reply' }>,
  ): Promise<void> {
    const nextText = model.parts[0]?.text ?? (model.rawText.trim() || model.rawText);

    try {
      // LIVE route check (mirrors the coach draft guard): the polled
      // currentGroupId can lag a chat switch by up to 500ms, and this path
      // auto-inserts — never drop fan A's improved draft into fan B's composer.
      if (parseGroupIdFromPath(window.location.pathname) !== model.groupId) {
        throw new ChatGooseError('chat_changed');
      }
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
    if (!this.observedDraftDocument) {
      return;
    }
    this.observedDraftDocument.removeEventListener('input', this.handleDraftInput, true);
    this.observedDraftDocument.removeEventListener('change', this.handleDraftInput, true);
    this.observedDraftDocument = null;
  }

  private syncDraftTextareaObserver(): void {
    const textarea = findActiveConversationTextarea();
    if (this.observedDraftDocument !== document) {
      this.detachDraftTextareaObserver();
      this.observedDraftDocument = document;
      document.addEventListener('input', this.handleDraftInput, true);
      document.addEventListener('change', this.handleDraftInput, true);
    }
    this.hasDraftText = Boolean(textarea?.value.trim());
  }

  private async computeCompareFingerprint(): Promise<string | null> {
    if (!this.tabState) {
      return null;
    }

    const storage = await readStorageState();
    return getCompareCardsFingerprintForPersonality(
      storage,
      this.tabState.mappedPersonalityId,
    );
  }

  private async restoreCompletedComparePanel(): Promise<boolean> {
    return this.restoreCompletedComparePanelInternal(false);
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
          groupId: this.activeOperationGroupId ?? this.currentGroupId ?? '',
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
          recapMode: this.activeSummaryMode ?? 'full',
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
      groupId: this.activeOperationGroupId ?? this.currentGroupId ?? '',
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

export function startContentApp(): ChatGooseContentApp {
  const app = new ChatGooseContentApp();
  app.init();
  return app;
}
