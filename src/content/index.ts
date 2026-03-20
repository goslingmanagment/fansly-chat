import contentStyles from './styles.css';
import { ButtonBar } from './button-bar.js';
import { getActiveConversationDisplayName } from './conversation-dom.js';
import { ConversationMountController } from './conversation-mount-controller.js';
import { installContentStyles } from './dom-anchor.js';
import { CompletedCompareCache } from './inline-panel/completed-compare-cache.js';
import { InlinePanelController } from './inline-panel/inline-panel-controller.js';
import { MappingBanner } from './mapping-banner.js';
import { CompletedOverlayCache } from './overlay/completed-overlay-cache.js';
import { OverlayController } from './overlay/overlay-controller.js';
import { PortClient } from './port-client.js';
import { startRouteWatcher } from './route-watcher.js';
import { captureScrollSnapshot, applyScrollCompensation } from './scroll-compensation.js';
import { findActiveConversationTextarea } from './conversation-dom.js';
import { getActiveConversationDraftText } from './textarea.js';
import { ToastController } from './toast.js';
import {
  getCompareCardsFingerprintForPersonality,
} from '../shared/compare-cards.js';
import { splitByNext } from '../shared/split.js';
import { loadStorageState } from '../shared/storage.js';
import type {
  AnthropicSpendSummary,
  BackgroundPortMessage,
  CompareInlineTabState,
  CompareInlineViewModel,
  CompletedOverlayViewModel,
  FeatureType,
  FeatureResult,
  OverlayInsertPart,
  OverlayViewModel,
  OperationProgressPayload,
  OperationProfilingSnapshot,
  PromptDebugSnapshot,
  ReplyMode,
  ReplyTone,
  TabUiState,
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

function isInlineQuickFeature(
  f: FeatureType,
): f is 'fast-reply' | 'improve-draft' | 'ping' {
  return f === 'fast-reply' || f === 'improve-draft' || f === 'ping';
}

function isOverlayOnlyFeature(f: FeatureType): f is 'help-me' | 'chat-review' | 'fan-summary' {
  return f === 'help-me' || f === 'chat-review' || f === 'fan-summary';
}

function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
  if ((el as HTMLElement).isContentEditable) return true;
  return false;
}

export class ChatMuseContentApp {
  private routeNonce = 0;
  private currentGroupId: string | null = null;
  private tabState: TabUiState | null = null;
  private activeFeature: FeatureType | null = null;
  private activeOperationId: string | null = null;
  private activeFanDisplayName: string | null = null;
  private activeDebugPrompt: PromptDebugSnapshot | null = null;
  private activeAnthropicSpend: AnthropicSpendSummary | null = null;
  private activeProfiling: OperationProfilingSnapshot | null = null;
  private activeProgress: OperationProgressPayload | null = null;
  private lastFeature: FeatureType | null = null;
  private nextFastReplyMode: ReplyMode = 'default';
  private nextReplyTone: ReplyTone = 'none';
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
  private suppressedTerminalOpId: string | null = null;
  private observedDraftTextarea: HTMLTextAreaElement | null = null;
  private hasDraftText = false;
  // Deep feature overlay model (completed/error/cache-hit shown in overlay)
  private deepOverlayModel: OverlayViewModel | null = null;

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
      this.toast.show('Extension reloaded. Please try again.');
      this.completedOverlayCache.clearAll();
      this.completedCompareCache.clearAll();
      this.quickInlineVisible = false;
      this.comparePanelVisible = false;
      this.activeCompareModel = null;
      this.pendingCompareFingerprint = null;
      this.quickSurfaceMode = 'inline';
      this.suppressedTerminalOpId = null;
      this.detachDraftTextareaObserver();
      this.clearOperationState(true);
      this.resetNextFastReplyMode();
      this.resetNextReplyTone();
      this.renderAll();
    },
  });
  private readonly buttonBar = new ButtonBar({
    onFeatureClick: (feature) => this.startFeature(feature, false),
    onCompareClick: () => {
      void this.startCompare(false);
    },
    onCompareRestoreClick: () => {
      void this.reopenCompletedCompare();
    },
    onReplyModeToggle: () => this.toggleNextFastReplyMode(),
    onToneSelect: (tone) => this.selectTone(tone),
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
    onClose: () => {
      this.deepOverlayModel = null;
      if (!this.activeFeature || !isInlineQuickFeature(this.activeFeature)) {
        this.clearOperationState(true);
        this.resetNextFastReplyMode();
        this.resetNextReplyTone();
      }
      this.renderAll();
    },
    onCancel: (operationId) => {
      this.port.send({ type: 'operation:cancel', operationId });
      this.quickInlineVisible = false;
      this.clearOperationState(true);
      this.resetNextFastReplyMode();
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
  });

  constructor() {
    this.root.id = 'chatmuse-root';
    this.root.append(this.inlinePanel.root, this.buttonBar.root, this.mappingBanner.root);
    this.mountController = new ConversationMountController(this.root);
  }

  init(): void {
    installContentStyles(contentStyles);
    this.port.connect();
    startRouteWatcher((groupId) => this.handleRouteChange(groupId));

    document.addEventListener('keydown', (e) => {
      if (
        (e.metaKey || e.ctrlKey) && e.shiftKey && e.code === 'KeyE' && !e.repeat &&
        !isEditableElement(document.activeElement) &&
        this.currentGroupId &&
        !this.activeFeature &&
        !this.activeCompareModel?.operationId
      ) {
        e.preventDefault();
        this.startFeature('fast-reply', false);
      }
    });
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
      const visibleCompareModel =
        this.comparePanelVisible
          ? this.activeCompareModel
          : null;

      // Overlay-only features — active loading
      if (this.activeFeature && isOverlayOnlyFeature(this.activeFeature)) {
        this.inlinePanel.hide();
        this.overlay.render(this.buildActiveLoadingModel());
        return;
      }

      // Inline quick features — active operation
      if (this.activeFeature && isInlineQuickFeature(this.activeFeature)) {
        if (this.quickSurfaceMode === 'overlay') {
          this.inlinePanel.hide();
          this.overlay.render(this.buildActiveLoadingModel({ canRegenerate: true }), {
            dismissMode: 'collapse-to-inline',
          });
          return;
        }
        // inline mode
        this.overlay.render({ kind: 'hidden' });
        if (this.quickInlineVisible) {
          this.inlinePanel.render(this.buildActiveLoadingModel({ canRegenerate: true }));
        } else {
          this.inlinePanel.hide();
        }
        return;
      }

      if (visibleCompareModel) {
        this.overlay.render({ kind: 'hidden' });
        this.inlinePanel.render(visibleCompareModel);
        return;
      }

      // No active quick feature — check for completed/cached inline results
      if (this.quickInlineVisible && this.lastFeature && isInlineQuickFeature(this.lastFeature)) {
        const cached = this.completedOverlayCache.get(this.currentGroupId, this.lastFeature);
        if (cached) {
          if (this.quickSurfaceMode === 'overlay') {
            this.inlinePanel.hide();
            this.overlay.render(cached, { dismissMode: 'collapse-to-inline' });
          } else {
            this.overlay.render({ kind: 'hidden' });
            this.inlinePanel.render(cached);
          }
          return;
        }
      }

      // Deep feature result in overlay (completed, error, or cache hit)
      if (this.deepOverlayModel) {
        this.inlinePanel.hide();
        this.overlay.render(this.deepOverlayModel);
        return;
      }

      // Nothing to show — hide both surfaces
      this.inlinePanel.hide();
      this.overlay.render({ kind: 'hidden' });
      if (this.quickSurfaceMode === 'overlay') {
        this.quickSurfaceMode = 'inline';
      }
    } finally {
      applyScrollCompensation(this.root, scrollSnapshot);
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
      anthropicSpend: this.activeAnthropicSpend ?? undefined,
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

  // ─── Feature Lifecycle ──────────────────────────────────────────────

  private startFeature(feature: FeatureType, forceRegenerate: boolean): void {
    // Same-feature click while active
    if (this.activeFeature === feature) {
      if (isInlineQuickFeature(feature)) {
        if (!this.quickInlineVisible && this.suppressedTerminalOpId !== this.activeOperationId) {
          this.quickInlineVisible = true;
          this.renderSurfaces();
        }
      }
      return;
    }

    if (this.activeFeature || this.activeCompareModel?.operationId) {
      this.toast.show('Another operation is already in progress.');
      return;
    }

    this.comparePanelVisible = false;
    if (this.activeCompareModel && !this.activeCompareModel.operationId) {
      this.activeCompareModel = null;
    }

    // Cache hit
    const cachedResult =
      !forceRegenerate && feature !== 'improve-draft'
        ? this.completedOverlayCache.get(this.currentGroupId, feature)
        : null;
    if (cachedResult) {
      this.lastFeature = feature;
      if (isInlineQuickFeature(feature)) {
        this.quickInlineVisible = true;
        this.quickSurfaceMode = 'inline';
      } else {
        this.deepOverlayModel = cachedResult;
      }
      this.renderSurfaces();
      return;
    }

    if (!this.tabState) {
      return;
    }

    if (!this.tabState.hasApiKey) {
      this.toast.show('Claude API key not configured. Go to Settings to add it.', {
        actionLabel: 'Settings',
        onAction: () => { void browser.runtime.openOptionsPage(); },
      });
      return;
    }
    if (!this.tabState.hasPersonalities) {
      this.toast.show('No model personalities configured. Go to Settings to create one.', {
        actionLabel: 'Settings',
        onAction: () => { void browser.runtime.openOptionsPage(); },
      });
      return;
    }
    if (!this.tabState.mappedPersonalityId) {
      this.toast.show('No model personality assigned for this account. Select one to continue.', {
        actionLabel: 'Settings',
        onAction: () => { void browser.runtime.openOptionsPage(); },
      });
      return;
    }
    if (!this.tabState.connected) {
      this.toast.show('Not connected to Fansly. Browse Fansly to establish a connection.');
      return;
    }
    if (feature === 'improve-draft' && !this.computeHasDraftText()) {
      this.toast.show('Write a draft in the composer first, then use Improve.');
      this.renderButtonBar();
      return;
    }

    // Start new operation
    const operationId = crypto.randomUUID();
    const domFanDisplayName = getActiveConversationDisplayName();
    const draftText =
      feature === 'improve-draft'
        ? getActiveConversationDraftText().trim()
        : undefined;
    const replyMode = feature === 'fast-reply' ? this.nextFastReplyMode : 'default';
    this.cancelScheduledLoadingRender();
    this.activeDebugPrompt = null;
    this.activeAnthropicSpend = null;
    this.activeProfiling = null;
    this.activeProgress = null;
    this.activeFeature = feature;
    this.activeOperationId = operationId;
    this.activeFanDisplayName = domFanDisplayName ?? 'fan';
    this.lastFeature = feature;
    this.overlayRawText = '';
    this.suppressedTerminalOpId = null;
    this.comparePanelVisible = false;

    if (isInlineQuickFeature(feature)) {
      this.quickInlineVisible = false;
      this.quickSurfaceEverOpened = false;
      this.quickSurfaceMode = 'inline';
    }
    // renderSurfaces() handles overlay loading for deep features,
    // and hides surfaces for inline quick (panel opens on first chunk).
    this.renderSurfaces();

    this.port.send({
      type: 'operation:start',
      operationId,
      feature,
      groupId: this.currentGroupId,
      routeNonce: this.routeNonce,
      domFanDisplayName,
      draftText,
      forceRegenerate,
      replyMode: feature === 'fast-reply' ? replyMode : undefined,
      replyTone: feature === 'fast-reply' ? this.nextReplyTone : undefined,
    });
    if (feature === 'fast-reply') {
      this.resetNextFastReplyMode();
      this.resetNextReplyTone();
    }
    this.renderButtonBar();
  }

  private async startCompare(forceRegenerate: boolean): Promise<void> {
    if (this.activeCompareModel?.operationId) {
      if (!this.comparePanelVisible && this.suppressedTerminalOpId !== this.activeCompareModel.operationId) {
        this.comparePanelVisible = true;
        this.renderSurfaces();
      }
      return;
    }

    if (this.activeFeature) {
      this.toast.show('Another operation is already in progress.');
      return;
    }

    if (!this.tabState) {
      return;
    }
    if (!this.tabState.hasApiKey) {
      this.toast.show('Claude API key not configured. Go to Settings to add it.', {
        actionLabel: 'Settings',
        onAction: () => { void browser.runtime.openOptionsPage(); },
      });
      return;
    }
    if (!this.tabState.connected) {
      this.toast.show('Not connected to Fansly. Browse Fansly to establish a connection.');
      return;
    }
    if (this.tabState.compareCardCount < 2) {
      this.toast.show('Compare needs at least two model cards. Add files in prompts/drafts or map a personality.');
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
    this.suppressedTerminalOpId = null;
    this.renderButtonBar();

    this.port.send({
      type: 'compare:start',
      operationId,
      groupId: this.currentGroupId,
      routeNonce: this.routeNonce,
      domFanDisplayName,
      forceRegenerate,
      replyMode: this.nextFastReplyMode,
      replyTone: this.nextReplyTone,
    });
    this.resetNextFastReplyMode();
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

  private selectTone(tone: ReplyTone): void {
    if (this.activeFeature || this.activeCompareModel?.operationId) return;
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
    this.completedOverlayCache.setActiveGroup(groupId);
    this.completedCompareCache.setActiveGroup(groupId);
    this.mountController.setActiveRoute(groupId);

    if (changed) {
      this.pendingCompareFingerprint = null;
      if (this.activeFeature && isInlineQuickFeature(this.activeFeature)) {
        this.quickInlineVisible = false;
        this.quickSurfaceMode = 'inline';
        this.suppressedTerminalOpId = this.activeOperationId;
        this.renderSurfaces();
      } else if (this.activeCompareModel?.operationId) {
        this.comparePanelVisible = false;
        this.suppressedTerminalOpId = this.activeCompareModel.operationId;
        this.activeCompareModel = null;
        this.completedCompareCache.clear(previousGroupId);
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

  // ─── Port Messages ──────────────────────────────────────────────────

  private handlePortMessage(message: BackgroundPortMessage): void {
    switch (message.type) {
      case 'tab:state':
      case 'settings:changed':
      case 'mapping:changed':
        this.tabState = message.state;
        void this.mappingBanner.render(message.state.accountId, Boolean(message.state.mappedPersonalityId));
        this.renderButtonBar();
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

  private handleProgress(message: Extract<BackgroundPortMessage, { type: 'operation:progress' }>): void {
    if (this.activeOperationId !== message.operationId) {
      return;
    }
    this.activeAnthropicSpend = message.anthropicSpend ?? this.activeAnthropicSpend;
    if (
      message.anthropicSpend &&
      this.activeFeature &&
      isInlineQuickFeature(this.activeFeature) &&
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
    tab.rawText = message.result.rawText;
    tab.parts = createParts(
      message.result.parts && message.result.parts.length > 0
        ? message.result.parts
        : splitByNext(message.result.rawText),
    );
    tab.anthropicSpend = message.anthropicSpend;
    tab.splitModeRequested = Boolean(message.result.splitModeRequested);
    tab.error = undefined;
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
    tab.anthropicSpend = message.anthropicSpend;
    tab.error = message.error;
    this.renderSurfaces();
  }

  private handleCompareComplete(
    message: Extract<BackgroundPortMessage, { type: 'compare:complete' }>,
  ): void {
    const model = this.activeCompareFor(message.operationId);
    if (!model) {
      return;
    }

    if (this.suppressedTerminalOpId === message.operationId) {
      this.suppressedTerminalOpId = null;
      this.activeCompareModel = null;
      this.comparePanelVisible = false;
      this.pendingCompareFingerprint = null;
      this.renderButtonBar();
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
    if (this.activeCompareModel?.operationId === message.operationId) {
      if (this.suppressedTerminalOpId === message.operationId) {
        this.suppressedTerminalOpId = null;
        this.activeCompareModel = null;
        this.comparePanelVisible = false;
        this.pendingCompareFingerprint = null;
        this.renderButtonBar();
        return;
      }

      this.activeCompareModel = null;
      this.comparePanelVisible = false;
      this.pendingCompareFingerprint = null;
      this.completedCompareCache.clear(this.currentGroupId);
      this.renderButtonBar();
    }

    if (message.type === 'compare:error') {
      this.toast.show(message.error.message);
    }
  }

  private handleDebugPrompt(message: Extract<BackgroundPortMessage, { type: 'operation:debugPrompt' }>): void {
    if (this.activeOperationId !== message.operationId) {
      return;
    }
    this.activeDebugPrompt = message.snapshot;
    this.scheduleLoadingRender();
  }

  private handleChunk(operationId: string, text: string): void {
    if (this.activeOperationId !== operationId) {
      return;
    }
    this.overlayRawText += text;

    if (this.activeFeature && isInlineQuickFeature(this.activeFeature)) {
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
    if (this.activeOperationId !== message.operationId || !this.activeFeature) {
      return;
    }

    // Suppressed after route change — discard silently
    if (this.suppressedTerminalOpId === message.operationId) {
      this.suppressedTerminalOpId = null;
      this.clearOperationState(true);
      this.renderButtonBar();
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
      message.anthropicSpend ?? this.activeAnthropicSpend ?? undefined,
      message.profiling ?? this.activeProfiling ?? undefined,
    );
    if (feature !== 'improve-draft') {
      this.completedOverlayCache.set(this.currentGroupId, feature, completedModel);
    }

    if (isInlineQuickFeature(feature)) {
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

  private handleOperationError(
    message: Extract<
      BackgroundPortMessage,
      { type: 'operation:error' | 'operation:discarded' }
    >,
  ): void {
    if (this.activeOperationId === message.operationId) {
      const feature = this.activeFeature ?? this.lastFeature ?? 'fast-reply';

      if (this.suppressedTerminalOpId === message.operationId) {
        this.suppressedTerminalOpId = null;
        this.clearOperationState(true);
        this.renderButtonBar();
        return;
      }

      const errorModel: OverlayViewModel = {
        kind: 'error',
        feature,
        fanDisplayName: this.currentFanDisplayName(),
        operationId: message.operationId,
        debugPrompt: this.activeDebugPrompt ?? undefined,
        anthropicSpend:
          message.anthropicSpend ?? this.activeAnthropicSpend ?? undefined,
        profiling: message.profiling ?? this.activeProfiling ?? undefined,
        error: {
          code: 'unknown_error',
          message: message.error.message,
        },
      };

      if (isInlineQuickFeature(feature)) {
        this.cancelScheduledLoadingRender();
        if (this.quickSurfaceMode === 'overlay') {
          // Errors aren't cached, so collapse-to-inline is meaningless —
          // use 'close' so dismiss hides the overlay cleanly.
          this.overlay.render(errorModel, { dismissMode: 'close' });
        } else if (this.quickInlineVisible) {
          this.inlinePanel.render(errorModel);
        } else {
          this.toast.show(message.error.message);
        }
        this.clearOperationState(false);
        this.renderButtonBar();
        return;
      }

      this.deepOverlayModel = errorModel;
      this.clearOperationState(false);
      this.renderAll();
      return;
    }

    this.toast.show(message.error.message);
  }

  // ─── State Helpers ──────────────────────────────────────────────────

  private clearOperationState(fullReset: boolean): void {
    this.activeFeature = null;
    this.activeOperationId = null;
    this.activeFanDisplayName = null;
    this.activeAnthropicSpend = null;
    this.activeProfiling = null;
    this.activeProgress = null;
    if (fullReset) {
      this.activeDebugPrompt = null;
      this.deepOverlayModel = null;
    }
  }

  private currentFanDisplayName(): string {
    return this.activeFanDisplayName ?? 'fan';
  }

  private computeHasDraftText(): boolean {
    return getActiveConversationDraftText().trim().length > 0;
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
        this.toast.show('Saved compare is outdated. Run Compare again.');
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
    anthropicSpend?: AnthropicSpendSummary,
    profiling?: OperationProfilingSnapshot,
  ): CompletedOverlayViewModel {
    const rawText = result.rawText;

    if (feature === 'help-me') {
      const parsed = result.helpMe;
      return {
        kind: 'helpMe',
        feature,
        fanDisplayName,
        operationId,
        rawText,
        coaching: parsed?.coaching ?? null,
        engagingParts: parsed?.engaging ? createParts(splitByNext(parsed.engaging)) : [],
        flirtyParts: parsed?.flirty ? createParts(splitByNext(parsed.flirty)) : [],
        parseFallback: !parsed?.valid,
        debugPrompt: this.activeDebugPrompt ?? undefined,
        anthropicSpend,
        profiling,
        rerunActionLabel: 'Regenerate',
      };
    }

    if (feature === 'fan-summary' || feature === 'chat-review') {
      return {
        kind: 'readOnly',
        feature,
        fanDisplayName,
        operationId,
        rawText,
        summaryMeta: result.summaryMeta,
        reviewMeta:
          feature === 'chat-review'
            ? {
                rating: result.chatReview?.rating ?? null,
                evaluation: result.chatReview?.evaluation ?? null,
                recommendations: result.chatReview?.recommendations ?? null,
                parseFallback: !result.chatReview?.valid,
              }
            : undefined,
        debugPrompt: this.activeDebugPrompt ?? undefined,
        anthropicSpend,
        profiling,
        rerunActionLabel: 'Refresh',
      };
    }

    return {
      kind: 'reply',
      feature,
      fanDisplayName,
      operationId,
      parts: createParts(
        result.parts && result.parts.length > 0
          ? result.parts
          : splitByNext(rawText),
      ),
      rawText,
      splitModeRequested: Boolean(result.splitModeRequested),
      debugPrompt: this.activeDebugPrompt ?? undefined,
      anthropicSpend,
      profiling,
      rerunActionLabel: 'Regenerate',
    };
  }
}

if (window.location.hostname.endsWith('fansly.com')) {
  new ChatMuseContentApp().init();
}
