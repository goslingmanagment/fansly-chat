import contentStyles from './styles.css';
import { ButtonBar } from './button-bar.js';
import { getActiveConversationDisplayName } from './conversation-dom.js';
import { ConversationMountController } from './conversation-mount-controller.js';
import { installContentStyles } from './dom-anchor.js';
import { InlinePanelController } from './inline-panel/inline-panel-controller.js';
import { MappingBanner } from './mapping-banner.js';
import { CompletedOverlayCache } from './overlay/completed-overlay-cache.js';
import { OverlayController } from './overlay/overlay-controller.js';
import { PortClient } from './port-client.js';
import { startRouteWatcher } from './route-watcher.js';
import { captureScrollSnapshot, applyScrollCompensation } from './scroll-compensation.js';
import { ToastController } from './toast.js';
import { splitByNext } from '../shared/split.js';
import type {
  BackgroundPortMessage,
  CompletedOverlayViewModel,
  FeatureType,
  FeatureResult,
  OverlayInsertPart,
  OverlayViewModel,
  OperationProgressPayload,
  OperationProfilingSnapshot,
  PromptDebugSnapshot,
  ReplyMode,
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

function isInlineQuickFeature(f: FeatureType): f is 'fast-reply' | 'ping' {
  return f === 'fast-reply' || f === 'ping';
}

function isOverlayOnlyFeature(f: FeatureType): f is 'help-me' | 'chat-review' | 'fan-summary' {
  return f === 'help-me' || f === 'chat-review' || f === 'fan-summary';
}

export class ChatMuseContentApp {
  private routeNonce = 0;
  private currentGroupId: string | null = null;
  private tabState: TabUiState | null = null;
  private activeFeature: FeatureType | null = null;
  private activeOperationId: string | null = null;
  private activeFanDisplayName: string | null = null;
  private activeDebugPrompt: PromptDebugSnapshot | null = null;
  private activeProfiling: OperationProfilingSnapshot | null = null;
  private activeProgress: OperationProgressPayload | null = null;
  private lastFeature: FeatureType | null = null;
  private nextFastReplyMode: ReplyMode = 'default';
  private hasSentInit = false;
  private overlayRawText = '';

  // Inline quick surface state
  private quickSurfaceMode: 'inline' | 'overlay' = 'inline';
  private quickInlineVisible = false;
  private quickSurfaceEverOpened = false;
  private pendingLoadingFrame: number | null = null;
  private suppressedTerminalOpId: string | null = null;
  // Deep feature overlay model (completed/error/cache-hit shown in overlay)
  private deepOverlayModel: OverlayViewModel | null = null;

  private readonly toast = new ToastController();
  private readonly port = new PortClient({
    onMessage: (message) => this.handlePortMessage(message),
    onDisconnected: () => {
      this.toast.show('Extension reloaded. Please try again.');
      this.completedOverlayCache.clearAll();
      this.quickInlineVisible = false;
      this.quickSurfaceMode = 'inline';
      this.suppressedTerminalOpId = null;
      this.clearOperationState(true);
      this.resetNextFastReplyMode();
      this.renderAll();
    },
  });
  private readonly buttonBar = new ButtonBar({
    onFeatureClick: (feature) => this.startFeature(feature, false),
    onReplyModeToggle: () => this.toggleNextFastReplyMode(),
  });
  private readonly mappingBanner = new MappingBanner({
    onOpenSettings: () => {
      void browser.runtime.openOptionsPage();
    },
  });
  private readonly root = document.createElement('div');
  private readonly mountController: ConversationMountController;
  private readonly completedOverlayCache = new CompletedOverlayCache();
  private readonly inlinePanel = new InlinePanelController({
    onClose: () => {
      this.quickInlineVisible = false;
      this.renderSurfaces();
    },
    onExpand: () => {
      this.quickSurfaceMode = 'overlay';
      this.renderSurfaces();
    },
    onCancel: (operationId) => {
      this.port.send({ type: 'operation:cancel', operationId });
    },
    onRerun: (feature) => {
      this.completedOverlayCache.clearFeature(this.currentGroupId, feature);
      this.startFeature(feature, true);
    },
  });
  private readonly overlay = new OverlayController({
    onClose: () => {
      this.deepOverlayModel = null;
      if (!this.activeFeature || !isInlineQuickFeature(this.activeFeature)) {
        this.clearOperationState(true);
        this.resetNextFastReplyMode();
      }
      this.renderAll();
    },
    onCancel: (operationId) => {
      this.port.send({ type: 'operation:cancel', operationId });
      this.quickInlineVisible = false;
      this.clearOperationState(true);
      this.resetNextFastReplyMode();
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
  }

  // ─── Surface Rendering ──────────────────────────────────────────────

  private renderButtonBar(): void {
    const activeLoading = this.activeFeature !== null && this.activeOperationId !== null;
    this.buttonBar.render(this.tabState, this.activeFeature, this.nextFastReplyMode, activeLoading);
  }

  private renderAll(): void {
    this.renderSurfaces();
    this.renderButtonBar();
  }

  private renderSurfaces(): void {
    this.cancelScheduledLoadingRender();

    const scrollSnapshot = captureScrollSnapshot(this.root);
    try {
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
      profiling: this.activeProfiling ?? undefined,
      canCancel: true,
      canRegenerate: options?.canRegenerate ?? false,
      operationId: this.activeOperationId!,
    };
  }

  private scheduleLoadingRender(): void {
    if (this.pendingLoadingFrame !== null) return;
    const capturedOpId = this.activeOperationId;
    const capturedNonce = this.routeNonce;
    this.pendingLoadingFrame = requestAnimationFrame(() => {
      this.pendingLoadingFrame = null;
      if (this.activeOperationId !== capturedOpId || this.routeNonce !== capturedNonce) return;
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

    if (this.activeFeature) {
      this.toast.show('Another operation is already in progress.');
      return;
    }

    // Cache hit
    const cachedResult = !forceRegenerate ? this.completedOverlayCache.get(this.currentGroupId, feature) : null;
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

    // Start new operation
    const operationId = crypto.randomUUID();
    const domFanDisplayName = getActiveConversationDisplayName();
    const replyMode = feature === 'fast-reply' ? this.nextFastReplyMode : 'default';
    this.cancelScheduledLoadingRender();
    this.activeDebugPrompt = null;
    this.activeProfiling = null;
    this.activeProgress = null;
    this.activeFeature = feature;
    this.activeOperationId = operationId;
    this.activeFanDisplayName = domFanDisplayName ?? 'fan';
    this.lastFeature = feature;
    this.overlayRawText = '';
    this.suppressedTerminalOpId = null;

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
      forceRegenerate,
      replyMode: feature === 'fast-reply' ? replyMode : undefined,
    });
    if (feature === 'fast-reply') {
      this.resetNextFastReplyMode();
    }
    this.renderButtonBar();
  }

  private toggleNextFastReplyMode(): void {
    if (this.activeFeature) {
      return;
    }
    this.nextFastReplyMode = this.nextFastReplyMode === 'preferSplit' ? 'default' : 'preferSplit';
    this.renderButtonBar();
  }

  private resetNextFastReplyMode(): void {
    this.nextFastReplyMode = 'default';
  }

  // ─── Route ──────────────────────────────────────────────────────────

  private handleRouteChange(groupId: string | null): void {
    const changed = this.currentGroupId !== groupId;
    this.routeNonce += 1;
    this.currentGroupId = groupId;
    this.completedOverlayCache.setActiveGroup(groupId);
    this.mountController.setActiveRoute(groupId);

    if (changed) {
      if (this.activeFeature && isInlineQuickFeature(this.activeFeature)) {
        this.quickInlineVisible = false;
        this.quickSurfaceMode = 'inline';
        this.suppressedTerminalOpId = this.activeOperationId;
        this.renderSurfaces();
      } else if (!this.activeFeature) {
        this.quickInlineVisible = false;
        this.deepOverlayModel = null;
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
    this.activeProfiling = message.profiling ?? null;
    this.activeProgress = message;
    this.scheduleLoadingRender();
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
      message.profiling ?? this.activeProfiling ?? undefined,
    );
    this.completedOverlayCache.set(this.currentGroupId, feature, completedModel);

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

  private buildCompletedOverlayModel(
    feature: FeatureType,
    operationId: string,
    fanDisplayName: string,
    result: FeatureResult,
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
      profiling,
      rerunActionLabel: 'Regenerate',
    };
  }
}

if (window.location.hostname.endsWith('fansly.com')) {
  new ChatMuseContentApp().init();
}
