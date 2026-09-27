import {
  QUICK_OPERATION_TIMEOUT_MS,
  STREAM_CHUNK_FLUSH_MS,
} from '../shared/constants.js';
import { isOutputExhausted } from '@kernel/sdk';
import {
  resolveCompareModelCards,
  resolveMappedPersonalityId,
} from '../shared/compare-cards.js';
import { findActivePersona, getActivePersonaCatalog } from '../shared/persona-catalog.js';
import { aggregateMonthlyEarnings, formatFanSpendingData } from '../shared/earnings.js';
import { ChatGooseError, toUserError } from '../shared/errors.js';
import { logDebug } from '../shared/log.js';
import { normalizeReplyParts } from '../shared/reply-output.js';
import { formatFanSubscriptionData } from '../shared/subscriptions.js';
import {
  formatTranscriptWithMediaForKernel,
  normalizeTranscript,
} from '../shared/transcript.js';
import type {
  AggregatedEarnings,
  LlmSpendSummary,
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
import {
  buildKernelSpendSummary,
  createZeroLlmSpendSummary,
  formatKernelUsageLog,
} from '../shared/spend.js';
import type { AgencyHubClient } from './agency-hub-client.js';
import type {
  KernelFeatureGateway,
  KernelFeatureUsage,
} from './kernel-feature-gateway.js';
import type {
  SubscriptionLookupTraceEvent,
  FanslyClient,
} from './fansly-client.js';
import {
  createOperationProfiler,
  type OperationProfiler,
} from './operation-profiling.js';
import { clearFlushTimer, clearFlushTimers } from './operation-cleanup.js';
import { OperationTimeoutController } from './operation-timeouts.js';
import { recordGeneration, recordHubError } from './ops-daily.js';
import type { CompareOperationLifecycle } from './operation-registry.js';
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
import { loadMediaPurchaseEvidence } from './conversation-context-loader.js';
import {
  isFreshPersonaOperationIdentityCurrent,
  type PersonaOperationIdentity,
} from './persona-identity-fence.js';

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
  personaIdentity: PersonaOperationIdentity | null;
  compareCards: Map<string, ActiveCompareCardState>;
}

export interface CompareOperationsContext {
  lifecycle: CompareOperationLifecycle<ActiveCompareOperation>;
  sessionStore: SessionStore;
  tabContexts: TabContextStore;
  storageCoordinator: StorageCoordinator;
  fanslyClient: FanslyClient;
  kernelGateway: KernelFeatureGateway;
  agencyHubClient: AgencyHubClient;
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


function buildCompareCardProfilingSnapshot(
  profiler: OperationProfiler,
  usage?: KernelFeatureUsage,
): OperationProfilingSnapshot | undefined {
  const snapshot = profiler.snapshot();
  if (!snapshot) {
    return undefined;
  }

  return {
    ...snapshot,
    ...(usage
      ? {
          llmUsage: {
            input_tokens: usage.inputTokens,
            cache_creation_input_tokens: usage.cacheWriteTokens,
            cache_read_input_tokens: usage.cacheReadTokens,
            output_tokens: usage.outputTokens,
          },
        }
      : {}),
  };
}

function buildLlmSpendPayload(
  llmSpend?: LlmSpendSummary,
): { llmSpend: LlmSpendSummary } | object {
  return llmSpend ? { llmSpend } : {};
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
  // A compare card IS a feature-lane generation, so its terminal failure belongs
  // in the same day counter as a fast-reply's — otherwise «Активность» reports
  // zero Hub errors while the compare grid is red. recordHubError keeps only the
  // `CG-HUB-` family, so a flow/AI code (`compare_cards_unavailable`,
  // `ai_output_unusable`) passing through here is dropped, not counted.
  void recordHubError(payload.error.code).catch(() => undefined);
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
  // Terminal failure of the whole compare run. Same `CG-HUB-` filter as above.
  void recordHubError(payload.error.code).catch(() => undefined);
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
  return context.lifecycle.getCompare(tabId);
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

  // Stage 32: AI rides the kernel feature lane — configured = hub up.
  if (!context.kernelGateway.isConfigured(storage.settings)) {
    throw new ChatGooseError('hub_missing_api_key');
  }
  if (getActivePersonaCatalog(storage.personaCatalog).length === 0) {
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

  context.lifecycle.completeCompare(tabId, (operation) => {
    clearFlushTimers(operation.compareCards.values());
  });
}

export function hasActiveCompare(
  context: CompareOperationsContext,
  tabId: number,
): boolean {
  return context.lifecycle.hasActiveCompare(tabId);
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

  context.lifecycle.cancelCompare(tabId, (operation) => {
    clearFlushTimers(operation.compareCards.values());
  });

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

async function fenceComparePersonaIdentity(
  context: CompareOperationsContext,
  tabId: number,
  operationId: string,
  identity: PersonaOperationIdentity,
): Promise<boolean> {
  if (await isFreshPersonaOperationIdentityCurrent(identity)) {
    return true;
  }

  const active = getActiveCompare(context, tabId);
  if (active?.operationId === operationId) {
    cancelCompareOperation(
      context,
      tabId,
      new ChatGooseError('chat_changed'),
      true,
    );
  }
  return false;
}

export async function executeCompare(
  context: CompareOperationsContext,
  tabId: number,
  payload: CompareStartPayload,
): Promise<void> {
  if (context.lifecycle.isBusy(tabId)) {
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

  // Reserve the tab synchronously before the first await so a racing feature
  // or compare start cannot slip past the guard during validateCompareStart.
  if (!context.lifecycle.reserve(tabId)) {
    sendCompareError(context, tabId, {
      type: 'compare:error',
      operationId: payload.operationId,
      error: toUserError(new ChatGooseError('another_operation')),
    });
    return;
  }
  // P1-1 (same shape as startOperation): a route-change during validate's awaits
  // advances the context but doesn't cancel this reserved-but-not-active start;
  // its setRoute below would roll the context back onto the abandoned chat.
  const startRouteNonce = context.tabContexts.getOrCreate(tabId).routeNonce;
  let timeoutController: OperationTimeoutController<'quick-total'> | null = null;
  let controller: AbortController | null = null;
  let debugEnabled = false;
  try {
    const validated = await validateCompareStart(context, tabId, payload);
    // Stale start: die with chat_changed, never re-touch the tab context.
    if (context.tabContexts.getOrCreate(tabId).routeNonce !== startRouteNonce) {
      throw new ChatGooseError('chat_changed');
    }
    debugEnabled = validated.storage.settings.debugMode;
    const profiler = createOperationProfiler(debugEnabled);
    const compareTimeoutController = new OperationTimeoutController<'quick-total'>();
    timeoutController = compareTimeoutController;
    compareTimeoutController.arm('quick-total', QUICK_OPERATION_TIMEOUT_MS);
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
      personaIdentity: null,
      compareCards: new Map(),
    };

    // Feature operations own tabContexts.activeOperationId; compare state is tracked separately here.
    context.lifecycle.activateCompare(tabId, active);
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
    if (storage.personaCatalogSource !== validated.storage.personaCatalogSource) {
      throw new ChatGooseError('chat_changed');
    }
    const mappedPersonaKey = resolveMappedPersonalityId(
      storage.accountMappings,
      resolvedAccountId,
      validated.legacyAccountId,
      storage.accountAliases,
    );
    const mappedPersona = findActivePersona(storage.personaCatalog, mappedPersonaKey);
    const personaIdentity: PersonaOperationIdentity | null = mappedPersona
      ? {
          resolvedAccountId,
          legacyAccountId: validated.legacyAccountId,
          personaKey: mappedPersona.key,
          personaVersion: mappedPersona.version,
          personaDefinitionId: mappedPersona.definitionId,
          personaCatalogSource: storage.personaCatalogSource,
        }
      : null;
    active.personaIdentity = personaIdentity;
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

    // Stage 32: models are kernel config; the meta frame names the real one.
    const resolvedModel = 'kernel';

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
    const purchaseEvidence = await loadMediaPurchaseEvidence({
      fanslyClient: context.fanslyClient,
      pages: messageLoad.pages,
      fanAccountId,
      session: validated.session,
      signal,
      debugEnabled,
    });
    // Normalize after group-lookup so transcript labels use fan-perspective
    // purchase state. Falls back to "unknown" when fanAccountId is null.
    const transcriptMessages = normalizeTranscript(
      messageLoad.pages,
      resolvedAccountId,
      fanAccountId,
      purchaseEvidence,
    );
    // UI-facing label (may carry a chatter's private custom fan name via the
    // DOM fallback). The KERNEL name is account-lookup only (custom-name rule,
    // spec §4) so a custom name never reaches a prompt.
    let fanDisplayName = payload.domFanDisplayName ?? 'fan';
    let kernelFanName = 'fan';
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
        kernelFanName =
          account?.username?.trim() || account?.displayName?.trim() || 'fan';
        completeStage(
          'account-name-lookup',
          `Resolved fan display name: ${fanDisplayName}`,
          `resolved ${fanDisplayName}`,
          { fanDisplayName },
        );
      } catch (error) {
        // Belt-and-braces (conversation-context-loader pattern): a route-change
        // abort must unwind this op, not fall through to write a stale fan.
        if (signal.aborted) {
          throw error;
        }
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

    // Pass THIS op's groupId; the store no-ops if the context has moved on.
    context.tabContexts.setFan(tabId, validated.urlGroupId, fanAccountId, fanDisplayName);
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
    // W9.4/A26: same 300k oldest-first cap as the main lane — compare cards
    // ride the identical kernel clientContext schema.
    const {
      transcript: formattedTranscript,
      messageCount: keptMessageCount,
      media: transcriptMedia,
    } = formatTranscriptWithMediaForKernel(transcriptMessages, validated.urlGroupId);
    const promptInputs = {
      transcript: formattedTranscript,
      messageCount: keptMessageCount,
      fanSpendingData: spendingData,
      fanSubscriptionData: subscriptionData,
      // Custom-name rule (spec §4): kernel-facing name is account-lookup only.
      fanDisplayName: kernelFanName,
      replyMode: payload.replyMode ?? 'default',
      replyTone: payload.replyTone ?? 'none',
    } satisfies {
      transcript: string;
      messageCount: number;
      fanSpendingData: string;
      fanSubscriptionData: string;
      fanDisplayName: string;
      replyMode: ReplyMode;
      replyTone: ReplyTone;
    };
    if (personaIdentity && !await fenceComparePersonaIdentity(
      context,
      tabId,
      payload.operationId,
      personaIdentity,
    )) {
      context.lifecycle.forgetCancelledCompare(payload.operationId);
      return;
    }
    // Stage 32: the kernel lane needs the page label; resolve once per run.
    const creatorUsername = validated.session.resolvedUsername?.trim()
      || (await context.fanslyClient.getAuthenticatedAccount(validated.session, signal))
        .username?.trim()
      || null;
    if (personaIdentity && !await fenceComparePersonaIdentity(
      context,
      tabId,
      payload.operationId,
      personaIdentity,
    )) {
      context.lifecycle.forgetCancelledCompare(payload.operationId);
      return;
    }
    const pageLabel = await context.agencyHubClient.resolvePageLabelForUsername(
      validated.storage.settings,
      creatorUsername,
      signal,
    );
    if (personaIdentity && !await fenceComparePersonaIdentity(
      context,
      tabId,
      payload.operationId,
      personaIdentity,
    )) {
      context.lifecycle.forgetCancelledCompare(payload.operationId);
      return;
    }
    if (!pageLabel) {
      throw new ChatGooseError('hub_page_match_failed');
    }
    completeStage(
      'prompt-build',
      `Built compare context: ${compareCards.length} cards`,
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

      // Stage 32: a compare card = one kernel fast-reply generation with the
      // card's persona. Only kernel-known personas can run ('current' cards —
      // the mapped personality, kernel-synced); local draft cards died with
      // the local prompt library (the folder was already absent from shipped
      // builds — the recorded 32.1 deviation).
      if (card.source !== 'current') {
        sendCompareCardError(
          context,
          tabId,
          {
            type: 'compare:cardError',
            operationId: payload.operationId,
            cardId: card.id,
            error: toUserError(new ChatGooseError('compare_cards_unavailable')),
            llmSpend: createZeroLlmSpendSummary(),
          },
          profiler,
          buildCompareCardProfilingSnapshot(profiler),
        );
        return;
      }
      const personaKey = card.id.startsWith('current:')
        ? card.id.slice('current:'.length)
        : card.id;

      let cardUsage: KernelFeatureUsage | undefined;
      let cardSpend: LlmSpendSummary | undefined;
      let actualModel = resolvedModel;
      let latestStopReason: string | null = null;

      const streamToCard = async (): Promise<string> => {
        return context.kernelGateway.streamFeature(
          validated.storage.settings,
          {
            feature: 'fast-reply',
            clientRequestId: crypto.randomUUID(),
            pageLabel,
            conversationRef: fanAccountId ?? validated.urlGroupId,
            personaKey,
            expectedPersonaDefinitionId: personaIdentity?.personaDefinitionId,
            replyTone: promptInputs.replyTone,
            replyMode: promptInputs.replyMode,
            isRegeneration: Boolean(payload.forceRegenerate),
            clientContext: {
              transcript: promptInputs.transcript,
              messageCount: promptInputs.messageCount,
              fanDisplayName: promptInputs.fanDisplayName,
              fanSpendingData: promptInputs.fanSpendingData,
              fanSubscriptionData: promptInputs.fanSubscriptionData,
              ...(transcriptMedia !== undefined ? { media: transcriptMedia } : {}),
            },
          },
          {
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
            onMeta: (meta) => {
              actualModel = meta.model;
            },
            onUsage: (usage) => {
              cardUsage = { ...usage };
              cardSpend = buildKernelSpendSummary(usage);
              profiler.log(formatKernelUsageLog(actualModel, usage));
              logDebug(debugEnabled, 'kernel usage', {
                cardId: card.id,
                model: actualModel,
                costMicroUsd: usage.costMicroUsd,
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
          },
          signal,
        );
      };

      let rawText = '';
      try {
        if (!personaIdentity || !await fenceComparePersonaIdentity(
          context,
          tabId,
          payload.operationId,
          personaIdentity,
        )) {
          return;
        }
        rawText = await streamToCard();
      } catch (error) {
        const abortError = resolveAbortChatGooseError(error, {
          active: Boolean(getActiveCompare(context, tabId)),
          timeoutSignal: timeoutController?.signal,
          cancelSignal: controller?.signal,
        });
        if (abortError?.key === 'timed_out') {
          throw abortError;
        } else if (abortError?.key === 'chat_changed') {
          return;
        } else {
          // Stop any pending flush for this card so a buffered chunk can't fire
          // a stray compare:chunk after the card is reported as errored, while
          // other cards in the session are still streaming.
          const erroredCardState = getActiveCompare(context, tabId)?.compareCards.get(card.id);
          if (erroredCardState) {
            clearFlushTimer(erroredCardState);
          }
          const profiling = buildCompareCardProfilingSnapshot(profiler, cardUsage);
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
      if (clearFlushTimer(cardState)) {
        flushCompareChunks(context, tabId, activeCompare, card.id);
      }

      const parts = normalizeReplyParts(rawText);
      // Fail closed on a truncated card (spec §8): isOutputExhausted normalizes
      // BOTH the kernel 'max_tokens' and OpenRouter's provider 'length' stop
      // reasons — the literal 'max_tokens' check missed 'length'. A compare card
      // is a reply, so any output exhaustion makes it non-insertable.
      if (isOutputExhausted(latestStopReason) || parts.length === 0) {
        const profiling = buildCompareCardProfilingSnapshot(profiler, cardUsage);
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
      if (!personaIdentity || !await fenceComparePersonaIdentity(
        context,
        tabId,
        payload.operationId,
        personaIdentity,
      )) {
        return;
      }
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
        buildCompareCardProfilingSnapshot(profiler, cardUsage),
      );

      // A delivered compare card is an ACCEPTED generation — it burned the same
      // feature-lane quota as a fast-reply and passed the same output/persona
      // fences. Recorded here (not in the send helper) because this is the scope
      // holding all four facts. Best-effort: a counter must never break a
      // delivered card.
      void recordGeneration({
        feature: 'fast-reply',
        accountId: resolvedAccountId,
        // Empty when no human name resolved — the pane falls back to the id
        // rather than showing a fabricated label.
        accountLabel: creatorUsername ?? '',
        pageLabel,
      }).catch(() => undefined);
    };

    await Promise.all(compareCards.map((card) => runCard(card)));

    const completedActive = getActiveCompare(context, tabId);
    if (
      !completedActive ||
      completedActive.operationId !== payload.operationId
    ) {
      // The session was cancelled/superseded mid-stream: every card swallowed
      // the abort and resolved, so we never reached the catch that clears the
      // cancelled id. Drop it here to keep the set from growing unbounded.
      context.lifecycle.forgetCancelledCompare(payload.operationId);
      return;
    }

    if (personaIdentity && !await fenceComparePersonaIdentity(
      context,
      tabId,
      payload.operationId,
      personaIdentity,
    )) {
      context.lifecycle.forgetCancelledCompare(payload.operationId);
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
    if (context.lifecycle.consumeCancelledCompare(operationId)) {
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
    // Terminal failure path: cancelCompareOperation re-adds the id, but no late
    // card message remains to suppress, so drop it to avoid unbounded growth.
    context.lifecycle.forgetCancelledCompare(operationId);
  } finally {
    context.lifecycle.releaseReservation(tabId);
    timeoutController?.clearAll();
  }
}
