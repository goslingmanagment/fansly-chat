import {
  DEFAULT_FEATURE_MODELS,
  QUICK_OPERATION_TIMEOUT_MS,
  STREAM_CHUNK_FLUSH_MS,
} from '../shared/constants.js';
import { aggregateMonthlyEarnings, formatFanSpendingData } from '../shared/earnings.js';
import { resolveClaudeProviderSettings } from '../shared/claude-api.js';
import { resolveCompareModelCards } from '../shared/compare-cards.js';
import { ChatMuseError, toUserError } from '../shared/errors.js';
import { logDebug } from '../shared/log.js';
import { buildPrompt, stripPromptCacheControl } from '../shared/prompts.js';
import { formatFanSubscriptionData } from '../shared/subscriptions.js';
import { formatTranscript } from '../shared/transcript.js';
import type {
  AggregatedEarnings,
  AnthropicCostEstimate,
  AnthropicSpendSummary,
  AnthropicUsageMetrics,
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
  OperationPhase,
  OperationProfilingSnapshot,
  ReplyMode,
  ReplyTone,
  SessionTemplate,
} from '../shared/types.js';
import type { AnthropicClient } from './anthropic-client.js';
import {
  buildAnthropicSpendSummary,
  createZeroAnthropicSpendSummary,
  estimateAnthropicCost,
  formatAnthropicCostLog,
} from './anthropic-cost.js';
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
} from './operation-utils.js';
import type { SessionStore } from './session-store.js';
import type { StorageCoordinator } from './storage-coordinator.js';
import type { TabContextStore } from './tab-context.js';

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
  anthropicClient: AnthropicClient;
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

function formatAnthropicUsageLog(usage: AnthropicUsageMetrics): string {
  return `Claude usage: input_tokens=${usage.input_tokens}, cache_creation_input_tokens=${usage.cache_creation_input_tokens}, cache_read_input_tokens=${usage.cache_read_input_tokens}, output_tokens=${usage.output_tokens}`;
}

function buildCompareCardProfilingSnapshot(
  profiler: OperationProfiler,
  usage?: AnthropicUsageMetrics,
  cost?: AnthropicCostEstimate,
): OperationProfilingSnapshot | undefined {
  const snapshot = profiler.snapshot();
  if (!snapshot) {
    return undefined;
  }

  return {
    ...snapshot,
    ...(usage ? { anthropicUsage: { ...usage } } : {}),
    ...(cost ? { anthropicCost: { ...cost } } : {}),
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
    throw new ChatMuseError('chat_changed');
  }

  const session = context.sessionStore.getSessionForTab(tabId);
  const legacyAccountId = context.sessionStore.getAccountIdForTab(tabId);
  const resolvedProvider = resolveClaudeProviderSettings(storage.settings);

  if (!resolvedProvider.apiKey) {
    throw new ChatMuseError('missing_api_key', undefined, undefined, false, resolvedProvider.provider);
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
  error?: ChatMuseError,
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
        error: toUserError(error ?? new ChatMuseError('chat_changed')),
      },
      active.profiler,
    );
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
      error: toUserError(new ChatMuseError('another_operation')),
    });
    return;
  }

  if (!context.hasPort(tabId)) {
    return;
  }

  let timeout: number | null = null;
  let debugEnabled = false;
  try {
    const validated = await validateCompareStart(context, tabId, payload);
    debugEnabled = validated.storage.settings.debugMode;
    const profiler = createOperationProfiler(debugEnabled);
    const timeoutController = new AbortController();
    timeout = globalThis.setTimeout(
      () => timeoutController.abort(),
      QUICK_OPERATION_TIMEOUT_MS,
    ) as unknown as number;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      timeoutController.signal,
    ]);

    const active: ActiveCompareOperation = {
      operationId: payload.operationId,
      tabId,
      groupId: validated.urlGroupId,
      routeNonce: payload.routeNonce,
      controller,
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
      throw new ChatMuseError('compare_cards_unavailable');
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
      resolvedAccountId,
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
      `Loaded messages: ${messageLoad.pagesLoaded} pages, ${messageLoad.transcriptMessages.length} transcript messages`,
      `${messageLoad.pagesLoaded} pages, ${messageLoad.transcriptMessages.length} transcript messages`,
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
    const formattedTranscript = formatTranscript(
      messageLoad.transcriptMessages,
    );
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

      const prompt = buildPrompt({
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
      });
      const systemBlocks = validated.storage.settings.promptCachingEnabled
        ? prompt.systemBlocks
        : stripPromptCacheControl(prompt.systemBlocks);
      const userBlocks = validated.storage.settings.promptCachingEnabled
        ? prompt.userBlocks
        : stripPromptCacheControl(prompt.userBlocks);

      let cardUsage: AnthropicUsageMetrics | undefined;
      let cardCost: AnthropicCostEstimate | undefined;
      let cardSpend: AnthropicSpendSummary | undefined;
      let actualModel = resolvedModel;
      const resolvedProvider = resolveClaudeProviderSettings(validated.storage.settings);

      const streamToCard = async (model: string): Promise<string> => {
        actualModel = model;
        return context.anthropicClient.streamMessage({
          provider: resolvedProvider.provider,
          apiKey: resolvedProvider.apiKey,
          model,
          systemBlocks,
          userBlocks,
          feature: 'fast-reply',
          debugEnabled,
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
            const cost = estimateAnthropicCost(actualModel, usage);
            const spend = buildAnthropicSpendSummary(actualModel, usage, cost);
            cardUsage = { ...usage };
            cardCost = { ...cost };
            cardSpend = { ...spend };
            profiler.log(formatAnthropicUsageLog(usage));
            profiler.log(formatAnthropicCostLog(cost));
            logDebug(debugEnabled, 'anthropic usage', {
              cardId: card.id,
              model: actualModel,
              ...usage,
            });
            logDebug(debugEnabled, 'anthropic cost', {
              cardId: card.id,
              ...cost,
            });
            sendDebugCompareProgress({
              phase: 'generating',
              message: 'Generating compare replies…',
              fanDisplayName,
            });
          },
        });
      };

      let rawText = '';
      try {
        rawText = await streamToCard(resolvedModel);
      } catch (error) {
        const defaultModel = DEFAULT_FEATURE_MODELS['fast-reply'];
        const isModelError = error instanceof ChatMuseError
          ? error.code === 'model_unavailable'
          : (error as { code?: string })?.code === 'model_unavailable';
        if (isModelError && resolvedModel !== defaultModel) {
          rawText = await streamToCard(defaultModel);
        } else if (
          error instanceof DOMException &&
          error.name === 'AbortError'
        ) {
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
              error: toUserError(error),
              anthropicSpend:
                cardSpend ?? createZeroAnthropicSpendSummary(),
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

      const result: FeatureResult = {
        rawText,
        splitModeRequested: payload.replyMode === 'preferSplit',
        parts: rawText
          .split('[NEXT]')
          .map((part) => part.trim())
          .filter(Boolean),
      };
      sendCompareCardComplete(
        context,
        tabId,
        {
          type: 'compare:cardComplete',
          operationId: payload.operationId,
          cardId: card.id,
          result,
          fanDisplayName,
          anthropicSpend: cardSpend ?? createZeroAnthropicSpendSummary(),
        },
        profiler,
        buildCompareCardProfilingSnapshot(profiler, cardUsage, cardCost),
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

    if (
      error instanceof DOMException &&
      error.name === 'AbortError'
    ) {
      sendCompareError(
        context,
        tabId,
        {
          type: 'compare:error',
          operationId,
          error: toUserError(
            active
              ? new ChatMuseError('timed_out')
              : new ChatMuseError('chat_changed'),
          ),
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
