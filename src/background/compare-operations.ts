import {
  COMPARE_TEMPERATURE,
  DEFAULT_FEATURE_MODELS,
  FANSLY_MEDIA_PURCHASE_VERIFICATION_LIMIT,
  QUICK_OPERATION_TIMEOUT_MS,
  STREAM_CHUNK_FLUSH_MS,
} from '../shared/constants.js';
import { resolveCompareModelCards } from '../shared/compare-cards.js';
import { aggregateMonthlyEarnings, formatFanSpendingData } from '../shared/earnings.js';
import { ChatGooseError, toDebugErrorPayload, toUserError } from '../shared/errors.js';
import { logDebug } from '../shared/log.js';
import {
  getAgencyHubModelId,
  getModelDisplayName,
  getModelEntry,
  isAnthropicModelSelection,
} from '../shared/model-registry.js';
import { buildPromptRequest } from '../shared/prompts.js';
import { normalizeReplyParts } from '../shared/reply-output.js';
import { formatFanSubscriptionData } from '../shared/subscriptions.js';
import {
  buildPurchaseEvidence,
  collectUnverifiedPpvAttachmentRequests,
  formatTranscript,
  normalizeTranscript,
} from '../shared/transcript.js';
import type { PurchaseEvidenceOverride } from '../shared/transcript.js';
import type {
  AgencyHubAiUsageEvent,
  AggregatedEarnings,
  LlmCostEstimate,
  LlmSpendSummary,
  LlmUsageMetrics,
  BackgroundPortMessage,
  CompareCardCompletePayload,
  CompareCardErrorPayload,
  CompareChunkPayload,
  CompareCompletePayload,
  CompareDiscardedPayload,
  CompareErrorPayload,
  CompareModelCard,
  CompareProgressPayload,
  CompareReadyPayload,
  CompareStartPayload,
  FeatureResult,
  FanslyMessagePageResponse,
  OperationPhase,
  OperationProfilingSnapshot,
  ReplyMode,
  ReplyTone,
  SessionTemplate,
} from '../shared/types.js';
import {
  buildLlmSpendSummary,
  createZeroLlmSpendSummary,
  estimateLlmCost,
  formatModelCostLog,
  formatModelUsageLog,
} from './llm-cost.js';
import type {
  SubscriptionLookupTraceEvent,
  FanslyClient,
} from './fansly-client.js';
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
import type { SessionStore } from './session-store.js';
import type { StorageCoordinator } from './storage-coordinator.js';
import type { TabContextStore } from './tab-context.js';
import type { AgencyHubUsageReporter } from './agency-hub-usage-reporter.js';
import type { LlmClient } from './llm-client.js';

export interface ActiveCompareCardState {
  card: Pick<CompareModelCard, 'id' | 'label' | 'source'>;
  rawText: string;
  flushBuffer: string;
  flushTimer: number | null;
}

export interface ActiveCompareOperation {
  operationId: string;
  tabId: number;
  groupId: string;
  routeNonce: number;
  startedAtMs: number;
  controller: AbortController;
  profiler: OperationProfiler;
  compareCards: Map<string, ActiveCompareCardState>;
}

export interface CompareOperationsContext {
  activeCompareByTabId: Map<number, ActiveCompareOperation>;
  cancelledCompareOperationIds: Set<string>;
  sessionStore: SessionStore;
  tabContexts: TabContextStore;
  storageCoordinator: StorageCoordinator;
  fanslyClient: FanslyClient;
  llmClient: LlmClient;
  agencyHubUsageReporter: Pick<AgencyHubUsageReporter, 'enqueue'>;
  hasActiveFeature: (tabId: number) => boolean;
  hasPort: (tabId: number) => boolean;
  send: (tabId: number, message: BackgroundPortMessage) => void;
}

interface ValidatedCompareStart {
  tab: browser.tabs.Tab;
  urlGroupId: string;
  storage: Awaited<ReturnType<StorageCoordinator['getState']>>;
  session: SessionTemplate;
  legacyAccountId: string;
  messageCount: number;
}

const NO_OP_PROFILER = createOperationProfiler(false);

function hasApiKeyForSelectedCompareModel(
  storage: Awaited<ReturnType<StorageCoordinator['getState']>>,
): { ok: boolean; provider?: string } {
  const model = getModelEntry(storage.settings.featureModels['fast-reply']);
  if (!model) {
    return {
      ok: Boolean(storage.settings.claudeApiKey || storage.settings.openRouterApiKey),
    };
  }

  if (model.provider === 'anthropic') {
    return { ok: Boolean(storage.settings.claudeApiKey), provider: model.provider };
  }
  if (model.provider === 'openrouter') {
    return { ok: Boolean(storage.settings.openRouterApiKey), provider: model.provider };
  }

  return { ok: false, provider: model.provider };
}

function buildCompareCardProfilingSnapshot(
  profiler: OperationProfiler,
  usage?: LlmUsageMetrics,
  cost?: LlmCostEstimate,
): OperationProfilingSnapshot | undefined {
  const snapshot = profiler.snapshot();
  if (!snapshot) {
    return undefined;
  }

  return {
    ...snapshot,
    ...(usage ? { llmUsage: { ...usage } } : {}),
    ...(cost ? { llmCost: { ...cost } } : {}),
  };
}

function buildLlmSpendPayload(
  llmSpend?: LlmSpendSummary,
): { llmSpend: LlmSpendSummary } | object {
  return llmSpend ? { llmSpend } : {};
}

function buildAiUsageEvent({
  clientEventId,
  model,
  spend,
  conversationId,
  startedAtMs,
  completedAtMs,
  isRegeneration,
}: {
  clientEventId: string;
  model: string;
  spend: LlmSpendSummary;
  conversationId: string | null;
  startedAtMs: number | null | undefined;
  completedAtMs: number;
  isRegeneration: boolean;
}): AgencyHubAiUsageEvent {
  return {
    clientEventId,
    feature: 'fast-reply',
    model: getAgencyHubModelId(model),
    inputTokens: spend.inputTokens,
    outputTokens: spend.outputTokens,
    cacheWriteTokens: spend.cacheWriteTokens,
    cacheReadTokens: spend.cacheReadTokens,
    conversationId,
    durationMs: typeof startedAtMs === 'number'
      ? Math.max(0, completedAtMs - startedAtMs)
      : null,
    isCacheHit: false,
    isRegeneration: isRegeneration,
    completedAt: new Date(completedAtMs).toISOString(),
  };
}

function sendCompareReady(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareReadyPayload,
): void {
  context.send(tabId, payload);
}

function sendCompareProgress(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareProgressPayload,
  profiler: OperationProfiler = NO_OP_PROFILER,
): void {
  const profiling = profiler.snapshot();
  context.send(tabId, {
    type: 'compare:progress',
    ...payload,
    ...(profiling ? { profiling } : {}),
  });
}

function sendCompareChunk(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareChunkPayload,
): void {
  context.send(tabId, payload);
}

function sendCompareCardComplete(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareCardCompletePayload,
  profiler: OperationProfiler = NO_OP_PROFILER,
  profilingOverride?: OperationProfilingSnapshot,
): void {
  const profiling = profilingOverride ?? profiler.snapshot();
  context.send(tabId, {
    ...payload,
    ...buildLlmSpendPayload(payload.llmSpend),
    ...(profiling ? { profiling } : {}),
  });
}

function sendCompareCardError(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareCardErrorPayload,
  profiler: OperationProfiler = NO_OP_PROFILER,
  profilingOverride?: OperationProfilingSnapshot,
): void {
  const profiling = profilingOverride ?? profiler.snapshot();
  context.send(tabId, {
    ...payload,
    ...buildLlmSpendPayload(payload.llmSpend),
    ...(profiling ? { profiling } : {}),
  });
}

function sendCompareError(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareErrorPayload,
  profiler: OperationProfiler = NO_OP_PROFILER,
): void {
  const profiling = profiler.snapshot();
  context.send(tabId, {
    ...payload,
    ...(profiling ? { profiling } : {}),
  });
}

function sendCompareComplete(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareCompletePayload,
  profiler: OperationProfiler = NO_OP_PROFILER,
): void {
  const profiling = profiler.snapshot();
  context.send(tabId, {
    ...payload,
    ...(profiling ? { profiling } : {}),
  });
}

function sendCompareDiscarded(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareDiscardedPayload,
  profiler: OperationProfiler = NO_OP_PROFILER,
): void {
  const profiling = profiler.snapshot();
  context.send(tabId, {
    ...payload,
    ...(profiling ? { profiling } : {}),
  });
}

function getActiveCompare(
  context: CompareOperationsContext,
  tabId: number,
): ActiveCompareOperation | null {
  return context.activeCompareByTabId.get(tabId) ?? null;
}

function flushCompareChunks(
  context: CompareOperationsContext,
  tabId: number,
  operation: ActiveCompareOperation,
  cardId: string,
): void {
  const cardState = operation.compareCards.get(cardId);
  if (!cardState) {
    return;
  }
  if (!cardState.flushBuffer) {
    cardState.flushTimer = null;
    return;
  }

  const text = cardState.flushBuffer;
  cardState.flushBuffer = '';
  cardState.flushTimer = null;
  sendCompareChunk(context, tabId, {
    type: 'compare:chunk',
    operationId: operation.operationId,
    cardId,
    text,
  });
}

function scheduleCompareChunkFlush(
  context: CompareOperationsContext,
  tabId: number,
  operation: ActiveCompareOperation,
  cardId: string,
): void {
  const cardState = operation.compareCards.get(cardId);
  if (!cardState || cardState.flushTimer !== null) {
    return;
  }

  cardState.flushTimer = globalThis.setTimeout(() => {
    flushCompareChunks(context, tabId, operation, cardId);
  }, STREAM_CHUNK_FLUSH_MS) as unknown as number;
}

async function validateCompareStart(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareStartPayload,
): Promise<ValidatedCompareStart> {
  const [tab, storage] = await Promise.all([
    browser.tabs.get(tabId),
    context.storageCoordinator.getState(),
  ]);
  const urlGroupId = parseGroupIdFromUrl(tab.url);
  if (
    !tab.url?.includes('fansly.com') ||
    !urlGroupId ||
    urlGroupId !== payload.groupId
  ) {
    throw new ChatGooseError('chat_changed');
  }

  const session = context.sessionStore.getSessionForTab(tabId);
  const legacyAccountId = context.sessionStore.getAccountIdForTab(tabId);

  const apiKeyCheck = hasApiKeyForSelectedCompareModel(storage);
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
    messageCount: storage.settings.quickMessageCount,
  };
}

function clearCompareOperation(
  context: CompareOperationsContext,
  tabId: number,
): void {
  const active = getActiveCompare(context, tabId);
  if (!active) {
    return;
  }

  active.compareCards.forEach((cardState) => {
    if (cardState.flushTimer !== null) {
      clearTimeout(cardState.flushTimer);
    }
  });

  context.activeCompareByTabId.delete(tabId);
  context.cancelledCompareOperationIds.delete(active.operationId);
}

export function hasActiveCompare(
  context: CompareOperationsContext,
  tabId: number,
): boolean {
  return context.activeCompareByTabId.has(tabId);
}

export function cancelCompareOperation(
  context: CompareOperationsContext,
  tabId: number,
  error?: ChatGooseError,
  notifyDiscard = false,
): void {
  const active = getActiveCompare(context, tabId);
  if (!active) {
    return;
  }

  context.cancelledCompareOperationIds.add(active.operationId);
  active.controller.abort();
  active.compareCards.forEach((cardState) => {
    if (cardState.flushTimer !== null) {
      clearTimeout(cardState.flushTimer);
    }
  });

  context.activeCompareByTabId.delete(tabId);

  if (notifyDiscard) {
    sendCompareDiscarded(
      context,
      tabId,
      {
        type: 'compare:discarded',
        operationId: active.operationId,
        error: toUserError(error ?? new ChatGooseError('chat_changed')),
      },
      active.profiler,
    );
  }
}

async function verifyMediaPurchaseEvidence(
  context: CompareOperationsContext,
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
    const verified = await context.fanslyClient.verifyMediaPurchaseStates(
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

export async function executeCompare(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareStartPayload,
): Promise<void> {
  if (context.hasActiveFeature(tabId) || context.activeCompareByTabId.has(tabId)) {
    sendCompareError(context, tabId, {
      type: 'compare:error',
      operationId: payload.operationId,
      error: toUserError(new ChatGooseError('another_operation')),
    });
    return;
  }

  if (!context.hasPort(tabId)) {
    return;
  }

  let timeout: number | null = null;
  let timeoutController: AbortController | null = null;
  let controller: AbortController | null = null;
  let debugEnabled = false;
  try {
    const validated = await validateCompareStart(context, tabId, payload);
    debugEnabled = validated.storage.settings.debugMode;
    const profiler = createOperationProfiler(debugEnabled);
    const compareTimeoutController = new AbortController();
    timeoutController = compareTimeoutController;
    timeout = globalThis.setTimeout(
      () => compareTimeoutController.abort(),
      QUICK_OPERATION_TIMEOUT_MS,
    ) as unknown as number;
    const compareController = new AbortController();
    controller = compareController;
    const signal = AbortSignal.any([
      compareController.signal,
      compareTimeoutController.signal,
    ]);

    const active: ActiveCompareOperation = {
      operationId: payload.operationId,
      tabId,
      groupId: validated.urlGroupId,
      routeNonce: payload.routeNonce,
      startedAtMs: Date.now(),
      controller: compareController,
      profiler,
      compareCards: new Map(),
    };

    // Feature operations own tabContexts.activeOperationId; compare state is tracked separately here.
    context.activeCompareByTabId.set(tabId, active);
    context.tabContexts.setRoute(
      tabId,
      validated.urlGroupId,
      payload.routeNonce,
    );

    let progressPhase: OperationPhase = 'loading-messages';
    let progressMessage: string | undefined = 'Preparing compare…';
    let progressCurrentPage: number | undefined;
    let progressTargetPages: number | undefined;
    let progressFanDisplayName = payload.domFanDisplayName ?? 'fan';

    type CompareProgressUpdate = {
      phase?: OperationPhase;
      message?: string | undefined;
      currentPage?: number | undefined;
      targetPages?: number | undefined;
      fanDisplayName?: string | undefined;
    };

    const sendCompareOperationProgress = (
      updates?: CompareProgressUpdate,
    ): void => {
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
        if ('fanDisplayName' in updates && updates.fanDisplayName) {
          progressFanDisplayName = updates.fanDisplayName;
        }
      }

      sendCompareProgress(
        context,
        tabId,
        {
          operationId: payload.operationId,
          phase: progressPhase,
          message: progressMessage,
          currentPage: progressCurrentPage,
          targetPages: progressTargetPages,
          fanDisplayName: progressFanDisplayName,
        },
        profiler,
      );
    };

    const sendDebugCompareProgress = (
      updates?: CompareProgressUpdate,
    ): void => {
      if (!profiler.enabled) {
        return;
      }
      sendCompareOperationProgress(updates);
    };

    const startStage = (
      key: Parameters<OperationProfiler['startStage']>[0],
      label: string,
      detail?: string,
      progressUpdates?: CompareProgressUpdate,
    ): void => {
      profiler.startStage(key, label, detail);
      profiler.log(label);
      sendDebugCompareProgress(progressUpdates);
    };

    const completeStage = (
      key: Parameters<OperationProfiler['completeStage']>[0],
      logMessage: string,
      detail?: string,
      progressUpdates?: CompareProgressUpdate,
    ): void => {
      profiler.completeStage(key, detail);
      profiler.log(logMessage);
      sendDebugCompareProgress(progressUpdates);
    };

    const failStage = (
      key: Parameters<OperationProfiler['failStage']>[0],
      logMessage: string,
      detail?: string,
      progressUpdates?: CompareProgressUpdate,
    ): void => {
      profiler.failStage(key, detail);
      profiler.log(logMessage);
      sendDebugCompareProgress(progressUpdates);
    };

    const skipStage = (
      key: Parameters<OperationProfiler['skipStage']>[0],
      label: string,
      detail: string,
      progressUpdates?: CompareProgressUpdate,
    ): void => {
      profiler.skipStage(key, label, detail);
      profiler.log(`${label} skipped: ${detail}`);
      sendDebugCompareProgress(progressUpdates);
    };

    let resolvedAccountId = validated.legacyAccountId;
    startStage(
      'resolve-identity',
      'Resolve account identity',
      undefined,
      {
        message: 'Preparing compare…',
      },
    );
    try {
      resolvedAccountId =
        await context.fanslyClient.getAuthenticatedAccountId(
          validated.session,
          signal,
        );
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
        `Resolve account identity failed: ${failureCode}`,
        failureCode,
      );
      logDebug(debugEnabled, 'account identity resolution failed', {
        legacyAccountId: validated.legacyAccountId,
        code: failureCode,
      });
      throw error;
    }

    const rekeyResult = await context.storageCoordinator.rekeyAccountIdentity(
      validated.legacyAccountId,
      resolvedAccountId,
    );
    const storage = rekeyResult.state;
    const compareCards = resolveCompareModelCards(
      storage,
      resolvedAccountId,
      validated.legacyAccountId,
    );
    if (compareCards.length < 2) {
      throw new ChatGooseError('compare_cards_unavailable');
    }

    for (const card of compareCards) {
      active.compareCards.set(card.id, {
        card: {
          id: card.id,
          label: card.label,
          source: card.source,
        },
        rawText: '',
        flushBuffer: '',
        flushTimer: null,
      });
    }

    sendCompareReady(context, tabId, {
      type: 'compare:ready',
      operationId: payload.operationId,
      fanDisplayName: progressFanDisplayName,
      cards: compareCards.map((card) => ({
        id: card.id,
        label: card.label,
        source: card.source,
      })),
    });
    sendCompareOperationProgress();

    const resolvedModel = validated.storage.settings.featureModels['fast-reply'];

    startStage(
      'load-messages',
      'Load messages',
      undefined,
      {
        phase: 'loading-messages',
        message: 'Loading messages…',
      },
    );
    profiler.log(`Requested ${validated.messageCount} messages for compare`);
    const messageLoad = await context.fanslyClient.loadMessages(
      validated.urlGroupId,
      validated.messageCount,
      validated.session,
      signal,
      (progress) => {
        if (profiler.enabled) {
          profiler.log(describeMessageLoadProgress(progress));
        }
        sendCompareOperationProgress({
          phase: 'loading-messages',
          currentPage: progress.currentPage,
          targetPages: progress.targetPages,
          message: `Loading messages… ${progress.currentPage}/${progress.targetPages} pages`,
        });
      },
    );
    completeStage(
      'load-messages',
      `Loaded messages: ${messageLoad.pagesLoaded} pages`,
      `${messageLoad.pagesLoaded} pages`,
    );

    let groupUsers: Array<{ userId: string }> | null = null;
    startStage('group-lookup', 'Load group users');
    try {
      const group = await context.fanslyClient.getGroup(
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

    const fanAccountId =
      groupUsers?.find((user) => user.userId !== resolvedAccountId)?.userId ??
      null;
    const purchaseEvidence = await verifyMediaPurchaseEvidence(
      context,
      messageLoad.pages,
      fanAccountId,
      validated.session,
      signal,
      debugEnabled,
    );
    // Normalize after group-lookup so transcript labels use fan-perspective
    // purchase state. Falls back to "unknown" when fanAccountId is null.
    const transcriptMessages = normalizeTranscript(
      messageLoad.pages,
      resolvedAccountId,
      fanAccountId,
      purchaseEvidence,
    );
    let fanDisplayName = payload.domFanDisplayName ?? 'fan';
    if (fanAccountId) {
      startStage('account-name-lookup', 'Resolve fan display name');
      try {
        const accounts = await context.fanslyClient.getAccountNames(
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
          { fanDisplayName },
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

    context.tabContexts.setFan(tabId, fanAccountId, fanDisplayName);
    sendCompareOperationProgress({
      phase: 'loading-earnings',
      message: 'Loading fan context…',
      currentPage: undefined,
      targetPages: undefined,
      fanDisplayName,
    });

    let spendingData = '';
    let subscriptionData = '';
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

        if (profiler.enabled) {
          profiler.log(`Subscription lookup ${step}`);
          sendDebugCompareProgress();
        }
      };

      const subscriptionRequest = profiler.enabled
        ? context.fanslyClient.getFanSubscriptionContext(
            validated.urlGroupId,
            fanAccountId,
            validated.session,
            signal,
            'full',
            handleSubscriptionTrace,
          )
        : context.fanslyClient.getFanSubscriptionContext(
            validated.urlGroupId,
            fanAccountId,
            validated.session,
            signal,
            'full',
          );
      const windowEndMs = Date.now();
      const [monthlyResult, earningsResult, subscriptionResult] =
        await Promise.allSettled([
          context.fanslyClient.getMonthlyEarnings(
            fanAccountId,
            0,
            windowEndMs,
            validated.session,
            signal,
          ),
          context.fanslyClient.getEarnings(
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

      if (statsAggregated || monthlyTotals.length > 0) {
        const aggregated: AggregatedEarnings = statsAggregated ?? {
          correlationAccountId: fanAccountId,
          windowStartIso: new Date(0).toISOString(),
          windowEndIso: new Date(windowEndMs).toISOString(),
          totalGross: monthlyTotals.reduce(
            (sum, month) => sum + month.totalGross,
            0,
          ),
          totalNet: monthlyTotals.reduce(
            (sum, month) => sum + month.totalNet,
            0,
          ),
          breakdown: [],
          monthlyTotals,
        };
        aggregated.monthlyTotals = monthlyTotals;
        spendingData = formatFanSpendingData(aggregated);
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
        logDebug(debugEnabled, 'subscription fetch failed (fail-open)', {
          fanAccountId,
        });
      }
    } else {
      skipStage('earnings', 'Fetch earnings', 'fan account unavailable');
      skipStage(
        'subscription-lookup',
        'Lookup subscription',
        'fan account unavailable',
      );
    }

    startStage('prompt-build', 'Build compare prompts');
    const formattedTranscript = formatTranscript(transcriptMessages);
    const promptInputs = {
      transcript: formattedTranscript,
      fanSpendingData: spendingData,
      fanSubscriptionData: subscriptionData,
      fanDisplayName,
      replyMode: payload.replyMode ?? 'default',
      replyTone: payload.replyTone ?? 'none',
    } satisfies {
      transcript: string;
      fanSpendingData: string;
      fanSubscriptionData: string;
      fanDisplayName: string;
      replyMode: ReplyMode;
      replyTone: ReplyTone;
    };
    completeStage(
      'prompt-build',
      `Built compare prompts: ${compareCards.length} cards`,
      `${compareCards.length} cards`,
    );

    sendCompareOperationProgress({
      phase: 'generating',
      message: 'Generating compare replies…',
      fanDisplayName,
    });

    const runCard = async (card: CompareModelCard): Promise<void> => {
      const currentActive = getActiveCompare(context, tabId);
      if (
        !currentActive ||
        currentActive.operationId !== payload.operationId
      ) {
        return;
      }

      const { systemBlocks, userBlocks } = buildPromptRequest({
        feature: 'fast-reply',
        personality: {
          id: card.id,
          name: card.label,
          content: card.content,
          updatedAt: Date.now(),
        },
        transcript: promptInputs.transcript,
        fanSpendingData: promptInputs.fanSpendingData,
        fanSubscriptionData: promptInputs.fanSubscriptionData,
        fanDisplayName: promptInputs.fanDisplayName,
        replyMode: promptInputs.replyMode,
        replyTone: promptInputs.replyTone,
      }, validated.storage.settings.promptCachingEnabled);

      let cardUsage: LlmUsageMetrics | undefined;
      let cardCost: LlmCostEstimate | undefined;
      let cardSpend: LlmSpendSummary | undefined;
      let actualModel = resolvedModel;
      let reasoningObserved = false;
      let latestStopReason: string | null = null;

      const streamToCard = async (model: string): Promise<string> => {
        actualModel = model;
        reasoningObserved = false;
        const reasoningEffort = validated.storage.settings.featureReasoning['fast-reply'];
        profiler.log(
          `Reasoning requested: ${reasoningEffort} (${getModelDisplayName(actualModel)})`,
        );
        return context.llmClient.streamMessage({
          settings: validated.storage.settings,
          model,
          temperature: COMPARE_TEMPERATURE,
          systemBlocks,
          userBlocks,
          feature: 'fast-reply',
          reasoningEffort,
          signal,
          onText: (chunk) => {
            const activeCompare = getActiveCompare(context, tabId);
            if (
              !activeCompare ||
              activeCompare.operationId !== payload.operationId
            ) {
              return;
            }
            const cardState = activeCompare.compareCards.get(card.id);
            if (!cardState) {
              return;
            }
            cardState.rawText += chunk;
            cardState.flushBuffer += chunk;
            scheduleCompareChunkFlush(
              context,
              tabId,
              activeCompare,
              card.id,
            );
          },
          onUsage: (usage) => {
            const cost = estimateLlmCost(actualModel, usage);
            const spend = buildLlmSpendSummary(actualModel, usage, cost);
            cardUsage = { ...usage };
            cardCost = { ...cost };
            cardSpend = { ...spend };
            profiler.log(formatModelUsageLog(actualModel, usage));
            profiler.log(formatModelCostLog(cost));
            logDebug(debugEnabled, 'model usage', {
              cardId: card.id,
              model: actualModel,
              ...usage,
            });
            logDebug(debugEnabled, 'model cost', {
              cardId: card.id,
              ...cost,
            });
            sendDebugCompareProgress({
              phase: 'generating',
              message: 'Generating compare replies…',
              fanDisplayName,
            });
          },
          onReasoningObserved: (reasoningSignal) => {
            if (reasoningObserved) {
              return;
            }
            reasoningObserved = true;
            profiler.log(`Reasoning observed: yes (${reasoningSignal})`);
            logDebug(debugEnabled, 'reasoning observed', {
              cardId: card.id,
              model: actualModel,
              feature: 'fast-reply',
              reasoningEffort,
              signal: reasoningSignal,
            });
            sendDebugCompareProgress({
              phase: 'generating',
              message: 'Generating compare replies…',
              fanDisplayName,
            });
          },
          onStopReason: (stopReason) => {
            latestStopReason = stopReason;
          },
        }).then((text) => {
          if (reasoningEffort !== 'off' && !reasoningObserved) {
            profiler.log('Reasoning observed: no');
            logDebug(debugEnabled, 'reasoning observed', {
              cardId: card.id,
              model: actualModel,
              feature: 'fast-reply',
              reasoningEffort,
              observed: false,
            });
          }
          return text;
        });
      };

      let rawText = '';
      try {
        rawText = await streamToCard(resolvedModel);
      } catch (error) {
        const defaultModel = DEFAULT_FEATURE_MODELS['fast-reply'];
        const isModelError = error instanceof ChatGooseError
          ? error.key === 'model_unavailable'
          : (error as { key?: string })?.key === 'model_unavailable';
        const abortError = resolveAbortChatGooseError(error, {
          active: Boolean(getActiveCompare(context, tabId)),
          timeoutSignal: timeoutController?.signal,
          cancelSignal: controller?.signal,
        });
        if (
          isModelError &&
          isAnthropicModelSelection(resolvedModel) &&
          resolvedModel !== defaultModel
        ) {
          rawText = await streamToCard(defaultModel);
        } else if (abortError?.key === 'timed_out') {
          throw abortError;
        } else if (abortError?.key === 'chat_changed') {
          return;
        } else {
          const profiling = buildCompareCardProfilingSnapshot(
            profiler,
            cardUsage,
            cardCost,
          );
          sendCompareCardError(
            context,
            tabId,
            {
              type: 'compare:cardError',
              operationId: payload.operationId,
              cardId: card.id,
              error: toUserError(abortError ?? error),
              llmSpend:
                cardSpend ?? createZeroLlmSpendSummary(),
            },
            profiler,
            profiling,
          );
          return;
        }
      }

      const activeCompare = getActiveCompare(context, tabId);
      if (
        !activeCompare ||
        activeCompare.operationId !== payload.operationId
      ) {
        return;
      }
      const cardState = activeCompare.compareCards.get(card.id);
      if (!cardState) {
        return;
      }
      if (cardState.flushTimer !== null) {
        clearTimeout(cardState.flushTimer);
        flushCompareChunks(context, tabId, activeCompare, card.id);
      }

      const parts = normalizeReplyParts(rawText);
      if (latestStopReason === 'max_tokens' || parts.length === 0) {
        const profiling = buildCompareCardProfilingSnapshot(
          profiler,
          cardUsage,
          cardCost,
        );
        sendCompareCardError(
          context,
          tabId,
          {
            type: 'compare:cardError',
            operationId: payload.operationId,
            cardId: card.id,
            error: toUserError(new ChatGooseError('ai_output_unusable')),
            llmSpend:
              cardSpend ?? createZeroLlmSpendSummary(),
          },
          profiler,
          profiling,
        );
        return;
      }

      const result: FeatureResult = {
        rawText,
        splitModeRequested: payload.replyMode === 'preferSplit',
        parts,
      };
      const completedAtMs = Date.now();
      const completedSpend = cardSpend ?? createZeroLlmSpendSummary();
      sendCompareCardComplete(
        context,
        tabId,
        {
          type: 'compare:cardComplete',
          operationId: payload.operationId,
          cardId: card.id,
          result,
          fanDisplayName,
          llmSpend: completedSpend,
        },
        profiler,
        buildCompareCardProfilingSnapshot(profiler, cardUsage, cardCost),
      );
      context.agencyHubUsageReporter.enqueue(
        {
          agencyHubBaseUrl: validated.storage.settings.agencyHubBaseUrl,
          agencyHubApiKey: validated.storage.settings.agencyHubApiKey,
          debugMode: validated.storage.settings.debugMode,
        },
        buildAiUsageEvent({
          clientEventId: `${payload.operationId}:${card.id}`,
          model: actualModel,
          spend: completedSpend,
          conversationId: validated.urlGroupId,
          startedAtMs: activeCompare.startedAtMs,
          completedAtMs,
          isRegeneration: Boolean(payload.forceRegenerate),
        }),
      );
    };

    await Promise.all(compareCards.map((card) => runCard(card)));

    const completedActive = getActiveCompare(context, tabId);
    if (
      !completedActive ||
      completedActive.operationId !== payload.operationId
    ) {
      return;
    }

    sendCompareComplete(
      context,
      tabId,
      {
        type: 'compare:complete',
        operationId: payload.operationId,
        fanDisplayName,
      },
      profiler,
    );
    clearCompareOperation(context, tabId);
  } catch (error) {
    const active = getActiveCompare(context, tabId);
    const operationId = active?.operationId ?? payload.operationId;
    if (context.cancelledCompareOperationIds.delete(operationId)) {
      return;
    }
    active?.profiler.finalizeRunningStages('compare failed');

    const abortError = resolveAbortChatGooseError(error, {
      active: Boolean(active),
      timeoutSignal: timeoutController?.signal,
      cancelSignal: controller?.signal,
    });
    if (abortError) {
      sendCompareError(
        context,
        tabId,
        {
          type: 'compare:error',
          operationId,
          error: toUserError(active ? abortError : new ChatGooseError('chat_changed')),
        },
        active?.profiler ?? NO_OP_PROFILER,
      );
    } else {
      sendCompareError(
        context,
        tabId,
        {
          type: 'compare:error',
          operationId,
          error: toUserError(error),
        },
        active?.profiler ?? NO_OP_PROFILER,
      );
    }

    logDebug(debugEnabled, 'compare operation error', error);
    cancelCompareOperation(context, tabId);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}
