import {
  AGENCY_HUB_PROFILE_MAX_BYTES,
  isAgencyHubSummarySavedForBaseUrl,
  measureUtf8Bytes,
  normalizeAgencyHubSummarySyncMetadata,
  normalizeAgencyHubBaseUrl,
} from '../shared/agency-hub.js';
import {
  AGENCY_HUB_PREFETCH_TIMEOUT_MS,
  AGENCY_HUB_SYNC_TIMEOUT_MS,
  DEEP_OPERATION_LLM_IDLE_TIMEOUT_MS,
  DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS,
  DEEP_OPERATION_LLM_TTFB_TIMEOUT_MS,
  DEEP_OPERATION_PREP_TIMEOUT_MS,
  FEATURE_TEMPERATURES,
  DEFAULT_FEATURE_MODELS,
  FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT,
  HI_GREETING_MAX_TRANSCRIPT,
  MIN_MESSAGES_FOR_DEEP,
  QUICK_OPERATION_TIMEOUT_MS,
  STREAM_CHUNK_FLUSH_MS,
} from '../shared/constants.js';
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
import {
  ChatGooseError,
  createUserError,
  toDebugErrorPayload,
  toUserError,
} from '../shared/errors.js';
import {
  featureRequiresDraft,
  featureUsesPingSegment,
  getFeaturePolicy,
  isDeepFeature,
  resolveFeatureMessageCount,
  resolveFeatureModelFeature,
} from '../shared/features.js';
import { logDebug } from '../shared/log.js';
import {
  getAgencyHubModelId,
  getModelDisplayName,
  getModelEntry,
  isAnthropicModelSelection,
} from '../shared/model-registry.js';
import { buildPromptRequest } from '../shared/prompts.js';
import {
  normalizeReplyParts,
  normalizeSingleReplyPart,
  normalizeVariantReplyParts,
} from '../shared/reply-output.js';
import {
  hasAvailableFanSummary,
  isValidSummaryCacheEntry,
} from '../shared/summary-cache.js';
import { formatFanSubscriptionData } from '../shared/subscriptions.js';
import {
  analyzePingSegment,
  buildPurchaseEvidence,
  collectUnverifiedPpvAttachmentRequests,
  formatTranscript,
  normalizeTranscript,
} from '../shared/transcript.js';
import type { PurchaseEvidenceOverride } from '../shared/transcript.js';
import { parseChatReviewXml, parseHelpMeXml } from '../shared/xml.js';
import type {
  AggregatedEarnings,
  AgencyHubAiUsageEvent,
  LlmCostEstimate,
  LlmReasoningSignal,
  LlmSpendSummary,
  LlmUsageMetrics,
  BackgroundPortMessage,
  CompareStartPayload,
  CompletePayload,
  ContentPortMessage,
  DiscardedPayload,
  ErrorPayload,
  FanSummarySyncState,
  FanSummarySyncStatus,
  FeatureType,
  FeatureResult,
  OperationPhase,
  OperationProgressPayload,
  OperationStartPayload,
  FanslyMessagePageResponse,
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
import {
  AgencyHubClient,
  type AgencyHubFetchFanProfileResult,
  type AgencyHubPushFanProfileResult,
} from './agency-hub-client.js';
import type { AgencyHubUsageReporter } from './agency-hub-usage-reporter.js';
import {
  buildLlmSpendSummary,
  createZeroLlmSpendSummary,
  estimateLlmCost,
  formatModelCostLog,
  formatModelUsageLog,
} from './llm-cost.js';
import {
  cancelCompareOperation,
  executeCompare,
  type ActiveCompareOperation,
  type CompareOperationsContext,
} from './compare-operations.js';
import type { SubscriptionLookupTraceEvent } from './fansly-client.js';
import { FanslyClient } from './fansly-client.js';
import type { LlmClient } from './llm-client.js';
import {
  createOperationProfiler,
  type OperationProfiler,
} from './operation-profiling.js';
import {
  describeMessageLoadProgress,
  describeSubscriptionTraceStep,
  errorCode,
  parseGroupIdFromUrl,
  resolveAbortChatGooseError,
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
  startedAtMs: number;
  controller: AbortController;
  rawText: string;
  flushBuffer: string;
  flushTimer: number | null;
  llmSpend: LlmSpendSummary | null;
  profiler: OperationProfiler;
}

const NO_OP_PROFILER = createOperationProfiler(false);
const CAPTURE_IDENTITY_TIMEOUT_MS = 5_000;
const DEEP_OPERATION_TIMEOUTS = {
  prep: DEEP_OPERATION_PREP_TIMEOUT_MS,
  llmTtfb: DEEP_OPERATION_LLM_TTFB_TIMEOUT_MS,
  llmIdle: DEEP_OPERATION_LLM_IDLE_TIMEOUT_MS,
  llmMaxStream: DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS,
} as const;
const AUTO_RETRY_RATE_LIMIT_MAX_MS = 60_000;
const AUTO_RETRY_SERVICE_UNAVAILABLE_MS = 5_000;
type OperationTimeoutKey =
  | 'quick-total'
  | 'deep-prep'
  | 'llm-ttfb'
  | 'llm-idle'
  | 'llm-max-stream';

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
  fanBio?: string;
  draftText?: string;
  pingSegment?: PingSegment;
  replyMode?: OperationStartPayload['replyMode'];
  replyTone?: OperationStartPayload['replyTone'];
  promptCachingEnabled: boolean;
}

function buildModelProviderByFeature(
  settings: Settings,
): TabUiState['modelProviderByFeature'] {
  return Object.fromEntries(
    Object.entries(settings.featureModels).flatMap(([feature, modelId]) => {
      const provider = getModelEntry(modelId)?.provider;
      return provider ? [[feature, provider]] : [];
    }),
  ) as TabUiState['modelProviderByFeature'];
}

function buildApiKeyReadyByFeature(
  settings: Settings,
): TabUiState['apiKeyReadyByFeature'] {
  return Object.fromEntries(
    Object.entries(settings.featureModels).map(([feature, modelId]) => {
      const provider = getModelEntry(modelId)?.provider;
      if (provider === 'anthropic') {
        return [feature, Boolean(settings.claudeApiKey)];
      }
      if (provider === 'openrouter') {
        return [feature, Boolean(settings.openRouterApiKey)];
      }
      return [feature, Boolean(settings.claudeApiKey || settings.openRouterApiKey)];
    }),
  ) as TabUiState['apiKeyReadyByFeature'];
}

function buildLlmSpendPayload(
  llmSpend?: LlmSpendSummary,
): { llmSpend: LlmSpendSummary } | object {
  return llmSpend ? { llmSpend } : {};
}

function hasApiKeyForSelectedModel(settings: Settings, feature: FeatureType): {
  ok: boolean;
  provider?: string;
} {
  const modelFeature = resolveFeatureModelFeature(feature);
  const model = getModelEntry(settings.featureModels[modelFeature]);
  if (!model) {
    return {
      ok: Boolean(settings.claudeApiKey || settings.openRouterApiKey),
    };
  }

  if (model.provider === 'anthropic') {
    return { ok: Boolean(settings.claudeApiKey), provider: model.provider };
  }
  if (model.provider === 'openrouter') {
    return { ok: Boolean(settings.openRouterApiKey), provider: model.provider };
  }

  return { ok: false, provider: model.provider };
}

interface AgencyHubSummarySyncTask {
  tabId: number;
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

interface AgencyHubSummaryPrefetchResult {
  summary: string;
  generatedAt: number;
  syncStatus: FanSummarySyncStatus;
  fanAccountId: string | null;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException('Aborted', 'AbortError'));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function createFanSummarySyncStatus(
  state: FanSummarySyncState,
  generatedAt: number,
  options?: {
    baseUrl?: string | null;
    pageLabel?: string | null;
    syncedAt?: number;
    updatedAt?: number;
    error?: FanSummarySyncStatus['error'];
  },
): FanSummarySyncStatus {
  const updatedAt = options?.updatedAt ?? Date.now();
  const normalizedBaseUrl = normalizeAgencyHubBaseUrl(options?.baseUrl);
  const trimmedPageLabel = options?.pageLabel?.trim() ?? '';
  return {
    state,
    generatedAt,
    ...(normalizedBaseUrl ? { baseUrl: normalizedBaseUrl } : {}),
    ...(trimmedPageLabel ? { pageLabel: trimmedPageLabel } : {}),
    ...(typeof options?.syncedAt === 'number' ? { syncedAt: options.syncedAt } : {}),
    ...(options?.error ? { error: options.error } : {}),
    updatedAt,
  };
}

function shouldAttemptAgencyHubSummarySync(
  agencyHubClient: AgencyHubClient,
  settings: Settings,
  summary: string,
): boolean {
  return (
    agencyHubClient.isConfigured(settings) &&
    Boolean(summary.trim()) &&
    measureUtf8Bytes(summary) <= AGENCY_HUB_PROFILE_MAX_BYTES
  );
}

function resolveSummarySyncStatusFromResult(
  result: AgencyHubPushFanProfileResult,
  generatedAt: number,
): FanSummarySyncStatus {
  const updatedAt = Date.now();
  switch (result.status) {
    case 'pushed':
    case 'already-synced':
      return createFanSummarySyncStatus('saved', generatedAt, {
        baseUrl: result.baseUrl,
        pageLabel: result.pageLabel ?? null,
        syncedAt: updatedAt,
        updatedAt,
      });
    case 'skipped':
      return createFanSummarySyncStatus(
        result.reason === 'missing_base_url' ||
          result.reason === 'missing_api_key' ||
          result.reason === 'missing_host_permission' ||
          result.reason === 'disabled'
          ? 'not-set-up'
          : 'failed',
        generatedAt,
        {
          baseUrl: result.baseUrl,
          pageLabel: result.pageLabel ?? null,
          updatedAt,
          error: result.error,
        },
      );
    case 'failed':
      return createFanSummarySyncStatus('failed', generatedAt, {
        baseUrl: result.baseUrl,
        pageLabel: result.pageLabel ?? null,
        updatedAt,
        error: result.error,
      });
  }
}

function resolveSummarySyncStatusFromHubFetch(
  result: AgencyHubFetchFanProfileResult,
  generatedAt: number,
): FanSummarySyncStatus {
  const updatedAt = Date.now();
  return createFanSummarySyncStatus('saved', generatedAt, {
    baseUrl: result.baseUrl,
    pageLabel: result.pageLabel ?? null,
    syncedAt: updatedAt,
    updatedAt,
  });
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
  fanBio,
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
      fanBio,
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
        parts: normalizeSingleReplyPart(rawText),
      };
    case 'summary':
      return { rawText };
    case 'reply': {
      const parts = feature === 'hi-greeting'
        ? normalizeVariantReplyParts(rawText)
        : normalizeReplyParts(rawText);
      return {
        rawText,
        ...(getFeaturePolicy(feature).supportsReplyMode
          ? {
              splitModeRequested: replyMode === 'preferSplit',
            }
          : {}),
        parts,
      };
    }
  }
}

function assertInsertableFeatureResult(
  feature: FeatureType,
  result: FeatureResult,
): void {
  const resultKind = getFeaturePolicy(feature).resultKind;
  if (
    (resultKind === 'reply' || resultKind === 'single-reply') &&
    (!result.parts || result.parts.length === 0)
  ) {
    throw new ChatGooseError('ai_output_unusable');
  }
}

export class OperationCoordinator {
  private readonly portsByTabId = new Map<number, browser.runtime.Port>();
  private readonly activeByTabId = new Map<number, ActiveOperation>();
  private readonly activeCompareByTabId = new Map<number, ActiveCompareOperation>();
  private readonly cancelledOperationIds = new Set<string>();
  private readonly cancelledCompareOperationIds = new Set<string>();
  private readonly pendingSummaryAvailabilityByKey = new Map<string, Promise<void>>();
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
    private readonly llmClient: LlmClient,
    private readonly storageCoordinator: StorageCoordinator,
    private readonly agencyHubClient: AgencyHubClient,
    private readonly agencyHubUsageReporter: Pick<AgencyHubUsageReporter, 'enqueue'>,
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
    const state = await this.buildTabUiState(tabId);
    port.postMessage({
      type: messageType,
      state,
    } satisfies TabStatePayload);
    if (!state.hasAvailableSummary) {
      void this.prefetchAvailableSummary(tabId);
    }
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
        new ChatGooseError('chat_changed'),
        true,
      );
    }
    if (changed && this.activeCompareByTabId.has(tabId)) {
      this.cancelCompare(tabId, new ChatGooseError('chat_changed'), true);
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
      hasAvailableSummary: hasAvailableFanSummary(
        storage,
        context.groupId,
        mappedPersonalityId,
      ),
      connected: Boolean(session?.connected),
      hasApiKey: Boolean(storage.settings.claudeApiKey || storage.settings.openRouterApiKey),
      modelProviderByFeature: buildModelProviderByFeature(storage.settings),
      apiKeyReadyByFeature: buildApiKeyReadyByFeature(storage.settings),
      hasPersonalities: storage.personalities.length > 0,
      mappedPersonalityId,
      mappedPersonalityName,
      compareCardCount: compareDraftCount + (mappedPersonalityId ? 1 : 0),
      compareDraftCount,
    };
  }

  private async cachePrefetchedSummary(
    groupId: string,
    personality: PersistedState['personalities'][number],
    modelId: string,
    prefetchedSummary: AgencyHubSummaryPrefetchResult,
  ): Promise<void> {
    await this.storageCoordinator.saveSummaryCache(groupId, {
      summary: prefetchedSummary.summary,
      personalityId: personality.id,
      personalityUpdatedAt: personality.updatedAt,
      generatedAt: prefetchedSummary.generatedAt,
      spendingDataVerified: true,
      subscriptionLookupVerified: true,
      modelId,
      fanAccountId: prefetchedSummary.fanAccountId,
      agencyHubSync: prefetchedSummary.syncStatus,
    });
  }

  private async prefetchAvailableSummary(tabId: number): Promise<void> {
    const storage = await this.storageCoordinator.getState();
    const context = this.tabContexts.getOrCreate(tabId);
    const groupId = context.groupId?.trim() ?? '';
    if (!groupId) {
      return;
    }

    const session = this.sessionStore.getSessionForTab(tabId);
    if (!session?.connected) {
      return;
    }

    const legacyAccountId =
      this.sessionStore.getAccountIdForTab(tabId) ?? context.accountId;
    const accountId = session.resolvedAccountId ?? legacyAccountId;
    const mappedPersonalityId = resolveMappedPersonalityId(
      storage.accountMappings,
      accountId,
      legacyAccountId,
      storage.accountAliases,
    );

    if (hasAvailableFanSummary(storage, groupId, mappedPersonalityId)) {
      return;
    }

    const personality = storage.personalities.find(
      (entry) => entry.id === mappedPersonalityId,
    );
    if (!personality) {
      return;
    }

    const modelId = storage.settings.featureModels['fan-summary'];
    const key = [
      tabId,
      groupId,
      personality.id,
      personality.updatedAt,
      modelId,
    ].join('|');

    const pending = this.pendingSummaryAvailabilityByKey.get(key);
    if (pending) {
      await pending;
      return;
    }

    const task = (async () => {
      const prefetchedSummary = await this.prefetchAgencyHubSummary(
        groupId,
        storage.settings,
        session,
        new AbortController().signal,
        storage.settings.debugMode,
      );
      if (!prefetchedSummary) {
        return;
      }

      const active = this.activeByTabId.get(tabId);
      if (active?.feature === 'fan-summary' && active.groupId === groupId) {
        return;
      }

      await this.cachePrefetchedSummary(
        groupId,
        personality,
        modelId,
        prefetchedSummary,
      );

      if (this.tabContexts.getOrCreate(tabId).groupId === groupId) {
        await this.refreshTabState(tabId, 'tab:state');
      }
    })().finally(() => {
      if (this.pendingSummaryAvailabilityByKey.get(key) === task) {
        this.pendingSummaryAvailabilityByKey.delete(key);
      }
    });

    this.pendingSummaryAvailabilityByKey.set(key, task);
    await task;
  }

  private send(tabId: number, message: BackgroundPortMessage): void {
    this.portsByTabId.get(tabId)?.postMessage(message);
  }

  private sendSummarySyncStatus(
    tabId: number,
    groupId: string,
    syncStatus: FanSummarySyncStatus,
  ): void {
    this.send(tabId, {
      type: 'summary:syncStatus',
      groupId,
      generatedAt: syncStatus.generatedAt,
      syncStatus,
    });
  }

  private sendProgress(
    tabId: number,
    progress: OperationProgressPayload,
    llmSpend?: LlmSpendSummary,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      type: 'operation:progress',
      ...progress,
      ...buildLlmSpendPayload(llmSpend),
      ...(profiling ? { profiling } : {}),
    });
  }

  private sendComplete(
    tabId: number,
    payload: CompletePayload,
    llmSpend?: LlmSpendSummary,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      ...payload,
      ...buildLlmSpendPayload(llmSpend),
      ...(profiling ? { profiling } : {}),
    });
  }

  private sendError(
    tabId: number,
    payload: ErrorPayload,
    llmSpend?: LlmSpendSummary,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      ...payload,
      ...buildLlmSpendPayload(llmSpend),
      ...(profiling ? { profiling } : {}),
    });
  }

  private sendDiscarded(
    tabId: number,
    payload: DiscardedPayload,
    llmSpend?: LlmSpendSummary,
    profiler: OperationProfiler = NO_OP_PROFILER,
  ): void {
    const profiling = profiler.snapshot();
    this.send(tabId, {
      ...payload,
      ...buildLlmSpendPayload(llmSpend),
      ...(profiling ? { profiling } : {}),
    });
  }

  private buildAiUsageEvent({
    clientEventId,
    feature,
    model,
    spend,
    conversationId,
    startedAtMs,
    completedAtMs,
    isCacheHit,
    isRegeneration,
  }: {
    clientEventId: string;
    feature: FeatureType;
    model: string;
    spend: LlmSpendSummary;
    conversationId: string | null;
    startedAtMs: number | null | undefined;
    completedAtMs: number;
    isCacheHit: boolean;
    isRegeneration: boolean;
  }): AgencyHubAiUsageEvent {
    return {
      clientEventId,
      feature,
      model: getAgencyHubModelId(model),
      inputTokens: spend.inputTokens,
      outputTokens: spend.outputTokens,
      cacheWriteTokens: spend.cacheWriteTokens,
      cacheReadTokens: spend.cacheReadTokens,
      conversationId,
      durationMs: typeof startedAtMs === 'number'
        ? Math.max(0, completedAtMs - startedAtMs)
        : null,
      isCacheHit,
      isRegeneration,
      completedAt: new Date(completedAtMs).toISOString(),
    };
  }

  private enqueueCompletedOperationUsage(
    settings: Pick<Settings, 'agencyHubBaseUrl' | 'agencyHubApiKey' | 'debugMode'>,
    event: AgencyHubAiUsageEvent,
  ): void {
    this.agencyHubUsageReporter.enqueue(settings, event);
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
      throw new ChatGooseError('chat_changed');
    }

    const session = this.sessionStore.getSessionForTab(tabId);
    const legacyAccountId = this.sessionStore.getAccountIdForTab(tabId);

    const apiKeyCheck = hasApiKeyForSelectedModel(
      storage.settings,
      payload.feature,
    );
    if (!apiKeyCheck.ok) {
      throw new ChatGooseError('missing_api_key', {
        details: apiKeyCheck.provider ? { provider: apiKeyCheck.provider } : undefined,
      });
    }
    if (storage.personalities.length === 0) {
      throw new ChatGooseError('no_personalities');
    }
    if (!legacyAccountId || !session) {
      throw new ChatGooseError('not_connected');
    }
    if (!session.connected) {
      throw new ChatGooseError('session_expired');
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
    error?: ChatGooseError,
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
        error: toUserError(error ?? new ChatGooseError('chat_changed')),
      }, active.llmSpend ?? createZeroLlmSpendSummary(), active.profiler);
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

  private async persistSummarySyncStatus(
    groupId: string,
    generatedAt: number,
    syncStatus: FanSummarySyncStatus,
    fanAccountId?: string | null,
  ): Promise<void> {
    await this.storageCoordinator.updateSummaryCache(groupId, (entry) => {
      if (entry.generatedAt !== generatedAt) {
        return entry;
      }

      return {
        ...entry,
        ...(fanAccountId?.trim() ? { fanAccountId: fanAccountId.trim() } : {}),
        agencyHubSync: syncStatus,
      };
    });
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

  private async prefetchAgencyHubSummary(
    groupId: string,
    settings: Settings,
    session: SessionTemplate,
    signal: AbortSignal,
    debugEnabled: boolean,
  ): Promise<AgencyHubSummaryPrefetchResult | null> {
    if (!this.agencyHubClient.isConfigured(settings)) {
      return null;
    }

    const timeoutController = new AbortController();
    const timeoutHandle = globalThis.setTimeout(
      () => timeoutController.abort(),
      AGENCY_HUB_PREFETCH_TIMEOUT_MS,
    );
    const prefetchSignal = AbortSignal.any([signal, timeoutController.signal]);

    try {
      const pageUsername = await this.resolveCreatorUsername(session, prefetchSignal);
      const result = await this.agencyHubClient.fetchFanProfileByConversation({
        settings,
        pageUsername,
        conversationId: groupId,
        signal: prefetchSignal,
      });

      if (signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }

      logDebug(debugEnabled, 'agency hub summary prefetch', {
        status: result.status,
        reason: result.reason,
        baseUrl: result.baseUrl,
        pageLabel: result.pageLabel,
        fanAccountId: result.fanAccountId,
        error: result.error,
      });

      if (result.status !== 'fetched' || !result.body) {
        return null;
      }

      const generatedAt = result.createdAtMs ?? Date.now();
      return {
        summary: result.body,
        generatedAt,
        syncStatus: resolveSummarySyncStatusFromHubFetch(result, generatedAt),
        fanAccountId: result.fanAccountId?.trim() || null,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError' && signal.aborted) {
        throw error;
      }

      logDebug(debugEnabled, 'agency hub summary prefetch failed', toDebugErrorPayload(error));
      return null;
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private async syncAgencyHubSummary(task: AgencyHubSummarySyncTask): Promise<void> {
    const timeoutController = new AbortController();
    const timeoutHandle = globalThis.setTimeout(
      () => timeoutController.abort(),
      AGENCY_HUB_SYNC_TIMEOUT_MS,
    );
    let syncStatus: FanSummarySyncStatus | null = null;
    let resolvedFanAccountId = task.fanAccountId;

    try {
      const pageUsername = await this.resolveCreatorUsername(task.session, timeoutController.signal);
      resolvedFanAccountId = await this.resolveFanAccountIdForSync(
        task.groupId,
        task.session,
        task.resolvedAccountId,
        task.fanAccountId,
        timeoutController.signal,
      );

      const result = await this.agencyHubClient.pushFanProfile({
        settings: task.settings,
        pageUsername,
        platformUserId: resolvedFanAccountId,
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
        error: result.error,
      });
      syncStatus = resolveSummarySyncStatusFromResult(result, task.generatedAt);
    } catch (error) {
      logDebug(task.debugEnabled, 'agency hub summary sync failed', toDebugErrorPayload(error));
      syncStatus = createFanSummarySyncStatus('failed', task.generatedAt, {
        baseUrl: task.settings.agencyHubBaseUrl,
        error: createUserError('hub_timeout'),
      });
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!syncStatus) {
      return;
    }

    await this.persistSummarySyncStatus(
      task.groupId,
      task.generatedAt,
      syncStatus,
      resolvedFanAccountId,
    );
    this.sendSummarySyncStatus(task.tabId, task.groupId, syncStatus);
  }

  private async verifyMediaPurchaseEvidence(
    pages: FanslyMessagePageResponse[],
    fanAccountId: string | null,
    session: SessionTemplate,
    signal: AbortSignal,
    debugEnabled: boolean,
  ): Promise<PurchaseEvidenceOverride> {
    if (!fanAccountId) {
      return {};
    }

    const inlineEvidence = buildPurchaseEvidence(pages, fanAccountId);
    const unresolved = collectUnverifiedPpvAttachmentRequests(pages, inlineEvidence);
    if (unresolved.length === 0) {
      return {};
    }

    const capped = unresolved.slice(0, FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT);
    const capOverflow = unresolved.length > capped.length;

    try {
      const verified = await this.fanslyClient.verifyMediaPurchaseStates(
        capped,
        fanAccountId,
        session,
        signal,
      );
      return {
        ...verified,
        verificationIncomplete: Boolean(
          verified.verificationIncomplete || capOverflow,
        ),
      };
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      logDebug(debugEnabled, 'media purchase verification failed (fail-open)', {
        fanAccountId,
        requested: capped.length,
        capOverflow,
        error: toDebugErrorPayload(error),
      });
      return { verificationIncomplete: true };
    }
  }

  private assertActive(
    tabId: number,
    operationId: string,
  ): ActiveOperation {
    const active = this.activeByTabId.get(tabId);
    if (!active || active.operationId !== operationId) {
      throw new ChatGooseError('chat_changed');
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
        error: toUserError(new ChatGooseError('another_operation')),
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
      const startLlmTtfbTimeout = (): void => {
        if (!usesDeepOperationTimeouts(payload.feature)) {
          return;
        }
        clearTimeoutHandle('deep-prep');
        armTimeoutHandle('llm-ttfb', DEEP_OPERATION_TIMEOUTS.llmTtfb);
      };
      const startLlmStreamTimeouts = (): void => {
        if (!usesDeepOperationTimeouts(payload.feature)) {
          return;
        }
        clearTimeoutHandle('llm-ttfb');
        armTimeoutHandle('llm-idle', DEEP_OPERATION_TIMEOUTS.llmIdle);
        armTimeoutHandle(
          'llm-max-stream',
          DEEP_OPERATION_TIMEOUTS.llmMaxStream,
        );
      };
      const resetLlmIdleTimeout = (): void => {
        if (!usesDeepOperationTimeouts(payload.feature)) {
          return;
        }
        armTimeoutHandle('llm-idle', DEEP_OPERATION_TIMEOUTS.llmIdle);
      };
      const clearLlmTimeouts = (): void => {
        clearTimeoutHandle('llm-ttfb');
        clearTimeoutHandle('llm-idle');
        clearTimeoutHandle('llm-max-stream');
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
        startedAtMs: Date.now(),
        controller: operationController,
        rawText: '',
        flushBuffer: '',
        flushTimer: null,
        llmSpend: null,
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
      let progressStatusCode: string | undefined;
      let progressRetryAtMs: number | undefined;

      type OperationProgressUpdate = {
        phase?: OperationPhase;
        message?: string | undefined;
        currentPage?: number | undefined;
        targetPages?: number | undefined;
        statusCode?: string | undefined;
        retryAtMs?: number | undefined;
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
          if ('statusCode' in updates) {
            progressStatusCode = updates.statusCode;
          }
          if ('retryAtMs' in updates) {
            progressRetryAtMs = updates.retryAtMs;
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
            statusCode: progressStatusCode,
            retryAtMs: progressRetryAtMs,
          },
          active.llmSpend ?? undefined,
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
        throw new ChatGooseError('no_mapping');
      }

      const personality = storage.personalities.find(
        (entry) => entry.id === personalityId,
      );
      if (!personality) {
        throw new ChatGooseError('no_mapping');
      }

      if (featureRequiresDraft(payload.feature) && !payload.draftText?.trim()) {
        throw new ChatGooseError('unknown_error');
      }

      const modelFeature = resolveFeatureModelFeature(payload.feature);
      const resolvedModel = validated.storage.settings.featureModels[modelFeature];

      let cachedSummary = null;
      let hasValidCachedSummary = false;
      if (payload.feature === 'fan-summary') {
        startStage('summary-cache-check', 'Check summary cache');
        if (payload.forceRegenerate) {
          profiler.log('Forced summary refresh');
          await this.storageCoordinator.removeSummaryCache(validated.urlGroupId);
        }
        cachedSummary = payload.forceRegenerate
          ? null
          : await this.storageCoordinator.getSummaryCache(validated.urlGroupId);
        hasValidCachedSummary = isValidSummaryCacheEntry(
          cachedSummary,
          personality.id,
          personality.updatedAt,
          resolvedModel,
        );
      }

      if (payload.feature === 'fan-summary' && cachedSummary && hasValidCachedSummary) {
        const normalizedCachedSync = normalizeAgencyHubSummarySyncMetadata(
          cachedSummary.agencyHubSync,
        );
        const currentAgencyHubBaseUrl = normalizeAgencyHubBaseUrl(
          validated.storage.settings.agencyHubBaseUrl,
        );
        const shouldAttemptSync = shouldAttemptAgencyHubSummarySync(
          this.agencyHubClient,
          validated.storage.settings,
          cachedSummary.summary,
        );
        const savedForCurrentTarget = isAgencyHubSummarySavedForBaseUrl(
          normalizedCachedSync,
          currentAgencyHubBaseUrl,
          cachedSummary.generatedAt,
        );
        let syncStatus: FanSummarySyncStatus;

        if (savedForCurrentTarget && normalizedCachedSync) {
          syncStatus = normalizedCachedSync;
        } else if (shouldAttemptSync) {
          syncStatus = createFanSummarySyncStatus(
            'saving',
            cachedSummary.generatedAt,
            { baseUrl: currentAgencyHubBaseUrl },
          );
          await this.persistSummarySyncStatus(
            validated.urlGroupId,
            cachedSummary.generatedAt,
            syncStatus,
            cachedSummary.fanAccountId ?? null,
          );
          cachedSummary.agencyHubSync = syncStatus;
        } else {
          syncStatus = normalizedCachedSync ?? createFanSummarySyncStatus(
            'not-set-up',
            cachedSummary.generatedAt,
            { baseUrl: currentAgencyHubBaseUrl },
          );
        }

        const result: FeatureResult = {
          rawText: cachedSummary.summary,
          summaryMeta: {
            generatedAt: cachedSummary.generatedAt,
            stale: false,
            cached: true,
            syncStatus,
          },
        };
        const current = this.assertActive(tabId, payload.operationId);
        completeStage(
          'summary-cache-check',
          'Summary cache hit',
          'cache hit',
        );
        const completedAtMs = Date.now();
        const zeroSpend = createZeroLlmSpendSummary();
        this.sendComplete(tabId, {
          type: 'operation:complete',
          operationId: payload.operationId,
          result,
          fanDisplayName: payload.domFanDisplayName ?? 'fan',
        }, zeroSpend, profiler);
        this.enqueueCompletedOperationUsage(
          validated.storage.settings,
          this.buildAiUsageEvent({
            clientEventId: payload.operationId,
            feature: payload.feature,
            model: resolvedModel,
            spend: zeroSpend,
            conversationId: validated.urlGroupId,
            startedAtMs: current.startedAtMs,
            completedAtMs,
            isCacheHit: true,
            isRegeneration: Boolean(payload.forceRegenerate),
          }),
        );
        this.clearCompletedOperation(tabId);
        if (shouldAttemptSync && !savedForCurrentTarget) {
          this.enqueueAgencyHubSummarySync({
            tabId,
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
        }
        return;
      }

      if (payload.feature === 'fan-summary') {
        if (!payload.forceRegenerate) {
          const prefetchedSummary = await this.prefetchAgencyHubSummary(
            validated.urlGroupId,
            validated.storage.settings,
            validated.session,
            signal,
            debugEnabled,
          );

          if (prefetchedSummary) {
            await this.cachePrefetchedSummary(
              validated.urlGroupId,
              personality,
              resolvedModel,
              prefetchedSummary,
            );

            const result: FeatureResult = {
              rawText: prefetchedSummary.summary,
              summaryMeta: {
                generatedAt: prefetchedSummary.generatedAt,
                stale: false,
                cached: true,
                syncStatus: prefetchedSummary.syncStatus,
              },
            };

            const current = this.assertActive(tabId, payload.operationId);
            completeStage(
              'summary-cache-check',
              'Summary loaded from Agency Hub',
              'hub hit',
            );
            const completedAtMs = Date.now();
            const zeroSpend = createZeroLlmSpendSummary();
            this.sendComplete(tabId, {
              type: 'operation:complete',
              operationId: payload.operationId,
              result,
              fanDisplayName: payload.domFanDisplayName ?? 'fan',
            }, zeroSpend, profiler);
            this.enqueueCompletedOperationUsage(
              validated.storage.settings,
              this.buildAiUsageEvent({
                clientEventId: payload.operationId,
                feature: payload.feature,
                model: resolvedModel,
                spend: zeroSpend,
                conversationId: validated.urlGroupId,
                startedAtMs: current.startedAtMs,
                completedAtMs,
                isCacheHit: true,
                isRegeneration: Boolean(payload.forceRegenerate),
              }),
            );
            this.clearCompletedOperation(tabId);
            return;
          }
        }

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
        `Loaded messages: ${messageLoad.pagesLoaded} pages`,
        `${messageLoad.pagesLoaded} pages`,
      );

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
      let fanBio: string | undefined;
      fanAccountId =
        groupUsers?.find(
          (user) => user.userId !== resolvedAccountId,
        )?.userId ?? null;

      const purchaseEvidence = await this.verifyMediaPurchaseEvidence(
        messageLoad.pages,
        fanAccountId,
        validated.session,
        signal,
        debugEnabled,
      );

      // Normalize after group-lookup so transcript labels can use the
      // resolved fan id for fan-perspective purchase state. When the lookup
      // fails or is skipped, fanAccountId is null and PPV labels degrade to
      // "unknown" rather than misclassifying.
      const transcriptMessages = normalizeTranscript(
        messageLoad.pages,
        resolvedAccountId,
        fanAccountId,
        purchaseEvidence,
      );

      if (
        isDeepFeature(payload.feature) &&
        transcriptMessages.length < MIN_MESSAGES_FOR_DEEP
      ) {
        throw new ChatGooseError('not_enough_history');
      }

      if (
        payload.feature === 'hi-greeting' &&
        transcriptMessages.length > HI_GREETING_MAX_TRANSCRIPT
      ) {
        throw new ChatGooseError('hi_too_many_messages');
      }

      let pingSegment: PingSegment | undefined;
      if (featureUsesPingSegment(payload.feature)) {
        startStage('ping-analysis', 'Analyze ping segment');
        const pingAnalysis = analyzePingSegment(
          transcriptMessages,
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
            error: toUserError(new ChatGooseError('ping_blocked')),
          }, createZeroLlmSpendSummary(), profiler);
          this.clearCompletedOperation(tabId);
          return;
        }
      }

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
          if (payload.feature === 'hi-greeting' && account?.about?.trim()) {
            fanBio = account.about.trim();
          }
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
      const shouldLoadEarnings = getFeaturePolicy(payload.feature).includesEarnings !== false;

      if (shouldLoadEarnings && fanAccountId) {
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
        const skipReason = !shouldLoadEarnings
          ? 'not included for this feature'
          : 'fan account unavailable';
        skipStage('earnings', 'Fetch earnings', skipReason);
        skipStage(
          'subscription-lookup',
          'Lookup subscription',
          skipReason,
        );
      }

      startStage('prompt-build', 'Build prompt');
      const formattedTranscript = formatTranscript(transcriptMessages);
      const { prompt, systemBlocks, userBlocks } = buildOperationPromptRequest({
        feature: payload.feature,
        personality,
        transcript: formattedTranscript,
        fanSpendingData: spendingData,
        fanSubscriptionData: subscriptionData,
        fanDisplayName,
        fanBio,
        draftText: payload.draftText,
        pingSegment,
        replyMode: payload.replyMode,
        replyTone: payload.replyTone,
        promptCachingEnabled: validated.storage.settings.promptCachingEnabled,
      });
      completeStage(
        'prompt-build',
        `Built prompt: ${transcriptMessages.length} transcript messages`,
        `${transcriptMessages.length} transcript messages`,
      );

      const sendDebugPromptSnapshot = (modelId: string): void => {
        if (!profiler.enabled) {
          return;
        }

        this.send(tabId, {
          type: 'operation:debugPrompt',
          operationId: payload.operationId,
          feature: payload.feature,
          snapshot: {
            feature: payload.feature,
            modelId,
            system: prompt.system,
            transcript: formattedTranscript,
            fanSpendingData: spendingData,
            fanSubscriptionData: subscriptionData,
            user: prompt.user,
          },
        });
      };

      sendDebugPromptSnapshot(resolvedModel);

      let sawProviderActivity = false;
      let sawProviderActivityInAttempt = false;
      let sawFirstChunk = false;
      let actualModel = resolvedModel;
      let reasoningObserved = false;
      let reasoningDebugText = '';
      let latestLlmStopReason: string | null = null;
      const actualModelName = (): string => getModelDisplayName(actualModel);
      startStage('llm-ttfb', 'Wait for AI TTFB');
      profiler.log(`Waiting for ${actualModelName()}`);
      sendDebugProgress();
      startLlmTtfbTimeout();

      let latestLlmSpend: LlmSpendSummary | null = null;
      const handleLlmUsage = (
        usage: LlmUsageMetrics,
      ): LlmCostEstimate => {
        const cost = estimateLlmCost(actualModel, usage);
        const spend = buildLlmSpendSummary(actualModel, usage, cost);
        latestLlmSpend = spend;
        const current = this.getActive(tabId);
        if (current?.operationId === payload.operationId) {
          current.llmSpend = spend;
        }
        profiler.setLlmUsage(usage);
        profiler.setLlmCost(cost);
        profiler.log(formatModelUsageLog(actualModel, usage));
        profiler.log(formatModelCostLog(cost));
        logDebug(debugEnabled, 'model usage', {
          model: actualModel,
          ...usage,
        });
        logDebug(debugEnabled, 'model cost', cost);
        sendOperationProgress();
        return cost;
      };

      const markProviderActivity = (ttfbDetail: string): boolean => {
        if (!sawProviderActivityInAttempt) {
          sawProviderActivityInAttempt = true;
          startLlmStreamTimeouts();
          if (sawProviderActivity) {
            sendDebugProgress();
            return false;
          }
          sawProviderActivity = true;
          profiler.completeStage('llm-ttfb', ttfbDetail);
          profiler.startStage('llm-stream', 'Stream AI response');
          profiler.log(`Stream ${actualModelName()} response`);
          sendDebugProgress();
          return true;
        }
        resetLlmIdleTimeout();
        return false;
      };

      const streamArgs = {
        settings: validated.storage.settings,
        model: actualModel,
        temperature: FEATURE_TEMPERATURES[payload.feature],
        systemBlocks,
        userBlocks,
        feature: payload.feature,
        reasoningEffort: validated.storage.settings.featureReasoning[modelFeature],
        signal,
        onText: (chunk: string) => {
          const current = this.getActive(tabId);
          if (
            !current ||
            current.operationId !== payload.operationId
          ) {
            return;
          }
          const firstTextChunk = !sawFirstChunk;
          const firstProviderActivity = markProviderActivity('first text chunk received');
          if (firstTextChunk) {
            sawFirstChunk = true;
            profiler.log(`${actualModelName()} first text chunk`);
            if (!firstProviderActivity) {
              sendDebugProgress();
            }
          }
          current.rawText += chunk;
          current.flushBuffer += chunk;
          this.scheduleChunkFlush(tabId, current);
        },
        onProgress: () => {
          if (markProviderActivity('first provider event received')) {
            profiler.log(`${actualModelName()} first provider event`);
          }
        },
        onUsage: (usage: LlmUsageMetrics) => {
          markProviderActivity('first provider event received');
          handleLlmUsage(usage);
        },
        onReasoningObserved: (reasoningSignal: LlmReasoningSignal) => {
          markProviderActivity('first provider event received');
          if (reasoningObserved) {
            return;
          }
          reasoningObserved = true;
          profiler.log(`Reasoning observed: yes (${reasoningSignal})`);
          logDebug(debugEnabled, 'reasoning observed', {
            model: actualModel,
            feature: payload.feature,
            reasoningEffort: validated.storage.settings.featureReasoning[modelFeature],
            signal: reasoningSignal,
          });
          sendDebugProgress();
        },
        onReasoningDelta: (text: string) => {
          markProviderActivity('first provider event received');
          if (profiler.enabled) {
            reasoningDebugText += text;
            profiler.setReasoningBlock(reasoningDebugText);
          }
        },
        onStopReason: (stopReason: string | null) => {
          latestLlmStopReason = stopReason;
        },
      } as const;

      const defaultModel = DEFAULT_FEATURE_MODELS[modelFeature];
      let rateLimitRetried = false;
      let serviceUnavailableRetried = false;
      let rawText: string;
      while (true) {
        try {
          reasoningObserved = false;
          reasoningDebugText = '';
          profiler.setReasoningBlock('');
          profiler.log(
            `Reasoning requested: ${streamArgs.reasoningEffort} (${actualModelName()})`,
          );
          rawText = await this.llmClient.streamMessage({
            ...streamArgs,
            model: actualModel,
          });
          if (streamArgs.reasoningEffort !== 'off' && !reasoningObserved) {
            profiler.log('Reasoning observed: no');
            logDebug(debugEnabled, 'reasoning observed', {
              model: actualModel,
              feature: payload.feature,
              reasoningEffort: streamArgs.reasoningEffort,
              observed: false,
            });
          }
          break;
        } catch (err) {
          const errorKey = err instanceof ChatGooseError
            ? err.key
            : (err as { key?: string })?.key;
          const retryAfterMs = typeof (err as { retryAfterMs?: unknown })?.retryAfterMs === 'number'
            ? (err as { retryAfterMs: number }).retryAfterMs
            : undefined;
          const retryAtMs = typeof (err as { retryAtMs?: unknown })?.retryAtMs === 'number'
            ? (err as { retryAtMs: number }).retryAtMs
            : undefined;
          const canRetryRateLimit =
            !sawFirstChunk &&
            !rateLimitRetried &&
            errorKey === 'rate_limited' &&
            typeof retryAfterMs === 'number' &&
            retryAfterMs <= AUTO_RETRY_RATE_LIMIT_MAX_MS;
          const canRetryServiceUnavailable =
            !sawFirstChunk &&
            !serviceUnavailableRetried &&
            errorKey === 'service_unavailable';

          if (canRetryRateLimit || canRetryServiceUnavailable) {
            const fallbackRetryKey = canRetryServiceUnavailable
              ? 'service_unavailable'
              : 'rate_limited';
            const errorCode = err instanceof ChatGooseError
              ? err.code
              : (typeof (err as { code?: unknown })?.code === 'string'
                  ? (err as { code: string }).code
                  : createUserError(fallbackRetryKey).code);
            if (canRetryRateLimit) {
              rateLimitRetried = true;
            } else {
              serviceUnavailableRetried = true;
            }
            clearLlmTimeouts();
            const retryDelayMs = canRetryRateLimit
              ? (retryAfterMs ?? 0)
              : AUTO_RETRY_SERVICE_UNAVAILABLE_MS;
            const nextRetryAtMs = canRetryRateLimit
              ? (retryAtMs ?? (Date.now() + retryDelayMs))
              : (Date.now() + retryDelayMs);
            const providerLabel = getModelEntry(actualModel)?.providerLabel ?? 'Provider';
            const retryMessage = canRetryRateLimit
              ? 'Rate limited. Waiting to retry…'
              : `${providerLabel} unavailable. Retrying…`;
            profiler.log(
              canRetryRateLimit
                ? `${providerLabel} rate limited, retrying in ${Math.ceil(retryDelayMs / 1000)}s (${errorCode})`
                : `${providerLabel} service unavailable, retrying in ${Math.ceil(retryDelayMs / 1000)}s (${errorCode})`,
            );
            sendOperationProgress({
              phase: 'generating',
              message: retryMessage,
              currentPage: undefined,
              targetPages: undefined,
              statusCode: errorCode,
              retryAtMs: nextRetryAtMs,
            });
            await delay(retryDelayMs, signal);
            sendOperationProgress({
              phase: 'generating',
              message: 'Generating…',
              currentPage: undefined,
              targetPages: undefined,
              statusCode: undefined,
              retryAtMs: undefined,
            });
            if (!sawFirstChunk) {
              sawProviderActivityInAttempt = false;
              startLlmTtfbTimeout();
            }
            continue;
          }

          if (
            errorKey === 'model_unavailable' &&
            isAnthropicModelSelection(actualModel) &&
            actualModel !== defaultModel
          ) {
            actualModel = defaultModel;
            profiler.log(`Model ${resolvedModel} unavailable, retrying with ${defaultModel}`);
            sendDebugPromptSnapshot(defaultModel);
            if (!sawFirstChunk) {
              clearLlmTimeouts();
              sawProviderActivityInAttempt = false;
              startLlmTtfbTimeout();
            }
            continue;
          }

          throw err;
        }
      }
      clearLlmTimeouts();

      if (sawProviderActivity) {
        completeStage(
          'llm-stream',
          `${actualModelName()} stream complete: ${rawText.length} chars`,
          `${rawText.length} chars`,
        );
      } else {
        completeStage(
          'llm-ttfb',
          `${actualModelName()} completed without streamed text`,
          'completed without streamed text',
        );
        skipStage(
          'llm-stream',
          'Stream AI response',
          'no streamed chunks',
        );
      }

      const current = this.assertActive(tabId, payload.operationId);
      if (current.flushTimer !== null) {
        clearTimeout(current.flushTimer);
        this.flushChunks(tabId, current);
      }

      if (
        latestLlmStopReason === 'max_tokens' &&
        getFeaturePolicy(payload.feature).promptMode === 'reply'
      ) {
        throw new ChatGooseError('ai_output_unusable');
      }

      const result = buildFeatureResult(
        payload.feature,
        rawText,
        payload.replyMode,
      );
      assertInsertableFeatureResult(payload.feature, result);

      if (payload.feature === 'fan-summary') {
        const generatedAt = Date.now();
        const shouldAttemptSync = shouldAttemptAgencyHubSummarySync(
          this.agencyHubClient,
          validated.storage.settings,
          rawText,
        );
        const initialSyncStatus = createFanSummarySyncStatus(
          shouldAttemptSync ? 'saving' : 'not-set-up',
          generatedAt,
          { baseUrl: validated.storage.settings.agencyHubBaseUrl },
        );
        result.summaryMeta = {
          generatedAt,
          stale: false,
          cached: false,
          syncStatus: initialSyncStatus,
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
            agencyHubSync: initialSyncStatus,
          });
        }
      }

      const completedAtMs = Date.now();
      const completedSpend = latestLlmSpend ?? createZeroLlmSpendSummary();
      this.sendComplete(tabId, {
        type: 'operation:complete',
        operationId: payload.operationId,
        result,
        fanDisplayName,
      }, completedSpend, profiler);
      this.enqueueCompletedOperationUsage(
        validated.storage.settings,
        this.buildAiUsageEvent({
          clientEventId: payload.operationId,
          feature: payload.feature,
          model: actualModel,
          spend: completedSpend,
          conversationId: validated.urlGroupId,
          startedAtMs: current.startedAtMs,
          completedAtMs,
          isCacheHit: Boolean(result.summaryMeta?.cached),
          isRegeneration: Boolean(payload.forceRegenerate),
        }),
      );

      this.clearCompletedOperation(tabId);
      if (payload.feature === 'fan-summary' && result.summaryMeta) {
        if (result.summaryMeta.syncStatus?.state === 'saving') {
          this.enqueueAgencyHubSummarySync({
            tabId,
            groupId: validated.urlGroupId,
            settings: validated.storage.settings,
            summary: rawText,
            generatedAt: result.summaryMeta.generatedAt,
            existingSync: result.summaryMeta.syncStatus,
            fanAccountId,
            session: validated.session,
            resolvedAccountId,
            debugEnabled,
          });
        }
      }
    } catch (error) {
      const active = this.getActive(tabId);
      const operationId = active?.operationId ?? payload.operationId;
      if (this.cancelledOperationIds.delete(operationId)) {
        return;
      }
      active?.profiler.finalizeRunningStages('operation failed');

      const abortError = resolveAbortChatGooseError(error, {
        active: Boolean(active),
        timeoutSignal: timeoutController?.signal,
        cancelSignal: controller?.signal,
      });
      if (abortError) {
        const code = active
          ? abortError
          : new ChatGooseError('chat_changed');
        const errorPayload: ErrorPayload = {
          type: 'operation:error',
          operationId,
          error: toUserError(code),
        };
        this.sendError(
          tabId,
          errorPayload,
          active?.llmSpend ?? createZeroLlmSpendSummary(),
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
          active?.llmSpend ?? createZeroLlmSpendSummary(),
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
      llmClient: this.llmClient,
      agencyHubUsageReporter: this.agencyHubUsageReporter,
      hasActiveFeature: (tabId) => this.activeByTabId.has(tabId),
      hasPort: (tabId) => this.portsByTabId.has(tabId),
      send: (tabId, message) => this.send(tabId, message),
    };
  }

  private cancelCompare(
    tabId: number,
    error?: ChatGooseError,
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
