import contentStyles from './styles.css';
import { ButtonBar } from './button-bar.js';
import { getActiveConversationDisplayName } from './conversation-dom.js';
import { ConversationMountController } from './conversation-mount-controller.js';
import { installContentStyles } from './dom-anchor.js';
import { MappingBanner } from './mapping-banner.js';
import { OverlayController } from './overlay/overlay-controller.js';
import { PortClient } from './port-client.js';
import { startRouteWatcher } from './route-watcher.js';
import { ToastController } from './toast.js';
import { splitByNext } from '../shared/split.js';
import type {
  BackgroundPortMessage,
  FeatureType,
  OverlayInsertPart,
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

export class ChatMuseContentApp {
  private routeNonce = 0;
  private currentGroupId: string | null = null;
  private tabState: TabUiState | null = null;
  private activeFeature: FeatureType | null = null;
  private activeOperationId: string | null = null;
  private activeFanDisplayName: string | null = null;
  private activeDebugPrompt: PromptDebugSnapshot | null = null;
  private lastFeature: FeatureType | null = null;
  private nextFastReplyMode: ReplyMode = 'default';
  private hasSentInit = false;
  private readonly toast = new ToastController();
  private readonly port = new PortClient({
    onMessage: (message) => this.handlePortMessage(message),
    onDisconnected: () => {
      this.toast.show('Extension reloaded. Please try again.');
      this.overlay.render({ kind: 'hidden' });
      this.clearOperationState(true);
      this.resetNextFastReplyMode();
      this.render();
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
  private readonly overlay = new OverlayController({
    onClose: () => {
      this.overlay.render({ kind: 'hidden' });
      this.clearOperationState(true);
      this.resetNextFastReplyMode();
      this.render();
    },
    onCancel: (operationId) => {
      this.port.send({ type: 'operation:cancel', operationId });
      this.overlay.render({ kind: 'hidden' });
      this.clearOperationState(true);
      this.resetNextFastReplyMode();
      this.render();
    },
    onRegenerate: (feature) => this.startFeature(feature, true),
    onRefreshSummary: () => this.startFeature('fan-summary', true),
  });
  private overlayRawText = '';

  constructor() {
    this.root.id = 'chatmuse-root';
    this.root.append(this.buttonBar.root, this.mappingBanner.root);
    this.mountController = new ConversationMountController(this.root);
  }

  init(): void {
    installContentStyles(contentStyles);
    this.port.connect();

    startRouteWatcher((groupId) => {
      this.routeNonce += 1;
      this.currentGroupId = groupId;
      this.mountController.setActiveRoute(groupId);

      if (!this.hasSentInit) {
        this.port.send({ type: 'tab:init', groupId, routeNonce: this.routeNonce });
        this.hasSentInit = true;
      } else {
        this.port.send({ type: 'tab:routeChanged', groupId, routeNonce: this.routeNonce });
      }

      this.render();
    });
  }

  private startFeature(feature: FeatureType, forceRegenerate: boolean): void {
    if (!this.tabState) {
      return;
    }

    if (this.activeFeature) {
      this.toast.show('Another operation is already in progress.');
      return;
    }

    if (!this.tabState.hasApiKey) {
      this.toast.show('Claude API key not configured. Go to Settings to add it.', {
        actionLabel: 'Settings',
        onAction: () => {
          void browser.runtime.openOptionsPage();
        },
      });
      return;
    }
    if (!this.tabState.hasPersonalities) {
      this.toast.show('No model personalities configured. Go to Settings to create one.', {
        actionLabel: 'Settings',
        onAction: () => {
          void browser.runtime.openOptionsPage();
        },
      });
      return;
    }
    if (!this.tabState.mappedPersonalityId) {
      this.toast.show('No model personality assigned for this account. Select one to continue.', {
        actionLabel: 'Settings',
        onAction: () => {
          void browser.runtime.openOptionsPage();
        },
      });
      return;
    }
    if (!this.tabState.connected) {
      this.toast.show('Not connected to Fansly. Browse Fansly to establish a connection.');
      return;
    }

    const operationId = crypto.randomUUID();
    const domFanDisplayName = getActiveConversationDisplayName();
    const replyMode = feature === 'fast-reply' ? this.nextFastReplyMode : 'default';
    this.activeDebugPrompt = null;
    this.activeFeature = feature;
    this.activeOperationId = operationId;
    this.activeFanDisplayName = domFanDisplayName ?? 'fan';
    this.lastFeature = feature;
    this.overlay.render({
      kind: 'loading',
      feature,
      fanDisplayName: this.currentFanDisplayName(),
      progress: null,
      rawText: '',
      debugPrompt: undefined,
      canCancel: true,
      canRegenerate: feature === 'fast-reply' || feature === 'ping',
      operationId,
    });
    this.overlayRawText = '';
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
    this.render();
  }

  private toggleNextFastReplyMode(): void {
    if (this.activeFeature) {
      return;
    }

    this.nextFastReplyMode = this.nextFastReplyMode === 'preferSplit' ? 'default' : 'preferSplit';
    this.render();
  }

  private resetNextFastReplyMode(): void {
    this.nextFastReplyMode = 'default';
  }

  private handlePortMessage(message: BackgroundPortMessage): void {
    switch (message.type) {
      case 'tab:state':
      case 'settings:changed':
      case 'mapping:changed':
        this.tabState = message.state;
        void this.mappingBanner.render(message.state.accountId, Boolean(message.state.mappedPersonalityId));
        this.render();
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
        this.handleOperationError(message.operationId, message.error.message);
        break;
      default:
        break;
    }
  }

  private handleProgress(message: Extract<BackgroundPortMessage, { type: 'operation:progress' }>): void {
    if (this.activeOperationId !== message.operationId) {
      return;
    }

    this.overlay.render({
      kind: 'loading',
      feature: message.feature,
      fanDisplayName: this.currentFanDisplayName(),
      progress: message,
      rawText: this.currentRawText(),
      debugPrompt: this.activeDebugPrompt ?? undefined,
      canCancel: true,
      canRegenerate: message.feature === 'fast-reply' || message.feature === 'ping',
      operationId: message.operationId,
    });
  }

  private handleDebugPrompt(message: Extract<BackgroundPortMessage, { type: 'operation:debugPrompt' }>): void {
    if (this.activeOperationId !== message.operationId) {
      return;
    }

    this.activeDebugPrompt = message.snapshot;

    this.overlay.render({
      kind: 'loading',
      feature: message.feature,
      fanDisplayName: this.currentFanDisplayName(),
      progress: null,
      rawText: this.currentRawText(),
      debugPrompt: this.activeDebugPrompt,
      canCancel: true,
      canRegenerate: message.feature === 'fast-reply' || message.feature === 'ping',
      operationId: message.operationId,
    });
  }

  private handleChunk(operationId: string, text: string): void {
    if (this.activeOperationId !== operationId) {
      return;
    }

    const current = this.currentRawText() + text;
    this.overlayRawText = current;
    this.overlay.render({
      kind: 'loading',
      feature: this.activeFeature!,
      fanDisplayName: this.currentFanDisplayName(),
      progress: null,
      rawText: current,
      debugPrompt: this.activeDebugPrompt ?? undefined,
      canCancel: true,
      canRegenerate: this.activeFeature === 'fast-reply' || this.activeFeature === 'ping',
      operationId,
    });
  }

  private handleComplete(message: Extract<BackgroundPortMessage, { type: 'operation:complete' }>): void {
    if (this.activeOperationId !== message.operationId || !this.activeFeature) {
      return;
    }

    const feature = this.activeFeature;
    const rawText = message.result.rawText;
    this.overlayRawText = rawText;

    if (feature === 'help-me') {
      const parsed = message.result.helpMe;
      this.overlay.render({
        kind: 'helpMe',
        fanDisplayName: message.fanDisplayName,
        operationId: message.operationId,
        rawText,
        coaching: parsed?.coaching ?? null,
        engagingParts: parsed?.engaging ? createParts(splitByNext(parsed.engaging)) : [],
        flirtyParts: parsed?.flirty ? createParts(splitByNext(parsed.flirty)) : [],
        parseFallback: !parsed?.valid,
      });
    } else if (feature === 'fan-summary') {
      this.overlay.render({
        kind: 'readOnly',
        feature,
        fanDisplayName: message.fanDisplayName,
        operationId: message.operationId,
        rawText,
        summaryMeta: message.result.summaryMeta,
        canRefresh: true,
      });
    } else if (feature === 'chat-review') {
      this.overlay.render({
        kind: 'readOnly',
        feature,
        fanDisplayName: message.fanDisplayName,
        operationId: message.operationId,
        rawText,
        reviewMeta: {
          rating: message.result.chatReview?.rating ?? null,
          evaluation: message.result.chatReview?.evaluation ?? null,
          recommendations: message.result.chatReview?.recommendations ?? null,
          parseFallback: !message.result.chatReview?.valid,
        },
      });
    } else {
      this.overlay.render({
        kind: 'reply',
        feature,
        fanDisplayName: message.fanDisplayName,
        operationId: message.operationId,
        parts: createParts(
          message.result.parts && message.result.parts.length > 0
            ? message.result.parts
            : splitByNext(rawText),
        ),
        rawText,
        splitModeRequested: Boolean(message.result.splitModeRequested),
        debugPrompt: feature === 'fast-reply' ? this.activeDebugPrompt ?? undefined : undefined,
        canRegenerate: feature === 'fast-reply' || feature === 'ping',
      });
    }

    this.clearOperationState(false);
    this.render();
  }

  private handleOperationError(operationId: string, message: string): void {
    if (this.activeOperationId === operationId) {
      this.overlay.render({
        kind: 'error',
        feature: this.activeFeature ?? this.lastFeature ?? 'fast-reply',
        fanDisplayName: this.currentFanDisplayName(),
        operationId,
        debugPrompt: this.activeDebugPrompt ?? undefined,
        error: {
          code: 'unknown_error',
          message,
        },
      });
      this.clearOperationState(false);
      this.render();
      return;
    }

    this.toast.show(message);
  }

  private clearOperationState(clearDebugPrompt: boolean): void {
    this.activeFeature = null;
    this.activeOperationId = null;
    this.activeFanDisplayName = null;
    if (clearDebugPrompt) {
      this.activeDebugPrompt = null;
    }
  }

  private currentRawText(): string {
    return this.overlayRawText;
  }

  private currentFanDisplayName(): string {
    return this.activeFanDisplayName ?? 'fan';
  }

  private render(): void {
    this.buttonBar.render(this.tabState, this.activeFeature, this.nextFastReplyMode);
  }
}

if (window.location.hostname.endsWith('fansly.com')) {
  new ChatMuseContentApp().init();
}
