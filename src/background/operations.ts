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
  FANSLY_PAGE_LIMIT,
  FANSLY_PAGINATION_DELAY_MS,
  HI_GREETING_MAX_TRANSCRIPT,
  HI_WELCOME_LOAD_TIMEOUT_MS,
  MIN_MESSAGES_FOR_DEEP,
  QUICK_OPERATION_TIMEOUT_MS,
  SHORT_SUMMARY_MESSAGE_COUNT,
  STREAM_CHUNK_FLUSH_MS,
  SUMMARY_SYNC_RETRY_COOLDOWN_MS,
} from '../shared/constants.js';
import { customNameFromAccount, kernelFanCustomName } from '../shared/fansly-custom-name.js';
import { fanslyAvatarUrl } from '../shared/followers.js';
import {
  AUTOMATED_MESSAGE_LABEL,
  buildGreetingContext,
  countPersonalMessages,
  isAutomatedGreetingMessage,
  type GreetingProfile,
  type GreetingWindowMessage,
} from '../shared/greeting-context.js';
import { isOutputExhausted } from '@kernel/sdk';
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
  featureIncludesFanBio,
  featureRequiresDraft,
  featureUsesPingSegment,
  getFeaturePolicy,
  isDeepFeature,
  resolveFeatureMessageCount,
} from '../shared/features.js';
import { logDebug } from '../shared/log.js';
import { findActivePersona, getActivePersonaCatalog } from '../shared/persona-catalog.js';
import { isContentPortMessage } from '../shared/protocol.js';
import {
  normalizeReplyParts,
  normalizeSingleReplyPart,
  normalizeVariantReplyParts,
} from '../shared/reply-output.js';
import {
  getAvailableFanSummaryModes,
  getSummaryCacheEntry,
  isValidSummaryCacheEntry,
  summaryCacheKey,
  type SummaryCacheMode,
} from '../shared/summary-cache.js';
import { formatFanSubscriptionData } from '../shared/subscriptions.js';
import {
  analyzePingSegment,
  fanSilenceDaysFromAnalysis,
  fanWritesCyrillic,
  formatTranscriptForKernel,
  normalizeTranscript,
} from '../shared/transcript.js';
import { parseChatReviewXml, parseHelpMeXml } from '../shared/xml.js';
import type {
  EarningsBreakdownEntry,
  AggregatedEarnings,
  LlmSpendSummary,
  BackgroundPortMessage,
  CompareStartPayload,
  CompletePayload,
  ContentPortMessage,
  DiscardedPayload,
  ErrorPayload,
  FanslyMessagePageResponse,
  FanSummarySyncState,
  FanSummarySyncStatus,
  FeatureType,
  FeatureResult,
  OperationPhase,
  OperationProfilingStageKey,
  OperationProgressPayload,
  OperationStartPayload,
  PingSegment,
  DebugPromptEchoStatus,
  PersistedState,
  Settings,
  SubscriptionLookupMode,
  RouteChangedPayload,
  SessionTemplate,
  SummaryCacheEntry,
  TabStatePayload,
  TabUiState,
} from '../shared/types.js';
import type {
  AgencyHubClient} from './agency-hub-client.js';
import {
  type AgencyHubPushFanProfileResult,
} from './agency-hub-client.js';
import type {
  AcceptanceEventInput,
  AcceptanceReporter,
} from './acceptance-reporter.js';
import {
  buildKernelSpendSummary,
  createZeroLlmSpendSummary,
  formatKernelUsageLog,
} from '../shared/spend.js';
import {
  type KernelFeatureAttachedRecaps,
  type KernelFeatureDebugInput,
  type KernelFeatureGateway,
  type KernelFeatureUsage,
} from './kernel-feature-gateway.js';
import { createDebugPromptStore, type DebugPromptStore } from './debug-prompt-store.js';
import { WelcomeDefinitionsService } from './welcome-definitions.js';
import { projectKernelContext } from '../shared/kernel-context.js';
import {
  cancelCompareOperation,
  executeCompare,
  type ActiveCompareOperation,
  type CompareOperationsContext,
} from './compare-operations.js';
import { loadMediaPurchaseEvidence } from './conversation-context-loader.js';
import {
  recordGeneration,
  recordHubError,
  recordSummaryPush,
} from './ops-daily.js';
import {
  CoachTranscriptCache,
  type CoachTranscriptCacheKeyParts,
  type CoachTranscriptWindow,
} from './coach-transcript-cache.js';
import type {
  MessageLoadProgress,
  SubscriptionLookupTraceEvent,
} from './fansly-client.js';
import type { FanslyClient } from './fansly-client.js';
import { clearFlushTimer } from './operation-cleanup.js';
import {
  createOperationProfiler,
  type OperationProfiler,
} from './operation-profiling.js';
import { OperationRegistry } from './operation-registry.js';
import { OperationTimeoutController } from './operation-timeouts.js';
import {
  isFreshPersonaOperationIdentityCurrent,
  isPersonaOperationIdentityCurrent,
  readFreshPersonaFenceState,
  type PersonaOperationIdentity,
} from './persona-identity-fence.js';
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
  summaryCommitToken: number | null;
}

const NO_OP_PROFILER = createOperationProfiler(false);
/** Stage 32: models are kernel config — the summary-cache model pin. */
const KERNEL_MODEL_ID = 'kernel';
const CAPTURE_IDENTITY_TIMEOUT_MS = 5_000;
/** Invalidation strength of tab-state message types (see refreshTabState):
 * 'settings:changed' carries board/source invalidation the state payload
 * cannot express, 'mapping:changed' is the narrow persona/mapping signal. */
const TAB_STATE_TYPE_PRIORITY: Record<TabStatePayload['type'], number> = {
  'tab:state': 0,
  'mapping:changed': 1,
  'settings:changed': 2,
};
const CAPTURE_IDENTITY_RETRY_COOLDOWN_MS = 30_000;
const DEEP_OPERATION_TIMEOUTS = {
  prep: DEEP_OPERATION_PREP_TIMEOUT_MS,
  llmTtfb: DEEP_OPERATION_LLM_TTFB_TIMEOUT_MS,
  llmIdle: DEEP_OPERATION_LLM_IDLE_TIMEOUT_MS,
  llmMaxStream: DEEP_OPERATION_LLM_MAX_STREAM_TIMEOUT_MS,
} as const;
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




function buildLlmSpendPayload(
  llmSpend?: LlmSpendSummary,
): { llmSpend: LlmSpendSummary } | object {
  return llmSpend ? { llmSpend } : {};
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
  personaIdentity: PersonaOperationIdentity;
  /** Generated summaries with incomplete enrichment are intentionally not
   * cached, but still retain the persona fence before their existing Hub push. */
  requireCachedEntry: boolean;
  operationId?: string;
  summaryCommitToken?: number;
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

function usesDeepOperationTimeouts(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).timeoutBucket === 'deep';
}

/** A deep-timeout feature whose PREP stage is capped at the quick budget (coach:
 * a small quick window ⇒ no 360s prep budget, while its STREAM stays deep). */
function usesQuickPrepBudget(feature: FeatureType): boolean {
  return getFeaturePolicy(feature).prepTimeoutBucket === 'quick';
}

/**
 * Canonical vs legacy conversation identity (spec §5). Coach + fan-summary send
 * `conversationRef = groupId` + `fanRef = fanAccountId` once the fan is
 * resolved. Both generation paths fail before this builder when the fan is
 * unresolved, so they never ship a canonical groupId without a fanRef. Every
 * other feature keeps the legacy shape (`conversationRef = fanAccountId ??
 * groupId`, no fanRef) unchanged this phase.
 */
function buildConversationRefs(
  feature: FeatureType,
  fanAccountId: string | null,
  groupId: string,
): { conversationRef: string; fanRef?: string } {
  const usesCanonicalRefs = feature === 'coach-chat' || feature === 'fan-summary';
  if (usesCanonicalRefs && fanAccountId) {
    return { conversationRef: groupId, fanRef: fanAccountId };
  }
  return { conversationRef: fanAccountId ?? groupId };
}

/**
 * Kernel-facing fan display name: ONLY the Fansly account lookup (username →
 * displayName), falling back to a neutral "fan" when the lookup fails. The DOM
 * label is never used for it: it is ambiguous (platform name or the chatter's
 * rename) and stays a local UI label. The chatter's saved name itself DOES
 * reach the kernel since E115, but through its own field
 * (`clientContext.fanCustomName`, read from the same account lookup), never
 * through this one. Applies to every feature.
 */
function kernelFanDisplayName(
  account: { username?: string | null; displayName?: string | null } | undefined,
): string {
  return account?.username?.trim() || account?.displayName?.trim() || 'fan';
}

export function buildFeatureResult(
  feature: FeatureType,
  rawText: string,
  replyMode?: OperationStartPayload['replyMode'],
): FeatureResult {
  switch (getFeaturePolicy(feature).resultKind) {
    case 'help-me':
      return { rawText, helpMe: parseHelpMeXml(rawText) };
    case 'chat-review':
      return { rawText, chatReview: parseChatReviewXml(rawText) };
    // Coach streams free-form advice; the raw text is the result — no XML
    // sections, no reply-part splitting. Draft cards (if any) arrive on the
    // wire via result.parts, handled by the overlay, not synthesized here.
    case 'coach-chat':
      return { rawText };
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
  /** Monotonic per-tab refresh generation — only the newest refresh posts. */
  private readonly tabStateGenerationByTabId = new Map<number, number>();
  /** Strongest message type pending while refreshes coalesce. The TYPE carries
   * invalidation semantics the state payload does not (review P1:
   * 'settings:changed' is the only signal that invalidates the Spenders board
   * on a Hub source switch — TabUiState has no source fingerprint), so a
   * superseded refresh must escalate the survivor's type, never lose it. */
  private readonly pendingTabStateTypeByTabId = new Map<number, TabStatePayload['type']>();
  private readonly lifecycle =
    new OperationRegistry<ActiveOperation, ActiveCompareOperation>();
  /** Hub-sync retry bookkeeping, keyed `groupId|generatedAt|baseUrl` — a new
   * Scan (new generatedAt) or a hub retarget gets a fresh key. Entries clear
   * once saved; failures wait out SUMMARY_SYNC_RETRY_COOLDOWN_MS. */
  private readonly summarySyncRetryByKey = new Map<
    string,
    { inFlight: boolean; nextAttemptAt: number }
  >();
  private readonly pendingIdentityResolutionByLegacyAccountId = new Map<
    string,
    {
      promise: Promise<void>;
      waitingTabIds: Set<number>;
    }
  >();
  private readonly captureIdentityRetryAfterByLegacyAccountId = new Map<string, number>();
  private summaryCommitSequence = 0;
  /** Voice transport stays outside this coordinator. This callback exists
   * only because TabUiState is assembled here. */
  private voiceCapabilityResolver: ((tabId: number) => Promise<boolean>) | null = null;
  /** Latest user-started Scan for each conversation AND recap size. Kept after
   * completion so an async full Hub append cannot be overtaken by an older
   * cross-tab full operation, while an independent short recap cannot fence it. */
  private readonly latestSummaryCommitByKey = new Map<
    string,
    { operationId: string; token: number }
  >();
  /** Coach transcript session cache (spec §6): overlap-and-replace so a rolling
   * coach dialog refreshes only the newest tail each turn instead of paginating
   * the whole quick window. In-memory, LRU 5, keyed per content coach session. */
  private readonly coachTranscriptCache = new CoachTranscriptCache();

  constructor(
    private readonly sessionStore: SessionStore,
    private readonly tabContexts: TabContextStore,
    private readonly fanslyClient: FanslyClient,
    private readonly kernelGateway: KernelFeatureGateway,
    private readonly storageCoordinator: StorageCoordinator,
    private readonly agencyHubClient: AgencyHubClient,
    private readonly acceptance?: Pick<AcceptanceReporter, 'enqueue'>,
    /** E28 prompt-echo custody; shared with the runtime API, which serves the
     * viewer page. In-memory by construction — see debug-prompt-store.ts. */
    readonly debugPrompts: DebugPromptStore = createDebugPromptStore(),
    /** Welcome definitions for the Hi automation labels. The composition root
     * passes the instance the New Followers window uses, so the 24 h cache and
     * the one-read-per-creator rule are shared. */
    private readonly welcomeDefinitions: WelcomeDefinitionsService =
      new WelcomeDefinitionsService({ fansly: fanslyClient, storage: browser.storage.local }),
  ) {}

  setVoiceCapabilityResolver(resolver: (tabId: number) => Promise<boolean>): void {
    this.voiceCapabilityResolver = resolver;
  }

  /** Correlation for post-settle copy/insert signals (bounded, newest-wins). */
  private readonly acceptanceContexts = new Map<string, Omit<AcceptanceEventInput, 'action' | 'at'>>();

  private rememberAcceptanceContext(
    operationId: string,
    context: Omit<AcceptanceEventInput, 'action' | 'at'>,
  ): void {
    this.acceptanceContexts.set(operationId, context);
    if (this.acceptanceContexts.size > 50) {
      const oldest = this.acceptanceContexts.keys().next().value;
      if (oldest !== undefined) {
        this.acceptanceContexts.delete(oldest);
      }
    }
  }

  private get activeByTabId(): Map<number, ActiveOperation> {
    return this.lifecycle.featureOperations;
  }

  private get activeCompareByTabId(): Map<number, ActiveCompareOperation> {
    return this.lifecycle.compareOperations;
  }

  private get cancelledOperationIds(): Set<string> {
    return this.lifecycle.cancelledFeatureIds;
  }

  private get cancelledCompareOperationIds(): Set<string> {
    return this.lifecycle.cancelledCompareIds;
  }

  private get startingTabIds(): Set<number> {
    return this.lifecycle.reservations;
  }

  registerPort(port: browser.runtime.Port): void {
    const tabId = port.sender?.tab?.id;
    if (!tabId) {
      return;
    }

    this.portsByTabId.set(tabId, port);
    port.onMessage.addListener((message) => {
      if (isContentPortMessage(message)) {
        void this.handlePortMessage(tabId, message);
      }
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
    // Newest-wins: buildTabUiState awaits a capability probe that can take
    // seconds, so two overlapping refreshes could post out of order and let a
    // STALE snapshot (old accountId/persona) overwrite a newer one in the
    // content script. Only the most recently started refresh may post — but
    // the strongest pending message TYPE always survives the coalescing.
    const pendingType = this.pendingTabStateTypeByTabId.get(tabId);
    this.pendingTabStateTypeByTabId.set(
      tabId,
      pendingType && TAB_STATE_TYPE_PRIORITY[pendingType] > TAB_STATE_TYPE_PRIORITY[messageType]
        ? pendingType
        : messageType,
    );
    const generation = (this.tabStateGenerationByTabId.get(tabId) ?? 0) + 1;
    this.tabStateGenerationByTabId.set(tabId, generation);
    const state = await this.buildTabUiState(tabId);
    if (this.tabStateGenerationByTabId.get(tabId) !== generation) {
      // The pending type stays: the newer in-flight refresh posts it.
      return;
    }
    const postType = this.pendingTabStateTypeByTabId.get(tabId) ?? messageType;
    this.pendingTabStateTypeByTabId.delete(tabId);
    port.postMessage({
      type: postType,
      state,
    } satisfies TabStatePayload);
    if (state.availableRecaps?.full ?? state.hasAvailableSummary) {
      // Core #136: the kernel injects the HUB copy of a ready Scan into other
      // features' prompts — so an unsaved local summary gets an opportunistic
      // re-push here, not only when the chatter reopens Scan.
      void this.retrySummaryHubSync(tabId);
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

  async handleCapture(
    tabId: number,
    accountId: string,
    material = true,
  ): Promise<void> {
    const session = this.sessionStore.getSessionByAccount(accountId);
    // Canonical-preferred: captures fire on every Fansly request, and writing
    // the raw legacy id here made TabContext.accountId oscillate against the
    // canonical resolved id the UI state and voice bindings carry (false
    // invalid_sender / route-mismatch rejections while traffic was flowing).
    this.tabContexts.setAccount(tabId, session?.resolvedAccountId ?? accountId);
    let shouldResolveIdentity = false;
    if (session?.resolvedAccountId) {
      this.captureIdentityRetryAfterByLegacyAccountId.delete(accountId);
    } else {
      const now = Date.now();
      const retryAfter = this.captureIdentityRetryAfterByLegacyAccountId.get(accountId) ?? 0;
      if (material || retryAfter <= now) {
        this.captureIdentityRetryAfterByLegacyAccountId.set(
          accountId,
          now + CAPTURE_IDENTITY_RETRY_COOLDOWN_MS,
        );
        shouldResolveIdentity = true;
      }
    }
    if (material) {
      try {
        await this.refreshTabState(tabId);
      } finally {
        // Identity recovery is independent of UI refresh/storage side effects:
        // one transient failure must be retried by later same-session traffic.
        if (shouldResolveIdentity) {
          void this.resolveCapturedIdentity(tabId, accountId);
        }
      }
    } else if (shouldResolveIdentity) {
      void this.resolveCapturedIdentity(tabId, accountId);
    }
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
        // Canonical-preferred (falls back to the legacy capture id, then to
        // the raw per-tab capture record) — same oscillation guard as
        // handleCapture.
        this.tabContexts.setAccount(
          tabId,
          this.sessionStore.getDisplayAccountIdForTab(tabId) ??
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
      case 'operation:acceptance': {
        const context = this.acceptanceContexts.get(message.operationId);
        if (context && this.acceptance) {
          this.acceptance.enqueue({
            ...context,
            // Prefer the live context's ref; fall back to the client-carried one.
            requestId: context.requestId ?? message.generationRef ?? null,
            action: message.action,
            at: new Date().toISOString(),
          });
        } else if (message.generationRef && this.acceptance) {
          // The in-memory op→ref context is gone (SW restart / 50-entry eviction),
          // but the coach feed still holds the generation ref, so correlate via it
          // (P2). pageLabel is not cheaply recoverable here (a Hub round-trip); the
          // kernel matches by generationRef, so a degraded pageLabel is acceptable.
          const ctx = this.tabContexts.get(tabId);
          this.acceptance.enqueue({
            operationId: message.operationId,
            requestId: message.generationRef,
            feature: 'coach-chat',
            pageLabel: '',
            conversationRef: ctx?.groupId ?? '',
            action: message.action,
            at: new Date().toISOString(),
          });
        }
        break;
      }
      case 'operation:cancel': {
        const active = this.lifecycle.getFeature(tabId);
        if (active && active.operationId === message.operationId) {
          await this.cancelOperation(tabId);
        }
        break;
      }
      case 'compare:cancel': {
        const active = this.lifecycle.getCompare(tabId);
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
        this.captureIdentityRetryAfterByLegacyAccountId.delete(legacyAccountId);
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
    if (changed && this.lifecycle.hasActiveCompare(tabId)) {
      this.cancelCompare(tabId, new ChatGooseError('chat_changed'), true);
    }
    await this.refreshTabState(tabId, 'tab:state');
  }

  private async buildTabUiState(tabId: number): Promise<TabUiState> {
    const storage = await this.storageCoordinator.getState();
    const context = this.tabContexts.getOrCreate(tabId);
    // The capability probe runs FIRST: it may resolve the session's canonical
    // identity as a side effect (resolvePageForTab → getAuthenticatedAccount),
    // and reading the session before it meant the returned state could carry
    // the legacy id even though the session had just learned the canonical one.
    // The injected resolver is budgeted (composition root), so a cold probe no
    // longer holds first paint; when it loses the race it re-pushes tab state
    // afterwards, which is how the identity correction still lands.
    // Voice is conversation-bound. A global Fansly tab has no attach route,
    // so probing page identity/capability here only delays shell state and can
    // wake the kernel path for a toolbar that is not mounted.
    const voiceNotesCapable = context.groupId
      ? await this.voiceCapabilityResolver?.(tabId) ?? false
      : false;
    const session = this.sessionStore.getSessionForTab(tabId);
    const legacyAccountId =
      this.sessionStore.getAccountIdForTab(tabId) ?? context.accountId;
    const accountId = session?.resolvedAccountId ?? legacyAccountId;
    this.tabContexts.setAccount(tabId, accountId);
    // Both ids of THIS session, so content can tell the budgeted-probe
    // legacy→canonical refinement from a real account switch (see
    // TabUiState.accountIdAliases).
    const accountIdAliases = [legacyAccountId, session?.resolvedAccountId ?? null]
      .filter((id): id is string => Boolean(id));

    const rawMappedPersonalityId = resolveMappedPersonalityId(
      storage.accountMappings,
      accountId,
      legacyAccountId,
      storage.accountAliases,
    );
    const mappedPersonality = findActivePersona(
      storage.personaCatalog,
      rawMappedPersonalityId,
    );
    const mappedPersonalityId = mappedPersonality?.key ?? null;
    const mappedPersonalityName = mappedPersonality?.displayName ?? null;
    const mappedPersonaVersion = mappedPersonality?.version ?? null;
    const mappedPersonaDefinitionId = mappedPersonality?.definitionId ?? null;
    const mappedPersonaSource = mappedPersonality
      ? storage.personaCatalogSource
      : null;
    const compareDraftCount = getCompareDraftCount();
    const availableRecaps = getAvailableFanSummaryModes(
      storage,
      context.groupId,
      mappedPersonalityId,
    );

    return {
      tabId,
      accountId,
      accountIdAliases,
      groupId: context.groupId,
      hasAvailableSummary: availableRecaps.full || availableRecaps.short,
      availableRecaps,
      connected: Boolean(session?.connected),
      // Stage 32: readiness = kernel lane configured (hub transport up).
      hasApiKey: this.kernelGateway.isConfigured(storage.settings),
      signedIn: storage.settings.agencyHubDeviceToken.trim().length > 0,
      voiceNotesCapable,
      showToolbarHints: storage.settings.showToolbarHints,
      hasPersonalities: getActivePersonaCatalog(storage.personaCatalog).length > 0,
      mappedPersonalityId,
      mappedPersonalityName,
      mappedPersonaVersion,
      mappedPersonaDefinitionId,
      mappedPersonaSource,
      compareCardCount: compareDraftCount + (mappedPersonalityId ? 1 : 0),
      compareDraftCount,
    };
  }

  /** Re-push a valid-but-unsaved cached summary to the hub. Bounded: dedup
   * while an attempt is in flight, cooldown after a failure, key cleared once
   * the hub confirms the save. The push is NOT blind — a preflight read of
   * the hub's current profile resolves the ambiguous cases first: an
   * identical body just gets its saved status recorded (lost ack), and a
   * hub profile that is not older than ours is never superseded by a stale
   * local re-push (another device may have re-scanned). */
  private async retrySummaryHubSync(tabId: number): Promise<void> {
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
    const cached = await this.storageCoordinator.getSummaryCache(groupId);
    if (!cached) {
      return;
    }
    // Round-9 P1: never re-push an UNTRUSTED cached recap to the Hub. A recap
    // cached before fan-summary was exhaustion-guarded (possibly truncated) lacks
    // `trustedTerminal`; trustedTerminal already makes it a local cache MISS, but
    // this opportunistic re-push must ALSO refuse it so a stale/truncated body is
    // never (re)written to the fan_profiles dossier the kernel injects into other
    // prompts. It self-heals only via a fresh trusted regeneration, whose own
    // sync path overwrites the Hub copy. (The caller already gates on the exact
    // full slot — a short-only recap must not enter the dossier-sync path — and
    // this is the explicit local invariant after a cache-swap race.)
    if (cached.trustedTerminal !== true) {
      return;
    }
    const baseUrl = normalizeAgencyHubBaseUrl(storage.settings.agencyHubBaseUrl);
    if (!baseUrl) {
      return;
    }
    const existingSync = normalizeAgencyHubSummarySyncMetadata(cached.agencyHubSync);
    if (isAgencyHubSummarySavedForBaseUrl(existingSync, baseUrl, cached.generatedAt)) {
      return;
    }
    if (!shouldAttemptAgencyHubSummarySync(this.agencyHubClient, storage.settings, cached.summary)) {
      return;
    }
    const legacyAccountId =
      this.sessionStore.getAccountIdForTab(tabId) ?? context.accountId;
    const resolvedAccountId = session.resolvedAccountId ?? legacyAccountId;
    if (!resolvedAccountId) {
      return;
    }
    const mappedPersonaKey = resolveMappedPersonalityId(
      storage.accountMappings,
      resolvedAccountId,
      legacyAccountId,
      storage.accountAliases,
    );
    const mappedPersona = findActivePersona(storage.personaCatalog, mappedPersonaKey);
    if (
      !mappedPersona ||
      cached.personalityId !== mappedPersona.key ||
      cached.personaDefinitionId !== mappedPersona.definitionId ||
      cached.personaCatalogSource !== storage.personaCatalogSource
    ) {
      return;
    }
    const syncTask: AgencyHubSummarySyncTask = {
      tabId,
      groupId,
      settings: storage.settings,
      summary: cached.summary,
      generatedAt: cached.generatedAt,
      existingSync: cached.agencyHubSync,
      fanAccountId: cached.fanAccountId ?? null,
      session,
      resolvedAccountId,
      debugEnabled: storage.settings.debugMode,
      personaIdentity: {
        resolvedAccountId,
        legacyAccountId,
        personaKey: mappedPersona.key,
        personaVersion: mappedPersona.version,
        personaDefinitionId: mappedPersona.definitionId,
        personaCatalogSource: storage.personaCatalogSource,
      },
      requireCachedEntry: true,
      summaryCommitToken:
        this.latestSummaryCommitByKey.get(this.summaryCommitKey(groupId, 'full'))?.token ?? 0,
    };

    const key = [groupId, cached.generatedAt, baseUrl].join('|');
    const now = Date.now();
    const entry = this.summarySyncRetryByKey.get(key);
    if (entry && (entry.inFlight || now < entry.nextAttemptAt)) {
      return;
    }
    this.summarySyncRetryByKey.set(key, {
      inFlight: true,
      nextAttemptAt: now + SUMMARY_SYNC_RETRY_COOLDOWN_MS,
    });

    try {
      // buildTabUiState may have observed the old mapping while the committed
      // storage change event is still queued. Fence before even reading Hub.
      if (!await this.isSummarySyncTaskCurrent(syncTask)) {
        return;
      }
      const preflight = await this.preflightSummaryHubState(
        groupId,
        storage.settings,
        session,
        cached.summary,
        cached.generatedAt,
      );
      if (preflight.verdict === 'already-stored') {
        if (!await this.isSummarySyncTaskCurrent(syncTask)) {
          return;
        }
        // The hub already holds this exact dossier (a previous push whose ack
        // was lost) — record the save, never append a duplicate version.
        const syncStatus = createFanSummarySyncStatus('saved', cached.generatedAt, {
          baseUrl: preflight.baseUrl ?? baseUrl,
          pageLabel: preflight.pageLabel ?? null,
          syncedAt: Date.now(),
          updatedAt: Date.now(),
        });
        const persisted = await this.persistSummarySyncStatus(
          groupId,
          cached.generatedAt,
          syncStatus,
          cached.fanAccountId ?? null,
          syncTask,
        );
        if (persisted && await this.isSummarySyncTaskCurrent(syncTask)) {
          this.sendSummarySyncStatus(tabId, groupId, syncStatus);
        }
        this.summarySyncRetryByKey.delete(key);
        return;
      }
      if (preflight.verdict === 'hub-newer') {
        // The hub holds a DIFFERENT dossier that is not older than ours —
        // another device re-scanned. Never supersede it with a stale body;
        // park the key for this service-worker lifetime.
        const parked = this.summarySyncRetryByKey.get(key);
        if (parked) {
          parked.nextAttemptAt = Number.MAX_SAFE_INTEGER;
        }
        return;
      }
      if (preflight.verdict === 'inconclusive') {
        // The hub state is unknown (fetch failed/skipped) — do not push
        // blind; the cooldown already set governs the next attempt.
        return;
      }

      await this.syncAgencyHubSummary(syncTask);
    } finally {
      const current = this.summarySyncRetryByKey.get(key);
      if (current) {
        current.inFlight = false;
      }
      const after = await this.storageCoordinator.getSummaryCache(groupId);
      const afterSync = normalizeAgencyHubSummarySyncMetadata(after?.agencyHubSync);
      if (isAgencyHubSummarySavedForBaseUrl(afterSync, baseUrl, cached.generatedAt)) {
        this.summarySyncRetryByKey.delete(key);
      }
    }
  }

  /** Read the hub's current profile for the conversation and classify it
   * against the local cached summary. 'push' = hub is empty or holds a
   * STRICTLY older dossier (source generation time preferred, append time
   * fallback) — safe to append ours. */
  private async preflightSummaryHubState(
    groupId: string,
    settings: Settings,
    session: SessionTemplate,
    localSummary: string,
    localGeneratedAt: number,
  ): Promise<{
    verdict: 'push' | 'already-stored' | 'hub-newer' | 'inconclusive';
    baseUrl?: string | null;
    pageLabel?: string | null;
  }> {
    const timeoutController = new AbortController();
    const timeoutHandle = globalThis.setTimeout(
      () => timeoutController.abort(),
      AGENCY_HUB_PREFETCH_TIMEOUT_MS,
    );
    try {
      const pageUsername = await this.resolveCreatorUsername(
        session,
        timeoutController.signal,
      );
      const hub = await this.agencyHubClient.fetchFanProfileByConversation({
        settings,
        pageUsername,
        conversationId: groupId,
        signal: timeoutController.signal,
      });
      if (hub.status === 'not-found') {
        return { verdict: 'push', baseUrl: hub.baseUrl, pageLabel: hub.pageLabel ?? null };
      }
      if (hub.status !== 'fetched') {
        return { verdict: 'inconclusive' };
      }
      if ((hub.body ?? '') === localSummary.trim()) {
        return {
          verdict: 'already-stored',
          baseUrl: hub.baseUrl,
          pageLabel: hub.pageLabel ?? null,
        };
      }
      const hubGeneratedAtMs = hub.sourceGeneratedAtMs ?? hub.createdAtMs;
      if (hubGeneratedAtMs !== undefined && hubGeneratedAtMs >= localGeneratedAt) {
        return { verdict: 'hub-newer' };
      }
      return { verdict: 'push', baseUrl: hub.baseUrl, pageLabel: hub.pageLabel ?? null };
    } catch {
      return { verdict: 'inconclusive' };
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  private send(tabId: number, message: BackgroundPortMessage): void {
    this.portsByTabId.get(tabId)?.postMessage(message);
  }

  /** Push a message to a tab's content port — used by the runtime API for
   * board-build progress (the board rides a one-shot runtime request, so it
   * has no channel of its own). No-op when that tab has no live port. */
  sendToTab(tabId: number, message: BackgroundPortMessage): void {
    this.send(tabId, message);
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

    // Stage 32: AI rides the kernel feature lane — configured = hub transport
    // up (device token or legacy key). Vendor keys are gone.
    if (!this.kernelGateway.isConfigured(storage.settings)) {
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
    const active = this.lifecycle.cancelFeature(tabId, clearFlushTimer);
    if (!active) {
      return;
    }

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
    const active = this.lifecycle.completeFeature(tabId, clearFlushTimer);
    if (!active) {
      return;
    }

    this.tabContexts.setActiveOperation(tabId, null);
  }

  private getActive(tabId: number): ActiveOperation | null {
    return this.lifecycle.getFeature(tabId);
  }

  private async assertPersonaIdentityCurrent(
    identity: PersonaOperationIdentity,
  ): Promise<void> {
    if (!await isFreshPersonaOperationIdentityCurrent(identity)) {
      throw new ChatGooseError('chat_changed');
    }
  }

  private reserveSummaryCommitToken(): number {
    this.summaryCommitSequence += 1;
    return this.summaryCommitSequence;
  }

  private summaryCommitKey(groupId: string, mode: SummaryCacheMode): string {
    return `${groupId}|${mode}`;
  }

  private registerSummaryCommit(
    groupId: string,
    mode: SummaryCacheMode,
    operationId: string,
    token: number,
  ): void {
    const key = this.summaryCommitKey(groupId, mode);
    const current = this.latestSummaryCommitByKey.get(key);
    if (current && current.token > token) {
      return;
    }
    this.latestSummaryCommitByKey.delete(key);
    this.latestSummaryCommitByKey.set(key, { operationId, token });
    // This map is a correctness fence, not a result cache: a Scan may still be
    // finishing its durable write or Hub append long after another group was
    // opened. An arbitrary LRU cap cannot know which token is still pending and
    // may turn a valid completion into a false stale result. Service-worker
    // lifetime bounds the map, and repeated work for one group replaces its row.
  }

  private isLatestSummaryCommit(
    groupId: string,
    mode: SummaryCacheMode,
    operationId: string | undefined,
    token: number | undefined,
  ): boolean {
    if (token === undefined) {
      return true;
    }
    const latest = this.latestSummaryCommitByKey.get(this.summaryCommitKey(groupId, mode));
    const latestToken = latest?.token ?? 0;
    return latestToken === token &&
      (operationId === undefined || latest?.operationId === operationId);
  }

  private assertLatestSummaryCommit(
    groupId: string,
    mode: SummaryCacheMode,
    operationId: string,
    token: number,
  ): void {
    if (!this.isLatestSummaryCommit(groupId, mode, operationId, token)) {
      throw new ChatGooseError('chat_changed');
    }
  }

  private async isSummarySyncTaskCurrent(
    task: AgencyHubSummarySyncTask,
  ): Promise<boolean> {
    if (!this.isLatestSummaryCommit(
      task.groupId,
      'full',
      task.operationId,
      task.summaryCommitToken,
    )) {
      return false;
    }
    const state = await readFreshPersonaFenceState({
      summaryKeys: [summaryCacheKey(task.groupId)],
    });
    if (!isPersonaOperationIdentityCurrent(state, task.personaIdentity)) {
      return false;
    }
    if (!task.requireCachedEntry) {
      return true;
    }

    const cached = getSummaryCacheEntry(state, task.groupId);
    return cached?.generatedAt === task.generatedAt &&
      cached.summary === task.summary &&
      cached.personalityId === task.personaIdentity.personaKey &&
      cached.personaDefinitionId === task.personaIdentity.personaDefinitionId &&
      cached.personaCatalogSource === task.personaIdentity.personaCatalogSource;
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
    expected?: Pick<
      AgencyHubSummarySyncTask,
      'summary' | 'personaIdentity'
    >,
  ): Promise<boolean> {
    let updated = false;
    await this.storageCoordinator.updateSummaryCache(groupId, (entry) => {
      if (
        entry.generatedAt !== generatedAt ||
        (expected && (
          entry.summary !== expected.summary ||
          entry.personalityId !== expected.personaIdentity.personaKey ||
          entry.personaDefinitionId !== expected.personaIdentity.personaDefinitionId ||
          entry.personaCatalogSource !== expected.personaIdentity.personaCatalogSource
        ))
      ) {
        return entry;
      }

      updated = true;
      return {
        ...entry,
        ...(fanAccountId?.trim() ? { fanAccountId: fanAccountId.trim() } : {}),
        agencyHubSync: syncStatus,
      };
    });
    return updated;
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

      // All resolution above can await long enough for an owner revision or a
      // local remap to commit before storage.onChanged/cancel reaches the tab.
      // Read storage directly immediately before the irreversible Hub append.
      if (!await this.isSummarySyncTaskCurrent(task)) {
        return;
      }

      const result = await this.agencyHubClient.pushFanProfile({
        settings: task.settings,
        pageUsername,
        platformUserId: resolvedFanAccountId,
        body: task.summary,
        signal: timeoutController.signal,
        existingSync: task.existingSync,
        generatedAt: task.generatedAt,
        beforeCommit: () => this.isSummarySyncTaskCurrent(task),
      });

      logDebug(task.debugEnabled, 'agency hub summary sync', {
        status: result.status,
        reason: result.reason,
        baseUrl: result.baseUrl,
        pageLabel: result.pageLabel,
        error: result.error,
      });
      // «Fan Summary — последний пуш» means a push that LANDED. A skip (no hub
      // configured) or a failure is not a push, and 'already-synced' wrote
      // nothing new this time — none of them may set the timestamp.
      if (result.status === 'pushed') {
        // An unresolved creator username records as '' — the pane then omits
        // the account, rather than inventing one.
        void recordSummaryPush(pageUsername ?? '').catch(() => undefined);
      }
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

    // Do not stamp or announce a stale cache entry if the identity changed
    // while the remote request was in flight. The append cannot be retracted,
    // but all later local state remains scoped to the current persona.
    if (!await this.isSummarySyncTaskCurrent(task)) {
      return;
    }

    const persisted = await this.persistSummarySyncStatus(
      task.groupId,
      task.generatedAt,
      syncStatus,
      resolvedFanAccountId,
      task,
    );
    if (persisted || !task.requireCachedEntry) {
      this.sendSummarySyncStatus(task.tabId, task.groupId, syncStatus);
    }
  }

  private assertActive(
    tabId: number,
    operationId: string,
  ): ActiveOperation {
    const active = this.lifecycle.getFeature(tabId);
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
    if (this.lifecycle.isBusy(tabId)) {
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

    // Reserve the tab synchronously before the first await so a racing start
    // cannot slip past the guard while validateStart is in flight.
    if (!this.lifecycle.reserve(tabId)) {
      this.sendError(tabId, {
        type: 'operation:error',
        operationId: payload.operationId,
        error: toUserError(new ChatGooseError('another_operation')),
      });
      return;
    }
    // Preserve user-arrival order across tabs before validateStart's first
    // await. Register immediately so a newer click also fences old async Hub
    // work while its own validation is pending; an older slow validation can
    // never obtain a newer token and supersede that click.
    // A cached-only view never writes a recap, so it must not take commit
    // ownership from a paid generation running in another tab. Generating and
    // cache-serving recap operations retain the existing newest-writer fence.
    const reservedSummaryCommitMode: SummaryCacheMode | null =
      payload.feature === 'fan-summary' && payload.viewCachedOnly !== true
      ? (payload.summaryMode === 'short' ? 'short' : 'full')
      : null;
    const reservedSummaryCommitToken = reservedSummaryCommitMode !== null
      ? this.reserveSummaryCommitToken()
      : null;
    if (
      reservedSummaryCommitToken !== null &&
      reservedSummaryCommitMode !== null &&
      payload.groupId
    ) {
      this.registerSummaryCommit(
        payload.groupId,
        reservedSummaryCommitMode,
        payload.operationId,
        reservedSummaryCommitToken,
      );
    }
    // P1-1: capture the tab's route identity BEFORE validateStart's awaits. A
    // route-change to another chat during those awaits advances the context but
    // only cancels an ACTIVE op — this reserved-but-not-yet-active start survives,
    // and its setRoute below would roll the context back onto the abandoned chat
    // (then its setFan would pass the same-group guard). validateStart's own URL
    // check misses this because the tab.url can still lag the routeChanged message.
    const startRouteNonce = this.tabContexts.getOrCreate(tabId).routeNonce;
    let timeoutController: OperationTimeoutController<OperationTimeoutKey> | null = null;
    let controller: AbortController | null = null;
    let debugEnabled = false;
    try {
      const validated = await this.validateStart(tabId, payload);
      // Stale start: the route advanced while we validated. Die with chat_changed
      // and never re-touch the tab context (no setRoute/activate/setFan).
      if (this.tabContexts.getOrCreate(tabId).routeNonce !== startRouteNonce) {
        throw new ChatGooseError('chat_changed');
      }
      debugEnabled = validated.storage.settings.debugMode;
      const profiler = createOperationProfiler(debugEnabled);
      const operationTimeoutController = new OperationTimeoutController<OperationTimeoutKey>();
      timeoutController = operationTimeoutController;
      const startLlmTtfbTimeout = (): void => {
        if (!usesDeepOperationTimeouts(payload.feature)) {
          return;
        }
        operationTimeoutController.clear('deep-prep');
        operationTimeoutController.arm('llm-ttfb', DEEP_OPERATION_TIMEOUTS.llmTtfb);
      };
      const startLlmStreamTimeouts = (): void => {
        if (!usesDeepOperationTimeouts(payload.feature)) {
          return;
        }
        operationTimeoutController.clear('llm-ttfb');
        operationTimeoutController.arm('llm-idle', DEEP_OPERATION_TIMEOUTS.llmIdle);
        operationTimeoutController.arm(
          'llm-max-stream',
          DEEP_OPERATION_TIMEOUTS.llmMaxStream,
        );
      };
      const resetLlmIdleTimeout = (): void => {
        if (!usesDeepOperationTimeouts(payload.feature)) {
          return;
        }
        operationTimeoutController.arm('llm-idle', DEEP_OPERATION_TIMEOUTS.llmIdle);
      };
      const clearLlmTimeouts = (): void => {
        operationTimeoutController.clear('llm-ttfb');
        operationTimeoutController.clear('llm-idle');
        operationTimeoutController.clear('llm-max-stream');
      };
      if (usesDeepOperationTimeouts(payload.feature)) {
        // The PREP budget is split from the STREAM budget (P2-6): coach paginates a
        // small quick window, so it gets the quick prep ceiling even though its
        // stream timeouts below stay deep. deep-prep is cleared on stream start.
        const prepBudget = usesQuickPrepBudget(payload.feature)
          ? QUICK_OPERATION_TIMEOUT_MS
          : DEEP_OPERATION_TIMEOUTS.prep;
        operationTimeoutController.arm('deep-prep', prepBudget);
      } else {
        operationTimeoutController.arm('quick-total', QUICK_OPERATION_TIMEOUT_MS);
      }
      const operationController = new AbortController();
      controller = operationController;
      const signal = AbortSignal.any([
        operationController.signal,
        operationTimeoutController.signal,
      ]);
      const summaryCommitToken = reservedSummaryCommitToken;

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
        summaryCommitToken,
      };

      this.lifecycle.activateFeature(tabId, active);
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
      let progressStageKey: OperationProfilingStageKey | undefined;

      type OperationProgressUpdate = {
        phase?: OperationPhase;
        message?: string | undefined;
        currentPage?: number | undefined;
        targetPages?: number | undefined;
        statusCode?: string | undefined;
        retryAtMs?: number | undefined;
        stageKey?: OperationProfilingStageKey | undefined;
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
          if ('stageKey' in updates && updates.stageKey) {
            progressStageKey = updates.stageKey;
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
            ...(progressStageKey !== undefined ? { stageKey: progressStageKey } : {}),
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

      // E81: coach narrates its wait in the pending bubble, so its stage
      // boundaries always ship as progress (a handful of tiny frames per turn);
      // every other feature keeps the debug-only cadence.
      const reportStageProgress = payload.feature === 'coach-chat';

      // E28: the echo's fate for this operation. Carries the counts projection
      // and an opaque viewer token — never a byte of the assembled prompt, which
      // stays in the service worker (this message lands in the Fansly DOM).
      const sendDebugEchoStatus = (echo: DebugPromptEchoStatus): void => {
        if (!profiler.enabled) {
          return;
        }
        this.send(tabId, {
          type: 'operation:debugPromptStatus',
          operationId: payload.operationId,
          feature: payload.feature,
          echo,
        });
      };

      const startStage = (
        key: Parameters<OperationProfiler['startStage']>[0],
        label: string,
        detail?: string,
        progressUpdates?: OperationProgressUpdate,
      ): void => {
        profiler.startStage(key, label, detail);
        profiler.log(label);
        if (reportStageProgress) {
          sendOperationProgress({ ...(progressUpdates ?? {}), stageKey: key });
        } else {
          sendDebugProgress(progressUpdates);
        }
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
      if (storage.personaCatalogSource !== validated.storage.personaCatalogSource) {
        throw new ChatGooseError('chat_changed');
      }
      const personalityId = resolveMappedPersonalityId(
        storage.accountMappings,
        resolvedAccountId,
        validated.legacyAccountId,
        storage.accountAliases,
      );
      if (!personalityId) {
        throw new ChatGooseError('no_mapping');
      }

      const personality = findActivePersona(storage.personaCatalog, personalityId);
      if (!personality) {
        throw new ChatGooseError('no_mapping');
      }
      const personaIdentity: PersonaOperationIdentity = {
        resolvedAccountId,
        legacyAccountId: validated.legacyAccountId,
        personaKey: personality.key,
        personaVersion: personality.version,
        personaDefinitionId: personality.definitionId,
        personaCatalogSource: storage.personaCatalogSource,
      };

      if (featureRequiresDraft(payload.feature) && !payload.draftText?.trim()) {
        throw new ChatGooseError('unknown_error');
      }

      // Stage 32: models are kernel config; 'kernel' is the summary-cache
      // sentinel (existing cached entries pinned to vendor model ids
      // invalidate once — the desktop cutover's recorded trade).
      const resolvedModel = KERNEL_MODEL_ID;

      // Recap sizing (spec §5): a SHORT recap is a fan-summary run with a fixed
      // 300-message window (NOT deepMessageCount), its own local cache key, and
      // no Hub dossier push. A full recap and every other feature are unchanged.
      const isShortRecap =
        payload.feature === 'fan-summary' && payload.summaryMode === 'short';
      const summaryCacheMode: SummaryCacheMode = isShortRecap ? 'short' : 'full';
      const effectiveMessageCount = isShortRecap
        ? SHORT_SUMMARY_MESSAGE_COUNT
        : validated.messageCount;

      let cachedSummary = null;
      let hasValidCachedSummary = false;
      if (payload.feature === 'fan-summary') {
        startStage('summary-cache-check', 'Check summary cache');
        if (payload.forceRegenerate) {
          profiler.log('Forced summary refresh');
        }
        cachedSummary = payload.forceRegenerate
          ? null
          : await this.storageCoordinator.getSummaryCache(validated.urlGroupId, summaryCacheMode);
        hasValidCachedSummary = isValidSummaryCacheEntry(
          cachedSummary,
          personality.key,
          personality.definitionId,
          storage.personaCatalogSource,
          resolvedModel,
        );
        // «Открыть последний» (spec §5): view the stored recap WITHOUT ever
        // generating. A cache miss is not an error to a normal Recap run (it
        // would generate), but here it must fail closed — no pagination, no
        // kernel call, no AI spend — so the standalone "view last" action stays
        // spend-free and honest about there being nothing stored.
        if (payload.viewCachedOnly && !(cachedSummary && hasValidCachedSummary)) {
          throw new ChatGooseError('no_saved_recap');
        }
      }

      if (payload.feature === 'fan-summary' && cachedSummary && hasValidCachedSummary) {
        if (!payload.viewCachedOnly) {
          if (summaryCommitToken === null) {
            throw new ChatGooseError('unknown_error');
          }
          this.assertLatestSummaryCommit(
            validated.urlGroupId,
            summaryCacheMode,
            payload.operationId,
            summaryCommitToken,
          );
        }
        await this.assertPersonaIdentityCurrent(personaIdentity);

        if (isShortRecap) {
          // Short recaps never touch the Hub dossier (spec §5): serve the
          // cached short body with NO sync status, NO persist, NO enqueue.
          const shortResult: FeatureResult = {
            rawText: cachedSummary.summary,
            summaryMeta: {
              generatedAt: cachedSummary.generatedAt,
              stale: false,
              cached: true,
              storedLocally: true,
              transcriptCoverage: cachedSummary.transcriptCoverage,
              keptCount: cachedSummary.keptCount,
            },
          };
          this.assertActive(tabId, payload.operationId);
          completeStage('summary-cache-check', 'Short recap cache hit', 'cache hit');
          sendDebugEchoStatus({ state: 'cache-hit' });
          this.sendComplete(tabId, {
            type: 'operation:complete',
            operationId: payload.operationId,
            result: shortResult,
            fanDisplayName: payload.domFanDisplayName ?? 'fan',
          }, createZeroLlmSpendSummary(), profiler);
          this.clearCompletedOperation(tabId);
          return;
        }

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
            {
              summary: cachedSummary.summary,
              personaIdentity,
            },
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
            storedLocally: true,
            syncStatus,
            transcriptCoverage: cachedSummary.transcriptCoverage,
            keptCount: cachedSummary.keptCount,
          },
        };
        this.assertActive(tabId, payload.operationId);
        completeStage(
          'summary-cache-check',
          'Summary cache hit',
          'cache hit',
        );
        // No kernel call happened, so there is no prompt to echo — say that
        // outright instead of showing an empty inspector (E28).
        sendDebugEchoStatus({ state: 'cache-hit' });
        const summarySyncTask: AgencyHubSummarySyncTask = {
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
          personaIdentity,
          requireCachedEntry: true,
          // Cached-only reads do not participate in writer ordering. The cache
          // identity + persona checks in isSummarySyncTaskCurrent still prevent
          // a stale async Hub push if a real writer replaces this entry.
          ...(summaryCommitToken !== null
            ? { operationId: payload.operationId, summaryCommitToken }
            : {}),
        };
        if (!await this.isSummarySyncTaskCurrent(summarySyncTask)) {
          throw new ChatGooseError('chat_changed');
        }
        this.assertActive(tabId, payload.operationId);
        const zeroSpend = createZeroLlmSpendSummary();
        this.sendComplete(tabId, {
          type: 'operation:complete',
          operationId: payload.operationId,
          result,
          fanDisplayName: payload.domFanDisplayName ?? 'fan',
        }, zeroSpend, profiler);
        this.clearCompletedOperation(tabId);
        if (shouldAttemptSync && !savedForCurrentTarget) {
          this.enqueueAgencyHubSummarySync(summarySyncTask);
        }
        return;
      }

      if (payload.feature === 'fan-summary') {
        // The Hub fan-profile contract does not yet carry persona key/version
        // provenance. A remote body therefore cannot be proved to belong to
        // the currently mapped revision and must never be returned or stamped
        // into the local cache as current. Local cache hits remain versioned;
        // every miss runs the gateway. The post-generation Hub PUSH path is
        // intentionally retained below.
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
      profiler.log(`Requested ${effectiveMessageCount} messages`);
      sendDebugProgress();
      const shouldReportMessageProgress =
        profiler.enabled || isDeepFeature(payload.feature) || reportStageProgress;
      const messageProgress: ((progress: MessageLoadProgress) => void) | undefined =
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
              // E81: coach's quick-window seed narrates its pages in the
              // pending bubble (RU copy is built content-side from the counts).
              if (reportStageProgress) {
                sendOperationProgress({
                  phase: 'loading-messages',
                  currentPage: progress.currentPage,
                  targetPages: progress.targetPages,
                  stageKey: 'load-messages',
                });
                return;
              }
              sendDebugProgress({
                phase: 'loading-messages',
                currentPage: progress.currentPage,
                targetPages: progress.targetPages,
              });
            }
          : undefined;

      // `transcriptPages` is what normalizeTranscript sees; `providerReachedEnd`
      // feeds transcriptCoverage (spec §5/§6). Coach reads via the session cache
      // (oldest-first, freshest tail); every other feature paginates fresh.
      let transcriptPages: FanslyMessagePageResponse[];
      let providerReachedEnd: boolean;
      let pagesLoadedLabel: number;
      if (payload.feature === 'coach-chat') {
        const cacheParts: CoachTranscriptCacheKeyParts = {
          tabId,
          coachSessionId: payload.coachSessionId ?? '',
          accountId: resolvedAccountId,
          groupId: validated.urlGroupId,
          quickMessageCount: effectiveMessageCount,
          // «Обновить переписку» bumps this content-owned epoch → guaranteed miss
          // + full quick-window reseed on the next turn (spec §8.4).
          transcriptEpoch: payload.transcriptEpoch ?? 0,
        };
        const loadFullWindow = async () => {
          const loaded = await this.fanslyClient.loadMessages(
            validated.urlGroupId,
            effectiveMessageCount,
            validated.session,
            signal,
            messageProgress,
          );
          return { pages: loaded.pages, reachedEnd: loaded.reachedEnd };
        };
        const loadPage = async (before: string | null) => {
          // The common refresh is a single page-1 fetch (immediate overlap); a
          // rarer no-overlap walk respects Fansly's pagination cadence between
          // pages (DP 1-B — never burst the model's own session).
          if (before !== null) {
            await delay(FANSLY_PAGINATION_DELAY_MS, signal);
          }
          const page = await this.fanslyClient.getMessagePage(
            validated.urlGroupId,
            before,
            validated.session,
            signal,
          );
          const messages = page.messages ?? [];
          return { page, reachedEnd: messages.length < FANSLY_PAGE_LIMIT };
        };
        // Try a tail refresh first; a 'miss' (first turn / evicted / SW restart)
        // or 'reload-required' (continuity lost — the cache self-evicts) both
        // fall back to a full quick-window (re)seed. This decision happens
        // BEFORE the kernel call, so acquiring context never burns a generation.
        const refreshResult = await this.coachTranscriptCache.refresh(cacheParts, loadPage);
        let window: CoachTranscriptWindow;
        if (refreshResult.status === 'refreshed') {
          window = refreshResult.window;
        } else {
          window = await this.coachTranscriptCache.getOrSeed(cacheParts, loadFullWindow);
        }
        transcriptPages = window.pages;
        providerReachedEnd = window.reachedEnd;
        pagesLoadedLabel = window.pages.length;
      } else {
        const messageLoad = await this.fanslyClient.loadMessages(
          validated.urlGroupId,
          effectiveMessageCount,
          validated.session,
          signal,
          messageProgress,
        );
        transcriptPages = messageLoad.pages;
        providerReachedEnd = messageLoad.reachedEnd;
        pagesLoadedLabel = messageLoad.pagesLoaded;
      }
      completeStage(
        'load-messages',
        `Loaded messages: ${pagesLoadedLabel} pages`,
        `${pagesLoadedLabel} pages`,
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
      // UI-facing label (may carry the chatter's private custom fan name via
      // the DOM fallback). NEVER used for the kernel — see kernelFanName below.
      let fanDisplayName = payload.domFanDisplayName ?? 'fan';
      // Kernel-facing name: account lookup ONLY, neutral "fan" on failure; the
      // DOM label never feeds it. The chatter's saved name (E115) rides its own
      // field from the same lookup; undefined when the fan was never renamed.
      let kernelFanName = 'fan';
      let fanCustomName: string | undefined;
      let fanBio: string | undefined;
      // Hi only: the profile the shared greeting-context module turns into
      // kernel fields. Same source as the names above (the account lookup,
      // never the DOM label); a failed lookup leaves the neutral text-only one.
      let greetingProfile: GreetingProfile = { displayName: 'fan' };
      fanAccountId =
        groupUsers?.find(
          (user) => user.userId !== resolvedAccountId,
        )?.userId ?? null;

      if (
        (payload.feature === 'coach-chat' || payload.feature === 'fan-summary') &&
        !fanAccountId
      ) {
        // New Coach and Recap requests use canonical groupId + fanRef identity.
        // A cached recap was already returned above without needing this lookup;
        // only a would-be generation reaches here. Fail BEFORE the kernel call
        // rather than persist a group-keyed row that fan erasure cannot reach.
        throw new ChatGooseError('coach_fan_unresolved');
      }

      const purchaseEvidence = await loadMediaPurchaseEvidence({
        fanslyClient: this.fanslyClient,
        pages: transcriptPages,
        fanAccountId,
        session: validated.session,
        signal,
        debugEnabled,
      });

      // Normalize after group-lookup so transcript labels can use the
      // resolved fan id for fan-perspective purchase state. When the lookup
      // fails or is skipped, fanAccountId is null and PPV labels degrade to
      // "unknown" rather than misclassifying.
      let transcriptMessages = normalizeTranscript(
        transcriptPages,
        resolvedAccountId,
        fanAccountId,
        purchaseEvidence,
      );

      // Defense-in-depth cap before formatting (spec §5 / §6.5 "Sort, cap to
      // the window"). The Coach cache is bounded at write time; short recap
      // pagination can still overshoot 300 at a page boundary. When this cap
      // bites it is window-trimming, forcing transcriptCoverage='window'.
      let windowTrimmed = false;
      if (
        (payload.feature === 'coach-chat' || isShortRecap) &&
        transcriptMessages.length > effectiveMessageCount
      ) {
        transcriptMessages = transcriptMessages.slice(-effectiveMessageCount);
        windowTrimmed = true;
      }

      if (
        isDeepFeature(payload.feature) &&
        transcriptMessages.length < MIN_MESSAGES_FOR_DEEP
      ) {
        throw new ChatGooseError('not_enough_history');
      }

      // Hi (E133, Core Decision 379): the same greeting context as the New
      // Followers window. Welcome and mass messages get the shared transcript
      // label and do not count against the freshness gate.
      let greetingWindow: GreetingWindowMessage[] | undefined;
      if (payload.feature === 'hi-greeting') {
        // Cache-first, never forced fresh, never in the way: a cold cache gets
        // a few seconds of the paced follower lane, then the stale texts or an
        // empty set. With no texts automation is still seen by its independent
        // markers (type 2, a correlation id that is not a reply).
        let welcomeTexts: ReadonlySet<string> = new Set<string>();
        startStage('welcome-definitions', 'Load welcome definitions');
        try {
          const welcome = await this.welcomeDefinitions.loadWithin({
            creatorId: resolvedAccountId,
            session: validated.session,
            timeoutMs: HI_WELCOME_LOAD_TIMEOUT_MS,
            signal,
          });
          welcomeTexts = welcome.texts;
          const detail = `${welcome.source}${welcome.reason ? ` after ${welcome.reason}` : ''}, ${welcome.texts.size} texts`;
          if (welcome.reason) {
            failStage('welcome-definitions', `Load welcome definitions degraded: ${detail}`, detail);
          } else {
            completeStage('welcome-definitions', `Loaded welcome definitions: ${detail}`, detail);
          }
          logDebug(debugEnabled, 'welcome definitions resolved', {
            source: welcome.source,
            reason: welcome.reason,
            count: welcome.texts.size,
          });
        } catch (error) {
          // Only a cancelled operation rejects; everything else degrades above.
          if (signal.aborted) {
            throw error;
          }
          const failureCode = errorCode(error);
          failStage('welcome-definitions', `Load welcome definitions failed: ${failureCode}`, failureCode);
          logDebug(debugEnabled, 'welcome definitions failed', { code: failureCode });
        }

        const rawById = new Map(
          transcriptPages.flatMap((page) => page.messages ?? []).map((message) => [message.id, message]),
        );
        const window = transcriptMessages.map((message) => {
          const raw = rawById.get(message.id);
          return {
            automated: raw !== undefined && isAutomatedGreetingMessage(raw, resolvedAccountId, welcomeTexts),
          };
        });
        transcriptMessages = transcriptMessages.map((message, index) =>
          window[index]!.automated
            ? { ...message, labels: [AUTOMATED_MESSAGE_LABEL, ...message.labels] }
            : message,
        );
        greetingWindow = window;

        // One Fansly page is all Hi reads. If it does not reach the start of
        // the conversation, older messages may be personal: fail closed, that
        // fan is Reply or Ping territory. Otherwise only personal messages count.
        const personalMessages = countPersonalMessages(window);
        logDebug(debugEnabled, 'hi greeting gate', {
          messages: window.length,
          personalMessages,
          historyCovered: Boolean(providerReachedEnd),
        });
        if (!providerReachedEnd || personalMessages > HI_GREETING_MAX_TRANSCRIPT) {
          throw new ChatGooseError('hi_too_many_messages');
        }
      }

      let pingSegment: PingSegment | undefined;
      let fanSilenceDays: number | undefined;
      if (featureUsesPingSegment(payload.feature)) {
        startStage('ping-analysis', 'Analyze ping segment');
        // One clock sample owns both values (Core #127), avoiding a boundary
        // disagreement between segment selection and the whole-day gap.
        const pingNowMs = Date.now();
        const pingAnalysis = analyzePingSegment(
          transcriptMessages,
          pingNowMs,
        );
        pingSegment = pingAnalysis.segment;
        fanSilenceDays = fanSilenceDaysFromAnalysis(pingAnalysis, pingNowMs) ?? undefined;
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
          fanSilenceDays,
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
          // UI label may fall back to the DOM name; the KERNEL name must not.
          fanDisplayName =
            account?.username?.trim() ||
            account?.displayName?.trim() ||
            payload.domFanDisplayName ||
            'fan';
          kernelFanName = kernelFanDisplayName(account);
          fanCustomName = kernelFanCustomName(account);
          // Bio inclusion is a per-feature policy (spec §7): hi-greeting, help-me,
          // and coach-chat — NOT a hardcoded hi-greeting check (that omitted the
          // bio for coach + help-me, the bug this fixes).
          if (featureIncludesFanBio(payload.feature) && account?.about?.trim()) {
            fanBio = account.about.trim();
          }
          if (payload.feature === 'hi-greeting' && account) {
            // The New Followers ordering: display name first, username beside
            // it in its own field (the kernel drops the username line when the
            // two are equal). This read is live on every generation, so the
            // signed avatar URL is fresh without any extra Fansly request.
            greetingProfile = {
              displayName: account.displayName?.trim() || account.username?.trim() || 'fan',
              username: account.username?.trim() || null,
              customName: customNameFromAccount(account),
              bio: fanBio ?? null,
              avatarUrl: fanslyAvatarUrl(account),
            };
          }
          completeStage(
            'account-name-lookup',
            `Resolved fan display name: ${fanDisplayName}`,
            `resolved ${fanDisplayName}`,
          );
        } catch (error) {
          // Belt-and-braces (conversation-context-loader pattern): if the lookup
          // was aborted by a route-change cancel, re-throw so this op unwinds
          // instead of falling through to write a now-stale fan.
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

      // Pass THIS op's groupId; the store no-ops if the context has moved on (the
      // structural stale-fan guard).
      this.tabContexts.setFan(tabId, validated.urlGroupId, fanAccountId, fanDisplayName);
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
                    breakdown: [] as EarningsBreakdownEntry[],
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

      startStage('prompt-build', 'Build context');
      // W9.4/A26: oldest-first truncation to the kernel's 300k transcript cap
      // — messageCount is the KEPT count, matching what the kernel receives.
      const { transcript: formattedTranscript, messageCount: keptMessageCount } =
        formatTranscriptForKernel(transcriptMessages);
      // Stage 32: prompt ASSEMBLY is kernel-side (templates, personas,
      // platform wording, budgets, capture). The client ships context VALUES
      // because Fansly has no webhook lane — the kernel archive is
      // pull-cadenced while this transcript was read live moments ago.
      // Do not make even the page-label/generation request against stale Hub A
      // after a committed A→B switch whose onChanged delivery lagged.
      await this.assertPersonaIdentityCurrent(personaIdentity);
      const pageUsername = await this.resolveCreatorUsername(validated.session, signal);
      await this.assertPersonaIdentityCurrent(personaIdentity);
      const pageLabel = await this.agencyHubClient.resolvePageLabelForUsername(
        validated.storage.settings,
        pageUsername,
        signal,
      );
      if (!pageLabel) {
        throw new ChatGooseError('hub_page_match_failed');
      }
      // Coverage (spec §5/§6): 'full-history' only when the provider reached the
      // conversation's oldest edge AND no window trim happened AND the char-cap
      // formatter kept every normalized message. Computed for EVERY run so the
      // recap coverage header (spec §5) can render on any fan-summary result…
      const computedTranscriptCoverage: 'full-history' | 'window' =
        providerReachedEnd &&
        !windowTrimmed &&
        keptMessageCount === transcriptMessages.length
          ? 'full-history'
          : 'window';
      // …but only SENT to the kernel for coach + short recap (spec §7 rollback
      // gating — old cores never see the field from a full run).
      const transcriptCoverage: 'full-history' | 'window' | undefined =
        payload.feature === 'coach-chat' || isShortRecap
          ? computedTranscriptCoverage
          : undefined;
      const refs = buildConversationRefs(
        payload.feature,
        fanAccountId,
        validated.urlGroupId,
      );
      // Hi: profile fields, avatar and the personal count of the KEPT window
      // come from the shared module (it bounds them to the Core contract, and
      // the count can never exceed clientContext.messageCount).
      const greetingContext =
        greetingWindow !== undefined
          ? buildGreetingContext({
              profile: greetingProfile,
              messages: greetingWindow,
              transcript: { messageCount: keptMessageCount },
            })
          : undefined;
      const kernelRequest = {
        feature: payload.feature,
        clientRequestId: payload.operationId,
        pageLabel,
        conversationRef: refs.conversationRef,
        ...(refs.fanRef !== undefined ? { fanRef: refs.fanRef } : {}),
        personaKey: personality.key,
        expectedPersonaDefinitionId: personality.definitionId,
        replyTone: payload.replyTone,
        replyMode: payload.replyMode,
        draftText: payload.draftText,
        isRegeneration: Boolean(payload.forceRegenerate),
        ...(payload.feature === 'coach-chat' && payload.chatterQuestion !== undefined
          ? { chatterQuestion: payload.chatterQuestion }
          : {}),
        ...(payload.feature === 'coach-chat' && payload.coachPreset !== undefined
          ? { preset: payload.coachPreset }
          : {}),
        ...(payload.feature === 'coach-chat' && payload.coachHistory !== undefined
          ? { coachHistory: payload.coachHistory }
          : {}),
        ...(isShortRecap ? { summaryMode: 'short' as const } : {}),
        // Three variants for the overlay; the New Followers window asks for 1.
        ...(greetingContext !== undefined ? { variantCount: 3 as const } : {}),
        // The REQUESTED window (kernel records requestedCount from this): the
        // short const for a short recap, else the feature's window (deep for a
        // full recap). Distinct from clientContext.messageCount (the kept count).
        messageCount: effectiveMessageCount,
        // E28: ask only in debug mode. The kernel answers only inside an
        // owner-set time-bounded window, so this is a request, not a right.
        debugPromptEcho: profiler.enabled,
        clientContext: {
          transcript: formattedTranscript,
          messageCount: keptMessageCount,
          fanSpendingData: spendingData,
          fanSubscriptionData: subscriptionData,
          ...(greetingContext !== undefined
            ? greetingContext
            : {
                // Kernel-facing name is account-lookup only, never the DOM label
                // (which fanDisplayName still uses for UI); the chatter's saved name
                // travels beside it in its own field (E115, Core Decision 290).
                fanDisplayName: kernelFanName,
                ...(fanBio !== undefined ? { fanBio } : {}),
                ...(fanCustomName !== undefined ? { fanCustomName } : {}),
              }),
          ...(pingSegment !== undefined ? { pingSegment } : {}),
          ...(fanSilenceDays !== undefined ? { fanSilenceDays } : {}),
          ...(transcriptCoverage !== undefined ? { transcriptCoverage } : {}),
        },
      } as const;
      completeStage(
        'prompt-build',
        `Built context: ${keptMessageCount} transcript messages`,
        `${keptMessageCount} transcript messages`,
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
            system: '[assembled kernel-side]',
            transcript: formattedTranscript,
            fanSpendingData: spendingData,
            fanSubscriptionData: subscriptionData,
            user: '[assembled kernel-side]',
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
      // coach-chat turn context (spec §8.2): the gateway parses attachedRecaps on
      // the meta frame; capture it here so the operation:complete message can
      // carry the honest post-attach recap provenance (the callback used to
      // discard it). Undefined until/unless the meta frame reports it.
      let attachedRecaps: KernelFeatureAttachedRecaps | undefined;
      let presetQuestion: string | undefined;
      const actualModelName = (): string => actualModel;
      startStage('llm-ttfb', 'Wait for AI TTFB');
      profiler.log(`Waiting for ${actualModelName()}`);
      sendDebugProgress();
      startLlmTtfbTimeout();

      let latestLlmSpend: LlmSpendSummary | null = null;
      const handleKernelUsage = (usage: KernelFeatureUsage): void => {
        // Gateway-priced (Stage 29) — the only spend source post-cutover.
        const spend = buildKernelSpendSummary(usage);
        latestLlmSpend = spend;
        const current = this.getActive(tabId);
        if (current?.operationId === payload.operationId) {
          current.llmSpend = spend;
        }
        profiler.setLlmUsage({
          input_tokens: usage.inputTokens,
          cache_creation_input_tokens: usage.cacheWriteTokens,
          cache_read_input_tokens: usage.cacheReadTokens,
          output_tokens: usage.outputTokens,
        });
        profiler.log(formatKernelUsageLog(actualModel, usage));
        logDebug(debugEnabled, 'kernel usage', {
          model: actualModel,
          costMicroUsd: usage.costMicroUsd,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
        });
        sendOperationProgress();
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
          if (reportStageProgress) {
            sendOperationProgress({ stageKey: 'llm-stream' });
          } else {
            sendDebugProgress();
          }
          return true;
        }
        resetLlmIdleTimeout();
        return false;
      };

      let debugEchoSeen = false;
      const handleDebugInput = (input: KernelFeatureDebugInput): void => {
        // A frame belonging to an operation the tab has already moved past must
        // not repaint the inspector — same staleness guard as onText/onUsage.
        const current = this.getActive(tabId);
        if (!current || current.operationId !== payload.operationId) {
          return;
        }
        debugEchoSeen = true;
        const viewerToken = this.debugPrompts.put({
          operationId: payload.operationId,
          feature: payload.feature,
          modelId: actualModel,
          capturedAt: Date.now(),
          systemBlocks: input.systemBlocks,
          userBlocks: input.userBlocks,
          contextManifest: input.contextManifest,
        });
        sendDebugEchoStatus({
          state: 'available',
          viewerToken,
          kernelContext: projectKernelContext(input.contextManifest),
        });
      };

      const streamCallbacks = {
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
            // Acceptance lifecycle: the suggestion became visible.
            this.acceptance?.enqueue({
              operationId: payload.operationId,
              requestId: this.acceptanceContexts.get(payload.operationId)?.requestId ?? null,
              feature: payload.feature,
              action: 'shown',
              pageLabel: kernelRequest.pageLabel,
              conversationRef: kernelRequest.conversationRef,
              at: new Date().toISOString(),
            });
          }
          current.rawText += chunk;
          current.flushBuffer += chunk;
          this.scheduleChunkFlush(tabId, current);
        },
        onMeta: (meta: {
          requestId: string;
          clientRequestId: string;
          model: string;
          attachedRecaps?: KernelFeatureAttachedRecaps;
          presetQuestion?: string;
        }) => {
          // The kernel names the model (client model config died with the
          // vendor lane); requestId is the generation ref — the acceptance
          // correlation key kernel-side.
          actualModel = meta.model;
          // Coach-only: the recap slots Core actually attached this turn (spec
          // §8.2) — retained for the collapsed «Отправлено коучу…» line.
          if (meta.attachedRecaps !== undefined) {
            attachedRecaps = meta.attachedRecaps;
          }
          if (meta.presetQuestion !== undefined) {
            presetQuestion = meta.presetQuestion;
          }
          this.rememberAcceptanceContext(payload.operationId, {
            operationId: payload.operationId,
            requestId: meta.requestId,
            feature: payload.feature,
            pageLabel: kernelRequest.pageLabel,
            conversationRef: kernelRequest.conversationRef,
          });
          if (markProviderActivity('first provider event received')) {
            profiler.log(`${actualModelName()} first provider event`);
          }
        },
        onUsage: (usage: KernelFeatureUsage) => {
          markProviderActivity('first provider event received');
          handleKernelUsage(usage);
        },
        onReasoningDelta: (text: string) => {
          markProviderActivity('first provider event received');
          if (!reasoningObserved) {
            reasoningObserved = true;
            profiler.log('Reasoning observed: yes (stream)');
          }
          if (profiler.enabled) {
            reasoningDebugText += text;
            profiler.setReasoningBlock(reasoningDebugText);
          }
        },
        onStopReason: (stopReason: string | null) => {
          latestLlmStopReason = stopReason;
        },
        onDebugInput: handleDebugInput,
      } as const;

      let serviceUnavailableRetried = false;
      let rawText: string;
      while (true) {
        try {
          await this.assertPersonaIdentityCurrent(personaIdentity);
          if (summaryCommitToken !== null) {
            this.assertLatestSummaryCommit(
              validated.urlGroupId,
              summaryCacheMode,
              payload.operationId,
              summaryCommitToken,
            );
          }
          reasoningObserved = false;
          reasoningDebugText = '';
          profiler.setReasoningBlock('');
          rawText = await this.kernelGateway.streamFeature(
            validated.storage.settings,
            kernelRequest,
            streamCallbacks,
            signal,
          );
          break;
        } catch (err) {
          // Duck-typed key (not instanceof): test/dual-module instances of
          // ChatGooseError must still match — the pre-cutover code's pattern.
          const errorKey = err instanceof ChatGooseError
            ? err.key
            : (err as { key?: string })?.key;
          // One transparent retry when the kernel gateway reports the
          // provider unavailable and nothing has streamed yet.
          if (!sawFirstChunk && !serviceUnavailableRetried && errorKey === 'service_unavailable') {
            serviceUnavailableRetried = true;
            clearLlmTimeouts();
            const retryDelayMs = AUTO_RETRY_SERVICE_UNAVAILABLE_MS;
            profiler.log(
              `Kernel gateway unavailable, retrying in ${Math.ceil(retryDelayMs / 1000)}s`,
            );
            sendOperationProgress({
              phase: 'generating',
              message: 'Provider unavailable. Retrying…',
              currentPage: undefined,
              targetPages: undefined,
              statusCode: err instanceof ChatGooseError
                ? err.code
                : (err as { code?: string })?.code,
              retryAtMs: Date.now() + retryDelayMs,
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
            sawProviderActivityInAttempt = false;
            startLlmTtfbTimeout();
            continue;
          }
          throw err;
        }
      }
      clearLlmTimeouts();

      if (!debugEchoSeen) {
        // Asked and not answered: the kernel's echo window is closed for this
        // chatter. Say so, rather than leaving the inspector looking broken.
        sendDebugEchoStatus({ state: 'unavailable' });
      }

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
      if (clearFlushTimer(current)) {
        this.flushChunks(tabId, current);
      }

      // Output-exhaustion fail-closed (spec §8, CLAUDE.md family law): a provider
      // hitting its token ceiling (normalized cross-provider by isOutputExhausted:
      // kernel 'max_tokens' + OpenRouter 'length') makes the generation
      // non-committable for EVERY feature — "a truncated stream is an error, never
      // presented as a result", with NO exceptions. Applies before buildFeatureResult,
      // so a truncated help-me/chat-review can't slip through as a valid: false
      // XML fallback either. This is the universal guard; do not re-narrow it to a
      // feature/promptMode list — the rule is unconditional.
      if (isOutputExhausted(latestLlmStopReason)) {
        throw new ChatGooseError('ai_output_unusable');
      }

      // Empty / whitespace-only output fails closed for EVERY feature, symmetric
      // to the exhaustion guard above — a meta→done stream with no content, or a
      // whitespace end_turn answer, is not a usable result. This is unconditional:
      // help-me/chat-review's parseHelpMeXml('')/parseChatReviewXml('') return
      // valid:false (they do NOT throw), and assertInsertableFeatureResult only
      // guards reply kinds, so an empty analysis result would otherwise reach
      // operation:complete and render an empty card as success. Sits before the
      // result build and the summary-cache write, so nothing empty is ever
      // presented or cached. Do not re-narrow to a feature list.
      if (!rawText.trim()) {
        throw new ChatGooseError('ai_output_unusable');
      }

      const result = buildFeatureResult(
        payload.feature,
        rawText,
        payload.replyMode,
      );
      assertInsertableFeatureResult(payload.feature, result);
      await this.assertPersonaIdentityCurrent(personaIdentity);
      // Cancellation can land during the fresh storage read above, after the
      // stream's active check. Never commit that abandoned result or recap.
      this.assertActive(tabId, payload.operationId);

      let summarySyncTask: AgencyHubSummarySyncTask | null = null;
      if (payload.feature === 'fan-summary') {
        if (summaryCommitToken === null) {
          throw new ChatGooseError('unknown_error');
        }
        this.assertLatestSummaryCommit(
          validated.urlGroupId,
          summaryCacheMode,
          payload.operationId,
          summaryCommitToken,
        );
        const generatedAt = Date.now();
        // W9.4/A18: the old `actualModel === resolvedModel` gate made this
        // write DEAD post-cutover — resolvedModel is the 'kernel' cache
        // sentinel while actualModel becomes the meta frame's real vendor
        // model id, so the equality never held and no fresh summary was ever
        // cached. Model choice is kernel config now; the sentinel pin below
        // is the cache identity, and the equality gate is gone.
        const shouldCacheSummary = spendingDataVerified && subscriptionLookupVerified;
        const isCommitCurrent = (state: PersistedState): boolean =>
          this.getActive(tabId)?.operationId === payload.operationId &&
          this.isLatestSummaryCommit(
            validated.urlGroupId,
            summaryCacheMode,
            payload.operationId,
            summaryCommitToken,
          ) && isPersonaOperationIdentityCurrent(state, personaIdentity);

        if (isShortRecap) {
          // Short recap (spec §5): own mode-qualified cache key, and NEVER a Hub
          // dossier push — a short run must not overwrite the durable full
          // dossier. No sync status, no summarySyncTask. Coverage header data
          // (spec §5) rides on the freshly generated result.
          result.summaryMeta = {
            generatedAt,
            stale: false,
            cached: false,
            storedLocally: shouldCacheSummary,
            transcriptCoverage: computedTranscriptCoverage,
            keptCount: keptMessageCount,
          };
          if (shouldCacheSummary) {
            const committed = await this.storageCoordinator.saveSummaryCacheIfCurrent(
              validated.urlGroupId,
              {
                summary: rawText,
                personalityId: personality.key,
                personaDefinitionId: personality.definitionId,
                personalityUpdatedAt: personality.version,
                personaCatalogSource: personaIdentity.personaCatalogSource,
                generatedAt,
                transcriptCoverage: computedTranscriptCoverage,
                keptCount: keptMessageCount,
                spendingDataVerified: true,
                subscriptionLookupVerified: true,
                modelId: resolvedModel,
                fanAccountId,
                // Behind the exhaustion + empty guards ⇒ a complete, trusted
                // generation. Required by isValidSummaryCacheEntry for a hit.
                trustedTerminal: true,
              },
              isCommitCurrent,
              'short',
            );
            if (!committed) {
              throw new ChatGooseError('chat_changed');
            }
          }
          // summarySyncTask intentionally left null → no dossier enqueue below.
        } else {
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
            storedLocally: shouldCacheSummary,
            syncStatus: initialSyncStatus,
            transcriptCoverage: computedTranscriptCoverage,
            keptCount: keptMessageCount,
          };
          if (shouldCacheSummary) {
            const committed = await this.storageCoordinator.saveSummaryCacheIfCurrent(
              validated.urlGroupId,
              {
                summary: rawText,
                personalityId: personality.key,
                personaDefinitionId: personality.definitionId,
                personalityUpdatedAt: personality.version,
                personaCatalogSource: personaIdentity.personaCatalogSource,
                generatedAt,
                transcriptCoverage: computedTranscriptCoverage,
                keptCount: keptMessageCount,
                spendingDataVerified: true,
                subscriptionLookupVerified: true,
                modelId: resolvedModel,
                fanAccountId,
                agencyHubSync: initialSyncStatus,
                // Behind the exhaustion + empty guards ⇒ a complete, trusted
                // generation. Required by isValidSummaryCacheEntry for a hit.
                trustedTerminal: true,
              },
              isCommitCurrent,
            );
            if (!committed) {
              throw new ChatGooseError('chat_changed');
            }
          }
          summarySyncTask = {
            tabId,
            groupId: validated.urlGroupId,
            settings: validated.storage.settings,
            summary: rawText,
            generatedAt,
            existingSync: initialSyncStatus,
            fanAccountId,
            session: validated.session,
            resolvedAccountId,
            debugEnabled,
            personaIdentity,
            requireCachedEntry: shouldCacheSummary,
            operationId: payload.operationId,
            summaryCommitToken,
          };
          if (!await this.isSummarySyncTaskCurrent(summarySyncTask)) {
            throw new ChatGooseError('chat_changed');
          }
        }
      }
      // Recap persistence and Hub-sync eligibility perform additional awaits.
      // A cancelled turn must not publish success or increment usage counters.
      this.assertActive(tabId, payload.operationId);
      const completedSpend = latestLlmSpend ?? createZeroLlmSpendSummary();
      // generationRef (spec §3): the gateway meta-frame requestId, captured in
      // acceptanceContexts on onMeta. Threaded to content so a later coach draft
      // acceptance can correlate back to its generation. Harmless for all.
      const generationRef =
        this.acceptanceContexts.get(payload.operationId)?.requestId;
      // coach-chat turn context (spec §8.2): kept-count + coverage the BROWSER
      // sent (pre-budget) plus the recap slots Core actually attached, each with
      // its age, plus Core #204's canonical preset question when present. Typed
      // projection (E28), never the raw meta payload.
      const turnContext =
        payload.feature === 'coach-chat'
          ? {
              sentMessageCount: keptMessageCount,
              transcriptCoverage: computedTranscriptCoverage,
              // «Not reported» stays ABSENT (round 12, E43): only a kernel
              // that actually sent the field yields a recap claim. Floored:
              // the content-side validator requires non-negative INTEGER ages.
              ...(attachedRecaps !== undefined
                ? {
                    attachedRecaps: {
                      full: attachedRecaps.full
                        ? { ageMs: Math.max(0, Math.floor(attachedRecaps.full.ageMs)) }
                        : null,
                      short: attachedRecaps.short
                        ? { ageMs: Math.max(0, Math.floor(attachedRecaps.short.ageMs)) }
                        : null,
                    },
                  }
                : {}),
              ...(presetQuestion !== undefined ? { presetQuestion } : {}),
              // E108: the fan-language signal for the content-side Cyrillic
              // guard, measured on the SAME windowed transcript the kernel got.
              fanWritesCyrillic: fanWritesCyrillic(transcriptMessages),
            }
          : undefined;
      this.sendComplete(tabId, {
        type: 'operation:complete',
        operationId: payload.operationId,
        result,
        fanDisplayName,
        ...(generationRef != null ? { generationRef } : {}),
        ...(turnContext !== undefined ? { turnContext } : {}),
      }, completedSpend, profiler);

      // The coordinator has ACCEPTED this result — that, not the gateway's
      // request, is the honest moment a generation happened (a stream can still
      // fail validation after the kernel finished). Recorded here because this
      // is the only scope holding all four facts: the feature, the resolved
      // account, its human label, and the kernel page label. Best-effort: a
      // counter must never break a delivered generation.
      void recordGeneration({
        feature: payload.feature,
        accountId: resolvedAccountId,
        // Empty when no human name resolved — the pane falls back to the id
        // instead of showing a fabricated label.
        accountLabel: pageUsername ?? '',
        pageLabel,
      }).catch(() => undefined);

      this.clearCompletedOperation(tabId);
      if (payload.feature === 'fan-summary' && result.summaryMeta && summarySyncTask) {
        if (result.summaryMeta.syncStatus?.state === 'saving') {
          this.enqueueAgencyHubSummarySync(summarySyncTask);
        }
      }
    } catch (error) {
      const active = this.getActive(tabId);
      const operationId = active?.operationId ?? payload.operationId;
      if (this.lifecycle.consumeCancelledFeature(operationId)) {
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
        void recordHubError(errorPayload.error.code).catch(() => undefined);
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
        // Terminal failure of a feature run. recordHubError itself keeps only
        // the `CG-HUB-` family, so a Fansly/flow code passed here is dropped —
        // the pane's «Ошибки генераций (Hub)» counter stays what it claims.
        void recordHubError(errorPayload.error.code).catch(() => undefined);
      }

      logDebug(debugEnabled, 'operation error', error);
      await this.cancelOperation(tabId);
      // cancelOperation re-adds the id to the cancelled set, but this is the
      // terminal failure path — there is no late chunk/complete left to
      // suppress, so drop it to keep the set from growing unbounded.
      this.lifecycle.forgetCancelledFeature(operationId);
    } finally {
      this.lifecycle.releaseReservation(tabId);
      timeoutController?.clearAll();
    }
  }

  private getCompareContext(): CompareOperationsContext {
    return {
      lifecycle: this.lifecycle,
      sessionStore: this.sessionStore,
      tabContexts: this.tabContexts,
      storageCoordinator: this.storageCoordinator,
      fanslyClient: this.fanslyClient,
      kernelGateway: this.kernelGateway,
      agencyHubClient: this.agencyHubClient,
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
