import {
  AGENCY_HUB_SYNC_TIMEOUT_MS,
  DEEP_OPERATION_CLAUDE_IDLE_TIMEOUT_MS,
  DEEP_OPERATION_CLAUDE_MAX_STREAM_TIMEOUT_MS,
  DEEP_OPERATION_CLAUDE_TTFB_TIMEOUT_MS,
  DEEP_OPERATION_PREP_TIMEOUT_MS,
  FEATURE_TEMPERATURES,
  DEFAULT_FEATURE_MODELS,
  MIN_MESSAGES_FOR_DEEP,
  QUICK_OPERATION_TIMEOUT_MS,
  STREAM_CHUNK_FLUSH_MS,
} from '../shared/constants.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { mapWithConcurrency } from '../shared/concurrency.js';
import {
  aggregateMonthlyEarnings,
  formatFanSpendingData,
  monthWindowMs,
} from '../shared/earnings.js';
import {
  getCompareDraftCount,
  resolveMappedPersonalityId,
} from '../shared/compare-cards.js';
import { ChatMuseError, toUserError } from '../shared/errors.js';
import {
  featureRequiresDraft,
  featureUsesPingSegment,
  getFeaturePolicy,
  isDeepFeature,
  resolveFeatureMessageCount,
  resolveFeatureModelFeature,
} from '../shared/features.js';
import { logDebug } from '../shared/log.js';
import { buildPromptRequest } from '../shared/prompts.js';
import { splitByNext } from '../shared/split.js';
import { formatFanSubscriptionData } from '../shared/subscriptions.js';
import { analyzePingSegment, formatTranscript } from '../shared/transcript.js';
import { parseChatReviewXml, parseHelpMeXml } from '../shared/xml.js';
import type {
  AggregatedEarnings,
  AnthropicCostEstimate,
  AnthropicSpendSummary,
  AnthropicUsageMetrics,
  BackgroundPortMessage,
  CompareStartPayload,
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
  Settings,
  SubscriptionLookupMode,
  RouteChangedPayload,
  SessionTemplate,
  SummaryCacheEntry,
  TabStatePayload,
  TabUiState,
} from '../shared/types.js';
import { AgencyHubClient } from './agency-hub-client.js';
import { AnthropicClient } from './anthropic-client.js';
import {
  buildAnthropicSpendSummary,
  createZeroAnthropicSpendSummary,
  estimateAnthropicCost,
  formatAnthropicCostLog,
} from './anthropic-cost.js';
import {
  cancelCompareOperation,
  executeCompare,
  type ActiveCompareOperation,
  type CompareOperationsContext,
} from './compare-operations.js';
import type { SubscriptionLookupTraceEvent } from './fansly-client.js';
import { FanslyClient } from './fansly-client.js';
import {
  createOperationProfiler,
  type OperationProfiler,
} from './operation-profiling.js';
import {
  describeMessageLoadProgress,
  describeSubscriptionTraceStep,
  errorCode,
  parseGroupIdFromUrl,
  resolveAbortChatMuseError,
} from './operation-utils.js';
import { SessionStore } from './session-store.js';
import { StorageCoordinator } from './storage-coordinator.js';
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
  anthropicSpend: AnthropicSpendSummary | null;
  profiler: OperationProfiler;
}

const NO_OP_PROFILER = createOperationProfiler(false);
const CAPTURE_IDENTITY_TIMEOUT_MS = 5_000;
const DEEP_OPERATION_TIMEOUTS = {
  prep: DEEP_OPERATION_PREP_TIMEOUT_MS,
  claudeTtfb: DEEP_OPERATION_CLAUDE_TTFB_TIMEOUT_MS,
  claudeIdle: DEEP_OPERATION_CLAUDE_IDLE_TIMEOUT_MS,
  claudeMaxStream: DEEP_OPERATION_CLAUDE_MAX_STREAM_TIMEOUT_MS,
} as const;
type OperationTimeoutKey =
  | 'quick-total'
  | 'deep-prep'
  | 'claude-ttfb'
  | 'claude-idle'
  | 'claude-max-stream';

interface ValidatedOperationStart {
  tab: browser.tabs.Tab;
  urlGroupId: string;
  storage: PersistedState;
  session: SessionTemplate;
  legacyAccountId: string;
  messageCount: number;
}

interface OperationPromptRequestArgs {
  feature: FeatureType;
  personality: PersistedState['personalities'][number];
  transcript: string;
  fanSpendingData: string;
  fanSubscriptionData: string;
  fanDisplayName: string;
  draftText?: string;
  pingSegment?: PingSegment;
  replyMode?: OperationStartPayload['replyMode'];
  replyTone?: OperationStartPayload['replyTone'];
  promptCachingEnabled: boolean;
}

interface AgencyHubSummarySyncTask {
  groupId: string;
  settings: Settings;
  summary: string;
  generatedAt: number;
  existingSync?: SummaryCacheEntry['agencyHubSync'];
  fanAccountId: string | null;
  session: SessionTemplate;
  resolvedAccountId: string;
  debugEnabled: boolean;
}

function usesDeepOperationTimeouts(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).timeoutBucket === 'deep';
}

function buildOperationPromptRequest({
  feature,
  personality,
  transcript,
  fanSpendingData,
  fanSubscriptionData,
  fanDisplayName,
  draftText,
  pingSegment,
  replyMode,
  replyTone,
  promptCachingEnabled,
}: OperationPromptRequestArgs) {
  return buildPromptRequest(
    {
      feature,
      personality,
      transcript,
      fanSpendingData,
      fanSubscriptionData,
      fanDisplayName,
      draftText,
      pingSegment,
      replyMode,
      replyTone,
    },
    promptCachingEnabled,
  );
}

function buildFeatureResult(
  feature: FeatureType,
  rawText: string,
  replyMode?: OperationStartPayload['replyMode'],
): FeatureResult {
  switch (getFeaturePolicy(feature).resultKind) {
    case 'help-me':
      return { rawText, helpMe: parseHelpMeXml(rawText) };
    case 'chat-review':
      return { rawText, chatReview: parseChatReviewXml(rawText) };
    case 'single-reply':
      return {
        rawText,
        parts: [rawText.trim() || rawText],
      };
    case 'summary':
      return { rawText };
    case 'reply':
      return {
        rawText,
        ...(getFeaturePolicy(feature).supportsReplyMode
          ? {
              splitModeRequested: replyMode === 'preferSplit',
            }
          : {}),
        parts: splitByNext(rawText),
      };
  }
}

function formatAnthropicUsageLog(usage: AnthropicUsageMetrics): string {
  return `Claude usage: input_tokens=${usage.input_tokens}, cache_creation_input_tokens=${usage.cache_creation_input_tokens}, cache_read_input_tokens=${usage.cache_read_input_tokens}, output_tokens=${usage.output_tokens}`;
}

export class OperationCoordinator {
  private readonly portsByTabId = new Map<number, browser.runtime.Port>();
  private readonly activeByTabId = new Map<number, ActiveOperation>();
  private readonly activeCompareByTabId = new Map<number, ActiveCompareOperation>();
  private readonly cancelledOperationIds = new Set<string>();
  private readonly cancelledCompareOperationIds = new Set<string>();
  private readonly pendingIdentityResolutionByLegacyAccountId = new Map<
    string,
    {
      promise: Promise<void>;
      waitingTabIds: Set<number>;
    }
  >();

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly tabContexts: TabContextStore,
    private readonly fanslyClient: FanslyClient,
    private readonly anthropicClient: AnthropicClient,
    private readonly storageCoordinator: StorageCoordinator,
    private readonly agencyHubClient: AgencyHubClient,
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
      if (this.portsByTabId.get(tabId) !== port) return;
      this.portsByTabId.delete(tabId);
      void this.cancelOperation(tabId);
      this.cancelCompare(tabId);
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
    void this.resolveCapturedIdentity(tabId, accountId);
  }

  async handleTabRemoved(tabId: number): Promise<void> {
    await this.cancelOperation(tabId);
    this.cancelCompare(tabId);
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
      case 'compare:start':
        await this.startCompare(tabId, message);
        break;
      case 'operation:cancel': {
        const active = this.activeByTabId.get(tabId);
        if (active && active.operationId === message.operationId) {
          await this.cancelOperation(tabId);
        }
        break;
      }
      case 'compare:cancel': {
        const active = this.activeCompareByTabId.get(tabId);
        if (active && active.operationId === message.operationId) {
          this.cancelCompare(tabId);
        }
        break;
      }
      default:
        break;
    }
  }

  private async resolveCapturedIdentity(
    tabId: number,
    legacyAccountId: string,
  ): Promise<void> {
    if (!legacyAccountId) {
      return;
    }

    const pending = this.pendingIdentityResolutionByLegacyAccountId.get(
      legacyAccountId,
    );
    if (pending) {
      pending.waitingTabIds.add(tabId);
      await pending.promise;
      return;
    }

    const waitingTabIds = new Set([tabId]);

    const task = (async () => {
      const session = this.sessionStore.getSessionByAccount(legacyAccountId);
      if (!session || session.resolvedAccountId) {
        return;
      }

      const controller = new AbortController();
      const timeout = globalThis.setTimeout(
        () => controller.abort(),
        CAPTURE_IDENTITY_TIMEOUT_MS,
      );

      try {
        const resolvedAccountId =
          await this.fanslyClient.getAuthenticatedAccountId(
            session,
            controller.signal,
          );
        const rekeyResult = await this.storageCoordinator.rekeyAccountIdentity(
          legacyAccountId,
          resolvedAccountId,
        );
        const canonicalAccountId = session.resolvedAccountId ?? resolvedAccountId;
        await Promise.all(
          Array.from(waitingTabIds).map(async (waitingTabId) => {
            this.tabContexts.setAccount(waitingTabId, canonicalAccountId);
            await this.refreshTabState(waitingTabId, 'mapping:changed');
          }),
        );
        if (
          rekeyResult.mappingMigrated ||
          rekeyResult.mappingConflict ||
          rekeyResult.knownAccountsChanged
        ) {
          await this.refreshAllTabs('mapping:changed');
        }
      } catch {
        // Capture-time identity enrichment is best effort only.
      } finally {
        globalThis.clearTimeout(timeout);
      }
    })().finally(() => {
      this.pendingIdentityResolutionByLegacyAccountId.delete(legacyAccountId);
    });

    this.pendingIdentityResolutionByLegacyAccountId.set(legacyAccountId, {
      promise: task,
      waitingTabIds,
    });
    await task;
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
    if (changed && this.activeCompareByTabId.has(tabId)) {
      this.cancelCompare(tabId, new ChatMuseError('chat_changed'), true);
    }
    await this.refreshTabState(tabId, 'tab:state');
  }

  private async buildTabUiState(tabId: number): Promise<TabUiState> {
    const storage = await this.storageCoordinator.getState();
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
      storage.accountAliases,
    );
    const mappedPersonalityName =
      storage.personalities.find((p) => p.id === mappedPersonalityId)?.name ??
      null;
    const compareDraftCount = getCompareDraftCount();

    return {
      tabId,
      accountId,
      groupId: context.groupId,
      connected: Boolean(session?.connected),
      hasApiKey: Boolean(storage.settings.claudeApiKey),
      hasPersonalities: storage.personalities.length > 0,
      mappedPersonalityId,
      mappedPersonalityName,
      compareCardCount: compareDraftCount + (mappedPersonalityId ? 1 : 0),
      compareDraftCount,
    };
  }

  private send(tabId: number, message: BackgroundPortMessage): void {
    this.portsByTabId.get(tabId)?.postMessage(message);
  }

  private sendProgress(
    tabId: number,
    progress: OperationProgressPayload,
    anthropicSpend?: AnthropicSpendSummary,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      type: 'operation:progress',
      ...progress,
      ...(anthropicSpend ? { anthropicSpend } : {}),
      ...(profiling ? { profiling } : {}),
    });
  }

  private sendComplete(
    tabId: number,
    payload: CompletePayload,
    anthropicSpend?: AnthropicSpendSummary,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      ...payload,
      ...(anthropicSpend ? { anthropicSpend } : {}),
      ...(profiling ? { profiling } : {}),
    });
  }

  private sendError(
    tabId: number,
    payload: ErrorPayload,
    anthropicSpend?: AnthropicSpendSummary,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      ...payload,
      ...(anthropicSpend ? { anthropicSpend } : {}),
      ...(profiling ? { profiling } : {}),
    });
  }

  private sendDiscarded(
    tabId: number,
    payload: DiscardedPayload,
    anthropicSpend?: AnthropicSpendSummary,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      ...payload,
      ...(anthropicSpend ? { anthropicSpend } : {}),
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
      this.storageCoordinator.getState(),
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
      messageCount: resolveFeatureMessageCount(
        payload.feature,
        storage.settings,
      ),
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
      }, active.anthropicSpend ?? createZeroAnthropicSpendSummary(), active.profiler);
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

  private enqueueAgencyHubSummarySync(task: AgencyHubSummarySyncTask): void {
    if (!this.agencyHubClient.isConfigured(task.settings)) {
      return;
    }

    void this.syncAgencyHubSummary(task);
  }

  private async resolveCreatorUsername(
    session: SessionTemplate,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (session.resolvedUsername?.trim()) {
      return session.resolvedUsername.trim();
    }

    const account = await this.fanslyClient.getAuthenticatedAccount(session, signal);
    return account.username?.trim() || null;
  }

  private async resolveFanAccountIdForSync(
    groupId: string,
    session: SessionTemplate,
    resolvedAccountId: string,
    fanAccountId: string | null,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (fanAccountId?.trim()) {
      return fanAccountId.trim();
    }

    const group = await this.fanslyClient.getGroup(groupId, session, signal);
    return (group.users ?? []).find(
      (user): user is { userId: string } =>
        typeof user.userId === 'string' &&
        user.userId.length > 0 &&
        user.userId !== resolvedAccountId,
    )?.userId ?? null;
  }

  private async syncAgencyHubSummary(task: AgencyHubSummarySyncTask): Promise<void> {
    const timeoutController = new AbortController();
    const timeoutHandle = globalThis.setTimeout(
      () => timeoutController.abort(),
      AGENCY_HUB_SYNC_TIMEOUT_MS,
    );

    try {
      const pageUsername = await this.resolveCreatorUsername(task.session, timeoutController.signal);
      const fanAccountId = await this.resolveFanAccountIdForSync(
        task.groupId,
        task.session,
        task.resolvedAccountId,
        task.fanAccountId,
        timeoutController.signal,
      );

      const result = await this.agencyHubClient.pushFanProfile({
        settings: task.settings,
        pageUsername,
        platformUserId: fanAccountId,
        body: task.summary,
        signal: timeoutController.signal,
        existingSync: task.existingSync,
        generatedAt: task.generatedAt,
      });

      logDebug(task.debugEnabled, 'agency hub summary sync', {
        status: result.status,
        reason: result.reason,
        baseUrl: result.baseUrl,
        pageLabel: result.pageLabel,
      });

      if (
        result.status !== 'pushed' ||
        !result.baseUrl ||
        !result.pageLabel
      ) {
        return;
      }

      await this.storageCoordinator.updateSummaryCache(task.groupId, (entry) => {
        if (entry.generatedAt !== task.generatedAt) {
          return entry;
        }

        return {
          ...entry,
          ...(fanAccountId ? { fanAccountId } : {}),
          agencyHubSync: {
            baseUrl: result.baseUrl!,
            pageLabel: result.pageLabel!,
            generatedAt: task.generatedAt,
            syncedAt: Date.now(),
          },
        };
      });
    } catch (error) {
      logDebug(task.debugEnabled, 'agency hub summary sync failed', error);
    } finally {
      clearTimeout(timeoutHandle);
    }
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
    const existing =
      this.activeByTabId.get(tabId) ?? this.activeCompareByTabId.get(tabId);
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

    const timeoutHandles = new Map<OperationTimeoutKey, number>();
    let timeoutController: AbortController | null = null;
    let controller: AbortController | null = null;
    let debugEnabled = false;
    try {
      const validated = await this.validateStart(tabId, payload);
      debugEnabled = validated.storage.settings.debugMode;
      const profiler = createOperationProfiler(debugEnabled);
      const operationTimeoutController = new AbortController();
      timeoutController = operationTimeoutController;
      const clearTimeoutHandle = (key: OperationTimeoutKey): void => {
        const handle = timeoutHandles.get(key);
        if (handle === undefined) {
          return;
        }
        clearTimeout(handle);
        timeoutHandles.delete(key);
      };
      const armTimeoutHandle = (
        key: OperationTimeoutKey,
        ms: number,
      ): void => {
        clearTimeoutHandle(key);
        const handle = globalThis.setTimeout(
          () => operationTimeoutController.abort(),
          ms,
        ) as unknown as number;
        timeoutHandles.set(key, handle);
      };
      const startClaudeTtfbTimeout = (): void => {
        if (!usesDeepOperationTimeouts(payload.feature)) {
          return;
        }
        clearTimeoutHandle('deep-prep');
        armTimeoutHandle('claude-ttfb', DEEP_OPERATION_TIMEOUTS.claudeTtfb);
      };
      const startClaudeStreamTimeouts = (): void => {
        if (!usesDeepOperationTimeouts(payload.feature)) {
          return;
        }
        clearTimeoutHandle('claude-ttfb');
        armTimeoutHandle('claude-idle', DEEP_OPERATION_TIMEOUTS.claudeIdle);
        armTimeoutHandle(
          'claude-max-stream',
          DEEP_OPERATION_TIMEOUTS.claudeMaxStream,
        );
      };
      const resetClaudeIdleTimeout = (): void => {
        if (!usesDeepOperationTimeouts(payload.feature)) {
          return;
        }
        armTimeoutHandle('claude-idle', DEEP_OPERATION_TIMEOUTS.claudeIdle);
      };
      const clearClaudeTimeouts = (): void => {
        clearTimeoutHandle('claude-ttfb');
        clearTimeoutHandle('claude-idle');
        clearTimeoutHandle('claude-max-stream');
      };
      if (usesDeepOperationTimeouts(payload.feature)) {
        armTimeoutHandle('deep-prep', DEEP_OPERATION_TIMEOUTS.prep);
      } else {
        armTimeoutHandle('quick-total', QUICK_OPERATION_TIMEOUT_MS);
      }
      const operationController = new AbortController();
      controller = operationController;
      const signal = AbortSignal.any([
        operationController.signal,
        operationTimeoutController.signal,
      ]);

      const active: ActiveOperation = {
        operationId: payload.operationId,
        tabId,
        feature: payload.feature,
        groupId: validated.urlGroupId,
        routeNonce: payload.routeNonce,
        controller: operationController,
        rawText: '',
        flushBuffer: '',
        flushTimer: null,
        anthropicSpend: null,
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
        featureUsesPingSegment(payload.feature) ? 'Loading messages…' : undefined;
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
          active.anthropicSpend ?? undefined,
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
          featureUsesPingSegment(payload.feature)
            ? 'Resolve account identity failed, using legacy account id'
            : `Resolve account identity failed: ${failureCode}`,
          featureUsesPingSegment(payload.feature)
            ? 'failed, using legacy account id'
            : failureCode,
        );
        logDebug(debugEnabled, 'account identity resolution failed', {
          legacyAccountId: validated.legacyAccountId,
          code: failureCode,
        });
        if (!featureUsesPingSegment(payload.feature)) {
          throw error;
        }
      }

      const rekeyResult = await this.storageCoordinator.rekeyAccountIdentity(
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
        storage.accountAliases,
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

      if (featureRequiresDraft(payload.feature) && !payload.draftText?.trim()) {
        throw new ChatMuseError('unknown_error');
      }

      const modelFeature = resolveFeatureModelFeature(payload.feature);
      const resolvedModel = validated.storage.settings.featureModels[modelFeature];

      let cachedSummary = null;
      if (payload.feature === 'fan-summary') {
        startStage('summary-cache-check', 'Check summary cache');
        if (payload.forceRegenerate) {
          profiler.log('Forced summary refresh');
          await this.storageCoordinator.removeSummaryCache(validated.urlGroupId);
        }
        cachedSummary = payload.forceRegenerate
          ? null
          : await this.storageCoordinator.getSummaryCache(validated.urlGroupId);
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
        }, createZeroAnthropicSpendSummary(), profiler);
        this.clearCompletedOperation(tabId);
        this.enqueueAgencyHubSummarySync({
          groupId: validated.urlGroupId,
          settings: validated.storage.settings,
          summary: cachedSummary.summary,
          generatedAt: cachedSummary.generatedAt,
          existingSync: cachedSummary.agencyHubSync,
          fanAccountId: cachedSummary.fanAccountId ?? null,
          session: validated.session,
          resolvedAccountId,
          debugEnabled,
        });
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
      if (featureUsesPingSegment(payload.feature)) {
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
          }, createZeroAnthropicSpendSummary(), profiler);
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
      const subscriptionLookupMode: SubscriptionLookupMode = 'full';

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
        const [monthlyResult, earningsResult, subscriptionResult] =
          await Promise.allSettled([
            this.fanslyClient.getMonthlyEarnings(
              fanAccountId,
              0,
              windowEndMs,
              validated.session,
              signal,
            ),
            this.fanslyClient.getEarnings(
              fanAccountId,
              0,
              windowEndMs,
              validated.session,
              signal,
            ),
            subscriptionRequest,
          ]);

        const monthlyRows =
          monthlyResult.status === 'fulfilled'
            ? monthlyResult.value
            : [];
        const monthlyTotals = aggregateMonthlyEarnings(monthlyRows);
        const statsAggregated =
          earningsResult.status === 'fulfilled'
            ? earningsResult.value
            : null;

        const bothEarningsFulfilled =
          earningsResult.status === 'fulfilled' &&
          monthlyResult.status === 'fulfilled';

        if (
          statsAggregated ||
          monthlyTotals.length > 0 ||
          bothEarningsFulfilled
        ) {
          const aggregated: AggregatedEarnings = statsAggregated ?? {
            correlationAccountId: fanAccountId,
            windowStartIso: new Date(0).toISOString(),
            windowEndIso: new Date(windowEndMs).toISOString(),
            totalGross: monthlyTotals.reduce(
              (sum, m) => sum + m.totalGross,
              0,
            ),
            totalNet: monthlyTotals.reduce(
              (sum, m) => sum + m.totalNet,
              0,
            ),
            breakdown: [],
            monthlyTotals: [],
          };
          aggregated.monthlyTotals = monthlyTotals;

          if (
            isDeepFeature(payload.feature) &&
            monthlyTotals.length > 0
          ) {
            const recentMonths = monthlyTotals.slice(0, 12);
            const monthlyResults = await mapWithConcurrency(
              recentMonths,
              4,
              async (month) => {
                const { start, end } = monthWindowMs(
                  month.year,
                  month.month,
                );
                try {
                  const monthAgg =
                    await this.fanslyClient.getEarnings(
                      fanAccountId,
                      start,
                      end,
                      validated.session,
                      signal,
                    );
                  return {
                    year: month.year,
                    month: month.month,
                    breakdown: monthAgg?.breakdown ?? [],
                    failed: false,
                  };
                } catch {
                  return {
                    year: month.year,
                    month: month.month,
                    breakdown: [] as import('../shared/types.js').EarningsBreakdownEntry[],
                    failed: true,
                  };
                }
              },
            );
            aggregated.monthlyBreakdowns = monthlyResults
              .filter((mb) => mb.breakdown.length > 0)
              .map(({ failed: _, ...rest }) => rest);
            if (monthlyResults.some((mb) => mb.failed)) {
              aggregated.monthlyBreakdownsPartial = true;
            }
          }

          spendingData = formatFanSpendingData(aggregated);
          spendingDataVerified = statsAggregated !== null;
          completeStage(
            'earnings',
            statsAggregated
              ? 'Fetched earnings: data found'
              : 'Fetched earnings: partial (monthly only)',
            statsAggregated ? 'data found' : 'partial',
          );
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
      const { prompt, systemBlocks, userBlocks } = buildOperationPromptRequest({
        feature: payload.feature,
        personality,
        transcript: formattedTranscript,
        fanSpendingData: spendingData,
        fanSubscriptionData: subscriptionData,
        fanDisplayName,
        draftText: payload.draftText,
        pingSegment,
        replyMode: payload.replyMode,
        replyTone: payload.replyTone,
        promptCachingEnabled: validated.storage.settings.promptCachingEnabled,
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
      startClaudeTtfbTimeout();

      let actualModel = resolvedModel;
      let latestAnthropicSpend: AnthropicSpendSummary | null = null;
      const handleAnthropicUsage = (
        usage: AnthropicUsageMetrics,
      ): AnthropicCostEstimate => {
        const cost = estimateAnthropicCost(actualModel, usage);
        const spend = buildAnthropicSpendSummary(actualModel, usage, cost);
        latestAnthropicSpend = spend;
        const current = this.getActive(tabId);
        if (current?.operationId === payload.operationId) {
          current.anthropicSpend = spend;
        }
        profiler.setAnthropicUsage(usage);
        profiler.setAnthropicCost(cost);
        profiler.log(formatAnthropicUsageLog(usage));
        profiler.log(formatAnthropicCostLog(cost));
        logDebug(debugEnabled, 'anthropic usage', usage);
        logDebug(debugEnabled, 'anthropic cost', cost);
        sendOperationProgress();
        return cost;
      };

      const streamArgs = {
        apiKey: validated.storage.settings.claudeApiKey,
        model: actualModel,
        temperature: FEATURE_TEMPERATURES[payload.feature],
        systemBlocks,
        userBlocks,
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
            startClaudeStreamTimeouts();
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
        onProgress: () => {
          if (!sawFirstChunk) {
            return;
          }
          resetClaudeIdleTimeout();
        },
        onUsage: (usage: AnthropicUsageMetrics) => {
          handleAnthropicUsage(usage);
        },
      } as const;

      let rawText: string;
      try {
        rawText = await this.anthropicClient.streamMessage(streamArgs);
      } catch (err) {
        const defaultModel = DEFAULT_FEATURE_MODELS[modelFeature];
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
                system: prompt.system,
                transcript: formattedTranscript,
                fanSpendingData: spendingData,
                fanSubscriptionData: subscriptionData,
                user: prompt.user,
              },
            });
          }
          rawText = await this.anthropicClient.streamMessage({ ...streamArgs, model: defaultModel });
        } else {
          throw err;
        }
      }
      clearClaudeTimeouts();

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

      const result = buildFeatureResult(
        payload.feature,
        rawText,
        payload.replyMode,
      );

      if (payload.feature === 'fan-summary') {
        const generatedAt = Date.now();
        result.summaryMeta = {
          generatedAt,
          stale: false,
          cached: false,
        };
        if (spendingDataVerified && subscriptionLookupVerified && actualModel === resolvedModel) {
          await this.storageCoordinator.saveSummaryCache(validated.urlGroupId, {
            summary: rawText,
            personalityId: personality.id,
            personalityUpdatedAt: personality.updatedAt,
            generatedAt,
            spendingDataVerified: true,
            subscriptionLookupVerified: true,
            modelId: resolvedModel,
            fanAccountId,
          });
        }
      }

      this.sendComplete(tabId, {
        type: 'operation:complete',
        operationId: payload.operationId,
        result,
        fanDisplayName,
      }, latestAnthropicSpend ?? createZeroAnthropicSpendSummary(), profiler);

      this.clearCompletedOperation(tabId);
      if (payload.feature === 'fan-summary' && result.summaryMeta) {
        this.enqueueAgencyHubSummarySync({
          groupId: validated.urlGroupId,
          settings: validated.storage.settings,
          summary: rawText,
          generatedAt: result.summaryMeta.generatedAt,
          fanAccountId,
          session: validated.session,
          resolvedAccountId,
          debugEnabled,
        });
      }
    } catch (error) {
      const active = this.getActive(tabId);
      const operationId = active?.operationId ?? payload.operationId;
      if (this.cancelledOperationIds.delete(operationId)) {
        return;
      }
      active?.profiler.finalizeRunningStages('operation failed');

      const abortError = resolveAbortChatMuseError(error, {
        active: Boolean(active),
        timeoutSignal: timeoutController?.signal,
        cancelSignal: controller?.signal,
      });
      if (abortError) {
        const code = active
          ? abortError
          : new ChatMuseError('chat_changed');
        const errorPayload: ErrorPayload = {
          type: 'operation:error',
          operationId,
          error: toUserError(code),
        };
        this.sendError(
          tabId,
          errorPayload,
          active?.anthropicSpend ?? createZeroAnthropicSpendSummary(),
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
          active?.anthropicSpend ?? createZeroAnthropicSpendSummary(),
          active?.profiler ?? NO_OP_PROFILER,
        );
      }

      logDebug(debugEnabled, 'operation error', error);
      await this.cancelOperation(tabId);
    } finally {
      for (const handle of timeoutHandles.values()) {
        clearTimeout(handle);
      }
      timeoutHandles.clear();
    }
  }

  private getCompareContext(): CompareOperationsContext {
    return {
      activeCompareByTabId: this.activeCompareByTabId,
      cancelledCompareOperationIds: this.cancelledCompareOperationIds,
      sessionStore: this.sessionStore,
      tabContexts: this.tabContexts,
      storageCoordinator: this.storageCoordinator,
      fanslyClient: this.fanslyClient,
      anthropicClient: this.anthropicClient,
      hasActiveFeature: (tabId) => this.activeByTabId.has(tabId),
      hasPort: (tabId) => this.portsByTabId.has(tabId),
      send: (tabId, message) => this.send(tabId, message),
    };
  }

  private cancelCompare(
    tabId: number,
    error?: ChatMuseError,
    notifyDiscard = false,
  ): void {
    cancelCompareOperation(this.getCompareContext(), tabId, error, notifyDiscard);
  }

  private async startCompare(
    tabId: number,
    payload: CompareStartPayload,
  ): Promise<void> {
    await executeCompare(this.getCompareContext(), tabId, payload);
  }
}
