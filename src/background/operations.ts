import {
  DEEP_OPERATION_TIMEOUT_MS,
  DEFAULT_FEATURE_MODELS,
  MIN_MESSAGES_FOR_DEEP,
  QUICK_OPERATION_TIMEOUT_MS,
  STREAM_CHUNK_FLUSH_MS,
} from '../shared/constants.js';
import { formatFanSpendingData } from '../shared/earnings.js';
import { ChatMuseError, toUserError } from '../shared/errors.js';
import { logDebug } from '../shared/log.js';
import { buildPrompt } from '../shared/prompts.js';
import {
  getSummaryCache,
  loadStorageState,
  removeSummaryCache,
  rekeyAccountIdentity,
  saveSummaryCache,
} from '../shared/storage.js';
import { formatFanSubscriptionData } from '../shared/subscriptions.js';
import { analyzePingSegment, formatTranscript } from '../shared/transcript.js';
import { parseChatReviewXml, parseHelpMeXml } from '../shared/xml.js';
import type {
  BackgroundPortMessage,
  CompletePayload,
  ContentPortMessage,
  DiscardedPayload,
  ErrorPayload,
  FeatureType,
  FeatureResult,
  OperationPhase,
  OperationProgressPayload,
  OperationStartPayload,
  PingSegment,
  PersistedState,
  SubscriptionLookupMode,
  RouteChangedPayload,
  SessionTemplate,
  TabStatePayload,
  TabUiState,
} from '../shared/types.js';
import { AnthropicClient } from './anthropic-client.js';
import type {
  MessageLoadProgress,
  SubscriptionLookupTraceEvent,
} from './fansly-client.js';
import { FanslyClient } from './fansly-client.js';
import {
  createOperationProfiler,
  type OperationProfiler,
} from './operation-profiling.js';
import { SessionStore } from './session-store.js';
import { TabContextStore } from './tab-context.js';

interface ActiveOperation {
  operationId: string;
  tabId: number;
  feature: FeatureType;
  groupId: string;
  routeNonce: number;
  controller: AbortController;
  rawText: string;
  flushBuffer: string;
  flushTimer: number | null;
  profiler: OperationProfiler;
}

const NO_OP_PROFILER = createOperationProfiler(false);

interface ValidatedOperationStart {
  tab: browser.tabs.Tab;
  urlGroupId: string;
  storage: PersistedState;
  session: SessionTemplate;
  legacyAccountId: string;
  messageCount: number;
}

function parseGroupIdFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const match = /\/messages\/([^/?#]+)/.exec(url);
  return match?.[1] ?? null;
}

function isDeepFeature(feature: FeatureType): boolean {
  return feature === 'fan-summary' || feature === 'chat-review';
}

function resolveTimeout(feature: FeatureType): number {
  return isDeepFeature(feature) ? DEEP_OPERATION_TIMEOUT_MS : QUICK_OPERATION_TIMEOUT_MS;
}

function resolveSubscriptionLookupMode(feature: FeatureType): SubscriptionLookupMode {
  return isDeepFeature(feature) ? 'full' : 'cache-only';
}

function resolveMappedPersonalityId(
  accountMappings: Record<string, string>,
  resolvedAccountId: string | null,
  legacyAccountId: string | null,
): string | null {
  if (resolvedAccountId) {
    const resolved = accountMappings[resolvedAccountId];
    if (resolved) {
      return resolved;
    }
  }

  if (legacyAccountId && legacyAccountId !== resolvedAccountId) {
    return accountMappings[legacyAccountId] ?? null;
  }

  return null;
}

function errorCode(error: unknown): string {
  if (error instanceof ChatMuseError) return error.code;
  const code = (error as { code?: string })?.code;
  return typeof code === 'string' ? code : 'unknown_error';
}

function describeMessageLoadProgress(progress: MessageLoadProgress): string {
  return `Loaded messages page ${progress.currentPage}/${progress.targetPages} (${progress.pageMessageCount} msgs, ${progress.collectedCount} collected)`;
}

function describeSubscriptionTraceStep(
  event: SubscriptionLookupTraceEvent,
): string {
  switch (event.type) {
    case 'cache-hit':
      return 'cache hit';
    case 'cache-miss':
      return 'cache miss';
    case 'cache-only-skip':
      return 'cache-only skip';
    case 'groups-start':
      return 'groups start';
    case 'groups-hit':
      return 'groups hit';
    case 'groups-miss':
      return 'groups miss';
    case 'groups-error':
      return `groups error (${event.code})`;
    case 'subscribers-start':
      return 'subscribers start';
    case 'subscribers-hit':
      return 'subscribers hit';
    case 'subscribers-miss':
      return 'subscribers miss';
  }
}

export class OperationCoordinator {
  private readonly portsByTabId = new Map<number, browser.runtime.Port>();
  private readonly activeByTabId = new Map<number, ActiveOperation>();
  private readonly cancelledOperationIds = new Set<string>();

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly tabContexts: TabContextStore,
    private readonly fanslyClient: FanslyClient,
    private readonly anthropicClient: AnthropicClient,
  ) {}

  registerPort(port: browser.runtime.Port): void {
    const tabId = port.sender?.tab?.id;
    if (!tabId) {
      return;
    }

    this.portsByTabId.set(tabId, port);
    port.onMessage.addListener((message) => {
      void this.handlePortMessage(tabId, message as ContentPortMessage);
    });
    port.onDisconnect.addListener(() => {
      this.portsByTabId.delete(tabId);
      void this.cancelOperation(tabId);
    });
  }

  async refreshTabState(
    tabId: number,
    messageType: TabStatePayload['type'] = 'tab:state',
  ): Promise<void> {
    const port = this.portsByTabId.get(tabId);
    if (!port) {
      return;
    }
    port.postMessage({
      type: messageType,
      state: await this.buildTabUiState(tabId),
    } satisfies TabStatePayload);
  }

  async refreshAllTabs(
    messageType: TabStatePayload['type'] = 'settings:changed',
  ): Promise<void> {
    await Promise.all(
      Array.from(this.portsByTabId.keys()).map((tabId) =>
        this.refreshTabState(tabId, messageType),
      ),
    );
  }

  async handleCapture(tabId: number, accountId: string): Promise<void> {
    this.tabContexts.setAccount(tabId, accountId);
    await this.refreshTabState(tabId);
  }

  async handleTabRemoved(tabId: number): Promise<void> {
    await this.cancelOperation(tabId);
    this.sessionStore.forgetTab(tabId);
    this.tabContexts.remove(tabId);
    this.portsByTabId.delete(tabId);
  }

  private async handlePortMessage(
    tabId: number,
    message: ContentPortMessage,
  ): Promise<void> {
    switch (message.type) {
      case 'tab:init':
        this.tabContexts.setRoute(tabId, message.groupId, message.routeNonce);
        this.tabContexts.setAccount(
          tabId,
          this.sessionStore.getAccountIdForTab(tabId),
        );
        await this.refreshTabState(tabId, 'tab:state');
        break;
      case 'tab:routeChanged':
        await this.handleRouteChanged(tabId, message);
        break;
      case 'operation:start':
        await this.startOperation(tabId, message);
        break;
      case 'operation:cancel':
        await this.cancelOperation(tabId);
        break;
      default:
        break;
    }
  }

  private async handleRouteChanged(
    tabId: number,
    payload: RouteChangedPayload,
  ): Promise<void> {
    const previous = this.tabContexts.getOrCreate(tabId);
    const changed = previous.groupId !== payload.groupId;
    this.tabContexts.setRoute(tabId, payload.groupId, payload.routeNonce);
    if (changed && previous.activeOperationId) {
      await this.cancelOperation(
        tabId,
        new ChatMuseError('chat_changed'),
        true,
      );
    }
    await this.refreshTabState(tabId, 'tab:state');
  }

  private async buildTabUiState(tabId: number): Promise<TabUiState> {
    const storage = await loadStorageState();
    const context = this.tabContexts.getOrCreate(tabId);
    const session = this.sessionStore.getSessionForTab(tabId);
    const legacyAccountId =
      this.sessionStore.getAccountIdForTab(tabId) ?? context.accountId;
    const accountId = session?.resolvedAccountId ?? legacyAccountId;
    this.tabContexts.setAccount(tabId, accountId);

    const mappedPersonalityId = resolveMappedPersonalityId(
      storage.accountMappings,
      accountId,
      legacyAccountId,
    );
    const mappedPersonalityName =
      storage.personalities.find((p) => p.id === mappedPersonalityId)?.name ??
      null;

    return {
      tabId,
      accountId,
      groupId: context.groupId,
      connected: Boolean(session?.connected),
      hasApiKey: Boolean(storage.settings.claudeApiKey),
      hasPersonalities: storage.personalities.length > 0,
      mappedPersonalityId,
      mappedPersonalityName,
    };
  }

  private send(tabId: number, message: BackgroundPortMessage): void {
    this.portsByTabId.get(tabId)?.postMessage(message);
  }

  private sendProgress(
    tabId: number,
    progress: OperationProgressPayload,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      type: 'operation:progress',
      ...progress,
      ...(profiling ? { profiling } : {}),
    });
  }

  private sendComplete(
    tabId: number,
    payload: CompletePayload,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      ...payload,
      ...(profiling ? { profiling } : {}),
    });
  }

  private sendError(
    tabId: number,
    payload: ErrorPayload,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      ...payload,
      ...(profiling ? { profiling } : {}),
    });
  }

  private sendDiscarded(
    tabId: number,
    payload: DiscardedPayload,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      ...payload,
      ...(profiling ? { profiling } : {}),
    });
  }

  private flushChunks(tabId: number, operation: ActiveOperation): void {
    if (!operation.flushBuffer) {
      operation.flushTimer = null;
      return;
    }

    const text = operation.flushBuffer;
    operation.flushBuffer = '';
    operation.flushTimer = null;
    this.send(tabId, {
      type: 'operation:chunk',
      operationId: operation.operationId,
      text,
    });
  }

  private scheduleChunkFlush(
    tabId: number,
    operation: ActiveOperation,
  ): void {
    if (operation.flushTimer !== null) {
      return;
    }

    operation.flushTimer = globalThis.setTimeout(() => {
      this.flushChunks(tabId, operation);
    }, STREAM_CHUNK_FLUSH_MS) as unknown as number;
  }

  private async validateStart(
    tabId: number,
    payload: OperationStartPayload,
  ): Promise<ValidatedOperationStart> {
    const [tab, storage] = await Promise.all([
      browser.tabs.get(tabId),
      loadStorageState(),
    ]);
    const urlGroupId = parseGroupIdFromUrl(tab.url);
    if (
      !tab.url?.includes('fansly.com') ||
      !urlGroupId ||
      urlGroupId !== payload.groupId
    ) {
      throw new ChatMuseError('chat_changed');
    }

    const session = this.sessionStore.getSessionForTab(tabId);
    const legacyAccountId = this.sessionStore.getAccountIdForTab(tabId);

    if (!storage.settings.claudeApiKey) {
      throw new ChatMuseError('missing_api_key');
    }
    if (storage.personalities.length === 0) {
      throw new ChatMuseError('no_personalities');
    }
    if (!legacyAccountId || !session) {
      throw new ChatMuseError('not_connected');
    }
    if (!session.connected) {
      throw new ChatMuseError('session_expired');
    }

    return {
      tab,
      urlGroupId,
      storage,
      session,
      legacyAccountId,
      messageCount: isDeepFeature(payload.feature)
        ? storage.settings.deepMessageCount
        : storage.settings.quickMessageCount,
    };
  }

  private async cancelOperation(
    tabId: number,
    error?: ChatMuseError,
    notifyDiscard = false,
  ): Promise<void> {
    const active = this.activeByTabId.get(tabId);
    if (!active) {
      return;
    }

    this.cancelledOperationIds.add(active.operationId);
    active.controller.abort();
    if (active.flushTimer !== null) {
      clearTimeout(active.flushTimer);
    }

    this.activeByTabId.delete(tabId);
    this.tabContexts.setActiveOperation(tabId, null);

    if (notifyDiscard) {
      this.sendDiscarded(tabId, {
        type: 'operation:discarded',
        operationId: active.operationId,
        error: toUserError(error ?? new ChatMuseError('chat_changed')),
      }, active.profiler);
    }
  }

  private clearCompletedOperation(tabId: number): void {
    const active = this.activeByTabId.get(tabId);
    if (!active) {
      return;
    }

    if (active.flushTimer !== null) {
      clearTimeout(active.flushTimer);
    }

    this.activeByTabId.delete(tabId);
    this.tabContexts.setActiveOperation(tabId, null);
    this.cancelledOperationIds.delete(active.operationId);
  }

  private getActive(tabId: number): ActiveOperation | null {
    return this.activeByTabId.get(tabId) ?? null;
  }

  private assertActive(
    tabId: number,
    operationId: string,
  ): ActiveOperation {
    const active = this.activeByTabId.get(tabId);
    if (!active || active.operationId !== operationId) {
      throw new ChatMuseError('chat_changed');
    }
    return active;
  }

  private async startOperation(
    tabId: number,
    payload: OperationStartPayload,
  ): Promise<void> {
    // SPEC-CORRECT: BLOCK concurrent ops (don't auto-cancel like Codex)
    const existing = this.activeByTabId.get(tabId);
    if (existing) {
      this.sendError(tabId, {
        type: 'operation:error',
        operationId: payload.operationId,
        error: toUserError(new ChatMuseError('another_operation')),
      });
      return;
    }

    const port = this.portsByTabId.get(tabId);
    if (!port) {
      return;
    }

    let timeout: number | null = null;
    let debugEnabled = false;
    try {
      const validated = await this.validateStart(tabId, payload);
      debugEnabled = validated.storage.settings.debugMode;
      const profiler = createOperationProfiler(debugEnabled);
      const timeoutController = new AbortController();
      timeout = globalThis.setTimeout(
        () => timeoutController.abort(),
        resolveTimeout(payload.feature),
      ) as unknown as number;
      const controller = new AbortController();
      const signal = AbortSignal.any([
        controller.signal,
        timeoutController.signal,
      ]);

      const active: ActiveOperation = {
        operationId: payload.operationId,
        tabId,
        feature: payload.feature,
        groupId: validated.urlGroupId,
        routeNonce: payload.routeNonce,
        controller,
        rawText: '',
        flushBuffer: '',
        flushTimer: null,
        profiler,
      };

      this.activeByTabId.set(tabId, active);
      this.tabContexts.setActiveOperation(tabId, payload.operationId);
      this.tabContexts.setRoute(
        tabId,
        validated.urlGroupId,
        payload.routeNonce,
      );

      let progressPhase: OperationPhase = 'loading-messages';
      let progressMessage: string | undefined =
        payload.feature === 'ping' ? 'Loading messages…' : undefined;
      let progressCurrentPage: number | undefined;
      let progressTargetPages: number | undefined;

      type OperationProgressUpdate = {
        phase?: OperationPhase;
        message?: string | undefined;
        currentPage?: number | undefined;
        targetPages?: number | undefined;
      };

      const sendOperationProgress = (updates?: OperationProgressUpdate): void => {
        if (updates) {
          if ('phase' in updates && updates.phase) {
            progressPhase = updates.phase;
          }
          if ('message' in updates) {
            progressMessage = updates.message;
          }
          if ('currentPage' in updates) {
            progressCurrentPage = updates.currentPage;
          }
          if ('targetPages' in updates) {
            progressTargetPages = updates.targetPages;
          }
        }

        this.sendProgress(
          tabId,
          {
            operationId: payload.operationId,
            feature: payload.feature,
            phase: progressPhase,
            message: progressMessage,
            currentPage: progressCurrentPage,
            targetPages: progressTargetPages,
          },
          profiler,
        );
      };

      const sendDebugProgress = (updates?: OperationProgressUpdate): void => {
        if (!profiler.enabled) {
          return;
        }
        sendOperationProgress(updates);
      };

      const startStage = (
        key: Parameters<OperationProfiler['startStage']>[0],
        label: string,
        detail?: string,
        progressUpdates?: OperationProgressUpdate,
      ): void => {
        profiler.startStage(key, label, detail);
        profiler.log(label);
        sendDebugProgress(progressUpdates);
      };

      const completeStage = (
        key: Parameters<OperationProfiler['completeStage']>[0],
        logMessage: string,
        detail?: string,
        progressUpdates?: OperationProgressUpdate,
      ): void => {
        profiler.completeStage(key, detail);
        profiler.log(logMessage);
        sendDebugProgress(progressUpdates);
      };

      const failStage = (
        key: Parameters<OperationProfiler['failStage']>[0],
        logMessage: string,
        detail?: string,
        progressUpdates?: OperationProgressUpdate,
      ): void => {
        profiler.failStage(key, detail);
        profiler.log(logMessage);
        sendDebugProgress(progressUpdates);
      };

      const skipStage = (
        key: Parameters<OperationProfiler['skipStage']>[0],
        label: string,
        detail: string,
        progressUpdates?: OperationProgressUpdate,
      ): void => {
        profiler.skipStage(key, label, detail);
        profiler.log(`${label} skipped: ${detail}`);
        sendDebugProgress(progressUpdates);
      };

      sendOperationProgress();

      let resolvedAccountId = validated.legacyAccountId;
      let authenticatedIdentityResolved = false;
      startStage('resolve-identity', 'Resolve account identity');
      try {
        resolvedAccountId =
          await this.fanslyClient.getAuthenticatedAccountId(
            validated.session,
            signal,
          );
        authenticatedIdentityResolved = true;
        completeStage(
          'resolve-identity',
          `Resolved account identity: ${resolvedAccountId}`,
          `resolved ${resolvedAccountId}`,
        );
        logDebug(debugEnabled, 'account identity resolved', {
          legacyAccountId: validated.legacyAccountId,
          resolvedAccountId,
        });
      } catch (error) {
        const failureCode = errorCode(error);
        failStage(
          'resolve-identity',
          payload.feature === 'ping'
            ? 'Resolve account identity failed, using legacy account id'
            : `Resolve account identity failed: ${failureCode}`,
          payload.feature === 'ping'
            ? 'failed, using legacy account id'
            : failureCode,
        );
        logDebug(debugEnabled, 'account identity resolution failed', {
          legacyAccountId: validated.legacyAccountId,
          code: failureCode,
        });
        if (payload.feature !== 'ping') {
          throw error;
        }
      }

      const rekeyResult = await rekeyAccountIdentity(
        validated.legacyAccountId,
        resolvedAccountId,
      );
      if (
        rekeyResult.mappingMigrated ||
        rekeyResult.mappingConflict ||
        rekeyResult.knownAccountsChanged
      ) {
        logDebug(debugEnabled, 'account identity rekeyed', {
          legacyAccountId: validated.legacyAccountId,
          resolvedAccountId,
          mappingMigrated: rekeyResult.mappingMigrated,
          mappingConflict: rekeyResult.mappingConflict,
          knownAccountsChanged: rekeyResult.knownAccountsChanged,
        });
      }

      const storage = rekeyResult.state;
      const personalityId = resolveMappedPersonalityId(
        storage.accountMappings,
        resolvedAccountId,
        validated.legacyAccountId,
      );
      if (!personalityId) {
        throw new ChatMuseError('no_mapping');
      }

      const personality = storage.personalities.find(
        (entry) => entry.id === personalityId,
      );
      if (!personality) {
        throw new ChatMuseError('no_mapping');
      }

      const resolvedModel = validated.storage.settings.featureModels[payload.feature];

      let cachedSummary = null;
      if (payload.feature === 'fan-summary') {
        startStage('summary-cache-check', 'Check summary cache');
        if (payload.forceRegenerate) {
          profiler.log('Forced summary refresh');
          await removeSummaryCache(validated.urlGroupId);
        }
        cachedSummary = payload.forceRegenerate
          ? null
          : await getSummaryCache(validated.urlGroupId);
      }

      if (
        payload.feature === 'fan-summary' &&
        cachedSummary &&
        cachedSummary.personalityId === personality.id &&
        cachedSummary.personalityUpdatedAt === personality.updatedAt &&
        cachedSummary.modelId === resolvedModel &&
        cachedSummary.spendingDataVerified === true &&
        cachedSummary.subscriptionLookupVerified === true
      ) {
        const result: FeatureResult = {
          rawText: cachedSummary.summary,
          summaryMeta: {
            generatedAt: cachedSummary.generatedAt,
            stale: false,
            cached: true,
          },
        };
        this.assertActive(tabId, payload.operationId);
        completeStage(
          'summary-cache-check',
          'Summary cache hit',
          'cache hit',
        );
        this.sendComplete(tabId, {
          type: 'operation:complete',
          operationId: payload.operationId,
          result,
          fanDisplayName: payload.domFanDisplayName ?? 'fan',
        }, profiler);
        this.clearCompletedOperation(tabId);
        return;
      }

      if (payload.feature === 'fan-summary') {
        completeStage(
          'summary-cache-check',
          `Summary cache miss${
            payload.forceRegenerate ? ' after forced refresh' : ''
          }`,
          payload.forceRegenerate
            ? 'forced refresh, cache miss'
            : 'cache miss',
        );
      }

      startStage('load-messages', 'Load messages');
      profiler.log(`Requested ${validated.messageCount} messages`);
      sendDebugProgress();
      const shouldReportMessageProgress =
        profiler.enabled || isDeepFeature(payload.feature);
      const messageLoad = await this.fanslyClient.loadMessages(
        validated.urlGroupId,
        validated.messageCount,
        validated.session,
        resolvedAccountId,
        signal,
        shouldReportMessageProgress
          ? (progress) => {
              if (profiler.enabled) {
                profiler.log(describeMessageLoadProgress(progress));
              }
              if (isDeepFeature(payload.feature)) {
                sendOperationProgress({
                  phase: 'loading-messages',
                  currentPage: progress.currentPage,
                  targetPages: progress.targetPages,
                  message: `Loading messages… ${progress.currentPage}/${progress.targetPages} pages`,
                });
                return;
              }
              sendDebugProgress({
                phase: 'loading-messages',
                currentPage: progress.currentPage,
                targetPages: progress.targetPages,
              });
            }
          : undefined,
      );
      completeStage(
        'load-messages',
        `Loaded messages: ${messageLoad.pagesLoaded} pages, ${messageLoad.transcriptMessages.length} transcript messages`,
        `${messageLoad.pagesLoaded} pages, ${messageLoad.transcriptMessages.length} transcript messages`,
      );

      if (
        isDeepFeature(payload.feature) &&
        messageLoad.transcriptMessages.length < MIN_MESSAGES_FOR_DEEP
      ) {
        throw new ChatMuseError('not_enough_history');
      }

      let pingSegment: PingSegment | undefined;
      if (payload.feature === 'ping') {
        startStage('ping-analysis', 'Analyze ping segment');
        const pingAnalysis = analyzePingSegment(
          messageLoad.transcriptMessages,
          Date.now(),
        );
        pingSegment = pingAnalysis.segment;
        completeStage(
          'ping-analysis',
          `Ping segment selected: ${pingAnalysis.segment}`,
          pingAnalysis.segment,
        );
        logDebug(debugEnabled, 'ping segment selected', {
          groupId: validated.urlGroupId,
          segment: pingAnalysis.segment,
          fanTextMessageCount: pingAnalysis.fanTextMessageCount,
          latestFanTextAtMs: pingAnalysis.latestFanTextAtMs,
        });

        if (pingSegment === 'active') {
          this.sendError(tabId, {
            type: 'operation:error',
            operationId: payload.operationId,
            error: toUserError(new ChatMuseError('ping_blocked')),
          }, profiler);
          this.clearCompletedOperation(tabId);
          return;
        }
      }

      let groupUsers: Array<{ userId: string }> | null = null;
      if (payload.feature !== 'ping' || authenticatedIdentityResolved) {
        startStage('group-lookup', 'Load group users');
        try {
          const group = await this.fanslyClient.getGroup(
            validated.urlGroupId,
            validated.session,
            signal,
          );
          groupUsers = (group.users ?? []).filter(
            (user): user is { userId: string } =>
              typeof user.userId === 'string' && user.userId.length > 0,
          );
          completeStage(
            'group-lookup',
            `Loaded group users: ${groupUsers.length}`,
            `${groupUsers.length} users`,
          );
        } catch (error) {
          const failureCode = errorCode(error);
          failStage(
            'group-lookup',
            `Load group users failed: ${failureCode}`,
            failureCode,
          );
          logDebug(debugEnabled, 'group enrichment failed', {
            groupId: validated.urlGroupId,
            code: failureCode,
          });
        }
      } else {
        skipStage(
          'group-lookup',
          'Load group users',
          'skipped for ping without authenticated identity',
        );
      }

      let fanAccountId: string | null = null;
      let fanDisplayName = payload.domFanDisplayName ?? 'fan';
      fanAccountId =
        groupUsers?.find(
          (user) => user.userId !== resolvedAccountId,
        )?.userId ?? null;

      if (fanAccountId) {
        startStage('account-name-lookup', 'Resolve fan display name');
        try {
          const accounts = await this.fanslyClient.getAccountNames(
            [fanAccountId],
            validated.session,
            signal,
          );
          const account = accounts[0];
          fanDisplayName =
            account?.username?.trim() ||
            account?.displayName?.trim() ||
            payload.domFanDisplayName ||
            'fan';
          completeStage(
            'account-name-lookup',
            `Resolved fan display name: ${fanDisplayName}`,
            `resolved ${fanDisplayName}`,
          );
        } catch (error) {
          const failureCode = errorCode(error);
          failStage(
            'account-name-lookup',
            `Resolve fan display name failed: ${failureCode}`,
            failureCode,
          );
          logDebug(debugEnabled, 'fan display name lookup failed', {
            fanAccountId,
            code: failureCode,
          });
        }
      } else {
        skipStage(
          'account-name-lookup',
          'Resolve fan display name',
          'fan account unavailable',
        );
      }

      this.tabContexts.setFan(tabId, fanAccountId, fanDisplayName);
      sendOperationProgress({
        phase: 'generating',
        message: 'Generating…',
        currentPage: undefined,
        targetPages: undefined,
      });

      let spendingData = '';
      let spendingDataVerified = false;
      let subscriptionData = '';
      let subscriptionLookupVerified = false;
      const subscriptionLookupMode = resolveSubscriptionLookupMode(
        payload.feature,
      );

      if (fanAccountId) {
        startStage('earnings', 'Fetch earnings');
        startStage('subscription-lookup', 'Lookup subscription');
        const subscriptionTraceSteps: string[] = [];
        const handleSubscriptionTrace = (
          event: SubscriptionLookupTraceEvent,
        ): void => {
          const step = describeSubscriptionTraceStep(event);
          switch (event.type) {
            case 'cache-hit':
            case 'cache-miss':
            case 'cache-only-skip':
            case 'groups-hit':
            case 'groups-miss':
            case 'groups-error':
            case 'subscribers-hit':
            case 'subscribers-miss':
              subscriptionTraceSteps.push(step);
              break;
            default:
              break;
          }

          switch (event.type) {
            case 'groups-start':
              profiler.log('Lookup subscription via messaging groups');
              break;
            case 'groups-hit':
              profiler.log('Subscription found in messaging groups');
              break;
            case 'groups-miss':
              profiler.log('Subscription missing from messaging groups');
              break;
            case 'groups-error':
              profiler.log(
                `Messaging groups lookup failed (${event.code}), falling back to subscribers`,
              );
              break;
            case 'subscribers-start':
              profiler.log('Lookup subscription via subscribers');
              break;
            case 'subscribers-hit':
              profiler.log('Subscription found in subscribers');
              break;
            case 'subscribers-miss':
              profiler.log('Subscription missing from subscribers');
              break;
            case 'cache-hit':
            case 'cache-miss':
            case 'cache-only-skip':
              profiler.log(`Subscription lookup ${step}`);
              break;
          }
          sendDebugProgress();
        };

        const subscriptionRequest = profiler.enabled
          ? this.fanslyClient.getFanSubscriptionContext(
              validated.urlGroupId,
              fanAccountId,
              validated.session,
              signal,
              subscriptionLookupMode,
              handleSubscriptionTrace,
            )
          : this.fanslyClient.getFanSubscriptionContext(
              validated.urlGroupId,
              fanAccountId,
              validated.session,
              signal,
              subscriptionLookupMode,
            );
        const windowEndMs = Date.now();
        const [earningsResult, subscriptionResult] =
          await Promise.allSettled([
            this.fanslyClient.getEarnings(
              fanAccountId,
              messageLoad.windowStartMs,
              windowEndMs,
              validated.session,
              signal,
            ),
            subscriptionRequest,
          ]);

        if (earningsResult.status === 'fulfilled') {
          const aggregated = earningsResult.value;
          if (aggregated) {
            spendingData = formatFanSpendingData(aggregated);
            spendingDataVerified = true;
            completeStage(
              'earnings',
              'Fetched earnings: data found',
              'data found',
            );
          } else {
            completeStage(
              'earnings',
              'Fetched earnings: no earnings data',
              'no earnings data',
            );
          }
        } else {
          failStage(
            'earnings',
            'Fetch earnings failed (fail-open)',
            'fail-open',
          );
          logDebug(debugEnabled, 'earnings fetch failed (fail-open)', {
            fanAccountId,
          });
        }

        if (subscriptionResult.status === 'fulfilled') {
          subscriptionLookupVerified = subscriptionLookupMode === 'full';
          if (subscriptionResult.value) {
            subscriptionData = formatFanSubscriptionData(
              subscriptionResult.value,
            );
          }
          const pathDetail = subscriptionTraceSteps.join(' -> ');
          const subscriptionDetail = subscriptionResult.value
            ? `${pathDetail} (${subscriptionResult.value.source})`
            : `${pathDetail}${pathDetail ? ' -> ' : ''}not found`;
          completeStage(
            'subscription-lookup',
            `Subscription lookup complete: ${subscriptionDetail}`,
            subscriptionDetail,
          );
        } else {
          const failureDetail = subscriptionTraceSteps.length > 0
            ? `${subscriptionTraceSteps.join(' -> ')} -> fail-open`
            : 'fail-open';
          failStage(
            'subscription-lookup',
            `Subscription lookup failed: ${failureDetail}`,
            failureDetail,
          );
          logDebug(
            debugEnabled,
            'subscription fetch failed (fail-open)',
            { fanAccountId },
          );
        }
        sendDebugProgress();
      } else {
        skipStage('earnings', 'Fetch earnings', 'fan account unavailable');
        skipStage(
          'subscription-lookup',
          'Lookup subscription',
          'fan account unavailable',
        );
      }

      startStage('prompt-build', 'Build Claude prompt');
      const formattedTranscript = formatTranscript(
        messageLoad.transcriptMessages,
      );
      const prompt = buildPrompt({
        feature: payload.feature,
        personality,
        transcript: formattedTranscript,
        fanSpendingData: spendingData,
        fanSubscriptionData: subscriptionData,
        fanDisplayName,
        pingSegment,
        replyMode:
          payload.feature === 'fast-reply'
            ? (payload.replyMode ?? 'default')
            : undefined,
      });
      completeStage(
        'prompt-build',
        `Built Claude prompt: ${messageLoad.transcriptMessages.length} transcript messages`,
        `${messageLoad.transcriptMessages.length} transcript messages`,
      );

      if (profiler.enabled) {
        this.send(tabId, {
          type: 'operation:debugPrompt',
          operationId: payload.operationId,
          feature: payload.feature,
          snapshot: {
            feature: payload.feature,
            modelId: resolvedModel,
            system: prompt.system,
            transcript: formattedTranscript,
            fanSpendingData: spendingData,
            fanSubscriptionData: subscriptionData,
            user: prompt.user,
          },
        });
      }

      let sawFirstChunk = false;
      startStage('claude-ttfb', 'Wait for Claude TTFB');
      profiler.log('Waiting for Claude');
      sendDebugProgress();

      const streamArgs = {
        apiKey: validated.storage.settings.claudeApiKey,
        model: resolvedModel,
        system: prompt.system,
        user: prompt.user,
        feature: payload.feature,
        signal,
        onText: (chunk: string) => {
          const current = this.getActive(tabId);
          if (
            !current ||
            current.operationId !== payload.operationId
          ) {
            return;
          }
          if (!sawFirstChunk) {
            sawFirstChunk = true;
            profiler.completeStage('claude-ttfb', 'first chunk received');
            profiler.log('Claude first token');
            profiler.startStage('claude-stream', 'Stream Claude response');
            profiler.log('Stream Claude response');
            sendDebugProgress();
          }
          current.rawText += chunk;
          current.flushBuffer += chunk;
          this.scheduleChunkFlush(tabId, current);
        },
      } as const;

      let actualModel = resolvedModel;
      let rawText: string;
      try {
        rawText = await this.anthropicClient.streamMessage(streamArgs);
      } catch (err) {
        const defaultModel = DEFAULT_FEATURE_MODELS[payload.feature];
        const isModelError = err instanceof ChatMuseError
          ? err.code === 'model_unavailable'
          : (err as { code?: string })?.code === 'model_unavailable';
        if (isModelError && resolvedModel !== defaultModel) {
          actualModel = defaultModel;
          profiler.log(`Model ${resolvedModel} unavailable, retrying with ${defaultModel}`);
          if (profiler.enabled) {
            this.send(tabId, {
              type: 'operation:debugPrompt',
              operationId: payload.operationId,
              feature: payload.feature,
              snapshot: {
                feature: payload.feature,
                modelId: defaultModel,
                system: streamArgs.system,
                transcript: formattedTranscript,
                fanSpendingData: spendingData,
                fanSubscriptionData: subscriptionData,
                user: streamArgs.user,
              },
            });
          }
          rawText = await this.anthropicClient.streamMessage({ ...streamArgs, model: defaultModel });
        } else {
          throw err;
        }
      }

      if (sawFirstChunk) {
        completeStage(
          'claude-stream',
          `Claude stream complete: ${rawText.length} chars`,
          `${rawText.length} chars`,
        );
      } else {
        completeStage(
          'claude-ttfb',
          'Claude completed without streamed text',
          'completed without streamed text',
        );
        skipStage(
          'claude-stream',
          'Stream Claude response',
          'no streamed chunks',
        );
      }

      const current = this.assertActive(tabId, payload.operationId);
      if (current.flushTimer !== null) {
        clearTimeout(current.flushTimer);
        this.flushChunks(tabId, current);
      }

      const result: FeatureResult =
        payload.feature === 'help-me'
          ? { rawText, helpMe: parseHelpMeXml(rawText) }
          : payload.feature === 'chat-review'
            ? { rawText, chatReview: parseChatReviewXml(rawText) }
            : {
                rawText,
                ...(payload.feature === 'fast-reply'
                  ? {
                      splitModeRequested:
                        payload.replyMode === 'preferSplit',
                    }
                  : {}),
                parts: rawText
                  .split('[NEXT]')
                  .map((part) => part.trim())
                  .filter(Boolean),
              };

      if (payload.feature === 'fan-summary') {
        const generatedAt = Date.now();
        result.summaryMeta = {
          generatedAt,
          stale: false,
          cached: false,
        };
        if (spendingDataVerified && subscriptionLookupVerified && actualModel === resolvedModel) {
          await saveSummaryCache(validated.urlGroupId, {
            summary: rawText,
            personalityId: personality.id,
            personalityUpdatedAt: personality.updatedAt,
            generatedAt,
            spendingDataVerified: true,
            subscriptionLookupVerified: true,
            modelId: resolvedModel,
          });
        }
      }

      this.sendComplete(tabId, {
        type: 'operation:complete',
        operationId: payload.operationId,
        result,
        fanDisplayName,
      }, profiler);

      this.clearCompletedOperation(tabId);
    } catch (error) {
      const active = this.getActive(tabId);
      const operationId = active?.operationId ?? payload.operationId;
      if (this.cancelledOperationIds.delete(operationId)) {
        return;
      }
      active?.profiler.finalizeRunningStages('operation failed');

      if (
        error instanceof DOMException &&
        error.name === 'AbortError'
      ) {
        const code = active
          ? new ChatMuseError('timed_out')
          : new ChatMuseError('chat_changed');
        const errorPayload: ErrorPayload = {
          type: 'operation:error',
          operationId,
          error: toUserError(code),
        };
        this.sendError(
          tabId,
          errorPayload,
          active?.profiler ?? NO_OP_PROFILER,
        );
      } else {
        const errorPayload: ErrorPayload = {
          type: 'operation:error',
          operationId,
          error: toUserError(error),
        };
        this.sendError(
          tabId,
          errorPayload,
          active?.profiler ?? NO_OP_PROFILER,
        );
      }

      logDebug(debugEnabled, 'operation error', error);
      await this.cancelOperation(tabId);
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    }
  }
}
