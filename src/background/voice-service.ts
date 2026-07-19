import {
  AGENCY_HUB_PREFETCH_TIMEOUT_MS,
  VOICE_AUDIO_MAX_BYTES,
} from '../shared/constants.js';
import {
  ChatGooseError,
  createUserError,
  isUserErrorKey,
} from '../shared/errors.js';
import { resolveFeatureMessageCount } from '../shared/features.js';
import { normalizeAgencyHubBaseUrl } from '../shared/agency-hub.js';
import { isContentPortMessage } from '../shared/protocol.js';
import {
  formatTranscriptForKernel,
  normalizeTranscript,
} from '../shared/transcript.js';
import type {
  BackgroundPortMessage,
  ContentPortMessage,
  Settings,
  TabContext,
  VoiceNoteCreatePayload,
  VoiceNoteStatusView,
} from '../shared/types.js';
import type {
  AgencyHubResolvedPage,
} from './agency-hub-client.js';
import { resolveHubBearer } from './agency-hub-client.js';
import { loadMediaPurchaseEvidence } from './conversation-context-loader.js';
import type { FanslyClient } from './fansly-client.js';
import type { KernelFeatureGateway } from './kernel-feature-gateway.js';
import type { SessionStore } from './session-store.js';
import type { StorageCoordinator } from './storage-coordinator.js';
import type { TabContextStore } from './tab-context.js';

type VoiceContentMessage = Extract<ContentPortMessage, { type: `voice:${string}` }>;
type VoiceBackgroundMessage = Extract<BackgroundPortMessage, { type: `voice:${string}` }>;
type VoiceEmitter = (message: VoiceBackgroundMessage) => void;
type VoiceNoteErrorContext =
  | { source: 'create' }
  | { source: 'status' | 'audio'; voiceNoteId: number };
type HubSettings = Pick<
  Settings,
  'agencyHubBaseUrl' | 'agencyHubApiKey' | 'agencyHubDeviceToken'
>;

const VOICE_CAPABILITY_TTL_MS = 5 * 60_000;

interface VoiceAgencyHubClient {
  resolvePageForUsername(
    settings: HubSettings,
    pageUsername: string | null,
    signal: AbortSignal,
  ): Promise<AgencyHubResolvedPage | null>;
  createVoiceNote(
    settings: HubSettings,
    pageLabel: string,
    body: Pick<
      VoiceNoteCreatePayload,
      'clientRequestId' | 'conversationRef' | 'sourceGenerationRef' | 'script'
    >,
    signal: AbortSignal,
  ): Promise<VoiceNoteStatusView>;
  getVoiceNoteStatus(
    settings: HubSettings,
    pageLabel: string,
    id: number,
    signal: AbortSignal,
  ): Promise<VoiceNoteStatusView>;
  fetchVoiceNoteAudio(
    settings: HubSettings,
    pageLabel: string,
    id: number,
    signal: AbortSignal,
  ): Promise<Response>;
}

interface AttemptBinding {
  tabId: number;
  accountId: string | null;
  groupId: string | null;
  fanAccountId: string | null;
  routeNonce: number;
}

interface VoiceAttemptRecord {
  attemptId: string;
  pageLabel: string;
  voiceNoteId: number;
  binding: AttemptBinding;
}

interface CapabilityCacheEntry {
  baseUrl: string;
  bearer: string;
  capable: boolean;
  expiresAt: number;
}

interface TabPageBinding {
  baseUrl: string;
  bearer: string;
  pageUsername: string;
  pageLabel: string;
}

interface ActiveScript {
  attemptId: string;
  controller: AbortController;
}

export interface VoiceServiceDependencies {
  kernelGateway: Pick<KernelFeatureGateway, 'streamFeature'>;
  agencyHubClient: VoiceAgencyHubClient;
  fanslyClient: Pick<
    FanslyClient,
    | 'getAuthenticatedAccount'
    | 'loadMessages'
    | 'getGroup'
    | 'getAccountNames'
    | 'verifyMediaPurchaseStates'
  >;
  sessionStore: Pick<SessionStore, 'getSessionForTab'>;
  tabContexts: Pick<TabContextStore, 'get' | 'getOrCreate' | 'setFan'>;
  storageCoordinator: Pick<StorageCoordinator, 'getState'>;
  randomUUID?: () => string;
  now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isVoiceContentMessage(message: ContentPortMessage): message is VoiceContentMessage {
  switch (message.type) {
    case 'voice:scriptStart':
    case 'voice:scriptCancel':
    case 'voice:noteCreate':
    case 'voice:noteStatus':
    case 'voice:audioFetch':
    case 'voice:attachToken':
      return true;
    default:
      return false;
  }
}

function numericStatus(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function errorBody(error: unknown): Record<string, unknown> | null {
  if (!isRecord(error) || !isRecord(error.body)) {
    return null;
  }
  return error.body;
}

function structuredErrorCode(error: unknown, fallback: string): string {
  if (error instanceof ChatGooseError) {
    return error.key;
  }
  const body = errorBody(error);
  if (typeof body?.code === 'string' && body.code.trim()) {
    return body.code.trim();
  }
  if (typeof body?.error === 'string' && body.error.trim()) {
    return body.error.trim();
  }
  if (isRecord(error) && typeof error.code === 'string' && error.code.trim()) {
    return error.code.trim();
  }
  return fallback;
}

function safeMessageForCode(code: string, fallback: Parameters<typeof createUserError>[0]): string {
  return createUserError(isUserErrorKey(code) ? code : fallback).message;
}

function noteFailure(error: unknown): { code: string; message: string; status: number } {
  const body = errorBody(error);
  const status = isRecord(error)
    ? numericStatus(error.status) ||
      numericStatus(body?.statusCode) ||
      (isRecord(error.details) ? numericStatus(error.details.status) : 0)
    : 0;
  const code = status === 401 || status === 403
    ? 'hub_invalid_api_key'
    : structuredErrorCode(error, 'hub_request_failed');
  return {
    code,
    message: safeMessageForCode(code, 'hub_request_failed'),
    status,
  };
}

function parseResponseErrorBody(text: string): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function bindingFromContext(context: TabContext): AttemptBinding {
  return {
    tabId: context.tabId,
    accountId: context.accountId,
    groupId: context.groupId,
    fanAccountId: context.fanAccountId,
    routeNonce: context.routeNonce,
  };
}

function sameRoute(
  binding: Pick<AttemptBinding, 'tabId' | 'accountId' | 'groupId' | 'routeNonce'>,
  context: TabContext | null,
): boolean {
  return Boolean(
    context &&
    context.tabId === binding.tabId &&
    context.accountId === binding.accountId &&
    context.groupId === binding.groupId &&
    context.routeNonce === binding.routeNonce
  );
}

function attachRefusal(
  binding: AttemptBinding,
  context: TabContext | null,
): 'route_changed' | 'fan_mismatch' | null {
  if (!sameRoute(binding, context)) {
    return 'route_changed';
  }
  return context?.fanAccountId === binding.fanAccountId ? null : 'fan_mismatch';
}

function isAbortError(error: unknown): boolean {
  return isRecord(error) && error.name === 'AbortError';
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}

/** Dedicated voice lane. It never enters OperationRegistry, acceptance
 * capture, generic result parsing, or the service_unavailable retry loop. */
export class VoiceService {
  private readonly portsByTabId = new Map<number, browser.runtime.Port>();
  private readonly activeScriptsByTabId = new Map<number, ActiveScript>();
  private readonly attemptsById = new Map<string, VoiceAttemptRecord>();
  /** Route/fan invalidation is permanent for this worker-lifetime attempt.
   * A successfully dispatched grant is not attempt-level invalidation: an
   * explicit human re-request may receive a fresh, independently single-use
   * token after an uncertain native handoff. */
  private readonly unavailableAttachAttemptIds = new Set<string>();
  private readonly attachGrantsInFlight = new Set<string>();
  private readonly capabilityByPageLabel = new Map<string, CapabilityCacheEntry>();
  private readonly pageBindingByTabId = new Map<number, TabPageBinding>();
  private readonly randomUUID: () => string;
  private readonly now: () => number;

  constructor(private readonly deps: VoiceServiceDependencies) {
    this.randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
    this.now = deps.now ?? (() => Date.now());
  }

  /** Independent port lane: validated voice envelopes never enter
   * OperationCoordinator or its retry/acceptance/result machinery. */
  registerPort(port: browser.runtime.Port): void {
    const tabId = port.sender?.tab?.id;
    if (!tabId) {
      return;
    }
    this.portsByTabId.set(tabId, port);
    port.onMessage.addListener((message) => {
      if (this.portsByTabId.get(tabId) !== port || !isContentPortMessage(message)) {
        return;
      }
      if (message.type === 'tab:init' || message.type === 'tab:routeChanged') {
        this.invalidateRoute(tabId);
        return;
      }
      if (isVoiceContentMessage(message)) {
        void this.handleMessage(tabId, message, (outbound) => {
          if (this.portsByTabId.get(tabId) === port) {
            port.postMessage(outbound);
          }
        });
      }
    });
    port.onDisconnect.addListener(() => {
      if (this.portsByTabId.get(tabId) !== port) {
        return;
      }
      this.portsByTabId.delete(tabId);
      this.handlePortDisconnected(tabId);
    });
  }

  async handleMessage(
    tabId: number,
    message: VoiceContentMessage,
    emit: VoiceEmitter,
  ): Promise<void> {
    switch (message.type) {
      case 'voice:scriptStart':
        await this.startScript(tabId, message, emit);
        return;
      case 'voice:scriptCancel':
        this.cancelScript(tabId, message.attemptId);
        return;
      case 'voice:noteCreate':
        await this.createNote(tabId, message, emit);
        return;
      case 'voice:noteStatus':
        await this.readStatus(tabId, message, emit);
        return;
      case 'voice:audioFetch':
        await this.fetchAudio(tabId, message, emit);
        return;
      case 'voice:attachToken':
        await this.grantAttachToken(tabId, message, emit);
        return;
    }
  }

  /** Called by tab:init state assembly and storage-change refreshes. Any
   * missing page row/capability or request error fails closed. */
  async resolveCapability(tabId: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(
      () => controller.abort(),
      AGENCY_HUB_PREFETCH_TIMEOUT_MS,
    );
    try {
      return (await this.resolvePageForTab(tabId, controller.signal)).voiceNotesCapable;
    } catch {
      return false;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  /** Route changes permanently invalidate attachment handoffs for the tab and
   * abort a script whose live clientContext belongs to the old conversation. */
  invalidateRoute(tabId: number): void {
    this.abortActiveScript(tabId);
    this.invalidateAttachAttemptsForTab(tabId);
  }

  handlePortDisconnected(tabId: number): void {
    this.invalidateRoute(tabId);
  }

  handleTabRemoved(tabId: number): void {
    this.invalidateRoute(tabId);
    for (const [attemptId, attempt] of this.attemptsById) {
      if (attempt.binding.tabId === tabId) {
        this.attemptsById.delete(attemptId);
        this.unavailableAttachAttemptIds.delete(attemptId);
        this.attachGrantsInFlight.delete(attemptId);
      }
    }
    this.pageBindingByTabId.delete(tabId);
    this.portsByTabId.delete(tabId);
  }

  private async startScript(
    tabId: number,
    message: Extract<VoiceContentMessage, { type: 'voice:scriptStart' }>,
    emit: VoiceEmitter,
  ): Promise<void> {
    this.abortActiveScript(tabId);
    const controller = new AbortController();
    const active: ActiveScript = { attemptId: message.attemptId, controller };
    this.activeScriptsByTabId.set(tabId, active);

    try {
      const context = this.deps.tabContexts.get(tabId);
      const session = this.deps.sessionStore.getSessionForTab(tabId);
      if (!context || !context.groupId || !session?.connected) {
        throw new ChatGooseError('not_connected');
      }
      if (!message.draftText.trim()) {
        throw new ChatGooseError('voice_script_invalid');
      }
      const routeBinding = bindingFromContext(context);
      const state = await this.deps.storageCoordinator.getState();
      const account = await this.deps.fanslyClient.getAuthenticatedAccount(
        session,
        controller.signal,
      );
      if (!sameRoute(routeBinding, this.deps.tabContexts.get(tabId))) {
        throw new ChatGooseError('chat_changed');
      }

      const [messageResult, groupResult] = await Promise.allSettled([
        this.deps.fanslyClient.loadMessages(
          context.groupId,
          resolveFeatureMessageCount('voice-script', state.settings),
          session,
          controller.signal,
        ),
        this.deps.fanslyClient.getGroup(context.groupId, session, controller.signal),
      ]);
      if (messageResult.status === 'rejected') {
        throw messageResult.reason;
      }
      if (groupResult.status === 'rejected' && controller.signal.aborted) {
        throw groupResult.reason;
      }
      const messageLoad = messageResult.value;
      const group = groupResult.status === 'fulfilled' ? groupResult.value : null;
      const fanAccountId = (group?.users ?? []).find(
        (user) => user.userId && user.userId !== account.id,
      )?.userId ?? context.fanAccountId;
      const purchaseEvidence = await loadMediaPurchaseEvidence({
        fanslyClient: this.deps.fanslyClient,
        pages: messageLoad.pages,
        fanAccountId,
        session,
        signal: controller.signal,
        debugEnabled: state.settings.debugMode,
      });
      const transcriptMessages = normalizeTranscript(
        messageLoad.pages,
        account.id,
        fanAccountId,
        purchaseEvidence,
      );
      const clientTranscript = formatTranscriptForKernel(transcriptMessages);

      let fanDisplayName = context.fanDisplayName?.trim() || 'fan';
      if (fanAccountId) {
        try {
          const [fan] = await this.deps.fanslyClient.getAccountNames(
            [fanAccountId],
            session,
            controller.signal,
          );
          fanDisplayName = fan?.username?.trim() ||
            fan?.displayName?.trim() ||
            fanDisplayName;
        } catch (error) {
          if (controller.signal.aborted) {
            throw error;
          }
          // Display-name enrichment is optional; the live context remains valid.
        }
      }
      if (!sameRoute(routeBinding, this.deps.tabContexts.get(tabId))) {
        throw new ChatGooseError('chat_changed');
      }
      this.deps.tabContexts.setFan(tabId, fanAccountId, fanDisplayName);

      const page = await this.resolvePageForSettings(
        tabId,
        state.settings,
        account.username?.trim() || session.resolvedUsername?.trim() || null,
        controller.signal,
      );
      if (!sameRoute(routeBinding, this.deps.tabContexts.get(tabId))) {
        throw new ChatGooseError('chat_changed');
      }

      let generationRef: string | null = null;
      const script = await this.deps.kernelGateway.streamFeature(
        state.settings,
        {
          feature: 'voice-script',
          clientRequestId: message.attemptId,
          pageLabel: page.pageLabel,
          conversationRef: fanAccountId ?? context.groupId,
          replyTone: message.replyTone,
          draftText: message.draftText,
          isRegeneration: false,
          clientContext: {
            transcript: clientTranscript.transcript,
            messageCount: clientTranscript.messageCount,
            fanDisplayName,
            fanSpendingData: '',
            fanSubscriptionData: '',
          },
        },
        {
          onText: (text) => {
            if (
              this.isActiveScript(tabId, message.attemptId) &&
              sameRoute(routeBinding, this.deps.tabContexts.get(tabId))
            ) {
              emit({ type: 'voice:scriptDelta', attemptId: message.attemptId, text });
            }
          },
          onMeta: (meta) => {
            generationRef = meta.requestId;
          },
        },
        controller.signal,
      );

      if (
        !this.isActiveScript(tabId, message.attemptId) ||
        !sameRoute(routeBinding, this.deps.tabContexts.get(tabId))
      ) {
        return;
      }
      if (!generationRef) {
        throw new ChatGooseError('hub_request_failed');
      }
      emit({
        type: 'voice:scriptComplete',
        attemptId: message.attemptId,
        script,
        generationRef,
      });
    } catch (error) {
      if (!this.isActiveScript(tabId, message.attemptId) || isAbortError(error)) {
        return;
      }
      const code = structuredErrorCode(error, 'hub_request_failed');
      emit({
        type: 'voice:scriptError',
        attemptId: message.attemptId,
        code,
        message: safeMessageForCode(code, 'hub_request_failed'),
      });
    } finally {
      if (this.isActiveScript(tabId, message.attemptId)) {
        this.activeScriptsByTabId.delete(tabId);
      }
    }
  }

  private async createNote(
    tabId: number,
    message: Extract<VoiceContentMessage, { type: 'voice:noteCreate' }>,
    emit: VoiceEmitter,
  ): Promise<void> {
    const context = this.deps.tabContexts.get(tabId);
    // First send: derive exactly like voice-script. Recovery: use the pin that
    // this service returned before the original create dispatch, even if a new
    // MV3 worker has not resolved fanAccountId yet. The legacy conversationRef
    // field remains display/recovery context and is never trusted as the pin.
    const derivedConversationRef = context
      ? context.fanAccountId ?? context.groupId
      : null;
    const conversationRef = message.pinnedConversationRef ?? derivedConversationRef;
    if (!context || conversationRef === null) {
      this.emitLocalNoteError(
        message.attemptId,
        { source: 'create' },
        'voice_source_invalid',
        emit,
      );
      return;
    }
    const binding = bindingFromContext(context);
    const controller = new AbortController();
    try {
      const state = await this.deps.storageCoordinator.getState();
      const page = await this.resolvePageForTab(tabId, controller.signal, state.settings);
      if (attachRefusal(binding, this.deps.tabContexts.get(tabId)) !== null) {
        this.emitLocalNoteError(
          message.attemptId,
          { source: 'create' },
          'voice_source_invalid',
          emit,
        );
        return;
      }
      // Send the background-owned derivation back before the billable request.
      // Content persists it against this exact clientRequestId and includes it
      // on every recovery replay.
      emit({
        type: 'voice:noteCreateAck',
        attemptId: message.attemptId,
        clientRequestId: message.clientRequestId,
        conversationRef,
      });
      const view = await this.deps.agencyHubClient.createVoiceNote(
        state.settings,
        page.pageLabel,
        {
          clientRequestId: message.clientRequestId,
          conversationRef,
          sourceGenerationRef: message.sourceGenerationRef,
          script: message.script,
        },
        controller.signal,
      );
      this.attemptsById.set(message.attemptId, {
        attemptId: message.attemptId,
        pageLabel: page.pageLabel,
        voiceNoteId: view.voiceNoteId,
        binding,
      });
      emit({ type: 'voice:noteView', attemptId: message.attemptId, view });
    } catch (error) {
      this.emitNoteError(message.attemptId, { source: 'create' }, error, emit);
    }
  }

  private async readStatus(
    tabId: number,
    message: Extract<VoiceContentMessage, { type: 'voice:noteStatus' }>,
    emit: VoiceEmitter,
  ): Promise<void> {
    const controller = new AbortController();
    try {
      const state = await this.deps.storageCoordinator.getState();
      const pageLabel = await this.pageLabelForAttempt(
        tabId,
        message.attemptId,
        message.voiceNoteId,
        state.settings,
        controller.signal,
      );
      const view = await this.deps.agencyHubClient.getVoiceNoteStatus(
        state.settings,
        pageLabel,
        message.voiceNoteId,
        controller.signal,
      );
      emit({ type: 'voice:noteView', attemptId: message.attemptId, view });
    } catch (error) {
      this.emitNoteError(
        message.attemptId,
        { source: 'status', voiceNoteId: message.voiceNoteId },
        error,
        emit,
      );
    }
  }

  private async fetchAudio(
    tabId: number,
    message: Extract<VoiceContentMessage, { type: 'voice:audioFetch' }>,
    emit: VoiceEmitter,
  ): Promise<void> {
    if (
      !Number.isInteger(message.expectedBytes) ||
      message.expectedBytes < 0 ||
      message.expectedBytes > VOICE_AUDIO_MAX_BYTES
    ) {
      this.emitLocalNoteError(
        message.attemptId,
        { source: 'audio', voiceNoteId: message.voiceNoteId },
        'voice_artifact_corrupt',
        emit,
      );
      return;
    }

    const controller = new AbortController();
    try {
      const state = await this.deps.storageCoordinator.getState();
      const pageLabel = await this.pageLabelForAttempt(
        tabId,
        message.attemptId,
        message.voiceNoteId,
        state.settings,
        controller.signal,
      );
      const response = await this.deps.agencyHubClient.fetchVoiceNoteAudio(
        state.settings,
        pageLabel,
        message.voiceNoteId,
        controller.signal,
      );
      if (!response.ok) {
        const body = parseResponseErrorBody(await response.text());
        this.emitNoteError(
          message.attemptId,
          { source: 'audio', voiceNoteId: message.voiceNoteId },
          {
            status: response.status,
            body,
          },
          emit,
        );
        return;
      }

      const contentType = response.headers.get('content-type')
        ?.split(';', 1)[0]
        ?.trim()
        .toLowerCase();
      if (contentType !== 'audio/mpeg') {
        this.emitLocalNoteError(
          message.attemptId,
          { source: 'audio', voiceNoteId: message.voiceNoteId },
          'voice_artifact_corrupt',
          emit,
        );
        return;
      }
      const bytes = await response.arrayBuffer();
      if (
        bytes.byteLength !== message.expectedBytes ||
        bytes.byteLength > VOICE_AUDIO_MAX_BYTES ||
        (await sha256Hex(bytes)) !== message.expectedSha256.trim().toLowerCase()
      ) {
        this.emitLocalNoteError(
          message.attemptId,
          { source: 'audio', voiceNoteId: message.voiceNoteId },
          'voice_artifact_corrupt',
          emit,
        );
        return;
      }
      emit({
        type: 'voice:audioBytes',
        attemptId: message.attemptId,
        voiceNoteId: message.voiceNoteId,
        bytes,
      });
    } catch (error) {
      this.emitNoteError(
        message.attemptId,
        { source: 'audio', voiceNoteId: message.voiceNoteId },
        error,
        emit,
      );
    }
  }

  private async grantAttachToken(
    tabId: number,
    message: Extract<VoiceContentMessage, { type: 'voice:attachToken' }>,
    emit: VoiceEmitter,
  ): Promise<void> {
    const attempt = this.attemptsById.get(message.attemptId);
    if (
      !attempt ||
      attempt.binding.tabId !== tabId ||
      attempt.voiceNoteId !== message.voiceNoteId ||
      this.unavailableAttachAttemptIds.has(message.attemptId) ||
      this.attachGrantsInFlight.has(message.attemptId)
    ) {
      this.emitAttachRefusal(message.attemptId, 'unknown', emit);
      return;
    }
    this.attachGrantsInFlight.add(message.attemptId);
    try {
      const context = this.deps.tabContexts.get(tabId);
      const refusal = attachRefusal(attempt.binding, context);
      if (refusal) {
        this.unavailableAttachAttemptIds.add(message.attemptId);
        this.emitAttachRefusal(message.attemptId, refusal, emit);
        return;
      }

      let fanUsername = context?.fanDisplayName?.trim() ?? '';
      if (!fanUsername && context?.fanAccountId) {
        try {
          const session = this.deps.sessionStore.getSessionForTab(tabId);
          if (session) {
            const [fan] = await this.deps.fanslyClient.getAccountNames(
              [context.fanAccountId],
              session,
              new AbortController().signal,
            );
            fanUsername = fan?.username?.trim() || fan?.displayName?.trim() || '';
          }
        } catch {
          // The attestation remains valid, but without a fan label it cannot be
          // safely handed to the DOM attach path.
        }
      }
      const afterLookupRefusal = attachRefusal(
        attempt.binding,
        this.deps.tabContexts.get(tabId),
      );
      if (afterLookupRefusal) {
        this.unavailableAttachAttemptIds.add(message.attemptId);
        this.emitAttachRefusal(message.attemptId, afterLookupRefusal, emit);
        return;
      }
      if (!fanUsername) {
        this.emitAttachRefusal(message.attemptId, 'unknown', emit);
        return;
      }

      // Mint only for this explicit handoff. The adapter consumes this token
      // before its one native change dispatch; a later human re-request gets a
      // different token and can never revive the consumed one.
      emit({
        type: 'voice:attachGrant',
        attemptId: message.attemptId,
        token: this.randomUUID(),
        fanUsername,
      });
    } finally {
      this.attachGrantsInFlight.delete(message.attemptId);
    }
  }

  private async resolvePageForTab(
    tabId: number,
    signal: AbortSignal,
    settingsOverride?: Settings,
  ): Promise<AgencyHubResolvedPage> {
    const session = this.deps.sessionStore.getSessionForTab(tabId);
    if (!session?.connected) {
      throw new ChatGooseError('not_connected');
    }
    const settings = settingsOverride ?? (await this.deps.storageCoordinator.getState()).settings;
    const pageUsername = session.resolvedUsername?.trim() ||
      (await this.deps.fanslyClient.getAuthenticatedAccount(session, signal)).username?.trim() ||
      null;
    return await this.resolvePageForSettings(tabId, settings, pageUsername, signal);
  }

  private async resolvePageForSettings(
    tabId: number,
    settings: Settings,
    pageUsername: string | null,
    signal: AbortSignal,
  ): Promise<AgencyHubResolvedPage> {
    const normalizedUsername = pageUsername?.trim().toLowerCase() ?? '';
    const baseUrl = normalizeAgencyHubBaseUrl(settings.agencyHubBaseUrl);
    const bearer = resolveHubBearer(settings);
    const tabBinding = this.pageBindingByTabId.get(tabId);
    if (
      normalizedUsername &&
      baseUrl &&
      bearer &&
      tabBinding?.baseUrl === baseUrl &&
      tabBinding.bearer === bearer &&
      tabBinding.pageUsername === normalizedUsername
    ) {
      const cached = this.capabilityByPageLabel.get(tabBinding.pageLabel);
      if (
        cached &&
        cached.baseUrl === baseUrl &&
        cached.bearer === bearer &&
        cached.expiresAt > this.now()
      ) {
        return {
          pageLabel: tabBinding.pageLabel,
          voiceNotesCapable: cached.capable,
        };
      }
    }

    const page = await this.deps.agencyHubClient.resolvePageForUsername(
      settings,
      pageUsername,
      signal,
    );
    if (!page) {
      throw new ChatGooseError('hub_page_match_failed');
    }
    if (baseUrl && bearer && normalizedUsername) {
      this.pageBindingByTabId.set(tabId, {
        baseUrl,
        bearer,
        pageUsername: normalizedUsername,
        pageLabel: page.pageLabel,
      });
      this.capabilityByPageLabel.set(page.pageLabel, {
        baseUrl,
        bearer,
        capable: page.voiceNotesCapable,
        expiresAt: this.now() + VOICE_CAPABILITY_TTL_MS,
      });
    }
    return page;
  }

  private async pageLabelForAttempt(
    tabId: number,
    attemptId: string,
    voiceNoteId: number,
    settings: Settings,
    signal: AbortSignal,
  ): Promise<string> {
    const attempt = this.attemptsById.get(attemptId);
    if (attempt) {
      if (attempt.binding.tabId !== tabId || attempt.voiceNoteId !== voiceNoteId) {
        throw new ChatGooseError('voice_source_invalid');
      }
      return attempt.pageLabel;
    }
    // A worker restart may lose the in-memory attempt while the content-side
    // session record survives. Status/audio remain page-scoped server reads;
    // only attachment requires the original in-memory tuple attestation.
    return (await this.resolvePageForTab(tabId, signal, settings)).pageLabel;
  }

  private emitNoteError(
    attemptId: string,
    context: VoiceNoteErrorContext,
    error: unknown,
    emit: VoiceEmitter,
  ): void {
    emit({ type: 'voice:noteError', attemptId, ...context, ...noteFailure(error) });
  }

  private emitLocalNoteError(
    attemptId: string,
    context: VoiceNoteErrorContext,
    code: 'voice_source_invalid' | 'voice_artifact_corrupt',
    emit: VoiceEmitter,
  ): void {
    emit({
      type: 'voice:noteError',
      attemptId,
      ...context,
      code,
      message: createUserError(code).message,
      status: 0,
    });
  }

  private emitAttachRefusal(
    attemptId: string,
    reason: 'route_changed' | 'fan_mismatch' | 'unknown',
    emit: VoiceEmitter,
  ): void {
    emit({ type: 'voice:attachRefuse', attemptId, reason });
  }

  private isActiveScript(tabId: number, attemptId: string): boolean {
    return this.activeScriptsByTabId.get(tabId)?.attemptId === attemptId;
  }

  private cancelScript(tabId: number, attemptId: string): void {
    if (this.isActiveScript(tabId, attemptId)) {
      this.abortActiveScript(tabId);
    }
  }

  private abortActiveScript(tabId: number): void {
    const active = this.activeScriptsByTabId.get(tabId);
    if (!active) {
      return;
    }
    this.activeScriptsByTabId.delete(tabId);
    active.controller.abort();
  }

  private invalidateAttachAttemptsForTab(tabId: number): void {
    for (const [attemptId, attempt] of this.attemptsById) {
      if (attempt.binding.tabId === tabId) {
        this.unavailableAttachAttemptIds.add(attemptId);
      }
    }
  }
}
