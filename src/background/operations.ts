import {
  DEEP_OPERATION_TIMEOUT_MS,
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
  FeatureType,
  FeatureResult,
  OperationProgressPayload,
  OperationStartPayload,
  PingSegment,
  SubscriptionLookupMode,
  RouteChangedPayload,
  TabStatePayload,
  TabUiState,
} from '../shared/types.js';
import { AnthropicClient } from './anthropic-client.js';
import { FanslyClient } from './fansly-client.js';
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
  ): void {
    this.send(tabId, { type: 'operation:progress', ...progress });
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

  private async validateStart(tabId: number, payload: OperationStartPayload) {
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
      this.send(tabId, {
        type: 'operation:discarded',
        operationId: active.operationId,
        error: toUserError(error ?? new ChatMuseError('chat_changed')),
      });
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
      this.send(tabId, {
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
    try {
      const validated = await this.validateStart(tabId, payload);
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
      };

      this.activeByTabId.set(tabId, active);
      this.tabContexts.setActiveOperation(tabId, payload.operationId);
      this.tabContexts.setRoute(
        tabId,
        validated.urlGroupId,
        payload.routeNonce,
      );
      this.sendProgress(tabId, {
        operationId: payload.operationId,
        feature: payload.feature,
        phase: 'loading-messages',
        message:
          payload.feature === 'ping' ? 'Loading messages…' : undefined,
      });
      const debugEnabled = validated.storage.settings.debugMode;

      // Resolve model account identity
      let resolvedAccountId = validated.legacyAccountId;
      let authenticatedIdentityResolved = false;
      try {
        resolvedAccountId =
          await this.fanslyClient.getAuthenticatedAccountId(
            validated.session,
            signal,
          );
        authenticatedIdentityResolved = true;
        logDebug(debugEnabled, 'account identity resolved', {
          legacyAccountId: validated.legacyAccountId,
          resolvedAccountId,
        });
      } catch (error) {
        logDebug(debugEnabled, 'account identity resolution failed', {
          legacyAccountId: validated.legacyAccountId,
          code:
            error instanceof ChatMuseError
              ? error.code
              : 'unknown_error',
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

      if (payload.feature === 'fan-summary' && payload.forceRegenerate) {
        await removeSummaryCache(validated.urlGroupId);
      }

      // Summary cache check
      const cachedSummary =
        payload.feature === 'fan-summary' && !payload.forceRegenerate
          ? await getSummaryCache(validated.urlGroupId)
          : null;
      if (
        payload.feature === 'fan-summary' &&
        cachedSummary &&
        cachedSummary.personalityId === personality.id &&
        cachedSummary.personalityUpdatedAt === personality.updatedAt &&
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
        this.send(tabId, {
          type: 'operation:complete',
          operationId: payload.operationId,
          result,
          fanDisplayName: payload.domFanDisplayName ?? 'fan',
        } satisfies CompletePayload);
        this.clearCompletedOperation(tabId);
        return;
      }

      // Load messages
      const messageLoad = await this.fanslyClient.loadMessages(
        validated.urlGroupId,
        validated.messageCount,
        validated.session,
        resolvedAccountId,
        signal,
        isDeepFeature(payload.feature)
          ? (currentPage, targetPages) => {
              this.sendProgress(tabId, {
                operationId: payload.operationId,
                feature: payload.feature,
                phase: 'loading-messages',
                currentPage,
                targetPages,
                message: `Loading messages… ${currentPage}/${targetPages} pages`,
              });
            }
          : undefined,
      );

      // Deep feature minimum check
      if (isDeepFeature(payload.feature) && messageLoad.transcriptMessages.length < MIN_MESSAGES_FOR_DEEP) {
        throw new ChatMuseError('not_enough_history');
      }

      // Ping segment analysis + active fan blocking
      let pingSegment: PingSegment | undefined;
      if (payload.feature === 'ping') {
        const pingAnalysis = analyzePingSegment(
          messageLoad.transcriptMessages,
          Date.now(),
        );
        pingSegment = pingAnalysis.segment;
        logDebug(debugEnabled, 'ping segment selected', {
          groupId: validated.urlGroupId,
          segment: pingAnalysis.segment,
          fanTextMessageCount: pingAnalysis.fanTextMessageCount,
          latestFanTextAtMs: pingAnalysis.latestFanTextAtMs,
        });

        // SPEC-CORRECT: BLOCK active fan pings
        if (pingSegment === 'active') {
          this.send(tabId, {
            type: 'operation:error',
            operationId: payload.operationId,
            error: toUserError(new ChatMuseError('ping_blocked')),
          });
          this.clearCompletedOperation(tabId);
          return;
        }
      }

      // Resolve fan identity
      let groupUsers: Array<{ userId: string }> | null = null;
      if (payload.feature !== 'ping' || authenticatedIdentityResolved) {
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
        } catch (error) {
          logDebug(debugEnabled, 'group enrichment failed', {
            groupId: validated.urlGroupId,
            code:
              error instanceof ChatMuseError
                ? error.code
                : 'unknown_error',
          });
        }
      }

      let fanAccountId: string | null = null;
      let fanDisplayName = payload.domFanDisplayName ?? 'fan';
      fanAccountId =
        groupUsers?.find(
          (user) => user.userId !== resolvedAccountId,
        )?.userId ?? null;

      if (fanAccountId) {
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
        } catch (error) {
          logDebug(debugEnabled, 'fan display name lookup failed', {
            fanAccountId,
            code:
              error instanceof ChatMuseError
                ? error.code
                : 'unknown_error',
          });
        }
      }

      this.tabContexts.setFan(tabId, fanAccountId, fanDisplayName);
      this.sendProgress(tabId, {
        operationId: payload.operationId,
        feature: payload.feature,
        phase: 'generating',
        message: 'Generating…',
      });

      // Load earnings and subscription data (fail-open)
      let spendingData = '';
      let spendingDataVerified = false;
      let subscriptionData = '';
      let subscriptionLookupVerified = false;
      const subscriptionLookupMode = resolveSubscriptionLookupMode(
        payload.feature,
      );

      if (fanAccountId) {
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
            this.fanslyClient.getFanSubscriptionContext(
              validated.urlGroupId,
              fanAccountId,
              validated.session,
              signal,
              subscriptionLookupMode,
            ),
          ]);

        if (earningsResult.status === 'fulfilled') {
          const aggregated = earningsResult.value;
          if (aggregated) {
            spendingData = formatFanSpendingData(aggregated);
            spendingDataVerified = true;
          }
        } else {
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
        } else {
          logDebug(
            debugEnabled,
            'subscription fetch failed (fail-open)',
            { fanAccountId },
          );
        }
      }

      // Build prompt
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

      // Debug prompt snapshot
      if (debugEnabled) {
        this.send(tabId, {
          type: 'operation:debugPrompt',
          operationId: payload.operationId,
          feature: payload.feature,
          snapshot: {
            feature: payload.feature,
            system: prompt.system,
            transcript: formattedTranscript,
            fanSpendingData: spendingData,
            fanSubscriptionData: subscriptionData,
            user: prompt.user,
          },
        });
      }

      // Stream from Claude
      const rawText = await this.anthropicClient.streamMessage({
        apiKey: validated.storage.settings.claudeApiKey,
        system: prompt.system,
        user: prompt.user,
        feature: payload.feature,
        signal,
        onText: (chunk) => {
          const current = this.getActive(tabId);
          if (
            !current ||
            current.operationId !== payload.operationId
          ) {
            return;
          }
          current.rawText += chunk;
          current.flushBuffer += chunk;
          this.scheduleChunkFlush(tabId, current);
        },
      });

      // Flush any remaining chunks
      const current = this.assertActive(tabId, payload.operationId);
      if (current.flushTimer !== null) {
        clearTimeout(current.flushTimer);
        this.flushChunks(tabId, current);
      }

      // Build result
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

      // Cache fan summary
      if (payload.feature === 'fan-summary') {
        const generatedAt = Date.now();
        result.summaryMeta = {
          generatedAt,
          stale: false,
          cached: false,
        };
        if (spendingDataVerified && subscriptionLookupVerified) {
          await saveSummaryCache(validated.urlGroupId, {
            summary: rawText,
            personalityId: personality.id,
            personalityUpdatedAt: personality.updatedAt,
            generatedAt,
            spendingDataVerified: true,
            subscriptionLookupVerified: true,
          });
        }
      }

      this.send(tabId, {
        type: 'operation:complete',
        operationId: payload.operationId,
        result,
        fanDisplayName,
      });

      this.clearCompletedOperation(tabId);
    } catch (error) {
      const operationId =
        this.getActive(tabId)?.operationId ?? payload.operationId;
      if (this.cancelledOperationIds.delete(operationId)) {
        return;
      }

      if (
        error instanceof DOMException &&
        error.name === 'AbortError'
      ) {
        const code = this.getActive(tabId)
          ? new ChatMuseError('timed_out')
          : new ChatMuseError('chat_changed');
        this.send(tabId, {
          type: 'operation:error',
          operationId,
          error: toUserError(code),
        });
      } else {
        this.send(tabId, {
          type: 'operation:error',
          operationId,
          error: toUserError(error),
        });
      }

      logDebug(false, 'operation error', error);
      await this.cancelOperation(tabId);
    } finally {
      if (timeout !== null) {
        clearTimeout(timeout);
      }
    }
  }
}
